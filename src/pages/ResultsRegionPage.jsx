import { useEffect, useRef, useState, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import { useTheme } from '../App';
import { getT, mapStyle } from '../constants';
import {
  fetchEpmCSV, fetchLinestringGeoJSON, fetchZonesGeoJSON,
  fetchGitHubDir, fetchResultCSV,
  processTechFuel, processYearlyZone, processDispatchResults, processHourlyPrice,
  processHours, computeCentroid, normalizeFuel, EPM_FUEL_COLORS,
  resultYears,
} from '../utils/epmFetch';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAP_PALETTE = ['#1B6CA8','#36B5B5','#E8C547','#4DA6FF','#0D7680','#85C1E9','#2E9EC8','#5EBCBA','#1A5276','#7EC8E3','#14A094','#4CAFE8','#EDD770','#AED6F1','#1F618D','#0A6B70'];

const TECHFUEL_COLORS = {
  Nuclear:'#C8A8F0', Coal:'#808890', Peat:'#A0856C', 'Domestic Coal':'#6A5C4C',
  Gas:'#9A7040', CCGT:'#B8921A', OCGT:'#C4A820', Methane:'#D4B030',
  Diesel:'#6A7888', HFO:'#7A7068', Oil:'#7A7068', 'Fuel Oil':'#8A8078',
  Biomass:'#52C860', Waste:'#8A9098', Biogas:'#72DC8A', Geothermal:'#D4A820',
  Reservoir:'#1E9AF5', ROR:'#5DADE2', PSH:'#0D7680', 'Run-of-River':'#5DADE2',
  Solar:'#FFD700', PV:'#FFD700', CSP:'#E8C547', 'Solar Thermal':'#F0D060',
  'Onshore Wind':'#44DAEC', OnshoreWind:'#44DAEC',
  'Offshore Wind':'#7CC8FA', OffshoreWind:'#7CC8FA',
  Battery:'#A3D5FF', Storage:'#AED6F1', 'PV+Storage':'#C8E860',
  Imports:'#E8C547', Demand:'#9B59B6',
};

function techColor(tf) {
  if (TECHFUEL_COLORS[tf]) return TECHFUEL_COLORS[tf];
  return EPM_FUEL_COLORS[normalizeFuel(tf)] || '#AAAAAA';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n, d = 0) { if (n == null || isNaN(n)) return '—'; return n.toLocaleString('en-US', { maximumFractionDigits: d }); }
function hexA(hex, a) { if (!hex || hex.length < 7) return `rgba(128,128,128,${a})`; const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16); return `rgba(${r},${g},${b},${a})`; }
function cjDefaults(t) {
  return { responsive:true, maintainAspectRatio:false, plugins:{ legend:{display:false}, tooltip:{backgroundColor:t.panel,borderColor:t.panelBorder,borderWidth:1,titleColor:t.lbl,bodyColor:t.muted,titleFont:{size:9},bodyFont:{size:9},padding:6} }, scales:{ x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}}}, y:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}}} } };
}
function avgProfile(profiles) { return profiles.length ? Array.from({length:24},(_,i)=>profiles.reduce((s,p)=>s+(p[i]||0),0)/profiles.length) : null; }

function CJChart({ type, data, options, height, plugins: extraPlugins, cacheKey }) {
  const canvasRef = useRef(null); const chartRef = useRef(null);
  const sig = JSON.stringify({ type, labels:data.labels, ck:cacheKey, ds:data.datasets?.map(d=>({l:d.label,n:d.data?.length,t:d.type})) });
  useEffect(() => {
    const CJ = window.Chart; if (!CJ || !canvasRef.current) return;
    chartRef.current?.destroy();
    chartRef.current = new CJ(canvasRef.current, { type, data, options, plugins: extraPlugins||[] });
    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  }, [sig]); // eslint-disable-line
  return <div style={{ height, width:'100%', position:'relative' }}><canvas ref={canvasRef} /></div>;
}

function SectionTitle({ t, children, right }) {
  return <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
    <div style={{ fontSize:'0.47rem', letterSpacing:'2px', fontWeight:700, color:t.lblMuted, textTransform:'uppercase' }}>{children}</div>
    {right}
  </div>;
}

function Pill({ active, onClick, children }) {
  return <button onClick={onClick} style={{ fontSize:'0.44rem', fontFamily:'inherit', padding:'2px 7px', borderRadius:3, cursor:'pointer', border:`1px solid ${active?'rgba(74,143,204,0.65)':'rgba(128,160,192,0.2)'}`, backgroundColor:active?'rgba(74,143,204,0.12)':'transparent', color:active?'rgba(74,143,204,1)':'rgba(128,160,192,0.7)', fontWeight:active?600:400 }}>{children}</button>;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ResultsRegionPage() {
  const { regionId } = useParams();
  const { theme }    = useTheme();
  const t            = getT(theme);
  const navigate     = useNavigate();

  const containerRef    = useRef(null);
  const mapRef          = useRef(null);

  // ── State ────────────────────────────────────────────────────────────────────
  const [region,       setRegion]       = useState(null);
  const [zcmapRows,    setZcmapRows]    = useState([]);
  const [zonesGJ,      setZonesGJ]      = useState(null);
  const [hoursData,    setHoursData]    = useState({});
  const [runList,      setRunList]      = useState([]);
  const [simRun,       setSimRun]       = useState(null);
  const [scenarioList, setScenarioList] = useState([]);
  const [resultsData,  setResultsData]  = useState({}); // { scenario: { techFuel, yearlyZone, dispatch, price } }
  const [loadingRuns,  setLoadingRuns]  = useState(false);
  const [loadingData,  setLoadingData]  = useState(false);
  const [activeTab,    setActiveTab]    = useState('overview');
  // Tab-level state
  const [refYear,      setRefYear]      = useState(null);
  const [ovScenario,   setOvScenario]   = useState(null); // overview scenario
  const [evIndicator,  setEvIndicator]  = useState('CapacityTechFuel');
  const [evScenarios,  setEvScenarios]  = useState(new Set());
  const [evMode,       setEvMode]       = useState('zone'); // 'zone' | 'country'
  const [dispScenario, setDispScenario] = useState(null);
  const [dispZone,     setDispZone]     = useState(null);
  const [dispMode,     setDispMode]     = useState('full'); // 'full' | 'season'
  const [dispSeason,   setDispSeason]   = useState('Q1');
  const [dispDay,      setDispDay]      = useState('avg');

  // ── Load region + geo + pHours ────────────────────────────────────────────────
  useEffect(() => {
    fetch('/data/regions.json').then(r=>r.json()).then(d => {
      const r = (d.regions||[]).find(r=>r.id===regionId);
      setRegion(r||null);
    });
  }, [regionId]);

  useEffect(() => {
    if (!region?.epm) return;
    const { branch, dataFolder } = region.epm;
    Promise.all([
      fetchEpmCSV(branch, dataFolder, 'zcmap.csv'),
      fetchZonesGeoJSON(branch, dataFolder),
      fetchEpmCSV(branch, dataFolder, 'pHours.csv'),
    ]).then(([zcRaw, zGJ, hoursRaw]) => {
      setZcmapRows(zcRaw||[]);
      setZonesGJ(zGJ);
      if (hoursRaw) setHoursData(processHours(hoursRaw));
    });
  }, [region]);

  // ── Load run list ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!region?.epm) return;
    setLoadingRuns(true);
    fetchGitHubDir(region.epm.branch, 'epm/output').then(items => {
      const runs = (items||[]).filter(i=>i.type==='dir').map(i=>i.name).sort().reverse();
      setRunList(runs);
      if (runs.length) setSimRun(runs[0]);
    }).finally(() => setLoadingRuns(false));
  }, [region]);

  // ── Load scenario list ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!region?.epm || !simRun) return;
    fetchGitHubDir(region.epm.branch, `epm/output/${simRun}`).then(items => {
      const scens = (items||[]).filter(i=>i.type==='dir').map(i=>i.name).sort();
      setScenarioList(scens);
      setEvScenarios(new Set(scens)); // all active by default
      if (scens.length) { setOvScenario(scens[0]); setDispScenario(scens[0]); }
    });
  }, [region, simRun]);

  // ── Load result CSVs ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!region?.epm || !simRun || !scenarioList.length) return;
    setLoadingData(true);
    const { branch } = region.epm;
    Promise.all(scenarioList.map(async scen => {
      const [tfRaw, yzRaw, dispRaw, priceRaw] = await Promise.all([
        fetchResultCSV(branch, simRun, scen, 'pTechFuelMerged.csv'),
        fetchResultCSV(branch, simRun, scen, 'pYearlyZoneMerged.csv'),
        fetchResultCSV(branch, simRun, scen, 'pDispatchComplete.csv'),
        fetchResultCSV(branch, simRun, scen, 'pHourlyPrice.csv'),
      ]);
      return { scen,
        techFuel:   tfRaw    ? processTechFuel(tfRaw)           : {},
        yearlyZone: yzRaw    ? processYearlyZone(yzRaw)         : {},
        dispatch:   dispRaw  ? processDispatchResults(dispRaw)  : {},
        price:      priceRaw ? processHourlyPrice(priceRaw)     : {},
      };
    })).then(results => {
      const rd = Object.fromEntries(results.map(r=>[r.scen,r]));
      setResultsData(rd);
      // Set reference year
      const firstScen = results[0];
      if (firstScen) {
        const yrs = resultYears(firstScen.techFuel);
        if (yrs.length) setRefYear(yrs[0]);
      }
    }).finally(() => setLoadingData(false));
  }, [region, simRun, scenarioList]); // eslint-disable-line

  // ── Map ───────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || !region || !zonesGJ) return;

    const zoneToCountry = Object.fromEntries(zcmapRows.map(r=>[r.z,r.c]));
    const regionCountries = [...new Set(zcmapRows.map(r=>r.c))].sort();
    const countryColorMap = {};
    regionCountries.forEach((c,i) => { countryColorMap[c] = MAP_PALETTE[i%MAP_PALETTE.length]; });

    const zoneCentroids = {};
    for (const f of zonesGJ.features) {
      const z = f.properties.z;
      if (z) { const c = computeCentroid(f.geometry); if (c) zoneCentroids[z] = c; }
    }
    const lons = Object.values(zoneCentroids).map(c=>c[0]);
    const lats = Object.values(zoneCentroids).map(c=>c[1]);
    const bounds = lons.length ? [[Math.min(...lons)-2,Math.min(...lats)-2],[Math.max(...lons)+2,Math.max(...lats)+2]] : null;

    const map = new maplibregl.Map({
      container: containerRef.current, style: mapStyle(theme),
      center: [lons.length?lons.reduce((a,b)=>a+b,0)/lons.length:20, lats.length?lats.reduce((a,b)=>a+b,0)/lats.length:0],
      zoom: 4, minZoom: 1, maxZoom: 14, attributionControl: false,
    });
    mapRef.current = map;
    const popup = new maplibregl.Popup({ closeButton:false, closeOnClick:false, offset:10, className:`popup-${theme}` });

    map.on('load', async () => {
      const tv = getT(theme);
      if (bounds) map.fitBounds(bounds, { padding:60, duration:0, maxZoom:8 });

      const countries = await fetch('/data/countries_110m.geojson').then(r=>r.json());
      countries.features.forEach((f,i)=>{ f.id=i; });
      map.addSource('countries', { type:'geojson', data:countries, generateId:false });
      map.addLayer({ id:'land', type:'fill', source:'countries', paint:{'fill-color':tv.land,'fill-opacity':1} });
      map.addLayer({ id:'borders', type:'line', source:'countries', paint:{'line-color':tv.worldBdr,'line-width':tv.worldBdrW} });

      const isoToCountry = {};
      for (const f of zonesGJ.features) isoToCountry[f.properties.ISO_A3] = f.properties.c;
      const uniqueIsos = [...new Set(zonesGJ.features.map(f=>f.properties.ISO_A3))];
      const fillExpr = ['match',['get','ISO_A3'],...uniqueIsos.flatMap(iso=>[iso,countryColorMap[isoToCountry[iso]]||'#888']),'transparent'];

      map.addSource('zones', { type:'geojson', data:zonesGJ, generateId:true });
      map.addLayer({ id:'zone-fill', type:'fill', source:'zones', paint:{'fill-color':fillExpr,'fill-opacity':0.28} });
      map.addLayer({ id:'zone-hover', type:'fill', source:'zones', filter:['==',['get','ISO_A3'],''], paint:{'fill-color':fillExpr,'fill-opacity':0.55} });
      map.addLayer({ id:'zone-border', type:'line', source:'zones', paint:{'line-color':fillExpr,'line-width':1.2,'line-opacity':0.75} });

      let hovIso = null;
      map.on('mousemove','zone-fill',e=>{
        map.getCanvas().style.cursor='pointer';
        const iso=e.features[0].properties.ISO_A3; const c=isoToCountry[iso]||iso;
        if(iso!==hovIso){hovIso=iso;map.setFilter('zone-hover',['==',['get','ISO_A3'],iso]);}
        popup.setLngLat(e.lngLat).setHTML(`<b>${c}</b><br><span style="opacity:.65;font-size:0.7em">click to explore results</span>`).addTo(map);
      });
      map.on('mouseleave','zone-fill',()=>{ map.getCanvas().style.cursor=''; hovIso=null; map.setFilter('zone-hover',['==',['get','ISO_A3'],'']),popup.remove(); });
      map.on('click','zone-fill',e=>{
        const iso=e.features[0].properties.ISO_A3; const c=isoToCountry[iso]||iso;
        navigate(`/region/${regionId}/results/country/${encodeURIComponent(c)}`);
      });
    });
    return () => { popup.remove(); mapRef.current?.remove(); };
  }, [region, theme, zonesGJ, zcmapRows]); // eslint-disable-line

  // ── Computed ──────────────────────────────────────────────────────────────────
  const zoneToCountry = useMemo(() => Object.fromEntries(zcmapRows.map(r=>[r.z,r.c])), [zcmapRows]);
  const allZones      = useMemo(() => zcmapRows.map(r=>r.z), [zcmapRows]);
  const allCountries  = useMemo(() => [...new Set(zcmapRows.map(r=>r.c))].sort(), [zcmapRows]);

  const hasData  = Object.keys(resultsData).length > 0;
  const allYears = useMemo(() => {
    const first = Object.values(resultsData)[0];
    return first ? resultYears(first.techFuel) : [];
  }, [resultsData]);

  const allTechfuels = useMemo(() => {
    const tfs = new Set();
    for (const d of Object.values(resultsData))
      for (const z of Object.values(d.techFuel))
        for (const attr of Object.values(z))
          for (const y of Object.values(attr))
            for (const tf of Object.keys(y)) tfs.add(tf);
    return [...tfs].filter(t=>t!=='Demand').sort();
  }, [resultsData]);

  // Dispatch seasons/daytypes from first available scenario
  const firstDispatch = Object.values(resultsData)[0]?.dispatch || {};
  const dispAvailSeasons = useMemo(() => {
    const qs = new Set();
    for (const z of Object.values(firstDispatch)) for (const q of Object.keys(z)) qs.add(q);
    return [...qs].sort();
  }, [firstDispatch]);
  const dispAvailDays = useMemo(() => {
    const ds = new Set();
    for (const z of Object.values(firstDispatch)) for (const q of Object.values(z)) for (const d of Object.keys(q)) ds.add(d);
    return [...ds].sort();
  }, [firstDispatch]);
  const totalDays = useMemo(() => Object.values(hoursData).reduce((s,dts)=>s+Object.values(dts||{}).reduce((a,b)=>a+b,0),0)||365, [hoursData]);

  // Active dispatch zone
  const activeDispZone = useMemo(() => dispZone || allZones[0] || null, [dispZone, allZones]);

  if (!region) return <div style={{ padding:40, color:t.text }}>Loading…</div>;

  // ── Overview builders ─────────────────────────────────────────────────────────
  const buildOverviewMix = () => {
    const sd = resultsData[ovScenario];
    if (!sd || !refYear) return null;
    const labels = allZones.filter(z=>sd.techFuel[z]?.[evIndicator]?.[refYear]);
    if (!labels.length) return null;
    const tfs = allTechfuels.filter(tf=>labels.some(z=>(sd.techFuel[z]?.[evIndicator]?.[refYear]?.[tf]||0)>0));
    return {
      labels,
      datasets: tfs.map(tf=>({
        label:tf, data:labels.map(z=>Math.round(sd.techFuel[z]?.[evIndicator]?.[refYear]?.[tf]||0)),
        backgroundColor:techColor(tf), borderWidth:0, barThickness:14, stack:'a',
      })),
    };
  };

  // ── Evolution builders ────────────────────────────────────────────────────────
  const buildEvolution = () => {
    const activeSc = scenarioList.filter(s=>evScenarios.has(s));
    if (!activeSc.length || !allYears.length) return null;
    const tfs = allTechfuels.filter(tf=>activeSc.some(s=>
      allZones.some(z=>(resultsData[s]?.techFuel[z]?.[evIndicator]?.[allYears[0]]?.[tf]||0)>0)
    ));
    const labels = allYears;
    // Stack per scenario: group bars [scen1_tf1, scen1_tf2, scen2_tf1, ...]
    const datasets = [];
    for (const scen of activeSc) {
      for (const tf of tfs) {
        datasets.push({
          label:`${scen} — ${tf}`,
          data: allYears.map(y => {
            const total = allZones.reduce((s,z)=>s+(resultsData[scen]?.techFuel[z]?.[evIndicator]?.[y]?.[tf]||0),0);
            return Math.round(total);
          }),
          backgroundColor: hexA(techColor(tf), activeSc.length > 1 ? 0.5 : 0.85),
          borderColor: techColor(tf),
          borderWidth: activeSc.length > 1 ? 1 : 0,
          stack: scen,
        });
      }
    }
    return { labels, datasets };
  };

  // ── Dispatch builders ─────────────────────────────────────────────────────────
  const buildDispatch = () => {
    const sd = resultsData[dispScenario];
    if (!sd || !activeDispZone) return { chartData:{labels:[],datasets:[]}, plugin:null };
    const zDisp = sd.dispatch[activeDispZone] || {};
    const isDark = t.isDark;

    if (dispMode === 'full') {
      const seasons = dispAvailSeasons;
      const days    = dispAvailDays;
      if (!seasons.length || !days.length) return { chartData:{labels:[],datasets:[]}, plugin:null };
      const nS=seasons.length, nDT=days.length, nPts=nS*nDT*24;
      const tfs = [...new Set(
        seasons.flatMap(q=>days.flatMap(d=>Object.values(zDisp[q]?.[d]||{}).flatMap(Object.keys)))
      )].filter(t=>t!=='Demand').sort();

      const datasets = tfs.map(tf=>({
        label:tf, fill:true,
        data: (() => {
          const pts=[];
          for(const s of seasons) for(const d of days) for(let h=1;h<=24;h++) {
            pts.push(zDisp[s]?.[d]?.[`t${h}`]?.[tf]||0);
          }
          return pts;
        })(),
        backgroundColor:hexA(techColor(tf),0.7), borderColor:techColor(tf), borderWidth:0, pointRadius:0, tension:0,
      }));
      // Price overlay
      const zPrice = sd.price[activeDispZone]||{};
      const priceData=[];
      for(const s of seasons) for(const d of days) for(let h=1;h<=24;h++) priceData.push(zPrice[s]?.[d]?.[`t${h}`]||null);
      if (priceData.some(v=>v!=null)) {
        datasets.push({ label:'Marginal cost', type:'line', data:priceData, yAxisID:'yR', borderColor:hexA('#E8C547',0.9), borderWidth:1.5, pointRadius:0, tension:0, fill:false, spanGaps:true });
      }

      const separatorPlugin = {
        id:'dispSep',
        afterDraw:(chart)=>{
          const{ctx,chartArea,scales}=chart; if(!chartArea||!scales.x) return;
          const{top,bottom}=chartArea; const xS=scales.x;
          const dashC=isDark?'rgba(255,255,255,0.13)':'rgba(0,0,0,0.12)';
          const solidC=isDark?'rgba(255,255,255,0.36)':'rgba(0,0,0,0.30)';
          const textC=isDark?'rgba(255,255,255,0.46)':'rgba(0,0,0,0.40)';
          const seasC=isDark?'rgba(255,255,255,0.70)':'rgba(0,0,0,0.58)';
          for(let si=0;si<nS;si++){
            const ss=si*nDT*24;
            ctx.save();ctx.font='700 9px system-ui,sans-serif';ctx.fillStyle=seasC;ctx.textAlign='center';ctx.textBaseline='bottom';
            ctx.fillText(seasons[si],xS.getPixelForValue(ss+nDT*12),top-2);ctx.restore();
            for(let di=0;di<nDT;di++){
              const dts=ss+di*24;
              if(dts>0){const lx=xS.getPixelForValue(dts);const isS=di===0;ctx.save();ctx.strokeStyle=isS?solidC:dashC;ctx.lineWidth=isS?1.2:0.7;if(!isS)ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(lx,top);ctx.lineTo(lx,bottom);ctx.stroke();ctx.restore();}
              const midX=xS.getPixelForValue(dts+12);
              const w=hoursData?.[seasons[si]]?.[days[di]]||0;const pct=w>0?` (${((w/totalDays)*100).toFixed(0)}%)`:'';
              ctx.save();ctx.translate(midX,bottom+3);ctx.rotate(-Math.PI/2);ctx.font='7px system-ui,sans-serif';ctx.fillStyle=textC;ctx.textAlign='right';ctx.textBaseline='middle';ctx.fillText(`${days[di]}${pct}`,0,0);ctx.restore();
            }
          }
        },
      };
      return { chartData:{labels:new Array(nPts).fill(''),datasets}, plugin:separatorPlugin };
    }

    // Single season/daytype
    const tfs2 = [...new Set(Object.values(zDisp[dispSeason]||{}).flatMap(d=>Object.values(d).flatMap(Object.keys)))].filter(t=>t!=='Demand').sort();
    const getDayData = (tf) => {
      const sp=zDisp[dispSeason];if(!sp)return null;
      if(dispDay==='avg'){
        const days=Object.keys(sp);
        return Array.from({length:24},(_,h)=>days.reduce((s,d)=>s+(sp[d]?.[`t${h+1}`]?.[tf]||0),0)/Math.max(days.length,1));
      }
      return Array.from({length:24},(_,h)=>sp[dispDay]?.[`t${h+1}`]?.[tf]||0);
    };
    const datasets2 = tfs2.map(tf=>({ label:tf,fill:true,data:getDayData(tf)||[],backgroundColor:hexA(techColor(tf),0.7),borderColor:techColor(tf),borderWidth:0,pointRadius:0,tension:0 }));
    return { chartData:{labels:Array.from({length:24},(_,i)=>`${i+1}h`),datasets:datasets2}, plugin:null };
  };

  const overviewMix  = buildOverviewMix();
  const evolutionData = buildEvolution();
  const dispatchResult = buildDispatch();
  const dispTechfuels = dispatchResult.chartData.datasets.filter(d=>d.label!=='Marginal cost').map(d=>d.label);

  const TABS = ['overview','evolution','dispatch'];
  const TAB_LABELS = { overview:'Overview', evolution:'Evolution', dispatch:'Dispatch' };
  const selectStyle = { fontSize:'0.5rem', fontFamily:'inherit', padding:'2px 6px', borderRadius:3, border:`1px solid ${t.panelBorder}`, backgroundColor:t.panel, color:t.muted, cursor:'pointer' };

  return (
    <div style={{ display:'flex', height:'calc(100vh - 46px)' }}>
      {/* Map */}
      <div style={{ position:'relative', flex:1 }}>
        <div ref={containerRef} style={{ width:'100%', height:'100%', backgroundColor:t.bg }} />
        <div style={{ position:'absolute', top:10, left:10, zIndex:10, display:'flex', gap:4, alignItems:'center',
          fontSize:'0.52rem', color:t.text, backgroundColor:t.panel, border:`1px solid ${t.panelBorder}`, borderRadius:5, padding:'4px 10px', boxShadow:'0 1px 4px rgba(0,0,0,.18)' }}>
          <Link to="/" style={{ color:t.lblMuted, textDecoration:'none' }}>World</Link>
          <span style={{ color:t.lblMuted }}>›</span>
          <Link to={`/region/${regionId}`} style={{ color:t.lblMuted, textDecoration:'none' }}>{region.name}</Link>
          <span style={{ color:t.lblMuted }}>›</span>
          <span style={{ color:t.lbl, fontWeight:600 }}>Results</span>
        </div>
      </div>

      {/* Right panel */}
      <div style={{ width:560, flexShrink:0, height:'100%', overflowY:'auto', padding:'18px 16px',
        backgroundColor:t.panel, borderLeft:`1px solid ${t.panelBorder}` }}>

        {/* Header */}
        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:'0.52rem', color:t.lblMuted, marginBottom:2 }}>
            <Link to={`/region/${regionId}`} style={{ color:t.lblMuted, textDecoration:'none' }}>← {region.name} · Inputs</Link>
          </div>
          <div style={{ fontSize:'1rem', fontWeight:700, color:t.lbl }}>{region.name} — Results</div>
        </div>

        {/* Run selector */}
        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:14, padding:'8px 10px',
          border:`1px solid ${t.panelBorder}`, borderRadius:6, backgroundColor:hexA(t.panelBorder,0.15) }}>
          <span style={{ fontSize:'0.5rem', color:t.lblMuted, flexShrink:0 }}>Simulation run</span>
          {loadingRuns ? (
            <span style={{ fontSize:'0.5rem', color:t.lblMuted }}>Loading…</span>
          ) : runList.length > 0 ? (
            <select value={simRun||''} onChange={e=>setSimRun(e.target.value)} style={{ ...selectStyle, flex:1 }}>
              {runList.map(r=><option key={r} value={r}>{r}</option>)}
            </select>
          ) : (
            <span style={{ fontSize:'0.5rem', color:t.lblMuted }}>No results found — push output CSV files to epm/output/</span>
          )}
        </div>

        {/* Tabs */}
        <div style={{ display:'flex', gap:0, marginBottom:16, borderBottom:`1px solid ${t.panelBorder}` }}>
          {TABS.map(tab => (
            <button key={tab} onClick={()=>setActiveTab(tab)} style={{
              fontSize:'0.5rem', fontFamily:'inherit', padding:'6px 16px', border:'none',
              borderBottom: activeTab===tab?`2px solid ${t.lbl}`:'2px solid transparent',
              backgroundColor:'transparent', color:activeTab===tab?t.lbl:t.lblMuted,
              cursor:'pointer', fontWeight:activeTab===tab?600:400,
            }}>{TAB_LABELS[tab]}</button>
          ))}
        </div>

        {loadingData && <div style={{ padding:'24px 0', textAlign:'center', color:t.lblMuted, fontSize:'0.6rem' }}>Loading results…</div>}

        {!loadingData && !hasData && simRun && scenarioList.length > 0 && (
          <div style={{ padding:'24px 0', textAlign:'center', color:t.lblMuted, fontSize:'0.6rem' }}>No result data available for this run.</div>
        )}

        {/* ════ OVERVIEW ════ */}
        {hasData && activeTab === 'overview' && (
          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>

            {/* Year + scenario selectors */}
            <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
              <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                <span style={{ fontSize:'0.5rem', color:t.lblMuted }}>Year</span>
                <select value={refYear||''} onChange={e=>setRefYear(e.target.value)} style={selectStyle}>
                  {allYears.map(y=><option key={y} value={y}>{y}</option>)}
                </select>
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                <span style={{ fontSize:'0.5rem', color:t.lblMuted }}>Scenario</span>
                <select value={ovScenario||''} onChange={e=>setOvScenario(e.target.value)} style={selectStyle}>
                  {scenarioList.map(s=><option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div style={{ display:'flex', gap:3 }}>
                <Pill active={evIndicator==='CapacityTechFuel'} onClick={()=>setEvIndicator('CapacityTechFuel')}>Capacity</Pill>
                <Pill active={evIndicator==='EnergyTechFuelComplete'} onClick={()=>setEvIndicator('EnergyTechFuelComplete')}>Energy</Pill>
              </div>
            </div>

            {/* KPIs */}
            {(() => {
              const sd = resultsData[ovScenario]; if (!sd || !refYear) return null;
              const totGW  = allZones.reduce((s,z)=>s+Object.values(sd.techFuel[z]?.CapacityTechFuel?.[refYear]||{}).reduce((a,b)=>a+b,0),0)/1000;
              const demTWh = allZones.reduce((s,z)=>s+(sd.yearlyZone[z]?.DemandEnergyZone?.[refYear]||0),0)/1000;
              const emiMt  = allZones.reduce((s,z)=>s+(sd.yearlyZone[z]?.EmissionsZone?.[refYear]||0),0)/1e6;
              return (
                <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8 }}>
                  {[
                    { l:`Installed ${refYear}`, v:`${totGW.toFixed(1)} GW` },
                    { l:`Demand ${refYear}`, v:`${demTWh.toFixed(0)} TWh` },
                    { l:`Emissions ${refYear}`, v:emiMt>0?`${emiMt.toFixed(1)} MtCO₂`:'—' },
                  ].map(({l,v})=>(
                    <div key={l} style={{ border:`1px solid ${t.panelBorder}`, borderRadius:6, padding:'8px 10px' }}>
                      <div style={{ fontSize:'0.42rem', color:t.lblMuted, marginBottom:2 }}>{l}</div>
                      <div style={{ fontSize:'0.8rem', fontWeight:700, color:t.lbl }}>{v}</div>
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* Capacity/Energy mix chart */}
            {overviewMix && (
              <div>
                <SectionTitle t={t}>{evIndicator==='CapacityTechFuel'?'Capacity':'Energy'} by zone (MW)</SectionTitle>
                <CJChart type="bar" height={Math.min(overviewMix.labels.length*22+24,280)}
                  data={overviewMix}
                  options={{ ...cjDefaults(t), indexAxis:'y',
                    scales:{
                      x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}},
                      y:{stacked:true,grid:{display:false},ticks:{color:t.muted,font:{size:8}}},
                    },
                    plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>`${ctx.dataset.label}: ${fmt(ctx.parsed.x)} MW`}}}
                  }}
                />
                {/* Fuel legend */}
                <div style={{ display:'flex', flexWrap:'wrap', gap:'3px 8px', marginTop:5 }}>
                  {allTechfuels.map(tf=>(
                    <div key={tf} style={{ display:'flex', alignItems:'center', gap:3, fontSize:'0.43rem', color:t.muted }}>
                      <div style={{ width:8, height:8, borderRadius:2, backgroundColor:techColor(tf) }}/>{tf}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ════ EVOLUTION ════ */}
        {hasData && activeTab === 'evolution' && (
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>

            {/* Controls */}
            <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
              <div style={{ display:'flex', gap:3 }}>
                <Pill active={evIndicator==='CapacityTechFuel'} onClick={()=>setEvIndicator('CapacityTechFuel')}>Capacity</Pill>
                <Pill active={evIndicator==='EnergyTechFuelComplete'} onClick={()=>setEvIndicator('EnergyTechFuelComplete')}>Energy</Pill>
                <Pill active={evIndicator==='NewCapacityTechFuel'} onClick={()=>setEvIndicator('NewCapacityTechFuel')}>New Cap</Pill>
              </div>
              <div style={{ width:1, height:14, backgroundColor:t.panelBorder }}/>
              {/* Scenario toggles */}
              {scenarioList.map(s=>(
                <Pill key={s} active={evScenarios.has(s)} onClick={()=>setEvScenarios(prev=>{const n=new Set(prev);n.has(s)?n.delete(s):n.add(s);return n;})}>{s}</Pill>
              ))}
            </div>

            {evolutionData ? (
              <>
                <CJChart type="bar" height={220}
                  cacheKey={`ev|${evIndicator}|${[...evScenarios].sort().join(',')}`}
                  data={evolutionData}
                  options={{ ...cjDefaults(t),
                    scales:{
                      x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},maxTicksLimit:10}},
                      y:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},
                        title:{display:true,text:evIndicator==='EnergyTechFuelComplete'?'GWh':'MW',color:t.muted,font:{size:7}}},
                    },
                    plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>`${ctx.dataset.label}: ${fmt(ctx.parsed.y)}`}}}
                  }}
                />
                <div style={{ display:'flex', flexWrap:'wrap', gap:'3px 8px', marginTop:2 }}>
                  {allTechfuels.map(tf=>(
                    <div key={tf} style={{ display:'flex', alignItems:'center', gap:3, fontSize:'0.43rem', color:t.muted }}>
                      <div style={{ width:8, height:8, borderRadius:2, backgroundColor:techColor(tf) }}/>{tf}
                    </div>
                  ))}
                </div>
              </>
            ) : <div style={{ color:t.lblMuted, fontSize:'0.58rem' }}>No data — select at least one scenario.</div>}
          </div>
        )}

        {/* ════ DISPATCH ════ */}
        {hasData && activeTab === 'dispatch' && (
          <div style={{ display:'flex', flexDirection:'column', gap:12 }}>

            {/* Controls */}
            <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
              <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                <span style={{ fontSize:'0.5rem', color:t.lblMuted }}>Zone</span>
                <select value={activeDispZone||''} onChange={e=>setDispZone(e.target.value)} style={selectStyle}>
                  {allZones.map(z=><option key={z} value={z}>{z}</option>)}
                </select>
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                <span style={{ fontSize:'0.5rem', color:t.lblMuted }}>Scenario</span>
                <select value={dispScenario||''} onChange={e=>setDispScenario(e.target.value)} style={selectStyle}>
                  {scenarioList.map(s=><option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                <span style={{ fontSize:'0.5rem', color:t.lblMuted }}>Year</span>
                <select value={refYear||''} onChange={e=>setRefYear(e.target.value)} style={selectStyle}>
                  {allYears.map(y=><option key={y} value={y}>{y}</option>)}
                </select>
              </div>
            </div>

            {/* Profile mode + season/daytype */}
            <div style={{ display:'flex', flexWrap:'wrap', gap:3, alignItems:'center' }}>
              <Pill active={dispMode==='full'} onClick={()=>setDispMode('full')}>Full Year</Pill>
              {dispAvailSeasons.map(s=>(
                <Pill key={s} active={dispMode==='season'&&dispSeason===s} onClick={()=>{setDispMode('season');setDispSeason(s);}}>{s}</Pill>
              ))}
              {dispMode==='season' && dispAvailDays.length>0 && (
                <>
                  <div style={{ width:1, height:14, backgroundColor:t.panelBorder }}/>
                  <select value={dispDay} onChange={e=>setDispDay(e.target.value)} style={selectStyle}>
                    <option value="avg">Avg</option>
                    {dispAvailDays.map(d=><option key={d} value={d}>{d}</option>)}
                  </select>
                </>
              )}
            </div>

            {/* Chart */}
            {dispatchResult.chartData.datasets.length > 0 ? (
              <>
                <CJChart type="line"
                  height={dispMode==='full'?210:160}
                  data={dispatchResult.chartData}
                  plugins={dispatchResult.plugin?[dispatchResult.plugin]:[]}
                  cacheKey={`disp|${dispScenario}|${activeDispZone}|${refYear}|${dispMode}|${dispSeason}|${dispDay}`}
                  options={{ ...cjDefaults(t),
                    layout:{padding:{top:dispMode==='full'?18:4,bottom:dispMode==='full'?62:4}},
                    scales:{
                      x:{grid:{color:t.panelBorder,drawTicks:false},ticks:{display:dispMode!=='full',color:t.muted,font:{size:7},maxTicksLimit:12}},
                      y:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}},stacked:true,title:{display:true,text:'MW',color:t.muted,font:{size:7}}},
                      yR:{type:'linear',position:'right',display:dispatchResult.chartData.datasets.some(d=>d.label==='Marginal cost'),
                        grid:{drawOnChartArea:false},ticks:{color:t.muted,font:{size:8}},title:{display:true,text:'USD/MWh',color:t.muted,font:{size:7}}},
                    },
                    plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false,callbacks:{label:ctx=>`${ctx.dataset.label}: ${fmt(ctx.parsed.y,1)}`}}}
                  }}
                />
                <div style={{ display:'flex', flexWrap:'wrap', gap:'3px 8px', marginTop:2 }}>
                  {dispTechfuels.map(tf=>(
                    <div key={tf} style={{ display:'flex', alignItems:'center', gap:3, fontSize:'0.43rem', color:t.muted }}>
                      <div style={{ width:8, height:8, borderRadius:2, backgroundColor:techColor(tf) }}/>{tf}
                    </div>
                  ))}
                </div>
              </>
            ) : <div style={{ color:t.lblMuted, fontSize:'0.58rem' }}>No dispatch data for this zone/scenario.</div>}
          </div>
        )}

      </div>
    </div>
  );
}
