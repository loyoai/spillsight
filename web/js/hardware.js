/* Low-poly response hardware for the map and the hardware viewer (Three.js r149, WebGL1-safe). */
const HW = (() => {
  const lam = (c, e) => new THREE.MeshLambertMaterial(Object.assign({ color: c }, e || {}));
  const box = (w, h, d, c) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), lam(c));
  const cyl = (r1, r2, h, c, s) => new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, h, s || 16), lam(c));

  function hull(len, beam, h, color) {
    const s = new THREE.Shape(), L = len / 2, B = beam / 2;
    s.moveTo(L, 0); s.quadraticCurveTo(L * 0.7, B, L * 0.35, B); s.lineTo(-L, B); s.lineTo(-L, -B); s.lineTo(L * 0.35, -B); s.quadraticCurveTo(L * 0.7, -B, L, 0);
    const g = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false }); g.rotateX(-Math.PI / 2);
    return new THREE.Mesh(g, lam(color));
  }
  function wake(len) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([-0.4, 0.004, 0.12, -0.4, 0.004, -0.12, -len, 0.004, 0.6, -len, 0.004, -0.6], 3));
    g.setIndex([0, 2, 1, 1, 2, 3]);
    return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }));
  }
  function vessel(color) {
    const g = new THREE.Group();
    g.add(hull(1.0, 0.28, 0.1, color || 0xf97316));
    const deck = box(0.7, 0.012, 0.24, 0xd9dde3); deck.position.set(-0.08, 0.105, 0); g.add(deck);
    const house = box(0.26, 0.11, 0.2, 0xf8fafc); house.position.set(0.12, 0.165, 0); g.add(house);
    const bridge = box(0.15, 0.07, 0.18, 0xffffff); bridge.position.set(0.14, 0.255, 0); g.add(bridge);
    const glass = box(0.006, 0.03, 0.16, 0x0f172a); glass.position.set(0.218, 0.26, 0); g.add(glass);
    const mast = cyl(0.008, 0.008, 0.2, 0xcbd5e1); mast.position.set(0.1, 0.38, 0); g.add(mast);
    const reel = cyl(0.07, 0.07, 0.2, 0xfacc15); reel.rotation.x = Math.PI / 2; reel.position.set(-0.3, 0.18, 0); g.add(reel);
    const crane = box(0.28, 0.02, 0.02, 0xfacc15); crane.position.set(-0.12, 0.26, 0.08); crane.rotation.z = 0.45; g.add(crane);
    const w = wake(1.6); g.add(w); g.userData.wake = w;
    return g;
  }
  function skimmer() {
    const g = new THREE.Group();
    const base = box(0.5, 0.06, 0.5, 0x1f2937); base.position.y = 0.03; g.add(base);
    for (const sx of [-1, 1]) { const f = cyl(0.07, 0.07, 0.5, 0xf97316); f.rotation.x = Math.PI / 2; f.position.set(sx * 0.22, 0.05, 0); g.add(f); }
    const drum = cyl(0.13, 0.13, 0.3, 0xfacc15, 24); drum.rotation.x = Math.PI / 2; drum.position.set(0, 0.16, 0); g.add(drum);
    const hose = cyl(0.025, 0.025, 0.5, 0x111827); hose.rotation.z = Math.PI / 2; hose.position.set(-0.4, 0.12, 0); g.add(hose);
    return g;
  }
  function boomSection(n) {
    const g = new THREE.Group();
    for (let i = 0; i < (n || 9); i++) {
      const f = cyl(0.06, 0.06, 0.16, 0xfacc15, 14); f.rotation.z = Math.PI / 2; f.position.set(i * 0.17 - 0.68, 0.05, 0); g.add(f);
      const sk = box(0.16, 0.12, 0.01, 0xb45309); sk.position.set(i * 0.17 - 0.68, -0.04, 0); g.add(sk);
    }
    return g;
  }
  function barge() {
    const g = new THREE.Group();
    g.add(hull(1.3, 0.34, 0.08, 0x334155));
    for (let i = 0; i < 4; i++) { const t = cyl(0.1, 0.1, 0.14, 0xe2e8f0); t.position.set(-0.4 + i * 0.25, 0.15, 0); g.add(t); }
    const w = wake(1.2); g.add(w); g.userData.wake = w;
    return g;
  }
  function drone() {
    const g = new THREE.Group(), rot = [];
    g.add(box(0.24, 0.06, 0.18, 0xf1f5f9));
    const cam = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 10), lam(0x111827)); cam.position.set(0.08, -0.06, 0); g.add(cam);
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + (k * Math.PI) / 2;
      const arm = box(0.32, 0.02, 0.03, 0x94a3b8); arm.position.set(Math.cos(a) * 0.16, 0, Math.sin(a) * 0.16); arm.rotation.y = -a; g.add(arm);
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.004, 24), new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.25 }));
      disc.position.set(Math.cos(a) * 0.3, 0.04, Math.sin(a) * 0.3); g.add(disc);
      const b = box(0.2, 0.004, 0.018, 0x0f172a); b.position.copy(disc.position); b.position.y += 0.004; g.add(b); rot.push(b);
    }
    g.userData.rot = rot;
    return g;
  }
  function aircraft() {
    const g = new THREE.Group();
    const f = cyl(0.06, 0.04, 1.0, 0xf8fafc, 14); f.rotation.z = Math.PI / 2; g.add(f);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.06, 14, 10), lam(0xf8fafc)); nose.position.x = 0.5; g.add(nose);
    const wing = box(0.22, 0.015, 1.2, 0xe2e8f0); wing.position.set(0.05, 0.02, 0); g.add(wing);
    const tail = box(0.12, 0.012, 0.4, 0xe2e8f0); tail.position.set(-0.45, 0.03, 0); g.add(tail);
    const fin = box(0.14, 0.16, 0.012, 0xf97316); fin.position.set(-0.46, 0.1, 0); g.add(fin);
    const pod = cyl(0.025, 0.025, 0.5, 0x334155, 10); pod.rotation.z = Math.PI / 2; pod.position.set(0.05, -0.07, 0); g.add(pod);
    for (const s of [-1, 1]) { const e = cyl(0.035, 0.035, 0.14, 0x64748b); e.rotation.z = Math.PI / 2; e.position.set(0.12, 0.0, s * 0.3); g.add(e); }
    return g;
  }
  function satellite() {
    const g = new THREE.Group();
    g.add(box(0.3, 0.3, 0.4, 0xd4af37));
    for (const s of [-1, 1]) { const p = box(0.02, 0.28, 0.9, 0x1e3a8a); p.position.set(0, 0, s * 0.68); g.add(p); }
    const sar = box(0.04, 0.12, 1.1, 0x94a3b8); sar.position.set(0.2, -0.18, 0); g.add(sar);
    const dish = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.06, 16), lam(0xf8fafc)); dish.position.set(-0.2, 0.2, 0); g.add(dish);
    return g;
  }
  const make = { vessel: () => vessel(), boom: () => boomSection(), skimmer, storage: barge, drone, aircraft, satellite };

  // Hardware viewer: one rotating model with a ring floor, used in the Resources view and the sensor card.
  function viewer(canvas, opts) {
    opts = opts || {};
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(32, 1, 0.01, 50);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 0.8); sun.position.set(2, 3, 2); scene.add(sun);
    const rim = new THREE.DirectionalLight(0xf97316, 0.35); rim.position.set(-3, 1, -2); scene.add(rim);
    const floor = new THREE.Mesh(new THREE.RingGeometry(0.9, 0.92, 96).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xf97316, transparent: true, opacity: 0.55 }));
    const grid = new THREE.GridHelper(2.4, 16, 0x334155, 0x1e293b); grid.position.y = -0.002;
    if (!opts.space) { scene.add(floor); scene.add(grid); }
    let model = null, t0 = performance.now();
    function size() { const w = canvas.clientWidth || 300, h = canvas.clientHeight || 200; r.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); }
    function show(type) {
      if (model) scene.remove(model);
      model = (make[type] || make.vessel)();
      if (model.userData.wake) model.userData.wake.visible = false;
      model.scale.setScalar(type === "aircraft" || type === "satellite" ? 1.1 : type === "boom" ? 1.0 : 1.4);
      scene.add(model);
    }
    function frame() {
      size();
      const t = (performance.now() - t0) / 1000;
      if (model) {
        model.rotation.y = t * 0.5;
        if (model.userData.rot) model.userData.rot.forEach((b, i) => (b.rotation.y = t * 30 + i));
        if (opts.space) { model.rotation.x = 0.35; model.position.y = Math.sin(t * 0.8) * 0.03; }
      }
      cam.position.set(Math.cos(0.6) * 2.4, opts.space ? 0.6 : 1.1, Math.sin(0.6) * 2.4); cam.lookAt(0, 0.1, 0);
      r.render(scene, cam);
      requestAnimationFrame(frame);
    }
    frame();
    return { show };
  }
  return { make, viewer, vessel };
})();
