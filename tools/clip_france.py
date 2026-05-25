"""Remove French overseas territories from the France polygon in GeoJSON files."""
import json
from pathlib import Path
from shapely.geometry import shape, mapping, MultiPolygon, box

# Metropolitan France + Corsica bounding box
METRO_BBOX = (-5.5, 41.0, 10.0, 51.5)

def keep_metro(geom):
    clip = box(*METRO_BBOX)
    if geom.geom_type == 'MultiPolygon':
        parts = [p.intersection(clip) for p in geom.geoms
                 if not p.intersection(clip).is_empty]
        if not parts:
            return geom
        return MultiPolygon(parts) if len(parts) > 1 else parts[0]
    return geom.intersection(clip)

ROOT = Path(__file__).resolve().parents[1]

for fname in ['countries_110m.geojson', 'countries_10m.geojson']:
    path = ROOT / 'public' / 'data' / fname
    if not path.exists():
        print(f'  SKIP {fname} (not found)')
        continue
    gj = json.loads(path.read_text(encoding='utf-8'))
    changed = 0
    for feat in gj['features']:
        p = feat['properties']
        raw = p.get('ISO_A3') or ''
        iso = raw if raw != '-99' else (p.get('ISO_A3_EH') or p.get('ADM0_A3') or '')
        if iso != 'FRA':
            continue
        geom = shape(feat['geometry'])
        new_geom = keep_metro(geom)
        feat['geometry'] = mapping(new_geom)
        changed += 1
    path.write_text(json.dumps(gj, ensure_ascii=False), encoding='utf-8')
    print(f'  {fname}: {changed} feature(s) — clipped to metropolitan France + Corsica')

print('Done.')
