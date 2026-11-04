"""SpillSight server: static web/ + JSON API on http://127.0.0.1:8787 (see CONTRACT.md)."""
import base64
import json
import mimetypes
import os
import shutil
import sys
import threading
import traceback
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import common  # noqa: E402
import drift  # noqa: E402
import metocean  # noqa: E402
import planner  # noqa: E402
import sam  # noqa: E402
from geo import centroid, ellipse  # noqa: E402

PORT = int(os.environ.get("PORT", 8787))
SITES_PATH = os.path.join(common.DATA, "sites.json")
RES_PATH = os.path.join(common.DATA, "resources.json")
RES_SEED = os.path.join(common.DATA, "resources.seed.json")
SAMPLE_PATH = os.path.join(common.DATA, "sample_detect.json")
RES_TYPES = {"vessel", "boom", "skimmer", "storage", "drone", "aircraft"}
RES_STATUS = {"ready", "busy", "maintenance"}
DEFAULT_CENTER = [56.52, 26.47]
_res_lock = threading.Lock()

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("model/gltf-binary", ".glb")
mimetypes.add_type("application/wasm", ".wasm")


def load_sites():
    return json.load(open(SITES_PATH))


def load_resources():
    with _res_lock:
        if not os.path.exists(RES_PATH):
            shutil.copyfile(RES_SEED, RES_PATH)
        return json.load(open(RES_PATH))


def save_resources(items):
    with _res_lock:
        tmp = RES_PATH + ".tmp"
        json.dump(items, open(tmp, "w"), indent=1)
        os.replace(tmp, RES_PATH)


def default_slick():
    return ellipse(DEFAULT_CENTER, 2.0, 0.8, 60)


def sample_footprint(w, h, center=DEFAULT_CENTER, width_km=6.0):
    import math
    hw = width_km / 2
    hh = width_km * h / w / 2
    dlon = hw / (111.32 * math.cos(math.radians(center[1])))
    dlat = hh / 110.574
    lon, lat = center
    return [[round(lon - dlon, 5), round(lat + dlat, 5)], [round(lon + dlon, 5), round(lat + dlat, 5)],
            [round(lon + dlon, 5), round(lat - dlat, 5)], [round(lon - dlon, 5), round(lat - dlat, 5)]]


class Handler(SimpleHTTPRequestHandler):
    server_version = "SpillSight/0.1"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=common.WEB, **kw)

    def log_message(self, fmt, *args):  # quiet; never logs bodies or headers
        sys.stderr.write("%s %s\n" % (self.command, self.path.split("?")[0]))

    # ---------- helpers
    def send_json(self, obj, status=200):
        b = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return {}
        raw = self.rfile.read(n)
        return json.loads(raw.decode() or "{}")

    def route(self):
        return urllib.parse.urlparse(self.path)

    # ---------- GET
    def do_GET(self):
        u = self.route()
        p = u.path
        try:
            if p == "/api/health":
                return self.send_json({"ok": True, "meta_key": common.has_key(),
                                       "spent_usd": round(common.ledger_total(), 6),
                                       "cap_usd": common.CAP_USD})
            if p == "/api/sites":
                return self.send_json(load_sites())
            if p == "/api/resources":
                return self.send_json(load_resources())
            if p == "/api/metocean":
                q = urllib.parse.parse_qs(u.query)
                lon = float(q.get("lon", [DEFAULT_CENTER[0]])[0])
                lat = float(q.get("lat", [DEFAULT_CENTER[1]])[0])
                return self.send_json(metocean.fetch(lon, lat))
            if p == "/api/ledger":
                L = common.ledger_load()
                return self.send_json({"total_usd": L.get("total_usd", 0.0), "cap_usd": common.CAP_USD,
                                       "remaining_usd": round(common.CAP_USD - L.get("total_usd", 0.0), 6),
                                       "entries": L.get("calls", [])})
            if p.startswith("/api/"):
                return self.send_json({"ok": False, "error": "not found"}, 404)
        except Exception as e:
            traceback.print_exc()
            return self.send_json({"ok": False, "error": f"{type(e).__name__}: {e}"}, 500)
        return super().do_GET()

    # ---------- POST
    def do_POST(self):
        p = self.route().path
        try:
            b = self.body()
        except ValueError:
            return self.send_json({"ok": False, "error": "invalid JSON body"}, 400)
        try:
            if p == "/api/resources":
                return self.post_resource(b)
            if p == "/api/detect/sample":
                return self.send_json(self.sample_detect(b))
            if p == "/api/detect":
                img_b64 = b.get("image_b64") or ""
                if "," in img_b64[:80] and img_b64.startswith("data:"):
                    img_b64 = img_b64.split(",", 1)[1]
                try:
                    img = base64.b64decode(img_b64)
                    sam.image_info(img)
                except Exception:
                    return self.send_json({"ok": False, "error": "image_b64 must be a base64 PNG or JPEG"}, 400)
                out = sam.detect(img, b.get("prompt") or "rainbow sheen", b.get("points"), b.get("footprint"))
                return self.send_json(out, 200 if out.get("ok") else 502)
            if p == "/api/forecast":
                return self.send_json(self.forecast(b))
            if p == "/api/plan":
                sites = {s["id"]: s for s in load_sites()}
                res = b.get("resources") or load_resources()
                return self.send_json(planner.plan(b, res, sites))
            return self.send_json({"ok": False, "error": "not found"}, 404)
        except Exception as e:
            traceback.print_exc()
            return self.send_json({"ok": False, "error": f"{type(e).__name__}: {e}"}, 500)

    def do_DELETE(self):
        p = self.route().path
        if p.startswith("/api/resources/"):
            rid = urllib.parse.unquote(p.rsplit("/", 1)[1])
            items = load_resources()
            keep = [r for r in items if r.get("id") != rid]
            if len(keep) == len(items):
                return self.send_json({"ok": False, "error": "no such resource"}, 404)
            save_resources(keep)
            return self.send_json({"ok": True, "deleted": rid})
        return self.send_json({"ok": False, "error": "not found"}, 404)

    # ---------- endpoint bodies
    def post_resource(self, b):
        if b.get("type") not in RES_TYPES:
            return self.send_json({"ok": False, "error": f"type must be one of {sorted(RES_TYPES)}"}, 400)
        ll = b.get("lonlat")
        if not (isinstance(ll, list) and len(ll) == 2):
            return self.send_json({"ok": False, "error": "lonlat [lon, lat] required"}, 400)
        items = load_resources()
        prefix = b["type"][:2]
        n = 1
        while any(r["id"] == f"{prefix}-user-{n}" for r in items):
            n += 1

        def num(k, d=0):
            try:
                return float(b.get(k, d) or 0)
            except (TypeError, ValueError):
                return d
        r = {"id": f"{prefix}-user-{n}", "type": b["type"],
             "name": str(b.get("name") or f"{b['type'].title()} {n}")[:80],
             "base": str(b.get("base") or "")[:60],
             "lonlat": [float(ll[0]), float(ll[1])],
             "speed_kn": num("speed_kn", 8), "boom_m": num("boom_m"), "skimmer_m3h": num("skimmer_m3h"),
             "storage_m3": num("storage_m3"), "crew": int(num("crew")),
             "status": b.get("status") if b.get("status") in RES_STATUS else "ready",
             "sample": bool(b.get("sample", False))}
        items.append(r)
        save_resources(items)
        return self.send_json(r)

    def forecast(self, b):
        slick = b.get("slick") or default_slick()
        slick = [[float(p[0]), float(p[1])] for p in slick]
        met = b.get("metocean")
        if not met:
            c = centroid(slick)
            met = metocean.fetch(c[0], c[1])
        met = metocean.normalise(met)
        return drift.run(slick, b.get("hours", 72), b.get("n", 300), met, load_sites())

    def sample_detect(self, b):
        s = json.load(open(SAMPLE_PATH))
        w, h = s["image_size"]
        fp = b.get("footprint") or sample_footprint(w, h)
        if "insts" not in _sample_cache:
            _sample_cache["insts"] = sam.parse_text(common.output_text(s["response"]), w, h)
        insts = [dict(i) for i in _sample_cache["insts"]]
        for i in insts:
            i["polygon_lonlat"] = [sam.footprint_lonlat(pt, w, h, fp) for pt in i["polygon"]]
        return {"ok": True, "model": "sam-3.1", "instances": insts, "image_size": [w, h],
                "cost_usd": 0.0, "cached": True, "prompt": s.get("prompt"), "footprint": fp,
                "image_url": "assets/img/sample_sar.jpg",
                "label": "Simulated SAR image (AI-generated, not real satellite data)",
                "recorded": s.get("time")}


_sample_cache = {}


def _warm():
    try:  # pre-decode the bundled sample masks (~2.5 s pure Python) so the first request is fast
        s = json.load(open(SAMPLE_PATH))
        w, h = s["image_size"]
        _sample_cache["insts"] = sam.parse_text(common.output_text(s["response"]), w, h)
    except Exception:
        pass


def main():
    load_resources()
    threading.Thread(target=_warm, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"SpillSight on http://127.0.0.1:{PORT}  (meta key: {'yes' if common.has_key() else 'no'})",
          flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
