/**
 * The physical indicators of the Summary tab, shared by the region and the country page
 * so the two never drift. `zones` is the only difference between them: the region passes
 * every zone, a country page passes its own.
 *
 * Everything here is undiscounted and read straight off the annual files. The cost of the
 * study — the discounted NPV the deck prints — lives in utils/npv.js instead.
 */

import { netImportGWh, netImportCumulGWh } from './netImport';

/** Renewables, by the techfuel labels EPM writes. */
const RE = new Set(['Solar','PV','CSP','RPV','OnshoreWind','Onshore Wind','OffshoreWind',
  'Offshore Wind','Reservoir','ReservoirHydro','ROR','PSH','Biomass','Geothermal']);

/**
 * @param sd        one scenario of resultsData
 * @param zones     zones to sum over
 * @param years     every year of the horizon
 * @param lastY     the horizon's last year
 * @param costCats  cost categories to break out (MAIN_COST_CATS)
 */
export function physicalStats(sd, zones, years, lastY, costCats = []) {
  if (!sd) return {};
  const yZS = k => zones.reduce((s,z)=>{ for(const y of years) s+=(sd.yearlyZone[z]?.[k]?.[y]||0); return s; },0);
  const yZL = k => zones.reduce((s,z)=>s+(sd.yearlyZone[z]?.[k]?.[lastY]||0),0);
  const ebS = k => zones.reduce((s,z)=>{ for(const y of years) s+=(sd.energyBalance?.[z]?.[k]?.[y]||0); return s; },0);

  let cT=0,cR=0,gT=0,gR=0;
  for (const z of zones) {
    for (const [tf,v] of Object.entries(sd.techFuel[z]?.CapacityTechFuel?.[lastY]||{}))   { cT+=v; if(RE.has(tf)) cR+=v; }
    for (const [tf,v] of Object.entries(sd.techFuel[z]?.GenerationTechFuel?.[lastY]||{})) { gT+=v; if(RE.has(tf)) gR+=v; }
  }

  const cc={}; let ct=0;
  for (const cat of costCats) {
    let v=0; for(const z of zones) for(const y of years) v+=(sd.costs[z]?.[cat]?.[y]||0);
    cc[cat]=v; ct+=v;
  }

  const demCumul = yZS('DemandEnergyZone')/1000;          // TWh
  const demLast  = yZL('DemandEnergyZone')/1000;          // TWh/yr
  const peak     = yZL('DemandPeakZone')/1000;            // GW — coincident only within a zone
  const co2Cumul = yZS('EmissionsZone');                  // Mt, already
  const co2Last  = yZL('EmissionsZone');
  const unmet    = ebS('Unmet demand: GWh');
  const surplus  = ebS('Surplus generation: GWh');

  return {
    demCumul, demLast,
    cT:cT/1000, cR:cR/1000,
    cRsh: cT>0?(cR/cT)*100:null,
    gRsh: gT>0?(gR/gT)*100:null,
    peak,
    // Sum of zonal peaks, not a regional coincident peak: EPM writes no regional one.
    resMargin: peak>0?((cT/1000-peak)/peak)*100:null,
    // Net import comes from the transmission pairs, not from yearlyZone, which
    // carries no such attribute -- see utils/netImport. Flows between two zones of
    // `zones` cancel, so this is the selection's exchange with everything outside it.
    niCumul: netImportCumulGWh(sd.transmission, zones, years)/1000,
    niLast:  netImportGWh(sd.transmission, zones, lastY)/1000,
    co2Cumul, co2Last,
    // Mt/TWh -> kg/MWh is a factor of 1000.
    co2Int: demLast>0?(co2Last/demLast)*1000:null,
    unmet, unmetPct: demCumul>0?(unmet/(demCumul*1000))*100:null,
    surplus,
    costTotal: ct,
    // M$ over TWh is $/MWh outright. Undiscounted, unlike everything in the NPV block.
    costPerMWh: demCumul>0?ct/demCumul:null,
    ...cc,
  };
}
