// --- A folder of CSVs, compiled into one workbook ---
//
// The Raw data tabs show one file at a time, which is right for reading and
// wrong for taking away: the model is a folder of tables, and whoever asks for
// it usually wants all of them. This gathers the files a tab is offering and
// writes them as one xlsx, a tab per parameter, the way EPM used to hand its
// data out.
//
// Rows come out of the same csvRecords and unitResolver the table on screen and
// the "Download CSV" button read, so the workbook cannot say something different
// from either. What the CSV puts in a comment header -- where the file came
// from, when, from which branch and run -- has nowhere to live inside a sheet,
// so it goes on a Contents sheet in front, one line per tab, with the source URL
// on each. Nothing is dropped in silence: a file skipped for its size or cut at
// Excel's row limit says so there, next to its name.

import { csvRecords, unitResolver } from './csvMeta';
import { fetchFileSize } from './epmFetch';
import { buildWorkbook, sheetName, SHEET_ROW_LIMIT } from './xlsx';
import { sourcesFor } from './dataSources';

// Above this a file is named on the Contents sheet and left out: EPM's hourly
// dispatch is 121 MB, and pulling it into a workbook would hang the tab rather
// than fill it. It stays one click away as the CSV it already is.
const MAX_BYTES = 12 * 1024 * 1024;
// And a ceiling for the workbook as a whole, so a run of many large files cannot
// quietly turn into a browser tab holding a gigabyte of strings.
const MAX_TOTAL = 60 * 1024 * 1024;
const AT_ONCE = 6;

const fmtBytes = (n) => (
  n == null ? '' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB`
    : n >= 1024 ? `${Math.round(n / 1024)} kB` : `${n} B`
);

/** A download name safe on every platform, from the parts that identify what is
 *  in it. */
export function exportName(parts, tail) {
  const stem = parts.filter(Boolean).join('_').replace(/[^\w.-]+/g, '-').slice(0, 90);
  return (stem || 'epm-view') + tail;
}

/**
 * The unit an input sheet can carry on every row, from the one config.csv declares.
 *
 * An input file is one parameter, so its unit is usually one word and a column
 * repeating it is what lets a sheet travel alone. Two kinds are left to Contents:
 * a unit that varies by column ('varies; capacity in MW, cost in USD/MW'), which
 * a per-row cell would state wrongly, and a file with no unit at all. One compound
 * is placed row by row, the demand forecast's 'GWh and MW': its `type` column
 * already says which row is energy and which is peak.
 *
 * @returns (header) => ((fields) => unit) | null
 */
export function inputUnitFrom(unit) {
  const u = (unit || '').trim();
  if (!u || /^(varies|unitless|parameter-specific|n\/a)/i.test(u)) return null;
  const pair = /^(\S+) and (\S+)$/i.exec(u);
  if (!pair) return () => () => u;
  const energy = [pair[1], pair[2]].find(x => /wh$/i.test(x));
  const power  = [pair[1], pair[2]].find(x => /w$/i.test(x));
  if (!energy || !power) return null;
  return (header) => {
    const i = header.map(h => h.trim().toLowerCase()).indexOf('type');
    if (i === -1) return null;
    return (fields) => {
      const kind = (fields[i] || '').trim().toLowerCase();
      return kind === 'energy' ? energy : kind === 'peak' ? power : '';
    };
  };
}

/** One CSV as sheet rows: the header, then every row, plus the unit column where
 *  the file earns one. Returns null for a file with nothing in it. `unitFrom`
 *  builds a per-row unit from the header, for callers that know the file's unit. */
export function csvToRows(text, { filename = '', unitFor = null, unitFrom = null } = {}) {
  const body = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  const recs = csvRecords(body).filter(r => !(r.fields.length === 1 && r.fields[0] === ''));
  if (!recs.length) return null;

  const header = recs[0].fields;
  const { addColumn, resolve } = unitResolver(header, {
    filename, unitFor: unitFor || (unitFrom ? unitFrom(header) : null),
  });
  const rows = [addColumn ? [...header, 'unit'] : header];
  const total = recs.length - 1;
  for (let i = 1; i <= total && rows.length <= SHEET_ROW_LIMIT; i++) {
    const fields = recs[i].fields;
    rows.push(addColumn ? [...fields, resolve(fields)] : fields);
  }
  return { rows, total, truncated: total > rows.length - 1, unitColumn: addColumn };
}

/** Fetch one file and turn it into a sheet, or into the reason there is none. */
async function oneSheet(item, budget) {
  const size = await fetchFileSize(item.url);
  if (size != null && size > MAX_BYTES) {
    return { note: `not included: ${fmtBytes(size)}, too large for a workbook` };
  }
  if (budget.used > MAX_TOTAL) {
    return { note: 'not included: the workbook had reached its size limit' };
  }
  let text;
  try {
    const res = await fetch(item.url);
    if (res.status === 404) return { note: 'not published in this folder' };
    if (!res.ok) return { note: `could not be read (HTTP ${res.status})` };
    text = await res.text();
  } catch {
    return { note: 'could not be read' };
  }
  budget.used += text.length;
  const parsed = csvToRows(text, { filename: item.file, unitFor: item.unitFor, unitFrom: item.unitFrom });
  if (!parsed) return { note: 'the file is empty' };
  return {
    rows: parsed.rows,
    count: parsed.total,
    unitColumn: parsed.unitColumn,
    note: parsed.truncated
      ? `cut at ${SHEET_ROW_LIMIT.toLocaleString()} rows, the most a sheet holds -- download the CSV for all ${parsed.total.toLocaleString()}`
      : '',
  };
}

/**
 * Compile the given files into one workbook.
 *
 * @param items  [{ sheet, label, unit, file, url, unitFor }] -- `sheet` is the
 *               tab name asked for (the parameter), `file` the name the CSV has
 *               on disk, `label` what it holds in words.
 * @param meta   [[name, value]] provenance shown at the top of Contents.
 * @param loadSources  optional () => Promise<parsed DATA_SOURCES | null>, see
 *               utils/dataSources. When it yields something, Contents gains a
 *               Data sources column and the workbook a Sources sheet.
 * @param onProgress  called with (done, total) as the files come in.
 * @returns { blob, included, skipped }
 */
export async function buildDataWorkbook({ items, meta = [], loadSources = null, onProgress = null }) {
  const budget = { used: 0 };
  const results = new Array(items.length);
  let done = 0;
  const sourcesP = loadSources ? loadSources().catch(() => null) : Promise.resolve(null);

  for (let i = 0; i < items.length; i += AT_ONCE) {
    const slice = items.slice(i, i + AT_ONCE);
    await Promise.all(slice.map(async (item, k) => {
      results[i + k] = await oneSheet(item, budget);
      done += 1;
      if (onProgress) onProgress(done, items.length);
    }));
  }
  const sources = await sourcesP;

  const head = ['Sheet', 'What it holds', 'Unit', 'Rows', 'File', 'Note', 'File URL'];
  if (sources) head.push('Data sources');
  const index = [];
  for (const [name, value] of meta) if (value) index.push([name, String(value)]);
  if (loadSources) {
    index.push(['data sources', sources
      ? 'Sources sheet, one row per parameter and country, from the folder\'s DATA_SOURCES page'
      : 'this folder publishes no readable DATA_SOURCES page']);
  }
  index.push([]);
  const headRow = index.length;
  index.push(head);

  // Tab names are settled here rather than left to the writer, so the name on
  // the Contents sheet is the name on the tab -- including where Excel's 31
  // characters cut one short, or two parameters would have collided.
  const taken = new Set(['contents', 'sources']);
  const sheets = [];
  let included = 0, skipped = 0;
  items.forEach((item, i) => {
    const r = results[i] || {};
    const has = !!r.rows;
    const name = has ? sheetName(item.sheet, taken) : '';
    if (has) { sheets.push({ name, rows: r.rows }); included += 1; }
    else skipped += 1;
    // A results file whose unit changes by row says so, rather than leaving the
    // column blank as if it had none.
    const unit = item.unit || (r.unitColumn ? 'per row, see the unit column' : '');
    const row = [
      name, item.label || '', unit,
      has ? r.count : '', item.file || '', r.note || '', item.url || '',
    ];
    if (sources) {
      const e = sourcesFor(sources, [item.sheet, item.file]);
      row.push(e && e.names.length ? e.names.join('; ').slice(0, 32000) : 'not documented');
    }
    index.push(row);
  });

  const book = [{ name: 'Contents', rows: index, head: headRow }];
  if (sources && sources.rows.length) {
    const rows = [['Parameter', 'Category', 'Description', 'Country', 'Source', 'Also uses',
      'Method', 'Confidence', 'Last updated', 'Review note']];
    for (const s of sources.rows) {
      const e = sources.byParam.get(s.param.toLowerCase()) || {};
      rows.push([s.param, e.category || '', e.description || '', s.country, s.source, s.also,
        s.method, s.confidence, s.updated, s.review]);
    }
    book.push({ name: 'Sources', rows });
  }

  const blob = await buildWorkbook([...book, ...sheets]);
  return { blob, included, skipped };
}
