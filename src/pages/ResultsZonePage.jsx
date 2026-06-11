import { useEffect, useRef, useState, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import { track } from '@vercel/analytics';
import { useTheme } from '../App';
import { getT, mapStyle } from '../constants';
import {
  fetchEpmCSV, fetchZonesGeoJSON, fetchLinestringGeoJSON, fetchGitHubDir, fetchResultCSV,
  processTechFuel, processYearlyZone, processDispatchResults, processHourlyPrice,
  processHours, processTransmissionResults, processPlants,
  computeCentroid, normalizeFuel, EPM_FUEL_COLORS, resultYears,
} from '../utils/epmFetch';

const MAP_PALETTE = ['#1B6CA8','#36B5B5','#E8C547','#4DA6FF','#4169E1','#85C1E9','#2E9EC8','#5EBCBA','#1A5276','#7EC8E3','#14A094','#4CAFE8','#EDD770','#AED6F1','#1F618D','#0A6B70'];
const TECHFUEL_COLORS = { Nuclear:'#C8A8F0',Coal:'#808890',Gas:'#9A7040',CCGT:'#B8921A',OCGT:'#C4A820',Diesel:'#6A7888',HFO:'#7A7068',Oil:'#7A7068',Biomass:'#52C860',Waste:'#8A9098',Geothermal:'#D4A820',Reservoir:'#1E9AF5',ROR:'#5DADE2',ReservoirHydro:'#1E9AF5',PSH:'#0D7680',Solar:'#FFD700',PV:'#FFD700',CSP:'#E8C547',RPV:'#FFD700','Onshore Wind':'#44DAEC',OnshoreWind:'#44DAEC','Offshore Wind':'#7CC8FA',OffshoreWind:'#7CC8FA',Battery:'#A3D5FF',Storage:'#AED6F1',ICE:'#6A7888',ST:'#C8A8F0' };
function techColor(tf){return TECHFUEL_COLORS[tf]||EPM_FUEL_COLORS[normalizeFuel(tf)]||'#AAAAAA';}
function fmt(n,d=0){if(n==null||isNaN(n))return'—';return n.toLocaleString('en-US',{maximumFractionDigits:d});}
function fmtBig(n){if(!n)return'—';const a=Math.abs(n);if(a>=1e3)return`${(n/1e3).toFixed(1)}k`;return n.toFixed(1);}
function hexA(hex,a){if(!hex||hex.length<7)return`rgba(128,128,128,${a})`;const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);return`rgba(${r},${g},${b},${a})`;}
function cjDefaults(t){return{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{backgroundColor:t.panel,borderColor:t.panelBorder,borderWidth:1,titleColor:t.lbl,bodyColor:t.muted,titleFont:{size:9},bodyFont:{size:9},padding:6}},scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}}},y:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}}}}};}

function CJChart({type,data,options,height,plugins:ep,cacheKey}){
  const ref=useRef(null);const chart=useRef(null);
  const sig=JSON.stringify({type,labels:data.labels,ck:cacheKey,ds:data.datasets?.map(d=>({l:d.label,n:d.data?.length,t:d.type}))});
  useEffect(()=>{const CJ=window.Chart;if(!CJ||!ref.current)return;chart.current?.destroy();chart.current=new CJ(ref.current,{type,data,options,plugins:ep||[]});return()=>{chart.current?.destroy();chart.current=null;};},[sig]); // eslint-disable-line
  return <div style={{height,width:'100%',position:'relative'}}><canvas ref={ref}/></div>;
}
function SectionTitle({t,children,right}){return<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}><div style={{fontSize:'0.47rem',letterSpacing:'2px',fontWeight:700,color:t.lblMuted,textTransform:'uppercase'}}>{children}</div>{right}</div>;}
function Pill({active,onClick,children}){return<button onClick={onClick} style={{fontSize:'0.44rem',fontFamily:'inherit',padding:'2px 7px',borderRadius:3,cursor:'pointer',border:`1px solid ${active?'rgba(74,143,204,0.65)':'rgba(128,160,192,0.2)'}`,backgroundColor:active?'rgba(74,143,204,0.12)':'transparent',color:active?'rgba(74,143,204,1)':'rgba(128,160,192,0.7)',fontWeight:active?600:400}}>{children}</button>;}

export default function ResultsZonePage() {
  const { regionId, zoneId } = useParams();
  const zoneIdDecoded = decodeURIComponent(zoneId);
  const { theme } = useTheme(); const t = getT(theme); const navigate = useNavigate();

  const containerRef = useRef(null); const mapRef = useRef(null); const markerRef = useRef(null);
  const hoursDataRef = useRef({});

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
  const [scenario,     setScenario]     = useState(null);
  const [dispMode,     setDispMode]     = useState('full');
  const [dispSeason,   setDispSeason]   = useState('Q1');
  const [dispDay,      setDispDay]      = useState('avg');
  const [plIndicator,  setPlIndicator]  = useState('CapacityPlant');
  const [plTopN,       setPlTopN]       = useState(15);
  const [mapLoadedCount, setMapLoadedCount] = useState(0);
  const [panelWidth,   setPanelWidth]   = useState(480);

  const isDrRef = useRef(false); const drStartX = useRef(0); const drStartW = useRef(0);
  useEffect(()=>{hoursDataRef.current=hoursData;},[hoursData]);

  useEffect(()=>{track('results_view',{type:'zone',region:regionId,zone:zoneIdDecoded});fetch('/data/regions.json').then(r=>r.json()).then(d=>{const r=(d.regions||[]).find(r=>r.id===regionId);setRegion(r||null);});},[regionId,zoneIdDecoded]);
  useEffect(()=>{if(!region?.epm)return;const{branch,dataFolder}=region.epm;Promise.all([fetchEpmCSV(branch,dataFolder,'zcmap.csv'),fetchZonesGeoJSON(branch,dataFolder),fetchLinestringGeoJSON(branch,dataFolder),fetchEpmCSV(branch,dataFolder,'pHours.csv')]).then(([zc,zGJ,lGJ,hr])=>{setZcmapRows(zc||[]);setZonesGJ(zGJ);setLinestringGJ(lGJ);if(hr)setHoursData(processHours(hr));});},[region]);
  useEffect(()=>{if(!region?.epm)return;setLoadingRuns(true);fetchGitHubDir(region.epm.branch,'epm/output').then(items=>{const runs=(items||[]).filter(i=>i.type==='dir').map(i=>i.name).sort().reverse();setRunList(runs);if(runs.length)setSimRun(runs[0]);}).finally(()=>setLoadingRuns(false));},[region]);
  useEffect(()=>{if(!region?.epm||!simRun)return;fetchGitHubDir(region.epm.branch,`epm/output/${simRun}`).then(items=>{const s=(items||[]).filter(i=>i.type==='dir').map(i=>i.name).sort();setScenarioList(s);if(s.length)setScenario(s[0]);});},[region,simRun]);
  useEffect(()=>{
    if(!region?.epm||!simRun||!scenarioList.length)return;
    setLoadingData(true);const{branch}=region.epm;
    Promise.all(scenarioList.map(async scen=>{const[tf,yz,dp,pr,tx,pl]=await Promise.all([fetchResultCSV(branch,simRun,scen,'pTechFuelMerged.csv'),fetchResultCSV(branch,simRun,scen,'pYearlyZoneMerged.csv'),fetchResultCSV(branch,simRun,scen,'pDispatchComplete.csv'),fetchResultCSV(branch,simRun,scen,'pHourlyPrice.csv'),fetchResultCSV(branch,simRun,scen,'pTransmissionMerged.csv'),fetchResultCSV(branch,simRun,scen,'pPlantMerged.csv')]);return{scen,techFuel:tf?processTechFuel(tf):{},yearlyZone:yz?processYearlyZone(yz):{},dispatch:dp?processDispatchResults(dp):{},price:pr?processHourlyPrice(pr):{},transmission:tx?processTransmissionResults(tx):{},plants:pl?processPlants(pl):[]};}))
    .then(res=>{const rd=Object.fromEntries(res.map(r=>[r.scen,r]));setResultsData(rd);const yrs=resultYears(res[0]?.techFuel||{});if(yrs.length)setRefYear(yrs[0]);}).finally(()=>setLoadingData(false));
  },[region,simRun,scenarioList]); // eslint-disable-line

  const countryName = zcmapRows.find(r=>r.z===zoneIdDecoded)?.c||'';
  const allYears = useMemo(()=>{const f=Object.values(resultsData)[0];return f?resultYears(f.techFuel):[];},[resultsData]);
  const hasData = Object.keys(resultsData).length>0;
  const totalDays = useMemo(()=>Object.values(hoursData).reduce((s,dts)=>s+Object.values(dts||{}).reduce((a,b)=>a+b,0),0)||365,[hoursData]);
  const firstDisp = Object.values(resultsData)[0]?.dispatch||{};
  const dispSeasons = useMemo(()=>{const qs=new Set();for(const yr of Object.values(firstDisp[zoneIdDecoded]||{}))for(const q of Object.keys(yr))qs.add(q);return[...qs].sort();},[firstDisp,zoneIdDecoded]);
  const dispDays = useMemo(()=>{const ds=new Set();for(const yr of Object.values(firstDisp[zoneIdDecoded]||{}))for(const q of Object.values(yr))for(const d of Object.keys(q))ds.add(d);return[...ds].sort();},[firstDisp,zoneIdDecoded]);

  // Map
  useEffect(()=>{
    if(!containerRef.current||!region||!zonesGJ)return;
    const regionCountries=[...new Set(zcmapRows.map(r=>r.c))].sort();const colorMap={};regionCountries.forEach((c,i)=>{colorMap[c]=MAP_PALETTE[i%MAP_PALETTE.length];});
    const zoneCentroids={};for(const f of zonesGJ.features){const z=f.properties.z;if(z){const c=computeCentroid(f.geometry);if(c)zoneCentroids[z]=c;}}
    const center=zoneCentroids[zoneIdDecoded]||[35,39];
    const map=new maplibregl.Map({container:containerRef.current,style:mapStyle(theme),center,zoom:5,minZoom:1,maxZoom:14,attributionControl:false});
    mapRef.current=map;
    const popup=new maplibregl.Popup({closeButton:false,closeOnClick:false,offset:10,className:`popup-${theme}`});
    map.on('load',async()=>{
      const tv=getT(theme);
      const countries=await fetch('/data/countries_10m.geojson').then(r=>r.json());countries.features.forEach((f,i)=>{f.id=i;});
      map.addSource('countries',{type:'geojson',data:countries,generateId:false});
      map.addLayer({id:'land',type:'fill',source:'countries',paint:{'fill-color':tv.land,'fill-opacity':1}});
      map.addLayer({id:'borders',type:'line',source:'countries',paint:{'line-color':tv.worldBdr,'line-width':tv.worldBdrW}});
      const isoToC={};for(const f of zonesGJ.features)isoToC[f.properties.ISO_A3]=f.properties.c;
      const uIsos=[...new Set(zonesGJ.features.map(f=>f.properties.ISO_A3))];
      const fillExpr=['match',['get','ISO_A3'],...uIsos.flatMap(iso=>[iso,colorMap[isoToC[iso]]||'#888']),'transparent'];
      map.addSource('zones',{type:'geojson',data:zonesGJ,generateId:true});
      map.addLayer({id:'zone-fill-dim',type:'fill',source:'zones',filter:['!=',['get','z'],zoneIdDecoded],paint:{'fill-color':fillExpr,'fill-opacity':0.07}});
      map.addLayer({id:'zone-fill-active',type:'fill',source:'zones',filter:['==',['get','z'],zoneIdDecoded],paint:{'fill-color':fillExpr,'fill-opacity':0.45}});
      map.addLayer({id:'zone-border-active',type:'line',source:'zones',filter:['==',['get','z'],zoneIdDecoded],paint:{'line-color':fillExpr,'line-width':2.5,'line-opacity':1}});
      // NTC source
      const aW=14,aH=12;const aData=new Uint8Array(aW*aH*4).fill(0);for(let y=0;y<aH;y++){const h=aH/2;const xMax=Math.round(y<=h?(y/h)*aW*0.85:((aH-y)/h)*aW*0.85);for(let x=0;x<xMax;x++){const i=(y*aW+x)*4;aData[i]=255;aData[i+1]=255;aData[i+2]=255;aData[i+3]=255;}}
      if(!map.hasImage('ntc-arrow-z'))map.addImage('ntc-arrow-z',{width:aW,height:aH,data:aData},{sdf:true});
      map.addSource('ntc-results',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
      map.addLayer({id:'ntc-bg',type:'line',source:'ntc-results',paint:{'line-color':['interpolate',['linear'],['get','util'],0,'#FFD700',0.5,'#FF8C00',1,'#E53935'],'line-width':['interpolate',['linear'],['get','vol'],0,1,500,2.5,5000,5],'line-opacity':0.88}});
      map.addLayer({id:'ntc-arrows',type:'symbol',source:'ntc-results',layout:{'icon-image':'ntc-arrow-z','icon-allow-overlap':false,'symbol-placement':'line','symbol-spacing':55,'icon-rotation-alignment':'map','icon-size':0.9},paint:{'icon-color':['interpolate',['linear'],['get','util'],0,'#FFD700',0.5,'#FF8C00',1,'#E53935']}});
      map.on('mouseenter','ntc-bg',e=>{map.getCanvas().style.cursor='pointer';const p=e.features[0].properties;popup.setLngLat(e.lngLat).setHTML(`<b>${p.z} ↔ ${p.z2}</b><br><span style="opacity:.8;font-size:0.8em">Interchange ${p.yr}: ${fmtBig(parseFloat(p.fwd))} / ${fmtBig(parseFloat(p.rev))} GWh<br>Util: ${p.util!=null?(parseFloat(p.util)*100).toFixed(0)+'%':'—'} · Cap: ${fmtBig(parseFloat(p.cap)||0)} MW</span>`).addTo(map);});
      map.on('mouseleave','ntc-bg',()=>{map.getCanvas().style.cursor='';popup.remove();});
      map.on('mousemove','zone-fill-dim',e=>{map.getCanvas().style.cursor='pointer';const z=e.features[0].properties.z||'';popup.setLngLat(e.lngLat).setHTML(`<b>${z}</b><br><span style="opacity:.6;font-size:0.7em">click to explore zone</span>`).addTo(map);});
      map.on('mouseleave','zone-fill-dim',()=>{map.getCanvas().style.cursor='';popup.remove();});
      map.on('click','zone-fill-dim',e=>{navigate(`/region/${regionId}/results/zone/${encodeURIComponent(e.features[0].properties.z||'')}`);});
      if(zoneCentroids[zoneIdDecoded]){const el=document.createElement('div');el.style.cssText=`font-size:0.55rem;font-weight:700;font-family:system-ui,sans-serif;color:${tv.lbl};background:${tv.panel};border:1.5px solid ${tv.panelBorder};border-radius:4px;padding:2px 7px;white-space:nowrap;pointer-events:none;box-shadow:0 1px 4px rgba(0,0,0,.22);`;el.textContent=zoneIdDecoded;markerRef.current=new maplibregl.Marker({element:el,anchor:'bottom',offset:[0,-4]}).setLngLat(zoneCentroids[zoneIdDecoded]).addTo(map);}
      setMapLoadedCount(c=>c+1);
    });
    return()=>{popup.remove();markerRef.current?.remove();markerRef.current=null;mapRef.current?.remove();};
  },[region,theme,zonesGJ,zcmapRows,zoneIdDecoded]); // eslint-disable-line

  // Update NTC
  useEffect(()=>{
    const map=mapRef.current;if(!map||!map.getSource('ntc-results')||!refYear)return;
    const sd=resultsData[scenario]||Object.values(resultsData)[0];if(!sd)return;
    const tx=sd.transmission;const zoneCentroids={};if(zonesGJ)for(const f of zonesGJ.features){const z=f.properties.z;if(z){const c=computeCentroid(f.geometry);if(c)zoneCentroids[z]=c;}}
    const seen=new Set();const features=[];
    for(const[z,z2map]of Object.entries(tx)){for(const[z2,attrs]of Object.entries(z2map)){const key=[z,z2].sort().join('||');if(seen.has(key))continue;seen.add(key);
      if(z!==zoneIdDecoded&&z2!==zoneIdDecoded)continue;
      const fwd=attrs.Interchange?.[refYear]||0;const rev=tx[z2]?.[z]?.Interchange?.[refYear]||0;const util=Math.min(1,Math.max(0,attrs.InterconUtilization?.[refYear]||tx[z2]?.[z]?.InterconUtilization?.[refYear]||0));const cap=attrs.TransmissionCapacity?.[refYear]||0;const vol=Math.abs(fwd)+Math.abs(rev);if(vol===0&&cap===0)continue;
      const lf=linestringGJ?.features?.find(f=>(f.properties.z===z&&(f.properties.z_other||f.properties.z2)===z2)||(f.properties.z===z2&&(f.properties.z_other||f.properties.z2)===z));
      let coords=lf?lf.geometry.coordinates:(zoneCentroids[z]&&zoneCentroids[z2]?[zoneCentroids[z],zoneCentroids[z2]]:null);if(!coords)continue;
      features.push({type:'Feature',properties:{z,z2,fwd,rev,util,vol,cap,yr:refYear},geometry:{type:'LineString',coordinates:fwd>=rev?coords:[...coords].reverse()}});
    }}
    map.getSource('ntc-results').setData({type:'FeatureCollection',features});
  },[resultsData,refYear,scenario,zonesGJ,linestringGJ,zoneIdDecoded,mapLoadedCount]); // eslint-disable-line

  if(!region)return<div style={{padding:40,color:t.text}}>Loading…</div>;
  const selectStyle={fontSize:'0.5rem',fontFamily:'inherit',padding:'2px 6px',borderRadius:3,border:`1px solid ${t.panelBorder}`,backgroundColor:t.panel,color:t.muted,cursor:'pointer'};

  // Builders
  const buildDispatch=()=>{
    const sd=resultsData[scenario];if(!sd||!zoneIdDecoded||!refYear)return{chartData:{labels:[],datasets:[]},plugin:null};
    const zDisp=sd.dispatch[zoneIdDecoded]?.[refYear]||{};const isDark=t.isDark;const mcColor=isDark?'rgba(255,255,255,0.88)':'#1E3A8A';const seasons=dispSeasons,days=dispDays;
    if(dispMode==='full'&&seasons.length&&days.length){
      const nS=seasons.length,nDT=days.length,nPts=nS*nDT*24;
      const tfs=[...new Set(seasons.flatMap(q=>days.flatMap(d=>Object.values(zDisp[q]?.[d]||{}).flatMap(Object.keys))))].filter(t=>t!=='Demand').sort();
      const datasets=tfs.map(tf=>({label:tf,fill:true,data:seasons.flatMap(s=>days.flatMap(d=>Array.from({length:24},(_,h)=>zDisp[s]?.[d]?.[`t${h+1}`]?.[tf]||0))),backgroundColor:hexA(techColor(tf),0.7),borderColor:techColor(tf),borderWidth:0,pointRadius:0,tension:0,stack:'gen'}));
      const zP=sd.price[zoneIdDecoded]?.[refYear]||{};const pd=seasons.flatMap(s=>days.flatMap(d=>Array.from({length:24},(_,h)=>zP[s]?.[d]?.[`t${h+1}`]||null)));
      if(pd.some(v=>v!=null))datasets.push({label:'Marginal cost',type:'line',data:pd,yAxisID:'yR',borderColor:mcColor,borderWidth:1,pointRadius:0,tension:0,fill:false,spanGaps:true,order:1});
      const dem=seasons.flatMap(s=>days.flatMap(d=>Array.from({length:24},(_,h)=>zDisp[s]?.[d]?.[`t${h+1}`]?.Demand||null)));
      if(dem.some(v=>v!=null))datasets.push({label:'Demand',type:'line',data:dem,borderColor:'#8B0000',borderWidth:1,pointRadius:0,tension:0,fill:false,spanGaps:true,stack:'demand',order:1});
      const sepPlugin={id:'zSep',afterDatasetsDraw:(chart)=>{const{ctx,chartArea:ca,scales:sc}=chart;if(!ca)return;const dL=(data,yK,col,lw=1.5)=>{if(!data.some(v=>v!=null)||!sc[yK])return;ctx.save();ctx.beginPath();ctx.strokeStyle=col;ctx.lineWidth=lw;ctx.setLineDash([]);let mv=false;data.forEach((v,i)=>{if(v==null){mv=false;return;}const x=sc.x.getPixelForValue(i);const y=sc[yK].getPixelForValue(v);mv?ctx.lineTo(x,y):ctx.moveTo(x,y);mv=true;});ctx.stroke();ctx.restore();};dL(dem,'y','#CC0000');dL(pd,'yR',mcColor,1);},afterDraw:(chart)=>{const{ctx,chartArea,scales}=chart;if(!chartArea||!scales.x)return;const{top,bottom}=chartArea;const xS=scales.x;const dC=isDark?'rgba(255,255,255,0.13)':'rgba(0,0,0,0.12)';const sC=isDark?'rgba(255,255,255,0.36)':'rgba(0,0,0,0.30)';const tC=isDark?'rgba(255,255,255,0.46)':'rgba(0,0,0,0.40)';const seC=isDark?'rgba(255,255,255,0.70)':'rgba(0,0,0,0.58)';for(let si=0;si<nS;si++){const ss=si*nDT*24;ctx.save();ctx.font='700 9px system-ui,sans-serif';ctx.fillStyle=seC;ctx.textAlign='center';ctx.textBaseline='bottom';ctx.fillText(seasons[si],xS.getPixelForValue(ss+nDT*12),top-2);ctx.restore();for(let di=0;di<nDT;di++){const dts=ss+di*24;if(dts>0){const lx=xS.getPixelForValue(dts);const isS=di===0;ctx.save();ctx.strokeStyle=isS?sC:dC;ctx.lineWidth=isS?1.2:0.7;if(!isS)ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(lx,top);ctx.lineTo(lx,bottom);ctx.stroke();ctx.restore();}const midX=xS.getPixelForValue(dts+12);const w=hoursData?.[seasons[si]]?.[days[di]]||0;const pct=w>0?` (${((w/totalDays)*100).toFixed(0)}%)`:'';ctx.save();ctx.translate(midX,bottom+3);ctx.rotate(-Math.PI/2);ctx.font='7px system-ui,sans-serif';ctx.fillStyle=tC;ctx.textAlign='right';ctx.textBaseline='middle';ctx.fillText(`${days[di]}${pct}`,0,0);ctx.restore();}}}};
      return{chartData:{labels:new Array(nPts).fill(''),datasets},plugin:sepPlugin};
    }
    const sp=zDisp[dispSeason];if(!sp)return{chartData:{labels:[],datasets:[]},plugin:null};
    const tfs2=[...new Set(Object.values(sp).flatMap(d=>Object.values(d).flatMap(Object.keys)))].filter(t=>t!=='Demand').sort();
    const getData=(tf)=>{if(dispDay==='avg'){const ds=Object.keys(sp);return Array.from({length:24},(_,h)=>ds.reduce((s,d)=>s+(sp[d]?.[`t${h+1}`]?.[tf]||0),0)/Math.max(ds.length,1));}return Array.from({length:24},(_,h)=>sp[dispDay]?.[`t${h+1}`]?.[tf]||0);};
    const datasets2=tfs2.map(tf=>({label:tf,fill:true,data:getData(tf),backgroundColor:hexA(techColor(tf),0.7),borderColor:techColor(tf),borderWidth:0,pointRadius:0,tension:0,stack:'gen'}));
    const getDem=()=>{if(dispDay==='avg'){const ds=Object.keys(sp);return Array.from({length:24},(_,h)=>ds.reduce((s,d)=>s+(sp[d]?.[`t${h+1}`]?.Demand||0),0)/Math.max(ds.length,1));}return Array.from({length:24},(_,h)=>sp[dispDay]?.[`t${h+1}`]?.Demand||null);};
    const demL=getDem();if(demL.some(v=>v))datasets2.push({label:'Demand',type:'line',data:demL,borderColor:'#8B0000',borderWidth:1,pointRadius:0,tension:0,fill:false,spanGaps:true,stack:'demand',order:1});
    const prL=Array.from({length:24},(_,h)=>{const d=dispDay==='avg'?Object.keys(sp)[0]:dispDay;return sd.price[zoneIdDecoded]?.[refYear]?.[dispSeason]?.[d]?.[`t${h+1}`]||null;});
    if(prL.some(v=>v!=null))datasets2.push({label:'Marginal cost',type:'line',data:prL,yAxisID:'yR',borderColor:mcColor,borderWidth:1,pointRadius:0,tension:0,fill:false,spanGaps:true,order:1});
    const linePlugin=(demL.some(v=>v)||prL.some(v=>v!=null))?{id:'lineS',afterDatasetsDraw:(chart)=>{const{ctx,chartArea:ca,scales:sc}=chart;if(!ca)return;const dL=(data,yK,col,lw=1.5)=>{if(!data.some(v=>v!=null)||!sc[yK])return;ctx.save();ctx.beginPath();ctx.strokeStyle=col;ctx.lineWidth=lw;ctx.setLineDash([]);let mv=false;data.forEach((v,i)=>{if(v==null){mv=false;return;}const x=sc.x.getPixelForValue(i);const y=sc[yK].getPixelForValue(v);mv?ctx.lineTo(x,y):ctx.moveTo(x,y);mv=true;});ctx.stroke();ctx.restore();};dL(demL,'y','#CC0000');dL(prL,'yR',mcColor,1);}}:null;
    return{chartData:{labels:Array.from({length:24},(_,i)=>`${i+1}h`),datasets:datasets2},plugin:linePlugin};
  };

  const buildConnections=()=>{
    const tx=resultsData[scenario]?.transmission||{};if(!refYear)return[];
    const conns=[];const seen=new Set();
    for(const[z,z2map]of Object.entries(tx))for(const[z2,attrs]of Object.entries(z2map)){
      if(z!==zoneIdDecoded&&z2!==zoneIdDecoded)continue;
      const neighbor=z===zoneIdDecoded?z2:z;if(seen.has(neighbor))continue;seen.add(neighbor);
      const fwd=tx[zoneIdDecoded]?.[neighbor]?.Interchange?.[refYear]||0;
      const rev=tx[neighbor]?.[zoneIdDecoded]?.Interchange?.[refYear]||0;
      const util=tx[zoneIdDecoded]?.[neighbor]?.InterconUtilization?.[refYear]||tx[neighbor]?.[zoneIdDecoded]?.InterconUtilization?.[refYear]||0;
      conns.push({neighbor,fwd,rev,net:fwd-rev,util});
    }
    return conns.sort((a,b)=>Math.abs(b.net)-Math.abs(a.net));
  };

  const buildPlants=()=>(resultsData[scenario]?.plants||[]).filter(p=>p.attribute===plIndicator&&p.y===refYear&&p.value>0&&p.z===zoneIdDecoded).sort((a,b)=>b.value-a.value).slice(0,plTopN);
  const buildLCOE=()=>{const pl=resultsData[scenario]?.plants||[];if(!refYear)return null;const byG={};for(const p of pl.filter(pp=>pp.y===refYear&&pp.z===zoneIdDecoded)){if(!byG[p.g])byG[p.g]={techfuel:p.techfuel};byG[p.g][p.attribute]=p.value;}const points=Object.entries(byG).map(([g,d])=>({g,techfuel:d.techfuel||'',lcoe:d.PlantAnnualLCOE||0,util:(d.UtilizationPlant||0)*100,cap:d.CapacityPlant||0})).filter(p=>p.lcoe>0&&p.util>0&&p.cap>0);const tfs=[...new Set(points.map(p=>p.techfuel))].sort();return{datasets:tfs.map(tf=>({label:tf,data:points.filter(p=>p.techfuel===tf).map(p=>({x:+p.util.toFixed(1),y:+p.lcoe.toFixed(1),r:Math.min(Math.max(Math.sqrt(p.cap)*0.6,3),20),_plant:p.g,_cap:p.cap})),backgroundColor:hexA(techColor(tf),0.65),borderColor:techColor(tf),borderWidth:1})).filter(d=>d.data.length>0)};};

  const dispResult=buildDispatch();const plantsData=buildPlants();const lcoeData=buildLCOE();const connections=buildConnections();
  const dispTechs=dispResult.chartData.datasets.filter(d=>d.label!=='Marginal cost'&&d.label!=='Demand').map(d=>d.label);

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
          {countryName&&<><span style={{color:t.lblMuted}}>›</span><Link to={`/region/${regionId}/results/country/${encodeURIComponent(countryName)}`} style={{color:t.lblMuted,textDecoration:'none'}}>{countryName}</Link></>}
          <span style={{color:t.lblMuted}}>›</span><span style={{color:t.lbl,fontWeight:600}}>{zoneIdDecoded}</span>
        </div>
      </div>

      <div style={{width:5,flexShrink:0,cursor:'col-resize'}} onMouseDown={e=>{isDrRef.current=true;drStartX.current=e.clientX;drStartW.current=panelWidth;e.preventDefault();}}/>

      <div style={{width:panelWidth,flexShrink:0,height:'100%',overflowY:'auto',padding:'18px 16px',backgroundColor:t.panel,borderLeft:`1px solid ${t.panelBorder}`}}>
        <div style={{marginBottom:12}}>
          <div style={{fontSize:'0.52rem',color:t.lblMuted,marginBottom:2}}>{countryName&&<Link to={`/region/${regionId}/results/country/${encodeURIComponent(countryName)}`} style={{color:t.lblMuted,textDecoration:'none'}}>← {countryName}</Link>}</div>
          <div style={{fontSize:'1rem',fontWeight:700,color:t.lbl}}>{zoneIdDecoded} — Results</div>
        </div>
        {/* Run selector */}
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:12,padding:'7px 10px',border:`1px solid ${t.panelBorder}`,borderRadius:6,backgroundColor:hexA(t.panelBorder,0.12)}}>
          <span style={{fontSize:'0.5rem',color:t.lblMuted,flexShrink:0}}>Run</span>
          {loadingRuns?<span style={{fontSize:'0.5rem',color:t.lblMuted}}>Loading…</span>:runList.length>0?<select value={simRun||''} onChange={e=>setSimRun(e.target.value)} style={{...selectStyle,flex:1}}>{runList.map(r=><option key={r} value={r}>{r}</option>)}</select>:<span style={{fontSize:'0.5rem',color:t.lblMuted}}>No results</span>}
          <select value={scenario||''} onChange={e=>setScenario(e.target.value)} style={selectStyle}>{scenarioList.map(s=><option key={s} value={s}>{s}</option>)}</select>
          <select value={refYear||''} onChange={e=>setRefYear(e.target.value)} style={selectStyle}>{allYears.map(y=><option key={y} value={y}>{y}</option>)}</select>
        </div>
        {/* Tabs */}
        <div style={{display:'flex',gap:0,marginBottom:16,borderBottom:`1px solid ${t.panelBorder}`}}>
          {['overview','dispatch','connections','plants'].map(tab=><button key={tab} onClick={()=>setActiveTab(tab)} style={{fontSize:'0.5rem',fontFamily:'inherit',padding:'6px 12px',border:'none',borderBottom:activeTab===tab?`2px solid ${t.lbl}`:'2px solid transparent',backgroundColor:'transparent',color:activeTab===tab?t.lbl:t.lblMuted,cursor:'pointer',fontWeight:activeTab===tab?600:400,textTransform:'capitalize'}}>{tab}</button>)}
        </div>
        {loadingData&&<div style={{padding:'24px 0',textAlign:'center',color:t.lblMuted,fontSize:'0.6rem'}}>Loading…</div>}

        {/* OVERVIEW */}
        {hasData&&activeTab==='overview'&&(()=>{
          const sd=resultsData[scenario];if(!sd||!refYear)return<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>Select a scenario.</div>;
          const cap=Object.values(sd.techFuel[zoneIdDecoded]?.CapacityTechFuel?.[refYear]||{}).reduce((a,b)=>a+b,0)/1000;
          const dem=(sd.yearlyZone[zoneIdDecoded]?.DemandEnergyZone?.[refYear]||0)/1000;
          const netImp=(sd.yearlyZone[zoneIdDecoded]?.NetImport?.[refYear]||0)/1000;
          const tfs=Object.keys(sd.techFuel[zoneIdDecoded]?.CapacityTechFuel?.[refYear]||{}).filter(tf=>sd.techFuel[zoneIdDecoded]?.CapacityTechFuel?.[refYear]?.[tf]>0).sort();
          return <div style={{display:'flex',flexDirection:'column',gap:14}}>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
              {[{l:`Installed ${refYear}`,v:`${cap.toFixed(1)} GW`},{l:`Demand ${refYear}`,v:`${dem.toFixed(0)} TWh`},{l:'Net import',v:`${netImp>=0?'+':''}${netImp.toFixed(0)} TWh`}].map(({l,v})=><div key={l} style={{border:`1px solid ${t.panelBorder}`,borderRadius:6,padding:'8px 10px'}}><div style={{fontSize:'0.41rem',color:t.lblMuted,marginBottom:2}}>{l}</div><div style={{fontSize:'0.78rem',fontWeight:700,color:t.lbl}}>{v}</div></div>)}
            </div>
            {tfs.length>0&&<><SectionTitle t={t}>Capacity by technology (MW)</SectionTitle>
              <CJChart type="bar" height={Math.min(tfs.length*22+24,200)} cacheKey={`ov-z|${scenario}|${refYear}`}
                data={{labels:tfs,datasets:[{data:tfs.map(tf=>Math.round(sd.techFuel[zoneIdDecoded]?.CapacityTechFuel?.[refYear]?.[tf]||0)),backgroundColor:tfs.map(tf=>techColor(tf)),borderWidth:0,barThickness:12}]}}
                options={{...cjDefaults(t),indexAxis:'y',scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}},y:{grid:{display:false},ticks:{color:t.muted,font:{size:8}}}}}}
              /></>}
          </div>;
        })()}

        {/* DISPATCH */}
        {hasData&&activeTab==='dispatch'&&(
          <div style={{display:'flex',flexDirection:'column',gap:10}}>
            <div style={{display:'flex',flexWrap:'wrap',gap:3,alignItems:'center'}}>
              <Pill active={dispMode==='full'} onClick={()=>setDispMode('full')}>Full Year</Pill>
              {dispSeasons.map(s=><Pill key={s} active={dispMode==='season'&&dispSeason===s} onClick={()=>{setDispMode('season');setDispSeason(s);}}>{s}</Pill>)}
              {dispMode==='season'&&dispDays.length>0&&<><div style={{width:1,height:14,backgroundColor:t.panelBorder}}/><select value={dispDay} onChange={e=>setDispDay(e.target.value)} style={selectStyle}><option value="avg">Avg</option>{dispDays.map(d=><option key={d} value={d}>{d}</option>)}</select></>}
            </div>
            {dispResult.chartData.datasets.length>0?<>
              <CJChart type="line" height={dispMode==='full'?210:165} data={dispResult.chartData} plugins={dispResult.plugin?[dispResult.plugin]:[]} cacheKey={`disp-z|${scenario}|${zoneIdDecoded}|${refYear}|${dispMode}|${dispSeason}|${dispDay}|${theme}`}
                options={{...cjDefaults(t),layout:{padding:{top:dispMode==='full'?18:4,bottom:dispMode==='full'?62:4}},scales:{x:{grid:{color:hexA(t.panelBorder,0.35),drawTicks:false},ticks:{display:dispMode!=='full',color:t.muted,font:{size:7},maxTicksLimit:12}},y:{stacked:true,grid:{color:hexA(t.panelBorder,0.35)},ticks:{color:t.muted,font:{size:8}},title:{display:true,text:'MW',color:t.muted,font:{size:7}}},yR:{type:'linear',position:'right',display:dispResult.chartData.datasets.some(d=>d.label==='Marginal cost'),grid:{drawOnChartArea:false},ticks:{color:t.muted,font:{size:8}}}},plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,mode:'index',intersect:false}}}}/>
              <div style={{display:'flex',flexWrap:'wrap',gap:'3px 8px',marginTop:2}}>
                {dispTechs.map(tf=><div key={tf} style={{display:'flex',alignItems:'center',gap:3,fontSize:'0.43rem',color:t.muted}}><div style={{width:8,height:8,borderRadius:2,backgroundColor:techColor(tf)}}/>{tf}</div>)}
                <div style={{display:'flex',alignItems:'center',gap:3,fontSize:'0.43rem',color:t.muted}}><div style={{width:12,height:2,backgroundColor:'#8B0000',borderRadius:1}}/><span>Demand</span></div>
                <div style={{display:'flex',alignItems:'center',gap:3,fontSize:'0.43rem',color:t.muted}}><div style={{width:12,height:2,backgroundColor:t.isDark?'rgba(255,255,255,0.88)':'#1E3A8A',borderRadius:1}}/><span>Marg. cost</span></div>
              </div>
            </>:<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>No dispatch data.</div>}
          </div>
        )}

        {/* CONNECTIONS */}
        {hasData&&activeTab==='connections'&&(
          <div style={{display:'flex',flexDirection:'column',gap:12}}>
            <SectionTitle t={t}>NTC connections ({refYear||'—'})</SectionTitle>
            {connections.length>0?<div style={{border:`1px solid ${t.panelBorder}`,borderRadius:6,overflow:'hidden'}}>
              <div style={{display:'grid',gridTemplateColumns:'1fr 80px 70px 60px',padding:'4px 10px',backgroundColor:hexA(t.panelBorder,0.4),fontSize:'0.42rem',color:t.lblMuted,fontWeight:600,borderBottom:`1px solid ${t.panelBorder}`}}>
                <span>Neighbor</span><span style={{textAlign:'center'}}>→ GWh</span><span style={{textAlign:'center'}}>← GWh</span><span style={{textAlign:'right'}}>Util%</span>
              </div>
              {connections.map(c=><div key={c.neighbor} onClick={()=>navigate(`/region/${regionId}/results/zone/${encodeURIComponent(c.neighbor)}`)} style={{display:'grid',gridTemplateColumns:'1fr 80px 70px 60px',padding:'6px 10px',borderTop:`1px solid ${t.panelBorder}`,fontSize:'0.52rem',alignItems:'center',cursor:'pointer'}} onMouseEnter={e=>e.currentTarget.style.backgroundColor=hexA('#1a5fa8',0.06)} onMouseLeave={e=>e.currentTarget.style.backgroundColor='transparent'}>
                <span style={{color:t.lbl,fontWeight:500}}>{c.neighbor}</span>
                <span style={{textAlign:'center',color:c.fwd>0?t.lbl:t.lblMuted}}>{c.fwd>0?fmt(c.fwd,0):'—'}</span>
                <span style={{textAlign:'center',color:c.rev>0?t.lbl:t.lblMuted}}>{c.rev>0?fmt(c.rev,0):'—'}</span>
                <span style={{textAlign:'right',color:t.muted,fontSize:'0.46rem'}}>{c.util>0?(c.util*100).toFixed(0)+'%':'—'}</span>
              </div>)}
            </div>:<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>No NTC data for this zone.</div>}
          </div>
        )}

        {/* PLANTS */}
        {hasData&&activeTab==='plants'&&(
          <div style={{display:'flex',flexDirection:'column',gap:14}}>
            <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
              <select value={plIndicator} onChange={e=>setPlIndicator(e.target.value)} style={selectStyle}>{['CapacityPlant','EnergyPlant','CostsPlant','PlantAnnualLCOE','UtilizationPlant'].map(k=><option key={k} value={k}>{k.replace('Plant','').replace(/([A-Z])/g,' $1').trim()}</option>)}</select>
              <select value={plTopN} onChange={e=>setPlTopN(+e.target.value)} style={selectStyle}>{[10,15,20].map(n=><option key={n} value={n}>Top {n}</option>)}</select>
            </div>
            {plantsData.length>0?<><SectionTitle t={t}>Top {plTopN} plants</SectionTitle><CJChart type="bar" height={Math.min(plantsData.length*18+24,240)} cacheKey={`pl-z|${scenario}|${refYear}|${plIndicator}|${plTopN}`} data={{labels:plantsData.map(p=>p.g),datasets:[{data:plantsData.map(p=>+p.value.toFixed(2)),backgroundColor:plantsData.map(p=>hexA(techColor(p.techfuel),0.8)),borderWidth:0,barThickness:12}]}} options={{...cjDefaults(t),indexAxis:'y',scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}},y:{grid:{display:false},ticks:{color:t.muted,font:{size:7}}}}}}/></>:<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>No plant data.</div>}
            {lcoeData&&lcoeData.datasets.length>0&&<><SectionTitle t={t}>LCOE vs Utilization</SectionTitle><CJChart type="bubble" height={220} cacheKey={`lcoe-z|${scenario}|${refYear}`} data={lcoeData} options={{...cjDefaults(t),plugins:{...cjDefaults(t).plugins,tooltip:{...cjDefaults(t).plugins.tooltip,callbacks:{label:ctx=>{const d=ctx.raw;return[`${d._plant||ctx.dataset.label}`,`LCOE: ${d.y} $/MWh · Util: ${d.x.toFixed(0)}%`,d._cap?`Cap: ${fmt(d._cap)} MW`:''].filter(Boolean);}}}},scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}},title:{display:true,text:'Utilization (%)',color:t.muted,font:{size:8}},min:0,max:105},y:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}},title:{display:true,text:'LCOE (USD/MWh)',color:t.muted,font:{size:8}},min:0}}}}/><div style={{display:'flex',flexWrap:'wrap',gap:'3px 8px',marginTop:4}}>{lcoeData.datasets.map(ds=><div key={ds.label} style={{display:'flex',alignItems:'center',gap:3,fontSize:'0.43rem',color:t.muted}}><div style={{width:8,height:8,borderRadius:'50%',backgroundColor:ds.backgroundColor}}/>{ds.label}</div>)}</div></>}
          </div>
        )}

        <div style={{marginTop:20,paddingTop:12,borderTop:`1px solid ${t.panelBorder}`,fontSize:'0.48rem',color:t.lblMuted}}>Zone <b style={{color:t.lbl}}>{zoneIdDecoded}</b> · {countryName} · {region.name}</div>
      </div>
    </div>
  );
}
