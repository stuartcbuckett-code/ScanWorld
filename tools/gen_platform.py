"""Synthetic offshore wellhead platform point cloud (~15 x 15 m, 30 m high), in the style of
yellow-painted topsides: jacket legs and bracing, three decks with UB/PFC framing, wells and
Christmas trees, manifold, separator, scrubber, vent stack, pipe rack, firewater ring main,
gate valves with handwheels, flanges, expansion loop, stairs, handrails, crane, cable trays.
Writes LAZ, E57 (one scan per scanner set-up, with poses) and a truth CSV of what was built."""
import numpy as np, laspy, csv, math, sys
from pye57 import libe57 as l

rng = np.random.default_rng(20261110)
P, N, C = [], [], []          # points, normals, colours (uint8)
TRUTH = []                   # rows describing built elements
D_PIPE, D_STEEL, D_PLATE, D_EQ = 2600., 1800., 900., 1500.   # points per m² before visibility

YEL = (232, 188, 36); YEL2 = (214, 170, 30); WHITE = (236, 236, 230); RED = (200, 40, 34)
GREY = (150, 152, 150); GALV = (175, 178, 176); RUST = (96, 70, 52); DECK = (190, 172, 104)
BEIGE = (210, 200, 175); DARK = (60, 62, 64); ORANGE = (230, 120, 30); GREEN = (40, 170, 90)
PALE = (226, 208, 128); SPLASH = (150, 150, 92); RUSTO = (190, 92, 40); BLUE = (30, 90, 200); MODGREY = (168, 172, 172); BLACK = (35, 35, 38)

def V(*a): return np.array(a, dtype=float)
def unit(v): v = np.asarray(v, float); return v / np.linalg.norm(v)
def frame(ax):
    ax = unit(ax); h = V(0, 0, 1) if abs(ax[2]) < 0.9 else V(1, 0, 0)
    u = unit(np.cross(ax, h)); return u, np.cross(ax, u)

def add(pts, nrm, col, jitter=3):
    n = len(pts)
    if n == 0: return
    c = np.clip(np.array(col)[None, :] + rng.normal(0, jitter, (n, 1)), 0, 255)
    P.append(pts); N.append(nrm); C.append(c.astype(np.uint8))

def cnt(area, dens): return max(1, int(rng.poisson(area * dens)))

def cyl(p0, p1, r, col, dens=D_PIPE, caps=False):
    p0, p1 = V(*p0), V(*p1); ax = p1 - p0; L = np.linalg.norm(ax); ax = ax / L; u, v = frame(ax)
    n = cnt(2 * math.pi * r * L, dens); t = rng.random(n) * L; a = rng.random(n) * 2 * math.pi
    rad = np.cos(a)[:, None] * u + np.sin(a)[:, None] * v
    add(p0 + t[:, None] * ax + r * rad, rad, col)
    if caps:
        disc(p0, -ax, 0, r, col, dens); disc(p1, ax, 0, r, col, dens)

def disc(c, nrm, r0, r1, col, dens=D_PIPE):
    c = V(*c); nrm = unit(nrm); u, v = frame(nrm)
    n = cnt(math.pi * (r1 * r1 - r0 * r0), dens); rr = np.sqrt(r0 * r0 + rng.random(n) * (r1 * r1 - r0 * r0)); a = rng.random(n) * 2 * math.pi
    add(c + rr[:, None] * (np.cos(a)[:, None] * u + np.sin(a)[:, None] * v), np.tile(nrm, (n, 1)), col)

def rect(o, A, B, col, dens=D_PLATE, both=True):
    o, A, B = V(*o), V(*A), V(*B); nrm = unit(np.cross(A, B)); area = np.linalg.norm(np.cross(A, B))
    n = cnt(area, dens); s, t = rng.random(n), rng.random(n); pts = o + s[:, None] * A + t[:, None] * B
    add(pts, np.tile(nrm, (n, 1)), col)
    if both:
        n2 = cnt(area, dens); s, t = rng.random(n2), rng.random(n2); add(o + s[:, None] * A + t[:, None] * B, np.tile(-nrm, (n2, 1)), col)

def box(c, ex, ey, ez, col, dens=D_EQ):
    """box centred at c with half-extent vectors ex, ey, ez"""
    c, ex, ey, ez = V(*c), V(*ex), V(*ey), V(*ez)
    for a, b, k in ((ey, ez, ex), (ex, ez, ey), (ex, ey, ez)):
        for sgn in (-1, 1):
            o = c + sgn * k - a - b; rect(o, 2 * a, 2 * b, col, dens, both=False)
            N[-1][:] = sgn * unit(k)

def torus_seg(cc, u, v, n, R, r, ang, col, dens=D_PIPE):
    area = 2 * math.pi * r * R * ang; m = cnt(area, dens) * 2
    th = rng.random(m) * ang; ph = rng.random(m) * 2 * math.pi
    keep = rng.random(m) < (R + r * np.cos(ph)) / (R + r); th, ph = th[keep], ph[keep]
    d = np.cos(th)[:, None] * u + np.sin(th)[:, None] * v
    nrm = np.cos(ph)[:, None] * d + np.sin(ph)[:, None] * n
    add(cc + R * d + r * nrm, nrm, col)

def dished(c, ax, R, col, dens=D_EQ):
    """2:1 ellipsoidal head bulging along ax from centre c"""
    ax = unit(ax); u, v = frame(ax); h = R / 2
    n = cnt(2 * math.pi * R * R * 0.75, dens); z = rng.random(n); a = rng.random(n) * 2 * math.pi
    rr = np.sqrt(1 - z * z); pts = c + (R * rr * np.cos(a))[:, None] * u + (R * rr * np.sin(a))[:, None] * v + (h * z)[:, None] * ax
    nrm = (rr * np.cos(a) / R)[:, None] * u + (rr * np.sin(a) / R)[:, None] * v + (z / h)[:, None] * ax
    add(pts, nrm / np.linalg.norm(nrm, axis=1)[:, None], col)

# ---------- pipe helpers ----------
PIPE = {50: .0603, 80: .0889, 100: .1143, 150: .1683, 200: .2191, 250: .273, 300: .3238, 750: .762}
def flange(c, ax, dn, col=YEL, thick=None):
    od = PIPE[dn]; fo = {50: .152, 80: .190, 100: .229, 150: .279, 200: .343, 250: .406, 300: .483, 750: 1.0}[dn] / 2
    t = thick or max(0.02, od * 0.18); c, ax = V(*c), unit(ax)
    a, b = c - ax * t / 2, c + ax * t / 2
    cyl(a, b, fo, col); disc(a, -ax, od / 2, fo, col); disc(b, ax, od / 2, fo, col)
    # bolts
    u, v = frame(ax); nb = 8 if dn <= 200 else 12
    for k in range(nb):
        q = (math.cos(2 * math.pi * k / nb) * u + math.sin(2 * math.pi * k / nb) * v) * (fo - 0.03)
        cyl(a - ax * 0.03 + q, b + ax * 0.03 + q, 0.009, DARK, dens=D_PIPE)
    TRUTH.append(['flange', f'DN{dn}', f'OD {fo*2000:.0f}', *np.round(c, 3), '', '', '', f'{t*1000:.0f} mm thick'])

def gate_valve(c, ax, dn, up=V(0, 0, 1), col=YEL, tag=''):
    """flanged gate valve with bonnet and handwheel; ax = pipe direction"""
    od = PIPE[dn]; c, ax = V(*c), unit(ax)
    if abs(np.dot(unit(up), ax)) > 0.9: up = V(1, 0, 0) if abs(ax[0]) < 0.9 else V(0, 1, 0)
    up = unit(up - np.dot(up, ax) * ax)
    L = max(0.25, od * 2.2); flange(c - ax * L / 2, ax, dn, col); flange(c + ax * L / 2, ax, dn, col)
    cyl(c - ax * L / 2, c + ax * L / 2, od * 0.75, col)                          # body
    side = np.cross(ax, up)
    box(c + up * od * 0.4, ax * od * 0.6, side * od * 0.55, up * od * 0.5, col)      # body block
    top = c + up * (od * 0.9 + od * 2.0)
    cyl(c + up * od * 0.9, top, od * 0.32, col)                                # bonnet
    cyl(top, top + up * od * 1.1, 0.02, GREY)                                  # stem
    hw = top + up * od * 0.9; Rw = max(0.15, od * 1.5)
    u2, v2 = frame(up); torus_seg(hw, u2, v2, up, Rw, 0.016, 2 * math.pi, col)
    for k in range(3):
        d = math.cos(2 * math.pi * k / 3) * u2 + math.sin(2 * math.pi * k / 3) * v2
        cyl(hw, hw + d * Rw, 0.012, col)
    TRUTH.append(['valve', f'DN{dn} gate valve {tag}'.strip(), f'handwheel Ø{Rw*2000:.0f}', *np.round(c, 3), *np.round(ax, 3), ''])
    return L

def route(pts, dn, col=YEL, name='', valves=(), flanges=(), bend_k=1.5, bands=None):
    if bands is None: bands = col == YEL
    """polyline pipe with long-radius elbows. valves/flanges: list of (segment index, fraction)."""
    pts = [V(*p) for p in pts]; od = PIPE[dn]; r = od / 2; Rb = bend_k * od
    trims = [0.0] * len(pts); bends = []
    for i in range(1, len(pts) - 1):
        a, b = unit(pts[i] - pts[i - 1]), unit(pts[i + 1] - pts[i]); ang = math.acos(np.clip(np.dot(a, b), -1, 1))
        if ang < 1e-3: continue
        d = Rb * math.tan(ang / 2); trims[i] = d
        T1 = pts[i] - a * d; w = unit(b - np.dot(a, b) * a); cc = T1 + w * Rb
        u = unit(T1 - cc); vv = a; nn = np.cross(u, vv)
        bends.append((cc, u, vv, nn, ang))
        torus_seg(cc, u, vv, nn, Rb, r, ang, col)
        TRUTH.append(['elbow', name, f'DN{dn} OD {od*1000:.1f}', *np.round(pts[i], 3), '', '', '', f'{math.degrees(ang):.0f} deg, R {Rb:.3f}'])
    for i in range(len(pts) - 1):
        a = unit(pts[i + 1] - pts[i]); s = pts[i] + a * trims[i]; e = pts[i + 1] - a * trims[i + 1]
        cuts = []
        for (si, f) in valves:
            if si == i: cuts.append(('v', s + (e - s) * f))
        for (si, f) in flanges:
            if si == i: cuts.append(('f', s + (e - s) * f))
        cuts.sort(key=lambda q: np.dot(q[1] - s, a))
        cur = s
        for kind, q in cuts:
            if kind == 'v':
                L = gate_valve(q, a, dn, tag=name); cyl(cur, q - a * L / 2, r, col); cur = q + a * L / 2
            else:
                flange(q, a, dn, col); cyl(cur, q - a * 0.03, r, col); cur = q + a * 0.03
        if np.dot(e - cur, a) > 0.005: cyl(cur, e, r, col)
        if bands and np.linalg.norm(e - s) > 1.2:
            for t in np.arange(0.6, np.linalg.norm(e - s) - 0.3, 3.0):
                q = s + a * t; cyl(q, q + a * 0.12, r + 0.002, RED); cyl(q + a * 0.2, q + a * 0.32, r + 0.002, RED)
        TRUTH.append(['pipe', name, f'DN{dn} OD {od*1000:.1f}', *np.round(s, 3), *np.round(e, 3), f'L {np.linalg.norm(e-s):.3f}'])

# ---------- steel helpers ----------
SEC = {'610UB125': (.612, .229, .0196, .0119), '310UB40.4': (.304, .165, .0102, .0061), '250UC72.9': (.254, .254, .0142, .0086),
       '150UC23.4': (.152, .152, .0068, .0061), '200PFC': (.2, .075, .012, .006), '380PFC': (.38, .1, .0175, .01)}
def ibeam(p0, p1, sec, col=YEL, up=V(0, 0, 1), name=''):
    d, b, tf, tw = SEC[sec]; p0, p1 = V(*p0), V(*p1); ax = unit(p1 - p0); up = unit(up - np.dot(up, ax) * ax); side = np.cross(ax, up)
    L = np.linalg.norm(p1 - p0); mid = (p0 + p1) / 2
    for z in (d / 2 - tf / 2, -d / 2 + tf / 2):
        box(mid + up * z, ax * L / 2, side * b / 2, up * tf / 2, col, D_STEEL)
    box(mid, ax * L / 2, side * tw / 2, up * (d / 2 - tf), col, D_STEEL)
    TRUTH.append(['steel', name or sec, sec, *np.round(p0, 3), *np.round(p1, 3), f'L {L:.3f}'])

def channel(p0, p1, sec, col=YEL, up=V(0, 0, 1), flip=1, name=''):
    d, b, tf, tw = SEC[sec]; p0, p1 = V(*p0), V(*p1); ax = unit(p1 - p0); up = unit(up - np.dot(up, ax) * ax); side = np.cross(ax, up) * flip
    L = np.linalg.norm(p1 - p0); mid = (p0 + p1) / 2
    box(mid, ax * L / 2, side * tw / 2, up * d / 2, col, D_STEEL)
    for z in (d / 2 - tf / 2, -d / 2 + tf / 2):
        box(mid + up * z + side * b / 2, ax * L / 2, side * b / 2, up * tf / 2, col, D_STEEL)
    TRUTH.append(['steel', name or sec, sec, *np.round(p0, 3), *np.round(p1, 3), f'L {L:.3f}'])

def tube(p0, p1, od, col=YEL, name='', dens=D_STEEL):
    cyl(p0, p1, od / 2, col, dens)
    TRUTH.append(['tubular', name, f'OD {od*1000:.0f}', *np.round(V(*p0), 3), *np.round(V(*p1), 3), f'L {np.linalg.norm(V(*p1)-V(*p0)):.3f}'])

# ================= THE PLATFORM =================
ZC, ZM, ZU = 12.0, 18.0, 24.0                # top of deck plate: cellar, main, upper
H = 7.5
# ---- jacket legs (battered 1:12 below cellar deck), deck legs above
for sx in (-1, 1):
    for sy in (-1, 1):
        top = V(6 * sx, 6 * sy, ZC - 0.65); bot = V(7 * sx, 7 * sy, -0.3)
        cyl(bot, V(*(bot + (top - bot) * 0.3)), 0.6, SPLASH, D_STEEL)                # splash zone, weathered
        cyl(V(*(bot + (top - bot) * 0.3)), top, 0.6, PALE, D_STEEL)
        TRUTH.append(['tubular', 'jacket leg', 'OD 1200', *np.round(bot, 3), *np.round(top, 3), ''])
        tube(V(6 * sx, 6 * sy, ZC - 0.65), V(6 * sx, 6 * sy, ZU - 0.65), 1.0, YEL, 'deck leg')
def leg_at(sx, sy, z):
    t = (z + 0.3) / (ZC - 0.65 + 0.3); return V((7 - t) * sx, (7 - t) * sy, z)
# jacket horizontals at +4 and +10.5, X braces between on each face
for z in (4.0, 10.6):
    for (a, b) in (((-1, -1), (1, -1)), ((1, -1), (1, 1)), ((1, 1), (-1, 1)), ((-1, 1), (-1, -1))):
        p, q = leg_at(*a, z), leg_at(*b, z); d = unit(q - p); cyl(p + d * 0.6, q - d * 0.6, 0.3, PALE, D_STEEL)
        TRUTH.append(['tubular', 'jacket horizontal', 'OD 600', *np.round(p, 3), *np.round(q, 3), ''])
for (a, b) in (((-1, -1), (1, -1)), ((1, -1), (1, 1)), ((1, 1), (-1, 1)), ((-1, 1), (-1, -1))):
    mid = (leg_at(*a, 4.0) + leg_at(*b, 4.0)) / 2
    for e_ in (a, b):
        p = leg_at(*e_, 10.6); d = unit(mid - p); cyl(p + d * 0.7, mid - d * 0.35, 0.25, PALE, D_STEEL)
        TRUTH.append(['tubular', 'jacket K-brace', 'OD 500', *np.round(p, 3), *np.round(mid, 3), ''])
# ---- conductors (4 wells) from sea to cellar deck, conductor guide frame
WELLS = [(-3.5, -4.0), (-1.5, -4.0), (-3.5, -2.0), (-1.5, -2.0)]
for (x, y) in WELLS:
    cyl(V(x, y, -0.3), V(x, y, 10.2), PIPE[750] / 2, RUSTO, D_STEEL); cyl(V(x, y, 10.2), V(x, y, ZC - 0.6), PIPE[750] / 2, YEL, D_STEEL)
    TRUTH.append(['tubular', 'conductor', 'OD 762', x, y, -0.3, x, y, ZC - 0.6, ''])
    for zg in (4.0, 10.6):  # guide collar + funnel
        cyl(V(x, y, zg - 0.25), V(x, y, zg + 0.15), 0.47, YEL, D_STEEL)
        n_ = cnt(2.2, D_STEEL); th = rng.random(n_) * 2 * math.pi; hh = rng.random(n_) * 0.35; rr = 0.47 + hh * 0.6
        add(np.c_[x + rr * np.cos(th), y + rr * np.sin(th), zg + 0.15 + hh], np.c_[np.cos(th), np.sin(th), -0.6 * np.ones(n_)] / 1.17, YEL)
for z in (4.0, 10.6):
    for x0, x1, y0, y1 in ((-4.4, -0.6, -4.0, -4.0), (-4.4, -0.6, -2.0, -2.0)):
        cyl(V(x0, y0, z), V(x1, y1, z), 0.11, YEL2, D_STEEL)
    cyl(leg_at(-1, -1, z) + V(0.6, 0.6, 0), V(-3.5, -4.0, z), 0.11, YEL2, D_STEEL)
cx_, cy_ = 8.4, 3.0
cyl(V(cx_, cy_, -0.3), V(cx_, cy_, 8.0), 0.3, PALE, D_STEEL); TRUTH.append(['tubular', 'sump caisson', 'OD 600', cx_, cy_, -0.3, cx_, cy_, 8.0, ''])
n_ = cnt(3.0, D_STEEL); th = rng.random(n_) * 2 * math.pi; hh = rng.random(n_) * 0.5; rr = 0.3 + hh * 0.9
add(np.c_[cx_ + rr * np.cos(th), cy_ + rr * np.sin(th), 8.0 + hh], np.c_[np.cos(th), np.sin(th), -0.9 * np.ones(n_)] / 1.35, YEL)
cyl(V(cx_, cy_, 7.0), leg_at(1, 1, 7.0) + V(0.4, -0.5, 0), 0.18, PALE, D_STEEL); cyl(V(cx_, cy_, 3.0), leg_at(1, 1, 3.0) + V(0.4, -0.5, 0), 0.18, PALE, D_STEEL)
# ---- boat landing on south face
for x in (-2.0, 0.0, 2.0):
    cyl(V(x, -8.6, -0.3), V(x, -8.6, 4.2), 0.17, YEL, D_STEEL)
for z in (0.5, 2.0, 3.5):
    cyl(V(-2.4, -8.6, z), V(2.4, -8.6, z), 0.11, YEL, D_STEEL)
rect(V(-2.6, -8.6, 4.2), V(5.2, 0, 0), V(0, 1.6, 0), DECK)
for x in (-2.0, 2.0): cyl(V(x, -8.6, 4.2), leg_at(np.sign(x), -1, 4.2) + V(0, 0.4, 0), 0.11, YEL2, D_STEEL)

# ---- decks: plate + framing + edge channels + handrails
def deck(z, x0, x1, y0, y1, holes=()):
    # plate top and underside, skipping holes (rects)
    n = cnt((x1 - x0) * (y1 - y0), D_PLATE); xs = x0 + rng.random(n) * (x1 - x0); ys = y0 + rng.random(n) * (y1 - y0)
    ok = np.ones(n, bool)
    for (hx0, hx1, hy0, hy1) in holes: ok &= ~((xs > hx0) & (xs < hx1) & (ys > hy0) & (ys < hy1))
    # leave leg penetrations
    for sx in (-6, 6):
        for sy in (-6, 6): ok &= (xs - sx) ** 2 + (ys - sy) ** 2 > 0.55 ** 2
    xs, ys = xs[ok], ys[ok]
    edge = (np.minimum(np.minimum(xs - x0, x1 - xs), np.minimum(ys - y0, y1 - ys)) < 0.45) | (np.abs(ys - 0.0) < 0.06) | (np.abs(xs - 2.6) < 0.06)
    cols = np.where(edge[:, None], np.array([[222, 186, 52]]), np.array([[132, 136, 132]]))
    grid = ((np.floor(xs / 0.04) + np.floor(ys / 0.1)) % 2 == 0) & ~edge          # grating bars read as fine light/dark stripes
    cols = np.clip(cols + np.where(grid[:, None], 10, -14) + rng.normal(0, 3, (len(xs), 1)), 0, 255)
    P.append(np.c_[xs, ys, np.full(len(xs), z)]); N.append(np.tile(V(0, 0, 1), (len(xs), 1))); C.append(cols.astype(np.uint8))
    add(np.c_[xs, ys, np.full(len(xs), z - 0.012)], np.tile(V(0, 0, -1), (len(xs), 1)), YEL2, 14)
    ts = z - 0.012
    # primary girders 610UB along x, secondary 310UB along y
    for y in (-6.0, 0.0, 6.0):
        if y0 <= y <= y1: ibeam(V(x0, y, ts - .306), V(x1, y, ts - .306), '610UB125', name='deck girder')
    xs2 = np.arange(x0 + 1.25, x1, 2.5)
    for x in xs2:
        for (ya, yb) in ((-6.0, 0.0), (0.0, 6.0), (y0, -6.0), (6.0, y1)):
            ya, yb = max(ya, y0), min(yb, y1)
            if yb - ya > 0.6: ibeam(V(x, ya + 0.12, ts - .152), V(x, yb - 0.12, ts - .152), '310UB40.4', name='deck beam')
    # perimeter 380PFC, toes out
    channel(V(x0, y0, ts - .19), V(x1, y0, ts - .19), '380PFC', flip=-1, name='edge channel')
    channel(V(x0, y1, ts - .19), V(x1, y1, ts - .19), '380PFC', flip=1, name='edge channel')
    channel(V(x0, y0, ts - .19), V(x0, y1, ts - .19), '380PFC', flip=1, name='edge channel')
    channel(V(x1, y0, ts - .19), V(x1, y1, ts - .19), '380PFC', flip=-1, name='edge channel')

def handrail(pts, z, gaps=()):
    pts = [V(p[0], p[1], 0.0) for p in pts]
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]; L = np.linalg.norm(b - a); d = (b - a) / L
        segs = [(0, L)]
        for (gi, g0, g1) in gaps:
            if gi == i: segs = [(s0, min(s1, g0)) for s0, s1 in segs if s0 < g0] + [(max(s0, g1), s1) for s0, s1 in segs if s1 > g1]
        for s0, s1 in segs:
            if s1 - s0 < 0.2: continue
            p, q = a + d * s0, a + d * s1
            for hz in (0.55, 1.1): cyl(p + V(0, 0, z + hz), q + V(0, 0, z + hz), 0.024, YEL, D_PIPE * 0.7)
            for t in np.arange(0, s1 - s0 + 1e-6, 1.5):
                c = p + d * t; box(c + V(0, 0, z + 0.55), V(0.025, 0, 0), V(0, 0.025, 0), V(0, 0, 0.55), YEL, D_STEEL)
            rect(p + V(0, 0, z), q - p, V(0, 0, 0.1), YEL, D_STEEL)

deck(ZC, -H, H, -H, H, holes=[(-4.0, -1.0, -4.5, -1.5)])            # well bay opening on cellar deck
deck(ZM, -H, H, -H, H, holes=[(-4.0, -1.0, -4.5, -1.5), (5.2, 7.2, -1.6, 1.4)])
deck(ZU, -H, H, -H, 2.5)
handrail([(-H, -H), (H, -H), (H, H), (-H, H), (-H, -H)], ZC, gaps=[(3, 1.0, 2.2)])
handrail([(-H, -H), (H, -H), (H, H), (-H, H), (-H, -H)], ZM, gaps=[(1, 6.0, 7.2)])
handrail([(-H, -H), (H, -H), (H, 2.5), (-H, 2.5), (-H, -H)], ZU, gaps=[(1, 6.0, 7.5)])
handrail([(-4.0, -1.5), (-1.0, -1.5)], ZM)
# intermediate deck columns
for z0, z1 in ((ZC, ZM - 0.62), (ZM, ZU - 0.62)):
    for (x, y) in ((0.0, -6.0), (0.0, 6.0) if z0 == ZC else (0.0, 2.3)):
        ibeam(V(x, y, z0), V(x, y, z1), '250UC72.9', up=V(1, 0, 0), name='deck column')

for z0 in (ZC, ZM):
    for sx in (-1, 1):
        for sy in (-1, 1):
            if z0 == ZM and sy == 1: continue
            leg = V(6 * sx, 6 * sy, z0 + 0.3)
            for dvec in (V(-sx, 0, 0), V(0, -sy, 0)):
                tgt = leg + dvec * 2.6 + V(0, 0, 4.9); cyl(leg + dvec * 0.55, tgt, 0.11, YEL, D_STEEL)
                TRUTH.append(['tubular', 'deck knee brace', 'OD 219', *np.round(leg + dvec * 0.55, 3), *np.round(tgt, 3), ''])
# ---- stairs: cellar -> main on east side, main -> upper on east side further south
def stair(x, y0, z0, z1, width=0.9):
    run = (z1 - z0); y1 = y0 + run
    for s in (-1, 1):
        channel(V(x + s * width / 2, y0, z0 + 0.1), V(x + s * width / 2, y1, z1 + 0.1), '200PFC', up=unit(V(0, -1, 1)), flip=s, name='stair stringer')
    n = int(run / 0.2)
    for k in range(1, n):
        yy, zz = y0 + k * 0.2, z0 + k * 0.2
        rect(V(x - width / 2, yy - 0.12, zz), V(width, 0, 0), V(0, 0.25, 0), YEL2, D_STEEL)
    for s in (-1, 1):
        cyl(V(x + s * (width / 2 + 0.05), y0, z0 + 1.0), V(x + s * (width / 2 + 0.05), y1, z1 + 1.0), 0.024, YEL, D_PIPE * 0.7)
stair(6.6, -6.4, ZC, ZM)
stair(6.6, -7.2 + 0.1, ZM, ZU) if False else stair(-6.6, -4.0, ZM, ZU)

# ---- wells: wellhead + Christmas tree stack on cellar deck
for i, (x, y) in enumerate(WELLS):
    b = V(x, y, ZC)
    cyl(b, b + V(0, 0, 0.6), 0.32, WHITE, D_EQ, caps=False)                    # wellhead housing
    flange(b + V(0, 0, 0.62), V(0, 0, 1), 300, WHITE)
    for k, zz in enumerate((0.95, 1.45)):                                       # master valves
        box(b + V(0, 0, zz), V(0.22, 0, 0), V(0, 0.22, 0), V(0, 0, 0.2), WHITE, D_EQ)
        hw = b + V(0, -0.45, zz); u2, v2 = frame(V(0, 1, 0)); torus_seg(hw, u2, v2, V(0, 1, 0), 0.2, 0.015, 2 * math.pi, WHITE); cyl(hw, b + V(0, -0.22, zz), 0.02, GREY)
    cross = b + V(0, 0, 1.95); box(cross, V(0.24, 0, 0), V(0, 0.24, 0), V(0, 0, 0.24), WHITE, D_EQ)            # flow cross
    box(cross + V(0, 0, 0.5), V(0.2, 0, 0), V(0, 0.2, 0), V(0, 0, 0.22), WHITE, D_EQ)                       # swab valve
    disc(cross + V(0, 0, 0.75), V(0, 0, 1), 0, 0.16, WHITE); cyl(cross + V(0, 0, 0.72), cross + V(0, 0, 0.9), 0.12, WHITE)  # tree cap
    for k in range(8):  # rusty studs at the tree flanges
        a_ = 2 * math.pi * k / 8; q = V(0.2 * math.cos(a_), 0.2 * math.sin(a_), 0)
        cyl(b + V(0, 0, 0.5) + q, b + V(0, 0, 0.75) + q, 0.018, RUST, D_PIPE)
    g0 = cross + V(0, 0, 0.9); cyl(g0, g0 + V(0, 0, 0.2), 0.012, GREY); disc(g0 + V(0, 0.03, 0.3), V(0, -1, 0), 0, 0.08, WHITE); cyl(g0 + V(0, 0.03, 0.3), g0 + V(0, 0.08, 0.3), 0.08, GREY)  # pressure gauge
    TRUTH.append(['wellhead', f'Well W-{i+1} Christmas tree', 'height 2.9 m', x, y, ZC, x, y, ZC + 2.9, ''])
    # wing outlet -> choke -> flowline DN100 to header at x=1.6
    wing = cross + V(0.24, 0, 0)
    route([wing, wing + V(0.9, 0, 0), V(wing[0] + 0.9, y, ZC + 0.9), V(1.6 - 0.3, y, ZC + 0.9)], 100, YEL, f'W-{i+1} flowline', valves=[(0, 0.55)])
    box(wing + V(1.25, 0, -0.35), V(0.18, 0, 0), V(0, 0.18, 0), V(0, 0, 0.15), GREY)                       # choke actuator lump
# production header DN200 along y at x=1.6, z=ZC+0.9, rising to separator inlet on main deck
route([V(1.6, -5.2, ZC + 0.9), V(1.6, 3.5, ZC + 0.9), V(1.6, 3.5, ZM + 3.2), V(-0.2, 3.5, ZM + 3.2), V(-0.2, 3.5, ZM + 2.7)], 200, YEL, 'production header', valves=[(0, 0.82), (1, 0.15)], flanges=[(1, 0.6)])
for y in (-4.0, -2.0):  # pipe supports for header
    box(V(1.6, y + 1.0, ZC + 0.4), V(0.08, 0, 0), V(0, 0.08, 0), V(0, 0, 0.4), YEL2, D_STEEL)
# gas lift riser DN100 up leg (-6,-6) to cellar deck, gas-lift header with drops to each tree
route([V(-6.4, -5.2, -0.3), V(-6.4, -5.2, ZC + 1.4), V(-4.4, -5.2, ZC + 1.4), V(-1.0, -5.2, ZC + 1.4)], 100, YEL, 'gas lift riser + header', valves=[(1, 0.5)])
for (x, y) in WELLS:
    if y < -3: route([V(x + 0.35, -5.2, ZC + 1.4), V(x + 0.35, y, ZC + 1.4), V(x + 0.35, y, ZC + 0.7)], 50, YEL, 'gas lift drop')
def riser_clamp(c, r, leg):
    c = V(*c); cyl(c - V(0, 0, 0.2), c + V(0, 0, 0.2), r + 0.06, YEL, D_STEEL); disc(c + V(0, 0, 0.2), V(0, 0, 1), r, r + 0.06, YEL); disc(c - V(0, 0, 0.2), V(0, 0, -1), r, r + 0.06, YEL)
    d = unit(V(leg[0] - c[0], leg[1] - c[1], 0)); box(c + d * (r + 0.1), d * 0.08, unit(np.cross(V(0, 0, 1), d)) * 0.12, V(0, 0, 0.2), YEL, D_STEEL)   # hinge lugs
    L = np.linalg.norm(V(leg[0], leg[1], 0) - V(c[0], c[1], 0)) - 0.55 - r; m = c + d * (r + 0.15 + L / 2)
    box(m, d * L / 2, unit(np.cross(V(0, 0, 1), d)) * 0.15, V(0, 0, 0.18), YEL, D_STEEL)
    TRUTH.append(['clamp', 'riser clamp', f'bore {r*2000:.0f}', *np.round(c, 3), '', '', '', ''])
for z in (2.5, 6.5, 9.5):
    riser_clamp(V(-6.4, -5.2, z), PIPE[100] / 2, leg_at(-1, -1, z))
# chemical injection skid on cellar deck
box(V(4.5, 4.5, ZC + 0.9), V(1.0, 0, 0), V(0, 0.7, 0), V(0, 0, 0.9), BEIGE)
box(V(4.0, 4.5, ZC + 2.05), V(0.4, 0, 0), V(0, 0.4, 0), V(0, 0, 0.25), GREY)
route([V(3.5, 4.0, ZC + 1.2), V(-1.0, 4.0, ZC + 1.2), V(-1.0, -1.2, ZC + 1.2)], 50, YEL, 'chemical injection')

# ---- main deck: production separator V-1010 (horizontal, white) on saddles
sc = V(-1.5, 3.6, ZM + 1.6); Rv = 1.0; Ls = 5.0
cyl(sc - V(Ls / 2, 0, 0), sc + V(Ls / 2, 0, 0), Rv, WHITE, D_EQ)
dished(sc - V(Ls / 2, 0, 0), V(-1, 0, 0), Rv, WHITE); dished(sc + V(Ls / 2, 0, 0), V(1, 0, 0), Rv, WHITE)
for x in (-3.2, 0.2):
    box(V(x, 3.6, ZM + 0.35), V(0.15, 0, 0), V(0, 0.85, 0), V(0, 0, 0.35), YEL2)
TRUTH.append(['vessel', 'V-1010 production separator', 'ID 2000, T/T 5000', *np.round(sc - V(Ls / 2, 0, 0), 3), *np.round(sc + V(Ls / 2, 0, 0), 3), 'horizontal'])
# gas scrubber V-1020 vertical
gc = V(4.6, 5.0, ZM); Rg = 0.55
cyl(gc + V(0, 0, 1.0), gc + V(0, 0, 4.2), Rg, WHITE, D_EQ); dished(gc + V(0, 0, 4.2), V(0, 0, 1), Rg, WHITE); dished(gc + V(0, 0, 1.0), V(0, 0, -1), Rg, WHITE)
cyl(gc, gc + V(0, 0, 0.75), Rg, YEL2, D_EQ)
TRUTH.append(['vessel', 'V-1020 gas scrubber', 'ID 1100, T/T 3200', *np.round(gc + V(0, 0, 1.0), 3), *np.round(gc + V(0, 0, 4.2), 3), 'vertical'])
# gas line separator top -> expansion loop (inverted U, like the photo) -> scrubber inlet
route([V(0.6, 3.6, ZM + 2.6), V(0.6, 3.6, ZM + 3.0), V(1.4, 3.6, ZM + 3.0), V(1.4, 5.0, ZM + 3.0), V(2.4, 5.0, ZM + 3.0), V(2.4, 5.0, ZM + 4.3), V(3.4, 5.0, ZM + 4.3), V(3.4, 5.0, ZM + 3.0), V(4.05, 5.0, ZM + 3.0)], 150, YEL, 'gas line + loop', valves=[(4, 0.5)])
# scrubber top -> vent stack
route([V(4.6, 5.0, ZM + 4.75), V(4.6, 5.0, ZM + 5.4), V(6.4, 5.0, ZM + 5.4), V(6.4, 6.4, ZM + 5.4)], 150, YEL, 'vent line')
cyl(V(6.4, 6.4, ZM), V(6.4, 6.4, 30.0), PIPE[300] / 2, GREY, D_PIPE); TRUTH.append(['pipe', 'vent stack', 'DN300 OD 323.8', 6.4, 6.4, ZM, 6.4, 6.4, 30.0, ''])
cyl(V(6.4, 6.4, 29.4), V(6.4, 6.4, 29.8), 0.25, DARK, D_PIPE)                    # flame arrestor
for z in (ZU - 0.3, 27.5): cyl(V(6.4, 6.4, z), V(6.4, 2.6, ZU - 0.3 if z < 25 else 24.5), 0.06, YEL2, D_STEEL)  # stack bracing
# liquid outlet -> pig launcher -> export riser down leg (6,-6)
route([V(0.4, 3.6, ZM + 0.6), V(0.4, 3.6, ZM + 0.45), V(2.6, 3.6, ZM + 0.45), V(2.6, -3.0, ZM + 0.45), V(5.6, -3.0, ZM + 0.45)], 100, YEL, 'liquid outlet', valves=[(2, 0.3)])
pl0 = V(5.6, -3.0, ZM + 0.45)
cyl(pl0, pl0 + V(0, -0.5, 0), PIPE[200] / 2, YEL)                                # reducer approx
cyl(pl0 + V(0, -0.5, 0), pl0 + V(0, -2.9, 0), PIPE[300] / 2, YEL); disc(pl0 + V(0, -2.9, 0), V(0, -1, 0), 0, PIPE[300] / 2 + 0.06, YEL)
TRUTH.append(['equipment', 'pig launcher barrel', 'DN300 OD 323.8', *np.round(pl0 + V(0, -0.5, 0), 3), *np.round(pl0 + V(0, -2.9, 0), 3), ''])
for y in (-3.8, -5.6): box(V(5.6, y, ZM + 0.15), V(0.1, 0, 0), V(0, 0.1, 0), V(0, 0, 0.15), YEL2, D_STEEL)
route([pl0 + V(0, -0.25, 0.2), V(5.6, -3.25, ZM + 1.2), V(6.7, -3.25, ZM + 1.2), V(6.7, -5.4, ZM + 1.2), V(6.7, -5.4, -0.3)], 200, GREY, 'export riser', valves=[(2, 0.5)], flanges=[(3, 0.45)])
for z in (2.5, 6.5, 9.5):
    riser_clamp(V(6.7, -5.4, z), PIPE[200] / 2, leg_at(1, -1, z))
# pipe rack on main deck south edge: 4 lines on stanchions, ends turn up / down
for x in np.arange(-6.5, 5.0, 3.0):
    ibeam(V(x, -6.85, ZM), V(x, -6.85, ZM + 0.9), '150UC23.4', up=V(1, 0, 0), name='rack post'); ibeam(V(x, -5.25, ZM), V(x, -5.25, ZM + 0.9), '150UC23.4', up=V(1, 0, 0), name='rack post')
    channel(V(x, -6.95, ZM + 0.95), V(x, -5.15, ZM + 0.95), '200PFC', up=V(0, 0, 1), name='rack beam')
RACK = [(150, -6.6, RED, 'firewater'), (100, -6.2, YEL, 'fuel gas'), (80, -5.85, YEL, 'instrument air'), (50, -5.55, GREEN, 'utility water')]
for dn, y, col, nm in RACK:
    zc = ZM + 1.05 + PIPE[dn] / 2
    route([V(-6.9, y, zc), V(4.8, y, zc), V(4.8, y, ZM + 2.4 + (0.35 if dn == 150 else 0)), V(4.8, y + 4.0, ZM + 2.4 + (0.35 if dn == 150 else 0))], dn, col, nm + ' (rack)', valves=[(0, 0.2)] if dn >= 100 else ())
bv = V(-2.0, -6.2, ZM + 1.05 + PIPE[100] / 2); box(bv + V(0, 0, 0.32), V(0.12, 0, 0), V(0, 0.12, 0), V(0, 0, 0.14), BLUE); cyl(bv + V(0, 0, 0.06), bv + V(0, 0, 0.18), 0.03, BLUE)
TRUTH.append(['valve', 'fuel gas actuated valve (blue actuator)', 'DN100', *np.round(bv, 3), '', '', '', ''])
# firewater ring main (red) round three sides of main deck, low on posts
route([V(-7.0, -4.8, ZM + 0.5), V(-7.0, 7.0, ZM + 0.5), V(5.0, 7.0, ZM + 0.5), V(5.0, 6.3, ZM + 0.5)], 150, RED, 'firewater ring main', flanges=[(1, 0.5)])
for y in (-2.0, 2.0, 5.5):
    box(V(-7.0, y, ZM + 0.2), V(0.08, 0, 0), V(0, 0.08, 0), V(0, 0, 0.2), YEL2, D_STEEL)
# deluge / hydrant box and hose reel
box(V(-6.5, 1.0, ZM + 0.8), V(0.3, 0, 0), V(0, 0.35, 0), V(0, 0, 0.8), RED)

# ---- upper deck: switchroom module with louvres, crane, cable trays, mast, lights
mc = V(-3.5, -3.5, ZU + 1.6)
box(mc, V(2.5, 0, 0), V(0, 2.0, 0), V(0, 0, 1.6), MODGREY)
box(mc + V(0.8, 0.5, 1.85), V(0.8, 0, 0), V(0, 0.6, 0), V(0, 0, 0.25), DARK)   # HVAC unit on roof
for k in range(12):  # louvre slats on east wall
    z = ZU + 0.6 + k * 0.12; rect(V(-0.95, -4.6, z), V(0, 2.2, 0), V(0.06, 0, -0.05), DARK, D_EQ, both=False)
TRUTH.append(['building', 'switchroom module', '5.0 x 4.0 x 3.2', *np.round(mc - V(2.5, 2.0, 1.6), 3), *np.round(mc + V(2.5, 2.0, 1.6), 3), ''])
pc = V(4.0, -4.8, ZU)
cyl(pc, pc + V(0, 0, 3.0), 0.8, YEL, D_EQ); cyl(pc + V(0, 0, 3.0), pc + V(0, 0, 3.25), 1.0, DARK, D_EQ)
box(pc + V(0.9, 0.0, 3.9), V(0.7, 0, 0), V(0, 0.55, 0), V(0, 0, 0.65), YEL)
b0 = pc + V(0, 0, 3.6); b1 = V(-3.5, 1.8, 29.6); bd = unit(b1 - b0); bu = unit(np.cross(np.cross(bd, V(0, 0, 1)), bd))
bs = unit(np.cross(bd, bu)); Lb = np.linalg.norm(b1 - b0)
chords = [bu * 0.35 + bs * 0.3, bu * 0.35 - bs * 0.3, -bu * 0.25]
for ch in chords: cyl(b0 + ch, b1 + ch * 0.4, 0.05, YEL, D_PIPE)
nseg = int(Lb / 0.8)
for k in range(nseg):
    t0, t1 = k / nseg, (k + 1) / nseg
    for i_ in range(3):
        c0 = chords[i_] * (1 - 0.6 * t0); c1 = chords[(i_ + 1) % 3] * (1 - 0.6 * t1)
        cyl(b0 + bd * Lb * t0 + c0, b0 + bd * Lb * t1 + c1, 0.025, YEL, D_PIPE)
cyl(b1, b1 + V(0, 0, -1.4), 0.015, DARK, D_PIPE); box(b1 + V(0, 0, -1.6), V(0.15, 0, 0), V(0, 0.15, 0), V(0, 0, 0.2), ORANGE)
TRUTH.append(['equipment', 'pedestal crane', 'pedestal Ø1.6', *np.round(pc, 3), *np.round(b1, 3), 'boom tip'])
cyl(V(-6.6, -6.6, ZU), V(-6.6, -6.6, 30.0), 0.11, GREY, D_PIPE); TRUTH.append(['tubular', 'telecom mast', 'OD 220', -6.6, -6.6, ZU, -6.6, -6.6, 30.0, ''])
for k in range(3): box(V(-6.6, -6.6, 28.6 + k * 0.4), V(0.25, 0, 0), V(0, 0.04, 0), V(0, 0, 0.12), GREY)
# cable trays (ladder) under upper deck, galvanised
for y in (-1.0, -5.0):
    zt = ZU - 0.85
    for s in (-0.3, 0.3): box(V(0, y + s, zt), V(7.0, 0, 0), V(0, 0.005, 0), V(0, 0, 0.05), GALV, D_STEEL)
    for x in np.arange(-6.9, 7.0, 0.3): cyl(V(x, y - 0.3, zt - 0.04), V(x, y + 0.3, zt - 0.04), 0.012, GALV, D_STEEL)
    n = cnt(14 * 0.5, 800); add(np.c_[-7 + rng.random(n) * 14, y - 0.25 + rng.random(n) * 0.5, np.full(n, zt - 0.0) + rng.random(n) * 0.05], np.tile(V(0, 0, 1), (n, 1)), DARK)  # cables
    TRUTH.append(['cable tray', 'ladder tray 600', '600 wide', -7, y, zt, 7, y, zt, ''])
# electrical cabinets / local control panels (free-standing, plinth, door handles)
CAB = (196, 198, 194)
def cabinet(cx, cy, z, W, D, Hh, face, name):
    """face: direction the doors face, (1,0)/(-1,0)/(0,1)/(0,-1)"""
    fx, fy = face; ex = V(W / 2, 0, 0) if fy != 0 else V(0, W / 2, 0); ey = V(0, D / 2, 0) if fy != 0 else V(D / 2, 0, 0)
    box(V(cx, cy, z + 0.05), ex, ey, V(0, 0, 0.05), DARK)                                   # plinth
    box(V(cx, cy, z + 0.1 + Hh / 2), ex, ey, V(0, 0, Hh / 2), CAB)
    fo = V(cx, cy, 0) + V(fx, fy, 0) * (D / 2 + 0.01)
    for k in (-1, 1):                                                                       # door handles
        if W > 0.7: cyl(fo + V(0, 0, z + 0.1 + Hh * 0.55) + (ex / np.linalg.norm(ex)) * k * 0.05, fo + V(0, 0, z + 0.1 + Hh * 0.55 + 0.15) + (ex / np.linalg.norm(ex)) * k * 0.05, 0.008, DARK)
    TRUTH.append(['cabinet', name, f'{W*1000:.0f} x {D*1000:.0f} x {(Hh+0.1)*1000:.0f}', cx, cy, z, cx, cy, z + Hh + 0.1, f'faces {fx},{fy}'])
for k, x in enumerate((-4.9, -4.0, -3.1)): cabinet(x, 6.55, ZM, 0.8, 0.5, 2.0, (0, -1), f'MCC panel {k+1}')
cabinet(5.6, -6.6, ZC, 1.2, 0.4, 1.7, (0, 1), 'well control panel')
cabinet(0.8, -6.6, ZU, 0.6, 0.6, 1.8, (0, 1), 'telecom cabinet'); cabinet(1.7, -6.6, ZU, 0.6, 0.6, 1.8, (0, 1), 'UPS cabinet')
box(V(-1.6, 6.9, ZM + 1.1), V(0.2, 0, 0), V(0, 0.08, 0), V(0, 0, 0.15), CAB); TRUTH.append(['cabinet', 'junction box', '400 x 160 x 300', -1.6, 6.9, ZM + 0.95, -1.6, 6.9, ZM + 1.25, 'wall mounted'])
# people caught in the scan (for testing the remove-people filter): hi-vis coveralls, hard hat
def person(x, y, z, face=0.0, hat=(240, 240, 235), suit=(235, 110, 30)):
    c, s_ = math.cos(face), math.sin(face); fx = V(c, s_, 0); sx = V(-s_, c, 0); base = V(x, y, z)
    for k in (-1, 1): cyl(base + sx * 0.1 * k + V(0, 0, 0.02), base + sx * 0.1 * k + V(0, 0, 0.86), 0.075, (40, 50, 80), caps=True)          # legs
    box(base + V(0, 0, 1.16), sx * 0.21, fx * 0.12, V(0, 0, 0.30), suit)                                                                # torso
    for k in (-1, 1): cyl(base + sx * 0.27 * k + V(0, 0, 0.82), base + sx * 0.27 * k + V(0, 0, 1.42), 0.05, suit, caps=True)             # arms
    cyl(base + V(0, 0, 1.46), base + V(0, 0, 1.54), 0.055, (200, 160, 130))                                                              # neck
    dished(base + V(0, 0, 1.64), V(0, 0, 1), 0.105, hat); dished(base + V(0, 0, 1.64), V(0, 0, -1), 0.1, (200, 160, 130))               # head + hat
    TRUTH.append(['person', 'person (temporary)', '1.75 m', x, y, z, x, y, z + 1.75, 'remove before modelling'])
person(2.5, -2.0, ZM, 0.4); person(-1.0, 0.8, ZC, 2.0); person(3.2, 2.4, ZU, -1.2)
# light poles like the photo
for (x, y, z) in ((-7.2, 6.8, ZM), (7.2, -0.5, ZC), (7.2, 2.4, ZU)):
    cyl(V(x, y, z), V(x, y, z + 3.2), 0.045, YEL, D_PIPE); cyl(V(x, y, z + 3.2), V(x + 0.5 * (-np.sign(x)), y, z + 3.4), 0.03, YEL, D_PIPE)
    box(V(x + 0.6 * (-np.sign(x)), y, z + 3.35), V(0.18, 0, 0), V(0, 0.12, 0), V(0, 0, 0.07), GREY)

# ================= SCANNER SET-UPS, VISIBILITY, NOISE =================
P = np.concatenate(P); N = np.concatenate(N); C = np.concatenate(C)
SETUPS = [(-5.5, 5.5, ZC + 1.6), (3.0, -1.0, ZC + 1.6), (-2.5, -6.5, ZC + 1.6), (5.5, 6.5, ZC + 1.6),
          (-5.5, -0.5, ZM + 1.6), (2.0, 0.5, ZM + 1.6), (-4.5, 6.5, ZM + 1.6), (3.5, -6.0, ZM + 1.6),
          (2.0, -1.5, ZU + 1.6), (-5.5, 1.5, ZU + 1.6), (0.0, -9.2, 5.8), (5.0, 8.0, ZC - 3.5)]
S = np.array(SETUPS)
best = np.full(len(P), np.inf); owner = np.full(len(P), -1)
for k, s in enumerate(S):
    d = s[None, :] - P; dist = np.linalg.norm(d, axis=1); facing = np.einsum('ij,ij->i', d, N) / np.maximum(dist, 1e-9)
    # same-level rule: a deck blocks views between levels except through edges (rough occlusion stand-in)
    lvl_s = np.digitize(s[2], [ZC - 0.5, ZM - 0.5, ZU - 0.5]); lvl_p = np.digitize(P[:, 2], [ZC - 0.5, ZM - 0.5, ZU - 0.5])
    inside = (np.abs(P[:, 0]) < 7.0) & (np.abs(P[:, 1]) < 7.0)
    seen = (facing > 0.08) & (dist < 30) & ((lvl_s == lvl_p) | ~inside | (np.abs(lvl_s - lvl_p) == 1) & (rng.random(len(P)) < 0.25))
    better = seen & (dist < best); best[better] = dist[better]; owner[better] = k
keep = owner >= 0
# density falls with range, plus random dropout
keep &= rng.random(len(P)) < np.clip((9.0 / np.maximum(best, 1)) ** 2, 0.12, 1.0)
P, N, C, owner, best = P[keep], N[keep], C[keep], owner[keep], best[keep]
# ---------- realistic colour: sun + sky light, deck shadows, weathering, marine growth, per-set-up exposure
def vnoise(X, scale, seed):
    q = X / scale; i = np.floor(q).astype(np.int64); f = q - i; f = f * f * (3 - 2 * f)
    def h(a, b, c): v = (a * 73856093) ^ (b * 19349663) ^ (c * 83492791) ^ seed; v = (v ^ (v >> 13)) * 1274126177; return ((v ^ (v >> 16)) & 0xffff) / 65535.0
    out = 0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (f[:, 0] if dx else 1 - f[:, 0]) * (f[:, 1] if dy else 1 - f[:, 1]) * (f[:, 2] if dz else 1 - f[:, 2])
                out = out + w * h(i[:, 0] + dx, i[:, 1] + dy, i[:, 2] + dz)
    return out
Cf = C.astype(float)
sun = unit(V(0.45, 0.35, 0.82)); sky = V(0, 0, 1)
lam = np.clip(np.einsum('ij,j->i', N, sun), 0, 1); amb = 0.55 + 0.25 * np.einsum('ij,j->i', N, sky)
# shadow: under a deck footprint and below its underside -> mostly ambient light
inside = (np.abs(P[:, 0]) < 7.3) & (np.abs(P[:, 1]) < 7.3)
under = np.zeros(len(P), bool)
for zd, ylim in ((ZC, 7.5), (ZM, 7.5), (ZU, 2.5)):
    under |= inside & (P[:, 1] < ylim) & (P[:, 2] < zd - 0.05) & (P[:, 2] > zd - 7.0)
edge_light = np.clip((np.maximum(np.abs(P[:, 0]), np.abs(P[:, 1])) - 5.5) / 2.0, 0, 1)   # light leaks in near deck edges
direct = np.where(under, 0.25 + 0.6 * edge_light, 1.0)
shade = 0.80 * amb + 0.42 * lam * direct
shade = np.where(under, shade * 0.85, shade)
shade = shade / np.percentile(shade, 75)          # camera auto-exposure: typical lit paint reads at full brightness
shade = 0.62 + 0.38 * np.clip(shade, 0, 1.3)       # bounce light off the sea and sky lifts the shadows
# weathering: low-frequency dirt, vertical streaks, rust
dirt = vnoise(P, 1.7, 11) * 0.6 + vnoise(P, 0.35, 23) * 0.4
streak = vnoise(P * V(4.0, 4.0, 0.25), 1.0, 37)
Cf *= (0.93 + 0.12 * dirt)[:, None]
Cf *= (1 - 0.08 * np.clip(streak - 0.55, 0, 1) * 2.5)[:, None]
rustw = np.clip((vnoise(P, 0.25, 51) - 0.72) * 4, 0, 1) * np.clip(-N[:, 2] + 0.2, 0, 1) * 0.8     # undersides rust first
rustw = np.maximum(rustw, np.clip((vnoise(P, 0.6, 77) - 0.8) * 3, 0, 1) * 0.6)
Cf = Cf * (1 - rustw[:, None]) + np.array([[128, 72, 40]]) * rustw[:, None]
# splash zone: marine growth and staining from sea level to +3.5 m
mg = np.clip((3.5 - P[:, 2]) / 3.5, 0, 1) ** 1.3 * (0.6 + 0.4 * vnoise(P, 0.5, 91))
Cf = Cf * (1 - mg[:, None] * 0.8) + np.array([[78, 92, 58]]) * mg[:, None] * 0.8
# apply light, gentle tone curve
Cf = Cf * shade[:, None]
# per set-up camera exposure / white balance differences
expo = rng.normal(1.0, 0.05, len(S)); wb = rng.normal(0, 0.025, (len(S), 3))
Cf = Cf * (expo[owner][:, None] * (1 + wb[owner]))
Cf = 255 * (np.clip(Cf, 0, 400) / 255) ** 0.85
C = np.clip(Cf + rng.normal(0, 2.0, Cf.shape), 0, 255).astype(np.uint8)
P = P + rng.normal(0, 1, P.shape) * (0.0012 + 0.00008 * best)[:, None]             # range noise
# a few mixed-pixel / spray outliers
no = int(len(P) * 0.002); idx = rng.integers(0, len(P), no)
P = np.r_[P, P[idx] + rng.normal(0, 0.15, (no, 3))]; C = np.r_[C, np.clip(C[idx].astype(int) * 0.5 + np.array([[70, 95, 120]]), 0, 255).astype(np.uint8)]; owner = np.r_[owner, owner[idx]]; N = np.r_[N, N[idx]]
inten = np.clip(0.18 + 0.7 * C.mean(axis=1) / 255 + rng.normal(0, 0.03, len(P)), 0, 1)
print('points', len(P), 'per set-up', np.bincount(owner, minlength=len(S)))

# ================= WRITE FILES =================
OFF = np.array([335000.0, 7710000.0, 0.0])      # fictitious MGA2020 zone 50 position (NW Shelf); Z = metres above LAT
W = P + OFF
out = sys.argv[1] if len(sys.argv) > 1 else '.'
h = laspy.LasHeader(point_format=7, version='1.4'); h.offsets = np.floor(W.min(0)); h.scales = [0.0001] * 3
las = laspy.LasData(h); las.x, las.y, las.z = W[:, 0], W[:, 1], W[:, 2]
las.red, las.green, las.blue = (C[:, 0].astype(np.uint16) * 257), (C[:, 1].astype(np.uint16) * 257), (C[:, 2].astype(np.uint16) * 257)
las.intensity = (inten * 65535).astype(np.uint16); las.point_source_id = (owner + 1).astype(np.uint16)
las.write(f'{out}/offshore_platform.laz')
# E57: one scan per set-up, points in scanner coordinates, pose = rotation about Z + translation (like a registered TLS export)
imf = l.ImageFile(f'{out}/offshore_platform.e57', 'w'); root = imf.root()
root.set('formatName', l.StringNode(imf, 'ASTM E57 3D Imaging Data File')); root.set('guid', l.StringNode(imf, '{scanbench-offshore-sample}'))
root.set('versionMajor', l.IntegerNode(imf, 1)); root.set('versionMinor', l.IntegerNode(imf, 0))
d3 = l.VectorNode(imf, True); root.set('data3D', d3)
for k, s in enumerate(S):
    m = owner == k
    if not m.any(): continue
    yaw = rng.uniform(-math.pi, math.pi); cz, sz = math.cos(yaw), math.sin(yaw); Rm = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    T = s + OFF; loc = (W[m] - T) @ Rm            # world = R @ loc + T
    sc_ = l.StructureNode(imf); d3.append(sc_)
    sc_.set('guid', l.StringNode(imf, '{setup-%02d}' % (k + 1))); sc_.set('name', l.StringNode(imf, 'Setup %d' % (k + 1)))
    pose = l.StructureNode(imf); sc_.set('pose', pose); rot = l.StructureNode(imf); pose.set('rotation', rot); tr = l.StructureNode(imf); pose.set('translation', tr)
    for kk, vv in zip('wxyz', (math.cos(yaw / 2), 0.0, 0.0, math.sin(yaw / 2))): rot.set(kk, l.FloatNode(imf, float(vv)))
    for kk, vv in zip('xyz', T): tr.set(kk, l.FloatNode(imf, float(vv)))
    il = l.StructureNode(imf); sc_.set('intensityLimits', il); il.set('intensityMinimum', l.IntegerNode(imf, 0)); il.set('intensityMaximum', l.IntegerNode(imf, 2047))
    cl = l.StructureNode(imf); sc_.set('colorLimits', cl)
    for cc in ('Red', 'Green', 'Blue'): cl.set('color%sMinimum' % cc, l.IntegerNode(imf, 0)); cl.set('color%sMaximum' % cc, l.IntegerNode(imf, 255))
    proto = l.StructureNode(imf)
    for kk in ('cartesianX', 'cartesianY', 'cartesianZ'): proto.set(kk, l.ScaledIntegerNode(imf, 0, -400000, 400000, 0.0001, 0.0))
    proto.set('intensity', l.IntegerNode(imf, 0, 0, 2047))
    for cc in ('colorRed', 'colorGreen', 'colorBlue'): proto.set(cc, l.IntegerNode(imf, 0, 0, 255))
    cv = l.CompressedVectorNode(imf, proto, l.VectorNode(imf, True)); sc_.set('points', cv)
    n = int(m.sum()); X = np.ascontiguousarray(loc[:, 0]); Y = np.ascontiguousarray(loc[:, 1]); Z = np.ascontiguousarray(loc[:, 2])
    # note: pye57 mis-strides int64 integer buffers (every 2nd value reads 0) -> use uint16
    I = np.ascontiguousarray((inten[m] * 2047).astype(np.uint16)); Rr, Gg, Bb = (np.ascontiguousarray(C[m, j].astype(np.uint16)) for j in range(3))
    vb = l.VectorSourceDestBuffer()
    for nm_, arr, sc2 in (('cartesianX', X, True), ('cartesianY', Y, True), ('cartesianZ', Z, True), ('intensity', I, False), ('colorRed', Rr, False), ('colorGreen', Gg, False), ('colorBlue', Bb, False)):
        vb.append(l.SourceDestBuffer(imf, nm_, arr, n, True, sc2) if sc2 else l.SourceDestBuffer(imf, nm_, arr, n, True))
    w_ = cv.writer(vb); w_.write(n); w_.close()
imf.close()
# truth CSV in the same coordinates
with open(f'{out}/offshore_platform_truth.csv', 'w', newline='') as f:
    wr = csv.writer(f); wr.writerow(['Type', 'Name', 'Size', 'Start E', 'Start N', 'Start Z', 'End E', 'End N', 'End Z', 'Note'])
    for r in TRUTH:
        r = list(r)
        for j, o in ((3, 0), (4, 1), (5, 2), (6, 0), (7, 1), (8, 2)):
            if j < len(r) and r[j] != '' and isinstance(r[j], (int, float, np.floating)): r[j] = f'{float(r[j]) + OFF[o]:.3f}' if j not in (6, 7, 8) or r[0] not in ('valve',) else f'{float(r[j]):.3f}'
        wr.writerow(r)
print('truth rows', len(TRUTH))
