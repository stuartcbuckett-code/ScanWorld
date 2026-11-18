// ---------- nothing lost on a crash ----------
// 1. LOD projects save themselves: every 30 s, changes (annotations, measurements, views, boxes, edits) are written into the project folder
//    when ScanBench may write there (a folder you allowed, or scanlod view).
// 2. Everything else is kept in this browser as a recovery copy, refreshed when something changes: point cloud and mesh layers (with their
//    classes), annotations, measurements, views, groups, Scan to CAD results, and any LOD project changes that could not be written.
//    When ScanBench starts after closing with unsaved work, it offers to bring it all back.
const REC = { pending: true, db: null, busy: false, last: '', hashes: new Map(), timer: 0, autosave: true, quiet: 0, lastSave: 0 };
try { if (localStorage.getItem('sb-autosave') === '0') REC.autosave = false; } catch (e) { }
function recDB() {
  if (REC.db) return REC.db;
  REC.db = new Promise((res, rej) => { const r = indexedDB.open('scanbench-recovery', 1); r.onupgradeneeded = () => { r.result.createObjectStore('meta'); r.result.createObjectStore('blobs'); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return REC.db;
}
async function recTx(stores, mode, fn) { const db = await recDB(); return new Promise((res, rej) => { const t = db.transaction(stores, mode); let out; Promise.resolve(fn(t)).then(v => { out = v; }); t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); }
const recReq = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
function recHash(a, step) { if (!a) return 0; let h = a.length | 0; const s = step || Math.max(1, Math.floor(a.length / 20000)); for (let i = 0; i < a.length; i += s) h = (Math.imul(h, 31) + (a[i] * 1000 | 0)) | 0; return h; }
function recLayerHash(L) { return L.kind === 'cloud' ? [L.n, recHash(L.pos), recHash(L.cls, 1 + (L.n >> 22)), recHash(L.rgb), L.name, L.colorMode, [...(L.hiddenCls || [])].join(',')].join('|') : [L.tris.length, recHash(L.tris), L.name].join('|'); }
const recKeep = L => !L.sample && !L.model && (L.kind === 'cloud' || L.kind === 'mesh');
function recLayerBlob(L) {
  if (L.kind === 'mesh') return new Blob([L.tris.buffer.slice(L.tris.byteOffset, L.tris.byteOffset + L.tris.length * 4)]);
  const parts = [L.pos.subarray(0, L.n * 3)]; if (L.rgb) parts.push(L.rgb.subarray(0, L.n * 3)); if (L.intensity) parts.push(L.intensity.subarray(0, L.n)); if (L.cls) parts.push(L.cls.subarray(0, L.n));
  return new Blob(parts.map(a => a.slice().buffer));
}
function recUnsaved() {
  const lod = lodDatasets().some(D => D.ed && D.ed.dirty) || LP.projects.some(P => P.dirty);
  const own = x => !x._p;
  return S.layers.some(recKeep) || lod || S.annots.some(own) || S.measures.some(own) || S.bookmarks.some(own) || !!S.cad;
}
// ----- the recovery copy -----
async function recSnapshot(reason) { REC.chain = (REC.chain || Promise.resolve()).then(() => recSnapshot1(reason)).catch(() => { }); return REC.chain; }   // one at a time, none dropped
async function recSnapshot1(reason) {
  if (REC.pending || REC.busy || !S.origin) return; REC.busy = true;
  try {
    if (!recUnsaved()) { await recClear(); return; }
    const layers = S.layers.filter(recKeep); const own = x => !x._p;
    let st = null; try { st = projectState(); } catch (e) { }
    if (st) { const pick = (arr, src) => arr.filter((_, i) => own(src[i])); st.annotations = pick(st.annotations, S.annots); st.measurements = pick(st.measurements, S.measures); st.bookmarks = pick(st.bookmarks, S.bookmarks); }
    const lod = [];
    for (const P of LP.projects) {
      const st0 = P.store; const ref = st0 instanceof LDirStore ? { kind: 'dir', handle: st0.h } : st0 instanceof LHttpStore ? { kind: 'url', url: st0.base + (st0.projectFile || 'project.json') } : null; if (!ref) continue;
      const eds = []; for (const D of lodDatasets().filter(D => D.P === P)) { const E = D.ed; if (!E || !E.dirty) continue; const nodes = {}; for (const [k, v] of E.bytes) nodes[k] = v ? new Blob([v]) : null; eds.push({ path: D.entry.path, nodes, cls: !!D.edCls, log: E.log }); }
      lod.push({ ref, name: P.name, dirty: !!P.dirty, project: P.dirty ? lodProjectJSON(P) : null, edits: eds });
    }
    const meta = { time: Date.now(), reason, origin: S.origin, crs: S.crs || '', state: st, lod, layers: layers.map(L => ({ key: 'L' + L.id, name: L.name, kind: L.kind, n: L.n || 0, has: L.kind === 'cloud' ? { rgb: !!L.rgb, intensity: !!L.intensity, cls: !!L.cls } : null, colorMode: L.colorMode, hiddenCls: L.hiddenCls ? [...L.hiddenCls] : [], visible: L.visible !== false, meta: L.meta || {}, hash: recLayerHash(L) })) };
    const sig = JSON.stringify([meta.state, meta.lod.map(x => [x.name, x.dirty, x.project, x.edits.map(e => Object.keys(e.nodes).length)]), meta.layers.map(l => l.hash), meta.crs]);
    if (sig === REC.last) return;
    // big arrays only when they changed
    const changed = layers.filter(L => REC.hashes.get('L' + L.id) !== recLayerHash(L));
    for (const L of changed) { const h = recLayerHash(L), b = recLayerBlob(L); await recTx(['blobs'], 'readwrite', t => { t.objectStore('blobs').put(b, 'L' + L.id); }); REC.hashes.set('L' + L.id, h); }   // the hash of what was copied, not of what the layer is now
    await recTx(['meta', 'blobs'], 'readwrite', async t => { t.objectStore('meta').put(meta, 'snap'); const keys = await recReq(t.objectStore('blobs').getAllKeys()); for (const k of keys) if (!layers.some(L => 'L' + L.id === k)) t.objectStore('blobs').delete(k); });
    REC.last = sig; try { localStorage.setItem('sb-rec', '1'); } catch (e) { } recBadge('Recovery copy saved ' + new Date().toLocaleTimeString());
  } catch (e) { console.warn('recovery copy', e); }
  finally { REC.busy = false; }
}
async function recClear() { try { localStorage.removeItem('sb-rec'); } catch (e) { } try { await recTx(['meta', 'blobs'], 'readwrite', t => { t.objectStore('meta').clear(); t.objectStore('blobs').clear(); }); REC.last = ''; REC.hashes.clear(); } catch (e) { } }
// ----- LOD projects: write changes into their folder -----
async function recAutosave() {
  if (!REC.autosave) return;
  for (const P of LP.projects) {
    const dirty = P.dirty || lodDatasets().some(D => D.P === P && D.ed && D.ed.dirty); if (!dirty) continue;
    const st = P.store; let ok = false; try { ok = st && st.write && (st instanceof LDirStore ? (await st.h.queryPermission({ mode: 'readwrite' })) === 'granted' : !!(await st.canWrite())); } catch (e) { }
    if (!ok) continue;
    const t = toast; REC.quiet++; toast = (m, err) => { if (err) t(m, err); }; try { await lodSaveProject(P); REC.lastSave = Date.now(); recBadge('Saved ' + P.name + ' ' + new Date().toLocaleTimeString()); } catch (e) { } finally { toast = t; REC.quiet--; }
  }
}
function recBadge(text) { const b = $('#recBadge'); if (b) { b.textContent = '✓ ' + text; b.title = text; } }
// ----- coming back -----
async function recOffer() {
  let meta = null; try { meta = await recTx(['meta'], 'readonly', t => recReq(t.objectStore('meta').get('snap'))); } catch (e) { REC.pending = false; return; }
  if (!meta || (!meta.layers.length && !meta.lod.length && !(meta.state && (meta.state.annotations.length || meta.state.measurements.length || meta.state.bookmarks.length || meta.state.cad)))) { REC.pending = false; return; }
  const what = []; if (meta.layers.length) what.push(meta.layers.length + ' layer' + (meta.layers.length > 1 ? 's' : '') + ' (' + fmtN(meta.layers.reduce((a, l) => a + l.n, 0)) + ' points)');
  const st = meta.state || {}; const nA = (st.annotations || []).length + (st.measurements || []).length + (st.bookmarks || []).length; if (nA) what.push(nA + ' annotations, measurements and views'); if (st.cad) what.push('Scan to CAD results');
  for (const x of meta.lod) { const ne = x.edits.reduce((a, e) => a + Object.keys(e.nodes).length, 0); if (x.dirty || ne) what.push('unsaved changes to ' + x.name + (ne ? ' (' + ne + ' edited tiles)' : '')); else what.push('project ' + x.name); }
  const card = el('div', { role: 'dialog', 'aria-label': 'Restore your work', style: 'position:fixed;inset:0;z-index:160;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);padding:16px' });
  const go = el('button', { class: 'btn primary', 'data-instant': '', style: 'font-size:15px;padding:9px 16px' }, 'Restore'), no = el('button', { class: 'btn', 'data-instant': '' }, 'Start fresh'), msg = el('div', { class: 'hint' });
  card.append(el('div', { style: 'background:var(--panel,#fff);color:var(--ink,#111);border-radius:14px;padding:22px 24px;max-width:480px;width:100%;box-shadow:0 12px 40px rgba(0,0,0,.3);display:flex;flex-direction:column;gap:10px' },
    el('div', { style: 'font-size:18px;font-weight:600' }, 'Bring back your last session?'), el('div', { class: 'note' }, 'ScanBench closed with work that was not saved (recovery copy from ' + new Date(meta.time).toLocaleString() + '):'),
    el('ul', { style: 'margin:0;padding-left:18px;font-size:13px' }, ...what.map(w => el('li', {}, w))), msg, el('div', { class: 'row' }, go, no)));
  document.body.append(card); go.focus();
  no.addEventListener('click', async () => { card.remove(); await recClear(); REC.pending = false; });
  go.addEventListener('click', async () => { go.disabled = no.disabled = true; msg.textContent = 'Restoring…'; try { await recRestore(meta); card.remove(); REC.pending = false; REC.last = ''; setTimeout(() => recSnapshot('restored'), 500); } catch (e) { msg.textContent = 'Could not restore everything: ' + e.message; go.disabled = no.disabled = false; } });
}
async function recRestore(meta) {
  await busy('Restoring your last session…', async onP => {
    if (!S.origin || (S.sample && !S.layers.some(L => !L.sample))) S.origin = meta.origin.slice(); if (meta.crs && !S.crs) { S.crs = meta.crs; try { updateCrsStatus(); } catch (e) { } }
    try { if (S.sample) { dropSample(); if (!S.layers.length && !(S.streams || []).length) S.origin = meta.origin.slice(); } } catch (e) { }
    // LOD projects first (they bring their own annotations), then their unsaved changes
    for (const x of meta.lod) {
      try {
        if (x.ref.kind === 'dir') { const h = x.ref.handle; if ((await h.queryPermission({ mode: 'readwrite' })) !== 'granted') await h.requestPermission({ mode: 'readwrite' }); await lodOpenStore(new LDirStore(h)); }
        else await lodOpenUrl(x.ref.url);
        const P = LP.projects[LP.projects.length - 1];
        for (const e of x.edits) { const D = lodDatasets().find(D => D.P === P && D.entry.path === e.path); if (!D) continue; const E = edState(D); for (const [k, b] of Object.entries(e.nodes)) { E.bytes.set(k, b ? new Uint8Array(await b.arrayBuffer()) : null); E.cache.delete(k); if (D.loaded.has(k)) lodDrop(D, k); } E.dirty = true; E.log = e.log || E.log; if (e.cls) D.edCls = true; markDirty(P); }
        if (x.project && P) { S.annots.filter(a => a._p === P.id).forEach(a => removeAnnotation(a)); S.measures = S.measures.filter(m => m._p !== P.id); S.bookmarks = S.bookmarks.filter(b => b._p !== P.id); await lodApplyState(x.project, P); markDirty(P); }
      } catch (e) { toast('Could not reopen ' + x.name + ': ' + e.message, true); }
    }
    let k = 0;
    for (const l of meta.layers) {
      const b = await recTx(['blobs'], 'readonly', t => recReq(t.objectStore('blobs').get(l.key))); if (!b) continue; const buf = await b.arrayBuffer(); let o = 0; const take = (C, len) => { const a = new C(buf.slice(o, o + len * C.BYTES_PER_ELEMENT)); o += len * C.BYTES_PER_ELEMENT; return a; };
      if (l.kind === 'mesh') { const t = new Float32Array(buf); const w = new Float64Array(t.length); for (let i = 0; i < t.length; i++) w[i] = t[i] + S.origin[i % 3]; addMesh(l.name, w, l.meta, 1); }
      else { const pos = take(Float32Array, l.n * 3), rgb = l.has.rgb ? take(Uint8Array, l.n * 3) : null, intensity = l.has.intensity ? take(Float32Array, l.n) : null, cls = l.has.cls ? take(Uint8Array, l.n) : null;
        const L = addCloud(l.name, { n: l.n, pos, rgb, intensity, cls, origin: S.origin, meta: l.meta }); if (l.colorMode) L.colorMode = l.colorMode; if (l.hiddenCls.length) { L.hiddenCls = new Set(l.hiddenCls); applyClassHide(L); } colorize(L); if (!l.visible) { L.visible = false; L.obj.visible = false; } }
      onP(++k / Math.max(1, meta.layers.length));
    }
    if (meta.state) { try { loadProjectObj(meta.state); } catch (e) { console.warn(e); } }
    refreshLayers(); fitAll(); return true;
  });
  toast('Your last session is back. Save it (project file, LOD project, or exports) when you are ready.');
}
// ----- schedule -----
function recStart() {
  const bar = $('#stOrigin'); if (bar && !$('#recBadge')) { const b = el('span', { id: 'recBadge', class: 'hint', style: 'margin-left:10px;white-space:nowrap' }); bar.after(b); }
  clearInterval(REC.timer); REC.timer = setInterval(async () => { await recAutosave(); await recSnapshot('timer'); }, 30000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { recAutosave(); recSnapshot('hidden'); } });
  window.addEventListener('beforeunload', e => { recSnapshot('close'); if (lodDatasets().some(D => D.ed && D.ed.dirty) || LP.projects.some(P => P.dirty)) { e.preventDefault(); e.returnValue = ''; } });
}
// big jobs finished: take a copy straight away rather than waiting for the timer
{ const _busy = busy; busy = async function (label, fn) { const r = await _busy(label, fn); if (r && !/Restoring/.test(label)) setTimeout(() => recSnapshot('after ' + label), 500); return r; }; }
setTimeout(() => { recStart(); recOffer(); }, 1200);
