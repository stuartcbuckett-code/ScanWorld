// Browser converter test: converts files with SBConv in headless Chrome (output into browser storage),
// copies the result to disk for scanlod verify / comparison. usage: node test/conv_browser.js <out dir> <files...>
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), os = require('os');
const [outDir, ...inputs] = process.argv.slice(2);
(async () => {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-')); const ctx = await chromium.launchPersistentContext(prof, { headless: true });
  const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', e => errs.push(e.message)); pg.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await pg.goto(process.env.CONV_URL || 'http://127.0.0.1:8777/ScanLOD-Converter.html');
  await pg.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.multiple = true; i.id = 't'; document.body.append(i); });
  await pg.setInputFiles('#t', inputs);
  const t0 = Date.now();
  const r = await pg.evaluate(async () => {
    const root = await navigator.storage.getDirectory(); try { await root.removeEntry('out', { recursive: true }); } catch (e) { }
    const out = await root.getDirectoryHandle('out', { create: true }); const logs = [];
    const viewer = async () => { const b = Uint8Array.from(atob(window.SB_VIEWER_GZ), c => c.charCodeAt(0)); return await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).text(); };
    const ds = await SBConv.run({ files: [...document.getElementById('t').files], out, viewer, memoryGB: 2, threads: 4, onLog: s => logs.push(s), onProgress: () => {} });
    const names = []; for await (const [n, e] of out.entries()) names.push(n + (e.kind === 'directory' ? '/' : ''));
    return { points: ds.points, nodes: ds.nodes, depth: ds.depth, bytes: ds.octree.bytes, logs, names, attrs: ds.attributes.map(a => a.name) };
  });
  console.log(r.logs.join('\n')); console.log('files:', r.names.join(' '), '| attributes:', r.attrs.join(','), '|', (Date.now() - t0) / 1000, 's');
  fs.mkdirSync(outDir, { recursive: true });
  for (const n of ['dataset.json', 'project.json', 'hierarchy.bin', 'octree.bin', 'ScanBench.html']) {
    const size = await pg.evaluate(async n => (await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('out')).getFileHandle(n)).getFile()).size, n);
    const fd = fs.openSync(path.join(outDir, n), 'w'); const step = 8e6;
    for (let o = 0; o < size; o += step) { const b64 = await pg.evaluate(async ([n, o, l]) => { const f = await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('out')).getFileHandle(n)).getFile(); const u = new Uint8Array(await f.slice(o, o + l).arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }, [n, o, step]); fs.writeSync(fd, Buffer.from(b64, 'base64')); }
    fs.closeSync(fd);
  }
  console.log(errs.length ? 'page errors: ' + errs.join(' | ') : 'no page errors'); await ctx.close(); fs.rmSync(prof, { recursive: true, force: true });
})().catch(e => { console.error(e); process.exit(1); });
