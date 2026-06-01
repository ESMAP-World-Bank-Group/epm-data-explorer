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
  fetchEpmCSV, fetchLinestringGeoJSON, fetchZonesGeoJSON,
  processGenData, processDemand,
  processNTC, processDemandProfile, availableYears, EPM_FUEL_COLORS, STATUS_LABEL,
} from '../utils/epmFetch';

// chart.js via CDN — no npm dep
function CJChart({ type, data, options, height }) {
  const canvasRef = useRef(null);
  const chartRef  = useRef(null);
  const sig = JSON.stringify({ type, labels: data.labels,
    ds: data.datasets?.map(d => ({ l: d.label, n: d.data?.length, t: d.type, f: d.fill })) });
  useEffect(() => {
    const CJ = window.Chart;
    if (!CJ || !canvasRef.current) return;
    chartRef.current?.destroy();
    chartRef.current = new CJ(canvasRef.current, { type, data, options });
    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div style={{ height, width: '100%', position: 'relative' }}>
      <canvas ref={canvasRef} />
    </div>
  );
}

const ZONE_PALETTE = [
  '#1E9AF5','#FF6B6B','#52C860','#FFD700','#C8A8F0',
  '#FF8C42','#44DAEC','#E74C3C','#9B59B6','#2ECC71',
  '#F39C12','#1ABC9C','#E67E22','#8E44AD','#16A085','#D35400',
];

/** Compute the centroid of a GeoJSON polygon or multipolygon geometry. */
function computeCentroid(geometry) {
  if (!geometry) return null;
  const rings = geometry.type === 'Polygon'
    ? geometry.coordinates
    : geometry.coordinates.flatMap(p => p);
  let x = 0, y = 0, n = 0;
  for (const ring of rings)
    for (const [lon, lat] of ring) { x += lon; y += lat; n++; }
  return n > 0 ? [x / n, y / n] : null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fitBounds(isos, countries) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const f of countries.features) {
    if (!isos.includes(f.properties.ISO_A3)) continue;
    const geom = f.geometry;
    const rings = geom.type === 'Polygon' ? geom.coordinates : geom.coordinates.flatMap(p => p);
    for (const ring of rings)
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
      }
  }
  if (!isFinite(minLon)) return null;
  return [[minLon - 0.5, minLat - 0.5], [maxLon + 0.5, maxLat + 0.5]];
}

function makeLayerFilter(status, fuelsOff, minMw) {
  const clauses = [['==', ['get', 'status'], status], ['>=', ['get', 'mw'], minMw]];
  if (fuelsOff.size > 0)
    clauses.push(['!', ['in', ['get', 'fuel'], ['literal', [...fuelsOff]]]]);
  return ['all', ...clauses];
}

function downloadBlob(content, filename, type = 'application/octet-stream') {
  const blob = new Blob([content], { type });
  const url  = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function makeDonutSVG(fuelMix, tv, size = 52) {
  const cx = size / 2, cy = size / 2;
  const r  = size / 2 - 10;
  const sw = 8;
  const circum = 2 * Math.PI * r;
  const entries = Object.entries(fuelMix).filter(([, v]) => v > 0);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (total === 0 || r <= 0) return '';
  let cumDeg = -90;
  const arcs = entries.map(([fuel, mw]) => {
    const angle = (mw / total) * 360;
    const start = (cumDeg * Math.PI) / 180;
    const end   = ((cumDeg + angle) * Math.PI) / 180;
    cumDeg += angle;
    const x1 = cx + r * Math.cos(start), y1 = cy + r * Math.sin(start);
    const x2 = cx + r * Math.cos(end),   y2 = cy + r * Math.sin(end);
    const large = angle > 180 ? 1 : 0;
    const color = EPM_FUEL_COLORS[fuel] || '#AAAAAA';
    return `<path d="M${x1} ${y1} A${r} ${r} 0 ${large} 1 ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="butt"/>`;
  });
  const totalGW   = total / 1000;
  const label = totalGW >= 1 ? totalGW.toFixed(1) : total.toFixed(0);
  const unit  = totalGW >= 1 ? 'GW' : 'MW';
  const bg    = tv.isDark ? 'rgba(20,20,20,0.82)' : 'rgba(255,255,255,0.88)';
  const tc    = tv.isDark ? '#fff' : '#111';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <circle cx="${cx}" cy="${cy}" r="${r + sw / 2 + 1}" fill="${bg}" stroke="rgba(0,0,0,0.18)" stroke-width="0.5"/>
    ${arcs.join('')}
    <text x="${cx}" y="${cy - 1}" text-anchor="middle" font-size="9" font-weight="700" fill="${tc}" font-family="system-ui,sans-serif">${label}</text>
    <text x="${cx}" y="${cy + 9}" text-anchor="middle" font-size="7" fill="${tc}" font-family="system-ui,sans-serif" opacity="0.65">${unit}</text>
  </svg>`;
}

// ── Shared mini utilities ─────────────────────────────────────────────────────

function NotAvailable({ t }) {
  return (
    <div style={{ border: `1px dashed ${t.panelBorder}`, borderRadius: 8,
      padding: '24px 16px', textAlign: 'center', color: t.lblMuted, fontSize: '0.58rem' }}>
      <div style={{ fontSize: '0.6rem', fontWeight: 700, color: t.lbl, marginBottom: 4 }}>Not available</div>
      No EPM input data configured for this region yet.
    </div>
  );
}
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
    <div style={{ padding: '24px 0', textAlign: 'center', color: t.lblMuted, fontSize: '0.6rem' }}>
      Loading EPM data…
    </div>
  );
}
function fmt(n, digits = 0) {
  if (n == null || isNaN(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}
function cjDefaults(t) {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: t.panel, borderColor: t.panelBorder, borderWidth: 1,
        titleColor: t.lbl, bodyColor: t.muted,
        titleFont: { size: 9 }, bodyFont: { size: 9 }, padding: 6,
      },
    },
    scales: {
      x: { grid: { color: t.panelBorder }, ticks: { color: t.muted, font: { size: 8 } } },
      y: { grid: { color: t.panelBorder }, ticks: { color: t.muted, font: { size: 8 } } },
    },
  };
}
function hexA(hex, a) {
  if (!hex || hex.length < 7) return `rgba(128,128,128,${a})`;
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}

// ── Overview tab ──────────────────────────────────────────────────────────────

function EpmOverviewTab({ t, epmData, region }) {
  const { gen, demand, ntc, zcmap } = epmData;
  const allYears = availableYears(demand);
  const refYr    = allYears.find(y => y === '2024') || allYears[0];

  const existing    = gen.filter(r => r.status === 1);
  const totalGW     = existing.reduce((s, r) => s + r.capacity, 0) / 1000;
  const peakRows    = demand.filter(r => r.type === 'peak');
  const energyRows  = demand.filter(r => r.type === 'energy');
  const peakGW      = peakRows.reduce((s, r) => s + (r.years[refYr] || 0), 0) / 1000;
  const energyTWh   = energyRows.reduce((s, r) => s + (r.years[refYr] || 0), 0) / 1000;
  const ntcTotal    = ntc.reduce((s, r) => s + (r.years[refYr] || r.years[allYears[0]] || 0), 0);
  const nZones      = zcmap.length;
  const nCountries  = region.countries.length;

  // Capacity by fuel
  const fuelAgg = {};
  for (const r of existing) fuelAgg[r.fuel] = (fuelAgg[r.fuel] || 0) + r.capacity;
  const fuelData = Object.entries(fuelAgg)
    .map(([fuel, mw]) => ({ fuel, mw: Math.round(mw) }))
    .sort((a, b) => b.mw - a.mw);

  // Capacity by country (via zcmap zone→country)
  const zoneToCountry = Object.fromEntries(zcmap.map(r => [r.z, r.c]));
  const countryFuelAgg = {};
  for (const r of existing) {
    const country = zoneToCountry[r.zone] || r.zone;
    if (!countryFuelAgg[country]) countryFuelAgg[country] = {};
    countryFuelAgg[country][r.fuel] = (countryFuelAgg[country][r.fuel] || 0) + r.capacity;
  }
  const countries = Object.entries(countryFuelAgg)
    .map(([c, fuels]) => ({ c, total: Object.values(fuels).reduce((s, v) => s + v, 0), fuels }))
    .sort((a, b) => b.total - a.total);
  const allFuels = [...new Set(fuelData.map(d => d.fuel))];

  const kpis = [
    { label: 'Installed Capacity', value: `${totalGW.toFixed(1)} GW`, sub: 'existing fleet' },
    { label: `Peak — ${refYr}`,    value: `${peakGW.toFixed(1)} GW`,  sub: 'system peak demand' },
    { label: `Energy — ${refYr}`,  value: `${energyTWh.toFixed(0)} TWh`, sub: 'total energy demand' },
    { label: 'Total NTC',          value: `${fmt(Math.round(ntcTotal / nZones))} MW`, sub: 'avg per corridor' },
    { label: 'Countries',          value: nCountries,                   sub: `${nZones} zones` },
    { label: 'NTC Corridors',      value: ntc.length,                   sub: `${refYr}` },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {kpis.map(({ label, value, sub }) => (
          <div key={label} style={{ border: `1px solid ${t.panelBorder}`, borderRadius: 6,
            padding: '10px 12px', textAlign: 'center' }}>
            <div style={{ fontSize: '0.44rem', color: t.lblMuted, textTransform: 'uppercase',
              letterSpacing: '1px', marginBottom: 4 }}>{label}</div>
            <div style={{ fontSize: '1rem', fontWeight: 700, color: t.lbl, lineHeight: 1 }}>{value}</div>
            <div style={{ fontSize: '0.44rem', color: t.lblMuted, marginTop: 3 }}>{sub}</div>
          </div>
        ))}
      </div>

      <div>
        <SectionTitle t={t}>Existing capacity by fuel (MW)</SectionTitle>
        <CJChart type="bar" height={Math.min(fuelData.length * 22 + 24, 240)}
          data={{
            labels: fuelData.map(d => d.fuel),
            datasets: [{ data: fuelData.map(d => d.mw),
              backgroundColor: fuelData.map(d => EPM_FUEL_COLORS[d.fuel] || EPM_FUEL_COLORS.other),
              borderWidth: 0, barThickness: 12 }],
          }}
          options={{ ...cjDefaults(t), indexAxis: 'y',
            scales: {
              x: { grid: { color: t.panelBorder }, ticks: { color: t.muted, font: { size: 8 },
                callback: v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v } },
              y: { grid: { display: false }, ticks: { color: t.muted, font: { size: 8 } } },
            },
            plugins: { ...cjDefaults(t).plugins,
              tooltip: { ...cjDefaults(t).plugins.tooltip,
                callbacks: { label: ctx => `${ctx.raw.toLocaleString()} MW` } } },
          }}
        />
      </div>

      {countries.length > 0 && (
        <div>
          <SectionTitle t={t}>Capacity mix by country (MW)</SectionTitle>
          <CJChart type="bar" height={Math.min(countries.length * 24 + 24, 280)}
            data={{
              labels: countries.map(d => d.c),
              datasets: allFuels.map(fuel => ({
                label: fuel,
                data: countries.map(d => Math.round(d.fuels[fuel] || 0)),
                backgroundColor: EPM_FUEL_COLORS[fuel] || EPM_FUEL_COLORS.other,
                borderWidth: 0, barThickness: 14,
              })),
            }}
            options={{ ...cjDefaults(t), indexAxis: 'y',
              scales: {
                x: { stacked: true, grid: { color: t.panelBorder }, ticks: { color: t.muted, font: { size: 8 },
                  callback: v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v } },
                y: { stacked: true, grid: { display: false }, ticks: { color: t.muted, font: { size: 8 } } },
              },
              plugins: { ...cjDefaults(t).plugins,
                legend: { display: false },
                tooltip: { ...cjDefaults(t).plugins.tooltip,
                  callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.raw.toLocaleString()} MW` } },
              },
            }}
          />
          {/* Fuel legend */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 8px', marginTop: 6 }}>
            {allFuels.map(f => (
              <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: '0.44rem', color: t.muted }}>
                <div style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: EPM_FUEL_COLORS[f] || '#aaa' }} />{f}
              </div>
            ))}
          </div>
        </div>
      )}

      {region.epm && (
        <a href={`https://github.com/ESMAP-World-Bank-Group/EPM/tree/${region.epm.branch}`}
          target="_blank" rel="noreferrer"
          style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.52rem',
            color: t.lblMuted, textDecoration: 'none', marginTop: 2 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
          </svg>
          View on GitHub · {region.epm.branch}
        </a>
      )}
    </div>
  );
}

// ── Supply tab ────────────────────────────────────────────────────────────────

function EpmSupplyTab({ t, epmData, region }) {
  const { gen, zcmap } = epmData;
  const [visStatuses, setVisStatuses] = useState(new Set([1, 2, 3]));
  const [selectedPlant, setSelectedPlant] = useState(null);
  const [search, setSearch] = useState('');
  const [sortCol, setSortCol] = useState('capacity');

  const zoneToCountry = Object.fromEntries(zcmap.map(r => [r.z, r.c]));
  const filtered = gen.filter(r => visStatuses.has(r.status));
  const searched = search
    ? filtered.filter(r => r.g.toLowerCase().includes(search.toLowerCase()) ||
        r.zone.toLowerCase().includes(search.toLowerCase()) ||
        r.fuel.toLowerCase().includes(search.toLowerCase()))
    : filtered;
  const sorted = [...searched].sort((a, b) => {
    if (sortCol === 'capacity') return b.capacity - a.capacity;
    if (sortCol === 'name') return a.g.localeCompare(b.g);
    if (sortCol === 'fuel') return a.fuel.localeCompare(b.fuel);
    return 0;
  });

  // Chart by fuel
  const fuels = [...new Set(gen.map(r => r.fuel))].sort();
  const byFS = {};
  for (const r of filtered) {
    if (!byFS[r.fuel]) byFS[r.fuel] = { 1: 0, 2: 0, 3: 0 };
    byFS[r.fuel][r.status] = (byFS[r.fuel][r.status] || 0) + r.capacity;
  }
  const fuelChartData = fuels
    .filter(f => byFS[f])
    .map(f => ({ fuel: f, ex: Math.round(byFS[f]?.[1] || 0), co: Math.round(byFS[f]?.[2] || 0), ca: Math.round(byFS[f]?.[3] || 0) }))
    .sort((a, b) => (b.ex + b.co + b.ca) - (a.ex + a.co + a.ca));

  // Chart by country
  const byCountryFuel = {};
  for (const r of filtered) {
    const country = zoneToCountry[r.zone] || r.zone;
    if (!byCountryFuel[country]) byCountryFuel[country] = {};
    byCountryFuel[country][r.fuel] = (byCountryFuel[country][r.fuel] || 0) + r.capacity;
  }
  const ctryData = Object.entries(byCountryFuel)
    .map(([c, fuelMap]) => ({ c, total: Object.values(fuelMap).reduce((s, v) => s + v, 0), fuelMap }))
    .sort((a, b) => b.total - a.total);
  const allFuels = [...new Set(filtered.map(r => r.fuel))];

  const toggleStatus = s => setVisStatuses(prev => {
    const next = new Set(prev);
    if (next.has(s)) { if (next.size > 1) next.delete(s); } else next.add(s);
    return next;
  });

  const statusConfig = [
    { s: 1, label: 'Existing',  color: '#1a5fa8' },
    { s: 2, label: 'Committed', color: '#e07b00' },
    { s: 3, label: 'Candidate', color: '#888' },
  ];

  const handleDownload = async () => {
    const { branch, dataFolder } = region.epm;
    const url = `https://raw.githubusercontent.com/ESMAP-World-Bank-Group/EPM/${branch}/epm/input/${dataFolder}/supply/pGenDataInput.csv`;
    try {
      const res = await fetch(url);
      const text = await res.text();
      downloadBlob(text, `pGenDataInput_${region.id}.csv`, 'text/csv');
    } catch { alert('Download failed'); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Status toggles */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={{ fontSize: '0.48rem', color: t.lblMuted }}>Show:</span>
        {statusConfig.map(({ s, label, color }) => (
          <button key={s} onClick={() => toggleStatus(s)} style={{
            fontSize: '0.48rem', fontFamily: 'inherit', padding: '3px 8px', borderRadius: 4,
            cursor: 'pointer', border: `1px solid ${visStatuses.has(s) ? color : t.panelBorder}`,
            backgroundColor: visStatuses.has(s) ? hexA(color, 0.15) : 'transparent',
            color: visStatuses.has(s) ? t.lbl : t.lblMuted, fontWeight: visStatuses.has(s) ? 600 : 400,
          }}>{label}</button>
        ))}
      </div>

      {/* Chart by fuel */}
      <div>
        <SectionTitle t={t}>Capacity by fuel (MW)</SectionTitle>
        <CJChart type="bar" height={Math.min(fuelChartData.length * 22 + 24, 260)}
          data={{
            labels: fuelChartData.map(d => d.fuel),
            datasets: [
              { label: 'Existing',  data: fuelChartData.map(d => d.ex),
                backgroundColor: fuelChartData.map(d => EPM_FUEL_COLORS[d.fuel] || EPM_FUEL_COLORS.other),
                borderWidth: 0, barThickness: 12, stack: 'a' },
              { label: 'Committed', data: fuelChartData.map(d => d.co),
                backgroundColor: fuelChartData.map(d => hexA(EPM_FUEL_COLORS[d.fuel] || EPM_FUEL_COLORS.other, 0.5)),
                borderWidth: 0, barThickness: 12, stack: 'a' },
              { label: 'Candidate', data: fuelChartData.map(d => d.ca),
                backgroundColor: fuelChartData.map(d => hexA(EPM_FUEL_COLORS[d.fuel] || EPM_FUEL_COLORS.other, 0.22)),
                borderWidth: 0, barThickness: 12, stack: 'a' },
            ],
          }}
          options={{ ...cjDefaults(t), indexAxis: 'y',
            scales: {
              x: { stacked: true, grid: { color: t.panelBorder }, ticks: { color: t.muted, font: { size: 8 },
                callback: v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v } },
              y: { stacked: true, grid: { display: false }, ticks: { color: t.muted, font: { size: 8 } } },
            },
          }}
        />
        <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
          {[['Existing', 1.0, '#1a5fa8'], ['Committed', 0.5, '#e07b00'], ['Candidate', 0.22, '#888']].map(([lbl, op, c]) => (
            <div key={lbl} style={{ display: 'flex', alignItems: 'center', gap: 3,
              fontSize: '0.44rem', color: t.muted }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: c, opacity: op }} />{lbl}
            </div>
          ))}
        </div>
      </div>

      {/* Chart by country */}
      {ctryData.length > 0 && (
        <div>
          <SectionTitle t={t}>Capacity by country (MW)</SectionTitle>
          <CJChart type="bar" height={Math.min(ctryData.length * 24 + 24, 260)}
            data={{
              labels: ctryData.map(d => d.c),
              datasets: allFuels.map(fuel => ({
                label: fuel,
                data: ctryData.map(d => Math.round(d.fuelMap[fuel] || 0)),
                backgroundColor: EPM_FUEL_COLORS[fuel] || EPM_FUEL_COLORS.other,
                borderWidth: 0, barThickness: 14, stack: 'a',
              })),
            }}
            options={{ ...cjDefaults(t), indexAxis: 'y',
              scales: {
                x: { stacked: true, grid: { color: t.panelBorder }, ticks: { color: t.muted, font: { size: 8 },
                  callback: v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v } },
                y: { stacked: true, grid: { display: false }, ticks: { color: t.muted, font: { size: 8 } } },
              },
              plugins: { ...cjDefaults(t).plugins, legend: { display: false },
                tooltip: { ...cjDefaults(t).plugins.tooltip,
                  callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.raw.toLocaleString()} MW` } } },
            }}
          />
        </div>
      )}

      {/* Plant database */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <SectionTitle t={t}>Plant database ({sorted.length})</SectionTitle>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search…"
            style={{ fontSize: '0.48rem', fontFamily: 'inherit', padding: '2px 6px', borderRadius: 4,
              border: `1px solid ${t.panelBorder}`, backgroundColor: t.panel, color: t.lbl,
              width: 90, outline: 'none' }} />
        </div>
        {/* Sort chips */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
          {['capacity', 'name', 'fuel'].map(col => (
            <button key={col} onClick={() => setSortCol(col)} style={{
              fontSize: '0.44rem', fontFamily: 'inherit', padding: '1px 5px', borderRadius: 3,
              cursor: 'pointer', border: `1px solid ${sortCol === col ? t.lbl : t.panelBorder}`,
              backgroundColor: sortCol === col ? hexA('#1a5fa8', 0.12) : 'transparent',
              color: sortCol === col ? t.lbl : t.lblMuted,
            }}>Sort: {col}</button>
          ))}
        </div>
        <div style={{ maxHeight: 260, overflowY: 'auto', border: `1px solid ${t.panelBorder}`, borderRadius: 6 }}>
          {sorted.slice(0, 200).map(r => (
            <div key={`${r.g}-${r.zone}`}
              onClick={() => setSelectedPlant(selectedPlant?.g === r.g ? null : r)}
              style={{ display: 'grid', gridTemplateColumns: '1fr 60px 50px 36px',
                padding: '4px 8px', borderBottom: `1px solid ${t.panelBorder}`,
                cursor: 'pointer', fontSize: '0.5rem', alignItems: 'center',
                backgroundColor: selectedPlant?.g === r.g ? hexA('#1a5fa8', 0.08) : 'transparent',
              }}>
              <span style={{ color: t.lbl, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.g}</span>
              <span style={{ color: t.muted, fontSize: '0.44rem' }}>{r.zone}</span>
              <span>
                <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 1, marginRight: 3,
                  backgroundColor: EPM_FUEL_COLORS[r.fuel] || '#aaa' }} />
                <span style={{ color: t.muted, fontSize: '0.44rem' }}>{r.fuel}</span>
              </span>
              <span style={{ color: t.lbl, textAlign: 'right', fontWeight: 600 }}>{fmt(r.capacity)}</span>
            </div>
          ))}
        </div>
        {sorted.length > 200 && (
          <div style={{ fontSize: '0.44rem', color: t.lblMuted, marginTop: 3 }}>
            Showing 200 of {sorted.length} — use search to filter
          </div>
        )}
        {/* Detail panel */}
        {selectedPlant && (
          <div style={{ marginTop: 8, border: `1px solid ${t.panelBorder}`, borderRadius: 6,
            padding: '10px 12px', fontSize: '0.52rem', lineHeight: 1.7 }}>
            <div style={{ fontWeight: 700, color: t.lbl, marginBottom: 6, fontSize: '0.58rem' }}>{selectedPlant.g}</div>
            {[
              ['Zone', selectedPlant.zone],
              ['Country', zoneToCountry[selectedPlant.zone] || '—'],
              ['Fuel', selectedPlant.fuel],
              ['Tech', selectedPlant.tech],
              ['Status', STATUS_LABEL[selectedPlant.status]],
              ['Capacity', `${fmt(selectedPlant.capacity)} MW`],
              ['Comm. year', selectedPlant.stYr || '—'],
              ['Retire year', selectedPlant.retrYr || '—'],
              ['Heat rate', selectedPlant.heatRate ? `${selectedPlant.heatRate.toFixed(2)} GJ/MWh` : '—'],
              ['Capex', selectedPlant.capex != null && selectedPlant.capex > 0 ? `${fmt(selectedPlant.capex)} USD/kW` : '—'],
              ['FOM', selectedPlant.fom != null && selectedPlant.fom > 0 ? `${fmt(selectedPlant.fom)} USD/MW/yr` : '—'],
              ['VOM', selectedPlant.vom != null && selectedPlant.vom > 0 ? `${selectedPlant.vom.toFixed(2)} USD/MWh` : '—'],
            ].map(([label, value]) => (
              <div key={label} style={{ display: 'grid', gridTemplateColumns: '90px 1fr', borderBottom: `1px solid ${t.panelBorder}`, padding: '2px 0' }}>
                <span style={{ color: t.lblMuted }}>{label}</span>
                <span style={{ color: t.lbl }}>{value}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Export */}
      <button onClick={handleDownload} style={{
        fontSize: '0.52rem', fontFamily: 'inherit', padding: '5px 10px', borderRadius: 4,
        border: `1px solid ${t.panelBorder}`, backgroundColor: 'transparent', color: t.muted,
        cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, alignSelf: 'flex-start',
      }}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Download pGenDataInput.csv
      </button>
    </div>
  );
}

// ── Demand tab ────────────────────────────────────────────────────────────────

function DemandTab({ t, epmData, epmLoading, hasEpm }) {
  const allYears  = availableYears(epmData?.demand || []);
  const allZones  = [...new Set((epmData?.demand || []).map(r => r.zone))].sort();
  const [selZones, setSelZones]   = useState(null);
  const [snapYear, setSnapYear]   = useState(null);
  const [profZone, setProfZone]   = useState(null);

  if (!hasEpm)                         return <NotAvailable t={t} />;
  if (epmLoading)                      return <LoadingBox t={t} />;
  if (!epmData?.demand?.length)        return <NotAvailable t={t} />;

  const activeZones = selZones || allZones;
  const refSnap = snapYear || allYears.find(y => y === '2030') || allYears[Math.floor(allYears.length / 2)];
  const peakRows   = epmData.demand.filter(r => r.type === 'peak');
  const energyRows = epmData.demand.filter(r => r.type === 'energy');

  // Chart 1 — total dual-axis
  const totalByYear = allYears.map(y => ({
    year: y,
    'Peak (GW)':    +(peakRows.reduce((s, r)   => s + (r.years[y] || 0), 0) / 1000).toFixed(2),
    'Energy (TWh)': +(energyRows.reduce((s, r) => s + (r.years[y] || 0), 0) / 1000).toFixed(1),
  }));

  // Chart 2 — demand by zone (horizontal bars, selected year)
  const byZoneSnap = [...allZones]
    .map((z, i) => ({
      zone: z,
      color: ZONE_PALETTE[i % ZONE_PALETTE.length],
      energy: +(energyRows.find(r => r.zone === z)?.years[refSnap] || 0) / 1000, // TWh
      peak:   Math.round(peakRows.find(r => r.zone === z)?.years[refSnap] || 0),   // MW
    }))
    .sort((a, b) => b.energy - a.energy);

  // Chart 3 — demand profile (average hourly)
  const demandProfile = epmData?.demandProfile;
  const profZones = demandProfile ? Object.keys(demandProfile).sort() : [];
  const profZoneActive = profZone || profZones[0];
  const profData = demandProfile?.[profZoneActive];

  const toggleZone = z => {
    if (!selZones) { setSelZones([z]); return; }
    const next = selZones.includes(z) ? selZones.filter(s => s !== z) : [...selZones, z];
    setSelZones(next.length === 0 || next.length === allZones.length ? null : next);
  };

  const handleDownload = () => {
    const header = 'zone,type,' + allYears.join(',');
    const rows = epmData.demand.map(r => `${r.zone},${r.type},${allYears.map(y => r.years[y] ?? '').join(',')}`);
    downloadBlob([header, ...rows].join('\n'), `pDemandForecast_${epmData.branch || ''}.csv`, 'text/csv');
  };

  const ntcTotal = epmData?.ntc?.reduce((s, r) => s + (r.years[refSnap] || 0), 0) || 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>

      {/* Chart 1: dual-axis total */}
      <div>
        <SectionTitle t={t}>Total demand forecast</SectionTitle>
        <CJChart type="bar" height={180}
          data={{
            labels: totalByYear.map(d => d.year),
            datasets: [
              { type: 'bar',  label: 'Peak (GW)',    yAxisID: 'yL',
                data: totalByYear.map(d => d['Peak (GW)']),
                backgroundColor: hexA('#1a5fa8', 0.75), borderWidth: 0 },
              { type: 'line', label: 'Energy (TWh)', yAxisID: 'yR',
                data: totalByYear.map(d => d['Energy (TWh)']),
                borderColor: '#FF6B6B', borderWidth: 2.5, pointRadius: 0, tension: 0.3 },
            ],
          }}
          options={{ ...cjDefaults(t),
            scales: {
              x:  { grid: { color: t.panelBorder }, ticks: { color: t.muted, font: { size: 8 }, maxTicksLimit: 7 } },
              yL: { type: 'linear', position: 'left',  title: { display: true, text: 'GW',  color: t.muted, font: { size: 7 } },
                grid: { color: t.panelBorder }, ticks: { color: t.muted, font: { size: 8 } } },
              yR: { type: 'linear', position: 'right', title: { display: true, text: 'TWh', color: t.muted, font: { size: 7 } },
                grid: { drawOnChartArea: false }, ticks: { color: t.muted, font: { size: 8 } } },
            },
          }}
        />
        <div style={{ display: 'flex', gap: 14, justifyContent: 'center', marginTop: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.48rem', color: t.muted }}>
            <div style={{ width: 12, height: 10, backgroundColor: '#1a5fa8', opacity: 0.75, borderRadius: 1 }} />Peak GW (left)
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.48rem', color: t.muted }}>
            <div style={{ width: 18, height: 2.5, backgroundColor: '#FF6B6B', borderRadius: 1 }} />Energy TWh (right)
          </div>
        </div>
      </div>

      {/* Chart 2: demand by zone (horizontal bar, energy TWh + peak MW) */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <SectionTitle t={t}>Demand by zone</SectionTitle>
          <select value={refSnap} onChange={e => setSnapYear(e.target.value)} style={{
            fontSize: '0.5rem', fontFamily: 'inherit', padding: '2px 6px', borderRadius: 4,
            border: `1px solid ${t.panelBorder}`, backgroundColor: t.panel, color: t.lbl, cursor: 'pointer',
          }}>
            {allYears.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          {/* Chart */}
          <div style={{ flex: 1 }}>
            <CJChart type="bar" height={Math.min(allZones.length * 22 + 24, 240)}
              data={{
                labels: byZoneSnap.map(d => d.zone),
                datasets: [
                  { label: 'Energy (TWh)', data: byZoneSnap.map(d => +d.energy.toFixed(2)),
                    backgroundColor: byZoneSnap.map(d => hexA(d.color, 0.75)),
                    borderWidth: 0, barThickness: 12, yAxisID: 'y' },
                ],
              }}
              options={{ ...cjDefaults(t), indexAxis: 'y',
                scales: {
                  x: { grid: { color: t.panelBorder }, ticks: { color: t.muted, font: { size: 8 } },
                    title: { display: true, text: 'TWh', color: t.muted, font: { size: 7 } } },
                  y: { grid: { display: false }, ticks: { color: t.muted, font: { size: 8 } } },
                },
                plugins: { ...cjDefaults(t).plugins,
                  tooltip: { ...cjDefaults(t).plugins.tooltip,
                    callbacks: {
                      label: ctx => {
                        const d = byZoneSnap[ctx.dataIndex];
                        return [`Energy: ${ctx.raw} TWh`, `Peak: ${d.peak.toLocaleString()} MW`];
                      }
                    }
                  }
                },
              }}
            />
          </div>
          {/* Compact zone legend (right) */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 2,
            justifyContent: 'center', minWidth: 90, maxHeight: 240, overflowY: 'auto' }}>
            <div onClick={() => setSelZones(null)}
              style={{ fontSize: '0.44rem', color: !selZones ? t.lbl : t.lblMuted, cursor: 'pointer',
                fontWeight: !selZones ? 700 : 400, paddingBottom: 2, borderBottom: `1px solid ${t.panelBorder}`, marginBottom: 2 }}>
              All zones
            </div>
            {allZones.map((z, i) => {
              const active = !selZones || selZones.includes(z);
              return (
                <div key={z} onClick={() => toggleZone(z)} style={{
                  display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer',
                  fontSize: '0.44rem', color: active ? t.lbl : t.lblMuted, opacity: active ? 1 : 0.45,
                }}>
                  <div style={{ width: 7, height: 7, borderRadius: 1, flexShrink: 0,
                    backgroundColor: ZONE_PALETTE[i % ZONE_PALETTE.length] }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{z}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Chart 3: demand profile */}
      {demandProfile && profZones.length > 0 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <SectionTitle t={t}>Average daily demand profile</SectionTitle>
            <select value={profZoneActive} onChange={e => setProfZone(e.target.value)} style={{
              fontSize: '0.5rem', fontFamily: 'inherit', padding: '2px 6px', borderRadius: 4,
              border: `1px solid ${t.panelBorder}`, backgroundColor: t.panel, color: t.lbl, cursor: 'pointer',
            }}>
              {profZones.map(z => <option key={z} value={z}>{z}</option>)}
            </select>
          </div>
          {profData && (
            <CJChart type="line" height={140}
              data={{
                labels: Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2,'0')}:00`),
                datasets: [{
                  label: profZoneActive,
                  data: profData.map(v => +v.toFixed(3)),
                  borderColor: '#1E9AF5', backgroundColor: hexA('#1E9AF5', 0.12),
                  borderWidth: 2, pointRadius: 0, tension: 0.4, fill: true,
                }],
              }}
              options={{ ...cjDefaults(t),
                scales: {
                  x: { grid: { color: t.panelBorder }, ticks: { color: t.muted, font: { size: 7 },
                    maxTicksLimit: 12 } },
                  y: { grid: { color: t.panelBorder }, ticks: { color: t.muted, font: { size: 8 } },
                    title: { display: true, text: 'Fraction of peak', color: t.muted, font: { size: 7 } },
                    min: 0, max: 1 },
                },
              }}
            />
          )}
        </div>
      )}

      {/* Download */}
      <button onClick={handleDownload} style={{
        fontSize: '0.52rem', fontFamily: 'inherit', padding: '5px 10px', borderRadius: 4,
        border: `1px solid ${t.panelBorder}`, backgroundColor: 'transparent', color: t.muted,
        cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, alignSelf: 'flex-start',
      }}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Download pDemandForecast.csv
      </button>
    </div>
  );
}

// ── Trade / Transmission tab ──────────────────────────────────────────────────

function TradeTab({ t, epmData, epmLoading, hasEpm }) {
  const ntcYears = availableYears(epmData?.ntc || []);
  const [yr, setYr]       = useState(null);
  const [chartType, setChartType] = useState('bar'); // bar | line

  if (!hasEpm)              return <NotAvailable t={t} />;
  if (epmLoading)           return <LoadingBox t={t} />;
  if (!epmData?.ntc?.length) return <NotAvailable t={t} />;

  const refYr = yr || ntcYears.find(y => y === '2024') || ntcYears[0];
  const corridors = epmData.ntc
    .map(r => ({ ...r, label: `${r.z} ↔ ${r.z2}`, mw: r.years[refYr] || 0 }))
    .filter(r => r.mw > 0)
    .sort((a, b) => b.mw - a.mw);

  // NTC evolution chart — top N corridors by max capacity
  const topN = 10;
  const topCorridors = [...epmData.ntc]
    .sort((a, b) => {
      const maxA = Math.max(...Object.values(a.years));
      const maxB = Math.max(...Object.values(b.years));
      return maxB - maxA;
    })
    .slice(0, topN);

  const handleDownload = () => {
    const header = 'z,z2,' + ntcYears.join(',');
    const rows = epmData.ntc.map(r => `${r.z},${r.z2},${ntcYears.map(y => r.years[y] ?? '').join(',')}`);
    downloadBlob([header, ...rows].join('\n'), `pTransferLimit_${epmData.branch || ''}.csv`, 'text/csv');
  };

  const zcmap  = epmData?.zcmap || [];
  const countries = [...new Set(zcmap.map(r => r.c))].sort();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

      {/* NTC Evolution chart */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <SectionTitle t={t}>NTC evolution — top {topN} corridors (MW)</SectionTitle>
          <div style={{ display: 'flex', gap: 3 }}>
            {['bar', 'line'].map(type => (
              <button key={type} onClick={() => setChartType(type)} style={{
                fontSize: '0.44rem', fontFamily: 'inherit', padding: '2px 5px', borderRadius: 3,
                cursor: 'pointer', border: `1px solid ${chartType === type ? t.lbl : t.panelBorder}`,
                backgroundColor: chartType === type ? hexA('#1a5fa8', 0.1) : 'transparent',
                color: chartType === type ? t.lbl : t.lblMuted,
              }}>{type}</button>
            ))}
          </div>
        </div>
        <CJChart type={chartType} height={200}
          data={{
            labels: ntcYears,
            datasets: topCorridors.map((r, i) => ({
              label: `${r.z} ↔ ${r.z2}`,
              data: ntcYears.map(y => r.years[y] || 0),
              backgroundColor: hexA(ZONE_PALETTE[i % ZONE_PALETTE.length], 0.6),
              borderColor: ZONE_PALETTE[i % ZONE_PALETTE.length],
              borderWidth: 2, pointRadius: 0, tension: 0.3,
              fill: false,
              stack: chartType === 'bar' ? 'a' : undefined,
            })),
          }}
          options={{ ...cjDefaults(t),
            scales: {
              x: { stacked: chartType === 'bar', grid: { color: t.panelBorder },
                ticks: { color: t.muted, font: { size: 8 }, maxTicksLimit: 7 } },
              y: { stacked: chartType === 'bar', grid: { color: t.panelBorder },
                ticks: { color: t.muted, font: { size: 8 },
                  callback: v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v } },
            },
            plugins: { ...cjDefaults(t).plugins,
              legend: { display: false },
              tooltip: { ...cjDefaults(t).plugins.tooltip,
                callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.raw.toLocaleString()} MW` } } },
          }}
        />
        {/* Legend */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 8px', marginTop: 4 }}>
          {topCorridors.map((r, i) => (
            <div key={`${r.z}-${r.z2}`} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: '0.44rem', color: t.muted }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: ZONE_PALETTE[i % ZONE_PALETTE.length] }} />
              {r.z} ↔ {r.z2}
            </div>
          ))}
        </div>
      </div>

      {/* NTC by corridor — selected year */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <SectionTitle t={t}>Capacity by corridor (MW)</SectionTitle>
          <select value={refYr} onChange={e => setYr(e.target.value)} style={{
            fontSize: '0.52rem', fontFamily: 'inherit', padding: '2px 6px', borderRadius: 4,
            border: `1px solid ${t.panelBorder}`, backgroundColor: t.panel, color: t.lbl, cursor: 'pointer',
          }}>
            {ntcYears.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <CJChart type="bar" height={Math.min(corridors.length * 22 + 24, 260)}
          data={{
            labels: corridors.map(r => r.label),
            datasets: [{ data: corridors.map(r => r.mw),
              backgroundColor: corridors.map((_, i) => ZONE_PALETTE[i % ZONE_PALETTE.length]),
              borderWidth: 0, barThickness: 12 }],
          }}
          options={{ ...cjDefaults(t), indexAxis: 'y',
            scales: {
              x: { grid: { color: t.panelBorder }, ticks: { color: t.muted, font: { size: 8 },
                callback: v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v } },
              y: { grid: { display: false }, ticks: { color: t.muted, font: { size: 8 } } },
            },
            plugins: { ...cjDefaults(t).plugins,
              tooltip: { ...cjDefaults(t).plugins.tooltip,
                callbacks: { label: ctx => `${ctx.raw.toLocaleString()} MW` } } },
          }}
        />
      </div>

      {/* Zones + countries */}
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

      {/* Download */}
      <button onClick={handleDownload} style={{
        fontSize: '0.52rem', fontFamily: 'inherit', padding: '5px 10px', borderRadius: 4,
        border: `1px solid ${t.panelBorder}`, backgroundColor: 'transparent', color: t.muted,
        cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, alignSelf: 'flex-start',
      }}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Download pTransferLimit.csv
      </button>
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
            <div>Demand profiles: <b style={{ color: t.lbl }}>{epmData.demandProfile ? Object.keys(epmData.demandProfile).length + ' zones' : 'n/a'}</b></div>
          </>
        ) : (
          <div style={{ color: t.lblMuted }}>No EPM data configured for this region.</div>
        )}
      </div>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function RegionPage() {
  const { regionId } = useParams();
  const { theme }    = useTheme();
  const t            = getT(theme);
  const navigate     = useNavigate();

  const containerRef     = useRef(null);
  const mapRef           = useRef(null);
  const donutMarkersRef  = useRef([]);

  const [region,        setRegion]        = useState(null);
  const [capacity,      setCapacity]      = useState(null);
  const [tariffs,       setTariffs]       = useState(null);
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
  const [epmData,         setEpmData]         = useState(null);
  const [epmLoading,      setEpmLoading]      = useState(false);

  // Static data
  useEffect(() => {
    fetch('/data/tariffs.json').then(r => r.json()).then(setTariffs).catch(() => {});
    fetch('/data/access.json').then(r => r.json()).then(setAccess).catch(() => {});
  }, []);

  // Region metadata
  useEffect(() => {
    fetch('/data/regions.json').then(r => r.json()).then(d => {
      const r = (d.regions || []).find(r => r.id === regionId);
      setRegion(r || null);
    });
    setCapacity(null);
    fetch(`/data/cache/region_capacity_${regionId}.json`).then(r => r.json()).then(setCapacity).catch(() => {});
    setFuelsOff(new Set()); setStatusOff(new Set()); setKvsOff(new Set());
    setLinesOn(true); setPlantsOn(true); setSubsOn(false);
    setLoadCentersOn(false); setLcMinPop(300_000); setLcCircleScale(1.0);
    setMinMw(100); setCircleScale(1.0);
    setPlantSource('osm'); setActiveTab('overview');
    setGppdAvailable(null);
    fetch(`/data/cache/region_plants_${regionId}_gppd.geojson`, { method: 'HEAD' })
      .then(r => setGppdAvailable(r.ok)).catch(() => setGppdAvailable(false));
    setGemAvailable(null);
    fetch(`/data/cache/region_plants_${regionId}_gem.geojson`, { method: 'HEAD' })
      .then(r => setGemAvailable(r.ok)).catch(() => setGemAvailable(false));
  }, [regionId]);

  // EPM data — also fetches linestring + demand profile
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
      fetchLinestringGeoJSON(branch, dataFolder),
      fetchEpmCSV(branch, dataFolder, 'load/pDemandProfile.csv'),
      fetchZonesGeoJSON(branch, dataFolder),
    ]).then(([genRaw, demandRaw, ntcRaw, zcmapRaw, linestringGJ, profileRaw, zonesGJ]) => {
      setEpmData({
        gen:           genRaw    ? processGenData(genRaw)       : [],
        demand:        demandRaw ? processDemand(demandRaw)     : [],
        ntc:           ntcRaw    ? processNTC(ntcRaw)           : [],
        zcmap:         zcmapRaw  || [],
        demandProfile: profileRaw ? processDemandProfile(profileRaw) : null,
        linestringGJ,
        zonesGJ,
        branch,
      });
    }).finally(() => setEpmLoading(false));
  }, [region]);

  // Fleet age — GPPD only
  useEffect(() => {
    if (plantSource !== 'gppd') return;
    fetch(`/data/cache/region_age_${regionId}_gppd.json`)
      .then(r => r.ok ? r.json() : null).catch(() => {});
  }, [plantSource, regionId]);

  // ── Map initialisation ────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || !region) return;
    // EPM region: wait for data; skip map if neither linestring nor zones available
    if (region.epm) {
      if (!epmData) return;
      if (!epmData.linestringGJ && !epmData.zonesGJ) return;
    }

    const isos = region.countries.map(c => c.iso);
    const TERRITORY_ALIASES = { SOM: ['SOL'], SDN: ['SDS'] };
    const expandedIsos = isos.flatMap(iso => [iso, ...(TERRITORY_ALIASES[iso] || [])]);
    const isEpm = !!(region.epm && epmData && (epmData.linestringGJ || epmData.zonesGJ));

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
      const countries = await fetch('/data/countries_10m.geojson').then(r => r.json());
      countries.features.forEach((f, i) => {
        const p = f.properties;
        let iso = p.ISO_A3 || '-99';
        if (iso === '-99') iso = p.ISO_A3_EH || '-99';
        if (iso === '-99') iso = p.ADM0_A3 || '-99';
        p.ISO_A3 = iso; f.id = i;
      });

      const bounds = fitBounds(expandedIsos, countries);
      if (bounds) map.fitBounds(bounds, { padding: 40, duration: 0 });

      map.addSource('countries', { type: 'geojson', data: countries, generateId: false });
      const tv = getT(theme);
      map.addLayer({ id: 'land',    type: 'fill', source: 'countries',
        paint: { 'fill-color': tv.land, 'fill-opacity': 1 } });
      map.addLayer({ id: 'borders', type: 'line', source: 'countries',
        paint: { 'line-color': tv.worldBdr, 'line-width': tv.worldBdrW } });

      if (isEpm) {
        // ── EPM map: zone polygons + NTC lines + country donut markers ───────
        const lsgj = epmData.linestringGJ;
        const zonesGJ = epmData.zonesGJ;
        const zcmapRows = epmData.zcmap;  // [{z, c}]
        const zoneToCountry = Object.fromEntries(zcmapRows.map(r => [r.z, r.c]));

        // Unique countries → colors
        const regionCountries = [...new Set(zcmapRows.map(r => r.c))].sort();
        const countryColorMap = {};
        regionCountries.forEach((c, i) => { countryColorMap[c] = ZONE_PALETTE[i % ZONE_PALETTE.length]; });

        // Zone centroids — from polygon centroids when zonesGJ available, else from linestring endpoints
        const zoneCentroids = {};
        if (zonesGJ) {
          for (const f of zonesGJ.features) {
            const z = f.properties.z;
            if (z) { const c = computeCentroid(f.geometry); if (c) zoneCentroids[z] = c; }
          }
        } else if (lsgj) {
          for (const f of lsgj.features) {
            const coords = f.geometry.coordinates;
            const z = f.properties.z;
            const z2 = f.properties.z_other;
            if (z && !zoneCentroids[z]) zoneCentroids[z] = coords[0];
            if (z2 && !zoneCentroids[z2]) zoneCentroids[z2] = coords[coords.length - 1];
          }
        }

        // Country centroids = average of zone centroids per country
        const countryCentroids = {};
        for (const { z, c } of zcmapRows) {
          const coord = zoneCentroids[z];
          if (!coord) continue;
          if (!countryCentroids[c]) countryCentroids[c] = { sum: [0, 0], n: 0 };
          countryCentroids[c].sum[0] += coord[0];
          countryCentroids[c].sum[1] += coord[1];
          countryCentroids[c].n++;
        }
        for (const c of Object.keys(countryCentroids)) {
          const d = countryCentroids[c];
          countryCentroids[c] = [d.sum[0] / d.n, d.sum[1] / d.n];
        }

        // Zone polygon fill layer using zones.geojson
        if (zonesGJ) {
          const isoToCountry = {};
          for (const f of zonesGJ.features) isoToCountry[f.properties.ISO_A3] = f.properties.c;
          const uniqueIsos = [...new Set(zonesGJ.features.map(f => f.properties.ISO_A3))];
          const fillExpr = ['match', ['get', 'ISO_A3'],
            ...uniqueIsos.flatMap(iso => [iso, countryColorMap[isoToCountry[iso]] || '#888']),
            'transparent',
          ];
          map.addSource('zones', { type: 'geojson', data: zonesGJ, generateId: true });
          map.addLayer({ id: 'zone-fill', type: 'fill', source: 'zones',
            paint: { 'fill-color': fillExpr, 'fill-opacity': 0.25 } });
          map.addLayer({ id: 'zone-hover', type: 'fill', source: 'zones',
            filter: ['==', ['get', 'ISO_A3'], ''],
            paint: { 'fill-color': fillExpr, 'fill-opacity': 0.55 } });
          map.addLayer({ id: 'zone-border', type: 'line', source: 'zones',
            paint: { 'line-color': fillExpr, 'line-width': 1.2, 'line-opacity': 0.75 } });

          let hovIso = null;
          map.on('mousemove', 'zone-fill', e => {
            map.getCanvas().style.cursor = 'pointer';
            const iso = e.features[0].properties.ISO_A3;
            const c = isoToCountry[iso] || iso;
            if (iso !== hovIso) { hovIso = iso; map.setFilter('zone-hover', ['==', ['get', 'ISO_A3'], iso]); }
            popup.setLngLat(e.lngLat).setHTML(`<b>${c}</b><br><span style="opacity:.65;font-size:0.7em">click to explore</span>`).addTo(map);
          });
          map.on('mouseleave', 'zone-fill', () => {
            map.getCanvas().style.cursor = '';
            hovIso = null; map.setFilter('zone-hover', ['==', ['get', 'ISO_A3'], '']); popup.remove();
          });
          map.on('click', 'zone-fill', e => {
            const iso = e.features[0].properties.ISO_A3;
            const c = isoToCountry[iso] || iso;
            navigate(`/region/${regionId}/country/${encodeURIComponent(c)}`);
          });
        } else if (lsgj) {
          // Fallback: country fill from world source (no zones.geojson)
          const isoColorPairs = [];
          for (const { z, c } of zcmapRows) {
            const f = lsgj.features.find(ft => ft.properties.z === z);
            const iso = f?.properties.ISO_A3;
            if (iso && iso !== '-99') isoColorPairs.push([iso, countryColorMap[c] || '#888']);
          }
          const fbIsos = [...new Set(isoColorPairs.map(([iso]) => iso))];
          const fbExpr = ['match', ['get', 'ISO_A3'], ...isoColorPairs.flat(), 'transparent'];
          map.addLayer({ id: 'zone-fill', type: 'fill', source: 'countries',
            filter: ['in', ['get', 'ISO_A3'], ['literal', fbIsos]],
            paint: { 'fill-color': fbExpr, 'fill-opacity': 0.28 } });
          map.addLayer({ id: 'zone-border', type: 'line', source: 'countries',
            filter: ['in', ['get', 'ISO_A3'], ['literal', fbIsos]],
            paint: { 'line-color': fbExpr, 'line-width': 1.2, 'line-opacity': 0.75 } });
        }

        // NTC transmission lines
        {
          const ntcYrs = availableYears(epmData.ntc);
          const ntcYr  = ntcYrs[0] || '2024';
          const seenPairs = new Set();
          let ntcFeatures = [];

          if (Object.keys(zoneCentroids).length > 0) {
            // Build NTC lines from computed zone centroids + pTransferLimit data
            ntcFeatures = epmData.ntc
              .filter(r => {
                const key = [r.z, r.z2].sort().join('||');
                if (seenPairs.has(key)) return false;
                seenPairs.add(key);
                return (r.years[ntcYr] || 0) > 0 && zoneCentroids[r.z] && zoneCentroids[r.z2];
              })
              .map(r => ({
                type: 'Feature',
                properties: { z: r.z, z_other: r.z2, ntc_mw: r.years[ntcYr] || 0 },
                geometry: { type: 'LineString', coordinates: [zoneCentroids[r.z], zoneCentroids[r.z2]] },
              }));
          } else if (lsgj) {
            // Fallback: original linestring-based NTC (for regions without zonesGJ)
            ntcFeatures = lsgj.features
              .filter(f => {
                const { z, z_other } = f.properties;
                if (!z || !z_other) return false;
                const key = [z, z_other].sort().join('||');
                if (seenPairs.has(key)) return false;
                seenPairs.add(key);
                const entry = epmData.ntc.find(r =>
                  (r.z === z && r.z2 === z_other) || (r.z === z_other && r.z2 === z));
                return (entry?.years[ntcYr] || 0) > 0;
              })
              .map(f => {
                const { z, z_other } = f.properties;
                const entry = epmData.ntc.find(r =>
                  (r.z === z && r.z2 === z_other) || (r.z === z_other && r.z2 === z));
                return { ...f, properties: { ...f.properties, ntc_mw: entry?.years[ntcYr] || 0 } };
              });
          }

          if (ntcFeatures.length > 0) {
            map.addSource('ntc-lines', { type: 'geojson',
              data: { type: 'FeatureCollection', features: ntcFeatures } });
            map.addLayer({ id: 'ntc-lines-layer', type: 'line', source: 'ntc-lines',
              layout: { 'line-cap': 'round', 'line-join': 'round' },
              paint: { 'line-color': '#f0b030',
                'line-width': ['interpolate', ['linear'], ['get', 'ntc_mw'], 0, 1, 500, 2, 2000, 3.5, 8000, 6],
                'line-opacity': 0.88 } });
            map.addLayer({ id: 'ntc-labels', type: 'symbol', source: 'ntc-lines',
              layout: { 'text-field': ['concat', ['to-string', ['round', ['get', 'ntc_mw']]], ' MW'],
                'text-size': 8, 'symbol-placement': 'line-center', 'text-allow-overlap': false },
              paint: { 'text-color': '#b07800',
                'text-halo-color': 'rgba(255,255,255,0.9)', 'text-halo-width': 1.5 } });
          }
        }

        // Country donut markers (one per country, aggregates all zones)
        const countryGen = {};
        for (const r of epmData.gen.filter(g => g.status === 1)) {
          const c = zoneToCountry[r.zone] || r.zone;
          if (!countryGen[c]) countryGen[c] = {};
          countryGen[c][r.fuel] = (countryGen[c][r.fuel] || 0) + r.capacity;
        }
        donutMarkersRef.current.forEach(m => m.remove());
        donutMarkersRef.current = [];
        for (const [c, fuelMix] of Object.entries(countryGen)) {
          const coord = countryCentroids[c];
          if (!coord) continue;
          const el = document.createElement('div');
          el.style.cursor = 'pointer';
          el.innerHTML = makeDonutSVG(fuelMix, tv);
          el.addEventListener('click', () => navigate(`/region/${regionId}/country/${encodeURIComponent(c)}`));
          const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
            .setLngLat(coord).addTo(map);
          donutMarkersRef.current.push(marker);
        }

      } else {
        // ── OSM map ──────────────────────────────────────────────────────────
        const [plantsGJ, linesGJ, subsGJ, lcGJ] = await Promise.all([
          fetch(`/data/cache/region_plants_${regionId}.geojson`).then(r => r.json()),
          fetch(`/data/cache/region_lines_${regionId}.geojson`).then(r => r.json()),
          fetch(`/data/cache/region_substations_${regionId}.geojson`)
            .then(r => r.json()).catch(() => ({ type: 'FeatureCollection', features: [] })),
          fetch(`/data/region_load_centers_${regionId}.geojson`)
            .then(r => r.json()).catch(() => ({ type: 'FeatureCollection', features: [] })),
        ]);

        map.addSource('plants',       { type: 'geojson', data: plantsGJ });
        map.addSource('lines',        { type: 'geojson', data: linesGJ  });
        map.addSource('substations',  { type: 'geojson', data: subsGJ   });
        map.addSource('load-centers', { type: 'geojson', data: lcGJ     });

        const tv = getT(theme);
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

        const hl = tv.highlight;
        map.addLayer({ id: 'region-fill', type: 'fill', source: 'countries',
          filter: ['in', ['get', 'ISO_A3'], ['literal', expandedIsos]],
          paint: { 'fill-color': hl.fill,
            'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.18, 0.08] } });
        map.addLayer({ id: 'region-border', type: 'line', source: 'countries',
          filter: ['in', ['get', 'ISO_A3'], ['literal', expandedIsos]],
          paint: { 'line-color': hl.border, 'line-width': hl.borderW, 'line-opacity': 0.9 } });

        const fuels = new Set();
        for (const f of plantsGJ.features) {
          const fuel = f.properties.fuel;
          if (fuel && FUEL_COLORS[fuel]) fuels.add(fuel);
        }
        setPresentFuels(fuels);
        const colorExpr = fuelColorExpr();

        map.addLayer({ id: 'plants-operating', type: 'circle', source: 'plants',
          filter: makeLayerFilter('operating', new Set(), 100),
          paint: { 'circle-radius': plantRadiusExpr(), 'circle-color': colorExpr,
            'circle-opacity': 0.88, 'circle-stroke-width': 0.6, 'circle-stroke-color': 'rgba(0,0,0,0.3)' } });
        map.addLayer({ id: 'plants-construction', type: 'circle', source: 'plants',
          filter: makeLayerFilter('construction', new Set(), 100),
          paint: { 'circle-radius': plantRadiusExpr(), 'circle-color': 'rgba(0,0,0,0)',
            'circle-opacity': 1, 'circle-stroke-width': 2, 'circle-stroke-color': colorExpr,
            'circle-stroke-opacity': 0.9 } });
        map.addLayer({ id: 'plants-planned', type: 'circle', source: 'plants',
          filter: makeLayerFilter('planned', new Set(), 100),
          paint: { 'circle-radius': plantRadiusExpr(), 'circle-color': colorExpr,
            'circle-opacity': 0.22, 'circle-stroke-width': 1, 'circle-stroke-color': colorExpr,
            'circle-stroke-opacity': 0.45 } });

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

        map.addLayer({ id: 'load-centers', type: 'circle', source: 'load-centers',
          filter: ['>=', ['get', 'pop'], 300_000], layout: { visibility: 'none' },
          paint: { 'circle-radius': lcRadiusExpr(), 'circle-color': '#1a237e', 'circle-opacity': 0.72,
            'circle-stroke-width': 1.2, 'circle-stroke-color': 'rgba(255,255,255,0.65)' } });
        map.addLayer({ id: 'load-centers-labels', type: 'symbol', source: 'load-centers',
          filter: ['>=', ['get', 'pop'], 300_000], layout: { visibility: 'none',
            'text-field': ['get', 'name'], 'text-size': 9, 'text-offset': [0, 1.3], 'text-anchor': 'top' },
          paint: { 'text-color': '#1a237e', 'text-halo-color': 'rgba(255,255,255,0.88)', 'text-halo-width': 1.5 } });

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
      }
    });

    return () => {
      popup.remove();
      donutMarkersRef.current.forEach(m => m.remove());
      donutMarkersRef.current = [];
      mapRef.current?.remove();
    };
  }, [region, theme, epmData?.linestringGJ, epmData?.zonesGJ]); // eslint-disable-line react-hooks/exhaustive-deps

  // Basemap switcher
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

  // Plant source hot-swap (OSM mode only)
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

  // ── Render ────────────────────────────────────────────────────────────────

  if (!region) return <div style={{ padding: 40, color: t.text }}>Loading…</div>;

  const isEpmMode = !!(region.epm && epmData && (epmData.linestringGJ || epmData.zonesGJ));
  const showMap   = !region.epm || isEpmMode;

  const panelWidth = 560;

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 46px)' }}>

      {/* Map */}
      {showMap && (
        <div style={{ position: 'relative', flex: 1 }}>
          <div ref={containerRef}
            style={{ width: '100%', height: 'calc(100vh - 46px)', backgroundColor: t.bg }} />

          {/* Basemap controls */}
          <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 10, display: 'flex', gap: 4, alignItems: 'center' }}>
            {[{ id: 'minimal', label: 'Map' }, { id: 'labeled', label: 'Labels' }, { id: 'satellite', label: 'Sat' }]
              .map(({ id, label }) => {
                const active = (basemap || 'minimal') === id;
                return (
                  <button key={id} onClick={() => setBasemap(id)} style={{
                    fontSize: '0.52rem', letterSpacing: '0.5px', fontFamily: 'inherit',
                    padding: '4px 8px', borderRadius: 5, cursor: 'pointer',
                    border: `1px solid ${active ? 'rgba(74,143,204,0.6)' : t.panelBorder}`,
                    backgroundColor: active ? 'rgba(74,143,204,0.14)' : t.panel,
                    color: active ? t.lbl : t.lblMuted,
                    boxShadow: '0 1px 4px rgba(0,0,0,.18)', transition: 'all 0.15s',
                  }}>{label}</button>
                );
              })}
          </div>

          {/* EPM map badge */}
          {isEpmMode && (
            <div style={{ position: 'absolute', bottom: 10, left: 10, zIndex: 10,
              fontSize: '0.46rem', color: t.lblMuted, backgroundColor: t.panel,
              border: `1px solid ${t.panelBorder}`, borderRadius: 4, padding: '3px 7px' }}>
              EPM zones + NTC · {epmData.ntc.length} corridors
            </div>
          )}
        </div>
      )}

      {/* Right panel */}
      <div style={{
        width: showMap ? panelWidth : '100%',
        maxWidth: showMap ? panelWidth : 800,
        margin: showMap ? 0 : '0 auto',
        height: 'calc(100vh - 46px)', overflowY: 'auto',
        padding: '18px 16px',
        backgroundColor: t.panel, borderLeft: showMap ? `1px solid ${t.panelBorder}` : 'none',
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
          {['Overview', 'Supply', 'Demand', 'Trade', 'About'].map(tab => {
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

        {/* Tab content */}
        {activeTab === 'overview' && (
          !region.epm  ? <NotAvailable t={t} /> :
          epmLoading   ? <LoadingBox t={t} /> :
          epmData      ? <EpmOverviewTab t={t} epmData={epmData} region={region} /> :
                         <NotAvailable t={t} />
        )}
        {activeTab === 'supply' && (
          !region.epm  ? <NotAvailable t={t} /> :
          epmLoading   ? <LoadingBox t={t} /> :
          epmData      ? <EpmSupplyTab t={t} epmData={epmData} region={region} /> :
                         <NotAvailable t={t} />
        )}
        {activeTab === 'demand' && (
          <DemandTab t={t} epmData={epmData} epmLoading={epmLoading} hasEpm={!!region.epm} />
        )}
        {activeTab === 'trade' && (
          <TradeTab t={t} epmData={epmData} epmLoading={epmLoading} hasEpm={!!region.epm} />
        )}
        {activeTab === 'about' && (
          <AboutTab region={region} t={t} epmData={epmData} />
        )}
      </div>
    </div>
  );
}
