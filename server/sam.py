"""SAM 3.1 image segmentation via the Meta Responses API + mask -> polygon decoding.

Uses the vendored pure-Python meta_sam_parser (server/vendor, SAM License) to decode
`<|box;...|><|mask;...;data=...|>` tokens, then traces the mask outline
(marching squares), keeps the largest ring and simplifies it to <= 120 points.
"""
import base64
import hashlib
import json
import os
import struct
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "vendor"))
from meta_sam_parser import (CompletedOutcome, decode_mask_to_raster,  # noqa: E402
                             image_segmentation_format)

import common  # noqa: E402

MAX_POLY = 120
TRACE_MAX = 256  # downsample masks to at most this many cells per side before tracing


# ---------- image header sniffing (no PIL needed) ----------
def image_info(b):
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        w, h = struct.unpack(">II", b[16:24])
        return "image/png", w, h
    if b[:2] == b"\xff\xd8":
        i = 2
        while i < len(b) - 9:
            if b[i] != 0xFF:
                i += 1
                continue
            marker = b[i + 1]
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                h, w = struct.unpack(">HH", b[i + 5:i + 9])
                return "image/jpeg", w, h
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                i += 2
                continue
            seg = struct.unpack(">H", b[i + 2:i + 4])[0]
            i += 2 + seg
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        try:
            from PIL import Image
            import io
            im = Image.open(io.BytesIO(b))
            return "image/webp", im.size[0], im.size[1]
        except Exception:
            pass
    raise ValueError("unsupported image (send PNG or JPEG)")


# ---------- polygon helpers ----------
def _trace_largest(raster, w, h):
    """Marching squares on a row-major 0/1 raster; return the largest closed ring (cell coords)."""
    def px(r, c):
        return raster[r * w + c] if 0 <= r < h and 0 <= c < w else 0

    segs = []
    for r in range(h + 1):
        for c in range(w + 1):
            tl, tr, bl, br = px(r - 1, c - 1), px(r - 1, c), px(r, c - 1), px(r, c)
            idx = (tl << 3) | (tr << 2) | (br << 1) | bl
            if idx in (0, 15):
                continue
            top, bottom = (c - 0.5, r - 1.0), (c - 0.5, float(r))
            left, right = (c - 1.0, r - 0.5), (float(c), r - 0.5)
            table = {1: [(left, bottom)], 14: [(left, bottom)], 2: [(bottom, right)],
                     13: [(bottom, right)], 3: [(left, right)], 12: [(left, right)],
                     4: [(top, right)], 11: [(top, right)], 5: [(left, top), (bottom, right)],
                     6: [(top, bottom)], 9: [(top, bottom)], 7: [(left, top)], 8: [(left, top)],
                     10: [(top, right), (left, bottom)]}
            segs.extend(table[idx])
    adj = {}
    for a, b in segs:
        adj.setdefault(a, []).append(b)
        adj.setdefault(b, []).append(a)
    seen, rings = set(), []
    for start in list(adj):
        if start in seen:
            continue
        ring, prev, cur = [], None, start
        while True:
            ring.append(cur)
            seen.add(cur)
            nxt = next((q for q in adj[cur] if q != prev and q not in seen), None)
            if nxt is None:
                break
            prev, cur = cur, nxt
        if len(ring) >= 3:
            rings.append(ring)
    if not rings:
        return []

    def area(rg):
        return abs(sum(rg[i][0] * rg[(i + 1) % len(rg)][1] - rg[(i + 1) % len(rg)][0] * rg[i][1]
                       for i in range(len(rg)))) / 2
    return max(rings, key=area)


def _rdp(pts, eps):
    if len(pts) < 3:
        return pts
    stack, keep = [(0, len(pts) - 1)], {0, len(pts) - 1}
    while stack:
        i, j = stack.pop()
        ax, ay = pts[i]
        bx, by = pts[j]
        dx, dy = bx - ax, by - ay
        L = (dx * dx + dy * dy) ** 0.5 or 1e-9
        best, bi = -1, None
        for k in range(i + 1, j):
            d = abs(dy * pts[k][0] - dx * pts[k][1] + bx * ay - by * ax) / L
            if d > best:
                best, bi = d, k
        if bi is not None and best > eps:
            keep.add(bi)
            stack += [(i, bi), (bi, j)]
    return [pts[k] for k in sorted(keep)]


def simplify(ring, max_pts=MAX_POLY):
    if len(ring) <= max_pts:
        return ring
    eps = 0.5
    out = ring
    for _ in range(30):
        out = _rdp(ring, eps)
        if len(out) <= max_pts:
            break
        eps *= 1.5
    if len(out) > max_pts:  # hard cap by striding
        step = len(out) / max_pts
        out = [out[int(i * step)] for i in range(max_pts)]
    return out


def mask_polygon(mrec, img_w, img_h):
    """Decode one mask record to an image-pixel polygon (<= MAX_POLY points)."""
    mk = mrec.mask
    raster = decode_mask_to_raster(mk)
    mw, mh = int(mk.width), int(mk.height)
    # Downsample (block OR) so tracing stays fast in pure Python.
    f = max(1, -(-max(mw, mh) // TRACE_MAX))
    if f > 1:
        sw, sh = -(-mw // f), -(-mh // f)
        small = bytearray(sw * sh)
        for r in range(mh):
            row = raster[r * mw:(r + 1) * mw]
            base = (r // f) * sw
            for c in range(mw):
                if row[c]:
                    small[base + c // f] = 1
        raster, mw2, mh2 = small, sw, sh
    else:
        mw2, mh2 = mw, mh
    ring = _trace_largest(raster, mw2, mh2)
    if not ring:
        return []
    b = mrec.bounds
    sx = (b.right - b.left) / mw2
    sy = (b.bottom - b.top) / mh2
    poly = [((x + 0.5) * sx + b.left, (y + 0.5) * sy + b.top) for x, y in ring]
    poly = simplify(poly)
    return [[round(min(max(x, 0), img_w), 1), round(min(max(y, 0), img_h), 1)] for x, y in poly]


def footprint_lonlat(pt, w, h, fp):
    """Bilinear map from image px to lon/lat; fp = [TL, TR, BR, BL] as [lon, lat]."""
    u, v = pt[0] / w, pt[1] / h
    tl, tr, br, bl = fp
    lon = tl[0] * (1 - u) * (1 - v) + tr[0] * u * (1 - v) + br[0] * u * v + bl[0] * (1 - u) * v
    lat = tl[1] * (1 - u) * (1 - v) + tr[1] * u * (1 - v) + br[1] * u * v + bl[1] * (1 - u) * v
    return [round(lon, 5), round(lat, 5)]


def parse_text(text, img_w, img_h):
    p = image_segmentation_format().create_parser()
    p.push(text)
    res = p.finish(CompletedOutcome()).result
    boxes = {r.object_id: r for r in res.records if r.kind == "box"}
    insts = []
    for m in (r for r in res.records if r.kind == "mask"):
        b = boxes.get(m.object_id)
        score = (b.confidence if b and b.confidence is not None else m.confidence)
        box = ([b.left, b.top, b.right, b.bottom] if b else
               [m.bounds.left, m.bounds.top, m.bounds.right, m.bounds.bottom])
        try:
            poly = mask_polygon(m, img_w, img_h)
        except Exception:
            poly = []
        if len(poly) < 3:  # fall back to the box outline
            poly = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]]
        insts.append({"score": round(score, 4) if score is not None else None,
                      "box": [round(v, 1) for v in box], "polygon": poly})
    # boxes without masks
    masked = {m.object_id for m in res.records if m.kind == "mask"}
    for oid, b in boxes.items():
        if oid not in masked:
            box = [b.left, b.top, b.right, b.bottom]
            insts.append({"score": b.confidence, "box": box, "polygon":
                          [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]]})
    insts.sort(key=lambda i: -(i["score"] or 0))
    return insts


def point_prompt(points, w, h):
    toks = "".join(f"<|point;x={min(w - 1, max(0, int(x)))};y={min(h - 1, max(0, int(y)))};w={w};h={h}|>"
                   for x, y in points)
    return f"<0f>1{toks}"


def build_request(img_bytes, mime, prompt_text):
    data_url = f"data:{mime};base64," + base64.b64encode(img_bytes).decode()
    return {"model": "sam-3.1", "stream": False,
            "input": [{"type": "message", "role": "user", "content": [
                {"type": "input_text", "text": prompt_text},
                {"type": "input_image", "image_url": data_url}]}],
            "metadata": {"include_confidence": "true"}}


def detect(img_bytes, prompt="rainbow sheen", points=None, footprint=None, label="spillsight detect"):
    mime, w, h = image_info(img_bytes)
    text_prompt = point_prompt(points, w, h) if points else (prompt or "rainbow sheen")
    key = hashlib.sha256(img_bytes + b"|" + text_prompt.encode()).hexdigest()[:24]
    cpath = os.path.join(common.CACHE, f"sam_{key}.json")
    cached = False
    if os.path.exists(cpath):
        raw = json.load(open(cpath))
        cached, cost, status = True, 0.0, 200
    else:
        if not common.has_key():
            return {"ok": False, "error": "no META_API_KEY configured", "model": "sam-3.1",
                    "instances": [], "image_size": [w, h], "cost_usd": 0.0, "cached": False}
        if not common.budget_allows(common.SAM_COST):
            return {"ok": False, "error": f"spending cap ${common.CAP_USD:.2f} reached",
                    "model": "sam-3.1", "instances": [], "image_size": [w, h],
                    "cost_usd": 0.0, "cached": False}
        t0 = time.time()
        status, raw, err = common.meta_post("/responses", build_request(img_bytes, mime, text_prompt), 180)
        ok = status == 200 and raw is not None
        cost = common.SAM_COST if ok else 0.0
        common.ledger_add("sam-3.1", "/v1/responses", f"{label} :: {text_prompt}"[:200], cost, status,
                          f"spillsight server; {w}x{h}; {time.time() - t0:.1f}s")
        if not ok:
            return {"ok": False, "error": f"SAM HTTP {status}: {err[:200]}", "model": "sam-3.1",
                    "instances": [], "image_size": [w, h], "cost_usd": cost, "cached": False}
        os.makedirs(common.CACHE, exist_ok=True)
        json.dump(raw, open(cpath, "w"))
    insts = parse_text(common.output_text(raw), w, h)
    if footprint and len(footprint) == 4:
        for i in insts:
            i["polygon_lonlat"] = [footprint_lonlat(p, w, h, footprint) for p in i["polygon"]]
    return {"ok": True, "model": "sam-3.1", "instances": insts, "image_size": [w, h],
            "cost_usd": cost, "cached": cached, "prompt": text_prompt}
