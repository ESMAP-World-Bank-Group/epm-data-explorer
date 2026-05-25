import { FUEL_COLORS, FUEL_LABELS, getT } from '../constants';

const RE_FUELS = new Set(['solar', 'wind', 'hydro', 'geothermal', 'biomass', 'biogas', 'wood']);

function KpiCard({ label, value, accent, t }) {
  return (
    <div style={{
      padding: '7px 10px', borderRadius: 5,
      backgroundColor: t.cardBg, border: `1px solid ${t.cardBorder}`,
    }}>
      <div style={{ fontSize: '0.45rem', color: t.lblMuted, letterSpacing: '1.5px', textTransform: 'uppercase', marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ fontSize: '0.9rem', fontWeight: 700, color: accent || t.lbl, lineHeight: 1 }}>
        {value}
      </div>
    </div>
  );
}

function accessColor(val) {
  return val < 30 ? '#F03E3E' : val < 75 ? '#FCC419' : '#40C057';
}

export default function CountryOverview({ iso, region, capacity, fleetAge, tariffs, access, theme, source = 'osm' }) {
  const t = getT(theme);
  const sec = {
    fontSize: '0.5rem', letterSpacing: '2px', fontWeight: 700,
    color: t.lblMuted, textTransform: 'uppercase', marginBottom: 7, display: 'block',
  };

  // Capacity for this country
  const fd = capacity?.countries?.[iso] || {};
  const fuelEntries = Object.entries(fd).filter(([, v]) => v > 0).sort(([, a], [, b]) => b - a);
  const totalMW = fuelEntries.reduce((s, [, v]) => s + v, 0);
  const reMW   = fuelEntries.filter(([f]) => RE_FUELS.has(f)).reduce((s, [, v]) => s + v, 0);
  const reShare = totalMW > 0 ? Math.round((reMW / totalMW) * 100) : null;
  const maxFuelMW = fuelEntries[0]?.[1] || 1;

  // Region rank by total capacity
  const regionRanked = region.countries
    .map(c => ({ iso: c.iso, total: Object.values(capacity?.countries?.[c.iso] || {}).reduce((s, v) => s + v, 0) }))
    .sort((a, b) => b.total - a.total);
  const rank = regionRanked.findIndex(c => c.iso === iso) + 1;

  const tariffData  = tariffs?.countries?.[iso];
  const ageData     = fleetAge?.countries?.[iso];
  const accessData  = access?.countries?.[iso];

  return (
    <div>
      {/* ── KPI cards ─────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 16 }}>
        <KpiCard
          label="Capacity"
          value={totalMW > 0 ? `${(totalMW / 1000).toFixed(1)} GW` : '—'}
          t={t}
        />
        <KpiCard
          label="RE Share"
          value={reShare !== null ? `${reShare}%` : '—'}
          accent="#4DABF7"
          t={t}
        />
        {rank > 0 && (
          <KpiCard
            label="Region Rank"
            value={`#${rank} of ${region.countries.length}`}
            t={t}
          />
        )}
        {accessData && (
          <KpiCard
            label="Elec. Access"
            value={`${accessData.total}%`}
            accent={accessColor(accessData.total)}
            t={t}
          />
        )}
      </div>

      {/* ── Fuel mix ─────────────────────────── */}
      {fuelEntries.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <span style={sec}>Installed Capacity by Fuel</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {fuelEntries.map(([fuel, mw]) => (
              <div key={fuel}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span style={{ fontSize: '0.6rem', color: t.lblRow }}>{FUEL_LABELS[fuel] || fuel}</span>
                  <span style={{ fontSize: '0.6rem', color: t.muted, fontVariantNumeric: 'tabular-nums' }}>
                    {(mw / 1000).toFixed(1)} GW
                  </span>
                </div>
                <div style={{
                  height: 5, borderRadius: 2,
                  backgroundColor: 'rgba(128,160,192,0.1)', overflow: 'hidden',
                }}>
                  <div style={{
                    width: `${(mw / maxFuelMW) * 100}%`, height: '100%',
                    backgroundColor: FUEL_COLORS[fuel], opacity: 0.85, borderRadius: 2,
                  }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {totalMW === 0 && (
        <p style={{ fontSize: '0.65rem', color: t.muted, fontStyle: 'italic', marginBottom: 12 }}>
          No capacity data for this country.
        </p>
      )}

      {/* ── Electricity tariff ───────────────── */}
      {tariffData && (() => {
        const avg = (tariffData.res != null && tariffData.ind != null)
          ? (tariffData.res + tariffData.ind) / 2 : null;
        const maxVal = Math.max(tariffData.res ?? 0, tariffData.ind ?? 0, avg ?? 0) * 1000;
        const scale = maxVal > 0 ? maxVal * 1.25 : 300;
        return (
          <div style={{ marginBottom: 16 }}>
            <span style={sec}>Electricity Tariff</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {[
                ['Residential', tariffData.res],
                ['Industrial',  tariffData.ind],
                ...(avg != null ? [['Average', avg]] : []),
              ].map(([label, val]) => (
                val != null ? (
                  <div key={label}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                      <span style={{ fontSize: '0.6rem', color: t.lblRow }}>{label}</span>
                      <span style={{ fontSize: '0.6rem', fontWeight: 700, color: '#74C0FC' }}>
                        ${Math.round(val * 1000)} USD/MWh
                      </span>
                    </div>
                    <div style={{ height: 5, borderRadius: 2, backgroundColor: 'rgba(128,160,192,0.1)', overflow: 'hidden' }}>
                      <div style={{
                        width: `${Math.min(100, (val * 1000 / scale) * 100)}%`,
                        height: '100%',
                        backgroundColor: label === 'Average' ? '#4DABF7' : '#74C0FC',
                        opacity: 0.8, borderRadius: 2,
                      }} />
                    </div>
                  </div>
                ) : null
              ))}
            </div>
            <p style={{ fontSize: '0.5rem', color: t.lblMuted, marginTop: 5, fontStyle: 'italic' }}>
              {tariffs.year} · {tariffs.source}
            </p>
          </div>
        );
      })()}

      {/* ── Electricity access ───────────────── */}
      {accessData && (
        <div style={{ marginBottom: 16 }}>
          <span style={sec}>Electricity Access</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {[['Total', accessData.total], ['Urban', accessData.urban], ['Rural', accessData.rural]].map(([label, val]) => (
              <div key={label}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span style={{ fontSize: '0.6rem', color: t.lblRow }}>{label}</span>
                  <span style={{ fontSize: '0.6rem', fontWeight: 700, color: accessColor(val) }}>{val}%</span>
                </div>
                <div style={{ height: 5, borderRadius: 2, backgroundColor: 'rgba(128,160,192,0.1)', overflow: 'hidden' }}>
                  <div style={{
                    width: `${val}%`, height: '100%',
                    backgroundColor: accessColor(val), opacity: 0.8, borderRadius: 2,
                  }} />
                </div>
              </div>
            ))}
          </div>
          <p style={{ fontSize: '0.5rem', color: t.lblMuted, marginTop: 5, fontStyle: 'italic' }}>
            World Bank / SE4All · {access.year}
          </p>
        </div>
      )}

      {/* ── Fleet age ────────────────────────── */}
      {ageData ? (
        <div style={{ marginBottom: 8 }}>
          <span style={sec}>Fleet Age · MW-weighted</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <div style={{ flex: 1, padding: '6px 8px', borderRadius: 5, backgroundColor: t.cardBg, border: `1px solid ${t.cardBorder}` }}>
              <div style={{ fontSize: '0.44rem', color: t.lblMuted, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 3 }}>Avg Age</div>
              <div style={{ fontSize: '0.9rem', fontWeight: 700, color: t.lbl }}>{ageData.avg_years.toFixed(0)} yrs</div>
            </div>
            <div style={{ flex: 1, padding: '6px 8px', borderRadius: 5, backgroundColor: t.cardBg, border: `1px solid ${t.cardBorder}` }}>
              <div style={{ fontSize: '0.44rem', color: t.lblMuted, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 3 }}>Oldest Plant</div>
              <div style={{ fontSize: '0.9rem', fontWeight: 700, color: t.lbl }}>{ageData.oldest_year}</div>
            </div>
          </div>
          <p style={{ fontSize: '0.5rem', color: t.lblMuted, marginTop: 5, fontStyle: 'italic' }}>
            WRI GPPD v1.3 · ref. year {fleetAge.reference_year}
          </p>
        </div>
      ) : (
        <p style={{ fontSize: '0.5rem', color: t.lblMuted, fontStyle: 'italic', marginBottom: 8 }}>
          Fleet age available with GPPD source
        </p>
      )}

      {/* ── Source attribution ────────────────── */}
      <p style={{ fontSize: '0.52rem', color: t.lblMuted, marginTop: 4, fontStyle: 'italic' }}>
        Capacity: {source === 'gppd' ? 'WRI GPPD v1.3' : 'OpenStreetMap'} · may be incomplete
      </p>
    </div>
  );
}
