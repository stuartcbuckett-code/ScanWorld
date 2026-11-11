// ---------- REVIEW: annotations, bookmarks, flythroughs, project files, change detection, analysis tools ----------
S.annots = []; S.bookmarks = [];
const RV = { dsm: null };

// ---------- surface model of the visible clouds (for line of sight, viewshed, slope) ----------
function surfaceModel(cell, mode = 'max', groundOnly = false) {
  const Ls = clouds().filter(L => L.visible); if (!Ls.length) throw new Error('Load a point cloud first.');
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const L of Ls) { x0 = Math.min(x0, L.box.min.x); y0 = Math.min(y0, L.box.min.y); x1 = Math.max(x1, L.box.max.x); y1 = Math.max(y1, L.box.max.y); }
  let c = cell; while (((x1 - x0) / c + 1) * ((y1 - y0) / c + 1) > 6e6) c *= 1.5;
  const nx = Math.floor((x1 - x0) / c) + 1, ny = Math.floor((y1 - y0) / c) + 1, z = new Float32Array(nx * ny).fill(NaN);
  for (const L of Ls) { const P = L.pos, cls = L.cls; for (let i = 0; i < L.n; i++) {
    if (cls) { const q = cls[i]; if (q === 7 || q === 18 || (groundOnly && q !== 2 && q !== 9)) continue; }
    const k = Math.floor((P[i * 3 + 1] - y0) / c) * nx + Math.floor((P[i * 3] - x0) / c), v = P[i * 3 + 2];
    if (isNaN(z[k]) || (mode === 'max' ? v > z[k] : v < z[k])) z[k] = v; } }
  const R = { x0, y0, cell: c, nx, ny, z }; AL.fillHoles(R, 4); return R;
}
const rz = (R, x, y) => { const i = Math.floor((x - R.x0) / R.cell), j = Math.floor((y - R.y0) / R.cell); if (i < 0 || j < 0 || i >= R.nx || j >= R.ny) return NaN; return R.z[j * R.nx + i]; };
function getDSM() { const key = clouds().filter(L => L.visible).map(L => L.id + ':' + L.n).join(','); if (!RV.dsm || RV.dsmKey !== key) { RV.dsm = surfaceModel(0.5, 'max'); RV.dsmKey = key; } return RV.dsm; }

// ---------- plane: dip and dip direction ----------
function planeDipMode() {
  startMode({ type: 'dip', text: 'Click a planar surface (rock face, roof, slab)', onPick: pk => {
    cancelMode(); if (pk.mesh) { toast('Click on the cloud.'); return; }
    const L = pk.layer, c = pk.p, r = S.dipR || 0.4, idx = [];
    for (let i = 0; i < L.n; i++) { const dx = L.pos[i * 3] - c.x, dy = L.pos[i * 3 + 1] - c.y, dz = L.pos[i * 3 + 2] - c.z; if (dx * dx + dy * dy + dz * dz < r * r) idx.push(i); }
    if (idx.length < 10) { toast('Too few points within ' + r + ' m.', true); return; }
    planeDip(L, c, idx);
  } });
}
function planeDip(L, c, idx) {
  const F = AL.fitPlane(L.pos, idx); const n = F.normal; const dip = F.dipDeg; let dd = (Math.atan2(n[0], n[1]) * 180 / Math.PI + 360) % 360; if (dip < 0.05) dd = 0;
  const p0 = new THREE.Vector3(...F.centroid), N3 = new THREE.Vector3(...n), u = new THREE.Vector3(); u.crossVectors(N3, Math.abs(n[2]) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1)).normalize(); const v = new THREE.Vector3().crossVectors(N3, u);
  const s = S.dipR || 0.4; const sq = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => p0.clone().addScaledVector(u, a * s).addScaledVector(v, b * s));
  const M = { type: 'plane', pts: sq, closed: true, labels: [], name: 'Plane ' + (S.measures.length + 1), note: '', tags: [], color: '#ffcc00',
    lines: ['Dip ' + dip.toFixed(1) + '° · dip direction ' + dd.toFixed(1) + '° (grid)', 'Strike ' + ((dd + 270) % 360).toFixed(1) + '° · fit ±' + (F.rms * 1000).toFixed(1) + ' mm on ' + idx.length + ' pts', 'Normal ' + n.map(q => q.toFixed(4)).join(', '), 'Centre ' + W3(p0).map(q => q.toFixed(3)).join(', ')],
    lab: dip.toFixed(0) + '°/' + dd.toFixed(0).padStart(3, '0') + '°', at: p0, value: dip, dipDir: dd };
  const tip = p0.clone().addScaledVector(N3, s * 0.8); M.extra = lineObj([p0, tip], false, 0x66ddff);
  pushMeasure(M); return M;
}

// ---------- stockpile volume inside a polygon ----------
function stockpileMode() {
  const L = S.sel && S.sel.kind === 'cloud' ? S.sel : null; if (!L) { toast('Select the point cloud layer first.', true); return; }
  startMode({ type: 'stock', text: 'Click around the toe of the stockpile · Enter to close', finishable: true, dblFinish: true,
    onPick: pk => { S.mode.pts.push(pk.p); refreshModeGraphics(); },
    onFinish: m => { if (m.pts.length < 3) { toast('Need at least 3 points around the toe.'); return; } stockpileVolume(L, m.pts.slice(), S.stockBase || 'plane'); } });
}
function inPoly(x, y, P) { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[i], b = P[j]; if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) c = !c; } return c; }
function stockpileVolume(L, pts, base, fixedZ) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  let cell = Math.max(0.05, Math.sqrt((x1 - x0) * (y1 - y0) / 400000)); const nx = Math.ceil((x1 - x0) / cell) + 1, ny = Math.ceil((y1 - y0) / cell) + 1;
  const z = new Float64Array(nx * ny), cnt = new Uint32Array(nx * ny);
  for (let i = 0; i < L.n; i++) { const x = L.pos[i * 3], y = L.pos[i * 3 + 1]; if (x < x0 || y < y0 || x > x1 || y > y1) continue; if (L.cls && (L.cls[i] === 7 || L.cls[i] === 18)) continue; const k = Math.floor((y - y0) / cell) * nx + Math.floor((x - x0) / cell); z[k] += L.pos[i * 3 + 2]; cnt[k]++; }
  const R = { x0, y0, cell, nx, ny, z: new Float32Array(nx * ny) }; for (let k = 0; k < z.length; k++) R.z[k] = cnt[k] ? z[k] / cnt[k] : NaN; AL.fillHoles(R, 6);
  // base surface: least-squares plane through the toe points, the lowest toe point, or a fixed RL
  let bz; let desc;
  if (base === 'fixed' && Number.isFinite(fixedZ)) { const zl = fixedZ - S.origin[2]; bz = () => zl; desc = 'fixed RL ' + fixedZ.toFixed(3); }
  else if (base === 'lowest') { const zl = Math.min(...pts.map(p => p.z)); bz = () => zl; desc = 'lowest toe point RL ' + (zl + S.origin[2]).toFixed(3); }
  else { let sx = 0, sy = 0, sz = 0; const n = pts.length; for (const p of pts) { sx += p.x; sy += p.y; sz += p.z; } const mx = sx / n, my = sy / n, mz = sz / n; let a = 0, b = 0, c = 0, d = 0, e = 0;
    for (const p of pts) { const X = p.x - mx, Y = p.y - my, Z = p.z - mz; a += X * X; b += X * Y; c += Y * Y; d += X * Z; e += Y * Z; } const det = a * c - b * b || 1e-12; const gx = (d * c - e * b) / det, gy = (a * e - b * d) / det;
    bz = (x, y) => mz + gx * (x - mx) + gy * (y - my); desc = 'plane through the toe points'; }
  let cut = 0, fill = 0, area = 0; const A = cell * cell;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const x = x0 + (i + 0.5) * cell, y = y0 + (j + 0.5) * cell; if (!inPoly(x, y, pts)) continue; const v = R.z[j * nx + i]; if (isNaN(v)) continue; area += A; const d = v - bz(x, y); if (d > 0) cut += d * A; else fill -= d * A; }
  const at = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
  const M = { type: 'volume', pts, closed: true, labels: [], name: 'Stockpile ' + (S.measures.length + 1), note: '', tags: [], color: '#ffcc00',
    lines: ['Volume above base ' + cut.toFixed(2) + ' m³', 'Below base (hollows) ' + fill.toFixed(2) + ' m³', 'Net ' + (cut - fill).toFixed(2) + ' m³', 'Plan area ' + area.toFixed(1) + ' m²', 'Base: ' + desc + ' · grid ' + (cell * 100).toFixed(0) + ' cm'],
    lab: cut.toFixed(1) + ' m³', at, value: cut };
  pushMeasure(M); return M;
}

// ---------- line of sight and viewshed ----------
function losMode() {
  startMode({ type: 'los', text: 'Click the observer, then the target', onPick: pk => { S.mode.pts.push(pk.p); refreshModeGraphics(); if (S.mode.pts.length === 2) { const [a, b] = S.mode.pts; cancelMode(); lineOfSight(a, b); } } });
}
function lineOfSight(a, b, eye = S.losEye ?? 1.7, tgt = S.losTgt ?? 0) {
  let R; try { R = getDSM(); } catch (e) { toast(e.message, true); return; }
  const A = a.clone(); A.z += eye; const B = b.clone(); B.z += tgt; const D = A.distanceTo(B), Hd = Math.hypot(B.x - A.x, B.y - A.y), steps = Math.max(2, Math.ceil(Hd / (R.cell * 0.5)));
  let block = null; const skip = Math.max(1.0, R.cell * 2);
  for (let k = 1; k < steps; k++) { const t = k / steps, x = A.x + (B.x - A.x) * t, y = A.y + (B.y - A.y) * t, zl = A.z + (B.z - A.z) * t, d = Hd * t; if (d < skip || Hd - d < skip) continue; const s = rz(R, x, y); if (s > zl + 0.05) { block = { t, p: new THREE.Vector3(x, y, s), d: D * t }; break; } }
  const M = { type: 'line of sight', pts: [A, B], labels: [], name: 'Line of sight ' + (S.measures.length + 1), note: '', tags: [], color: block ? '#e0475b' : '#3ccf6e', keepColor: true,
    lines: [block ? 'Blocked ' + block.d.toFixed(1) + ' m from the observer (surface RL ' + (block.p.z + S.origin[2]).toFixed(2) + ')' : 'Clear line of sight', 'Distance ' + D.toFixed(2) + ' m · observer +' + eye + ' m · target +' + tgt + ' m', 'Surface model grid ' + R.cell.toFixed(2) + ' m'],
    lab: block ? 'Blocked at ' + block.d.toFixed(0) + ' m' : 'Visible', at: A.clone().lerp(B, 0.5) };
  if (block) { const P = A.clone().lerp(B, block.t); M.obj = new THREE.Group(); M.obj.add(lineObj([A, P], false, 0x3ccf6e), lineObj([P, B], false, 0xe0475b)); M.drawPts = [A, B]; }
  else M.obj = lineObj([A, B], false, 0x3ccf6e);
  pushMeasure(M); return M;
}
function viewshedMode() {
  startMode({ type: 'vs', text: 'Click the observer position', onPick: pk => { cancelMode(); viewshed(pk.p, S.vsR || 300, S.losEye ?? 1.7); } });
}
function viewshed(o, radius = 300, eye = 1.7) {
  let R; try { R = getDSM(); } catch (e) { toast(e.message, true); return; }
  const { nx, ny, cell, x0, y0 } = R; const vis = new Uint8Array(nx * ny); const oz = o.z + eye, nr = Math.min(7200, Math.ceil(2 * Math.PI * radius / cell));
  for (let a = 0; a < nr; a++) { const th = 2 * Math.PI * a / nr, cx = Math.cos(th), sy = Math.sin(th); let maxS = -Infinity;
    for (let d = cell; d <= radius; d += cell * 0.5) { const x = o.x + cx * d, y = o.y + sy * d, i = Math.floor((x - x0) / cell), j = Math.floor((y - y0) / cell); if (i < 0 || j < 0 || i >= nx || j >= ny) break; const z = R.z[j * nx + i]; if (isNaN(z)) continue; const s = (z - oz) / d; if (s >= maxS - 1e-4) vis[j * nx + i] = 1; if (s > maxS) maxS = s; } }
  let nV = 0, nT = 0;
  for (const L of clouds().filter(L => L.visible)) {
    const v = new Float32Array(L.n);
    for (let i = 0; i < L.n; i++) { const x = L.pos[i * 3], y = L.pos[i * 3 + 1]; if (Math.hypot(x - o.x, y - o.y) > radius) { v[i] = NaN; continue; } const ii = Math.floor((x - x0) / cell), jj = Math.floor((y - y0) / cell); const k = jj * nx + ii; const top = R.z[k]; v[i] = vis[k] && L.pos[i * 3 + 2] > top - 1.0 ? 1 : -1; nT++; if (v[i] > 0) nV++; }
    addSF(L, 'Visible from observer', v, false); L.sfStyle['Visible from observer'].lo = -1; L.sfStyle['Visible from observer'].hi = 1; L.sfStyle['Visible from observer'].ramp = 'tol'; L.sfStyle['Visible from observer'].tol = 0.5; colorize(L);
  }
  const M = { type: 'viewshed', pts: [o], labels: [], name: 'Viewshed ' + (S.measures.length + 1), note: '', tags: [], color: '#66ddff', lines: ['Observer ' + W3(o).map(q => q.toFixed(2)).join(', ') + ' +' + eye + ' m', 'Radius ' + radius + ' m · ' + (nT ? (nV / nT * 100).toFixed(0) : 0) + '% of points visible', 'Points coloured: red visible, blue hidden'], lab: 'Observer', at: o };
  M.obj = lineObj([o, o.clone().setZ(o.z + eye)], false, 0x66ddff); pushMeasure(M); refreshProps(); return M;
}

// ---------- slope and aspect ----------
async function slopeAspect(L, cell = 1) {
  const R = await busy('Building the ground surface…', async () => surfaceModel(cell, 'min', !!L.cls));
  if (!R) return; const { nx, ny, z } = R, c = R.cell; const sl = new Float32Array(nx * ny), as = new Float32Array(nx * ny);
  const g = (i, j) => { i = Math.max(0, Math.min(nx - 1, i)); j = Math.max(0, Math.min(ny - 1, j)); const v = z[j * nx + i]; return v; };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = g(i - 1, j + 1), b = g(i, j + 1), cc = g(i + 1, j + 1), d = g(i - 1, j), f = g(i + 1, j), gg = g(i - 1, j - 1), h = g(i, j - 1), ii = g(i + 1, j - 1);
    const dzdx = ((cc + 2 * f + ii) - (a + 2 * d + gg)) / (8 * c), dzdy = ((a + 2 * b + cc) - (gg + 2 * h + ii)) / (8 * c), k = j * nx + i;
    sl[k] = Math.atan(Math.hypot(dzdx, dzdy)) * 180 / Math.PI; as[k] = (Math.atan2(-dzdx, -dzdy) * 180 / Math.PI + 360) % 360;   // aspect: direction the slope faces, from grid north
  }
  const S1 = new Float32Array(L.n), A1 = new Float32Array(L.n);
  for (let i = 0; i < L.n; i++) { const ii = Math.floor((L.pos[i * 3] - R.x0) / c), jj = Math.floor((L.pos[i * 3 + 1] - R.y0) / c); const k = jj * nx + ii; S1[i] = sl[k]; A1[i] = as[k]; }
  addSF(L, 'Aspect (° from grid north)', A1, false); L.sfStyle['Aspect (° from grid north)'].lo = 0; L.sfStyle['Aspect (° from grid north)'].hi = 360;
  addSF(L, 'Slope (°)', S1, false); L.sfStyle['Slope (°)'].lo = 0; L.sfStyle['Slope (°)'].hi = 45; colorize(L); refreshProps();
  RV.slopeGrid = { R, sl, as }; toast('Slope and aspect added to ' + L.name + ' (switch between them under Colour by).');
}

// ---------- change between two captures (time series) ----------
async function dsmChange(A, B, cell = 0.5) {
  const res = await busy('Comparing surfaces…', async () => {
    let x0 = Math.min(A.box.min.x, B.box.min.x), y0 = Math.min(A.box.min.y, B.box.min.y), x1 = Math.max(A.box.max.x, B.box.max.x), y1 = Math.max(A.box.max.y, B.box.max.y);
    let c = cell; while (((x1 - x0) / c + 1) * ((y1 - y0) / c + 1) > 8e6) c *= 1.5; const nx = Math.floor((x1 - x0) / c) + 1, ny = Math.floor((y1 - y0) / c) + 1;
    const ras = L => { const z = new Float32Array(nx * ny).fill(NaN); for (let i = 0; i < L.n; i++) { if (L.cls && (L.cls[i] === 7 || L.cls[i] === 18)) continue; const k = Math.floor((L.pos[i * 3 + 1] - y0) / c) * nx + Math.floor((L.pos[i * 3] - x0) / c), v = L.pos[i * 3 + 2]; if (isNaN(z[k]) || v > z[k]) z[k] = v; } return z; };
    const za = ras(A), zb = ras(B); let gain = 0, loss = 0, area = 0; const a2 = c * c, thr = S.chgThr || 0.1;
    for (let k = 0; k < za.length; k++) { if (isNaN(za[k]) || isNaN(zb[k])) continue; const d = zb[k] - za[k]; area += a2; if (d > thr) gain += d * a2; else if (d < -thr) loss -= d * a2; }
    const dz = new Float32Array(B.n); for (let i = 0; i < B.n; i++) { const k = Math.floor((B.pos[i * 3 + 1] - y0) / c) * nx + Math.floor((B.pos[i * 3] - x0) / c); dz[i] = isNaN(za[k]) ? NaN : B.pos[i * 3 + 2] - za[k]; }
    return { gain, loss, area, dz, c };
  });
  if (!res) return null; addSF(B, 'Change since ' + A.name, res.dz, true); refreshProps();
  S.change = { a: A.name, b: B.name, ...res, dz: undefined }; buildReview(); return S.change;
}

// ---------- annotations ----------
function annotMarker(a) {
  const g = new THREE.Group(); const p = new THREE.Vector3(...a.p); const col = new THREE.Color(a.color || '#ff7a3d');
  const s = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: 0.95 })); s.position.copy(p); s.renderOrder = 6; s.onBeforeRender = (r, sc, cam) => { const d = cam.isOrthographicCamera ? (cam.top - cam.bottom) / 2 : cam.position.distanceTo(p); s.scale.setScalar(Math.max(0.01, d * 0.008)); };
  g.add(s); a.obj = g; annot.add(g); a.label = addLabel(p, '<b>' + esc(a.title) + '</b>' + (a.tags && a.tags.length ? ' <span style="opacity:.7">' + esc(a.tags.join(', ')) + '</span>' : '')); S.dirty = true;
}
function addAnnotation(p, title, note = '', tags = [], color = '#ff7a3d') {
  const a = { id: Date.now() + Math.random(), p: [p.x, p.y, p.z], title: title || 'Note ' + (S.annots.length + 1), note, tags, color, created: new Date().toISOString(), view: camState() };
  annotMarker(a); S.annots.push(a); buildReview(); return a;
}
function removeAnnotation(a) { annot.remove(a.obj); removeLabel(a.label); S.annots = S.annots.filter(x => x !== a); S.dirty = true; }
function annotMode() { startMode({ type: 'annot', text: 'Click where the annotation goes', onPick: pk => { cancelMode(); const a = addAnnotation(pk.p, ''); setTimeout(() => { const i = $('#annT' + S.annots.indexOf(a)); if (i) { i.focus(); i.select(); } }, 30); } }); }
function restyleAnnots() { const t = S.aTag; for (const a of S.annots) { const v = !t || (a.tags || []).includes(t); a.obj.visible = v; a.label.el.style.display = v ? '' : 'none'; a.label.el.innerHTML = '<b>' + esc(a.title) + '</b>' + (a.tags && a.tags.length ? ' <span style="opacity:.7">' + esc(a.tags.join(', ')) + '</span>' : ''); a.obj.children[0].material.color.set(a.color); } S.dirty = true; }

// ---------- bookmarks and flythrough ----------
function camState() { const c = S.cam; return { target: [c.target.x, c.target.y, c.target.z], dist: c.dist, yaw: c.yaw, pitch: c.pitch, ortho: !!c.ortho }; }
function addBookmark(name) { S.bookmarks.push({ name: name || 'View ' + (S.bookmarks.length + 1), cam: camState() }); buildReview(); }
function applyCam(v) { const c = S.cam; c.target.set(...v.target); c.dist = v.dist; c.yaw = v.yaw; c.pitch = v.pitch; if (!!c.ortho !== !!v.ortho) toggleOrtho(); else updateCamera(); }
function tweenCam(to, ms = 1200) {
  return new Promise(res => { const from = camState(); let dy = to.yaw - from.yaw; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI; const t0 = performance.now();
    const step = now => { if (RV.stop) { res(false); return; } const t = Math.min(1, (now - t0) / ms), e = t * t * (3 - 2 * t);
      const L = (a, b) => a + (b - a) * e; S.cam.target.set(L(from.target[0], to.target[0]), L(from.target[1], to.target[1]), L(from.target[2], to.target[2])); S.cam.dist = Math.exp(L(Math.log(from.dist), Math.log(to.dist))); S.cam.yaw = from.yaw + dy * e; S.cam.pitch = L(from.pitch, to.pitch); updateCamera();
      if (t < 1) requestAnimationFrame(step); else res(true); };
    requestAnimationFrame(step); });
}
async function flythrough(record) {
  if (S.bookmarks.length < 2) { toast('Save at least two views first.', true); return; }
  RV.stop = false; RV.playing = true; buildReview(); let rec = null, chunks = [];
  if (record) { try { const st = canvas.captureStream(30); rec = new MediaRecorder(st, { mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm' }); rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); }; rec.start(200); } catch (e) { toast('Recording is not available in this browser: ' + e.message, true); rec = null; } }
  const secs = S.flySecs || 3; applyCam(S.bookmarks[0].cam); await new Promise(r => setTimeout(r, 400));
  for (let i = 1; i < S.bookmarks.length && !RV.stop; i++) { await tweenCam(S.bookmarks[i].cam, secs * 1000); await new Promise(r => setTimeout(r, 300)); }
  if (rec) { await new Promise(r => { rec.onstop = r; rec.stop(); }); const blob = new Blob(chunks, { type: 'video/webm' }); const data = new Uint8Array(await blob.arrayBuffer()); saveFile('flythrough.zip', IO.makeZip([{ name: 'flythrough.webm', data }])); }
  RV.playing = false; buildReview();
}

// ---------- project file (annotations, views, measurements, CAD, coordinate system) ----------
function saveProject() {
  const o = S.origin || [0, 0, 0]; const w = p => [p[0] + o[0], p[1] + o[1], p[2] + o[2]]; const wv = v => w([v.x, v.y, v.z]);
  const cadOut = S.cad ? JSON.parse(JSON.stringify(cadLists(), (k, v) => (k === 'pipe' || (k === 'a' || k === 'b') && v && v.type) ? undefined : (v instanceof Float32Array || v instanceof Uint32Array ? undefined : v))) : null;
  const proj = { format: 'ScanBench project', version: 1, saved: new Date().toISOString(), crs: S.crs || null, origin: o,
    layers: S.layers.map(L => ({ name: L.name, kind: L.kind, points: L.n || 0, source: L.meta && L.meta.format })),
    annotations: S.annots.map(a => ({ title: a.title, note: a.note, tags: a.tags, color: a.color, created: a.created, position: w(a.p) })),
    bookmarks: S.bookmarks.map(b => ({ name: b.name, tags: b.tags || [], clip: b.clip ? { min: w(b.clip.min), max: w(b.clip.max) } : b.clip === null ? null : undefined, view: { ...b.cam, target: w(b.cam.target) } })),
    measurements: S.measures.map(M => ({ name: M.name, type: M.type, values: M.lines, tags: M.tags, note: M.note, color: M.color, closed: !!M.closed, points: M.pts.map(wv) })),
    tags: S.tagLib, groups: S.groups, layerGroups: S.layers.map(L => [L.name, L.group]), flights: (S.paths || []).map(F => ({ name: F.name, speed: F.speed, look: F.look, closed: !!F.closed, tilt: F.tilt, target: F.target ? w(F.target) : null, waypoints: F.pts.map(w) })),
    cadOriginLocal: o, cad: cadOut };
  saveFile('scanbench-project.json', JSON.stringify(proj, null, 1));
}
function loadProjectObj(proj) {
  if (!proj || proj.format !== 'ScanBench project') { toast('That is not a ScanBench project file.', true); return; }
  if (!S.origin) { toast('Load the point clouds first, then open the project file.', true); return; }
  const o = S.origin; const l = p => [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  if (proj.crs && !S.crs) { S.crs = proj.crs; try { updateCrsStatus(); } catch (e) { } }
  for (const a of proj.annotations || []) { const q = l(a.position); const A = addAnnotation(new THREE.Vector3(...q), a.title, a.note, a.tags || [], a.color); A.created = a.created; }
  for (const b of proj.bookmarks || []) S.bookmarks.push({ name: b.name, tags: b.tags || [], clip: b.clip ? { min: l(b.clip.min), max: l(b.clip.max) } : b.clip, cam: { ...b.view, target: l(b.view.target) } });
  for (const t of proj.tags || []) if (!S.tagLib.some(x => x.name === t.name)) S.tagLib.push(t);
  if (proj.groups && proj.groups.length) { S.groups = proj.groups; S.gidc = 1 + Math.max(...S.groups.map(g => +String(g.id).slice(1) || 0)); for (const [nm, g] of proj.layerGroups || []) { const L = S.layers.find(x => x.name === nm); if (L) L.group = g; } applyVisibility(); refreshLayers(); }
  for (const F of proj.flights || []) S.paths.push({ name: F.name, speed: F.speed, look: F.look, closed: F.closed, tilt: F.tilt, target: F.target ? l(F.target) : null, pts: F.waypoints.map(l) }); if ((proj.flights || []).length) drawPaths();
  for (const m of proj.measurements || []) { const pts = m.points.map(p => new THREE.Vector3(...l(p))); const M = { type: m.type, pts, lines: m.values, labels: [], name: m.name, note: m.note, tags: m.tags || [], color: m.color, closed: m.closed, lab: m.values[0], at: pts[0] }; pushMeasure(M); }
  if (proj.cad) { const d = [proj.cadOriginLocal[0] - o[0], proj.cadOriginLocal[1] - o[1], proj.cadOriginLocal[2] - o[2]]; const r = normCad(Object.assign(emptyCad(), proj.cad)); for (const [k, x] of cadItemsOf(r)) transformItem(k, x, d, 0, [0, 0, 0]); clearCad(); S.cad = r; drawCad(); buildCad(); }
  buildReview(); buildMeasure(); toast('Project loaded: ' + (proj.annotations || []).length + ' annotations, ' + (proj.bookmarks || []).length + ' views, ' + (proj.measurements || []).length + ' measurements.');
}

// ---------- exports: KML (Google Earth), DEM grid ----------
function toLatLon(p) { const w = [p[0] + S.origin[0], p[1] + S.origin[1], p[2] + S.origin[2]]; const C = X_.byId(S.crs); if (!C) return null; if (C.type === 'geo') return w; const g = X_.convertPoint(w[0], w[1], w[2], S.crs, C.datum); return g; }
function exportKML() {
  if (!S.crs) { toast('Set the project coordinate system (Coords tab) first: KML needs latitude and longitude.', true); return; }
  const C = X_.byId(S.crs); if (C && C.type === 'local') { toast('A local grid cannot be placed on Google Earth. Set a map grid such as MGA2020.', true); return; }
  const x = s => String(s).replace(/[<&>]/g, c => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]));
  const co = pts => pts.map(p => { const g = toLatLon(p); return g[0].toFixed(8) + ',' + g[1].toFixed(8) + ',' + g[2].toFixed(3); }).join(' ');
  let k = '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>ScanBench</name>\n';
  k += '<Style id="m"><LineStyle><color>ff00ccff</color><width>2</width></LineStyle><PolyStyle><color>4000ccff</color></PolyStyle></Style>\n';
  k += '<Folder><name>Annotations</name>'; for (const a of S.annots) k += '<Placemark><name>' + x(a.title) + '</name><description>' + x(a.note + (a.tags.length ? '\nTags: ' + a.tags.join(', ') : '')) + '</description><Point><altitudeMode>absolute</altitudeMode><coordinates>' + co([a.p]) + '</coordinates></Point></Placemark>\n'; k += '</Folder>';
  k += '<Folder><name>Measurements</name>'; for (const M of S.measures) { const P = (M.drawPts || M.pts).map(p => [p.x, p.y, p.z]); const d = '<description>' + x(M.lines.join('\n') + (M.note ? '\n' + M.note : '')) + '</description>';
    if (P.length === 1) k += '<Placemark><name>' + x(M.name) + '</name>' + d + '<Point><altitudeMode>absolute</altitudeMode><coordinates>' + co(P) + '</coordinates></Point></Placemark>\n';
    else if (M.closed) k += '<Placemark><name>' + x(M.name) + '</name>' + d + '<styleUrl>#m</styleUrl><Polygon><altitudeMode>absolute</altitudeMode><outerBoundaryIs><LinearRing><coordinates>' + co([...P, P[0]]) + '</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>\n';
    else k += '<Placemark><name>' + x(M.name) + '</name>' + d + '<styleUrl>#m</styleUrl><LineString><altitudeMode>absolute</altitudeMode><coordinates>' + co(P) + '</coordinates></LineString></Placemark>\n'; }
  k += '</Folder>';
  if (S.topo && S.topoContours) { k += '<Folder><name>Contours</name>'; for (const c of S.topoContours.slice(0, 5000)) if (c.pts && c.pts.length > 1) k += '<Placemark><name>' + (c.level + S.origin[2]).toFixed(2) + '</name><LineString><altitudeMode>absolute</altitudeMode><coordinates>' + co(c.pts) + '</coordinates></LineString></Placemark>\n'; k += '</Folder>'; }
  k += '</Document></kml>';
  saveFile('scanbench-kml.zip', IO.makeZip([{ name: 'doc.kml', data: new TextEncoder().encode(k) }]));
  toast('Saved a zip with doc.kml. Rename the zip to .kmz, or open doc.kml, in Google Earth.');
}
async function exportDEM(cell) {
  const R = await busy('Building the bare-earth grid…', async () => surfaceModel(cell, 'min', clouds().some(L => L.visible && L.cls)));
  if (!R) return; const o = S.origin; let s = 'ncols ' + R.nx + '\nnrows ' + R.ny + '\nxllcorner ' + (R.x0 + o[0]).toFixed(3) + '\nyllcorner ' + (R.y0 + o[1]).toFixed(3) + '\ncellsize ' + R.cell.toFixed(4) + '\nNODATA_value -9999\n';
  const rows = []; for (let j = R.ny - 1; j >= 0; j--) { const r = new Array(R.nx); for (let i = 0; i < R.nx; i++) { const v = R.z[j * R.nx + i]; r[i] = isNaN(v) ? '-9999' : (v + o[2]).toFixed(3); } rows.push(r.join(' ')); }
  s += rows.join('\n') + '\n'; const files = [{ name: 'dem.asc', data: new TextEncoder().encode(s) }];
  const C = S.crs && X_.byId(S.crs); if (C && C.epsg) files.push({ name: 'dem.txt', data: new TextEncoder().encode('Coordinate system: ' + C.name + ' (EPSG:' + C.epsg + ')\nHeights: as in the source point cloud\nGrid: ' + R.nx + ' x ' + R.ny + ' at ' + R.cell + ' m, lowest ground point per cell, holes filled\n') });
  saveFile('dem-grid.zip', IO.makeZip(files));
}

// ---------- samples ----------
const WEIR_PARTS = ['samples/weir_1.laz.b64.txt', 'samples/weir_2.laz.b64.txt', 'samples/weir_3.laz.b64.txt', 'samples/weir_4.laz.b64.txt'];
async function loadWeirSample() {
  if (location.protocol === 'file:') { toast('Open the published page to load the built-in samples (or open mundaring_weir_sim.laz).', true); return; }
  await busy('Loading the Mundaring Weir sample (2.6 M points)…', async onP => {
    const parts = []; let k = 0;
    for (const u of WEIR_PARTS) { const b = await fetchSamplePart(u); onP(++k / WEIR_PARTS.length * 0.6);
      const src = { name: u, size: b.length, read: async (o, l) => b.buffer.slice(o, o + l) }; parts.push(await IO.readLAS(src, { budget: 5e6, lazPerf: getLaz })); }
    const n = parts.reduce((a, p) => a + p.n, 0), o0 = parts[0].origin; const pos = new Float32Array(n * 3), rgb = new Uint8Array(n * 3), it = new Float32Array(n), cls = new Uint8Array(n); let q = 0;
    for (const p of parts) { const d = [p.origin[0] - o0[0], p.origin[1] - o0[1], p.origin[2] - o0[2]]; for (let i = 0; i < p.n; i++, q++) { pos[q * 3] = p.pos[i * 3] + d[0]; pos[q * 3 + 1] = p.pos[i * 3 + 1] + d[1]; pos[q * 3 + 2] = p.pos[i * 3 + 2] + d[2]; } if (p.rgb) rgb.set(p.rgb, (q - p.n) * 3); if (p.intensity) it.set(p.intensity, q - p.n); if (p.cls) cls.set(p.cls, q - p.n); }
    dropSample(); for (const L0 of S.layers.filter(x => x.name.startsWith('Offshore platform (synthetic'))) removeLayer(L0);
    const L = addCloud('Mundaring Weir (simulated DJI L3 drone LiDAR)', { n, pos, rgb, intensity: it, cls, origin: o0, meta: { format: 'Synthetic sample · LAS 1.4 PF7 · MGA2020 zone 50', total: n, stride: 1 } }, { sample: true }); S.sample = true; refreshAllPanes();
    if (!S.crs) { S.crs = 'MGA2020-50'; try { updateCrsStatus(); } catch (e) { } }
    fitAll(); setView('iso'); return L;
  });
}

// ---------- pane ----------
function buildReview() {
  const p = pane('review'); if (!p) return; p.textContent = '';
  // annotations
  const tags = [...new Set(S.annots.flatMap(a => a.tags || []))].sort(); if (S.aTag && !tags.includes(S.aTag)) S.aTag = '';
  const al = el('div', { class: 'mlist' });
  if (!S.annots.length) al.append(el('div', { class: 'empty' }, 'Pin notes to places in the cloud: issues, defects, questions for the field crew.'));
  S.annots.forEach((a, i) => {
    if (S.aTag && !(a.tags || []).includes(S.aTag)) return;
    const t = el('input', { type: 'text', value: a.title, id: 'annT' + i, 'aria-label': 'Title' }); t.addEventListener('change', () => { a.title = t.value; restyleAnnots(); });
    const c = el('input', { type: 'color', value: a.color, 'aria-label': 'Colour' }); c.addEventListener('input', () => { a.color = c.value; restyleAnnots(); });
    const g = el('input', { type: 'text', value: (a.tags || []).join(', '), placeholder: 'tags, comma separated', 'aria-label': 'Tags' }); g.addEventListener('change', () => { a.tags = g.value.split(',').map(s => s.trim()).filter(Boolean); restyleAnnots(); buildReview(); });
    const n = el('textarea', { rows: '2', placeholder: 'Notes', 'aria-label': 'Notes', style: 'width:100%;resize:vertical' }); n.value = a.note || ''; n.addEventListener('change', () => { a.note = n.value; });
    al.append(el('div', { class: 'mitem', style: 'grid-template-columns:minmax(0,1fr) auto' }, el('div', { style: 'display:grid;gap:4px' }, el('div', { class: 'row', style: 'flex-wrap:nowrap' }, t, c), g, n, el('div', { class: 'hint mono' }, W3(new THREE.Vector3(...a.p)).map(v => v.toFixed(3)).join(', '))),
      el('span', { style: 'display:grid;gap:4px;align-self:start' }, el('button', { class: 'btn small', onclick: () => { if (a.view) tweenCam(a.view, 900); else { const b = new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(...a.p), new THREE.Vector3(6, 6, 6)); fitBox(b); } } }, 'Go'), el('button', { class: 'btn small icon danger', 'aria-label': 'Delete annotation', onclick: () => { removeAnnotation(a); buildReview(); } }, '×'))));
  });
  const tagSel = tags.length ? (() => { const s = el('select', { style: 'width:auto', 'aria-label': 'Filter by tag' }, el('option', { value: '' }, 'All tags'), ...tags.map(t => el('option', { value: t, selected: S.aTag === t }, t))); s.addEventListener('change', () => { S.aTag = s.value; restyleAnnots(); buildReview(); }); return s; })() : null;
  p.append(el('div', { class: 'sec' }, el('h3', {}, 'Annotations', el('button', { class: 'btn small primary', onclick: annotMode }, 'Add')), tagSel ? el('div', { class: 'row' }, el('span', { class: 'hint' }, 'Show'), tagSel) : null, al));
  // bookmarks
  const bl = el('div', { class: 'mlist' });
  if (!S.bookmarks.length) bl.append(el('div', { class: 'empty' }, 'Save camera views to come back to, or play them in order as a flythrough.'));
  S.bookmarks.forEach((b, i) => { const t = el('input', { type: 'text', value: b.name, 'aria-label': 'View name' }); t.addEventListener('change', () => { b.name = t.value; });
    bl.append(el('div', { class: 'mitem', style: 'grid-template-columns:minmax(0,1fr) auto' }, t, el('span', { class: 'row', style: 'gap:4px' }, el('button', { class: 'btn small', onclick: () => tweenCam(b.cam, 900) }, 'Go'), el('button', { class: 'btn small', title: 'Replace with the current view', onclick: () => { b.cam = camState(); toast('View updated.'); } }, 'Update'),
      el('button', { class: 'btn small icon', disabled: i === 0, 'aria-label': 'Move up', onclick: () => { S.bookmarks.splice(i - 1, 0, S.bookmarks.splice(i, 1)[0]); buildReview(); } }, '↑'), el('button', { class: 'btn small icon danger', 'aria-label': 'Delete view', onclick: () => { S.bookmarks.splice(i, 1); buildReview(); } }, '×')))); });
  const secs = numIn('flySecs', S.flySecs || 3, '0.5'); secs.addEventListener('change', () => { S.flySecs = Math.max(0.5, +secs.value); });
  p.append(el('div', { class: 'sec' }, el('h3', {}, 'Saved views', el('button', { class: 'btn small primary', onclick: () => addBookmark() }, 'Save view')), bl,
    fieldRow('Seconds between views', secs),
    el('div', { class: 'row' }, RV.playing ? el('button', { class: 'btn small danger', onclick: () => { RV.stop = true; } }, 'Stop') : el('button', { class: 'btn small', disabled: S.bookmarks.length < 2, onclick: () => flythrough(false) }, 'Play flythrough'),
      el('button', { class: 'btn small', disabled: S.bookmarks.length < 2 || RV.playing, onclick: () => flythrough(true) }, 'Record video'))));
  // change detection
  const cl = clouds(); const la = layerSelect('chgA', cl, cl[0]), lb = layerSelect('chgB', cl, cl[1] || cl[0]); const cc = numIn('chgCell', S.chgCell || 0.5, '0.1'), th = numIn('chgThr', S.chgThr || 0.1, '0.01');
  const chg = el('div', { class: 'sec' }, el('h3', {}, 'Change between captures'), el('div', { class: 'note' }, 'Compares the surfaces of two captures of the same site (earthworks, stockpiles, erosion, construction progress). The later cloud gets a signed height-change field.'),
    fieldRow('Earlier capture', la), fieldRow('Later capture', lb), fieldRow('Grid (m)', cc), fieldRow('Ignore changes under (m)', th),
    el('div', { class: 'row' }, el('button', { class: 'btn small primary', disabled: cl.length < 2, onclick: () => { S.chgCell = +cc.value; S.chgThr = +th.value; const A = byId(la.value), B = byId(lb.value); if (A === B) { toast('Pick two different clouds.', true); return; } dsmChange(A, B, S.chgCell); } }, 'Compare')));
  if (S.change) chg.append(el('div', { class: 'result' }, el('dl', { class: 'kv' }, el('dt', {}, 'Material gained'), el('dd', {}, S.change.gain.toFixed(1) + ' m³'), el('dt', {}, 'Material lost'), el('dd', {}, S.change.loss.toFixed(1) + ' m³'), el('dt', {}, 'Net'), el('dd', {}, (S.change.gain - S.change.loss).toFixed(1) + ' m³'), el('dt', {}, 'Area compared'), el('dd', {}, S.change.area.toFixed(0) + ' m² at ' + S.change.c.toFixed(2) + ' m'))));
  p.append(chg);
  // analysis
  const L = S.sel && S.sel.kind === 'cloud' ? S.sel : null;
  const eye = numIn('losEye', S.losEye ?? 1.7, '0.1'), vr = numIn('vsR', S.vsR || 300, '10'), sb = el('select', { id: 'stockBase' }, el('option', { value: 'plane', selected: (S.stockBase || 'plane') === 'plane' }, 'Plane through the toe points'), el('option', { value: 'lowest', selected: S.stockBase === 'lowest' }, 'Lowest toe point'));
  eye.addEventListener('change', () => { S.losEye = +eye.value; }); vr.addEventListener('change', () => { S.vsR = +vr.value; }); sb.addEventListener('change', () => { S.stockBase = sb.value; });
  p.append(el('div', { class: 'sec' }, el('h3', {}, 'Analysis'),
    el('div', { class: 'row' }, el('button', { class: 'btn small', disabled: !L, onclick: () => slopeAspect(L, S.slopeCell || 1) }, 'Slope and aspect'), el('button', { class: 'btn small', onclick: planeDipMode }, 'Plane dip'), el('button', { class: 'btn small', onclick: stockpileMode }, 'Stockpile volume')),
    el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: losMode }, 'Line of sight'), el('button', { class: 'btn small', onclick: viewshedMode }, 'Viewshed'), el('button', { class: 'btn small', disabled: !L || !L.cls, onclick: () => wireClearance(L, S.wireThr || 3) }, 'Vegetation near wires')),
    S.wireRes ? el('div', { class: 'note' }, S.wireRes.close.toLocaleString() + ' vegetation points within ' + S.wireRes.thr + ' m of wires; closest ' + S.wireRes.minD.toFixed(2) + ' m; ' + S.wireRes.spots + ' spots pinned.') : null,
    fieldRow('Wire clearance limit (m)', (() => { const i = numIn('wireThr', S.wireThr || 3, '0.5'); i.addEventListener('change', () => { S.wireThr = +i.value; }); return i; })()), fieldRow('Observer eye height (m)', eye), fieldRow('Viewshed radius (m)', vr), fieldRow('Stockpile base', sb),
    el('div', { class: 'hint' }, 'Results land in the Measure list (with notes, tags and CSV/DXF export) or as colour fields on the cloud.')));
  // project + exports
  const fin = el('input', { type: 'file', accept: '.json', hidden: true }); fin.addEventListener('change', async () => { const f = fin.files[0]; if (!f) return; try { loadProjectObj(JSON.parse(await f.text())); } catch (e) { toast('Could not read the project: ' + e.message, true); } fin.value = ''; });
  const dc = numIn('demCell', S.demCell || 1, '0.1'); dc.addEventListener('change', () => { S.demCell = +dc.value; });
  p.append(el('div', { class: 'sec' }, el('h3', {}, 'Project and sharing'),
    el('div', { class: 'note' }, 'A project file keeps annotations, saved views, measurements, Scan to CAD results and the coordinate system, in real-world coordinates. Send it with the clouds so others open the same review.'),
    el('div', { class: 'row' }, el('button', { class: 'btn small primary', onclick: saveProject }, 'Save project'), el('label', { class: 'btn small' }, 'Open project…', fin)),
    el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: exportKML }, 'KML for Google Earth'), el('button', { class: 'btn small', onclick: exportSHP }, 'Shapefiles'), el('button', { class: 'btn small', disabled: !clouds().length, onclick: () => exportDEM(S.demCell || 1) }, 'DEM grid (.asc)')), fieldRow('DEM cell (m)', dc)));
  const dxin = el('input', { type: 'file', accept: '.dxf', hidden: true }); dxin.addEventListener('change', async () => { for (const f of dxin.files) { try { addOverlay(f.name, parseDXF(await f.text())); } catch (e) { toast('Could not read ' + f.name + ': ' + e.message, true); } } dxin.value = ''; });
  const ovl = el('div', { class: 'mlist' }); for (const ov of S.overlays) { const cb = el('input', { type: 'checkbox', 'aria-label': 'Show ' + ov.name }); cb.checked = ov.visible; cb.addEventListener('change', () => { ov.visible = cb.checked; ov.obj.visible = cb.checked; S.dirty = true; });
    ovl.append(el('div', { class: 'mitem', style: 'grid-template-columns:auto minmax(0,1fr) auto' }, cb, el('div', {}, el('div', { class: 't' }, ov.name), el('div', { class: 'v' }, ov.n.toLocaleString() + ' entities')), el('button', { class: 'btn small icon danger', 'aria-label': 'Remove overlay', onclick: () => { annot.remove(ov.obj); S.overlays = S.overlays.filter(x => x !== ov); S.dirty = true; buildReview(); } }, '×'))); }
  p.append(el('div', { class: 'sec' }, el('h3', {}, 'Design overlays', el('label', { class: 'btn small' }, 'Add DXF…', dxin)), el('div', { class: 'note' }, 'Show design linework (lines, polylines, circles, 3D faces, points) with the cloud to check as-built against design. The DXF must be in the same coordinates as the cloud.'), ovl));
  p.append(el('div', { class: 'sec' }, el('h3', {}, 'Samples'), el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: loadWeirSample }, 'Mundaring Weir (L3 drone)'), el('button', { class: 'btn small', onclick: () => loadPlatformSample() }, 'Offshore platform (scan)')),
    el('div', { class: 'hint' }, 'Synthetic test data. The weir is a simulation styled on the real dam, not survey data.')));
}
const _refreshAll2 = refreshAllPanes;
refreshAllPanes = function () { _refreshAll2(); buildReview(); };

// ---------- vegetation clearance to wires (utility corridor check) ----------
async function wireClearance(L, thr = 3) {
  if (!L || !L.cls) { toast('This needs a classified cloud (wires class 14, vegetation 3–5).', true); return; }
  const res = await busy('Measuring vegetation clearance to wires…', async onP => {
    const wi = []; for (let i = 0; i < L.n; i++) if (L.cls[i] === 14) wi.push(i); if (wi.length < 10) throw new Error('No wire points (class 14) in ' + L.name + '.');
    const W = new Float32Array(wi.length * 3); wi.forEach((i, k) => { W[k * 3] = L.pos[i * 3]; W[k * 3 + 1] = L.pos[i * 3 + 1]; W[k * 3 + 2] = L.pos[i * 3 + 2]; });
    const K = await AL.buildKD(W, wi.length); const d = new Float32Array(L.n).fill(NaN); let close = 0, minD = Infinity; const hits = [];
    for (let i = 0; i < L.n; i++) { const c = L.cls[i]; if (c < 3 || c > 5) continue; const r = AL.kdNearest(K, L.pos[i * 3], L.pos[i * 3 + 1], L.pos[i * 3 + 2], 30); if (r[0] < 0) continue; const v = Math.sqrt(r[1]); d[i] = v; if (v < thr) { close++; if (hits.length < 200000) hits.push(i); } if (v < minD) minD = v; if ((i & 262143) === 0) { onP(i / L.n); await tick(); } }
    // group close points into trees / clumps (2 m cells)
    const cl = new Map(); for (const i of hits) { const k = Math.floor(L.pos[i * 3] / 2) + ',' + Math.floor(L.pos[i * 3 + 1] / 2); const e = cl.get(k); if (!e || d[i] < d[e]) cl.set(k, i); }
    const spots = [...cl.values()].sort((a, b) => d[a] - d[b]); const kept = []; for (const i of spots) { if (kept.some(j => Math.hypot(L.pos[i * 3] - L.pos[j * 3], L.pos[i * 3 + 1] - L.pos[j * 3 + 1]) < 4)) continue; kept.push(i); if (kept.length >= 50) break; }
    return { d, close, minD, kept };
  });
  if (!res) return; addSF(L, 'Clearance to wires (m)', res.d, false); L.sfStyle['Clearance to wires (m)'].lo = 0; L.sfStyle['Clearance to wires (m)'].hi = thr * 3; L.sfStyle['Clearance to wires (m)'].ramp = 'rgb'; colorize(L); refreshProps();
  for (const i of res.kept.slice(0, 25)) addAnnotation(new THREE.Vector3(L.pos[i * 3], L.pos[i * 3 + 1], L.pos[i * 3 + 2]), 'Vegetation ' + res.d[i].toFixed(1) + ' m from wire', 'Clearance below ' + thr + ' m', ['encroachment'], '#e0475b');
  S.wireRes = { close: res.close, minD: res.minD, spots: res.kept.length, thr }; buildReview();
  toast(res.close ? res.close.toLocaleString() + ' vegetation points within ' + thr + ' m of a wire; closest ' + res.minD.toFixed(2) + ' m. Spots are pinned as annotations tagged "encroachment".' : 'No vegetation within ' + thr + ' m of the wires (closest ' + res.minD.toFixed(1) + ' m).');
}

// ---------- DXF overlays (design linework shown with the cloud) ----------
S.overlays = [];
function parseDXF(text) {
  const L = text.split(/\r?\n/); const pairs = []; for (let i = 0; i + 1 < L.length; i += 2) pairs.push([+L[i].trim(), L[i + 1].trim()]);
  let i = 0; while (i < pairs.length && !(pairs[i][0] === 2 && pairs[i][1] === 'ENTITIES')) i++;
  const segs = [], faces = [], pts = []; let cur = null, poly = null; const flush = () => {
    if (!cur) return; const g = cur.g, n = k => +(g[k] || 0), t = cur.t;
    if (t === 'LINE') segs.push([[n(10), n(20), n(30)], [n(11), n(21), n(31)]]);
    else if (t === 'POINT') pts.push([n(10), n(20), n(30)]);
    else if (t === '3DFACE') faces.push([[n(10), n(20), n(30)], [n(11), n(21), n(31)], [n(12), n(22), n(32)], [n(13), n(23), n(33)]]);
    else if (t === 'LWPOLYLINE') { const v = cur.v; const z = n(38); for (let k = 1; k < v.length; k++) segs.push([[v[k - 1][0], v[k - 1][1], z], [v[k][0], v[k][1], z]]); if ((n(70) & 1) && v.length > 2) segs.push([[v[v.length - 1][0], v[v.length - 1][1], z], [v[0][0], v[0][1], z]]); }
    else if (t === 'CIRCLE') { const c = [n(10), n(20), n(30)], r = n(40); for (let k = 0; k < 48; k++) { const a = k / 48 * 2 * Math.PI, b = (k + 1) / 48 * 2 * Math.PI; segs.push([[c[0] + r * Math.cos(a), c[1] + r * Math.sin(a), c[2]], [c[0] + r * Math.cos(b), c[1] + r * Math.sin(b), c[2]]]); } }
    else if (t === 'POLYLINE') poly = { v: [], closed: n(70) & 1 };
    else if (t === 'VERTEX' && poly) poly.v.push([n(10), n(20), n(30)]);
    else if (t === 'SEQEND' && poly) { const v = poly.v; for (let k = 1; k < v.length; k++) segs.push([v[k - 1], v[k]]); if (poly.closed && v.length > 2) segs.push([v[v.length - 1], v[0]]); poly = null; }
    cur = null; };
  for (; i < pairs.length; i++) { const [c, v] = pairs[i]; if (c === 0) { flush(); if (v === 'ENDSEC') break; cur = { t: v, g: {}, v: [] }; } else if (cur) { if (cur.t === 'LWPOLYLINE' && c === 10) cur.v.push([+v, 0]); else if (cur.t === 'LWPOLYLINE' && c === 20 && cur.v.length) cur.v[cur.v.length - 1][1] = +v; else cur.g[c] = v; } }
  flush(); return { segs, faces, pts };
}
function addOverlay(name, D) {
  if (!S.origin) { toast('Load a point cloud first so the drawing has somewhere to sit.', true); return; }
  const o = S.origin, l = p => [p[0] - o[0], p[1] - o[1], p[2] - o[2]]; const g = new THREE.Group();
  if (D.segs.length) g.add(linesObj(D.segs.map(s => s.map(l)), 0xff8c1a));
  if (D.faces.length) g.add(facesMesh(D.faces.map(q => q.map(l)), 0x9fb7ff, 0.45));
  if (D.pts.length) { const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(D.pts.map(l).flat(), 3)); g.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xff8c1a, size: 5, sizeAttenuation: false }))); }
  annot.add(g); const ov = { name, obj: g, n: D.segs.length + D.faces.length + D.pts.length, visible: true }; S.overlays.push(ov); S.dirty = true; buildReview();
  const far = D.segs.concat(D.faces).slice(0, 50).flat().some(p => Math.hypot(p[0] - o[0], p[1] - o[1]) > 50000);
  toast('Overlay ' + name + ': ' + D.segs.length + ' lines, ' + D.faces.length + ' faces, ' + D.pts.length + ' points.' + (far ? ' It looks far from the cloud: check both are in the same coordinate system.' : ''), far);
}

// ---------- Shapefile export (annotations as points, measurements and contours as 3D lines) ----------
function shpFiles(kind, recs) {   // kind 11 = PointZ, 13 = PolyLineZ; recs: [{parts:[[[x,y,z],...]], attrs:{NAME, TYPE, VALUE}}]
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
  for (const r of recs) for (const pt of r.parts.flat()) { bx0 = Math.min(bx0, pt[0]); by0 = Math.min(by0, pt[1]); bx1 = Math.max(bx1, pt[0]); by1 = Math.max(by1, pt[1]); bz0 = Math.min(bz0, pt[2]); bz1 = Math.max(bz1, pt[2]); }
  const recBytes = r => { if (kind === 11) return 4 + 32; const np = r.parts.reduce((a, p) => a + p.length, 0); return 4 + 32 + 8 + r.parts.length * 4 + np * 16 + 16 + np * 8 + 16 + np * 8; };
  const total = 100 + recs.reduce((a, r) => a + 8 + recBytes(r), 0); const shp = new DataView(new ArrayBuffer(total)), shx = new DataView(new ArrayBuffer(100 + recs.length * 8));
  const hdr = (dv, len) => { dv.setInt32(0, 9994); dv.setInt32(24, len / 2); dv.setInt32(28, 1000, true); dv.setInt32(32, kind, true); dv.setFloat64(36, bx0, true); dv.setFloat64(44, by0, true); dv.setFloat64(52, bx1, true); dv.setFloat64(60, by1, true); dv.setFloat64(68, bz0, true); dv.setFloat64(76, bz1, true); };
  hdr(shp, total); hdr(shx, 100 + recs.length * 8); let off = 100;
  recs.forEach((r, k) => { const len = recBytes(r); shx.setInt32(100 + k * 8, off / 2); shx.setInt32(104 + k * 8, len / 2); shp.setInt32(off, k + 1); shp.setInt32(off + 4, len / 2); let p = off + 8; shp.setInt32(p, kind, true); p += 4;
    if (kind === 11) { const q = r.parts[0][0]; shp.setFloat64(p, q[0], true); shp.setFloat64(p + 8, q[1], true); shp.setFloat64(p + 16, q[2], true); shp.setFloat64(p + 24, 0, true); }
    else { const all = r.parts.flat(); const xs = all.map(q => q[0]), ys = all.map(q => q[1]), zs = all.map(q => q[2]); shp.setFloat64(p, Math.min(...xs), true); shp.setFloat64(p + 8, Math.min(...ys), true); shp.setFloat64(p + 16, Math.max(...xs), true); shp.setFloat64(p + 24, Math.max(...ys), true); p += 32;
      shp.setInt32(p, r.parts.length, true); shp.setInt32(p + 4, all.length, true); p += 8; let s = 0; for (const pr of r.parts) { shp.setInt32(p, s, true); p += 4; s += pr.length; }
      for (const q of all) { shp.setFloat64(p, q[0], true); shp.setFloat64(p + 8, q[1], true); p += 16; } shp.setFloat64(p, Math.min(...zs), true); shp.setFloat64(p + 8, Math.max(...zs), true); p += 16; for (const q of all) { shp.setFloat64(p, q[2], true); p += 8; } shp.setFloat64(p, 0, true); shp.setFloat64(p + 8, 0, true); p += 16; for (const q of all) { shp.setFloat64(p, 0, true); p += 8; } }
    off += 8 + len; });
  // dBASE III table: NAME C(80), TYPE C(30), VALUE C(120)
  const F = [['NAME', 80], ['TYPE', 30], ['VALUE', 120]], recLen = 1 + F.reduce((a, f) => a + f[1], 0), hl = 32 + F.length * 32 + 1; const dbf = new Uint8Array(hl + recs.length * recLen + 1); const dv = new DataView(dbf.buffer); const enc = s => new TextEncoder().encode(String(s));
  dbf[0] = 3; const d = new Date(); dbf[1] = d.getFullYear() - 1900; dbf[2] = d.getMonth() + 1; dbf[3] = d.getDate(); dv.setInt32(4, recs.length, true); dv.setInt16(8, hl, true); dv.setInt16(10, recLen, true);
  F.forEach(([nm, w], k) => { dbf.set(enc(nm), 32 + k * 32); dbf[32 + k * 32 + 11] = 67; dbf[32 + k * 32 + 16] = w; }); dbf[hl - 1] = 13;
  recs.forEach((r, k) => { let p = hl + k * recLen; dbf[p++] = 32; for (const [nm, w] of F) { const b = enc((r.attrs[nm] || '').toString().replace(/[^\x20-\x7e]/g, '?')).slice(0, w); dbf.fill(32, p, p + w); dbf.set(b, p); p += w; } }); dbf[dbf.length - 1] = 26;
  return { shp: new Uint8Array(shp.buffer), shx: new Uint8Array(shx.buffer), dbf };
}
function exportSHP() {
  if (!S.origin) return; const o = S.origin, w = p => [p[0] + o[0], p[1] + o[1], p[2] + o[2]]; const files = [];
  const prj = S.crs && X_.byId(S.crs) && X_.byId(S.crs).epsg ? 'Coordinate system: ' + X_.byId(S.crs).name + ' (EPSG:' + X_.byId(S.crs).epsg + '). Assign it in your GIS if it asks.' : 'Coordinate system not set in ScanBench.';
  const add = (name, kind, recs) => { if (!recs.length) return; const f = shpFiles(kind, recs); files.push({ name: name + '.shp', data: f.shp }, { name: name + '.shx', data: f.shx }, { name: name + '.dbf', data: f.dbf }); };
  add('annotations', 11, S.annots.map(a => ({ parts: [[w(a.p)]], attrs: { NAME: a.title, TYPE: (a.tags || []).join(' '), VALUE: a.note } })));
  add('measure_points', 11, S.measures.filter(M => M.pts.length === 1).map(M => ({ parts: [[w([M.pts[0].x, M.pts[0].y, M.pts[0].z])]], attrs: { NAME: M.name, TYPE: M.type, VALUE: M.lines[0] } })));
  add('measure_lines', 13, S.measures.filter(M => M.pts.length > 1).map(M => { const P = (M.drawPts || M.pts).map(p => w([p.x, p.y, p.z])); if (M.closed) P.push(P[0]); return { parts: [P], attrs: { NAME: M.name, TYPE: M.type, VALUE: M.lines.join('; ') } }; }));
  if (S.topoContours) add('contours', 13, S.topoContours.filter(c => c.pts.length > 1).map(c => ({ parts: [c.pts.map(w)], attrs: { NAME: (c.level + o[2]).toFixed(2), TYPE: c.major ? 'major' : 'minor', VALUE: (c.level + o[2]).toFixed(3) } })));
  if (!files.length) { toast('Nothing to export yet: add annotations, measurements or contours.', true); return; }
  files.push({ name: 'README.txt', data: new TextEncoder().encode('ScanBench shapefiles\n' + prj + '\nHeights are in the Z values of each vertex.\n') });
  saveFile('scanbench-shapefiles.zip', IO.makeZip(files));
}
