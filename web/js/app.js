/* SpillSight console: detect -> forecast -> recommend taskings / plan -> approve -> execute. */
(() => {
  const $ = (s, r) => (r || document).querySelector(s), $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const icons = (root) => window.lucide && lucide.createIcons(root ? { nodes: [root] } : undefined);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmtH = (h) => { const hh = Math.floor(h), mm = Math.floor((h - hh) * 60); return `T+${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`; };
  const ago = (t) => { const s = Math.max(1, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s} seconds ago` : `${Math.round(s / 60)} minute${s < 120 ? "" : "s"} ago`; };
  const TYPE_ICON = { vessel: "ship", boom: "waves", skimmer: "fuel", storage: "container", drone: "scan", aircraft: "plane" };
  const TYPE_NAME = { vessel: "Response vessel", boom: "Containment boom", skimmer: "Skimmer", storage: "Storage barge", drone: "Survey drone", aircraft: "Surveillance aircraft" };
  const SITE_ICON = { port: "anchor", intake: "droplets", mangrove: "trees", coral: "fish", coast: "waves", town: "house", lane: "waypoints" };
  const DEFAULT_LL = [56.52, 26.47];
  // live conditions are often calm; the Shamal (north-westerly) scenario is a labelled what-if for planning
  const SHAMAL = { wind_kn: 18, wind_from_deg: 300, current_kn: 1.0, current_to_deg: 240, wave_m: 1.6, source: "scenario" };

  const S = { stage: "detect", view: "ops", tab: "targets", sel: null, sites: [], resources: [], det: null, footprint: null, slick: null, met: null, metMode: "scenario", fc: null, plan: null,
    approved: false, hour: 0, playing: false, board: [], log: [], siteMk: {}, execT0: 0, srcImg: "assets/img/sample_sar.jpg", upload: null, resFilter: "all", hwType: "vessel",
    weights: { time: 50, capacity: 30, distance: 20, sensitivity: 40, endurance: 20, readiness: 30 }, contOpt: true, collapsed: {}, t0: Date.now() };

  // ------------------------------------------------------------------ helpers
  function toast(msg, cls) { const t = document.createElement("div"); t.className = "toast " + (cls || ""); t.innerHTML = msg; $("#toasts").appendChild(t); icons(t); setTimeout(() => t.remove(), 4200); }
  function log(msg, color) { S.log.unshift({ t: new Date().toISOString().slice(11, 19), msg, color: color || "#ec9a3c" }); if (S.tab === "alerts") renderLeft(); }
  const siteById = (id) => S.sites.find((s) => s.id === id);
  const resById = (id) => S.resources.find((r) => r.id === id);
  const activeMet = () => (S.metMode === "live" && S.met ? S.met : SHAMAL);
  function polyAreaKm2(poly) { const w = poly.map((ll) => Geo.toWorld(ll[0], ll[1])); let a = 0; for (let i = 0; i < w.length; i++) { const p = w[i], q = w[(i + 1) % w.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2; }
  function centroid(poly) { let x = 0, y = 0; poly.forEach((p) => { x += p[0]; y += p[1]; }); return [x / poly.length, y / poly.length]; }
  const cap = (r) => [r.boom_m ? `${r.boom_m} m boom` : "", r.skimmer_m3h ? `${r.skimmer_m3h} m³/h` : "", r.storage_m3 ? `${r.storage_m3} m³` : "", r.speed_kn ? `${r.speed_kn} kn` : ""].filter(Boolean).join(" · ") || "survey";
  const stageName = () => (!S.det ? "Pending detection" : !S.fc ? "Dynamic" : !S.plan ? "Pending pairing" : !S.approved ? "Paired" : S.execDone ? "Pending verification" : "In execution");

  // ------------------------------------------------------------------ board
  const COLS = [["detected", "DETECTED"], ["triage", "TRIAGE"], ["pairing", "PENDING PAIRING"], ["paired", "PAIRED"], ["exec", "IN EXECUTION"], ["verify", "PENDING VERIFICATION"], ["complete", "COMPLETE"]];
  let cardSeq = 4100;
  function card(kind, title, sub, col, extra) { const c = Object.assign({ id: `${kind === "det" ? "DT" : kind === "site" ? "SR" : "AS"}${cardSeq++}`, kind, title, sub, col, t: Date.now() }, extra || {}); S.board.push(c); renderBoard(); return c; }
  function moveCards(pred, col) { S.board.filter(pred).forEach((c) => { c.col = col; c.t = Date.now(); }); renderBoard(); }
  function renderBoard() {
    $("#board-count").textContent = S.board.length; $("#bt-warn").textContent = S.board.filter((c) => c.warn).length;
    const B = $("#board");
    const bq = ($("#b-search") || {}).value ? $("#b-search").value.toLowerCase() : "";
    const etaOf = (c) => parseFloat(String(c.tot || "").split("+")[1]) || 999;
    B.innerHTML = COLS.map(([k, n]) => { let cs = S.board.filter((c) => c.col === k && (!S.bWarn || c.warn) && (!bq || (c.title + " " + c.sub + " " + c.id).toLowerCase().includes(bq)));
      cs = S.bSort === "eta" ? cs.slice().sort((a, b) => etaOf(a) - etaOf(b)) : cs.slice().sort((a, b) => b.t - a.t); return `<div class="col ${k === "triage" ? "hl" : ""}" data-col="${k}"><div class="col-h"><span class="dot" style="background:${k === "complete" ? "#32a467" : k === "exec" ? "#4c90f0" : "#ec9a3c"}"></span>${n}<span class="n">${cs.length}</span></div><div class="col-b">` +
      cs.map((c) => `<div class="bc k-${c.kind}${Date.now() - c.t < 450 ? " fresh" : ""}" draggable="true" data-id="${c.id}" data-title="${esc(c.title)}">${c.tot ? `<div class="tot">${esc(c.tot.split(":")[0])}: <b>${esc(c.tot.split(":").slice(1).join(":"))}</b></div>` : ""}<div class="row"><span class="ic"><i data-lucide="${c.kind === "asg" ? "ship" : "crosshair"}"></i></span><div><span class="id">${c.id}</span> <b>${esc(c.title)}</b><small>${esc(c.sub)}</small></div></div><div class="ft"><span>Last edited ${ago(c.t)}</span>${c.warn ? '<span class="w"><i data-lucide="triangle-alert"></i></span>' : ""}</div></div>`).join("") + "</div></div>"; }).join("");
    icons(B);
    $$(".bc", B).forEach((e) => e.addEventListener("dragstart", (ev) => ev.dataTransfer.setData("text", e.dataset.id)));
    $$(".col", B).forEach((col) => {
      col.addEventListener("dragover", (ev) => { ev.preventDefault(); col.classList.add("drop"); });
      col.addEventListener("dragleave", () => col.classList.remove("drop"));
      col.addEventListener("drop", (ev) => { ev.preventDefault(); const c = S.board.find((q) => q.id === ev.dataTransfer.getData("text")); if (c) { c.col = col.dataset.col; c.t = Date.now(); renderBoard(); } });
    });
  }

  // ------------------------------------------------------------------ left panel
  const vis = { sites: true, assets: true, oil: true, risk: true, lanes: true };
  function renderLeft() {
    const L = $("#left");
    const tabs = `<div class="lp-tabs"><button class="lp-tab ${S.tab === "targets" ? "on" : ""}" data-t="targets"><i data-lucide="crosshair"></i>Targets</button><button class="lp-tab ic ${S.tab === "layers" ? "on" : ""}" data-t="layers" title="Map layers"><i data-lucide="layers"></i></button><button class="lp-tab ic ${S.tab === "assets" ? "on" : ""}" data-t="assets" title="AI asset tasking recommender"><i data-lucide="ship"></i></button><button class="lp-tab ic ${S.tab === "alerts" ? "on" : ""}" data-t="alerts" title="Activity"><i data-lucide="triangle-alert"></i></button><button class="lp-tab ic" data-t="home" title="Overview"><i data-lucide="house"></i></button><span class="sp"></span><button class="lp-tab ic" id="lp-collapse" title="Collapse panel"><i data-lucide="panel-left-close"></i></button></div>`;
    let body = "";
    const q = ($("#obj-search").value || "").toLowerCase(), f = (s) => !q || s.toLowerCase().includes(q);
    if (S.tab === "targets" || S.tab === "home") {
      const items = [];
      if (S.det) items.push({ key: "slick", icon: "crosshair", t: "Computer Vision Detection", s: `Oil slick · ${polyAreaKm2(S.slick).toFixed(2)} km²`, st: stageName(), dot: "#ec9a3c", tr: S.fc && S.fc.stats.first_landfall_h != null ? `+${S.fc.stats.first_landfall_h} h` : "" });
      (S.fc ? S.fc.impacts : []).forEach((im) => { const s = siteById(im.site_id); if (!s || s.kind === "lane") return; items.push({ key: "site:" + s.id, icon: SITE_ICON[s.kind] || "map-pin", t: "Shoreline impact", s: `${s.name}`, st: S.approved ? "In execution" : S.plan ? "Paired" : "Pending pairing", dot: S.hour >= im.eta_h ? "#e76a6e" : "#ec9a3c", tr: `ETA +${im.eta_h} h` }); });
      body = `<div class="lp-h">Incident board <span class="lk">${items.length} target${items.length === 1 ? "" : "s"}</span></div>
        <div class="bp-field"><span>Board:</span><b><i data-lucide="crosshair" style="color:#e76a6e"></i>HZ-01 · Strait of Hormuz</b></div>
        <div class="bp-field"><i data-lucide="search"></i><input placeholder="Search targets…" id="lp-search"></div>
        <div class="rec-row" id="rec-row"><i data-lucide="sparkles"></i>Recommend taskings<i data-lucide="arrow-right" class="a"></i></div>` +
        (items.length ? items.filter((it) => f(it.s + it.t)).map((it) => `<div class="tcard ${S.sel === it.key ? "sel" : ""}" data-key="${it.key}"><span class="ti"><i data-lucide="${it.icon}"></i></span><b>${esc(it.t)}</b><span class="tr">${esc(it.tr)}</span><small>${esc(it.s)}</small><div class="st">HZ-01 <i style="background:${it.dot}"></i>${esc(it.st)}</div></div>`).join("") +
          (S.det ? `<div class="sub-ap"><i data-lucide="corner-down-right"></i>${S.fc ? S.fc.particles + " particles · 72 h" : "awaiting forecast"}</div>` : "")
          : `<div class="empty">No targets yet.<br>Run a detection on a new image.</div>`);
    } else if (S.tab === "layers") {
      const atRisk = new Set((S.fc ? S.fc.impacts : []).map((i) => i.site_id));
      const grp = (key, name, icon, items) => `<div class="lg"><div class="lg-h"><i data-lucide="${icon}"></i>${name}<span class="n">${items.length}</span><span class="eye" data-eye="${key}"><i data-lucide="${vis[key] === false ? "eye-off" : "eye"}"></i></span></div>${items.join("")}</div>`;
      const sites = S.sites.filter((s) => s.kind !== "lane" && f(s.name)).sort((a, b) => atRisk.has(b.id) - atRisk.has(a.id)).map((s) => { const im = S.fc && S.fc.impacts.find((i) => i.site_id === s.id); return `<div class="li" data-site="${s.id}"><span class="b" style="background:${im ? "#e76a6e" : s.kind === "intake" ? "#8abbff" : "#abb3bf"}"></span>${esc(s.name)}<small>${im ? "+" + im.eta_h + " h" : s.kind}</small></div>`; });
      const assets = S.resources.filter((r) => f(r.name)).map((r) => `<div class="li" data-res="${r.id}"><i data-lucide="${TYPE_ICON[r.type] || "box"}" style="width:12px;height:12px;color:#8abbff"></i>${esc(r.name)}<small>${r.status}</small></div>`);
      const lanes = S.sites.filter((s) => s.kind === "lane").map((s) => `<div class="li" data-lane="${s.id}"><span class="b" style="background:#8abbff"></span>${esc(s.name)}</div>`);
      body = `<div class="lp-h">Map layers <span class="lk">${S.sites.length + S.resources.length} objects</span></div>` + grp("oil", "Detections & drift", "crosshair", S.det ? [`<div class="li" data-go="slick"><span class="b" style="background:#e5484d"></span>Oil slick · SAM 3.1<small>${polyAreaKm2(S.slick).toFixed(2)} km²</small></div>`] : []) +
        grp("risk", "Sensitive sites", "shield-alert", sites) + grp("assets", "Response assets", "ship", assets) + grp("lanes", "Traffic separation scheme", "waypoints", lanes);
    } else if (S.tab === "assets") {
      const head = `<div class="lp-h" style="padding-top:8px"><span style="display:flex;gap:7px;align-items:center;color:#f6f7f9"><i data-lucide="arrow-left" id="lp-back" style="cursor:pointer" title="Back to targets"></i><i data-lucide="sparkles" style="color:#bdabff"></i>AI asset tasking recommender</span><i data-lucide="sliders-horizontal" id="open-metrics" style="cursor:pointer"></i></div>
        <div style="padding:0 10px 6px;color:#8f99a8;font-size:10.5px">Last refresh ${ago(S.planT || S.t0)} · <span style="color:#8abbff;cursor:pointer" id="re-rec">Refresh</span></div>`;
      if (S.plan) {
        body = head + S.plan.plan.assignments.map((a) => {
          const r = resById(a.resource_id) || { name: a.resource_id, type: "vessel", base: "" }, sc = +a.score || 0, m = sc >= 0.8 ? "Strong match" : sc >= 0.6 ? "Fair match" : "Weak match";
          return `<div class="mcard"><div class="mh"><span class="q"><i data-lucide="${sc >= 0.8 ? "badge-check" : "badge"}"></i>${m}</span><span class="ed" data-edit="${esc(a.resource_id)}" style="cursor:pointer" title="Open in the asset inventory"><i data-lucide="pencil"></i>Edit asset</span></div><div class="mbar"><i style="width:${(sc * 100).toFixed(0)}%"></i></div>
            <div class="mb"><div class="as"><b title="${esc(r.name)}"><i data-lucide="${TYPE_ICON[r.type] || "ship"}" style="color:#8abbff"></i>${esc(r.name.replace(/ Response| Unit/g, ""))}</b>${cap(r).split(" · ").slice(0, 3).map((c) => `<small>${esc(c)}</small>`).join("")}</div><i data-lucide="arrow-right" style="color:#738091"></i><div class="tg"><b><i data-lucide="crosshair"></i>${esc(a.task.split(/[,;.(]/)[0])}</b><small>ETA +${(+a.eta_h).toFixed(1)} h · score ${sc.toFixed(2)}</small></div></div>
            <div class="mf"><span><span class="live">LIVE</span> (updated ${ago(S.planT)})</span><span>${esc(r.base || "")}</span></div></div>`;
        }).join("");
      } else body = head + `<div class="empty"><i data-lucide="sparkles"></i><br>${S.fc ? "Choose which metrics the AI should prioritise, then optimise." : "Run a forecast to get recommendations."}</div>${S.fc ? '<div style="padding:0 10px"><button class="bp-btn olive w" id="lp-opt"><i data-lucide="sliders-horizontal"></i>Choose metrics</button></div>' : ""}`;
    } else {
      body = `<div class="lp-h">Activity <span class="lk">${S.log.length}</span></div><div class="log" style="padding:0 10px">${S.log.map((l) => `<div class="ln"><em>${l.t}</em><i style="background:${l.color}"></i><div>${l.msg}</div></div>`).join("") || '<div class="empty">No activity yet.</div>'}</div>`;
    }
    L.innerHTML = tabs + `<div class="lp-body">${body}</div>`; icons(L);
    $$(".lp-tab[data-t]", L).forEach((b) => (b.onclick = () => { S.tab = b.dataset.t === "home" ? "targets" : b.dataset.t; if (b.dataset.t === "home") Map3D.flyTo([56.3, 26.5], 175, { el: 0.95, az: -0.6 }); syncRail(); renderLeft(); }));
    $$(".tcard", L).forEach((c) => (c.onclick = () => selectObj(c.dataset.key)));
    $$("[data-eye]", L).forEach((e) => e.addEventListener("click", (ev) => { ev.stopPropagation(); const k = e.dataset.eye; vis[k] = !vis[k]; ({ risk: ["risk", "sites"], oil: ["oil", "tracks"], assets: ["assets"], lanes: ["lanes"] }[k] || [k]).forEach((g) => Map3D.setGroupVisible(g, vis[k])); renderLeft(); }));
    $$("[data-site]", L).forEach((e) => (e.onclick = () => selectObj("site:" + e.dataset.site)));
    $$("[data-res]", L).forEach((e) => (e.onclick = () => { const r = resById(e.dataset.res); const p = Map3D.assetPos(r.id); Map3D.flyTo(p ? Geo.toLonLat(p.x, p.z) : r.lonlat, 16); }));
    $$("[data-go=slick]", L).forEach((e) => (e.onclick = () => selectObj("slick")));
    $$("[data-lane]", L).forEach((e) => (e.onclick = () => { const s = siteById(e.dataset.lane); Map3D.flyTo(s.path[Math.floor(s.path.length / 2)], 70); }));
    $$(".lg-h", L).forEach((h) => (h.onclick = () => { const eye = h.querySelector("[data-eye]"); if (eye) eye.click(); }));
    const on = (id, fn) => { const e = $(id, L); if (e) e.onclick = fn; };
    on("#rec-row", () => (S.fc ? openMetrics() : toast('<i data-lucide="info"></i>Run a forecast before asking for taskings', "or")));
    on("#open-metrics", () => S.fc && openMetrics()); on("#lp-opt", openMetrics); on("#re-rec", () => S.fc && openMetrics());
    const ls = $("#lp-search", L); if (ls) ls.oninput = () => { const v = ls.value.toLowerCase(); $$(".tcard", L).forEach((c) => (c.style.display = c.textContent.toLowerCase().includes(v) ? "" : "none")); };
    on("#lp-back", () => { S.tab = "targets"; syncRail(); renderLeft(); });
    on("#lp-collapse", () => $("#app").classList.toggle("lp-collapsed"));
    $$("[data-edit]", L).forEach((e) => (e.onclick = () => { const r = resById(e.dataset.edit); if (r) { S.hwType = r.type; S.resFilter = r.type; S.resSel = r.id; } setView("res"); }));
  }
  function syncRail() { $$("#rail [data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === S.tab)); }
  function selectObj(key) {
    S.sel = key;
    if (key === "slick" && S.slick) { Map3D.flyTo(centroid(S.slick), 14); setStage(S.approved ? "execute" : S.plan ? "plan" : S.fc ? "forecast" : "detect"); }
    else if (key && key.startsWith("site:")) { const s = siteById(key.slice(5)); if (s) Map3D.flyTo(s.lonlat, 20); renderInspector(); }
    renderLeft();
  }

  // ------------------------------------------------------------------ met-ocean HUD + top object chip
  function renderMet() {
    const m = activeMet();
    $("#met").innerHTML = `<div><small>WIND</small><b>${m.wind_kn.toFixed(0)}</b><span> kn</span><svg class="arw" width="12" height="12" viewBox="0 0 16 16" style="transform:rotate(${m.wind_from_deg + 180}deg)"><path d="M8 1 L12 11 L8 8 L4 11 Z" fill="currentColor"/></svg><span class="src">from ${Math.round(m.wind_from_deg)}°</span></div>
      <div><small>CURRENT</small><b>${m.current_kn.toFixed(1)}</b><span> kn</span><svg class="arw" width="12" height="12" viewBox="0 0 16 16" style="transform:rotate(${m.current_to_deg}deg)"><path d="M8 1 L12 11 L8 8 L4 11 Z" fill="currentColor"/></svg><span class="src">to ${Math.round(m.current_to_deg)}°</span></div>
      <div><small>WAVES</small><b>${(m.wave_m || 0).toFixed(1)}</b><span> m</span><span class="src">${m.source === "open-meteo" ? "Open-Meteo · live" : m.source === "scenario" ? "Shamal scenario" : "defaults"}</span></div>`;
  }
  function renderChip() {
    const c = $("#objchip");
    let t, s, btn, act;
    if (!S.det) { t = "HZ-01 · Strait of Hormuz"; s = "No detection yet"; btn = "Run detection"; act = () => runDetect(true); }
    else if (!S.fc) { t = "Computer Vision Detection"; s = `Oil slick · ${polyAreaKm2(S.slick).toFixed(2)} km²`; btn = "Forecast drift"; act = () => { setStage("forecast"); runForecast(); }; }
    else if (!S.plan) { t = "Drift forecast"; s = `${S.fc.impacts.filter((i) => (siteById(i.site_id) || {}).kind !== "lane").length} sites at risk · landfall ${S.fc.stats.first_landfall_h != null ? "+" + S.fc.stats.first_landfall_h + " h" : "none"}`; btn = "Task assets"; act = openMetrics; }
    else if (!S.approved) { t = "Response plan"; s = `${S.plan.plan.assignments.length} assignments · awaiting approval`; btn = "Approve"; act = approve; }
    else { t = "In execution"; s = `${S.plan.plan.assignments.length} assets tasked`; btn = "Board"; act = () => setView("board"); }
    c.innerHTML = `<span class="oi"><i data-lucide="crosshair"></i></span><div><b>${esc(t)}</b><small>${esc(s)}</small></div><button class="tools" id="chip-loc" title="Zoom to object"><i data-lucide="locate-fixed"></i></button><button class="go" id="chip-go">${esc(btn)} <i data-lucide="arrow-right"></i></button><button class="xx" id="chip-x" title="Hide"><i data-lucide="x"></i></button>`;
    c.classList.toggle("on", S.chipHidden !== t); icons(c); $("#chip-go").onclick = act;
    $("#chip-loc").onclick = () => Map3D.flyTo(S.slick ? centroid(S.slick) : DEFAULT_LL, S.slick ? 14 : 60);
    $("#chip-x").onclick = () => { S.chipHidden = t; c.classList.remove("on"); };
  }

  // ------------------------------------------------------------------ inspector (object view)
  function setStage(st) { S.stage = st; if (S.view !== "ops") setView("ops"); renderInspector(); }
  const sec = (key, icon, title, body, open) => { const o = S.collapsed[key] == null ? open !== false : !S.collapsed[key]; return `<div class="sec"><div class="sec-h" data-sec="${key}"><i data-lucide="${icon}"></i>${title}<i data-lucide="${o ? "chevron-down" : "chevron-right"}" class="cv"></i></div>${o ? `<div class="sec-b">${body}</div>` : ""}</div>`; };
  function renderInspector() {
    const I = $("#inspector");
    const head = (ic, cls, t, s) => `<div class="ov-h"><span class="oi ${cls || ""}"><i data-lucide="${ic}"></i></span><div><b>${t}</b><small>${s}</small></div></div>`;
    const kv = (rows) => `<div class="kvl">${rows.map(([a, b, c, l]) => `<span>${a}</span><b class="${c || ""}"${l ? ` data-link="${l}"` : ""}>${b}</b>`).join("")}</div>`;
    let h = "";
    if (S.sel && S.sel.startsWith("res:")) {
      const r = resById(S.sel.slice(4)) || {}, a = S.plan && S.plan.plan.assignments.find((q) => q.resource_id === r.id);
      h = head(TYPE_ICON[r.type] || "ship", "bl", esc(r.name), `${TYPE_NAME[r.type] || r.type} · ${esc(r.base)}`) +
        kv([["Status", a ? (S.approved ? "Tasked" : "Proposed") : r.status], ["Capability", cap(r)], ["Crew", r.crew || "—"], ["Base", esc(r.base), "lk", "res"], ["Data", r.sample ? "sample inventory" : "added by user"]]) +
        `<div class="btn-row"><button class="bp-btn out" id="back-stage">Back to ${S.stage}</button><button class="bp-btn" id="res-open"><i data-lucide="boxes"></i>Open in inventory</button></div>` +
        (a ? sec("res-a", "crosshair", "Assignment", `<div class="prop"><span>Task</span><b>${esc(a.task)}</b></div><div class="prop"><span>ETA</span><b>+${(+a.eta_h).toFixed(1)} h</b></div><div class="prop"><span>Why</span><b>${esc(a.reason)}</b></div>`) : "") +
        sec("res-hw", "box", "3D model", `<canvas id="res-hw" style="width:100%;height:170px;display:block;background:radial-gradient(circle at 50% 45%,#1d2630,#0a0d10)"></canvas>`);
    } else if (S.sel && S.sel.startsWith("site:")) {
      const s = siteById(S.sel.slice(5)) || {}, im = S.fc && S.fc.impacts.find((i) => i.site_id === s.id), cl = S.plan && (S.plan.plan.closures || []).find((c) => c.site_id === s.id);
      h = head(SITE_ICON[s.kind] || "map-pin", im ? "" : "bl", esc(s.name), `${esc(s.kind)} · ${esc(s.country)}`) +
        kv([["Status", im ? (S.hour >= im.eta_h ? "Oiled (forecast)" : `At risk · ETA +${im.eta_h} h`) : "Clear"], ["Data source", "SpillSight sites", "lk", "data"], ["Layer", "Sensitive sites", "lk", "layers"], ["Position", Geo.fmtLL(s.lonlat || DEFAULT_LL), "mono"], ["Accuracy", "approximate"]]) +
        `<div class="act-row"><button class="bp-btn out w" id="back-stage">Back to ${S.stage} <i data-lucide="chevron-down"></i></button></div>` +
        sec("site-d", "info", "Details", `<div class="prop"><span>Description</span><b>${esc(s.note || "")}</b></div>${im ? `<div class="prop"><span>Particles within 4 km</span><b>${im.n}</b></div>` : ""}${cl ? `<div class="prop"><span>Planned action</span><b>${esc(cl.action)} from +${cl.from_h} h</b></div><div class="prop"><span>Reason</span><b>${esc(cl.reason)}</b></div>` : ""}`);
    } else if (S.stage === "detect") {
      const d = S.det, inst = d && d.instances.slice().sort((a, b) => b.score - a.score)[0];
      h = head("crosshair", "", d ? "Computer Vision Detection" : "New image", d ? "Oil slick · SAM 3.1" : "Satellite, aircraft or drone") +
        kv([["Latest image", d ? "a few seconds ago" : "—"], ["Data source", S.upload ? "Uploaded image" : "Sentinel-1 SAR (simulated)", "lk", "data"], ["Layer", "Detections", "lk", "layers"], ["Model", "SAM 3.1"], ["Confidence", inst ? (inst.score * 100).toFixed(0) + "%" : "—"], ["Area", S.slick ? polyAreaKm2(S.slick).toFixed(2) + " km²" : "—"], ["Classification", "SIMULATED"]]) +
        `<div class="btn-row"><button class="bp-btn" id="d-sample"><i data-lucide="database"></i>Cached result</button><button class="bp-btn blue" id="d-run"><i data-lucide="sparkles"></i>Run SAM 3.1</button></div>` +
        (d ? `<div class="act-row"><button class="bp-btn olive w" id="d-next">Forecast drift <i data-lucide="arrow-right"></i></button></div>` : "") +
        sec("img", "image", "Image preview", `<div class="thumb" id="src"><img src="${S.upload || S.srcImg}" id="src-img"><svg class="ov" id="src-ov" preserveAspectRatio="none"></svg>${S.upload ? '<span class="tg bp-tag blue">UPLOAD</span>' : ""}<button class="exp" id="img-exp" title="Open full size"><i data-lucide="expand"></i></button></div>`) +
        sec("sensor", "satellite", "Sensor", `<div class="sensor"><canvas id="sat-canvas"></canvas><div><b>Sentinel-1 SAR pass</b><small>C-band radar shows oil as dark, smooth water, through cloud and at night.</small></div></div>`) +
        sec("prompt", "text-cursor-input", "Prompt & source", `<label class="field">Concept prompt<input id="d-prompt" value="dark oil slick"></label><label class="field">Upload image<input type="file" id="d-file" accept="image/*"></label><div style="color:#738091;margin-top:6px">Live run $0.0025. Footprint 6 km wide at ${Geo.fmtLL(S.footprintCenter || DEFAULT_LL)}; right-click the map to move it.</div>`, !d) +
        sec("props", "list", "Properties", `<div class="subh">Featured properties</div><div class="prop"><span>Timestamp</span><b>${new Date(S.detT || Date.now()).toUTCString().replace("GMT", "UTC")}</b></div><div class="prop"><span>Centre</span><b>${S.slick ? Geo.fmtLL(centroid(S.slick)) : "—"}</b></div><div class="prop"><span>API cost</span><b>$${d ? (d.cost_usd || 0).toFixed(4) : "0.0000"}</b></div><div class="subh">Additional properties</div><div class="prop"><span>Instances</span><b>${d ? d.instances.length : 0}</b></div><div class="prop"><span>Image size</span><b>${d ? d.image_size.join(" × ") + " px" : "—"}</b></div>`, !!d) +
        sec("enh", "circle-plus", "Enhancements", `<div style="color:#8f99a8">Mask decoded from SAM run-length output → contour → simplified polygon → georeferenced to the image footprint.</div>`, false);
    } else if (S.stage === "forecast") {
      const f = S.fc, m = activeMet(), real = f ? f.impacts.filter((i) => (siteById(i.site_id) || {}).kind !== "lane") : [];
      h = head("wind", "bl", "Drift forecast", "Lagrangian particles · 72 h") +
        kv([["Particles", f ? f.particles : 300], ["Horizon", "72 h"], ["Wind", `${m.wind_kn.toFixed(1)} kn from ${Math.round(m.wind_from_deg)}°`], ["Current", `${m.current_kn.toFixed(2)} kn to ${Math.round(m.current_to_deg)}°`], ["Data source", m.source === "open-meteo" ? "Open-Meteo (live)" : "Shamal scenario (what-if)", "lk", "data"], ["First landfall", f && f.stats.first_landfall_h != null ? "+" + f.stats.first_landfall_h + " h" : "—"], ["Ashore at 24 h", f ? f.stats.ashore_pct["24"] + "%" : "—"]]) +
        `<div class="act-row"><div class="seg" style="grid-template-columns:1fr 1fr"><button data-met="live" class="${S.metMode === "live" ? "on" : ""}"><i data-lucide="satellite-dish"></i>Live · Open-Meteo</button><button data-met="scenario" class="${S.metMode === "scenario" ? "on" : ""}"><i data-lucide="wind"></i>Shamal scenario</button></div></div>` +
        `<div class="btn-row"><button class="bp-btn blue" id="f-run" ${S.slick ? "" : "disabled"}><i data-lucide="play"></i>${f ? "Re-run" : "Run"} forecast</button>${f ? '<button class="bp-btn olive" id="f-next">Task assets <i data-lucide="arrow-right"></i></button>' : ""}</div>` +
        (f ? sec("risk", "shield-alert", `Shoreline at risk (${real.length})`, real.length ? real.map((im) => { const s = siteById(im.site_id); const live = S.hour >= im.eta_h; return `<div class="rowl" data-site="${s.id}" style="cursor:pointer"><span class="ic"><i data-lucide="${SITE_ICON[s.kind] || "map-pin"}"></i></span><div><b>${esc(s.name)}</b><small>${s.kind} · ${s.country} · ${im.n} particles</small></div><div class="r">+${im.eta_h} h<br><span class="bp-tag ${live ? "red" : "orange"}">${live ? "OILED" : "IN " + Math.max(0, Math.ceil(im.eta_h - S.hour)) + " H"}</span></div></div>`; }).join("") : '<div class="empty">No sensitive site reached within 72 h.</div>') : "") +
        (f ? sec("lanes", "waypoints", "Traffic & exposure", f.impacts.filter((i) => (siteById(i.site_id) || {}).kind === "lane").map((im) => `<div class="rowl"><span class="ic"><i data-lucide="waypoints"></i></span><div><b>${esc(siteById(im.site_id).name)}</b><small>floating oil within 2 km</small></div><div class="r">+${im.eta_h} h</div></div>`).join("") || '<div style="color:#738091">Lanes clear.</div>', false) : "") +
        sec("model", "cpu", "Model", `<div class="prop"><span>Physics</span><b>current + 3% wind + random walk (K = 3 m²/s), hourly steps, beaching on the Natural Earth 10m coastline</b></div><div class="prop"><span>Limits</span><b>uniform met field, no weathering or tides; not yet validated by hindcast</b></div>`, false);
    } else if (S.stage === "plan") {
      const P = S.plan;
      if (!P) h = head("sparkles", "vi", "Response plan", "Muse Wonder") + `<div class="act-row"><button class="bp-btn olive w" id="p-open" ${S.fc ? "" : "disabled"}><i data-lucide="sliders-horizontal"></i>Choose metrics &amp; recommend</button></div>`;
      else {
        h = head("sparkles", "vi", "Response plan", `${P.source === "rules" ? "Rules planner (fallback)" : "Muse Wonder"} · ${P.plan.assignments.length} assignments`) +
          `<div class="pairc"><div class="t"><i data-lucide="ship"></i>${P.plan.assignments.length} assets <i data-lucide="arrow-right"></i> Oil slick<span class="bp-tag ${S.approved ? "green" : "orange"}">${S.approved ? "APPROVED" : "PROPOSED"}</span></div><div class="kvl"><span>Time on target</span><b class="mono">${fmtH(Math.min(...P.plan.assignments.map((a) => +a.eta_h || 0)))}</b><span>Created</span><b>${ago(S.planT)} by Muse Wonder</b><span>Closures</span><b>${(P.plan.closures || []).length}</b><span>Cost</span><b class="mono">$${(P.cost_usd || 0).toFixed(4)}</b></div></div>` +
          `<div style="padding:0 12px 8px;color:#abb3bf">${esc(P.plan.summary || "")}</div>` +
          sec("asg", "ship", "Assignments", P.plan.assignments.map((a) => { const r = resById(a.resource_id) || { name: a.resource_id, type: "vessel" }; return `<div class="rowl" data-rsel="${esc(a.resource_id)}" style="cursor:pointer"><span class="ic"><i data-lucide="${TYPE_ICON[r.type] || "ship"}"></i></span><div><b>${esc(r.name)}</b><small>${esc(a.task)}</small><small style="color:#bdabff;display:block">Why: ${esc(a.reason)}</small></div><div class="r">+${(+a.eta_h).toFixed(1)} h<br><span class="bp-tag vi">${(+a.score).toFixed(2)}</span></div></div>`; }).join("")) +
          sec("booms", "waves", "Booms", (P.plan.booms || []).map((b) => `<div class="rowl"><span class="ic" style="color:#fbd065"><i data-lucide="waves"></i></span><div><b>${esc(b.kind)} · ${b.length_m} m at ${b.angle_deg}°</b><small>${esc(b.site_id ? (siteById(b.site_id) || {}).name || b.site_id : "slick leading edge")} — ${esc(b.reason)}</small></div><div></div></div>`).join("")) +
          sec("cl", "ban", "Closures & advisories", (P.plan.closures || []).map((c) => `<div class="rowl"><span class="ic" style="color:#e76a6e"><i data-lucide="ban"></i></span><div><b>${esc(c.action)} · ${esc((siteById(c.site_id) || {}).name || c.site_id)}</b><small>${esc(c.reason)}</small></div><div class="r">+${c.from_h} h</div></div>`).join("") + (P.plan.advisories || []).map((a) => `<div class="rowl"><span class="ic" style="color:#bdabff"><i data-lucide="megaphone"></i></span><div><b>${esc(a.kind)} · ${a.radius_km} km</b><small>${esc(a.reason)}</small></div><div></div></div>`).join("")) +
          sec("risks", "triangle-alert", "Risks flagged", (P.plan.risks || []).map((r) => `<div class="prop"><b>${esc(r)}</b></div>`).join(""), false) +
          `<div class="approve"><span class="who" title="Incident lead"><b>RM</b></span>${S.approved ? '<span class="bp-tag green"><i data-lucide="check"></i>APPROVED</span>' : `<button class="bp-btn red" id="p-reject"><i data-lucide="x"></i>Reject</button><button class="bp-btn" id="p-re"><i data-lucide="refresh-cw"></i>Reassign</button><button class="bp-btn blue" id="p-ok">Approve <i data-lucide="arrow-right"></i></button>`}</div>`;
      }
    } else {
      h = head("navigation", "gr", "Execution", S.approved ? `${S.plan.plan.assignments.length} assets tasked` : "No approved plan");
      if (S.approved) {
        const now = performance.now() / 1000;
        h += kv([["Approved", ago(S.approvedT) + " by RM"], ["Status", S.execDone ? "Boom closed · recovering" : "Assets en route"], ["Layer", "Missions", "lk", "board"]]) +
          sec("mis", "ship", "Missions", S.plan.plan.assignments.map((a) => { const r = resById(a.resource_id) || { name: a.resource_id, type: "vessel" }; const k = clamp((now - S.execT0 - (a._delay || 0)) / (a._dur || 8), 0, 1); return `<div class="rowl" data-rsel="${esc(a.resource_id)}" style="cursor:pointer"><span class="ic"><i data-lucide="${TYPE_ICON[r.type] || "ship"}"></i></span><div><b>${esc(r.name)}</b><small>${esc(a.task)}</small><div class="mbar2"><i style="width:${(k * 100).toFixed(0)}%"></i></div></div><div class="r"><span class="bp-tag ${k >= 1 ? "green" : "blue"}">${k >= 1 ? "ON SCENE" : "EN ROUTE"}</span></div></div>`; }).join("")) +
          sec("act", "activity", "Activity", `<div class="log">${S.log.map((l) => `<div class="ln"><em>${l.t}</em><i style="background:${l.color}"></i><div>${l.msg}</div></div>`).join("")}</div>`);
      } else h += '<div class="empty">Approve a plan to start execution.</div>';
    }
    I.innerHTML = h; icons(I); bindInspector(); renderChip();
  }
  function bindInspector() {
    const I = $("#inspector"), on = (id, f) => { const e = $(id, I); if (e) e.addEventListener("click", f); };
    $$("[data-sec]", I).forEach((e) => (e.onclick = () => { const k = e.dataset.sec, cur = S.collapsed[k]; S.collapsed[k] = cur == null ? true : !cur; renderInspector(); }));
    if ($("#sat-canvas", I)) HW.viewer($("#sat-canvas", I), { space: true }).show("satellite");
    const img = $("#src-img", I); if (img) { img.onload = drawSrcOverlay; drawSrcOverlay(); }
    on("#d-run", () => runDetect(false)); on("#d-sample", () => runDetect(true)); on("#d-next", () => { setStage("forecast"); runForecast(); });
    const fi = $("#d-file", I); if (fi) fi.addEventListener("change", () => { const f = fi.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => { S.upload = rd.result; renderInspector(); }; rd.readAsDataURL(f); });
    $$("[data-met]", I).forEach((b) => (b.onclick = () => { S.metMode = b.dataset.met; renderMet(); renderInspector(); }));
    $$("[data-site]", I).forEach((e) => (e.onclick = () => selectObj("site:" + e.dataset.site)));
    $$("[data-rsel]", I).forEach((e) => (e.onclick = () => { S.sel = "res:" + e.dataset.rsel; const p = Map3D.assetPos(e.dataset.rsel); if (p) Map3D.flyTo(Geo.toLonLat(p.x, p.z), 14); renderInspector(); }));
    on("#f-run", runForecast); on("#f-next", openMetrics); on("#p-open", openMetrics); on("#p-re", openMetrics); on("#p-ok", approve);
    on("#back-stage", () => { S.sel = null; renderInspector(); renderLeft(); });
    on("#res-open", () => { const r = resById(S.sel.slice(4)); if (r) { S.hwType = r.type; S.resFilter = r.type; S.resSel = r.id; } setView("res"); });
    if ($("#res-hw", I)) HW.viewer($("#res-hw", I)).show((resById(S.sel.slice(4)) || {}).type || "vessel");
    $$("[data-link]", I).forEach((e) => (e.onclick = () => { const l = e.dataset.link; if (l === "layers") { S.tab = "layers"; syncRail(); renderLeft(); } else setView(l); }));
    on("#img-exp", () => { $("#mbox").innerHTML = `<div class="mm-h" style="font-size:14px">Image preview<span class="ic"><i data-lucide="x" id="lb-x" style="cursor:pointer"></i></span></div><div class="lightbox" style="position:relative"><img src="${S.upload || S.srcImg}"><svg class="ov" style="position:absolute;inset:0;width:100%;height:100%" preserveAspectRatio="none" viewBox="${$("#src-ov") ? $("#src-ov").getAttribute("viewBox") || "" : ""}">${$("#src-ov") ? $("#src-ov").innerHTML : ""}</svg></div>`; $("#mbox").style.width = "auto"; $("#modal").classList.add("on"); icons($("#mbox")); $("#lb-x").onclick = () => { $("#modal").classList.remove("on"); $("#mbox").style.width = ""; }; });
    on("#p-reject", () => { S.plan = null; Map3D.setBooms([]); S.board = S.board.filter((c) => c.kind !== "asg"); moveCards((c) => c.kind !== "asg", "pairing"); renderInspector(); renderLeft(); toast('<i data-lucide="x"></i>Plan rejected', "rd"); });
  }
  function drawSrcOverlay() {
    const svg = $("#src-ov"), img = $("#src-img"); if (!svg || !img || !S.det || S.det._src !== (S.upload || S.srcImg)) { if (svg) svg.innerHTML = ""; return; }
    const [w, h] = S.det.image_size || [img.naturalWidth, img.naturalHeight];
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.innerHTML = S.det.instances.map((it) => `<polygon points="${it.polygon.map((p) => p.join(",")).join(" ")}" fill="rgba(229,72,77,.22)" stroke="#e5484d" stroke-width="${Math.max(2, w / 320)}"/><rect x="${it.box[0]}" y="${it.box[1]}" width="${it.box[2] - it.box[0]}" height="${it.box[3] - it.box[1]}" fill="none" stroke="#fbd065" stroke-width="${Math.max(1.5, w / 600)}"/><text x="${it.box[0] + 6}" y="${it.box[1] - 8}" fill="#fbd065" font-size="${w / 40}" font-family="sans-serif" font-weight="600">oil slick ${(it.score * 100).toFixed(0)}%</text>`).join("");
  }

  // ------------------------------------------------------------------ detect
  function footprintFor(w, h) {
    const c = S.footprintCenter || DEFAULT_LL, hwKm = 3, hhKm = 3 * h / w;
    const dLon = hwKm / (111.32 * Math.cos((c[1] * Math.PI) / 180)), dLat = hhKm / 110.57;
    return [[c[0] - dLon, c[1] + dLat], [c[0] + dLon, c[1] + dLat], [c[0] + dLon, c[1] - dLat], [c[0] - dLon, c[1] - dLat]];
  }
  function pxToLL(p, w, h, fp) {
    const u = p[0] / w, v = p[1] / h, [TL, TR, BR, BL] = fp;
    const top = [TL[0] + (TR[0] - TL[0]) * u, TL[1] + (TR[1] - TL[1]) * u], bot = [BL[0] + (BR[0] - BL[0]) * u, BL[1] + (BR[1] - BL[1]) * u];
    return [top[0] + (bot[0] - top[0]) * v, top[1] + (bot[1] - top[1]) * v];
  }
  async function imgB64(src) {
    const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    const c = document.createElement("canvas"), k = Math.min(1, 1280 / Math.max(im.width, im.height)); c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
    c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
    return { b64: c.toDataURL("image/jpeg", 0.9).split(",")[1], w: c.width, h: c.height };
  }
  async function runDetect(cached) {
    if (S.stage !== "detect") setStage("detect");
    const btn = cached ? $("#d-sample") : $("#d-run"); if (btn) { btn.disabled = true; btn.innerHTML = '<i data-lucide="loader"></i>Segmenting…'; icons(btn); }
    const src = $("#src"); const sc = document.createElement("div"); sc.className = "scan"; if (src) src.appendChild(sc);
    try {
      let d; const srcUrl = S.upload || S.srcImg;
      if (cached && !S.upload) d = await API.detectSample();
      else { const { b64, w, h } = await imgB64(srcUrl); d = await API.detect({ image_b64: b64, prompt: ($("#d-prompt") || {}).value || "dark oil slick", footprint: footprintFor(w, h) }); }
      if (!d.instances || !d.instances.length) { toast('<i data-lucide="triangle-alert"></i>SAM 3.1 found no oil in this image. Try another prompt.', "or"); return; }
      d._src = srcUrl; S.det = d; S.detT = Date.now();
      const [w, h] = d.image_size;
      S.footprint = d.footprint || footprintFor(w, h);
      const best = d.instances.slice().sort((a, b) => b.score - a.score)[0];
      S.slick = best.polygon_lonlat && best.polygon_lonlat.length > 2 ? best.polygon_lonlat : best.polygon.map((p) => pxToLL(p, w, h, S.footprint));
      Map3D.setImageOverlay(srcUrl, S.footprint, 0.32); Map3D.setSlick(S.slick); Map3D.slickOpacity(1);
      Map3D.clearMarkers("det");
      Map3D.marker({ kind: "det", icon: "crosshair", label: "Computer Vision Detection", sub: `oil slick · ${(best.score * 100).toFixed(0)}%`, lonlat: centroid(S.slick), group: "det", y: 0.4, onClick: () => selectObj("slick") });
      Map3D.flyTo(centroid(S.slick), 13, { el: 0.95 });
      cvCard("Computer Vision Detection", `Oil slick · SAM 3.1 · ${(best.score * 100).toFixed(0)}%`);
      if (!S.board.some((c) => c.kind === "det")) { const c = card("det", "Computer Vision Detection", `Oil slick · ${polyAreaKm2(S.slick).toFixed(2)} km²`, "detected", { tot: "Time on target:pending" }); setTimeout(() => { c.col = "triage"; renderBoard(); }, 1400); }
      S.sel = "slick"; log(`Detection · SAM 3.1 · ${(best.score * 100).toFixed(0)}% · ${polyAreaKm2(S.slick).toFixed(2)} km²`, "#e76a6e");
      fetchMet(centroid(S.slick)); refreshBudget(); renderLeft();
    } catch (e) { toast(`<i data-lucide="triangle-alert"></i>Detect failed: ${esc(e.message)}`, "rd"); }
    finally { sc.remove(); renderInspector(); }
  }
  function cvCard(t, s) { const c = $("#cvd"); c.innerHTML = `<div class="cvcard"><span class="ic"><i data-lucide="crosshair"></i></span><div><b>${esc(t)}</b><small>${esc(s)}</small></div></div>`; icons(c); c.classList.remove("on"); void c.offsetWidth; c.classList.add("on"); clearTimeout(cvCard.t); cvCard.t = setTimeout(() => c.classList.remove("on"), 4500); }

  // ------------------------------------------------------------------ forecast
  async function fetchMet(ll) { try { S.met = await API.metocean(ll); renderMet(); if (S.stage === "forecast") renderInspector(); } catch (e) { /* server not ready */ } }
  async function runForecast() {
    const b = $("#f-run"); if (b) { b.disabled = true; b.innerHTML = '<i data-lucide="loader"></i>Running 300 particles…'; icons(b); }
    try {
      const f = await API.forecast({ slick: S.slick, hours: 72, n: 300, metocean: activeMet() });
      S.fc = f; Map3D.setForecast(f); Map3D.setHour(0, 0); Map3D.fadeImage(0); Map3D.slickOpacity(0);
      const real = f.impacts.filter((im) => { const s = siteById(im.site_id); return s && s.kind !== "lane"; });
      Map3D.setRisk([]);
      const land = f.tracks.map((tr, i) => (f.beach_h[i] != null ? tr[Math.min(f.beach_h[i], tr.length - 1)] : null)).filter(Boolean);
      Map3D.setLanding(land); Map3D.clearMarkers("land");
      if (land.length) Map3D.marker({ kind: "det", icon: "triangle-alert", label: `Landfall +${f.stats.first_landfall_h} h`, sub: `${land.length} of ${f.particles} particles ashore`, lonlat: centroid(land), group: "land", y: 0.3 });
      Object.entries(S.siteMk).forEach(([id, m]) => m.el.classList.toggle("atrisk", real.some((i) => i.site_id === id)));
      S.board = S.board.filter((c) => c.kind !== "site");
      real.slice(0, 8).forEach((im) => { const s = siteById(im.site_id); card("site", s.name, `Shoreline impact · ${s.kind}`, "pairing", { tot: `Time to landfall:+${im.eta_h} h`, warn: im.eta_h <= 12 }); });
      moveCards((c) => c.kind === "det", "pairing");
      S.board.filter((c) => c.kind === "det").forEach((c) => (c.tot = `Time to landfall:${f.stats.first_landfall_h != null ? "+" + f.stats.first_landfall_h + " h" : "none"}`));
      $("#tl-marks").innerHTML = f.stats.first_landfall_h != null ? `<i style="left:${(100 * f.stats.first_landfall_h) / 72}%"><span>LANDFALL +${f.stats.first_landfall_h} H</span></i>` : "";
      $("#tl-mode").textContent = "DRIFT FORECAST";
      const pts = real.map((im) => siteById(im.site_id).lonlat).concat([centroid(S.slick)]);
      const c = centroid(pts); const spread = Math.max(...pts.map((p) => Geo.km(p, c)));
      Map3D.flyTo(c, clamp(spread * 2.6, 40, 150), { el: 0.9 });
      play(0);
      if (S.contOpt && S.plan && !S.approved) { toast('<i data-lucide="refresh-cw"></i>Forecast changed: re-planning', "vi"); setTimeout(runPlan, 300); }
      log(`Forecast · ${f.particles} particles · landfall ${f.stats.first_landfall_h != null ? "+" + f.stats.first_landfall_h + " h" : "none"} · ${real.length} sites at risk`, "#4c90f0");
      renderLeft();
    } catch (e) { toast(`<i data-lucide="triangle-alert"></i>Forecast failed: ${esc(e.message)}`, "rd"); }
    renderInspector();
  }
  let playT = null;
  function play(from) { S.playing = true; S.hour = from || 0; const t0 = performance.now(); clearInterval(playT); $("#tl-play").innerHTML = '<i data-lucide="pause"></i>'; icons($("#tl-play"));
    playT = setInterval(() => { S.hour = clamp((from || 0) + ((performance.now() - t0) / 1000) * 6, 0, 72); setHour(S.hour); if (S.hour >= 72) stop(); }, 50); }
  function stop() { S.playing = false; clearInterval(playT); $("#tl-play").innerHTML = '<i data-lucide="play"></i>'; icons($("#tl-play")); }
  let lastRender = 0;
  function setHour(h) {
    S.hour = h; Map3D.setHour(h, performance.now() / 1000);
    $("#tl-time").textContent = fmtH(h); $("#tl-fill").style.width = (100 * h) / 72 + "%"; $("#tl-knob").style.left = (100 * h) / 72 + "%";
    if (S.stage === "forecast" && performance.now() - lastRender > 500) { lastRender = performance.now(); renderInspector(); renderLeft(); }
  }

  // ------------------------------------------------------------------ AI metrics (indigo) + recommender
  const METRICS = [["time", "Time to Site"], ["capacity", "Capacity"], ["distance", "Distance"], ["sensitivity", "Site Sensitivity"], ["endurance", "Endurance"], ["readiness", "Crew Readiness"]];
  function gaugeSVG(v) {
    const cx = 40, cy = 40, r = 30, a1 = Math.PI, a2 = Math.PI - (Math.PI * v) / 100;
    const P = (a, rr) => [cx + Math.cos(a) * rr, cy - Math.sin(a) * rr];
    let grid = ""; for (let k = 0; k <= 6; k++) { const a = Math.PI - (Math.PI * k) / 6, p = P(a, r); grid += `<line x1="${cx}" y1="${cy}" x2="${p[0].toFixed(1)}" y2="${p[1].toFixed(1)}" stroke="#7b78c9" stroke-width=".6"/>`; }
    for (const rr of [r * 0.5, r]) grid += `<path d="M${cx - rr} ${cy} A${rr} ${rr} 0 0 1 ${cx + rr} ${cy}" fill="none" stroke="#7b78c9" stroke-width=".6"/>`;
    const p1 = P(a1, r), p2 = P(a2, r), lab = P(a2, r + 9);
    return `<svg class="g" width="96" height="54" viewBox="0 0 80 48">${grid}<path d="M${cx} ${cy} L${p1[0]} ${p1[1]} A${r} ${r} 0 0 1 ${p2[0].toFixed(2)} ${p2[1].toFixed(2)} Z" fill="#bdb9f2" fill-opacity=".85"/><text x="${lab[0].toFixed(1)}" y="${(lab[1] + 3).toFixed(1)}" fill="#ecebff" font-size="8" font-weight="700" text-anchor="middle" transform="rotate(${(-((a2 * 180) / Math.PI) + 90).toFixed(0)} ${lab[0].toFixed(1)} ${(lab[1] + 3).toFixed(1)})">${v}</text></svg>`;
  }
  function openMetrics() {
    if (!S.fc) { toast('<i data-lucide="info"></i>Run a forecast first', "or"); return; }
    const W = S.weights, ready = S.resources.filter((r) => r.status === "ready"), real = S.fc.impacts.filter((i) => (siteById(i.site_id) || {}).kind !== "lane");
    const draw = () => {
      $("#mbox").innerHTML = `<div class="mm-h">Choose which metrics AI should prioritize<span class="ic"><button id="mm-info" title="How the recommender works"><i data-lucide="info"></i></button><button id="mm-x" title="Close"><i data-lucide="x"></i></button></span></div>${S.mmHelp ? `<div class="metric-help">Each gauge is a weight sent to <b>Muse Wonder</b> with the live forecast, threatened sites and every ready asset (distance and ETA computed on the server). It returns strict JSON: one assignment per asset with a score and a plain-English reason, plus booms, closures and advisories. Same inputs are cached, so re-running costs nothing; new inputs cost about $0.02. Without a key the rules planner answers instead.</div>` : ""}
        <div class="mm-ctx"><span><b>${ready.length}</b> ready assets</span><span><b>${real.length}</b> threatened sites</span><span>first landfall <b>${S.fc.stats.first_landfall_h != null ? "+" + S.fc.stats.first_landfall_h + " h" : "none"}</b></span><span>model <b>Muse Wonder</b></span></div>
        <div class="gauges">${METRICS.map(([k, n]) => `<div class="gauge"><div class="t">${n}<span class="x" data-z="${k}" title="Ignore this metric">×</span></div>${gaugeSVG(W[k])}<div class="st"><button data-m="${k}" data-d="-10">−</button>${W[k]}<button data-m="${k}" data-d="10">+</button></div></div>`).join("")}</div>
        <div class="mm-f"><button id="mm-go"><i data-lucide="hammer"></i>Optimize Recommender</button><button id="mm-cont"><i data-lucide="${S.contOpt ? "refresh-cw" : "pause"}"></i>Auto re-plan on new forecast: ${S.contOpt ? "On" : "Off"}</button></div>`;
      icons($("#mbox"));
      $$("[data-m]").forEach((b) => (b.onclick = () => { W[b.dataset.m] = clamp(W[b.dataset.m] + +b.dataset.d, 0, 100); draw(); }));
      $("#mm-x").onclick = () => $("#modal").classList.remove("on");
      $("#mm-info").onclick = () => { S.mmHelp = !S.mmHelp; draw(); };
      $$("[data-z]").forEach((b) => (b.onclick = () => { W[b.dataset.z] = 0; draw(); }));
      $("#mm-cont").onclick = () => { S.contOpt = !S.contOpt; draw(); };
      $("#mm-go").onclick = runPlan;
    };
    draw(); $("#modal").classList.add("on");
  }
  async function runPlan() {
    const b = $("#mm-go") || { set innerHTML(v) {}, set disabled(v) {} }; b.disabled = true; b.innerHTML = '<i data-lucide="loader"></i>Muse Wonder is planning…'; if (b.nodeType) icons(b);
    try {
      const W = S.weights, tot = W.time + W.capacity + W.distance || 1;
      const impacts = S.fc.impacts.map((im) => { const s = siteById(im.site_id) || {}; return { ...im, name: s.name, kind: s.kind, lonlat: s.lonlat }; });
      const P = await API.plan({ forecast_summary: { ...S.fc.stats, slick_centroid: centroid(S.slick), slick_area_km2: polyAreaKm2(S.slick) }, impacts, resources: S.resources, metocean: activeMet(),
        weights: { time: W.time / tot, capacity: W.capacity / tot, distance: W.distance / tot, site_sensitivity: W.sensitivity / 100, endurance: W.endurance / 100, crew_readiness: W.readiness / 100 } });
      S.plan = P; S.planT = Date.now(); S.approved = false; $("#modal").classList.remove("on");
      showPlanOnMap(); S.board = S.board.filter((c) => c.kind !== "asg");
      P.plan.assignments.forEach((a) => { const r = resById(a.resource_id); card("asg", r ? r.name : a.resource_id, a.task, "paired", { tot: `Time on target:+${(+a.eta_h).toFixed(1)} h`, rid: a.resource_id }); });
      moveCards((c) => c.kind === "site" || c.kind === "det", "paired");
      toast(`<i data-lucide="sparkles"></i>${P.source === "rules" ? "Rules planner" : "Muse Wonder"} paired ${P.plan.assignments.length} assets`, "vi");
      log(`Recommender · ${P.source} · ${P.plan.assignments.length} pairings · $${(P.cost_usd || 0).toFixed(4)}`, "#7961db");
      S.tab = "assets"; syncRail(); setStage("plan"); renderLeft(); refreshBudget();
    } catch (e) { toast(`<i data-lucide="triangle-alert"></i>Plan failed: ${esc(e.message)}`, "rd"); b.disabled = false; b.textContent = "Retry"; }
  }

  // boom geometry: a U around the slick at the containment hour, deflection booms in front of threatened sites
  function containmentU(h) {
    const at = (hh) => S.fc.tracks.map((tr) => { const p = tr[Math.min(Math.round(hh), tr.length - 1)]; return Geo.toWorld(p[0], p[1]); });
    const pts = at(h), mean = (q) => q.reduce((a, p) => [a[0] + p[0] / q.length, a[1] + p[1] / q.length], [0, 0]);
    const c = mean(pts), c2 = mean(at(h + 2));
    let d = [c2[0] - c[0], c2[1] - c[1]]; const l = Math.hypot(d[0], d[1]) || 1; d = [d[0] / l, d[1] / l]; const n = [-d[1], d[0]];
    const us = pts.map((p) => (p[0] - c[0]) * d[0] + (p[1] - c[1]) * d[1]).sort((a, b) => a - b), ws = pts.map((p) => (p[0] - c[0]) * n[0] + (p[1] - c[1]) * n[1]).sort((a, b) => a - b);
    const q = (a, f) => a[Math.floor(f * (a.length - 1))];
    const uM = q(us, 0.04) - 0.2, uA = q(us, 0.96) + 0.5, wc = (q(ws, 0.04) + q(ws, 0.96)) / 2, hw = (q(ws, 0.96) - q(ws, 0.04)) / 2 + 0.5;
    const W2 = (u, w) => Geo.toLonLat(c[0] + d[0] * u + n[0] * w, c[1] + d[1] * u + n[1] * w);
    const half = (side) => { const o = []; for (let k = 0; k <= 24; k++) { const s = k / 24; o.push(W2(uM + (uA - uM) * s, wc + side * hw * Math.sqrt(Math.max(0, 1 - Math.pow(s, 2.4))))); } return o; };
    return { halves: [half(-1), half(1)], mouth: [W2(uM, wc - hw), W2(uM, wc + hw)], apex: W2(uA - 0.4, wc) };
  }
  function deflection(site, angle) {
    const [sx, sz] = Geo.toWorld(site.lonlat[0], site.lonlat[1]), c = S.fc.tracks[0][0], [cx, cz] = Geo.toWorld(c[0], c[1]);
    let o = [cx - sx, cz - sz]; const l = Math.hypot(o[0], o[1]) || 1; o = [o[0] / l, o[1] / l];
    const a = ((angle || 30) * Math.PI) / 180, r = [o[0] * Math.cos(a) - o[1] * Math.sin(a), o[0] * Math.sin(a) + o[1] * Math.cos(a)];
    const p0 = [sx + o[0] * 0.5, sz + o[1] * 0.5], p1 = [p0[0] + r[0] * 2.5, p0[1] + r[1] * 2.5];
    return [Geo.toLonLat(p0[0], p0[1]), Geo.toLonLat((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2), Geo.toLonLat(p1[0], p1[1])];
  }
  function showPlanOnMap() {
    const P = S.plan.plan, hC = clamp(Math.min(...P.assignments.map((a) => +a.eta_h || 4)), 2, 24);
    S.U = containmentU(hC); S.hC = hC;
    const lines = [...S.U.halves];
    (P.booms || []).forEach((b) => { const s = b.site_id && siteById(b.site_id); if (s && s.lonlat) lines.push(deflection(s, b.angle_deg)); });
    Map3D.setBooms(lines); Map3D.boomProgress(1); Map3D.boomOpacity(0.45);
    let mouth = 0;
    P.assignments.forEach((a) => {
      const r = resById(a.resource_id); if (!r) return;
      let to = a.target_lonlat;
      if (/contain|boom|tow|skim|recover/i.test(a.task) && r.type !== "drone" && r.type !== "aircraft") to = mouth < 2 ? S.U.mouth[mouth++] : S.U.apex;
      a._to = to; if (to) Map3D.mission(a.resource_id, to, 1e12, 1);
    });
    // preview where the vessels will sit: tow boats at the two mouth ends, skimmers at the closed end
    const [mx0, mz0] = Geo.toWorld(...S.U.mouth[0]), [mx1, mz1] = Geo.toWorld(...S.U.mouth[1]), [ax, az] = Geo.toWorld(...S.U.apex);
    const up = Math.atan2((mz0 + mz1) / 2 - az, (mx0 + mx1) / 2 - ax), side = [-(mz1 - mz0), mx1 - mx0], sl = Math.hypot(side[0], side[1]) || 1;
    const off = (k) => Geo.toLonLat(ax + (side[0] / sl) * 0.18 * k, az + (side[1] / sl) * 0.18 * k);
    const ahead = (ll) => { const [x, z] = Geo.toWorld(ll[0], ll[1]); return Geo.toLonLat(x + Math.cos(up) * 0.32, z + Math.sin(up) * 0.32); };
    Map3D.setPreview([{ type: "vessel", lonlat: ahead(S.U.mouth[0]), heading: up, scale: 0.62 }, { type: "vessel", lonlat: ahead(S.U.mouth[1]), heading: up, scale: 0.62 },
      { type: "skimmer", lonlat: off(-1), heading: up, scale: 0.34 }, { type: "skimmer", lonlat: off(1), heading: up, scale: 0.34 }]);
  }
  function approve() {
    if (!S.plan) return;
    S.approved = true; S.approvedT = Date.now(); S.execT0 = performance.now() / 1000;
    stop(); setHour(S.hC || 4); $("#tl-mode").textContent = "CONTAINMENT";
    Map3D.boomOpacity(1); Map3D.boomProgress(0); Map3D.setPreview([]);
    S.plan.plan.assignments.forEach((a, i) => { a._delay = i * 0.35; a._dur = clamp(6 + (+a.eta_h || 2) * 0.8, 6, 14); if (a._to) Map3D.mission(a.resource_id, a._to, S.execT0 + a._delay, a._dur); });
    (S.plan.plan.closures || []).forEach((c) => { const m = S.siteMk[c.site_id]; if (m) m.el.classList.add("closed"); });
    moveCards((c) => c.kind === "asg" || c.kind === "det", "exec");
    toast(`<i data-lucide="circle-check"></i>Approved · ${S.plan.plan.assignments.length} assets tasked · ${(S.plan.plan.closures || []).length} closure notices queued`);
    log("Plan approved by incident lead (RM)", "#32a467");
    (S.plan.plan.closures || []).forEach((c) => log(`Notice queued · ${esc(c.action)} · ${esc((siteById(c.site_id) || {}).name || c.site_id)} from +${c.from_h} h`, "#e76a6e"));
    if (S.slick) Map3D.flyTo(centroid(S.slick), 26, { el: 0.85 });
    setStage("execute"); renderLeft();
  }

  // ------------------------------------------------------------------ map context menu
  function ctxMenu(ll, e) {
    const m = $("#ctx"), r = $("#view-ops").getBoundingClientRect();
    m.innerHTML = `<div class="it" data-a="copy"><i data-lucide="locate"></i><span class="mono">${Geo.fmtLL(ll)}</span><i data-lucide="copy" class="r"></i></div><div class="it" data-a="measure"><i data-lucide="ruler"></i>${S.measureA ? "Measure to here" : "Measure distance from here"}</div>
      <div class="it" data-a="nominate"><i data-lucide="circle-plus"></i>Nominate to board</div><div class="it" data-a="foot"><i data-lucide="image"></i>Place image footprint here</div><div class="it" data-a="met"><i data-lucide="wind"></i>Met-ocean at this point</div><hr><div class="it" data-a="base"><i data-lucide="map"></i>Basemap: ${Map3D.getBasemap() === "dark" ? "satellite" : "dark"}</div>`;
    m.style.left = clamp(e.clientX - r.left, 0, r.width - 230) + "px"; m.style.top = clamp(e.clientY - r.top, 0, r.height - 230) + "px"; m.classList.add("on"); icons(m);
    $$("[data-a]", m).forEach((it) => (it.onclick = (ev) => {
      ev.stopPropagation(); m.classList.remove("on");
      if (it.dataset.a === "nominate") { card("det", "Reported sighting", Geo.fmtLL(ll), "detected", { tot: "Time on target:unassessed" }); toast('<i data-lucide="circle-plus"></i>Nominated to board', "or"); log(`Sighting nominated at ${Geo.fmtLL(ll)}`); }
      if (it.dataset.a === "foot") { S.footprintCenter = ll; setStage("detect"); toast(`<i data-lucide="image"></i>Image footprint centred on ${Geo.fmtLL(ll)}`, "or"); }
      if (it.dataset.a === "met") { S.metMode = "live"; fetchMet(ll); toast(`<i data-lucide="wind"></i>Live met-ocean at ${Geo.fmtLL(ll)}`, "or"); }
      if (it.dataset.a === "base") toggleBase();
      if (it.dataset.a === "copy") { navigator.clipboard && navigator.clipboard.writeText(Geo.fmtLL(ll)); toast(`<i data-lucide="copy"></i>Copied ${Geo.fmtLL(ll)}`); }
      if (it.dataset.a === "measure") measure(ll);
    }));
  }
  function measure(ll) {
    if (!S.measureA) { S.measureA = ll; Map3D.clearMarkers("measure"); Map3D.marker({ kind: "site", icon: "ruler", label: "A", lonlat: ll, group: "measure" }); toast('<i data-lucide="ruler"></i>Point A set. Right-click another point and choose “Measure to here”.', "or"); return; }
    const a = S.measureA, d = Geo.km(a, ll), brg = (Math.atan2((ll[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), ll[1] - a[1]) * 180 / Math.PI + 360) % 360;
    Map3D.marker({ kind: "site", icon: "ruler", label: `B · ${d.toFixed(1)} km`, sub: `${(d / 1.852).toFixed(1)} nm · bearing ${brg.toFixed(0)}°`, lonlat: ll, group: "measure" });
    toast(`<i data-lucide="ruler"></i>${d.toFixed(2)} km (${(d / 1.852).toFixed(2)} nm), bearing ${brg.toFixed(0)}°. At 12 kn: ${(d / 1.852 / 12).toFixed(1)} h.`);
    S.measureA = null; setTimeout(() => Map3D.clearMarkers("measure"), 12000);
  }
  function nearby() {
    const p = S.lastLL || (S.slick ? centroid(S.slick) : DEFAULT_LL);
    const ss = S.sites.filter((s) => s.lonlat).map((s) => [s, Geo.km(p, s.lonlat)]).sort((a, b) => a[1] - b[1]).slice(0, 3);
    const rr = S.resources.map((r) => { const q = Map3D.assetPos(r.id); return [r, Geo.km(p, q ? Geo.toLonLat(q.x, q.z) : r.lonlat)]; }).sort((a, b) => a[1] - b[1]).slice(0, 3);
    toast(`<div><b>Nearest to ${Geo.fmtLL(p)}</b><br>${ss.map(([s, d]) => `${esc(s.name)} · ${d.toFixed(1)} km`).join("<br>")}<br><span style="color:#8abbff">${rr.map(([r, d]) => `${esc(r.name)} · ${d.toFixed(1)} km`).join("<br>")}</span></div>`);
  }
  function toggleBase() { Map3D.setBasemap(Map3D.getBasemap() === "dark" ? "sat" : "dark"); $("#t-base").classList.toggle("on", Map3D.getBasemap() === "sat"); }
  document.addEventListener("click", (e) => { if (!e.target.closest("#ctx")) $("#ctx").classList.remove("on"); });

  // ------------------------------------------------------------------ assets view
  const SPEC = { vessel: [["speed_kn", "Speed kn", 12], ["crew", "Crew", 8], ["boom_m", "Boom m", 0]], boom: [["boom_m", "Length m", 500], ["speed_kn", "Tow kn", 0.7], ["crew", "Crew", 4]], skimmer: [["skimmer_m3h", "Rate m³/h", 40], ["crew", "Crew", 3], ["speed_kn", "Speed kn", 0]],
    storage: [["storage_m3", "Storage m³", 1200], ["speed_kn", "Speed kn", 8], ["crew", "Crew", 6]], drone: [["speed_kn", "Speed kn", 40], ["crew", "Crew", 2]], aircraft: [["speed_kn", "Speed kn", 180], ["crew", "Crew", 4]] };
  const BASES = { "Bandar Abbas": [56.21, 27.14], Qeshm: [56.27, 26.95], Khasab: [56.25, 26.2], "Saqr port": [56.05, 25.98] };
  let hwView = null;
  function renderResources() {
    const types = ["all", "vessel", "boom", "skimmer", "storage", "drone", "aircraft"];
    $("#res-filters").innerHTML = types.map((t) => `<button data-f="${t}" class="${S.resFilter === t ? "on" : ""}">${t === "all" ? "All" : `<i data-lucide="${TYPE_ICON[t]}"></i>${TYPE_NAME[t].split(" ").pop()}`}</button>`).join("");
    const rows = S.resources.filter((r) => S.resFilter === "all" || r.type === S.resFilter);
    $("#res-table").innerHTML = `<tr><th>Asset</th><th>Type</th><th>Base</th><th>Capability</th><th>Status</th><th></th></tr>` + rows.map((r) => `<tr data-id="${r.id}" style="${S.resSel === r.id ? "outline:1px solid #b6c94a;outline-offset:-1px" : ""}"><td><div class="nm"><i data-lucide="${TYPE_ICON[r.type]}"></i>${esc(r.name)}${r.sample ? ' <span class="bp-tag">SAMPLE</span>' : ""}</div></td><td>${TYPE_NAME[r.type] || r.type}</td><td>${esc(r.base)}</td><td style="color:#abb3bf">${cap(r)}</td><td><span class="bp-tag ${r.status === "ready" ? "green" : r.status === "busy" ? "orange" : "red"}">${r.status.toUpperCase()}</span></td><td><button class="del" data-del="${r.id}" title="Remove"><i data-lucide="trash-2"></i></button></td></tr>`).join("");
    $("#res-type").innerHTML = Object.keys(TYPE_ICON).map((t) => `<button type="button" data-t="${t}" class="${S.hwType === t ? "on" : ""}"><i data-lucide="${TYPE_ICON[t]}"></i>${TYPE_NAME[t].split(" ").pop()}</button>`).join("");
    $("#res-base").innerHTML = Object.keys(BASES).map((b) => `<option>${b}</option>`).join("");
    $("#res-specs").innerHTML = SPEC[S.hwType].map(([k, l, v]) => `<label>${l}<input name="${k}" type="number" step="any" value="${v}"></label>`).join("");
    $("#hw-title").textContent = TYPE_NAME[S.hwType]; $("#hw-img").src = `assets/img/hw/${S.hwType}.jpg`;
    if (!hwView) hwView = HW.viewer($("#hw-canvas"), { blueprint: true }); hwView.show(S.hwType);
    icons($("#view-res"));
    $$("#res-filters button").forEach((b) => (b.onclick = () => { S.resFilter = b.dataset.f; renderResources(); }));
    $$("#res-type button").forEach((b) => (b.onclick = () => { S.hwType = b.dataset.t; renderResources(); }));
    $$("#res-table tr[data-id]").forEach((tr) => (tr.onclick = () => { S.hwType = resById(tr.dataset.id).type; S.resSel = tr.dataset.id; renderResources(); }));
    $$("[data-del]").forEach((b) => (b.onclick = async (ev) => { ev.stopPropagation(); try { await API.delResource(b.dataset.del); await loadResources(); toast('<i data-lucide="trash-2"></i>Asset removed', "or"); } catch (e) { toast("Remove failed: " + esc(e.message), "rd"); } }));
  }
  $("#res-form").addEventListener("submit", async (ev) => {
    ev.preventDefault(); const fd = new FormData(ev.target), o = { type: S.hwType, sample: false };
    for (const [k, v] of fd.entries()) o[k] = ["name", "base", "status"].includes(k) ? v : +v;
    o.lonlat = BASES[o.base]; ["speed_kn", "boom_m", "skimmer_m3h", "storage_m3", "crew"].forEach((k) => (o[k] = o[k] || 0));
    try { await API.addResource(o); await loadResources(); ev.target.reset(); toast(`<i data-lucide="plus"></i>${esc(o.name)} added to inventory`); log(`Asset added · ${esc(o.name)}`, "#32a467"); } catch (e) { toast("Add failed: " + esc(e.message), "rd"); }
  });
  async function loadResources() {
    S.resources = await API.resources();
    Map3D.setAssets(S.resources); Map3D.clearMarkers("assets");
    S.resources.forEach((r) => Map3D.marker({ kind: "asset", icon: TYPE_ICON[r.type], label: r.name, sub: `${TYPE_NAME[r.type]} · ${r.base}`, group: "assets", get: () => Map3D.assetPos(r.id), onClick: () => { S.sel = "res:" + r.id; if (S.view !== "ops") setView("ops"); renderInspector(); } }));
    renderLeft(); if (S.view === "res") renderResources();
  }

  // ------------------------------------------------------------------ data view
  async function renderData() {
    let L = null; try { L = await API.ledger(); } catch (e) { /* offline */ }
    const m = activeMet();
    const box = (ic, t, p, kv, cls) => `<div class="panelbox ds ${cls || ""}"><h5><i data-lucide="${ic}"></i>${t}</h5><p>${p}</p><div class="kvl">${kv.map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join("")}</div></div>`;
    $("#data-wrap").innerHTML =
      box("crosshair", "Meta SAM 3.1", "Promptable segmentation. Outlines oil in satellite, aircraft and drone images from a text or point prompt.", [["Endpoint", "/v1/responses"], ["Cost", "$0.0025 / image"], ["Used for", "Detect"]]) +
      box("sparkles", "Meta Muse Wonder", "Writes the response plan as strict JSON: pairings, booms, closures and a reason for each.", [["Format", "json_schema strict"], ["Fallback", "rules planner"], ["Used for", "Recommend & plan"]]) +
      box("image", "Meta Muse Image 1.0", "Product imagery for the hardware catalogue (labelled AI-generated).", [["Images", "6"], ["Cost", "$0.01 each"], ["Used for", "Assets"]]) +
      box("wind", "Open-Meteo (live)", "Hourly wind and ocean currents + waves (marine API) at the slick.", [["Wind", S.met ? `${S.met.wind_kn.toFixed(1)} kn` : "—"], ["Current", S.met ? `${S.met.current_kn.toFixed(2)} kn` : "—"], ["In use", m.source === "scenario" ? "Shamal scenario" : "live"]]) +
      box("satellite", "Sentinel-2 cloudless (EOX)", "Basemap imagery, CC BY 4.0. Terrain: AWS Terrain Tiles (open data).", [["Zoom", "11"], ["Extent", `${Geo.R.W.toFixed(0)} × ${Geo.R.H.toFixed(0)} km`], ["Exaggeration", `${Geo.R.exag}×`]]) +
      box("map", "Natural Earth 10m", "Coastline used to stop particles at the shore (beaching).", [["Sites", String(S.sites.filter((s) => s.kind !== "lane").length)], ["Lanes", String(S.sites.filter((s) => s.kind === "lane").length)], ["Coordinates", "approximate"]]) +
      box("gauge", "API budget", "Hard cap on paid Meta calls, shared with the demo video work.", [["Spent", L ? `$${L.total_usd.toFixed(4)}` : "—"], ["Cap", "$2.00"], ["Calls", L ? String(L.entries.length) : "—"]], "wide");
    icons($("#data-wrap"));
  }
  async function refreshBudget() { try { const h = await API.health(); $("#budget span").textContent = `$${(h.spent_usd || 0).toFixed(2)}`; $("#srv").className = "ab-stat ok"; $("#srv").title = h.meta_key ? "Server online · Meta key loaded" : "Server online · offline models"; } catch (e) { $("#srv").className = "ab-stat bad"; $("#srv").title = "Server offline"; } }

  // ------------------------------------------------------------------ views + boot
  function setView(v) {
    S.view = v; $$(".view").forEach((e) => e.classList.toggle("on", e.id === "view-" + v)); $$("#menu [data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
    if (v === "board") { S.sawBoard = true; renderBoard(); } if (v === "res") renderResources(); if (v === "data") renderData();
  }
  $$("#menu [data-view]").forEach((b) => (b.onclick = () => setView(b.dataset.view)));
  $$("[data-view-btn]").forEach((b) => (b.onclick = () => setView(b.dataset.viewBtn)));
  $$("#rail [data-tab]").forEach((b) => (b.onclick = () => { S.tab = b.dataset.tab; syncRail(); renderLeft(); }));
  $("#obj-search").addEventListener("input", renderLeft);
  $("#tl-play").onclick = () => { if (!S.fc) return; S.playing ? stop() : play(S.hour >= 72 ? 0 : S.hour); };
  $("#tl-track").addEventListener("click", (e) => { if (!S.fc) return; const r = e.currentTarget.getBoundingClientRect(); stop(); setHour(clamp((e.clientX - r.left) / r.width, 0, 1) * 72); });
  $("#t-home").onclick = () => Map3D.flyTo([56.3, 26.5], 175, { el: 0.95, az: -0.6 });
  $("#t-slick").onclick = () => S.slick && Map3D.flyTo(centroid(S.slick), 14);
  $("#t-tracks").onclick = (e) => { const b = e.currentTarget; b.classList.toggle("on"); Map3D.setGroupVisible("tracks", b.classList.contains("on")); };
  $("#t-lanes").onclick = (e) => { const b = e.currentTarget; b.classList.toggle("on"); Map3D.setGroupVisible("lanes", b.classList.contains("on")); };
  $("#t-base").onclick = toggleBase;
  setInterval(() => { const d = new Date(); $("#utc").textContent = d.toUTCString().slice(5, 16).toUpperCase() + " " + d.toISOString().slice(11, 19) + "Z"; }, 1000);
  setInterval(() => { if (S.stage === "execute" && S.approved) renderInspector(); if (S.view === "board") renderBoard(); }, 1000);

  // ------------------------------------------------------------------ menus, export, top-bar actions
  function exportReport() {
    const rep = { incident: "HZ-01 Strait of Hormuz (simulated)", exported_utc: new Date().toISOString(),
      detection: S.det ? { model: S.det.model || "sam-3.1", cached: !!S.det.cached, score: Math.max(...S.det.instances.map((i) => i.score)), area_km2: +polyAreaKm2(S.slick).toFixed(3), polygon_lonlat: S.slick } : null,
      metocean: activeMet(), forecast: S.fc ? { stats: S.fc.stats, impacts: S.fc.impacts.map((i) => ({ ...i, name: (siteById(i.site_id) || {}).name })) } : null,
      plan: S.plan ? { source: S.plan.source, cost_usd: S.plan.cost_usd, ...S.plan.plan, approved: S.approved, approved_utc: S.approvedT ? new Date(S.approvedT).toISOString() : null } : null,
      board: S.board.map(({ id, kind, title, sub, col }) => ({ id, kind, title, sub, column: col })), activity: S.log };
    const url = URL.createObjectURL(new Blob([JSON.stringify(rep, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = `spillsight-HZ-01-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('<i data-lucide="download"></i>Incident report downloaded'); log("Incident report exported", "#8abbff");
  }
  function summary() {
    const lines = [`HZ-01 Strait of Hormuz (simulated) · ${new Date().toUTCString()}`];
    if (S.det) lines.push(`Detection: oil slick ${polyAreaKm2(S.slick).toFixed(2)} km² at ${Geo.fmtLL(centroid(S.slick))} (SAM 3.1)`);
    if (S.fc) lines.push(`Forecast: first landfall ${S.fc.stats.first_landfall_h != null ? "+" + S.fc.stats.first_landfall_h + " h" : "none"}; at risk: ${S.fc.impacts.map((i) => (siteById(i.site_id) || {}).name).join(", ")}`);
    if (S.plan) lines.push(`Plan (${S.plan.source}): ${S.plan.plan.assignments.length} assignments, ${(S.plan.plan.closures || []).length} closures${S.approved ? ", APPROVED" : ", awaiting approval"}`);
    return lines.join("\n");
  }
  const MENUS = {
    file: [["download", "Export incident report (JSON)", exportReport], ["copy", "Copy summary to clipboard", () => { navigator.clipboard && navigator.clipboard.writeText(summary()); toast('<i data-lucide="copy"></i>Summary copied'); }], null, ["rotate-ccw", "New incident (reset)", () => location.reload()]],
    tools: [["map", "Basemap: dark / satellite", toggleBase], ["route", "Trajectories on / off", () => $("#t-tracks").click()], ["waypoints", "Traffic lanes on / off", () => $("#t-lanes").click()], ["crosshair", "Reset view", () => $("#t-home").click()], null, ["ruler", "Measure distance", () => toast('<i data-lucide="ruler"></i>Right-click the map and choose “Measure distance from here”.', "or")], ["search", "Search nearby", nearby]],
    help: [["circle-help", "Guided walkthrough", () => startGuide()], ["mouse-pointer-2", "Map controls", () => toast('<i data-lucide="mouse-pointer-2"></i>Drag to rotate · right-drag or shift-drag to pan · scroll to zoom · right-click for tools · click any marker to inspect it', "or")], ["database", "Models & data sources", () => setView("data")]],
  };
  function openMenu(key, btn) {
    const dd = $("#dd"), r = btn.getBoundingClientRect();
    dd.innerHTML = MENUS[key].map((m, i) => (m ? `<div class="it" data-i="${i}"><i data-lucide="${m[0]}"></i>${m[1]}</div>` : "<hr>")).join("");
    dd.style.left = r.left + "px"; dd.style.top = r.bottom + 2 + "px"; dd.classList.add("on"); icons(dd);
    $$("[data-i]", dd).forEach((e) => (e.onclick = (ev) => { ev.stopPropagation(); dd.classList.remove("on"); MENUS[key][+e.dataset.i][2](); }));
  }
  $$("#menu [data-dd]").forEach((b) => (b.onclick = (ev) => { ev.stopPropagation(); openMenu(b.dataset.dd, b); }));
  document.addEventListener("click", () => $("#dd").classList.remove("on"));
  $("#export").onclick = exportReport;
  $("#bell").onclick = () => { S.tab = "alerts"; syncRail(); renderLeft(); if (S.view !== "ops") setView("ops"); };
  $("#budget").onclick = () => setView("data");
  $("#srv").onclick = async () => { await refreshBudget(); toast(`<i data-lucide="activity"></i>${esc($("#srv").title)}`, $("#srv").classList.contains("ok") ? "" : "rd"); };
  $("#rail-guide").onclick = () => startGuide();
  $("#t-layers").onclick = () => { S.tab = "layers"; syncRail(); renderLeft(); };
  $("#compass").onclick = () => Map3D.flyTo(Geo.toLonLat(Map3D.cam.tx, Map3D.cam.tz), Map3D.cam.dist, { az: 0, dur: 0.8 });
  $("#nearby").onclick = nearby;
  $("#b-add").onclick = () => { card("det", "Reported sighting", S.lastLL ? Geo.fmtLL(S.lastLL) : "manual entry", "detected", { tot: "Time on target:unassessed", warn: true }); log("Sighting added to board", "#ec9a3c"); };
  $("#b-search").oninput = renderBoard;
  $("#b-filter").onclick = (e) => { S.bWarn = !S.bWarn; e.currentTarget.style.color = S.bWarn ? "#b6c94a" : ""; renderBoard(); };
  $("#b-sort").onclick = (e) => { S.bSort = S.bSort === "eta" ? "new" : "eta"; e.currentTarget.lastChild.textContent = S.bSort === "eta" ? "Sort: time on target" : "Sort: newest"; renderBoard(); };
  $("#b-guide").onclick = () => startGuide();

  // ------------------------------------------------------------------ guided walkthrough (every step runs the real pipeline)
  const GUIDE = [
    { t: "Detect oil with Meta SAM 3.1", p: "Click <em>Run SAM 3.1</em> in the right panel. The image is sent to Meta's SAM 3.1 model (live, $0.0025) and the oil outline lands on the map. <em>Cached result</em> replays a saved real response for free.", sel: () => ($("#d-run") ? "#d-run" : "#chip-go"), done: () => !!S.det },
    { t: "Forecast where the oil drifts", p: "Click <em>Forecast drift →</em>. 300 particles drift for 72 h with wind and current and stop at the coastline. Pick <em>Live · Open-Meteo</em> in the forecast panel to use today's real weather.", sel: () => ($("#d-next") ? "#d-next" : "#chip-go"), done: () => !!S.fc },
    { t: "Ask the AI to task assets", p: "Click <em>Task assets →</em>, tune the gauges with − / +, then press <em>Optimize Recommender</em>. Muse Wonder writes the plan live (about 30 s; identical inputs are cached).", sel: () => ($("#modal").classList.contains("on") ? "#mm-go" : $("#f-next") ? "#f-next" : "#chip-go"), done: () => !!S.plan },
    { t: "Review the reasons, then approve", p: "Each assignment carries a <em>Why</em>. Click any site or asset marker to inspect it. Then click <em>Approve →</em>, or Reject / Reassign to change it.", sel: () => "#p-ok", done: () => S.approved },
    { t: "Watch the response run", p: "Vessels sail from their bases and the U-boom closes around the slick. Open the <em>Board</em> to see each card move as its asset arrives.", sel: () => '#menu [data-view="board"]', done: () => !!S.sawBoard },
    { t: "Use your own data", p: "Add an asset in <em>Assets</em>, upload your own image in Detect, right-click the map to measure or nominate a sighting, or <em>Export</em> the incident report.", sel: () => "#export", done: () => false },
  ];
  S.guideOn = true;
  function startGuide() { S.guideOn = true; S.guideIdx = -1; tickGuide(); }
  function tickGuide() {
    const G = $("#guide");
    $$(".pulse").forEach((e) => e.classList.remove("pulse"));
    if (!S.guideOn) { G.classList.remove("on"); return; }
    const i = Math.max(0, GUIDE.findIndex((g) => !g.done())), g = GUIDE[i];
    if (i !== S.guideIdx) {
      S.guideIdx = i;
      G.innerHTML = `<div class="gh"><i data-lucide="compass"></i>GUIDE · STEP ${i + 1} OF ${GUIDE.length}<button class="x" id="g-x" title="Hide guide"><i data-lucide="x"></i></button></div><div class="gs">${GUIDE.map((q, k) => `<i class="${k < i ? "d" : k === i ? "c" : ""}"></i>`).join("")}</div>
        <div class="gb"><b>${g.t}</b><p>${g.p}</p></div><div class="gf"><button class="bp-btn olive" id="g-show"><i data-lucide="mouse-pointer-click"></i>Show me</button><button class="bp-btn min" id="g-hide">Hide guide</button></div>`;
      G.classList.add("on"); icons(G);
      $("#g-x").onclick = $("#g-hide").onclick = () => { S.guideOn = false; tickGuide(); };
      $("#g-show").onclick = () => { const sel = GUIDE[S.guideIdx].sel(); if (sel.startsWith("#menu") || sel === "#export") { const el = $(sel); el && el.scrollIntoView({ block: "nearest" }); return; } if (S.view !== "ops") setView("ops"); const el = $(sel); if (el) el.scrollIntoView({ block: "center", behavior: "smooth" }); };
    }
    const el = $(g.sel()); if (el) el.classList.add("pulse");
  }
  setInterval(tickGuide, 500);

  async function boot() {
    await Geo.load();
    Map3D.init($("#map"));
    Map3D.onPick((ll, e, right) => { S.lastLL = ll; $("#cursor-ll").textContent = Geo.fmtLL(ll); $("#cursor-el").textContent = S.slick ? `${Geo.km(ll, centroid(S.slick)).toFixed(1)} km to slick` : "no slick yet"; if (right || e.button === 2) ctxMenu(ll, e); else $("#ctx").classList.remove("on"); });
    Map3D.onFrame((t) => {
      Map3D.setClock(t);
      const c = Map3D.cam; $("#compass").style.transform = `rotate(${((c.az * 180) / Math.PI).toFixed(0)}deg)`;
      const tilt = Math.round(90 - (c.el * 180) / Math.PI); $("#tilt-v").textContent = tilt + "°"; $("#tilt-i").style.height = clamp((tilt / 70) * 100, 0, 100) + "%";
      const km = (c.dist * 0.7) / 3; $("#sb-scale").textContent = km >= 1 ? `${km.toFixed(0)} km` : `${(km * 1000).toFixed(0)} m`;
      if (S.approved && S.plan) {
        // a card moves on when its asset arrives: on scene -> pending verification, survey assets -> complete
        let moved = false;
        S.board.forEach((c) => { if (c.kind !== "asg" || !c.rid) return; const a = S.plan.plan.assignments.find((q) => q.resource_id === c.rid); if (!a) return; const k = (t - S.execT0 - (a._delay || 0)) / (a._dur || 8), r = resById(c.rid) || {};
          const col = k >= 1.6 && (r.type === "drone" || r.type === "aircraft") ? "complete" : k >= 1 ? "verify" : "exec"; if (c.col !== col && ["exec", "verify"].includes(c.col)) { c.col = col; c.t = Date.now(); moved = true; } });
        if (moved && S.view === "board") renderBoard();
      }
      if (S.approved && S.plan) { const k = (t - S.execT0 - 3) / 6; Map3D.boomProgress(clamp(k, 0, 1)); if (k > 1.2 && !S.execDone) { S.execDone = true; log("U-boom closed around the slick · skimmers at the apex", "#fbd065"); moveCards((q) => q.kind === "det", "verify"); renderLeft(); } }
    });
    Map3D.flyTo([56.3, 26.5], 175, { el: 0.95, az: -0.6, dur: 0.01 });
    const tOk = await Map3D.loadTerrain();
    if (!tOk) toast('<i data-lucide="triangle-alert"></i>Terrain assets missing: flat map', "or");
    try {
      S.sites = await API.sites();
      Map3D.setSites(S.sites, (m) => selectObj("site:" + m.data.id));
      setTimeout(() => { $$(".mk-site").forEach((el) => { const name = el.querySelector("b").textContent; const s = S.sites.find((q) => q.name === name); if (s) S.siteMk[s.id] = { el }; }); }, 0);
      await loadResources();
    } catch (e) { toast('<i data-lucide="triangle-alert"></i>Server not reachable: start it with <b>python3 server/app.py</b>', "rd"); }
    fetchMet(DEFAULT_LL); renderMet();
    refreshBudget(); renderLeft(); renderInspector(); renderBoard(); icons();
  }
  boot();
})();
