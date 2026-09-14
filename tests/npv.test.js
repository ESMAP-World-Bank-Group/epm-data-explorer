// Unit tests for src/utils/npv.js, on synthetic runs small enough to check by hand.
// Run with `npm test` (node's built-in runner, no dependency).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNpv, processNpvInput, npvCheckNotes, npvTolerance } from '../src/utils/npv.js';

const INV = 'Investment costs: $m';
const FUEL = 'Fuel costs: $m';
const EXT = 'Export revenues with external zones: $m';
const IMP_INT = 'Import costs with internal zones: $m';
const EXP_INT = 'Export revenues with internal zones: $m';
const SHARED = 'Trade shared benefits: $m';

/** One scenario's resultsData entry, from { zone: { cost line: $m } }. */
const scen = (byZone, npvSystem, { zoneCountry = {}, yearlyZone } = {}) => ({
  npvRaw: { byZone, zoneCountry, factors: {}, years: ['2040'], lastYear: '2040' },
  npvSystem, yearlyZone,
});
const build = (resultsData, opts = {}) => buildNpv({
  scenarios: Object.keys(resultsData), resultsData, zoneToCountry: z => z, ...opts,
}).byScen;

test('export line written as a cost (negative) is read as written', () => {
  const { S } = build({ S: scen({ A: { [INV]: 100, [FUEL]: 50, [EXT]: -30 }, B: { [INV]: 80, [FUEL]: 20 } }, 220) });
  assert.equal(S.exportSign, 1);
  assert.equal(S.comps.exp_ext, -30);
  assert.equal(S.total, 220);
  assert.equal(S.reconciled, true);
  assert.equal(S.comps.unexpl, undefined);
});

test('export line written as a magnitude (old report) is flipped', () => {
  const { S } = build({ S: scen({ A: { [INV]: 100, [FUEL]: 50, [EXT]: 30 }, B: { [INV]: 80, [FUEL]: 20 } }, 220) });
  assert.equal(S.exportSign, -1);
  assert.equal(S.comps.exp_ext, -30);
  assert.equal(S.byCountry.A.exp_ext, -30);
  assert.equal(S.total, 220);
  assert.equal(S.reconciled, true);
});

test('without the model NPV, a positive export line is taken as the old magnitude', () => {
  const { S } = build({ S: scen({ A: { [INV]: 100, [EXT]: 30 } }, null) });
  assert.equal(S.exportSign, -1);
  assert.equal(S.residual, null);
  assert.equal(S.reconciled, true);
  assert.equal(S.total, 70);
});

test('sound internal trade nets to zero: left out of the region, kept per country', () => {
  const { S } = build({ S: scen({
    A: { [INV]: 100, [IMP_INT]: 40, [SHARED]: -3 },
    B: { [INV]: 50, [EXP_INT]: -34, [SHARED]: -3 },
  }, 150) });
  assert.equal(S.total, 150);
  assert.equal(S.internalImbalance, 0);
  assert.equal(S.comps.int_net, undefined);
  assert.equal(S.byCountry.A.imp_int, 40);
  assert.equal(S.byCountry.B.exp_int, -34);
  assert.deepEqual(S.noDemandZones, []);
  assert.deepEqual(npvCheckNotes({ S }, ['S']), []);
});

// The cesi_grid_20260913 case: export line written as a cost, and a transit hub without
// demand whose trade the pre-fix report booked on the hub side only.
const hubRun = () => scen({
  Main: { [INV]: 100, [FUEL]: 50, [EXT]: -30 },
  Hub:  { [IMP_INT]: 460, [EXP_INT]: -48, [SHARED]: -5 },
}, 120, {
  zoneCountry: { Main: 'Azerbaijan', Hub: 'Azerbaijan' },
  yearlyZone: { Main: { DemandEnergyZone: { 2040: 10 } }, Hub: { Costs: { 2040: 5 } } },
});

test('one-sided hub trade: region total stays exact, the imbalance and the hub are named', () => {
  const { S } = build({ S: hubRun() });
  assert.equal(S.exportSign, 1);
  assert.equal(S.internalImbalance, 407);
  assert.equal(S.total, 120);
  assert.equal(S.reconciled, true);
  assert.equal(S.comps.unexpl, undefined);
  assert.deepEqual(S.noDemandZones, ['Hub']);
  assert.deepEqual(S.noDemandCountries, ['Azerbaijan']);
  assert.equal(S.byCountry.Hub.imp_int, 460);
  const notes = npvCheckNotes({ S }, ['S']);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /S \(\+407 M\$\)/);
  assert.match(notes[0], /\(Hub\)/);
  assert.match(notes[0], /Azerbaijan/);
  assert.match(notes[0], /rerun/);
});

test('a gap to the model NPV is drawn as Unexplained, and the total is the model NPV', () => {
  // No capex line in pCosts and no summary.csv: the capex is missing, not zero.
  const { S } = build({ S: scen({ A: { [FUEL]: 50 } }, 150) });
  assert.equal(S.hasCapex, false);
  assert.equal(S.residual, -100);
  assert.equal(S.reconciled, false);
  assert.equal(S.comps.unexpl, 100);
  assert.equal(S.total, 150);
  assert.equal(S.byCountry.A.unexpl, undefined);
  const notes = npvCheckNotes({ S }, ['S']);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /S \(-100 M\$\)/);
  assert.match(notes[0], /Unexplained/);
});

test('external interconnector capex adds to the total but not to the check', () => {
  const { S } = build({ S: scen({ A: { [INV]: 100 } }, 100) }, { extNpv: { S: { A: 500 } } });
  assert.equal(S.comps.newcap, 500);
  assert.equal(S.total, 600);
  assert.equal(S.residual, 0);
  assert.equal(S.hasExternal, true);
});

test('benefits between scenarios are differences of model NPVs', () => {
  const byScen = build({
    Ref: scen({ A: { [INV]: 300, [EXT]: 40 } }, 260),   // old report: magnitude
    Alt: hubRun(),                                      // new report, hub imbalance
  });
  assert.equal(byScen.Ref.total - byScen.Alt.total, 260 - 120);
});

test('processNpvInput takes the last discounted year and normalises year keys', () => {
  const rows = [
    { uni: FUEL, z: 'A', c: 'Aland', y: '2039.0', attribute: 'DiscountedWeightedCostsCumulated', value: '10' },
    { uni: FUEL, z: 'A', c: 'Aland', y: '2040.0', attribute: 'DiscountedWeightedCostsCumulated', value: '18' },
    { uni: FUEL, z: 'A', c: 'Aland', y: '2039.0', attribute: 'Costs', value: '20' },
    { uni: FUEL, z: 'A', c: 'Aland', y: '2040.0', attribute: 'Costs', value: '20' },
    { uni: 'NPV of system cost: $m', z: 'A', c: 'Aland', y: '2040.0', attribute: 'DiscountedWeightedCostsCumulated', value: '999' },
  ];
  const raw = processNpvInput(rows);
  assert.equal(raw.lastYear, '2040');
  assert.deepEqual(raw.byZone, { A: { [FUEL]: 18 } });
  assert.equal(raw.zoneCountry.A, 'Aland');
  assert.equal(raw.factors['2040'], 0.4);
});

test('npvTolerance is $1m or a hundredth of a percent of the NPV', () => {
  assert.equal(npvTolerance(100), 1);
  assert.equal(npvTolerance(-220000), 22);
  assert.equal(npvTolerance(null), 1);
});
