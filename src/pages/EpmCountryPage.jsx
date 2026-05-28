import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import { useTheme } from '../App';
import { getT, mapStyle } from '../constants';
import {
  fetchEpmCSV, fetchLinestringGeoJSON, fetchZonesGeoJSON,
  processGenData, processDemand, processNTC, processDemandProfile,
  availableYears, EPM_FUEL_COLORS,
} from '../utils/epmFetch';

const ZONE_PALETTE = [
  '#1E9AF5','#FF6B6B','#52C860','#FFD700','#C8A8F0',
  '#FF8C42','#44DAEC','#E74C3C','#9B59B6','#2ECC71',
  '#F39C12','#1ABC9C','#E67E22','#8E44AD','#16A085','#D35400',
];

function CJChart({ type, data, options, height }) {
  const canvasRef = useRef(null);
  const chartRef  = useRef(null);
  const sig = JSON.stringify({ type, labels: data.labels,
    ds: data.datasets?.map(d => ({ l: d.label, n: d.data?.length, t: d.type })) });
  useEffect(() => {
    const CJ = window.Chart;
    if (!CJ || !canvasRef.current) return;
    chartRef.current?.destroy();
    chartRef.current = new CJ(canvasRef.current, { type, data, options });
    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div style={{ height, width: '100%', position: 'relative' }}><canvas ref={canvasRef} /></div>;
}

function makeDonutSVG(fuelMix, tv, size = 48) {
  const cx = size / 2, cy = size / 2, r = size / 2 - 9, sw = 7;
  const entries = Object.entries(fuelMix).filter(([, v]) => v > 0);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (total === 0) return '';
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
  const totalGW = total / 1000;
  const label = totalGW >= 1 ? totalGW.toFixed(1) : total.toFixed(0);
  const unit  = totalGW >= 1 ? 'GW' : 'MW';
  const bg = tv.isDark ? 'rgba(20,20,20,0.82)' : 'rgba(255,255,255,0.88)';
  const tc = tv.isDark ? '#fff' : '#111';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <circle cx="${cx}" cy="${cy}" r="${r + sw/2 + 1}" fill="${bg}" stroke="rgba(0,0,0,0.18)" stroke-width="0.5"/>
    ${arcs.join('')}
    <text x="${cx}" y="${cy - 1}" text-anchor="middle" font-size="8" font-weight="700" fill="${tc}" font-family="system-ui,sans-serif">${label}</text>
    <text x="${cx}" y="${cy + 8}" text-anchor="middle" font-size="6.5" fill="${tc}" font-family="system-ui,sans-serif" opacity="0.65">${unit}</text>
  </svg>`;
}

function fmt(n, d = 0) {
  if (n == null || isNaN(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: d });
}
function hexA(hex, a) {
  if (!hex || hex.length < 7) return `rgba(128,128,128,${a})`;
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}
function cjDefaults(t) {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { backgroundColor: t.panel, borderColor: t.panelBorder, borderWidth: 1,
        titleColor: t.lbl, bodyColor: t.muted, titleFont: { size: 9 }, bodyFont: { size: 9 }, padding: 6 },
    },
    scales: {
      x: { grid: { color: t.panelBorder }, ticks: { color: t.muted, font: { size: 8 } } },
      y: { grid: { color: t.panelBorder }, ticks: { color: t.muted, font: { size: 8 } } },
    },
  };
}
function SectionTitle({ t, children }) {
  return <div style={{ fontSize: '0.47rem', letterSpacing: '2px', fontWeight: 700,
    color: t.lblMuted, textTransform: 'uppercase', marginBottom: 6 }}>{children}</div>;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function EpmCountryPage() {
  const { regionId, countryName } = useParams();
  const countryNameDecoded = decodeURIComponent(countryName);
  const { theme } = useTheme();
  const t = getT(theme);
  const navigate = useNavigate();

  const containerRef    = useRef(null);
  const mapRef          = useRef(null);
  const donutMarkersRef = useRef([]);

  const [region,  setRegion]  = useState(null);
  const [epmData, setEpmData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');

  // Load region metadata
  useEffect(() => {
    fetch('/data/regions.json').then(r => r.json()).then(d => {
      const r = (d.regions || []).find(r => r.id === regionId);
      setRegion(r || null);
    });
  }, [regionId]);

  // Load EPM data
  useEffect(() => {
    setEpmData(null);
    if (!region?.epm) return;
    const { branch, dataFolder } = region.epm;
    setLoading(true);
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
        gen:           genRaw    ? processGenData(genRaw)           : [],
        demand:        demandRaw ? processDemand(demandRaw)         : [],
        ntc:           ntcRaw    ? processNTC(ntcRaw)               : [],
        zcmap:         zcmapRaw  || [],
        demandProfile: profileRaw ? processDemandProfile(profileRaw) : null,
        linestringGJ, zonesGJ, branch,
      });
    }).finally(() => setLoading(false));
  }, [region]);

  // Map
  useEffect(() => {
    if (!containerRef.current || !region || !epmData) return;
    const { linestringGJ, zonesGJ } = epmData;
    if (!linestringGJ && !zonesGJ) return;

    const zcmapRows = epmData.zcmap;
    const zoneToCountry = Object.fromEntries(zcmapRows.map(r => [r.z, r.c]));
    const countryZones  = zcmapRows.filter(r => r.c === countryNameDecoded).map(r => r.z);
    const countryIsos   = zonesGJ
      ? [...new Set(zonesGJ.features
          .filter(f => countryZones.includes(f.properties.z))
          .map(f => f.properties.ISO_A3))]
      : [];

    // Zone centroids from BOTH linestring endpoints
    const zoneCentroids = {};
    if (linestringGJ) {
      for (const f of linestringGJ.features) {
        const coords = f.geometry.coordinates;
        const z = f.properties.z, z2 = f.properties.z_other;
        if (z && !zoneCentroids[z]) zoneCentroids[z] = coords[0];
        if (z2 && !zoneCentroids[z2]) zoneCentroids[z2] = coords[coords.length - 1];
      }
    }

    // Fit bounds to this country's zones
    const countryCoords = countryZones.flatMap(z => {
      const c = zoneCentroids[z];
      return c ? [c] : [];
    });
    const lons = countryCoords.map(c => c[0]);
    const lats = countryCoords.map(c => c[1]);
    const bounds = lons.length
      ? [[Math.min(...lons) - 2, Math.min(...lats) - 2], [Math.max(...lons) + 2, Math.max(...lats) + 2]]
      : null;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: mapStyle(theme),
      center: [countryCoords.length ? lons.reduce((a, b) => a + b, 0) / lons.length : 20,
               countryCoords.length ? lats.reduce((a, b) => a + b, 0) / lats.length : 0],
      zoom: 4, minZoom: 1, maxZoom: 14, attributionControl: false,
    });
    mapRef.current = map;
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10,
      className: `popup-${theme}` });

    map.on('load', async () => {
      const tv = getT(theme);
      if (bounds) map.fitBounds(bounds, { padding: 60, duration: 0, maxZoom: 8 });

      // World base
      const countries = await fetch('/data/countries_110m.geojson').then(r => r.json());
      countries.features.forEach((f, i) => { f.id = i; });
      map.addSource('countries', { type: 'geojson', data: countries, generateId: false });
      map.addLayer({ id: 'land',    type: 'fill', source: 'countries',
        paint: { 'fill-color': tv.land, 'fill-opacity': 1 } });
      map.addLayer({ id: 'borders', type: 'line', source: 'countries',
        paint: { 'line-color': tv.worldBdr, 'line-width': tv.worldBdrW } });

      if (zonesGJ) {
        // All region ISOs from zonesGJ
        const regionIsos = [...new Set(zonesGJ.features.map(f => f.properties.ISO_A3))];
        const regionCountries = [...new Set(zcmapRows.map(r => r.c))].sort();
        const countryColorMap = {};
        regionCountries.forEach((c, i) => { countryColorMap[c] = ZONE_PALETTE[i % ZONE_PALETTE.length]; });
        const isoToCountry = {};
        for (const f of zonesGJ.features) isoToCountry[f.properties.ISO_A3] = f.properties.c;

        const fillExpr = ['match', ['get', 'ISO_A3'],
          ...regionIsos.flatMap(iso => [iso, countryColorMap[isoToCountry[iso]] || '#888']),
          'transparent',
        ];
        map.addSource('zones', { type: 'geojson', data: zonesGJ, generateId: true });

        // Dimmed fill for non-selected country zones
        map.addLayer({ id: 'zone-fill-dim', type: 'fill', source: 'zones',
          filter: ['!', ['in', ['get', 'ISO_A3'], ['literal', countryIsos]]],
          paint: { 'fill-color': fillExpr, 'fill-opacity': 0.08 } });
        map.addLayer({ id: 'zone-border-dim', type: 'line', source: 'zones',
          filter: ['!', ['in', ['get', 'ISO_A3'], ['literal', countryIsos]]],
          paint: { 'line-color': fillExpr, 'line-width': 0.6, 'line-opacity': 0.25 } });

        // Active country zones
        map.addLayer({ id: 'zone-fill', type: 'fill', source: 'zones',
          filter: ['in', ['get', 'ISO_A3'], ['literal', countryIsos]],
          paint: { 'fill-color': fillExpr, 'fill-opacity': 0.35 } });
        map.addLayer({ id: 'zone-hover', type: 'fill', source: 'zones',
          filter: ['==', ['get', 'z'], ''],
          paint: { 'fill-color': fillExpr, 'fill-opacity': 0.60 } });
        map.addLayer({ id: 'zone-border', type: 'line', source: 'zones',
          filter: ['in', ['get', 'ISO_A3'], ['literal', countryIsos]],
          paint: { 'line-color': fillExpr, 'line-width': 1.5, 'line-opacity': 0.9 } });

        let hovZ = null;
        map.on('mousemove', 'zone-fill', e => {
          map.getCanvas().style.cursor = 'pointer';
          const z = e.features[0].properties.z;
          if (z !== hovZ) { hovZ = z; map.setFilter('zone-hover', ['==', ['get', 'z'], z]); }
          popup.setLngLat(e.lngLat)
            .setHTML(`<b>${z}</b><br><span style="opacity:.65;font-size:0.7em">click to explore zone</span>`)
            .addTo(map);
        });
        map.on('mouseleave', 'zone-fill', () => {
          map.getCanvas().style.cursor = '';
          hovZ = null; map.setFilter('zone-hover', ['==', ['get', 'z'], '']); popup.remove();
        });
        map.on('click', 'zone-fill', e => {
          const z = e.features[0].properties.z;
          navigate(`/region/${regionId}/zone/${encodeURIComponent(z)}`);
        });
      }

      // NTC lines (all corridors, country corridors highlighted)
      if (linestringGJ) {
        const ntcYrs = availableYears(epmData.ntc);
        const ntcYr  = ntcYrs[0] || '2024';
        const seenPairs = new Set();
        const ntcFeatures = linestringGJ.features
          .filter(f => {
            const { z, z_other } = f.properties;
            if (!z || !z_other) return false;
            const key = [z, z_other].sort().join('||');
            if (seenPairs.has(key)) return false; seenPairs.add(key);
            const entry = epmData.ntc.find(r =>
              (r.z === z && r.z2 === z_other) || (r.z === z_other && r.z2 === z));
            return (entry?.years[ntcYr] || 0) > 0;
          })
          .map(f => {
            const { z, z_other } = f.properties;
            const entry = epmData.ntc.find(r =>
              (r.z === z && r.z2 === z_other) || (r.z === z_other && r.z2 === z));
            const isCountry = countryZones.includes(z) || countryZones.includes(z_other);
            return { ...f, properties: { ...f.properties, ntc_mw: entry?.years[ntcYr] || 0, isCountry } };
          });
        map.addSource('ntc-lines', { type: 'geojson',
          data: { type: 'FeatureCollection', features: ntcFeatures } });
        map.addLayer({ id: 'ntc-lines-bg', type: 'line', source: 'ntc-lines',
          paint: { 'line-color': '#f0b030', 'line-width': 0.8, 'line-opacity': 0.25 } });
        map.addLayer({ id: 'ntc-lines-active', type: 'line', source: 'ntc-lines',
          filter: ['==', ['get', 'isCountry'], true],
          layout: { 'line-cap': 'round' },
          paint: { 'line-color': '#f0b030',
            'line-width': ['interpolate', ['linear'], ['get', 'ntc_mw'], 0,1, 500,2, 2000,3.5, 8000,6],
            'line-opacity': 0.9 } });
        map.addLayer({ id: 'ntc-labels', type: 'symbol', source: 'ntc-lines',
          filter: ['==', ['get', 'isCountry'], true],
          layout: { 'text-field': ['concat', ['to-string', ['round', ['get', 'ntc_mw']]], ' MW'],
            'text-size': 8, 'symbol-placement': 'line-center', 'text-allow-overlap': false },
          paint: { 'text-color': '#b07800',
            'text-halo-color': 'rgba(255,255,255,0.9)', 'text-halo-width': 1.5 } });
      }

      // Zone donut markers for THIS country's zones
      const zoneGen = {};
      for (const r of epmData.gen.filter(g => g.status === 1 && countryZones.includes(g.zone))) {
        if (!zoneGen[r.zone]) zoneGen[r.zone] = {};
        zoneGen[r.zone][r.fuel] = (zoneGen[r.zone][r.fuel] || 0) + r.capacity;
      }
      donutMarkersRef.current.forEach(m => m.remove());
      donutMarkersRef.current = [];
      for (const z of countryZones) {
        const fuelMix = zoneGen[z];
        const coord = zoneCentroids[z];
        if (!fuelMix || !coord) continue;
        const el = document.createElement('div');
        el.style.cursor = 'pointer';
        el.innerHTML = makeDonutSVG(fuelMix, tv);
        el.addEventListener('click', () => navigate(`/region/${regionId}/zone/${encodeURIComponent(z)}`));
        const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat(coord).addTo(map);
        donutMarkersRef.current.push(marker);
      }
    });

    return () => {
      popup.remove();
      donutMarkersRef.current.forEach(m => m.remove());
      donutMarkersRef.current = [];
      mapRef.current?.remove();
    };
  }, [region, theme, epmData, countryNameDecoded]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Panel content ─────────────────────────────────────────────────────────

  const tabs = ['overview', 'supply', 'demand', 'about'];
  const hasData = !!(epmData && !loading);

  const zcmapRows = epmData?.zcmap || [];
  const countryZoneIds = zcmapRows.filter(r => r.c === countryNameDecoded).map(r => r.z);

  // Overview stats
  const countryGen    = (epmData?.gen || []).filter(r => countryZoneIds.includes(r.zone));
  const existingGen   = countryGen.filter(r => r.status === 1);
  const totalGW       = existingGen.reduce((s, r) => s + r.capacity, 0) / 1000;
  const allYears      = availableYears(epmData?.demand || []);
  const refYr         = allYears.find(y => y === '2024') || allYears[0];
  const countryDemand = (epmData?.demand || []).filter(r => countryZoneIds.includes(r.zone));
  const peakGW        = countryDemand.filter(r => r.type === 'peak')
    .reduce((s, r) => s + (r.years[refYr] || 0), 0) / 1000;
  const energyTWh     = countryDemand.filter(r => r.type === 'energy')
    .reduce((s, r) => s + (r.years[refYr] || 0), 0) / 1000;

  const fuelAgg = {};
  for (const r of existingGen) fuelAgg[r.fuel] = (fuelAgg[r.fuel] || 0) + r.capacity;
  const fuelData = Object.entries(fuelAgg).map(([fuel, mw]) => ({ fuel, mw: Math.round(mw) })).sort((a, b) => b.mw - a.mw);

  const zoneCapacity = {};
  for (const r of existingGen) zoneCapacity[r.zone] = (zoneCapacity[r.zone] || 0) + r.capacity;
  const zoneCapList = Object.entries(zoneCapacity).map(([z, mw]) => ({ z, mw })).sort((a, b) => b.mw - a.mw);

  if (!region) return <div style={{ padding: 40, color: t.text }}>Loading…</div>;

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 46px)' }}>
      {/* Map */}
      <div style={{ position: 'relative', flex: 1 }}>
        <div ref={containerRef} style={{ width: '100%', height: '100%', backgroundColor: t.bg }} />
        {/* Breadcrumb on map */}
        <div style={{ position: 'absolute', top: 10, left: 10, zIndex: 10, display: 'flex', gap: 4, alignItems: 'center',
          fontSize: '0.52rem', color: t.text, backgroundColor: t.panel,
          border: `1px solid ${t.panelBorder}`, borderRadius: 5, padding: '4px 10px',
          boxShadow: '0 1px 4px rgba(0,0,0,.18)' }}>
          <Link to="/" style={{ color: t.lblMuted, textDecoration: 'none' }}>World</Link>
          <span style={{ color: t.lblMuted }}>›</span>
          <Link to={`/region/${regionId}`} style={{ color: t.lblMuted, textDecoration: 'none' }}>{region.name}</Link>
          <span style={{ color: t.lblMuted }}>›</span>
          <span style={{ color: t.lbl, fontWeight: 600 }}>{countryNameDecoded}</span>
        </div>
      </div>

      {/* Right panel */}
      <div style={{ width: 520, flexShrink: 0, height: '100%', overflowY: 'auto',
        padding: '18px 16px', backgroundColor: t.panel,
        borderLeft: `1px solid ${t.panelBorder}` }}>

        {/* Header */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: '0.52rem', color: t.lblMuted, marginBottom: 2 }}>
            <Link to={`/region/${regionId}`} style={{ color: t.lblMuted, textDecoration: 'none' }}>
              ← {region.name}
            </Link>
          </div>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: t.lbl }}>{countryNameDecoded}</div>
          <div style={{ fontSize: '0.55rem', color: t.lblMuted, marginTop: 2 }}>
            {countryZoneIds.length} EPM zone{countryZoneIds.length !== 1 ? 's' : ''}
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 0, marginBottom: 16, borderBottom: `1px solid ${t.panelBorder}` }}>
          {tabs.map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)} style={{
              fontSize: '0.52rem', fontFamily: 'inherit', padding: '6px 14px',
              border: 'none', borderBottom: activeTab === tab ? `2px solid ${t.lbl}` : '2px solid transparent',
              backgroundColor: 'transparent', color: activeTab === tab ? t.lbl : t.lblMuted,
              cursor: 'pointer', fontWeight: activeTab === tab ? 600 : 400,
              textTransform: 'capitalize',
            }}>{tab}</button>
          ))}
        </div>

        {loading && <div style={{ padding: '24px 0', textAlign: 'center', color: t.lblMuted, fontSize: '0.6rem' }}>Loading EPM data…</div>}

        {hasData && activeTab === 'overview' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {/* KPIs */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              {[
                { label: 'Installed', value: `${totalGW.toFixed(1)} GW` },
                { label: `Peak ${refYr}`,   value: `${peakGW.toFixed(1)} GW` },
                { label: `Energy ${refYr}`, value: `${energyTWh.toFixed(0)} TWh` },
              ].map(({ label, value }) => (
                <div key={label} style={{ border: `1px solid ${t.panelBorder}`, borderRadius: 6, padding: '8px 10px' }}>
                  <div style={{ fontSize: '0.44rem', color: t.lblMuted, marginBottom: 2 }}>{label}</div>
                  <div style={{ fontSize: '0.8rem', fontWeight: 700, color: t.lbl }}>{value}</div>
                </div>
              ))}
            </div>

            {/* Capacity by fuel */}
            {fuelData.length > 0 && (
              <div>
                <SectionTitle t={t}>Capacity by fuel (MW)</SectionTitle>
                <CJChart type="bar" height={Math.min(fuelData.length * 22 + 24, 220)}
                  data={{
                    labels: fuelData.map(d => d.fuel),
                    datasets: [{ data: fuelData.map(d => d.mw),
                      backgroundColor: fuelData.map(d => EPM_FUEL_COLORS[d.fuel] || '#aaa'),
                      borderWidth: 0, barThickness: 12 }],
                  }}
                  options={{ ...cjDefaults(t), indexAxis: 'y',
                    scales: {
                      x: { grid: { color: t.panelBorder }, ticks: { color: t.muted, font: { size: 8 },
                        callback: v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v } },
                      y: { grid: { display: false }, ticks: { color: t.muted, font: { size: 8 } } },
                    } }}
                />
                {/* Fuel legend */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 10px', marginTop: 4 }}>
                  {fuelData.map(d => (
                    <div key={d.fuel} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: '0.44rem', color: t.muted }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: EPM_FUEL_COLORS[d.fuel] || '#aaa' }} />
                      {d.fuel} ({fmt(d.mw)} MW)
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Zones list */}
            {zoneCapList.length > 0 && (
              <div>
                <SectionTitle t={t}>Zones ({countryZoneIds.length})</SectionTitle>
                <div style={{ border: `1px solid ${t.panelBorder}`, borderRadius: 6, overflow: 'hidden' }}>
                  {countryZoneIds.map((z, i) => (
                    <div key={z}
                      onClick={() => navigate(`/region/${regionId}/zone/${encodeURIComponent(z)}`)}
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '6px 10px', borderBottom: i < countryZoneIds.length - 1 ? `1px solid ${t.panelBorder}` : 'none',
                        cursor: 'pointer', fontSize: '0.52rem',
                        backgroundColor: 'transparent', transition: 'background 0.12s' }}
                      onMouseEnter={e => e.currentTarget.style.backgroundColor = hexA('#1a5fa8', 0.06)}
                      onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}>
                      <span style={{ color: t.lbl, fontWeight: 500 }}>{z}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ color: t.muted }}>{fmt(zoneCapacity[z] || 0)} MW</span>
                        <span style={{ color: t.lblMuted, fontSize: '0.44rem' }}>›</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {hasData && activeTab === 'supply' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <SectionTitle t={t}>Plants in {countryNameDecoded}</SectionTitle>
            <div style={{ border: `1px solid ${t.panelBorder}`, borderRadius: 6, maxHeight: 400, overflowY: 'auto' }}>
              {countryGen.map(r => (
                <div key={`${r.g}-${r.zone}`} style={{
                  display: 'grid', gridTemplateColumns: '1fr 56px 46px 40px',
                  padding: '4px 8px', borderBottom: `1px solid ${t.panelBorder}`,
                  fontSize: '0.5rem', alignItems: 'center' }}>
                  <span style={{ color: t.lbl, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.g}</span>
                  <span style={{ color: t.muted, fontSize: '0.44rem' }}>{r.zone}</span>
                  <span>
                    <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 1, marginRight: 2,
                      backgroundColor: EPM_FUEL_COLORS[r.fuel] || '#aaa' }} />
                    <span style={{ color: t.muted, fontSize: '0.44rem' }}>{r.fuel}</span>
                  </span>
                  <span style={{ color: t.lbl, textAlign: 'right', fontWeight: 600 }}>{fmt(r.capacity)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {hasData && activeTab === 'demand' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <SectionTitle t={t}>Demand forecast</SectionTitle>
            {countryDemand.length > 0 ? (() => {
              const energyByYear = {};
              const peakByYear   = {};
              for (const r of countryDemand) {
                for (const y of allYears) {
                  if (r.type === 'energy') energyByYear[y] = (energyByYear[y] || 0) + (r.years[y] || 0);
                  if (r.type === 'peak')   peakByYear[y]   = (peakByYear[y]   || 0) + (r.years[y] || 0);
                }
              }
              return (
                <CJChart type="bar" height={180}
                  data={{
                    labels: allYears,
                    datasets: [
                      { type: 'bar',  label: 'Peak (GW)',    yAxisID: 'yL',
                        data: allYears.map(y => +((peakByYear[y] || 0) / 1000).toFixed(2)),
                        backgroundColor: hexA('#1a5fa8', 0.75), borderWidth: 0 },
                      { type: 'line', label: 'Energy (TWh)', yAxisID: 'yR',
                        data: allYears.map(y => +((energyByYear[y] || 0) / 1000).toFixed(1)),
                        borderColor: '#FF6B6B', borderWidth: 2.5, pointRadius: 0, tension: 0.3 },
                    ],
                  }}
                  options={{ ...cjDefaults(t),
                    scales: {
                      x:  { grid: { color: t.panelBorder }, ticks: { color: t.muted, font: { size: 8 }, maxTicksLimit: 7 } },
                      yL: { type: 'linear', position: 'left',
                        title: { display: true, text: 'GW',  color: t.muted, font: { size: 7 } },
                        grid: { color: t.panelBorder }, ticks: { color: t.muted, font: { size: 8 } } },
                      yR: { type: 'linear', position: 'right',
                        title: { display: true, text: 'TWh', color: t.muted, font: { size: 7 } },
                        grid: { drawOnChartArea: false }, ticks: { color: t.muted, font: { size: 8 } } },
                    } }}
                />
              );
            })() : <div style={{ color: t.lblMuted, fontSize: '0.58rem' }}>No demand data for this country.</div>}
          </div>
        )}

        {activeTab === 'about' && (
          <div style={{ fontSize: '0.58rem', color: t.muted, lineHeight: 1.7 }}>
            <div style={{ fontWeight: 700, color: t.lbl, marginBottom: 6 }}>{countryNameDecoded}</div>
            <div>Zones: {countryZoneIds.join(', ') || '—'}</div>
            <div style={{ marginTop: 4 }}>Part of <b style={{ color: t.lbl }}>{region.name}</b> EPM study</div>
            {region.epm && <div style={{ marginTop: 2 }}>Branch: <code style={{ fontSize: '0.52rem' }}>{region.epm.branch}</code></div>}
          </div>
        )}
      </div>
    </div>
  );
}
