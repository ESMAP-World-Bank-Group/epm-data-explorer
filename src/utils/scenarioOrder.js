// The order scenarios are shown in, and how many of them a chart opens on.
//
// Every results chart plots its scenarios baseline-first and numbers them S1, S2,
// … by their rank in that order among the ones selected. The picker, the key
// column beside the chart and the labels drawn under the bars all have to agree
// on that order, so it lives here rather than in any one of them.

/** A baseline by name: "baseline" or "base…", or a family prefix such as LC_Baseline. */
const isBase = s => /^base/i.test(s) || /_base(line)?$/i.test(s);

/** Baseline first, everything else in the order given. */
export function baseFirst(arr) {
  return [...arr].sort((a, b) => (isBase(a) ? -1 : isBase(b) ? 1 : 0));
}

/** The scenario the tabs open on and compare against: a plain "baseline" before a
 *  prefixed one, and the first scenario when no name says baseline. */
export function baseScenario(list) {
  return list.find(s => /^base(line)?$/i.test(s)) || list.find(isBase) || list[0];
}

/** What a chart opens on. All of them at once was unreadable past three or four,
 *  and every tab started that way. */
export function defaultScenarios(list, n = 3) {
  return new Set(baseFirst(list).slice(0, n));
}
