/* Response hardware models for the map and the hardware viewer (Three.js r149, WebGL1-safe: Phong/Lambert only).
 * Every model is ~1 unit long, +x is forward, y is up, waterline at y = 0. */
const HW = (() => {
  const phong = (c, o) => new THREE.MeshPhongMaterial(Object.assign({ color: c, shininess: 40, specular: 0x222222 }, o || {}));
  const M = {
    orange: phong(0xf2701d, { shininess: 60 }), red: phong(0xb3261e), white: phong(0xf4f6f8, { shininess: 70 }), grey: phong(0x9aa3ad), dark: phong(0x2a2f36),
    steel: phong(0x6b7480, { shininess: 90, specular: 0x555555 }), yellow: phong(0xf5c518, { shininess: 50 }), black: phong(0x111418), glass: phong(0x1b2a3a, { shininess: 120, specular: 0x88aaff }),
    deck: phong(0x5d6b5f), rubber: phong(0x1a1a1a, { shininess: 10 }), gold: phong(0xc9a227, { shininess: 100, specular: 0xffeeaa }), blue: phong(0x3b82f6),
  };
  const box = (w, h, d, m) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  const cyl = (r1, r2, h, m, s) => new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, h, s || 20), m);
  const at = (o, x, y, z) => { o.position.set(x, y, z); return o; };

  // canvas textures (power-of-two)
  function canvasTex(w, h, draw) { const c = document.createElement("canvas"); c.width = w; c.height = h; draw(c.getContext("2d"), w, h); const t = new THREE.CanvasTexture(c); t.anisotropy = 4; return t; }
  const solarTex = canvasTex(256, 128, (g, w, h) => { g.fillStyle = "#0d1f45"; g.fillRect(0, 0, w, h); g.strokeStyle = "#5b79b8"; g.lineWidth = 1.5; for (let x = 0; x <= w; x += 16) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); } for (let y = 0; y <= h; y += 16) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); } });
  const winTex = canvasTex(128, 32, (g, w, h) => { g.fillStyle = "#f4f6f8"; g.fillRect(0, 0, w, h); g.fillStyle = "#14202c"; for (let x = 6; x < w - 8; x += 15) g.fillRect(x, 9, 11, 14); });
  const foilTex = canvasTex(64, 64, (g, w, h) => { const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, "#e9c25a"); gr.addColorStop(0.5, "#b88a1e"); gr.addColorStop(1, "#f2d27a"); g.fillStyle = gr; g.fillRect(0, 0, w, h); g.strokeStyle = "rgba(90,60,10,.5)"; for (let i = 0; i < 9; i++) { g.beginPath(); g.moveTo(Math.random() * w, 0); g.lineTo(Math.random() * w, h); g.stroke(); } });

  // smooth ship hull: lofted cross-sections, flared bow, transom stern
  function hullGeo(L, B, D, bowRake) {
    const N = 28, R = 9, pos = [], idx = [];
    for (let i = 0; i <= N; i++) {
      const u = i / N, x = -L / 2 + u * L;
      const bow = u > 0.62 ? Math.pow((u - 0.62) / 0.38, 1.7) : 0, stern = u < 0.06 ? (0.06 - u) / 0.06 * 0.12 : 0;
      const halfB = (B / 2) * (1 - bow * 0.98) * (1 - stern), keel = D * (0.15 + 0.85 * (1 - bow * 0.6)), sheer = D * 0.12 * bow + 0.0;
      for (let j = 0; j <= R; j++) {
        const a = (j / R) * Math.PI, s = Math.cos(a), c = Math.sin(a);
        const w = halfB * Math.sign(s) * Math.pow(Math.abs(s), 0.55), y = -keel * Math.pow(c, 1.6) + sheer * (1 - c);
        pos.push(x + bow * bowRake * (1 - c) * 0.0, y + D * 0.35, w);
      }
    }
    for (let i = 0; i < N; i++) for (let j = 0; j < R; j++) { const a = i * (R + 1) + j, b = a + R + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
    // transom
    const t0 = pos.length / 3; pos.push(-L / 2, D * 0.35, 0); for (let j = 0; j < R; j++) idx.push(t0, j + 1, j);
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    return g;
  }
  function deckGeo(L, B) {
    const s = new THREE.Shape(), l = L / 2, b = B / 2;
    s.moveTo(-l, -b); s.lineTo(l * 0.24, -b); s.bezierCurveTo(l * 0.7, -b, l * 0.92, -b * 0.35, l, 0); s.bezierCurveTo(l * 0.92, b * 0.35, l * 0.7, b, l * 0.24, b); s.lineTo(-l, b); s.closePath();
    const g = new THREE.ShapeGeometry(s, 24); g.rotateX(-Math.PI / 2); return g;
  }
  function rail(L, B, y, m) {
    const g = new THREE.Group(), n = 14;
    for (const side of [-1, 1]) {
      const top = box(L * 0.7, 0.006, 0.006, m); at(top, -L * 0.12, y + 0.035, side * B * 0.48); g.add(top);
      for (let i = 0; i < n; i++) { const p = box(0.005, 0.035, 0.005, m); at(p, -L * 0.47 + (i / (n - 1)) * L * 0.7, y + 0.018, side * B * 0.48); g.add(p); }
    }
    return g;
  }
  function wake(len) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([-0.48, 0.004, 0.11, -0.48, 0.004, -0.11, -len, 0.004, 0.62, -len, 0.004, -0.62], 3));
    g.setIndex([0, 2, 1, 1, 2, 3]);
    return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }));
  }

  function vessel() {
    const g = new THREE.Group(), L = 1, B = 0.24, D = 0.1;
    const hull = new THREE.Mesh(hullGeo(L, B, D, 0), M.orange); g.add(hull);
    const boot = new THREE.Mesh(hullGeo(L * 0.995, B * 1.002, D * 0.45, 0), M.red); boot.position.y = -0.02; boot.scale.set(1, 1, 1.004); g.add(boot);
    const deck = new THREE.Mesh(deckGeo(L * 0.98, B * 0.96), M.deck); deck.position.y = D * 0.36; g.add(deck);
    // superstructure forward, working deck aft
    const sup1 = at(box(0.26, 0.07, 0.2, M.white), 0.14, 0.08, 0); g.add(sup1);
    const sup2 = at(box(0.2, 0.06, 0.19, M.white), 0.16, 0.145, 0); g.add(sup2);
    const bridge = at(box(0.15, 0.055, 0.215, M.white), 0.18, 0.2, 0); g.add(bridge);
    const wins = new THREE.Mesh(new THREE.PlaneGeometry(0.215, 0.026), new THREE.MeshBasicMaterial({ map: winTex })); wins.rotation.y = Math.PI / 2; at(wins, 0.2555, 0.205, 0); g.add(wins);
    for (const s of [-1, 1]) { const sw = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.022), new THREE.MeshBasicMaterial({ map: winTex })); at(sw, 0.18, 0.205, s * 0.1076); if (s < 0) sw.rotation.y = Math.PI; g.add(sw); }
    const roof = at(box(0.17, 0.008, 0.24, M.grey), 0.18, 0.231, 0); g.add(roof);
    const mast = at(cyl(0.006, 0.008, 0.16, M.white, 8), 0.16, 0.31, 0); g.add(mast);
    const yard = at(box(0.012, 0.006, 0.09, M.white), 0.16, 0.35, 0); g.add(yard);
    const radar = at(box(0.07, 0.006, 0.012, M.dark), 0.16, 0.37, 0); g.add(radar); g.userData.radar = radar;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.016, 14, 10), M.white); at(dome, 0.2, 0.25, 0.06); g.add(dome);
    const funnel = at(cyl(0.022, 0.026, 0.07, M.orange, 16), 0.06, 0.16, 0); g.add(funnel);
    const ftop = at(cyl(0.022, 0.022, 0.012, M.black, 16), 0.06, 0.2, 0); g.add(ftop);
    // boom reel with yellow boom wraps, A-frame, crane, life rafts
    const reel = new THREE.Group();
    const drum = cyl(0.055, 0.055, 0.16, M.yellow, 24); drum.rotation.x = Math.PI / 2; reel.add(drum);
    for (const s of [-1, 1]) { const fl = cyl(0.075, 0.075, 0.008, M.steel, 24); fl.rotation.x = Math.PI / 2; fl.position.z = s * 0.084; reel.add(fl); }
    const stand = box(0.03, 0.08, 0.17, M.steel); stand.position.y = -0.04; reel.add(stand);
    at(reel, -0.22, 0.15, 0); g.add(reel); g.userData.reel = reel;
    const af = new THREE.Group();
    for (const s of [-1, 1]) { const leg = box(0.012, 0.16, 0.012, M.yellow); leg.position.set(0, 0.08, s * 0.1); leg.rotation.z = -0.28; af.add(leg); }
    const beam = box(0.014, 0.014, 0.21, M.yellow); beam.position.set(-0.022, 0.155, 0); af.add(beam);
    at(af, -0.43, D * 0.36, 0); g.add(af);
    const crane = new THREE.Group(); const cb = cyl(0.014, 0.018, 0.05, M.yellow, 12); cb.position.y = 0.025; crane.add(cb);
    const jib = box(0.18, 0.012, 0.012, M.yellow); jib.position.set(-0.08, 0.07, 0); jib.rotation.z = 0.35; crane.add(jib);
    at(crane, -0.06, D * 0.36, 0.08); g.add(crane);
    for (const s of [-1, 1]) { const raft = cyl(0.018, 0.018, 0.045, M.white, 12); raft.rotation.z = Math.PI / 2; at(raft, 0.05, 0.13, s * 0.105); g.add(raft); }
    g.add(rail(L, B, D * 0.36, M.white));
    const w = wake(1.7); g.add(w); g.userData.wake = w;
    return g;
  }

  function barge() {
    const g = new THREE.Group(), L = 1.2, B = 0.3, D = 0.08;
    const hull = new THREE.Mesh(hullGeo(L, B, D, 0), M.dark); hull.scale.set(1, 1, 1); g.add(hull);
    const deck = new THREE.Mesh(deckGeo(L * 0.98, B * 0.96), M.grey); deck.position.y = D * 0.36; g.add(deck);
    for (let i = 0; i < 4; i++) {
      const t = at(cyl(0.085, 0.085, 0.1, M.white, 24), -0.38 + i * 0.22, 0.09, 0); g.add(t);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.085, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2), M.white); at(cap, -0.38 + i * 0.22, 0.14, 0); cap.scale.y = 0.35; g.add(cap);
      const vlv = at(cyl(0.01, 0.01, 0.03, M.red, 8), -0.38 + i * 0.22, 0.17, 0); g.add(vlv);
    }
    const pipe = box(0.8, 0.012, 0.012, M.steel); at(pipe, -0.05, 0.06, 0.12); g.add(pipe);
    const house = at(box(0.12, 0.08, 0.2, M.white), -0.52, 0.08, 0); g.add(house);
    const hw = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.024), new THREE.MeshBasicMaterial({ map: winTex })); hw.rotation.y = Math.PI / 2; at(hw, -0.459, 0.095, 0); g.add(hw);
    g.add(rail(L, B, D * 0.36, M.grey));
    const w = wake(1.3); g.add(w); g.userData.wake = w;
    return g;
  }

  function skimmer() {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.055, 14, 40), M.orange); ring.rotation.x = Math.PI / 2; ring.position.y = 0.03; g.add(ring);
    for (let k = 0; k < 3; k++) { const a = (k / 3) * Math.PI * 2, arm = box(0.28, 0.02, 0.03, M.steel); arm.position.set(Math.cos(a) * 0.14, 0.07, Math.sin(a) * 0.14); arm.rotation.y = -a; g.add(arm); }
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.09, 0.09, 28, 1, true), phong(0xd8dde2, { side: THREE.DoubleSide, shininess: 110, specular: 0x999999 })); bowl.position.y = 0.05; g.add(bowl);
    const weir = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.01, 8, 32), M.steel); weir.rotation.x = Math.PI / 2; weir.position.y = 0.095; g.add(weir);
    const oil = new THREE.Mesh(new THREE.CircleGeometry(0.12, 28), phong(0x0b0806, { shininess: 140, specular: 0x666666 })); oil.rotation.x = -Math.PI / 2; oil.position.y = 0.075; g.add(oil);
    const pump = at(cyl(0.045, 0.05, 0.1, M.yellow, 16), 0, 0.14, 0); g.add(pump);
    const motor = at(cyl(0.035, 0.035, 0.05, M.dark, 16), 0, 0.21, 0); g.add(motor);
    const hose = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0.15, 0), new THREE.Vector3(-0.18, 0.2, 0.02), new THREE.Vector3(-0.38, 0.08, 0.05), new THREE.Vector3(-0.6, 0.04, 0.02)]), 24, 0.022, 8), M.rubber); g.add(hose);
    const hose2 = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0.2, 0.02), new THREE.Vector3(-0.15, 0.26, 0.08), new THREE.Vector3(-0.35, 0.12, 0.12), new THREE.Vector3(-0.6, 0.06, 0.1)]), 24, 0.01, 6), M.blue); g.add(hose2);
    return g;
  }

  function boomSection() {
    const g = new THREE.Group(), n = 13, pts = [];
    for (let i = 0; i < n; i++) { const u = i / (n - 1), x = -0.6 + u * 1.2, z = Math.sin(u * Math.PI) * 0.18 - 0.08; pts.push([x, z]); }
    pts.forEach(([x, z], i) => {
      const f = new THREE.Mesh(new THREE.CapsuleGeometry ? new THREE.CapsuleGeometry(0.045, 0.06, 6, 12) : new THREE.CylinderGeometry(0.045, 0.045, 0.12, 14), M.yellow);
      f.rotation.z = Math.PI / 2; const nx = pts[Math.min(n - 1, i + 1)], pv = pts[Math.max(0, i - 1)]; f.rotation.y = -Math.atan2(nx[1] - pv[1], nx[0] - pv[0]); f.position.set(x, 0.04, z); g.add(f);
      const sk = box(0.1, 0.11, 0.008, phong(0xd97706)); sk.position.set(x, -0.04, z); sk.rotation.y = f.rotation.y; g.add(sk);
      const bal = box(0.1, 0.012, 0.014, M.steel); bal.position.set(x, -0.1, z); bal.rotation.y = f.rotation.y; g.add(bal);
    });
    const line = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map(([x, z]) => new THREE.Vector3(x, 0.09, z))), 40, 0.006, 6), M.dark); g.add(line);
    for (const [x, z] of [pts[0], pts[n - 1]]) { const b = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), M.red); b.position.set(x, 0.05, z); g.add(b); const pole = at(cyl(0.006, 0.006, 0.12, M.white, 6), x, 0.15, z); g.add(pole); }
    return g;
  }

  function drone() {
    const g = new THREE.Group(), rot = [];
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.11, 24, 16), M.white); body.scale.set(1.25, 0.45, 1); g.add(body);
    const top = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 10), M.dark); top.scale.set(1, 0.4, 1); top.position.y = 0.04; g.add(top);
    const gps = at(cyl(0.025, 0.025, 0.02, M.white, 16), -0.02, 0.07, 0); g.add(gps);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
      const arm = box(0.26, 0.018, 0.026, M.dark); arm.position.set(Math.cos(a) * 0.18, 0.01, Math.sin(a) * 0.18); arm.rotation.y = -a; g.add(arm);
      const mot = at(cyl(0.024, 0.026, 0.04, M.steel, 14), Math.cos(a) * 0.31, 0.03, Math.sin(a) * 0.31); g.add(mot);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.11, 28), new THREE.MeshBasicMaterial({ color: 0x9fb4c8, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }));
      disc.rotation.x = -Math.PI / 2; disc.position.set(Math.cos(a) * 0.31, 0.056, Math.sin(a) * 0.31); g.add(disc);
      const blade = box(0.21, 0.004, 0.022, M.black); blade.position.copy(disc.position); blade.position.y += 0.002; g.add(blade); rot.push(blade);
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.008, 8, 6), new THREE.MeshBasicMaterial({ color: k < 3 ? 0xef4444 : 0x22c55e })); led.position.set(Math.cos(a) * 0.31, 0.005, Math.sin(a) * 0.31); g.add(led);
    }
    // gimbal + thermal camera
    const yoke = at(box(0.012, 0.05, 0.07, M.dark), 0.07, -0.06, 0); g.add(yoke);
    const cam = at(box(0.06, 0.05, 0.06, M.dark), 0.08, -0.09, 0); g.add(cam);
    const lens = at(cyl(0.017, 0.017, 0.012, M.glass, 16), 0.112, -0.09, 0.012); lens.rotation.z = Math.PI / 2; g.add(lens);
    const lens2 = at(cyl(0.01, 0.01, 0.012, M.glass, 12), 0.112, -0.09, -0.016); lens2.rotation.z = Math.PI / 2; g.add(lens2);
    for (const s of [-1, 1]) { const leg = box(0.012, 0.1, 0.012, M.dark); leg.position.set(0, -0.08, s * 0.08); leg.rotation.x = s * 0.25; g.add(leg); const skid = at(cyl(0.007, 0.007, 0.24, M.dark, 8), 0, -0.13, s * 0.095); skid.rotation.z = Math.PI / 2; g.add(skid); }
    g.userData.rot = rot;
    return g;
  }

  function aircraft() {
    const g = new THREE.Group(), rot = [];
    const prof = []; for (let i = 0; i <= 24; i++) { const u = i / 24, nose = Math.sin(Math.min(1, u * 5) * Math.PI / 2), tail = u > 0.62 ? 1 - Math.pow((u - 0.62) / 0.38, 1.4) * 0.8 : 1; prof.push(new THREE.Vector2(Math.max(0.003, 0.058 * nose * tail), u)); }
    const fus = new THREE.Mesh(new THREE.LatheGeometry(prof, 24), M.white); fus.rotation.z = Math.PI / 2; fus.position.x = 0.5; g.add(fus);
    const belly = new THREE.Mesh(new THREE.LatheGeometry(prof.map((v) => new THREE.Vector2(v.x * 1.01, v.y)), 24, Math.PI * 0.62, Math.PI * 0.76), phong(0x1f4e8c, { side: THREE.DoubleSide })); belly.rotation.z = Math.PI / 2; belly.position.x = 0.5; g.add(belly);
    const cock = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2.4), M.glass); cock.rotation.z = -Math.PI / 2.6; cock.position.set(0.4, 0.03, 0); cock.scale.set(1.1, 0.6, 0.85); g.add(cock);
    const wing = box(0.18, 0.016, 1.3, M.white); wing.position.set(0.08, 0.055, 0); g.add(wing);
    for (const s of [-1, 1]) {
      const nac = at(cyl(0.032, 0.026, 0.22, M.grey, 14), 0.15, 0.03, s * 0.26); nac.rotation.z = Math.PI / 2; g.add(nac);
      const spin = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.05, 12), M.dark); spin.rotation.z = -Math.PI / 2; spin.position.set(0.285, 0.03, s * 0.26); g.add(spin);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.11, 28), new THREE.MeshBasicMaterial({ color: 0xc0cad4, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false })); disc.rotation.y = Math.PI / 2; disc.position.set(0.27, 0.03, s * 0.26); g.add(disc);
      const bl = box(0.004, 0.2, 0.016, M.black); bl.position.set(0.272, 0.03, s * 0.26); g.add(bl); rot.push(bl);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.01, 8, 6), new THREE.MeshBasicMaterial({ color: s < 0 ? 0xef4444 : 0x22c55e })); tip.position.set(0.08, 0.055, s * 0.65); g.add(tip);
    }
    const fin = new THREE.Mesh(new THREE.ExtrudeGeometry((() => { const s = new THREE.Shape(); s.moveTo(0, 0); s.lineTo(0.14, 0); s.lineTo(0.05, 0.2); s.lineTo(-0.02, 0.2); s.closePath(); return s; })(), { depth: 0.012, bevelEnabled: false }), M.orange); fin.position.set(-0.5, 0.02, -0.006); g.add(fin);
    const tp = box(0.1, 0.01, 0.42, M.white); tp.position.set(-0.48, 0.215, 0); g.add(tp);
    const slar = at(cyl(0.022, 0.022, 0.48, M.grey, 12), 0.02, -0.065, 0); slar.rotation.z = Math.PI / 2; g.add(slar);
    const fl = at(new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 10), M.dark), 0.3, -0.06, 0); g.add(fl);
    g.userData.rot = rot; g.userData.prop = true;
    return g;
  }

  function satellite() {
    const g = new THREE.Group();
    const bus = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.32, 0.3), new THREE.MeshPhongMaterial({ map: foilTex, shininess: 100, specular: 0xffeeaa })); g.add(bus);
    const top = at(box(0.31, 0.02, 0.31, M.white), 0, 0.17, 0); g.add(top);
    const sar = at(box(0.05, 0.11, 1.5, phong(0x2b3440, { shininess: 60 })), 0.19, -0.03, 0); g.add(sar);
    for (let i = 0; i < 12; i++) { const t = at(box(0.052, 0.1, 0.004, M.steel), 0.19, -0.03, -0.7 + i * 0.127); g.add(t); }
    const sp = new THREE.MeshPhongMaterial({ map: solarTex, shininess: 120, specular: 0x6688cc, side: THREE.DoubleSide });
    for (const s of [-1, 1]) {
      const yoke = at(cyl(0.008, 0.008, 0.14, M.steel, 8), -0.05, 0.04, s * 0.22); yoke.rotation.x = Math.PI / 2; g.add(yoke);
      for (let k = 0; k < 3; k++) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.3, 0.3), sp); p.position.set(-0.05, 0.04, s * (0.31 + k * 0.31)); g.add(p); }
    }
    const dish = new THREE.Mesh(new THREE.SphereGeometry(0.07, 18, 10, 0, Math.PI * 2, 0, Math.PI / 3), phong(0xf4f6f8, { side: THREE.DoubleSide })); dish.rotation.z = Math.PI; dish.position.set(-0.08, -0.2, 0); g.add(dish);
    const feed = at(cyl(0.004, 0.004, 0.08, M.steel, 6), -0.08, -0.2, 0); g.add(feed);
    const star = at(cyl(0.03, 0.03, 0.04, M.dark, 12), -0.1, 0.2, 0.08); g.add(star);
    return g;
  }

  const make = { vessel, boom: boomSection, skimmer, storage: barge, drone, aircraft, satellite };

  // hardware viewer: rotating model on a studio floor, used in the Assets view and the sensor card
  function viewer(canvas, opts) {
    opts = opts || {};
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
    scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x2a3038, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 0.9); key.position.set(2.5, 3.5, 2); scene.add(key);
    const fill = new THREE.DirectionalLight(0x9fb8ff, 0.35); fill.position.set(-2.5, 1.2, 1.5); scene.add(fill);
    const rim = new THREE.DirectionalLight(0xb6c94a, 0.45); rim.position.set(-2, 1.5, -3); scene.add(rim);
    if (opts.blueprint) {
      const grid = new THREE.GridHelper(2.4, 24, 0x5f9fd6, 0x2c5f8f); grid.position.y = -0.12; scene.add(grid);
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.0, 1.008, 96).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xbfe3ff })); ring.position.y = -0.118; scene.add(ring);
    } else if (!opts.space) {
      const floor = new THREE.Mesh(new THREE.CircleGeometry(1.05, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x10151b })); floor.position.y = -0.12; scene.add(floor);
      const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.55, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false })); shadow.position.y = -0.116; scene.add(shadow);
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.0, 1.012, 96).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xb6c94a, transparent: true, opacity: 0.6 })); ring.position.y = -0.118; scene.add(ring);
      const grid = new THREE.PolarGridHelper(1.0, 12, 4, 64, 0x2c3540, 0x222a33); grid.position.y = -0.117; scene.add(grid);
    } else {
      const stars = new THREE.BufferGeometry(), sp = []; for (let i = 0; i < 300; i++) { const a = Math.random() * 6.28, b = Math.acos(2 * Math.random() - 1), d = 8; sp.push(d * Math.sin(b) * Math.cos(a), d * Math.cos(b), d * Math.sin(b) * Math.sin(a)); }
      stars.setAttribute("position", new THREE.Float32BufferAttribute(sp, 3)); scene.add(new THREE.Points(stars, new THREE.PointsMaterial({ color: 0xffffff, size: 0.03 })));
      const earth = new THREE.Mesh(new THREE.SphereGeometry(3, 48, 32), new THREE.MeshPhongMaterial({ color: 0x1d4f7a, emissive: 0x06121e, shininess: 30 })); earth.position.set(0, -3.6, -1.5); scene.add(earth);
    }
    let model = null, type = null; const t0 = performance.now();
    function size() { const w = canvas.clientWidth || 300, h = canvas.clientHeight || 200; if (canvas.width !== Math.round(w * r.getPixelRatio())) { r.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); } }
    function show(t) {
      if (model) scene.remove(model);
      type = t; model = (make[t] || make.vessel)();
      if (model.userData.wake) model.userData.wake.visible = false;
      if (opts.blueprint) {
        const edges = [];
        model.traverse((m) => { if (m.isMesh) { edges.push(m); m.material = new THREE.MeshBasicMaterial({ color: 0x103a66, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }); } });
        edges.forEach((m) => { const l = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 28), new THREE.LineBasicMaterial({ color: 0xbfe3ff })); m.add(l); });
      }
      model.scale.setScalar(t === "satellite" ? 0.85 : t === "aircraft" ? 1.0 : t === "boom" ? 1.0 : t === "skimmer" ? 1.5 : t === "drone" ? 1.8 : 1.35);
      scene.add(model);
    }
    function frame() {
      if (!canvas.isConnected) { r.dispose(); r.forceContextLoss(); return; }   // viewer removed with its panel: free the GL context
      size();
      const t = (performance.now() - t0) / 1000;
      if (model) {
        model.rotation.y = t * 0.45;
        if (model.userData.rot) model.userData.rot.forEach((b, i) => (model.userData.prop ? (b.rotation.x = t * 30 + i) : (b.rotation.y = t * 30 + i)));
        if (model.userData.radar) model.userData.radar.rotation.y = t * 3;
        if (opts.space) { model.rotation.x = 0.3; model.position.y = Math.sin(t * 0.8) * 0.03; }
        if (type === "drone") model.position.y = 0.15 + Math.sin(t * 2) * 0.02;
      }
      cam.position.set(Math.cos(0.65) * 2.25, opts.space ? 0.7 : 0.72, Math.sin(0.65) * 2.25); cam.lookAt(0, 0.04, 0);
      r.render(scene, cam);
      requestAnimationFrame(frame);
    }
    frame();
    return { show };
  }
  return { make, viewer };
})();
