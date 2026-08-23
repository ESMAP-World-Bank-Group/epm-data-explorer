// Colours and fills for the results charts.
//
// The region, country and zone pages each carried their own copy of the techfuel
// palette. They had drifted — Imports was yellow on one page and the anonymous
// fallback grey on the other two — so the same stack read differently depending
// on which page you were looking at. One table now, imported by all three.
//
// Imports, Exports and Unmet demand are not generation, but they sit in the same
// stack as it: on the dispatch chart because EPM writes them as dispatch rows, and
// on the annual energy chart because generation alone does not balance demand.
// They are textured rather than flat -- imports hatched one way, exports the other,
// and the flows that leave the zones on screen dotted instead of striped -- so the
// eye separates "traded" and "not served" from "produced" before it reads a colour.
//
// Their two hues are ones no fuel uses: a rose and a deep teal. Trade used to borrow
// indianred and seagreen, which put imports next to the unmet-demand red and exports
// next to the biomass greens, so either pair read as one block inside a stack.

import { normalizeFuel, EPM_FUEL_COLORS } from './epmFetch';

export const IMPORT_COLOR = '#C25E7A'; // rose - a hue no fuel uses, and it leaves red to unmet demand
export const EXPORT_COLOR = '#0F766E'; // deep teal - far darker than the winds, clear of the biomass greens
export const UNMET_COLOR  = '#FF1744'; // unserved energy: the one alarm colour on the chart

export const TECHFUEL_COLORS = {
  Nuclear:'#C8A8F0', Coal:'#808890', Peat:'#A0856C', 'Domestic Coal':'#6A5C4C',
  Gas:'#9A7040', CCGT:'#B8921A', OCGT:'#C4A820', Methane:'#D4B030',
  Diesel:'#6A7888', HFO:'#7A7068', Oil:'#7A7068',
  Biomass:'#52C860', Waste:'#8A9098', Biogas:'#72DC8A', Geothermal:'#D4A820',
  Reservoir:'#1E9AF5', ROR:'#5DADE2', 'Run-of-River':'#5DADE2', ReservoirHydro:'#1E9AF5',
  Solar:'#FFD700', PV:'#FFD700', CSP:'#E8C547', RPV:'#FFD700',
  'Onshore Wind':'#44DAEC', OnshoreWind:'#44DAEC', ST:'#C8A8F0',
  'Offshore Wind':'#7CC8FA', OffshoreWind:'#7CC8FA',
  // Storage is one colour whichever way the energy runs: what charges below the
  // axis is what discharges above it, and EPM's 'Storage Charge' had been falling
  // through to the anonymous grey. PSH keeps a darker shade of the same slate blue,
  // so the two storage technologies still read apart inside the stack.
  Battery:'#6A5ACD', Storage:'#6A5ACD',
  'Storage Charge':'#6A5ACD', StorageCharge:'#6A5ACD', 'Storage Discharge':'#6A5ACD',
  PSH:'#4A3FA0', Pumped:'#4A3FA0', 'Pumped Storage':'#4A3FA0',
  'PV+Storage':'#C8E860',
  Demand:'#9B59B6', ICE:'#6A7888',
  Imports:IMPORT_COLOR, Exports:EXPORT_COLOR,
  'Unmet demand':UNMET_COLOR, 'Unmet Demand':UNMET_COLOR, UnmetDemand:UNMET_COLOR,
  // The annual charts split trade by whether it crosses out of the zones on screen.
  // The texture is what tells the two apart; the lightness is only a backup, for a
  // bar too thin to hold a pattern and for printing in black and white.
  'Imports (ext.)':IMPORT_COLOR, 'Imports (int.)':'#D68DA1',
  'Exports (ext.)':EXPORT_COLOR, 'Exports (int.)':'#4FA39C',
};

/** How each traded series is textured. Imports and exports hatch opposite ways, so a
 *  stack holding both is readable in one glance; the flows that cross out of the zones
 *  on screen are dotted, which stays visible on a bar too thin to show two stripes.
 *  Dispatch has no int/ext split to make -- EPM aggregates both into one Imports row
 *  per timeslice -- so its Imports and Exports keep the plain hatch. */
export const TEXTURE = {
  Imports:          { kind: 'hatch', dir:  1 },
  Exports:          { kind: 'hatch', dir: -1 },
  'Imports (int.)': { kind: 'hatch', dir:  1 },
  'Exports (int.)': { kind: 'hatch', dir: -1 },
  'Imports (ext.)': { kind: 'dot' },
  'Exports (ext.)': { kind: 'dot' },
};

/** Where a series belongs in a stack, and so in the legend: generation at the bottom,
 *  then what was traded, then the demand that was never served at all. This used to
 *  fall out of whatever order the builders happened to push their datasets in, which
 *  is how Exports ended up between Diesel and Gas on the dispatch chart.
 *  Multi-scenario labels are prefixed 'scenario — series', hence the split. */
export function seriesRank(label) {
  const l = label.includes(' — ') ? label.split(' — ')[1] : label;
  if (/^unmet\s*demand$/i.test(l)) return 2;
  return TEXTURE[l] ? 1 : 0;
}

export function techColor(tf) {
  return TECHFUEL_COLORS[tf] || EPM_FUEL_COLORS[normalizeFuel(tf)] || '#AAAAAA';
}

export function hexA(hex, a) {
  if (!hex || hex.length < 7) return `rgba(128,128,128,${a})`;
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// ── Textures ─────────────────────────────────────────────────────────────────
// Chart.js has no pattern fill of its own, but it takes anything the canvas takes,
// so a CanvasPattern built from a small repeating tile does the job. The tile is
// built once per (colour, alpha, texture) — the pages rebuild their datasets on
// every render and a fresh canvas each time would be a canvas per frame.

const TILE = 6;         // tile side in px; stripe period is TILE/√2 ≈ 4.2px across
const STRIPE = 2;       // stripe width in px
const DOT_R = 1.25;     // dot radius in px
const DOT_AT = [[1.5, 1.5], [4.5, 4.5]]; // two per tile, staggered, so the dots read as a lattice
const patternCache = new Map();
let patternCtx = null;

function hatchTile(color, alpha, dir) {
  const c = document.createElement('canvas');
  c.width = c.height = TILE;
  const g = c.getContext('2d');
  g.fillStyle = hexA(color, alpha * 0.35);
  g.fillRect(0, 0, TILE, TILE);
  g.strokeStyle = hexA(color, Math.min(1, alpha + 0.2));
  g.lineWidth = STRIPE;
  g.lineCap = 'square';
  // Three passes, offset by a full tile either way, so the stripes meet across
  // the tile seams instead of stopping at them.
  for (const off of [-TILE, 0, TILE]) {
    g.beginPath();
    if (dir >= 0) { g.moveTo(off - 1, TILE + 1); g.lineTo(off + TILE + 1, -1); }
    else          { g.moveTo(off - 1, -1);       g.lineTo(off + TILE + 1, TILE + 1); }
    g.stroke();
  }
  return c;
}

function dotTile(color, alpha) {
  const c = document.createElement('canvas');
  c.width = c.height = TILE;
  const g = c.getContext('2d');
  g.fillStyle = hexA(color, alpha * 0.35);
  g.fillRect(0, 0, TILE, TILE);
  g.fillStyle = hexA(color, Math.min(1, alpha + 0.2));
  for (const [x, y] of DOT_AT) { g.beginPath(); g.arc(x, y, DOT_R, 0, Math.PI * 2); g.fill(); }
  return c;
}

/** A textured fill, as a CanvasPattern. Falls back to the flat colour where there is
 *  no document to build a tile in. */
function patternFill(color, alpha, { kind, dir = 1 }) {
  const flat = hexA(color, alpha);
  if (typeof document === 'undefined') return flat;
  const key = `${color}|${alpha}|${kind}|${dir}`;
  if (patternCache.has(key)) return patternCache.get(key);
  try {
    if (!patternCtx) patternCtx = document.createElement('canvas').getContext('2d');
    const tile = kind === 'dot' ? dotTile(color, alpha) : hatchTile(color, alpha, dir);
    const p = patternCtx.createPattern(tile, 'repeat') || flat;
    patternCache.set(key, p);
    return p;
  } catch { return flat; }
}

/** The same texture as a CSS background, for the legend swatches — those are divs,
 *  not canvas, so the chip has to be reproduced rather than reused. */
function patternCss(color, alpha, { kind, dir = 1 }) {
  const base = hexA(color, alpha * 0.35), line = hexA(color, Math.min(1, alpha + 0.2));
  if (kind === 'dot') {
    const dots = DOT_AT.map(([x, y]) =>
      `radial-gradient(circle at ${x}px ${y}px, ${line} ${DOT_R}px, transparent ${DOT_R + 0.4}px) 0 0 / ${TILE}px ${TILE}px`);
    return `${dots.join(', ')}, linear-gradient(${base}, ${base})`;
  }
  const period = (TILE / Math.SQRT2).toFixed(1);
  return `repeating-linear-gradient(${dir >= 0 ? -45 : 45}deg, ${line} 0 ${STRIPE}px, ${base} ${STRIPE}px ${period}px)`;
}

/** Chart fill for a series: textured if it is one of the traded ones, flat otherwise. */
export function fillFor(tf, alpha = 0.75) {
  const tex = TEXTURE[tf];
  return tex ? patternFill(techColor(tf), alpha, tex) : hexA(techColor(tf), alpha);
}

/** The legend chip matching fillFor. */
export function cssFillFor(tf, alpha = 0.75) {
  const tex = TEXTURE[tf];
  return tex ? patternCss(techColor(tf), alpha, tex) : techColor(tf);
}

/** A legend item for a series, ready for makeLegend. */
export const legendItem = (tf) => ({ label: tf, color: techColor(tf), fill: cssFillFor(tf) });
