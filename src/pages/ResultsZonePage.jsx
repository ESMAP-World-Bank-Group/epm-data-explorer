import { useEffect, useRef, useState, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import { useTheme } from '../App';
import { getT, mapStyle } from '../constants';
import {
  fetchEpmCSV, fetchZonesGeoJSON, fetchGitHubDir, fetchResultCSV,
  processTechFuel, processYearlyZone, processDispatchResults, processHourlyPrice, processHours,
  processPlants,
  computeCentroid, normalizeFuel, EPM_FUEL_COLORS, resultYears,
} from '../utils/epmFetch';

const MAP_PALETTE = ['#1B6CA8','#36B5B5','#E8C547','#4DA6FF','#0D7680','#85C1E9','#2E9EC8','#5EBCBA','#1A5276','#7EC8E3','#14A094','#4CAFE8','#EDD770','#AED6F1','#1F618D','#0A6B70'];
const TECHFUEL_COLORS = { Nuclear:'#C8A8F0',Coal:'#808890',Gas:'#9A7040',CCGT:'#B8921A',OCGT:'#C4A820',Diesel:'#6A7888',HFO:'#7A7068',Oil:'#7A7068',Biomass:'#52C860',Waste:'#8A9098',Geothermal:'#D4A820',Reservoir:'#1E9AF5',ROR:'#5DADE2',PSH:'#0D7680',Solar:'#FFD700',PV:'#FFD700',CSP:'#E8C547','Onshore Wind':'#44DAEC',OnshoreWind:'#44DAEC','Offshore Wind':'#7CC8FA',OffshoreWind:'#7CC8FA',Battery:'#A3D5FF',Storage:'#AED6F1',Demand:'#9B59B6' };
function techColor(tf) { return TECHFUEL_COLORS[tf]||EPM_FUEL_COLORS[normalizeFuel(tf)]||'#AAAAAA'; }
function hexA(hex,a){if(!hex||hex.length<7)return`rgba(128,128,128,${a})`;const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);return`rgba(${r},${g},${b},${a})`;}
function cjDefaults(t){return{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{backgroundColor:t.panel,borderColor:t.panelBorder,borderWidth:1,titleColor:t.lbl,bodyColor:t.muted,titleFont:{size:9},bodyFont:{size:9},padding:6}},scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}}},y:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}}}}};}

function CJChart({ type, data, options, height, plugins: extraPlugins, cacheKey }) {
  const canvasRef=useRef(null);const chartRef=useRef(null);
  const sig=JSON.stringify({type,labels:data.labels,ck:cacheKey,ds:data.datasets?.map(d=>({l:d.label,n:d.data?.length,t:d.type}))});
  useEffect(()=>{const CJ=window.Chart;if(!CJ||!canvasRef.current)return;chartRef.current?.destroy();chartRef.current=new CJ(canvasRef.current,{type,data,options,plugins:extraPlugins||[]});return()=>{chartRef.current?.destroy();chartRef.current=null;};},[sig]); // eslint-disable-line
  return <div style={{height,width:'100%',position:'relative'}}><canvas ref={canvasRef}/></div>;
}
function SectionTitle({t,children}){return <div style={{fontSize:'0.47rem',letterSpacing:'2px',fontWeight:700,color:t.lblMuted,textTransform:'uppercase',marginBottom:6}}>{children}</div>;}
function Pill({active,onClick,children}){return <button onClick={onClick} style={{fontSize:'0.44rem',fontFamily:'inherit',padding:'2px 7px',borderRadius:3,cursor:'pointer',border:`1px solid ${active?'rgba(74,143,204,0.65)':'rgba(128,160,192,0.2)'}`,backgroundColor:active?'rgba(74,143,204,0.12)':'transparent',color:active?'rgba(74,143,204,1)':'rgba(128,160,192,0.7)',fontWeight:active?600:400}}>{children}</button>;}

export default function ResultsZonePage() {
  const { regionId, zoneId } = useParams();
  const zoneIdDecoded = decodeURIComponent(zoneId);
  const { theme } = useTheme(); const t = getT(theme); const navigate = useNavigate();
  const containerRef = useRef(null); const mapRef = useRef(null); const markerRef = useRef(null);

  const [region, setRegion]           = useState(null);
  const [zcmapRows, setZcmapRows]     = useState([]);
  const [zonesGJ, setZonesGJ]         = useState(null);
  const [hoursData, setHoursData]     = useState({});
  const [runList, setRunList]         = useState([]);
  const [simRun, setSimRun]           = useState(null);
  const [scenarioList, setScenarioList] = useState([]);
  const [resultsData, setResultsData] = useState({});
  const [loading, setLoading]         = useState(false);
  const [activeTab, setActiveTab]     = useState('overview');
  const [refYear, setRefYear]         = useState(null);
  const [scenario, setScenario]       = useState(null);
  const [dispMode, setDispMode]       = useState('full');
  const [dispSeason, setDispSeason]   = useState('Q1');
  const [dispDay, setDispDay]         = useState('avg');

  useEffect(()=>{fetch('/data/regions.json').then(r=>r.json()).then(d=>{const r=(d.regions||[]).find(r=>r.id===regionId);setRegion(r||null);});},[regionId]);

  useEffect(()=>{
    if(!region?.epm)return;
    const{branch,dataFolder}=region.epm;
    Promise.all([fetchEpmCSV(branch,dataFolder,'zcmap.csv'),fetchZonesGeoJSON(branch,dataFolder),fetchEpmCSV(branch,dataFolder,'pHours.csv')]).then(([zc,zGJ,hr])=>{setZcmapRows(zc||[]);setZonesGJ(zGJ);if(hr)setHoursData(processHours(hr));});
  },[region]);

  useEffect(()=>{if(!region?.epm)return;fetchGitHubDir(region.epm.branch,'epm/output').then(items=>{const runs=(items||[]).filter(i=>i.type==='dir').map(i=>i.name).sort().reverse();setRunList(runs);if(runs.length)setSimRun(runs[0]);});},[region]);
  useEffect(()=>{if(!region?.epm||!simRun)return;fetchGitHubDir(region.epm.branch,`epm/output/${simRun}`).then(items=>{const s=(items||[]).filter(i=>i.type==='dir').map(i=>i.name).sort();setScenarioList(s);if(s.length)setScenario(s[0]);});},[region,simRun]);

  useEffect(()=>{
    if(!region?.epm||!simRun||!scenarioList.length)return;
    setLoading(true);const{branch}=region.epm;
    Promise.all(scenarioList.map(async scen=>{const[tf,yz,dp,pr,pl]=await Promise.all([fetchResultCSV(branch,simRun,scen,'pTechFuelMerged.csv'),fetchResultCSV(branch,simRun,scen,'pYearlyZoneMerged.csv'),fetchResultCSV(branch,simRun,scen,'pDispatchComplete.csv'),fetchResultCSV(branch,simRun,scen,'pHourlyPrice.csv'),fetchResultCSV(branch,simRun,scen,'pPlantMerged.csv')]);return{scen,techFuel:tf?processTechFuel(tf):{},yearlyZone:yz?processYearlyZone(yz):{},dispatch:dp?processDispatchResults(dp):{},price:pr?processHourlyPrice(pr):{},plants:pl?processPlants(pl):[]};})).then(res=>{const rd=Object.fromEntries(res.map(r=>[r.scen,r]));setResultsData(rd);const yrs=resultYears(res[0]?.techFuel||{});if(yrs.length)setRefYear(yrs[0]);}).finally(()=>setLoading(false));
  },[region,simRun,scenarioList]); // eslint-disable-line

  const countryName=zcmapRows.find(r=>r.z===zoneIdDecoded)?.c||'';
  const allYears=useMemo(()=>{const f=Object.values(resultsData)[0];return f?resultYears(f.techFuel):[];},[resultsData]);
  const hasData=Object.keys(resultsData).length>0;
  const totalDays=useMemo(()=>Object.values(hoursData).reduce((s,dts)=>s+Object.values(dts||{}).reduce((a,b)=>a+b,0),0)||365,[hoursData]);
  const firstDisp=Object.values(resultsData)[0]?.dispatch||{};
  const dispSeasons=useMemo(()=>{const qs=new Set();for(const z of Object.values(firstDisp))for(const q of Object.keys(z))qs.add(q);return[...qs].sort();},[firstDisp]);
  const dispDays=useMemo(()=>{const ds=new Set();for(const z of Object.values(firstDisp))for(const q of Object.values(z))for(const d of Object.keys(q))ds.add(d);return[...ds].sort();},[firstDisp]);

  // Map
  useEffect(()=>{
    if(!containerRef.current||!region||!zonesGJ)return;
    const zcMap=Object.fromEntries(zcmapRows.map(r=>[r.z,r.c]));
    const regionCountries=[...new Set(zcmapRows.map(r=>r.c))].sort();
    const colorMap={};regionCountries.forEach((c,i)=>{colorMap[c]=MAP_PALETTE[i%MAP_PALETTE.length];});
    const zoneCentroids={};for(const f of zonesGJ.features){const z=f.properties.z;if(z){const c=computeCentroid(f.geometry);if(c)zoneCentroids[z]=c;}}
    const center=zoneCentroids[zoneIdDecoded]||[35,39];
    const map=new maplibregl.Map({container:containerRef.current,style:mapStyle(theme),center,zoom:5,minZoom:1,maxZoom:14,attributionControl:false});
    mapRef.current=map;
    const popup=new maplibregl.Popup({closeButton:false,closeOnClick:false,offset:10,className:`popup-${theme}`});
    map.on('load',async()=>{
      const tv=getT(theme);
      const countries=await fetch('/data/countries_110m.geojson').then(r=>r.json());countries.features.forEach((f,i)=>{f.id=i;});
      map.addSource('countries',{type:'geojson',data:countries,generateId:false});
      map.addLayer({id:'land',type:'fill',source:'countries',paint:{'fill-color':tv.land,'fill-opacity':1}});
      map.addLayer({id:'borders',type:'line',source:'countries',paint:{'line-color':tv.worldBdr,'line-width':tv.worldBdrW}});
      const isoToC={};for(const f of zonesGJ.features)isoToC[f.properties.ISO_A3]=f.properties.c;
      const uniqueIsos=[...new Set(zonesGJ.features.map(f=>f.properties.ISO_A3))];
      const fillExpr=['match',['get','ISO_A3'],...uniqueIsos.flatMap(iso=>[iso,colorMap[isoToC[iso]]||'#888']),'transparent'];
      map.addSource('zones',{type:'geojson',data:zonesGJ,generateId:true});
      map.addLayer({id:'zone-fill-dim',type:'fill',source:'zones',filter:['!=',['get','z'],zoneIdDecoded],paint:{'fill-color':fillExpr,'fill-opacity':0.07}});
      map.addLayer({id:'zone-fill-active',type:'fill',source:'zones',filter:['==',['get','z'],zoneIdDecoded],paint:{'fill-color':fillExpr,'fill-opacity':0.45}});
      map.addLayer({id:'zone-border-active',type:'line',source:'zones',filter:['==',['get','z'],zoneIdDecoded],paint:{'line-color':fillExpr,'line-width':2.5,'line-opacity':1}});
      map.on('mousemove','zone-fill-dim',e=>{map.getCanvas().style.cursor='pointer';const z=e.features[0].properties.z;popup.setLngLat(e.lngLat).setHTML(`<b>${z}</b>`).addTo(map);});
      map.on('mouseleave','zone-fill-dim',()=>{map.getCanvas().style.cursor='';popup.remove();});
      map.on('click','zone-fill-dim',e=>{navigate(`/region/${regionId}/results/zone/${encodeURIComponent(e.features[0].properties.z)}`);});
      if(zoneCentroids[zoneIdDecoded]){const el=document.createElement('div');el.style.cssText=`font-size:0.55rem;font-weight:700;font-family:system-ui,sans-serif;color:${tv.lbl};background:${tv.panel};border:1.5px solid ${tv.panelBorder};border-radius:4px;padding:2px 7px;white-space:nowrap;pointer-events:none;box-shadow:0 1px 4px rgba(0,0,0,.22);`;el.textContent=zoneIdDecoded;markerRef.current=new maplibregl.Marker({element:el,anchor:'bottom',offset:[0,-4]}).setLngLat(zoneCentroids[zoneIdDecoded]).addTo(map);}
    });
    return()=>{popup.remove();markerRef.current?.remove();markerRef.current=null;mapRef.current?.remove();};
  },[region,theme,zonesGJ,zcmapRows,zoneIdDecoded]); // eslint-disable-line

  const selectStyle={fontSize:'0.5rem',fontFamily:'inherit',padding:'2px 6px',borderRadius:3,border:`1px solid ${t.panelBorder}`,backgroundColor:t.panel,color:t.muted,cursor:'pointer'};

  // Build dispatch for this zone
  const buildDispatch=()=>{
    const sd=resultsData[scenario];if(!sd)return{chartData:{labels:[],datasets:[]},plugin:null};
    const zDisp=sd.dispatch[zoneIdDecoded]||{};
    const isDark=t.isDark;const seasons=dispSeasons,days=dispDays;
    if(dispMode==='full'&&seasons.length&&days.length){
      const nS=seasons.length,nDT=days.length,nPts=nS*nDT*24;
      const tfs=[...new Set(seasons.flatMap(q=>days.flatMap(d=>Object.values(zDisp[q]?.[d]||{}).flatMap(Object.keys))))].filter(t=>t!=='Demand').sort();
      const datasets=tfs.map(tf=>({label:tf,fill:true,data:seasons.flatMap(s=>days.flatMap(d=>Array.from({length:24},(_,h)=>zDisp[s]?.[d]?.[`t${h+1}`]?.[tf]||0))),backgroundColor:hexA(techColor(tf),0.7),borderColor:techColor(tf),borderWidth:0,pointRadius:0,tension:0}));
      const zP=sd.price[zoneIdDecoded]||{};const pd=seasons.flatMap(s=>days.flatMap(d=>Array.from({length:24},(_,h)=>zP[s]?.[d]?.[`t${h+1}`]||null)));
      if(pd.some(v=>v!=null))datasets.push({label:'Marginal cost',type:'line',data:pd,yAxisID:'yR',borderColor:hexA('#E8C547',0.9),borderWidth:1.5,pointRadius:0,tension:0,fill:false,spanGaps:true});
      const sepPlugin={id:'zSep',afterDraw:(chart)=>{const{ctx,chartArea,scales}=chart;if(!chartArea||!scales.x)return;const{top,bottom}=chartArea;const xS=scales.x;const dashC=isDark?'rgba(255,255,255,0.13)':'rgba(0,0,0,0.12)';const solidC=isDark?'rgba(255,255,255,0.36)':'rgba(0,0,0,0.30)';const textC=isDark?'rgba(255,255,255,0.46)':'rgba(0,0,0,0.40)';const seasC=isDark?'rgba(255,255,255,0.70)':'rgba(0,0,0,0.58)';for(let si=0;si<nS;si++){const ss=si*nDT*24;ctx.save();ctx.font='700 9px system-ui,sans-serif';ctx.fillStyle=seasC;ctx.textAlign='center';ctx.textBaseline='bottom';ctx.fillText(seasons[si],xS.getPixelForValue(ss+nDT*12),top-2);ctx.restore();for(let di=0;di<nDT;di++){const dts=ss+di*24;if(dts>0){const lx=xS.getPixelForValue(dts);const isS=di===0;ctx.save();ctx.strokeStyle=isS?solidC:dashC;ctx.lineWidth=isS?1.2:0.7;if(!isS)ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(lx,top);ctx.lineTo(lx,bottom);ctx.stroke();ctx.restore();}const midX=xS.getPixelForValue(dts+12);const w=hoursData?.[seasons[si]]?.[days[di]]||0;const pct=w>0?` (${((w/totalDays)*100).toFixed(0)}%)`:'';ctx.save();ctx.translate(midX,bottom+3);ctx.rotate(-Math.PI/2);ctx.font='7px system-ui,sans-serif';ctx.fillStyle=textC;ctx.textAlign='right';ctx.textBaseline='middle';ctx.fillText(`${days[di]}${pct}`,0,0);ctx.restore();}}}};
      return{chartData:{labels:new Array(nPts).fill(''),datasets},plugin:sepPlugin};
    }
    const sp=zDisp[dispSeason];if(!sp)return{chartData:{labels:[],datasets:[]},plugin:null};
    const tfs2=[...new Set(Object.values(sp).flatMap(d=>Object.values(d).flatMap(Object.keys)))].filter(t=>t!=='Demand').sort();
    const getData=(tf)=>{if(dispDay==='avg'){const ds=Object.keys(sp);return Array.from({length:24},(_,h)=>ds.reduce((s,d)=>s+(sp[d]?.[`t${h+1}`]?.[tf]||0),0)/Math.max(ds.length,1));}return Array.from({length:24},(_,h)=>sp[dispDay]?.[`t${h+1}`]?.[tf]||0);};
    return{chartData:{labels:Array.from({length:24},(_,i)=>`${i+1}h`),datasets:tfs2.map(tf=>({label:tf,fill:true,data:getData(tf),backgroundColor:hexA(techColor(tf),0.7),borderColor:techColor(tf),borderWidth:0,pointRadius:0,tension:0}))},plugin:null};
  };

  const dispResult=buildDispatch();
  const dispTechs=dispResult.chartData.datasets.filter(d=>d.label!=='Marginal cost').map(d=>d.label);

  return (
    <div style={{display:'flex',height:'calc(100vh - 46px)'}}>
      <div style={{position:'relative',flex:1}}>
        <div ref={containerRef} style={{width:'100%',height:'100%',backgroundColor:t.bg}}/>
        <div style={{position:'absolute',top:10,left:10,zIndex:10,display:'flex',gap:4,alignItems:'center',fontSize:'0.52rem',color:t.text,backgroundColor:t.panel,border:`1px solid ${t.panelBorder}`,borderRadius:5,padding:'4px 10px',boxShadow:'0 1px 4px rgba(0,0,0,.18)'}}>
          <Link to="/" style={{color:t.lblMuted,textDecoration:'none'}}>World</Link><span style={{color:t.lblMuted}}>›</span>
          <Link to={`/region/${regionId}/results`} style={{color:t.lblMuted,textDecoration:'none'}}>{region?.name} · Results</Link>
          {countryName&&<><span style={{color:t.lblMuted}}>›</span><Link to={`/region/${regionId}/results/country/${encodeURIComponent(countryName)}`} style={{color:t.lblMuted,textDecoration:'none'}}>{countryName}</Link></>}
          <span style={{color:t.lblMuted}}>›</span><span style={{color:t.lbl,fontWeight:600}}>{zoneIdDecoded}</span>
        </div>
      </div>
      <div style={{width:490,flexShrink:0,height:'100%',overflowY:'auto',padding:'18px 16px',backgroundColor:t.panel,borderLeft:`1px solid ${t.panelBorder}`}}>
        <div style={{marginBottom:12}}>
          <div style={{fontSize:'0.52rem',color:t.lblMuted,marginBottom:2}}>{countryName&&<Link to={`/region/${regionId}/results/country/${encodeURIComponent(countryName)}`} style={{color:t.lblMuted,textDecoration:'none'}}>← {countryName}</Link>}</div>
          <div style={{fontSize:'1rem',fontWeight:700,color:t.lbl}}>{zoneIdDecoded}</div>
        </div>
        {/* Run selector */}
        <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:12,padding:'7px 10px',border:`1px solid ${t.panelBorder}`,borderRadius:6,flexWrap:'wrap'}}>
          <span style={{fontSize:'0.5rem',color:t.lblMuted}}>Run</span>
          <select value={simRun||''} onChange={e=>setSimRun(e.target.value)} style={{...selectStyle,flex:1,minWidth:100}}>
            {runList.map(r=><option key={r} value={r}>{r}</option>)}
          </select>
          <span style={{fontSize:'0.5rem',color:t.lblMuted}}>Scenario</span>
          <select value={scenario||''} onChange={e=>setScenario(e.target.value)} style={selectStyle}>
            {scenarioList.map(s=><option key={s} value={s}>{s}</option>)}
          </select>
          <select value={refYear||''} onChange={e=>setRefYear(e.target.value)} style={selectStyle}>
            {allYears.map(y=><option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        {/* Tabs */}
        <div style={{display:'flex',gap:0,marginBottom:14,borderBottom:`1px solid ${t.panelBorder}`}}>
          {['overview','dispatch','plants'].map(tab=>(
            <button key={tab} onClick={()=>setActiveTab(tab)} style={{fontSize:'0.5rem',fontFamily:'inherit',padding:'6px 16px',border:'none',borderBottom:activeTab===tab?`2px solid ${t.lbl}`:'2px solid transparent',backgroundColor:'transparent',color:activeTab===tab?t.lbl:t.lblMuted,cursor:'pointer',fontWeight:activeTab===tab?600:400,textTransform:'capitalize'}}>{tab}</button>
          ))}
        </div>
        {loading&&<div style={{padding:'24px 0',textAlign:'center',color:t.lblMuted,fontSize:'0.6rem'}}>Loading results…</div>}
        {/* Overview */}
        {!loading&&hasData&&activeTab==='overview'&&(()=>{
          const sd=resultsData[scenario];if(!sd||!refYear)return<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>Select a scenario.</div>;
          const zoneTf=sd.techFuel[zoneIdDecoded];
          const totGW=Object.values(zoneTf?.CapacityTechFuel?.[refYear]||{}).reduce((s,v)=>s+v,0)/1000;
          const demTWh=(sd.yearlyZone[zoneIdDecoded]?.DemandEnergyZone?.[refYear]||0)/1000;
          const tfs=Object.keys(zoneTf?.CapacityTechFuel?.[refYear]||{}).sort();
          return <div style={{display:'flex',flexDirection:'column',gap:14}}>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
              {[{l:`Installed ${refYear}`,v:`${totGW.toFixed(1)} GW`},{l:`Demand ${refYear}`,v:`${demTWh.toFixed(0)} TWh`}].map(({l,v})=>(
                <div key={l} style={{border:`1px solid ${t.panelBorder}`,borderRadius:6,padding:'8px 10px'}}>
                  <div style={{fontSize:'0.42rem',color:t.lblMuted,marginBottom:2}}>{l}</div>
                  <div style={{fontSize:'0.8rem',fontWeight:700,color:t.lbl}}>{v}</div>
                </div>
              ))}
            </div>
            {tfs.length>0&&<div>
              <SectionTitle t={t}>Capacity by technology (MW)</SectionTitle>
              <CJChart type="bar" height={Math.min(tfs.length*22+24,200)}
                data={{labels:tfs,datasets:[{data:tfs.map(tf=>Math.round(zoneTf?.CapacityTechFuel?.[refYear]?.[tf]||0)),backgroundColor:tfs.map(tf=>techColor(tf)),borderWidth:0,barThickness:12}]}}
                options={{...cjDefaults(t),indexAxis:'y',scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}},y:{grid:{display:false},ticks:{color:t.muted,font:{size:8}}}}}}
              />
            </div>}
          </div>;
        })()}
        {/* Dispatch */}
        {!loading&&hasData&&activeTab==='dispatch'&&(
          <div style={{display:'flex',flexDirection:'column',gap:10}}>
            <div style={{display:'flex',flexWrap:'wrap',gap:3,alignItems:'center'}}>
              <Pill active={dispMode==='full'} onClick={()=>setDispMode('full')}>Full Year</Pill>
              {dispSeasons.map(s=><Pill key={s} active={dispMode==='season'&&dispSeason===s} onClick={()=>{setDispMode('season');setDispSeason(s);}}>{s}</Pill>)}
              {dispMode==='season'&&dispDays.length>0&&<>
                <div style={{width:1,height:14,backgroundColor:t.panelBorder}}/>
                <select value={dispDay} onChange={e=>setDispDay(e.target.value)} style={selectStyle}>
                  <option value="avg">Avg</option>{dispDays.map(d=><option key={d} value={d}>{d}</option>)}
                </select>
              </>}
            </div>
            {dispResult.chartData.datasets.length>0?<>
              <CJChart type="line" height={dispMode==='full'?210:160} data={dispResult.chartData} plugins={dispResult.plugin?[dispResult.plugin]:[]} cacheKey={`zdisp|${scenario}|${zoneIdDecoded}|${dispMode}|${dispSeason}|${dispDay}`}
                options={{...cjDefaults(t),layout:{padding:{top:dispMode==='full'?18:4,bottom:dispMode==='full'?62:4}},scales:{x:{grid:{color:t.panelBorder,drawTicks:false},ticks:{display:dispMode!=='full',color:t.muted,font:{size:7},maxTicksLimit:12}},y:{stacked:true,grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8}},title:{display:true,text:'MW',color:t.muted,font:{size:7}}},yR:{type:'linear',position:'right',display:dispResult.chartData.datasets.some(d=>d.label==='Marginal cost'),grid:{drawOnChartArea:false},ticks:{color:t.muted,font:{size:8}}}}}}/>
              <div style={{display:'flex',flexWrap:'wrap',gap:'3px 8px',marginTop:2}}>
                {dispTechs.map(tf=><div key={tf} style={{display:'flex',alignItems:'center',gap:3,fontSize:'0.43rem',color:t.muted}}><div style={{width:8,height:8,borderRadius:2,backgroundColor:techColor(tf)}}/>{tf}</div>)}
              </div>
            </>:<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>No dispatch data for this zone.</div>}
          </div>
        )}
        {/* Plants */}
        {!loading&&hasData&&activeTab==='plants'&&(()=>{
          const selectStyle={fontSize:'0.5rem',fontFamily:'inherit',padding:'2px 6px',borderRadius:3,border:`1px solid ${t.panelBorder}`,backgroundColor:t.panel,color:t.muted,cursor:'pointer'};
          const [plInd,setPlInd]=[useState('CapacityPlant')[0],useState('CapacityPlant')[1]]; // local state workaround
          const pl=(resultsData[scenario]?.plants||[]).filter(p=>p.attribute==='CapacityPlant'&&p.z===zoneIdDecoded&&p.y===refYear&&p.value>0).sort((a,b)=>b.value-a.value).slice(0,15);
          return<div style={{display:'flex',flexDirection:'column',gap:10}}>
            <div style={{fontSize:'0.47rem',letterSpacing:'2px',fontWeight:700,color:t.lblMuted,textTransform:'uppercase',marginBottom:4}}>Top plants — Capacity (MW)</div>
            {pl.length>0?<CJChart type="bar" height={Math.min(pl.length*18+24,280)} cacheKey={`zpl|${scenario}|${refYear}`}
              data={{labels:pl.map(p=>p.g),datasets:[{data:pl.map(p=>+p.value.toFixed(2)),backgroundColor:pl.map(p=>hexA(techColor(p.techfuel),0.8)),borderWidth:0,barThickness:12}]}}
              options={{...cjDefaults(t),indexAxis:'y',scales:{x:{grid:{color:t.panelBorder},ticks:{color:t.muted,font:{size:8},callback:v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}},y:{grid:{display:false},ticks:{color:t.muted,font:{size:7}}}}}}
            />:<div style={{color:t.lblMuted,fontSize:'0.58rem'}}>No plant data for this zone.</div>}
          </div>;
        })()}
        <div style={{marginTop:24,paddingTop:12,borderTop:`1px solid ${t.panelBorder}`,fontSize:'0.48rem',color:t.lblMuted}}>
          Zone <b style={{color:t.lbl}}>{zoneIdDecoded}</b> · {countryName} · {region?.name}
        </div>
      </div>
    </div>
  );
}
