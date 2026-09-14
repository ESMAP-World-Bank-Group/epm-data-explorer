// Unit tests for src/utils/scenarioOrder.js. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseFirst, baseScenario } from '../src/utils/scenarioOrder.js';

test('baseScenario prefers a plain baseline, then a prefixed one, then the first', () => {
  assert.equal(baseScenario(['LC_BSSC', 'baseline', 'LC_Baseline']), 'baseline');
  assert.equal(baseScenario(['CESI_GECO', 'CESI_NoCorr', 'LC_Baseline', 'LC_BSSC']), 'LC_Baseline');
  assert.equal(baseScenario(['ISO', 'BSSC']), 'ISO');
  assert.equal(baseScenario([]), undefined);
});

test('baseFirst moves a prefixed baseline to the front and keeps the rest in order', () => {
  assert.deepEqual(baseFirst(['CESI_GECO', 'LC_Baseline', 'LC_BSSC']), ['LC_Baseline', 'CESI_GECO', 'LC_BSSC']);
  assert.deepEqual(baseFirst(['ISO', 'baseline']), ['baseline', 'ISO']);
  // A name that merely contains Baseline is a variant, not the baseline: order kept.
  assert.deepEqual(baseFirst(['A', 'LC_BaselineHigh']), ['A', 'LC_BaselineHigh']);
});
