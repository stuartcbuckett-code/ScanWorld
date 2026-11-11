// ===== ScanBench: vegetation analysis and bushfire hazard (Topo tab) =====
const VEG = { res: null, fire: null, obj: null, fireObj: null, showMap: true, opts: { ffdi: 80, litterCanopy: 70, litterOpen: 0, flammability: 2, cell: 5 } };
const f1 = (v, d = 1) => Number.isFinite(v) ? v.toFixed(d) : '–';
function vegClear() { if (VEG.obj) annot.remove(VEG.obj); if (VEG.fireObj) annot.remove(VEG.fireObj); VEG.obj = VEG.fireObj = VEG.res = VEG.fire = null; S.dirty = true; }
const _clearTopoV = clearTopo; clearTopo = function () { vegClear(); _clearTopoV(); };
function vegDraw() {
  if (VEG.obj) annot.remove(VEG.obj); VEG.obj = null; const v = VEG.res; if (!v) return; const g = new THREE.Group();
  const ring = (x, y, z, r) => { const a = []; for (let k = 0; k <= 24; k++) a.push([x + Math.cos(k / 24 * 2 * Math.PI) * r, y + Math.sin(k / 24 * 2 * Math.PI) * r, z]); return a; };
  g.add(linesObj(v.trees.filter(T => T.dbh).map(T => ring(T.trunkX, T.trunkY, T.groundZ + 1.3, T.dbh / 2)), 0xffa040));
  g.add(linesObj(v.trees.filter(T => Number.isFinite(T.crownBase)).map(T => ring(T.x, T.y, T.groundZ + T.crownBase, T.spread / 2)), 0x8fd18f));
  VEG.obj = g; annot.add(g); S.dirty = true;
}
function fireDraw() {
  if (VEG.fireObj) annot.remove(VEG.fireObj); VEG.fireObj = null; const F = VEG.fire; if (!F || !VEG.showMap) { S.dirty = true; return; }
  const n = F.cells.length, pos = new Float32Array(n * 18), col = new Float32Array(n * 18), h = F.cell / 2 * 0.96, c = new THREE.Color(); let q = 0;
  for (const C of F.cells) { c.setHex(F.classes[C.rating].color); const z = C.z + 0.3, x0 = C.x - h, x1 = C.x + h, y0 = C.y - h, y1 = C.y + h;
    for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y0], [x1, y1], [x0, y1]]) { pos[q] = x; pos[q + 1] = y; pos[q + 2] = z; col[q] = c.r; col[q + 1] = c.g; col[q + 2] = c.b; q += 3; } }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, depthTest: false })); m.renderOrder = 6;
  VEG.fireObj = m; annot.add(m); S.dirty = true;
}
function vegRun() {
  if (!S.topo) { toast('Process topo first: the vegetation tools use its ground and tree pick-up.', true); return; }
  VEG.res = T_.vegetation(S.topo, {}); VEG.fire = null; if (VEG.fireObj) { annot.remove(VEG.fireObj); VEG.fireObj = null; } vegDraw(); buildTopo();
  toast(VEG.res.trees.length + ' trees analysed, ' + VEG.res.stand.trunksMeasured + ' trunks measured.');
}
function litterZones() { return S.measures.filter(M => M.type === 'area' && M.litter !== undefined && M.litter !== '' && Number.isFinite(+M.litter)).map(M => ({ name: M.name, depth: Math.max(0, +M.litter), poly: M.pts.map(p => [p.x, p.y]) })); }
function fireRun() {
  if (!S.topo) { toast('Process topo first.', true); return; } if (!VEG.res) VEG.res = T_.vegetation(S.topo, {});
  VEG.fire = T_.fireHazard(S.topo, VEG.res, Object.assign({}, VEG.opts, { zones: litterZones() })); vegDraw(); fireDraw(); buildTopo();
  const s = VEG.fire.summary; toast('Bushfire hazard mapped over ' + f1(s.areaHa, 1) + ' ha.');
}
const csvCell = v => typeof v === 'number' ? (Number.isFinite(v) ? String(+v.toFixed(3)) : '') : v == null ? '' : '"' + String(v).replace(/"/g, '""') + '"';
function vegExportTrees() {
  const o = S.origin, rows = [['Tree', 'Easting', 'Northing', 'Ground RL', 'Height m', 'Crown spread m', 'Crown area m2', 'Crown base height m', 'Crown depth m', 'Crown volume m3', 'Trunk diameter at 1.3 m (m)', 'Canopy returns']];
  for (const T of VEG.res.trees) rows.push([T.id, T.trunkX + o[0], T.trunkY + o[1], T.groundZ + o[2], T.height, T.spread, T.crownArea, T.crownBase, T.crownDepth, T.crownVolume, T.dbh, T.returns]);
  saveFile('vegetation_trees.csv', '# ScanBench vegetation analysis · ' + crsLabel() + '\n' + rows.map(r => r.map(csvCell).join(',')).join('\n'));
}
function fireExport() {
  const o = S.origin, F = VEG.fire, rows = [['Easting', 'Northing', 'Ground RL', 'Rating', 'Fireline intensity kW/m', 'Rate of spread m/h', 'Flame height m', 'Fuel modelled t/ha', 'Fuel total t/ha', 'Litter depth mm', 'Litter t/ha', 'Scrub t/ha', 'Slope deg', 'Canopy cover', 'Elevated cover', 'Near-surface cover', 'Elevated fuel height m', 'Canopy base height m', 'Crown fire likely', 'Ladder fuel', 'Litter zone']];
  for (const C of F.cells) rows.push([C.x + o[0], C.y + o[1], C.z + o[2], F.classes[C.rating].name, C.intensity, C.ros, C.flame, C.fuel, C.fuelTotal, C.litterDepth, C.litterLoad, C.scrubLoad, C.slope, C.canopy, C.elevated, C.nearSurface, C.elevatedHeight, C.crownBase, C.crownFire ? 'yes' : 'no', C.ladder ? 'yes' : 'no', C.zone]);
  const I = F.inputs, head = '# ScanBench bushfire hazard screening · ' + crsLabel() + ' · cell ' + F.cell + ' m\n# Inputs: FFDI ' + I.ffdi + ', litter under canopy ' + I.litterCanopy + ' mm, litter in the open ' + I.litterOpen + ' mm, ' + I.zones + ' litter zones, scrub condition factor ' + I.flammability + '\n# Method: northern jarrah litter depth to weight table; McArthur Mk5 forest spread (Noble et al. 1980) with slope; Byram fireline intensity; Van Wagner (1977) crown fire initiation.\n# Screening only: not a Bushfire Attack Level (AS 3959) assessment.\n';
  saveFile('bushfire_hazard.csv', head + rows.map(r => r.map(csvCell).join(',')).join('\n'));
}
const _buildTopoV = buildTopo;
buildTopo = function () {
  _buildTopoV(); const p = $('#topoMain'); if (!p) return; const has = !!S.topo, v = VEG.res, F = VEG.fire;
  const tbl = rows => el('table', { style: 'width:100%;font-size:12px;border-collapse:collapse' }, ...rows.map(r => el('tr', {}, ...r.map((c, i) => el('td', { style: 'padding:2px 4px;' + (i ? 'text-align:right' : '') }, c)))));
  // ---- vegetation ----
  const sv = el('div', { class: 'sec' }, el('h3', {}, 'Vegetation analysis'), el('div', { class: 'note' }, 'Measures each tree picked up by the topo run: height, crown spread, crown base, crown volume, and trunk diameter at 1.3 m where the trunk was scanned. Aerial scans rarely see trunks; ground-based scans do.'),
    el('div', { class: 'row' }, el('button', { class: 'btn small primary', disabled: !has, onclick: vegRun }, 'Analyse vegetation'), el('button', { class: 'btn small', disabled: !v, onclick: vegExportTrees }, 'Trees CSV')));
  if (v) { const s = v.stand;
    sv.append(tbl([['Area surveyed', f1(s.areaHa, 2) + ' ha'], ['Trees', s.trees + ' (' + f1(s.stemsPerHa, 0) + ' per ha)'], ['Canopy cover (over 3 m)', f1(s.canopyCover * 100, 0) + ' %'], ['Elevated cover (0.6–3 m)', f1(s.elevatedCover * 100, 0) + ' %'], ['Near-surface cover (0.1–0.6 m)', f1(s.nearSurfaceCover * 100, 0) + ' %'], ['Tree height mean / 95th / max', f1(s.heightMean) + ' / ' + f1(s.heightP95) + ' / ' + f1(s.heightMax) + ' m'], ['Mean crown base height', f1(s.crownBaseMean) + ' m'], ['Trunks measured', s.trunksMeasured + (s.trunksMeasured ? ' (mean ' + f1(s.dbhMean * 1000, 0) + ' mm)' : '')]]));
    const list = el('div', { style: 'max-height:180px;overflow:auto;margin-top:6px;border:1px solid var(--line,#333);border-radius:6px' });
    const top = v.trees.slice().sort((a, b) => b.height - a.height).slice(0, 300);
    list.append(el('table', { style: 'width:100%;font-size:11.5px;border-collapse:collapse' }, el('tr', {}, ...['Tree', 'Height', 'Spread', 'Crown base', 'Trunk'].map(h => el('th', { style: 'text-align:right;padding:2px 4px;position:sticky;top:0;background:var(--panel,#1c1f24)' }, h))),
      ...top.map(T => el('tr', { style: 'cursor:pointer', title: 'Zoom to this tree', onclick: () => tweenCam({ target: [T.x, T.y, T.groundZ + T.height / 2], dist: Math.max(15, T.height * 2.2), yaw: S.cam.yaw, pitch: S.cam.pitch, ortho: S.cam.ortho }, 700) }, ...[T.id, f1(T.height) + ' m', f1(T.spread) + ' m', f1(T.crownBase) + ' m', T.dbh ? f1(T.dbh * 1000, 0) + ' mm' : '–'].map(c => el('td', { style: 'text-align:right;padding:2px 4px' }, String(c)))))));
    sv.append(list, el('div', { class: 'note' }, (v.trees.length > 300 ? 'Tallest 300 of ' + v.trees.length + ' shown; the CSV has them all. ' : '') + 'Green rings mark crown base, orange rings mark measured trunks. Click a row to zoom to the tree.'));
  }
  // ---- bushfire ----
  const O = VEG.opts, ff = numIn('bfF', O.ffdi, '1'), lc = numIn('bfLc', O.litterCanopy, '1'), lo = numIn('bfLo', O.litterOpen, '1'), cl = numIn('bfCell', O.cell, '1');
  const fl = el('select', { id: 'bfFl' }, ...[['1', 'Green, little dead material'], ['2', 'About 20% dead'], ['3', '50% or more dead']].map(([a, b]) => el('option', { value: a, selected: String(O.flammability) === a }, b)));
  const read = () => Object.assign(O, { ffdi: Math.max(1, +ff.value), litterCanopy: Math.max(0, +lc.value), litterOpen: Math.max(0, +lo.value), cell: Math.max(1, +cl.value), flammability: +fl.value });
  const sf = el('div', { class: 'sec' }, el('h3', {}, 'Bushfire hazard'), el('div', { class: 'note' }, 'Maps how intensely each patch would burn on the chosen fire danger day, from leaf litter, scrub measured in the scan, canopy and slope. Leaf litter cannot be measured from a scan, so enter its depth: one figure under tree canopy, one in the open, and optional zones for areas you have checked on site.'),
    fieldRow('Fire danger index (FFDI)', ff), fieldRow('Litter under canopy (mm)', lc), fieldRow('Litter in the open (mm)', lo), fieldRow('Scrub condition', fl), fieldRow('Map cell (m)', cl));
  const areas = S.measures.filter(M => M.type === 'area');
  const zl = el('div', { style: 'margin:6px 0' }, el('div', { class: 'note' }, areas.length ? 'Litter zones: give a depth to any area measurement to override the figures above inside it (0 for cleared ground). Leave blank to ignore.' : 'To set litter zones, draw areas with Measure → Area, then come back here and give each a depth.'));
  for (const M of areas) { const inp = el('input', { type: 'number', step: '1', min: '0', placeholder: 'mm', value: M.litter ?? '', style: 'width:70px' }); inp.addEventListener('change', () => { M.litter = inp.value === '' ? undefined : +inp.value; }); zl.append(el('div', { class: 'field' }, el('label', {}, M.name), inp)); }
  const show = el('input', { type: 'checkbox', id: 'bfShow' }); show.checked = VEG.showMap; show.addEventListener('change', () => { VEG.showMap = show.checked; fireDraw(); });
  sf.append(zl, el('div', { class: 'row' }, el('button', { class: 'btn small primary', disabled: !has, onclick: () => { read(); fireRun(); } }, 'Assess bushfire hazard'), el('button', { class: 'btn small', disabled: !F, onclick: fireExport }, 'Hazard CSV')));
  if (F) { const s = F.summary, hex = c => '#' + c.toString(16).padStart(6, '0');
    sf.append(el('label', { class: 'row', style: 'gap:6px;font-size:12px;margin:6px 0' }, show, 'Show hazard map'),
      el('table', { style: 'width:100%;font-size:12px;border-collapse:collapse' }, ...F.classes.map((c, i) => el('tr', {}, el('td', { style: 'padding:2px 4px' }, el('span', { style: 'display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;background:' + hex(c.color) }), c.name + (i === 0 ? '' : i === 5 ? ' (over 10,000 kW/m)' : ' (under ' + c.max.toLocaleString() + ' kW/m)')), el('td', { style: 'text-align:right;padding:2px 4px' }, f1(s.areaByClass[i], 2) + ' ha'), el('td', { style: 'text-align:right;padding:2px 4px' }, f1(s.areaHa ? s.areaByClass[i] / s.areaHa * 100 : 0, 0) + ' %')))),
      tbl([['Mean fuel load', f1(s.fuelMean) + ' t/ha'], ['Crown fire likely', f1(s.crownFireShare * 100, 0) + ' % of area'], ['Ladder fuel (scrub reaching the canopy)', f1(s.ladderShare * 100, 0) + ' % of area'], ['Litter zones used', String(F.inputs.zones)]]),
      el('div', { class: 'note' }, 'Screening only, not a Bushfire Attack Level (AS 3959) assessment. Litter weight uses the northern jarrah depth table (about 0.54 t/ha per mm; depths over 50 mm are extrapolated). Modelled fuel is capped at 25 t/ha. Spread and flame height follow McArthur Mk5 with slope, intensity follows Byram, and crown fire follows Van Wagner. Scrub under dense canopy is under-counted by aerial scans.'));
  }
  p.append(sv, sf);
};
