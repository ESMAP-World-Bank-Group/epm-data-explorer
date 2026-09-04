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

/** One CSV as sheet rows: the header, then every row, plus the unit column where
 *  the file earns one. Returns null for a file with nothing in it. */
export function csvToRows(text, { filename = '', unitFor = null } = {}) {
  const body = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  const recs = csvRecords(body).filter(r => !(r.fields.length === 1 && r.fields[0] === ''));
  if (!recs.length) return null;

  const header = recs[0].fields;
  const { addColumn, resolve } = unitResolver(header, { filename, unitFor });
  const rows = [addColumn ? [...header, 'unit'] : header];
  const total = recs.length - 1;
  for (let i = 1; i <= total && rows.length <= SHEET_ROW_LIMIT; i++) {
    const fields = recs[i].fields;
    rows.push(addColumn ? [...fields, resolve(fields)] : fields);
  }
  return { rows, total, truncated: total > rows.length - 1 };
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
  const parsed = csvToRows(text, { filename: item.file, unitFor: item.unitFor });
  if (!parsed) return { note: 'the file is empty' };
  return {
    rows: parsed.rows,
    count: parsed.total,
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
 * @param onProgress  called with (done, total) as the files come in.
 * @returns { blob, included, skipped }
 */
export async function buildDataWorkbook({ items, meta = [], onProgress = null }) {
  const budget = { used: 0 };
  const results = new Array(items.length);
  let done = 0;

  for (let i = 0; i < items.length; i += AT_ONCE) {
    const slice = items.slice(i, i + AT_ONCE);
    await Promise.all(slice.map(async (item, k) => {
      results[i + k] = await oneSheet(item, budget);
      done += 1;
      if (onProgress) onProgress(done, items.length);
    }));
  }

  const head = ['Sheet', 'What it holds', 'Unit', 'Rows', 'File', 'Note', 'Source'];
  const index = [];
  for (const [name, value] of meta) if (value) index.push([name, String(value)]);
  index.push([]);
  const headRow = index.length;
  index.push(head);

  // Tab names are settled here rather than left to the writer, so the name on
  // the Contents sheet is the name on the tab -- including where Excel's 31
  // characters cut one short, or two parameters would have collided.
  const taken = new Set(['contents']);
  const sheets = [];
  let included = 0, skipped = 0;
  items.forEach((item, i) => {
    const r = results[i] || {};
    const has = !!r.rows;
    const name = has ? sheetName(item.sheet, taken) : '';
    if (has) { sheets.push({ name, rows: r.rows }); included += 1; }
    else skipped += 1;
    index.push([
      name, item.label || '', item.unit || '',
      has ? r.count : '', item.file || '', r.note || '', item.url || '',
    ]);
  });

  const blob = await buildWorkbook([
    { name: 'Contents', rows: index, head: headRow },
    ...sheets,
  ]);
  return { blob, included, skipped };
}
