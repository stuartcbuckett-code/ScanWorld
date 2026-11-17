"""Three terrestrial scans of a room-sized scene, each in its own local frame with a pose."""
import sys, numpy as np, pye57
out = sys.argv[1]; n = int(sys.argv[2]) if len(sys.argv) > 2 else 2_000_000
e = pye57.E57(out, mode='w')
rng = np.random.default_rng(5)
for s, (tx, ty, yaw) in enumerate([(0, 0, 0.0), (12, 3, 1.2), (5, 14, -2.0)]):
    # scene in world: floor, 4 walls of a 30x20x6 box, a pipe
    k = rng.integers(0, 4, n); u = rng.random(n); v = rng.random(n)
    X = np.where(k == 0, u*30, np.where(k == 1, u*30, np.where(k == 2, 0, 30))); Y = np.where(k == 0, v*20, np.where(k == 1, 20*(u > 0.5), u*20)); Z = np.where(k == 0, 0, v*6)
    pipe = rng.random(n) < 0.1; a = rng.random(n)*2*np.pi
    X = np.where(pipe, u*30, X); Y = np.where(pipe, 10 + 0.3*np.cos(a), Y); Z = np.where(pipe, 3 + 0.3*np.sin(a), Z)
    W = np.c_[X, Y, Z] + rng.normal(0, 0.002, (n, 3))
    # world -> scan local: p_local = R^T (p - t)
    c, si = np.cos(yaw), np.sin(yaw); R = np.array([[c, -si, 0], [si, c, 0], [0, 0, 1]]); t = np.array([tx, ty, 1.5])
    L = (W - t) @ R
    q = [np.cos(yaw/2), 0, 0, np.sin(yaw/2)]
    d = {'cartesianX': L[:, 0], 'cartesianY': L[:, 1], 'cartesianZ': L[:, 2], 'intensity': rng.random(n).astype(np.float32),
         'colorRed': rng.integers(0, 256, n).astype(np.uint8), 'colorGreen': rng.integers(0, 256, n).astype(np.uint8), 'colorBlue': rng.integers(0, 256, n).astype(np.uint8)}
    e.write_scan_raw(d, name=f'Scan {s+1}', rotation=np.array(q), translation=t)
    np.save(out + f'.world{s}.npy', W[:2000])
e.close(); print('ok')
