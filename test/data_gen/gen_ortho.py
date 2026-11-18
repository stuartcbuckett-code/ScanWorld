"""A tiled GeoTIFF with overviews (MGA2020 zone 50, 0.1 m pixels) and a JPEG + world file, around the Mundaring Weir sample."""
import sys, numpy as np, tifffile
from PIL import Image
out = sys.argv[1]; E0, N0, px, S = 421300.0, 6464100.0, 0.1, 6000
y, x = np.mgrid[0:S, 0:S].astype(np.float32)
E = E0 + (x + 0.5) * px; N = N0 - (y + 0.5) * px
img = np.zeros((S, S, 3), np.uint8)
img[..., 0] = 90 + 80 * ((E - E0) / (S * px)); img[..., 1] = 110 + 60 * ((N0 - N) / (S * px)); img[..., 2] = 70
grid10 = ((E % 10) < 0.25) | ((N % 10) < 0.25); grid1 = ((E % 1) < 0.05) | ((N % 1) < 0.05)
img[grid1] = (200, 200, 200); img[grid10] = (255, 255, 255)
img[:40, :40] = 0   # a black corner (no data)
geokeys = [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 7850]
tags = [(33550, 'd', 3, (px, px, 0.0), False), (33922, 'd', 6, (0, 0, 0, E0, N0, 0), False), (34735, 'H', len(geokeys), geokeys, False)]
with tifffile.TiffWriter(out + '.tif', bigtiff=False) as t:
    t.write(img, tile=(256, 256), compression='zlib', photometric='rgb', extratags=tags)
    for k in (2, 4, 8, 16):
        t.write(img[::k, ::k], tile=(256, 256), compression='zlib', photometric='rgb', subfiletype=1)
s = img[::3, ::3]; Image.fromarray(s).save(out + '.jpg', quality=85)
open(out + '.jgw', 'w').write('\n'.join(map(str, [px * 3, 0, 0, -px * 3, E0 + px * 3 / 2, N0 - px * 3 / 2])) + '\n')
print('ok')
