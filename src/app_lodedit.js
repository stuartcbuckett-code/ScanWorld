// ---------- EDITING LOD DATASETS: every Edit tool works on streamed datasets too ----------
// The converted files are never changed. Edits (new classes, deleted points) are kept per tile in edits.bin + edits.json next to dataset.json,
// and applied whenever a tile is read: on screen, in box reads, extracts and LAS exports. Tools that look at neighbours (ground, noise, terrain,
// people) run over the area in overlapping blocks of full-resolution points, so any size of dataset can be processed without loading it whole.
const ED = { blockPts: 6e6, undoDepth: 3 };
const edState = D => D.ed || (D.ed = { bytes: new Map(), index: null, cache: new Map(), dirty: false, undo: [], log: [] });
async function edGzip(u8) { const s = new Blob([u8]).stream().pipeThrough(new CompressionStream('gzip')); return new Uint8Array(await new Response(s).arrayBuffer()); }
function edEncode(p) { const n = p.n0, nb = (n + 7) >> 3, out = new Uint8Array(8 + (p.cls ? n : 0) + (p.del ? nb : 0)); const dv = new DataView(out.buffer); dv.setUint32(0, n, true); out[4] = (p.cls ? 1 : 0) | (p.del ? 2 : 0); let o = 8; if (p.cls) { out.set(p.cls, o); o += n; } if (p.del) out.set(p.del, o); return out; }
function edDecodeRaw(u8) { const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), n = dv.getUint32(0, true), f = u8[4], nb = (n + 7) >> 3; let o = 8; const p = { n0: n, cls: null, del: null }; if (f & 1) { p.cls = u8.slice(o, o + n); o += n; } if (f & 2) p.del = u8.slice(o, o + nb); return p; }
async function edGet(D, name) {   // the patch for a tile, or null
  const E = D.ed; if (!E) return null; if (E.cache.has(name)) return E.cache.get(name);
  let b = E.bytes.get(name); if (b === undefined && E.index && E.index.nodes[name]) { const [off, len] = E.index.nodes[name]; b = await D.store.read(D.dir + 'edits.bin', off, len); E.bytes.set(name, b); }
  if (!b) return null; const p = edDecodeRaw(await lodGunzip(b)); if (E.cache.size > 400) E.cache.delete(E.cache.keys().next().value); E.cache.set(name, p); return p;
}
async function edPut(D, name, p) {   // store (or clear, with null) a tile's patch; the tile on screen reloads
  const E = edState(D); const prev = E.bytes.has(name) ? E.bytes.get(name) : (E.index && E.index.nodes[name] ? await (async () => { const [off, len] = E.index.nodes[name]; return D.store.read(D.dir + 'edits.bin', off, len); })() : null);
  if (E.op && !E.op.has(name)) E.op.set(name, prev);
  E.bytes.set(name, p ? await edGzip(edEncode(p)) : null); E.cache.delete(name); E.dirty = true; if (p && p.cls) D.edCls = true;
  if (E.op) (E.drop || (E.drop = new Set())).add(name); else if (D.loaded.has(name)) { lodDrop(D, name); LP.force = true; } S.dirty = true;
}
// a decoded tile with its patch applied: classes replaced, deleted points removed (and r.idx maps each point back to its place in the original tile)
function edApply(r, p, full) {
  const n0 = r.n;
  if (p.cls) { r.classification = p.cls.slice(0, n0); if (full) { if (r.cols.classification) r.raw.set(p.cls.subarray(0, n0), r.cols.classification.off); else { const raw = new Uint8Array(r.raw.length + n0); raw.set(r.raw); raw.set(p.cls.subarray(0, n0), r.raw.length); r.cols = Object.assign({}, r.cols, { classification: { off: r.raw.length, type: 'uint8', c: 1 } }); r.raw = raw; } } }
  if (!p.del) { r.idx = null; return r; }
  const keep = []; for (let i = 0; i < n0; i++) if (!(p.del[i >> 3] & (1 << (i & 7)))) keep.push(i); const m = keep.length; if (m === n0) { r.idx = null; return r; }
  const sub = (a, k) => { if (!a) return a; const o = new a.constructor(m * k); for (let j = 0; j < m; j++) for (let c = 0; c < k; c++) o[j * k + c] = a[keep[j] * k + c]; return o; };
  r.pos = sub(r.pos, 3); r.rgb = sub(r.rgb, 3); for (const nm of ['intensity', 'classification', 'return_number', 'number_of_returns', 'source']) if (r[nm]) r[nm] = sub(r[nm], 1);
  if (full) {   // repack every column of the raw tile for the kept points
    const SZ = { uint8: 1, int8: 1, uint16: 2, int16: 2, uint32: 4, int32: 4, float32: 4, float64: 8 }; let tot = 0; for (const c of Object.values(r.cols)) tot += m * SZ[c.type] * c.c;
    const raw = new Uint8Array(tot), cols = {}; let o = 0;
    for (const [nm, c] of Object.entries(r.cols)) { const s = SZ[c.type]; cols[nm] = { off: o, type: c.type, c: c.c }; for (let k = 0; k < c.c; k++) { const src = c.off + k * n0 * s; for (let j = 0; j < m; j++) raw.set(r.raw.subarray(src + keep[j] * s, src + keep[j] * s + s), o + j * s); o += m * s; } }
    r.raw = raw; r.cols = cols;
  }
  r.n = m; r.idx = Uint32Array.from(keep); return r;
}
const _lodDecodeE = lodDecode;
lodDecode = async function (D, node, buf, full) { const r = await _lodDecodeE(D, node, buf, full); if (D.ed) { const p = await edGet(D, node.name); if (p) edApply(r, p, full); } return r; };

// merge a change into a tile's patch. ch: { cls: Uint8Array(n current) with 255 = unchanged, del: Uint8Array(n current) 1 = delete } in the order of r
async function edMerge(D, N, r, ch) {
  const n0 = N.count, old = await edGet(D, N.name); const idx = r.idx; const orig = i => idx ? idx[i] : i; let changed = false;
  let cls = old && old.cls ? old.cls.slice() : null, del = old && old.del ? old.del.slice() : null;
  if (ch.cls) { for (let i = 0; i < r.n; i++) { const c = ch.cls[i]; if (c === 255) continue; const cur = r.classification ? r.classification[i] : 0; if (c === cur && cls) continue; if (!cls) { cls = new Uint8Array(n0); if (r.classification) for (let j = 0; j < r.n; j++) cls[orig(j)] = r.classification[j]; } if (cls[orig(i)] !== c) { cls[orig(i)] = c; changed = true; } } }
  if (ch.del) { for (let i = 0; i < r.n; i++) if (ch.del[i]) { if (!del) del = new Uint8Array((n0 + 7) >> 3); const o = orig(i); if (!(del[o >> 3] & (1 << (o & 7)))) { del[o >> 3] |= 1 << (o & 7); changed = true; } } }
  if (changed) await edPut(D, N.name, { n0, cls, del }); return changed;
}
function edBegin(D, what) { const E = edState(D); E.op = new Map(); E.opName = what; }
function edEnd(D, summary) { const E = edState(D); if (E.drop) { for (const nm of E.drop) if (D.loaded.has(nm)) lodDrop(D, nm); E.drop = null; LP.force = true; S.dirty = true; }
  if (E.op && E.op.size && D.edCls && /class|ground|terrain|type|people to/i.test(E.opName || '') && D.colorMode !== 'class') { D.colorMode = 'class'; try { lodRecolor(D); buildLodPanel(); } catch (e) { } } if (E.op && E.op.size) { E.undo.push({ what: E.opName, nodes: E.op }); if (E.undo.length > ED.undoDepth) E.undo.shift(); E.log.push({ op: E.opName, when: new Date().toISOString(), summary }); markDirty(D.P); } E.op = null; refreshEditPane(); }
async function edUndo(D) { const E = edState(D), u = E.undo.pop(); if (!u) return; for (const [name, prev] of u.nodes) { E.bytes.set(name, prev); E.cache.delete(name); if (D.loaded.has(name)) lodDrop(D, name); } E.dirty = true; LP.force = true; S.dirty = true; toast('Undid: ' + u.what + '.'); refreshEditPane(); }
async function edDiscard(D) {
  if (!confirm('Remove every edit to ' + D.meta.name + '? The converted points are unchanged, so this puts the dataset back as it was converted.')) return;
  const E = edState(D); for (const nm of [...E.bytes.keys(), ...Object.keys((E.index && E.index.nodes) || {})]) { E.bytes.set(nm, null); if (D.loaded.has(nm)) lodDrop(D, nm); } E.cache.clear(); E.undo = []; E.dirty = true; D.edCls = false; LP.force = true; S.dirty = true; markDirty(D.P); toast('Edits removed. Save the project to make it stick.'); refreshEditPane();
}
const edCount = D => { const E = D.ed; if (!E) return 0; const s = new Set(Object.keys((E.index && E.index.nodes) || {})); for (const [k, v] of E.bytes) v ? s.add(k) : s.delete(k); return s.size; };

// ----- saving and loading edits.bin / edits.json -----
async function edSave(D) {
  const E = D.ed; if (!E || !E.dirty) return; const names = new Set(Object.keys((E.index && E.index.nodes) || {})); for (const [k, v] of E.bytes) v ? names.add(k) : names.delete(k);
  const parts = [], nodes = {}; let off = 0;
  for (const nm of names) { let b = E.bytes.get(nm); if (b === undefined) { const [o, l] = E.index.nodes[nm]; b = await D.store.read(D.dir + 'edits.bin', o, l); } nodes[nm] = [off, b.length]; parts.push(b); off += b.length; }
  const bin = new Uint8Array(off); let o = 0; for (const b of parts) { bin.set(b, o); o += b.length; }
  const json = JSON.stringify({ format: 'scanbench-edits', version: 1, dataset: D.meta.name, saved: new Date().toISOString(), tiles: names.size, classes: !!D.edCls, log: E.log.slice(-200), nodes });
  const st = D.store;
  if (st.write && await st.canWrite()) { await st.write(D.dir + 'edits.bin', bin); await st.write(D.dir + 'edits.json', json); if (st.files) { st.files.delete(D.dir + 'edits.bin'); st.files.delete(D.dir + 'edits.json'); } }
  else { await saveFile('edits.bin', new Blob([bin])); await saveFile('edits.json', json); toast('This folder is read-only here, so edits.bin and edits.json were downloaded. Put them next to dataset.json of ' + D.meta.name + '.', true); }
  E.index = { nodes }; const nl = [...names]; E.bytes = new Map(nl.map((nm, i) => [nm, parts[i]])); E.dirty = false;
}
async function edLoad(D) {
  try { const j = JSON.parse(await D.store.text(D.dir + 'edits.json')); if (j.format !== 'scanbench-edits') return; const E = edState(D); E.index = j; E.log = j.log || []; if (j.classes) D.edCls = true; if (j.tiles) toast(D.meta.name + ': ' + j.tiles + ' edited tile' + (j.tiles > 1 ? 's' : '') + ' applied (from edits.json).'); } catch (e) { }
}
const _lodOpenDatasetE = lodOpenDataset;
lodOpenDataset = async function (store, entry, P) { const D = await _lodOpenDatasetE(store, entry, P); await edLoad(D); if (entry.shift) edShiftApply(D, entry.shift, true); if (Array.isArray(entry.hiddenClasses)) { lodHideU(D); for (const k of entry.hiddenClasses) D.hiddenCls.add(+k); } return D; };
const _lodSaveProjectE = lodSaveProject;
lodSaveProject = async function (P) { P = P || LP.active; for (const D of lodDatasets().filter(D => !P || D.P === P)) { try { await edSave(D); } catch (e) { toast('Could not save the edits of ' + D.meta.name + ': ' + e.message, true); } } return _lodSaveProjectE(P); };
const _lodProjectJSONE = lodProjectJSON;
lodProjectJSON = function (P) { const out = _lodProjectJSONE(P); const Ds = lodDatasets(); for (const e of out.datasets) { const D = Ds.find(D => (D.entry.id || D.id) === e.id); if (D && D.shift && D.shift.some(v => v)) e.shift = D.shift; if (D && D.hiddenCls && D.hiddenCls.size) e.hiddenClasses = [...D.hiddenCls].sort((a, b) => a - b); } return out; };

// ----- moving a whole dataset (shift only: rotating or scaling would need re-converting) -----
function edShiftApply(D, d, quiet) {
  D.shift = (D.shift || [0, 0, 0]).map((v, k) => v + d[k]); D.meta = Object.assign({}, D.meta, { offset: D.meta.offset.map((v, k) => v + d[k]) }); D.offW = D.offW.map((v, k) => v + d[k]);
  const v = new THREE.Vector3(d[0], d[1], d[2]); for (const N of D.nodes.values()) { N.box.translate(v); N.centre.add(v); } D.box.translate(v);
  for (const nm of [...D.loaded.keys()]) lodDrop(D, nm); LP.force = true; S.dirty = true; if (!quiet) { markDirty(D.P); toast('Moved ' + D.meta.name + ' by ' + d.map(x => x.toFixed(3)).join(', ') + ' m. Exports use the new position; Save the project to keep it.'); }
}

// ----- which dataset the Edit tools act on, and over which area -----
function edTargetD() { if (S.sel && S.sel.kind === 'cloud') return null; const Ds = lodDatasets().filter(D => !D.closed); if (!Ds.length) return null; return Ds.includes(S.selStream) ? S.selStream : Ds[0]; }
function edRegion() { return (S.clip.on || (LP.box && LP.box.shown)) && !S.clip.box.isEmpty() ? S.clip.box.clone() : null; }
const edRegionText = () => edRegion() ? 'inside the box' : 'the whole dataset';

// point by point over every tile of the area: fn(N, r) returns a change for that tile, or null
async function edPointwise(D, what, box, fn, onP, nodeOk) {
  const nodes = (await lodCollect(D, box)).filter(N => !nodeOk || nodeOk(N)); let tiles = 0;
  await lodEach(D, nodes, false, async (N, r) => { const ch = fn(N, r); if (ch && await edMerge(D, N, r, ch)) tiles++; }, onP);
  return tiles;
}
// over the area in overlapping blocks of full-resolution points: fn(T) gets { n, pos, rgb, intensity, cls, box, core } and returns { cls?, del? } for those points
async function edBlocks(D, what, box, margin, fn, onP) {
  const area = box || D.box.clone(); area.intersect(D.box); if (area.isEmpty()) return { tiles: 0, points: 0 };
  const nodes = await lodCollect(D, area); const total = nodes.reduce((a, N) => a + N.count, 0); const w = area.max.x - area.min.x, h = area.max.y - area.min.y;
  const k = Math.max(1, Math.ceil(Math.sqrt(total / ED.blockPts * (1 + margin * 4 / Math.max(1, Math.min(w, h)))))); const nx = Math.max(1, Math.round(k * Math.sqrt(w / Math.max(h, 1e-6)))), ny = Math.max(1, Math.ceil(k * k / nx));
  const bw = w / nx, bh = h / ny; let tiles = 0, points = 0, b = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, b++) {
    const core = new THREE.Box3(new THREE.Vector3(area.min.x + i * bw, area.min.y + j * bh, area.min.z), new THREE.Vector3(area.min.x + (i + 1) * bw, area.min.y + (j + 1) * bh, area.max.z));
    const ext = core.clone(); ext.min.x -= margin; ext.min.y -= margin; ext.max.x += margin; ext.max.y += margin; if (!box) { ext.min.z = -Infinity; ext.max.z = Infinity; }
    const bn = await lodCollect(D, ext); const parts = []; let n = 0;
    await lodEach(D, bn, false, (N, r) => { const keep = []; for (let q = 0; q < r.n; q++) { const x = r.pos[q * 3], y = r.pos[q * 3 + 1], z = r.pos[q * 3 + 2]; if (x >= ext.min.x && x <= ext.max.x && y >= ext.min.y && y <= ext.max.y && z >= ext.min.z && z <= ext.max.z) keep.push(q); } if (keep.length) { parts.push({ N, r, keep }); n += keep.length; } });
    if (!n) continue;
    const T = { n, pos: new Float32Array(n * 3), rgb: parts.every(p => p.r.rgb) ? new Uint8Array(n * 3) : null, intensity: new Float32Array(n), cls: new Uint8Array(n), core: new Uint8Array(n), box: new THREE.Box3() }; let o = 0; const iM = D.iMax || 65535;
    for (const p of parts) for (const q of p.keep) { const x = p.r.pos[q * 3], y = p.r.pos[q * 3 + 1], z = p.r.pos[q * 3 + 2]; T.pos[o * 3] = x; T.pos[o * 3 + 1] = y; T.pos[o * 3 + 2] = z; T.box.expandByPoint(new THREE.Vector3(x, y, z)); if (T.rgb) { T.rgb[o * 3] = p.r.rgb[q * 3]; T.rgb[o * 3 + 1] = p.r.rgb[q * 3 + 1]; T.rgb[o * 3 + 2] = p.r.rgb[q * 3 + 2]; } T.intensity[o] = p.r.intensity ? p.r.intensity[q] / iM : 0.5; T.cls[o] = p.r.classification ? p.r.classification[q] : 1;
      T.core[o] = x >= core.min.x && x < core.max.x + (i === nx - 1 ? 1e-6 : 0) && y >= core.min.y && y < core.max.y + (j === ny - 1 ? 1e-6 : 0) && (!box || (z >= box.min.z && z <= box.max.z)) ? 1 : 0; o++; }
    const nb = nx * ny; onP && onP((b + 0.3) / nb); await tick();
    const res = await fn(T, f => onP && onP((b + 0.3 + 0.5 * f) / nb)); onP && onP((b + 0.8) / nb); if (!res) continue;
    o = 0; const jobs = []; for (const p of parts) { const ch = { cls: res.cls ? new Uint8Array(p.r.n).fill(255) : null, del: res.del ? new Uint8Array(p.r.n) : null }; let any = false;
      for (const q of p.keep) { if (T.core[o]) { if (ch.cls && res.cls[o] !== 255) { ch.cls[q] = res.cls[o]; any = true; } if (ch.del && res.del[o]) { ch.del[q] = 1; any = true; points++; } } o++; }
      if (any) jobs.push([p, ch]); }
    for (let q = 0; q < jobs.length; q += 16) { const rs = await Promise.all(jobs.slice(q, q + 16).map(([p, ch]) => edMerge(D, p.N, p.r, ch))); tiles += rs.filter(Boolean).length; }   // tiles in parallel
    onP && onP((b + 1) / (nx * ny)); await tick();
  }
  return { tiles, points };
}
// full-resolution points of an area as a plain array set (for extract, subsample, people search): filter(x,y,z) optional
async function edCollect(D, box, filter, max = 4e7, onP) {
  const nodes = await lodCollect(D, box); const parts = []; let n = 0; let over = false;
  await lodEach(D, nodes, false, (N, r) => { if (over) return; const keep = []; for (let q = 0; q < r.n; q++) { const x = r.pos[q * 3], y = r.pos[q * 3 + 1], z = r.pos[q * 3 + 2]; if (box && (x < box.min.x || y < box.min.y || z < box.min.z || x > box.max.x || y > box.max.y || z > box.max.z)) continue; if (filter && !filter(x, y, z)) continue; keep.push(q); } n += keep.length; if (n > max) { over = true; return; } if (keep.length) parts.push([r, keep]); }, onP, () => over);
  if (over) throw new Error('More than ' + fmtN(max) + ' points fall in that area. Use a smaller area, or export it to a file.');
  return lodJoin(D, parts, n);
}

// ----- the tools -----
const edAsk = (D, what) => { if (D.meta.points > 5e8 && !edRegion()) return confirm(what + ' over all ' + fmtN(D.meta.points) + ' points of ' + D.meta.name + ' reads every tile and can take a long time. Continue? (Draw a box first to work on part of it.)'); return true; };
async function edRun(D, what, job) {
  if (!edAsk(D, what)) return; edBegin(D, what); let res; ED.pause = true; try { res = await busy(what + ' on ' + D.meta.name + ' (' + edRegionText() + ')…', job); } finally { ED.pause = false; edEnd(D, res && res.summary); S.dirty = true; }
  if (res && res.summary) toast(res.summary + ' Save the project to keep the edits (the converted files are not changed).');
}
const edGround = D => edRun(D, 'Ground classification', async onP => { const r = await edBlocks(D, 'ground', edRegion(), Math.max(10, (S.gMaxW || 40) * 0.75, S.gCell * 6), async T => { const g = groundMask(T.pos, T.n); const cls = new Uint8Array(T.n); for (let i = 0; i < T.n; i++) cls[i] = g[i] ? 2 : 1; return { cls }; }, onP); return { summary: 'Ground classified (' + r.tiles + ' tiles changed).' }; });
const edNoise = D => edRun(D, 'Noise filter', async onP => { const r = await edBlocks(D, 'noise', edRegion(), Math.max(1, S.noiseR * 4), async (T, p) => { const keep = await AL.radiusOutliers(T.pos, T.n, S.noiseR, S.noiseN, p); const del = new Uint8Array(T.n); for (let i = 0; i < T.n; i++) del[i] = keep[i] ? 0 : 1; return { del }; }, onP); return { summary: 'Removed ' + r.points.toLocaleString() + ' isolated points.' }; });
const edTerrain = D => edRun(D, 'Terrain classification', async onP => { const r = await edBlocks(D, 'terrain', edRegion(), 12, async (T, p) => { const res = await terrainClasses(T, {}, p); const cls = res.cls; for (let i = 0; i < T.n; i++) { const c = T.cls[i]; if (c === 9 || (c >= 13 && c <= 17) || c >= 64) cls[i] = c; } return { cls }; }, onP); return { summary: 'Classified ground, vegetation, buildings and roads (' + r.tiles + ' tiles changed).' }; });
async function edCad(D) {
  if (!S.cad) { toast('Run Scan to CAD (or extract elements) first: classes come from the fitted elements.', true); return; }
  const items = cadItemsForClass(); if (!items.length) { toast('No fitted elements to classify by.', true); return; }
  const bb = new THREE.Box3(); for (const [k, x] of items) bb.union(itemAABB(k, x, 0.04)); const reg = edRegion(); if (reg) bb.intersect(reg);
  return edRun(D, 'Classify by element type', async onP => { const r = await edBlocks(D, 'cad', bb, 0.1, async (T, p) => { const before = T.cls.slice(); await cadClasses(T, items, 0.04, p); const cls = new Uint8Array(T.n).fill(255); for (let i = 0; i < T.n; i++) if (T.cls[i] !== before[i]) cls[i] = T.cls[i]; return { cls }; }, onP); return { summary: 'Points on the fitted elements classified (' + r.tiles + ' tiles changed).' }; });
}
async function edPeopleFind(D) {
  if (!edAsk(D, 'Looking for people')) return; const found = [];
  const res = await busy('Looking for people in ' + D.meta.name + ' (' + edRegionText() + ')…', async onP => { await edBlocks(D, 'people', edRegion(), 3, async (T, p) => { const f = await C_.detectPeople(T.pos, T.n, {}, p); for (const x of f) { const c = new THREE.Vector3(x.centre[0], x.centre[1], x.centre[2]); if (T.box && found.every(y => y.c.distanceTo(c) > 0.6)) found.push({ c, f: x }); } return null; }, onP); return true; });
  if (!res) return; S.people = { lod: D, found: found.map(x => x.f) };
  for (const x of found) addAnnotation(new THREE.Vector3(x.f.centre[0], x.f.centre[1], x.f.centre[2] + x.f.H), 'Person? ' + x.f.H.toFixed(2) + ' m tall', 'Found by the people filter', ['people'], '#ff3cc8');
  toast(found.length ? 'Found ' + found.length + ' possible ' + (found.length > 1 ? 'people' : 'person') + ', pinned and tagged "people". Check them, then remove.' : 'No people found.'); buildEdit();
}
async function edPeopleRemove(D, mode) {
  const P0 = S.people; if (!P0 || !P0.found.length) return; const inB = (x, y, z) => P0.found.some(f => x >= f.lo[0] && x <= f.hi[0] && y >= f.lo[1] && y <= f.hi[1] && z >= f.lo[2] && z <= f.hi[2]);
  const bb = new THREE.Box3(); for (const f of P0.found) bb.union(new THREE.Box3(new THREE.Vector3(...f.lo), new THREE.Vector3(...f.hi)));
  await edRun(D, mode === 'class' ? 'People to class 77' : 'Remove people', async onP => { let c = 0; await edPointwise(D, 'people', bb, (N, r) => { const ch = mode === 'class' ? { cls: new Uint8Array(r.n).fill(255) } : { del: new Uint8Array(r.n) }; let any = false; for (let i = 0; i < r.n; i++) if (inB(r.pos[i * 3], r.pos[i * 3 + 1], r.pos[i * 3 + 2])) { if (ch.cls) ch.cls[i] = 77; else ch.del[i] = 1; any = true; c++; } return any ? ch : null; }, onP); return { summary: c.toLocaleString() + ' points ' + (mode === 'class' ? 'set to class 77 (Person). Untick it under Show classes to hide them.' : 'removed from ' + P0.found.length + ' people.') }; });
  for (const a of S.annots.filter(a => (a.tags || []).includes('people'))) removeAnnotation(a); S.people = null; buildEdit(); buildReview();
}
// lasso: the polygon (taken through the view when it was drawn) selects points in every tile it covers
function edLassoTest() {
  const { M: e, pts, rect } = S.lasso; const poly = pts.map(p => [p[0] - rect.l, p[1] - rect.t]); let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of poly) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  const clip = S.clip.on, b = S.clip.box;
  return (x, y, z) => { if (clip && (x < b.min.x || y < b.min.y || z < b.min.z || x > b.max.x || y > b.max.y || z > b.max.z)) return false; const cw = e[3] * x + e[7] * y + e[11] * z + e[15]; if (cw <= 0) return false;
    const sx = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / cw * 0.5 + 0.5) * rect.w, sy = (0.5 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw * 0.5) * rect.h; if (sx < x0 || sx > x1 || sy < y0 || sy > y1) return false;
    let c = false; for (let a = 0, bb = poly.length - 1; a < poly.length; bb = a++) { const pa = poly[a], pb = poly[bb]; if (((pa[1] > sy) !== (pb[1] > sy)) && (sx < (pb[0] - pa[0]) * (sy - pa[1]) / (pb[1] - pa[1]) + pa[0])) c = !c; } return c; };
}
function edLassoBox() { return S.clip.on ? S.clip.box.clone() : null; }
function edLassoNodes() {   // a tile can hold selected points only if its screen footprint meets the polygon's bounding box (or it straddles the camera)
  const { M: e, pts, rect } = S.lasso; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of pts) { x0 = Math.min(x0, p[0] - rect.l); x1 = Math.max(x1, p[0] - rect.l); y0 = Math.min(y0, p[1] - rect.t); y1 = Math.max(y1, p[1] - rect.t); }
  return N => { let a0 = Infinity, b0 = Infinity, a1 = -Infinity, b1 = -Infinity; const B = N.box; for (let k = 0; k < 8; k++) { const x = k & 1 ? B.max.x : B.min.x, y = k & 2 ? B.max.y : B.min.y, z = k & 4 ? B.max.z : B.min.z; const cw = e[3] * x + e[7] * y + e[11] * z + e[15]; if (cw <= 0) return true;
    const sx = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / cw * 0.5 + 0.5) * rect.w, sy = (0.5 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw * 0.5) * rect.h; a0 = Math.min(a0, sx); a1 = Math.max(a1, sx); b0 = Math.min(b0, sy); b1 = Math.max(b1, sy); }
    return !(a1 < x0 || a0 > x1 || b1 < y0 || b0 > y1); };
}
async function edLasso(D, action, cls) {
  if (!S.lasso) return; const test = edLassoTest(); const box = edLassoBox(); const nodeOk = edLassoNodes();
  if (action === 'extract' || action === 'export' || action === 'clip') {
    const r = await busy('Reading the points inside the lasso…', onP => edCollect(D, box, test, 4e7, onP)); if (!r) return; if (!r.n) { toast('No points of ' + D.meta.name + ' fall inside the lasso.'); return; }
    if (action === 'clip') { const bb = new THREE.Box3(); for (let i = 0; i < r.n; i++) bb.expandByPoint(new THREE.Vector3(r.pos[i * 3], r.pos[i * 3 + 1], r.pos[i * 3 + 2])); S.clip.box.copy(bb); S.clip.on = true; syncClipUI(); toast('Clipping box set to the section (' + r.n.toLocaleString() + ' points).'); }
    else { const L = addCloud(D.meta.name + ' (segment)', { n: r.n, pos: r.pos, rgb: r.rgb, intensity: r.intensity, cls: r.cls, origin: S.origin, meta: { format: 'From LOD dataset ' + D.meta.name, total: r.n, stride: 1 } });
      if (action === 'export') { const f = ($('#secFmt') || {}).value || 'las'; exportCloud(L, f); } else toast('Extracted ' + r.n.toLocaleString() + ' points into a new layer.'); }
    S.lasso = null; drawOverlay(); buildEdit(); return;
  }
  const what = action === 'delIn' ? 'Delete inside the lasso' : action === 'delOut' ? 'Delete outside the lasso' : 'Set class ' + cls + ' inside the lasso';
  await edRun(D, what, async onP => { let c = 0; await edPointwise(D, what, action === 'delOut' ? null : box, (N, r) => { const ch = action === 'setCls' ? { cls: new Uint8Array(r.n).fill(255) } : { del: new Uint8Array(r.n) }; let any = false;
    for (let i = 0; i < r.n; i++) { const inside = test(r.pos[i * 3], r.pos[i * 3 + 1], r.pos[i * 3 + 2]); if (action === 'delOut' ? !inside : inside) { if (ch.cls) ch.cls[i] = cls; else ch.del[i] = 1; any = true; c++; } } return any ? ch : null; }, onP, action === 'delOut' ? null : nodeOk);
    return { summary: (action === 'setCls' ? c.toLocaleString() + ' points set to class ' + cls + ' (' + (CLASS_NAME[cls] || '') + ').' : 'Deleted ' + c.toLocaleString() + ' points.') }; });
  S.lasso = null; drawOverlay(); buildEdit();
}
async function edSubsample(D, kind, v) {
  const box = edRegion();
  const r = await busy('Subsampling ' + D.meta.name + '…', async onP => {
    if (kind === 'random') { const s = await lodReadSample(D, v * 1.3, onP); const idx = AL.randomSubsample(s.n, Math.min(s.n, Math.floor(v))); return pick(s, idx); }
    const est = (box ? (await lodCollect(D, box)).reduce((a, N) => a + N.count, 0) : D.meta.points); const parts = []; let n = 0;
    await edBlocks(D, 'subsample', box, 0, async T => { const idx = AL.voxelSubsample(T.pos, T.n, Math.max(1e-4, v)); const keep = []; for (const i of idx) if (T.core[i]) keep.push(i); n += keep.length; if (n > 4e7) throw new Error('That spacing keeps more than 40 million points. Use a larger spacing or a box.'); parts.push(pick(T, keep)); return null; }, onP); void est;
    return join(parts);
  });
  if (!r || !r.n) return; addCloud(D.meta.name + (kind === 'space' ? ' (' + v + ' m)' : ' (' + fmtN(r.n) + ')'), { n: r.n, pos: r.pos, rgb: r.rgb, intensity: r.intensity, cls: r.cls, origin: S.origin, meta: { format: 'From LOD dataset ' + D.meta.name, total: r.n, stride: 1 } }); toast('New layer: ' + r.n.toLocaleString() + ' points.');
  function pick(s, idx) { const n = idx.length, o = { n, pos: new Float32Array(n * 3), rgb: s.rgb ? new Uint8Array(n * 3) : null, intensity: new Float32Array(n), cls: new Uint8Array(n) }; for (let j = 0; j < n; j++) { const i = idx[j]; for (let k = 0; k < 3; k++) { o.pos[j * 3 + k] = s.pos[i * 3 + k]; if (o.rgb) o.rgb[j * 3 + k] = s.rgb[i * 3 + k]; } o.intensity[j] = s.intensity ? s.intensity[i] : 0.5; o.cls[j] = s.cls ? s.cls[i] : 1; } return o; }
  function join(ps) { const n = ps.reduce((a, p) => a + p.n, 0), o = { n, pos: new Float32Array(n * 3), rgb: ps.every(p => p.rgb) ? new Uint8Array(n * 3) : null, intensity: new Float32Array(n), cls: new Uint8Array(n) }; let j = 0; for (const p of ps) { o.pos.set(p.pos, j * 3); if (o.rgb) o.rgb.set(p.rgb, j * 3); o.intensity.set(p.intensity, j); o.cls.set(p.cls, j); j += p.n; } return o; }
}

// ----- route the existing Edit buttons: with no cloud layer selected and an LOD dataset open, they act on the dataset -----
const route = (name, lodFn) => { const orig = window[name]; const f = function (...a) { const D = edTargetD(); if (D) return lodFn(D, ...a); return orig.apply(this, a); }; return f; };
noiseFilter = route('noiseFilter', D => edNoise(D));
groundClassify = route('groundClassify', D => edGround(D));
subsample = route('subsample', (D, kind, v) => edSubsample(D, kind, v));
applyLasso = route('applyLasso', (D, action) => edLasso(D, action));
classifyTerrain = route('classifyTerrain', D => edTerrain(D));
classifyByCad = route('classifyByCad', D => edCad(D));
findPeople = route('findPeople', D => edPeopleFind(D));
{ const orig = removePeople; removePeople = function (mode) { if (S.people && S.people.lod) return edPeopleRemove(S.people.lod, mode); return orig(mode); }; }
{ const orig = transformLayer; transformLayer = function (dx, dy, dz, rz, sc) { const D = edTargetD(); if (!D) return orig(dx, dy, dz, rz, sc); if (rz || sc !== 1) { toast('A streamed dataset can be shifted here, not rotated or scaled (that needs re-converting). Set Rotate to 0 and Scale to 1, or extract an area to a layer.', true); return; } edShiftApply(D, [dx, dy, dz]); buildEdit(); }; }
{ const orig = lassoMode; lassoMode = function (f, r) { if (!edTargetD()) return orig(f, r); const nc = needCloud; needCloud = () => ({}); try { return orig(f, r); } finally { needCloud = nc; } }; }
// set class inside the lasso: for layers in memory and for LOD datasets
function lassoSetClass(cls) {
  const D = edTargetD(); if (D) return edLasso(D, 'setCls', cls);
  const L = needCloud(); if (!L || !S.lasso) return; const test = edLassoTest(); if (!L.cls) L.cls = new Uint8Array(L.n).fill(1); let c = 0;
  for (let i = 0; i < L.n; i++) if (test(L.pos[i * 3], L.pos[i * 3 + 1], L.pos[i * 3 + 2])) { L.cls[i] = cls; c++; }
  L.colorMode = 'class'; applyClassHide(L); colorize(L); refreshProps(); toast(c.toLocaleString() + ' points set to class ' + cls + ' (' + (CLASS_NAME[cls] || '') + ').'); S.lasso = null; drawOverlay(); buildEdit();
}
const EXTRA_CLASSES = { 8: 'Model key point', 10: 'Rail', 11: 'Road surface', 12: 'Overlap', 19: 'Overhead structure', 20: 'Ignored ground', 64: 'Pipe', 65: 'Fitting', 66: 'Vessel', 67: 'Structural steel', 77: 'Person' };

function refreshEditPane() { try { buildEdit(); } catch (e) { } }
const _buildEditE = buildEdit;
buildEdit = function () {
  _buildEditE(); const p = pane('edit'); if (!p) return; const D = edTargetD();
  // manual classification in the lasso section
  const lassoSec = [...p.querySelectorAll('.sec')].find(s => /Segment with lasso/.test(s.textContent));
  if (lassoSec) { const names = Object.assign({}, CLASS_NAME, EXTRA_CLASSES); const sel = el('select', { style: 'width:auto', 'aria-label': 'Class' }, ...Object.keys(names).map(Number).sort((a, b) => a - b).map(k => el('option', { value: k, selected: k === (S.setCls || 2) }, k + ' ' + names[k])));
    sel.addEventListener('change', () => { S.setCls = +sel.value; });
    const row = el('div', { class: 'row' }, el('span', { class: 'hint' }, 'Classify inside:'), sel, el('button', { class: 'btn small primary', disabled: !S.lasso, onclick: () => lassoSetClass(+sel.value) }, 'Set class'));
    const after = [...lassoSec.querySelectorAll('.row')][1]; if (after) after.after(row); else lassoSec.append(row); }
  if (!D) return;
  // the "choose a cloud" box becomes the LOD target box
  const old = [...p.querySelectorAll('.sec')].find(s => /Choose a point cloud to work on/.test(s.textContent)); const E = D.ed || {};
  const dsSel = lodDatasets().length > 1 ? el('select', { style: 'width:auto', 'aria-label': 'Dataset' }, ...lodDatasets().map(x => el('option', { value: x.id, selected: x === D }, x.meta.name))) : null;
  if (dsSel) dsSel.addEventListener('change', () => { S.selStream = lodDatasets().find(x => x.id === dsSel.value); buildEdit(); });
  const nE = edCount(D);
  const box = el('div', { class: 'sec', style: 'border-left:3px solid var(--accent)' }, el('h3', {}, 'Editing ' + D.meta.name),
    el('div', { class: 'note' }, 'The tools below work on this streamed dataset at full resolution (' + fmtN(D.meta.points) + ' points), over ' + edRegionText() + '. ' + (edRegion() ? '' : 'Draw a box (LOD panel) to work on part of it. ') + 'Changes go into edits.bin next to dataset.json; the converted files are never changed.'),
    dsSel ? el('div', { class: 'row' }, el('span', { class: 'hint' }, 'Dataset'), dsSel) : null,
    el('div', { class: 'row' }, el('span', { class: 'hint' }, nE ? nE + ' tile' + (nE > 1 ? 's' : '') + ' edited' + (E.dirty ? ' (not saved)' : '') : 'No edits yet'),
      el('button', { class: 'btn small', disabled: !(E.undo && E.undo.length), onclick: () => edUndo(D) }, 'Undo' + (E.undo && E.undo.length ? ': ' + E.undo[E.undo.length - 1].what : '')),
      el('button', { class: 'btn small primary', disabled: !E.dirty, onclick: () => lodSaveProject(D.P) }, 'Save edits'), el('button', { class: 'btn small danger', disabled: !nE, onclick: () => edDiscard(D) }, 'Remove all edits')),
    el('div', { class: 'row' }, el('span', { class: 'hint' }, 'Or copy it into a layer:'), el('button', { class: 'btn small', onclick: () => extractToLayer(D, 'sample') }, 'Sample → layer'), el('button', { class: 'btn small', onclick: () => extractToLayer(D, 'box') }, 'Box → layer')));
  if (old) old.replaceWith(box); else p.prepend(box);
  // enable the tools and say what they do here
  for (const b of p.querySelectorAll('button')) { const t = b.textContent;
    if (/^(Filter → new layer|Classify|Spatial → new layer|Random → new layer|Find people|Ground, trees, buildings, roads|Apply)$/.test(t)) b.disabled = false;
    if (t === 'Plant and structure by type') b.disabled = !S.cad;
    if (t === 'Filter → new layer') b.textContent = 'Remove noise';
    if (/^Hide as class 77|^Remove/.test(t) && S.people && S.people.lod) b.disabled = false; }
  const tgt = [...p.querySelectorAll('.note')].find(n => /^Working on:/.test(n.textContent)); if (tgt) tgt.replaceChildren('Working on: ', el('b', {}, D.meta.name + ' (streamed)'));
  const tr = [...p.querySelectorAll('.sec')].find(s => /Transform layer/.test(s.textContent)); if (tr) tr.querySelector('.note').textContent = 'Shifts the whole streamed dataset (ΔE, ΔN, ΔZ). Rotating or scaling a converted dataset is not possible here; extract an area to a layer for that.';
};

// while a tool runs over a dataset, the 3D view waits (drawing every frame would slow the job down)
const _drawEd = draw; draw = function () { if (ED.pause) { S.dirty = true; return; } return _drawEd(); };

// ----- one colour switch for everything in view: RGB, classification, elevation or intensity (toolbar) -----
function colourAll(mode) {
  let skipped = [];
  for (const L of S.layers) { if (L.kind !== 'cloud') continue; const ok = mode === 'elevation' || (mode === 'rgb' && L.rgb) || (mode === 'class' && L.cls) || (mode === 'intensity' && L.intensity); if (ok) { L.colorMode = mode; colorize(L); } else skipped.push(L.name); }
  for (const D of lodDatasets()) { const at = D.meta.attributes.map(a => a.name); const ok = mode === 'elevation' || (mode === 'rgb' && at.includes('rgb')) || (mode === 'class' && (at.includes('classification') || D.edCls)) || (mode === 'intensity' && at.includes('intensity')); if (ok) { D.colorMode = mode; lodRecolor(D); } else skipped.push(D.meta.name); }
  try { refreshProps(); buildLodPanel(); } catch (e) { } S.dirty = true;
  if (skipped.length) toast(skipped.join(', ') + ' ' + (skipped.length > 1 ? 'have' : 'has') + ' no ' + ({ rgb: 'RGB colour', class: 'classes', intensity: 'intensity' }[mode] || mode) + ', so ' + (skipped.length > 1 ? 'they keep' : 'it keeps') + ' its colours.');
}
function colourAllSync() { const sel = $('#colAll'); if (!sel || document.activeElement === sel) return; const modes = new Set([...S.layers.filter(L => L.kind === 'cloud').map(L => L.colorMode), ...lodDatasets().map(D => D.colorMode)]); sel.value = modes.size === 1 && ['rgb', 'class', 'elevation', 'intensity'].includes([...modes][0]) ? [...modes][0] : ''; }
{ const sel = $('#colAll'); if (sel) sel.addEventListener('change', () => { if (sel.value) colourAll(sel.value); }); }
{ const _rp = refreshProps; refreshProps = function () { const r = _rp.apply(this, arguments); try { colourAllSync(); } catch (e) { } return r; }; }
{ const _bl = buildLodPanel; buildLodPanel = function () { const r = _bl.apply(this, arguments); try { colourAllSync(); } catch (e) { } return r; }; }
