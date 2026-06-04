import { useEffect, useRef, useState, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import { useTheme } from '../App';
import { getT, mapStyle } from '../constants';
import {
  fetchEpmCSV, fetchLinestringGeoJSON, fetchZonesGeoJSON, fetchGitHubDir, fetchResultCSV,
  processTechFuel, processYearlyZone, processDispatchResults, processHourlyPrice,
  processHours, processTransmissionResults, processPlants, processCosts,
  computeCentroid, normalizeFuel, EPM_FUEL_COLORS, resultYears,
} from '../utils/epmFetch';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAP_PALETTE = ['#1B6CA8','#36B5B5','#E8C547','#4DA6FF','#4169E1','#85C1E9','#2E9EC8','#5EBCBA','#1A5276','#7EC8E3','#14A094','#4CAFE8','#EDD770','#AED6F1','#1F618D','#0A6B70'];

const TECHFUEL_COLORS = {
  Nuclear:'#C8A8F0', Coal:'#808890', Peat:'#A0856C', 'Domestic Coal':'#6A5C4C',
  Gas:'#9A7040', CCGT:'#B8921A', OCGT:'#C4A820', Methane:'#D4B030',
  Diesel:'#6A7888', HFO:'#7A7068', Oil:'#7A7068',
  Biomass:'#52C860', Waste:'#8A9098', Biogas:'#72DC8A', Geothermal:'#D4A820',
  Reservoir:'#1E9AF5', ROR:'#5DADE2', PSH:'#0D7680', 'Run-of-River':'#5DADE2', ReservoirHydro:'#1E9AF5',
  Solar:'#FFD700', PV:'#FFD700', CSP:'#E8C547', RPV:'#FFD700',
  'Onshore Wind':'#44DAEC', OnshoreWind:'#44DAEC', ST:'#C8A8F0',
  'Offshore Wind':'#7CC8FA', OffshoreWind:'#7CC8FA',
  Battery:'#A3D5FF', Storage:'#AED6F1', 'PV+Storage':'#C8E860',
  Imports:'#E8C547', Demand:'#9B59B6', ICE:'#6A7888',
};
function techColor(tf) { return TECHFUEL_COLORS[tf] || EPM_FUEL_COLORS[normalizeFuel(tf)] || '#AAAAAA'; }

const COST_COLORS = {
  'Fuel costs: $m':'#9A7040', 'Fixed O&M: $m':'#1E9AF5', 'Variable O&M: $m':'#44DAEC',
  'Investment costs: $m':'#C8A8F0', 'Carbon costs: $m':'#808890', 'Transmission costs: $m':'#E8C547',
  'VRE curtailment: $m':'#FFD700', 'Variable Cost: $m':'#5DADE2',
  'Import costs with internal zones: $m':'#E53935', 'Import costs with external zones: $m':'#C0392B',
  'Export revenues with internal zones: $m':'#52C860', 'Export revenues with external zones: $m':'#27AE60',
};
const COST_LABELS = {
  'Fuel costs: $m':'Fuel', 'Fixed O&M: $m':'Fixed O&M', 'Variable O&M: $m':'Variable O&M',
  'Investment costs: $m':'Investment', 'Carbon costs: $m':'Carbon', 'Transmission costs: $m':'Transmission',
  'VRE curtailment: $m':'VRE curtailment', 'Variable Cost: $m':'Variable cost',
  'Import costs with internal zones: $m':'Internal imports', 'Import costs with external zones: $m':'External imports',
  'Export revenues with internal zones: $m':'Internal exports', 'Export revenues with external zones: $m':'External exports',
};
const MAIN_COST_CATS = ['Fuel costs: $m','Fixed O&M: $m','Variable O&M: $m','Investment costs: $m','Carbon costs: $m','VRE curtailment: $m','Transmission costs: $m'];
function costColor(cat) { return COST_COLORS[cat] || '#888888'; }

const INDICATORS = [
  { key:'CapacityTechFuel',             label:'Capacity (MW)',             source:'techFuel',   unit:'MW' },
  { key:'EnergyTechFuelComplete',       label:'Energy (GWh)',              source:'techFuel',   unit:'GWh' },
  { key:'NewCapacityTechFuel',          label:'New Capacity (MW)',         source:'techFuel',   unit:'MW' },
  { key:'NewCapacityTechFuelCumulated', label:'Cum. New Capacity (MW)',    source:'techFuel',   unit:'MW' },
  { key:'ReserveSpinningTechFuel',      label:'Spinning Reserve (GWh)',    source:'techFuel',   unit:'GWh' },
  { key:'CostsBreakdown',               label:'Costs breakdown (m USD)',   source:'costs',      unit:'m USD' },
  { key:'Costs',                        label:'Costs total (m USD)',       source:'yearlyZone', unit:'m USD' },
  { key:'CapexInvestmentComponent',     label:'CAPEX (m USD)',             source:'yearlyZone', unit:'m USD' },
  { key:'GenCostsPerMWh',               label:'Gen Cost (USD/MWh)',        source:'yearlyZone', unit:'USD/MWh' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n, d = 0) { if (n == null || isNaN(n)) return '—'; return n.toLocaleString('en-US', { maximumFractionDigits: d }); }
function fmtBig(n) { if (!n) return '—'; const a=Math.abs(n); if(a>=1e9)return`${(n/1e9).toFixed(1)}B`; if(a>=1e6)return`${(n/1e6).toFixed(1)}M`; if(a>=1e3)return`${(n/1e3).toFixed(1)}k`; return n.toFixed(1); }
function hexA(hex, a) { if (!hex||hex.length<7) return `rgba(128,128,128,${a})`; const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16); return `rgba(${r},${g},${b},${a})`; }
function cjDefaults(t) { return { responsive:true,maintainAspectRatio:false, plugins:{legend:{display:false},tooltip:{backgroundColor:t.panel,borderColor:t.panelBorder,borderWidth:1,titleColor:t.lbl,bodyColor:t.muted,titleFont:{size:9},bodyFont:{size:9},padding:6}}, scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}}},y:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}}}}}; }

function priceColor(t_) {
  // t_ = 0-1: white → #1B6CA8 (medium blue)
  return `rgb(${Math.round(255-t_*(255-27))},${Math.round(255-t_*(255-108))},${Math.round(255-t_*(255-168))})`;
}
function priceBarColor(t_) {
  // #2E9EC8 (trade blue, low) → #E8C547 (trade gold, high)
  return `rgb(${Math.round(46+t_*(232-46))},${Math.round(158+t_*(197-158))},${Math.round(200+t_*(71-200))})`;
}

function CJChart({ type, data, options, height, plugins: ep, cacheKey }) {
  const ref=useRef(null); const chart=useRef(null);
  const sig=JSON.stringify({type,labels:data.labels,ck:cacheKey,ds:data.datasets?.map(d=>({l:d.label,n:d.data?.length,t:d.type}))});
  useEffect(()=>{ const CJ=window.Chart; if(!CJ||!ref.current)return; chart.current?.destroy(); chart.current=new CJ(ref.current,{type,data,options,plugins:ep||[]}); return()=>{chart.current?.destroy();chart.current=null;}; },[sig]); // eslint-disable-line
  return <div style={{height,width:'100%',position:'relative'}}><canvas ref={ref}/></div>;
}
function SectionTitle({ t, children, right }) {
  return <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
    <div style={{fontSize:'0.47rem',letterSpacing:'2px',fontWeight:700,color:t.lblMuted,textTransform:'uppercase'}}>{children}</div>{right}
  </div>;
}
function Pill({ active, onClick, children }) {
  return <button onClick={onClick} style={{fontSize:'0.44rem',fontFamily:'inherit',padding:'2px 7px',borderRadius:3,cursor:'pointer',border:`1px solid ${active?'rgba(74,143,204,0.65)':'rgba(128,160,192,0.2)'}`,backgroundColor:active?'rgba(74,143,204,0.12)':'transparent',color:active?'rgba(74,143,204,1)':'rgba(128,160,192,0.7)',fontWeight:active?600:400}}>{children}</button>;
}
function DownloadBtn({ url, filename, t }) {
  const [busy, setBusy] = useState(false);
  const handle = async () => {
    setBusy(true);
    try {
      const res = await fetch(url); const text = await res.text();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text],{type:'text/csv'}));
      a.download = filename; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),100);
    } catch { window.open(url,'_blank'); } finally { setBusy(false); }
  };
  return <button onClick={handle} disabled={busy} title={filename} style={{display:'flex',alignItems:'center',gap:3,fontSize:'0.42rem',fontFamily:'inherit',padding:'3px 8px',borderRadius:3,cursor:'pointer',border:`1px solid ${t.panelBorder}`,backgroundColor:'transparent',color:t.muted,opacity:busy?0.5:1}}>
    <span style={{fontSize:'0.6rem'}}>{busy?'…':'↓'}</span><span>{filename.replace('.csv','')}</span>
  </button>;
}

function OverviewPie({ tfs, data, total, unitDiv, unitLbl, t }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const SZ = 76, cx = SZ/2, cy = SZ/2, oR = SZ/2 - 2, iR = oR * 0.52;
    canvas.width = Math.round(SZ*dpr); canvas.height = Math.round(SZ*dpr);
    canvas.style.width = SZ+'px'; canvas.style.height = SZ+'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const tot = data.reduce((a,b) => a+b, 0);
    let ang = -Math.PI/2;
    tfs.forEach((tf, i) => {
      const sw = (data[i]/tot)*2*Math.PI;
      ctx.beginPath(); ctx.moveTo(cx+iR*Math.cos(ang), cy+iR*Math.sin(ang));
      ctx.arc(cx, cy, oR, ang, ang+sw); ctx.arc(cx, cy, iR, ang+sw, ang, true);
      ctx.closePath(); ctx.fillStyle = TECHFUEL_COLORS[tf]||EPM_FUEL_COLORS[normalizeFuel(tf)]||'#AAA'; ctx.fill();
      ang += sw;
    });
    ctx.beginPath(); ctx.arc(cx, cy, iR-0.5, 0, 2*Math.PI);
    ctx.fillStyle = t.isDark ? 'rgba(15,20,30,0.88)' : 'rgba(245,248,252,0.92)'; ctx.fill();
    const v = (total/unitDiv); const vs = v>=10 ? v.toFixed(0) : v.toFixed(1);
    ctx.fillStyle = t.isDark ? 'rgba(255,255,255,0.95)' : 'rgba(15,30,60,0.9)';
    ctx.font = 'bold 10px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(vs, cx, cy-4);
    ctx.fillStyle = t.isDark ? 'rgba(255,255,255,0.5)' : 'rgba(60,80,120,0.6)';
    ctx.font = '7.5px system-ui,sans-serif'; ctx.fillText(unitLbl, cx, cy+7);
  }, [tfs, data, total, unitDiv, unitLbl, t]); // eslint-disable-line
  return <canvas ref={ref} style={{ display:'block', flexShrink:0 }} />;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ResultsRegionPage() {
  const { regionId } = useParams();
  const { theme }    = useTheme();
  const t            = getT(theme);
  const navigate     = useNavigate();

  const containerRef  = useRef(null); const mapRef = useRef(null);
  const dotMarkersRef = useRef([]);
  const pieMarkersRef = useRef([]);
  // Refs for map popup closures (avoid stale state)
  const resultsDataRef  = useRef({});
  const refYearRef      = useRef(null);
  const ovScenarioRef   = useRef(null);
  const hoursDataRef    = useRef({});

  // ── State ──────────────────────────────────────────────────────────────────
  const [region,       setRegion]       = useState(null);
  const [zcmapRows,    setZcmapRows]    = useState([]);
  const [zonesGJ,      setZonesGJ]      = useState(null);
  const [linestringGJ, setLinestringGJ] = useState(null);
  const [hoursData,    setHoursData]    = useState({});
  const [runList,      setRunList]      = useState([]);
  const [simRun,       setSimRun]       = useState(null);
  const [scenarioList, setScenarioList] = useState([]);
  const [resultsData,  setResultsData]  = useState({});
  const [loadingRuns,  setLoadingRuns]  = useState(false);
  const [loadingData,  setLoadingData]  = useState(false);
  const [activeTab,    setActiveTab]    = useState('overview');
  const [refYear,      setRefYear]      = useState(null);
  const [ovScenario,   setOvScenario]   = useState(null);
  const [ovMixMode,    setOvMixMode]    = useState('zone');
  const [evIndicator,  setEvIndicator]  = useState('CapacityTechFuel');
  const [evScenarios,  setEvScenarios]  = useState(new Set());
  const [evCountry,    setEvCountry]    = useState('all');
  const [dispScenario, setDispScenario] = useState(null);
  const [dispZone,     setDispZone]     = useState(null);
  const [dispMode,     setDispMode]     = useState('full');
  const [dispSeason,   setDispSeason]   = useState('Q1');
  const [dispDay,      setDispDay]      = useState('avg');
  const [trScenario,   setTrScenario]   = useState(null);
  const [trViewMode,   setTrViewMode]   = useState('netbar');   // 'netbar' | 'evolution'
  const [trEvMetric,   setTrEvMetric]   = useState('volume');   // 'volume' | 'capacity'
  const [trEvSplit,    setTrEvSplit]     = useState(false);
  const [plScenario,   setPlScenario]   = useState(null);
  const [plIndicator,  setPlIndicator]  = useState('CapacityPlant');
  const [plTopN,       setPlTopN]       = useState(20);
  const [plShowBubble,   setPlShowBubble]   = useState(false);
  const [panelWidth,     setPanelWidth]     = useState(560);
  const [mapLoadedCount, setMapLoadedCount] = useState(0);
  const [hiddenMap,      setHiddenMap]      = useState({}); // { chartId: Set<label> }
  const [pieDispMode,    setPieDispMode]    = useState('none'); // 'none'|'capacity'|'energy'
  const isDraggingRef = useRef(false);
  const dragStartX    = useRef(0);
  const dragStartW    = useRef(0);

  const toggleHidden = (chartId, label) => setHiddenMap(prev => {
    const s = new Set(prev[chartId] || []);
    s.has(label) ? s.delete(label) : s.add(label);
    return { ...prev, [chartId]: s };
  });
  const isHidden = (chartId, label) => hiddenMap[chartId]?.has(label) || false;

  // ── Sync refs ──────────────────────────────────────────────────────────────
  useEffect(() => { resultsDataRef.current = resultsData; }, [resultsData]);
  useEffect(() => { refYearRef.current = refYear; }, [refYear]);
  useEffect(() => { ovScenarioRef.current = ovScenario; }, [ovScenario]);
  useEffect(() => { hoursDataRef.current = hoursData; }, [hoursData]);

  // ── Load region + geo ──────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/data/regions.json').then(r=>r.json()).then(d => {
      const r=(d.regions||[]).find(r=>r.id===regionId); setRegion(r||null);
    });
  }, [regionId]);

  useEffect(() => {
    if (!region?.epm) return;
    const { branch, dataFolder } = region.epm;
    Promise.all([
      fetchEpmCSV(branch, dataFolder, 'zcmap.csv'),
      fetchZonesGeoJSON(branch, dataFolder),
      fetchLinestringGeoJSON(branch, dataFolder),
      fetchEpmCSV(branch, dataFolder, 'pHours.csv'),
    ]).then(([zc, zGJ, lGJ, hr]) => {
      setZcmapRows(zc||[]); setZonesGJ(zGJ); setLinestringGJ(lGJ);
      if (hr) setHoursData(processHours(hr));
    });
  }, [region]);

  // ── Load runs / scenarios / data ───────────────────────────────────────────
  useEffect(() => {
    if (!region?.epm) return;
    setLoadingRuns(true);
    fetchGitHubDir(region.epm.branch, 'epm/output').then(items => {
      const runs = (items||[]).filter(i=>i.type==='dir').map(i=>i.name).sort().reverse();
      setRunList(runs); if (runs.length) setSimRun(runs[0]);
    }).finally(()=>setLoadingRuns(false));
  }, [region]);

  useEffect(() => {
    if (!region?.epm || !simRun) return;
    fetchGitHubDir(region.epm.branch, `epm/output/${simRun}`).then(items => {
      const scens = (items||[]).filter(i=>i.type==='dir').map(i=>i.name).sort();
      setScenarioList(scens); setEvScenarios(new Set(scens));
      if (scens.length) { setOvScenario(scens[0]); setDispScenario(scens[0]); setTrScenario(scens[0]); setPlScenario(scens[0]); }
    });
  }, [region, simRun]);

  useEffect(() => {
    if (!region?.epm || !simRun || !scenarioList.length) return;
    setLoadingData(true);
    const { branch } = region.epm;
    Promise.all(scenarioList.map(async scen => {
      const [tfR, yzR, dpR, prR, txR, plR, coR] = await Promise.all([
        fetchResultCSV(branch, simRun, scen, 'pTechFuelMerged.csv'),
        fetchResultCSV(branch, simRun, scen, 'pYearlyZoneMerged.csv'),
        fetchResultCSV(branch, simRun, scen, 'pDispatchComplete.csv'),
        fetchResultCSV(branch, simRun, scen, 'pHourlyPrice.csv'),
        fetchResultCSV(branch, simRun, scen, 'pTransmissionMerged.csv'),
        fetchResultCSV(branch, simRun, scen, 'pPlantMerged.csv'),
        fetchResultCSV(branch, simRun, scen, 'pCostsMerged.csv'),
      ]);
      return { scen,
        techFuel:     tfR  ? processTechFuel(tfR)              : {},
        yearlyZone:   yzR  ? processYearlyZone(yzR)            : {},
        dispatch:     dpR  ? processDispatchResults(dpR)       : {},
        price:        prR  ? processHourlyPrice(prR)           : {},
        transmission: txR  ? processTransmissionResults(txR)   : {},
        plants:       plR  ? processPlants(plR)                : [],
        costs:        coR  ? processCosts(coR)                 : {},
      };
    })).then(results => {
      const rd = Object.fromEntries(results.map(r=>[r.scen, r]));
      setResultsData(rd);
      const yrs = resultYears(results[0]?.techFuel||{});
      if (yrs.length) setRefYear(yrs[0]);
    }).finally(()=>setLoadingData(false));
  }, [region, simRun, scenarioList]); // eslint-disable-line

  // ── Map ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || !region || !zonesGJ) return;

    const zcMap = Object.fromEntries(zcmapRows.map(r=>[r.z, r.c]));
    const regionCountries = [...new Set(zcmapRows.map(r=>r.c))].sort();
    const colorMap = {};
    regionCountries.forEach((c,i) => { colorMap[c] = MAP_PALETTE[i%MAP_PALETTE.length]; });
    const zoneCentroids = {};
    for (const f of zonesGJ.features) {
      const z=f.properties.z; if (z) { const c=computeCentroid(f.geometry); if(c) zoneCentroids[z]=c; }
    }
    const lons=Object.values(zoneCentroids).map(c=>c[0]);
    const lats=Object.values(zoneCentroids).map(c=>c[1]);
    const bounds=lons.length?[[Math.min(...lons)-2,Math.min(...lats)-2],[Math.max(...lons)+2,Math.max(...lats)+2]]:null;

    const map = new maplibregl.Map({
      container:containerRef.current, style:mapStyle(theme),
      center:[lons.length?lons.reduce((a,b)=>a+b,0)/lons.length:20, lats.length?lats.reduce((a,b)=>a+b,0)/lats.length:0],
      zoom:4, minZoom:1, maxZoom:14, attributionControl:false,
    });
    mapRef.current = map;
    const popup = new maplibregl.Popup({ closeButton:false, closeOnClick:false, offset:10, className:`popup-${theme}` });

    map.on('load', async () => {
      const tv = getT(theme);
      if (bounds) map.fitBounds(bounds, { padding:60, duration:0, maxZoom:8 });

      // SDF arrow image (white triangle = inside, supports icon-color)
      const aW=14, aH=12;
      const aData = new Uint8Array(aW*aH*4).fill(0);
      for (let y=0;y<aH;y++) {
        const h=aH/2; const xMax=Math.round(y<=h?(y/h)*aW*0.85:((aH-y)/h)*aW*0.85);
        for (let x=0;x<xMax;x++) { const i=(y*aW+x)*4; aData[i]=255;aData[i+1]=255;aData[i+2]=255;aData[i+3]=255; }
      }
      if (!map.hasImage('ntc-arrow')) map.addImage('ntc-arrow', { width:aW, height:aH, data:aData }, { sdf:true });

      const countries = await fetch('/data/countries_10m.geojson').then(r=>r.json());
      countries.features.forEach((f,i)=>{ f.id=i; });
      map.addSource('countries', { type:'geojson', data:countries, generateId:false });
      map.addLayer({ id:'land',    type:'fill', source:'countries', paint:{'fill-color':tv.land,'fill-opacity':1} });
      map.addLayer({ id:'borders', type:'line', source:'countries', paint:{'line-color':tv.worldBdr,'line-width':tv.worldBdrW} });

      const isoToCountry = {};
      for (const f of zonesGJ.features) isoToCountry[f.properties.ISO_A3]=f.properties.c;
      const uniqueIsos = [...new Set(zonesGJ.features.map(f=>f.properties.ISO_A3))];
      const fillExpr = ['match',['get','ISO_A3'],...uniqueIsos.flatMap(iso=>[iso,colorMap[isoToCountry[iso]]||'#888']),'transparent'];

      map.addSource('zones', { type:'geojson', data:zonesGJ, generateId:true });
      map.addLayer({ id:'zone-fill',   type:'fill', source:'zones', paint:{'fill-color':fillExpr,'fill-opacity':0.22} });
      map.addLayer({ id:'zone-hover',  type:'fill', source:'zones', filter:['==',['get','z'],''], paint:{'fill-color':fillExpr,'fill-opacity':0.55} });
      map.addLayer({ id:'zone-border', type:'line', source:'zones', paint:{'line-color':fillExpr,'line-width':1.2,'line-opacity':0.75} });

      // NTC lines — empty source, updated separately
      map.addSource('ntc-results', { type:'geojson', data:{type:'FeatureCollection',features:[]} });
      map.addLayer({ id:'ntc-bg', type:'line', source:'ntc-results',
        paint:{ 'line-color':['interpolate',['linear'],['get','util'],0,'#FFD700',0.5,'#FF8C00',1,'#E53935'],
          'line-width':['interpolate',['linear'],['get','vol'],0,1,500,2.5,5000,5], 'line-opacity':0.88 } });
      map.addLayer({ id:'ntc-arrows', type:'symbol', source:'ntc-results',
        layout:{ 'icon-image':'ntc-arrow', 'icon-allow-overlap':false, 'symbol-placement':'line', 'symbol-spacing':55, 'icon-rotation-alignment':'map', 'icon-pitch-alignment':'viewport', 'icon-size':0.9 },
        paint:{ 'icon-color':['interpolate',['linear'],['get','util'],0,'#FFD700',0.5,'#FF8C00',1,'#E53935'] } });

      // Hover on NTC line
      map.on('mouseenter','ntc-bg',e=>{
        map.getCanvas().style.cursor='pointer';
        const p=e.features[0].properties;
        popup.setLngLat(e.lngLat).setHTML(
          `<b>${p.z} ↔ ${p.z2}</b><br>` +
          `<span style="opacity:.8;font-size:0.8em">Interchange ${p.yr}: ${fmtBig(p.fwd)} GWh (fwd) / ${fmtBig(p.rev)} GWh (rev)<br>` +
          `Utilization: ${p.util!=null?(parseFloat(p.util)*100).toFixed(0)+'%':'—'} &nbsp;·&nbsp; Capacity: ${fmtBig(parseFloat(p.cap)||0)} MW</span>`
        ).addTo(map);
      });
      map.on('mouseleave','ntc-bg',()=>{ map.getCanvas().style.cursor=''; popup.remove(); });

      // Zone hover — per-zone stats
      let hovZ=null;
      map.on('mousemove','zone-fill',e=>{
        map.getCanvas().style.cursor='pointer';
        const z=e.features[0].properties.z||''; const c=isoToCountry[e.features[0].properties.ISO_A3]||'';
        if (z!==hovZ) { hovZ=z; map.setFilter('zone-hover',['==',['get','z'],z]); }
        const rd=resultsDataRef.current; const yr=refYearRef.current;
        const scen=ovScenarioRef.current; const sd=rd[scen]||Object.values(rd)[0];
        let statsHtml='';
        if (sd && yr && z) {
          const cap = Object.values(sd.techFuel[z]?.CapacityTechFuel?.[yr]||{}).reduce((a,b)=>a+b,0)/1000;
          const dem = (sd.yearlyZone[z]?.DemandEnergyZone?.[yr]||0)/1000;
          const netImp = (sd.yearlyZone[z]?.NetImport?.[yr]||0)/1000;
          const hd=hoursDataRef.current;
          const zP=sd.price[z]?.[yr]||{}; let tw=0,tp=0;
          for(const[q,days]of Object.entries(zP))for(const[d,hrs]of Object.entries(days)){const w=hd[q]?.[d]||0;for(const p of Object.values(hrs)){tp+=p*w;tw+=w;}}
          const avgP=tw>0?tp/tw:null;
          statsHtml=`<br><span style="opacity:.8;font-size:0.78em">` +
            `${c?`Country: ${c}<br>`:''}` +
            `Installed: ${cap.toFixed(1)} GW &nbsp; Demand: ${dem.toFixed(0)} TWh<br>` +
            `Net import: ${netImp>=0?'+':''}${netImp.toFixed(0)} TWh` +
            `${avgP!=null?` &nbsp; Avg price: ${avgP.toFixed(1)} $/MWh`:''}</span>`;
        }
        popup.setLngLat(e.lngLat).setHTML(`<b>${z||c}</b>${statsHtml}<br><span style="opacity:.5;font-size:0.7em">click to explore country</span>`).addTo(map);
      });
      map.on('mouseleave','zone-fill',()=>{ map.getCanvas().style.cursor=''; hovZ=null; map.setFilter('zone-hover',['==',['get','z'],'']),popup.remove(); });
      map.on('click','zone-fill',e=>{ const c=isoToCountry[e.features[0].properties.ISO_A3]||''; navigate(`/region/${regionId}/results/country/${encodeURIComponent(c)}`); });
      // Fire AFTER all sources/layers are added so NTC update effect can find the source
      setMapLoadedCount(c => c + 1);
    });

    return () => { popup.remove(); dotMarkersRef.current.forEach(m=>m.remove()); dotMarkersRef.current=[]; pieMarkersRef.current.forEach(m=>m.remove()); pieMarkersRef.current=[]; mapRef.current?.remove(); };
  }, [region, theme, zonesGJ, zcmapRows]); // eslint-disable-line

  // ── Update NTC + price dots when data changes ────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource('ntc-results') || !refYear) return;
    const sd = resultsData[ovScenario] || Object.values(resultsData)[0];
    if (!sd) return;
    const tx = sd.transmission;
    const zcCentroids = {};
    if (zonesGJ) for (const f of zonesGJ.features) { const z=f.properties.z; if(z){const c=computeCentroid(f.geometry);if(c)zcCentroids[z]=c;} }

    const seen = new Set(); const features = [];
    for (const [z, z2map] of Object.entries(tx)) {
      for (const [z2, attrs] of Object.entries(z2map)) {
        const key=[z,z2].sort().join('||'); if(seen.has(key))continue; seen.add(key);
        const fwd = attrs.Interchange?.[refYear]||0;
        const rev = tx[z2]?.[z]?.Interchange?.[refYear]||0;
        const util = attrs.InterconUtilization?.[refYear]||tx[z2]?.[z]?.InterconUtilization?.[refYear]||0;
        const cap  = attrs.TransmissionCapacity?.[refYear]||tx[z2]?.[z]?.TransmissionCapacity?.[refYear]||0;
        const vol  = Math.abs(fwd)+Math.abs(rev);
        if (vol===0 && cap===0) continue;
        let coords = null;
        const lf = linestringGJ?.features?.find(f=>(f.properties.z===z&&(f.properties.z_other||f.properties.z2)===z2)||(f.properties.z===z2&&(f.properties.z_other||f.properties.z2)===z));
        if (lf) coords=lf.geometry.coordinates;
        else if (zcCentroids[z]&&zcCentroids[z2]) coords=[zcCentroids[z],zcCentroids[z2]];
        if (!coords) continue;
        // Direction: use fwd direction if fwd > rev, reverse coords otherwise
        const finalCoords = fwd >= rev ? coords : [...coords].reverse();
        features.push({ type:'Feature', properties:{ z, z2, fwd, rev, util:Math.min(1,Math.max(0,util)), vol, cap, yr:refYear }, geometry:{ type:'LineString', coordinates:finalCoords } });
      }
    }
    map.getSource('ntc-results').setData({ type:'FeatureCollection', features });
  }, [resultsData, refYear, ovScenario, zonesGJ, linestringGJ, mapLoadedCount]); // eslint-disable-line

  // ── Update price dots ────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    dotMarkersRef.current.forEach(m=>m.remove()); dotMarkersRef.current=[];
    const sd = resultsData[ovScenario]||Object.values(resultsData)[0];
    if (!sd || !refYear || !zonesGJ) return;
    const tv = getT(theme);
    const zcCentroids = {};
    for (const f of zonesGJ.features) { const z=f.properties.z; if(z){const c=computeCentroid(f.geometry);if(c)zcCentroids[z]=c;} }
    // Compute avg price per zone
    const prices = {};
    for (const [z, yearmap] of Object.entries(sd.price)) {
      const qmap=yearmap[refYear]||{};
      let tw=0,tp=0;
      for(const[q,days]of Object.entries(qmap))for(const[d,hrs]of Object.entries(days)){const w=hoursData[q]?.[d]||0;for(const p of Object.values(hrs)){tp+=p*w;tw+=w;}}
      if(tw>0) prices[z]=tp/tw;
    }
    const vals=Object.values(prices); if(!vals.length)return;
    const minP=Math.min(...vals), maxP=Math.max(...vals), rng=maxP-minP||1;
    for (const [z, price] of Object.entries(prices)) {
      const coord=zcCentroids[z]; if(!coord)continue;
      const t_=(price-minP)/rng;
      const color=priceColor(t_);
      const el=document.createElement('div');
      el.style.cssText=`width:10px;height:10px;border-radius:50%;background:${color};border:1.5px solid rgba(255,255,255,0.7);box-shadow:0 1px 4px rgba(0,0,0,0.4);cursor:pointer;`;
      el.title=`${z}: ${price.toFixed(1)} USD/MWh`;
      dotMarkersRef.current.push(new maplibregl.Marker({element:el,anchor:'center'}).setLngLat(coord).addTo(map));
    }
  }, [resultsData, refYear, ovScenario, zonesGJ, hoursData, theme, mapLoadedCount]); // eslint-disable-line

  // ── Zone mix pie markers ──────────────────────────────────────────────────
  useEffect(() => {
    pieMarkersRef.current.forEach(m=>m.remove()); pieMarkersRef.current=[];
    const map=mapRef.current;
    if(!map||pieDispMode==='none'||!zonesGJ||!refYear)return;
    const sd=resultsData[ovScenario]||Object.values(resultsData)[0]; if(!sd)return;
    const attr=pieDispMode==='capacity'?'CapacityTechFuel':'EnergyTechFuelComplete';
    const unitDiv=1000; const unitLbl=pieDispMode==='capacity'?'GW':'TWh';
    const isDk=t.isDark;
    const allZonesList=zcmapRows.map(r=>r.z);
    const zcC={}; for(const f of zonesGJ.features){const z=f.properties.z;if(z){const c=computeCentroid(f.geometry);if(c)zcC[z]=c;}}
    // Pre-compute zone avg prices for center color
    const zPrices={};
    for(const z of allZonesList){const qmap=sd.price[z]?.[refYear]||{};let tw=0,tp=0;for(const[q,days]of Object.entries(qmap))for(const[d,hrs]of Object.entries(days)){const w=hoursData[q]?.[d]||0;for(const p of Object.values(hrs)){tp+=p*w;tw+=w;}}if(tw>0)zPrices[z]=tp/tw;}
    const pVals=Object.values(zPrices); const pMin=pVals.length?Math.min(...pVals):0; const pRng=pVals.length?Math.max(...pVals)-pMin||1:1;
    const SZ=44,dpr=window.devicePixelRatio||1,cx=SZ/2,cy=SZ/2,oR=SZ/2-1.5,iR=oR*0.50;
    for(const z of allZonesList){
      const coord=zcC[z]; if(!coord)continue;
      const data=sd.techFuel[z]?.[attr]?.[refYear]; if(!data)continue;
      const entries=Object.entries(data).filter(([,v])=>v>0);
      if(!entries.length)continue;
      const total=entries.reduce((s,[,v])=>s+v,0); if(total<=0)continue;
      const canvas=document.createElement('canvas');
      canvas.width=Math.round(SZ*dpr); canvas.height=Math.round(SZ*dpr);
      canvas.style.width=SZ+'px'; canvas.style.height=SZ+'px';
      const ctx=canvas.getContext('2d');
      ctx.scale(dpr,dpr);
      ctx.shadowColor='rgba(0,0,0,0.35)'; ctx.shadowBlur=3; ctx.shadowOffsetY=1;
      let ang=-Math.PI/2;
      for(const[tf,val]of entries){const sw=(val/total)*2*Math.PI;ctx.beginPath();ctx.moveTo(cx+iR*Math.cos(ang),cy+iR*Math.sin(ang));ctx.arc(cx,cy,oR,ang,ang+sw);ctx.arc(cx,cy,iR,ang+sw,ang,true);ctx.closePath();ctx.fillStyle=techColor(tf);ctx.fill();ang+=sw;}
      ctx.shadowColor='transparent';
      // Center: price color (same gradient as price dots)
      const t_=zPrices[z]!=null?(zPrices[z]-pMin)/pRng:null;
      const centerBg=t_!=null?priceColor(t_).replace('rgb(','rgba(').replace(')',',0.92)'):(isDk?'rgba(15,20,30,0.88)':'rgba(245,248,252,0.92)');
      const lightBg=t_==null||t_<0.5;
      const textC=lightBg?'rgba(15,30,60,0.9)':'rgba(255,255,255,0.95)';
      const mutedC=lightBg?'rgba(60,80,120,0.65)':'rgba(255,255,255,0.55)';
      ctx.beginPath();ctx.arc(cx,cy,iR-0.5,0,2*Math.PI);ctx.fillStyle=centerBg;ctx.fill();
      const val=total/unitDiv; const valStr=val>=10?val.toFixed(0):val.toFixed(1);
      ctx.fillStyle=textC; ctx.font='bold 8px system-ui,sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(valStr,cx,cy-2.5);
      ctx.fillStyle=mutedC; ctx.font='6px system-ui,sans-serif'; ctx.fillText(unitLbl,cx,cy+6);
      canvas.title=`${z}: ${(total/unitDiv).toFixed(1)} ${unitLbl}`;
      pieMarkersRef.current.push(new maplibregl.Marker({element:canvas,anchor:'center'}).setLngLat(coord).addTo(map));
    }
  }, [pieDispMode, resultsData, ovScenario, refYear, zonesGJ, zcmapRows, hoursData, mapLoadedCount, theme]); // eslint-disable-line

  // ── Computed ───────────────────────────────────────────────────────────────
  const zoneToCountry = useMemo(()=>Object.fromEntries(zcmapRows.map(r=>[r.z,r.c])),[zcmapRows]);
  const allZones      = useMemo(()=>zcmapRows.map(r=>r.z),[zcmapRows]);
  const allCountries  = useMemo(()=>[...new Set(zcmapRows.map(r=>r.c))].sort(),[zcmapRows]);
  const hasData       = Object.keys(resultsData).length>0;
  const allYears      = useMemo(()=>{ const f=Object.values(resultsData)[0]; return f?resultYears(f.techFuel):[]; },[resultsData]);
  const activeInd     = useMemo(()=>INDICATORS.find(i=>i.key===evIndicator)||INDICATORS[0],[evIndicator]);
  const evZones       = useMemo(()=>evCountry==='all'?allZones:allZones.filter(z=>zoneToCountry[z]===evCountry),[evCountry,allZones,zoneToCountry]);
  const allTechfuels  = useMemo(()=>{ const tfs=new Set(); for(const d of Object.values(resultsData)) for(const z of Object.values(d.techFuel)) for(const a of Object.values(z)) for(const y of Object.values(a)) for(const tf of Object.keys(y)) tfs.add(tf); return[...tfs].filter(t=>t!=='Demand').sort();},[resultsData]);

  const firstDisp      = Object.values(resultsData)[0]?.dispatch||{};
  const dispAvailS     = useMemo(()=>{ const qs=new Set(); for(const z of Object.values(firstDisp)) for(const yr of Object.values(z)) for(const q of Object.keys(yr)) qs.add(q); return[...qs].sort();},[firstDisp]);
  const dispAvailD     = useMemo(()=>{ const ds=new Set(); for(const z of Object.values(firstDisp)) for(const yr of Object.values(z)) for(const q of Object.values(yr)) for(const d of Object.keys(q)) ds.add(d); return[...ds].sort();},[firstDisp]);
  const totalDays      = useMemo(()=>Object.values(hoursData).reduce((s,dts)=>s+Object.values(dts||{}).reduce((a,b)=>a+b,0),0)||365,[hoursData]);
  const activeDispZone = dispZone||'__all__';

  // Explicit demand lookup — zone-specific or region total (independent of generation)
  const getDispDemand = (sd, zone, zones, year, s, d, h) => {
    const key = `t${h+1}`;
    if (zone === '__all__') return zones.reduce((sum, z) => sum + (sd.dispatch[z]?.[year]?.[s]?.[d]?.[key]?.Demand || 0), 0);
    return sd.dispatch[zone]?.[year]?.[s]?.[d]?.[key]?.Demand ?? null;
  };

  // Aggregate dispatch generation (excl. Demand) across zones when '__all__' selected
  const getZoneDisp = (sd, zone, year) => {
    if (zone !== '__all__') return sd.dispatch[zone]?.[year] || {};
    const agg = {};
    for (const z of allZones) {
      for (const [q, days] of Object.entries(sd.dispatch[z]?.[year]||{}))
        for (const [d, hours] of Object.entries(days))
          for (const [tt, tfs] of Object.entries(hours))
            for (const [tf, val] of Object.entries(tfs)) {
              if (!agg[q]) agg[q]={};if(!agg[q][d])agg[q][d]={};if(!agg[q][d][tt])agg[q][d][tt]={};
              agg[q][d][tt][tf]=(agg[q][d][tt][tf]||0)+val;
            }
    }
    return agg;
  };

  // Zone avg prices
  const zoneAvgPrices = useMemo(()=>{
    const sd=resultsData[ovScenario]||Object.values(resultsData)[0]; if(!sd||!refYear)return{};
    const res={};
    for(const[z,yearmap] of Object.entries(sd.price)){const qmap=yearmap[refYear]||{};let tw=0,tp=0; for(const[q,days]of Object.entries(qmap))for(const[d,hrs]of Object.entries(days)){const w=hoursData[q]?.[d]||0;for(const p of Object.values(hrs)){tp+=p*w;tw+=w;}} if(tw>0)res[z]=tp/tw;}
    return res;
  },[resultsData,ovScenario,refYear,hoursData]);

  const zonePriceRange = useMemo(()=>{
    const sd=resultsData[ovScenario]||Object.values(resultsData)[0]; if(!sd||!refYear)return{};
    const res={};
    for(const[z,yearmap] of Object.entries(sd.price)){
      const qmap=yearmap[refYear]||{}; let pmin=Infinity,pmax=-Infinity;
      for(const[,days]of Object.entries(qmap))for(const[,hrs]of Object.entries(days))for(const p of Object.values(hrs))if(p>0){if(p<pmin)pmin=p;if(p>pmax)pmax=p;}
      if(isFinite(pmin))res[z]={min:pmin,max:pmax};
    }
    return res;
  },[resultsData,ovScenario,refYear]);

  const priceVals = Object.values(zoneAvgPrices);
  const minPrice = priceVals.length?Math.min(...priceVals):0;
  const maxPrice = priceVals.length?Math.max(...priceVals):100;

  // Total trade
  const totalTradeGWh = useMemo(()=>{
    const tx=resultsData[ovScenario]?.transmission||{}; if(!refYear)return 0;
    const seen=new Set(); let total=0;
    for(const[z,z2map] of Object.entries(tx)) for(const[z2,attrs] of Object.entries(z2map)){const k=[z,z2].sort().join('||');if(seen.has(k))continue;seen.add(k);total+=Math.abs(attrs.Interchange?.[refYear]||0);}
    return total;
  },[resultsData,ovScenario,refYear]);

  if (!region) return <div style={{ padding:40, color:t.text }}>Loading…</div>;

  const selectStyle = { fontSize:'0.5rem',fontFamily:'inherit',padding:'2px 6px',borderRadius:3,border:`1px solid ${t.panelBorder}`,backgroundColor:t.panel,color:t.muted,cursor:'pointer' };
  const csvUrl = (scen, file) => `https://raw.githubusercontent.com/ESMAP-World-Bank-Group/EPM/${region.epm?.branch}/epm/output/${simRun}/${scen}/output_csv/${file}`;
  const DlRow = ({files}) => simRun&&files[0][0]?<div style={{marginTop:14,paddingTop:10,borderTop:`1px solid ${hexA(t.panelBorder,0.4)}`,display:'flex',gap:5,flexWrap:'wrap',alignItems:'center'}}><span style={{fontSize:'0.38rem',color:t.lblMuted}}>↓</span>{files.map(([sc,f])=><DownloadBtn key={f} url={csvUrl(sc,f)} filename={f} t={t}/>)}</div>:null;
  const TABS = ['overview','evolution','dispatch','trade','plants'];
  const TAB_LABELS = { overview:'Overview', evolution:'Evolution', dispatch:'Dispatch', trade:'Trade', plants:'Plants' };

  // ── Overview mix ────────────────────────────────────────────────────────────
  const buildOverviewMix = () => {
    const sd=resultsData[ovScenario]; if(!sd||!refYear)return null;
    const grp=ovMixMode==='zone'
      ?allZones.filter(z=>sd.techFuel[z]?.CapacityTechFuel?.[refYear])
      :allCountries.filter(c=>allZones.some(z=>zoneToCountry[z]===c&&sd.techFuel[z]?.CapacityTechFuel?.[refYear]));
    if(!grp.length)return null;
    const tfs=allTechfuels.filter(tf=>grp.some(g=>((ovMixMode==='zone'?sd.techFuel[g]?.CapacityTechFuel?.[refYear]?.[tf]:allZones.filter(z=>zoneToCountry[z]===g).reduce((s,z)=>s+(sd.techFuel[z]?.CapacityTechFuel?.[refYear]?.[tf]||0),0))||0)>0));
    return { labels:grp, datasets:tfs.map(tf=>({ label:tf, data:grp.map(g=>ovMixMode==='zone'?Math.round(sd.techFuel[g]?.CapacityTechFuel?.[refYear]?.[tf]||0):Math.round(allZones.filter(z=>zoneToCountry[z]===g).reduce((s,z)=>s+(sd.techFuel[z]?.CapacityTechFuel?.[refYear]?.[tf]||0),0))), backgroundColor:techColor(tf), borderWidth:0, barThickness:14, stack:'a' })) };
  };

  // ── Evolution ───────────────────────────────────────────────────────────────
  const buildEvolution = () => {
    const activeSc=scenarioList.filter(s=>evScenarios.has(s)); if(!activeSc.length||!allYears.length)return null;
    const ind=activeInd;
    if (ind.source==='costs') {
      const cats=MAIN_COST_CATS.filter(cat=>activeSc.some(s=>evZones.some(z=>(resultsData[s]?.costs[z]?.[cat])||false)));
      const datasets=[]; for(const scen of activeSc) for(const cat of cats) {
        datasets.push({ label:`${scen} — ${COST_LABELS[cat]||cat}`, data:allYears.map(y=>Math.round(evZones.reduce((s,z)=>s+(resultsData[scen]?.costs[z]?.[cat]?.[y]||0),0)*10)/10), backgroundColor:hexA(costColor(cat),activeSc.length>1?0.5:0.82), borderColor:costColor(cat), borderWidth:activeSc.length>1?1:0, stack:scen });
      }
      return { labels:allYears, datasets };
    }
    if (ind.source==='yearlyZone') {
      return { labels:allYears, datasets:activeSc.map((scen,i)=>({ label:scen, data:allYears.map(y=>+evZones.reduce((s,z)=>s+(resultsData[scen]?.yearlyZone[z]?.[ind.key]?.[y]||0),0).toFixed(2)), backgroundColor:hexA(['#3B82F6','#10B981','#F59E0B','#8B5CF6'][i%4],0.75), borderColor:['#3B82F6','#10B981','#F59E0B','#8B5CF6'][i%4], borderWidth:2, fill:false, tension:0.3, type:'line' })) };
    }
    const tfs=allTechfuels.filter(tf=>activeSc.some(s=>evZones.some(z=>(resultsData[s]?.techFuel[z]?.[ind.key]?.[allYears[0]]?.[tf]||0)>0)));
    const datasets=[]; for(const scen of activeSc) for(const tf of tfs) { datasets.push({ label:`${scen} — ${tf}`, data:allYears.map(y=>Math.round(evZones.reduce((s,z)=>s+(resultsData[scen]?.techFuel[z]?.[ind.key]?.[y]?.[tf]||0),0))), backgroundColor:hexA(techColor(tf),activeSc.length>1?0.5:0.85), borderColor:techColor(tf), borderWidth:activeSc.length>1?1:0, stack:scen }); }
    return { labels:allYears, datasets };
  };

  // ── Dispatch ────────────────────────────────────────────────────────────────
  const buildDispatch = () => {
    const sd=resultsData[dispScenario]; if(!sd||!activeDispZone||!refYear)return{chartData:{labels:[],datasets:[]},plugin:null};
    const zDisp=getZoneDisp(sd,activeDispZone,refYear); const isDark=t.isDark;
    const mcColor=isDark?'rgba(255,255,255,0.88)':'#1E3A8A';
    const seasons=dispAvailS, days=dispAvailD;
    if(dispMode==='full'&&seasons.length&&days.length){
      const nS=seasons.length,nDT=days.length,nPts=nS*nDT*24;
      const tfs=[...new Set(seasons.flatMap(q=>days.flatMap(d=>Object.values(zDisp[q]?.[d]||{}).flatMap(Object.keys))))].filter(t=>t!=='Demand').sort();
      const datasets=tfs.map(tf=>({label:tf,fill:true,data:seasons.flatMap(s=>days.flatMap(d=>Array.from({length:24},(_,h)=>zDisp[s]?.[d]?.[`t${h+1}`]?.[tf]||0))),backgroundColor:hexA(techColor(tf),0.7),borderColor:techColor(tf),borderWidth:0,pointRadius:0,tension:0,stack:'gen'}));
      const zP=activeDispZone==='__all__'?sd.price[allZones[0]]?.[refYear]||{}:sd.price[activeDispZone]?.[refYear]||{};
      const pd=seasons.flatMap(s=>days.flatMap(d=>Array.from({length:24},(_,h)=>zP[s]?.[d]?.[`t${h+1}`]||null)));
      if(pd.some(v=>v!=null))datasets.push({label:'Marginal cost',type:'line',data:pd,yAxisID:'yR',borderColor:mcColor,borderWidth:1,pointRadius:0,tension:0,fill:false,spanGaps:true,order:1});
      // Actual demand from dispatch (dark red dashed)
      const demData=seasons.flatMap(s=>days.flatMap(d=>Array.from({length:24},(_,h)=>{ const v=getDispDemand(sd,activeDispZone,allZones,refYear,s,d,h); return v!=null&&v>0?v:null; })));
      if(demData.some(v=>v!=null))datasets.push({label:'Demand',type:'line',data:demData,borderColor:'#8B0000',borderWidth:1,pointRadius:0,tension:0,fill:false,spanGaps:true,stack:'demand',order:1});
      const sepPlugin={id:'dSep',afterDatasetsDraw:(chart)=>{const{ctx,chartArea:ca,scales:sc}=chart;if(!ca)return;const dL=(data,yK,col,lw=1.5)=>{if(!data.some(v=>v!=null)||!sc[yK])return;ctx.save();ctx.beginPath();ctx.strokeStyle=col;ctx.lineWidth=lw;ctx.setLineDash([]);let mv=false;data.forEach((v,i)=>{if(v==null){mv=false;return;}const x=sc.x.getPixelForValue(i);const y=sc[yK].getPixelForValue(v);mv?ctx.lineTo(x,y):ctx.moveTo(x,y);mv=true;});ctx.stroke();ctx.restore();};dL(demData,'y','#CC0000');dL(pd,'yR',mcColor,1);},afterDraw:(chart)=>{
        const{ctx,chartArea,scales}=chart;if(!chartArea||!scales.x)return;
        const{top,bottom}=chartArea;const xS=scales.x;
        const dC=isDark?'rgba(255,255,255,0.13)':'rgba(0,0,0,0.12)';const sC=isDark?'rgba(255,255,255,0.36)':'rgba(0,0,0,0.30)';
        const tC=isDark?'rgba(255,255,255,0.46)':'rgba(0,0,0,0.40)';const seC=isDark?'rgba(255,255,255,0.70)':'rgba(0,0,0,0.58)';
        for(let si=0;si<nS;si++){const ss=si*nDT*24;ctx.save();ctx.font='700 9px system-ui,sans-serif';ctx.fillStyle=seC;ctx.textAlign='center';ctx.textBaseline='bottom';ctx.fillText(seasons[si],xS.getPixelForValue(ss+nDT*12),top-2);ctx.restore();
          for(let di=0;di<nDT;di++){const dts=ss+di*24;if(dts>0){const lx=xS.getPixelForValue(dts);const isS=di===0;ctx.save();ctx.strokeStyle=isS?sC:dC;ctx.lineWidth=isS?1.2:0.7;if(!isS)ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(lx,top);ctx.lineTo(lx,bottom);ctx.stroke();ctx.restore();}
            const midX=xS.getPixelForValue(dts+12);const w=hoursData?.[seasons[si]]?.[days[di]]||0;const pct=w>0?` (${((w/totalDays)*100).toFixed(0)}%)`:'';
            ctx.save();ctx.translate(midX,bottom+3);ctx.rotate(-Math.PI/2);ctx.font='7px system-ui,sans-serif';ctx.fillStyle=tC;ctx.textAlign='right';ctx.textBaseline='middle';ctx.fillText(`${days[di]}${pct}`,0,0);ctx.restore();
          }
        }
      }};
      return{chartData:{labels:new Array(nPts).fill(''),datasets},plugin:sepPlugin};
    }
    const sp=zDisp[dispSeason];if(!sp)return{chartData:{labels:[],datasets:[]},plugin:null};
    const tfs2=[...new Set(Object.values(sp).flatMap(d=>Object.values(d).flatMap(Object.keys)))].filter(t=>t!=='Demand').sort();
    const getData=(tf)=>{if(dispDay==='avg'){const ds=Object.keys(sp);return Array.from({length:24},(_,h)=>ds.reduce((s,d)=>s+(sp[d]?.[`t${h+1}`]?.[tf]||0),0)/Math.max(ds.length,1));}return Array.from({length:24},(_,h)=>sp[dispDay]?.[`t${h+1}`]?.[tf]||0);};
    const datasets2=tfs2.map(tf=>({label:tf,fill:true,data:getData(tf),backgroundColor:hexA(techColor(tf),0.7),borderColor:techColor(tf),borderWidth:0,pointRadius:0,tension:0,stack:'gen'}));
    const demLine=dispAvailD.length>0
      ?Array.from({length:24},(_,h)=>{
          const ds=dispDay==='avg'?dispAvailD:[dispDay];
          const vals=ds.map(d=>getDispDemand(sd,activeDispZone,allZones,refYear,dispSeason,d,h)).filter(v=>v!=null&&v>0);
          if(!vals.length)return null;
          return dispDay==='avg'?vals.reduce((a,b)=>a+b,0)/vals.length:vals[0];
        })
      :[]; if(demLine.some(v=>v))datasets2.push({label:'Demand',type:'line',data:demLine,borderColor:'#8B0000',borderWidth:1,pointRadius:0,tension:0,fill:false,spanGaps:true,stack:'demand',order:1});
    const zPr=sd.price[activeDispZone]?.[refYear]||{}; const prLine=Array.from({length:24},(_,h)=>{const d=dispDay==='avg'?Object.keys(sp)[0]:dispDay;return zPr[dispSeason]?.[d]?.[`t${h+1}`]||null;});
    if(prLine.some(v=>v!=null))datasets2.push({label:'Marginal cost',type:'line',data:prLine,yAxisID:'yR',borderColor:mcColor,borderWidth:1,pointRadius:0,tension:0,fill:false,spanGaps:true,order:1});
    const linePlugin=(demLine.some(v=>v)||prLine.some(v=>v!=null))?{id:'lineS',afterDatasetsDraw:(chart)=>{const{ctx,chartArea:ca,scales:sc}=chart;if(!ca)return;const dL=(data,yK,col,lw=1.5)=>{if(!data.some(v=>v!=null)||!sc[yK])return;ctx.save();ctx.beginPath();ctx.strokeStyle=col;ctx.lineWidth=lw;ctx.setLineDash([]);let mv=false;data.forEach((v,i)=>{if(v==null){mv=false;return;}const x=sc.x.getPixelForValue(i);const y=sc[yK].getPixelForValue(v);mv?ctx.lineTo(x,y):ctx.moveTo(x,y);mv=true;});ctx.stroke();ctx.restore();};dL(demLine,'y','#CC0000');dL(prLine,'yR',mcColor,1);}}:null;
    return{chartData:{labels:Array.from({length:24},(_,i)=>`${i+1}h`),datasets:datasets2},plugin:linePlugin};
  };

  // ── Trade ───────────────────────────────────────────────────────────────────
  const buildTradeBar = () => {
    const tx=resultsData[trScenario]?.transmission||{}; if(!refYear)return null;
    const imp={},exp={};
    for(const z of allZones){
      imp[z]=0;exp[z]=0;
      for(const[z2,attrs]of Object.entries(tx[z]||{}))exp[z]+=(attrs.Interchange?.[refYear]||0);
      for(const[z2,zm]of Object.entries(tx))if(z2!==z)imp[z]+=(zm[z]?.Interchange?.[refYear]||0);
    }
    const zones=allZones.filter(z=>imp[z]+exp[z]>0.5).sort((a,b)=>(imp[b]-exp[b])-(imp[a]-exp[a]));
    if(!zones.length)return null;
    const net=Object.fromEntries(zones.map(z=>[z,+(imp[z]-exp[z]).toFixed(1)]));
    const visImp = !isHidden('trade-bar','Imports');
    const visExp = !isHidden('trade-bar','Exports');
    return {
      labels:zones,
      datasets:[
        visImp&&{ label:'Imports', data:zones.map(z=>+imp[z].toFixed(1)), backgroundColor:hexA('#2E9EC8',0.78), borderWidth:0, barThickness:12, stack:'trade' },
        visExp&&{ label:'Exports', data:zones.map(z=>+(-exp[z]).toFixed(1)), backgroundColor:hexA('#E8C547',0.78), borderWidth:0, barThickness:12, stack:'trade' },
        // Net dot: thin bar at net position, independent of stack
        { label:'Net', data:zones.map(z=>net[z]), backgroundColor:t.isDark?'rgba(255,255,255,0.92)':'#1E3A8A', borderWidth:0, barThickness:3, order:0 },
      ].filter(Boolean),
      _imp:imp, _exp:exp, _net:net,
    };
  };

  const buildTradeEvolution = () => {
    const tx0=resultsData[trScenario]?.transmission||{}; if(!allYears.length||!Object.keys(tx0).length)return null;
    const corridors=[]; const seen=new Set();
    for(const[z,zm] of Object.entries(tx0))for(const z2 of Object.keys(zm)){const k=[z,z2].sort().join('||');if(!seen.has(k)){seen.add(k);corridors.push({z,z2,key:k});}}
    let attr,unit;
    if(trEvMetric==='volume')       { attr='Interchange';          unit='GWh'; }
    else if(trEvMetric==='capacity'){ attr='TransmissionCapacity'; unit='MW'; }
    else                            { attr='InterconUtilization';  unit='%'; }
    return { labels:allYears, corridors, unit, datasets:corridors.slice(0,12).map((c,i)=>({
      label:`${c.z}↔${c.z2}`,
      data:allYears.map(y=>{
        const tx=resultsData[trScenario]?.transmission||{};
        const fwd=tx[c.z]?.[c.z2]?.[attr]?.[y]||0;
        const rev=tx[c.z2]?.[c.z]?.[attr]?.[y]||0;
        // Utilization: average of both directions (0-1 scale → ×100)
        return trEvMetric==='utilization' ? +(((fwd+rev)/2)*100).toFixed(1) : +(Math.abs(fwd)+Math.abs(rev)).toFixed(1);
      }),
      backgroundColor:hexA(MAP_PALETTE[i%MAP_PALETTE.length], trEvMetric==='utilization'?0.15:(isHidden('trade-ev',`${c.z}↔${c.z2}`)?0.05:0.82)),
      borderColor:MAP_PALETTE[i%MAP_PALETTE.length],
      borderWidth: trEvMetric==='utilization'?2:0,
      type: trEvMetric==='utilization'?'line':'bar',
      fill:false, tension:0.3, pointRadius: trEvMetric==='utilization'?2:0,
      stack: trEvMetric==='utilization'?undefined:'a',
    }))};
  };

  // ── Plants ──────────────────────────────────────────────────────────────────
  const buildPlantsList = () => {
    const pl=(resultsData[plScenario]?.plants||[]).filter(p=>p.attribute===plIndicator&&p.y===refYear&&p.value>0).sort((a,b)=>b.value-a.value).slice(0,plTopN);
    return pl;
  };

  const buildLCOEBubble = () => {
    const pl=resultsData[plScenario]?.plants||[]; if(!refYear)return null;
    const lookup={};
    for(const p of pl){ if(!lookup[p.g])lookup[p.g]={techfuel:p.techfuel,z:p.z}; lookup[p.g][p.attribute]=p.attribute===p.attribute?p.value:lookup[p.g][p.attribute]; if(!lookup[p.g][p.attribute]||p.y===refYear)lookup[p.g][p.attribute]=p.y===refYear?p.value:lookup[p.g][p.attribute]; }
    // Build per refYear
    const byG={};
    for(const p of pl.filter(pp=>pp.y===refYear)){ if(!byG[p.g])byG[p.g]={techfuel:p.techfuel,z:p.z}; byG[p.g][p.attribute]=p.value; }
    const points=Object.entries(byG).map(([g,d])=>({g,techfuel:d.techfuel||'',zone:d.z||'',lcoe:d.PlantAnnualLCOE||0,util:(d.UtilizationPlant||0)*100,cap:d.CapacityPlant||0})).filter(p=>p.lcoe>0&&p.util>0&&p.cap>0);
    const tfs=[...new Set(points.map(p=>p.techfuel))].sort();
    return { datasets:tfs.map(tf=>({ label:tf, data:points.filter(p=>p.techfuel===tf).map(p=>({ x:+p.util.toFixed(1), y:+p.lcoe.toFixed(1), r:Math.min(Math.max(Math.sqrt(p.cap)*0.6,3),20), _plant:p.g, _cap:p.cap })), backgroundColor:hexA(techColor(tf),0.65), borderColor:techColor(tf), borderWidth:1 })).filter(d=>d.data.length>0) };
  };

  const overviewMix=buildOverviewMix(), evolutionData=buildEvolution();
  const dispResult=buildDispatch(), tradeBarData=buildTradeBar(), tradeEvData=buildTradeEvolution();
  const plantsData=buildPlantsList(), lcoeData=buildLCOEBubble();
  const dispTechfuels=dispResult.chartData.datasets.filter(d=>d.label!=='Marginal cost'&&d.label!=='Demand').map(d=>d.label);

  // ── JSX ─────────────────────────────────────────────────────────────────────
  return (
    <div style={{ display:'flex', height:'calc(100vh - 46px)' }}
      onMouseMove={e=>{ if(!isDraggingRef.current)return; const dx=dragStartX.current-e.clientX; setPanelWidth(Math.max(380,Math.min(760,dragStartW.current+dx))); }}
      onMouseUp={()=>{ isDraggingRef.current=false; }}
      onMouseLeave={()=>{ isDraggingRef.current=false; }}
    >

      {/* Map */}
      <div style={{ position:'relative', flex:1 }}>
        <div ref={containerRef} style={{ width:'100%', height:'100%', backgroundColor:t.bg }} />
        {/* Breadcrumb */}
        <div style={{ position:'absolute', top:10, left:10, zIndex:10, display:'flex', gap:4, alignItems:'center', fontSize:'0.52rem', color:t.text, backgroundColor:t.panel, border:`1px solid ${t.panelBorder}`, borderRadius:5, padding:'4px 10px', boxShadow:'0 1px 4px rgba(0,0,0,.18)' }}>
          <Link to="/" style={{ color:t.lblMuted, textDecoration:'none' }}>World</Link>
          <span style={{ color:t.lblMuted }}>›</span>
          <Link to={`/region/${regionId}`} style={{ color:t.lblMuted, textDecoration:'none' }}>{region.name}</Link>
          <span style={{ color:t.lblMuted }}>›</span>
          <span style={{ color:t.lbl, fontWeight:600 }}>Results</span>
        </div>
        {/* Map legend */}
        {hasData && (
          <div style={{ position:'absolute', bottom:14, left:10, zIndex:10, backgroundColor:hexA(t.panel,0.92), border:`1px solid ${t.panelBorder}`, borderRadius:6, padding:'8px 10px', fontSize:'0.43rem', color:t.muted, minWidth:120 }}>
            <div style={{ marginBottom:5 }}>
              <div style={{ fontSize:'0.38rem', color:t.lblMuted, marginBottom:2 }}>Interco utilization</div>
              <div style={{ background:'linear-gradient(to right, #FFD700, #FF8C00, #E53935)', height:5, borderRadius:3, marginBottom:2 }}/>
              <div style={{ display:'flex', justifyContent:'space-between' }}>
                <span>0%</span><span>100%</span>
              </div>
            </div>
            {Object.keys(zoneAvgPrices).length>0 && (
              <div>
                <div style={{ fontSize:'0.38rem', color:t.lblMuted, marginBottom:2 }}>Zonal price (marginal cost)</div>
                <div style={{ background:'linear-gradient(to right, #FFFFFF, #1B6CA8)', height:5, borderRadius:3, marginBottom:2 }}/>
                <div style={{ display:'flex', justifyContent:'space-between' }}>
                  <span>{minPrice.toFixed(0)}</span><span>{maxPrice.toFixed(0)} $/MWh</span>
                </div>
              </div>
            )}
            <div style={{ marginTop:8, paddingTop:8, borderTop:`1px solid ${hexA(t.panelBorder,0.5)}` }}>
              <div style={{ fontSize:'0.38rem', color:t.lblMuted, marginBottom:4 }}>Zone mix</div>
              <div style={{ display:'flex', gap:4 }}>
                <Pill active={pieDispMode==='none'} onClick={()=>setPieDispMode('none')}>—</Pill>
                <Pill active={pieDispMode==='capacity'} onClick={()=>setPieDispMode('capacity')}>Cap.</Pill>
                <Pill active={pieDispMode==='energy'} onClick={()=>setPieDispMode('energy')}>Gen.</Pill>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Drag handle */}
      <div
        style={{ width:5, flexShrink:0, cursor:'col-resize', backgroundColor:'transparent', zIndex:10 }}
        onMouseDown={e=>{ isDraggingRef.current=true; dragStartX.current=e.clientX; dragStartW.current=panelWidth; e.preventDefault(); }}
      />

      {/* Right panel — resizable */}
      <div style={{ width:panelWidth, flexShrink:0, height:'100%', overflowY:'auto', padding:'18px 16px', backgroundColor:t.panel, borderLeft:`1px solid ${t.panelBorder}` }}>

        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:'0.52rem', color:t.lblMuted, marginBottom:2 }}>
            <Link to={`/region/${regionId}`} style={{ color:t.lblMuted, textDecoration:'none' }}>← {region.name} · Inputs</Link>
          </div>
          <div style={{ fontSize:'1rem', fontWeight:700, color:t.lbl }}>{region.name} — Results</div>
        </div>

        {/* Run selector */}
        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:14, padding:'8px 10px', border:`1px solid ${t.panelBorder}`, borderRadius:6, backgroundColor:hexA(t.panelBorder,0.12) }}>
          <span style={{ fontSize:'0.5rem', color:t.lblMuted, flexShrink:0 }}>Run</span>
          {loadingRuns ? <span style={{ fontSize:'0.5rem', color:t.lblMuted }}>Loading…</span>
            : runList.length>0 ? <select value={simRun||''} onChange={e=>setSimRun(e.target.value)} style={{ ...selectStyle, flex:1 }}>{runList.map(r=><option key={r} value={r}>{r}</option>)}</select>
            : <span style={{ fontSize:'0.5rem', color:t.lblMuted }}>No results — push output CSVs to epm/output/</span>}
        </div>

        {/* Tabs */}
        <div style={{ display:'flex', gap:0, marginBottom:16, borderBottom:`1px solid ${t.panelBorder}` }}>
          {TABS.map(tab=>(
            <button key={tab} onClick={()=>setActiveTab(tab)} style={{ fontSize:'0.5rem', fontFamily:'inherit', padding:'6px 12px', border:'none', borderBottom:activeTab===tab?`2px solid ${t.lbl}`:'2px solid transparent', backgroundColor:'transparent', color:activeTab===tab?t.lbl:t.lblMuted, cursor:'pointer', fontWeight:activeTab===tab?600:400 }}>{TAB_LABELS[tab]}</button>
          ))}
        </div>

        {loadingData && <div style={{ padding:'24px 0', textAlign:'center', color:t.lblMuted, fontSize:'0.6rem' }}>Loading results…</div>}
        {!loadingData&&!hasData&&simRun&&<div style={{ padding:'24px 0', textAlign:'center', color:t.lblMuted, fontSize:'0.6rem' }}>No data for this run.</div>}

        {/* ════ OVERVIEW ════ */}
        {hasData&&activeTab==='overview'&&(
          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
            <div style={{ display:'flex', gap:6, alignItems:'center', flexWrap:'wrap' }}>
              <select value={refYear||''} onChange={e=>setRefYear(e.target.value)} style={selectStyle}>{allYears.map(y=><option key={y} value={y}>{y}</option>)}</select>
              <select value={ovScenario||''} onChange={e=>setOvScenario(e.target.value)} style={selectStyle}>{scenarioList.map(s=><option key={s} value={s}>{s}</option>)}</select>
            </div>
            {/* KPIs + overview pie */}
            {(()=>{ const sd=resultsData[ovScenario]; if(!sd||!refYear)return null;
              const totGW=allZones.reduce((s,z)=>s+Object.values(sd.techFuel[z]?.CapacityTechFuel?.[refYear]||{}).reduce((a,b)=>a+b,0),0)/1000;
              const demTWh=allZones.reduce((s,z)=>s+(sd.yearlyZone[z]?.DemandEnergyZone?.[refYear]||0),0)/1000;
              const avgRegPrice=priceVals.length?priceVals.reduce((a,b)=>a+b,0)/priceVals.length:null;
              // Aggregated pie data
              const pieTfMap={}; for(const z of allZones){for(const[tf,v] of Object.entries(sd.techFuel[z]?.CapacityTechFuel?.[refYear]||{}))if(v>0)pieTfMap[tf]=(pieTfMap[tf]||0)+v;}
              const pieTfs=Object.keys(pieTfMap).filter(tf=>pieTfMap[tf]>0).sort();
              return <div style={{ display:'flex', gap:10, alignItems:'center' }}>
                {pieTfs.length>0&&<OverviewPie tfs={pieTfs} data={pieTfs.map(tf=>pieTfMap[tf])} total={pieTfs.reduce((s,tf)=>s+pieTfMap[tf],0)} unitDiv={1000} unitLbl="GW" t={t}/>}
                <div style={{ flex:1, display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:6 }}>
                  {[
                    {l:`Installed ${refYear}`,v:`${totGW.toFixed(1)} GW`},
                    {l:`Demand ${refYear}`,v:`${demTWh.toFixed(0)} TWh`},
                    {l:`Trade volume`,v:totalTradeGWh>0?`${fmtBig(totalTradeGWh)} GWh`:'—'},
                    {l:'Avg price',v:avgRegPrice!=null?`${avgRegPrice.toFixed(1)} $/MWh`:'—'},
                  ].map(({l,v})=>(
                    <div key={l} style={{ border:`1px solid ${t.panelBorder}`, borderRadius:6, padding:'7px 8px' }}>
                      <div style={{ fontSize:'0.4rem', color:t.lblMuted, marginBottom:2 }}>{l}</div>
                      <div style={{ fontSize:'0.7rem', fontWeight:700, color:t.lbl }}>{v}</div>
                    </div>
                  ))}
                </div>
              </div>;
            })()}
            {/* Mix chart */}
            {overviewMix&&<div>
              <SectionTitle t={t} right={<div style={{display:'flex',gap:3}}><Pill active={ovMixMode==='zone'} onClick={()=>setOvMixMode('zone')}>Zone</Pill><Pill active={ovMixMode==='country'} onClick={()=>setOvMixMode('country')}>Country</Pill></div>}>Capacity mix (MW)</SectionTitle>
              <CJChart type="bar" height={Math.min(overviewMix.labels.length*22+24,300)} cacheKey={`ov|${ovScenario}|${refYear}|${ovMixMode}|${[...hiddenMap['ov-mix']||[]].join(',')}`} data={{...overviewMix,datasets:overviewMix.datasets.filter(d=>!isHidden('ov-mix',d.label))}}
                options={{...cjDefaults(t),indexAxis:'y',scales:{x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}},y:{stacked:true,grid:{display:false},ticks:{color:t.muted,font:{size:8}}}},plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>`${ctx.dataset.label}: ${fmt(ctx.parsed.x)} MW`}}}}}
              />
              <div style={{display:'flex',flexWrap:'wrap',gap:'3px 8px',marginTop:5}}>{allTechfuels.map(tf=><div key={tf} onClick={()=>toggleHidden('ov-mix',tf)} style={{display:'flex',alignItems:'center',gap:3,fontSize:'0.43rem',color:t.muted,cursor:'pointer',opacity:isHidden('ov-mix',tf)?0.28:1}}><div style={{width:8,height:8,borderRadius:2,backgroundColor:techColor(tf)}}/>{tf}</div>)}</div>
            </div>}
            {/* Prices by zone */}
            {Object.keys(zoneAvgPrices).length>0&&(()=>{
              const zones=Object.keys(zoneAvgPrices).sort((a,b)=>zoneAvgPrices[b]-zoneAvgPrices[a]);
              const rng=maxPrice-minPrice||1;
              return <div>
                <SectionTitle t={t}>Average marginal price by zone (USD/MWh)</SectionTitle>
                <CJChart type="bar" height={Math.min(zones.length*22+24,220)} cacheKey={`pz|${ovScenario}|${refYear}|${theme}`}
                  data={{labels:zones,datasets:[
                    {label:'Range',data:zones.map(z=>{const r=zonePriceRange[z];return r?[+r.min.toFixed(1),+r.max.toFixed(1)]:[+zoneAvgPrices[z].toFixed(1),+zoneAvgPrices[z].toFixed(1)];}),backgroundColor:zones.map(z=>priceBarColor((zoneAvgPrices[z]-minPrice)/rng).replace('rgb(','rgba(').replace(')',',0.18)')),borderWidth:0,barThickness:10},
                    {type:'scatter',label:'Avg',data:zones.map(z=>({x:+zoneAvgPrices[z].toFixed(1),y:z})),pointStyle:'line',rotation:90,radius:6,borderWidth:2.5,borderColor:zones.map(z=>priceBarColor((zoneAvgPrices[z]-minPrice)/rng))},
                  ]}}
                  options={{...cjDefaults(t),indexAxis:'y',scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}}},y:{grid:{display:false},ticks:{color:t.muted,font:{size:8}}}},plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>{const z=zones[ctx.dataIndex];if(ctx.datasetIndex===0){const r=zonePriceRange[z];return r&&r.min!==r.max?`${r.min.toFixed(1)}–${r.max.toFixed(1)} $/MWh`:'';} return`Avg: ${zoneAvgPrices[z]?.toFixed(1)} $/MWh`;},title:ctx=>ctx[0]?.label||''}}}}}
                />
                <div style={{display:'flex',gap:12,marginTop:4,fontSize:'0.44rem',color:t.muted}}>
                  <span>Avg: <b style={{color:t.lbl}}>{(priceVals.reduce((a,b)=>a+b,0)/priceVals.length).toFixed(1)} $/MWh</b></span>
                  <span>Min: <b style={{color:t.lbl}}>{minPrice.toFixed(1)}</b></span>
                  <span>Max: <b style={{color:t.lbl}}>{maxPrice.toFixed(1)}</b></span>
                </div>
              </div>;
            })()}
            <DlRow files={[[ovScenario,'pTechFuelMerged.csv'],[ovScenario,'pYearlyZoneMerged.csv'],[ovScenario,'pHourlyPrice.csv']]}/>
          </div>
        )}

        {/* ════ EVOLUTION ════ */}
        {hasData&&activeTab==='evolution'&&(
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
              <select value={evIndicator} onChange={e=>setEvIndicator(e.target.value)} style={selectStyle}>{INDICATORS.map(ind=><option key={ind.key} value={ind.key}>{ind.label}</option>)}</select>
              <select value={evCountry} onChange={e=>setEvCountry(e.target.value)} style={selectStyle}><option value="all">All countries</option>{allCountries.map(c=><option key={c} value={c}>{c}</option>)}</select>
              <div style={{width:1,height:14,backgroundColor:t.panelBorder}}/>
              {scenarioList.map(s=><Pill key={s} active={evScenarios.has(s)} onClick={()=>setEvScenarios(prev=>{const n=new Set(prev);n.has(s)?n.delete(s):n.add(s);return n;})}>{s}</Pill>)}
            </div>
            {evolutionData?<>
              <CJChart type={activeInd.source==='yearlyZone'?'line':'bar'} height={220} cacheKey={`ev|${evIndicator}|${[...evScenarios].sort().join(',')}|${evCountry}|${[...hiddenMap['ev-tf']||[]].join(',')}`} data={{...evolutionData,datasets:evolutionData.datasets.filter(d=>activeInd.source!=='techFuel'||!isHidden('ev-tf',d.label.split(' — ')[1]||d.label))}}
                options={{...cjDefaults(t),scales:{x:{stacked:activeInd.source!=='yearlyZone',grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},maxTicksLimit:10}},y:{stacked:activeInd.source!=='yearlyZone',grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:activeInd.unit,color:t.muted,font:{size:7}}}},plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>`${ctx.dataset.label}: ${fmt(ctx.parsed.y)}`}}}}}
              />
              {activeInd.source==='costs'&&<div style={{display:'flex',flexWrap:'wrap',gap:'3px 8px',marginTop:2}}>{MAIN_COST_CATS.map(cat=><div key={cat} style={{display:'flex',alignItems:'center',gap:3,fontSize:'0.43rem',color:t.muted}}><div style={{width:8,height:8,borderRadius:2,backgroundColor:costColor(cat)}}/>{COST_LABELS[cat]||cat}</div>)}</div>}
              {activeInd.source==='techFuel'&&<div style={{display:'flex',flexWrap:'wrap',gap:'3px 8px',marginTop:2}}>{allTechfuels.map(tf=><div key={tf} onClick={()=>toggleHidden('ev-tf',tf)} style={{display:'flex',alignItems:'center',gap:3,fontSize:'0.43rem',color:t.muted,cursor:'pointer',opacity:isHidden('ev-tf',tf)?0.28:1}}><div style={{width:8,height:8,borderRadius:2,backgroundColor:techColor(tf)}}/>{tf}</div>)}</div>}
            </>:<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>Select at least one scenario.</div>}
            <DlRow files={scenarioList.map(s=>[s,'pTechFuelMerged.csv']).slice(0,1).concat(scenarioList.map(s=>[s,'pYearlyZoneMerged.csv']).slice(0,1))}/>
          </div>
        )}

        {/* ════ DISPATCH ════ */}
        {hasData&&activeTab==='dispatch'&&(
          <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
            <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
              <select value={activeDispZone||''} onChange={e=>setDispZone(e.target.value)} style={selectStyle}>
                <option value="__all__">All zones (aggregated)</option>
                {allZones.map(z=><option key={z} value={z}>{z}</option>)}
              </select>
              <select value={dispScenario||''} onChange={e=>setDispScenario(e.target.value)} style={selectStyle}>{scenarioList.map(s=><option key={s} value={s}>{s}</option>)}</select>
              <select value={refYear||''} onChange={e=>setRefYear(e.target.value)} style={selectStyle}>{allYears.map(y=><option key={y} value={y}>{y}</option>)}</select>
            </div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:3, alignItems:'center' }}>
              <Pill active={dispMode==='full'} onClick={()=>setDispMode('full')}>Full Year</Pill>
              {dispAvailS.map(s=><Pill key={s} active={dispMode==='season'&&dispSeason===s} onClick={()=>{setDispMode('season');setDispSeason(s);}}>{s}</Pill>)}
              {dispMode==='season'&&dispAvailD.length>0&&<><div style={{width:1,height:14,backgroundColor:t.panelBorder}}/><select value={dispDay} onChange={e=>setDispDay(e.target.value)} style={selectStyle}><option value="avg">Avg</option>{dispAvailD.map(d=><option key={d} value={d}>{d}</option>)}</select></>}
            </div>
            {dispResult.chartData.datasets.length>0?<>
              <CJChart type="line" height={dispMode==='full'?215:165} data={dispResult.chartData} plugins={dispResult.plugin?[dispResult.plugin]:[]} cacheKey={`disp|${dispScenario}|${activeDispZone}|${refYear}|${dispMode}|${dispSeason}|${dispDay}|${theme}`}
                options={{...cjDefaults(t),layout:{padding:{top:dispMode==='full'?18:4,bottom:dispMode==='full'?62:4}},scales:{x:{grid:{color:hexA(t.panelBorder,0.35),drawTicks:false},ticks:{display:dispMode!=='full',color:t.muted,font:{size:7},maxTicksLimit:12}},y:{stacked:true,grid:{color:hexA(t.panelBorder,0.35)},ticks:{color:t.muted,font:{size:8}},title:{display:true,text:'MW',color:t.muted,font:{size:7}}},yR:{type:'linear',position:'right',display:dispResult.chartData.datasets.some(d=>d.label==='Marginal cost'),grid:{drawOnChartArea:false},ticks:{color:t.muted,font:{size:8}},title:{display:true,text:'USD/MWh',color:t.muted,font:{size:7}}}},plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false}}}}
              />
              <div style={{display:'flex',flexWrap:'wrap',gap:'3px 8px',marginTop:2}}>
                {dispTechfuels.map(tf=><div key={tf} style={{display:'flex',alignItems:'center',gap:3,fontSize:'0.43rem',color:t.muted}}><div style={{width:8,height:8,borderRadius:2,backgroundColor:techColor(tf)}}/>{tf}</div>)}
                <div style={{display:'flex',alignItems:'center',gap:3,fontSize:'0.43rem',color:t.muted}}><div style={{width:12,height:2,backgroundColor:'#8B0000',borderRadius:1,opacity:0.8}}/><span>Demand</span></div>
                <div style={{display:'flex',alignItems:'center',gap:3,fontSize:'0.43rem',color:t.muted}}><div style={{width:12,height:2,backgroundColor:t.isDark?'rgba(255,255,255,0.88)':'#1E3A8A',borderRadius:1}}/><span>Marginal cost</span></div>
              </div>
            </>:<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>No dispatch data.</div>}
            <DlRow files={[[dispScenario,'pDispatchComplete.csv'],[dispScenario,'pHourlyPrice.csv']]}/>
          </div>
        )}

        {/* ════ TRADE ════ */}
        {hasData&&activeTab==='trade'&&(
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
              <select value={refYear||''} onChange={e=>setRefYear(e.target.value)} style={selectStyle}>{allYears.map(y=><option key={y} value={y}>{y}</option>)}</select>
              <select value={trScenario||''} onChange={e=>setTrScenario(e.target.value)} style={selectStyle}>{scenarioList.map(s=><option key={s} value={s}>{s}</option>)}</select>
            </div>

            {/* Diverging import/export bars */}
            {tradeBarData&&tradeBarData.labels.length>0&&(()=>{
              const zones=tradeBarData.labels;
              return <>
                <SectionTitle t={t}>Imports (+) / Exports (−) by zone (GWh)</SectionTitle>
                <div style={{ display:'flex', gap:8 }}>
                  <div style={{ flex:1 }}>
                    <CJChart type="bar" height={Math.min(zones.length*22+24,260)}
                      cacheKey={`tr|${trScenario}|${refYear}|${theme}|${[...hiddenMap['trade-bar']||[]].join(',')}`}
                      data={tradeBarData}
                      options={{...cjDefaults(t),indexAxis:'y',
                        scales:{x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}},y:{stacked:true,grid:{display:false},ticks:{color:t.muted,font:{size:8}}}},
                        plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>`${ctx.dataset.label}: ${fmt(Math.abs(ctx.parsed.x))} GWh`,title:ctx=>{const z=ctx[0]?.label;const imp=tradeBarData._imp?.[z]||0;const exp=tradeBarData._exp?.[z]||0;return[z,`Net: ${imp>=exp?'+':''}${fmt(imp-exp)} GWh`];}}}}}}
                    />
                  </div>
                  {/* Clickable legend */}
                  <div style={{ width:72, flexShrink:0, display:'flex', flexDirection:'column', gap:4, paddingTop:4 }}>
                    {[{l:'Imports',c:'#2E9EC8'},{l:'Exports',c:'#E8C547'}].map(({l,c})=>(
                      <div key={l} onClick={()=>toggleHidden('trade-bar',l)} style={{ display:'flex',alignItems:'center',gap:4,cursor:'pointer',opacity:isHidden('trade-bar',l)?0.25:1 }}>
                        <div style={{ width:10,height:10,borderRadius:2,backgroundColor:hexA(c,0.78),flexShrink:0 }}/>
                        <span style={{ fontSize:'0.43rem',color:t.muted }}>{l}</span>
                      </div>
                    ))}
                    <div style={{ fontSize:'0.38rem',color:t.lblMuted,marginTop:4 }}>click to hide</div>
                  </div>
                </div>
              </>;
            })()}

            {/* Evolution stacked by corridor — right legend */}
            {tradeEvData&&(()=>{
              const allCorridors=tradeEvData.corridors||[];
              const unit=tradeEvData.unit||'GWh';
              return <>
                <div style={{ display:'flex', gap:4, alignItems:'center', flexWrap:'wrap', marginTop:4 }}>
                  <SectionTitle t={t}>Trade evolution by corridor</SectionTitle>
                  <div style={{display:'flex',gap:3,marginLeft:'auto'}}>
                    <Pill active={trEvMetric==='volume'}      onClick={()=>setTrEvMetric('volume')}>GWh</Pill>
                    <Pill active={trEvMetric==='capacity'}    onClick={()=>setTrEvMetric('capacity')}>MW</Pill>
                    <Pill active={trEvMetric==='utilization'} onClick={()=>setTrEvMetric('utilization')}>Util %</Pill>
                  </div>
                </div>
                <div style={{ display:'flex', gap:8 }}>
                  <div style={{ flex:1 }}>
                    <CJChart type="bar" height={200}
                      cacheKey={`trev|${trScenario}|${trEvMetric}|${[...hiddenMap['trade-ev']||[]].join(',')}`}
                      data={{ labels:tradeEvData.labels, datasets:tradeEvData.datasets.filter(d=>!isHidden('trade-ev',d.label)).map(d=>({...d,backgroundColor:hexA(MAP_PALETTE[allCorridors.findIndex(c=>`${c.z}↔${c.z2}`===d.label)%MAP_PALETTE.length],0.82)})) }}
                      options={{...cjDefaults(t),scales:{
                        x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},maxTicksLimit:10}},
                        y:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:unit,color:t.muted,font:{size:7}}},
                      },plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>`${ctx.dataset.label}: ${fmt(ctx.parsed.y)} ${unit}`}}}}}
                    />
                  </div>
                  {/* Right legend — clickable */}
                  <div style={{ width:80,flexShrink:0,display:'flex',flexDirection:'column',gap:2,paddingTop:4,maxHeight:200,overflowY:'auto' }}>
                    {allCorridors.slice(0,12).map((c,i)=>{
                      const label=`${c.z}↔${c.z2}`;
                      return <div key={label} onClick={()=>toggleHidden('trade-ev',label)} style={{ display:'flex',alignItems:'center',gap:3,cursor:'pointer',opacity:isHidden('trade-ev',label)?0.25:1 }}>
                        <div style={{ width:9,height:9,borderRadius:2,backgroundColor:hexA(MAP_PALETTE[i%MAP_PALETTE.length],0.82),flexShrink:0 }}/>
                        <span style={{ fontSize:'0.4rem',color:t.muted,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{label}</span>
                      </div>;
                    })}
                    <div style={{ fontSize:'0.38rem',color:t.lblMuted,marginTop:4 }}>click to hide</div>
                  </div>
                </div>
              </>;
            })()}
            <DlRow files={[[trScenario,'pTransmissionMerged.csv']]}/>
          </div>
        )}

        {/* ════ PLANTS ════ */}
        {hasData&&activeTab==='plants'&&(
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
              <select value={refYear||''} onChange={e=>setRefYear(e.target.value)} style={selectStyle}>{allYears.map(y=><option key={y} value={y}>{y}</option>)}</select>
              <select value={plScenario||''} onChange={e=>setPlScenario(e.target.value)} style={selectStyle}>{scenarioList.map(s=><option key={s} value={s}>{s}</option>)}</select>
              <select value={plIndicator} onChange={e=>setPlIndicator(e.target.value)} style={selectStyle}>
                {['CapacityPlant','EnergyPlant','CostsPlant','PlantAnnualLCOE','UtilizationPlant'].map(k=><option key={k} value={k}>{k.replace('Plant','').replace(/([A-Z])/g,' $1').trim()}</option>)}
              </select>
              <select value={plTopN} onChange={e=>setPlTopN(+e.target.value)} style={selectStyle}>{[10,20,30,50].map(n=><option key={n} value={n}>Top {n}</option>)}</select>
            </div>
            {/* Ranking */}
            {plantsData.length>0?<>
              <SectionTitle t={t}>Top {plTopN} — {plIndicator.replace('Plant','').replace(/([A-Z])/g,' $1').trim()}</SectionTitle>
              <CJChart type="bar" height={Math.min(plantsData.length*18+24,260)} cacheKey={`pl|${plScenario}|${refYear}|${plIndicator}|${plTopN}`}
                data={{labels:plantsData.map(p=>p.g),datasets:[{data:plantsData.map(p=>+p.value.toFixed(2)),backgroundColor:plantsData.map(p=>hexA(techColor(p.techfuel),0.8)),borderWidth:0,barThickness:12}]}}
                options={{...cjDefaults(t),indexAxis:'y',scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}},y:{grid:{display:false},ticks:{color:t.muted,font:{size:7}}}}}}
              />
              <div style={{display:'flex',flexWrap:'wrap',gap:'3px 8px',marginTop:4}}>{[...new Set(plantsData.map(p=>p.techfuel))].map(tf=><div key={tf} style={{display:'flex',alignItems:'center',gap:3,fontSize:'0.43rem',color:t.muted}}><div style={{width:8,height:8,borderRadius:2,backgroundColor:techColor(tf)}}/>{tf}</div>)}</div>
            </>:<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>No plant data for this run/scenario.</div>}
            {/* LCOE bubble — always below */}
            {lcoeData&&lcoeData.datasets.length>0&&<>
              <SectionTitle t={t}>LCOE vs Utilization — bubble = capacity</SectionTitle>
              <CJChart type="bubble" height={250} cacheKey={`lcoe|${plScenario}|${refYear}`} data={lcoeData}
                options={{...cjDefaults(t),plugins:{...cjDefaults(t).plugins,
                  tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>{const d=ctx.raw;return[`${d._plant||ctx.dataset.label}`,`LCOE: ${d.y} $/MWh  ·  Util: ${d.x.toFixed(0)}%`,d._cap?`Cap: ${fmt(d._cap)} MW`:''].filter(Boolean);}}}},
                  scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}},title:{display:true,text:'Utilization (%)',color:t.muted,font:{size:8}},min:0,max:105},y:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}},title:{display:true,text:'LCOE (USD/MWh)',color:t.muted,font:{size:8}},min:0}}}}
              />
              <div style={{display:'flex',flexWrap:'wrap',gap:'3px 8px',marginTop:4}}>{lcoeData.datasets.map(ds=><div key={ds.label} style={{display:'flex',alignItems:'center',gap:3,fontSize:'0.43rem',color:t.muted}}><div style={{width:8,height:8,borderRadius:'50%',backgroundColor:ds.backgroundColor}}/>{ds.label}</div>)}</div>
            </>}
            <DlRow files={[[plScenario,'pPlantMerged.csv'],[plScenario,'pCostsMerged.csv']]}/>
          </div>
        )}

      </div>
    </div>
  );
}
