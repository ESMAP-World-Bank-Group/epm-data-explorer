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
// from either. What the CSV puts in a comment header goes at the head of each
// tab instead, above the table: what the parameter is, its unit, the file, where
// the data came from country by country, so a tab copied out on its own still
// says what it holds. A Contents sheet in front lists every tab. Nothing is
// dropped in silence: a file skipped for its size or cut at Excel's row limit
// says so there, next to its name.

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
export function csvToRows(text, { filename = '', unitFor = null, unitFrom = null, reserve = 0 } = {}) {
  const body = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  const recs = csvRecords(body).filter(r => !(r.fields.length === 1 && r.fields[0] === ''));
  if (!recs.length) return null;

  const header = recs[0].fields;
  const { addColumn, resolve } = unitResolver(header, {
    filename, unitFor: unitFor || (unitFrom ? unitFrom(header) : null),
  });
  const rows = [addColumn ? [...header, 'unit'] : header];
  const total = recs.length - 1;
  // `reserve` rows of the sheet go to the head block above the table.
  const limit = SHEET_ROW_LIMIT - reserve;
  for (let i = 1; i <= total && rows.length <= limit; i++) {
    const fields = recs[i].fields;
    rows.push(addColumn ? [...fields, resolve(fields)] : fields);
  }
  return { rows, total, truncated: total > rows.length - 1, unitColumn: addColumn };
}

const UNIT_PER_ROW = 'varies by row, see the unit column';

/** The lines above a tab's table, as [label, value] rows. Called once before the
 *  file is read, to size the reserve, and once after, with what the read found;
 *  the second call never returns more rows than the first. */
function tabHead(item, { context, sources, found = null }) {
  const unit = item.unit || (found?.unitColumn ? UNIT_PER_ROW : '');
  const rows = [
    ['Parameter', item.sheet],
    ['Description', item.label],
    ['Unit', found ? unit : 'x'],
    ...context,
    ['File', item.file],
  ];
  if (sources) {
    const e = sourcesFor(sources, [item.sheet, item.file]);
    const by = e?.byCountry || [];
    if (!by.length) rows.push(['Source', 'not documented']);
    // A parameter every country takes from the same place says it once.
    else if (by.length > 1 && by.every(b => b.names.join('; ') === by[0].names.join('; '))) {
      rows.push(['Source', by[0].names.join('; ')]);
    } else {
      for (const b of by) rows.push([`Source, ${b.country}`, b.names.join('; ')]);
    }
  }
  rows.push(['Note', found ? found.note : 'x']);
  return rows
    .filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
    .map(([k, v]) => [k, String(v).slice(0, 32000)]);
}

/** Fetch one file and turn it into a sheet, or into the reason there is none. */
async function oneSheet(item, budget, reserve) {
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
  const parsed = csvToRows(text, {
    filename: item.file, unitFor: item.unitFor, unitFrom: item.unitFrom, reserve,
  });
  if (!parsed) return { note: 'the file is empty' };
  return {
    rows: parsed.rows,
    count: parsed.total,
    unitColumn: parsed.unitColumn,
    note: parsed.truncated
      ? `cut at ${(parsed.rows.length - 1).toLocaleString()} rows, the most a sheet holds -- download the CSV for all ${parsed.total.toLocaleString()}`
      : '',
  };
}

/**
 * Compile the given files into one workbook.
 *
 * @param items  [{ sheet, label, unit, file, url, unitFor }] -- `sheet` is the
 *               tab name asked for (the parameter), `file` the name the CSV has
 *               on disk, `label` what it holds in words.
 * @param meta   [[name, value]] provenance shown at the top of Contents; all but
 *               the first line, the branch and the date are repeated at the head
 *               of each tab.
 * @param loadSources  optional () => Promise<parsed DATA_SOURCES | null>, see
 *               utils/dataSources. When it yields something, each tab names its
 *               sources, Contents lists them, and a Sources sheet holds the detail.
 * @param onProgress  called with (done, total) as the files come in.
 * @returns { blob, included, skipped }
 */
export async function buildDataWorkbook({ items, meta = [], loadSources = null, onProgress = null }) {
  const budget = { used: 0 };
  const results = new Array(items.length);
  let done = 0;
  // One small file, read first: the head of every tab depends on it.
  const sources = loadSources ? await loadSources().catch(() => null) : null;
  // The tab repeats what a reader needs to place the table; the branch and the
  // download time stay on Contents.
  const context = meta.slice(1).filter(([k, v]) => v && k !== 'downloaded' && k !== 'branch')
    .map(([k, v]) => [k.charAt(0).toUpperCase() + k.slice(1), v]);
  const reserveOf = (item) => tabHead(item, { context, sources }).length + 1;

  for (let i = 0; i < items.length; i += AT_ONCE) {
    const slice = items.slice(i, i + AT_ONCE);
    await Promise.all(slice.map(async (item, k) => {
      results[i + k] = await oneSheet(item, budget, reserveOf(item));
      done += 1;
      if (onProgress) onProgress(done, items.length);
    }));
  }

  const head = ['Sheet', 'What it holds', 'Unit', 'Rows', 'File', 'Note'];
  if (sources) head.push('Data sources');
  const index = [];
  for (const [name, value] of meta) if (value) index.push([name, String(value)]);
  if (sources) index.push(['sources', 'at the head of each tab, and by country on the Sources sheet']);
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
    if (has) {
      const top = tabHead(item, { context, sources, found: r });
      // A head too tall to freeze would pin half the screen; the table's own
      // header is frozen only when the block above it is short.
      sheets.push({ name, rows: [...top, [], ...r.rows], head: top.length + 1, freeze: top.length <= 8 });
      included += 1;
    } else skipped += 1;
    // A results file whose unit changes by row says so, rather than leaving the
    // column blank as if it had none.
    const unit = item.unit || (r.unitColumn ? UNIT_PER_ROW : '');
    const row = [
      name, item.label || '', unit,
      has ? r.count : '', item.file || '', r.note || '',
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
