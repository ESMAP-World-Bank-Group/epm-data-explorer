// One hook, so the three results pages and the three inputs pages promote zones the
// same way and cannot drift apart.
//
// It sits between the fetched state and everything that reads it: the pages keep their
// raw state under `*Raw` names and take the promoted values back under the names the
// rest of the file already uses, so no consumer downstream has to know this happened.
// See utils/zoneClass for what promotion means and why a region would ask for it.
//
// Every field is optional. A page that has no external NTC, or no results, passes what
// it has; and for a region that named nothing, each promote* call hands its input
// straight back, so the memo settles on the identical objects and nothing re-renders.

import { useMemo } from 'react';
import {
  externalZonePlan, internalZcmap, promoteGeo, promoteExtNtc, promoteResults,
  warnUnmatchedExternal,
} from './zoneClass';

/** Zone of a row, with the same tolerance epmFetch's own readers use. */
const rowZone = r => r?.z || r?.zone || r?.Zone || '';

export function usePromotedZones(region, raw = {}) {
  const plan = useMemo(() => externalZonePlan(region), [region]);
  const { zcmapRows, zonesGJ, zonesExtGJ, extNtc, ntc, resultsData } = raw;

  return useMemo(() => {
    warnUnmatchedExternal(plan, zcmapRows);
    const geo = promoteGeo(zonesGJ, zonesExtGJ, plan);
    return {
      extPlan:    plan,
      zcmapRows:  internalZcmap(zcmapRows, plan),
      zonesGJ:    geo.zonesGJ,
      zonesExtGJ: geo.zonesExtGJ,
      extNtc:     promoteExtNtc(extNtc, ntc, plan),
      resultsData: promoteResults(resultsData, plan),
    };
  }, [plan, zcmapRows, zonesGJ, zonesExtGJ, extNtc, ntc, resultsData]);
}

// ── The inputs side ──────────────────────────────────────────────────────────
//
// The inputs pages carry everything in one `epmData` object, and unlike the results
// pages they do not read all their totals through the zone list: totalDemand() sums
// every row of `demand` it is given, so a promoted zone's demand would survive being
// dropped from zcmap. The per-zone series are therefore filtered here as well.

/** Rows whose zone is not promoted. */
const dropZoneRows = (rows, plan) =>
  (Array.isArray(rows) && plan.size ? rows.filter(r => !plan.isExternal(rowZone(r))) : rows);

/** A {zone: …} map without the promoted zones' entries. */
function dropZoneKeys(obj, plan) {
  if (!obj || !plan.size) return obj;
  const keys = Object.keys(obj).filter(z => plan.isExternal(z));
  if (!keys.length) return obj;
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}

export function usePromotedEpmData(region, epmData) {
  const plan = useMemo(() => externalZonePlan(region), [region]);

  return useMemo(() => {
    if (!plan.size || !epmData) return epmData;
    warnUnmatchedExternal(plan, epmData.zcmap);
    const geo = promoteGeo(epmData.zonesGJ, epmData.zonesExtGJ, plan);
    return {
      ...epmData,
      zcmap:      internalZcmap(epmData.zcmap, plan),
      zonesGJ:    geo.zonesGJ,
      zonesExtGJ: geo.zonesExtGJ,
      // The promoted zone's link becomes a border corridor, so it moves from the
      // internal transfer limits to the external ones rather than being deleted.
      extNtc:     promoteExtNtc(epmData.extNtc, epmData.ntc, plan),
      ntc:        Array.isArray(epmData.ntc) && plan.size
        ? epmData.ntc.filter(r => !plan.isExternal(r.z) && !plan.isExternal(r.z2))
        : epmData.ntc,
      gen:        dropZoneRows(epmData.gen, plan),
      demand:     dropZoneRows(epmData.demand, plan),
      demandProfileFull: dropZoneKeys(epmData.demandProfileFull, plan),
      vreProfile:        dropZoneKeys(epmData.vreProfile, plan),
      availability:      dropZoneKeys(epmData.availability, plan),
      fuelPrice:         dropZoneKeys(epmData.fuelPrice, plan),
    };
  }, [plan, epmData]);
}
