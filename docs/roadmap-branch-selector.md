# Roadmap: choosing the EPM branch of a region

Status: proposal, not started. Written 2026-11-16.

## Goal

Let a viewer switch a region between several EPM branches without a redeploy.
The first use is Mexico, where `mexico_2026` is the default and `mexico_old`
(the CCDR model) stays reachable for comparison. A link must keep the choice,
so a colleague who opens a shared URL sees the same model.

Already done: Mexico reads `mexico_2026` / `data_mexico_2026` (commit 7061364).

## How the app works today

- `public/data/regions.json` gives each region one `epm` block: `branch`,
  `dataFolder`, and optional keys (`dataFolders`, `scenariosFile`,
  `configFile`, `externalZones`).
- Six pages fetch regions.json themselves and read `region.epm.branch`:
  RegionPage, EpmCountryPage, EpmZonePage, ResultsRegionPage,
  ResultsCountryPage, ResultsZonePage. Navbar and WorldPage read it too.
- Every helper in `src/utils/epmFetch.js` already takes the branch as an
  argument. Nothing below the pages needs to know a choice exists.
- R2 hosting is a hard-coded set, `R2_BRANCHES` in epmFetch.js.

So the change is upstream of the pages: pick the variant, then hand the pages
a region whose `epm` block is already the chosen one.

## Plan

### 1. Config (small)

Add an optional `variants` list to a region's `epm` block. The first entry is
the default. A region without `variants` behaves exactly as today.

```json
"epm": {
  "variants": [
    { "branch": "mexico_2026", "dataFolder": "data_mexico_2026", "label": "2026 update" },
    { "branch": "mexico_old",  "dataFolder": "data_mexico_ccdr", "label": "CCDR (2026-09)" }
  ]
}
```

Each variant may carry any key the `epm` block accepts today, since folder
names and scenario files differ between branches. Add a `host: "r2"` key so
the R2 flag lives with the branch it describes, and derive `R2_BRANCHES` from
regions.json instead of the constant.

Add a node test in `tests/` that checks regions.json: unique branches per
region, a `dataFolder` on every variant, a label when there is more than one.

### 2. One resolver (core, about 2 h)

New `src/utils/regionEpm.js`:

- `resolveRegion(region, branchParam)` returns the region with `epm` merged
  from the chosen variant, plus `epm.variants` and `epm.isDefault` for the UI.
  An unknown branch falls back to the default and the page shows a short
  notice instead of failing.
- `useRegion(regionId)` fetches regions.json once per session (module cache),
  reads `?branch=` with `useSearchParams` and returns the resolved region.

Replace the six copies of `fetch('/data/regions.json')` in the pages with the
hook. This also removes duplicated code, which is worth it on its own.

### 3. Keep the choice in the URL (about 2 h)

About 37 places build a `/region/...` link (navigate, `to`, `href`). Add a
`useRegionHref()` helper that appends the current `?branch=` when it is not
the default, and use it everywhere inside a region. Switching to another
region from the Navbar or the world map drops the parameter, since a branch
belongs to one region. Default links stay clean, so existing bookmarks and
analytics paths do not change.

### 4. The selector (about 2 h)

A "Model version" select in the region header, shown only when a region has
more than one variant. It sits next to the existing "Data folder" select on
RegionPage and uses the same styling, and it appears on the Results pages too.

Changing it writes `?branch=` and must reset what belonged to the old branch:
active data folder, zcmap, selected run and scenario. The page effects are
keyed on the region object, so a new resolved object reruns them. Check each
page for state that survives the switch.

### 5. Side effects to handle (1 to 2 h)

- **Scenario docs.** `src/utils/scenarioDocs.js` caches
  `public/data/scenarios/<region>.json` by region id. Look for
  `<region>@<branch>.json` first, then fall back to the region file, and key
  the cache the same way.
- **GitHub API rate limit.** Listings use the unauthenticated Contents API,
  60 requests per hour per IP. Switching back and forth doubles them. Cache
  `fetchGitHubDir` results per branch and path for the session.
- **Analytics.** Add `branch` to the six `track()` payloads so usage per model
  version is visible.
- **Exports.** Raw data and CSV downloads already put the branch in file names
  and metadata. Check that they read the resolved branch, not the default.
- **Branch lifetime.** A variant breaks if its branch is deleted or renamed in
  the EPM repo. Tell modelers that a listed branch must stay, or remove the
  variant first.

### 6. Test (about 1 h)

- Unit tests for `resolveRegion` (default, valid param, unknown param, region
  without variants).
- Headless browser pass over the Mexico region, country, zone and results
  pages, with and without `?branch=mexico_old`, checking that every data
  request goes to the chosen branch and links keep the parameter.
- `npm run build` and lint.

## Effort

About one to one and a half days of work in total, in two pull requests:
steps 1 and 2 first (no visible change, pages read the hook), then 3 to 6.

## Out of scope

A free-text "open any branch" mode. A random branch has no guaranteed input
folder, zone geometry or curated runs, and the error states would cost more
than the feature. A short curated list in regions.json is enough.

## Decisions for the region owner

- Labels shown to users for each version.
- Whether old versions stay listed after a new one lands, and for how long.
