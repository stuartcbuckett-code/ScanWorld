// ---------- MORE TOOLS: data management tree, tags, view clips, scan-vs-CAD, classification by type, people filter, flight paths, batch Scan to CAD ----------

// ===== data management: projects and sub-projects you can switch on and off =====
S.groups = [{ id: 'g1', name: 'Project', parent: null, on: true, open: true }]; S.gidc = 2;
const grpOf = id => S.groups.find(g => g.id === id);
function grpChain(id) { const out = []; let g = grpOf(id); while (g) { out.push(g); g = grpOf(g.parent); } return out; }
function grpOn(id) { return grpChain(id).every(g => g.on); }
function applyVisibility() {
  for (const L of S.layers) {
    if (L.selfVisible === undefined) L.selfVisible = L.visible; if (!L.group || !grpOf(L.group)) L.group = S.groups[0].id;
    L.visible = L.selfVisible && grpOn(L.group);
    if (L.lod) { L.obj.visible = false; L.lod.group.visible = L.visible; } else L.obj.visible = L.visible; if (L.edges) L.edges.visible = L.visible;
  }
  for (const D of S.streams || []) { if (!D.group || !grpOf(D.group)) D.group = S.groups[0].id; D.visible = D.selfVisible !== false && grpOn(D.group); if (D.root) D.root.visible = D.visible; }
  for (const ov of S.overlays || []) { if (!ov.group || !grpOf(ov.group)) ov.group = S.groups[0].id; ov.obj.visible = ov.visible && grpOn(ov.group); }
  if (typeof LODS !== 'undefined') LODS.key = ''; S.dirty = true; updateStatus();
}
function addGroup(parent, name) { const g = { id: 'g' + S.gidc++, name: name || 'Sub-project ' + (S.groups.length), parent: parent || S.groups[0].id, on: true, open: true }; S.groups.push(g); refreshLayers(); return g; }
function removeGroup(g) { if (g.parent === null) return; for (const L of S.layers) if (L.group === g.id) L.group = g.parent; for (const D of S.streams || []) if (D.group === g.id) D.group = g.parent; for (const c of S.groups) if (c.parent === g.id) c.parent = g.parent; S.groups = S.groups.filter(x => x !== g); applyVisibility(); refreshLayers(); }
refreshLayers = function () {
  const box = $('#layers'); box.textContent = '';
  if (!S.layers.length && !(S.streams || []).length) box.append(el('div', { class: 'empty' }, 'No layers yet. Open an E57 or LAS/LAZ scan to begin.'));
  for (const L of S.layers) { if (L.selfVisible === undefined) L.selfVisible = L.visible; if (!L.group || !grpOf(L.group)) L.group = S.groups[0].id; }
  const moveSel = (cur, onPick) => { const s = el('select', { 'aria-label': 'Move to', style: 'width:auto;font-size:11px;padding:1px 2px', onclick: e => e.stopPropagation() }, ...S.groups.map(g => el('option', { value: g.id, selected: g.id === cur }, '→ ' + grpChain(g.id).reverse().map(x => x.name).join(' / ')))); s.addEventListener('change', () => onPick(s.value)); return s; };
  const drawGroup = (g, depth) => {
    const cb = el('input', { type: 'checkbox', 'aria-label': 'Show ' + g.name }); cb.checked = g.on; cb.addEventListener('change', () => { g.on = cb.checked; applyVisibility(); refreshLayers(); });
    const nm = el('input', { type: 'text', value: g.name, 'aria-label': 'Name', style: 'font-weight:600;font-size:12px;padding:2px 4px;min-width:0' }); nm.addEventListener('change', () => { g.name = nm.value || g.name; refreshLayers(); });
    const tg = el('button', { class: 'btn small icon', 'aria-label': g.open ? 'Collapse' : 'Expand', onclick: () => { g.open = !g.open; refreshLayers(); } }, g.open ? '▾' : '▸');
    box.append(el('div', { class: 'row', style: 'flex-wrap:nowrap;gap:4px;margin:4px 0 2px ' + depth * 14 + 'px' }, tg, cb, nm,
      el('button', { class: 'btn small icon', title: 'Add a sub-project', 'aria-label': 'Add sub-project', onclick: () => addGroup(g.id) }, '+'),
      g.parent ? el('button', { class: 'btn small icon danger', title: 'Remove (its layers move up a level)', 'aria-label': 'Remove sub-project', onclick: () => removeGroup(g) }, '×') : null));
    if (!g.open) return;
    for (const L of S.layers.filter(x => x.group === g.id)) {
      const c2 = el('input', { type: 'checkbox', 'aria-label': 'Show ' + L.name }); c2.checked = L.selfVisible; c2.addEventListener('click', e => e.stopPropagation()); c2.addEventListener('change', () => { L.selfVisible = c2.checked; applyVisibility(); });
      box.append(el('div', { class: 'layer' + (S.sel === L ? ' sel' : ''), tabindex: '0', style: 'margin-left:' + (depth * 14 + 14) + 'px' + (grpOn(g.id) ? '' : ';opacity:.5'), onclick: () => selectLayer(L), onkeydown: e => { if (e.key === 'Enter') selectLayer(L); } },
        c2, el('span', { class: 'sw', style: 'background:' + L.solid }), el('span', { class: 'nm', title: L.name }, L.name), el('span', { class: 'ct' }, L.kind === 'cloud' ? fmtN(L.n) : (L.tris.length / 9 | 0) + ' tri'),
        S.groups.length > 1 ? moveSel(L.group, v => { L.group = v; applyVisibility(); refreshLayers(); }) : null));
    }
    for (const D of (S.streams || []).filter(x => x.group === g.id)) {
      const c2 = el('input', { type: 'checkbox', 'aria-label': 'Show ' + D.meta.name }); c2.checked = D.selfVisible !== false; c2.addEventListener('change', () => { D.selfVisible = c2.checked; applyVisibility(); });
      box.append(el('div', { class: 'layer' + (S.selStream === D ? ' sel' : ''), style: 'margin-left:' + (depth * 14 + 14) + 'px' + (grpOn(g.id) ? '' : ';opacity:.5'), onclick: () => { S.selStream = D; refreshLayers(); buildDatasets(); } },
        c2, el('span', { class: 'sw', style: 'background:#e39545;border-radius:2px' }), el('span', { class: 'nm', title: D.meta.name }, D.meta.name + ' (dataset)'), el('span', { class: 'ct' }, fmtN(D.meta.points)),
        S.groups.length > 1 ? moveSel(D.group, v => { D.group = v; applyVisibility(); refreshLayers(); }) : null));
    }
    for (const c of S.groups.filter(x => x.parent === g.id)) drawGroup(c, depth + 1);
  };
  drawGroup(S.groups[0], 0);
  updateStatus();
};

// ===== tag library and saved view clips =====
S.tagLib = [];
function allTags() { return [...new Set([...S.tagLib.map(t => t.name), ...S.annots.flatMap(a => a.tags || []), ...S.measures.flatMap(m => m.tags || []), ...S.bookmarks.flatMap(b => b.tags || [])])].sort(); }
function syncTagList() { let d = $('#tagList'); if (!d) { d = el('datalist', { id: 'tagList' }); document.body.append(d); } d.textContent = ''; for (const t of allTags()) d.append(el('option', { value: t })); }
function viewState() { const v = { cam: camState(), clip: S.clip.on ? { min: S.clip.box.min.toArray(), max: S.clip.box.max.toArray() } : null, layers: {}, groups: {} }; for (const L of S.layers) v.layers[L.id] = L.selfVisible !== false; for (const g of S.groups) v.groups[g.id] = g.on; return v; }
addBookmark = function (name, tags) { const v = viewState(); S.bookmarks.push({ name: name || 'View ' + (S.bookmarks.length + 1), cam: v.cam, clip: v.clip, layers: v.layers, groups: v.groups, tags: tags || [] }); buildReview(); };
async function goView(b) {
  if (b.clip) { S.clip.box.min.fromArray(b.clip.min); S.clip.box.max.fromArray(b.clip.max); S.clip.on = true; } else if (b.clip === null) S.clip.on = false;
  try { syncClipUI(); } catch (e) { }
  if (b.layers) for (const L of S.layers) if (b.layers[L.id] !== undefined) L.selfVisible = b.layers[L.id];
  if (b.groups) for (const g of S.groups) if (b.groups[g.id] !== undefined) g.on = b.groups[g.id];
  applyVisibility(); refreshLayers(); await tweenCam(b.cam, 900);
}
function buildTagsSec() {
  const list = el('div', { class: 'row' });
  for (const t of S.tagLib) list.append(el('span', { class: 'row', style: 'gap:4px;border:1px solid var(--line);border-radius:999px;padding:1px 4px 1px 8px;font-size:12px' }, el('span', { style: 'width:8px;height:8px;border-radius:50%;background:' + t.color }), t.name, el('button', { class: 'btn small icon', 'aria-label': 'Remove tag ' + t.name, onclick: () => { S.tagLib = S.tagLib.filter(x => x !== t); buildReview(); } }, '×')));
  const nm = el('input', { type: 'text', placeholder: 'New tag (e.g. defect, RFI, as-built)', 'aria-label': 'New tag name' }), col = el('input', { type: 'color', value: '#4fb3c3', 'aria-label': 'Tag colour' });
  const add = () => { const v = nm.value.trim(); if (!v || S.tagLib.some(t => t.name === v)) return; S.tagLib.push({ name: v, color: col.value }); buildReview(); };
  nm.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  return el('div', { class: 'sec' }, el('h3', {}, 'Tags'), el('div', { class: 'note' }, 'Make a set of tags to use on annotations, measurements and saved views, then filter by them.'), el('div', { class: 'row', style: 'flex-wrap:nowrap' }, nm, col, el('button', { class: 'btn small', onclick: add }, 'Add')), list);
}
const _buildReview0 = buildReview;
buildReview = function () {
  _buildReview0(); const p = pane('review'); if (!p) return; syncTagList();
  p.prepend(buildTagsSec());
  for (const i of p.querySelectorAll('input[placeholder="tags, comma separated"]')) i.setAttribute('list', 'tagList');
  // saved views: clip badge, tags, tag filter, Go restores clip + visibility
  const sec = [...p.querySelectorAll('.sec')].find(s => /Saved views/.test(s.querySelector('h3')?.textContent || '')); if (!sec) return;
  const items = sec.querySelectorAll('.mlist .mitem'); const vt = S.vTag || '';
  S.bookmarks.forEach((b, i) => { const it = items[i]; if (!it) return; if (vt && !(b.tags || []).includes(vt)) { it.style.display = 'none'; return; }
    const go = [...it.querySelectorAll('button')].find(x => x.textContent === 'Go'); if (go) { const ng = go.cloneNode(true); ng.addEventListener('click', () => goView(b)); go.replaceWith(ng); }
    const up = [...it.querySelectorAll('button')].find(x => x.textContent === 'Update'); if (up) { const nu = up.cloneNode(true); nu.addEventListener('click', () => { Object.assign(b, viewState()); toast('View updated' + (b.clip ? ' with the clipping box.' : '.')); buildReview(); }); up.replaceWith(nu); }
    const tg = el('input', { type: 'text', list: 'tagList', value: (b.tags || []).join(', '), placeholder: 'tags', 'aria-label': 'View tags', style: 'font-size:11px' }); tg.addEventListener('change', () => { b.tags = tg.value.split(',').map(s => s.trim()).filter(Boolean); buildReview(); });
    it.style.gridTemplateColumns = 'minmax(0,1fr) auto'; it.append(el('div', { style: 'grid-column:1/-1;display:flex;gap:6px;align-items:center' }, b.clip ? el('span', { class: 'hint', title: 'Restores the clipping box' }, '✂ clip') : el('span', { class: 'hint' }, 'no clip'), tg)); });
  const tags = [...new Set(S.bookmarks.flatMap(b => b.tags || []))].sort();
  if (tags.length) { const s = el('select', { style: 'width:auto', 'aria-label': 'Filter views by tag' }, el('option', { value: '' }, 'All tags'), ...tags.map(t => el('option', { value: t, selected: vt === t }, t))); s.addEventListener('change', () => { S.vTag = s.value; buildReview(); }); sec.querySelector('h3').after(el('div', { class: 'row' }, el('span', { class: 'hint' }, 'Show'), s)); }
  sec.querySelector('.mlist').before(el('div', { class: 'hint' }, 'A saved view keeps the camera, the clipping box (if on) and which layers and sub-projects are switched on.'));
  p.append(buildPathsSec());
};

// ===== shared spatial index (2D bins) for per-item work on big clouds =====
function binIndex(L, cell = 1) {
  const b = L.box, nx = Math.max(1, Math.ceil((b.max.x - b.min.x) / cell) + 1), ny = Math.max(1, Math.ceil((b.max.y - b.min.y) / cell) + 1), x0 = b.min.x, y0 = b.min.y;
  const cnt = new Uint32Array(nx * ny + 1), key = new Uint32Array(L.n);
  for (let i = 0; i < L.n; i++) { const k = Math.min(ny - 1, Math.floor((L.pos[i * 3 + 1] - y0) / cell)) * nx + Math.min(nx - 1, Math.floor((L.pos[i * 3] - x0) / cell)); key[i] = k; cnt[k + 1]++; }
  for (let k = 0; k < nx * ny; k++) cnt[k + 1] += cnt[k]; const ord = new Uint32Array(L.n), fill = cnt.slice(0, nx * ny);
  for (let i = 0; i < L.n; i++) ord[fill[key[i]]++] = i;
  return { nx, ny, x0, y0, cell, start: cnt, ord, *inBox(lo, hi) { const i0 = Math.max(0, Math.floor((lo[0] - x0) / cell)), i1 = Math.min(nx - 1, Math.floor((hi[0] - x0) / cell)), j0 = Math.max(0, Math.floor((lo[1] - y0) / cell)), j1 = Math.min(ny - 1, Math.floor((hi[1] - y0) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const k = j * nx + i; for (let q = this.start[k]; q < this.start[k + 1]; q++) yield this.ord[q]; } } };
}
function itemAABB(kind, x, pad) {
  const b = new THREE.Box3(); const add = p => b.expandByPoint(new THREE.Vector3(p[0], p[1], p[2]));
  if (kind === 'box') { const h = Math.hypot(x.W, x.D) / 2; add([x.centre[0] - h, x.centre[1] - h, x.zmin]); add([x.centre[0] + h, x.centre[1] + h, x.zmax]); }
  else if (x.p0 && x.p1) { add(x.p0); add(x.p1); b.expandByScalar((x.r || (x.dims ? Math.max(x.dims.d || 0, x.dims.bf || 0) / 2000 : 0.3)) * (kind === 'vessel' ? 1.6 : 1.05)); }
  else if (x.a && x.b) { add(x.a); add(x.b); b.expandByPoint(new THREE.Vector3(x.a[0], x.a[1], x.level)); }
  else if (x.pts) { x.pts.forEach(add); b.expandByScalar(x.r); } else if (x.at) { add(x.at); b.expandByScalar(x.od); }
  return b.expandByScalar(pad);
}

// ===== scan vs CAD: how well the model fits the scan, item by item =====
async function compareToCad(L, tol = 0.01, band = Math.max(0.04, tol * 4)) {
  if (!S.cad) { toast('Run Scan to CAD or extract some elements first.', true); return; }
  const items = cadItems().filter(([k, x]) => x.include !== false && k !== 'plane');
  const res = await busy('Comparing the scan with ' + items.length + ' CAD elements…', async onP => {
    const I = binIndex(L, 1); const dev = new Float32Array(L.n).fill(NaN), own = new Int32Array(L.n).fill(-1);
    for (let k = 0; k < items.length; k++) { const [kind, x] = items[k]; const bb = itemAABB(kind, x, band);
      for (const i of I.inBox([bb.min.x, bb.min.y], [bb.max.x, bb.max.y])) { const z = L.pos[i * 3 + 2]; if (z < bb.min.z || z > bb.max.z) continue; const d = itemDistance(kind, x, [L.pos[i * 3], L.pos[i * 3 + 1], z]); if (Math.abs(d) > band) continue; if (own[i] < 0 || Math.abs(d) < Math.abs(dev[i])) { dev[i] = d; own[i] = k; } }
      if ((k & 15) === 0) { onP(k / items.length); await tick(); } }
    const st = items.map(() => ({ n: 0, s2: 0, mx: 0, ok: 0, sum: 0 }));
    for (let i = 0; i < L.n; i++) { const k = own[i]; if (k < 0) continue; const d = dev[i], s = st[k]; s.n++; s.s2 += d * d; s.sum += d; s.mx = Math.max(s.mx, Math.abs(d)); if (Math.abs(d) <= tol) s.ok++; }
    return { dev, rows: items.map(([kind, x], k) => ({ kind, x, n: st[k].n, rms: st[k].n ? Math.sqrt(st[k].s2 / st[k].n) : NaN, mean: st[k].n ? st[k].sum / st[k].n : NaN, max: st[k].mx, pct: st[k].n ? st[k].ok / st[k].n * 100 : 0 })) };
  });
  if (!res) return; addSF(L, 'Deviation from CAD (m)', res.dev, true); const sty = L.sfStyle['Deviation from CAD (m)']; sty.ramp = 'tol'; sty.tol = tol; colorize(L); refreshProps();
  S.cadCmp = { tol, band, rows: res.rows, layer: L.name }; buildCad(); toast('Coloured ' + L.name + ' by deviation from the CAD model: green within ±' + (tol * 1000).toFixed(0) + ' mm, red outside the model surface, blue inside.');
}
function exportCadCmpCSV() {
  const c = S.cadCmp; if (!c) return; const q = s => '"' + String(s).replace(/"/g, '""') + '"';
  let s = 'Type,Element,Scan points,Mean (mm),RMS (mm),Max (mm),Within ±' + (c.tol * 1000).toFixed(0) + ' mm (%),Result\n';
  for (const r of c.rows) s += [CAD_NAME[r.kind], q(r.x.label || r.x.kind || ''), r.n, (r.mean * 1000).toFixed(1), (r.rms * 1000).toFixed(1), (r.max * 1000).toFixed(1), r.pct.toFixed(0), r.n < 20 ? 'not enough scan' : r.rms <= c.tol ? 'OK' : r.rms <= c.tol * 3 ? 'Check' : 'Fail'].join(',') + '\n';
  saveFile('scan-vs-cad.csv', s);
}
function cadCmpSec() {
  const L = S.sel && S.sel.kind === 'cloud' ? S.sel : null; const tol = numIn('cmpTol', (S.cmpTol || 0.01) * 1000, '1');
  const sec = el('div', { class: 'sec' }, el('h3', {}, 'Scan vs CAD'), el('div', { class: 'note' }, 'Measures every scan point against the nearest CAD element and grades each element: OK, Check or Fail. Use it to QA extracted models, or to check a design model (DXF overlay → design mesh in Compare) against the as-built scan.'),
    fieldRow('Tolerance (mm)', tol), el('div', { class: 'row' }, el('button', { class: 'btn small primary', disabled: !L || !S.cad, onclick: () => { S.cmpTol = +tol.value / 1000; compareToCad(L, S.cmpTol); } }, 'Compare'), el('button', { class: 'btn small', disabled: !S.cadCmp, onclick: exportCadCmpCSV }, 'Report CSV')));
  if (S.cadCmp) {
    const rows = S.cadCmp.rows.slice().sort((a, b) => (b.rms || 0) - (a.rms || 0)); const c = { ok: 0, chk: 0, fail: 0, none: 0 };
    for (const r of rows) { if (r.n < 20) c.none++; else if (r.rms <= S.cadCmp.tol) c.ok++; else if (r.rms <= S.cadCmp.tol * 3) c.chk++; else c.fail++; }
    sec.append(el('div', { class: 'result' }, el('dl', { class: 'kv' }, el('dt', {}, 'OK'), el('dd', {}, String(c.ok)), el('dt', {}, 'Check'), el('dd', {}, String(c.chk)), el('dt', {}, 'Fail'), el('dd', {}, String(c.fail)), el('dt', {}, 'Not enough scan'), el('dd', {}, String(c.none)))));
    const ml = el('div', { class: 'mlist' }); for (const r of rows.slice(0, 60)) { const grade = r.n < 20 ? 'no scan' : r.rms <= S.cadCmp.tol ? 'OK' : r.rms <= S.cadCmp.tol * 3 ? 'Check' : 'Fail'; const col = grade === 'OK' ? '#3ccf6e' : grade === 'Check' ? '#e9b43a' : grade === 'Fail' ? '#e0475b' : '#888';
      ml.append(el('div', { class: 'mitem', style: 'grid-template-columns:auto minmax(0,1fr) auto;cursor:pointer', onclick: () => { cadSelect(r.kind, r.x, false); fitBox(cadBox(r.kind, r.x)); } }, el('span', { style: 'width:10px;height:10px;border-radius:50%;background:' + col }), el('div', {}, el('div', { class: 't' }, CAD_NAME[r.kind] + ' · ' + grade), el('div', { class: 'v' }, (r.x.label || r.x.kind || '') + ' · RMS ' + (r.rms * 1000).toFixed(1) + ' mm · max ' + (r.max * 1000).toFixed(0) + ' mm · ' + r.n + ' pts')), el('span', { class: 'hint' }, r.pct.toFixed(0) + '%'))); }
    sec.append(ml);
  }
  return sec;
}

// ===== classification by type (plant and structure), roads, trees, buildings =====
const XCLS = { 64: ['Pipe', [47, 184, 201]], 65: ['Pipe fitting / flange / valve', [255, 155, 61]], 66: ['Pressure vessel', [223, 230, 238]], 67: ['Tank / large tubular', [154, 167, 181]], 68: ['Steel I-section (UB/UC)', [91, 123, 214]], 69: ['Steel channel (PFC)', [120, 90, 210]], 70: ['Steel angle', [170, 120, 230]], 71: ['Steel hollow section', [60, 160, 160]], 72: ['Steel (other)', [100, 110, 160]], 73: ['Handrail', [242, 194, 48]], 74: ['Electrical cabinet / equipment', [132, 178, 111]], 77: ['Person (temporary)', [255, 60, 200]], 11: ['Road surface', [60, 60, 66]] };
for (const k in XCLS) { CLASS_NAME[k] = XCLS[k][0]; CLASS_COL[k] = XCLS[k][1]; }
function itemClass(kind, x) {
  if (kind === 'pipe' || kind === 'bend') return 64; if (kind === 'flange' || kind === 'fitting') return 65; if (kind === 'vessel') return 66; if (kind === 'cylinder') return 67; if (kind === 'handrail') return 73; if (kind === 'box') return 74;
  if (kind === 'steel') { const sh = x.sec && x.sec.shape; return sh === 'I' ? 68 : sh === 'C' ? 69 : sh === 'L' ? 70 : sh === 'BOX' ? 71 : 72; } return 0;
}
async function classifyByCad(L, tol = 0.04) {
  if (!S.cad) { toast('Run Scan to CAD (or extract elements) first: classes come from the fitted elements.', true); return; }
  const items = cadItems().filter(([k, x]) => x.include !== false && itemClass(k, x)).sort((a, b) => (a[0] === 'flange' || a[0] === 'fitting') - (b[0] === 'flange' || b[0] === 'fitting'));   // fittings last so they win at joints
  const res = await busy('Classifying points by element type…', async onP => {
    const I = binIndex(L, 1); if (!L.cls) L.cls = new Uint8Array(L.n).fill(1); let n = 0; const counts = {};
    for (let k = 0; k < items.length; k++) { const [kind, x] = items[k]; const c = itemClass(kind, x), bb = itemAABB(kind, x, tol);
      for (const i of I.inBox([bb.min.x, bb.min.y], [bb.max.x, bb.max.y])) { const z = L.pos[i * 3 + 2]; if (z < bb.min.z || z > bb.max.z) continue; const d = itemDistance(kind, x, [L.pos[i * 3], L.pos[i * 3 + 1], z]); if (d > tol || (d < -tol && kind !== 'box' && kind !== 'vessel')) continue; if (L.cls[i] !== c) n++; L.cls[i] = c; counts[c] = (counts[c] || 0) + 1; }
      if ((k & 15) === 0) { onP(k / items.length); await tick(); } }
    return { n, counts };
  });
  if (!res) return; L.colorMode = 'class'; colorize(L); refreshProps();
  toast('Classified ' + Object.values(res.counts).reduce((a, b) => a + b, 0).toLocaleString() + ' points into ' + Object.keys(res.counts).map(k => CLASS_NAME[k]).join(', ') + '. Colour by Classification to see them; untick classes to hide them.');
}
async function classifyTerrain(L, opts = {}) {
  const res = await busy('Classifying ground, vegetation, buildings and roads…', async onP => {
    const sp = opts.spacing || 0.1; const vox = C_.voxelAssign(L.pos, L.n, sp); const reps = vox.reps; const P = C_.gather(L.pos, reps), m = reps.length;
    const T = await T_.classify(P, m, { spacing: sp, normalsFn: parNormalsFn(Math.max(0.5, sp * 8)) }, f => onP(f * 0.8));
    // spread the class of each voxel representative to every point in its voxel
    const cls = new Uint8Array(L.n); const owner = vox.assign || vox.map || null;
    if (owner) for (let i = 0; i < L.n; i++) cls[i] = T.cls[owner[i]] || 1;
    else { const G = new Map(); const key = (x, y, z) => Math.floor(x / sp) + ',' + Math.floor(y / sp) + ',' + Math.floor(z / sp); for (let r = 0; r < m; r++) G.set(key(P[r * 3], P[r * 3 + 1], P[r * 3 + 2]), T.cls[r]); for (let i = 0; i < L.n; i++) cls[i] = G.get(key(L.pos[i * 3], L.pos[i * 3 + 1], L.pos[i * 3 + 2])) || 1; }
    // roads: flat, smooth ground, grey or dark (bitumen/concrete), in big connected patches
    let roads = 0; if (opts.roads !== false) {
      const c = 1, b = L.box, nx = Math.ceil((b.max.x - b.min.x) / c) + 1, ny = Math.ceil((b.max.y - b.min.y) / c) + 1; const zmin = new Float32Array(nx * ny).fill(Infinity), zmax = new Float32Array(nx * ny).fill(-Infinity), grey = new Float32Array(nx * ny), cnt = new Uint32Array(nx * ny);
      for (let i = 0; i < L.n; i++) { if (cls[i] !== 2) continue; const k = Math.floor((L.pos[i * 3 + 1] - b.min.y) / c) * nx + Math.floor((L.pos[i * 3] - b.min.x) / c), z = L.pos[i * 3 + 2]; zmin[k] = Math.min(zmin[k], z); zmax[k] = Math.max(zmax[k], z); cnt[k]++;
        if (L.rgb) { const r = L.rgb[i * 3], g = L.rgb[i * 3 + 1], bl = L.rgb[i * 3 + 2], mx = Math.max(r, g, bl), mn = Math.min(r, g, bl); grey[k] += (mx - mn < 22 && mx < 150) ? 1 : 0; } else if (L.intensity) grey[k] += L.intensity[i] < 0.25 ? 1 : 0; }
      const cand = new Uint8Array(nx * ny); for (let k = 0; k < nx * ny; k++) if (cnt[k] >= 3 && zmax[k] - zmin[k] < 0.15 && grey[k] / cnt[k] > 0.6) cand[k] = 1;
      // keep big connected patches only, then grow by one cell to catch edges
      const lab = new Int32Array(nx * ny).fill(-1); const keep = new Uint8Array(nx * ny);
      for (let k = 0; k < nx * ny; k++) { if (!cand[k] || lab[k] >= 0) continue; const st = [k], comp = []; lab[k] = k; while (st.length) { const q = st.pop(); comp.push(q); const qi = q % nx, qj = (q / nx) | 0; for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const ii = qi + di, jj = qj + dj; if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue; const w = jj * nx + ii; if (cand[w] && lab[w] < 0) { lab[w] = k; st.push(w); } } } if (comp.length >= (opts.minRoad || 60)) for (const q of comp) keep[q] = 1; }
      for (let i = 0; i < L.n; i++) { if (cls[i] !== 2) continue; const k = Math.floor((L.pos[i * 3 + 1] - b.min.y) / c) * nx + Math.floor((L.pos[i * 3] - b.min.x) / c); if (keep[k]) { const isG = L.rgb ? (Math.max(L.rgb[i * 3], L.rgb[i * 3 + 1], L.rgb[i * 3 + 2]) - Math.min(L.rgb[i * 3], L.rgb[i * 3 + 1], L.rgb[i * 3 + 2]) < 30) : true; if (isG) { cls[i] = 11; roads++; } } }
    }
    return { cls, roads };
  });
  if (!res) return; if (opts.keepWater && L.cls) for (let i = 0; i < L.n; i++) { const c = L.cls[i]; if (c === 9 || (c >= 13 && c <= 17) || c >= 64) res.cls[i] = c; }   // keep water, wires, poles, bridge decks and plant classes already set
  L.cls = res.cls; L.colorMode = 'class'; applyClassHide(L); colorize(L); refreshProps();
  const cnt = {}; for (let i = 0; i < L.n; i++) cnt[L.cls[i]] = (cnt[L.cls[i]] || 0) + 1;
  toast('Classified: ' + Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 7).map(([k, v]) => (CLASS_NAME[k] || 'class ' + k) + ' ' + fmtN(v)).join(', ') + '.');
}

// ===== remove people (and other temporary standing figures) =====
async function findPeople(L) {
  const res = await busy('Looking for people…', async onP => {
    const found = await C_.detectPeople(L.pos, L.n, {}, onP);
    return found;
  });
  if (!res) return null; S.people = { layer: L, found: res };
  for (const f of res) addAnnotation(new THREE.Vector3(f.centre[0], f.centre[1], f.centre[2] + f.H), 'Person? ' + f.H.toFixed(2) + ' m tall', 'Found by the people filter', ['people'], '#ff3cc8');
  toast(res.length ? 'Found ' + res.length + ' possible ' + (res.length > 1 ? 'people' : 'person') + ', pinned and tagged "people". Check them, then remove.' : 'No people found.'); buildEdit(); return res;
}
function removePeople(mode) {
  const P0 = S.people; if (!P0 || !P0.found.length) return; const L = P0.layer; const inBox = i => P0.found.some(f => L.pos[i * 3] >= f.lo[0] && L.pos[i * 3] <= f.hi[0] && L.pos[i * 3 + 1] >= f.lo[1] && L.pos[i * 3 + 1] <= f.hi[1] && L.pos[i * 3 + 2] >= f.lo[2] && L.pos[i * 3 + 2] <= f.hi[2]);
  if (mode === 'class') { if (!L.cls) L.cls = new Uint8Array(L.n).fill(1); let c = 0; for (let i = 0; i < L.n; i++) if (inBox(i)) { L.cls[i] = 77; c++; } L.hiddenCls = L.hiddenCls || new Set(); L.hiddenCls.add(77); applyClassHide(L); colorize(L); refreshProps(); toast(c.toLocaleString() + ' points set to class 77 (Person) and hidden.'); }
  else { const keep = []; for (let i = 0; i < L.n; i++) if (!inBox(i)) keep.push(i); const rem = L.n - keep.length; replaceWithSubset(L, Uint32Array.from(keep)); toast('Removed ' + rem.toLocaleString() + ' points from ' + P0.found.length + ' people.'); }
  for (const a of S.annots.filter(a => (a.tags || []).includes('people'))) removeAnnotation(a); S.people = null; buildEdit(); buildReview();
}
const _buildEdit0 = buildEdit;
buildEdit = function () {
  _buildEdit0(); const p = pane('edit'); if (!p) return; const L = S.sel && S.sel.kind === 'cloud' ? S.sel : null;
  const n = S.people ? S.people.found.length : 0;
  p.append(el('div', { class: 'sec' }, el('h3', {}, 'Remove people'), el('div', { class: 'note' }, 'Finds people standing on floors and decks (1–2.1 m tall, narrow head, wider shoulders). Check the pins first, then remove them or move them to class 77 (Person), hidden.'),
    el('div', { class: 'row' }, el('button', { class: 'btn small primary', disabled: !L, onclick: () => findPeople(L) }, 'Find people'), el('button', { class: 'btn small danger', disabled: !n, onclick: () => removePeople('delete') }, 'Remove ' + (n || '')), el('button', { class: 'btn small', disabled: !n, onclick: () => removePeople('class') }, 'Hide as class 77'))),
    el('div', { class: 'sec' }, el('h3', {}, 'Classify'), el('div', { class: 'note' }, 'Terrain: ground, low/medium/high vegetation (trees), buildings and road surfaces (flat grey ground in large patches). Plant and structure: each point gets the class of the Scan to CAD element it lies on: pipe, fitting, vessel, I-section, channel, angle, hollow section, handrail, cabinet.'),
      el('div', { class: 'row' }, el('button', { class: 'btn small primary', disabled: !L, onclick: () => classifyTerrain(L, { keepWater: true }) }, 'Ground, trees, buildings, roads'), el('button', { class: 'btn small', disabled: !L || !S.cad, onclick: () => classifyByCad(L) }, 'Plant and structure by type'))));
};

// ===== flight paths: waypoint, orbit and survey paths; preview and frame-paced recording =====
S.paths = [];
function catmull(P, t) { const n = P.length; const i = Math.min(n - 2, Math.max(0, Math.floor(t))), f = t - i; const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(n - 1, i + 2)]; const f2 = f * f, f3 = f2 * f;
  return [0, 1, 2].map(k => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * f + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * f2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * f3)); }
function pathSamples(F) { const P = F.pts; if (P.length < 2) return null; const out = [], steps = (P.length - 1) * 40; let L = 0; for (let k = 0; k <= steps; k++) { const q = catmull(P, k / steps * (P.length - 1)); if (out.length) L += vlen(vsub(q, out[out.length - 1].p)); out.push({ p: q, s: L }); } return { pts: out, len: L }; }
function pathAt(F, S_, s) { const A = S_.pts; let lo = 0, hi = A.length - 1; s = Math.max(0, Math.min(S_.len, s)); while (hi - lo > 1) { const m = (lo + hi) >> 1; if (A[m].s < s) lo = m; else hi = m; } const a = A[lo], b = A[hi], f = (s - a.s) / ((b.s - a.s) || 1); return a.p.map((v, k) => v + (b.p[k] - v) * f); }
function pathCam(F, S_, t) {
  const s = (F.closed ? (t * F.speed) % S_.len : t * F.speed); const pos = pathAt(F, S_, s); let look;
  if (F.look === 'target' && F.target) look = F.target; else if (F.look === 'down') look = [pos[0] + 0.01, pos[1], pos[2] - 20]; else { const ahead = pathAt(F, S_, F.closed ? (s + 6) % S_.len : Math.min(S_.len, s + 6)); look = vlen(vsub(ahead, pos)) < 0.5 ? V3.add(pos, V3.norm(vsub(pathAt(F, S_, S_.len), pathAt(F, S_, Math.max(0, S_.len - 1)))), 6) : [ahead[0], ahead[1], ahead[2] - (F.tilt || 1.5)]; }
  const v = vsub(pos, look), d = vlen(v) || 1; return { target: look, dist: d, yaw: Math.atan2(v[1], v[0]), pitch: Math.asin(Math.max(-1, Math.min(1, v[2] / d))), ortho: false };
}
function drawPaths() {
  for (const F of S.paths) { if (F.obj) annot.remove(F.obj); const S_ = pathSamples(F); if (!S_ || F.hidden) continue; const g = new THREE.Group(); g.add(lineObj(S_.pts.map(q => new THREE.Vector3(...q.p)), false, 0x66ddff));
    for (const p of F.pts) { const m = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6), new THREE.MeshBasicMaterial({ color: 0x66ddff })); m.position.set(...p); g.add(m); }
    if (F.target && F.look === 'target') { const m = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff7a3d })); m.position.set(...F.target); g.add(m); }
    F.obj = g; annot.add(g); } S.dirty = true;
}
function newPathMode() {
  const F = { name: 'Flight ' + (S.paths.length + 1), pts: [], speed: S.flySpeed || 5, look: 'ahead', tilt: 1.5, closed: false };
  startMode({ type: 'path', text: 'Click waypoints; each sits ' + (S.flyAGL ?? 3) + ' m above the point you click · Enter to finish', finishable: true, dblFinish: true,
    onPick: pk => { S.mode.pts.push(pk.p.clone().setZ(pk.p.z + (S.flyAGL ?? 3))); refreshModeGraphics(); },
    onFinish: m => { if (m.pts.length < 2) { toast('A flight needs at least two waypoints.'); return; } F.pts = m.pts.map(v => [v.x, v.y, v.z]); S.paths.push(F); drawPaths(); buildReview(); } });
}
function orbitPathMode() {
  startMode({ type: 'path', text: 'Click the point to orbit around', onPick: pk => { cancelMode(); const c = [pk.p.x, pk.p.y, pk.p.z], r = S.orbitR || 20, h = S.orbitH || 10, pts = [];
    for (let k = 0; k <= 24; k++) { const a = k / 24 * 2 * Math.PI; pts.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a), c[2] + h]); }
    S.paths.push({ name: 'Orbit ' + (S.paths.length + 1), pts, speed: S.flySpeed || 5, look: 'target', target: c, closed: true }); drawPaths(); buildReview(); } });
}
function surveyPath() {
  const b = S.clip.on ? S.clip.box : sceneBox(); if (b.isEmpty()) return; const alt = b.max.z + (S.flyAGL ?? 3) * 5, gap = Math.max(5, (b.max.x - b.min.x) / 6), pts = []; let dir = 1;
  for (let x = b.min.x; x <= b.max.x + 1e-6; x += gap) { const ys = dir > 0 ? [b.min.y, b.max.y] : [b.max.y, b.min.y]; pts.push([x, ys[0], alt], [x, ys[1], alt]); dir = -dir; }
  S.paths.push({ name: 'Survey ' + (S.paths.length + 1), pts, speed: S.flySpeed || 8, look: 'down', closed: false, linear: true }); drawPaths(); buildReview();
}
function pathFromViews() { if (S.bookmarks.length < 2) { toast('Save at least two views first.', true); return; } const pts = S.bookmarks.map(b => { const c = b.cam, cp = Math.cos(c.pitch); return [c.target[0] + c.dist * cp * Math.cos(c.yaw), c.target[1] + c.dist * cp * Math.sin(c.yaw), c.target[2] + c.dist * Math.sin(c.pitch)]; }); S.paths.push({ name: 'From views', pts, speed: S.flySpeed || 5, look: 'ahead', tilt: 1.5 }); drawPaths(); buildReview(); }
const FLY = { playing: null };
async function playPath(F, record) {
  const S_ = pathSamples(F); if (!S_) return; const dur = (F.closed ? S_.len : S_.len) / Math.max(0.1, F.speed); const fps = S.flyFps || 30; FLY.stop = false; FLY.playing = F; buildReview();
  if (S.cam.ortho) toggleOrtho();
  let rec = null, chunks = [], track = null;
  if (record) { try { const st = canvas.captureStream(0); track = st.getVideoTracks()[0]; rec = new MediaRecorder(st, { mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm', videoBitsPerSecond: 12e6 }); rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); }; rec.start(); } catch (e) { toast('Recording is not available in this browser: ' + e.message, true); rec = null; } }
  const t0 = performance.now(); const nF = Math.ceil(dur * fps);
  for (let f = 0; f <= nF && !FLY.stop; f++) {
    const t = record ? f / fps : (performance.now() - t0) / 1000; if (!record && t > dur) break;
    applyCam(pathCam(F, S_, Math.min(t, dur))); draw(); if (track && track.requestFrame) track.requestFrame();
    const prog = $('#flyProg'); if (prog) prog.value = Math.min(1, t / dur);
    const wait = record ? Math.max(0, 1000 / fps - 2) : 0; await new Promise(r => wait ? setTimeout(r, wait) : requestAnimationFrame(r));
  }
  if (rec) { await new Promise(r => { rec.onstop = r; rec.stop(); }); const data = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer()); saveFile(F.name.replace(/[^\w-]+/g, '_') + '-flight.zip', IO.makeZip([{ name: F.name.replace(/[^\w-]+/g, '_') + '.webm', data }])); toast('Recorded ' + dur.toFixed(1) + ' s at ' + fps + ' fps. The zip holds a WebM video (plays in browsers and VLC).'); }
  FLY.playing = null; buildReview();
}
function buildPathsSec() {
  const sp = numIn('flySpeed', S.flySpeed || 5, '0.5'), agl = numIn('flyAGL', S.flyAGL ?? 3, '0.5'), orr = numIn('orbitR', S.orbitR || 20, '1'), orh = numIn('orbitH', S.orbitH || 10, '1');
  const fps = el('select', { id: 'flyFps', style: 'width:auto' }, ...[24, 30, 60].map(v => el('option', { value: v, selected: (S.flyFps || 30) === v }, v + ' fps')));
  sp.addEventListener('change', () => { S.flySpeed = +sp.value; }); agl.addEventListener('change', () => { S.flyAGL = +agl.value; }); orr.addEventListener('change', () => { S.orbitR = +orr.value; }); orh.addEventListener('change', () => { S.orbitH = +orh.value; }); fps.addEventListener('change', () => { S.flyFps = +fps.value; });
  const list = el('div', { class: 'mlist' }); if (!S.paths.length) list.append(el('div', { class: 'empty' }, 'Draw a flight path, then preview it or record it as a video.'));
  for (const F of S.paths) {
    const S_ = pathSamples(F); const nm = el('input', { type: 'text', value: F.name, 'aria-label': 'Flight name' }); nm.addEventListener('change', () => { F.name = nm.value; });
    const spd = el('input', { type: 'number', value: F.speed, step: '0.5', 'aria-label': 'Speed (m/s)', style: 'width:70px' }); spd.addEventListener('change', () => { F.speed = Math.max(0.1, +spd.value); buildReview(); });
    const lk = el('select', { 'aria-label': 'Camera looks', style: 'width:auto' }, ...[['ahead', 'Look ahead'], ['target', 'Look at a point'], ['down', 'Look straight down']].map(([v, t]) => el('option', { value: v, selected: F.look === v }, t)));
    lk.addEventListener('change', () => { F.look = lk.value; if (F.look === 'target' && !F.target) startMode({ type: 'path', text: 'Click the point the camera looks at', onPick: pk => { cancelMode(); F.target = [pk.p.x, pk.p.y, pk.p.z]; drawPaths(); buildReview(); } }); drawPaths(); });
    const playing = FLY.playing === F;
    list.append(el('div', { class: 'mitem', style: 'grid-template-columns:minmax(0,1fr)' }, el('div', { style: 'display:grid;gap:4px' }, el('div', { class: 'row', style: 'flex-wrap:nowrap' }, nm, spd, el('span', { class: 'hint' }, 'm/s')),
      el('div', { class: 'row' }, lk, el('span', { class: 'hint' }, F.pts.length + ' waypoints · ' + (S_ ? S_.len.toFixed(0) + ' m · ' + (S_.len / F.speed).toFixed(1) + ' s' : ''))),
      playing ? el('progress', { id: 'flyProg', value: 0, max: 1, style: 'width:100%' }) : null,
      el('div', { class: 'row' }, playing ? el('button', { class: 'btn small danger', onclick: () => { FLY.stop = true; } }, 'Stop') : el('button', { class: 'btn small primary', disabled: !!FLY.playing, onclick: () => playPath(F, false) }, 'Preview'),
        el('button', { class: 'btn small', disabled: !!FLY.playing, onclick: () => playPath(F, true) }, 'Record video'),
        el('button', { class: 'btn small', onclick: () => { F.hidden = !F.hidden; drawPaths(); buildReview(); } }, F.hidden ? 'Show path' : 'Hide path'),
        el('button', { class: 'btn small icon danger', 'aria-label': 'Delete flight', onclick: () => { if (F.obj) annot.remove(F.obj); S.paths = S.paths.filter(x => x !== F); S.dirty = true; buildReview(); } }, '×')))));
  }
  return el('div', { class: 'sec' }, el('h3', {}, 'Flight simulator'), el('div', { class: 'note' }, 'Plan a camera flight like a drone: click waypoints, orbit a point, or fly a survey pattern over the clip box. Record renders every frame at a steady rate, so the video plays smoothly even on big clouds (keep the clip box and point budget sensible).'),
    el('div', { class: 'row' }, el('button', { class: 'btn small primary', onclick: newPathMode }, 'Draw waypoints'), el('button', { class: 'btn small', onclick: orbitPathMode }, 'Orbit a point'), el('button', { class: 'btn small', onclick: surveyPath }, 'Survey pattern'), el('button', { class: 'btn small', onclick: pathFromViews }, 'Through saved views')),
    fieldRow('Speed (m/s)', sp), fieldRow('Height above clicks (m)', agl), fieldRow('Orbit radius / height (m)', el('div', { class: 'row', style: 'flex-wrap:nowrap' }, orr, orh)), fieldRow('Video frame rate', fps), list);
}

// ===== batch Scan to CAD: tile the whole cloud (or the clip box) and run in the background =====
const BATCH = { running: false, stop: false };
function centreIn(kind, x, lo, hi) { const c = itemCentre(kind, x); return c[0] >= lo[0] && c[0] < hi[0] && c[1] >= lo[1] && c[1] < hi[1]; }
function mergeCollinear(list, sameType) {
  let merged = true; while (merged) { merged = false;
    outer: for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) { const a = list[i], b = list[j]; if (!sameType(a, b)) continue; if (Math.abs(V3.dot(a.axis, b.axis)) < 0.999) continue;
      const off = q => { const d = vsub(q, a.p0), t = V3.dot(d, a.axis); return vlen(vsub(d, a.axis.map(v => v * t))); }; const tol = Math.max(0.03, (a.r || 0.05) * 0.5); if (off(b.p0) > tol || off(b.p1) > tol) continue;
      const ts = [a.p0, a.p1, b.p0, b.p1].map(q => V3.dot(vsub(q, a.p0), a.axis)); const [ta0, ta1] = [Math.min(ts[0], ts[1]), Math.max(ts[0], ts[1])], [tb0, tb1] = [Math.min(ts[2], ts[3]), Math.max(ts[2], ts[3])]; if (tb0 > ta1 + 0.35 || ta0 > tb1 + 0.35) continue;
      const t0 = Math.min(ta0, tb0), t1 = Math.max(ta1, tb1); const p0 = a.p0.slice(); a.p0 = V3.add(p0, a.axis, t0); a.p1 = V3.add(p0, a.axis, t1); a.length = t1 - t0; if (a.rms !== undefined && b.rms !== undefined) a.rms = Math.max(a.rms, b.rms);
      list.splice(j, 1); merged = true; break outer; } }
}
async function batchScanToCad(L, scope, tile = 8, overlap = 0.6) {
  if (BATCH.running) return; const D = scope === 'dataset' ? S.selStream : null; let b = D ? (S.clip.on ? S.clip.box.clone().intersect(D.box) : D.box.clone()) : scope === 'clip' && S.clip.on ? S.clip.box.clone() : L.box.clone(); if (b.isEmpty()) return;
  const tiles = []; for (let x = b.min.x; x < b.max.x; x += tile) for (let y = b.min.y; y < b.max.y; y += tile) tiles.push([x, y]);
  BATCH.running = true; BATCH.stop = false; BATCH.done = 0; BATCH.total = tiles.length; BATCH.t0 = performance.now(); BATCH.found = 0; buildCad(); await poolReady();
  if (!S.cad) S.cad = emptyCad(); normCad(S.cad); cadSnapshot(); const opts = { spacing: Math.max(0.005, S.cadSp || 0.015), minR: (S.cadMinD || 20) / 2000, maxR: (S.cadMaxD || 800) / 2000, pipes: S.cadPipes, steel: S.cadSteel, planes: S.cadPl, flanges: S.cadFl, handrails: S.cadRail, vessels: S.cadVes, boxes: S.cadBox, normalsFn: parNormalsFn(Math.max(0.05, (S.cadSp || 0.015) * 8)) };
  try {
    for (const [x, y] of tiles) {
      if (BATCH.stop) break; const lo = [x, y], hi = [Math.min(x + tile, b.max.x + 1e-6), Math.min(y + tile, b.max.y + 1e-6)];
      const box = [lo[0] - overlap, lo[1] - overlap, b.min.z, hi[0] + overlap, hi[1] + overlap, b.max.z];
      let any = false, src = L; if (D) { try { const tb = new THREE.Box3(new THREE.Vector3(box[0], box[1], box[2]), new THREE.Vector3(box[3], box[4], box[5])); src = await readBox(D, tb, 2e7); any = src.n > 200; } catch (e) { toast(e.message + ' Use a smaller tile size.', true); BATCH.stop = true; break; } }
      else for (let i = 0; i < L.n; i += 97) { const px = L.pos[i * 3], py = L.pos[i * 3 + 1]; if (px >= box[0] && px <= box[3] && py >= box[1] && py <= box[4]) { any = true; break; } }
      if (any) { let r = null; try { r = await C_.scanToCad(src.pos, src.n, Object.assign(D ? {} : { box }, opts), f => { BATCH.tileF = f; const e = $('#batchBar'); if (e) e.value = (BATCH.done + f) / BATCH.total; }); } catch (e) { console.warn(e); }
        if (r) { normCad(r); for (const [k] of CAD_KINDS) { if (k === 'flanges' || k === 'fittings') continue; for (const it of r[k]) { const kind = CAD_KINDS.find(c => c[0] === k)[1]; if (!centreIn(kind, it, lo, hi)) continue; delete it.idx; S.cad[k].push(it); BATCH.found++; if (k === 'pipes') for (const f of [...r.flanges, ...r.fittings]) if (f.pipe === it) (f.type === 'flange' ? S.cad.flanges : S.cad.fittings).push(f); } } } }
      BATCH.done++; drawCad(); buildCad(); await tick();
    }
    mergeCollinear(S.cad.pipes, (a, b) => Math.abs(a.r - b.r) < Math.max(0.004, a.r * 0.08)); mergeCollinear(S.cad.steel, (a, b) => a.label === b.label);
    S.cad.bends = C_.findBends(S.cad.pipes); S.cad.n = (S.cad.n || 0); drawCad();
    toast((BATCH.stop ? 'Batch stopped after ' : 'Batch finished: ') + BATCH.done + ' of ' + BATCH.total + ' tiles in ' + ((performance.now() - BATCH.t0) / 60000).toFixed(1) + ' min. ' + S.cad.pipes.length + ' pipes, ' + S.cad.steel.length + ' steel, ' + S.cad.vessels.length + ' vessels, ' + S.cad.boxes.length + ' cabinets/equipment, ' + S.cad.handrails.length + ' handrails.');
  } finally { BATCH.running = false; buildCad(); }
}
function batchSec() {
  const L = S.sel && S.sel.kind === 'cloud' ? S.sel : null; const ts = numIn('batchTile', S.batchTile || 8, '1');
  const scope = el('select', { id: 'batchScope', style: 'width:auto' }, el('option', { value: 'all', selected: S.batchScope !== 'clip' }, 'The whole cloud'), el('option', { value: 'clip', selected: S.batchScope === 'clip' }, 'Inside the clip box'), S.selStream ? el('option', { value: 'dataset', selected: S.batchScope === 'dataset' }, 'Selected dataset: ' + S.selStream.meta.name + (S.clip.on ? ' (clip box)' : '')) : null);
  scope.addEventListener('change', () => { S.batchScope = scope.value; }); ts.addEventListener('change', () => { S.batchTile = +ts.value; });
  const sec = el('div', { class: 'sec' }, el('h3', {}, 'Batch processing'), el('div', { class: 'note' }, 'Runs Scan to CAD over a whole project or clip area, tile by tile, in the background: keep working while it runs. Results appear as each tile finishes; members cut by tile edges are joined at the end. Uses the element types ticked above.'),
    fieldRow('Area', scope), fieldRow('Tile size (m)', ts));
  if (BATCH.running) { const el_ = (BATCH.done / BATCH.total); const mins = (performance.now() - BATCH.t0) / 60000, eta = BATCH.done ? mins / BATCH.done * (BATCH.total - BATCH.done) : NaN;
    sec.append(el('progress', { id: 'batchBar', value: el_, max: 1, style: 'width:100%' }), el('div', { class: 'hint' }, 'Tile ' + Math.min(BATCH.total, BATCH.done + 1) + ' of ' + BATCH.total + ' · ' + BATCH.found + ' elements so far' + (isFinite(eta) ? ' · about ' + eta.toFixed(0) + ' min left' : '')), el('button', { class: 'btn small danger', onclick: () => { BATCH.stop = true; toast('Stopping after this tile…'); } }, 'Stop')); }
  else sec.append(el('button', { class: 'btn small primary', disabled: !L && !S.selStream, onclick: () => { S.batchTile = +ts.value; S.batchScope = scope.value; if (scope.value === 'clip' && !S.clip.on) { toast('Turn the clipping box on first, or choose the whole cloud.', true); return; } batchScanToCad(L, scope.value, Math.max(2, S.batchTile)); } }, 'Start batch'));
  return sec;
}
const _buildCad0 = buildCad;
buildCad = function () { _buildCad0(); const p = pane('cad'); if (!p) return; const secs = p.querySelectorAll('.sec'); const after = secs[1] || secs[0]; if (after) after.after(batchSec()); p.append(cadCmpSec()); };
