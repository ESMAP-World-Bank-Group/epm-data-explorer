// --- Source des données PAR BRANCHE ---
// Par défaut, les données viennent du repo public EPM (GitHub).
// Pour les branches "privées", elles sont servies depuis le bucket R2 (store privé) :
// il suffit d'ajouter le nom de la branche dans R2_BRANCHES.
const GITHUB_RAW  = 'https://raw.githubusercontent.com/ESMAP-World-Bank-Group/EPM';
const R2_BASE     = 'https://pub-fbe9fb64480745d48ed524b3803b349d.r2.dev';
const R2_BRANCHES = new Set(['blacksea_2026']);   // branches dont les données vivent dans R2
function rawBase(branch) { return R2_BRANCHES.has(branch) ? R2_BASE : GITHUB_RAW; }

const API_BASE = 'https://api.github.com/repos/ESMAP-World-Bank-Group/EPM';

// ── Results: GitHub Contents API ──────────────────────────────────────────────

/** List files/dirs at path in branch. Returns [{ name, type }] or null. */
export async function fetchGitHubDir(branch, path) {
  const url = `${API_BASE}/contents/${path}?ref=${branch}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/vnd.github.v3+json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** List all data_* input folders in a branch (excluding data_test).
 *  Label = folder name with 'data_' prefix stripped.
 *  The defaultFolder is always first. Falls back to [{id:defaultFolder, label}] on error. */
export async function fetchDataFolderList(branch, defaultFolder) {
  const strip = n => n.replace(/^data_/, '');
  const items = await fetchGitHubDir(branch, 'epm/input');
  if (!items) return [{ id: defaultFolder, label: strip(defaultFolder) }];
  const folders = items
    .filter(i => i.type === 'dir' && /^data_/.test(i.name) && i.name !== 'data_test')
    .map(i => ({ id: i.name, label: strip(i.name) }))
    .sort((a, b) => (a.id === defaultFolder ? -1 : b.id === defaultFolder ? 1 : a.id.localeCompare(b.id)));
  return folders.length ? folders : [{ id: defaultFolder, label: strip(defaultFolder) }];
}

/** List zcmap*.csv stems in a data folder (e.g. ['zcmap', 'zcmap_alt']).
 *  Falls back to ['zcmap'] if the directory is unreachable. */
export async function fetchZcmapList(branch, dataFolder) {
  const items = await fetchGitHubDir(branch, `epm/input/${dataFolder}`);
  const names = (items || [])
    .filter(f => f.type === 'file' && /^zcmap.*\.csv$/i.test(f.name))
    .map(f => f.name.slice(0, -4));
  names.sort((a, b) => a === 'zcmap' ? -1 : b === 'zcmap' ? 1 : a.localeCompare(b));
  return names.length ? names : ['zcmap'];
}

/** Results live under epm/output_view (curated) if present, else epm/output (legacy).
 *  Resolved once per page load from the branch's GitHub tree, then threaded through. */
export async function resolveOutputDir(branch) {
  const items = await fetchGitHubDir(branch, 'epm/output_view');
  const hasRuns = (items || []).some(i => i.type === 'dir');
  return hasRuns ? 'epm/output_view' : 'epm/output';
}

/** Fetch a result CSV: {outputDir}/{simRun}/{scenario}/output_csv/{filename} */
export async function fetchResultCSV(branch, simRun, scenario, filename, outputDir = 'epm/output') {
  const url = `${rawBase(branch)}/${branch}/${outputDir}/${simRun}/${scenario}/output_csv/${filename}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return parseCSV(await res.text());
  } catch { return null; }
}

// ── Result processors ─────────────────────────────────────────────────────────

/** pTechFuelMerged → { zone: { attribute: { year: { techfuel: val } } } } */
export function processTechFuel(rows) {
  if (!rows?.length) return {};
  const out = {};
  for (const r of rows) {
    const z = r.z || r.zone || ''; const attr = r.attribute || '';
    const y = String(r.y || '').trim(); const tf = r.techfuel || r.tech || '';
    const val = parseFloat(r.value) || 0;
    if (!z || !attr || !y || !tf) continue;
    if (!out[z]) out[z] = {};
    if (!out[z][attr]) out[z][attr] = {};
    if (!out[z][attr][y]) out[z][attr][y] = {};
    out[z][attr][y][tf] = (out[z][attr][y][tf] || 0) + val;
  }
  return out;
}

/** pYearlyZoneMerged → { zone: { attribute: { year: val } } } */
export function processYearlyZone(rows) {
  if (!rows?.length) return {};
  const out = {};
  for (const r of rows) {
    const z = r.z || r.zone || ''; const attr = r.attribute || '';
    const y = String(r.y || '').trim(); const val = parseFloat(r.value) || 0;
    if (!z || !attr || !y) continue;
    if (!out[z]) out[z] = {};
    if (!out[z][attr]) out[z][attr] = {};
    out[z][attr][y] = (out[z][attr][y] || 0) + val;
  }
  return out;
}

/** pDispatchComplete → { zone: { year: { q: { d: { t: { techfuel: val } } } } } } */
export function processDispatchResults(rows) {
  if (!rows?.length) return {};
  const out = {};
  for (const r of rows) {
    const z = r.z || r.zone || ''; const y = String(r.y || '').trim();
    const q = r.q || ''; const d = r.d || '';
    const tt = (r.t||'').replace(/^(t)0+(\d)/,'$1$2'); const tf = r.uni || r.techfuel || r.tech || '';
    const val = parseFloat(r.value) || 0;
    if (!z || !y || !q || !d || !tt || !tf) continue;
    if (!out[z]) out[z] = {};
    if (!out[z][y]) out[z][y] = {};
    if (!out[z][y][q]) out[z][y][q] = {};
    if (!out[z][y][q][d]) out[z][y][q][d] = {};
    if (!out[z][y][q][d][tt]) out[z][y][q][d][tt] = {};
    out[z][y][q][d][tt][tf] = (out[z][y][q][d][tt][tf] || 0) + val;
  }
  return out;
}

/** pHourlyPrice → { zone: { year: { q: { d: { t: val } } } } } */
export function processHourlyPrice(rows) {
  if (!rows?.length) return {};
  const out = {};
  for (const r of rows) {
    const z = r.z || r.zone || ''; const y = String(r.y || '').trim();
    const q = r.q || ''; const d = r.d || '';
    const tt = (r.t||'').replace(/^(t)0+(\d)/,'$1$2'); const val = parseFloat(r.value) || 0;
    if (!z || !y || !q || !d || !tt) continue;
    if (!out[z]) out[z] = {};
    if (!out[z][y]) out[z][y] = {};
    if (!out[z][y][q]) out[z][y][q] = {};
    if (!out[z][y][q][d]) out[z][y][q][d] = {};
    out[z][y][q][d][tt] = val;
  }
  return out;
}

/** pTransmissionMerged → { z: { z2: { attribute: { year: val } } } } */
export function processTransmissionResults(rows) {
  if (!rows?.length) return {};
  const out = {};
  for (const r of rows) {
    const z    = r.z || '';
    const z2   = r.z2 || r.uni || '';
    const attr = r.attribute || '';
    const y    = String(r.y || '').trim();
    const val  = parseFloat(r.value) || 0;
    if (!z || !z2 || !attr || !y) continue;
    if (!out[z])       out[z]       = {};
    if (!out[z][z2])   out[z][z2]   = {};
    if (!out[z][z2][attr]) out[z][z2][attr] = {};
    out[z][z2][attr][y] = (out[z][z2][attr][y] || 0) + val;
  }
  return out;
}

/** pCostsMerged → { zone: { category: { year: val } } } (attribute='Costs', uni=category) */
export function processCosts(rows) {
  if (!rows?.length) return {};
  const out = {};
  for (const r of rows) {
    const z   = r.z || '';
    const cat = r.uni || '';
    const y   = String(r.y || '').replace('.0','').trim();
    const val = parseFloat(r.value) || 0;
    if (!z || !cat || !y || r.attribute !== 'Costs') continue;
    if (!out[z]) out[z] = {};
    if (!out[z][cat]) out[z][cat] = {};
    out[z][cat][y] = (out[z][cat][y] || 0) + val;
  }
  return out;
}

/** pPlantMerged → [{ g, z, c, techfuel, attribute, year, value }] */
export function processPlants(rows) {
  if (!rows?.length) return [];
  return rows.map(r => ({
    g:         r.g || '',
    z:         r.z || '',
    c:         r.c || '',
    techfuel:  r.techfuel || r.tech || '',
    attribute: r.attribute || '',
    y:         String(r.y || ''),
    value:     parseFloat(r.value) || 0,
  })).filter(r => r.g && r.attribute && r.y);
}

/** Extract sorted unique years from processTechFuel or processYearlyZone output */
export function resultYears(data) {
  const ys = new Set();
  for (const attrs of Object.values(data))
    for (const yrs of Object.values(attrs))
      if (typeof yrs === 'object' && !Array.isArray(yrs))
        for (const y of Object.keys(yrs)) ys.add(y);
  return [...ys].sort();
}

/** Collect all techfuel names from dispatch or techFuel data */
export function collectTechfuels(data) {
  const tfs = new Set();
  for (const z of Object.values(data))
    for (const a of Object.values(z))
      for (const y of Object.values(a))
        if (typeof y === 'object') for (const tf of Object.keys(y)) tfs.add(tf);
  return [...tfs].filter(t => t !== 'Demand').sort();
}

/** Compute the centroid of a GeoJSON Polygon or MultiPolygon geometry. */
export function computeCentroid(geometry) {
  if (!geometry) return null;
  const rings = geometry.type === 'Polygon'
    ? geometry.coordinates
    : geometry.coordinates.flatMap(p => p);
  let x = 0, y = 0, n = 0;
  for (const ring of rings)
    for (const [lon, lat] of ring) { x += lon; y += lat; n++; }
  return n > 0 ? [x / n, y / n] : null;
}

function stripBOM(s) {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

function parseCSV(text) {
  const lines = stripBOM(text).trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = line.split(',');
    return Object.fromEntries(headers.map((h, i) => [h, (vals[i] ?? '').trim()]));
  });
}

export async function fetchLinestringGeoJSON(branch, dataFolder, stem = null) {
  const name = stem ? `linestring_${stem}.geojson` : 'linestring_countries.geojson';
  const url = `${rawBase(branch)}/${branch}/epm/input/${dataFolder}/${name}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return stem ? fetchLinestringGeoJSON(branch, dataFolder, null) : null;
    return await res.json();
  } catch { return null; }
}

export async function fetchZonesGeoJSON(branch, dataFolder, stem = null) {
  const name = stem ? `zones_${stem}.geojson` : 'zones.geojson';
  const url = `${rawBase(branch)}/${branch}/epm/input/${dataFolder}/${name}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return stem ? fetchZonesGeoJSON(branch, dataFolder, null) : null;
    return await res.json();
  } catch { return null; }
}

/** Fetch scenario names from {outputDir}/{simRun}/input_scenarios.csv (first row, cols after paramNames). */
export async function fetchInputScenarios(branch, outputDir, simRun) {
  const url = `${rawBase(branch)}/${branch}/${outputDir}/${simRun}/input_scenarios.csv`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const text = await res.text();
    const firstLine = text.split('\n')[0] || '';
    const cols = firstLine.split(',').map(c => c.trim()).filter(Boolean);
    return cols.slice(1); // drop 'paramNames' header
  } catch { return null; }
}

export async function fetchZonesExtGeoJSON(branch, dataFolder) {
  const url = `${rawBase(branch)}/${branch}/epm/input/${dataFolder}/zones_ext.geojson`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export async function fetchEpmCSV(branch, dataFolder, relPath) {
  const url = `${rawBase(branch)}/${branch}/epm/input/${dataFolder}/${relPath}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return parseCSV(await res.text());
  } catch {
    return null;
  }
}

/** Fetch a raw input file as text (for config.csv / scenarios.csv parsing). */
export async function fetchEpmText(branch, dataFolder, relPath) {
  const url = `${rawBase(branch)}/${branch}/epm/input/${dataFolder}/${relPath}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// Map EPM fuel names → canonical key matching FUEL_COLORS in constants.js
const FUEL_MAP = {
  water: 'hydro', ror: 'hydro', reservoirhydro: 'hydro', pumpedhydro: 'hydro',
  solar: 'solar', pv: 'solar', rpv: 'solar', csp: 'solar', cspplant: 'solar',
  wind: 'wind', windonshore: 'wind', windoffshore: 'wind', onshorewind: 'wind', offshorewind: 'wind',
  gas: 'gas', naturalgas: 'gas', lng: 'gas', ocgt: 'gas', ccgt: 'gas', ocgtccs: 'gas', ccgtccs: 'gas', methane: 'gas',
  coal: 'coal', domesticcoal: 'coal', importedcoal: 'coal',
  nuclear: 'nuclear', uranium: 'nuclear',
  oil: 'oil', hfo: 'oil', fueloil: 'oil', lightfueloil: 'oil',
  biomass: 'biomass', biomasswaste: 'biomass', biomassplant: 'biomass',
  geothermal: 'geothermal',
  ice: 'diesel', diesel: 'diesel',
  waste: 'waste',
  biogas: 'biogas',
};

export function normalizeFuel(raw) {
  const k = (raw || '').toLowerCase().replace(/[^a-z]/g, '');
  return FUEL_MAP[k] || k || 'other';
}

export const EPM_FUEL_COLORS = {
  hydro:      '#1E9AF5',
  solar:      '#FFD700',
  wind:       '#44DAEC',
  gas:        '#9A7040',
  coal:       '#808890',
  nuclear:    '#C8A8F0',
  oil:        '#7A7068',
  biomass:    '#52C860',
  geothermal: '#D4A820',
  diesel:     '#6A7888',
  waste:      '#8A9098',
  biogas:     '#72DC8A',
  other:      '#AAAAAA',
};

export const STATUS_LABEL = { 1: 'Existing', 2: 'Committed', 3: 'Candidate' };

// ── Column-name helpers (EPM models use inconsistent headers) ─────────────────

/** Read zone ID — tolerates z, zone, Zone */
function rZone(r)    { return r.z    || r.zone  || r.Zone  || ''; }
/** Read season — tolerates season, q, Q, m */
function rSeason(r)  { return r.season || r.q   || r.Q    || r.m  || ''; }
/** Read daytype — tolerates daytype, d, D */
function rDaytype(r) { return r.daytype || r.d  || r.D    || ''; }
/** Read hourly value at index i (1-based) — tolerates t01 and t1 */
function rT(r, i) {
  return parseFloat(r[`t${String(i).padStart(2,'0')}`] || r[`t${i}`] || 0) || 0;
}

// ── Processors ───────────────────────────────────────────────────────────────

export function processGenData(rows) {
  return rows.map(r => {
    const status   = parseInt(r.Status || r.status || '0');
    const capacity = parseFloat(r.Capacity || r.capacity || '0') || 0;
    if (capacity <= 0 || status < 1 || status > 3) return null;
    return {
      g:        r.g || '',
      zone:     rZone(r),
      tech:     r.tech || '',
      fuel:     normalizeFuel(r.fuel || r.f || r.tech || ''),
      fuelRaw:  r.fuel || r.f || '',
      status,
      capacity,
      stYr:     parseInt(r.StYr || r.stYr || '0') || null,
      retrYr:   parseInt(r.RetrYr || r.retrYr || '0') || null,
      heatRate: parseFloat(r.HeatRate || r.heatRate || '0') || null,
      capex:    parseFloat(r.Capex || r.capex || '0') || null,
      fom:      parseFloat(r.FOMperMW || r.fomPerMW || '0') || null,
      vom:      parseFloat(r.VOM || r.vom || '0') || null,
    };
  }).filter(Boolean);
}

/** Average hourly demand profile per zone: { zone: [h1avg..h24avg] } (values 0-1) */
export function processDemandProfile(rows) {
  if (!rows?.length) return {};
  const byZone = {};
  for (const r of rows) {
    const z = r.z;
    if (!byZone[z]) byZone[z] = { sum: new Array(24).fill(0), count: 0 };
    for (let h = 1; h <= 24; h++) byZone[z].sum[h - 1] += parseFloat(r[`t${h}`]) || 0;
    byZone[z].count++;
  }
  const result = {};
  for (const [z, d] of Object.entries(byZone))
    result[z] = d.sum.map(v => v / d.count);
  return result;
}

/** Returns { zone, type ('peak'|'energy'), years: { '2024': val, ... } }[] */
export function processDemand(rows) {
  if (!rows?.length) return [];
  const yearCols = Object.keys(rows[0]).filter(k => /^\d{4}$/.test(k));
  return rows.map(r => ({
    zone: rZone(r),
    type: (r.type || '').toLowerCase(),
    years: Object.fromEntries(yearCols.map(y => [y, parseFloat(r[y]) || 0])),
  }));
}

/** Returns { z, zext, years: { '2024': maxMW, ... } }[] — max NTC over directions/quarters */
export function processExtNTC(rows) {
  if (!rows?.length) return [];
  const yearCols = Object.keys(rows[0]).filter(k => /^\d{4}$/.test(k));
  const pairs = {};
  for (const r of rows) {
    const z    = r.z    || '';
    const zext = r.zext || '';
    if (!z || !zext) continue;
    const key = `${z}||${zext}`;
    if (!pairs[key]) pairs[key] = { z, zext, years: {} };
    for (const y of yearCols) {
      const v = parseFloat(r[y]) || 0;
      pairs[key].years[y] = Math.max(pairs[key].years[y] || 0, v);
    }
  }
  return Object.values(pairs);
}

/** Returns { z, z2, years: { '2024': avgMW, ... } }[] — averaged over quarters */
export function processNTC(rows) {
  if (!rows?.length) return [];
  const yearCols = Object.keys(rows[0]).filter(k => /^\d{4}$/.test(k));
  const pairs = {};
  for (const r of rows) {
    // Tolerates: z/z2 (Black Sea) and From/To (SAPP)
    const z  = r.z  || r.from || r.From || '';
    const z2 = r.z2 || r.to   || r.To   || '';
    if (!z || !z2) continue;
    const key = `${z}||${z2}`;
    if (!pairs[key]) pairs[key] = { z, z2, years: {}, count: 0 };
    pairs[key].count += 1;
    for (const y of yearCols)
      pairs[key].years[y] = (pairs[key].years[y] || 0) + (parseFloat(r[y]) || 0);
  }
  for (const p of Object.values(pairs))
    for (const y of yearCols)
      p.years[y] = Math.round(p.years[y] / p.count);
  return Object.values(pairs);
}

/** Aggregate gen data by fuel for a given status (or all statuses) */
export function genByFuel(genRows, statuses = [1, 2, 3]) {
  const out = {};
  for (const r of genRows) {
    if (!statuses.includes(r.status)) continue;
    out[r.fuel] = (out[r.fuel] || 0) + r.capacity;
  }
  return out;
}

/** Aggregate demand across all zones for a given type and year */
export function totalDemand(demandRows, type, year) {
  return demandRows
    .filter(r => r.type === type && r.years[year] != null)
    .reduce((s, r) => s + r.years[r.years[year] !== undefined ? year : 0], 0);
}

/** First year column that appears in demand or NTC rows */
export function availableYears(rows) {
  if (!rows?.length) return [];
  return Object.keys(rows[0]?.years || {}).filter(k => /^\d{4}$/.test(k)).sort();
}

/** Full demand profile with season/daytype granularity.
 *  Returns { zone: { season: { daytype: number[24] } } } */
export function processDemandProfileFull(rows) {
  if (!rows?.length) return {};
  const out = {};
  for (const r of rows) {
    const z = rZone(r);
    const s = rSeason(r);
    const d = rDaytype(r);
    if (!z || !s || !d) continue;
    if (!out[z])       out[z]       = {};
    if (!out[z][s])    out[z][s]    = {};
    out[z][s][d] = Array.from({ length: 24 }, (_, i) => rT(r, i + 1));
  }
  return out;
}

/** VRE + ROR generation profiles.
 *  Returns { zone: { tech: { season: { daytype: number[24] } } } } */
export function processVREProfile(rows) {
  if (!rows?.length) return {};
  const out = {};
  for (const r of rows) {
    const z    = rZone(r);
    const tech = (r.tech || '').toLowerCase();
    const s    = rSeason(r);
    const d    = rDaytype(r);
    if (!z || !tech || !s || !d) continue;
    if (!out[z])          out[z]          = {};
    if (!out[z][tech])    out[z][tech]    = {};
    if (!out[z][tech][s]) out[z][tech][s] = {};
    out[z][tech][s][d] = Array.from({ length: 24 }, (_, i) => rT(r, i + 1));
  }
  return out;
}

/** Seasonal availability factors.
 *  Returns { zone: { 'tech|fuel': { Q1, Q2, Q3, Q4, tech, fuel } } } */
export function processAvailability(rows) {
  if (!rows?.length) return {};
  const qCols = Object.keys(rows[0] || {}).filter(k => /^Q\d+$/.test(k)).sort();
  const out = {};
  for (const r of rows) {
    const z    = r.zone || r.z;
    const tech = r.tech || '';
    if (!z || !tech) continue;
    if (!out[z]) out[z] = {};
    const key   = `${tech}|${r.fuel || ''}`;
    const entry = { tech, fuel: r.fuel || '' };
    for (const q of qCols) entry[q] = parseFloat(r[q]) ?? 1;
    out[z][key] = entry;
  }
  return out;
}

/** Representative day weights from pHours.csv.
 *  Returns { season: { daytype: number } } — number = days represented */
export function processHours(rows) {
  if (!rows?.length) return {};
  const out = {};
  for (const r of rows) {
    const q = r.q || r.Q || r.season || '';
    const d = r.d || r.D || r.daytype || '';
    if (!q || !d) continue;
    // Weight = any t value (all identical per row in pHours)
    const w = rT(r, 1);
    if (!out[q]) out[q] = {};
    out[q][d] = w;
  }
  return out;
}

/** Fuel price trajectories.
 *  Returns { country: { fuel: { year: number } } } */
export function processFuelPrice(rows) {
  if (!rows?.length) return {};
  const yearCols = Object.keys(rows[0] || {}).filter(k => /^\d{4}$/.test(k));
  const out = {};
  for (const r of rows) {
    const c = r.country || r.c || '';
    const f = r.fuel    || '';
    if (!c || !f) continue;
    if (!out[c]) out[c] = {};
    out[c][f] = Object.fromEntries(yearCols.map(y => [y, parseFloat(r[y]) || 0]));
  }
  return out;
}
