"""Synthetic large survey for converter testing: N tiles of M points (LAS 1.4 PF7, LAZ),
terrain + buildings + trees, flight-line ordered like a real capture."""
import sys, os, numpy as np, laspy
out = sys.argv[1]; tiles = int(sys.argv[2]); per = int(sys.argv[3]); os.makedirs(out, exist_ok=True)
E0, N0 = 390000.0, 6460000.0; T = 600.0
def terrain(x, y): return 40 + 12*np.sin(x/180) + 8*np.cos(y/140) + 3*np.sin((x+y)/37) + 0.6*np.sin(x/7.3)*np.cos(y/9.1)
for t in range(tiles):
    rng = np.random.default_rng(t)
    tx, ty = (t % 3) * T, (t // 3) * T
    hdr = laspy.LasHeader(point_format=7, version='1.4'); hdr.scales = [0.001]*3; hdr.offsets = [E0, N0, 0]
    try:
        from pyproj import CRS; hdr.add_crs(CRS.from_epsg(7850))
    except Exception: pass
    with laspy.open(os.path.join(out, f'tile_{t:02d}.laz'), mode='w', header=hdr, do_compress=True) as w:
        done = 0; B = 5_000_000
        while done < per:
            n = min(B, per - done)
            # flight strips 60 m wide, points ordered along strips
            u = np.sort(rng.random(n)) * T * (T / 60)
            strip = (u // T).astype(int); along = u % T
            x = tx + strip * 60 + rng.random(n) * 60
            y = ty + np.where(strip % 2 == 0, along, T - along)
            z = terrain(x, y)
            cls = np.full(n, 2, np.uint8)
            # buildings on a 50 m grid
            bx, by = np.mod(x, 50), np.mod(y, 50)
            bld = (bx > 10) & (bx < 32) & (by > 12) & (by < 30) & (((x // 50 + y // 50) % 3) == 0)
            z = np.where(bld, terrain(x - bx + 21, y - by + 21) + 7 + 0.15*np.minimum(np.abs(bx-21), 11), z); cls[bld] = 6
            # trees: 35% of the rest get canopy returns
            tr = (~bld) & (rng.random(n) < 0.35) & (np.sin(x/23)*np.cos(y/19) > 0.1)
            z = np.where(tr, z + rng.uniform(3, 18, n), z); cls[tr] = 5
            z += rng.normal(0, 0.01, n)
            p = laspy.ScaleAwarePointRecord.zeros(n, header=hdr)
            p.x = E0 + x; p.y = N0 + y; p.z = z
            p.intensity = np.where(cls == 2, rng.normal(9000, 800, n), np.where(cls == 6, rng.normal(16000, 1200, n), rng.normal(5000, 900, n))).clip(0, 65535).astype(np.uint16)
            p.classification = cls
            p.return_number = np.ones(n, np.uint8); p.number_of_returns = np.where(tr, 2, 1).astype(np.uint8)
            p.gps_time = 1e8 + t * 1e4 + (done + np.arange(n)) * 2e-6
            g = np.where(cls == 2, 120, np.where(cls == 6, 150, 90))
            p.red = (np.clip(g + rng.normal(0, 8, n) + (cls == 6) * 40, 0, 255) * 257).astype(np.uint16)
            p.green = (np.clip(g + rng.normal(0, 8, n) + (cls == 5) * 40, 0, 255) * 257).astype(np.uint16)
            p.blue = (np.clip(g * 0.8 + rng.normal(0, 8, n), 0, 255) * 257).astype(np.uint16)
            p.point_source_id = np.full(n, t + 1, np.uint16)
            w.write_points(p); done += n
    print('tile', t, flush=True)
