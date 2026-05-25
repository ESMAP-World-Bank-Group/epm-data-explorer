import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import { useTheme } from '../App';
import {
  getT, mapStyle, swapBasemap, toggleSatLabels, FUEL_COLORS, VOLTAGE_BRACKETS,
  plantRadiusExpr, lcRadiusExpr, fuelColorExpr, PLANT_STATUSES, zoneColorExpr,
} from '../constants';
import CapacityChart from '../components/CapacityChart';
import StatsPanel from '../components/StatsPanel';
import {
  fetchEpmCSV, processGenData, processDemand, processNTC,
  genByFuel, availableYears, EPM_FUEL_COLORS, STATUS_LABEL,
} from '../utils/epmFetch';

// ── Helpers ──────────────────────────────────────────────────────────────────

function fitBounds(isos, countries) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const f of countries.features) {
    if (!isos.includes(f.properties.ISO_A3)) continue;
    const geom = f.geometry;
    const rings = geom.type === 'Polygon'
      ? geom.coordinates
      : geom.coordinates.flatMap(p => p);
    for (const ring of rings)
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
      }
  }
  if (!isFinite(minLon)) return null;
  return [[minLon - 0.5, minLat - 0.5], [maxLon + 0.5, maxLat + 0.5]];
}

/** Build the MapLibre filter for a status layer, respecting fuel visibility and minMw. */
function makeLayerFilter(status, fuelsOff, minMw) {
  const clauses = [
    ['==', ['get', 'status'], status],
    ['>=', ['get', 'mw'], minMw],
  ];
  if (fuelsOff.size > 0)
    clauses.push(['!', ['in', ['get', 'fuel'], ['literal', [...fuelsOff]]]]);
  return ['all', ...clauses];
}

function downloadBlob(content, filename, type = 'application/octet-stream') {
  const blob = new Blob([content], { type });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Tab sub-components ────────────────────────────────────────────────────────

// ── Shared mini utilities ─────────────────────────────────────────────────────

function SectionTitle({ t, children }) {
  return (
    <div style={{ fontSize: '0.47rem', letterSpacing: '2px', fontWeight: 700,
      color: t.lblMuted, textTransform: 'uppercase', marginBottom: 6 }}>
      {children}
    </div>
  );
}

function LoadingBox({ t }) {
  return (
    <div style={{ padding: '18px 0', textAlign: 'center', color: t.lblMuted, fontSize: '0.6rem' }}>
      Loading EPM data…
    </div>
  );
}

function fmt(n, digits = 0) {
  if (n == null || isNaN(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}

// ── Supply tab ────────────────────────────────────────────────────────────────

function EpmSupplyTab({ t, epmData }) {
  const { gen } = epmData;

  // Aggregate by fuel × status
  const statuses = [1, 2, 3];
  const fuels = [...new Set(gen.map(r => r.fuel))].sort();
  const byFuelStatus = {};
  for (const r of gen) {
    if (!byFuelStatus[r.fuel]) byFuelStatus[r.fuel] = {};
    byFuelStatus[r.fuel][r.status] = (byFuelStatus[r.fuel][r.status] || 0) + r.capacity;
  }

  const totalExisting = gen.filter(r => r.status === 1).reduce((s, r) => s + r.capacity, 0);
  const maxFuelTotal  = Math.max(...fuels.map(f =>
    statuses.reduce((s, st) => s + (byFuelStatus[f]?.[st] || 0), 0)));

  const statusColors = { 1: 1.0, 2: 0.45, 3: 0.18 };

  return (
    <div>
      <SectionTitle t={t}>Installed capacity (MW)</SectionTitle>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
        {statuses.map(st => (
          <div key={st} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.52rem', color: t.muted }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: '#888', opacity: statusColors[st] }} />
            {STATUS_LABEL[st]}
          </div>
        ))}
      </div>

      {/* One row per fuel */}
      {fuels.map(fuel => {
        const color = EPM_FUEL_COLORS[fuel] || EPM_FUEL_COLORS.other;
        const total = statuses.reduce((s, st) => s + (byFuelStatus[fuel]?.[st] || 0), 0);
        const barW  = maxFuelTotal > 0 ? (total / maxFuelTotal) * 100 : 0;
        return (
          <div key={fuel} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between',
              fontSize: '0.55rem', color: t.lbl, marginBottom: 2 }}>
              <span style={{ textTransform: 'capitalize' }}>{fuel}</span>
              <span style={{ color: t.muted, fontSize: '0.5rem' }}>
                {statuses.map(st => byFuelStatus[fuel]?.[st]
                  ? `${fmt(byFuelStatus[fuel][st])} ${STATUS_LABEL[st].toLowerCase()}`
                  : null).filter(Boolean).join(' · ')}
              </span>
            </div>
            {/* Stacked bar */}
            <div style={{ display: 'flex', height: 7, borderRadius: 3, overflow: 'hidden',
              width: `${barW}%`, minWidth: 4, backgroundColor: color, opacity: 0.18 }}>
              {statuses.map(st => {
                const mw = byFuelStatus[fuel]?.[st] || 0;
                const pct = total > 0 ? (mw / total) * 100 : 0;
                return pct > 0 ? (
                  <div key={st} style={{
                    width: `${pct}%`, height: '100%',
                    backgroundColor: color, opacity: statusColors[st],
                  }} />
                ) : null;
              })}
            </div>
          </div>
        );
      })}

      <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${t.panelBorder}`,
        fontSize: '0.55rem', color: t.muted }}>
        Total existing: <b style={{ color: t.lbl }}>{fmt(totalExisting / 1000, 1)} GW</b>
        {' '}across {gen.filter(r => r.status === 1).length} units
      </div>
    </div>
  );
}

// ── Demand tab ────────────────────────────────────────────────────────────────

function DemandTab({ t, epmData, epmLoading }) {
  const years = availableYears(epmData?.demand || []);
  const [yr,   setYr]   = useState(null);

  const refYr = yr || years.find(y => y === '2024') || years[0];

  if (epmLoading) return <LoadingBox t={t} />;
  if (!epmData?.demand?.length) return (
    <div style={{ fontSize: '0.6rem', color: t.muted, padding: '12px 0' }}>
      No demand data available for this region.
    </div>
  );

  const peakRows   = epmData.demand.filter(r => r.type === 'peak');
  const energyRows = epmData.demand.filter(r => r.type === 'energy');
  const zones      = [...new Set(epmData.demand.map(r => r.zone))].sort();

  const totalEnergy = energyRows.reduce((s, r) => s + (r.years[refYr] || 0), 0);
  const totalPeak   = peakRows.reduce((s, r)   => s + (r.years[refYr] || 0), 0);

  // Mini sparkline years (5 pts)
  const sparkYrs = years.filter((_, i) => i % Math.max(1, Math.floor(years.length / 5)) === 0).slice(0, 5);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <SectionTitle t={t}>Demand forecast</SectionTitle>
        <select value={refYr} onChange={e => setYr(e.target.value)} style={{
          fontSize: '0.52rem', fontFamily: 'inherit', padding: '2px 6px',
          borderRadius: 4, border: `1px solid ${t.panelBorder}`,
          backgroundColor: t.panel, color: t.lbl, cursor: 'pointer',
        }}>
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      {/* Totals */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
        {[
          { label: 'Total Energy', value: `${fmt(totalEnergy / 1000, 1)} TWh` },
          { label: 'Total Peak',   value: `${fmt(totalPeak, 0)} MW`  },
        ].map(({ label, value }) => (
          <div key={label} style={{ border: `1px solid ${t.panelBorder}`, borderRadius: 6,
            padding: '8px 10px', textAlign: 'center' }}>
            <div style={{ fontSize: '0.47rem', color: t.lblMuted, marginBottom: 2 }}>{label}</div>
            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: t.lbl }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Zone table */}
      <SectionTitle t={t}>By zone — {refYr}</SectionTitle>
      <div style={{ fontSize: '0.52rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 70px',
          color: t.lblMuted, borderBottom: `1px solid ${t.panelBorder}`, paddingBottom: 3, marginBottom: 4 }}>
          <span>Zone</span><span style={{ textAlign: 'right' }}>Energy (GWh)</span>
          <span style={{ textAlign: 'right' }}>Peak (MW)</span>
        </div>
        {zones.map(z => {
          const e = energyRows.find(r => r.zone === z);
          const p = peakRows.find(r => r.zone === z);
          const eMW = e?.years[refYr] || 0;
          const pMW = p?.years[refYr] || 0;
          const maxE = Math.max(...energyRows.map(r => r.years[refYr] || 0));
          return (
            <div key={z} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 70px',
              padding: '3px 0', borderBottom: `1px solid ${t.panelBorder}`,
              color: t.muted, alignItems: 'center' }}>
              <div>
                <div style={{ color: t.lbl, marginBottom: 1 }}>{z}</div>
                <div style={{ height: 3, borderRadius: 2,
                  width: `${maxE > 0 ? (eMW / maxE) * 100 : 0}%`,
                  backgroundColor: '#1AA8B0', opacity: 0.6 }} />
              </div>
              <span style={{ textAlign: 'right' }}>{fmt(eMW)}</span>
              <span style={{ textAlign: 'right' }}>{fmt(pMW)}</span>
            </div>
          );
        })}
      </div>

      {/* Growth indicator */}
      {sparkYrs.length >= 2 && (() => {
        const y0 = sparkYrs[0], yn = sparkYrs[sparkYrs.length - 1];
        const e0 = energyRows.reduce((s, r) => s + (r.years[y0] || 0), 0);
        const en = energyRows.reduce((s, r) => s + (r.years[yn] || 0), 0);
        const pct = e0 > 0 ? ((en - e0) / e0 * 100).toFixed(0) : null;
        return pct ? (
          <div style={{ marginTop: 10, fontSize: '0.52rem', color: t.muted }}>
            Energy growth {y0}→{yn}: <b style={{ color: t.lbl }}>+{pct}%</b>
          </div>
        ) : null;
      })()}
    </div>
  );
}

// ── Topology tab ──────────────────────────────────────────────────────────────

function TopologyTab({ t, epmData, epmLoading, zonesAvailable, zoningConfigs }) {
  const ntcYears = availableYears(epmData?.ntc || []);
  const [yr, setYr] = useState(null);
  const refYr = yr || ntcYears.find(y => y === '2024') || ntcYears[0];

  if (epmLoading) return <LoadingBox t={t} />;

  // Zone → country from zcmap
  const zcmap = epmData?.zcmap || [];
  const countries = [...new Set(zcmap.map(r => r.c))].sort();

  // NTC corridors for refYr, sorted desc
  const corridors = (epmData?.ntc || [])
    .map(r => ({ ...r, mw: r.years[refYr] || 0 }))
    .filter(r => r.mw > 0)
    .sort((a, b) => b.mw - a.mw);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* Zones */}
      {zcmap.length > 0 && (
        <div>
          <SectionTitle t={t}>Zones ({zcmap.length})</SectionTitle>
          {countries.map(c => {
            const czones = zcmap.filter(r => r.c === c).map(r => r.z);
            return (
              <div key={c} style={{ display: 'flex', gap: 6, alignItems: 'baseline',
                fontSize: '0.52rem', padding: '3px 0', borderBottom: `1px solid ${t.panelBorder}` }}>
                <span style={{ color: t.lbl, minWidth: 80 }}>{c}</span>
                <span style={{ color: t.muted }}>{czones.join(', ')}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Zoning configs (from map layers) */}
      {zonesAvailable && (
        <div>
          <SectionTitle t={t}>Zoning configurations</SectionTitle>
          {zoningConfigs.map(cfg => (
            <div key={cfg.slug} style={{ fontSize: '0.52rem', color: t.muted,
              padding: '3px 0', borderBottom: `1px solid ${t.panelBorder}` }}>
              {cfg.name}
            </div>
          ))}
        </div>
      )}

      {/* NTC corridors */}
      {corridors.length > 0 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <SectionTitle t={t}>Internal NTC (MW)</SectionTitle>
            <select value={refYr} onChange={e => setYr(e.target.value)} style={{
              fontSize: '0.52rem', fontFamily: 'inherit', padding: '2px 6px',
              borderRadius: 4, border: `1px solid ${t.panelBorder}`,
              backgroundColor: t.panel, color: t.lbl, cursor: 'pointer',
            }}>
              {ntcYears.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div style={{ fontSize: '0.52rem' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 64px',
              color: t.lblMuted, borderBottom: `1px solid ${t.panelBorder}`, paddingBottom: 3, marginBottom: 4 }}>
              <span>Corridor</span><span style={{ textAlign: 'right' }}>MW</span>
            </div>
            {corridors.map(r => {
              const maxMW = corridors[0]?.mw || 1;
              return (
                <div key={`${r.z}-${r.z2}`} style={{ display: 'grid', gridTemplateColumns: '1fr 64px',
                  padding: '3px 0', borderBottom: `1px solid ${t.panelBorder}`,
                  color: t.muted, alignItems: 'center' }}>
                  <div>
                    <div style={{ color: t.lbl, marginBottom: 1 }}>{r.z} ↔ {r.z2}</div>
                    <div style={{ height: 3, borderRadius: 2,
                      width: `${(r.mw / maxMW) * 100}%`,
                      backgroundColor: '#1a5fa8', opacity: 0.55 }} />
                  </div>
                  <span style={{ textAlign: 'right' }}>{fmt(r.mw)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── About tab ─────────────────────────────────────────────────────────────────

function AboutTab({ region, t, epmData }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ border: `1px solid ${t.panelBorder}`, borderRadius: 8, padding: '12px 14px',
        fontSize: '0.58rem', color: t.muted, lineHeight: 1.6 }}>
        <div style={{ fontSize: '0.6rem', fontWeight: 700, color: t.lbl, marginBottom: 6 }}>
          {region.name} — EPM Study
        </div>
        <div><b style={{ color: t.lbl }}>Countries:</b> {region.countries.map(c => c.name).join(', ')}</div>
        {region.epm && (
          <>
            <div style={{ marginTop: 4 }}>
              <b style={{ color: t.lbl }}>Branch:</b>{' '}
              <code style={{ fontSize: '0.52rem' }}>{region.epm.branch}</code>
            </div>
            <div>
              <b style={{ color: t.lbl }}>Data folder:</b>{' '}
              <code style={{ fontSize: '0.52rem' }}>{region.epm.dataFolder}</code>
            </div>
            <div>
              <b style={{ color: t.lbl }}>Source:</b>{' '}
              <a href={`https://github.com/ESMAP-World-Bank-Group/EPM/tree/${region.epm.branch}`}
                target="_blank" rel="noreferrer"
                style={{ color: t.lbl, fontSize: '0.52rem' }}>
                ESMAP-World-Bank-Group/EPM
              </a>
            </div>
          </>
        )}
      </div>
      <div style={{ border: `1px solid ${t.panelBorder}`, borderRadius: 8, padding: '12px 14px',
        fontSize: '0.58rem', color: t.muted, lineHeight: 1.7 }}>
        <div style={{ fontSize: '0.6rem', fontWeight: 700, color: t.lbl, marginBottom: 6 }}>Data loaded</div>
        {epmData ? (
          <>
            <div>Generation units: <b style={{ color: t.lbl }}>{epmData.gen.length}</b></div>
            <div>Demand zones: <b style={{ color: t.lbl }}>{[...new Set(epmData.demand.map(r => r.zone))].length}</b></div>
            <div>NTC corridors: <b style={{ color: t.lbl }}>{epmData.ntc.length}</b></div>
            <div>Zones mapped: <b style={{ color: t.lbl }}>{epmData.zcmap.length}</b></div>
          </>
        ) : (
          <div style={{ color: t.lblMuted }}>No EPM data configured for this region.</div>
        )}
      </div>
      <div style={{ border: `1px solid ${t.panelBorder}`, borderRadius: 8, padding: '12px 14px',
        fontSize: '0.58rem', color: t.muted, lineHeight: 1.7 }}>
        <div style={{ fontSize: '0.6rem', fontWeight: 700, color: t.lbl, marginBottom: 6 }}>Map data sources</div>
        <div>· Plant locations: OSM / GPPD / GEM</div>
        <div>· Transmission lines: OpenStreetMap</div>
        <div>· EPM inputs: World Bank ESMAP (live from GitHub)</div>
      </div>
    </div>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export default function RegionPage() {
  const { regionId } = useParams();
  const { theme }    = useTheme();
  const t            = getT(theme);
  const navigate     = useNavigate();

  const containerRef = useRef(null);
  const mapRef       = useRef(null);

  const [region,        setRegion]        = useState(null);
  const [capacity,      setCapacity]      = useState(null);
  const [tariffs,       setTariffs]       = useState(null);
  const [fleetAge,      setFleetAge]      = useState(null);
  const [access,        setAccess]        = useState(null);
  const [gppdAvailable, setGppdAvailable] = useState(null);
  const [gemAvailable,  setGemAvailable]  = useState(null);
  const [presentFuels,  setPresentFuels]  = useState(new Set());
  const [fuelsOff,      setFuelsOff]      = useState(new Set());
  const [statusOff,     setStatusOff]     = useState(new Set());
  const [kvsOff,        setKvsOff]        = useState(new Set());
  const [linesOn,       setLinesOn]       = useState(true);
  const [plantsOn,      setPlantsOn]      = useState(true);
  const [subsOn,          setSubsOn]          = useState(false);
  const [loadCentersOn,   setLoadCentersOn]   = useState(false);
  const [lcMinPop,        setLcMinPop]        = useState(300_000);
  const [lcCircleScale,   setLcCircleScale]   = useState(1.0);
  const [minMw,           setMinMw]           = useState(100);
  const [circleScale,     setCircleScale]     = useState(1.0);
  const [plantSource,     setPlantSource]     = useState('osm');
  const [activeTab,       setActiveTab]       = useState('overview');
  const [basemap,         setBasemap]         = useState('minimal');
  const [satLabels,       setSatLabels]       = useState(false);
  const [mapMode,         setMapMode]         = useState('countries');
  const [zonesAvailable,  setZonesAvailable]  = useState(false);
  const [corrExistOn,     setCorrExistOn]     = useState(false);
  const [corrCommOn,      setCorrCommOn]      = useState(false);
  const [corrCandOn,      setCorrCandOn]      = useState(false);
  const [zoningConfigs,   setZoningConfigs]   = useState([]);
  const [selectedSlug,    setSelectedSlug]    = useState(null);
  const [epmData,         setEpmData]         = useState(null);
  const [epmLoading,      setEpmLoading]      = useState(false);

  // Static data
  useEffect(() => {
    fetch('/data/tariffs.json').then(r => r.json()).then(setTariffs).catch(() => {});
    fetch('/data/access.json').then(r => r.json()).then(setAccess).catch(() => {});
  }, []);

  // Region metadata + availability checks
  useEffect(() => {
    fetch('/data/regions.json').then(r => r.json()).then(d => {
      const r = (d.regions || []).find(r => r.id === regionId);
      setRegion(r || null);
    });
    setCapacity(null); setFleetAge(null);
    fetch(`/data/cache/region_capacity_${regionId}.json`).then(r => r.json()).then(setCapacity).catch(() => {});
    setFuelsOff(new Set()); setStatusOff(new Set()); setKvsOff(new Set());
    setLinesOn(true); setPlantsOn(true); setSubsOn(false);
    setLoadCentersOn(false); setLcMinPop(300_000); setLcCircleScale(1.0);
    setMinMw(100); setCircleScale(1.0);
    setPlantSource('osm'); setActiveTab('overview');

    setMapMode('countries'); setZonesAvailable(false);
    setCorrExistOn(false); setCorrCommOn(false); setCorrCandOn(false);
    setZoningConfigs([]); setSelectedSlug(null);
    fetch(`/data/zones/${regionId}_configs.json`)
      .then(r => r.ok ? r.json() : null)
      .then(cfgs => {
        if (cfgs?.length) {
          setZoningConfigs(cfgs);
          setSelectedSlug(cfgs[0].slug);
          setZonesAvailable(true);
        }
      })
      .catch(() => {});

    setGppdAvailable(null);
    fetch(`/data/cache/region_plants_${regionId}_gppd.geojson`, { method: 'HEAD' })
      .then(r => setGppdAvailable(r.ok)).catch(() => setGppdAvailable(false));

    setGemAvailable(null);
    fetch(`/data/cache/region_plants_${regionId}_gem.geojson`, { method: 'HEAD' })
      .then(r => setGemAvailable(r.ok)).catch(() => setGemAvailable(false));
  }, [regionId]);

  // EPM data — fetched from GitHub raw when region has epm config
  useEffect(() => {
    setEpmData(null);
    if (!region?.epm) return;
    const { branch, dataFolder } = region.epm;
    setEpmLoading(true);
    Promise.all([
      fetchEpmCSV(branch, dataFolder, 'supply/pGenDataInput.csv'),
      fetchEpmCSV(branch, dataFolder, 'load/pDemandForecast.csv'),
      fetchEpmCSV(branch, dataFolder, 'trade/pTransferLimit.csv'),
      fetchEpmCSV(branch, dataFolder, 'zcmap.csv'),
    ]).then(([gen, demand, ntc, zcmap]) => {
      setEpmData({
        gen:    gen    ? processGenData(gen)    : [],
        demand: demand ? processDemand(demand)  : [],
        ntc:    ntc    ? processNTC(ntc)        : [],
        zcmap:  zcmap  || [],
        branch,
      });
    }).finally(() => setEpmLoading(false));
  }, [region]);

  // Fleet age — GPPD only
  useEffect(() => {
    setFleetAge(null);
    if (plantSource !== 'gppd') return;
    fetch(`/data/cache/region_age_${regionId}_gppd.json`)
      .then(r => r.ok ? r.json() : null).then(setFleetAge).catch(() => {});
  }, [plantSource, regionId]);

  // Map initialisation
  useEffect(() => {
    if (!containerRef.current || !region) return;

    const isos = region.countries.map(c => c.iso);
    const TERRITORY_ALIASES = { SOM: ['SOL'], SDN: ['SDS'] };
    const expandedIsos = isos.flatMap(iso => [iso, ...(TERRITORY_ALIASES[iso] || [])]);

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: mapStyle(theme),
      center: [0, 20], zoom: 2, minZoom: 1, maxZoom: 14,
      attributionControl: false,
    });
    mapRef.current = map;

    const popup = new maplibregl.Popup({
      closeButton: false, closeOnClick: false, offset: 10,
      className: `popup-${theme}`,
    });

    map.on('load', async () => {
      const [countries, plantsGJ, linesGJ, subsGJ, lcGJ] = await Promise.all([
        fetch('/data/countries_10m.geojson').then(r => r.json()),
        fetch(`/data/cache/region_plants_${regionId}.geojson`).then(r => r.json()),
        fetch(`/data/cache/region_lines_${regionId}.geojson`).then(r => r.json()),
        fetch(`/data/cache/region_substations_${regionId}.geojson`)
          .then(r => r.json()).catch(() => ({ type: 'FeatureCollection', features: [] })),
        fetch(`/data/region_load_centers_${regionId}.geojson`)
          .then(r => r.json()).catch(() => ({ type: 'FeatureCollection', features: [] })),
      ]);

      countries.features.forEach((f, i) => {
        const p = f.properties;
        let iso = p.ISO_A3 || '-99';
        if (iso === '-99') iso = p.ISO_A3_EH || '-99';
        if (iso === '-99') iso = p.ADM0_A3 || '-99';
        p.ISO_A3 = iso; f.id = i;
      });

      const bounds = fitBounds(expandedIsos, countries);
      if (bounds) map.fitBounds(bounds, { padding: 40, duration: 0 });

      map.addSource('countries',    { type: 'geojson', data: countries, generateId: false });
      map.addSource('plants',       { type: 'geojson', data: plantsGJ });
      map.addSource('lines',        { type: 'geojson', data: linesGJ  });
      map.addSource('substations',  { type: 'geojson', data: subsGJ   });
      map.addSource('load-centers', { type: 'geojson', data: lcGJ     });

      const tv = getT(theme);
      map.addLayer({ id: 'land',    type: 'fill', source: 'countries',
        paint: { 'fill-color': tv.land, 'fill-opacity': 1 } });
      map.addLayer({ id: 'borders', type: 'line', source: 'countries',
        paint: { 'line-color': tv.worldBdr, 'line-width': tv.worldBdrW } });


      // Transmission lines
      const kvFilters = {
        '500': ['>=', ['get', 'v'], 500_000],
        '330': ['all', ['>=', ['get', 'v'], 330_000], ['<', ['get', 'v'], 500_000]],
        '220': ['all', ['>=', ['get', 'v'], 220_000], ['<', ['get', 'v'], 330_000]],
        '110': ['<', ['get', 'v'], 220_000],
      };
      for (const { colors, width, key } of VOLTAGE_BRACKETS) {
        map.addLayer({ id: `lines-${key}`, type: 'line', source: 'lines',
          filter: kvFilters[key],
          paint: { 'line-color': colors[theme] ?? colors.fog, 'line-width': width,
            'line-opacity': tv.isDark ? 0.92 : 0.65 } });
      }

      // Region highlight
      const hl = tv.highlight;
      map.addLayer({ id: 'region-fill', type: 'fill', source: 'countries',
        filter: ['in', ['get', 'ISO_A3'], ['literal', expandedIsos]],
        paint: { 'fill-color': hl.fill,
          'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.18, 0.08] } });
      map.addLayer({ id: 'region-border', type: 'line', source: 'countries',
        filter: ['in', ['get', 'ISO_A3'], ['literal', expandedIsos]],
        paint: { 'line-color': hl.border, 'line-width': hl.borderW, 'line-opacity': 0.9 } });


      // Preferred zones overlay (hidden until mapMode === 'zones')
      const emptyGJ = { type: 'FeatureCollection', features: [] };
      map.addSource('region-zones',         { type: 'geojson', data: emptyGJ });
      map.addSource('region-zones-inner',   { type: 'geojson', data: emptyGJ });
      map.addSource('region-corridors-src', { type: 'geojson', data: emptyGJ });
      map.addSource('region-centroids-src', { type: 'geojson', data: emptyGJ });

      const zoneLayerPaint = {
        fill:   { 'fill-color': zoneColorExpr(), 'fill-opacity': 0.35 },
        border: { 'line-color': tv.isDark ? '#bbb' : '#444', 'line-width': 1.2, 'line-opacity': 0.7 },
      };
      map.addLayer({ id: 'region-zones-fill',   type: 'fill', source: 'region-zones',
        layout: { visibility: 'none' }, paint: zoneLayerPaint.fill });
      map.addLayer({ id: 'region-zones-border', type: 'line', source: 'region-zones-inner',
        layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
        paint: zoneLayerPaint.border });

      // Corridor capacity lines for preferred zone view
      const mwWidthExpr     = (field) => ['interpolate', ['linear'], ['coalesce', ['get', field], 0], 0, 1.5, 500, 3.0, 2000, 6.0];
      const hasNtcField     = (field) => ['>', ['coalesce', ['get', field], 0], 0];
      map.addLayer({
        id: 'region-corridors-ex', type: 'line', source: 'region-corridors-src',
        filter: hasNtcField('mw_existing'),
        layout: { visibility: 'none' },
        paint: { 'line-color': '#1a5fa8', 'line-width': mwWidthExpr('mw_existing'), 'line-opacity': 0.85 },
      });
      map.addLayer({
        id: 'region-corridors-committed', type: 'line', source: 'region-corridors-src',
        filter: hasNtcField('mw_committed'),
        layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#e07b00', 'line-width': mwWidthExpr('mw_committed'), 'line-opacity': 0.85, 'line-dasharray': [6, 3] },
      });
      map.addLayer({
        id: 'region-corridors-candidate', type: 'line', source: 'region-corridors-src',
        filter: hasNtcField('mw_candidate'),
        layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#555', 'line-width': mwWidthExpr('mw_candidate'), 'line-opacity': 0.7, 'line-dasharray': [2, 4] },
      });
      map.addLayer({
        id: 'region-corridors-labels', type: 'symbol', source: 'region-corridors-src',
        filter: ['>', ['coalesce', ['get', 'mw'], 0], 0],
        layout: {
          visibility: 'none',
          'text-field': ['get', 'label'],
          'text-size': 9,
          'symbol-placement': 'line-center',
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': '#1a5fa8',
          'text-halo-color': 'rgba(255,255,255,0.9)',
          'text-halo-width': 1.5,
        },
      });
      map.addLayer({
        id: 'region-corridors-dots', type: 'circle', source: 'region-centroids-src',
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': 4, 'circle-color': '#696969',
          'circle-opacity': 0.75,
          'circle-stroke-width': 1.2, 'circle-stroke-color': 'rgba(255,255,255,0.7)',
        },
      });

      // ── Plant layers (3 status layers, data-driven fuel color) ───────────
      const fuels = new Set();
      for (const f of plantsGJ.features) {
        const fuel = f.properties.fuel;
        if (fuel && FUEL_COLORS[fuel]) fuels.add(fuel);
      }
      setPresentFuels(fuels);

      const colorExpr = fuelColorExpr();

      // Operating: filled circles
      map.addLayer({ id: 'plants-operating', type: 'circle', source: 'plants',
        filter: makeLayerFilter('operating', new Set(), 100),
        paint: {
          'circle-radius':       plantRadiusExpr(),
          'circle-color':        colorExpr,
          'circle-opacity':      0.88,
          'circle-stroke-width': 0.6,
          'circle-stroke-color': 'rgba(0,0,0,0.3)',
        },
      });

      // Under construction: hollow ring
      map.addLayer({ id: 'plants-construction', type: 'circle', source: 'plants',
        filter: makeLayerFilter('construction', new Set(), 100),
        paint: {
          'circle-radius':         plantRadiusExpr(),
          'circle-color':          'rgba(0,0,0,0)',
          'circle-opacity':        1,
          'circle-stroke-width':   2,
          'circle-stroke-color':   colorExpr,
          'circle-stroke-opacity': 0.9,
        },
      });

      // Planned: faint filled + thin stroke
      map.addLayer({ id: 'plants-planned', type: 'circle', source: 'plants',
        filter: makeLayerFilter('planned', new Set(), 100),
        paint: {
          'circle-radius':         plantRadiusExpr(),
          'circle-color':          colorExpr,
          'circle-opacity':        0.22,
          'circle-stroke-width':   1,
          'circle-stroke-color':   colorExpr,
          'circle-stroke-opacity': 0.45,
        },
      });

      // Hover popups for each status layer
      for (const status of PLANT_STATUSES) {
        map.on('mouseenter', `plants-${status}`, e => {
          map.getCanvas().style.cursor = 'pointer';
          const p = e.features[0].properties;
          const name   = p.name ? `<b>${p.name}</b><br>` : '';
          const mwText = p.mw   ? ` · ${p.mw} MW` : '';
          const badge  = status !== 'operating'
            ? ` <span style="opacity:.55;font-size:.85em">[${status}]</span>` : '';
          popup.setLngLat(e.features[0].geometry.coordinates)
            .setHTML(`${name}<span style="opacity:.75">${p.fuel}${mwText}${badge}</span>`)
            .addTo(map);
        });
        map.on('mouseleave', `plants-${status}`, () => {
          map.getCanvas().style.cursor = ''; popup.remove();
        });
      }

      // Substations
      const sqSz = 5;
      const sqData = new Uint8Array(sqSz * sqSz * 4);
      for (let i = 0; i < sqSz * sqSz; i++) {
        sqData[i*4] = 105; sqData[i*4+1] = 105; sqData[i*4+2] = 105;
        sqData[i*4+3] = tv.isDark ? 160 : 130;
      }
      map.addImage('sub-sq', { width: sqSz, height: sqSz, data: sqData });
      map.addLayer({ id: 'substations', type: 'symbol', source: 'substations',
        filter: ['in', ['get', 'iso'], ['literal', isos]],
        layout: { 'icon-image': 'sub-sq', 'icon-allow-overlap': true, 'icon-ignore-placement': true, visibility: 'none' },
        paint: { 'icon-opacity': 0.8 } });
      map.on('mouseenter', 'substations', e => {
        map.getCanvas().style.cursor = 'pointer';
        const p = e.features[0].properties;
        const kv = p.v ? `${Math.round(p.v / 1000)} kV` : '';
        popup.setLngLat(e.features[0].geometry.coordinates)
          .setHTML(`${p.name ? `<b>${p.name}</b><br>` : ''}<span style="opacity:.75">Substation${kv ? ' · ' + kv : ''}</span>`)
          .addTo(map);
      });
      map.on('mouseleave', 'substations', () => { map.getCanvas().style.cursor = ''; popup.remove(); });

      // Load centers
      map.addLayer({
        id: 'load-centers', type: 'circle', source: 'load-centers',
        filter: ['>=', ['get', 'pop'], 300_000],
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': lcRadiusExpr(),
          'circle-color': '#1a237e', 'circle-opacity': 0.72,
          'circle-stroke-width': 1.2, 'circle-stroke-color': 'rgba(255,255,255,0.65)',
        },
      });
      map.addLayer({
        id: 'load-centers-labels', type: 'symbol', source: 'load-centers',
        filter: ['>=', ['get', 'pop'], 300_000],
        layout: {
          visibility: 'none',
          'text-field': ['get', 'name'], 'text-size': 9,
          'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-allow-overlap': false,
        },
        paint: {
          'text-color': '#1a237e',
          'text-halo-color': 'rgba(255,255,255,0.88)', 'text-halo-width': 1.5,
        },
      });
      map.on('mouseenter', 'load-centers', e => {
        map.getCanvas().style.cursor = 'pointer';
        const p = e.features[0].properties;
        const pop = p.pop >= 1_000_000 ? `${(p.pop / 1_000_000).toFixed(1)}M` : `${Math.round(p.pop / 1_000)}k`;
        popup.setLngLat(e.features[0].geometry.coordinates)
          .setHTML(`<b>${p.name}</b><br><span style="opacity:.75">${pop} pop.</span>`).addTo(map);
      });
      map.on('mouseleave', 'load-centers', () => { map.getCanvas().style.cursor = ''; popup.remove(); });

      // Country hover + click
      let hoveredId = null;
      map.on('mousemove', 'region-fill', e => {
        map.getCanvas().style.cursor = 'pointer';
        if (hoveredId !== null)
          map.setFeatureState({ source: 'countries', id: hoveredId }, { hover: false });
        hoveredId = e.features[0].id;
        map.setFeatureState({ source: 'countries', id: hoveredId }, { hover: true });
      });
      map.on('mouseleave', 'region-fill', () => {
        map.getCanvas().style.cursor = '';
        if (hoveredId !== null)
          map.setFeatureState({ source: 'countries', id: hoveredId }, { hover: false });
        hoveredId = null;
      });
      const ALIAS_TO_CANON = { SOL: 'SOM', SDS: 'SDN' };
      map.on('click', 'region-fill', e => {
        const iso = e.features[0].properties.ISO_A3;
        const canonIso = (!isos.includes(iso) && ALIAS_TO_CANON[iso]) || iso;
        if (isos.includes(canonIso)) navigate(`/country/${canonIso}`);
      });
      const onZoneClick = e => {
        const iso = e.features[0].properties.ISO_A3 || e.features[0].properties.country;
        const canonIso = (!isos.includes(iso) && ALIAS_TO_CANON[iso]) || iso;
        if (isos.includes(canonIso)) navigate(`/country/${canonIso}`);
      };
      map.on('click', 'region-zones-fill', onZoneClick);
      map.on('mouseenter', 'region-zones-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'region-zones-fill', () => { map.getCanvas().style.cursor = ''; });

    });

    return () => { popup.remove(); mapRef.current?.remove(); };
  }, [region, theme]);

  // ── Basemap switcher ─────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    swapBasemap(map, basemap, theme);
    if (basemap !== 'satellite') toggleSatLabels(map, false, theme);
  }, [basemap, theme]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || basemap !== 'satellite') return;
    toggleSatLabels(map, satLabels, theme);
  }, [satLabels, basemap, theme]);

  // ── Zone mode / refine toggle ─────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer('region-zones-fill')) return;
    const showZones = mapMode === 'zones';

    if (showZones) {
      const slug       = selectedSlug || 'recommended';
      const url        = `/data/zones/${regionId}_${slug}_zones_hd.geojson`;
      const corrUrl    = `/data/zones/${regionId}_${slug}_corridors.geojson`;
      const innerUrl   = `/data/zones/${regionId}_${slug}_inner_borders.geojson`;
      Promise.all([
        fetch(url).then(r => { if (!r.ok) throw new Error(); return r.json(); }),
        fetch(corrUrl).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(innerUrl).then(r => r.ok ? r.json() : null).catch(() => null),
      ])
        .then(([data, corridorsGJ, innerGJ]) => {
          const m = mapRef.current;
          if (!m?.getSource('region-zones')) return;
          m.getSource('region-zones').setData(data);
          if (m.getSource('region-zones-inner'))
            m.getSource('region-zones-inner').setData(innerGJ || data);
          m.setLayoutProperty('region-zones-fill',   'visibility', 'visible');
          m.setLayoutProperty('region-zones-border', 'visibility', 'visible');
          m.setLayoutProperty('region-fill', 'visibility', 'none');
          const emptyGJ = { type: 'FeatureCollection', features: [] };
          if (m.getSource('region-corridors-src'))
            m.getSource('region-corridors-src').setData(corridorsGJ || emptyGJ);
          // Extract centroids from corridor endpoints
          const centroidMap = new Map();
          for (const f of (corridorsGJ?.features || [])) {
            const [s, e] = [f.geometry.coordinates[0], f.geometry.coordinates[f.geometry.coordinates.length - 1]];
            const ks = `${s[0]},${s[1]}`, ke = `${e[0]},${e[1]}`;
            if (!centroidMap.has(ks)) centroidMap.set(ks, { type: 'Feature', geometry: { type: 'Point', coordinates: s }, properties: { zone: f.properties.zone_a } });
            if (!centroidMap.has(ke)) centroidMap.set(ke, { type: 'Feature', geometry: { type: 'Point', coordinates: e }, properties: { zone: f.properties.zone_b } });
          }
          if (m.getSource('region-centroids-src'))
            m.getSource('region-centroids-src').setData({ type: 'FeatureCollection', features: [...centroidMap.values()] });
          const layerVis = {
            'region-corridors-ex':        corrExistOn ? 'visible' : 'none',
            'region-corridors-committed':  corrCommOn  ? 'visible' : 'none',
            'region-corridors-candidate':  corrCandOn  ? 'visible' : 'none',
            'region-corridors-labels':    corrExistOn ? 'visible' : 'none',
            'region-corridors-dots':      (corrExistOn || corrCommOn || corrCandOn) ? 'visible' : 'none',
          };
          for (const [id, vis] of Object.entries(layerVis))
            if (m.getLayer(id)) m.setLayoutProperty(id, 'visibility', vis);
        })
        .catch(() => setMapMode('countries'));
    } else {
      if (map.getLayer('region-zones-fill'))   map.setLayoutProperty('region-zones-fill',   'visibility', 'none');
      if (map.getLayer('region-zones-border')) map.setLayoutProperty('region-zones-border', 'visibility', 'none');
      if (map.getLayer('region-fill'))         map.setLayoutProperty('region-fill', 'visibility', 'visible');
      if (map.getSource('region-zones'))
        map.getSource('region-zones').setData({ type: 'FeatureCollection', features: [] });
      if (map.getSource('region-zones-inner'))
        map.getSource('region-zones-inner').setData({ type: 'FeatureCollection', features: [] });
      for (const id of ['region-corridors-ex', 'region-corridors-committed', 'region-corridors-candidate', 'region-corridors-labels', 'region-corridors-dots']) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
      }
      if (map.getSource('region-corridors-src'))
        map.getSource('region-corridors-src').setData({ type: 'FeatureCollection', features: [] });
      if (map.getSource('region-centroids-src'))
        map.getSource('region-centroids-src').setData({ type: 'FeatureCollection', features: [] });
    }
  }, [mapMode, regionId, corrExistOn, corrCommOn, corrCandOn, selectedSlug]);

  // ── Layer toggle handlers ─────────────────────────────────────────────────

  const toggleFuel = useCallback(fuel => {
    const map = mapRef.current;
    if (!map) return;
    setFuelsOff(prev => {
      const next = new Set(prev);
      if (next.has(fuel)) next.delete(fuel); else next.add(fuel);
      for (const s of PLANT_STATUSES) {
        if (map.getLayer(`plants-${s}`))
          map.setFilter(`plants-${s}`, makeLayerFilter(s, next, minMw));
      }
      return next;
    });
  }, [minMw]);

  const toggleStatus = useCallback(status => {
    const map = mapRef.current;
    if (!map || !map.getLayer(`plants-${status}`)) return;
    setStatusOff(prev => {
      const next    = new Set(prev);
      const hiding  = !prev.has(status);
      if (hiding) next.add(status); else next.delete(status);
      if (plantsOn)
        map.setLayoutProperty(`plants-${status}`, 'visibility', hiding ? 'none' : 'visible');
      return next;
    });
  }, [plantsOn]);

  const toggleKv = useCallback(key => {
    const map = mapRef.current;
    if (!map || !map.getLayer(`lines-${key}`)) return;
    setKvsOff(prev => {
      const next = new Set(prev);
      if (next.has(key)) { next.delete(key); map.setLayoutProperty(`lines-${key}`, 'visibility', 'visible'); }
      else               { next.add(key);    map.setLayoutProperty(`lines-${key}`, 'visibility', 'none');    }
      return next;
    });
  }, []);

  const toggleLines = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    setLinesOn(prev => {
      const next = !prev;
      for (const { key } of VOLTAGE_BRACKETS)
        if (!kvsOff.has(key) && map.getLayer(`lines-${key}`))
          map.setLayoutProperty(`lines-${key}`, 'visibility', next ? 'visible' : 'none');
      return next;
    });
  }, [kvsOff]);

  const togglePlants = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    setPlantsOn(prev => {
      const next = !prev;
      for (const s of PLANT_STATUSES) {
        if (!map.getLayer(`plants-${s}`)) continue;
        if (!statusOff.has(s))
          map.setLayoutProperty(`plants-${s}`, 'visibility', next ? 'visible' : 'none');
      }
      return next;
    });
  }, [statusOff]);

  const toggleSubs = useCallback(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer('substations')) return;
    setSubsOn(prev => {
      const next = !prev;
      map.setLayoutProperty('substations', 'visibility', next ? 'visible' : 'none');
      return next;
    });
  }, []);

  const handleMinMw = useCallback(mw => {
    const map = mapRef.current;
    if (!map) return;
    setMinMw(mw);
    for (const s of PLANT_STATUSES)
      if (map.getLayer(`plants-${s}`))
        map.setFilter(`plants-${s}`, makeLayerFilter(s, fuelsOff, mw));
  }, [fuelsOff]);

  const handleCircleScale = useCallback(scale => {
    const map = mapRef.current;
    if (!map) return;
    setCircleScale(scale);
    for (const s of PLANT_STATUSES)
      if (map.getLayer(`plants-${s}`))
        map.setPaintProperty(`plants-${s}`, 'circle-radius', plantRadiusExpr(scale));
  }, []);

  const makeCorridorToggle = (layerIds, setter) => () => {
    const map = mapRef.current;
    if (!map) return;
    setter(prev => {
      const next = !prev;
      for (const id of layerIds)
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', next ? 'visible' : 'none');
      return next;
    });
  };
  const toggleCorrExist = useCallback(
    makeCorridorToggle(['region-corridors-ex', 'region-corridors-labels', 'region-corridors-dots'], setCorrExistOn), []);
  const toggleCorrComm  = useCallback(
    makeCorridorToggle(['region-corridors-committed', 'region-corridors-dots'], setCorrCommOn), []);
  const toggleCorrCand  = useCallback(
    makeCorridorToggle(['region-corridors-candidate', 'region-corridors-dots'], setCorrCandOn), []);

  const toggleLoadCenters = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    setLoadCentersOn(prev => {
      const next = !prev;
      for (const id of ['load-centers', 'load-centers-labels'])
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', next ? 'visible' : 'none');
      return next;
    });
  }, []);

  const handleLcMinPop = useCallback(pop => {
    const map = mapRef.current;
    if (!map) return;
    setLcMinPop(pop);
    for (const id of ['load-centers', 'load-centers-labels'])
      if (map.getLayer(id)) map.setFilter(id, ['>=', ['get', 'pop'], pop]);
  }, []);

  const handleLcCircleScale = useCallback(scale => {
    const map = mapRef.current;
    if (!map) return;
    setLcCircleScale(scale);
    if (map.getLayer('load-centers'))
      map.setPaintProperty('load-centers', 'circle-radius', lcRadiusExpr(scale));
  }, []);

  // Plant source hot-swap
  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getSource('plants')) return;
    const suffix = plantSource === 'gppd' ? '_gppd' : plantSource === 'gem' ? '_gem' : '';
    const f  = `region_plants_${regionId}${suffix}.geojson`;
    const cf = `region_capacity_${regionId}${suffix}.json`;
    fetch(`/data/cache/${f}`)
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(data => {
        map.getSource('plants').setData(data);
        const fuels = new Set(data.features.map(f => f.properties.fuel).filter(f => FUEL_COLORS[f]));
        setPresentFuels(fuels);
        return fetch(`/data/cache/${cf}`).then(r => r.json());
      })
      .then(setCapacity)
      .catch(() => {
        if (plantSource === 'gppd') { setGppdAvailable(false); setPlantSource('osm'); }
        if (plantSource === 'gem')  { setGemAvailable(false);  setPlantSource('osm'); }
      });
  }, [plantSource, regionId]);


  // ── Download helpers ──────────────────────────────────────────────────────

  const handleDownloadPlants = useCallback(async (format = 'geojson') => {
    const suffix = plantSource === 'gppd' ? '_gppd' : plantSource === 'gem' ? '_gem' : '';
    const url  = `/data/cache/region_plants_${regionId}${suffix}.geojson`;
    const data = await fetch(url).then(r => r.json());
    if (format === 'csv') {
      const header = 'name,fuel,mw,country,status,lat,lon,source';
      const rows = data.features.map(f => {
        const p = f.properties;
        const [lon, lat] = f.geometry.coordinates;
        return [
          `"${(p.name || '').replace(/"/g, '""')}"`,
          p.fuel || '', p.mw || '', p.country || '', p.status || '',
          lat.toFixed(5), lon.toFixed(5), plantSource,
        ].join(',');
      });
      downloadBlob([header, ...rows].join('\n'), `plants_${regionId}${suffix}.csv`, 'text/csv');
    } else {
      downloadBlob(JSON.stringify(data), `plants_${regionId}${suffix}.geojson`, 'application/geo+json');
    }
  }, [plantSource, regionId]);

  const handleDownloadLines = useCallback(async (format = 'geojson') => {
    const url  = `/data/cache/region_lines_${regionId}.geojson`;
    const data = await fetch(url).then(r => r.json());
    if (format === 'csv') {
      const header = 'id,voltage_kv,geometry_wkt';
      const rows = data.features.map((f, i) => {
        const vkv   = f.properties.v ? Math.round(f.properties.v / 1000) : '';
        const wkt   = `LINESTRING(${f.geometry.coordinates.map(([x, y]) => `${x} ${y}`).join(', ')})`;
        return `${i},${vkv},"${wkt}"`;
      });
      downloadBlob([header, ...rows].join('\n'), `lines_${regionId}.csv`, 'text/csv');
    } else {
      downloadBlob(JSON.stringify(data), `lines_${regionId}.geojson`, 'application/geo+json');
    }
  }, [regionId]);

  const handleDownloadCapacity = useCallback(() => {
    if (!capacity || !region) return;
    const fuels = Object.keys(FUEL_COLORS);
    const header = ['country', 'iso', ...fuels, 'total_mw'];
    const rows = region.countries.map(c => {
      const cd    = capacity.countries?.[c.iso] || {};
      const total = Object.values(cd).reduce((s, v) => s + v, 0);
      return [c.name, c.iso, ...fuels.map(f => (cd[f] || 0).toFixed(1)), total.toFixed(1)];
    });
    downloadBlob([header, ...rows].map(r => r.join(',')).join('\n'),
      `capacity_${regionId}.csv`, 'text/csv');
  }, [capacity, region, regionId]);

  const handleDownloadTariffs = useCallback(() => {
    if (!tariffs || !region) return;
    const rows = region.countries.map(c => {
      const d = tariffs.countries?.[c.iso] || {};
      return [c.name, c.iso,
        d.res != null ? Math.round(d.res * 1000) : '',
        d.ind != null ? Math.round(d.ind * 1000) : ''];
    });
    downloadBlob(['country,iso,residential_usd_mwh,industrial_usd_mwh', ...rows.map(r => r.join(','))].join('\n'),
      `tariffs_${regionId}.csv`, 'text/csv');
  }, [tariffs, region, regionId]);

  const handleDownloadAccess = useCallback(() => {
    if (!access || !region) return;
    const rows = region.countries.map(c => {
      const d = access.countries?.[c.iso] || {};
      return [c.name, c.iso, d.total ?? '', d.urban ?? '', d.rural ?? ''];
    });
    downloadBlob(['country,iso,total_pct,urban_pct,rural_pct', ...rows.map(r => r.join(','))].join('\n'),
      `access_${regionId}.csv`, 'text/csv');
  }, [access, region, regionId]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (!region) return <div style={{ padding: 40, color: t.text }}>Loading…</div>;

  const dlBtn = {
    background: 'none', border: 'none', cursor: 'pointer',
    padding: '1px 4px', borderRadius: 3, color: t.lblMuted,
    fontSize: '0.6rem', fontFamily: 'inherit',
    display: 'inline-flex', alignItems: 'center', gap: 3,
  };

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 46px)' }}>

      <div style={{ position: 'relative', flex: 1 }}>
        <div ref={containerRef}
          style={{ width: '100%', height: 'calc(100vh - 46px)', backgroundColor: t.bg }} />
        {zonesAvailable && (
          <div style={{ position: 'absolute', top: 10, left: 10, zIndex: 10, display: 'flex', gap: 6, alignItems: 'center' }}>
            {/* Potential Zonings toggle */}
            <button
              onClick={() => setMapMode(m => m === 'zones' ? 'countries' : 'zones')}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: '0.58rem', letterSpacing: '0.5px', fontFamily: 'inherit',
                padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
                border: `1px solid ${mapMode === 'zones' ? 'rgba(74,143,204,0.6)' : t.panelBorder}`,
                backgroundColor: mapMode === 'zones' ? 'rgba(74,143,204,0.14)' : t.panel,
                color: mapMode === 'zones' ? t.lbl : t.lblMuted,
                fontWeight: mapMode === 'zones' ? 700 : 400,
                boxShadow: '0 1px 4px rgba(0,0,0,.18)',
                transition: 'all 0.15s',
              }}>
              <span style={{
                width: 8, height: 8, borderRadius: 2,
                backgroundColor: mapMode === 'zones' ? 'rgba(74,143,204,0.8)' : t.panelBorder,
                display: 'inline-block', transition: 'background 0.15s',
              }} />
              Potential Zonings
            </button>

            {/* Config selector — only when zone mode is active and multiple configs exist */}
            {mapMode === 'zones' && zoningConfigs.length > 1 && (
              <select
                value={selectedSlug || ''}
                onChange={e => setSelectedSlug(e.target.value)}
                style={{
                  fontSize: '0.58rem', fontFamily: 'inherit',
                  padding: '5px 8px', borderRadius: 6,
                  border: `1px solid rgba(74,143,204,0.5)`,
                  backgroundColor: t.panel, color: t.lbl,
                  cursor: 'pointer',
                  boxShadow: '0 1px 4px rgba(0,0,0,.18)',
                  outline: 'none',
                }}>
                {zoningConfigs.map(cfg => (
                  <option key={cfg.slug} value={cfg.slug}>{cfg.name}</option>
                ))}
              </select>
            )}

            {/* Corridor type toggles — only in zone mode */}
            {mapMode === 'zones' && [
              { label: 'Existing',   on: corrExistOn, toggle: toggleCorrExist, color: '#1a5fa8', dash: null },
              { label: 'Committed',  on: corrCommOn,  toggle: toggleCorrComm,  color: '#e07b00', dash: '8 3' },
              { label: 'Candidate',  on: corrCandOn,  toggle: toggleCorrCand,  color: '#666',    dash: '2 4' },
            ].map(({ label, on, toggle, color, dash }) => (
              <button key={label} onClick={toggle} style={{
                display: 'flex', alignItems: 'center', gap: 5,
                fontSize: '0.58rem', letterSpacing: '0.5px', fontFamily: 'inherit',
                padding: '5px 9px', borderRadius: 6, cursor: 'pointer',
                border: `1px solid ${on ? color + '99' : t.panelBorder}`,
                backgroundColor: on ? color + '22' : t.panel,
                color: on ? t.lbl : t.lblMuted,
                fontWeight: on ? 700 : 400,
                boxShadow: '0 1px 4px rgba(0,0,0,.18)',
                transition: 'all 0.15s',
              }}>
                <svg width="16" height="4" style={{ flexShrink: 0 }}>
                  <line x1="0" y1="2" x2="16" y2="2"
                    stroke={on ? color : t.panelBorder} strokeWidth="2.5"
                    strokeDasharray={dash || ''} strokeLinecap="round" />
                </svg>
                {label}
              </button>
            ))}
          </div>
        )}

        {/* Top-right: basemap + layer toggles */}
        <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 10, display: 'flex', gap: 4, alignItems: 'center' }}>
          {[
            { id: 'minimal',   label: 'Map'    },
            { id: 'labeled',   label: 'Labels' },
            { id: 'satellite', label: 'Sat'    },
          ].map(({ id, label }) => {
            const active = (basemap || 'minimal') === id;
            return (
              <button key={id} onClick={() => setBasemap(id)} style={{
                fontSize: '0.52rem', letterSpacing: '0.5px', fontFamily: 'inherit',
                padding: '4px 8px', borderRadius: 5, cursor: 'pointer',
                border: `1px solid ${active ? 'rgba(74,143,204,0.6)' : t.panelBorder}`,
                backgroundColor: active ? 'rgba(74,143,204,0.14)' : t.panel,
                color: active ? t.lbl : t.lblMuted,
                boxShadow: '0 1px 4px rgba(0,0,0,.18)',
                transition: 'all 0.15s',
              }}>{label}</button>
            );
          })}
          <div style={{ width: 1, height: 16, backgroundColor: t.panelBorder, margin: '0 2px' }} />
          {[
            { label: 'Plants', on: plantsOn, toggle: togglePlants },
            { label: 'Lines',  on: linesOn,  toggle: toggleLines  },
          ].map(({ label, on, toggle }) => (
            <button key={label} onClick={toggle} style={{
              fontSize: '0.52rem', letterSpacing: '0.5px', fontFamily: 'inherit',
              padding: '4px 8px', borderRadius: 5, cursor: 'pointer',
              border: `1px solid ${on ? 'rgba(128,160,192,0.55)' : t.panelBorder}`,
              backgroundColor: on ? 'rgba(128,160,192,0.12)' : t.panel,
              color: on ? t.lbl : t.lblMuted,
              boxShadow: '0 1px 4px rgba(0,0,0,.18)',
              transition: 'all 0.15s',
            }}>{label}</button>
          ))}
        </div>
      </div>

      {/* Right panel */}
      <div style={{
        width: 360, height: 'calc(100vh - 46px)', overflowY: 'auto',
        padding: '18px 16px',
        backgroundColor: t.panel, borderLeft: `1px solid ${t.panelBorder}`,
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 16, flexWrap: 'wrap' }}>
          <Link to="/" style={{ fontSize: '0.75rem', color: t.muted }}>World</Link>
          <span style={{ color: t.panelBorder, fontSize: '0.75rem' }}>/</span>
          <span style={{ fontSize: '0.75rem', color: t.lbl, fontWeight: 600 }}>{region.name}</span>
        </div>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: t.text, marginBottom: 4 }}>
          {region.name}
        </h2>
        <p style={{ fontSize: '0.8rem', color: t.muted, marginBottom: 16 }}>
          {region.countries.length} countries
        </p>
        <div style={{ height: 3, borderRadius: 2, backgroundColor: region.color, width: 36, marginBottom: 20 }} />

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 2, marginBottom: 14, flexWrap: 'wrap' }}>
          {['Overview', 'Supply', 'Demand', 'Topology', 'About'].map(tab => {
            const key    = tab.toLowerCase();
            const active = activeTab === key;
            return (
              <button key={tab} onClick={() => setActiveTab(key)} style={{
                flex: '1 1 auto', fontSize: '0.55rem', letterSpacing: '0.8px',
                textTransform: 'uppercase', fontFamily: 'inherit',
                padding: '4px 6px', borderRadius: 4, cursor: 'pointer',
                border: `1px solid ${active ? t.lbl : t.panelBorder}`,
                backgroundColor: active ? 'rgba(128,160,192,0.12)' : 'transparent',
                color: active ? t.lbl : t.lblMuted,
                fontWeight: active ? 700 : 400,
              }}>{tab}</button>
            );
          })}
        </div>

        {activeTab === 'overview'  && <CapacityChart capacity={capacity} region={region} theme={theme} source={plantSource} tariffs={tariffs} access={access} />}
        {activeTab === 'supply'    && (
          epmData
            ? <EpmSupplyTab t={t} epmData={epmData} />
            : epmLoading
              ? <LoadingBox t={t} />
              : <StatsPanel capacity={capacity} region={region} theme={theme} source={plantSource} tariffs={tariffs} fleetAge={fleetAge} access={access} />
        )}
        {activeTab === 'demand'    && <DemandTab   t={t} epmData={epmData} epmLoading={epmLoading} />}
        {activeTab === 'topology'  && <TopologyTab t={t} epmData={epmData} epmLoading={epmLoading} zonesAvailable={zonesAvailable} zoningConfigs={zoningConfigs} />}
        {activeTab === 'about'     && <AboutTab    region={region} t={t} epmData={epmData} />}

        {/* Export section */}
        <div style={{ marginTop: 20, borderTop: `1px solid ${t.panelBorder}`, paddingTop: 12 }}>
          <span style={{ fontSize: '0.47rem', letterSpacing: '2px', fontWeight: 700, color: t.lblMuted, textTransform: 'uppercase', display: 'block', marginBottom: 7 }}>
            Export Data
          </span>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
            {[
              { label: 'Plants GeoJSON',  handler: handleDownloadPlants },
              { label: 'Lines GeoJSON',   handler: handleDownloadLines  },
              { label: 'Capacity CSV',    handler: handleDownloadCapacity },
              tariffs && { label: 'Tariffs CSV', handler: handleDownloadTariffs },
              access  && { label: 'Access CSV',  handler: handleDownloadAccess  },
            ].filter(Boolean).map(({ label, handler }) => (
              <button key={label} onClick={handler} style={{
                ...dlBtn,
                border: `1px solid ${t.panelBorder}`,
                padding: '4px 6px', justifyContent: 'center',
                fontSize: '0.52rem', color: t.muted,
              }}>
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                {label}
              </button>
            ))}
          </div>
          <p style={{ fontSize: '0.47rem', color: t.lblMuted, marginTop: 6, fontStyle: 'italic' }}>
            Source: {plantSource.toUpperCase()} · {region.name}
          </p>
        </div>
      </div>
    </div>
  );
}
