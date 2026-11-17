// Browser test for LOD projects: open through `scanlod view`, stream, box read, export, annotate + save, STL model, reload.
// usage: node test/lod_browser.js <scanlod binary> <project folder> <out dir>
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), path = require('path');
const [bin, folder, outDir] = process.argv.slice(2); const port = 8790 + Math.floor(Math.random() * 100);
const sleep = ms => new Promise(r => setTimeout(r, ms)); let fails = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const srv = spawn(bin, ['view', folder, '--no-open', '--port', String(port)], { stdio: ['ignore', 'inherit', 'inherit'] }); await sleep(800);
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await b.newContext({ viewport: { width: 1400, height: 860 }, acceptDownloads: true }); const pg = await ctx.newPage(); const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERR ' + e.message)); pg.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|ERR_NAME|ERR_INTERNET|fonts\.g/.test(m.text())) errs.push('console ' + m.text()); }); pg.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) errs.push('HTTP ' + r.status() + ' ' + r.url()); });
  const t0 = Date.now(); pg.on('load', () => console.log('page loaded', Date.now() - t0, 'ms')); await pg.goto(`http://127.0.0.1:${port}/?project=data/project.json`);
  await pg.waitForFunction(() => window.__sb && __sb.lodDatasets && __sb.lodDatasets().length > 0, null, { timeout: 120000 }); console.log('dataset open', Date.now() - t0, 'ms');
  await pg.waitForFunction(() => __sb.lodDatasets().every(D => D.loaded.size > 3) && !__sb.LP.pending, null, { timeout: 120000 });
  const info = await pg.evaluate(() => { const D = __sb.lodDatasets()[0]; return { name: D.meta.name, pts: D.meta.points, tiles: D.loaded.size, shown: __sb.LP.shown, nodes: D.nodes.size, crs: __sb.S.crs }; });
  ok(info.tiles > 3, `opened ${info.name}: ${info.pts} points, ${info.tiles} tiles loaded, ${info.shown} shown, crs ${info.crs} (${Date.now() - t0} ms)`);
  await pg.screenshot({ path: path.join(outDir, 'lod1.png') });
  // zoom in: deeper tiles should load
  const before = await pg.evaluate(() => __sb.lodDatasets()[0].loaded.size);
  await pg.evaluate(() => { const S = __sb.S; S.cam.dist *= 0.15; __sb.updateCamera(); __sb.LP.force = true; S.dirty = true; });
  await sleep(300); await pg.waitForFunction(() => { __sb.S.dirty = true; return !__sb.LP.pending && __sb.LP.key; }, null, { timeout: 120000, polling: 500 }); await sleep(2500); await pg.waitForFunction(() => !__sb.LP.pending, null, { timeout: 120000 });
  const after = await pg.evaluate(() => { const D = __sb.lodDatasets()[0]; return { n: D.loaded.size, deep: Math.max(...[...D.loaded.values()].map(N => N.node.level)) }; });
  ok(after.n >= before, `zoomed in: ${after.n} tiles cached, deepest level ${after.deep}`);
  await pg.screenshot({ path: path.join(outDir, 'lod2.png') });
  // frame times while orbiting
  const ft = await pg.evaluate(async () => { const S = __sb.S, ts = []; let last = performance.now(); for (let i = 0; i < 40; i++) { S.cam.yaw += 0.03; __sb.updateCamera(); S.dirty = true; await new Promise(r => requestAnimationFrame(r)); const t = performance.now(); ts.push(t - last); last = t; } ts.sort((a, b) => a - b); return { med: ts[20], p95: ts[37] }; });
  const um = await pg.evaluate(() => __sb.LP.updMs); ok(um < 30, `orbit frame time median ${ft.med.toFixed(1)} ms, 95th ${ft.p95.toFixed(1)} ms (software GL); tile selection ${um.toFixed(2)} ms per frame`);
  // draw a box with the mouse, then drag its +E face
  await pg.evaluate(() => { const S = __sb.S; __sb.setView ? __sb.setView('top') : null; });
  await pg.click('#lodSec button:has-text("Draw box")');
  const cv = await pg.$('canvas'); const bb = await cv.boundingBox(); const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
  await pg.mouse.move(cx - 60, cy - 50); await pg.mouse.down(); await pg.mouse.move(cx, cy, { steps: 4 }); await pg.mouse.move(cx + 60, cy + 50, { steps: 4 }); await pg.mouse.up(); await sleep(400);
  const drawn = await pg.evaluate(() => ({ shown: __sb.LP.box.shown, w: __sb.boxWorld(), empty: __sb.S.clip.box.isEmpty() }));
  ok(drawn.shown && !drawn.empty, `drew a box with the mouse: E ${drawn.w.min[0].toFixed(1)}…${drawn.w.max[0].toFixed(1)}, Z ${drawn.w.min[2].toFixed(1)}…${drawn.w.max[2].toFixed(1)}`);
  await pg.evaluate(() => { __sb.S.dirty = true; }); await sleep(1500);
  const hp = await pg.evaluate(() => { const S = __sb.S, b = S.clip.box, c = b.getCenter(new THREE.Vector3()); c.x = b.max.x; const cam = __sb.curCam(); cam.updateMatrixWorld(); const p = c.clone().project(cam), r = document.querySelector('canvas').getBoundingClientRect(); return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height, max: b.max.x }; });
  await pg.mouse.move(hp.x, hp.y); await pg.mouse.down(); await pg.mouse.move(hp.x + 40, hp.y, { steps: 5 }); await pg.mouse.up(); await sleep(300);
  const moved = await pg.evaluate(() => __sb.S.clip.box.max.x); ok(Math.abs(moved - hp.max) > 0.5, `dragged the +E handle: max E moved by ${(moved - hp.max).toFixed(2)} m`);
  // box: centre 30 m, full height
  const box = await pg.evaluate(() => { const D = __sb.lodDatasets()[0], m = D.meta.bounds; const c = [(m.min[0] + m.max[0]) / 2, (m.min[1] + m.max[1]) / 2]; __sb.boxFromWorld({ min: [c[0] - 15, c[1] - 15, m.min[2]], max: [c[0] + 15, c[1] + 15, m.max[2]] }); return __sb.boxWorld(); });
  const rb = await pg.evaluate(async () => { const D = __sb.lodDatasets()[0]; const r = await __sb.lodReadBox(D, __sb.S.clip.box, 4e7); return r.n; });
  ok(rb > 0, `box read at full resolution: ${rb} points`); fs.writeFileSync(path.join(outDir, 'box.json'), JSON.stringify(box));
  // export the box (memory path, as in browsers without the file-system API)
  await pg.evaluate(() => { delete window.showSaveFilePicker; });
  const [dl] = await Promise.all([pg.waitForEvent('download', { timeout: 120000 }), pg.evaluate(() => __sb.lodExport(__sb.lodDatasets()[0], { box: __sb.S.clip.box }))]);
  const lasPath = path.join(outDir, 'browser_box.las'); await dl.saveAs(lasPath); ok(fs.statSync(lasPath).size > 375, `exported box LAS: ${fs.statSync(lasPath).size} bytes`);
  // annotation + STL model, save, reload
  const stl = fs.readFileSync(path.join(outDir, 'cube.stl'));
  await pg.evaluate(async b64 => { const S = __sb.S; const D = __sb.lodDatasets()[0]; const c = D.box.getCenter(new THREE.Vector3()); __sb.addAnnotation(c, 'Test note', 'from the browser test', ['test']); __sb.addBookmark('Test view');
    const bytes = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0)); const L = await __sb.lodAddModel(new File([bytes], 'cube.stl')); const o = S.origin; await __sb.lodPlaceModel(L, { offset: [c.x + o[0], c.y + o[1], c.z + o[2]], scale: 1 }); await __sb.lodSaveProject(); }, stl.toString('base64'));
  await sleep(500); const pj = JSON.parse(fs.readFileSync(path.join(folder, 'project.json'), 'utf8'));
  ok(pj.annotations.length === 1 && pj.views.length === 1 && pj.models.length === 1 && fs.existsSync(path.join(folder, 'models', 'cube.stl')), `project.json saved: ${pj.annotations.length} annotation, ${pj.views.length} view, ${pj.models.length} model (${pj.models[0] && pj.models[0].path})`);
  await pg.reload(); await pg.waitForFunction(() => window.__sb && __sb.lodDatasets && __sb.lodDatasets().length > 0 && __sb.S.annots.length > 0 && __sb.S.layers.some(L => L.model), null, { timeout: 60000 }); await sleep(300);
  const back = await pg.evaluate(() => ({ a: __sb.S.annots.length, v: __sb.S.bookmarks.length, m: __sb.S.layers.filter(L => L.model).length, dirty: __sb.LP.dirtyProject }));
  ok(back.a === 1 && back.v === 1 && back.m === 1 && !back.dirty, `reloaded: ${back.a} annotation, ${back.v} view, ${back.m} model, unsaved=${back.dirty}`);
  await pg.screenshot({ path: path.join(outDir, 'lod3.png') });
  ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.slice(0, 5).join(' | ') : ''));
  await b.close(); srv.kill(); console.log(fails ? fails + ' FAILED' : 'all passed'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
