"""Two scan stations in a painted room (points coloured by a pattern), one with an embedded spherical photo
(flip -1, offset 0.25 to test the orientation search), one with six pinhole photos (camera looks +z, y down)."""
import sys, io, uuid, numpy as np, pye57, pye57.libe57 as l
from PIL import Image
out = sys.argv[1]; n = int(sys.argv[2]) if len(sys.argv) > 2 else 300_000
BX, BY, BZ = 30.0, 20.0, 6.0
def pattern(P):   # colour by world position: 1 m checks, hue by wall
    c = (np.floor(P[:, 0]) + np.floor(P[:, 1]) + np.floor(P[:, 2])) % 2
    r = 60 + 150 * c + 40 * (P[:, 0] / BX); g = 60 + 120 * (P[:, 1] / BY) + 50 * c; b = 80 + 150 * (P[:, 2] / BZ) * (1 - c)
    return np.clip(np.c_[r, g, b], 0, 255).astype(np.uint8)
def raycast(o, D):   # rays from inside the box: nearest wall
    t = np.full(len(D), np.inf)
    for ax, lo, hi in [(0, 0, BX), (1, 0, BY), (2, 0, BZ)]:
        d = D[:, ax]
        with np.errstate(divide='ignore', invalid='ignore'):
            for pl in (lo, hi):
                tt = (pl - o[ax]) / d; tt[(tt <= 1e-9) | ~np.isfinite(tt)] = np.inf; t = np.minimum(t, tt)
    return o + D * t[:, None]
def quat(yaw): return np.array([np.cos(yaw / 2), 0, 0, np.sin(yaw / 2)])
def rot(yaw): c, s = np.cos(yaw), np.sin(yaw); return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])
rng = np.random.default_rng(3)
stations = [(np.array([8.0, 6.0, 1.6]), 0.7), (np.array([21.0, 13.0, 1.5]), -1.9)]
e = pye57.E57(out, mode='w'); imf = e.image_file; root = imf.root()
for s, (t, yaw) in enumerate(stations):
    # points: random directions from the station, hitting the walls (what a scanner sees)
    D = rng.normal(size=(n, 3)); D /= np.linalg.norm(D, axis=1)[:, None]; W = raycast(t, D); C = pattern(W)
    R = rot(yaw); L = (W - t) @ R
    e.write_scan_raw({'cartesianX': L[:, 0], 'cartesianY': L[:, 1], 'cartesianZ': L[:, 2], 'intensity': np.full(n, 0.5, np.float32), 'colorRed': C[:, 0], 'colorGreen': C[:, 1], 'colorBlue': C[:, 2]}, name=f'Station {s+1}', rotation=quat(yaw), translation=t)
if not root.isDefined('images2D'): root.set('images2D', l.VectorNode(imf, True))
im2 = root['images2D']; d3 = root['data3D']
def pose_node(q, t):
    p = l.StructureNode(imf); r = l.StructureNode(imf); tr = l.StructureNode(imf)
    for k, v in zip('wxyz', q): r.set(k, l.FloatNode(imf, float(v)))
    for k, v in zip('xyz', t): tr.set(k, l.FloatNode(imf, float(v)))
    p.set('rotation', r); p.set('translation', tr); return p
def add_image(name, scan_i, q, t, rep_name, w, h, jpg, extra):
    node = l.StructureNode(imf); node.set('guid', l.StringNode(imf, str(uuid.uuid4()))); node.set('name', l.StringNode(imf, name))
    node.set('associatedData3DGuid', l.StringNode(imf, d3[scan_i]['guid'].value())); node.set('pose', pose_node(q, t))
    rep = l.StructureNode(imf); blob = l.BlobNode(imf, len(jpg)); rep.set('jpegImage', blob)
    rep.set('imageWidth', l.IntegerNode(imf, w)); rep.set('imageHeight', l.IntegerNode(imf, h))
    for k, v in extra.items(): rep.set(k, l.FloatNode(imf, float(v)))
    node.set(rep_name, rep); im2.append(node); blob.write(np.frombuffer(jpg, np.uint8), 0, len(jpg))
def jpeg(a): b = io.BytesIO(); Image.fromarray(a).save(b, 'JPEG', quality=88); return b.getvalue()
# station 1: spherical photo, u = 0.5 + flip*az/2pi + off with flip=-1, off=0.25; rows from +90 deg (top)
t, yaw = stations[0]; w, h = 2048, 1024; flip, off = -1, 0.25
u = (np.arange(w) + 0.5) / w; v = (np.arange(h) + 0.5) / h; U, V = np.meshgrid(u, v)
az = (U - 0.5 - off) * 2 * np.pi / flip; el = (0.5 - V) * np.pi
Dl = np.stack([np.cos(el) * np.cos(az), np.cos(el) * np.sin(az), np.sin(el)], -1).reshape(-1, 3); Dw = Dl @ rot(yaw).T
add_image('Station 1 panorama', 0, quat(yaw), t, 'sphericalRepresentation', w, h, jpeg(pattern(raycast(t, Dw)).reshape(h, w, 3)), {'pixelWidth': 2 * np.pi / w, 'pixelHeight': np.pi / h})
# station 2: six pinhole photos (cube faces), camera frame: +z forward, +x right, +y down
t, yaw = stations[1]; S_ = 800; f_px = S_ / 2; pw = 5e-6
faces = {'front': (0, 0), 'right': (-np.pi / 2, 0), 'back': (np.pi, 0), 'left': (np.pi / 2, 0), 'up': (0, np.pi / 2), 'down': (0, -np.pi / 2)}
for nm, (a, b) in faces.items():
    # camera axes in world: forward, right, down
    fwd0 = np.array([np.cos(b) * np.cos(yaw + a), np.cos(b) * np.sin(yaw + a), np.sin(b)])
    up_hint = np.array([np.cos(yaw + a), np.sin(yaw + a), 0.0]) if abs(b) > 1 else np.array([0, 0, 1.0])
    if b > 1: up_hint = -up_hint
    right = np.cross(fwd0, up_hint); right /= np.linalg.norm(right); down = np.cross(fwd0, right)
    Rc = np.c_[right, down, fwd0]   # columns: camera x, y, z in world
    from scipy.spatial.transform import Rotation as Rot
    q = Rot.from_matrix(Rc).as_quat()  # x y z w
    xs = (np.arange(S_) + 0.5 - S_ / 2) / f_px; X, Y = np.meshgrid(xs, xs)
    Dc = np.stack([X, Y, np.ones_like(X)], -1).reshape(-1, 3); Dw = Dc @ Rc.T
    add_image('Station 2 ' + nm, 1, [q[3], q[0], q[1], q[2]], t, 'pinholeRepresentation', S_, S_, jpeg(pattern(raycast(t, Dw)).reshape(S_, S_, 3)),
              {'focalLength': f_px * pw, 'pixelWidth': pw, 'pixelHeight': pw, 'principalPointX': S_ / 2, 'principalPointY': S_ / 2})
e.close(); print('ok')
