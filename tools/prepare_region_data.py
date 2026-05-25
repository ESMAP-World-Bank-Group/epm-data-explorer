"""
Prepares region-level HV lines, power plant, and substation data for EPM Explorer.
Clips to actual country polygon boundaries (not just bbox).

Data source: maps/worldwide.gpkg  (sibling of epm-explorer-v2, not committed to git)

Usage:
    python tools/prepare_region_data.py                    # all regions
    python tools/prepare_region_data.py --regions asean eu # specific regions only

Outputs (data-source/cache/):
    region_lines_{id}.json       -- HV segments with voltage
    region_plants_{id}.json      -- power plants with fuel/capacity
    region_capacity_{id}.json    -- capacity summary per country
    region_substations_{id}.json -- HV substations
"""
import argparse
import json
import sqlite3
import yaml
from pathlib import Path

from shapely.geometry import shape
from shapely.wkb import loads as wkb_loads
from shapely.ops import unary_union

_ROOT    = Path(__file__).resolve().parents[1]
GPKG     = _ROOT.parent / "maps" / "worldwide.gpkg"
DATA_DIR = _ROOT / "data-source"
OUT_DIR  = DATA_DIR / "cache"
OUT_DIR.mkdir(parents=True, exist_ok=True)

LINE_MIN_KV    = 110_000
LINE_TOLERANCE = 0.04
COORD_PREC     = 3


def load_regions(only=None):
    with open(DATA_DIR / "regions.yaml", encoding="utf-8") as f:
        regions = [r for r in yaml.safe_load(f)["regions"] if r["status"] == "available"]
    if only:
        regions = [r for r in regions if r["id"] in only]
    return regions


def load_countries_gdf():
    with open(DATA_DIR.parent / "public" / "data" / "countries_110m.geojson", encoding="utf-8") as f:
        gj = json.load(f)
    rows = []
    for feat in gj["features"]:
        p = feat["properties"]
        iso = p.get("ISO_A3") or "-99"
        if iso == "-99":
            iso = p.get("ISO_A3_EH") or "-99"
        if iso == "-99":
            iso = p.get("ADM0_A3") or "-99"
        try:
            geom = shape(feat["geometry"])
        except Exception:
            continue
        rows.append({"ISO_A3": iso, "geometry": geom})
    return rows


def _gpkg_wkb_to_shapely(raw):
    if raw is None:
        return None
    b = bytes(raw)
    if len(b) >= 8 and b[:2] == b'GP':
        flags = b[3]
        env_size = [0, 4, 6, 6, 8][(flags >> 1) & 7] if ((flags >> 1) & 7) < 5 else 0
        header_len = 8 + env_size * 8
        wkb = b[header_len:]
    else:
        wkb = b
    try:
        return wkb_loads(wkb)
    except Exception:
        return None


def _gpkg_query(table, bbox, columns):
    minx, miny, maxx, maxy = bbox
    conn = sqlite3.connect(str(GPKG))
    try:
        cur = conn.execute(f"PRAGMA table_info({table})")
        cols_info = cur.fetchall()
        geom_col = "geom"
        for ci in cols_info:
            if ci[2].upper() in ("GEOMETRY", "MULTILINESTRING", "LINESTRING", "POINT",
                                  "MULTIPOLYGON", "POLYGON", "BLOB") or "geom" in ci[1].lower():
                geom_col = ci[1]
                break

        idx_table = f"rtree_{table}_{geom_col}"
        try:
            conn.execute(f"SELECT 1 FROM {idx_table} LIMIT 1")
            has_rtree = True
        except Exception:
            has_rtree = False

        sel_cols = ", ".join([f"t.{c}" for c in columns] + [f"t.{geom_col}"])
        if has_rtree:
            sql = (f"SELECT {sel_cols} FROM {table} t "
                   f"JOIN {idx_table} r ON t.fid=r.id "
                   f"WHERE r.minx<={maxx} AND r.maxx>={minx} "
                   f"AND r.miny<={maxy} AND r.maxy>={miny}")
        else:
            sql = f"SELECT {sel_cols} FROM {table}"

        cur = conn.execute(sql)
        rows = []
        for row in cur.fetchall():
            d = {col: row[i] for i, col in enumerate(columns)}
            d["geometry"] = _gpkg_wkb_to_shapely(row[len(columns)])
            rows.append(d)
        return rows
    finally:
        conn.close()


def _geom_to_segments(geom):
    if geom is None or geom.is_empty:
        return
    if geom.geom_type == "LineString":
        yield list(geom.coords)
    elif geom.geom_type == "MultiLineString":
        for part in geom.geoms:
            yield list(part.coords)


def build_lines(region_id, region_union):
    bbox = region_union.bounds
    print(f"  Lines: reading GPKG...")
    rows = _gpkg_query("power_line", bbox, ["max_voltage"])
    rows = [r for r in rows if r.get("max_voltage") is not None and r["max_voltage"] >= LINE_MIN_KV]
    print(f"  {len(rows):,} lines >= {LINE_MIN_KV//1000} kV in bbox")

    segments = []
    for row in rows:
        geom = row["geometry"]
        if geom is None or geom.is_empty:
            continue
        try:
            clipped = geom.intersection(region_union)
        except Exception:
            continue
        if clipped.is_empty:
            continue
        simplified = clipped.simplify(LINE_TOLERANCE, preserve_topology=False)
        if simplified is None or simplified.is_empty:
            continue
        v = int(row.get("max_voltage") or 0)
        for coords in _geom_to_segments(simplified):
            segments.append({
                "v":    v,
                "lats": [round(y, COORD_PREC) for x, y in coords],
                "lons": [round(x, COORD_PREC) for x, y in coords],
            })

    print(f"  {len(segments):,} segments after clip")
    out = OUT_DIR / f"region_lines_{region_id}.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"segments": segments}, f, separators=(",", ":"))
    print(f"  Saved {out.name}  ({out.stat().st_size/1024:.0f} KB, {len(segments):,} segments)")


def build_plants(region_id, region_union, region_countries):
    bbox = region_union.bounds
    print(f"  Plants: reading GPKG...")
    try:
        rows = _gpkg_query("power_plant", bbox, ["name", "name_en", "source", "output"])
    except Exception as e:
        print(f"  Warning: {e}")
        return
    print(f"  {len(rows):,} plants in bbox")

    region_buf = region_union.buffer(0.05)
    plants_in = []
    for row in rows:
        g = row["geometry"]
        if g is None or g.is_empty:
            continue
        pt = g.centroid if g.geom_type != "Point" else g
        try:
            if pt.within(region_buf):
                plants_in.append((row, pt))
        except Exception:
            pass
    print(f"  {len(plants_in):,} plants within region")

    def find_country(pt):
        for c in region_countries:
            try:
                if c["geometry"].contains(pt):
                    return c["ISO_A3"]
            except Exception:
                pass
        return None

    print(f"  Assigning country ISO...")
    plants = []
    capacity = {}
    for row, pt in plants_in:
        mw = None
        if row.get("output") is not None:
            try:
                mw = round(float(row["output"]) / 1000, 1)
            except (ValueError, TypeError):
                pass
        country = find_country(pt)
        fuel = str(row.get("source") or "").strip() or "unknown"
        plants.append({
            "lat":     round(pt.y, COORD_PREC),
            "lon":     round(pt.x, COORD_PREC),
            "name":    str(row.get("name") or row.get("name_en") or "").strip(),
            "fuel":    fuel,
            "mw":      mw,
            "country": country,
        })
        if country and mw and mw > 0:
            fuel_key = fuel.split(";")[0].strip().lower()
            capacity.setdefault(country, {})
            capacity[country][fuel_key] = round(
                capacity[country].get(fuel_key, 0) + mw, 1
            )

    out = OUT_DIR / f"region_plants_{region_id}.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(plants, f, separators=(",", ":"), ensure_ascii=False)
    print(f"  Saved {out.name}  ({out.stat().st_size/1024:.0f} KB, {len(plants):,} plants)")

    out_cap = OUT_DIR / f"region_capacity_{region_id}.json"
    with open(out_cap, "w", encoding="utf-8") as f:
        json.dump({"countries": capacity}, f, separators=(",", ":"))
    print(f"  Saved {out_cap.name}")


def build_substations(region_id, region_union):
    bbox = region_union.bounds
    print(f"  Substations: reading GPKG...")
    try:
        rows = _gpkg_query("power_substation_point", bbox, ["name", "name_en", "max_voltage"])
    except Exception as e:
        print(f"  Warning: {e}")
        return
    region_buf = region_union.buffer(0.02)
    subs = []
    for row in rows:
        v_raw = row.get("max_voltage")
        if v_raw is None:
            continue
        try:
            v = int(v_raw)
        except (ValueError, TypeError):
            continue
        if v < 110_000:
            continue
        geom = row["geometry"]
        if geom is None or geom.is_empty:
            continue
        try:
            if not geom.within(region_buf):
                continue
        except Exception:
            continue
        subs.append({
            "lat":  round(geom.y, COORD_PREC),
            "lon":  round(geom.x, COORD_PREC),
            "name": str(row.get("name") or row.get("name_en") or "").strip(),
            "v":    v,
        })

    print(f"  {len(subs):,} substations >= 110 kV within region")
    out = OUT_DIR / f"region_substations_{region_id}.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(subs, f, separators=(",", ":"), ensure_ascii=False)
    print(f"  Saved {out.name}  ({out.stat().st_size/1024:.0f} KB, {len(subs):,} substations)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--regions", nargs="+", metavar="ID",
                        help="Only process these region IDs (e.g. --regions asean eu)")
    args = parser.parse_args()

    if not GPKG.exists():
        print(f"ERROR: worldwide.gpkg not found at {GPKG}")
        raise SystemExit(1)

    regions       = load_regions(only=set(args.regions) if args.regions else None)
    countries_all = load_countries_gdf()

    for region in regions:
        print(f"\n=== {region['name']} ({region['id']}) ===")
        iso_set          = {c["iso"] for c in region["countries"]}
        region_countries = [c for c in countries_all if c["ISO_A3"] in iso_set]
        if not region_countries:
            print("  No matching countries, skipping")
            continue
        region_union = unary_union([c["geometry"] for c in region_countries])
        build_lines(region["id"], region_union)
        build_plants(region["id"], region_union, region_countries)
        build_substations(region["id"], region_union)

    print("\nDone.")
