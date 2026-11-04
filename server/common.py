"""Shared config: Meta API key loading (never printed) and the shared cost ledger."""
import datetime
import json
import os
import threading
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                      # spillsight/
OIL = os.path.dirname(ROOT)                       # ~/Desktop/oil
DATA = os.path.join(ROOT, "data")
WEB = os.path.join(ROOT, "web")
CACHE = os.path.join(HERE, "cache")
ENV_FILE = os.path.join(OIL, ".env")
LEDGER = os.path.join(OIL, "video", "assets", "api_cost_ledger.json")
CAP_USD = 2.00
META_API = "https://api.meta.ai/v1"

SAM_COST = 0.0025                  # per image call
MUSE_IN_PER_TOKEN = 1.25e-6        # matches existing ledger entries (943 in / 2710 out -> $0.012696)
MUSE_OUT_PER_TOKEN = 4.25e-6
MUSE_RESERVE = 0.03                # pre-check reserve for one plan call

_lock = threading.Lock()


def _ssl_context():
    """python.org builds on macOS ship without a CA store; prefer certifi, then the system bundle."""
    import ssl
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        pass
    for path in ("/etc/ssl/cert.pem", "/usr/local/etc/openssl/cert.pem"):
        if os.path.exists(path):
            return ssl.create_default_context(cafile=path)
    return ssl.create_default_context()


SSL_CTX = _ssl_context()


def api_key():
    k = os.environ.get("META_API_KEY")
    if k:
        return k.strip()
    try:
        with open(ENV_FILE) as f:
            for line in f:
                line = line.strip()
                if line.startswith("META_API_KEY="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'") or None
    except OSError:
        pass
    return None


def has_key():
    return bool(api_key())


def ledger_load():
    try:
        with open(LEDGER) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"budget_usd": CAP_USD, "calls": [], "total_usd": 0.0}


def ledger_total():
    return float(ledger_load().get("total_usd", 0.0))


def budget_allows(cost):
    return ledger_total() + cost <= CAP_USD + 1e-9


def ledger_add(model, endpoint, label, cost, status, note=""):
    with _lock:
        L = ledger_load()
        L.setdefault("calls", []).append({
            "time": datetime.datetime.now().isoformat(timespec="seconds"),
            "model": model, "endpoint": endpoint, "label": label,
            "http_status": status, "cost_usd": round(cost, 6), "note": note,
        })
        L["budget_usd"] = CAP_USD
        L["total_usd"] = round(sum(c.get("cost_usd", 0) for c in L["calls"]), 6)
        L["remaining_usd"] = round(CAP_USD - L["total_usd"], 6)
        tmp = LEDGER + ".tmp"
        with open(tmp, "w") as f:
            json.dump(L, f, indent=2)
        os.replace(tmp, LEDGER)
        return L["total_usd"]


def meta_post(path, body, timeout=120):
    """POST JSON to the Meta API. Returns (status, json_or_None, error_text)."""
    key = api_key()
    if not key:
        return 0, None, "no META_API_KEY"
    req = urllib.request.Request(
        META_API + path, data=json.dumps(body).encode(), method="POST",
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json",
                 "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
            return r.status, json.loads(r.read().decode()), ""
    except urllib.error.HTTPError as e:
        txt = e.read().decode(errors="replace")[:600]
        try:
            return e.code, json.loads(txt), txt
        except ValueError:
            return e.code, None, txt
    except Exception as e:  # network, timeout, bad JSON
        return 0, None, f"{type(e).__name__}: {e}"[:300]


def output_text(resp):
    out = []
    for item in (resp or {}).get("output", []) or []:
        for part in item.get("content", []) or []:
            if part.get("type") == "output_text":
                out.append(part.get("text", ""))
    return "".join(out)
