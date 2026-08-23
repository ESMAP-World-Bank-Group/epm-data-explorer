// The order scenarios are shown in, and how many of them a chart opens on.
//
// Every results chart plots its scenarios baseline-first and numbers them S1, S2,
// … by their rank in that order among the ones selected. The picker, the key
// column beside the chart and the labels drawn under the bars all have to agree
// on that order, so it lives here rather than in any one of them.

/** Baseline first, everything else in the order given. */
export function baseFirst(arr) {
  return [...arr].sort((a, b) => (/^base/i.test(a) ? -1 : /^base/i.test(b) ? 1 : 0));
}

/** What a chart opens on. All of them at once was unreadable past three or four,
 *  and every tab started that way. */
export function defaultScenarios(list, n = 3) {
  return new Set(baseFirst(list).slice(0, n));
}
