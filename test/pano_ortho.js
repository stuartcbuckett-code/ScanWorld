// 360° views (E57 stations with embedded photos, imported 360° photos) and aerial images (GeoTIFF with overviews, JPEG + world file).
// usage: node test/pano_ortho.js <data dir with stations.e57, ortho.tif/.jpg/.jgw, pano_*.jpg, pano_pos.csv> <out dir>
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const path = require('path');
const [dataDir, outDir] = process.argv.slice(2); const port = 8930 + Math.floor(Math.random() * 50); const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(port), '--directory', path.join(__dirname, '..', 'dist')], { stdio: 'ignore' }); await sleep(800);
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = async () => { const pg = await b.newPage({ viewport: { width: 1400, height: 860 } }); pg.errs = []; pg.stacks = []; pg.on('pageerror', e => { pg.errs.push(e.message); pg.stacks.push(e.stack); }); await pg.route(/arcgisonline|fonts\.g/, r => r.abort()); await pg.goto(`http://127.0.0.1:${port}/?nosample`); await sleep(1500); return pg; };
  const wait = async (pg, fn, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pg.evaluate(fn)) return true; await sleep(300); } return false; };
  // ---- E57 stations ----
  let pg = await page();
  await pg.setInputFiles('#fileIn', path.join(dataDir, 'stations.e57'));
  ok(await wait(pg, () => __sb.PANO.list.length === 2), 'two scan stations found in the E57');
  const st = await pg.evaluate(() => __sb.PANO.list.map(s => ({ name: s.name, pos: s.pos.toArray().map(v => +v.toFixed(2)), photos: s.photos.length, show: s.show })));
  console.log('     ', JSON.stringify(st));
  const o = await pg.evaluate(() => __sb.S.origin);
  ok(Math.abs(st[0].pos[0] + o[0] - 8) < 0.01 && Math.abs(st[1].pos[1] + o[1] - 13) < 0.01, 'station positions match the scan poses');
  ok(st[0].photos === 1 && st[1].photos === 6, 'embedded photos linked to their scans (1 spherical, 6 pinhole)');
  await pg.evaluate(() => __sb.panoOpen(__sb.PANO.list[0])); await wait(pg, () => !!(__sb.PANO.active && __sb.PANO.active.tex.photo));
  const t1 = await pg.evaluate(() => { const t = __sb.PANO.list[0].tex.photo; return { flip: t.flip, off: t.off, cam: __sb.S.cam.dist }; });
  ok(t1.flip === -1 && t1.off === 0.25, 'spherical photo orientation found by matching the scan colours (flip ' + t1.flip + ', offset ' + t1.off + ')');
  ok(await pg.evaluate(() => !!document.getElementById('panoChip')), 'standing at station 1, the 360° bar is shown');
  await sleep(500); await pg.screenshot({ path: path.join(outDir, 'pano_photo.png') });
  // points on top: the photo and the points should line up
  await pg.evaluate(() => { __sb.PANO.overlay = true; __sb.S.dirty = true; }); await sleep(500); await pg.screenshot({ path: path.join(outDir, 'pano_overlay.png') }); await pg.evaluate(() => { __sb.PANO.overlay = false; __sb.S.dirty = true; });
  await pg.evaluate(() => __sb.panoOpen(__sb.PANO.list[1])); ok(await wait(pg, () => !!(__sb.PANO.list[1].tex.photo)), 'six pinhole photos stitched into a panorama');
  await sleep(500); await pg.screenshot({ path: path.join(outDir, 'pano_pinhole.png') });
  await pg.evaluate(() => { const s = __sb.PANO.list[1]; s.show = 'scan'; return __sb.panoOpen(s); }); ok(await wait(pg, () => !!(__sb.PANO.list[1].tex.scan)), 'panorama built from the scan points');
  await sleep(500); await pg.screenshot({ path: path.join(outDir, 'pano_scan.png') });
  // wheel zooms the lens, the camera stays on the station
  await pg.mouse.move(700, 400); await pg.mouse.wheel(0, -500); await sleep(200);
  const z = await pg.evaluate(() => ({ dist: __sb.S.cam.dist, active: !!__sb.PANO.active }));
  ok(z.active && z.dist < 0.02, 'wheel zooms the lens without leaving the station');
  await pg.keyboard.press('Escape'); await sleep(900); ok(await pg.evaluate(() => !__sb.PANO.active && __sb.S.cam.dist > 1), 'Esc leaves the 360° view and returns to the previous view');
  ok(!pg.errs.length, 'no page errors (' + pg.errs.slice(0, 2).join(' | ') + ')'); await pg.close();
  // ---- aerials ----
  pg = await page();
  await pg.setInputFiles('#fileIn', [path.join(dataDir, 'ortho.tif')]);
  ok(await wait(pg, () => __sb.ORTHO.list.length === 1), 'GeoTIFF loaded');
  const g = await pg.evaluate(() => { const O = __sb.ORTHO.list[0]; return { w: O.w, h: O.h, A: O.A, crs: O.crs, levels: O.src.levels.length, scrs: __sb.S.crs }; });
  console.log('     ', JSON.stringify(g));
  ok(g.w === 6000 && Math.abs(g.A[0] - 0.1) < 1e-9 && Math.abs(g.A[2] - 421300) < 1e-6 && Math.abs(g.A[5] - 6464100) < 1e-6, 'geo-referencing read from the GeoTIFF tags');
  ok(g.crs === 'MGA2020-50' && g.levels === 5, 'EPSG:7850 recognised; 5 resolution levels');
  await pg.setInputFiles('#fileIn', [path.join(dataDir, 'ortho.jpg'), path.join(dataDir, 'ortho.jgw')]);
  ok(await wait(pg, () => __sb.ORTHO.list.length === 2), 'JPEG + world file loaded');
  const j = await pg.evaluate(() => { const O = __sb.ORTHO.list[1]; return { A: O.A, w: O.w }; });
  ok(Math.abs(j.A[2] - 421300) < 1e-6 && Math.abs(j.A[5] - 6464100) < 1e-6 && Math.abs(j.A[0] - 0.3) < 1e-9, 'world file read (pixel centre moved to the corner)');
  await pg.evaluate(() => { __sb.ORTHO.list[1].visible = false; __sb.fitAll(); __sb.S.dirty = true; }); await sleep(1200); await pg.screenshot({ path: path.join(outDir, 'ortho_all.png') });
  // zoom right in on a known grid crossing (E 421500, N 6463800)
  await pg.evaluate(() => { const S = __sb.S; S.cam.target.set(421500 - S.origin[0], 6463800 - S.origin[1], 0); S.cam.dist = 12; S.cam.pitch = 1.5; __sb.updateCamera(); S.dirty = true; });
  ok(await wait(pg, () => !!__sb.ORTHO.list[0].detail, 20000), 'zoomed in: the part in view was read again at full detail');
  await sleep(500); await pg.screenshot({ path: path.join(outDir, 'ortho_zoom.png') });
  ok(!pg.errs.length, 'no page errors (' + pg.errs.slice(0, 2).join(' | ') + ')'); if (pg.errs.length) console.log(pg.stacks.slice(0, 2).join('\n')); await pg.close();
  // ---- 360° photos ----
  pg = await page();
  await pg.evaluate(() => { __sb.S.crs = 'MGA2020-50'; });
  await pg.setInputFiles('#fileIn', [path.join(dataDir, 'pano_gps.jpg'), path.join(dataDir, 'pano_csv.jpg'), path.join(dataDir, 'pano_pos.csv')]);
  ok(await wait(pg, () => __sb.PANO.list.length === 2), 'two 360° photos placed (one from EXIF GPS, one from the CSV)');
  const pp = await pg.evaluate(() => __sb.PANO.list.map(s => ({ n: s.name, E: s.pos.x + __sb.S.origin[0], N: s.pos.y + __sb.S.origin[1], Z: s.pos.z + __sb.S.origin[2], h: s.heading })));
  console.log('     ', JSON.stringify(pp));
  const csv = pp.find(p => p.n === 'pano_csv.jpg'), gps = pp.find(p => p.n === 'pano_gps.jpg');
  ok(csv && Math.abs(csv.E - 421520) < 1e-6 && Math.abs(csv.N - 6463800) < 1e-6 && csv.h === 90, 'CSV position and heading used');
  const ref = await pg.evaluate(() => window.SBX.convertPoint(116.1615, -31.9668, 150, 'GDA2020', 'MGA2020-50'));
  ok(gps && Math.abs(gps.E - ref[0]) < 0.01 && Math.abs(gps.N - ref[1]) < 0.01 && gps.E > 420000 && gps.E < 422000 && gps.h === 45 && gps.Z === 150, 'GPS position converted to MGA2020 zone 50 (E ' + (gps && gps.E.toFixed(1)) + ', N ' + (gps && gps.N.toFixed(1)) + '), heading from EXIF');
  await pg.evaluate(() => __sb.panoOpen(__sb.PANO.list.find(s => s.name === 'pano_csv.jpg'))); await sleep(1500); ok(await pg.evaluate(() => !!__sb.PANO.active), 'standing at the imported photo');
  // heading 90 = east: the red centre line of the photo should be straight ahead when looking east (yaw: camera sits west of target → yaw = π)
  await pg.evaluate(() => { __sb.S.cam.yaw = Math.PI; __sb.S.cam.pitch = 0; __sb.updateCamera(); __sb.S.dirty = true; }); await sleep(600);
  const box = await pg.evaluate(() => { const r = document.getElementById('gl').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  const shot = await pg.screenshot({ clip: { x: box[0] - 2, y: box[1], width: 5, height: 1 } }); const { PNG } = (() => { try { return require('pngjs'); } catch (e) { return {}; } })();
  let red = [0, 0, 0]; if (PNG) { const im = PNG.sync.read(shot); red = [im.data[8], im.data[9], im.data[10]]; } else { red = await pg.evaluate(async b64 => { const im = new Image(); im.src = 'data:image/png;base64,' + b64; await im.decode(); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const x = c.getContext('2d'); x.drawImage(im, 0, 0); const d = x.getImageData(0, 0, c.width, 1).data; const k = Math.floor(c.width / 2) * 4; return [d[k], d[k + 1], d[k + 2]]; }, shot.toString('base64')); }
  ok(red[0] > 200 && red[1] < 90, 'looking east, the photo centre (heading 90°) is straight ahead (pixel ' + red.join(',') + ')');
  await pg.screenshot({ path: path.join(outDir, 'pano_import.png') });
  ok(!pg.errs.length, 'no page errors (' + pg.errs.slice(0, 2).join(' | ') + ')');
  await b.close(); srv.kill(); console.log(fails ? fails + ' FAILED' : 'all passed'); process.exit(fails ? 1 : 0);
})();
