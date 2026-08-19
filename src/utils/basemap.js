/**
 * Base map layers, built on the World Bank Official Boundaries extract that
 * tools/prepare_boundaries.py writes into public/data.
 *
 * Features carrying STATUS 'non-determined' are the areas the Bank does not
 * attribute to any country (Western Sahara, Abyei, Arunachal Pradesh, the
 * Kashmir area north of the line of control, the Kuril Islands, the UN buffer
 * zone in Cyprus). WB cartographic policy draws them as land, without a country
 * fill and with a broken outline, so they are painted by the land layer, kept
 * out of the solid border layer, and never carry a country code -- which is
 * what keeps every ISO_A3-keyed layer and click handler from picking them up.
 *
 * Their outlines, and the national borders the Bank itself draws broken, come
 * from the companion boundaries_*.geojson: line features carrying the Bank's
 * own STYLE, traced onto the very same polygon edges so the two can never
 * disagree by a pixel. See tools/prepare_boundaries.py.
 */

/** Country features only: everything the Bank attributes to a country. */
export const COUNTRY_ONLY = ['!=', ['get', 'STATUS'], 'non-determined'];
/** The unattributed areas. */
export const NON_DETERMINED_ONLY = ['==', ['get', 'STATUS'], 'non-determined'];

/**
 * The Bank's three broken-line styles. Dash lengths are multiples of the line
 * width, which is well under a pixel, hence the large numbers. Dots are drawn
 * with round caps, and need a wider line than the dashes do: a dot is only as
 * across as the line is wide, so at the border width it would not survive
 * rasterising.
 */
const LINE_STYLES = [
  { style: 'Dashed', dash: [9, 6], scale: 1, cap: 'butt' },
  { style: 'Tightly Dashed', dash: [4.5, 3], scale: 1, cap: 'butt' },
  { style: 'Dotted', dash: [0, 2.5], scale: 2.5, cap: 'round' },
];
const layerIdFor = style => `boundaries-${style.toLowerCase().replace(/ /g, '-')}`;
/** Every layer this module draws above the country fills, in drawing order. */
const BROKEN_LAYERS = ['boundaries-mask', ...LINE_STYLES.map(s => layerIdFor(s.style))];

async function fetchJson(path) {
  return fetch(path).then(r => r.json());
}

/**
 * Load a boundary layer. Feature ids are assigned here because MapLibre needs
 * them for setFeatureState and the source is loaded with generateId: false.
 *
 * @param {'10m'|'110m'} resolution
 */
export async function fetchCountries(resolution = '10m') {
  const fc = await fetchJson(`/data/countries_${resolution}.geojson`);
  fc.features.forEach((f, i) => { f.id = i; });
  return fc;
}

/**
 * @param {import('maplibre-gl').Map} map
 * @param {object} countries  a FeatureCollection from fetchCountries()
 */
export function addCountriesSource(map, countries) {
  map.addSource('countries', { type: 'geojson', data: countries, generateId: false });
}

/**
 * Load the Bank's broken-border lines for a resolution.
 *
 * @param {'10m'|'110m'} resolution
 */
export async function fetchBoundaries(resolution = '10m') {
  return fetchJson(`/data/boundaries_${resolution}.geojson`);
}

/**
 * Add the land, border and broken-border layers every map starts from.
 * Requires the 'countries' source, see addCountriesSource().
 *
 * @param {import('maplibre-gl').Map} map
 * @param {object} t  the active theme, see src/constants.js
 * @param {object} boundaries  a FeatureCollection from fetchBoundaries()
 */
export function addBaseLayers(map, t, boundaries) {
  map.addSource('boundaries', { type: 'geojson', data: boundaries });

  map.addLayer({
    id: 'land', type: 'fill', source: 'countries',
    paint: { 'fill-color': t.land, 'fill-opacity': 1 },
  });
  map.addLayer({
    id: 'borders', type: 'line', source: 'countries', filter: COUNTRY_ONLY,
    paint: { 'line-color': t.worldBdr, 'line-width': t.worldBdrW },
  });
  // The shore of an unattributed area is a coastline like any other, and the
  // solid layer above skips it along with the rest of the area's outline.
  map.addLayer({
    id: 'boundaries-coast', type: 'line', source: 'boundaries',
    filter: ['==', ['get', 'STYLE'], ''],
    paint: { 'line-color': t.worldBdr, 'line-width': t.worldBdrW },
  });
  // A broken border runs along an edge the solid layer has already drawn, so a
  // dashed line laid straight on top would read as solid. Mask that edge back
  // out in the land colour first. Every broken border is a land boundary, so
  // the mask always has the land fill on both sides and never shows.
  map.addLayer({
    id: 'boundaries-mask', type: 'line', source: 'boundaries',
    filter: ['!=', ['get', 'STYLE'], ''],
    paint: { 'line-color': t.land, 'line-width': t.worldBdrW * 2.2 },
  });
  for (const { style, dash, scale, cap } of LINE_STYLES) {
    map.addLayer({
      id: layerIdFor(style),
      type: 'line', source: 'boundaries',
      filter: ['==', ['get', 'STYLE'], style],
      layout: { 'line-cap': cap },
      paint: {
        'line-color': t.worldBdr,
        'line-width': t.worldBdrW * scale,
        'line-dasharray': dash,
      },
    });
  }
}

/**
 * Match a region's own countries plus the unattributed areas assigned to it.
 *
 * The Bank attributes such an area to no country, so it carries no code and no
 * ISO_A3 filter can reach it -- but it still lies inside the region a map is
 * about, and leaving it blank in the middle of a coloured region reads as a
 * hole. It takes the region fill like any member country; only its outline
 * stays broken. Areas come from the `non_determined` list in regions.json and
 * are matched on WB_NAME, the only name they carry.
 *
 * @param {string[]} isos
 * @param {string[]} [areas]  WB_NAME of each unattributed area in the region
 */
export function regionFilter(isos, areas = []) {
  const byIso = ['in', ['get', 'ISO_A3'], ['literal', isos]];
  if (!areas.length) return byIso;
  return ['any', byIso,
    ['all', NON_DETERMINED_ONLY, ['in', ['get', 'WB_NAME'], ['literal', areas]]]];
}

/**
 * Lift the broken borders back to the top of the stack. A page that fills
 * regions or countries after loadBasemap() paints over them otherwise, and the
 * dashes are the whole point of drawing those borders differently.
 *
 * @param {import('maplibre-gl').Map} map
 */
export function raiseBoundaries(map) {
  for (const id of BROKEN_LAYERS) {
    if (map.getLayer(id)) map.moveLayer(id);
  }
}
