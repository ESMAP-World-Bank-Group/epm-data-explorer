import { FUEL_COLORS, FUEL_LABELS, getT } from '../constants';

const RE_FUELS = new Set(['solar', 'wind', 'hydro', 'geothermal', 'biomass', 'biogas', 'wood']);

function polarToXY(cx, cy, r, deg) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function donutArc(cx, cy, R, r, start, end) {
  if (end - start >= 359) {
    const m1 = polarToXY(cx, cy, R, 0),   m2 = polarToXY(cx, cy, R, 180);
    const m3 = polarToXY(cx, cy, r, 180),  m4 = polarToXY(cx, cy, r, 0);
    return `M${m1.x},${m1.y} A${R},${R},0,1,1,${m2.x},${m2.y} A${R},${R},0,1,1,${m1.x},${m1.y} M${m3.x},${m3.y} A${r},${r},0,1,0,${m4.x},${m4.y} A${r},${r},0,1,0,${m3.x},${m3.y} Z`;
  }
  const s1 = polarToXY(cx, cy, R, start), e1 = polarToXY(cx, cy, R, end);
  const e2 = polarToXY(cx, cy, r, end),   s2 = polarToXY(cx, cy, r, start);
  const lg = (end - start) > 180 ? 1 : 0;
  return `M${s1.x.toFixed(2)},${s1.y.toFixed(2)} A${R},${R},0,${lg},1,${e1.x.toFixed(2)},${e1.y.toFixed(2)} L${e2.x.toFixed(2)},${e2.y.toFixed(2)} A${r},${r},0,${lg},0,${s2.x.toFixed(2)},${s2.y.toFixed(2)} Z`;
}

function KpiCard({ label, value, accent, t }) {
  return (
    <div style={{
      padding: '7px 10px', borderRadius: 5,
      backgroundColor: t.cardBg, border: `1px solid ${t.cardBorder}`,
    }}>
      <div style={{ fontSize: '0.45rem', color: t.lblMuted, letterSpacing: '1.5px', textTransform: 'uppercase', marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ fontSize: '0.95rem', fontWeight: 700, color: accent || t.lbl, lineHeight: 1 }}>
        {value}
      </div>
    </div>
  );
}

export default function CapacityChart({ capacity, region, theme, source = 'osm', tariffs, access }) {
  const t = getT(theme);
  const sec = {
    fontSize: '0.5rem', letterSpacing: '2px', fontWeight: 700,
    color: t.lblMuted, textTransform: 'uppercase', marginBottom: 7, display: 'block',
  };

  if (!capacity) return (
    <p style={{ fontSize: '0.7rem', color: t.muted, fontStyle: 'italic' }}>Loading…</p>
  );

  // Aggregate region fuels
  const regionFuels = {};
  for (const iso of Object.keys(capacity.countries || {})) {
    for (const [f, v] of Object.entries(capacity.countries[iso])) {
      regionFuels[f] = (regionFuels[f] || 0) + v;
    }
  }
  const totalMW = Object.values(regionFuels).reduce((s, v) => s + v, 0);
  const reMW    = Object.entries(regionFuels).filter(([f]) => RE_FUELS.has(f)).reduce((s, [, v]) => s + v, 0);
  const reShare = totalMW > 0 ? Math.round((reMW / totalMW) * 100) : null;
  const fuelsWithData = Object.entries(regionFuels).filter(([, v]) => v > 0).sort(([, a], [, b]) => b - a);

  // Tariff range across region
  let tMin = null, tMax = null, tMinIso = null, tMaxIso = null;
  if (tariffs) {
    for (const c of region.countries) {
      const d = tariffs.countries?.[c.iso];
      if (d?.res != null) {
        if (tMin === null || d.res < tMin) { tMin = d.res; tMinIso = c.iso; }
        if (tMax === null || d.res > tMax) { tMax = d.res; tMaxIso = c.iso; }
      }
    }
  }

  // Access range across region
  let aMin = null, aMax = null, aMinIso = null, aMaxIso = null;
  if (access) {
    for (const c of region.countries) {
      const d = access.countries?.[c.iso];
      if (d?.total != null) {
        if (aMin === null || d.total < aMin) { aMin = d.total; aMinIso = c.iso; }
        if (aMax === null || d.total > aMax) { aMax = d.total; aMaxIso = c.iso; }
      }
    }
  }

  // Donut arcs
  const cx = 44, cy = 44, R = 36, r = 22;
  let cumDeg = 0;
  const arcs = fuelsWithData.map(([fuel, mw]) => {
    const sweep = fuelsWithData.length === 1 ? 359.9 : (mw / totalMW) * 357;
    const start = cumDeg;
    cumDeg += sweep + (fuelsWithData.length > 1 ? 1 : 0);
    return { fuel, start, end: start + sweep };
  });

  return (
    <div>
      {/* ── KPI cards ─────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 16 }}>
        <KpiCard label="Total Capacity" value={`${(totalMW / 1000).toFixed(1)} GW`} t={t} />
        <KpiCard label="RE Share"       value={reShare !== null ? `${reShare}%` : '—'} accent="#4DABF7" t={t} />
        <KpiCard label="Countries"      value={region.countries.length} t={t} />
        <KpiCard label="Fuel Types"     value={fuelsWithData.length} t={t} />
      </div>

      {/* ── RE share bar ──────────────────────── */}
      {reShare !== null && (
        <div style={{ marginBottom: 16 }}>
          <span style={sec}>RE Share · Installed Capacity</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              flex: 1, height: 7, borderRadius: 3,
              backgroundColor: 'rgba(128,160,192,0.12)', overflow: 'hidden',
            }}>
              <div style={{
                width: `${reShare}%`, height: '100%',
                background: 'linear-gradient(90deg, #4DABF7, #40C057)', borderRadius: 3,
              }} />
            </div>
            <span style={{ fontSize: '1rem', fontWeight: 700, color: '#4DABF7', minWidth: 38, textAlign: 'right' }}>
              {reShare}%
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
            <span style={{ fontSize: '0.55rem', color: t.lblMuted }}>RE: {(reMW / 1000).toFixed(1)} GW</span>
            <span style={{ fontSize: '0.55rem', color: t.lblMuted }}>Total: {(totalMW / 1000).toFixed(1)} GW</span>
          </div>
        </div>
      )}

      {/* ── Capacity donut ────────────────────── */}
      {totalMW > 0 ? (
        <div style={{ marginBottom: 16 }}>
          <span style={sec}>Capacity Mix</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <svg width={88} height={88} viewBox="0 0 88 88" style={{ flexShrink: 0 }}>
              {arcs.map(({ fuel, start, end }) => (
                <path key={fuel} d={donutArc(cx, cy, R, r, start, end)}
                  fill={FUEL_COLORS[fuel]} opacity={0.88} />
              ))}
              <text x={cx} y={cy - 2} textAnchor="middle" fontSize="8"
                fontWeight="700" fill={t.text} fontFamily="inherit">
                {(totalMW / 1000).toFixed(1)}
              </text>
              <text x={cx} y={cy + 8} textAnchor="middle" fontSize="6.5"
                fill={t.muted} fontFamily="inherit">GW</text>
            </svg>
            <div style={{ fontSize: '0.58rem', color: t.muted, lineHeight: '1.65', overflow: 'hidden' }}>
              {fuelsWithData.slice(0, 6).map(([fuel, mw]) => (
                <div key={fuel} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{
                    display: 'inline-block', width: 6, height: 6,
                    borderRadius: '50%', backgroundColor: FUEL_COLORS[fuel], flexShrink: 0,
                  }} />
                  <span style={{ flex: 1 }}>{FUEL_LABELS[fuel] || fuel}</span>
                  <span style={{ color: t.lbl, fontVariantNumeric: 'tabular-nums' }}>
                    {(mw / 1000).toFixed(1)}
                  </span>
                </div>
              ))}
              {fuelsWithData.length > 6 && (
                <div style={{ color: t.lblMuted }}>+{fuelsWithData.length - 6} more</div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <p style={{ fontSize: '0.65rem', color: t.muted, fontStyle: 'italic', marginBottom: 12 }}>
          No capacity data available.
        </p>
      )}

      {/* ── Tariff range ──────────────────────── */}
      {tMin !== null && tMax !== null && (
        <div style={{ marginBottom: 8 }}>
          <span style={sec}>Electricity Tariffs · Residential</span>
          <div style={{
            height: 6, borderRadius: 3,
            background: 'linear-gradient(90deg, #40C057, #FCC419, #F03E3E)',
            marginBottom: 6,
          }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span>
              <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#40C057' }}>
                ${Math.round(tMin * 1000)}
              </span>
              <span style={{ fontSize: '0.5rem', color: t.lblMuted, marginLeft: 3 }}>{tMinIso}</span>
            </span>
            <span>
              <span style={{ fontSize: '0.5rem', color: t.lblMuted, marginRight: 3 }}>{tMaxIso}</span>
              <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#F03E3E' }}>
                ${Math.round(tMax * 1000)}
              </span>
            </span>
          </div>
          <p style={{ fontSize: '0.5rem', color: t.lblMuted, marginTop: 5, fontStyle: 'italic' }}>
            USD/MWh · {tariffs.year} · {tariffs.source}
          </p>
        </div>
      )}

      {/* ── Access — regional average ─────────── */}
      {aMin !== null && (() => {
        const vals = region.countries.map(c => access.countries?.[c.iso]?.total).filter(v => v != null);
        const avg = Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
        const color = avg < 30 ? '#F03E3E' : avg < 75 ? '#FCC419' : '#40C057';
        return (
          <div style={{ marginBottom: 8 }}>
            <span style={sec}>Electricity Access · Regional Avg</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: 1, height: 7, borderRadius: 3, backgroundColor: 'rgba(128,160,192,0.12)', overflow: 'hidden' }}>
                <div style={{ width: `${avg}%`, height: '100%', backgroundColor: color, borderRadius: 3, opacity: 0.85 }} />
              </div>
              <span style={{ fontSize: '1rem', fontWeight: 700, color, minWidth: 38, textAlign: 'right' }}>{avg}%</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
              <span style={{ fontSize: '0.55rem', color: t.lblMuted }}>
                Lowest: {aMinIso} {aMin}%
              </span>
              <span style={{ fontSize: '0.55rem', color: t.lblMuted }}>
                of total population
              </span>
            </div>
            <p style={{ fontSize: '0.5rem', color: t.lblMuted, marginTop: 4, fontStyle: 'italic' }}>
              World Bank / SE4All · {access.year}
            </p>
          </div>
        );
      })()}

      {/* ── Source attribution ────────────────── */}
      <p style={{ fontSize: '0.52rem', color: t.lblMuted, marginTop: 4, fontStyle: 'italic' }}>
        Capacity: {source === 'gppd' ? 'WRI GPPD v1.3' : 'OpenStreetMap'} · may be incomplete
      </p>
    </div>
  );
}
