// The external neighbours: zones the model trades with but does not solve.
//
// They are drawn in grey, and the grey is the point. Everything the model decided —
// which plants ran, what the price came out at — is in colour; an external zone has
// none of that, only a border capacity someone typed in. Colouring it like an internal
// zone would claim a result that does not exist.
//
// zones_ext.geojson gives them as Points or as Polygons/MultiPolygons. Either way each
// one resolves to a single anchor (see utils/centroids), which is where its node sits
// and where the corridors from the internal zones terminate.
import { featureCentroid } from './centroids';
import { layer, source } from './mapSource';

// All layer ids the toggle controls, bottom to top: the country body, then the
// corridors crossing it, then the node and its label. setExtZonesVisible skips ids a
// given map never created, so a page is free to build only part of this list.
export const EXT_LAYER_IDS = [
  'ext-zones-fill', 'ext-zones-hover', 'ext-zones-border',
  'ext-ntc-lines-layer', 'ext-ntc-labels', 'ext-nodes-circles', 'ext-nodes-labels',
];

/** The one grey palette, so the fill, the border, the node and the label cannot drift
 *  apart across the five maps that draw them. */
export function extGrey(isDark) {
  return isDark
    ? { fill: '#3b3b3b', hover: '#6f6f6f', line: '#8a8a8a',
      node: 'rgba(40,40,40,0.85)', text: '#e0e0e0', dim: '#cccccc', halo: 'rgba(0,0,0,0.6)' }
    : { fill: '#d6d6d6', hover: '#9a9a9a', line: '#8a8a8a',
      node: 'rgba(255,255,255,0.85)', text: '#222222', dim: '#444444', halo: 'rgba(255,255,255,0.7)' };
}

/** The year to read a corridor's capacity at: the one asked for when the table has it,
 *  otherwise the last year before it — a capacity is a step function of the year a line
 *  is commissioned, so the previous entry is the value still in force, not a guess. */
function pickYear(years, want) {
  if (!years.length) return null;
  if (!want) return years[0];
  const w = String(want);
  if (years.includes(w)) return w;
  const before = years.filter(y => y <= w);
  return before.length ? before[before.length - 1] : years[0];
}

// Node coords, polygon features, corridor lines and node features, from the raw
// zones_ext geojson and the processed pExtTransferLimit rows.
export function buildExtZoneData(zonesExtGJ, extNtc, zoneCentroids, year = null) {
  const extNodeCoords = {};
  const polyGeom = {};
  for (const f of zonesExtGJ?.features || []) {
    const z = f.properties?.z;
    if (!z || !f.geometry) continue;
    const c = featureCentroid(f);
    if (c) extNodeCoords[z] = c;
    if (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') polyGeom[z] = f.geometry;
  }

  const yrs = extNtc?.length ? Object.keys(extNtc[0].years).sort() : [];
  const extNtcYr = pickYear(yrs, year) || '2024';

  // Every corridor that lands on a zone, carried on the zone's own feature. A popup that
  // reads its rows out of the feature cannot go stale against the selected year the way
  // one closing over the data at layer-creation time did.
  const linksBy = {};
  for (const r of extNtc || []) (linksBy[r.zext] ||= []).push({ z: r.z, mw: r.years[extNtcYr] || 0 });
  const links = z => JSON.stringify(linksBy[z] || []);

  const extPolyFeatures = Object.entries(polyGeom).map(([z, geometry]) => ({
    type: 'Feature', properties: { z, links: links(z) }, geometry,
  }));
  const extLineFeatures = (extNtc || [])
    .filter(r => zoneCentroids[r.z] && extNodeCoords[r.zext])
    .map(r => ({
      type: 'Feature',
      properties: { z: r.z, zext: r.zext, ntc_mw: r.years[extNtcYr] || 0, yr: extNtcYr },
      geometry: { type: 'LineString', coordinates: [zoneCentroids[r.z], extNodeCoords[r.zext]] },
    }));
  const extNodeFeatures = Object.entries(extNodeCoords).map(([z, coords]) => ({
    type: 'Feature', properties: { z, links: links(z) }, geometry: { type: 'Point', coordinates: coords },
  }));
  return { extNodeCoords, extPolyFeatures, extLineFeatures, extNodeFeatures, extNtcYr };
}

// Add every external-zone source and layer to a loaded map. `visible` is applied at
// creation rather than after it: the layers are on by default, and creating them hidden
// only to reveal them a tick later flashes a map without its neighbours every time it
// is rebuilt — on a theme change, on a region change.
export function addExtZoneLayers(map, tv, data, { visible = true } = {}) {
  const { extPolyFeatures, extLineFeatures, extNodeFeatures } = data;
  const g = extGrey(tv.isDark);
  const vis = visible ? 'visible' : 'none';

  map.addSource('ext-zones', { type: 'geojson', data: { type: 'FeatureCollection', features: extPolyFeatures } });
  map.addLayer({ id: 'ext-zones-fill', type: 'fill', source: 'ext-zones',
    layout: { visibility: vis },
    paint: { 'fill-color': g.fill, 'fill-opacity': 0.22 } });
  map.addLayer({ id: 'ext-zones-hover', type: 'fill', source: 'ext-zones',
    layout: { visibility: vis }, filter: ['==', ['get', 'z'], ''],
    paint: { 'fill-color': g.hover, 'fill-opacity': 0.4 } });
  map.addLayer({ id: 'ext-zones-border', type: 'line', source: 'ext-zones',
    layout: { visibility: vis },
    paint: { 'line-color': g.line, 'line-width': 1, 'line-dasharray': [2, 1.5], 'line-opacity': 0.65 } });

  map.addSource('ext-ntc-lines', { type: 'geojson', data: { type: 'FeatureCollection', features: extLineFeatures } });
  map.addLayer({ id: 'ext-ntc-lines-layer', type: 'line', source: 'ext-ntc-lines',
    layout: { visibility: vis, 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': g.line,
      'line-width': ['interpolate', ['linear'], ['get', 'ntc_mw'], 0, 1, 500, 2, 2000, 3, 5000, 4.5],
      'line-opacity': 0.85 } });

  map.addSource('ext-nodes', { type: 'geojson', data: { type: 'FeatureCollection', features: extNodeFeatures } });
  map.addLayer({ id: 'ext-nodes-circles', type: 'circle', source: 'ext-nodes',
    layout: { visibility: vis },
    paint: { 'circle-radius': 5, 'circle-color': g.node,
      'circle-stroke-width': 1.5, 'circle-stroke-color': g.line } });
  map.addLayer({ id: 'ext-nodes-labels', type: 'symbol', source: 'ext-nodes',
    layout: { visibility: vis, 'text-field': ['get', 'z'], 'text-size': 10,
      'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-allow-overlap': false },
    paint: { 'text-color': g.text, 'text-halo-color': g.halo, 'text-halo-width': 1 } });
  map.addLayer({ id: 'ext-ntc-labels', type: 'symbol', source: 'ext-ntc-lines',
    layout: { visibility: vis, 'text-field': ['concat', ['to-string', ['round', ['get', 'ntc_mw']]], ' MW'],
      'text-size': 9, 'symbol-placement': 'line-center', 'text-allow-overlap': false },
    paint: { 'text-color': g.dim, 'text-halo-color': g.halo, 'text-halo-width': 1 } });
}

// Push a rebuilt data set into layers that already exist — what a year change needs.
// Rebuilding the layers instead would drop the toggle state and re-bind the handlers.
export function updateExtZoneData(map, data) {
  if (!map || !data) return;
  const fc = features => ({ type: 'FeatureCollection', features });
  source(map, 'ext-zones')?.setData(fc(data.extPolyFeatures));
  source(map, 'ext-ntc-lines')?.setData(fc(data.extLineFeatures));
  source(map, 'ext-nodes')?.setData(fc(data.extNodeFeatures));
}

// Hover popups for corridor lines, nodes and country bodies. Everything shown is read
// off the hovered feature, so these bind once and stay right as the year changes.
export function bindExtZoneHandlers(map, popup) {
  const clear = () => {
    map.getCanvas().style.cursor = '';
    if (layer(map, 'ext-zones-hover')) map.setFilter('ext-zones-hover', ['==', ['get', 'z'], '']);
    popup.remove();
  };

  map.on('mousemove', 'ext-ntc-lines-layer', e => {
    map.getCanvas().style.cursor = 'pointer';
    const p = e.features[0].properties;
    popup.setLngLat(e.lngLat)
      .setHTML(`<b>${p.z} ↔ ${p.zext}</b><br><span style="opacity:.75">NTC ${p.yr}: ${Math.round(p.ntc_mw).toLocaleString()} MW</span>`)
      .addTo(map);
  });
  map.on('mouseleave', 'ext-ntc-lines-layer', clear);

  const zoneInfo = (e, highlight) => {
    map.getCanvas().style.cursor = 'pointer';
    const p = e.features[0].properties;
    if (highlight && layer(map, 'ext-zones-hover')) map.setFilter('ext-zones-hover', ['==', ['get', 'z'], p.z]);
    let rows;
    try { rows = JSON.parse(p.links || '[]'); } catch { rows = []; }
    const html = rows.map(r =>
      '<div style="display:flex;justify-content:space-between;gap:12px">'
      + `<span style="opacity:.75">${r.z}</span>`
      + `<span style="font-weight:600">${Math.round(r.mw).toLocaleString()} MW</span></div>`
    ).join('');
    popup.setLngLat(e.lngLat)
      .setHTML(`<b>${p.z}</b> <span style="opacity:.55">· external</span><br>`
        + (html || '<span style="opacity:.6">No NTC data</span>'))
      .addTo(map);
  };
  map.on('mousemove', 'ext-nodes-circles', e => zoneInfo(e, false));
  map.on('mouseleave', 'ext-nodes-circles', clear);
  map.on('mousemove', 'ext-zones-fill', e => zoneInfo(e, true));
  map.on('mouseleave', 'ext-zones-fill', clear);
}

// Show / hide all external-zone layers (toggle).
export function setExtZonesVisible(map, visible) {
  if (!map) return;
  const vis = visible ? 'visible' : 'none';
  for (const id of EXT_LAYER_IDS) if (layer(map, id)) map.setLayoutProperty(id, 'visibility', vis);
}
