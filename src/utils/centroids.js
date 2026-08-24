// Where a zone gets drawn: its price dot, its generation donut, and the ends of the
// corridors that terminate on it.
//
// Three sources, in decreasing order of how deliberate they are:
//
//   1. An override written into the geojson feature — `properties.centroid: [lon, lat]`,
//      or a `properties.lon` / `properties.lat` pair. Some countries have no useful
//      centre: Russia's is in Siberia, thousands of kilometres from the only corridor
//      that ends on it, so a line drawn to it leaves the map entirely. An override is
//      someone saying where the country should be *attached*, which is not a question
//      geometry can answer.
//   2. The endpoint EPM's postprocessing already wrote into linestring_*.geojson.
//   3. The polygon's own centre of area.
//
// (3) used to be the average of the polygon's vertices, which is not a centroid at all:
// it follows how finely the outline happens to be drawn. Greece came out 130 km south
// of its centre because the islands carry most of the vertices, and Russia's 14 900
// points dragged it east. The centre of area does not care how the outline was sampled.

/** An explicit centroid written on a feature, or null. Accepts `centroid: [lon, lat]`
 *  and a flat `lon`/`lat` pair, since geojson editors offer one or the other. */
export function overrideCentroid(props) {
  if (!props) return null;
  const c = props.centroid ?? props.center;
  if (Array.isArray(c) && c.length >= 2) {
    const [lon, lat] = c.map(Number);
    if (Number.isFinite(lon) && Number.isFinite(lat)) return [lon, lat];
  }
  const lon = Number(props.lon ?? props.longitude);
  const lat = Number(props.lat ?? props.latitude);
  if (Number.isFinite(lon) && Number.isFinite(lat)) return [lon, lat];
  return null;
}

/** Signed area and area-weighted centroid of one closed ring, by the shoelace formula.
 *  The sign carries the winding, which is what lets holes subtract from their shell. */
function ringCentroid(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    const p = ring[i], q = ring[i + 1];
    if (!p || !q) return null;
    const cross = p[0] * q[1] - q[0] * p[1];
    a  += cross;
    cx += (p[0] + q[0]) * cross;
    cy += (p[1] + q[1]) * cross;
  }
  if (a === 0) return null;
  a /= 2;
  return { area: a, x: cx / (6 * a), y: cy / (6 * a) };
}

/** Centre of area of one Polygon's coordinate array: outer ring minus its holes. */
function partCentroid(rings) {
  let a = 0, x = 0, y = 0;
  for (const r of rings || []) {
    const c = ringCentroid(r);
    if (!c) continue;
    a += c.area;
    x += c.x * c.area;
    y += c.y * c.area;
  }
  return a !== 0 ? { area: Math.abs(a), x: x / a, y: y / a } : null;
}

/** Average of every vertex. Only a last resort, for geometry with no area at all —
 *  a ring that never closes, or one flattened onto a line. */
function vertexAverage(geometry) {
  const rings = geometry.type === 'Polygon'
    ? geometry.coordinates
    : geometry.coordinates.flatMap(p => p);
  let x = 0, y = 0, n = 0;
  for (const ring of rings || [])
    for (const pt of ring || []) { x += pt[0]; y += pt[1]; n++; }
  return n > 0 ? [x / n, y / n] : null;
}

/** Centre of area of a Polygon or MultiPolygon. A MultiPolygon resolves to its largest
 *  part rather than to the mean of all of them: the mean of mainland Greece and Crete is
 *  in the sea, and a country is better labelled on the piece someone can point at. */
export function polygonCentroid(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'Point') return geometry.coordinates;
  const parts = geometry.type === 'Polygon' ? [geometry.coordinates]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates
      : null;
  if (!parts) return null;
  let best = null;
  for (const rings of parts) {
    const c = partCentroid(rings);
    if (c && (!best || c.area > best.area)) best = c;
  }
  return best ? [best.x, best.y] : vertexAverage(geometry);
}

/** Where a feature should be drawn: its override if it has one, its own coordinates if
 *  it is a Point, otherwise its centre of area. */
export function featureCentroid(feature) {
  if (!feature) return null;
  return overrideCentroid(feature.properties)
    || (feature.geometry?.type === 'Point' ? feature.geometry.coordinates : null)
    || polygonCentroid(feature.geometry);
}

/** The zone → [lon, lat] map every map effect needs.
 *
 *  linestring_*.geojson is preferred over the polygons because EPM's postprocessing
 *  wrote those endpoints for exactly this purpose and the corridors already meet there;
 *  computing our own would put a zone's dot a few kilometres off the lines that end on
 *  it. An override outranks both — see the note at the top of this file. */
export function zoneCentroidMap(zonesGJ, linestringGJ) {
  const out = {};
  for (const f of zonesGJ?.features || []) {
    const z = f.properties?.z;
    const c = z && overrideCentroid(f.properties);
    if (c) out[z] = c;
  }
  for (const f of linestringGJ?.features || []) {
    const coords = f.geometry?.coordinates;
    if (!coords?.length) continue;
    const z  = f.properties?.z;
    const z2 = f.properties?.z_other || f.properties?.z2;
    if (z  && !out[z])  out[z]  = coords[0];
    if (z2 && !out[z2]) out[z2] = coords[coords.length - 1];
  }
  for (const f of zonesGJ?.features || []) {
    const z = f.properties?.z;
    if (!z || out[z]) continue;
    const c = featureCentroid(f);
    if (c) out[z] = c;
  }
  return out;
}
