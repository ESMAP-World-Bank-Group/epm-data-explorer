// Ranking plants on one attribute of pPlantMerged.
//
// Four of the five attributes the Plants tab offers are written once per plant and
// year. CostsPlant is not: the model writes one row per cost category (Investment
// costs, Fixed O&M, Variable Cost, Spinning Reserve Cost) and the loader used to
// drop the `uni` column that carried the category. Ranking the raw rows therefore
// listed the same plant up to four times under the same name, and got the order
// wrong: in 2030 of the baseline run, 492 of the 527 plants had more than one row,
// and AKKUYU_1 read 336.7 (its investment line alone) where its 2030 cost is 586.6.
//
// So a ranking groups by plant before it sorts, and keeps the breakdown so a
// tooltip can say what the total is made of. A per-MWh figure and a share must not
// be added: the model writes exactly one row for those, and they keep that value
// rather than summing.
//
// The unit comes from the same table the CSV downloads are stamped with, so an axis
// label and a downloaded file can never drift apart.

import { RESULT_UNIT_BY_ATTRIBUTE } from './csvMeta';

/** Plant attributes that are ratios, never summed across rows. */
export const RATIO_PLANT_ATTRS = new Set(['PlantAnnualLCOE', 'UtilizationPlant']);

/**
 * How one plant attribute is shown: the unit to write on the axis and the factor
 * that brings the stored value into it. UtilizationPlant is stored as a share and
 * read as a percentage, which is how the LCOE bubble beside it has always shown it.
 */
export function plantDisplay(attribute) {
  if (attribute === 'UtilizationPlant') return { unit: '%', scale: 100 };
  return { unit: RESULT_UNIT_BY_ATTRIBUTE[attribute] || '', scale: 1 };
}

/**
 * The top `topN` plants of one scenario on one attribute for one year.
 *
 * @param plants    the scenario's `plants` rows, as processPlants leaves them
 * @param attribute the pPlantMerged attribute to rank on
 * @param year      the year, as a string
 * @param topN      how many plants to keep
 * @param keep      optional row filter, used by the pages to restrict the zones
 *
 * Returns [{ g, z, c, techfuel, value, parts, n }] sorted by value, descending.
 * `value` is already in the unit `plantDisplay` names, and `parts` holds the cost
 * categories that make it up, largest first, empty when the attribute has none.
 */
export function rankPlants(plants, { attribute, year, topN = 20, keep } = {}) {
  const { scale } = plantDisplay(attribute);
  const isRatio = RATIO_PLANT_ATTRS.has(attribute);
  const by = new Map();
  for (const p of plants || []) {
    if (p.attribute !== attribute || p.y !== year) continue;
    if (keep && !keep(p)) continue;
    let e = by.get(p.g);
    if (!e) { e = { g:p.g, z:p.z, c:p.c, techfuel:p.techfuel, value:0, parts:[], n:0 }; by.set(p.g, e); }
    const v = (p.value || 0) * scale;
    if (isRatio) { if (e.n === 0) e.value = v; }
    else e.value += v;
    e.n += 1;
    if (p.cat) e.parts.push({ cat:p.cat, value:v });
  }
  for (const e of by.values()) e.parts.sort((a, b) => b.value - a.value);
  // The plant name breaks ties, so a ranking does not depend on the order the rows
  // happened to arrive in: several units of the same station reach the same value to
  // the last digit, and without this they would swap places between two renders.
  return [...by.values()].filter(e => e.value > 0)
    .sort((a, b) => b.value - a.value || a.g.localeCompare(b.g)).slice(0, topN);
}

/** A value with as many decimals as it needs and no more. */
export function plantFmt(v) {
  if (v == null || isNaN(v)) return '\u2014';
  const a = Math.abs(v);
  return v.toLocaleString('en-US', { maximumFractionDigits: a >= 100 ? 0 : a >= 10 ? 1 : 2 });
}
