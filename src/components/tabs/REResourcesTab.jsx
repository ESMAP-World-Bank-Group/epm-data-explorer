import { useState, useEffect } from 'react';
import { getT } from '../../constants';

const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function downloadBlob(content, filename, type = 'application/octet-stream') {
  const blob = new Blob([content], { type });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const DAYS_PER_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const HELLMAN = 0.143; // open terrain height exponent

function windCF(v100) {
  if (v100 < 3.5) return 5;
  if (v100 < 4.5) return 10;
  if (v100 < 5.5) return 16;
  if (v100 < 6.5) return 23;
  if (v100 < 7.5) return 30;
  if (v100 < 8.5) return 36;
  if (v100 < 9.5) return 41;
  return 45;
}

function LineChart({ data, color, yUnit, t }) {
  if (!data || data.length < 2) return null;
  const W = 226, H = 64, pL = 30, pR = 6, pT = 6, pB = 20;
  const iW = W - pL - pR, iH = H - pT - pB;
  const minV = Math.min(...data), maxV = Math.max(...data);
  const range = maxV - minV || 1;
  const toX = i => pL + (i / (data.length - 1)) * iW;
  const toY = v => pT + iH - ((v - minV) / range) * iH;
  const pts  = data.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');
  const fill = [
    `${pL},${pT + iH}`,
    ...data.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`),
    `${pL + iW},${pT + iH}`,
  ].join(' ');
  const ticks = [minV, (minV + maxV) / 2, maxV];
  return (
    <div>
      <svg width={W} height={H} style={{ display: 'block', overflow: 'visible' }}>
        {ticks.map((v, i) => {
          const y = toY(v);
          return (
            <g key={i}>
              <line x1={pL} y1={y} x2={pL + iW} y2={y}
                stroke={t.panelBorder} strokeWidth={0.5} strokeDasharray="2,2" />
              <text x={pL - 2} y={y + 3} textAnchor="end" fill={t.lblMuted} fontSize={6.5}>
                {v.toFixed(1)}
              </text>
            </g>
          );
        })}
        <polygon points={fill} fill={color} opacity={0.12} />
        <polyline points={pts} fill="none" stroke={color}
          strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
        {data.map((v, i) => (
          <circle key={i} cx={toX(i)} cy={toY(v)} r={2} fill={color} />
        ))}
        {[0, 3, 6, 9, 11].map(i => (
          <text key={i} x={toX(i)} y={H - 4} textAnchor="middle" fill={t.lblMuted} fontSize={7}>
            {MONTH_LABELS[i]}
          </text>
        ))}
        {/* Y unit rotated label */}
        <text
          transform={`translate(8, ${pT + iH / 2}) rotate(-90)`}
          textAnchor="middle" fill={t.lblMuted} fontSize={6}
        >
          {yUnit}
        </text>
      </svg>
    </div>
  );
}

export default function REResourcesTab({ center, theme }) {
  const t = getT(theme);
  const [solar, setSolar] = useState(null);
  const [wind,  setWind]  = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(false);

  useEffect(() => {
    if (!center) return;
    setLoading(true); setError(false); setSolar(null); setWind(null);
    const { lat, lon } = center;

    const solarP = fetch(
      `https://api.globalsolaratlas.info/data/lta?loc=${lat.toFixed(4)},${lon.toFixed(4)}`
    ).then(r => { if (!r.ok) throw new Error(); return r.json(); });

    // Open-Meteo ERA5 archive: monthly 10m wind speed, 2014–2023
    const windP = fetch(
      `https://archive-api.open-meteo.com/v1/archive?` +
      `latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
      `&start_date=2014-01-01&end_date=2023-12-31&monthly=wind_speed_10m`
    ).then(r => { if (!r.ok) throw new Error(); return r.json(); });

    Promise.allSettled([solarP, windP]).then(([solarR, windR]) => {
      // Solar
      if (solarR.status === 'fulfilled') {
        const data = solarR.value;
        const ann  = data.annual?.data  || {};
        const mon  = data.monthly?.data || {};
        const monthlyGhiDaily = (mon.GHI || []).map((v, i) => +(v / DAYS_PER_MONTH[i]).toFixed(2));
        setSolar({
          ghi:   ann.GHI,
          dni:   ann.DNI,
          pvout: ann.PVOUT_csi,
          cf:    ann.PVOUT_csi ? ((ann.PVOUT_csi / 8760) * 100).toFixed(1) : null,
          monthlyGhiDaily,
        });
      }

      // Wind: group monthly values by calendar month, average, apply height correction
      if (windR.status === 'fulfilled') {
        const d    = windR.value;
        const times  = d.monthly?.time          || [];
        const speeds = d.monthly?.wind_speed_10m || [];
        const byMonth = Array.from({ length: 12 }, () => []);
        times.forEach((t, i) => {
          if (speeds[i] == null) return;
          const m = parseInt(t.split('-')[1]) - 1;
          byMonth[m].push(speeds[i]);
        });
        const monthly10m  = byMonth.map(arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);
        const monthly100m = monthly10m.map(v => v != null ? +(v * Math.pow(100 / 10, HELLMAN)).toFixed(2) : null);
        const validSpeeds = monthly100m.filter(v => v != null);
        const mean100m    = validSpeeds.length
          ? +(validSpeeds.reduce((s, v) => s + v, 0) / validSpeeds.length).toFixed(1)
          : null;
        setWind({
          monthly100m,
          mean100m,
          cf: mean100m != null ? windCF(mean100m) : null,
        });
      }

      if (solarR.status === 'rejected' && windR.status === 'rejected') setError(true);
      setLoading(false);
    });
  }, [center]);

  const sec = {
    fontSize: '0.45rem', letterSpacing: '2px', fontWeight: 700,
    color: t.lblMuted, textTransform: 'uppercase', marginBottom: 6, display: 'block',
  };

  return (
    <div>
      {/* ── Solar ─────────────────────────────── */}
      <span style={sec}>Solar Resource</span>

      {!center && (
        <p style={{ fontSize: '0.62rem', color: t.muted, fontStyle: 'italic' }}>Loading country location…</p>
      )}
      {loading && (
        <p style={{ fontSize: '0.62rem', color: t.muted, fontStyle: 'italic' }}>Fetching resource data…</p>
      )}
      {error && !solar && !wind && (
        <p style={{ fontSize: '0.62rem', color: t.muted, fontStyle: 'italic' }}>Could not load resource data.</p>
      )}

      {solar && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5, marginBottom: 10 }}>
            {[
              { label: 'GHI',   value: solar.ghi   ? solar.ghi.toFixed(0)   : '—', unit: 'kWh/m²/yr' },
              { label: 'PVOUT', value: solar.pvout  ? solar.pvout.toFixed(0)  : '—', unit: 'kWh/kWp/yr' },
              { label: 'DNI',   value: solar.dni   ? solar.dni.toFixed(0)   : '—', unit: 'kWh/m²/yr' },
              { label: 'PV CF', value: solar.cf    ? `${solar.cf}%`         : '—', unit: 'capacity factor' },
            ].map(({ label, value, unit }) => (
              <div key={label} style={{
                padding: '6px 8px', borderRadius: 5,
                backgroundColor: t.cardBg, border: `1px solid ${t.cardBorder}`,
              }}>
                <div style={{ fontSize: '0.42rem', color: t.lblMuted, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 2 }}>{label}</div>
                <div style={{ fontSize: '0.88rem', fontWeight: 700, color: t.lbl }}>{value}</div>
                <div style={{ fontSize: '0.42rem', color: t.lblMuted }}>{unit}</div>
              </div>
            ))}
          </div>
          <span style={{ ...sec, marginBottom: 4 }}>Monthly GHI</span>
          <LineChart data={solar.monthlyGhiDaily} color="#FFD43B" yUnit="kWh/m²/d" t={t} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 3, marginBottom: 14 }}>
            <p style={{ fontSize: '0.44rem', color: t.lblMuted, fontStyle: 'italic', margin: 0 }}>
              Source:{' '}
              <a href="https://globalsolaratlas.info" target="_blank" rel="noopener noreferrer"
                style={{ color: 'rgba(74,143,204,0.75)', textDecoration: 'none' }}>
                Global Solar Atlas
              </a>{' '}(ESMAP / World Bank)
            </p>
            {(solar || wind) && (
              <button
                title="Download RE data CSV"
                onClick={() => {
                  const rows = [];
                  rows.push('type,metric,value,unit');
                  if (solar) {
                    rows.push(`solar,GHI,${solar.ghi ?? ''},kWh/m²/yr`);
                    rows.push(`solar,DNI,${solar.dni ?? ''},kWh/m²/yr`);
                    rows.push(`solar,PVOUT,${solar.pvout ?? ''},kWh/kWp/yr`);
                    rows.push(`solar,CF,${solar.cf ?? ''},%`);
                    (solar.monthlyGhiDaily || []).forEach((v, i) => {
                      rows.push(`solar_monthly,GHI_daily_${MONTH_LABELS[i]},${v ?? ''},kWh/m²/d`);
                    });
                  }
                  if (wind) {
                    rows.push(`wind,mean_100m,${wind.mean100m ?? ''},m/s`);
                    (wind.monthly100m || []).forEach((v, i) => {
                      rows.push(`wind_monthly,speed_100m_${MONTH_LABELS[i]},${v ?? ''},m/s`);
                    });
                  }
                  downloadBlob(rows.join('\n'), `re_resources_${center?.lat?.toFixed(2)}_${center?.lon?.toFixed(2)}.csv`, 'text/csv');
                }}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  padding: '1px 3px', borderRadius: 3, color: t.lblMuted,
                  display: 'inline-flex', alignItems: 'center', opacity: 0.7,
                  flexShrink: 0,
                }}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
              </button>
            )}
          </div>
        </>
      )}

      {/* ── Wind ──────────────────────────────── */}
      <div style={{ borderTop: `1px solid ${t.panelBorder}`, paddingTop: 12, marginTop: solar ? 0 : 0 }}>
        <span style={sec}>Wind Resource</span>

        {wind && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5, marginBottom: 10 }}>
              {[
                { label: 'Mean wind', value: wind.mean100m != null ? `${wind.mean100m}` : '—', unit: 'm/s @ 100m' },
                { label: 'Est. CF',   value: wind.cf       != null ? `~${wind.cf}%`    : '—', unit: 'indicative' },
              ].map(({ label, value, unit }) => (
                <div key={label} style={{
                  padding: '6px 8px', borderRadius: 5,
                  backgroundColor: t.cardBg, border: `1px solid ${t.cardBorder}`,
                }}>
                  <div style={{ fontSize: '0.42rem', color: t.lblMuted, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 2 }}>{label}</div>
                  <div style={{ fontSize: '0.88rem', fontWeight: 700, color: t.lbl }}>{value}</div>
                  <div style={{ fontSize: '0.42rem', color: t.lblMuted }}>{unit}</div>
                </div>
              ))}
            </div>
            <span style={{ ...sec, marginBottom: 4 }}>Monthly Wind Speed @ 100m</span>
            <LineChart data={wind.monthly100m.filter(v => v != null)} color="#90AAC4" yUnit="m/s" t={t} />
            <p style={{ fontSize: '0.44rem', color: t.lblMuted, marginTop: 3, fontStyle: 'italic' }}>
              ERA5 reanalysis 2014–2023, Hellman correction (α=0.143) ·{' '}
              <a href="https://open-meteo.com" target="_blank" rel="noopener noreferrer"
                style={{ color: 'rgba(74,143,204,0.75)', textDecoration: 'none' }}>
                Open-Meteo
              </a>
              {' '}· CF estimate is indicative (IEC class 2–3)
            </p>
          </>
        )}
        {!wind && !loading && (
          <p style={{ fontSize: '0.62rem', color: t.muted, fontStyle: 'italic' }}>No wind data available.</p>
        )}
      </div>
    </div>
  );
}
