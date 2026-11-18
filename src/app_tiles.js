// ===== ScanBench: LOD projects (datasets made by the scanlod converter) =====
// A project folder holds project.json (datasets, annotations, measurements, views, boxes, STL models)
// and one or more datasets (dataset.json + hierarchy.bin + octree.bin). Only the tiles in view are
// fetched, at the detail their size on screen needs, inside a fixed point budget.
const LP = { projects: [], project: null, store: null, active: null, workers: [], wseq: 0, waits: new Map(), conc: 6, detail: 90, adaptive: true, freshCap: 1200000, cacheX: 2.5, dirtyProject: false, box: { shown: false, edit: true }, key: '', force: true, hide: new Array(32).fill(0) };

// ---------- stores: a local folder, a list of files, or a web address ----------
class LDirStore {
  constructor(h, label) { this.h = h; this.label = label || h.name; this.files = new Map(); this.kind = 'folder'; }
  async dirOf(path, create = false) { const parts = path.split('/').filter(Boolean); let d = this.h; for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create }); return [d, parts[parts.length - 1]]; }
  async file(path, fresh) { if (!fresh && this.files.has(path)) return this.files.get(path); const [d, n] = await this.dirOf(path); const f = await (await d.getFileHandle(n)).getFile(); this.files.set(path, f); return f; }
  async read(path, off, len) { const f = await this.file(path); return new Uint8Array(await f.slice(off, off + len).arrayBuffer()); }
  async text(path) { return (await this.file(path, true)).text(); }
  async bytes(path) { return new Uint8Array(await (await this.file(path, true)).arrayBuffer()); }
  async canWrite() { try { if ((await this.h.queryPermission({ mode: 'readwrite' })) === 'granted') return true; return (await this.h.requestPermission({ mode: 'readwrite' })) === 'granted'; } catch (e) { return false; } }
  async write(path, data) { if (!(await this.canWrite())) throw new Error('No permission to write to the folder'); const [d, n] = await this.dirOf(path, true); const w = await (await d.getFileHandle(n, { create: true })).createWritable(); await w.write(data); await w.close(); this.files.delete(path); }
}
class LFileStore { // <input webkitdirectory>: read only
  constructor(list) { this.map = new Map(); let root = ''; for (const f of list) { const p = f.webkitRelativePath || f.name; const i = p.indexOf('/'); if (!root && i > 0) root = p.slice(0, i); this.map.set(i > 0 ? p.slice(i + 1) : p, f); } this.label = root || 'files'; this.kind = 'files'; }
  async file(path) { const f = this.map.get(path); if (!f) throw new Error(path + ' is not in the chosen folder'); return f; }
  async read(path, off, len) { return new Uint8Array(await (await this.file(path)).slice(off, off + len).arrayBuffer()); }
  async text(path) { return (await this.file(path)).text(); }
  async bytes(path) { return new Uint8Array(await (await this.file(path)).arrayBuffer()); }
  async canWrite() { return false; }
}
class LHttpStore { // any static host with Range support (S3, Azure, GitHub Pages, scanlod view)
  constructor(base) { this.base = base.replace(/[^/]*$/, ''); this.label = base; this.kind = 'web'; this.ctl = new AbortController(); }
  url(path) { return new URL(path, new URL(this.base, location.href)).href; }
  async read(path, off, len) {
    for (let a = 0; ; a++) {
      try { const r = await fetch(this.url(path), { headers: { Range: 'bytes=' + off + '-' + (off + len - 1) }, signal: this.ctl.signal }); if (!r.ok) throw new Error('HTTP ' + r.status + ' reading ' + path); const u = new Uint8Array(await r.arrayBuffer()); return r.status === 206 ? u : u.subarray(off, off + len); }
      catch (e) { if (e.name === 'AbortError' || a >= 3 || /HTTP 4/.test(e.message)) throw e; await new Promise(r => setTimeout(r, 400 * (a + 1))); }
    }
  }
  async text(path) { const r = await fetch(this.url(path), { cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status + ' reading ' + path); return r.text(); }
  async bytes(path) { const r = await fetch(this.url(path)); if (!r.ok) throw new Error('HTTP ' + r.status + ' reading ' + path); return new Uint8Array(await r.arrayBuffer()); }
  async canWrite() { return this.putOK !== false; }
  async write(path, data) { const r = await fetch(this.url(path), { method: 'PUT', body: data, headers: { 'X-ScanBench': '1' } }); if (!r.ok) { this.putOK = false; throw new Error('the server would not save (HTTP ' + r.status + ')'); } this.putOK = true; }
}

// ---------- decoding (Web Workers, with a main-thread fallback) ----------
function lodDecodeCore(u8, n, lay, base, sc, full, rgbShift) {
  const SZ = { uint8: 1, int8: 1, uint16: 2, int16: 2, uint32: 4, int32: 4, float32: 4, float64: 8 };
  const CT = { uint8: Uint8Array, int8: Int8Array, uint16: Uint16Array, int16: Int16Array, uint32: Uint32Array, int32: Int32Array, float32: Float32Array, float64: Float64Array };
  let off = 0; const col = {};
  for (const a of lay) { col[a.name] = { off, type: a.type, c: a.components }; off += n * SZ[a.type] * a.components; }
  if (off !== u8.length) throw new Error('tile holds ' + u8.length + ' bytes, expected ' + off);
  const arr = (type, o, len) => { const s = SZ[type], C = CT[type]; return (u8.byteOffset + o) % s === 0 ? new C(u8.buffer, u8.byteOffset + o, len) : new C(u8.buffer.slice(u8.byteOffset + o, u8.byteOffset + o + len * s)); };
  const p = col.position, X = arr('uint32', p.off, n), Y = arr('uint32', p.off + n * 4, n), Z = arr('uint32', p.off + n * 8, n);
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { pos[i * 3] = base[0] + X[i] * sc[0]; pos[i * 3 + 1] = base[1] + Y[i] * sc[1]; pos[i * 3 + 2] = base[2] + Z[i] * sc[2]; }
  const r = { n, pos, transfer: [pos.buffer] };
  if (col.rgb) { const R = arr('uint16', col.rgb.off, n), G = arr('uint16', col.rgb.off + n * 2, n), B = arr('uint16', col.rgb.off + n * 4, n); let mx = 0; for (let i = 0; i < n; i += 7) { if (R[i] > mx) mx = R[i]; if (G[i] > mx) mx = G[i]; if (B[i] > mx) mx = B[i]; }
    const sh = rgbShift === null || rgbShift === undefined ? (mx > 255 ? 8 : 0) : rgbShift; const c = new Uint8Array(n * 3); for (let i = 0; i < n; i++) { c[i * 3] = R[i] >> sh; c[i * 3 + 1] = G[i] >> sh; c[i * 3 + 2] = B[i] >> sh; } r.rgb = c; r.rgbMax = mx; r.transfer.push(c.buffer); }
  const copy = (name, type) => { if (!col[name]) return; const a = new CT[type](n); a.set(arr(type, col[name].off, n)); r[name] = a; r.transfer.push(a.buffer); };
  copy('intensity', 'uint16'); copy('classification', 'uint8'); copy('return_number', 'uint8'); copy('number_of_returns', 'uint8'); copy('source', 'uint16');
  if (full) { r.raw = u8; r.cols = col; r.transfer.push(u8.buffer); }
  return r;
}
async function lodGunzip(u8) { const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip')); return new Uint8Array(await new Response(s).arrayBuffer()); }
const LOD_WORKER_SRC = 'const lodDecodeCore = ' + lodDecodeCore.toString() + ';\nconst lodGunzip = ' + lodGunzip.toString() + ';\nself.onmessage = async e => { const m = e.data; try { let u8 = new Uint8Array(m.buf); if (m.gz && u8.length) u8 = await lodGunzip(u8); const r = lodDecodeCore(u8, m.n, m.lay, m.base, m.sc, m.full, m.rgbShift); const t = r.transfer; delete r.transfer; self.postMessage({ id: m.id, r }, t); } catch (err) { self.postMessage({ id: m.id, err: String(err && err.message || err) }); } };';
function lodWorkers() {
  if (LP.workers.length || LP.noWorkers) return LP.workers;
  try { const url = URL.createObjectURL(new Blob([LOD_WORKER_SRC], { type: 'text/javascript' })); const k = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < k; i++) { const w = new Worker(url); w.busy = 0; w.onmessage = e => { const m = e.data, p = LP.waits.get(m.id); if (!p) return; LP.waits.delete(m.id); w.busy--; m.err ? p.reject(new Error(m.err)) : p.resolve(m.r); }; w.onerror = () => { }; LP.workers.push(w); } }
  catch (e) { LP.noWorkers = true; }
  return LP.workers;
}
async function lodDecode(D, node, buf, full) {
  const base = [D.offW[0] + node.minU[0] * D.sc[0], D.offW[1] + node.minU[1] * D.sc[1], D.offW[2] + node.minU[2] * D.sc[2]];
  const msg = { buf: buf.buffer.byteLength === buf.length ? buf.buffer : buf.slice().buffer, n: node.count, lay: D.lay, base, sc: D.sc, gz: D.gz, full: !!full, rgbShift: D.rgbShift };
  const ws = lodWorkers();
  if (!ws.length) { let u8 = new Uint8Array(msg.buf); if (msg.gz && u8.length) u8 = await lodGunzip(u8); const r = lodDecodeCore(u8, msg.n, msg.lay, base, msg.sc, msg.full, msg.rgbShift); delete r.transfer; return r; }
  const w = ws.reduce((a, b) => (b.busy < a.busy ? b : a)); w.busy++; const id = ++LP.wseq;
  return new Promise((resolve, reject) => { LP.waits.set(id, { resolve, reject }); w.postMessage(Object.assign(msg, { id }), [msg.buf]); });
}

// ---------- hierarchy: pages are fetched only when the view reaches them ----------
function lodNode(D, name, parent, d) {
  let N = D.nodes.get(name); if (N) return N;
  const size = parent ? parent.sizeU / 2 : D.meta.cube.units; const minU = parent ? [parent.minU[0] + (d & 1) * size, parent.minU[1] + ((d >> 1) & 1) * size, parent.minU[2] + ((d >> 2) & 1) * size] : [0, 0, 0];
  const mn = new THREE.Vector3(D.offW[0] + minU[0] * D.sc[0], D.offW[1] + minU[1] * D.sc[1], D.offW[2] + minU[2] * D.sc[2]); const w = size * D.sc[0];
  N = { name, level: name.length - 1, parent, minU, sizeU: size, box: new THREE.Box3(mn, mn.clone().addScalar(w)), kids: [], count: 0, off: 0, size: 0, proxy: null, ready: false, spacing: w / (D.meta.settings && D.meta.settings.samplingGrid || 128) };
  N.centre = N.box.getCenter(new THREE.Vector3()); N.radius = w * Math.sqrt(3) / 2; D.nodes.set(name, N); return N;
}
function lodParsePage(D, root, u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), E = 22; let k = 0; const q = [root];
  while (q.length) { const N = q.shift(); if (k * E + E > u8.length) throw new Error('hierarchy page too short'); const p = k * E; k++;
    const t = dv.getUint8(p), mask = dv.getUint8(p + 1), cnt = dv.getUint32(p + 2, true), off = Number(dv.getBigUint64(p + 6, true)), sz = Number(dv.getBigUint64(p + 14, true));
    N.count = cnt; N.mask = mask; N.spacing = (N.sizeU * D.sc[0]) / Math.sqrt(Math.max(1, cnt));
    if (t === 2 && N !== root) { N.proxy = { off, size: sz }; N.ready = false; continue; }
    N.off = off; N.size = sz; N.proxy = null; N.ready = true; N.kids = [];
    for (let d = 0; d < 8; d++) if (mask & (1 << d)) { const c = lodNode(D, N.name + d, N, d); N.kids.push(c); q.push(c); } }
}
function lodPage(D, N) {
  if (N.pageP) return N.pageP;
  const pr = N === D.rootNode ? { off: 0, size: D.meta.hierarchy.firstChunkSize } : N.proxy;
  N.pageP = D.store.read(D.hierPath, pr.off, pr.size).then(b => { lodParsePage(D, N, b); LP.force = true; S.dirty = true; setTimeout(() => { try { lodUpdate(); } catch (e) { } }, 0); }).catch(e => { N.pageP = null; N.fail = (N.fail || 0) + 1; console.warn(e); });
  return N.pageP;
}

// ---------- rendering ----------
const LOD_VS = `
attribute vec3 color; attribute float aCls;
uniform float uSize; uniform float uPR; uniform int uClip; uniform vec3 uMin; uniform vec3 uMax;
uniform float uSpacing; uniform float uAdapt; uniform float uHalfH; uniform float uOrtho; uniform float uHide[32];
varying vec3 vC;
void main(){
  vC = color; vec4 wp = modelMatrix * vec4(position, 1.0);
  if (uClip == 1 && (any(lessThan(wp.xyz, uMin)) || any(greaterThan(wp.xyz, uMax)))) { gl_Position = vec4(2.0,2.0,2.0,1.0); gl_PointSize = 0.0; return; }
  int ci = int(aCls + 0.5); if (ci < 32 && uHide[ci] > 0.5) { gl_Position = vec4(2.0,2.0,2.0,1.0); gl_PointSize = 0.0; return; }
  vec4 mv = viewMatrix * wp; gl_Position = projectionMatrix * mv;
  float px = projectionMatrix[1][1] * uHalfH; if (uOrtho < 0.5) px /= max(1e-6, -mv.z);
  float s = uSize * uPR; if (uAdapt > 0.5) s = max(s, min(uSpacing * px, 10.0 * uPR));
  gl_PointSize = s; }`;
const lodU = { uAdapt: { value: 1 }, uHalfH: { value: 400 }, uOrtho: { value: 0 }, uHide: { value: LP.hide } };
function lodMat(spacing) { return new THREE.ShaderMaterial({ vertexShader: LOD_VS, fragmentShader: PT_FS, uniforms: { uSize: ptUniforms.uSize, uPR: ptUniforms.uPR, uClip: ptUniforms.uClip, uMin: ptUniforms.uMin, uMax: ptUniforms.uMax, uAdapt: lodU.uAdapt, uHalfH: lodU.uHalfH, uOrtho: lodU.uOrtho, uHide: lodU.uHide, uSpacing: { value: spacing } } }); }
const SRC_PAL = [[230, 159, 0], [86, 180, 233], [0, 158, 115], [240, 228, 66], [0, 114, 178], [213, 94, 0], [204, 121, 167], [200, 200, 200]];
function lodColor(D, N) {
  const c = N.col || (N.col = new Uint8Array(N.n * 3)), mode = D.colorMode, z0 = D.box.min.z, z1 = D.box.max.z, tmp = [0, 0, 0], iM = D.iMax || 65535;
  for (let i = 0; i < N.n; i++) {
    let r = 200, g = 200, b = 200;
    if (mode === 'rgb' && N.rgb) { r = N.rgb[i * 3]; g = N.rgb[i * 3 + 1]; b = N.rgb[i * 3 + 2]; }
    else if (mode === 'class' && N.classification) { const q = CLASS_COL[N.classification[i]] || [200, 200, 200]; r = q[0]; g = q[1]; b = q[2]; }
    else if (mode === 'elevation') { rampAt((N.pos[i * 3 + 2] - z0) / ((z1 - z0) || 1), 'bgr', tmp, 0); r = tmp[0]; g = tmp[1]; b = tmp[2]; }
    else if (mode === 'returns' && N.return_number) { const rn = N.return_number[i], nr = N.number_of_returns ? N.number_of_returns[i] : 1; const q = nr <= 1 ? [200, 200, 200] : rn === 1 ? [230, 80, 60] : rn === nr ? [60, 120, 230] : [90, 200, 90]; r = q[0]; g = q[1]; b = q[2]; }
    else if (mode === 'source' && N.source) { const q = SRC_PAL[N.source[i] % SRC_PAL.length]; r = q[0]; g = q[1]; b = q[2]; }
    else if (N.intensity) { const v = Math.min(255, Math.sqrt(N.intensity[i] / iM) * 255); r = g = b = v; }
    c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b;
  }
  if (N.obj) N.obj.geometry.attributes.color.needsUpdate = true;
}
function lodRecolor(D) { for (const [, N] of D.loaded) lodColor(D, N); S.dirty = true; }
function lodMakeObj(D, node, r) {
  const N = Object.assign(r, { node, last: performance.now(), fresh: true });
  if (D.rgbShift === null && r.rgb) D.rgbShift = r.rgbMax > 255 ? 8 : 0;
  if (!D.iMax && r.intensity && r.n) { const s = Array.from(r.intensity.filter((_, i) => i % 3 === 0)).sort((a, b) => a - b); D.iMax = Math.max(1, s[Math.floor(s.length * 0.99)] || 65535); }
  lodColor(D, N);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(N.pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(N.col, 3, true));
  if (N.classification) g.setAttribute('aCls', new THREE.BufferAttribute(N.classification, 1)); else g.setAttribute('aCls', new THREE.BufferAttribute(new Uint8Array(N.n), 1));
  g.boundingBox = node.box.clone(); g.boundingSphere = new THREE.Sphere(node.centre.clone(), node.radius);
  N.obj = new THREE.Points(g, lodMat(node.spacing)); N.obj.frustumCulled = false; N.obj.visible = false; N.obj.renderOrder = 0; D.root.add(N.obj); D.loaded.set(node.name, N); D.cachedPts += N.n;
}
function lodDrop(D, name) { const N = D.loaded.get(name); if (!N) return; D.root.remove(N.obj); N.obj.geometry.dispose(); N.obj.material.dispose(); D.loaded.delete(name); D.cachedPts -= N.n; }
async function lodLoad(D, node) {
  D.inflight.add(node.name);
  try { const b = await D.store.read(D.octPath, node.off, node.size); if (D.closed) return; const r = await lodDecode(D, node, b, false); if (D.closed) return; lodMakeObj(D, node, r); node.fail = 0; }
  catch (e) { if (D.closed) return; node.fail = (node.fail || 0) + 1; node.retryAt = performance.now() + 1500 * node.fail; if (node.fail === 3) console.warn('tile ' + node.name + ': ' + e.message); }
  finally { D.inflight.delete(node.name); LP.force = true; S.dirty = true; lodPump(); }
}
function lodPump() {
  const Ds = lodDatasets(); let busy = Ds.reduce((a, D) => a + D.inflight.size, 0); const now = performance.now();
  while (busy < LP.conc && LP.want && LP.want.length) { const it = LP.want.shift(); const N = it.N, D = it.D; if (D.closed || D.loaded.has(N.name) || D.inflight.has(N.name) || N.fail > 6 || N.retryAt > now) continue; busy++; lodLoad(D, N); }
  LP.pending = (LP.want ? LP.want.length : 0) + busy;
}
function lodDatasets() { return (S.streams || []).filter(D => D.kind === 'lod'); }
function lodUpdate() { const t0 = performance.now(); lodUpdateInner(); LP.updMs = performance.now() - t0; }
function lodUpdateInner() {
  const Ds = lodDatasets(); if (!Ds.length) return;
  const cam = curCam(); cam.updateMatrixWorld(); const pm = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  lodU.uHalfH.value = H() * renderer.getPixelRatio() / 2; lodU.uOrtho.value = cam.isOrthographicCamera ? 1 : 0; lodU.uAdapt.value = LP.adaptive ? 1 : 0;
  const key = pm.elements.map(v => v.toFixed(5)).join(',') + '|' + LODS.budget + '|' + LP.detail + '|' + S.clip.on + S.clip.box.min.toArray() + S.clip.box.max.toArray() + '|' + Ds.map(D => +D.visible).join('');
  if (key === LP.key && !LP.force) return; LP.key = key; LP.force = false;
  const fr = new THREE.Frustum().setFromProjectionMatrix(pm); const pxScale = cam.isOrthographicCamera ? H() / (cam.top - cam.bottom) * cam.zoom : H() / (2 * Math.tan(cam.fov * Math.PI / 360)); const camPos = cam.position;
  const heap = []; const push = (D, N) => { if (!fr.intersectsBox(N.box)) return; if (S.clip.on && !S.clip.box.intersectsBox(N.box)) return; const d = cam.isOrthographicCamera ? 1 : Math.max(1e-6, camPos.distanceTo(N.centre) - N.radius * 0.5); const w = N.radius / d * pxScale; let i = heap.length; heap.push({ D, N, w }); while (i > 0) { const p = (i - 1) >> 1; if (heap[p].w >= heap[i].w) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = i * 2 + 1, r = l + 1; let m = i; if (l < heap.length && heap[l].w > heap[m].w) m = l; if (r < heap.length && heap[r].w > heap[m].w) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  for (const D of Ds) { D.root.visible = D.visible; for (const [, N] of D.loaded) N.obj.visible = false; if (D.visible) { if (D.rootNode.ready) push(D, D.rootNode); else lodPage(D, D.rootNode); } }
  let shown = 0, fresh = 0, more = false; const want = [], pages = [], vis = [], now = performance.now(), budget = LODS.budget;
  while (heap.length) {
    const it = pop(), N = it.N, D = it.D;
    if (shown + N.count > budget && N.level > 0) continue;
    if (!N.ready) { if (N.proxy && !N.pageP && !(N.fail > 4)) pages.push(it); continue; }
    const L = D.loaded.get(N.name);
    if (L) { if (L.fresh && fresh > 0 && fresh + L.n > LP.freshCap) { more = true; continue; } L.obj.visible = true; if (L.fresh) { L.fresh = false; fresh += L.n; } L.last = now; shown += L.n; vis.push([N, L]); if (it.w > LP.detail) for (const c of N.kids) push(D, c); }
    else if (N.count > 0) { if (!(N.fail > 6) && !(N.retryAt > now)) want.push(it); }
    else if (it.w > LP.detail) for (const c of N.kids) push(D, c);
  }
  // gap filling: a tile draws at the spacing of the finest visible tile below it, since together they are that dense
  vis.sort((a, b) => b[0].level - a[0].level); for (const [N] of vis) N.eff = Infinity; for (const [N] of vis) { const e = Math.min(N.eff, N.spacing); N.eff = e; if (N.parent && N.parent.eff !== undefined && e < N.parent.eff) N.parent.eff = e; }
  for (const [N, L] of vis) L.obj.material.uniforms.uSpacing.value = Number.isFinite(N.eff) ? N.eff : N.spacing;
  for (const it of pages.slice(0, 8)) lodPage(it.D, it.N);
  want.sort((a, b) => b.w - a.w); LP.want = want.slice(0, 64); lodPump(); const busy = Ds.reduce((a, D) => a + D.inflight.size, 0);
  // forget tiles that are out of view once the cache is full, oldest first
  const cap = Math.max(budget * LP.cacheX, 2e6); let cached = Ds.reduce((a, D) => a + D.cachedPts, 0);
  if (cached > cap) { const all = []; for (const D of Ds) for (const [nm, N] of D.loaded) if (!N.obj.visible) all.push([D, nm, N.last]); all.sort((a, b) => a[2] - b[2]); for (const [D, nm] of all) { if (cached <= cap) break; const n = D.loaded.get(nm).n; lodDrop(D, nm); cached -= n; } }
  LP.shown = shown; const st = $('#stLOD'); const total = Ds.reduce((a, D) => a + (D.visible ? D.meta.points : 0), 0);
  if (st) st.textContent = 'Shown ' + fmtN(shown + (LODS.shown || 0) + (STR.shown || 0)) + ' of ' + fmtN(total + S.layers.filter(L => L.visible && L.kind === 'cloud').reduce((a, L) => a + L.n, 0)) + (busy || pages.length ? ' · loading…' : '');
  if (want.length || pages.length || more) setTimeout(() => { LP.force = true; S.dirty = true; }, more ? 16 : 60);
}
const _drawLOD = draw; draw = function () { try { lodUpdate(); } catch (e) { console.warn(e); } try { boxHelpersSync(); } catch (e) { } _drawLOD(); };

// ---------- opening and closing ----------
function crsIdFromMeta(c) { if (!c) return null; if (c.id && X_.byId(c.id)) return c.id; const code = c.epsg; if (code) { const s = X_.SYSTEMS.find(x => x.epsg === code); if (s) return s.id; } return null; }
async function lodOpenDataset(store, entry, P) {
  const meta = JSON.parse(await store.text(entry.path)); if (meta.format !== 'scanbench-lod') throw new Error(entry.path + ' is not a scanlod dataset');
  const dir = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/') + 1) : '';
  if (!S.origin) { S.origin = meta.bounds.min.map(v => Math.floor(v)); const so = $('#stOrigin'); if (so) so.textContent = 'Local origin E ' + S.origin[0] + ' N ' + S.origin[1] + ' Z ' + S.origin[2]; }
  const o = S.origin; if (Math.hypot(meta.bounds.min[0] - o[0], meta.bounds.min[1] - o[1]) > 20000) toast(meta.name + ' is ' + (Math.hypot(meta.bounds.min[0] - o[0], meta.bounds.min[1] - o[1]) / 1000).toFixed(0) + ' km from the data already open, so it will draw coarsely. Open it on its own for full precision.', true);
  const cid = crsIdFromMeta(meta.crs); if (cid && !S.crs) { S.crs = cid; try { updateCrsStatus(); } catch (e) { } }
  const name = entry.name || meta.name;
  const D = { kind: 'lod', P, id: (P ? P.id + ':' : '') + (entry.id || 'd' + Date.now()), entry, store, dir, meta: Object.assign({}, meta, { name }), octPath: dir + meta.octree.file, hierPath: dir + meta.hierarchy.file,
    nodes: new Map(), loaded: new Map(), inflight: new Set(), cachedPts: 0, root: new THREE.Group(), visible: entry.visible !== false, selfVisible: entry.visible !== false, group: entry.group,
    sc: meta.scale, offW: [meta.offset[0] - o[0], meta.offset[1] - o[1], meta.offset[2] - o[2]], gz: meta.encoding === 'gzip', lay: meta.attributes, rgbShift: null,
    colorMode: entry.color || (meta.attributes.some(a => a.name === 'rgb') ? 'rgb' : meta.attributes.some(a => a.name === 'intensity') ? 'intensity' : 'elevation') };
  D.box = new THREE.Box3(new THREE.Vector3(meta.bounds.min[0] - o[0], meta.bounds.min[1] - o[1], meta.bounds.min[2] - o[2]), new THREE.Vector3(meta.bounds.max[0] - o[0], meta.bounds.max[1] - o[1], meta.bounds.max[2] - o[2]));
  D.rootNode = lodNode(D, 'r', null, 0); await lodPage(D, D.rootNode); if (!D.rootNode.ready) throw new Error('could not read ' + D.hierPath);
  scene.add(D.root); S.streams.push(D); S.selStream = D; applyVisibility(); refreshLayers(); LP.force = true; S.dirty = true; return D;
}
function lodClose(D) { D.closed = true; for (const nm of [...D.loaded.keys()]) lodDrop(D, nm); scene.remove(D.root); S.streams = S.streams.filter(x => x !== D); if (S.selStream === D) S.selStream = null; refreshLayers(); LP.force = true; S.dirty = true; }
const _closeDatasetT = closeDataset; closeDataset = function (D) { if (D.kind === 'lod') { lodClose(D); buildLodPanel(); return; } return _closeDatasetT(D); };
function markDirty(P) { if (P) P.dirty = true; LP.dirtyProject = true; }
function claimNew(P) { if (P) for (const x of [...S.annots, ...S.measures, ...S.bookmarks, ...S.layers.filter(L => L.model)]) if (!x._p) x._p = P.id; }
function setActive(P) { if (LP.active && LP.active !== P) claimNew(LP.active); LP.active = P || null; LP.project = P ? P.proj : null; LP.store = P ? P.store : null; LP.boxes = P ? P.boxes : []; }
function ownedBy(x, P) { return x._p === P.id || (!x._p && LP.active === P); }
async function lodCloseProject(P) {
  if (!P) { for (const Q of LP.projects.slice()) await lodCloseProject(Q); return; }
  for (const D of lodDatasets().filter(D => D.P === P)) lodClose(D);
  for (const L of S.layers.filter(L => L.model && L._p === P.id)) removeLayerSafe(L);
  for (const a of S.annots.filter(a => a._p === P.id)) removeAnnotation(a);
  for (const M of S.measures.filter(M => M._p === P.id)) removeMeasure(M);
  S.bookmarks = S.bookmarks.filter(b => b._p !== P.id);
  if (P.store.ctl) P.store.ctl.abort();
  LP.projects = LP.projects.filter(Q => Q !== P); if (LP.active === P) setActive(LP.projects[0]);
  try { buildReview(); buildMeasure(); } catch (e) { } buildLodPanel();
}
function removeLayerSafe(L) { try { if (typeof removeLayer === 'function') { removeLayer(L); return; } } catch (e) { } scene.remove(L.obj); if (L.edges) scene.remove(L.edges); S.layers = S.layers.filter(x => x !== L); refreshLayers(); }
function blankProject(name, ds) { return { format: 'scanbench-project', version: 1, name, datasets: ds ? [{ id: 'd1', name, path: 'dataset.json', visible: true }] : [], annotations: [], measurements: [], views: [], boxes: [], models: [] }; }
async function lodOpenStore(store) {
  let proj = null; const tries = store.projectFile ? [store.projectFile] : ['project.json'];
  for (const f of tries) { try { proj = JSON.parse(await store.text(f)); store.projectFile = f; break; } catch (e) { } }
  if (!proj || proj.format === 'scanbench-lod') { let ds = proj && proj.format === 'scanbench-lod' ? proj : null; if (!ds) { try { ds = JSON.parse(await store.text('dataset.json')); } catch (e) { throw new Error('there is no project.json or dataset.json in ' + store.label); } } proj = blankProject(ds.name, true); if (store.projectFile && store.projectFile !== 'project.json') proj.datasets[0].path = store.projectFile; store.projectFile = 'project.json'; }
  if (proj.format !== 'scanbench-project') throw new Error('not a ScanBench project');
  const same = LP.projects.find(Q => Q.store.label === store.label && (Q.store.projectFile || 'project.json') === (store.projectFile || 'project.json') && Q.store.kind === store.kind);
  if (same) { toast((proj.name || store.label) + ' is already open.'); return; }
  const P = { id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), proj, store, name: proj.name || store.label, dirty: false, boxes: [] };
  LP.projects.push(P); setActive(P); LP.dirtyProject = false;
  const got = await busy('Opening ' + P.name + '…', async onP => { let k = 0; for (const e of proj.datasets || []) { try { await lodOpenDataset(store, e, P); } catch (err) { toast('Could not open ' + (e.name || e.path) + ': ' + err.message, true); } onP(++k / Math.max(1, proj.datasets.length)); } return true; });
  if (!got) { await lodCloseProject(P); return; }
  // everything the project brings in is tagged with it, so saving writes each item back to its own project
  const n0 = [S.annots.length, S.measures.length, S.bookmarks.length];
  LP.applying = true; try { await lodApplyState(proj, P); } finally { LP.applying = false; }
  S.annots.slice(n0[0]).forEach(a => { a._p = P.id; }); S.measures.slice(n0[1]).forEach(M => { M._p = P.id; }); S.bookmarks.slice(n0[2]).forEach(b => { b._p = P.id; }); P.dirty = false; LP.dirtyProject = false;
  const b = new THREE.Box3(); for (const D of lodDatasets()) b.union(D.box); if (!b.isEmpty()) fitBox(b);
  buildLodPanel(); toast('Opened ' + P.name + ': ' + lodDatasets().filter(D => D.P === P).length + ' dataset(s), ' + fmtN(lodDatasets().filter(D => D.P === P).reduce((a, D) => a + D.meta.points, 0)) + ' points' + (LP.projects.length > 1 ? ' (' + LP.projects.length + ' projects open)' : '') + '. Tiles load as you move.');
}
async function lodOpenFolder() {
  if (window.showDirectoryPicker) { try { const h = await window.showDirectoryPicker({ mode: 'readwrite' }); await lodOpenStore(new LDirStore(h)); } catch (e) { if (e.name !== 'AbortError') toast('Could not open that folder: ' + e.message, true); } return; }
  const inp = el('input', { type: 'file', webkitdirectory: true, hidden: true }); inp.addEventListener('change', async () => { if (!inp.files.length) return; try { await lodOpenStore(new LFileStore([...inp.files])); } catch (e) { toast('Could not open that folder: ' + e.message, true); } }); document.body.append(inp); inp.click(); setTimeout(() => inp.remove(), 60000);
}
async function lodOpenUrl(u) {
  u = (u || '').trim(); if (!u) return; const st = new LHttpStore(/\.json(\?|$)/i.test(u) ? u : u.replace(/\/?$/, '/'));
  if (/\.json(\?|$)/i.test(u)) st.projectFile = u.split('?')[0].split('/').pop();
  try { await lodOpenStore(st); } catch (e) { toast('Could not open ' + u + ': ' + e.message, true); }
}

// ---------- project state: annotations, measurements, views, boxes, models ----------
async function lodApplyState(p, P) {
  if (!S.origin) return;
  const st = { format: 'ScanBench project', crs: p.crs || null, annotations: p.annotations || [], bookmarks: p.views || [], measurements: p.measurements || [], tags: p.tags || [], groups: p.groups, layerGroups: p.layerGroups || [], flights: p.flights || [], cad: p.cad || null, cadOriginLocal: p.cadOriginLocal || S.origin };
  if (LP.projects.length > 1) { st.groups = undefined; st.cad = null; }   // groups and Scan to CAD results come from the first project only
  if (st.annotations.length || st.bookmarks.length || st.measurements.length || st.flights.length || st.cad || (st.groups && st.groups.length)) { try { loadProjectObj(st); } catch (e) { console.warn(e); } }
  const boxes = (p.boxes || []).map(b => ({ name: b.name, min: b.min, max: b.max, note: b.note || '', _p: P && P.id })); if (P) { P.boxes = boxes; LP.boxes = boxes; } else LP.boxes = boxes;
  for (const m of p.models || []) await lodLoadModel(m, null, P).catch(e => toast('Model ' + (m.name || m.path) + ': ' + e.message, true));
}
function lodProjectJSON(P) {
  P = P || LP.active; const p = (P && P.proj) || blankProject('Untitled'); const st = projectState(); const o = S.origin || [0, 0, 0];
  const pick = (arr, src) => arr.filter((_, i) => !P || ownedBy(src[i], P)); const main = !P || LP.active === P;
  const out = { format: 'scanbench-project', version: 1, name: p.name, created: p.created, saved: new Date().toISOString(), crs: S.crs || p.crs || null,
    datasets: lodDatasets().filter(D => !P || D.P === P).map(D => ({ id: D.entry.id || D.id, name: D.meta.name, path: D.entry.path, visible: D.selfVisible !== false, group: D.group, color: D.colorMode })),
    annotations: pick(st.annotations, S.annots), measurements: pick(st.measurements, S.measures), views: pick(st.bookmarks, S.bookmarks),
    tags: main ? st.tags : p.tags, groups: main ? st.groups : p.groups, flights: main ? st.flights : p.flights, cad: main ? st.cad : p.cad, cadOriginLocal: main ? st.cadOriginLocal : p.cadOriginLocal,
    boxes: ((P ? P.boxes : LP.boxes) || []).map(b => ({ name: b.name, min: b.min, max: b.max, note: b.note })),
    models: S.layers.filter(L => L.model && (!P || ownedBy(L, P))).map(L => Object.assign({}, L.model, { visible: L.visible, color: L.solid, opacity: L.opacity })) };
  void o; return out;
}
async function lodSaveProject(P) {
  P = P || LP.active; if (!P) return; const txt = JSON.stringify(lodProjectJSON(P), null, 1), st = P.store; const claim = () => { if (LP.active === P) claimNew(P); P.dirty = false; LP.dirtyProject = LP.projects.some(Q => Q.dirty); };
  if (st && st.write && await st.canWrite()) { try { await st.write(st.projectFile || 'project.json', txt); claim(); toast('Saved ' + (st.projectFile || 'project.json') + ' in ' + st.label + '.'); buildLodPanel(); return; } catch (e) { toast('Could not save into ' + P.name + ' (' + e.message + '); downloading project.json instead.', true); } }
  await saveFile('project.json', txt); claim(); toast('Downloaded project.json for ' + P.name + '. Put it in that project folder (next to dataset.json) to keep these changes.'); buildLodPanel();
}
async function lodSaveAll() { for (const P of LP.projects) await lodSaveProject(P); }
// STL models: placed with an offset (E, N, Z), a rotation about Z and a scale (e.g. 0.001 for millimetres)
async function lodLoadModel(m, bytes, P) {
  P = P || LP.active; if (!bytes) bytes = await (P ? P.store : LP.store).bytes(m.path);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); const r = /\.obj$/i.test(m.path) ? await readOBJ({ read: async (o, l) => ab.slice(o, o + l), size: ab.byteLength }) : await readSTL({ read: async (o, l) => ab.slice(o, o + l), size: ab.byteLength });
  const t = r.tris, s = m.scale || 1, a = (m.rotation || 0) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a), off = m.offset || [0, 0, 0];
  const w = new Float64Array(t.length); for (let i = 0; i < t.length; i += 3) { const x = t[i] * s, y = t[i + 1] * s, z = t[i + 2] * s; w[i] = x * c - y * sn + off[0]; w[i + 1] = x * sn + y * c + off[1]; w[i + 2] = z + off[2]; }
  const L = addMesh(m.name || m.path.split('/').pop(), w, Object.assign({}, r.meta, { format: (r.meta.format || 'STL') + ' · project model ' + m.path }));
  L.model = { id: m.id || 'm' + Date.now(), name: L.name, path: m.path, offset: off, rotation: m.rotation || 0, scale: s }; L.modelBytes = bytes; if (P) L._p = P.id;
  if (m.color) { L.solid = m.color; L.mat.color.set(m.color); } if (m.opacity !== undefined) { L.opacity = m.opacity; L.mat.opacity = m.opacity; }
  if (m.visible === false) { L.visible = false; L.obj.visible = false; if (L.edges) L.edges.visible = false; }
  S.dirty = true; return L;
}
async function lodAddModel(file) {
  const bytes = new Uint8Array(await file.arrayBuffer()); const path = 'models/' + file.name.replace(/[^\w.-]+/g, '_');
  let saved = false; if (LP.store && LP.store.write && await LP.store.canWrite()) { try { await LP.store.write(path, bytes); saved = true; } catch (e) { } }
  const L = await lodLoadModel({ path, name: file.name.replace(/\.[^.]+$/, ''), offset: [0, 0, 0], rotation: 0, scale: 1 }, bytes, LP.active); markDirty(LP.active); buildLodPanel();
  toast(saved ? 'Copied ' + file.name + ' into ' + path + '. Save the project to keep it.' : 'Loaded ' + file.name + '. This project is read-only here, so put the file at ' + path + ' in the project folder.');
  return L;
}
async function lodPlaceModel(L, upd) {
  const m = Object.assign({}, L.model, upd); const bytes = L.modelBytes; const P = LP.projects.find(Q => Q.id === L._p) || LP.active; removeLayerSafe(L); const N = await lodLoadModel(m, bytes, P); selectLayer(N); markDirty(P); buildLodPanel();
}

// ---------- the 3D box: draw over the view, drag its faces, save, export ----------
const BOX = { helper: null, handles: [], drag: null };
function boxHelpersSync() {
  const b = S.clip.box, show = (LP.box.shown || S.clip.on) && !b.isEmpty();
  if (!BOX.helper) { BOX.helper = new THREE.Box3Helper(new THREE.Box3(), 0xffb020); BOX.helper.material.depthTest = false; BOX.helper.renderOrder = 9; annot.add(BOX.helper);
    for (let k = 0; k < 6; k++) { const h = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: k < 2 ? 0xe0564a : k < 4 ? 0x4cc27c : 0x4f8fe0, depthTest: false })); h.renderOrder = 10; h.userData = { axis: k >> 1, side: k & 1 }; annot.add(h); BOX.handles.push(h); } }
  BOX.helper.visible = show && !S.clip.on; BOX.helper.box.copy(b);
  const hv = show && LP.box.edit; const cam = curCam(); const c = b.getCenter(new THREE.Vector3());
  for (const h of BOX.handles) { h.visible = hv; if (!hv) continue; const a = h.userData.axis, p = c.clone(); p.setComponent(a, h.userData.side ? b.max.getComponent(a) : b.min.getComponent(a)); h.position.copy(p);
    const d = cam.isOrthographicCamera ? (cam.top - cam.bottom) / cam.zoom / H() : 2 * Math.tan(cam.fov * Math.PI / 360) * cam.position.distanceTo(p) / H(); h.scale.setScalar(Math.max(1e-4, d * 7)); }
}
vp.addEventListener('pointerdown', e => {
  if (e.button !== 0 || !BOX.handles.length || !BOX.handles[0].visible || S.mode) return;
  const r = vp.getBoundingClientRect(); const ndc = new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1); const cam = curCam(); const rc = new THREE.Raycaster(); rc.setFromCamera(ndc, cam);
  const hit = rc.intersectObjects(BOX.handles.filter(h => h.visible), false)[0]; if (!hit) return;
  e.stopPropagation(); e.preventDefault(); const h = hit.object, a = h.userData.axis;
  // screen direction of the axis, in pixels per metre
  cam.updateMatrixWorld(); const p0 = h.position.clone().project(cam), dir = new THREE.Vector3(); dir.setComponent(a, 1); const p1 = h.position.clone().add(dir).project(cam);
  const sx = (p1.x - p0.x) * r.width / 2, sy = -(p1.y - p0.y) * r.height / 2, L2 = sx * sx + sy * sy; if (L2 < 1e-9) return;
  BOX.drag = { h, a, side: h.userData.side, x: e.clientX, y: e.clientY, sx, sy, L2, v0: h.userData.side ? S.clip.box.max.getComponent(a) : S.clip.box.min.getComponent(a) };
  const mv = ev => { const d = BOX.drag; if (!d) return; const t = ((ev.clientX - d.x) * d.sx + (ev.clientY - d.y) * d.sy) / d.L2; const b = S.clip.box, v = d.v0 + t;
    if (d.side) b.max.setComponent(d.a, Math.max(v, b.min.getComponent(d.a) + 0.01)); else b.min.setComponent(d.a, Math.min(v, b.max.getComponent(d.a) - 0.01)); LP.force = true; S.dirty = true; };
  const up = () => { window.removeEventListener('pointermove', mv, true); window.removeEventListener('pointerup', up, true); BOX.drag = null; try { buildSection(); } catch (e) { } buildLodPanel(); };
  window.addEventListener('pointermove', mv, true); window.addEventListener('pointerup', up, true);
}, true);
function boxDrawMode() {
  startMode({ type: 'lasso', freehand: true, rect: true, finishable: true, text: 'Drag a rectangle over the part you want; the box takes the points under it',
    onFinish: m => {
      if (m.pts.length < 3) return false; const r = vp.getBoundingClientRect(); const xs = m.pts.map(p => p[0] - r.left), ys = m.pts.map(p => p[1] - r.top);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys); if (x1 - x0 < 4 || y1 - y0 < 4) { toast('Drag a bigger rectangle.'); return false; }
      const cam = curCam(); cam.updateMatrixWorld(); const e = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements; const w = r.width, h = r.height;
      const b = new THREE.Box3(); let seen = 0; const sets = [...S.layers.filter(L => L.visible && L.kind === 'cloud'), ...pickSets()];
      const total = sets.reduce((a, L) => a + L.n, 0), step = Math.max(1, Math.floor(total / 4e6)); const clip = S.clip.on, cb = S.clip.box;
      for (const L of sets) { const P = L.pos; for (let i = 0; i < L.n; i += step) { const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2]; if (clip && (x < cb.min.x || y < cb.min.y || z < cb.min.z || x > cb.max.x || y > cb.max.y || z > cb.max.z)) continue;
        const cw = e[3] * x + e[7] * y + e[11] * z + e[15]; if (cw <= 0) continue; const sx = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / cw * 0.5 + 0.5) * w, sy = (1 - ((e[1] * x + e[5] * y + e[9] * z + e[13]) / cw * 0.5 + 0.5)) * h;
        if (sx < x0 || sx > x1 || sy < y0 || sy > y1) continue; b.expandByPoint(new THREE.Vector3(x, y, z)); seen++; } }
      if (!seen) { toast('No points under that rectangle.', true); return false; }
      const pad = Math.max(0.02, b.getSize(new THREE.Vector3()).length() * 0.01); b.expandByScalar(pad); S.clip.box.copy(b); LP.box.shown = true; LP.box.edit = true; LP.force = true; S.dirty = true;
      try { buildSection(); } catch (err) { } buildLodPanel(); toast('Box set. Drag the coloured handles to adjust a face, then export or save it.');
    } });
}
const boxWorld = () => { const o = S.origin || [0, 0, 0], b = S.clip.box; return { min: [b.min.x + o[0], b.min.y + o[1], b.min.z + o[2]], max: [b.max.x + o[0], b.max.y + o[1], b.max.z + o[2]] }; };
function boxFromWorld(w) { const o = S.origin || [0, 0, 0]; S.clip.box.min.set(w.min[0] - o[0], w.min[1] - o[1], w.min[2] - o[2]); S.clip.box.max.set(w.max[0] - o[0], w.max[1] - o[1], w.max[2] - o[2]); LP.box.shown = true; LP.force = true; S.dirty = true; try { buildSection(); } catch (e) { } }

// ---------- full-resolution reads: every point in a box ----------
async function lodCollect(D, box, maxLevel = 99) {
  const out = []; const st = [D.rootNode];
  while (st.length) { const N = st.pop(); if (box && !box.intersectsBox(N.box)) continue; if (!N.ready) { await lodPage(D, N); if (!N.ready) throw new Error('could not read part of the tile index'); } if (N.count) out.push(N); if (N.level < maxLevel) for (const c of N.kids) st.push(c); }
  return out;
}
async function lodEach(D, nodes, full, fn, onP, stop) {
  let k = 0, i = 0; const conc = Math.min(6, LP.conc);
  const worker = async () => { while (i < nodes.length) { if (stop && stop()) return; const N = nodes[i++]; const b = await D.store.read(D.octPath, N.off, N.size); const r = await lodDecode(D, N, b, full); await fn(N, r); onP && onP(++k / nodes.length); } };
  await Promise.all(Array.from({ length: conc }, worker));
}
async function lodReadBox(D, box, maxPts = 4e7, onP = () => {}) {
  const nodes = await lodCollect(D, box); const est = nodes.reduce((a, N) => a + N.count, 0); if (est > maxPts * 1.6) throw new Error('About ' + fmtN(est) + ' points fall in that box. Make it smaller (limit ' + fmtN(maxPts) + ') or export it to a file instead.');
  const parts = []; let n = 0;
  await lodEach(D, nodes, false, (N, r) => { const keep = []; for (let q = 0; q < r.n; q++) { if (box) { const x = r.pos[q * 3], y = r.pos[q * 3 + 1], z = r.pos[q * 3 + 2]; if (x < box.min.x || y < box.min.y || z < box.min.z || x > box.max.x || y > box.max.y || z > box.max.z) continue; } keep.push(q); } if (keep.length) { parts.push([r, keep]); n += keep.length; } }, onP);
  return lodJoin(D, parts, n);
}
async function lodReadSample(D, target, onP = () => {}) {
  const parts = []; let n = 0; let lvl = [D.rootNode];
  while (lvl.length && n < target) { const next = []; for (const N of lvl) { if (!N.ready) await lodPage(D, N); } const use = lvl.filter(N => N.ready && N.count); await lodEach(D, use, false, (N, r) => { parts.push([r, null]); n += r.n; }, null); onP(Math.min(1, n / target)); for (const N of lvl) for (const c of N.kids) next.push(c); lvl = next; }
  return lodJoin(D, parts, n);
}
function lodJoin(D, parts, n) {
  const pos = new Float32Array(n * 3), hasRGB = parts.length && parts.every(p => p[0].rgb), rgb = hasRGB ? new Uint8Array(n * 3) : null, it = new Float32Array(n), cls = new Uint8Array(n); let j = 0; const iM = D.iMax || 65535;
  for (const [r, keep] of parts) { const m = keep ? keep.length : r.n; for (let k = 0; k < m; k++) { const q = keep ? keep[k] : k; pos[j * 3] = r.pos[q * 3]; pos[j * 3 + 1] = r.pos[q * 3 + 1]; pos[j * 3 + 2] = r.pos[q * 3 + 2]; if (rgb) { rgb[j * 3] = r.rgb[q * 3]; rgb[j * 3 + 1] = r.rgb[q * 3 + 1]; rgb[j * 3 + 2] = r.rgb[q * 3 + 2]; } it[j] = r.intensity ? Math.min(1, r.intensity[q] / iM) : 0.5; cls[j] = r.classification ? r.classification[q] : 1; j++; } }
  return { n, pos, rgb, intensity: it, cls };
}
const _readBoxT = readBox; readBox = function (D, box, maxPts, onP) { return D && D.kind === 'lod' ? lodReadBox(D, box, maxPts, onP) : _readBoxT(D, box, maxPts, onP); };
const _readSampleT = readSample; readSample = function (D, target, onP) { return D && D.kind === 'lod' ? lodReadSample(D, target, onP) : _readSampleT(D, target, onP); };
const _extractT = extractToLayer;
extractToLayer = async function (D, mode) {
  if (!D || D.kind !== 'lod') return _extractT(D, mode);
  if (mode === 'box' && !(LP.box.shown || S.clip.on)) { toast('Draw or set a box first.', true); return null; }
  const r = await busy(mode === 'box' ? 'Loading every point inside the box…' : 'Loading an even sample…', onP => mode === 'box' ? lodReadBox(D, S.clip.box, 4e7, onP) : lodReadSample(D, S.extractN || 5e6, onP));
  if (!r || !r.n) { if (r) toast('No points there.', true); return null; }
  const L = addCloud(D.meta.name + (mode === 'box' ? ' (box)' : ' (sample)'), { n: r.n, pos: r.pos, rgb: r.rgb, intensity: r.intensity, cls: r.cls, origin: S.origin, meta: { format: 'From LOD dataset ' + D.meta.name, total: r.n, stride: 1 } });
  refreshProps(); toast(fmtN(r.n) + ' points copied into a working layer. Every tool works on it.'); return L;
};

// ---------- export: LAS 1.4 written straight to disk, with the source's VLRs ----------
async function lodOutFile(name) {
  if (window.showSaveFilePicker) { const h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'LAS point cloud', accept: { 'application/octet-stream': ['.las'] } }] }); const w = await h.createWritable(); let pos = 0; return { kind: 'disk', write: async u => { await w.write(u); pos += u.length; }, writeAt: async (p, u) => { await w.write({ type: 'write', position: p, data: u }); }, pos: () => pos, close: () => w.close(), abort: () => w.abort() }; }
  const parts = []; let pos = 0; let head = null; return { kind: 'memory', write: async u => { parts.push(u.slice()); pos += u.length; }, writeAt: async (p, u) => { if (p === 0) head = u.slice(); }, pos: () => pos, close: async () => { if (head) parts[0] = head; await saveFile(name, new Blob(parts)); }, abort: () => { } };
}
const b64u8 = s => Uint8Array.from(atob(s || ''), c => c.charCodeAt(0));
async function lodExport(D, opts = {}) {
  const box = opts.box || null, srcIdx = opts.source ?? null, src = D.meta.sources[srcIdx ?? 0] || {}; const sm = src.metadata || {};
  const nodes = await busy('Reading the tile index…', () => lodCollect(D, box)); if (!nodes) return; const est = nodes.reduce((a, N) => a + N.count, 0);
  const nm = (D.meta.name + (box ? '_box' : '') + (srcIdx !== null ? '_' + (src.label || 'source') : '')).replace(/[^\w.-]+/g, '_') + '.las';
  if (!window.showSaveFilePicker && est > 1.5e8) { toast('This browser can only export about 150 million points at once (this would be up to ' + fmtN(est) + '). Use Chrome or Edge, or run: scanlod export <folder> --box …', true); return; }
  let out; try { out = await lodOutFile(nm); } catch (e) { if (e.name !== 'AbortError') toast('Could not create the file: ' + e.message, true); return; }
  const hasRGB = D.lay.some(a => a.name === 'rgb'), pf = hasRGB ? 7 : 6, rl = hasRGB ? 36 : 30;
  const vl = []; let wkt = false; for (const v of [...(sm.vlrs || [])]) { if (v.laszip || v.userId === 'laszip encoded' || (v.userId === 'LASF_Spec' && v.recordId === 4)) continue; if (v.userId === 'LASF_Projection' && v.recordId === 2112) wkt = true; vl.push(b64u8(v.b64)); }
  if (!wkt && D.meta.crs && D.meta.crs.wkt) { const t = new TextEncoder().encode(D.meta.crs.wkt + '\0'); const h = new Uint8Array(54 + t.length), dv = new DataView(h.buffer); h.set(new TextEncoder().encode('LASF_Projection')); dv.setUint16(18, 2112, true); dv.setUint16(20, t.length, true); h.set(new TextEncoder().encode('OGC WKT'), 22); h.set(t, 54); vl.push(h); wkt = true; }
  const vlb = vl.reduce((a, v) => a + v.length, 0); await out.write(new Uint8Array(375)); for (const v of vl) await out.write(v);
  const sc = D.meta.scale, of = D.meta.offset, o = S.origin; let count = 0; const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], byRet = new Array(15).fill(0); let stop = false;
  const ok = await busy('Writing ' + nm + ' (' + fmtN(est) + ' points to check)…', async onP => {
    let chain = Promise.resolve();
    await lodEach(D, nodes, true, async (N, r) => {
      const c = r.cols, u8 = r.raw, n = r.n, dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), rec = new Uint8Array(n * rl), w = new DataView(rec.buffer); let m = 0;
      const g = (name, sz, i, k = 0) => c[name] ? (sz === 1 ? dv.getUint8(c[name].off + (k * n + i) * sz) : sz === 2 ? dv.getUint16(c[name].off + (k * n + i) * 2, true) : dv.getFloat64(c[name].off + (k * n + i) * 8, true)) : 0;
      const ux = N.minU[0], uy = N.minU[1], uz = N.minU[2], p = c.position.off;
      for (let i = 0; i < n; i++) {
        if (srcIdx !== null && c.source && dv.getUint16(c.source.off + i * 2, true) !== srcIdx) continue;
        const X = ux + dv.getUint32(p + i * 4, true), Y = uy + dv.getUint32(p + (n + i) * 4, true), Z = uz + dv.getUint32(p + (2 * n + i) * 4, true);
        const wx = of[0] + X * sc[0], wy = of[1] + Y * sc[1], wz = of[2] + Z * sc[2];
        if (box && (wx - o[0] < box.min.x || wy - o[1] < box.min.y || wz - o[2] < box.min.z || wx - o[0] > box.max.x || wy - o[1] > box.max.y || wz - o[2] > box.max.z)) continue;
        const q = m * rl; w.setInt32(q, X, true); w.setInt32(q + 4, Y, true); w.setInt32(q + 8, Z, true); w.setUint16(q + 12, g('intensity', 2, i), true);
        const rn = g('return_number', 1, i), nr = g('number_of_returns', 1, i), fl = g('flags', 1, i), ch = g('scanner_channel', 1, i);
        w.setUint8(q + 14, (rn & 15) | (nr & 15) << 4); w.setUint8(q + 15, (fl & 15) | (ch & 3) << 4 | ((fl >> 4) & 1) << 6 | ((fl >> 5) & 1) << 7); w.setUint8(q + 16, g('classification', 1, i)); w.setUint8(q + 17, g('user_data', 1, i));
        w.setInt16(q + 18, c.scan_angle ? dv.getInt16(c.scan_angle.off + i * 2, true) : 0, true); w.setUint16(q + 20, c.point_source_id ? g('point_source_id', 2, i) : c.source ? g('source', 2, i) + 1 : 0, true); w.setFloat64(q + 22, g('gps_time', 8, i), true);
        if (hasRGB) { w.setUint16(q + 30, g('rgb', 2, i, 0), true); w.setUint16(q + 32, g('rgb', 2, i, 1), true); w.setUint16(q + 34, g('rgb', 2, i, 2), true); }
        if (wx < mn[0]) mn[0] = wx; if (wx > mx[0]) mx[0] = wx; if (wy < mn[1]) mn[1] = wy; if (wy > mx[1]) mx[1] = wy; if (wz < mn[2]) mn[2] = wz; if (wz > mx[2]) mx[2] = wz; if (rn >= 1 && rn <= 15) byRet[rn - 1]++; m++;
      }
      count += m; if (m) { const part = rec.subarray(0, m * rl); chain = chain.then(() => out.write(part)); await chain; }
    }, onP, () => stop);
    await chain;
    // header (LAS 1.4, 375 bytes)
    const h = new Uint8Array(375), dv = new DataView(h.buffer); h.set([76, 65, 83, 70]); dv.setUint16(6, (wkt ? 16 : 0) | 1, true); h[24] = 1; h[25] = 4;
    const raw = sm.header ? b64u8(sm.header) : null; if (raw && raw.length >= 58) h.set(raw.subarray(26, 58), 26); h.set(new TextEncoder().encode('ScanBench ' + (D.meta.generator || '')).subarray(0, 31), 58);
    const d = new Date(); dv.setUint16(90, Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 864e5), true); dv.setUint16(92, d.getFullYear(), true);
    dv.setUint16(94, 375, true); dv.setUint32(96, 375 + vlb, true); dv.setUint32(100, vl.length, true); h[104] = pf; dv.setUint16(105, rl, true); dv.setUint32(107, 0, true);
    [0, 1, 2].forEach(k => { dv.setFloat64(131 + k * 8, sc[k], true); dv.setFloat64(155 + k * 8, of[k], true); });
    dv.setFloat64(179, count ? mx[0] : 0, true); dv.setFloat64(187, count ? mn[0] : 0, true); dv.setFloat64(195, count ? mx[1] : 0, true); dv.setFloat64(203, count ? mn[1] : 0, true); dv.setFloat64(211, count ? mx[2] : 0, true); dv.setFloat64(219, count ? mn[2] : 0, true);
    dv.setBigUint64(247, BigInt(count), true); for (let k = 0; k < 15; k++) dv.setBigUint64(255 + k * 8, BigInt(byRet[k]), true);
    await out.writeAt(0, h); return true;
  });
  if (!ok) { try { await out.abort(); } catch (e) { } return; }
  await out.close(); toast('Wrote ' + nm + ': ' + count.toLocaleString() + ' points (LAS 1.4, point format ' + pf + (vl.length ? ', ' + vl.length + ' VLR' + (vl.length > 1 ? 's' : '') + ' from the source' : '') + ').');
}

// ---------- panel ----------
function lodSelBox() { return LP.box.shown || S.clip.on ? S.clip.box : null; }
function buildLodPanel() {
  let host = $('#lodSec'); if (!host) { host = el('div', { class: 'sec', id: 'lodSec' }); const lay = $('#layers'); if (!lay) return; lay.closest('.sec').after(host); }
  const ds = $('#dsSec'); if (ds && host.nextSibling !== ds) ds.before(host);
  host.textContent = ''; const p = LP.projects.length ? LP.project || LP.projects[0].proj : null, Ds = lodDatasets().slice().sort((a, b) => LP.projects.indexOf(a.P) - LP.projects.indexOf(b.P));
  host.append(el('h3', {}, 'LOD projects'), el('div', { class: 'note' }, 'Open a folder made by the scanlod converter (project.json or dataset.json). Scans of any size stream in: only what is in view loads, at the detail it needs.'),
    el('div', { class: 'row' }, el('button', { class: 'btn small primary', onclick: lodOpenFolder }, 'Open project folder…'), el('button', { class: 'btn small', onclick: () => { const i = $('#lodUrl'); i.hidden = !i.hidden; if (!i.hidden) i.focus(); } }, 'Open from web address…'), el('button', { class: 'btn small', title: 'Make a LOD project from E57, LAS or LAZ files of any size, on this computer', onclick: openConverter }, 'Convert scans…')),
    el('input', { type: 'url', id: 'lodUrl', hidden: true, placeholder: 'https://…/project.json, then Enter', 'aria-label': 'Project web address', onkeydown: e => { if (e.key === 'Enter') lodOpenUrl(e.target.value); } }));
  if (!p) { host.append(el('div', { class: 'row' }, el('button', { class: 'btn small', title: 'Mundaring Weir converted by scanlod, streamed from this site', onclick: async () => { try { await new LHttpStore('lod/weir/project.json').text('project.json'); lodOpenUrl('lod/weir/project.json'); } catch (e) { lodOpenUrl('https://stuartcbuckett-code.github.io/ScanWorld/lod/weir/project.json'); } } }, 'Open the streaming demo')), el('div', { class: 'hint' }, 'Make your own with Convert scans… (Chrome or Edge), then open the folder it writes.')); return; }
  const budgetSel = el('select', { 'aria-label': 'Points on screen', style: 'width:auto', onchange: e => { LODS.budget = +e.target.value; LP.force = true; S.dirty = true; } }, ...[[1e6, '1 M'], [2e6, '2 M'], [3e6, '3 M'], [5e6, '5 M'], [8e6, '8 M'], [12e6, '12 M'], [20e6, '20 M']].map(([v, t]) => el('option', { value: v, selected: Math.abs(LODS.budget - v) < 1 }, t)));
  const detailSel = el('select', { 'aria-label': 'Detail', style: 'width:auto', onchange: e => { LP.detail = +e.target.value; LP.force = true; S.dirty = true; } }, ...[[200, 'Low'], [130, 'Medium'], [90, 'High'], [55, 'Very high']].map(([v, t]) => el('option', { value: v, selected: LP.detail === v }, t)));
  const ad = el('input', { type: 'checkbox' }); ad.checked = LP.adaptive; ad.addEventListener('change', () => { LP.adaptive = ad.checked; S.dirty = true; });
  host.append(el('div', { class: 'row', style: 'margin:6px 0;gap:8px;flex-wrap:wrap' }, el('label', { class: 'hint' }, 'Points ', budgetSel), el('label', { class: 'hint' }, 'Detail ', detailSel), el('label', { class: 'hint row', style: 'gap:4px' }, ad, 'Fill gaps'),
    LP.projects.length > 1 ? el('button', { class: 'btn small', onclick: lodSaveAll }, 'Save all') : null));
  const projHead = P => { const act = LP.active === P, many = LP.projects.length > 1;
    return el('div', { class: 'mitem', style: 'grid-template-columns:minmax(0,1fr);border-left:3px solid ' + (act ? 'var(--accent)' : 'transparent') },
      el('div', { class: 't' }, P.name + (P.dirty ? ' · unsaved changes' : '')), el('div', { class: 'v' }, P.store.label + ' · ' + (P.store.kind === 'files' ? 'read only' : P.store.kind) + (many ? (act ? ' · active: new notes and measurements go here' : '') : '')),
      el('div', { class: 'row', style: 'margin-top:4px' }, el('button', { class: 'btn small primary', onclick: () => lodSaveProject(P) }, 'Save'), many && !act ? el('button', { class: 'btn small', title: 'New annotations, measurements, views, boxes and models go into this project', onclick: () => { setActive(P); buildLodPanel(); } }, 'Make active') : null,
        el('button', { class: 'btn small', onclick: () => { if (P.dirty && !confirm(P.name + ' has unsaved changes. Close it anyway?')) return; lodCloseProject(P); } }, 'Close'))); };
  for (const P of LP.projects) if (!Ds.some(D => D.P === P)) host.append(projHead(P));
  let lastP = null;
  for (const D of Ds) {
    if (D.P !== lastP) { lastP = D.P; if (D.P) host.append(projHead(D.P)); }
    const m = D.meta, attrs = m.attributes.map(a => a.name).concat(D.edCls ? ['classification'] : []);
    const col = el('select', { 'aria-label': 'Colour by', style: 'width:auto', onchange: e => { D.colorMode = e.target.value; lodRecolor(D); } }, ...[['rgb', 'RGB', 'rgb'], ['intensity', 'Intensity', 'intensity'], ['class', 'Class', 'classification'], ['elevation', 'Elevation', 'position'], ['returns', 'Returns', 'return_number'], ['source', 'Source', 'source']].filter(x => attrs.includes(x[2])).map(([v, t]) => el('option', { value: v, selected: D.colorMode === v }, t)));
    const srcSel = m.sources.length > 1 ? el('select', { 'aria-label': 'Source to export', style: 'width:auto' }, el('option', { value: '' }, 'All sources'), ...m.sources.map((s, i) => el('option', { value: i }, s.label))) : null;
    host.append(el('div', { class: 'mitem', style: 'grid-template-columns:minmax(0,1fr)' + (S.selStream === D ? ';outline:2px solid var(--accent)' : '') },
      el('div', { class: 't' }, m.name), el('div', { class: 'v' }, fmtN(m.points) + ' pts · ' + m.sources.length + ' source' + (m.sources.length > 1 ? 's' : '') + ' · ' + (m.octree.bytes / 1e9).toFixed(2) + ' GB' + (m.crs && m.crs.epsg ? ' · EPSG:' + m.crs.epsg : '')),
      el('div', { class: 'row', style: 'margin-top:4px' }, el('button', { class: 'btn small', onclick: () => fitBox(D.box) }, 'Zoom'), col, srcSel),
      el('div', { class: 'row', style: 'margin-top:4px' }, el('button', { class: 'btn small', title: 'Every point inside the box, as a working layer every tool can use', onclick: () => extractToLayer(D, 'box') }, 'Box → layer'), el('button', { class: 'btn small', onclick: () => extractToLayer(D, 'sample') }, 'Sample → layer'),
        el('button', { class: 'btn small', onclick: () => lodExport(D, { box: lodSelBox(), source: srcSel && srcSel.value !== '' ? +srcSel.value : null }) }, lodSelBox() ? 'Export box (LAS)' : 'Export all (LAS)')),
      el('details', {}, el('summary', { class: 'hint', style: 'cursor:pointer' }, 'Source metadata'), el('div', { class: 'mono hint', style: 'white-space:pre-wrap;font-size:10.5px;max-height:220px;overflow:auto' },
        m.sources.map(s => s.label + '\n  ' + (s.kind || '').toUpperCase() + (s.metadata.version ? ' ' + s.metadata.version : '') + (s.metadata.pointFormat !== undefined ? ' · PF ' + s.metadata.pointFormat : '') + ' · ' + (s.points || 0).toLocaleString() + ' pts' + (s.metadata.systemIdentifier ? '\n  ' + s.metadata.systemIdentifier : '') + (s.metadata.generatingSoftware ? ' · ' + s.metadata.generatingSoftware : '') + (s.metadata.sensor && s.metadata.sensor.model ? '\n  ' + [s.metadata.sensor.vendor, s.metadata.sensor.model, s.metadata.sensor.serial].filter(Boolean).join(' ') : '') + ((s.metadata.vlrs || []).length ? '\n  VLRs: ' + s.metadata.vlrs.map(v => v.userId + ' ' + v.recordId + (v.description ? ' (' + v.description + ')' : '')).join('; ') : '')).join('\n\n')))));
  }
  // classes
  const anyCls = Ds.some(D => D.lay.some(a => a.name === 'classification') || D.edCls);
  if (anyCls) { const row = el('div', { class: 'row', style: 'flex-wrap:wrap;gap:4px' }); for (const [k, t] of [[0, 'Never'], [1, 'Unclass.'], [2, 'Ground'], [3, 'Low veg'], [4, 'Med veg'], [5, 'High veg'], [6, 'Building'], [7, 'Noise'], [9, 'Water'], [17, 'Bridge']]) { const c = el('input', { type: 'checkbox' }); c.checked = !LP.hide[k]; c.addEventListener('change', () => { LP.hide[k] = c.checked ? 0 : 1; S.dirty = true; }); row.append(el('label', { class: 'hint row', style: 'gap:3px' }, c, t)); } host.append(el('details', {}, el('summary', { class: 'hint', style: 'cursor:pointer' }, 'Show classes'), row)); }
  // box
  const b = lodSelBox(), w = b ? boxWorld() : null; const ed = el('input', { type: 'checkbox' }); ed.checked = LP.box.edit; ed.addEventListener('change', () => { LP.box.edit = ed.checked; S.dirty = true; });
  const hideOut = el('input', { type: 'checkbox' }); hideOut.checked = S.clip.on; hideOut.addEventListener('change', () => { S.clip.on = hideOut.checked; if (S.clip.on) LP.box.shown = true; syncClipUI(); buildLodPanel(); });
  const boxSec = el('div', { class: 'mitem', style: 'grid-template-columns:minmax(0,1fr)' }, el('div', { class: 't' }, '3D box'), el('div', { class: 'v' }, b ? 'E ' + w.min[0].toFixed(2) + ' … ' + w.max[0].toFixed(2) + ' · N ' + w.min[1].toFixed(2) + ' … ' + w.max[1].toFixed(2) + ' · Z ' + w.min[2].toFixed(2) + ' … ' + w.max[2].toFixed(2) : 'Drag a rectangle over the part you want (any view); the box wraps the points under it.'),
    el('div', { class: 'row', style: 'margin-top:4px' }, el('button', { class: 'btn small primary', onclick: boxDrawMode }, b ? 'Redraw box' : 'Draw box'), b ? el('button', { class: 'btn small', onclick: () => { LP.box.shown = false; S.clip.on = false; syncClipUI(); buildLodPanel(); } }, 'Clear') : null,
      b ? el('button', { class: 'btn small', onclick: () => { const nm = prompt('Name for this box', 'Box ' + ((LP.boxes || []).length + 1)); if (!nm) return; (LP.boxes = LP.boxes || []).push(Object.assign({ name: nm, note: '' }, boxWorld())); markDirty(LP.active); buildLodPanel(); } }, 'Save box') : null),
    b ? el('div', { class: 'row', style: 'margin-top:4px;gap:10px' }, el('label', { class: 'hint row', style: 'gap:4px' }, ed, 'Drag handles'), el('label', { class: 'hint row', style: 'gap:4px' }, hideOut, 'Hide outside')) : null);
  for (const [i, sb] of (LP.boxes || []).entries()) boxSec.append(el('div', { class: 'row', style: 'margin-top:4px;justify-content:space-between' }, el('span', { class: 'hint' }, sb.name), el('span', { class: 'row', style: 'gap:4px' }, el('button', { class: 'btn small', onclick: () => { boxFromWorld(sb); const bb = S.clip.box.clone(); fitBox(bb.expandByScalar(bb.getSize(new THREE.Vector3()).length() * 0.2)); buildLodPanel(); } }, 'Use'), el('button', { class: 'btn small icon danger', 'aria-label': 'Delete box', onclick: () => { LP.boxes.splice(i, 1); markDirty(LP.active); buildLodPanel(); } }, '×'))));
  host.append(boxSec);
  // models
  const mf = el('input', { type: 'file', hidden: true, accept: '.stl,.obj' }); mf.addEventListener('change', () => { const f = mf.files[0]; mf.value = ''; if (f) lodAddModel(f).catch(e => toast('Could not read ' + f.name + ': ' + e.message, true)); });
  const ms = el('div', { class: 'mitem', style: 'grid-template-columns:minmax(0,1fr)' }, el('div', { class: 't' }, 'Models (STL)'), el('div', { class: 'row', style: 'margin-top:4px' }, el('label', { class: 'btn small' }, 'Add STL…', mf)));
  for (const L of S.layers.filter(L => L.model)) {
    const m = L.model; const inp = (v, lab, step = 'any') => el('input', { type: 'number', value: v, step, 'aria-label': lab, title: lab, style: 'width:86px' });
    const e1 = inp(m.offset[0], 'Offset E'), n1 = inp(m.offset[1], 'Offset N'), z1 = inp(m.offset[2], 'Offset Z'), r1 = inp(m.rotation, 'Rotation about Z (degrees)'), s1 = el('select', { 'aria-label': 'Units', style: 'width:auto' }, ...[[1, 'metres'], [0.001, 'millimetres'], [0.0254, 'inches'], [0.3048, 'feet']].map(([v, t]) => el('option', { value: v, selected: Math.abs(m.scale - v) < 1e-12 }, t)));
    ms.append(el('details', { style: 'margin-top:4px' }, el('summary', { class: 'hint', style: 'cursor:pointer' }, L.name + ' · ' + m.path), el('div', { class: 'row', style: 'flex-wrap:wrap;gap:4px;margin-top:4px' }, e1, n1, z1, r1, s1,
      el('button', { class: 'btn small', onclick: () => lodPlaceModel(L, { offset: [+e1.value, +n1.value, +z1.value], rotation: +r1.value, scale: +s1.value }) }, 'Place'),
      el('button', { class: 'btn small', title: 'Move the model so its centre sits at the box centre (or the view centre)', onclick: () => { const c = (lodSelBox() || new THREE.Box3().setFromCenterAndSize(S.cam.target, new THREE.Vector3(1, 1, 1))).getCenter(new THREE.Vector3()); const mc = L.box.getCenter(new THREE.Vector3()); const o = S.origin; lodPlaceModel(L, { offset: [m.offset[0] + c.x - mc.x, m.offset[1] + c.y - mc.y, m.offset[2] + c.z - mc.z] }); void o; } }, 'Centre here'),
      el('button', { class: 'btn small icon danger', 'aria-label': 'Remove model', onclick: () => { removeLayerSafe(L); markDirty(LP.projects.find(Q => Q.id === L._p) || LP.active); buildLodPanel(); } }, '×'))));
  }
  host.append(ms, el('div', { class: 'hint' }, 'Annotations, measurements and saved views (Review and Measure tabs) are stored in project.json when you save.'));
}
const _refreshLayersT = refreshLayers; refreshLayers = function () { _refreshLayersT.apply(this, arguments); if (LP.project) { clearTimeout(LP.rp); LP.rp = setTimeout(buildLodPanel, 50); } };
window.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 's' && LP.project) { e.preventDefault(); lodSaveProject(); } });
window.addEventListener('beforeunload', e => { if (LP.projects.some(P => P.dirty)) { e.preventDefault(); e.returnValue = ''; } });
setTimeout(() => {
  buildLodPanel();
  const q = new URLSearchParams(location.search); const u = q.get('project') || q.get('open'); if (u) { lodOpenUrl(u); return; }
  if (window.SB_HOME) homeProject(window.SB_HOME);
}, 60);
// ---------- ScanBench.html written into a project folder by the converter: opens that project ----------
const HOMEDB = { get: async k => { try { return await new Promise((res, rej) => { const r = indexedDB.open('scanbench-home', 1); r.onupgradeneeded = () => r.result.createObjectStore('h'); r.onerror = () => rej(r.error); r.onsuccess = () => { const t = r.result.transaction('h').objectStore('h').get(k); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); }; }); } catch (e) { return null; } },
  set: async (k, v) => { try { await new Promise((res, rej) => { const r = indexedDB.open('scanbench-home', 1); r.onupgradeneeded = () => r.result.createObjectStore('h'); r.onerror = () => rej(r.error); r.onsuccess = () => { const t = r.result.transaction('h', 'readwrite'); t.objectStore('h').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }; }); } catch (e) { } } };
async function homeProject(home) {
  // served over http(s) (a web server, S3, scanlod view): the project sits beside this page, so open it straight away
  if (/^https?:$/.test(location.protocol)) { lodOpenUrl('project.json'); return; }
  // opened from disk: browsers only let a page read its folder after the user confirms it once
  const key = location.pathname; const saved = await HOMEDB.get(key);
  const msg = el('div', { class: 'note' }), btn = el('button', { class: 'btn primary', style: 'font-size:15px;padding:10px 18px' }, 'Open project');
  const card = el('div', { role: 'dialog', 'aria-label': 'Open project', style: 'position:fixed;inset:0;z-index:150;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);padding:16px' },
    el('div', { style: 'background:var(--panel,#fff);color:var(--ink,#111);border-radius:14px;padding:22px 24px;max-width:460px;width:100%;box-shadow:0 12px 40px rgba(0,0,0,.3);display:flex;flex-direction:column;gap:12px' },
      el('div', { style: 'font-size:19px;font-weight:600' }, home.name || 'LOD project'), el('div', { class: 'hint' }, (home.points ? fmtN(home.points) + ' points · ' : '') + 'converted ' + (home.created ? new Date(home.created * 1000).toLocaleDateString() : '')), msg, el('div', { class: 'row' }, btn, el('button', { class: 'btn', onclick: () => card.remove() }, 'Not now'))));
  msg.textContent = saved ? 'Your browser asks you to allow this folder again each visit. Press Open project, then Allow.' : 'Press Open project and choose the folder this page is in (' + decodeURIComponent(location.pathname.split('/').slice(-2, -1)[0] || 'this folder') + '). Your browser asks once; after that it only asks to allow it.';
  if (!window.showDirectoryPicker) msg.textContent = 'This browser cannot open folders from a page on disk. Use Chrome or Edge, or run scanlod view on the folder.';
  btn.addEventListener('click', async () => {
    try {
      let h = saved; if (h && (await h.requestPermission({ mode: 'readwrite' })) !== 'granted') h = null;
      if (!h) { h = await window.showDirectoryPicker({ mode: 'readwrite', id: 'sbhome' }); }
      let ok = false; try { await h.getFileHandle('dataset.json'); ok = true; } catch (e) { try { await h.getFileHandle('project.json'); ok = true; } catch (e2) { } }
      if (!ok) { msg.textContent = 'That folder has no project in it. Choose the folder this page (ScanBench.html) is in.'; return; }
      await HOMEDB.set(key, h); card.remove(); await lodOpenStore(new LDirStore(h));
    } catch (e) { if (e.name !== 'AbortError') msg.textContent = 'Could not open it: ' + e.message; }
  });
  document.body.append(card); btn.focus();
}
// changes that belong in project.json mark the project unsaved
for (const [get, set] of [[() => addAnnotation, f => { addAnnotation = f; }], [() => pushMeasure, f => { pushMeasure = f; }], [() => addBookmark, f => { addBookmark = f; }], [() => removeAnnotation, f => { removeAnnotation = f; }]]) {
  const orig = get(); set(function () { const r = orig.apply(this, arguments); if (LP.project && !LP.applying) { markDirty(LP.active); clearTimeout(LP.rp); LP.rp = setTimeout(buildLodPanel, 80); } return r; });
}

// ---------- the converter, in a dialog ----------
function openConverter() {
  if (!$('#convCss')) document.head.append(el('style', { id: 'convCss' }, `
.conv-ov{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:200;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:24px 12px}
.conv-pan{background:var(--panel,#fff);color:var(--ink,#111);border:1px solid var(--line,#ccc);border-radius:12px;max-width:720px;width:100%;padding:16px 18px;box-shadow:0 10px 40px rgba(0,0,0,.3)}
.conv-pan h2{margin:0 0 4px;font-size:18px}.conv-step{padding:10px 0;border-bottom:1px solid var(--line,#ddd)}.conv-step b{display:block;margin-bottom:6px}
.conv-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0}.conv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.conv-grid label{display:flex;flex-direction:column;gap:4px;font-size:12.5px;opacity:.8}
.conv-files{font-size:12.5px;opacity:.85;word-break:break-all}.conv-note{font-size:12px;opacity:.75}.conv-bar{height:8px;background:var(--line,#ddd);border-radius:6px;overflow:hidden;margin:12px 0 6px}.conv-bar-in{height:100%;width:0;background:var(--accent,#1f6feb);transition:width .3s}
.conv-stage{font-size:13px}.conv-done{margin-top:10px;display:flex;flex-direction:column;gap:8px;align-items:flex-start}.conv-log{max-height:200px;overflow:auto;font:11.5px/1.45 ui-monospace,Consolas,monospace;white-space:pre-wrap;opacity:.85;margin-top:8px}`));
  const host = el('div'); const ov = el('div', { class: 'conv-ov', role: 'dialog', 'aria-label': 'Convert scans' }, el('div', { class: 'conv-pan' },
    el('div', { class: 'row', style: 'justify-content:space-between' }, el('h2', {}, 'Convert scans to a LOD project'), el('button', { class: 'btn small icon', 'aria-label': 'Close', onclick: () => { if (host.querySelector('.conv-stage') && /%/.test(host.querySelector('.conv-stage').textContent) && !confirm('A conversion is running. Close anyway? It will stop.')) return; ov.remove(); } }, '×')),
    el('div', { class: 'note' }, 'Runs on this computer in Chrome or Edge; nothing is uploaded. Every point and attribute is kept, with all source metadata.'), host));
  document.body.append(ov);
  const viewer = async () => { for (const u of ['ScanBench-offline.html', 'https://stuartcbuckett-code.github.io/ScanWorld/ScanBench-offline.html']) { try { const r = await fetch(u); if (r.ok) return await r.text(); } catch (e) { } } return null; };
  convUI(host, { viewer, onDone: async h => { ov.remove(); try { await lodOpenStore(new LDirStore(h)); } catch (e) { toast('Could not open the new project: ' + e.message, true); } } });
}
