import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import { track } from '../analytics';
import { useTheme } from '../App';
import {
  getT, mapStyle, swapBasemap, toggleSatLabels, FUEL_COLORS, VOLTAGE_BRACKETS,
  plantRadiusExpr, lcRadiusExpr, fuelColorExpr, PLANT_STATUSES, zoneColorExpr,
} from '../constants';
import CapacityChart from '../components/CapacityChart';
import StatsPanel from '../components/StatsPanel';
import {
  fetchEpmCSV, fetchLinestringGeoJSON, fetchZonesGeoJSON, fetchZonesExtGeoJSON,
  processGenData, processDemand,
  processNTC, processExtNTC, processDemandProfileFull, processVREProfile, processAvailability, processFuelPrice, processHours,
  availableYears, EPM_FUEL_COLORS, STATUS_LABEL,
  computeCentroid, normalizeFuel,
} from '../utils/epmFetch';
import { fetchScenarioConfig } from '../utils/epmScenarios';
import VariantPicker from '../components/VariantPicker';
import ScenarioTab from '../components/ScenarioTab';

// chart.js via CDN — no npm dep
function CJChart({ type, data, options, height, plugins: extraPlugins, cacheKey }) {
  const canvasRef = useRef(null);
  const chartRef  = useRef(null);
  const sig = JSON.stringify({ type, labels: data.labels, ck: cacheKey,
    ds: data.datasets?.map(d => ({ l: d.label, n: d.data?.length, t: d.type, f: d.fill })) });
  useEffect(() => {
    const CJ = window.Chart;
    if (!CJ || !canvasRef.current) return;
    chartRef.current?.destroy();
    chartRef.current = new CJ(canvasRef.current, { type, data, options, plugins: extraPlugins || [] });
    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div style={{ height, width: '100%', position: 'relative' }}>
      <canvas ref={canvasRef} />
    </div>
  );
}

// Map zone fills — blues/teals/gold only
const MAP_PALETTE = [
  '#1B6CA8','#36B5B5','#E8C547','#4DA6FF',
  '#0D7680','#85C1E9','#2E9EC8','#5EBCBA',
  '#1A5276','#7EC8E3','#14A094','#4CAFE8',
  '#EDD770','#AED6F1','#1F618D','#0A6B70',
];
// Chart colors — same tasteful palette as map (blues/teals/gold, no neon)
const CHART_PALETTE = [
  '#1B6CA8','#36B5B5','#E8C547','#4DA6FF',
  '#4169E1','#85C1E9','#2E9EC8','#5EBCBA',
  '#1A5276','#7EC8E3','#14A094','#4CAFE8',
  '#EDD770','#AED6F1','#1F618D','#0A6B70',
];
const ZONE_PALETTE = CHART_PALETTE; // legacy alias for chart code

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

function genForYear(genRows, year) {
  if (!year) return genRows.filter(g => g.status === 1);
  const yr = parseInt(year);
  return genRows.filter(g => {
    if (g.status === 1) return !g.retrYr || g.retrYr > yr;
    if (g.status === 2) return g.stYr && g.stYr <= yr && (!g.retrYr || g.retrYr > yr);
    return false;
  });
}

function makeDonutSVG(fuelMix, tv, size = 54) {
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
    <text x="${cx}" y="${cy - 1}" text-anchor="middle" font-size="7" font-weight="700" fill="${tc}" font-family="system-ui,sans-serif">${label}</text>
    <text x="${cx}" y="${cy + 7.5}" text-anchor="middle" font-size="5.5" fill="${tc}" font-family="system-ui,sans-serif" opacity="0.65">${unit}</text>
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

const RE_FUELS_SET = new Set(['hydro','solar','wind','biomass','geothermal','biogas','waste']);

function EpmOverviewTab({ t, epmData, region, epmYear, setEpmYear }) {
  const [mixView, setMixView] = useState('country');
  const { gen, demand, ntc, zcmap } = epmData;
  const allYears = availableYears(demand);
  const refYr    = epmYear || allYears.find(y => y === '2024') || allYears[0];

  const existing   = genForYear(gen, epmYear);
  const totalGW    = existing.reduce((s, r) => s + r.capacity, 0) / 1000;
  const reMW       = existing.filter(r => RE_FUELS_SET.has(r.fuel)).reduce((s, r) => s + r.capacity, 0);
  const reShare    = totalGW > 0 ? Math.round(reMW / (totalGW * 1000) * 100) : 0;
  const peakGW     = demand.filter(r => r.type === 'peak').reduce((s, r) => s + (r.years[refYr] || 0), 0) / 1000;
  const energyTWh  = demand.filter(r => r.type === 'energy').reduce((s, r) => s + (r.years[refYr] || 0), 0) / 1000;

  // Deduplicated corridors
  const seenNTC = new Set();
  const uniqueNTC = ntc.filter(r => { const k = [r.z,r.z2].sort().join('||'); if (seenNTC.has(k)) return false; seenNTC.add(k); return true; });
  const txGW = uniqueNTC.reduce((s, r) => s + (r.years[refYr] || 0), 0) / 1000;

  const nZones     = zcmap.length;
  const nCountries = region.countries.length;

  // Fuel mix for donut
  const fuelAgg = {};
  for (const r of existing) fuelAgg[r.fuel] = (fuelAgg[r.fuel] || 0) + r.capacity;
  const fuelData = Object.entries(fuelAgg).map(([fuel, mw]) => ({ fuel, mw: Math.round(mw) })).sort((a, b) => b.mw - a.mw);

  // Mix by country / zone
  const zoneToCountry = Object.fromEntries(zcmap.map(r => [r.z, r.c]));
  const countryMix = {}, zoneMix = {};
  for (const r of existing) {
    const c = zoneToCountry[r.zone] || r.zone;
    if (!countryMix[c]) countryMix[c] = {};
    countryMix[c][r.fuel] = (countryMix[c][r.fuel] || 0) + r.capacity;
    if (!zoneMix[r.zone]) zoneMix[r.zone] = {};
    zoneMix[r.zone][r.fuel] = (zoneMix[r.zone][r.fuel] || 0) + r.capacity;
  }
  const mixData   = mixView === 'country' ? countryMix : zoneMix;
  const mixLabels = Object.entries(mixData)
    .sort((a, b) => Object.values(b[1]).reduce((s,v)=>s+v,0) - Object.values(a[1]).reduce((s,v)=>s+v,0))
    .map(([l]) => l);
  const allFuels = [...new Set(fuelData.map(d => d.fuel))];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Donut + KPI rows */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div style={{ flexShrink: 0, width: 100, textAlign: 'center' }}>
          <CJChart type="doughnut" height={100}
            data={{ labels: fuelData.map(d => d.fuel), datasets: [{ data: fuelData.map(d => d.mw),
              backgroundColor: fuelData.map(d => EPM_FUEL_COLORS[d.fuel] || '#aaa'),
              borderWidth: 1.5, borderColor: t.panel, hoverOffset: 3 }] }}
            options={{ cutout: '60%', responsive: true, maintainAspectRatio: false, layout: { padding: 3 },
              plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${c.label}: ${c.parsed.toLocaleString()} MW` } } } }}
          />
          <div style={{ fontSize: '0.4rem', color: t.lblMuted, marginTop: 2 }}>Existing mix</div>
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            <span style={{ fontSize: '0.42rem', color: t.lblMuted, flexShrink: 0 }}>Year</span>
            <select value={epmYear || ''} onChange={e => setEpmYear(e.target.value || null)}
              style={{ fontSize: '0.48rem', padding: '2px 4px', borderRadius: 4,
                border: `1px solid ${t.panelBorder}`, background: t.panel, color: t.lbl, cursor: 'pointer' }}>
              {allYears.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 5 }}>
            {[
              { l: `Peak ${refYr||''}`, v: `${peakGW.toFixed(1)} GW` },
              { l: `Energy ${refYr||''}`, v: `${energyTWh.toFixed(0)} TWh` },
              { l: 'Installed', v: `${totalGW.toFixed(1)} GW` },
              { l: 'RE Share', v: `${reShare}%` },
            ].map(({ l, v }) => (
              <div key={l} style={{ border: `1px solid ${t.panelBorder}`, borderRadius: 5, padding: '6px 8px' }}>
                <div style={{ fontSize: '0.4rem', color: t.lblMuted, marginBottom: 2 }}>{l}</div>
                <div style={{ fontSize: '0.72rem', fontWeight: 700, color: t.lbl }}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 5 }}>
            {[
              { l: 'Countries', v: nCountries },
              { l: 'Zones', v: nZones },
              { l: 'Gen. units', v: gen.length },
              { l: 'TX Cap.', v: `${txGW.toFixed(1)} GW` },
              { l: 'Corridors', v: uniqueNTC.length },
            ].map(({ l, v }) => (
              <div key={l} style={{ border: `1px solid ${t.panelBorder}`, borderRadius: 5, padding: '5px 8px' }}>
                <div style={{ fontSize: '0.39rem', color: t.lblMuted, marginBottom: 1 }}>{l}</div>
                <div style={{ fontSize: '0.6rem', fontWeight: 700, color: t.lbl }}>{v}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Mix chart — country/zone toggle — FIRST */}
      {mixLabels.length > 0 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <SectionTitle t={t}>Capacity mix (MW)</SectionTitle>
            <div style={{ display: 'flex', gap: 3 }}>
              {[['country','Countries'],['zone','Zones']].map(([v, l]) => (
                <button key={v} onClick={() => setMixView(v)} style={{
                  fontSize: '0.44rem', fontFamily: 'inherit', padding: '2px 7px', borderRadius: 3, cursor: 'pointer',
                  border: `1px solid ${mixView===v ? 'rgba(74,143,204,0.65)' : t.panelBorder}`,
                  backgroundColor: mixView===v ? 'rgba(74,143,204,0.12)' : 'transparent',
                  color: mixView===v ? t.lbl : t.lblMuted, fontWeight: mixView===v ? 600 : 400,
                }}>{l}</button>
              ))}
            </div>
          </div>
          <div style={{ display:'flex', gap:6, alignItems:'flex-start' }}>
            <div style={{ flex:1, minWidth:0 }}>
              <CJChart type="bar" height={Math.min(mixLabels.length * 22 + 24, 280)}
                data={{
                  labels: mixLabels,
                  datasets: allFuels.map(fuel => ({
                    label: fuel,
                    data: mixLabels.map(l => Math.round(mixData[l]?.[fuel] || 0)),
                    backgroundColor: EPM_FUEL_COLORS[fuel] || EPM_FUEL_COLORS.other,
                    borderWidth: 0, barThickness: 14, stack: 'a',
                  })),
                }}
                options={{ ...cjDefaults(t), indexAxis: 'y',
                  scales: {
                    x: { stacked: true, grid: { color: t.panelBorder }, ticks: { color: t.muted, font: { size: 8 }, callback: v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v } },
                    y: { stacked: true, grid: { display: false }, ticks: { color: t.muted, font: { size: 8 } } },
                  },
                  plugins: { ...cjDefaults(t).plugins, legend: { display: false },
                    tooltip: { ...cjDefaults(t).plugins.tooltip, callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.raw.toLocaleString()} MW` } } },
                }}
              />
            </div>
            <div style={{ width:90, flexShrink:0, display:'flex', flexDirection:'column', gap:2, paddingTop:4, maxHeight:280, overflowY:'auto' }}>
              {allFuels.map(f => (
                <div key={f} style={{ display:'flex', alignItems:'center', gap:3 }}>
                  <div style={{ width:8, height:8, borderRadius:2, backgroundColor:EPM_FUEL_COLORS[f]||'#aaa', flexShrink:0 }}/>
                  <span style={{ fontSize:'0.4rem', color:t.muted, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{f}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {region.epm && (
        <a href={`https://github.com/ESMAP-World-Bank-Group/EPM/tree/${region.epm.branch}`}
          target="_blank" rel="noreferrer"
          style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.52rem', color: t.lblMuted, textDecoration: 'none', marginTop: 2 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
          View on GitHub · {region.epm.branch}
        </a>
      )}
    </div>
  );
}

// ── Supply tab ────────────────────────────────────────────────────────────────
function SupPill({ active, color, onClick, children }) {
  return (
    <button onClick={onClick} style={{ fontSize:'0.44rem', fontFamily:'inherit', padding:'2px 8px', borderRadius:3, cursor:'pointer',
      border:`1px solid ${active?(color||'rgba(74,143,204,0.65)'):'rgba(128,160,192,0.2)'}`,
      backgroundColor:active?hexA(color||'#4a8fcc',0.12):'transparent',
      color:active?(color||'rgba(74,143,204,1)'):'rgba(128,160,192,0.7)', fontWeight:active?600:400, display:'flex', alignItems:'center', gap:4 }}>
      {children}
    </button>
  );
}

function EpmSupplyTab({ t, epmData, region, scnMeta, varOverrides, setVariant }) {
  const { gen, zcmap } = epmData;
  const [visStatuses, setVisStatuses] = useState(new Set([1]));
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
    if (sortCol === 'name')     return a.g.localeCompare(b.g);
    if (sortCol === 'fuel')     return a.fuel.localeCompare(b.fuel);
    if (sortCol === 'zone')     return a.zone.localeCompare(b.zone);
    if (sortCol === 'country')  return (zoneToCountry[a.zone]||'').localeCompare(zoneToCountry[b.zone]||'');
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
      <VariantPicker t={t} scnMeta={scnMeta} param="pGenDataInput" value={varOverrides?.pGenDataInput} onChange={setVariant} />
      {/* Status toggles */}
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        {statusConfig.map(({ s, label, color }) => (
          <SupPill key={s} active={visStatuses.has(s)} color={color} onClick={() => toggleStatus(s)}>
            <span style={{ display:'inline-block', width:6, height:6, borderRadius:'50%', backgroundColor:color }}/>
            {label}
          </SupPill>
        ))}
      </div>

      {/* Chart by fuel */}
      <div>
        <SectionTitle t={t}>Capacity by fuel (MW)</SectionTitle>
        <div style={{ display:'flex', gap:6, alignItems:'flex-start' }}>
          <div style={{ flex:1, minWidth:0 }}>
            <CJChart type="bar" height={Math.min(fuelChartData.length * 22 + 24, 260)}
              data={{ labels: fuelChartData.map(d => d.fuel), datasets: [
                { label:'Existing',  data:fuelChartData.map(d=>d.ex), backgroundColor:fuelChartData.map(d=>EPM_FUEL_COLORS[d.fuel]||EPM_FUEL_COLORS.other), borderWidth:0, barThickness:12, stack:'a' },
                { label:'Committed', data:fuelChartData.map(d=>d.co), backgroundColor:fuelChartData.map(d=>hexA(EPM_FUEL_COLORS[d.fuel]||EPM_FUEL_COLORS.other,0.5)), borderWidth:0, barThickness:12, stack:'a' },
                { label:'Candidate', data:fuelChartData.map(d=>d.ca), backgroundColor:fuelChartData.map(d=>hexA(EPM_FUEL_COLORS[d.fuel]||EPM_FUEL_COLORS.other,0.22)), borderWidth:0, barThickness:12, stack:'a' },
              ]}}
              options={{ ...cjDefaults(t), indexAxis:'y', scales: {
                x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}},
                y:{stacked:true,grid:{display:false},ticks:{color:t.muted,font:{size:8}}},
              }}}
            />
          </div>
          <div style={{ width:90, flexShrink:0, display:'flex', flexDirection:'column', gap:3, paddingTop:4 }}>
            {[['Existing',1.0,'#1a5fa8'],['Committed',0.5,'#e07b00'],['Candidate',0.22,'#888']].map(([lbl,op,c])=>(
              <div key={lbl} style={{ display:'flex', alignItems:'center', gap:3 }}>
                <div style={{ width:8, height:8, borderRadius:2, backgroundColor:c, opacity:op, flexShrink:0 }}/>
                <span style={{ fontSize:'0.4rem', color:t.muted }}>{lbl}</span>
              </div>
            ))}
          </div>
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
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
          <SectionTitle t={t}>Plant database ({sorted.length})</SectionTitle>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search…"
            style={{ fontSize:'0.44rem', fontFamily:'inherit', padding:'2px 6px', borderRadius:3,
              border:`1px solid ${t.panelBorder}`, backgroundColor:t.panel, color:t.lbl, width:90, outline:'none' }}/>
        </div>
        <div style={{ border:`1px solid ${t.panelBorder}`, borderRadius:6, overflow:'hidden' }}>
          {/* Header */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 52px 52px 48px 52px',
            padding:'4px 8px', backgroundColor:hexA(t.panelBorder,0.4), borderBottom:`1px solid ${t.panelBorder}`, position:'sticky', top:0 }}>
            {[['name','Name'],['zone','Zone'],['country','Country'],['fuel','Fuel'],['capacity','MW']].map(([col,lbl])=>(
              <span key={col} onClick={()=>setSortCol(col)} style={{ fontSize:'0.41rem', color:sortCol===col?t.lbl:t.lblMuted, fontWeight:sortCol===col?700:400, cursor:'pointer', textAlign:col==='capacity'?'right':'left', userSelect:'none' }}>
                {lbl}{sortCol===col?' ↓':''}
              </span>
            ))}
          </div>
          {/* Rows */}
          <div style={{ maxHeight:360, overflowY:'auto' }}>
            {sorted.slice(0,300).map(r=>{
              const key=`${r.g}-${r.zone}-${r.status}`;
              const isSel=selectedPlant?.g===r.g&&selectedPlant?.zone===r.zone;
              const sc=statusConfig.find(s=>s.s===r.status);
              return (
                <div key={key}>
                  <div onClick={()=>setSelectedPlant(isSel?null:r)}
                    onMouseEnter={e=>{if(!isSel)e.currentTarget.style.backgroundColor=hexA('#1a5fa8',0.04);}}
                    onMouseLeave={e=>{if(!isSel)e.currentTarget.style.backgroundColor='transparent';}}
                    style={{ display:'grid', gridTemplateColumns:'1fr 52px 52px 48px 52px',
                      padding:'5px 8px', borderBottom:`1px solid ${t.panelBorder}`, cursor:'pointer',
                      fontSize:'0.5rem', alignItems:'center', backgroundColor:isSel?hexA('#1a5fa8',0.08):'transparent' }}>
                    <span style={{ color:t.lbl, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.g}</span>
                    <span style={{ color:t.muted, fontSize:'0.43rem' }}>{r.zone}</span>
                    <span style={{ color:t.muted, fontSize:'0.43rem', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{zoneToCountry[r.zone]||'—'}</span>
                    <span style={{ display:'flex', alignItems:'center', gap:3 }}>
                      <span style={{ display:'inline-block', width:7, height:7, borderRadius:1, backgroundColor:EPM_FUEL_COLORS[r.fuel]||'#aaa' }}/>
                      <span style={{ color:t.muted, fontSize:'0.43rem' }}>{r.fuel}</span>
                    </span>
                    <span style={{ display:'flex', alignItems:'center', gap:3, justifyContent:'flex-end' }}>
                      <span style={{ display:'inline-block', width:6, height:6, borderRadius:'50%', backgroundColor:sc?.color||'#aaa' }}/>
                      <span style={{ color:t.lbl, fontWeight:600 }}>{fmt(r.capacity)}</span>
                    </span>
                  </div>
                  {isSel&&(
                    <div style={{ padding:'8px 12px', backgroundColor:hexA('#1a5fa8',0.05), borderBottom:`1px solid ${t.panelBorder}`, fontSize:'0.5rem' }}>
                      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:'6px 10px' }}>
                        {[
                          {l:'Technology',v:r.tech||'—'},{l:'Status',v:sc?.label||'—'},
                          {l:'Start year',v:r.stYr||'—'},{l:'Retire year',v:r.retrYr||'—'},
                          {l:'Capex ($/kW)',v:r.capex>0?fmt(r.capex):'—'},{l:'FOM ($/MW/yr)',v:r.fom>0?fmt(r.fom):'—'},
                          {l:'VOM ($/MWh)',v:r.vom>0?r.vom.toFixed(2):'—'},{l:'Heat rate',v:r.heatRate?r.heatRate.toFixed(2):'—'},
                        ].map(({l,v})=>(
                          <div key={l}>
                            <div style={{ fontSize:'0.39rem', color:t.lblMuted, marginBottom:1 }}>{l}</div>
                            <div style={{ color:t.lbl, fontWeight:600 }}>{v}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {sorted.length > 300 && (
          <div style={{ fontSize:'0.44rem', color:t.lblMuted, marginTop:3 }}>
            Showing 300 of {sorted.length} — use search to filter
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

const SEASON_LABEL = { Q1: 'Winter', Q2: 'Spring', Q3: 'Summer', Q4: 'Autumn' };

function DemandTab({ t, epmData, epmLoading, hasEpm, scnMeta, varOverrides, setVariant }) {
  const allYears = availableYears(epmData?.demand || []);
  const allZones = [...new Set((epmData?.demand || []).map(r => r.zone))].sort();
  const zcmap    = epmData?.zcmap || [];
  const zoneToCountry = Object.fromEntries(zcmap.map(r => [r.z, r.c]));
  const allCountries  = [...new Set(allZones.map(z => zoneToCountry[z] || z))].sort();

  const [segMode,     setSegMode]     = useState('zone');
  const [hidden,      setHidden]      = useState(new Set());
  const [profileMode, setProfileMode] = useState('full'); // 'full' | 'season'
  const [season,      setSeason]      = useState('Q1');
  const [daytype,     setDaytype]     = useState('avg');

  if (!hasEpm)                  return <NotAvailable t={t} />;
  if (epmLoading)               return <LoadingBox t={t} />;
  if (!epmData?.demand?.length) return <NotAvailable t={t} />;

  const peakRows   = epmData.demand.filter(r => r.type === 'peak');
  const energyRows = epmData.demand.filter(r => r.type === 'energy');

  const toggleHidden = key => setHidden(s => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });

  // Build forecast chart data
  const buildForecastData = () => {
    if (segMode === 'aggregate') {
      const eby = {}, pby = {};
      for (const r of epmData.demand) for (const y of allYears) {
        if (r.type==='energy') eby[y]=(eby[y]||0)+(r.years[y]||0);
        if (r.type==='peak')   pby[y]=(pby[y]||0)+(r.years[y]||0);
      }
      return { labels: allYears, datasets: [
        { type:'bar', label:'Energy (GWh)', yAxisID:'yL',
          data: allYears.map(y => Math.round(eby[y]||0)),
          backgroundColor: hexA('#1a5fa8',0.72), borderWidth:0 },
        { type:'line', label:'Peak (GW)', yAxisID:'yR',
          data: allYears.map(y => +((pby[y]||0)/1000).toFixed(2)),
          borderColor:'#7048A8', borderWidth:2.5, pointRadius:0, tension:0.3, fill:false },
      ]};
    }

    // Use full segments list for stable color assignment (not filtered list)
    const segments = segMode === 'zone' ? allZones : allCountries;
    const ebySegYear = {};
    const pby = {};

    if (segMode === 'zone') {
      for (const r of epmData.demand) for (const y of allYears) {
        if (r.type==='energy') { if(!ebySegYear[r.zone]) ebySegYear[r.zone]={}; ebySegYear[r.zone][y]=(ebySegYear[r.zone][y]||0)+(r.years[y]||0); }
        if (r.type==='peak' && !hidden.has(r.zone)) pby[y]=(pby[y]||0)+(r.years[y]||0);
      }
    } else {
      for (const r of epmData.demand) {
        const c = zoneToCountry[r.zone] || r.zone;
        for (const y of allYears) {
          if (r.type==='energy') { if(!ebySegYear[c]) ebySegYear[c]={}; ebySegYear[c][y]=(ebySegYear[c][y]||0)+(r.years[y]||0); }
          if (r.type==='peak' && !hidden.has(c)) pby[y]=(pby[y]||0)+(r.years[y]||0);
        }
      }
    }

    // Iterate all segments (not filtered), skip hidden — preserves color index
    return { labels: allYears, datasets: [
      ...segments.flatMap((seg, i) => {
        if (hidden.has(seg)) return [];
        return [{ type:'bar', label:seg, yAxisID:'yL',
          data: allYears.map(y => Math.round(ebySegYear[seg]?.[y]||0)),
          backgroundColor: ZONE_PALETTE[i % ZONE_PALETTE.length], borderWidth:0, stack:'energy' }];
      }),
      { type:'line', label:'Peak (GW)', yAxisID:'yR',
        data: allYears.map(y => +((pby[y]||0)/1000).toFixed(2)),
        borderColor:'#7048A8', borderWidth:2.5, pointRadius:0, tension:0.3, fill:false },
    ]};
  };

  // Detect available seasons/daytypes from profile data
  const pf          = epmData?.demandProfileFull || {};
  const hoursData   = epmData?.hours || {};
  const firstZoneWithPf = allZones.find(z => pf[z]);
  const availSeasons    = firstZoneWithPf ? Object.keys(pf[firstZoneWithPf]).sort() : ['Q1','Q2','Q3','Q4'];
  const availDaytypes   = firstZoneWithPf ? Object.keys(pf[firstZoneWithPf]?.[availSeasons[0]] || {}).sort() : [];
  const totalDays       = Object.values(hoursData).reduce((s, dts) => s + Object.values(dts||{}).reduce((a,b)=>a+b,0), 0) || 365;

  // Build profile chart (full year or single season)
  const buildProfileData = () => {
    const isDark = t.isDark;
    const showAvg = !hidden.has('__avg__');

    if (profileMode === 'full') {
      if (!firstZoneWithPf || !availDaytypes.length) return { chartData:{ labels:[], datasets:[] }, plugin:null };
      const nDT = availDaytypes.length, nS = availSeasons.length;
      const nPts = nS * nDT * 24;
      const labels = new Array(nPts).fill('');

      // Zone lines — use allZones index for stable colors
      const zoneDs = allZones.flatMap((z, i) => {
        if (hidden.has(z)) return [];
        const data = [];
        for (const s of availSeasons) for (const d of availDaytypes) {
          const p = pf[z]?.[s]?.[d];
          data.push(...(p ? p : new Array(24).fill(null)));
        }
        if (!data.some(v => v !== null)) return [];
        return [{ label:z, data, borderColor:ZONE_PALETTE[i%ZONE_PALETTE.length],
          borderWidth:1.5, pointRadius:0, tension:0.3, fill:false, spanGaps:true }];
      });

      // Region avg last (on top) — only if not hidden
      const avgData = [];
      for (const s of availSeasons) for (const d of availDaytypes) {
        const profs = allZones.map(z=>pf[z]?.[s]?.[d]).filter(Boolean);
        for (let h=0;h<24;h++) avgData.push(profs.length ? profs.reduce((sum,p)=>sum+(p[h]||0),0)/profs.length : null);
      }
      const avgDs = showAvg ? { label:'Region avg', data:avgData, borderColor:'#1a5fa8',
        borderWidth:2.5, pointRadius:0, tension:0.3, fill:false, spanGaps:true } : null;

      // Separator + label plugin
      const separatorPlugin = {
        id: 'profileSep',
        afterDraw: (chart) => {
          const { ctx, chartArea, scales } = chart;
          if (!chartArea || !scales.x) return;
          const { top, bottom } = chartArea;
          const xScale = scales.x;
          const dashC   = isDark ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.12)';
          const solidC  = isDark ? 'rgba(255,255,255,0.36)' : 'rgba(0,0,0,0.30)';
          const textC   = isDark ? 'rgba(255,255,255,0.46)' : 'rgba(0,0,0,0.40)';
          const seasonC = isDark ? 'rgba(255,255,255,0.70)' : 'rgba(0,0,0,0.58)';

          for (let si=0;si<nS;si++) {
            const seasonStart = si * nDT * 24;
            // Season label above chartArea
            const sx = xScale.getPixelForValue(seasonStart + nDT * 12);
            ctx.save();
            ctx.font='700 9px system-ui,sans-serif';
            ctx.fillStyle=seasonC; ctx.textAlign='center'; ctx.textBaseline='bottom';
            ctx.fillText(availSeasons[si], sx, top - 2);
            ctx.restore();

            for (let di=0;di<nDT;di++) {
              const dtStart = seasonStart + di * 24;
              // Separator line
              if (dtStart > 0) {
                const lx = xScale.getPixelForValue(dtStart);
                const isSeasBorder = di === 0;
                ctx.save();
                ctx.strokeStyle = isSeasBorder ? solidC : dashC;
                ctx.lineWidth   = isSeasBorder ? 1.2 : 0.7;
                if (!isSeasBorder) ctx.setLineDash([3,3]);
                ctx.beginPath(); ctx.moveTo(lx,top); ctx.lineTo(lx,bottom); ctx.stroke();
                ctx.restore();
              }
              // Day type label — rotated −90°, below x-axis
              const midX = xScale.getPixelForValue(dtStart + 12);
              const w    = hoursData?.[availSeasons[si]]?.[availDaytypes[di]] || 0;
              const pct  = w > 0 ? ` (${((w/totalDays)*100).toFixed(0)}%)` : '';
              ctx.save();
              ctx.translate(midX, bottom + 3);
              ctx.rotate(-Math.PI/2);
              ctx.font='7px system-ui,sans-serif';
              ctx.fillStyle=textC; ctx.textAlign='right'; ctx.textBaseline='middle';
              ctx.fillText(`${availDaytypes[di]}${pct}`, 0, 0);
              ctx.restore();
            }
          }
        },
      };
      return { chartData:{ labels, datasets:[...zoneDs, ...(avgDs?[avgDs]:[])] }, plugin:separatorPlugin };
    }

    // Single season mode
    const getP = (zone) => {
      const sp = pf[zone]?.[season];
      if (!sp) return null;
      if (daytype === 'avg') { const days=Object.keys(sp); return days.length ? Array.from({length:24},(_,h)=>days.reduce((s,d)=>s+(sp[d][h]||0),0)/days.length) : null; }
      return sp[daytype] || null;
    };
    // Use allZones index for stable colors
    const zoneLines = allZones.flatMap((z, i) => {
      if (hidden.has(z)) return [];
      const p = getP(z);
      return p ? [{ label:z, data:p, borderColor:ZONE_PALETTE[i%ZONE_PALETTE.length], borderWidth:1.8, pointRadius:0, tension:0.35, fill:false }] : [];
    });
    const allProf = allZones.map(z=>getP(z)).filter(Boolean);
    const avgLine = (showAvg && allProf.length) ? { label:'Region avg', data:Array.from({length:24},(_,h)=>allProf.reduce((s,p)=>s+(p[h]||0),0)/allProf.length), borderColor:'#1a5fa8', borderWidth:2.5, pointRadius:0, tension:0.35, fill:false } : null;
    return { chartData:{ labels:Array.from({length:24},(_,i)=>`${i+1}h`), datasets:[...zoneLines,...(avgLine?[avgLine]:[])] }, plugin:null };
  };

  const segments = segMode === 'zone' ? allZones : segMode === 'country' ? allCountries : [];
  const forecastData  = buildForecastData();
  const profileResult = buildProfileData();

  const handleDownload = () => {
    const header = 'zone,type,' + allYears.join(',');
    const rows = epmData.demand.map(r => `${r.zone},${r.type},${allYears.map(y => r.years[y] ?? '').join(',')}`);
    downloadBlob([header, ...rows].join('\n'), `pDemandForecast_${epmData.branch || ''}.csv`, 'text/csv');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <VariantPicker t={t} scnMeta={scnMeta} param="pDemandForecast" value={varOverrides?.pDemandForecast} onChange={setVariant} />
        <VariantPicker t={t} scnMeta={scnMeta} param="pDemandProfile" value={varOverrides?.pDemandProfile} onChange={setVariant} />
      </div>

      {/* Forecast chart */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <SectionTitle t={t}>Demand forecast</SectionTitle>
          <div style={{ display: 'flex', gap: 3 }}>
            {[['aggregate','Aggregate'],['zone','By Zone'],['country','By Country']].map(([v,l]) => (
              <button key={v} onClick={() => { setSegMode(v); setHidden(new Set()); }} style={{
                fontSize:'0.44rem', fontFamily:'inherit', padding:'2px 6px', borderRadius:3, cursor:'pointer',
                border:`1px solid ${segMode===v?'rgba(74,143,204,0.65)':t.panelBorder}`,
                backgroundColor:segMode===v?'rgba(74,143,204,0.12)':'transparent',
                color:segMode===v?t.lbl:t.lblMuted, fontWeight:segMode===v?600:400,
              }}>{l}</button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <CJChart type="bar" height={180} data={forecastData}
              cacheKey={`forecast|${segMode}|${[...hidden].sort().join(',')}`}
              options={{ ...cjDefaults(t),
                scales: {
                  x: { stacked:true, grid:{color:t.panelBorder}, ticks:{color:t.muted,font:{size:8},maxTicksLimit:7} },
                  yL:{ type:'linear', position:'left', stacked:true, title:{display:true,text:'GWh',color:t.muted,font:{size:7}},
                    grid:{color:t.panelBorder}, ticks:{color:t.muted,font:{size:8}} },
                  yR:{ type:'linear', position:'right', title:{display:true,text:'GW',color:t.muted,font:{size:7}},
                    grid:{drawOnChartArea:false}, ticks:{color:t.muted,font:{size:8}} },
                },
              }}
            />
          </div>
          {segments.length > 0 && (
            <div style={{ width:100, flexShrink:0, display:'flex', flexDirection:'column', gap:2, paddingTop:4, maxHeight:180, overflowY:'auto' }}>
              {segments.map((seg,i) => (
                <div key={seg} onClick={() => toggleHidden(seg)}
                  style={{ display:'flex', alignItems:'center', gap:4, cursor:'pointer', opacity:hidden.has(seg)?0.3:1 }}>
                  <div style={{ width:9, height:9, borderRadius:2, flexShrink:0, backgroundColor:ZONE_PALETTE[i%ZONE_PALETTE.length] }}/>
                  <span style={{ fontSize:'0.43rem', color:t.muted, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{seg}</span>
                </div>
              ))}
              <div style={{ display:'flex', gap:3, marginTop:5 }}>
                <button onClick={() => setHidden(new Set())} style={{ fontSize:'0.38rem', fontFamily:'inherit', padding:'1px 5px', borderRadius:3, cursor:'pointer', border:`1px solid rgba(128,160,192,0.25)`, backgroundColor:'transparent', color:t.lblMuted }}>All</button>
                <button onClick={() => setHidden(new Set(segments))} style={{ fontSize:'0.38rem', fontFamily:'inherit', padding:'1px 5px', borderRadius:3, cursor:'pointer', border:`1px solid rgba(128,160,192,0.25)`, backgroundColor:'transparent', color:t.lblMuted }}>None</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Profile chart */}
      <div>
        <SectionTitle t={t}>Load profile</SectionTitle>
        {/* Mode + season + daytype selectors */}
        <div style={{ display:'flex', flexWrap:'wrap', gap:3, marginBottom:6, alignItems:'center' }}>
          {/* Full Year */}
          <button onClick={() => setProfileMode('full')} style={{
            fontSize:'0.44rem', fontFamily:'inherit', padding:'2px 7px', borderRadius:3, cursor:'pointer',
            border:`1px solid ${profileMode==='full'?'rgba(74,143,204,0.65)':t.panelBorder}`,
            backgroundColor:profileMode==='full'?'rgba(74,143,204,0.12)':'transparent',
            color:profileMode==='full'?t.lbl:t.lblMuted, fontWeight:profileMode==='full'?600:400,
          }}>Full Year</button>
          {/* Season buttons */}
          {availSeasons.map(s => (
            <button key={s} onClick={() => { setProfileMode('season'); setSeason(s); }} style={{
              fontSize:'0.44rem', fontFamily:'inherit', padding:'2px 6px', borderRadius:3, cursor:'pointer',
              border:`1px solid ${profileMode==='season'&&season===s?'rgba(74,143,204,0.65)':t.panelBorder}`,
              backgroundColor:profileMode==='season'&&season===s?'rgba(74,143,204,0.12)':'transparent',
              color:profileMode==='season'&&season===s?t.lbl:t.lblMuted, fontWeight:profileMode==='season'&&season===s?600:400,
            }}>{s}</button>
          ))}
          {/* Day type dropdown — only in season mode */}
          {profileMode === 'season' && availDaytypes.length > 0 && (
            <>
              <div style={{ width:1, backgroundColor:t.panelBorder, height:14 }}/>
              <select value={daytype} onChange={e=>setDaytype(e.target.value)} style={{
                fontSize:'0.44rem', fontFamily:'inherit', padding:'2px 5px', borderRadius:3,
                border:`1px solid ${t.panelBorder}`, backgroundColor:t.panel, color:t.muted, cursor:'pointer',
              }}>
                <option value="avg">Avg</option>
                {availDaytypes.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </>
          )}
        </div>

        {/* Chart + legend */}
        {profileResult.chartData.datasets.length > 0 ? (
          <div style={{ display:'flex', gap:8 }}>
            <div style={{ flex:1 }}>
              <CJChart type="line"
                height={profileMode==='full' ? 205 : 160}
                data={profileResult.chartData}
                plugins={profileResult.plugin ? [profileResult.plugin] : []}
                cacheKey={`${profileMode}|${season}|${daytype}|${[...hidden].sort().join(',')}`}
                options={{ ...cjDefaults(t),
                  layout:{ padding:{ top: profileMode==='full'?18:4, bottom: profileMode==='full'?62:4 } },
                  scales:{
                    x:{ grid:{ color:t.panelBorder, drawTicks:false },
                      ticks:{ display: profileMode!=='full', color:t.muted, font:{size:7}, maxTicksLimit:12 } },
                    y:{ grid:{color:t.panelBorder}, ticks:{color:t.muted,font:{size:8}}, min:0,
                      title:{display:true,text:'Load factor',color:t.muted,font:{size:7}} },
                  },
                }}
              />
            </div>
            {/* Legend */}
            <div style={{ width:96, flexShrink:0, display:'flex', flexDirection:'column', gap:2, paddingTop:4,
              maxHeight: profileMode==='full'?205:160, overflowY:'auto' }}>
              {/* Avg toggle */}
              <div onClick={() => toggleHidden('__avg__')}
                style={{ display:'flex', alignItems:'center', gap:4, cursor:'pointer', opacity:hidden.has('__avg__')?0.25:1 }}>
                <div style={{ width:12, height:2.5, backgroundColor:'#1a5fa8', borderRadius:1 }}/>
                <span style={{ fontSize:'0.43rem', color:t.muted, fontWeight:600 }}>avg</span>
              </div>
              {allZones.map((z,i) => (
                <div key={z} onClick={() => toggleHidden(z)}
                  style={{ display:'flex', alignItems:'center', gap:4, cursor:'pointer', opacity:hidden.has(z)?0.25:1 }}>
                  <div style={{ width:12, height:2.5, backgroundColor:ZONE_PALETTE[i%ZONE_PALETTE.length], borderRadius:1 }}/>
                  <span style={{ fontSize:'0.43rem', color:t.muted, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{z}</span>
                </div>
              ))}
              <div style={{ display:'flex', gap:3, marginTop:5 }}>
                <button onClick={() => setHidden(new Set())} style={{ fontSize:'0.38rem', fontFamily:'inherit', padding:'1px 5px', borderRadius:3, cursor:'pointer', border:`1px solid rgba(128,160,192,0.25)`, backgroundColor:'transparent', color:t.lblMuted }}>All</button>
                <button onClick={() => setHidden(new Set(allZones))} style={{ fontSize:'0.38rem', fontFamily:'inherit', padding:'1px 5px', borderRadius:3, cursor:'pointer', border:`1px solid rgba(128,160,192,0.25)`, backgroundColor:'transparent', color:t.lblMuted }}>None</button>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ fontSize:'0.55rem', color:t.lblMuted, padding:'20px 0' }}>
            No profile data available.
          </div>
        )}
      </div>

      <button onClick={handleDownload} style={{
        fontSize:'0.52rem', fontFamily:'inherit', padding:'5px 10px', borderRadius:4,
        border:`1px solid ${t.panelBorder}`, backgroundColor:'transparent', color:t.muted,
        cursor:'pointer', display:'flex', alignItems:'center', gap:4, alignSelf:'flex-start',
      }}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Download pDemandForecast.csv
      </button>
    </div>
  );
}

// ── Tech display helpers (VRE) ────────────────────────────────────────────────

const VRE_DISPLAY = {
  pv:'Solar PV', solar:'Solar PV',
  onshorewind:'Onshore Wind', wind:'Wind',
  offshorewind:'Offshore Wind',
  ror:'Run-of-River', rof:'Run-of-River',
};
const VRE_COLOR = {
  pv:'#FFD700', solar:'#FFD700',
  onshorewind:'#44DAEC', wind:'#44DAEC',
  offshorewind:'#7CC8FA',
  ror:'#1E9AF5', rof:'#1E9AF5',
};

// ── Resources tab ─────────────────────────────────────────────────────────────

function ResourcesTab({ t, epmData, epmLoading, hasEpm, scnMeta, varOverrides, setVariant }) {
  const [section,     setSection]     = useState('vre');
  const [vreProfileMode, setVreProfileMode] = useState('full');
  const [vreSeason,   setVreSeason]   = useState('Q1');
  const [vreDay,      setVreDay]      = useState('avg');
  const [vreHidden,   setVreHidden]   = useState(new Set());
  const [availZone,   setAvailZone]   = useState('all');
  const [fpCountries, setFpCountries] = useState(null);

  // Auto-detect available VRE techs
  const vp         = epmData?.vreProfile || {};
  const allVreTechs = [...new Set(Object.values(vp).flatMap(Object.keys))].sort();
  const [vreTech, setVreTech] = useState(() => allVreTechs[0] || 'ror');

  if (!hasEpm)    return <NotAvailable t={t} />;
  if (epmLoading) return <LoadingBox t={t} />;
  if (!epmData)   return <NotAvailable t={t} />;

  const zcmap   = epmData.zcmap || [];
  const allZones = zcmap.map(r => r.z);
  const allCountries = [...new Set(zcmap.map(r => r.c))].sort();

  const toggleVreHidden = z => setVreHidden(s => { const n=new Set(s); n.has(z)?n.delete(z):n.add(z); return n; });

  // Detect season/daytype structure for selected VRE tech
  const firstZoneWithVre  = allZones.find(z => vp[z]?.[vreTech]);
  const vreAvailSeasons   = firstZoneWithVre ? Object.keys(vp[firstZoneWithVre][vreTech]).sort() : [];
  const vreAvailDaytypes  = firstZoneWithVre && vreAvailSeasons[0]
    ? Object.keys(vp[firstZoneWithVre][vreTech][vreAvailSeasons[0]] || {}).sort() : [];
  const hoursData  = epmData?.hours || {};
  const totalDaysV = Object.values(hoursData).reduce((s,dts)=>s+Object.values(dts||{}).reduce((a,b)=>a+b,0),0) || 365;

  const buildVREData = () => {
    const isDark   = t.isDark;
    const showAvgV = !vreHidden.has('__avg__');

    if (vreProfileMode === 'full') {
      if (!firstZoneWithVre || !vreAvailDaytypes.length) return { chartData:{ labels:[], datasets:[] }, plugin:null };
      const nDT = vreAvailDaytypes.length, nS = vreAvailSeasons.length;
      const nPts = nS * nDT * 24;
      const labels = new Array(nPts).fill('');

      // Zone lines — use allZones index for stable colors
      const zoneDs = allZones.flatMap((z, i) => {
        if (vreHidden.has(z)) return [];
        const data = [];
        for (const s of vreAvailSeasons) for (const d of vreAvailDaytypes) {
          const p = vp[z]?.[vreTech]?.[s]?.[d];
          data.push(...(p ? p : new Array(24).fill(null)));
        }
        if (!data.some(v => v !== null)) return [];
        return [{ label:z, data, borderColor:ZONE_PALETTE[i%ZONE_PALETTE.length],
          borderWidth:1.5, pointRadius:0, tension:0.3, fill:false, spanGaps:true }];
      });

      // Avg last
      const avgData = [];
      for (const s of vreAvailSeasons) for (const d of vreAvailDaytypes) {
        const profs = allZones.map(z=>vp[z]?.[vreTech]?.[s]?.[d]).filter(Boolean);
        for (let h=0;h<24;h++) avgData.push(profs.length?profs.reduce((sum,p)=>sum+(p[h]||0),0)/profs.length:null);
      }
      const techColor = VRE_COLOR[vreTech] || '#1E9AF5';
      const avgDs = showAvgV ? { label:`${VRE_DISPLAY[vreTech]||vreTech} avg`, data:avgData,
        borderColor:techColor, borderWidth:2.5, pointRadius:0, tension:0.3, fill:false, spanGaps:true } : null;

      // Separator plugin (reuse same pattern as demand)
      const separatorPlugin = {
        id: 'vreSep',
        afterDraw: (chart) => {
          const { ctx, chartArea, scales } = chart;
          if (!chartArea || !scales.x) return;
          const { top, bottom } = chartArea;
          const xScale = scales.x;
          const dashC  = isDark?'rgba(255,255,255,0.13)':'rgba(0,0,0,0.12)';
          const solidC = isDark?'rgba(255,255,255,0.36)':'rgba(0,0,0,0.30)';
          const textC  = isDark?'rgba(255,255,255,0.46)':'rgba(0,0,0,0.40)';
          const seasC  = isDark?'rgba(255,255,255,0.70)':'rgba(0,0,0,0.58)';
          for (let si=0;si<nS;si++) {
            const ss = si*nDT*24;
            const sx = xScale.getPixelForValue(ss+nDT*12);
            ctx.save(); ctx.font='700 9px system-ui,sans-serif';
            ctx.fillStyle=seasC; ctx.textAlign='center'; ctx.textBaseline='bottom';
            ctx.fillText(vreAvailSeasons[si], sx, top-2); ctx.restore();
            for (let di=0;di<nDT;di++) {
              const dts = ss+di*24;
              if (dts>0) {
                const lx=xScale.getPixelForValue(dts);
                const isS=di===0;
                ctx.save(); ctx.strokeStyle=isS?solidC:dashC; ctx.lineWidth=isS?1.2:0.7;
                if(!isS)ctx.setLineDash([3,3]);
                ctx.beginPath();ctx.moveTo(lx,top);ctx.lineTo(lx,bottom);ctx.stroke();ctx.restore();
              }
              const midX=xScale.getPixelForValue(dts+12);
              const w=hoursData?.[vreAvailSeasons[si]]?.[vreAvailDaytypes[di]]||0;
              const pct=w>0?` (${((w/totalDaysV)*100).toFixed(0)}%)`:'';
              ctx.save();ctx.translate(midX,bottom+3);ctx.rotate(-Math.PI/2);
              ctx.font='7px system-ui,sans-serif';ctx.fillStyle=textC;
              ctx.textAlign='right';ctx.textBaseline='middle';
              ctx.fillText(`${vreAvailDaytypes[di]}${pct}`,0,0);ctx.restore();
            }
          }
        },
      };
      return { chartData:{ labels, datasets:[...zoneDs, ...(avgDs?[avgDs]:[])] }, plugin:separatorPlugin };
    }

    // Single season mode
    const getP = (zone) => {
      const sp = vp[zone]?.[vreTech]?.[vreSeason];
      if (!sp) return null;
      if (vreDay==='avg') { const days=Object.keys(sp); return days.length?Array.from({length:24},(_,h)=>days.reduce((s,d)=>s+(sp[d][h]||0),0)/days.length):null; }
      return sp[vreDay]||null;
    };
    // Use allZones index for stable colors
    const zoneLines = allZones.flatMap((z, i) => {
      if (vreHidden.has(z)) return [];
      const p = getP(z);
      return p ? [{ label:z, data:p, borderColor:ZONE_PALETTE[i%ZONE_PALETTE.length], borderWidth:1.8, pointRadius:0, tension:0.35, fill:false }] : [];
    });
    const allProf = allZones.map(z=>getP(z)).filter(Boolean);
    const techColor = VRE_COLOR[vreTech]||'#1E9AF5';
    const avgLine = (showAvgV && allProf.length) ? { label:`${VRE_DISPLAY[vreTech]||vreTech} avg`, data:Array.from({length:24},(_,h)=>allProf.reduce((s,p)=>s+(p[h]||0),0)/allProf.length), borderColor:techColor, borderWidth:2.5, pointRadius:0, tension:0.35, fill:false } : null;
    return { chartData:{ labels:Array.from({length:24},(_,i)=>`${i+1}h`), datasets:[...zoneLines,...(avgLine?[avgLine]:[])] }, plugin:null };
  };

  const buildAvailData = () => {
    const av = epmData.availability || {};
    const zones = availZone==='all' ? allZones : [availZone];
    const techKeys = new Set();
    zones.forEach(z => Object.keys(av[z]||{}).forEach(k => techKeys.add(k)));
    const keys = [...techKeys].slice(0,12);
    const firstZ = av[zones[0]] || {};
    const qCols = keys.length ? Object.keys(firstZ[keys[0]]||{}).filter(k=>/^Q\d+$/.test(k)).sort() : ['Q1','Q2','Q3','Q4'];
    return {
      labels: qCols,
      datasets: keys.map((k,i) => {
        const e = firstZ[k]||{};
        return {
          label: e.fuel&&e.fuel!==''?e.fuel:e.tech||k,
          data: qCols.map(q => { const vals=zones.map(z=>av[z]?.[k]?.[q]).filter(v=>v!=null); return vals.length?+(vals.reduce((s,v)=>s+v,0)/vals.length).toFixed(3):0; }),
          backgroundColor: hexA(EPM_FUEL_COLORS[normalizeFuel(e.fuel||e.tech||'')]||ZONE_PALETTE[i%ZONE_PALETTE.length],0.75),
          borderWidth:0, barThickness:10,
        };
      }),
    };
  };

  const buildFPData = () => {
    const fp = epmData.fuelPrice || {};
    const clist = (fpCountries||allCountries).filter(c=>fp[c]);
    if (!clist.length) return {labels:[],datasets:[]};
    const fuels = [...new Set(clist.flatMap(c=>Object.keys(fp[c]||{})))];
    const years = Object.keys(Object.values(fp[clist[0]]||{})[0]||{}).filter(k=>/^\d{4}$/.test(k)).sort().filter(y=>y<='2050');
    return {
      labels: years,
      datasets: fuels.map((fuel,i) => ({
        label: fuel,
        data: years.map(y => { const vals=clist.map(c=>fp[c]?.[fuel]?.[y]).filter(v=>v!=null&&v>0); return vals.length?+(vals.reduce((s,v)=>s+v,0)/vals.length).toFixed(2):null; }),
        borderColor: EPM_FUEL_COLORS[normalizeFuel(fuel)]||ZONE_PALETTE[i%ZONE_PALETTE.length],
        borderWidth:2, pointRadius:0, tension:0.2, fill:false, spanGaps:true,
      })),
    };
  };

  const Pill = ({ v, active, onClick, children }) => (
    <button onClick={onClick} style={{ fontSize:'0.44rem',fontFamily:'inherit',padding:'2px 7px',borderRadius:3,cursor:'pointer',
      border:`1px solid ${active?'rgba(74,143,204,0.65)':t.panelBorder}`,
      backgroundColor:active?'rgba(74,143,204,0.12)':'transparent',
      color:active?t.lbl:t.lblMuted,fontWeight:active?600:400 }}>{children}</button>
  );

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
      <div style={{ display:'flex', gap:4 }}>
        <Pill active={section==='vre'}   onClick={()=>setSection('vre')}>VRE Profiles</Pill>
        <Pill active={section==='avail'} onClick={()=>setSection('avail')}>Availability</Pill>
        <Pill active={section==='fuel'}  onClick={()=>setSection('fuel')}>Fuel Prices</Pill>
      </div>

      {section==='vre'   && <VariantPicker t={t} scnMeta={scnMeta} param="pVREProfile"          value={varOverrides?.pVREProfile}          onChange={setVariant} />}
      {section==='avail' && <VariantPicker t={t} scnMeta={scnMeta} param="pAvailabilityDefault" value={varOverrides?.pAvailabilityDefault} onChange={setVariant} />}
      {section==='fuel'  && <VariantPicker t={t} scnMeta={scnMeta} param="pFuelPrice"           value={varOverrides?.pFuelPrice}           onChange={setVariant} />}

      {section === 'vre' && (
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {allVreTechs.length === 0 ? (
            <div style={{ color:t.lblMuted, fontSize:'0.55rem' }}>No VRE profile data for this region.</div>
          ) : (
            <>
              {/* Tech pills */}
              <div style={{ display:'flex', flexWrap:'wrap', gap:3, alignItems:'center' }}>
                {allVreTechs.map(tc => (
                  <Pill key={tc} active={vreTech===tc} onClick={()=>setVreTech(tc)}>
                    {VRE_DISPLAY[tc]||tc}
                  </Pill>
                ))}
                <div style={{ width:1, backgroundColor:t.panelBorder, height:14, margin:'0 2px' }}/>
                {/* Mode */}
                <Pill active={vreProfileMode==='full'} onClick={()=>setVreProfileMode('full')}>Full Year</Pill>
                {vreAvailSeasons.map(s => (
                  <Pill key={s} active={vreProfileMode==='season'&&vreSeason===s}
                    onClick={()=>{ setVreProfileMode('season'); setVreSeason(s); }}>{s}</Pill>
                ))}
                {/* Day type dropdown in season mode */}
                {vreProfileMode === 'season' && vreAvailDaytypes.length > 0 && (
                  <>
                    <div style={{ width:1, backgroundColor:t.panelBorder, height:14 }}/>
                    <select value={vreDay} onChange={e=>setVreDay(e.target.value)} style={{
                      fontSize:'0.44rem', fontFamily:'inherit', padding:'2px 5px', borderRadius:3,
                      border:`1px solid ${t.panelBorder}`, backgroundColor:t.panel, color:t.muted, cursor:'pointer',
                    }}>
                      <option value="avg">Avg</option>
                      {vreAvailDaytypes.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </>
                )}
              </div>
              {/* Chart */}
              {(() => {
                const vd = buildVREData();
                return vd.chartData.datasets.length > 0 ? (
                  <div style={{ display:'flex', gap:8 }}>
                    <div style={{ flex:1 }}>
                      <CJChart type="line"
                        height={vreProfileMode==='full' ? 205 : 160}
                        data={vd.chartData}
                        plugins={vd.plugin ? [vd.plugin] : []}
                        cacheKey={`${vreProfileMode}|${vreTech}|${vreSeason}|${vreDay}|${[...vreHidden].sort().join(',')}`}
                        options={{ ...cjDefaults(t),
                          layout:{ padding:{ top:vreProfileMode==='full'?18:4, bottom:vreProfileMode==='full'?62:4 } },
                          scales:{
                            x:{ grid:{color:t.panelBorder,drawTicks:false},
                              ticks:{ display:vreProfileMode!=='full', color:t.muted,font:{size:7},maxTicksLimit:12 } },
                            y:{ min:0, max:1, grid:{color:t.panelBorder}, ticks:{color:t.muted,font:{size:8}},
                              title:{display:true,text:'Availability (0-1)',color:t.muted,font:{size:7}} },
                          },
                        }}
                      />
                    </div>
                    {/* Legend */}
                    <div style={{ width:96, flexShrink:0, display:'flex', flexDirection:'column', gap:2, paddingTop:4,
                      maxHeight:vreProfileMode==='full'?205:160, overflowY:'auto' }}>
                      {/* Avg toggle */}
                      <div onClick={() => setVreHidden(s => { const n=new Set(s); n.has('__avg__')?n.delete('__avg__'):n.add('__avg__'); return n; })}
                        style={{ display:'flex', alignItems:'center', gap:4, cursor:'pointer', opacity:vreHidden.has('__avg__')?0.25:1 }}>
                        <div style={{ width:12, height:2.5, backgroundColor:VRE_COLOR[vreTech]||'#1E9AF5', borderRadius:1 }}/>
                        <span style={{ fontSize:'0.43rem', color:t.muted, fontWeight:600 }}>avg</span>
                      </div>
                      {allZones.map((z, allIdx) => {
                        if (!vp[z]?.[vreTech]) return null;
                        return (
                          <div key={z} onClick={()=>toggleVreHidden(z)}
                            style={{ display:'flex', alignItems:'center', gap:4, cursor:'pointer', opacity:vreHidden.has(z)?0.25:1 }}>
                            <div style={{ width:12, height:2.5, backgroundColor:ZONE_PALETTE[allIdx%ZONE_PALETTE.length], borderRadius:1 }}/>
                            <span style={{ fontSize:'0.43rem', color:t.muted, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{z}</span>
                          </div>
                        );
                      })}
                      <div style={{ display:'flex', gap:3, marginTop:5 }}>
                        <button onClick={() => setVreHidden(new Set())} style={{ fontSize:'0.38rem', fontFamily:'inherit', padding:'1px 5px', borderRadius:3, cursor:'pointer', border:`1px solid rgba(128,160,192,0.25)`, backgroundColor:'transparent', color:t.lblMuted }}>All</button>
                        <button onClick={() => setVreHidden(new Set(allZones))} style={{ fontSize:'0.38rem', fontFamily:'inherit', padding:'1px 5px', borderRadius:3, cursor:'pointer', border:`1px solid rgba(128,160,192,0.25)`, backgroundColor:'transparent', color:t.lblMuted }}>None</button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div style={{ color:t.lblMuted, fontSize:'0.55rem' }}>
                    No {VRE_DISPLAY[vreTech]||vreTech} data available.
                  </div>
                );
              })()}
            </>
          )}
        </div>
      )}

      {section === 'avail' && (
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          <div style={{ display:'flex', gap:4, alignItems:'center' }}>
            <span style={{ fontSize:'0.44rem',color:t.lblMuted }}>Zone:</span>
            <select value={availZone} onChange={e=>setAvailZone(e.target.value)} style={{ fontSize:'0.44rem',fontFamily:'inherit',padding:'3px 6px',borderRadius:3,border:`1px solid ${t.panelBorder}`,backgroundColor:t.panel,color:t.muted }}>
              <option value="all">All (avg)</option>
              {allZones.map(z=><option key={z} value={z}>{z}</option>)}
            </select>
          </div>
          {(() => { const ad=buildAvailData(); return ad.datasets.length>0 ? (
            <>
              <CJChart type="bar" height={160} data={ad}
                options={{ ...cjDefaults(t), scales:{
                  x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}}},
                  y:{min:0,max:1,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}},title:{display:true,text:'Availability factor',color:t.muted,font:{size:7}}},
                }}}
              />
              <div style={{ display:'flex',flexWrap:'wrap',gap:'3px 8px',marginTop:2 }}>
                {ad.datasets.map((ds,i)=>(
                  <div key={ds.label} style={{ display:'flex',alignItems:'center',gap:3,fontSize:'0.43rem',color:t.muted }}>
                    <div style={{ width:8,height:8,borderRadius:2,backgroundColor:ad.datasets[i].backgroundColor }}/>{ds.label}
                  </div>
                ))}
              </div>
            </>
          ) : <div style={{ color:t.lblMuted,fontSize:'0.55rem' }}>No availability data.</div>; })()}
        </div>
      )}

      {section === 'fuel' && (
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          <div>
            <div style={{ fontSize:'0.44rem',color:t.lblMuted,marginBottom:4 }}>Countries:</div>
            <div style={{ display:'flex',flexWrap:'wrap',gap:3 }}>
              <Pill active={fpCountries===null} onClick={()=>setFpCountries(null)}>All</Pill>
              {allCountries.filter(c=>(epmData.fuelPrice||{})[c]).map(c=>(
                <Pill key={c} active={fpCountries?.includes(c)??false} onClick={()=>setFpCountries(prev=>{
                  if(prev===null)return[c];const n=prev.includes(c)?prev.filter(x=>x!==c):[...prev,c];return n.length===0?null:n;
                })}>{c}</Pill>
              ))}
            </div>
          </div>
          {(() => { const fd=buildFPData(); return fd.datasets.length>0 ? (
            <>
              <CJChart type="line" height={170} data={fd}
                options={{ ...cjDefaults(t), scales:{
                  x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:7},maxTicksLimit:8}},
                  y:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}},title:{display:true,text:'USD/MBtu',color:t.muted,font:{size:7}}},
                }}}
              />
              <div style={{ display:'flex',flexWrap:'wrap',gap:'3px 10px',marginTop:2 }}>
                {fd.datasets.map((ds,i)=>(
                  <div key={ds.label} style={{ display:'flex',alignItems:'center',gap:3,fontSize:'0.43rem',color:t.muted }}>
                    <div style={{ width:12,height:2.5,borderRadius:1,backgroundColor:typeof ds.borderColor==='string'?ds.borderColor:ZONE_PALETTE[i%ZONE_PALETTE.length] }}/>{ds.label}
                  </div>
                ))}
              </div>
            </>
          ) : <div style={{ color:t.lblMuted,fontSize:'0.55rem' }}>No fuel price data.</div>; })()}
        </div>
      )}
    </div>
  );
}

// ── Trade / Transmission tab ──────────────────────────────────────────────────

function TradeTab({ t, epmData, epmLoading, hasEpm, scnMeta, varOverrides, setVariant }) {
  const ntcYears = availableYears(epmData?.ntc || []);
  const [yr, setYr]       = useState(null);
  const [chartType, setChartType] = useState('bar'); // bar | line
  const [ntcHidden, setNtcHidden] = useState(new Set());

  if (!hasEpm)              return <NotAvailable t={t} />;
  if (epmLoading)           return <LoadingBox t={t} />;
  if (!epmData?.ntc?.length) return <NotAvailable t={t} />;

  const refYr = yr || ntcYears.find(y => y === '2024') || ntcYears[0];

  // Deduplicate: keep only one entry per corridor pair
  const seenC = new Set();
  const uniqueNtc = epmData.ntc.filter(r => {
    const key = [r.z,r.z2].sort().join('||');
    if (seenC.has(key)) return false; seenC.add(key); return true;
  });

  const corridors = uniqueNtc
    .map(r => ({ ...r, label: `${r.z} ↔ ${r.z2}`, mw: r.years[refYr] || 0 }))
    .filter(r => r.mw > 0)
    .sort((a, b) => b.mw - a.mw);

  // NTC evolution chart — top N corridors by max capacity (deduplicated)
  const topN = 10;
  const topCorridors = [...uniqueNtc]
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
      <VariantPicker t={t} scnMeta={scnMeta} param="pTransferLimit" value={varOverrides?.pTransferLimit} onChange={setVariant} />

      {/* NTC Evolution chart */}
      <div>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
          <SectionTitle t={t}>NTC evolution — top {topN} corridors (MW)</SectionTitle>
          <div style={{ display:'flex', gap:3 }}>
            {['bar','line'].map(type=>(
              <button key={type} onClick={()=>setChartType(type)} style={{
                fontSize:'0.44rem', fontFamily:'inherit', padding:'2px 5px', borderRadius:3,
                cursor:'pointer', border:`1px solid ${chartType===type?t.lbl:t.panelBorder}`,
                backgroundColor:chartType===type?hexA('#1a5fa8',0.1):'transparent',
                color:chartType===type?t.lbl:t.lblMuted,
              }}>{type}</button>
            ))}
          </div>
        </div>
        <div style={{ display:'flex', gap:6, alignItems:'flex-start' }}>
          <div style={{ flex:1, minWidth:0 }}>
            <CJChart type={chartType} height={200}
              cacheKey={`ntc-ev|${chartType}|${[...ntcHidden].sort().join(',')}`}
              data={{ labels:ntcYears, datasets:topCorridors
                .filter(r=>!ntcHidden.has(`${r.z} ↔ ${r.z2}`))
                .map(r=>{
                  const i=topCorridors.indexOf(r);
                  return{ label:`${r.z} ↔ ${r.z2}`, data:ntcYears.map(y=>r.years[y]||0),
                    backgroundColor:hexA(ZONE_PALETTE[i%ZONE_PALETTE.length],0.6),
                    borderColor:ZONE_PALETTE[i%ZONE_PALETTE.length],
                    borderWidth:2, pointRadius:0, tension:0.3, fill:false,
                    stack:chartType==='bar'?'a':undefined };
                })
              }}
              options={{ ...cjDefaults(t),
                scales:{
                  x:{stacked:chartType==='bar',grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},maxTicksLimit:7}},
                  y:{stacked:chartType==='bar',grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}},
                },
                plugins:{...cjDefaults(t).plugins,legend:{display:false},
                  tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.raw.toLocaleString()} MW`}}},
              }}
            />
          </div>
          <div style={{ width:90, flexShrink:0, display:'flex', flexDirection:'column', gap:2, paddingTop:4, maxHeight:200, overflowY:'auto' }}>
            {corridors.map((r,i)=>{
              const label=r.label;
              return (
                <div key={label} onClick={()=>setNtcHidden(prev=>{const n=new Set(prev);n.has(label)?n.delete(label):n.add(label);return n;})}
                  style={{ display:'flex', alignItems:'center', gap:3, cursor:'pointer', opacity:ntcHidden.has(label)?0.25:1 }}>
                  <div style={{ width:12, height:2, borderRadius:1, backgroundColor:ZONE_PALETTE[i%ZONE_PALETTE.length], flexShrink:0 }}/>
                  <span style={{ fontSize:'0.4rem', color:t.muted, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{label}</span>
                </div>
              );
            })}
            <div style={{ fontSize:'0.38rem', color:t.lblMuted, marginTop:4, display:'flex', gap:6 }}>
              <span onClick={()=>setNtcHidden(new Set(corridors.map(r=>r.label)))} style={{cursor:'pointer',textDecoration:'underline'}}>None</span>
              <span onClick={()=>setNtcHidden(new Set())} style={{cursor:'pointer',textDecoration:'underline'}}>All</span>
            </div>
          </div>
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
        {(()=>{const visCor=corridors.filter(r=>!ntcHidden.has(r.label));return(
          <CJChart type="bar" height={Math.min(visCor.length*22+24,260)}
            cacheKey={`ntc-yr|${refYr}|${[...ntcHidden].sort().join(',')}`}
            data={{ labels:visCor.map(r=>r.label),
              datasets:[{data:visCor.map(r=>r.mw),
                backgroundColor:visCor.map(r=>ZONE_PALETTE[corridors.indexOf(r)%ZONE_PALETTE.length]),
                borderWidth:0, barThickness:12}] }}
            options={{ ...cjDefaults(t), indexAxis:'y',
              scales:{
                x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}},
                y:{grid:{display:false},ticks:{color:t.muted,font:{size:8}}},
              },
              plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,
                callbacks:{label:ctx=>`${ctx.raw.toLocaleString()} MW`}}},
            }}
          />
        );})()}
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
      {region.epm && (
        <a href={`https://htmlpreview.github.io/?https://raw.githubusercontent.com/ESMAP-World-Bank-Group/EPM/${region.epm.branch}/epm/input/${region.epm.dataFolder}/DATA_SOURCES.html`}
          target="_blank" rel="noreferrer"
          style={{ textDecoration: 'none' }}>
          <div style={{ border: `1px solid ${t.panelBorder}`, borderRadius: 8, padding: '10px 14px',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            cursor: 'pointer', transition: 'background 0.15s',
            backgroundColor: t.panel }}
            onMouseEnter={e => e.currentTarget.style.backgroundColor = t.isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)'}
            onMouseLeave={e => e.currentTarget.style.backgroundColor = t.panel}>
            <div>
              <div style={{ fontSize: '0.6rem', fontWeight: 700, color: t.lbl, marginBottom: 2 }}>
                Data Sources
              </div>
              <div style={{ fontSize: '0.52rem', color: t.muted }}>
                Detailed methodology and source references for all input data
              </div>
            </div>
            <span style={{ fontSize: '0.85rem', color: t.lblMuted, marginLeft: 10 }}>↗</span>
          </div>
        </a>
      )}
      <div style={{ border: `1px solid ${t.panelBorder}`, borderRadius: 8, padding: '12px 14px',
        fontSize: '0.58rem', color: t.muted, lineHeight: 1.7 }}>
        <div style={{ fontSize: '0.6rem', fontWeight: 700, color: t.lbl, marginBottom: 6 }}>Data loaded</div>
        {epmData ? (
          <>
            <div>Generation units: <b style={{ color: t.lbl }}>{epmData.gen.length}</b></div>
            <div>Demand zones: <b style={{ color: t.lbl }}>{[...new Set(epmData.demand.map(r => r.zone))].length}</b></div>
            <div>NTC corridors: <b style={{ color: t.lbl }}>{(() => { const s=new Set(); epmData.ntc.forEach(r=>{const k=[r.z,r.z2].sort().join('||');s.add(k);}); return s.size; })()}</b></div>
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

  const containerRef       = useRef(null);
  const mapRef             = useRef(null);
  const donutMarkersRef    = useRef([]);
  const zoneCentroidsRef   = useRef({});
  const countryCentroidsRef = useRef({});

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
  const [scnMeta,         setScnMeta]         = useState(null);   // parsed config.csv + scenarios.csv
  const [varOverrides,    setVarOverrides]    = useState({});     // { paramName: variantFile }
  const setVariant = (param, file) => setVarOverrides(o => {
    const next = { ...o };
    if (file) next[param] = file; else delete next[param];
    return next;
  });
  const [pieMode,         setPieMode]         = useState('zone');
  const [epmYear,         setEpmYear]         = useState(null);
  const [showExtZones,    setShowExtZones]    = useState(false);
  const [mapLoaded,       setMapLoaded]       = useState(0);
  const [panelWidth,      setPanelWidth]      = useState(560);
  const isDrRef = useRef(false); const drStartX = useRef(0); const drStartW = useRef(0);

  // Static data
  useEffect(() => {
    fetch('/data/tariffs.json').then(r => r.json()).then(setTariffs).catch(() => {});
    fetch('/data/access.json').then(r => r.json()).then(setAccess).catch(() => {});
  }, []);

  // Region metadata
  useEffect(() => {
    track('region_view', { region: regionId });
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

  // Reset year when region changes
  useEffect(() => { setEpmYear(null); }, [region]);

  // Load scenario definitions (config.csv + scenarios.csv) for variant pickers
  useEffect(() => {
    setScnMeta(null);
    setVarOverrides({});
    if (!region?.epm) return;
    const { branch, dataFolder, scenariosFile, configFile } = region.epm;
    fetchScenarioConfig(branch, dataFolder, { scenariosFile, configFile })
      .then(setScnMeta)
      .catch(() => setScnMeta(null));
  }, [region]);

  // EPM data — also fetches linestring + demand profile
  const prevRegionRef = useRef(null);
  useEffect(() => {
    if (!region?.epm) { setEpmData(null); return; }
    const regionChanged = prevRegionRef.current !== region;
    prevRegionRef.current = region;
    const { branch, dataFolder } = region.epm;
    // Effective file for a data type: user-selected variant, else hard-coded default.
    const rf = (param, fallback) => varOverrides[param] || fallback;
    // Blank + show the loading screen ONLY when the region changes. On a variant
    // change we keep the current data visible and swap it in when ready (fluid).
    if (regionChanged) { setEpmData(null); setEpmLoading(true); }
    Promise.all([
      fetchEpmCSV(branch, dataFolder, rf('pGenDataInput', 'supply/pGenDataInput.csv')),
      fetchEpmCSV(branch, dataFolder, rf('pDemandForecast', 'load/pDemandForecast.csv')),
      fetchEpmCSV(branch, dataFolder, rf('pTransferLimit', 'trade/pTransferLimit.csv')),
      fetchEpmCSV(branch, dataFolder, 'zcmap.csv'),
      fetchLinestringGeoJSON(branch, dataFolder),
      fetchEpmCSV(branch, dataFolder, rf('pDemandProfile', 'load/pDemandProfile.csv')),
      fetchZonesGeoJSON(branch, dataFolder),
      fetchEpmCSV(branch, dataFolder, rf('pVREProfile', 'supply/pVREProfile.csv')),
      fetchEpmCSV(branch, dataFolder, rf('pAvailabilityDefault', 'supply/pAvailabilityDefault.csv')),
      fetchEpmCSV(branch, dataFolder, rf('pFuelPrice', 'supply/pFuelPrice.csv')),
      fetchEpmCSV(branch, dataFolder, rf('pHours', 'pHours.csv')),
      fetchZonesExtGeoJSON(branch, dataFolder),
      fetchEpmCSV(branch, dataFolder, rf('pExtTransferLimit', 'trade/pExtTransferLimit.csv')),
    ]).then(([genRaw, demandRaw, ntcRaw, zcmapRaw, linestringGJ, profileRaw, zonesGJ, vreRaw, availRaw, fpRaw, hoursRaw, zonesExtGJ, extNtcRaw]) => {
      const demandYears = (demandRaw || []).length
        ? Object.keys(demandRaw[0]).filter(k => /^\d{4}$/.test(k)).sort()
        : [];
      const defaultYr = demandYears.find(y => parseInt(y) >= 2023) || demandYears[0];
      if (regionChanged && defaultYr) setEpmYear(defaultYr);   // keep the chosen year on variant change
      setEpmData(prev => ({
        gen:               genRaw    ? processGenData(genRaw)               : [],
        demand:            demandRaw ? processDemand(demandRaw)             : [],
        ntc:               ntcRaw    ? processNTC(ntcRaw)                   : [],
        zcmap:             zcmapRaw  || [],
        demandProfileFull: profileRaw ? processDemandProfileFull(profileRaw) : {},
        vreProfile:        vreRaw    ? processVREProfile(vreRaw)            : {},
        availability:      availRaw  ? processAvailability(availRaw)        : {},
        fuelPrice:         fpRaw     ? processFuelPrice(fpRaw)              : {},
        hours:             hoursRaw  ? processHours(hoursRaw)               : {},
        extNtc:            extNtcRaw ? processExtNTC(extNtcRaw)             : [],
        // Preserve geojson refs on a variant change so the map doesn't rebuild/recenter.
        linestringGJ: (regionChanged || !prev) ? linestringGJ : prev.linestringGJ,
        zonesGJ:      (regionChanged || !prev) ? zonesGJ      : prev.zonesGJ,
        zonesExtGJ:   (regionChanged || !prev) ? zonesExtGJ   : prev.zonesExtGJ,
        branch,
      }));
    }).finally(() => setEpmLoading(false));
  }, [region, varOverrides]);

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
        regionCountries.forEach((c, i) => { countryColorMap[c] = MAP_PALETTE[i % MAP_PALETTE.length]; });

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

        // Store centroids in refs for pieMode effect
        zoneCentroidsRef.current = zoneCentroids;
        countryCentroidsRef.current = countryCentroids;

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
          const ntcYr  = ntcYrs.find(y => epmData.ntc.some(r => (r.years[y] || 0) > 0))
                         || ntcYrs[0] || '2024';
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

        // ── External zone layers (toggle-controlled) ─────────────────────
        const zonesExtGJ = epmData.zonesExtGJ;
        const extNtc     = epmData.extNtc || [];
        const extNodeCoords = {};
        if (zonesExtGJ) {
          for (const f of zonesExtGJ.features) {
            const z = f.properties?.z;
            if (z && f.geometry?.type === 'Point')
              extNodeCoords[z] = f.geometry.coordinates;
          }
        }

        const extNtcYrs  = extNtc.length > 0 ? Object.keys(extNtc[0].years).sort() : [];
        const extNtcYr   = extNtcYrs[0] || '2024';
        const extLineFeatures = extNtc
          .filter(r => zoneCentroids[r.z] && extNodeCoords[r.zext])
          .map(r => ({
            type: 'Feature',
            properties: { z: r.z, zext: r.zext, ntc_mw: r.years[extNtcYr] || 0 },
            geometry: { type: 'LineString', coordinates: [zoneCentroids[r.z], extNodeCoords[r.zext]] },
          }));
        const extNodeFeatures = Object.entries(extNodeCoords).map(([z, coords]) => ({
          type: 'Feature',
          properties: { z },
          geometry: { type: 'Point', coordinates: coords },
        }));

        // Build a lookup: zext → max NTC MW (for popup display)
        const extNtcByPair = {};
        for (const r of extNtc)
          extNtcByPair[`${r.z}||${r.zext}`] = r.years[extNtcYr] || 0;

        map.addSource('ext-ntc-lines', { type: 'geojson',
          data: { type: 'FeatureCollection', features: extLineFeatures } });
        map.addLayer({ id: 'ext-ntc-lines-layer', type: 'line', source: 'ext-ntc-lines',
          layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#888888',
            'line-width': ['interpolate', ['linear'], ['get', 'ntc_mw'], 0, 1, 500, 2, 2000, 3, 5000, 4.5],
            'line-opacity': 0.85 } });

        map.addSource('ext-nodes', { type: 'geojson',
          data: { type: 'FeatureCollection', features: extNodeFeatures } });
        map.addLayer({ id: 'ext-nodes-circles', type: 'circle', source: 'ext-nodes',
          layout: { visibility: 'none' },
          paint: { 'circle-radius': 5, 'circle-color': tv.isDark ? 'rgba(40,40,40,0.85)' : 'rgba(255,255,255,0.85)',
            'circle-stroke-width': 1.5, 'circle-stroke-color': '#888888' } });
        map.addLayer({ id: 'ext-nodes-labels', type: 'symbol', source: 'ext-nodes',
          layout: { visibility: 'none', 'text-field': ['get', 'z'],
            'text-size': 10, 'text-font': ['literal', ['Noto Sans Bold', 'Arial Unicode MS Bold']],
            'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-allow-overlap': false },
          paint: { 'text-color': tv.isDark ? '#e0e0e0' : '#222222',
            'text-halo-color': tv.isDark ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.7)',
            'text-halo-width': 1 } });
        map.addLayer({ id: 'ext-ntc-labels', type: 'symbol', source: 'ext-ntc-lines',
          layout: { visibility: 'none',
            'text-field': ['concat', ['to-string', ['round', ['get', 'ntc_mw']]], ' MW'],
            'text-size': 9, 'text-font': ['literal', ['Noto Sans Bold', 'Arial Unicode MS Bold']],
            'symbol-placement': 'line-center', 'text-allow-overlap': false },
          paint: { 'text-color': tv.isDark ? '#cccccc' : '#444444',
            'text-halo-color': tv.isDark ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.7)',
            'text-halo-width': 1 } });

        // Hover popup: line shows "Z ↔ Ext · NTC MW"
        map.on('mouseenter', 'ext-ntc-lines-layer', e => {
          if (!map.getLayoutProperty('ext-ntc-lines-layer', 'visibility') === 'none') return;
          map.getCanvas().style.cursor = 'pointer';
          const { z, zext, ntc_mw } = e.features[0].properties;
          popup.setLngLat(e.lngLat)
            .setHTML(`<b>${z} ↔ ${zext}</b><br><span style="opacity:.75">NTC: ${Math.round(ntc_mw).toLocaleString()} MW</span>`)
            .addTo(map);
        });
        map.on('mouseleave', 'ext-ntc-lines-layer', () => {
          map.getCanvas().style.cursor = ''; popup.remove();
        });

        // Hover popup: node shows all connected corridors + NTC
        map.on('mouseenter', 'ext-nodes-circles', e => {
          map.getCanvas().style.cursor = 'pointer';
          const zext = e.features[0].properties.z;
          const corridors = extNtc.filter(r => r.zext === zext);
          const rows = corridors.map(r =>
            `<div style="display:flex;justify-content:space-between;gap:12px">` +
            `<span style="opacity:.75">${r.z}</span>` +
            `<span style="font-weight:600">${Math.round(r.years[extNtcYr] || 0).toLocaleString()} MW</span></div>`
          ).join('');
          popup.setLngLat(e.lngLat)
            .setHTML(`<b>${zext}</b><br>${rows || '<span style="opacity:.6">No NTC data</span>'}`)
            .addTo(map);
        });
        map.on('mouseleave', 'ext-nodes-circles', () => {
          map.getCanvas().style.cursor = ''; popup.remove();
        });

        // Trigger donut rendering via pieMode effect
        setMapLoaded(n => n + 1);

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

  // External zones toggle
  useEffect(() => {
    const map = mapRef.current;
    const vis = showExtZones ? 'visible' : 'none';
    for (const id of ['ext-ntc-lines-layer', 'ext-ntc-labels', 'ext-nodes-circles', 'ext-nodes-labels']) {
      if (map?.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
    }
  }, [showExtZones]);

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

  // Pie donut markers — re-render on pieMode toggle or after map loads
  useEffect(() => {
    if (!mapRef.current || !epmData || mapLoaded === 0) return;
    const tv = getT(theme);
    const zcmapRows = epmData.zcmap;
    const zoneToCountry = Object.fromEntries(zcmapRows.map(r => [r.z, r.c]));

    donutMarkersRef.current.forEach(m => m.remove());
    donutMarkersRef.current = [];

    const activeGen = genForYear(epmData.gen, epmYear);
    if (pieMode === 'zone') {
      for (const { z, c } of zcmapRows) {
        const coord = zoneCentroidsRef.current[z];
        if (!coord) continue;
        const fuelMix = {};
        for (const r of activeGen.filter(g => g.zone === z))
          fuelMix[r.fuel] = (fuelMix[r.fuel] || 0) + r.capacity;
        if (!Object.keys(fuelMix).length) continue;
        const el = document.createElement('div');
        el.style.cursor = 'pointer';
        el.innerHTML = makeDonutSVG(fuelMix, tv, 48);
        el.addEventListener('click', () => navigate(`/region/${regionId}/country/${encodeURIComponent(c)}`));
        const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat(coord).addTo(mapRef.current);
        donutMarkersRef.current.push(marker);
      }
    } else {
      const countryGen = {};
      for (const r of activeGen) {
        const c = zoneToCountry[r.zone] || r.zone;
        if (!countryGen[c]) countryGen[c] = {};
        countryGen[c][r.fuel] = (countryGen[c][r.fuel] || 0) + r.capacity;
      }
      for (const [c, fuelMix] of Object.entries(countryGen)) {
        const coord = countryCentroidsRef.current[c];
        if (!coord) continue;
        const el = document.createElement('div');
        el.style.cursor = 'pointer';
        el.innerHTML = makeDonutSVG(fuelMix, tv);
        el.addEventListener('click', () => navigate(`/region/${regionId}/country/${encodeURIComponent(c)}`));
        const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat(coord).addTo(mapRef.current);
        donutMarkersRef.current.push(marker);
      }
    }
  }, [pieMode, mapLoaded, theme, epmYear, epmData]); // eslint-disable-line react-hooks/exhaustive-deps

  // NTC map update when year changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !epmData || mapLoaded === 0) return;
    if (!map.getSource('ntc-lines')) return;
    const ntcYrs = availableYears(epmData.ntc);
    const yr = epmYear
      || ntcYrs.find(y => epmData.ntc.some(r => (r.years[y] || 0) > 0))
      || ntcYrs[0] || '2024';
    const seen = new Set();
    const features = epmData.ntc
      .filter(r => {
        const key = [r.z, r.z2].sort().join('||');
        if (seen.has(key)) return false;
        seen.add(key);
        return (r.years[yr] || 0) > 0
          && zoneCentroidsRef.current[r.z] && zoneCentroidsRef.current[r.z2];
      })
      .map(r => ({
        type: 'Feature',
        properties: { z: r.z, z_other: r.z2, ntc_mw: r.years[yr] || 0 },
        geometry: { type: 'LineString', coordinates: [zoneCentroidsRef.current[r.z], zoneCentroidsRef.current[r.z2]] },
      }));
    map.getSource('ntc-lines').setData({ type: 'FeatureCollection', features });
  }, [epmYear, mapLoaded, epmData]); // eslint-disable-line react-hooks/exhaustive-deps

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

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 46px)' }}
      onMouseMove={e=>{ if(!isDrRef.current)return; setPanelWidth(w=>Math.max(380,Math.min(760,drStartW.current+(drStartX.current-e.clientX)))); }}
      onMouseUp={()=>{isDrRef.current=false;}} onMouseLeave={()=>{isDrRef.current=false;}}
    >

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

          {/* EPM map badge + pie mode toggle */}
          {isEpmMode && (
            <div style={{ position: 'absolute', bottom: 10, left: 10, zIndex: 10, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ fontSize: '0.46rem', color: t.lblMuted, backgroundColor: t.panel,
                border: `1px solid ${t.panelBorder}`, borderRadius: 4, padding: '3px 7px',
                display: 'flex', alignItems: 'center', gap: 6 }}>
                <span>EPM zones + NTC · {epmData.ntc.length} corridors</span>
                <a href={`https://htmlpreview.github.io/?https://raw.githubusercontent.com/ESMAP-World-Bank-Group/EPM/${region.epm.branch}/epm/input/${region.epm.dataFolder}/DATA_SOURCES.html`}
                  target="_blank" rel="noreferrer"
                  style={{ color: t.lbl, fontWeight: 600, textDecoration: 'none', opacity: 0.7,
                    borderLeft: `1px solid ${t.panelBorder}`, paddingLeft: 6 }}
                  title="View detailed data sources">
                  Sources ↗
                </a>
              </div>
              <div style={{ display: 'flex', gap: 2, backgroundColor: t.panel,
                border: `1px solid ${t.panelBorder}`, borderRadius: 4, padding: 2 }}>
                {['country', 'zone'].map(mode => (
                  <button key={mode} onClick={() => setPieMode(mode)} style={{
                    fontSize: '0.46rem', fontFamily: 'inherit', cursor: 'pointer',
                    padding: '2px 7px', borderRadius: 3, border: 'none',
                    backgroundColor: pieMode === mode ? 'rgba(74,143,204,0.2)' : 'transparent',
                    color: pieMode === mode ? t.lbl : t.lblMuted,
                    fontWeight: pieMode === mode ? 700 : 400,
                  }}>
                    {mode === 'country' ? 'By country' : 'By zone'}
                  </button>
                ))}
              </div>
              {epmData.extNtc?.length > 0 && (
                <button onClick={() => setShowExtZones(v => !v)} style={{
                  fontSize: '0.46rem', fontFamily: 'inherit', cursor: 'pointer',
                  padding: '3px 8px', borderRadius: 4,
                  border: `1px solid ${showExtZones ? 'rgba(136,136,136,0.6)' : t.panelBorder}`,
                  backgroundColor: showExtZones ? 'rgba(136,136,136,0.14)' : t.panel,
                  color: showExtZones ? t.lbl : t.lblMuted,
                  fontWeight: showExtZones ? 700 : 400,
                  transition: 'all 0.15s',
                }}>
                  Ext. zones
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Drag handle */}
      {showMap && <div style={{width:5,flexShrink:0,cursor:'col-resize'}} onMouseDown={e=>{isDrRef.current=true;drStartX.current=e.clientX;drStartW.current=panelWidth;e.preventDefault();}}/>}

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
          {['Overview', 'Demand', 'Supply', 'Resources', 'Trade', 'Scenarios', 'About'].map(tab => {
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
          epmData      ? <EpmOverviewTab t={t} epmData={epmData} region={region} epmYear={epmYear} setEpmYear={setEpmYear} /> :
                         <NotAvailable t={t} />
        )}
        {activeTab === 'supply' && (
          !region.epm  ? <NotAvailable t={t} /> :
          epmLoading   ? <LoadingBox t={t} /> :
          epmData      ? <EpmSupplyTab t={t} epmData={epmData} region={region}
                           scnMeta={scnMeta} varOverrides={varOverrides} setVariant={setVariant} /> :
                         <NotAvailable t={t} />
        )}
        {activeTab === 'demand' && (
          <DemandTab t={t} epmData={epmData} epmLoading={epmLoading} hasEpm={!!region.epm}
            scnMeta={scnMeta} varOverrides={varOverrides} setVariant={setVariant} />
        )}
        {activeTab === 'resources' && (
          <ResourcesTab t={t} epmData={epmData} epmLoading={epmLoading} hasEpm={!!region.epm}
            scnMeta={scnMeta} varOverrides={varOverrides} setVariant={setVariant} />
        )}
        {activeTab === 'scenarios' && (
          <ScenarioTab t={t} scnMeta={scnMeta} />
        )}
        {activeTab === 'trade' && (
          <TradeTab t={t} epmData={epmData} epmLoading={epmLoading} hasEpm={!!region.epm}
            scnMeta={scnMeta} varOverrides={varOverrides} setVariant={setVariant} />
        )}
        {activeTab === 'about' && (
          <AboutTab region={region} t={t} epmData={epmData} />
        )}
      </div>
    </div>
  );
}
