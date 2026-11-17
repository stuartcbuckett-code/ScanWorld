// Navigation soak on a large LOD project: random views, checks the cache stays bounded and pages/tiles load.
// usage: node test/lod_soak.js <scanlod binary> <project folder> <out dir> [steps]
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const path = require('path');
const [bin, folder, outDir, stepsArg] = process.argv.slice(2); const steps = +(stepsArg || 30); const port = 8890 + Math.floor(Math.random() * 100);
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const srv = spawn(bin, ['view', folder, '--no-open', '--port', String(port)], { stdio: 'ignore' }); await sleep(800);
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-precise-memory-info'] });
  const pg = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage(); const errs = [];
  pg.on('pageerror', e => errs.push(e.message)); pg.on('response', r => { if (r.status() >= 400) errs.push('HTTP ' + r.status() + ' ' + r.url()); });
  await pg.goto(`http://127.0.0.1:${port}/?project=data/project.json`);
  await pg.waitForFunction(() => window.__sb && __sb.lodDatasets && __sb.lodDatasets().length && __sb.lodDatasets()[0].loaded.size > 2 && !__sb.LP.pending, null, { timeout: 180000 });
  await pg.evaluate(() => { __sb.LODS.budget = 1.5e6; __sb.LP.force = true; __sb.S.dirty = true; });
  const t0 = Date.now(); let maxCache = 0, maxHeap = 0, deep = 0, pages = 0;
  for (let i = 0; i < steps; i++) {
    await pg.evaluate(i => { const S = __sb.S, D = __sb.lodDatasets()[0], b = D.box; const r = (k => { let x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); });
      S.cam.target.set(b.min.x + r(1) * (b.max.x - b.min.x), b.min.y + r(2) * (b.max.y - b.min.y), b.min.z + (b.max.z - b.min.z) * 0.3); S.cam.dist = 8 + r(3) * (i % 5 === 0 ? 2000 : 150); S.cam.yaw = r(4) * 6.28; S.cam.pitch = 0.2 + r(5) * 1.2; __sb.updateCamera(); __sb.LP.force = true; S.dirty = true; }, i);
    await sleep(200); await pg.waitForFunction(() => { __sb.S.dirty = true; return !__sb.LP.pending; }, null, { timeout: 180000, polling: 300 });
    const st = await pg.evaluate(() => { const D = __sb.lodDatasets()[0]; let lv = 0; for (const [, N] of D.loaded) lv = Math.max(lv, N.node.level); let pg = 0; for (const [, N] of D.nodes) if (N.pageP) pg++; return { cache: D.cachedPts, heap: performance.memory ? performance.memory.usedJSHeapSize : 0, lv, pg, cap: Math.max(__sb.LODS.budget * __sb.LP.cacheX, 2e6), shown: __sb.LP.shown }; });
    maxCache = Math.max(maxCache, st.cache); maxHeap = Math.max(maxHeap, st.heap); deep = Math.max(deep, st.lv); pages = Math.max(pages, st.pg);
    if (i % 10 === 9) console.log(`step ${i + 1}: shown ${st.shown}, cached ${st.cache} (cap ${st.cap}), deepest level ${st.lv}, index pages ${st.pg}, JS heap ${(st.heap / 1e6).toFixed(0)} MB`);
  }
  await pg.screenshot({ path: path.join(outDir, 'soak.png') });
  const cap = await pg.evaluate(() => Math.max(__sb.LODS.budget * __sb.LP.cacheX, 2e6));
  console.log(`${steps} views in ${((Date.now() - t0) / 1000).toFixed(0)} s; peak cache ${maxCache} points (cap ${cap}); peak JS heap ${(maxHeap / 1e6).toFixed(0)} MB; deepest level ${deep}; index pages loaded ${pages}; errors ${errs.length}${errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''}`);
  const ok = maxCache <= cap * 1.15 && !errs.length && deep >= 6; console.log(ok ? 'soak passed' : 'soak FAILED');
  await b.close(); srv.kill(); process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
