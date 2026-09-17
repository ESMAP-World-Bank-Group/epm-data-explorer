// --- Where each input came from, read off the folder's DATA_SOURCES page ---
//
// A data folder ships DATA_SOURCES.md next to its tables, written by EPM's
// pre-analysis/catalog/generate_docs.py. It is the only place that says which
// study, database or judgement stands behind a parameter, country by country.
// The input workbook carries that along: the sources country by country at the
// head of each tab, their names on Contents, and a Sources sheet with one row per
// parameter and country for the detail (method, confidence, date).
//
// The page is read as the generator writes it:
//
//   ## <Country>                     one section per country, then "Model-wide"
//   ### `pParam`                     one block per documented parameter
//   **Source**: name (`id`)          the main source
//   **Also uses**: name              zero or more
//   **Method**: text
//   *Confidence: [LOW] · Last updated: 2026-05-29*
//
// plus the overview table at the top, which gives each parameter its category and
// description. Its source cells are shortened with an ellipsis, so they are used
// only where a country has no block of its own. Nothing here is required: a folder
// without the page, or a page laid out differently, gives an export without the
// Sources sheet rather than a failed one.

import { rawFileUrl } from './epmFetch';

const NOT_COUNTRIES = new Set(['model overview', 'contents']);
// Excel refuses a cell above 32,767 characters, and a Method paragraph can be long.
const CELL_MAX = 32000;

/** Markdown and the generator's HTML bits, said as plain text. Links keep their
 *  target in brackets, so the workbook still says where to look. */
export function plainSource(md) {
  return (md || '')
    .replace(/<br\s*\/?>/gi, '; ')
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_, text, url) => (text ? `${text} (${url})` : url))
    .replace(/\s*\(`[^`]*`\)/g, '')          // the catalogue id after a source name
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/&#8593;/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CELL_MAX);
}

/** The source name alone, without its link target: what Contents lists. */
const sourceName = (md) => plainSource((md || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'));

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
const paramOf = (cell) => (/`([^`]+)`/.exec(cell || '') || [])[1] || '';

/**
 * Parse a DATA_SOURCES.md.
 * @returns {{ rows: Array, byParam: Map<string, {category, item, description, names: string[]}> }}
 *          `rows` in document order, keyed lower case in `byParam`.
 */
export function parseDataSources(md) {
  const lines = (md || '').split(/\r?\n/);
  const byParam = new Map();
  const detail = [];               // one per country block
  const overview = [];             // { param, country, text }
  const entry = (param) => {
    const k = param.toLowerCase();
    if (!byParam.has(k)) byParam.set(k, { param, category: '', item: '', description: '', names: [], byCountry: [] });
    return byParam.get(k);
  };

  let section = '';
  let block = null;
  let tableCols = null;            // country columns of the overview table

  for (const line of lines) {
    if (tableCols) {
      if (!line.trim().startsWith('|')) { tableCols = null; }
      else {
        const c = cells(line);
        const param = paramOf(c[2]);
        if (!param) continue;      // the |---| separator
        const e = entry(param);
        e.category = e.category || c[0];
        e.item = e.item || c[1];
        e.description = e.description || plainSource(c[3]);
        tableCols.forEach((country, j) => {
          const text = c[4 + j] || '';
          if (text && !/^—/.test(text)) overview.push({ param, country, text });
        });
        continue;
      }
    }
    if (/^\|\s*Category\s*\|\s*Item\s*\|\s*Parameter\s*\|/.test(line)) {
      tableCols = cells(line).slice(4);
      continue;
    }
    let m;
    if ((m = /^##\s+(.+?)\s*$/.exec(line))) {
      section = NOT_COUNTRIES.has(m[1].toLowerCase()) ? '' : m[1];
      block = null;
      continue;
    }
    if ((m = /^###\s+`([^`]+)`/.exec(line))) {
      block = section ? { param: m[1], country: section, source: '', also: [], method: '',
        confidence: '', updated: '', review: '' } : null;
      if (block) detail.push(block);
      continue;
    }
    if (/^###\s/.test(line)) { block = null; continue; }
    if (!block) continue;
    if ((m = /^\*\*Source\*\*:\s*(.*)$/.exec(line))) block.source = m[1];
    else if ((m = /^\*\*Also uses\*\*:\s*(.*)$/.exec(line))) block.also.push(m[1]);
    else if ((m = /^\*\*Method\*\*:\s*(.*)$/.exec(line))) block.method = m[1];
    else if ((m = /^>\s*⚠\s*\*\*Needs review\*\*:\s*(.*)$/.exec(line))) block.review = m[1];
    else if ((m = /^\*Confidence:\s*(\[[^\]]*\])(?:\s*·\s*Last updated:\s*([^*]+))?\*/.exec(line))) {
      block.confidence = m[1].replace(/[[\]]/g, '');
      block.updated = (m[2] || '').trim();
    }
  }

  const rows = [];
  const seen = new Set();
  const addName = (param, md) => {
    const n = sourceName(md);
    const e = entry(param);
    if (n && !e.names.includes(n)) e.names.push(n);
    return n;
  };
  // Per parameter, the source names country by country, for the head of each tab.
  const addCountry = (param, country, names) => {
    if (names.length) entry(param).byCountry.push({ country, names });
  };
  for (const b of detail) {
    if (!b.source && !b.also.length) continue;
    seen.add(`${b.param.toLowerCase()}|${b.country}`);
    addCountry(b.param, b.country,
      [addName(b.param, b.source), ...b.also.map(a => addName(b.param, a))].filter(Boolean));
    rows.push({
      param: b.param, country: b.country,
      source: plainSource(b.source),
      also: plainSource(b.also.join('<br>')),
      method: plainSource(b.method),
      confidence: b.confidence, updated: b.updated,
      review: plainSource(b.review),
    });
  }
  for (const o of overview) {
    if (seen.has(`${o.param.toLowerCase()}|${o.country}`)) continue;
    // The overview cell joins its sources with ' + '. The names are shortened
    // there, so they go on the row and the country line, not into the list of
    // full names Contents shows.
    addCountry(o.param, o.country, [sourceName(o.text)].filter(Boolean));
    rows.push({ param: o.param, country: o.country, source: plainSource(o.text),
      also: '', method: '', confidence: '', updated: '', review: 'from the overview table, names shortened' });
  }
  const order = [...byParam.keys()];
  rows.sort((a, b) => order.indexOf(a.param.toLowerCase()) - order.indexOf(b.param.toLowerCase()));
  return { rows, byParam };
}

/** The folder's DATA_SOURCES, parsed, or null when there is none to read. */
export async function fetchDataSources(branch, folder) {
  if (!branch || !folder) return null;
  try {
    const res = await fetch(rawFileUrl(branch, `epm/input/${folder}/DATA_SOURCES.md`));
    if (!res.ok) return null;
    const text = await res.text();
    // A sign-in or error page served with a 200 is not the document.
    if (!/^#\s/m.test(text) || /^\s*<!doctype|^\s*<html/i.test(text)) return null;
    const parsed = parseDataSources(text);
    return parsed.rows.length || parsed.byParam.size ? parsed : null;
  } catch {
    return null;
  }
}

/** Source names for one tab, looked up by parameter and then by file name:
 *  config.csv says pAvailability where the page says pAvailabilityCustom. */
export function sourcesFor(sources, keys) {
  if (!sources) return null;
  for (const k of keys) {
    const e = k && sources.byParam.get(String(k).replace(/^.*\//, '').replace(/\.csv$/i, '').toLowerCase());
    if (e) return e;
  }
  return null;
}
