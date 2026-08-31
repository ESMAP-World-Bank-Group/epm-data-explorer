// The total of a stacked bar, written at its end and repeated in the tooltip.
//
// A stacked capacity mix answers "what is this zone made of" and, until 2026-08-31,
// nothing at all answered "how much does this zone have". The tooltip named one techfuel,
// the one under the cursor, and the axis was shared by bars spanning a factor of 170
// (Nakhchivan 206 MW against WestAna 35 555 MW in the 2030 baseline), so the small zones
// were slivers with no readable size. The whole region total existed as a card above the
// chart; nothing gave it per bar.
//
// Chart.js has no built-in value label, and pulling chartjs-plugin-datalabels in for one
// number would add a dependency to every page that draws a chart. This is the small local
// plugin instead, written once so the region and the country pages cannot drift apart.
//
// What the total counts: the datasets the chart actually holds. The pages filter their
// datasets on the clickable legend before handing them over, so a hidden techfuel is gone
// by the time the plugin runs and the number matches the bar that is drawn rather than a
// mix the reader cannot see. `filtered` lets the tooltip say so.

const DEFAULT_FMT = v => Math.round(v).toLocaleString('en-US');

/** Sum of the visible datasets at one index, which is the length of that stacked bar. */
export function visibleStackTotal(chart, dataIndex) {
  let total = 0;
  const ds = chart?.data?.datasets || [];
  for (let i = 0; i < ds.length; i++) {
    if (chart.isDatasetVisible && !chart.isDatasetVisible(i)) continue;
    total += Number(ds[i].data?.[dataIndex]) || 0;
  }
  return total;
}

/**
 * A chart.js plugin that writes each stacked bar's total just past its end.
 *
 * @param axis  the value axis, 'x' for a horizontal bar chart (indexAxis 'y'), else 'y'
 * @param color the text colour, normally the theme's label colour
 * @param fmt   how to render the number, unit excluded
 * @param unit  appended after the number, e.g. 'MW'
 *
 * Leave room for it with layout.padding on the value axis side, else the text is clipped.
 */
export function barTotalPlugin({ axis = 'x', color = '#333', fmt = DEFAULT_FMT, unit = '', size = 10, pad = 6 } = {}) {
  return {
    id: 'barTotals',
    afterDatasetsDraw(chart) {
      const scale = chart.scales?.[axis];
      if (!scale) return;
      // The geometry comes from the first visible dataset: every dataset of a stack shares
      // the bar's position on the index axis, only its extent on the value axis differs.
      let ref = -1;
      for (let i = 0; i < (chart.data.datasets || []).length; i++) {
        if (!chart.isDatasetVisible || chart.isDatasetVisible(i)) { ref = i; break; }
      }
      if (ref < 0) return;
      const meta = chart.getDatasetMeta(ref);
      const n = chart.data.labels?.length || 0;
      const ctx = chart.ctx;
      ctx.save();
      ctx.fillStyle = color;
      ctx.font = `600 ${size}px system-ui, -apple-system, sans-serif`;
      for (let idx = 0; idx < n; idx++) {
        const total = visibleStackTotal(chart, idx);
        if (!total) continue;
        const el = meta.data?.[idx];
        if (!el) continue;
        const p = scale.getPixelForValue(total);
        const txt = unit ? `${fmt(total)} ${unit}` : fmt(total);
        if (axis === 'x') {
          ctx.textBaseline = 'middle';
          ctx.textAlign = total >= 0 ? 'left' : 'right';
          ctx.fillText(txt, p + (total >= 0 ? pad : -pad), el.y);
        } else {
          ctx.textAlign = 'center';
          ctx.textBaseline = total >= 0 ? 'bottom' : 'top';
          ctx.fillText(txt, el.x, p + (total >= 0 ? -pad : pad));
        }
      }
      ctx.restore();
    },
  };
}

/**
 * A tooltip footer giving the bar's total and the hovered segment's share of it.
 *
 * `filtered` says whether the legend is currently hiding techfuels, so the reader knows
 * the total describes what is on screen and not the whole mix.
 */
export function barTotalFooter({ axis = 'x', unit = '', fmt = DEFAULT_FMT, filtered = false } = {}) {
  return items => {
    const it = items?.[0];
    if (!it) return '';
    const total = visibleStackTotal(it.chart, it.dataIndex);
    if (!total) return '';
    const v = Number(it.parsed?.[axis]) || 0;
    const share = total ? (v / total) * 100 : 0;
    const head = filtered ? 'Total shown' : 'Total';
    return `${head}: ${fmt(total)}${unit ? ' ' + unit : ''}  (${share.toFixed(share < 10 ? 1 : 0)}%)`;
  };
}
