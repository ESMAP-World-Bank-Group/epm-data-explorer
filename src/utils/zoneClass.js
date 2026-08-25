// Which zones a study actually treats as its own, and which ones only sit in the
// solver for the arithmetic.
//
// EPM's answer is structural and not negotiable: a zone in `zones` is internal, a zone
// in `zext` is external. That answer is right for the model and incomplete for the
// reader, because a study sometimes carries a zone through the solver that is not part
// of the system under study. Black Sea's `iran_swap` is the case: Armenia barters gas
// for electricity with Iran, and the Iranian margin on that barter is represented as a
// zone so the flows balance. Nobody here is planning Iran's grid. Counted as internal,
// every MWh Armenia swaps reads as trade the region did with itself, its 1100 GWh of
// placeholder demand lands in the regional total, and `iran_swap` turns up in the
// country selector next to Georgia.
//
// So a region may name those zones in regions.json, under `epm.externalZones`, and this
// module moves them across the line *before any page sees them*. Everything downstream
// then works unchanged: what counts internal zones stops counting them, what draws
// external ones starts drawing them. Adding another exception is one string in
// regions.json and no code at all.
//
//   "externalZones": ["iran_swap"]                                  own identity
//   "externalZones": [{ "zone": "iran_swap", "label": "Iran (swap)" }]     …named
//   "externalZones": [{ "zone": "iran_swap", "as": "Iran" }]         folded onto Iran
//
// `as` exists because a promoted zone can collide with a real one. Black Sea already
// carries `Iran` as a genuine external zone, with its own polygon and its own corridors
// from Armenia, Nakhchivan, AzerbaijanMain and EastAna — and `iran_swap` carries
// ISO_A3 = IRN, so promoting it on its own identity would put a second Iran-shaped grey
// polygon on top of the first. `as` says "this is the same border, show it there": no
// second polygon, no second node, and the swap adds to the exchange already drawn.
//
// What this does NOT do is touch the model. iran_swap remains a zone GAMS solved; the
// inputs and the run are untouched. This is a presentation convention, and deleting the
// string from regions.json puts everything back.
//
// Zone ids come from GAMS, which is case-insensitive, so the matching is too.

const lc = z => String(z ?? '').toLowerCase();

/** Attributes that are ratios, not quantities. When two arrangements are folded onto
 *  one border, quantities add and ratios do not — a corridor used 46% of the time and
 *  one used 9% is not one used 55%. Take the harder-worked of the two instead. */
const RATIO_ATTRS = new Set(['InterconUtilization', 'CongestionShare']);

const EMPTY_PLAN = {
  size: 0,
  isExternal: () => false,
  aliasOf: z => z,
  labelOf: z => z,
  names: [],
};

/** Reads `epm.externalZones` into the one object every function here takes.
 *  Regions that named nothing — which is all of them but Black Sea — get a shared
 *  no-op plan, so `plan.size` is the cheap test for "skip all of this". */
export function externalZonePlan(region) {
  const named = region?.epm?.externalZones;
  if (!Array.isArray(named) || named.length === 0) return EMPTY_PLAN;

  const alias = new Map();   // lowercased id -> the external zone it is presented as
  const label = new Map();   // lowercased id -> display name
  const names = [];
  for (const entry of named) {
    const zone = typeof entry === 'string' ? entry : entry?.zone;
    if (!zone) continue;
    const key = lc(zone);
    const as = (typeof entry === 'object' && entry?.as) || zone;
    alias.set(key, as);
    label.set(key, (typeof entry === 'object' && entry?.label) || as);
    names.push(zone);
  }
  if (!alias.size) return EMPTY_PLAN;

  return {
    size: alias.size,
    isExternal: z => alias.has(lc(z)),
    aliasOf: z => alias.get(lc(z)) ?? z,
    labelOf: z => label.get(lc(z)) ?? z,
    names,
  };
}

/** A name in regions.json that matches no zone is the failure mode this whole feature
 *  had before it worked: the setting is there, nothing happens, and nothing says why.
 *  Warned once per region, in dev only. */
export function warnUnmatchedExternal(plan, zcmapRows) {
  if (!import.meta.env?.DEV || !plan?.size || !zcmapRows?.length) return;
  const known = new Set(zcmapRows.map(r => lc(r.z)));
  const missing = plan.names.filter(z => !known.has(lc(z)));
  if (missing.length)
    console.warn(`[externalZones] named in regions.json but not a zone in zcmap: ${missing.join(', ')}`);
}

// ── The promotion itself ─────────────────────────────────────────────────────

/** zcmap without the promoted zones. This is the choke point: `allZones`,
 *  `allCountries`, `zoneToCountry` and every regional total derive from it, so a zone
 *  dropped here leaves the selectors, the mixes, the KPIs and the sums at once. */
export function internalZcmap(rows, plan) {
  if (!plan?.size || !rows?.length) return rows;
  return rows.filter(r => !plan.isExternal(r.z));
}

/** Moves the promoted zones' geometry from the internal geojson to the external one.
 *  A zone folded onto another with `as` is only removed: the target already has a
 *  polygon and a node, and drawing a second one over it is the collision `as` exists
 *  to avoid. A zone whose `as` target is missing from zones_ext falls back to carrying
 *  its own geometry, so a typo degrades to "shown on its own" and not to "invisible". */
export function promoteGeo(zonesGJ, zonesExtGJ, plan) {
  if (!plan?.size) return { zonesGJ, zonesExtGJ };

  const extHas = new Set((zonesExtGJ?.features || []).map(f => lc(f.properties?.z)));
  const keep = [], moved = [];
  for (const f of zonesGJ?.features || []) {
    const z = f.properties?.z;
    if (!plan.isExternal(z)) { keep.push(f); continue; }
    const as = plan.aliasOf(z);
    if (extHas.has(lc(as))) continue;                      // folded onto a real one
    moved.push({ ...f, properties: { ...f.properties, z: as, c: as, type: 'external' } });
  }
  if (keep.length === (zonesGJ?.features?.length ?? 0)) return { zonesGJ, zonesExtGJ };

  return {
    zonesGJ: zonesGJ ? { ...zonesGJ, features: keep } : zonesGJ,
    zonesExtGJ: moved.length
      ? { type: 'FeatureCollection', ...(zonesExtGJ || {}),
        features: [...(zonesExtGJ?.features || []), ...moved] }
      : zonesExtGJ,
  };
}

/** Adds the promoted zones' corridors to the external NTC list, taken from the internal
 *  transfer limits they used to live in. Without this a promoted zone is a grey polygon
 *  wired to nothing: the external corridors are drawn from pExtTransferLimit, and a zone
 *  that was internal is, by definition, absent from it.
 *
 *  ntc rows are {z, z2, years}; either end may be the promoted one, and the result is
 *  always oriented (z = the internal zone, zext = the promoted one). Only the inputs
 *  maps need this — the results maps discover the same pair from the flows themselves. */
export function promoteExtNtc(extNtc, ntc, plan) {
  if (!plan?.size || !ntc?.length) return extNtc;

  const add = new Map();
  for (const r of ntc) {
    const aExt = plan.isExternal(r.z), bExt = plan.isExternal(r.z2);
    if (aExt === bExt) continue;                     // internal-internal, or both promoted
    const z = aExt ? r.z2 : r.z;
    const zext = plan.aliasOf(aExt ? r.z : r.z2);
    const key = `${z}||${zext}`;
    const prev = add.get(key);
    // pTransferLimit carries both directions of the same link; one corridor, so the
    // capacity is the larger of the two rather than their sum.
    if (!prev) add.set(key, { z, zext, years: { ...r.years } });
    else for (const [y, v] of Object.entries(r.years || {}))
      prev.years[y] = Math.max(prev.years[y] || 0, v || 0);
  }
  if (!add.size) return extNtc;

  // A promoted corridor folded onto a border that already has one adds to its capacity:
  // the barter link and the commercial interconnection are two real sets of wires.
  const out = (extNtc || []).map(r => ({ ...r, years: { ...r.years } }));
  for (const row of add.values()) {
    const hit = out.find(r => lc(r.z) === lc(row.z) && lc(r.zext) === lc(row.zext));
    if (!hit) { out.push(row); continue; }
    for (const [y, v] of Object.entries(row.years)) hit.years[y] = (hit.years[y] || 0) + (v || 0);
  }
  return out;
}

/** Re-keys the transmission results so a promoted zone answers to the name it is shown
 *  under. tx is {z: {counterparty: {attribute: {year: value}}}} and a promoted zone
 *  appears on both levels — Armenia's row has it as a counterparty, and it has a row of
 *  its own — so both are rewritten.
 *
 *  Folding two corridors onto one border makes the attributes meet. Quantities add,
 *  which is what two sets of wires on the same border actually do; ratios take the
 *  maximum (see RATIO_ATTRS). */
export function promoteTransmission(tx, plan) {
  if (!plan?.size || !tx) return tx;
  let touched = false;

  const mergeYears = (into, from, attr) => {
    for (const [y, v] of Object.entries(from || {})) {
      if (into[y] == null) into[y] = v;
      else into[y] = RATIO_ATTRS.has(attr) ? Math.max(into[y], v) : into[y] + v;
    }
  };
  const mergeAttrs = (into, from) => {
    for (const [attr, years] of Object.entries(from || {})) {
      if (!into[attr]) into[attr] = { ...years };
      else mergeYears(into[attr], years, attr);
    }
  };

  const out = {};
  for (const [z, byPartner] of Object.entries(tx)) {
    const zKey = plan.isExternal(z) ? plan.aliasOf(z) : z;
    if (zKey !== z) touched = true;
    const row = out[zKey] ||= {};
    for (const [z2, attrs] of Object.entries(byPartner || {})) {
      const pKey = plan.isExternal(z2) ? plan.aliasOf(z2) : z2;
      if (pKey !== z2) touched = true;
      if (!row[pKey]) row[pKey] = Object.fromEntries(
        Object.entries(attrs || {}).map(([a, ys]) => [a, { ...ys }]));
      else mergeAttrs(row[pKey], attrs);
    }
  }
  return touched ? out : tx;
}

/** The same, applied across every scenario of a results payload. Only `transmission` is
 *  rewritten: the per-zone series (dispatch, energy balance, tech-fuel, costs) are read
 *  by looping the zone list, and a promoted zone has already left it. */
export function promoteResults(resultsData, plan) {
  if (!plan?.size || !resultsData) return resultsData;
  let touched = false;
  const out = {};
  for (const [scen, sd] of Object.entries(resultsData)) {
    const tx = promoteTransmission(sd?.transmission, plan);
    if (tx !== sd?.transmission) { touched = true; out[scen] = { ...sd, transmission: tx }; }
    else out[scen] = sd;
  }
  return touched ? out : resultsData;
}

// ── Back-compat shims ────────────────────────────────────────────────────────
// annualExtras still takes a plain Set of names. Kept so the trade split keeps working
// while the chart side moves over.

const NONE = new Set();

/** The zones this region asked to have presented as external, lowercased. */
export function externalZoneSet(region) {
  const plan = externalZonePlan(region);
  if (!plan.size) return NONE;
  return new Set(plan.names.map(lc));
}

/** `zones` without the ones named external — i.e. the zones that count as inside. */
export function internalOnly(zones, extSet) {
  if (!extSet?.size || !zones?.length) return zones;
  return zones.filter(z => !extSet.has(lc(z)));
}
