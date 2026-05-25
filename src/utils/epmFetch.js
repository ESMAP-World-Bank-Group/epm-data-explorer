const RAW_BASE = 'https://raw.githubusercontent.com/ESMAP-World-Bank-Group/EPM';

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
  return rows.map(r => ({
    g:        r.g || '',
    zone:     r.z || '',
    tech:     r.tech || '',
    fuel:     normalizeFuel(r.fuel || r.f || ''),
    fuelRaw:  r.fuel || r.f || '',
    status:   parseInt(r.Status || r.status || '0'),
    capacity: parseFloat(r.Capacity || r.capacity || '0') || 0,
  })).filter(r => r.capacity > 0 && r.status >= 1 && r.status <= 3);
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
