// ---------- EARTH GLOBE: data with a real coordinate system sits on the Earth; local grids stay in black space ----------
const GLB = { on: true, mode: 'always', R: 6371008, scene: null, cam: null, mesh: null, key: '', alpha: 0, tex: null };
try { const v = localStorage.getItem('sb-globe'); if (v === '0') GLB.on = false; if (v === 'zoom') GLB.mode = 'zoom'; } catch (e) { }   // the Earth: always in the background (default), only when zoomed out, or off
function globeGeo() {   // where is the local origin on the Earth? null for local grids or no coordinate system
  if (!S.crs || !S.origin) return null; const C = X_.byId(S.crs); if (!C || C.type === 'local') return null;
  try { const o = S.origin; const g = C.type === 'geo' ? [o[0], o[1]] : X_.convertPoint(o[0], o[1], o[2], S.crs, C.datum); if (!isFinite(g[0]) || !isFinite(g[1]) || Math.abs(g[1]) > 90) return null; return { lon: g[0], lat: g[1] }; } catch (e) { return null; }
}
function earthTexture() {
  if (GLB.tex) return GLB.tex; const W_ = 4096, H_ = 2048, cv = document.createElement('canvas'); cv.width = W_; cv.height = H_; const g = cv.getContext('2d');
  const sea = g.createLinearGradient(0, 0, 0, H_); sea.addColorStop(0, '#0d2a45'); sea.addColorStop(0.5, '#0f3a5e'); sea.addColorStop(1, '#0d2a45'); g.fillStyle = sea; g.fillRect(0, 0, W_, H_);
  const T = window.WORLD_TOPO; const X = lon => (lon + 180) / 360 * W_, Y = lat => (90 - lat) / 180 * H_;
  if (T) {
    const sc = T.transform.scale, tr = T.transform.translate; const arcs = T.arcs.map(a => { let x = 0, y = 0; return a.map(([dx, dy]) => { x += dx; y += dy; return [x * sc[0] + tr[0], y * sc[1] + tr[1]]; }); });
    const ring = idx => { const out = []; for (const i of idx) { const a = i >= 0 ? arcs[i] : arcs[~i].slice().reverse(); for (let k = out.length ? 1 : 0; k < a.length; k++) out.push(a[k]); } return out; };
    const polys = []; const walk = o => { if (o.type === 'GeometryCollection') o.geometries.forEach(walk); else if (o.type === 'Polygon') polys.push(o.arcs.map(ring)); else if (o.type === 'MultiPolygon') for (const p of o.arcs) polys.push(p.map(ring)); }; walk(T.objects.land);
    const land = g.createLinearGradient(0, 0, 0, H_); [[0, '#e8eef0'], [0.1, '#8a9a86'], [0.2, '#4f6b47'], [0.32, '#6f7a4a'], [0.4, '#b09a66'], [0.47, '#4f7a40'], [0.53, '#4a7a3c'], [0.62, '#b89a62'], [0.72, '#7a8450'], [0.8, '#6d8a5a'], [0.86, '#dfe7ea'], [1, '#f2f6f8']].forEach(([t, c]) => land.addColorStop(t, c));
    g.fillStyle = land; g.beginPath(); for (const p of polys) for (const r of p) { r.forEach(([lo, la], k) => k ? g.lineTo(X(lo), Y(la)) : g.moveTo(X(lo), Y(la))); g.closePath(); } g.fill('evenodd');
    g.strokeStyle = 'rgba(230,240,235,0.55)'; g.lineWidth = 1.2; g.stroke(); g.fillStyle = '#eef3f6'; g.fillRect(0, Y(-84.5), W_, H_ - Y(-84.5));   // the Antarctic polygon wraps the pole; fill the cap
  }
  g.strokeStyle = 'rgba(255,255,255,0.10)'; g.lineWidth = 1; g.beginPath(); for (let lo = -180; lo <= 180; lo += 10) { g.moveTo(X(lo), 0); g.lineTo(X(lo), H_); } for (let la = -80; la <= 80; la += 10) { g.moveTo(0, Y(la)); g.lineTo(W_, Y(la)); } g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.22)'; g.beginPath(); g.moveTo(0, Y(0)); g.lineTo(W_, Y(0)); g.stroke();
  const t = new THREE.CanvasTexture(cv); t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false; t.anisotropy = 4; GLB.tex = t; return t;
}
function buildGlobe(geo) {
  const R = GLB.R, la = geo.lat * Math.PI / 180, lo = geo.lon * Math.PI / 180;
  const up = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)], east = [-Math.sin(lo), Math.cos(lo), 0], north = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
  // rings of growing angular distance from the site: metre-scale facets under the data, continent-scale far away
  const rings = [0]; let a = 2e-6; while (a < Math.PI) { rings.push(a); a = Math.min(a * 1.45, a + 0.04); } /* capped step keeps the far limb round */ rings.push(Math.PI); const seg = 96; const pos = [], dir = [], idx = []; const z0 = -S.origin[2];
  rings.forEach((an, ri) => { for (let s = 0; s <= seg; s++) { const b = s / seg * 2 * Math.PI, x = R * Math.sin(an) * Math.cos(b), y = R * Math.sin(an) * Math.sin(b), z = R * (Math.cos(an) - 1); pos.push(x, y, z + z0);
    const e = [x, y, z + R]; const d = [0, 1, 2].map(k => east[k] * e[0] + north[k] * e[1] + up[k] * e[2]); const l = Math.hypot(d[0], d[1], d[2]); dir.push(d[0] / l, d[1] / l, d[2] / l); } });
  for (let r = 0; r < rings.length - 1; r++) for (let s = 0; s < seg; s++) { const i0 = r * (seg + 1) + s, i1 = i0 + 1, j0 = i0 + seg + 1, j1 = j0 + 1; idx.push(i0, j0, i1, i1, j0, j1); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('aDir', new THREE.Float32BufferAttribute(dir, 3)); g.setIndex(idx);
  const sun = [0, 1, 2].map(k => up[k] * 0.75 + east[k] * 0.45 + north[k] * 0.3);
  const mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: true, side: THREE.DoubleSide, uniforms: { tMap: { value: earthTexture() }, uAlpha: { value: 1 }, uSun: { value: new THREE.Vector3(...sun).normalize() }, uCentre: { value: new THREE.Vector3(0, 0, z0 - R) } },
    vertexShader: 'attribute vec3 aDir; varying vec3 vDir; varying vec3 vW; void main(){ vDir = aDir; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: 'uniform sampler2D tMap; uniform float uAlpha; uniform vec3 uSun; uniform vec3 uCentre; varying vec3 vDir; varying vec3 vW; void main(){ vec3 d = normalize(vDir); float lon = atan(d.y, d.x), lat = asin(clamp(d.z,-1.0,1.0)); vec2 uv = vec2(lon/6.28318530718+0.5, lat/3.14159265359+0.5); vec3 c = texture2D(tMap, uv).rgb; float l = 0.5 + 0.5*max(dot(d,uSun),0.0); vec3 n = normalize(vW - uCentre); vec3 v = normalize(cameraPosition - vW); float rim = pow(1.0 - max(dot(n,v),0.0), 3.0); c = c*l + vec3(0.25,0.5,0.9)*rim*0.7; gl_FragColor = vec4(c, uAlpha); }' });
  const m = new THREE.Mesh(g, mat); m.frustumCulled = false; const sc = new THREE.Scene(); sc.add(m);
  // stars
  const sp = []; let sd = 99; const rnd = () => { sd = (sd * 1103515245 + 12345) >>> 0; return sd / 4294967296; }; for (let i = 0; i < 2500; i++) { const u = rnd() * 2 - 1, t = rnd() * 2 * Math.PI, r = Math.sqrt(1 - u * u); sp.push(1e8 * r * Math.cos(t), 1e8 * r * Math.sin(t), 1e8 * u + z0 - R); }
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3)); const stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 1.4, sizeAttenuation: false, transparent: true, opacity: 0.8, depthTest: false })); stars.frustumCulled = false; stars.renderOrder = -1; sc.add(stars);
  GLB.scene = sc; GLB.mesh = m; GLB.stars = stars; GLB.cam = new THREE.PerspectiveCamera(); GLB.geo = geo;
}
function globeRender(cam, bg) {
  if (!GLB.on || !cam.isPerspectiveCamera) return false; const geo = globeGeo(); if (!geo) { GLB.alpha = 0; globeBadge(null); return false; }
  const key = S.crs + '|' + S.origin.join(','); if (key !== GLB.key) { GLB.key = key; buildGlobe(geo); }
  const d = S.cam.dist, d0 = Math.max(1500, sceneRadius() * 4), t = Math.max(0, Math.min(1, (d - d0) / (d0 * 3))), a0 = t * t * (3 - 2 * t), a = GLB.mode === 'always' ? 1 : a0; GLB.alpha = a; GLB.zoomA = a0; globeBadge(geo); if (a <= 0) return false;
  const g = GLB.cam; g.fov = cam.fov; g.aspect = cam.aspect; g.position.copy(cam.position); g.quaternion.copy(cam.quaternion); g.near = Math.max(5, d * 0.02); g.far = 4e8; g.updateProjectionMatrix(); g.updateMatrixWorld();
  GLB.mesh.material.uniforms.uAlpha.value = a; GLB.stars.material.opacity = 0.8 * a0; GLB.scene.background = bg.clone().lerp(new THREE.Color(0x000000), a0);   // close up the sky keeps the usual background; space darkens as you pull away
  renderer.render(GLB.scene, g); return true;
}
function globeBadge(geo) {
  let b = $('#globeBadge'); if (!b) { b = el('div', { id: 'globeBadge', style: 'position:absolute;left:12px;bottom:44px;font:11px IBM Plex Mono,monospace;color:#cfe3f5;background:rgba(8,16,28,.6);padding:3px 8px;border-radius:6px;pointer-events:none;display:none' }); vp.append(b); }
  if (!geo || (GLB.zoomA || 0) <= 0) { b.style.display = 'none'; if (GLB.pin) GLB.pin.pos.set(0, 0, 1e15); return; }
  b.style.display = ''; const C = X_.byId(S.crs); b.textContent = 'On the globe at ' + Math.abs(geo.lat).toFixed(4) + '°' + (geo.lat < 0 ? 'S' : 'N') + ' ' + Math.abs(geo.lon).toFixed(4) + '°' + (geo.lon < 0 ? 'W' : 'E') + ' · ' + (C ? C.name : S.crs) + ' · eye ' + (S.cam.dist > 1000 ? (S.cam.dist / 1000).toFixed(S.cam.dist > 1e5 ? 0 : 1) + ' km' : S.cam.dist.toFixed(0) + ' m');
  if (!GLB.pin) GLB.pin = addLabel(new THREE.Vector3(0, 0, 0), '');
  const bx = sceneBox(); if (!bx.isEmpty()) bx.getCenter(GLB.pin.pos); const names = [...S.layers.map(L => L.name), ...(S.streams || []).map(D => D.meta.name)];
  if (S.cam.dist <= Math.max(3000, sceneRadius() * 12)) GLB.pin.pos.set(0, 0, 1e15); GLB.pin.el.innerHTML = '◉ ' + esc(names.length === 1 ? names[0] : names.length + ' layers');
}
function globeFly() {
  if (!globeGeo()) { toast(S.crs ? 'This project uses a local grid, so it has no place on the Earth. Set a map grid (Coords tab) to put it on the globe.' : 'Set the project coordinate system (Coords tab) to place the data on the Earth. Without one it stays in open space.', true); return; }
  if (!GLB.on) { GLB.on = true; try { localStorage.setItem('sb-globe', '1'); } catch (e) { } }
  if (S.cam.ortho) toggleOrtho();
  if (S.cam.dist < 2e5) { GLB.back = camState(); tweenCam({ target: GLB.back.target, dist: 1.6e7, yaw: GLB.back.yaw, pitch: 1.2, ortho: false }, 2600); }
  else if (GLB.back) tweenCam(GLB.back, 2600); else fitAll();
}
$('#btnGlobe').addEventListener('click', globeFly);
const _buildCoordsG = buildCoords;
buildCoords = function () {
  _buildCoordsG(); const p = pane('coords'); if (!p) return; const geo = globeGeo(); const cb = el('select', { id: 'globeOn', 'aria-label': 'Earth in the background', style: 'width:auto' }, ...[['always', 'Always'], ['zoom', 'When zoomed out'], ['off', 'Off']].map(([v, t]) => el('option', { value: v, selected: (GLB.on ? GLB.mode : 'off') === v }, t))); cb.addEventListener('change', () => { GLB.on = cb.value !== 'off'; if (GLB.on) GLB.mode = cb.value; try { localStorage.setItem('sb-globe', GLB.on ? (GLB.mode === 'zoom' ? 'zoom' : '1') : '0'); } catch (e) { } S.dirty = true; });
  p.append(el('div', { class: 'sec' }, el('h3', {}, 'Earth globe'), el('div', { class: 'note' }, geo ? 'This project sits on the Earth at ' + Math.abs(geo.lat).toFixed(5) + '°' + (geo.lat < 0 ? 'S' : 'N') + ', ' + Math.abs(geo.lon).toFixed(5) + '°' + (geo.lon < 0 ? 'W' : 'E') + '. The Earth sits under the data; zoom well out (or press Globe in the toolbar) to see the whole planet.' : S.crs ? 'The project uses a local grid, which has no position on the Earth, so the data stays in open space. Choose a map grid (MGA, PCG…) to place it on the globe.' : 'No coordinate system is set, so the data stays in open space. Set the project coordinate system above to place it on the globe.'),
    el('label', { class: 'row', style: 'gap:6px;font-size:12px' }, 'Earth in the background', cb), el('div', { class: 'row' }, el('button', { class: 'btn small', disabled: !geo, onclick: globeFly }, 'Fly out to the globe / back'))));
};

// ---------- Satellite imagery (online): Esri World Imagery tiles draped under the data near the site, and painted onto the globe ----------
// Tiles load only while the Earth is shown and the browser is online; offline, the drawn globe stays. Nothing is sent but the tile addresses.
const IMG = { on: true, tiles: new Map(), group: null, key: '', loading: 0, frame: 0, camKey: '', globeState: 0, shown: 0, errs: 0,
  url: (z, x, y) => 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/' + z + '/' + y + '/' + x };
try { if (localStorage.getItem('sb-imagery') === '0') IMG.on = false; } catch (e) { }
const imgX2lon = (x, z) => x / 2 ** z * 360 - 180, imgY2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / 2 ** z; return 180 / Math.PI * Math.atan(Math.sinh(n)); };
const imgLon2x = (lon, z) => (lon + 180) / 360 * 2 ** z, imgLat2y = (lat, z) => { const r = Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z; };
function imgClear() { for (const t of IMG.tiles.values()) imgDrop(t); IMG.tiles.clear(); }
function imgDrop(t) { if (t.mesh) { IMG.group.remove(t.mesh); t.mesh.geometry.dispose(); t.mesh.material.dispose(); } if (t.tex) t.tex.dispose(); t.dead = true; }
function imgTileMesh(t) {   // a 8×8 grid in the project grid, so the tile follows the map projection exactly
  const C = X_.byId(S.crs), N = 8, pos = [], uv = [], idx = [], o = S.origin;
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) { const lon = imgX2lon(t.x + i / N, t.z), lat = imgY2lat(t.y + j / N, t.z); const p = X_.convertPoint(lon, lat, 0, C.datum, S.crs); pos.push(p[0] - o[0], p[1] - o[1], 0); uv.push(i / N, 1 - j / N); }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: t.tex, depthTest: false, depthWrite: false, side: THREE.DoubleSide, transparent: true, opacity: 1 })); m.renderOrder = 10 + t.z; m.frustumCulled = false; return m;
}
function imgLoad(t) {
  IMG.loading++; const im = new Image(); im.crossOrigin = 'anonymous';
  im.onload = () => { IMG.loading--; if (t.dead) return; const tx = new THREE.Texture(im); tx.needsUpdate = true; tx.minFilter = THREE.LinearMipmapLinearFilter; tx.anisotropy = 8; t.tex = tx; try { t.mesh = imgTileMesh(t); IMG.group.add(t.mesh); } catch (e) { } t.ok = true; IMG.errs = 0; S.dirty = true; };
  im.onerror = () => { IMG.loading--; t.failed = true; IMG.errs++; };
  im.src = IMG.url(t.z, t.x, t.y);
}
function imgUpdate(cam, geo) {
  if (!IMG.group) { IMG.group = new THREE.Group(); }
  if (IMG.group.parent !== GLB.scene) GLB.scene.add(IMG.group);
  const key = S.crs + '|' + S.origin.join(','); if (key !== IMG.key) { IMG.key = key; imgClear(); IMG.globeState = 0; }
  const C = X_.byId(S.crs); const ok = IMG.on && C && C.type !== 'geo' && C.type !== 'local' && navigator.onLine !== false && IMG.errs < 12;
  const d = S.cam.dist; IMG.group.visible = ok && d < 2.5e5; imgCredit(ok && (IMG.group.visible || IMG.globeState === 2) && [...IMG.tiles.values()].some(t => t.ok) || IMG.globeState === 2);
  if (!ok) return;
  if (d > 4e4 && !IMG.globeState) imgGlobe();
  // the flat imagery sits at the bottom of the data, under the points (it is drawn behind them)
  const bx = sceneBox(); IMG.group.position.z = bx.isEmpty() ? 0 : bx.min.z - 0.05;
  if (!IMG.group.visible) return;
  const ck = [S.cam.target.x.toFixed(1), S.cam.target.y.toFixed(1), d.toFixed(1), S.cam.yaw.toFixed(2), S.cam.pitch.toFixed(2), W(), H()].join(); IMG.frame++;
  if (ck === IMG.camKey && IMG.loading === 0 && !IMG.pending) return; IMG.camKey = ck; IMG.pending = false;
  // where the camera looks, on the Earth
  const tw = [S.cam.target.x + S.origin[0], S.cam.target.y + S.origin[1], S.cam.target.z + S.origin[2]]; let g;
  try { g = X_.convertPoint(tw[0], tw[1], tw[2], S.crs, C.datum); } catch (e) { return; } if (!isFinite(g[0]) || !isFinite(g[1])) return;
  const lat = g[1], cosl = Math.cos(lat * Math.PI / 180), mpp = d * 2 * Math.tan(cam.fov * Math.PI / 360) / Math.max(1, H());   // metres per screen pixel at the target
  const zf = Math.max(3, Math.min(19, Math.round(Math.log2(156543.03 * cosl / Math.max(mpp, 0.05)))));
  // ground the view covers: more towards the horizon when tilted
  const tilt = Math.max(0.25, Math.sin(Math.abs(S.cam.pitch))); const reach = Math.min(3e5, d * Math.tan(cam.fov * Math.PI / 360) * Math.max(1, cam.aspect) * 1.6 / tilt);
  const want = new Set();
  for (const [dz, maxN] of [[0, 4], [2, 3], [4, 3], [6, 2]]) {
    const z = zf - dz; if (z < 2) continue; const tile = 40075016.7 * cosl / 2 ** z, n = Math.min(maxN, Math.ceil(reach / tile)); const cx = Math.floor(imgLon2x(g[0], z)), cy = Math.floor(imgLat2y(lat, z)), M = 2 ** z;
    for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) { const x = ((cx + i) % M + M) % M, y = cy + j; if (y < 0 || y >= M) continue; want.add(z + '/' + x + '/' + y); }
  }
  for (const k of want) { let t = IMG.tiles.get(k); if (!t) { const [z, x, y] = k.split('/').map(Number); t = { z, x, y }; IMG.tiles.set(k, t); } t.used = IMG.frame; }
  // load the coarse ones first (they cover the view quickly), then the fine ones, nearest first
  const queue = [...want].map(k => IMG.tiles.get(k)).filter(t => !t.ok && !t.failed && !t.req).sort((a, b) => a.z - b.z);
  while (IMG.loading < 8 && queue.length) { const t = queue.shift(); t.req = true; imgLoad(t); }
  if (queue.length) IMG.pending = true;
  for (const t of IMG.tiles.values()) if (t.mesh) t.mesh.visible = t.used === IMG.frame;
  if (IMG.tiles.size > 400) { const old = [...IMG.tiles.entries()].filter(([, t]) => t.used !== IMG.frame && (t.ok || t.failed)).sort((a, b) => a[1].used - b[1].used); for (const [k, t] of old.slice(0, IMG.tiles.size - 300)) { imgDrop(t); IMG.tiles.delete(k); } }
}
function imgGlobe() {   // repaint the globe texture from zoom-4 imagery (256 tiles, about 4 MB), once
  IMG.globeState = 1; const tex = earthTexture(), cv = tex.image, g = cv.getContext('2d'), Wc = cv.width, Hc = cv.height, z = 4, M = 16; let left = M * M, got = 0;
  const X = lon => (lon + 180) / 360 * Wc, Y = lat => (90 - lat) / 180 * Hc;
  for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
    const im = new Image(); im.crossOrigin = 'anonymous';
    im.onload = () => { const S_ = 16; for (let s = 0; s < S_; s++) { const la0 = imgY2lat(y + s / S_, z), la1 = imgY2lat(y + (s + 1) / S_, z); g.drawImage(im, 0, s * 256 / S_, 256, 256 / S_, X(imgX2lon(x, z)), Y(la0), X(imgX2lon(x + 1, z)) - X(imgX2lon(x, z)), Y(la1) - Y(la0) + 0.5); } got++; tex.needsUpdate = true; S.dirty = true; if (--left === 0) IMG.globeState = got > 128 ? 2 : 0; };
    im.onerror = () => { if (--left === 0) IMG.globeState = got > 128 ? 2 : 0; };
    im.src = IMG.url(z, x, y);
  }
}
function imgCredit(show) {
  let b = $('#imgCredit'); if (!b) { b = el('div', { id: 'imgCredit', style: 'position:absolute;left:12px;bottom:22px;font:10px IBM Plex Sans,sans-serif;color:#d8e2ea;background:rgba(8,16,28,.55);padding:2px 7px;border-radius:5px;pointer-events:none;display:none' }, 'Imagery: Esri, Maxar, Earthstar Geographics, and the GIS User Community'); vp.append(b); }
  b.style.display = show ? '' : 'none';
}
const _globeRenderI = globeRender;
globeRender = function (cam, bg) {
  if (GLB.on && cam.isPerspectiveCamera) { const geo = globeGeo(); if (geo) { const key = S.crs + '|' + S.origin.join(','); if (key !== GLB.key) { GLB.key = key; buildGlobe(geo); } try { imgUpdate(cam, geo); } catch (e) { console.warn(e); } } }
  else if (IMG.group) { IMG.group.visible = false; imgCredit(false); }
  const r = _globeRenderI(cam, bg); if (!r) imgCredit(false); return r;
};
const _buildCoordsI = buildCoords;
buildCoords = function () {
  _buildCoordsI(); const p = pane('coords'); if (!p) return; const sec = [...p.querySelectorAll('.sec')].find(s => /Earth globe/.test(s.textContent)); if (!sec) return;
  const cb = el('input', { type: 'checkbox', id: 'imgOn', checked: IMG.on }); cb.addEventListener('change', () => { IMG.on = cb.checked; IMG.errs = 0; try { localStorage.setItem('sb-imagery', cb.checked ? '1' : '0'); } catch (e) { } if (!cb.checked && IMG.globeState) { GLB.tex = null; if (GLB.mesh) GLB.mesh.material.uniforms.tMap.value = earthTexture(); IMG.globeState = 0; } IMG.camKey = ''; S.dirty = true; });
  sec.append(el('label', { class: 'row', style: 'gap:6px;font-size:12px' }, cb, 'Satellite imagery under the data (online)'),
    el('div', { class: 'note' }, 'Esri World Imagery, streamed for the area in view (about 0.3–1 m per pixel in most of Australia). It is drawn at the lowest level of the data, behind the points. Needs internet; offline the plain Earth stays. Only map tile addresses are requested, never your data.'));
};
