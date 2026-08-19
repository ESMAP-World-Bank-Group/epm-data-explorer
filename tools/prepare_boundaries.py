"""Build the country boundary layers from the World Bank Official Boundaries dataset.

Source: World Bank Official Boundaries, Data Catalog dataset 0038272 (CC BY 4.0)
        https://datacatalog.worldbank.org/search/dataset/0038272
        wb_countries_admin0_10m.zip -> WB_countries_Admin0_10m.shp

This replaces the Natural Earth extraction previously shipped in public/data. The WB
file is Natural Earth derived but carries the Bank's own treatment of disputed areas
(Kashmir line of control, Western Sahara, Cyprus, Taiwan, Somaliland, ...), so the
maps are consistent with WB cartographic policy.

The Admin 0 layer deliberately leaves the areas the Bank does not attribute to any
country as holes (Western Sahara, Abyei, Arunachal Pradesh, ...). They live in a
separate WB layer, WB_GAD_Disputes, which is appended here so the maps show land
rather than sea there -- see build_undetermined().

Outputs (public/data/):
    countries_10m.geojson   -- one feature per country code, detail layer
    countries_110m.geojson  -- same features, generalised for world/meta-region views

Feature properties:
    ISO_A3     ISO 3166-1 alpha-3, the key every page joins on ("" when unattributed)
    WB_A3      World Bank country code (differs from ISO for e.g. ZAR, ROM, TMP, KSV)
    WB_NAME    official World Bank country name
    WB_REGION  World Bank region (AFR, EAP, ECA, LCR, MENA, SOA, Other)
    STATUS     absent on countries, "non-determined" on unattributed areas

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
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

import pandas as pd
import geopandas as gpd
import topojson as tp
from shapely.geometry import LineString, MultiPolygon, Polygon, box, mapping
from shapely.ops import unary_union
from shapely.strtree import STRtree
from shapely.validation import make_valid

SOURCE_URL = (
    "https://datacatalogfiles.worldbank.org/ddh-published/0038272/DR0046659/"
    "wb_countries_admin0_10m.zip"
)
SOURCE_NAME = "World Bank Official Boundaries (Data Catalog dataset 0038272)"
SOURCE_LICENSE = "CC BY 4.0"
SHP_IN_ZIP = "WB_countries_Admin0_10m/WB_countries_Admin0_10m.shp"

# Disputed / non-determined status areas, from the WB Global Administrative
# Divisions service. Same cartographic authority as the Admin 0 file above.
DISPUTES_URL = (
    "https://geowb.worldbank.org/hosting/rest/services/Hosted/"
    "WB_GAD_Medium_Resolution/FeatureServer/6/query"
)
DISPUTES_QUERY = {
    "where": "1=1",
    "outFields": "nam_0,nam_0_alt",
    "returnGeometry": "true",
    "outSR": "4326",
    "f": "geojson",
}

# The Bank's own drawing instructions for national boundaries. Every segment
# carries a `style`: null where the line is solid, otherwise one of Dashed,
# Tightly Dashed or Dotted. Only the styles are used -- this layer is medium
# resolution and sits up to ~2 km off our Admin 0 edges, so drawing its
# geometry would double every border. See build_boundaries().
STYLES_URL = (
    "https://geowb.worldbank.org/hosting/rest/services/Hosted/"
    "WB_GAD_Medium_Resolution/FeatureServer/0/query"
)
STYLES_QUERY = {
    "where": "1=1",
    "outFields": "style",
    "returnGeometry": "true",
    "outSR": "4326",
    "f": "geojson",
}

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

# Antarctica is a non-determined area too, but it is outside the scope of the
# explorer and on its own is larger than every other one put together.
UNDETERMINED_SKIP = {"Antarctica"}
# A disputed polygon that the Admin 0 layer already paints as part of a country
# only leaves a coastal or border sliver behind; keep the ones that are a real
# hole, by uncovered fraction and by absolute size (square degrees).
MIN_UNDETERMINED_FRACTION = 0.5
MIN_UNDETERMINED_AREA = 1e-3

# Every land boundary of a non-determined area is drawn dashed; its coastline
# is drawn solid like any other. This is the style to fall back on for the
# stretches the WB line layer does not reach.
WB_LINE_STYLES = ("Dashed", "Tightly Dashed", "Dotted")
UNDETERMINED_STYLE = "Tightly Dashed"
# Lateral tolerance, in degrees, for recognising one of our own border edges in
# a styled WB segment. Ends are squared off so a segment cannot bleed past its
# own tips onto the next border along.
STYLE_MATCH_TOL = 0.05
# How close an area's outline has to run to a country for that stretch to count
# as a land boundary rather than a shore. Testing against the country areas
# instead of their edges survives the vertex mismatch left by simplification.
# The two source layers are drawn at different resolutions, so a land boundary
# can leave a void up to ~0.08 deg wide between the area and its neighbour; a
# real shore is degrees away from the nearest other country, so 0.1 separates
# the two cleanly.
LAND_EDGE_TOL = 0.1
# Near a tripoint a styled segment still passes within the tolerance of the
# neighbouring border and tags a stub of it. A real dashed border contributes
# degrees of line; those strays contribute hundredths, so drop the small ones.
MIN_STYLED_BORDER = 0.25

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


def fetch_disputes():
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    local = CACHE_DIR / "wb_gad_disputes.geojson"
    if not local.exists():
        url = f"{DISPUTES_URL}?{urllib.parse.urlencode(DISPUTES_QUERY)}"
        print(f"  downloading {DISPUTES_URL}")
        tmp = local.with_suffix(".geojson.part")
        with urllib.request.urlopen(url, timeout=300) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f)
        tmp.replace(local)
    return local


def fetch_boundary_styles():
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    local = CACHE_DIR / "wb_gad_adm0_bdys.geojson"
    if not local.exists():
        url = f"{STYLES_URL}?{urllib.parse.urlencode(STYLES_QUERY)}"
        print(f"  downloading {STYLES_URL}")
        tmp = local.with_suffix(".geojson.part")
        with urllib.request.urlopen(url, timeout=300) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f)
        tmp.replace(local)
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


def lines_only(geom):
    """Flatten a geometry to its non-empty LineString parts."""
    out, stack = [], [geom]
    while stack:
        part = stack.pop()
        if part is None or part.is_empty:
            continue
        if isinstance(part, LineString):
            if part.length > 0:
                out.append(part)
        elif hasattr(part, "geoms"):
            stack.extend(part.geoms)
    return out


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
    out["STATUS"] = ""
    out = out[["ISO_A3", "WB_A3", "WB_NAME", "WB_REGION", "STATUS", "geometry"]]
    out["geometry"] = out.geometry.apply(polygons_only)
    return out.sort_values("ISO_A3").reset_index(drop=True)


def build_undetermined(countries):
    """The WB disputed areas, reduced to the holes the Admin 0 layer leaves.

    Most disputed polygons sit on top of a country the Bank does attribute
    (Arunachal Pradesh is drawn inside India in some products, the Kurils inside
    Russia, ...). Subtracting the country union keeps only what is genuinely
    unpainted, so these features never overpaint a country, they just fill in.
    """
    gdf = gpd.read_file(fetch_disputes())
    gdf["WB_NAME"] = gdf.nam_0_alt.fillna(gdf.nam_0).str.strip()
    gdf = gdf[~gdf.WB_NAME.isin(UNDETERMINED_SKIP)]

    covered = unary_union([g.buffer(0) for g in countries.geometry if g is not None])
    geoms, kept = [], []
    with warnings.catch_warnings():
        # degree-based area, only ever compared against another degree-based area
        warnings.simplefilter("ignore")
        for g in gdf.geometry:
            g = polygons_only(g)
            hole = None if g is None else polygons_only(g.difference(covered))
            geoms.append(hole)
            kept.append(hole is not None
                        and hole.area >= MIN_UNDETERMINED_AREA
                        and hole.area >= MIN_UNDETERMINED_FRACTION * g.area)
    gdf["geometry"] = geoms
    gdf = gdf[kept]

    out = gdf.dissolve(by="WB_NAME", as_index=False)[["WB_NAME", "geometry"]]
    out["ISO_A3"] = ""
    out["WB_A3"] = ""
    out["WB_REGION"] = ""
    out["STATUS"] = "non-determined"
    out = out.sort_values("WB_NAME").reset_index(drop=True)
    print(f"  {len(out)} non-determined areas: {', '.join(out.WB_NAME)}")
    return out[["ISO_A3", "WB_A3", "WB_NAME", "WB_REGION", "STATUS", "geometry"]]


def _style_lookup(styles):
    """Split one of our edges into the styled stretches a WB segment covers."""
    tree = STRtree(list(styles.geometry))

    def lookup(edge):
        matched, rest = [], edge
        for k in tree.query(edge.buffer(STYLE_MATCH_TOL)):
            band = styles.geometry[k].buffer(STYLE_MATCH_TOL, cap_style=2)
            for piece in lines_only(rest.intersection(band)):
                matched.append((styles["style"][k], piece))
            rest = unary_union(lines_only(rest.difference(band)))
            if rest.is_empty:
                break
        return matched, lines_only(rest)

    return lookup


def build_boundaries(layer):
    """The Bank's broken borders, redrawn on our own edges.

    Two things end up in this layer. The outline of every non-determined area,
    split so that the land boundary is dashed and the coastline stays solid
    like any other shore. And the national borders the Bank itself draws
    broken -- the Line of Control, the line of actual control, the Korean
    DMZ -- matched onto our geometry by position, so that the styled line and
    the solid one underneath can never disagree by a pixel.
    """
    styles = gpd.read_file(fetch_boundary_styles())
    styles = styles[styles["style"].isin(WB_LINE_STYLES)].reset_index(drop=True)
    lookup = _style_lookup(styles)

    nd = layer[layer.STATUS == "non-determined"]
    countries = layer[layer.STATUS != "non-determined"].reset_index(drop=True)
    cgeoms, cnames = list(countries.geometry), list(countries.WB_NAME)
    tree = STRtree(cgeoms)
    rows = []

    for area in nd.itertuples():
        outline = area.geometry.boundary
        neighbours = [cgeoms[k].buffer(0)
                      for k in tree.query(area.geometry.buffer(LAND_EDGE_TOL))]
        band = unary_union(neighbours).buffer(LAND_EDGE_TOL)
        for piece in lines_only(outline.difference(band)):
            rows.append((area.WB_NAME, "", piece))
        for edge in lines_only(outline.intersection(band)):
            matched, plain = lookup(edge)
            rows.extend((area.WB_NAME, st, piece) for st, piece in matched)
            rows.extend((area.WB_NAME, UNDETERMINED_STYLE, piece) for piece in plain)

    tagged = defaultdict(list)
    for i, gi in enumerate(cgeoms):
        boundary = gi.boundary
        for j in tree.query(gi):
            if j <= i:
                continue
            for edge in lines_only(boundary.intersection(cgeoms[j].boundary)):
                for st, piece in lookup(edge)[0]:
                    tagged[(" / ".join(sorted((cnames[i], cnames[j]))), st)].append(piece)
    for (pair, st), pieces in sorted(tagged.items()):
        if sum(p.length for p in pieces) >= MIN_STYLED_BORDER:
            rows.extend((pair, st, p) for p in pieces)

    out = gpd.GeoDataFrame(rows, columns=["NAME", "STYLE", "geometry"],
                           geometry="geometry", crs=layer.crs)
    kept = defaultdict(float)
    for r in out.itertuples():
        kept[r.STYLE or "solid (coastline)"] += r.geometry.length
    print("    " + ", ".join(f"{k} {v:.1f} deg" for k, v in sorted(kept.items())))
    return out


def write_lines(gdf, path, precision, name):
    features = [{
        "type": "Feature",
        "properties": {"NAME": row.NAME, "STYLE": row.STYLE},
        "geometry": {"type": "LineString",
                     "coordinates": round_coords(list(row.geometry.coords), precision)},
    } for row in gdf.itertuples()]
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


def simplify(gdf, tolerance):
    """Topology-preserving simplification: shared borders stay shared, no slivers."""
    simplified = tp.Topology(gdf, prequantize=1e6,
                             shared_coords=False).toposimplify(tolerance).to_gdf()
    simplified["geometry"] = simplified.geometry.apply(polygons_only)
    # Very small states can be simplified out of existence; keep the source shape.
    lost = simplified.geometry.isna()
    if lost.any():
        names = list(simplified.loc[lost, "WB_NAME"])
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
        props = {
            "ISO_A3": row.ISO_A3,
            "WB_A3": row.WB_A3,
            "WB_NAME": row.WB_NAME,
            "WB_REGION": row.WB_REGION,
        }
        if row.STATUS:
            props["STATUS"] = row.STATUS
        features.append({
            "type": "Feature",
            "properties": props,
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

    # Simplified together with the countries so the shared edges stay shared.
    layer = pd.concat([countries, build_undetermined(countries)], ignore_index=True)
    layer = gpd.GeoDataFrame(layer, geometry="geometry", crs=countries.crs)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    # The broken borders are traced on the simplified polygons of each
    # resolution, so that every dash sits exactly on the edge it belongs to.
    for label, tol, prec, suffix in (("detail", TOL_10M, PREC_10M, "10m"),
                                     ("world", TOL_110M, PREC_110M, "110m")):
        print(f"  simplifying {label} layer")
        simplified = simplify(layer, tol)
        write_geojson(simplified, OUT_DIR / f"countries_{suffix}.geojson",
                      prec, f"countries_{suffix}")
        print(f"  tracing {label} boundary styles")
        write_lines(build_boundaries(simplified),
                    OUT_DIR / f"boundaries_{suffix}.geojson", prec,
                    f"boundaries_{suffix}")
    print("Done.")


if __name__ == "__main__":
    main()
