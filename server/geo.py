"""Geometry helpers: haversine, bearings, point-in-polygon, land mask."""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(HERE), "data")
R_EARTH_KM = 6371.0088
KN_MS = 0.514444  # 1 knot in m/s
NM_KM = 1.852


def haversine_km(a, b):
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * R_EARTH_KM * math.asin(min(1.0, math.sqrt(h)))


def bearing_deg(a, b):
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    y = math.sin(lon2 - lon1) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(lon2 - lon1)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def offset(lonlat, east_m, north_m):
    """Move a point by metres east/north (local flat-earth approximation)."""
    lon, lat = lonlat
    dlat = north_m / 111320.0
    dlon = east_m / (111320.0 * math.cos(math.radians(lat)))
    return [lon + dlon, lat + dlat]


def destination(lonlat, bearing, dist_km):
    b = math.radians(bearing)
    return offset(lonlat, math.sin(b) * dist_km * 1000, math.cos(b) * dist_km * 1000)


def pip_ring(ring, lon, lat):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def polygon_area_km2(poly):
    if len(poly) < 3:
        return 0.0
    lat0 = sum(p[1] for p in poly) / len(poly)
    kx = 111.32 * math.cos(math.radians(lat0))
    ky = 110.574
    s = 0.0
    for i in range(len(poly)):
        x1, y1 = poly[i][0] * kx, poly[i][1] * ky
        x2, y2 = poly[(i + 1) % len(poly)][0] * kx, poly[(i + 1) % len(poly)][1] * ky
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


def centroid(poly):
    return [sum(p[0] for p in poly) / len(poly), sum(p[1] for p in poly) / len(poly)]


def dist_point_segment_km(p, a, b):
    """Approximate distance from p to segment ab (local equirectangular)."""
    k = math.cos(math.radians(p[1]))
    ax, ay = (a[0] - p[0]) * k * 111.32, (a[1] - p[1]) * 110.574
    bx, by = (b[0] - p[0]) * k * 111.32, (b[1] - p[1]) * 110.574
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = 0.0 if L == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / L))
    cx, cy = ax + t * dx, ay + t * dy
    return math.hypot(cx, cy)


def ellipse(center, major_km, minor_km, axis_deg, n=36):
    """Ellipse polygon; axis_deg is the compass bearing of the long axis."""
    a, b = major_km / 2, minor_km / 2
    th = math.radians(axis_deg)
    out = []
    for i in range(n):
        t = 2 * math.pi * i / n
        u, v = a * math.cos(t), b * math.sin(t)  # u along axis, v across
        east = u * math.sin(th) + v * math.cos(th)
        north = u * math.cos(th) - v * math.sin(th)
        out.append([round(c, 5) for c in offset(center, east * 1000, north * 1000)])
    return out


class Land:
    """Even-odd point-in-polygon over the cropped Natural Earth rings with bbox prefilter."""

    def __init__(self, path=os.path.join(DATA, "land.json")):
        doc = json.load(open(path))
        self.rings = []
        for r in doc["rings"]:
            xs = [p[0] for p in r]
            ys = [p[1] for p in r]
            self.rings.append((min(xs), min(ys), max(xs), max(ys), [tuple(p) for p in r]))

    def is_land(self, lon, lat):
        inside = False
        for x0, y0, x1, y1, ring in self.rings:
            if x0 <= lon <= x1 and y0 <= lat <= y1 and pip_ring(ring, lon, lat):
                inside = not inside
        return inside


_land = None


def land():
    global _land
    if _land is None:
        _land = Land()
    return _land
