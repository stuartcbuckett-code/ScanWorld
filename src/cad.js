// ===== ScanBench scan-to-CAD engine: normals, planes, pipes, flanges, steel members (no DOM) =====
(function () {
const G = typeof globalThis !== 'undefined' ? globalThis : window;
const AL = typeof module !== 'undefined' ? require('./algo.js') : G.SBA;
const tickC = () => new Promise(r => setTimeout(r, 0));

// ---------- KD queries on SBA.buildKD trees ----------
function kdKNN(K, x, y, z, k, oI, oD) { // fills oI/oD (length k) sorted ascending; returns count
  const { pos, idx, axis, split, size, LEAF } = K; let cnt = 0, worst = Infinity; const q = [x, y, z];
  function ins(i, d) {
    if (cnt < k) cnt++; else if (d >= worst) return;
    let j = cnt - 1; while (j > 0 && oD[j - 1] > d) { oD[j] = oD[j - 1]; oI[j] = oI[j - 1]; j--; }
    oD[j] = d; oI[j] = i; if (cnt === k) worst = oD[k - 1];
  }
  function rec(node, lo, hi) {
    if (hi - lo <= LEAF || node * 2 + 2 >= size) {
      for (let a = lo; a < hi; a++) { const p = idx[a] * 3, dx = pos[p] - x, dy = pos[p + 1] - y, dz = pos[p + 2] - z; ins(idx[a], dx * dx + dy * dy + dz * dz); }
      return;
    }
    const ax = axis[node], diff = q[ax] - split[node], mid = (lo + hi) >> 1;
    if (diff < 0) { rec(node * 2 + 1, lo, mid); if (diff * diff < worst) rec(node * 2 + 2, mid, hi); }
    else { rec(node * 2 + 2, mid, hi); if (diff * diff < worst) rec(node * 2 + 1, lo, mid); }
  }
  rec(0, 0, K.n); return cnt;
}
function kdRadius(K, x, y, z, r, out) { // pushes indices into out (array), returns out
  const { pos, idx, axis, split, size, LEAF } = K, r2 = r * r, q = [x, y, z];
  function rec(node, lo, hi) {
    if (hi - lo <= LEAF || node * 2 + 2 >= size) {
      for (let a = lo; a < hi; a++) { const p = idx[a] * 3, dx = pos[p] - x, dy = pos[p + 1] - y, dz = pos[p + 2] - z; if (dx * dx + dy * dy + dz * dz <= r2) out.push(idx[a]); }
      return;
    }
    const ax = axis[node], diff = q[ax] - split[node], mid = (lo + hi) >> 1;
    if (diff < 0) { rec(node * 2 + 1, lo, mid); if (diff * diff <= r2) rec(node * 2 + 2, mid, hi); }
    else { rec(node * 2 + 2, mid, hi); if (diff * diff <= r2) rec(node * 2 + 1, lo, mid); }
  }
  rec(0, 0, K.n); return out;
}

// ---------- small linear algebra ----------
function eig3(a00, a01, a02, a11, a12, a22) {
  // eigenvalues ascending l[0..2], eigenvectors v0 (smallest), v2 (largest)
  const p1 = a01 * a01 + a02 * a02 + a12 * a12; let l0, l1, l2;
  if (p1 < 1e-30) { const d = [a00, a11, a22].sort((a, b) => a - b); l0 = d[0]; l1 = d[1]; l2 = d[2]; }
  else {
    const q = (a00 + a11 + a22) / 3, b00 = a00 - q, b11 = a11 - q, b22 = a22 - q;
    const p = Math.sqrt((b00 * b00 + b11 * b11 + b22 * b22 + 2 * p1) / 6) || 1e-30;
    const det = (b00 * (b11 * b22 - a12 * a12) - a01 * (a01 * b22 - a12 * a02) + a02 * (a01 * a12 - b11 * a02)) / (p * p * p);
    const r = Math.max(-1, Math.min(1, det / 2)), phi = Math.acos(r) / 3;
    l2 = q + 2 * p * Math.cos(phi); l0 = q + 2 * p * Math.cos(phi + 2 * Math.PI / 3); l1 = 3 * q - l0 - l2;
  }
  const vec = l => {
    const r0 = [a00 - l, a01, a02], r1 = [a01, a11 - l, a12], r2 = [a02, a12, a22 - l];
    const c = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const cs = [c(r0, r1), c(r0, r2), c(r1, r2)]; let best = cs[0], bn = 0;
    for (const v of cs) { const nn = v[0] * v[0] + v[1] * v[1] + v[2] * v[2]; if (nn > bn) { bn = nn; best = v; } }
    if (bn < 1e-40) return [0, 0, 1];
    const s = 1 / Math.sqrt(bn); return [best[0] * s, best[1] * s, best[2] * s];
  };
  return { l: [l0, l1, l2], v0: vec(l0), v2: vec(l2), vec };
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
function perpFrame(d, prefer) { // u,v orthonormal ⟂ d; u close to `prefer` if given
  let u = prefer ? add(prefer, d, -dot(prefer, d)) : null;
  if (!u || Math.hypot(...u) < 1e-6) u = Math.abs(d[2]) < 0.9 ? cross(d, [0, 0, 1]) : cross(d, [1, 0, 0]);
  u = norm(u); return { u, v: norm(cross(d, u)) };
}

// ---------- voxel subsample with full assignment ----------
function voxelAssign(pos, n, cell, mask) {
  const inv = 1 / cell; const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) { if (mask && !mask[i]) continue; for (let k = 0; k < 3; k++) { const v = pos[i * 3 + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; } }
  const ny = Math.floor((mx[1] - mn[1]) * inv) + 1, nz = Math.floor((mx[2] - mn[2]) * inv) + 1;
  const m = new Map(); let reps = new Uint32Array(1024), cnt = 0; const assign = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (mask && !mask[i]) continue;
    const key = (Math.floor((pos[i * 3] - mn[0]) * inv) * ny + Math.floor((pos[i * 3 + 1] - mn[1]) * inv)) * nz + Math.floor((pos[i * 3 + 2] - mn[2]) * inv);
    let s = m.get(key);
    if (s === undefined) { if (cnt === reps.length) { const a = new Uint32Array(cnt * 2); a.set(reps); reps = a; } s = cnt++; m.set(key, s); reps[s] = i; }
    assign[i] = s;
  }
  return { reps: reps.slice(0, cnt), assign };
}
function gather(pos, idx) { const o = new Float32Array(idx.length * 3); for (let j = 0; j < idx.length; j++) { const i = idx[j] * 3; o[j * 3] = pos[i]; o[j * 3 + 1] = pos[i + 1]; o[j * 3 + 2] = pos[i + 2]; } return o; }

// ---------- normals (kNN PCA) ----------
async function computeNormals(P, n, k, onP = () => {}) {
  const K = await AL.buildKD(P, n, f => onP(f * 0.2));
  const nrm = new Float32Array(n * 3), curv = new Float32Array(n), nbr = new Int32Array(n * k);
  const oI = new Int32Array(k), oD = new Float64Array(k);
  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    const c = kdKNN(K, x, y, z, k, oI, oD);
    let sx = 0, sy = 0, sz = 0;
    for (let j = 0; j < c; j++) { const q = oI[j] * 3; sx += P[q]; sy += P[q + 1]; sz += P[q + 2]; nbr[i * k + j] = oI[j]; }
    for (let j = c; j < k; j++) nbr[i * k + j] = -1;
    sx /= c; sy /= c; sz /= c;
    let a00 = 0, a01 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0;
    for (let j = 0; j < c; j++) { const q = oI[j] * 3, dx = P[q] - sx, dy = P[q + 1] - sy, dz = P[q + 2] - sz; a00 += dx * dx; a01 += dx * dy; a02 += dx * dz; a11 += dy * dy; a12 += dy * dz; a22 += dz * dz; }
    const e = eig3(a00, a01, a02, a11, a12, a22); const v = e.v0;
    nrm[i * 3] = v[0]; nrm[i * 3 + 1] = v[1]; nrm[i * 3 + 2] = v[2];
    const s = e.l[0] + e.l[1] + e.l[2]; curv[i] = s > 0 ? Math.max(0, e.l[0]) / s : 0;
    if ((i & 0x7fff) === 0) { onP(0.2 + 0.8 * i / n); await tickC(); }
  }
  return { K, nrm, curv, nbr, k };
}

// ---------- plane segmentation (region growing) ----------
async function growPlanes(P, n, N, opts = {}, onP = () => {}) {
  const { nrm, curv, nbr, k } = N; const cosT = Math.cos((opts.angleDeg || 10) * Math.PI / 180), tol = opts.distTol || 0.02, minPts = opts.minPts || 200;
  const label = new Int32Array(n).fill(-1); const order = new Uint32Array(n); for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => curv[a] - curv[b]);
  const planes = []; const queue = new Int32Array(n);
  for (let oi = 0; oi < n; oi++) {
    const s = order[oi]; if (label[s] !== -1 || curv[s] > 0.05) continue;
    const id = planes.length; let qh = 0, qt = 0; queue[qt++] = s; label[s] = id;
    let cnt = 0, sx = 0, sy = 0, sz = 0, sxx = 0, sxy = 0, sxz = 0, syy = 0, syz = 0, szz = 0;
    let pn = [nrm[s * 3], nrm[s * 3 + 1], nrm[s * 3 + 2]], pc = [P[s * 3], P[s * 3 + 1], P[s * 3 + 2]], nextFit = 16;
    const members = [];
    while (qh < qt) {
      const i = queue[qh++]; members.push(i);
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2]; cnt++; sx += x; sy += y; sz += z; sxx += x * x; sxy += x * y; sxz += x * z; syy += y * y; syz += y * z; szz += z * z;
      if (cnt >= nextFit) {
        nextFit = Math.ceil(cnt * 1.5); const mx = sx / cnt, my = sy / cnt, mz = sz / cnt;
        const e = eig3(sxx / cnt - mx * mx, sxy / cnt - mx * my, sxz / cnt - mx * mz, syy / cnt - my * my, syz / cnt - my * mz, szz / cnt - mz * mz);
        pn = e.v0; pc = [mx, my, mz];
      }
      for (let j = 0; j < k; j++) {
        const q = nbr[i * k + j]; if (q < 0 || label[q] !== -1) continue;
        if (Math.abs(nrm[q * 3] * pn[0] + nrm[q * 3 + 1] * pn[1] + nrm[q * 3 + 2] * pn[2]) < cosT) continue;
        if (Math.abs((P[q * 3] - pc[0]) * pn[0] + (P[q * 3 + 1] - pc[1]) * pn[1] + (P[q * 3 + 2] - pc[2]) * pn[2]) > tol) continue;
        label[q] = id; queue[qt++] = q;
      }
    }
    if (cnt < minPts) { for (const i of members) label[i] = -2; continue; } // -2: tried, too small
    const mx = sx / cnt, my = sy / cnt, mz = sz / cnt;
    const e = eig3(sxx / cnt - mx * mx, sxy / cnt - mx * my, sxz / cnt - mx * mz, syy / cnt - my * my, syz / cnt - my * mz, szz / cnt - mz * mz);
    planes.push({ id, idx: Uint32Array.from(members), normal: e.v0, centroid: [mx, my, mz], rms: Math.sqrt(Math.max(0, e.l[0])), count: cnt });
    if (planes.length % 20 === 0) { onP(oi / n); await tickC(); }
  }
  for (let i = 0; i < n; i++) if (label[i] === -2) label[i] = -1;
  return { label, planes };
}

// ---------- outlines of 2D point sets (grid + marching squares) ----------
function douglasPeucker(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1; const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop(); const A = pts[a], B = pts[b]; let md = -1, mi = -1;
    const dx = B[0] - A[0], dy = B[1] - A[1], dz = (B[2] || 0) - (A[2] || 0), L2 = dx * dx + dy * dy + dz * dz;
    for (let i = a + 1; i < b; i++) {
      const p = pts[i]; let t = L2 > 0 ? ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy + ((p[2] || 0) - (A[2] || 0)) * dz) / L2 : 0; t = Math.max(0, Math.min(1, t));
      const ex = p[0] - A[0] - t * dx, ey = p[1] - A[1] - t * dy, ez = (p[2] || 0) - (A[2] || 0) - t * dz, d = ex * ex + ey * ey + ez * ez;
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol * tol) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function simplifyClosed(loop, tol) { // split closed loop at farthest pair
  if (loop.length < 5) return loop;
  let far = 0, fd = -1; for (let i = 1; i < loop.length; i++) { const d = (loop[i][0] - loop[0][0]) ** 2 + (loop[i][1] - loop[0][1]) ** 2; if (d > fd) { fd = d; far = i; } }
  const a = douglasPeucker(loop.slice(0, far + 1), tol), b = douglasPeucker(loop.slice(far).concat([loop[0]]), tol);
  return a.concat(b.slice(1, -1));
}
function joinSegments(segs) { // segs: [[p,q]], returns polylines (closed loops repeat first point)
  const key = p => Math.round(p[0] * 1e4) + ',' + Math.round(p[1] * 1e4);
  const adj = new Map();
  segs.forEach((s, k) => { for (const e of [0, 1]) { const kk = key(s[e]); let l = adj.get(kk); if (!l) adj.set(kk, l = []); l.push(k); } });
  const used = new Uint8Array(segs.length), lines = [];
  for (let s0 = 0; s0 < segs.length; s0++) {
    if (used[s0]) continue; used[s0] = 1; const pts = [segs[s0][0], segs[s0][1]];
    for (const dir of [1, -1]) for (;;) {
      const tip = dir === 1 ? pts[pts.length - 1] : pts[0]; const kt = key(tip);
      const cand = (adj.get(kt) || []).find(k => !used[k]); if (cand === undefined) break;
      used[cand] = 1; const s = segs[cand]; const nx = key(s[0]) === kt ? s[1] : s[0];
      if (dir === 1) pts.push(nx); else pts.unshift(nx);
    }
    lines.push(pts);
  }
  return lines;
}
// mask: Uint8Array nx*ny. returns loops in cell coords (cell centres at i+0.5)
function maskOutlines(mask, nx, ny) {
  const at = (i, j) => (i < 0 || j < 0 || i >= nx || j >= ny) ? 0 : mask[j * nx + i];
  const segs = [];
  for (let j = -1; j < ny; j++) for (let i = -1; i < nx; i++) {
    const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
    const idx = a | (b << 1) | (c << 2) | (d << 3); if (idx === 0 || idx === 15) continue;
    const x = i + 0.5, y = j + 0.5;
    const e = [[x + 0.5, y], [x + 1, y + 0.5], [x + 0.5, y + 1], [x, y + 0.5]];
    const T = { 1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 5: [[3, 0], [1, 2]], 6: [[0, 2]], 7: [[3, 2]], 8: [[2, 3]], 9: [[0, 2]], 10: [[0, 1], [2, 3]], 11: [[1, 2]], 12: [[1, 3]], 13: [[0, 1]], 14: [[0, 3]] }[idx];
    for (const [p, q] of T) segs.push([e[p], e[q]]);
  }
  return joinSegments(segs);
}
function dilate(mask, nx, ny, r = 1) {
  const o = new Uint8Array(mask.length);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { if (!mask[j * nx + i]) continue; for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) { const a = i + di, b = j + dj; if (a >= 0 && b >= 0 && a < nx && b < ny) o[b * nx + a] = 1; } }
  return o;
}
function erode(mask, nx, ny, r = 1) {
  const o = new Uint8Array(mask.length);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { let ok = 1; for (let dj = -r; dj <= r && ok; dj++) for (let di = -r; di <= r; di++) { const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= nx || b >= ny || !mask[b * nx + a]) { ok = 0; break; } } o[j * nx + i] = ok; }
  return o;
}
function polyArea(loop) { let a = 0; for (let i = 0; i < loop.length; i++) { const p = loop[i], q = loop[(i + 1) % loop.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }
// outline of 2D points: returns loops (outer first) in world 2D
function outline2D(xy, m, cell, simplifyTol, close = 1) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < m; i++) { const x = xy[i * 2], y = xy[i * 2 + 1]; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  const pad = (close || 0) + 1; x0 -= pad * cell; y0 -= pad * cell;
  const nx = Math.floor((x1 - x0) / cell) + 1 + pad, ny = Math.floor((y1 - y0) / cell) + 1 + pad;
  if (nx * ny > 2e7) return { loops: [], area: 0 };
  let mask = new Uint8Array(nx * ny);
  for (let i = 0; i < m; i++) mask[Math.floor((xy[i * 2 + 1] - y0) / cell) * nx + Math.floor((xy[i * 2] - x0) / cell)] = 1;
  if (close) mask = erode(dilate(mask, nx, ny, close), nx, ny, close);
  let area = 0; for (const v of mask) area += v; area *= cell * cell;
  const loops = maskOutlines(mask, nx, ny).filter(l => l.length > 3).map(l => { const w = l.map(p => [x0 + p[0] * cell, y0 + p[1] * cell]); if (w.length > 1 && w[0][0] === w[w.length - 1][0] && w[0][1] === w[w.length - 1][1]) w.pop(); return simplifyClosed(w, simplifyTol); });
  loops.sort((a, b) => Math.abs(polyArea(b)) - Math.abs(polyArea(a)));
  return { loops, area };
}

// plane -> structural surface with outline
function describePlane(P, pl, spacing, zRef) {
  const n = pl.normal; const vertical = Math.abs(n[2]) < 0.25, horizontal = Math.abs(n[2]) > 0.95;
  const { u, v } = perpFrame(n, vertical ? [0, 0, 1] : [1, 0, 0]);
  // for vertical planes we want u horizontal, v vertical: perpFrame gives u ≈ projection of prefer; swap
  const U = vertical ? norm(cross([0, 0, 1], n)) : u, V = vertical ? [0, 0, 1] : v;
  const m = pl.idx.length, xy = new Float64Array(m * 2), c = pl.centroid;
  for (let j = 0; j < m; j++) { const i = pl.idx[j] * 3, dx = P[i] - c[0], dy = P[i + 1] - c[1], dz = P[i + 2] - c[2]; xy[j * 2] = dx * U[0] + dy * U[1] + dz * U[2]; xy[j * 2 + 1] = dx * V[0] + dy * V[1] + dz * V[2]; }
  const cell = Math.max(spacing * 2.5, 0.02);
  const o = outline2D(xy, m, cell, Math.max(0.02, spacing * 2), 2);
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity; for (let j = 0; j < m; j++) { a0 = Math.min(a0, xy[j * 2]); a1 = Math.max(a1, xy[j * 2]); b0 = Math.min(b0, xy[j * 2 + 1]); b1 = Math.max(b1, xy[j * 2 + 1]); }
  const loops3 = o.loops.map(l => l.map(p => [c[0] + U[0] * p[0] + V[0] * p[1], c[1] + U[1] * p[0] + V[1] * p[1], c[2] + U[2] * p[0] + V[2] * p[1]]));
  let kind = 'Sloped surface';
  if (vertical) kind = 'Wall'; else if (horizontal) kind = c[2] > zRef + 1.8 ? 'Ceiling / soffit' : 'Floor / slab';
  return { kind, normal: n, centroid: c, area: o.area, ext: [a1 - a0, b1 - b0], loops: loops3, rms: pl.rms, level: horizontal ? c[2] : null };
}

// ---------- circle fit ----------
function fitCircle(xs, ys, m) {
  let mx = 0, my = 0; for (let i = 0; i < m; i++) { mx += xs[i]; my += ys[i]; } mx /= m; my /= m;
  // Kasa
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (let i = 0; i < m; i++) { const u = xs[i] - mx, v = ys[i] - my; suu += u * u; svv += v * v; suv += u * v; suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u; }
  const det = suu * svv - suv * suv; let cx = mx, cy = my, r;
  if (Math.abs(det) > 1e-18) { const b1 = 0.5 * (suuu + suvv), b2 = 0.5 * (svvv + svuu); cx = mx + (b1 * svv - b2 * suv) / det; cy = my + (b2 * suu - b1 * suv) / det; }
  r = 0; for (let i = 0; i < m; i++) r += Math.hypot(xs[i] - cx, ys[i] - cy); r /= m;
  // Gauss-Newton geometric refinement
  for (let it = 0; it < 15; it++) {
    let J00 = 0, J01 = 0, J02 = 0, J11 = 0, J12 = 0, J22 = 0, g0 = 0, g1 = 0, g2 = 0;
    for (let i = 0; i < m; i++) {
      const dx = cx - xs[i], dy = cy - ys[i], d = Math.hypot(dx, dy) || 1e-12, res = d - r, a = dx / d, b = dy / d;
      J00 += a * a; J01 += a * b; J02 -= a; J11 += b * b; J12 -= b; J22 += 1; g0 += a * res; g1 += b * res; g2 -= res;
    }
    const A = [J00, J01, J02, J01, J11, J12, J02, J12, J22], g = [g0, g1, g2];
    const s = solve3(A, g); if (!s) break; cx -= s[0]; cy -= s[1]; r -= s[2];
    if (Math.abs(s[0]) + Math.abs(s[1]) + Math.abs(s[2]) < 1e-9) break;
  }
  let ss = 0; for (let i = 0; i < m; i++) { const e = Math.hypot(xs[i] - cx, ys[i] - cy) - r; ss += e * e; }
  return { cx, cy, r: Math.abs(r), rms: Math.sqrt(ss / m) };
}
function solve3(A, b) {
  const [a, b1, c, d, e, f, g, h, i] = A; const det = a * (e * i - f * h) - b1 * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-24) return null;
  return [(b[0] * (e * i - f * h) - b1 * (b[1] * i - f * b[2]) + c * (b[1] * h - e * b[2])) / det,
    (a * (b[1] * i - f * b[2]) - b[0] * (d * i - f * g) + c * (d * b[2] - b[1] * g)) / det,
    (a * (e * b[2] - b[1] * h) - b1 * (d * b[2] - b[1] * g) + b[0] * (d * h - e * g)) / det];
}
function arcCoverage(xs, ys, m, cx, cy) { const bins = new Uint8Array(36); for (let i = 0; i < m; i++) { let a = Math.atan2(ys[i] - cy, xs[i] - cx); bins[Math.min(35, Math.floor((a + Math.PI) / (2 * Math.PI) * 36))] = 1; } let c = 0; for (const b of bins) c += b; return c * 10; }

// ---------- catalogues ----------
const PIPE_OD = [[15, 21.3], [20, 26.7], [25, 33.4], [32, 42.2], [40, 48.3], [50, 60.3], [65, 73.0], [80, 88.9], [100, 114.3], [125, 141.3], [150, 168.3], [200, 219.1], [250, 273.0], [300, 323.8], [350, 355.6], [400, 406.4], [450, 457.0], [500, 508.0], [600, 610.0], [750, 762.0], [900, 914.0], [1050, 1067.0], [1200, 1219.0]];
function matchPipe(odMM) { let best = null, be = Infinity; for (const [dn, od] of PIPE_OD) { const e = Math.abs(od - odMM) / od; if (e < be) { be = e; best = { dn, od }; } } return be < 0.06 ? best : null; }
// AS/NZS 3679.1 sections (d, bf, tf, tw in mm) — nearest-size guide only, verify on site
const STEEL = {
  UB: [['610UB125', 612, 229, 19.6, 11.9], ['610UB113', 607, 228, 17.3, 11.2], ['610UB101', 602, 228, 14.8, 10.6], ['530UB92.4', 533, 209, 15.6, 10.2], ['530UB82.0', 528, 209, 13.2, 9.6], ['460UB82.1', 460, 191, 16.0, 9.9], ['460UB74.6', 457, 190, 14.5, 9.1], ['460UB67.1', 454, 190, 12.7, 8.5], ['410UB59.7', 406, 178, 12.8, 7.8], ['410UB53.7', 403, 178, 10.9, 7.6], ['360UB56.7', 359, 172, 13.0, 8.0], ['360UB50.7', 356, 171, 11.5, 7.3], ['360UB44.7', 352, 171, 9.7, 6.9], ['310UB46.2', 307, 166, 11.8, 6.7], ['310UB40.4', 304, 165, 10.2, 6.1], ['310UB32.0', 298, 149, 8.0, 5.5], ['250UB37.3', 256, 146, 10.9, 6.4], ['250UB31.4', 252, 146, 8.6, 6.1], ['250UB25.7', 248, 124, 8.0, 5.0], ['200UB29.8', 207, 134, 9.6, 6.3], ['200UB25.4', 203, 133, 7.8, 5.8], ['200UB22.3', 202, 133, 7.0, 5.0], ['200UB18.2', 198, 99, 7.0, 4.5], ['180UB22.2', 179, 90, 10.0, 6.0], ['180UB18.1', 175, 90, 8.0, 5.0], ['180UB16.1', 173, 90, 7.0, 4.5], ['150UB18.0', 155, 75, 9.5, 6.0], ['150UB14.0', 150, 75, 7.0, 5.0]],
  UC: [['310UC158', 327, 311, 25.0, 15.7], ['310UC137', 321, 309, 21.7, 13.8], ['310UC118', 315, 307, 18.7, 11.9], ['310UC96.8', 308, 305, 15.4, 9.9], ['250UC89.5', 260, 256, 17.3, 10.5], ['250UC72.9', 254, 254, 14.2, 8.6], ['200UC59.5', 210, 205, 14.2, 9.3], ['200UC52.2', 206, 204, 12.5, 8.0], ['200UC46.2', 203, 203, 11.0, 7.3], ['150UC37.2', 162, 154, 11.5, 8.1], ['150UC30.0', 158, 153, 9.4, 6.6], ['150UC23.4', 152, 152, 6.8, 6.1], ['100UC14.8', 97, 99, 7.0, 5.0]],
  PFC: [['380PFC', 380, 100, 17.5, 10.0], ['300PFC', 300, 90, 16.0, 8.0], ['250PFC', 250, 90, 15.0, 8.0], ['230PFC', 230, 75, 12.0, 6.5], ['200PFC', 200, 75, 12.0, 6.0], ['180PFC', 180, 75, 11.0, 6.0], ['150PFC', 150, 75, 9.5, 6.0], ['125PFC', 125, 65, 7.5, 4.7], ['100PFC', 100, 50, 6.7, 4.2], ['75PFC', 75, 40, 6.1, 3.8]]
};
const HOLLOW = [50, 65, 75, 89, 100, 125, 150, 200, 250, 300, 350, 400];
function matchSteel(fam, dMM, bMM) {
  let best = null, be = Infinity;
  const err = s => { const ed = (dMM - s[1]) / s[1], eb = (bMM - s[2]) / s[2]; return Math.hypot(ed < 0 ? ed * 2.5 : ed, (eb < 0 ? eb * 2.5 : eb) * 0.7); };   // reading small is less likely than reading large
  for (const f of fam) for (const s of STEEL[f]) { const e = err(s); if (e < be) { be = e; best = { name: s[0], d: s[1], bf: s[2], tf: s[3], tw: s[4], fam: f }; } }
  if (be >= 0.14) return null;
  const alts = []; for (const f of fam) for (const s of STEEL[f]) { const e = err(s); if (s[0] !== best.name && e < be + 0.035) alts.push(s[0]); }
  return Object.assign(best, { err: be, alts });
}
const nearestHollow = v => HOLLOW.reduce((a, b) => Math.abs(b - v) < Math.abs(a - v) ? b : a);

// ---------- section classification ----------
// s,t: 2D coords of member points in its section frame. returns {shape, W, H, cs, ct, rot, ...}
function classifySection(s, t, m) {
  const sortedPct = (arr, p) => { const a = Float64Array.from(arr.subarray ? arr.subarray(0, m) : arr.slice(0, m)).sort(); return [a[Math.floor(p * (m - 1))], a[Math.floor((1 - p) * (m - 1))]]; };
  const [s0, s1] = sortedPct(s, 0.005), [t0, t1] = sortedPct(t, 0.005);
  const W = Math.max(1e-3, s1 - s0), H = Math.max(1e-3, t1 - t0);
  const tf = 0.2, tw = 0.12;
  const T = {
    'I|': (a, b) => b < tf || b > 1 - tf || Math.abs(a - 0.5) < tw,   // flanges top/bottom (along s), web vertical
    'I-': (a, b) => a < tf || a > 1 - tf || Math.abs(b - 0.5) < tw,   // rotated 90°
    'C0': (a, b) => a < tf || b < tf || b > 1 - tf, 'C1': (a, b) => a > 1 - tf || b < tf || b > 1 - tf,
    'C2': (a, b) => b < tf || a < tf || a > 1 - tf, 'C3': (a, b) => b > 1 - tf || a < tf || a > 1 - tf,
    'L0': (a, b) => a < tf || b < tf, 'L1': (a, b) => a > 1 - tf || b < tf, 'L2': (a, b) => a < tf || b > 1 - tf, 'L3': (a, b) => a > 1 - tf || b > 1 - tf,
    'BOX': (a, b) => a < tf || a > 1 - tf || b < tf || b > 1 - tf
  };
  const AREA = { 'I|': 2 * tf + (1 - 2 * tf) * 2 * tw, 'I-': 2 * tf + (1 - 2 * tf) * 2 * tw, C: 1 - (1 - tf) * (1 - 2 * tf), L: 1 - (1 - tf) * (1 - tf), BOX: 1 - (1 - 2 * tf) ** 2 };
  const scores = {};
  for (const key in T) {
    let inn = 0, f = T[key];
    for (let i = 0; i < m; i++) { const a = (s[i] - s0) / W, b = (t[i] - t0) / H; if (a < -0.05 || a > 1.05 || b < -0.05 || b > 1.05) continue; if (f(a, b)) inn++; }
    // coverage: how much of the template's material is actually observed (coarse 10x10)
    const occ = new Uint8Array(100); for (let i = 0; i < m; i++) { const a = (s[i] - s0) / W, b = (t[i] - t0) / H; if (a < 0 || a >= 1 || b < 0 || b >= 1) continue; occ[Math.floor(b * 10) * 10 + Math.floor(a * 10)] = 1; }
    let mat = 0, seen = 0; for (let j = 0; j < 10; j++) for (let i = 0; i < 10; i++) if (f((i + 0.5) / 10, (j + 0.5) / 10)) { mat++; seen += occ[j * 10 + i]; }
    const area = AREA[key[0] === 'I' ? key : key === 'BOX' ? 'BOX' : key[0]];
    scores[key] = { prec: inn / m, cov: seen / mat, score: inn / m - 0.25 * area + 0.15 * (seen / mat) };
  }
  let best = null; for (const k in scores) if (!best || scores[k].score > scores[best].score) best = k;
  const sc = scores[best];
  let shape = sc.prec > 0.85 ? (best[0] === 'I' ? 'I' : best === 'BOX' ? 'BOX' : best[0]) : 'PRISM';
  // I needs the web: if web band nearly empty it's really two plates (channel-like or box); keep I only with web coverage
  // flange width from the free flange: a deck plate, grating or kick-plate welded to one flange must not widen the section
  let W2 = W, H2 = H, S0 = s0, S1 = s1, T0 = t0, T1 = t1, plate = false;
  if (shape === 'I' || shape === 'C') {
    const along = best === 'I|' || best === 'C0' || best === 'C1';   // flanges run along s, depth along t
    const ext = (sel, val) => { const v = []; for (let i = 0; i < m; i++) if (sel(i)) v.push(val(i)); if (v.length < 12) return null; v.sort((x, y) => x - y); return [v[Math.floor(v.length * 0.02)], v[Math.floor(v.length * 0.98)], v.length]; };
    const A = along ? i => (t[i] - t0) / H : i => (s[i] - s0) / W, val = along ? i => s[i] : i => t[i];
    const lo = ext(i => A(i) < 0.12, val), hi = ext(i => A(i) > 0.88, val);
    if (lo && hi) { const wl = lo[1] - lo[0], wh = hi[1] - hi[0], nar = wl < wh ? lo : hi, wid = Math.max(wl, wh), nw = Math.min(wl, wh); if (wid > nw * 1.2 && nw > 0.03) { plate = true; if (along) { W2 = nw; S0 = nar[0]; S1 = nar[1]; } else { H2 = nw; T0 = nar[0]; T1 = nar[1]; } } }
    // depth between the outer flange faces, less sensitive to stray points than the full extent
    const dv = ext(i => { const q = along ? s[i] : t[i]; return q >= (along ? S0 : T0) && q <= (along ? S1 : T1); }, along ? i => t[i] : i => s[i]);
    if (dv) {
      // flange faces show as peaks along the depth; a kick-plate or stiffener standing past a flange does not
      let d0 = dv[0], d1 = dv[1]; const bw = 0.004, nb = Math.max(4, Math.ceil((d1 - d0) / bw) + 1), hist = new Float32Array(nb); const inW = along ? i => s[i] >= S0 && s[i] <= S1 : i => t[i] >= T0 && t[i] <= T1, dc = along ? i => t[i] : i => s[i];
      for (let i = 0; i < m; i++) if (inW(i)) { const k = Math.floor((dc(i) - d0) / bw); if (k >= 0 && k < nb) hist[k]++; }
      const sm = new Float32Array(nb); for (let k = 0; k < nb; k++) sm[k] = (hist[k - 1] || 0) + hist[k] + (hist[k + 1] || 0); let mx = 0; for (const v of sm) if (v > mx) mx = v;
      const peaks = []; for (let k = 0; k < nb; k++) if (sm[k] >= mx * 0.3 && sm[k] >= (sm[k - 1] || 0) && sm[k] >= (sm[k + 1] || 0)) peaks.push(k);
      if (peaks.length >= 2) { const p0 = d0 + (peaks[0] + 0.5) * bw - bw, p1 = d0 + (peaks[peaks.length - 1] + 0.5) * bw + bw; if (p1 - p0 > (d1 - d0) * 0.55) { d0 = Math.max(d0, p0); d1 = Math.min(d1, p1); } }
      if (along) { T0 = d0; T1 = d1; H2 = T1 - T0; } else { S0 = d0; S1 = d1; W2 = S1 - S0; }
    }
  }
  return { shape, key: best, W: W2, H: H2, s0: S0, s1: S1, t0: T0, t1: T1, cs: (S0 + S1) / 2, ct: (T0 + T1) / 2, prec: sc.prec, cov: sc.cov, plate, Wfull: W, Hfull: H };
}

// ---------- member growth from a seed ----------
function normalsAxis(nrm, idx, m) {
  let a00 = 0, a01 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0;
  for (let j = 0; j < m; j++) { const i = idx[j] * 3, x = nrm[i], y = nrm[i + 1], z = nrm[i + 2]; a00 += x * x; a01 += x * y; a02 += x * z; a11 += y * y; a12 += y * z; a22 += z * z; }
  const e = eig3(a00 / m, a01 / m, a02 / m, a11 / m, a12 / m, a22 / m);
  return { axis: e.v0, l: e.l, major: e.v2 };
}
function fitMember(ctx, idx, axisGuess, opts) {
  const { P, nrm } = ctx; const m = idx.length;
  let ax = axisGuess || normalsAxis(nrm, idx, m).axis;
  const fr0 = normalsAxis(nrm, idx, m);
  let { u, v } = perpFrame(ax, fr0.major);
  let c3 = [0, 0, 0]; for (const i of idx) { c3[0] += P[i * 3]; c3[1] += P[i * 3 + 1]; c3[2] += P[i * 3 + 2]; } c3 = c3.map(x => x / m);
  const s = new Float64Array(m), t = new Float64Array(m), a = new Float64Array(m);
  const proj = () => { for (let j = 0; j < m; j++) { const i = idx[j] * 3, d = [P[i] - c3[0], P[i + 1] - c3[1], P[i + 2] - c3[2]]; s[j] = dot(d, u); t[j] = dot(d, v); a[j] = dot(d, ax); } };
  proj();
  // circle test
  let circ = fitCircle(s, t, m), isPipe = false;
  // robust: trim outliers and refit (contamination from touching objects)
  for (let it = 0; it < 2; it++) {
    const res = new Float64Array(m); for (let j = 0; j < m; j++) res[j] = Math.abs(Math.hypot(s[j] - circ.cx, t[j] - circ.cy) - circ.r);
    const srt = Float64Array.from(res).sort(); const thr = Math.max(0.004, srt[Math.floor(m * 0.5)] * 3);
    const xs = [], ys = []; for (let j = 0; j < m; j++) if (res[j] <= thr) { xs.push(s[j]); ys.push(t[j]); }
    if (xs.length < m * 0.6 || xs.length < 20) break;
    const c2 = fitCircle(xs, ys, xs.length); c2.inl = xs.length / m; circ = c2;
  }
  if (circ.inl === undefined) circ.inl = 1;
  const cov = arcCoverage(s, t, m, circ.cx, circ.cy);
  let radial = 0, rc = 0;
  if (circ.r >= opts.minR && circ.r <= opts.maxR) { for (let j = 0; j < m; j++) { const i = idx[j] * 3, ds = s[j] - circ.cx, dt = t[j] - circ.cy, l = Math.hypot(ds, dt) || 1; if (Math.abs(l - circ.r) > Math.max(0.004, circ.r * 0.15)) continue; const ns = nrm[i] * u[0] + nrm[i + 1] * u[1] + nrm[i + 2] * u[2], nt = nrm[i] * v[0] + nrm[i + 1] * v[1] + nrm[i + 2] * v[2]; radial += Math.abs((ns * ds + nt * dt) / l); rc++; } radial /= Math.max(1, rc); }
  const okR = circ.r >= opts.minR && circ.r <= opts.maxR;
  if (opts.force !== 'steel' && (opts.force === 'pipe' ? okR && circ.inl >= 0.4 : okR && circ.rms < Math.max(0.003, circ.r * 0.05) && circ.inl >= 0.7 && cov >= 100 && radial > 0.8)) {
    isPipe = true;
    // refine axis: circle centres of two halves
    for (let it = 0; it < 3; it++) {
      let amin = Infinity, amax = -Infinity; for (let j = 0; j < m; j++) { amin = Math.min(amin, a[j]); amax = Math.max(amax, a[j]); }
      const mid = (amin + amax) / 2; if (amax - amin < 4 * circ.r) break;
      const half = side => { const xs = [], ys = [], as = []; for (let j = 0; j < m; j++) if ((a[j] < mid) === side) { xs.push(s[j]); ys.push(t[j]); as.push(a[j]); } const f = fitCircle(xs, ys, xs.length); return { f, am: as.reduce((x, y) => x + y, 0) / as.length }; };
      const h0 = half(true), h1 = half(false);
      const p0 = add(add(add(c3, u, h0.f.cx), v, h0.f.cy), ax, h0.am), p1 = add(add(add(c3, u, h1.f.cx), v, h1.f.cy), ax, h1.am);
      const nax = norm([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]);
      const fr = perpFrame(nax, u); ax = nax; u = fr.u; v = fr.v; proj(); circ = fitCircle(s, t, m);
    }
  }
  let amin = Infinity, amax = -Infinity; for (let j = 0; j < m; j++) { amin = Math.min(amin, a[j]); amax = Math.max(amax, a[j]); }
  if (isPipe) {
    const cen = add(add(c3, u, circ.cx), v, circ.cy);
    return { type: 'pipe', axis: ax, u, v, p0: add(cen, ax, amin), p1: add(cen, ax, amax), r: circ.r, rms: circ.rms, cover: cov, length: amax - amin, n: m };
  }
  // refine a prismatic member's axis: line through the section centres of its two halves
  for (let it = 0; it < 3; it++) {
    let amin = Infinity, amax = -Infinity; for (let j = 0; j < m; j++) { amin = Math.min(amin, a[j]); amax = Math.max(amax, a[j]); }
    if (amax - amin < 0.6) break; const mid = (amin + amax) / 2;
    const ctr = side => { const ss = [], ts = [], as = []; for (let j = 0; j < m; j++) if ((a[j] < mid) === side) { ss.push(s[j]); ts.push(t[j]); as.push(a[j]); }
      const q = (arr, p) => { const x = Float64Array.from(arr).sort(); return x[Math.floor(p * (x.length - 1))]; };
      return [(q(ss, 0.02) + q(ss, 0.98)) / 2, (q(ts, 0.02) + q(ts, 0.98)) / 2, as.reduce((x, y) => x + y, 0) / as.length]; };
    const h0 = ctr(true), h1 = ctr(false);
    const p0 = add(add(add(c3, u, h0[0]), v, h0[1]), ax, h0[2]), p1 = add(add(add(c3, u, h1[0]), v, h1[1]), ax, h1[2]);
    const nax = norm([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]); if (dot(nax, ax) > 0.99999) break;
    const fr = perpFrame(nax, u); ax = nax; u = fr.u; v = fr.v; proj();
  }
  // rotate the section frame to the minimum-area box
  {
    const sub = []; const stp = Math.max(1, Math.floor(m / 3000)); for (let j = 0; j < m; j += stp) sub.push(j);
    const area = th => { const c = Math.cos(th), sn = Math.sin(th); const A = new Float64Array(sub.length), B = new Float64Array(sub.length);
      sub.forEach((j, q) => { A[q] = c * s[j] + sn * t[j]; B[q] = -sn * s[j] + c * t[j]; }); A.sort(); B.sort(); const lo = Math.floor(sub.length * 0.01), hi = Math.floor(sub.length * 0.99);
      return (A[hi] - A[lo]) * (B[hi] - B[lo]); };
    let best = 0, ba = area(0);
    for (let d = -45; d <= 45; d += 1.5) { const ar = area(d * Math.PI / 180); if (ar < ba) { ba = ar; best = d * Math.PI / 180; } }
    for (let d = -1.5; d <= 1.5; d += 0.1) { const th = best + d * Math.PI / 180, ar = area(th); if (ar < ba) { ba = ar; best = th; } }
    if (best) { const c = Math.cos(best), sn = Math.sin(best); const nu = norm(add(u.map(x => x * c), v, sn)), nv = norm(cross(ax, nu)); u = nu; v = nv; proj(); }
  }
  const keep = []; for (let j = 0; j < m; j++) { const i = idx[j] * 3; if (Math.abs(nrm[i] * ax[0] + nrm[i + 1] * ax[1] + nrm[i + 2] * ax[2]) < 0.15) keep.push(j); }
  const ss = new Float64Array(keep.length), tt = new Float64Array(keep.length); keep.forEach((j, q) => { ss[q] = s[j]; tt[q] = t[j]; });
  const sec = keep.length > 30 ? classifySection(ss, tt, keep.length) : classifySection(s, t, m);
  if (opts.shape && sec.shape !== opts.shape) { sec.shape = opts.shape; sec.key = opts.shape === 'I' ? (sec.H >= sec.W ? 'I|' : 'I-') : opts.shape === 'C' ? (sec.H >= sec.W ? 'C0' : 'C2') : sec.key; sec.forced = true; }   // the user said what it is
  const cen = add(add(c3, u, sec.cs), v, sec.ct);
  return { type: 'steel', axis: ax, u, v, p0: add(cen, ax, amin), p1: add(cen, ax, amax), sec, length: amax - amin, n: m };
}
function describeSteel(M) {
  const sec = M.sec; let W = sec.W * 1000, H = sec.H * 1000; let label, dims, fam = null;
  // orient so that depth is across the flanges
  if (sec.shape === 'I') {
    const d = sec.key === 'I|' ? H : W, b = sec.key === 'I|' ? W : H;
    const cat = matchSteel(d / b > 1.3 ? ['UB'] : ['UC', 'UB'], d, b);
    dims = cat ? { d: cat.d, bf: cat.bf, tf: cat.tf, tw: cat.tw } : { d, bf: b, tf: Math.max(6, d * 0.04), tw: Math.max(5, d * 0.025) };
    label = cat ? cat.name + (cat.alts.length ? ' (or ' + cat.alts.slice(0, 2).join(', ') + ')' : '') : 'I-section ' + Math.round(d) + '×' + Math.round(b); fam = cat ? cat.fam : 'I';
  } else if (sec.shape === 'C') {
    const webAlongT = sec.key === 'C0' || sec.key === 'C1'; const d = webAlongT ? H : W, b = webAlongT ? W : H;
    let cat = matchSteel(['PFC'], d, b); if (!cat) { const c2 = STEEL.PFC.map(q => [Math.abs(d - q[1]) / q[1], q]).sort((x, y) => x[0] - y[0])[0]; if (c2[0] < 0.05 && b > c2[1][2] * 0.6 && b < c2[1][2] * 2.3) cat = { name: c2[1][0], d: c2[1][1], bf: c2[1][2], tf: c2[1][3], tw: c2[1][4], fam: 'PFC', alts: [] }; } dims = cat ? { d: cat.d, bf: cat.bf, tf: cat.tf, tw: cat.tw } : { d, bf: b, tf: Math.max(6, d * 0.05), tw: Math.max(5, d * 0.03) };
    label = cat ? cat.name : 'Channel ' + Math.round(d) + '×' + Math.round(b); fam = 'PFC';
  } else if (sec.shape === 'L') { dims = { d: H, bf: W, t: Math.max(5, Math.min(W, H) * 0.08) }; label = 'Angle ' + Math.round(Math.max(W, H)) + '×' + Math.round(Math.min(W, H)); }
  else if (sec.shape === 'BOX') { const a = nearestHollow(Math.max(W, H)), b = nearestHollow(Math.min(W, H)); dims = { d: H, bf: W, t: Math.max(3, Math.min(W, H) * 0.05) }; label = (Math.abs(a - b) < 1 ? 'SHS ' : 'RHS ') + a + '×' + b + ' (approx)'; }
  else { dims = { d: H, bf: W }; label = 'Member ' + Math.round(W) + '×' + Math.round(H); }
  M.label = label; M.dims = dims; M.family = fam; return M;
}

async function detectMembers(ctx, opts, onP = () => {}) {
  const { P, n, nrm, K, used } = ctx;
  const tried = new Uint8Array(n); const out = [];
  const r0 = opts.seedRadius || Math.max(0.15, Math.min(0.5, opts.maxR * 1.6));
  const order = []; for (let i = 0; i < n; i++) if (!used[i]) order.push(i);
  let seed = 9; for (let i = order.length - 1; i > 0; i--) { seed = (seed * 16807) % 2147483647; const j = seed % (i + 1); const t = order[i]; order[i] = order[j]; order[j] = t; }
  let attempts = 0; const maxAttempts = opts.maxAttempts || (opts.only === 'pipe' ? 12000 : 4000); const buf = [];
  for (let oi = 0; oi < order.length && attempts < maxAttempts; oi++) {
    const sI = order[oi]; if (used[sI] || tried[sI]) continue; attempts++;
    // pipes: try small neighbourhoods first, so a pipe on a crowded rack is seen on its own before its neighbours get in the way
    const radii = opts.only === 'pipe' ? (opts.seedRadii || [0.07, 0.12, 0.2, 0.35]).filter(r => r < r0).concat([r0]) : [r0];
    let M = null, local = null, rUsed = radii[0];
    for (const rs of radii) {
      buf.length = 0; kdRadius(K, P[sI * 3], P[sI * 3 + 1], P[sI * 3 + 2], rs, buf); local = buf.filter(i => !used[i]); rUsed = rs;
      if (local.length < 30) continue;
      const NA = normalsAxis(nrm, local, local.length);
      if (!(NA.l[1] > 0.06 * NA.l[2] && NA.l[0] < 0.35 * NA.l[1])) continue;
      const m = growMember(ctx, local, NA.axis, opts, rs);
      if (m && (!opts.only || m.type === opts.only)) { M = m; break; }
    }
    const markTried = () => { const rt = radii[0]; buf.length = 0; kdRadius(K, P[sI * 3], P[sI * 3 + 1], P[sI * 3 + 2], rt * 0.6, buf); for (const i of buf) tried[i] = 1; tried[sI] = 1; };
    if (!M) { markTried(); continue; }
    out.push(M); for (const i of M.idx) used[i] = 1;
    if (out.length % 3 === 0) { onP(oi / order.length); await tickC(); }
    if ((attempts & 63) === 0) { onP(oi / order.length); await tickC(); }
  }
  return out;
}
function growMember(ctx, local, axis, opts, r0) {
  const { P, nrm, K, used } = ctx;
  let first = fitMember(ctx, local, axis, opts);
  if (!first || (opts.only === 'pipe' && first.type !== 'pipe')) return null;   // pipe pass: do not grow something that is not round
  // section half-size for corridor
  let rad;
  if (first.type === 'pipe') rad = first.r * 1.25 + 0.01;
  else rad = Math.hypot(first.sec.Wfull || first.sec.W, first.sec.Hfull || first.sec.H) / 2 * 1.05 + 0.01;
  if (rad > Math.max(opts.maxR * 1.4, opts.maxSection || 0.7)) return null;
  const ax = first.axis; const cen = [(first.p0[0] + first.p1[0]) / 2, (first.p0[1] + first.p1[1]) / 2, (first.p0[2] + first.p1[2]) / 2];
  const step = Math.max(0.1, rad), maxGap = opts.maxGap || 0.5;
  const member = new Set(); const buf = [];
  const nTol = 0.35;
  const collect = tC => {
    const c = add(cen, ax, tC); buf.length = 0; kdRadius(K, c[0], c[1], c[2], Math.hypot(rad, step / 2), buf); let cnt = 0;
    for (const i of buf) {
      if (used[i] || member.has(i)) continue;
      const d = [P[i * 3] - cen[0], P[i * 3 + 1] - cen[1], P[i * 3 + 2] - cen[2]], ta = dot(d, ax);
      if (Math.abs(ta - tC) > step / 2) continue;
      const rx = d[0] - ax[0] * ta, ry = d[1] - ax[1] * ta, rz = d[2] - ax[2] * ta;
      if (rx * rx + ry * ry + rz * rz > rad * rad) continue;
      if (Math.abs(nrm[i * 3] * ax[0] + nrm[i * 3 + 1] * ax[1] + nrm[i * 3 + 2] * ax[2]) > nTol) continue;
      if (first.type === 'pipe') { const rr = Math.sqrt(rx * rx + ry * ry + rz * rz); if (Math.abs(rr - first.r) > Math.max(0.01, first.r * 0.2)) continue; }
      member.add(i); cnt++;
    }
    return cnt;
  };
  const minSlice = 6;
  collect(0);
  for (const dir of [1, -1]) {
    let gap = 0;
    for (let k = 1; k < 10000; k++) { const c = collect(dir * k * step); if (c < minSlice) { gap += step; if (gap > maxGap) break; } else gap = 0; }
  }
  if (member.size < 40) return null;
  const idx = Uint32Array.from(member);
  const M = fitMember(ctx, idx, null, opts);
  const secSize = M.type === 'pipe' ? 2 * M.r : Math.max(M.sec.W, M.sec.H);
  if (M.length < Math.max(opts.minLen || 0.3, secSize * 1.5)) return null;
  if (M.type === 'steel' && ctx.curv && !opts.keepPrisms) { let flat = 0; for (const i of idx) if (ctx.curv[i] < 0.012) flat++; M.flat = flat / idx.length; if (M.flat < (opts.minFlat || 0)) return null; }
  if (M.type === 'steel' && !opts.keepPrisms && !sectionConsistent(ctx, idx, M)) return null;
  if (M.type === 'steel' && !opts.keepOddSections) { const a_ = Math.max(M.sec.W, M.sec.H), b_ = Math.min(M.sec.W, M.sec.H), sh = M.sec.shape; if ((sh === 'C' && (b_ > 0.2 || b_ > a_ * 0.6)) || (sh === 'L' && a_ > 0.26) || (sh === 'I' && (b_ < a_ * 0.22 || a_ > 1.0))) return null; }
  if (M.type === 'steel') { if (M.sec.shape === 'PRISM' && !opts.keepPrisms) return null; if (Math.max(M.sec.W, M.sec.H) > (opts.maxSection || 0.7)) return null; describeSteel(M); }
  else {
    const ax2 = M.axis, base = M.p0, keepI = [];
    for (const i of idx) { const d = [P[i * 3] - base[0], P[i * 3 + 1] - base[1], P[i * 3 + 2] - base[2]], ta = dot(d, ax2); const rx = d[0] - ax2[0] * ta, ry = d[1] - ax2[1] * ta, rz = d[2] - ax2[2] * ta; if (Math.abs(Math.sqrt(rx * rx + ry * ry + rz * rz) - M.r) <= Math.max(0.006, M.r * 0.12)) keepI.push(i); }
    M.idx = Uint32Array.from(keepI);
    let amin = Infinity, amax = -Infinity; for (const i of keepI) { const ta = (P[i * 3] - base[0]) * ax2[0] + (P[i * 3 + 1] - base[1]) * ax2[1] + (P[i * 3 + 2] - base[2]) * ax2[2]; amin = Math.min(amin, ta); amax = Math.max(amax, ta); }
    if (keepI.length > 20) { M.p1 = add(base, ax2, amax); M.p0 = add(base, ax2, amin); M.length = amax - amin; }
    const od = M.r * 2000; const mt = matchPipe(od); M.dn = mt ? mt.dn : null; M.odNominal = mt ? mt.od : null; M.label = (mt ? 'DN' + mt.dn + ' ' : '') + 'Ø' + od.toFixed(0) + ' mm'; }
  if (!M.idx) M.idx = idx; M.dir = Math.abs(M.axis[2]) > 0.98 ? 'vertical' : Math.abs(M.axis[2]) < 0.02 ? 'horizontal' : 'sloped';
  return M;
}

function sectionConsistent(ctx, idx, M) {
  const { P } = ctx; const parts = [[], [], []]; const L = M.length || 1;
  for (const i of idx) { const d = [P[i * 3] - M.p0[0], P[i * 3 + 1] - M.p0[1], P[i * 3 + 2] - M.p0[2]]; const ta = dot(d, M.axis); const k = Math.min(2, Math.max(0, Math.floor(ta / L * 3))); parts[k].push([dot(d, M.u), dot(d, M.v)]); }
  const q = (arr, p) => arr[Math.floor(p * (arr.length - 1))];
  for (const pt of parts) {
    if (pt.length < 15) return false;
    const a = pt.map(x => x[0]).sort((x, y) => x - y), b = pt.map(x => x[1]).sort((x, y) => x - y);
    const w = q(a, 0.98) - q(a, 0.02), h = q(b, 0.98) - q(b, 0.02);
    const FW = M.sec.Wfull || M.sec.W, FH = M.sec.Hfull || M.sec.H; if (w > FW * 1.25 + 0.01 || h > FH * 1.25 + 0.01 || w < FW * 0.6 - 0.01 || h < FH * 0.6 - 0.01) return false;
  }
  return true;
}
// flanges / fittings along a pipe
function detectFlanges(ctx, pipe) {
  const { P, K } = ctx; const ax = pipe.axis, r = pipe.r, p0 = pipe.p0, L = pipe.length;
  const ext = Math.max(0.15, r * 2), Rmax = r * 2.4 + 0.04, bin = Math.max(0.005, r * 0.08);
  const nb = Math.ceil((L + 2 * ext) / bin); const cnt = new Float32Array(nb), angs = Array.from({ length: nb }, () => new Uint8Array(12)), rmax = new Float32Array(nb), axv = [], secR = [];
  const buf = []; const { u, v } = perpFrame(ax);
  for (let t = -ext; t <= L + ext; t += Rmax) {
    const c = add(p0, ax, t); buf.length = 0; kdRadius(K, c[0], c[1], c[2], Math.hypot(Rmax, Rmax), buf);
    for (const i of buf) {
      const d = [P[i * 3] - p0[0], P[i * 3 + 1] - p0[1], P[i * 3 + 2] - p0[2]], ta = dot(d, ax);
      if (ta < t - Rmax / 2 || ta >= t + Rmax / 2 || ta < -ext || ta > L + ext) continue;
      const ru = dot(d, u), rv = dot(d, v), rr = Math.hypot(ru, rv);
      if (rr < r * 1.18 || rr > Rmax) continue;
      const b = Math.floor((ta + ext) / bin); if (b < 0 || b >= nb) continue;
      cnt[b]++; (axv[b] || (axv[b] = [])).push(ta); const sc = Math.min(11, Math.floor((Math.atan2(rv, ru) + Math.PI) / (2 * Math.PI) * 12)); angs[b][sc] = 1; if (rr > rmax[b]) rmax[b] = rr; const sr = secR[b] || (secR[b] = new Float32Array(12)); if (rr > sr[sc]) sr[sc] = rr;
    }
  }
  const good = new Uint8Array(nb); for (let b = 0; b < nb; b++) { let c = 0; for (const x of angs[b]) c += x; good[b] = cnt[b] >= 6 && c >= 4 ? 1 : 0; }
  const out = [];
  for (let b = 0; b < nb; b++) {
    if (!good[b]) continue; let e = b; while (e + 1 < nb && (good[e + 1] || (e + 2 < nb && good[e + 2]))) e++;
    let len = (e - b + 1) * bin; const rs = []; for (let k = b; k <= e; k++) if (rmax[k]) rs.push(rmax[k]); rs.sort((x, y) => x - y);
    const od = 2 * rs[Math.floor(rs.length * 0.9)] || 0; let tm = -ext + (b + e + 1) / 2 * bin;
    const av = []; for (let k = b; k <= e; k++) if (axv[k]) av.push(...axv[k]); av.sort((x, y) => x - y);
    if (av.length > 10) { const a5 = av[Math.floor(av.length * 0.04)], a95 = av[Math.floor(av.length * 0.96)]; tm = (a5 + a95) / 2; if (a95 - a5 > 0.004) len = Math.min(len, a95 - a5); }
    // roundness: outer radius per 30° sector over the whole run; a flange or valve body is centred on the pipe, a neighbour or a support is not
    const sm = new Float32Array(12); for (let k = b; k <= e; k++) if (secR[k]) for (let q = 0; q < 12; q++) if (secR[k][q] > sm[q]) sm[q] = secR[k][q];
    const sv = Array.from(sm).filter(x => x > 0); const mean = sv.reduce((x, y) => x + y, 0) / (sv.length || 1), sd = Math.sqrt(sv.reduce((x, y) => x + (y - mean) * (y - mean), 0) / (sv.length || 1));
    if (sv.length < 6 || sd / mean > 0.12 || od < r * 2 * 1.3) { b = e; continue; }
    if (len >= 0.008 && len <= Math.max(0.12, r * 1.2)) out.push({ type: 'flange', at: add(p0, ax, tm), axis: ax, od, thick: len, pipe });
    else if (len > Math.max(0.12, r * 1.2) && len < 1.5) out.push({ type: 'fitting', at: add(p0, ax, tm), axis: ax, od, thick: len, pipe });
    b = e;
  }
  return out;
}


// ---------- handrails: thin horizontal rails ~1.0–1.2 m above a deck, with mid rail and posts ----------
// decks: [{level, x0, x1, y0, y1}] in local coords. Returns [{level, a, b, height, midZ, posts:[[x,y]], length, rms, idx}]
function detectHandrails(ctx, decks, opts = {}) {
  const { P, n, used } = ctx; const out = [];
  const tubeTol = opts.tubeTol || 0.045, minLen = opts.minLen || 1.0;
  let seed = 4242; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (const D of decks) {
    const pad = 0.8, band = [], within = i => P[i * 3] > D.x0 - pad && P[i * 3] < D.x1 + pad && P[i * 3 + 1] > D.y0 - pad && P[i * 3 + 1] < D.y1 + pad;
    const lowBand = []; // 0.1–0.85 m: posts and mid rail
    for (let i = 0; i < n; i++) {
      if (used[i]) continue; const h = P[i * 3 + 2] - D.level; if (h < 0.1 || h > 1.35) continue; if (!within(i)) continue;
      if (h >= 0.85) band.push(i); else lowBand.push(i);
    }
    if (band.length < 30) continue;
    const free = new Uint8Array(band.length).fill(1); let fails = 0;
    for (let iter = 0; iter < 150 && fails < 60; iter++) {
      const live = []; for (let k = 0; k < band.length; k++) if (free[k]) live.push(k); if (live.length < 30) break;
      const sample = live.length > 4000 ? Array.from({ length: 4000 }, () => live[Math.floor(rnd() * live.length)]) : live;
      let best = null, bestScore = 0;
      for (let t = 0; t < 250; t++) {
        const a = band[sample[Math.floor(rnd() * sample.length)]], b = band[sample[Math.floor(rnd() * sample.length)]];
        const dx = P[b * 3] - P[a * 3], dy = P[b * 3 + 1] - P[a * 3 + 1], L = Math.hypot(dx, dy); if (L < 0.4 || L > 6) continue;
        if (Math.abs(P[b * 3 + 2] - P[a * 3 + 2]) > 0.06) continue;
        const ux = dx / L, uy = dy / L, z0 = (P[a * 3 + 2] + P[b * 3 + 2]) / 2; let sc = 0;
        for (const k of sample) { const i = band[k]; const ex = P[i * 3] - P[a * 3], ey = P[i * 3 + 1] - P[a * 3 + 1]; if (Math.abs(-ex * uy + ey * ux) < tubeTol && Math.abs(P[i * 3 + 2] - z0) < tubeTol) sc++; }
        if (sc > bestScore) { bestScore = sc; best = { ox: P[a * 3], oy: P[a * 3 + 1], ux, uy, z0 }; }
      }
      if (!best || bestScore < 12) { fails++; continue; }
      // all inliers, refine line by PCA in XY and z by median
      const inl = []; for (const k of live) { const i = band[k]; const ex = P[i * 3] - best.ox, ey = P[i * 3 + 1] - best.oy; if (Math.abs(-ex * best.uy + ey * best.ux) < tubeTol && Math.abs(P[i * 3 + 2] - best.z0) < tubeTol) inl.push(k); }
      let mx = 0, my = 0; for (const k of inl) { mx += P[band[k] * 3]; my += P[band[k] * 3 + 1]; } mx /= inl.length; my /= inl.length;
      let sxx = 0, sxy = 0, syy = 0; for (const k of inl) { const x = P[band[k] * 3] - mx, y = P[band[k] * 3 + 1] - my; sxx += x * x; sxy += x * y; syy += y * y; }
      const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(th), uy = Math.sin(th);
      const zs = inl.map(k => P[band[k] * 3 + 2]).sort((a, b) => a - b), zr = zs[zs.length >> 1];
      // split into runs along the line
      const along = inl.map(k => { const i = band[k]; return [(P[i * 3] - mx) * ux + (P[i * 3 + 1] - my) * uy, k]; }).sort((a, b) => a[0] - b[0]);
      let runs = [], cur = [along[0]];
      for (let q = 1; q < along.length; q++) { if (along[q][0] - along[q - 1][0] > 0.6) { runs.push(cur); cur = []; } cur.push(along[q]); }
      runs.push(cur);
      let accepted = 0;
      for (const run of runs) {
        const t0 = run[0][0], t1 = run[run.length - 1][0], len = t1 - t0;
        for (const [, k] of run) free[k] = 0;
        if (len < minLen || run.length / len < 12) continue;
        // tube check: rms distance from the 3D axis should be about the rail radius (not a big pipe)
        let ss = 0; for (const [, k] of run) { const i = band[k]; const d = -(P[i * 3] - mx) * uy + (P[i * 3 + 1] - my) * ux, dz = P[i * 3 + 2] - zr; ss += d * d + dz * dz; }
        const rms = Math.sqrt(ss / run.length); if (rms > 0.045) continue;
        // cross-section circle: a rail is a small tube (OD 30-70 mm) that fits a circle cleanly
        const ds = run.map(([, k]) => { const i = band[k]; return -(P[i * 3] - mx) * uy + (P[i * 3 + 1] - my) * ux; }), dzs = run.map(([, k]) => P[band[k] * 3 + 2] - zr);
        const cf = fitCircle(ds, dzs, ds.length);
        if (!(cf.r > 0.014 && cf.r < 0.036 && cf.rms < 0.006)) continue;
        const zc = zr + cf.cy, off = cf.cx;
        // isolation: a rail has free space around it; a strip of a larger pipe or plate does not
        { let ring = 0, core = 0; const pts = band.concat(lowBand); const ax0 = mx - uy * off, ay0 = my + ux * off;
          for (const i of pts) { const ex = P[i * 3] - ax0, ey = P[i * 3 + 1] - ay0, t = ex * ux + ey * uy; if (t < t0 || t > t1) continue; const d = Math.hypot(-ex * uy + ey * ux, P[i * 3 + 2] - zc); if (d < cf.r + 0.012) core++; else if (d < cf.r + 0.09) ring++; }
          if (ring > core * 0.25) continue; }
        const a = [mx + ux * t0 - uy * off, my + uy * t0 + ux * off, zc], b = [mx + ux * t1 - uy * off, my + uy * t1 + ux * off, zc];
        // mid rail and posts from the low band near this line
        let midZs = [], postBins = new Map(), idx = run.map(([, k]) => band[k]);
        for (const i of lowBand) {
          if (used[i]) continue; const ex = P[i * 3] - mx, ey = P[i * 3 + 1] - my, t = ex * ux + ey * uy; if (t < t0 - 0.1 || t > t1 + 0.1) continue;
          const d = Math.abs(-ex * uy + ey * ux); if (d > 0.08) continue; const h = P[i * 3 + 2] - D.level;
          if (h > 0.4 && h < 0.75 && d < tubeTol) midZs.push(P[i * 3 + 2]);
          const bin = Math.round(t / 0.05); postBins.set(bin, (postBins.get(bin) || 0) + 1); idx.push(i);
        }
        let midZ = null; const mids = midZs.filter(z => zc - z > 0.35 && zc - z < 0.75);
        if (mids.length > len * 8) { mids.sort((x, y) => x - y); midZ = mids[mids.length >> 1]; }
        if (midZ === null && !opts.allowNoMidRail) continue;
        // posts: bins with many points spread over the height (exclude the mid rail which fills every bin)
        const counts = [...postBins.entries()].sort((x, y) => x[0] - y[0]); const med = counts.map(c => c[1]).sort((x, y) => x - y)[counts.length >> 1] || 0;
        const posts = []; let blk = [];
        for (const [bin, c] of counts) { if (c > Math.max(6, med * 2.5)) blk.push(bin); else if (blk.length) { const m = blk.reduce((x, y) => x + y, 0) / blk.length * 0.05; if (blk.length <= 4) posts.push([mx + ux * m, my + uy * m]); blk = []; } }
        if (blk.length && blk.length <= 4) { const m = blk.reduce((x, y) => x + y, 0) / blk.length * 0.05; posts.push([mx + ux * m, my + uy * m]); }
        if (posts.length < Math.max(1, Math.floor(len / 2.5))) continue;   // real rails have posts at least every ~2 m
        out.push({ type: 'handrail', level: D.level, a, b, height: zc - D.level, midZ, posts, length: len, rms: cf.rms, od: cf.r * 2, idx: Uint32Array.from(idx), dir: [ux, uy] });
        accepted++;
      }
      if (!accepted) fails++; else fails = 0;
    }
  }
  // join corners: endpoints of rails on the same deck that meet at an angle -> snap to the intersection
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
    const A = out[i], B = out[j]; if (Math.abs(A.level - B.level) > 0.05) continue;
    const cr = A.dir[0] * B.dir[1] - A.dir[1] * B.dir[0]; if (Math.abs(cr) < 0.5) continue;
    const t = ((B.a[0] - A.a[0]) * B.dir[1] - (B.a[1] - A.a[1]) * B.dir[0]) / cr; const X = [A.a[0] + A.dir[0] * t, A.a[1] + A.dir[1] * t];
    for (const R of [A, B]) { const da = Math.hypot(R.a[0] - X[0], R.a[1] - X[1]), db = Math.hypot(R.b[0] - X[0], R.b[1] - X[1]); const e = da < db ? 'a' : 'b'; if (Math.min(da, db) < 0.6 && Math.max(da, db) > 0.8) { R[e] = [X[0], X[1], R[e][2]]; R.corner = true; } }
  }
  // merge collinear duplicates (same line found twice) and drop slivers
  for (let i = out.length - 1; i >= 0; i--) {
    const A = out[i]; if (Math.hypot(A.b[0] - A.a[0], A.b[1] - A.a[1]) < 0.5) { out.splice(i, 1); continue; }
    for (let j = 0; j < i; j++) { const B = out[j]; if (Math.abs(A.level - B.level) > 0.05 || Math.abs(A.a[2] - B.a[2]) > 0.08) continue; if (Math.abs(A.dir[0] * B.dir[1] - A.dir[1] * B.dir[0]) > 0.05) continue;
      const off = Math.abs(-(A.a[0] - B.a[0]) * B.dir[1] + (A.a[1] - B.a[1]) * B.dir[0]); if (off > 0.08) continue;
      const tA = [A.a, A.b].map(p => (p[0] - B.a[0]) * B.dir[0] + (p[1] - B.a[1]) * B.dir[1]), tB1 = (B.b[0] - B.a[0]) * B.dir[0] + (B.b[1] - B.a[1]) * B.dir[1];
      const lo = Math.min(0, tB1, ...tA), hi = Math.max(0, tB1, ...tA), ov = Math.min(Math.max(...tA), Math.max(0, tB1)) - Math.max(Math.min(...tA), Math.min(0, tB1)); if (ov < -0.6) continue;
      const z = B.a[2]; B.a = [B.a[0] + B.dir[0] * lo, B.a[1] + B.dir[1] * lo, z]; B.b = [B.a[0] + B.dir[0] * (hi - lo), B.a[1] + B.dir[1] * (hi - lo), z]; B.posts = B.posts.concat(A.posts); B.idx = Uint32Array.from([...B.idx, ...A.idx]); out.splice(i, 1); break; }
  }
  for (const R of out) { R.length = Math.hypot(R.b[0] - R.a[0], R.b[1] - R.a[1]); R.label = 'Handrail ' + R.length.toFixed(2) + ' m, H ' + R.height.toFixed(2) + (R.midZ !== null ? ', mid rail' : '') + ', ' + R.posts.length + ' posts'; for (const i of R.idx) used[i] = 1; }
  return out;
}
function handrailFaces(R, r = 0.024, post = 0.025) {
  const F = []; F.push(...cylFaces(R.a, R.b, r, 10));
  if (R.midZ !== null) F.push(...cylFaces([R.a[0], R.a[1], R.midZ], [R.b[0], R.b[1], R.midZ], r, 10));
  for (const p of R.posts) F.push(...boxFaces([p[0], p[1], R.level], [p[0], p[1], R.a[2]], [1, 0, 0], [0, 1, 0], -post, post, -post, post));
  return F;
}

// connect pipe runs meeting at bends
function findBends(pipes) {
  const bends = [];
  for (let a = 0; a < pipes.length; a++) for (let b = a + 1; b < pipes.length; b++) {
    const A = pipes[a], B = pipes[b]; if (Math.abs(A.r - B.r) > Math.max(A.r, B.r) * 0.2) continue;
    if (Math.abs(dot(A.axis, B.axis)) > 0.97) continue;
    // closest points of the two axis lines
    const w0 = [A.p0[0] - B.p0[0], A.p0[1] - B.p0[1], A.p0[2] - B.p0[2]], aa = dot(A.axis, A.axis), bb = dot(A.axis, B.axis), cc = dot(B.axis, B.axis), d = dot(A.axis, w0), e = dot(B.axis, w0);
    const den = aa * cc - bb * bb; if (Math.abs(den) < 1e-9) continue;
    const sA = (bb * e - cc * d) / den, sB = (aa * e - bb * d) / den;
    const pA = add(A.p0, A.axis, sA), pB = add(B.p0, B.axis, sB);
    if (Math.hypot(pA[0] - pB[0], pA[1] - pB[1], pA[2] - pB[2]) > Math.max(0.03, A.r * 0.6)) continue;
    const I = [(pA[0] + pB[0]) / 2, (pA[1] + pB[1]) / 2, (pA[2] + pB[2]) / 2];
    const near = (P_, Iv) => { const d0 = Math.hypot(P_.p0[0] - Iv[0], P_.p0[1] - Iv[1], P_.p0[2] - Iv[2]), d1 = Math.hypot(P_.p1[0] - Iv[0], P_.p1[1] - Iv[1], P_.p1[2] - Iv[2]); return d0 < d1 ? { end: P_.p0, d: d0 } : { end: P_.p1, d: d1 }; };
    const ea = near(A, I), eb = near(B, I); const lim = Math.max(A.r, B.r) * 5 + 0.15;
    if (ea.d > lim || eb.d > lim) continue;
    const ang = Math.acos(Math.min(1, Math.abs(dot(A.axis, B.axis)))) * 180 / Math.PI;
    bends.push({ type: 'bend', a: A, b: B, pts: [ea.end, I, eb.end], r: (A.r + B.r) / 2, angle: 180 - (180 - ang) });
  }
  return bends;
}

// ---------- full pipeline ----------
async function scanToCad(pos, n, opts = {}, onP = () => {}) {
  const spacing = opts.spacing || 0.015;
  const stage = (a, b) => f => onP(a + (b - a) * f);
  let mask = null; if (opts.box) { const b = opts.box; mask = new Uint8Array(n); for (let i = 0; i < n; i++) { const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]; mask[i] = x >= b[0] && y >= b[1] && z >= b[2] && x <= b[3] && y <= b[4] && z <= b[5] ? 1 : 0; } }
  const vox = voxelAssign(pos, n, spacing, mask);
  let reps = vox.reps; if (reps.length > (opts.maxPoints || 1500000)) { const st = Math.ceil(reps.length / (opts.maxPoints || 1500000)); reps = reps.filter((_, i) => i % st === 0); }
  const P = gather(pos, reps), m = reps.length;
  onP(0.02); await tickC();
  const N = opts.normalsFn ? await opts.normalsFn(P, m, opts.k || 14, stage(0.02, 0.35)) : await computeNormals(P, m, opts.k || 14, stage(0.02, 0.35));
  const ctx = { P, n: m, nrm: N.nrm, curv: N.curv, K: N.K, used: new Uint8Array(m), floorZ: [] };
  let zRef = Infinity; { const zs = new Float32Array(m); for (let i = 0; i < m; i++) zs[i] = P[i * 3 + 2]; zs.sort(); zRef = zs[Math.floor(m * 0.02)]; }
  const result = { spacing, n: m, planes: [], pipes: [], steel: [], flanges: [], fittings: [], bends: [] };
  // big planes: walls/floors (not member plates)
  const PL = await growPlanes(P, m, N, { angleDeg: 8, distTol: Math.max(0.01, spacing * 1.2), minPts: Math.max(150, Math.round(1.0 / (spacing * spacing) * 0.5)) }, stage(0.35, 0.5));
  for (const pl of PL.planes) {
    const D = describePlane(P, pl, spacing, zRef);
    const big = D.area >= (opts.minPlaneArea || 2.0) && Math.min(D.ext[0], D.ext[1]) >= (opts.minPlaneWidth || 0.9);
    if (!big) continue;
    if (Math.abs(pl.normal[2]) > 0.95) { let zs = 0; for (const i of pl.idx) zs += P[i * 3 + 2]; ctx.floorZ.push(zs / pl.idx.length); }
    const vert = Math.abs(pl.normal[2]) < 0.3, small = D.area < (opts.equipWallArea || 9) && Math.max(D.ext[0], D.ext[1]) < 4.2;
    for (const i of pl.idx) ctx.used[i] = vert && small ? 2 : 1;   // 2 = equipment may still claim it
    if (opts.planes !== false) result.planes.push(D);
  }
  onP(0.5); await tickC();
  result.handrails = [];
  if (opts.handrails !== false) {
    let decks = [];
    for (const pl of PL.planes) {
      if (Math.abs(pl.normal[2]) < 0.95) continue; let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const i of pl.idx) { x0 = Math.min(x0, P[i * 3]); x1 = Math.max(x1, P[i * 3]); y0 = Math.min(y0, P[i * 3 + 1]); y1 = Math.max(y1, P[i * 3 + 1]); }
      if ((x1 - x0) * (y1 - y0) < 4) continue; decks.push({ level: pl.centroid[2], x0, x1, y0, y1, n: pl.idx.length });
    }
    // keep the walking surfaces: one per level (a deck seen from above and below gives two planes ~1 cm apart)
    decks.sort((p, q) => q.n - p.n); const kept = [];
    for (const d of decks) { const near = kept.find(k => Math.abs(k.level - d.level) < 0.15); if (!near) kept.push(Object.assign({}, d)); else { near.x0 = Math.min(near.x0, d.x0); near.x1 = Math.max(near.x1, d.x1); near.y0 = Math.min(near.y0, d.y0); near.y1 = Math.max(near.y1, d.y1); if (d.level > near.level + 0.005) near.level = d.level; } }
    result.handrails = detectHandrails(ctx, kept, opts);
  }
  // people standing in the scan are found first and kept out of the model
  result.people = [];
  if (opts.people !== false) { try { result.people = peopleIn(ctx.P, ctx.n, { nrm: ctx.nrm, curv: ctx.curv }, {}); } catch (e) { result.people = []; }
    for (const f of result.people) for (let i = 0; i < ctx.n; i++) { const x = ctx.P[i * 3], y = ctx.P[i * 3 + 1], z = ctx.P[i * 3 + 2]; if (x >= f.lo[0] && x <= f.hi[0] && y >= f.lo[1] && y <= f.hi[1] && z >= f.lo[2] - 0.15 && z <= f.hi[2]) ctx.used[i] = 1; } }
  onP(0.55); await tickC();
  if (opts.pipes !== false || opts.steel !== false) {
    const mo = { minR: opts.minR || 0.01, maxR: opts.maxR || 0.4, maxSection: opts.maxSection || 0.7, minLen: opts.minLen || 0.3, maxGap: opts.maxGap || 0.5, maxAttempts: opts.maxAttempts || 6000 };
    if (opts.pipes !== false) result.pipes = await detectMembers(ctx, Object.assign({ only: 'pipe' }, mo), stage(0.5, 0.7));
    result.vessels = []; result.boxes = [];
    if (opts.vessels !== false || opts.boxes !== false) { const EQ = detectEquipment(ctx, opts); result.vessels = EQ.vessels; result.boxes = EQ.boxes; result.cylinders = EQ.cylinders; }
    for (let i = 0; i < ctx.n; i++) if (ctx.used[i] === 2) ctx.used[i] = 1;
    onP(0.75); await tickC();
    if (opts.steel !== false) result.steel = await detectMembers(ctx, Object.assign({ only: 'steel' }, mo), stage(0.75, 0.95));
  }
  if (result.pipes.length) { mergeCollinear(result.pipes, (x, y) => Math.abs(x.r - y.r) < Math.max(0.004, x.r * 0.08), opts.joinGap || 0.35); result.pipes = result.pipes.filter(p => p.length >= Math.max(opts.minLen || 0.3, p.r * 4)); for (const p of result.pipes) { const od = p.r * 2000, mt = matchPipe(od); p.dn = mt ? mt.dn : null; } }
  if (opts.flanges !== false) for (const p of result.pipes) for (const f of detectFlanges(ctx, p)) (f.type === 'flange' ? result.flanges : result.fittings).push(f);
  result.bends = findBends(result.pipes);
  if (!result.vessels) { result.vessels = []; result.boxes = []; result.cylinders = []; if (opts.vessels !== false || opts.boxes !== false) { const EQ = detectEquipment(ctx, opts); result.vessels = EQ.vessels; result.boxes = EQ.boxes; result.cylinders = EQ.cylinders; } }
  result.ctx = ctx; onP(1);
  return result;
}
// assisted fit at a clicked point (uses a prepared ctx)
function fitAt(ctx, pi, opts) {
  const { P, K, nrm } = ctx; const r0 = Math.max(0.15, Math.min(0.6, (opts.maxR || 0.4) * 1.6)); const buf = [];
  kdRadius(K, P[pi * 3], P[pi * 3 + 1], P[pi * 3 + 2], r0, buf); const local = buf.filter(i => !ctx.used[i]);
  if (local.length < 20) return null;
  const NA = normalsAxis(nrm, local, local.length);
  const M = growMember(ctx, local, NA.axis, Object.assign({ minR: 0.005, maxR: 1.0, maxSection: 1.2, minLen: 0.1, keepPrisms: true, maxGap: 0.6 }, opts), r0);
  if (M) for (const i of M.idx) ctx.used[i] = 1;
  return M;
}



// ---------- pressure vessels and box equipment (electrical cabinets, skids, modules) from what is left ----------
function components3D(P, idxList, cell) {
  const inv = 1 / cell, cells = new Map();
  for (const i of idxList) { const k = (Math.floor(P[i * 3] * inv) + 4096) * 67108864 + (Math.floor(P[i * 3 + 1] * inv) + 4096) * 8192 + (Math.floor(P[i * 3 + 2] * inv) + 4096); let l = cells.get(k); if (!l) cells.set(k, l = []); l.push(i); }
  const seen = new Set(), comps = [];
  for (const k0 of cells.keys()) {
    if (seen.has(k0)) continue; seen.add(k0); const st = [k0], pts = [];
    while (st.length) { const k = st.pop(); pts.push(...cells.get(k)); const x = Math.floor(k / 67108864), y = Math.floor((k % 67108864) / 8192), z = k % 8192;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) { const q = (x + dx) * 67108864 + (y + dy) * 8192 + (z + dz); if (cells.has(q) && !seen.has(q)) { seen.add(q); st.push(q); } } }
    comps.push(pts);
  }
  return comps;
}
function pcaAxes(P, idx) {
  let mx = 0, my = 0, mz = 0; for (const i of idx) { mx += P[i * 3]; my += P[i * 3 + 1]; mz += P[i * 3 + 2]; } const m = idx.length; mx /= m; my /= m; mz /= m;
  let a = 0, b = 0, c = 0, d = 0, e = 0, f = 0; for (const i of idx) { const x = P[i * 3] - mx, y = P[i * 3 + 1] - my, z = P[i * 3 + 2] - mz; a += x * x; b += x * y; c += x * z; d += y * y; e += y * z; f += z * z; }
  const E = eig3(a / m, b / m, c / m, d / m, e / m, f / m); return { c: [mx, my, mz], major: E.v2, l: E.l };
}
function fitVessel(ctx, idx, opts) {
  const { P } = ctx; const m = idx.length; if (m < 300) return null;
  const pa = pcaAxes(P, idx); let best = null;
  // candidate axes: vertical, the long axis, and the axis from normals; keep the best circle
  const cands = [...(opts.axisHint ? [opts.axisHint] : []), [0, 0, 1], pa.major, normalsAxis(ctx.nrm, idx, m).axis];
  for (const ax0 of cands) {
    const ax = norm(ax0); const { u, v } = perpFrame(ax); const xs = new Float64Array(m), ys = new Float64Array(m), as = new Float64Array(m);
    idx.forEach((i, k) => { const d = [P[i * 3] - pa.c[0], P[i * 3 + 1] - pa.c[1], P[i * 3 + 2] - pa.c[2]]; xs[k] = dot(d, u); ys[k] = dot(d, v); as[k] = dot(d, ax); });
    let cf = fitCircle(xs, ys, m);
    for (let it = 0; it < 3; it++) { const res = []; for (let k = 0; k < m; k++) res.push(Math.abs(Math.hypot(xs[k] - cf.cx, ys[k] - cf.cy) - cf.r)); const srt = res.slice().sort((x, y) => x - y), thr = Math.max(0.01, srt[m >> 1] * 3); const X = [], Y = []; for (let k = 0; k < m; k++) if (res[k] <= thr) { X.push(xs[k]); Y.push(ys[k]); } if (X.length < 50) break; cf = fitCircle(X, Y, X.length); cf.inl = X.length / m; }
    if (!(cf.r >= (opts.minVesselR || 0.25) && cf.r <= (opts.maxVesselR || 2.5))) continue;
    // shell = points on the cylinder; tangent line ends = their axial extent
    const sh = []; for (let k = 0; k < m; k++) if (Math.abs(Math.hypot(xs[k] - cf.cx, ys[k] - cf.cy) - cf.r) < Math.max(0.012, cf.r * 0.02)) sh.push(as[k]);
    if (sh.length < m * 0.35) continue; sh.sort((x, y) => x - y); const a0 = sh[Math.floor(sh.length * 0.01)], a1 = sh[Math.floor(sh.length * 0.99)];
    const cov = arcCoverage(xs, ys, m, cf.cx, cf.cy); if (cov < 120) continue;
    const score = sh.length / m * (cov / 360);
    if (!best || score > best.score) best = { ax, u, v, cf, a0, a1, score, xs, ys, as };
  }
  if (!best || best.a1 - best.a0 < best.cf.r * 0.8) return null;
  const { ax, u, v, cf, a0, a1 } = best; const cen = add(add(pa.c, u, cf.cx), v, cf.cy);
  // heads: how far points reach past each tangent line, close to the axis
  const reach = side => { let r = 0; for (let k = 0; k < m; k++) { const rr = Math.hypot(best.xs[k] - cf.cx, best.ys[k] - cf.cy); if (rr > cf.r * 0.8) continue; const ex = side > 0 ? best.as[k] - a1 : a0 - best.as[k]; if (ex > r && ex < cf.r * 1.2) r = ex; } return r; };
  const h0 = reach(-1), h1 = reach(1); const head = h => h > cf.r * 0.35 ? '2:1 ellipsoidal' : h > cf.r * 0.12 ? 'torispherical' : h > 0.02 ? 'flat / shallow' : 'not seen';
  const vertical = Math.abs(ax[2]) > 0.95, horizontal = Math.abs(ax[2]) < 0.1;
  return { type: 'vessel', axis: ax, p0: add(cen, ax, a0), p1: add(cen, ax, a1), r: cf.r, rms: cf.rms, length: a1 - a0, heads: [head(h0), head(h1)], headDepth: [h0, h1], dir: vertical ? 'vertical' : horizontal ? 'horizontal' : 'inclined', label: (vertical ? 'Vertical' : horizontal ? 'Horizontal' : 'Inclined') + ' vessel ID≈' + (cf.r * 2000).toFixed(0) + ' mm, T/T ' + ((a1 - a0) * 1000).toFixed(0) + ' mm' };
}
function fitBox(ctx, idx, opts) {
  const { P } = ctx; const m = idx.length; if (m < 150) return null;
  const zz = new Float32Array(m); idx.forEach((i, k) => zz[k] = P[i * 3 + 2]); zz.sort(); let zmin = zz[Math.floor(m * 0.005)], zmax = zz[Math.floor(m * 0.985)];   // robust: a pipe brushing past should not set the size
  // minimum-area rectangle in plan
  let best = null;
  const sub = idx.length > 4000 ? idx.filter((_, k) => k % Math.ceil(idx.length / 4000) === 0) : idx;
  const rect = th => { const c = Math.cos(th), s = Math.sin(th); const A = [], B = []; for (const i of sub) { A.push(c * P[i * 3] + s * P[i * 3 + 1]); B.push(-s * P[i * 3] + c * P[i * 3 + 1]); } A.sort((x, y) => x - y); B.sort((x, y) => x - y); const lo = Math.floor(A.length * 0.04), hi = Math.floor(A.length * 0.96); return { th, a0: A[lo], a1: A[hi], b0: B[lo], b1: B[hi], area: (A[hi] - A[lo]) * (B[hi] - B[lo]) }; };
  for (let d = 0; d < 90; d += 1.5) { const r = rect(d * Math.PI / 180); if (!best || r.area < best.area) best = r; }
  for (let d = -1.5; d <= 1.5; d += 0.1) { const r = rect(best.th + d * Math.PI / 180); if (r.area < best.area) best = r; }
  // faces from points whose normals face along each box axis (a pipe brushing past has radial normals and barely votes)
  const c = Math.cos(best.th), s = Math.sin(best.th), nr = ctx.nrm;
  // extents from points on axis-aligned faces only (|normal . box axis| > 0.95): a pipe brushing past barely votes
  const A_ = [], B_ = [], Z_ = [];
  for (const i of idx) { const nu = Math.abs(c * nr[i * 3] + s * nr[i * 3 + 1]), nv = Math.abs(-s * nr[i * 3] + c * nr[i * 3 + 1]), nz = Math.abs(nr[i * 3 + 2]); if (Math.max(nu, nv, nz) < 0.95) continue; A_.push(c * P[i * 3] + s * P[i * 3 + 1]); B_.push(-s * P[i * 3] + c * P[i * 3 + 1]); Z_.push(P[i * 3 + 2]); }
  if (A_.length < 100) return null;
  const pr = (arr, q0, q1) => { arr.sort((x, y) => x - y); return [arr[Math.floor(arr.length * q0)], arr[Math.min(arr.length - 1, Math.floor(arr.length * q1))]]; };
  const PA = pr(A_, 0.015, 0.985), PB = pr(B_, 0.015, 0.985), PZ = pr(Z_, 0.005, 0.99);
  // then snap each extent to the outermost face (a histogram mode of points facing that way); keep the percentile where no face is seen
  const faceRange = (getC, getN, lo0, hi0) => { const v = []; for (const i of idx) if (Math.abs(getN(i)) > 0.9) v.push(getC(i)); if (v.length < 30) return [lo0, hi0];
    const mn = lo0 - 0.1, nb = Math.max(1, Math.ceil((hi0 - lo0 + 0.2) / 0.02)), h = new Int32Array(nb); for (const x of v) { const k = Math.floor((x - mn) / 0.02); if (k >= 0 && k < nb) h[k]++; }
    let hm = 0; for (const x of h) hm = Math.max(hm, x); let a = -1, b = -1; for (let k = 0; k < nb; k++) if (h[k] >= hm * 0.05 && h[k] >= 10) { if (a < 0) a = k; b = k; }
    if (a < 0) return [lo0, hi0]; let lo = mn + (a + 0.5) * 0.02, hi = mn + (b + 0.5) * 0.02; if (lo0 < lo - 0.04) lo = lo0; if (hi0 > hi + 0.04) hi = hi0; return [lo, hi]; };   // a face hidden from the scanner: the other surfaces still show the extent
  const [a0, a1] = faceRange(i => c * P[i * 3] + s * P[i * 3 + 1], i => c * nr[i * 3] + s * nr[i * 3 + 1], PA[0], PA[1]);
  const [b0, b1] = faceRange(i => -s * P[i * 3] + c * P[i * 3 + 1], i => -s * nr[i * 3] + c * nr[i * 3 + 1], PB[0], PB[1]);
  const [z0, z1] = faceRange(i => P[i * 3 + 2], i => nr[i * 3 + 2], PZ[0], PZ[1]);
  Object.assign(best, { a0, a1, b0, b1 }); zmin = z0; zmax = z1;
  const W = best.a1 - best.a0, D = best.b1 - best.b0, H = zmax - zmin; if (Math.min(W, D, H) < 0.15) return null;
  { const dims = [W, D, H].sort((x, y) => x - y); if (dims[1] < 0.3 && dims[2] > 1.0) return null; }   // long and thin: a pipe or member, not a box
  // box-ness: of the points inside the box (+5 cm), the share within 3 cm of a face; most of the component must be inside
  let on = 0, ins = 0;
  for (const i of idx) { const a = c * P[i * 3] + s * P[i * 3 + 1], b = -s * P[i * 3] + c * P[i * 3 + 1], z = P[i * 3 + 2];
    if (a < best.a0 - 0.05 || a > best.a1 + 0.05 || b < best.b0 - 0.05 || b > best.b1 + 0.05 || z < zmin - 0.05 || z > zmax + 0.05) continue; ins++;
    const d = Math.min(Math.abs(a - best.a0), Math.abs(a - best.a1), Math.abs(b - best.b0), Math.abs(b - best.b1), Math.abs(z - zmax), Math.abs(z - zmin)); if (d < 0.03 || Math.max(Math.abs(c * nr[i * 3] + s * nr[i * 3 + 1]), Math.abs(-s * nr[i * 3] + c * nr[i * 3 + 1]), Math.abs(nr[i * 3 + 2])) > 0.95) on++; }   // on a face, or on an internal face (panel joints, plinth)
  const fit = on / Math.max(1, ins); if (opts.debug) console.log("fitBox", W.toFixed(2), D.toFixed(2), H.toFixed(2), fit.toFixed(2), (ins / m).toFixed(2)); if (fit < 0.8 || ins < m * 0.8) return null;
  const am = (best.a0 + best.a1) / 2, bm = (best.b0 + best.b1) / 2; const cx = c * am - s * bm, cy = s * am + c * bm;
  const big = Math.max(W, D), small = Math.min(W, D);
  let kind = 'Box / enclosure';
  if (H >= 0.5 && H <= 2.4 && big <= 1.6 && small <= 0.9) kind = 'Electrical cabinet';
  else if (H < 0.5 && big <= 1.0) kind = 'Junction box';
  else if (H >= 1.5 && H <= 2.5 && big <= 6 && small <= 0.9) kind = 'Electrical cabinet line-up (' + Math.max(2, Math.round(big / 0.8)) + ' panels approx.)';
  else if (big > 2.5 && H > 2.2) kind = 'Module / building';
  else if (big > 1.6) kind = 'Skid / enclosure';
  const ux = [c, s, 0], uy = [-s, c, 0];
  return { type: 'box', kind, centre: [cx, cy, (zmin + zmax) / 2], ux, uy, W, D, H, rot: best.th * 180 / Math.PI, fit, zmin, zmax, label: kind + ' ' + (W * 1000).toFixed(0) + ' × ' + (D * 1000).toFixed(0) + ' × ' + (H * 1000).toFixed(0) + ' mm' };
}
function smoothSegments(ctx, idx, angDeg, rad) {
  // region growing over neighbours with continuous normals: a vessel shell + heads is one smooth surface, saddles and beams break off at edges
  const inSet = new Uint8Array(ctx.n); for (const i of idx) inSet[i] = 1; const lab = new Int32Array(ctx.n).fill(-1); const cosT = Math.cos(angDeg * Math.PI / 180), buf = [], segs = [];
  for (const s0 of idx) {
    if (lab[s0] >= 0 || ctx.curv[s0] > 0.06) continue; const id = segs.length, seg = [s0], st = [s0]; lab[s0] = id;
    while (st.length) { const i = st.pop(); buf.length = 0; kdRadius(ctx.K, ctx.P[i * 3], ctx.P[i * 3 + 1], ctx.P[i * 3 + 2], rad, buf);
      for (const j of buf) { if (!inSet[j] || lab[j] >= 0 || ctx.curv[j] > 0.06) continue; const c = Math.abs(ctx.nrm[i * 3] * ctx.nrm[j * 3] + ctx.nrm[i * 3 + 1] * ctx.nrm[j * 3 + 1] + ctx.nrm[i * 3 + 2] * ctx.nrm[j * 3 + 2]); if (c < cosT) continue; lab[j] = id; seg.push(j); st.push(j); } }
    segs.push(seg);
  }
  return segs.filter(g => g.length >= 300).sort((a, b) => b.length - a.length);
}
function detectEquipment(ctx, opts = {}) {
  // leave out the few centimetres just above each floor: leftover deck points there would tie every cabinet, skid and rail post into one lump
  const fz = ctx.floorZ || []; const nearFloor = z => { for (const f of fz) if (z > f - 0.04 && z < f + 0.07) return true; return false; };
  const left = []; for (let i = 0; i < ctx.n; i++) if (ctx.used[i] !== 1 && !nearFloor(ctx.P[i * 3 + 2])) left.push(i);
  const vessels = [], boxes = [], cylinders = [];
  const keepV = (V, pts) => { if (V.heads[0] === 'not seen' && V.heads[1] === 'not seen') { V.type = 'cylinder'; V.label = 'Large tubular / pedestal OD≈' + (V.r * 2000).toFixed(0) + ' mm, L ' + (V.length * 1000).toFixed(0) + ' mm (no heads)'; cylinders.push(V); } else vessels.push(V); for (const i of pts) ctx.used[i] = 1; };
  const extentOf = cp => { let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; for (const i of cp) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], ctx.P[i * 3 + k]); mx[k] = Math.max(mx[k], ctx.P[i * 3 + k]); } return mx.map((v, k) => v - mn[k]); };
  // pass 1: vessels (whole component, else its smooth surfaces)
  if (opts.vessels !== false) for (const cp of components3D(ctx.P, left, opts.cell || 0.06)) {
    if (cp.length < 300) continue; const ext = extentOf(cp); if (Math.max(...ext) < 0.5) continue;
    const V = Math.max(...ext) <= 12 ? fitVessel(ctx, cp, opts) : null; if (V) { keepV(V, cp); continue; }
    for (const sg of smoothSegments(ctx, cp, 6, Math.max(0.05, (opts.spacing || 0.02) * 3))) {
      const e2 = extentOf(sg); if (Math.max(...e2) < 0.5 || Math.max(...e2) > 12) continue; const V2 = fitVessel(ctx, sg, opts); if (!V2 || V2.r < 0.3) continue;
      // claim everything of the component inside the fitted envelope (shell, heads, nozzles stubs)
      const own = []; for (const i of cp) { if (ctx.used[i] === 1) continue; const d = [ctx.P[i * 3] - V2.p0[0], ctx.P[i * 3 + 1] - V2.p0[1], ctx.P[i * 3 + 2] - V2.p0[2]], a = dot(d, V2.axis), rr = Math.hypot(d[0] - a * V2.axis[0], d[1] - a * V2.axis[1], d[2] - a * V2.axis[2]); if (a > -V2.r * 0.6 && a < V2.length + V2.r * 0.6 && rr < V2.r + 0.04) own.push(i); }
      keepV(V2, own);
    }
  }
  // pass 2: boxes on what is left (finer cells so panels in a line-up stay apart)
  if (opts.boxes !== false) { const left2 = left.filter(i => ctx.used[i] !== 1);
    for (const cp of components3D(ctx.P, left2, opts.boxCell || 0.045)) {
      if (cp.length < 150) continue; const ext = extentOf(cp); if (Math.max(...ext) > 12 || Math.max(...ext) < 0.25) continue;
      const B = fitBox(ctx, cp, opts);
      if (B && fz.length && !opts.keepAllBoxes) { const onFloor = fz.some(f => B.zmin - f > -0.06 && B.zmin - f < 0.25), under = fz.some(f => B.zmax <= f + 0.03 && B.zmax > f - 0.8), dm = [B.W, B.D, B.H].sort((x, y) => x - y), wallBox = dm[0] <= 0.2 && dm[2] >= 0.3 && dm[2] <= 0.8 && dm[1] >= 0.25;
        if (under || !(onFloor || wallBox)) continue; if (/Junction/.test(B.kind) && !wallBox) continue; }
      if (B) { for (const f of fz) if (B.zmin - f > -0.02 && B.zmin - f < 0.15) { B.zmin = f; B.H = B.zmax - B.zmin; B.centre[2] = (B.zmin + B.zmax) / 2; B.label = B.label.replace(/× \d+ mm$/, '× ' + (B.H * 1000).toFixed(0) + ' mm'); } boxes.push(B); for (const i of cp) ctx.used[i] = 1; }
    } }
  return { vessels, boxes, cylinders };
}
function vesselFaces(Vs, sides = 32) {
  const F = cylFaces(Vs.p0, Vs.p1, Vs.r, sides); const { u, v } = perpFrame(Vs.axis);
  for (const [end, sgn, depth] of [[Vs.p0, -1, Vs.headDepth[0]], [Vs.p1, 1, Vs.headDepth[1]]]) {
    const h = Math.max(0.02, Math.min(Vs.r * 0.5, depth || Vs.r * 0.5)), rings = 6, pt = (k, j) => { const z = Math.sin(Math.PI / 2 * k / rings), rr = Vs.r * Math.cos(Math.PI / 2 * k / rings), a = 2 * Math.PI * j / sides; return add(add(add(end, Vs.axis, sgn * h * z), u, rr * Math.cos(a)), v, rr * Math.sin(a)); };
    for (let k = 0; k < rings; k++) for (let j = 0; j < sides; j++) F.push([pt(k, j), pt(k, j + 1), pt(k + 1, j + 1), pt(k + 1, j)]);
  }
  return F;
}
function boxEquipFaces(B) { const p0 = [B.centre[0], B.centre[1], B.zmin], p1 = [B.centre[0], B.centre[1], B.zmax]; return boxFaces(p0, p1, B.ux, B.uy, -B.W / 2, B.W / 2, -B.D / 2, B.D / 2); }

// ---------- fit a straight member between two picked points (start and end set the alignment and the extent) ----------
// pos: layer positions, A/B: picked surface points [x,y,z]. opts: {minR, maxR, maxSection, spacing}
async function fitBetween(pos, n, A, B, opts = {}) {
  const ax0 = norm([B[0] - A[0], B[1] - A[1], B[2] - A[2]]); const Lab = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]);
  if (Lab < 0.05) return null;
  const sp = opts.spacing || 0.01, maxSec = opts.maxSection || 0.75, R0 = maxSec + 0.05, cell = 0.015, nb = Lab < 0.6 ? 6 : 10, need = Lab < 0.6 ? 3 : 6;
  const { u, v } = perpFrame(ax0, Math.abs(ax0[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]);
  // 1. corridor around the picked line; section coordinates (s,t) and a length bin per point
  const ids = [], S2 = [], T2 = [], BIN = [];
  for (let i = 0; i < n; i++) {
    const dx = pos[i * 3] - A[0], dy = pos[i * 3 + 1] - A[1], dz = pos[i * 3 + 2] - A[2]; const a = dx * ax0[0] + dy * ax0[1] + dz * ax0[2]; if (a < 0 || a > Lab) continue;
    const s_ = dx * u[0] + dy * u[1] + dz * u[2], t_ = dx * v[0] + dy * v[1] + dz * v[2]; if (s_ * s_ + t_ * t_ > R0 * R0) continue;
    ids.push(i); S2.push(s_); T2.push(t_); BIN.push(Math.min(nb - 1, Math.floor(a / Lab * nb)));
  }
  if (ids.length < 30) return null;
  // 2. persistent section cells: present along most of the picked length
  const key = (a, b) => (a + 512) * 1024 + (b + 512); const mask = new Map();
  for (let k = 0; k < ids.length; k++) { const kk = key(Math.round(S2[k] / cell), Math.round(T2[k] / cell)); mask.set(kk, (mask.get(kk) || 0) | (1 << BIN[k])); }
  const pc = m => { let c = 0; while (m) { c += m & 1; m >>= 1; } return c; };
  const pers = new Set(); for (const [kk, m] of mask) if (pc(m) >= need) pers.add(kk);
  // 3. long straight runs (decks, floors, walls) crossing the corridor: set aside, add back only within the member's own width
  const runCells = new Set(), lim = Math.round(0.9 / cell);
  const scan = horiz => { const lines = new Map(); for (const kk of pers) { const a = Math.floor(kk / 1024) - 512, b = kk % 1024 - 512; const line = horiz ? b : a, pos_ = horiz ? a : b; let l = lines.get(line); if (!l) lines.set(line, l = []); l.push(pos_); }
    for (const [line, arr] of lines) { arr.sort((x, y) => x - y); let st = 0; for (let q = 1; q <= arr.length; q++) { if (q === arr.length || arr[q] - arr[q - 1] > 2) { if (arr[q - 1] - arr[st] >= lim) for (let w = st; w < q; w++) runCells.add(horiz ? key(arr[w], line) : key(line, arr[w])); st = q; } } } };
  scan(true); scan(false);
  // 4. flood fill from the clicked point through persistent, non-run cells
  let seed = null, bd = Infinity; for (const kk of pers) { if (runCells.has(kk)) continue; const a = Math.floor(kk / 1024) - 512, b = kk % 1024 - 512, d = a * a + b * b; if (d < bd) { bd = d; seed = kk; } }
  if (seed === null || bd > 64) return null;
  const region = new Set([seed]), st = [seed];
  while (st.length) { const kk = st.pop(); const a = Math.floor(kk / 1024) - 512, b = kk % 1024 - 512; for (let da = -2; da <= 2; da++) for (let db = -2; db <= 2; db++) { const q = key(a + da, b + db); if (pers.has(q) && !runCells.has(q) && !region.has(q)) { region.add(q); st.push(q); } } }
  let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity; for (const kk of region) { const a = Math.floor(kk / 1024) - 512, b = kk % 1024 - 512; s0 = Math.min(s0, a); s1 = Math.max(s1, a); t0 = Math.min(t0, b); t1 = Math.max(t1, b); }
  for (const kk of runCells) { const a = Math.floor(kk / 1024) - 512, b = kk % 1024 - 512; if (a >= s0 && a <= s1 && b >= t0 - 2 && b <= t1 + 2) region.add(kk); } // a flange against a deck plate
  const sel = new Uint8Array(n); let cnt = 0;
  for (let k = 0; k < ids.length; k++) if (region.has(key(Math.round(S2[k] / cell), Math.round(T2[k] / cell)))) { sel[ids[k]] = 1; cnt++; }
  if (cnt < 30) return null;
  // 5. fit along the user's alignment
  const vox = voxelAssign(pos, n, sp, sel); const P = gather(pos, vox.reps), m = vox.reps.length; const N = await computeNormals(P, m, 14);
  const ctx = { P, n: m, nrm: N.nrm, curv: N.curv, K: N.K, used: new Uint8Array(m) };
  const M = fitMember(ctx, Uint32Array.from({ length: m }, (_, i) => i), ax0, Object.assign({ minR: 0.005, maxR: 1.0 }, opts));
  const c = M.p0, pa = dot([A[0] - c[0], A[1] - c[1], A[2] - c[2]], M.axis), pb = dot([B[0] - c[0], B[1] - c[1], B[2] - c[2]], M.axis);
  M.p0 = add(c, M.axis, pa); M.p1 = add(c, M.axis, pb); M.length = Math.abs(pb - pa); if (pb < pa) M.axis = M.axis.map(x => -x);
  if (M.type === 'pipe') { const od = M.r * 2000, mt = matchPipe(od); M.dn = mt ? mt.dn : null; M.label = (mt ? 'DN' + mt.dn + ' ' : '') + 'Ø' + od.toFixed(0) + ' mm'; M.flanges = detectFlanges(ctx, M); }
  else describeSteel(M);
  M.dir = Math.abs(M.axis[2]) > 0.98 ? 'vertical' : Math.abs(M.axis[2]) < 0.02 ? 'horizontal' : 'sloped'; M.picked = true; M.idx = new Uint32Array(0);
  return M;
}
// bend/joint between consecutive picked runs: meet the two centrelines at their closest approach
function joinRuns(A, B) {
  if (A.type !== 'pipe' || B.type !== 'pipe') return null;
  const w0 = [A.p0[0] - B.p0[0], A.p0[1] - B.p0[1], A.p0[2] - B.p0[2]], aa = 1, bb = dot(A.axis, B.axis), cc = 1, d = dot(A.axis, w0), e = dot(B.axis, w0), den = aa * cc - bb * bb;
  const e1 = A.p1, s0 = B.p0;
  if (Math.abs(den) > 1e-6) {
    const sA = (bb * e - cc * d) / den, sB = (aa * e - bb * d) / den; const pA = add(A.p0, A.axis, sA), pB = add(B.p0, B.axis, sB);
    const gap = Math.hypot(pA[0] - pB[0], pA[1] - pB[1], pA[2] - pB[2]);
    const I = [(pA[0] + pB[0]) / 2, (pA[1] + pB[1]) / 2, (pA[2] + pB[2]) / 2];
    if (gap < Math.max(0.05, A.r) && Math.hypot(I[0] - e1[0], I[1] - e1[1], I[2] - e1[2]) < 2.5 && Math.hypot(I[0] - s0[0], I[1] - s0[1], I[2] - s0[2]) < 2.5)
      return { type: 'bend', a: A, b: B, pts: [e1, I, s0], r: (A.r + B.r) / 2, angle: Math.acos(Math.min(1, Math.abs(bb))) * 180 / Math.PI };
  }
  if (Math.hypot(e1[0] - s0[0], e1[1] - s0[1], e1[2] - s0[2]) > 2.5) return null;
  return { type: 'bend', a: A, b: B, pts: [e1, [(e1[0] + s0[0]) / 2, (e1[1] + s0[1]) / 2, (e1[2] + s0[2]) / 2], s0], r: (A.r + B.r) / 2, angle: 0 };
}
// ---------- geometry for display / DXF ----------
function cylFaces(p0, p1, r, sides = 16) { // returns array of quads [[a,b,c,d]]
  const ax = norm([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]), { u, v } = perpFrame(ax); const F = [];
  for (let k = 0; k < sides; k++) {
    const a0 = 2 * Math.PI * k / sides, a1 = 2 * Math.PI * (k + 1) / sides;
    const o0 = add([0, 0, 0], u, Math.cos(a0) * r), o0b = add(o0, v, Math.sin(a0) * r), o1 = add(add([0, 0, 0], u, Math.cos(a1) * r), v, Math.sin(a1) * r);
    F.push([add(p0, o0b), add(p0, o1), add(p1, o1), add(p1, o0b)]);
  }
  return F;
}
function discFaces(c, ax, r0, r1, sides = 16) { const { u, v } = perpFrame(ax); const F = []; for (let k = 0; k < sides; k++) { const a0 = 2 * Math.PI * k / sides, a1 = 2 * Math.PI * (k + 1) / sides; const q = (a, r) => add(add(c, u, Math.cos(a) * r), v, Math.sin(a) * r); F.push([q(a0, r0), q(a1, r0), q(a1, r1), q(a0, r1)]); } return F; }
function boxFaces(p0, p1, u, v, s0, s1, t0, t1) { // prism along p0->p1 with rectangle [s0,s1]x[t0,t1] in (u,v)
  const c = (p, s, t) => add(add(p, u, s), v, t);
  const A = [c(p0, s0, t0), c(p0, s1, t0), c(p0, s1, t1), c(p0, s0, t1)], B = [c(p1, s0, t0), c(p1, s1, t0), c(p1, s1, t1), c(p1, s0, t1)];
  return [[A[0], A[1], A[2], A[3]], [B[0], B[3], B[2], B[1]], [A[0], B[0], B[1], A[1]], [A[1], B[1], B[2], A[2]], [A[2], B[2], B[3], A[3]], [A[3], B[3], B[0], A[0]]];
}
// rectangles (in section frame, metres) making up a steel profile
function steelRects(M) {
  const s = M.sec, d = M.dims, mm = 0.001; const cs = 0, ct = 0; // centred at centreline
  if (s.shape === 'I') {
    const D = d.d * mm, B = d.bf * mm, tf = d.tf * mm, tw = d.tw * mm;
    const R = [[-B / 2, B / 2, D / 2 - tf, D / 2], [-B / 2, B / 2, -D / 2, -D / 2 + tf], [-tw / 2, tw / 2, -D / 2 + tf, D / 2 - tf]];
    return s.key === 'I|' ? R : R.map(r => [r[2], r[3], r[0], r[1]]);
  }
  if (s.shape === 'C') {
    const D = d.d * mm, B = d.bf * mm, tf = d.tf * mm, tw = d.tw * mm;
    let R = [[-B / 2, -B / 2 + tw, -D / 2, D / 2], [-B / 2, B / 2, D / 2 - tf, D / 2], [-B / 2, B / 2, -D / 2, -D / 2 + tf]]; // web on -s side, depth along t
    if (s.key === 'C1') R = R.map(r => [-r[1], -r[0], r[2], r[3]]);
    if (s.key === 'C2') R = R.map(r => [r[2], r[3], r[0], r[1]]);
    if (s.key === 'C3') R = R.map(r => [r[2], r[3], -r[1], -r[0]]);
    return R;
  }
  if (s.shape === 'L') {
    const H = s.H, W = s.W, t = d.t * mm; let R = [[-W / 2, -W / 2 + t, -H / 2, H / 2], [-W / 2, W / 2, -H / 2, -H / 2 + t]];
    if (s.key === 'L1' || s.key === 'L3') R = R.map(r => [-r[1], -r[0], r[2], r[3]]);
    if (s.key === 'L2' || s.key === 'L3') R = R.map(r => [r[0], r[1], -r[3], -r[2]]);
    return R;
  }
  if (s.shape === 'BOX') { const H = s.H, W = s.W, t = d.t * mm; return [[-W / 2, W / 2, H / 2 - t, H / 2], [-W / 2, W / 2, -H / 2, -H / 2 + t], [-W / 2, -W / 2 + t, -H / 2 + t, H / 2 - t], [W / 2 - t, W / 2, -H / 2 + t, H / 2 - t]]; }
  return [[-s.W / 2, s.W / 2, -s.H / 2, s.H / 2]];
}
function memberFaces(M) { const F = []; for (const r of steelRects(M)) F.push(...boxFaces(M.p0, M.p1, M.u, M.v, r[0], r[1], r[2], r[3])); return F; }

// join pieces of one straight member (same size, same line, small gap); the longer piece keeps its fit
function mergeCollinear(list, same, gap = 0.35) {
  let merged = true; while (merged) { merged = false;
    outer: for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) { let a = list[i], b = list[j]; if (!same(a, b)) continue; if (Math.abs(dot(a.axis, b.axis)) < 0.9986) continue; if (b.length > a.length) { list[i] = b; list[j] = a; const t = a; a = b; b = t; }
      const off = q => { const d = [q[0] - a.p0[0], q[1] - a.p0[1], q[2] - a.p0[2]], t = dot(d, a.axis); return [t, Math.hypot(d[0] - a.axis[0] * t, d[1] - a.axis[1] * t, d[2] - a.axis[2] * t)]; };
      const [t0, o0] = off(b.p0), [t1, o1] = off(b.p1); const tol = Math.max(0.025, (a.r || 0.05) * 0.5); if (o0 > tol || o1 > tol) continue;
      const lo = Math.min(t0, t1), hi = Math.max(t0, t1); if (lo > a.length + gap || hi < -gap) continue;
      const ends = [[0, a.p0], [a.length, a.p1], [t0, b.p0], [t1, b.p1]].sort((x, y) => x[0] - y[0]); const e0 = ends[0][1].slice(), e1 = ends[3][1].slice(); const L2 = Math.hypot(e1[0] - e0[0], e1[1] - e0[1], e1[2] - e0[2]);
      a.p0 = e0; a.p1 = e1; a.length = L2; a.axis = [(e1[0] - e0[0]) / L2, (e1[1] - e0[1]) / L2, (e1[2] - e0[2]) / L2]; if (a.u && a.v) { const uu = a.u.map((q, k) => q - dot(a.u, a.axis) * a.axis[k]), nn = Math.hypot(uu[0], uu[1], uu[2]) || 1; a.u = uu.map(q => q / nn); const w = cross(a.axis, a.u); a.v = dot(w, a.v) < 0 ? w.map(q => -q) : w; }
      if (a.idx && b.idx) { const m = new Uint32Array(a.idx.length + b.idx.length); m.set(a.idx); m.set(b.idx, a.idx.length); a.idx = m; }
      list.splice(j, 1); merged = true; break outer; } }
  return list;
}
// ---------- people standing on floors (temporary objects to remove before modelling) ----------
async function detectPeople(pos, n, opts = {}, onP = () => {}) {
    const sp = 0.04; const vox = voxelAssign(pos, n, sp); const P = gather(pos, vox.reps), m = vox.reps.length; const N = await computeNormals(P, m, 12, f => onP(f * 0.6));
    return peopleIn(P, m, N, opts, onP);
}
function peopleIn(P, m, N, opts = {}, onP = () => {}) {
    const floor = new Uint8Array(m); for (let i = 0; i < m; i++) if (Math.abs(N.nrm[i * 3 + 2]) > 0.93 && N.curv[i] < 0.02) floor[i] = 1;
    // floor heights on a 0.3 m grid (several levels per cell allowed)
    // real floors are big: a level counts only where ≥ 200 flat points (about 0.3 m²) sit around the cell (not a hat, a shoulder or a box lid)
    const fc = new Map(); for (let i = 0; i < m; i++) if (floor[i]) { const k = Math.floor(P[i * 3] / 0.3) + ',' + Math.floor(P[i * 3 + 1] / 0.3); let a = fc.get(k); if (!a) fc.set(k, a = new Map()); const zb = Math.round(P[i * 3 + 2] / 0.05); a.set(zb, (a.get(zb) || 0) + 1); }
    const fl = new Map(); for (const [k, lv] of fc) { const [cx, cy] = k.split(',').map(Number); const ok = []; for (const [zb] of lv) { let t = 0; for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const a = fc.get((cx + dx) + ',' + (cy + dy)); if (a) t += (a.get(zb - 1) || 0) + (a.get(zb) || 0) + (a.get(zb + 1) || 0); } if (t >= 200) ok.push(zb * 0.05); } if (ok.length) fl.set(k, ok); }
    for (let i = 0; i < m; i++) if (floor[i]) { const a = fl.get(Math.floor(P[i * 3] / 0.3) + ',' + Math.floor(P[i * 3 + 1] / 0.3)); if (!a || !a.some(z => Math.abs(z - P[i * 3 + 2]) < 0.08)) floor[i] = 0; }
    // leave out the 12 cm just above a floor so feet do not join people to the deck, kerbs or low pipes
    const nearFloor = i => { const cx = Math.floor(P[i * 3] / 0.3), cy = Math.floor(P[i * 3 + 1] / 0.3), z = P[i * 3 + 2]; for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const a = fl.get((cx + dx) + ',' + (cy + dy)); if (a) for (const zf of a) if (z - zf > -0.03 && z - zf < 0.12) return true; } return false; };
    const nonF = []; for (let i = 0; i < m; i++) if (!floor[i] && !nearFloor(i)) nonF.push(i);
    onP(0.8); const found = [];
    // columns: non-floor points on a 0.2 m grid; a person is a narrow column 1.45–2.05 m tall with nothing above it
    const cs = 0.2, cells = new Map(); for (const i of nonF) { const k = Math.floor(P[i * 3] / cs) + ',' + Math.floor(P[i * 3 + 1] / cs); let a = cells.get(k); if (!a) cells.set(k, a = []); a.push(i); }
    const around = (cx, cy, r) => { const out = [], R = Math.ceil(r / cs); const ix = Math.floor(cx / cs), iy = Math.floor(cy / cs); for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) { const a = cells.get((ix + dx) + ',' + (iy + dy)); if (a) for (const i of a) { const d = Math.hypot(P[i * 3] - cx, P[i * 3 + 1] - cy); if (d <= r) out.push([i, d]); } } return out; };
    const cands = [];
    for (const [k, list] of cells) {
      const [ix, iy] = k.split(',').map(Number), x = (ix + 0.5) * cs, y = (iy + 0.5) * cs; const fa = fl.get(Math.floor(x / 0.3) + ',' + Math.floor(y / 0.3)); if (!fa) continue;
      for (const zf of fa) {
        let top = -1, cnt = 0, sx = 0, sy = 0, over = 0; for (const i of list) { const h = P[i * 3 + 2] - zf; if (h > 2.05 && h < 2.3) over++; if (h < 1.0 || h > 2.05) continue; cnt++; sx += P[i * 3]; sy += P[i * 3 + 1]; if (h > top) top = h; }
        if (cnt < 8 || top < 1.45 || over) continue; const cx = sx / cnt, cy = sy / cnt;
        const body = around(cx, cy, 0.45).filter(([i]) => { const h = P[i * 3 + 2] - zf; return h > 0.12 && h < 2.3; }); let H = 0, above = 0; for (const [i] of body) { const h = P[i * 3 + 2] - zf; if (h > 2.05) above++; else if (h > H) H = h; }
        if (above || H < 1.45 || body.length < 80) continue;
        const up = body.filter(([i]) => P[i * 3 + 2] - zf > 1.0); let ux = 0, uy = 0; for (const [i] of up) { ux += P[i * 3]; uy += P[i * 3 + 1]; } ux /= up.length; uy /= up.length;
        const wid = (f0, f1) => { let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity, c = 0; for (const [i] of body) { const f = (P[i * 3 + 2] - zf) / H; if (f < f0 || f > f1) continue; a0 = Math.min(a0, P[i * 3]); a1 = Math.max(a1, P[i * 3]); b0 = Math.min(b0, P[i * 3 + 1]); b1 = Math.max(b1, P[i * 3 + 1]); c++; } return c < 4 ? 0 : Math.max(a1 - a0, b1 - b0); };
        const head = wid(0.9, 1.0), sh = wid(0.68, 0.84), legs = wid(0.15, 0.4);
        const ring = around(ux, uy, 0.85).filter(([i, d]) => d > 0.5 && P[i * 3 + 2] - zf > 1.0 && P[i * 3 + 2] - zf < 2.0).length;
        if (opts.debug) console.log('col', (cx).toFixed(2), cy.toFixed(2), 'H', H.toFixed(2), 'n', body.length, 'head', head.toFixed(2), 'sh', sh.toFixed(2), 'legs', legs.toFixed(2), 'ring', ring, 'up', up.length);
        if (!(head > 0.08 && head < 0.36 && sh > 0.3 && sh < 0.85 && sh / head > 1.3)) continue; if (ring > up.length * 0.2) continue;
        cands.push({ c: [ux, uy], zf, H, n: body.length });
      }
    }
    cands.sort((a, b) => b.n - a.n); for (const c of cands) { if (found.some(f => Math.hypot(f.centre[0] - c.c[0], f.centre[1] - c.c[1]) < 0.6 && Math.abs(f.centre[2] - c.zf) < 0.5)) continue; found.push({ lo: [c.c[0] - 0.45, c.c[1] - 0.45, c.zf + 0.03], hi: [c.c[0] + 0.45, c.c[1] + 0.45, c.zf + c.H + 0.06], H: c.H, centre: [c.c[0], c.c[1], c.zf] }); }
    return found;
}
const SBC = { mergeCollinear, detectPeople, components3D, smoothSegments, detectEquipment, fitVessel, fitBox, vesselFaces, boxEquipFaces, fitBetween, joinRuns, describeSteel, detectHandrails, handrailFaces, kdKNN, kdRadius, eig3, voxelAssign, gather, computeNormals, growPlanes, describePlane, fitCircle, classifySection, fitMember, growMember, detectMembers, detectFlanges, findBends, scanToCad, fitAt, cylFaces, discFaces, boxFaces, memberFaces, steelRects, matchPipe, matchSteel, STEEL, PIPE_OD, outline2D, maskOutlines, joinSegments, douglasPeucker, simplifyClosed, polyArea, dilate, erode, perpFrame, normalsAxis, vec: { dot, cross, norm, add } };
if (typeof module !== 'undefined') module.exports = SBC; else G.SBC = SBC;
})();
