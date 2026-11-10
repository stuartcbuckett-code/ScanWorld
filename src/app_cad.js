// ---------- SCAN TO CAD: detection, editing and 2-point fitting ----------
S.cad = null; S.cadSel = null; S.cadUndo = [];
const CAD_KINDS = [['pipes', 'pipe'], ['bends', 'bend'], ['flanges', 'flange'], ['fittings', 'fitting'], ['steel', 'steel'], ['handrails', 'handrail'], ['vessels', 'vessel'], ['cylinders', 'cylinder'], ['boxes', 'box'], ['planes', 'plane']];
const CAD_NAME = { pipe: 'Pipe', bend: 'Bend', flange: 'Flange', fitting: 'Fitting or valve', steel: 'Steel', handrail: 'Handrail', vessel: 'Pressure vessel', cylinder: 'Large tubular', box: 'Equipment', plane: 'Surface' };
const CAD_COL = { pipe: 0x2fb8c9, bend: 0x2fb8c9, flange: 0xff9b3d, fitting: 0xd9534f, steel: 0x5b7bd6, handrail: 0xf2c230, vessel: 0xdfe6ee, cylinder: 0x9aa7b5, box: 0x84b26f, plane: 0x8fa0b8 };
const CAD_SELCOL = 0xff4fd8;
const V3 = C_.vec; const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], vlen = a => Math.hypot(a[0], a[1], a[2]);
function emptyCad() { const r = { n: 0 }; for (const [k] of CAD_KINDS) r[k] = []; return r; }
function normCad(r) { for (const [k] of CAD_KINDS) if (!r[k]) r[k] = []; return r; }
function cadListOf(kind) { return S.cad[CAD_KINDS.find(c => c[1] === kind)[0]]; }
function clearCad() { if (S.cadObj) annot.remove(S.cadObj); (S.cadLabels || []).forEach(removeLabel); S.cadObj = null; S.cadLabels = []; S.cad = null; S.cadSel = null; S.cadUndo = []; S.dirty = true; }
function cadItems() { const r = S.cad; if (!r) return []; const out = []; for (const [k, kind] of CAD_KINDS) for (const x of r[k]) out.push([kind, x]); return out; }
function flangeFaces(f) { const h = f.thick / 2, a = V3.add(f.at, f.axis, -h), b = V3.add(f.at, f.axis, h), ro = f.od / 2, ri = Math.min(ro * 0.95, f.ri || (f.pipe ? f.pipe.r : ro * 0.6)); return [...C_.cylFaces(a, b, ro, 24), ...C_.discFaces(a, f.axis, ri, ro, 24), ...C_.discFaces(b, f.axis, ri, ro, 24)]; }
function itemFaces(kind, x) {
  if (kind === 'pipe') return C_.cylFaces(x.p0, x.p1, x.r, 20);
  if (kind === 'bend') return [...C_.cylFaces(x.pts[0], x.pts[1], x.r, 20), ...C_.cylFaces(x.pts[1], x.pts[2], x.r, 20)];
  if (kind === 'flange' || kind === 'fitting') return flangeFaces(x);
  if (kind === 'steel') return C_.memberFaces(x);
  if (kind === 'handrail') return C_.handrailFaces(x);
  if (kind === 'vessel') return C_.vesselFaces(x);
  if (kind === 'cylinder') return C_.cylFaces(x.p0, x.p1, x.r, 32);
  if (kind === 'box') return C_.boxEquipFaces(x);
  return [];
}
function itemCentre(kind, x) {
  if (x.p0 && x.p1) return [(x.p0[0] + x.p1[0]) / 2, (x.p0[1] + x.p1[1]) / 2, (x.p0[2] + x.p1[2]) / 2];
  if (x.a && x.b) return [(x.a[0] + x.b[0]) / 2, (x.a[1] + x.b[1]) / 2, (x.a[2] + x.b[2]) / 2];
  if (x.at) return x.at.slice(); if (x.centre) return x.centre.slice(); if (x.pts) return x.pts[1].slice();
  if (x.centroid) return x.centroid.slice(); if (x.loops && x.loops[0]) { const l = x.loops[0]; return [l.reduce((s, p) => s + p[0], 0) / l.length, l.reduce((s, p) => s + p[1], 0) / l.length, l.reduce((s, p) => s + p[2], 0) / l.length]; }
  return [0, 0, 0];
}
function cadBox(kind, x) {
  const b = new THREE.Box3(); const add = p => b.expandByPoint(new THREE.Vector3(p[0], p[1], p[2]));
  if (x.p0) { add(x.p0); add(x.p1); } else if (x.a) { add(x.a); add(x.b); } else if (x.pts) x.pts.forEach(add); else if (x.at) add(x.at); else if (x.centre) { add([x.centre[0], x.centre[1], x.zmin]); add([x.centre[0], x.centre[1], x.zmax]); } else if (x.loops) x.loops.forEach(l => l.forEach(add));
  return b.expandByScalar(Math.max(0.5, (x.r || 0) * 2, (x.W || 0)));
}
function itemSummary(kind, x) {
  const f3 = v => v.toFixed(3);
  if (kind === 'pipe') return [CAD_NAME.pipe + ' · ' + x.dir + (x.picked ? ' · picked' : ''), x.label + ' · L ' + f3(x.length) + ' m' + (x.rms ? ' · fit ±' + (x.rms * 1000).toFixed(1) + ' mm' : '')];
  if (kind === 'bend') return ['Bend', 'Ø' + (x.r * 2000).toFixed(0) + ' mm' + (x.angle ? ' · ' + x.angle.toFixed(0) + '°' : '') + ' joining two runs'];
  if (kind === 'flange' || kind === 'fitting') return [CAD_NAME[kind], 'OD ' + (x.od * 1000).toFixed(0) + ' mm · ' + (kind === 'flange' ? 'thk ' : 'length ') + (x.thick * 1000).toFixed(0) + ' mm' + (x.pipe ? ' on ' + x.pipe.label : '')];
  if (kind === 'steel') return ['Steel · ' + x.dir + (x.picked ? ' · picked' : ''), x.label + ' · L ' + f3(x.length) + ' m' + (x.sec ? ' · measured ' + (x.sec.W * 1000).toFixed(0) + '×' + (x.sec.H * 1000).toFixed(0) + ' mm' : '')];
  if (kind === 'handrail') return ['Handrail · ' + x.posts.length + ' posts', 'L ' + f3(x.length) + ' m · top rail ' + (x.height * 1000).toFixed(0) + ' mm above deck RL ' + (x.level + S.origin[2]).toFixed(3) + (x.midZ !== null ? ' · mid rail' : '')];
  if (kind === 'vessel') return ['Pressure vessel · ' + x.dir, 'ID≈' + (x.r * 2000).toFixed(0) + ' mm · T/T ' + (x.length * 1000).toFixed(0) + ' mm · heads ' + x.heads.join(' / ')];
  if (kind === 'cylinder') return ['Large tubular · ' + x.dir, 'OD≈' + (x.r * 2000).toFixed(0) + ' mm · L ' + f3(x.length) + ' m · no heads seen (leg, pedestal or tank shell?)'];
  if (kind === 'box') return [x.kind, (x.W * 1000).toFixed(0) + ' × ' + (x.D * 1000).toFixed(0) + ' × ' + (x.H * 1000).toFixed(0) + ' mm · base RL ' + (x.zmin + S.origin[2]).toFixed(3) + ' · fit ' + (x.fit * 100).toFixed(0) + '%'];
  return [x.kind, x.area.toFixed(1) + ' m²' + (x.level !== null && x.level !== undefined ? ' · RL ' + (x.level + S.origin[2]).toFixed(3) : '') + ' · flat ±' + (x.rms * 1000).toFixed(1) + ' mm'];
}
function drawCad() {
  if (S.cadObj) annot.remove(S.cadObj); (S.cadLabels || []).forEach(removeLabel); S.cadLabels = [];
  const r = S.cad; if (!r) return; const g = new THREE.Group(); const keep = x => x.include !== false;
  const cl = [];
  for (const [kind, x] of cadItems()) {
    if (!keep(x)) continue;
    if (kind === 'plane') { const lo = linesObj(x.loops, x.kind === 'Wall' ? 0xb0b8c0 : x.kind.startsWith('Floor') ? 0x9a8b6d : 0x8fa0b8, true); lo.userData = { kind, x }; g.add(lo); continue; }
    const F = itemFaces(kind, x); if (!F.length) continue;
    const sel = S.cadSel && S.cadSel.x === x; const m = facesMesh(F, sel ? CAD_SELCOL : CAD_COL[kind], sel ? 1 : kind === 'vessel' ? 0.75 : 0.88);
    m.userData = { kind, x }; g.add(m);
    if (x.p0 && kind !== 'box') cl.push([x.p0, x.p1]); else if (kind === 'bend') cl.push(x.pts); else if (kind === 'handrail') cl.push([x.a, x.b]);
  }
  if (cl.length) { const l = linesObj(cl, 0xff3366); l.userData = { lines: true }; g.add(l); }
  S.cadObj = g; annot.add(g);
  if (S.cadShowLabels !== false) {
    const items = cadItems().filter(([k, x]) => keep(x) && ['pipe', 'steel', 'vessel', 'cylinder', 'box', 'handrail'].includes(k)).slice(0, 120);
    for (const [k, it] of items) { const c = itemCentre(k, it); S.cadLabels.push(addLabel(new THREE.Vector3(c[0], c[1], k === 'box' ? it.zmax + 0.1 : c[2]), esc(k === 'box' ? it.kind : k === 'handrail' ? 'Handrail ' + it.length.toFixed(1) + ' m' : it.label))); }
  }
  S.dirty = true;
}
function recolorCad() {
  if (!S.cadObj) return;
  for (const o of S.cadObj.children) { const u = o.userData; if (!u || !u.x || !o.material || o.isLineSegments) continue; const sel = S.cadSel && S.cadSel.x === u.x; o.material.color.setHex(sel ? CAD_SELCOL : CAD_COL[u.kind]); o.material.opacity = sel ? 1 : u.kind === 'vessel' ? 0.75 : 0.88; }
  S.dirty = true;
}
function pickCad(cx, cy) {
  if (!S.cadObj) return null; const rc = new THREE.Raycaster(); rc.setFromCamera(ndcOf(cx, cy), curCam());
  const hits = rc.intersectObjects(S.cadObj.children.filter(o => o.isMesh), false); if (!hits.length) return null;
  return { kind: hits[0].object.userData.kind, x: hits[0].object.userData.x, distance: hits[0].distance };
}
function cadSelect(kind, x, scroll) {
  S.cadSel = kind && x ? { kind, x } : null; recolorCad(); buildCad();
  if (S.cadSel) { const t = $$('.tab').find(b => b.dataset.tab === 'cad'); if (t && !t.classList.contains('on')) t.click(); const e = $('#cadEditor'); if (e && scroll !== false) e.scrollIntoView({ block: 'nearest' }); }
}
// distance from a point to an item's surface (negative inside): lets a click on the scan points select the model fitted to them
function itemDistance(kind, x, p) {
  const seg = (a, b) => { const ab = vsub(b, a), ap = vsub(p, a), L2 = V3.dot(ab, ab) || 1e-12; const t = Math.max(0, Math.min(1, V3.dot(ap, ab) / L2)); return vlen(vsub(p, V3.add(a, ab, t))); };
  if (kind === 'pipe' || kind === 'cylinder') return seg(x.p0, x.p1) - x.r;
  if (kind === 'vessel') return Math.min(seg(x.p0, x.p1) - x.r, vlen(vsub(p, x.p0)) - x.r, vlen(vsub(p, x.p1)) - x.r);
  if (kind === 'bend') return Math.min(seg(x.pts[0], x.pts[1]), seg(x.pts[1], x.pts[2])) - x.r;
  if (kind === 'steel') return seg(x.p0, x.p1) - Math.max(x.dims ? Math.max(x.dims.d || 0, x.dims.bf || 0) / 2000 : 0.1, 0.05);
  if (kind === 'handrail') return Math.min(seg(x.a, x.b), x.midZ !== null ? seg([x.a[0], x.a[1], x.midZ], [x.b[0], x.b[1], x.midZ]) : 9) - 0.03;
  if (kind === 'flange' || kind === 'fitting') return Math.max(Math.abs(V3.dot(vsub(p, x.at), x.axis)) - x.thick / 2, 0) + Math.max(0, vlen(vsub(vsub(p, x.at), x.axis.map(q => q * V3.dot(vsub(p, x.at), x.axis)))) - x.od / 2);
  if (kind === 'box') { const d = vsub(p, x.centre), a = Math.abs(V3.dot(d, x.ux)) - x.W / 2, b = Math.abs(V3.dot(d, x.uy)) - x.D / 2, z = Math.max(x.zmin - p[2], p[2] - x.zmax); return Math.max(a, b, z); }
  return Infinity;
}
function nearestItem(p, tol) { let best = null, bd = tol; for (const [kind, x] of cadItems()) { if (x.include === false || kind === 'plane') continue; const d = Math.abs(itemDistance(kind, x, p)); if (d < bd) { bd = d; best = { kind, x }; } } return best; }
// click in the viewport: a CAD object (hit directly, or the scan point clicked lies on one), else the normal point readout
const _onClickCloud = onClick;
onClick = function (e) {
  if (!S.mode && S.cadObj && S.cad) {
    const h = pickCad(e.clientX, e.clientY), p = pick(e.clientX, e.clientY), cam = curCam();
    if (h && (!p || cam.position.distanceTo(p.p) > h.distance - Math.max(0.2, h.distance * 0.03))) { cadSelect(h.kind, h.x); return; }
    if (p && !p.mesh) { const q = nearestItem([p.p.x, p.p.y, p.p.z], 0.06); if (q) { cadSelect(q.kind, q.x); return; } }
    if (S.cadSel) cadSelect(null);
  }
  _onClickCloud(e);
};

// ---------- undo ----------
function cadLists() { const o = {}; for (const [k] of CAD_KINDS) o[k] = S.cad[k]; return o; }
function cadSnapshot() { if (!S.cad) return; try { S.cadUndo.push(structuredClone(cadLists())); if (S.cadUndo.length > 60) S.cadUndo.shift(); } catch (e) { console.warn(e); } }
function cadUndo() {
  const u = S.cadUndo.pop(); if (!u) { toast('Nothing to undo.'); return; }
  Object.assign(S.cad, u); S.cadSel = null; drawCad(); buildCad(); toast('Undone.');
}

// ---------- editing ----------
const PT_KEYS = ['p0', 'p1', 'at', 'a', 'b', 'centre', 'centroid'], VEC_KEYS = ['axis', 'u', 'v', 'ux', 'uy', 'normal'];
const is3 = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
function transformItem(kind, x, d, rotDeg, pivot) {
  const th = (rotDeg || 0) * Math.PI / 180, c = Math.cos(th), s = Math.sin(th), pv = pivot || [0, 0, 0];
  const P = p => { const X = p[0] - pv[0], Y = p[1] - pv[1]; const r = [pv[0] + c * X - s * Y + d[0], pv[1] + s * X + c * Y + d[1]]; return p.length > 2 ? [r[0], r[1], p[2] + d[2]] : r; };
  const Vv = v => [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
  for (const k of PT_KEYS) if (is3(x[k])) x[k] = P(x[k]);
  for (const k of VEC_KEYS) if (is3(x[k])) x[k] = Vv(x[k]);
  if (x.pts) x.pts = x.pts.map(P); if (x.loops) x.loops = x.loops.map(l => l.map(P)); if (x.posts) x.posts = x.posts.map(P);
  for (const k of ['level', 'midZ', 'zmin', 'zmax']) if (Number.isFinite(x[k])) x[k] += d[2];
  if (kind === 'box') x.rot = (x.rot || 0) + (rotDeg || 0);
}
function cadTransform(kind, x, d, rotDeg, opts = {}) {
  if (opts.snapshot !== false) cadSnapshot();
  const pivot = itemCentre(kind, x); transformItem(kind, x, d, rotDeg, pivot);
  if (kind === 'pipe') for (const f of [...S.cad.flanges, ...S.cad.fittings]) if (f.pipe === x) transformItem('flange', f, d, rotDeg, pivot);   // flanges ride with their pipe
  if (opts.redraw !== false) { drawCad(); buildCad(); }
}
function refreshAxis(kind, x) {   // after an end point is edited
  const v = vsub(x.p1, x.p0), L = vlen(v); if (L < 1e-6) return; const ax = v.map(q => q / L); x.length = L;
  if (x.u && x.v) { const uu = x.u.map((q, i) => q - V3.dot(x.u, ax) * ax[i]), n = vlen(uu) || 1; const u = uu.map(q => q / n); const w = V3.cross(ax, u), sg = V3.dot(w, x.v) < 0 ? -1 : 1; x.u = u; x.v = w.map(q => q * sg); }
  x.axis = ax; x.dir = Math.abs(ax[2]) > 0.98 ? 'vertical' : Math.abs(ax[2]) < 0.02 ? 'horizontal' : 'sloped';
}
function cadDelete(kind, x) {
  cadSnapshot(); const L = cadListOf(kind); const i = L.indexOf(x); if (i >= 0) L.splice(i, 1);
  if (kind === 'pipe') { S.cad.flanges = S.cad.flanges.filter(f => f.pipe !== x); S.cad.fittings = S.cad.fittings.filter(f => f.pipe !== x); S.cad.bends = S.cad.bends.filter(b => b.a !== x && b.b !== x); }
  if (S.cadSel && S.cadSel.x === x) S.cadSel = null; drawCad(); buildCad(); toast(CAD_NAME[kind] + ' deleted. Ctrl+Z undoes.');
}
function cadDuplicate(kind, x, d) {
  cadSnapshot(); const strip = kind === 'bend' ? { pipe: undefined, a: undefined, b: undefined } : { pipe: undefined }; const y = structuredClone(Object.assign({}, x, strip)); if (x.pipe) y.pipe = x.pipe;
  transformItem(kind, y, d, 0, itemCentre(kind, y)); cadListOf(kind).push(y); S.cadSel = { kind, x: y }; drawCad(); buildCad();
}
function steelCatalogue() { const out = []; for (const fam of ['UB', 'UC', 'PFC']) for (const s of C_.STEEL[fam]) out.push({ fam, name: s[0], d: s[1], bf: s[2], tf: s[3], tw: s[4] }); return out; }
function setSteelSection(x, name) {
  const s = steelCatalogue().find(q => q.name === name); if (!s) return;
  x.dims = { d: s.d, bf: s.bf, tf: s.tf, tw: s.tw }; x.family = s.fam; x.label = s.name; x.sec = Object.assign({}, x.sec || {});
  if (s.fam === 'PFC') { if (x.sec.shape !== 'C') { x.sec.shape = 'C'; x.sec.key = 'C0'; } } else { if (x.sec.shape !== 'I') { x.sec.shape = 'I'; x.sec.key = 'I|'; } }
}
function pickTwo(text1, text2, done) {
  const pts = [];
  startMode({ type: 'cadpick', text: text1, onPick: pk => { pts.push([pk.p.x, pk.p.y, pk.p.z]); if (pts.length === 1 && text2) { setModeText(text2); S.mode.pts = [pk.p]; refreshModeGraphics(); return; } cancelMode(); done(pts); } });
}
function pickOne(text, done) { startMode({ type: 'cadpick', text, onPick: pk => { cancelMode(); done([pk.p.x, pk.p.y, pk.p.z]); } }); }
function cadEditor() {
  const sel = S.cadSel; if (!sel) return null; const { kind, x } = sel; const o = S.origin; const W = p => p.map((v, i) => v + o[i]);
  const wrap = el('div', { class: 'sec', id: 'cadEditor' }); const [t, v] = itemSummary(kind, x);
  wrap.append(el('h3', {}, 'Selected: ' + CAD_NAME[kind], el('button', { class: 'btn small', onclick: () => cadSelect(null) }, 'Deselect')), el('div', { class: 'note' }, v));
  const apply = fn => { cadSnapshot(); fn(); drawCad(); buildCad(); };
  // label
  if (x.label !== undefined || kind === 'box') { const li = el('input', { type: 'text', value: kind === 'box' ? x.kind : x.label, 'aria-label': 'Label' }); li.addEventListener('change', () => apply(() => { if (kind === 'box') x.kind = li.value; else x.label = li.value; })); wrap.append(fieldRow('Label', li)); }
  // size
  const num = (val, step) => el('input', { type: 'number', value: val, step: step || 'any' });
  if (kind === 'pipe') {
    const od = num((x.r * 2000).toFixed(1), '0.1'); const dn = el('select', {}, el('option', { value: '' }, 'Nominal size…'), ...C_.PIPE_OD.map(([d, q]) => el('option', { value: q, selected: x.dn === d }, 'DN' + d + ' (OD ' + q + ')')));
    od.addEventListener('change', () => apply(() => { x.r = +od.value / 2000; const mt = C_.matchPipe(+od.value); x.dn = mt ? mt.dn : null; x.label = (mt ? 'DN' + mt.dn + ' ' : '') + 'Ø' + (+od.value).toFixed(0) + ' mm'; }));
    dn.addEventListener('change', () => { if (!dn.value) return; od.value = dn.value; od.dispatchEvent(new Event('change')); });
    wrap.append(fieldRow('Outside diameter (mm)', od), fieldRow('Nominal size', dn));
  } else if (kind === 'steel') {
    const ss = el('select', {}, el('option', { value: '' }, x.label + ' (current)'), ...['UB', 'UC', 'PFC'].map(f => { const g = el('optgroup', { label: f }); for (const s of C_.STEEL[f]) g.append(el('option', { value: s[0] }, s[0])); return g; }));
    ss.addEventListener('change', () => { if (ss.value) apply(() => setSteelSection(x, ss.value)); });
    wrap.append(fieldRow('Section', ss), el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: () => apply(() => { const u = x.u; x.u = x.v; x.v = u.map(q => -q); }) }, 'Roll 90°'), el('button', { class: 'btn small', onclick: () => apply(() => { x.v = x.v.map(q => -q); x.u = x.u.map(q => -q); }) }, 'Roll 180°')));
  } else if (kind === 'vessel' || kind === 'cylinder') {
    const dd = num((x.r * 2000).toFixed(0), '1'); dd.addEventListener('change', () => apply(() => { x.r = +dd.value / 2000; if (kind === 'vessel') x.label = x.label.replace(/ID≈\d+/, 'ID≈' + (+dd.value).toFixed(0)); }));
    wrap.append(fieldRow(kind === 'vessel' ? 'Inside diameter (mm)' : 'Outside diameter (mm)', dd));
    if (kind === 'cylinder') wrap.append(el('button', { class: 'btn small', onclick: () => { cadSnapshot(); S.cad.cylinders.splice(S.cad.cylinders.indexOf(x), 1); x.type = 'vessel'; x.heads = ['2:1 ellipsoidal', '2:1 ellipsoidal']; x.headDepth = [x.r / 2, x.r / 2]; x.label = 'Vessel ID≈' + (x.r * 2000).toFixed(0) + ' mm'; S.cad.vessels.push(x); S.cadSel = { kind: 'vessel', x }; drawCad(); buildCad(); } }, 'Make it a vessel (add heads)'));
  } else if (kind === 'box') {
    const w = num((x.W * 1000).toFixed(0), '1'), d = num((x.D * 1000).toFixed(0), '1'), h = num((x.H * 1000).toFixed(0), '1');
    const upd = () => apply(() => { x.W = +w.value / 1000; x.D = +d.value / 1000; x.H = +h.value / 1000; x.zmax = x.zmin + x.H; x.centre[2] = (x.zmin + x.zmax) / 2; });
    [w, d, h].forEach(i => i.addEventListener('change', upd));
    wrap.append(el('div', { class: 'field' }, el('label', {}, 'W × D × H (mm)'), el('div', { class: 'row', style: 'flex-wrap:nowrap' }, w, d, h)));
  } else if (kind === 'handrail') {
    const hh = num((x.height * 1000).toFixed(0), '10'); hh.addEventListener('change', () => apply(() => { x.height = +hh.value / 1000; x.a[2] = x.b[2] = x.level + x.height; if (x.midZ !== null) x.midZ = x.level + x.height / 2; }));
    wrap.append(fieldRow('Top rail height (mm)', hh));
  } else if (kind === 'flange' || kind === 'fitting') {
    const od = num((x.od * 1000).toFixed(0), '1'), th = num((x.thick * 1000).toFixed(0), '1');
    od.addEventListener('change', () => apply(() => { x.od = +od.value / 1000; })); th.addEventListener('change', () => apply(() => { x.thick = +th.value / 1000; }));
    wrap.append(fieldRow('Outside diameter (mm)', od), fieldRow(kind === 'flange' ? 'Thickness (mm)' : 'Length (mm)', th));
  }
  // end points / position (world coordinates)
  const ptRow = (lab, getP, setP) => { const p = W(getP()); const ins = p.map(q => el('input', { type: 'number', value: q.toFixed(3), step: '0.001' }));
    ins.forEach(i => i.addEventListener('change', () => apply(() => setP(ins.map((q, k) => +q.value - o[k])))));
    ins.forEach(i => { i.style.minWidth = '0'; i.style.fontSize = '11.5px'; });
    return el('div', { style: 'display:grid;gap:3px;margin:4px 0' }, el('label', { class: 'hint' }, lab), el('div', { style: 'display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px' }, ...ins)); };
  if (x.p0 && x.p1 && kind !== 'box') {
    wrap.append(ptRow('Start E N Z', () => x.p0, p => { x.p0 = p; refreshAxis(kind, x); }), ptRow('End E N Z', () => x.p1, p => { x.p1 = p; refreshAxis(kind, x); }));
    const ln = num(x.length.toFixed(3), '0.001'); ln.addEventListener('change', () => apply(() => { x.p1 = V3.add(x.p0, x.axis, +ln.value); refreshAxis(kind, x); }));
    wrap.append(fieldRow('Length (m, keeps the start)', ln));
  } else if (kind === 'handrail') wrap.append(ptRow('Start E N Z', () => x.a, p => { x.a = p; x.length = Math.hypot(x.b[0] - x.a[0], x.b[1] - x.a[1]); }), ptRow('End E N Z', () => x.b, p => { x.b = p; x.length = Math.hypot(x.b[0] - x.a[0], x.b[1] - x.a[1]); }));
  else if (kind === 'box') wrap.append(ptRow('Centre E N, base Z', () => [x.centre[0], x.centre[1], x.zmin], p => { const dz = p[2] - x.zmin; x.centre = [p[0], p[1], x.centre[2] + dz]; x.zmin += dz; x.zmax += dz; }));
  else if (x.at) wrap.append(ptRow('Centre E N Z', () => x.at, p => { x.at = p; }));
  // move / rotate / copy
  const dE = num(S.cadMove ? S.cadMove[0] : 0, '0.01'), dN = num(S.cadMove ? S.cadMove[1] : 0, '0.01'), dZ = num(S.cadMove ? S.cadMove[2] : 0, '0.01'), rot = num(S.cadRot || 90, '1');
  const D = () => { S.cadMove = [+dE.value, +dN.value, +dZ.value]; return S.cadMove; };
  wrap.append(el('div', { class: 'field' }, el('label', {}, 'Move by ΔE ΔN ΔZ (m)'), el('div', { class: 'row', style: 'flex-wrap:nowrap' }, dE, dN, dZ)),
    el('div', { class: 'row' }, el('button', { class: 'btn small primary', onclick: () => cadTransform(kind, x, D(), 0) }, 'Move'), el('button', { class: 'btn small', onclick: () => cadDuplicate(kind, x, D()) }, 'Copy with offset'),
      el('button', { class: 'btn small', onclick: () => pickTwo('Pick the base point on the cloud', 'Pick where the base point goes', ([a, b]) => cadTransform(kind, x, vsub(b, a), 0)) }, 'Move by picking')),
    el('div', { class: 'field' }, el('label', {}, 'Rotate in plan (°)'), el('div', { class: 'row', style: 'flex-wrap:nowrap' }, rot, el('button', { class: 'btn small', onclick: () => { S.cadRot = +rot.value; cadTransform(kind, x, [0, 0, 0], +rot.value); } }, 'Rotate'))));
  const snaps = el('div', { class: 'row' });
  if (x.p0 && x.p1 && kind !== 'box') snaps.append(
    el('button', { class: 'btn small', onclick: () => pickOne('Pick the new start point', p => { cadSnapshot(); const t = V3.dot(vsub(p, x.p1), x.axis); x.p0 = S.cadSnapAxis !== false ? V3.add(x.p1, x.axis, t) : p; refreshAxis(kind, x); drawCad(); buildCad(); }) }, 'Extend start to…'),
    el('button', { class: 'btn small', onclick: () => pickOne('Pick the new end point', p => { cadSnapshot(); const t = V3.dot(vsub(p, x.p0), x.axis); x.p1 = S.cadSnapAxis !== false ? V3.add(x.p0, x.axis, t) : p; refreshAxis(kind, x); drawCad(); buildCad(); }) }, 'Extend end to…'),
    el('button', { class: 'btn small', onclick: () => apply(() => { const t = x.p0; x.p0 = x.p1; x.p1 = t; refreshAxis(kind, x); }) }, 'Flip'));
  snaps.append(el('button', { class: 'btn small', onclick: () => fitBox(cadBox(kind, x)) }, 'Zoom'), el('button', { class: 'btn small danger', onclick: () => cadDelete(kind, x) }, 'Delete'));
  wrap.append(snaps, el('div', { class: 'hint' }, 'Keys: Delete removes, arrows nudge 10 mm (Shift 100 mm), Page Up/Down raise and lower, Ctrl+Z undoes. Extend keeps the member on its own alignment.'));
  return wrap;
}
window.addEventListener('keydown', e => {
  if (e.target.matches('input, select, textarea')) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && S.cad && S.cadUndo.length) { e.preventDefault(); cadUndo(); return; }
  if (!S.cadSel || S.mode) return; const { kind, x } = S.cadSel; const st = e.shiftKey ? 0.1 : 0.01;
  const mv = { ArrowLeft: [-st, 0, 0], ArrowRight: [st, 0, 0], ArrowUp: [0, st, 0], ArrowDown: [0, -st, 0], PageUp: [0, 0, st], PageDown: [0, 0, -st] }[e.key];
  if (mv) { e.preventDefault(); cadTransform(kind, x, mv, 0); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); cadDelete(kind, x); }
});

// ---------- pane ----------
function buildCad() {
  const p = pane('cad'); if (!p) return; const keepScroll = p.scrollTop; p.textContent = '';
  const L = S.sel && S.sel.kind === 'cloud' ? S.sel : null;
  const sp = numIn('cadSp', S.cadSp || 0.015), r0 = numIn('cadMinD', S.cadMinD || 20, '1'), r1 = numIn('cadMaxD', S.cadMaxD || 800, '1');
  const chk = (id, label, on) => { const c = el('input', { type: 'checkbox', id }); c.checked = on; return el('label', { class: 'row', style: 'gap:6px;font-size:12px' }, c, label); };
  const toggles = el('div', { class: 'row' }, chk('cadPipes', 'Pipes', S.cadPipes !== false), chk('cadFl', 'Flanges and fittings', S.cadFl !== false), chk('cadSteel', 'Steel members', S.cadSteel !== false),
    chk('cadRail', 'Handrails', S.cadRail !== false), chk('cadVes', 'Pressure vessels', S.cadVes !== false), chk('cadBox', 'Cabinets and equipment', S.cadBox !== false), chk('cadPl', 'Walls and floors', S.cadPl !== false));
  const clipOnly = chk('cadClip', 'Only inside the clipping box', !!S.clip.on);
  const s1 = el('div', { class: 'sec' }, el('h3', {}, 'Scan to CAD'),
    el('div', { class: 'note' }, 'Finds pipes, flanges, bends, steel sections, handrails, pressure vessels, electrical cabinets and walls/floors in ', el('b', {}, L ? L.name : 'the selected cloud'), '. Runs on ' + POOL.size + ' CPU cores. Every result can be selected in the view and edited, moved or deleted.'),
    fieldRow('Analysis spacing (m)', sp), el('div', { class: 'field' }, el('label', {}, 'Pipe OD (mm)'), el('div', { class: 'row', style: 'flex-wrap:nowrap' }, r0, r1)), toggles, clipOnly,
    el('div', { class: 'row' }, el('button', { class: 'btn small primary', disabled: !L, onclick: () => { Object.assign(S, { cadSp: +sp.value, cadMinD: +r0.value, cadMaxD: +r1.value, cadPipes: $('#cadPipes').checked, cadFl: $('#cadFl').checked, cadSteel: $('#cadSteel').checked, cadPl: $('#cadPl').checked, cadRail: $('#cadRail').checked, cadVes: $('#cadVes').checked, cadBox: $('#cadBox').checked }); runCad(L, $('#cadClip').checked); } }, 'Detect'),
      el('button', { class: 'btn small danger', disabled: !S.cad, onclick: () => { clearCad(); buildCad(); } }, 'Clear all')),
    el('div', { class: 'hint' }, 'Detect finds everything in the cloud or clip box. Spacing: 1–2 cm for plant and steel.'));
  const inMode = S.mode && S.mode.type === 'fit2';
  const typeBtns = el('div', { class: 'row', role: 'radiogroup', 'aria-label': 'Element type' }, ...XT.map(([t, nm]) => el('button', { class: 'btn small' + (S.cadType === t ? ' primary' : ''), role: 'radio', 'aria-checked': S.cadType === t ? 'true' : 'false', onclick: () => { S.cadType = t; if (S.mode && S.mode.type === 'fit2') setModeText('Extract ' + nm + ': pick ' + XT.find(x => x[0] === t)[2] + ' (point 1)'); buildCad(); } }, nm)));
  const s1b = el('div', { class: 'sec' }, el('h3', {}, 'Extract by picking'),
    el('div', { class: 'note' }, 'Choose the element type, then pick 2 points for each one: ', el('b', {}, (XT.find(x => x[0] === S.cadType) || XT[0])[2]), '. Only that element is extracted, and the type stays selected so you can keep picking pairs. Consecutive pipe runs are joined with bends.'),
    typeBtns, el('div', { class: 'row' }, inMode ? el('button', { class: 'btn small', onclick: () => finishMode() }, 'Finish picking') : el('button', { class: 'btn small primary', disabled: !L, onclick: () => fitTwoPointMode(S.cadType) }, 'Start picking: ' + xtName(S.cadType))));
  p.append(s1, s1b);
  if (!S.cad) return;
  const ed = cadEditor(); if (ed) p.append(ed);
  const r = S.cad;
  const showL = el('input', { type: 'checkbox', id: 'cadLbl' }); showL.checked = S.cadShowLabels !== false; showL.addEventListener('change', () => { S.cadShowLabels = showL.checked; drawCad(); });
  const kv = el('dl', { class: 'kv' }); const add = (k, v) => kv.append(el('dt', {}, k), el('dd', {}, v));
  add('Pipes', r.pipes.length + ' (' + r.pipes.reduce((a, x) => a + x.length, 0).toFixed(1) + ' m)'); add('Bends', String(r.bends.length)); add('Flanges / fittings', r.flanges.length + ' / ' + r.fittings.length);
  add('Steel members', r.steel.length + ' (' + r.steel.reduce((a, x) => a + x.length, 0).toFixed(1) + ' m)'); add('Handrails', r.handrails.length + ' (' + r.handrails.reduce((a, x) => a + x.length, 0).toFixed(1) + ' m)');
  add('Vessels / tubulars', r.vessels.length + ' / ' + r.cylinders.length); add('Cabinets and equipment', String(r.boxes.length)); add('Walls / floors', String(r.planes.length));
  add('Points analysed', (r.n || 0).toLocaleString() + (r.ms ? ' in ' + (r.ms / 1000).toFixed(1) + ' s' : ''));
  const filt = el('select', { id: 'cadFilt', style: 'width:auto' }, el('option', { value: '' }, 'All types'), ...CAD_KINDS.filter(([k]) => r[k].length).map(([k, kind]) => el('option', { value: kind, selected: S.cadFilt === kind }, CAD_NAME[kind] + ' (' + r[k].length + ')')));
  filt.addEventListener('change', () => { S.cadFilt = filt.value; buildCad(); });
  const list = el('div', { class: 'mlist' });
  for (const [kind, x] of cadItems()) {
    if (S.cadFilt && S.cadFilt !== kind) continue;
    const cb = el('input', { type: 'checkbox', 'aria-label': 'Include in export' }); cb.checked = x.include !== false; cb.addEventListener('change', () => { x.include = cb.checked; drawCad(); });
    const [t, v] = itemSummary(kind, x); const sel = S.cadSel && S.cadSel.x === x;
    list.append(el('div', { class: 'mitem', style: 'grid-template-columns:auto minmax(0,1fr) auto' + (sel ? ';outline:2px solid #ff4fd8' : '') }, cb,
      el('div', { style: 'cursor:pointer', onclick: () => cadSelect(kind, x) }, el('div', { class: 't' }, t), el('div', { class: 'v' }, v)),
      el('span', { class: 'row', style: 'gap:4px' }, el('button', { class: 'btn small', onclick: () => { cadSelect(kind, x, false); fitBox(cadBox(kind, x)); } }, 'Zoom'), el('button', { class: 'btn small icon danger', 'aria-label': 'Delete', onclick: () => cadDelete(kind, x) }, '×'))));
  }
  const s2 = el('div', { class: 'sec' }, el('h3', {}, 'Results', el('label', { class: 'row', style: 'gap:6px;text-transform:none;letter-spacing:0;font-weight:400;color:var(--fg)' }, showL, 'Labels')), el('div', { class: 'result' }, kv),
    el('div', { class: 'row' }, el('button', { class: 'btn small primary', onclick: exportCadDXF }, 'DXF for AutoCAD'), el('button', { class: 'btn small', onclick: exportCadCSV }, 'Schedule CSV'), el('button', { class: 'btn small', disabled: !S.cadUndo.length, onclick: cadUndo }, 'Undo')),
    el('div', { class: 'row' }, filt, el('span', { class: 'hint' }, 'Click an item here or in the view to edit it.')), list);
  p.append(s2); p.scrollTop = keepScroll;
}
async function runCad(L, clipOnly) {
  const b = S.clip.box; const box = clipOnly && !b.isEmpty() ? [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z] : null;
  const t0 = performance.now(); await poolReady();
  const res = await busy('Detecting pipes, steel, handrails, vessels and cabinets…', onP => C_.scanToCad(L.pos, L.n, { spacing: Math.max(0.005, S.cadSp), minR: S.cadMinD / 2000, maxR: S.cadMaxD / 2000, pipes: S.cadPipes, steel: S.cadSteel, planes: S.cadPl, flanges: S.cadFl, handrails: S.cadRail, vessels: S.cadVes, boxes: S.cadBox, box, normalsFn: parNormalsFn(Math.max(0.05, S.cadSp * 8)) }, onP));
  if (!res) return; res.ms = performance.now() - t0; delete res.ctx; normCad(res);
  for (const [, x] of cadItemsOf(res)) delete x.idx;
  clearCad(); S.cad = res; drawCad(); buildCad(); $$('.tab').find(x => x.dataset.tab === 'cad').click();
  toast('Found ' + res.pipes.length + ' pipes, ' + res.steel.length + ' steel members, ' + res.handrails.length + ' handrails, ' + res.vessels.length + ' vessels and ' + res.boxes.length + ' cabinets/equipment in ' + (res.ms / 1000).toFixed(1) + ' s.');
}
function cadItemsOf(r) { const out = []; for (const [k, kind] of CAD_KINDS) for (const x of r[k] || []) out.push([kind, x]); return out; }

// ---------- extract by type: choose the element type once, then pick 2 points per element; the type stays selected ----------
const XT = [
  ['pipe', 'Pipe', 'start and end of a straight run'], ['steel', 'Steel (any)', 'two points along the member'], ['I', 'I-beam / column', 'two points along it'],
  ['C', 'Channel (PFC)', 'two points along it'], ['L', 'Angle', 'two points along it'], ['BOX', 'Hollow section', 'two points along it'],
  ['handrail', 'Handrail', 'two points on the top rail'], ['vessel', 'Pressure vessel', 'the two ends (heads)'], ['box', 'Cabinet / equipment', 'two opposite corners']];
S.cadType = S.cadType || 'pipe';
function xtName(t) { return (XT.find(x => x[0] === t) || XT[0])[1]; }
async function localCtx(L, A, B, pad, sp = 0.012) {   // voxelised points + normals in a box around the picks
  const lo = [Math.min(A[0], B[0]) - pad, Math.min(A[1], B[1]) - pad, Math.min(A[2], B[2]) - pad], hi = [Math.max(A[0], B[0]) + pad, Math.max(A[1], B[1]) + pad, Math.max(A[2], B[2]) + pad];
  const mask = new Uint8Array(L.n); let c = 0; for (let i = 0; i < L.n; i++) { const x = L.pos[i * 3], y = L.pos[i * 3 + 1], z = L.pos[i * 3 + 2]; if (x >= lo[0] && y >= lo[1] && z >= lo[2] && x <= hi[0] && y <= hi[1] && z <= hi[2]) { mask[i] = 1; c++; } }
  if (c < 30) return null; const vox = C_.voxelAssign(L.pos, L.n, sp, mask); const P = C_.gather(L.pos, vox.reps), m = vox.reps.length; const N = await C_.computeNormals(P, m, 14);
  return { P, n: m, nrm: N.nrm, curv: N.curv, K: N.K, used: new Uint8Array(m) };
}
async function extractVessel(L, A, B) {
  const ax = V3.norm(vsub(B, A)), len = vlen(vsub(B, A)); const ctx = await localCtx(L, A, B, 2.6, 0.02); if (!ctx) return null;
  const idx = []; for (let i = 0; i < ctx.n; i++) { const d = vsub([ctx.P[i * 3], ctx.P[i * 3 + 1], ctx.P[i * 3 + 2]], A), a = V3.dot(d, ax); if (a < -0.15 * len || a > 1.15 * len) continue; const r = vlen(vsub(d, ax.map(q => q * a))); if (r < 2.6) idx.push(i); }
  // keep the smooth surface the picks lie on (the shell), then fit along the picked axis
  const segs = C_.smoothSegments(ctx, idx, 6, 0.06); let best = null, bd = Infinity;
  for (const sg of segs.slice(0, 12)) { let d = Infinity; for (const i of sg) { const q = [ctx.P[i * 3], ctx.P[i * 3 + 1], ctx.P[i * 3 + 2]]; d = Math.min(d, vlen(vsub(q, A)), vlen(vsub(q, B))); } if (d < bd) { bd = d; best = sg; } }
  const V = C_.fitVessel(ctx, best || idx, { axisHint: ax, minVesselR: 0.15, maxVesselR: 3 }) || C_.fitVessel(ctx, idx, { axisHint: ax, minVesselR: 0.15, maxVesselR: 3 });
  if (!V) return null; V.picked = true; return V;
}
async function extractBox(L, A, B) {
  const ctx = await localCtx(L, A, B, 0.25, 0.02); if (!ctx) return null;
  const lo = [Math.min(A[0], B[0]) - 0.2, Math.min(A[1], B[1]) - 0.2, Math.min(A[2], B[2]) - 0.05], hi = [Math.max(A[0], B[0]) + 0.2, Math.max(A[1], B[1]) + 0.2, Math.max(A[2], B[2]) + 0.05];
  const idx = []; for (let i = 0; i < ctx.n; i++) { const x = ctx.P[i * 3], y = ctx.P[i * 3 + 1], z = ctx.P[i * 3 + 2]; if (x >= lo[0] && y >= lo[1] && z >= lo[2] && x <= hi[0] && y <= hi[1] && z <= hi[2]) idx.push(i); }
  // drop the floor under it
  const zs = idx.map(i => ctx.P[i * 3 + 2]).sort((a, b) => a - b); const zf = zs[Math.floor(zs.length * 0.02)]; const flat = idx.filter(i => Math.abs(ctx.nrm[i * 3 + 2]) > 0.95 && ctx.P[i * 3 + 2] < zf + 0.02);
  const fl = new Set(flat.length > idx.length * 0.15 ? flat : []); const use = idx.filter(i => !fl.has(i));
  const B_ = C_.fitBox(ctx, use, { }); if (!B_) return null; B_.picked = true; return B_;
}
function extractHandrail(L, A, B) {
  // top rail through the two picks; deck = densest level below; posts = vertical runs of points along the rail
  const dir = V3.norm([B[0] - A[0], B[1] - A[1], 0]), len = Math.hypot(B[0] - A[0], B[1] - A[1]); if (len < 0.3) return null;
  const top = [], below = new Map(); const ztop = (A[2] + B[2]) / 2;
  for (let i = 0; i < L.n; i++) { const x = L.pos[i * 3], y = L.pos[i * 3 + 1], z = L.pos[i * 3 + 2]; const dx = x - A[0], dy = y - A[1], a = dx * dir[0] + dy * dir[1]; if (a < -0.05 || a > len + 0.05) continue; const off = Math.abs(-dx * dir[1] + dy * dir[0]); if (off > 0.12) continue;
    if (Math.abs(z - ztop) < 0.08) top.push(z); if (z < ztop - 0.3 && z > ztop - 1.6) { const k = Math.round(z / 0.02); below.set(k, (below.get(k) || 0) + 1); } }
  if (top.length < 10) return null; top.sort((a, b) => a - b); const zt = top[top.length >> 1];
  let bk = null, bc = 0; for (const [k, c] of below) if (c > bc && k * 0.02 < zt - 0.7) { bc = c; bk = k; } const level = bk !== null ? bk * 0.02 : zt - 1.1;
  let midZ = null, mc = 0; for (const [k, c] of below) { const z = k * 0.02; if (z > level + 0.3 && z < zt - 0.25 && c > mc) { mc = c; midZ = z; } }
  if (mc < bc * 0.05) midZ = null;
  const a = [A[0], A[1], zt], b = [A[0] + dir[0] * len, A[1] + dir[1] * len, zt]; const posts = [a.slice(0, 2), b.slice(0, 2)];
  return { type: 'handrail', level, a, b, height: zt - level, midZ, posts, length: len, rms: 0, od: 0.048, dir, picked: true, label: 'Handrail ' + len.toFixed(2) + ' m' };
}
async function extractTyped(L, type, A, B, prev) {
  await poolReady(); if (!S.cad) S.cad = emptyCad(); normCad(S.cad);
  const res = await busy('Extracting ' + xtName(type).toLowerCase() + '…', async () => {
    if (type === 'vessel') return (await extractVessel(L, A, B)) || 'none';
    if (type === 'box') return (await extractBox(L, A, B)) || 'none';
    if (type === 'handrail') return extractHandrail(L, A, B) || 'none';
    const o = { maxR: Math.max(0.6, (S.cadMaxD || 800) / 2000), minR: (S.cadMinD || 20) / 2000 };
    if (type === 'pipe') o.force = 'pipe'; else { o.force = 'steel'; if (type !== 'steel') o.shape = type; }
    const M = await C_.fitBetween(L.pos, L.n, A, B, o); if (M && M.type === 'steel' && M.sec.forced) C_.describeSteel(M); return M || 'none';
  });
  if (!res || res === 'none') return null; cadSnapshot(); const M = res;
  if (M.type === 'pipe') { S.cad.pipes.push(M); for (const f of M.flanges || []) (f.type === 'flange' ? S.cad.flanges : S.cad.fittings).push(f); delete M.flanges; if (prev && prev.type === 'pipe') { const j = C_.joinRuns(prev, M); if (j) S.cad.bends.push(j); } }
  else if (M.type === 'steel') S.cad.steel.push(M);
  else if (M.type === 'vessel' || M.type === 'cylinder') { if (M.heads[0] === 'not seen' && M.heads[1] === 'not seen') { M.type = 'cylinder'; S.cad.cylinders.push(M); } else S.cad.vessels.push(M); }
  else if (M.type === 'box') S.cad.boxes.push(M);
  else if (M.type === 'handrail') S.cad.handrails.push(M);
  return M;
}
function kindOf(M) { return M.type === 'box' ? 'box' : M.type; }
function fitTwoPointMode(type) {
  const L = S.sel && S.sel.kind === 'cloud' ? S.sel : null; if (!L) { toast('Select a point cloud layer first.', true); return; }
  if (type) S.cadType = type; let prev = null, n = 0, busyNow = false;
  const hint = () => 'Extract ' + xtName(S.cadType) + ': pick ' + (XT.find(x => x[0] === S.cadType) || XT[0])[2];
  startMode({ type: 'fit2', text: hint() + ' (point 1)', finishable: true,
    onPick: async pk => {
      if (busyNow) return; if (pk.mesh) { toast('Pick on the point cloud, not a mesh.'); return; }
      const m = S.mode; m.pts.push(pk.p); refreshModeGraphics();
      if (m.pts.length % 2 === 1) { setModeText(hint() + ' (point 2)'); return; }
      const A = m.pts[m.pts.length - 2], B = m.pts[m.pts.length - 1]; busyNow = true;
      const M = await extractTyped(pk.layer && pk.layer.pos ? pk.layer : L, S.cadType, [A.x, A.y, A.z], [B.x, B.y, B.z], prev); busyNow = false;
      if (S.mode !== m) { if (M) { drawCad(); buildCad(); } return; }
      m.pts = []; refreshModeGraphics();
      if (!M) { toast('No ' + xtName(S.cadType).toLowerCase() + ' found between those points. Pick both points on the same element, clear of joints.', true); setModeText(hint() + ' (point 1)'); return; }
      if (M.type === 'pipe') prev = M; n++; S.cadSel = { kind: kindOf(M), x: M }; drawCad(); buildCad();
      setModeText('Got ' + (M.label || M.kind) + '. Still on ' + xtName(S.cadType) + ': pick the next 2 points · Enter to finish');
    },
    onFinish: () => { toast(n ? 'Extracted ' + n + ' element' + (n > 1 ? 's' : '') + '.' : 'Nothing extracted.'); buildCad(); } });
}
function fitClickMode() { fitTwoPointMode(); }
async function fit2Pair(L, A, B, prev) { return extractTyped(L, S.cadType === 'pipe' || S.cadType === 'steel' ? S.cadType : 'pipe', A, B, prev); }
async function fitAtPoint(L, p) { const M = await extractTyped(L, 'pipe', [p.x - 0.3, p.y, p.z], [p.x + 0.3, p.y, p.z], null); if (M) { drawCad(); buildCad(); } return M; }

// ---------- exports ----------
function exportCadDXF() {
  const r = S.cad; if (!r) return; const E = []; const keep = x => x.include !== false; const Wp = p => wpt(p);
  const face = (F, layer) => { for (const q of F) E.push({ type: '3DFACE', pts: q.map(Wp), layer }); };
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const txt = (p, s, layer, rot) => E.push({ type: 'TEXT', p: Wp(p), h: 0.08, text: s, layer, rot });
  const ang = ax => Math.atan2(ax[1], ax[0]) * 180 / Math.PI;
  for (const x of r.pipes.filter(keep)) { face(C_.cylFaces(x.p0, x.p1, x.r, 16), 'S2C-PIPE'); E.push({ type: 'POLY', pts: [Wp(x.p0), Wp(x.p1)], layer: 'S2C-PIPE-CL' }); txt(V3.add(mid(x.p0, x.p1), [0, 0, 1], x.r + 0.05), x.label + ' L' + x.length.toFixed(2), 'S2C-TEXT', ang(x.axis)); }
  for (const b of r.bends.filter(keep)) { face(C_.cylFaces(b.pts[0], b.pts[1], b.r, 16), 'S2C-PIPE'); face(C_.cylFaces(b.pts[1], b.pts[2], b.r, 16), 'S2C-PIPE'); E.push({ type: 'POLY', pts: b.pts.map(Wp), layer: 'S2C-PIPE-CL' }); }
  for (const f of r.flanges.filter(keep)) { face(flangeFaces(f), 'S2C-FLANGE'); txt(f.at, 'FLG OD' + (f.od * 1000).toFixed(0), 'S2C-TEXT'); }
  for (const f of r.fittings.filter(keep)) { face(flangeFaces(f), 'S2C-FITTING'); txt(f.at, 'FITTING OD' + (f.od * 1000).toFixed(0), 'S2C-TEXT'); }
  for (const s of r.steel.filter(keep)) { face(C_.memberFaces(s), 'S2C-STEEL'); E.push({ type: 'POLY', pts: [Wp(s.p0), Wp(s.p1)], layer: 'S2C-STEEL-CL' }); txt(mid(s.p0, s.p1), s.label + ' L' + s.length.toFixed(2), 'S2C-TEXT', ang(s.axis)); }
  for (const h of r.handrails.filter(keep)) {
    face(C_.handrailFaces(h), 'S2C-HANDRAIL'); E.push({ type: 'POLY', pts: [Wp(h.a), Wp(h.b)], layer: 'S2C-HANDRAIL-CL' });
    if (h.midZ !== null) E.push({ type: 'POLY', pts: [Wp([h.a[0], h.a[1], h.midZ]), Wp([h.b[0], h.b[1], h.midZ])], layer: 'S2C-HANDRAIL-CL' });
    for (const q of h.posts) E.push({ type: 'LINE', a: Wp([q[0], q[1], h.level]), b: Wp([q[0], q[1], h.a[2]]), layer: 'S2C-HANDRAIL-CL' });
    txt(V3.add(mid(h.a, h.b), [0, 0, 1], 0.1), 'HANDRAIL H' + (h.height * 1000).toFixed(0) + ' L' + h.length.toFixed(2), 'S2C-TEXT', Math.atan2(h.b[1] - h.a[1], h.b[0] - h.a[0]) * 180 / Math.PI);
  }
  for (const v of r.vessels.filter(keep)) { face(C_.vesselFaces(v, 24), 'S2C-VESSEL'); E.push({ type: 'POLY', pts: [Wp(v.p0), Wp(v.p1)], layer: 'S2C-VESSEL-CL' }); txt(V3.add(mid(v.p0, v.p1), [0, 0, 1], v.r + 0.15), v.label, 'S2C-TEXT', v.dir === 'vertical' ? 0 : ang(v.axis)); }
  for (const v of r.cylinders.filter(keep)) { face(C_.cylFaces(v.p0, v.p1, v.r, 24), 'S2C-TUBULAR'); E.push({ type: 'POLY', pts: [Wp(v.p0), Wp(v.p1)], layer: 'S2C-VESSEL-CL' }); }
  for (const b of r.boxes.filter(keep)) { face(C_.boxEquipFaces(b), /cabinet|junction/i.test(b.kind) ? 'S2C-CABINET' : 'S2C-EQUIPMENT'); txt([b.centre[0], b.centre[1], b.zmax + 0.1], b.kind.toUpperCase() + ' ' + (b.W * 1000).toFixed(0) + 'x' + (b.D * 1000).toFixed(0) + 'x' + (b.H * 1000).toFixed(0), 'S2C-TEXT', b.rot); }
  for (const pl of r.planes.filter(keep)) { const layer = pl.kind === 'Wall' ? 'S2C-WALL' : pl.kind.startsWith('Floor') ? 'S2C-FLOOR' : pl.kind.startsWith('Ceiling') ? 'S2C-CEILING' : 'S2C-SURFACE'; for (const lp of pl.loops) E.push({ type: 'POLY', pts: lp.map(Wp), closed: true, layer }); }
  if (!E.length) { toast('Nothing ticked to export.', true); return; }
  saveFile('scan-to-cad.dxf', IO.writeDXF(E, { comment: dxfComment('scan to CAD'), layerColors: { 'S2C-PIPE': 4, 'S2C-PIPE-CL': 6, 'S2C-FLANGE': 30, 'S2C-FITTING': 1, 'S2C-STEEL': 5, 'S2C-STEEL-CL': 6, 'S2C-HANDRAIL': 2, 'S2C-HANDRAIL-CL': 2, 'S2C-VESSEL': 9, 'S2C-VESSEL-CL': 6, 'S2C-TUBULAR': 8, 'S2C-CABINET': 3, 'S2C-EQUIPMENT': 94, 'S2C-WALL': 8, 'S2C-FLOOR': 9, 'S2C-CEILING': 8, 'S2C-SURFACE': 8, 'S2C-TEXT': 7 } }));
}
function exportCadCSV() {
  const r = S.cad; if (!r) return; const keep = x => x.include !== false; const f = v => v.toFixed(3); const q = s => '"' + String(s).replace(/"/g, '""') + '"';
  let s = 'Type,Description,Size,Length (m),Start E,Start N,Start Z,End E,End N,End Z,Direction,Grade (%),Fit RMS (mm),Coordinate system\n';
  const row = (type, desc, size, a0, b0, len, dir, rms) => { const a = wpt(a0), b = wpt(b0), h = Math.hypot(b[0] - a[0], b[1] - a[1]); s += [type, q(desc), q(size), f(len), ...a.map(f), ...b.map(f), dir || '', h > 0.01 && dir !== 'vertical' ? ((b[2] - a[2]) / h * 100).toFixed(2) : dir === 'vertical' ? 'vertical' : '', rms ? (rms * 1000).toFixed(1) : '', q(crsLabel())].join(',') + '\n'; };
  for (const x of r.pipes.filter(keep)) row('Pipe', x.label, 'OD ' + (x.r * 2000).toFixed(1) + ' mm' + (x.dn ? ' (DN' + x.dn + ')' : ''), x.p0, x.p1, x.length, x.dir, x.rms);
  for (const x of r.steel.filter(keep)) row('Steel', x.label, x.sec ? (x.sec.W * 1000).toFixed(0) + ' x ' + (x.sec.H * 1000).toFixed(0) + ' mm measured' : '', x.p0, x.p1, x.length, x.dir, x.rms);
  for (const x of r.handrails.filter(keep)) row('Handrail', x.posts.length + ' posts' + (x.midZ !== null ? ', mid rail' : ''), 'top rail ' + (x.height * 1000).toFixed(0) + ' mm above deck', x.a, x.b, x.length, 'horizontal', x.rms);
  for (const x of r.vessels.filter(keep)) row('Pressure vessel', x.label, 'ID ' + (x.r * 2000).toFixed(0) + ' mm, T/T ' + (x.length * 1000).toFixed(0) + ' mm, heads ' + x.heads.join(' / '), x.p0, x.p1, x.length, x.dir, x.rms);
  for (const x of r.cylinders.filter(keep)) row('Large tubular', x.label, 'OD ' + (x.r * 2000).toFixed(0) + ' mm', x.p0, x.p1, x.length, x.dir, x.rms);
  for (const x of r.boxes.filter(keep)) row(/cabinet|junction/i.test(x.kind) ? 'Cabinet' : 'Equipment', x.kind, (x.W * 1000).toFixed(0) + ' x ' + (x.D * 1000).toFixed(0) + ' x ' + (x.H * 1000).toFixed(0) + ' mm, rotation ' + x.rot.toFixed(1) + '°', [x.centre[0], x.centre[1], x.zmin], [x.centre[0], x.centre[1], x.zmax], x.H, 'vertical');
  for (const x of r.flanges.filter(keep)) { const a = wpt(x.at); s += ['Flange', q('on ' + (x.pipe ? x.pipe.label : 'pipe')), q('OD ' + (x.od * 1000).toFixed(0) + ' mm, thk ' + (x.thick * 1000).toFixed(0) + ' mm'), '', ...a.map(f), '', '', '', '', '', '', q(crsLabel())].join(',') + '\n'; }
  saveFile('scan-to-cad-schedule.csv', s);
}
