import { useEffect, useRef, useState, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import { useTheme } from '../App';
import { getT, mapStyle } from '../constants';
import {
  fetchEpmCSV, fetchLinestringGeoJSON, fetchZonesGeoJSON,
  processGenData, processDemand, processNTC,
  processDemandProfileFull, processVREProfile, processAvailability, processFuelPrice, processHours,
  availableYears, EPM_FUEL_COLORS, computeCentroid, normalizeFuel,
} from '../utils/epmFetch';

// ── Constants ─────────────────────────────────────────────────────────────────

const ZONE_PALETTE = [
  '#1B6CA8','#36B5B5','#E8C547','#4DA6FF',
  '#0D7680','#85C1E9','#2E9EC8','#5EBCBA',
  '#1A5276','#A3D5FF','#14A094','#6BAED6',
  '#EDD770','#AED6F1','#1F618D','#0A6B70',
];
const STATUS_COLOR  = { 1: '#52C860', 2: '#FFD700', 3: '#9A9EF5' };
const STATUS_LABEL  = { 1: 'Existing', 2: 'Committed', 3: 'Candidate' };
const RE_FUELS      = new Set(['hydro','solar','wind','biomass','geothermal','biogas','waste']);
const VRE_DISPLAY  = { pv:'Solar PV', solar:'Solar PV', onshorewind:'Onshore Wind', wind:'Wind', offshorewind:'Offshore Wind', ror:'Run-of-River', rof:'Run-of-River' };
const VRE_COLOR    = { pv:'#FFD700', solar:'#FFD700', onshorewind:'#44DAEC', wind:'#44DAEC', offshorewind:'#7CC8FA', ror:'#1E9AF5', rof:'#1E9AF5' };

// ── Helpers ───────────────────────────────────────────────────────────────────

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
function sumObj(obj) { return Object.values(obj || {}).reduce((s, v) => s + v, 0); }
function avgProfile(profiles) {
  if (!profiles.length) return null;
  return Array.from({ length: 24 }, (_, i) => profiles.reduce((s, p) => s + (p[i] || 0), 0) / profiles.length);
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

// ── Sub-components ────────────────────────────────────────────────────────────

function CJChart({ type, data, options, height }) {
  const canvasRef = useRef(null);
  const chartRef  = useRef(null);
  const sig = JSON.stringify({ type, labels: data.labels,
    ds: data.datasets?.map(d => ({ l: d.label, n: d.data?.length, t: d.type, h: d.hidden })) });
  useEffect(() => {
    const CJ = window.Chart;
    if (!CJ || !canvasRef.current) return;
    chartRef.current?.destroy();
    chartRef.current = new CJ(canvasRef.current, { type, data, options });
    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div style={{ height, width: '100%', position: 'relative' }}><canvas ref={canvasRef} /></div>;
}

function SectionTitle({ t, children, right }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
      <div style={{ fontSize: '0.47rem', letterSpacing: '2px', fontWeight: 700,
        color: t.lblMuted, textTransform: 'uppercase' }}>{children}</div>
      {right}
    </div>
  );
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

  // ── Core state ──────────────────────────────────────────────────────────────
  const [region,  setRegion]  = useState(null);
  const [epmData, setEpmData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');

  // ── Overview state ──────────────────────────────────────────────────────────
  const [mixView, setMixView] = useState('zone'); // 'zone' | 'country'

  // ── Demand state ────────────────────────────────────────────────────────────
  const [demandSeg,         setDemandSeg]         = useState('aggregate');
  const [demandProfileMode, setDemandProfileMode] = useState('full');
  const [demandSeason,      setDemandSeason]      = useState('Q1');
  const [demandDay,         setDemandDay]         = useState('avg');
  const [demandHidden,      setDemandHidden]      = useState(new Set());

  // ── Supply state ────────────────────────────────────────────────────────────
  const [statusFilter,  setStatusFilter]  = useState(new Set([1]));
  const [zoneFilter,    setZoneFilter]    = useState('all');
  const [supplySort,    setSupplySort]    = useState({ col: 'capacity', dir: 'desc' });
  const [selectedPlant, setSelectedPlant] = useState(null);

  // ── Resources state ─────────────────────────────────────────────────────────
  const [resSection,    setResSection]    = useState('vre');
  const [vreTech,       setVreTech]       = useState('');
  const [vreProfileMode, setVreProfileMode] = useState('full');
  const [vreSeason,     setVreSeason]     = useState('Q1');
  const [vreDay,        setVreDay]        = useState('avg');
  const [vreHidden,     setVreHidden]     = useState(new Set());
  const [fpCountries,   setFpCountries]   = useState(null); // null = all
  const [availZone,     setAvailZone]     = useState('all');

  // ── Load region ─────────────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/data/regions.json').then(r => r.json()).then(d => {
      const r = (d.regions || []).find(r => r.id === regionId);
      setRegion(r || null);
    });
  }, [regionId]);

  // ── Load EPM data ────────────────────────────────────────────────────────────
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
      fetchEpmCSV(branch, dataFolder, 'supply/pVREProfile.csv'),
      fetchEpmCSV(branch, dataFolder, 'supply/pAvailabilityDefault.csv'),
      fetchEpmCSV(branch, dataFolder, 'supply/pFuelPrice.csv'),
      fetchEpmCSV(branch, dataFolder, 'pHours.csv'),
    ]).then(([genRaw, demandRaw, ntcRaw, zcmapRaw, linestringGJ, profileRaw, zonesGJ, vreRaw, availRaw, fpRaw, hoursRaw]) => {
      setEpmData({
        gen:              genRaw     ? processGenData(genRaw)              : [],
        demand:           demandRaw  ? processDemand(demandRaw)            : [],
        ntc:              ntcRaw     ? processNTC(ntcRaw)                  : [],
        zcmap:            zcmapRaw   || [],
        demandProfileFull: profileRaw ? processDemandProfileFull(profileRaw) : {},
        vreProfile:        vreRaw    ? processVREProfile(vreRaw)           : {},
        availability:      availRaw  ? processAvailability(availRaw)       : {},
        fuelPrice:         fpRaw     ? processFuelPrice(fpRaw)             : {},
        hours:             hoursRaw  ? processHours(hoursRaw)              : {},
        linestringGJ, zonesGJ, branch,
      });
    }).finally(() => setLoading(false));
  }, [region]);

  // ── Map ──────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || !region || !epmData) return;
    const { linestringGJ, zonesGJ } = epmData;
    if (!linestringGJ && !zonesGJ) return;

    const zcmapRows     = epmData.zcmap;
    const zoneToCountry = Object.fromEntries(zcmapRows.map(r => [r.z, r.c]));
    const countryZones  = zcmapRows.filter(r => r.c === countryNameDecoded).map(r => r.z);
    const countryIsos   = zonesGJ
      ? [...new Set(zonesGJ.features
          .filter(f => countryZones.includes(f.properties.z))
          .map(f => f.properties.ISO_A3))]
      : [];

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
        if (z  && !zoneCentroids[z])  zoneCentroids[z]  = coords[0];
        if (z2 && !zoneCentroids[z2]) zoneCentroids[z2] = coords[coords.length - 1];
      }
    }

    const countryCoords = countryZones.flatMap(z => zoneCentroids[z] ? [zoneCentroids[z]] : []);
    const lons = countryCoords.map(c => c[0]);
    const lats = countryCoords.map(c => c[1]);
    const bounds = lons.length
      ? [[Math.min(...lons) - 2, Math.min(...lats) - 2], [Math.max(...lons) + 2, Math.max(...lats) + 2]]
      : null;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: mapStyle(theme),
      center: [lons.length ? lons.reduce((a,b)=>a+b,0)/lons.length : 20,
               lats.length ? lats.reduce((a,b)=>a+b,0)/lats.length : 0],
      zoom: 4, minZoom: 1, maxZoom: 14, attributionControl: false,
    });
    mapRef.current = map;
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10,
      className: `popup-${theme}` });

    map.on('load', async () => {
      const tv = getT(theme);
      if (bounds) map.fitBounds(bounds, { padding: 60, duration: 0, maxZoom: 8 });

      const countries = await fetch('/data/countries_110m.geojson').then(r => r.json());
      countries.features.forEach((f, i) => { f.id = i; });
      map.addSource('countries', { type: 'geojson', data: countries, generateId: false });
      map.addLayer({ id: 'land',    type: 'fill', source: 'countries', paint: { 'fill-color': tv.land, 'fill-opacity': 1 } });
      map.addLayer({ id: 'borders', type: 'line', source: 'countries', paint: { 'line-color': tv.worldBdr, 'line-width': tv.worldBdrW } });

      if (zonesGJ) {
        const regionCountries = [...new Set(zcmapRows.map(r => r.c))].sort();
        const countryColorMap = {};
        regionCountries.forEach((c, i) => { countryColorMap[c] = ZONE_PALETTE[i % ZONE_PALETTE.length]; });
        const isoToCountry = {};
        for (const f of zonesGJ.features) isoToCountry[f.properties.ISO_A3] = f.properties.c;
        const regionIsos = [...new Set(zonesGJ.features.map(f => f.properties.ISO_A3))];
        const fillExpr = ['match', ['get', 'ISO_A3'],
          ...regionIsos.flatMap(iso => [iso, countryColorMap[isoToCountry[iso]] || '#888']), 'transparent'];

        map.addSource('zones', { type: 'geojson', data: zonesGJ, generateId: true });
        map.addLayer({ id: 'zone-fill-dim', type: 'fill', source: 'zones',
          filter: ['!', ['in', ['get', 'ISO_A3'], ['literal', countryIsos]]],
          paint: { 'fill-color': fillExpr, 'fill-opacity': 0.08 } });
        map.addLayer({ id: 'zone-border-dim', type: 'line', source: 'zones',
          filter: ['!', ['in', ['get', 'ISO_A3'], ['literal', countryIsos]]],
          paint: { 'line-color': fillExpr, 'line-width': 0.6, 'line-opacity': 0.25 } });
        map.addLayer({ id: 'zone-fill', type: 'fill', source: 'zones',
          filter: ['in', ['get', 'ISO_A3'], ['literal', countryIsos]],
          paint: { 'fill-color': fillExpr, 'fill-opacity': 0.35 } });
        map.addLayer({ id: 'zone-hover', type: 'fill', source: 'zones',
          filter: ['==', ['get', 'z'], ''], paint: { 'fill-color': fillExpr, 'fill-opacity': 0.60 } });
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
        map.on('click', 'zone-fill', e => navigate(`/region/${regionId}/zone/${encodeURIComponent(e.features[0].properties.z)}`));
      }

      if (Object.keys(zoneCentroids).length > 0 || linestringGJ) {
        const ntcYrs = availableYears(epmData.ntc);
        const ntcYr  = ntcYrs[0] || '2024';
        const seenPairs = new Set();
        let ntcFeatures = [];
        if (Object.keys(zoneCentroids).length > 0) {
          ntcFeatures = epmData.ntc
            .filter(r => { const key = [r.z,r.z2].sort().join('||'); if(seenPairs.has(key))return false; seenPairs.add(key);
              return (r.years[ntcYr]||0)>0 && zoneCentroids[r.z] && zoneCentroids[r.z2]; })
            .map(r => ({ type:'Feature',
              properties:{ z:r.z, z_other:r.z2, ntc_mw:r.years[ntcYr]||0, isCountry: countryZones.includes(r.z)||countryZones.includes(r.z2) },
              geometry:{ type:'LineString', coordinates:[zoneCentroids[r.z], zoneCentroids[r.z2]] } }));
        } else if (linestringGJ) {
          ntcFeatures = linestringGJ.features
            .filter(f => { const {z,z_other}=f.properties; if(!z||!z_other)return false;
              const key=[z,z_other].sort().join('||'); if(seenPairs.has(key))return false; seenPairs.add(key);
              const entry=epmData.ntc.find(r=>(r.z===z&&r.z2===z_other)||(r.z===z_other&&r.z2===z));
              return (entry?.years[ntcYr]||0)>0; })
            .map(f => { const {z,z_other}=f.properties;
              const entry=epmData.ntc.find(r=>(r.z===z&&r.z2===z_other)||(r.z===z_other&&r.z2===z));
              return {...f, properties:{...f.properties, ntc_mw:entry?.years[ntcYr]||0,
                isCountry:countryZones.includes(z)||countryZones.includes(z_other)}}; });
        }
        if (ntcFeatures.length > 0) {
          map.addSource('ntc-lines', { type:'geojson', data:{type:'FeatureCollection',features:ntcFeatures} });
          map.addLayer({ id:'ntc-lines-bg', type:'line', source:'ntc-lines',
            paint:{'line-color':'#f0b030','line-width':0.8,'line-opacity':0.25} });
          map.addLayer({ id:'ntc-lines-active', type:'line', source:'ntc-lines',
            filter:['==',['get','isCountry'],true], layout:{'line-cap':'round'},
            paint:{'line-color':'#f0b030',
              'line-width':['interpolate',['linear'],['get','ntc_mw'],0,1,500,2,2000,3.5,8000,6],'line-opacity':0.9} });
          map.addLayer({ id:'ntc-labels', type:'symbol', source:'ntc-lines',
            filter:['==',['get','isCountry'],true],
            layout:{'text-field':['concat',['to-string',['round',['get','ntc_mw']]],' MW'],
              'text-size':8,'symbol-placement':'line-center','text-allow-overlap':false},
            paint:{'text-color':'#b07800','text-halo-color':'rgba(255,255,255,0.9)','text-halo-width':1.5} });
        }
      }

      const zoneGen = {};
      for (const r of epmData.gen.filter(g => g.status===1 && countryZones.includes(g.zone))) {
        if (!zoneGen[r.zone]) zoneGen[r.zone] = {};
        zoneGen[r.zone][r.fuel] = (zoneGen[r.zone][r.fuel] || 0) + r.capacity;
      }
      donutMarkersRef.current.forEach(m => m.remove());
      donutMarkersRef.current = [];
      for (const z of countryZones) {
        const fuelMix = zoneGen[z]; const coord = zoneCentroids[z];
        if (!fuelMix || !coord) continue;
        const el = document.createElement('div');
        el.style.cursor = 'pointer';
        el.innerHTML = makeDonutSVG(fuelMix, tv);
        el.addEventListener('click', () => navigate(`/region/${regionId}/zone/${encodeURIComponent(z)}`));
        donutMarkersRef.current.push(new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(coord).addTo(map));
      }
    });

    return () => {
      popup.remove();
      donutMarkersRef.current.forEach(m => m.remove());
      donutMarkersRef.current = [];
      mapRef.current?.remove();
    };
  }, [region, theme, epmData, countryNameDecoded]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Computed values ───────────────────────────────────────────────────────────

  const zcmapRows      = epmData?.zcmap || [];
  const zoneToCountry  = useMemo(() => Object.fromEntries(zcmapRows.map(r => [r.z, r.c])), [zcmapRows]);
  const countryZoneIds = useMemo(() => zcmapRows.filter(r => r.c === countryNameDecoded).map(r => r.z), [zcmapRows, countryNameDecoded]);
  const allCountries   = useMemo(() => [...new Set(zcmapRows.map(r => r.c))].sort(), [zcmapRows]);

  const allGen        = epmData?.gen || [];
  const countryGen    = useMemo(() => allGen.filter(r => countryZoneIds.includes(r.zone)), [allGen, countryZoneIds]);
  const existingGen   = useMemo(() => countryGen.filter(r => r.status === 1), [countryGen]);
  const allExisting   = useMemo(() => allGen.filter(r => r.status === 1), [allGen]);

  const totalGW   = existingGen.reduce((s,r)=>s+r.capacity,0) / 1000;
  const reMW      = existingGen.filter(r=>RE_FUELS.has(r.fuel)).reduce((s,r)=>s+r.capacity,0);
  const reShare   = totalGW > 0 ? Math.round(reMW / (totalGW * 1000) * 100) : 0;

  const allYears  = availableYears(epmData?.demand || []);
  const refYr     = allYears.find(y => y === '2024') || allYears[0];

  const countryDemand = useMemo(() => (epmData?.demand||[]).filter(r=>countryZoneIds.includes(r.zone)), [epmData, countryZoneIds]);
  const peakGW        = countryDemand.filter(r=>r.type==='peak').reduce((s,r)=>s+(r.years[refYr]||0),0)/1000;
  const energyTWh     = countryDemand.filter(r=>r.type==='energy').reduce((s,r)=>s+(r.years[refYr]||0),0)/1000;

  const ntcAll = epmData?.ntc || [];
  const { txGW, nCorridors, uniqueNTC } = useMemo(() => {
    const seen = new Set(); const result = [];
    for (const r of ntcAll) {
      const key = [r.z,r.z2].sort().join('||');
      if (!seen.has(key)) { seen.add(key); result.push(r); }
    }
    const countryCorr = result.filter(r=>countryZoneIds.includes(r.z)||countryZoneIds.includes(r.z2));
    const tx = countryCorr.reduce((s,r)=>s+(r.years[refYr]||0),0)/1000;
    return { txGW: tx, nCorridors: countryCorr.length, uniqueNTC: result };
  }, [ntcAll, countryZoneIds, refYr]);

  // Mix chart data
  const { genByZoneFuel, genByCountryFuel } = useMemo(() => {
    const byZone = {}, byCountry = {};
    for (const r of allExisting) {
      if (!byZone[r.zone]) byZone[r.zone] = {};
      byZone[r.zone][r.fuel] = (byZone[r.zone][r.fuel]||0) + r.capacity;
      const c = zoneToCountry[r.zone] || 'Other';
      if (!byCountry[c]) byCountry[c] = {};
      byCountry[c][r.fuel] = (byCountry[c][r.fuel]||0) + r.capacity;
    }
    return { genByZoneFuel: byZone, genByCountryFuel: byCountry };
  }, [allExisting, zoneToCountry]);

  const FUEL_ORDER = ['hydro','solar','wind','nuclear','gas','coal','oil','biomass','geothermal','diesel','waste','biogas','other'];
  const sortedFuels = useMemo(() => {
    const fuels = new Set([...Object.values(genByZoneFuel).flatMap(Object.keys), ...Object.values(genByCountryFuel).flatMap(Object.keys)]);
    return [...fuels].sort((a,b)=>FUEL_ORDER.indexOf(a)-FUEL_ORDER.indexOf(b));
  }, [genByZoneFuel, genByCountryFuel]); // eslint-disable-line react-hooks/exhaustive-deps

  const fuelAgg = useMemo(() => genByCountryFuel[countryNameDecoded] || {}, [genByCountryFuel, countryNameDecoded]);

  // Supply filtered + sorted
  const demandZones = useMemo(() => [...new Set(countryDemand.map(r=>r.zone))].sort(), [countryDemand]);
  const zoneColors  = useMemo(() => Object.fromEntries(demandZones.map((z,i)=>[z,ZONE_PALETTE[i%ZONE_PALETTE.length]])), [demandZones]);

  const filteredPlants = useMemo(() => countryGen.filter(r=>statusFilter.has(r.status) && (zoneFilter==='all'||r.zone===zoneFilter)), [countryGen, statusFilter, zoneFilter]);
  const sortedPlants   = useMemo(() => {
    const { col, dir } = supplySort;
    return [...filteredPlants].sort((a,b) => {
      let va = a[col], vb = b[col];
      if (typeof va === 'string') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return dir === 'asc' ? cmp : -cmp;
    });
  }, [filteredPlants, supplySort]);

  // Trade corridors — deduplicated, must stay before early return
  const tradeCorridors = useMemo(() => {
    const seen = new Set();
    return ntcAll.reduce((acc, r) => {
      const key = [r.z,r.z2].sort().join('||');
      if (seen.has(key)) return acc; seen.add(key);
      const rev = ntcAll.find(x=>x.z===r.z2&&x.z2===r.z);
      acc.push({
        key, z:r.z, z2:r.z2,
        c: zoneToCountry[r.z]||r.z, c2: zoneToCountry[r.z2]||r.z2,
        mwFwd: r.years[refYr]||0, mwRev: rev ? (rev.years[refYr]||0) : 0,
        isCountry: countryZoneIds.includes(r.z)||countryZoneIds.includes(r.z2),
      });
      return acc;
    }, []).sort((a,b)=>b.mwFwd-a.mwFwd);
  }, [ntcAll, zoneToCountry, countryZoneIds, refYr]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasData = !!(epmData && !loading);
  if (!region) return <div style={{ padding: 40, color: t.text }}>Loading…</div>;

  // ── Helpers ──────────────────────────────────────────────────────────────────

  const Pill = ({ active, onClick, children, color }) => (
    <button onClick={onClick} style={{
      fontSize: '0.44rem', fontFamily: 'inherit', padding: '3px 8px',
      border: `1px solid ${active ? (color||'rgba(74,143,204,0.65)') : t.panelBorder}`,
      borderRadius: 3, cursor: 'pointer',
      backgroundColor: active ? (color ? hexA(color,0.15) : 'rgba(74,143,204,0.12)') : 'transparent',
      color: active ? (color||t.lbl) : t.lblMuted, fontWeight: active ? 600 : 400,
    }}>{children}</button>
  );

  const handleSort = col => setSupplySort(s => ({
    col, dir: s.col === col && s.dir === 'desc' ? 'asc' : 'desc'
  }));

  const SortBtn = ({ col, label, align }) => (
    <button onClick={() => handleSort(col)} style={{ background:'none', border:'none', cursor:'pointer', padding:0, textAlign: align||'left',
      fontSize:'0.42rem', color: supplySort.col===col ? t.lbl : t.lblMuted, fontWeight: supplySort.col===col ? 700 : 400 }}>
      {label}{supplySort.col===col ? (supplySort.dir==='desc' ? ' ↓' : ' ↑') : ''}
    </button>
  );

  const toggleDemandHidden = z => setDemandHidden(s => { const n=new Set(s); n.has(z)?n.delete(z):n.add(z); return n; });
  const toggleVreHidden    = z => setVreHidden(s => { const n=new Set(s); n.has(z)?n.delete(z):n.add(z); return n; });
  const toggleStatus       = s => { setStatusFilter(f=>{ const n=new Set(f); n.has(s)?n.delete(s):n.add(s); return n; }); setSelectedPlant(null); };

  // ── Profile helper ────────────────────────────────────────────────────────────
  const getProfile = (profileData, zone, season, day) => {
    const sp = profileData[zone]?.[season];
    if (!sp) return null;
    if (day === 'avg') {
      const days = Object.keys(sp);
      return days.length ? avgProfile(days.map(d => sp[d])) : null;
    }
    return sp[day] || null;
  };

  // ── Mix chart builder ─────────────────────────────────────────────────────────
  const buildMixChart = (labels, dataByGroup) => {
    const presentFuels = sortedFuels.filter(f => labels.some(l => (dataByGroup[l]?.[f]||0)>0));
    return {
      labels,
      datasets: presentFuels.map(fuel => ({
        label: fuel,
        data: labels.map(l => Math.round(dataByGroup[l]?.[fuel]||0)),
        backgroundColor: EPM_FUEL_COLORS[fuel] || '#aaa',
        stack: 'total',
      })),
    };
  };

  // ── Computed profile metadata ─────────────────────────────────────────────────
  const pf           = epmData?.demandProfileFull || {};
  const hoursData    = epmData?.hours || {};
  const vp           = epmData?.vreProfile || {};
  const firstZoneWithPf  = countryZoneIds.find(z => pf[z]);
  const availSeasons     = firstZoneWithPf ? Object.keys(pf[firstZoneWithPf]).sort() : [];
  const availDaytypes    = firstZoneWithPf && availSeasons[0] ? Object.keys(pf[firstZoneWithPf][availSeasons[0]]||{}).sort() : [];
  const totalDaysPf      = Object.values(hoursData).reduce((s,dts)=>s+Object.values(dts||{}).reduce((a,b)=>a+b,0),0) || 365;
  const allVreTechs      = [...new Set(countryZoneIds.flatMap(z=>Object.keys(vp[z]||{})))].sort();
  const activeVreTech    = allVreTechs.includes(vreTech) ? vreTech : (allVreTechs[0]||'');
  const firstZoneWithVre = countryZoneIds.find(z=>vp[z]?.[activeVreTech]);
  const vreAvailSeasons  = firstZoneWithVre ? Object.keys(vp[firstZoneWithVre][activeVreTech]).sort() : [];
  const vreAvailDaytypes = firstZoneWithVre && vreAvailSeasons[0] ? Object.keys(vp[firstZoneWithVre][activeVreTech][vreAvailSeasons[0]]||{}).sort() : [];

  // ── Demand forecast builder ───────────────────────────────────────────────────
  const buildForecastData = () => {
    if (demandSeg === 'aggregate') {
      const eby = {}, pby = {};
      for (const r of countryDemand) for (const y of allYears) {
        if (r.type==='energy') eby[y]=(eby[y]||0)+(r.years[y]||0);
        if (r.type==='peak')   pby[y]=(pby[y]||0)+(r.years[y]||0);
      }
      return { labels: allYears, datasets: [
        { type:'bar',  label:'Energy (GWh)', yAxisID:'yL',
          data: allYears.map(y=>Math.round(eby[y]||0)),
          backgroundColor: hexA('#1a5fa8',0.72), borderWidth:0 },
        { type:'line', label:'Peak (GW)', yAxisID:'yR',
          data: allYears.map(y=>+((pby[y]||0)/1000).toFixed(2)),
          borderColor:'#9B59B6', borderWidth:2.5, pointRadius:2, tension:0.3, fill:false },
      ]};
    }
    const ebyZone = {}, pby = {};
    for (const r of countryDemand) for (const y of allYears) {
      if (r.type==='energy') { if(!ebyZone[r.zone]) ebyZone[r.zone]={}; ebyZone[r.zone][y]=(ebyZone[r.zone][y]||0)+(r.years[y]||0); }
      if (r.type==='peak') pby[y]=(pby[y]||0)+(r.years[y]||0);
    }
    // Stable colors: use demandZones index, skip hidden
    return { labels: allYears, datasets: [
      ...demandZones.flatMap((z,i) => {
        if (demandHidden.has(z)) return [];
        return [{ type:'bar', label:z, yAxisID:'yL',
          data: allYears.map(y=>Math.round(ebyZone[z]?.[y]||0)),
          backgroundColor: ZONE_PALETTE[i%ZONE_PALETTE.length], borderWidth:0, stack:'energy' }];
      }),
      { type:'line', label:'Peak (GW)', yAxisID:'yR',
        data: allYears.map(y=>+((pby[y]||0)/1000).toFixed(2)),
        borderColor:'#9B59B6', borderWidth:2.5, pointRadius:2, tension:0.3, fill:false },
    ]};
  };

  // ── Profile builder (Full Year + single season) ───────────────────────────────
  const buildProfileData = () => {
    const isDark   = t.isDark;
    const showAvg  = !demandHidden.has('__avg__');

    if (demandProfileMode === 'full') {
      if (!firstZoneWithPf || !availDaytypes.length) return { chartData:{ labels:[], datasets:[] }, plugin:null };
      const nDT = availDaytypes.length, nS = availSeasons.length;
      const nPts = nS * nDT * 24;
      const zoneDs = countryZoneIds.flatMap((z,i) => {
        if (demandHidden.has(z)) return [];
        const data = [];
        for (const s of availSeasons) for (const d of availDaytypes) {
          const p = pf[z]?.[s]?.[d];
          data.push(...(p ? p : new Array(24).fill(null)));
        }
        if (!data.some(v=>v!==null)) return [];
        return [{ label:z, data, borderColor:ZONE_PALETTE[i%ZONE_PALETTE.length], borderWidth:1.5, pointRadius:0, tension:0.3, fill:false, spanGaps:true }];
      });
      const avgData = [];
      for (const s of availSeasons) for (const d of availDaytypes) {
        const profs = countryZoneIds.map(z=>pf[z]?.[s]?.[d]).filter(Boolean);
        for (let h=0;h<24;h++) avgData.push(profs.length?profs.reduce((sum,p)=>sum+(p[h]||0),0)/profs.length:null);
      }
      const avgDs = showAvg ? { label:'avg', data:avgData, borderColor:'#1a5fa8', borderWidth:2.5, pointRadius:0, tension:0.3, fill:false, spanGaps:true } : null;
      const separatorPlugin = {
        id:'profSepC',
        afterDraw:(chart)=>{
          const {ctx,chartArea,scales}=chart; if(!chartArea||!scales.x) return;
          const {top,bottom}=chartArea; const xS=scales.x;
          const dashC=isDark?'rgba(255,255,255,0.13)':'rgba(0,0,0,0.12)';
          const solidC=isDark?'rgba(255,255,255,0.36)':'rgba(0,0,0,0.30)';
          const textC=isDark?'rgba(255,255,255,0.46)':'rgba(0,0,0,0.40)';
          const seasC=isDark?'rgba(255,255,255,0.70)':'rgba(0,0,0,0.58)';
          for(let si=0;si<nS;si++){
            const ss=si*nDT*24;
            ctx.save();ctx.font='700 9px system-ui,sans-serif';ctx.fillStyle=seasC;ctx.textAlign='center';ctx.textBaseline='bottom';
            ctx.fillText(availSeasons[si],xS.getPixelForValue(ss+nDT*12),top-2);ctx.restore();
            for(let di=0;di<nDT;di++){
              const dts=ss+di*24;
              if(dts>0){const lx=xS.getPixelForValue(dts);const isS=di===0;ctx.save();ctx.strokeStyle=isS?solidC:dashC;ctx.lineWidth=isS?1.2:0.7;if(!isS)ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(lx,top);ctx.lineTo(lx,bottom);ctx.stroke();ctx.restore();}
              const midX=xS.getPixelForValue(dts+12);
              const w=hoursData?.[availSeasons[si]]?.[availDaytypes[di]]||0;
              const pct=w>0?` (${((w/totalDaysPf)*100).toFixed(0)}%)`:'';
              ctx.save();ctx.translate(midX,bottom+3);ctx.rotate(-Math.PI/2);ctx.font='7px system-ui,sans-serif';ctx.fillStyle=textC;ctx.textAlign='right';ctx.textBaseline='middle';
              ctx.fillText(`${availDaytypes[di]}${pct}`,0,0);ctx.restore();
            }
          }
        },
      };
      return { chartData:{ labels:new Array(nPts).fill(''), datasets:[...zoneDs,...(avgDs?[avgDs]:[])] }, plugin:separatorPlugin };
    }

    // Single season
    const getP = (zone) => {
      const sp=pf[zone]?.[demandSeason]; if(!sp) return null;
      if(demandDay==='avg'){const days=Object.keys(sp);return days.length?Array.from({length:24},(_,h)=>days.reduce((s,d)=>s+(sp[d][h]||0),0)/days.length):null;}
      return sp[demandDay]||null;
    };
    const zoneLines = countryZoneIds.flatMap((z,i)=>{if(demandHidden.has(z))return[];const p=getP(z);return p?[{label:z,data:p,borderColor:ZONE_PALETTE[i%ZONE_PALETTE.length],borderWidth:1.8,pointRadius:0,tension:0.35,fill:false}]:[];});
    const allProf = countryZoneIds.map(z=>getP(z)).filter(Boolean);
    const avgLine = (showAvg&&allProf.length)?{label:'avg',data:Array.from({length:24},(_,h)=>allProf.reduce((s,p)=>s+(p[h]||0),0)/allProf.length),borderColor:'#1a5fa8',borderWidth:2.5,pointRadius:0,tension:0.35,fill:false}:null;
    return { chartData:{ labels:Array.from({length:24},(_,i)=>`${i+1}h`), datasets:[...zoneLines,...(avgLine?[avgLine]:[])] }, plugin:null };
  };

  // ── VRE profile builder ───────────────────────────────────────────────────────
  const buildVREData = () => {
    const isDark = t.isDark;
    const showAvgV = !vreHidden.has('__avg__');
    const tech = activeVreTech;

    if (vreProfileMode === 'full') {
      if (!firstZoneWithVre || !vreAvailDaytypes.length) return { chartData:{ labels:[], datasets:[] }, plugin:null };
      const nDT=vreAvailDaytypes.length, nS=vreAvailSeasons.length, nPts=nS*nDT*24;
      const zoneDs = countryZoneIds.flatMap((z,i)=>{
        if(vreHidden.has(z)) return [];
        const data=[];
        for(const s of vreAvailSeasons) for(const d of vreAvailDaytypes){const p=vp[z]?.[tech]?.[s]?.[d];data.push(...(p?p:new Array(24).fill(null)));}
        if(!data.some(v=>v!==null)) return [];
        return [{label:z,data,borderColor:ZONE_PALETTE[i%ZONE_PALETTE.length],borderWidth:1.5,pointRadius:0,tension:0.3,fill:false,spanGaps:true}];
      });
      const avgData=[];
      for(const s of vreAvailSeasons) for(const d of vreAvailDaytypes){
        const profs=countryZoneIds.map(z=>vp[z]?.[tech]?.[s]?.[d]).filter(Boolean);
        for(let h=0;h<24;h++) avgData.push(profs.length?profs.reduce((sum,p)=>sum+(p[h]||0),0)/profs.length:null);
      }
      const techColor=VRE_COLOR[tech]||'#1E9AF5';
      const avgDs=showAvgV?{label:`${VRE_DISPLAY[tech]||tech} avg`,data:avgData,borderColor:techColor,borderWidth:2.5,pointRadius:0,tension:0.3,fill:false,spanGaps:true}:null;
      const separatorPlugin={
        id:'vreSepC',
        afterDraw:(chart)=>{
          const{ctx,chartArea,scales}=chart;if(!chartArea||!scales.x)return;
          const{top,bottom}=chartArea;const xS=scales.x;
          const dashC=isDark?'rgba(255,255,255,0.13)':'rgba(0,0,0,0.12)';const solidC=isDark?'rgba(255,255,255,0.36)':'rgba(0,0,0,0.30)';
          const textC=isDark?'rgba(255,255,255,0.46)':'rgba(0,0,0,0.40)';const seasC=isDark?'rgba(255,255,255,0.70)':'rgba(0,0,0,0.58)';
          for(let si=0;si<nS;si++){
            const ss=si*nDT*24;ctx.save();ctx.font='700 9px system-ui,sans-serif';ctx.fillStyle=seasC;ctx.textAlign='center';ctx.textBaseline='bottom';ctx.fillText(vreAvailSeasons[si],xS.getPixelForValue(ss+nDT*12),top-2);ctx.restore();
            for(let di=0;di<nDT;di++){
              const dts=ss+di*24;if(dts>0){const lx=xS.getPixelForValue(dts);const isS=di===0;ctx.save();ctx.strokeStyle=isS?solidC:dashC;ctx.lineWidth=isS?1.2:0.7;if(!isS)ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(lx,top);ctx.lineTo(lx,bottom);ctx.stroke();ctx.restore();}
              const midX=xS.getPixelForValue(dts+12);const w=hoursData?.[vreAvailSeasons[si]]?.[vreAvailDaytypes[di]]||0;const pct=w>0?` (${((w/totalDaysPf)*100).toFixed(0)}%)`:'';
              ctx.save();ctx.translate(midX,bottom+3);ctx.rotate(-Math.PI/2);ctx.font='7px system-ui,sans-serif';ctx.fillStyle=textC;ctx.textAlign='right';ctx.textBaseline='middle';ctx.fillText(`${vreAvailDaytypes[di]}${pct}`,0,0);ctx.restore();
            }
          }
        },
      };
      return { chartData:{ labels:new Array(nPts).fill(''), datasets:[...zoneDs,...(avgDs?[avgDs]:[])] }, plugin:separatorPlugin };
    }

    // Single season
    const getP=(zone)=>{const sp=vp[zone]?.[tech]?.[vreSeason];if(!sp)return null;if(vreDay==='avg'){const days=Object.keys(sp);return days.length?Array.from({length:24},(_,h)=>days.reduce((s,d)=>s+(sp[d][h]||0),0)/days.length):null;}return sp[vreDay]||null;};
    const zoneLines=countryZoneIds.flatMap((z,i)=>{if(vreHidden.has(z))return[];const p=getP(z);return p?[{label:z,data:p,borderColor:ZONE_PALETTE[i%ZONE_PALETTE.length],borderWidth:1.8,pointRadius:0,tension:0.35,fill:false}]:[];});
    const allProf=countryZoneIds.map(z=>getP(z)).filter(Boolean);
    const techColor=VRE_COLOR[tech]||'#1E9AF5';
    const avgLine=(showAvgV&&allProf.length)?{label:`${VRE_DISPLAY[tech]||tech} avg`,data:Array.from({length:24},(_,h)=>allProf.reduce((s,p)=>s+(p[h]||0),0)/allProf.length),borderColor:techColor,borderWidth:2.5,pointRadius:0,tension:0.35,fill:false}:null;
    return { chartData:{ labels:Array.from({length:24},(_,i)=>`${i+1}h`), datasets:[...zoneLines,...(avgLine?[avgLine]:[])] }, plugin:null };
  };

  // ── Availability builder ──────────────────────────────────────────────────────
  const buildAvailData = () => {
    const av = epmData?.availability || {};
    const zones = availZone === 'all' ? countryZoneIds : [availZone];
    const techKeys = new Set();
    for (const z of zones) for (const k of Object.keys(av[z]||{})) techKeys.add(k);
    const keys = [...techKeys].slice(0, 12);
    const firstZoneData = av[zones[0]] || {};
    const qCols = keys.length ? Object.keys(firstZoneData[keys[0]]||{}).filter(k=>/^Q\d+$/.test(k)).sort() : ['Q1','Q2','Q3','Q4'];
    return {
      labels: qCols,
      datasets: keys.map((k, i) => {
        const entry = firstZoneData[k] || {};
        const displayLabel = entry.fuel && entry.fuel !== '' ? entry.fuel : entry.tech || k;
        return {
          label: displayLabel,
          data: qCols.map(q => {
            const vals = zones.map(z=>av[z]?.[k]?.[q]).filter(v=>v!=null);
            return vals.length ? +(vals.reduce((s,v)=>s+v,0)/vals.length).toFixed(3) : 0;
          }),
          backgroundColor: hexA(EPM_FUEL_COLORS[normalizeFuel(entry.fuel||entry.tech||'')] || ZONE_PALETTE[i%ZONE_PALETTE.length], 0.75),
          borderWidth: 0, barThickness: 10,
        };
      }),
    };
  };

  // ── Fuel price builder ────────────────────────────────────────────────────────
  const buildFuelPriceData = () => {
    const fp = epmData?.fuelPrice || {};
    const countries = (fpCountries || allCountries).filter(c=>fp[c]);
    if (!countries.length) return { labels:[], datasets:[] };
    const allFuels = [...new Set(countries.flatMap(c=>Object.keys(fp[c]||{})))];
    const yearCols = Object.keys(Object.values(fp[countries[0]]||{})[0]||{}).filter(k=>/^\d{4}$/.test(k)).sort().filter(y=>y<='2050');
    return {
      labels: yearCols,
      datasets: allFuels.map((fuel, i) => ({
        label: fuel,
        data: yearCols.map(y => {
          const vals = countries.map(c=>fp[c]?.[fuel]?.[y]).filter(v=>v!=null&&v>0);
          return vals.length ? +(vals.reduce((s,v)=>s+v,0)/vals.length).toFixed(2) : null;
        }),
        borderColor: EPM_FUEL_COLORS[normalizeFuel(fuel)] || ZONE_PALETTE[i%ZONE_PALETTE.length],
        borderWidth: 2, pointRadius: 0, tension: 0.2, fill: false, spanGaps: true,
      })),
    };
  };

  // ── Mix chart config ──────────────────────────────────────────────────────────
  // Mix chart: zone view only (we're already in a country)
  const mixLabels = countryZoneIds.filter(z=>Object.keys(genByZoneFuel[z]||{}).length>0);
  const mixData = buildMixChart(mixLabels, genByZoneFuel);
  const mixHeight = Math.max(mixLabels.length * 20 + 24, 60);
  const presentFuelsInMix = sortedFuels.filter(f=>mixLabels.some(l=>(genByZoneFuel[l]?.[f]||0)>0));

  // ── Tab colors ────────────────────────────────────────────────────────────────
  const TABS = ['overview','demand','supply','resources','trade','about'];
  const TAB_LABELS = { overview:'Overview', demand:'Demand', supply:'Supply', resources:'Resources', trade:'Trade', about:'About' };

  // ── JSX ───────────────────────────────────────────────────────────────────────
  return (
    <div style={{ display:'flex', height:'calc(100vh - 46px)' }}>

      {/* Map */}
      <div style={{ position:'relative', flex:1 }}>
        <div ref={containerRef} style={{ width:'100%', height:'100%', backgroundColor:t.bg }} />
        <div style={{ position:'absolute', top:10, left:10, zIndex:10, display:'flex', gap:4, alignItems:'center',
          fontSize:'0.52rem', color:t.text, backgroundColor:t.panel, border:`1px solid ${t.panelBorder}`,
          borderRadius:5, padding:'4px 10px', boxShadow:'0 1px 4px rgba(0,0,0,.18)' }}>
          <Link to="/" style={{ color:t.lblMuted, textDecoration:'none' }}>World</Link>
          <span style={{ color:t.lblMuted }}>›</span>
          <Link to={`/region/${regionId}`} style={{ color:t.lblMuted, textDecoration:'none' }}>{region.name}</Link>
          <span style={{ color:t.lblMuted }}>›</span>
          <span style={{ color:t.lbl, fontWeight:600 }}>{countryNameDecoded}</span>
        </div>
      </div>

      {/* Right panel */}
      <div style={{ width:530, flexShrink:0, height:'100%', overflowY:'auto', padding:'18px 16px',
        backgroundColor:t.panel, borderLeft:`1px solid ${t.panelBorder}`, position:'relative' }}>

        {/* Header */}
        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:'0.52rem', color:t.lblMuted, marginBottom:2 }}>
            <Link to={`/region/${regionId}`} style={{ color:t.lblMuted, textDecoration:'none' }}>← {region.name}</Link>
          </div>
          <div style={{ fontSize:'1rem', fontWeight:700, color:t.lbl }}>{countryNameDecoded}</div>
          <div style={{ fontSize:'0.55rem', color:t.lblMuted, marginTop:1 }}>
            {countryZoneIds.length} zone{countryZoneIds.length!==1?'s':''} · EPM study
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display:'flex', gap:0, marginBottom:16, borderBottom:`1px solid ${t.panelBorder}` }}>
          {TABS.map(tab => (
            <button key={tab} onClick={()=>setActiveTab(tab)} style={{
              fontSize:'0.5rem', fontFamily:'inherit', padding:'6px 10px', border:'none',
              borderBottom: activeTab===tab ? `2px solid ${t.lbl}` : '2px solid transparent',
              backgroundColor:'transparent', color: activeTab===tab ? t.lbl : t.lblMuted,
              cursor:'pointer', fontWeight: activeTab===tab ? 600 : 400,
            }}>{TAB_LABELS[tab]}</button>
          ))}
        </div>

        {loading && <div style={{ padding:'24px 0', textAlign:'center', color:t.lblMuted, fontSize:'0.6rem' }}>Loading EPM data…</div>}

        {/* ════════ OVERVIEW ════════════════════════════════════════════════════ */}
        {hasData && activeTab === 'overview' && (
          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>

            {/* KPIs + donut */}
            <div style={{ display:'flex', gap:12, alignItems:'flex-start' }}>
              {/* Donut */}
              <div style={{ flexShrink:0, width:108, textAlign:'center' }}>
                <CJChart type="doughnut" height={108}
                  data={{ labels: Object.keys(fuelAgg), datasets:[{
                    data: Object.values(fuelAgg).map(v=>Math.round(v)),
                    backgroundColor: Object.keys(fuelAgg).map(f=>EPM_FUEL_COLORS[f]||'#aaa'),
                    borderWidth:1.5, borderColor:t.panel, hoverOffset:3,
                  }]}}
                  options={{ cutout:'60%', responsive:true, maintainAspectRatio:false, layout:{padding:4},
                    plugins:{ legend:{display:false}, tooltip:{callbacks:{label:c=>` ${c.label}: ${fmt(c.parsed)} MW`}}} }}
                />
                <div style={{ fontSize:'0.4rem', color:t.lblMuted, marginTop:2 }}>Existing mix</div>
              </div>
              {/* KPI rows */}
              <div style={{ flex:1, display:'flex', flexDirection:'column', gap:5 }}>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:5 }}>
                  {[
                    { l:`Peak ${refYr||''}`, v:`${peakGW.toFixed(1)} GW` },
                    { l:`Energy ${refYr||''}`, v:`${energyTWh.toFixed(0)} TWh` },
                    { l:'Installed', v:`${totalGW.toFixed(1)} GW` },
                    { l:'RE Share', v:`${reShare}%` },
                  ].map(({l,v})=>(
                    <div key={l} style={{ border:`1px solid ${t.panelBorder}`, borderRadius:5, padding:'6px 8px' }}>
                      <div style={{ fontSize:'0.4rem', color:t.lblMuted, marginBottom:2 }}>{l}</div>
                      <div style={{ fontSize:'0.72rem', fontWeight:700, color:t.lbl }}>{v}</div>
                    </div>
                  ))}
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:5 }}>
                  {[
                    { l:'Countries', v:allCountries.length },
                    { l:'Zones', v:countryZoneIds.length },
                    { l:'TX Capacity', v:`${txGW.toFixed(1)} GW` },
                    { l:'Corridors', v:nCorridors },
                  ].map(({l,v})=>(
                    <div key={l} style={{ border:`1px solid ${t.panelBorder}`, borderRadius:5, padding:'5px 8px' }}>
                      <div style={{ fontSize:'0.39rem', color:t.lblMuted, marginBottom:1 }}>{l}</div>
                      <div style={{ fontSize:'0.6rem', fontWeight:700, color:t.lbl }}>{v}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Mix chart */}
            <div>
              <SectionTitle t={t}>Capacity mix by zone (MW)</SectionTitle>
              {mixLabels.length > 0 ? (
                <>
                  <CJChart type="bar" height={Math.min(mixHeight, 260)}
                    data={mixData}
                    options={{ ...cjDefaults(t), indexAxis:'y',
                      scales: {
                        x: { stacked:true, grid:{color:t.panelBorder}, ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v} },
                        y: { stacked:true, grid:{display:false}, ticks:{color:t.muted,font:{size:8}} },
                      }, plugins:{...cjDefaults(t).plugins, tooltip:{...cjDefaults(t).plugins.tooltip,
                        callbacks:{label:c=>` ${c.dataset.label}: ${fmt(c.parsed.x)} MW`}}} }}
                  />
                  <div style={{ display:'flex', flexWrap:'wrap', gap:'3px 10px', marginTop:5 }}>
                    {presentFuelsInMix.map(f=>(
                      <div key={f} style={{ display:'flex', alignItems:'center', gap:3, fontSize:'0.43rem', color:t.muted }}>
                        <div style={{ width:8, height:8, borderRadius:2, backgroundColor:EPM_FUEL_COLORS[f]||'#aaa' }}/>
                        {f}
                      </div>
                    ))}
                  </div>
                </>
              ) : <div style={{ color:t.lblMuted, fontSize:'0.58rem' }}>No generation data.</div>}
            </div>

            {/* Zones quick list */}
            {countryZoneIds.length > 0 && (
              <div>
                <SectionTitle t={t}>Zones ({countryZoneIds.length})</SectionTitle>
                <div style={{ border:`1px solid ${t.panelBorder}`, borderRadius:6, overflow:'hidden' }}>
                  {countryZoneIds.map((z,i)=>(
                    <div key={z} onClick={()=>navigate(`/region/${regionId}/zone/${encodeURIComponent(z)}`)}
                      style={{ display:'flex', justifyContent:'space-between', alignItems:'center',
                        padding:'5px 10px', borderBottom:i<countryZoneIds.length-1?`1px solid ${t.panelBorder}`:'none',
                        cursor:'pointer', fontSize:'0.52rem' }}
                      onMouseEnter={e=>e.currentTarget.style.backgroundColor=hexA('#1a5fa8',0.06)}
                      onMouseLeave={e=>e.currentTarget.style.backgroundColor='transparent'}>
                      <span style={{ color:t.lbl, fontWeight:500 }}>{z}</span>
                      <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                        <span style={{ color:t.muted }}>{fmt((genByZoneFuel[z]?Object.values(genByZoneFuel[z]).reduce((s,v)=>s+v,0):0))} MW</span>
                        <span style={{ color:t.lblMuted, fontSize:'0.44rem' }}>›</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ════════ DEMAND ══════════════════════════════════════════════════════ */}
        {hasData && activeTab === 'demand' && (
          <div style={{ display:'flex', flexDirection:'column', gap:18 }}>

            {/* Forecast */}
            <div>
              <SectionTitle t={t} right={
                <div style={{ display:'flex', gap:3 }}>
                  <Pill active={demandSeg==='aggregate'} onClick={()=>{ setDemandSeg('aggregate'); setDemandHidden(new Set()); }}>Aggregate</Pill>
                  <Pill active={demandSeg==='zone'}      onClick={()=>{ setDemandSeg('zone'); setDemandHidden(new Set()); }}>By Zone</Pill>
                </div>
              }>Demand forecast</SectionTitle>
              {countryDemand.length > 0 ? (
                <div style={{ display:'flex', gap:8 }}>
                  <div style={{ flex:1 }}>
                    <CJChart type="bar" height={170} data={buildForecastData()}
                      cacheKey={`forecast|${demandSeg}|${[...demandHidden].sort().join(',')}`}
                      options={{ ...cjDefaults(t),
                        scales: {
                          x:  { stacked:true, grid:{color:t.panelBorder}, ticks:{color:t.muted,font:{size:8},maxTicksLimit:7} },
                          yL: { type:'linear', position:'left', stacked:true, title:{display:true,text:'GWh',color:t.muted,font:{size:7}},
                            grid:{color:t.panelBorder}, ticks:{color:t.muted,font:{size:8}} },
                          yR: { type:'linear', position:'right', title:{display:true,text:'GW',color:t.muted,font:{size:7}},
                            grid:{drawOnChartArea:false}, ticks:{color:t.muted,font:{size:8}} },
                        } }}
                    />
                  </div>
                  {demandSeg==='zone' && demandZones.length>0 && (
                    <div style={{ width:100, flexShrink:0, display:'flex', flexDirection:'column', gap:3, paddingTop:4 }}>
                      {demandZones.map((z,i)=>(
                        <div key={z} onClick={()=>toggleDemandHidden(z)}
                          style={{ display:'flex', alignItems:'center', gap:4, cursor:'pointer', opacity:demandHidden.has(z)?0.3:1 }}>
                          <div style={{ width:10, height:10, borderRadius:2, flexShrink:0, backgroundColor:ZONE_PALETTE[i%ZONE_PALETTE.length] }}/>
                          <span style={{ fontSize:'0.43rem', color:t.muted, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{z}</span>
                        </div>
                      ))}
                      <div style={{ fontSize:'0.38rem', color:t.lblMuted, marginTop:4 }}>click to hide</div>
                    </div>
                  )}
                </div>
              ) : <div style={{ color:t.lblMuted, fontSize:'0.58rem' }}>No demand data.</div>}
            </div>

            {/* Profile */}
            <div>
              <SectionTitle t={t}>Load profile</SectionTitle>
              <div style={{ display:'flex', flexWrap:'wrap', gap:3, marginBottom:6, alignItems:'center' }}>
                <Pill active={demandProfileMode==='full'} onClick={()=>setDemandProfileMode('full')}>Full Year</Pill>
                {availSeasons.map(s=>(
                  <Pill key={s} active={demandProfileMode==='season'&&demandSeason===s}
                    onClick={()=>{setDemandProfileMode('season');setDemandSeason(s);}}>
                    {s}
                  </Pill>
                ))}
                {demandProfileMode==='season' && availDaytypes.length>0 && (
                  <>
                    <div style={{ width:1, backgroundColor:t.panelBorder, height:14 }}/>
                    <select value={demandDay} onChange={e=>setDemandDay(e.target.value)} style={{
                      fontSize:'0.44rem', fontFamily:'inherit', padding:'2px 5px', borderRadius:3,
                      border:`1px solid ${t.panelBorder}`, backgroundColor:t.panel, color:t.muted, cursor:'pointer' }}>
                      <option value="avg">Avg</option>
                      {availDaytypes.map(d=><option key={d} value={d}>{d}</option>)}
                    </select>
                  </>
                )}
              </div>
              {(() => {
                const pd = buildProfileData();
                return pd.chartData.datasets.length > 0 ? (
                  <div style={{ display:'flex', gap:8 }}>
                    <div style={{ flex:1 }}>
                      <CJChart type="line"
                        height={demandProfileMode==='full'?205:160}
                        data={pd.chartData}
                        plugins={pd.plugin?[pd.plugin]:[]}
                        cacheKey={`${demandProfileMode}|${demandSeason}|${demandDay}|${[...demandHidden].sort().join(',')}`}
                        options={{ ...cjDefaults(t),
                          layout:{padding:{top:demandProfileMode==='full'?18:4,bottom:demandProfileMode==='full'?62:4}},
                          scales:{
                            x:{grid:{color:t.panelBorder,drawTicks:false},ticks:{display:demandProfileMode!=='full',color:t.muted,font:{size:7},maxTicksLimit:12}},
                            y:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}},min:0,title:{display:true,text:'Load factor',color:t.muted,font:{size:7}}},
                          }}}
                      />
                    </div>
                    <div style={{ width:96, flexShrink:0, display:'flex', flexDirection:'column', gap:2, paddingTop:4, maxHeight:demandProfileMode==='full'?205:160, overflowY:'auto' }}>
                      <div onClick={()=>toggleDemandHidden('__avg__')} style={{ display:'flex', alignItems:'center', gap:4, cursor:'pointer', opacity:demandHidden.has('__avg__')?0.25:1 }}>
                        <div style={{ width:12, height:2.5, backgroundColor:'#1a5fa8', borderRadius:1 }}/>
                        <span style={{ fontSize:'0.43rem', color:t.muted, fontWeight:600 }}>avg</span>
                      </div>
                      {countryZoneIds.map((z,i)=>(
                        <div key={z} onClick={()=>toggleDemandHidden(z)} style={{ display:'flex', alignItems:'center', gap:4, cursor:'pointer', opacity:demandHidden.has(z)?0.25:1 }}>
                          <div style={{ width:12, height:2.5, backgroundColor:ZONE_PALETTE[i%ZONE_PALETTE.length], borderRadius:1 }}/>
                          <span style={{ fontSize:'0.43rem', color:t.muted, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{z}</span>
                        </div>
                      ))}
                      <div style={{ fontSize:'0.38rem', color:t.lblMuted, marginTop:4 }}>click to hide</div>
                    </div>
                  </div>
                ) : <div style={{ color:t.lblMuted, fontSize:'0.55rem' }}>No profile data.</div>;
              })()}
            </div>
          </div>
        )}

        {/* ════════ SUPPLY ══════════════════════════════════════════════════════ */}
        {hasData && activeTab === 'supply' && (
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>

            {/* Capacity chart */}
            {(() => {
              const chartPlants = countryGen.filter(r => statusFilter.has(r.status));
              const fuels = [...new Set(chartPlants.map(r => r.fuel))];
              const byFS = {};
              for (const r of chartPlants) { if(!byFS[r.fuel]) byFS[r.fuel]={1:0,2:0,3:0}; byFS[r.fuel][r.status]=(byFS[r.fuel][r.status]||0)+r.capacity; }
              const fd = fuels.filter(f=>byFS[f]).map(f=>({ fuel:f, ex:Math.round(byFS[f]?.[1]||0), co:Math.round(byFS[f]?.[2]||0), ca:Math.round(byFS[f]?.[3]||0) })).filter(d=>d.ex+d.co+d.ca>0).sort((a,b)=>(b.ex+b.co+b.ca)-(a.ex+a.co+a.ca));
              if (!fd.length) return null;
              return (
                <div>
                  <SectionTitle t={t}>Capacity by fuel (MW)</SectionTitle>
                  <CJChart type="bar" height={Math.min(fd.length*22+24,200)}
                    data={{ labels:fd.map(d=>d.fuel), datasets:[
                      { label:'Existing', data:fd.map(d=>d.ex), backgroundColor:fd.map(d=>EPM_FUEL_COLORS[d.fuel]||'#aaa'), borderWidth:0, barThickness:12, stack:'a' },
                      { label:'Committed', data:fd.map(d=>d.co), backgroundColor:fd.map(d=>hexA(EPM_FUEL_COLORS[d.fuel]||'#aaa',0.55)), borderWidth:0, barThickness:12, stack:'a' },
                      { label:'Candidate', data:fd.map(d=>d.ca), backgroundColor:fd.map(d=>hexA(EPM_FUEL_COLORS[d.fuel]||'#aaa',0.22)), borderWidth:0, barThickness:12, stack:'a' },
                    ]}}
                    options={{ ...cjDefaults(t), indexAxis:'y',
                      scales:{
                        x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}},
                        y:{stacked:true,grid:{display:false},ticks:{color:t.muted,font:{size:8}}},
                      }}}
                  />
                  <div style={{ display:'flex', gap:10, marginTop:4 }}>
                    {[['Existing',1.0],['Committed',0.55],['Candidate',0.22]].map(([lbl,op])=>(
                      <div key={lbl} style={{ display:'flex', alignItems:'center', gap:3, fontSize:'0.44rem', color:t.muted }}>
                        <div style={{ width:8, height:8, borderRadius:2, backgroundColor:`rgba(100,140,200,${op})` }}/>{lbl}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* Filters */}
            <div style={{ display:'flex', flexWrap:'wrap', gap:4, alignItems:'center' }}>
              {[1,2,3].map(s=>(
                <Pill key={s} active={statusFilter.has(s)} onClick={()=>toggleStatus(s)} color={STATUS_COLOR[s]}>
                  <span style={{ display:'inline-block', width:6, height:6, borderRadius:'50%',
                    backgroundColor:STATUS_COLOR[s], marginRight:3 }}/>
                  {STATUS_LABEL[s]}
                </Pill>
              ))}
              <div style={{ height:14, width:1, backgroundColor:t.panelBorder, margin:'0 2px' }}/>
              <select value={zoneFilter} onChange={e=>{setZoneFilter(e.target.value);setSelectedPlant(null);}} style={{
                fontSize:'0.44rem', fontFamily:'inherit', padding:'3px 6px', borderRadius:3,
                border:`1px solid ${t.panelBorder}`, backgroundColor:t.panel, color:t.muted, cursor:'pointer' }}>
                <option value="all">All zones</option>
                {countryZoneIds.map(z=><option key={z} value={z}>{z}</option>)}
              </select>
              <span style={{ fontSize:'0.42rem', color:t.lblMuted, marginLeft:2 }}>
                {sortedPlants.length} unit{sortedPlants.length!==1?'s':''}
              </span>
            </div>

            {/* Table */}
            <div style={{ border:`1px solid ${t.panelBorder}`, borderRadius:6, overflow:'hidden' }}>
              {/* Header */}
              <div style={{ display:'grid', gridTemplateColumns:'1fr 70px 56px 52px 56px',
                padding:'4px 8px', backgroundColor:hexA(t.panelBorder,0.4),
                borderBottom:`1px solid ${t.panelBorder}` }}>
                <SortBtn col="g"        label="Name"/>
                <SortBtn col="zone"     label="Zone"/>
                <SortBtn col="fuel"     label="Fuel"/>
                <SortBtn col="status"   label="Status"/>
                <span><SortBtn col="capacity" label="MW" align="right"/></span>
              </div>
              {/* Rows */}
              <div style={{ maxHeight:360, overflowY:'auto' }}>
                {sortedPlants.length === 0 ? (
                  <div style={{ padding:'12px 10px', color:t.lblMuted, fontSize:'0.55rem' }}>No units match filters.</div>
                ) : sortedPlants.map((r) => {
                  const plantKey = `${r.g}|${r.zone}|${r.status}`;
                  const isSelected = selectedPlant && `${selectedPlant.g}|${selectedPlant.zone}|${selectedPlant.status}` === plantKey;
                  return (
                    <div key={plantKey}>
                      <div onClick={()=>setSelectedPlant(isSelected ? null : r)}
                        style={{ display:'grid', gridTemplateColumns:'1fr 70px 56px 52px 56px',
                          padding:'5px 8px', borderBottom:`1px solid ${t.panelBorder}`,
                          fontSize:'0.5rem', alignItems:'center', cursor:'pointer',
                          backgroundColor: isSelected ? hexA('#1a5fa8',0.08) : 'transparent' }}
                        onMouseEnter={e=>{ if(!isSelected) e.currentTarget.style.backgroundColor=hexA('#1a5fa8',0.04); }}
                        onMouseLeave={e=>{ if(!isSelected) e.currentTarget.style.backgroundColor='transparent'; }}>
                        <span style={{ color:t.lbl, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.g||'—'}</span>
                        <span style={{ color:t.muted, fontSize:'0.44rem' }}>{r.zone}</span>
                        <span style={{ display:'flex', alignItems:'center', gap:3 }}>
                          <span style={{ display:'inline-block', width:7, height:7, borderRadius:1, backgroundColor:EPM_FUEL_COLORS[r.fuel]||'#aaa' }}/>
                          <span style={{ color:t.muted, fontSize:'0.43rem' }}>{r.fuel}</span>
                        </span>
                        <span>
                          <span style={{ display:'inline-block', width:7, height:7, borderRadius:'50%',
                            backgroundColor:STATUS_COLOR[r.status]||'#aaa' }}/>
                        </span>
                        <span style={{ color:t.lbl, textAlign:'right', fontWeight:600 }}>{fmt(r.capacity)}</span>
                      </div>
                      {/* Inline detail expansion */}
                      {isSelected && (
                        <div style={{ padding:'8px 12px', backgroundColor:hexA('#1a5fa8',0.05),
                          borderBottom:`1px solid ${t.panelBorder}`, fontSize:'0.5rem' }}>
                          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:'6px 10px' }}>
                            {[
                              { l:'Technology', v:r.tech||'—' },
                              { l:'Status', v:STATUS_LABEL[r.status]||'—' },
                              { l:'Start year', v:r.stYr||'—' },
                              { l:'Retire year', v:r.retrYr||'—' },
                              { l:'Capex ($/kW)', v:r.capex!=null?fmt(r.capex,0):'—' },
                              { l:'FOM ($/MW/yr)', v:r.fom!=null?fmt(r.fom,0):'—' },
                              { l:'VOM ($/MWh)', v:r.vom!=null?fmt(r.vom,2):'—' },
                              { l:'Heat rate', v:r.heatRate!=null?fmt(r.heatRate,2):'—' },
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
          </div>
        )}

        {/* ════════ RESOURCES ═══════════════════════════════════════════════════ */}
        {hasData && activeTab === 'resources' && (
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>

            {/* Sub-section pills */}
            <div style={{ display:'flex', gap:4 }}>
              <Pill active={resSection==='vre'}   onClick={()=>setResSection('vre')}>VRE Profiles</Pill>
              <Pill active={resSection==='avail'} onClick={()=>setResSection('avail')}>Availability</Pill>
              <Pill active={resSection==='fuel'}  onClick={()=>setResSection('fuel')}>Fuel Prices</Pill>
            </div>

            {/* VRE Profiles */}
            {resSection === 'vre' && (
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {allVreTechs.length === 0 ? (
                  <div style={{ color:t.lblMuted, fontSize:'0.55rem' }}>No VRE profile data for this country.</div>
                ) : (
                  <>
                    <div style={{ display:'flex', flexWrap:'wrap', gap:3, alignItems:'center' }}>
                      {allVreTechs.map(tc=>(
                        <Pill key={tc} active={activeVreTech===tc} onClick={()=>setVreTech(tc)}>
                          {VRE_DISPLAY[tc]||tc}
                        </Pill>
                      ))}
                      <div style={{ width:1, backgroundColor:t.panelBorder, height:14, margin:'0 2px' }}/>
                      <Pill active={vreProfileMode==='full'} onClick={()=>setVreProfileMode('full')}>Full Year</Pill>
                      {vreAvailSeasons.map(s=>(
                        <Pill key={s} active={vreProfileMode==='season'&&vreSeason===s}
                          onClick={()=>{setVreProfileMode('season');setVreSeason(s);}}>
                          {s}
                        </Pill>
                      ))}
                      {vreProfileMode==='season' && vreAvailDaytypes.length>0 && (
                        <>
                          <div style={{ width:1, backgroundColor:t.panelBorder, height:14 }}/>
                          <select value={vreDay} onChange={e=>setVreDay(e.target.value)} style={{
                            fontSize:'0.44rem', fontFamily:'inherit', padding:'2px 5px', borderRadius:3,
                            border:`1px solid ${t.panelBorder}`, backgroundColor:t.panel, color:t.muted, cursor:'pointer' }}>
                            <option value="avg">Avg</option>
                            {vreAvailDaytypes.map(d=><option key={d} value={d}>{d}</option>)}
                          </select>
                        </>
                      )}
                    </div>
                    {(() => {
                      const vd = buildVREData();
                      return vd.chartData.datasets.length > 0 ? (
                        <div style={{ display:'flex', gap:8 }}>
                          <div style={{ flex:1 }}>
                            <CJChart type="line"
                              height={vreProfileMode==='full'?205:160}
                              data={vd.chartData}
                              plugins={vd.plugin?[vd.plugin]:[]}
                              cacheKey={`${vreProfileMode}|${activeVreTech}|${vreSeason}|${vreDay}|${[...vreHidden].sort().join(',')}`}
                              options={{ ...cjDefaults(t),
                                layout:{padding:{top:vreProfileMode==='full'?18:4,bottom:vreProfileMode==='full'?62:4}},
                                scales:{
                                  x:{grid:{color:t.panelBorder,drawTicks:false},ticks:{display:vreProfileMode!=='full',color:t.muted,font:{size:7},maxTicksLimit:12}},
                                  y:{min:0,max:1,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}},title:{display:true,text:'Availability (0-1)',color:t.muted,font:{size:7}}},
                                }}}
                            />
                          </div>
                          <div style={{ width:96, flexShrink:0, display:'flex', flexDirection:'column', gap:2, paddingTop:4, maxHeight:vreProfileMode==='full'?205:160, overflowY:'auto' }}>
                            <div onClick={()=>setVreHidden(s=>{const n=new Set(s);n.has('__avg__')?n.delete('__avg__'):n.add('__avg__');return n;})}
                              style={{ display:'flex', alignItems:'center', gap:4, cursor:'pointer', opacity:vreHidden.has('__avg__')?0.25:1 }}>
                              <div style={{ width:12, height:2.5, backgroundColor:VRE_COLOR[activeVreTech]||'#1E9AF5', borderRadius:1 }}/>
                              <span style={{ fontSize:'0.43rem', color:t.muted, fontWeight:600 }}>avg</span>
                            </div>
                            {countryZoneIds.map((z,i)=>{
                              if(!vp[z]?.[activeVreTech]) return null;
                              return (
                                <div key={z} onClick={()=>toggleVreHidden(z)} style={{ display:'flex', alignItems:'center', gap:4, cursor:'pointer', opacity:vreHidden.has(z)?0.25:1 }}>
                                  <div style={{ width:12, height:2.5, backgroundColor:ZONE_PALETTE[i%ZONE_PALETTE.length], borderRadius:1 }}/>
                                  <span style={{ fontSize:'0.43rem', color:t.muted, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{z}</span>
                                </div>
                              );
                            })}
                            <div style={{ fontSize:'0.38rem', color:t.lblMuted, marginTop:4 }}>click to hide</div>
                          </div>
                        </div>
                      ) : <div style={{ color:t.lblMuted, fontSize:'0.55rem' }}>No {VRE_DISPLAY[activeVreTech]||activeVreTech} data available.</div>;
                    })()}
                  </>
                )}
              </div>
            )}

            {/* Availability */}
            {resSection === 'avail' && (
              <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                <div style={{ display:'flex', gap:4, alignItems:'center' }}>
                  <span style={{ fontSize:'0.44rem', color:t.lblMuted }}>Zone:</span>
                  <select value={availZone} onChange={e=>setAvailZone(e.target.value)} style={{
                    fontSize:'0.44rem', fontFamily:'inherit', padding:'3px 6px', borderRadius:3,
                    border:`1px solid ${t.panelBorder}`, backgroundColor:t.panel, color:t.muted }}>
                    <option value="all">All zones (avg)</option>
                    {countryZoneIds.map(z=><option key={z} value={z}>{z}</option>)}
                  </select>
                </div>
                {(() => {
                  const ad = buildAvailData();
                  return ad.datasets.length > 0 ? (
                    <>
                      <CJChart type="bar" height={160} data={ad}
                        options={{ ...cjDefaults(t),
                          scales: {
                            x: { grid:{color:t.panelBorder}, ticks:{color:t.muted,font:{size:8}} },
                            y: { min:0, max:1, grid:{color:t.panelBorder}, ticks:{color:t.muted,font:{size:8}},
                              title:{display:true,text:'Availability factor',color:t.muted,font:{size:7}} },
                          } }}
                      />
                      <div style={{ display:'flex', flexWrap:'wrap', gap:'3px 10px', marginTop:2 }}>
                        {ad.datasets.map((ds,i)=>(
                          <div key={ds.label} style={{ display:'flex', alignItems:'center', gap:3, fontSize:'0.43rem', color:t.muted }}>
                            <div style={{ width:8, height:8, borderRadius:2, backgroundColor:ad.datasets[i].backgroundColor }}/>
                            {ds.label}
                          </div>
                        ))}
                      </div>
                    </>
                  ) : <div style={{ color:t.lblMuted, fontSize:'0.55rem' }}>No availability data for this country.</div>;
                })()}
              </div>
            )}

            {/* Fuel Prices */}
            {resSection === 'fuel' && (
              <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                {/* Country filter */}
                <div>
                  <div style={{ fontSize:'0.44rem', color:t.lblMuted, marginBottom:4 }}>
                    Countries — click to filter:
                  </div>
                  <div style={{ display:'flex', flexWrap:'wrap', gap:3 }}>
                    <Pill active={fpCountries===null} onClick={()=>setFpCountries(null)}>All</Pill>
                    {allCountries.filter(c=>(epmData?.fuelPrice||{})[c]).map(c=>(
                      <Pill key={c} active={fpCountries?.includes(c)??false}
                        onClick={()=>setFpCountries(prev=>{
                          if (prev===null) return [c];
                          const n=prev.includes(c)?prev.filter(x=>x!==c):[...prev,c];
                          return n.length===0?null:n;
                        })}>
                        {c}
                      </Pill>
                    ))}
                  </div>
                </div>
                {(() => {
                  const fd = buildFuelPriceData();
                  return fd.datasets.length > 0 ? (
                    <>
                      <CJChart type="line" height={170} data={fd}
                        options={{ ...cjDefaults(t),
                          scales: {
                            x: { grid:{color:t.panelBorder}, ticks:{color:t.muted,font:{size:7},maxTicksLimit:8} },
                            y: { grid:{color:t.panelBorder}, ticks:{color:t.muted,font:{size:8}},
                              title:{display:true,text:'USD/MBtu',color:t.muted,font:{size:7}} },
                          } }}
                      />
                      <div style={{ display:'flex', flexWrap:'wrap', gap:'3px 10px', marginTop:2 }}>
                        {fd.datasets.map((ds,i)=>(
                          <div key={ds.label} style={{ display:'flex', alignItems:'center', gap:3, fontSize:'0.43rem', color:t.muted }}>
                            <div style={{ width:12, height:2.5, borderRadius:1, backgroundColor:typeof ds.borderColor==='string'?ds.borderColor:ZONE_PALETTE[i%ZONE_PALETTE.length] }}/>
                            {ds.label}
                          </div>
                        ))}
                      </div>
                    </>
                  ) : <div style={{ color:t.lblMuted, fontSize:'0.55rem' }}>No fuel price data available.</div>;
                })()}
              </div>
            )}
          </div>
        )}

        {/* ════════ TRADE ═══════════════════════════════════════════════════════ */}
        {hasData && activeTab === 'trade' && (
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            <SectionTitle t={t}>NTC corridors ({refYr||'—'})</SectionTitle>
            {tradeCorridors.length > 0 ? (
              <div style={{ border:`1px solid ${t.panelBorder}`, borderRadius:6, overflow:'hidden' }}>
                {/* Header */}
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 90px 90px',
                  padding:'4px 10px', backgroundColor:hexA(t.panelBorder,0.4),
                  fontSize:'0.42rem', color:t.lblMuted, fontWeight:600, letterSpacing:'0.5px',
                  borderBottom:`1px solid ${t.panelBorder}` }}>
                  <span>Zone A</span><span>Zone B</span><span style={{textAlign:'center'}}>→ MW</span><span style={{textAlign:'center'}}>← MW</span>
                </div>
                {tradeCorridors.map(cor=>(
                  <div key={cor.key} style={{ display:'grid', gridTemplateColumns:'1fr 1fr 90px 90px',
                    padding:'6px 10px', borderTop:`1px solid ${t.panelBorder}`,
                    fontSize:'0.5rem', alignItems:'center',
                    backgroundColor: cor.isCountry ? hexA('#f0b030',0.06) : 'transparent' }}>
                    <div>
                      <div style={{ color:t.lbl, fontWeight: cor.isCountry?600:400, cursor:'pointer' }}
                        onClick={()=>navigate(`/region/${regionId}/zone/${encodeURIComponent(cor.z)}`)}>
                        {cor.z}
                      </div>
                      <div style={{ fontSize:'0.41rem', color:t.lblMuted }}>{cor.c}</div>
                    </div>
                    <div>
                      <div style={{ color:t.lbl, fontWeight: cor.isCountry?600:400, cursor:'pointer' }}
                        onClick={()=>navigate(`/region/${regionId}/zone/${encodeURIComponent(cor.z2)}`)}>
                        {cor.z2}
                      </div>
                      <div style={{ fontSize:'0.41rem', color:t.lblMuted }}>{cor.c2}</div>
                    </div>
                    <div style={{ textAlign:'center' }}>
                      <span style={{ color:cor.mwFwd>0?t.lbl:t.lblMuted, fontWeight:600 }}>{cor.mwFwd>0?fmt(cor.mwFwd):'—'}</span>
                    </div>
                    <div style={{ textAlign:'center' }}>
                      <span style={{ color:cor.mwRev>0?t.lbl:t.lblMuted, fontWeight:600 }}>{cor.mwRev>0?fmt(cor.mwRev):'—'}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : <div style={{ color:t.lblMuted, fontSize:'0.58rem' }}>No NTC data available.</div>}

            {/* Corridor bar chart for this country */}
            {(() => {
              const countryCorrData = tradeCorridors.filter(c=>c.isCountry);
              if (!countryCorrData.length) return null;
              return (
                <div style={{ marginTop:4 }}>
                  <SectionTitle t={t}>This country's corridors (MW)</SectionTitle>
                  <CJChart type="bar" height={Math.min(countryCorrData.length*22+30, 200)}
                    data={{ labels: countryCorrData.map(c=>`${c.z}↔${c.z2}`),
                      datasets:[{ data:countryCorrData.map(c=>Math.max(c.mwFwd,c.mwRev)),
                        backgroundColor:hexA('#f0b030',0.75), borderWidth:0, barThickness:12 }] }}
                    options={{ ...cjDefaults(t), indexAxis:'y',
                      scales: {
                        x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}},
                        y:{grid:{display:false},ticks:{color:t.muted,font:{size:7}}},
                      }}}
                  />
                </div>
              );
            })()}
          </div>
        )}

        {/* ════════ ABOUT ═══════════════════════════════════════════════════════ */}
        {activeTab === 'about' && (
          <div style={{ fontSize:'0.58rem', color:t.muted, lineHeight:1.7 }}>
            <div style={{ fontWeight:700, color:t.lbl, marginBottom:6 }}>{countryNameDecoded}</div>
            <div>Zones: {countryZoneIds.join(', ')||'—'}</div>
            <div style={{ marginTop:4 }}>Part of <b style={{color:t.lbl}}>{region.name}</b> EPM study</div>
            {region.epm && <div style={{ marginTop:2 }}>Branch: <code style={{fontSize:'0.52rem'}}>{region.epm.branch}</code></div>}
          </div>
        )}

      </div>
    </div>
  );
}
