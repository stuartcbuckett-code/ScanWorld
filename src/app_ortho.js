// ---------- AERIAL IMAGES: geo-referenced GeoTIFF, or JPEG/PNG/TIFF with a world file, laid under the data ----------
// A whole-image overview is always shown; when you zoom in, the part in view is read again at screen resolution (from the GeoTIFF's overviews or tiles,
// so a multi-gigabyte ortho never has to fit in memory).
const ORTHO = { list: [], idc: 1, timer: 0, camKey: '' };
const WORLD_EXT = /\.(jgw|jpgw|pgw|pngw|tfw|tifw|wld)$/i;
function parseWorldFile(t) { const v = t.trim().split(/\s+/).map(Number); if (v.length < 6 || v.some(x => !isFinite(x))) return null; const [A, D, B, E, C, F] = v; return [A, B, C - A / 2 - B / 2, D, E, F - D / 2 - E / 2]; }   // to top-left pixel corner
const sameStem = (a, b) => a.name.replace(/\.[^.]+$/, '').toLowerCase() === b.name.replace(/\.[^.]+$/, '').toLowerCase();
const epsgToId = e => { const s = (X_.SYSTEMS || []).find(s => s.epsg === e); return s ? s.id : null; };

async function loadOrtho(f, all) {
  const wf = all.find(g => WORLD_EXT.test(g.name) && sameStem(g, f)); let A = wf ? parseWorldFile(await wf.text()) : null, epsg = null, src = null, w = 0, h = 0;
  if (/\.tiff?$/i.test(f.name)) {
    if (!window.GeoTIFF) throw new Error('The GeoTIFF reader did not load.');
    const tiff = await GeoTIFF.fromBlob(f); const n = await tiff.getImageCount(); const imgs = []; for (let i = 0; i < n; i++) imgs.push(await tiff.getImage(i));
    const im = imgs[0]; w = im.getWidth(); h = im.getHeight();
    if (!A) { try { const fd = im.getFileDirectory(); if (fd.ModelTransformation) { const m = fd.ModelTransformation; A = [m[0], m[1], m[3], m[4], m[5], m[7]]; } else { const o = im.getOrigin(), r = im.getResolution(); A = [r[0], 0, o[0], 0, r[1], o[1]]; } } catch (e) { } }
    try { const gk = im.getGeoKeys() || {}; epsg = gk.ProjectedCSTypeGeoKey || gk.GeographicTypeGeoKey || null; if (epsg === 32767) epsg = null; } catch (e) { }
    const levels = imgs.filter(x => x.getWidth() <= w && !(x.fileDirectory.NewSubfileType & 4)).sort((a, b) => b.getWidth() - a.getWidth());
    src = { kind: 'tiff', levels: levels.length ? levels : [im], bits: im.getBitsPerSample ? im.getBitsPerSample() : 8 };
  } else {
    const bm = await createImageBitmap(f); w = bm.width; h = bm.height; src = { kind: 'bitmap', bm };
  }
  if (!A) throw new Error(f.name + ' has no geo-referencing. Add its world file (' + f.name.replace(/\.[^.]+$/, '') + '.jgw, .tfw or .wld) alongside it, or use a GeoTIFF.');
  const id = epsg ? epsgToId(epsg) : null;
  if (epsg && !id) toast(f.name + ': coordinate system EPSG:' + epsg + ' is not in ScanBench\'s list, so it is placed as if it matched the project.', true);
  if (id && !S.crs) { S.crs = id; try { updateCrsStatus(); } catch (e) { } }
  const O = { id: ORTHO.idc++, name: f.name, w, h, A, crs: id, src, visible: true, opacity: 1, zMode: 'below', z: 0, black: true };
  const ctr = orthoXY(O, w / 2, h / 2); if (!S.origin) S.origin = [Math.round(ctr[0]), Math.round(ctr[1]), 0];
  await orthoOverview(O); ORTHO.list.push(O); refreshOrthoPanel(); S.dirty = true; return O;
}
function orthoXY(O, col, row) { const a = O.A; return [a[0] * col + a[1] * row + a[2], a[3] * col + a[4] * row + a[5]]; }
function orthoLocal(O, col, row) {   // pixel corner → scene coordinates (reprojected when the image is in another known system)
  if (!S.origin) S.origin = [0, 0, 0];
  let p = orthoXY(O, col, row); if (O.crs && S.crs && O.crs !== S.crs) { try { p = X_.convertPoint(p[0], p[1], 0, O.crs, S.crs); } catch (e) { } }
  return [p[0] - S.origin[0], p[1] - S.origin[1]];
}
// read a pixel window at a given output size into a canvas
async function orthoRead(O, x0, y0, x1, y1, ow, oh) {
  const cv = document.createElement('canvas'); cv.width = ow; cv.height = oh; const g = cv.getContext('2d');
  if (O.src.kind === 'bitmap') { g.drawImage(O.src.bm, x0, y0, x1 - x0, y1 - y0, 0, 0, ow, oh); }
  else {
    const L = O.src.levels; let im = L[0]; for (const c of L) { const s = c.getWidth() / O.w; if ((x1 - x0) * s >= ow * 0.9) im = c; }   // coarsest level that still has the detail
    const s = im.getWidth() / O.w, win = [Math.floor(x0 * s), Math.floor(y0 * s), Math.min(im.getWidth(), Math.ceil(x1 * s)), Math.min(im.getHeight(), Math.ceil(y1 * s))];
    const r = await im.readRGB({ window: win, width: ow, height: oh, interleave: true, enableAlpha: false });
    const id = g.createImageData(ow, oh), d = id.data, n = ow * oh; let mx = 255;
    if (!(r instanceof Uint8Array || r instanceof Uint8ClampedArray)) { mx = 1; for (let i = 0; i < r.length; i += 7) if (r[i] > mx) mx = r[i]; }
    for (let i = 0; i < n; i++) { const R_ = r[i * 3] * 255 / mx, G = r[i * 3 + 1] * 255 / mx, B = r[i * 3 + 2] * 255 / mx; d[i * 4] = R_; d[i * 4 + 1] = G; d[i * 4 + 2] = B; d[i * 4 + 3] = 255; }
    g.putImageData(id, 0, 0);
  }
  if (O.black) { const id = g.getImageData(0, 0, ow, oh), d = id.data; let any = false; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 4) { d[i + 3] = 0; any = true; } if (any) g.putImageData(id, 0, 0); }
  return cv;
}
function orthoMesh(O, x0, y0, x1, y1, cv, order) {
  const N = O.crs && S.crs && O.crs !== S.crs ? 12 : 1, pos = [], uv = [], idx = [];
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) { const c = x0 + (x1 - x0) * i / N, r = y0 + (y1 - y0) * j / N; const p = orthoLocal(O, c, r); pos.push(p[0], p[1], 0); uv.push(i / N, 1 - j / N); }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
  const t = new THREE.CanvasTexture(cv); t.anisotropy = 8;
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: t, transparent: true, opacity: O.opacity, depthWrite: false, side: THREE.DoubleSide, alphaTest: 0.01, polygonOffset: true, polygonOffsetFactor: -order, polygonOffsetUnits: -order }));
  m.renderOrder = -10 + order; m.frustumCulled = false; return m;
}
async function orthoOverview(O) {
  const s = Math.min(1, 4096 / Math.max(O.w, O.h)); const cv = await orthoRead(O, 0, 0, O.w, O.h, Math.max(1, Math.round(O.w * s)), Math.max(1, Math.round(O.h * s)));
  O.group = new THREE.Group(); O.base = orthoMesh(O, 0, 0, O.w, O.h, cv, 0); O.group.add(O.base); scene.add(O.group); O.full = s >= 1; orthoHeight(O);
}
function orthoHeight(O) { const b = sceneBox(); O.group.position.z = O.zMode === 'below' ? (b.isEmpty() || (b.min.z === 0 && b.max.z === 0) ? 0 : b.min.z - 0.03) : O.z - (S.origin ? S.origin[2] : 0); }
// the part in view, at screen resolution
async function orthoDetail(O) {
  if (O.full || !O.visible) return; const cam = curCam(), z = O.group.position.z, pts = [];
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0], [0, -1], [0, 1], [-1, 0], [1, 0]]) { const r = new THREE.Raycaster(); r.setFromCamera(new THREE.Vector2(sx, sy), cam); const t = (z - r.ray.origin.z) / r.ray.direction.z; if (t > 0 && isFinite(t)) pts.push(r.ray.origin.clone().addScaledVector(r.ray.direction, Math.min(t, 1e6))); }
  if (pts.length < 3) return;
  // scene → pixel (inverse of the affine; reprojection is small over a view, so the inverse affine is close enough to choose the window)
  const a = O.A, det = a[0] * a[4] - a[1] * a[3], inv = (X, Y) => { X += S.origin[0]; Y += S.origin[1]; const dx = X - a[2], dy = Y - a[5]; return [(a[4] * dx - a[1] * dy) / det, (-a[3] * dx + a[0] * dy) / det]; };
  let c0 = Infinity, r0 = Infinity, c1 = -Infinity, r1 = -Infinity; for (const p of pts) { const [c, r] = inv(p.x, p.y); c0 = Math.min(c0, c); c1 = Math.max(c1, c); r0 = Math.min(r0, r); r1 = Math.max(r1, r); }
  c0 = Math.max(0, Math.floor(c0)); r0 = Math.max(0, Math.floor(r0)); c1 = Math.min(O.w, Math.ceil(c1)); r1 = Math.min(O.h, Math.ceil(r1)); if (c1 - c0 < 2 || r1 - r0 < 2) { orthoDropDetail(O); return; }
  const scr = Math.max(W(), H()) * 1.5, s = Math.min(1, scr / Math.max(c1 - c0, r1 - r0)); const ow = Math.max(2, Math.round((c1 - c0) * s)), oh = Math.max(2, Math.round((r1 - r0) * s));
  if ((c1 - c0) / ow <= O.w / O.base.material.map.image.width * 1.05 && c1 - c0 > O.w * 0.8) { orthoDropDetail(O); return; }   // the overview already shows this much
  const key = [c0, r0, c1, r1, ow, oh].join(); if (key === O.detailKey) return; O.detailKey = key;
  const cv = await orthoRead(O, c0, r0, c1, r1, ow, oh); if (key !== O.detailKey) return;
  orthoDropDetail(O, true); O.detail = orthoMesh(O, c0, r0, c1, r1, cv, 1); O.detail.material.opacity = O.opacity; O.group.add(O.detail); S.dirty = true;
}
function orthoDropDetail(O, keepKey) { if (O.detail) { O.group.remove(O.detail); O.detail.geometry.dispose(); O.detail.material.map.dispose(); O.detail.material.dispose(); O.detail = null; } if (!keepKey) O.detailKey = ''; }
function orthoRemove(O) { orthoDropDetail(O); scene.remove(O.group); O.base.geometry.dispose(); O.base.material.map.dispose(); O.base.material.dispose(); if (O.src.bm) O.src.bm.close(); ORTHO.list = ORTHO.list.filter(x => x !== O); refreshOrthoPanel(); S.dirty = true; }
const _drawO = draw;
draw = function () {
  if (ORTHO.list.length) {
    for (const O of ORTHO.list) { O.group.visible = O.visible; if (O.zMode === 'below') orthoHeight(O); }
    const k = [S.cam.target.x, S.cam.target.y, S.cam.dist, S.cam.yaw, S.cam.pitch, S.cam.ortho, W(), H()].map(v => typeof v === 'number' ? v.toFixed(2) : v).join();
    if (k !== ORTHO.camKey) { ORTHO.camKey = k; clearTimeout(ORTHO.timer); ORTHO.timer = setTimeout(() => { for (const O of ORTHO.list) orthoDetail(O).catch(e => console.warn(e)); }, 250); }
  }
  return _drawO();
};
const _sceneBoxO = sceneBox; sceneBox = function (onlyVisible = true) { const b = _sceneBoxO(onlyVisible); if (b.isEmpty() && ORTHO.list.length) for (const O of ORTHO.list) { if (onlyVisible && !O.visible) continue; for (const [c, r] of [[0, 0], [O.w, O.h], [0, O.h], [O.w, 0]]) { const p = orthoLocal(O, c, r); b.expandByPoint(new THREE.Vector3(p[0], p[1], 0)); } } return b; };

function refreshOrthoPanel() {
  let host = $('#orthoSec'); if (!host) { host = el('div', { class: 'sec', id: 'orthoSec' }); const ps = $('#panoSec'); if (ps) ps.before(host); else $('#leftPane').append(host); }
  host.textContent = ''; const pick = el('input', { type: 'file', multiple: true, hidden: true, accept: '.tif,.tiff,.jpg,.jpeg,.png,.jgw,.jpgw,.pgw,.pngw,.tfw,.tifw,.wld,.ecw' }); pick.addEventListener('change', () => { const fs = [...pick.files]; pick.value = ''; loadFiles(fs); });
  host.append(el('h3', {}, 'Aerial images'), el('div', { class: 'note' }, 'GeoTIFF, or JPEG, PNG or TIFF with its world file (.jgw, .pgw, .tfw, .wld). Choose the image and its world file together. Laid under the data; zoom in and the part in view sharpens.'),
    el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: () => pick.click() }, 'Add aerial image…')), pick);
  for (const O of ORTHO.list) {
    const vis = el('input', { type: 'checkbox', checked: O.visible, 'aria-label': 'Show ' + O.name }); vis.addEventListener('change', () => { O.visible = vis.checked; S.dirty = true; });
    const op = el('input', { type: 'range', min: 0.1, max: 1, step: 0.05, value: O.opacity, style: 'width:70px', 'aria-label': 'Opacity' }); op.addEventListener('input', () => { O.opacity = +op.value; for (const m of [O.base, O.detail]) if (m) m.material.opacity = O.opacity; S.dirty = true; });
    const zs = el('select', { style: 'width:auto', 'aria-label': 'Height' }, el('option', { value: 'below', selected: O.zMode === 'below' }, 'Under the data'), el('option', { value: 'fixed', selected: O.zMode === 'fixed' }, 'At height…'));
    const zi = el('input', { type: 'number', step: 0.1, value: O.z, style: 'width:80px', hidden: O.zMode !== 'fixed', 'aria-label': 'Height (m)' });
    zs.addEventListener('change', () => { O.zMode = zs.value; zi.hidden = O.zMode !== 'fixed'; orthoHeight(O); S.dirty = true; }); zi.addEventListener('change', () => { O.z = +zi.value; orthoHeight(O); S.dirty = true; });
    const bk = el('input', { type: 'checkbox', checked: O.black }); bk.addEventListener('change', async () => { O.black = bk.checked; scene.remove(O.group); await orthoOverview(O); O.detailKey = ''; ORTHO.camKey = ''; S.dirty = true; });
    const gsd = Math.hypot(O.A[0], O.A[3]);
    host.append(el('div', { class: 'mitem', style: 'grid-template-columns:minmax(0,1fr)' },
      el('div', { class: 'row', style: 'justify-content:space-between' }, el('label', { class: 'row', style: 'gap:6px;min-width:0' }, vis, el('span', { class: 't', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, O.name)), el('button', { class: 'btn small', 'aria-label': 'Remove ' + O.name, onclick: () => orthoRemove(O) }, '×')),
      el('div', { class: 'v' }, O.w.toLocaleString() + ' × ' + O.h.toLocaleString() + ' px · ' + (gsd < 1 ? (gsd * 100).toFixed(1) + ' cm' : gsd.toFixed(2) + ' m') + ' pixels' + (O.crs ? ' · ' + O.crs : '')),
      el('div', { class: 'row', style: 'gap:6px;margin-top:4px' }, el('button', { class: 'btn small', onclick: () => { const b = new THREE.Box3(); for (const [c, r] of [[0, 0], [O.w, O.h], [0, O.h], [O.w, 0]]) { const p = orthoLocal(O, c, r); b.expandByPoint(new THREE.Vector3(p[0], p[1], O.group.position.z)); } fitBox(b); } }, 'Zoom'), el('span', { class: 'hint' }, 'Opacity'), op),
      el('div', { class: 'row', style: 'gap:6px;margin-top:4px' }, zs, zi, el('label', { class: 'row', style: 'gap:4px;font-size:12px' }, bk, 'Black is see-through'))));
  }
}
refreshOrthoPanel();
const _loadFilesO = loadFiles;
loadFiles = async function (files) {
  const ecw = files.filter(f => /\.(ecw|jp2|sid)$/i.test(f.name));
  if (ecw.length) toast(ecw.map(f => f.name).join(', ') + ': ECW, JPEG 2000 and MrSID are compressed with licensed codecs that browsers cannot read. Convert to a tiled GeoTIFF first, e.g. in QGIS (right-click the layer → Export → Save As → GeoTIFF) or with GDAL: gdal_translate -of COG in.ecw out.tif', true);
  const isWorld = f => WORLD_EXT.test(f.name) || (/\.(prj|aux\.xml|ovr)$/i.test(f.name) && files.some(g => g !== f && /\.(tiff?|jpe?g|png)$/i.test(g.name)));
  const imgs = files.filter(f => /\.tiff?$/i.test(f.name) || (/\.(jpe?g|png)$/i.test(f.name) && files.some(g => WORLD_EXT.test(g.name) && sameStem(g, f))));
  let firstO = null;
  for (const f of imgs) { try { const O = await busy('Reading ' + f.name, async () => loadOrtho(f, files)); if (O && !firstO) firstO = O; } catch (e) { toast(e.message, true); } }
  if (firstO && !S.layers.length && !(S.streams || []).length) fitAll();
  const rest = files.filter(f => !imgs.includes(f) && !isWorld(f) && !ecw.includes(f)); if (rest.length) return _loadFilesO(rest);
};
