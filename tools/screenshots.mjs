// Drive the console through detect -> forecast -> pair -> approve and save screenshots to docs/img.
// usage: node tools/screenshots.mjs [baseUrl] [outDir]   (needs puppeteer-core and Google Chrome)
import { createRequire } from "module";
import fs from "fs";
const require = createRequire(import.meta.url);
const PUP = process.env.PUPPETEER_CORE || "puppeteer-core";
const puppeteer = require(PUP);
const base = process.argv[2] || "http://127.0.0.1:8787/";
const out = process.argv[3] || "docs/img";
const live = process.env.LIVE === "1";            // LIVE=1 runs a paid SAM call instead of the cached result
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new", args: ["--use-angle=metal", "--enable-webgl", "--ignore-gpu-blocklist", "--window-size=1920,1080"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });
page.on("console", (m) => { if (m.type() === "error") console.log("console:", m.text()); });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
const shot = async (name) => { await page.screenshot({ path: `${out}/${name}.png` }); console.log("saved", name); };
const click = async (sel) => { await page.waitForSelector(sel, { visible: true, timeout: 60000 }); await page.click(sel); };

await page.goto(base, { waitUntil: "networkidle0", timeout: 120000 });
await sleep(4000);
await shot("01-overview");
await click(live ? "#d-run" : "#d-sample");
await page.waitForSelector("#d-next", { timeout: 60000 }); await sleep(2200);
await shot("02-detect");
await click("#d-next"); await sleep(1500);
await click("#f-run");
await page.waitForSelector("#f-next", { timeout: 120000 }); await sleep(7000);
await shot("03-forecast");
await click("#f-next"); await sleep(1200);
await shot("04-pairing");
await click("#m-go");
await page.waitForSelector("#p-ok", { timeout: 180000 }); await sleep(2500);
await shot("05-plan");
await click("#p-ok"); await sleep(9000);
await shot("06-execute");
await page.evaluate(() => document.querySelector('[data-view="board"]').click()); await sleep(800);
await shot("07-board");
await page.evaluate(() => document.querySelector('[data-view="res"]').click()); await sleep(1800);
await shot("08-resources");
await page.evaluate(() => document.querySelector('[data-view="data"]').click()); await sleep(1200);
await shot("09-data");
await browser.close();
