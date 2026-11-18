// The folder viewer (ScanBench.html beside a project) opens its project by itself when the browser already allows the folder.
// The remembered folder here is an OPFS folder (always allowed), standing in for a folder the user allowed "on every visit".
// usage: node test/home_open.js <converted project folder>
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'), path = require('path'), os = require('os');
const [proj] = process.argv.slice(2); const port = 8960; const sleep = ms => new Promise(r => setTimeout(r, ms)); let fails = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(port), '--directory', path.join(__dirname, '..', 'dist')], { stdio: 'ignore' }); await sleep(800);
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'home-')), { headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  let pg = await ctx.newPage(); await pg.route(/arcgisonline|fonts\.g/, r => r.abort()); await pg.goto(`http://127.0.0.1:${port}/?nosample`); await sleep(800);
  for (const f of fs.readdirSync(proj).filter(f => !/\.html$/.test(f))) { const b64 = fs.readFileSync(path.join(proj, f)).toString('base64');
    await pg.evaluate(async ([f, b64]) => { const root = await navigator.storage.getDirectory(); const d = await root.getDirectoryHandle('proj', { create: true }); const w = await (await d.getFileHandle(f, { create: true })).createWritable(); await w.write(Uint8Array.from(atob(b64), c => c.charCodeAt(0))); await w.close(); }, [f, b64]); }
  await pg.evaluate(async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('proj'); await new Promise((res, rej) => { const r = indexedDB.open('scanbench-home', 1); r.onupgradeneeded = () => r.result.createObjectStore('h'); r.onsuccess = () => { const t = r.result.transaction('h', 'readwrite'); t.objectStore('h').put(d, 'proj:test-id'); t.oncomplete = res; t.onerror = rej; }; }); });
  await pg.close();
  pg = await ctx.newPage(); const errs = []; pg.on('pageerror', e => errs.push(e.message)); await pg.route(/arcgisonline|fonts\.g/, r => r.abort());
  await pg.addInitScript(() => { window.SB_DISKTEST = true; let v = { name: 'Weir', points: 1322019, created: 1763430000, id: 'test-id' }; Object.defineProperty(window, 'SB_HOME', { get: () => v, set: x => { if (x) v = x; } }); });
  await pg.goto(`http://127.0.0.1:${port}/`); let opened = false; for (let i = 0; i < 30 && !opened; i++) { await sleep(300); opened = await pg.evaluate(() => !!(window.__sb && __sb.lodDatasets && __sb.lodDatasets().length)); }
  const card = await pg.evaluate(() => !!document.querySelector('[aria-label="Open project"]'));
  ok(opened && !card, 'opened the project from its folder by itself, no button to press');
  const n = await pg.evaluate(() => __sb.lodDatasets()[0] && __sb.lodDatasets()[0].meta.points); ok(n > 0, 'dataset streaming: ' + n + ' points');
  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  await ctx.close(); srv.kill(); process.exit(fails ? 1 : 0);
})();
