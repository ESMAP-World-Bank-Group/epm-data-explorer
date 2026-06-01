import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import { useTheme } from '../App';
import { getT, mapStyle } from '../constants';
import {
  fetchEpmCSV, fetchLinestringGeoJSON, fetchZonesGeoJSON,
  processGenData, processDemand, processNTC, processDemandProfile,
  availableYears, EPM_FUEL_COLORS, STATUS_LABEL, computeCentroid,
} from '../utils/epmFetch';

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

const STATUS_COLOR = { 1: '#52C860', 2: '#FFD700', 3: '#9A9EF5' };

// ── Main component ────────────────────────────────────────────────────────────

export default function EpmZonePage() {
  const { regionId, zoneId } = useParams();
  const zoneIdDecoded = decodeURIComponent(zoneId);
  const { theme } = useTheme();
  const t = getT(theme);
  const navigate = useNavigate();

  const containerRef    = useRef(null);
  const mapRef          = useRef(null);
  const markerRef       = useRef(null);

  const [region,    setRegion]    = useState(null);
  const [epmData,   setEpmData]   = useState(null);
  const [loading,   setLoading]   = useState(false);
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
        linestringGJ, zonesGJ,
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
    const countryName   = zoneToCountry[zoneIdDecoded] || '';

    // Zone centroids — from polygon centroids when zonesGJ available, else from linestring endpoints
    const zoneCentroids = {};
    if (zonesGJ) {
      for (const f of zonesGJ.features) {
        const z = f.properties.z;
        if (z) { const c = computeCentroid(f.geometry); if (c) zoneCentroids[z] = c; }
      }
    } else if (linestringGJ) {
      for (const f of linestringGJ.features) {
        const coords = f.geometry.coordinates;
        const z = f.properties.z, z2 = f.properties.z_other;
        if (z && !zoneCentroids[z])   zoneCentroids[z]  = coords[0];
        if (z2 && !zoneCentroids[z2]) zoneCentroids[z2] = coords[coords.length - 1];
      }
    }

    const center = zoneCentroids[zoneIdDecoded] || [35, 39]; // fallback: Turkiye center

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: mapStyle(theme),
      center, zoom: 5, minZoom: 1, maxZoom: 14, attributionControl: false,
    });
    mapRef.current = map;
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10,
      className: `popup-${theme}` });

    map.on('load', async () => {
      const tv = getT(theme);

      // World base
      const countries = await fetch('/data/countries_110m.geojson').then(r => r.json());
      countries.features.forEach((f, i) => { f.id = i; });
      map.addSource('countries', { type: 'geojson', data: countries, generateId: false });
      map.addLayer({ id: 'land',    type: 'fill', source: 'countries',
        paint: { 'fill-color': tv.land, 'fill-opacity': 1 } });
      map.addLayer({ id: 'borders', type: 'line', source: 'countries',
        paint: { 'line-color': tv.worldBdr, 'line-width': tv.worldBdrW } });

      if (zonesGJ) {
        const regionCountries = [...new Set(zcmapRows.map(r => r.c))].sort();
        const ZONE_PALETTE = [
          '#1E9AF5','#FF6B6B','#52C860','#FFD700','#C8A8F0',
          '#FF8C42','#44DAEC','#E74C3C','#9B59B6','#2ECC71',
          '#F39C12','#1ABC9C','#E67E22','#8E44AD','#16A085','#D35400',
        ];
        const countryColorMap = {};
        regionCountries.forEach((c, i) => { countryColorMap[c] = ZONE_PALETTE[i % ZONE_PALETTE.length]; });
        const isoToCountry = {};
        for (const f of zonesGJ.features) isoToCountry[f.properties.ISO_A3] = f.properties.c;
        const regionIsos = [...new Set(zonesGJ.features.map(f => f.properties.ISO_A3))];

        const fillExpr = ['match', ['get', 'ISO_A3'],
          ...regionIsos.flatMap(iso => [iso, countryColorMap[isoToCountry[iso]] || '#888']),
          'transparent',
        ];

        map.addSource('zones', { type: 'geojson', data: zonesGJ, generateId: true });

        // Dimmed fill for non-selected zones
        map.addLayer({ id: 'zone-fill-dim', type: 'fill', source: 'zones',
          filter: ['!=', ['get', 'z'], zoneIdDecoded],
          paint: { 'fill-color': fillExpr, 'fill-opacity': 0.07 } });
        map.addLayer({ id: 'zone-border-dim', type: 'line', source: 'zones',
          filter: ['!=', ['get', 'z'], zoneIdDecoded],
          paint: { 'line-color': fillExpr, 'line-width': 0.6, 'line-opacity': 0.2 } });

        // Active zone
        map.addLayer({ id: 'zone-fill-active', type: 'fill', source: 'zones',
          filter: ['==', ['get', 'z'], zoneIdDecoded],
          paint: { 'fill-color': fillExpr, 'fill-opacity': 0.45 } });
        map.addLayer({ id: 'zone-border-active', type: 'line', source: 'zones',
          filter: ['==', ['get', 'z'], zoneIdDecoded],
          paint: { 'line-color': fillExpr, 'line-width': 2.5, 'line-opacity': 1 } });

        // Hover on other zones → navigate
        map.addLayer({ id: 'zone-hover', type: 'fill', source: 'zones',
          filter: ['==', ['get', 'z'], ''],
          paint: { 'fill-color': fillExpr, 'fill-opacity': 0.35 } });

        let hovZ = null;
        map.on('mousemove', 'zone-fill-dim', e => {
          map.getCanvas().style.cursor = 'pointer';
          const z = e.features[0].properties.z;
          if (z !== hovZ) { hovZ = z; map.setFilter('zone-hover', ['==', ['get', 'z'], z]); }
          const c = zoneToCountry[z] || '';
          popup.setLngLat(e.lngLat)
            .setHTML(`<b>${z}</b>${c ? `<br><span style="opacity:.65;font-size:0.7em">${c}</span>` : ''}`)
            .addTo(map);
        });
        map.on('mouseleave', 'zone-fill-dim', () => {
          map.getCanvas().style.cursor = '';
          hovZ = null; map.setFilter('zone-hover', ['==', ['get', 'z'], '']); popup.remove();
        });
        map.on('click', 'zone-fill-dim', e => {
          const z = e.features[0].properties.z;
          navigate(`/region/${regionId}/zone/${encodeURIComponent(z)}`);
        });
      }

      // NTC lines — highlight connections to this zone
      {
        const ntcYrs = availableYears(epmData.ntc);
        const ntcYr  = ntcYrs[0] || '2024';
        const seenPairs = new Set();
        let ntcFeatures = [];

        if (Object.keys(zoneCentroids).length > 0) {
          ntcFeatures = epmData.ntc
            .filter(r => {
              const key = [r.z, r.z2].sort().join('||');
              if (seenPairs.has(key)) return false; seenPairs.add(key);
              return (r.years[ntcYr] || 0) > 0 && zoneCentroids[r.z] && zoneCentroids[r.z2];
            })
            .map(r => {
              const isZone = r.z === zoneIdDecoded || r.z2 === zoneIdDecoded;
              return {
                type: 'Feature',
                properties: { z: r.z, z_other: r.z2, ntc_mw: r.years[ntcYr] || 0, isZone },
                geometry: { type: 'LineString', coordinates: [zoneCentroids[r.z], zoneCentroids[r.z2]] },
              };
            });
        } else if (linestringGJ) {
          ntcFeatures = linestringGJ.features
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
              const isZone = z === zoneIdDecoded || z_other === zoneIdDecoded;
              return { ...f, properties: { ...f.properties, ntc_mw: entry?.years[ntcYr] || 0, isZone } };
            });
        }

        if (ntcFeatures.length > 0) {
          map.addSource('ntc-lines', { type: 'geojson',
            data: { type: 'FeatureCollection', features: ntcFeatures } });
          map.addLayer({ id: 'ntc-lines-bg', type: 'line', source: 'ntc-lines',
            paint: { 'line-color': '#f0b030', 'line-width': 0.8, 'line-opacity': 0.2 } });
          map.addLayer({ id: 'ntc-lines-active', type: 'line', source: 'ntc-lines',
            filter: ['==', ['get', 'isZone'], true],
            layout: { 'line-cap': 'round' },
            paint: { 'line-color': '#f0b030',
              'line-width': ['interpolate', ['linear'], ['get', 'ntc_mw'], 0,1, 500,2, 2000,3.5, 8000,6],
              'line-opacity': 0.95 } });
          map.addLayer({ id: 'ntc-labels', type: 'symbol', source: 'ntc-lines',
            filter: ['==', ['get', 'isZone'], true],
            layout: { 'text-field': ['concat', ['to-string', ['round', ['get', 'ntc_mw']]], ' MW'],
              'text-size': 8, 'symbol-placement': 'line-center', 'text-allow-overlap': false },
            paint: { 'text-color': '#b07800',
              'text-halo-color': 'rgba(255,255,255,0.9)', 'text-halo-width': 1.5 } });
        }
      }

      // Zone name label marker
      if (zoneCentroids[zoneIdDecoded]) {
        const el = document.createElement('div');
        el.style.cssText = `
          font-size: 0.55rem; font-weight: 700; font-family: system-ui, sans-serif;
          color: ${tv.lbl}; background: ${tv.panel}; border: 1.5px solid ${tv.panelBorder};
          border-radius: 4px; padding: 2px 7px; white-space: nowrap; pointer-events: none;
          box-shadow: 0 1px 4px rgba(0,0,0,.22);
        `;
        el.textContent = zoneIdDecoded;
        markerRef.current = new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -4] })
          .setLngLat(zoneCentroids[zoneIdDecoded]).addTo(map);
      }
    });

    return () => {
      popup.remove();
      markerRef.current?.remove();
      markerRef.current = null;
      mapRef.current?.remove();
    };
  }, [region, theme, epmData, zoneIdDecoded]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Panel content ─────────────────────────────────────────────────────────

  const tabs = ['overview', 'supply', 'demand', 'connections'];
  const hasData = !!(epmData && !loading);

  const zcmapRows = epmData?.zcmap || [];
  const countryName = zcmapRows.find(r => r.z === zoneIdDecoded)?.c || '';

  const zoneGen       = (epmData?.gen || []).filter(r => r.zone === zoneIdDecoded);
  const existingGen   = zoneGen.filter(r => r.status === 1);
  const committedGen  = zoneGen.filter(r => r.status === 2);
  const candidateGen  = zoneGen.filter(r => r.status === 3);
  const totalMW       = existingGen.reduce((s, r) => s + r.capacity, 0);

  const allYears      = availableYears(epmData?.demand || []);
  const refYr         = allYears.find(y => y === '2024') || allYears[0];
  const zoneDemand    = (epmData?.demand || []).filter(r => r.zone === zoneIdDecoded);
  const peakMW        = zoneDemand.filter(r => r.type === 'peak')
    .reduce((s, r) => s + (r.years[refYr] || 0), 0);
  const energyGWh     = zoneDemand.filter(r => r.type === 'energy')
    .reduce((s, r) => s + (r.years[refYr] || 0), 0);

  // Fuel breakdown (existing)
  const fuelAgg = {};
  for (const r of existingGen) fuelAgg[r.fuel] = (fuelAgg[r.fuel] || 0) + r.capacity;
  const fuelData = Object.entries(fuelAgg).map(([fuel, mw]) => ({ fuel, mw: Math.round(mw) })).sort((a, b) => b.mw - a.mw);

  // NTC connections
  const ntcRows    = epmData?.ntc || [];
  const ntcYears   = availableYears(ntcRows);
  const ntcRefYr   = ntcYears.find(y => y === '2024') || ntcYears[0];
  const connections = ntcRows
    .filter(r => r.z === zoneIdDecoded || r.z2 === zoneIdDecoded)
    .map(r => {
      const neighbor = r.z === zoneIdDecoded ? r.z2 : r.z;
      const neighborCountry = zcmapRows.find(z => z.z === neighbor)?.c || '';
      return { neighbor, neighborCountry, mw: r.years[ntcRefYr] || 0 };
    })
    .sort((a, b) => b.mw - a.mw);

  if (!region) return <div style={{ padding: 40, color: t.text }}>Loading…</div>;

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 46px)' }}>
      {/* Map */}
      <div style={{ position: 'relative', flex: 1 }}>
        <div ref={containerRef} style={{ width: '100%', height: '100%', backgroundColor: t.bg }} />
        {/* Breadcrumb */}
        <div style={{ position: 'absolute', top: 10, left: 10, zIndex: 10, display: 'flex', gap: 4, alignItems: 'center',
          fontSize: '0.52rem', color: t.text, backgroundColor: t.panel,
          border: `1px solid ${t.panelBorder}`, borderRadius: 5, padding: '4px 10px',
          boxShadow: '0 1px 4px rgba(0,0,0,.18)' }}>
          <Link to="/" style={{ color: t.lblMuted, textDecoration: 'none' }}>World</Link>
          <span style={{ color: t.lblMuted }}>›</span>
          <Link to={`/region/${regionId}`} style={{ color: t.lblMuted, textDecoration: 'none' }}>{region.name}</Link>
          <span style={{ color: t.lblMuted }}>›</span>
          {countryName && (
            <>
              <Link to={`/region/${regionId}/country/${encodeURIComponent(countryName)}`}
                style={{ color: t.lblMuted, textDecoration: 'none' }}>{countryName}</Link>
              <span style={{ color: t.lblMuted }}>›</span>
            </>
          )}
          <span style={{ color: t.lbl, fontWeight: 600 }}>{zoneIdDecoded}</span>
        </div>
      </div>

      {/* Right panel */}
      <div style={{ width: 480, flexShrink: 0, height: '100%', overflowY: 'auto',
        padding: '18px 16px', backgroundColor: t.panel,
        borderLeft: `1px solid ${t.panelBorder}` }}>

        {/* Header */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: '0.52rem', color: t.lblMuted, marginBottom: 2 }}>
            {countryName && (
              <Link to={`/region/${regionId}/country/${encodeURIComponent(countryName)}`}
                style={{ color: t.lblMuted, textDecoration: 'none' }}>
                ← {countryName}
              </Link>
            )}
          </div>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: t.lbl }}>{zoneIdDecoded}</div>
          <div style={{ fontSize: '0.55rem', color: t.lblMuted, marginTop: 2 }}>
            EPM zone · {region.name}
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

        {/* ── Overview ─────────────────────────────────────────────────── */}
        {hasData && activeTab === 'overview' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {/* KPIs */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              {[
                { label: 'Installed', value: totalMW >= 1000 ? `${(totalMW/1000).toFixed(1)} GW` : `${fmt(totalMW)} MW` },
                { label: `Peak ${refYr || ''}`,   value: peakMW >= 1000 ? `${(peakMW/1000).toFixed(1)} GW` : `${fmt(peakMW)} MW` },
                { label: `Energy ${refYr || ''}`, value: energyGWh >= 1000 ? `${(energyGWh/1000).toFixed(1)} TWh` : `${fmt(energyGWh)} GWh` },
              ].map(({ label, value }) => (
                <div key={label} style={{ border: `1px solid ${t.panelBorder}`, borderRadius: 6, padding: '8px 10px' }}>
                  <div style={{ fontSize: '0.44rem', color: t.lblMuted, marginBottom: 2 }}>{label}</div>
                  <div style={{ fontSize: '0.8rem', fontWeight: 700, color: t.lbl }}>{value || '—'}</div>
                </div>
              ))}
            </div>

            {/* Status breakdown */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              {[
                { label: 'Existing',   rows: existingGen,  color: STATUS_COLOR[1] },
                { label: 'Committed',  rows: committedGen, color: STATUS_COLOR[2] },
                { label: 'Candidate',  rows: candidateGen, color: STATUS_COLOR[3] },
              ].map(({ label, rows, color }) => {
                const mw = rows.reduce((s, r) => s + r.capacity, 0);
                return (
                  <div key={label} style={{ border: `1px solid ${t.panelBorder}`, borderRadius: 6, padding: '8px 10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
                      <div style={{ width: 7, height: 7, borderRadius: 50, backgroundColor: color }} />
                      <div style={{ fontSize: '0.44rem', color: t.lblMuted }}>{label}</div>
                    </div>
                    <div style={{ fontSize: '0.72rem', fontWeight: 700, color: t.lbl }}>
                      {mw >= 1000 ? `${(mw/1000).toFixed(1)} GW` : `${fmt(mw)} MW`}
                    </div>
                    <div style={{ fontSize: '0.42rem', color: t.lblMuted, marginTop: 1 }}>{rows.length} units</div>
                  </div>
                );
              })}
            </div>

            {/* Capacity by fuel */}
            {fuelData.length > 0 && (
              <div>
                <SectionTitle t={t}>Existing capacity by fuel (MW)</SectionTitle>
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

            {zoneGen.length === 0 && (
              <div style={{ color: t.lblMuted, fontSize: '0.58rem' }}>No generation data for this zone.</div>
            )}
          </div>
        )}

        {/* ── Supply ─────────────────────────────────────────────────────── */}
        {hasData && activeTab === 'supply' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {[
              { status: 1, label: 'Existing',  rows: existingGen },
              { status: 2, label: 'Committed', rows: committedGen },
              { status: 3, label: 'Candidate', rows: candidateGen },
            ].filter(s => s.rows.length > 0).map(({ status, label, rows }) => (
              <div key={status}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 50, backgroundColor: STATUS_COLOR[status] }} />
                  <SectionTitle t={t}>{label} ({rows.length})</SectionTitle>
                </div>
                <div style={{ border: `1px solid ${t.panelBorder}`, borderRadius: 6, overflow: 'hidden' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 52px 46px',
                    padding: '3px 8px', backgroundColor: hexA(t.panelBorder, 0.5),
                    fontSize: '0.42rem', color: t.lblMuted, fontWeight: 600, letterSpacing: '0.5px' }}>
                    <span>Unit</span><span>Fuel</span><span style={{ textAlign: 'right' }}>MW</span>
                  </div>
                  {rows.map(r => (
                    <div key={`${r.g}-${r.status}`} style={{
                      display: 'grid', gridTemplateColumns: '1fr 52px 46px',
                      padding: '4px 8px', borderTop: `1px solid ${t.panelBorder}`,
                      fontSize: '0.5rem', alignItems: 'center' }}>
                      <span style={{ color: t.lbl, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.g}</span>
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
            ))}
            {zoneGen.length === 0 && (
              <div style={{ color: t.lblMuted, fontSize: '0.58rem' }}>No generation units for this zone.</div>
            )}
          </div>
        )}

        {/* ── Demand ─────────────────────────────────────────────────────── */}
        {hasData && activeTab === 'demand' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <SectionTitle t={t}>Demand forecast</SectionTitle>
            {zoneDemand.length > 0 ? (() => {
              const energyByYear = {};
              const peakByYear   = {};
              for (const r of zoneDemand) {
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
                      { type: 'bar',  label: 'Peak (MW)',   yAxisID: 'yL',
                        data: allYears.map(y => Math.round(peakByYear[y] || 0)),
                        backgroundColor: hexA('#1a5fa8', 0.75), borderWidth: 0 },
                      { type: 'line', label: 'Energy (GWh)', yAxisID: 'yR',
                        data: allYears.map(y => Math.round(energyByYear[y] || 0)),
                        borderColor: '#FF6B6B', borderWidth: 2.5, pointRadius: 0, tension: 0.3 },
                    ],
                  }}
                  options={{ ...cjDefaults(t),
                    scales: {
                      x:  { grid: { color: t.panelBorder }, ticks: { color: t.muted, font: { size: 8 }, maxTicksLimit: 7 } },
                      yL: { type: 'linear', position: 'left',
                        title: { display: true, text: 'MW',  color: t.muted, font: { size: 7 } },
                        grid: { color: t.panelBorder }, ticks: { color: t.muted, font: { size: 8 } } },
                      yR: { type: 'linear', position: 'right',
                        title: { display: true, text: 'GWh', color: t.muted, font: { size: 7 } },
                        grid: { drawOnChartArea: false }, ticks: { color: t.muted, font: { size: 8 } } },
                    } }}
                />
              );
            })() : <div style={{ color: t.lblMuted, fontSize: '0.58rem' }}>No demand data for this zone.</div>}
          </div>
        )}

        {/* ── Connections ─────────────────────────────────────────────────── */}
        {hasData && activeTab === 'connections' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <SectionTitle t={t}>NTC connections ({ntcRefYr || '—'})</SectionTitle>
            {connections.length > 0 ? (
              <div style={{ border: `1px solid ${t.panelBorder}`, borderRadius: 6, overflow: 'hidden' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 70px',
                  padding: '4px 10px', backgroundColor: hexA(t.panelBorder, 0.5),
                  fontSize: '0.42rem', color: t.lblMuted, fontWeight: 600, letterSpacing: '0.5px' }}>
                  <span>Neighbor zone</span><span>Country</span><span style={{ textAlign: 'right' }}>Avg MW</span>
                </div>
                {connections.map((c, i) => (
                  <div key={c.neighbor}
                    onClick={() => navigate(`/region/${regionId}/zone/${encodeURIComponent(c.neighbor)}`)}
                    style={{ display: 'grid', gridTemplateColumns: '1fr 80px 70px',
                      padding: '6px 10px', borderTop: `1px solid ${t.panelBorder}`,
                      fontSize: '0.52rem', alignItems: 'center', cursor: 'pointer',
                      transition: 'background 0.12s' }}
                    onMouseEnter={e => e.currentTarget.style.backgroundColor = hexA('#1a5fa8', 0.06)}
                    onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}>
                    <span style={{ color: t.lbl, fontWeight: 500 }}>{c.neighbor}</span>
                    <span style={{ color: t.muted, fontSize: '0.46rem' }}>{c.neighborCountry}</span>
                    <div style={{ textAlign: 'right' }}>
                      <span style={{ color: t.lbl, fontWeight: 600 }}>{fmt(c.mw)}</span>
                      <span style={{ color: t.lblMuted, fontSize: '0.44rem', marginLeft: 2 }}>MW</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ color: t.lblMuted, fontSize: '0.58rem' }}>No NTC data for this zone.</div>
            )}

            {connections.length > 0 && (
              <div style={{ marginTop: 4 }}>
                <CJChart type="bar" height={Math.min(connections.length * 22 + 30, 200)}
                  data={{
                    labels: connections.map(c => c.neighbor),
                    datasets: [{ data: connections.map(c => c.mw),
                      backgroundColor: hexA('#f0b030', 0.75), borderWidth: 0, barThickness: 12 }],
                  }}
                  options={{ ...cjDefaults(t), indexAxis: 'y',
                    scales: {
                      x: { grid: { color: t.panelBorder }, ticks: { color: t.muted, font: { size: 8 },
                        callback: v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v } },
                      y: { grid: { display: false }, ticks: { color: t.muted, font: { size: 8 } } },
                    } }}
                />
              </div>
            )}
          </div>
        )}

        {/* About footer */}
        <div style={{ marginTop: 24, paddingTop: 12, borderTop: `1px solid ${t.panelBorder}`,
          fontSize: '0.48rem', color: t.lblMuted }}>
          Zone <b style={{ color: t.lbl }}>{zoneIdDecoded}</b> · {countryName} · {region.name}
        </div>
      </div>
    </div>
  );
}
