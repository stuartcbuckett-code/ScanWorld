#!/usr/bin/env python3
"""Build ScanBench into a static site.

  python3 build.py            -> dist/index.html + dist/vendor + dist/samples   (GitHub Pages, any web server, or open from disk)
  python3 build.py --single   -> also dist/ScanBench.html, one self-contained file (three.js from the CDN)

Needs `npm ci` first (laz-perf, delaunator, three).
"""
import base64, os, shutil, sys
root = os.path.dirname(os.path.abspath(__file__))
R = lambda *p: os.path.join(root, *p)
read = lambda *p: open(R(*p), encoding='utf-8').read()

shell = read('src', 'shell.html')
laz = read('node_modules', 'laz-perf', 'lib', 'web', 'laz-perf.js')
wasm = base64.b64encode(open(R('node_modules', 'laz-perf', 'lib', 'web', 'laz-perf.wasm'), 'rb').read()).decode()
dl = read('node_modules', 'delaunator', 'delaunator.min.js')
io, al, cad, topo, crs = (read('src', f) for f in ['io.js', 'algo.js', 'cad.js', 'topo.js', 'crs.js'])
app = read('src', 'app.js')
ext = '\n'.join(read('src', f) for f in ['app_ext.js', 'app_cad.js', 'app_review.js', 'app_lod.js', 'app_more.js', 'app_stream.js', 'app_globe.js'])
marker = '// ---------- boot ----------'
assert marker in app
app = app.replace(marker, ext + '\n' + marker)
# handles used by the browser tests
hook = "window.__sb = { S,"
assert hook in app
app = app.replace(hook, "poolReady(); window.__sb = { S, POOL, parC2C, buildCad, buildTopo, buildCoords, convertAll, fitAtPoint, cadSelect, cadTransform, cadDelete, cadUndo, fit2Pair, buildReview, buildLOD, LODS, addAnnotation, addBookmark, lineOfSight, viewshed, slopeAspect, stockpileVolume, planeDip, dsmChange, saveProject, loadProjectObj, loadWeirSample, wireClearance, exportSHP, parseDXF, addOverlay, importDataset, openDataset, exportDataset, extractToLayer, readBox, compareToCad, classifyByCad, classifyTerrain, findPeople, removePeople, playPath, batchScanToCad, addGroup, applyVisibility, extractTyped, goView, DS, STR, GLB, globeFly, globeGeo,")
for name, src in [('laz', laz), ('io', io), ('al', al), ('cad', cad), ('topo', topo), ('crs', crs), ('app', app), ('dl', dl)]:
    assert '</script' not in src.lower(), name

def page(three_src, binary_samples):
    out = shell + '\n<script src="' + three_src + '"></script>\n'
    if binary_samples: out += '<script>window.SB_BINARY_SAMPLES = true;</script>\n'
    out += '<script>\n' + laz + '\nwindow.createLazPerf = createLazPerf;\n</script>\n'
    out += '<script>window.LAZ_WASM_B64="' + wasm + '";</script>\n'
    out += '<script>window.WORLD_TOPO=' + read('src', 'land-50m.json') + ';</script>\n'
    out += '<script>\n' + io + '\n</script>\n'
    for src in [dl, al, cad, topo, crs]: out += '<script data-lib>\n' + src + '\n</script>\n'
    out += '<script>\n' + app + '\n</script>\n'
    return out

HEAD = ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
        '<title>ScanBench</title><meta name="description" content="Point cloud workbench: view, edit, Scan to CAD, topo, coordinates.">'
        '<style>:root{color-scheme:light}html,body{height:100%}body{margin:0;font:14px system-ui}[hidden]{display:none!important}</style></head><body>')
dist = R('dist'); os.makedirs(R('dist', 'vendor'), exist_ok=True)
shutil.copy(R('node_modules', 'three', 'build', 'three.min.js'), R('dist', 'vendor', 'three.min.js'))
open(R('dist', 'index.html'), 'w', encoding='utf-8').write(HEAD + page('vendor/three.min.js', True) + '</body></html>')
if os.path.isdir(R('samples')):
    shutil.rmtree(R('dist', 'samples'), ignore_errors=True); shutil.copytree(R('samples'), R('dist', 'samples'))
open(R('dist', '.nojekyll'), 'w').write('')
print('dist/index.html', os.path.getsize(R('dist', 'index.html')) // 1024, 'KB')
if '--single' in sys.argv:
    open(R('dist', 'ScanBench.html'), 'w', encoding='utf-8').write(HEAD + page('https://cdn.jsdelivr.net/npm/three@0.155.0/build/three.min.js', False) + '</body></html>')
    print('dist/ScanBench.html written')
