// Shared off-grid zone map layers (inputs + results).
// zones_offgrid.geojson holds the parts of the modelled countries that belong to NO
// dispatch zone because they are outside the modelled electrical system (in CASA:
// the KEGOC Western zone, synchronised with Russia, and the Afghan provinces off
// NEPS). Undrawn they read as a hole in the map, so they get their own grey dashed
// layer that says so on hover.
//
// This is deliberately NOT zones.geojson: that source is joined to model results, and
// a zone with no results would show up as a phantom entry in dropdowns and totals.
// It is not zones_ext.geojson either — those are external trading neighbours, which
// these are not. A model without the file simply gets no layer.

export const OFFGRID_LAYER_IDS = ['offgrid-fill', 'offgrid-border', 'offgrid-labels'];

// Add the off-grid source + layers to a loaded map. Visible from the start: the whole
// point is that the gap is explained without the user having to find a toggle.
export function addOffgridLayers(map, tv, offgridGJ) {
  if (!offgridGJ?.features?.length || map.getSource('offgrid-zones')) return;

  map.addSource('offgrid-zones', { type: 'geojson', data: offgridGJ });
  map.addLayer({ id: 'offgrid-fill', type: 'fill', source: 'offgrid-zones',
    paint: { 'fill-color': tv.isDark ? '#3b3b3b' : '#d6d6d6', 'fill-opacity': 0.30 } });
  map.addLayer({ id: 'offgrid-border', type: 'line', source: 'offgrid-zones',
    paint: { 'line-color': '#8a8a8a', 'line-width': 1, 'line-dasharray': [2, 1.5],
      'line-opacity': 0.7 } });
  map.addLayer({ id: 'offgrid-labels', type: 'symbol', source: 'offgrid-zones',
    layout: { 'text-field': ['get', 'z'], 'text-size': 9, 'text-allow-overlap': false },
    paint: { 'text-color': tv.isDark ? '#9a9a9a' : '#6a6a6a',
      'text-halo-color': tv.isDark ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.7)',
      'text-halo-width': 1 } });
}

// Hover popup: the written reason the area is outside the model.
export function bindOffgridHandlers(map, popup) {
  const info = e => {
    map.getCanvas().style.cursor = 'pointer';
    const { name, z, reason, area_km2 } = e.features[0].properties;
    const km2 = area_km2 ? `${Number(area_km2).toLocaleString()} km²` : '';
    popup.setLngLat(e.lngLat)
      .setHTML(`<b>${name || z}</b><br>` +
        `<span style="opacity:.75">Not modelled${km2 ? ` — ${km2}` : ''}</span>` +
        (reason ? `<br><span style="opacity:.6">${reason}</span>` : ''))
      .addTo(map);
  };
  map.on('mouseenter', 'offgrid-fill', info);
  map.on('mouseleave', 'offgrid-fill', () => { map.getCanvas().style.cursor = ''; popup.remove(); });
}

// Show / hide the off-grid layers, for pages that expose a layer toggle.
export function setOffgridVisible(map, visible) {
  if (!map) return;
  const vis = visible ? 'visible' : 'none';
  for (const id of OFFGRID_LAYER_IDS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
}
