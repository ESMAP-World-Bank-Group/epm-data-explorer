// NASA POWER Climatology API — granular solar & wind grid fetcher
// Returns a GeoJSON FeatureCollection of 1°×1° (solar) or 0.5°×0.5° (wind) polygons

export const SOLAR_COLOR_EXPR = [
  'interpolate', ['linear'], ['get', 'value'],
  700,  '#FFF9C4',
  1200, '#FFE082',
  1600, '#FFA726',
  2000, '#FF5722',
  2600, '#B71C1C',
];

export const WIND_COLOR_EXPR = [
  'interpolate', ['linear'], ['get', 'value'],
  3, '#EBF5FB',
  5, '#85C1E9',
  7, '#2E86C1',
  10, '#1A5276',
];

const EMPTY_FC = { type: 'FeatureCollection', features: [] };
const HELLMAN_50_TO_100 = Math.pow(100 / 50, 0.143); // ≈ 1.082

function splitRange(lo, hi) {
  const tiles = [];
  const MAX = 9.8;
  let s = lo;
  while (s < hi) {
    tiles.push([s, Math.min(s + MAX, hi)]);
    s += MAX;
  }
  return tiles;
}

async function fetchTile(latMin, latMax, lonMin, lonMax, parameter) {
  try {
    const url =
      `https://power.larc.nasa.gov/api/temporal/climatology/regional?` +
      `parameters=${parameter}&community=RE` +
      `&latitude-min=${latMin.toFixed(2)}&latitude-max=${latMax.toFixed(2)}` +
      `&longitude-min=${lonMin.toFixed(2)}&longitude-max=${lonMax.toFixed(2)}&format=JSON`;
    const r = await fetch(url);
    if (!r.ok) return [];
    const d = await r.json();
    return d.features || [];
  } catch {
    return [];
  }
}

/**
 * Fetch a solar (GHI) or wind (100m) grid from NASA POWER for the given bbox.
 * Returns a GeoJSON FeatureCollection with polygon cells and a `value` property.
 * Solar: kWh/m²/yr (GHI proxy). Wind: m/s @ 100m (Hellman from 50m).
 */
export async function fetchResourceGrid(south, north, west, east, type) {
  const param = type === 'solar' ? 'ALLSKY_SFC_SW_DWN' : 'WS50M';
  const halfStep = type === 'solar' ? 0.5 : 0.25; // half cell width

  const latTiles = splitRange(Math.max(south - 1, -88), Math.min(north + 1, 88));
  const lonTiles = splitRange(Math.max(west  - 1, -179), Math.min(east + 1, 179));

  // Cap at 25 tiles to avoid hammering the API
  if (latTiles.length * lonTiles.length > 25) return EMPTY_FC;

  const requests = latTiles.flatMap(([latMin, latMax]) =>
    lonTiles.map(([lonMin, lonMax]) => fetchTile(latMin, latMax, lonMin, lonMax, param))
  );

  const batches = await Promise.all(requests);
  const seen = new Set();
  const features = [];

  for (const batch of batches) {
    for (const f of batch) {
      const [lon, lat] = f.geometry.coordinates;
      const key = `${lon.toFixed(3)},${lat.toFixed(3)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const raw = f.properties?.parameter?.[param]?.ANN;
      if (raw == null) continue;

      const value = type === 'solar'
        ? Math.round(raw * 365)
        : +(raw * HELLMAN_50_TO_100).toFixed(1);

      features.push({
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [lon - halfStep, lat - halfStep],
            [lon + halfStep, lat - halfStep],
            [lon + halfStep, lat + halfStep],
            [lon - halfStep, lat + halfStep],
            [lon - halfStep, lat - halfStep],
          ]],
        },
        properties: { value },
      });
    }
  }

  return { type: 'FeatureCollection', features };
}
