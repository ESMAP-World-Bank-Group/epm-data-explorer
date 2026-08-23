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
// They are drawn hatched (imports leaning one way, exports the other) so the eye
// separates "traded" and "not served" from "produced" without another hue having
// to be found that no fuel already uses.

import { normalizeFuel, EPM_FUEL_COLORS } from './epmFetch';

export const IMPORT_COLOR = '#CD5C5C'; // indianred
export const EXPORT_COLOR = '#2E8B57'; // seagreen — clear of Biomass #52C860 and Biogas #72DC8A
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
  // Same hue either way, lighter for the flows that stay inside.
  'Imports (ext.)':IMPORT_COLOR, 'Imports (int.)':'#E39C9C',
  'Exports (ext.)':EXPORT_COLOR, 'Exports (int.)':'#7FC4A0',
};

/** Which series are hatched, and which way the stripes lean. Imports and exports
 *  lean opposite ways so a stack holding both is readable in one glance. */
export const HATCH_DIR = {
  Imports: 1, 'Imports (int.)': 1, 'Imports (ext.)': 1,
  Exports: -1, 'Exports (int.)': -1, 'Exports (ext.)': -1,
};

export function techColor(tf) {
  return TECHFUEL_COLORS[tf] || EPM_FUEL_COLORS[normalizeFuel(tf)] || '#AAAAAA';
}

export function hexA(hex, a) {
  if (!hex || hex.length < 7) return `rgba(128,128,128,${a})`;
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// ── Hatching ─────────────────────────────────────────────────────────────────
// Chart.js has no pattern fill of its own, but it takes anything the canvas takes,
// so a CanvasPattern built from a small repeating tile does the job. The tile is
// built once per (colour, alpha, direction) — the pages rebuild their datasets on
// every render and a fresh canvas each time would be a canvas per frame.

const TILE = 6;         // tile side in px; stripe period is TILE/√2 ≈ 4.2px across
const STRIPE = 2;       // stripe width in px
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

/** A diagonally hatched fill, as a CanvasPattern. Falls back to the flat colour
 *  where there is no document to build a tile in. */
export function hatchFill(color, { alpha = 0.75, dir = 1 } = {}) {
  const flat = hexA(color, alpha);
  if (typeof document === 'undefined') return flat;
  const key = `${color}|${alpha}|${dir}`;
  if (patternCache.has(key)) return patternCache.get(key);
  try {
    if (!patternCtx) patternCtx = document.createElement('canvas').getContext('2d');
    const p = patternCtx.createPattern(hatchTile(color, alpha, dir), 'repeat') || flat;
    patternCache.set(key, p);
    return p;
  } catch { return flat; }
}

/** The same hatch as a CSS background, for the legend swatches — those are divs,
 *  not canvas, so the chip has to be reproduced rather than reused. */
export function hatchCss(color, { alpha = 0.75, dir = 1 } = {}) {
  const base = hexA(color, alpha * 0.35), line = hexA(color, Math.min(1, alpha + 0.2));
  const period = (TILE / Math.SQRT2).toFixed(1);
  return `repeating-linear-gradient(${dir >= 0 ? -45 : 45}deg, ${line} 0 ${STRIPE}px, ${base} ${STRIPE}px ${period}px)`;
}

/** Chart fill for a series: hatched if it is one of the traded ones, flat otherwise. */
export function fillFor(tf, alpha = 0.75) {
  const dir = HATCH_DIR[tf];
  return dir ? hatchFill(techColor(tf), { alpha, dir }) : hexA(techColor(tf), alpha);
}

/** The legend chip matching fillFor. */
export function cssFillFor(tf, alpha = 0.75) {
  const dir = HATCH_DIR[tf];
  return dir ? hatchCss(techColor(tf), { alpha, dir }) : techColor(tf);
}

/** A legend item for a series, ready for makeLegend. */
export const legendItem = (tf) => ({ label: tf, color: techColor(tf), fill: cssFillFor(tf) });
