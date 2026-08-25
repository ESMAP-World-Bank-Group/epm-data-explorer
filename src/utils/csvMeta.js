// --- Metadata stamped onto the CSVs EPM View hands out ---
//
// A result CSV used to leave with nothing on it that said what it held. Half of
// EPM's result files carry no unit at all -- pYearlyZoneMerged is
// `c,z,attribute,y,value` and nothing more -- and the ones that do hide it in a
// `uni` column that means a different thing in every file: a cost category in
// pCostsMerged, the facing zone in pTransmissionMerged, a fuel in
// pDispatchComplete. A reader had to already know the model to know whether a
// column was MW or GWh.
//
// So a download now leaves with a comment header saying where the file came from
// and, where the unit changes from row to row, a `unit` column.
//
// The units below are read off the parameter declarations in EPM's
// epm/generate_report.gms and then checked against the values a real run writes.
// Where the two disagree, what a run actually writes is what is recorded here:
//
//   * CapexInvestmentComponent is USD, not the $m every other cost attribute
//     uses (declared '[USD]', and the values confirm it -- they reach 2.4e10).
//   * InterconUtilization and CongestionShare are declared '[%]' but both are
//     computed as a plain share and never exceed 1.
//   * The *PerMWh attributes carry a `uni` label ending ': $m', copied by the
//     merge from the money parameter they are stacked onto. They are USD/MWh --
//     which is why the attribute is consulted before the label.
//
// EmissionsIntensityZone is deliberately left without a unit. generate_report.gms
// divides pEmissionsZone -- already scaled to Mt -- by GWh and labels the result
// tCO2/GWh, so a run writes 1e-9 of the declared unit (~3e-7 where the real
// intensity is ~350 tCO2/GWh). Stamping the declared unit on that would hand the
// reader a wrong number with a confident label on it.

/** attribute -> unit, for the result files that name an attribute per row. */
export const RESULT_UNIT_BY_ATTRIBUTE = {
  // Capacity [MW]
  CapacityPlant: 'MW', NewCapacityPlant: 'MW',
  CapacityTechFuel: 'MW', NewCapacityTechFuel: 'MW', NewCapacityTechFuelCumulated: 'MW',
  TransmissionCapacity: 'MW', NewTransmissionCapacity: 'MW',
  DemandPeakZone: 'MW',
  // Energy [GWh]
  EnergyPlant: 'GWh', EnergyTechFuelComplete: 'GWh', DemandEnergyZone: 'GWh',
  Interchange: 'GWh', NetImport: 'GWh', ReserveSpinningTechFuel: 'GWh',
  // Money [million USD]
  Costs: '$m', CostsPlant: '$m', DiscountedWeightedCostsCumulated: '$m',
  NetPresentCostSystem: '$m',
  // Money [USD] -- see the note above, these two are not $m
  CapexInvestmentComponent: 'USD', CapexInvestmentComponentCumulated: 'USD',
  // Unit costs
  CostsPerMWh: 'USD/MWh', GenCostsPerMWh: 'USD/MWh', NetPresentCostPerMWh: 'USD/MWh',
  NetPresentCostSystemPerMWh: 'USD/MWh', PlantAnnualLCOE: 'USD/MWh',
  // Shares, 0-1 -- not percentages, whatever generate_report.gms declares
  UtilizationTechFuel: 'share (0-1)', UtilizationPlant: 'share (0-1)',
  InterconUtilization: 'share (0-1)', CongestionShare: 'share (0-1)',
  // Emissions
  EmissionsZone: 'Mt CO2',
};

/** Files whose every row shares one unit, so no `attribute` is needed to place it. */
export const RESULT_UNIT_BY_FILE = {
  'pHourlyPrice.csv': 'USD/MWh',
  'pDispatchComplete.csv': 'MW',
};

/** Files that hold no measurement at all -- they get the header, not a unit column. */
const UNITLESS_FILES = new Set(['pSettings.csv', 'input_scenarios.csv']);

/** A readable name for each result file EPM publishes today. The names are the
 *  GAMS declarations in epm/generate_report.gms said plainly -- pCostsMerged is
 *  'Annual cost summary [million USD] by zone and year' -- not new coinages, so
 *  a reader who knows the model still recognises what they are looking at. */
export const RESULT_FILE_LABELS = {
  'pCostsMerged.csv': 'Annual costs by zone',
  'pYearlyZoneMerged.csv': 'Yearly zone indicators',
  'pTechFuelMerged.csv': 'Capacity & energy by technology',
  'pPlantMerged.csv': 'Plant-level results',
  'pTransmissionMerged.csv': 'Transmission & interchange',
  'pCapexInvestmentMerged.csv': 'Capex investment',
  'pNetPresentCostSystemMerged.csv': 'System net present cost',
  'pSummary.csv': 'Summary -- all indicators',
  'pDispatchComplete.csv': 'Hourly dispatch',
  'pHourlyPrice.csv': 'Hourly marginal price',
  'pEnergyBalance.csv': 'Energy balance',
  'pPrice.csv': 'Annual average price',
  'pSettings.csv': 'Run settings',
};

/** Readable name for a result file. An older run writes files this table has
 *  never heard of -- the tableau-era folders hold about forty-six of them -- so
 *  an unknown name is unpacked from its camel case rather than left blank:
 *  pEnergyByFuel -> 'Energy by fuel'. Acronyms are kept whole (LCOE, NPV). */
export function resultLabel(filename) {
  const parts = (filename || '').split('/').filter(Boolean);
  const key = parts[parts.length - 1] || '';
  if (!key) return '';
  // A split parameter is published as pDispatchComplete/y2030.csv: the folder is
  // the parameter and the leaf is the slice of it, so name it as both.
  if (parts.length > 1) return `${resultLabel(`${parts[parts.length - 2]}.csv`)} -- ${key.replace(/\.csv$/i, '')}`;
  if (RESULT_FILE_LABELS[key]) return RESULT_FILE_LABELS[key];
  const words = key.replace(/\.csv$/i, '')
    .replace(/^p(?=[A-Z])/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return key;
  return words.map((w, i) => (
    /^[A-Z0-9]{2,}$/.test(w) ? w
      : i === 0 ? w.charAt(0).toUpperCase() + w.slice(1)
        : w.charAt(0).toLowerCase() + w.slice(1)
  )).join(' ');
}

/** The unit hidden in a `uni` cell, for the files that put it there.
 *  'Carbon costs: $m' -> '$m', 'Demand: GWh' -> 'GWh'. A `uni` holding a zone or
 *  a fuel name ('Georgia', 'Onshore Wind') has no separator and yields nothing,
 *  which is what makes this safe to try on every file -- including pSummary,
 *  where both kinds of `uni` share the one column. */
function unitFromUni(uni) {
  const i = uni.lastIndexOf(': ');
  if (i === -1) return '';
  const tail = uni.slice(i + 2).trim();
  return tail && !tail.includes(',') && tail.length <= 16 ? tail : '';
}

/** Split a CSV into records that each keep the exact source text they came from,
 *  so an annotated file differs from the original only by what we append to it.
 *  Handles quoted fields, embedded separators and newlines, CRLF and LF. */
export function csvRecords(text) {
  const out = [];
  let i = 0, start = 0, field = '', fields = [], inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { fields.push(field); field = ''; i++; continue; }
    if (c === '\n' || c === '\r') {
      const eolAt = i;
      i += (c === '\r' && text[i + 1] === '\n') ? 2 : 1;
      fields.push(field);
      out.push({ fields, text: text.slice(start, eolAt), eol: text.slice(eolAt, i) });
      fields = []; field = ''; start = i;
      continue;
    }
    field += c; i++;
  }
  if (i > start || field || fields.length) {
    fields.push(field);
    out.push({ fields, text: text.slice(start), eol: '' });
  }
  return out;
}

const csvEscape = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Comment header. Leading with `#` is safe: no EPM result file contains one, so
 *  pandas' comment='#' cannot swallow a real value. */
function headerBlock(lines, eol) {
  return lines.filter(Boolean).map(l => `# ${l}`).join(eol) + eol;
}

/**
 * Stamp provenance -- and, where it varies per row, a unit -- onto a CSV.
 *
 * `lines` describe where the file came from; whatever the caller knows goes in,
 * and missing pieces are dropped rather than printed empty. `unitFor` overrides
 * the per-row lookup for callers that already know the unit.
 *
 * The original bytes are preserved: this only prepends comment lines and appends
 * one column, whose values come from the same unitResolver the on-screen table
 * reads -- so what is shown and what is downloaded cannot disagree.
 */
/** How to place a unit on each row of one file, and whether a `unit` column is
 *  warranted at all. The on-screen table and the download both read this, which
 *  is the only reason the two can be trusted to agree. */
export function unitResolver(header, { filename = '', unitFor = null } = {}) {
  const cols  = header.map(h => h.trim());
  const iAttr = cols.indexOf('attribute');
  const iUni  = cols.indexOf('uni');
  const fileUnit = RESULT_UNIT_BY_FILE[filename] || '';

  // The attribute is asked first and the `uni` label only after it. That order
  // matters: the merge copies `uni` across from the money parameter it stacks a
  // per-MWh variant onto, so 217 rows of a single run say 'Fuel costs: $m' on a
  // NetPresentCostSystemPerMWh row. The attribute is right in every one of them.
  const resolve = unitFor || ((fields) => {
    const attr = iAttr !== -1 ? (fields[iAttr] || '').trim() : '';
    const fromAttr = attr ? RESULT_UNIT_BY_ATTRIBUTE[attr] : '';
    if (fromAttr) return fromAttr;
    const uni = iUni !== -1 ? (fields[iUni] || '').trim() : '';
    return (uni ? unitFromUni(uni) : '') || fileUnit;
  });

  // A file we cannot place a unit on keeps its columns untouched.
  const addColumn = !UNITLESS_FILES.has(filename)
    && !cols.includes('unit')
    && (!!unitFor || iAttr !== -1 || iUni !== -1 || !!fileUnit);

  return { addColumn, resolve };
}

export function annotateCsv(text, { filename = '', lines = [], unitFor = null } = {}) {
  if (!text) return text;
  const bom  = text.charCodeAt(0) === 0xFEFF ? '﻿' : '';
  const body = bom ? text.slice(1) : text;
  const records = csvRecords(body);
  if (!records.length) return text;

  const eol = records[0].eol || '\r\n';
  const { addColumn, resolve } = unitResolver(records[0].fields, { filename, unitFor });

  const note = addColumn ? 'unit: last column, added on download -- EPM does not write it' : '';
  const out = [bom, headerBlock([...lines, note, "pandas: pd.read_csv(path, comment='#')"], eol)];

  for (let r = 0; r < records.length; r++) {
    const rec = records[r];
    const blank = rec.fields.length === 1 && rec.fields[0] === '';
    if (!addColumn || blank) { out.push(rec.text, rec.eol); continue; }
    out.push(rec.text, ',', r === 0 ? 'unit' : csvEscape(resolve(rec.fields)), rec.eol);
  }
  return out.join('');
}

/** Provenance lines for a result CSV. */
export function resultLines({ filename, regionName, branch, simRun, scenario, url }) {
  return [
    `EPM View export -- ${filename}`,
    [regionName && `region: ${regionName}`, branch && `branch: ${branch}`].filter(Boolean).join(' | '),
    [simRun && `run: ${simRun}`, scenario && `scenario: ${scenario}`].filter(Boolean).join(' | '),
    `downloaded: ${new Date().toISOString()}`,
    url && `source: ${url}`,
  ];
}

/** Provenance lines for an input CSV. One file reads as one parameter, so its
 *  unit is constant and belongs in the header -- a column repeating it on every
 *  row would say nothing the header has not already said. */
export function inputLines({ filename, param, meta, regionName, branch, dataFolder, url }) {
  return [
    `EPM View export -- ${filename}`,
    [regionName && `region: ${regionName}`, branch && `branch: ${branch}`,
      dataFolder && `data folder: ${dataFolder}`].filter(Boolean).join(' | '),
    param && `parameter: ${param}`,
    meta?.label && `description: ${meta.label}`,
    meta?.unit && `unit: ${meta.unit}`,
    `downloaded: ${new Date().toISOString()}`,
    url && `source: ${url}`,
  ];
}
