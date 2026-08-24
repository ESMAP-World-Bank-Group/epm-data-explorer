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
