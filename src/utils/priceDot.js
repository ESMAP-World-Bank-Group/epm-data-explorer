// The dot that marks a zone price on a results map.
//
// One definition, because the map has to be readable as a single scale: an internal
// price and a border price sit on the same colour ramp, and a dot that looks heavier on
// one side of the border reads as "more important" when it is only "drawn by different
// code". The two were written out separately once -- 10px content-box with a solid ring
// on the pages, 13px border-box with a 2px dashed ring in extZones -- and the external
// one came out visibly bigger.
//
// Same box, same diameter, same ring. Making the ring dashed instead was still too much
// of a difference: at 13px an interrupted grey outline does not read as "same dot, other
// provenance", it reads as a different kind of object. So the outline is now identical
// on both, and what marks a border price is a hatch *inside* the dot -- the fill itself,
// still on the ramp, just visibly textured.
//
// The distinction is worth keeping: a border price is an input someone typed, not a
// marginal the model produced, and the map should not let the two be mistaken for one
// another. It should also not shout about it. A hatch is the quietest way to say it, and
// it is the same device the annual charts use to mark traded series.

/** 45° hatch over the fill: transparent, then a thin dark stripe. Sizes are in px and
 *  deliberately small -- at 13px across, a dot fits about four stripes, which is enough
 *  to register as texture and not enough to hide the colour the ramp assigned. */
const HATCH = 'repeating-linear-gradient(45deg,'
  + ' rgba(0,0,0,0) 0 2px, rgba(0,0,0,0.42) 2px 3.4px)';

/** @param {string} color  fill, off the page's own price ramp
 *  @param {string} title  the native tooltip
 *  @param {{external?: boolean}} [opts]  external = a border price (an input), hatched */
export function priceDotEl(color, title, { external = false } = {}) {
  const el = document.createElement('div');
  el.style.cssText = 'width:13px;height:13px;box-sizing:border-box;border-radius:50%;'
    + `background-color:${color};`
    + (external ? `background-image:${HATCH};` : '')
    + 'border:1.5px solid rgba(255,255,255,0.7);'
    + 'box-shadow:0 1px 4px rgba(0,0,0,0.4);cursor:pointer;';
  el.title = title;
  return el;
}
