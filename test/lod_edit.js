// Edit tools on a streamed LOD dataset: classify, set class by lasso, delete, undo, noise, shift; save edits; reload; export applies them.
// usage: node test/lod_edit.js <scanlod binary> <project folder (a copy: edits are written into it)> <out dir>
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), path = require('path');
const [bin, folder, outDir] = process.argv.slice(2); const port = 8840 + Math.floor(Math.random() * 100); const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
const lasClasses = f => { const b = fs.readFileSync(f), off = b.readUInt32LE(96), rl = b.readUInt16LE(105), n = Number(b.readBigUInt64LE(247)); const c = {}; for (let i = 0; i < n; i++) { const k = b[off + i * rl + 16]; c[k] = (c[k] || 0) + 1; } return { n, c, ox: b.readDoubleLE(155), oy: b.readDoubleLE(163) }; };
(async () => {
  const srv = spawn(bin, ['view', folder, '--no-open', '--port', String(port)], { stdio: 'ignore' }); await sleep(800);
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await b.newContext({ viewport: { width: 1400, height: 860 }, acceptDownloads: true });
  const open = async () => { const pg = await ctx.newPage(); pg.errs = []; pg.on('pageerror', e => pg.errs.push(e.message + ' ' + (e.stack || '').split('\n')[1])); await pg.route(/arcgisonline|fonts\.g/, r => r.abort()); await pg.goto(`http://127.0.0.1:${port}/?project=data/project.json`);
    for (let i = 0; i < 60 && !(await pg.evaluate(() => window.__sb && __sb.lodDatasets && __sb.lodDatasets().length && __sb.lodDatasets()[0].rootNode)); i++) await sleep(300); await sleep(1500); return pg; };
  const count = pg => pg.evaluate(async () => { const D = __sb.lodDatasets()[0]; const r = await __sb.lodReadBox(D, null, 4e7); const c = {}; for (let i = 0; i < r.n; i++) c[r.cls[i]] = (c[r.cls[i]] || 0) + 1; return { n: r.n, c }; });
  let pg = await open();
  const n0 = await count(pg); console.log('      start', JSON.stringify(n0));
  await pg.evaluate(() => [...document.querySelectorAll('.tab')].find(x => x.dataset.tab === 'edit').click()); await sleep(300);
  const pane = await pg.evaluate(() => { const p = document.getElementById('pane-edit'); const btn = t => { const b = [...p.querySelectorAll('button')].find(x => x.textContent === t); return b ? !b.disabled : null; }; return { title: /Editing/i.test(p.innerText), classify: btn('Classify'), noise: btn('Remove noise'), terrain: btn('Ground, trees, buildings, roads') }; });
  ok(pane.title && pane.classify && pane.noise && pane.terrain, 'Edit tab targets the streamed dataset, tools enabled ' + JSON.stringify(pane));
  // ground classification over the whole dataset
  await pg.evaluate(() => { __sb.S.gCell = 2; __sb.S.gH = 0.25; return __sb.groundClassify(); });
  const g = await count(pg); ok(g.n === n0.n && g.c[2] > 1000 && g.c[1] > 1000 && Object.keys(g.c).length === 2, 'ground classification on full-resolution blocks: ' + JSON.stringify(g.c));
  // lasso through the current view (a polygon in the middle of the screen), set class 6
  const setLasso = () => pg.evaluate(() => { const cam = __sb.curCam(); cam.updateMatrixWorld(); const M = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse); const r = document.getElementById('vp').getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    __sb.S.lasso = { pts: [[cx - 80, cy - 60], [cx + 80, cy - 60], [cx + 80, cy + 60], [cx - 80, cy + 60]], show: true, M: M.elements.slice(), rect: { l: r.left, t: r.top, w: r.width, h: r.height } }; });
  await setLasso(); await pg.evaluate(() => __sb.lassoSetClass(6));
  const l6 = await count(pg); ok(l6.c[6] > 100 && l6.n === n0.n, 'lasso → set class 6 (Building): ' + l6.c[6] + ' points');
  // delete inside the lasso, then undo
  await setLasso(); await pg.evaluate(() => __sb.applyLasso('delIn'));
  const del = await count(pg); ok(del.n === n0.n - l6.c[6] && !del.c[6], 'lasso → delete inside removed exactly those points (' + (n0.n - del.n) + ')');
  await pg.evaluate(() => __sb.edUndo(__sb.lodDatasets()[0])); const und = await count(pg); ok(und.n === n0.n && und.c[6] === l6.c[6], 'undo brings them back');
  // noise filter (deletes isolated points)
  await pg.evaluate(() => { __sb.S.noiseR = 0.3; __sb.S.noiseN = 6; return __sb.noiseFilter(); });
  const nz = await count(pg); ok(nz.n < und.n, 'noise filter removed ' + (und.n - nz.n) + ' isolated points');
  // the view still draws (tiles reload with edits)
  await pg.evaluate(() => { const D = __sb.lodDatasets()[0]; D.colorMode = 'class'; __sb.S.dirty = true; }); await sleep(2500); await pg.screenshot({ path: path.join(outDir, 'edit_classes.png') });
  // shift the dataset 10 m east
  const bx0 = await pg.evaluate(() => __sb.lodDatasets()[0].box.min.x); await pg.evaluate(() => __sb.transformLayer(10, 0, 0, 0, 1));
  const bx1 = await pg.evaluate(() => __sb.lodDatasets()[0].box.min.x); ok(Math.abs(bx1 - bx0 - 10) < 1e-6, 'shift moved the dataset 10 m east');
  // save: edits.bin + edits.json + the shift in project.json
  await pg.evaluate(() => __sb.lodSaveAll()); await sleep(800);
  ok(fs.existsSync(path.join(folder, 'edits.bin')) && fs.existsSync(path.join(folder, 'edits.json')), 'edits.bin and edits.json written next to dataset.json (' + fs.statSync(path.join(folder, 'edits.bin')).size + ' bytes)');
  const pj = JSON.parse(fs.readFileSync(path.join(folder, 'project.json'), 'utf8')); ok(pj.datasets[0].shift && pj.datasets[0].shift[0] === 10, 'project.json keeps the shift');
  ok(!pg.errs.length, 'no page errors ' + pg.errs.slice(0, 2).join(' | ')); await pg.close();
  // reload: edits applied from the files
  pg = await open(); const re = await count(pg); ok(re.n === nz.n && re.c[6] === nz.c[6] && re.c[2] === nz.c[2], 'reopened: the saved edits are applied (' + re.n + ' points, classes ' + JSON.stringify(re.c) + ')');
  ok(await pg.evaluate(() => Math.abs(__sb.lodDatasets()[0].box.min.x - 10 - (__sb.lodDatasets()[0].meta.bounds.min[0] - __sb.S.origin[0])) < 1e-6), 'reopened: the shift is applied');
  // export: the LAS has the edited classes, without the deleted points, at the shifted position
  await pg.evaluate(() => { delete window.showSaveFilePicker; });
  const [dl] = await Promise.all([pg.waitForEvent('download', { timeout: 120000 }), pg.evaluate(() => __sb.lodExport(__sb.lodDatasets()[0], {}))]);
  const lp = path.join(outDir, 'edited.las'); await dl.saveAs(lp); const L = lasClasses(lp);
  const of = await pg.evaluate(() => __sb.lodDatasets()[0].meta.offset[0]); const raw = JSON.parse(fs.readFileSync(path.join(folder, 'dataset.json'), 'utf8')).offset[0];
  ok(L.n === re.n && L.c[6] === re.c[6] && L.c[2] === re.c[2], 'exported LAS: ' + L.n + ' points, classes ' + JSON.stringify(L.c));
  ok(Math.abs(L.ox - raw - 10) < 1e-6 && Math.abs(of - raw - 10) < 1e-6, 'exported LAS offset includes the 10 m shift');
  ok(!pg.errs.length, 'no page errors ' + pg.errs.slice(0, 2).join(' | '));
  await b.close(); srv.kill(); console.log(fails ? fails + ' FAILED' : 'all passed'); process.exit(fails ? 1 : 0);
})();
