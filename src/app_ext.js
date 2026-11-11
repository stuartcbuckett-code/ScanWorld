// ===== ScanBench app extension: worker pool, coordinates, scan to CAD, topo (inserted into app.js scope) =====
const C_ = window.SBC, T_ = window.SBT, X_ = window.SBX;

// ---------- multi-core worker pool ----------
const WORKER_MAIN = `self.onmessage = async e => { const { id, task, a } = e.data; try { let r, tr = [];
  if (task === 'ping') r = 'pong';
  else if (task === 'c2c') { r = await SBA.c2c(a.cmp, a.nc, a.ref, a.nr, { maxDist: a.maxDist }); tr = [r.buffer]; }
  else if (task === 'c2m') { r = await SBA.c2m(a.cmp, a.nc, a.tris, { maxDist: a.maxDist, signed: a.signed }); tr = [r.buffer]; }
  else if (task === 'normals') { const N = await SBC.computeNormals(a.P, a.n, a.k); r = { nrm: N.nrm, curv: N.curv, nbr: N.nbr }; tr = [N.nrm.buffer, N.curv.buffer, N.nbr.buffer]; }
  else if (task === 'crs') { self.__sbLocalGrids = a.locals || []; SBX.convertArray(a.arr, a.n, a.from, a.to); r = a.arr; tr = [r.buffer]; }
  self.postMessage({ id, r }, tr); } catch (err) { self.postMessage({ id, err: String(err && err.message || err) }); } };`;
const POOL = { size: Math.max(1, Math.min(16, navigator.hardwareConcurrency || 4)), ws: [], free: [], queue: [], cbs: new Map(), seq: 0, ok: null };
async function poolReady() {
  if (POOL.ok !== null) return POOL.ok;
  try {
    const src = $$('script[data-lib]').map(s => s.textContent).join('\n;\n') + '\n' + WORKER_MAIN;
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    for (let i = 0; i < POOL.size; i++) {
      const w = new Worker(url);
      w.onmessage = ev => { const cb = POOL.cbs.get(ev.data.id); POOL.cbs.delete(ev.data.id); POOL.free.push(w); pump(); if (cb) ev.data.err ? cb.rej(new Error(ev.data.err)) : cb.res(ev.data.r); };
      w.onerror = ev => { ev.preventDefault && ev.preventDefault(); };
      POOL.ws.push(w); POOL.free.push(w);
    }
    const t = await Promise.race([poolRun('ping', {}), new Promise(r => setTimeout(() => r('timeout'), 4000))]);
    POOL.ok = t === 'pong';
  } catch (e) { POOL.ok = false; }
  if (!POOL.ok) { POOL.ws.forEach(w => w.terminate()); POOL.ws = []; POOL.free = []; }
  $('#stCores') && ($('#stCores').textContent = POOL.ok ? POOL.size + ' cores' : '1 core');
  return POOL.ok;
}
function pump() { while (POOL.free.length && POOL.queue.length) { const w = POOL.free.pop(), j = POOL.queue.shift(); POOL.cbs.set(j.id, j); w.postMessage({ id: j.id, task: j.task, a: j.a }, j.tr || []); } }
function poolRun(task, a, tr) { return new Promise((res, rej) => { POOL.queue.push({ id: ++POOL.seq, task, a, tr, res, rej }); pump(); }); }
// split along the longest axis into slabs of roughly equal point counts
function slabCuts(pos, n, k, axis) {
  const m = Math.min(n, 100000), st = n / m, v = new Float32Array(m); for (let j = 0; j < m; j++) v[j] = pos[Math.floor(j * st) * 3 + axis]; v.sort();
  const cuts = [-Infinity]; for (let s = 1; s < k; s++) cuts.push(v[Math.floor(s / k * (m - 1))]); cuts.push(Infinity); return cuts;
}
function longestAxis(box) { const s = box.getSize(new THREE.Vector3()); return s.x >= s.y && s.x >= s.z ? 0 : s.y >= s.z ? 1 : 2; }
function slabIndex(cuts, v) { let lo = 0, hi = cuts.length - 2; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (v >= cuts[mid]) lo = mid; else hi = mid - 1; } return lo; }
async function parC2C(L, R, maxD, onP) {
  if (!(await poolReady()) || L.n < 200000) return AL.c2c(L.pos, L.n, R.pos, R.n, { maxDist: maxD, onProgress: onP });
  const k = POOL.size * 2, ax = longestAxis(L.box), cuts = slabCuts(L.pos, L.n, k, ax);
  const cI = Array.from({ length: k }, () => []), rI = Array.from({ length: k }, () => []);
  for (let i = 0; i < L.n; i++) cI[slabIndex(cuts, L.pos[i * 3 + ax])].push(i);
  for (let i = 0; i < R.n; i++) { const v = R.pos[i * 3 + ax], a = slabIndex(cuts, v - maxD), b = slabIndex(cuts, v + maxD); for (let s = a; s <= b; s++) rI[s].push(i); }
  const out = new Float32Array(L.n).fill(NaN); let done = 0;
  await Promise.all(cI.map(async (ci, s) => {
    if (!ci.length) { done++; return; }
    const cmp = C_.gather(L.pos, ci), ref = C_.gather(R.pos, rI[s]);
    const d = rI[s].length ? await poolRun('c2c', { cmp, nc: ci.length, ref, nr: rI[s].length, maxDist: maxD }, [cmp.buffer, ref.buffer]) : new Float32Array(ci.length).fill(NaN);
    for (let j = 0; j < ci.length; j++) out[ci[j]] = d[j]; onP(++done / k);
  }));
  return out;
}
async function parC2M(L, M, maxD, signed, onP) {
  if (!(await poolReady()) || L.n < 100000) return AL.c2m(L.pos, L.n, M.tris, { maxDist: maxD, signed, onProgress: onP });
  const k = POOL.size * 2, ax = longestAxis(L.box), cuts = slabCuts(L.pos, L.n, k, ax);
  const cI = Array.from({ length: k }, () => []), tI = Array.from({ length: k }, () => []);
  for (let i = 0; i < L.n; i++) cI[slabIndex(cuts, L.pos[i * 3 + ax])].push(i);
  const T = M.tris, nt = T.length / 9;
  for (let t = 0; t < nt; t++) { let lo = Infinity, hi = -Infinity; for (let v = 0; v < 3; v++) { const q = T[t * 9 + v * 3 + ax]; if (q < lo) lo = q; if (q > hi) hi = q; } const a = slabIndex(cuts, lo - maxD), b = slabIndex(cuts, hi + maxD); for (let s = a; s <= b; s++) tI[s].push(t); }
  const out = new Float32Array(L.n).fill(NaN); let done = 0;
  await Promise.all(cI.map(async (ci, s) => {
    if (!ci.length) { done++; return; }
    const cmp = C_.gather(L.pos, ci); const tris = new Float32Array(tI[s].length * 9); tI[s].forEach((t, j) => tris.set(T.subarray(t * 9, t * 9 + 9), j * 9));
    const d = tI[s].length ? await poolRun('c2m', { cmp, nc: ci.length, tris, maxDist: maxD, signed }, [cmp.buffer, tris.buffer]) : new Float32Array(ci.length).fill(NaN);
    for (let j = 0; j < ci.length; j++) out[ci[j]] = d[j]; onP(++done / k);
  }));
  return out;
}
// kNN normals across workers; margin must exceed the k-th neighbour distance
function parNormalsFn(margin) {
  return async (P, m, k, onP) => {
    const ok = await poolReady();
    if (!ok || m < 60000) return C_.computeNormals(P, m, k, onP);
    const box = new THREE.Box3(); for (let i = 0; i < m; i += Math.max(1, Math.floor(m / 50000))) box.expandByPoint(new THREE.Vector3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]));
    const ax = longestAxis(box), ns = POOL.size * 2, cuts = slabCuts(P, m, ns, ax);
    const sub = Array.from({ length: ns }, () => []);
    for (let i = 0; i < m; i++) { const v = P[i * 3 + ax], a = slabIndex(cuts, v - margin), b = slabIndex(cuts, v + margin); for (let s = a; s <= b; s++) sub[s].push(i); }
    const nrm = new Float32Array(m * 3), curv = new Float32Array(m), nbr = new Int32Array(m * k); let done = 0;
    const jobs = sub.map(async (si, s) => {
      if (!si.length) return; const Q = C_.gather(P, si);
      const r = await poolRun('normals', { P: Q, n: si.length, k }, [Q.buffer]);
      for (let j = 0; j < si.length; j++) { const g = si[j], v = P[g * 3 + ax]; if (v < cuts[s] || v >= cuts[s + 1]) continue; nrm[g * 3] = r.nrm[j * 3]; nrm[g * 3 + 1] = r.nrm[j * 3 + 1]; nrm[g * 3 + 2] = r.nrm[j * 3 + 2]; curv[g] = r.curv[j]; for (let q = 0; q < k; q++) { const l = r.nbr[j * k + q]; nbr[g * k + q] = l < 0 ? -1 : si[l]; } }
      onP(0.25 + 0.75 * (++done / ns));
    });
    const K = await AL.buildKD(P, m, f => onP(f * 0.25));
    await Promise.all(jobs);
    return { K, nrm, curv, nbr, k };
  };
}
async function parCRS(arr, n, from, to, onP) {
  const locals = S.localGrids || [];
  if (!(await poolReady()) || n < 50000) { X_.convertArray(arr, n, from, to, onP); return arr; }
  const k = POOL.size, step = Math.ceil(n / k); let done = 0; const parts = [];
  for (let s = 0; s < k; s++) { const a = s * step, b = Math.min(n, a + step); if (a >= b) break; parts.push([a, b]); }
  await Promise.all(parts.map(async ([a, b]) => { const sl = arr.slice(a * 3, b * 3); const r = await poolRun('crs', { arr: sl, n: b - a, from, to, locals }, [sl.buffer]); arr.set(r, a * 3); onP && onP(++done / parts.length); }));
  return arr;
}
// use the pool for the existing compare tools
runC2C = async function (L, R, maxD) {
  if (!R) { toast('Pick a reference cloud.', true); return; }
  const d = await busy('Cloud-to-cloud distances on ' + POOL.size + ' cores…', onP => parC2C(L, R, maxD, onP)); if (!d) return;
  addSF(L, 'C2C to ' + R.name, d, false); refreshProps(); buildCompare(); $$('.tab').find(x => x.dataset.tab === 'compare').click();
};
runC2M = async function (L, M, maxD, signed) {
  if (!M) { toast('Load a design mesh first.', true); return; }
  const d = await busy('Distances to design on ' + POOL.size + ' cores…', onP => parC2M(L, M, maxD, signed, onP)); if (!d) return;
  const nm = (signed ? 'Deviation from ' : 'Distance to ') + M.name; addSF(L, nm, d, signed); L.sfStyle[nm].tol = L.sfStyle[nm].tol || 0.01; refreshProps(); buildCompare(); $$('.tab').find(x => x.dataset.tab === 'compare').click();
};

// ---------- coordinate systems ----------
try { S.localGrids = JSON.parse(localStorage.getItem('sb-local-grids') || '[]'); } catch (e) { S.localGrids = []; }
window.__sbLocalGrids = S.localGrids;
S.crs = '';
function saveLocals() { window.__sbLocalGrids = S.localGrids; try { localStorage.setItem('sb-local-grids', JSON.stringify(S.localGrids)); } catch (e) { } }
function crsObj(id) { return id ? X_.byId(id) : null; }
function crsLabel() { const c = crsObj(S.crs); return c ? c.name.replace(/ \(.*\)$/, '') : 'coordinate system not set'; }
function crsSelect(id, value, allowBlank) {
  const s = el('select', { id });
  if (allowBlank) s.append(el('option', { value: '' }, 'Not set (as in file)'));
  const groups = [['Geographic', x => x.type === 'geo'], ['MGA2020', x => x.id.startsWith('MGA2020')], ['MGA94', x => x.id.startsWith('MGA94')], ['WA project grids · GDA2020', x => x.type === 'tm' && x.id.endsWith('2020') && !x.id.startsWith('MGA')], ['WA project grids · GDA94', x => x.type === 'tm' && x.id.endsWith('94') && !x.id.startsWith('MGA')]];
  for (const [g, f] of groups) { const og = el('optgroup', { label: g }); X_.SYSTEMS.filter(f).forEach(x => og.append(el('option', { value: x.id, selected: x.id === value }, x.name))); s.append(og); }
  if (S.localGrids.length) { const og = el('optgroup', { label: 'Local grids' }); S.localGrids.forEach(x => og.append(el('option', { value: x.id, selected: x.id === value }, x.name))); s.append(og); }
  return s;
}
function updateCrsStatus() {
  const o = S.origin; $('#stOrigin').textContent = (S.crs ? crsLabel() + ' · ' : '') + (o ? 'origin E ' + o[0] + ' N ' + o[1] + ' Z ' + o[2] : '');
  const c = crsObj(S.crs); if (c && c.heightLimit && S.layers.length) { const b = sceneBox(); if (!b.isEmpty() && b.max.z + S.origin[2] > c.heightLimit) toast('Data reaches RL ' + (b.max.z + S.origin[2]).toFixed(0) + ' m, above the ' + c.heightLimit + ' m height limit of ' + c.id + '. Grid and ground distances may differ by more than 20 ppm.', true); }
}
const _addCloud = addCloud;
addCloud = function (name, data, extra) {
  const first = !S.origin; const L = _addCloud(name, data, extra); updateCrsStatus();
  if (first && !S.crs && !(extra && extra.sample)) { const g = X_.guessSystems(S.origin[0], S.origin[1]); if (g.length) toast('These coordinates could be ' + g.slice(0, 4).map(id => X_.byId(id).id).join(', ') + (g.length > 4 ? '…' : '') + '. Set the project coordinate system in the Coords tab.'); }
  return L;
};
function buildCoords() {
  const p = pane('coords'); if (!p) return; p.textContent = '';
  const ps = crsSelect('projCrs', S.crs, true);
  ps.addEventListener('change', () => { S.crs = ps.value; updateCrsStatus(); buildCoords(); toast(S.crs ? 'Project coordinate system: ' + crsLabel() + '. Coordinates were not changed.' : 'Project coordinate system cleared.'); });
  const c = crsObj(S.crs);
  const info = c ? el('dl', { class: 'kv' }, el('dt', {}, 'Datum'), el('dd', {}, c.datum || ('local on ' + c.parent)), ...(c.p ? [el('dt', {}, 'Central meridian'), el('dd', {}, c.p.lon0.toFixed(6) + '°'), el('dt', {}, 'Scale factor'), el('dd', {}, String(c.p.k0)), el('dt', {}, 'False E / N'), el('dd', {}, c.p.fe + ' / ' + c.p.fn)] : []), ...(c.epsg ? [el('dt', {}, 'EPSG'), el('dd', {}, String(c.epsg))] : []), ...(c.heightLimit ? [el('dt', {}, 'Height limit'), el('dd', {}, c.heightLimit + ' m')] : []), ...(c.type === 'local' ? [el('dt', {}, 'Rotation'), el('dd', {}, (c.theta * 180 / Math.PI).toFixed(6) + '°'), el('dt', {}, 'Scale'), el('dd', {}, String(c.scale))] : [])) : null;
  const s1 = el('div', { class: 'sec' }, el('h3', {}, 'Project coordinate system'), el('div', { class: 'note' }, 'Says what the loaded coordinates are in. Choosing one here labels the data and exports; it does not move any points. Use Convert below to change systems.'), fieldRow('System', ps), info);
  // convert all layers
  const to = crsSelect('convTo', '', false);
  const s2 = el('div', { class: 'sec' }, el('h3', {}, 'Convert all layers'), el('div', { class: 'note' }, 'Re-projects every cloud and mesh from the project system into another one, for example MGA94 zone 50 to MGA2020 zone 50 or PCG2020. GDA94 ↔ GDA2020 uses the conformal 7-parameter transformation (EPSG 8048, about 0.01 m). Heights are not changed.'),
    fieldRow('To', to), el('div', { class: 'row' }, el('button', { class: 'btn small primary', disabled: !S.crs || !S.layers.length, onclick: () => convertAll(S.crs, to.value) }, 'Convert')));
  // point calculator
  const cf = crsSelect('calcFrom', S.crs || 'MGA2020-50', false), ct = crsSelect('calcTo', 'GDA2020', false);
  const ce = numIn('calcE', ''), cn = numIn('calcN', ''), cz = numIn('calcZ', 0); const out = el('div', { class: 'result mono', id: 'calcOut', style: 'font-size:12px' }, 'Enter a point and press Convert.');
  const s3 = el('div', { class: 'sec' }, el('h3', {}, 'Point converter'), fieldRow('From', cf), el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:6px' }, labeled('E / long', ce), labeled('N / lat', cn), labeled('Z', cz)), fieldRow('To', ct),
    el('div', { class: 'row' }, el('button', { class: 'btn small primary', onclick: () => { try { const r = X_.convertPoint(+ce.value, +cn.value, +cz.value, cf.value, ct.value); const geo = X_.byId(ct.value).type === 'geo'; out.textContent = geo ? 'Lat ' + r[1].toFixed(9) + '  Long ' + r[0].toFixed(9) + '  h ' + r[2].toFixed(3) : 'E ' + r[0].toFixed(4) + '  N ' + r[1].toFixed(4) + '  Z ' + r[2].toFixed(4); const T = X_.byId(ct.value); if (T.p) { const g = X_.convertPoint(+ce.value, +cn.value, +cz.value, cf.value, T.datum); const sc = X_.tmScale(g[1], g[0], T.p); out.textContent += '   ·  point scale ' + sc.k.toFixed(8) + ', convergence ' + sc.convergence.toFixed(5) + '°'; } } catch (e) { out.textContent = e.message; } } }, 'Convert'),
      el('button', { class: 'btn small', onclick: () => startMode({ type: 'calcpick', text: 'Click a point to fill the converter', onPick: pk => { const w = W3(pk.p); ce.value = w[0].toFixed(4); cn.value = w[1].toFixed(4); cz.value = w[2].toFixed(4); if (S.crs) cf.value = S.crs; cancelMode(); } }) }, 'Pick from cloud')), out);
  // local grid builder
  const nm = el('input', { type: 'text', id: 'lgName', value: 'Site grid ' + (S.localGrids.length + 1) }), par = crsSelect('lgParent', S.crs && X_.byId(S.crs).type === 'tm' ? S.crs : 'MGA2020-50', false);
  par.querySelectorAll('optgroup').forEach(g => { if (g.label === 'Geographic' || g.label === 'Local grids') g.remove(); });
  S.lgPairs = S.lgPairs || [];
  const tbl = el('div', { class: 'mlist' });
  S.lgPairs.forEach((pr, i) => {
    const ins = ['lx', 'ly', 'lz', 'E', 'N', 'Z'].map((k, q) => { const e = el('input', { type: 'number', step: 'any', value: pr[q] ?? '', 'aria-label': k + ' of control ' + (i + 1), style: 'padding:0 4px' }); e.addEventListener('change', () => { pr[q] = e.value === '' ? null : +e.value; }); return e; });
    tbl.append(el('div', { style: 'display:grid;grid-template-columns:repeat(6,minmax(0,1fr)) auto;gap:4px;align-items:center' }, ...ins, el('button', { class: 'btn small icon danger', 'aria-label': 'Remove control point', onclick: () => { S.lgPairs.splice(i, 1); buildCoords(); } }, '×')));
  });
  const lgRes = S.lgFit ? el('div', { class: 'result' }, el('dl', { class: 'kv' }, el('dt', {}, 'Horizontal RMS'), el('dd', {}, mm(S.lgFit.rmsH)), el('dt', {}, 'Vertical RMS'), el('dd', {}, mm(S.lgFit.rmsV)), el('dt', {}, 'Rotation'), el('dd', {}, (S.lgFit.params.theta * 180 / Math.PI).toFixed(6) + '°'), el('dt', {}, 'Scale'), el('dd', {}, S.lgFit.params.scale.toFixed(9))), el('div', { class: 'mono hint' }, 'Residuals ΔE ΔN ΔZ (mm): ' + S.lgFit.residuals.map(r => r.map(v => (v * 1000).toFixed(1)).join(' ')).join(' | '))) : null;
  const fs = el('input', { type: 'checkbox', id: 'lgFixScale' }); fs.checked = S.lgFixScale !== false; fs.addEventListener('change', () => { S.lgFixScale = fs.checked; });
  const s4 = el('div', { class: 'sec' }, el('h3', {}, 'Local grid (metres, scale factor 1)'),
    el('div', { class: 'note' }, 'Ties a site grid to MGA or a project grid. Enter control points known in both: local x, y, z and grid E, N, Z. Two or more points fit a rotation and shift with scale held at 1, so local distances stay true ground distances.'),
    fieldRow('Name', nm), fieldRow('Tied to', par), el('div', { class: 'field' }, el('label', { for: 'lgFixScale' }, 'Hold scale at 1'), el('span', {}, fs)),
    el('div', { style: 'display:grid;grid-template-columns:repeat(6,minmax(0,1fr)) 26px;gap:4px;font-size:11px;color:var(--muted)' }, 'local x', 'local y', 'local z', 'grid E', 'grid N', 'grid Z', ''), tbl,
    el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: () => { S.lgPairs.push([null, null, null, null, null, null]); buildCoords(); } }, 'Add control point'),
      el('button', { class: 'btn small', onclick: () => startMode({ type: 'lgpick', text: 'Click a control point in the cloud (fills local x, y, z)', onPick: pk => { const w = W3(pk.p); S.lgPairs.push([+w[0].toFixed(4), +w[1].toFixed(4), +w[2].toFixed(4), null, null, null]); cancelMode(); buildCoords(); } }) }, 'Pick local point'),
      el('button', { class: 'btn small primary', onclick: () => { try { const ok = S.lgPairs.filter(r => r.every(v => v !== null && isFinite(v))); S.lgFit = X_.fitLocal(ok.map(r => r.slice(0, 3)), ok.map(r => r.slice(3, 6)), S.lgFixScale !== false); buildCoords(); } catch (e) { toast(e.message, true); } } }, 'Fit'),
      el('button', { class: 'btn small', disabled: !S.lgFit, onclick: () => { const id = 'LOCAL-' + Date.now().toString(36); S.localGrids.push(Object.assign({ id, name: nm.value || id, type: 'local', parent: par.value, datum: X_.byId(par.value).datum }, S.lgFit.params)); saveLocals(); S.lgFit = null; S.lgPairs = []; toast('Saved local grid ' + nm.value + '. It is now in every system list.'); buildCoords(); } }, 'Save grid')), lgRes,
    S.localGrids.length ? el('div', { class: 'mlist' }, ...S.localGrids.map(g => el('div', { class: 'mitem' }, el('div', {}, el('div', { class: 't' }, 'local grid on ' + g.parent), el('div', { class: 'v' }, g.name + ' · rot ' + (g.theta * 180 / Math.PI).toFixed(4) + '° · scale ' + g.scale)), el('button', { class: 'btn small icon danger', 'aria-label': 'Delete local grid', onclick: () => { S.localGrids = S.localGrids.filter(x => x !== g); saveLocals(); buildCoords(); } }, '×')))) : null);
  p.append(s1, s2, s3, s4);
}
async function convertAll(from, to) {
  if (!from || !to || from === to) { toast('Choose a different target system.', true); return; }
  const res = await busy('Converting ' + S.layers.length + ' layers to ' + X_.byId(to).id + '…', async onP => {
    const worlds = []; let tot = 0; for (const L of S.layers) tot += L.kind === 'cloud' ? L.n : L.tris.length / 3; let done = 0;
    for (const L of S.layers) {
      const P = L.kind === 'cloud' ? L.pos : L.tris, m = L.kind === 'cloud' ? L.n : P.length / 3; const w = new Float64Array(m * 3);
      for (let i = 0; i < m; i++) { w[i * 3] = P[i * 3] + S.origin[0]; w[i * 3 + 1] = P[i * 3 + 1] + S.origin[1]; w[i * 3 + 2] = P[i * 3 + 2] + S.origin[2]; }
      await parCRS(w, m, from, to, f => onP((done + f * m) / tot)); done += m; worlds.push(w);
    }
    const w0 = worlds[0]; const no = [Math.floor(w0[0]), Math.floor(w0[1]), Math.floor(w0[2])];
    S.layers.forEach((L, k) => { const P = L.kind === 'cloud' ? L.pos : L.tris, w = worlds[k]; for (let i = 0; i < w.length; i++) P[i] = w[i] - no[i % 3]; });
    S.origin = no; return true;
  });
  if (!res) return;
  for (const L of S.layers) posChanged(L);
  clearMeasures(); clearCad(); clearTopo(); S.section = null; S.raster = null;
  S.clip.on = false; S.crs = to; updateCrsStatus(); fitAll(); refreshAllPanes(); buildMeasure();
  toast('Converted all layers to ' + crsLabel() + '. Measurements and extracted results were cleared because their coordinates changed.');
}

// ---------- shared 3D helpers ----------
function facesMesh(faces, color, opacity = 0.9) {
  const pos = new Float32Array(faces.length * 18); let o = 0;
  for (const q of faces) { const tri = (a, b, c) => { for (const p of [a, b, c]) { pos[o++] = p[0]; pos[o++] = p[1]; pos[o++] = p[2]; } }; tri(q[0], q[1], q[2]); tri(q[0], q[2], q[3] || q[2]); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, o), 3)); g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 })); m.renderOrder = 3; return m;
}
function linesObj(polys, color, closed) {
  const arr = []; for (const pl of polys) { for (let i = 0; i < pl.length - 1; i++) arr.push(...pl[i], ...pl[i + 1]); if (closed && pl.length > 2) arr.push(...pl[pl.length - 1], ...pl[0]); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
  const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color })); l.renderOrder = 4; return l;
}
const wpt = p => [p[0] + S.origin[0], p[1] + S.origin[1], p[2] + S.origin[2]];
const dxfComment = what => 'ScanBench ' + what + '\nCoordinate system: ' + crsLabel() + '\nCreated ' + new Date().toISOString() + '\nAutomatically extracted from a point cloud: check before use.';

// (Scan to CAD lives in app_cad.js)

// ---------- TOPO ----------
S.topo = null;
function clearTopo() { if (S.topoObj) annot.remove(S.topoObj); S.topoObj = null; S.topo = null; S.topoContours = null; S.dirty = true; }
function drawTopo() {
  if (S.topoObj) annot.remove(S.topoObj); const t = S.topo; if (!t) return; const g = new THREE.Group(); const vis = S.topoVis || (S.topoVis = { tin: true, brk: true, cont: true, feat: true, spot: false });
  if (vis.tin) { const pos = new Float32Array(t.tin.tris.length * 3); for (let i = 0; i < t.tin.tris.length; i++) { const p = t.tin.pts[t.tin.tris[i]]; pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2]; } const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.computeVertexNormals(); const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0xc9b48a, side: THREE.DoubleSide, transparent: true, opacity: 0.55, depthWrite: false })); m.renderOrder = 2; g.add(m); }
  if (vis.brk) { g.add(linesObj(t.breaklines.filter(b => b.kind === 'top').map(b => b.pts), 0xff4040)); g.add(linesObj(t.breaklines.filter(b => b.kind === 'toe').map(b => b.pts), 0x3a7bff)); }
  if (vis.cont && S.topoContours) { g.add(linesObj(S.topoContours.filter(c => !c.major).map(c => c.pts), 0xffd27a)); g.add(linesObj(S.topoContours.filter(c => c.major).map(c => c.pts), 0xff8a3d)); }
  if (vis.feat) {
    const circ = (x, y, z, r) => { const a = []; for (let k = 0; k <= 32; k++) a.push([x + Math.cos(k / 32 * 2 * Math.PI) * r, y + Math.sin(k / 32 * 2 * Math.PI) * r, z]); return a; };
    g.add(linesObj(t.trees.map(T => circ(T.x, T.y, T.groundZ + 0.05, T.spread / 2)), 0x3fbf5f));
    g.add(linesObj(t.trees.map(T => [[T.x, T.y, T.groundZ], [T.x, T.y, T.groundZ + T.height]]), 0x3fbf5f));
    g.add(linesObj(t.buildings.map(B => B.loop.map(p => [p[0], p[1], B.groundZ + 0.05])), 0xe06060, true));
    g.add(linesObj(t.poles.map(P => [[P.x, P.y, P.groundZ], [P.x, P.y, P.groundZ + P.height]]), 0xffffff));
    g.add(linesObj(t.walls.map(Wl => [[Wl.a[0], Wl.a[1], Wl.groundZ + Wl.height], [Wl.b[0], Wl.b[1], Wl.groundZ + Wl.height]]), 0xd08cff));
    if (t.extent) g.add(linesObj([T_.lineZ(t.tin, t.idxGrid, t.extent)], 0x999999, true));
  }
  if (vis.spot) { const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(t.spots.flat(), 3)); g.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 5, sizeAttenuation: false }))); }
  S.topoObj = g; annot.add(g); S.dirty = true;
}
function makeContours2() {
  const t = S.topo; if (!t) return;
  if (!S.tcInt || S.tcAuto) { S.tcAuto = true; let z0 = Infinity, z1 = -Infinity; for (const p of t.tin.pts) { if (p[2] < z0) z0 = p[2]; if (p[2] > z1) z1 = p[2]; } S.tcInt = T_.niceInterval(z1 - z0); S.tcMaj = S.tcInt === 0.25 ? 4 : 5; }
  const iv = Math.max(0.01, S.tcInt), maj = Math.max(1, S.tcMaj || 4) * iv, smooth = S.tcSmooth !== false;
  let cs = T_.tinContours(smooth ? T_.smoothTin(t.tin, 3) : t.tin, iv, -S.origin[2]);
  const minLen = smooth ? Math.max(2, 6 * (S.tTin || 0.5)) : iv, plen = c => { let s = 0; for (let i = 1; i < c.pts.length; i++) s += Math.hypot(c.pts[i][0] - c.pts[i - 1][0], c.pts[i][1] - c.pts[i - 1][1]); return s; };
  cs = cs.filter(c => plen(c) >= minLen);
  for (const c of cs) { const wl = c.level + S.origin[2]; c.major = Math.abs(wl / maj - Math.round(wl / maj)) < 1e-6; if (S.tcSmooth !== false) c.pts = T_.smoothLine(c.pts, 2); }
  S.topoContours = cs; drawTopo();
}
function buildTopo() {
  const host = pane('topo'); if (!host) return; let p = $('#topoMain'); if (!p) { p = el('div', { id: 'topoMain' }); host.prepend(p); } p.textContent = '';
  const L = S.sel && S.sel.kind === 'cloud' ? S.sel : null;
  const sp = numIn('tSp', S.tSp || 0.1), terr = el('select', { id: 'tTerr' }, ...[['0.15', 'Flat or urban'], ['0.3', 'Rolling'], ['0.7', 'Steep or hilly']].map(([v, t]) => el('option', { value: v, selected: String(S.tSlope || 0.3) === v }, t)));
  const gt = numIn('tGt', S.tGt || 0.15), tc = numIn('tTin', S.tTin || 0.5), gc = numIn('tGc', S.tGc || 20, '1'), ss = numIn('tSpot', S.tSpot || 5);
  const s1 = el('div', { class: 'sec' }, el('h3', {}, 'Topographic survey'),
    el('div', { class: 'note' }, 'Classifies ground, builds a TIN with breaklines, and picks up trees, buildings, poles, walls and fences in ', el('b', {}, L ? L.name : 'the selected cloud'), '. Classes are written back to the cloud (colour by Classification to check them).'),
    fieldRow('Analysis spacing (m)', sp), fieldRow('Terrain', terr), fieldRow('Ground tolerance (m)', gt), fieldRow('TIN spacing (m)', tc), fieldRow('Breakline grade change (%)', gc), fieldRow('Spot level grid (m)', ss),
    el('div', { class: 'row' }, el('button', { class: 'btn small primary', disabled: !L, onclick: () => { Object.assign(S, { tSp: +sp.value, tSlope: +terr.value, tGt: +gt.value, tTin: +tc.value, tGc: +gc.value, tSpot: +ss.value }); runTopo(L); } }, 'Process topo'), el('button', { class: 'btn small danger', disabled: !S.topo, onclick: () => { clearTopo(); buildTopo(); } }, 'Clear')));
  p.append(s1);
  if (!S.topo) return; const t = S.topo;
  const cnt = t.counts, tot = Object.values(cnt).reduce((a, b) => a + b, 0) || 1;
  const vis = S.topoVis || (S.topoVis = { tin: true, brk: true, cont: true, feat: true, spot: false });
  const vchk = (k, label) => { const c = el('input', { type: 'checkbox' }); c.checked = vis[k]; c.addEventListener('change', () => { vis[k] = c.checked; drawTopo(); }); return el('label', { class: 'row', style: 'gap:6px;font-size:12px' }, c, label); };
  const s2 = el('div', { class: 'sec' }, el('h3', {}, 'Result'), el('div', { class: 'result' }, el('dl', { class: 'kv' },
    el('dt', {}, 'Ground'), el('dd', {}, ((cnt[2] || 0) / tot * 100).toFixed(1) + '% of points'), el('dt', {}, 'Vegetation'), el('dd', {}, (((cnt[3] || 0) + (cnt[4] || 0) + (cnt[5] || 0)) / tot * 100).toFixed(1) + '%'), el('dt', {}, 'Buildings'), el('dd', {}, ((cnt[6] || 0) / tot * 100).toFixed(1) + '%'),
    el('dt', {}, 'TIN'), el('dd', {}, (t.tin.tris.length / 3).toLocaleString() + ' triangles'), el('dt', {}, 'Breaklines'), el('dd', {}, t.breaklines.length + ' (' + t.breaklines.filter(b => b.kind === 'top').length + ' tops, ' + t.breaklines.filter(b => b.kind === 'toe').length + ' toes)'),
    el('dt', {}, 'Trees'), el('dd', {}, String(t.trees.length)), el('dt', {}, 'Buildings'), el('dd', {}, String(t.buildings.length)), el('dt', {}, 'Poles'), el('dd', {}, String(t.poles.length)), el('dt', {}, 'Walls / fences'), el('dd', {}, String(t.walls.length)), el('dt', {}, 'Spot levels'), el('dd', {}, String(t.spots.length)),
    el('dt', {}, 'Time'), el('dd', {}, (t.ms / 1000).toFixed(1) + ' s on ' + (POOL.ok ? POOL.size : 1) + ' cores'))),
    el('div', { class: 'row' }, vchk('tin', 'TIN'), vchk('brk', 'Breaklines'), vchk('cont', 'Contours'), vchk('feat', 'Features'), vchk('spot', 'Spot levels')));
  const iv = numIn('tcInt', S.tcInt || 0.25), mj = numIn('tcMaj', S.tcMaj || 4, '1'); const sm = el('input', { type: 'checkbox', id: 'tcSm' }); sm.checked = S.tcSmooth !== false;
  const s3 = el('div', { class: 'sec' }, el('h3', {}, 'Contours'), fieldRow('Interval (m)', iv), fieldRow('Major every', mj), el('div', { class: 'field' }, el('label', { for: 'tcSm' }, 'Smooth'), el('span', {}, sm)),
    el('div', { class: 'row' }, el('button', { class: 'btn small primary', onclick: () => { Object.assign(S, { tcAuto: false, tcInt: +iv.value, tcMaj: +mj.value, tcSmooth: sm.checked }); makeContours2(); buildTopo(); } }, 'Generate')), S.topoContours ? el('div', { class: 'note' }, S.topoContours.length + ' contour lines from the TIN.') : null);
  const tinOn = el('input', { type: 'checkbox', id: 'tDxfTin' }); tinOn.checked = S.tDxfTin !== false; tinOn.addEventListener('change', () => { S.tDxfTin = tinOn.checked; });
  const s4 = el('div', { class: 'sec' }, el('h3', {}, 'Export'), el('div', { class: 'note' }, 'DXF layers: TOPO-CONT-MAJR/MINR (+ labels), TOPO-BRKL-TOP/TOE, TOPO-SPOT, TOPO-TREE, TOPO-BLDG, TOPO-POLE, TOPO-WALL, TOPO-EXTENT, TOPO-TIN. LandXML carries the TIN and breaklines for Civil 3D. Coordinates are written in ' + crsLabel() + '.'),
    el('div', { class: 'field' }, el('label', { for: 'tDxfTin' }, 'TIN faces in DXF'), el('span', {}, tinOn)),
    el('div', { class: 'row' }, el('button', { class: 'btn small primary', onclick: exportTopoDXF }, 'DXF for AutoCAD'), el('button', { class: 'btn small', onclick: exportLandXML }, 'LandXML surface'), el('button', { class: 'btn small', onclick: exportPNEZD }, 'Points CSV (PNEZD)')));
  p.append(s2, s3, s4);
}
async function runTopo(L) {
  const t0 = performance.now(); await poolReady();
  const res = await busy('Processing topo on ' + POOL.size + ' cores…', onP => T_.topoSurvey(L.pos, L.n, { spacing: Math.max(0.02, S.tSp), slope: S.tSlope, groundTol: S.tGt, tinCell: Math.max(0.1, S.tTin), gradeChange: S.tGc / 100, spotSpacing: S.tSpot, maxWindow: S.tSlope > 0.5 ? 12 : 20, normalsFn: parNormalsFn(Math.max(0.5, S.tSp * 8)) }, onP));
  if (!res) return; res.ms = performance.now() - t0; res.layer = L;
  // write classes back to the source cloud
  if (!L.cls) L.cls = new Uint8Array(L.n);
  for (let i = 0; i < L.n; i++) { const s = res.assign[i]; L.cls[i] = s >= 0 ? res.slotCls[s] : 1; }
  L.colorMode = 'class'; colorize(L); refreshProps();
  clearTopo(); S.topo = res; makeContours2(); buildTopo(); $$('.tab').find(x => x.dataset.tab === 'topo').click();
  toast('Topo done: ' + res.breaklines.length + ' breaklines, ' + res.trees.length + ' trees, ' + res.buildings.length + ' buildings, ' + res.poles.length + ' poles.');
}
function exportTopoDXF() {
  const t = S.topo; if (!t) return; const E = []; const W = p => wpt(p);
  if (S.tDxfTin !== false) for (let i = 0; i < t.tin.tris.length; i += 3) { const a = t.tin.pts[t.tin.tris[i]], b = t.tin.pts[t.tin.tris[i + 1]], c = t.tin.pts[t.tin.tris[i + 2]]; E.push({ type: '3DFACE', pts: [W(a), W(b), W(c)], layer: 'TOPO-TIN' }); }
  for (const b of t.breaklines) E.push({ type: 'POLY', pts: b.pts.map(W), layer: b.kind === 'top' ? 'TOPO-BRKL-TOP' : 'TOPO-BRKL-TOE' });
  for (const c of S.topoContours || []) {
    E.push({ type: 'POLY', pts: c.pts.map(W), layer: c.major ? 'TOPO-CONT-MAJR' : 'TOPO-CONT-MINR' });
    if (c.major) { let acc = 0; for (let i = 1; i < c.pts.length; i++) { const a = c.pts[i - 1], b = c.pts[i]; acc += Math.hypot(b[0] - a[0], b[1] - a[1]); if (acc > 40 || (i === Math.floor(c.pts.length / 2) && c.pts.length > 6 && acc > 5)) { let rot = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI; if (rot > 90) rot -= 180; if (rot < -90) rot += 180; E.push({ type: 'TEXT', p: W(b), h: 0.25, text: (c.level + S.origin[2]).toFixed(2), rot, center: true, layer: 'TOPO-CONT-TEXT' }); acc = 0; } } }
  }
  for (const s of t.spots) { E.push({ type: 'POINT', p: W(s), layer: 'TOPO-SPOT' }); E.push({ type: 'TEXT', p: W([s[0] + 0.1, s[1] + 0.1, s[2]]), h: 0.15, text: (s[2] + S.origin[2]).toFixed(2), layer: 'TOPO-SPOT-TEXT' }); }
  for (const T of t.trees) { const p = [T.x, T.y, T.groundZ]; E.push({ type: 'CIRCLE', p: W(p), r: T.spread / 2, layer: 'TOPO-TREE' }); E.push({ type: 'POINT', p: W(p), layer: 'TOPO-TREE' }); E.push({ type: 'TEXT', p: W([T.x + 0.3, T.y, T.groundZ]), h: 0.2, text: 'TREE H' + T.height.toFixed(1) + ' S' + T.spread.toFixed(1), layer: 'TOPO-TREE-TEXT' }); }
  for (const B of t.buildings) { E.push({ type: 'POLY', pts: B.loop.map(q => W([q[0], q[1], B.groundZ])), closed: true, layer: 'TOPO-BLDG' }); const c = B.loop.reduce((a, q) => [a[0] + q[0] / B.loop.length, a[1] + q[1] / B.loop.length], [0, 0]); E.push({ type: 'TEXT', p: W([c[0], c[1], B.groundZ]), h: 0.3, text: 'BLDG RL ' + (B.roofZ + S.origin[2]).toFixed(2), center: true, layer: 'TOPO-BLDG-TEXT' }); }
  for (const P of t.poles) { E.push({ type: 'CIRCLE', p: W([P.x, P.y, P.groundZ]), r: Math.max(0.1, P.dia / 2), layer: 'TOPO-POLE' }); E.push({ type: 'TEXT', p: W([P.x + 0.3, P.y, P.groundZ]), h: 0.2, text: 'POLE H' + P.height.toFixed(1), layer: 'TOPO-POLE' }); }
  for (const Wl of t.walls) { E.push({ type: 'POLY', pts: [W([Wl.a[0], Wl.a[1], Wl.groundZ]), W([Wl.b[0], Wl.b[1], Wl.groundZ])], layer: 'TOPO-WALL' }); E.push({ type: 'TEXT', p: W([(Wl.a[0] + Wl.b[0]) / 2, (Wl.a[1] + Wl.b[1]) / 2, Wl.groundZ]), h: 0.2, text: 'WALL/FENCE H' + Wl.height.toFixed(1), rot: Math.atan2(Wl.b[1] - Wl.a[1], Wl.b[0] - Wl.a[0]) * 180 / Math.PI, layer: 'TOPO-WALL' }); }
  if (t.extent) E.push({ type: 'POLY', pts: t.extent.map(q => W([q[0], q[1], 0])), closed: true, layer: 'TOPO-EXTENT' });
  saveFile('topo-survey.dxf', IO.writeDXF(E, { comment: dxfComment('topographic survey'), layerColors: { 'TOPO-TIN': 8, 'TOPO-BRKL-TOP': 1, 'TOPO-BRKL-TOE': 5, 'TOPO-CONT-MAJR': 30, 'TOPO-CONT-MINR': 40, 'TOPO-CONT-TEXT': 30, 'TOPO-SPOT': 7, 'TOPO-SPOT-TEXT': 7, 'TOPO-TREE': 3, 'TOPO-TREE-TEXT': 3, 'TOPO-BLDG': 1, 'TOPO-BLDG-TEXT': 1, 'TOPO-POLE': 6, 'TOPO-WALL': 6, 'TOPO-EXTENT': 9 } }));
}
function exportLandXML() {
  const t = S.topo; if (!t) return; let x = T_.landXML(t.tin, t.breaklines, S.origin, 'ScanBench ground');
  const c = crsObj(S.crs); if (c) x = x.replace('<Application', '<CoordinateSystem name="' + c.name.replace(/"/g, '') + '"' + (c.epsg ? ' epsgCode="' + c.epsg + '"' : '') + ' horizontalDatum="' + (c.datum || '') + '"/>\n<Application');
  saveFile('ground-surface.xml', x);
}
function exportPNEZD() {
  const t = S.topo; if (!t) return; let k = 1, s = ''; const o = S.origin, f = v => v.toFixed(3);
  const add = (x, y, z, d) => { s += (k++) + ',' + f(y + o[1]) + ',' + f(x + o[0]) + ',' + f(z + o[2]) + ',' + d + '\n'; };
  for (const p of t.spots) add(p[0], p[1], p[2], 'SL');
  for (const T of t.trees) add(T.x, T.y, T.groundZ, 'TREE H' + T.height.toFixed(1) + ' S' + T.spread.toFixed(1));
  for (const P of t.poles) add(P.x, P.y, P.groundZ, 'POLE H' + P.height.toFixed(1));
  for (const B of t.buildings) for (const q of B.loop) add(q[0], q[1], B.groundZ, 'BLDG');
  for (const b of t.breaklines) for (const q of b.pts) add(q[0], q[1], q[2], b.kind === 'top' ? 'TOB' : 'TOE');
  saveFile('topo-points-pnezd.csv', s);
}

// ---------- hook into the app ----------
const _refreshAll = refreshAllPanes;
refreshAllPanes = function () { _refreshAll(); buildCad(); buildTopo(); buildCoords(); };

// ---------- start-up sample: offshore platform (published alongside the page), else the small room ----------
// sample parts: base64 text on the hosted preview page, plain .laz files on a normal web server (GitHub Pages)
const sampleUrl = u => window.SB_BINARY_SAMPLES ? u.replace('.b64.txt', '') : u;
async function fetchSamplePart(u) { const r = await fetch(sampleUrl(u)); if (!r.ok) throw new Error('Sample not found (' + r.status + ')'); if (window.SB_BINARY_SAMPLES) return new Uint8Array(await r.arrayBuffer()); const bin = atob((await r.text()).trim()); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; }
const PLATFORM_PARTS = ['samples/platform_1.laz.b64.txt', 'samples/platform_2.laz.b64.txt', 'samples/platform_3.laz.b64.txt', 'samples/platform_4.laz.b64.txt'];
async function loadPlatformSample() {
  if (location.protocol === 'file:') return false;
  try { const h = await fetch(sampleUrl(PLATFORM_PARTS[0]), { method: 'HEAD' }); if (!h.ok) return false; } catch (e) { return false; }
  const parts = await busy('Loading the offshore platform sample (3.6 M points)…', async onP => {
    const out = [];
    for (let k = 0; k < PLATFORM_PARTS.length; k++) {
      const u8 = await fetchSamplePart(PLATFORM_PARTS[k]); const buf = u8.buffer;
      const src = { name: PLATFORM_PARTS[k], size: buf.byteLength, read: async (o, l) => buf.slice(o, o + l) };
      out.push(await IO.readLAS(src, { budget: 5e6, lazPerf: getLaz, onProgress: f => onP((k + f) / PLATFORM_PARTS.length) }));
    }
    return out;
  });
  if (!parts || !parts.length) return false;
  const o = parts[0].origin, n = parts.reduce((a, p) => a + p.n, 0);
  const pos = new Float32Array(n * 3), rgb = new Uint8Array(n * 3), it = new Float32Array(n), cls = new Uint8Array(n); let q = 0;
  for (const p of parts) {
    const d = [p.origin[0] - o[0], p.origin[1] - o[1], p.origin[2] - o[2]];
    for (let i = 0; i < p.n; i++) { pos[(q + i) * 3] = p.pos[i * 3] + d[0]; pos[(q + i) * 3 + 1] = p.pos[i * 3 + 1] + d[1]; pos[(q + i) * 3 + 2] = p.pos[i * 3 + 2] + d[2]; }
    rgb.set(p.rgb, q * 3); it.set(p.intensity, q); cls.fill(1, q, q + p.n); q += p.n;
  }
  addCloud('Offshore platform (synthetic sample)', { n, pos, rgb, intensity: it, cls, origin: o, meta: { format: 'Synthetic TLS sample, 12 set-ups merged (LAZ)', total: n, stride: 1 } }, { sample: true });
  S.sample = true; S.crs = 'MGA2020-50'; updateCrsStatus(); refreshAllPanes();
  S.cam.yaw = -1.25; S.cam.pitch = 0.32; fitAll();
  toast('Loaded a synthetic offshore platform: 15 × 15 m, 30 m high, 3.6 M points in MGA2020 zone 50. Try Scan to CAD with the clipping box around one deck. Opening your own files replaces it.');
  return true;
}
async function loadStartSample() {
  const ok = await loadPlatformSample();
  if (!ok) { loadSample(); toast('Loaded a synthetic sample room so the tools have something to work on. Opening your own files replaces it.'); }
}
