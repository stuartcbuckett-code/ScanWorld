"""
ScanBench sample: synthetic aerial LiDAR of a concrete gravity dam in a forested valley,
styled on Mundaring Weir (Helena River, Perth Hills, Western Australia).

THIS IS SYNTHETIC TEST DATA. Shapes, levels and positions are approximations made for
software testing, not survey data of the real dam.

Output (folder given as argv[1], default out_weir):
  mundaring_weir_sim.laz     LAS 1.4 point format 7, ASPRS classes, RGB, intensity, returns
  mundaring_weir_truth.csv   design features (crest, spillway, roads, buildings, water levels)
  README.txt
Coordinates: MGA2020 zone 50 (EPSG:7850), heights in metres AHD (approximate).
"""
import sys, os, csv, math
import numpy as np
import laspy

rng = np.random.default_rng(1903)
OUT = sys.argv[1] if len(sys.argv) > 1 else 'out_weir'
os.makedirs(OUT, exist_ok=True)

# ---------------- site frame ----------------
E0, N0 = 421661.0, 6463698.0       # dam centre (approx. 31°57'36"S 116°10'16"E)
ROT = math.radians(-12.0)           # dam axis a little off north-south
X0, X1, Y0, Y1 = -480.0, 360.0, -330.0, 330.0   # local extent (x downstream->upstream, y along the dam axis)
CREST = 161.5      # crest walkway / abutment top (m AHD, approx.)
SPILL = 159.6      # overflow crest
WATER = 156.2      # reservoir level on "survey day"
BED_TOE = 118.6    # river bed at the toe
DENS = 5.0         # last-return ground density (pts/m²) in the open

# ---------------- terrain ----------------
G = 1.0
gx = np.arange(X0, X1 + G, G); gy = np.arange(Y0, Y1 + G, G)
GX, GY = np.meshgrid(gx, gy)

def fbm(shape, octaves, base, amp, seed):
    r = np.random.default_rng(seed); out = np.zeros(shape)
    for o in range(octaves):
        cell = base / 2 ** o
        nx, ny = int(shape[1] * G / cell) + 3, int(shape[0] * G / cell) + 3
        coarse = r.normal(0, 1, (ny, nx))
        yy = np.linspace(0, ny - 3, shape[0]); xx = np.linspace(0, nx - 3, shape[1])
        iy = np.floor(yy).astype(int); ix = np.floor(xx).astype(int); fy = (yy - iy)[:, None]; fx = (xx - ix)[None, :]
        fy = fy * fy * (3 - 2 * fy); fx = fx * fx * (3 - 2 * fx)
        a = coarse[iy][:, ix]; b = coarse[iy][:, ix + 1]; c = coarse[iy + 1][:, ix]; d = coarse[iy + 1][:, ix + 1]
        out += (a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy) * amp / 2 ** (o * 0.85)
    return out

def river_y(x):  # thalweg meanders a little
    return 18 * np.sin(x / 170.0) + 10 * np.sin(x / 61.0 + 1.0) * (x < -60) - 8 * (x > 0) * np.sin(x / 90.0)

def bed_z(x):
    return np.where(x < 0, BED_TOE + 0.011 * x, BED_TOE + 4 + 0.035 * x)   # reservoir floor rises upstream

d = np.abs(GY - river_y(GX))
side = 44 * (1 - np.exp(-d / 105.0)) + 0.085 * d
# a side gully coming in from the north-west and one from the south-east
side -= 14 * np.exp(-(((GX + 260) * 0.8 + (GY - 170)) ** 2) / (2 * 35 ** 2)) * (GY > 60)
side -= 10 * np.exp(-(((GX - 200) - 0.6 * (GY + 160)) ** 2) / (2 * 30 ** 2)) * (GY < -60)
noise = fbm(GX.shape, 6, 160.0, 3.2, 7) * np.clip(d / 25.0, 0.15, 1.0)
Z = bed_z(GX) + side + noise
# granite tors and sheets on the valley sides
tors = []
for _ in range(70):
    tx, ty = rng.uniform(X0, X1), rng.uniform(Y0, Y1)
    dd = abs(ty - river_y(tx))
    if dd < 40 or dd > 300: continue
    r_ = rng.uniform(3, 9); h_ = rng.uniform(1.5, 4.5); tors.append((tx, ty, r_, h_))
    Z += h_ * np.exp(-((GX - tx) ** 2 + (GY - ty) ** 2) / (2 * r_ ** 2)) ** 0.6
# river channel below the dam: stone-lined trench then natural pools
chan = (GX < -30) & (GX > X0) & (d < 16)
Z = np.where(chan, np.minimum(Z, bed_z(GX) + 0.25 * (d / 16) ** 2 * 3), Z)

def smooth(A, r):
    k = np.exp(-np.arange(-3 * r, 3 * r + 1) ** 2 / (2 * r * r)); k /= k.sum()
    A = np.apply_along_axis(lambda v: np.convolve(np.pad(v, 3 * r, mode='edge'), k, 'valid'), 1, A)
    return np.apply_along_axis(lambda v: np.convolve(np.pad(v, 3 * r, mode='edge'), k, 'valid'), 0, A)

# ---------------- roads, pads and buildings (local x,y) ----------------
def polyline_dist(px, py, pts):
    best = np.full(px.shape, 1e9); s_at = np.zeros(px.shape); acc = 0.0
    for (ax, ay), (bx, by) in zip(pts[:-1], pts[1:]):
        vx, vy = bx - ax, by - ay; L = math.hypot(vx, vy)
        t = np.clip(((px - ax) * vx + (py - ay) * vy) / (L * L), 0, 1)
        dd = np.hypot(px - ax - t * vx, py - ay - t * vy)
        m = dd < best; best = np.where(m, dd, best); s_at = np.where(m, acc + t * L, s_at); acc += L
    return best, s_at

ROADS = {
    'Mundaring Weir Road (bitumen)': dict(w=7.0, kind='bitumen', pts=[(-470, 300), (-400, 250), (-330, 215), (-280, 160), (-250, 110), (-215, 80), (-160, 72), (-95, 95), (-40, 128), (-8, 150)]),
    'Pump station access (bitumen)': dict(w=6.0, kind='bitumen', pts=[(-250, 110), (-262, 70), (-245, 40)]),
    'Museum access (gravel)': dict(w=5.0, kind='gravel', pts=[(-215, 80), (-200, 40), (-185, 18)]),
    'South side track (gravel)': dict(w=4.5, kind='gravel', pts=[(-12, -150), (-60, -175), (-140, -190), (-230, -235), (-330, -300), (-420, -325)]),
    'Hotel road (bitumen)': dict(w=6.5, kind='bitumen', pts=[(-8, 150), (40, 190), (110, 225), (180, 245), (240, 262), (330, 290)]),
}
PADS = {  # flat platforms: name -> (cx, cy, w, h, rot, surface)
    'C Y O\'Connor Museum (former No. 1 Pump Station) pad': (-185, 0, 70, 34, 0.0, 'gravel'),
    'Pump station pad': (-252, 25, 52, 40, 0.15, 'bitumen'),
    'Car park and picnic lawn': (-120, 85, 60, 36, -0.35, 'lawn'),
    'Hotel pad': (255, 255, 60, 40, 0.3, 'bitumen'),
}
BUILDINGS = [  # name, cx, cy, length, width, rot, eave height, ridge rise, roof colour, wall colour
    ('Former No. 1 Pump Station (museum)', -188, 2, 46, 16, 0.0, 8.0, 4.5, (128, 52, 40), (158, 82, 58)),
    ('Boiler house annex', -188, 18, 20, 9, 0.0, 6.0, 2.5, (128, 52, 40), (158, 82, 58)),
    ('Pump station', -255, 28, 32, 20, 0.15, 7.5, 0.6, (176, 180, 182), (205, 198, 182)),
    ('Switch room', -232, 4, 12, 8, 0.15, 4.0, 0.4, (176, 180, 182), (205, 198, 182)),
    ('Mundaring Weir Hotel', 255, 258, 34, 18, 0.3, 7.0, 3.5, (150, 152, 150), (215, 205, 180)),
    ('Hotel verandah', 255, 246, 34, 5, 0.3, 3.0, 0.3, (150, 152, 150), (215, 205, 180)),
    ('Toilet block', -105, 105, 8, 5, -0.35, 3.0, 1.0, (110, 125, 110), (190, 170, 140)),
]
def rect_mask(px, py, cx, cy, w, h, rot, grow=0.0):
    c, s = math.cos(rot), math.sin(rot); u = (px - cx) * c + (py - cy) * s; v = -(px - cx) * s + (py - cy) * c
    return (np.abs(u) <= w / 2 + grow) & (np.abs(v) <= h / 2 + grow), u, v

Zs = smooth(Z, 6)
surface = np.full(Z.shape, 'natural', dtype=object)
road_d = np.full(Z.shape, 1e9)
for name, R in ROADS.items():
    dd, _ = polyline_dist(GX, GY, R['pts']); road_d = np.minimum(road_d, dd)
    core = dd < R['w'] / 2; batter = (dd >= R['w'] / 2) & (dd < R['w'] / 2 + 6)
    Z = np.where(core, Zs + 0.05, Z); bl = np.clip((dd - R['w'] / 2) / 6, 0, 1)
    Z = np.where(batter, Zs * (1 - bl) + Z * bl, Z)
    surface = np.where(core, R['kind'], np.where((dd < R['w'] / 2 + 0.8) & (surface == 'natural'), 'shoulder', surface))
for name, (cx, cy, w, h, rot, surf) in PADS.items():
    m, u, v = rect_mask(GX, GY, cx, cy, w, h, rot); level = float(np.median(Z[m]))
    m2, _, _ = rect_mask(GX, GY, cx, cy, w, h, rot, 8); bl = np.clip(np.maximum(np.abs(u) - w / 2, np.abs(v) - h / 2) / 8, 0, 1)
    Z = np.where(m2 & ~m, level * (1 - bl) + Z * bl, Z); Z = np.where(m, level + 0.02 * u / w, Z)
    surface = np.where(m, surf, surface)
    PADS[name] = (cx, cy, w, h, rot, surf, level)

# ---------------- dam ----------------
DAM_UP = 3.0         # upstream face x (vertical)
def dam_down_x(z):   # downstream face: ogee top then 0.78H:1V
    dz = CREST - z
    return np.where(dz < 4, DAM_UP - 6 - 1.2 * dz ** 1.5 / 2, DAM_UP - 6 - 2.4 - 0.78 * (dz - 4))
SPILL_HALF = 72.0
def crest_z(y): return np.where(np.abs(y) < SPILL_HALF, SPILL, CREST)
def ground_at(x, y):
    ix = np.clip(((x - X0) / G), 0, len(gx) - 2); iy = np.clip(((y - Y0) / G), 0, len(gy) - 2)
    i0 = np.floor(ix).astype(int); j0 = np.floor(iy).astype(int); fx = ix - i0; fy = iy - j0
    return Z[j0, i0] * (1 - fx) * (1 - fy) + Z[j0, i0 + 1] * fx * (1 - fy) + Z[j0 + 1, i0] * (1 - fx) * fy + Z[j0 + 1, i0 + 1] * fx * fy
# where the valley sides drop below the crest = dam extent along the axis
ys = np.arange(Y0, Y1, 0.5); gz = ground_at(np.zeros_like(ys), ys)
below = ys[gz < CREST - 0.5]; DAM_Y0, DAM_Y1 = below.min() - 2, below.max() + 2
toe_x = float(dam_down_x(np.array(BED_TOE)))
# excavate the footprint so the dam sits in a cut (ground inside the footprint is not "seen")
in_dam = (GX <= DAM_UP + 0.5) & (GX >= toe_x - 1) & (GY >= DAM_Y0) & (GY <= DAM_Y1)
dam_mask_ground = in_dam & (Z < CREST)
# apron and stilling basin
APRON = (toe_x - 28, toe_x, -45, 45)
ap = (GX >= APRON[0]) & (GX <= APRON[1]) & (np.abs(GY - river_y(GX)) < 45) & (Z < BED_TOE + 6)
Z = np.where(ap, BED_TOE - 0.4, Z); surface = np.where(ap, 'concrete', surface)

# ---------------- point builders ----------------
P, C, I, CL, RN, NR = [], [], [], [], [], []
def emit(xyz, rgb, inten, cls, rn=1, nr=1):
    n = len(xyz); P.append(xyz); C.append(np.clip(rgb, 0, 255).astype(np.uint16) * 257); I.append(np.clip(inten, 0, 65535).astype(np.uint16))
    CL.append(np.full(n, cls, np.uint8)); RN.append(np.broadcast_to(np.asarray(rn, np.uint8), (n,)).copy()); NR.append(np.broadcast_to(np.asarray(nr, np.uint8), (n,)).copy())
def jitter_rgb(base, n, sd=10):
    return np.asarray(base, float)[None, :] + rng.normal(0, sd, (n, 1)) + rng.normal(0, sd * 0.35, (n, 3))

# vegetation density field: forest everywhere natural, thinner on rock and near the water, cleared on pads/roads
forest = np.clip(0.55 + 0.35 * fbm(GX.shape, 3, 120.0, 1.0, 11), 0, 0.95)
forest = np.where(surface != 'natural', 0, forest)
forest = np.where(road_d < 10, forest * 0.2, forest)
forest = np.where((GX > -60) & (GX < 25) & (GY > DAM_Y0 - 30) & (GY < DAM_Y1 + 30), forest * 0.15, forest)  # cleared around the wall
forest = np.where((Z < WATER + 1.5) & (GX > DAM_UP), forest * 0.3, forest)
forest = np.where(chan, 0.1, forest)

# trees (jarrah / marri): crowns as flattened ellipsoids
trees = []
area = (X1 - X0) * (Y1 - Y0); nt = int(area / 55)
tx = rng.uniform(X0, X1, nt); ty = rng.uniform(Y0, Y1, nt)
fv = forest[np.clip(((ty - Y0) / G).astype(int), 0, len(gy) - 1), np.clip(((tx - X0) / G).astype(int), 0, len(gx) - 1)]
keep = rng.random(nt) < fv; tx, ty = tx[keep], ty[keep]
inwater = (ground_at(tx, ty) < WATER + 0.3) & (tx > DAM_UP); tx, ty = tx[~inwater], ty[~inwater]
for x_, y_ in zip(tx, ty):
    h = rng.uniform(9, 27); cr = h * rng.uniform(0.18, 0.3); trees.append((x_, y_, ground_at(np.array([x_]), np.array([y_]))[0], h, cr))
trees = np.array(trees)

# ground points (last returns), thinned under canopy
n_g = int(area * DENS)
px = rng.uniform(X0, X1, n_g); py = rng.uniform(Y0, Y1, n_g)
ix = np.clip(((px - X0) / G).astype(int), 0, len(gx) - 1); iy = np.clip(((py - Y0) / G).astype(int), 0, len(gy) - 1)
pz = ground_at(px, py)
fv = forest[iy, ix]
keep = rng.random(n_g) > fv * 0.55
_zt = np.linspace(BED_TOE - 2, CREST, 400); _xt = dam_down_x(_zt)          # face x falls as z drops: invert by interpolation
def dam_surface_z(x, y):
    zf = np.interp(x, _xt, _zt, left=-1e9, right=CREST) - (CREST - crest_z(y))
    return np.where((x <= DAM_UP) & (y >= DAM_Y0) & (y <= DAM_Y1), zf, -1e9)
keep &= pz > dam_surface_z(px, py) + 0.05
keep &= (pz > WATER - 0.05) | (px < DAM_UP)      # under the reservoir: no ground return (water handled below)
for name, B in [(b[0], b) for b in BUILDINGS]:
    m, _, _ = rect_mask(px, py, B[1], B[2], B[3], B[4], B[5]); keep &= ~m
px, py, pz, ix, iy = px[keep], py[keep], pz[keep], ix[keep], iy[keep]
surf = surface[iy, ix]
n = len(px); rgb = np.zeros((n, 3)); inten = np.zeros(n)
lit = fbm(GX.shape, 4, 60.0, 0.25, 21)[iy, ix]
# slope shading as in an orthophoto (sun from the north-east)
dzdx = np.gradient(Z, axis=1)[iy, ix]; dzdy = np.gradient(Z, axis=0)[iy, ix]
hs = np.clip(0.75 + 0.9 * (-dzdx * 0.55 - dzdy * 0.65) / np.sqrt(1 + dzdx ** 2 + dzdy ** 2), 0.45, 1.25)
def put(m, base, sd, it):
    k = int(m.sum());
    if k: rgb[m] = jitter_rgb(base, k, sd); inten[m] = rng.normal(it, it * 0.12, k)
nat = surf == 'natural'
slope = np.hypot(dzdx, dzdy)
rock = nat & ((slope > 0.75) | (fbm(GX.shape, 3, 30.0, 1.0, 5)[iy, ix] > 1.15))
litter = nat & ~rock & (fv[keep] > 0.35 if False else forest[iy, ix] > 0.35)
grass = nat & ~rock & ~litter
put(litter, (118, 98, 72), 12, 9000)
put(grass, (182, 162, 112), 14, 14000)
put(rock, (152, 144, 134), 16, 21000)
put(surf == 'bitumen', (72, 72, 74), 6, 4000)
put(surf == 'gravel', (168, 116, 74), 10, 15000)
put(surf == 'shoulder', (150, 120, 85), 12, 12000)
put(surf == 'lawn', (96, 132, 62), 10, 16000)
put(surf == 'concrete', (178, 174, 166), 8, 24000)
# road line marking
m = (surf == 'bitumen') & (np.abs(road_d[iy, ix]) < 0.08); rgb[m] = (230, 230, 225); inten[m] = 32000
# damp sand and laterite along the river bed
m = chan[iy, ix] & (surf == 'natural'); put(m, (138, 120, 92), 12, 11000)
rgb *= (hs * (1 + lit))[:, None]
emit(np.c_[px, py, pz + rng.normal(0, 0.025, n)], rgb, inten, 2, rn=np.where(fv[keep] > 0.3, 2, 1) if False else 1, nr=1)

# water surfaces: sparse returns (specular), class 9
def water(mask_fn, level, dens):
    k = int(area * dens); wx = rng.uniform(X0, X1, k); wy = rng.uniform(Y0, Y1, k); wz = ground_at(wx, wy)
    m = mask_fn(wx, wy, wz); wx, wy = wx[m], wy[m]; k = len(wx)
    shade = 1 + 0.12 * np.sin(wx * 0.31 + wy * 0.17) * np.sin(wy * 0.23)
    emit(np.c_[wx, wy, level + rng.normal(0, 0.03, k)], jitter_rgb((44, 66, 64), k, 5) * shade[:, None], rng.normal(1500, 400, k), 9)
water(lambda x, y, z: (z < WATER) & (x > DAM_UP + 0.3), WATER, 0.6)
water(lambda x, y, z: (z < BED_TOE - 0.25 + 0.011 * np.minimum(x, 0) + 0.35) & (x < APRON[0]) & (np.abs(y - river_y(x)) < 14), None or 0, 0) if False else None
# pools in the river below the apron
k = int(area * 0.8); wx = rng.uniform(X0, APRON[0], k); wy = rng.uniform(Y0, Y1, k)
m = (np.abs(wy - river_y(wx)) < 9 + 3 * np.sin(wx / 23.0)) & (np.sin(wx / 37.0) > -0.2); wx, wy = wx[m], wy[m]
wz = bed_z(wx) + 0.3
emit(np.c_[wx, wy, wz + rng.normal(0, 0.02, len(wx))], jitter_rgb((52, 70, 58), len(wx), 5), rng.normal(1800, 400, len(wx)), 9)

# dam wall: downstream face, crest, parapets, footbridge and piers  (class 1: unclassified structure)
def concrete(n, stain=None):
    base = jitter_rgb((186, 181, 170), n, 7)
    if stain is not None: base *= (1 - 0.28 * stain)[:, None]
    return base
DD = 12.0
# downstream face (param y, z)
dy_span = DAM_Y1 - DAM_Y0
n_f = int(dy_span * (CREST - BED_TOE) * 1.3 * DD)
fy = rng.uniform(DAM_Y0, DAM_Y1, n_f); fz = rng.uniform(BED_TOE - 0.4, CREST, n_f)
cz = crest_z(fy); fz = np.minimum(fz, cz)
fx = dam_down_x(fz + (CREST - cz))   # spill section: same profile, lower
gfz = ground_at(fx, fy); m = fz > gfz + 0.05; fx, fy, fz = fx[m], fy[m], fz[m]
# step joints every 1.5 m (lift lines) and vertical streaks below the spillway
lift = (np.mod(fz, 1.5) < 0.06).astype(float)
streak = np.clip(0.5 + 0.5 * np.sin(fy * 1.7) * np.sin(fy * 0.37), 0, 1) * (np.abs(fy) < SPILL_HALF) * np.clip((cz[m] - fz) / 30, 0, 1)
k = len(fx); emit(np.c_[fx + rng.normal(0, 0.01, k), fy, fz], concrete(k, 0.6 * streak + 0.5 * lift), rng.normal(26000, 2500, k), 1)
# crest tops
n_c = int(dy_span * 8 * DD); cy_ = rng.uniform(DAM_Y0, DAM_Y1, n_c); cx_ = rng.uniform(dam_down_x(np.array(CREST - 0.01)), DAM_UP, n_c); czz = crest_z(cy_)
ogee = (np.abs(cy_) < SPILL_HALF); czz = np.where(ogee, SPILL - 0.25 * ((cx_ - (DAM_UP - 3)) / 3) ** 2, czz)
k = len(cx_); emit(np.c_[cx_, cy_, czz + rng.normal(0, 0.01, k)], concrete(k), rng.normal(27000, 2000, k), 1)
# upstream face above the water
n_u = int(dy_span * 6 * DD); uy = rng.uniform(DAM_Y0, DAM_Y1, n_u); uz = rng.uniform(WATER, CREST, n_u); m = uz < crest_z(uy); uy, uz = uy[m], uz[m]
k = len(uy); emit(np.c_[np.full(k, DAM_UP) + rng.normal(0, 0.01, k), uy, uz], concrete(k, 0.35 * (uz < WATER + 0.8)), rng.normal(23000, 2000, k), 1)
# parapets on the abutment sections
for side_x in (DAM_UP - 0.15, dam_down_x(np.array(CREST - 0.01)) + 0.15):
    n_p = int(dy_span * 1.1 * DD * 2); qy = rng.uniform(DAM_Y0, DAM_Y1, n_p); m = np.abs(qy) >= SPILL_HALF; qy = qy[m]; k = len(qy)
    emit(np.c_[side_x + rng.normal(0, 0.01, k), qy, CREST + rng.uniform(0, 1.1, k)], concrete(k), rng.normal(26000, 2000, k), 1)
# footbridge over the spillway on piers every 9 m
FB = (DAM_UP - 4.6, DAM_UP - 1.6, SPILL + 2.6)
n_b = int(2 * SPILL_HALF * 3 * DD * 1.4); by = rng.uniform(-SPILL_HALF, SPILL_HALF, n_b); bx = rng.uniform(FB[0], FB[1], n_b)
emit(np.c_[bx, by, FB[2] + rng.normal(0, 0.01, n_b)], jitter_rgb((160, 158, 150), n_b, 8), rng.normal(22000, 2000, n_b), 17)
for side_x in (FB[0], FB[1]):  # handrails (thin, sparse)
    n_h = int(2 * SPILL_HALF * 12); hy = rng.uniform(-SPILL_HALF, SPILL_HALF, n_h)
    emit(np.c_[np.full(n_h, side_x) + rng.normal(0, 0.01, n_h), hy, FB[2] + 1.05 + rng.normal(0, 0.01, n_h)], jitter_rgb((90, 110, 95), n_h, 6), rng.normal(18000, 2000, n_h), 17)
for py_ in np.arange(-SPILL_HALF, SPILL_HALF + 0.1, 9.0):
    n_q = 260; qx = rng.uniform(FB[0] + 0.3, FB[1] - 0.3, n_q); qz = rng.uniform(SPILL, FB[2], n_q); qy = py_ + rng.choice([-0.6, 0.6], n_q)
    emit(np.c_[qx, qy, qz], concrete(n_q), rng.normal(25000, 2000, n_q), 1)
# valve tower / outlet house on the upstream side, north of the spillway
VT = (DAM_UP + 5.5, 95.0, 6.0, CREST + 4.5)
n_v = 2500; a = rng.uniform(0, 2 * np.pi, n_v); z_ = rng.uniform(WATER, VT[3], n_v)
emit(np.c_[VT[0] + VT[2] / 2 * np.cos(a), VT[1] + VT[2] / 2 * np.sin(a), z_], concrete(n_v), rng.normal(25000, 2000, n_v), 1)
n_v = 900; r_ = np.sqrt(rng.random(n_v)) * VT[2] / 2 + 0.2; a = rng.uniform(0, 2 * np.pi, n_v)
emit(np.c_[VT[0] + r_ * np.cos(a), VT[1] + r_ * np.sin(a), VT[3] + 0.8 * (1 - r_ / (VT[2] / 2 + 0.2))], jitter_rgb((110, 60, 50), n_v, 6), rng.normal(15000, 2000, n_v), 6)
n_v = 400; vb = rng.uniform(DAM_UP, VT[0] - VT[2] / 2, n_v); emit(np.c_[vb, VT[1] + rng.uniform(-1, 1, n_v), np.full(n_v, CREST + 0.05)], concrete(n_v), rng.normal(25000, 2000, n_v), 17)

# buildings: walls (sparse, mostly roofs from the air), gable roofs
for (name, cx, cy, Lb, Wb, rot, eave, rise, roof_rgb, wall_rgb) in BUILDINGS:
    c, s = math.cos(rot), math.sin(rot); gz0 = float(ground_at(np.array([cx]), np.array([cy]))[0])
    n_r = int(Lb * Wb * 9); u = rng.uniform(-Lb / 2 - 0.5, Lb / 2 + 0.5, n_r); v = rng.uniform(-Wb / 2 - 0.5, Wb / 2 + 0.5, n_r)
    z = gz0 + eave + rise * (1 - np.abs(v) / (Wb / 2 + 0.5))
    corr = 1 + 0.05 * (np.mod(u, 0.76) < 0.1)  # corrugations / roof sheet laps
    sunny = np.where(v * (1 if rot >= 0 else -1) > 0, 1.08, 0.85) if rise > 1 else 1.0
    emit(np.c_[cx + u * c - v * s, cy + u * s + v * c, z], jitter_rgb(roof_rgb, n_r, 7) * (corr * sunny)[:, None] if np.ndim(sunny) else jitter_rgb(roof_rgb, n_r, 7) * corr[:, None], rng.normal(17000, 2500, n_r), 6)
    per = 2 * (Lb + Wb); n_w = int(per * eave * 2.5); t = rng.uniform(0, per, n_w)
    u = np.where(t < Lb, t - Lb / 2, np.where(t < Lb + Wb, Lb / 2, np.where(t < 2 * Lb + Wb, Lb / 2 - (t - Lb - Wb), -Lb / 2)))
    v = np.where(t < Lb, -Wb / 2, np.where(t < Lb + Wb, -Wb / 2 + (t - Lb), np.where(t < 2 * Lb + Wb, Wb / 2, Wb / 2 - (t - 2 * Lb - Wb))))
    zw = gz0 + rng.uniform(0, eave, n_w)
    emit(np.c_[cx + u * c - v * s, cy + u * s + v * c, zw], jitter_rgb(wall_rgb, n_w, 8), rng.normal(14000, 2500, n_w), 6)
# museum chimney stubs (the old boiler stacks)
for sx in (-200, -176):
    n_s = 700; a = rng.uniform(0, 2 * np.pi, n_s); gz0 = float(ground_at(np.array([sx]), np.array([20.0]))[0])
    emit(np.c_[sx + 1.4 * np.cos(a), 20 + 1.4 * np.sin(a), gz0 + rng.uniform(0, 14, n_s)], jitter_rgb((150, 78, 56), n_s, 8), rng.normal(14000, 2000, n_s), 6)

# Golden Pipeline: above-ground steel main on concrete plinths, leaving the pump station westward up the hill
PIPE = [(-262, 40), (-300, 60), (-360, 75), (-420, 95), (-478, 118)]
pts = []
for (ax, ay), (bx, by) in zip(PIPE[:-1], PIPE[1:]):
    L = math.hypot(bx - ax, by - ay); k = int(L * 70); t = rng.random(k)
    x = ax + (bx - ax) * t; y = ay + (by - ay) * t; a = rng.uniform(-np.pi * 0.95, np.pi * 0.95, k)
    nx, ny = -(by - ay) / L, (bx - ax) / L; gz = ground_at(x, y); r = 0.38
    pts.append(np.c_[x + nx * r * np.sin(a), y + ny * r * np.sin(a), gz + 0.9 + r + r * np.cos(a)])
    for t0 in np.arange(0, L, 7.0):  # plinths
        x0 = ax + (bx - ax) * t0 / L; y0 = ay + (by - ay) * t0 / L; g0 = float(ground_at(np.array([x0]), np.array([y0]))[0]); m_ = 60
        emit(np.c_[x0 + rng.uniform(-0.5, 0.5, m_), y0 + rng.uniform(-0.5, 0.5, m_), g0 + rng.uniform(0, 0.9, m_)], concrete(m_), rng.normal(22000, 2000, m_), 1)
pp = np.vstack(pts); emit(pp, jitter_rgb((92, 96, 92), len(pp), 7), rng.normal(12000, 2000, len(pp)), 1)

# power line along the hotel road on timber poles (wires = class 14, poles = 15)
POLES = []
pl_pts = [(-8, 160), (40, 200), (110, 235), (180, 255), (240, 272), (330, 300)]
for (ax, ay), (bx, by) in zip(pl_pts[:-1], pl_pts[1:]):
    L = math.hypot(bx - ax, by - ay); ns = max(1, int(L // 45))
    for j in range(ns): POLES.append((ax + (bx - ax) * j / ns, ay + (by - ay) * j / ns))
POLES.append(pl_pts[-1])
ptop = []
for (x0, y0) in POLES:
    g0 = float(ground_at(np.array([x0]), np.array([y0]))[0]); h = 10.5; m_ = 150; a = rng.uniform(0, 2 * np.pi, m_)
    emit(np.c_[x0 + 0.15 * np.cos(a), y0 + 0.15 * np.sin(a), g0 + rng.uniform(0, h, m_)], jitter_rgb((105, 88, 66), m_, 6), rng.normal(9000, 1500, m_), 15)
    ptop.append((x0, y0, g0 + h))
for (x0, y0, z0), (x1, y1, z1) in zip(ptop[:-1], ptop[1:]):
    L = math.hypot(x1 - x0, y1 - y0)
    for off in (-0.6, 0.0, 0.6):
        k = int(L * 6); t = rng.random(k); nx, ny = -(y1 - y0) / L, (x1 - x0) / L
        sag = 4 * 0.9 * t * (1 - t) * (L / 45) ** 2
        emit(np.c_[x0 + (x1 - x0) * t + nx * off, y0 + (y1 - y0) * t + ny * off, z0 + (z1 - z0) * t - 0.3 - sag], jitter_rgb((60, 60, 60), k, 4), rng.normal(5000, 1000, k), 14)

# vegetation returns: crowns (first returns), understorey shrubs
CROWN = [(58, 74, 44), (72, 86, 50), (64, 70, 46), (84, 92, 58), (95, 98, 66)]
for (x0, y0, g0, h, cr) in trees:
    if dam_surface_z(np.array([x0]), np.array([y0]))[0] > -1e8 or (APRON[0] - 5 < x0 < DAM_UP + 2 and abs(y0) < 60): continue
    k = int(math.pi * cr * cr * DENS * rng.uniform(1.4, 2.2)); dep = h * rng.uniform(0.3, 0.5)
    u = rng.normal(0, 1, (k, 3)); u /= np.linalg.norm(u, axis=1)[:, None]; rr = rng.random(k) ** 0.35
    pts_ = np.c_[x0 + u[:, 0] * cr * rr, y0 + u[:, 1] * cr * rr, g0 + h - dep / 2 + u[:, 2] * dep / 2 * rr]
    top = (pts_[:, 2] - (g0 + h - dep)) / dep
    keep = rng.random(k) < 0.25 + 0.75 * top; pts_ = pts_[keep]; top = top[keep]; k = len(pts_)
    base = np.array(CROWN[rng.integers(len(CROWN))], float); col = jitter_rgb(base, k, 9) * (0.75 + 0.4 * top)[:, None]
    rn = np.where(top > 0.6, 1, np.where(top > 0.3, 2, 3)); emit(pts_, col, rng.normal(7000, 2000, k), 5, rn=rn, nr=np.full(k, 4))
    m_ = int(h * 2); emit(np.c_[x0 + rng.normal(0, 0.12, m_), y0 + rng.normal(0, 0.12, m_), g0 + rng.uniform(0.3, h - dep, m_)], jitter_rgb((96, 82, 66), m_, 8), rng.normal(8000, 1500, m_), 4, rn=3, nr=4)
# shrubs (balga / blackboys, wattle): low veg 0.3-2 m
ns = int(area * 0.01); sx = rng.uniform(X0, X1, ns); sy = rng.uniform(Y0, Y1, ns)
sv = forest[np.clip(((sy - Y0) / G).astype(int), 0, len(gy) - 1), np.clip(((sx - X0) / G).astype(int), 0, len(gx) - 1)]
m = (rng.random(ns) < sv) & ((ground_at(sx, sy) > WATER + 0.5) | (sx < DAM_UP)); sx, sy = sx[m], sy[m]
for x0, y0 in zip(sx, sy):
    g0 = float(ground_at(np.array([x0]), np.array([y0]))[0]); h = rng.uniform(0.4, 2.2); k = int(25 * h)
    emit(np.c_[x0 + rng.normal(0, 0.5, k), y0 + rng.normal(0, 0.5, k), g0 + rng.uniform(0.15, h, k)], jitter_rgb((92, 104, 60), k, 10), rng.normal(9000, 2000, k), 3 if h < 1 else 4, rn=2, nr=3)

# noise: birds / low points
k = 80; emit(np.c_[rng.uniform(X0, X1, k), rng.uniform(Y0, Y1, k), rng.uniform(170, 260, k)], jitter_rgb((120, 120, 120), k, 20), rng.normal(3000, 800, k), 7)
k = 40; xx = rng.uniform(X0, X1, k); yy = rng.uniform(Y0, Y1, k); emit(np.c_[xx, yy, ground_at(xx, yy) - rng.uniform(3, 15, k)], jitter_rgb((80, 80, 80), k, 10), rng.normal(2000, 500, k), 7)

# ---------------- assemble, rotate into MGA, write ----------------
xyz = np.vstack(P); rgb = np.vstack(C); inten = np.concatenate(I); cls = np.concatenate(CL); rn = np.concatenate(RN); nr = np.concatenate(NR)
c, s = math.cos(ROT), math.sin(ROT)
E = E0 + xyz[:, 0] * c - xyz[:, 1] * s; N = N0 + xyz[:, 0] * s + xyz[:, 1] * c
# clip to a tidy rectangle in MGA
xm, ym = (E0 - 400, N0 - 300), (E0 + 300, N0 + 300)
m = (E >= xm[0]) & (E <= ym[0]) & (N >= xm[1]) & (N <= ym[1])
# flight-line order (north-south strips 60 m wide, alternating), so LAZ compresses like a real capture
xs_, ys_ = xyz[m, 0], xyz[m, 1]; strip = np.floor((xs_ - X0) / 60).astype(int); along = np.where(strip % 2 == 0, ys_, -ys_)
order = np.lexsort((np.round(along * 2) / 2 + rng.random(len(xs_)) * 0.5, strip))
hdr = laspy.LasHeader(point_format=7, version='1.4'); hdr.offsets = [E0 - 400, N0 - 300, 0]; hdr.scales = [0.01, 0.01, 0.01]
try:
    from pyproj import CRS; hdr.add_crs(CRS.from_epsg(7850))
except Exception: pass
las = laspy.LasData(hdr)
las.x = E[m][order]; las.y = N[m][order]; las.z = xyz[m, 2][order]
las.red = rgb[m, 0][order]; las.green = rgb[m, 1][order]; las.blue = rgb[m, 2][order]
las.intensity = inten[m][order]; las.classification = cls[m][order]
rn_ = rn[m][order]; nr_ = np.maximum(nr[m][order], rn_); las.return_number = rn_; las.number_of_returns = nr_
las.gps_time = np.linspace(0, 600, m.sum()); las.point_source_id = np.full(m.sum(), 1, np.uint16)
las.write(os.path.join(OUT, 'mundaring_weir_sim.laz'))
print('points', m.sum(), 'classes', {int(k): int(v) for k, v in zip(*np.unique(cls[m], return_counts=True))})

# truth / design features in MGA
def to_mga(x, y): return E0 + x * c - y * s, N0 + x * s + y * c
rows = [['Type', 'Name', 'Detail', 'E', 'N', 'Z / RL', 'Note']]
for y_, nm in [(DAM_Y0, 'crest south end'), (-SPILL_HALF, 'spillway south end'), (SPILL_HALF, 'spillway north end'), (DAM_Y1, 'crest north end')]:
    e, n_ = to_mga(DAM_UP - 3, y_); rows.append(['dam', nm, 'crest centreline', f'{e:.2f}', f'{n_:.2f}', f'{float(crest_z(np.array(y_))):.2f}', ''])
e, n_ = to_mga(toe_x, 0); rows.append(['dam', 'downstream toe at river', '', f'{e:.2f}', f'{n_:.2f}', f'{BED_TOE:.2f}', f'wall height ~{CREST - BED_TOE + 2:.0f} m above foundation'])
rows.append(['dam', 'crest length', f'{DAM_Y1 - DAM_Y0:.0f} m', '', '', '', 'abutment crest RL %.1f, overflow crest RL %.1f' % (CREST, SPILL)])
rows.append(['water', 'reservoir (Lake C.Y. O\'Connor)', 'water level on capture', '', '', f'{WATER:.2f}', 'water returns are sparse (class 9)'])
for nm, R in ROADS.items():
    for k, (x_, y_) in enumerate(R['pts']): e, n_ = to_mga(x_, y_); rows.append(['road', nm, f'vertex {k + 1}, width {R["w"]} m', f'{e:.2f}', f'{n_:.2f}', f'{float(ground_at(np.array([x_]), np.array([y_]))[0]):.2f}', R['kind']])
for (name, cx, cy, Lb, Wb, rot, eave, rise, *_r) in BUILDINGS:
    e, n_ = to_mga(cx, cy); g0 = float(ground_at(np.array([cx]), np.array([cy]))[0]); rows.append(['building', name, f'{Lb} x {Wb} m, eave {eave} m, ridge +{rise} m', f'{e:.2f}', f'{n_:.2f}', f'{g0:.2f}', f'ridge RL {g0 + eave + rise:.2f}'])
for k, (x0, y0) in enumerate(POLES): e, n_ = to_mga(x0, y0); rows.append(['pole', f'power pole {k + 1}', 'timber 10.5 m', f'{e:.2f}', f'{n_:.2f}', f'{float(ground_at(np.array([x0]), np.array([y0]))[0]):.2f}', ''])
for k, (x0, y0) in enumerate(PIPE): e, n_ = to_mga(x0, y0); rows.append(['pipeline', 'Goldfields pipeline (above ground)', f'vertex {k + 1}, OD 760', f'{e:.2f}', f'{n_:.2f}', f'{float(ground_at(np.array([x0]), np.array([y0]))[0]) + 1.28:.2f}', 'pipe crown'])
rows.append(['trees', 'tree crowns generated', str(len(trees)), '', '', '', 'heights 9-27 m'])
with open(os.path.join(OUT, 'mundaring_weir_truth.csv'), 'w', newline='') as f: csv.writer(f).writerows(rows)
print('truth rows', len(rows) - 1, 'dam', DAM_Y0, DAM_Y1, 'toe x', toe_x)
