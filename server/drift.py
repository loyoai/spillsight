"""Simplified Lagrangian oil drift: surface current + 3% wind + random walk (K = 3 m^2/s).

Hourly steps, seeded RNG (same input -> same output), particles beach when a step
lands on Natural Earth 10m land.  Not OpenDrift; constant met-ocean over the run.
"""
import hashlib
import json
import math
import random

from geo import (KN_MS, centroid, destination, dist_point_segment_km, haversine_km,
                 land, pip_ring, polygon_area_km2)

WIND_FACTOR = 0.03
K_DIFF = 3.0          # m^2/s horizontal diffusivity
DT = 3600.0           # s
SITE_RADIUS_KM = 4.0
LANE_RADIUS_KM = 2.0
ASHORE_MARKS = (6, 12, 24, 48, 72)


def advective_velocity(met):
    """Return (u_east, v_north) in m/s from current + 3% wind (wind blows FROM wind_from_deg)."""
    c = met["current_kn"] * KN_MS
    ct = math.radians(met["current_to_deg"])
    w = met["wind_kn"] * KN_MS * WIND_FACTOR
    wt = math.radians((met["wind_from_deg"] + 180.0) % 360)
    return c * math.sin(ct) + w * math.sin(wt), c * math.cos(ct) + w * math.cos(wt)


def _seed(slick, hours, n, met):
    blob = json.dumps([[[round(x, 5) for x in p] for p in slick], hours, n,
                       [round(met[k], 3) for k in ("wind_kn", "wind_from_deg", "current_kn",
                                                    "current_to_deg")]])
    return int(hashlib.sha256(blob.encode()).hexdigest()[:12], 16)


def _move(p, de, dn):
    lat = p[1]
    return (p[0] + de / (111320.0 * math.cos(math.radians(lat))), lat + dn / 111320.0)


def _coast_point(L, a, b):
    """Bisect between a (water) and b (land) to approximate the coastline crossing."""
    lo, hi = a, b
    for _ in range(7):
        mid = ((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2)
        if L.is_land(*mid):
            hi = mid
        else:
            lo = mid
    return hi


def run(slick, hours, n, met, sites):
    L = land()
    hours = max(1, min(int(hours), 240))
    n = max(1, min(int(n), 2000))
    rng = random.Random(_seed(slick, hours, n, met))
    xs = [p[0] for p in slick]
    ys = [p[1] for p in slick]
    ring = [tuple(p) for p in slick]

    # Uniform seeding inside the slick polygon (rejection sampling), avoiding land.
    starts, tries = [], 0
    while len(starts) < n and tries < n * 200:
        tries += 1
        q = (rng.uniform(min(xs), max(xs)), rng.uniform(min(ys), max(ys)))
        if pip_ring(ring, *q) and not L.is_land(*q):
            starts.append(q)
    if not starts:  # degenerate polygon: start everything at the centroid
        starts = [tuple(centroid(slick))] * n
    while len(starts) < n:
        starts.append(starts[len(starts) % max(1, len(starts))])

    u, v = advective_velocity(met)
    sig = math.sqrt(2 * K_DIFF * DT)  # random-walk std per component per step, m
    tracks, beach_h = [], []
    for s in starts:
        p = s
        tr = [[round(p[0], 4), round(p[1], 4)]]
        bh = None
        for h in range(1, hours + 1):
            if bh is None:
                q = _move(p, u * DT + rng.gauss(0, sig), v * DT + rng.gauss(0, sig))
                if L.is_land(*q):
                    p = _coast_point(L, p, q)
                    bh = h
                else:
                    p = q
            tr.append([round(p[0], 4), round(p[1], 4)])
        tracks.append(tr)
        beach_h.append(bh)

    # Impacts: shore sites -> particles beaching within 4 km; lanes -> floating particles within 2 km.
    impacts = []
    for site in sites:
        if site.get("kind") == "lane":
            path = site["path"]
            eta, cnt = None, 0
            for tr, bh in zip(tracks, beach_h):
                last = len(tr) if bh is None else bh
                for h in range(0, last):
                    pt = tr[h]
                    if any(dist_point_segment_km(pt, path[i], path[i + 1]) <= LANE_RADIUS_KM
                           for i in range(len(path) - 1)):
                        cnt += 1
                        eta = h if eta is None else min(eta, h)
                        break
            if cnt:
                impacts.append({"site_id": site["id"], "eta_h": eta, "n": cnt})
            continue
        eta, cnt = None, 0
        for tr, bh in zip(tracks, beach_h):
            if bh is not None and haversine_km(tr[bh], site["lonlat"]) <= SITE_RADIUS_KM:
                cnt += 1
                eta = bh if eta is None else min(eta, bh)
        if cnt:
            impacts.append({"site_id": site["id"], "eta_h": eta, "n": cnt})
    impacts.sort(key=lambda r: (r["eta_h"], -r["n"]))

    beached = [b for b in beach_h if b is not None]
    speed_ms = math.hypot(u, v)
    c0 = centroid(slick)
    to_deg = (math.degrees(math.atan2(u, v)) + 360) % 360
    # Leading edge: slick vertex furthest along the drift direction.
    lead = max(slick, key=lambda p: (p[0] - c0[0]) * math.cos(math.radians(c0[1])) * u
               + (p[1] - c0[1]) * v)
    floating = [tr[-1] for tr, b in zip(tracks, beach_h) if b is None]
    stats = {
        "first_landfall_h": min(beached) if beached else None,
        "ashore_pct": {str(k): round(100.0 * sum(1 for b in beached if b <= k) / len(tracks), 1)
                       for k in ASHORE_MARKS},
        "drift_kn": round(speed_ms / KN_MS, 2),
        "drift_to_deg": round(to_deg, 0),
        "area_km2": round(polygon_area_km2(slick), 3),
        # extra fields (not in the contract, safe to ignore):
        "centroid_lonlat": [round(c0[0], 5), round(c0[1], 5)],
        "leading_edge_lonlat": [round(lead[0], 5), round(lead[1], 5)],
        "centroid_end_lonlat": ([round(sum(p[0] for p in floating) / len(floating), 4),
                                 round(sum(p[1] for p in floating) / len(floating), 4)]
                                if floating else None),
        "drift_km_24h": round(speed_ms * 86400 / 1000, 1),
    }
    return {"hours": hours, "particles": len(tracks), "tracks": tracks, "beach_h": beach_h,
            "stats": stats, "impacts": impacts,
            "model": "current + 3% wind + random walk K=3 m2/s, hourly, constant met-ocean",
            "metocean": met}
