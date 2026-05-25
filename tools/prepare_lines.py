"""
Extracts worldwide HV lines (>=330 kV) from worldwide.gpkg for the world map view.

Data source: maps/worldwide.gpkg  (sibling of epm-explorer-v2, not committed to git)

Usage (run once, commit output):
    python tools/prepare_lines.py

Output:
    data-source/cache/lines_world_220kv.json
    (then run prepare_data.py to copy to public/data/cache/)
"""
import json
from pathlib import Path

import geopandas as gpd

_ROOT   = Path(__file__).resolve().parents[1]
GPKG    = _ROOT.parent / "maps" / "worldwide.gpkg"
OUT_DIR = _ROOT / "data-source" / "cache"
OUT_DIR.mkdir(parents=True, exist_ok=True)

WORLD_THRESHOLD = 330_000
WORLD_TOLERANCE = 0.15
COORD_PRECISION = 2


def _geom_to_segments(geom):
    if geom is None or geom.is_empty:
        return
    if geom.geom_type == "LineString":
        yield list(geom.coords)
    elif geom.geom_type == "MultiLineString":
        for part in geom.geoms:
            yield list(part.coords)


def build_world_lines():
    if not GPKG.exists():
        print(f"ERROR: worldwide.gpkg not found at {GPKG}")
        raise SystemExit(1)

    print(f"Reading power_line layer (max_voltage >= {WORLD_THRESHOLD/1000:.0f} kV)...")
    gdf = gpd.read_file(GPKG, layer="power_line",
                        where=f"max_voltage >= {WORLD_THRESHOLD}")
    print(f"  {len(gdf):,} lines found")

    print(f"Simplifying (tolerance={WORLD_TOLERANCE}°)...")
    gdf["geometry"] = gdf["geometry"].simplify(WORLD_TOLERANCE, preserve_topology=False)
    gdf = gdf[gdf["geometry"].notna() & ~gdf["geometry"].is_empty]
    print(f"  {len(gdf):,} lines after simplification")

    lats, lons = [], []
    for geom in gdf["geometry"]:
        for segment in _geom_to_segments(geom):
            for x, y in segment:
                lons.append(round(x, COORD_PRECISION))
                lats.append(round(y, COORD_PRECISION))
            lons.append(None)
            lats.append(None)

    out = OUT_DIR / "lines_world_220kv.json"
    with open(out, "w") as f:
        json.dump({"lats": lats, "lons": lons}, f, separators=(",", ":"))

    size_mb = out.stat().st_size / 1024 / 1024
    print(f"  Saved: {out}  ({size_mb:.1f} MB, {len(lats):,} points)")
    return size_mb


if __name__ == "__main__":
    mb = build_world_lines()
    if mb > 10:
        print(f"\nWARNING: file is {mb:.1f} MB — consider increasing WORLD_TOLERANCE.")
    print("\nDone. Run prepare_data.py to copy to public/data/cache/.")
