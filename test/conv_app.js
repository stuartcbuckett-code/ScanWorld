// In-app converter: dialog renders, a conversion runs inside ScanBench, and the result opens and streams.
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), os = require('os');
const files = process.argv.slice(2); let fails = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'capp-')); const ctx = await chromium.launchPersistentContext(prof, { headless: true, viewport: { width: 1300, height: 820 }, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', e => errs.push(e.message));
  await pg.goto('http://127.0.0.1:8777/index.html?project=none'); await pg.waitForFunction(() => window.__sb && document.querySelector('#lodSec'), null, { timeout: 120000 });
  await pg.click('#lodSec button:has-text("Convert scans")'); await pg.waitForSelector('.conv-ov .conv-step'); const steps = await pg.$$eval('.conv-ov .conv-step', n => n.length);
  ok(steps === 3, 'converter dialog shows its ' + steps + ' steps'); await pg.screenshot({ path: process.env.SHOT || '/tmp/conv_dialog.png' }); await pg.click('.conv-ov button[aria-label="Close"]');
  await pg.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.multiple = true; i.id = 't'; document.body.append(i); }); await pg.setInputFiles('#t', files);
  const r = await pg.evaluate(async () => { const root = await navigator.storage.getDirectory(); try { await root.removeEntry('p', { recursive: true }); } catch (e) { } const out = await root.getDirectoryHandle('p', { create: true });
    const ds = await SBConv.run({ files: [...document.getElementById('t').files], out, name: 'In-app test' }); await __sb.lodOpenStore(new __sb.LDirStore(out)); return ds.points; });
  await pg.waitForFunction(() => __sb.lodDatasets().length && __sb.lodDatasets()[0].loaded.size > 2 && !__sb.LP.pending, null, { timeout: 300000 });
  const st = await pg.evaluate(() => ({ name: __sb.lodDatasets()[0].meta.name, tiles: __sb.lodDatasets()[0].loaded.size, shown: __sb.LP.shown }));
  ok(st.tiles > 2, `converted ${r} points in the page and opened "${st.name}": ${st.tiles} tiles, ${st.shown} points shown`);
  ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : '')); await ctx.close(); fs.rmSync(prof, { recursive: true, force: true }); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
