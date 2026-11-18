// Topo → S551 CAD deliverable on a synthetic park: road with kerbs, footpath, track, bank, trees, building, pond.
// usage: node test/cad_s551.js <park.las> <out dir>
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const path = require('path'), fs = require('fs');
const [las, outDir] = process.argv.slice(2); const port = 8990 + Math.floor(Math.random() * 9); const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(port), '--directory', path.join(__dirname, '..', 'dist')], { stdio: 'ignore' }); await sleep(800);
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true }); const pg = await ctx.newPage(); pg.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('C', m.text().slice(0, 300)); }); const errs = []; pg.on('pageerror', e => errs.push(e.message + ' ' + (e.stack || '').split('\n')[1]));
  await pg.route(/arcgisonline|fonts\.g/, r => r.abort()); await pg.goto(`http://127.0.0.1:${port}/?nosample`); await sleep(1500);
  await pg.setInputFiles('#fileIn', las); for (let i = 0; i < 100 && !(await pg.evaluate(() => __sb.S.layers.length)); i++) await sleep(300);
  await pg.evaluate(() => { __sb.S.crs = 'MGA2020-50'; });
  const t0 = Date.now(); await pg.evaluate(() => __sb.runTopo(__sb.S.layers[0])); console.log('topo', ((Date.now() - t0) / 1000).toFixed(1), 's');
  const r = await pg.evaluate(() => { const F = __sb.cadFeatures(); const t = __sb.S.topo, sf = t.surfaces; return { counts: Object.fromEntries(Object.entries(F).map(([k, v]) => [k, v.length])), roads: sf.roads.map(x => ({ w: +x.width.toFixed(2), a: Math.round(x.area), e: x.edges.length, c: x.centre.length })), paths: sf.paths.map(x => ({ w: +x.width.toFixed(2), e: x.edges.length })), tracks: sf.tracks.map(x => ({ w: +x.width.toFixed(2), e: x.edges.length, c: x.centre.length })), kerbs: sf.kerbs.length, water: sf.water.length, map: __sb.CADO.map && Object.keys(__sb.CADO.map).length }; });
  console.log(JSON.stringify(r, null, 0));
  await pg.evaluate(() => [...document.querySelectorAll('.tab')].find(x => x.dataset.tab === 'topo').click()); await sleep(500); await pg.screenshot({ path: path.join(outDir, 'cad_topo.png') });
  const [dl] = await Promise.all([pg.waitForEvent('download', { timeout: 60000 }), pg.evaluate(() => __sb.cadExport('dxf'))]); const out = path.join(outDir, 'park_S551.dxf'); await dl.saveAs(out); console.log('dxf', fs.statSync(out).size, 'bytes');
  console.log('errors', errs);
  await b.close(); srv.kill();
})();
