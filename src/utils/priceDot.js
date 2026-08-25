// The dot that marks a zone price on a results map.
//
// One definition, because the map has to be readable as a single scale: an internal
// price and a border price sit on the same colour ramp, and a dot that is two pixels
// wider on one side of the border reads as "more important" when it is only "drawn by
// different code". The two used to be written out separately -- 10px content-box with a
// solid ring on the pages, 13px border-box with a 2px dashed ring in extZones -- and the
// external one came out visibly heavier.
//
// So: same box, same diameter, same ring width. What separates a border price from a
// solved one is the ring *style* -- dashed, and only just visible at reading distance --
// plus the grey zone under it and the tooltip. That is deliberate: a border price is an
// input someone typed, not a marginal the model produced, and the map should not let the
// two be mistaken for one another. It should also not shout about it.

/** @param {string} color  fill, off the page's own price ramp
 *  @param {string} title  the native tooltip
 *  @param {{external?: boolean}} [opts]  external = a border price (input), dashed ring */
export function priceDotEl(color, title, { external = false } = {}) {
  const ring = external ? '1.5px dashed rgba(120,120,120,0.95)' : '1.5px solid rgba(255,255,255,0.7)';
  const el = document.createElement('div');
  el.style.cssText = `width:13px;height:13px;box-sizing:border-box;border-radius:50%;background:${color};`
    + `border:${ring};box-shadow:0 1px 4px rgba(0,0,0,0.4);cursor:pointer;`;
  el.title = title;
  return el;
}
