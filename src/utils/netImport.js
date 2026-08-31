// What a zone, a country or the region takes from everyone else.
//
// Four call sites used to read `NetImport` off pYearlyZoneMerged, where no such
// attribute exists. All four fell through to their `|| 0` and printed +0 TWh
// forever, NorthWest included, which imports 55.9 TWh in 2030 of the baseline.
//
// The attribute lives in pTransmissionMerged instead, indexed by zone pair, and it
// is the right source rather than a workaround. Checked over three scenarios and
// sixteen years: NetImport(a,b) is exactly antisymmetric on every reciprocal pair,
// so summing it over a group of zones cancels whatever flowed inside the group and
// leaves precisely its exchange with the outside. One formula therefore serves a
// zone, a country and the region.
//
// It also carries the external borders, which the Interchange sums elsewhere on
// these pages do not: Georgia in 2030 reads -1252 GWh on Interchange alone and +937
// here, the 2189 GWh difference being the Russian corridor.

/** Net import in GWh of `zones` taken together, for one year. Positive is imported. */
export function netImportGWh(tx, zones, year) {
  if (!tx || !year || !zones?.length) return 0;
  const y = String(year);
  let net = 0;
  for (const z of zones) {
    const zm = tx[z];
    if (!zm) continue;
    for (const attrs of Object.values(zm)) net += attrs?.NetImport?.[y] || 0;
  }
  return net;
}

/** The same, added up over a whole horizon. */
export function netImportCumulGWh(tx, zones, years) {
  return (years || []).reduce((s, y) => s + netImportGWh(tx, zones, y), 0);
}
