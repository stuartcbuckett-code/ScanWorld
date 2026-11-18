// ---------- CAD deliverable: the topo linework written to a layer standard (Water Corporation S551 built in, or your own DXF template) ----------
const CADO = { tpl: null, tplName: '', std: 's551', map: null, rows: null };
function cadStdRows() { if (!CADO.rows) { CADO.rows = new Map(); for (const r of (window.S551 && window.S551.layers) || []) CADO.rows.set(r.layer, r); } return CADO.rows; }
function cadTemplate() {
  if (!CADO.tpl) { if (!window.S551_DXF) return null; CADO.tpl = SBCAD.readTemplate(window.S551_DXF); CADO.tplName = 'Water Corporation S551, Appendix B (' + CADO.tpl.layers.length + ' layers)'; CADO.std = 's551'; }
  if (!CADO.map) CADO.map = SBCAD.matchLayers(CADO.tpl.layers, CADO.std);
  return CADO.tpl;
}
async function cadLoadTemplate(f) {
  let txt;
  if (/\.dwg$/i.test(f.name)) { if (!window.SBDWG) { toast('Browsers cannot read .dwg files directly. In AutoCAD, open the template and Save As → AutoCAD 2010 DXF (or later), then load that DXF here; it keeps every layer, linetype and block.', true); return; } txt = await busy('Reading ' + f.name + '…', async () => window.SBDWG.dwgToDxf(new Uint8Array(await f.arrayBuffer()))); if (!txt) return; }
  else txt = await f.text();
  const T = SBCAD.readTemplate(txt); if (!T.layers.length) { toast(f.name + ' has no layers.', true); return; }
  cadTagS551(T); if (f.save !== false) { await STDDB.put(f.name.replace(/\.dxf$/i, ''), txt); CADO.stdName = f.name.replace(/\.dxf$/i, ''); }
  CADO.tpl = T; CADO.tplName = f.name.replace(/\.dxf$/i, '') + ' (' + T.layers.length + ' layers)'; CADO.std = T.layers.filter(L => L.code).length >= 10 ? 's551' : 'own'; CADO.map = SBCAD.matchLayers(T.layers, CADO.std);
  const n = Object.keys(CADO.map).length; toast('Template ' + f.name + ': ' + T.layers.length + ' layers; ' + n + ' of ' + SBCAD.FEATURES.length + ' feature types matched by name and description. Check the list under CAD deliverable.'); buildTopo();
}
// layers of a template that carry S551 names get their S551 codes (so the S551 mapping and symbols apply to Water Corporation's own template files too)
function cadTagS551(T) { const rows = cadStdRows(); const byName = new Map([...rows.values()].map(r => [r.layer.toLowerCase(), r])); for (const L of T.layers) { if (L.code) continue; const r = byName.get(L.name.toLowerCase()); if (r) { L.code = r.code; if (!L.description) L.description = r.description; } } }
// standards kept in this browser: the built-in S551, plus any template you add (stored with ScanBench in this browser)
const STDDB = { op(mode, fn) { return new Promise((res, rej) => { const r = indexedDB.open('scanbench-standards', 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onerror = () => rej(r.error); r.onsuccess = () => { const t = r.result.transaction('s', mode); const q = fn(t.objectStore('s')); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }; }); },
  async list() { try { return (await this.op('readonly', s => s.getAllKeys())) || []; } catch (e) { return []; } }, async get(k) { try { return await this.op('readonly', s => s.get(k)); } catch (e) { return null; } },
  async put(k, v) { try { await this.op('readwrite', s => s.put(v, k)); } catch (e) { } }, async del(k) { try { await this.op('readwrite', s => s.delete(k)); } catch (e) { } } };
async function cadUseStandard(name) {
  if (!name) { CADO.tpl = null; CADO.map = null; CADO.stdName = ''; buildTopo(); return; }
  const txt = await STDDB.get(name); if (!txt) { toast('That standard is no longer stored here.', true); return; }
  await cadLoadTemplate({ name: name + '.dxf', text: async () => txt, save: false }); CADO.stdName = name; buildTopo();
}

// the topo result as features
function cadFeatures() {
  const t = S.topo; if (!t) return {}; const W = p => wpt(p); const zAt = (x, y, d) => { const z = T_.tinZ(t.tin, x, y, t.idxGrid); return isFinite(z) ? z : d; };
  const F = {}; const add = (k, e) => (F[k] || (F[k] = [])).push(e);
  for (const s of t.spots) { add('spot', { type: 'INSERT', p: W(s), sym: true }); add('spotText', { type: 'TEXT', p: W([s[0] + 0.15, s[1] + 0.1, s[2]]), h: 0.2, text: (s[2] + S.origin[2]).toFixed(2) }); }
  // breaklines that only repeat a kerb are left out (the kerb lines carry that step)
  const kh = new Set(), kc = 0.5; for (const k of ((t.surfaces || {}).kerbs || [])) for (const L of [k.front, k.back]) for (let q = 1; q < L.length; q++) { const a = L[q - 1], b = L[q], m = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.2)); for (let u = 0; u <= m; u++) kh.add(Math.floor((a[0] + (b[0] - a[0]) * u / m) / kc) + ',' + Math.floor((a[1] + (b[1] - a[1]) * u / m) / kc)); }
  const nearKerb = p => { const i = Math.floor(p[0] / kc), j = Math.floor(p[1] / kc); for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (kh.has((i + a) + ',' + (j + b))) return true; return false; };
  for (const b of t.breaklines) { let run = []; const flush = () => { if (run.length >= 2) add(b.kind === 'top' ? 'breakTop' : b.kind === 'toe' ? 'breakToe' : 'breakline', { type: 'POLY', pts: run.map(W) }); run = []; };
    for (const p of b.pts) { if (kh.size && nearKerb(p)) flush(); else run.push(p); } flush(); }
  for (const c of S.topoContours || []) { add(c.major ? 'contMajor' : 'contMinor', { type: 'POLY', pts: c.pts.map(W) });
    if (c.major) { let acc = 0; for (let i = 1; i < c.pts.length; i++) { const a = c.pts[i - 1], b = c.pts[i]; acc += Math.hypot(b[0] - a[0], b[1] - a[1]); if (acc > 40) { acc = 0; let rot = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI; if (rot > 90) rot -= 180; if (rot < -90) rot += 180; add('contText', { type: 'TEXT', p: W(a), h: 0.3, rot, text: (c.level + S.origin[2]).toFixed(2) }); } } } }
  if (S.tDxfTin !== false) for (let i = 0; i < t.tin.tris.length; i += 3) add('tin', { type: '3DFACE', pts: [W(t.tin.pts[t.tin.tris[i]]), W(t.tin.pts[t.tin.tris[i + 1]]), W(t.tin.pts[t.tin.tris[i + 2]])] });
  for (const T of t.trees) { const p = [T.x, T.y, T.groundZ]; add('tree', { type: 'INSERT', p: W(p), sym: true }); add('tree', { type: 'CIRCLE', p: W(p), r: T.spread / 2 }); add('treeText', { type: 'TEXT', p: W([T.x + 0.4, T.y - 0.1, T.groundZ]), h: 0.2, text: 'TREE H' + T.height.toFixed(1) + ' S' + T.spread.toFixed(1) }); }
  for (const B of t.buildings) { add('bldg', { type: 'POLY', closed: true, pts: B.loop.map(q => W([q[0], q[1], zAt(q[0], q[1], B.groundZ)])) }); add('roof', { type: 'POLY', closed: true, pts: B.loop.map(q => W([q[0], q[1], B.roofZ])) }); }
  for (const P of t.poles) { add('pole', { type: 'INSERT', p: W([P.x, P.y, P.groundZ]), sym: true }); add('treeText', { type: 'TEXT', p: W([P.x + 0.3, P.y - 0.1, P.groundZ]), h: 0.2, text: 'POLE H' + P.height.toFixed(1) }); }
  for (const w of t.walls) { add('wallToe', { type: 'POLY', pts: [W([w.a[0], w.a[1], w.groundZ]), W([w.b[0], w.b[1], w.groundZ])] }); add('wallTop', { type: 'POLY', pts: [W([w.a[0], w.a[1], w.groundZ + w.height]), W([w.b[0], w.b[1], w.groundZ + w.height])] }); }
  const sf = t.surfaces || {};
  for (const r of sf.roads || []) { for (const e of (r.edgesNoKerb || r.edges)) add('roadEdge', { type: 'POLY', pts: e.map(W) }); for (const c of r.centre) add('roadCentre', { type: 'POLY', pts: c.map(W) }); }
  for (const k of sf.kerbs || []) { add('kerbFront', { type: 'POLY', pts: k.front.map(W) }); add('kerbBack', { type: 'POLY', pts: k.back.map(W) }); }
  for (const r of sf.paths || []) for (const e of r.edges) add('pathEdge', { type: 'POLY', pts: e.map(W) });
  for (const r of sf.tracks || []) { for (const e of r.edges) add('trackEdge', { type: 'POLY', pts: e.map(W) }); for (const c of r.centre) add('trackCentre', { type: 'POLY', pts: c.map(W) }); }
  for (const w of sf.water || []) for (const e of w.edges) add('water', { type: 'POLY', pts: e.map(W) });
  return F;
}
function cadEntities(T, F) {
  const map = CADO.map || {}, rows = cadStdRows(), out = []; let skipped = 0;
  for (const [k, list] of Object.entries(F)) {
    let layer = map[k]; if (!layer && (k === 'breakTop' || k === 'breakToe')) layer = map.breakline; if (!layer) { skipped += list.length; continue; }
    const row = rows.get(layer), sym = row && row.symbol && T.blocks.has(row.symbol) ? row.symbol : null;
    for (const e of list) { if (e.type === 'INSERT') { if (sym) out.push({ type: 'INSERT', block: sym, p: e.p, layer }); out.push({ type: 'POINT', p: e.p, layer }); } else out.push(Object.assign({}, e, { layer })); }
  }
  return { ents: out, skipped };
}
function cadExport(fmt) {
  const T = cadTemplate(); if (!T || !S.topo) return; const F = cadFeatures(); const { ents, skipped } = cadEntities(T, F); if (!ents.length) { toast('Nothing to export: no feature type is mapped to a layer.', true); return; }
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; for (const e of ents) for (const p of e.pts || [e.p]) if (p) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
  const dxf = SBCAD.writeInto(T, ents, { ext: [mn, mx] }); const base = (S.topo.layer ? S.topo.layer.name.replace(/\.[^.]+$/, '') : 'survey').replace(/[^\w.-]+/g, '_') + (CADO.std === 's551' ? '_S551' : '');
  if (fmt === 'dwg') { if (!window.SBDWG) { toast('DWG export is not in this build; use the DXF.', true); return; } busy('Writing DWG…', async () => { const b = await window.SBDWG.dxfToDwg(dxf); saveFile(base + '.dwg', new Blob([b])); return true; }); }
  else saveFile(base + '.dxf', dxf);
  const used = new Set(ents.map(e => e.layer)); toast((fmt === 'dwg' ? 'DWG' : 'DXF') + ': ' + ents.length.toLocaleString() + ' entities on ' + used.size + ' layers of ' + (CADO.std === 's551' ? 'S551' : 'your template') + ' (3D, ' + crsLabel() + ').' + (skipped ? ' ' + skipped + ' items had no layer and were left out.' : ''));
}
function cadExportTemplate() { const T = cadTemplate(); if (!T) return; saveFile(CADO.std === 's551' ? 'S551_layers_template.dxf' : 'template.dxf', T.txt); }

const _buildTopoC = buildTopo;
buildTopo = function () {
  _buildTopoC(); const p = $('#topoMain'); if (!p) return; const T = cadTemplate(); if (!T) return;
  const pick = el('input', { type: 'file', hidden: true, accept: '.dxf,.dwg' }); pick.addEventListener('change', () => { const f = pick.files[0]; pick.value = ''; if (f) cadLoadTemplate(f); });
  const stdSel = el('select', { 'aria-label': 'Layer standard', style: 'width:auto;max-width:100%' }, el('option', { value: '', selected: !CADO.stdName }, 'Water Corporation S551 (built in)'));
  STDDB.list().then(ks => { for (const k of ks) stdSel.append(el('option', { value: k, selected: k === CADO.stdName }, k)); }); stdSel.addEventListener('change', () => cadUseStandard(stdSel.value));
  const stdRow = el('div', { class: 'row' }, el('span', { class: 'hint' }, 'Standard'), stdSel);
  const F = S.topo ? cadFeatures() : {}; const layerNames = T.layers.map(L => L.name).filter(n => n !== '0' && !/^defpoints$/i.test(n)).sort();
  const rows = SBCAD.FEATURES.map(Fe => { const sel = el('select', { style: 'width:100%;max-width:230px;font-size:11px', 'aria-label': Fe.name + ' layer' }, el('option', { value: '' }, '(leave out)'), ...layerNames.map(n => el('option', { value: n, selected: (CADO.map || {})[Fe.k] === n }, n)));
    sel.addEventListener('change', () => { CADO.map[Fe.k] = sel.value || undefined; }); const n = (F[Fe.k] || []).length;
    return el('tr', {}, el('td', { style: 'font-size:11px;padding:2px 4px' }, Fe.name), el('td', { class: 'mono', style: 'font-size:11px;text-align:right;padding:2px 4px;color:var(--muted)' }, S.topo ? String(n) : ''), el('td', { style: 'padding:2px 0' }, sel)); });
  const sf = S.topo && S.topo.surfaces;
  p.append(el('div', { class: 'sec' }, el('h3', {}, 'CAD deliverable (layer standard)'),
    el('div', { class: 'note' }, 'Writes the survey as 3D linework into a copy of the template, so every layer, colour, linetype, lineweight and symbol block comes from the standard. Template: ', el('b', {}, CADO.tplName), '. Features are matched to layers by the standard\'s codes, or by the words in each layer\'s name and description for your own template; change any of them below.'),
    stdRow, el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: () => pick.click() }, 'Add a standard (DXF template)…'), CADO.stdName ? el('button', { class: 'btn small danger', onclick: async () => { if (!confirm('Remove the standard "' + CADO.stdName + '" from this browser?')) return; await STDDB.del(CADO.stdName); cadUseStandard(''); } }, 'Remove this standard') : null, pick),
    sf ? el('div', { class: 'hint' }, 'Found: ' + sf.roads.length + ' sealed road areas, ' + sf.kerbs.length + ' kerb runs, ' + sf.paths.length + ' paths, ' + sf.tracks.length + ' unsealed tracks, ' + sf.water.length + ' water areas.') : null,
    el('details', {}, el('summary', { class: 'hint', style: 'cursor:pointer' }, 'Layers used (' + Object.keys(CADO.map || {}).length + ' of ' + SBCAD.FEATURES.length + ' features mapped)'), el('table', { style: 'width:100%;border-collapse:collapse' }, ...rows)),
    el('div', { class: 'row' }, el('button', { class: 'btn small primary', disabled: !S.topo, onclick: () => cadExport('dxf') }, 'Export DXF'), el('button', { class: 'btn small', onclick: cadExportTemplate }, 'Empty template')),
    el('div', { class: 'hint' }, 'The DXF is AutoCAD 2000 format with every layer of the template: open it in AutoCAD or Civil 3D and Save As DWG (or batch-convert with the free ODA File Converter). Heights are 3D on every line, point and block.'),
    S.topo ? null : el('div', { class: 'hint' }, 'Run Process topo first (on a cloud layer; for a streamed dataset use Box → layer).')));
};
