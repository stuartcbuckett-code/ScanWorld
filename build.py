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
ffl = read('node_modules', 'fflate', 'umd', 'index.js')
gtf = read('node_modules', 'geotiff', 'dist-browser', 'geotiff.js')
conv = read('src', 'conv.js') + '\n' + read('src', 'conv_ui.js')
app = read('src', 'app.js')
ext = '\n'.join(read('src', f) for f in ['app_ext.js', 'app_cad.js', 'app_review.js', 'app_lod.js', 'app_more.js', 'app_stream.js', 'app_globe.js', 'app_veg.js', 'app_tiles.js', 'app_pano.js', 'app_ortho.js', 'app_lodedit.js'])
marker = '// ---------- boot ----------'
assert marker in app
app = app.replace(marker, ext + '\n' + marker)
# handles used by the browser tests
hook = "window.__sb = { S,"
assert hook in app
app = app.replace(hook, "poolReady(); window.__sb = { S, PANO, ORTHO, LP, edTargetD, edUndo, edSave, edCount, lassoSetClass, applyLasso: (a) => applyLasso(a), groundClassify: () => groundClassify(), noiseFilter: () => noiseFilter(), classifyTerrain: (L) => classifyTerrain(L), transformLayer: (...a) => transformLayer(...a), lodExport: (...a) => lodExport(...a), lodReadBox: (...a) => lodReadBox(...a), importPanos, panoOpen, panoClose, loadFiles: (f) => loadFiles(f), fitAll, POOL, parC2C, buildCad, buildTopo, buildCoords, convertAll, fitAtPoint, cadSelect, cadTransform, cadDelete, cadUndo, fit2Pair, buildReview, buildLOD, LODS, addAnnotation, addBookmark, lineOfSight, viewshed, slopeAspect, stockpileVolume, planeDip, dsmChange, saveProject, loadProjectObj, loadWeirSample, wireClearance, exportSHP, parseDXF, addOverlay, importDataset, openDataset, updateCamera, curCam, setView, LP, lodOpenStore, lodOpenUrl, lodDatasets, lodExport, lodReadBox, lodSaveProject, lodProjectJSON, lodAddModel, lodPlaceModel, boxFromWorld, boxWorld, boxDrawMode, LHttpStore, LFileStore, LDirStore, openConverter, buildLodPanel, lodClose, lodCloseProject, lodSaveAll, setActive, exportDataset, extractToLayer, readBox, compareToCad, classifyByCad, classifyTerrain, findPeople, removePeople, playPath, batchScanToCad, addGroup, applyVisibility, extractTyped, goView, DS, STR, GLB, globeFly, globeGeo,")
for name, src in [('gtf', gtf), ('ffl', ffl), ('conv', conv), ('laz', laz), ('io', io), ('al', al), ('cad', cad), ('topo', topo), ('crs', crs), ('app', app), ('dl', dl)]:
    assert '</script' not in src.lower(), name

def page(three_src, binary_samples):
    out = shell + '\n<script src="' + three_src + '"></script>\n'
    if binary_samples: out += '<script>window.SB_BINARY_SAMPLES = true;</script>\n'
    out += '<script>window.SB_HOME=/*SB_HOME*/null;</script>\n'
    out += '<script id="src-laz">\n' + laz + '\nwindow.createLazPerf = createLazPerf;\n</script>\n'
    out += '<script>window.LAZ_WASM_B64="' + wasm + '";</script>\n'
    out += '<script>window.WORLD_TOPO=' + read('src', 'land-50m.json') + ';</script>\n'
    out += '<script id="src-io">\n' + io + '\n</script>\n'
    out += '<script id="src-fflate">\n' + ffl + '\n</script>\n'
    out += '<script>\n' + conv + '\n</script>\n'
    out += '<script>\n' + gtf + '\n</script>\n'
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
# one self-contained file with three.js inside, for offline use and for the scanlod viewer server
three = read('node_modules', 'three', 'build', 'three.min.js')
assert '</script' not in three.lower()
off = HEAD + page('', True).replace('<script src=""></script>', '<script>\n' + three + '\n</script>') + '</body></html>'
open(R('dist', 'ScanBench-offline.html'), 'w', encoding='utf-8').write(off)
print('dist/ScanBench-offline.html', len(off) // 1024, 'KB')
# stand-alone converter: one HTML file, works offline in Chrome or Edge
CONV_CSS = open(R('src', 'conv_page.css'), encoding='utf-8').read()
import gzip as _gz
VIEWER_GZ = base64.b64encode(_gz.compress(off.encode('utf-8'), 9)).decode()
cpage = ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
         '<title>ScanLOD Converter</title><meta name="description" content="Convert E57, LAS and LAZ scans of any size into a streaming ScanBench LOD project.">'
         '<style>' + CONV_CSS + '</style></head><body><main><h1>ScanLOD Converter</h1>'
         '<p class="lead">Turns E57, LAS and LAZ scans of any size into a ScanBench LOD project: tiles that the viewer streams, loading only what is in view. '
         'Everything runs on this computer; nothing is uploaded. Every point and attribute is kept, with all the source metadata.</p>'
         '<div id="app"></div><p class="foot">Open the result in <a href="https://stuartcbuckett-code.github.io/ScanWorld/" target="_blank" rel="noopener">ScanBench</a> (LOD projects → Open project folder…). '
         'The format is documented at <a href="https://github.com/stuartcbuckett-code/ScanWorld/blob/main/docs/lod-format.md" target="_blank" rel="noopener">docs/lod-format.md</a>.</p></main>'
         '<script id="src-laz">\n' + laz + '\nwindow.createLazPerf = createLazPerf;\n</script>\n<script>window.LAZ_WASM_B64="' + wasm + '";</script>\n'
         '<script id="src-io">\n' + io + '\n</script>\n<script id="src-fflate">\n' + ffl + '\n</script>\n<script>window.SB_VIEWER_GZ="' + VIEWER_GZ + '";</script>\n<script>\n' + conv + '\nconvUI(document.getElementById("app"), { viewerUrl: "https://stuartcbuckett-code.github.io/ScanWorld/", viewer: async () => { const b = Uint8Array.from(atob(window.SB_VIEWER_GZ), c => c.charCodeAt(0)); return await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream("gzip"))).text(); } });\n</script></body></html>')
open(R('dist', 'ScanLOD-Converter.html'), 'w', encoding='utf-8').write(cpage)
print('dist/ScanLOD-Converter.html', len(cpage) // 1024, 'KB')
# guard: every script block must parse (one stray quote silently breaks the whole app)
import subprocess
chk = "const fs=require('fs');const h=fs.readFileSync(process.argv[1],'utf8');let bad=0;for(const m of h.matchAll(/<script(?: [^>]*)?>([\\s\\S]*?)<\\/script>/g)){try{new Function(m[1])}catch(e){bad++;console.error('script syntax error: '+e.message)}}process.exit(bad?1:0)"
try:
    for f in ['ScanBench-offline.html', 'ScanLOD-Converter.html']:
        r = subprocess.run(['node', '-e', chk, R('dist', f)])
        if r.returncode: sys.exit('build stopped: a script block in ' + f + ' does not parse')
except FileNotFoundError:
    print('(node not found: skipped the script syntax check)')
if '--single' in sys.argv:
    open(R('dist', 'ScanBench.html'), 'w', encoding='utf-8').write(HEAD + page('https://cdn.jsdelivr.net/npm/three@0.155.0/build/three.min.js', False) + '</body></html>')
    print('dist/ScanBench.html written')
