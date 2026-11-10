// Reads every bundled sample part: checks the LAS reader and the chunk-by-chunk LAZ decoder against each other.
const fs = require('fs'), path = require('path'); const io = require('../src/io.js'); const { create } = require('laz-perf');
const dir = path.join(__dirname, '..', 'samples'); let fail = 0;
(async () => {
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.laz')).sort()) {
    const u = fs.readFileSync(path.join(dir, f)); const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
    const hs = dv.getUint16(94, true), po = dv.getUint32(96, true), nv = dv.getUint32(100, true), fmt = dv.getUint8(104) & 0x3f, rl = dv.getUint16(105, true); let cnt = dv.getUint32(107, true); if (dv.getUint8(25) >= 4) cnt = Number(dv.getBigUint64(247, true)) || cnt;
    let p = hs, chunk = 0; for (let i = 0; i < nv; i++) { const uid = u.subarray(p + 2, p + 18).toString().replace(/\0.*$/, ''), rid = dv.getUint16(p + 18, true), len = dv.getUint16(p + 20, true); if (uid === 'laszip encoded' && rid === 22204) chunk = dv.getUint32(p + 54 + 12, true); p += 54 + len; }
    const ts = Number(dv.getBigInt64(po, true)); const T = io.lazChunkSizes(u.subarray(ts), chunk === 0xFFFFFFFF); const sum = T.sizes.reduce((a, b) => a + b, 0);
    const src = { name: f, size: u.length, read: async (o, l) => u.buffer.slice(u.byteOffset + o, u.byteOffset + o + l) };
    const L = await io.readLAS(src, { lazPerf: create, budget: 1e9 });
    const ok = sum === ts - po - 8 && L.n === cnt; if (!ok) fail++;
    console.log((ok ? 'ok  ' : 'FAIL'), f, 'format', fmt, 'points', cnt, 'read', L.n, 'chunks', T.sizes.length, 'chunk bytes', sum, 'expected', ts - po - 8);
  }
  if (fail) { console.error(fail + ' sample check(s) failed'); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
