import { useEffect, useRef, useState, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import { track } from '../analytics';
import { useTheme } from '../App';
import { getT, mapStyle } from '../constants';
import {
  fetchEpmCSV, fetchZonesGeoJSON, fetchLinestringGeoJSON, fetchGitHubDir, fetchResultCSV, resolveOutputDir,
  processTechFuel, processYearlyZone, processDispatchResults, processHourlyPrice,
  processHours, processTransmissionResults, processPlants, processCosts,
  computeCentroid, normalizeFuel, EPM_FUEL_COLORS, resultYears,
} from '../utils/epmFetch';

// ── Constants / helpers (shared with RegionPage) ──────────────────────────────

const MAP_PALETTE = ['#1B6CA8','#36B5B5','#E8C547','#4DA6FF','#4169E1','#85C1E9','#2E9EC8','#5EBCBA','#1A5276','#7EC8E3','#14A094','#4CAFE8','#EDD770','#AED6F1','#1F618D','#0A6B70'];
const SCEN_COLORS=['#3B82F6','#10B981','#F59E0B','#8B5CF6','#EF4444','#6B7280'];
function buildNetDotPlugin(netData){return{id:'netDot',afterDatasetsDraw(chart){if(!netData.length)return;const ctx=chart.ctx;const yScale=chart.scales.y;netData.forEach(({si,data,color})=>{const di=chart.data.datasets.findIndex(d=>d._si===si);if(di<0)return;const meta=chart.getDatasetMeta(di);data.forEach((val,i)=>{const bar=meta.data[i];if(!bar)return;const y=yScale.getPixelForValue(val);ctx.save();ctx.beginPath();ctx.arc(bar.x,y,3.5,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();ctx.restore();});});}};}
function getTradeValsC(resultsData,scen,zones,y){const tx=resultsData[scen]?.transmission||{};const res={};for(const z of zones){let imp=0,exp=0;for(const[z2,attrs]of Object.entries(tx[z]||{}))exp+=(attrs.Interchange?.[y]||0);for(const[z2,zm]of Object.entries(tx))if(z2!==z)imp+=(zm[z]?.Interchange?.[y]||0);res[z]={imp,exp,net:imp-exp};}return res;}
const TECHFUEL_COLORS = { Nuclear:'#C8A8F0',Coal:'#808890',Gas:'#9A7040',CCGT:'#B8921A',OCGT:'#C4A820',Diesel:'#6A7888',HFO:'#7A7068',Oil:'#7A7068',Biomass:'#52C860',Waste:'#8A9098',Geothermal:'#D4A820',Reservoir:'#1E9AF5',ROR:'#5DADE2',ReservoirHydro:'#1E9AF5',PSH:'#0D7680',Solar:'#FFD700',PV:'#FFD700',CSP:'#E8C547',RPV:'#FFD700','Onshore Wind':'#44DAEC',OnshoreWind:'#44DAEC','Offshore Wind':'#7CC8FA',OffshoreWind:'#7CC8FA',Battery:'#A3D5FF',Storage:'#AED6F1',ICE:'#6A7888',ST:'#C8A8F0' };
function techColor(tf) { return TECHFUEL_COLORS[tf]||EPM_FUEL_COLORS[normalizeFuel(tf)]||'#AAAAAA'; }
function fmt(n,d=0){if(n==null||isNaN(n))return'—';return n.toLocaleString('en-US',{maximumFractionDigits:d});}
function fmtBig(n){if(!n)return'—';const a=Math.abs(n);if(a>=1e3)return`${(n/1e3).toFixed(1)}k`;return n.toFixed(1);}
function hexA(hex,a){if(!hex||hex.length<7)return`rgba(128,128,128,${a})`;const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);return`rgba(${r},${g},${b},${a})`;}
function cjDefaults(t){return{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{backgroundColor:t.panel,borderColor:t.panelBorder,borderWidth:1,titleColor:t.lbl,bodyColor:t.muted,titleFont:{size:11},bodyFont:{size:11},padding:6}},scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:10}}},y:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:10}}}}};}
function priceColor(t_){return`rgb(${Math.round(255-t_*(255-27))},${Math.round(255-t_*(255-108))},${Math.round(255-t_*(255-168))})`}
function priceBarColor(t_){return`rgb(${Math.round(46+t_*(232-46))},${Math.round(158+t_*(197-158))},${Math.round(200+t_*(71-200))})`}

const COST_COLORS={'Fuel costs: $m':'#E8C547','Fixed O&M: $m':'#4DA6FF','Variable O&M: $m':'#36B5B5','Investment costs: $m':'#8B5CF6','Carbon costs: $m':'#EF4444','VRE curtailment: $m':'#F59E0B','Transmission costs: $m':'#1B6CA8'};
const COST_LABELS={'Fuel costs: $m':'Fuel','Fixed O&M: $m':'Fixed O&M','Variable O&M: $m':'Var O&M','Investment costs: $m':'CAPEX','Carbon costs: $m':'Carbon','VRE curtailment: $m':'Curtailment','Transmission costs: $m':'Transmission'};
const MAIN_COST_CATS=['Fuel costs: $m','Fixed O&M: $m','Variable O&M: $m','Investment costs: $m','Carbon costs: $m','VRE curtailment: $m','Transmission costs: $m'];
function costColor(cat){return COST_COLORS[cat]||'#888888';}

const INDICATORS=[
  {key:'CapacityTechFuel',label:'Capacity (MW)',source:'techFuel',unit:'MW'},
  {key:'EnergyTechFuelComplete',label:'Energy (GWh)',source:'techFuel',unit:'GWh'},
  {key:'NewCapacityTechFuel',label:'New Capacity (MW)',source:'techFuel',unit:'MW'},
  {key:'NewCapacityTechFuelCumulated',label:'Cum. New Cap (MW)',source:'techFuel',unit:'MW'},
  {key:'ReserveSpinningTechFuel',label:'Spinning Reserve (GWh)',source:'techFuel',unit:'GWh'},
  {key:'CostsBreakdown',label:'Costs breakdown (m USD)',source:'costs',unit:'m USD'},
  {key:'Costs',label:'Costs total (m USD)',source:'yearlyZone',unit:'m USD'},
  {key:'CapexInvestmentComponent',label:'CAPEX (m USD)',source:'yearlyZone',unit:'m USD'},
  {key:'GenCostsPerMWh',label:'Gen Cost (USD/MWh)',source:'yearlyZone',unit:'USD/MWh'},
  {key:'DemandEnergyZone',label:'Demand (GWh)',source:'yearlyZone',unit:'GWh'},
  {key:'Trade',label:'Trade (GWh)',source:'trade',unit:'GWh'},
];

function CJChart({type,data,options,height,plugins:ep,cacheKey}){
  const ref=useRef(null);const chart=useRef(null);
  const sig=JSON.stringify({type,labels:data.labels,ck:cacheKey,ds:data.datasets?.map(d=>({l:d.label,n:d.data?.length,t:d.type}))});
  useEffect(()=>{const CJ=window.Chart;if(!CJ||!ref.current)return;chart.current?.destroy();chart.current=new CJ(ref.current,{type,data,options,plugins:ep||[]});return()=>{chart.current?.destroy();chart.current=null;};},[sig]); // eslint-disable-line
  return <div style={{height,width:'100%',position:'relative'}}><canvas ref={ref}/></div>;
}
function SectionTitle({t,children,right}){return<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}><div style={{fontSize:'0.47rem',letterSpacing:'2px',fontWeight:700,color:t.lblMuted,textTransform:'uppercase'}}>{children}</div>{right}</div>;}
function Pill({active,onClick,children}){return<button onClick={onClick} style={{fontSize:'0.44rem',fontFamily:'inherit',padding:'2px 7px',borderRadius:3,cursor:'pointer',border:`1px solid ${active?'rgba(74,143,204,0.65)':'rgba(128,160,192,0.2)'}`,backgroundColor:active?'rgba(74,143,204,0.12)':'transparent',color:active?'rgba(74,143,204,1)':'rgba(128,160,192,0.7)',fontWeight:active?600:400}}>{children}</button>;}

// ── Main component ────────────────────────────────────────────────────────────

export default function ResultsCountryPage() {
  const { regionId, countryName } = useParams();
  const countryDecoded = decodeURIComponent(countryName);
  const { theme } = useTheme(); const t = getT(theme); const navigate = useNavigate();

  const containerRef = useRef(null); const mapRef = useRef(null); const dotMarkersRef = useRef([]);
  const resultsDataRef = useRef({}); const refYearRef = useRef(null);
  const ovScenarioRef = useRef(null); const hoursDataRef = useRef({});

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
  const [activeTab,    setActiveTab]    = useState('overview');
  const [refYear,      setRefYear]      = useState(null);
  const [ovScenario,   setOvScenario]   = useState(null);
  const [evIndicator,  setEvIndicator]  = useState('CapacityTechFuel');
  const [evScenarios,  setEvScenarios]  = useState(new Set());
  const [dispScenario, setDispScenario] = useState(null);
  const [dispZone,     setDispZone]     = useState(null);
  const [dispMode,     setDispMode]     = useState('full');
  const [dispSeason,   setDispSeason]   = useState('Q1');
  const [dispDay,      setDispDay]      = useState('avg');
  const [trScenario,   setTrScenario]   = useState(null);
  const [trEvMetric,   setTrEvMetric]   = useState('volume');
  const [plScenario,   setPlScenario]   = useState(null);
  const [plIndicator,  setPlIndicator]  = useState('CapacityPlant');
  const [plTopN,       setPlTopN]       = useState(15);
  const [mapLoadedCount, setMapLoadedCount] = useState(0);
  const [hiddenMap,    setHiddenMap]    = useState({});
  const [panelWidth,   setPanelWidth]   = useState(520);
  const [snapIndicator,setSnapIndicator]= useState('CapacityTechFuel');
  const [snapScenarios,setSnapScenarios]= useState(new Set());
  const [cmpRef,       setCmpRef]       = useState(null);
  const [cmpScenarios, setCmpScenarios] = useState(new Set());
  const [trScenarios,  setTrScenarios]  = useState(new Set());
  const [plZone,       setPlZone]       = useState('all');
  const [selZone,      setSelZone]      = useState('all');
  const [pieDispMode,  setPieDispMode]  = useState('none');
  const pieMarkersRef = useRef([]);

  const isDrRef = useRef(false); const drStartX = useRef(0); const drStartW = useRef(0);
  const toggleHidden=(id,label)=>setHiddenMap(p=>{const s=new Set(p[id]||[]);s.has(label)?s.delete(label):s.add(label);return{...p,[id]:s};});
  const isHidden=(id,label)=>hiddenMap[id]?.has(label)||false;

  useEffect(()=>{resultsDataRef.current=resultsData;},[resultsData]);
  useEffect(()=>{refYearRef.current=refYear;},[refYear]);
  useEffect(()=>{ovScenarioRef.current=ovScenario;},[ovScenario]);
  useEffect(()=>{hoursDataRef.current=hoursData;},[hoursData]);

  useEffect(()=>{track('results_view',{type:'country',region:regionId,country:countryDecoded});fetch('/data/regions.json').then(r=>r.json()).then(d=>{const r=(d.regions||[]).find(r=>r.id===regionId);setRegion(r||null);});},[regionId,countryDecoded]);

  useEffect(()=>{
    if(!region?.epm)return;
    const{branch,dataFolder}=region.epm;
    Promise.all([fetchEpmCSV(branch,dataFolder,'zcmap.csv'),fetchZonesGeoJSON(branch,dataFolder),fetchLinestringGeoJSON(branch,dataFolder),fetchEpmCSV(branch,dataFolder,'pHours.csv')]).then(([zc,zGJ,lGJ,hr])=>{
      setZcmapRows(zc||[]);setZonesGJ(zGJ);setLinestringGJ(lGJ);if(hr)setHoursData(processHours(hr));
    });
  },[region]);

  useEffect(()=>{if(!region?.epm)return;setLoadingRuns(true);const b=region.epm.branch;resolveOutputDir(b).then(dir=>{setOutputDir(dir);return fetchGitHubDir(b,dir);}).then(items=>{const runs=(items||[]).filter(i=>i.type==='dir').map(i=>i.name).sort().reverse();setRunList(runs);if(runs.length)setSimRun(runs[0]);}).finally(()=>setLoadingRuns(false));},[region]);
  useEffect(()=>{if(!region?.epm||!simRun)return;fetchGitHubDir(region.epm.branch,`${outputDir}/${simRun}`).then(items=>{const s=(items||[]).filter(i=>i.type==='dir').map(i=>i.name).sort();setScenarioList(s);if(s.length){const base=s.find(x=>/^base(line)?$/i.test(x))||s[0];setOvScenario(base);setDispScenario(base);setTrScenario(base);setPlScenario(base);setEvScenarios(new Set(s));setCmpRef(base);setCmpScenarios(new Set(s));setTrScenarios(new Set(s));setSnapScenarios(new Set(s));}});},[region,simRun,outputDir]);

  useEffect(()=>{
    if(!region?.epm||!simRun||!scenarioList.length)return;
    setLoadingData(true);const{branch}=region.epm;
    Promise.all(scenarioList.map(async scen=>{
      const[tf,yz,dp,pr,tx,pl,co]=await Promise.all([fetchResultCSV(branch,simRun,scen,'pTechFuelMerged.csv',outputDir),fetchResultCSV(branch,simRun,scen,'pYearlyZoneMerged.csv',outputDir),fetchResultCSV(branch,simRun,scen,'pDispatchComplete.csv',outputDir),fetchResultCSV(branch,simRun,scen,'pHourlyPrice.csv',outputDir),fetchResultCSV(branch,simRun,scen,'pTransmissionMerged.csv',outputDir),fetchResultCSV(branch,simRun,scen,'pPlantMerged.csv',outputDir),fetchResultCSV(branch,simRun,scen,'pCostsMerged.csv',outputDir)]);
      return{scen,techFuel:tf?processTechFuel(tf):{},yearlyZone:yz?processYearlyZone(yz):{},dispatch:dp?processDispatchResults(dp):{},price:pr?processHourlyPrice(pr):{},transmission:tx?processTransmissionResults(tx):{},plants:pl?processPlants(pl):[],costs:co?processCosts(co):{}};
    })).then(res=>{const rd=Object.fromEntries(res.map(r=>[r.scen,r]));setResultsData(rd);const yrs=resultYears(res[0]?.techFuel||{});if(yrs.length)setRefYear(yrs[0]);}).finally(()=>setLoadingData(false));
  },[region,simRun,scenarioList]); // eslint-disable-line

  // Derived
  const zoneToCountry = useMemo(()=>Object.fromEntries(zcmapRows.map(r=>[r.z,r.c])),[zcmapRows]);
  const countryZoneIds = useMemo(()=>zcmapRows.filter(r=>r.c===countryDecoded).map(r=>r.z),[zcmapRows,countryDecoded]);
  const countryIsos = useMemo(()=>zonesGJ?[...new Set(zonesGJ.features.filter(f=>countryZoneIds.includes(f.properties.z)).map(f=>f.properties.ISO_A3))]:[]  ,[zonesGJ,countryZoneIds]);
  const allZones = countryZoneIds;
  const visZones = selZone==='all'?allZones:allZones.filter(z=>z===selZone);
  const hasData = Object.keys(resultsData).length>0;
  const allYears = useMemo(()=>{const f=Object.values(resultsData)[0];return f?resultYears(f.techFuel):[];},[resultsData]);
  const activeInd = useMemo(()=>INDICATORS.find(i=>i.key===evIndicator)||INDICATORS[0],[evIndicator]);
  const allTechfuels = useMemo(()=>{const tfs=new Set();for(const d of Object.values(resultsData))for(const z of allZones)for(const a of Object.values(d.techFuel[z]||{}))for(const y of Object.values(a))for(const tf of Object.keys(y))tfs.add(tf);return[...tfs].filter(t=>t!=='Demand').sort();},[resultsData,allZones]);

  const firstDisp=Object.values(resultsData)[0]?.dispatch||{};
  const dispAvailS=useMemo(()=>{const qs=new Set();for(const z of allZones){for(const yr of Object.values(firstDisp[z]||{}))for(const q of Object.keys(yr))qs.add(q);}return[...qs].sort();},[firstDisp,allZones]);
  const dispAvailD=useMemo(()=>{const ds=new Set();for(const z of allZones)for(const yr of Object.values(firstDisp[z]||{}))for(const q of Object.values(yr))for(const d of Object.keys(q))ds.add(d);return[...ds].sort();},[firstDisp,allZones]);
  const totalDays=useMemo(()=>Object.values(hoursData).reduce((s,dts)=>s+Object.values(dts||{}).reduce((a,b)=>a+b,0),0)||365,[hoursData]);
  const activeDispZone=dispZone||'__all__';
  const getDispDemand=(sd,zone,zones,year,s,d,h)=>{const key=`t${h+1}`;if(zone==='__all__')return zones.reduce((sum,z)=>sum+(sd.dispatch[z]?.[year]?.[s]?.[d]?.[key]?.Demand||0),0);return sd.dispatch[zone]?.[year]?.[s]?.[d]?.[key]?.Demand??null;};
  const getZoneDisp=(sd,zone,year)=>{if(zone!=='__all__')return sd.dispatch[zone]?.[year]||{};const agg={};for(const z of allZones)for(const[q,days]of Object.entries(sd.dispatch[z]?.[year]||{}))for(const[d,hours]of Object.entries(days))for(const[tt,tfs]of Object.entries(hours))for(const[tf,val]of Object.entries(tfs)){if(!agg[q])agg[q]={};if(!agg[q][d])agg[q][d]={};if(!agg[q][d][tt])agg[q][d][tt]={};agg[q][d][tt][tf]=(agg[q][d][tt][tf]||0)+val;}return agg;};

  const zoneAvgPrices=useMemo(()=>{
    const sd=resultsData[ovScenario]||Object.values(resultsData)[0];if(!sd||!refYear)return{};
    const res={};
    for(const z of allZones){const qmap=sd.price[z]?.[refYear]||{};let tw=0,tp=0;for(const[q,days]of Object.entries(qmap))for(const[d,hrs]of Object.entries(days)){const w=hoursData[q]?.[d]||0;for(const p of Object.values(hrs)){tp+=p*w;tw+=w;}}if(tw>0)res[z]=tp/tw;}
    return res;
  },[resultsData,ovScenario,refYear,allZones,hoursData]);
  const zonePriceRange=useMemo(()=>{
    const sd=resultsData[ovScenario]||Object.values(resultsData)[0];if(!sd||!refYear)return{};
    const res={};
    for(const z of allZones){const qmap=sd.price[z]?.[refYear]||{};let pmin=Infinity,pmax=-Infinity;for(const[,days]of Object.entries(qmap))for(const[,hrs]of Object.entries(days))for(const p of Object.values(hrs))if(p>0){if(p<pmin)pmin=p;if(p>pmax)pmax=p;}if(isFinite(pmin))res[z]={min:pmin,max:pmax};}
    return res;
  },[resultsData,ovScenario,refYear,allZones]);
  const priceVals=Object.values(zoneAvgPrices);
  const minP=priceVals.length?Math.min(...priceVals):0,maxP=priceVals.length?Math.max(...priceVals):100,rngP=maxP-minP||1;

  // ── Map ───────────────────────────────────────────────────────────────────────
  useEffect(()=>{
    if(!containerRef.current||!region||!zonesGJ)return;
    const regionCountries=[...new Set(zcmapRows.map(r=>r.c))].sort();
    const colorMap={};regionCountries.forEach((c,i)=>{colorMap[c]=MAP_PALETTE[i%MAP_PALETTE.length];});
    const zoneCentroids={};if(linestringGJ){for(const f of linestringGJ.features){const coords=f.geometry.coordinates,z=f.properties.z,z2=f.properties.z_other||f.properties.z2;if(z&&!zoneCentroids[z])zoneCentroids[z]=coords[0];if(z2&&!zoneCentroids[z2])zoneCentroids[z2]=coords[coords.length-1];}}for(const f of zonesGJ.features){const z=f.properties.z;if(z&&!zoneCentroids[z]){const c=computeCentroid(f.geometry);if(c)zoneCentroids[z]=c;}}
    const cCoords=countryZoneIds.flatMap(z=>zoneCentroids[z]?[zoneCentroids[z]]:[]);
    const lons=cCoords.map(c=>c[0]),lats=cCoords.map(c=>c[1]);
    const bounds=lons.length?[[Math.min(...lons)-1.5,Math.min(...lats)-1.5],[Math.max(...lons)+1.5,Math.max(...lats)+1.5]]:null;
    const map=new maplibregl.Map({container:containerRef.current,style:mapStyle(theme),center:[lons.length?lons.reduce((a,b)=>a+b,0)/lons.length:20,lats.length?lats.reduce((a,b)=>a+b,0)/lats.length:0],zoom:4,minZoom:1,maxZoom:14,attributionControl:false});
    mapRef.current=map;
    const popup=new maplibregl.Popup({closeButton:false,closeOnClick:false,offset:10,className:`popup-${theme}`});
    map.on('load',async()=>{
      const tv=getT(theme);
      if(bounds)map.fitBounds(bounds,{padding:60,duration:0,maxZoom:7});
      const countries=await fetch('/data/countries_10m.geojson').then(r=>r.json());
      countries.features.forEach((f,i)=>{f.id=i;});
      map.addSource('countries',{type:'geojson',data:countries,generateId:false});
      map.addLayer({id:'land',type:'fill',source:'countries',paint:{'fill-color':tv.land,'fill-opacity':1}});
      map.addLayer({id:'borders',type:'line',source:'countries',paint:{'line-color':tv.worldBdr,'line-width':tv.worldBdrW}});
      const isoToC={};for(const f of zonesGJ.features)isoToC[f.properties.ISO_A3]=f.properties.c;
      const uIsos=[...new Set(zonesGJ.features.map(f=>f.properties.ISO_A3))];
      const fillExpr=['match',['get','ISO_A3'],...uIsos.flatMap(iso=>[iso,colorMap[isoToC[iso]]||'#888']),'transparent'];
      map.addSource('zones',{type:'geojson',data:zonesGJ,generateId:true});
      map.addLayer({id:'zone-fill-dim',type:'fill',source:'zones',filter:['!',['in',['get','ISO_A3'],['literal',countryIsos]]],paint:{'fill-color':fillExpr,'fill-opacity':0.08}});
      map.addLayer({id:'zone-fill',type:'fill',source:'zones',filter:['in',['get','ISO_A3'],['literal',countryIsos]],paint:{'fill-color':fillExpr,'fill-opacity':0.32}});
      map.addLayer({id:'zone-hover',type:'fill',source:'zones',filter:['==',['get','z'],''],paint:{'fill-color':fillExpr,'fill-opacity':0.60}});
      map.addLayer({id:'zone-selected',type:'fill',source:'zones',filter:['==',['get','z'],'__none__'],paint:{'fill-color':fillExpr,'fill-opacity':0.45}});
      map.addLayer({id:'zone-selected-border',type:'line',source:'zones',filter:['==',['get','z'],'__none__'],paint:{'line-color':'rgba(255,255,255,0.9)','line-width':2.5}});
      map.addLayer({id:'zone-border',type:'line',source:'zones',filter:['in',['get','ISO_A3'],['literal',countryIsos]],paint:{'line-color':fillExpr,'line-width':1.5,'line-opacity':0.9}});
      // NTC lines source (updated separately)
      const aW=14,aH=12;const aData=new Uint8Array(aW*aH*4).fill(0);
      for(let y=0;y<aH;y++){const h=aH/2;const xMax=Math.round(y<=h?(y/h)*aW*0.85:((aH-y)/h)*aW*0.85);for(let x=0;x<xMax;x++){const i=(y*aW+x)*4;aData[i]=255;aData[i+1]=255;aData[i+2]=255;aData[i+3]=255;}}
      if(!map.hasImage('ntc-arrow-c'))map.addImage('ntc-arrow-c',{width:aW,height:aH,data:aData},{sdf:true});
      map.addSource('ntc-results',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
      map.addLayer({id:'ntc-bg',type:'line',source:'ntc-results',paint:{'line-color':['interpolate',['linear'],['get','util'],0,'#FFD700',0.5,'#FF8C00',1,'#E53935'],'line-width':['interpolate',['linear'],['get','vol'],0,1,500,2.5,5000,5],'line-opacity':0.88}});
      map.addLayer({id:'ntc-arrows',type:'symbol',source:'ntc-results',layout:{'icon-image':'ntc-arrow-c','icon-allow-overlap':false,'symbol-placement':'line','symbol-spacing':55,'icon-rotation-alignment':'map','icon-size':0.9},paint:{'icon-color':['interpolate',['linear'],['get','util'],0,'#FFD700',0.5,'#FF8C00',1,'#E53935']}});
      map.on('mouseenter','ntc-bg',e=>{map.getCanvas().style.cursor='pointer';const p=e.features[0].properties;popup.setLngLat(e.lngLat).setHTML(`<b>${p.z} ↔ ${p.z2}</b><br><span style="opacity:.8;font-size:0.8em">Interchange ${p.yr}: ${fmtBig(parseFloat(p.fwd))} GWh / ${fmtBig(parseFloat(p.rev))} GWh<br>Utilization: ${p.util!=null?(parseFloat(p.util)*100).toFixed(0)+'%':'—'} · Capacity: ${fmtBig(parseFloat(p.cap)||0)} MW</span>`).addTo(map);});
      map.on('mouseleave','ntc-bg',()=>{map.getCanvas().style.cursor='';popup.remove();});
      let hovZ=null;
      map.on('mousemove','zone-fill',e=>{
        map.getCanvas().style.cursor='pointer';const z=e.features[0].properties.z||'';
        if(z!==hovZ){hovZ=z;map.setFilter('zone-hover',['==',['get','z'],z]);}
        const rd=resultsDataRef.current;const yr=refYearRef.current;const sd=rd[ovScenarioRef.current]||Object.values(rd)[0];
        let statsHtml='';
        if(sd&&yr&&z){const cap=Object.values(sd.techFuel[z]?.CapacityTechFuel?.[yr]||{}).reduce((a,b)=>a+b,0)/1000;const dem=(sd.yearlyZone[z]?.DemandEnergyZone?.[yr]||0)/1000;const netImp=(sd.yearlyZone[z]?.NetImport?.[yr]||0)/1000;const hd=hoursDataRef.current;const zP=sd.price[z]?.[yr]||{};let tw=0,tp=0;for(const[q,days]of Object.entries(zP))for(const[d,hrs]of Object.entries(days)){const w=hd[q]?.[d]||0;for(const p of Object.values(hrs)){tp+=p*w;tw+=w;}}const avgP=tw>0?tp/tw:null;statsHtml=`<br><span style="opacity:.8;font-size:0.78em">Installed: ${cap.toFixed(1)} GW · Demand: ${dem.toFixed(0)} TWh<br>Net import: ${netImp>=0?'+':''}${netImp.toFixed(0)} TWh${avgP!=null?` · Price: ${avgP.toFixed(1)} $/MWh`:''}</span>`;}
        popup.setLngLat(e.lngLat).setHTML(`<b>${z}</b>${statsHtml}`).addTo(map);
      });
      map.on('mouseleave','zone-fill',()=>{map.getCanvas().style.cursor='';hovZ=null;map.setFilter('zone-hover',['==',['get','z'],'']),popup.remove();});
      map.on('click','zone-fill',e=>{const z=e.features[0].properties.z||'';if(countryZoneIds.includes(z)){setSelZone(prev=>prev===z?'all':z);}else{navigate(`/region/${regionId}/results/zone/${encodeURIComponent(z)}`);} });
      setMapLoadedCount(c=>c+1);
    });
    return()=>{popup.remove();dotMarkersRef.current.forEach(m=>m.remove());dotMarkersRef.current=[];pieMarkersRef.current.forEach(m=>m.remove());pieMarkersRef.current=[];mapRef.current?.remove();};
  },[region,theme,zonesGJ,zcmapRows,countryZoneIds,countryIsos]); // eslint-disable-line

  // Update selected zone highlight
  useEffect(()=>{
    const map=mapRef.current;if(!map)return;
    const f=selZone==='all'?'__none__':selZone;
    try{map.setFilter('zone-selected',['==',['get','z'],f]);map.setFilter('zone-selected-border',['==',['get','z'],f]);}catch(e){}
  },[selZone,mapLoadedCount]);

  // Update NTC
  useEffect(()=>{
    const map=mapRef.current;if(!map||!map.getSource('ntc-results')||!refYear)return;
    const sd=resultsData[ovScenario]||Object.values(resultsData)[0];if(!sd)return;
    const tx=sd.transmission;const zoneCentroids={};if(linestringGJ){for(const f of linestringGJ.features){const coords=f.geometry.coordinates,z=f.properties.z,z2=f.properties.z_other||f.properties.z2;if(z&&!zoneCentroids[z])zoneCentroids[z]=coords[0];if(z2&&!zoneCentroids[z2])zoneCentroids[z2]=coords[coords.length-1];}}if(zonesGJ)for(const f of zonesGJ.features){const z=f.properties.z;if(z&&!zoneCentroids[z]){const c=computeCentroid(f.geometry);if(c)zoneCentroids[z]=c;}}
    const seen=new Set();const features=[];
    for(const[z,z2map]of Object.entries(tx)){for(const[z2,attrs]of Object.entries(z2map)){const key=[z,z2].sort().join('||');if(seen.has(key))continue;seen.add(key);
      if(!countryZoneIds.includes(z)&&!countryZoneIds.includes(z2))continue;
      const fwd=attrs.Interchange?.[refYear]||0;const rev=tx[z2]?.[z]?.Interchange?.[refYear]||0;const util=Math.min(1,Math.max(0,attrs.InterconUtilization?.[refYear]||tx[z2]?.[z]?.InterconUtilization?.[refYear]||0));const cap=attrs.TransmissionCapacity?.[refYear]||0;const vol=Math.abs(fwd)+Math.abs(rev);if(vol===0&&cap===0)continue;
      const lf=linestringGJ?.features?.find(f=>(f.properties.z===z&&(f.properties.z_other||f.properties.z2)===z2)||(f.properties.z===z2&&(f.properties.z_other||f.properties.z2)===z));
      const lfFwd=!lf||lf.properties.z===z;
      let coords=lf?lf.geometry.coordinates:(zoneCentroids[z]&&zoneCentroids[z2]?[zoneCentroids[z],zoneCentroids[z2]]:null);if(!coords)continue;
      features.push({type:'Feature',properties:{z,z2,fwd,rev,util,vol,cap,yr:refYear},geometry:{type:'LineString',coordinates:(lfFwd===(fwd>=rev))?coords:[...coords].reverse()}});
    }}
    map.getSource('ntc-results').setData({type:'FeatureCollection',features});
  },[resultsData,refYear,ovScenario,zonesGJ,linestringGJ,countryZoneIds,mapLoadedCount]); // eslint-disable-line

  // Price dots
  useEffect(()=>{
    const map=mapRef.current;if(!map||!refYear||!zonesGJ)return;
    dotMarkersRef.current.forEach(m=>m.remove());dotMarkersRef.current=[];
    const sd=resultsData[ovScenario]||Object.values(resultsData)[0];if(!sd)return;
    const tv=getT(theme);const zoneCentroids={};if(linestringGJ){for(const f of linestringGJ.features){const coords=f.geometry.coordinates,z=f.properties.z,z2=f.properties.z_other||f.properties.z2;if(z&&!zoneCentroids[z])zoneCentroids[z]=coords[0];if(z2&&!zoneCentroids[z2])zoneCentroids[z2]=coords[coords.length-1];}}for(const f of zonesGJ.features){const z=f.properties.z;if(z&&!zoneCentroids[z]){const c=computeCentroid(f.geometry);if(c)zoneCentroids[z]=c;}}
    const prices={};for(const z of allZones){const qmap=sd.price[z]?.[refYear]||{};let tw=0,tp=0;for(const[q,days]of Object.entries(qmap))for(const[d,hrs]of Object.entries(days)){const w=hoursData[q]?.[d]||0;for(const p of Object.values(hrs)){tp+=p*w;tw+=w;}}if(tw>0)prices[z]=tp/tw;}
    const vals=Object.values(prices);if(!vals.length)return;
    const minV=Math.min(...vals),maxV=Math.max(...vals),rng=maxV-minV||1;
    for(const[z,price]of Object.entries(prices)){const coord=zoneCentroids[z];if(!coord)continue;const el=document.createElement('div');el.style.cssText=`width:10px;height:10px;border-radius:50%;background:${priceColor((price-minV)/rng)};border:1.5px solid rgba(255,255,255,0.7);box-shadow:0 1px 4px rgba(0,0,0,0.4);cursor:pointer;`;el.title=`${z}: ${price.toFixed(1)} $/MWh`;dotMarkersRef.current.push(new maplibregl.Marker({element:el,anchor:'center'}).setLngLat(coord).addTo(map));}
  },[resultsData,refYear,ovScenario,zonesGJ,allZones,hoursData,theme,mapLoadedCount]); // eslint-disable-line

  // ── Zone mix pie markers ──────────────────────────────────────────────────
  useEffect(()=>{
    pieMarkersRef.current.forEach(m=>m.remove());pieMarkersRef.current=[];
    const map=mapRef.current;
    if(!map||pieDispMode==='none'||!zonesGJ||!refYear)return;
    const sd=resultsData[ovScenario]||Object.values(resultsData)[0];if(!sd)return;
    const attr=pieDispMode==='capacity'?'CapacityTechFuel':'EnergyTechFuelComplete';
    const unitDiv=1000;const unitLbl=pieDispMode==='capacity'?'GW':'TWh';
    const isDk=t.isDark;
    const zcC={};if(linestringGJ){for(const f of linestringGJ.features){const coords=f.geometry.coordinates,z=f.properties.z,z2=f.properties.z_other||f.properties.z2;if(z&&!zcC[z])zcC[z]=coords[0];if(z2&&!zcC[z2])zcC[z2]=coords[coords.length-1];}}for(const f of zonesGJ.features){const z=f.properties.z;if(z&&!zcC[z]){const c=computeCentroid(f.geometry);if(c)zcC[z]=c;}}
    const zPrices={};for(const z of allZones){const qmap=sd.price[z]?.[refYear]||{};let tw=0,tp=0;for(const[q,days]of Object.entries(qmap))for(const[d,hrs]of Object.entries(days)){const w=hoursData[q]?.[d]||0;for(const p of Object.values(hrs)){tp+=p*w;tw+=w;}}if(tw>0)zPrices[z]=tp/tw;}
    const pVals=Object.values(zPrices);const pMin=pVals.length?Math.min(...pVals):0;const pRng=pVals.length?Math.max(...pVals)-pMin||1:1;
    const SZ=44,dpr=window.devicePixelRatio||1,cx=SZ/2,cy=SZ/2,oR=SZ/2-1.5,iR=oR*0.50;
    for(const z of allZones){
      const coord=zcC[z];if(!coord)continue;
      const data=sd.techFuel[z]?.[attr]?.[refYear];if(!data)continue;
      const entries=Object.entries(data).filter(([,v])=>v>0);if(!entries.length)continue;
      const total=entries.reduce((s,[,v])=>s+v,0);if(total<=0)continue;
      const canvas=document.createElement('canvas');
      canvas.width=Math.round(SZ*dpr);canvas.height=Math.round(SZ*dpr);
      canvas.style.width=SZ+'px';canvas.style.height=SZ+'px';
      const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);
      ctx.shadowColor='rgba(0,0,0,0.35)';ctx.shadowBlur=3;ctx.shadowOffsetY=1;
      let ang=-Math.PI/2;
      for(const[tf,val]of entries){const sw=(val/total)*2*Math.PI;ctx.beginPath();ctx.moveTo(cx+iR*Math.cos(ang),cy+iR*Math.sin(ang));ctx.arc(cx,cy,oR,ang,ang+sw);ctx.arc(cx,cy,iR,ang+sw,ang,true);ctx.closePath();ctx.fillStyle=techColor(tf);ctx.fill();ang+=sw;}
      ctx.shadowColor='transparent';
      const t_=zPrices[z]!=null?(zPrices[z]-pMin)/pRng:null;
      const centerBg=t_!=null?priceColor(t_).replace('rgb(','rgba(').replace(')',',0.92)'):(isDk?'rgba(15,20,30,0.88)':'rgba(245,248,252,0.92)');
      const lightBg=t_==null||t_<0.5;
      const textC=lightBg?'rgba(15,30,60,0.9)':'rgba(255,255,255,0.95)';
      const mutedC=lightBg?'rgba(60,80,120,0.65)':'rgba(255,255,255,0.55)';
      ctx.beginPath();ctx.arc(cx,cy,iR-0.5,0,2*Math.PI);ctx.fillStyle=centerBg;ctx.fill();
      const val=total/unitDiv;const valStr=val>=10?val.toFixed(0):val.toFixed(1);
      ctx.fillStyle=textC;ctx.font='bold 8px system-ui,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
      ctx.fillText(valStr,cx,cy-2.5);ctx.fillStyle=mutedC;ctx.font='6px system-ui,sans-serif';ctx.fillText(unitLbl,cx,cy+6);
      canvas.title=`${z}: ${(total/unitDiv).toFixed(1)} ${unitLbl}`;
      pieMarkersRef.current.push(new maplibregl.Marker({element:canvas,anchor:'center'}).setLngLat(coord).addTo(map));
    }
  },[pieDispMode,resultsData,ovScenario,refYear,zonesGJ,allZones,hoursData,mapLoadedCount,theme]); // eslint-disable-line

  if(!region)return<div style={{padding:40,color:t.text}}>Loading…</div>;
  const selectStyle={fontSize:'0.5rem',fontFamily:'inherit',padding:'2px 6px',borderRadius:3,border:`1px solid ${t.panelBorder}`,backgroundColor:t.panel,color:t.muted,cursor:'pointer'};
  const TABS=['overview','snapshot','evolution','dispatch','trade','plants'];

  // ── Helpers ───────────────────────────────────────────────────────────────────
  const findBase=scens=>scens.find(s=>/^base(line)?$/i.test(s))||scens[0];
  const baseFirst=arr=>[...arr].sort((a,b)=>(/^base(line)?$/i.test(a)?-1:/^base(line)?$/i.test(b)?1:0));

  // ── Builders ──────────────────────────────────────────────────────────────────
  const buildSnapshot=()=>{
    const activeSc=baseFirst(scenarioList.filter(s=>snapScenarios.has(s)&&resultsData[s]));
    if(!activeSc.length||!refYear)return null;
    const ind=INDICATORS.find(i=>i.key===snapIndicator)||INDICATORS[0];
    const groups=visZones; const multi=activeSc.length>1;
    const getTf=(scen,z,tf)=>resultsData[scen]?.techFuel[z]?.[ind.key]?.[refYear]?.[tf]||0;
    const getTotal=(scen,z)=>{if(ind.source==='techFuel')return Object.values(resultsData[scen]?.techFuel[z]?.[ind.key]?.[refYear]||{}).reduce((a,b)=>a+b,0);if(ind.source==='yearlyZone')return resultsData[scen]?.yearlyZone[z]?.[ind.key]?.[refYear]||0;if(ind.source==='costs')return MAIN_COST_CATS.reduce((s,cat)=>s+(resultsData[scen]?.costs[z]?.[cat]?.[refYear]||0),0);return 0;};
    if(ind.source==='techFuel'){const tfs=allTechfuels.filter(tf=>activeSc.some(s=>groups.some(z=>getTf(s,z,tf)>0)));const datasets=[];for(const scen of activeSc)for(const tf of tfs){const data=groups.map(z=>Math.round(getTf(scen,z,tf)));if(data.some(v=>v>0))datasets.push({label:multi?`${scen} — ${tf}`:tf,data,backgroundColor:hexA(techColor(tf),multi?0.5:0.82),borderColor:techColor(tf),borderWidth:multi?1:0,stack:scen});}return{labels:groups,datasets,ind};}
    if(ind.source==='trade'){const datasets=[];const netPluginData=[];for(let i=0;i<activeSc.length;i++){const scen=activeSc[i];const col=SCEN_COLORS[i%SCEN_COLORS.length];const tv=getTradeValsC(resultsData,scen,allZones,refYear);datasets.push({label:`${multi?scen+' — ':''}Imp.`,type:'bar',data:groups.map(z=>+(tv[z]?.imp||0).toFixed(0)),backgroundColor:hexA(col,0.75),borderWidth:0,stack:scen,_si:i});datasets.push({label:`${multi?scen+' — ':''}Exp.`,type:'bar',data:groups.map(z=>+(-tv[z]?.exp||0).toFixed(0)),backgroundColor:hexA(col,0.40),borderWidth:0,stack:scen});netPluginData.push({si:i,data:groups.map(z=>+(tv[z]?.net||0).toFixed(0)),color:col});}return{labels:groups,datasets,ind,netPlugin:buildNetDotPlugin(netPluginData)};}
    return{labels:groups,datasets:activeSc.map((scen,i)=>({label:scen,data:groups.map(z=>+getTotal(scen,z).toFixed(2)),backgroundColor:hexA(SCEN_COLORS[i%SCEN_COLORS.length],0.78),borderWidth:0,stack:scen})).filter(d=>d.data.some(v=>v>0)),ind};
  };
  const buildSnapshotDelta=()=>{
    if(!cmpRef||!refYear)return null;
    const compareScs=baseFirst(scenarioList.filter(s=>cmpScenarios.has(s)&&s!==cmpRef&&resultsData[s]));
    if(!compareScs.length)return null;
    const ind=INDICATORS.find(i=>i.key===snapIndicator)||INDICATORS[0];
    const groups=visZones; const multi=compareScs.length>1;
    const getTf=(scen,z,tf)=>resultsData[scen]?.techFuel[z]?.[ind.key]?.[refYear]?.[tf]||0;
    const getTotal=(scen,z)=>{if(ind.source==='techFuel')return Object.values(resultsData[scen]?.techFuel[z]?.[ind.key]?.[refYear]||{}).reduce((a,b)=>a+b,0);if(ind.source==='yearlyZone')return resultsData[scen]?.yearlyZone[z]?.[ind.key]?.[refYear]||0;if(ind.source==='costs')return MAIN_COST_CATS.reduce((s,cat)=>s+(resultsData[scen]?.costs[z]?.[cat]?.[refYear]||0),0);return 0;};
    if(ind.source==='techFuel'){const tfs=allTechfuels.filter(tf=>[...compareScs,cmpRef].some(s=>groups.some(z=>getTf(s,z,tf)>0)));const datasets=[];for(const scen of compareScs)for(const tf of tfs){const data=groups.map(z=>+(getTf(scen,z,tf)-getTf(cmpRef,z,tf)).toFixed(0));if(data.some(v=>v!==0))datasets.push({label:multi?`${scen} — ${tf}`:tf,data,backgroundColor:hexA(techColor(tf),multi?0.5:0.82),borderColor:techColor(tf),borderWidth:multi?1:0,stack:scen});}return{labels:groups,datasets,ind};}
    if(ind.source==='trade'){const datasets=[];const netPluginData=[];for(let i=0;i<compareScs.length;i++){const scen=compareScs[i];const col=SCEN_COLORS[(i+1)%SCEN_COLORS.length];const tvS=getTradeValsC(resultsData,scen,allZones,refYear);const tvR=getTradeValsC(resultsData,cmpRef,allZones,refYear);const getD=(z,k)=>(tvS[z]?.[k]||0)-(tvR[z]?.[k]||0);const dImp=groups.map(z=>+getD(z,'imp').toFixed(0));const dExp=groups.map(z=>+getD(z,'exp').toFixed(0));const dNet=groups.map(z=>+getD(z,'net').toFixed(0));if(dImp.some(v=>v!==0))datasets.push({label:multi?`Δ ${scen} Imp.`:'Δ Imp.',type:'bar',data:dImp,backgroundColor:hexA(col,0.75),borderWidth:0,stack:scen,_si:i});if(dExp.some(v=>v!==0))datasets.push({label:multi?`Δ ${scen} Exp.`:'Δ Exp.',type:'bar',data:dExp.map(v=>-v),backgroundColor:hexA(col,0.40),borderWidth:0,stack:scen});if(dNet.some(v=>v!==0))netPluginData.push({si:i,data:dNet,color:col});}return{labels:groups,datasets,ind,netPlugin:buildNetDotPlugin(netPluginData)};}
    const DCOLS=['#3887C4','#4A9E6A','#D4A820','#B83838'];
    return{labels:groups,datasets:compareScs.map((scen,i)=>({label:`Δ ${scen}`,data:groups.map(z=>+((getTotal(scen,z)-getTotal(cmpRef,z)).toFixed(2))),backgroundColor:hexA(DCOLS[i%4],0.72),borderColor:DCOLS[i%4],borderWidth:0,stack:scen})).filter(d=>d.data.some(v=>v!==0)),ind};
  };
  const buildCmpEvolution=()=>{
    if(!cmpRef||!refYear)return null;
    const compareScs=baseFirst(scenarioList.filter(s=>cmpScenarios.has(s)&&s!==cmpRef&&resultsData[s]));
    if(!compareScs.length)return null;
    const ind=activeInd; const multi=compareScs.length>1;
    if(ind.source==='techFuel'){const tfs=allTechfuels;const datasets=[];for(const scen of compareScs)for(const tf of tfs){const data=allYears.map(y=>Math.round(visZones.reduce((s,z)=>s+(resultsData[scen]?.techFuel[z]?.[ind.key]?.[y]?.[tf]||0),0)-(visZones.reduce((s,z)=>s+(resultsData[cmpRef]?.techFuel[z]?.[ind.key]?.[y]?.[tf]||0),0))));if(data.some(v=>v!==0))datasets.push({label:multi?`${scen} — ${tf}`:tf,data,backgroundColor:hexA(techColor(tf),multi?0.5:0.82),borderColor:techColor(tf),borderWidth:multi?1:0,stack:scen});}return{labels:allYears,datasets};}
    if(ind.source==='yearlyZone'){return{labels:allYears,datasets:compareScs.map((scen,i)=>({label:scen,data:allYears.map(y=>+(visZones.reduce((s,z)=>s+(resultsData[scen]?.yearlyZone[z]?.[ind.key]?.[y]||0)-(resultsData[cmpRef]?.yearlyZone[z]?.[ind.key]?.[y]||0),0)).toFixed(2)),backgroundColor:hexA(SCEN_COLORS[(i+1)%SCEN_COLORS.length],0.75),borderColor:SCEN_COLORS[(i+1)%SCEN_COLORS.length],borderWidth:1,fill:false,tension:0.3,type:'line'})).filter(d=>d.data.some(v=>v!==0))};}
    if(ind.source==='costs'){const datasets=[];for(const scen of compareScs)for(const cat of MAIN_COST_CATS){const data=allYears.map(y=>Math.round((visZones.reduce((s,z)=>s+(resultsData[scen]?.costs[z]?.[cat]?.[y]||0),0)-visZones.reduce((s,z)=>s+(resultsData[cmpRef]?.costs[z]?.[cat]?.[y]||0),0))*10)/10);if(data.some(v=>v!==0))datasets.push({label:multi?`${scen} — ${COST_LABELS[cat]||cat}`:(COST_LABELS[cat]||cat),data,backgroundColor:hexA(costColor(cat),multi?0.5:0.82),borderColor:costColor(cat),borderWidth:multi?1:0,stack:scen});}return{labels:allYears,datasets};}
    if(ind.source==='trade'){const datasets=[];for(let i=0;i<compareScs.length;i++){const scen=compareScs[i];const col=SCEN_COLORS[(i+1)%SCEN_COLORS.length];const tvS=y=>getTradeValsC(resultsData,scen,visZones,y);const tvR=y=>getTradeValsC(resultsData,cmpRef,visZones,y);const dImp=allYears.map(y=>+(Object.values(tvS(y)).reduce((s,v)=>s+v.imp,0)-Object.values(tvR(y)).reduce((s,v)=>s+v.imp,0)).toFixed(0));const dExp=allYears.map(y=>+(Object.values(tvS(y)).reduce((s,v)=>s+v.exp,0)-Object.values(tvR(y)).reduce((s,v)=>s+v.exp,0)).toFixed(0));const dNet=allYears.map(y=>+(Object.values(tvS(y)).reduce((s,v)=>s+v.net,0)-Object.values(tvR(y)).reduce((s,v)=>s+v.net,0)).toFixed(0));if(dImp.some(v=>v!==0))datasets.push({label:multi?`Δ ${scen} Imp.`:'Δ Imp.',type:'bar',data:dImp,backgroundColor:hexA(col,0.75),borderWidth:0,stack:scen});if(dExp.some(v=>v!==0))datasets.push({label:multi?`Δ ${scen} Exp.`:'Δ Exp.',type:'bar',data:dExp.map(v=>-v),backgroundColor:hexA(col,0.40),borderWidth:0,stack:scen});if(dNet.some(v=>v!==0))datasets.push({label:multi?`Δ ${scen} Net`:'Δ Net',type:'line',data:dNet,borderColor:col,borderWidth:1.5,pointRadius:0,tension:0.3,fill:false});}return{labels:allYears,datasets};}
    return null;
  };
  const buildDispatchDelta=()=>{
    if(!cmpRef||cmpRef===dispScenario||!refYear||!activeDispZone||!resultsData[cmpRef])return{chartData:{labels:[],datasets:[]},plugin:null};
    const sdA=resultsData[dispScenario],sdB=resultsData[cmpRef];if(!sdA||!sdB)return{chartData:{labels:[],datasets:[]},plugin:null};
    const zA=getZoneDisp(sdA,activeDispZone,refYear),zB=getZoneDisp(sdB,activeDispZone,refYear);
    const seasons=dispAvailS,days=dispAvailD;const mcColor=t.isDark?'rgba(255,255,255,0.88)':'#1E3A8A';
    const addMC=(ds,labels,prA,prB)=>{const d=labels.map((_,i)=>{const a=prA[i],b=prB[i];return(a!=null&&b!=null)?+(a-b).toFixed(2):null;});if(d.some(v=>v!=null))ds.push({label:'Marginal cost',type:'line',data:d,yAxisID:'yR',borderColor:mcColor,borderWidth:1,pointRadius:0,tension:0,fill:false,spanGaps:true,order:1});return ds;};
    const mkDs=(tfs,getA,getB,nPts,labels,prA,prB)=>{const ds=tfs.map(tf=>({label:tf,fill:true,data:Array.from({length:nPts},(_,i)=>+(getA(i,tf)-getB(i,tf)).toFixed(1)),backgroundColor:hexA(techColor(tf),0.7),borderColor:techColor(tf),borderWidth:0,pointRadius:0,tension:0,stack:'gen'})).filter(d=>d.data.some(v=>v!==0));return{chartData:{labels,datasets:addMC(ds,labels,prA||[],prB||[])},plugin:null};};
    const zk=activeDispZone==='__all__'?allZones[0]:activeDispZone;
    if(dispMode==='full'&&seasons.length&&days.length){const nPts=seasons.length*days.length*24;const tfs=[...new Set([zA,zB].flatMap(z=>seasons.flatMap(s=>days.flatMap(d=>Object.values(z[s]?.[d]||{}).flatMap(Object.keys)))))].filter(t=>t!=='Demand').sort();const pts=seasons.flatMap(s=>days.flatMap(d=>Array.from({length:24},(_,h)=>[s,d,h])));const prA=pts.map(([s,d,h])=>sdA.price[zk]?.[refYear]?.[s]?.[d]?.[`t${h+1}`]??null);const prB=pts.map(([s,d,h])=>sdB.price[zk]?.[refYear]?.[s]?.[d]?.[`t${h+1}`]??null);return mkDs(tfs,(i,tf)=>zA[pts[i][0]]?.[pts[i][1]]?.[`t${pts[i][2]+1}`]?.[tf]||0,(i,tf)=>zB[pts[i][0]]?.[pts[i][1]]?.[`t${pts[i][2]+1}`]?.[tf]||0,nPts,new Array(nPts).fill(''),prA,prB);}
    const spA=zA[dispSeason],spB=zB[dispSeason];if(!spA&&!spB)return{chartData:{labels:[],datasets:[]},plugin:null};
    const tfs=[...new Set([spA,spB].flatMap(sp=>Object.values(sp||{}).flatMap(d=>Object.values(d).flatMap(Object.keys))))].filter(t=>t!=='Demand').sort();
    const gv=(sp,h,tf)=>dispDay==='avg'?Object.keys(sp||{}).reduce((s,d)=>s+(sp[d]?.[`t${h+1}`]?.[tf]||0),0)/Math.max(Object.keys(sp||{}).length,1):(sp?.[dispDay]?.[`t${h+1}`]?.[tf]||0);
    const prA_=sdA.price[zk]?.[refYear]?.[dispSeason]||{};const prB_=sdB.price[zk]?.[refYear]?.[dispSeason]||{};
    const pA=Array.from({length:24},(_,h)=>dispDay==='avg'?Object.keys(prA_).reduce((s,d)=>s+(prA_[d]?.[`t${h+1}`]??0),0)/Math.max(Object.keys(prA_).length,1):(prA_[dispDay]?.[`t${h+1}`]??null));
    const pB=Array.from({length:24},(_,h)=>dispDay==='avg'?Object.keys(prB_).reduce((s,d)=>s+(prB_[d]?.[`t${h+1}`]??0),0)/Math.max(Object.keys(prB_).length,1):(prB_[dispDay]?.[`t${h+1}`]??null));
    return mkDs(tfs,(i,tf)=>gv(spA,i,tf),(i,tf)=>gv(spB,i,tf),24,Array.from({length:24},(_,i)=>`${i+1}h`),pA,pB);
  };
  const buildTradeCmpDelta=()=>{
    if(!cmpRef||!allYears.length)return null;
    const compareScs=baseFirst(scenarioList.filter(s=>cmpScenarios.has(s)&&s!==cmpRef&&resultsData[s]));
    if(!compareScs.length)return null;
    const attr=trEvMetric==='capacity'?'TransmissionCapacity':trEvMetric==='utilization'?'InterconUtilization':'Interchange';
    const unit=trEvMetric==='volume'?'GWh':trEvMetric==='capacity'?'MW':'%';
    const tx0=resultsData[baseFirst([...trScenarios].filter(s=>resultsData[s]))[0]||cmpRef]?.transmission||{};
    const seen=new Set();const allCorridors=[];
    for(const[z,zm]of Object.entries(tx0))for(const z2 of Object.keys(zm)){if(!allZones.includes(z)&&!allZones.includes(z2))continue;const k=[z,z2].sort().join('||');if(!seen.has(k)){seen.add(k);allCorridors.push({z,z2,key:k});}}
    const corridors=allCorridors.slice(0,10).filter(c=>!isHidden('trev-c',`${c.z}↔${c.z2}`));
    if(!corridors.length)return null;
    const getVal=(scen,c,y)=>{const tx=resultsData[scen]?.transmission||{};if(trEvMetric==='utilization')return(((tx[c.z]?.[c.z2]?.[attr]?.[y]||0)+(tx[c.z2]?.[c.z]?.[attr]?.[y]||0))/2)*100;return Math.abs(tx[c.z]?.[c.z2]?.[attr]?.[y]||0)+Math.abs(tx[c.z2]?.[c.z]?.[attr]?.[y]||0);};
    const isUtil=trEvMetric==='utilization';
    return{labels:allYears,unit,datasets:compareScs.flatMap((scen,si)=>corridors.map((c)=>{const ci2=allCorridors.findIndex(a=>a.key===c.key);const col=MAP_PALETTE[ci2%MAP_PALETTE.length];const data=allYears.map(y=>+(getVal(scen,c,y)-getVal(cmpRef,c,y)).toFixed(isUtil?1:0));if(isUtil)return{label:`${compareScs.length>1?scen+' — ':''}${c.z}↔${c.z2}`,data,type:'line',borderColor:col,backgroundColor:hexA(col,0.1),borderWidth:2,fill:false,tension:0.3,pointRadius:0};return{label:`${compareScs.length>1?scen+' — ':''}${c.z}↔${c.z2}`,data,backgroundColor:hexA(col,0.72),borderColor:col,borderWidth:0,stack:scen};})).filter(d=>d.data.some(v=>v!==0))};
  };

  const buildMix=()=>{const sd=resultsData[ovScenario];if(!sd||!refYear)return null;const zones=visZones.filter(z=>sd.techFuel[z]?.CapacityTechFuel?.[refYear]);if(!zones.length)return null;const tfs=allTechfuels.filter(tf=>zones.some(z=>(sd.techFuel[z]?.CapacityTechFuel?.[refYear]?.[tf]||0)>0));return{labels:zones,datasets:tfs.filter(tf=>!isHidden('mix-c',tf)).map(tf=>({label:tf,data:zones.map(z=>Math.round(sd.techFuel[z]?.CapacityTechFuel?.[refYear]?.[tf]||0)),backgroundColor:techColor(tf),borderWidth:0,barThickness:14,stack:'a'}))};};

  const buildEvolution=()=>{
    const activeSc=scenarioList.filter(s=>evScenarios.has(s));if(!activeSc.length||!allYears.length)return null;
    const ind=activeInd;
    if(ind.source==='yearlyZone')return{labels:allYears,datasets:activeSc.map((s,i)=>({label:s,data:allYears.map(y=>+visZones.reduce((acc,z)=>acc+(resultsData[s]?.yearlyZone[z]?.[ind.key]?.[y]||0),0).toFixed(2)),backgroundColor:hexA(SCEN_COLORS[i%SCEN_COLORS.length],0.75),borderColor:SCEN_COLORS[i%SCEN_COLORS.length],borderWidth:2,fill:false,tension:0.3,type:'line'}))};
    if(ind.source==='costs'){const cats=MAIN_COST_CATS.filter(cat=>activeSc.some(s=>visZones.some(z=>resultsData[s]?.costs[z]?.[cat])));const datasets=[];for(const scen of activeSc)for(const cat of cats){const data=allYears.map(y=>Math.round(visZones.reduce((s,z)=>s+(resultsData[scen]?.costs[z]?.[cat]?.[y]||0),0)*10)/10);if(data.some(v=>v!==0))datasets.push({label:`${activeSc.length>1?scen+' — ':''}${COST_LABELS[cat]||cat}`,data,backgroundColor:hexA(costColor(cat),activeSc.length>1?0.5:0.82),borderColor:costColor(cat),borderWidth:activeSc.length>1?1:0,stack:scen});}return{labels:allYears,datasets};}
    if(ind.source==='trade'){const multi=activeSc.length>1;const datasets=[];for(let i=0;i<activeSc.length;i++){const scen=activeSc[i];const col=SCEN_COLORS[i%SCEN_COLORS.length];datasets.push({label:multi?`${scen} — Imp.`:'Imp.',type:'bar',data:allYears.map(y=>+(Object.values(getTradeValsC(resultsData,scen,visZones,y)).reduce((s,v)=>s+v.imp,0)).toFixed(0)),backgroundColor:hexA(col,0.75),borderWidth:0,stack:scen});datasets.push({label:multi?`${scen} — Exp.`:'Exp.',type:'bar',data:allYears.map(y=>+(-(Object.values(getTradeValsC(resultsData,scen,visZones,y)).reduce((s,v)=>s+v.exp,0))).toFixed(0)),backgroundColor:hexA(col,0.40),borderWidth:0,stack:scen});datasets.push({label:multi?`${scen} — Net`:'Net',type:'line',data:allYears.map(y=>+(Object.values(getTradeValsC(resultsData,scen,visZones,y)).reduce((s,v)=>s+v.net,0)).toFixed(0)),borderColor:col,borderWidth:1.5,pointRadius:0,tension:0.3,fill:false});}return{labels:allYears,datasets};}
    const tfs=allTechfuels.filter(tf=>!isHidden('ev-c',tf));const datasets=[];for(const scen of activeSc)for(const tf of tfs){datasets.push({label:`${scen} — ${tf}`,data:allYears.map(y=>Math.round(visZones.reduce((s,z)=>s+(resultsData[scen]?.techFuel[z]?.[ind.key]?.[y]?.[tf]||0),0))),backgroundColor:hexA(techColor(tf),activeSc.length>1?0.5:0.85),borderColor:techColor(tf),borderWidth:activeSc.length>1?1:0,stack:scen});}return{labels:allYears,datasets};
  };

  const buildDispatch=()=>{const sd=resultsData[dispScenario];if(!sd||!activeDispZone||!refYear)return{chartData:{labels:[],datasets:[]},plugin:null};const zDisp=getZoneDisp(sd,activeDispZone,refYear);const isDark=t.isDark;const mcColor=isDark?'rgba(255,255,255,0.88)':'#1E3A8A';const seasons=dispAvailS,days=dispAvailD;if(dispMode==='full'&&seasons.length&&days.length){const nS=seasons.length,nDT=days.length,nPts=nS*nDT*24;const tfs=[...new Set(seasons.flatMap(q=>days.flatMap(d=>Object.values(zDisp[q]?.[d]||{}).flatMap(Object.keys))))].filter(t=>t!=='Demand').sort();const datasets=tfs.map(tf=>({label:tf,fill:true,data:seasons.flatMap(s=>days.flatMap(d=>Array.from({length:24},(_,h)=>zDisp[s]?.[d]?.[`t${h+1}`]?.[tf]||0))),backgroundColor:hexA(techColor(tf),0.7),borderColor:techColor(tf),borderWidth:0,pointRadius:0,tension:0,stack:'gen'}));const zP=sd.price[activeDispZone]?.[refYear]||{};const pd=seasons.flatMap(s=>days.flatMap(d=>Array.from({length:24},(_,h)=>zP[s]?.[d]?.[`t${h+1}`]||null)));if(pd.some(v=>v!=null))datasets.push({label:'Marginal cost',type:'line',data:pd,yAxisID:'yR',borderColor:mcColor,borderWidth:1,pointRadius:0,tension:0,fill:false,spanGaps:true,order:1});const dem=seasons.flatMap(s=>days.flatMap(d=>Array.from({length:24},(_,h)=>{const v=getDispDemand(sd,activeDispZone,allZones,refYear,s,d,h);return v!=null&&v>0?v:null;})));if(dem.some(v=>v!=null))datasets.push({label:'Demand',type:'line',data:dem,borderColor:'#8B0000',borderWidth:1,pointRadius:0,tension:0,fill:false,spanGaps:true,stack:'demand',order:1});const sepPlugin={id:'cSep',afterDatasetsDraw:(chart)=>{const{ctx,chartArea:ca,scales:sc}=chart;if(!ca)return;const dL=(data,yK,col,lw=1.5)=>{if(!data.some(v=>v!=null)||!sc[yK])return;ctx.save();ctx.beginPath();ctx.strokeStyle=col;ctx.lineWidth=lw;ctx.setLineDash([]);let mv=false;data.forEach((v,i)=>{if(v==null){mv=false;return;}const x=sc.x.getPixelForValue(i);const y=sc[yK].getPixelForValue(v);mv?ctx.lineTo(x,y):ctx.moveTo(x,y);mv=true;});ctx.stroke();ctx.restore();};dL(dem,'y','#CC0000');dL(pd,'yR',mcColor,1);},afterDraw:(chart)=>{const{ctx,chartArea,scales}=chart;if(!chartArea||!scales.x)return;const{top,bottom}=chartArea;const xS=scales.x;const dC=isDark?'rgba(255,255,255,0.13)':'rgba(0,0,0,0.12)';const sC=isDark?'rgba(255,255,255,0.36)':'rgba(0,0,0,0.30)';const tC=isDark?'rgba(255,255,255,0.46)':'rgba(0,0,0,0.40)';const seC=isDark?'rgba(255,255,255,0.70)':'rgba(0,0,0,0.58)';for(let si=0;si<nS;si++){const ss=si*nDT*24;ctx.save();ctx.font='700 9px system-ui,sans-serif';ctx.fillStyle=seC;ctx.textAlign='center';ctx.textBaseline='bottom';ctx.fillText(seasons[si],xS.getPixelForValue(ss+nDT*12),top-2);ctx.restore();for(let di=0;di<nDT;di++){const dts=ss+di*24;if(dts>0){const lx=xS.getPixelForValue(dts);const isS=di===0;ctx.save();ctx.strokeStyle=isS?sC:dC;ctx.lineWidth=isS?1.2:0.7;if(!isS)ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(lx,top);ctx.lineTo(lx,bottom);ctx.stroke();ctx.restore();}const midX=xS.getPixelForValue(dts+12);const w=hoursData?.[seasons[si]]?.[days[di]]||0;const pct=w>0?` (${((w/totalDays)*100).toFixed(0)}%)`:'';ctx.save();ctx.translate(midX,bottom+3);ctx.rotate(-Math.PI/2);ctx.font='7px system-ui,sans-serif';ctx.fillStyle=tC;ctx.textAlign='right';ctx.textBaseline='middle';ctx.fillText(`${days[di]}${pct}`,0,0);ctx.restore();}}}};return{chartData:{labels:new Array(nPts).fill(''),datasets},plugin:sepPlugin};}
  const sp=zDisp[dispSeason];if(!sp)return{chartData:{labels:[],datasets:[]},plugin:null};const tfs2=[...new Set(Object.values(sp).flatMap(d=>Object.values(d).flatMap(Object.keys)))].filter(t=>t!=='Demand').sort();const getData=(tf)=>{if(dispDay==='avg'){const ds=Object.keys(sp);return Array.from({length:24},(_,h)=>ds.reduce((s,d)=>s+(sp[d]?.[`t${h+1}`]?.[tf]||0),0)/Math.max(ds.length,1));}return Array.from({length:24},(_,h)=>sp[dispDay]?.[`t${h+1}`]?.[tf]||0);};const datasets2=tfs2.map(tf=>({label:tf,fill:true,data:getData(tf),backgroundColor:hexA(techColor(tf),0.7),borderColor:techColor(tf),borderWidth:0,pointRadius:0,tension:0,stack:'gen'}));const demL=dispAvailD.length>0?Array.from({length:24},(_,h)=>{const ds=dispDay==='avg'?dispAvailD:[dispDay];const vals=ds.map(d=>getDispDemand(sd,activeDispZone,allZones,refYear,dispSeason,d,h)).filter(v=>v!=null&&v>0);if(!vals.length)return null;return dispDay==='avg'?vals.reduce((a,b)=>a+b,0)/vals.length:vals[0];}):[];if(demL.some(v=>v))datasets2.push({label:'Demand',type:'line',data:demL,borderColor:'#8B0000',borderWidth:1,pointRadius:0,tension:0,fill:false,spanGaps:true,stack:'demand',order:1});const prL=Array.from({length:24},(_,h)=>{const d=dispDay==='avg'?Object.keys(sp)[0]:dispDay;return sd.price[activeDispZone]?.[refYear]?.[dispSeason]?.[d]?.[`t${h+1}`]||null;});if(prL.some(v=>v!=null))datasets2.push({label:'Marginal cost',type:'line',data:prL,yAxisID:'yR',borderColor:mcColor,borderWidth:1,pointRadius:0,tension:0,fill:false,spanGaps:true,order:1});const linePlugin=(demL.some(v=>v)||prL.some(v=>v!=null))?{id:'lineS',afterDatasetsDraw:(chart)=>{const{ctx,chartArea:ca,scales:sc}=chart;if(!ca)return;const dL=(data,yK,col,lw=1.5)=>{if(!data.some(v=>v!=null)||!sc[yK])return;ctx.save();ctx.beginPath();ctx.strokeStyle=col;ctx.lineWidth=lw;ctx.setLineDash([]);let mv=false;data.forEach((v,i)=>{if(v==null){mv=false;return;}const x=sc.x.getPixelForValue(i);const y=sc[yK].getPixelForValue(v);mv?ctx.lineTo(x,y):ctx.moveTo(x,y);mv=true;});ctx.stroke();ctx.restore();};dL(demL,'y','#CC0000');dL(prL,'yR',mcColor,1);}}:null;return{chartData:{labels:Array.from({length:24},(_,i)=>`${i+1}h`),datasets:datasets2},plugin:linePlugin};};

  const buildTrade=()=>{const tx=resultsData[trScenario]?.transmission||{};if(!refYear)return null;const imp={},exp={};for(const z of visZones){imp[z]=0;exp[z]=0;for(const[z2,attrs]of Object.entries(tx[z]||{}))exp[z]+=(attrs.Interchange?.[refYear]||0);for(const[z2,zm]of Object.entries(tx))if(z2!==z)imp[z]+=(zm[z]?.Interchange?.[refYear]||0);}const zones=allZones.filter(z=>imp[z]+exp[z]>0.5).sort((a,b)=>(imp[b]-exp[b])-(imp[a]-exp[a]));if(!zones.length)return null;const net=Object.fromEntries(zones.map(z=>[z,+(imp[z]-exp[z]).toFixed(1)]));return{labels:zones,datasets:[!isHidden('trade-c','Imports')&&{label:'Imports',data:zones.map(z=>+imp[z].toFixed(1)),backgroundColor:hexA('#2E9EC8',0.78),borderWidth:0,barThickness:12,stack:'t'},!isHidden('trade-c','Exports')&&{label:'Exports',data:zones.map(z=>+(-exp[z]).toFixed(1)),backgroundColor:hexA('#E8C547',0.78),borderWidth:0,barThickness:12,stack:'t'},{label:'Net',data:zones.map(z=>net[z]),backgroundColor:t.isDark?'rgba(255,255,255,0.92)':'#1E3A8A',borderWidth:0,barThickness:3,order:0}].filter(Boolean),_imp:imp,_exp:exp,_net:net};};

  const buildTradeEv=()=>{
    const activeSc=baseFirst(scenarioList.filter(s=>trScenarios.has(s)&&resultsData[s]));
    if(!activeSc.length||!allYears.length)return null;
    const tx0=resultsData[activeSc[0]]?.transmission||{};
    const corridors=[];const seen=new Set();
    for(const[z,zm]of Object.entries(tx0))for(const z2 of Object.keys(zm)){if(!allZones.includes(z)&&!allZones.includes(z2))continue;if(selZone!=='all'&&z!==selZone&&z2!==selZone)continue;const k=[z,z2].sort().join('||');if(!seen.has(k)){seen.add(k);corridors.push({z,z2,key:k});}}
    if(!corridors.length)return null;
    const attr=trEvMetric==='volume'?'Interchange':trEvMetric==='capacity'?'TransmissionCapacity':'InterconUtilization';
    const unit=trEvMetric==='volume'?'GWh':trEvMetric==='capacity'?'MW':'%';
    const PSTYLES=['circle','rectRot','triangle','crossRot'];const isUtil=trEvMetric==='utilization';const multi=activeSc.length>1;
    const datasets=activeSc.flatMap((scen,si)=>corridors.slice(0,10).map((c,ci)=>{
      const col=MAP_PALETTE[ci%MAP_PALETTE.length];
      const data=allYears.map(y=>{const tx=resultsData[scen]?.transmission||{};const fwd=tx[c.z]?.[c.z2]?.[attr]?.[y]||0;const rev=tx[c.z2]?.[c.z]?.[attr]?.[y]||0;return isUtil?+(((fwd+rev)/2)*100).toFixed(1):+(Math.abs(fwd)+Math.abs(rev)).toFixed(1);});
      const label=multi?`${scen} — ${c.z}↔${c.z2}`:`${c.z}↔${c.z2}`;
      if(isUtil)return{label,data,type:'line',borderColor:col,backgroundColor:hexA(col,0.1),borderWidth:1.5,fill:false,tension:0.3,pointStyle:PSTYLES[si%PSTYLES.length],pointRadius:3};
      return{label,data,backgroundColor:hexA(col,0.82),borderColor:col,borderWidth:0,stack:scen,type:'bar'};
    }));
    return{labels:allYears,corridors,unit,datasets};
  };

  const buildPlants=()=>(resultsData[plScenario]?.plants||[]).filter(p=>p.attribute===plIndicator&&p.y===refYear&&p.value>0&&allZones.includes(p.z)&&(plZone==='all'||p.z===plZone)).sort((a,b)=>b.value-a.value).slice(0,plTopN);
  const buildLCOE=()=>{const pl=resultsData[plScenario]?.plants||[];if(!refYear)return null;const byG={};for(const p of pl.filter(pp=>pp.y===refYear&&allZones.includes(pp.z)&&(plZone==='all'||pp.z===plZone))){if(!byG[p.g])byG[p.g]={techfuel:p.techfuel,z:p.z};byG[p.g][p.attribute]=p.value;}const points=Object.entries(byG).map(([g,d])=>({g,techfuel:d.techfuel||'',lcoe:d.PlantAnnualLCOE||0,util:(d.UtilizationPlant||0)*100,cap:d.CapacityPlant||0})).filter(p=>p.lcoe>0&&p.util>0&&p.cap>0);const tfs=[...new Set(points.map(p=>p.techfuel))].sort();return{datasets:tfs.map(tf=>({label:tf,data:points.filter(p=>p.techfuel===tf).map(p=>({x:+p.util.toFixed(1),y:+p.lcoe.toFixed(1),r:Math.min(Math.max(Math.sqrt(p.cap)*0.6,3),20),_plant:p.g,_cap:p.cap})),backgroundColor:hexA(techColor(tf),0.65),borderColor:techColor(tf),borderWidth:1})).filter(d=>d.data.length>0)};};

  const snapData=buildSnapshot(),snapDeltaData=buildSnapshotDelta();
  const cmpEvData=buildCmpEvolution();
  const dispDeltaResult=(cmpRef&&cmpRef!==dispScenario&&resultsData[cmpRef])?buildDispatchDelta():{chartData:{labels:[],datasets:[]},plugin:null};
  const tradeCmpDeltaData=buildTradeCmpDelta();
  const mixData=buildMix(),evData=buildEvolution(),dispResult=buildDispatch(),tradeData=buildTrade(),tradeEvData=buildTradeEv(),plantsData=buildPlants(),lcoeData=buildLCOE();
  const dispTechs=dispResult.chartData.datasets.filter(d=>d.label!=='Marginal cost'&&d.label!=='Demand').map(d=>d.label);

  // ── Legend helpers ────────────────────────────────────────────────────────────
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

  // ── JSX ───────────────────────────────────────────────────────────────────────
  return (
    <div style={{display:'flex',height:'calc(100vh - 46px)'}}
      onMouseMove={e=>{if(!isDrRef.current)return;setPanelWidth(w=>Math.max(380,drStartW.current+(drStartX.current-e.clientX)));}}
      onMouseUp={()=>{isDrRef.current=false;}} onMouseLeave={()=>{isDrRef.current=false;}}
    >
      <div style={{position:'relative',flex:1}}>
        <div ref={containerRef} style={{width:'100%',height:'100%',backgroundColor:t.bg}}/>
        <div style={{position:'absolute',top:10,left:10,zIndex:10,display:'flex',gap:4,alignItems:'center',fontSize:'0.52rem',color:t.text,backgroundColor:t.panel,border:`1px solid ${t.panelBorder}`,borderRadius:5,padding:'4px 10px',boxShadow:'0 1px 4px rgba(0,0,0,.18)'}}>
          <Link to="/" style={{color:t.lblMuted,textDecoration:'none'}}>World</Link><span style={{color:t.lblMuted}}>›</span>
          <Link to={`/region/${regionId}/results`} style={{color:t.lblMuted,textDecoration:'none'}}>{region.name} · Results</Link>
          <span style={{color:t.lblMuted}}>›</span><span style={{color:t.lbl,fontWeight:600}}>{countryDecoded}</span>
        </div>
        {hasData&&(
          <div style={{position:'absolute',bottom:14,left:10,zIndex:10,backgroundColor:hexA(t.panel,0.92),border:`1px solid ${t.panelBorder}`,borderRadius:6,padding:'8px 10px',fontSize:'0.43rem',color:t.muted,minWidth:110}}>
            <div style={{marginBottom:5}}>
              <div style={{fontSize:'0.38rem',color:t.lblMuted,marginBottom:2}}>Interco utilization</div>
              <div style={{background:'linear-gradient(to right, #FFD700, #FF8C00, #E53935)',height:5,borderRadius:3,marginBottom:2}}/>
              <div style={{display:'flex',justifyContent:'space-between'}}><span>0%</span><span>100%</span></div>
            </div>
            {Object.keys(zoneAvgPrices).length>0&&<div>
              <div style={{fontSize:'0.38rem',color:t.lblMuted,marginBottom:2}}>Zonal price (marginal cost)</div>
              <div style={{background:'linear-gradient(to right, #FFFFFF, #1B6CA8)',height:5,borderRadius:3,marginBottom:2}}/>
              <div style={{display:'flex',justifyContent:'space-between'}}><span>{minP.toFixed(0)}</span><span>{maxP.toFixed(0)} $/MWh</span></div>
            </div>}
            <div style={{marginTop:8,paddingTop:8,borderTop:`1px solid ${hexA(t.panelBorder,0.5)}`}}>
              <div style={{fontSize:'0.38rem',color:t.lblMuted,marginBottom:4}}>Zone mix</div>
              <div style={{display:'flex',gap:4}}>
                <Pill active={pieDispMode==='none'} onClick={()=>setPieDispMode('none')}>—</Pill>
                <Pill active={pieDispMode==='capacity'} onClick={()=>setPieDispMode('capacity')}>Cap.</Pill>
                <Pill active={pieDispMode==='energy'} onClick={()=>setPieDispMode('energy')}>Gen.</Pill>
              </div>
            </div>
          </div>
        )}
      </div>

      <div style={{width:5,flexShrink:0,cursor:'col-resize'}} onMouseDown={e=>{isDrRef.current=true;drStartX.current=e.clientX;drStartW.current=panelWidth;e.preventDefault();}}/>

      <div style={{width:panelWidth,flexShrink:0,height:'100%',overflowY:'auto',padding:'18px 16px',backgroundColor:t.panel,borderLeft:`1px solid ${t.panelBorder}`}}>
        <div style={{marginBottom:12}}>
          <div style={{fontSize:'0.52rem',color:t.lblMuted,marginBottom:2}}><Link to={`/region/${regionId}/results`} style={{color:t.lblMuted,textDecoration:'none'}}>← {region.name} · Results</Link></div>
          <div style={{fontSize:'1rem',fontWeight:700,color:t.lbl}}>{countryDecoded} — Results</div>
        </div>
        {/* Run selector */}
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:12,padding:'7px 10px',border:`1px solid ${t.panelBorder}`,borderRadius:6,backgroundColor:hexA(t.panelBorder,0.12)}}>
          <span style={{fontSize:'0.5rem',color:t.lblMuted,flexShrink:0}}>Run</span>
          {loadingRuns?<span style={{fontSize:'0.5rem',color:t.lblMuted}}>Loading…</span>:runList.length>0?<select value={simRun||''} onChange={e=>setSimRun(e.target.value)} style={{...selectStyle,flex:1}}>{runList.map(r=><option key={r} value={r}>{r}</option>)}</select>:<span style={{fontSize:'0.5rem',color:t.lblMuted}}>No results</span>}
        </div>
        {/* Tabs */}
        <div style={{display:'flex',gap:0,marginBottom:16,borderBottom:`1px solid ${t.panelBorder}`}}>
          {TABS.map(tab=><button key={tab} onClick={()=>setActiveTab(tab)} style={{fontSize:'0.5rem',fontFamily:'inherit',padding:'6px 11px',border:'none',borderBottom:activeTab===tab?`2px solid ${t.lbl}`:'2px solid transparent',backgroundColor:'transparent',color:activeTab===tab?t.lbl:t.lblMuted,cursor:'pointer',fontWeight:activeTab===tab?600:400,textTransform:'capitalize'}}>{tab}</button>)}
        </div>
        {loadingData&&<div style={{padding:'24px 0',textAlign:'center',color:t.lblMuted,fontSize:'0.6rem'}}>Loading…</div>}
        {hasData&&allZones.length>1&&(
          <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:10,fontSize:'0.44rem',color:t.muted}}>
            <span style={{color:t.lblMuted}}>Zone:</span>
            <select value={selZone} onChange={e=>setSelZone(e.target.value)} style={selectStyle}>
              <option value="all">All zones</option>
              {allZones.map(z=><option key={z} value={z}>{z}</option>)}
            </select>
            {selZone!=='all'&&<span onClick={()=>setSelZone('all')} style={{cursor:'pointer',color:t.lblMuted,padding:'1px 5px',border:`1px solid ${t.panelBorder}`,borderRadius:3,fontSize:'0.42rem'}}>✕ all</span>}
            <span style={{color:t.lblMuted,fontSize:'0.4rem',marginLeft:2}}>or click zone on map</span>
          </div>
        )}

        {/* ── OVERVIEW ── */}
        {hasData&&activeTab==='overview'&&(
          <div style={{display:'flex',flexDirection:'column',gap:14}}>
            <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
              <select value={refYear||''} onChange={e=>setRefYear(e.target.value)} style={selectStyle}>{allYears.map(y=><option key={y} value={y}>{y}</option>)}</select>
              <select value={ovScenario||''} onChange={e=>setOvScenario(e.target.value)} style={selectStyle}>{scenarioList.map(s=><option key={s} value={s}>{s}</option>)}</select>
            </div>
            {(()=>{const sd=resultsData[ovScenario];if(!sd||!refYear)return null;const totGW=allZones.reduce((s,z)=>s+Object.values(sd.techFuel[z]?.CapacityTechFuel?.[refYear]||{}).reduce((a,b)=>a+b,0),0)/1000;const demTWh=allZones.reduce((s,z)=>s+(sd.yearlyZone[z]?.DemandEnergyZone?.[refYear]||0),0)/1000;const avgP=priceVals.length?priceVals.reduce((a,b)=>a+b,0)/priceVals.length:null;return<div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>{[{l:`Installed ${refYear}`,v:`${totGW.toFixed(1)} GW`},{l:`Demand ${refYear}`,v:`${demTWh.toFixed(0)} TWh`},{l:'Avg price',v:avgP!=null?`${avgP.toFixed(1)} $/MWh`:'—'}].map(({l,v})=><div key={l} style={{border:`1px solid ${t.panelBorder}`,borderRadius:6,padding:'8px 10px'}}><div style={{fontSize:'0.41rem',color:t.lblMuted,marginBottom:2}}>{l}</div><div style={{fontSize:'0.78rem',fontWeight:700,color:t.lbl}}>{v}</div></div>)}</div>;})()}
            {mixData&&<div>
              <SectionTitle t={t}>Capacity mix by zone (MW)</SectionTitle>
              <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                <div style={{flex:1,minWidth:0}}>
                  <CJChart type="bar" height={Math.min(mixData.labels.length*22+24,260)} cacheKey={`mix-c|${ovScenario}|${refYear}|${theme}|${[...hiddenMap['mix-c']||[]].join(',')}`} data={mixData} options={{...cjDefaults(t),indexAxis:'y',scales:{x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}},y:{stacked:true,grid:{display:false},ticks:{color:t.muted,font:{size:8}}}},plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>`${ctx.dataset.label}: ${fmt(ctx.parsed.x)} MW`}}}}}/>
                </div>
                {makeLegend('mix-c',allTechfuels.filter(tf=>mixData.datasets.some(d=>d.label===tf)).map(tf=>({label:tf,color:techColor(tf)})))}
              </div>
            </div>}
            {Object.keys(zoneAvgPrices).length>0&&<div>
              <SectionTitle t={t}>Avg marginal price by zone ($/MWh)</SectionTitle>
              <CJChart type="bar" height={Math.min(allZones.filter(z=>zoneAvgPrices[z]).length*22+24,200)} cacheKey={`pz-c|${ovScenario}|${refYear}|${theme}`}
                data={{labels:allZones.filter(z=>zoneAvgPrices[z]),datasets:[
                  {label:'Range',data:allZones.filter(z=>zoneAvgPrices[z]).map(z=>{const r=zonePriceRange[z];return r?[+r.min.toFixed(1),+r.max.toFixed(1)]:[+zoneAvgPrices[z].toFixed(1),+zoneAvgPrices[z].toFixed(1)];}),backgroundColor:allZones.filter(z=>zoneAvgPrices[z]).map(z=>priceBarColor((zoneAvgPrices[z]-minP)/rngP).replace('rgb(','rgba(').replace(')',',0.18)')),borderWidth:0,barThickness:10},
                  {type:'scatter',label:'Avg',data:allZones.filter(z=>zoneAvgPrices[z]).map(z=>({x:+zoneAvgPrices[z].toFixed(1),y:z})),pointStyle:'line',rotation:90,radius:6,borderWidth:2.5,borderColor:allZones.filter(z=>zoneAvgPrices[z]).map(z=>priceBarColor((zoneAvgPrices[z]-minP)/rngP))},
                ]}}
                options={{...cjDefaults(t),indexAxis:'y',scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}}},y:{grid:{display:false},ticks:{color:t.muted,font:{size:8}}}},plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>{const zones=allZones.filter(z=>zoneAvgPrices[z]);const z=zones[ctx.dataIndex];if(ctx.datasetIndex===0){const r=zonePriceRange[z];return r&&r.min!==r.max?`${r.min.toFixed(1)}–${r.max.toFixed(1)} $/MWh`:'';} return`Avg: ${zoneAvgPrices[z]?.toFixed(1)} $/MWh`;},title:ctx=>ctx[0]?.label||''}}}}}
              />
              {priceVals.length>0&&<div style={{display:'flex',gap:12,marginTop:4,fontSize:'0.44rem',color:t.muted}}><span>Avg: <b style={{color:t.lbl}}>{(priceVals.reduce((a,b)=>a+b,0)/priceVals.length).toFixed(1)} $/MWh</b></span><span>Min: <b style={{color:t.lbl}}>{minP.toFixed(1)}</b></span><span>Max: <b style={{color:t.lbl}}>{maxP.toFixed(1)}</b></span></div>}
            </div>}
          </div>
        )}

        {/* ── SNAPSHOT ── */}
        {hasData&&activeTab==='snapshot'&&(
          <div style={{display:'flex',flexDirection:'column',gap:14}}>
            <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
              <select value={snapIndicator} onChange={e=>setSnapIndicator(e.target.value)} style={selectStyle}>{INDICATORS.map(ind=><option key={ind.key} value={ind.key}>{ind.label}</option>)}</select>
              <select value={refYear||''} onChange={e=>setRefYear(e.target.value)} style={selectStyle}>{allYears.map(y=><option key={y} value={y}>{y}</option>)}</select>
              <div style={{width:1,height:14,backgroundColor:t.panelBorder}}/>
              {scenarioList.map(s=><Pill key={s} active={snapScenarios.has(s)} onClick={()=>setSnapScenarios(prev=>{const n=new Set(prev);n.has(s)?n.delete(s):n.add(s);return n;})}>{s}</Pill>)}
            </div>
            {snapData&&snapData.datasets.length>0?
              <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                <div style={{flex:1,minWidth:0}}>
                  <CJChart type="bar" height={220}
                    cacheKey={`snap-c|${snapIndicator}|${refYear}|${theme}|${[...snapScenarios].sort().join(',')}|${[...hiddenMap['snap-c-tf']||[]].join(',')}`}
                    plugins={snapData.netPlugin?[snapData.netPlugin]:[]}
                    data={{labels:snapData.labels,datasets:snapData.datasets.filter(d=>{const lbl=d.label.includes(' — ')?d.label.split(' — ')[1]:d.label;return!isHidden('snap-c-tf',lbl);})}}
                    options={{...cjDefaults(t),scales:{x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:7},maxRotation:45,autoSkip:true,maxTicksLimit:20}},y:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:(snapData.ind||{}).unit||'',color:t.muted,font:{size:7}}}},plugins:{...cjDefaults(t).plugins,legend:{display:false},tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false,callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.raw?.toLocaleString?.()??ctx.raw}`}}}}}
                  />
                  {[...snapScenarios].filter(s=>resultsData[s]).length>1&&(snapData.ind?.source==='yearlyZone'?
                    <div style={{display:'flex',gap:6,flexWrap:'wrap',marginTop:3,fontSize:'0.42rem',color:t.muted}}>
                      {baseFirst(scenarioList.filter(s=>snapScenarios.has(s)&&resultsData[s])).map((s,i)=><span key={s} style={{display:'flex',alignItems:'center',gap:3}}><span style={{display:'inline-block',width:7,height:7,borderRadius:1,backgroundColor:SCEN_COLORS[i%SCEN_COLORS.length]}}/>{s}</span>)}
                    </div>:
                    <div style={{fontSize:'0.42rem',color:t.lblMuted,marginTop:3}}>Groups (L→R): {baseFirst(scenarioList.filter(s=>snapScenarios.has(s)&&resultsData[s])).join(' · ')}</div>
                  )}
                </div>
                {makeLegend('snap-c-tf',[...new Set(snapData.datasets.map(d=>d.label.includes(' — ')?d.label.split(' — ')[1]:d.label))].map(tf=>({label:tf,color:techColor(tf)||SCEN_COLORS[0]})))}
              </div>
            :<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>Select at least one scenario.</div>}
            {scenarioList.length>1&&(
              <div style={{borderTop:`1px solid ${hexA(t.panelBorder,0.4)}`,paddingTop:10,marginTop:2,display:'flex',flexDirection:'column',gap:8}}>
                <div style={{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}}>
                  <span style={{fontSize:'0.47rem',letterSpacing:'2px',fontWeight:700,color:t.lblMuted,textTransform:'uppercase'}}>Δ vs ref:</span>
                  <select value={cmpRef||''} onChange={e=>{setCmpRef(e.target.value);setCmpScenarios(new Set(scenarioList.filter(s=>s!==e.target.value)));}} style={selectStyle}>{scenarioList.map(s=><option key={s} value={s}>{s}</option>)}</select>
                  {scenarioList.filter(s=>s!==cmpRef).map(s=><Pill key={s} active={cmpScenarios.has(s)} onClick={()=>setCmpScenarios(prev=>{const n=new Set(prev);n.has(s)?n.delete(s):n.add(s);return n;})}>{s}</Pill>)}
                </div>
                {snapDeltaData&&snapDeltaData.datasets.length>0?
                  <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                    <div style={{flex:1,minWidth:0}}>
                      <CJChart type="bar" height={180}
                        cacheKey={`snap-c-d|${snapIndicator}|${refYear}|${theme}|${cmpRef}|${[...cmpScenarios].sort().join(',')}|${[...hiddenMap['snap-c-tf']||[]].join(',')}`}
                        plugins={snapDeltaData.netPlugin?[snapDeltaData.netPlugin]:[]}
                        data={{labels:snapDeltaData.labels,datasets:snapDeltaData.datasets.filter(d=>{const lbl=d.label.includes(' — ')?d.label.split(' — ')[1]:d.label;return!isHidden('snap-c-tf',lbl);})}}
                        options={{...cjDefaults(t),scales:{x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:7},maxRotation:45,autoSkip:true,maxTicksLimit:20}},y:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:(snapDeltaData.ind||{}).unit||'',color:t.muted,font:{size:7}}}},plugins:{...cjDefaults(t).plugins,legend:{display:false},tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false,callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.raw>0?'+':''}${ctx.raw?.toLocaleString?.()??ctx.raw}`,footer:ctxs=>{const total=ctxs.reduce((s,c)=>s+(c.raw||0),0);return total!==0?`Net: ${total>0?'+':''}${Math.round(total).toLocaleString()}`:undefined;}}}}}}
                      />
                      {[...cmpScenarios].filter(s=>resultsData[s]&&s!==cmpRef).length>0&&(
                        <div style={{fontSize:'0.42rem',color:t.lblMuted,marginTop:3}}>Δ vs <b style={{color:t.muted}}>{cmpRef}</b>: {baseFirst([...cmpScenarios].filter(s=>resultsData[s]&&s!==cmpRef)).join(' · ')}</div>
                      )}
                    </div>
                    {makeLegend('snap-c-tf',[...new Set(snapDeltaData.datasets.map(d=>d.label.includes(' — ')?d.label.split(' — ')[1]:d.label))].map(tf=>({label:tf,color:techColor(tf)||SCEN_COLORS[0]})))}
                  </div>
                :<div style={{fontSize:'0.55rem',color:t.lblMuted}}>{[...cmpScenarios].filter(s=>s!==cmpRef&&resultsData[s]).length>0?'No differences found.':'Select at least one scenario to compare.'}</div>}
              </div>
            )}
          </div>
        )}

        {/* ── EVOLUTION ── */}
        {hasData&&activeTab==='evolution'&&(
          <div style={{display:'flex',flexDirection:'column',gap:14}}>
            <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
              <select value={evIndicator} onChange={e=>setEvIndicator(e.target.value)} style={selectStyle}>{INDICATORS.map(ind=><option key={ind.key} value={ind.key}>{ind.label}</option>)}</select>
              <div style={{width:1,height:14,backgroundColor:t.panelBorder}}/>
              {scenarioList.map(s=><Pill key={s} active={evScenarios.has(s)} onClick={()=>setEvScenarios(prev=>{const n=new Set(prev);n.has(s)?n.delete(s):n.add(s);return n;})}>{s}</Pill>)}
            </div>
            {evData?
              <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                <div style={{flex:1,minWidth:0}}>
                  <CJChart type={activeInd.source==='yearlyZone'?'line':'bar'} height={200} cacheKey={`ev-c|${evIndicator}|${theme}|${[...evScenarios].sort().join(',')}|${[...hiddenMap['ev-c']||[]].join(',')}`}
                    data={{...evData,datasets:evData.datasets.filter(d=>{if(activeInd.source==='techFuel')return!isHidden('ev-c',tfLabel(d));if(activeInd.source==='costs')return!isHidden('ev-cost',tfLabel(d));return true;})}}
                    options={{...cjDefaults(t),scales:{x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},maxTicksLimit:10}},y:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:activeInd.unit,color:t.muted,font:{size:7}}}},plugins:{...cjDefaults(t).plugins,legend:activeInd.source==='yearlyZone'&&evScenarios.size>1?{display:true,labels:{color:t.muted,font:{size:8},boxWidth:8,boxHeight:6}}:{display:false},tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>`${ctx.dataset.label}: ${fmt(ctx.parsed.y)}`}}}}}/>
                  {activeInd.source!=='yearlyZone'&&evScenarios.size>1&&(
                    <div style={{fontSize:'0.42rem',color:t.lblMuted,marginTop:3}}>Groups (L→R): {baseFirst(scenarioList.filter(s=>evScenarios.has(s)&&resultsData[s])).join(' · ')}</div>
                  )}
                </div>
                {activeInd.source==='techFuel'&&makeLegend('ev-c',allTechfuels.filter(tf=>evData.datasets.some(d=>tfLabel(d)===tf)).map(tf=>({label:tf,color:techColor(tf)})))}
                {activeInd.source==='costs'&&makeLegend('ev-cost',MAIN_COST_CATS.filter(cat=>evData.datasets.some(d=>tfLabel(d)===(COST_LABELS[cat]||cat))).map(cat=>({label:COST_LABELS[cat]||cat,color:costColor(cat)})))}
              </div>
            :<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>Select at least one scenario.</div>}
            {scenarioList.length>1&&(
              <div style={{borderTop:`1px solid ${hexA(t.panelBorder,0.4)}`,paddingTop:10,marginTop:2,display:'flex',flexDirection:'column',gap:8}}>
                <div style={{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}}>
                  <span style={{fontSize:'0.47rem',letterSpacing:'2px',fontWeight:700,color:t.lblMuted,textTransform:'uppercase'}}>Δ vs ref:</span>
                  <select value={cmpRef||''} onChange={e=>{setCmpRef(e.target.value);setCmpScenarios(new Set(scenarioList.filter(s=>s!==e.target.value)));}} style={selectStyle}>{scenarioList.map(s=><option key={s} value={s}>{s}</option>)}</select>
                  {scenarioList.filter(s=>s!==cmpRef).map(s=><Pill key={s} active={cmpScenarios.has(s)} onClick={()=>setCmpScenarios(prev=>{const n=new Set(prev);n.has(s)?n.delete(s):n.add(s);return n;})}>{s}</Pill>)}
                </div>
                {cmpEvData&&cmpEvData.datasets.length>0?
                  <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                    <div style={{flex:1,minWidth:0}}>
                      <CJChart type="bar" height={190}
                        cacheKey={`cmp-ev-c|${evIndicator}|${theme}|${cmpRef}|${[...cmpScenarios].sort().join(',')}|${[...hiddenMap['ev-c']||[]].join(',')}|${[...hiddenMap['ev-cost']||[]].join(',')}`}
                        data={{...cmpEvData,datasets:cmpEvData.datasets.filter(d=>{if(activeInd.source==='techFuel')return!isHidden('ev-c',tfLabel(d));if(activeInd.source==='costs')return!isHidden('ev-cost',tfLabel(d));return true;})}}
                        options={{...cjDefaults(t),scales:{x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},maxTicksLimit:10}},y:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:activeInd.unit,color:t.muted,font:{size:7}}}},plugins:{...cjDefaults(t).plugins,legend:activeInd.source==='yearlyZone'?{display:true,labels:{color:t.muted,font:{size:8},boxWidth:8,boxHeight:6}}:{display:false},tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false,callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.raw>0?'+':''}${ctx.raw?.toLocaleString?.()??ctx.raw}`,footer:ctxs=>{const total=ctxs.reduce((s,c)=>s+(c.raw||0),0);return total!==0?`Net: ${total>0?'+':''}${Math.round(total).toLocaleString()} ${activeInd.unit}`:undefined;}}}}}}
                      />
                      {activeInd.source!=='yearlyZone'&&[...cmpScenarios].filter(s=>resultsData[s]&&s!==cmpRef).length>0&&(
                        <div style={{fontSize:'0.42rem',color:t.lblMuted,marginTop:3}}>Δ vs <b style={{color:t.muted}}>{cmpRef}</b>: {baseFirst([...cmpScenarios].filter(s=>resultsData[s]&&s!==cmpRef)).join(' · ')}</div>
                      )}
                    </div>
                    {activeInd.source==='techFuel'&&makeLegend('ev-c',[...new Set(cmpEvData.datasets.map(tfLabel))].map(tf=>({label:tf,color:techColor(tf)||SCEN_COLORS[0]})))}
                    {activeInd.source==='costs'&&makeLegend('ev-cost',[...new Set(cmpEvData.datasets.map(tfLabel))].map(tf=>({label:tf,color:costColor(tf)})))}
                  </div>
                :<div style={{fontSize:'0.55rem',color:t.lblMuted}}>{[...cmpScenarios].filter(s=>s!==cmpRef&&resultsData[s]).length>0?'No differences found.':'Select at least one scenario to compare.'}</div>}
              </div>
            )}
          </div>
        )}

        {/* ── DISPATCH ── */}
        {hasData&&activeTab==='dispatch'&&(
          <div style={{display:'flex',flexDirection:'column',gap:10}}>
            <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
              <select value={activeDispZone||''} onChange={e=>setDispZone(e.target.value)} style={selectStyle}>
                <option value="__all__">All zones (aggregated)</option>
                {allZones.map(z=><option key={z} value={z}>{z}</option>)}
              </select>
              <select value={dispScenario||''} onChange={e=>setDispScenario(e.target.value)} style={selectStyle}>{scenarioList.map(s=><option key={s} value={s}>{s}</option>)}</select>
              <select value={refYear||''} onChange={e=>setRefYear(e.target.value)} style={selectStyle}>{allYears.map(y=><option key={y} value={y}>{y}</option>)}</select>
            </div>
            <div style={{display:'flex',flexWrap:'wrap',gap:3,alignItems:'center'}}>
              <Pill active={dispMode==='full'} onClick={()=>setDispMode('full')}>Full Year</Pill>
              {dispAvailS.map(s=><Pill key={s} active={dispMode==='season'&&dispSeason===s} onClick={()=>{setDispMode('season');setDispSeason(s);}}>{s}</Pill>)}
              {dispMode==='season'&&dispAvailD.length>0&&<><div style={{width:1,height:14,backgroundColor:t.panelBorder}}/><select value={dispDay} onChange={e=>setDispDay(e.target.value)} style={selectStyle}><option value="avg">Avg</option>{dispAvailD.map(d=><option key={d} value={d}>{d}</option>)}</select></>}
            </div>
            {dispResult.chartData.datasets.length>0?
              <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                <div style={{flex:1,minWidth:0}}>
                  <CJChart type="line" height={dispMode==='full'?210:165}
                    data={{...dispResult.chartData,datasets:dispResult.chartData.datasets.filter(d=>!isHidden('disp-c-tf',d.label))}}
                    plugins={dispResult.plugin?[dispResult.plugin]:[]}
                    cacheKey={`disp-c|${dispScenario}|${activeDispZone}|${refYear}|${dispMode}|${dispSeason}|${dispDay}|${theme}|${[...hiddenMap['disp-c-tf']||[]].join(',')}`}
                    options={{...cjDefaults(t),layout:{padding:{top:dispMode==='full'?18:4,bottom:dispMode==='full'?62:4}},scales:{x:{grid:{color:hexA(t.panelBorder,0.35),drawTicks:false},ticks:{display:dispMode!=='full',color:t.muted,font:{size:7},maxTicksLimit:12}},y:{stacked:true,grid:{color:hexA(t.panelBorder,0.35)},ticks:{color:t.muted,font:{size:8}},title:{display:true,text:'MW',color:t.muted,font:{size:7}}},yR:{type:'linear',position:'right',display:dispResult.chartData.datasets.some(d=>d.label==='Marginal cost'&&!isHidden('disp-c-tf','Marginal cost')),grid:{drawOnChartArea:false},ticks:{color:t.muted,font:{size:8}},title:{display:true,text:'$/MWh',color:t.muted,font:{size:7}}}},plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false}}}}/>
                </div>
                {makeLegend('disp-c-tf',[...dispTechs.map(tf=>({label:tf,color:techColor(tf)})),{label:'Demand',color:'#8B0000',shape:'line'},{label:'Marginal cost',color:t.isDark?'rgba(255,255,255,0.88)':'#1E3A8A',shape:'line'}])}
              </div>
            :<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>No dispatch data.</div>}
            {scenarioList.length>1&&(
              <div style={{borderTop:`1px solid ${hexA(t.panelBorder,0.4)}`,paddingTop:10,marginTop:6,display:'flex',flexDirection:'column',gap:8}}>
                <div style={{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}}>
                  <span style={{fontSize:'0.47rem',letterSpacing:'2px',fontWeight:700,color:t.lblMuted,textTransform:'uppercase'}}>Δ vs ref:</span>
                  <select value={cmpRef||''} onChange={e=>{setCmpRef(e.target.value);setCmpScenarios(new Set(scenarioList.filter(s=>s!==e.target.value)));}} style={selectStyle}>{scenarioList.map(s=><option key={s} value={s}>{s}</option>)}</select>
                </div>
                {cmpRef&&cmpRef!==dispScenario&&dispDeltaResult.chartData.datasets.length>0?<>
                  <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                    <div style={{flex:1,minWidth:0}}>
                      <CJChart type="line" height={dispMode==='full'?180:130}
                        data={{...dispDeltaResult.chartData,datasets:dispDeltaResult.chartData.datasets.filter(d=>!isHidden('disp-c-tf',d.label))}}
                        plugins={dispDeltaResult.plugin?[dispDeltaResult.plugin]:[]}
                        cacheKey={`disp-c-d|${dispScenario}|${cmpRef}|${activeDispZone}|${refYear}|${dispMode}|${dispSeason}|${dispDay}|${theme}|${[...hiddenMap['disp-c-tf']||[]].join(',')}`}
                        options={{...cjDefaults(t),layout:{padding:{top:dispMode==='full'?18:4,bottom:dispMode==='full'?62:4}},scales:{x:{grid:{color:hexA(t.panelBorder,0.35),drawTicks:false},ticks:{display:dispMode!=='full',color:t.muted,font:{size:7},maxTicksLimit:12}},y:{stacked:true,grid:{color:hexA(t.panelBorder,0.35)},ticks:{color:t.muted,font:{size:8}},title:{display:true,text:'ΔMW',color:t.muted,font:{size:7}}},yR:{type:'linear',position:'right',display:dispDeltaResult.chartData.datasets.some(d=>d.label==='Marginal cost'&&!isHidden('disp-c-tf','Marginal cost')),grid:{drawOnChartArea:false},ticks:{color:t.muted,font:{size:8}},title:{display:true,text:'Δ$/MWh',color:t.muted,font:{size:7}}}},plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false,callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.raw>0?'+':''}${ctx.raw?.toLocaleString?.()}`}}}}}
                      />
                    </div>
                    {makeLegend('disp-c-tf',[...dispTechs.map(tf=>({label:tf,color:techColor(tf)})),{label:'Demand',color:'#8B0000',shape:'line'},{label:'Marginal cost',color:t.isDark?'rgba(255,255,255,0.88)':'#1E3A8A',shape:'line'}])}
                  </div>
                </>:cmpRef&&cmpRef===dispScenario?<div style={{fontSize:'0.55rem',color:t.lblMuted}}>Select a different reference scenario.</div>:<div style={{fontSize:'0.55rem',color:t.lblMuted}}>No differences found.</div>}
              </div>
            )}
          </div>
        )}

        {/* ── TRADE ── */}
        {hasData&&activeTab==='trade'&&(
          <div style={{display:'flex',flexDirection:'column',gap:14}}>
            <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
              <select value={refYear||''} onChange={e=>setRefYear(e.target.value)} style={selectStyle}>{allYears.map(y=><option key={y} value={y}>{y}</option>)}</select>
              <select value={trScenario||''} onChange={e=>setTrScenario(e.target.value)} style={selectStyle}>{scenarioList.map(s=><option key={s} value={s}>{s}</option>)}</select>
              <div style={{width:1,height:14,backgroundColor:t.panelBorder}}/>
              {scenarioList.map(s=><Pill key={s} active={trScenarios.has(s)} onClick={()=>setTrScenarios(prev=>{const n=new Set(prev);n.has(s)?n.delete(s):n.add(s);return n;})}>{s}</Pill>)}
            </div>
            {tradeEvData&&(()=>{const allCorridors=tradeEvData.corridors||[];const unit=tradeEvData.unit||'GWh';return<>
              <div style={{display:'flex',gap:4,alignItems:'center',flexWrap:'wrap',marginTop:4}}>
                <SectionTitle t={t}>Trade evolution by corridor</SectionTitle>
                <div style={{display:'flex',gap:3,marginLeft:'auto'}}>
                  <Pill active={trEvMetric==='volume'} onClick={()=>setTrEvMetric('volume')}>GWh</Pill>
                  <Pill active={trEvMetric==='capacity'} onClick={()=>setTrEvMetric('capacity')}>MW</Pill>
                  <Pill active={trEvMetric==='utilization'} onClick={()=>setTrEvMetric('utilization')}>Util %</Pill>
                </div>
              </div>
              <div style={{display:'flex',gap:8}}>
                <div style={{flex:1}}>
                  <CJChart type="bar" height={180} cacheKey={`trev-c|${[...trScenarios].sort().join(',')}|${trEvMetric}|${theme}|${[...hiddenMap['trev-c']||[]].join(',')}`} data={{labels:tradeEvData.labels,datasets:tradeEvData.datasets.filter(d=>!isHidden('trev-c',d.label.includes(' — ')?d.label.split(' — ')[1]:d.label))}}
                    options={{...cjDefaults(t),scales:{x:{stacked:trEvMetric!=='utilization',grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},maxTicksLimit:10}},y:{stacked:trEvMetric!=='utilization',grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:unit,color:t.muted,font:{size:7}}}},plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>`${ctx.dataset.label}: ${fmt(ctx.parsed.y)} ${unit}`}}}}}/>
                </div>
                <div style={{width:80,flexShrink:0,display:'flex',flexDirection:'column',gap:2,paddingTop:4,maxHeight:180,overflowY:'auto'}}>
                  {allCorridors.slice(0,10).map((c,i)=>{const label=`${c.z}↔${c.z2}`;return<div key={label} onClick={()=>toggleHidden('trev-c',label)} style={{display:'flex',alignItems:'center',gap:3,cursor:'pointer',opacity:isHidden('trev-c',label)?0.25:1}}><div style={{width:9,height:9,borderRadius:2,backgroundColor:hexA(MAP_PALETTE[i%MAP_PALETTE.length],0.82),flexShrink:0}}/><span style={{fontSize:'0.4rem',color:t.muted,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{label}</span></div>;})}
                  <div style={{fontSize:'0.38rem',color:t.lblMuted,marginTop:4,display:'flex',gap:6}}>
                    <span onClick={()=>setHiddenMap(p=>({...p,'trev-c':new Set(allCorridors.slice(0,10).map(c=>`${c.z}↔${c.z2}`))}))} style={{cursor:'pointer',textDecoration:'underline'}}>None</span>
                    <span onClick={()=>setHiddenMap(p=>({...p,'trev-c':new Set()}))} style={{cursor:'pointer',textDecoration:'underline'}}>All</span>
                  </div>
                </div>
              </div>
            </>})()}
            {scenarioList.length>1&&(
              <div style={{borderTop:`1px solid ${hexA(t.panelBorder,0.4)}`,paddingTop:10,marginTop:2,display:'flex',flexDirection:'column',gap:8}}>
                <div style={{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}}>
                  <span style={{fontSize:'0.47rem',letterSpacing:'2px',fontWeight:700,color:t.lblMuted,textTransform:'uppercase'}}>Δ vs ref:</span>
                  <select value={cmpRef||''} onChange={e=>{setCmpRef(e.target.value);setCmpScenarios(new Set(scenarioList.filter(s=>s!==e.target.value)));}} style={selectStyle}>{scenarioList.map(s=><option key={s} value={s}>{s}</option>)}</select>
                  {scenarioList.filter(s=>s!==cmpRef).map(s=><Pill key={s} active={cmpScenarios.has(s)} onClick={()=>setCmpScenarios(prev=>{const n=new Set(prev);n.has(s)?n.delete(s):n.add(s);return n;})}>{s}</Pill>)}
                </div>
                {tradeCmpDeltaData&&tradeCmpDeltaData.datasets.length>0?
                  <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                    <div style={{flex:1,minWidth:0}}>
                      <CJChart type="bar" height={200}
                        cacheKey={`trev-c-d|${[...trScenarios].sort().join(',')}|${cmpRef}|${[...cmpScenarios].sort().join(',')}|${trEvMetric}|${theme}|${[...hiddenMap['trev-c']||[]].join(',')}`}
                        data={{labels:tradeCmpDeltaData.labels,datasets:tradeCmpDeltaData.datasets}}
                        options={{...cjDefaults(t),scales:{x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},maxTicksLimit:10}},y:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:`Δ${tradeCmpDeltaData.unit||'GWh'}`,color:t.muted,font:{size:7}}}},plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false,callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.raw>0?'+':''}${ctx.raw?.toLocaleString?.()}`}}}}}
                      />
                    </div>
                    {(()=>{const allCorridors=tradeEvData?.corridors||[];return makeLegend('trev-c',allCorridors.slice(0,10).map((c,i)=>({label:`${c.z}↔${c.z2}`,color:hexA(MAP_PALETTE[i%MAP_PALETTE.length],0.82)})));})()}
                  </div>
                :<div style={{fontSize:'0.55rem',color:t.lblMuted}}>{[...cmpScenarios].filter(s=>s!==cmpRef&&resultsData[s]).length>0?'No corridor differences found.':'Select at least one scenario to compare.'}</div>}
              </div>
            )}
          </div>
        )}

        {/* ── PLANTS ── */}
        {hasData&&activeTab==='plants'&&(
          <div style={{display:'flex',flexDirection:'column',gap:14}}>
            <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
              <select value={refYear||''} onChange={e=>setRefYear(e.target.value)} style={selectStyle}>{allYears.map(y=><option key={y} value={y}>{y}</option>)}</select>
              <select value={plScenario||''} onChange={e=>setPlScenario(e.target.value)} style={selectStyle}>{scenarioList.map(s=><option key={s} value={s}>{s}</option>)}</select>
              <select value={plIndicator} onChange={e=>setPlIndicator(e.target.value)} style={selectStyle}>{['CapacityPlant','EnergyPlant','CostsPlant','PlantAnnualLCOE','UtilizationPlant'].map(k=><option key={k} value={k}>{k.replace('Plant','').replace(/([A-Z])/g,' $1').trim()}</option>)}</select>
              <select value={plTopN} onChange={e=>setPlTopN(+e.target.value)} style={selectStyle}>{[10,15,20,30].map(n=><option key={n} value={n}>Top {n}</option>)}</select>
              {allZones.length>1&&<select value={plZone} onChange={e=>setPlZone(e.target.value)} style={selectStyle}><option value="all">All zones</option>{allZones.map(z=><option key={z} value={z}>{z}</option>)}</select>}
            </div>
            {plantsData.length>0?<><SectionTitle t={t}>Top {plTopN} plants</SectionTitle><CJChart type="bar" height={Math.min(plantsData.length*18+24,250)} cacheKey={`pl-c|${plScenario}|${refYear}|${plIndicator}|${plTopN}|${theme}`} data={{labels:plantsData.map(p=>p.g),datasets:[{data:plantsData.map(p=>+p.value.toFixed(2)),backgroundColor:plantsData.map(p=>hexA(techColor(p.techfuel),0.8)),borderWidth:0,barThickness:12}]}} options={{...cjDefaults(t),indexAxis:'y',scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}},y:{grid:{display:false},ticks:{color:t.muted,font:{size:7}}}}}}/></>:<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>No plant data.</div>}
            {lcoeData&&lcoeData.datasets.length>0&&<>
              <SectionTitle t={t}>LCOE vs Utilization — bubble = capacity</SectionTitle>
              <div style={{display:'flex',gap:6,alignItems:'flex-start'}}>
                <div style={{flex:1,minWidth:0}}>
                  <CJChart type="bubble" height={230} cacheKey={`lcoe-c|${plScenario}|${refYear}|${theme}|${[...hiddenMap['lcoe-c']||[]].join(',')}`}
                    data={{...lcoeData,datasets:lcoeData.datasets.filter(ds=>!isHidden('lcoe-c',ds.label))}}
                    options={{...cjDefaults(t),plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>{const d=ctx.raw;return[`${d._plant||ctx.dataset.label}`,`LCOE: ${d.y} $/MWh · Util: ${d.x.toFixed(0)}%`,d._cap?`Cap: ${fmt(d._cap)} MW`:''].filter(Boolean);}}}},scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}},title:{display:true,text:'Utilization (%)',color:t.muted,font:{size:8}},min:0,max:105},y:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}},title:{display:true,text:'LCOE (USD/MWh)',color:t.muted,font:{size:8}},min:0}}}}/>
                </div>
                {makeLegend('lcoe-c',lcoeData.datasets.map(ds=>({label:ds.label,color:ds.backgroundColor,shape:'circle'})))}
              </div>
            </>}
          </div>
        )}
      </div>
    </div>
  );
}
