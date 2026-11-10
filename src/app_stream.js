// ---------- DATASETS: unlimited points via an out-of-core octree on local storage (cloud-ready), full source metadata, re-export ----------
// Storage layout (one folder per dataset, identical locally and on a web server / bucket):
//   metadata.json  bounds, scale/offset, record layout, every source file's header + VLRs + EVLRs, node hierarchy
//   octree.bin     points node by node; each point = the source LAS record (all attributes, extra bytes) + 2-byte source index
S.streams = [];
const DS = { root: null, CH: 2500000, G: 128, LEAF: 60000, conc: 4 };
const RECLEN = { 0: 20, 1: 28, 2: 26, 3: 34, 4: 57, 5: 63, 6: 30, 7: 36, 8: 38, 9: 59, 10: 67 };
const b64e = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768)); return btoa(s); };
const b64d = s => Uint8Array.from(atob(s || ''), c => c.charCodeAt(0));

// ----- stores -----
class DirStore {
  constructor(h, label) { this.h = h; this.label = label || 'This browser'; }
  async fh(name, create = false) { return this.h.getFileHandle(name, { create }); }
  async file(name) { return (await this.fh(name)).getFile(); }
  async read(name, off, len) { const f = await this.file(name); return new Uint8Array(await f.slice(off, off + len).arrayBuffer()); }
  async text(name) { return (await this.file(name)).text(); }
  async writeText(name, s) { const w = await (await this.fh(name, true)).createWritable(); await w.write(s); await w.close(); }
  async writer(name) { const w = await (await this.fh(name, true)).createWritable(); let pos = 0; return { pos: () => pos, write: async u8 => { await w.write(u8); pos += u8.length; }, close: () => w.close() }; }
  async append(name, u8) { const h = await this.fh(name, true); const sz = (await h.getFile()).size; const w = await h.createWritable({ keepExistingData: true }); await w.seek(sz); await w.write(u8); await w.close(); }
  async remove(name) { try { await this.h.removeEntry(name); } catch (e) { } }
}
class HttpStore {   // the same folder served over HTTP(S) with Range support (S3, R2, Azure Blob, any static host with CORS)
  constructor(base) { this.base = base.replace(/\/?$/, '/'); this.label = base; }
  async read(name, off, len) { const r = await fetch(this.base + name, { headers: { Range: 'bytes=' + off + '-' + (off + len - 1) } }); if (!r.ok) throw new Error('HTTP ' + r.status + ' reading ' + name); const u = new Uint8Array(await r.arrayBuffer()); return r.status === 206 ? u : u.subarray(off, off + len); }
  async text(name) { const r = await fetch(this.base + name); if (!r.ok) throw new Error('HTTP ' + r.status + ' reading ' + name); return r.text(); }
}
async function dsRoot() { if (!DS.root) { if (!navigator.storage || !navigator.storage.getDirectory) throw new Error('This browser has no local file storage (needs a recent Chrome, Edge, Firefox or Safari).'); const r = await navigator.storage.getDirectory(); DS.root = await r.getDirectoryHandle('scanbench-datasets', { create: true }); try { await navigator.storage.persist(); } catch (e) { } } return DS.root; }

// ----- LAS records: decode / encode any point format 0-10 -----
function decRec(dv, p, f) {
  const o = { X: dv.getInt32(p, true), Y: dv.getInt32(p + 4, true), Z: dv.getInt32(p + 8, true), I: dv.getUint16(p + 12, true), gps: 0, r: 0, g: 0, b: 0, nir: 0 };
  if (f < 6) { const a = dv.getUint8(p + 14); o.ret = a & 7; o.nret = (a >> 3) & 7; o.sdir = (a >> 6) & 1; o.edge = a >> 7; const c = dv.getUint8(p + 15); o.cls = c & 31; o.cfl = c >> 5; o.ang = dv.getInt8(p + 16); o.user = dv.getUint8(p + 17); o.psid = dv.getUint16(p + 18, true); let q = 20; if (f === 1 || f === 3 || f === 4 || f === 5) { o.gps = dv.getFloat64(20 + p, true); q = 28; } if (f === 2 || f === 3 || f === 5) { o.r = dv.getUint16(p + q, true); o.g = dv.getUint16(p + q + 2, true); o.b = dv.getUint16(p + q + 4, true); } }
  else { const a = dv.getUint8(p + 14); o.ret = a & 15; o.nret = a >> 4; const c = dv.getUint8(p + 15); o.cfl = c & 15; o.chan = (c >> 4) & 3; o.sdir = (c >> 6) & 1; o.edge = c >> 7; o.cls = dv.getUint8(p + 16); o.user = dv.getUint8(p + 17); o.ang = dv.getInt16(p + 18, true) * 0.006; o.psid = dv.getUint16(p + 20, true); o.gps = dv.getFloat64(p + 22, true); if (f === 7 || f === 8 || f === 10) { o.r = dv.getUint16(p + 30, true); o.g = dv.getUint16(p + 32, true); o.b = dv.getUint16(p + 34, true); } if (f === 8 || f === 10) o.nir = dv.getUint16(p + 36, true); }
  return o;
}
function encRec(dv, p, f, o) {
  dv.setInt32(p, o.X, true); dv.setInt32(p + 4, o.Y, true); dv.setInt32(p + 8, o.Z, true); dv.setUint16(p + 12, o.I || 0, true);
  if (f < 6) { dv.setUint8(p + 14, (Math.min(7, o.ret || 1)) | (Math.min(7, o.nret || 1) << 3) | ((o.sdir || 0) << 6) | ((o.edge || 0) << 7)); dv.setUint8(p + 15, (Math.min(31, o.cls || 0)) | ((o.cfl || 0) & 7) << 5); dv.setInt8(p + 16, Math.max(-90, Math.min(90, Math.round(o.ang || 0)))); dv.setUint8(p + 17, o.user || 0); dv.setUint16(p + 18, o.psid || 0, true); let q = 20; if (f === 1 || f === 3 || f === 4 || f === 5) { dv.setFloat64(p + 20, o.gps || 0, true); q = 28; } if (f === 2 || f === 3 || f === 5) { dv.setUint16(p + q, o.r, true); dv.setUint16(p + q + 2, o.g, true); dv.setUint16(p + q + 4, o.b, true); } }
  else { dv.setUint8(p + 14, (Math.min(15, o.ret || 1)) | (Math.min(15, o.nret || 1) << 4)); dv.setUint8(p + 15, ((o.cfl || 0) & 15) | ((o.chan || 0) << 4) | ((o.sdir || 0) << 6) | ((o.edge || 0) << 7)); dv.setUint8(p + 16, o.cls || 0); dv.setUint8(p + 17, o.user || 0); dv.setInt16(p + 18, Math.round((o.ang || 0) / 0.006), true); dv.setUint16(p + 20, o.psid || 0, true); dv.setFloat64(p + 22, o.gps || 0, true); if (f === 7 || f === 8 || f === 10) { dv.setUint16(p + 30, o.r, true); dv.setUint16(p + 32, o.g, true); dv.setUint16(p + 34, o.b, true); } if (f === 8 || f === 10) dv.setUint16(p + 36, o.nir || 0, true); }
}
const hasRGB = f => [2, 3, 5, 7, 8, 10].includes(f);
const clsOff = f => f >= 6 ? 16 : 15, clsMask = f => f >= 6 ? 0xff : 0x1f, rgbOff = f => ({ 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 }[f]);

// ----- reading a LAS/LAZ header with its VLRs and EVLRs (kept verbatim for export) -----
async function lasInfo(file) {
  const head = new Uint8Array(await file.slice(0, Math.min(file.size, 375)).arrayBuffer()); const dv = new DataView(head.buffer);
  if (String.fromCharCode(...head.subarray(0, 4)) !== 'LASF') return null;
  const h = { major: dv.getUint8(24), minor: dv.getUint8(25), hs: dv.getUint16(94, true), po: dv.getUint32(96, true), nv: dv.getUint32(100, true), fb: dv.getUint8(104), rl: dv.getUint16(105, true), cnt: dv.getUint32(107, true),
    scale: [dv.getFloat64(131, true), dv.getFloat64(139, true), dv.getFloat64(147, true)], offset: [dv.getFloat64(155, true), dv.getFloat64(163, true), dv.getFloat64(171, true)], max: [dv.getFloat64(179, true), dv.getFloat64(195, true), dv.getFloat64(211, true)], min: [dv.getFloat64(187, true), dv.getFloat64(203, true), dv.getFloat64(219, true)] };
  h.fmt = h.fb & 0x3f; h.laz = !!(h.fb & 0xc0);
  if (h.minor >= 4 && h.hs >= 375) { const c64 = Number(dv.getBigUint64(247, true)); if (c64) h.cnt = c64; h.evlrStart = Number(dv.getBigUint64(235, true)); h.nEvlr = dv.getUint32(243, true); }
  const hdr = new Uint8Array(await file.slice(0, h.hs).arrayBuffer()); const vb = new Uint8Array(await file.slice(h.hs, h.po).arrayBuffer());
  // split VLRs, drop the LASzip one (it describes compression, which we do not keep)
  const vlrs = []; let p = 0; const vd = new DataView(vb.buffer); while (p + 54 <= vb.length && vlrs.length < h.nv) { const len = vd.getUint16(p + 20, true); const uid = String.fromCharCode(...vb.subarray(p + 2, p + 18)).replace(/\0.*$/, ''), rid = vd.getUint16(p + 18, true); const bytes = vb.subarray(p, p + 54 + len); if (uid === 'laszip encoded' && rid === 22204) h.chunkSize = vd.getUint32(p + 54 + 12, true); else vlrs.push({ uid, rid, desc: String.fromCharCode(...vb.subarray(p + 22, p + 54)).replace(/\0+$/, ''), b64: b64e(bytes) }); p += 54 + len; }
  let evlrs = []; if (h.nEvlr && h.evlrStart && h.evlrStart < file.size) { const eb = new Uint8Array(await file.slice(h.evlrStart, file.size).arrayBuffer()); let q = 0; const ed = new DataView(eb.buffer); while (q + 60 <= eb.length && evlrs.length < h.nEvlr) { const len = Number(ed.getBigUint64(q + 20, true)); evlrs.push({ uid: String.fromCharCode(...eb.subarray(q + 2, q + 18)).replace(/\0+$/, ''), rid: ed.getUint16(q + 18, true), b64: b64e(eb.subarray(q, q + 60 + len)) }); q += 60 + len; } }
  const wkt = vlrs.find(v => v.uid === 'LASF_Projection' && v.rid === 2112); h.crsWKT = wkt ? new TextDecoder().decode(b64d(wkt.b64).subarray(54)).replace(/\0+$/, '') : null;
  h.hdrB64 = b64e(hdr); h.vlrs = vlrs; h.evlrs = evlrs; return h;
}
// streams decompressed records of one LAS/LAZ file in batches: cb(u8 records, count)
async function eachLasBatch(file, h, cb, onP) {
  if (!h.laz) { const per = Math.max(1, Math.floor(8e6 / h.rl)); for (let s = 0; s < h.cnt; s += per) { const m = Math.min(per, h.cnt - s); const u = new Uint8Array(await file.slice(h.po + s * h.rl, h.po + (s + m) * h.rl).arrayBuffer()); await cb(u, m); onP((s + m) / h.cnt); } return; }
  // LAZ of any size: read the chunk table, then decode chunk by chunk (only one group of chunks is in memory at a time)
  const LP = await getLaz(); const rl = h.rl; const dvh = new DataView(await file.slice(h.po, h.po + 8).arrayBuffer()); let ts = Number(dvh.getBigInt64(0, true)); if (ts === -1) ts = Number(new DataView(await file.slice(file.size - 8, file.size).arrayBuffer()).getBigInt64(0, true));
  const tEnd = h.evlrStart && h.evlrStart > ts ? h.evlrStart : file.size; const T = IO.lazChunkSizes(new Uint8Array(await file.slice(ts, tEnd).arrayBuffer()), h.chunkSize === 0xFFFFFFFF);
  const pp = LP._malloc(rl + 64); let off = h.po + 8, done = 0;
  try { for (let c = 0; c < T.sizes.length; ) {
      let c1 = c, bytes = 0, pts = 0; while (c1 < T.sizes.length && (c1 === c || bytes + T.sizes[c1] < 24e6)) { bytes += T.sizes[c1]; pts += T.totals ? T.totals[c1] : Math.min(h.chunkSize, h.cnt - done - pts); c1++; }
      const u = new Uint8Array(await file.slice(off, off + bytes).arrayBuffer()); const cp = LP._malloc(bytes); LP.HEAPU8.set(u, cp); const out = new Uint8Array(pts * rl); let o = 0, q = cp;
      for (let k = c; k < c1; k++) { const n = T.totals ? T.totals[k] : Math.min(h.chunkSize, h.cnt - done); const cd = new LP.ChunkDecoder(); cd.open(h.fmt, rl, q); for (let i = 0; i < n; i++) { cd.getPoint(pp); out.set(LP.HEAPU8.subarray(pp, pp + rl), o); o += rl; } cd.delete(); q += T.sizes[k]; done += n; }
      LP._free(cp); await cb(out, pts); off += bytes; c = c1; onP(done / h.cnt); }
  } finally { LP._free(pp); }
}

// ----- import: any number of files (LAS, LAZ, E57, PLY, XYZ) → one dataset -----
async function importDataset(files, name, store) {
  files = [...files]; if (!files.length) return null;
  const root = await dsRoot(); const id = 'ds' + Date.now().toString(36); const dir = store ? null : await root.getDirectoryHandle(id, { create: true }); const st = store || new DirStore(dir);
  const job = { stop: false }; DS.job = job; buildDatasets();
  const res = await busy('Importing ' + files.length + ' file' + (files.length > 1 ? 's' : '') + ' as a dataset…', async onP => {
    // 1. headers → record layout, scale, offset
    const infos = []; for (const f of files) infos.push(/\.la[sz]$/i.test(f.name) ? await lasInfo(f) : null);
    const las = infos.filter(Boolean); const same = las.length === files.length && las.every(h => h.fmt === las[0].fmt && h.rl === las[0].rl);
    let fmt, rl; if (same) { fmt = las[0].fmt; rl = las[0].rl; } else { fmt = infos.some(h => h && (h.fmt === 8 || h.fmt === 10)) ? 8 : 7; rl = RECLEN[fmt]; }
    const scale = las.length ? [0, 1, 2].map(k => Math.min(...las.map(h => h.scale[k]))) : [0.001, 0.001, 0.001];
    let offset = las.length && las.every(h => h.offset.every((v, k) => v === las[0].offset[k])) ? las[0].offset.slice() : las.length ? las[0].min.map(v => Math.floor(v / 1000) * 1000) : null;
    // integer coordinates must fit 32 bits: widen the scale when the sources span too far for the finest one
    let coarsened = false; if (las.length) for (let k = 0; k < 3; k++) { const lo = Math.min(...las.map(h => h.min[k])), hi = Math.max(...las.map(h => h.max[k])); if (!offset || offset[k] > lo || hi - offset[k] > 2.0e9 * scale[k]) { if (!offset) offset = [0, 0, 0]; offset[k] = Math.floor(lo / 1000) * 1000; } while ((hi - offset[k]) / scale[k] > 2.0e9) { scale[k] *= 10; coarsened = true; } }
    if (coarsened) toast('These files span a very large area, so coordinates are stored at ' + scale.map(v => v * 1000 + ' mm').join(' / ') + ' resolution instead of the finest source resolution.', true);
    { const est = las.reduce((a, h) => a + h.cnt, 0) * (rl + 2) * 2.3, q = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate().catch(() => null) : null;
      if (q && est > (q.quota - q.usage)) throw new Error('Not enough browser storage for this import: it needs about ' + (est / 1e9).toFixed(1) + ' GB while converting (' + (est / 2.3e9).toFixed(1) + ' GB afterwards) and ' + ((q.quota - q.usage) / 1e9).toFixed(1) + ' GB is free. Free up disk space, delete old datasets, or import fewer files at a time.'); }
    const stride = rl + 2; const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; let total = 0, rgbMax = 0, iMax = 0; const sources = [];
    // 2. stage: every source → records in the dataset layout (+ source index), one stage file per source
    for (let fi = 0; fi < files.length; fi++) {
      if (job.stop) throw new Error('Import cancelled.'); const f = files[fi], h = infos[fi]; const sw = await st.writer('stage_' + fi + '.bin'); let n = 0;
      const src = { name: f.name, size: f.size, points: 0 };
      const put = async (u8, m, srcFmt, srcRl, sScale, sOff) => {
        const out = new Uint8Array(m * stride), dvo = new DataView(out.buffer), dvi = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); const conv = srcFmt !== fmt || srcRl !== rl;
        for (let k = 0; k < m; k++) { const pi = k * srcRl, po = k * stride;
          if (conv) encRec(dvo, po, fmt, decRec(dvi, pi, srcFmt)); else out.set(u8.subarray(pi, pi + rl), po);
          // re-quantise X/Y/Z into the dataset scale/offset
          const x = dvi.getInt32(pi, true) * sScale[0] + sOff[0], y = dvi.getInt32(pi + 4, true) * sScale[1] + sOff[1], z = dvi.getInt32(pi + 8, true) * sScale[2] + sOff[2];
          dvo.setInt32(po, Math.round((x - offset[0]) / scale[0]), true); dvo.setInt32(po + 4, Math.round((y - offset[1]) / scale[1]), true); dvo.setInt32(po + 8, Math.round((z - offset[2]) / scale[2]), true); dvo.setUint16(po + rl, fi, true);
          if (x < mn[0]) mn[0] = x; if (x > mx[0]) mx[0] = x; if (y < mn[1]) mn[1] = y; if (y > mx[1]) mx[1] = y; if (z < mn[2]) mn[2] = z; if (z > mx[2]) mx[2] = z;
          const I = dvo.getUint16(po + 12, true); if (I > iMax) iMax = I; if (hasRGB(fmt)) { const ro = rgbOff(fmt) + po; const r = Math.max(dvo.getUint16(ro, true), dvo.getUint16(ro + 2, true), dvo.getUint16(ro + 4, true)); if (r > rgbMax) rgbMax = r; } }
        await sw.write(out); n += m; };
      if (h) { Object.assign(src, { kind: 'LAS', version: h.major + '.' + h.minor, compressed: h.laz, pointFormat: h.fmt, recordLength: h.rl, scale: h.scale, offset: h.offset, min: h.min, max: h.max, crsWKT: h.crsWKT, header: h.hdrB64, vlrs: h.vlrs, evlrs: h.evlrs });
        await eachLasBatch(f, h, (u, m) => put(u, m, h.fmt, h.rl, h.scale, h.offset), q => onP((fi + q) / files.length * 0.35)); }
      else { const r = await IO.readAny(IO.fileSource(f), { budget: 2e9, lazPerf: getLaz, onProgress: q => onP((fi + q * 0.7) / files.length * 0.35) }); if (!r || !r.n) throw new Error(f.name + ' has no points.'); if (r.mesh) throw new Error(f.name + ' is a mesh, not a point cloud.');
        if (!offset) offset = r.origin.map(v => Math.floor(v / 1000) * 1000);
        const tmp = new Uint8Array(r.n * 36), dt = new DataView(tmp.buffer); const one = [1, 1, 1], z0 = [0, 0, 0];
        for (let i = 0; i < r.n; i++) { const o = { X: Math.round((r.pos[i * 3] + r.origin[0] - offset[0]) / 0.0001), Y: Math.round((r.pos[i * 3 + 1] + r.origin[1] - offset[1]) / 0.0001), Z: Math.round((r.pos[i * 3 + 2] + r.origin[2] - offset[2]) / 0.0001), I: r.intensity ? Math.round(r.intensity[i] * 65535) : 0, ret: 1, nret: 1, cls: r.cls ? r.cls[i] : 1, psid: fi, r: r.rgb ? r.rgb[i * 3] * 257 : 0, g: r.rgb ? r.rgb[i * 3 + 1] * 257 : 0, b: r.rgb ? r.rgb[i * 3 + 2] * 257 : 0 }; encRec(dt, i * 36, 7, o); }
        Object.assign(src, { kind: (f.name.split('.').pop() || '').toUpperCase(), meta: r.meta || {} });
        await put(tmp, r.n, 7, 36, [0.0001, 0.0001, 0.0001], offset); }
      await sw.close(); src.points = n; total += n; sources.push(src);
    }
    if (!total) throw new Error('No points found.');
    console.log('[ds] staged', Math.round(performance.now()));
    // 3. count on a 128³ grid over the bounding cube and group cells into chunks of ≤ 2.5 M points;
    //    a cell that is still too heavy (a dense site inside a huge extent) gets its own 16³ grid, and so on
    const size = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) * 1.0001 + 1e-3, G = DS.G, cmin = mn.slice();
    const mkGrid = (min, sz, res, name) => ({ min, size: sz, res, name, cnt: new Uint32Array(res * res * res), map: new Int32Array(res * res * res).fill(-1), sub: new Map(), counting: true });
    const rootG = mkGrid(cmin, size, G, 'r'); const chunks = [];
    const cellIn = (g, x, y, z) => { const f = g.res / g.size, i = Math.max(0, Math.min(g.res - 1, Math.floor((x - g.min[0]) * f))), j = Math.max(0, Math.min(g.res - 1, Math.floor((y - g.min[1]) * f))), k = Math.max(0, Math.min(g.res - 1, Math.floor((z - g.min[2]) * f))); return (k * g.res + j) * g.res + i; };
    const xyz = (dv, p) => [dv.getInt32(p, true) * scale[0] + offset[0], dv.getInt32(p + 4, true) * scale[1] + offset[1], dv.getInt32(p + 8, true) * scale[2] + offset[2]];
    const eachStage = async (fn, p0, p1, drop) => { let done = 0; for (let fi = 0; fi < files.length; fi++) { const fl = await st.file('stage_' + fi + '.bin'); const per = Math.floor(16e6 / stride) * stride; for (let o = 0; o < fl.size; o += per) { if (job.stop) throw new Error('Import cancelled.'); const u = new Uint8Array(await fl.slice(o, Math.min(fl.size, o + per)).arrayBuffer()); await fn(u, new DataView(u.buffer)); done += u.length / stride; onP(p0 + (p1 - p0) * done / total); await tick(); } if (drop) await st.remove('stage_' + fi + '.bin'); } };   // drop: free each staged file as soon as it has been distributed
    const splitGrid = g => { const R = g.res, fresh = [];
      const sum = (l, i, j, k) => { const s_ = R >> l; let t = 0; for (let z = k * s_; z < (k + 1) * s_; z++) for (let y = j * s_; y < (j + 1) * s_; y++) { const b = (z * R + y) * R; for (let x = i * s_; x < (i + 1) * s_; x++) t += g.cnt[b + x]; } return t; };
      const rec = (l, i, j, k, name) => { const t = sum(l, i, j, k); if (!t) return; const s_ = R >> l;
        if (t <= DS.CH) { const ci = chunks.length; chunks.push({ name, level: name.length - 1, n: t }); for (let z = k * s_; z < (k + 1) * s_; z++) for (let y = j * s_; y < (j + 1) * s_; y++) for (let x = i * s_; x < (i + 1) * s_; x++) g.map[(z * R + y) * R + x] = ci; return; }
        if (s_ === 1) { const cs = g.size / R; if (name.length > 40) { const ci = chunks.length; chunks.push({ name, level: name.length - 1, n: t }); g.map[(k * R + j) * R + i] = ci; return; } const sg = mkGrid([g.min[0] + i * cs, g.min[1] + j * cs, g.min[2] + k * cs], cs, 16, name); g.sub.set((k * R + j) * R + i, sg); fresh.push(sg); return; }
        for (let o = 0; o < 8; o++) rec(l + 1, i * 2 + (o & 1), j * 2 + ((o >> 1) & 1), k * 2 + ((o >> 2) & 1), name + o); };
      rec(0, 0, 0, 0, g.name); g.counting = false; return fresh; };
    let todo = [rootG], round = 0;
    while (todo.length) { await eachStage(async (u, dv) => { for (let p = 0; p < u.length; p += stride) { const [x, y, z] = xyz(dv, p); let g = rootG; for (;;) { const c = cellIn(g, x, y, z); const sg = g.sub.get(c); if (sg) { g = sg; continue; } if (g.counting) g.cnt[c]++; break; } } }, 0.35 + 0.02 * round, 0.37 + 0.02 * round); const next = []; for (const g of todo) next.push(...splitGrid(g)); todo = next; round++; }
    const chunkOf = (x, y, z) => { let g = rootG; for (;;) { const c = cellIn(g, x, y, z); const sg = g.sub.get(c); if (sg) { g = sg; continue; } return g.map[c]; } };
    console.log('[ds] counted', Math.round(performance.now()));
    // 4. distribute records into chunk files
    // one file, each chunk at a known position (sizes come from the counts), written with positioned writes
    let acc = 0; for (const c of chunks) { c.off = acc; c.w = 0; acc += c.n * stride; }
    const cw = await (await st.fh('chunks.bin', true)).createWritable(); const bufs = chunks.map(() => ({ u: new Uint8Array(1 << 18), m: 0 }));
    const flush = async ci => { const b = bufs[ci], c = chunks[ci]; if (!b.m) return; await cw.write({ type: 'write', position: c.off + c.w, data: b.u.slice(0, b.m) }); c.w += b.m; b.m = 0; };
    await eachStage(async (u, dv) => { for (let p = 0; p < u.length; p += stride) { const [x, y, z] = xyz(dv, p); const ci = chunkOf(x, y, z); if (ci < 0) continue; const b = bufs[ci]; if (b.m + stride > b.u.length) await flush(ci); b.u.set(u.subarray(p, p + stride), b.m); b.m += stride; } }, 0.47, 0.6, true);
    for (let ci = 0; ci < chunks.length; ci++) await flush(ci); await cw.close();
    for (let fi = 0; fi < files.length; fi++) await st.remove('stage_' + fi + '.bin');
    console.log('[ds] distributed', Math.round(performance.now()));
    // 5. octree per chunk (Potree-style sampling); chunk roots kept aside for the levels above
    const out = await st.writer('octree.bin'); const hier = new Map();
    const writeNode = async (name, level, cb, recs) => { const off = out.pos(); if (recs.length) await out.write(recs); hier.set(name, { name, level, min: cb.min, size: cb.size, count: recs.length / stride, off, len: recs.length, children: [] }); };
    for (let ci = 0; ci < chunks.length; ci++) {
      const c = chunks[ci]; const u = await st.read('chunks.bin', c.off, c.w); const dv = new DataView(u.buffer); const n = u.length / stride; const cb0 = hierCube(c.name, cmin, size);
      const nodes = [{ name: c.name, level: c.level, min: cb0.min, size: cb0.size, cells: new Set(), list: [], kids: [-1, -1, -1, -1, -1, -1, -1, -1] }];
      const order = new Uint32Array(n); for (let i = 0; i < n; i++) order[i] = i; let sd = 7 + ci; for (let i = n - 1; i > 0; i--) { sd = (sd * 1103515245 + 12345) >>> 0; const j = sd % (i + 1); const t = order[i]; order[i] = order[j]; order[j] = t; }
      for (let q = 0; q < n; q++) { const r = order[q], p = r * stride; const x = dv.getInt32(p, true) * scale[0] + offset[0], y = dv.getInt32(p + 4, true) * scale[1] + offset[1], z = dv.getInt32(p + 8, true) * scale[2] + offset[2]; let N = nodes[0];
        for (;;) { const f = G / N.size, kx = Math.max(0, Math.min(G - 1, Math.floor((x - N.min[0]) * f))), ky = Math.max(0, Math.min(G - 1, Math.floor((y - N.min[1]) * f))), kz = Math.max(0, Math.min(G - 1, Math.floor((z - N.min[2]) * f))); const key = (kz * G + ky) * G + kx;
          if (N.level >= c.level + 14 || !N.cells.has(key)) { N.cells.add(key); N.list.push(r); break; } const hs = N.size / 2, ox = x >= N.min[0] + hs ? 1 : 0, oy = y >= N.min[1] + hs ? 1 : 0, oz = z >= N.min[2] + hs ? 1 : 0, oc = ox | (oy << 1) | (oz << 2);
          let cI = N.kids[oc]; if (cI < 0) { cI = nodes.length; N.kids[oc] = cI; nodes.push({ name: N.name + oc, level: N.level + 1, min: [N.min[0] + ox * hs, N.min[1] + oy * hs, N.min[2] + oz * hs], size: hs, cells: new Set(), list: [], kids: [-1, -1, -1, -1, -1, -1, -1, -1] }); } N = nodes[cI]; } }
      // fold small subtrees into leaves
      const tot = new Int32Array(nodes.length); for (let k = nodes.length - 1; k >= 0; k--) { let t = nodes[k].list.length; for (const cc of nodes[k].kids) if (cc >= 0) t += tot[cc]; tot[k] = t; }
      const gath = (k, o) => { for (const i of nodes[k].list) o.push(i); for (const cc of nodes[k].kids) if (cc >= 0) gath(cc, o); };
      for (let k = 1; k < nodes.length; k++) { const N = nodes[k]; if (!N.list || !N.kids.some(cc => cc >= 0) || tot[k] > DS.LEAF) continue; const all = []; gath(k, all); const kill = [...N.kids.filter(cc => cc >= 0)]; while (kill.length) { const q = kill.pop(); for (const cc of nodes[q].kids) if (cc >= 0) kill.push(cc); nodes[q].list = null; } N.list = all; N.kids = [-1, -1, -1, -1, -1, -1, -1, -1]; }
      const recsOf = N => { const r = new Uint8Array(N.list.length * stride); N.list.forEach((i, k) => r.set(u.subarray(i * stride, i * stride + stride), k * stride)); return r; };
      for (let k = 1; k < nodes.length; k++) { const N = nodes[k]; if (!N.list) continue; await writeNode(N.name, N.level, { min: N.min, size: N.size }, recsOf(N)); }
      for (let k = 0; k < nodes.length; k++) { const N = nodes[k]; if (!N.list) continue; const ch = N.kids.filter(cc => cc >= 0 && nodes[cc].list).map(cc => nodes[cc].name); if (k === 0) c.kids = ch; else hier.get(N.name).children = ch; }
      await st.writeText('root_' + c.name + '.json', ''); await st.append('nb_' + c.name + '.bin', recsOf(nodes[0]));
      onP(0.6 + 0.3 * (ci + 1) / chunks.length); await tick();
    }
    console.log('[ds] chunks done', Math.round(performance.now()));
    await st.remove('chunks.bin');
    // 6. levels above the chunks: sample each node from its children's points (points move up, never duplicate)
    const pending = new Map(chunks.map(c => [c.name, { level: c.level, kids: c.kids }])); let lvl = Math.max(...chunks.map(c => c.level));
    const readNB = async nm => { try { const f = await st.file('nb_' + nm + '.bin'); return new Uint8Array(await f.arrayBuffer()); } catch (e) { return new Uint8Array(0); } };
    while (lvl > 0) {
      const parents = new Map(); for (const [nm, v] of pending) if (v.level === lvl) { const pn = nm.slice(0, -1); if (!parents.has(pn)) parents.set(pn, []); parents.get(pn).push(nm); }
      for (const [pn, kidsN] of parents) {
        const P = hierCube(pn, cmin, size); const bufsK = []; for (const k of kidsN) bufsK.push(await readNB(k));
        const cells = new Set(), up = [], keep = bufsK.map(() => []);
        bufsK.forEach((u, kI) => { const dv = new DataView(u.buffer, u.byteOffset, u.byteLength); const n = u.length / stride; const ord = Array.from({ length: n }, (_, i) => i); for (let i = n - 1; i > 0; i--) { const j = (i * 2654435761 >>> 0) % (i + 1); const t = ord[i]; ord[i] = ord[j]; ord[j] = t; }
          for (const r of ord) { const p = r * stride; const x = dv.getInt32(p, true) * scale[0] + offset[0], y = dv.getInt32(p + 4, true) * scale[1] + offset[1], z = dv.getInt32(p + 8, true) * scale[2] + offset[2]; const f = G / P.size; const key = (Math.min(G - 1, Math.max(0, Math.floor((z - P.min[2]) * f))) * G + Math.min(G - 1, Math.max(0, Math.floor((y - P.min[1]) * f)))) * G + Math.min(G - 1, Math.max(0, Math.floor((x - P.min[0]) * f)));
            if (!cells.has(key) && up.length < 400000) { cells.add(key); up.push(u.subarray(p, p + stride)); } else keep[kI].push(u.subarray(p, p + stride)); } });
        for (let q = 0; q < kidsN.length; q++) { const nm = kidsN[q]; const rec = new Uint8Array(keep[q].length * stride); keep[q].forEach((s, k) => rec.set(s, k * stride)); const C = hierCube(nm, cmin, size); await writeNode(nm, lvl, C, rec); hier.get(nm).children = pending.get(nm).kids || []; await st.remove('nb_' + nm + '.bin'); await st.remove('root_' + nm + '.json'); pending.delete(nm); }
        const pr = new Uint8Array(up.length * stride); up.forEach((s, k) => pr.set(s, k * stride)); await st.append('nb_' + pn + '.bin', pr); pending.set(pn, { level: lvl - 1, kids: kidsN });
      }
      console.log('[ds] level', lvl, parents.size, Math.round(performance.now())); lvl--; await tick();
    }
    { const rb = await readNB('r'); await writeNode('r', 0, hierCube('r', cmin, size), rb); hier.get('r').children = (pending.get('r') || {}).kids || []; await st.remove('nb_r.bin'); await st.remove('root_r.json'); }
    await out.close();
    const meta = { format: 'ScanBench dataset', version: 1, id, name: name || files[0].name.replace(/\.[^.]+$/, '') + (files.length > 1 ? ' +' + (files.length - 1) : ''), created: new Date().toISOString(), points: total,
      record: { pointFormat: fmt, length: rl, stride, sourceIndex: 'uint16 after each record', identicalToSources: same }, scale, offset, bounds: { min: mn, max: mx }, cube: { min: cmin, size }, grid: G, rgbMax, intensityMax: iMax, coordinatesCoarsened: coarsened,
      crs: { id: S.crs || null, wkt: (sources.find(s => s.crsWKT) || {}).crsWKT || null }, sources, data: 'octree.bin', hierarchy: [...hier.values()].sort((a, b) => a.level - b.level || (a.name < b.name ? -1 : 1)) };
    await st.writeText('metadata.json', JSON.stringify(meta)); onP(1);
    return meta;
  });
  DS.job = null;
  if (!res) { if (dir) try { await root.removeEntry(id, { recursive: true }); } catch (e) { } buildDatasets(); return null; }
  toast('Dataset ready: ' + res.points.toLocaleString() + ' points in ' + res.hierarchy.length.toLocaleString() + ' nodes. All source headers, VLRs and point attributes are kept.');
  await buildDatasets(); await openDataset(new DirStore(dir || store.h), res); return res;
}
function hierCube(name, cmin, size) { let mn = cmin.slice(), s = size; for (let q = 1; q < name.length; q++) { s /= 2; const o = +name[q]; mn = [mn[0] + (o & 1) * s, mn[1] + ((o >> 1) & 1) * s, mn[2] + ((o >> 2) & 1) * s]; } return { min: mn, size: s }; }

// ----- viewing: stream nodes on demand within the point budget -----
async function openDataset(store, meta) {
  meta = meta || JSON.parse(await store.text('metadata.json')); if (S.streams.some(D => D.meta.id === meta.id && D.store.label === store.label)) return;
  if (!S.origin) { S.origin = meta.cube.min.map(v => Math.floor(v)); $('#stOrigin').textContent = 'Local origin E ' + S.origin[0] + ' N ' + S.origin[1] + ' Z ' + S.origin[2]; }
  if (meta.crs && meta.crs.id && !S.crs) { S.crs = meta.crs.id; try { updateCrsStatus(); } catch (e) { } }
  const idx = new Map(meta.hierarchy.map((h, i) => [h.name, i])); const o = S.origin;
  const nodes = meta.hierarchy.map(h => { const box = new THREE.Box3(new THREE.Vector3(h.min[0] - o[0], h.min[1] - o[1], h.min[2] - o[2]), new THREE.Vector3(h.min[0] + h.size - o[0], h.min[1] + h.size - o[1], h.min[2] + h.size - o[2])); return Object.assign({}, h, { box, centre: box.getCenter(new THREE.Vector3()), radius: h.size * Math.sqrt(3) / 2, kidsI: h.children.map(c => idx.get(c)).filter(x => x !== undefined) }); });
  const D = { meta, store, nodes, rootI: idx.get('r'), root: new THREE.Group(), loaded: new Map(), inflight: new Set(), colorMode: hasRGB(meta.record.pointFormat) && meta.rgbMax ? 'rgb' : 'intensity', visible: true, selfVisible: true };
  D.box = new THREE.Box3(new THREE.Vector3(meta.bounds.min[0] - o[0], meta.bounds.min[1] - o[1], meta.bounds.min[2] - o[2]), new THREE.Vector3(meta.bounds.max[0] - o[0], meta.bounds.max[1] - o[1], meta.bounds.max[2] - o[2]));
  if (Math.hypot(meta.cube.min[0] - o[0], meta.cube.min[1] - o[1]) > 20000) toast(meta.name + ' is ' + (Math.hypot(meta.cube.min[0] - o[0], meta.cube.min[1] - o[1]) / 1000).toFixed(0) + ' km from the layers already open, so it will draw coarsely. Close the other layers first (or open it in a fresh session) for full precision.', true);
  scene.add(D.root); S.streams.push(D); S.selStream = D; applyVisibility(); refreshLayers(); buildDatasets(); if (!S.layers.length && S.streams.length === 1) fitBox(D.box); STR.key = ''; S.dirty = true; return D;
}
function closeDataset(D) { for (const [, L] of D.loaded) L.obj.geometry.dispose(); scene.remove(D.root); S.streams = S.streams.filter(x => x !== D); if (S.selStream === D) S.selStream = null; refreshLayers(); buildDatasets(); S.dirty = true; }
function decodeNode(D, u8) {
  const m = D.meta, st = m.record.stride, f = m.record.pointFormat, n = u8.length / st, dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), o = S.origin;
  const pos = new Float32Array(n * 3), rgb = hasRGB(f) ? new Uint8Array(n * 3) : null, I = new Uint16Array(n), cls = new Uint8Array(n), co = clsOff(f), cm = clsMask(f), ro = rgbOff(f), div = m.rgbMax > 255 ? 257 : 1;
  for (let i = 0; i < n; i++) { const p = i * st; pos[i * 3] = dv.getInt32(p, true) * m.scale[0] + m.offset[0] - o[0]; pos[i * 3 + 1] = dv.getInt32(p + 4, true) * m.scale[1] + m.offset[1] - o[1]; pos[i * 3 + 2] = dv.getInt32(p + 8, true) * m.scale[2] + m.offset[2] - o[2]; I[i] = dv.getUint16(p + 12, true); cls[i] = dv.getUint8(p + co) & cm; if (rgb) { rgb[i * 3] = dv.getUint16(p + ro, true) / div; rgb[i * 3 + 1] = dv.getUint16(p + ro + 2, true) / div; rgb[i * 3 + 2] = dv.getUint16(p + ro + 4, true) / div; } }
  return { n, pos, rgb, I, cls, raw: u8 };
}
function colorNode(D, N) {
  const c = N.col || (N.col = new Uint8Array(N.n * 3)), m = D.meta, mode = D.colorMode, tmp = [0, 0, 0], z0 = D.box.min.z, z1 = D.box.max.z;
  for (let i = 0; i < N.n; i++) { if (mode === 'rgb' && N.rgb) { c[i * 3] = N.rgb[i * 3]; c[i * 3 + 1] = N.rgb[i * 3 + 1]; c[i * 3 + 2] = N.rgb[i * 3 + 2]; } else if (mode === 'class') { const q = CLASS_COL[N.cls[i]] || [200, 200, 200]; c[i * 3] = q[0]; c[i * 3 + 1] = q[1]; c[i * 3 + 2] = q[2]; } else if (mode === 'elevation') { rampAt((N.pos[i * 3 + 2] - z0) / ((z1 - z0) || 1), 'bgr', tmp, 0); c[i * 3] = tmp[0]; c[i * 3 + 1] = tmp[1]; c[i * 3 + 2] = tmp[2]; } else { const v = Math.min(255, N.I[i] / (m.intensityMax || 65535) * 320); c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = v; } }
  if (N.obj) N.obj.geometry.attributes.color.needsUpdate = true;
}
async function loadNode(D, i) {
  const h = D.nodes[i]; D.inflight.add(i);
  try { const u8 = h.len ? await D.store.read(D.meta.data || 'octree.bin', h.off, h.len) : new Uint8Array(0); const N = decodeNode(D, u8); colorNode(D, N);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(N.pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(N.col, 3, true)); N.obj = new THREE.Points(g, makePtMat()); N.obj.frustumCulled = false; N.obj.visible = false; D.root.add(N.obj); N.last = performance.now(); D.loaded.set(i, N);
  } catch (e) { console.warn(e); D.failed = (D.failed || 0) + 1; } finally { D.inflight.delete(i); STR.key = ''; S.dirty = true; }
}
const STR = { key: '', shown: 0 };
function updateStreams() {
  const Ds = S.streams.filter(D => D.visible); for (const D of S.streams) D.root.visible = D.visible; if (!Ds.length) { STR.shown = 0; return; }
  const cam = curCam(); cam.updateMatrixWorld(); const pm = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  const key = pm.elements.map(v => v.toFixed(4)).join(',') + Ds.map(D => D.loaded.size + ':' + D.inflight.size).join() + S.clip.on + LODS.budget + LODS.minPx; if (key === STR.key) return; STR.key = key;
  const fr = new THREE.Frustum().setFromProjectionMatrix(pm); const pxScale = cam.isOrthographicCamera ? H() / (cam.top - cam.bottom) : H() / (2 * Math.tan(cam.fov * Math.PI / 360));
  const heap = []; const push = (D, i) => { const h = D.nodes[i]; if (!fr.intersectsBox(h.box)) return; if (S.clip.on && !S.clip.box.intersectsBox(h.box)) return; const d = cam.isOrthographicCamera ? 1 : Math.max(1e-6, cam.position.distanceTo(h.centre) - h.radius * 0.5); heap.push({ D, i, w: h.radius / d * pxScale }); };
  for (const D of Ds) { for (const [, N] of D.loaded) N.obj.visible = false; if (D.rootI !== undefined) push(D, D.rootI); }
  let shown = 0; const want = [], now = performance.now();
  while (heap.length) { let bi = 0; for (let k = 1; k < heap.length; k++) if (heap[k].w > heap[bi].w) bi = k; const it = heap[bi]; heap[bi] = heap[heap.length - 1]; heap.pop(); const h = it.D.nodes[it.i];
    if (shown + h.count > LODS.budget && h.level > 0) continue; const N = it.D.loaded.get(it.i);
    if (N) { N.obj.visible = true; N.last = now; shown += h.count; if (it.w > LODS.minPx) for (const c of h.kidsI) push(it.D, c); } else want.push(it); }
  STR.shown = shown;
  // fetch the most important missing nodes; evict least-recently-used ones beyond the cache
  for (const it of want.slice(0, 16)) { const busyN = S.streams.reduce((a, D) => a + D.inflight.size, 0); if (busyN >= DS.conc) break; if (!it.D.inflight.has(it.i)) loadNode(it.D, it.i); }
  let cached = S.streams.reduce((a, D) => a + [...D.loaded.values()].reduce((s, N) => s + N.n, 0), 0); const cap = LODS.budget * 2.5;
  if (cached > cap) { const all = []; for (const D of S.streams) for (const [i, N] of D.loaded) if (!N.obj.visible) all.push([D, i, N]); all.sort((a, b) => a[2].last - b[2].last); for (const [D, i, N] of all) { if (cached <= cap) break; D.root.remove(N.obj); N.obj.geometry.dispose(); D.loaded.delete(i); cached -= N.n; } }
  const s = $('#stLOD'); if (s) s.textContent = 'Shown ' + fmtN(LODS.shown + STR.shown) + ' of ' + fmtN(S.layers.filter(L => L.visible && L.kind === 'cloud').reduce((a, L) => a + L.n, 0) + Ds.reduce((a, D) => a + D.meta.points, 0)) + (S.streams.some(D => D.inflight.size) ? ' · loading…' : '');
  if (want.length) setTimeout(() => { STR.key = ''; S.dirty = true; }, 120);
}
const _drawS = draw; draw = function () { try { updateStreams(); } catch (e) { console.warn(e); } _drawS(); };
function pickSets() { const out = []; for (const D of S.streams || []) if (D.visible) for (const [, N] of D.loaded) if (N.obj.visible) out.push({ visible: true, kind: 'cloud', pos: N.pos, n: N.n, name: D.meta.name + ' (dataset)', stream: D }); return out; }
const _sceneBoxS = sceneBox; sceneBox = function (onlyVisible = true) { const b = _sceneBoxS(onlyVisible); for (const D of S.streams || []) if (!onlyVisible || D.visible) b.union(D.box); return b; };

// ----- reading points back at full density (a box) or as an even sample (a point count) -----
async function readBox(D, box, maxPts = 4e7, onP = () => {}) {
  const sel = D.nodes.map((h, i) => i).filter(i => D.nodes[i].count && (!box || box.intersectsBox(D.nodes[i].box))); const est = sel.reduce((a, i) => a + D.nodes[i].count, 0); if (est > maxPts * 1.6) throw new Error('About ' + fmtN(est) + ' points fall in that area. Make the clip box smaller (limit ' + fmtN(maxPts) + ').');
  const parts = []; let n = 0, k = 0;
  for (const i of sel) { const h = D.nodes[i]; const u8 = await D.store.read(D.meta.data || 'octree.bin', h.off, h.len); const N = decodeNode(D, u8); const keep = []; for (let q = 0; q < N.n; q++) { if (box) { const x = N.pos[q * 3], y = N.pos[q * 3 + 1], z = N.pos[q * 3 + 2]; if (x < box.min.x || y < box.min.y || z < box.min.z || x > box.max.x || y > box.max.y || z > box.max.z) continue; } keep.push(q); } if (keep.length) { parts.push([N, keep]); n += keep.length; } onP(++k / sel.length); if ((k & 7) === 0) await tick(); }
  return joinParts(D, parts, n);
}
async function readSample(D, target, onP = () => {}) {
  const order = []; const q = [D.rootI]; while (q.length) { const i = q.shift(); order.push(i); for (const c of D.nodes[i].kidsI) q.push(c); } order.sort((a, b) => D.nodes[a].level - D.nodes[b].level);
  const parts = []; let n = 0, k = 0; for (const i of order) { if (n >= target) break; const h = D.nodes[i]; if (!h.count) continue; const N = decodeNode(D, await D.store.read(D.meta.data || 'octree.bin', h.off, h.len)); parts.push([N, null]); n += N.n; onP(Math.min(1, n / target)); if ((++k & 7) === 0) await tick(); }
  return joinParts(D, parts, n);
}
function joinParts(D, parts, n) {
  const st = D.meta.record.stride, pos = new Float32Array(n * 3), rgb = parts[0] && parts[0][0].rgb ? new Uint8Array(n * 3) : null, it = new Float32Array(n), cls = new Uint8Array(n), raw = new Uint8Array(n * st); let j = 0; const iM = D.meta.intensityMax || 65535;
  for (const [N, keep] of parts) { const ids = keep || Array.from({ length: N.n }, (_, i) => i); for (const q of ids) { pos[j * 3] = N.pos[q * 3]; pos[j * 3 + 1] = N.pos[q * 3 + 1]; pos[j * 3 + 2] = N.pos[q * 3 + 2]; if (rgb) { rgb[j * 3] = N.rgb[q * 3]; rgb[j * 3 + 1] = N.rgb[q * 3 + 1]; rgb[j * 3 + 2] = N.rgb[q * 3 + 2]; } it[j] = N.I[q] / iM; cls[j] = N.cls[q]; raw.set(N.raw.subarray(q * st, q * st + st), j * st); j++; } }
  return { n, pos, rgb, intensity: it, cls, raw };
}
async function extractToLayer(D, mode) {
  const r = await busy(mode === 'box' ? 'Loading every point inside the clip box…' : 'Loading an even sample…', onP => mode === 'box' ? readBox(D, S.clip.box, 4e7, onP) : readSample(D, S.extractN || 5e6, onP));
  if (!r || !r.n) { if (r) toast('No points there.', true); return null; }
  const L = addCloud(D.meta.name + (mode === 'box' ? ' (clip)' : ' (sample)'), { n: r.n, pos: r.pos, rgb: r.rgb, intensity: r.intensity, cls: r.cls, origin: S.origin, meta: { format: 'From dataset ' + D.meta.name + ' (all attributes kept)', total: r.n, stride: 1 } });
  L.raw = r.raw; L.rawMeta = { stride: D.meta.record.stride, ds: D.meta }; refreshProps(); return L;
}

// ----- export: LAS with the original header fields, VLRs and EVLRs, every attribute, merged or per source, optionally clipped -----
function lasHeaderFor(meta, src, count, mn, mx, nV, vlrBytes, evlrCount, evlrStart) {
  const f = meta.record.pointFormat, rl = meta.record.length; const h = new Uint8Array(375), dv = new DataView(h.buffer);
  const o = src && src.header ? b64d(src.header) : null; if (o) h.set(o.subarray(0, Math.min(o.length, 227)));
  h.set([76, 65, 83, 70]); dv.setUint8(24, 1); dv.setUint8(25, 4); dv.setUint16(94, 375, true); dv.setUint32(96, 375 + vlrBytes, true); dv.setUint32(100, nV, true); dv.setUint8(104, f); dv.setUint16(105, rl, true);
  dv.setUint32(107, f < 6 && count < 4294967296 ? count : 0, true); for (let k = 0; k < 5; k++) dv.setUint32(111 + k * 4, 0, true);
  if (!o) { const sw = new TextEncoder().encode('ScanBench'); h.set(sw, 58); const d = new Date(); const doy = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 864e5); dv.setUint16(90, doy, true); dv.setUint16(92, d.getFullYear(), true); }
  else { const sw = new TextEncoder().encode('ScanBench (re-export)'); h.fill(0, 58, 90); h.set(sw.subarray(0, 32), 58); }
  [0, 1, 2].forEach(k => { dv.setFloat64(131 + k * 8, meta.scale[k], true); dv.setFloat64(155 + k * 8, meta.offset[k], true); }); dv.setFloat64(179, mx[0], true); dv.setFloat64(187, mn[0], true); dv.setFloat64(195, mx[1], true); dv.setFloat64(203, mn[1], true); dv.setFloat64(211, mx[2], true); dv.setFloat64(219, mn[2], true);
  dv.setBigUint64(227, 0n, true); dv.setBigUint64(235, BigInt(evlrStart || 0), true); dv.setUint32(243, evlrCount, true); dv.setBigUint64(247, BigInt(count), true); for (let k = 0; k < 15; k++) dv.setBigUint64(255 + k * 8, 0n, true);
  if (src && src.crsWKT) dv.setUint16(6, (o ? new DataView(o.buffer).getUint16(6, true) : 0) | 16, true);   // WKT flag when the CRS is in a WKT VLR
  return h;
}
async function outFile(name) {
  if (window.showSaveFilePicker) { try { const h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'LAS point cloud', accept: { 'application/octet-stream': ['.las'] } }] }); const w = await h.createWritable(); let pos = 0; return { write: async u => { await w.write(u); pos += u.length; }, seekWrite: async (p, u) => { await w.write({ type: 'write', position: p, data: u }); }, pos: () => pos, close: async () => { await w.close(); } }; } catch (e) { if (e.name === 'AbortError') return null; } }
  const root = await dsRoot(); const tmp = new DirStore(root); const w = await (await tmp.fh('_export.las', true)).createWritable(); let pos = 0;
  return { write: async u => { await w.write(u); pos += u.length; }, seekWrite: async (p, u) => { await w.write({ type: 'write', position: p, data: u }); }, pos: () => pos, close: async () => { await w.close(); const f = await tmp.file('_export.las'); if (f.size > 1.8e9) { toast('The export is ' + (f.size / 1e9).toFixed(1) + ' GB, too big to hand over from this page. Open ScanBench.html in Chrome or Edge to save large exports straight to disk.', true); return; } await saveFile(name.replace(/\.las$/i, '') + '.zip', IO.makeZip([{ name, data: new Uint8Array(await f.arrayBuffer()) }])); await tmp.remove('_export.las'); } };
}
async function exportDataset(D, opts = {}) {
  const meta = D.meta, st = meta.record.stride, rl = meta.record.length, box = opts.clip && S.clip.on ? S.clip.box : null; const per = opts.perSource; const srcIdx = per ? meta.sources.map((s, i) => i) : [-1];
  for (const si of srcIdx) {
    const src = si >= 0 ? meta.sources[si] : meta.sources[0]; const nm = (si >= 0 ? src.name.replace(/\.[^.]+$/, '') : meta.name).replace(/[^\w.-]+/g, '_') + (box ? '_clip' : '') + '.las';
    const out = await outFile(nm); if (!out) return;
    const vl = (src.vlrs || []).map(v => b64d(v.b64)); const vlrBytes = vl.reduce((a, v) => a + v.length, 0);
    await out.write(new Uint8Array(375)); for (const v of vl) await out.write(v);
    let count = 0; const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; const o = S.origin;
    const ok = await busy('Writing ' + nm + '…', async onP => { let k = 0; for (const h of meta.hierarchy) { if (!h.count) { k++; continue; } if (box) { const hb = new THREE.Box3(new THREE.Vector3(h.min[0] - o[0], h.min[1] - o[1], h.min[2] - o[2]), new THREE.Vector3(h.min[0] + h.size - o[0], h.min[1] + h.size - o[1], h.min[2] + h.size - o[2])); if (!box.intersectsBox(hb)) { k++; continue; } }
      const u = await D.store.read(meta.data || 'octree.bin', h.off, h.len), dv = new DataView(u.buffer, u.byteOffset, u.byteLength), n = u.length / st; const o2 = new Uint8Array(n * rl); let m = 0;
      for (let q = 0; q < n; q++) { const p = q * st; if (si >= 0 && dv.getUint16(p + rl, true) !== si) continue; const x = dv.getInt32(p, true) * meta.scale[0] + meta.offset[0], y = dv.getInt32(p + 4, true) * meta.scale[1] + meta.offset[1], z = dv.getInt32(p + 8, true) * meta.scale[2] + meta.offset[2];
        if (box && (x - o[0] < box.min.x || y - o[1] < box.min.y || z - o[2] < box.min.z || x - o[0] > box.max.x || y - o[1] > box.max.y || z - o[2] > box.max.z)) continue;
        o2.set(u.subarray(p, p + rl), m * rl); m++; if (x < mn[0]) mn[0] = x; if (x > mx[0]) mx[0] = x; if (y < mn[1]) mn[1] = y; if (y > mx[1]) mx[1] = y; if (z < mn[2]) mn[2] = z; if (z > mx[2]) mx[2] = z; }
      if (m) await out.write(o2.subarray(0, m * rl)); count += m; onP(++k / meta.hierarchy.length); if ((k & 15) === 0) await tick(); }
      const ev = (src.evlrs || []).map(e => b64d(e.b64)); const evStart = out.pos(); for (const e of ev) await out.write(e);
      await out.seekWrite(0, lasHeaderFor(meta, src, count, mn, mx, vl.length, vlrBytes, ev.length, ev.length ? evStart : 0)); return true; });
    await out.close(); if (ok) toast('Wrote ' + nm + ': ' + count.toLocaleString() + ' points, point format ' + meta.record.pointFormat + ', ' + vl.length + ' VLRs' + ((src.evlrs || []).length ? ' and ' + src.evlrs.length + ' EVLRs' : '') + ' from the source.');
  }
}
// working layers that came from a dataset keep every attribute: LAS export writes the original records (with any edits to position)
const _exportCloudS = exportCloud;
exportCloud = async function (L, f) {
  if (f !== 'las' || !L.raw || !L.rawMeta) return _exportCloudS(L, f);
  const meta = L.rawMeta.ds, st = L.rawMeta.stride, rl = meta.record.length, src = meta.sources[0]; const nm = L.name.replace(/[^\w.-]+/g, '_') + '.las'; const o = S.origin;
  const vl = (src.vlrs || []).map(v => b64d(v.b64)), vb = vl.reduce((a, v) => a + v.length, 0); const recs = new Uint8Array(L.n * rl), dv = new DataView(recs.buffer); const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < L.n; i++) { recs.set(L.raw.subarray(i * st, i * st + rl), i * rl); const w = [L.pos[i * 3] + o[0], L.pos[i * 3 + 1] + o[1], L.pos[i * 3 + 2] + o[2]]; for (let k = 0; k < 3; k++) { dv.setInt32(i * rl + k * 4, Math.round((w[k] - meta.offset[k]) / meta.scale[k]), true); if (w[k] < mn[k]) mn[k] = w[k]; if (w[k] > mx[k]) mx[k] = w[k]; } if (L.cls) dv.setUint8(i * rl + clsOff(meta.record.pointFormat), meta.record.pointFormat >= 6 ? L.cls[i] : (dv.getUint8(i * rl + 15) & 0xe0) | (L.cls[i] & 31)); }
  const ev = (src.evlrs || []).map(e => b64d(e.b64)), evB = ev.reduce((a, e) => a + e.length, 0); const total = 375 + vb + recs.length + evB; const all = new Uint8Array(total);
  all.set(lasHeaderFor(meta, src, L.n, mn, mx, vl.length, vb, ev.length, ev.length ? 375 + vb + recs.length : 0)); let p = 375; for (const v of vl) { all.set(v, p); p += v.length; } all.set(recs, p); p += recs.length; for (const e of ev) { all.set(e, p); p += e.length; }
  await saveFile(nm, all); toast('Exported ' + L.n.toLocaleString() + ' points with their original attributes and the source VLRs.');
};

// ----- datasets panel -----
async function listLocalDatasets() { const out = []; try { const root = await dsRoot(); for await (const [nm, h] of root.entries()) { if (h.kind !== 'directory') continue; try { const st = new DirStore(h); const meta = JSON.parse(await st.text('metadata.json')); let size = 0; try { size = (await st.file('octree.bin')).size; } catch (e) { } out.push({ st, meta, size }); } catch (e) { out.push({ broken: nm }); } } } catch (e) { } return out; }
async function buildDatasets() {
  let host = $('#dsSec'); if (!host) { host = el('div', { class: 'sec', id: 'dsSec' }); const lay = $('#layers'); if (!lay) return; lay.closest('.sec').after(host); }
  const fin = el('input', { type: 'file', multiple: true, hidden: true, accept: '.las,.laz,.e57,.ply,.xyz,.txt,.csv,.pts' }); fin.addEventListener('change', () => { const fs = [...fin.files]; fin.value = ''; if (fs.length) importDataset(fs); });
  const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate().catch(() => null) : null;
  host.textContent = ''; host.append(el('h3', {}, 'Datasets'), el('div', { class: 'note' }, 'For clouds of any size. Files are converted once into an octree on this computer (browser storage), then streamed into view at the point budget. Every source header, VLR and point attribute is kept, so you can export them again. The same dataset folder can later be served from cloud storage.'),
    el('div', { class: 'row' }, el('label', { class: 'btn small primary' }, 'Import files as dataset…', fin), window.showDirectoryPicker ? el('button', { class: 'btn small', onclick: openFolderDataset }, 'Open dataset folder…') : null, el('button', { class: 'btn small', onclick: openUrlDataset }, 'Open from URL…')), el('input', { type: 'url', id: 'dsUrl', hidden: true, placeholder: 'https://…/dataset-folder/ then press Enter', 'aria-label': 'Dataset folder URL', onkeydown: e => { if (e.key === 'Enter') openUrlDataset(); } }),
    est ? el('div', { class: 'hint' }, 'Local storage: ' + (est.usage / 1e9).toFixed(2) + ' GB used of ' + (est.quota / 1e9).toFixed(0) + ' GB available to this page.') : null);
  if (DS.job) host.append(el('button', { class: 'btn small danger', onclick: () => { DS.job.stop = true; } }, 'Cancel import'));
  const list = el('div', { class: 'mlist' }); const items = await listLocalDatasets();
  if (!items.length) list.append(el('div', { class: 'empty' }, 'No datasets yet. Import LAS, LAZ, E57, PLY or XYZ files: one huge file or thousands of tiles become one dataset.'));
  for (const it of items) { if (it.broken) { list.append(el('div', { class: 'mitem', style: 'grid-template-columns:minmax(0,1fr) auto' }, el('div', { class: 'v' }, 'Unfinished import ' + it.broken), el('button', { class: 'btn small icon danger', 'aria-label': 'Delete', onclick: async () => { await (await dsRoot()).removeEntry(it.broken, { recursive: true }); buildDatasets(); } }, '×'))); continue; }
    const D = S.streams.find(x => x.meta.id === it.meta.id); const m = it.meta;
    list.append(el('div', { class: 'mitem', style: 'grid-template-columns:minmax(0,1fr)' + (S.selStream === D && D ? ';outline:2px solid var(--accent)' : '') }, el('div', {}, el('div', { class: 't' }, m.name), el('div', { class: 'v' }, fmtN(m.points) + ' pts · ' + m.sources.length + ' source' + (m.sources.length > 1 ? 's' : '') + ' · format ' + m.record.pointFormat + ' · ' + (it.size / 1e9).toFixed(2) + ' GB'),
      el('div', { class: 'row', style: 'margin-top:4px' }, D ? el('button', { class: 'btn small', onclick: () => closeDataset(D) }, 'Close') : el('button', { class: 'btn small primary', onclick: () => openDataset(it.st, m).then(d => d && fitBox(d.box)) }, 'Open'),
        D ? el('button', { class: 'btn small', onclick: () => fitBox(D.box) }, 'Zoom') : null,
        D ? el('select', { 'aria-label': 'Colour by', style: 'width:auto', onchange: e => { D.colorMode = e.target.value; for (const [, N] of D.loaded) colorNode(D, N); S.dirty = true; } }, ...[['rgb', 'RGB'], ['intensity', 'Intensity'], ['class', 'Class'], ['elevation', 'Elevation']].map(([v, t]) => el('option', { value: v, selected: D.colorMode === v }, t))) : null),
      D ? el('div', { class: 'row', style: 'margin-top:4px' }, el('button', { class: 'btn small', disabled: !S.clip.on, title: 'Every point inside the clipping box, with all attributes', onclick: () => extractToLayer(D, 'box') }, 'Clip box → layer'), el('button', { class: 'btn small', onclick: () => extractToLayer(D, 'sample') }, 'Sample → layer'),
        el('button', { class: 'btn small', onclick: () => exportDataset(D, { clip: S.clip.on }) }, S.clip.on ? 'Export clip (LAS)' : 'Export LAS'), m.sources.length > 1 ? el('button', { class: 'btn small', onclick: () => exportDataset(D, { perSource: true, clip: S.clip.on }) }, 'Export per source') : null) : null,
      el('details', {}, el('summary', { class: 'hint', style: 'cursor:pointer' }, 'Source metadata'), el('div', { class: 'mono hint', style: 'white-space:pre-wrap;font-size:10.5px;max-height:200px;overflow:auto' }, m.sources.map(s => s.name + '\n  ' + (s.kind || '') + ' ' + (s.version || '') + (s.compressed ? ' (LAZ)' : '') + ' · PF ' + (s.pointFormat ?? '-') + ' · ' + (s.points || 0).toLocaleString() + ' pts' + (s.scale ? '\n  scale ' + s.scale.join(' ') + ' · offset ' + s.offset.join(' ') : '') + ((s.vlrs || []).length ? '\n  VLRs: ' + s.vlrs.map(v => v.uid + ' ' + v.rid + (v.desc ? ' (' + v.desc + ')' : '')).join('; ') : '') + ((s.evlrs || []).length ? '\n  EVLRs: ' + s.evlrs.map(v => v.uid + ' ' + v.rid).join('; ') : '') + (s.crsWKT ? '\n  CRS: ' + s.crsWKT.slice(0, 120) + '…' : '')).join('\n'))),
      el('div', { class: 'row', style: 'margin-top:4px' }, el('button', { class: 'btn small danger', onclick: async () => { if (D) closeDataset(D); await (await dsRoot()).removeEntry(m.id, { recursive: true }); buildDatasets(); toast('Deleted dataset ' + m.name + '.'); } }, 'Delete')))));
  }
  for (const D of S.streams.filter(D => !(D.store instanceof DirStore) || !items.some(i => i.meta.id === D.meta.id))) list.append(el('div', { class: 'mitem', style: 'grid-template-columns:minmax(0,1fr) auto' }, el('div', {}, el('div', { class: 't' }, D.meta.name), el('div', { class: 'v' }, fmtN(D.meta.points) + ' pts · ' + D.store.label)), el('span', { class: 'row', style: 'gap:4px' }, el('button', { class: 'btn small', onclick: () => extractToLayer(D, S.clip.on ? 'box' : 'sample') }, '→ layer'), el('button', { class: 'btn small', onclick: () => closeDataset(D) }, 'Close'))));
  host.append(list);
}
async function openFolderDataset() { try { const h = await window.showDirectoryPicker({ mode: 'read' }); const st = new DirStore(h, h.name); await openDataset(st); } catch (e) { if (e.name !== 'AbortError') toast('Could not open that folder as a dataset: ' + e.message, true); } }
async function openUrlDataset() { const i = $('#dsUrl'); if (!i) return; if (i.hidden) { i.hidden = false; i.focus(); return; } const u = i.value.trim(); if (!u) return; try { await openDataset(new HttpStore(u)); } catch (e) { toast('Could not open ' + u + ': ' + e.message, true); } }
setTimeout(() => { buildDatasets(); }, 50);
