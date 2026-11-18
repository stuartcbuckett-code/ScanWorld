"""A synthetic park scan for testing CAD linework: sealed road with kerbs, footpath, unsealed track, a bank, trees, a building, a pond.
Coordinates in MGA2020 zone 50 near Kalamunda; heights AHD-like. Writes a LAS 1.4 file with RGB."""
import sys, numpy as np, laspy
out = sys.argv[1]; rng = np.random.default_rng(11)
E0, N0, Z0 = 405200.0, 6463300.0, 280.0; W, H = 90.0, 70.0; sp = 0.07
gx, gy = np.meshgrid(np.arange(0, W, sp), np.arange(0, H, sp)); x = gx.ravel() + rng.uniform(-sp / 2, sp / 2, gx.size); y = gy.ravel() + rng.uniform(-sp / 2, sp / 2, gx.size)
def ground_z(x, y):
    z = 0.02 * x + 0.01 * y
    bank = np.clip((y - 50) / 4, 0, 1) * 2.0   # a 2 m bank between y = 50 and 54 (top at y = 54)
    return z + bank
z = ground_z(x, y); col = np.zeros((x.size, 3)); cls = np.full(x.size, 2, np.uint8)
grass = np.array([90, 140, 60]); col[:] = grass + rng.normal(0, 12, (x.size, 3))
# sealed road along x, centre y = 20, 7 m wide; kerbs 0.3 m wide, 0.15 m high, then 0.15 m up for the verge
road = np.abs(y - 20) < 3.5; kerb = (np.abs(y - 20) >= 3.5) & (np.abs(y - 20) < 3.8); verge = np.abs(y - 20) >= 3.8
z = np.where(road, z - 0.15, z); col[road] = np.array([60, 60, 62]) + rng.normal(0, 6, (road.sum(), 3)); col[kerb] = np.array([175, 175, 170]) + rng.normal(0, 6, (kerb.sum(), 3))
# footpath, concrete, 1.5 m wide, centre y = 28
path = np.abs(y - 28) < 0.75; col[path] = np.array([190, 188, 182]) + rng.normal(0, 6, (path.sum(), 3))
# unsealed track (red gravel), 3 m wide, gentle curve from (10, 35) to (85, 44)
tc = 35 + (x - 10) / 75 * 9 + 2 * np.sin(x / 12); track = (np.abs(y - tc) < 1.5) & (x > 8) & (x < 87) & ~road & ~path; col[track] = np.array([170, 95, 55]) + rng.normal(0, 8, (track.sum(), 3))
# pond: a 6 m circle at (70, 60), level water
pond = (x - 70) ** 2 + (y - 61) ** 2 < 36; z = np.where(pond, ground_z(70, 57) - 0.3, z); col[pond] = np.array([40, 70, 110]) + rng.normal(0, 5, (pond.sum(), 3)); cls[pond] = 9
P = [np.c_[x, y, z]]; C = [col]; K = [cls]
# building 12 x 8 m at (40..52, 5..13), walls 3 m, flat roof, red
bx0, bx1, by0, by1, bh = 40, 52, 6, 13, 3.0
inb = (x > bx0) & (x < bx1) & (y > by0) & (y < by1); keep = ~inb; P = [P[0][keep]]; C = [C[0][keep]]; K = [K[0][keep]]
gz = ground_z((bx0 + bx1) / 2, (by0 + by1) / 2)
rx, ry = np.meshgrid(np.arange(bx0, bx1, 0.1), np.arange(by0, by1, 0.1)); P.append(np.c_[rx.ravel(), ry.ravel(), np.full(rx.size, gz + bh)]); C.append(np.tile([180, 60, 50], (rx.size, 1)) + rng.normal(0, 6, (rx.size, 3))); K.append(np.full(rx.size, 6, np.uint8))
for (a, b) in [((bx0, by0), (bx1, by0)), ((bx1, by0), (bx1, by1)), ((bx1, by1), (bx0, by1)), ((bx0, by1), (bx0, by0))]:
    L = np.hypot(b[0] - a[0], b[1] - a[1]); t, h = np.meshgrid(np.linspace(0, 1, int(L / 0.1)), np.arange(0, bh, 0.1)); wx = a[0] + (b[0] - a[0]) * t.ravel(); wy = a[1] + (b[1] - a[1]) * t.ravel()
    P.append(np.c_[wx, wy, gz + h.ravel()]); C.append(np.tile([200, 190, 170], (wx.size, 1))); K.append(np.full(wx.size, 6, np.uint8))
# trees: trunk + canopy
for (tx, ty, th, cr) in [(12, 45, 9, 3), (25, 47, 11, 3.5), (60, 32, 8, 2.8), (78, 30, 12, 4), (15, 10, 7, 2.5), (30, 62, 10, 3.2), (85, 12, 9, 3)]:
    g0 = ground_z(tx, ty); m = 2500; a = rng.uniform(0, 2 * np.pi, m); hh = rng.uniform(0, th * 0.55, m)
    P.append(np.c_[tx + 0.2 * np.cos(a), ty + 0.2 * np.sin(a), g0 + hh]); C.append(np.tile([100, 80, 60], (m, 1))); K.append(np.full(m, 1, np.uint8))
    m = int(cr * cr * 1500); u = rng.normal(size=(m, 3)); u /= np.linalg.norm(u, axis=1)[:, None]; r = cr * rng.uniform(0.85, 1.0, m)[:, None]
    c = u * r * np.array([1, 1, 0.8]) + np.array([tx, ty, g0 + th - cr * 0.8]); P.append(c); C.append(np.array([50, 110, 40]) + rng.normal(0, 15, (m, 3))); K.append(np.full(m, 1, np.uint8))
# a light pole
g0 = ground_z(55, 25); hh = rng.uniform(0, 8, 3000); a = rng.uniform(0, 2 * np.pi, 3000); P.append(np.c_[55 + 0.1 * np.cos(a), 25 + 0.1 * np.sin(a), g0 + hh]); C.append(np.tile([150, 150, 150], (3000, 1))); K.append(np.full(3000, 1, np.uint8))
P = np.vstack(P); C = np.clip(np.vstack(C), 0, 255).astype(np.uint16) * 256; K = np.concatenate(K)
P[:, 2] += rng.normal(0, 0.006, len(P))
hdr = laspy.LasHeader(point_format=7, version='1.4'); hdr.scales = [0.001] * 3; hdr.offsets = [E0, N0, Z0]
las = laspy.LasData(hdr); las.x = P[:, 0] + E0; las.y = P[:, 1] + N0; las.z = P[:, 2] + Z0; las.red, las.green, las.blue = C[:, 0], C[:, 1], C[:, 2]; las.classification = K
las.write(out); print(len(P), 'points')
