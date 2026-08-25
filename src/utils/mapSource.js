// Reading a source from a map that may already be gone.
//
// maplibre implements Map.getSource as `return this.style.getSource(id)`, and a map
// that has been removed no longer has a style. Every `map.getSource(...)` reached by
// an effect or a fetch callback that outlived its map therefore throws "Cannot read
// properties of undefined (reading 'getSource')" and takes the whole page with it —
// a white screen with the error in the console and nothing rendered.
//
// The guards that were written around those calls all test that `map` is truthy,
// which it still is: mapRef.current holds a removed Map object, not null. So the
// question to ask is not whether there is a map but whether it can still answer,
// and that is what this asks.

/** Whether the map is still mounted and its style still answers. */
export function alive(map) {
  return Boolean(map && map.style);
}

/** The source, or null if the map cannot answer for it (removed, or no such source). */
export function source(map, id) {
  if (!alive(map)) return null;
  try {
    return map.getSource(id) || null;
  } catch {
    return null;
  }
}

/** The layer, under the same rule: getLayer is `this.style.getLayer(id)` as well. */
export function layer(map, id) {
  if (!alive(map)) return null;
  try {
    return map.getLayer(id) || null;
  } catch {
    return null;
  }
}

// ── Is this map ready to take layers? ────────────────────────────────────────
//
// alive() answers "can the map still be asked questions". This answers a different
// one: "has *this* map finished loading its style", which is what maplibre demands
// before addSource / addLayer / setFilter — Style._checkLoaded() throws
// "Style is not done loading" otherwise.
//
// The pages used to answer it with a `mapLoadedCount` counter bumped in each map's
// load handler. A counter says "some map finished loading at some point", and it
// never goes back down: when a page rebuilds its map — a new run means new
// zones.geojson, which the map effect depends on — the count is still ≥ 1 while the
// fresh map's style is empty. Every effect gated on it then fired against a map that
// could not take layers yet, and the first addSource took the page down.
//
// So readiness is tracked per map object. A WeakSet, because the entry must die with
// the map it describes: a removed map must never be able to answer "ready" again, and
// nothing here should keep one alive.
const readyMaps = new WeakSet();

/** Call once the map's style is loaded and its layers are built — at the end of the
 *  `load` handler, next to whatever state bump makes the dependent effects re-run. */
export function markStyleReady(map) {
  if (map) readyMaps.add(map);
}

/** Whether this exact map is mounted and can take sources and layers. */
export function styleReady(map) {
  return alive(map) && readyMaps.has(map);
}
