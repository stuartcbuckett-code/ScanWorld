// ---------- OCTREE LEVEL OF DETAIL: per-layer octree, point budget, JSON octree export/import ----------
const LODS = { on: true, budget: 3000000, auto: 1000000, minPx: 90, grid: 128, maxDepth: 14, shown: 0, total: 0 };
try { const s = JSON.parse(localStorage.getItem('sb-lod') || '{}'); if (s.budget) LODS.budget = s.budget; if (s.on === false) LODS.on = false; } catch (e) { }
function saveLodPrefs() { try { localStorage.setItem('sb-lod', JSON.stringify({ budget: LODS.budget, on: LODS.on })); } catch (e) { } }

// Potree-style sampling: each node keeps at most one point per cell of a 128³ grid over its cube; the rest go down to the children.
async function buildOctree(pos, n, box, onP = () => {}, opts = {}) {
  const G = opts.grid || LODS.grid, maxD = opts.maxDepth || LODS.maxDepth;
  const size = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) * 1.0001 + 1e-6, mn = [box.min.x, box.min.y, box.min.z];
  const mk = (level, min, sz, name) => ({ name, level, min, size: sz, children: [-1, -1, -1, -1, -1, -1, -1, -1], cells: new Set(), list: [] });
  const nodes = [mk(0, mn, size, 'r')];
  // visit points in a shuffled order so every node holds an even sample of its cube
  const order = new Uint32Array(n); for (let i = 0; i < n; i++) order[i] = i; let sd = 12345; for (let i = n - 1; i > 0; i--) { sd = (sd * 1103515245 + 12345) >>> 0; const j = sd % (i + 1); const t = order[i]; order[i] = order[j]; order[j] = t; }
  for (let q = 0; q < n; q++) {
    const i = order[q], x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]; let N = nodes[0];
    for (;;) {
      const f = G / N.size, kx = Math.min(G - 1, Math.floor((x - N.min[0]) * f)), ky = Math.min(G - 1, Math.floor((y - N.min[1]) * f)), kz = Math.min(G - 1, Math.floor((z - N.min[2]) * f));
      const key = (kz * G + ky) * G + kx;
      if (N.level >= maxD || !N.cells.has(key)) { N.cells.add(key); N.list.push(i); break; }
      const h = N.size / 2, ox = x >= N.min[0] + h ? 1 : 0, oy = y >= N.min[1] + h ? 1 : 0, oz = z >= N.min[2] + h ? 1 : 0, oc = ox | (oy << 1) | (oz << 2);
      let c = N.children[oc]; if (c < 0) { c = nodes.length; N.children[oc] = c; nodes.push(mk(N.level + 1, [N.min[0] + ox * h, N.min[1] + oy * h, N.min[2] + oz * h], h, N.name + oc)); }
      N = nodes[c];
    }
    if ((q & 262143) === 0) { onP(q / n * 0.85); await tick(); }
  }
  // fold small subtrees into one leaf (fewer, fuller nodes = fewer draw calls)
  const LEAF = opts.leaf || 40000; const tot = new Int32Array(nodes.length);
  for (let k = nodes.length - 1; k >= 0; k--) { const N = nodes[k]; let t = N.list.length; for (const c of N.children) if (c >= 0) t += tot[c]; tot[k] = t; }
  const gather = (k, out) => { const N = nodes[k]; for (const i of N.list) out.push(i); for (const c of N.children) if (c >= 0) gather(c, out); };
  for (let k = 0; k < nodes.length; k++) { const N = nodes[k]; if (!N.list || !N.children.some(c => c >= 0) || tot[k] > LEAF) continue; const all = []; gather(k, all); for (const c of N.children) if (c >= 0) { const st = [c]; while (st.length) { const q = st.pop(); for (const cc of nodes[q].children) if (cc >= 0) st.push(cc); nodes[q].list = null; } } N.list = all; N.children = [-1, -1, -1, -1, -1, -1, -1, -1]; }
  // breadth-first order; each node's points become one contiguous block
  const bfs = [0]; for (let k = 0; k < bfs.length; k++) for (const c of nodes[bfs[k]].children) if (c >= 0) bfs.push(c);
  const remap = new Int32Array(nodes.length); bfs.forEach((ni, k) => { remap[ni] = k; });
  const perm = new Uint32Array(n); let o = 0; const out = [];
  for (const ni of bfs) { const N = nodes[ni]; const st = o; for (const i of N.list) perm[o++] = i; out.push({ name: N.name, level: N.level, min: N.min, size: N.size, start: st, count: N.list.length, children: N.children.filter(c => c >= 0).map(c => remap[c]) }); N.cells = null; N.list = null; }
  onP(0.9);
  return { nodes: out, perm, size, min: mn, spacing: size / G };
}
function permuteLayer(L, perm) {
  const n = L.n; const take = (a, k) => { const b = new a.constructor(n * k); for (let j = 0; j < n; j++) { const s = perm[j] * k, d = j * k; for (let q = 0; q < k; q++) b[d + q] = a[s + q]; } return b; };
  for (const key of Object.keys(L)) { const v = L[key]; if (!ArrayBuffer.isView(v) || key === 'col' || key === 'hide') continue; const k = v.length / n; if (k === 1 || k === 2 || k === 3 || k === 4) L[key] = take(v, k); }
  for (const k of Object.keys(L.sfs || {})) L.sfs[k] = take(L.sfs[k], 1);
}
function dropLOD(L) {
  if (!L.lod) return; scene.remove(L.lod.group); for (const nd of L.lod.nodes) if (nd.obj) nd.obj.geometry.dispose(); L.lod = null; L.obj.visible = L.visible; S.dirty = true; updateLodStatus();
}
function attachLOD(L, tree) {
  const g = new THREE.Group(); const mat = L.obj.material;
  for (const nd of tree.nodes) {
    const geo = new THREE.BufferGeometry(); for (const nm of ['position', 'color', 'aHide']) if (L.geom.attributes[nm]) geo.setAttribute(nm, L.geom.attributes[nm]);
    geo.setDrawRange(nd.start, nd.count); const o = new THREE.Points(geo, mat); o.frustumCulled = false; o.visible = false; nd.obj = o; g.add(o);
    nd.box = new THREE.Box3(new THREE.Vector3(...nd.min), new THREE.Vector3(nd.min[0] + nd.size, nd.min[1] + nd.size, nd.min[2] + nd.size)); nd.radius = nd.size * Math.sqrt(3) / 2; nd.centre = nd.box.getCenter(new THREE.Vector3());
  }
  scene.add(g); L.lod = { nodes: tree.nodes, group: g, spacing: tree.spacing, size: tree.size, min: tree.min }; L.obj.visible = false; LODS.key = ''; S.dirty = true;
}
async function buildLOD(L) {
  if (!L || L.kind !== 'cloud' || L.lodBusy || !S.layers.includes(L)) return;
  L.lodBusy = true; const n0 = L.n;
  try {
    const tree = await busy('Building the octree for ' + L.name + '…', onP => buildOctree(L.pos, L.n, L.box, onP));
    if (!tree || L.n !== n0 || !S.layers.includes(L)) return;
    dropLOD(L); permuteLayer(L, tree.perm); L.lodRebuilding = true; rebuildCloud(L); L.lodRebuilding = false; refreshProps(); attachLOD(L, tree);
    toast('Octree built for ' + L.name + ': ' + tree.nodes.length.toLocaleString() + ' nodes, ' + (tree.nodes.reduce((a, b) => Math.max(a, b.level), 0) + 1) + ' levels.');
  } finally { L.lodBusy = false; buildLODPane(); }
}
// a layer whose points change loses its octree; rebuild it if it is still large
function lodOnRebuild(L) { if (L.lodRebuilding) return; dropLOD(L); if (LODS.on && L.n >= LODS.auto) setTimeout(() => buildLOD(L), 30); }
const _addCloudL = addCloud;
addCloud = function (...a) { const L = _addCloudL(...a); L.onRebuild = lodOnRebuild; if (LODS.on && L.n >= LODS.auto) setTimeout(() => buildLOD(L), 60); return L; };
const _removeLayerL = removeLayer;
removeLayer = function (L) { dropLOD(L); return _removeLayerL(L); };

// per frame: choose nodes by projected size, nearest/biggest first, within the point budget
const _frus = new THREE.Frustum(), _pm = new THREE.Matrix4();
function updateLOD() {
  const Ls = S.layers.filter(L => L.lod); if (!Ls.length) { LODS.shown = 0; return; }
  const cam = curCam(); cam.updateMatrixWorld(); _pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  const key = _pm.elements.map(v => v.toFixed(5)).join(',') + '|' + LODS.budget + '|' + Ls.map(L => L.id + (L.visible ? 'v' : 'h')).join() + '|' + S.clip.on + S.clip.box.min.toArray() + S.clip.box.max.toArray() + '|' + H();
  if (key === LODS.key) return; LODS.key = key; _frus.setFromProjectionMatrix(_pm);
  const pxScale = cam.isOrthographicCamera ? H() / (cam.top - cam.bottom) : H() / (2 * Math.tan(cam.fov * Math.PI / 360));
  const heap = []; const push = (L, nd) => { if (!_frus.intersectsBox(nd.box)) return; if (S.clip.on && !S.clip.box.intersectsBox(nd.box)) return; const d = cam.isOrthographicCamera ? 1 : Math.max(1e-6, cam.position.distanceTo(nd.centre) - nd.radius * 0.5); const px = nd.radius / d * pxScale; heap.push({ L, nd, w: px }); };
  for (const L of Ls) { for (const nd of L.lod.nodes) nd.obj.visible = false; L.obj.visible = false; L.lod.group.visible = L.visible; if (L.visible) push(L, L.lod.nodes[0]); }
  let shown = 0; const budget = LODS.budget;
  while (heap.length) {
    let bi = 0; for (let k = 1; k < heap.length; k++) if (heap[k].w > heap[bi].w) bi = k; const it = heap[bi]; heap[bi] = heap[heap.length - 1]; heap.pop();
    if (shown + it.nd.count > budget) { if (it.nd.level === 0) { it.nd.obj.visible = true; shown += it.nd.count; } continue; }
    it.nd.obj.visible = true; shown += it.nd.count;
    if (it.w > LODS.minPx) for (const c of it.nd.children) push(it.L, it.L.lod.nodes[c]);
  }
  LODS.shown = shown; LODS.total = Ls.filter(L => L.visible).reduce((a, L) => a + L.n, 0); updateLodStatus();
}
const _drawL = draw;
draw = function () { try { updateLOD(); } catch (e) { console.warn(e); } _drawL(); };
function updateLodStatus() {
  let s = $('#stLOD'); if (!s) { s = el('span', { class: 'hide-narrow', id: 'stLOD' }); const st = $('#stCores'); if (st) st.before(s); }
  const any = S.layers.some(L => L.lod); s.textContent = any ? 'LOD ' + fmtN(LODS.shown) + ' of ' + fmtN(LODS.total) + ' shown' : '';
}
// layer visibility toggles hide the LOD group too
const _refreshLayersL = refreshLayers;
refreshLayers = function () { _refreshLayersL(); for (const L of S.layers) if (L.lod) { L.obj.visible = false; L.lod.group.visible = L.visible; } LODS.key = ''; S.dirty = true; };

// ---------- octree export / import (JSON hierarchy + binary node blocks, zipped) ----------
function exportOctreeZip(L) {
  if (!L.lod) { toast('Build the octree first.', true); return; }
  const o = S.origin, n = L.n, nodes = L.lod.nodes; const hasRGB = !!L.rgb, hasI = !!L.intensity, hasC = !!L.cls;
  const per = 12 + (hasRGB ? 3 : 0) + (hasI ? 4 : 0) + (hasC ? 1 : 0); const bin = new Uint8Array(n * per); const dv = new DataView(bin.buffer); let off = 0; const hier = [];
  for (const nd of nodes) {
    const st = off; for (let j = nd.start; j < nd.start + nd.count; j++) { dv.setFloat32(off, L.pos[j * 3], true); dv.setFloat32(off + 4, L.pos[j * 3 + 1], true); dv.setFloat32(off + 8, L.pos[j * 3 + 2], true); off += 12; }
    if (hasRGB) { bin.set(L.rgb.subarray(nd.start * 3, (nd.start + nd.count) * 3), off); off += nd.count * 3; }
    if (hasI) { for (let j = nd.start; j < nd.start + nd.count; j++) { dv.setFloat32(off, L.intensity[j], true); off += 4; } }
    if (hasC) { bin.set(L.cls.subarray(nd.start, nd.start + nd.count), off); off += nd.count; }
    hier.push({ name: nd.name, level: nd.level, numPoints: nd.count, byteOffset: st, byteSize: off - st, min: nd.min.map((v, k) => +(v + o[k]).toFixed(4)), size: +nd.size.toFixed(4), children: nd.children.map(c => nodes[c].name) });
  }
  const C = S.crs && X_.byId(S.crs);
  const meta = { format: 'ScanBench octree', version: '1.0', name: L.name, points: n, crs: C ? { id: S.crs, name: C.name, epsg: C.epsg || null } : null,
    offset: o, boundingBox: { min: [L.box.min.x + o[0], L.box.min.y + o[1], L.box.min.z + o[2]], max: [L.box.max.x + o[0], L.box.max.y + o[1], L.box.max.z + o[2]] },
    cube: { min: L.lod.min.map((v, k) => v + o[k]), size: L.lod.size }, spacing: L.lod.spacing, sampling: 'one point per cell of a 128³ grid per node; children split the cube in eight',
    encoding: 'little-endian; per node, attribute blocks one after another in this order', data: 'octree.bin',
    attributes: [{ name: 'position', type: 'float32', elements: 3, note: 'metres, add offset for real-world coordinates' }, ...(hasRGB ? [{ name: 'rgb', type: 'uint8', elements: 3 }] : []), ...(hasI ? [{ name: 'intensity', type: 'float32', elements: 1 }] : []), ...(hasC ? [{ name: 'classification', type: 'uint8', elements: 1 }] : [])],
    hierarchy: hier };
  saveFile(L.name.replace(/[^\w.-]+/g, '_') + '-octree.zip', IO.makeZip([{ name: 'metadata.json', data: new TextEncoder().encode(JSON.stringify(meta, null, 1)) }, { name: 'octree.bin', data: bin }]));
}
function readStoredZip(u8) {   // ScanBench writes stored (uncompressed) zips
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); const files = {}; let p = 0; const dec = new TextDecoder();
  while (p + 30 <= u8.length && dv.getUint32(p, true) === 0x04034b50) {
    const method = dv.getUint16(p + 8, true), csize = dv.getUint32(p + 18, true), nl = dv.getUint16(p + 26, true), xl = dv.getUint16(p + 28, true); const name = dec.decode(u8.subarray(p + 30, p + 30 + nl)); const st = p + 30 + nl + xl;
    if (method !== 0) throw new Error('This zip is compressed; unzip it and open metadata.json with octree.bin.'); files[name] = u8.subarray(st, st + csize); p = st + csize;
  }
  return files;
}
function loadOctree(meta, bin) {
  if (!meta || meta.format !== 'ScanBench octree') throw new Error('metadata.json is not a ScanBench octree.');
  const n = meta.points, has = nm => meta.attributes.some(a => a.name === nm); const pos = new Float32Array(n * 3), rgb = has('rgb') ? new Uint8Array(n * 3) : null, it = has('intensity') ? new Float32Array(n) : null, cls = has('classification') ? new Uint8Array(n) : null;
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength); let j = 0; const nodes = []; const idx = {}; meta.hierarchy.forEach((h, k) => { idx[h.name] = k; });
  for (const h of meta.hierarchy) {
    let off = h.byteOffset; const st = j;
    for (let q = 0; q < h.numPoints; q++) { pos[(st + q) * 3] = dv.getFloat32(off, true); pos[(st + q) * 3 + 1] = dv.getFloat32(off + 4, true); pos[(st + q) * 3 + 2] = dv.getFloat32(off + 8, true); off += 12; }
    if (rgb) { rgb.set(bin.subarray(off, off + h.numPoints * 3), st * 3); off += h.numPoints * 3; }
    if (it) { for (let q = 0; q < h.numPoints; q++) { it[st + q] = dv.getFloat32(off, true); off += 4; } }
    if (cls) { cls.set(bin.subarray(off, off + h.numPoints), st); off += h.numPoints; }
    j += h.numPoints; nodes.push({ name: h.name, level: h.level, start: st, count: h.numPoints, min: h.min.map((v, k) => v - meta.offset[k]), size: h.size, children: h.children.map(c => idx[c]) });
  }
  const L = _addCloudL(meta.name + ' (octree)', { n, pos, rgb, intensity: it, cls, origin: meta.offset.slice(), meta: { format: 'ScanBench octree (JSON + binary), ' + meta.hierarchy.length + ' nodes' } });
  L.onRebuild = lodOnRebuild;
  if (meta.crs && meta.crs.id && !S.crs) { S.crs = meta.crs.id; try { updateCrsStatus(); } catch (e) { } }
  const d = [meta.offset[0] - S.origin[0], meta.offset[1] - S.origin[1], meta.offset[2] - S.origin[2]]; for (const nd of nodes) nd.min = nd.min.map((v, k) => v + d[k]);   // addCloud shifted the points to the shared origin
  attachLOD(L, { nodes, spacing: meta.spacing, size: meta.cube.size, min: meta.cube.min.map((v, k) => v - S.origin[k]) }); fitAll(); return L;
}
const _loadFilesL = loadFiles;
loadFiles = async function (files) {
  const arr = [...files]; const rest = [];
  const metaF = arr.find(f => /metadata\.json$/i.test(f.name)), binF = arr.find(f => /\.bin$/i.test(f.name));
  if (metaF && binF) { try { loadOctree(JSON.parse(await metaF.text()), new Uint8Array(await binF.arrayBuffer())); } catch (e) { toast(e.message, true); } }
  for (const f of arr) {
    if (f === metaF || f === binF) continue;
    if (/\.zip$/i.test(f.name)) { try { const z = readStoredZip(new Uint8Array(await f.arrayBuffer())); if (z['metadata.json'] && z['octree.bin']) loadOctree(JSON.parse(new TextDecoder().decode(z['metadata.json'])), z['octree.bin']); else toast(f.name + ' is not a ScanBench octree zip.', true); } catch (e) { toast(e.message, true); } continue; }
    if (/scanbench-project.*\.json$/i.test(f.name) || (/\.json$/i.test(f.name) && !/metadata/i.test(f.name))) { try { loadProjectObj(JSON.parse(await f.text())); } catch (e) { toast('Could not read ' + f.name + ': ' + e.message, true); } continue; }
    rest.push(f);
  }
  if (rest.length) return _loadFilesL(rest);
};

// ---------- view pane section (in the layer panel) ----------
function buildLODPane() {
  let host = $('#lodSec'); if (!host) { host = el('div', { class: 'sec', id: 'lodSec' }); const lp = $('#layerProps'); if (lp) lp.after(host); else return; }
  host.textContent = ''; const L = S.sel && S.sel.kind === 'cloud' ? S.sel : null;
  const on = el('input', { type: 'checkbox', id: 'lodOn' }); on.checked = LODS.on; on.addEventListener('change', () => { LODS.on = on.checked; saveLodPrefs(); if (!LODS.on) for (const X of S.layers) dropLOD(X); else for (const X of clouds()) if (X.n >= LODS.auto && !X.lod) buildLOD(X); buildLODPane(); });
  const bs = el('select', { id: 'lodBudget' }, ...[[1e6, '1 M'], [2e6, '2 M'], [3e6, '3 M'], [5e6, '5 M'], [8e6, '8 M'], [12e6, '12 M'], [2e7, '20 M']].map(([v, t]) => el('option', { value: v, selected: LODS.budget === v }, t + ' points')));
  bs.addEventListener('change', () => { LODS.budget = +bs.value; saveLodPrefs(); LODS.key = ''; S.dirty = true; });
  const qs = el('select', { id: 'lodQ' }, ...[[160, 'Fast'], [90, 'Balanced'], [45, 'Detailed']].map(([v, t]) => el('option', { value: v, selected: LODS.minPx === v }, t))); qs.addEventListener('change', () => { LODS.minPx = +qs.value; LODS.key = ''; S.dirty = true; });
  host.append(el('h3', {}, 'Level of detail'), el('label', { class: 'row', style: 'gap:6px;font-size:12px' }, on, 'Octree streaming for clouds over 1 M points'),
    el('div', { class: 'field' }, el('label', { for: 'lodBudget' }, 'Points on screen'), bs), el('div', { class: 'field' }, el('label', { for: 'lodQ' }, 'Detail'), qs));
  if (L) {
    if (L.lod) { const lv = L.lod.nodes.reduce((a, b) => Math.max(a, b.level), 0) + 1; host.append(el('div', { class: 'note' }, L.name + ': ' + L.lod.nodes.length.toLocaleString() + ' nodes in ' + lv + ' levels, root spacing ' + (L.lod.spacing * 100).toFixed(1) + ' cm.'),
      el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: () => exportOctreeZip(L) }, 'Export octree (JSON)'), el('button', { class: 'btn small', onclick: () => { dropLOD(L); buildLOD(L); } }, 'Rebuild'))); }
    else host.append(el('div', { class: 'row' }, el('button', { class: 'btn small', disabled: !!L.lodBusy, onclick: () => buildLOD(L) }, L.lodBusy ? 'Building…' : 'Build octree for ' + (L.n >= 1e6 ? (L.n / 1e6).toFixed(1) + ' M' : L.n.toLocaleString()) + ' points')));
    host.append(el('div', { class: 'hint' }, 'Export writes metadata.json (bounds, coordinate system, node hierarchy) and octree.bin (the points, node by node) in a zip. Open the zip, or both files, to load it back.'));
  }
}
const _posChangedL = posChanged;
posChanged = function (L) { _posChangedL(L); if (L.lod) { dropLOD(L); buildLOD(L); } };
const _refreshPropsL = refreshProps;
refreshProps = function () { _refreshPropsL(); buildLODPane(); };
