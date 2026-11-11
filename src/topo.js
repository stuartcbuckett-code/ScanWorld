// ===== ScanBench topographic engine: ground, classes, TIN, breaklines, contours, features (no DOM) =====
(function () {
const G = typeof globalThis !== 'undefined' ? globalThis : window;
const AL = typeof module !== 'undefined' ? require('./algo.js') : G.SBA;
const C = typeof module !== 'undefined' ? require('./cad.js') : G.SBC;
const Delaunator = typeof module !== 'undefined' ? (() => { const vm = require('vm'), fs = require('fs'), path = require('path'); const ctx = { self: {} }; ctx.globalThis = ctx.self; vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../node_modules/delaunator/delaunator.min.js'), 'utf8'), ctx); return ctx.self.Delaunator || ctx.Delaunator; })() : G.Delaunator;
const tickT = () => new Promise(r => setTimeout(r, 0));

// ---------- grids ----------
function gridOf(P, n, cell, mask) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) { if (mask && !mask[i]) continue; const x = P[i * 3], y = P[i * 3 + 1]; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  const nx = Math.floor((x1 - x0) / cell) + 1, ny = Math.floor((y1 - y0) / cell) + 1;
  if (nx * ny > 3e7) throw new Error('Area too large for a ' + cell + ' m grid. Use a bigger cell.');
  return { x0, y0, cell, nx, ny };
}
function cellIndex(g, x, y) { const i = Math.floor((x - g.x0) / g.cell), j = Math.floor((y - g.y0) / g.cell); return (i < 0 || j < 0 || i >= g.nx || j >= g.ny) ? -1 : j * g.nx + i; }
function minGrid(P, n, g, mask) { const z = new Float32Array(g.nx * g.ny).fill(NaN); for (let i = 0; i < n; i++) { if (mask && !mask[i]) continue; const k = cellIndex(g, P[i * 3], P[i * 3 + 1]); if (k < 0) continue; const v = P[i * 3 + 2]; if (!(v >= z[k])) z[k] = v; } return z; }
function fillNaN(z, nx, ny, passes = 50) {
  let cur = z; for (let p = 0; p < passes; p++) {
    const nz = cur.slice(); let left = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const k = j * nx + i; if (!isNaN(cur[k])) continue; let s = 0, c = 0; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= nx || b >= ny) continue; const v = cur[b * nx + a]; if (!isNaN(v)) { s += v; c++; } } if (c) nz[k] = s / c; else left++; }
    cur = nz; if (!left) break;
  }
  return cur;
}
// separable min / max filter with square window radius w (cells)
function minmax(z, nx, ny, w, isMax) {
  const tmp = new Float32Array(z.length), out = new Float32Array(z.length);
  const f = isMax ? Math.max : Math.min;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { let m = isMax ? -Infinity : Infinity; for (let d = -w; d <= w; d++) { const a = i + d; if (a < 0 || a >= nx) continue; m = f(m, z[j * nx + a]); } tmp[j * nx + i] = m; }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { let m = isMax ? -Infinity : Infinity; for (let d = -w; d <= w; d++) { const b = j + d; if (b < 0 || b >= ny) continue; m = f(m, tmp[b * nx + i]); } out[j * nx + i] = m; }
  return out;
}
function bilinear(R, x, y) {
  const fx = (x - R.x0) / R.cell - 0.5, fy = (y - R.y0) / R.cell - 0.5;
  let i = Math.floor(fx), j = Math.floor(fy); const tx = fx - i, ty = fy - j;
  const at = (a, b) => R.z[Math.max(0, Math.min(R.ny - 1, b)) * R.nx + Math.max(0, Math.min(R.nx - 1, a))];
  return at(i, j) * (1 - tx) * (1 - ty) + at(i + 1, j) * tx * (1 - ty) + at(i, j + 1) * (1 - tx) * ty + at(i + 1, j + 1) * tx * ty;
}

// ---------- progressive morphological filter (Zhang et al. 2003) ----------
function pmfGround(P, n, opts = {}) {
  const cell = opts.cell || 0.5, slope = opts.slope ?? 0.3, dh0 = opts.dh0 ?? 0.15, dhMax = opts.dhMax ?? 2.5, maxW = opts.maxWindow || 20;
  const g = gridOf(P, n, cell); const raw = minGrid(P, n, g);
  const has = new Uint8Array(raw.length); for (let k = 0; k < raw.length; k++) has[k] = isNaN(raw[k]) ? 0 : 1;
  let surf = fillNaN(raw, g.nx, g.ny);
  const flag = new Uint8Array(raw.length); // 1 = cell min is non-ground
  let wPrev = 0;
  for (let w = 1; w * cell <= maxW; w *= 2) {
    const opened = minmax(minmax(surf, g.nx, g.ny, w, false), g.nx, g.ny, w, true);
    const dh = Math.min(dhMax, (w - wPrev) * 2 * cell * slope + dh0);
    for (let k = 0; k < surf.length; k++) if (surf[k] - opened[k] > dh) flag[k] = 1;
    surf = opened; wPrev = w;
  }
  // ground surface: cell minima that survived, re-interpolated
  const gz = new Float32Array(raw.length).fill(NaN); for (let k = 0; k < raw.length; k++) if (has[k] && !flag[k]) gz[k] = raw[k];
  const R = Object.assign({ z: fillNaN(gz, g.nx, g.ny, 200), has }, g);
  const tol = opts.groundTol ?? 0.15; const ground = new Uint8Array(n);
  for (let i = 0; i < n; i++) ground[i] = P[i * 3 + 2] - bilinear(R, P[i * 3], P[i * 3 + 1]) <= tol ? 1 : 0;
  return { ground, R };
}

// ---------- classification ----------
// ASPRS: 2 ground, 3 low veg, 4 med veg, 5 high veg, 6 building, 7 low noise, 1 unclassified
async function classify(P, n, opts = {}, onP = () => {}) {
  const { ground, R } = pmfGround(P, n, opts); onP(0.25); await tickT();
  const hag = new Float32Array(n); for (let i = 0; i < n; i++) hag[i] = P[i * 3 + 2] - bilinear(R, P[i * 3], P[i * 3 + 1]);
  const N = opts.normalsFn ? await opts.normalsFn(P, n, 12, f => onP(0.25 + f * 0.5)) : await C.computeNormals(P, n, 12, f => onP(0.25 + f * 0.5));
  const cls = new Uint8Array(n);
  // planar clusters above ground -> buildings / structures
  const PL = await C.growPlanes(P, n, N, { angleDeg: 12, distTol: opts.planeTol || 0.06, minPts: 60 }, () => {});
  const isBld = new Uint8Array(n);
  for (const pl of PL.planes) {
    let h = 0; for (const i of pl.idx) h += hag[i]; h /= pl.idx.length;
    const D = C.describePlane(P, pl, opts.spacing || 0.1, -1e9);
    if (h > (opts.bldMinH || 1.5) && D.area > (opts.bldMinArea || 6)) for (const i of pl.idx) isBld[i] = 1;
  }
  for (let i = 0; i < n; i++) {
    const h = hag[i];
    if (ground[i]) cls[i] = 2;
    else if (h < -0.5) cls[i] = 7;
    else if (isBld[i]) cls[i] = 6;
    else if (N.curv[i] > 0.03 || h > 0.3) cls[i] = h < 0.5 ? 3 : h < 2 ? 4 : 5;
    else cls[i] = 1;
  }
  // edges and corners of buildings look rough: points within one cell of a building cell join the building
  { const bc = 0.5, g = gridOf(P, n, bc), bm = new Uint8Array(g.nx * g.ny); for (let i = 0; i < n; i++) if (cls[i] === 6) bm[cellIndex(g, P[i * 3], P[i * 3 + 1])] = 1;
    const dm = C.dilate(bm, g.nx, g.ny, 1); for (let i = 0; i < n; i++) if ((cls[i] === 5 || cls[i] === 4 || cls[i] === 1) && hag[i] > 1.0 && dm[cellIndex(g, P[i * 3], P[i * 3 + 1])]) cls[i] = 6; }
  // linear planar-ish things that are not buildings stay unclassified (walls, fences, poles handled as features)
  onP(1);
  return { cls, hag, R, N };
}

// ---------- TIN ----------
function tinPoints(P, n, cls, cell) { // one ground point per cell (median z), returns indices
  const g = gridOf(P, n, cell, cls ? (cls.map ? null : null) : null); const buckets = new Map();
  for (let i = 0; i < n; i++) { if (cls && cls[i] !== 2) continue; const k = cellIndex(g, P[i * 3], P[i * 3 + 1]); let b = buckets.get(k); if (!b) buckets.set(k, b = []); b.push(i); }
  const out = []; for (const b of buckets.values()) { b.sort((a, c) => P[a * 3 + 2] - P[c * 3 + 2]); out.push(b[b.length >> 1]); }
  return out;
}
function buildTIN(xyz, maxEdge) { // xyz: array of [x,y,z]
  const coords = new Float64Array(xyz.length * 2); xyz.forEach((p, i) => { coords[i * 2] = p[0]; coords[i * 2 + 1] = p[1]; });
  const d = new Delaunator(coords); const T = d.triangles; const keep = [];
  const m2 = maxEdge * maxEdge;
  for (let t = 0; t < T.length; t += 3) {
    const a = xyz[T[t]], b = xyz[T[t + 1]], c = xyz[T[t + 2]];
    const e = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
    if (e(a, b) > m2 || e(b, c) > m2 || e(c, a) > m2) continue;
    keep.push(T[t], T[t + 1], T[t + 2]);
  }
  return { pts: xyz, tris: Uint32Array.from(keep) };
}
function tinContours(tin, interval, base = 0) {
  const { pts, tris } = tin; let zmin = Infinity, zmax = -Infinity; for (const p of pts) { if (p[2] < zmin) zmin = p[2]; if (p[2] > zmax) zmax = p[2]; }
  const out = []; if (!(zmax > zmin)) return out;
  const first = Math.ceil((zmin - base) / interval - 1e-9) * interval + base;
  const byLevel = new Map();
  for (let t = 0; t < tris.length; t += 3) {
    const A = pts[tris[t]], B = pts[tris[t + 1]], Cc = pts[tris[t + 2]];
    const lo = Math.min(A[2], B[2], Cc[2]), hi = Math.max(A[2], B[2], Cc[2]);
    let L = Math.ceil((lo - base) / interval - 1e-9) * interval + base;
    for (; L <= hi; L += interval) {
      if (L === lo && L === hi) continue;
      const cut = [];
      const E = [[A, B], [B, Cc], [Cc, A]];
      for (const [p, q] of E) { const zp = p[2] - L, zq = q[2] - L; if ((zp < 0 && zq >= 0) || (zp >= 0 && zq < 0)) { const f = zp / (zp - zq); cut.push([p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f]); } }
      if (cut.length === 2) { const key = L.toFixed(6); let a = byLevel.get(key); if (!a) byLevel.set(key, a = { L, segs: [] }); a.segs.push(cut); }
    }
  }
  for (const { L, segs } of byLevel.values()) for (const line of C.joinSegments(segs)) out.push({ level: L, pts: line.map(p => [p[0], p[1], L]) });
  return out.sort((a, b) => a.level - b.level);
}
function smoothTin(tin, iters = 2) { // contouring surface: each vertex moves halfway to the mean of its neighbours, so scan noise does not become contour specks
  const { pts, tris } = tin, n = pts.length; let z = Float64Array.from(pts, p => p[2]);
  for (let k = 0; k < iters; k++) { const s = new Float64Array(n), c = new Uint32Array(n);
    for (let t = 0; t < tris.length; t += 3) { const a = tris[t], b = tris[t + 1], d = tris[t + 2]; s[a] += z[b] + z[d]; s[b] += z[a] + z[d]; s[d] += z[a] + z[b]; c[a] += 2; c[b] += 2; c[d] += 2; }
    const q = new Float64Array(n); for (let i = 0; i < n; i++) q[i] = c[i] ? 0.5 * z[i] + 0.5 * s[i] / c[i] : z[i]; z = q; }
  return { pts: pts.map((p, i) => [p[0], p[1], z[i]]), tris };
}
function niceInterval(relief, levels = 50) { const want = relief / levels; for (const v of [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 50]) if (v >= want) return v; return 100; }
function lineZ(tin, grid, line) { // heights for a plan line on the surface; points that fall off the surface take the height of the nearest point along the line that is on it
  const z = line.map(p => tinZ(tin, p[0], p[1], grid)), n = z.length, ok = i => Number.isFinite(z[i]); if (!z.some((v, i) => ok(i))) return line.map(p => [p[0], p[1], tin.pts[0][2]]);
  return line.map((p, i) => { if (ok(i)) return [p[0], p[1], z[i]]; for (let d = 1; d < n; d++) { const a = (i + d) % n, b = (i - d + n * 2) % n; if (ok(a)) return [p[0], p[1], z[a]]; if (ok(b)) return [p[0], p[1], z[b]]; } return [p[0], p[1], 0]; });
}
function smoothLine(pts, iters = 2) { // Chaikin, keeps ends (or closure)
  let p = pts; const closed = p.length > 3 && Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) < 1e-6;
  for (let k = 0; k < iters; k++) {
    const q = closed ? [] : [p[0]];
    for (let i = 0; i < p.length - 1; i++) { const a = p[i], b = p[i + 1]; q.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25, a[2]], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75, a[2]]); }
    if (closed) q.push(q[0]); else q.push(p[p.length - 1]); p = q;
  }
  return p;
}
function tinZ(tin, x, y, grid) { // point-in-triangle via a coarse bucket grid
  if (!grid) return NaN; const k = Math.floor((x - grid.x0) / grid.c) + Math.floor((y - grid.y0) / grid.c) * grid.nx; const list = grid.b.get(k); if (!list) return NaN;
  const { pts, tris } = tin;
  for (const t of list) {
    const A = pts[tris[t]], B = pts[tris[t + 1]], Cc = pts[tris[t + 2]];
    const d = (B[1] - Cc[1]) * (A[0] - Cc[0]) + (Cc[0] - B[0]) * (A[1] - Cc[1]); if (!d) continue;
    const l1 = ((B[1] - Cc[1]) * (x - Cc[0]) + (Cc[0] - B[0]) * (y - Cc[1])) / d, l2 = ((Cc[1] - A[1]) * (x - Cc[0]) + (A[0] - Cc[0]) * (y - Cc[1])) / d, l3 = 1 - l1 - l2;
    if (l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9) return l1 * A[2] + l2 * B[2] + l3 * Cc[2];
  }
  return NaN;
}
function tinIndex(tin, c) {
  const { pts, tris } = tin; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  const nx = Math.floor((x1 - x0) / c) + 1; const b = new Map();
  for (let t = 0; t < tris.length; t += 3) {
    const A = pts[tris[t]], B = pts[tris[t + 1]], Cc = pts[tris[t + 2]];
    const i0 = Math.floor((Math.min(A[0], B[0], Cc[0]) - x0) / c), i1 = Math.floor((Math.max(A[0], B[0], Cc[0]) - x0) / c), j0 = Math.floor((Math.min(A[1], B[1], Cc[1]) - y0) / c), j1 = Math.floor((Math.max(A[1], B[1], Cc[1]) - y0) / c);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const k = j * nx + i; let l = b.get(k); if (!l) b.set(k, l = []); l.push(t); }
  }
  return { x0, y0, c, nx, b };
}

// ---------- breaklines from a fine ground DTM ----------
function breaklines(P, n, cls, opts = {}) {
  const cell = opts.cell || 0.25; const mask = new Uint8Array(n); for (let i = 0; i < n; i++) mask[i] = cls[i] === 2 ? 1 : 0;
  const g = gridOf(P, n, cell, mask);
  // mean ground z per cell
  const s = new Float64Array(g.nx * g.ny), c = new Uint32Array(g.nx * g.ny);
  for (let i = 0; i < n; i++) { if (!mask[i]) continue; const k = cellIndex(g, P[i * 3], P[i * 3 + 1]); s[k] += P[i * 3 + 2]; c[k]++; }
  const z0 = new Float32Array(g.nx * g.ny).fill(NaN); for (let k = 0; k < z0.length; k++) if (c[k]) z0[k] = s[k] / c[k];
  const has = new Uint8Array(z0.length); for (let k = 0; k < z0.length; k++) has[k] = c[k] ? 1 : 0;
  // light smoothing (3x3 mean of valid) to suppress noise
  const { nx, ny } = g; let z = fillNaN(z0, nx, ny, 3);
  const zs = new Float32Array(z.length); for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { let a = 0, q = 0; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const x = i + di, y = j + dj; if (x < 0 || y < 0 || x >= nx || y >= ny) continue; const v = z[y * nx + x]; if (!isNaN(v)) { a += v; q++; } } zs[j * nx + i] = q ? a / q : NaN; }
  z = zs;
  const at = (i, j) => z[Math.max(0, Math.min(ny - 1, j)) * nx + Math.max(0, Math.min(nx - 1, i))];
  const K = new Float32Array(nx * ny), dirx = new Float32Array(nx * ny), diry = new Float32Array(nx * ny);
  const h = cell;
  for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const k = j * nx + i; if (!has[k]) continue;
    const zx = (at(i + 1, j) - at(i - 1, j)) / (2 * h), zy = (at(i, j + 1) - at(i, j - 1)) / (2 * h);
    const zxx = (at(i + 1, j) - 2 * at(i, j) + at(i - 1, j)) / (h * h), zyy = (at(i, j + 1) - 2 * at(i, j) + at(i, j - 1)) / (h * h), zxy = (at(i + 1, j + 1) - at(i + 1, j - 1) - at(i - 1, j + 1) + at(i - 1, j - 1)) / (4 * h * h);
    const gg = zx * zx + zy * zy;
    let kk, dx, dy;
    if (gg > 1e-8) { kk = (zxx * zx * zx + 2 * zxy * zx * zy + zyy * zy * zy) / gg; const l = Math.sqrt(gg); dx = zx / l; dy = zy / l; }
    else { kk = 0; dx = 1; dy = 0; }
    if (!isFinite(kk)) kk = 0;
    // change in grade across one cell ~ kk*h ; store as grade change per cell
    K[k] = kk * h; dirx[k] = dx; diry[k] = dy;
  }
  const hi = opts.gradeChange ?? 0.25, lo = hi * 0.5; // e.g. 25% change of grade
  const edge = new Uint8Array(nx * ny);
  for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const k = j * nx + i, v = Math.abs(K[k]); if (v < lo) continue;
    const ox = Math.round(dirx[k]), oy = Math.round(diry[k]);
    const a = Math.abs(K[(j + oy) * nx + i + ox]), b = Math.abs(K[(j - oy) * nx + i - ox]);
    if (v >= a && v >= b) edge[k] = v >= hi ? 2 : 1;
  }
  // hysteresis
  const stack = []; for (let k = 0; k < edge.length; k++) if (edge[k] === 2) stack.push(k);
  while (stack.length) { const k = stack.pop(); const i = k % nx, j = (k / nx) | 0; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const q = (j + dj) * nx + i + di; if (edge[q] === 1) { edge[q] = 2; stack.push(q); } } }
  // trace chains
  const seen = new Uint8Array(nx * ny); const lines = [];
  const nb = k => { const i = k % nx, j = (k / nx) | 0, out = []; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { if (!di && !dj) continue; const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= nx || b >= ny) continue; const q = b * nx + a; if (edge[q] === 2 && !seen[q] && Math.sign(K[q]) === Math.sign(K[k])) out.push(q); } return out; };
  for (let k0 = 0; k0 < edge.length; k0++) {
    if (edge[k0] !== 2 || seen[k0]) continue;
    seen[k0] = 1; const chain = [k0];
    for (const dir of [1, -1]) {
      let cur = k0;
      for (;;) { const nn = nb(cur); if (!nn.length) break; const nx2 = nn[0]; seen[nx2] = 1; if (dir === 1) chain.push(nx2); else chain.unshift(nx2); cur = nx2; }
    }
    const len = chain.length * cell; if (len < (opts.minLen || 2)) continue;
    const sign = K[chain[chain.length >> 1]];
    const pts = chain.map(k => { const i = k % nx, j = (k / nx) | 0; const x = g.x0 + (i + 0.5) * cell, y = g.y0 + (j + 0.5) * cell;
      // take extreme of the original cell means nearby: top (convex) = max, toe (concave) = min
      let best = sign < 0 ? -Infinity : Infinity; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const v = z0[(j + dj) * nx + i + di]; if (isNaN(v)) continue; if (sign < 0 ? v > best : v < best) best = v; }
      return [x, y, isFinite(best) ? best : at(i, j)]; });
    lines.push({ kind: sign < 0 ? 'top' : 'toe', pts: C.douglasPeucker(pts, opts.simplify || cell * 0.6) });
  }
  return { lines, grid: Object.assign({ z: z0, has }, g) };
}

// ---------- features ----------
function components2D(P, n, sel, cell) { // grid connected components of selected points; returns [{idx:[...]}]
  const g = gridOf(P, n, cell, sel); const cellPts = new Map();
  for (let i = 0; i < n; i++) { if (!sel[i]) continue; const k = cellIndex(g, P[i * 3], P[i * 3 + 1]); let l = cellPts.get(k); if (!l) cellPts.set(k, l = []); l.push(i); }
  const lab = new Map(); const comps = [];
  for (const k of cellPts.keys()) {
    if (lab.has(k)) continue; const id = comps.length; const st = [k]; lab.set(k, id); const idx = [];
    while (st.length) { const q = st.pop(); idx.push(...cellPts.get(q)); const i = q % g.nx, j = (q / g.nx) | 0; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= g.nx || b >= g.ny) continue; const r = b * g.nx + a; if (cellPts.has(r) && !lab.has(r)) { lab.set(r, id); st.push(r); } } }
    comps.push({ idx });
  }
  return comps;
}
function trees(P, n, cls, hag, opts = {}) {
  const cell = opts.cell || 0.5, minH = opts.minH || 2.5; const sel = new Uint8Array(n); for (let i = 0; i < n; i++) sel[i] = cls[i] === 5 && hag[i] <= (opts.maxH || 70) ? 1 : 0;   // stray high returns (birds, noise) are not tree tops
  let cnt = 0; for (const v of sel) cnt += v; if (cnt < 20) return [];
  const g = gridOf(P, n, cell, sel); const chm = new Float32Array(g.nx * g.ny).fill(NaN), top = new Float32Array(g.nx * g.ny).fill(NaN);
  for (let i = 0; i < n; i++) { if (!sel[i]) continue; const k = cellIndex(g, P[i * 3], P[i * 3 + 1]); if (!(hag[i] <= chm[k])) { chm[k] = hag[i]; top[k] = P[i * 3 + 2]; } }
  // smooth CHM slightly, local maxima with radius depending on height
  const { nx, ny } = g; const tops = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, v = chm[k]; if (!(v >= minH)) continue;
    const r = Math.max(1, Math.round(Math.min(4, 0.6 + v * 0.12) / cell)); let isMax = true;
    for (let dj = -r; dj <= r && isMax; dj++) for (let di = -r; di <= r; di++) { if (!di && !dj) continue; if (di * di + dj * dj > r * r) continue; const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= nx || b >= ny) continue; const w = chm[b * nx + a]; if (w > v || (w === v && b * nx + a < k)) { isMax = false; break; } }
    if (isMax) tops.push(k);
  }
  // assign canopy cells to nearest top by descending region growing (simple watershed)
  const owner = new Int32Array(nx * ny).fill(-1); const order = []; for (let k = 0; k < chm.length; k++) if (!isNaN(chm[k])) order.push(k);
  order.sort((a, b) => chm[b] - chm[a]); tops.forEach((k, t) => owner[k] = t);
  for (let pass = 0; pass < 3; pass++) for (const k of order) {
    if (owner[k] >= 0) continue; const i = k % nx, j = (k / nx) | 0; let best = -1, bh = -Infinity;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= nx || b >= ny) continue; const q = b * nx + a; if (owner[q] >= 0 && chm[q] >= chm[k] - 0.01 && chm[q] > bh) { bh = chm[q]; best = owner[q]; } }
    if (best >= 0) owner[k] = best;
  }
  const out = tops.map((k, t) => ({ x: g.x0 + (k % nx + 0.5) * cell, y: g.y0 + (((k / nx) | 0) + 0.5) * cell, height: chm[k], topZ: top[k], cells: 0 }));
  for (let k = 0; k < owner.length; k++) if (owner[k] >= 0) out[owner[k]].cells++;
  for (const T of out) { T.spread = 2 * Math.sqrt(T.cells * cell * cell / Math.PI); T.groundZ = T.topZ - T.height; }
  return out.filter(T => T.cells >= 2 && T.spread >= (opts.minSpread || 1.5));
}
function structures(P, n, cls, hag, opts = {}) {
  const res = { buildings: [], poles: [], walls: [] };
  // buildings: class 6 components
  const sel = new Uint8Array(n); for (let i = 0; i < n; i++) sel[i] = cls[i] === 6 ? 1 : 0;
  for (const c of components2D(P, n, sel, opts.bldCell || 0.5)) {
    if (c.idx.length < 30) continue; const xy = new Float64Array(c.idx.length * 2); let zmax = -Infinity, hmax = 0, gz = 0;
    c.idx.forEach((i, q) => { xy[q * 2] = P[i * 3]; xy[q * 2 + 1] = P[i * 3 + 1]; if (P[i * 3 + 2] > zmax) zmax = P[i * 3 + 2]; hmax = Math.max(hmax, hag[i]); gz += P[i * 3 + 2] - hag[i]; });
    const o = C.outline2D(xy, c.idx.length, opts.bldCell || 0.5, 0.25, 2); if (!o.loops.length || o.area < (opts.bldMinArea || 6)) continue;
    res.buildings.push({ loop: o.loops[0], area: o.area, roofZ: zmax, height: hmax, groundZ: gz / c.idx.length });
  }
  // poles / walls / fences: unclassified points 0.3 m+ above ground
  const sel2 = new Uint8Array(n); for (let i = 0; i < n; i++) sel2[i] = (cls[i] === 1 || cls[i] === 3 || cls[i] === 4 || cls[i] === 5) && hag[i] > 0.3 ? 1 : 0;
  for (const c of components2D(P, n, sel2, 0.25)) {
    if (c.idx.length < 15) continue; const m = c.idx.length; let sx = 0, sy = 0, hmax = 0, gz = 0;
    for (const i of c.idx) { sx += P[i * 3]; sy += P[i * 3 + 1]; hmax = Math.max(hmax, hag[i]); gz += P[i * 3 + 2] - hag[i]; } sx /= m; sy /= m; gz /= m;
    let a = 0, b = 0, d = 0; for (const i of c.idx) { const x = P[i * 3] - sx, y = P[i * 3 + 1] - sy; a += x * x; b += x * y; d += y * y; } a /= m; b /= m; d /= m;
    const tr = a + d, det = a * d - b * b, l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det)), l2 = Math.max(0, tr / 2 - Math.sqrt(Math.max(0, tr * tr / 4 - det)));
    const len = Math.sqrt(12 * l1), wid = Math.sqrt(12 * l2);
    if (len < 0.6 && hmax > 2) { res.poles.push({ x: sx, y: sy, groundZ: gz, height: hmax, dia: Math.max(len, wid) }); for (const i of c.idx) cls[i] = 1; }
    else if (len > 2 && wid < 0.6 && hmax < 3.5) { for (const i of c.idx) cls[i] = 1;
      const ex = [b, l1 - a]; let ux = Math.abs(b) > 1e-12 ? b : (a >= d ? 1 : 0), uy = Math.abs(b) > 1e-12 ? l1 - a : (a >= d ? 0 : 1); const ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul;
      let t0 = Infinity, t1 = -Infinity; for (const i of c.idx) { const t = (P[i * 3] - sx) * ux + (P[i * 3 + 1] - sy) * uy; t0 = Math.min(t0, t); t1 = Math.max(t1, t); }
      res.walls.push({ a: [sx + ux * t0, sy + uy * t0], b: [sx + ux * t1, sy + uy * t1], height: hmax, groundZ: gz, length: t1 - t0, width: wid });
    }
  }
  return res;
}
function spotLevels(tin, idxGrid, spacing, R) {
  const out = []; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of tin.pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  const sx = Math.ceil(x0 / spacing) * spacing, sy = Math.ceil(y0 / spacing) * spacing;
  for (let y = sy; y <= y1; y += spacing) for (let x = sx; x <= x1; x += spacing) { const z = tinZ(tin, x, y, idxGrid); if (isFinite(z)) out.push([x, y, z]); }
  return out;
}
function extentOf(P, n, cls, cell) { const sel = []; for (let i = 0; i < n; i++) if (cls[i] === 2) sel.push(P[i * 3], P[i * 3 + 1]); const o = C.outline2D(Float64Array.from(sel), sel.length / 2, cell, cell * 0.8, 2); return o.loops[0] || null; }

// ---------- full topo pipeline ----------
async function topoSurvey(pos, n, opts = {}, onP = () => {}) {
  const st = (a, b) => f => onP(a + (b - a) * f);
  const spacing = opts.spacing || 0.1;
  const vox = C.voxelAssign(pos, n, spacing); let reps = vox.reps;
  const cap = opts.maxPoints || 2500000; if (reps.length > cap) { const s = Math.ceil(reps.length / cap); reps = reps.filter((_, i) => i % s === 0); }
  const P = C.gather(pos, reps), m = reps.length; onP(0.03); await tickT();
  const CL = await classify(P, m, Object.assign({ spacing }, opts), st(0.03, 0.55));
  // map classes back to every source point via its voxel
  const slotCls = new Uint8Array(vox.reps.length); const slotOf = new Int32Array(vox.reps.length).fill(-1); reps.forEach((r, j) => { slotOf[vox.assign[r]] = j; });
  for (let s = 0; s < slotCls.length; s++) slotCls[s] = slotOf[s] >= 0 ? CL.cls[slotOf[s]] : 1;
  onP(0.6); await tickT();
  const BL = opts.breaklines === false ? { lines: [] } : breaklines(P, m, CL.cls, { cell: opts.blCell || 0.25, gradeChange: opts.gradeChange ?? 0.25, minLen: opts.blMinLen || 2 });
  onP(0.7); await tickT();
  // TIN: thinned ground + breakline vertices (densified), ground points near breaklines removed
  const tinCell = opts.tinCell || 0.5; const gi = tinPoints(P, m, CL.cls, tinCell);
  const blPts = []; const dens = tinCell * 0.5;
  for (const L of BL.lines) for (let k = 0; k < L.pts.length - 1; k++) { const a = L.pts[k], b = L.pts[k + 1], d = Math.hypot(b[0] - a[0], b[1] - a[1]), s = Math.max(1, Math.ceil(d / dens)); for (let q = 0; q < s; q++) blPts.push([a[0] + (b[0] - a[0]) * q / s, a[1] + (b[1] - a[1]) * q / s, a[2] + (b[2] - a[2]) * q / s]); if (k === L.pts.length - 2) blPts.push(b); }
  const near = new Set(); if (blPts.length) { const cg = new Map(), cc = tinCell * 0.4; for (const p of blPts) cg.set(Math.floor(p[0] / cc) + ',' + Math.floor(p[1] / cc), 1); gi.forEach((i, q) => { const kx = Math.floor(P[i * 3] / cc), ky = Math.floor(P[i * 3 + 1] / cc); for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (cg.has((kx + a) + ',' + (ky + b))) near.add(q); }); }
  const xyz = []; gi.forEach((i, q) => { if (!near.has(q)) xyz.push([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]); }); for (const p of blPts) xyz.push(p);
  const tin = buildTIN(xyz, opts.maxEdge || Math.max(5, tinCell * 8)); onP(0.8); await tickT();
  const idxGrid = tinIndex(tin, Math.max(1, tinCell * 4));
  const STc = structures(P, m, CL.cls, CL.hag, {}); onP(0.86); await tickT();
  const TR = opts.trees === false ? [] : trees(P, m, CL.cls, CL.hag, {}); onP(0.92); await tickT();
  const spots = spotLevels(tin, idxGrid, opts.spotSpacing || 5);
  const extent = extentOf(P, m, CL.cls, Math.max(0.5, tinCell));
  let counts = {}; for (const c of CL.cls) counts[c] = (counts[c] || 0) + 1;
  onP(1);
  return { spacing, P, m, cls: CL.cls, hag: CL.hag, slotCls, assign: vox.assign, breaklines: BL.lines, tin, idxGrid, trees: TR, ...STc, spots, extent, counts };
}

// ---------- exports ----------
function landXML(tin, breaks, origin, name, units = 'meter') {
  const o = origin, f = v => v.toFixed(4); const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>', '<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2" date="' + new Date().toISOString().slice(0, 10) + '" time="' + new Date().toISOString().slice(11, 19) + '">',
    '<Units><Metric areaUnit="squareMeter" linearUnit="' + units + '" volumeUnit="cubicMeter" temperatureUnit="celsius" pressureUnit="milliBars" angularUnit="decimal degrees" directionUnit="decimal degrees"/></Units>',
    '<Application name="ScanBench" version="1"/>', '<Surfaces>', '<Surface name="' + name + '">', '<Definition surfType="TIN">', '<Pnts>');
  // LandXML points are "northing easting elevation"
  tin.pts.forEach((p, i) => L.push('<P id="' + (i + 1) + '">' + f(p[1] + o[1]) + ' ' + f(p[0] + o[0]) + ' ' + f(p[2] + o[2]) + '</P>'));
  L.push('</Pnts>', '<Faces>');
  for (let t = 0; t < tin.tris.length; t += 3) L.push('<F>' + (tin.tris[t] + 1) + ' ' + (tin.tris[t + 1] + 1) + ' ' + (tin.tris[t + 2] + 1) + '</F>');
  L.push('</Faces>', '</Definition>');
  if (breaks && breaks.length) {
    L.push('<SourceData>', '<Breaklines>');
    breaks.forEach((b, i) => L.push('<Breakline name="BL' + (i + 1) + '" desc="' + b.kind + '" brkType="standard"><PntList3D>' + b.pts.map(p => f(p[1] + o[1]) + ' ' + f(p[0] + o[0]) + ' ' + f(p[2] + o[2])).join(' ') + '</PntList3D></Breakline>'));
    L.push('</Breaklines>', '</SourceData>');
  }
  L.push('</Surface>', '</Surfaces>', '</LandXML>');
  return L.join('\n');
}


// ---------- vegetation analysis and bushfire hazard ----------
function circleFit(xy) { // least-squares circle through plan points [[x,y]…]
  const n = xy.length; let mx = 0, my = 0; for (const q of xy) { mx += q[0]; my += q[1]; } mx /= n; my /= n;
  let suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const q of xy) { const u = q[0] - mx, v = q[1] - my; suu += u * u; suv += u * v; svv += v * v; suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u; }
  const det = suu * svv - suv * suv; if (Math.abs(det) < 1e-12) return null;
  const a = 0.5 * (suuu + suvv), b = 0.5 * (svvv + svuu), uc = (a * svv - b * suv) / det, vc = (b * suu - a * suv) / det, r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  let ss = 0; const sect = new Uint8Array(12); for (const q of xy) { const dx = q[0] - mx - uc, dy = q[1] - my - vc; ss += (Math.hypot(dx, dy) - r) ** 2; sect[Math.min(11, Math.floor((Math.atan2(dy, dx) + Math.PI) / (Math.PI / 6)))] = 1; }
  return { x: mx + uc, y: my + vc, r, rms: Math.sqrt(ss / n), arc: sect.reduce((p, q) => p + q, 0) * 30 };
}
const pct = (a, f) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * f))] : NaN;
function vegetation(t, opts = {}) {
  const { P, m, cls, hag } = t, cell = opts.cell || 1, trees = (t.trees || []).filter(T => T.height <= (opts.maxTreeHeight || 70) && !(T.height > 40 && T.spread < 0.12 * T.height));   // very tall and pencil-thin is a mast, wire or stray return, not a tree
  const NS = opts.nearSurface || [0.1, 0.6], EL = opts.elevated || [0.6, 3];
  // strata grid
  const g = gridOf(P, m, cell), N = g.nx * g.ny; const seen = new Uint8Array(N), ns = new Uint8Array(N), elv = new Uint8Array(N), can = new Uint8Array(N), elTop = new Float32Array(N), canBase = new Float32Array(N).fill(Infinity), canTop = new Float32Array(N);
  // trees: bucket grid for point → tree
  const bc = 4, bk = new Map(); trees.forEach((T, i) => { const R = Math.max(1, T.spread * 0.6); for (let a = Math.floor((T.x - R) / bc); a <= Math.floor((T.x + R) / bc); a++) for (let b = Math.floor((T.y - R) / bc); b <= Math.floor((T.y + R) / bc); b++) { const k = a + ',' + b; let l = bk.get(k); if (!l) bk.set(k, l = []); l.push(i); } });
  const crown = trees.map(() => []), bh = [];
  for (let i = 0; i < m; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], h = hag[i], c = cls[i], k = cellIndex(g, x, y); if (k < 0) continue; seen[k] = 1;
    const veg = c === 3 || c === 4 || c === 5;
    if (veg) { if (h >= NS[0] && h < NS[1]) ns[k] = 1; else if (h >= EL[0] && h < EL[1]) { elv[k] = 1; if (h > elTop[k]) elTop[k] = h; } else if (h >= EL[1]) { can[k] = 1; if (h < canBase[k]) canBase[k] = h; if (h > canTop[k]) canTop[k] = h; } }
    if (c !== 2 && h >= 1.0 && h <= 1.6) bh.push(i);
    if (!trees.length || c === 2 || c === 6) continue;
    const l = bk.get(Math.floor(x / bc) + ',' + Math.floor(y / bc)); if (!l) continue; let best = -1, bd = Infinity;
    for (const ti of l) { const T = trees[ti], d = Math.hypot(x - T.x, y - T.y); if (d <= Math.max(1, T.spread * 0.6) && d / Math.max(1, T.spread) < bd) { bd = d / Math.max(1, T.spread); best = ti; } }
    if (best >= 0 && c === 5) crown[best].push(h);
  }
  const outT = trees.map((T, i) => {
    const hs = Float32Array.from(crown[i]).sort(); const cbh = hs.length >= 8 ? Math.max(0.3, pct(hs, 0.05)) : NaN, area = Math.PI * (T.spread / 2) ** 2, depth = isFinite(cbh) ? Math.max(0, T.height - cbh) : NaN;
    const dbh = null, tx = T.x, ty = T.y;
    return { id: i + 1, x: T.x, y: T.y, groundZ: T.groundZ, height: T.height, spread: T.spread, crownArea: area, crownBase: cbh, crownDepth: depth, crownVolume: isFinite(depth) ? 2 / 3 * area * depth : NaN, dbh, trunkX: tx, trunkY: ty, returns: hs.length };
  });
  // stems: clusters of returns at breast height that fit a circle; each goes to the crown it stands under, or becomes a tree of its own
  const sc = 0.2, cellsB = new Map(); for (const i of bh) { const k = Math.floor(P[i * 3] / sc) + ',' + Math.floor(P[i * 3 + 1] / sc); let l = cellsB.get(k); if (!l) cellsB.set(k, l = []); l.push(i); }
  const done = new Set(), stems = [];
  for (const k0 of cellsB.keys()) { if (done.has(k0)) continue; const comp = [], st = [k0]; done.add(k0);
    while (st.length) { const k = st.pop(); comp.push(k); const [a, b] = k.split(',').map(Number); for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) { const q = (a + da) + ',' + (b + db); if (cellsB.has(q) && !done.has(q)) { done.add(q); st.push(q); } } }
    if (comp.length > 80) continue; const xy = []; for (const k of comp) for (const i of cellsB.get(k)) xy.push([P[i * 3], P[i * 3 + 1], P[i * 3 + 2] - hag[i]]); if (xy.length < 10) continue;
    const f = circleFit(xy); if (!f || f.r < 0.04 || f.r > 0.6 || f.rms > Math.max(0.012, 0.1 * f.r) || f.arc < 150) continue;
    stems.push({ x: f.x, y: f.y, dbh: 2 * f.r, gz: xy.reduce((p, q) => p + q[2], 0) / xy.length }); }
  for (const S2 of stems.sort((a, b) => b.dbh - a.dbh)) { let best = null, bd = Infinity; for (const T of outT) { if (T.dbh) continue; const d = Math.hypot(T.x - S2.x, T.y - S2.y); if (d <= Math.max(1.5, (T.spread || 0) * 0.5) && d < bd) { bd = d; best = T; } }
    if (best) { best.dbh = S2.dbh; best.trunkX = S2.x; best.trunkY = S2.y; continue; }
    const ci = Math.floor((S2.x - g.x0) / cell), cj = Math.floor((S2.y - g.y0) / cell); let top = 0, base = Infinity; for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) { const a = ci + di, b = cj + dj; if (a < 0 || b < 0 || a >= g.nx || b >= g.ny) continue; const k = b * g.nx + a; if (canTop[k] > top) top = canTop[k]; if (canBase[k] < base) base = canBase[k]; }
    if (top < 2.5 || top > Math.min(opts.maxTreeHeight || 70, 100 * S2.dbh)) continue;   // nothing overhead, or far too tall for the stem: a post or a wall edge, not a tree
    outT.push({ id: outT.length + 1, x: S2.x, y: S2.y, groundZ: S2.gz, height: top, spread: NaN, crownArea: NaN, crownBase: Number.isFinite(base) ? base : NaN, crownDepth: Number.isFinite(base) ? top - base : NaN, crownVolume: NaN, dbh: S2.dbh, trunkX: S2.x, trunkY: S2.y, returns: 0, fromStem: true }); }
  let aS = 0, aC = 0, aE = 0, aN = 0; for (let k = 0; k < N; k++) if (seen[k]) { aS++; aC += can[k]; aE += elv[k]; aN += ns[k]; }
  const hsort = outT.map(T => T.height).sort((a, b) => a - b), cb = outT.map(T => T.crownBase).filter(isFinite), dbhs = outT.filter(T => T.dbh).map(T => T.dbh), ha = aS * cell * cell / 1e4;
  const stand = { areaHa: ha, trees: outT.length, stemsPerHa: ha ? outT.length / ha : 0, canopyCover: aS ? aC / aS : 0, elevatedCover: aS ? aE / aS : 0, nearSurfaceCover: aS ? aN / aS : 0, heightMean: hsort.length ? hsort.reduce((a, b) => a + b, 0) / hsort.length : 0, heightP95: pct(hsort, 0.95) || 0, heightMax: hsort.length ? hsort[hsort.length - 1] : 0, crownBaseMean: cb.length ? cb.reduce((a, b) => a + b, 0) / cb.length : NaN, trunksMeasured: dbhs.length, dbhMean: dbhs.length ? dbhs.reduce((a, b) => a + b, 0) / dbhs.length : NaN };
  return { trees: outT, stand, grid: g, seen, ns, elv, can, elTop, canBase, canTop, NS, EL };
}
// Northern jarrah litter depth (mm) → litter weight (t/ha); beyond the table the last slope is carried on
const LITTER_TABLE = [[0, 0], [5, 2.7], [10, 5.3], [15, 8], [20, 11], [25, 13], [30, 16], [35, 19], [40, 21], [45, 24], [50, 27]];
function litterLoad(mm) { if (!(mm > 0)) return 0; const T = LITTER_TABLE; for (let i = 1; i < T.length; i++) if (mm <= T[i][0]) return T[i - 1][1] + (T[i][1] - T[i - 1][1]) * (mm - T[i - 1][0]) / (T[i][0] - T[i - 1][0]); return 27 + (mm - 50) * 0.54; }
const FIRE_CLASSES = [{ name: 'No fuel', max: 0, color: 0x6f7780 }, { name: 'Low', max: 500, color: 0x4caf50 }, { name: 'Moderate', max: 2000, color: 0xffd54a }, { name: 'High', max: 4000, color: 0xff9800 }, { name: 'Very high', max: 10000, color: 0xe53935 }, { name: 'Extreme', max: Infinity, color: 0x8e24aa }];
function inPolyXY(x, y, poly) { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; }
function fireHazard(t, veg, opts = {}) {
  const ffdi = opts.ffdi ?? 80, fmc = opts.fmc ?? 100, flam = opts.flammability ?? 2, perM = opts.scrubPerMetre ?? 4, dCan = opts.litterCanopy ?? 70, dOpen = opts.litterOpen ?? 0, zones = opts.zones || [];
  const g = veg.grid, k0 = Math.max(1, Math.round((opts.cell || 5) / g.cell)), nx = Math.ceil(g.nx / k0), ny = Math.ceil(g.ny / k0), C = k0 * g.cell; const cells = [];
  const zAt = (x, y) => tinZ(t.tin, x, y, t.idxGrid);
  for (let J = 0; J < ny; J++) for (let I = 0; I < nx; I++) {
    let n = 0, cc = 0, ce = 0, cn = 0, eh = 0; const cbs = [];
    for (let j = J * k0; j < Math.min(g.ny, (J + 1) * k0); j++) for (let i = I * k0; i < Math.min(g.nx, (I + 1) * k0); i++) { const k = j * g.nx + i; if (!veg.seen[k]) continue; n++; if (veg.can[k]) { cc++; cbs.push(veg.canBase[k]); } if (veg.elv[k]) { ce++; eh += veg.elTop[k]; } cn += veg.ns[k]; }
    if (n < k0 * k0 * 0.25) continue;
    const x = g.x0 + (I + 0.5) * C, y = g.y0 + (J + 0.5) * C, z = zAt(x, y); if (!Number.isFinite(z)) continue;
    const h = C / 2, zx0 = zAt(x - h, y), zx1 = zAt(x + h, y), zy0 = zAt(x, y - h), zy1 = zAt(x, y + h); const gx = Number.isFinite(zx0) && Number.isFinite(zx1) ? (zx1 - zx0) / C : 0, gy = Number.isFinite(zy0) && Number.isFinite(zy1) ? (zy1 - zy0) / C : 0;
    const slope = Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI, covC = cc / n, covE = ce / n, covN = cn / n, elH = ce ? eh / ce : 0; cbs.sort((a, b) => a - b); const cbh = cbs.length ? pct(cbs, 0.25) : NaN;
    let depth = covC >= 0.2 ? dCan : dOpen, zone = null; for (const Z of zones) if (inPolyXY(x, y, Z.poly)) { depth = Z.depth; zone = Z.name || 'zone'; }
    const wL = litterLoad(depth), wS = flam * (perM * elH * covE + perM * 0.35 * covN), Wall = wL + wS, W = Math.min(Wall, opts.maxFuel ?? 25);
    const R = 0.0012 * ffdi * W * Math.exp(0.069 * Math.min(20, slope)), flame = W > 0 ? Math.max(0, 13 * R + 0.24 * W - 2) : 0, I0 = 18600 * (W / 10) * (R / 3.6);   // km/h, m, kW/m
    const crit = Number.isFinite(cbh) ? Math.pow(0.010 * cbh * (460 + 25.9 * fmc), 1.5) : Infinity, crownFire = covC >= 0.3 && I0 >= crit, ladder = covC >= 0.2 && covE >= 0.2 && Number.isFinite(cbh) && cbh - elH < 1.5;
    let rating = 0; if (W > 0) { rating = 1; while (rating < 5 && I0 >= FIRE_CLASSES[rating].max) rating++; }
    cells.push({ x, y, z, slope, canopy: covC, elevated: covE, nearSurface: covN, elevatedHeight: elH, crownBase: cbh, litterDepth: depth, litterLoad: wL, scrubLoad: wS, fuelTotal: Wall, fuel: W, ros: R * 1000, flame, intensity: I0, crownFire, ladder, rating, zone });
  }
  const area = new Array(6).fill(0); let cf = 0, lf = 0, mi = 0, si = 0, sw = 0; for (const c of cells) { area[c.rating] += C * C; if (c.crownFire) cf++; if (c.ladder) lf++; mi = Math.max(mi, c.intensity); si += c.intensity; sw += c.fuel; }
  const tot = cells.length * C * C;
  return { cell: C, cells, classes: FIRE_CLASSES, inputs: { ffdi, fmc, flammability: flam, scrubPerMetre: perM, litterCanopy: dCan, litterOpen: dOpen, zones: zones.length }, summary: { areaHa: tot / 1e4, areaByClass: area.map(a => a / 1e4), crownFireShare: cells.length ? cf / cells.length : 0, ladderShare: cells.length ? lf / cells.length : 0, intensityMax: mi, intensityMean: cells.length ? si / cells.length : 0, fuelMean: cells.length ? sw / cells.length : 0 } };
}
const SBT = { vegetation, fireHazard, litterLoad, circleFit, FIRE_CLASSES, smoothTin, niceInterval, lineZ, pmfGround, classify, tinPoints, buildTIN, tinContours, smoothLine, tinZ, tinIndex, breaklines, trees, structures, spotLevels, topoSurvey, landXML, bilinear, components2D };
if (typeof module !== 'undefined') module.exports = SBT; else G.SBT = SBT;
})();
