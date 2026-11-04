"""One paid SAM 3.1 call on the simulated SAR image -> data/sample_detect.json.

Tries a concept prompt first; with --points, uses a point prompt instead.
Usage: python3 tools/make_sample.py ["dark oil slick" | --points]
"""
import datetime
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "server"))
import common  # noqa: E402
import sam  # noqa: E402

IMG = os.path.join(ROOT, "web", "assets", "img", "sample_sar.jpg")
POINTS = [[533, 293], [880, 533], [1200, 667]]  # on the dark slick, full-res px (2048x1152)


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else "dark oil slick"
    img = open(IMG, "rb").read()
    mime, w, h = sam.image_info(img)
    prompt = sam.point_prompt(POINTS, w, h) if arg == "--points" else arg
    if not common.budget_allows(common.SAM_COST):
        raise SystemExit("budget cap reached")
    req = sam.build_request(img, mime, prompt)
    status, resp, err = common.meta_post("/responses", req, 180)
    ok = status == 200 and resp is not None
    common.ledger_add("sam-3.1", "/v1/responses", f"spillsight sample sar :: {prompt}"[:200],
                      common.SAM_COST if ok else 0.0, status, f"{w}x{h}")
    if not ok:
        raise SystemExit(f"HTTP {status}: {err[:300]}")
    insts = sam.parse_text(common.output_text(resp), w, h)
    print(f"prompt={prompt!r}: {len(insts)} instances; scores {[i['score'] for i in insts]}")
    if not insts:
        print("empty result; not overwriting sample")
        return
    req["input"][0]["content"][1]["image_url"] = f"<base64 jpeg of web/assets/img/sample_sar.jpg, {w}x{h}>"
    doc = {"time": datetime.datetime.now().isoformat(timespec="seconds"), "prompt": prompt,
           "image": "web/assets/img/sample_sar.jpg",
           "image_source": "AI-generated simulated SAR image (muse-image-1.0), not real satellite data",
           "image_size": [w, h], "request": req, "http_status": status, "response": resp,
           "instances": insts, "cost_usd": common.SAM_COST}
    json.dump(doc, open(os.path.join(common.DATA, "sample_detect.json"), "w"), indent=1)
    print("wrote data/sample_detect.json")


if __name__ == "__main__":
    main()
