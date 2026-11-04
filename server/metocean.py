"""Live met-ocean from Open-Meteo (forecast + marine APIs, no key), 10-minute cache."""
import datetime
import json
import threading
import time
import urllib.parse
import urllib.request

from common import SSL_CTX

DEFAULTS = {"wind_kn": 12.0, "wind_from_deg": 315.0, "current_kn": 0.8,
            "current_to_deg": 290.0, "wave_m": 0.8}
TTL_S = 600
_cache = {}
_lock = threading.Lock()


def _get(url, params, timeout=8):
    q = url + "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(q, timeout=timeout, context=SSL_CTX) as r:
        return json.loads(r.read().decode())


def _pick(hourly, key, stamp):
    times = hourly.get("time") or []
    vals = hourly.get(key) or []
    if stamp in times:
        v = vals[times.index(stamp)]
        if v is not None:
            return float(v)
    for v in vals:  # nearest non-null fallback
        if v is not None:
            return float(v)
    return None


def fetch(lon, lat):
    lon, lat = round(float(lon), 2), round(float(lat), 2)
    key = (lon, lat)
    now = time.time()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < TTL_S:
            return dict(hit[1])
    t = datetime.datetime.now(datetime.timezone.utc).replace(minute=0, second=0, microsecond=0)
    stamp = t.strftime("%Y-%m-%dT%H:00")
    out = dict(DEFAULTS)
    got, missing = [], []
    common = {"latitude": lat, "longitude": lon, "timezone": "GMT", "forecast_days": 2}
    try:
        w = _get("https://api.open-meteo.com/v1/forecast",
                 {**common, "hourly": "wind_speed_10m,wind_direction_10m", "wind_speed_unit": "kn"})
        h = w.get("hourly", {})
        ws, wd = _pick(h, "wind_speed_10m", stamp), _pick(h, "wind_direction_10m", stamp)
        if ws is not None and wd is not None:
            out["wind_kn"], out["wind_from_deg"] = round(ws, 1), round(wd, 0)
            got.append("wind")
    except Exception:
        pass
    try:
        m = _get("https://marine-api.open-meteo.com/v1/marine",
                 {**common, "hourly": "ocean_current_velocity,ocean_current_direction,wave_height"})
        h = m.get("hourly", {})
        cv, cd = _pick(h, "ocean_current_velocity", stamp), _pick(h, "ocean_current_direction", stamp)
        wv = _pick(h, "wave_height", stamp)
        if cv is not None and cd is not None:
            out["current_kn"], out["current_to_deg"] = round(cv / 1.852, 2), round(cd, 0)  # km/h -> kn
            got.append("current")
        if wv is not None:
            out["wave_m"] = round(wv, 2)
            got.append("wave")
    except Exception:
        pass
    missing = [k for k in ("wind", "current", "wave") if k not in got]
    out["source"] = "open-meteo" if got else "default"
    out["time"] = t.strftime("%Y-%m-%dT%H:00Z")
    out["defaulted"] = missing  # extra field: which parts fell back to defaults
    out["lonlat"] = [lon, lat]
    with _lock:
        _cache[key] = (now, out)
    return dict(out)


def normalise(m):
    """Fill a client-supplied metocean dict with defaults and coerce numbers."""
    m = dict(m or {})
    for k, v in DEFAULTS.items():
        try:
            m[k] = float(m.get(k, v))
        except (TypeError, ValueError):
            m[k] = v
    return m
