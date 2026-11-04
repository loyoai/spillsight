"""One-off build step: writes data/land.json, data/sites.json, data/resources.seed.json.

land.json is cropped from Natural Earth 10m land (via film/build/geo.py) so the
server has no runtime dependency on film/.  Run: python3 tools/build_data.py
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")
FILM_BUILD = os.path.join(os.path.dirname(ROOT), "film", "build")

BBOX = (54.5, 25.2, 58.2, 27.8)  # lon0, lat0, lon1, lat1


def clip_ring(ring, bbox):
    """Sutherland-Hodgman clip of a ring against an axis-aligned box."""
    x0, y0, x1, y1 = bbox
    edges = [
        (lambda p: p[0] >= x0, lambda a, b: (x0, a[1] + (b[1] - a[1]) * (x0 - a[0]) / (b[0] - a[0]))),
        (lambda p: p[0] <= x1, lambda a, b: (x1, a[1] + (b[1] - a[1]) * (x1 - a[0]) / (b[0] - a[0]))),
        (lambda p: p[1] >= y0, lambda a, b: (a[0] + (b[0] - a[0]) * (y0 - a[1]) / (b[1] - a[1]), y0)),
        (lambda p: p[1] <= y1, lambda a, b: (a[0] + (b[0] - a[0]) * (y1 - a[1]) / (b[1] - a[1]), y1)),
    ]
    out = list(ring)
    for inside, inter in edges:
        if not out:
            break
        inp, out = out, []
        prev = inp[-1]
        for cur in inp:
            if inside(cur):
                if not inside(prev):
                    out.append(inter(prev, cur))
                out.append(cur)
            elif inside(prev):
                out.append(inter(prev, cur))
            prev = cur
    return out


def build_land():
    sys.path.insert(0, FILM_BUILD)
    from geo import _load_rings  # noqa: E402
    rings = _load_rings("10m")
    pad = 0.05
    box = (BBOX[0] - pad, BBOX[1] - pad, BBOX[2] + pad, BBOX[3] + pad)
    out = []
    for r in rings:
        xs = [p[0] for p in r]
        ys = [p[1] for p in r]
        if max(xs) < box[0] or min(xs) > box[2] or max(ys) < box[1] or min(ys) > box[3]:
            continue
        c = clip_ring(r, box)
        if len(c) >= 3:
            out.append([[round(x, 5), round(y, 5)] for x, y in c])
    doc = {"source": "Natural Earth 10m land (public domain), cropped",
           "bbox": list(BBOX), "rule": "even-odd over all rings", "rings": out}
    with open(os.path.join(DATA, "land.json"), "w") as f:
        json.dump(doc, f, separators=(",", ":"))
    print(f"land.json: {len(out)} rings, {sum(len(r) for r in out)} points")
    return out


def pip(rings, lon, lat):
    inside = False
    for r in rings:
        n = len(r)
        j = n - 1
        for i in range(n):
            xi, yi = r[i]
            xj, yj = r[j]
            if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
                inside = not inside
            j = i
    return inside


SITES = [
    ("bandar_abbas_port", "Bandar Abbas port", "port", 56.21, 27.14, "Iran",
     "Major commercial port on the northern shore of the strait."),
    ("bandar_abbas_desal", "Bandar Abbas desalination intake", "intake", 56.35, 27.17, "Iran",
     "Seawater intake for municipal desalination; intakes are sensitive to floating oil."),
    ("qeshm_desal", "Qeshm desalination intake", "intake", 56.27, 26.95, "Iran",
     "Seawater intake on Qeshm Island."),
    ("hara_mangrove", "Hara mangrove protected area", "mangrove", 55.73, 26.85, "Iran",
     "Grey mangrove (Avicennia marina) forest between Qeshm and the mainland; protected area."),
    ("hormuz_island", "Hormuz Island coast", "coast", 56.46, 27.06, "Iran",
     "Island shoreline east of Bandar Abbas."),
    ("larak_island", "Larak Island coast", "coast", 56.36, 26.86, "Iran",
     "Island shoreline close to the shipping lanes."),
    ("khasab_port", "Khasab port", "port", 56.25, 26.20, "Oman",
     "Main port of the Musandam peninsula."),
    ("khasab_desal", "Khasab desalination intake", "intake", 56.24, 26.19, "Oman",
     "Seawater intake serving Khasab."),
    ("khor_sham_coral", "Khor Sham coral reefs", "coral", 56.33, 26.21, "Oman",
     "Fjord-like inlet with fringing coral communities."),
    ("kumzar", "Kumzar village coast", "town", 56.40, 26.33, "Oman",
     "Coastal village near the tip of the Musandam peninsula, reached by sea."),
    ("rak_desal", "Ras Al Khaimah desalination intake", "intake", 55.94, 25.79, "UAE",
     "Seawater intake on the Ras Al Khaimah coast."),
    ("saqr_port", "Saqr port", "port", 56.05, 25.98, "UAE",
     "Bulk and container port north of Ras Al Khaimah."),
]

LANES = [
    ("tss_inbound", "Traffic separation scheme, inbound lane",
     [[56.90, 26.27], [56.72, 26.44], [56.55, 26.60], [56.38, 26.62], [56.20, 26.56],
      [56.05, 26.48], [55.90, 26.42]],
     "Approximate centreline of the westbound (inbound) lane; for orientation only."),
    ("tss_outbound", "Traffic separation scheme, outbound lane",
     [[55.90, 26.33], [56.05, 26.39], [56.20, 26.46], [56.36, 26.52], [56.50, 26.52],
      [56.66, 26.38], [56.90, 26.19]],
     "Approximate centreline of the eastbound (outbound) lane; for orientation only."),
]

RESOURCES = [
    # id, type, name, base, lon, lat, speed_kn, boom_m, skimmer_m3h, storage_m3, crew
    ("rv-bnd-1", "vessel", "Bandar Abbas Response Vessel 1", "Bandar Abbas", 56.22, 27.12, 12, 0, 0, 40, 8),
    ("rv-bnd-2", "vessel", "Bandar Abbas Response Vessel 2", "Bandar Abbas", 56.23, 27.12, 10, 0, 0, 30, 6),
    ("rv-qsm-1", "vessel", "Qeshm Response Vessel 1", "Qeshm", 56.28, 26.93, 14, 0, 0, 20, 6),
    ("rv-ksb-1", "vessel", "Khasab Response Vessel 1", "Khasab", 56.26, 26.21, 13, 0, 0, 30, 7),
    ("rv-sqr-1", "vessel", "Saqr Port Response Vessel 1", "Saqr port", 56.06, 25.99, 11, 0, 0, 50, 8),
    ("bm-bnd-1", "boom", "Bandar Abbas Boom Unit 1", "Bandar Abbas", 56.21, 27.13, 8, 800, 0, 0, 4),
    ("bm-ksb-1", "boom", "Khasab Boom Unit 1", "Khasab", 56.25, 26.21, 8, 500, 0, 0, 4),
    ("bm-sqr-1", "boom", "Saqr Port Boom Unit 1", "Saqr port", 56.05, 25.99, 8, 300, 0, 0, 3),
    ("sk-qsm-1", "skimmer", "Qeshm Skimmer Unit 1", "Qeshm", 56.28, 26.94, 8, 0, 50, 0, 3),
    ("sk-ksb-1", "skimmer", "Khasab Skimmer Unit 1", "Khasab", 56.25, 26.20, 8, 0, 30, 0, 3),
    ("st-bnd-1", "storage", "Bandar Abbas Storage Barge 1", "Bandar Abbas", 56.20, 27.13, 6, 0, 0, 1200, 5),
    ("dr-ksb-1", "drone", "Khasab Survey Drone 1", "Khasab", 56.25, 26.20, 45, 0, 0, 0, 2),
    ("dr-qsm-1", "drone", "Qeshm Survey Drone 1", "Qeshm", 56.27, 26.95, 45, 0, 0, 0, 2),
]


def build_sites(rings):
    sites = []
    for sid, name, kind, lon, lat, country, note in SITES:
        sites.append({"id": sid, "name": name, "kind": kind, "lonlat": [lon, lat],
                      "country": country, "note": note, "approx": True})
        print(f"  {sid:20s} on_land={pip(rings, lon, lat)}")
    for sid, name, path, note in LANES:
        wet = [not pip(rings, x, y) for x, y in path]
        print(f"  {sid:20s} all_in_water={all(wet)} {wet}")
        sites.append({"id": sid, "name": name, "kind": "lane", "path": path,
                      "country": None, "note": note, "approx": True})
    with open(os.path.join(DATA, "sites.json"), "w") as f:
        json.dump(sites, f, indent=1)
    print(f"sites.json: {len(sites)} items; default slick centre on land="
          f"{pip(rings, 56.52, 26.47)}")


def build_resources():
    res = []
    for rid, typ, name, base, lon, lat, spd, boom, sk, st, crew in RESOURCES:
        res.append({"id": rid, "type": typ, "name": name, "base": base, "lonlat": [lon, lat],
                    "speed_kn": spd, "boom_m": boom, "skimmer_m3h": sk, "storage_m3": st,
                    "crew": crew, "status": "ready", "sample": True})
    with open(os.path.join(DATA, "resources.seed.json"), "w") as f:
        json.dump(res, f, indent=1)
    print(f"resources.seed.json: {len(res)} sample resources")


if __name__ == "__main__":
    os.makedirs(DATA, exist_ok=True)
    rings = build_land()
    build_sites(rings)
    build_resources()
