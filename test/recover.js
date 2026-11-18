// Crash recovery: a layer with classes and an annotation come back after the page dies; LOD projects save themselves into their folder.
// usage: node test/recover.js <park.las> <scanlod> <LOD project copy>
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), path = require('path'), os = require('os');
const [las, bin, proj] = process.argv.slice(2); const sleep = ms => new Promise(r => setTimeout(r, ms)); let fails = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', '8981', '--directory', path.join(__dirname, '..', 'dist')], { stdio: 'ignore' }); await sleep(800);
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'rec-')), { headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  let pg = await ctx.newPage(); const errs = []; const watch = p => { p.on('pageerror', e => errs.push(e.message)); return p.route(/arcgisonline|fonts\.g/, r => r.abort()); }; await watch(pg);
  await pg.goto('http://127.0.0.1:8981/?nosample'); await sleep(1500);
  await pg.setInputFiles('#fileIn', las); for (let i = 0; i < 60 && !(await pg.evaluate(() => __sb.S.layers.length)); i++) await sleep(300);
  const before = await pg.evaluate(async () => { __sb.S.gCell = 1; __sb.S.gH = 0.25; __sb.S.gMaxW = 40; __sb.S.gSlope = 0.3; await __sb.groundClassify(); __sb.addAnnotationX(new THREE.Vector3(10, 10, 1), 'Valve', 'check this', ['test'], '#ff0'); const L = __sb.S.layers[0]; let g = 0; for (let i = 0; i < L.n; i++) g += L.cls[i] === 2; await __sb.recSnapshot('test'); return { n: L.n, g, annots: __sb.S.annots.length }; });
  console.log('      before the crash', JSON.stringify(before));
  console.log('      blob check', await pg.evaluate(() => new Promise(res => { const r = indexedDB.open('scanbench-recovery', 1); r.onsuccess = () => { const q = r.result.transaction('blobs').objectStore('blobs').getAll(); q.onsuccess = async () => { const b = q.result[0]; const buf = await b.arrayBuffer(); const L = __sb.S.layers[0]; const n = L.n; const off = n * 12 + (L.rgb ? n * 3 : 0) + (L.intensity ? n * L.intensity.BYTES_PER_ELEMENT : 0); const c = new Uint8Array(buf, off, n); let g = 0; for (const v of c) g += v === 2; res(JSON.stringify({ size: buf.byteLength, g, ib: L.intensity && L.intensity.constructor.name, rgb: L.rgb && L.rgb.constructor.name })); }; }; })));
  await pg.close({ runBeforeUnload: false });   // the page dies
  pg = await ctx.newPage(); await watch(pg); await pg.goto('http://127.0.0.1:8981/'); await sleep(2500);
  console.log('      stored:', await pg.evaluate(() => new Promise(res => { const r = indexedDB.open('scanbench-recovery', 1); r.onsuccess = () => { const q = r.result.transaction('meta').objectStore('meta').get('snap'); q.onsuccess = () => res(JSON.stringify(q.result ? { layers: q.result.layers.length, ann: q.result.state && q.result.state.annotations.length, lod: q.result.lod.length } : null)); q.onerror = () => res('err'); }; r.onerror = () => res('openerr'); })));
  const card = await pg.evaluate(() => { const c = document.querySelector('[aria-label="Restore your work"]'); return c ? c.innerText : null; });
  ok(!!card && /1 layer/.test(card) && /annotations/.test(card), 'on the next start it offers to restore: ' + (card || '').replace(/\s+/g, ' ').slice(0, 160));
  ok(await pg.evaluate(() => !__sb.S.layers.some(L => L.sample)), 'the start-up sample did not load over it');
  await pg.click('[aria-label="Restore your work"] >> text=Restore'); for (let i = 0; i < 60 && !(await pg.evaluate(() => __sb.S.layers.length)); i++) await sleep(300); await sleep(500);
  const after = await pg.evaluate(() => { const L = __sb.S.layers[0]; let g = 0; for (let i = 0; i < L.n; i++) g += L.cls[i] === 2; return { n: L.n, g, annots: __sb.S.annots.length, title: __sb.S.annots[0] && __sb.S.annots[0].title }; });
  ok(after.n === before.n && after.g === before.g && after.annots === 1 && after.title === 'Valve', 'restored the layer with its classes and the annotation ' + JSON.stringify(after));
  await pg.close();
  // LOD project: changes write themselves into the folder
  const port = 8982; const s2 = spawn(bin, ['view', proj, '--no-open', '--port', String(port)], { stdio: 'ignore' }); await sleep(800);
  pg = await ctx.newPage(); await watch(pg); await pg.goto(`http://127.0.0.1:${port}/?project=data/project.json`); await sleep(4000);
  await pg.evaluate(async () => { const D = __sb.lodDatasets()[0]; const c = D.box.getCenter(new THREE.Vector3()); __sb.addAnnotationX(c, 'Pump', 'autosave test', [], '#0ff'); __sb.S.gCell = 1; __sb.S.gH = 0.25; __sb.S.gMaxW = 40; __sb.S.gSlope = 0.3; await __sb.groundClassify(); await __sb.recAutosave(); });
  await sleep(500); const pj = JSON.parse(fs.readFileSync(path.join(proj, 'project.json'), 'utf8'));
  ok(pj.annotations.some(a => a.title === 'Pump') && fs.existsSync(path.join(proj, 'edits.bin')), 'LOD project saved itself: annotation in project.json and edits.bin written');
  ok(!errs.length, 'no page errors ' + errs.slice(0, 2).join(' | '));
  await ctx.close(); srv.kill(); s2.kill(); process.exit(fails ? 1 : 0);
})();
