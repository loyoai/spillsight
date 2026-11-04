#!/usr/bin/env python3
"""Build the Strait of Hormuz terrain assets for SpillSight (see ../CONTRACT.md).

Outputs (in ../web/assets/):
  tex/sat.jpg        4096x2048  Sentinel-2 cloudless (EOX, CC BY 4.0), hillshade baked in on land
  tex/sat_small.jpg  1024x512   same, for fast previews
  tex/height.png     1024x576 L 0 = sea / <=0 m, 1..255 = land height scaled to hmax_m
  tex/seamask.png    1024x512 L white = sea, black = land (soft edge)
  region.json        {Z, lon0, lat0, crop_w, crop_h, x0, y0, W, H, hmax_m, exag}

Sources: EOX s2cloudless_3857 WMTS tiles (zoom 11), AWS Terrain Tiles terrarium (zoom 10),
Natural Earth 10m land (world-atlas TopoJSON). Tiles are fetched sequentially with curl and cached
in tools/tiles/ (gitignored). Already-downloaded tiles in ../../film/build/tiles are reused read-only.

Usage: python3 tools/build_terrain.py
"""
import json
import math
import os
import shutil
import subprocess
import time

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ASSETS = os.path.join(ROOT, "web", "assets")
TEX = os.path.join(ASSETS, "tex")
CACHE = os.path.join(HERE, "tiles")
FILM_BUILD = os.path.join(os.path.dirname(ROOT), "film", "build")
FILM_CACHE = os.path.join(FILM_BUILD, "tiles")
LAND_JSON = os.path.join(HERE, "land-10m.json")

SAT_URL = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg"
TERR_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"

# ---- contract: region / world mapping -------------------------------------------------------
Z = 11
LON0, LAT0 = 56.30, 26.50
CROP_W, CROP_H = 4096, 2304
EXAG = 3
HZ = 11                    # terrarium zoom (11 = same pixel grid as the satellite crop)
SAT_OUT = (4096, 2048)
HEIGHT_OUT = (1024, 576)
MASK_OUT = (1024, 512)


def world(lon, lat, z):
    n = 256 * 2 ** z
    x = (lon + 180) / 360 * n
    s = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return x, y


N = 256 * 2 ** Z
XC, YC = world(LON0, LAT0, Z)
X0, Y0 = XC - CROP_W / 2, YC - CROP_H / 2
W_KM = CROP_W / (N / 360) * 111.32 * math.cos(math.radians(26.5))
H_KM = W_KM * CROP_H / CROP_W


# ---- tile fetching --------------------------------------------------------------------------
def fetch(name, url):
    p = os.path.join(CACHE, name)
    if os.path.exists(p) and os.path.getsize(p) > 0:
        return p
    film = os.path.join(FILM_CACHE, name)
    if os.path.exists(film) and os.path.getsize(film) > 0:
        shutil.copyfile(film, p)
        return p
    tmp = p + ".part"
    for attempt in range(3):
        r = subprocess.run(["curl", "-sSf", "-A", "SpillSight-hackathon/1.0", "-o", tmp, url], timeout=60)
        if r.returncode == 0:
            os.replace(tmp, p)
            time.sleep(0.05)  # polite, sequential
            return p
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"failed to fetch {url}")


def tile_range(x0, y0, w, h):
    return int(x0 // 256), int(y0 // 256), int((x0 + w - 1e-6) // 256), int((y0 + h - 1e-6) // 256)


def satellite_crop():
    """Full-res RGB crop, CROP_W x CROP_H, in zoom-11 pixel space."""
    tx0, ty0, tx1, ty1 = tile_range(X0, Y0, CROP_W, CROP_H)
    total = (tx1 - tx0 + 1) * (ty1 - ty0 + 1)
    print(f"sat: zoom {Z} tiles x {tx0}..{tx1}, y {ty0}..{ty1} ({total} tiles)")
    canvas = Image.new("RGB", ((tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256))
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            p = fetch(f"{Z}_{ty}_{tx}.jpg", SAT_URL.format(z=Z, y=ty, x=tx))
            canvas.paste(Image.open(p).convert("RGB"), ((tx - tx0) * 256, (ty - ty0) * 256))
    left, top = X0 - tx0 * 256, Y0 - ty0 * 256
    # crop with sub-pixel offset via affine transform (keeps exact alignment with x0/y0)
    return canvas.transform((CROP_W, CROP_H), Image.AFFINE, (1, 0, left, 0, 1, top), resample=Image.BILINEAR)


def elevation_crop():
    """Elevation in metres over the crop at terrarium zoom HZ (CROP_W/f x CROP_H/f), float32."""
    f = 2 ** (Z - HZ)
    x0, y0, cw, ch = X0 / f, Y0 / f, CROP_W // f, CROP_H // f
    tx0, ty0, tx1, ty1 = tile_range(x0, y0, cw, ch)
    print(f"terrain: zoom {HZ} tiles x {tx0}..{tx1}, y {ty0}..{ty1} ({(tx1-tx0+1)*(ty1-ty0+1)} tiles)")
    mosaic = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256), dtype=np.float32)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            p = fetch(f"terr_{HZ}_{ty}_{tx}.png", TERR_URL.format(z=HZ, x=tx, y=ty))
            a = np.asarray(Image.open(p).convert("RGBA")).astype(np.float32)
            h = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
            mosaic[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = h
    left, top = x0 - tx0 * 256, y0 - ty0 * 256
    img = Image.fromarray(mosaic, "F").transform((cw, ch), Image.AFFINE, (1, 0, left, 0, 1, top), resample=Image.BILINEAR)
    return np.asarray(img, dtype=np.float32)


# ---- Natural Earth land rings ---------------------------------------------------------------
def load_rings():
    if not os.path.exists(LAND_JSON):
        shutil.copyfile(os.path.join(FILM_BUILD, "land-10m.json"), LAND_JSON)
    topo = json.load(open(LAND_JSON))
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)

    def ring(idx):
        out = []
        for i in idx:
            pts = arcs[i] if i >= 0 else arcs[~i][::-1]
            out.extend(pts if not out else pts[1:])
        return out

    rings = []
    for geom in topo["objects"]["land"]["geometries"]:
        polys = geom["arcs"] if geom["type"] == "MultiPolygon" else [geom["arcs"]]
        for poly in polys:
            for k, r in enumerate(poly):
                rings.append((k > 0, ring(r)))  # (is_hole, points)
    return rings


def land_raster(w, h):
    """Natural Earth land rasterised over the crop at w x h (bool, True = land)."""
    lon_min = X0 / N * 360 - 180
    lon_max = (X0 + CROP_W) / N * 360 - 180
    img = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(img)
    kx, ky = w / CROP_W, h / CROP_H
    for hole, r in load_rings():
        if not any(lon_min - 1 < lo < lon_max + 1 and 24 < la < 29 for lo, la in r):
            continue
        pts = []
        for lo, la in r:
            X, Y = world(lo, max(min(la, 85), -85), Z)
            pts.append(((X - X0) * kx, (Y - Y0) * ky))
        if len(pts) > 2:
            d.polygon(pts, fill=0 if hole else 255)
    return np.asarray(img) > 127


# ---- hillshade ------------------------------------------------------------------------------
def hillshade(elev, px_m, az=315.0, alt=45.0, z_factor=1.0):
    """Lambert shade of the surface normal against a sun at azimuth `az` (deg clockwise from north)."""
    gy, gx = np.gradient(elev * z_factor, px_m)   # gx: d/d east, gy: d/d south (rows go down)
    dz_de, dz_dn = gx, -gy
    norm = np.sqrt(dz_de ** 2 + dz_dn ** 2 + 1)
    a, b = math.radians(az), math.radians(alt)
    le, ln, lu = math.sin(a) * math.cos(b), math.cos(a) * math.cos(b), math.sin(b)
    hs = (-dz_de * le - dz_dn * ln + lu) / norm
    return np.clip(hs, 0, 1)


# ---- EOX no-data fill -----------------------------------------------------------------------
NODATA_RGB = (24, 44, 77)   # flat navy EOX uses offshore where Sentinel-2 has no scenes


def push_pull(chan, w):
    """Fill low-weight pixels from a weighted image pyramid (w in 0..1)."""
    h, wd = chan.shape
    if min(h, wd) <= 4 or w.min() > 0.999:
        return chan
    sz = (max(1, wd // 2), max(1, h // 2))
    num = np.asarray(Image.fromarray((chan * w).astype(np.float32), "F").resize(sz, Image.BOX))
    den = np.asarray(Image.fromarray(w.astype(np.float32), "F").resize(sz, Image.BOX))
    coarse = push_pull(np.where(den > 1e-6, num / np.maximum(den, 1e-6), 0), np.clip(den * 4, 0, 1))
    up = np.asarray(Image.fromarray(coarse.astype(np.float32), "F").resize((wd, h), Image.BILINEAR))
    return chan * w + up * (1 - w)


def fill_nodata(sat, sea_hi):
    """Replace the EOX flat no-data navy (only over sea) with colour pulled in from the surrounding sea."""
    a = np.asarray(sat, dtype=np.float32)
    nd = np.all(np.abs(a - np.array(NODATA_RGB, np.float32)) < 9, axis=-1) & sea_hi
    if not np.all(np.abs(a - np.array(NODATA_RGB, np.float32)) < 9, axis=-1).any():
        return sat, 0.0
    nd_img = Image.fromarray((nd * 255).astype(np.uint8), "L").filter(ImageFilter.MaxFilter(7))
    alpha = np.asarray(nd_img.filter(ImageFilter.GaussianBlur(4)), dtype=np.float32) / 255
    alpha = np.maximum(alpha, np.asarray(nd_img, dtype=np.float32) / 255)
    # work at 1/4 res: valid = real sea pixels, away from no-data
    small = (a.shape[1] // 4, a.shape[0] // 4)
    valid = np.asarray(Image.fromarray(((sea_hi & (alpha < 0.01)) * 255).astype(np.uint8)).resize(small, Image.BOX),
                       dtype=np.float32) / 255
    out = a.copy()
    for c in range(3):
        ch = np.asarray(Image.fromarray(a[..., c], "F").resize(small, Image.BOX))
        filled = push_pull(ch, valid)
        up = np.asarray(Image.fromarray(filled.astype(np.float32), "F").resize(sat.size, Image.BILINEAR))
        out[..., c] = a[..., c] * (1 - alpha) + up * alpha
    # no-data over land (EOX has no scenes for Abu Musa): paint median land colour, grain + hillshade added later
    ndl = np.all(np.abs(a - np.array(NODATA_RGB, np.float32)) < 9, axis=-1) & ~sea_hi
    if ndl.any():
        ndl_img = Image.fromarray((ndl * 255).astype(np.uint8), "L").filter(ImageFilter.MaxFilter(5))
        al = np.asarray(ndl_img.filter(ImageFilter.GaussianBlur(2)), dtype=np.float32) / 255
        al = np.maximum(al, np.asarray(ndl_img, dtype=np.float32) / 255) * (~sea_hi)
        land_rgb = np.median(a[~sea_hi & ~ndl][::97], axis=0) * 0.92
        out = out * (1 - al[..., None]) + land_rgb * al[..., None]
        alpha = np.maximum(alpha, al)
        print(f"EOX no-data over land: {ndl.sum()} px, painted {land_rgb.round()}")
    # a little grain so the patch doesn't read as flat paint
    rng = np.random.default_rng(7)
    out += (rng.normal(0, 1.6, a.shape[:2]).astype(np.float32) * alpha)[..., None]
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGB"), float(nd.mean())


def clean_mask(sea, px_km2):
    """Drop inland sea specks (< 2 km2, not touching the crop edge) and land specks (< 0.05 km2). Needs scipy."""
    try:
        from scipy import ndimage
    except ImportError:
        print("scipy missing: mask speck cleanup skipped")
        return sea
    sea = sea.copy()
    lab, n = ndimage.label(sea)
    sz = np.bincount(lab.ravel())
    edge = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    drop = (sz < 2.0 / px_km2)
    drop[0] = False
    drop[edge] = False
    sea[drop[lab]] = False
    lab, n = ndimage.label(~sea)
    sz = np.bincount(lab.ravel())
    drop = sz < 0.05 / px_km2
    drop[0] = False
    sea[drop[lab]] = True
    print(f"mask cleanup: sea comps {n}, removed specks")
    return sea


def main():
    os.makedirs(CACHE, exist_ok=True)
    os.makedirs(TEX, exist_ok=True)

    elev = elevation_crop()                       # CROP_W/2^(Z-HZ) x CROP_H/2^(Z-HZ)
    eh, ew = elev.shape
    # ---- sea mask: elevation <= 0 m, minus Natural Earth land interiors ----
    # NE 10m is coarse (it cuts across Musandam's fjords), so it only vetoes "sea" well inside its
    # land polygons (inland pits / sabkhas at or below 0 m); the coastline itself comes from the DEM.
    land_ne = land_raster(ew, eh)
    erode = max(3, int(round(1200 / (W_KM * 1000 / ew))) | 1)   # ~1.2 km
    land_core = np.asarray(Image.fromarray((land_ne * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(erode))) > 127
    sea = (elev <= 0) & ~land_core
    sea = clean_mask(sea, (W_KM * 1000 / ew) ** 2 / 1e6)
    mask_img = Image.fromarray((sea * 255).astype(np.uint8), "L")
    mask_img = mask_img.filter(ImageFilter.GaussianBlur(0.8)).resize(MASK_OUT, Image.LANCZOS)
    mask_img.save(os.path.join(TEX, "seamask.png"))

    # ---- height map: land only (anything flagged sea is 0) ----
    land_h = np.where(sea, 0.0, np.clip(elev, 0, None))
    h_small = np.asarray(Image.fromarray(land_h.astype(np.float32), "F").resize(HEIGHT_OUT, Image.BILINEAR))
    sea_small = np.asarray(Image.fromarray((sea * 255).astype(np.uint8)).resize(HEIGHT_OUT, Image.BILINEAR)) > 127
    hmax = float(np.percentile(land_h[~sea], 99.9))
    enc = np.where(~sea_small, np.clip(np.round(h_small / hmax * 254 + 1), 1, 255), 0).astype(np.uint8)
    Image.fromarray(enc, "L").save(os.path.join(TEX, "height.png"))

    # ---- satellite + baked hillshade ----
    sat = satellite_crop()
    sea_hi = np.asarray(Image.fromarray((sea * 255).astype(np.uint8)).resize((CROP_W, CROP_H), Image.NEAREST)) > 127
    sat, nd_frac = fill_nodata(sat, sea_hi)
    print(f"EOX no-data filled: {nd_frac*100:.2f}% of crop")
    # shade at sat resolution: upsample elevation (zoom10 -> zoom11 = 2x), smooth a touch
    px_m = (W_KM * 1000) / CROP_W                 # metres per zoom-11 px over the crop
    elev_hi = np.asarray(Image.fromarray(land_h.astype(np.float32), "F").resize((CROP_W, CROP_H), Image.BICUBIC))
    hs = hillshade(elev_hi, px_m, z_factor=2.0)
    flat = math.sin(math.radians(45.0))
    rel = hs / flat                               # 1.0 on flat ground
    land_soft = np.asarray(Image.fromarray(((~sea) * 255).astype(np.uint8)).resize((CROP_W, CROP_H), Image.BILINEAR)
                           .filter(ImageFilter.GaussianBlur(2)), dtype=np.float32) / 255
    strength = 0.75
    factor = 1 + strength * (np.clip(rel, 0.2, 1.45) - 1) * land_soft
    rgb = np.asarray(sat, dtype=np.float32) * factor[..., None]
    shaded = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), "RGB")
    shaded.resize(SAT_OUT, Image.LANCZOS).save(os.path.join(TEX, "sat.jpg"), quality=88, optimize=True)
    shaded.resize((1024, 512), Image.LANCZOS).save(os.path.join(TEX, "sat_small.jpg"), quality=85, optimize=True)

    region = {"Z": Z, "lon0": LON0, "lat0": LAT0, "crop_w": CROP_W, "crop_h": CROP_H,
              "x0": round(X0, 3), "y0": round(Y0, 3), "W": round(W_KM, 4), "H": round(H_KM, 4),
              "hmax_m": round(hmax, 1), "exag": EXAG}
    json.dump(region, open(os.path.join(ASSETS, "region.json"), "w"), indent=2)
    print(json.dumps(region))
    lon_min, lon_max = X0 / N * 360 - 180, (X0 + CROP_W) / N * 360 - 180

    def lat_of(Y):
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * Y / N))))
    print(f"bounds lon {lon_min:.4f}..{lon_max:.4f}  lat {lat_of(Y0 + CROP_H):.4f}..{lat_of(Y0):.4f}")
    print(f"sea fraction {sea.mean():.3f}")


if __name__ == "__main__":
    main()
