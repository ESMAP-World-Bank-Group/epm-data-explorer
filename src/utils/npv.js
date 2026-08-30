// --- Net present cost, and where a scenario's difference comes from ---
//
// EPM discounts as it reports: pCostsMerged carries every cost line twice, once as the
// undiscounted cost of the year (attribute 'Costs') and once as the discounted running
// total ('DiscountedWeightedCostsCumulated'). The last year of the second one IS the NPV,
// per zone and per cost line, on the model's own year factors. Nothing here re-applies a
// discount rate, and nothing should: EPM's factors carry a half-year convention that a
// rebuild from DR alone misses quietly.
//
// Two pieces of the objective are not in that file:
//
//   * Generation capex, which pCosts does not carry at all. summary.csv, at the run root,
//     does -- 'Investment costs: $m', per zone and year, the annuity the objective pays.
//     Discounting it needs the year factors, recovered from pCostsMerged itself: the
//     discounted step of a year over its undiscounted cost is pWeightYear * pRR, exactly.
//   * Capex of the *external* interconnectors. The model never sees it (pExtTransferLimit
//     carries no investment variable), so no output can be made to yield it. A run may
//     publish it beside summary.csv as npv_external.csv; without that file the component
//     is absent, and the UI says so rather than pretending the corridors were free.
//
// Everything is checked back against the model's own 'NPV of system cost'
// (pNetPresentCostSystemMerged). A decomposition that does not sum back to it means the
// map below is missing a line this particular model writes -- so the residual is reported
// rather than swallowed, and the caller can refuse to draw a total the model disowns.
//
// The conventions here mirror tools/results_report/slides_regional.py in the blacksea
// study, which is what the printed deck is built from. Keep the two in step.

/** Year keys arrive as '2025' from summary.csv and '2025.0' from pCostsMerged. */
const yr = v => String(v ?? '').trim().replace(/\.0+$/, '');

const TOTAL_LINE = 'NPV of system cost: $m';
const CAPEX_ATTR = 'Investment costs: $m';
const DISCOUNTED = 'DiscountedWeightedCostsCumulated';

/** Stacking and legend order. Signs are COST signs: a positive NPV is money the system
 *  spends, so a benefit against a counterfactual is counterfactual minus scenario. */
export const NPV_COMPONENTS = [
  { key:'exp_ext', label:'Export revenue, external',      color:'#C9A227' },
  { key:'fuel',    label:'Fuel cost',                     color:'#2F3F57' },
  { key:'capex',   label:'Generation capex',              color:'#8FB3D4' },
  { key:'fom',     label:'Fixed O&M',                     color:'#6F97BD' },
  { key:'vom',     label:'Variable O&M',                  color:'#33628F' },
  { key:'res',     label:'Reserve and unserved',          color:'#8A97A8' },
  { key:'carbon',  label:'Carbon cost',                   color:'#6E7C8C' },
  { key:'other',   label:'Other',                         color:'#9AA5A0' },
  { key:'trans',   label:'Transmission capex, internal',  color:'#7FB0A3' },
  { key:'imp_ext', label:'Import cost, external',         color:'#E0CD8F' },
  { key:'newcap',  label:'Transmission capex, external',  color:'#C0392B' },
  { key:'int_net', label:'Internal trade, net',           color:'#B9C2CC' },
  { key:'exp_int', label:'Export revenue, internal',      color:'#ECCB72' },
  { key:'imp_int', label:'Import cost, internal',         color:'#D7DDE5' },
  { key:'shared',  label:'Trade shared benefits',         color:'#9C8AB5' },
];
export const NPV_COMP = Object.fromEntries(NPV_COMPONENTS.map(c => [c.key, c]));

/** Internal trade is a transfer between zones of the same region: these three lines sum
 *  to zero region-wide by construction. Left apart they draw as three large bars that
 *  annihilate, so a whole-region view merges them; a per-country view must not, because
 *  that is exactly where they stop cancelling. */
const INTERNAL = ['exp_int', 'imp_int', 'shared'];

/** pCosts line -> [component, sign]. Anything a model writes that is not named here lands
 *  in 'other': those lines are usually pennies, but they have to go somewhere or the
 *  decomposition stops adding up to the model's NPV. */
const LINE_TO_COMP = {
  'Fuel costs: $m':                           ['fuel',    1],
  'Fixed O&M: $m':                            ['fom',     1],
  'Variable O&M: $m':                         ['vom',     1],
  'Transmission costs: $m':                   ['trans',   1],
  'Import costs with external zones: $m':     ['imp_ext', 1],
  // generate_report.gms writes this one as a positive magnitude, but base.gms:679
  // subtracts it from the objective. Flip it or the NPV will not reconcile.
  'Export revenues with external zones: $m':  ['exp_ext', -1],
  'Import costs with internal zones: $m':     ['imp_int', 1],
  'Export revenues with internal zones: $m':  ['exp_int', 1],
  'Trade shared benefits: $m':                ['shared',  1],
  'Carbon costs: $m':                         ['carbon',  1],
  'Unmet country CO2 backstop cost: $m':      ['carbon',  1],
  'Unmet system CO2 backstop cost: $m':       ['carbon',  1],
  'Unmet demand costs: $m':                   ['res',     1],
  'Unmet country planning reserve costs: $m': ['res',     1],
  'Unmet system planning reserve costs: $m':  ['res',     1],
  'Unmet country spinning reserve costs: $m': ['res',     1],
  'Unmet system spinning reserve costs: $m':  ['res',     1],
  'Spinning reserve costs: $m':               ['res',     1],
  'VRE curtailment: $m':                      ['other',   1],
  'Startup costs: $m':                        ['other',   1],
  'Excess generation: $m':                    ['other',   1],
  'Generation costs: $m':                     ['other',   1],
};

/**
 * Parse pCostsMerged once into everything the NPV needs:
 *   byZone      { zone: { cost line: $m } } -- the discounted total at the last year
 *   zoneCountry { zone: country }           -- the file's own c column, used when the
 *                                              caller has no zcmap to hand
 *   factors     { year: pWeightYear * pRR } -- for discounting anything pCosts omits
 * Returns null when the file carries no discounted block at all (an old run, a model
 * built without one): the caller then has no NPV to show, which is a state, not a bug.
 */
export function processNpvInput(rows) {
  if (!rows?.length) return null;
  const cum = {};          // line -> year -> $m (summed over zones)
  const ann = {};          // line -> year -> $m
  const byZoneYear = {};   // zone -> line -> year -> $m
  const zoneCountry = {};
  const years = new Set();

  for (const r of rows) {
    const line = (r.uni || '').trim();
    if (!line || line === TOTAL_LINE) continue;   // the total is the check, not a part
    const z = (r.z || '').trim();
    const y = yr(r.y);
    const v = parseFloat(r.value);
    if (!z || !y || !Number.isFinite(v)) continue;
    if (r.c) zoneCountry[z] = r.c.trim();
    years.add(y);
    if (r.attribute === DISCOUNTED) {
      (cum[line] ||= {})[y] = (cum[line][y] || 0) + v;
      ((byZoneYear[z] ||= {})[line] ||= {})[y] = v;
    } else if (r.attribute === 'Costs') {
      (ann[line] ||= {})[y] = (ann[line][y] || 0) + v;
    }
  }
  const sorted = [...years].sort();
  if (!sorted.length || !Object.keys(cum).length) return null;
  const last = sorted[sorted.length - 1];

  const byZone = {};
  for (const [z, lines] of Object.entries(byZoneYear)) {
    for (const [line, byY] of Object.entries(lines)) {
      const v = byY[last];
      if (v) (byZone[z] ||= {})[line] = v;
    }
  }

  // Year factors. The discounted step of one year over its undiscounted cost is the
  // factor -- per cost line, so summing |step| and |cost| over the lines keeps it exact
  // and immune to the sign cancellation a plain sum would suffer (export revenues are
  // reported against costs).
  const factors = {};
  sorted.forEach((y, i) => {
    const prev = i ? sorted[i - 1] : null;
    let step = 0, base = 0;
    for (const line of Object.keys(cum)) {
      step += Math.abs((cum[line][y] || 0) - (prev ? (cum[line][prev] || 0) : 0));
      base += Math.abs(ann[line]?.[y] || 0);
    }
    if (base > 1e-9) factors[y] = step / base;
  });

  return { byZone, zoneCountry, factors, years: sorted, lastYear: last };
}

/** The model's own NPV of system cost, from pNetPresentCostSystemMerged. This is the
 *  number the decomposition has to reproduce; null when the run did not write the file. */
export function processNpvSystem(rows) {
  if (!rows?.length) return null;
  for (const r of rows) {
    if (r.attribute === 'NetPresentCostSystem' && (r.uni || '').trim() === TOTAL_LINE) {
      const v = parseFloat(r.value);
      if (Number.isFinite(v)) return v;
    }
  }
  return null;
}

/** Discounted generation capex by zone, $m, from the yearly annuities in summary.csv.
 *  `found` is false when the run published no summary, or none for this scenario: the
 *  component is then missing, not zero, and the caller has to say which. */
export function capexNpvByZone(summaryRows, scen, factors) {
  const byZone = {};
  if (!summaryRows?.length || !scen || !factors) return { byZone, found: false };
  let found = false;
  for (const r of summaryRows) {
    if ((r.attribute || '').trim() !== CAPEX_ATTR) continue;
    const z = (r.zone || '').trim();
    const y = yr(r.year);
    // summary.csv repeats every block as a System row, and carries the scenario's whole
    // NPV on the year-less one. Both would double count against the per-zone annuities.
    if (!z || z === 'System' || !y) continue;
    const v = parseFloat(r[scen]);
    if (!Number.isFinite(v)) continue;
    found = true;
    const f = factors[y];
    if (f) byZone[z] = (byZone[z] || 0) + v * f;
  }
  return { byZone, found };
}

/**
 * The NPV of every scenario, by component and by country.
 *
 * `resultsData[scen]` is expected to carry `npvRaw` (processNpvInput) and `npvSystem`
 * (processNpvSystem). `extNpv` is the optional { scenario: { zone: $m } } of external
 * interconnector capex a run publishes alongside summary.csv.
 *
 * `zoneToCountry` is the grouping, and may be a map or a function. `z => z` groups by
 * zone, which is what a single-country page wants: `byCountry` is then keyed by zone and
 * `countries` lists them. The scenario totals and the residual are unaffected -- they sum
 * every zone whatever the grouping -- so the check against the model stays system-wide
 * even when the caller goes on to show one country's slice.
 */
export function buildNpv({ scenarios, resultsData, summaryRows, extNpv, zoneToCountry }) {
  const byScen = {};
  const countries = new Set();

  for (const scen of scenarios || []) {
    const sd  = resultsData?.[scen];
    const raw = sd?.npvRaw;
    if (!raw) continue;
    const look   = typeof zoneToCountry === 'function' ? zoneToCountry : (z => zoneToCountry?.[z]);
    const nameOf = z => look(z) || raw.zoneCountry[z] || z;

    const byCountry = {};
    const add = (country, comp, v) => {
      if (!v || !Number.isFinite(v)) return;
      (byCountry[country] ||= {})[comp] = (byCountry[country][comp] || 0) + v;
      countries.add(country);
    };

    for (const [zone, lines] of Object.entries(raw.byZone)) {
      for (const [line, v] of Object.entries(lines)) {
        const [comp, sign] = LINE_TO_COMP[line] || ['other', 1];
        add(nameOf(zone), comp, sign * v);
      }
    }
    const cap = capexNpvByZone(summaryRows, scen, raw.factors);
    for (const [zone, v] of Object.entries(cap.byZone)) add(nameOf(zone), 'capex', v);
    for (const [zone, v] of Object.entries(extNpv?.[scen] || {})) add(nameOf(zone), 'newcap', v);

    // Region totals, with internal trade merged: see INTERNAL.
    const { comps, total } = aggregateNpv(byCountry, Object.keys(byCountry), true);
    // The model's NPV knows nothing about external interconnector capex, so the check has
    // to be made on the part of the decomposition it does cover.
    const modelTotal = sd?.npvSystem ?? null;
    const checked = total - (comps.newcap || 0);
    byScen[scen] = {
      comps, byCountry, total, modelTotal,
      residual: modelTotal == null ? null : checked - modelTotal,
      hasCapex: cap.found,
      hasExternal: !!Object.keys(extNpv?.[scen] || {}).length,
    };
  }

  return { byScen, countries: [...countries].sort() };
}

/**
 * Sum a per-group decomposition (`byCountry` above, or by zone when the caller grouped
 * that way) over a chosen set of groups.
 *
 * `merge` folds the three internal-trade lines into one net line. That is right for a
 * whole region, where they cancel to zero by construction and would otherwise draw as
 * three large annihilating bars, and wrong for any slice of one: a country's exports to
 * its neighbours are real money to that country.
 */
export function aggregateNpv(byGroup, keys, merge = false) {
  const comps = {};
  let total = 0;
  for (const k of keys || []) {
    for (const [c, v] of Object.entries(byGroup?.[k] || {})) {
      const key = merge && INTERNAL.includes(c) ? 'int_net' : c;
      comps[key] = (comps[key] || 0) + v;
      total += v;
    }
  }
  return { comps, total };
}

/** Counterfactual minus scenario, per component: positive is a benefit. */
export function npvDelta(refComps, scenComps) {
  const out = {};
  for (const k of new Set([...Object.keys(refComps || {}), ...Object.keys(scenComps || {})]))
    out[k] = (refComps?.[k] || 0) - (scenComps?.[k] || 0);
  return out;
}

/** Components worth drawing, in stacking order: anything that moves at least $1m in one
 *  of the columns, or a thousandth of the largest column, whichever is larger. Keeps a
 *  legend of fifteen entries down to the handful a given run actually uses. */
export function visibleComps(columns) {
  const cols = (columns || []).filter(Boolean);
  const scale = Math.max(...cols.map(c => Object.values(c).reduce((s, v) => s + Math.abs(v), 0)), 0);
  const floor = Math.max(1, scale * 0.001);
  return NPV_COMPONENTS.filter(({ key }) => cols.some(c => Math.abs(c[key] || 0) >= floor));
}
