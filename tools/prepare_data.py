"""
Convert data-source/cache/ intermediate JSON files to GeoJSON for the app.

Run after prepare_region_data.py and/or prepare_gppd.py.

Usage:
    python tools/prepare_data.py                          # all regions
    python tools/prepare_data.py --regions asean eu       # specific regions only
"""
import argparse
import json
import math
import shutil
import yaml
from pathlib import Path


def _safe_mw(v):
    try:
        f = float(v or 0)
        return 0.0 if (math.isnan(f) or math.isinf(f)) else round(f, 1)
    except (TypeError, ValueError):
        return 0.0


_ROOT = Path(__file__).resolve().parents[1]
SRC   = _ROOT / "data-source"
DST   = _ROOT / "public" / "data"
DST.mkdir(parents=True, exist_ok=True)
(DST / "cache").mkdir(exist_ok=True)


def load_region_ids(only=None):
    with open(SRC / "regions.yaml", encoding="utf-8") as f:
        regions = [r for r in yaml.safe_load(f)["regions"] if r["status"] == "available"]
    if only:
        regions = [r for r in regions if r["id"] in only]
    return [r["id"] for r in regions]


def convert_plants(region_id, suffix=""):
    src_path = SRC / "cache" / f"region_plants_{region_id}{suffix}.json"
    if not src_path.exists():
        return
    plants = json.loads(src_path.read_text(encoding="utf-8"))
    geojson = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": i,
                "geometry": {"type": "Point", "coordinates": [p["lon"], p["lat"]]},
                "properties": {
                    "name":    p.get("name") or "",
                    "fuel":    (p.get("fuel") or "unknown").split(";")[0].strip().lower(),
                    "mw":      _safe_mw(p.get("mw")),
                    "country": p.get("country") or "",
                    "status":  p.get("status") or "operating",
                },
            }
            for i, p in enumerate(plants)
            if p.get("lat") and p.get("lon")
        ],
    }
    out = DST / "cache" / f"region_plants_{region_id}{suffix}.geojson"
    out.write_text(json.dumps(geojson), encoding="utf-8")
    print(f"  {out.name}  ({len(geojson['features'])} plants)")


def convert_lines(region_id):
    src_path = SRC / "cache" / f"region_lines_{region_id}.json"
    if not src_path.exists():
        return
    data = json.loads(src_path.read_text(encoding="utf-8"))
    geojson = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[lon, lat] for lon, lat in zip(seg["lons"], seg["lats"])],
                },
                "properties": {"v": seg["v"]},
            }
            for seg in data["segments"]
            if len(seg.get("lons", [])) >= 2
        ],
    }
    out = DST / "cache" / f"region_lines_{region_id}.geojson"
    out.write_text(json.dumps(geojson), encoding="utf-8")
    print(f"  {out.name}  ({len(geojson['features'])} segments)")


def convert_substations(region_id):
    src_path = SRC / "cache" / f"region_substations_{region_id}.json"
    if not src_path.exists():
        return
    subs = json.loads(src_path.read_text(encoding="utf-8"))
    geojson = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [s["lon"], s["lat"]]},
                "properties": {
                    "name": s.get("name") or "",
                    "v":    int(s.get("v") or 0),
                },
            }
            for s in subs
            if s.get("lat") and s.get("lon")
        ],
    }
    out = DST / "cache" / f"region_substations_{region_id}.geojson"
    out.write_text(json.dumps(geojson), encoding="utf-8")
    print(f"  {out.name}  ({len(geojson['features'])} substations)")


def copy_json(region_id, kind, suffix=""):
    src_path = SRC / "cache" / f"region_{kind}_{region_id}{suffix}.json"
    if not src_path.exists():
        return
    dst = DST / "cache" / f"region_{kind}_{region_id}{suffix}.json"
    shutil.copy(src_path, dst)
    print(f"  {dst.name}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--regions", nargs="+", metavar="ID",
                        help="Only process these region IDs (e.g. --regions asean eu)")
    args = parser.parse_args()

    region_ids = load_region_ids(only=set(args.regions) if args.regions else None)

    for rid in region_ids:
        print(f"\n── {rid} ──")
        convert_plants(rid)
        convert_plants(rid, "_gppd")
        convert_plants(rid, "_gem")
        convert_lines(rid)
        convert_substations(rid)
        copy_json(rid, "capacity")
        copy_json(rid, "capacity", "_gppd")
        copy_json(rid, "capacity", "_gem")
        copy_json(rid, "age", "_gppd")

    print("\nAll done.")
