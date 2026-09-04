// --- One Excel workbook, written by hand ---
//
// The old EPM handed its data out as a single spreadsheet with one tab per
// parameter, and that is what the "Download all" button in the Raw data tabs
// restores. Nothing here reads xlsx; it only writes one, and an xlsx is a zip of
// a few XML parts, so writing it costs a hundred lines rather than a dependency.
//
// What it deliberately leaves out: a shared string table (a result sheet is
// mostly distinct labels, so the table would be as long as the sheet itself),
// column widths, and number formats. The point is the values as the CSV carries
// them, with a bold, frozen header row so a long sheet stays readable.

const ROW_LIMIT = 1048576;                       // what one sheet can hold, header included
export const SHEET_ROW_LIMIT = ROW_LIMIT - 1;    // ... so this many data rows

// -- zip ---------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** Deflate through the platform's own compressor. No polyfill: a browser without
 *  it gets a stored (uncompressed) zip, which Excel opens just as happily -- it
 *  is only bigger. */
async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch { return null; }
}

const u16 = (v) => [v & 255, (v >> 8) & 255];
const u32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
const u8a = (arr) => Uint8Array.from(arr);

/** The DOS date and time an entry is stamped with. */
function dosStamp(d) {
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return [date & 0xFFFF, time & 0xFFFF];
}

/** Zip the given entries into one Blob. Names are written as UTF-8 (general
 *  purpose bit 11), and each entry keeps whichever of deflated or stored is the
 *  smaller, so a part that does not compress is not made bigger. */
async function zipBlob(files, mime) {
  const enc = new TextEncoder();
  const [date, time] = dosStamp(new Date());
  const body = [], dir = [];
  let offset = 0, dirSize = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const raw = f.data;
    const packed = await deflateRaw(raw);
    const use = packed && packed.length < raw.length ? packed : raw;
    const method = use === raw ? 0 : 8;
    const crc = crc32(raw);
    const local = u8a([
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(method),
      ...u16(time), ...u16(date), ...u32(crc), ...u32(use.length), ...u32(raw.length),
      ...u16(name.length), ...u16(0),
    ]);
    body.push(local, name, use);
    const entry = u8a([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(method),
      ...u16(time), ...u16(date), ...u32(crc), ...u32(use.length), ...u32(raw.length),
      ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
    ]);
    dir.push(entry, name);
    offset += local.length + name.length + use.length;
    dirSize += entry.length + name.length;
  }

  const end = u8a([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
    ...u32(dirSize), ...u32(offset), ...u16(0),
  ]);
  return new Blob([...body, ...dir, end], { type: mime });
}

// -- sheet XML ---------------------------------------------------------------

// The control characters XML 1.0 has no way to carry. A stray one in a CSV would
// make the whole workbook unreadable, so it is dropped rather than written.
// eslint-disable-next-line no-control-regex -- the point of the rule is to name them
const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
const esc = (s) => String(s).replace(XML_BAD, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const LETTERS = [];
function colName(i) {
  if (LETTERS[i]) return LETTERS[i];
  let n = i, s = '';
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  LETTERS[i] = s;
  return s;
}

/** Whether a CSV field should land in Excel as a number rather than as text.
 *  Two kinds of digits are not quantities and stay as they are written: one with
 *  a leading zero is a code ('01', '007'), and one longer than fifteen digits is
 *  a run id or a timestamp that a float would round to something else. The rest
 *  is written as a number, so a column of values can be summed in the sheet. */
const NUMBERISH = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const CODE_LIKE = /^-?0\d/;
export function asNumber(s) {
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  const v = String(s).trim();
  if (!v || !NUMBERISH.test(v) || CODE_LIKE.test(v)) return null;
  if (v.split(/[eE]/)[0].replace(/[-.]/g, '').length > 15) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function cellXml(value, ref, style) {
  const s = style ? ` s="${style}"` : '';
  const n = asNumber(value);
  if (n !== null) return `<c r="${ref}"${s}><v>${n}</v></c>`;
  const text = String(value);
  const pad = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
  return `<c r="${ref}"${s} t="inlineStr"><is><t${pad}>${esc(text)}</t></is></c>`;
}

/** One worksheet. `head` is the row that names the columns -- row 1 on a data
 *  sheet, further down on one that opens with a few lines of provenance. It is
 *  set bold and everything above it is frozen; an empty cell is left out of the
 *  XML rather than written empty. */
function sheetXml(rows, head = 0) {
  const out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<sheetViews><sheetView workbookViewId="0">'
    + '<pane ySplit="' + (head + 1) + '" topLeftCell="A' + (head + 2) + '"'
    + ' activePane="bottomLeft" state="frozen"/>'
    + '</sheetView></sheetViews><sheetData>'];
  for (let r = 0; r < rows.length && r < ROW_LIMIT; r++) {
    const row = rows[r] || [];
    out.push(`<row r="${r + 1}">`);
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (v === null || v === undefined || v === '') continue;
      out.push(cellXml(v, `${colName(c)}${r + 1}`, r === head ? 1 : 0));
    }
    out.push('</row>');
  }
  out.push('</sheetData></worksheet>');
  return out.join('');
}

const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
  + '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill>'
  + '<fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border/></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
  // Naming the default style is optional for Excel but not for every reader:
  // pandas and openpyxl warn about a workbook that has none.
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';

/** A tab name Excel will accept: none of the characters it reserves, no quote at
 *  either end, 31 characters at most, and never a repeat -- a clash is numbered
 *  rather than silently merged. */
export function sheetName(raw, taken = new Set()) {
  const base = String(raw || '').replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^'+|'+$/g, '').slice(0, 31).trim() || 'Sheet';
  let name = base;
  for (let i = 2; taken.has(name.toLowerCase()); i++) {
    const tag = `~${i}`;
    name = base.slice(0, 31 - tag.length) + tag;
  }
  taken.add(name.toLowerCase());
  return name;
}

/**
 * Build a workbook from [{ name, rows, head }] and hand back the Blob.
 * Tab names are sanitized and deduped here, so a caller passes what the tab
 * should be called without having to know Excel's rules.
 */
export async function buildWorkbook(sheets) {
  const enc = new TextEncoder();
  const taken = new Set();
  const named = sheets.map(s => ({ name: sheetName(s.name, taken), rows: s.rows || [], head: s.head || 0 }));

  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + named.map((_, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1)
      + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('')
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + '</Types>';

  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>';

  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
    + named.map((s, i) => '<sheet name="' + esc(s.name).replace(/"/g, '&quot;')
      + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('')
    + '</sheets></workbook>';

  const workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + named.map((_, i) => '<Relationship Id="rId' + (i + 1)
      + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"'
      + ' Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('')
    + '<Relationship Id="rId' + (named.length + 1)
    + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '</Relationships>';

  const parts = [
    { name: '[Content_Types].xml', text: contentTypes },
    { name: '_rels/.rels', text: rootRels },
    { name: 'xl/workbook.xml', text: workbook },
    { name: 'xl/_rels/workbook.xml.rels', text: workbookRels },
    { name: 'xl/styles.xml', text: STYLES },
    ...named.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, text: sheetXml(s.rows, s.head) })),
  ];

  return zipBlob(parts.map(p => ({ name: p.name, data: enc.encode(p.text) })),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

/** Hand a built Blob to the browser as a download. */
export function saveBlob(blob, filename) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(href);
}
