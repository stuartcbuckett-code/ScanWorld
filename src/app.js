// ===== ScanBench app =====
(() => {
'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v); } for (const c of kids.flat()) if (c !== null && c !== undefined) e.append(c.nodeType ? c : document.createTextNode(c)); return e; };
const IO = window.SBIO, AL = window.SBA;
const fmtN = n => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + ' M' : n >= 1e3 ? (n / 1e3).toFixed(1) + ' k' : String(n);
const fm = (v, d = 3) => (v === undefined || v === null || !isFinite(v)) ? '–' : v.toFixed(d);
const mm = v => !isFinite(v) ? '–' : (v * 1000).toFixed(1) + ' mm';
const tick = () => new Promise(r => setTimeout(r, 0));
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// ---------- feedback ----------
function toast(msg, err) { const d = el('div', { class: err ? 'err' : '' }, msg); $('#toast').append(d); setTimeout(() => d.remove(), err ? 9000 : 4500); }
const prog = {
  show(t) { $('#prog').hidden = false; $('#progText').textContent = t; this.set(0); },
  set(f) { const p = Math.round(Math.max(0, Math.min(1, f)) * 100); $('#progBar').style.width = p + '%'; $('#progPct').textContent = p + '%'; },
  hide() { $('#prog').hidden = true; }
};
async function busy(label, fn) {
  prog.show(label); await tick(); await tick();
  try { return await fn(f => prog.set(f)); }
  catch (e) { console.error(e); toast(e.message || String(e), true); return null; }
  finally { prog.hide(); }
}

// ---------- saving files ----------
const ALLOWED = ['png', 'txt', 'json', 'csv', 'zip', 'svg', 'html', 'pdf'];
let dlPromise = null;
try { if (window.claude && window.claude.use) dlPromise = window.claude.use('downloads').catch(() => null); } catch (e) { dlPromise = null; }
async function saveFile(name, data) {
  let blob = data instanceof Blob ? data : new Blob(Array.isArray(data) ? data : [data]);
  const dl = dlPromise ? await dlPromise : null;
  if (dl) {
    const ext = name.split('.').pop().toLowerCase();
    if (!ALLOWED.includes(ext)) {
      const u8 = new Uint8Array(await blob.arrayBuffer());
      blob = IO.makeZip([{ name, data: u8 }]); name = name.replace(/\.[^.]+$/, '') + '.zip';
      toast('Packed ' + ext.toUpperCase() + ' inside ' + name + ' (this viewer only saves common file types).');
    }
    try { await dl.save({ filename: name, data: blob }); toast('Saved ' + name); }
    catch (e) { if (e && e.code !== 'declined') toast('Could not save: ' + (e.message || e.code), true); }
    return;
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ---------- three.js setup ----------
THREE.ColorManagement.enabled = false;
const canvas = $('#gl'), vp = $('#vp'), ov = $('#ov'), octx = ov.getContext('2d');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
const scene = new THREE.Scene();
const persp = new THREE.PerspectiveCamera(50, 1, 0.01, 1e5); persp.up.set(0, 0, 1);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1e6); ortho.up.set(0, 0, 1);
scene.add(new THREE.HemisphereLight(0xffffff, 0x445055, 0.9));
const dirL = new THREE.DirectionalLight(0xffffff, 0.7); dirL.position.set(0.4, -0.6, 1); scene.add(dirL);
const annot = new THREE.Group(); scene.add(annot);
const clipHelper = new THREE.Box3Helper(new THREE.Box3(), 0xff9900); clipHelper.visible = false; scene.add(clipHelper);

const S = {
  layers: [], sel: null, origin: null, mode: null, idc: 1,
  cam: { target: new THREE.Vector3(), dist: 20, yaw: -2.2, pitch: 0.55, ortho: false },
  ptSize: 2, edl: true, clip: { on: false, box: new THREE.Box3() },
  measures: [], lasso: null, pairs: [], undo: null, contours: null, section: null, raster: null, plane: null,
  dirty: true
};
const curCam = () => S.cam.ortho ? ortho : persp;
const W = () => vp.clientWidth, H = () => vp.clientHeight;

// point material
const PT_VS = `
attribute vec3 color; attribute float aHide; uniform float uSize; uniform float uPR; uniform int uClip; uniform vec3 uMin; uniform vec3 uMax;
varying vec3 vC;
void main(){ vec4 wp = modelMatrix * vec4(position,1.0); vC = color;
  if (aHide > 0.5) { gl_Position = vec4(2.0,2.0,2.0,1.0); gl_PointSize = 0.0; return; }
  if (uClip == 1 && (any(lessThan(wp.xyz, uMin)) || any(greaterThan(wp.xyz, uMax)))) { gl_Position = vec4(2.0,2.0,2.0,1.0); gl_PointSize = 0.0; return; }
  gl_Position = projectionMatrix * viewMatrix * wp; gl_PointSize = uSize * uPR; }`;
const PT_FS = `varying vec3 vC; void main(){ vec2 c = gl_PointCoord - 0.5; if (dot(c,c) > 0.25) discard; gl_FragColor = vec4(vC,1.0); }`;
const ptUniforms = { uSize: { value: 2 }, uPR: { value: renderer.getPixelRatio() }, uClip: { value: 0 }, uMin: { value: new THREE.Vector3() }, uMax: { value: new THREE.Vector3() } };
const makePtMat = () => new THREE.ShaderMaterial({ vertexShader: PT_VS, fragmentShader: PT_FS, uniforms: ptUniforms });

// EDL post-process
let rt = null;
const edlMat = new THREE.ShaderMaterial({
  uniforms: { tColor: { value: null }, tDepth: { value: null }, uRes: { value: new THREE.Vector2() }, uNear: { value: 0.1 }, uFar: { value: 100 }, uOrtho: { value: 0 }, uStrength: { value: 0.6 }, uRadius: { value: 1.4 }, uScale: { value: 1 }, uBg: { value: new THREE.Color() } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `uniform sampler2D tColor; uniform sampler2D tDepth; uniform vec2 uRes; uniform float uNear; uniform float uFar; uniform int uOrtho; uniform float uStrength; uniform float uRadius; uniform float uScale; uniform vec3 uBg; varying vec2 vUv;
  float lin(float d){ return uOrtho == 1 ? uNear + d * (uFar - uNear) : (uNear * uFar) / (uFar - d * (uFar - uNear)); }
  void main(){ float d = texture2D(tDepth, vUv).r; vec4 c = texture2D(tColor, vUv);
    if (d >= 1.0) { gl_FragColor = vec4(c.rgb, 1.0); return; }
    float ld = log2(max(lin(d), 1e-6)); float sum = 0.0;
    for (int i = 0; i < 8; i++) { float a = float(i) * 0.785398; vec2 o = vec2(cos(a), sin(a)) * uRadius / uRes;
      float dn = texture2D(tDepth, vUv + o).r; if (dn < 1.0) sum += max(0.0, ld - log2(max(lin(dn), 1e-6))); }
    float shade = exp(-sum * 300.0 * uStrength * 0.125 * uScale);
    gl_FragColor = vec4(c.rgb * shade, 1.0); }`,
  depthTest: false, depthWrite: false
});
const edlScene = new THREE.Scene(); const edlCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
edlScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), edlMat));
function ensureRT() {
  const w = Math.max(1, Math.floor(W() * renderer.getPixelRatio())), h = Math.max(1, Math.floor(H() * renderer.getPixelRatio()));
  if (rt && rt.width === w && rt.height === h) return;
  if (rt) rt.dispose();
  rt = new THREE.WebGLRenderTarget(w, h, { depthTexture: new THREE.DepthTexture(w, h, THREE.UnsignedIntType), minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  edlMat.uniforms.uRes.value.set(w, h);
}

function bgColor() { return new THREE.Color(cssVar('--vp') || '#0a0e11'); }
function resize() {
  renderer.setSize(W(), H(), false);
  const pr = renderer.getPixelRatio(); ov.width = W() * pr; ov.height = H() * pr;
  ptUniforms.uPR.value = pr; updateCamera(); S.dirty = true;
}
new ResizeObserver(resize).observe(vp);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { S.dirty = true; });
new MutationObserver(() => { S.dirty = true; }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// ---------- camera control ----------
function sceneRadius() { const b = sceneBox(); if (b.isEmpty()) return 10; return b.getSize(new THREE.Vector3()).length() / 2 || 1; }
function sceneBox(onlyVisible = true) { const b = new THREE.Box3(); for (const L of S.layers) if (!onlyVisible || L.visible) b.union(L.box); return b; }
function camDir() { const c = S.cam; return new THREE.Vector3(Math.cos(c.pitch) * Math.cos(c.yaw), Math.cos(c.pitch) * Math.sin(c.yaw), Math.sin(c.pitch)); }
function updateCamera() {
  const c = S.cam, dir = camDir(), R = sceneRadius(), asp = W() / Math.max(1, H());
  persp.aspect = asp; persp.position.copy(c.target).addScaledVector(dir, c.dist);
  persp.up.set(0, 0, 1);
  if (Math.abs(c.pitch) > 1.5) persp.up.set(-Math.cos(c.yaw) * Math.sign(c.pitch), -Math.sin(c.yaw) * Math.sign(c.pitch), 0);
  persp.lookAt(c.target);
  persp.near = Math.max(c.dist / 2000, 1e-4); persp.far = c.dist * 4 + R * 6;
  persp.updateProjectionMatrix();
  const hh = c.dist * Math.tan(persp.fov * Math.PI / 360);
  ortho.left = -hh * asp; ortho.right = hh * asp; ortho.top = hh; ortho.bottom = -hh;
  const back = R * 3 + c.dist;
  ortho.position.copy(c.target).addScaledVector(dir, back); ortho.up.copy(persp.up); ortho.lookAt(c.target);
  ortho.near = 0; ortho.far = back + R * 3; ortho.updateProjectionMatrix();
  S.dirty = true;
}
function setView(v) {
  const c = S.cam; const P = { top: [-Math.PI / 2, Math.PI / 2 - 1e-4], front: [-Math.PI / 2, 0], back: [Math.PI / 2, 0], left: [Math.PI, 0], right: [0, 0], iso: [-Math.PI * 0.75 + 0.2, 0.6] }[v];
  if (!P) return; c.yaw = P[0]; c.pitch = P[1]; fitAll(false);
}
function fitBox(b) {
  if (b.isEmpty()) return;
  const ctr = b.getCenter(new THREE.Vector3()), r = b.getSize(new THREE.Vector3()).length() / 2 || 1;
  S.cam.target.copy(ctr); S.cam.dist = r / Math.tan(persp.fov * Math.PI / 360) * 1.05 / Math.min(1, W() / Math.max(1, H())); updateCamera();
}
function fitAll() { fitBox(sceneBox()); }

// pointer interaction
const ptrs = new Map(); let drag = null;
function ndcOf(x, y) { const r = vp.getBoundingClientRect(); return new THREE.Vector2((x - r.left) / r.width * 2 - 1, -((y - r.top) / r.height) * 2 + 1); }
function worldAtTargetPlane(cx, cy) {
  const cam = curCam(); const n = ndcOf(cx, cy);
  const ray = new THREE.Raycaster(); ray.setFromCamera(n, cam);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir(), S.cam.target);
  const p = new THREE.Vector3(); return ray.ray.intersectPlane(plane, p) ? p : S.cam.target.clone();
}
vp.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 1) drag = { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, btn: e.button, shift: e.shiftKey || e.ctrlKey, moved: false, t: performance.now() };
  else drag = { pinch: true, d: pinchDist(), mid: pinchMid(), moved: true };
  if (S.mode && S.mode.type === 'lasso' && e.button === 0 && ptrs.size === 1 && S.mode.freehand) { S.mode.pts = [[e.clientX, e.clientY]]; S.mode.start = [e.clientX, e.clientY]; S.mode.drawing = true; }
});
function pinchDist() { const a = [...ptrs.values()]; return Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y); }
function pinchMid() { const a = [...ptrs.values()]; return { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2 }; }
canvas.addEventListener('pointermove', e => {
  if (!ptrs.has(e.pointerId)) { hover(e); return; }
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!drag) return;
  if (drag.pinch && ptrs.size >= 2) {
    const d = pinchDist(), m = pinchMid();
    const f = drag.d / Math.max(d, 1); zoomAt(m.x, m.y, f);
    panBy(m.x - drag.mid.x, m.y - drag.mid.y); drag.d = d; drag.mid = m; return;
  }
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
  if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 4) drag.moved = true;
  if (S.mode && S.mode.drawing) { if (S.mode.rect) { const [a, b] = S.mode.start, c = e.clientX, d = e.clientY; S.mode.pts = [[a, b], [c, b], [c, d], [a, d]]; } else S.mode.pts.push([e.clientX, e.clientY]); drawOverlay(); return; }
  if (!drag.moved) return;
  if (drag.btn === 2 || drag.btn === 1 || drag.shift) panBy(dx, dy);
  else { S.cam.yaw -= dx * 0.006; S.cam.pitch = Math.max(-Math.PI / 2 + 1e-4, Math.min(Math.PI / 2 - 1e-4, S.cam.pitch + dy * 0.006)); updateCamera(); }
});
canvas.addEventListener('pointerup', e => {
  ptrs.delete(e.pointerId);
  const d = drag; if (ptrs.size === 0) drag = null;
  if (!d || d.pinch) return;
  if (S.mode && S.mode.drawing) { S.mode.drawing = false; finishMode(); return; }
  if (!d.moved && d.btn === 0) onClick(e);
});
canvas.addEventListener('dblclick', e => {
  if (S.mode && S.mode.dblFinish) { finishMode(); return; }
  const p = pick(e.clientX, e.clientY);
  if (p) { const camPos = curCam() === persp ? persp.position.clone() : persp.position.clone(); S.cam.target.copy(p.p); const v = camPos.sub(p.p); S.cam.dist = Math.max(v.length(), 1e-3); S.cam.yaw = Math.atan2(v.y, v.x); S.cam.pitch = Math.asin(Math.max(-1, Math.min(1, v.z / S.cam.dist))); updateCamera(); flashPivot(p.p); toast('Rotation centre set'); }
});
canvas.addEventListener('wheel', e => { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015))); }, { passive: false });
function zoomAt(cx, cy, f) {
  const P = worldAtTargetPlane(cx, cy);
  S.cam.dist = Math.max(1e-3, S.cam.dist * f);
  S.cam.target.sub(P).multiplyScalar(f).add(P);
  updateCamera();
}
function panBy(dx, dy) {
  const wpp = 2 * S.cam.dist * Math.tan(persp.fov * Math.PI / 360) / Math.max(1, H());
  const cam = persp; const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
  S.cam.target.addScaledVector(right, -dx * wpp).addScaledVector(up, dy * wpp); updateCamera();
}
let pivotMark = null;
function flashPivot(p) {
  if (!pivotMark) { pivotMark = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3)), new THREE.PointsMaterial({ color: 0xff9900, size: 10, sizeAttenuation: false, depthTest: false })); pivotMark.renderOrder = 10; scene.add(pivotMark); }
  pivotMark.position.copy(p); pivotMark.visible = true; S.dirty = true; clearTimeout(flashPivot.t); flashPivot.t = setTimeout(() => { pivotMark.visible = false; S.dirty = true; }, 1200);
}
window.addEventListener('keydown', e => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.key === 'Escape') cancelMode();
  else if (e.key === 'Enter' && S.mode) finishMode();
  else if (e.key === 't' || e.key === 'T') setView('top');
  else if (e.key === 'i' || e.key === 'I') setView('iso');
  else if (e.key === 'f' || e.key === 'F') fitAll();
  else if (e.key === 'o' || e.key === 'O') toggleOrtho();
  else if (e.key === 'Backspace' && S.mode && S.mode.pts && S.mode.pts.length) { S.mode.pts.pop(); refreshModeGraphics(); }
});

// ---------- picking ----------
const _m = new THREE.Matrix4();
function pick(cx, cy, radiusPx = 9) {
  const cam = curCam(); cam.updateMatrixWorld(); _m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  const e = _m.elements, r = vp.getBoundingClientRect();
  const sx = (cx - r.left), sy = (cy - r.top), w = r.width, h = r.height, r2 = radiusPx * radiusPx;
  let best = null, bestZ = Infinity;
  const clip = S.clip.on, cmn = S.clip.box.min, cmx = S.clip.box.max;
  for (const L of [...S.layers, ...pickSets()]) {
    if (!L.visible || L.kind !== 'cloud') continue;
    const P = L.pos, n = L.n;
    for (let i = 0; i < n; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      const cw = e[3] * x + e[7] * y + e[11] * z + e[15]; if (cw <= 0) continue;
      const px = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / cw * 0.5 + 0.5) * w - sx;
      if (px > radiusPx || px < -radiusPx) continue;
      const py = (0.5 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw * 0.5) * h - sy;
      if (py > radiusPx || py < -radiusPx || px * px + py * py > r2) continue;
      const cz = (e[2] * x + e[6] * y + e[10] * z + e[14]) / cw; if (cz < -1 || cz > 1) continue;
      if (clip && (x < cmn.x || y < cmn.y || z < cmn.z || x > cmx.x || y > cmx.y || z > cmx.z)) continue;
      if (L.hide && L.hide[i]) continue;
      if (cz < bestZ) { bestZ = cz; best = { layer: L, i, p: new THREE.Vector3(x, y, z) }; }
    }
  }
  const meshes = S.layers.filter(L => L.visible && L.kind === 'mesh').map(L => L.obj);
  if (meshes.length) {
    const rc = new THREE.Raycaster(); rc.setFromCamera(ndcOf(cx, cy), cam);
    const hit = rc.intersectObjects(meshes, false)[0];
    if (hit) { const z = hit.point.clone().project(cam).z; if (z < bestZ) best = { layer: S.layers.find(L => L.obj === hit.object), p: hit.point.clone(), mesh: true }; }
  }
  return best;
}
const W3 = p => [p.x + S.origin[0], p.y + S.origin[1], p.z + S.origin[2]];
const fmtW = p => { const w = W3(p); let s = 'E ' + w[0].toFixed(3) + '  N ' + w[1].toFixed(3) + '  Z ' + w[2].toFixed(3); try { if (S.crs && window.SBX.byId(S.crs).type !== 'geo') { const g = window.SBX.convertPoint(w[0], w[1], w[2], S.crs, window.SBX.byId(S.crs).datum); s += '  (' + g[1].toFixed(7) + ', ' + g[0].toFixed(7) + ')'; } } catch (e) { } return s; };
let hoverT = 0;
function hover(e) { /* lightweight: only update lasso rubber band */ if (S.mode && S.mode.type === 'lasso' && S.mode.pts.length && !S.mode.drawing) { S.mode.cursor = [e.clientX, e.clientY]; drawOverlay(); } }
function onClick(e) {
  if (S.mode) {
    if (S.mode.type === 'lasso') { S.mode.pts.push([e.clientX, e.clientY]); drawOverlay(); return; }
    const p = pick(e.clientX, e.clientY);
    if (!p) { toast('No point under the cursor. Click closer to the cloud.'); return; }
    S.mode.onPick(p); return;
  }
  const p = pick(e.clientX, e.clientY);
  if (p) { $('#stPick').innerHTML = '<b>' + fmtW(p.p) + '</b> · ' + esc(p.layer.name) + pointExtra(p); flashPivot(p.p); }
}
function pointExtra(p) {
  const L = p.layer; if (p.mesh) return ' (mesh)'; const i = p.i; let s = '';
  if (L.intensity) s += ' · I ' + L.intensity[i].toFixed(3);
  if (L.rgb) s += ' · RGB ' + L.rgb[i * 3] + ',' + L.rgb[i * 3 + 1] + ',' + L.rgb[i * 3 + 2];
  if (L.cls) s += ' · class ' + L.cls[i];
  if (L.sf && L.sfs[L.sf]) s += ' · ' + esc(L.sf) + ' ' + fm(L.sfs[L.sf][i], 4);
  return s;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- colour ----------
const RAMPS = {
  bgr: [[0, [38, 70, 200]], [0.25, [40, 170, 230]], [0.5, [60, 200, 90]], [0.75, [245, 210, 50]], [1, [215, 45, 35]]],
  viridis: [[0, [68, 1, 84]], [0.25, [59, 82, 139]], [0.5, [33, 145, 140]], [0.75, [94, 201, 98]], [1, [253, 231, 37]]],
  grey: [[0, [30, 30, 30]], [1, [240, 240, 240]]],
  diverging: [[0, [40, 80, 190]], [0.5, [235, 235, 235]], [1, [200, 40, 40]]]
};
function rampAt(t, ramp, out, o) {
  const R = RAMPS[ramp] || RAMPS.bgr; if (!(t >= 0)) t = 0; if (t > 1) t = 1;
  let k = 1; while (k < R.length - 1 && R[k][0] < t) k++;
  const a = R[k - 1], b = R[k], f = (t - a[0]) / ((b[0] - a[0]) || 1);
  out[o] = a[1][0] + (b[1][0] - a[1][0]) * f; out[o + 1] = a[1][1] + (b[1][1] - a[1][1]) * f; out[o + 2] = a[1][2] + (b[1][2] - a[1][2]) * f;
}
function rampCss(ramp) { if (ramp === 'tol') return 'linear-gradient(90deg,#2846be 0 33%,#3cc85a 33% 67%,#d72d23 67%)'; return 'linear-gradient(90deg,' + (RAMPS[ramp] || RAMPS.bgr).map(s => 'rgb(' + s[1].join(',') + ') ' + (s[0] * 100) + '%').join(',') + ')'; }
const CLASS_COL = { 0: [150, 150, 150], 1: [170, 170, 170], 2: [166, 120, 70], 3: [140, 200, 110], 4: [80, 170, 70], 5: [30, 120, 40], 6: [220, 90, 60], 7: [230, 40, 200], 8: [255, 200, 0], 9: [60, 120, 230], 10: [120, 120, 220], 11: [90, 90, 90], 13: [255, 150, 0], 14: [255, 230, 0], 15: [190, 110, 255], 16: [255, 120, 0], 17: [200, 200, 80], 18: [230, 40, 200] };
const CLASS_NAME = { 0: 'Never classified', 1: 'Unclassified', 2: 'Ground', 3: 'Low vegetation', 4: 'Medium vegetation', 5: 'High vegetation', 6: 'Building', 7: 'Low noise', 9: 'Water', 13: 'Wire guard', 14: 'Wire conductor', 15: 'Transmission tower / pole', 16: 'Wire connector', 17: 'Bridge deck', 18: 'High noise' };
function percentiles(arr, n, ps) {
  const m = Math.min(n, 200000), step = n / m, s = new Float32Array(m); let k = 0;
  for (let j = 0; j < m; j++) { const v = arr[Math.floor(j * step)]; if (isFinite(v)) s[k++] = v; }
  const t = s.subarray(0, k).sort(); return ps.map(p => k ? t[Math.min(k - 1, Math.floor(p * (k - 1)))] : 0);
}
function colorize(L) {
  if (L.kind !== 'cloud') return;
  const n = L.n, c = L.col, mode = L.colorMode;
  if (mode === 'rgb' && L.rgb) c.set(L.rgb.subarray(0, n * 3));
  else if (mode === 'intensity' && L.intensity) {
    if (!L.iRange) L.iRange = percentiles(L.intensity, n, [0.01, 0.99]);
    const [a, b] = L.iRange, s = 255 / ((b - a) || 1);
    for (let i = 0; i < n; i++) { const v = Math.max(0, Math.min(255, (L.intensity[i] - a) * s)); c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = v; }
  } else if (mode === 'elevation') {
    if (!L.zRange) { const z = new Float32Array(n); for (let i = 0; i < n; i++) z[i] = L.pos[i * 3 + 2]; L.zRange = percentiles(z, n, [0.01, 0.99]); }
    const [a, b] = L.zRange, tmp = [0, 0, 0];
    for (let i = 0; i < n; i++) { rampAt((L.pos[i * 3 + 2] - a) / ((b - a) || 1), 'bgr', tmp, 0); c[i * 3] = tmp[0]; c[i * 3 + 1] = tmp[1]; c[i * 3 + 2] = tmp[2]; }
  } else if (mode === 'class' && L.cls) {
    for (let i = 0; i < n; i++) { const q = CLASS_COL[L.cls[i]] || [200, 200, 200]; c[i * 3] = q[0]; c[i * 3 + 1] = q[1]; c[i * 3 + 2] = q[2]; }
  } else if (mode === 'sf' && L.sf && L.sfs[L.sf]) {
    const v = L.sfs[L.sf], st = L.sfStyle[L.sf], tmp = [0, 0, 0], lo = st.lo, hi = st.hi;
    for (let i = 0; i < n; i++) {
      const x = v[i];
      if (!isFinite(x)) { c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = 110; continue; }
      if (st.ramp === 'tol') { const q = x < -st.tol ? [40, 70, 190] : x > st.tol ? [215, 45, 35] : [60, 200, 90]; c[i * 3] = q[0]; c[i * 3 + 1] = q[1]; c[i * 3 + 2] = q[2]; continue; }
      rampAt((x - lo) / ((hi - lo) || 1), st.ramp, tmp, 0); c[i * 3] = tmp[0]; c[i * 3 + 1] = tmp[1]; c[i * 3 + 2] = tmp[2];
    }
  } else {
    const q = new THREE.Color(L.solid); for (let i = 0; i < n; i++) { c[i * 3] = q.r * 255; c[i * 3 + 1] = q.g * 255; c[i * 3 + 2] = q.b * 255; }
  }
  L.geom.attributes.color.needsUpdate = true; S.dirty = true;
}
function applyClassHide(L) { if (!L.cls || !L.hide) return; const h = L.hiddenCls || new Set(); for (let i = 0; i < L.n; i++) L.hide[i] = h.has(L.cls[i]) ? 1 : 0; L.geom.attributes.aHide.needsUpdate = true; S.dirty = true; }
function addSF(L, name, arr, signed) {
  L.sfs[name] = arr;
  const st = AL.stats(arr, L.n);
  let lo, hi;
  if (signed) { const p = percentiles(arr, L.n, [0.02, 0.98]); const m = Math.max(Math.abs(p[0]), Math.abs(p[1])) || 0.01; lo = -m; hi = m; }
  else { const p = percentiles(arr, L.n, [0.0, 0.98]); lo = Math.min(0, p[0]); hi = p[1] || 0.01; }
  L.sfStyle[name] = { lo, hi, ramp: signed ? 'bgr' : 'bgr', tol: L.sfStyle[name] ? L.sfStyle[name].tol : 0.01, signed, stats: st };
  L.sf = name; L.colorMode = 'sf'; colorize(L);
}

// ---------- layers ----------
const PALETTE = ['#4fb3c3', '#e39545', '#9a7fd1', '#6cc27c', '#e0677a', '#c8b84a'];
function computeBox(L) {
  const b = new THREE.Box3(); const P = L.kind === 'cloud' ? L.pos : L.tris; const m = L.kind === 'cloud' ? L.n * 3 : P.length;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < m; i += 3) { const x = P[i], y = P[i + 1], z = P[i + 2]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z; }
  if (m) b.set(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
  L.box = b; return b;
}
function addCloud(name, data, extra = {}) {
  if (!S.origin) S.origin = data.origin.slice();
  const d = [data.origin[0] - S.origin[0], data.origin[1] - S.origin[1], data.origin[2] - S.origin[2]];
  if (Math.hypot(d[0], d[1], d[2]) > 20000) toast(name + ' is ' + (Math.hypot(d[0], d[1], d[2]) / 1000).toFixed(0) + ' km from the first layer, so the two are probably in different coordinate systems. Coordinates this far from the shared origin lose precision; load them in separate sessions or bring them together with Transform or point pairs.', true);
  if (d[0] || d[1] || d[2]) for (let i = 0; i < data.n; i++) { data.pos[i * 3] += d[0]; data.pos[i * 3 + 1] += d[1]; data.pos[i * 3 + 2] += d[2]; }
  const L = { id: S.idc++, kind: 'cloud', name, n: data.n, pos: data.pos, rgb: data.rgb, intensity: data.intensity, cls: data.cls, sfs: {}, sfStyle: {}, sf: null, visible: true, meta: data.meta || {}, solid: PALETTE[S.layers.length % PALETTE.length], ...extra };
  L.colorMode = L.colorMode || (L.rgb ? 'rgb' : L.intensity ? 'intensity' : 'elevation');
  L.col = new Uint8Array(L.n * 3);
  L.geom = new THREE.BufferGeometry();
  L.geom.setAttribute('position', new THREE.BufferAttribute(L.pos, 3));
  L.geom.setAttribute('color', new THREE.BufferAttribute(L.col, 3, true));
  L.hide = new Uint8Array(L.n); L.geom.setAttribute('aHide', new THREE.BufferAttribute(L.hide, 1));
  L.obj = new THREE.Points(L.geom, makePtMat()); L.obj.frustumCulled = false;
  scene.add(L.obj); computeBox(L); colorize(L);
  S.layers.push(L); selectLayer(L); refreshLayers();
  $('#stOrigin').textContent = 'Local origin E ' + S.origin[0] + ' N ' + S.origin[1] + ' Z ' + S.origin[2];
  return L;
}
function addMesh(name, tris64, meta = {}, scale = 1) {
  if (!S.origin) { S.origin = [Math.floor(tris64[0] * scale), Math.floor(tris64[1] * scale), Math.floor(tris64[2] * scale)]; }
  const t = new Float32Array(tris64.length);
  for (let i = 0; i < tris64.length; i++) t[i] = tris64[i] * scale - S.origin[i % 3];
  const L = { id: S.idc++, kind: 'mesh', name, tris: t, visible: true, meta, solid: '#c9ced6', opacity: 0.55, wire: false };
  L.geom = new THREE.BufferGeometry(); L.geom.setAttribute('position', new THREE.BufferAttribute(t, 3)); L.geom.computeVertexNormals();
  L.mat = new THREE.MeshLambertMaterial({ color: L.solid, transparent: true, opacity: L.opacity, side: THREE.DoubleSide, depthWrite: false });
  L.obj = new THREE.Mesh(L.geom, L.mat); L.obj.renderOrder = 2; scene.add(L.obj);
  L.edges = new THREE.LineSegments(new THREE.EdgesGeometry(L.geom, 20), new THREE.LineBasicMaterial({ color: 0x8090a0 })); scene.add(L.edges);
  computeBox(L); S.layers.push(L); selectLayer(L); refreshLayers(); return L;
}
function rebuildCloud(L) { // after pos/n changes
  L.col = new Uint8Array(L.n * 3);
  L.geom.dispose(); L.geom = new THREE.BufferGeometry();
  L.geom.setAttribute('position', new THREE.BufferAttribute(L.pos, 3));
  L.geom.setAttribute('color', new THREE.BufferAttribute(L.col, 3, true));
  L.hide = new Uint8Array(L.n); L.geom.setAttribute('aHide', new THREE.BufferAttribute(L.hide, 1)); if (L.hiddenCls) applyClassHide(L);
  L.obj.geometry = L.geom; L.zRange = null; if (L.onRebuild) L.onRebuild(L); L.iRange = null; computeBox(L); colorize(L); refreshLayers();
}
function posChanged(L) {
  if (L.kind === 'cloud') { L.geom.attributes.position.needsUpdate = true; L.zRange = null; if (L.colorMode === 'elevation') colorize(L); }
  else { L.geom.attributes.position.needsUpdate = true; L.geom.computeVertexNormals(); L.edges.geometry.dispose(); L.edges.geometry = new THREE.EdgesGeometry(L.geom, 20); }
  computeBox(L); S.dirty = true; refreshProps();
}
function removeLayer(L) {
  scene.remove(L.obj); L.geom.dispose(); if (L.edges) { scene.remove(L.edges); L.edges.geometry.dispose(); }
  S.layers = S.layers.filter(x => x !== L); if (S.sel === L) S.sel = S.layers[S.layers.length - 1] || null;
  if (!S.layers.length) S.origin = null;
  refreshLayers(); refreshAllPanes(); S.dirty = true;
}
function subsetCloud(L, idx, name) { // idx: Uint32Array of indices
  const n = idx.length, pos = new Float32Array(n * 3), rgb = L.rgb ? new Uint8Array(n * 3) : null, it = L.intensity ? new Float32Array(n) : null, cls = L.cls ? new Uint8Array(n) : null;
  const sfs = {}; for (const k in L.sfs) sfs[k] = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    const i = idx[j]; pos[j * 3] = L.pos[i * 3]; pos[j * 3 + 1] = L.pos[i * 3 + 1]; pos[j * 3 + 2] = L.pos[i * 3 + 2];
    if (rgb) { rgb[j * 3] = L.rgb[i * 3]; rgb[j * 3 + 1] = L.rgb[i * 3 + 1]; rgb[j * 3 + 2] = L.rgb[i * 3 + 2]; }
    if (it) it[j] = L.intensity[i]; if (cls) cls[j] = L.cls[i];
    for (const k in sfs) sfs[k][j] = L.sfs[k][i];
  }
  const N = addCloud(name, { n, pos, rgb, intensity: it, cls, origin: S.origin, meta: { format: 'Derived from ' + L.name } }, { colorMode: L.colorMode === 'sf' ? 'elevation' : L.colorMode });
  if (L.raw) { const k = L.rawMeta.stride, r = new Uint8Array(n * k); for (let j = 0; j < n; j++) r.set(L.raw.subarray(idx[j] * k, idx[j] * k + k), j * k); N.raw = r; N.rawMeta = L.rawMeta; }
  N.sfs = sfs; N.sfStyle = JSON.parse(JSON.stringify(L.sfStyle)); N.sf = L.sf; if (L.colorMode === 'sf' && N.sf) N.colorMode = 'sf'; colorize(N); refreshProps(); refreshAllPanes();
  return N;
}
function subsetView(L, idx, name) {
  const n = idx.length; const take = (a, k) => { if (!a) return null; const b = new a.constructor(n * k); for (let j = 0; j < n; j++) for (let q = 0; q < k; q++) b[j * k + q] = a[idx[j] * k + q]; return b; };
  const v = { name, kind: 'cloud', n, pos: take(L.pos, 3), rgb: take(L.rgb, 3), intensity: take(L.intensity, 1), cls: take(L.cls, 1), sfs: {}, sf: L.sf, meta: L.meta };
  for (const k in L.sfs) v.sfs[k] = take(L.sfs[k], 1); if (L.raw) { v.raw = take(L.raw, L.rawMeta.stride); v.rawMeta = L.rawMeta; } return v;
}
function replaceWithSubset(L, idx) {
  const n = idx.length; const take = (a, k) => { if (!a) return null; const b = new a.constructor(n * k); for (let j = 0; j < n; j++) for (let q = 0; q < k; q++) b[j * k + q] = a[idx[j] * k + q]; return b; };
  L.pos = take(L.pos, 3); L.rgb = take(L.rgb, 3); L.intensity = take(L.intensity, 1); L.cls = take(L.cls, 1); if (L.raw) L.raw = take(L.raw, L.rawMeta.stride);
  for (const k in L.sfs) L.sfs[k] = take(L.sfs[k], 1);
  L.n = n; rebuildCloud(L);
}
function selectLayer(L) { S.sel = L; refreshLayers(); refreshProps(); refreshAllPanes(); }
function refreshLayers() {
  const box = $('#layers'); box.textContent = '';
  if (!S.layers.length) { box.append(el('div', { class: 'empty' }, 'No layers yet. Open an E57 or LAS/LAZ scan to begin.')); }
  for (const L of S.layers) {
    const cb = el('input', { type: 'checkbox', 'aria-label': 'Show ' + L.name }); cb.checked = L.visible;
    cb.addEventListener('click', e => e.stopPropagation());
    cb.addEventListener('change', () => { L.visible = cb.checked; L.obj.visible = L.visible; if (L.edges) L.edges.visible = L.visible && L.wire !== 'hide'; S.dirty = true; updateStatus(); });
    const row = el('div', { class: 'layer' + (S.sel === L ? ' sel' : ''), tabindex: '0', onclick: () => selectLayer(L), onkeydown: e => { if (e.key === 'Enter') selectLayer(L); } },
      cb, el('span', { class: 'sw', style: 'background:' + (L.kind === 'mesh' ? L.solid : L.solid) }), el('span', { class: 'nm', title: L.name }, L.name),
      el('span', { class: 'ct' }, L.kind === 'cloud' ? fmtN(L.n) : (L.tris.length / 9 | 0) + ' tri'));
    box.append(row);
  }
  updateStatus();
}
function updateStatus() { let n = 0; for (const L of S.layers) if (L.visible && L.kind === 'cloud') n += L.n; $('#stPts').textContent = fmtN(n); }

function refreshProps() {
  const P = $('#layerProps'); P.textContent = ''; const L = S.sel;
  if (!L) { P.append(el('h3', {}, 'Layer'), el('div', { class: 'empty' }, 'Select a layer to see its details and display settings.')); return; }
  const nameIn = el('input', { type: 'text', id: 'layerName', value: L.name, 'aria-label': 'Layer name' });
  nameIn.addEventListener('change', () => { L.name = nameIn.value || L.name; refreshLayers(); refreshAllPanes(); });
  P.append(el('h3', {}, L.kind === 'cloud' ? 'Point cloud' : 'Mesh'), nameIn);
  const b = L.box, o = S.origin || [0, 0, 0];
  const kv = el('dl', { class: 'kv' });
  const add = (k, v) => kv.append(el('dt', {}, k), el('dd', {}, v));
  if (L.kind === 'cloud') {
    add('Points', L.n.toLocaleString());
    if (L.meta.format) add('Source', L.meta.format);
    if (L.meta.stride > 1) add('Loaded', 'every ' + L.meta.stride + 'th of ' + L.meta.total.toLocaleString());
    const f = ['XYZ']; if (L.rgb) f.push('RGB'); if (L.intensity) f.push('Intensity'); if (L.cls) f.push('Class'); f.push(...Object.keys(L.sfs)); add('Fields', f.join(', '));
  } else { add('Triangles', (L.tris.length / 9).toLocaleString()); if (L.meta.format) add('Source', L.meta.format); }
  if (!b.isEmpty()) {
    add('E range', fm(b.min.x + o[0]) + ' – ' + fm(b.max.x + o[0]));
    add('N range', fm(b.min.y + o[1]) + ' – ' + fm(b.max.y + o[1]));
    add('Z range', fm(b.min.z + o[2]) + ' – ' + fm(b.max.z + o[2]));
    const s = b.getSize(new THREE.Vector3()); add('Size', fm(s.x, 2) + ' × ' + fm(s.y, 2) + ' × ' + fm(s.z, 2) + ' m');
  }
  if (L.meta.scans && L.meta.scans.length > 1) add('Scans', L.meta.scans.map(s => s.name).join(', '));
  P.append(kv);
  if (L.kind === 'cloud') {
    const sel = el('select', { id: 'colorMode' });
    const opts = [['rgb', 'RGB colour', !!L.rgb], ['intensity', 'Intensity', !!L.intensity], ['elevation', 'Elevation', true], ['class', 'Classification', !!L.cls], ['sf', 'Scalar field', Object.keys(L.sfs).length > 0], ['solid', 'Single colour', true]];
    for (const [v, t, ok] of opts) if (ok) sel.append(el('option', { value: v, selected: L.colorMode === v }, t));
    sel.addEventListener('change', () => { L.colorMode = sel.value; if (L.colorMode === 'sf' && !L.sf) L.sf = Object.keys(L.sfs)[0]; colorize(L); refreshProps(); refreshAllPanes(); });
    P.append(el('div', { class: 'field' }, el('label', { for: 'colorMode' }, 'Colour by'), sel));
    if (L.colorMode === 'solid') {
      const ci = el('input', { type: 'color', value: L.solid, 'aria-label': 'Layer colour' }); ci.addEventListener('input', () => { L.solid = ci.value; colorize(L); refreshLayers(); });
      P.append(el('div', { class: 'field' }, el('label', {}, 'Colour'), ci));
    }
    if (L.colorMode === 'sf' && L.sf && L.sfStyle[L.sf]) P.append(sfControls(L));
    if (L.colorMode === 'class' && L.cls) {
      const counts = {}; for (let i = 0; i < L.n; i++) counts[L.cls[i]] = (counts[L.cls[i]] || 0) + 1;
      const leg = el('div', { class: 'mlist' });
      for (const k of Object.keys(counts).sort((a, b) => a - b)) { const q = CLASS_COL[k] || [200, 200, 200]; const cb = el('input', { type: 'checkbox', 'aria-label': 'Show ' + (CLASS_NAME[k] || 'class ' + k) }); cb.checked = !(L.hiddenCls && L.hiddenCls.has(+k)); cb.addEventListener('change', () => { L.hiddenCls = L.hiddenCls || new Set(); if (cb.checked) L.hiddenCls.delete(+k); else L.hiddenCls.add(+k); applyClassHide(L); });
        leg.append(el('label', { class: 'row', style: 'font-size:12px;gap:6px' }, cb, el('span', { class: 'sw', style: 'width:10px;height:10px;border-radius:2px;background:rgb(' + q.join(',') + ')' }), (CLASS_NAME[k] || 'Class ' + k), el('span', { class: 'grow' }), el('span', { class: 'mono hint' }, fmtN(counts[k])))); }
      P.append(el('div', { class: 'hint' }, 'Untick a class to hide it in the view (exports and tools still use every point).'), leg);
    }
  } else {
    const op = el('input', { type: 'range', min: '0.1', max: '1', step: '0.05', value: L.opacity, id: 'meshOp' });
    op.addEventListener('input', () => { L.opacity = +op.value; L.mat.opacity = L.opacity; L.mat.depthWrite = L.opacity > 0.95; S.dirty = true; });
    const ci = el('input', { type: 'color', value: L.solid, 'aria-label': 'Mesh colour' }); ci.addEventListener('input', () => { L.solid = ci.value; L.mat.color.set(ci.value); refreshLayers(); S.dirty = true; });
    const ed = el('input', { type: 'checkbox', id: 'meshEdges' }); ed.checked = L.edges.visible; ed.addEventListener('change', () => { L.edges.visible = ed.checked; S.dirty = true; });
    P.append(el('div', { class: 'field' }, el('label', { for: 'meshOp' }, 'Opacity'), op), el('div', { class: 'field' }, el('label', {}, 'Colour'), ci), el('div', { class: 'field' }, el('label', { for: 'meshEdges' }, 'Edges'), el('span', {}, ed)));
  }
  const exp = el('div', { class: 'row' });
  exp.append(el('button', { class: 'btn small', onclick: () => fitBox(L.box) }, 'Zoom to'));
  if (L.kind === 'cloud') {
    exp.append(el('button', { class: 'btn small', onclick: () => { const idx = new Uint32Array(L.n); for (let i = 0; i < L.n; i++) idx[i] = i; subsetCloud(L, idx, L.name + ' copy'); } }, 'Duplicate'));
    const fsel = el('select', { id: 'expFmt', style: 'width:auto' }, el('option', { value: 'las' }, 'LAS 1.2'), el('option', { value: 'ply' }, 'PLY'), el('option', { value: 'csv' }, 'CSV'));
    exp.append(fsel, el('button', { class: 'btn small', onclick: () => exportCloud(L, fsel.value) }, 'Export'));
  }
  exp.append(el('button', { class: 'btn small danger', onclick: () => removeLayer(L) }, 'Delete'));
  P.append(exp);
}
function sfControls(L) {
  const box = el('div', { style: 'display:grid;gap:8px' });
  const fsel = el('select', { id: 'sfName' }); for (const k of Object.keys(L.sfs)) fsel.append(el('option', { value: k, selected: L.sf === k }, k));
  fsel.addEventListener('change', () => { L.sf = fsel.value; colorize(L); refreshProps(); refreshAllPanes(); });
  const st = L.sfStyle[L.sf];
  const rsel = el('select', { id: 'sfRamp' }, ...[['bgr', 'Blue–green–red'], ['diverging', 'Blue–white–red'], ['viridis', 'Viridis'], ['grey', 'Greyscale'], ['tol', 'Tolerance bands']].map(([v, t]) => el('option', { value: v, selected: st.ramp === v }, t)));
  rsel.addEventListener('change', () => { st.ramp = rsel.value; colorize(L); refreshProps(); refreshAllPanes(); });
  const lo = el('input', { type: 'number', step: 'any', value: +st.lo.toFixed(4), id: 'sfLo', 'aria-label': 'Range minimum' }), hi = el('input', { type: 'number', step: 'any', value: +st.hi.toFixed(4), id: 'sfHi', 'aria-label': 'Range maximum' });
  const upd = () => { st.lo = +lo.value; st.hi = +hi.value; colorize(L); refreshAllPanes(); };
  lo.addEventListener('change', upd); hi.addEventListener('change', upd);
  box.append(el('div', { class: 'field' }, el('label', { for: 'sfName' }, 'Field'), fsel), el('div', { class: 'field' }, el('label', { for: 'sfRamp' }, 'Ramp'), rsel));
  if (st.ramp === 'tol') {
    const tol = el('input', { type: 'number', step: 'any', value: st.tol, id: 'sfTol' }); tol.addEventListener('change', () => { st.tol = Math.abs(+tol.value); colorize(L); refreshAllPanes(); });
    box.append(el('div', { class: 'field' }, el('label', { for: 'sfTol' }, 'Tolerance ± (m)'), tol));
  } else {
    box.append(el('div', { class: 'field' }, el('label', {}, 'Range'), el('div', { class: 'row', style: 'flex-wrap:nowrap' }, lo, hi)));
  }
  box.append(el('div', { class: 'ramp', style: 'background:' + rampCss(st.ramp) }), el('div', { class: 'legend' }, el('span', {}, st.ramp === 'tol' ? '< −' + st.tol : fm(st.lo, 4)), el('span', {}, st.ramp === 'tol' ? 'within' : ''), el('span', {}, st.ramp === 'tol' ? '> +' + st.tol : fm(st.hi, 4))));
  return box;
}

// ---------- export ----------
async function exportCloud(L, f) {
  const base = L.name.replace(/[^\w\-. ]+/g, '_').replace(/\.(las|laz|e57|ply|xyz|txt|csv|pts)$/i, '');
  const view = { n: L.n, pos: L.pos, rgb: L.rgb, intensity: L.intensity, cls: L.cls, sf: L.sf ? L.sfs[L.sf] : null, sfName: L.sf };
  await busy('Writing ' + f.toUpperCase() + '…', async () => {
    if (f === 'las') await saveFile(base + '.las', IO.writeLAS(view, S.origin));
    else if (f === 'ply') await saveFile(base + '.ply', IO.writePLY(view, S.origin));
    else await saveFile(base + '.csv', IO.writeXYZ(view, S.origin, true));
  });
}

// ---------- loading ----------
let lazModule = null;
async function getLaz() {
  if (lazModule) return lazModule;
  const b64 = window.LAZ_WASM_B64; const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  lazModule = await window.createLazPerf({ wasmBinary: bin, locateFile: x => x });
  return lazModule;
}
async function loadFiles(files) {
  for (const f of files) {
    const res = await busy('Reading ' + f.name, onProgress => IO.readAny(IO.fileSource(f), { budget: +$('#budget').value, onProgress, lazPerf: getLaz }));
    if (!res) continue;
    if (res.mesh) { addMesh(f.name, res.tris, res.meta, +$('#meshUnits').value); toast('Loaded mesh ' + f.name + ' (' + res.meta.triangles.toLocaleString() + ' triangles)'); }
    else {
      if (!res.n) { toast(f.name + ' contained no valid points.', true); continue; }
      addCloud(f.name, res);
      const m = res.meta; toast('Loaded ' + f.name + ': ' + res.n.toLocaleString() + ' points' + (m.stride > 1 ? ' (every ' + m.stride + 'th of ' + m.total.toLocaleString() + ' — raise the point budget for more)' : ''));
    }
    if (S.layers.length === 1 || (S.layers.length <= 2 && S.sample)) { /* first real data: frame it */ }
    fitAll();
  }
}
$('#fileIn').addEventListener('change', e => { const fs = [...e.target.files]; e.target.value = ''; if (fs.some(f => !/\.json$/i.test(f.name))) dropSample(); loadFiles(fs); });
['dragenter', 'dragover'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); $('#drop').classList.add('hot'); }));
['dragleave', 'drop'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); if (t === 'drop' || !e.relatedTarget) $('#drop').classList.remove('hot'); }));
document.addEventListener('drop', e => { const fs = [...(e.dataTransfer?.files || [])]; if (fs.length) { if (fs.some(f => !/\.json$/i.test(f.name))) dropSample(); loadFiles(fs); } });
function dropSample() { if (!S.sample) return; for (const L of S.layers.filter(L => L.sample)) removeLayer(L); S.sample = false; clearMeasures(); }

// ---------- modes ----------
function startMode(m) {
  cancelMode(); S.mode = Object.assign({ pts: [] }, m);
  $('#modechip').hidden = false; $('#modetext').textContent = m.text; $('#modeDone').hidden = !m.finishable;
  canvas.style.cursor = 'crosshair';
  if (innerWidth <= 1000) closeDrawers();
}
function setModeText(t) { if (S.mode) $('#modetext').textContent = t; }
function cancelMode() {
  if (!S.mode) return; const m = S.mode; S.mode = null;
  if (m.temp) { annot.remove(m.temp); m.temp = null; }
  if (m.onCancel) m.onCancel();
  $('#modechip').hidden = true; canvas.style.cursor = ''; drawOverlay(); S.dirty = true;
}
function finishMode() { if (!S.mode) return; const m = S.mode; if (m.onFinish) { const keep = m.onFinish(m); if (keep === false) return; } S.mode = null; if (m.temp) annot.remove(m.temp); $('#modechip').hidden = true; canvas.style.cursor = ''; drawOverlay(); S.dirty = true; }
$('#modeEsc').addEventListener('click', cancelMode);
$('#modeDone').addEventListener('click', finishMode);
function refreshModeGraphics() { const m = S.mode; if (!m) return; if (m.temp) annot.remove(m.temp); m.temp = m.pts.length && m.pts[0].isVector3 ? lineObj(m.pts, false, 0xffaa00) : null; if (m.temp) annot.add(m.temp); drawOverlay(); S.dirty = true; }

// ---------- graphics helpers ----------
function lineObj(pts, closed, color = 0xffcc00) {
  const g = new THREE.Group();
  const arr = []; pts.forEach(p => arr.push(p.x, p.y, p.z)); if (closed && pts.length > 2) arr.push(pts[0].x, pts[0].y, pts[0].z);
  const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
  const ln = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true })); ln.renderOrder = 20; g.add(ln);
  const pg = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts.flatMap(p => [p.x, p.y, p.z]), 3));
  const pp = new THREE.Points(pg, new THREE.PointsMaterial({ color, size: 7, sizeAttenuation: false, depthTest: false, transparent: true })); pp.renderOrder = 21; g.add(pp);
  return g;
}
const labels = [];
function addLabel(pos, html) { const d = el('div', { class: 'lbl' }); d.innerHTML = html; $('#labels').append(d); const o = { pos, el: d }; labels.push(o); return o; }
function removeLabel(o) { if (!o) return; o.el.remove(); const i = labels.indexOf(o); if (i >= 0) labels.splice(i, 1); }
function updateLabels() {
  const cam = curCam(), w = W(), h = H(), v = new THREE.Vector3();
  for (const o of labels) {
    v.copy(o.pos).project(cam);
    const vis = v.z > -1 && v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2;
    o.el.style.display = vis ? '' : 'none';
    if (vis) { o.el.style.left = ((v.x * 0.5 + 0.5) * w) + 'px'; o.el.style.top = ((0.5 - v.y * 0.5) * h) + 'px'; }
  }
}
function drawOverlay() {
  const pr = renderer.getPixelRatio(); octx.setTransform(pr, 0, 0, pr, 0, 0); octx.clearRect(0, 0, W(), H());
  const r = vp.getBoundingClientRect();
  const poly = (S.mode && S.mode.type === 'lasso') ? S.mode.pts : (S.lasso && S.lasso.show ? S.lasso.pts : null);
  if (poly && poly.length) {
    octx.beginPath(); poly.forEach((p, i) => { const x = p[0] - r.left, y = p[1] - r.top; i ? octx.lineTo(x, y) : octx.moveTo(x, y); });
    if (S.mode && S.mode.cursor && !S.mode.drawing) octx.lineTo(S.mode.cursor[0] - r.left, S.mode.cursor[1] - r.top);
    octx.closePath(); octx.fillStyle = 'rgba(255,170,0,0.12)'; octx.fill(); octx.strokeStyle = '#ffaa00'; octx.lineWidth = 1.5; octx.setLineDash([6, 4]); octx.stroke(); octx.setLineDash([]);
  }
}
function drawAxes() {
  const cam = persp, svg = $('#axes'); const m = cam.matrixWorldInverse.elements;
  const ax = [['E', [1, 0, 0], '#e0564a'], ['N', [0, 1, 0], '#4cc27c'], ['Z', [0, 0, 1], '#4f8fe0']];
  let s = '';
  const items = ax.map(([n, v, c]) => { const x = m[0] * v[0] + m[4] * v[1] + m[8] * v[2], y = m[1] * v[0] + m[5] * v[1] + m[9] * v[2], z = m[2] * v[0] + m[6] * v[1] + m[10] * v[2]; return { n, c, x: x * 22, y: -y * 22, z }; }).sort((a, b) => a.z - b.z);
  for (const a of items) s += `<line x1="0" y1="0" x2="${a.x.toFixed(1)}" y2="${a.y.toFixed(1)}" stroke="${a.c}" stroke-width="2.2" stroke-linecap="round"/><text x="${(a.x * 1.22).toFixed(1)}" y="${(a.y * 1.22 + 3.5).toFixed(1)}" fill="${a.c}" font-size="10" font-family="IBM Plex Mono, monospace" text-anchor="middle">${a.n}</text>`;
  svg.innerHTML = s;
}

// ---------- render loop ----------
function loop() { requestAnimationFrame(loop); if (S.dirty) { S.dirty = false; draw(); } }
function draw() {
  const cam = curCam(); const bg = bgColor();
  scene.background = bg; ptUniforms.uSize.value = S.ptSize;
  ptUniforms.uClip.value = S.clip.on ? 1 : 0; ptUniforms.uMin.value.copy(S.clip.box.min); ptUniforms.uMax.value.copy(S.clip.box.max);
  clipHelper.visible = S.clip.on && S.clip.showBox !== false; clipHelper.box.copy(S.clip.box);
  if (S.edl) {
    ensureRT(); renderer.setRenderTarget(rt); if (globeRender(cam, bg)) { scene.background = null; renderer.autoClear = false; renderer.clearDepth(); } renderer.render(scene, cam); renderer.autoClear = true; renderer.setRenderTarget(null);
    edlMat.uniforms.tColor.value = rt.texture; edlMat.uniforms.tDepth.value = rt.depthTexture;
    edlMat.uniforms.uNear.value = cam.near; edlMat.uniforms.uFar.value = cam.far; edlMat.uniforms.uOrtho.value = S.cam.ortho ? 1 : 0; edlMat.uniforms.uBg.value.copy(bg); edlMat.uniforms.uScale.value = S.cam.ortho ? ortho.position.distanceTo(S.cam.target) / Math.max(1e-6, S.cam.dist) : 1;
    renderer.render(edlScene, edlCam);
  } else { if (globeRender(cam, bg)) { scene.background = null; renderer.autoClear = false; renderer.clearDepth(); } renderer.render(scene, cam); renderer.autoClear = true; }
  updateLabels(); drawAxes(); drawOverlay();
}

// ---------- toolbar ----------
$$('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
$('#btnFit').addEventListener('click', () => fitAll());
function toggleOrtho() { S.cam.ortho = !S.cam.ortho; $('#btnOrtho').classList.toggle('on', S.cam.ortho); updateCamera(); }
$('#btnOrtho').addEventListener('click', toggleOrtho);
$('#btnEDL').addEventListener('click', () => { S.edl = !S.edl; $('#btnEDL').classList.toggle('on', S.edl); S.dirty = true; });
$('#btnClipVis').addEventListener('click', () => { S.clip.on = !S.clip.on; if (S.clip.on && S.clip.box.isEmpty()) S.clip.box.copy(sceneBox()); syncClipUI(); S.dirty = true; });
$('#ptSize').addEventListener('input', e => { S.ptSize = +e.target.value; S.dirty = true; });
$('#btnShot').addEventListener('click', () => { draw(); canvas.toBlob(b => saveFile('scanbench-view.png', b), 'image/png'); });
$$('.tab').forEach(t => t.addEventListener('click', () => { $$('.tab').forEach(x => x.classList.toggle('on', x === t)); $$('.pane').forEach(p => p.classList.toggle('on', p.id === 'pane-' + t.dataset.tab)); }));
function closeDrawers() { $('#leftPane').classList.remove('open'); $('#rightPane').classList.remove('open'); $('#scrim').classList.remove('on'); }
$('#tglLeft').addEventListener('click', () => { const o = !$('#leftPane').classList.contains('open'); closeDrawers(); if (o) { $('#leftPane').classList.add('open'); $('#scrim').classList.add('on'); } });
$('#tglRight').addEventListener('click', () => { const o = !$('#rightPane').classList.contains('open'); closeDrawers(); if (o) { $('#rightPane').classList.add('open'); $('#scrim').classList.add('on'); } });
$('#scrim').addEventListener('click', closeDrawers);
$('#btnMerge').addEventListener('click', () => {
  const Ls = S.layers.filter(L => L.visible && L.kind === 'cloud'); if (Ls.length < 2) { toast('Show at least two point clouds to merge.'); return; }
  const n = Ls.reduce((a, L) => a + L.n, 0); const pos = new Float32Array(n * 3); const hasRGB = Ls.every(L => L.rgb), hasI = Ls.every(L => L.intensity);
  const rgb = hasRGB ? new Uint8Array(n * 3) : null, it = hasI ? new Float32Array(n) : null, cls = new Uint8Array(n); let o = 0;
  for (const L of Ls) { pos.set(L.pos.subarray(0, L.n * 3), o * 3); if (rgb) rgb.set(L.rgb.subarray(0, L.n * 3), o * 3); if (it) it.set(L.intensity.subarray(0, L.n), o); if (L.cls) cls.set(L.cls.subarray(0, L.n), o); else cls.fill(1, o, o + L.n); o += L.n; }
  for (const L of Ls) { L.visible = false; L.obj.visible = false; }
  addCloud('Merged (' + Ls.length + ' clouds)', { n, pos, rgb, intensity: it, cls, origin: S.origin, meta: { format: 'Merged' } });
  toast('Merged ' + Ls.length + ' clouds. The originals are hidden, not deleted.');
});

// ============ PANES ============
const pane = id => $('#pane-' + id);
const clouds = () => S.layers.filter(L => L.kind === 'cloud');
const meshes = () => S.layers.filter(L => L.kind === 'mesh');
function needCloud() { if (!S.sel || S.sel.kind !== 'cloud') { toast('Select a point cloud layer first.', true); return null; } return S.sel; }
function numIn(id, val, step = 'any', attrs = {}) { const e = el('input', { type: 'number', id, value: val, step, ...attrs }); return e; }
function fieldRow(label, input, id) { return el('div', { class: 'field' }, el('label', { for: id || input.id }, label), input); }
function layerSelect(id, list, selected) { const s = el('select', { id }); for (const L of list) s.append(el('option', { value: L.id, selected: L === selected }, L.name)); return s; }
const byId = id => S.layers.find(L => L.id === +id);
function refreshAllPanes() { buildCompare(); buildRegister(); buildTerrain(); buildEdit(); buildSection(); }

// ---------- MEASURE ----------
function buildMeasure() {
  const p = pane('measure'); p.textContent = '';
  const s1 = el('div', { class: 'sec' }, el('h3', {}, 'Measure'),
    el('div', { class: 'note' }, 'Click points on the cloud or mesh. Points snap to the nearest visible point within 9 px, frontmost first. Double-click anywhere to set the rotation centre.'),
    el('div', { class: 'row' },
      el('button', { class: 'btn small', onclick: () => measureMode('point') }, 'Point'),
      el('button', { class: 'btn small', onclick: () => measureMode('distance') }, 'Distance'),
      el('button', { class: 'btn small', onclick: () => measureMode('height') }, 'Height'),
      el('button', { class: 'btn small', onclick: () => measureMode('polyline') }, 'Polyline'),
      el('button', { class: 'btn small', onclick: () => measureMode('area') }, 'Area'),
      el('button', { class: 'btn small', onclick: () => measureMode('angle') }, 'Angle')),
    el('div', { class: 'row' },
      el('button', { class: 'btn small', onclick: () => planeDipMode() }, 'Plane (dip)'),
      el('button', { class: 'btn small', onclick: () => stockpileMode() }, 'Stockpile volume'),
      el('button', { class: 'btn small', onclick: () => losMode() }, 'Line of sight'),
      el('button', { class: 'btn small', onclick: () => viewshedMode() }, 'Viewshed')),
    el('div', { class: 'hint' }, 'Plane: click a surface for dip and dip direction. Stockpile: click around the toe, Enter to close. Line of sight and viewshed use a surface model of the visible clouds.'));
  const list = el('div', { class: 'mlist', id: 'mlist' });
  if (!S.measures.length) list.append(el('div', { class: 'empty' }, 'Measurements you take appear here, with values you can export to CSV or DXF.'));
  const tags = [...new Set(S.measures.flatMap(M => M.tags || []))].sort();
  if (S.mTag && !tags.includes(S.mTag)) S.mTag = '';
  for (const M of S.measures) {
    restyleMeasure(M); if (!measureVisible(M)) continue;
    const nm = el('input', { type: 'text', value: M.name || '', 'aria-label': 'Name' }); nm.addEventListener('change', () => { M.name = nm.value; });
    const col = el('input', { type: 'color', value: M.color || '#ffcc00', 'aria-label': 'Colour' }); col.addEventListener('input', () => { M.color = col.value; restyleMeasure(M); });
    const tg = el('input', { type: 'text', value: (M.tags || []).join(', '), placeholder: 'tags, comma separated', 'aria-label': 'Tags' }); tg.addEventListener('change', () => { M.tags = tg.value.split(',').map(t => t.trim()).filter(Boolean); buildMeasure(); });
    const nt = el('textarea', { rows: '2', placeholder: 'Notes', 'aria-label': 'Notes', style: 'width:100%;resize:vertical' }); nt.value = M.note || ''; nt.addEventListener('change', () => { M.note = nt.value; });
    const det = el('details', {}, el('summary', { class: 'hint', style: 'cursor:pointer' }, 'Name, colour, tags, notes'), el('div', { style: 'display:grid;gap:4px;margin-top:4px' }, el('div', { class: 'row', style: 'flex-wrap:nowrap' }, nm, col), tg, nt));
    list.append(el('div', { class: 'mitem' }, el('div', {}, el('div', { class: 't' }, (M.name || M.type) + ((M.tags || []).length ? ' · ' + M.tags.join(', ') : '')), el('div', { class: 'v' }, ...M.lines.map(l => el('div', {}, l))), det),
      el('span', { class: 'row', style: 'gap:4px;align-self:start' }, el('button', { class: 'btn small', onclick: () => { const b = new THREE.Box3(); (M.drawPts || M.pts).forEach(p => b.expandByPoint(p)); fitBox(b.expandByScalar(2)); } }, 'Zoom'),
        el('button', { class: 'btn small icon danger', 'aria-label': 'Delete measurement', onclick: () => { removeMeasure(M); buildMeasure(); } }, '×'))));
  }
  if (tags.length) { const ts = el('select', { style: 'width:auto', 'aria-label': 'Show tag' }, el('option', { value: '' }, 'All tags'), ...tags.map(t => el('option', { value: t, selected: S.mTag === t }, t))); ts.addEventListener('change', () => { S.mTag = ts.value; buildMeasure(); }); list.prepend(el('div', { class: 'row' }, el('span', { class: 'hint' }, 'Show'), ts)); }
  const s2 = el('div', { class: 'sec' }, el('h3', {}, 'Results', S.measures.length ? el('span', { class: 'row', style: 'gap:4px' },
    el('button', { class: 'btn small', onclick: exportMeasuresCSV }, 'CSV'), el('button', { class: 'btn small', onclick: exportMeasuresDXF }, 'DXF'), el('button', { class: 'btn small danger', onclick: () => { clearMeasures(); buildMeasure(); } }, 'Clear')) : null), list);
  const s3 = el('div', { class: 'sec' }, el('h3', {}, 'Navigation'), el('div', { class: 'help' },
    el('span', {}, 'Rotate'), el('span', { class: 'note' }, 'Left drag'), el('span', {}, 'Pan'), el('span', { class: 'note' }, 'Right drag, or Shift + drag'), el('span', {}, 'Zoom'), el('span', { class: 'note' }, 'Wheel (zooms to cursor), pinch'),
    el('span', {}, 'Pivot'), el('span', { class: 'note' }, 'Double-click a point'), el('span', {}, 'Views'), el('span', { class: 'note' }, el('kbd', {}, 'T'), ' top, ', el('kbd', {}, 'I'), ' iso, ', el('kbd', {}, 'F'), ' fit, ', el('kbd', {}, 'O'), ' ortho'),
    el('span', {}, 'Tools'), el('span', { class: 'note' }, el('kbd', {}, 'Enter'), ' finish, ', el('kbd', {}, 'Backspace'), ' undo point, ', el('kbd', {}, 'Esc'), ' cancel')));
  p.append(s1, s2, s3);
}
function measureMode(type) {
  const need = { point: 1, distance: 2, height: 2, angle: 3 }[type];
  const text = { point: 'Click a point', distance: 'Click the start, then the end', height: 'Click the lower point, then the upper point', polyline: 'Click vertices · Enter or double-click to finish', area: 'Click the outline · Enter or double-click to close', angle: 'Click first arm, then the vertex, then second arm' }[type];
  startMode({
    type: 'measure', text, finishable: !need, dblFinish: !need,
    onPick: pk => { S.mode.pts.push(pk.p); refreshModeGraphics(); if (need && S.mode.pts.length >= need) finishMode(); },
    onFinish: m => { if (m.pts.length < (need || 2) || (type === 'area' && m.pts.length < 3)) { toast('Not enough points for this measurement.'); return; } addMeasure(type, m.pts.slice()); }
  });
}
function addMeasure(type, pts) {
  const M = { type, pts, lines: [], labels: [], name: type[0].toUpperCase() + type.slice(1) + ' ' + (S.measures.length + 1), note: '', tags: [], color: '#ffcc00' };
  const d3 = (a, b) => a.distanceTo(b), dh = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  let lab = '', at = pts[0];
  if (type === 'point') { const w = W3(pts[0]); M.lines = ['E ' + w[0].toFixed(3), 'N ' + w[1].toFixed(3), 'Z ' + w[2].toFixed(3)]; lab = 'Z ' + w[2].toFixed(3); }
  else if (type === 'distance') {
    const [a, b] = pts, D = d3(a, b), Hh = dh(a, b), dz = b.z - a.z, slope = Hh > 0 ? dz / Hh * 100 : Infinity;
    M.lines = ['3D ' + D.toFixed(4) + ' m', 'Horizontal ' + Hh.toFixed(4) + ' m', 'ΔZ ' + (dz >= 0 ? '+' : '') + dz.toFixed(4) + ' m', 'Grade ' + (isFinite(slope) ? slope.toFixed(2) + ' %' : 'vertical')];
    lab = D.toFixed(3) + ' m'; at = a.clone().add(b).multiplyScalar(0.5); M.value = D;
  } else if (type === 'height') {
    const [a, b] = pts, dz = b.z - a.z; const top = new THREE.Vector3(a.x, a.y, b.z);
    M.drawPts = [a, top, b];
    M.lines = ['ΔZ ' + (dz >= 0 ? '+' : '') + dz.toFixed(4) + ' m', 'Horizontal offset ' + dh(a, b).toFixed(4) + ' m']; lab = 'ΔZ ' + dz.toFixed(3); at = a.clone().add(top).multiplyScalar(0.5); M.value = dz;
  } else if (type === 'polyline') {
    let D = 0, Hh = 0; for (let i = 1; i < pts.length; i++) { D += d3(pts[i - 1], pts[i]); Hh += dh(pts[i - 1], pts[i]); }
    M.lines = ['Length 3D ' + D.toFixed(4) + ' m', 'Length plan ' + Hh.toFixed(4) + ' m', pts.length + ' vertices']; lab = D.toFixed(3) + ' m'; at = pts[pts.length - 1]; M.value = D;
  } else if (type === 'area') {
    let A2 = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; A2 += a.x * b.y - b.x * a.y; }
    const plan = Math.abs(A2) / 2; const nrm = new THREE.Vector3();
    for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; nrm.x += (a.y - b.y) * (a.z + b.z); nrm.y += (a.z - b.z) * (a.x + b.x); nrm.z += (a.x - b.x) * (a.y + b.y); }
    const a3 = nrm.length() / 2; let per = 0; for (let i = 0; i < pts.length; i++) per += d3(pts[i], pts[(i + 1) % pts.length]);
    M.lines = ['Plan area ' + plan.toFixed(3) + ' m²', 'Surface area ' + a3.toFixed(3) + ' m²', 'Perimeter ' + per.toFixed(3) + ' m']; lab = plan.toFixed(2) + ' m²';
    at = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length); M.closed = true; M.value = plan;
  } else if (type === 'angle') {
    const [a, v, b] = pts; const u = a.clone().sub(v).normalize(), w = b.clone().sub(v).normalize();
    const ang = Math.acos(Math.max(-1, Math.min(1, u.dot(w)))) * 180 / Math.PI;
    M.lines = ['Angle ' + ang.toFixed(3) + '°']; lab = ang.toFixed(2) + '°'; at = v; M.value = ang;
  }
  M.lab = lab; M.at = at; pushMeasure(M);
}
function pushMeasure(M) {
  M.obj = M.obj || lineObj(M.drawPts || M.pts, M.closed, new THREE.Color(M.color || '#ffcc00').getHex()); annot.add(M.obj);
  if (M.extra) annot.add(M.extra);
  M.labels.push(addLabel(M.at || M.pts[0], esc(M.lab || '')));
  S.measures.push(M); buildMeasure(); S.dirty = true;
}
function measureVisible(M) { return !S.mTag || (M.tags || []).includes(S.mTag); }
function restyleMeasure(M) {
  const v = measureVisible(M); M.obj.visible = v; if (M.extra) M.extra.visible = v; M.labels.forEach(l => { l.el.style.display = v ? '' : 'none'; });
  if (M.obj.material && M.obj.material.color && !M.keepColor) M.obj.material.color.set(M.color || '#ffcc00'); S.dirty = true;
}
function removeMeasure(M) { annot.remove(M.obj); if (M.extra) annot.remove(M.extra); M.labels.forEach(removeLabel); S.measures = S.measures.filter(x => x !== M); S.dirty = true; }
function clearMeasures() { for (const M of S.measures.slice()) removeMeasure(M); }
function exportMeasuresCSV() {
  const q = v => '"' + String(v || '').replace(/"/g, '""') + '"';
  let s = 'id,name,type,values,tags,notes,colour,points (E N Z)\n';
  S.measures.filter(measureVisible).forEach((M, i) => { s += [(i + 1), q(M.name), M.type, q(M.lines.join('; ')), q((M.tags || []).join(', ')), q(M.note), M.color || '', q(M.pts.map(p => W3(p).map(v => v.toFixed(4)).join(' ')).join(' | '))].join(',') + '\n'; });
  saveFile('measurements.csv', s);
}
function exportMeasuresDXF() {
  const E = []; const w = p => W3(p);
  S.measures.forEach((M, i) => {
    const P = (M.drawPts || M.pts).map(w);
    if (P.length === 1) E.push({ type: 'POINT', p: P[0], layer: 'MEASURE_POINTS' });
    else E.push({ type: 'POLY', pts: P, closed: !!M.closed, layer: 'MEASURE_' + M.type.toUpperCase() });
    E.push({ type: 'TEXT', p: P[0], h: 0.1, text: (M.name || (i + 1)) + ' ' + M.lines[0], layer: 'MEASURE_TEXT' });
  });
  saveFile('measurements.dxf', IO.writeDXF(E));
}

// ---------- CLIP & SECTION ----------
function syncClipUI() { $('#btnClipVis').classList.toggle('on', S.clip.on); buildSection(); S.dirty = true; }
function buildSection() {
  const p = pane('section'); if (!p) return; p.textContent = '';
  const o = S.origin || [0, 0, 0], b = S.clip.box;
  const on = el('input', { type: 'checkbox', id: 'clipOn' }); on.checked = S.clip.on;
  on.addEventListener('change', () => { S.clip.on = on.checked; if (S.clip.on && b.isEmpty()) b.copy(sceneBox()); syncClipUI(); });
  const grid = el('div', { style: 'display:grid;grid-template-columns:24px 1fr 1fr;gap:6px;align-items:center' }, el('span'), el('span', { class: 'hint' }, 'Min'), el('span', { class: 'hint' }, 'Max'));
  ['x', 'y', 'z'].forEach((a, k) => {
    const mn = numIn('clip' + a + '0', b.isEmpty() ? '' : (b.min[a] + o[k]).toFixed(3), 'any', { 'aria-label': ['E', 'N', 'Z'][k] + ' minimum' });
    const mx = numIn('clip' + a + '1', b.isEmpty() ? '' : (b.max[a] + o[k]).toFixed(3), 'any', { 'aria-label': ['E', 'N', 'Z'][k] + ' maximum' });
    const upd = () => { b.min[a] = +mn.value - o[k]; b.max[a] = +mx.value - o[k]; S.clip.on = true; on.checked = true; $('#btnClipVis').classList.add('on'); S.dirty = true; };
    mn.addEventListener('change', upd); mx.addEventListener('change', upd);
    grid.append(el('span', { class: 'mono' }, ['E', 'N', 'Z'][k]), mn, mx);
  });
  const thick = numIn('secThick', S.secThick || 0.1, 'any');
  thick.addEventListener('change', () => { S.secThick = Math.max(1e-4, +thick.value); });
  const s1 = el('div', { class: 'sec' }, el('h3', {}, 'Clipping box', el('label', { class: 'row', style: 'gap:6px;text-transform:none;letter-spacing:0;font-weight:400;color:var(--fg)' }, on, 'On')),
    el('div', { class: 'note' }, 'Hides everything outside the box. Coordinates are in the file’s system.'), grid,
    el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: () => { b.copy(sceneBox()); S.clip.on = true; syncClipUI(); } }, 'Fit to all'),
      el('button', { class: 'btn small', onclick: () => { if (S.sel) { b.copy(S.sel.box); S.clip.on = true; syncClipUI(); } } }, 'Fit to layer'),
      el('button', { class: 'btn small', onclick: () => { const c = sceneBox(); const ctr = c.getCenter(new THREE.Vector3()); const sz = c.getSize(new THREE.Vector3()).multiplyScalar(0.25); b.set(ctr.clone().sub(sz), ctr.clone().add(sz)); S.clip.on = true; syncClipUI(); } }, 'Centre half')),
    el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: () => cropBox(true) }, 'Extract inside → new layer'), el('button', { class: 'btn small danger', onclick: () => cropBox(false) }, 'Delete inside')));
  const s2 = el('div', { class: 'sec' }, el('h3', {}, 'Slices and sections'), fieldRow('Thickness (m)', thick),
    el('div', { class: 'row' },
      el('button', { class: 'btn small', onclick: () => sliceAt('z') }, 'Horizontal slice at point'),
      el('button', { class: 'btn small', onclick: () => sliceAt('x') }, 'E slice'),
      el('button', { class: 'btn small', onclick: () => sliceAt('y') }, 'N slice')),
    el('div', { class: 'row' }, el('button', { class: 'btn small primary', onclick: sectionMode }, 'Vertical section A → B')),
    el('div', { class: 'note' }, 'Slices set the clipping box around a clicked point. A vertical section collects points within half the thickness of the line A→B and plots the profile below.'));
  p.append(s1, s2);
  if (S.section) {
    const sc = S.section;
    const cv = el('canvas', { class: 'profile', id: 'profileCv' });
    const s3 = el('div', { class: 'sec' }, el('h3', {}, 'Section profile'), el('dl', { class: 'kv' }, el('dt', {}, 'Length'), el('dd', {}, fm(sc.len, 3) + ' m'), el('dt', {}, 'Points'), el('dd', {}, sc.n.toLocaleString()), el('dt', {}, 'Z range'), el('dd', {}, fm(sc.zmin + o[2]) + ' – ' + fm(sc.zmax + o[2]))), cv,
      el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: () => exportSection('dxf2d') }, 'DXF profile (chainage, Z)'), el('button', { class: 'btn small', onclick: () => exportSection('dxf3d') }, 'DXF 3D points'), el('button', { class: 'btn small', onclick: () => exportSection('csv') }, 'CSV')));
    p.append(s3); requestAnimationFrame(() => drawProfile(cv, sc));
  }
}
function insideBoxIdx(L, inside) {
  const b = S.clip.box, P = L.pos, out = []; for (let i = 0; i < L.n; i++) { const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2]; const isIn = x >= b.min.x && x <= b.max.x && y >= b.min.y && y <= b.max.y && z >= b.min.z && z <= b.max.z; if (isIn === inside) out.push(i); } return Uint32Array.from(out);
}
function cropBox(extract) {
  const L = needCloud(); if (!L) return; if (S.clip.box.isEmpty()) { toast('Set the clipping box first.'); return; }
  if (extract) { const idx = insideBoxIdx(L, true); if (!idx.length) { toast('No points inside the box.'); return; } subsetCloud(L, idx, L.name + ' (box)'); toast('Extracted ' + idx.length.toLocaleString() + ' points.'); }
  else { const idx = insideBoxIdx(L, false); const rem = L.n - idx.length; replaceWithSubset(L, idx); toast('Deleted ' + rem.toLocaleString() + ' points from ' + L.name + '.'); }
  S.clip.on = false; syncClipUI();
}
function sliceAt(axis) {
  startMode({ type: 'slice', text: 'Click a point to centre the ' + (axis === 'z' ? 'horizontal' : axis === 'x' ? 'E' : 'N') + ' slice', onPick: pk => {
    const t = (S.secThick || 0.1) / 2; const all = sceneBox(); S.clip.box.copy(all);
    S.clip.box.min[axis] = pk.p[axis] - t; S.clip.box.max[axis] = pk.p[axis] + t; S.clip.on = true; cancelMode(); syncClipUI();
    if (axis === 'z') setView('top'); else { S.cam.yaw = axis === 'x' ? 0 : -Math.PI / 2; S.cam.pitch = 0; if (!S.cam.ortho) toggleOrtho(); updateCamera(); }
  } });
}
function sectionMode() {
  startMode({ type: 'section', text: 'Click point A, then point B', onPick: pk => {
    S.mode.pts.push(pk.p); refreshModeGraphics();
    if (S.mode.pts.length === 2) { const [a, b] = S.mode.pts; cancelMode(); buildSectionProfile(a, b); }
  } });
}
function buildSectionProfile(a, b) {
  const t = (S.secThick || 0.1) / 2; const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
  if (len < 1e-6) { toast('A and B are at the same plan position. Pick two points apart.'); return; }
  const ux = dx / len, uy = dy / len; const st = [], zs = [], pts = [];
  for (const L of S.layers) {
    if (!L.visible || L.kind !== 'cloud') continue;
    for (let i = 0; i < L.n; i++) {
      const px = L.pos[i * 3] - a.x, py = L.pos[i * 3 + 1] - a.y; const s = px * ux + py * uy; if (s < 0 || s > len) continue;
      const off = -px * uy + py * ux; if (Math.abs(off) > t) continue;
      st.push(s); zs.push(L.pos[i * 3 + 2]); pts.push(L.pos[i * 3], L.pos[i * 3 + 1], L.pos[i * 3 + 2]);
    }
  }
  if (!st.length) { toast('No points within the section thickness. Increase the thickness.'); return; }
  let zmin = Infinity, zmax = -Infinity; for (const z of zs) { if (z < zmin) zmin = z; if (z > zmax) zmax = z; }
  if (S.secObj) annot.remove(S.secObj);
  const zt = zmax, zb = zmin; const c = [new THREE.Vector3(a.x, a.y, zb), new THREE.Vector3(b.x, b.y, zb), new THREE.Vector3(b.x, b.y, zt), new THREE.Vector3(a.x, a.y, zt)];
  S.secObj = lineObj(c, true, 0x33ccff); annot.add(S.secObj);
  S.section = { a: a.clone(), b: b.clone(), len, st: Float32Array.from(st), z: Float32Array.from(zs), pts: Float32Array.from(pts), n: st.length, zmin, zmax };
  $$('.tab').find(x => x.dataset.tab === 'section').click(); buildSection(); S.dirty = true;
}
function drawProfile(cv, sc) {
  const pr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight; cv.width = w * pr; cv.height = h * pr;
  const g = cv.getContext('2d'); g.scale(pr, pr); g.clearRect(0, 0, w, h);
  const pad = 26, zr = (sc.zmax - sc.zmin) || 1, sx = (w - pad - 8) / sc.len, sz = (h - pad - 8) / zr; const s = Math.min(sx, sz * 4) /* allow vertical exaggeration up to 4x */;
  const kx = sx, kz = Math.min(sz, sx * 10);
  g.strokeStyle = cssVar('--line'); g.fillStyle = cssVar('--muted'); g.font = '10px IBM Plex Mono, monospace';
  g.beginPath(); g.moveTo(pad, 4); g.lineTo(pad, h - pad + 4); g.lineTo(w - 4, h - pad + 4); g.stroke();
  g.fillText(fm(sc.zmax + S.origin[2], 2), 2, 12); g.fillText(fm(sc.zmin + S.origin[2], 2), 2, h - pad); g.fillText('0', pad, h - 8); g.textAlign = 'right'; g.fillText(fm(sc.len, 2) + ' m', w - 4, h - 8);
  g.fillStyle = cssVar('--accent');
  const step = Math.max(1, Math.floor(sc.n / 60000));
  for (let i = 0; i < sc.n; i += step) g.fillRect(pad + sc.st[i] * kx, h - pad - (sc.z[i] - sc.zmin) * kz, 1.2, 1.2);
  if (kz / kx > 1.05) { g.textAlign = 'right'; g.fillStyle = cssVar('--muted'); g.fillText('vertical × ' + (kz / kx).toFixed(1), w - 4, 12); }
}
function exportSection(kind) {
  const sc = S.section; if (!sc) return; const o = S.origin;
  if (kind === 'csv') { let s = 'chainage,E,N,Z\n'; for (let i = 0; i < sc.n; i++) s += sc.st[i].toFixed(4) + ',' + (sc.pts[i * 3] + o[0]).toFixed(4) + ',' + (sc.pts[i * 3 + 1] + o[1]).toFixed(4) + ',' + (sc.pts[i * 3 + 2] + o[2]).toFixed(4) + '\n'; saveFile('section.csv', s); return; }
  const E = [];
  if (kind === 'dxf2d') {
    for (let i = 0; i < sc.n; i++) E.push({ type: 'POINT', p: [sc.st[i], sc.z[i] + o[2], 0], layer: 'SECTION_POINTS' });
    // binned upper envelope as polyline (useful for terrain / slab tops)
    const bins = Math.max(2, Math.min(2000, Math.round(sc.len / Math.max(0.01, (S.secThick || 0.1))))); const top = new Float32Array(bins).fill(NaN);
    for (let i = 0; i < sc.n; i++) { const k = Math.min(bins - 1, Math.floor(sc.st[i] / sc.len * bins)); if (!(sc.z[i] <= top[k])) top[k] = sc.z[i]; }
    const pl = []; for (let k = 0; k < bins; k++) if (!isNaN(top[k])) pl.push([(k + 0.5) / bins * sc.len, top[k] + o[2], 0]);
    if (pl.length > 1) E.push({ type: 'POLY', pts: pl, layer: 'SECTION_TOP' });
    E.push({ type: 'TEXT', p: [0, sc.zmax + o[2] + 0.2, 0], h: 0.15, text: 'Section A ' + W3(sc.a).map(v => v.toFixed(3)).join(' ') + '  B ' + W3(sc.b).map(v => v.toFixed(3)).join(' '), layer: 'SECTION_TEXT' });
  } else for (let i = 0; i < sc.n; i++) E.push({ type: 'POINT', p: [sc.pts[i * 3] + o[0], sc.pts[i * 3 + 1] + o[1], sc.pts[i * 3 + 2] + o[2]], layer: 'SECTION_POINTS' });
  saveFile(kind === 'dxf2d' ? 'section-profile.dxf' : 'section-3d.dxf', IO.writeDXF(E));
}

// ---------- EDIT ----------
function buildEdit() {
  const p = pane('edit'); if (!p) return; p.textContent = '';
  const L = S.sel && S.sel.kind === 'cloud' ? S.sel : null;
  const tgt = el('div', { class: 'note' }, 'Working on: ', el('b', {}, S.sel ? S.sel.name : 'no layer selected'));
  const lassoS = el('div', { class: 'sec' }, el('h3', {}, 'Segment with lasso'), tgt,
    el('div', { class: 'note' }, 'Click around the area to make a polygon (or drag freehand), then press Enter. The polygon is taken from the current view.'),
    el('div', { class: 'row' }, el('button', { class: 'btn small primary', onclick: () => lassoMode(false, true) }, 'Draw box'), el('button', { class: 'btn small', onclick: () => lassoMode(false) }, 'Click polygon'), el('button', { class: 'btn small', onclick: () => lassoMode(true) }, 'Freehand')),
    el('div', { class: 'row' },
      el('button', { class: 'btn small', disabled: !S.lasso, onclick: () => applyLasso('extract') }, 'Extract inside → new layer'),
      el('button', { class: 'btn small danger', disabled: !S.lasso, onclick: () => applyLasso('delIn') }, 'Delete inside'),
      el('button', { class: 'btn small danger', disabled: !S.lasso, onclick: () => applyLasso('delOut') }, 'Delete outside')),
    el('div', { class: 'row' }, el('span', { class: 'hint' }, 'Export just this section:'), (() => { const f = el('select', { id: 'secFmt', style: 'width:auto', 'aria-label': 'Format' }, el('option', { value: 'las' }, 'LAS'), el('option', { value: 'ply' }, 'PLY'), el('option', { value: 'csv' }, 'CSV')); return f; })(),
      el('button', { class: 'btn small primary', disabled: !S.lasso, onclick: () => applyLasso('export') }, 'Export'), el('button', { class: 'btn small', disabled: !S.lasso, onclick: () => applyLasso('clip') }, 'Clip to it')),
    el('div', { class: 'hint' }, 'Tip: the box is taken through the current view, so draw it in Top view for a plan section, or a side view for a slice. Turn the clipping box on to limit the depth.'));
  const sp = numIn('subSp', S.subSp || 0.01), rc = numIn('subN', S.subN || 1000000, '1');
  const subS = el('div', { class: 'sec' }, el('h3', {}, 'Subsample'), fieldRow('Min spacing (m)', sp),
    el('div', { class: 'row' }, el('button', { class: 'btn small', disabled: !L, onclick: () => { S.subSp = +sp.value; subsample('space', +sp.value); } }, 'Spatial → new layer')),
    fieldRow('Point count', rc), el('div', { class: 'row' }, el('button', { class: 'btn small', disabled: !L, onclick: () => { S.subN = +rc.value; subsample('random', +rc.value); } }, 'Random → new layer')));
  const nr = numIn('noiseR', S.noiseR || 0.05), nn = numIn('noiseN', S.noiseN || 4, '1');
  const noiseS = el('div', { class: 'sec' }, el('h3', {}, 'Noise filter'), el('div', { class: 'note' }, 'Removes isolated points: a point is kept when it has at least the given number of neighbours inside the radius. Good for mixed pixels, people and dust.'),
    fieldRow('Radius (m)', nr), fieldRow('Min neighbours', nn), el('div', { class: 'row' }, el('button', { class: 'btn small', disabled: !L, onclick: () => { S.noiseR = +nr.value; S.noiseN = +nn.value; noiseFilter(); } }, 'Filter → new layer')));
  const gc = numIn('gCell', S.gCell || 1), gh = numIn('gH', S.gH || 0.15);
  const groundS = el('div', { class: 'sec' }, el('h3', {}, 'Ground classification'), el('div', { class: 'note' }, 'Lowest-surface filter: points within the height tolerance of the local ground surface become class 2 (ground), the rest class 1. Use a cell larger than cars or bushes.'),
    fieldRow('Cell size (m)', gc), fieldRow('Height tolerance (m)', gh), el('div', { class: 'row' }, el('button', { class: 'btn small', disabled: !L, onclick: () => { S.gCell = +gc.value; S.gH = +gh.value; groundClassify(); } }, 'Classify')));
  const tx = numIn('trX', 0), ty = numIn('trY', 0), tz = numIn('trZ', 0), rz = numIn('trRz', 0), scl = numIn('trS', 1);
  const trS = el('div', { class: 'sec' }, el('h3', {}, 'Transform layer'), el('div', { class: 'note' }, 'Shift, rotate about a vertical axis through the layer centre, and scale (scale is applied about the centre too). Works on clouds and meshes.'),
    el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:6px' }, labeled('ΔE', tx), labeled('ΔN', ty), labeled('ΔZ', tz)),
    el('div', { style: 'display:grid;grid-template-columns:repeat(2,1fr);gap:6px' }, labeled('Rotate Z (°)', rz), labeled('Scale', scl)),
    el('div', { class: 'row' }, el('button', { class: 'btn small', disabled: !S.sel, onclick: () => transformLayer(+tx.value, +ty.value, +tz.value, +rz.value, +scl.value) }, 'Apply'),
      el('button', { class: 'btn small', disabled: !S.undo, onclick: undoTransform }, 'Undo last transform')));
  p.append(lassoS, subS, noiseS, groundS, trS);
}
function labeled(t, inp) { return el('label', { style: 'display:grid;gap:3px;font-size:11px;color:var(--muted)' }, t, inp); }
function lassoMode(freehand, rect) {
  if (!needCloud()) return; S.lasso = null;
  startMode({ type: 'lasso', freehand: freehand || rect, rect: !!rect, finishable: true, dblFinish: !freehand && !rect, text: rect ? 'Drag a box around the section' : freehand ? 'Drag around the area' : 'Click polygon corners · Enter or double-click to close',
    onFinish: m => { if (m.pts.length < 3) { toast('Lasso needs at least three corners.'); return false; }
      const cam = curCam(); cam.updateMatrixWorld(); const M = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      const r = vp.getBoundingClientRect(); S.lasso = { pts: m.pts.slice(), show: true, M: M.elements.slice(), rect: { l: r.left, t: r.top, w: r.width, h: r.height } };
      setTimeout(() => { buildEdit(); $$('.tab').find(x => x.dataset.tab === 'edit').click(); toast('Lasso ready. Choose Extract or Delete in the Edit panel.'); }, 0); } });
}
function applyLasso(action) {
  const L = needCloud(); if (!L || !S.lasso) return;
  const { M: e, pts, rect } = S.lasso; const poly = pts.map(p => [p[0] - rect.l, p[1] - rect.t]);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of poly) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  const inside = new Uint8Array(L.n); const P = L.pos, clip = S.clip.on, b = S.clip.box;
  for (let i = 0; i < L.n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    if (clip && (x < b.min.x || y < b.min.y || z < b.min.z || x > b.max.x || y > b.max.y || z > b.max.z)) continue;
    const cw = e[3] * x + e[7] * y + e[11] * z + e[15]; if (cw <= 0) continue;
    const sx = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / cw * 0.5 + 0.5) * rect.w, sy = (0.5 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw * 0.5) * rect.h;
    if (sx < x0 || sx > x1 || sy < y0 || sy > y1) continue;
    let c = false; for (let a = 0, bb = poly.length - 1; a < poly.length; bb = a++) { const pa = poly[a], pb = poly[bb]; if (((pa[1] > sy) !== (pb[1] > sy)) && (sx < (pb[0] - pa[0]) * (sy - pa[1]) / (pb[1] - pa[1]) + pa[0])) c = !c; }
    if (c) inside[i] = 1;
  }
  const pick = want => { const o = []; for (let i = 0; i < L.n; i++) if (inside[i] === want) o.push(i); return Uint32Array.from(o); };
  const inIdx = pick(1);
  if (!inIdx.length) { toast('No points of ' + L.name + ' fall inside the lasso.'); return; }
  if (action === 'export') { const f = ($('#secFmt') || {}).value || 'las'; exportCloud(subsetView(L, inIdx, L.name + ' section'), f); S.lasso = null; drawOverlay(); buildEdit(); return; }
  if (action === 'clip') { const bb = new THREE.Box3(); for (const i of inIdx) bb.expandByPoint(new THREE.Vector3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2])); S.clip.box.copy(bb); S.clip.on = true; syncClipUI(); S.lasso = null; drawOverlay(); buildEdit(); toast('Clipping box set to the section (' + inIdx.length.toLocaleString() + ' points).'); return; }
  if (action === 'extract') subsetCloud(L, inIdx, L.name + ' (segment)');
  else if (action === 'delIn') replaceWithSubset(L, pick(0));
  else replaceWithSubset(L, inIdx);
  toast((action === 'extract' ? 'Extracted ' : action === 'delIn' ? 'Deleted ' : 'Kept ') + inIdx.length.toLocaleString() + ' points.');
  S.lasso = null; drawOverlay(); buildEdit();
}
async function subsample(kind, v) {
  const L = needCloud(); if (!L) return;
  const idx = await busy('Subsampling…', async () => kind === 'space' ? AL.voxelSubsample(L.pos, L.n, Math.max(1e-4, v)) : AL.randomSubsample(L.n, Math.max(1, Math.floor(v))));
  if (!idx) return; subsetCloud(L, idx, L.name + (kind === 'space' ? ' (' + v + ' m)' : ' (' + fmtN(idx.length) + ')'));
  toast('New layer: ' + idx.length.toLocaleString() + ' of ' + L.n.toLocaleString() + ' points.');
}
async function noiseFilter() {
  const L = needCloud(); if (!L) return;
  const keep = await busy('Filtering noise…', onP => AL.radiusOutliers(L.pos, L.n, S.noiseR, S.noiseN, onP)); if (!keep) return;
  const idx = []; for (let i = 0; i < L.n; i++) if (keep[i]) idx.push(i);
  subsetCloud(L, Uint32Array.from(idx), L.name + ' (filtered)'); toast('Removed ' + (L.n - idx.length).toLocaleString() + ' isolated points. The original layer is hidden.'); L.visible = false; L.obj.visible = false; refreshLayers();
}
async function groundClassify() {
  const L = needCloud(); if (!L) return;
  const g = await busy('Classifying ground…', async () => AL.groundFilter(L.pos, L.n, S.gCell, S.gH)); if (!g) return;
  if (!L.cls) L.cls = new Uint8Array(L.n); let c = 0; for (let i = 0; i < L.n; i++) { L.cls[i] = g[i] ? 2 : 1; c += g[i]; }
  L.colorMode = 'class'; colorize(L); refreshProps(); toast(c.toLocaleString() + ' ground points (' + (c / L.n * 100).toFixed(1) + '%).');
}
function transformLayer(dx, dy, dz, rzDeg, sc) {
  const L = S.sel; if (!L) return; const P = L.kind === 'cloud' ? L.pos : L.tris, m = L.kind === 'cloud' ? L.n * 3 : P.length;
  S.undo = { L, data: P.slice(0, m) };
  const c = L.box.getCenter(new THREE.Vector3()); const a = rzDeg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  for (let i = 0; i < m; i += 3) { const x = (P[i] - c.x) * sc, y = (P[i + 1] - c.y) * sc, z = (P[i + 2] - c.z) * sc; P[i] = c.x + ca * x - sa * y + dx; P[i + 1] = c.y + sa * x + ca * y + dy; P[i + 2] = c.z + z + dz; }
  posChanged(L); buildEdit(); buildRegister(); toast('Transformed ' + L.name + '.');
}
function undoTransform() { const u = S.undo; if (!u || !S.layers.includes(u.L)) return; const P = u.L.kind === 'cloud' ? u.L.pos : u.L.tris; P.set(u.data); posChanged(u.L); S.undo = null; buildEdit(); buildRegister(); toast('Undid the last transform of ' + u.L.name + '.'); }
function applyRigid(L, T) { const P = L.kind === 'cloud' ? L.pos : L.tris, m = L.kind === 'cloud' ? L.n : P.length / 3; S.undo = { L, data: P.slice(0, m * 3) }; AL.applyRT(P, m, T); posChanged(L); }

// ---------- COMPARE ----------
function buildCompare() {
  const p = pane('compare'); if (!p) return; p.textContent = '';
  const L = S.sel && S.sel.kind === 'cloud' ? S.sel : null;
  const refC = layerSelect('c2cRef', clouds().filter(x => x !== L), clouds().find(x => x !== L && x.id === S.c2cRef));
  const md = numIn('c2cMax', S.c2cMax || 0.1);
  const c2cS = el('div', { class: 'sec' }, el('h3', {}, 'Cloud to cloud'), el('div', { class: 'note' }, 'Nearest-neighbour distance from each point of ', el('b', {}, L ? L.name : 'the selected cloud'), ' to the reference cloud. Use it for change detection between two scans.'),
    fieldRow('Reference', refC), fieldRow('Max distance (m)', md),
    el('div', { class: 'row' }, el('button', { class: 'btn small primary', disabled: !L || !refC.options.length, onclick: () => { S.c2cRef = +refC.value; S.c2cMax = +md.value; runC2C(L, byId(refC.value), +md.value); } }, 'Compute')));
  const refM = layerSelect('c2mRef', meshes(), meshes().find(x => x.id === S.c2mRef));
  const mmx = numIn('c2mMax', S.c2mMax || 0.1); const sg = el('input', { type: 'checkbox', id: 'c2mSigned' }); sg.checked = S.c2mSigned !== false;
  const c2mS = el('div', { class: 'sec' }, el('h3', {}, 'Cloud to design (mesh)'), el('div', { class: 'note' }, 'Signed distance from each scan point to the nearest design surface. Positive is on the side the triangle normals face. Load the design as STL, OBJ or PLY (set mesh units in Load first).'),
    fieldRow('Design mesh', refM), fieldRow('Max distance (m)', mmx), el('div', { class: 'field' }, el('label', { for: 'c2mSigned' }, 'Signed'), el('span', {}, sg)),
    el('div', { class: 'row' }, el('button', { class: 'btn small primary', disabled: !L || !refM.options.length, onclick: () => { S.c2mRef = +refM.value; S.c2mMax = +mmx.value; S.c2mSigned = sg.checked; runC2M(L, byId(refM.value), +mmx.value, sg.checked); } }, 'Compute')));
  const datum = numIn('datumZ', S.datumZ !== undefined ? S.datumZ : '', 'any', { placeholder: 'Z of datum' });
  const planeS = el('div', { class: 'sec' }, el('h3', {}, 'Flatness and level'), el('div', { class: 'note' }, 'Fit a best-fit plane to the selected cloud (only points inside the clipping box when it is on) and colour every point by its deviation. Or colour by height above a fixed datum level.'),
    el('div', { class: 'row' }, el('button', { class: 'btn small primary', disabled: !L, onclick: () => runPlane(L) }, 'Fit plane & colour deviation')),
    fieldRow('Datum Z', datum),
    el('div', { class: 'row' }, el('button', { class: 'btn small', disabled: !L, onclick: () => { S.datumZ = +datum.value; runDatum(L, +datum.value); } }, 'Height above datum'), el('button', { class: 'btn small', disabled: !L, onclick: () => pickDatum(datum) }, 'Pick datum point')));
  if (S.plane && S.plane.layer === L) {
    const pl = S.plane.fit, o = S.origin;
    planeS.append(el('div', { class: 'result' }, el('dl', { class: 'kv' },
      el('dt', {}, 'Points used'), el('dd', {}, pl.n.toLocaleString()), el('dt', {}, 'RMS'), el('dd', {}, mm(pl.rms)), el('dt', {}, 'Peak to valley'), el('dd', {}, mm(pl.max - pl.min)),
      el('dt', {}, 'Tilt from level'), el('dd', {}, pl.dipDeg.toFixed(4) + '°  (' + (Math.tan(pl.dipDeg * Math.PI / 180) * 1000).toFixed(2) + ' mm/m)'),
      el('dt', {}, 'Normal'), el('dd', {}, pl.normal.map(v => v.toFixed(5)).join(', ')), el('dt', {}, 'Centroid'), el('dd', {}, pl.centroid.map((v, k) => (v + o[k]).toFixed(3)).join(', ')))));
  }
  p.append(c2cS, c2mS, planeS);
  if (L && L.sf && L.sfs[L.sf]) p.append(resultSec(L));
}
function resultSec(L) {
  const st = L.sfStyle[L.sf], s = st.stats; const v = L.sfs[L.sf];
  let within = 0; for (let i = 0; i < L.n; i++) if (Math.abs(v[i]) <= st.tol) within++;
  const tol = numIn('resTol', st.tol); tol.addEventListener('change', () => { st.tol = Math.abs(+tol.value); colorize(L); buildCompare(); refreshProps(); });
  const cv = el('canvas', { class: 'hist', id: 'histCv' });
  const sec = el('div', { class: 'sec' }, el('h3', {}, 'Result: ' + L.sf, el('button', { class: 'btn small', onclick: () => exportReport(L) }, 'Report CSV')),
    el('dl', { class: 'kv' },
      el('dt', {}, 'Points measured'), el('dd', {}, s.count.toLocaleString() + (s.invalid ? '  (' + s.invalid.toLocaleString() + ' beyond max)' : '')),
      el('dt', {}, 'Mean'), el('dd', {}, mm(s.mean)), el('dt', {}, 'Std deviation'), el('dd', {}, mm(s.std)), el('dt', {}, 'RMS'), el('dd', {}, mm(s.rms)),
      el('dt', {}, 'Min / max'), el('dd', {}, mm(s.min) + ' / ' + mm(s.max))),
    fieldRow('Tolerance ± (m)', tol),
    el('div', { class: 'result' }, el('div', { class: 'row', style: 'justify-content:space-between' }, el('span', {}, 'Within ±' + (st.tol * 1000).toFixed(1) + ' mm'), el('b', { class: 'mono', style: 'font-size:16px;color:' + (within / s.count > 0.95 ? 'var(--good)' : within / s.count > 0.8 ? 'var(--warn)' : 'var(--bad)') }, (within / Math.max(1, s.count) * 100).toFixed(1) + '%'))),
    cv, el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: () => { st.ramp = 'tol'; colorize(L); refreshProps(); buildCompare(); } }, 'Show tolerance bands'), el('button', { class: 'btn small', onclick: () => { st.ramp = st.signed ? 'bgr' : 'bgr'; colorize(L); refreshProps(); buildCompare(); } }, 'Show gradient')));
  requestAnimationFrame(() => drawHist(cv, L));
  return sec;
}
function drawHist(cv, L) {
  const st = L.sfStyle[L.sf], v = L.sfs[L.sf]; const pr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight; if (!w) return; cv.width = w * pr; cv.height = h * pr;
  const g = cv.getContext('2d'); g.scale(pr, pr);
  const bins = 60, lo = st.lo, hi = st.hi, hist = AL.histogram(v, L.n, lo, hi, bins); let mx = 0; for (const c of hist) if (c > mx) mx = c;
  const bw = (w - 8) / bins, tmp = [0, 0, 0];
  for (let k = 0; k < bins; k++) {
    const x = lo + (k + 0.5) / bins * (hi - lo);
    if (st.ramp === 'tol') { const q = x < -st.tol ? [40, 70, 190] : x > st.tol ? [215, 45, 35] : [60, 200, 90]; tmp[0] = q[0]; tmp[1] = q[1]; tmp[2] = q[2]; } else rampAt((k + 0.5) / bins, st.ramp, tmp, 0);
    g.fillStyle = 'rgb(' + tmp.map(Math.round).join(',') + ')'; const bh = hist[k] / (mx || 1) * (h - 22); g.fillRect(4 + k * bw, h - 16 - bh, Math.max(1, bw - 1), bh);
  }
  g.fillStyle = cssVar('--muted'); g.font = '10px IBM Plex Mono, monospace'; g.fillText((lo * 1000).toFixed(1) + ' mm', 4, h - 4); g.textAlign = 'right'; g.fillText((hi * 1000).toFixed(1) + ' mm', w - 4, h - 4);
  if (lo < 0 && hi > 0) { const zx = 4 + (-lo) / (hi - lo) * (w - 8); g.strokeStyle = cssVar('--fg'); g.globalAlpha = 0.4; g.beginPath(); g.moveTo(zx, 2); g.lineTo(zx, h - 16); g.stroke(); g.globalAlpha = 1; }
}
async function runC2C(L, R, maxD) {
  if (!R) { toast('Pick a reference cloud.', true); return; }
  const d = await busy('Cloud-to-cloud distances…', onP => AL.c2c(L.pos, L.n, R.pos, R.n, { maxDist: maxD, onProgress: onP })); if (!d) return;
  addSF(L, 'C2C to ' + R.name, d, false); refreshProps(); buildCompare(); $$('.tab').find(x => x.dataset.tab === 'compare').click();
}
async function runC2M(L, M, maxD, signed) {
  if (!M) { toast('Load a design mesh first.', true); return; }
  const d = await busy('Distances to design…', onP => AL.c2m(L.pos, L.n, M.tris, { maxDist: maxD, signed, onProgress: onP })); if (!d) return;
  const nm = (signed ? 'Deviation from ' : 'Distance to ') + M.name; addSF(L, nm, d, signed); L.sfStyle[nm].tol = L.sfStyle[nm].tol || 0.01; refreshProps(); buildCompare(); $$('.tab').find(x => x.dataset.tab === 'compare').click();
}
function runPlane(L) {
  let idx = null; if (S.clip.on) { idx = insideBoxIdx(L, true); if (idx.length < 3) { toast('Fewer than 3 points inside the clipping box.', true); return; } }
  const fit = AL.fitPlane(L.pos, idx); S.plane = { layer: L, fit };
  addSF(L, 'Plane deviation', AL.planeDistances(L.pos, L.n, fit), true); refreshProps(); buildCompare();
}
function runDatum(L, z) { if (!isFinite(z)) { toast('Enter a datum Z or pick a point.', true); return; } const d = new Float32Array(L.n), zl = z - S.origin[2]; for (let i = 0; i < L.n; i++) d[i] = L.pos[i * 3 + 2] - zl; addSF(L, 'Height above ' + z.toFixed(3), d, true); refreshProps(); buildCompare(); }
function pickDatum(inp) { startMode({ type: 'datum', text: 'Click the datum point', onPick: pk => { const z = pk.p.z + S.origin[2]; S.datumZ = +z.toFixed(4); cancelMode(); buildCompare(); toast('Datum Z = ' + z.toFixed(4)); } }); }
function exportReport(L) {
  const st = L.sfStyle[L.sf], s = st.stats, v = L.sfs[L.sf]; let within = 0; for (let i = 0; i < L.n; i++) if (Math.abs(v[i]) <= st.tol) within++;
  let r = 'ScanBench deviation report\nLayer,' + L.name + '\nField,' + L.sf + '\nDate,' + new Date().toISOString() + '\n\nStatistic,Value (m)\n';
  r += 'Points measured,' + s.count + '\nBeyond max distance,' + s.invalid + '\nMean,' + s.mean.toFixed(6) + '\nStd deviation,' + s.std.toFixed(6) + '\nRMS,' + s.rms.toFixed(6) + '\nMin,' + s.min.toFixed(6) + '\nMax,' + s.max.toFixed(6) + '\nTolerance (±),' + st.tol + '\nWithin tolerance (%),' + (within / Math.max(1, s.count) * 100).toFixed(2) + '\n\nBin from (m),Bin to (m),Count\n';
  const bins = 40, h = AL.histogram(v, L.n, st.lo, st.hi, bins); for (let k = 0; k < bins; k++) r += (st.lo + k / bins * (st.hi - st.lo)).toFixed(5) + ',' + (st.lo + (k + 1) / bins * (st.hi - st.lo)).toFixed(5) + ',' + h[k] + '\n';
  saveFile('deviation-report.csv', r);
}

// ---------- REGISTER ----------
function buildRegister() {
  const p = pane('register'); if (!p) return; p.textContent = '';
  const L = S.sel;
  const ref = layerSelect('icpRef', clouds().filter(x => x !== L), clouds().find(x => x !== L && x.id === S.icpRef));
  const md = numIn('icpMax', S.icpMax || 0.5), smp = numIn('icpS', S.icpS || 50000, '1000'), ovl = numIn('icpO', S.icpO || 90, '1', { min: 10, max: 100 }), its = numIn('icpI', S.icpI || 40, '1');
  const icpS = el('div', { class: 'sec' }, el('h3', {}, 'Fine alignment (ICP)'),
    el('div', { class: 'note' }, 'Moves ', el('b', {}, L && L.kind === 'cloud' ? L.name : 'the selected cloud'), ' onto the reference. Start from a rough alignment (within the search distance), for example after point pairs.'),
    fieldRow('Reference', ref), fieldRow('Search distance (m)', md), fieldRow('Sample points', smp), fieldRow('Overlap %', ovl), fieldRow('Max iterations', its),
    el('div', { class: 'row' }, el('button', { class: 'btn small primary', disabled: !(L && L.kind === 'cloud') || !ref.options.length, onclick: () => { Object.assign(S, { icpRef: +ref.value, icpMax: +md.value, icpS: +smp.value, icpO: +ovl.value, icpI: +its.value }); runICP(L, byId(ref.value)); } }, 'Align'),
      el('button', { class: 'btn small', disabled: !S.undo, onclick: undoTransform }, 'Undo')));
  if (S.icpRes) icpS.append(rtResult(S.icpRes));
  const pairsS = el('div', { class: 'sec' }, el('h3', {}, 'Point pairs (rough alignment)'),
    el('div', { class: 'note' }, 'Pick the same feature on each cloud: first on the moving layer, then on the reference. Three or more well-spread pairs (corners, targets) give a rigid fit.'),
    el('div', { class: 'row' }, el('button', { class: 'btn small primary', disabled: !S.sel, onclick: pairMode }, 'Pick pairs'), el('button', { class: 'btn small', disabled: S.pairs.length < 3, onclick: alignPairs }, 'Align ' + (S.sel ? S.sel.name : '')), el('button', { class: 'btn small danger', disabled: !S.pairs.length, onclick: clearPairs }, 'Clear')));
  if (S.pairs.length) { const l = el('div', { class: 'mlist' }); S.pairs.forEach((pr, i) => l.append(el('div', { class: 'mitem' }, el('div', { class: 'v' }, (i + 1) + '. ', pr[1] ? 'moving → ref  ' + (pr.res !== undefined ? 'residual ' + mm(pr.res) : 'Δ ' + fm(pr[0].distanceTo(pr[1]), 3) + ' m') : 'moving picked, now click the reference'), el('span')))); pairsS.append(l); }
  if (S.pairRes) pairsS.append(rtResult(S.pairRes));
  p.append(pairsS, icpS);
}
function rtResult(r) {
  const R = r.T.R, t = r.T.t; const rz = Math.atan2(R[3], R[0]) * 180 / Math.PI;
  return el('div', { class: 'result' }, el('dl', { class: 'kv' }, el('dt', {}, 'RMS'), el('dd', {}, mm(r.rms)), ...(r.pairs ? [el('dt', {}, 'Pairs used'), el('dd', {}, r.pairs.toLocaleString())] : []), ...(r.iterations ? [el('dt', {}, 'Iterations'), el('dd', {}, String(r.iterations))] : []),
    el('dt', {}, 'Shift (E, N, Z)'), el('dd', {}, t.map(v => v.toFixed(4)).join(', ')), el('dt', {}, 'Rotation about Z'), el('dd', {}, rz.toFixed(4) + '°')),
    el('div', { class: 'mono hint' }, 'Matrix (local origin)'), el('div', { class: 'mono', style: 'font-size:11px;line-height:1.5' }, [0, 1, 2].map(i => el('div', {}, [R[i * 3], R[i * 3 + 1], R[i * 3 + 2], t[i]].map(v => v.toFixed(6).padStart(12)).join(' ')))));
}
async function runICP(L, R) {
  if (!R) return;
  const res = await busy('Aligning (ICP)…', onP => AL.icp(L.pos, L.n, R.pos, R.n, { maxDist: S.icpMax, sample: S.icpS, overlap: S.icpO / 100, iterations: S.icpI, onProgress: onP }));
  if (!res) return; applyRigid(L, res.T); S.icpRes = res; buildRegister(); toast('Aligned ' + L.name + ' to ' + R.name + ': RMS ' + mm(res.rms) + '.');
}
function pairMode() {
  const mov = S.sel; S.pairMov = mov;
  startMode({ type: 'pairs', finishable: true, text: 'Click a feature on ' + mov.name, onPick: pk => {
    const last = S.pairs[S.pairs.length - 1];
    if (!last || last[1]) { if (pk.layer !== mov) { toast('First pick of each pair goes on ' + mov.name + '.'); return; } S.pairs.push([pk.p.clone(), null]); setModeText('Now click the same feature on the reference'); }
    else { if (pk.layer === mov) { toast('Second pick goes on the reference layer, not ' + mov.name + '.'); return; } last[1] = pk.p.clone(); setModeText('Pair ' + S.pairs.length + ' set · next pair on ' + mov.name + ', or Finish'); }
    drawPairs(); buildRegister();
  }, onFinish: () => { if (S.pairs.length && !S.pairs[S.pairs.length - 1][1]) S.pairs.pop(); drawPairs(); buildRegister(); } });
}
function drawPairs() {
  if (S.pairObj) annot.remove(S.pairObj); (S.pairLabels || []).forEach(removeLabel); S.pairLabels = [];
  const g = new THREE.Group();
  S.pairs.forEach((pr, i) => { g.add(lineObj(pr[1] ? [pr[0], pr[1]] : [pr[0]], false, 0x33ccff)); S.pairLabels.push(addLabel(pr[0], String(i + 1) + 'm')); if (pr[1]) S.pairLabels.push(addLabel(pr[1], String(i + 1) + 'r')); });
  S.pairObj = g; annot.add(g); S.dirty = true;
}
function clearPairs() { S.pairs = []; S.pairRes = null; drawPairs(); buildRegister(); }
function alignPairs() {
  const full = S.pairs.filter(p => p[1]); if (full.length < 3) { toast('Need at least three complete pairs.', true); return; }
  const mov = S.pairMov && S.layers.includes(S.pairMov) ? S.pairMov : S.sel;
  const P = full.map(p => [p[0].x, p[0].y, p[0].z]), Q = full.map(p => [p[1].x, p[1].y, p[1].z]);
  const r = AL.bestRigid(P, Q);
  full.forEach((p, i) => { const a = P[i], R = r.R; const x = R[0] * a[0] + R[1] * a[1] + R[2] * a[2] + r.t[0] - Q[i][0], y = R[3] * a[0] + R[4] * a[1] + R[5] * a[2] + r.t[1] - Q[i][1], z = R[6] * a[0] + R[7] * a[1] + R[8] * a[2] + r.t[2] - Q[i][2]; p.res = Math.hypot(x, y, z); });
  applyRigid(mov, { R: r.R, t: r.t }); S.pairRes = { T: { R: r.R, t: r.t }, rms: r.rms, pairs: full.length };
  // move the moving markers too
  full.forEach(p => { const a = p[0], R = r.R; p[0] = new THREE.Vector3(R[0] * a.x + R[1] * a.y + R[2] * a.z + r.t[0], R[3] * a.x + R[4] * a.y + R[5] * a.z + r.t[1], R[6] * a.x + R[7] * a.y + R[8] * a.z + r.t[2]); });
  drawPairs(); buildRegister(); toast('Aligned ' + mov.name + ' from ' + full.length + ' pairs: RMS ' + mm(r.rms) + '.');
}

// ---------- TERRAIN ----------
function buildTerrain() {
  const p = pane('terrain'); if (!p) return; p.textContent = '';
  p.append(el('div', { class: 'sec' }, el('h3', {}, 'Quick surface grid and volume'), el('div', { class: 'note' }, 'A simple height grid of the selected cloud for contours and cut/fill volumes, without ground classification.')));
  const L = S.sel && S.sel.kind === 'cloud' ? S.sel : null;
  const cell = numIn('dtmCell', S.dtmCell || 0.5), meth = el('select', { id: 'dtmM' }, ...[['min', 'Lowest point'], ['mean', 'Mean'], ['max', 'Highest point']].map(([v, t]) => el('option', { value: v, selected: (S.dtmM || 'mean') === v }, t)));
  const gOnly = el('input', { type: 'checkbox', id: 'dtmG' }); gOnly.checked = !!S.dtmG;
  const s1 = el('div', { class: 'sec' }, el('h3', {}, 'Grid settings'), el('div', { class: 'note' }, 'Grids ', el('b', {}, L ? L.name : 'the selected cloud'), ' into cells. Tick ground-only after running Ground classification (Edit tab) to make a terrain model.'),
    fieldRow('Cell size (m)', cell), fieldRow('Cell value', meth), el('div', { class: 'field' }, el('label', { for: 'dtmG' }, 'Ground only'), el('span', {}, gOnly)),
    el('div', { class: 'row' }, el('button', { class: 'btn small primary', disabled: !L, onclick: () => { S.dtmCell = +cell.value; S.dtmM = meth.value; S.dtmG = gOnly.checked; makeRaster(L); } }, 'Build grid')));
  p.append(s1);
  if (S.raster) {
    const R = S.raster.R, o = S.origin; let filled = 0; for (const v of R.z) if (!isNaN(v)) filled++;
    s1.append(el('div', { class: 'result' }, el('dl', { class: 'kv' }, el('dt', {}, 'Grid'), el('dd', {}, R.nx + ' × ' + R.ny + ' cells'), el('dt', {}, 'Cells with data'), el('dd', {}, filled.toLocaleString()), el('dt', {}, 'Area covered'), el('dd', {}, (filled * R.cell * R.cell).toFixed(2) + ' m²'))),
      el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: exportGrid }, 'Grid CSV (E, N, Z)')));
    const iv = numIn('ctInt', S.ctInt || 0.25), mj = numIn('ctMaj', S.ctMaj || 5, '1');
    const s2 = el('div', { class: 'sec' }, el('h3', {}, 'Contours'), fieldRow('Interval (m)', iv), fieldRow('Major every', mj),
      el('div', { class: 'row' }, el('button', { class: 'btn small primary', onclick: () => { S.ctInt = +iv.value; S.ctMaj = +mj.value; makeContours(); } }, 'Generate'), el('button', { class: 'btn small', disabled: !S.contours, onclick: exportContours }, 'DXF'), el('button', { class: 'btn small danger', disabled: !S.contours, onclick: () => { if (S.ctObj) annot.remove(S.ctObj); S.contours = null; S.dirty = true; buildTerrain(); } }, 'Clear')));
    if (S.contours) s2.append(el('div', { class: 'note' }, S.contours.length + ' contour lines drawn in the view.'));
    const bz = numIn('volZ', S.volZ !== undefined ? S.volZ : (S.raster.zmin + o[2]).toFixed(3));
    const s3 = el('div', { class: 'sec' }, el('h3', {}, 'Volume against a level'), el('div', { class: 'note' }, 'Cut is surface above the level, fill is below. For a stockpile, set the level to its base or pick a toe point.'),
      fieldRow('Base level Z', bz), el('div', { class: 'row' }, el('button', { class: 'btn small primary', onclick: () => { S.volZ = +bz.value; S.vol = AL.volumeVsPlane(S.raster.R, S.volZ - o[2]); buildTerrain(); } }, 'Compute'),
        el('button', { class: 'btn small', onclick: () => startMode({ type: 'vol', text: 'Click the base level point', onPick: pk => { S.volZ = +(pk.p.z + o[2]).toFixed(4); cancelMode(); S.vol = AL.volumeVsPlane(S.raster.R, pk.p.z); buildTerrain(); } }) }, 'Pick level')));
    if (S.vol) s3.append(el('div', { class: 'result' }, el('dl', { class: 'kv' }, el('dt', {}, 'Cut (above)'), el('dd', {}, S.vol.cut.toFixed(3) + ' m³'), el('dt', {}, 'Fill (below)'), el('dd', {}, S.vol.fill.toFixed(3) + ' m³'), el('dt', {}, 'Net'), el('dd', {}, S.vol.net.toFixed(3) + ' m³'), el('dt', {}, 'Plan area'), el('dd', {}, S.vol.area.toFixed(2) + ' m²'))));
    p.append(s2, s3);
  }
}
async function makeRaster(L) {
  let mask = null; if (S.dtmG) { if (!L.cls) { toast('This layer has no classification. Run Ground classification first.', true); return; } mask = new Uint8Array(L.n); for (let i = 0; i < L.n; i++) mask[i] = L.cls[i] === 2 ? 1 : 0; }
  const R = await busy('Building grid…', async () => AL.fillHoles(AL.rasterize(L.pos, L.n, Math.max(0.005, S.dtmCell), S.dtmM, mask), 2)); if (!R) return;
  let zmin = Infinity; for (const v of R.z) if (v < zmin) zmin = v;
  S.raster = { R, layer: L, zmin }; S.vol = null; buildTerrain();
}
function makeContours() {
  const R = S.raster.R; const cs = AL.contours(R, Math.max(1e-3, S.ctInt), -S.origin[2]);
  if (S.ctObj) annot.remove(S.ctObj); const g = new THREE.Group();
  const maj = Math.max(1, S.ctMaj) * S.ctInt;
  for (const c of cs) {
    const isMaj = Math.abs(((c.level + S.origin[2]) / maj) - Math.round((c.level + S.origin[2]) / maj)) < 1e-6; c.major = isMaj;
    const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(c.pts.flat(), 3));
    g.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: isMaj ? 0xff8a3d : 0xffd27a })));
  }
  S.ctObj = g; annot.add(g); S.contours = cs; S.dirty = true; buildTerrain(); toast(cs.length + ' contour lines.');
}
function exportContours() {
  const o = S.origin; const E = S.contours.map(c => ({ type: 'POLY', pts: c.pts.map(p => [p[0] + o[0], p[1] + o[1], p[2] + o[2]]), layer: c.major ? 'CONTOUR_MAJOR' : 'CONTOUR_MINOR' }));
  saveFile('contours.dxf', IO.writeDXF(E));
}
function exportGrid() {
  const R = S.raster.R, o = S.origin; const parts = ['E,N,Z\n']; let s = '';
  for (let j = 0; j < R.ny; j++) for (let i = 0; i < R.nx; i++) { const z = R.z[j * R.nx + i]; if (isNaN(z)) continue; s += (R.x0 + (i + 0.5) * R.cell + o[0]).toFixed(3) + ',' + (R.y0 + (j + 0.5) * R.cell + o[1]).toFixed(3) + ',' + (z + o[2]).toFixed(4) + '\n'; if (s.length > 1 << 20) { parts.push(s); s = ''; } }
  parts.push(s); saveFile('surface-grid.csv', parts);
}

// ---------- sample data (synthetic) ----------
function makeSample() {
  let seed = 42; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647; const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const O = [384200, 6461300, 18]; const Wd = 12, D = 8, Ht = 3; const pts = [], col = [], it = [];
  const push = (x, y, z, c, i) => { pts.push(x + gauss() * 0.0015, y + gauss() * 0.0015, z + gauss() * 0.0015); col.push(...c); it.push(i); };
  // floor with a sag towards the middle (as-built), 12 x 8 m
  for (let k = 0; k < 260000; k++) { const x = rnd() * Wd, y = rnd() * D; if (Math.abs(x - 6) < 0.2 && Math.abs(y - 4) < 0.2) continue; const z = -0.014 * Math.sin(Math.PI * x / Wd) * Math.sin(Math.PI * y / D); const g = 150 + 30 * Math.sin(x * 3.1) * Math.cos(y * 2.3) + rnd() * 20; push(x, y, z, [g, g * 0.97, g * 0.92], 0.45 + rnd() * 0.1); }
  // walls (x=0, y=0, y=8, x=12 leaning 9 mm over its height); door gap in y=0
  const wall = (n, f) => { for (let k = 0; k < n; k++) f(); };
  wall(60000, () => { const y = rnd() * D, z = rnd() * Ht; const c = 200 + rnd() * 25; push(0, y, z, [c, c, c * 0.96], 0.7 + rnd() * 0.08); });
  wall(80000, () => { const x = rnd() * Wd, z = rnd() * Ht; if (x > 2 && x < 3.1 && z < 2.1) return; const c = 205 + rnd() * 20; push(x, 0, z, [c, c * 0.98, c * 0.94], 0.7 + rnd() * 0.08); });
  wall(80000, () => { const x = rnd() * Wd, z = rnd() * Ht; const c = 195 + rnd() * 25; push(x, D, z, [c, c, c], 0.7 + rnd() * 0.08); });
  wall(60000, () => { const y = rnd() * D, z = rnd() * Ht; const c = 190 + rnd() * 25; push(Wd + 0.009 * z / Ht, y, z, [c * 0.95, c, c], 0.7 + rnd() * 0.08); });
  // column 0.4 x 0.4 at (6.015, 4) — 15 mm out of position
  wall(30000, () => { const s = rnd() * 4, t = rnd() * 0.4 - 0.2, z = rnd() * Ht; const cx = 6.015, cy = 4; let x, y; if (s < 1) { x = cx - 0.2; y = cy + t; } else if (s < 2) { x = cx + 0.2; y = cy + t; } else if (s < 3) { x = cx + t; y = cy - 0.2; } else { x = cx + t; y = cy + 0.2; } push(x, y, z, [120, 124, 130], 0.3 + rnd() * 0.05); });
  // a cable tray / duct along y=6.5 at z=2.6
  wall(15000, () => { const x = 1 + rnd() * 10, a = rnd() * Math.PI * 2; push(x, 6.5 + Math.cos(a) * 0.15, 2.6 + Math.sin(a) * 0.15, [180, 120, 60], 0.85); });
  // a few stray points (noise)
  for (let k = 0; k < 400; k++) push(rnd() * Wd, rnd() * D, rnd() * Ht, [255, 255, 255], 0.1);
  const n = pts.length / 3, pos = new Float32Array(n * 3), rgb = new Uint8Array(n * 3), inten = Float32Array.from(it);
  for (let i = 0; i < n * 3; i++) { pos[i] = pts[i]; rgb[i] = Math.max(0, Math.min(255, col[i])); }
  // design mesh (flat floor, vertical walls, column at 6,4) in world coords
  const T = []; const quad = (a, b, c, d) => T.push(...a, ...b, ...c, ...a, ...c, ...d);
  const w = (x, y, z) => [x + O[0], y + O[1], z + O[2]];
  quad(w(0, 0, 0), w(Wd, 0, 0), w(Wd, D, 0), w(0, D, 0));
  quad(w(0, 0, 0), w(0, 0, Ht), w(0, D, Ht), w(0, D, 0)); quad(w(Wd, 0, 0), w(Wd, D, 0), w(Wd, D, Ht), w(Wd, 0, Ht));
  quad(w(0, 0, 0), w(Wd, 0, 0), w(Wd, 0, Ht), w(0, 0, Ht)); quad(w(0, D, 0), w(0, D, Ht), w(Wd, D, Ht), w(Wd, D, 0));
  const c0 = [5.8, 3.8], c1 = [6.2, 4.2];
  quad(w(c0[0], c0[1], 0), w(c1[0], c0[1], 0), w(c1[0], c0[1], Ht), w(c0[0], c0[1], Ht)); quad(w(c1[0], c0[1], 0), w(c1[0], c1[1], 0), w(c1[0], c1[1], Ht), w(c1[0], c0[1], Ht));
  quad(w(c1[0], c1[1], 0), w(c0[0], c1[1], 0), w(c0[0], c1[1], Ht), w(c1[0], c1[1], Ht)); quad(w(c0[0], c1[1], 0), w(c0[0], c0[1], 0), w(c0[0], c0[1], Ht), w(c0[0], c1[1], Ht));
  // fix normals: walls should face into the room; floor up
  return { cloud: { n, pos, rgb, intensity: inten, cls: null, origin: O, meta: { format: 'Synthetic sample (not real data)', total: n, stride: 1 } }, mesh: Float64Array.from(T) };
}
function loadSample() {
  const s = makeSample();
  const L = addCloud('Sample scan (synthetic)', s.cloud, { sample: true });
  const M = addMesh('Sample design (synthetic)', s.mesh, { format: 'Synthetic design surfaces' }); M.sample = true;
  S.sample = true; selectLayer(L); setView('iso');
  // demo: deviation of the scan from the design
  AL.c2m(L.pos, L.n, M.tris, { maxDist: 0.05, signed: false }).then(d => { addSF(L, 'Distance to design', d, false); L.sfStyle['Distance to design'].tol = 0.005; L.colorMode = 'rgb'; colorize(L); refreshProps(); buildCompare(); });
}

// ---------- boot ----------
buildMeasure(); refreshLayers(); refreshProps(); refreshAllPanes();
resize(); loop(); loadStartSample();
window.__sb = { S, addCloud, addMesh, pick, setView, measureMode, addMeasure, applyLasso, runC2M, runC2C, runPlane };
})();
