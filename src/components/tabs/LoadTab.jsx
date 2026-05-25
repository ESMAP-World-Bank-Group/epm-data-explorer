import { useState, useEffect } from 'react';
import { getT } from '../../constants';

const ISO3_TO_ISO2 = {
  TUR:'TR', ROU:'RO', BGR:'BG', GEO:'GE', ARM:'AM', AZE:'AZ',
  SEN:'SN', GMB:'GM', GNB:'GW', GIN:'GN', SLE:'SL', LBR:'LR', CIV:'CI', GHA:'GH',
  TGO:'TG', BEN:'BJ', NGA:'NG', NER:'NE', MLI:'ML', BFA:'BF', MRT:'MR', CPV:'CV',
  CMR:'CM', CAF:'CF', TCD:'TD', COD:'CD', COG:'CG', GAB:'GA', GNQ:'GQ', STP:'ST',
  EGY:'EG', LBY:'LY', SDN:'SD', SSD:'SS', ETH:'ET', DJI:'DJ', KEN:'KE', TZA:'TZ',
  SOM:'SO', UGA:'UG', RWA:'RW', BDI:'BI',
  ZAF:'ZA', ZWE:'ZW', ZMB:'ZM', BWA:'BW', MOZ:'MZ', MWI:'MW', NAM:'NA', LSO:'LS',
  SWZ:'SZ', MDG:'MG', AGO:'AO',
  MAR:'MA', DZA:'DZ', TUN:'TN', JOR:'JO', LBN:'LB', SYR:'SY', IRQ:'IQ', SAU:'SA',
  YEM:'YE', OMN:'OM', ARE:'AE', QAT:'QA', BHR:'BH', KWT:'KW', PSE:'PS',
  ALB:'AL', BIH:'BA', MKD:'MK', MNE:'ME', SRB:'RS', KOS:'XK',
  IND:'IN', PAK:'PK', BGD:'BD', LKA:'LK', NPL:'NP', BTN:'BT', AFG:'AF', MDV:'MV',
  KAZ:'KZ', KGZ:'KG', TJK:'TJ', TKM:'TM', UZB:'UZ',
};

const ENTSOE_ISO3 = new Set(['ROU','BGR','TUR','ALB','BIH','MKD','MNE','SRB','KOS',
  'GEO','ARM','AZE','MAR','DZA','TUN','EGY']);

const PROFILE_EUROPEAN = [42,38,35,33,32,33,38,56,75,82,85,86,87,87,85,83,84,88,93,96,91,78,65,52];
const PROFILE_AVERAGE  = [44,40,37,35,34,36,43,60,72,78,80,79,78,76,75,77,82,90,97,100,93,80,66,53];

function getProfile(iso) {
  if (ENTSOE_ISO3.has(iso)) return { data: PROFILE_EUROPEAN, label: 'Typical weekday · European grid (ENTSO-E shape)', specific: true };
  return { data: PROFILE_AVERAGE, label: 'Typical weekday · Global average shape (illustrative)', specific: false };
}

function downloadBlob(content, filename, type = 'application/octet-stream') {
  const blob = new Blob([content], { type });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function linearFit(pts) {
  const n = pts.length;
  if (n < 2) return null;
  const sx  = pts.reduce((s, [x])    => s + x,     0);
  const sy  = pts.reduce((s, [, y])  => s + y,     0);
  const sxy = pts.reduce((s, [x, y]) => s + x * y, 0);
  const sxx = pts.reduce((s, [x])    => s + x * x, 0);
  const denom = n * sxx - sx * sx;
  if (!denom) return null;
  const m = (n * sxy - sx * sy) / denom;
  const b = (sy - m * sx) / n;
  return { m, b };
}

function fmtTWh(v) {
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  if (v >= 10)   return v.toFixed(0);
  return v.toFixed(1);
}

function TrendChart({ historical, projected, t }) {
  if (!historical.length) return null;
  const all     = [...historical, ...projected];
  const years   = all.map(([y]) => y);
  const vals    = all.map(([, v]) => v);
  const minYear = Math.min(...years), maxYear = Math.max(...years);
  const maxVal  = Math.max(...vals) * 1.12;
  const W = 226, H = 72, pL = 34, pR = 6, pT = 6, pB = 18;
  const iW = W - pL - pR, iH = H - pT - pB;
  const toX = y => pL + ((y - minYear) / (maxYear - minYear || 1)) * iW;
  const toY = v => pT + iH - (v / maxVal) * iH;
  const histPts = historical.map(([y, v]) => `${toX(y).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');
  const projStart = historical[historical.length - 1];
  const projPts = projected.length
    ? [`${toX(projStart[0]).toFixed(1)},${toY(projStart[1]).toFixed(1)}`,
       ...projected.map(([y, v]) => `${toX(y).toFixed(1)},${toY(v).toFixed(1)}`)].join(' ')
    : null;
  const tickVals = [0, +(maxVal * 0.5).toFixed(1), +maxVal.toFixed(1)];
  const midProjYear = projected.length ? projected[Math.floor(projected.length / 2)][0] : null;
  const midProjVal  = projected.length ? projected[Math.floor(projected.length / 2)][1] : null;

  return (
    <svg width={W} height={H} style={{ display: 'block', overflow: 'visible' }}>
      {tickVals.map(v => {
        const y = toY(v);
        return (
          <g key={v}>
            <line x1={pL} y1={y} x2={pL + iW} y2={y}
              stroke={t.panelBorder} strokeWidth={0.5} strokeDasharray="2,2" />
            <text x={pL - 2} y={y + 3} textAnchor="end" fill={t.lblMuted} fontSize={6.5}>
              {fmtTWh(v)}
            </text>
          </g>
        );
      })}
      <text transform={`translate(8, ${pT + iH / 2}) rotate(-90)`}
        textAnchor="middle" fill={t.lblMuted} fontSize={6}>TWh/yr</text>
      <polyline points={histPts} fill="none" stroke="#4DABF7"
        strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      {projPts && (
        <>
          <polyline points={projPts} fill="none" stroke="#4DABF7"
            strokeWidth={1.4} strokeDasharray="4,3" strokeLinejoin="round"
            strokeLinecap="round" opacity={0.55} />
          {midProjVal != null && (
            <text x={toX(midProjYear)} y={toY(midProjVal) - 5}
              textAnchor="middle" fill={t.lblMuted} fontSize={6} fontStyle="italic">
              projected
            </text>
          )}
        </>
      )}
      {[minYear, Math.round((minYear + maxYear) / 2), maxYear].map(yr => (
        <text key={yr} x={toX(yr)} y={H - 2} textAnchor="middle" fill={t.lblMuted} fontSize={7}>
          {yr}
        </text>
      ))}
    </svg>
  );
}

function ProfileChart({ profile, color, t }) {
  const W = 226, H = 56, pL = 10, pR = 6, pT = 6, pB = 18;
  const iW = W - pL - pR, iH = H - pT - pB;
  const maxV = Math.max(...profile);
  const toX = i => pL + (i / (profile.length - 1)) * iW;
  const toY = v => pT + iH - (v / maxV) * iH;
  const pts = profile.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');
  const fill = [
    `${pL},${pT + iH}`,
    ...profile.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`),
    `${pL + iW},${pT + iH}`,
  ].join(' ');
  return (
    <svg width={W} height={H} style={{ display: 'block', overflow: 'visible' }}>
      <polygon points={fill} fill={color} opacity={0.12} />
      <polyline points={pts} fill="none" stroke={color}
        strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      {[0, 6, 12, 18, 23].map(h => (
        <text key={h} x={toX(h)} y={H - 3} textAnchor="middle" fill={t.lblMuted} fontSize={7}>
          {h}h
        </text>
      ))}
    </svg>
  );
}

export default function LoadTab({ iso, theme }) {
  const t = getT(theme);
  const [pts, setPts]       = useState(null); // [[year, TWh]]
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState(false);

  useEffect(() => {
    const iso2 = ISO3_TO_ISO2[iso];
    if (!iso2) { setError(true); return; }
    setLoading(true); setError(false); setPts(null);

    const wdi = url => fetch(url).then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(([, rows]) =>
        (rows || []).filter(r => r.value != null)
          .map(r => [parseInt(r.date), r.value])
          .sort(([a], [b]) => a - b)
      );

    const base = `https://api.worldbank.org/v2/country/${iso2}/indicator`;
    Promise.all([
      wdi(`${base}/EG.USE.ELEC.KH.PC?format=json&per_page=60&mrv=35`),
      wdi(`${base}/SP.POP.TOTL?format=json&per_page=60&mrv=35`),
    ])
      .then(([pc, pop]) => {
        const popMap = new Map(pop.map(([y, v]) => [y, v]));
        const merged = pc
          .filter(([y]) => popMap.has(y))
          .map(([y, kwh_cap]) => [y, +(kwh_cap * popMap.get(y) / 1e9).toFixed(3)]);
        setPts(merged);
        setLoading(false);
      })
      .catch(() => { setError(true); setLoading(false); });
  }, [iso]);

  const historical = pts || [];
  let projected = [];
  let cagr = null;
  if (historical.length >= 3) {
    const fit = linearFit(historical);
    if (fit) {
      const lastYear = historical[historical.length - 1][0];
      projected = Array.from({ length: 11 }, (_, i) => {
        const yr = lastYear + i + 1;
        return [yr, Math.max(0, +(fit.m * yr + fit.b).toFixed(3))];
      });
    }
    const v0 = historical[0][1], v1 = historical[historical.length - 1][1];
    const n  = historical[historical.length - 1][0] - historical[0][0];
    if (v0 > 0 && n > 0) cagr = ((Math.pow(v1 / v0, 1 / n) - 1) * 100).toFixed(1);
  }

  const lastTWh  = historical.length ? historical[historical.length - 1][1] : null;
  const lastYear = historical.length ? historical[historical.length - 1][0] : null;
  // Estimated peak: annual TWh / (8760 h × 0.55 load factor)
  const peakGW   = lastTWh != null ? (lastTWh * 1000 / (8760 * 0.55)).toFixed(1) : null;

  const profile = getProfile(iso);

  const sec = {
    fontSize: '0.45rem', letterSpacing: '2px', fontWeight: 700,
    color: t.lblMuted, textTransform: 'uppercase', marginBottom: 6, display: 'block',
  };

  const legend = (color, dash, label) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <svg width={18} height={6}>
        <line x1={0} y1={3} x2={18} y2={3} stroke={color}
          strokeWidth={1.5} strokeDasharray={dash || undefined} opacity={dash ? 0.6 : 1} />
      </svg>
      <span style={{ fontSize: '0.46rem', color: t.lblMuted }}>{label}</span>
    </div>
  );

  return (
    <div>
      {/* ── Total demand ─────────────────────── */}
      <span style={sec}>Electricity Demand</span>

      {loading && <p style={{ fontSize: '0.62rem', color: t.muted, fontStyle: 'italic' }}>Loading…</p>}
      {error   && <p style={{ fontSize: '0.62rem', color: t.muted, fontStyle: 'italic' }}>No WB WDI data for this country.</p>}
      {!loading && !error && historical.length === 0 && (
        <p style={{ fontSize: '0.62rem', color: t.muted, fontStyle: 'italic' }}>No data available.</p>
      )}

      {historical.length > 0 && (
        <>
          {/* KPI row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5, marginBottom: 8 }}>
            <div style={{ padding: '6px 8px', borderRadius: 5, backgroundColor: t.cardBg, border: `1px solid ${t.cardBorder}` }}>
              <div style={{ fontSize: '0.42rem', color: t.lblMuted, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 2 }}>
                Annual Demand
              </div>
              <div style={{ fontSize: '0.88rem', fontWeight: 700, color: t.lbl }}>
                {lastTWh != null ? `${fmtTWh(lastTWh)} TWh` : '—'}
              </div>
              <div style={{ fontSize: '0.42rem', color: t.lblMuted }}>{lastYear}</div>
            </div>
            <div style={{ padding: '6px 8px', borderRadius: 5, backgroundColor: t.cardBg, border: `1px solid ${t.cardBorder}` }}>
              <div style={{ fontSize: '0.42rem', color: t.lblMuted, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 2 }}>
                Est. Peak
              </div>
              <div style={{ fontSize: '0.88rem', fontWeight: 700, color: t.lbl }}>
                {peakGW != null ? `~${peakGW} GW` : '—'}
              </div>
              <div style={{ fontSize: '0.42rem', color: t.lblMuted }}>LF = 55%</div>
            </div>
          </div>

          <TrendChart historical={historical} projected={projected} t={t} />

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 5 }}>
            <div style={{ display: 'flex', gap: 12 }}>
              {legend('#4DABF7', null,  'Historical (WB WDI)')}
              {legend('#4DABF7', '4,3', 'Linear extrap.')}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {cagr != null && (
                <div style={{
                  fontSize: '0.55rem', color: parseFloat(cagr) >= 0 ? '#40C057' : '#F03E3E',
                  fontWeight: 700, letterSpacing: '0.3px',
                }}>
                  {parseFloat(cagr) >= 0 ? '+' : ''}{cagr}%
                  <span style={{ fontSize: '0.44rem', color: t.lblMuted, fontWeight: 400, marginLeft: 2 }}>
                    CAGR
                  </span>
                </div>
              )}
              <button
                title="Download CSV"
                onClick={() => {
                  const allRows = [
                    ...historical.map(([year, val]) => `${year},${val},historical`),
                    ...projected.map(([year, val]) => `${year},${val},projected`),
                  ];
                  downloadBlob(
                    ['year,twh,type', ...allRows].join('\n'),
                    `electricity_demand_${iso}.csv`,
                    'text/csv'
                  );
                }}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  padding: '1px 3px', borderRadius: 3, color: t.lblMuted,
                  display: 'inline-flex', alignItems: 'center', opacity: 0.7,
                }}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
              </button>
            </div>
          </div>
          <p style={{ fontSize: '0.46rem', color: t.lblMuted, marginTop: 3, fontStyle: 'italic', marginBottom: 14 }}>
            WB WDI · EG.USE.ELEC.KH.PC × SP.POP.TOTL ·{' '}
            {historical[0][0]}–{historical[historical.length - 1][0]} ·{' '}
            Peak estimated from load factor (55%)
          </p>
        </>
      )}

      {/* ── Daily load profile ────────────────── */}
      <div style={{ borderTop: `1px solid ${t.panelBorder}`, paddingTop: 10 }}>
        <span style={sec}>Daily Load Profile</span>
        <ProfileChart profile={profile.data} color={profile.specific ? '#74C0FC' : '#94A3B8'} t={t} />
        <p style={{ fontSize: '0.46rem', color: t.lblMuted, marginTop: 5, fontStyle: 'italic', lineHeight: 1.5 }}>
          {profile.label}
          {!profile.specific && (
            <span style={{ color: 'rgba(250,180,50,0.8)', fontStyle: 'normal', marginLeft: 4 }}>
              · No country-specific data available
            </span>
          )}
        </p>
      </div>
    </div>
  );
}
