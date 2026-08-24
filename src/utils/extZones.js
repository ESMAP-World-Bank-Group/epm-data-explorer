// Shared external-zone map layers (inputs + results).
// External neighbours in zones_ext.geojson may be Points OR Polygons/MultiPolygons.
// The renderer draws a subtle polygon fill (when available) + a centroid node + the
// NTC corridor lines from each internal zone centroid to the external centroid.
import { computeCentroid } from './epmFetch';
import { layer } from './mapSource';

// All layer ids the toggle controls (fill/border first so nodes+lines sit on top).
export const EXT_LAYER_IDS = [
  'ext-zones-fill', 'ext-zones-border',
  'ext-ntc-lines-layer', 'ext-ntc-labels', 'ext-nodes-circles', 'ext-nodes-labels',
];

// Build node coords (Point coords or polygon centroid), polygon features, corridor
// lines and node features from the raw zones_ext geojson + processed extNtc corridors.
export function buildExtZoneData(zonesExtGJ, extNtc, zoneCentroids) {
  const extNodeCoords = {};
  const extPolyFeatures = [];
  if (zonesExtGJ?.features) {
    for (const f of zonesExtGJ.features) {
      const z = f.properties?.z;
      if (!z || !f.geometry) continue;
      if (f.geometry.type === 'Point') {
        extNodeCoords[z] = f.geometry.coordinates;
      } else if (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') {
        const c = computeCentroid(f.geometry);
        if (c) extNodeCoords[z] = c;
        extPolyFeatures.push({ type: 'Feature', properties: { z }, geometry: f.geometry });
      }
    }
  }
  const yrs = extNtc?.length ? Object.keys(extNtc[0].years).sort() : [];
  const extNtcYr = yrs[0] || '2024';
  const extLineFeatures = (extNtc || [])
    .filter(r => zoneCentroids[r.z] && extNodeCoords[r.zext])
    .map(r => ({
      type: 'Feature',
      properties: { z: r.z, zext: r.zext, ntc_mw: r.years[extNtcYr] || 0 },
      geometry: { type: 'LineString', coordinates: [zoneCentroids[r.z], extNodeCoords[r.zext]] },
    }));
  const extNodeFeatures = Object.entries(extNodeCoords).map(([z, coords]) => ({
    type: 'Feature', properties: { z }, geometry: { type: 'Point', coordinates: coords },
  }));
  return { extNodeCoords, extPolyFeatures, extLineFeatures, extNodeFeatures, extNtcYr };
}

// Add all external-zone sources+layers to a loaded map (hidden by default).
export function addExtZoneLayers(map, tv, data) {
  const { extPolyFeatures, extLineFeatures, extNodeFeatures } = data;

  map.addSource('ext-zones', { type: 'geojson', data: { type: 'FeatureCollection', features: extPolyFeatures } });
  map.addLayer({ id: 'ext-zones-fill', type: 'fill', source: 'ext-zones',
    layout: { visibility: 'none' },
    paint: { 'fill-color': tv.isDark ? '#3b3b3b' : '#d6d6d6', 'fill-opacity': 0.22 } });
  map.addLayer({ id: 'ext-zones-border', type: 'line', source: 'ext-zones',
    layout: { visibility: 'none' },
    paint: { 'line-color': '#8a8a8a', 'line-width': 1, 'line-dasharray': [2, 1.5], 'line-opacity': 0.65 } });

  map.addSource('ext-ntc-lines', { type: 'geojson', data: { type: 'FeatureCollection', features: extLineFeatures } });
  map.addLayer({ id: 'ext-ntc-lines-layer', type: 'line', source: 'ext-ntc-lines',
    layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#888888',
      'line-width': ['interpolate', ['linear'], ['get', 'ntc_mw'], 0, 1, 500, 2, 2000, 3, 5000, 4.5],
      'line-opacity': 0.85 } });

  map.addSource('ext-nodes', { type: 'geojson', data: { type: 'FeatureCollection', features: extNodeFeatures } });
  map.addLayer({ id: 'ext-nodes-circles', type: 'circle', source: 'ext-nodes',
    layout: { visibility: 'none' },
    paint: { 'circle-radius': 5, 'circle-color': tv.isDark ? 'rgba(40,40,40,0.85)' : 'rgba(255,255,255,0.85)',
      'circle-stroke-width': 1.5, 'circle-stroke-color': '#888888' } });
  map.addLayer({ id: 'ext-nodes-labels', type: 'symbol', source: 'ext-nodes',
    layout: { visibility: 'none', 'text-field': ['get', 'z'], 'text-size': 10,
      'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-allow-overlap': false },
    paint: { 'text-color': tv.isDark ? '#e0e0e0' : '#222222',
      'text-halo-color': tv.isDark ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.7)', 'text-halo-width': 1 } });
  map.addLayer({ id: 'ext-ntc-labels', type: 'symbol', source: 'ext-ntc-lines',
    layout: { visibility: 'none', 'text-field': ['concat', ['to-string', ['round', ['get', 'ntc_mw']]], ' MW'],
      'text-size': 9, 'symbol-placement': 'line-center', 'text-allow-overlap': false },
    paint: { 'text-color': tv.isDark ? '#cccccc' : '#444444',
      'text-halo-color': tv.isDark ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.7)', 'text-halo-width': 1 } });
}

// Hover popups for corridor lines, nodes and polygon fills.
export function bindExtZoneHandlers(map, popup, extNtc, extNtcYr) {
  map.on('mouseenter', 'ext-ntc-lines-layer', e => {
    map.getCanvas().style.cursor = 'pointer';
    const { z, zext, ntc_mw } = e.features[0].properties;
    popup.setLngLat(e.lngLat)
      .setHTML(`<b>${z} ↔ ${zext}</b><br><span style="opacity:.75">NTC: ${Math.round(ntc_mw).toLocaleString()} MW</span>`)
      .addTo(map);
  });
  map.on('mouseleave', 'ext-ntc-lines-layer', () => { map.getCanvas().style.cursor = ''; popup.remove(); });

  const nodeInfo = e => {
    map.getCanvas().style.cursor = 'pointer';
    const zext = e.features[0].properties.z;
    const rows = (extNtc || []).filter(r => r.zext === zext).map(r =>
      `<div style="display:flex;justify-content:space-between;gap:12px">` +
      `<span style="opacity:.75">${r.z}</span>` +
      `<span style="font-weight:600">${Math.round(r.years[extNtcYr] || 0).toLocaleString()} MW</span></div>`
    ).join('');
    popup.setLngLat(e.lngLat)
      .setHTML(`<b>${zext}</b><br>${rows || '<span style="opacity:.6">No NTC data</span>'}`)
      .addTo(map);
  };
  map.on('mouseenter', 'ext-nodes-circles', nodeInfo);
  map.on('mouseleave', 'ext-nodes-circles', () => { map.getCanvas().style.cursor = ''; popup.remove(); });
  map.on('mouseenter', 'ext-zones-fill', nodeInfo);
  map.on('mouseleave', 'ext-zones-fill', () => { map.getCanvas().style.cursor = ''; popup.remove(); });
}

// Show / hide all external-zone layers (toggle).
export function setExtZonesVisible(map, visible) {
  if (!map) return;
  const vis = visible ? 'visible' : 'none';
  for (const id of EXT_LAYER_IDS) if (layer(map, id)) map.setLayoutProperty(id, 'visibility', vis);
}
