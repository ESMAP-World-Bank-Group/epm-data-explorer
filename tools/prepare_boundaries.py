"""Build the country boundary layers from the World Bank Official Boundaries dataset.

Source: World Bank Official Boundaries, Data Catalog dataset 0038272 (CC BY 4.0)
        https://datacatalog.worldbank.org/search/dataset/0038272
        wb_countries_admin0_10m.zip -> WB_countries_Admin0_10m.shp

This replaces the Natural Earth extraction previously shipped in public/data. The WB
file is Natural Earth derived but carries the Bank's own treatment of disputed areas
(Kashmir line of control, Western Sahara, Cyprus, Taiwan, Somaliland, ...), so the
maps are consistent with WB cartographic policy.

Outputs (public/data/):
    countries_10m.geojson   -- one feature per country code, detail layer
    countries_110m.geojson  -- same features, generalised for world/meta-region views

Feature properties:
    ISO_A3     ISO 3166-1 alpha-3, the key every page joins on
    WB_A3      World Bank country code (differs from ISO for e.g. ZAR, ROM, TMP, KSV)
    WB_NAME    official World Bank country name
    WB_REGION  World Bank region (AFR, EAP, ECA, LCR, MENA, SOA, Other)

Requires: geopandas, shapely, topojson

Usage:
    python tools/prepare_boundaries.py                  # download if needed, then build
    python tools/prepare_boundaries.py --source PATH    # build from a local zip/shp
    python tools/prepare_boundaries.py --keep-france-overseas
"""
import argparse
import json
import shutil
import warnings
import urllib.request
from pathlib import Path

import geopandas as gpd
import topojson as tp
from shapely.geometry import MultiPolygon, Polygon, box, mapping
from shapely.validation import make_valid

SOURCE_URL = (
    "https://datacatalogfiles.worldbank.org/ddh-published/0038272/DR0046659/"
    "wb_countries_admin0_10m.zip"
)
SOURCE_NAME = "World Bank Official Boundaries (Data Catalog dataset 0038272)"
SOURCE_LICENSE = "CC BY 4.0"
SHP_IN_ZIP = "WB_countries_Admin0_10m/WB_countries_Admin0_10m.shp"

_ROOT = Path(__file__).resolve().parents[1]
CACHE_DIR = _ROOT.parent / "maps"          # sibling of the repo, not committed
OUT_DIR = _ROOT / "public" / "data"

# The WB file leaves ISO_A3 as -99 on a handful of features and uses World Bank
# codes rather than ISO for a few countries. Map WB_A3 -> ISO_A3 for those cases.
WB_A3_TO_ISO = {
    "ZAR": "COD",   # Congo, Dem. Rep.
    "ROM": "ROU",   # Romania
    "TMP": "TLS",   # Timor-Leste
    "KSV": "KOS",   # Kosovo -- KOS is the code used across regions.yaml
}

# Metropolitan France + Corsica. The WB France polygon includes the overseas
# departments; the explorer shows metropolitan France only.
METRO_FRANCE_BBOX = (-5.5, 41.0, 10.0, 51.5)

# Simplification tolerances in degrees. 0.001 deg is ~110 m, well below the
# positional accuracy of a 1:10m source, so the detail layer keeps the WB
# geometry intact for practical purposes.
TOL_10M = 0.001
TOL_110M = 0.08
PREC_10M = 4    # ~11 m
PREC_110M = 3   # ~110 m


def fetch_source(explicit=None):
    if explicit:
        p = Path(explicit)
        if not p.exists():
            raise SystemExit(f"source not found: {p}")
        return p
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    local = CACHE_DIR / "wb_countries_admin0_10m.zip"
    if not local.exists():
        print(f"  downloading {SOURCE_URL}")
        tmp = local.with_suffix(".zip.part")
        with urllib.request.urlopen(SOURCE_URL, timeout=300) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f)
        tmp.replace(local)
    print(f"  source: {local}")
    return local


def read_admin0(path):
    if path.suffix.lower() == ".zip":
        return gpd.read_file(f"zip://{path.as_posix()}!{SHP_IN_ZIP}")
    return gpd.read_file(path)


def iso_code(row):
    for field in ("ISO_A3", "ISO_A3_EH"):
        v = (row.get(field) or "").strip()
        if v and v != "-99":
            return v
    wb = (row.get("WB_A3") or "").strip()
    return WB_A3_TO_ISO.get(wb, wb)


def polygons_only(geom):
    """Repair a geometry and keep only its polygonal parts."""
    if geom is None or geom.is_empty:
        return None
    if not geom.is_valid:
        geom = make_valid(geom)
    parts, stack = [], [geom]
    while stack:
        g = stack.pop()
        if g.is_empty:
            continue
        if isinstance(g, Polygon):
            parts.append(g)
        elif hasattr(g, "geoms"):
            stack.extend(g.geoms)
    if not parts:
        return None
    return parts[0] if len(parts) == 1 else MultiPolygon(parts)


def clip_france(gdf):
    clip = box(*METRO_FRANCE_BBOX)
    mask = gdf.ISO_A3 == "FRA"
    if not mask.any():
        return gdf
    gdf.loc[mask, "geometry"] = gdf.loc[mask, "geometry"].apply(
        lambda g: polygons_only(g.intersection(clip))
    )
    print("  France clipped to metropolitan France + Corsica")
    return gdf


def build_countries(src):
    gdf = read_admin0(src)
    gdf["ISO_A3"] = gdf.apply(iso_code, axis=1)

    unknown = gdf[gdf.ISO_A3.isin(("", "-99"))]
    if len(unknown):
        raise SystemExit(f"unresolved country codes: {sorted(unknown.WB_NAME)}")

    # Several dependencies share a country code (Guantanamo Bay -> USA,
    # Clipperton -> FRA, the US minor outlying islands -> UMI). Merge them so
    # every code maps to exactly one feature, which is what the pages assume.
    with warnings.catch_warnings():
        # degree-based area, only used to rank parts and pick a representative name
        warnings.simplefilter("ignore")
        gdf["_area"] = gdf.geometry.area
    main = (gdf.sort_values("_area", ascending=False)
                .drop_duplicates("ISO_A3")
                .set_index("ISO_A3"))
    out = gdf.dissolve(by="ISO_A3", as_index=False)
    for col in ("WB_A3", "WB_NAME", "WB_REGION"):
        out[col] = out.ISO_A3.map(main[col])
    out = out[["ISO_A3", "WB_A3", "WB_NAME", "WB_REGION", "geometry"]]
    out["geometry"] = out.geometry.apply(polygons_only)
    return out.sort_values("ISO_A3").reset_index(drop=True)


def simplify(gdf, tolerance):
    """Topology-preserving simplification: shared borders stay shared, no slivers."""
    simplified = tp.Topology(gdf, prequantize=1e6,
                             shared_coords=False).toposimplify(tolerance).to_gdf()
    simplified["geometry"] = simplified.geometry.apply(polygons_only)
    # Very small states can be simplified out of existence; keep the source shape.
    lost = simplified.geometry.isna()
    if lost.any():
        names = list(simplified.loc[lost, "ISO_A3"])
        simplified.loc[lost, "geometry"] = gdf.loc[lost, "geometry"].values
        print(f"    kept unsimplified (too small): {', '.join(names)}")
    return simplified


def round_coords(obj, precision):
    if isinstance(obj, float):
        return round(obj, precision)
    if isinstance(obj, (list, tuple)):
        return [round_coords(x, precision) for x in obj]
    return obj


def write_geojson(gdf, path, precision, name):
    features = []
    for row in gdf.itertuples():
        if row.geometry is None:
            continue
        geom = mapping(row.geometry)
        features.append({
            "type": "Feature",
            "properties": {
                "ISO_A3": row.ISO_A3,
                "WB_A3": row.WB_A3,
                "WB_NAME": row.WB_NAME,
                "WB_REGION": row.WB_REGION,
            },
            "geometry": {
                "type": geom["type"],
                "coordinates": round_coords(geom["coordinates"], precision),
            },
        })
    doc = {
        "type": "FeatureCollection",
        "name": name,
        "source": SOURCE_NAME,
        "license": SOURCE_LICENSE,
        "crs": {"type": "name",
                "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "features": features,
    }
    path.write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False),
                    encoding="utf-8")
    print(f"  {path.name}: {len(features)} features, {path.stat().st_size / 1e6:.1f} MB")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", help="local wb_countries_admin0_10m.zip or .shp")
    ap.add_argument("--keep-france-overseas", action="store_true",
                    help="keep the French overseas departments in the FRA polygon")
    args = ap.parse_args()

    src = fetch_source(args.source)
    countries = build_countries(src)
    if not args.keep_france_overseas:
        countries = clip_france(countries)
    print(f"  {len(countries)} country features")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print("  simplifying detail layer")
    write_geojson(simplify(countries, TOL_10M), OUT_DIR / "countries_10m.geojson",
                  PREC_10M, "countries_10m")
    print("  simplifying world layer")
    write_geojson(simplify(countries, TOL_110M), OUT_DIR / "countries_110m.geojson",
                  PREC_110M, "countries_110m")
    print("Done.")


if __name__ == "__main__":
    main()
