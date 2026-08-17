// Shared off-grid zone map layers (inputs + results).
// zones_offgrid.geojson holds the parts of the modelled countries that belong to NO
// dispatch zone because they are outside the modelled electrical system (in CASA:
// the KEGOC Western zone, synchronised with Russia, and the Afghan provinces off
// NEPS). Undrawn they read as a hole in the map, so they are painted like the rest
// of the country — same colour, no label, no popup, nothing inside them.
//
// This is deliberately NOT zones.geojson: that source is joined to model results, and
// a zone with no results would show up as a phantom entry in dropdowns and totals.
// It is not zones_ext.geojson either — those are external trading neighbours, which
// these are not. A model without the file simply gets no layer.

export const OFFGRID_LAYER_IDS = ['offgrid-fill', 'offgrid-border'];

// Read a paint property off the first of these layers that exists, so the off-grid
// polygons inherit the page's own zone styling instead of hard-coding a second
// palette. Zone pages dim everything but the selected zone and name their layers
// accordingly — off-grid areas are context there too, so they follow the dim style.
function paintOf(map, layers, prop, fallback) {
  for (const id of layers) {
    try {
      const v = map.getLayer(id) ? map.getPaintProperty(id, prop) : undefined;
      if (v !== undefined) return v;
    } catch { /* layer without that property — try the next one */ }
  }
  return fallback;
}

const FILL_LAYERS = ['zone-fill', 'zone-fill-dim'];
const BORDER_LAYERS = ['zone-border', 'zone-border-dim'];

// Add the off-grid source + layers to a loaded map. Visible from the start: the gap
// should simply not be there, without the user having to find a toggle.
export function addOffgridLayers(map, tv, offgridGJ) {
  if (!offgridGJ?.features?.length || map.getSource('offgrid-zones')) return;

  // The zone fill colours by ISO_A3 and the off-grid features carry ISO_A3 too, so
  // the page's own expression applies here unchanged -> same colour as the country.
  const fallback = tv?.isDark ? '#3b3b3b' : '#d6d6d6';
  const fillColor = paintOf(map, FILL_LAYERS, 'fill-color', fallback);
  const fillOpacity = paintOf(map, FILL_LAYERS, 'fill-opacity', 0.3);
  const lineColor = paintOf(map, BORDER_LAYERS, 'line-color', fillColor);
  const lineWidth = paintOf(map, BORDER_LAYERS, 'line-width', 0.6);
  const lineOpacity = paintOf(map, BORDER_LAYERS, 'line-opacity', 0.25);

  map.addSource('offgrid-zones', { type: 'geojson', data: offgridGJ });
  map.addLayer({ id: 'offgrid-fill', type: 'fill', source: 'offgrid-zones',
    paint: { 'fill-color': fillColor, 'fill-opacity': fillOpacity } });
  map.addLayer({ id: 'offgrid-border', type: 'line', source: 'offgrid-zones',
    paint: { 'line-color': lineColor, 'line-width': lineWidth, 'line-opacity': lineOpacity } });
}

// Show / hide the off-grid layers, for pages that expose a layer toggle.
export function setOffgridVisible(map, visible) {
  if (!map) return;
  const vis = visible ? 'visible' : 'none';
  for (const id of OFFGRID_LAYER_IDS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
}
