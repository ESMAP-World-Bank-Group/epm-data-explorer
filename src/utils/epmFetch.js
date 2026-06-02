const RAW_BASE = 'https://raw.githubusercontent.com/ESMAP-World-Bank-Group/EPM';

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

export async function fetchLinestringGeoJSON(branch, dataFolder) {
  const url = `${RAW_BASE}/${branch}/epm/input/${dataFolder}/linestring_countries.geojson`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export async function fetchZonesGeoJSON(branch, dataFolder) {
  const url = `${RAW_BASE}/${branch}/epm/input/${dataFolder}/zones.geojson`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export async function fetchEpmCSV(branch, dataFolder, relPath) {
  const url = `${RAW_BASE}/${branch}/epm/input/${dataFolder}/${relPath}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return parseCSV(await res.text());
  } catch {
    return null;
  }
}

// Map EPM fuel names → canonical key matching FUEL_COLORS in constants.js
const FUEL_MAP = {
  water: 'hydro', ror: 'hydro', reservoirhydro: 'hydro', pumpedhydro: 'hydro',
  solar: 'solar', pv: 'solar', csp: 'solar',
  wind: 'wind', windonshore: 'wind', windoffshore: 'wind',
  gas: 'gas', naturalgas: 'gas', lng: 'gas',
  coal: 'coal', domesticcoal: 'coal', importedcoal: 'coal',
  nuclear: 'nuclear', uranium: 'nuclear',
  oil: 'oil', hfo: 'oil', fueloil: 'oil', lightfueloil: 'oil',
  biomass: 'biomass', biomasswaste: 'biomass',
  geothermal: 'geothermal',
  diesel: 'diesel',
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

// ── Processors ───────────────────────────────────────────────────────────────

export function processGenData(rows) {
  return rows.map(r => {
    const status   = parseInt(r.Status || r.status || '0');
    const capacity = parseFloat(r.Capacity || r.capacity || '0') || 0;
    if (capacity <= 0 || status < 1 || status > 3) return null;
    return {
      g:        r.g || '',
      zone:     r.z || '',
      tech:     r.tech || '',
      fuel:     normalizeFuel(r.fuel || r.f || ''),
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
    zone: r.z,
    type: (r.type || '').toLowerCase(),
    years: Object.fromEntries(yearCols.map(y => [y, parseFloat(r[y]) || 0])),
  }));
}

/** Returns { z, z2, years: { '2024': avgMW, ... } }[] — averaged over quarters */
export function processNTC(rows) {
  if (!rows?.length) return [];
  const yearCols = Object.keys(rows[0]).filter(k => /^\d{4}$/.test(k));
  const pairs = {};
  for (const r of rows) {
    const key = `${r.z}||${r.z2}`;
    if (!pairs[key]) pairs[key] = { z: r.z, z2: r.z2, years: {}, count: 0 };
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
    const z = r.zone || r.z;
    const s = r.season || '';
    const d = r.daytype || '';
    if (!z || !s || !d) continue;
    if (!out[z])       out[z]       = {};
    if (!out[z][s])    out[z][s]    = {};
    out[z][s][d] = Array.from({ length: 24 }, (_, i) =>
      parseFloat(r[`t${String(i + 1).padStart(2, '0')}`]) || 0);
  }
  return out;
}

/** VRE + ROR generation profiles.
 *  Returns { zone: { tech: { season: { daytype: number[24] } } } } */
export function processVREProfile(rows) {
  if (!rows?.length) return {};
  const out = {};
  for (const r of rows) {
    const z    = r.zone || r.z;
    const tech = (r.tech || '').toLowerCase();
    const s    = r.season || '';
    const d    = r.daytype || '';
    if (!z || !tech || !s || !d) continue;
    if (!out[z])          out[z]          = {};
    if (!out[z][tech])    out[z][tech]    = {};
    if (!out[z][tech][s]) out[z][tech][s] = {};
    out[z][tech][s][d] = Array.from({ length: 24 }, (_, i) =>
      parseFloat(r[`t${String(i + 1).padStart(2, '0')}`]) || 0);
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
    // Weight = any of the t01..t24 values (they're all the same for pHours)
    const w = parseFloat(r.t01 || r['t01'] || 0) || 0;
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
