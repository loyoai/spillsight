/* 3D operations map: terrain, water, sites, lanes, slick, drift particles, risk zones, booms and moving assets.
 * Three.js r149, WebGL1-safe (no derivatives, no instancing). World units are km (Geo.toWorld). */
const Map3D = (() => {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
  const lerp = (a, b, k) => a + (b - a) * k;
  const hash = (i) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  const OIL_Y = 0.06, FOG = new THREE.Color("#0c1012");

  let renderer, scene, camera, el, overlay, svg, raf;
  const cam = { tx: 0, tz: 0, dist: 160, az: -0.6, el: 0.95 }, fly = { on: false };
  const markers = [];
  let water = null, slickMesh = null, slickLine = null, imgPlane = null, farSea = null, tmat = null, texSat = null, texDark = null, basemap = "dark";
  const groups = {};
  let onPick = null, frameHooks = [];

  function init(container) {
    el = container;
    const canvas = document.createElement("canvas"); canvas.className = "map-canvas"; el.appendChild(canvas);
    overlay = document.createElement("div"); overlay.className = "map-overlay"; el.appendChild(overlay);
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.classList.add("map-svg"); overlay.appendChild(svg);
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    scene = new THREE.Scene(); scene.background = FOG; scene.fog = new THREE.Fog(FOG, 260, 620);
    camera = new THREE.PerspectiveCamera(38, 1, 0.05, 2000);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 0.85));
    const sun = new THREE.DirectionalLight(0xfff1dd, 0.6); sun.position.set(-80, 120, -60); scene.add(sun);
    const far = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x0d1417 }));
    far.position.y = -0.08; scene.add(far); farSea = far;
    ["sites", "lanes", "risk", "oil", "tracks", "booms", "assets"].forEach((k) => { groups[k] = new THREE.Group(); scene.add(groups[k]); });
    controls(canvas);
    window.addEventListener("resize", resize); resize();
    loop();
  }
  function resize() { const w = el.clientWidth, h = el.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }

  // ------------------------------------------------------------------ terrain
  function loadImage(src) { return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; }); }
  async function loadTerrain() {
    const R = Geo.R;
    let sat, hm, sm;
    try { [sat, hm, sm] = await Promise.all([loadImage("assets/tex/sat.jpg"), loadImage("assets/tex/height.png"), loadImage("assets/tex/seamask.png")]); }
    catch (e) {
      const g = new THREE.Mesh(new THREE.PlaneGeometry(R.W, R.H).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x3a3428 }));
      scene.add(g); return false;
    }
    const c = document.createElement("canvas"); c.width = hm.width; c.height = hm.height;
    const g2 = c.getContext("2d", { willReadFrequently: true }); g2.drawImage(hm, 0, 0);
    const hw = hm.width, hh = hm.height, hd = g2.getImageData(0, 0, hw, hh).data;
    g2.clearRect(0, 0, hw, hh); g2.drawImage(sm, 0, 0, hw, hh); const md = g2.getImageData(0, 0, hw, hh).data;
    const hmax = (R.hmax_m || 1800) / 1000, ex = R.exag || 3;
    const sampleH = (x, z) => {
      const u = clamp(x / R.W + 0.5, 0, 1) * (hw - 1), v = clamp(z / R.H + 0.5, 0, 1) * (hh - 1);
      const x0 = Math.floor(u), y0 = Math.floor(v), x1 = Math.min(x0 + 1, hw - 1), y1 = Math.min(y0 + 1, hh - 1), fx = u - x0, fy = v - y0;
      const at = (xx, yy) => hd[(yy * hw + xx) * 4];
      const val = lerp(lerp(at(x0, y0), at(x1, y0), fx), lerp(at(x0, y1), at(x1, y1), fx), fy);
      const sea = md[(Math.round(v) * hw + Math.round(u)) * 4] > 127;
      if (sea && val < 4) return -0.05;
      return val <= 0.5 ? 0.03 : ((val - 1) / 254) * hmax * ex + 0.03;
    };
    const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    texSat = new THREE.Texture(sat); texSat.needsUpdate = true; texSat.anisotropy = aniso;
    // dark operations basemap: desaturated, dimmed copy of the satellite mosaic
    const dc = document.createElement("canvas"); dc.width = sat.width; dc.height = sat.height;
    const dctx = dc.getContext("2d"); dctx.filter = "grayscale(0.9) brightness(0.42) contrast(1.25)"; dctx.drawImage(sat, 0, 0);
    texDark = new THREE.CanvasTexture(dc); texDark.anisotropy = aniso;
    tmat = new THREE.MeshBasicMaterial({ map: texDark, color: 0xffffff });
    const TX = 4, TZ = 2, SX = 150, SZ = 120;
    for (let iz = 0; iz < TZ; iz++) for (let ix = 0; ix < TX; ix++) {
      const geo = new THREE.PlaneGeometry(R.W / TX, R.H / TZ, SX, SZ); geo.rotateX(-Math.PI / 2);
      const cx = -R.W / 2 + (ix + 0.5) * R.W / TX, cz = -R.H / 2 + (iz + 0.5) * R.H / TZ;
      const pos = geo.attributes.position, uv = geo.attributes.uv;
      for (let i = 0; i < pos.count; i++) {
        const xw = pos.getX(i) + cx, zw = pos.getZ(i) + cz;
        pos.setXYZ(i, xw, sampleH(xw, zw), zw);
        uv.setXY(i, (ix + uv.getX(i)) / TX, (TZ - 1 - iz + uv.getY(i)) / TZ);
      }
      geo.computeBoundingSphere();
      scene.add(new THREE.Mesh(geo, tmat));
    }
    const mask = new THREE.Texture(sm); mask.needsUpdate = true;
    water = new THREE.Mesh(new THREE.PlaneGeometry(R.W, R.H).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uMask: { value: mask }, uTime: { value: 0 }, uDeep: { value: new THREE.Color("#0b1519") }, uShallow: { value: new THREE.Color("#122228") }, uFog: { value: FOG }, uNear: { value: 260 }, uFar: { value: 620 } },
      vertexShader: "varying vec2 vUv; varying vec3 vW; varying float vD; void main(){ vUv=uv; vec4 wp=modelMatrix*vec4(position,1.0); vW=wp.xyz; vec4 mv=viewMatrix*wp; vD=-mv.z; gl_Position=projectionMatrix*mv; }",
      fragmentShader: "uniform sampler2D uMask; uniform float uTime; uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uFog; uniform float uNear; uniform float uFar; varying vec2 vUv; varying vec3 vW; varying float vD;" +
        "float wv(vec2 p){ return (sin(dot(p,vec2(0.8,0.6))*1.6+uTime*0.7)+sin(dot(p,vec2(-0.5,0.85))*2.3-uTime*0.5)+0.6*sin(dot(p,vec2(0.95,-0.3))*3.7+uTime*0.9))/2.6; }" +
        "void main(){ float m=texture2D(uMask,vUv).r; if(m<0.03) discard; float w=wv(vW.xz*0.35)+0.5*wv(vW.xz*1.1+3.1);" +
        " vec3 c=mix(uDeep,uShallow,0.5+0.12*w); c+=pow(max(0.0,w*0.55),8.0)*0.1; c=mix(c,uFog,smoothstep(uNear,uFar,vD)); gl_FragColor=vec4(c,0.88*m); }",
    }));
    water.renderOrder = 1; scene.add(water);
    setBasemap(basemap);
    return true;
  }

  function setBasemap(b) {
    basemap = b; if (!tmat) return;
    tmat.map = b === "dark" ? texDark : texSat; tmat.color.set(b === "dark" ? 0xffffff : 0xd0d4d8); tmat.needsUpdate = true;
    water.material.uniforms.uDeep.value.set(b === "dark" ? "#0b1519" : "#0d3247"); water.material.uniforms.uShallow.value.set(b === "dark" ? "#122228" : "#17506a");
    farSea.material.color.set(b === "dark" ? 0x0d1417 : 0x0c2433);
  }
  // ------------------------------------------------------------------ controls + camera
  function controls(canvas) {
    let drag = null;
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, b: e.button === 2 || e.shiftKey ? "pan" : "rot", moved: 0 }; canvas.setPointerCapture(e.pointerId); fly.on = false; });
    canvas.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY; drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.b === "rot") { cam.az -= dx * 0.005; cam.el = clamp(cam.el + dy * 0.004, 0.25, 1.45); }
      else { const k = cam.dist * 0.0016, ca = Math.cos(cam.az), sa = Math.sin(cam.az); cam.tx += (-dx * ca - dy * sa) * k; cam.tz += (dx * sa - dy * ca) * k; }
    });
    canvas.addEventListener("pointerup", (e) => {
      if (drag && drag.moved < 4 && onPick) { const ll = pick(e); if (ll) onPick(ll, e, drag.b === "pan"); }
      drag = null;
    });
    canvas.addEventListener("wheel", (e) => { e.preventDefault(); fly.on = false; cam.dist = clamp(cam.dist * Math.exp(e.deltaY * 0.0012), 3, 420); }, { passive: false });
  }
  function pick(e) {
    const r = renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster(); ray.setFromCamera(v, camera);
    const p = new THREE.Vector3(); if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p)) return null;
    return Geo.toLonLat(p.x, p.z);
  }
  function flyTo(ll, dist, opt) {
    opt = opt || {};
    const [x, z] = Geo.toWorld(ll[0], ll[1]);
    Object.assign(fly, { on: true, t0: performance.now(), dur: (opt.dur || 1.6) * 1000, from: { ...cam }, to: { tx: x, tz: z, dist: dist || cam.dist, az: opt.az != null ? opt.az : cam.az, el: opt.el != null ? opt.el : cam.el } });
  }
  function applyCam() {
    if (fly.on) {
      const k = smooth((performance.now() - fly.t0) / fly.dur);
      for (const key of ["tx", "tz", "dist", "az", "el"]) cam[key] = lerp(fly.from[key], fly.to[key], k);
      if (k >= 1) fly.on = false;
    }
    const ce = Math.cos(cam.el), se = Math.sin(cam.el);
    camera.position.set(cam.tx + Math.sin(cam.az) * ce * cam.dist, se * cam.dist, cam.tz + Math.cos(cam.az) * ce * cam.dist);
    camera.lookAt(cam.tx, 0, cam.tz); camera.updateMatrixWorld();
  }

  // ------------------------------------------------------------------ DOM markers
  const vtmp = new THREE.Vector3();
  function scr(x, y, z) { vtmp.set(x, y, z).project(camera); return [(vtmp.x + 1) * el.clientWidth / 2, (1 - vtmp.y) * el.clientHeight / 2, vtmp.z]; }
  function marker(opts) {
    const m = document.createElement("div"); m.className = "mk mk-" + (opts.kind || "site") + (opts.cls ? " " + opts.cls : "");
    m.innerHTML = `<span class="mk-ic"><i data-lucide="${opts.icon || "map-pin"}"></i></span><span class="mk-lb"><b>${opts.label || ""}</b>${opts.sub ? `<small>${opts.sub}</small>` : ""}</span>`;
    overlay.appendChild(m);
    const o = { el: m, ll: opts.lonlat, y: opts.y || 0.1, get: opts.get, group: opts.group || "sites", data: opts.data, visible: true };
    if (opts.onClick) m.addEventListener("click", (e) => { e.stopPropagation(); opts.onClick(o); });
    markers.push(o);
    if (window.lucide) lucide.createIcons({ nodes: [m] });
    return o;
  }
  function clearMarkers(group) { for (let i = markers.length - 1; i >= 0; i--) if (markers[i].group === group) { markers[i].el.remove(); markers.splice(i, 1); } }
  function setGroupVisible(name, on) { if (groups[name]) groups[name].visible = on; markers.forEach((m) => { if (m.group === name) m.visible = on; }); if (name === "oil" && slickMesh) { slickMesh.visible = on; slickLine.visible = on; } }
  function updateMarkers() {
    const W = el.clientWidth, H = el.clientHeight;
    for (const m of markers) {
      let x, z, y = m.y;
      if (m.get) { const p = m.get(); if (!p) { m.el.style.display = "none"; continue; } x = p.x; z = p.z; y = p.y + 0.05; }
      else [x, z] = Geo.toWorld(m.ll[0], m.ll[1]);
      const s = scr(x, y, z);
      const vis = m.visible && s[2] < 1 && s[0] > -60 && s[0] < W + 60 && s[1] > -40 && s[1] < H + 40;
      m.el.style.display = vis ? "" : "none";
      if (vis) m.el.style.transform = `translate(${s[0].toFixed(1)}px,${s[1].toFixed(1)}px)`;
    }
  }

  // ------------------------------------------------------------------ sites, lanes, risk zones
  const SITE_ICON = { port: "anchor", intake: "droplets", mangrove: "trees", coral: "fish", coast: "waves", town: "home" };
  function setSites(sites, onClick) {
    clearMarkers("sites"); groups.lanes.clear();
    for (const s of sites) {
      if (s.kind === "lane") {
        const pts = s.path.map((ll) => { const [x, z] = Geo.toWorld(ll[0], ll[1]); return new THREE.Vector3(x, 0.05, z); });
        const g = new THREE.BufferGeometry().setFromPoints(pts);
        const line = new THREE.Line(g, new THREE.LineDashedMaterial({ color: 0x8abbff, dashSize: 1.6, gapSize: 1.0, transparent: true, opacity: 0.55 }));
        line.computeLineDistances(); groups.lanes.add(line);
        continue;
      }
      marker({ kind: "site", cls: "k-" + s.kind, icon: SITE_ICON[s.kind] || "map-pin", label: s.name, sub: `${s.kind} · ${s.country}`, lonlat: s.lonlat, group: "sites", data: s, onClick });
    }
  }
  const risk = [];
  function setRisk(list) {
    groups.risk.clear(); risk.length = 0;
    for (const r of list) {
      const [x, z] = Geo.toWorld(r.lonlat[0], r.lonlat[1]);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(r.radius || 4, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.18, depthWrite: false }));
      const ring = new THREE.Mesh(new THREE.RingGeometry((r.radius || 4) * 0.96, r.radius || 4, 96).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.85, depthWrite: false }));
      disc.position.set(x, 0.07, z); ring.position.set(x, 0.075, z); disc.renderOrder = ring.renderOrder = 5;
      groups.risk.add(disc); groups.risk.add(ring); risk.push({ disc, ring, eta: r.eta_h });
    }
  }

  // landfall zone: where forecast particles come ashore (replaces wide risk circles)
  let landPts = null;
  function setLanding(lls) {
    if (landPts) { groups.risk.remove(landPts); landPts = null; }
    if (!lls || !lls.length) return;
    const g = new THREE.BufferGeometry().setFromPoints(lls.map((ll) => { const [x, z] = Geo.toWorld(ll[0], ll[1]); return new THREE.Vector3(x, 0.12, z); }));
    landPts = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xff4d4f, size: 6, sizeAttenuation: false, transparent: true, opacity: 0.9, depthWrite: false }));
    landPts.renderOrder = 7; groups.risk.add(landPts);
  }
  const previews = [];
  function setPreview(list) {
    previews.forEach((o) => groups.booms.remove(o)); previews.length = 0;
    for (const p of list || []) {
      const o = (HW.make[p.type] || HW.make.vessel)();
      o.traverse((m) => { if (m.material) { m.material = m.material.clone(); m.material.transparent = true; m.material.opacity = 0.8; } });
      if (o.userData.wake) o.userData.wake.visible = false;
      const [x, z] = Geo.toWorld(p.lonlat[0], p.lonlat[1]); o.position.set(x, OIL_Y + 0.01, z); o.rotation.y = -(p.heading || 0); o.scale.setScalar(p.scale || 0.28);
      groups.booms.add(o); previews.push(o);
    }
  }
  // ------------------------------------------------------------------ detection overlay (image draped on its footprint) + slick polygon
  function setImageOverlay(url, footprint, opacity) {
    if (imgPlane) { scene.remove(imgPlane); imgPlane = null; }
    if (!url) return;
    const pts = footprint.map((ll) => Geo.toWorld(ll[0], ll[1]));
    const g = new THREE.BufferGeometry();
    const y = 0.065;
    g.setAttribute("position", new THREE.Float32BufferAttribute([pts[0][0], y, pts[0][1], pts[1][0], y, pts[1][1], pts[2][0], y, pts[2][1], pts[3][0], y, pts[3][1]], 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
    g.setIndex([0, 3, 1, 1, 3, 2]);
    const t = new THREE.TextureLoader().load(url);
    imgPlane = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: t, transparent: true, opacity: opacity == null ? 0.85 : opacity, depthWrite: false, side: THREE.DoubleSide }));
    imgPlane.renderOrder = 3; scene.add(imgPlane);
  }
  function fadeImage(op) { if (imgPlane) imgPlane.material.opacity = op; }
  function setSlick(poly) {
    for (const m of [slickMesh, slickLine]) if (m) scene.remove(m);
    slickMesh = slickLine = null;
    if (!poly || poly.length < 3) return;
    const w = poly.map((ll) => Geo.toWorld(ll[0], ll[1]));
    const shape = new THREE.Shape(w.map((p) => new THREE.Vector2(p[0], -p[1])));
    const g = new THREE.ShapeGeometry(shape); g.rotateX(-Math.PI / 2);
    slickMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x0a0806, transparent: true, opacity: 0.82, depthWrite: false, side: THREE.DoubleSide }));
    slickMesh.position.y = OIL_Y + 0.004; slickMesh.renderOrder = 4; scene.add(slickMesh);
    const lg = new THREE.BufferGeometry().setFromPoints(w.concat([w[0]]).map((p) => new THREE.Vector3(p[0], OIL_Y + 0.01, p[1])));
    slickLine = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0xe5484d })); slickLine.renderOrder = 6; scene.add(slickLine);
  }
  function slickOpacity(k) { if (slickMesh) { slickMesh.material.opacity = 0.82 * k; slickLine.material.opacity = k; slickLine.material.transparent = true; } }

  // ------------------------------------------------------------------ drift particles as oil patches + trajectory lines
  let oil = null, fc = null;
  function setForecast(f) {
    fc = f; groups.oil.clear(); groups.tracks.clear(); oil = null;
    if (!f) return;
    const N = f.tracks.length, K = 4, B = N * K;
    const W = f.tracks.map((tr) => tr.map((ll) => Geo.toWorld(ll[0], ll[1])));
    const pos = new Float32Array(B * 12), corner = new Float32Array(B * 8), seed = new Float32Array(B * 4), alpha = new Float32Array(B * 4), idx = new Uint16Array(B * 6);
    for (let j = 0; j < B; j++) { corner.set([-1, -1, 1, -1, 1, 1, -1, 1], j * 8); const s = hash(j + 0.5); seed.set([s, s, s, s], j * 4); const v = j * 4; idx.set([v, v + 1, v + 2, v, v + 2, v + 3], j * 6); }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aCorner", new THREE.BufferAttribute(corner, 2)); g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    g.setAttribute("aAlpha", new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage)); g.setIndex(new THREE.BufferAttribute(idx, 1));
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uCore: { value: new THREE.Color(0x070504) }, uEdge: { value: new THREE.Color(0x2e241b) } },
      vertexShader: "attribute vec2 aCorner; attribute float aSeed; attribute float aAlpha; varying vec2 vC; varying float vS; varying float vA; void main(){ vC=aCorner; vS=aSeed; vA=aAlpha; gl_Position=projectionMatrix*viewMatrix*vec4(position,1.0); }",
      fragmentShader: "uniform vec3 uCore; uniform vec3 uEdge; varying vec2 vC; varying float vS; varying float vA;" +
        "void main(){ float r=length(vC); float an=atan(vC.y,vC.x); float rr=r*(1.0+0.12*sin(an*5.0+vS*6.283)+0.07*sin(an*9.0+vS*12.0));" +
        " float a=(1.0-smoothstep(0.62,0.98,rr))*vA; if(a<0.004) discard; vec3 c=mix(uCore,uEdge,smoothstep(0.35,0.95,rr));" +
        " float rim=smoothstep(0.72,0.95,rr)*(1.0-smoothstep(0.95,1.02,rr)); vec3 ir=0.5+0.5*cos(6.283*(vec3(0.0,0.33,0.67)+rr*2.5+vS)); c=mix(c,ir*0.6,rim*0.16); gl_FragColor=vec4(c,a); }",
    });
    const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false; mesh.renderOrder = 4; groups.oil.add(mesh);
    const st = []; for (let j = 0; j < B; j++) st.push({ k: Math.floor(j / K), r: j % K === 0 ? 0 : 0.05 + 0.18 * hash(j * 3.1), a0: 6.283 * hash(j * 7.7), s0: 0.09 + 0.12 * hash(j * 5.3), al: 0.55 + 0.35 * hash(j * 9.1) });
    oil = { g, pos, alpha, st, W, B };
    // trajectory lines for every 6th particle (Maven-style tracks)
    for (let k = 0; k < N; k += 6) {
      const tr = W[k], end = f.beach_h[k] == null ? tr.length - 1 : Math.min(tr.length - 1, f.beach_h[k]);
      const lg = new THREE.BufferGeometry().setFromPoints(tr.slice(0, end + 1).map((p) => new THREE.Vector3(p[0], OIL_Y + 0.02, p[1])));
      const line = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0xe8e8e8, transparent: true, opacity: 0.22 }));
      line.userData.end = end; groups.tracks.add(line);
    }
  }
  function setHour(h, t) {
    if (!oil) return;
    const { pos, alpha, st, W, B } = oil, a = Math.floor(h), f = h - a, H = W[0].length - 1;
    for (let j = 0; j < B; j++) {
      const q = st[j], tr = W[q.k], i0 = Math.min(a, H), i1 = Math.min(a + 1, H);
      let x = lerp(tr[i0][0], tr[i1][0], f), z = lerp(tr[i0][1], tr[i1][1], f);
      const bh = fc.beach_h[q.k], bf = bh == null ? 0 : smooth((h - bh + 1) / 2);
      const pa = tr[Math.max(0, i0 - 1)], pb = tr[Math.min(H, i0 + 2)];
      let dx = pb[0] - pa[0], dz = pb[1] - pa[1]; const sp = Math.hypot(dx, dz) || 1; dx /= sp; dz /= sp;
      const spread = 1 + Math.min(h, 48) / 30, ang = q.a0 + 0.15 * (t || 0) * (hash(j) - 0.5);
      x += Math.cos(ang) * q.r * spread * (1 - 0.6 * bf); z += Math.sin(ang) * q.r * spread * (1 - 0.6 * bf);
      const size = q.s0 * (1 + Math.min(h, 40) / 30) * (1 - 0.3 * bf), el = 1 + Math.min(h, 30) / 15;
      const ux = dx * size * el, uz = dz * size * el, vx = -dz * size, vz = dx * size, o = j * 12, y = OIL_Y + q.s0 * 0.002;
      pos[o] = x - ux - vx; pos[o + 1] = y; pos[o + 2] = z - uz - vz; pos[o + 3] = x + ux - vx; pos[o + 4] = y; pos[o + 5] = z + uz - vz;
      pos[o + 6] = x + ux + vx; pos[o + 7] = y; pos[o + 8] = z + uz + vz; pos[o + 9] = x - ux + vx; pos[o + 10] = y; pos[o + 11] = z - uz + vz;
      const al = q.al * (1 - 0.4 * (1 - Math.exp(-h / 10)));
      alpha[j * 4] = alpha[j * 4 + 1] = alpha[j * 4 + 2] = alpha[j * 4 + 3] = al;
    }
    oil.g.attributes.position.needsUpdate = true; oil.g.attributes.aAlpha.needsUpdate = true;
    groups.tracks.children.forEach((l) => l.geometry.setDrawRange(0, Math.min(l.userData.end, Math.ceil(h)) + 1));
  }
  function centroidAt(h) {
    if (!fc) return null; let x = 0, y = 0; const a = Math.floor(h), f = h - a;
    for (const tr of fc.tracks) { const p0 = tr[Math.min(a, tr.length - 1)], p1 = tr[Math.min(a + 1, tr.length - 1)]; x += lerp(p0[0], p1[0], f); y += lerp(p0[1], p1[1], f); }
    return [x / fc.tracks.length, y / fc.tracks.length];
  }

  // ------------------------------------------------------------------ booms and assets
  function setBooms(lines) {
    groups.booms.clear(); previews.length = 0;
    for (const b of lines) {
      const pts = b.map((ll) => { const [x, z] = Geo.toWorld(ll[0], ll[1]); return new THREE.Vector3(x, OIL_Y + 0.03, z); });
      if (pts.length < 2) continue;
      const curve = new THREE.CatmullRomCurve3(pts);
      const g = new THREE.TubeGeometry(curve, Math.max(24, pts.length * 4), 0.06, 6, false);
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0xfacc15, emissive: 0x4a3600 }));
      m.userData.n = g.index.count; m.geometry.setDrawRange(0, 0); groups.booms.add(m);
    }
  }
  function boomOpacity(op) { groups.booms.children.forEach((m) => { m.material.transparent = op < 1; m.material.opacity = op; m.material.needsUpdate = true; }); }
  function boomProgress(k) { groups.booms.children.forEach((m, i) => m.geometry.setDrawRange(0, Math.floor((m.userData.n * smooth(k * 1.2 - i * 0.08)) / 6) * 6)); }
  const assets = [];
  function setAssets(list) {
    assets.forEach((a) => groups.assets.remove(a.obj)); assets.length = 0; clearMarkers("assets");
    for (const r of list) {
      const obj = (HW.make[r.type] || HW.make.vessel)();
      groups.assets.add(obj);
      const a = { r, obj, path: null, t0: 0, dur: 1, hover: r.type === "drone" || r.type === "aircraft" };
      const [x, z] = Geo.toWorld(r.lonlat[0], r.lonlat[1]); obj.position.set(x, a.hover ? 1.2 : OIL_Y, z);
      assets.push(a);
    }
    return assets;
  }
  function mission(id, toLL, t0, dur) {
    const a = assets.find((q) => q.r.id === id); if (!a) return;
    const [x0, z0] = [a.obj.position.x, a.obj.position.z], [x1, z1] = Geo.toWorld(toLL[0], toLL[1]);
    const mx = (x0 + x1) / 2 + (z1 - z0) * 0.12, mz = (z0 + z1) / 2 - (x1 - x0) * 0.12;
    a.path = [[x0, z0], [mx, mz], [x1, z1]]; a.t0 = t0; a.dur = dur;
    if (!a.line) {
      a.line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.8, gapSize: 0.5, transparent: true, opacity: 0.75 }));
      groups.assets.add(a.line);
    }
    const pts = []; for (let i = 0; i <= 40; i++) { const k = i / 40, u = 1 - k; pts.push(new THREE.Vector3(u * u * x0 + 2 * u * k * mx + k * k * x1, OIL_Y + 0.02, u * u * z0 + 2 * u * k * mz + k * k * z1)); }
    a.line.geometry.setFromPoints(pts); a.line.computeLineDistances();
  }
  function updateAssets(clock, t) {
    const s = clamp(cam.dist * 0.011, 0.26, 3.2);
    for (const a of assets) {
      a.obj.scale.setScalar(s * (a.r.type === "aircraft" ? 1.6 : 1));
      if (a.obj.userData.rot) a.obj.userData.rot.forEach((b, i) => (b.rotation.y = t * 40 + i));
      let moving = 0;
      if (a.path) {
        const k = smooth((clock - a.t0) / a.dur), u = 1 - k, P = a.path;
        const x = u * u * P[0][0] + 2 * u * k * P[1][0] + k * k * P[2][0], z = u * u * P[0][1] + 2 * u * k * P[1][1] + k * k * P[2][1];
        const k2 = Math.min(1, k + 0.01), u2 = 1 - k2;
        const x2 = u2 * u2 * P[0][0] + 2 * u2 * k2 * P[1][0] + k2 * k2 * P[2][0], z2 = u2 * u2 * P[0][1] + 2 * u2 * k2 * P[1][1] + k2 * k2 * P[2][1];
        if (Math.hypot(x2 - x, z2 - z) > 1e-5) a.obj.rotation.y = -Math.atan2(z2 - z, x2 - x);
        a.obj.position.x = x; a.obj.position.z = z; moving = k > 0.01 && k < 0.99 ? 1 : 0;
      }
      if (a.hover) { a.obj.position.y = 1.2 + Math.sin(t * 2 + a.r.id.length) * 0.06; if (a.r.type === "aircraft" && !a.path) { a.obj.rotation.y = t * 0.15; } }
      if (a.obj.userData.wake) a.obj.userData.wake.material.opacity = 0.4 * moving;
    }
  }
  const assetPos = (id) => { const a = assets.find((q) => q.r.id === id); return a ? a.obj.position : null; };

  // ------------------------------------------------------------------ loop
  let simClock = 0;
  function loop() {
    raf = requestAnimationFrame(loop);
    const t = performance.now() / 1000;
    applyCam();
    if (water) water.material.uniforms.uTime.value = t;
    risk.forEach((r, i) => { const p = 0.5 + 0.5 * Math.sin(t * 3 + i); r.ring.material.opacity = 0.5 + 0.45 * p; r.disc.material.opacity = 0.1 + 0.12 * p; });
    frameHooks.forEach((f) => f(t));
    updateAssets(simClock, t);
    renderer.render(scene, camera);
    updateMarkers();
  }
  return {
    init, loadTerrain, setBasemap, getBasemap: () => basemap, flyTo, setSites, setRisk, setImageOverlay, fadeImage, setSlick, slickOpacity, setForecast, setHour, centroidAt,
    setBooms, boomProgress, boomOpacity, setLanding, setPreview, setAssets, mission, assetPos, marker, clearMarkers, setGroupVisible,
    onPick: (f) => (onPick = f), onFrame: (f) => frameHooks.push(f), setClock: (c) => (simClock = c), cam, canvas: () => renderer.domElement,
  };
})();
