// Two LOD projects open at once: annotations go to the active one, each saves its own, reopening restores both.
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), os = require('os');
let fails = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-')); const ctx = await chromium.launchPersistentContext(prof, { headless: true, viewport: { width: 1300, height: 820 }, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', e => errs.push(e.message));
  await pg.goto('http://127.0.0.1:8777/index.html?project=none'); await pg.waitForFunction(() => window.__sb && document.querySelector('#lodSec'), null, { timeout: 120000 });
  await pg.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.multiple = true; i.id = 't'; document.body.append(i); }); await pg.setInputFiles('#t', ['samples/weir_1.laz', 'samples/weir_3.laz']);
  await pg.evaluate(async () => { const root = await navigator.storage.getDirectory(); const fl = [...document.getElementById('t').files];
    for (const [i, nm] of ['A', 'B'].entries()) { try { await root.removeEntry(nm, { recursive: true }); } catch (e) { } const out = await root.getDirectoryHandle(nm, { create: true }); await SBConv.run({ files: [fl[i]], out, name: 'Project ' + nm }); } });
  const r = await pg.evaluate(async () => { const root = await navigator.storage.getDirectory(); const A = await root.getDirectoryHandle('A'), B = await root.getDirectoryHandle('B');
    await __sb.lodOpenStore(new __sb.LDirStore(A, 'A')); await __sb.lodOpenStore(new __sb.LDirStore(B, 'B'));
    const LP = __sb.LP; const [PA, PB] = LP.projects; const c = __sb.lodDatasets()[0].box.getCenter(new THREE.Vector3());
    __sb.addAnnotation(c.clone(), 'Note in B (active)', '', []); __sb.setActive(PA); __sb.addAnnotation(c.clone().addScalar(1), 'Note in A', '', []); __sb.addBookmark('View in A');
    await __sb.lodSaveAll(); const rd = async h => JSON.parse(await (await (await h.getFileHandle('project.json')).getFile()).text());
    const ja = await rd(A), jb = await rd(B); return { n: LP.projects.length, ds: __sb.lodDatasets().map(D => D.meta.name), a: ja.annotations.map(x => x.title), av: ja.views.length, b: jb.annotations.map(x => x.title), bv: jb.views.length, adat: ja.datasets.length, bdat: jb.datasets.length, dirty: LP.projects.map(P => P.dirty) }; });
  ok(r.n === 2 && r.ds.length === 2, 'two projects open: ' + r.ds.join(' + '));
  ok(r.a.length === 1 && r.a[0] === 'Note in A' && r.av === 1 && r.adat === 1, 'project A saved only its own items: ' + JSON.stringify(r.a) + ', ' + r.av + ' view');
  ok(r.b.length === 1 && r.b[0] === 'Note in B (active)' && r.bv === 0 && r.bdat === 1, 'project B saved only its own items: ' + JSON.stringify(r.b) + ', ' + r.bv + ' views');
  ok(r.dirty.every(d => !d), 'both marked saved');
  const c = await pg.evaluate(async () => { const LP = __sb.LP; await __sb.lodCloseProject(LP.projects[1]); const left = { n: LP.projects.length, annots: __sb.S.annots.map(a => a.title), ds: __sb.lodDatasets().length };
    const root = await navigator.storage.getDirectory(); await __sb.lodOpenStore(new __sb.LDirStore(await root.getDirectoryHandle('B'), 'B')); return Object.assign(left, { after: __sb.S.annots.map(a => a.title).sort(), n2: LP.projects.length }); });
  ok(c.n === 1 && c.ds === 1 && c.annots.length === 1 && c.annots[0] === 'Note in A', 'closing B removed only B and its note (left: ' + JSON.stringify(c.annots) + ')');
  ok(c.n2 === 2 && c.after.length === 2, 'reopening B brings its note back: ' + JSON.stringify(c.after));
  ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : '')); await pg.screenshot({ path: process.env.SHOT || '/tmp/mp.png' });
  await ctx.close(); fs.rmSync(prof, { recursive: true, force: true }); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
