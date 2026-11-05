"""Response planner: Meta Muse Wonder (JSON schema) with a deterministic rules fallback."""
import hashlib
import json
import os
import math
import time

import common
from geo import NM_KM, bearing_deg, destination, haversine_km

ROUTE_FACTOR = 1.15     # straight-line -> sea-route allowance
BOOM_LIMIT_KN = 0.7     # max current normal to a boom before entrainment
MAX_DEFLECT_DEG = 30.0
_cache = {}

KIND_PRIORITY = {"intake": 0, "mangrove": 1, "coral": 1, "town": 2, "coast": 3, "port": 3, "lane": 4}
CLOSURE_ACTION = {
    "intake": "Shut seawater intake / switch to stored water; monitor for hydrocarbons before restart",
    "mangrove": "Close area to access; pre-stage exclusion boom across creek mouths",
    "coral": "Close area to diving and anchoring; avoid dispersant use nearby",
    "town": "Shoreline advisory; keep public off oiled shoreline",
    "coast": "Shoreline advisory; pre-stage shoreline clean-up team",
    "port": "Restrict vessel movements in affected basin; protect berths with boom",
    "lane": "Navigation warning; reduced speed through affected section",
}


def _norm_weights(w):
    w = w or {}
    vals = {k: max(0.0, float(w.get(k, 1.0) or 0)) for k in ("time", "capacity", "distance")}
    s = sum(vals.values()) or 1.0
    return {k: v / s for k, v in vals.items()}


def eta_h(res, target):
    d_km = haversine_km(res["lonlat"], target) * ROUTE_FACTOR
    spd = max(float(res.get("speed_kn") or 8), 1.0)
    return d_km / NM_KM / spd, d_km


def _capacity(res):
    t = res.get("type")
    if t == "boom":
        return min(1.0, (res.get("boom_m") or 0) / 800.0)
    if t == "skimmer":
        return min(1.0, (res.get("skimmer_m3h") or 0) / 50.0)
    if t == "storage":
        return min(1.0, (res.get("storage_m3") or 0) / 1200.0)
    if t == "vessel":
        return min(1.0, (res.get("speed_kn") or 0) / 14.0)
    return 0.5


def deflection_angle(current_kn):
    if current_kn <= BOOM_LIMIT_KN:
        return MAX_DEFLECT_DEG
    return round(min(MAX_DEFLECT_DEG, math.degrees(math.asin(BOOM_LIMIT_KN / current_kn))), 1)


def _context(body, sites_by_id):
    fs = body.get("forecast_summary") or {}
    stats = fs.get("stats", fs)
    met = body.get("metocean") or {}
    centre = stats.get("centroid_lonlat") or fs.get("centroid_lonlat") or [56.52, 26.47]
    lead = stats.get("leading_edge_lonlat") or fs.get("leading_edge_lonlat")
    if not lead:
        lead = destination(centre, float(stats.get("drift_to_deg", met.get("current_to_deg", 290))), 1.0)
    impacts = []
    for im in body.get("impacts") or []:
        s = sites_by_id.get(im.get("site_id"))
        if not s:
            continue
        loc = s.get("lonlat") or (s.get("path") or [centre])[len(s.get("path") or [centre]) // 2]
        impacts.append({**im, "name": s["name"], "kind": s["kind"], "lonlat": loc,
                        "country": s.get("country")})
    impacts.sort(key=lambda r: (r.get("eta_h") if r.get("eta_h") is not None else 1e9))
    return stats, met, centre, lead, impacts


# ------------------------------------------------------------------ rules
def rules_plan(body, resources, sites_by_id):
    W = _norm_weights(body.get("weights"))
    stats, met, centre, lead, impacts = _context(body, sites_by_id)
    cur = float(met.get("current_kn", 0.8))
    wave = float(met.get("wave_m", 0.8))
    ready = [r for r in resources if r.get("status", "ready") == "ready"]
    used = set()
    assignments, booms, closures, advisories, risks = [], [], [], [], []

    drift_kn = float(stats.get("drift_kn") or 0)
    drift_to = float(stats.get("drift_to_deg") or 0)

    def aim(r, target, moving):
        """Fixed target, or an intercept on the drifting slick (one fixed-point iteration)."""
        if not moving:
            return target
        t0, _ = eta_h(r, target)
        return destination(target, drift_to, drift_kn * NM_KM * t0)

    def pick(types, target, deadline_h, task, why, moving=False):
        cands = [r for r in ready if r["type"] in types and r["id"] not in used]
        if not cands:
            return None
        aims = {r["id"]: aim(r, target, moving) for r in cands}
        dists = [eta_h(r, aims[r["id"]])[1] for r in cands]
        dmax = max(dists) or 1.0
        best = None
        for r, d in zip(cands, dists):
            t, _ = eta_h(r, aims[r["id"]])
            horizon = max(deadline_h or 24.0, 1.0)
            s_time = max(0.0, 1.0 - t / horizon)
            score = W["time"] * s_time + W["capacity"] * _capacity(r) + W["distance"] * (1 - d / dmax)
            if best is None or score > best[0]:
                best = (score, r, t, d)
        score, r, t, d = best
        used.add(r["id"])
        tg = aims[r["id"]]
        late = deadline_h is not None and t > deadline_h
        if moving:
            why = why + f" Intercept where the slick is forecast at +{t:.1f} h."
        a = {"resource_id": r["id"], "task": task,
             "target_lonlat": [round(tg[0], 5), round(tg[1], 5)],
             "eta_h": round(t, 1), "score": round(score, 3),
             "reason": f"{why} {r['name']} from {r['base']}: {d:.1f} km at {r.get('speed_kn')} kn "
                       f"= {t:.1f} h" + (f" (arrives after impact at {deadline_h} h)" if late else "")}
        assignments.append(a)
        if late:
            risks.append(f"{r['name']} reaches {task.split(':')[0]} after the forecast impact time.")
        return a

    shore = [i for i in impacts if i["kind"] != "lane"]
    first_eta = shore[0]["eta_h"] if shore else None
    # 1. Surveillance over the slick.
    pick({"drone", "aircraft"}, centre, 2, "surveillance: track slick and confirm forecast",
         "Fastest aerial asset.", moving=True)
    # 2. Containment at the leading edge (two vessels + boom + skimmer + storage).
    pick({"vessel"}, lead, first_eta, "containment: tow boom (lead vessel) at slick leading edge",
         "Best-scoring vessel for leading edge.", moving=True)
    pick({"vessel"}, lead, first_eta, "containment: tow boom (second vessel) at slick leading edge",
         "Second vessel for U-boom.", moving=True)
    angle = deflection_angle(cur)

    def protect(im):
        kind = "deflection" if im["kind"] in ("intake", "port") else "exclusion"
        a = pick({"boom"}, im["lonlat"], im["eta_h"], f"protect: {kind} boom at {im['name']}",
                 f"Forecast impact at {im['eta_h']} h ({im['n']} particles).")
        reason = (f"Deflection angle asin({BOOM_LIMIT_KN}/{cur:.2f} kn) capped at "
                  f"{MAX_DEFLECT_DEG:.0f} deg = {angle} deg keeps the current normal to the boom "
                  f"<= {BOOM_LIMIT_KN} kn; divert oil away from {im['name']}."
                  if kind == "deflection" else
                  f"Exclusion boom across the entrance to {im['name']}; sheltered water only.")
        length = 300
        if a:
            length = next(x for x in resources if x["id"] == a["resource_id"]).get("boom_m") or 300
        else:
            reason = "No boom unit left; request additional boom. " + reason
            risks.append(f"No boom available for {im['name']}.")
        booms.append({"site_id": im["site_id"], "kind": kind,
                      "angle_deg": angle if kind == "deflection" else 0,
                      "length_m": length, "reason": reason})
        pick({"vessel"}, im["lonlat"], im["eta_h"], f"support: deploy boom at {im['name']}",
             "Workboat for boom deployment.")

    ranked = sorted(shore, key=lambda r: (KIND_PRIORITY.get(r["kind"], 5), r["eta_h"]))
    # 3a. Most sensitive sites (intakes, mangrove, coral) get booms before open-water containment.
    for im in ranked:
        if KIND_PRIORITY.get(im["kind"], 5) <= 1:
            protect(im)
    cb = pick({"boom"}, lead, first_eta, "containment: U-boom across leading edge", "Boom unit.",
              moving=True)
    if cb:
        r = next(x for x in resources if x["id"] == cb["resource_id"])
        booms.append({"site_id": None, "kind": "containment", "angle_deg": 0,
                      "length_m": r.get("boom_m") or 300,
                      "reason": "U-configuration towed by two vessels across the leading edge; keep "
                                f"tow speed relative to water <= {BOOM_LIMIT_KN} kn."})
    else:
        risks.append("No boom unit left for open-water containment.")
    pick({"skimmer"}, lead, first_eta, "recovery: skim inside containment boom", "Skimmer.", moving=True)
    pick({"storage"}, lead, None, "storage: receive recovered emulsion", "Storage barge.", moving=True)
    # 3b. Remaining sites (towns, coasts, ports).
    for im in ranked:
        if KIND_PRIORITY.get(im["kind"], 5) > 1:
            protect(im)

    # 4. Closures 4 h before eta.
    for im in impacts:
        closures.append({"site_id": im["site_id"], "from_h": max(0, round(im["eta_h"] - 4, 1)),
                         "action": CLOSURE_ACTION.get(im["kind"], "Advisory"),
                         "reason": f"Forecast oil within {'2' if im['kind'] == 'lane' else '4'} km "
                                   f"at {im['eta_h']} h; act 4 h before."})

    # 5. Advisories.
    advisories.append({"kind": "navigation", "radius_km": 5,
                       "reason": "Keep non-response traffic clear of the slick and boom operations."})
    advisories.append({"kind": "air_quality", "radius_km": 2,
                       "reason": f"Fresh crude releases volatiles; downwind of wind from "
                                 f"{met.get('wind_from_deg', 315):.0f} deg for the first 24 h."})
    advisories.append({"kind": "fishing", "radius_km": 10,
                       "reason": "Suspend fishing in and around the slick and forecast drift path."})

    # 6. Risks.
    if cur > 1.0:
        risks.append(f"Current {cur:.2f} kn exceeds typical boom limit; containment will lose oil "
                     "unless booms are angled (deflection).")
    if wave > 1.5:
        risks.append(f"Wave height {wave:.1f} m reduces boom and skimmer efficiency.")
    if first_eta is not None and first_eta <= 6:
        risks.append(f"First landfall forecast at {first_eta} h; little time for shoreline protection.")
    off = [r["name"] for r in resources if r.get("status", "ready") != "ready"]
    if off:
        risks.append("Not available: " + ", ".join(off) + ".")
    if any(r.get("sample") for r in resources):
        risks.append("Resource list contains SAMPLE (fictional) assets; replace with real inventory.")
    risks.append("Drift is a simplified current + 3% wind particle model with constant met-ocean; "
                 "verify with surveillance and an operational model.")

    n_imp = len(shore)
    summary = (f"Slick drifting {stats.get('drift_kn', '?')} kn toward {stats.get('drift_to_deg', '?')} deg. "
               + (f"First shoreline impact forecast at {first_eta} h ({shore[0]['name']}). "
                  if shore else "No shoreline impacts forecast in the window. ")
               + f"{len(assignments)} assets assigned: containment at the leading edge, "
               f"{n_imp} site(s) to protect, closures 4 h before forecast arrival.")
    return {"summary": summary, "assignments": assignments, "booms": booms, "closures": closures,
            "advisories": advisories, "risks": risks}


# ------------------------------------------------------------------ Muse Wonder
def _schema():
    s, n = {"type": "string"}, {"type": "number"}

    def obj(props):
        return {"type": "object", "additionalProperties": False, "properties": props,
                "required": list(props)}
    return obj({
        "summary": s,
        "assignments": {"type": "array", "items": obj({
            "resource_id": {"type": "string", "description": "Must be one of the given resource ids"},
            "task": s,
            "target_lonlat": {"type": "array", "items": n, "description": "[lon, lat]"},
            "eta_h": n, "score": {"type": "number", "description": "0..1 suitability"},
            "reason": s})},
        "booms": {"type": "array", "items": obj({
            "site_id": {"type": "string", "description": "Given site id, or empty string for open-water containment"},
            "kind": {"type": "string", "enum": ["containment", "deflection", "exclusion"]},
            "angle_deg": n, "length_m": n, "reason": s})},
        "closures": {"type": "array", "items": obj({
            "site_id": s, "from_h": n, "action": s, "reason": s})},
        "advisories": {"type": "array", "items": obj({"kind": s, "radius_km": n, "reason": s})},
        "risks": {"type": "array", "items": s},
    })


def _prompt(body, resources, sites_by_id):
    W = _norm_weights(body.get("weights"))
    stats, met, centre, lead, impacts = _context(body, sites_by_id)
    cur = float(met.get("current_kn", 0.8))
    lines = ["SCENARIO (SIMULATED exercise, Strait of Hormuz). Treat these inputs as given facts.",
             f"- Slick centroid {centre}, leading edge {lead} ([lon, lat]).",
             f"- Forecast: {json.dumps({k: stats.get(k) for k in ('first_landfall_h', 'ashore_pct', 'drift_kn', 'drift_to_deg', 'area_km2', 'drift_km_24h')})}",
             f"- Met-ocean: wind {met.get('wind_kn')} kn from {met.get('wind_from_deg')} deg, current "
             f"{cur} kn toward {met.get('current_to_deg')} deg, waves {met.get('wave_m')} m "
             f"(source {met.get('source', 'given')}).",
             f"- Boom rule: current normal to boom <= {BOOM_LIMIT_KN} kn -> deflection angle = "
             f"asin({BOOM_LIMIT_KN}/{cur}) capped at {MAX_DEFLECT_DEG:.0f} deg = {deflection_angle(cur)} deg.",
             "- Closures should start 4 h before forecast arrival.",
             f"- Planner weights (normalised): time {W['time']:.2f}, capacity {W['capacity']:.2f}, "
             f"distance {W['distance']:.2f}.",
             "", "FORECAST IMPACTS (site_id, name, kind, eta_h, particles):"]
    for im in impacts:
        lines.append(f"- {im['site_id']} | {im['name']} | {im['kind']} | eta {im['eta_h']} h | n {im['n']} | at {im['lonlat']}")
    if not impacts:
        lines.append("- none in the forecast window")
    targets = [("leading_edge", lead)] + [(im["site_id"], im["lonlat"]) for im in impacts[:6]
                                          if im["kind"] != "lane"]
    lines += ["", "RESOURCES (id | type | name | base | status | capacity) with computed distance km / ETA h "
                  f"to targets (route factor {ROUTE_FACTOR}):"]
    for r in resources:
        cap = {"boom": f"boom {r.get('boom_m')} m", "skimmer": f"skimmer {r.get('skimmer_m3h')} m3/h",
               "storage": f"storage {r.get('storage_m3')} m3"}.get(r["type"], f"{r.get('speed_kn')} kn")
        et = "; ".join(f"{tid}: {eta_h(r, t)[1]:.1f} km / {eta_h(r, t)[0]:.1f} h" for tid, t in targets)
        lines.append(f"- {r['id']} | {r['type']} | {r['name']} | {r.get('base')} | {r.get('status', 'ready')} | {cap} | {et}")
    lines += ["", "TASK: Draft the next-72-hour response plan as the JSON schema requires.",
              "Use ONLY the resource ids and site ids listed above; only assign resources with status ready; "
              "each resource at most once. Use the computed ETAs, do not invent distances. "
              "Containment at the slick leading edge; deflection booms at intakes using the given angle; "
              "exclusion booms for mangrove/coral. Score each assignment 0..1 using the weights. "
              "Write every reason as one plain-English sentence of at most 16 words that a duty officer can read at a glance (e.g. 'Closest vessel, on scene 2 h before landfall'); no formulas or score arithmetic. If inputs look inconsistent, say so in risks."]
    return "\n".join(lines)


PLAN_MODEL = os.environ.get("SPILL_PLAN_MODEL", "muse-wonder-1.0")


def muse_plan(body, resources, sites_by_id):
    """Returns (plan|None, cost, error)."""
    if not common.has_key():
        return None, 0.0, "no key"
    if not common.budget_allows(common.MUSE_RESERVE):
        return None, 0.0, "spending cap reached"
    system = ("You are an oil spill response planner (ITOPF/IMO practice). Output only the JSON object "
              "required by the schema.")
    req = {"model": PLAN_MODEL, "reasoning": {"effort": "low"},
           "input": [{"role": "system", "content": system},
                     {"role": "user", "content": _prompt(body, resources, sites_by_id)}],
           "text": {"format": {"type": "json_schema", "name": "spillsight_plan", "strict": True,
                               "schema": _schema()}}}
    t0 = time.time()
    status, resp, err = common.meta_post("/responses", req, timeout=180)
    if status == 400:
        # model without structured-output support: ask for the same object as plain JSON text
        req.pop("text", None); req.pop("reasoning", None)
        req["input"][0]["content"] = system + " Return a single JSON object with exactly these keys and types: " + json.dumps(_schema())
        status, resp, err = common.meta_post("/responses", req, timeout=180)
    usage = (resp or {}).get("usage") or {}
    cost = (usage.get("input_tokens", 0) * common.MUSE_IN_PER_TOKEN
            + usage.get("output_tokens", 0) * common.MUSE_OUT_PER_TOKEN) if status == 200 else 0.0
    common.ledger_add(PLAN_MODEL, "/v1/responses", "spillsight plan", cost, status,
                      json.dumps(usage) if usage else f"{time.time() - t0:.1f}s {err[:120]}")
    if status != 200:
        return None, cost, f"HTTP {status}: {err[:200]}"
    txt = common.output_text(resp).strip()
    if txt.startswith("```"):
        txt = txt.strip("`").split("\n", 1)[1] if "\n" in txt else txt
    try:
        plan = json.loads(txt[txt.find("{"): txt.rfind("}") + 1])
    except ValueError:
        return None, cost, "model output was not JSON"
    return _validate(plan, body, resources, sites_by_id), cost, ""


def _validate(plan, body, resources, sites_by_id):
    rid = {r["id"]: r for r in resources}
    out_a, seen, notes = [], set(), []
    for a in plan.get("assignments", []):
        r = rid.get(a.get("resource_id"))
        if not r or r["id"] in seen:
            notes.append(f"Dropped assignment with unknown/duplicate resource id {a.get('resource_id')!r}.")
            continue
        seen.add(r["id"])
        tgt = a.get("target_lonlat") or r["lonlat"]
        if len(tgt) != 2:
            tgt = r["lonlat"]
        t, _ = eta_h(r, tgt)
        a["eta_h"] = round(t, 1)  # deterministic ETA overrides the model's number
        a["target_lonlat"] = [round(float(tgt[0]), 5), round(float(tgt[1]), 5)]
        out_a.append(a)
    plan["assignments"] = out_a
    for b in plan.get("booms", []):
        b["site_id"] = b.get("site_id") if b.get("site_id") in sites_by_id else None
    plan["closures"] = [c for c in plan.get("closures", []) if c.get("site_id") in sites_by_id]
    plan["risks"] = list(plan.get("risks", [])) + notes
    return plan


# ------------------------------------------------------------------ entry
def plan(body, resources, sites_by_id):
    engine = (body.get("engine") or "auto").lower()
    key = hashlib.sha256(json.dumps([body, resources], sort_keys=True).encode()).hexdigest()
    if engine != "rules" and key in _cache:
        hit = dict(_cache[key])
        hit["cost_usd"] = 0.0
        hit["cached"] = True
        return hit
    note = ""
    if engine != "rules":
        p, cost, err = muse_plan(body, resources, sites_by_id)
        if p is not None:
            out = {"ok": True, "source": PLAN_MODEL, "cost_usd": round(cost, 6), "plan": p,
                   "cached": False}
            _cache[key] = out
            return out
        note = err
    out = {"ok": True, "source": "rules", "cost_usd": 0.0,
           "plan": rules_plan(body, resources, sites_by_id), "cached": False}
    if note:
        out["fallback_reason"] = note
    return out
