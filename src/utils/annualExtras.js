// What a generation chart leaves out.
//
// The annual charts stack generation by techfuel, which is only part of the story:
// a zone covers its demand with what it produces, what it imports, and — when the
// model runs out of options — with demand it does not serve at all. Those three are
// in the same unit and belong in the same stack, so the top of the bar finally
// matches demand instead of falling short of it by the net import.
//
// In MW the counterpart is not another block: plant capacity and line capacity are
// both megawatts but they do not add up to anything. Those are drawn as lines over
// the stack, as a reference for how much of it can actually move.
//
// Everything is split into flows that stay inside the zones on screen and flows
// that leave them, because looking at a region you want to see both, and looking at
// one zone the distinction disappears on its own. Internal imports and internal
// exports are the same flows read from either end and so are exactly equal: adding
// both to an energy stack leaves the net, and therefore the balance against demand,
// where it was.

import { fillFor, techColor, cssFillFor, seriesRank } from './chartColors';

/** Which indicators get extras, and of which kind. */
const EXTRA_KIND = {
  EnergyTechFuelComplete:       'energy',
  CapacityTechFuel:             'capacity',
  NewCapacityTechFuel:          'capacity',
  NewCapacityTechFuelCumulated: 'capacity',
};

const CAP_ATTR = { CapacityTechFuel: 'TransmissionCapacity' }; // the others are additions
const CAP_LABEL = {
  CapacityTechFuel:             'Line capacity',
  NewCapacityTechFuel:          'New line capacity',
  NewCapacityTechFuelCumulated: 'Cum. new line cap.',
};

/** Transmission is not a fuel, so it gets its own pair of hues rather than
 *  borrowing the import red or the export green. */
export const GRID_COLOR = { ext: '#E67E22', int: '#F0B27A' };

const CAP_SIDE = Object.fromEntries(Object.values(CAP_LABEL).flatMap(
  n => [[`${n} (int.)`, 'int'], [`${n} (ext.)`, 'ext']]));

const r0 = (v) => +(v || 0).toFixed(0);

export function extraKind(indKey) { return EXTRA_KIND[indKey] || null; }

/** GWh exchanged in year `y` between `zones` and everything else, split into the
 *  part that stays within `zones` and the part that crosses out of it.
 *  tx[from][to].Interchange[y] is energy flowing from → to, in GWh. */
export function tradeSplit(tx, zones, y) {
  const zSet = new Set(zones);
  const out = { impInt: 0, impExt: 0, expInt: 0, expExt: 0 };
  for (const z of zones) {
    for (const [z2, attrs] of Object.entries(tx?.[z] || {})) {
      const v = attrs.Interchange?.[y] || 0;
      if (v) out[zSet.has(z2) ? 'expInt' : 'expExt'] += v;
    }
    for (const [z2, zm] of Object.entries(tx || {})) {
      if (z2 === z) continue;
      const v = zm[z]?.Interchange?.[y] || 0;
      if (v) out[zSet.has(z2) ? 'impInt' : 'impExt'] += v;
    }
  }
  return out;
}

/** MW of line capacity on the corridors `zones` sits on, counted once per corridor —
 *  EPM writes both directions of a symmetric line, and adding them would double it. */
export function capacitySplit(tx, zones, y, attr) {
  const zSet = new Set(zones);
  const out = { int: 0, ext: 0 };
  const seen = new Set();
  for (const z of zones) {
    const ends = new Set([...Object.keys(tx?.[z] || {}),
                          ...Object.entries(tx || {}).filter(([, zm]) => zm[z]).map(([z2]) => z2)]);
    for (const z2 of ends) {
      if (z2 === z) continue;
      const k = [z, z2].sort().join('||');
      if (seen.has(k)) continue;
      seen.add(k);
      const v = tx?.[z]?.[z2]?.[attr]?.[y] ?? tx?.[z2]?.[z]?.[attr]?.[y] ?? 0;
      if (v) out[zSet.has(z2) ? 'int' : 'ext'] += Math.abs(v);
    }
  }
  return out;
}

/** GWh of demand the model could not serve. */
export function unmetDemand(eb, zones, y) {
  return zones.reduce((s, z) => s + (eb?.[z]?.['Unmet demand: GWh']?.[y] || 0), 0);
}

/** The extra series for one scenario, as [{ label, kind, side, data }] — always the
 *  same list in the same order, zeros included, so two of them can be subtracted
 *  index by index to give a difference chart.
 *
 *  xs:  the chart's x values (years, or zone / country groups).
 *  at:  x => { tx, eb, zones, year } — what to read, and where, at that x.
 *  allYears: needed only by the cumulated indicator, which sums up to `year`. */
export function extraSeries({ indKey, xs, at, allYears = [] }) {
  const kind = EXTRA_KIND[indKey];
  if (!kind) return [];

  if (kind === 'energy') {
    const t = xs.map(x => { const c = at(x); return tradeSplit(c.tx, c.zones, c.year); });
    return [
      { label: 'Imports (int.)', kind, data: t.map(v => r0(v.impInt)) },
      { label: 'Imports (ext.)', kind, data: t.map(v => r0(v.impExt)) },
      { label: 'Exports (int.)', kind, data: t.map(v => r0(-v.expInt)) },
      { label: 'Exports (ext.)', kind, data: t.map(v => r0(-v.expExt)) },
      { label: 'Unmet demand',   kind, data: xs.map(x => { const c = at(x); return r0(unmetDemand(c.eb, c.zones, c.year)); }) },
    ];
  }

  const attr = CAP_ATTR[indKey] || 'NewTransmissionCapacity';
  const cumulate = indKey === 'NewCapacityTechFuelCumulated';
  const cap = xs.map(x => {
    const c = at(x);
    if (!cumulate) return capacitySplit(c.tx, c.zones, c.year, attr);
    return allYears.filter(y => String(y) <= String(c.year))
      .reduce((acc, y) => { const s = capacitySplit(c.tx, c.zones, y, attr); return { int: acc.int + s.int, ext: acc.ext + s.ext }; },
              { int: 0, ext: 0 });
  });
  const name = CAP_LABEL[indKey] || 'Line capacity';
  return [
    { label: `${name} (int.)`, kind, side: 'int', data: cap.map(v => r0(v.int)) },
    { label: `${name} (ext.)`, kind, side: 'ext', data: cap.map(v => r0(v.ext)) },
  ];
}

/** a − b, series by series. Both must come from extraSeries with the same indicator. */
export function extraDelta(a, b) {
  return a.map((e, i) => ({ ...e, data: e.data.map((v, k) => r0(v - (b[i]?.data[k] || 0))) }));
}

/** A Chart.js dataset for one extra series. Energy joins the techfuel stack; line
 *  capacity is drawn dashed and outside it, since MW of line does not add to MW of plant. */
export function extraDataset(e, scen, multi) {
  const label = multi ? `${scen} — ${e.label}` : e.label;
  if (e.kind === 'capacity') {
    const col = GRID_COLOR[e.side];
    return { label, data: e.data, type: 'line', borderColor: col, backgroundColor: col,
      borderWidth: 1.5, borderDash: [4, 3], pointRadius: 0, tension: 0, fill: false,
      order: 0, stack: `__cap_${scen}_${e.side}__` };
  }
  return { label, data: e.data, type: 'bar', backgroundColor: fillFor(e.label, multi ? 0.55 : 0.85),
    borderColor: techColor(e.label), borderWidth: multi ? 1 : 0, stack: scen };
}

/** Sorts a stack in place, and returns it: generation first, then the traded energy,
 *  then the unserved demand on top — and the legends, which read the dataset order,
 *  follow. Stable, so scenarios and fuels keep the order the builder made them in.
 *  Capacity is drawn as a line outside the stack and stays where it was pushed. */
export function orderStack(datasets) {
  return datasets.sort((a, b) => (a.type === 'line' ? 0 : seriesRank(a.label))
                               - (b.type === 'line' ? 0 : seriesRank(b.label)));
}

/** Legend entry for any series a techfuel chart can hold, extras included. */
export function seriesLegendItem(label) {
  const side = CAP_SIDE[label];
  if (side) return { label, color: GRID_COLOR[side], shape: 'line' };
  return { label, color: techColor(label), fill: cssFillFor(label) };
}
