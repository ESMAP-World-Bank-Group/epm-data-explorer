import { useNavigate } from 'react-router-dom';
import { FUEL_COLORS, getT } from '../constants';

export default function StatsPanel({ capacity, region, theme, source = 'osm', tariffs, fleetAge, access }) {
  const navigate = useNavigate();
  const t = getT(theme);

  const sec = {
    fontSize: '0.5rem', letterSpacing: '2px', fontWeight: 700,
    color: t.lblMuted, textTransform: 'uppercase', marginBottom: 7,
    display: 'block',
  };

  if (!capacity) return (
    <p style={{ fontSize: '0.7rem', color: t.muted, fontStyle: 'italic' }}>Loading…</p>
  );

  // Per-country data enriched with tariff + fleet age
  const countryData = region.countries.map(c => {
    const fd = capacity.countries?.[c.iso] || {};
    const total = Object.values(fd).reduce((s, v) => s + v, 0);
    return {
      iso:    c.iso,
      name:   c.name,
      fd,
      total,
      tariff: tariffs?.countries?.[c.iso]?.res ?? null,
      age:    fleetAge?.countries?.[c.iso]?.avg_years ?? null,
      oldest: fleetAge?.countries?.[c.iso]?.oldest_year ?? null,
    };
  }).sort((a, b) => b.total - a.total);

  const maxTotal = Math.max(...countryData.map(c => c.total), 1);
  const fuels    = Object.keys(FUEL_COLORS);

  const ageEntries = countryData.filter(c => c.age != null);
  const maxAge     = Math.max(...ageEntries.map(c => c.age), 1);

  return (
    <div>
      {/* ── Column header ────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, paddingLeft: 34 }}>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: '0.44rem', color: t.lblMuted, minWidth: 34, textAlign: 'right', letterSpacing: '0.5px' }}>GW</span>
        {tariffs && (
          <span style={{ fontSize: '0.44rem', color: t.lblMuted, minWidth: 38, textAlign: 'right', letterSpacing: '0.5px' }}>$/MWh</span>
        )}
      </div>

      {/* ── Per-country rows ─────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 16 }}>
        {countryData.map(c => (
          <div
            key={c.iso}
            onClick={() => navigate(`/country/${c.iso}`)}
            style={{
              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
              padding: '5px 7px', borderRadius: 5,
              backgroundColor: t.cardBg, border: `1px solid ${t.cardBorder}`,
            }}
          >
            <span style={{
              fontSize: '0.56rem', fontWeight: 700, color: 'white',
              backgroundColor: region.color, borderRadius: 3,
              padding: '1px 4px', flexShrink: 0, minWidth: 26, textAlign: 'center',
            }}>
              {c.iso}
            </span>

            {/* Stacked fuel bar */}
            <div style={{
              flex: 1, height: 7, borderRadius: 3,
              backgroundColor: 'rgba(128,160,192,0.1)',
              display: 'flex', overflow: 'hidden',
            }}>
              {fuels.map(fuel => {
                const mw = c.fd[fuel] || 0;
                if (!mw) return null;
                return (
                  <div key={fuel} style={{
                    width: `${(mw / maxTotal) * 100}%`,
                    backgroundColor: FUEL_COLORS[fuel],
                    opacity: 0.85, flexShrink: 0,
                  }} />
                );
              })}
            </div>

            {/* GW */}
            <span style={{
              fontSize: '0.56rem', color: t.muted,
              flexShrink: 0, minWidth: 34, textAlign: 'right',
              fontVariantNumeric: 'tabular-nums',
            }}>
              {c.total > 0 ? (c.total / 1000).toFixed(1) : '—'}
            </span>

            {/* Tariff */}
            {tariffs && (
              <span style={{
                fontSize: '0.52rem', color: t.lblMuted,
                flexShrink: 0, minWidth: 38, textAlign: 'right',
                fontVariantNumeric: 'tabular-nums',
              }}>
                {c.tariff != null ? Math.round(c.tariff * 1000) : '—'}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* ── Fleet age ────────────────────────── */}
      {ageEntries.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <span style={sec}>Fleet Age · MW-weighted avg</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {ageEntries.map(c => (
              <div key={c.iso}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span style={{ fontSize: '0.6rem', color: t.lblRow }}>{c.iso}</span>
                  <span style={{ fontSize: '0.6rem', color: t.muted, fontVariantNumeric: 'tabular-nums' }}>
                    {c.age.toFixed(0)} yrs
                    {c.oldest && <span style={{ opacity: 0.6 }}> · oldest {c.oldest}</span>}
                  </span>
                </div>
                <div style={{
                  height: 4, borderRadius: 2,
                  backgroundColor: 'rgba(128,160,192,0.1)', overflow: 'hidden',
                }}>
                  <div style={{
                    width: `${(c.age / maxAge) * 100}%`, height: '100%',
                    backgroundColor: '#F59F00', opacity: 0.75, borderRadius: 2,
                  }} />
                </div>
              </div>
            ))}
          </div>
          <p style={{ fontSize: '0.5rem', color: t.lblMuted, marginTop: 6, fontStyle: 'italic' }}>
            WRI GPPD v1.3 · ref. year {fleetAge.reference_year}
          </p>
        </div>
      )}

      {source === 'osm' && ageEntries.length === 0 && (
        <p style={{ fontSize: '0.5rem', color: t.lblMuted, fontStyle: 'italic', marginBottom: 8 }}>
          Fleet age available with GPPD source
        </p>
      )}

      {/* ── Electricity access ───────────────── */}
      {access && (() => {
        const withAccess = countryData.filter(c => access.countries?.[c.iso]?.total != null);
        if (!withAccess.length) return null;
        return (
          <div style={{ marginBottom: 10 }}>
            <span style={sec}>Electricity Access · Total %</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {withAccess.map(c => {
                const val = access.countries[c.iso].total;
                const color = val < 30 ? '#F03E3E' : val < 75 ? '#FCC419' : '#40C057';
                return (
                  <div key={c.iso}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                      <span style={{ fontSize: '0.6rem', color: t.lblRow }}>{c.iso}</span>
                      <span style={{ fontSize: '0.6rem', fontWeight: 700, color }}>{val}%</span>
                    </div>
                    <div style={{ height: 4, borderRadius: 2, backgroundColor: 'rgba(128,160,192,0.1)', overflow: 'hidden' }}>
                      <div style={{ width: `${val}%`, height: '100%', backgroundColor: color, opacity: 0.75, borderRadius: 2 }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <p style={{ fontSize: '0.5rem', color: t.lblMuted, marginTop: 6, fontStyle: 'italic' }}>
              World Bank / SE4All · {access.year}
            </p>
          </div>
        );
      })()}

      {/* ── Footer attributions ──────────────── */}
      {tariffs && (
        <p style={{ fontSize: '0.5rem', color: t.lblMuted, fontStyle: 'italic', marginBottom: 2 }}>
          Tariff: USD/MWh res. · {tariffs.year} · {tariffs.source}
        </p>
      )}
      <p style={{ fontSize: '0.52rem', color: t.lblMuted, fontStyle: 'italic' }}>
        Capacity: {source === 'gppd' ? 'WRI GPPD v1.3' : 'OpenStreetMap'} · may be incomplete
      </p>
    </div>
  );
}
