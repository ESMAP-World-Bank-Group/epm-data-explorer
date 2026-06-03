import { useEffect, useRef, useState, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import { useTheme } from '../App';
import { getT, mapStyle } from '../constants';
import {
  fetchEpmCSV, fetchZonesGeoJSON, fetchLinestringGeoJSON, fetchGitHubDir, fetchResultCSV,
  processTechFuel, processYearlyZone, processDispatchResults, processHourlyPrice,
  processHours, processTransmissionResults, processPlants, processCosts,
  computeCentroid, normalizeFuel, EPM_FUEL_COLORS, resultYears,
} from '../utils/epmFetch';

// ── Constants / helpers (shared with RegionPage) ──────────────────────────────

const MAP_PALETTE = ['#1B6CA8','#36B5B5','#E8C547','#4DA6FF','#4169E1','#85C1E9','#2E9EC8','#5EBCBA','#1A5276','#7EC8E3','#14A094','#4CAFE8','#EDD770','#AED6F1','#1F618D','#0A6B70'];
const TECHFUEL_COLORS = { Nuclear:'#C8A8F0',Coal:'#808890',Gas:'#9A7040',CCGT:'#B8921A',OCGT:'#C4A820',Diesel:'#6A7888',HFO:'#7A7068',Oil:'#7A7068',Biomass:'#52C860',Waste:'#8A9098',Geothermal:'#D4A820',Reservoir:'#1E9AF5',ROR:'#5DADE2',ReservoirHydro:'#1E9AF5',PSH:'#0D7680',Solar:'#FFD700',PV:'#FFD700',CSP:'#E8C547',RPV:'#FFD700','Onshore Wind':'#44DAEC',OnshoreWind:'#44DAEC','Offshore Wind':'#7CC8FA',OffshoreWind:'#7CC8FA',Battery:'#A3D5FF',Storage:'#AED6F1',ICE:'#6A7888',ST:'#C8A8F0' };
function techColor(tf) { return TECHFUEL_COLORS[tf]||EPM_FUEL_COLORS[normalizeFuel(tf)]||'#AAAAAA'; }
function fmt(n,d=0){if(n==null||isNaN(n))return'—';return n.toLocaleString('en-US',{maximumFractionDigits:d});}
function fmtBig(n){if(!n)return'—';const a=Math.abs(n);if(a>=1e3)return`${(n/1e3).toFixed(1)}k`;return n.toFixed(1);}
function hexA(hex,a){if(!hex||hex.length<7)return`rgba(128,128,128,${a})`;const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);return`rgba(${r},${g},${b},${a})`;}
function cjDefaults(t){return{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{backgroundColor:t.panel,borderColor:t.panelBorder,borderWidth:1,titleColor:t.lbl,bodyColor:t.muted,titleFont:{size:9},bodyFont:{size:9},padding:6}},scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}}},y:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}}}}};}
function priceColor(t_){if(t_<0.5){const s=t_*2;return`rgb(${Math.round(68+s*(232-68))},${Math.round(218+s*(195-218))},${Math.round(238+s*(71-238))})`;}const s=(t_-0.5)*2;return`rgb(${Math.round(232+s*(229-232))},${Math.round(195+s*(57-195))},${Math.round(71+s*(53-71))})`}

const INDICATORS=[
  {key:'CapacityTechFuel',label:'Capacity (MW)',source:'techFuel',unit:'MW'},
  {key:'EnergyTechFuelComplete',label:'Energy (GWh)',source:'techFuel',unit:'GWh'},
  {key:'NewCapacityTechFuel',label:'New Capacity (MW)',source:'techFuel',unit:'MW'},
  {key:'NewCapacityTechFuelCumulated',label:'Cum. New Cap (MW)',source:'techFuel',unit:'MW'},
  {key:'Costs',label:'Costs total (m USD)',source:'yearlyZone',unit:'m USD'},
  {key:'CapexInvestmentComponent',label:'CAPEX (m USD)',source:'yearlyZone',unit:'m USD'},
  {key:'GenCostsPerMWh',label:'Gen Cost (USD/MWh)',source:'yearlyZone',unit:'USD/MWh'},
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

  const isDrRef = useRef(false); const drStartX = useRef(0); const drStartW = useRef(0);
  const toggleHidden=(id,label)=>setHiddenMap(p=>{const s=new Set(p[id]||[]);s.has(label)?s.delete(label):s.add(label);return{...p,[id]:s};});
  const isHidden=(id,label)=>hiddenMap[id]?.has(label)||false;

  useEffect(()=>{resultsDataRef.current=resultsData;},[resultsData]);
  useEffect(()=>{refYearRef.current=refYear;},[refYear]);
  useEffect(()=>{ovScenarioRef.current=ovScenario;},[ovScenario]);
  useEffect(()=>{hoursDataRef.current=hoursData;},[hoursData]);

  useEffect(()=>{fetch('/data/regions.json').then(r=>r.json()).then(d=>{const r=(d.regions||[]).find(r=>r.id===regionId);setRegion(r||null);});},[regionId]);

  useEffect(()=>{
    if(!region?.epm)return;
    const{branch,dataFolder}=region.epm;
    Promise.all([fetchEpmCSV(branch,dataFolder,'zcmap.csv'),fetchZonesGeoJSON(branch,dataFolder),fetchLinestringGeoJSON(branch,dataFolder),fetchEpmCSV(branch,dataFolder,'pHours.csv')]).then(([zc,zGJ,lGJ,hr])=>{
      setZcmapRows(zc||[]);setZonesGJ(zGJ);setLinestringGJ(lGJ);if(hr)setHoursData(processHours(hr));
    });
  },[region]);

  useEffect(()=>{if(!region?.epm)return;setLoadingRuns(true);fetchGitHubDir(region.epm.branch,'epm/output').then(items=>{const runs=(items||[]).filter(i=>i.type==='dir').map(i=>i.name).sort().reverse();setRunList(runs);if(runs.length)setSimRun(runs[0]);}).finally(()=>setLoadingRuns(false));},[region]);
  useEffect(()=>{if(!region?.epm||!simRun)return;fetchGitHubDir(region.epm.branch,`epm/output/${simRun}`).then(items=>{const s=(items||[]).filter(i=>i.type==='dir').map(i=>i.name).sort();setScenarioList(s);setEvScenarios(new Set(s));if(s.length){setOvScenario(s[0]);setDispScenario(s[0]);setTrScenario(s[0]);setPlScenario(s[0]);}});},[region,simRun]);

  useEffect(()=>{
    if(!region?.epm||!simRun||!scenarioList.length)return;
    setLoadingData(true);const{branch}=region.epm;
    Promise.all(scenarioList.map(async scen=>{
      const[tf,yz,dp,pr,tx,pl,co]=await Promise.all([fetchResultCSV(branch,simRun,scen,'pTechFuelMerged.csv'),fetchResultCSV(branch,simRun,scen,'pYearlyZoneMerged.csv'),fetchResultCSV(branch,simRun,scen,'pDispatchComplete.csv'),fetchResultCSV(branch,simRun,scen,'pHourlyPrice.csv'),fetchResultCSV(branch,simRun,scen,'pTransmissionMerged.csv'),fetchResultCSV(branch,simRun,scen,'pPlantMerged.csv'),fetchResultCSV(branch,simRun,scen,'pCostsMerged.csv')]);
      return{scen,techFuel:tf?processTechFuel(tf):{},yearlyZone:yz?processYearlyZone(yz):{},dispatch:dp?processDispatchResults(dp):{},price:pr?processHourlyPrice(pr):{},transmission:tx?processTransmissionResults(tx):{},plants:pl?processPlants(pl):[],costs:co?processCosts(co):{}};
    })).then(res=>{const rd=Object.fromEntries(res.map(r=>[r.scen,r]));setResultsData(rd);const yrs=resultYears(res[0]?.techFuel||{});if(yrs.length)setRefYear(yrs[0]);}).finally(()=>setLoadingData(false));
  },[region,simRun,scenarioList]); // eslint-disable-line

  // Derived
  const zoneToCountry = useMemo(()=>Object.fromEntries(zcmapRows.map(r=>[r.z,r.c])),[zcmapRows]);
  const countryZoneIds = useMemo(()=>zcmapRows.filter(r=>r.c===countryDecoded).map(r=>r.z),[zcmapRows,countryDecoded]);
  const countryIsos = useMemo(()=>zonesGJ?[...new Set(zonesGJ.features.filter(f=>countryZoneIds.includes(f.properties.z)).map(f=>f.properties.ISO_A3))]:[]  ,[zonesGJ,countryZoneIds]);
  const allZones = countryZoneIds;
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
  const priceVals=Object.values(zoneAvgPrices);
  const minP=priceVals.length?Math.min(...priceVals):0,maxP=priceVals.length?Math.max(...priceVals):100,rngP=maxP-minP||1;

  // ── Map ───────────────────────────────────────────────────────────────────────
  useEffect(()=>{
    if(!containerRef.current||!region||!zonesGJ)return;
    const regionCountries=[...new Set(zcmapRows.map(r=>r.c))].sort();
    const colorMap={};regionCountries.forEach((c,i)=>{colorMap[c]=MAP_PALETTE[i%MAP_PALETTE.length];});
    const zoneCentroids={};for(const f of zonesGJ.features){const z=f.properties.z;if(z){const c=computeCentroid(f.geometry);if(c)zoneCentroids[z]=c;}}
    const cCoords=countryZoneIds.flatMap(z=>zoneCentroids[z]?[zoneCentroids[z]]:[]);
    const lons=cCoords.map(c=>c[0]),lats=cCoords.map(c=>c[1]);
    const bounds=lons.length?[[Math.min(...lons)-1.5,Math.min(...lats)-1.5],[Math.max(...lons)+1.5,Math.max(...lats)+1.5]]:null;
    const map=new maplibregl.Map({container:containerRef.current,style:mapStyle(theme),center:[lons.length?lons.reduce((a,b)=>a+b,0)/lons.length:20,lats.length?lats.reduce((a,b)=>a+b,0)/lats.length:0],zoom:4,minZoom:1,maxZoom:14,attributionControl:false});
    mapRef.current=map;
    const popup=new maplibregl.Popup({closeButton:false,closeOnClick:false,offset:10,className:`popup-${theme}`});
    map.on('load',async()=>{
      const tv=getT(theme);
      if(bounds)map.fitBounds(bounds,{padding:60,duration:0,maxZoom:9});
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
      map.on('click','zone-fill',e=>{navigate(`/region/${regionId}/results/zone/${encodeURIComponent(e.features[0].properties.z||'')}`);});
      setMapLoadedCount(c=>c+1);
    });
    return()=>{popup.remove();dotMarkersRef.current.forEach(m=>m.remove());dotMarkersRef.current=[];mapRef.current?.remove();};
  },[region,theme,zonesGJ,zcmapRows,countryZoneIds,countryIsos]); // eslint-disable-line

  // Update NTC
  useEffect(()=>{
    const map=mapRef.current;if(!map||!map.getSource('ntc-results')||!refYear)return;
    const sd=resultsData[ovScenario]||Object.values(resultsData)[0];if(!sd)return;
    const tx=sd.transmission;const zoneCentroids={};if(zonesGJ)for(const f of zonesGJ.features){const z=f.properties.z;if(z){const c=computeCentroid(f.geometry);if(c)zoneCentroids[z]=c;}}
    const seen=new Set();const features=[];
    for(const[z,z2map]of Object.entries(tx)){for(const[z2,attrs]of Object.entries(z2map)){const key=[z,z2].sort().join('||');if(seen.has(key))continue;seen.add(key);
      if(!countryZoneIds.includes(z)&&!countryZoneIds.includes(z2))continue;
      const fwd=attrs.Interchange?.[refYear]||0;const rev=tx[z2]?.[z]?.Interchange?.[refYear]||0;const util=Math.min(1,Math.max(0,attrs.InterconUtilization?.[refYear]||tx[z2]?.[z]?.InterconUtilization?.[refYear]||0));const cap=attrs.TransmissionCapacity?.[refYear]||0;const vol=Math.abs(fwd)+Math.abs(rev);if(vol===0&&cap===0)continue;
      const lf=linestringGJ?.features?.find(f=>(f.properties.z===z&&(f.properties.z_other||f.properties.z2)===z2)||(f.properties.z===z2&&(f.properties.z_other||f.properties.z2)===z));
      let coords=lf?lf.geometry.coordinates:(zoneCentroids[z]&&zoneCentroids[z2]?[zoneCentroids[z],zoneCentroids[z2]]:null);if(!coords)continue;
      features.push({type:'Feature',properties:{z,z2,fwd,rev,util,vol,cap,yr:refYear},geometry:{type:'LineString',coordinates:fwd>=rev?coords:[...coords].reverse()}});
    }}
    map.getSource('ntc-results').setData({type:'FeatureCollection',features});
  },[resultsData,refYear,ovScenario,zonesGJ,linestringGJ,countryZoneIds,mapLoadedCount]); // eslint-disable-line

  // Price dots
  useEffect(()=>{
    const map=mapRef.current;if(!map||!refYear||!zonesGJ)return;
    dotMarkersRef.current.forEach(m=>m.remove());dotMarkersRef.current=[];
    const sd=resultsData[ovScenario]||Object.values(resultsData)[0];if(!sd)return;
    const tv=getT(theme);const zoneCentroids={};for(const f of zonesGJ.features){const z=f.properties.z;if(z){const c=computeCentroid(f.geometry);if(c)zoneCentroids[z]=c;}}
    const prices={};for(const z of allZones){const qmap=sd.price[z]?.[refYear]||{};let tw=0,tp=0;for(const[q,days]of Object.entries(qmap))for(const[d,hrs]of Object.entries(days)){const w=hoursData[q]?.[d]||0;for(const p of Object.values(hrs)){tp+=p*w;tw+=w;}}if(tw>0)prices[z]=tp/tw;}
    const vals=Object.values(prices);if(!vals.length)return;
    const minV=Math.min(...vals),maxV=Math.max(...vals),rng=maxV-minV||1;
    for(const[z,price]of Object.entries(prices)){const coord=zoneCentroids[z];if(!coord)continue;const el=document.createElement('div');el.style.cssText=`width:10px;height:10px;border-radius:50%;background:${priceColor((price-minV)/rng)};border:1.5px solid rgba(255,255,255,0.7);box-shadow:0 1px 4px rgba(0,0,0,0.4);cursor:pointer;`;el.title=`${z}: ${price.toFixed(1)} $/MWh`;dotMarkersRef.current.push(new maplibregl.Marker({element:el,anchor:'center'}).setLngLat(coord).addTo(map));}
  },[resultsData,refYear,ovScenario,zonesGJ,allZones,hoursData,theme,mapLoadedCount]); // eslint-disable-line

  if(!region)return<div style={{padding:40,color:t.text}}>Loading…</div>;
  const selectStyle={fontSize:'0.5rem',fontFamily:'inherit',padding:'2px 6px',borderRadius:3,border:`1px solid ${t.panelBorder}`,backgroundColor:t.panel,color:t.muted,cursor:'pointer'};
  const TABS=['overview','evolution','dispatch','trade','plants'];

  // ── Builders ──────────────────────────────────────────────────────────────────
  const buildMix=()=>{const sd=resultsData[ovScenario];if(!sd||!refYear)return null;const zones=allZones.filter(z=>sd.techFuel[z]?.CapacityTechFuel?.[refYear]);if(!zones.length)return null;const tfs=allTechfuels.filter(tf=>zones.some(z=>(sd.techFuel[z]?.CapacityTechFuel?.[refYear]?.[tf]||0)>0));return{labels:zones,datasets:tfs.filter(tf=>!isHidden('mix-c',tf)).map(tf=>({label:tf,data:zones.map(z=>Math.round(sd.techFuel[z]?.CapacityTechFuel?.[refYear]?.[tf]||0)),backgroundColor:techColor(tf),borderWidth:0,barThickness:14,stack:'a'}))};};

  const buildEvolution=()=>{const activeSc=scenarioList.filter(s=>evScenarios.has(s));if(!activeSc.length||!allYears.length)return null;const ind=activeInd;if(ind.source==='yearlyZone')return{labels:allYears,datasets:activeSc.map((s,i)=>({label:s,data:allYears.map(y=>+allZones.reduce((acc,z)=>acc+(resultsData[s]?.yearlyZone[z]?.[ind.key]?.[y]||0),0).toFixed(2)),backgroundColor:hexA(['#3B82F6','#10B981','#F59E0B','#8B5CF6'][i%4],0.75),borderColor:['#3B82F6','#10B981','#F59E0B','#8B5CF6'][i%4],borderWidth:2,fill:false,tension:0.3,type:'line'}))};const tfs=allTechfuels.filter(tf=>!isHidden('ev-c',tf));const datasets=[];for(const scen of activeSc)for(const tf of tfs){datasets.push({label:`${scen} — ${tf}`,data:allYears.map(y=>Math.round(allZones.reduce((s,z)=>s+(resultsData[scen]?.techFuel[z]?.[ind.key]?.[y]?.[tf]||0),0))),backgroundColor:hexA(techColor(tf),activeSc.length>1?0.5:0.85),borderColor:techColor(tf),borderWidth:activeSc.length>1?1:0,stack:scen});}return{labels:allYears,datasets};};

  const buildDispatch=()=>{const sd=resultsData[dispScenario];if(!sd||!activeDispZone||!refYear)return{chartData:{labels:[],datasets:[]},plugin:null};const zDisp=getZoneDisp(sd,activeDispZone,refYear);const isDark=t.isDark;const seasons=dispAvailS,days=dispAvailD;if(dispMode==='full'&&seasons.length&&days.length){const nS=seasons.length,nDT=days.length,nPts=nS*nDT*24;const tfs=[...new Set(seasons.flatMap(q=>days.flatMap(d=>Object.values(zDisp[q]?.[d]||{}).flatMap(Object.keys))))].filter(t=>t!=='Demand').sort();const datasets=tfs.map(tf=>({label:tf,fill:true,data:seasons.flatMap(s=>days.flatMap(d=>Array.from({length:24},(_,h)=>zDisp[s]?.[d]?.[`t${h+1}`]?.[tf]||0))),backgroundColor:hexA(techColor(tf),0.7),borderColor:techColor(tf),borderWidth:0,pointRadius:0,tension:0,stack:'gen'}));const zP=sd.price[activeDispZone]?.[refYear]||{};const pd=seasons.flatMap(s=>days.flatMap(d=>Array.from({length:24},(_,h)=>zP[s]?.[d]?.[`t${h+1}`]||null)));if(pd.some(v=>v!=null))datasets.push({label:'Marginal cost',type:'line',data:pd,yAxisID:'yR',borderColor:'#3B82F6',borderWidth:1.5,pointRadius:0,tension:0,fill:false,spanGaps:true,order:1});const dem=seasons.flatMap(s=>days.flatMap(d=>Array.from({length:24},(_,h)=>{const v=getDispDemand(sd,activeDispZone,allZones,refYear,s,d,h);return v!=null&&v>0?v:null;})));if(dem.some(v=>v!=null))datasets.push({label:'Demand',type:'line',data:dem,borderColor:'#8B0000',borderWidth:1,pointRadius:0,tension:0,fill:false,spanGaps:true,stack:'demand',order:1});const sepPlugin={id:'cSep',afterDatasetsDraw:(chart)=>{if(dem.some(v=>v!=null)){const{ctx,chartArea:ca,scales:sc}=chart;if(ca&&sc.y){ctx.save();ctx.beginPath();ctx.strokeStyle='#CC0000';ctx.lineWidth=1.5;ctx.setLineDash([]);let mv=false;dem.forEach((v,i)=>{if(v==null){mv=false;return;}const x=sc.x.getPixelForValue(i);const y=sc.y.getPixelForValue(v);mv?ctx.lineTo(x,y):ctx.moveTo(x,y);mv=true;});ctx.stroke();ctx.restore();}}},afterDraw:(chart)=>{const{ctx,chartArea,scales}=chart;if(!chartArea||!scales.x)return;const{top,bottom}=chartArea;const xS=scales.x;const dC=isDark?'rgba(255,255,255,0.13)':'rgba(0,0,0,0.12)';const sC=isDark?'rgba(255,255,255,0.36)':'rgba(0,0,0,0.30)';const tC=isDark?'rgba(255,255,255,0.46)':'rgba(0,0,0,0.40)';const seC=isDark?'rgba(255,255,255,0.70)':'rgba(0,0,0,0.58)';for(let si=0;si<nS;si++){const ss=si*nDT*24;ctx.save();ctx.font='700 9px system-ui,sans-serif';ctx.fillStyle=seC;ctx.textAlign='center';ctx.textBaseline='bottom';ctx.fillText(seasons[si],xS.getPixelForValue(ss+nDT*12),top-2);ctx.restore();for(let di=0;di<nDT;di++){const dts=ss+di*24;if(dts>0){const lx=xS.getPixelForValue(dts);const isS=di===0;ctx.save();ctx.strokeStyle=isS?sC:dC;ctx.lineWidth=isS?1.2:0.7;if(!isS)ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(lx,top);ctx.lineTo(lx,bottom);ctx.stroke();ctx.restore();}const midX=xS.getPixelForValue(dts+12);const w=hoursData?.[seasons[si]]?.[days[di]]||0;const pct=w>0?` (${((w/totalDays)*100).toFixed(0)}%)`:'';ctx.save();ctx.translate(midX,bottom+3);ctx.rotate(-Math.PI/2);ctx.font='7px system-ui,sans-serif';ctx.fillStyle=tC;ctx.textAlign='right';ctx.textBaseline='middle';ctx.fillText(`${days[di]}${pct}`,0,0);ctx.restore();}}}};return{chartData:{labels:new Array(nPts).fill(''),datasets},plugin:sepPlugin};}
  const sp=zDisp[dispSeason];if(!sp)return{chartData:{labels:[],datasets:[]},plugin:null};const tfs2=[...new Set(Object.values(sp).flatMap(d=>Object.values(d).flatMap(Object.keys)))].filter(t=>t!=='Demand').sort();const getData=(tf)=>{if(dispDay==='avg'){const ds=Object.keys(sp);return Array.from({length:24},(_,h)=>ds.reduce((s,d)=>s+(sp[d]?.[`t${h+1}`]?.[tf]||0),0)/Math.max(ds.length,1));}return Array.from({length:24},(_,h)=>sp[dispDay]?.[`t${h+1}`]?.[tf]||0);};const datasets2=tfs2.map(tf=>({label:tf,fill:true,data:getData(tf),backgroundColor:hexA(techColor(tf),0.7),borderColor:techColor(tf),borderWidth:0,pointRadius:0,tension:0,stack:'gen'}));const demL=dispAvailD.length>0?Array.from({length:24},(_,h)=>{const ds=dispDay==='avg'?dispAvailD:[dispDay];const vals=ds.map(d=>getDispDemand(sd,activeDispZone,allZones,refYear,dispSeason,d,h)).filter(v=>v!=null&&v>0);if(!vals.length)return null;return dispDay==='avg'?vals.reduce((a,b)=>a+b,0)/vals.length:vals[0];}):[];if(demL.some(v=>v))datasets2.push({label:'Demand',type:'line',data:demL,borderColor:'#8B0000',borderWidth:1,pointRadius:0,tension:0,fill:false,spanGaps:true,stack:'demand',order:1});const prL=Array.from({length:24},(_,h)=>{const d=dispDay==='avg'?Object.keys(sp)[0]:dispDay;return sd.price[activeDispZone]?.[refYear]?.[dispSeason]?.[d]?.[`t${h+1}`]||null;});if(prL.some(v=>v!=null))datasets2.push({label:'Marginal cost',type:'line',data:prL,yAxisID:'yR',borderColor:'#3B82F6',borderWidth:1.5,pointRadius:0,tension:0,fill:false,spanGaps:true,order:1});const demPlugin=demL.some(v=>v)?{id:'demS',afterDatasetsDraw:(chart)=>{const{ctx,chartArea:ca,scales:sc}=chart;if(!ca||!sc.y)return;ctx.save();ctx.beginPath();ctx.strokeStyle='#CC0000';ctx.lineWidth=1.5;ctx.setLineDash([]);let mv=false;demL.forEach((v,i)=>{if(v==null){mv=false;return;}const x=sc.x.getPixelForValue(i);const y=sc.y.getPixelForValue(v);mv?ctx.lineTo(x,y):ctx.moveTo(x,y);mv=true;});ctx.stroke();ctx.restore();}}:null;return{chartData:{labels:Array.from({length:24},(_,i)=>`${i+1}h`),datasets:datasets2},plugin:demPlugin};};

  const buildTrade=()=>{const tx=resultsData[trScenario]?.transmission||{};if(!refYear)return null;const imp={},exp={};for(const z of allZones){imp[z]=0;exp[z]=0;for(const[z2,attrs]of Object.entries(tx[z]||{}))exp[z]+=(attrs.Interchange?.[refYear]||0);for(const[z2,zm]of Object.entries(tx))if(z2!==z)imp[z]+=(zm[z]?.Interchange?.[refYear]||0);}const zones=allZones.filter(z=>imp[z]+exp[z]>0.5).sort((a,b)=>(imp[b]-exp[b])-(imp[a]-exp[a]));if(!zones.length)return null;const net=Object.fromEntries(zones.map(z=>[z,+(imp[z]-exp[z]).toFixed(1)]));return{labels:zones,datasets:[!isHidden('trade-c','Imports')&&{label:'Imports',data:zones.map(z=>+imp[z].toFixed(1)),backgroundColor:hexA('#2E9EC8',0.78),borderWidth:0,barThickness:12,stack:'t'},!isHidden('trade-c','Exports')&&{label:'Exports',data:zones.map(z=>+(-exp[z]).toFixed(1)),backgroundColor:hexA('#E8C547',0.78),borderWidth:0,barThickness:12,stack:'t'},{label:'Net',data:zones.map(z=>net[z]),backgroundColor:'rgba(255,255,255,0.92)',borderWidth:0,barThickness:3,order:0}].filter(Boolean),_imp:imp,_exp:exp,_net:net};};

  const buildTradeEv=()=>{const tx0=resultsData[trScenario]?.transmission||{};if(!allYears.length)return null;const corridors=[];const seen=new Set();for(const[z,zm]of Object.entries(tx0))for(const z2 of Object.keys(zm)){if(!allZones.includes(z)&&!allZones.includes(z2))continue;const k=[z,z2].sort().join('||');if(!seen.has(k)){seen.add(k);corridors.push({z,z2,key:k});}}if(!corridors.length)return null;const attr=trEvMetric==='volume'?'Interchange':trEvMetric==='capacity'?'TransmissionCapacity':'InterconUtilization';const unit=trEvMetric==='volume'?'GWh':trEvMetric==='capacity'?'MW':'%';return{labels:allYears,corridors,unit,datasets:corridors.slice(0,10).map((c,i)=>({label:`${c.z}↔${c.z2}`,data:allYears.map(y=>{const tx=resultsData[trScenario]?.transmission||{};const fwd=tx[c.z]?.[c.z2]?.[attr]?.[y]||0;const rev=tx[c.z2]?.[c.z]?.[attr]?.[y]||0;return trEvMetric==='utilization'?+(((fwd+rev)/2)*100).toFixed(1):+(Math.abs(fwd)+Math.abs(rev)).toFixed(1);}),backgroundColor:hexA(MAP_PALETTE[i%MAP_PALETTE.length],isHidden('trev-c',`${c.z}↔${c.z2}`)?0.05:0.82),borderColor:MAP_PALETTE[i%MAP_PALETTE.length],borderWidth:trEvMetric==='utilization'?2:0,type:trEvMetric==='utilization'?'line':'bar',fill:false,tension:0.3,pointRadius:trEvMetric==='utilization'?2:0,stack:trEvMetric==='utilization'?undefined:'a'}))};};

  const buildPlants=()=>(resultsData[plScenario]?.plants||[]).filter(p=>p.attribute===plIndicator&&p.y===refYear&&p.value>0&&allZones.includes(p.z)).sort((a,b)=>b.value-a.value).slice(0,plTopN);
  const buildLCOE=()=>{const pl=resultsData[plScenario]?.plants||[];if(!refYear)return null;const byG={};for(const p of pl.filter(pp=>pp.y===refYear&&allZones.includes(pp.z))){if(!byG[p.g])byG[p.g]={techfuel:p.techfuel,z:p.z};byG[p.g][p.attribute]=p.value;}const points=Object.entries(byG).map(([g,d])=>({g,techfuel:d.techfuel||'',lcoe:d.PlantAnnualLCOE||0,util:(d.UtilizationPlant||0)*100,cap:d.CapacityPlant||0})).filter(p=>p.lcoe>0&&p.util>0&&p.cap>0);const tfs=[...new Set(points.map(p=>p.techfuel))].sort();return{datasets:tfs.map(tf=>({label:tf,data:points.filter(p=>p.techfuel===tf).map(p=>({x:+p.util.toFixed(1),y:+p.lcoe.toFixed(1),r:Math.min(Math.max(Math.sqrt(p.cap)*0.6,3),20),_plant:p.g,_cap:p.cap})),backgroundColor:hexA(techColor(tf),0.65),borderColor:techColor(tf),borderWidth:1})).filter(d=>d.data.length>0)};};

  const mixData=buildMix(),evData=buildEvolution(),dispResult=buildDispatch(),tradeData=buildTrade(),tradeEvData=buildTradeEv(),plantsData=buildPlants(),lcoeData=buildLCOE();
  const dispTechs=dispResult.chartData.datasets.filter(d=>d.label!=='Marginal cost'&&d.label!=='Demand').map(d=>d.label);

  // ── JSX ───────────────────────────────────────────────────────────────────────
  return (
    <div style={{display:'flex',height:'calc(100vh - 46px)'}}
      onMouseMove={e=>{if(!isDrRef.current)return;setPanelWidth(w=>Math.max(380,Math.min(760,drStartW.current+(drStartX.current-e.clientX))));}}
      onMouseUp={()=>{isDrRef.current=false;}} onMouseLeave={()=>{isDrRef.current=false;}}
    >
      <div style={{position:'relative',flex:1}}>
        <div ref={containerRef} style={{width:'100%',height:'100%',backgroundColor:t.bg}}/>
        <div style={{position:'absolute',top:10,left:10,zIndex:10,display:'flex',gap:4,alignItems:'center',fontSize:'0.52rem',color:t.text,backgroundColor:t.panel,border:`1px solid ${t.panelBorder}`,borderRadius:5,padding:'4px 10px',boxShadow:'0 1px 4px rgba(0,0,0,.18)'}}>
          <Link to="/" style={{color:t.lblMuted,textDecoration:'none'}}>World</Link><span style={{color:t.lblMuted}}>›</span>
          <Link to={`/region/${regionId}/results`} style={{color:t.lblMuted,textDecoration:'none'}}>{region.name} · Results</Link>
          <span style={{color:t.lblMuted}}>›</span><span style={{color:t.lbl,fontWeight:600}}>{countryDecoded}</span>
        </div>
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
              <CJChart type="bar" height={Math.min(mixData.labels.length*22+24,260)} cacheKey={`mix-c|${ovScenario}|${refYear}|${[...hiddenMap['mix-c']||[]].join(',')}`} data={mixData} options={{...cjDefaults(t),indexAxis:'y',scales:{x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}},y:{stacked:true,grid:{display:false},ticks:{color:t.muted,font:{size:8}}}},plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>`${ctx.dataset.label}: ${fmt(ctx.parsed.x)} MW`}}}}}/>
              <div style={{display:'flex',flexWrap:'wrap',gap:'3px 8px',marginTop:5}}>{allTechfuels.map(tf=><div key={tf} onClick={()=>toggleHidden('mix-c',tf)} style={{display:'flex',alignItems:'center',gap:3,fontSize:'0.43rem',color:t.muted,cursor:'pointer',opacity:isHidden('mix-c',tf)?0.28:1}}><div style={{width:8,height:8,borderRadius:2,backgroundColor:techColor(tf)}}/>{tf}</div>)}</div>
            </div>}
            {Object.keys(zoneAvgPrices).length>0&&<div>
              <SectionTitle t={t}>Avg marginal price by zone ($/MWh)</SectionTitle>
              <CJChart type="bar" height={Math.min(allZones.length*22+24,200)} cacheKey={`pz-c|${ovScenario}|${refYear}`} data={{labels:allZones.filter(z=>zoneAvgPrices[z]),datasets:[{data:allZones.filter(z=>zoneAvgPrices[z]).map(z=>+zoneAvgPrices[z].toFixed(1)),backgroundColor:allZones.filter(z=>zoneAvgPrices[z]).map(z=>hexA(`rgb(${Math.round(68+((zoneAvgPrices[z]-minP)/rngP)*(232-68))},${Math.round(218+((zoneAvgPrices[z]-minP)/rngP)*(195-218))},${Math.round(238+((zoneAvgPrices[z]-minP)/rngP)*(71-238))})`,0.92)),borderWidth:0,barThickness:12}]}} options={{...cjDefaults(t),indexAxis:'y',scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}}},y:{grid:{display:false},ticks:{color:t.muted,font:{size:8}}}}}}/>
              {priceVals.length>0&&<div style={{display:'flex',gap:12,marginTop:4,fontSize:'0.44rem',color:t.muted}}><span>Avg: <b style={{color:t.lbl}}>{(priceVals.reduce((a,b)=>a+b,0)/priceVals.length).toFixed(1)} $/MWh</b></span><span>Min: <b style={{color:t.lbl}}>{minP.toFixed(1)}</b></span><span>Max: <b style={{color:t.lbl}}>{maxP.toFixed(1)}</b></span></div>}
            </div>}
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
            {evData?<>
              <CJChart type={activeInd.source==='yearlyZone'?'line':'bar'} height={200} cacheKey={`ev-c|${evIndicator}|${[...evScenarios].sort().join(',')}|${[...hiddenMap['ev-c']||[]].join(',')}`} data={evData} options={{...cjDefaults(t),scales:{x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},maxTicksLimit:10}},y:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:activeInd.unit,color:t.muted,font:{size:7}}}},plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>`${ctx.dataset.label}: ${fmt(ctx.parsed.y)}`}}}}}/>
              {activeInd.source==='techFuel'&&<div style={{display:'flex',flexWrap:'wrap',gap:'3px 8px',marginTop:2}}>{allTechfuels.map(tf=><div key={tf} onClick={()=>toggleHidden('ev-c',tf)} style={{display:'flex',alignItems:'center',gap:3,fontSize:'0.43rem',color:t.muted,cursor:'pointer',opacity:isHidden('ev-c',tf)?0.28:1}}><div style={{width:8,height:8,borderRadius:2,backgroundColor:techColor(tf)}}/>{tf}</div>)}</div>}
            </>:<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>Select at least one scenario.</div>}
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
            {dispResult.chartData.datasets.length>0?<>
              <CJChart type="line" height={dispMode==='full'?210:165} data={dispResult.chartData} plugins={dispResult.plugin?[dispResult.plugin]:[]} cacheKey={`disp-c|${dispScenario}|${activeDispZone}|${refYear}|${dispMode}|${dispSeason}|${dispDay}`}
                options={{...cjDefaults(t),layout:{padding:{top:dispMode==='full'?18:4,bottom:dispMode==='full'?62:4}},scales:{x:{grid:{color:hexA(t.panelBorder,0.35),drawTicks:false},ticks:{display:dispMode!=='full',color:t.muted,font:{size:7},maxTicksLimit:12}},y:{stacked:true,grid:{color:hexA(t.panelBorder,0.35)},ticks:{color:t.muted,font:{size:8}},title:{display:true,text:'MW',color:t.muted,font:{size:7}}},yR:{type:'linear',position:'right',display:dispResult.chartData.datasets.some(d=>d.label==='Marginal cost'),grid:{drawOnChartArea:false},ticks:{color:t.muted,font:{size:8}}}},plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false}}}}/>
              <div style={{display:'flex',flexWrap:'wrap',gap:'3px 8px',marginTop:2}}>
                {dispTechs.map(tf=><div key={tf} style={{display:'flex',alignItems:'center',gap:3,fontSize:'0.43rem',color:t.muted}}><div style={{width:8,height:8,borderRadius:2,backgroundColor:techColor(tf)}}/>{tf}</div>)}
                <div style={{display:'flex',alignItems:'center',gap:3,fontSize:'0.43rem',color:t.muted}}><div style={{width:12,height:2,backgroundColor:'#8B0000',borderRadius:1}}/><span>Demand</span></div>
                <div style={{display:'flex',alignItems:'center',gap:3,fontSize:'0.43rem',color:t.muted}}><div style={{width:12,height:2,backgroundColor:'#3B82F6',borderRadius:1}}/><span>Marginal cost</span></div>
              </div>
            </>:<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>No dispatch data.</div>}
          </div>
        )}

        {/* ── TRADE ── */}
        {hasData&&activeTab==='trade'&&(
          <div style={{display:'flex',flexDirection:'column',gap:14}}>
            <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
              <select value={refYear||''} onChange={e=>setRefYear(e.target.value)} style={selectStyle}>{allYears.map(y=><option key={y} value={y}>{y}</option>)}</select>
              <select value={trScenario||''} onChange={e=>setTrScenario(e.target.value)} style={selectStyle}>{scenarioList.map(s=><option key={s} value={s}>{s}</option>)}</select>
            </div>
            {tradeData&&tradeData.labels.length>0&&(()=>{const zones=tradeData.labels;return<>
              <SectionTitle t={t}>Imports (+) / Exports (−) by zone (GWh)</SectionTitle>
              <div style={{display:'flex',gap:8}}>
                <div style={{flex:1}}>
                  <CJChart type="bar" height={Math.min(zones.length*22+24,240)} cacheKey={`tr-c|${trScenario}|${refYear}|${[...hiddenMap['trade-c']||[]].join(',')}`} data={tradeData}
                    options={{...cjDefaults(t),indexAxis:'y',scales:{x:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}},y:{stacked:true,grid:{display:false},ticks:{color:t.muted,font:{size:8}}}},plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>ctx.dataset.label==='Net'?`Net: ${fmt(ctx.parsed.x)} GWh`:`${ctx.dataset.label}: ${fmt(Math.abs(ctx.parsed.x))} GWh`}}}}}/>
                </div>
                <div style={{width:68,flexShrink:0,display:'flex',flexDirection:'column',gap:4,paddingTop:4}}>
                  {[{l:'Imports',c:'#2E9EC8'},{l:'Exports',c:'#E8C547'}].map(({l,c})=><div key={l} onClick={()=>toggleHidden('trade-c',l)} style={{display:'flex',alignItems:'center',gap:4,cursor:'pointer',opacity:isHidden('trade-c',l)?0.25:1}}><div style={{width:10,height:10,borderRadius:2,backgroundColor:hexA(c,0.78),flexShrink:0}}/><span style={{fontSize:'0.43rem',color:t.muted}}>{l}</span></div>)}
                  <div style={{fontSize:'0.38rem',color:t.lblMuted,marginTop:4}}>click to hide</div>
                </div>
              </div>
            </>})()}
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
                  <CJChart type="bar" height={180} cacheKey={`trev-c|${trScenario}|${trEvMetric}|${[...hiddenMap['trev-c']||[]].join(',')}`} data={{labels:tradeEvData.labels,datasets:tradeEvData.datasets.filter(d=>!isHidden('trev-c',d.label)).map(d=>({...d,backgroundColor:hexA(MAP_PALETTE[allCorridors.findIndex(c=>`${c.z}↔${c.z2}`===d.label)%MAP_PALETTE.length],0.82)}))}}
                    options={{...cjDefaults(t),scales:{x:{stacked:trEvMetric!=='utilization',grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},maxTicksLimit:10}},y:{stacked:trEvMetric!=='utilization',grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v},title:{display:true,text:unit,color:t.muted,font:{size:7}}}},plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>`${ctx.dataset.label}: ${fmt(ctx.parsed.y)} ${unit}`}}}}}/>
                </div>
                <div style={{width:80,flexShrink:0,display:'flex',flexDirection:'column',gap:2,paddingTop:4,maxHeight:180,overflowY:'auto'}}>
                  {allCorridors.slice(0,10).map((c,i)=>{const label=`${c.z}↔${c.z2}`;return<div key={label} onClick={()=>toggleHidden('trev-c',label)} style={{display:'flex',alignItems:'center',gap:3,cursor:'pointer',opacity:isHidden('trev-c',label)?0.25:1}}><div style={{width:9,height:9,borderRadius:2,backgroundColor:hexA(MAP_PALETTE[i%MAP_PALETTE.length],0.82),flexShrink:0}}/><span style={{fontSize:'0.4rem',color:t.muted,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{label}</span></div>;})}
                  <div style={{fontSize:'0.38rem',color:t.lblMuted,marginTop:4}}>click to hide</div>
                </div>
              </div>
            </>})()}
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
            </div>
            {plantsData.length>0?<><SectionTitle t={t}>Top {plTopN} plants</SectionTitle><CJChart type="bar" height={Math.min(plantsData.length*18+24,250)} cacheKey={`pl-c|${plScenario}|${refYear}|${plIndicator}|${plTopN}`} data={{labels:plantsData.map(p=>p.g),datasets:[{data:plantsData.map(p=>+p.value.toFixed(2)),backgroundColor:plantsData.map(p=>hexA(techColor(p.techfuel),0.8)),borderWidth:0,barThickness:12}]}} options={{...cjDefaults(t),indexAxis:'y',scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}},y:{grid:{display:false},ticks:{color:t.muted,font:{size:7}}}}}}/></>:<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>No plant data.</div>}
            {lcoeData&&lcoeData.datasets.length>0&&<><SectionTitle t={t}>LCOE vs Utilization — bubble = capacity</SectionTitle><CJChart type="bubble" height={230} cacheKey={`lcoe-c|${plScenario}|${refYear}`} data={lcoeData} options={{...cjDefaults(t),plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>{const d=ctx.raw;return[`${d._plant||ctx.dataset.label}`,`LCOE: ${d.y} $/MWh · Util: ${d.x.toFixed(0)}%`,d._cap?`Cap: ${fmt(d._cap)} MW`:''].filter(Boolean);}}}},scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}},title:{display:true,text:'Utilization (%)',color:t.muted,font:{size:8}},min:0,max:105},y:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}},title:{display:true,text:'LCOE (USD/MWh)',color:t.muted,font:{size:8}},min:0}}}}/><div style={{display:'flex',flexWrap:'wrap',gap:'3px 8px',marginTop:4}}>{lcoeData.datasets.map(ds=><div key={ds.label} style={{display:'flex',alignItems:'center',gap:3,fontSize:'0.43rem',color:t.muted}}><div style={{width:8,height:8,borderRadius:'50%',backgroundColor:ds.backgroundColor}}/>{ds.label}</div>)}</div></>}
          </div>
        )}
      </div>
    </div>
  );
}
