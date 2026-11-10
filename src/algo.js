// ===== ScanBench algorithms (no DOM). All positions are Float32 local coords (xyz interleaved). =====
const tickA = () => new Promise(r => setTimeout(r, 0));

// ---- hashed uniform grid over a point set ----
function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }
function hcell(ix, iy, iz, mask) { return ((Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) >>> 0) & mask; }

function buildGrid(pos, n, cell) {
  const T = nextPow2(Math.max(1024, Math.ceil(n * 1.3))), mask = T - 1, inv = 1 / cell;
  const keys = new Uint32Array(n), start = new Uint32Array(T + 1);
  for (let i = 0; i < n; i++) {
    const k = hcell(Math.floor(pos[i * 3] * inv), Math.floor(pos[i * 3 + 1] * inv), Math.floor(pos[i * 3 + 2] * inv), mask);
    keys[i] = k; start[k + 1]++;
  }
  for (let i = 0; i < T; i++) start[i + 1] += start[i];
  const fill = start.slice(0, T), order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[fill[keys[i]]++] = i;
  return { pos, n, cell, inv, mask, start, order };
}

// estimate a cell size giving ~target points per occupied cell
function estimateCell(pos, n, target = 8) {
  const m = Math.min(n, 60000), step = n / m;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let s = 0; s < m; s++) { const i = Math.floor(s * step); for (let k = 0; k < 3; k++) { const v = pos[i * 3 + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; } }
  const ext = mx.map((v, k) => Math.max(v - mn[k], 1e-6));
  let c = Math.cbrt(ext[0] * ext[1] * ext[2] / m) || 0.01;
  for (let it = 0; it < 5; it++) {
    const set = new Set(); const inv = 1 / c;
    for (let s = 0; s < m; s++) { const i = Math.floor(s * step); set.add(Math.floor(pos[i * 3] * inv) * 73856093 + Math.floor(pos[i * 3 + 1] * inv) * 19349663 + Math.floor(pos[i * 3 + 2] * inv) * 83492791); }
    const perCell = m / set.size;
    const f = Math.sqrt(target / Math.max(perCell, 1e-9));
    c *= Math.min(4, Math.max(0.25, f));
    if (Math.abs(f - 1) < 0.15) break;
  }
  return c * Math.sqrt(m / n);
}

// nearest neighbour in grid G to (x,y,z), within maxD. Returns [index, dist^2] (index -1 if none)
const _nn = [-1, 0];
function gridNearest(G, x, y, z, maxD) {
  const { pos, inv, mask, start, order, cell } = G;
  const cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv);
  let best = maxD * maxD, bi = -1;
  const K = Math.max(1, Math.ceil(maxD * inv));
  for (let k = 0; k <= K; k++) {
    for (let dx = -k; dx <= k; dx++) for (let dy = -k; dy <= k; dy++) {
      const edge = Math.abs(dx) === k || Math.abs(dy) === k;
      for (let dz = -k; dz <= k; dz += (edge ? 1 : 2 * k || 1)) {
        const h = hcell(cx + dx, cy + dy, cz + dz, mask);
        for (let q = start[h], e = start[h + 1]; q < e; q++) {
          const j = order[q], ax = pos[j * 3] - x, ay = pos[j * 3 + 1] - y, az = pos[j * 3 + 2] - z;
          const d = ax * ax + ay * ay + az * az;
          if (d < best) { best = d; bi = j; }
        }
        if (k === 0) break;
      }
    }
    if (bi >= 0 && Math.sqrt(best) <= k * cell) break;
  }
  _nn[0] = bi; _nn[1] = best; return _nn;
}

// ---- static KD-tree (implicit, median split, leaves of <=16) ----
async function buildKD(pos, n, onP = () => {}) {
  const idx = new Uint32Array(n); for (let i = 0; i < n; i++) idx[i] = i;
  const LEAF = 16; let size = 1; while (size * LEAF < n) size <<= 1; size <<= 1;
  const axis = new Uint8Array(size), split = new Float32Array(size);
  const coord = (i, a) => pos[idx[i] * 3 + a];
  function select(lo, hi, k, a) { // quickselect on idx[lo..hi) so idx[k] is k-th by axis a
    hi--;
    while (hi > lo) {
      const pv = coord((lo + hi) >> 1, a); let i = lo, j = hi;
      while (i <= j) {
        while (coord(i, a) < pv) i++;
        while (coord(j, a) > pv) j--;
        if (i <= j) { const t = idx[i]; idx[i] = idx[j]; idx[j] = t; i++; j--; }
      }
      if (k <= j) hi = j; else if (k >= i) lo = i; else break;
    }
  }
  const stack = [[0, 0, n]]; let done = 0;
  while (stack.length) {
    const [node, lo, hi] = stack.pop();
    if (hi - lo <= LEAF || node * 2 + 2 >= size) { done += hi - lo; continue; }
    let mn0 = Infinity, mn1 = Infinity, mn2 = Infinity, mx0 = -Infinity, mx1 = -Infinity, mx2 = -Infinity;
    const st = Math.max(1, Math.floor((hi - lo) / 2000));
    for (let i = lo; i < hi; i += st) { const p = idx[i] * 3, x = pos[p], y = pos[p + 1], z = pos[p + 2]; if (x < mn0) mn0 = x; if (x > mx0) mx0 = x; if (y < mn1) mn1 = y; if (y > mx1) mx1 = y; if (z < mn2) mn2 = z; if (z > mx2) mx2 = z; }
    const ex = [mx0 - mn0, mx1 - mn1, mx2 - mn2]; const a = ex[0] >= ex[1] && ex[0] >= ex[2] ? 0 : ex[1] >= ex[2] ? 1 : 2;
    const mid = (lo + hi) >> 1; select(lo, hi, mid, a);
    axis[node] = a; split[node] = coord(mid, a);
    stack.push([node * 2 + 1, lo, mid], [node * 2 + 2, mid, hi]);
    if (hi - lo > 500000) { onP(Math.min(0.99, done / n)); await tickA(); }
  }
  return { pos, n, idx, axis, split, size, LEAF };
}
function kdNearest(K, x, y, z, maxD) {
  const { pos, idx, axis, split, size, LEAF } = K; let best = maxD * maxD, bi = -1;
  const q = [x, y, z];
  function rec(node, lo, hi) {
    if (hi - lo <= LEAF || node * 2 + 2 >= size) {
      for (let i = lo; i < hi; i++) { const p = idx[i] * 3, dx = pos[p] - x, dy = pos[p + 1] - y, dz = pos[p + 2] - z, d = dx * dx + dy * dy + dz * dz; if (d < best) { best = d; bi = idx[i]; } }
      return;
    }
    const a = axis[node], diff = q[a] - split[node], mid = (lo + hi) >> 1;
    if (diff < 0) { rec(node * 2 + 1, lo, mid); if (diff * diff < best) rec(node * 2 + 2, mid, hi); }
    else { rec(node * 2 + 2, mid, hi); if (diff * diff < best) rec(node * 2 + 1, lo, mid); }
  }
  rec(0, 0, K.n);
  _nn[0] = bi; _nn[1] = best; return _nn;
}

// ---- Cloud-to-cloud distance ----
async function c2c(cmp, nc, ref, nr, opts = {}) {
  const maxD = opts.maxDist || 1, onP = opts.onProgress || (() => {});
  const G = await buildKD(ref, nr, p => onP(p * 0.3));
  const out = new Float32Array(nc);
  for (let i = 0; i < nc; i++) {
    const r = kdNearest(G, cmp[i * 3], cmp[i * 3 + 1], cmp[i * 3 + 2], maxD);
    out[i] = r[0] >= 0 ? Math.sqrt(r[1]) : NaN;
    if ((i & 0x1ffff) === 0) { onP(0.3 + 0.7 * i / nc); await tickA(); }
  }
  return out;
}

// ---- mesh grid + cloud-to-mesh signed distance ----
const tkey = (x, y, z) => ((x + 65536) * 131072 + (y + 65536)) * 131072 + (z + 65536);
function buildTriGrid(tris, cell) {
  const nt = tris.length / 9, inv = 1 / cell;
  const lists = new Map();
  let total = 0;
  for (let t = 0; t < nt; t++) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let v = 0; v < 3; v++) { const x = tris[t * 9 + v * 3], y = tris[t * 9 + v * 3 + 1], z = tris[t * 9 + v * 3 + 2]; if (x < x0) x0 = x; if (y < y0) y0 = y; if (z < z0) z0 = z; if (x > x1) x1 = x; if (y > y1) y1 = y; if (z > z1) z1 = z; }
    for (let ix = Math.floor(x0 * inv); ix <= Math.floor(x1 * inv); ix++) for (let iy = Math.floor(y0 * inv); iy <= Math.floor(y1 * inv); iy++) for (let iz = Math.floor(z0 * inv); iz <= Math.floor(z1 * inv); iz++) {
      const key = tkey(ix, iy, iz); let l = lists.get(key); if (!l) { l = []; lists.set(key, l); } l.push(t); total++;
      if (total > 3e7) throw new Error('Mesh grid too fine; increase max distance');
    }
  }
  const normals = new Float32Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    const b = t * 9, ux = tris[b + 3] - tris[b], uy = tris[b + 4] - tris[b + 1], uz = tris[b + 5] - tris[b + 2], vx = tris[b + 6] - tris[b], vy = tris[b + 7] - tris[b + 1], vz = tris[b + 8] - tris[b + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1;
    normals[t * 3] = nx / l; normals[t * 3 + 1] = ny / l; normals[t * 3 + 2] = nz / l;
  }
  return { tris, cell, inv, lists, normals };
}
// closest point on triangle (Ericson), writes into out
function closestOnTri(px, py, pz, T, b, out) {
  const ax = T[b], ay = T[b + 1], az = T[b + 2], bx = T[b + 3], by = T[b + 4], bz = T[b + 5], cx = T[b + 6], cy = T[b + 7], cz = T[b + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { out[0] = ax; out[1] = ay; out[2] = az; return; }
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { out[0] = bx; out[1] = by; out[2] = bz; return; }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); out[0] = ax + v * abx; out[1] = ay + v * aby; out[2] = az + v * abz; return; }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { out[0] = cx; out[1] = cy; out[2] = cz; return; }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); out[0] = ax + w * acx; out[1] = ay + w * acy; out[2] = az + w * acz; return; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); out[0] = bx + w * (cx - bx); out[1] = by + w * (cy - by); out[2] = bz + w * (cz - bz); return; }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  out[0] = ax + abx * v + acx * w; out[1] = ay + aby * v + acy * w; out[2] = az + abz * v + acz * w;
}
async function c2m(cmp, nc, tris, opts = {}) {
  const maxD = opts.maxDist || 0.5, onP = opts.onProgress || (() => {}), signed = opts.signed !== false;
  // cell: about maxD, but not absurdly small relative to mesh
  let cell = Math.max(maxD, 1e-3);
  let MG;
  for (;;) { try { MG = buildTriGrid(tris, cell); break; } catch (e) { cell *= 2; } }
  const { lists, normals, inv } = MG; const cp = [0, 0, 0];
  const out = new Float32Array(nc); const K = Math.max(1, Math.ceil(maxD * inv));
  for (let i = 0; i < nc; i++) {
    const x = cmp[i * 3], y = cmp[i * 3 + 1], z = cmp[i * 3 + 2];
    const cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv);
    let best = maxD * maxD, bt = -1, bx = 0, by = 0, bz = 0;
    for (let dx = -K; dx <= K; dx++) for (let dy = -K; dy <= K; dy++) for (let dz = -K; dz <= K; dz++) {
      const l = lists.get(tkey(cx + dx, cy + dy, cz + dz)); if (l === undefined) continue;
      for (let q = 0; q < l.length; q++) {
        const t = l[q]; closestOnTri(x, y, z, tris, t * 9, cp);
        const ax = x - cp[0], ay = y - cp[1], az = z - cp[2], d = ax * ax + ay * ay + az * az;
        if (d < best) { best = d; bt = t; bx = ax; by = ay; bz = az; }
      }
    }
    if (bt < 0) out[i] = NaN;
    else {
      let d = Math.sqrt(best);
      if (signed && bx * normals[bt * 3] + by * normals[bt * 3 + 1] + bz * normals[bt * 3 + 2] < 0) d = -d;
      out[i] = d;
    }
    if ((i & 0xffff) === 0) { onP(i / nc); await tickA(); }
  }
  return out;
}

// ---- symmetric eigen (Jacobi) ----
function jacobiEigen(A, n) { // A: array n*n (copied). returns {values, vectors (columns)}
  const a = A.slice(), v = new Array(n * n).fill(0); for (let i = 0; i < n; i++) v[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0; for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      const apq = a[p * n + q]; if (Math.abs(apq) < 1e-30) continue;
      const th = (a[q * n + q] - a[p * n + p]) / (2 * apq);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const akp = a[k * n + p], akq = a[k * n + q]; a[k * n + p] = c * akp - s * akq; a[k * n + q] = s * akp + c * akq; }
      for (let k = 0; k < n; k++) { const apk = a[p * n + k], aqk = a[q * n + k]; a[p * n + k] = c * apk - s * aqk; a[q * n + k] = s * apk + c * aqk; }
      for (let k = 0; k < n; k++) { const vkp = v[k * n + p], vkq = v[k * n + q]; v[k * n + p] = c * vkp - s * vkq; v[k * n + q] = s * vkp + c * vkq; }
    }
  }
  const values = []; for (let i = 0; i < n; i++) values.push(a[i * n + i]);
  return { values, vectors: v };
}

// ---- plane fit (least squares) on index subset or all ----
function fitPlane(pos, idx) {
  let n = idx ? idx.length : pos.length / 3, sx = 0, sy = 0, sz = 0;
  const get = k => idx ? idx[k] : k;
  for (let k = 0; k < n; k++) { const i = get(k); sx += pos[i * 3]; sy += pos[i * 3 + 1]; sz += pos[i * 3 + 2]; }
  const c = [sx / n, sy / n, sz / n]; const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let k = 0; k < n; k++) {
    const i = get(k), x = pos[i * 3] - c[0], y = pos[i * 3 + 1] - c[1], z = pos[i * 3 + 2] - c[2];
    C[0] += x * x; C[1] += x * y; C[2] += x * z; C[4] += y * y; C[5] += y * z; C[8] += z * z;
  }
  C[3] = C[1]; C[6] = C[2]; C[7] = C[5];
  const e = jacobiEigen(C, 3); let mi = 0; for (let i = 1; i < 3; i++) if (e.values[i] < e.values[mi]) mi = i;
  let nrm = [e.vectors[mi], e.vectors[3 + mi], e.vectors[6 + mi]];
  if (nrm[2] < 0 || (Math.abs(nrm[2]) < 1e-9 && nrm[0] < 0)) nrm = nrm.map(v => -v);
  let ss = 0, mn = Infinity, mx = -Infinity;
  for (let k = 0; k < n; k++) { const i = get(k); const d = (pos[i * 3] - c[0]) * nrm[0] + (pos[i * 3 + 1] - c[1]) * nrm[1] + (pos[i * 3 + 2] - c[2]) * nrm[2]; ss += d * d; if (d < mn) mn = d; if (d > mx) mx = d; }
  const dip = Math.acos(Math.min(1, Math.abs(nrm[2]))) * 180 / Math.PI;
  return { centroid: c, normal: nrm, rms: Math.sqrt(ss / n), min: mn, max: mx, n, dipDeg: dip };
}
function planeDistances(pos, n, plane) {
  const out = new Float32Array(n), c = plane.centroid, m = plane.normal;
  for (let i = 0; i < n; i++) out[i] = (pos[i * 3] - c[0]) * m[0] + (pos[i * 3 + 1] - c[1]) * m[1] + (pos[i * 3 + 2] - c[2]) * m[2];
  return out;
}

// ---- rigid transform from correspondences (Horn quaternion) ----
// P (moving) -> Q (fixed), arrays of [x,y,z]
function bestRigid(P, Q, W) {
  const n = P.length; let wsum = 0; const pc = [0, 0, 0], qc = [0, 0, 0];
  for (let i = 0; i < n; i++) { const w = W ? W[i] : 1; wsum += w; for (let k = 0; k < 3; k++) { pc[k] += w * P[i][k]; qc[k] += w * Q[i][k]; } }
  for (let k = 0; k < 3; k++) { pc[k] /= wsum; qc[k] /= wsum; }
  const S = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) { const w = W ? W[i] : 1; for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) S[a * 3 + b] += w * (P[i][a] - pc[a]) * (Q[i][b] - qc[b]); }
  const [Sxx, Sxy, Sxz, Syx, Syy, Syz, Szx, Szy, Szz] = S;
  const N = [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx,
    Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz,
    Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy,
    Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz];
  const e = jacobiEigen(N, 4); let mi = 0; for (let i = 1; i < 4; i++) if (e.values[i] > e.values[mi]) mi = i;
  const q = [e.vectors[mi], e.vectors[4 + mi], e.vectors[8 + mi], e.vectors[12 + mi]];
  const [w, x, y, z] = q;
  const R = [w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z];
  const t = [qc[0] - (R[0] * pc[0] + R[1] * pc[1] + R[2] * pc[2]), qc[1] - (R[3] * pc[0] + R[4] * pc[1] + R[5] * pc[2]), qc[2] - (R[6] * pc[0] + R[7] * pc[1] + R[8] * pc[2])];
  let ss = 0; for (let i = 0; i < n; i++) { const p = P[i]; for (let k = 0; k < 3; k++) { const v = R[k * 3] * p[0] + R[k * 3 + 1] * p[1] + R[k * 3 + 2] * p[2] + t[k] - Q[i][k]; ss += v * v; } }
  return { R, t, rms: Math.sqrt(ss / n) };
}
function composeRT(A, B) { // returns B∘A (apply A then B)
  const R = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R[i * 3 + j] = B.R[i * 3] * A.R[j] + B.R[i * 3 + 1] * A.R[3 + j] + B.R[i * 3 + 2] * A.R[6 + j];
  const t = [0, 1, 2].map(i => B.R[i * 3] * A.t[0] + B.R[i * 3 + 1] * A.t[1] + B.R[i * 3 + 2] * A.t[2] + B.t[i]);
  return { R, t };
}
function applyRT(pos, n, T) {
  const R = T.R, t = T.t;
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    pos[i * 3] = R[0] * x + R[1] * y + R[2] * z + t[0];
    pos[i * 3 + 1] = R[3] * x + R[4] * y + R[5] * z + t[1];
    pos[i * 3 + 2] = R[6] * x + R[7] * y + R[8] * z + t[2];
  }
}

// ---- ICP (point-to-point, trimmed) ----
async function icp(mov, nm, ref, nr, opts = {}) {
  const sample = Math.min(nm, opts.sample || 50000), iters = opts.iterations || 40, overlap = opts.overlap || 0.9;
  let maxD = opts.maxDist || 1; const onP = opts.onProgress || (() => {});
  const G = await buildKD(ref, nr);
  const S = new Float64Array(sample * 3);
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let s = 0; s < sample; s++) { const i = sample === nm ? s : Math.floor(rnd() * nm); S[s * 3] = mov[i * 3]; S[s * 3 + 1] = mov[i * 3 + 1]; S[s * 3 + 2] = mov[i * 3 + 2]; }
  let T = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }, prev = Infinity, rms = 0, used = 0, it = 0;
  const history = [];
  for (it = 0; it < iters; it++) {
    const pairs = [];
    for (let s = 0; s < sample; s++) {
      const x = S[s * 3], y = S[s * 3 + 1], z = S[s * 3 + 2];
      const px = T.R[0] * x + T.R[1] * y + T.R[2] * z + T.t[0], py = T.R[3] * x + T.R[4] * y + T.R[5] * z + T.t[1], pz = T.R[6] * x + T.R[7] * y + T.R[8] * z + T.t[2];
      const r = kdNearest(G, px, py, pz, maxD);
      if (r[0] >= 0) pairs.push([r[1], px, py, pz, r[0]]);
    }
    if (pairs.length < 3) throw new Error('ICP found too few overlapping points. Bring the clouds closer first, or raise the search distance.');
    pairs.sort((a, b) => a[0] - b[0]);
    const keep = pairs.slice(0, Math.max(3, Math.floor(pairs.length * overlap)));
    const P = keep.map(p => [p[1], p[2], p[3]]), Q = keep.map(p => [ref[p[4] * 3], ref[p[4] * 3 + 1], ref[p[4] * 3 + 2]]);
    const step = bestRigid(P, Q);
    T = composeRT(T, step);
    rms = Math.sqrt(keep.reduce((a, p) => a + p[0], 0) / keep.length); used = keep.length;
    history.push(rms);
    maxD = Math.max(maxD * 0.85, rms * 4, (opts.maxDist || 1) * 0.05);
    onP((it + 1) / iters); await tickA();
    if (Math.abs(prev - rms) < 1e-7 * Math.max(1, rms) || rms < 1e-9) break;
    prev = rms;
  }
  return { T, rms, pairs: used, iterations: it + 1, history };
}

// ---- voxel subsample: keep the point closest to each voxel centre ----
function voxelSubsample(pos, n, cell) {
  const inv = 1 / cell; const m = new Map();
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { const v = pos[i * 3 + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
  const ny = Math.floor((mx[1] - mn[1]) * inv) + 1, nz = Math.floor((mx[2] - mn[2]) * inv) + 1;
  const nxx = Math.floor((mx[0] - mn[0]) * inv) + 1;
  if (nxx * ny * nz > 9e15) throw new Error('Spacing too small for this extent. Use a larger spacing.');
  let bestI = new Uint32Array(1024), bestD = new Float32Array(1024), cnt = 0;
  for (let i = 0; i < n; i++) {
    const fx = (pos[i * 3] - mn[0]) * inv, fy = (pos[i * 3 + 1] - mn[1]) * inv, fz = (pos[i * 3 + 2] - mn[2]) * inv;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    const key = (ix * ny + iy) * nz + iz;
    const dx = fx - ix - 0.5, dy = fy - iy - 0.5, dz = fz - iz - 0.5, d = dx * dx + dy * dy + dz * dz;
    const s = m.get(key);
    if (s === undefined) {
      if (cnt === bestI.length) { const a = new Uint32Array(cnt * 2); a.set(bestI); bestI = a; const b = new Float32Array(cnt * 2); b.set(bestD); bestD = b; }
      m.set(key, cnt); bestI[cnt] = i; bestD[cnt] = d; cnt++;
    } else if (d < bestD[s]) { bestI[s] = i; bestD[s] = d; }
  }
  const out = bestI.slice(0, cnt); out.sort(); return out;
}
function randomSubsample(n, target) {
  if (target >= n) return Uint32Array.from({ length: n }, (_, i) => i);
  const out = new Uint32Array(target); const step = n / target;
  for (let k = 0; k < target; k++) out[k] = Math.min(n - 1, Math.floor(k * step + (k * 2654435761 % 1000) / 1000 * step));
  return out;
}

// ---- radius outlier removal: returns Uint8 mask (1 = keep) ----
async function radiusOutliers(pos, n, r, minN, onP = () => {}) {
  const G = buildGrid(pos, n, r), keep = new Uint8Array(n), r2 = r * r, seen = new Int32Array(27);
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const cx = Math.floor(x * G.inv), cy = Math.floor(y * G.inv), cz = Math.floor(z * G.inv);
    let cnt = 0, ns = 0;
    outer: for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const h = hcell(cx + dx, cy + dy, cz + dz, G.mask);
      let dup = false; for (let s = 0; s < ns; s++) if (seen[s] === h) { dup = true; break; }
      if (dup) continue; seen[ns++] = h;
      for (let q = G.start[h], e = G.start[h + 1]; q < e; q++) {
        const j = G.order[q]; if (j === i) continue;
        const ax = pos[j * 3] - x, ay = pos[j * 3 + 1] - y, az = pos[j * 3 + 2] - z;
        if (ax * ax + ay * ay + az * az <= r2 && ++cnt >= minN) break outer;
      }
    }
    keep[i] = cnt >= minN ? 1 : 0;
    if ((i & 0x3ffff) === 0) { onP(i / n); await tickA(); }
  }
  return keep;
}

// ---- 2D raster (DTM) ----
function rasterize(pos, n, cell, mode = 'min', mask) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) { if (mask && !mask[i]) continue; const x = pos[i * 3], y = pos[i * 3 + 1]; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  const nx = Math.floor((x1 - x0) / cell) + 1, ny = Math.floor((y1 - y0) / cell) + 1;
  if (nx * ny > 4e7) throw new Error('Grid too large (' + nx + ' × ' + ny + '). Use a bigger cell size.');
  const z = new Float32Array(nx * ny).fill(NaN), cnt = new Uint32Array(nx * ny);
  for (let i = 0; i < n; i++) {
    if (mask && !mask[i]) continue;
    const ix = Math.floor((pos[i * 3] - x0) / cell), iy = Math.floor((pos[i * 3 + 1] - y0) / cell), k = iy * nx + ix, v = pos[i * 3 + 2];
    if (!cnt[k]) z[k] = v; else if (mode === 'min') { if (v < z[k]) z[k] = v; } else if (mode === 'max') { if (v > z[k]) z[k] = v; } else z[k] += v;
    cnt[k]++;
  }
  if (mode === 'mean') for (let k = 0; k < z.length; k++) if (cnt[k]) z[k] /= cnt[k];
  return { x0, y0, cell, nx, ny, z, cnt };
}
function fillHoles(R, passes = 3) {
  const { nx, ny } = R; let z = R.z;
  for (let p = 0; p < passes; p++) {
    const nz = z.slice(); let filled = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i; if (!isNaN(z[k])) continue;
      let s = 0, c = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= nx || b >= ny) continue; const v = z[b * nx + a]; if (!isNaN(v)) { s += v; c++; } }
      if (c >= 3) { nz[k] = s / c; filled++; }
    }
    z = nz; if (!filled) break;
  }
  R.z = z; return R;
}
// simple ground filter: local-minimum surface, then height threshold. returns Uint8 mask (1 = ground)
function groundFilter(pos, n, cell, h) {
  const R = rasterize(pos, n, cell, 'min');
  // open: take the min of neighbours, then max (removes small objects sitting on cells)
  const { nx, ny } = R; const er = new Float32Array(nx * ny).fill(NaN);
  const W = 1;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { let m = Infinity; for (let dj = -W; dj <= W; dj++) for (let di = -W; di <= W; di++) { const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= nx || b >= ny) continue; const v = R.z[b * nx + a]; if (!isNaN(v) && v < m) m = v; } if (m < Infinity) er[j * nx + i] = m; }
  const di2 = new Float32Array(nx * ny).fill(NaN);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { let m = -Infinity; for (let dj = -W; dj <= W; dj++) for (let di = -W; di <= W; di++) { const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= nx || b >= ny) continue; const v = er[b * nx + a]; if (!isNaN(v) && v > m) m = v; } if (m > -Infinity) di2[j * nx + i] = m; }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const ix = Math.floor((pos[i * 3] - R.x0) / cell), iy = Math.floor((pos[i * 3 + 1] - R.y0) / cell);
    const g = di2[iy * nx + ix]; out[i] = !isNaN(g) && pos[i * 3 + 2] - g <= h ? 1 : 0;
  }
  return out;
}
// marching squares contours on raster, returns [{level, pts:[[x,y,z]...]}]
function contours(R, interval, base = 0) {
  const { nx, ny, z, x0, y0, cell } = R;
  let zmin = Infinity, zmax = -Infinity; for (const v of z) if (!isNaN(v)) { if (v < zmin) zmin = v; if (v > zmax) zmax = v; }
  const lines = [];
  if (!(zmax > zmin)) return lines;
  const first = Math.ceil((zmin - base) / interval) * interval + base;
  const cx = i => x0 + (i + 0.5) * cell, cy = j => y0 + (j + 0.5) * cell;
  for (let L = first; L <= zmax; L += interval) {
    const segs = [];
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = z[j * nx + i], b = z[j * nx + i + 1], c = z[(j + 1) * nx + i + 1], d = z[(j + 1) * nx + i];
      if (isNaN(a) || isNaN(b) || isNaN(c) || isNaN(d)) continue;
      const idx = (a > L ? 1 : 0) | (b > L ? 2 : 0) | (c > L ? 4 : 0) | (d > L ? 8 : 0);
      if (idx === 0 || idx === 15) continue;
      const e = [
        [cx(i) + (L - a) / (b - a) * cell, cy(j)], [cx(i + 1), cy(j) + (L - b) / (c - b) * cell],
        [cx(i) + (L - d) / (c - d) * cell, cy(j + 1)], [cx(i), cy(j) + (L - a) / (d - a) * cell]];
      const T = { 1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 5: [[3, 0], [1, 2]], 6: [[0, 2]], 7: [[3, 2]], 8: [[2, 3]], 9: [[0, 2]], 10: [[0, 1], [2, 3]], 11: [[1, 2]], 12: [[1, 3]], 13: [[0, 1]], 14: [[0, 3]] }[idx];
      for (const [p, q] of T) segs.push([e[p], e[q]]);
    }
    // join segments into polylines
    const key = p => Math.round(p[0] * 1e4) + ',' + Math.round(p[1] * 1e4);
    const adj = new Map();
    segs.forEach((s, k) => { for (const end of [0, 1]) { const kk = key(s[end]); if (!adj.has(kk)) adj.set(kk, []); adj.get(kk).push(k); } });
    const used = new Uint8Array(segs.length);
    for (let s0 = 0; s0 < segs.length; s0++) {
      if (used[s0]) continue; used[s0] = 1;
      const pts = [segs[s0][0], segs[s0][1]];
      for (const dir of [1, -1]) {
        for (;;) {
          const tip = dir === 1 ? pts[pts.length - 1] : pts[0];
          const cand = (adj.get(key(tip)) || []).find(k => !used[k]); if (cand === undefined) break;
          used[cand] = 1; const s = segs[cand]; const nxt = key(s[0]) === key(tip) ? s[1] : s[0];
          if (dir === 1) pts.push(nxt); else pts.unshift(nxt);
        }
      }
      lines.push({ level: L, pts: pts.map(p => [p[0], p[1], L]) });
    }
  }
  return lines;
}
function volumeVsPlane(R, zref) {
  let cut = 0, fill = 0, area = 0; const a = R.cell * R.cell;
  for (const v of R.z) { if (isNaN(v)) continue; area += a; if (v > zref) cut += (v - zref) * a; else fill += (zref - v) * a; }
  return { cut, fill, net: cut - fill, area };
}

// ---- statistics / histogram ----
function stats(arr, n) {
  let c = 0, s = 0, s2 = 0, mn = Infinity, mx = -Infinity, sa = 0;
  for (let i = 0; i < n; i++) { const v = arr[i]; if (!isFinite(v)) continue; c++; s += v; s2 += v * v; sa += Math.abs(v); if (v < mn) mn = v; if (v > mx) mx = v; }
  const mean = s / c; return { count: c, mean, std: Math.sqrt(Math.max(0, s2 / c - mean * mean)), rms: Math.sqrt(s2 / c), meanAbs: sa / c, min: mn, max: mx, invalid: n - c };
}
function histogram(arr, n, lo, hi, bins) {
  const h = new Uint32Array(bins); const w = (hi - lo) / bins;
  for (let i = 0; i < n; i++) { const v = arr[i]; if (!isFinite(v)) continue; let b = Math.floor((v - lo) / w); if (b < 0) b = 0; if (b >= bins) b = bins - 1; h[b]++; }
  return h;
}

const SBA = { buildKD, kdNearest, buildGrid, estimateCell, gridNearest, c2c, c2m, closestOnTri, jacobiEigen, fitPlane, planeDistances, bestRigid, composeRT, applyRT, icp, voxelSubsample, randomSubsample, radiusOutliers, rasterize, fillHoles, groundFilter, contours, volumeVsPlane, stats, histogram };
if (typeof module !== 'undefined') module.exports = SBA; else (typeof globalThis !== 'undefined' ? globalThis : window).SBA = SBA;
