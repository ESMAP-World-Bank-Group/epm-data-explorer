// --- EPM scenario definitions ---
// EPM drives its inputs from two files in the input folder:
//   • config.csv     → the BASE case: one row per data type (paramName) with its
//                      description, unit and default file.
//   • scenarios.csv  → a matrix: columns = scenarios, rows = paramNames. A non-empty
//                      cell is a VARIANT file overriding the base for that param in that
//                      scenario; an empty cell means "use the config.csv default".
// So a scenario = base config + a set of per-data-type variant overrides.
// This module fetches + parses both and exposes the systematic diff per scenario.
import { fetchEpmText } from './epmFetch';

/** Robust CSV → array-of-arrays (handles quoted fields containing commas). */
function parseCSV(text) {
  const s = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const UNIT_RE = /\(Unit:\s*([^)]*)\)/i;

// Names an input folder may give the scenario matrix, tried in this order after
// whatever regions.json declares.
const SCENARIO_FILES = ['scenarios.csv', 'input_scenarios.csv'];

/** A scenarios.csv section marker row is an all-caps label with no override cells. */
function isSectionName(s) {
  return s && /^[A-Z][A-Z0-9 _&/-]*$/.test(s.trim());
}

/** Short, readable file label: drop folder + .csv extension. */
export function baseName(path) {
  if (!path) return '';
  return path.split('/').pop().replace(/\.csv$/i, '');
}

/**
 * Fetch + parse the scenario definitions for a branch/dataFolder.
 * Returns null only when neither the config nor a scenarios file is reachable;
 * a folder with a config but no matrix still yields paramMeta and no scenarios.
 * Shape: { scenarios, paramMeta, overridesByParam, diffByScenario, variantsForParam }
 */
export async function fetchScenarioConfig(branch, dataFolder, opts = {}) {
  const configFile = opts.configFile || 'config.csv';
  // EPM does not fix one name for the scenario matrix, and regions.json is not
  // always right about it, so try the declared name and then the usual ones.
  const candidates = [...new Set([opts.scenariosFile, ...SCENARIO_FILES].filter(Boolean))];

  const [configText, ...scnTexts] = await Promise.all([
    fetchEpmText(branch, dataFolder, configFile),
    ...candidates.map(f => fetchEpmText(branch, dataFolder, f)),
  ]);
  const hit = scnTexts.findIndex(Boolean);
  const scnText       = hit === -1 ? null : scnTexts[hit];
  const scenariosFile = hit === -1 ? null : candidates[hit];

  // The base case lives in config.csv and does not depend on the matrix, so a
  // folder with no scenarios file still has a config worth returning.
  if (!configText && !scnText) return null;

  // --- config.csv: paramName → { section, label, unit, defaultFile } ---
  const paramMeta = {};
  if (configText) {
    const rows = parseCSV(configText);
    let section = '';
    for (let i = 1; i < rows.length; i++) {
      const param = (rows[i][1] || '').trim();
      const file  = (rows[i][2] || '').trim();
      if (!param) continue;
      if (!file) { section = param; continue; } // section marker (no file)
      const label = (rows[i][0] || '').trim();
      const unit  = (label.match(UNIT_RE) || [])[1]?.trim() || '';
      paramMeta[param] = { section, label, unit, defaultFile: file };
    }
  }

  // --- scenarios.csv: variant matrix (optional) ---
  const overridesByParam = {};                       // param → { scenario: file }
  const diffByScenario   = {};                       // scenario → [{ paramName, section, file, defaultFile, label, unit }]
  const rows = scnText ? parseCSV(scnText) : [];
  const scenarios = rows.length ? rows[0].slice(1).map(s => (s || '').trim()).filter(Boolean) : [];
  scenarios.forEach(s => { diffByScenario[s] = []; });

  let section = '';
  for (let i = 1; i < rows.length; i++) {
    const param = (rows[i][0] || '').trim();
    if (!param) continue;
    const cells = rows[i].slice(1, scenarios.length + 1);
    const hasOverride = cells.some(c => (c || '').trim());
    if (!hasOverride) { if (isSectionName(param)) section = param; continue; }

    const meta = paramMeta[param];
    const sec  = meta?.section || section;
    cells.forEach((cell, c) => {
      const file = (cell || '').trim();
      if (!file) return;
      const scenario = scenarios[c];
      (overridesByParam[param] ||= {})[scenario] = file;
      diffByScenario[scenario].push({
        paramName: param, section: sec, file,
        defaultFile: meta?.defaultFile || '', label: meta?.label || '', unit: meta?.unit || '',
      });
    });
  }

  /** Distinct variant files seen for a param across all scenarios (empty if none). */
  const variantsForParam = (param) => {
    const o = overridesByParam[param];
    return o ? [...new Set(Object.values(o))] : [];
  };

  return { scenarios, paramMeta, overridesByParam, diffByScenario, variantsForParam,
           configFile, scenariosFile };
}

/**
 * File a parameter actually reads, most specific source first: the variant the
 * user picked, then the base case config.csv declares, then the conventional name.
 *
 * The conventional name is only a guess and a bad one to rely on -- a folder can
 * point pGenDataInput at pGenDataInput_SAPP_v3.csv while a stale pGenDataInput.csv
 * still sits next to it, and guessing loads the stale one without a word.
 */
export function resolveFile(scnMeta, overrides, param, fallback) {
  return overrides?.[param] || scnMeta?.paramMeta?.[param]?.defaultFile || fallback;
}
