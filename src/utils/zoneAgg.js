// Aggregating a per-zone yearly attribute over several zones.
//
// Most of what pYearlyZoneMerged carries is a quantity: emissions, demand, costs. Add
// the zones and you have the region. A few attributes are ratios, and adding those is
// meaningless — thirteen zones at ~35 USD/MWh do not make a region at 456 USD/MWh, which
// is nevertheless what the Evolution and Snapshot charts showed until 2026-08-31.
//
// The right aggregate for a per-MWh figure is the energy weighted average, and the weight
// is in the same file: DemandEnergyZone. It is exact rather than approximate, since the
// model builds these ratios on that very denominator — CostsPerMWh is Costs over
// DemandEnergyZone zone by zone, to the last digit.
//
// The decision is taken on the attribute name rather than on a flag each page sets, so a
// ratio exposed later is handled the day it is exposed and cannot be aggregated wrongly
// by a call site that forgot the flag.

/** Attributes of pYearlyZoneMerged that are ratios and must never be summed. */
export const RATIO_ZONE_ATTRS = new Set([
  'GenCostsPerMWh',
  'CostsPerMWh',
  'EmissionsIntensityZone',
]);

export const isRatioZoneAttr = key => RATIO_ZONE_ATTRS.has(key);

/**
 * One attribute of one scenario, aggregated over `zs` for year `y`.
 *
 * @param yz  the scenario's yearlyZone map, zone -> attribute -> year -> value
 * @param key the attribute
 * @param zs  the zones to aggregate over; a single one gives that zone's own value
 * @param y   the year
 *
 * Quantities are summed. Ratios are averaged, weighted by the zones' demand, and fall
 * back to a plain mean where no zone in the selection has any demand to weight with, so
 * a zero demand zone still reads out its own number instead of a spurious zero.
 */
export function yzAgg(yz, key, zs, y) {
  if (!RATIO_ZONE_ATTRS.has(key)) return zs.reduce((s, z) => s + (yz?.[z]?.[key]?.[y] || 0), 0);
  let num = 0, w = 0, sum = 0, n = 0;
  for (const z of zs) {
    const v = yz?.[z]?.[key]?.[y];
    if (typeof v !== 'number') continue;
    sum += v; n += 1;
    const q = yz?.[z]?.DemandEnergyZone?.[y] || 0;
    if (q > 0) { num += v * q; w += q; }
  }
  if (w > 0) return num / w;
  return n > 0 ? sum / n : 0;
}
