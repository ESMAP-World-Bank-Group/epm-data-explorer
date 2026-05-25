"""
Download and process the WRI Global Power Plant Database (GPPD) for EPM Explorer.

Downloads the CSV once (~35 MB) and generates per-region plant files.

Usage:
    python tools/prepare_gppd.py                          # all regions
    python tools/prepare_gppd.py --regions asean eu       # specific regions only
    python tools/prepare_gppd.py --force                  # re-download CSV

Outputs (data-source/cache/):
    region_plants_{id}_gppd.json
    region_capacity_{id}_gppd.json
    region_age_{id}_gppd.json
"""
import argparse
import json
import math
import sys
import urllib.request
from pathlib import Path

import yaml

GPPD_URL = "https://raw.githubusercontent.com/wri/global-power-plant-database/master/output_database/global_power_plant_database.csv"

_ROOT    = Path(__file__).resolve().parents[1]
DATA_DIR = _ROOT / "data-source"
OUT_DIR  = DATA_DIR / "cache"
GPPD_CSV = DATA_DIR / "global_power_plant_database.csv"
OUT_DIR.mkdir(parents=True, exist_ok=True)

COORD_PREC   = 3
CURRENT_YEAR = 2024

FUEL_MAP = {
    "Solar":          "solar",
    "Wind":           "wind",
    "Hydro":          "hydro",
    "Gas":            "gas",
    "Coal":           "coal",
    "Nuclear":        "nuclear",
    "Oil":            "oil",
    "Biomass":        "biomass",
    "Geothermal":     "geothermal",
    "Waste":          "waste",
    "Petcoke":        "coal",
    "Cogeneration":   "gas",
    "Other":          "unknown",
    "Storage":        "unknown",
    "Wave and Tidal": "unknown",
}


def download_gppd(force=False):
    if GPPD_CSV.exists() and not force:
        print(f"  GPPD CSV already at {GPPD_CSV} — skipping download (use --force to re-download)")
        return
    print(f"  Downloading GPPD CSV from GitHub (~35 MB)...")
    urllib.request.urlretrieve(GPPD_URL, GPPD_CSV)
    print(f"  Saved to {GPPD_CSV}  ({GPPD_CSV.stat().st_size/1024/1024:.1f} MB)")


def load_regions(only=None):
    with open(DATA_DIR / "regions.yaml", encoding="utf-8") as f:
        regions = [r for r in yaml.safe_load(f)["regions"] if r["status"] == "available"]
    if only:
        regions = [r for r in regions if r["id"] in only]
    return regions


def process_region(region, df):
    iso_set = {c["iso"] for c in region["countries"]}
    sub = df[df["country"].isin(iso_set)].copy()
    print(f"  {len(sub):,} plants in GPPD for this region")

    plants = []
    capacity = {}
    age_accum = {}

    for _, row in sub.iterrows():
        try:
            lat = float(row["latitude"])
            lon = float(row["longitude"])
            if math.isnan(lat) or math.isnan(lon):
                continue
        except (ValueError, TypeError):
            continue

        try:
            mw = float(row["capacity_mw"])
            if math.isnan(mw) or math.isinf(mw):
                mw = None
            else:
                mw = round(mw, 1)
        except (ValueError, TypeError):
            mw = None

        raw_fuel = str(row.get("primary_fuel") or "").strip()
        fuel     = FUEL_MAP.get(raw_fuel, "unknown")
        country  = str(row.get("country") or "").strip() or None
        name     = str(row.get("name") or "").strip()

        cy = None
        try:
            raw_year = row.get("commissioning_year")
            if raw_year is not None:
                yr = float(raw_year)
                if not math.isnan(yr) and 1900 <= yr <= CURRENT_YEAR:
                    cy = int(yr)
        except (ValueError, TypeError):
            pass

        plants.append({
            "lat":     round(lat, COORD_PREC),
            "lon":     round(lon, COORD_PREC),
            "name":    name,
            "fuel":    fuel,
            "mw":      mw,
            "country": country,
            "year":    cy,
            "status":  "operating",
        })

        if country and mw and mw > 0:
            capacity.setdefault(country, {})
            capacity[country][fuel] = round(capacity[country].get(fuel, 0) + mw, 1)

            if cy is not None:
                age_years = CURRENT_YEAR - cy
                a = age_accum.setdefault(country, {"mw_sum": 0.0, "mw_age_sum": 0.0, "oldest_year": CURRENT_YEAR})
                a["mw_sum"]     += mw
                a["mw_age_sum"] += mw * age_years
                if cy < a["oldest_year"]:
                    a["oldest_year"] = cy

    rid = region["id"]
    out = OUT_DIR / f"region_plants_{rid}_gppd.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(plants, f, separators=(",", ":"), ensure_ascii=False)
    print(f"  Saved {out.name}  ({out.stat().st_size/1024:.0f} KB, {len(plants):,} plants)")

    out_cap = OUT_DIR / f"region_capacity_{rid}_gppd.json"
    with open(out_cap, "w", encoding="utf-8") as f:
        json.dump({"countries": capacity}, f, separators=(",", ":"))
    print(f"  Saved {out_cap.name}")

    fleet_age = {
        iso: {
            "avg_years":   round(d["mw_age_sum"] / d["mw_sum"], 1),
            "oldest_year": d["oldest_year"],
        }
        for iso, d in age_accum.items() if d["mw_sum"] > 0
    }
    out_age = OUT_DIR / f"region_age_{rid}_gppd.json"
    with open(out_age, "w", encoding="utf-8") as f:
        json.dump({"reference_year": CURRENT_YEAR, "countries": fleet_age}, f, separators=(",", ":"))
    print(f"  Saved {out_age.name}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--regions", nargs="+", metavar="ID",
                        help="Only process these region IDs (e.g. --regions asean eu)")
    parser.add_argument("--force", action="store_true", help="Re-download GPPD CSV")
    args = parser.parse_args()

    download_gppd(force=args.force)

    try:
        import pandas as pd
    except ImportError:
        print("pandas not installed — run: pip install pandas")
        sys.exit(1)

    print("Loading GPPD CSV...")
    df = pd.read_csv(GPPD_CSV, low_memory=False)
    print(f"  {len(df):,} plants total")

    regions = load_regions(only=set(args.regions) if args.regions else None)
    for region in regions:
        print(f"\n=== {region['name']} ({region['id']}) ===")
        process_region(region, df)

    print("\nDone. Run prepare_data.py to convert to GeoJSON for the app.")
