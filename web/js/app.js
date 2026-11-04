/* SpillSight console: detect -> forecast -> pair assets / plan -> approve -> execute. */
(() => {
  const $ = (s, r) => (r || document).querySelector(s), $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const icons = (root) => window.lucide && lucide.createIcons(root ? { nodes: [root] } : undefined);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v)), smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
  const fmtH = (h) => { const hh = Math.floor(h), mm = Math.floor((h - hh) * 60); return `T+${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`; };
  const TYPE_ICON = { vessel: "ship", boom: "waves", skimmer: "fuel", storage: "container", drone: "scan", aircraft: "plane" };
  const TYPE_NAME = { vessel: "Response vessel", boom: "Containment boom", skimmer: "Skimmer", storage: "Storage barge", drone: "Survey drone", aircraft: "Surveillance aircraft" };
  const SITE_ICON = { port: "anchor", intake: "droplets", mangrove: "trees", coral: "fish", coast: "waves", town: "house" };
  const DEFAULT_LL = [56.52, 26.47];
  // live conditions are often calm; the Shamal (north-westerly) scenario is a labelled what-if for planning
  const SHAMAL = { wind_kn: 18, wind_from_deg: 300, current_kn: 1.0, current_to_deg: 240, wave_m: 1.6, source: "scenario" };

  const S = { stage: "detect", view: "ops", sites: [], resources: [], det: null, footprint: null, slick: null, met: null, fc: null, plan: null,
    approved: false, metMode: "scenario", hour: 0, playing: false, board: [], log: [], siteMk: {}, execT0: 0, srcImg: "assets/img/sample_sar.jpg", upload: null, resFilter: "all", hwType: "vessel" };

  // ------------------------------------------------------------------ helpers
  function toast(msg, cls) { const t = document.createElement("div"); t.className = "toast " + (cls || ""); t.innerHTML = msg; $("#toasts").appendChild(t); icons(t); setTimeout(() => t.remove(), 4200); }
  function log(msg, color) { const d = new Date(); S.log.unshift({ t: d.toISOString().slice(11, 19), msg, color: color || "#f97316" }); if (S.stage === "execute") renderInspector(); }
  function pipe() {
    const st = { detect: S.det ? "done" : S.stage === "detect" ? "run" : "", forecast: S.fc ? "done" : S.stage === "forecast" ? "run" : "", plan: S.plan ? "done" : S.stage === "plan" ? "run" : "",
      approve: S.approved ? "done" : S.plan ? "run" : "", execute: S.approved ? (S.execDone ? "done" : "run") : "" };
    $$("#pipe span").forEach((e) => (e.className = st[e.dataset.k] || ""));
  }
  const siteById = (id) => S.sites.find((s) => s.id === id);
  const resById = (id) => S.resources.find((r) => r.id === id);
  function polyAreaKm2(poly) { const w = poly.map((ll) => Geo.toWorld(ll[0], ll[1])); let a = 0; for (let i = 0; i < w.length; i++) { const p = w[i], q = w[(i + 1) % w.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2; }
  function centroid(poly) { let x = 0, y = 0; poly.forEach((p) => { x += p[0]; y += p[1]; }); return [x / poly.length, y / poly.length]; }

  // ------------------------------------------------------------------ board
  const COLS = [["detected", "Detected", "scan-search"], ["triaged", "Triaged", "filter"], ["forecast", "Forecast", "wind"], ["proposed", "Plan proposed", "git-branch"], ["approved", "Approved", "circle-check"], ["exec", "In execution", "navigation"], ["verified", "Verified", "badge-check"]];
  let cardSeq = 140;
  function card(kind, title, sub, col, ref) { const c = { id: `${kind === "det" ? "DT" : kind === "site" ? "SR" : "AS"}-${cardSeq++}`, kind, title, sub, col, ref, t: Date.now() }; S.board.push(c); renderBoard(); return c; }
  function moveCards(pred, col) { S.board.filter(pred).forEach((c) => (c.col = col)); renderBoard(); }
  function renderBoard() {
    $("#board-count").textContent = S.board.length;
    const B = $("#board");
    B.innerHTML = COLS.map(([k, n, ic]) => `<div class="col" data-col="${k}"><div class="col-h"><i data-lucide="${ic}"></i>${n}<span class="n">${S.board.filter((c) => c.col === k).length}</span></div><div class="col-b">` +
      S.board.filter((c) => c.col === k).map((c) => `<div class="bc k-${c.kind}" draggable="true" data-id="${c.id}"><span class="ic"><i data-lucide="${c.kind === "det" ? "scan-search" : c.kind === "site" ? "shield-alert" : "ship"}"></i></span><div><span class="id">${c.id}</span><b>${esc(c.title)}</b><small>${esc(c.sub)}</small></div></div>`).join("") + "</div></div>").join("");
    icons(B);
    $$(".bc", B).forEach((e) => e.addEventListener("dragstart", (ev) => ev.dataTransfer.setData("text", e.dataset.id)));
    $$(".col", B).forEach((col) => {
      col.addEventListener("dragover", (ev) => { ev.preventDefault(); col.classList.add("drop"); });
      col.addEventListener("dragleave", () => col.classList.remove("drop"));
      col.addEventListener("drop", (ev) => { ev.preventDefault(); const c = S.board.find((q) => q.id === ev.dataTransfer.getData("text")); if (c) { c.col = col.dataset.col; renderBoard(); } });
    });
  }

  // ------------------------------------------------------------------ object tree (left)
  const vis = { sites: true, assets: true, oil: true, risk: true, lanes: true, booms: true };
  function renderTree() {
    const q = ($("#obj-search").value || "").toLowerCase();
    const atRisk = new Set((S.fc ? S.fc.impacts : []).map((i) => i.site_id));
    const grp = (key, name, icon, items) => `<div class="tg"><div class="tg-h" data-g="${key}"><i data-lucide="${icon}"></i>${name}<span class="n">${items.length}</span><span class="eye" data-eye="${key}"><i data-lucide="${vis[key] === false ? "eye-off" : "eye"}"></i></span></div>${items.join("")}</div>`;
    const f = (s) => !q || s.toLowerCase().includes(q);
    const det = S.det ? [`<div class="ti" data-go="slick"><span class="b" style="background:#f97316"></span>Oil slick · SAM 3.1<small>${S.slick ? polyAreaKm2(S.slick).toFixed(1) + " km²" : ""}</small></div>`] : [];
    const sites = S.sites.filter((s) => s.kind !== "lane" && f(s.name)).sort((a, b) => atRisk.has(b.id) - atRisk.has(a.id))
      .map((s) => { const im = S.fc && S.fc.impacts.find((i) => i.site_id === s.id); return `<div class="ti" data-site="${s.id}"><span class="b" style="background:${im ? "#ef4444" : "#38bdf8"}"></span>${esc(s.name)}<small>${im ? "ETA +" + im.eta_h + " h" : s.kind}</small></div>`; });
    const assets = S.resources.filter((r) => f(r.name)).map((r) => `<div class="ti" data-res="${r.id}"><i data-lucide="${TYPE_ICON[r.type] || "box"}" style="width:13px;height:13px;color:#fb923c"></i>${esc(r.name)}<small>${r.status}</small></div>`);
    const lanes = S.sites.filter((s) => s.kind === "lane").map((s) => `<div class="ti"><span class="b" style="background:#38bdf8"></span>${esc(s.name)}</div>`);
    $("#tree").innerHTML = grp("oil", "Detections", "scan-search", det) + grp("risk", "Sites & sensitivities", "shield-alert", sites) + grp("assets", "Assets", "ship", assets) + grp("lanes", "Traffic lanes", "waypoints", lanes);
    icons($("#tree"));
    $$("[data-eye]").forEach((e) => e.addEventListener("click", (ev) => { ev.stopPropagation(); const k = e.dataset.eye; vis[k] = !vis[k]; const map = { risk: ["risk", "sites"], oil: ["oil", "tracks"], assets: ["assets"], lanes: ["lanes"] }[k] || [k]; map.forEach((g) => Map3D.setGroupVisible(g, vis[k])); renderTree(); }));
    $$("[data-site]").forEach((e) => e.addEventListener("click", () => { const s = siteById(e.dataset.site); Map3D.flyTo(s.lonlat, 22); }));
    $$("[data-res]").forEach((e) => e.addEventListener("click", () => { const r = resById(e.dataset.res); const p = Map3D.assetPos(r.id); Map3D.flyTo(p ? Geo.toLonLat(p.x, p.z) : r.lonlat, 16); }));
    $$("[data-go=slick]").forEach((e) => e.addEventListener("click", () => S.slick && Map3D.flyTo(centroid(S.slick), 14)));
  }

  // ------------------------------------------------------------------ met-ocean HUD
  const activeMet = () => (S.metMode === "live" && S.met ? S.met : SHAMAL);
  function renderMet() {
    const m = activeMet(); if (!m) return;
    $("#met").innerHTML = `<div class="met"><small>Wind</small><b>${m.wind_kn.toFixed(0)}</b><span> kn</span><svg class="arw" width="16" height="16" viewBox="0 0 16 16" style="transform:rotate(${m.wind_from_deg + 180}deg)"><path d="M8 1 L12 9 L8 7 L4 9 Z" fill="currentColor"/></svg><span style="display:block">from ${Math.round(m.wind_from_deg)}°</span></div>
      <div class="met"><small>Current</small><b>${m.current_kn.toFixed(1)}</b><span> kn</span><svg class="arw" width="16" height="16" viewBox="0 0 16 16" style="transform:rotate(${m.current_to_deg}deg)"><path d="M8 1 L12 9 L8 7 L4 9 Z" fill="currentColor"/></svg><span style="display:block">to ${Math.round(m.current_to_deg)}°</span></div>
      <div class="met"><small>Waves</small><b>${(m.wave_m || 0).toFixed(1)}</b><span> m</span><span style="display:block">${m.source === "open-meteo" ? "Open-Meteo · live" : m.source === "scenario" ? "Shamal scenario" : "default values"}</span></div>`;
  }

  // ------------------------------------------------------------------ inspector (right)
  function setStage(st) {
    S.stage = st; $$("#rail [data-stage]").forEach((b) => b.classList.toggle("on", b.dataset.stage === st));
    if (S.view !== "ops") setView("ops");
    renderInspector(); pipe();
  }
  function renderInspector() {
    const I = $("#inspector");
    const head = (ic, t, p) => `<div class="insp-h"><h3><i data-lucide="${ic}"></i>${t}</h3><p>${p}</p></div>`;
    let h = "";
    if (S.stage === "detect") {
      const d = S.det, inst = d && d.instances && d.instances[0];
      h = head("scan-search", "Detect", "Outline oil in a satellite, aircraft or drone image with Meta SAM 3.1, then place it on the map.") +
        `<div class="sec"><h4><i data-lucide="satellite"></i>Sensor</h4><div class="card sensor"><canvas id="sat-canvas"></canvas><div><b>Sentinel-1 SAR pass</b><small>C-band radar sees oil as dark, smooth water, through cloud and at night.</small><div style="margin-top:6px"><span class="chip yl">Sample image is simulated</span></div></div></div></div>
        <div class="sec"><h4><i data-lucide="file-text"></i>Source image</h4><div class="src" id="src"><img src="${S.upload || S.srcImg}" id="src-img"><svg class="ov" id="src-ov" preserveAspectRatio="none"></svg><span class="tag chip">${S.upload ? "Uploaded image" : "Simulated SAR (AI-generated)"}</span></div>
        <label class="field">Prompt<input id="d-prompt" value="dark oil slick"></label>
        <label class="field">Or upload an image<input type="file" id="d-file" accept="image/*"></label>
        <div class="btns"><button class="btn" id="d-sample"><i data-lucide="database"></i>Cached result</button><button class="btn pr" id="d-run"><i data-lucide="sparkles"></i>Run SAM 3.1</button></div>
        <div class="small" style="color:var(--tx3);margin-top:6px">Live run costs $0.0025. Footprint: 6 km wide, centred on ${Geo.fmtLL(S.footprintCenter || DEFAULT_LL)} (click the map to move it).</div></div>` +
        (d ? `<div class="sec"><h4><i data-lucide="target"></i>Detection</h4><div class="dcard"><span class="ic"><i data-lucide="triangle-alert"></i></span><div><b>Computer vision detection · Oil slick</b><small>${esc(d.model || "sam-3.1")} · ${d.cached ? "cached result" : "live"} · ${d.instances.length} instance${d.instances.length === 1 ? "" : "s"}</small>
          <div class="kv"><span>Confidence</span><b>${inst ? (inst.score * 100).toFixed(0) + "%" : "—"}</b><span>Area</span><b>${S.slick ? polyAreaKm2(S.slick).toFixed(2) + " km²" : "—"}</b><span>Centre</span><b>${S.slick ? Geo.fmtLL(centroid(S.slick)) : "—"}</b><span>Cost</span><b>$${(d.cost_usd || 0).toFixed(4)}</b></div></div></div>
          <button class="btn pr w" style="margin-top:12px" id="d-next"><i data-lucide="wind"></i>Forecast the drift</button></div>` : "");
    } else if (S.stage === "forecast") {
      const f = S.fc;
      h = head("wind", "Forecast", "Particle drift: surface current + 3% of the wind + turbulent spreading, stopped at the coastline.") +
        `<div class="sec"><h4><i data-lucide="wind"></i>Met-ocean at the slick</h4><div class="seg" style="grid-template-columns:1fr 1fr;margin-bottom:8px"><button data-met="live" class="${S.metMode === "live" ? "on" : ""}"><i data-lucide="satellite-dish"></i>Live · Open-Meteo</button><button data-met="scenario" class="${S.metMode === "scenario" ? "on" : ""}"><i data-lucide="wind"></i>Shamal scenario</button></div>${(() => { const m = activeMet(); return `<div class="kv"><span>Wind</span><b>${m.wind_kn.toFixed(1)} kn from ${Math.round(m.wind_from_deg)}°</b><span>Current</span><b>${m.current_kn.toFixed(2)} kn to ${Math.round(m.current_to_deg)}°</b><span>Waves</span><b>${(m.wave_m || 0).toFixed(1)} m</b><span>Source</span><b>${m.source === "scenario" ? "what-if (labelled)" : m.source}</b></div>`; })()}
        <button class="btn pr w" style="margin-top:12px" id="f-run" ${S.slick ? "" : "disabled"}><i data-lucide="play"></i>${f ? "Re-run" : "Run"} 72 h forecast</button>${S.slick ? "" : '<div class="small" style="color:var(--tx3);margin-top:6px">Detect a slick first.</div>'}</div>` +
        (f ? `<div class="sec"><h4><i data-lucide="gauge"></i>Result</h4><div class="kpis"><div class="kpi"><small>First landfall</small><b>${f.stats.first_landfall_h != null ? "+" + f.stats.first_landfall_h + " h" : "none"}</b></div><div class="kpi"><small>Ashore 24 h</small><b>${f.stats.ashore_pct["24"]}%</b></div><div class="kpi"><small>Drift</small><b>${f.stats.drift_kn.toFixed(1)} kn</b></div></div></div>
          <div class="sec"><h4><i data-lucide="shield-alert"></i>Shoreline at risk</h4><div class="list">${f.impacts.length ? f.impacts.map((im) => { const s = siteById(im.site_id) || { name: im.site_id, kind: "" }; const live = S.hour >= im.eta_h; return `<div class="it"><span class="ic" style="color:${live ? "#ef4444" : "#fca5a5"}"><i data-lucide="${SITE_ICON[s.kind] || "map-pin"}"></i></span><div><b>${esc(s.name)}</b><small>${s.kind} · ${s.country || ""} · ${im.n} particles</small></div><div class="r"><span class="mono">+${im.eta_h} h</span><span class="chip ${live ? "rd" : "or"}">${live ? "oiled" : "in " + Math.max(0, Math.ceil(im.eta_h - S.hour)) + " h"}</span></div></div>`; }).join("") : '<div class="empty">No sensitive site reached within 72 h.</div>'}</div>
          <button class="btn pr w" style="margin-top:12px" id="f-next"><i data-lucide="git-branch"></i>Pair assets &amp; plan</button></div>` : "");
    } else if (S.stage === "plan") {
      const P = S.plan;
      h = head("git-branch", "Plan", "Rank available assets against the forecast, then let Muse Spark 1.3 write the response plan with a reason for every step.") +
        `<div class="sec">${S.fc ? `<button class="btn pr w" id="p-open"><i data-lucide="sliders-horizontal"></i>${P ? "Re-pair assets" : "Propose assets"}</button>` : '<div class="empty">Run a forecast first.</div>'}</div>` +
        (P ? `<div class="sec"><h4><i data-lucide="brain-circuit"></i>${P.source === "rules" ? "Rules planner (fallback)" : "Muse Spark 1.3"} · ${P.plan.assignments.length} assignments</h4><div style="color:var(--tx2);font-size:12px">${esc(P.plan.summary || "")}</div>${P.plan.assignments.map(asgHTML).join("")}</div>
          <div class="sec"><h4><i data-lucide="waves"></i>Booms</h4><div class="list">${(P.plan.booms || []).map((b) => `<div class="it"><span class="ic" style="color:#facc15"><i data-lucide="waves"></i></span><div><b>${esc(b.kind)} · ${b.length_m} m at ${b.angle_deg}°</b><small>${esc(b.site_id ? (siteById(b.site_id) || {}).name || b.site_id : "slick leading edge")} — ${esc(b.reason)}</small></div><div></div></div>`).join("")}</div></div>
          <div class="sec"><h4><i data-lucide="ban"></i>Closures &amp; advisories</h4><div class="list">${(P.plan.closures || []).map((c) => `<div class="it"><span class="ic" style="color:#ef4444"><i data-lucide="${SITE_ICON[(siteById(c.site_id) || {}).kind] || "ban"}"></i></span><div><b>${esc(c.action)} · ${esc((siteById(c.site_id) || {}).name || c.site_id)}</b><small>${esc(c.reason)}</small></div><div class="r"><span class="mono">+${c.from_h} h</span></div></div>`).join("")}${(P.plan.advisories || []).map((a) => `<div class="it"><span class="ic" style="color:#a78bfa"><i data-lucide="megaphone"></i></span><div><b>${esc(a.kind)} · ${a.radius_km} km</b><small>${esc(a.reason)}</small></div><div></div></div>`).join("")}</div></div>
          <div class="approve">${S.approved ? `<button class="btn ok w" disabled><i data-lucide="circle-check"></i>Approved · crews tasked</button>` : `<div class="btns" style="margin:0"><button class="btn no" id="p-reject"><i data-lucide="x"></i>Reject</button><button class="btn" id="p-re"><i data-lucide="refresh-cw"></i>Reassign</button><button class="btn bl" id="p-ok"><i data-lucide="check"></i>Approve</button></div>`}</div>` : "");
    } else {
      h = head("navigation", "Execute", "Approved tasks run on the map; every new image re-runs detection, forecast and plan.");
      if (!S.approved) h += '<div class="sec"><div class="empty"><i data-lucide="navigation"></i><br>Approve a plan to start execution.</div></div>';
      else {
        const now = performance.now() / 1000;
        h += `<div class="sec"><h4><i data-lucide="ship"></i>Missions</h4>${S.plan.plan.assignments.map((a) => { const r = resById(a.resource_id) || { name: a.resource_id, type: "vessel" }; const k = clamp((now - S.execT0 - (a._delay || 0)) / (a._dur || 8), 0, 1); return `<div class="asg"><span class="ic"><i data-lucide="${TYPE_ICON[r.type] || "ship"}"></i></span><div><b>${esc(r.name)}</b><small>${esc(a.task)}</small><div class="bar"><i style="width:${(k * 100).toFixed(0)}%"></i></div></div><div class="sc">${k >= 1 ? '<span class="chip gr">on scene</span>' : `<span class="chip bl">en route</span>`}</div></div>`; }).join("")}</div>
          <div class="sec"><h4><i data-lucide="activity"></i>Activity</h4><div class="log">${S.log.map((l) => `<div class="ln"><em>${l.t}</em><i style="background:${l.color}"></i><div>${l.msg}</div></div>`).join("")}</div></div>`;
      }
    }
    I.innerHTML = h; icons(I);
    bindInspector();
  }
  function asgHTML(a) {
    const r = resById(a.resource_id) || { name: a.resource_id, type: "vessel", base: "" };
    return `<div class="asg"><span class="ic"><i data-lucide="${TYPE_ICON[r.type] || "ship"}"></i></span><div><b>${esc(r.name)}</b><small>${esc(a.task)} · from ${esc(r.base || "")}</small><span class="why">Why: ${esc(a.reason)}</span></div><div class="sc">+${(+a.eta_h).toFixed(1)} h<small><br>score ${(+a.score).toFixed(2)}</small></div></div>`;
  }
  function bindInspector() {
    const on = (id, f) => { const e = $(id); if (e) e.addEventListener("click", f); };
    if ($("#sat-canvas")) { const v = HW.viewer($("#sat-canvas"), { space: true }); v.show("satellite"); }
    if ($("#src-img")) { $("#src-img").onload = drawSrcOverlay; drawSrcOverlay(); }
    on("#d-run", () => runDetect(false)); on("#d-sample", () => runDetect(true)); on("#d-next", () => setStage("forecast"));
    const fi = $("#d-file"); if (fi) fi.addEventListener("change", () => { const f = fi.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => { S.upload = rd.result; renderInspector(); }; rd.readAsDataURL(f); });
    $$("[data-met]").forEach((b) => (b.onclick = () => { S.metMode = b.dataset.met; renderMet(); renderInspector(); }));
    on("#f-run", runForecast); on("#f-next", () => { setStage("plan"); openPairing(); });
    on("#p-open", openPairing); on("#p-re", openPairing); on("#p-ok", approve);
    on("#p-reject", () => { S.plan = null; Map3D.setBooms([]); S.board = S.board.filter((c) => c.kind !== "asg"); renderBoard(); renderInspector(); pipe(); toast('<i data-lucide="x"></i>Plan rejected', "rd"); });
  }
  function drawSrcOverlay() {
    const svg = $("#src-ov"), img = $("#src-img"); if (!svg || !img || !S.det || S.det._src !== (S.upload || S.srcImg)) { if (svg) svg.innerHTML = ""; return; }
    const [w, h] = S.det.image_size || [img.naturalWidth, img.naturalHeight];
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.innerHTML = S.det.instances.map((it) => `<polygon points="${it.polygon.map((p) => p.join(",")).join(" ")}" fill="rgba(249,115,22,.28)" stroke="#f97316" stroke-width="${Math.max(2, w / 300)}"/><rect x="${it.box[0]}" y="${it.box[1]}" width="${it.box[2] - it.box[0]}" height="${it.box[3] - it.box[1]}" fill="none" stroke="#fff" stroke-dasharray="${w / 80} ${w / 120}" stroke-width="${Math.max(1, w / 500)}"/>`).join("");
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
    const btn = cached ? $("#d-sample") : $("#d-run"); btn.disabled = true; btn.innerHTML = '<i data-lucide="refresh-cw"></i>Segmenting…'; icons(btn);
    const src = $("#src"); const sc = document.createElement("div"); sc.className = "scan"; src.appendChild(sc);
    try {
      let d;
      const srcUrl = S.upload || S.srcImg;
      if (cached && !S.upload) d = await API.detectSample();
      else { const { b64, w, h } = await imgB64(srcUrl); d = await API.detect({ image_b64: b64, prompt: $("#d-prompt").value || "dark oil slick", footprint: footprintFor(w, h) }); }
      if (!d.instances || !d.instances.length) { toast('<i data-lucide="triangle-alert"></i>SAM 3.1 found no oil in this image. Try another prompt.', "or"); return; }
      d._src = srcUrl; S.det = d;
      const [w, h] = d.image_size;
      S.footprint = d.footprint || footprintFor(w, h);
      const best = d.instances.slice().sort((a, b) => b.score - a.score)[0];
      S.slick = best.polygon_lonlat && best.polygon_lonlat.length > 2 ? best.polygon_lonlat : best.polygon.map((p) => pxToLL(p, w, h, S.footprint));
      Map3D.setImageOverlay(srcUrl, S.footprint, 0.55); Map3D.setSlick(S.slick); Map3D.slickOpacity(1);
      Map3D.clearMarkers("det");
      Map3D.marker({ kind: "det", icon: "scan-search", label: "Oil slick", sub: `SAM 3.1 · ${(best.score * 100).toFixed(0)}%`, lonlat: centroid(S.slick), group: "det", y: 0.4 });
      Map3D.flyTo(centroid(S.slick), 13, { el: 0.95 });
      cvCard(`Computer vision detection`, `Oil slick · SAM 3.1 · ${(best.score * 100).toFixed(0)}% · ${polyAreaKm2(S.slick).toFixed(2)} km²`);
      if (!S.board.some((c) => c.kind === "det")) { const c = card("det", "Computer vision detection", `Oil slick · ${polyAreaKm2(S.slick).toFixed(2)} km²`, "detected"); setTimeout(() => { c.col = "triaged"; renderBoard(); }, 1400); }
      fetchMet(centroid(S.slick));
      refreshBudget(); renderTree(); pipe();
    } catch (e) { toast(`<i data-lucide="triangle-alert"></i>Detect failed: ${esc(e.message)}`, "rd"); }
    finally { sc.remove(); renderInspector(); }
  }
  function cvCard(t, s) { const c = $("#cvd"); c.innerHTML = `<div class="cvcard"><span class="ic"><i data-lucide="triangle-alert"></i></span><div><b>${esc(t)}</b><small>${esc(s)}</small></div></div>`; icons(c); c.classList.remove("on"); void c.offsetWidth; c.classList.add("on"); clearTimeout(cvCard.t); cvCard.t = setTimeout(() => c.classList.remove("on"), 4500); }

  // ------------------------------------------------------------------ forecast
  async function fetchMet(ll) { try { S.met = await API.metocean(ll); renderMet(); if (S.stage === "forecast") renderInspector(); } catch (e) { /* server not ready */ } }
  async function runForecast() {
    const b = $("#f-run"); b.disabled = true; b.innerHTML = '<i data-lucide="refresh-cw"></i>Running 300 particles…'; icons(b);
    try {
      const f = await API.forecast({ slick: S.slick, hours: 72, n: 300, metocean: activeMet() });
      S.fc = f; Map3D.setForecast(f); Map3D.setHour(0, 0);
      Map3D.fadeImage(0); Map3D.slickOpacity(0.0);
      // risk zones and at-risk markers
      Map3D.setRisk(f.impacts.map((im) => ({ lonlat: (siteById(im.site_id) || {}).lonlat, radius: 4, eta_h: im.eta_h })).filter((r) => r.lonlat));
      Object.entries(S.siteMk).forEach(([id, m]) => m.el.classList.toggle("atrisk", f.impacts.some((i) => i.site_id === id)));
      S.board = S.board.filter((c) => c.kind !== "site");
      f.impacts.slice(0, 8).forEach((im) => { const s = siteById(im.site_id); if (s && s.kind !== "lane") card("site", `Shoreline impact · ${s.name}`, `${s.kind} · ETA +${im.eta_h} h`, "forecast", im.site_id); });
      moveCards((c) => c.kind === "det", "forecast");
      $("#tl-marks").innerHTML = f.stats.first_landfall_h != null ? `<i style="left:${(100 * f.stats.first_landfall_h) / 72}%"><span>landfall +${f.stats.first_landfall_h} h</span></i>` : "";
      $("#tl-mode").textContent = "Drift forecast";
      const pts = f.impacts.map((im) => (siteById(im.site_id) || {}).lonlat).filter(Boolean).concat([centroid(S.slick)]);
      const c = centroid(pts); const spread = Math.max(...pts.map((p) => Geo.km(p, c)));
      Map3D.flyTo(c, clamp(spread * 2.6, 40, 150), { el: 0.9 });
      play(0);
      log(`Forecast run · ${f.particles} particles · first landfall ${f.stats.first_landfall_h != null ? "+" + f.stats.first_landfall_h + " h" : "none"}`, "#3b82f6");
      renderTree(); pipe();
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
    if (S.stage === "forecast" && performance.now() - lastRender > 400) { lastRender = performance.now(); renderInspector(); }
  }

  // ------------------------------------------------------------------ pairing modal + plan
  function openPairing() {
    const W = S.weights || { time: 0.5, capacity: 0.3, distance: 0.2 };
    const ready = S.resources.filter((r) => r.status === "ready");
    $("#mbox").innerHTML = `<div class="mh"><i data-lucide="sliders-horizontal"></i><h3>Choose which metrics the AI should prioritise</h3><button class="x" id="m-x"><i data-lucide="x"></i></button></div>
      <div class="mb"><div class="metrics">
        <div class="metric"><b><i data-lucide="timer"></i>Time to site</b><small>Reach the slick and threatened sites before the oil does.</small><input type="range" min="0" max="100" value="${W.time * 100}" id="w-time"><span class="w" id="w-time-v"></span></div>
        <div class="metric"><b><i data-lucide="container"></i>Capacity</b><small>Boom length, skimmer rate and storage brought to the task.</small><input type="range" min="0" max="100" value="${W.capacity * 100}" id="w-cap"><span class="w" id="w-cap-v"></span></div>
        <div class="metric"><b><i data-lucide="route"></i>Distance</b><small>Prefer nearby bases: less fuel, faster rotation.</small><input type="range" min="0" max="100" value="${W.distance * 100}" id="w-dist"><span class="w" id="w-dist-v"></span></div>
      </div>
      <div class="sec" style="padding:14px 0 0;border:0"><h4><i data-lucide="boxes"></i>${ready.length} ready assets · ${S.fc.impacts.length} threatened sites · first landfall ${S.fc.stats.first_landfall_h != null ? "+" + S.fc.stats.first_landfall_h + " h" : "none"}</h4>
      <table class="tbl" style="font-size:12px"><tr><th>Asset</th><th>Base</th><th>To slick</th><th>ETA</th><th>Capability</th></tr>${ready.map((r) => { const d = Geo.km(r.lonlat, centroid(S.slick)); return `<tr><td><div class="nm"><span class="ic"><i data-lucide="${TYPE_ICON[r.type]}"></i></span>${esc(r.name)}</div></td><td>${esc(r.base)}</td><td class="mono">${d.toFixed(0)} km</td><td class="mono">${r.speed_kn ? (d / (r.speed_kn * 1.852)).toFixed(1) + " h" : "—"}</td><td>${cap(r)}</td></tr>`; }).join("")}</table></div></div>
      <div class="mf"><span class="chip vi" style="margin-right:auto"><i data-lucide="brain-circuit"></i>Muse Spark 1.3 · JSON schema · reasons required</span><button class="btn" id="m-cancel">Cancel</button><button class="btn pr" id="m-go"><i data-lucide="sparkles"></i>Propose assets</button></div>`;
    $("#modal").classList.add("on"); icons($("#mbox"));
    const upd = () => { const t = +$("#w-time").value, c = +$("#w-cap").value, d = +$("#w-dist").value, s = t + c + d || 1; S.weights = { time: t / s, capacity: c / s, distance: d / s }; $("#w-time-v").textContent = (100 * S.weights.time).toFixed(0) + "%"; $("#w-cap-v").textContent = (100 * S.weights.capacity).toFixed(0) + "%"; $("#w-dist-v").textContent = (100 * S.weights.distance).toFixed(0) + "%"; };
    ["#w-time", "#w-cap", "#w-dist"].forEach((q) => $(q).addEventListener("input", upd)); upd();
    const close = () => $("#modal").classList.remove("on");
    $("#m-x").onclick = close; $("#m-cancel").onclick = close;
    $("#m-go").onclick = async () => {
      const b = $("#m-go"); b.disabled = true; b.innerHTML = '<i data-lucide="refresh-cw"></i>Muse Spark is planning…'; icons(b);
      try {
        const impacts = S.fc.impacts.map((im) => { const s = siteById(im.site_id) || {}; return { ...im, name: s.name, kind: s.kind, lonlat: s.lonlat }; });
        const P = await API.plan({ forecast_summary: { ...S.fc.stats, slick_centroid: centroid(S.slick), slick_area_km2: polyAreaKm2(S.slick) }, impacts, resources: S.resources, metocean: activeMet(), weights: S.weights });
        S.plan = P; S.approved = false; close();
        showPlanOnMap(); S.board = S.board.filter((c) => c.kind !== "asg");
        P.plan.assignments.forEach((a) => { const r = resById(a.resource_id); card("asg", r ? r.name : a.resource_id, `${a.task} · +${(+a.eta_h).toFixed(1)} h`, "proposed", a.resource_id); });
        moveCards((c) => c.kind === "site", "proposed");
        toast(`<i data-lucide="brain-circuit"></i>${P.source === "rules" ? "Rules planner" : "Muse Spark 1.3"} proposed ${P.plan.assignments.length} assignments`, "or");
        log(`Plan proposed by ${P.source} · ${P.plan.assignments.length} assignments · $${(P.cost_usd || 0).toFixed(4)}`, "#a78bfa");
        refreshBudget(); renderInspector(); pipe();
      } catch (e) { toast(`<i data-lucide="triangle-alert"></i>Plan failed: ${esc(e.message)}`, "rd"); b.disabled = false; b.innerHTML = "Retry"; }
    };
  }
  const cap = (r) => [r.boom_m ? `${r.boom_m} m boom` : "", r.skimmer_m3h ? `${r.skimmer_m3h} m³/h` : "", r.storage_m3 ? `${r.storage_m3} m³` : "", r.speed_kn ? `${r.speed_kn} kn` : ""].filter(Boolean).join(" · ") || "survey";

  // boom geometry: a U around the slick at the containment hour, deflection booms in front of threatened intakes
  function containmentU(h) {
    const pts = S.fc.tracks.map((tr) => { const p = tr[Math.min(Math.round(h), tr.length - 1)]; return Geo.toWorld(p[0], p[1]); });
    const c = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
    const c2 = (() => { const q = S.fc.tracks.map((tr) => { const p = tr[Math.min(Math.round(h) + 2, tr.length - 1)]; return Geo.toWorld(p[0], p[1]); }); return q.reduce((a, p) => [a[0] + p[0] / q.length, a[1] + p[1] / q.length], [0, 0]); })();
    let d = [c2[0] - c[0], c2[1] - c[1]]; const l = Math.hypot(d[0], d[1]) || 1; d = [d[0] / l, d[1] / l]; const n = [-d[1], d[0]];
    const us = pts.map((p) => (p[0] - c[0]) * d[0] + (p[1] - c[1]) * d[1]).sort((a, b) => a - b), ws = pts.map((p) => (p[0] - c[0]) * n[0] + (p[1] - c[1]) * n[1]).sort((a, b) => a - b);
    const q = (a, f) => a[Math.floor(f * (a.length - 1))];
    const uM = q(us, 0.04) - 0.2, uA = q(us, 0.96) + 0.5, wc = (q(ws, 0.04) + q(ws, 0.96)) / 2, hw = (q(ws, 0.96) - q(ws, 0.04)) / 2 + 0.5;
    const half = (side) => { const o = []; for (let k = 0; k <= 24; k++) { const s = k / 24, u = uM + (uA - uM) * s, w = wc + side * hw * Math.sqrt(Math.max(0, 1 - Math.pow(s, 2.4))); o.push(Geo.toLonLat(c[0] + d[0] * u + n[0] * w, c[1] + d[1] * u + n[1] * w)); } return o; };
    return { halves: [half(-1), half(1)], mouth: [Geo.toLonLat(c[0] + d[0] * uM + n[0] * (wc - hw), c[1] + d[1] * uM + n[1] * (wc - hw)), Geo.toLonLat(c[0] + d[0] * uM + n[0] * (wc + hw), c[1] + d[1] * uM + n[1] * (wc + hw))], apex: Geo.toLonLat(c[0] + d[0] * uA + n[0] * wc, c[1] + d[1] * uA + n[1] * wc) };
  }
  function deflection(site, angle) {
    const [sx, sz] = Geo.toWorld(site.lonlat[0], site.lonlat[1]), c = S.fc ? S.fc.tracks[0][0] : DEFAULT_LL, [cx, cz] = Geo.toWorld(c[0], c[1]);
    let o = [cx - sx, cz - sz]; const l = Math.hypot(o[0], o[1]) || 1; o = [o[0] / l, o[1] / l];
    const a = ((angle || 30) * Math.PI) / 180, r = [o[0] * Math.cos(a) - o[1] * Math.sin(a), o[0] * Math.sin(a) + o[1] * Math.cos(a)];
    const p0 = [sx + o[0] * 0.5, sz + o[1] * 0.5], p1 = [p0[0] + r[0] * 2.5, p0[1] + r[1] * 2.5];
    return [Geo.toLonLat(p0[0], p0[1]), Geo.toLonLat((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2), Geo.toLonLat(p1[0], p1[1])];
  }
  function showPlanOnMap() {
    const P = S.plan.plan, hC = clamp(Math.min(...P.assignments.map((a) => +a.eta_h || 4)), 2, 24);
    S.U = containmentU(hC); S.hC = hC;
    const lines = [...S.U.halves];
    (P.booms || []).forEach((b) => { if (b.site_id && siteById(b.site_id)) lines.push(deflection(siteById(b.site_id), b.angle_deg)); });
    Map3D.setBooms(lines); Map3D.boomProgress(0);
    // proposed routes (assets stay at base until approval)
    let mouth = 0;
    P.assignments.forEach((a) => {
      const r = resById(a.resource_id); if (!r) return;
      let to = a.target_lonlat;
      if (/contain|boom|tow|skim/i.test(a.task) && r.type !== "drone" && r.type !== "aircraft") to = mouth < 2 ? S.U.mouth[mouth++] : S.U.apex;
      a._to = to; Map3D.mission(a.resource_id, to, 1e12, 1);
    });
  }
  function approve() {
    S.approved = true; S.execT0 = performance.now() / 1000;
    stop(); setHour(S.hC || 4); $("#tl-mode").textContent = "Containment";
    S.plan.plan.assignments.forEach((a, i) => { a._delay = i * 0.35; a._dur = clamp(6 + (+a.eta_h || 2) * 0.8, 6, 14); if (a._to) Map3D.mission(a.resource_id, a._to, S.execT0 + a._delay, a._dur); });
    (S.plan.plan.closures || []).forEach((c) => { const m = S.siteMk[c.site_id]; if (m) m.el.classList.add("closed"); });
    moveCards((c) => c.kind === "asg" || c.kind === "site", "approved"); setTimeout(() => moveCards((c) => c.kind === "asg", "exec"), 1200);
    toast(`<i data-lucide="circle-check"></i>Plan approved · ${S.plan.plan.assignments.length} assets tasked · ${(S.plan.plan.closures || []).length} closure notices queued`);
    log("Plan approved by incident lead", "#22c55e");
    (S.plan.plan.closures || []).forEach((c) => log(`Notice queued · ${esc(c.action)} · ${esc((siteById(c.site_id) || {}).name || c.site_id)} from +${c.from_h} h`, "#ef4444"));
    if (S.slick) Map3D.flyTo(centroid(S.slick), 26, { el: 0.85 });
    setStage("execute");
  }

  // ------------------------------------------------------------------ resources view
  const SPEC = { vessel: [["speed_kn", "Speed kn", 12], ["crew", "Crew", 8], ["boom_m", "Boom m", 0]], boom: [["boom_m", "Length m", 500], ["speed_kn", "Tow kn", 0.7], ["crew", "Crew", 4]], skimmer: [["skimmer_m3h", "Rate m³/h", 40], ["crew", "Crew", 3], ["speed_kn", "Speed kn", 0]],
    storage: [["storage_m3", "Storage m³", 1200], ["speed_kn", "Speed kn", 8], ["crew", "Crew", 6]], drone: [["speed_kn", "Speed kn", 40], ["crew", "Crew", 2], ["storage_m3", "—", 0]], aircraft: [["speed_kn", "Speed kn", 180], ["crew", "Crew", 4], ["storage_m3", "—", 0]] };
  const BASES = { "Bandar Abbas": [56.21, 27.14], Qeshm: [56.27, 26.95], Khasab: [56.25, 26.2], "Saqr port": [56.05, 25.98] };
  let hwView = null;
  function renderResources() {
    const types = ["all", "vessel", "boom", "skimmer", "storage", "drone", "aircraft"];
    $("#res-filters").innerHTML = types.map((t) => `<button data-f="${t}" class="${S.resFilter === t ? "on" : ""}">${t === "all" ? "All" : `<i data-lucide="${TYPE_ICON[t]}"></i>${TYPE_NAME[t].split(" ").pop()}`}</button>`).join("");
    const rows = S.resources.filter((r) => S.resFilter === "all" || r.type === S.resFilter);
    $("#res-table").innerHTML = `<tr><th>Asset</th><th>Type</th><th>Base</th><th>Capability</th><th>Status</th><th></th></tr>` + rows.map((r) => `<tr data-id="${r.id}" class="${S.hwType === r.type ? "" : ""}"><td><div class="nm"><span class="ic"><i data-lucide="${TYPE_ICON[r.type]}"></i></span><div><b>${esc(r.name)}</b>${r.sample ? ' <span class="chip ghost" style="font-size:10px">sample</span>' : ""}</div></div></td><td>${TYPE_NAME[r.type] || r.type}</td><td>${esc(r.base)}</td><td style="color:var(--tx2)">${cap(r)}</td><td><span class="chip ${r.status === "ready" ? "gr" : r.status === "busy" ? "or" : "rd"}">${r.status}</span></td><td><button class="del" data-del="${r.id}" title="Remove"><i data-lucide="trash-2"></i></button></td></tr>`).join("");
    $("#res-type").innerHTML = Object.keys(TYPE_ICON).map((t) => `<button type="button" data-t="${t}" class="${S.hwType === t ? "on" : ""}"><i data-lucide="${TYPE_ICON[t]}"></i>${TYPE_NAME[t].split(" ").pop()}</button>`).join("");
    $("#res-base").innerHTML = Object.keys(BASES).map((b) => `<option>${b}</option>`).join("");
    $("#res-specs").innerHTML = SPEC[S.hwType].filter((s) => s[1] !== "—").map(([k, l, v]) => `<label>${l}<input name="${k}" type="number" step="any" value="${v}"></label>`).join("");
    $("#hw-title").textContent = TYPE_NAME[S.hwType]; $("#hw-img").src = `assets/img/hw/${S.hwType}.jpg`;
    if (!hwView) hwView = HW.viewer($("#hw-canvas")); hwView.show(S.hwType);
    icons($("#view-res"));
    $$("#res-filters button").forEach((b) => (b.onclick = () => { S.resFilter = b.dataset.f; renderResources(); }));
    $$("#res-type button").forEach((b) => (b.onclick = () => { S.hwType = b.dataset.t; renderResources(); }));
    $$("#res-table tr[data-id]").forEach((tr) => (tr.onclick = () => { const r = resById(tr.dataset.id); S.hwType = r.type; renderResources(); }));
    $$("[data-del]").forEach((b) => (b.onclick = async (ev) => { ev.stopPropagation(); try { await API.delResource(b.dataset.del); await loadResources(); toast('<i data-lucide="trash-2"></i>Resource removed', "or"); } catch (e) { toast("Remove failed: " + esc(e.message), "rd"); } }));
  }
  $("#res-form").addEventListener("submit", async (ev) => {
    ev.preventDefault(); const fd = new FormData(ev.target), o = { type: S.hwType, sample: false };
    for (const [k, v] of fd.entries()) o[k] = ["name", "base", "status"].includes(k) ? v : +v;
    o.lonlat = BASES[o.base]; ["speed_kn", "boom_m", "skimmer_m3h", "storage_m3", "crew"].forEach((k) => (o[k] = o[k] || 0));
    try { await API.addResource(o); await loadResources(); ev.target.reset(); toast(`<i data-lucide="plus"></i>${esc(o.name)} added to inventory`); } catch (e) { toast("Add failed: " + esc(e.message), "rd"); }
  });
  async function loadResources() {
    S.resources = await API.resources();
    Map3D.setAssets(S.resources);
    Map3D.clearMarkers("assets");
    S.resources.forEach((r) => Map3D.marker({ kind: "asset", icon: TYPE_ICON[r.type], label: r.name, sub: `${TYPE_NAME[r.type]} · ${r.base}`, group: "assets", get: () => Map3D.assetPos(r.id) }));
    renderTree(); if (S.view === "res") renderResources();
  }

  // ------------------------------------------------------------------ data view
  async function renderData() {
    let L = null; try { L = await API.ledger(); } catch (e) { /* offline */ }
    const card = (ic, t, p, kv, cls) => `<div class="card ds ${cls || ""}"><h5><i data-lucide="${ic}"></i>${t}</h5><p>${p}</p><div class="kv">${kv.map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join("")}</div></div>`;
    $("#data-wrap").innerHTML =
      card("scan-search", "Meta SAM 3.1", "Promptable segmentation. Outlines oil in satellite, aircraft and drone images from a text or point prompt.", [["Endpoint", "/v1/responses"], ["Cost", "$0.0025 / image"], ["Used for", "Detect"]]) +
      card("brain-circuit", "Meta Muse Spark 1.3", "Writes the response plan as strict JSON: assignments, booms, closures and a reason for each.", [["Format", "json_schema strict"], ["Fallback", "rules planner"], ["Used for", "Plan"]]) +
      card("image", "Meta Muse Image 1.0", "Product imagery for the hardware catalogue (labelled AI-generated).", [["Images", "6"], ["Cost", "$0.01 each"], ["Used for", "Resources"]]) +
      card("wind", "Open-Meteo (live)", "Hourly wind (GFS/ICON blend) and ocean currents + waves (marine API) at the slick.", [["Wind", S.met ? `${S.met.wind_kn.toFixed(1)} kn` : "—"], ["Current", S.met ? `${S.met.current_kn.toFixed(2)} kn` : "—"], ["Source", S.met ? S.met.source : "—"]]) +
      card("satellite", "Sentinel-2 cloudless (EOX)", "Basemap imagery, CC BY 4.0. Terrain: AWS Terrain Tiles (open data).", [["Zoom", "11"], ["Extent", `${Geo.R.W.toFixed(0)} × ${Geo.R.H.toFixed(0)} km`], ["Exaggeration", `${Geo.R.exag}×`]]) +
      card("map", "Natural Earth 10m", "Coastline used to stop particles at the shore (beaching).", [["Sites", String(S.sites.filter((s) => s.kind !== "lane").length)], ["Lanes", String(S.sites.filter((s) => s.kind === "lane").length)], ["Coordinates", "approximate"]]) +
      card("gauge", "API budget", "Hard cap on paid Meta calls, shared with the demo video work.", [["Spent", L ? `$${L.total_usd.toFixed(4)}` : "—"], ["Cap", "$2.00"], ["Calls", L ? String(L.entries.length) : "—"]], "wide");
    icons($("#data-wrap"));
  }
  async function refreshBudget() { try { const h = await API.health(); $("#budget span").textContent = `$${(h.spent_usd || 0).toFixed(2)} / $${h.cap_usd || 2}`; $("#srv").className = "chip ok"; $("#srv span").textContent = h.meta_key ? "online · Meta key" : "online · offline models"; } catch (e) { $("#srv").className = "chip bad"; $("#srv span").textContent = "server offline"; } }

  // ------------------------------------------------------------------ views + boot
  function setView(v) {
    S.view = v; $$(".view").forEach((e) => e.classList.toggle("on", e.id === "view-" + v)); $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
    if (v === "board") renderBoard(); if (v === "res") renderResources(); if (v === "data") renderData();
  }
  $$("#tabs button").forEach((b) => (b.onclick = () => setView(b.dataset.view)));
  $$("#rail [data-stage]").forEach((b) => (b.onclick = () => setStage(b.dataset.stage)));
  $$("#rail [data-view-btn]").forEach((b) => (b.onclick = () => setView(b.dataset.viewBtn)));
  $("#obj-search").addEventListener("input", renderTree);
  $("#tl-play").onclick = () => { if (!S.fc) return; S.playing ? stop() : play(S.hour >= 72 ? 0 : S.hour); };
  $("#tl-track").addEventListener("click", (e) => { if (!S.fc) return; const r = e.currentTarget.getBoundingClientRect(); stop(); setHour(clamp((e.clientX - r.left) / r.width, 0, 1) * 72); });
  $("#t-home").onclick = () => Map3D.flyTo([56.3, 26.5], 175, { el: 0.95, az: -0.6 });
  $("#t-slick").onclick = () => S.slick && Map3D.flyTo(centroid(S.slick), 14);
  $("#t-tracks").onclick = (e) => { const b = e.currentTarget; b.classList.toggle("on"); Map3D.setGroupVisible("tracks", b.classList.contains("on")); };
  $("#t-lanes").onclick = (e) => { const b = e.currentTarget; b.classList.toggle("on"); Map3D.setGroupVisible("lanes", b.classList.contains("on")); };
  setInterval(() => { $("#utc").textContent = new Date().toISOString().slice(11, 19) + " UTC"; }, 1000);
  setInterval(() => { if (S.stage === "execute" && S.approved) renderInspector(); }, 700);

  async function boot() {
    await Geo.load();
    Map3D.init($("#map"));
    Map3D.onPick((ll) => { $("#cursor-ll").textContent = Geo.fmtLL(ll); if (S.stage === "detect" && !S.det) { S.footprintCenter = ll; renderInspector(); toast(`<i data-lucide="crosshair"></i>Image footprint centred on ${Geo.fmtLL(ll)}`, "or"); } });
    Map3D.onFrame((t) => {
      Map3D.setClock(t);
      if (S.approved && S.plan) { const k = (t - S.execT0 - 3) / 6; Map3D.boomProgress(clamp(k, 0, 1)); if (k > 1.2 && !S.execDone) { S.execDone = true; log("Boom closed around the slick · skimmers working at the apex", "#facc15"); moveCards((c) => c.kind === "det", "exec"); pipe(); } }
    });
    Map3D.flyTo([56.3, 26.5], 175, { el: 0.95, az: -0.6, dur: 0.01 });
    const tOk = await Map3D.loadTerrain();
    if (!tOk) toast('<i data-lucide="triangle-alert"></i>Terrain assets missing: showing a flat map', "or");
    try {
      S.sites = await API.sites();
      Map3D.setSites(S.sites, (m) => { Map3D.flyTo(m.data.lonlat, 22); });
      // keep a handle to each site marker for risk / closed states
      setTimeout(() => { $$(".mk-site").forEach((el) => { const name = el.querySelector("b").textContent; const s = S.sites.find((q) => q.name === name); if (s) S.siteMk[s.id] = { el }; }); }, 0);
      await loadResources();
    } catch (e) { toast('<i data-lucide="triangle-alert"></i>Server not reachable: start it with <b>python3 server/app.py</b>', "rd"); }
    fetchMet(DEFAULT_LL);
    refreshBudget(); renderTree(); renderInspector(); renderBoard(); pipe(); icons();
  }
  boot();
})();
