// --- What a scenario IS, in words ---
//
// scenarios.csv says which input files a scenario swaps, which is the truth but not an
// explanation: nobody reads "pExtTransferLimit_bssc.csv" and comes away knowing that the
// scenario lays a 1 300 MW cable from Georgia to Romania in 2031. The prose lives in
// public/data/scenarios/<region>.json, written by hand and versioned with the app.
//
// It is optional everywhere. A region with no file gets the mechanical diff it always
// had, so this can never be the reason a study stops rendering.
//
// Two things the file carries that the run cannot know on its own:
//
//   * aliases -- a run folder may be called `baseline` where scenarios.csv says
//     `LC_Baseline`. One doc, several names.
//   * counterfactual -- which scenario a benefit must be measured against. A project run
//     on the crisis price path has to be read against the crisis baseline, not the
//     central one, or the price path shows up as if it were the project's doing.

const cache = new Map();   // region id -> parsed doc | null

/** The written scenario docs for a region, or null when it has none. Cached: the tab
 *  mounts and unmounts as the user moves between tabs, and this is a static file. */
export async function fetchScenarioDocs(regionId) {
  if (!regionId) return null;
  if (cache.has(regionId)) return cache.get(regionId);
  let doc = null;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL || '/'}data/scenarios/${regionId}.json`);
    // A missing file answers 200 with index.html under a SPA fallback, so the parse is
    // the real test, not the status.
    if (res.ok) {
      const json = await res.json();
      if (json && typeof json === 'object' && json.scenarios) doc = json;
    }
  } catch { doc = null; }
  cache.set(regionId, doc);
  return doc;
}

/** name -> canonical key, including every alias. */
function aliasIndex(doc) {
  const ix = {};
  for (const [key, s] of Object.entries(doc?.scenarios || {})) {
    ix[key] = key;
    for (const a of s?.aliases || []) ix[a] = key;
  }
  return ix;
}

/**
 * The lookups the UI needs, all tolerant of a region with no docs at all.
 *
 * `available` is the run's own scenario list: a counterfactual the run did not solve is
 * no use to anyone, so it is resolved to a name the run actually carries, or to null.
 */
export function scenarioDocIndex(doc, available = []) {
  const ix = aliasIndex(doc);
  const have = new Set(available);
  const canonToRun = {};
  for (const s of available) { const c = ix[s]; if (c && !canonToRun[c]) canonToRun[c] = s; }

  /** The doc for a scenario as the run names it. */
  const docFor = scen => doc?.scenarios?.[ix[scen]] || null;

  /** The scenario a benefit should be measured against, named as the run names it. */
  const counterfactualOf = scen => {
    const d = docFor(scen);
    const want = d?.counterfactual;
    if (!want) return null;
    if (have.has(want)) return want;
    const runName = canonToRun[ix[want] || want];
    return runName && runName !== scen ? runName : null;
  };

  return { docFor, counterfactualOf, has: !!doc, intro: doc?.intro || '', dimensions: doc?.dimensions || [] };
}
