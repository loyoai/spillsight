/* Thin client for the SpillSight server (CONTRACT.md). */
const API = (() => {
  async function j(method, url, body) {
    const r = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    let d; try { d = JSON.parse(t); } catch (e) { d = { ok: false, error: t.slice(0, 200) }; }
    if (!r.ok) throw Object.assign(new Error(d.error || `HTTP ${r.status}`), { data: d });
    return d;
  }
  return {
    health: () => j("GET", "/api/health"),
    sites: () => j("GET", "/api/sites"),
    resources: () => j("GET", "/api/resources"),
    addResource: (r) => j("POST", "/api/resources", r),
    delResource: (id) => j("DELETE", `/api/resources/${encodeURIComponent(id)}`),
    metocean: (ll) => j("GET", `/api/metocean?lon=${ll[0]}&lat=${ll[1]}`),
    detect: (body) => j("POST", "/api/detect", body),
    detectSample: () => j("POST", "/api/detect/sample", {}),
    forecast: (body) => j("POST", "/api/forecast", body),
    plan: (body) => j("POST", "/api/plan", body),
    ledger: () => j("GET", "/api/ledger"),
  };
})();
