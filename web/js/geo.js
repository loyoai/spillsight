/* Region mapping (CONTRACT.md): Web Mercator crop -> world kilometres. x = east, z = south. */
const Geo = (() => {
  const R = { Z: 11, lon0: 56.30, lat0: 26.50, crop_w: 4096, crop_h: 2304, hmax_m: 1800, exag: 3 };
  const merc = (lon, lat, z) => {
    const n = 256 * 2 ** z, s = Math.sin((lat * Math.PI) / 180);
    return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
  };
  function derive() {
    const n = 256 * 2 ** R.Z, [xc, yc] = merc(R.lon0, R.lat0, R.Z);
    R.x0 = xc - R.crop_w / 2; R.y0 = yc - R.crop_h / 2;
    R.W = (R.crop_w / (n / 360)) * 111.32 * Math.cos((R.lat0 * Math.PI) / 180);
    R.H = (R.W * R.crop_h) / R.crop_w;
  }
  derive();
  async function load() {
    try { const r = await fetch("assets/region.json"); if (r.ok) Object.assign(R, await r.json()); } catch (e) { /* contract defaults */ }
    if (R.W == null || R.x0 == null) derive();
    return R;
  }
  function toWorld(lon, lat) {
    const [X, Y] = merc(lon, lat, R.Z);
    return [((X - R.x0) / R.crop_w - 0.5) * R.W, ((Y - R.y0) / R.crop_h - 0.5) * R.H];
  }
  function toLonLat(x, z) {
    const n = 256 * 2 ** R.Z;
    const X = (x / R.W + 0.5) * R.crop_w + R.x0, Y = (z / R.H + 0.5) * R.crop_h + R.y0;
    const lon = (X / n) * 360 - 180;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * Y) / n))) * 180) / Math.PI;
    return [lon, lat];
  }
  function km(a, b) {
    const r = Math.PI / 180, dLat = (b[1] - a[1]) * r, dLon = (b[0] - a[0]) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
  }
  const fmtLL = (ll) => `${Math.abs(ll[1]).toFixed(3)}°${ll[1] >= 0 ? "N" : "S"} ${Math.abs(ll[0]).toFixed(3)}°${ll[0] >= 0 ? "E" : "W"}`;
  return { R, load, toWorld, toLonLat, km, fmtLL };
})();
