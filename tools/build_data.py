"""One-time data prep: shapefiles -> WGS84 GeoJSON, field-guide PDF pages -> web JPEGs.
Stdlib + Pillow only (no pyproj/GDAL on this machine). Run: python tools/build_data.py
"""
import json, math, re, struct
from pathlib import Path
import numpy as np
from PIL import Image

SHP_DIR = Path(r"C:\Users\DeskS\Desktop\lab\agq\shiny")
PDF = Path(r"C:\Users\DeskS\Downloads\fieldguide-5-29.pdf")
OUT = Path(__file__).resolve().parent.parent
FIRST_PAGE, LAST_PAGE = 1, 52  # every page of the guide (1-based; PDF page == printed page). Pages 44-49 are landscape.

# (file stem, output name, source CRS, properties kept: out_key -> dbf field)
LAYERS = [
    ("ActivityAreas", "activity_areas", "utm16", {"name": "Name", "description": "Descriptio"}),
    ("Buildings", "buildings", "utm16", {"name": "Name", "year": "YearBuilt", "description": "Descriptio"}),
    ("Trails", "trails", "utm16", {"name": "Name"}),
    ("Property Border", "property", "utm16", {}),
    ("Trees", "trees", "webmerc", {"tag": "Tag_Number", "common": "Common_Nam", "scientific": "Scientific", "dbh": "dbh"}),
    # Campsites intentionally omitted (not to be used)
    # Added later directly in this project's data/ folder:
    ("Areas", "areas", "utm16", {"name": "Name"}, OUT / "data"),
]
NAME_FIXES = {"Upststairs Camp": "Upstairs Camp"}  # typo in Areas.dbf

# Features missing from the shapefiles. The 48.6 in champion Paper Birch is on the printed tagged-trees map (p.47) but not in
# Trees.shp, and has no tag number there. Position was georeferenced from the print against known trees (~1.5 m accuracy);
# species confirmed by the project owner. Replace with the surveyed point if/when it is added to the shapefile.
EXTRA_FEATURES = {
    "trees": [{"type": "Feature", "properties": {"common": "Paper Birch", "scientific": "Betula papyrifera", "dbh": 48.6},
               "geometry": {"type": "Point", "coordinates": [-84.6839337, 45.4218847]}}],
}

# ---------- projections ----------
A, F = 6378137.0, 1 / 298.257223563
E2 = F * (2 - F)


def utm16_to_lonlat(e, n, lon0=-87.0, k0=0.9996):
    ep2 = E2 / (1 - E2)
    m = n / k0
    mu = m / (A * (1 - E2 / 4 - 3 * E2**2 / 64 - 5 * E2**3 / 256))
    e1 = (1 - math.sqrt(1 - E2)) / (1 + math.sqrt(1 - E2))
    phi1 = (mu + (3 * e1 / 2 - 27 * e1**3 / 32) * math.sin(2 * mu)
            + (21 * e1**2 / 16 - 55 * e1**4 / 32) * math.sin(4 * mu)
            + (151 * e1**3 / 96) * math.sin(6 * mu) + (1097 * e1**4 / 512) * math.sin(8 * mu))
    s, c, t = math.sin(phi1), math.cos(phi1), math.tan(phi1)
    c1, t1 = ep2 * c * c, t * t
    n1 = A / math.sqrt(1 - E2 * s * s)
    r1 = A * (1 - E2) / (1 - E2 * s * s) ** 1.5
    d = (e - 500000.0) / (n1 * k0)
    lat = phi1 - (n1 * t / r1) * (d**2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1**2 - 9 * ep2) * d**4 / 24
                                  + (61 + 90 * t1 + 298 * c1 + 45 * t1**2 - 252 * ep2 - 3 * c1**2) * d**6 / 720)
    lon = lon0 + math.degrees((d - (1 + 2 * t1 + c1) * d**3 / 6
                               + (5 - 2 * c1 + 28 * t1 - 3 * c1**2 + 8 * ep2 + 24 * t1**2) * d**5 / 120) / c)
    return lon, math.degrees(lat)


def webmerc_to_lonlat(x, y):
    return math.degrees(x / A), math.degrees(math.atan(math.sinh(y / A)))


PROJ = {"utm16": utm16_to_lonlat, "webmerc": webmerc_to_lonlat}

# ---------- shapefile / dbf readers ----------

def read_dbf(path):
    b = path.read_bytes()
    n, hl, rl = struct.unpack("<xxxxIHH", b[:12])
    fields, i = [], 32
    while b[i] != 0x0D:
        fields.append((b[i:i + 11].split(b"\0")[0].decode(), chr(b[i + 11]), b[i + 16]))
        i += 32
    rows = []
    for r in range(n):
        row, p, rec = b[hl + r * rl:hl + (r + 1) * rl], 1, {}
        for name, t, ln in fields:
            v = row[p:p + ln].decode("latin1").strip()
            p += ln
            rec[name] = (float(v) if v else None) if t in "NF" else v
        rows.append(rec)
    return rows


def ll(proj, x, y):
    lon, lat = PROJ[proj](x, y)
    return [round(lon, 7), round(lat, 7)]


def read_shp(path, proj):
    """Yield GeoJSON geometries (X,Y only; Z/M ignored)."""
    b = path.read_bytes()
    pos = 100
    while pos < len(b):
        clen = struct.unpack(">i", b[pos + 4:pos + 8])[0] * 2
        rec = b[pos + 8:pos + 8 + clen]
        pos += 8 + clen
        st = struct.unpack("<i", rec[:4])[0]
        if st == 0:
            yield None
        elif st % 10 == 1:  # point (1, 11 PointZ, 21 PointM)
            x, y = struct.unpack("<2d", rec[4:20])
            yield {"type": "Point", "coordinates": ll(proj, x, y)}
        else:  # polyline (3/13) or polygon (5/15)
            nparts, npts = struct.unpack("<2i", rec[36:44])
            parts = list(struct.unpack(f"<{nparts}i", rec[44:44 + 4 * nparts])) + [npts]
            o = 44 + 4 * nparts
            pts = [ll(proj, *struct.unpack("<2d", rec[o + 16 * k:o + 16 * k + 16])) for k in range(npts)]
            rings = [pts[parts[k]:parts[k + 1]] for k in range(nparts)]
            yield {"type": "MultiLineString", "coordinates": rings} if st % 10 == 3 else polygon(rings)


def polygon(rings):
    # shapefile outer rings are clockwise (negative signed area), holes counter-clockwise
    polys = []
    for r in rings:
        area = sum(r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1] for i in range(len(r) - 1))
        if area < 0 or not polys:
            polys.append([r])
        else:
            polys[-1].append(r)
    return {"type": "Polygon", "coordinates": polys[0]} if len(polys) == 1 else {"type": "MultiPolygon", "coordinates": polys}


def flat(c):
    if isinstance(c[0], (int, float)):
        yield c
    else:
        for x in c:
            yield from flat(x)


def build_geojson():
    (OUT / "data").mkdir(exist_ok=True)
    for stem, name, crs, keep, *src in LAYERS:
        folder = src[0] if src else SHP_DIR
        geoms = list(read_shp(folder / f"{stem}.shp", crs))
        rows = read_dbf(folder / f"{stem}.dbf")
        feats = []
        for g, row in zip(geoms, rows):
            if g is None:
                continue
            props = {}
            for k, src in keep.items():
                v = row[src]
                if k == "year" and v:
                    v = int(v)
                if k == "dbh" and v is not None:
                    v = round(v, 1)
                if k == "acres" and v is not None:
                    v = int(v)
                v = NAME_FIXES.get(v, v)
                if v not in ("", None, 0):
                    props[k] = v
            feats.append({"type": "Feature", "properties": props, "geometry": g})
        feats += EXTRA_FEATURES.get(name, [])
        # sanity: projection errors land far from the camp (~45.4N, -84.7W)
        for f in feats:
            for lon, lat in flat(f["geometry"]["coordinates"]):
                assert -84.8 < lon < -84.6 and 45.3 < lat < 45.5, (name, lon, lat)
        (OUT / "data" / f"{name}.geojson").write_text(
            json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")), encoding="utf-8")
        print(f"{name}: {len(feats)} features")

# ---------- PDF sheets ----------

def pdf_pages():
    """The PDF is a scan: one full-page DCT (JPEG) image per page, in page order."""
    d = PDF.read_bytes()
    out = []
    for m in re.finditer(rb"\d+ 0 obj\s*<<(.*?)>>\s*stream\r?\n", d, re.S):
        h = m.group(1)
        if b"/Subtype/Image" in h.replace(b" ", b"") and b"DCTDecode" in h:
            out.append(d[m.end():d.find(b"endstream", m.end())].rstrip(b"\r\n"))
    assert len(out) == 52, len(out)
    return out


def build_sheets():
    sheets, thumbs = OUT / "img" / "sheets", OUT / "img" / "thumbs"
    sheets.mkdir(parents=True, exist_ok=True)
    thumbs.mkdir(parents=True, exist_ok=True)
    pages = pdf_pages()
    tmp = OUT / "tools" / "_page.jpg"
    for n in range(FIRST_PAGE, LAST_PAGE + 1):
        tmp.write_bytes(pages[n - 1])
        im = Image.open(tmp).convert("RGB")
        for folder, w, q in ((sheets, 1400, 82), (thumbs, 360, 78)):
            w = min(w, im.width)  # never upscale (page 45 is only 1056 px wide)
            im.resize((w, round(im.height * w / im.width)), Image.LANCZOS).save(folder / f"p{n:02d}.jpg", quality=q, optimize=True)
    tmp.unlink()
    print(f"sheets: pages {FIRST_PAGE}-{LAST_PAGE}")


# ---------- elevation grid ----------
# data/elevation is an Esri binary grid (float32, feet, NAD83(2011) / Michigan Central in international feet). It is decoded
# here and baked into a shaded color-relief PNG that the map drapes over the property as an image layer.
ELEV_DIR = OUT / "data" / "elevation"
# (position 0 = lowest, 1 = highest) color stops sampled from the printed elevation map (guide p.48)
ELEV_RAMP = [(0.0, "#3b8f98"), (0.05, "#4da0aa"), (0.12, "#6aacab"), (0.15, "#bcd9c0"), (0.19, "#e5f0c7"), (0.27, "#ebf7c9"), (0.34, "#f4fcc9"),
             (0.42, "#fafecc"), (0.49, "#f8fcca"), (0.56, "#f3f3ca"), (0.63, "#ecdfaa"), (0.71, "#e4d49e"), (0.78, "#dfc58d"), (0.85, "#d8b87f"),
             (0.93, "#cea66b"), (1.0, "#bd894e")]


def lcc_to_lonlat(x_ft, y_ft):
    """Lambert Conformal Conic (2SP, GRS80) inverse for NAD83(2011) / Michigan Central (ft)."""
    a, f = 6378137.0, 1 / 298.257222101
    e2 = 2 * f - f * f
    e = math.sqrt(e2)
    phi0, lam0, phi1, phi2 = (math.radians(v) for v in (43.3166666666667, -84.3666666666667, 45.7, 44.1833333333333))
    m = lambda p: math.cos(p) / math.sqrt(1 - e2 * math.sin(p) ** 2)
    t = lambda p: math.tan(math.pi / 4 - p / 2) / (((1 - e * math.sin(p)) / (1 + e * math.sin(p))) ** (e / 2))
    n = (math.log(m(phi1)) - math.log(m(phi2))) / (math.log(t(phi1)) - math.log(t(phi2)))
    F = m(phi1) / (n * t(phi1) ** n)
    rho0 = a * F * t(phi0) ** n
    x, y = x_ft * 0.3048 - 6000000.0, y_ft * 0.3048  # false easting 19685039.37 ft = 6,000,000 m; false northing 0
    rho = math.hypot(x, rho0 - y)
    tt = (rho / (a * F)) ** (1 / n)
    phi = math.pi / 2 - 2 * math.atan(tt)
    for _ in range(8):
        phi = math.pi / 2 - 2 * math.atan(tt * ((1 - e * math.sin(phi)) / (1 + e * math.sin(phi))) ** (e / 2))
    return math.degrees(math.atan2(x, rho0 - y) / n + lam0), math.degrees(phi)


def read_elevation_grid():
    hdr = (ELEV_DIR / "hdr.adf").read_bytes()
    cell = struct.unpack(">d", hdr[256:264])[0]
    per_row, _, bw, _, bh = struct.unpack(">5i", hdr[288:308])  # tiles per row in the index, tile width, tile height
    llx, lly, urx, ury = struct.unpack(">4d", (ELEV_DIR / "dblbnd.adf").read_bytes())
    ncols, nrows = round((urx - llx) / cell), round((ury - lly) / cell)
    index, data = (ELEV_DIR / "w001001x.adf").read_bytes(), (ELEV_DIR / "w001001.adf").read_bytes()
    entries = [struct.unpack(">ii", index[100 + 8 * i:108 + 8 * i]) for i in range((len(index) - 100) // 8)]  # (offset, size) in 16-bit words
    grid = np.full((-(-len(entries) // per_row) * bh, per_row * bw), np.nan)
    for i, (off, size) in enumerate(entries):
        if size:  # empty tiles are all NoData
            r, c = divmod(i, per_row)
            grid[r * bh:(r + 1) * bh, c * bw:(c + 1) * bw] = np.frombuffer(data[off * 2 + 2:off * 2 + 2 + size * 2], ">f4").reshape(bh, bw)
    grid = grid[:nrows, :ncols]
    grid[(grid < 0) | (grid > 1e6)] = np.nan  # NoData is -FLT_MAX
    return grid, cell, (llx, lly, urx, ury)


def build_elevation():
    grid, cell, (llx, lly, urx, ury) = read_elevation_grid()
    lo, hi = float(np.nanmin(grid)), float(np.nanmax(grid))
    stops = np.array([p for p, _ in ELEV_RAMP])
    cols = np.array([[int(c[i:i + 2], 16) for i in (1, 3, 5)] for _, c in ELEV_RAMP], dtype=float)
    z = np.where(np.isnan(grid), np.nanmean(grid), grid)
    tpos = (z - lo) / (hi - lo)
    rgb = np.stack([np.interp(tpos, stops, cols[:, k]) for k in range(3)], axis=-1)
    # hillshade (light from the NW, relief exaggerated 3x) so terrain shows up under the color ramp
    dzdy_rows, dzdx = np.gradient(z * 3.0, cell)
    dzdn = -dzdy_rows  # rows run southward
    norm = np.sqrt(dzdx ** 2 + dzdn ** 2 + 1)
    shade = np.clip((-0.5 * -dzdx + 0.5 * -dzdn + 0.7071) / norm, 0, None) / 0.7071  # 1.0 on flat ground
    rgb *= np.clip(0.6 + 0.4 * shade, 0.55, 1.25)[..., None]
    alpha = np.where(np.isnan(grid), 0, 255)
    img = np.dstack([np.clip(rgb, 0, 255), alpha]).astype(np.uint8)
    Image.fromarray(img, "RGBA").save(OUT / "data" / "elevation.png", optimize=True)
    corners = [lcc_to_lonlat(x, y) for x, y in ((llx, ury), (urx, ury), (urx, lly), (llx, lly))]  # TL, TR, BR, BL
    for lon, lat in corners:
        assert -84.8 < lon < -84.6 and 45.3 < lat < 45.5, (lon, lat)
    (OUT / "data" / "elevation.json").write_text(json.dumps({
        "coordinates": [[round(lon, 7), round(lat, 7)] for lon, lat in corners], "min": round(lo, 1), "max": round(hi, 1), "unit": "ft",
        "ramp": [[p, c] for p, c in ELEV_RAMP]}), encoding="utf-8")
    print(f"elevation: {grid.shape[1]}x{grid.shape[0]} cells, {lo:.1f}-{hi:.1f} ft, corners {corners[0]} .. {corners[2]}")


if __name__ == "__main__":
    build_geojson()
    build_elevation()
    build_sheets()
