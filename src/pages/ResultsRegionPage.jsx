import { useEffect, useRef, useState, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import { track } from '../analytics';
import { useTheme } from '../App';
import { getT, mapStyle } from '../constants';
import {
  fetchEpmCSV, fetchLinestringGeoJSON, fetchZonesGeoJSON, fetchGitHubDir, fetchResultCSV, resolveOutputDir, fetchRunList, fetchInputScenarios, fetchDispatchYear,
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
function makeScenPlugin(activeSc,color){if(!activeSc||activeSc.length<2)return null;return{id:'scenLabels',afterDraw(chart){const{ctx,chartArea:ca}=chart;if(!ca)return;ctx.save();ctx.font='8px system-ui,sans-serif';ctx.textAlign='center';ctx.textBaseline='top';ctx.fillStyle=color||'rgba(128,128,128,0.7)';activeSc.forEach((scen,si)=>{const dsIdx=chart.data.datasets.findIndex(d=>d.stack===scen);if(dsIdx<0)return;const meta=chart.getDatasetMeta(dsIdx);const nX=chart.data.labels.length;for(let xi=0;xi<nX;xi++){const bar=meta.data[xi];if(!bar)continue;ctx.fillText(`S${si+1}`,bar.x,ca.bottom+12);}});ctx.restore();}};}

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
  { key:'Trade',                         label:'Trade (GWh)',               source:'trade',      unit:'GWh' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n, d = 0) { if (n == null || isNaN(n)) return '—'; return n.toLocaleString('en-US', { maximumFractionDigits: d }); }
function fmtBig(n) { if (!n) return '—'; const a=Math.abs(n); if(a>=1e9)return`${(n/1e9).toFixed(1)}B`; if(a>=1e6)return`${(n/1e6).toFixed(1)}M`; if(a>=1e3)return`${(n/1e3).toFixed(1)}k`; return n.toFixed(1); }
function hexA(hex, a) { if (!hex||hex.length<7) return `rgba(128,128,128,${a})`; const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16); return `rgba(${r},${g},${b},${a})`; }
function cjDefaults(t) { return { responsive:true,maintainAspectRatio:false, plugins:{legend:{display:false},tooltip:{backgroundColor:t.panel,borderColor:t.panelBorder,borderWidth:1,titleColor:t.lbl,bodyColor:t.muted,titleFont:{size:11},bodyFont:{size:11},padding:6}}, scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:10}}},y:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:10}}}}}; }

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

function buildNetDotPlugin(netData){
  return{id:'netDot',afterDatasetsDraw(chart){
    if(!netData.length)return;
    const ctx=chart.ctx;const yScale=chart.scales.y;
    netData.forEach(({si,data,color})=>{
      const di=chart.data.datasets.findIndex(d=>d._si===si);
      if(di<0)return;
      const meta=chart.getDatasetMeta(di);
      data.forEach((val,i)=>{
        const bar=meta.data[i];if(!bar)return;
        const y=yScale.getPixelForValue(val);
        ctx.save();ctx.beginPath();ctx.arc(bar.x,y,3.5,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();ctx.restore();
      });
    });
  }};
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
  const [outputDir,    setOutputDir]    = useState('epm/output');
  const [simRun,       setSimRun]       = useState(null);
  const [scenarioList, setScenarioList] = useState([]);
  const [resultsData,  setResultsData]  = useState({});
  const [loadingRuns,  setLoadingRuns]  = useState(false);
  const [loadingData,  setLoadingData]  = useState(false);
  const [loadingDisp,  setLoadingDisp]  = useState(false);
  const dispLoadedRef  = useRef(new Set());
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
  const [panelWidth,     setPanelWidth]     = useState(680);
  const [mapLoadedCount, setMapLoadedCount] = useState(0);
  const [hiddenMap,      setHiddenMap]      = useState({}); // { chartId: Set<label> }
  const [pieDispMode,    setPieDispMode]    = useState('none'); // 'none'|'capacity'|'energy'
  const [cmpRef,         setCmpRef]         = useState(null);
  const [cmpScenarios,   setCmpScenarios]   = useState(new Set());
  const [cmpMode,        setCmpMode]        = useState('values');
  const [trScenarios,    setTrScenarios]    = useState(new Set());
  const [snapIndicator,  setSnapIndicator]  = useState('CapacityTechFuel');
  const [snapView,       setSnapView]       = useState('zone');
  const [snapCountry,    setSnapCountry]    = useState('all');
  const [snapScenarios,  setSnapScenarios]  = useState(new Set());
  const [plZone,         setPlZone]         = useState('all');
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
    track('results_view', { type: 'region', region: regionId });
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
    const { branch, outputDir: fixedDir, simRuns: fixedRuns } = region.epm;
    if (fixedDir) {
      // regions.json overrides outputDir (e.g. R2 branches that skip GitHub API)
      setOutputDir(fixedDir);
      const runs = (fixedRuns || []).slice().sort().reverse();
      setRunList(runs); if (runs.length) setSimRun(runs[0]);
      setLoadingRuns(false);
    } else {
      resolveOutputDir(branch).then(dir => { setOutputDir(dir); return fetchRunList(branch, dir); }).then(names => {
        const runs = (names||[]).slice().sort().reverse();
        setRunList(runs); if (runs.length) setSimRun(runs[0]);
      }).finally(()=>setLoadingRuns(false));
    }
  }, [region]);

  useEffect(() => {
    if (!region?.epm || !simRun) return;
    const { branch } = region.epm;
    // Try GitHub dir listing first; fall back to input_scenarios.csv (for R2 branches)
    fetchGitHubDir(branch, `${outputDir}/${simRun}`).then(async items => {
      let scens = (items||[]).filter(i=>i.type==='dir').map(i=>i.name).sort();
      if (!scens.length) {
        const fromCsv = await fetchInputScenarios(branch, outputDir, simRun);
        scens = (fromCsv || []).sort();
      }
      setScenarioList(scens); setEvScenarios(new Set(scens));
      if (scens.length) {
        const base = scens.find(s=>/^base(line)?$/i.test(s))||scens[0];
        setOvScenario(base); setDispScenario(base); setTrScenario(base); setPlScenario(base); setCmpRef(base);
      }
      setCmpScenarios(new Set(scens.filter(s=>!/^base(line)?$/i.test(s)&&s!==(scens.find(s2=>/^base(line)?$/i.test(s2))||scens[0]))));
      setCmpMode('values');
      setTrScenarios(new Set(scens));
      setSnapScenarios(new Set(scens));
    });
  }, [region, simRun, outputDir]);

  useEffect(() => {
    if (!region?.epm || !simRun || !scenarioList.length) return;
    setLoadingData(true);
    const { branch } = region.epm;
    Promise.all(scenarioList.map(async scen => {
      // Dispatch (pDispatchComplete) is huge -> loaded lazily per year (see effect below)
      const [tfR, yzR, prR, txR, plR, coR] = await Promise.all([
        fetchResultCSV(branch, simRun, scen, 'pTechFuelMerged.csv', outputDir),
        fetchResultCSV(branch, simRun, scen, 'pYearlyZoneMerged.csv', outputDir),
        fetchResultCSV(branch, simRun, scen, 'pHourlyPrice.csv', outputDir),
        fetchResultCSV(branch, simRun, scen, 'pTransmissionMerged.csv', outputDir),
        fetchResultCSV(branch, simRun, scen, 'pPlantMerged.csv', outputDir),
        fetchResultCSV(branch, simRun, scen, 'pCostsMerged.csv', outputDir),
      ]);
      return { scen,
        techFuel:     tfR  ? processTechFuel(tfR)              : {},
        yearlyZone:   yzR  ? processYearlyZone(yzR)            : {},
        dispatch:     {},
        price:        prR  ? processHourlyPrice(prR)           : {},
        transmission: txR  ? processTransmissionResults(txR)   : {},
        plants:       plR  ? processPlants(plR)                : [],
        costs:        coR  ? processCosts(coR)                 : {},
      };
    })).then(results => {
      const rd = Object.fromEntries(results.map(r=>[r.scen, r]));
      setResultsData(rd);
      dispLoadedRef.current = new Set(); // dispatch cache is per-run
      const yrs = resultYears(results[0]?.techFuel||{});
      if (yrs.length) setRefYear(yrs[0]);
    }).finally(()=>setLoadingData(false));
  }, [region, simRun, scenarioList]); // eslint-disable-line

  // Lazy-load dispatch for the year/scenarios actually shown (big file, split per year).
  useEffect(() => {
    if (activeTab !== 'dispatch' || !region?.epm || !simRun || !refYear) return;
    const { branch } = region.epm;
    const wanted = [dispScenario, (cmpRef && cmpRef !== dispScenario) ? cmpRef : null]
      .filter(s => s && resultsData[s]);
    wanted.forEach(async scen => {
      const key = `${scen}|${refYear}`;
      if (dispLoadedRef.current.has(key)) return;
      dispLoadedRef.current.add(key);
      setLoadingDisp(true);
      try {
        const rows = await fetchDispatchYear(branch, simRun, scen, refYear, outputDir);
        const parsed = rows ? processDispatchResults(rows) : {};
        // Legacy unsplit file returns every year -> mark them all cached
        const years = new Set(); for (const ym of Object.values(parsed)) for (const y of Object.keys(ym)) years.add(y);
        years.forEach(y => dispLoadedRef.current.add(`${scen}|${y}`));
        setResultsData(prev => {
          const sd = prev[scen]; if (!sd) return prev;
          const dispatch = { ...sd.dispatch };
          for (const [z, ym] of Object.entries(parsed)) dispatch[z] = { ...(dispatch[z]||{}), ...ym };
          return { ...prev, [scen]: { ...sd, dispatch } };
        });
      } finally { setLoadingDisp(false); }
    });
  }, [activeTab, dispScenario, cmpRef, refYear, simRun, region, outputDir, resultsData]); // eslint-disable-line

  // ── Map ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || !region || !zonesGJ) return;

    const zcMap = Object.fromEntries(zcmapRows.map(r=>[r.z, r.c]));
    const regionCountries = [...new Set(zcmapRows.map(r=>r.c))].sort();
    const colorMap = {};
    regionCountries.forEach((c,i) => { colorMap[c] = MAP_PALETTE[i%MAP_PALETTE.length]; });
    const zoneCentroids = {};
    if (linestringGJ) { for (const f of linestringGJ.features) { const coords=f.geometry.coordinates,z=f.properties.z,z2=f.properties.z_other||f.properties.z2; if(z&&!zoneCentroids[z])zoneCentroids[z]=coords[0]; if(z2&&!zoneCentroids[z2])zoneCentroids[z2]=coords[coords.length-1]; } }
    for (const f of zonesGJ.features) { const z=f.properties.z; if(z&&!zoneCentroids[z]){const c=computeCentroid(f.geometry);if(c)zoneCentroids[z]=c;} }
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
      // Wide invisible hit layer on top — makes lines easy to click/hover
      map.addLayer({ id:'ntc-hit', type:'line', source:'ntc-results',
        paint:{ 'line-color':'rgba(0,0,0,0)', 'line-width':20 } });

      // Click / hover on NTC hit layer
      const ntcPopup = new maplibregl.Popup({ closeButton:true, closeOnClick:true, offset:10, className:`popup-${theme}` });
      map.on('mouseenter','ntc-hit',()=>{ map.getCanvas().style.cursor='pointer'; });
      map.on('mouseleave','ntc-hit',()=>{ map.getCanvas().style.cursor=''; });
      map.on('click','ntc-hit',e=>{
        e.preventDefault();
        const p=e.features[0].properties;
        const fwd=parseFloat(p.fwd)||0, rev=parseFloat(p.rev)||0, net=fwd-rev;
        const util=p.util!=null?(parseFloat(p.util)*100).toFixed(0)+'%':'—';
        const cap=parseFloat(p.cap)||0;
        ntcPopup.setLngLat(e.lngLat).setHTML(
          `<b>${p.z} ↔ ${p.z2}</b> <span style="opacity:.5;font-size:0.8em">${p.yr}</span><br>` +
          `<span style="font-size:0.82em">` +
          `${p.z} → ${p.z2}: <b>${fmtBig(fwd)}</b> GWh<br>` +
          `${p.z2} → ${p.z}: <b>${fmtBig(rev)}</b> GWh<br>` +
          `Net: <b>${net>=0?'+':''}${fmtBig(net)}</b> GWh<br>` +
          `<span style="opacity:.7">Util: ${util} &nbsp;·&nbsp; Cap: ${fmtBig(cap)} MW</span>` +
          `</span>`
        ).addTo(map);
      });

      // NTC hit hover hint
      map.on('mousemove','ntc-hit',e=>{
        map.getCanvas().style.cursor='pointer';
        const p=e.features[0].properties;
        popup.setLngLat(e.lngLat).setHTML(`<b>${p.z} ↔ ${p.z2}</b><br><span style="opacity:.6;font-size:0.8em">click to see flow data</span>`).addTo(map);
      });
      map.on('mouseleave','ntc-hit',()=>{ map.getCanvas().style.cursor=''; popup.remove(); });

      // Zone hover — per-zone stats
      let hovZ=null;
      map.on('mousemove','zone-fill',e=>{
        if(map.queryRenderedFeatures(e.point,{layers:['ntc-hit']}).length){ popup.remove(); return; }
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
      map.on('click','zone-fill',e=>{ if(map.queryRenderedFeatures(e.point,{layers:['ntc-hit']}).length) return; const c=isoToCountry[e.features[0].properties.ISO_A3]||''; navigate(`/region/${regionId}/results/country/${encodeURIComponent(c)}`); });
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
    if (linestringGJ) { for (const f of linestringGJ.features) { const coords=f.geometry.coordinates,z=f.properties.z,z2=f.properties.z_other||f.properties.z2; if(z&&!zcCentroids[z])zcCentroids[z]=coords[0]; if(z2&&!zcCentroids[z2])zcCentroids[z2]=coords[coords.length-1]; } }
    if (zonesGJ) for (const f of zonesGJ.features) { const z=f.properties.z; if(z&&!zcCentroids[z]){const c=computeCentroid(f.geometry);if(c)zcCentroids[z]=c;} }

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
        const lf = linestringGJ?.features?.find(f=>(f.properties.z===z&&(f.properties.z_other||f.properties.z2)===z2)||(f.properties.z===z2&&(f.properties.z_other||f.properties.z2)===z));
        const lfFwd = !lf || lf.properties.z === z;
        let coords = null;
        if (lf) coords=lf.geometry.coordinates;
        else if (zcCentroids[z]&&zcCentroids[z2]) coords=[zcCentroids[z],zcCentroids[z2]];
        if (!coords) continue;
        const finalCoords = (lfFwd === (fwd >= rev)) ? coords : [...coords].reverse();
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
    if (linestringGJ) { for (const f of linestringGJ.features) { const coords=f.geometry.coordinates,z=f.properties.z,z2=f.properties.z_other||f.properties.z2; if(z&&!zcCentroids[z])zcCentroids[z]=coords[0]; if(z2&&!zcCentroids[z2])zcCentroids[z2]=coords[coords.length-1]; } }
    for (const f of zonesGJ.features) { const z=f.properties.z; if(z&&!zcCentroids[z]){const c=computeCentroid(f.geometry);if(c)zcCentroids[z]=c;} }
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
    const zcC={};
    if(linestringGJ){for(const f of linestringGJ.features){const coords=f.geometry.coordinates,z=f.properties.z,z2=f.properties.z_other||f.properties.z2;if(z&&!zcC[z])zcC[z]=coords[0];if(z2&&!zcC[z2])zcC[z2]=coords[coords.length-1];}}
    for(const f of zonesGJ.features){const z=f.properties.z;if(z&&!zcC[z]){const c=computeCentroid(f.geometry);if(c)zcC[z]=c;}}
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
  const csvUrl = (scen, file) => `https://raw.githubusercontent.com/ESMAP-World-Bank-Group/EPM/${region.epm?.branch}/${outputDir}/${simRun}/${scen}/output_csv/${file}`;
  const DlRow = ({files}) => simRun&&files[0][0]?<div style={{marginTop:14,paddingTop:10,borderTop:`1px solid ${hexA(t.panelBorder,0.4)}`,display:'flex',gap:5,flexWrap:'wrap',alignItems:'center'}}><span style={{fontSize:'0.38rem',color:t.lblMuted}}>↓</span>{files.map(([sc,f])=><DownloadBtn key={f} url={csvUrl(sc,f)} filename={f} t={t}/>)}</div>:null;
  const TABS = ['overview','snapshot','evolution','dispatch','trade','plants'];
  const TAB_LABELS = { overview:'Overview', snapshot:'Snapshot', evolution:'Evolution', dispatch:'Dispatch', trade:'Trade', plants:'Plants' };

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
    const activeSc=baseFirst(scenarioList.filter(s=>evScenarios.has(s))); if(!activeSc.length||!allYears.length)return null;
    const ind=activeInd;
    if (ind.source==='costs') {
      const cats=MAIN_COST_CATS.filter(cat=>activeSc.some(s=>evZones.some(z=>(resultsData[s]?.costs[z]?.[cat])||false)));
      const datasets=[]; for(const scen of activeSc) for(const cat of cats) {
        datasets.push({ label:`${scen} — ${COST_LABELS[cat]||cat}`, data:allYears.map(y=>Math.round(evZones.reduce((s,z)=>s+(resultsData[scen]?.costs[z]?.[cat]?.[y]||0),0)*10)/10), backgroundColor:hexA(costColor(cat),activeSc.length>1?0.5:0.82), borderColor:costColor(cat), borderWidth:activeSc.length>1?1:0, stack:scen });
      }
      return { labels:allYears, datasets };
    }
    if (ind.source==='yearlyZone') {
      return { labels:allYears, datasets:activeSc.map((scen,i)=>({ label:scen, data:allYears.map(y=>+evZones.reduce((s,z)=>s+(resultsData[scen]?.yearlyZone[z]?.[ind.key]?.[y]||0),0).toFixed(2)), backgroundColor:hexA(SCEN_COLORS[i%SCEN_COLORS.length],0.75), borderColor:SCEN_COLORS[i%SCEN_COLORS.length], borderWidth:2, fill:false, tension:0.3, type:'line' })) };
    }
    if(ind.source==='trade'){
      const datasets=[];
      for(let i=0;i<activeSc.length;i++){const scen=activeSc[i];const col=SCEN_COLORS[i%SCEN_COLORS.length];
        datasets.push({label:`${scen} — Imp.`,type:'bar',data:allYears.map(y=>+(Object.values(getTradeVals(scen,evZones,y)).reduce((s,v)=>s+v.imp,0)).toFixed(0)),backgroundColor:hexA(col,0.75),borderWidth:0,stack:scen});
        datasets.push({label:`${scen} — Exp.`,type:'bar',data:allYears.map(y=>+(-(Object.values(getTradeVals(scen,evZones,y)).reduce((s,v)=>s+v.exp,0))).toFixed(0)),backgroundColor:hexA(col,0.40),borderWidth:0,stack:scen});
        datasets.push({label:`${scen} — Net`,type:'line',data:allYears.map(y=>+(Object.values(getTradeVals(scen,evZones,y)).reduce((s,v)=>s+v.net,0)).toFixed(0)),borderColor:col,borderWidth:1.5,pointRadius:0,tension:0.3,fill:false,stack:`__net_${i}__`});
      }
      return{labels:allYears,datasets};
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
            ctx.save();ctx.translate(midX,bottom+3);ctx.rotate(-Math.PI/2);ctx.font='8px system-ui,sans-serif';ctx.fillStyle=tC;ctx.textAlign='right';ctx.textBaseline='middle';ctx.fillText(`${days[di]}${pct}`,0,0);ctx.restore();
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
    const activeSc=baseFirst(scenarioList.filter(s=>trScenarios.has(s)&&resultsData[s]));
    if(!activeSc.length||!allYears.length)return null;
    const tx0=resultsData[activeSc[0]]?.transmission||{}; if(!Object.keys(tx0).length)return null;
    const corridors=[]; const seen=new Set();
    for(const[z,zm] of Object.entries(tx0))for(const z2 of Object.keys(zm)){const k=[z,z2].sort().join('||');if(!seen.has(k)){seen.add(k);corridors.push({z,z2,key:k});}}
    let attr,unit;
    if(trEvMetric==='volume')       { attr='Interchange';          unit='GWh'; }
    else if(trEvMetric==='capacity'){ attr='TransmissionCapacity'; unit='MW'; }
    else                            { attr='InterconUtilization';  unit='%'; }
    const PSTYLES=['circle','rectRot','triangle','crossRot','star','rect'];
    const isUtil=trEvMetric==='utilization'; const multi=activeSc.length>1;
    const datasets=activeSc.flatMap((scen,si)=>corridors.slice(0,12).map((c,ci)=>{
      const col=MAP_PALETTE[ci%MAP_PALETTE.length];
      const data=allYears.map(y=>{
        const tx=resultsData[scen]?.transmission||{};
        const fwd=tx[c.z]?.[c.z2]?.[attr]?.[y]||0; const rev=tx[c.z2]?.[c.z]?.[attr]?.[y]||0;
        return isUtil ? +(((fwd+rev)/2)*100).toFixed(1) : +(Math.abs(fwd)+Math.abs(rev)).toFixed(1);
      });
      const label=multi?`${scen} — ${c.z}↔${c.z2}`:`${c.z}↔${c.z2}`;
      if(isUtil) return{label,data,type:'line',borderColor:col,backgroundColor:hexA(col,0.1),borderWidth:1.5,fill:false,tension:0.3,pointStyle:PSTYLES[si%PSTYLES.length],pointRadius:3,pointHoverRadius:5};
      return{label,data,backgroundColor:hexA(col,0.82),borderColor:col,borderWidth:0,stack:scen,type:'bar'};
    }));
    return{labels:allYears,corridors,unit,datasets};
  };

  // ── Plants ──────────────────────────────────────────────────────────────────
  const buildPlantsList = () => {
    const pl=(resultsData[plScenario]?.plants||[]).filter(p=>p.attribute===plIndicator&&p.y===refYear&&p.value>0&&(plZone==='all'||p.z===plZone)).sort((a,b)=>b.value-a.value).slice(0,plTopN);
    return pl;
  };

  const buildLCOEBubble = () => {
    const pl=resultsData[plScenario]?.plants||[]; if(!refYear)return null;
    const lookup={};
    for(const p of pl){ if(!lookup[p.g])lookup[p.g]={techfuel:p.techfuel,z:p.z}; lookup[p.g][p.attribute]=p.attribute===p.attribute?p.value:lookup[p.g][p.attribute]; if(!lookup[p.g][p.attribute]||p.y===refYear)lookup[p.g][p.attribute]=p.y===refYear?p.value:lookup[p.g][p.attribute]; }
    // Build per refYear
    const byG={};
    for(const p of pl.filter(pp=>pp.y===refYear)){ if(!byG[p.g])byG[p.g]={techfuel:p.techfuel,z:p.z}; byG[p.g][p.attribute]=p.value; }
    const points=Object.entries(byG).map(([g,d])=>({g,techfuel:d.techfuel||'',zone:d.z||'',lcoe:d.PlantAnnualLCOE||0,util:(d.UtilizationPlant||0)*100,cap:d.CapacityPlant||0})).filter(p=>p.lcoe>0&&p.util>0&&p.cap>0&&(plZone==='all'||p.zone===plZone));
    const tfs=[...new Set(points.map(p=>p.techfuel))].sort();
    return { datasets:tfs.map(tf=>({ label:tf, data:points.filter(p=>p.techfuel===tf).map(p=>({ x:+p.util.toFixed(1), y:+p.lcoe.toFixed(1), r:Math.min(Math.max(Math.sqrt(p.cap)*0.6,3),20), _plant:p.g, _cap:p.cap })), backgroundColor:hexA(techColor(tf),0.65), borderColor:techColor(tf), borderWidth:1 })).filter(d=>d.data.length>0) };
  };

  // ── Scenario comparison (shared across tabs) ──────────────────────────────
  const findBase = scens => scens.find(s=>/^base/i.test(s))||scens[0];
  const baseFirst = arr => [...arr].sort((a,b)=>(/^base/i.test(a)?-1:/^base/i.test(b)?1:0));
  const SCEN_COLORS = ['#1B6CA8','#36B5B5','#4169E1','#D4A820','#B83838','#7048A8','#4A9E6A','#2E9EC8'];
  const getEvVal = (scen, y, ind) => {
    if(ind.source==='techFuel') return evZones.reduce((s,z)=>s+Object.values(resultsData[scen]?.techFuel[z]?.[ind.key]?.[y]||{}).reduce((a,b)=>a+b,0),0);
    if(ind.source==='yearlyZone') return evZones.reduce((s,z)=>s+(resultsData[scen]?.yearlyZone[z]?.[ind.key]?.[y]||0),0);
    if(ind.source==='costs') return MAIN_COST_CATS.reduce((s,cat)=>s+evZones.reduce((s2,z)=>s2+(resultsData[scen]?.costs[z]?.[cat]?.[y]||0),0),0);
    return 0;
  };
  // Trade helper: {imp, exp, net} per zone for a given year
  const getTradeVals = (scen, zones, y) => {
    const tx=resultsData[scen]?.transmission||{};
    return Object.fromEntries(zones.map(z=>{
      const imp=Object.values(tx).reduce((s,zm)=>s+(zm[z]?.Interchange?.[y]||0),0);
      const exp=Object.values(tx[z]||{}).reduce((s,attrs)=>s+(attrs.Interchange?.[y]||0),0);
      return[z,{imp:+imp.toFixed(1),exp:+exp.toFixed(1),net:+(imp-exp).toFixed(1)}];
    }));
  };
  const buildCmpEvolution = () => {
    if(!cmpRef||!allYears.length)return null;
    const compareScs=baseFirst([...cmpScenarios].filter(s=>resultsData[s]&&s!==cmpRef));
    if(!compareScs.length)return null;
    const ind=activeInd;
    const multi=compareScs.length>1;

    if(ind.source==='techFuel'){
      // Stacked signed bars by techfuel, grouped by scenario (same visual as main chart but showing Δ)
      const tfs=allTechfuels.filter(tf=>
        [...compareScs,cmpRef].some(scen=>evZones.some(z=>
          allYears.some(y=>(resultsData[scen]?.techFuel[z]?.[ind.key]?.[y]?.[tf]||0)>0)
        ))
      );
      const datasets=[];
      for(const scen of compareScs){
        for(const tf of tfs){
          const data=allYears.map(y=>{
            const ref=evZones.reduce((s,z)=>s+(resultsData[cmpRef]?.techFuel[z]?.[ind.key]?.[y]?.[tf]||0),0);
            const cmp=evZones.reduce((s,z)=>s+(resultsData[scen]?.techFuel[z]?.[ind.key]?.[y]?.[tf]||0),0);
            return Math.round(cmp-ref);
          });
          if(data.some(v=>v!==0))datasets.push({
            label:multi?`${scen} — ${tf}`:tf,
            data,
            backgroundColor:hexA(techColor(tf),multi?0.5:0.82),
            borderColor:techColor(tf),
            borderWidth:multi?1:0,
            stack:scen,
          });
        }
      }
      return{labels:allYears,datasets};
    }

    if(ind.source==='trade'){
      const datasets=[];
      for(let i=0;i<compareScs.length;i++){const scen=compareScs[i];const col=SCEN_COLORS[(i+1)%SCEN_COLORS.length];
        const tvCmp=y=>getTradeVals(scen,evZones,y); const tvRef=y=>getTradeVals(cmpRef,evZones,y);
        const dImp=allYears.map(y=>+(Object.values(tvCmp(y)).reduce((s,v)=>s+v.imp,0)-Object.values(tvRef(y)).reduce((s,v)=>s+v.imp,0)).toFixed(0));
        const dExp=allYears.map(y=>+(Object.values(tvCmp(y)).reduce((s,v)=>s+v.exp,0)-Object.values(tvRef(y)).reduce((s,v)=>s+v.exp,0)).toFixed(0));
        const dNet=allYears.map(y=>+(Object.values(tvCmp(y)).reduce((s,v)=>s+v.net,0)-Object.values(tvRef(y)).reduce((s,v)=>s+v.net,0)).toFixed(0));
        if(dImp.some(v=>v!==0))datasets.push({label:multi?`Δ ${scen} Imp.`:'Δ Imp.',type:'bar',data:dImp,backgroundColor:hexA(col,0.75),borderWidth:0,stack:scen});
        if(dExp.some(v=>v!==0))datasets.push({label:multi?`Δ ${scen} Exp.`:'Δ Exp.',type:'bar',data:dExp.map(v=>-v),backgroundColor:hexA(col,0.40),borderWidth:0,stack:scen});
        if(dNet.some(v=>v!==0))datasets.push({label:multi?`Δ ${scen} Net`:'Δ Net',type:'line',data:dNet,borderColor:col,borderWidth:1.5,pointRadius:0,tension:0.3,fill:false,stack:`__dnet_${i}__`});
      }
      return{labels:allYears,datasets};
    }
    // yearlyZone / costs: single signed bar per scenario (no techfuel breakdown available)
    return{labels:allYears,datasets:compareScs.map((scen,i)=>({
      label:`Δ ${scen}`,
      data:allYears.map(y=>+(getEvVal(scen,y,ind)-getEvVal(cmpRef,y,ind)).toFixed(1)),
      backgroundColor:hexA(SCEN_COLORS[(i+1)%SCEN_COLORS.length],0.75),
      borderColor:SCEN_COLORS[(i+1)%SCEN_COLORS.length],
      borderWidth:0, stack:scen,
    }))};
  };

  // ── Snapshot ──────────────────────────────────────────────────────────────
  const buildSnapshot = () => {
    if(!refYear||!snapScenarios.size)return null;
    const activeSc=baseFirst(scenarioList.filter(s=>snapScenarios.has(s)&&resultsData[s]));
    if(!activeSc.length)return null;
    const ind=INDICATORS.find(i=>i.key===snapIndicator)||INDICATORS[0];
    const groups=snapView==='zone'?(snapCountry!=='all'?allZones.filter(z=>zoneToCountry[z]===snapCountry):allZones):allCountries;
    const multi=activeSc.length>1;
    const getZones=grp=>snapView==='zone'?[grp]:allZones.filter(z=>zoneToCountry[z]===grp);
    const getTf=(scen,grp,tf)=>getZones(grp).reduce((s,z)=>s+(resultsData[scen]?.techFuel[z]?.[ind.key]?.[refYear]?.[tf]||0),0);
    const getTotal=(scen,grp)=>{
      const zs=getZones(grp);
      if(ind.source==='techFuel') return zs.reduce((s,z)=>s+Object.values(resultsData[scen]?.techFuel[z]?.[ind.key]?.[refYear]||{}).reduce((a,b)=>a+b,0),0);
      if(ind.source==='yearlyZone') return zs.reduce((s,z)=>s+(resultsData[scen]?.yearlyZone[z]?.[ind.key]?.[refYear]||0),0);
      if(ind.source==='costs') return MAIN_COST_CATS.reduce((s,cat)=>s+zs.reduce((s2,z)=>s2+(resultsData[scen]?.costs[z]?.[cat]?.[refYear]||0),0),0);
      return 0;
    };
    if(ind.source==='techFuel'){
      const tfs=allTechfuels.filter(tf=>activeSc.some(scen=>groups.some(g=>getTf(scen,g,tf)>0)));
      const datasets=[];
      for(const scen of activeSc) for(const tf of tfs){
        const data=groups.map(g=>Math.round(getTf(scen,g,tf)));
        if(data.some(v=>v>0)) datasets.push({label:multi?`${scen} — ${tf}`:tf,data,backgroundColor:hexA(techColor(tf),multi?0.5:0.82),borderColor:techColor(tf),borderWidth:multi?1:0,stack:scen});
      }
      return{labels:groups,datasets,ind};
    }
    if(ind.source==='trade'){
      const datasets=[];const netPluginData=[];
      for(let i=0;i<activeSc.length;i++){const scen=activeSc[i];const col=SCEN_COLORS[i%SCEN_COLORS.length];
        const tv=getTradeVals(scen,allZones,refYear);
        const getGrpVal=(grp,key)=>getZones(grp).reduce((s,z)=>s+(tv[z]?.[key]||0),0);
        datasets.push({label:`${activeSc.length>1?scen+' — ':''}Imp.`,type:'bar',data:groups.map(g=>+getGrpVal(g,'imp').toFixed(0)),backgroundColor:hexA(col,0.75),borderWidth:0,stack:scen,_si:i});
        datasets.push({label:`${activeSc.length>1?scen+' — ':''}Exp.`,type:'bar',data:groups.map(g=>+(-getGrpVal(g,'exp')).toFixed(0)),backgroundColor:hexA(col,0.40),borderWidth:0,stack:scen});
        netPluginData.push({si:i,data:groups.map(g=>+getGrpVal(g,'net').toFixed(0)),color:col});
      }
      return{labels:groups,datasets,ind,netPlugin:buildNetDotPlugin(netPluginData)};
    }
    return{labels:groups,datasets:activeSc.map((scen,i)=>({label:scen,data:groups.map(g=>+(getTotal(scen,g)).toFixed(2)),backgroundColor:hexA(SCEN_COLORS[i%SCEN_COLORS.length],0.78),borderWidth:0,stack:scen})).filter(d=>d.data.some(v=>v>0)),ind};
  };

  const buildSnapshotDelta = () => {
    if(!cmpRef||!refYear)return null;
    const compareScs=baseFirst([...cmpScenarios].filter(s=>resultsData[s]&&s!==cmpRef));
    if(!compareScs.length)return null;
    const ind=INDICATORS.find(i=>i.key===snapIndicator)||INDICATORS[0];
    const groups=snapView==='zone'?(snapCountry!=='all'?allZones.filter(z=>zoneToCountry[z]===snapCountry):allZones):allCountries;
    const multi=compareScs.length>1;
    const getZones=grp=>snapView==='zone'?[grp]:allZones.filter(z=>zoneToCountry[z]===grp);
    const getTf=(scen,grp,tf)=>getZones(grp).reduce((s,z)=>s+(resultsData[scen]?.techFuel[z]?.[ind.key]?.[refYear]?.[tf]||0),0);
    const getTotal=(scen,grp)=>{
      const zs=getZones(grp);
      if(ind.source==='techFuel') return zs.reduce((s,z)=>s+Object.values(resultsData[scen]?.techFuel[z]?.[ind.key]?.[refYear]||{}).reduce((a,b)=>a+b,0),0);
      if(ind.source==='yearlyZone') return zs.reduce((s,z)=>s+(resultsData[scen]?.yearlyZone[z]?.[ind.key]?.[refYear]||0),0);
      return 0;
    };
    if(ind.source==='techFuel'){
      const tfs=allTechfuels.filter(tf=>[...compareScs,cmpRef].some(scen=>groups.some(g=>getTf(scen,g,tf)>0)));
      const datasets=[];
      for(const scen of compareScs) for(const tf of tfs){
        const data=groups.map(g=>+(getTf(scen,g,tf)-getTf(cmpRef,g,tf)).toFixed(0));
        if(data.some(v=>v!==0)) datasets.push({label:multi?`${scen} — ${tf}`:tf,data,backgroundColor:hexA(techColor(tf),multi?0.5:0.82),borderColor:techColor(tf),borderWidth:multi?1:0,stack:scen});
      }
      return{labels:groups,datasets,ind};
    }
    if(ind.source==='trade'){
      const datasets=[];const netPluginData=[];
      for(let i=0;i<compareScs.length;i++){const scen=compareScs[i];const col=SCEN_COLORS[(i+1)%SCEN_COLORS.length];
        const tvCmp=getTradeVals(scen,allZones,refYear); const tvRef=getTradeVals(cmpRef,allZones,refYear);
        const getD=(grp,key)=>getZones(grp).reduce((s,z)=>s+((tvCmp[z]?.[key]||0)-(tvRef[z]?.[key]||0)),0);
        const dImp=groups.map(g=>+getD(g,'imp').toFixed(0)); const dExp=groups.map(g=>+getD(g,'exp').toFixed(0)); const dNet=groups.map(g=>+getD(g,'net').toFixed(0));
        if(dImp.some(v=>v!==0))datasets.push({label:multi?`Δ ${scen} Imp.`:'Δ Imp.',type:'bar',data:dImp,backgroundColor:hexA(col,0.75),borderWidth:0,stack:scen,_si:i});
        if(dExp.some(v=>v!==0))datasets.push({label:multi?`Δ ${scen} Exp.`:'Δ Exp.',type:'bar',data:dExp.map(v=>-v),backgroundColor:hexA(col,0.40),borderWidth:0,stack:scen});
        if(dNet.some(v=>v!==0))netPluginData.push({si:i,data:dNet,color:col});
      }
      return{labels:groups,datasets,ind,netPlugin:buildNetDotPlugin(netPluginData)};
    }
    const DCOLS=['#3887C4','#4A9E6A','#D4A820','#B83838'];
    return{labels:groups,datasets:compareScs.map((scen,i)=>({label:`Δ ${scen}`,data:groups.map(g=>+(getTotal(scen,g)-getTotal(cmpRef,g)).toFixed(2)),backgroundColor:hexA(DCOLS[i%4],0.72),borderColor:DCOLS[i%4],borderWidth:0,stack:scen})).filter(d=>d.data.some(v=>v!==0)),ind};
  };

  // ── Dispatch Δ ────────────────────────────────────────────────────────────
  const buildDispatchDelta = () => {
    const cmpScen=cmpRef;
    if(!cmpScen||cmpScen===dispScenario||!refYear||!activeDispZone||!resultsData[cmpScen])return{chartData:{labels:[],datasets:[]},plugin:null};
    const sdA=resultsData[dispScenario],sdB=resultsData[cmpScen];
    if(!sdA||!sdB)return{chartData:{labels:[],datasets:[]},plugin:null};
    const zA=getZoneDisp(sdA,activeDispZone,refYear),zB=getZoneDisp(sdB,activeDispZone,refYear);
    const seasons=dispAvailS,days=dispAvailD;
    const mcColor=t.isDark?'rgba(255,255,255,0.88)':'#1E3A8A';
    const addMC=(ds,labels,prA,prB)=>{const d=labels.map((_,i)=>{const a=prA[i],b=prB[i];return(a!=null&&b!=null)?+(a-b).toFixed(2):null;});if(d.some(v=>v!=null))ds.push({label:'Marginal cost',type:'line',data:d,yAxisID:'yR',borderColor:mcColor,borderWidth:1,pointRadius:0,tension:0,fill:false,spanGaps:true,order:1});return ds;};
    const mkDatasets=(tfs,getA,getB,nPts,labels,prA,prB)=>{
      const ds=tfs.map(tf=>({
        label:tf,fill:true,
        data:Array.from({length:nPts},(_,i)=>+(getA(i,tf)-getB(i,tf)).toFixed(1)),
        backgroundColor:hexA(techColor(tf),0.7),borderColor:techColor(tf),
        borderWidth:0,pointRadius:0,tension:0,stack:'gen',
      })).filter(d=>d.data.some(v=>v!==0));
      return{chartData:{labels,datasets:addMC(ds,labels,prA||[],prB||[])},plugin:null};
    };
    if(dispMode==='full'&&seasons.length&&days.length){
      const nPts=seasons.length*days.length*24;
      const tfs=[...new Set([zA,zB].flatMap(z=>seasons.flatMap(s=>days.flatMap(d=>Object.values(z[s]?.[d]||{}).flatMap(Object.keys)))))].filter(t=>t!=='Demand').sort();
      const pts=seasons.flatMap(s=>days.flatMap(d=>Array.from({length:24},(_,h)=>[s,d,h])));
      const zoneKey=activeDispZone==='__all__'?allZones[0]:activeDispZone;
      const prA=pts.map(([s,d,h])=>sdA.price[zoneKey]?.[refYear]?.[s]?.[d]?.[`t${h+1}`]??null);
      const prB=pts.map(([s,d,h])=>sdB.price[zoneKey]?.[refYear]?.[s]?.[d]?.[`t${h+1}`]??null);
      const labels=new Array(nPts).fill('');
      return mkDatasets(tfs,(i,tf)=>zA[pts[i][0]]?.[pts[i][1]]?.[`t${pts[i][2]+1}`]?.[tf]||0,(i,tf)=>zB[pts[i][0]]?.[pts[i][1]]?.[`t${pts[i][2]+1}`]?.[tf]||0,nPts,labels,prA,prB);
    }
    const spA=zA[dispSeason],spB=zB[dispSeason];
    if(!spA&&!spB)return{chartData:{labels:[],datasets:[]},plugin:null};
    const tfs=[...new Set([spA,spB].flatMap(sp=>Object.values(sp||{}).flatMap(d=>Object.values(d).flatMap(Object.keys))))].filter(t=>t!=='Demand').sort();
    const gv=(sp,h,tf)=>dispDay==='avg'?Object.keys(sp||{}).reduce((s,d)=>s+(sp[d]?.[`t${h+1}`]?.[tf]||0),0)/Math.max(Object.keys(sp||{}).length,1):(sp?.[dispDay]?.[`t${h+1}`]?.[tf]||0);
    const zoneKey=activeDispZone==='__all__'?allZones[0]:activeDispZone;
    const priceA=sdA.price[zoneKey]?.[refYear]?.[dispSeason]||{};const priceB=sdB.price[zoneKey]?.[refYear]?.[dispSeason]||{};
    const pA=Array.from({length:24},(_,h)=>dispDay==='avg'?Object.keys(priceA).reduce((s,d)=>s+(priceA[d]?.[`t${h+1}`]??0),0)/Math.max(Object.keys(priceA).length,1):(priceA[dispDay]?.[`t${h+1}`]??null));
    const pB=Array.from({length:24},(_,h)=>dispDay==='avg'?Object.keys(priceB).reduce((s,d)=>s+(priceB[d]?.[`t${h+1}`]??0),0)/Math.max(Object.keys(priceB).length,1):(priceB[dispDay]?.[`t${h+1}`]??null));
    return mkDatasets(tfs,(i,tf)=>gv(spA,i,tf),(i,tf)=>gv(spB,i,tf),24,Array.from({length:24},(_,i)=>`${i+1}h`),pA,pB);
  };

  // ── Plants compare ────────────────────────────────────────────────────────
  const buildPlantsCompare = () => {
    const cmpScen=cmpRef;
    if(!cmpScen||cmpScen===plScenario||!refYear)return null;
    const pl2=resultsData[cmpScen]?.plants||[];
    return Object.fromEntries(pl2.filter(p=>p.attribute===plIndicator&&p.y===refYear&&p.value>0).map(p=>[p.g,p.value]));
  };

  // ── Trade multi-scenario ──────────────────────────────────────────────────
  const buildTradeBarMulti = () => {
    const activeSc=baseFirst(scenarioList.filter(s=>trScenarios.has(s)&&resultsData[s]));
    if(!activeSc.length||!refYear)return null;
    const getData=(scen)=>{const tx=resultsData[scen]?.transmission||{};const imp={},exp={};for(const z of allZones){imp[z]=0;exp[z]=0;for(const[,attrs]of Object.entries(tx[z]||{}))exp[z]+=(attrs.Interchange?.[refYear]||0);for(const[z2,zm]of Object.entries(tx))if(z2!==z)imp[z]+=(zm[z]?.Interchange?.[refYear]||0);}return{imp,exp};};
    const trData=Object.fromEntries(activeSc.map(s=>[s,getData(s)]));
    const zones=allZones.filter(z=>activeSc.some(s=>(trData[s].imp[z]+trData[s].exp[z])>0.5)).sort((a,b)=>(trData[activeSc[0]].imp[b]-trData[activeSc[0]].exp[b])-(trData[activeSc[0]].imp[a]-trData[activeSc[0]].exp[a]));
    if(!zones.length)return null;
    const IMP_COLORS=['#2E9EC8','#1B6CA8','#36B5B5','#4169E1'];
    const EXP_COLORS=['#E8C547','#D4A820','#EDD770','#4CAFE8'];
    const datasets=[];
    for(let i=0;i<activeSc.length;i++){
      const scen=activeSc[i];
      if(!isHidden('trade-ms',`${scen}_imp`))datasets.push({label:`${scen} — Imp.`,data:zones.map(z=>+(trData[scen].imp[z]||0).toFixed(0)),backgroundColor:hexA(IMP_COLORS[i%4],0.78),borderWidth:0,barThickness:Math.max(4,12/activeSc.length),stack:scen});
      if(!isHidden('trade-ms',`${scen}_exp`))datasets.push({label:`${scen} — Exp.`,data:zones.map(z=>+(-trData[scen].exp[z]||0).toFixed(0)),backgroundColor:hexA(EXP_COLORS[i%4],0.78),borderWidth:0,barThickness:Math.max(4,12/activeSc.length),stack:scen});
    }
    // Comparison Δ datasets when cmpMode=delta and cmpRef in trScenarios
    if(cmpMode==='delta'&&cmpRef&&trScenarios.has(cmpRef)&&activeSc.filter(s=>s!==cmpRef).length){
      const ref=getData(cmpRef);
      for(const scen of activeSc.filter(s=>s!==cmpRef)){
        datasets.push({label:`Δ ${scen} Imp.`,data:zones.map(z=>+((trData[scen].imp[z]||0)-(ref.imp[z]||0)).toFixed(0)),backgroundColor:hexA(IMP_COLORS[activeSc.indexOf(scen)%4],0.5),borderWidth:1,borderColor:IMP_COLORS[activeSc.indexOf(scen)%4],barThickness:4,stack:`delta_${scen}`});
        datasets.push({label:`Δ ${scen} Exp.`,data:zones.map(z=>+((trData[scen].exp[z]||0)-(ref.exp[z]||0)).toFixed(0)),backgroundColor:hexA(EXP_COLORS[activeSc.indexOf(scen)%4],0.5),borderWidth:1,borderColor:EXP_COLORS[activeSc.indexOf(scen)%4],barThickness:4,stack:`delta_${scen}`});
      }
    }
    return{labels:zones,datasets,_activeSc:activeSc};
  };

  const overviewMix=buildOverviewMix(), evolutionData=buildEvolution();
  const cmpEvData=buildCmpEvolution();
  const snapData=buildSnapshot();
  const snapDeltaData=buildSnapshotDelta();
  // ── Trade corridor Δ ─────────────────────────────────────────────────────
  const buildTradeCmpDelta = () => {
    if(!cmpRef||!allYears.length||!resultsData[cmpRef])return null;
    const compareScs=baseFirst([...cmpScenarios].filter(s=>resultsData[s]&&s!==cmpRef));
    if(!compareScs.length)return null;
    // Sync metric with upper chart
    const attr=trEvMetric==='capacity'?'TransmissionCapacity':trEvMetric==='utilization'?'InterconUtilization':'Interchange';
    const unit=trEvMetric==='volume'?'GWh':trEvMetric==='capacity'?'MW':'%';
    const firstActive=baseFirst([...trScenarios].filter(s=>resultsData[s]))[0]||cmpRef||scenarioList[0];
    const tx0=resultsData[firstActive]?.transmission||{};
    const seen=new Set(); const allCorridors=[];
    for(const[z,zm] of Object.entries(tx0)) for(const z2 of Object.keys(zm)){const k=[z,z2].sort().join('||');if(!seen.has(k)){seen.add(k);allCorridors.push({z,z2,key:k});}}
    // Sync hidden corridors with upper chart
    const corridors=allCorridors.slice(0,12).filter(c=>!isHidden('trade-ev',`${c.z}↔${c.z2}`));
    if(!corridors.length)return null;
    const getVal=(scen,c,y)=>{const tx=resultsData[scen]?.transmission||{};
      if(trEvMetric==='utilization') return (((tx[c.z]?.[c.z2]?.[attr]?.[y]||0)+(tx[c.z2]?.[c.z]?.[attr]?.[y]||0))/2)*100;
      return Math.abs(tx[c.z]?.[c.z2]?.[attr]?.[y]||0)+Math.abs(tx[c.z2]?.[c.z]?.[attr]?.[y]||0);
    };
    const isUtil=trEvMetric==='utilization';
    return{labels:allYears,unit,datasets:compareScs.flatMap((scen,i)=>corridors.map((c,ci)=>{
      const ci2=allCorridors.findIndex(a=>a.key===c.key);
      const col=MAP_PALETTE[ci2%MAP_PALETTE.length];
      const data=allYears.map(y=>+(getVal(scen,c,y)-getVal(cmpRef,c,y)).toFixed(isUtil?1:0));
      if(isUtil) return{label:`${compareScs.length>1?scen+' — ':''}${c.z}↔${c.z2}`,data,type:'line',borderColor:col,backgroundColor:hexA(col,0.1),borderWidth:2,fill:false,tension:0.3,pointRadius:0};
      return{label:`${compareScs.length>1?scen+' — ':''}${c.z}↔${c.z2}`,data,backgroundColor:hexA(col,0.72),borderColor:col,borderWidth:0,stack:scen};
    })).filter(d=>d.data.some(v=>v!==0))};
  };

  const dispResult=buildDispatch();
  const dispDeltaResult=(cmpRef&&cmpRef!==dispScenario&&resultsData[cmpRef])?buildDispatchDelta():{chartData:{labels:[],datasets:[]}};
  const plantsCompareMap=buildPlantsCompare();
  const tradeCmpDeltaData=buildTradeCmpDelta();
  const tradeEvData=buildTradeEvolution();
  const plantsData=buildPlantsList(), lcoeData=buildLCOEBubble();
  const dispTechfuels=dispResult.chartData.datasets.filter(d=>d.label!=='Marginal cost'&&d.label!=='Demand').map(d=>d.label);

  // ── Legend helpers ──────────────────────────────────────────────────────────
  const tfLabel=d=>d.label.includes(' — ')?d.label.split(' — ')[1]:d.label;
  const makeLegend=(id,items,clickable=true)=>{
    const hidden=hiddenMap[id]||new Set();
    return <div style={{width:90,flexShrink:0,display:'flex',flexDirection:'column',gap:2,paddingTop:4,maxHeight:220,overflowY:'auto'}}>
      {items.map(({label,color,shape})=><div key={label} onClick={clickable?()=>toggleHidden(id,label):undefined} style={{display:'flex',alignItems:'center',gap:3,cursor:clickable?'pointer':'default',opacity:hidden.has(label)?0.25:1}}>
        {shape==='line'?<div style={{width:12,height:2,backgroundColor:color,borderRadius:1,flexShrink:0}}/>:<div style={{width:8,height:8,borderRadius:shape==='circle'?'50%':2,backgroundColor:color,flexShrink:0}}/>}
        <span style={{fontSize:'0.4rem',color:t.muted,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{label}</span>
      </div>)}
      {clickable&&<div style={{fontSize:'0.38rem',color:t.lblMuted,marginTop:4,display:'flex',gap:6}}>
        <span onClick={()=>setHiddenMap(p=>({...p,[id]:new Set(items.map(i=>i.label))}))} style={{cursor:'pointer',textDecoration:'underline'}}>None</span>
        <span onClick={()=>setHiddenMap(p=>({...p,[id]:new Set()}))} style={{cursor:'pointer',textDecoration:'underline'}}>All</span>
      </div>}
    </div>;
  };

  // ── JSX ─────────────────────────────────────────────────────────────────────
  return (
    <div style={{ display:'flex', height:'calc(100vh - 46px)' }}
      onMouseMove={e=>{ if(!isDraggingRef.current)return; const dx=dragStartX.current-e.clientX; setPanelWidth(Math.max(380,dragStartW.current+dx)); }}
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
              <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                <div style={{flex:1,minWidth:0}}>
                  <CJChart type="bar" height={Math.min(overviewMix.labels.length*22+24,300)} cacheKey={`ov|${ovScenario}|${refYear}|${ovMixMode}|${theme}|${[...hiddenMap['ov-mix']||[]].join(',')}`} data={{...overviewMix,datasets:overviewMix.datasets.filter(d=>!isHidden('ov-mix',d.label))}}
                    options={{...cjDefaults(t),indexAxis:'y',scales:{x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}},y:{stacked:true,grid:{display:false},ticks:{color:t.muted,font:{size:8}}}},plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>`${ctx.dataset.label}: ${fmt(ctx.parsed.x)} MW`}}}}}
                  />
                </div>
                {makeLegend('ov-mix',allTechfuels.filter(tf=>overviewMix.datasets.some(d=>d.label===tf)).map(tf=>({label:tf,color:techColor(tf)})))}
              </div>
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

        {/* ════ SNAPSHOT ════ */}
        {hasData&&activeTab==='snapshot'&&(
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            {/* Controls */}
            <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
              <select value={snapIndicator} onChange={e=>setSnapIndicator(e.target.value)} style={selectStyle}>{INDICATORS.map(ind=><option key={ind.key} value={ind.key}>{ind.label}</option>)}</select>
              <select value={refYear||''} onChange={e=>setRefYear(e.target.value)} style={selectStyle}>{allYears.map(y=><option key={y} value={y}>{y}</option>)}</select>
              <div style={{width:1,height:14,backgroundColor:t.panelBorder}}/>
              <select value={snapCountry} onChange={e=>setSnapCountry(e.target.value)} style={selectStyle}><option value="all">All countries</option>{allCountries.map(c=><option key={c} value={c}>{c}</option>)}</select>
              <Pill active={snapView==='zone'} onClick={()=>setSnapView('zone')}>Zone</Pill>
              <Pill active={snapView==='country'} onClick={()=>setSnapView('country')}>Country</Pill>
              <div style={{width:1,height:14,backgroundColor:t.panelBorder}}/>
              {baseFirst(scenarioList).map(s=><Pill key={s} active={snapScenarios.has(s)} onClick={()=>setSnapScenarios(prev=>{const n=new Set(prev);n.has(s)?n.delete(s):n.add(s);return n;})}>{scenarioList.length>1?`S${baseFirst(scenarioList).indexOf(s)+1} — ${s}`:s}</Pill>)}
            </div>
            {/* Absolute chart */}
            {snapData&&snapData.datasets.length>0?
              <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                <div style={{flex:1,minWidth:0}}>
                  <CJChart type="bar" height={220}
                    cacheKey={`snap|${snapIndicator}|${refYear}|${snapView}|${theme}|${[...snapScenarios].sort().join(',')}|${[...hiddenMap['snap-tf']||[]].join(',')}`}
                    plugins={(()=>{const aSc=baseFirst(scenarioList.filter(s=>snapScenarios.has(s)&&resultsData[s]));const sp=makeScenPlugin(aSc,t.muted);return[snapData.netPlugin,sp].filter(Boolean);})()}
                    data={{labels:snapData.labels,datasets:snapData.datasets.filter(d=>!isHidden('snap-tf',tfLabel(d)))}}
                    options={{...cjDefaults(t),datasets:{bar:{barPercentage:0.72}},scales:{
                      x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:7},maxRotation:45,autoSkip:true,maxTicksLimit:20,padding:16}},
                      y:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:(snapData.ind||{}).unit||'',color:t.muted,font:{size:7}}},
                    },plugins:{...cjDefaults(t).plugins,legend:{display:false},tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false,callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.raw?.toLocaleString?.()??ctx.raw}`}}}}}
                  />
                  {[...snapScenarios].filter(s=>resultsData[s]).length>1&&(snapData.ind?.source==='yearlyZone'?
                    <div style={{display:'flex',gap:6,flexWrap:'wrap',marginTop:3,fontSize:'0.42rem',color:t.muted}}>
                      {baseFirst(scenarioList.filter(s=>snapScenarios.has(s)&&resultsData[s])).map((s,i)=><span key={s} style={{display:'flex',alignItems:'center',gap:3}}><span style={{display:'inline-block',width:7,height:7,borderRadius:1,backgroundColor:SCEN_COLORS[i%SCEN_COLORS.length]}}/>{s}</span>)}
                    </div>:
                    <div style={{display:'none'}}></div>
                  )}
                </div>
                {makeLegend('snap-tf',[...new Set(snapData.datasets.map(tfLabel))].map(tf=>({label:tf,color:techColor(tf)||SCEN_COLORS[0]})))}
              </div>
            :<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>Select at least one scenario.</div>}
            {/* Δ vs ref section */}
            {scenarioList.length>1&&(
              <div style={{borderTop:`1px solid ${hexA(t.panelBorder,0.4)}`,paddingTop:10,marginTop:2,display:'flex',flexDirection:'column',gap:8}}>
                <div style={{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}}>
                  <span style={{fontSize:'0.47rem',letterSpacing:'2px',fontWeight:700,color:t.lblMuted,textTransform:'uppercase'}}>Δ vs ref:</span>
                  <select value={cmpRef||''} onChange={e=>{setCmpRef(e.target.value);setCmpScenarios(new Set(scenarioList.filter(s=>s!==e.target.value)));}} style={selectStyle}>
                    {scenarioList.map(s=><option key={s} value={s}>{s}</option>)}
                  </select>
                  {scenarioList.filter(s=>s!==cmpRef).map(s=>(
                    <Pill key={s} active={cmpScenarios.has(s)} onClick={()=>setCmpScenarios(prev=>{const n=new Set(prev);n.has(s)?n.delete(s):n.add(s);return n;})}>{s}</Pill>
                  ))}
                </div>
                {snapDeltaData&&snapDeltaData.datasets.length>0?
                  <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                    <div style={{flex:1,minWidth:0}}>
                      <CJChart type="bar" height={180}
                        cacheKey={`snap-d|${snapIndicator}|${refYear}|${snapView}|${theme}|${cmpRef}|${[...cmpScenarios].sort().join(',')}|${[...hiddenMap['snap-tf']||[]].join(',')}`}
                        plugins={snapDeltaData.netPlugin?[snapDeltaData.netPlugin]:[]}
                        data={{labels:snapDeltaData.labels,datasets:snapDeltaData.datasets.filter(d=>!isHidden('snap-tf',tfLabel(d)))}}
                        options={{...cjDefaults(t),scales:{
                          x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:7},maxRotation:45,autoSkip:true,maxTicksLimit:20}},
                          y:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:(snapDeltaData.ind||{}).unit||'',color:t.muted,font:{size:7}}},
                        },plugins:{...cjDefaults(t).plugins,legend:{display:false},tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false,callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.raw>0?'+':''}${ctx.raw?.toLocaleString?.()??ctx.raw}`,footer:ctxs=>{const total=ctxs.reduce((s,c)=>s+(c.raw||0),0);return total!==0?`Net: ${total>0?'+':''}${Math.round(total).toLocaleString()}`:undefined;}}}}}}
                      />
                      {[...cmpScenarios].filter(s=>resultsData[s]&&s!==cmpRef).length>0&&(
                        <div style={{fontSize:'0.42rem',color:t.lblMuted,marginTop:3}}>Δ vs <b style={{color:t.muted}}>{cmpRef}</b>: {baseFirst([...cmpScenarios].filter(s=>resultsData[s]&&s!==cmpRef)).join(' · ')}</div>
                      )}
                    </div>
                    {makeLegend('snap-tf',[...new Set(snapDeltaData.datasets.map(tfLabel))].map(tf=>({label:tf,color:techColor(tf)||SCEN_COLORS[0]})))}
                  </div>
                :<div style={{fontSize:'0.55rem',color:t.lblMuted}}>{[...cmpScenarios].filter(s=>s!==cmpRef&&resultsData[s]).length>0?'No differences found.':'Select at least one scenario to compare.'}</div>}
              </div>
            )}
          </div>
        )}

        {/* ════ EVOLUTION ════ */}
        {hasData&&activeTab==='evolution'&&(
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
              <select value={evIndicator} onChange={e=>setEvIndicator(e.target.value)} style={selectStyle}>{INDICATORS.map(ind=><option key={ind.key} value={ind.key}>{ind.label}</option>)}</select>
              <select value={evCountry} onChange={e=>setEvCountry(e.target.value)} style={selectStyle}><option value="all">All countries</option>{allCountries.map(c=><option key={c} value={c}>{c}</option>)}</select>
              <div style={{width:1,height:14,backgroundColor:t.panelBorder}}/>
              {baseFirst(scenarioList).map(s=><Pill key={s} active={evScenarios.has(s)} onClick={()=>setEvScenarios(prev=>{const n=new Set(prev);n.has(s)?n.delete(s):n.add(s);return n;})}>{scenarioList.length>1?`S${baseFirst(scenarioList).indexOf(s)+1} — ${s}`:s}</Pill>)}
            </div>
            {evolutionData?
              <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                <div style={{flex:1,minWidth:0}}>
                  <CJChart type={activeInd.source==='yearlyZone'?'line':'bar'} height={220}
                    cacheKey={`ev|${evIndicator}|${[...evScenarios].sort().join(',')}|${evCountry}|${theme}|${[...hiddenMap['ev-tf']||[]].join(',')}|${[...hiddenMap['ev-cost']||[]].join(',')}`}
                    data={{...evolutionData,datasets:evolutionData.datasets.filter(d=>{
                      if(activeInd.source==='techFuel') return !isHidden('ev-tf',tfLabel(d));
                      if(activeInd.source==='costs') return !isHidden('ev-cost',tfLabel(d));
                      return true;
                    })}}
                    plugins={(()=>{const aSc=baseFirst(scenarioList.filter(s=>evScenarios.has(s)&&resultsData[s]));const sp=makeScenPlugin(aSc,t.muted);return sp?[sp]:[];})()}
                    options={{...cjDefaults(t),datasets:{bar:{barPercentage:0.72}},scales:{x:{stacked:activeInd.source!=='yearlyZone',grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},maxTicksLimit:10,padding:16}},y:{stacked:activeInd.source!=='yearlyZone',grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:activeInd.unit,color:t.muted,font:{size:7}}}},plugins:{...cjDefaults(t).plugins,legend:activeInd.source==='yearlyZone'&&evScenarios.size>1?{display:true,labels:{color:t.muted,font:{size:8},boxWidth:8,boxHeight:6}}:{display:false},tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>`${ctx.dataset.label}: ${fmt(ctx.parsed.y)}`}}}}}
                  />
                </div>
                {activeInd.source==='techFuel'&&makeLegend('ev-tf',allTechfuels.filter(tf=>evolutionData.datasets.some(d=>tfLabel(d)===tf)).map(tf=>({label:tf,color:techColor(tf)})))}
                {activeInd.source==='costs'&&makeLegend('ev-cost',MAIN_COST_CATS.filter(cat=>evolutionData.datasets.some(d=>tfLabel(d)===(COST_LABELS[cat]||cat))).map(cat=>({label:COST_LABELS[cat]||cat,color:costColor(cat)})))}
              </div>
            :<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>Select at least one scenario.</div>}
            {/* ── Compare scenarios (Δ vs ref, stacked by techfuel) ── */}
            {scenarioList.length>1&&(
              <div style={{borderTop:`1px solid ${hexA(t.panelBorder,0.4)}`,paddingTop:10,marginTop:6,display:'flex',flexDirection:'column',gap:8}}>
                <div style={{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}}>
                  <span style={{fontSize:'0.47rem',letterSpacing:'2px',fontWeight:700,color:t.lblMuted,textTransform:'uppercase'}}>Δ vs ref:</span>
                  <select value={cmpRef||''} onChange={e=>{setCmpRef(e.target.value);setCmpScenarios(new Set(scenarioList.filter(s=>s!==e.target.value)));}} style={selectStyle}>
                    {scenarioList.map(s=><option key={s} value={s}>{s}</option>)}
                  </select>
                  {scenarioList.filter(s=>s!==cmpRef).map(s=>(
                    <Pill key={s} active={cmpScenarios.has(s)} onClick={()=>setCmpScenarios(prev=>{const n=new Set(prev);n.has(s)?n.delete(s):n.add(s);return n;})}>{s}</Pill>
                  ))}
                </div>
                {(()=>{const hasSc=[...cmpScenarios].filter(s=>s!==cmpRef&&resultsData[s]).length>0;
                return cmpEvData&&cmpEvData.datasets.length>0?
                  <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                    <div style={{flex:1,minWidth:0}}>
                      <CJChart type="bar" height={190}
                        cacheKey={`cmp-ev|${evIndicator}|${cmpRef}|${[...cmpScenarios].sort().join(',')}|${evCountry}|${theme}|${[...hiddenMap['ev-tf']||[]].join(',')}|${[...hiddenMap['ev-cost']||[]].join(',')}`}
                        data={{...cmpEvData,datasets:cmpEvData.datasets.filter(d=>{
                          if(activeInd.source==='techFuel') return !isHidden('ev-tf',tfLabel(d));
                          if(activeInd.source==='costs') return !isHidden('ev-cost',tfLabel(d));
                          return true;
                        })}}
                        options={{...cjDefaults(t),scales:{
                          x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},maxTicksLimit:10}},
                          y:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:activeInd.unit,color:t.muted,font:{size:7}}},
                        },plugins:{...cjDefaults(t).plugins,legend:activeInd.source==='yearlyZone'?{display:true,labels:{color:t.muted,font:{size:8},boxWidth:8,boxHeight:6}}:{display:false},tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false,callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.raw>0?'+':''}${ctx.raw?.toLocaleString?.()??ctx.raw}`,footer:ctxs=>{const total=ctxs.reduce((s,c)=>s+(c.raw||0),0);return total!==0?`Net: ${total>0?'+':''}${Math.round(total).toLocaleString()} ${activeInd.unit}`:undefined;}}}}}}
                      />
                      {activeInd.source!=='yearlyZone'&&[...cmpScenarios].filter(s=>resultsData[s]&&s!==cmpRef).length>0&&(
                        <div style={{fontSize:'0.42rem',color:t.lblMuted,marginTop:3}}>Δ vs <b style={{color:t.muted}}>{cmpRef}</b>: {baseFirst([...cmpScenarios].filter(s=>resultsData[s]&&s!==cmpRef)).join(' · ')}</div>
                      )}
                    </div>
                    {activeInd.source==='techFuel'&&makeLegend('ev-tf',[...new Set(cmpEvData.datasets.map(tfLabel))].map(tf=>({label:tf,color:techColor(tf)||SCEN_COLORS[0]})))}
                    {activeInd.source==='costs'&&makeLegend('ev-cost',[...new Set(cmpEvData.datasets.map(tfLabel))].map(tf=>({label:tf,color:costColor(tf)})))}
                  </div>
                :<div style={{fontSize:'0.55rem',color:t.lblMuted}}>{hasSc?'No differences found for this indicator between selected scenarios.':'Select at least one scenario to compare.'}</div>;})()}
              </div>
            )}
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
            {dispResult.chartData.datasets.length>0?
              <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                <div style={{flex:1,minWidth:0}}>
                  <CJChart type="line" height={dispMode==='full'?255:195}
                    data={{...dispResult.chartData,datasets:dispResult.chartData.datasets.filter(d=>!isHidden('disp-tf',d.label))}}
                    plugins={dispResult.plugin?[dispResult.plugin]:[]}
                    cacheKey={`disp|${dispScenario}|${activeDispZone}|${refYear}|${dispMode}|${dispSeason}|${dispDay}|${theme}|${[...hiddenMap['disp-tf']||[]].join(',')}`}
                    options={{...cjDefaults(t),layout:{padding:{top:dispMode==='full'?18:4,bottom:dispMode==='full'?70:4}},scales:{x:{grid:{color:hexA(t.panelBorder,0.35),drawTicks:false},ticks:{display:dispMode!=='full',color:t.muted,font:{size:7},maxTicksLimit:12}},y:{stacked:true,grid:{color:hexA(t.panelBorder,0.35)},ticks:{color:t.muted,font:{size:8}},title:{display:true,text:'MW',color:t.muted,font:{size:7}}},yR:{type:'linear',position:'right',display:dispResult.chartData.datasets.some(d=>d.label==='Marginal cost'&&!isHidden('disp-tf','Marginal cost')),grid:{drawOnChartArea:false},ticks:{color:t.muted,font:{size:8}},title:{display:true,text:'USD/MWh',color:t.muted,font:{size:7}}}},plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false}}}}
                  />
                </div>
                {makeLegend('disp-tf',[
                  ...dispTechfuels.map(tf=>({label:tf,color:techColor(tf)})),
                  {label:'Demand',color:'#8B0000',shape:'line'},
                  {label:'Marginal cost',color:t.isDark?'rgba(255,255,255,0.88)':'#1E3A8A',shape:'line'},
                ])}
              </div>
            :<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>{loadingDisp?'Loading dispatch…':'No dispatch data.'}</div>}
            {/* ── Dispatch Δ section ── */}
            {scenarioList.length>1&&(
              <div style={{borderTop:`1px solid ${hexA(t.panelBorder,0.4)}`,paddingTop:10,marginTop:6,display:'flex',flexDirection:'column',gap:8}}>
                <div style={{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}}>
                  <span style={{fontSize:'0.47rem',letterSpacing:'2px',fontWeight:700,color:t.lblMuted,textTransform:'uppercase'}}>Δ vs ref:</span>
                  <select value={cmpRef||''} onChange={e=>{setCmpRef(e.target.value);setCmpScenarios(new Set(scenarioList.filter(s=>s!==e.target.value)));}} style={selectStyle}>
                    {scenarioList.map(s=><option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                {cmpRef&&cmpRef!==dispScenario&&dispDeltaResult.chartData.datasets.length>0?<>
                  <SectionTitle t={t}>Δ {dispScenario} − {cmpRef} (MW)</SectionTitle>
                  <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                    <div style={{flex:1,minWidth:0}}>
                      <CJChart type="line" height={dispMode==='full'?215:155}
                        data={{...dispDeltaResult.chartData,datasets:dispDeltaResult.chartData.datasets.filter(d=>!isHidden('disp-tf',d.label))}}
                        plugins={dispDeltaResult.plugin?[dispDeltaResult.plugin]:[]}
                        cacheKey={`disp-d|${dispScenario}|${cmpRef}|${activeDispZone}|${refYear}|${dispMode}|${dispSeason}|${dispDay}|${theme}|${[...hiddenMap['disp-tf']||[]].join(',')}`}
                        options={{...cjDefaults(t),layout:{padding:{top:dispMode==='full'?18:4,bottom:dispMode==='full'?70:4}},
                          scales:{
                            x:{grid:{color:hexA(t.panelBorder,0.35),drawTicks:false},ticks:{display:dispMode!=='full',color:t.muted,font:{size:7},maxTicksLimit:12}},
                            y:{stacked:true,grid:{color:hexA(t.panelBorder,0.35)},ticks:{color:t.muted,font:{size:8}},title:{display:true,text:'ΔMW',color:t.muted,font:{size:7}}},
                            yR:{type:'linear',position:'right',display:dispDeltaResult.chartData.datasets.some(d=>d.label==='Marginal cost'&&!isHidden('disp-tf','Marginal cost')),grid:{drawOnChartArea:false},ticks:{color:t.muted,font:{size:8}},title:{display:true,text:'Δ$/MWh',color:t.muted,font:{size:7}}},
                          },
                          plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false,callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.raw>0?'+':''}${ctx.raw?.toLocaleString?.()}`}}}}}
                      />
                    </div>
                    {makeLegend('disp-tf',[...dispTechfuels.map(tf=>({label:tf,color:techColor(tf)})),{label:'Demand',color:'#8B0000',shape:'line'},{label:'Marginal cost',color:t.isDark?'rgba(255,255,255,0.88)':'#1E3A8A',shape:'line'}])}
                  </div>
                </>:cmpRef&&cmpRef===dispScenario?
                  <div style={{fontSize:'0.55rem',color:t.lblMuted}}>Select a different reference scenario.</div>:
                  <div style={{fontSize:'0.55rem',color:t.lblMuted}}>No differences found.</div>}
              </div>
            )}
            <DlRow files={[[dispScenario,'pDispatchComplete.csv'],[dispScenario,'pHourlyPrice.csv']]}/>
          </div>
        )}

        {/* ════ TRADE ════ */}
        {hasData&&activeTab==='trade'&&(
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
              {baseFirst(scenarioList).map(s=><Pill key={s} active={trScenarios.has(s)} onClick={()=>setTrScenarios(prev=>{const n=new Set(prev);n.has(s)?n.delete(s):n.add(s);return n;})}>{scenarioList.length>1?`S${baseFirst(scenarioList).indexOf(s)+1} — ${s}`:s}</Pill>)}
            </div>

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
                      cacheKey={`trev|${[...trScenarios].sort().join(',')}|${trEvMetric}|${theme}|${[...hiddenMap['trade-ev']||[]].join(',')}`}
                      data={{ labels:tradeEvData.labels, datasets:tradeEvData.datasets.filter(d=>!isHidden('trade-ev',tfLabel(d))) }}
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
                    <div style={{ fontSize:'0.38rem',color:t.lblMuted,marginTop:4,display:'flex',gap:6 }}>
                      <span style={{cursor:'pointer',textDecoration:'underline'}} onClick={()=>setHiddenMap(prev=>({...prev,'trade-ev':new Set(allCorridors.slice(0,12).map(c=>`${c.z}↔${c.z2}`))}))}>None</span>
                      <span style={{cursor:'pointer',textDecoration:'underline'}} onClick={()=>setHiddenMap(prev=>({...prev,'trade-ev':new Set()}))}>All</span>
                    </div>
                  </div>
                </div>
              </>;
            })()}
            {/* Δ corridor section */}
            {scenarioList.length>1&&(
              <div style={{borderTop:`1px solid ${hexA(t.panelBorder,0.4)}`,paddingTop:10,marginTop:2,display:'flex',flexDirection:'column',gap:8}}>
                <div style={{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}}>
                  <span style={{fontSize:'0.47rem',letterSpacing:'2px',fontWeight:700,color:t.lblMuted,textTransform:'uppercase'}}>Δ vs ref:</span>
                  <select value={cmpRef||''} onChange={e=>{setCmpRef(e.target.value);setCmpScenarios(new Set(scenarioList.filter(s=>s!==e.target.value)));}} style={selectStyle}>
                    {scenarioList.map(s=><option key={s} value={s}>{s}</option>)}
                  </select>
                  {scenarioList.filter(s=>s!==cmpRef).map(s=>(
                    <Pill key={s} active={cmpScenarios.has(s)} onClick={()=>setCmpScenarios(prev=>{const n=new Set(prev);n.has(s)?n.delete(s):n.add(s);return n;})}>{s}</Pill>
                  ))}
                </div>
                {tradeCmpDeltaData&&tradeCmpDeltaData.datasets.length>0?
                  <CJChart type="bar" height={200}
                    cacheKey={`trev-d|${[...trScenarios].sort().join(',')}|${cmpRef}|${[...cmpScenarios].sort().join(',')}|${trEvMetric}|${theme}|${[...hiddenMap['trade-ev']||[]].join(',')}`}
                    data={{labels:tradeCmpDeltaData.labels,datasets:tradeCmpDeltaData.datasets}}
                    options={{...cjDefaults(t),scales:{
                      x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},maxTicksLimit:10}},
                      y:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:`Δ${tradeCmpDeltaData.unit||'GWh'}`,color:t.muted,font:{size:7}}},
                    },plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false,callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.raw>0?'+':''}${ctx.raw?.toLocaleString?.()}`}}}}}
                  />
                :<div style={{fontSize:'0.55rem',color:t.lblMuted}}>{[...cmpScenarios].filter(s=>s!==cmpRef&&resultsData[s]).length>0?'No corridor differences found.':'Select at least one scenario to compare.'}</div>}
              </div>
            )}
            <DlRow files={[[baseFirst([...trScenarios].filter(s=>resultsData[s]))[0]||scenarioList[0],'pTransmissionMerged.csv']]}/>
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
              <select value={plZone} onChange={e=>setPlZone(e.target.value)} style={selectStyle}><option value="all">All zones</option>{allZones.map(z=><option key={z} value={z}>{z}</option>)}</select>
            </div>
            {/* Ranking */}
            {plantsData.length>0?<>
              <SectionTitle t={t}>Top {plTopN} — {plIndicator.replace('Plant','').replace(/([A-Z])/g,' $1').trim()}</SectionTitle>
              <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                <div style={{flex:1,minWidth:0}}>
                  {(()=>{const pd=plantsData.filter(p=>!isHidden('plants-tf',p.techfuel));return(
                    <CJChart type="bar" height={Math.min(pd.length*18+24,260)} cacheKey={`pl|${plScenario}|${refYear}|${plIndicator}|${plTopN}|${theme}|${[...hiddenMap['plants-tf']||[]].join(',')}`}
                      data={{labels:pd.map(p=>p.g),datasets:[{label:plScenario,data:pd.map(p=>+p.value.toFixed(2)),backgroundColor:pd.map(p=>hexA(techColor(p.techfuel),0.85)),borderWidth:0,barThickness:12}]}}
                      options={{...cjDefaults(t),indexAxis:'y',scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}},y:{grid:{display:false},ticks:{color:t.muted,font:{size:7}}}}}}
                    />
                  );})()}
                </div>
                {makeLegend('plants-tf',[...new Set(plantsData.map(p=>p.techfuel))].map(tf=>({label:tf,color:techColor(tf)})))}
              </div>
            </>:<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>No plant data for this run/scenario.</div>}
            {/* LCOE bubble — always below */}
            {lcoeData&&lcoeData.datasets.length>0&&<>
              <SectionTitle t={t}>LCOE vs Utilization — bubble = capacity</SectionTitle>
              <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                <div style={{flex:1,minWidth:0}}>
                  <CJChart type="bubble" height={250} cacheKey={`lcoe|${plScenario}|${refYear}|${theme}|${[...hiddenMap['lcoe-tf']||[]].join(',')}`}
                    data={{...lcoeData,datasets:lcoeData.datasets.filter(ds=>!isHidden('lcoe-tf',ds.label))}}
                    options={{...cjDefaults(t),plugins:{...cjDefaults(t).plugins,
                      tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>{const d=ctx.raw;return[`${d._plant||ctx.dataset.label}`,`LCOE: ${d.y} $/MWh  ·  Util: ${d.x.toFixed(0)}%`,d._cap?`Cap: ${fmt(d._cap)} MW`:''].filter(Boolean);}}}},
                      scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}},title:{display:true,text:'Utilization (%)',color:t.muted,font:{size:8}},min:0,max:105},y:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}},title:{display:true,text:'LCOE (USD/MWh)',color:t.muted,font:{size:8}},min:0}}}}
                  />
                </div>
                {makeLegend('lcoe-tf',lcoeData.datasets.map(ds=>({label:ds.label,color:ds.backgroundColor,shape:'circle'})))}
              </div>
            </>}
            <DlRow files={[[plScenario,'pPlantMerged.csv'],[plScenario,'pCostsMerged.csv']]}/>
          </div>
        )}

      </div>
    </div>
  );
}
