// ===== ScanBench coordinate systems: GDA94 / GDA2020, MGA zones, WA project grids, local grids (no DOM) =====
(function () {
const G = typeof globalThis !== 'undefined' ? globalThis : window;
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
// GRS80 (both GDA94 and GDA2020)
const A_ = 6378137, F_ = 1 / 298.257222101, E2 = F_ * (2 - F_), E_ = Math.sqrt(E2);
const n = F_ / (2 - F_), n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n;
const AA = A_ / (1 + n) * (1 + n2 / 4 + n4 / 64 + n6 / 256);
const ALPHA = [n / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180 - 127 * n5 / 288 + 7891 * n6 / 37800,
  13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440 + 281 * n5 / 630 - 1983433 * n6 / 1935360,
  61 * n3 / 240 - 103 * n4 / 140 + 15061 * n5 / 26880 + 167603 * n6 / 181440,
  49561 * n4 / 161280 - 179 * n5 / 168 + 6601661 * n6 / 7257600,
  34729 * n5 / 80640 - 3418889 * n6 / 1995840,
  212378941 * n6 / 319334400];
const BETA = [n / 2 - 2 * n2 / 3 + 37 * n3 / 96 - n4 / 360 - 81 * n5 / 512 + 96199 * n6 / 604800,
  n2 / 48 + n3 / 15 - 437 * n4 / 1440 + 46 * n5 / 105 - 1118711 * n6 / 3870720,
  17 * n3 / 480 - 37 * n4 / 840 - 209 * n5 / 4480 + 5569 * n6 / 90720,
  4397 * n4 / 161280 - 11 * n5 / 504 - 830251 * n6 / 7257600,
  4583 * n5 / 161280 - 108847 * n6 / 3991680,
  20648693 * n6 / 638668800];

// Transverse Mercator (Krüger series to n^6 — sub-millimetre within ±40° of the CM)
function tmForward(latDeg, lonDeg, p) {
  const phi = latDeg * D2R, lam = (lonDeg - p.lon0) * D2R;
  const s = Math.sin(phi);
  const t = Math.sinh(Math.atanh(s) - E_ * Math.atanh(E_ * s));
  const xi1 = Math.atan2(t, Math.cos(lam)), eta1 = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let xi = xi1, eta = eta1;
  for (let j = 1; j <= 6; j++) { xi += ALPHA[j - 1] * Math.sin(2 * j * xi1) * Math.cosh(2 * j * eta1); eta += ALPHA[j - 1] * Math.cos(2 * j * xi1) * Math.sinh(2 * j * eta1); }
  return [p.fe + p.k0 * AA * eta, p.fn + p.k0 * AA * xi];
}
function tmInverse(E, N, p) {
  const xi = (N - p.fn) / (p.k0 * AA), eta = (E - p.fe) / (p.k0 * AA);
  let xi1 = xi, eta1 = eta;
  for (let j = 1; j <= 6; j++) { xi1 -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta); eta1 -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta); }
  const sh = Math.sinh(eta1), c = Math.cos(xi1);
  const tau1 = Math.sin(xi1) / Math.sqrt(sh * sh + c * c);
  let tau = tau1;
  for (let it = 0; it < 6; it++) {
    const sig = Math.sinh(E_ * Math.atanh(E_ * tau / Math.sqrt(1 + tau * tau)));
    const ti = tau * Math.sqrt(1 + sig * sig) - sig * Math.sqrt(1 + tau * tau);
    const dt = (tau1 - ti) / Math.sqrt(1 + ti * ti) * (1 + (1 - E2) * tau * tau) / ((1 - E2) * Math.sqrt(1 + tau * tau));
    tau += dt; if (Math.abs(dt) < 1e-14) break;
  }
  return [Math.atan(tau) * R2D, p.lon0 + Math.atan2(sh, c) * R2D];
}
// point scale factor and grid convergence (numerical, at a geographic position)
function tmScale(latDeg, lonDeg, p) {
  const d = 1e-6, phi = latDeg * D2R;
  const [e0, n0] = tmForward(latDeg, lonDeg, p), [e1, n1] = tmForward(latDeg, lonDeg + d, p);
  const Nr = A_ / Math.sqrt(1 - E2 * Math.sin(phi) ** 2);
  const ground = Nr * Math.cos(phi) * d * D2R;
  return { k: Math.hypot(e1 - e0, n1 - n0) / ground, convergence: Math.atan2(n1 - n0, e1 - e0) * R2D };
}

// geodetic <-> cartesian (GRS80)
function geoToCart(lat, lon, h) { const p = lat * D2R, l = lon * D2R, N = A_ / Math.sqrt(1 - E2 * Math.sin(p) ** 2); return [(N + h) * Math.cos(p) * Math.cos(l), (N + h) * Math.cos(p) * Math.sin(l), (N * (1 - E2) + h) * Math.sin(p)]; }
function cartToGeo(X, Y, Z) {
  const p = Math.hypot(X, Y), lon = Math.atan2(Y, X); let lat = Math.atan2(Z, p * (1 - E2)), h = 0;
  for (let i = 0; i < 6; i++) { const N = A_ / Math.sqrt(1 - E2 * Math.sin(lat) ** 2); h = p / Math.cos(lat) - N; lat = Math.atan2(Z, p * (1 - E2 * N / (N + h))); }
  return [lat * R2D, lon * R2D, h];
}
// GDA94 -> GDA2020, EPSG:8048 (coordinate frame rotation). Reverse = negated parameters (EPSG convention).
const H8048 = { tx: 0.06155, ty: -0.01087, tz: -0.04019, rx: -0.0394924, ry: -0.0327221, rz: -0.0328979, s: -0.009994 }; // m, arc-seconds, ppm
function helmertCF(X, Y, Z, P, sign) {
  const k = sign, as = Math.PI / 180 / 3600;
  const rx = k * P.rx * as, ry = k * P.ry * as, rz = k * P.rz * as, s = 1 + k * P.s * 1e-6;
  return [k * P.tx + s * (X + rz * Y - ry * Z), k * P.ty + s * (-rz * X + Y + rx * Z), k * P.tz + s * (ry * X - rx * Y + Z)];
}
function datumShift(lat, lon, h, from, to) {
  if (from === to) return [lat, lon, h];
  const c = geoToCart(lat, lon, h);
  const r = (from === 'GDA94' && to === 'GDA2020') ? helmertCF(c[0], c[1], c[2], H8048, 1) : (from === 'GDA2020' && to === 'GDA94') ? helmertCF(c[0], c[1], c[2], H8048, -1) : null;
  if (!r) throw new Error('No transformation from ' + from + ' to ' + to);
  return cartToGeo(r[0], r[1], r[2]);
}

// ---------- registry ----------
const dms = (d, m, s = 0) => d + m / 60 + s / 3600;
// Landgate WA project grids: [code, CM (deg,min,sec), k0, FE, FN for 2020, FN for 94, height limit m]
const WA = [
  ['ALB', [117, 53], 1.0000044, 50000, 4100000, 4000000, 190], ['BIO', [115, 15], 1.0000022, 60000, 2700000, 2600000, null],
  ['BRO', [122, 20], 1.00000298, 50000, 2300000, 2200000, 130], ['BCG', [115, 26], 0.99999592, 50000, 4000000, 3900000, 250],
  ['CARN', [113, 40], 0.99999796, 50000, 3050000, 2950000, null], ['CIG', [105, 37, 30], 1.00002514, 50000, 1400000, 1300000, 290],
  ['CKIG', [96, 52, 30], 0.99999387, 50000, 1600000, 1500000, null], ['COL', [115, 56], 1.000019, 40000, 4100000, 4000000, 310],
  ['ESP', [121, 53], 1.0000055, 50000, 4050000, 3950000, null], ['EXM', [114, 4], 1.00000236, 50000, 2750000, 2650000, 160],
  ['GCG', [114, 35], 1.00000628, 50000, 3450000, 3350000, 195], ['GOLD', [121, 30], 1.00004949, 60000, 3800000, 3700000, null],
  ['JCG', [114, 59], 1.00000314, 50000, 3650000, 3550000, 200], ['KALB', [114, 18, 55], 1.000014, 55000, 3700000, 3600000, null],
  ['KAR', [116, 56], 0.9999989, 50000, 2550000, 2450000, null], ['KUN', [128, 45], 1.0000165, 50000, 2100000, 2000000, 200],
  ['LCG', [115, 22], 1.00000157, 50000, 3750000, 3650000, 200], ['MRCG', [115, 10], 1.0000055, 50000, 4050000, 3950000, 200],
  ['PCG', [115, 49], 0.99999906, 50000, 3900000, 3800000, 165], ['PHG', [118, 36], 1.00000135, 50000, 2500000, 2400000, null]
];
const SYSTEMS = [];
SYSTEMS.push({ id: 'GDA2020', name: 'GDA2020 geographic (lat, long, ellipsoidal h)', datum: 'GDA2020', type: 'geo', epsg: 7844 });
SYSTEMS.push({ id: 'GDA94', name: 'GDA94 geographic (lat, long, ellipsoidal h)', datum: 'GDA94', type: 'geo', epsg: 4283 });
for (let z = 49; z <= 56; z++) {
  SYSTEMS.push({ id: 'MGA2020-' + z, name: 'MGA2020 zone ' + z, datum: 'GDA2020', type: 'tm', epsg: 7800 + z, p: { lon0: 6 * z - 183, k0: 0.9996, fe: 500000, fn: 10000000 } });
  SYSTEMS.push({ id: 'MGA94-' + z, name: 'MGA94 zone ' + z, datum: 'GDA94', type: 'tm', epsg: 28300 + z, p: { lon0: 6 * z - 183, k0: 0.9996, fe: 500000, fn: 10000000 } });
}
for (const [code, cm, k0, fe, fn20, fn94, hl] of WA) {
  const lon0 = dms(cm[0], cm[1], cm[2] || 0);
  SYSTEMS.push({ id: code + '2020', name: code + '2020 (WA project grid, GDA2020)', datum: 'GDA2020', type: 'tm', p: { lon0, k0, fe, fn: fn20 }, heightLimit: hl, epsg: code === 'PCG' ? 8031 : null });
  SYSTEMS.push({ id: code + '94', name: code + '94 (WA project grid, GDA94)', datum: 'GDA94', type: 'tm', p: { lon0, k0, fe, fn: fn94 }, heightLimit: hl });
}
const byId = id => SYSTEMS.find(s => s.id === id) || (G.__sbLocalGrids || []).find(s => s.id === id);

// local grid = rigid (or similarity) 2D transform from local x,y to a parent grid E,N plus a height shift
// params: {parent, e0, n0, theta (rad), scale (1 for "metres, scale factor 1"), dz}
function localToParent(x, y, z, L) { const c = Math.cos(L.theta), s = Math.sin(L.theta), k = L.scale || 1; return [L.e0 + k * (c * x - s * y), L.n0 + k * (s * x + c * y), z + (L.dz || 0)]; }
function parentToLocal(E, N, Z, L) { const c = Math.cos(L.theta), s = Math.sin(L.theta), k = L.scale || 1, dx = (E - L.e0) / k, dy = (N - L.n0) / k; return [c * dx + s * dy, -s * dx + c * dy, Z - (L.dz || 0)]; }
// fit a local grid to control pairs: local [x,y,z] -> parent [E,N,Z]. fixScale: keep scale exactly 1
function fitLocal(local, parent, fixScale = true) {
  const m = local.length; if (m < 2) throw new Error('Need at least two control points');
  let lx = 0, ly = 0, px = 0, py = 0, dz = 0; for (let i = 0; i < m; i++) { lx += local[i][0]; ly += local[i][1]; px += parent[i][0]; py += parent[i][1]; dz += parent[i][2] - local[i][2]; }
  lx /= m; ly /= m; px /= m; py /= m; dz /= m;
  let a = 0, b = 0, ss = 0;
  for (let i = 0; i < m; i++) { const x = local[i][0] - lx, y = local[i][1] - ly, X = parent[i][0] - px, Y = parent[i][1] - py; a += x * X + y * Y; b += x * Y - y * X; ss += x * x + y * y; }
  const theta = Math.atan2(b, a), scale = fixScale ? 1 : Math.hypot(a, b) / ss;
  const c = Math.cos(theta), s = Math.sin(theta);
  const L = { e0: px - scale * (c * lx - s * ly), n0: py - scale * (s * lx + c * ly), theta, scale, dz };
  const res = local.map((q, i) => { const r = localToParent(q[0], q[1], q[2], L); return [r[0] - parent[i][0], r[1] - parent[i][1], r[2] - parent[i][2]]; });
  const rms = Math.sqrt(res.reduce((t, r) => t + r[0] * r[0] + r[1] * r[1], 0) / m);
  return { params: L, residuals: res, rmsH: rms, rmsV: Math.sqrt(res.reduce((t, r) => t + r[2] * r[2], 0) / m) };
}

// ---------- conversion between any two systems ----------
// a system's "geographic" step: returns [lat, lon, h, datum]
function toGeo(x, y, z, S) {
  if (S.type === 'geo') return [y, x, z, S.datum]; // geo stored as x=lon, y=lat
  if (S.type === 'tm') { const g = tmInverse(x, y, S.p); return [g[0], g[1], z, S.datum]; }
  if (S.type === 'local') { const P = byId(S.parent); const q = localToParent(x, y, z, S); return toGeo(q[0], q[1], q[2], P); }
  throw new Error('Unknown system');
}
function fromGeo(lat, lon, h, datum, S) {
  let g = [lat, lon, h]; const target = S.type === 'local' ? byId(S.parent) : S;
  if (datum !== target.datum) g = datumShift(g[0], g[1], g[2], datum, target.datum);
  if (target.type === 'geo') return S.type === 'local' ? null : [g[1], g[0], g[2]];
  const en = tmForward(g[0], g[1], target.p);
  if (S.type === 'local') return parentToLocal(en[0], en[1], g[2], S);
  return [en[0], en[1], g[2]];
}
function convertPoint(x, y, z, fromId, toId) {
  const F = typeof fromId === 'string' ? byId(fromId) : fromId, T = typeof toId === 'string' ? byId(toId) : toId;
  if (!F || !T) throw new Error('Unknown coordinate system');
  if (F === T) return [x, y, z];
  const g = toGeo(x, y, z, F); return fromGeo(g[0], g[1], g[2], g[3], T);
}
// convert interleaved Float64 world coords in place
function convertArray(arr, count, fromId, toId, onP) { for (let i = 0; i < count; i++) { const r = convertPoint(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2], fromId, toId); arr[i * 3] = r[0]; arr[i * 3 + 1] = r[1]; arr[i * 3 + 2] = r[2]; if (onP && (i & 0xffff) === 0) onP(i / count); } return arr; }
// guess a system from coordinates (for the import prompt)
function guessSystems(E, N) {
  const out = [];
  if (Math.abs(E) <= 180 && Math.abs(N) <= 90) out.push('GDA2020', 'GDA94');
  if (E > 100000 && E < 900000 && N > 6000000 && N < 9000000) for (let z = 49; z <= 56; z++) out.push('MGA2020-' + z, 'MGA94-' + z);
  for (const s of SYSTEMS) if (s.type === 'tm' && s.p.fe < 100000 && E > 0 && E < 150000 && Math.abs(N - s.p.fn) < 250000) out.push(s.id);
  return out;
}

const SBX = { SYSTEMS, byId, tmForward, tmInverse, tmScale, geoToCart, cartToGeo, datumShift, convertPoint, convertArray, fitLocal, localToParent, parentToLocal, guessSystems, H8048 };
if (typeof module !== 'undefined') module.exports = SBX; else G.SBX = SBX;
})();
