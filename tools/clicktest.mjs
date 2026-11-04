// QA: click every control in the console, run the real pipeline once (live SAM 3.1), report errors.
// usage: node tools/clicktest.mjs [baseUrl] [outDir]
import { createRequire } from "module";
import fs from "fs";
const require = createRequire(import.meta.url);
const puppeteer = require(process.env.PUPPETEER_CORE || "puppeteer-core");
const base = process.argv[2] || "http://127.0.0.1:8787/", out = process.argv[3] || "/tmp/spillsight-qa";
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [], log = (...a) => console.log(...a);
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new", args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--window-size=1920,1080"] });
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
page.on("dialog", (d) => d.dismiss());
const click = async (sel, wait = 400) => { const el = await page.waitForSelector(sel, { visible: true, timeout: 90000 }); await el.click(); await sleep(wait); };
const toasts = async () => page.$$eval(".toast", (ts) => ts.map((t) => t.textContent.trim()).slice(-2));
const shot = (n) => page.screenshot({ path: `${out}/${n}.png` });

await page.goto(base, { waitUntil: "networkidle0", timeout: 120000 }); await sleep(3500);
log("guide visible:", await page.$eval("#guide", (g) => g.classList.contains("on")));
await shot("q01-start");
// top bar menus
for (const m of ["file", "tools", "help"]) { await click(`#menu [data-dd="${m}"]`, 300); const items = await page.$$eval("#dd .it", (e) => e.map((x) => x.textContent.trim())); log("menu", m, items); await page.mouse.click(5, 1070); await sleep(150); }
await click('#menu [data-dd="tools"]', 300); await click("#dd [data-i='0']", 600); log("basemap toggled:", await page.$eval("#t-base", (b) => b.classList.contains("on")));
await click('#menu [data-dd="tools"]', 300); await click("#dd [data-i='0']", 300);
await click('#menu [data-dd="help"]', 300); await click("#dd [data-i='1']", 300); log("help toast:", await toasts());
await click("#srv", 500); log("srv toast:", await toasts());
await click("#nearby", 400); log("nearby:", (await toasts()).slice(-1)[0].slice(0, 90));
for (const t of ["layers", "assets", "alerts", "targets"]) await click(`#rail [data-tab="${t}"]`, 200);
await click("#compass", 900); await click("#t-layers", 200); await click('#rail [data-tab="targets"]', 200);
// right-click context menu on the map
await page.mouse.click(900, 500, { button: "right" }); await sleep(400);
log("ctx items:", await page.$$eval("#ctx .it", (e) => e.map((x) => x.textContent.trim())));
await click('#ctx [data-a="measure"]', 300); await page.mouse.click(1100, 600, { button: "right" }); await sleep(300); await click('#ctx [data-a="measure"]', 400); log("measure:", (await toasts()).slice(-1)[0]);
// 1. live SAM 3.1
await click("#d-run"); await page.waitForSelector("#d-next", { timeout: 90000 }); await sleep(1500);
log("detect live:", await page.$eval(".kvl", (k) => k.textContent.replace(/\s+/g, " ").slice(0, 160)));
await click("#img-exp", 600); await shot("q02-lightbox"); await click("#lb-x", 300);
await shot("q03-detect");
// 2. forecast
await click("#d-next"); await page.waitForSelector("#f-next", { timeout: 120000 }); await sleep(3000);
await click('[data-met="live"]', 300); await click('[data-met="scenario"]', 300);
await shot("q04-forecast");
// 3. recommender modal
await click("#f-next", 600); await click("#mm-info", 300); log("metric help:", await page.$("#mbox .metric-help") ? "shown" : "missing");
await click('[data-m="sensitivity"][data-d="10"]', 200); await click('[data-z="endurance"]', 200); await click("#mm-cont", 200);
await shot("q05-metrics");
await click("#mm-go", 200); await page.waitForSelector("#p-ok", { timeout: 180000 }); await sleep(1500);
log("plan source:", await page.$eval(".ov-h small", (e) => e.textContent));
await click("[data-rsel]", 800); log("asset inspector:", await page.$eval(".ov-h b", (e) => e.textContent)); await shot("q06-asset-inspector"); await click("#back-stage", 400);
await click('#rail [data-tab="assets"]', 400); await shot("q07-recommender"); await click('#rail [data-tab="targets"]', 200);
// 4. approve
await click("#p-ok", 9000); await shot("q08-execute");
await click("#chip-loc", 600);
// board
await click('#menu [data-view="board"]', 800); await click("#b-add", 300); await click("#b-sort", 300); await click("#b-filter", 300); await click("#b-filter", 300);
await page.type("#b-search", "Khasab"); await sleep(300); log("board filtered cards:", await page.$$eval(".bc", (e) => e.length)); await page.$eval("#b-search", (e) => { e.value = ""; e.dispatchEvent(new Event("input")); });
await shot("q09-board");
// assets: add then delete
await click('#menu [data-view="res"]', 1200); await click('#res-type [data-t="drone"]', 600); await shot("q10-assets-drone");
for (const t of ["vessel", "skimmer", "boom", "storage", "aircraft"]) { await click(`#res-type [data-t="${t}"]`, 900); await shot(`q11-model-${t}`); }
await page.type('#res-form input[name="name"]', "QA Test Vessel"); await click('#res-form button[type="submit"]', 1200);
const n1 = await page.$$eval("#res-table tr[data-id]", (r) => r.length);
const del = await page.$$eval("#res-table tr", (rows) => { const r = rows.find((x) => x.textContent.includes("QA Test Vessel")); return r ? r.dataset.id : null; });
if (del) await click(`[data-del="${del}"]`, 1200);
log("assets added/removed:", n1, "->", await page.$$eval("#res-table tr[data-id]", (r) => r.length));
await click('#menu [data-view="data"]', 1200); await shot("q12-data");
await click("#export", 600);
await click("#b-guide", 300).catch(() => {});
log("guide step:", await page.$eval("#guide .gh", (g) => g.textContent.trim()).catch(() => "hidden"));
log("ERRORS:", errors.length ? errors : "none");
await browser.close();
