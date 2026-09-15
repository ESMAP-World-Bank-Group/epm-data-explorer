import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FMT, compactNumber, stackOf, stackTotals, barTotalFooter, barTotalPlugin } from '../src/utils/barTotals.js';

const chartOf = (datasets, extra = {}) => ({
  config: { type: 'bar' },
  data: { labels: ['2030'], datasets },
  isDatasetVisible: () => true,
  ...extra,
});
const item = (chart, i, axis = 'y') => ({
  chart, dataIndex: 0, dataset: chart.data.datasets[i], parsed: { [axis]: chart.data.datasets[i].data[0] },
});

test('DEFAULT_FMT: whole above 100, three figures below', () => {
  assert.equal(DEFAULT_FMT(1234.6), '1,235');
  assert.equal(DEFAULT_FMT(12.34), '12.3');
  assert.equal(DEFAULT_FMT(1.234), '1.2');
  assert.equal(DEFAULT_FMT(-250.4), '-250');
});

test('compactNumber: k and M, one decimal below ten of the unit', () => {
  assert.equal(compactNumber(1234), '1.2k');
  assert.equal(compactNumber(12345), '12k');
  assert.equal(compactNumber(-12345), '-12k');
  assert.equal(compactNumber(2.5e6), '2.5M');
  assert.equal(compactNumber(45e6), '45M');
  assert.equal(compactNumber(50), '50');
});

test('stackOf: the explicit stack, else the dataset type, else the chart type', () => {
  assert.equal(stackOf({ stack: 'base' }), 'base');
  assert.equal(stackOf({ type: 'line' }), 'line');
  assert.equal(stackOf({}, 'bar'), 'bar');
});

test('stackTotals: one group per stack, extras drawn but not counted, lines left out', () => {
  const ds = [
    { stack: 'A', data: [10] },
    { stack: 'A', data: [-4] },
    { stack: 'B', data: [5] },
    { stack: 'A', data: [3], _extra: true },
    { type: 'line', data: [100] },
  ];
  const [a, b, ...rest] = stackTotals(ds, 0);
  assert.equal(rest.length, 0);
  assert.deepEqual(a, { key: 'A', first: 0, plants: 6, pos: 13, neg: -4, n: 2, nonzero: true, hasExtra: true });
  assert.deepEqual(b, { key: 'B', first: 2, plants: 5, pos: 5, neg: 0, n: 1, nonzero: true, hasExtra: false });
});

test('stackTotals: hidden datasets and all zero stacks', () => {
  const ds = [{ data: [10] }, { data: [20] }, { stack: 'Z', data: [0] }];
  const [g, z] = stackTotals(ds, 0, { isVisible: i => i !== 1 });
  assert.equal(g.key, 'bar');
  assert.equal(g.plants, 10);
  assert.equal(z.nonzero, false);
});

test('barTotalFooter: total and the hovered segment share', () => {
  const chart = chartOf([
    { label: 'Gas', stack: 'base', data: [30] },
    { label: 'Hydro', stack: 'base', data: [70] },
  ]);
  const footer = barTotalFooter({ axis: 'y', unit: 'MW' });
  assert.equal(footer([item(chart, 0)]), 'Total: 100 MW  (30%)');
  assert.equal(footer([item(chart, 0), item(chart, 1)]), 'Total: 100 MW');
  assert.equal(barTotalFooter({ axis: 'y', unit: 'MW', filtered: true })([item(chart, 1), item(chart, 0)]),
    'Total shown: 100 MW');
});

test('barTotalFooter: one line per hovered stack, named after it', () => {
  const chart = chartOf([
    { stack: 'base', data: [30] }, { stack: 'base', data: [70] },
    { stack: 'alt', data: [50] }, { stack: 'alt', data: [30] },
  ]);
  const footer = barTotalFooter({ axis: 'y', unit: 'MW' });
  assert.deepEqual(footer(chart.data.datasets.map((_, i) => item(chart, i))),
    ['base total: 100 MW', 'alt total: 80 MW']);
});

test('barTotalFooter: a Δ gives the signed net and no share, whatever line is hovered', () => {
  const chart = chartOf([
    { stack: 'alt', data: [20] },
    { stack: 'alt', data: [-8] },
    { type: 'line', label: 'Δ Net', data: [12] },
  ]);
  const footer = barTotalFooter({ axis: 'y', unit: 'GWh', delta: true });
  assert.equal(footer([item(chart, 0)]), 'Net: +12 GWh');
  assert.equal(footer(chart.data.datasets.map((_, i) => item(chart, i))), 'Net: +12 GWh');
});

test('barTotalFooter: nothing for a lone plant dataset, plants flagged next to extras', () => {
  const lone = chartOf([{ stack: 'base', data: [30] }]);
  assert.equal(barTotalFooter({ axis: 'y' })([item(lone, 0)]), '');
  const withExtra = chartOf([
    { stack: 'base', data: [80] },
    { stack: 'base', data: [20], _extra: true },
  ]);
  const footer = barTotalFooter({ axis: 'y', unit: 'GWh' });
  assert.equal(footer([item(withExtra, 1)]), 'Total (plants): 80 GWh');
  assert.equal(footer([item(withExtra, 0)]), 'Total (plants): 80 GWh  (100%)');
});

test('barTotalPlugin: the value axis is raised until the label clears the plot top', () => {
  const chart = chartOf([{ stack: 's', data: [100] }, { stack: 's', data: [50] }], {
    ctx: { save() {}, restore() {}, font: '', measureText: s => ({ width: s.length * 5 }) },
    chartArea: { width: 300, height: 200 },
  });
  const scale = { id: 'y', min: 0, max: 150 };
  barTotalPlugin({ axis: 'y' }).afterDataLimits(chart, { scale });
  assert.equal(scale.min, 0);
  assert.ok(scale.max > 150);
  const room = ((scale.max - 150) / scale.max) * 200;
  assert.ok(room >= 4 + 9 - 1e-9, `label room ${room}px`);
});
