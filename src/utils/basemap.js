/**
 * Base map layers, built on the World Bank Official Boundaries extract that
 * tools/prepare_boundaries.py writes into public/data.
 *
 * Features carrying STATUS 'non-determined' are the areas the Bank does not
 * attribute to any country (Western Sahara, Abyei, Arunachal Pradesh, the
 * Kashmir area north of the line of control, the Kuril Islands, the UN buffer
 * zone in Cyprus). WB cartographic policy draws them as land, without a country
 * fill and with a dashed outline, so they are painted by the land layer, kept
 * out of the solid border layer, and never carry a country code -- which is
 * what keeps every ISO_A3-keyed layer and click handler from picking them up.
 */

/** Country features only: everything the Bank attributes to a country. */
export const COUNTRY_ONLY = ['!=', ['get', 'STATUS'], 'non-determined'];
/** The unattributed areas. */
export const NON_DETERMINED_ONLY = ['==', ['get', 'STATUS'], 'non-determined'];

/**
 * Load a boundary layer. Feature ids are assigned here because MapLibre needs
 * them for setFeatureState and the source is loaded with generateId: false.
 *
 * @param {'10m'|'110m'} resolution
 */
export async function fetchCountries(resolution = '10m') {
  const fc = await fetch(`/data/countries_${resolution}.geojson`).then(r => r.json());
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
 * Add the land and border layers every map starts from. Requires the
 * 'countries' source, see addCountriesSource().
 *
 * @param {import('maplibre-gl').Map} map
 * @param {object} t  the active theme, see src/constants.js
 */
export function addBaseLayers(map, t) {
  map.addLayer({
    id: 'land', type: 'fill', source: 'countries',
    paint: { 'fill-color': t.land, 'fill-opacity': 1 },
  });
  map.addLayer({
    id: 'borders', type: 'line', source: 'countries', filter: COUNTRY_ONLY,
    paint: { 'line-color': t.worldBdr, 'line-width': t.worldBdrW },
  });
  map.addLayer({
    id: 'borders-non-determined', type: 'line', source: 'countries',
    filter: NON_DETERMINED_ONLY,
    paint: {
      'line-color': t.worldBdr,
      'line-width': t.worldBdrW,
      'line-dasharray': [4, 3],
    },
  });
}
