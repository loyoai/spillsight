# SpillSight server

```
python3 server/app.py          # -> http://127.0.0.1:8787  (serves ../web, index.html at /)
python3 tools/build_data.py    # rebuild data/land.json, sites.json, resources.seed.json (needs ../film)
python3 tools/make_sample.py   # ONE paid SAM call -> data/sample_detect.json (already done)
```

Python 3 stdlib only. The SAM mask decoder is vendored pure Python (`server/vendor/meta_sam_parser`, SAM License).
The Meta key is read from `META_API_KEY` (env) or `../.env` and is never logged. Every paid call is appended to
`../video/assets/api_cost_ledger.json`. Paid calls are refused if they would push the total over **$2.00**.

## Endpoints (shapes per CONTRACT.md; coordinates are `[lon, lat]`)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | `{ok, meta_key, spent_usd, cap_usd}` |
| GET | `/api/sites` | 12 sites + 2 `lane` items (`path`). All `approx: true`. |
| GET/POST | `/api/resources` | POST body = resource without id → saved resource (id like `ve-user-1`). Store: `data/resources.json` (copied from the seed on first run). |
| DELETE | `/api/resources/<id>` | `{ok, deleted}` or 404 |
| GET | `/api/metocean?lon=&lat=` | Live Open-Meteo, current UTC hour, 10 min cache. Extra fields: `defaulted` (parts that fell back), `lonlat`. |
| POST | `/api/detect` | SAM 3.1, $0.0025 per call. `points` → point prompt `<0f>1<|point;x;y;w;h|>…`. Results are cached on disk (`server/cache/`) by image+prompt, so a repeat costs $0 (`cached: true`). Extra field: `prompt`. |
| POST | `/api/detect/sample` | Bundled result (simulated AI-generated SAR image, `web/assets/img/sample_sar.jpg`), cost 0. Optional body `{footprint}`; the default footprint is 6 km wide centred on 56.52, 26.47. Extra fields: `footprint, image_url, label, recorded, prompt`. |
| POST | `/api/forecast` | Body `{slick?, hours=72, n=300, metocean?}`. No slick → default HZ-01 ellipse. No metocean → live fetch at the slick centroid. Deterministic for the same input. |
| POST | `/api/plan` | Muse Spark 1.3 (≈$0.02 per call) with a rules fallback. Optional `engine: "rules"` forces the free planner. Identical requests are served from memory (`cached: true`, cost 0). `resources` is optional (defaults to the store). Pass the forecast `stats` as `forecast_summary`. |
| GET | `/api/ledger` | `{total_usd, cap_usd, remaining_usd, entries}` |

## Forecast details
- Velocity = current + 3% of wind (wind blows from `wind_from_deg`) + random walk with K = 3 m²/s, hourly steps, constant met-ocean.
- Particles start uniformly inside the slick polygon. A particle beaches when a step lands on Natural Earth 10m land; the beach point is found by bisection.
- `tracks[i]` has `hours + 1` points (t = 0 … hours). After beaching, the beach point repeats.
- `impacts`: for shore sites, particles that beach within 4 km (`eta_h` is the earliest beach hour). For `lane` items, floating particles that come within 2 km of the lane line (`eta_h` is the first hour).
- Extra `stats` fields: `centroid_lonlat`, `leading_edge_lonlat`, `centroid_end_lonlat`, `drift_km_24h`. Extra top-level fields: `model`, `metocean`.

## Planner details
- Rules: weights are normalised. Score = w_time·(1 − eta/deadline) + w_capacity·capacity + w_distance·(1 − d/d_max). Distances are great-circle × 1.15.
- Containment targets are intercept points on the drifting slick. Intakes, mangroves and coral get booms before open-water containment. Deflection angle = asin(0.7 / current_kn), capped at 30°. Closures start 4 h before `eta_h`.
- Muse: strict JSON schema, low reasoning effort. Output is validated afterwards: unknown or duplicate resource ids are dropped, `eta_h` is recomputed, and unknown site ids are nulled or dropped.
- On error, no key, or the budget cap: falls back to rules, with `fallback_reason`.
