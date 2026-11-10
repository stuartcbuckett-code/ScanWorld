// ---------- EARTH GLOBE: data with a real coordinate system sits on the Earth; local grids stay in black space ----------
const GLB = { on: true, R: 6371008, scene: null, cam: null, mesh: null, key: '', alpha: 0, tex: null };
try { if (localStorage.getItem('sb-globe') === '0') GLB.on = false; } catch (e) { }
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
    g.strokeStyle = 'rgba(230,240,235,0.55)'; g.lineWidth = 1.2; g.stroke();
  }
  g.strokeStyle = 'rgba(255,255,255,0.10)'; g.lineWidth = 1; g.beginPath(); for (let lo = -180; lo <= 180; lo += 10) { g.moveTo(X(lo), 0); g.lineTo(X(lo), H_); } for (let la = -80; la <= 80; la += 10) { g.moveTo(0, Y(la)); g.lineTo(W_, Y(la)); } g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.22)'; g.beginPath(); g.moveTo(0, Y(0)); g.lineTo(W_, Y(0)); g.stroke();
  const t = new THREE.CanvasTexture(cv); t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false; t.anisotropy = 4; GLB.tex = t; return t;
}
function buildGlobe(geo) {
  const R = GLB.R, la = geo.lat * Math.PI / 180, lo = geo.lon * Math.PI / 180;
  const up = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)], east = [-Math.sin(lo), Math.cos(lo), 0], north = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
  // rings of growing angular distance from the site: metre-scale facets under the data, continent-scale far away
  const rings = [0]; let a = 2e-6; while (a < Math.PI) { rings.push(a); a *= 1.45; } rings.push(Math.PI); const seg = 96; const pos = [], dir = [], idx = []; const z0 = -S.origin[2];
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
  const d = S.cam.dist, d0 = Math.max(1500, sceneRadius() * 4), t = Math.max(0, Math.min(1, (d - d0) / (d0 * 3))), a = t * t * (3 - 2 * t); GLB.alpha = a; globeBadge(geo); if (a <= 0) return false;
  const g = GLB.cam; g.fov = cam.fov; g.aspect = cam.aspect; g.position.copy(cam.position); g.quaternion.copy(cam.quaternion); g.near = Math.max(5, d * 0.02); g.far = 4e8; g.updateProjectionMatrix(); g.updateMatrixWorld();
  GLB.mesh.material.uniforms.uAlpha.value = a; GLB.stars.material.opacity = 0.8 * a; GLB.scene.background = bg.clone().lerp(new THREE.Color(0x000000), a);
  renderer.render(GLB.scene, g); return true;
}
function globeBadge(geo) {
  let b = $('#globeBadge'); if (!b) { b = el('div', { id: 'globeBadge', style: 'position:absolute;left:12px;bottom:44px;font:11px IBM Plex Mono,monospace;color:#cfe3f5;background:rgba(8,16,28,.6);padding:3px 8px;border-radius:6px;pointer-events:none;display:none' }); vp.append(b); }
  if (!geo || GLB.alpha <= 0) { b.style.display = 'none'; if (GLB.pin) GLB.pin.pos.set(0, 0, 1e15); return; }
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
  _buildCoordsG(); const p = pane('coords'); if (!p) return; const geo = globeGeo(); const cb = el('input', { type: 'checkbox', id: 'globeOn' }); cb.checked = GLB.on; cb.addEventListener('change', () => { GLB.on = cb.checked; try { localStorage.setItem('sb-globe', GLB.on ? '1' : '0'); } catch (e) { } S.dirty = true; });
  p.append(el('div', { class: 'sec' }, el('h3', {}, 'Earth globe'), el('div', { class: 'note' }, geo ? 'This project sits on the Earth at ' + Math.abs(geo.lat).toFixed(5) + '°' + (geo.lat < 0 ? 'S' : 'N') + ', ' + Math.abs(geo.lon).toFixed(5) + '°' + (geo.lon < 0 ? 'W' : 'E') + '. Zoom well out from the data (or press Globe in the toolbar) and the Earth fades in under the data.' : S.crs ? 'The project uses a local grid, which has no position on the Earth, so the data stays in open space. Choose a map grid (MGA, PCG…) to place it on the globe.' : 'No coordinate system is set, so the data stays in open space. Set the project coordinate system above to place it on the globe.'),
    el('label', { class: 'row', style: 'gap:6px;font-size:12px' }, cb, 'Show the Earth when zoomed out'), el('div', { class: 'row' }, el('button', { class: 'btn small', disabled: !geo, onclick: globeFly }, 'Fly out to the globe / back'))));
};
