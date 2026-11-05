// Frame-exact screen recording of the live console for the demo video.
// The page clock (performance.now, Date.now, timers, requestAnimationFrame) is virtualised and stepped
// 1/30 s per captured frame, so WebGL and UI animation are smooth regardless of capture speed.
// Real API calls (SAM 3.1, forecast, Muse Wonder) still run for real.
// usage: PUPPETEER_CORE=... node tools/record.mjs <outDir>   (DRY=1 runs the flow without capturing, to warm caches)
import { createRequire } from "module";
import fs from "fs";
const require = createRequire(import.meta.url);
const puppeteer = require(process.env.PUPPETEER_CORE || "puppeteer-core");
const OUT = process.argv[2] || "/tmp/spillsight-rec", DRY = process.env.DRY === "1";
const BASE = process.env.BASE || "http://127.0.0.1:8787/";
const T0 = 66.6, T1 = +(process.env.T1 || 178.8), FPS = 30;
const CAP = process.env.CAP ? process.env.CAP.split(",").map(Number) : null;   // only save frames in [a, b]           // voiceover times covered by the screen recording
fs.mkdirSync(OUT, { recursive: true });

const SHIM = `(() => {
  const vt = { t: 1000 }; window.__vt = vt; const d0 = Date.now();
  performance.now = () => vt.t; Date.now = () => d0 + vt.t;
  const raf = []; window.requestAnimationFrame = (cb) => { raf.push(cb); return raf.length; }; window.cancelAnimationFrame = () => {};
  const timers = new Map(); let id = 1;
  window.setTimeout = (fn, ms, ...a) => { const k = id++; timers.set(k, { at: vt.t + (+ms || 0), fn: () => (typeof fn === "function" ? fn(...a) : 0) }); return k; };
  window.setInterval = (fn, ms, ...a) => { const k = id++; timers.set(k, { at: vt.t + Math.max(1, +ms || 1), every: Math.max(1, +ms || 1), fn: () => fn(...a) }); return k; };
  window.clearTimeout = window.clearInterval = (k) => timers.delete(k);
  window.__advance = (dt) => {
    const end = vt.t + dt;
    for (let guard = 0; guard < 500; guard++) {
      let nk = null, nt = null; for (const [k, tm] of timers) if (tm.at <= end && (!nt || tm.at < nt.at)) { nk = k; nt = tm; }
      if (!nt) break; vt.t = Math.max(vt.t, nt.at); if (nt.every) nt.at += nt.every; else timers.delete(nk);
      try { nt.fn(); } catch (e) { console.error(e); }
    }
    vt.t = end; const q = raf.splice(0); q.forEach((cb) => { try { cb(vt.t); } catch (e) { console.error(e); } });
  };
})();`;

const browser = await puppeteer.launch({ executablePath: process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new", args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--window-size=1920,1080", "--hide-scrollbars"] });
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.evaluateOnNewDocument(SHIM);
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 120000 });
const adv = (ms) => page.evaluate((m) => window.__advance(m), ms);
// let the terrain, sites and assets load
for (let i = 0; i < 60; i++) { await adv(50); await new Promise((r) => setTimeout(r, 60)); }
await page.evaluate(() => {
  const g = document.querySelector("#g-hide"); if (g) g.click();
  const c = document.createElement("div"); c.id = "rec-cursor";
  c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.6 15 L11.6 22 L14.6 20.7 L11.6 14 L18 14 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  Object.assign(c.style, { position: "fixed", left: "0", top: "0", zIndex: 9999, pointerEvents: "none", transform: "translate(1400px,700px)", filter: "drop-shadow(0 2px 3px rgba(0,0,0,.5))" });
  document.body.appendChild(c);
  const st = document.createElement("style"); st.textContent = ".rec-ring{position:fixed;z-index:9998;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:2px solid #b6c94a;pointer-events:none}";
  document.head.appendChild(st);
  Map3D.flyTo([56.36, 26.52], 185, { el: 0.95, az: -0.6, dur: 0.01 });
});
for (let i = 0; i < 10; i++) await adv(33);

// ---------------------------------------------------------------- shot list (voiceover seconds)
let cur = [1400, 700];
const center = (sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }).catch(() => null);
const trackAt = (h) => page.$eval("#tl-track", (e, hh) => { const r = e.getBoundingClientRect(); return [r.x + r.width * hh / 72, r.y + r.height / 2]; }, h);
const A = [];
const move = (t, sel, dur = 0.7) => A.push({ t, kind: "move", sel, dur });
const click = (t, sel) => A.push({ t, kind: "click", sel });
const clickTrack = (t, h) => A.push({ t, kind: "track", h });
const js = (t, fn, arg) => A.push({ t, kind: "js", fn, arg });
const fly = (t, ll, dist, opt) => js(t, ([ll, dist, opt]) => Map3D.flyTo(ll, dist, opt), [ll, dist, opt]);
const flyC = (t, h, dist, opt) => js(t, ([h, dist, opt]) => { const c = Map3D.centroidAt(h); if (c) Map3D.flyTo(c, dist, opt); }, [h, dist, opt]);
const SL = [56.518, 26.47];

fly(T0, [56.45, 26.48], 120, { el: 0.95, az: -0.45, dur: 6.5 });
move(73.4, ".ab-sim", 0.8);
move(76.4, "#src-img", 0.8);
move(79.3, "#d-run", 0.7); click(80.3, "#d-run");
move(84.2, "#src", 0.8);
fly(88.0, SL, 30, { el: 0.9, az: -0.2, dur: 3.5 });
fly(93.2, SL, 9.5, { el: 0.95, az: -0.35, dur: 2.6 });
move(97.6, ".kvl b:nth-of-type(6)", 0.7);
fly(100.0, SL, 26, { el: 0.85, az: 0.15, dur: 2.8 });
move(103.0, "#d-next", 0.7); click(104.0, "#d-next");
move(116.0, "#met", 0.8);
clickTrack(118.4, 10.5);
move(121.8, ".sec .rowl", 0.8);
clickTrack(124.8, 5);
move(125.6, ".sec .rowl .bp-tag", 0.6);
// equipment check: the inventory in blueprint view
move(127.9, '#menu [data-view="res"]', 0.6); click(128.6, '#menu [data-view="res"]');
move(129.7, '#res-type [data-t="boom"]', 0.45); click(130.2, '#res-type [data-t="boom"]');
move(131.2, '#res-type [data-t="skimmer"]', 0.4); click(131.6, '#res-type [data-t="skimmer"]');
move(132.6, '#res-type [data-t="drone"]', 0.4); click(133.0, '#res-type [data-t="drone"]');
move(134.4, '#menu [data-view="ops"]', 0.6); click(135.0, '#menu [data-view="ops"]');
move(135.2, "#rec-row", 0.35); click(135.6, "#rec-row");
move(135.9, "#mm-go", 0.5); click(136.6, "#mm-go");
move(139.0, ".mcard", 0.8);
move(141.2, "[data-rsel]", 0.9);
clickTrack(143.4, 2);
flyC(144.0, 2, 8.0, { el: 0.92, az: -0.3, dur: 2.4 });
flyC(148.2, 2, 6.5, { el: 0.85, az: 0.45, dur: 5.5 });
fly(154.5, [56.45, 26.30], 24, { el: 0.85, az: -0.1, dur: 2.6 });
js(154.6, () => { const h = [...document.querySelectorAll("#inspector .sec-h")].find((e) => /Closures/.test(e.textContent)); if (h) document.querySelector("#inspector").scrollTop = h.offsetTop - 120; });
move(156.4, "#inspector .sec:nth-last-of-type(2) .rowl", 0.8);
move(161.4, "#p-ok", 0.8); click(162.7, "#p-ok");
move(164.6, "#map", 1.0);
move(166.9, '#menu [data-view="board"]', 0.5); click(167.5, '#menu [data-view="board"]');
// drag two shoreline cards across the board, the way an operator would
const drag = (t, title, col) => {
  move(t, `.bc.k-site[data-title="${title}"]`, 0.6);
  move(t + 0.8, `.col[data-col="${col}"] .col-b`, 0.9);
  js(t + 1.75, ([title, col]) => { const c = [...document.querySelectorAll(".bc.k-site")].find((e) => e.textContent.includes(title)); const dst = document.querySelector(`.col[data-col="${col}"]`); if (!c || !dst) return;
    const dt = new DataTransfer(); c.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true })); dst.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true })); dst.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true })); }, [title, col]);
};
drag(169.4, "Kumzar village coast", "exec");
drag(172.6, "Ras Musandam coast", "exec");
move(175.6, ".col:nth-child(6) .col-h", 0.9);
A.sort((a, b) => a.t - b.t);

// ---------------------------------------------------------------- capture loop
const N = Math.round((T1 - T0) * FPS); let ai = 0, mv = null, frame = 0;
const setCursor = (x, y) => page.evaluate(([x, y]) => { document.querySelector("#rec-cursor").style.transform = `translate(${x - 4}px,${y - 2}px)`; }, [x, y]);
const ring = (x, y) => page.evaluate(([x, y]) => { const r = document.createElement("div"); r.className = "rec-ring"; r.style.left = x + "px"; r.style.top = y + "px"; document.body.appendChild(r); r.animate([{ transform: "scale(.4)", opacity: 1 }, { transform: "scale(1.6)", opacity: 0 }], { duration: 420 }); setTimeout(() => r.remove(), 450); }, [x, y]);
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
for (frame = 0; frame < N; frame++) {
  const t = T0 + frame / FPS;
  while (ai < A.length && A[ai].t <= t) {
    const a = A[ai++];
    if (a.kind === "move") { const p = await center(a.sel); if (p) mv = { from: cur.slice(), to: p, t0: t, dur: a.dur }; }
    else if (a.kind === "click") { const p = await center(a.sel); if (p) { cur = p; await setCursor(...p); await page.mouse.click(p[0], p[1]); await ring(...p); } else console.log("missing", a.sel, t.toFixed(1)); const W = DRY || (CAP && t < CAP[0]); if (W && a.sel === "#mm-go") await page.waitForSelector("#p-ok", { timeout: 120000 }); if (W && a.sel === "#d-run") await page.waitForSelector("#d-next", { timeout: 60000 }); if (W && a.sel === "#d-next") await page.waitForSelector("#f-next", { timeout: 60000 }); }
    else if (a.kind === "track") { const p = await trackAt(a.h); mv = null; cur = p; await setCursor(...p); await page.mouse.click(p[0], p[1]); await ring(...p); }
    else if (a.kind === "js") await page.evaluate(a.fn, a.arg);
  }
  if (mv) { const k = Math.min(1, (t - mv.t0) / mv.dur), e = ease(k); cur = [mv.from[0] + (mv.to[0] - mv.from[0]) * e, mv.from[1] + (mv.to[1] - mv.from[1]) * e]; await setCursor(...cur); if (k >= 1) mv = null; }
  await adv(1000 / FPS);
  if (!DRY && (!CAP || (t >= CAP[0] && t <= CAP[1]))) await page.screenshot({ path: `${OUT}/f${String(frame).padStart(5, "0")}.jpg`, type: "jpeg", quality: 90 });
  if (frame % 300 === 0) console.log("frame", frame, "/", N, "t", t.toFixed(1));
}
console.log("done", N, "frames");
await browser.close();
