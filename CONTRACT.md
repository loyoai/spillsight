# SpillSight — build contract (internal)

Region: **Strait of Hormuz**. Everything below is shared by the terrain build, the server and the web app.

## Region / world mapping (fixed)
- Web Mercator, zoom `Z = 11`, crop centred on lon `56.30`, lat `26.50`.
- `crop_w = 4096` px, `crop_h = 2304` px (in zoom-11 pixel space).
- Mercator: `n = 256 * 2**Z; X = (lon+180)/360*n; Y = (0.5 - ln((1+sin φ)/(1-sin φ))/(4π))*n`.
- `x0 = Xc - crop_w/2`, `y0 = Yc - crop_h/2`; `u = (X-x0)/crop_w`, `v = (Y-y0)/crop_h` (0..1, v down).
- World units are **km**: `W = crop_w / (n/360) * 111.32 * cos(26.5°)`, `H = W * crop_h / crop_w`.
  `x = (u-0.5)*W` (east), `z = (v-0.5)*H` (south), `y` = up.
- `web/assets/region.json` (written by terrain build) holds `{Z, lon0, lat0, crop_w, crop_h, x0, y0, W, H, hmax_m, exag}`.

## Terrain assets (web/assets/tex/) — terrain build
- `sat.jpg` 4096×2048 (resampled from the 4096×2304 crop; Sentinel-2 cloudless © EOX, CC BY 4.0), hillshade baked in, sea slightly darkened for a night-ops look is NOT baked (raw colours).
- `height.png` 1024×576 grayscale: 0 = sea/≤0 m, 1..255 = land height scaled to `hmax_m` (AWS Terrain Tiles, terrarium).
- `seamask.png` 1024×512: white = sea, black = land.

## Server (server/app.py, Python 3 stdlib only + `requests` optional) — port 8787
Serves `web/` statically and these JSON endpoints. All coordinates are `[lon, lat]`.
- `GET  /api/health` → `{ok, meta_key: bool, spent_usd, cap_usd}`
- `GET  /api/sites` → `[{id, name, kind: port|intake|mangrove|coral|coast|town|lane, lonlat:[..], country, note, approx: true}]`
  (`kind=lane` items have `path: [[lon,lat],...]` instead of `lonlat`)
- `GET  /api/resources` · `POST /api/resources` (body = resource without id → returns saved) · `DELETE /api/resources/<id>`
  resource: `{id, type: vessel|boom|skimmer|storage|drone|aircraft, name, base, lonlat, speed_kn, boom_m, skimmer_m3h, storage_m3, crew, status: ready|busy|maintenance, sample: true|false}`
- `GET  /api/metocean?lon=&lat=` → `{wind_kn, wind_from_deg, current_kn, current_to_deg, wave_m, source: "open-meteo"|"default", time}` (live Open-Meteo forecast + marine APIs, 10 min cache, fallback defaults)
- `POST /api/detect` body `{image_b64 (jpeg/png, no data: prefix), prompt: "rainbow sheen", points?: [[x,y],...], footprint?: [[lon,lat] TL, TR, BR, BL]}`
  → `{ok, model: "sam-3.1", instances: [{score, box:[x1,y1,x2,y2], polygon:[[x,y],...], polygon_lonlat?: [[lon,lat],...]}], image_size:[w,h], cost_usd, cached: bool}`
  `POST /api/detect/sample` → same shape, from the bundled sample (no API cost).
- `POST /api/forecast` body `{slick: [[lon,lat],...] polygon, hours: 72, n: 300, metocean: {...}}`
  → `{hours, particles: N, tracks: [[[lon,lat] per hour] per particle] (rounded 4 dp), beach_h: [h|null], stats: {first_landfall_h, ashore_pct: {6,12,24,48,72}, drift_kn, drift_to_deg, area_km2}, impacts: [{site_id, eta_h, n}] sorted by eta}`
- `POST /api/plan` body `{forecast_summary, impacts, resources, metocean, weights: {time, capacity, distance}}`
  → `{ok, source: "muse-wonder-1.0"|"rules", cost_usd, plan: {summary, assignments: [{resource_id, task, target_lonlat, eta_h, score, reason}], booms: [{site_id|null, kind: containment|deflection|exclusion, angle_deg, length_m, reason}], closures: [{site_id, from_h, action, reason}], advisories: [{kind, radius_km, reason}], risks: [str]}}`
- `GET  /api/ledger` → `{total_usd, cap_usd, entries:[...]}`. Hard cap: refuse paid calls if total would exceed **$2.00** (shared with `../video/assets/api_cost_ledger.json`).
- Key: read `META_API_KEY` from `../.env` (or env). Never log/print/commit it.

## Default scenario (simulated)
Incident `HZ-01`: tanker collision (simulated), slick centred **lon 56.52, lat 26.47**, ~2.0 × 0.8 km ellipse, long axis 60°.
