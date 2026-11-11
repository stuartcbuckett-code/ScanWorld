// Scan to CAD scorecard: runs detection on the platform sample, deck by deck, and scores it against the truth table.
//   node test/score_cad.js [cellar|main|upper ...] [--save] [--json out.json]
// --save writes test/score_baseline.json; without it the run is compared with the baseline and regressions are flagged.
const fs = require('fs'), path = require('path'); const io = require('../src/io.js'), C = require('../src/cad.js'); const { create } = require('laz-perf');
const V = C.vec, sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], len = a => Math.hypot(a[0], a[1], a[2]);
const OFF = [335000, 7710000, 0];
const REG = { cellar: [11.0, 16.6], main: [16.6, 22.8], upper: [22.8, 28.5] };
const args = process.argv.slice(2), want = args.filter(a => REG[a]); const regs = want.length ? want : Object.keys(REG);

function truth() {
  const L = fs.readFileSync(path.join(__dirname, '..', 'samples', 'offshore_platform_truth.csv'), 'utf8').trim().split('\n').slice(1).map(l => l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map(s => s.replace(/,$/, '').replace(/^"|"$/g, '')));
  return L.map(c => { const a = [+c[3] - OFF[0], +c[4] - OFF[1], +c[5]]; const b = c[6] === '' ? a.slice() : [+c[6] - OFF[0], +c[7] - OFF[1], +c[8]]; return { type: c[0], name: c[1], size: c[2], a, b }; }).filter(t => c => true).filter(t => isFinite(t.a[0]) && isFinite(t.b[0]));
}
// how much of truth segment T is covered by detected segments (parallel, close to the line)
function coverage(T, dets, latTol, angTol = 6) {
  const ax = V.norm(sub(T.b, T.a)), L = len(sub(T.b, T.a)); const iv = []; const used = [];
  for (const d of dets) { const dx = V.norm(sub(d.p1, d.p0)); if (Math.abs(V.dot(ax, dx)) < Math.cos(angTol * Math.PI / 180)) continue;
    const off = q => { const v = sub(q, T.a), t = V.dot(v, ax); return [t, len(sub(v, ax.map(x => x * t)))]; }; const [t0, o0] = off(d.p0), [t1, o1] = off(d.p1); if (Math.max(o0, o1) > latTol) continue;
    const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(L, Math.max(t0, t1)); if (hi - lo > 0.05) { iv.push([lo, hi]); used.push(d); } }
  iv.sort((p, q) => p[0] - q[0]); let cov = 0, end = -1; for (const [lo, hi] of iv) { if (hi <= end) continue; cov += hi - Math.max(lo, end); end = hi; }
  return { frac: L > 0 ? cov / L : 0, used, L };
}
(async () => {
  const dir = path.join(__dirname, '..', 'samples'); const parts = [];
  for (const f of fs.readdirSync(dir).filter(f => /^platform_\d\.laz$/.test(f)).sort()) { const u = fs.readFileSync(path.join(dir, f)); parts.push(await io.readLAS({ name: f, size: u.length, read: async (o, l) => u.buffer.slice(u.byteOffset + o, u.byteOffset + o + l) }, { lazPerf: create, budget: 1e9 })); }
  const n = parts.reduce((a, p) => a + p.n, 0), pos = new Float32Array(n * 3); let q = 0; const o = parts[0].origin;
  for (const p of parts) { const d = [p.origin[0] - o[0], p.origin[1] - o[1], p.origin[2] - o[2]]; for (let i = 0; i < p.n; i++, q++) { pos[q * 3] = p.pos[i * 3] + d[0]; pos[q * 3 + 1] = p.pos[i * 3 + 1] + d[1]; pos[q * 3 + 2] = p.pos[i * 3 + 2] + d[2]; } }
  const W = p => [p[0] + o[0] - OFF[0], p[1] + o[1] - OFF[1], p[2] + o[2]];   // detection → platform coordinates
  let T = truth(); const out = { regions: {}, total: {} };
  // the sample generator laid three rack pipes on one line: drop truth pipes that coincide with an earlier, different-size one
  { const pipes = T.filter(t => t.type === 'pipe'), bad = new Set(); for (let i = 0; i < pipes.length; i++) for (let j = 0; j < i; j++) { if (pipes[i].size === pipes[j].size || bad.has(pipes[j])) continue; const c = coverage(pipes[i], [{ p0: pipes[j].a, p1: pipes[j].b }], 0.04); if (c.frac > 0.5) bad.add(pipes[i]); } T = T.filter(t => !bad.has(t)); out.truthDropped = bad.size; } const tot = {};
  const add = (k, v) => { tot[k] = (tot[k] || 0) + v; };
  for (const rg of regs) {
    const [z0, z1] = REG[rg]; const XY = process.env.XY ? process.env.XY.split(',').map(Number) : [-8.6, -9, 8.6, 8.6]; const box = [XY[0] + OFF[0] - o[0], XY[1] + OFF[1] - o[1], z0 - o[2], XY[2] + OFF[0] - o[0], XY[3] + OFF[1] - o[1], z1 - o[2]];
    const t0 = Date.now(); const r = await C.scanToCad(pos, n, Object.assign({ spacing: 0.02, box }, process.env.OPTS ? JSON.parse(process.env.OPTS) : {})); const secs = (Date.now() - t0) / 1000;
    const inR = t => { const z = (t.a[2] + t.b[2]) / 2, x = (t.a[0] + t.b[0]) / 2, y = (t.a[1] + t.b[1]) / 2; return z >= z0 && z < z1 && x > XY[0] && x < XY[2] && y > XY[1] && y < XY[3]; };
    const dp = r.pipes.map(p => ({ p0: W(p.p0), p1: W(p.p1), od: p.r * 2000, label: p.label, ref: p })), ds = r.steel.map(s => ({ p0: W(s.p0), p1: W(s.p1), label: s.label, ref: s }));
    const S = {};
    // pipes
    const tp = T.filter(t => t.type === 'pipe' && inR(t) && len(sub(t.b, t.a)) >= 0.5); let found = 0, sizeOK = 0, lenT = 0, lenF = 0; const hitP = new Set(), missP = [];
    for (const t of tp) { const od = +t.size.match(/OD ([\d.]+)/)[1]; const c = coverage(t, dp.filter(d => Math.abs(d.od - od) / od < 0.2), Math.max(0.08, od / 1000)); lenT += c.L; lenF += c.L * c.frac; if (c.frac >= 0.5) { found++; c.used.forEach(d => hitP.add(d)); if (c.used.some(d => Math.abs(d.od - od) / od < 0.06)) sizeOK++; } else { const any = coverage(t, dp, Math.max(0.08, od / 1000)); if (any.frac >= 0.5) any.used.forEach(d => hitP.add(d)); missP.push(t.name + ' ' + t.size + ' L' + c.L.toFixed(1) + (any.frac >= 0.5 ? ' (found, wrong size ' + any.used.map(d => d.od.toFixed(0)).join('/') + ')' : '')); } }
    // structural tubes and legs found as pipes or large tubulars are right, not false
    const tt = T.filter(t => t.type === 'tubular' || t.type === 'equipment'); for (const t of tt) { const c = coverage(t, dp, 0.35, 8); c.used.forEach(d => hitP.add(d)); }
    for (const t of T.filter(t => t.type === 'pipe' && !inR(t))) { const od = +t.size.match(/OD ([\d.]+)/)[1]; coverage(t, dp, Math.max(0.08, od / 1000)).used.forEach(d => hitP.add(d)); }   // pipes that cross the region edge are real too
    // short pieces at elbows, valves and flanges are part of the real pipework; light poles and legs are real cylinders
    const fitPts = T.filter(t => ['elbow', 'valve', 'flange', 'clamp', 'wellhead'].includes(t.type)); for (const d of dp) { if (hitP.has(d)) continue; const mid = d.p0.map((v, k) => (v + d.p1[k]) / 2); if (len(sub(d.p1, d.p0)) < 1.0 && fitPts.some(t => len(sub(t.a, mid)) < 0.7 || len(sub(t.b, mid)) < 0.7)) hitP.add(d); }
    const falseP = dp.filter(d => !hitP.has(d)); const smallFalse = falseP.filter(d => d.od < 62).length;
    S.pipes = { truth: tp.length, found, sizeOK, lengthRecall: +(lenF / (lenT || 1)).toFixed(3), detected: dp.length, false: falseP.length, falseSmall: smallFalse, missed: missP };
    // steel
    const ts = T.filter(t => t.type === 'steel' && inR(t) && len(sub(t.b, t.a)) >= 0.5); let fs_ = 0, lab = 0, fam = 0; const hitS = new Set(), missS = [], wrong = {};
    for (const t of ts) { const c = coverage(t, ds, 0.3); if (c.frac >= 0.5) { fs_++; c.used.forEach(d => hitS.add(d)); const best = c.used.slice().sort((a, b) => len(sub(b.p1, b.p0)) - len(sub(a.p1, a.p0)))[0]; if (best.label.replace(/\s/g, '').includes(t.size)) lab++; else { const k = t.size + ' → ' + best.label; wrong[k] = (wrong[k] || 0) + 1; } if ((/UB|UC/.test(t.size) && /UB|UC|I-section/.test(best.label)) || (/PFC/.test(t.size) && /PFC|Channel/i.test(best.label))) fam++; } else missS.push(t.name + ' ' + t.size + ' L' + c.L.toFixed(1)); }
    for (const t of T.filter(t => t.type === 'cable tray' || t.type === 'tubular')) coverage(t, ds, 0.45, 8).used.forEach(d => hitS.add(d));   // tray rails and braces are real steel
    const falseS = ds.filter(d => !hitS.has(d));
    S.steel = { truth: ts.length, found: fs_, familyOK: fam, sectionOK: lab, detected: ds.length, false: falseS.length, wrongSection: wrong, missed: missS.length, falseLabels: falseS.slice(0, 12).map(d => d.label + ' L' + len(sub(d.p1, d.p0)).toFixed(1)) };
    // vessels
    const tv = T.filter(t => t.type === 'vessel' && inR(t)); let fv = 0; const vd = [];
    for (const t of tv) { const m = t.size.match(/ID (\d+), T\/T (\d+)/), id = +m[1], tl = +m[2]; const mid = t.a.map((v, k) => (v + t.b[k]) / 2); const hit = r.vessels.find(v => len(sub(W(v.p0).map((x, k) => (x + W(v.p1)[k]) / 2), mid)) < 1.0 && Math.abs(v.r * 2000 - id) / id < 0.1); if (hit) { fv++; vd.push(t.name + ': ID ' + (hit.r * 2000).toFixed(0) + ' (' + id + '), T/T ' + (hit.length * 1000).toFixed(0) + ' (' + tl + ')'); } }
    S.vessels = { truth: tv.length, found: fv, detected: r.vessels.length, false: r.vessels.length - fv, detail: vd, tubulars: (r.cylinders || []).length };
    // cabinets
    const tc = T.filter(t => t.type === 'cabinet' && inR(t)); let fc = 0; const hitB = new Set();
    for (const t of tc) { const hit = r.boxes.find(b => { const c = W(b.centre); const hw = Math.max(b.W, b.D) / 2 + 0.15; return Math.abs(c[0] - t.a[0]) < hw && Math.abs(c[1] - t.a[1]) < hw && W([0, 0, b.zmin])[2] < t.b[2] && W([0, 0, b.zmax])[2] > t.a[2]; }); if (hit) { fc++; hitB.add(hit); } }
    S.cabinets = { truth: tc.length, found: fc, detected: r.boxes.length, false: r.boxes.length - hitB.size, falseLabels: r.boxes.filter(b => !hitB.has(b)).map(b => b.label + ' @' + W(b.centre).map(v => v.toFixed(1)).join(',')) };
    // flanges
    const tf = T.filter(t => t.type === 'flange' && inR(t)); let ff = 0; const hitF = new Set(); const df = r.flanges.map(f => W(f.at));
    for (const t of tf) { const k = df.findIndex((p, i) => !hitF.has(i) && len(sub(p, t.a)) < 0.2); if (k >= 0) { ff++; hitF.add(k); } }
    S.flanges = { truth: tf.length, found: ff, detected: df.length, false: df.length - hitF.size };
    const tpp = T.filter(t => t.type === 'person' && inR(t)); S.people = { truth: tpp.length, found: tpp.filter(t => (r.people || []).some(f => Math.hypot(W(f.centre)[0] - t.a[0], W(f.centre)[1] - t.a[1]) < 0.5)).length, detected: (r.people || []).length };
    S.handrails = { detected: r.handrails.length, length: +r.handrails.reduce((a, h) => a + h.length, 0).toFixed(1) }; S.seconds = +secs.toFixed(0);
    out.regions[rg] = S;
    for (const k of ['pipes', 'steel', 'vessels', 'cabinets', 'flanges', 'people']) for (const f of ['truth', 'found', 'detected', 'false', 'sizeOK', 'sectionOK', 'familyOK']) if (S[k][f] !== undefined) add(k + '.' + f, S[k][f]);
    console.log('\n== ' + rg + ' (' + S.seconds + ' s)');
    console.log(' pipes    found ' + found + '/' + tp.length + ' (size right ' + sizeOK + ', length recall ' + (S.pipes.lengthRecall * 100).toFixed(0) + '%)  false ' + falseP.length + ' of ' + dp.length + ' (' + smallFalse + ' under 62 mm)');
    console.log(' steel    found ' + fs_ + '/' + ts.length + ' (family right ' + fam + ', section right ' + lab + ')  false ' + falseS.length + ' of ' + ds.length);
    console.log(' vessels  found ' + fv + '/' + tv.length + '  false ' + (r.vessels.length - fv) + '   cabinets found ' + fc + '/' + tc.length + '  false ' + S.cabinets.false + '   flanges found ' + ff + '/' + tf.length + '  false ' + S.flanges.false + '   people ' + S.people.found + '/' + S.people.truth);
    if (args.includes('--detail')) console.log(JSON.stringify({ missedPipes: missP, missedSteel: missS, wrongSection: wrong, falseSteel: S.steel.falseLabels, falseBoxes: S.cabinets.falseLabels, falsePipes: falseP.slice(0, 15).map(d => d.label + ' L' + len(sub(d.p1, d.p0)).toFixed(1) + ' @' + d.p0.map(v => v.toFixed(1)).join(',')) }, null, 1));
  }
  out.total = tot; const P = (a, b) => (tot[a] || 0) + '/' + (tot[b] || 0);
  console.log('\n== TOTAL  pipes ' + P('pipes.found', 'pipes.truth') + ' false ' + (tot['pipes.false'] || 0) + ' | steel ' + P('steel.found', 'steel.truth') + ' section right ' + (tot['steel.sectionOK'] || 0) + ' false ' + (tot['steel.false'] || 0) + ' | vessels ' + P('vessels.found', 'vessels.truth') + ' false ' + (tot['vessels.false'] || 0) + ' | cabinets ' + P('cabinets.found', 'cabinets.truth') + ' false ' + (tot['cabinets.false'] || 0) + ' | flanges ' + P('flanges.found', 'flanges.truth') + ' false ' + (tot['flanges.false'] || 0));
  const bf = path.join(__dirname, 'score_baseline.json'); const ji = args.indexOf('--json'); if (ji >= 0) fs.writeFileSync(args[ji + 1], JSON.stringify(out, null, 1));
  if (args.includes('--save')) { fs.writeFileSync(bf, JSON.stringify(out, null, 1)); console.log('baseline saved'); }
  else if (fs.existsSync(bf) && !want.length) { const b = JSON.parse(fs.readFileSync(bf, 'utf8')).total; let bad = 0; for (const k of Object.keys(b)) { const worse = /found|OK$/.test(k) ? tot[k] < b[k] : /false/.test(k) ? tot[k] > b[k] * 1.1 + 1 : false; if (worse) { console.log('REGRESSION ' + k + ': ' + b[k] + ' → ' + tot[k]); bad++; } } if (bad) process.exit(1); console.log('no regressions against the baseline'); }
})().catch(e => { console.error(e); process.exit(1); });
