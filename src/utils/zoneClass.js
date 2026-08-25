// Which zones a study actually treats as its own, and which ones only sit in the
// solver for the arithmetic.
//
// EPM's answer is structural and not negotiable: a zone in `zones` is internal, a zone
// in `zext` is external. That answer is right for the model and incomplete for the
// reader, because a study sometimes carries a zone through the solver that is not part
// of the system under study. Black Sea's `iran_swap` is the case: an Iranian swap node,
// modelled as a zone so the flows balance, but nobody here is planning Iran's grid.
// Counted as internal, every MWh the region swaps through it reads as trade the region
// did with itself, which makes it look more self-sufficient than it is.
//
// So a region may name those zones in regions.json, under `epm.externalZones`, and the
// int/ext line moves for them: their trade with the region counts as external, and the
// line capacity to them counts as a border interconnection.
//
// What this deliberately does NOT do is remove them. The model solved them; their
// generation, demand and costs are real numbers and stay in the region's totals. This
// only says which side of the border they sit on.
//
// Zone ids come from GAMS, which is case-insensitive, so the matching is too.

const NONE = new Set();

/** The zones this region asked to have presented as external, lowercased.
 *  An empty set — the normal case — is shared, so callers can test `.size` to skip. */
export function externalZoneSet(region) {
  const named = region?.epm?.externalZones;
  if (!Array.isArray(named) || named.length === 0) return NONE;
  return new Set(named.map(z => String(z).toLowerCase()));
}

/** `zones` without the ones named external — i.e. the zones that count as inside.
 *  Returns the input untouched when nothing was named, which is most regions. */
export function internalOnly(zones, extSet) {
  if (!extSet?.size || !zones?.length) return zones;
  return zones.filter(z => !extSet.has(String(z).toLowerCase()));
}
