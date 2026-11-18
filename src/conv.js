// ===== ScanBench LOD converter for the browser =====
// Converts E57, LAS and LAZ files of any size into a ScanBench LOD project (dataset.json, hierarchy.bin,
// octree.bin, project.json), written straight into a folder the user picks (Chrome/Edge). The same format and
// method as the scanlod program: two parallel read passes in Web Workers, out-of-core chunks, grid-sampled
// tiles, paged hierarchy. Needs the page to carry laz-perf (script#src-laz), its wasm (window.LAZ_WASM_B64)
// and the I/O library (script#src-io).
const SBConv = (() => {
  const REC = 40;
  const fmtN = n => n >= 1e9 ? (n / 1e9).toFixed(2) + ' B' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' M' : n >= 1e3 ? (n / 1e3).toFixed(1) + ' k' : String(n);
  const fmtT = s => s >= 3600 ? Math.floor(s / 3600) + 'h' + String(Math.floor(s % 3600 / 60)).padStart(2, '0') + 'm' : s >= 60 ? Math.floor(s / 60) + 'm' + String(Math.floor(s % 60)).padStart(2, '0') + 's' : Math.round(s) + 's';
  const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const cstr = u8 => { const e = u8.indexOf(0); return new TextDecoder().decode(e < 0 ? u8 : u8.subarray(0, e)).trim(); };
  const pow2 = v => { let p = 1; while (p < v) p *= 2; return p; };
  // common Australian systems (plus WGS 84): id matches ScanBench's coordinate list
  const tmWkt = (name, gcs, datum, sph, lon0, k0, fe, fn, epsg) => 'PROJCS["' + name + '",GEOGCS["' + gcs + '",DATUM["' + datum + '",SPHEROID[' + sph + ']],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",' + lon0 + '],PARAMETER["scale_factor",' + k0 + '],PARAMETER["false_easting",' + fe + '],PARAMETER["false_northing",' + fn + '],UNIT["metre",1]' + (epsg ? ',AUTHORITY["EPSG","' + epsg + '"]' : '') + ']';
  const GRS = '"GRS 1980",6378137,298.257222101', WGS = '"WGS 84",6378137,298.257223563', G20 = ['GDA2020', 'Geocentric_Datum_of_Australia_2020'], G94 = ['GDA94', 'Geocentric_Datum_of_Australia_1994'];
  const CRS = [];
  for (let z = 49; z <= 52; z++) CRS.push({ group: 'mga2020', id: 'MGA2020-' + z, name: 'GDA2020 / MGA zone ' + z, epsg: 7800 + z, wkt: tmWkt('GDA2020 / MGA zone ' + z, ...G20, GRS, 6 * z - 183, 0.9996, 500000, 10000000, 7800 + z) });
  for (let z = 49; z <= 52; z++) CRS.push({ group: 'mga94', id: 'MGA94-' + z, name: 'GDA94 / MGA zone ' + z, epsg: 28300 + z, wkt: tmWkt('GDA94 / MGA zone ' + z, ...G94, GRS, 6 * z - 183, 0.9996, 500000, 10000000, 28300 + z) });
  const pcgLon = 115 + 49 / 60;
  CRS.push({ group: 'pcg', id: 'PCG2020', name: 'PCG2020 (Perth Coastal Grid, GDA2020)', epsg: 8031, wkt: tmWkt('GDA2020 / PCG2020', ...G20, GRS, pcgLon, 0.99999906, 50000, 3900000, 8031) });
  CRS.push({ group: 'pcg', id: 'PCG94', name: 'PCG94 (Perth Coastal Grid, GDA94)', epsg: 10464, wkt: tmWkt('GDA94 / PCG94', ...G94, GRS, pcgLon, 0.99999906, 50000, 3800000, 10464) });
  for (let z = 49; z <= 52; z++) CRS.push({ group: 'wgs84', id: 'UTM' + z + 'S', name: 'WGS 84 / UTM zone ' + z + 'S', epsg: 32700 + z, wkt: tmWkt('WGS 84 / UTM zone ' + z + 'S', 'WGS 84', 'WGS_1984', WGS, 6 * z - 183, 0.9996, 500000, 10000000, 32700 + z) });
  CRS.push({ group: 'wgs84', id: 'WGS84', name: 'WGS 84 (latitude, longitude)', epsg: 4326, wkt: 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID[' + WGS + ']],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4326"]]' });
  const VERT = [{ id: '', name: 'As in the scans / not stated' }, { id: 'ellipsoid', name: 'Ellipsoidal heights', datum: 'ellipsoid' },
    { id: 'AHD-2020', name: 'AHD, from AUSGeoid2020', datum: 'AHD', geoid: 'AUSGeoid2020', epsg: 5711 }, { id: 'AHD-09', name: 'AHD, from AUSGeoid09', datum: 'AHD', geoid: 'AUSGeoid09', epsg: 5711 }, { id: 'AHD', name: 'AHD (geoid not known)', datum: 'AHD', epsg: 5711 }];
  const supported = () => !!(window.showDirectoryPicker && window.Worker && window.CompressionStream);

  // ---------------- the worker (runs with laz-perf and the I/O library loaded) ----------------
  function workerMain() {
    const REC = 40; let LAZ = null, LUT = null, wasm = null, ackP = null;
    const getLaz = async () => { if (!LAZ) LAZ = await createLazPerf({ wasmBinary: wasm, locateFile: x => x }); return LAZ; };
    const fit = (v, st) => { if (v < 0 || v > 2147483647) { st.outside++; return v < 0 ? 0 : 2147483647; } return v; };
    // one source's points → 40-byte records on the dataset grid, in batches
    async function readUnit(m, cb) {
      const s = m.src, u = m.unit, g = m.grid, st = { outside: 0, skipped: 0 }; const batch = 1 << 18;
      if (s.kind === 'las') {
        const pf = s.fmt, rl = s.rl, ex = [0, 1, 2].map(k => { const d = (s.offset[k] - g.offset[k]) / g.scale[k]; return Math.abs(s.scale[k] - g.scale[k]) < 1e-12 && Math.abs(d - Math.round(d)) < 1e-6 ? Math.round(d) : null; });
        const conv = (raw, n) => { const out = new ArrayBuffer(n * REC), dv = new DataView(out), di = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
          for (let i = 0; i < n; i++) { const p = i * rl, q = i * REC;
            for (let k = 0; k < 3; k++) { const xi = di.getInt32(p + k * 4, true); dv.setInt32(q + 8 + k * 4, fit(ex[k] !== null ? xi + ex[k] : Math.round((xi * s.scale[k] + s.offset[k] - g.offset[k]) / g.scale[k]), st), true); }
            dv.setUint16(q + 20, di.getUint16(p + 12, true), true); dv.setUint16(q + 32, m.si, true);
            if (pf < 6) { const a = di.getUint8(p + 14), c = di.getUint8(p + 15); dv.setUint8(q + 35, a & 7); dv.setUint8(q + 36, (a >> 3) & 7); dv.setUint8(q + 37, ((a >> 6) & 1) << 4 | ((a >> 7) & 1) << 5 | ((c >> 5) & 7)); dv.setUint8(q + 34, c & 31); dv.setInt16(q + 30, Math.round(di.getInt8(p + 16) / 0.006), true); dv.setUint8(q + 38, di.getUint8(p + 17)); dv.setUint16(q + 28, di.getUint16(p + 18, true), true);
              let o = 20; if (pf === 1 || pf === 3 || pf === 4 || pf === 5) { dv.setFloat64(q, di.getFloat64(p + 20, true), true); o = 28; } if (pf === 2 || pf === 3 || pf === 5) { dv.setUint16(q + 22, di.getUint16(p + o, true), true); dv.setUint16(q + 24, di.getUint16(p + o + 2, true), true); dv.setUint16(q + 26, di.getUint16(p + o + 4, true), true); } }
            else { const a = di.getUint8(p + 14), c = di.getUint8(p + 15); dv.setUint8(q + 35, a & 15); dv.setUint8(q + 36, a >> 4); dv.setUint8(q + 37, (c & 15) | ((c >> 6) & 1) << 4 | ((c >> 7) & 1) << 5); dv.setUint8(q + 39, (c >> 4) & 3); dv.setUint8(q + 34, di.getUint8(p + 16)); dv.setUint8(q + 38, di.getUint8(p + 17)); dv.setInt16(q + 30, di.getInt16(p + 18, true), true); dv.setUint16(q + 28, di.getUint16(p + 20, true), true); dv.setFloat64(q, di.getFloat64(p + 22, true), true);
              if (pf === 7 || pf === 8 || pf === 10) { dv.setUint16(q + 22, di.getUint16(p + 30, true), true); dv.setUint16(q + 24, di.getUint16(p + 32, true), true); dv.setUint16(q + 26, di.getUint16(p + 34, true), true); } } }
          return out; };
        if (!s.laz) { for (let a = u.start; a < u.start + u.count; a += batch) { const n = Math.min(batch, u.start + u.count - a); const raw = new Uint8Array(await m.file.slice(s.po + a * rl, s.po + (a + n) * rl).arrayBuffer()); await cb(conv(raw, n), n); } }
        else { const L = await getLaz(), pp = L._malloc(rl + 64); let off = u.byteOff;
          try { for (let c = 0; c < u.sizes.length; ) { let c1 = c, bytes = 0, pts = 0; while (c1 < u.sizes.length && (c1 === c || (bytes + u.sizes[c1] < 16e6 && pts + u.counts[c1] <= batch * 2))) { bytes += u.sizes[c1]; pts += u.counts[c1]; c1++; }
              const buf = new Uint8Array(await m.file.slice(off, off + bytes).arrayBuffer()); const cp = L._malloc(bytes); L.HEAPU8.set(buf, cp); const raw = new Uint8Array(pts * rl); let o = 0, q = cp;
              try { for (let k = c; k < c1; k++) { const cd = new L.ChunkDecoder(); cd.open(pf, rl, q); for (let i = 0; i < u.counts[k]; i++) { cd.getPoint(pp); raw.set(L.HEAPU8.subarray(pp, pp + rl), o); o += rl; } cd.delete(); q += u.sizes[k]; } } finally { L._free(cp); }
              await cb(conv(raw, pts), pts); off += bytes; c = c1; } } finally { L._free(pp); } }
      } else { // E57 scan, streamed through a moving window
        const f = new E57File(fileSource(m.file)); await f.init(); const sc = f.scans()[s.scan], pts = xChild(sc, 'points'), count = Number(pts.attrs.recordCount || 0); const proto = xChild(pts, 'prototype'), fields = proto.children; const has = k => fields.some(c => c.tag === k);
        const cart = has('cartesianX'), want = cart ? ['cartesianX', 'cartesianY', 'cartesianZ'] : ['sphericalRange', 'sphericalAzimuth', 'sphericalElevation']; if (!want.every(has)) return st;
        const W = 1 << 21; const extra = ['intensity', 'colorRed', 'colorGreen', 'colorBlue', cart ? 'cartesianInvalidState' : 'sphericalInvalidState']; const cols = {}, decs = [];
        fields.forEach((fp, i) => { if (want.includes(fp.tag) || extra.includes(fp.tag)) { cols[fp.tag] = new Float64Array(W * 2); decs[i] = new StreamDecoder(fp, count, 1, cols[fp.tag]); decs[i].ob = 0; } else decs[i] = null; });
        const active = decs.filter(Boolean); const R = s.R, T = s.T, iMin = s.iMin, iMax = s.iMax, cMin = s.cMin, cMax = s.cMax; let base = 0;
        const flush = async upto => { const n = upto - base; if (n <= 0) return; const out = new ArrayBuffer(n * REC), dv = new DataView(out); let k = 0; const X = cols[want[0]], Y = cols[want[1]], Z = cols[want[2]], I = cols.intensity, inv = cols.cartesianInvalidState || cols.sphericalInvalidState;
          for (let i = 0; i < n; i++) { if (inv && inv[i] !== 0) { st.skipped++; continue; } let x, y, z; if (cart) { x = X[i]; y = Y[i]; z = Z[i]; } else { const r = X[i], az = Y[i], el = Z[i]; if (r === 0) { st.skipped++; continue; } x = r * Math.cos(el) * Math.cos(az); y = r * Math.cos(el) * Math.sin(az); z = r * Math.sin(el); }
            const wx = R[0] * x + R[1] * y + R[2] * z + T[0], wy = R[3] * x + R[4] * y + R[5] * z + T[1], wz = R[6] * x + R[7] * y + R[8] * z + T[2], q = k * REC;
            dv.setInt32(q + 8, fit(Math.round((wx - g.offset[0]) / g.scale[0]), st), true); dv.setInt32(q + 12, fit(Math.round((wy - g.offset[1]) / g.scale[1]), st), true); dv.setInt32(q + 16, fit(Math.round((wz - g.offset[2]) / g.scale[2]), st), true);
            if (I) dv.setUint16(q + 20, Math.max(0, Math.min(65535, Math.round((I[i] - iMin) / ((iMax - iMin) || 1) * 65535))), true);
            if (cols.colorRed) ['colorRed', 'colorGreen', 'colorBlue'].forEach((c, j) => dv.setUint16(q + 22 + j * 2, Math.max(0, Math.min(65535, Math.round((cols[c][i] - cMin[j]) / ((cMax[j] - cMin[j]) || 1) * 65535))), true));
            dv.setUint16(q + 32, m.si, true); dv.setUint8(q + 35, 1); dv.setUint8(q + 36, 1); k++; }
          if (k) await cb(k === n ? out : out.slice(0, k * REC), k);
          // slide the window
          const lead = Math.max(...active.map(d => d.idx)) - upto; for (const nm in cols) cols[nm].copyWithin(0, n, n + Math.max(0, lead)); base = upto; for (const d of active) d.ob = base; };
        const fileOff = Number(pts.attrs.fileOffset); const sh = await f.readLogical(fileOff, 32), sdv = new DataView(sh.buffer, sh.byteOffset, 32); const secLen = Number(sdv.getBigUint64(8, true)), dataPhys = Number(sdv.getBigUint64(16, true)); const secEnd = f.toLogical(fileOff) + secLen; const stream = new LogicalStream(f, dataPhys); let logPos = f.toLogical(dataPhys);
        while (active.some(d => !d.done()) && logPos < secEnd) { const hdr = await stream.take(4); const plen = (hdr[2] | (hdr[3] << 8)) + 1; const body = await stream.take(plen - 4); logPos += plen; if (hdr[0] !== 1) continue; const bv = new DataView(body.buffer, body.byteOffset, body.length); const nbs = bv.getUint16(0, true); let off = 2 + nbs * 2;
          for (let k = 0; k < nbs; k++) { const L = bv.getUint16(2 + k * 2, true); if (decs[k] && L) decs[k].feed(body.subarray(off, off + L)); off += L; }
          const lo = Math.min(...active.map(d => d.idx)); if (lo - base >= W) await flush(lo); }
        await flush(Math.min(...active.map(d => d.idx)));
      }
      return st;
    }
    // ---- tiles ----
    const nodeCube = (name, cu) => { let mn = [0, 0, 0], s = cu; for (let i = 1; i < name.length; i++) { s /= 2; const d = name.charCodeAt(i) - 48; mn[0] += (d & 1) * s; mn[1] += ((d >> 1) & 1) * s; mn[2] += ((d >> 2) & 1) * s; } return [mn, s]; };
    const ATTRS = [['intensity', 'u16', 20, 1], ['rgb', 'u16', 22, 3], ['classification', 'u8', 34, 1], ['return_number', 'u8', 35, 1], ['number_of_returns', 'u8', 36, 1], ['flags', 'u8', 37, 1], ['scanner_channel', 'u8', 39, 1], ['user_data', 'u8', 38, 1], ['scan_angle', 'i16', 30, 1], ['point_source_id', 'u16', 28, 1], ['gps_time', 'f64', 0, 1], ['source', 'u16', 32, 1]];
    const SZ = { u8: 1, u16: 2, i16: 2, f64: 8 };
    const PROF = { sample: 0, enc: 0, gz: 0, split: 0 };
    async function gz(u8) { const t = performance.now(); try { return await gz0(u8); } finally { PROF.gz += performance.now() - t; } }
    async function gz0(u8) { if (self.fflate) return fflate.gzipSync(u8, { level: 2, mem: 4 }); const s = new Blob([u8]).stream().pipeThrough(new CompressionStream('gzip')); return new Uint8Array(await new Response(s).arrayBuffer()); }
    // typed views over 40-byte records (buffers always start at 0, so every view is aligned)
    const views = buf => ({ i32: new Int32Array(buf), u16: new Uint16Array(buf), i16: new Int16Array(buf), u8: new Uint8Array(buf), f64: new Float64Array(buf) });
    const COL = { intensity: ['u16', [10]], rgb: ['u16', [11, 12, 13]], classification: ['u8', [34]], return_number: ['u8', [35]], number_of_returns: ['u8', [36]], flags: ['u8', [37]], scanner_channel: ['u8', [39]], user_data: ['u8', [38]], scan_angle: ['i16', [15]], point_source_id: ['u16', [14]], gps_time: ['f64', [0]], source: ['u16', [16]] };
    const PER = { u16: 20, i16: 20, u8: 40, f64: 5 }, CT = { u16: Uint16Array, i16: Int16Array, u8: Uint8Array, f64: Float64Array };
    async function encode(V, idx, min, units, attrs, comp) { // idx: Uint32Array of record indices
      const T0 = performance.now(); const n = idx.length, i32 = V.i32; const sh = 2 ** Math.max(0, Math.log2(units) - 10);
      // Morton order (10 bits per axis) via a two-pass radix sort, so neighbours sit together and compress better
      const key = new Uint32Array(n); for (let k = 0; k < n; k++) { const p = idx[k] * 10; const x = Math.min(1023, ((i32[p + 2] - min[0]) / sh) | 0), y = Math.min(1023, ((i32[p + 3] - min[1]) / sh) | 0), z = Math.min(1023, ((i32[p + 4] - min[2]) / sh) | 0); let m = 0; for (let b = 0; b < 10; b++) m |= ((x >> b) & 1) << (3 * b) | ((y >> b) & 1) << (3 * b + 1) | ((z >> b) & 1) << (3 * b + 2); key[k] = m >>> 0; }
      let a = new Uint32Array(n); for (let k = 0; k < n; k++) a[k] = k; let t = new Uint32Array(n); for (const shf of [0, 15]) { const cnt = new Uint32Array(32769); for (let k = 0; k < n; k++) cnt[((key[a[k]] >>> shf) & 0x7fff) + 1]++; for (let k = 1; k < 32769; k++) cnt[k] += cnt[k - 1]; for (let k = 0; k < n; k++) t[cnt[(key[a[k]] >>> shf) & 0x7fff]++] = a[k]; const sw = a; a = t; t = sw; }
      const ord = new Uint32Array(n); for (let k = 0; k < n; k++) ord[k] = idx[a[k]];
      const parts = []; for (let k3 = 0; k3 < 3; k3++) { const c = new Uint32Array(n), mn = min[k3]; for (let k = 0; k < n; k++) c[k] = i32[ord[k] * 10 + 2 + k3] - mn; parts.push(c); }
      for (const nm of ['intensity', 'rgb', 'classification', 'return_number', 'number_of_returns', 'flags', 'scanner_channel', 'user_data', 'scan_angle', 'point_source_id', 'gps_time', 'source']) { if (!attrs[nm]) continue; const [ty, offs] = COL[nm], src = V[ty], per = PER[ty], C = CT[ty];
        for (const o of offs) { const c = new C(n); for (let k = 0; k < n; k++) c[k] = src[ord[k] * per + o]; parts.push(c); } }
      let len = 0; for (const c of parts) len += c.byteLength; const out = new Uint8Array(len); let o = 0; for (const c of parts) { out.set(new Uint8Array(c.buffer, 0, c.byteLength), o); o += c.byteLength; }
      PROF.enc += performance.now() - T0;
      return comp && n ? await gz(out) : out;
    }
    function sample(i32, idx, min, units, G, bitsArr) { // first point in each of G³ cells stays; the rest go to the children
      const gl = Math.log2(G), ul = Math.log2(units), sh = ul >= gl ? ul - gl : 0, gg = ul >= gl ? G : Math.max(1, units), d = 2 ** sh; const cells = gg * gg * gg; const bitsA = bitsArr.length >= (cells + 31) >> 5 ? bitsArr : new Uint32Array((cells + 31) >> 5); bitsA.fill(0, 0, (cells + 31) >> 5);
      const keep = new Uint32Array(idx.length), rest = new Uint32Array(idx.length); let nk = 0, nr = 0;
      for (let q = 0; q < idx.length; q++) { const i = idx[q], p = i * 10; const cx = Math.min(gg - 1, Math.floor((i32[p + 2] - min[0]) / d)), cy = Math.min(gg - 1, Math.floor((i32[p + 3] - min[1]) / d)), cz = Math.min(gg - 1, Math.floor((i32[p + 4] - min[2]) / d)); const c = (cx * gg + cy) * gg + cz; const w = c >> 5, b = 1 << (c & 31); if (bitsA[w] & b) rest[nr++] = i; else { bitsA[w] |= b; keep[nk++] = i; } }
      return [keep.subarray(0, nk), rest.subarray(0, nr), bitsA];
    }
    async function indexChunk(m) {
      const u8 = new Uint8Array(m.buf), V = views(m.buf), i32 = V.i32, n = u8.length / REC; const idx = new Uint32Array(n); for (let i = 0; i < n; i++) idx[i] = i;
      let s = 0x9e3779b9 ^ m.seed; for (let i = n - 1; i > 0; i--) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; const j = (s >>> 0) % (i + 1); const t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
      const nodes = [], tr = []; let held = null, bits = new Uint32Array(1); const [min0, u0] = nodeCube(m.name, m.cube); const stack = [[m.name, min0, u0, idx]];
      while (stack.length) { const [name, min, units, ix] = stack.pop(); let keep, rest; if (ix.length <= m.nodePoints || units <= 1 || name.length > 40) { keep = ix; rest = []; } else [keep, rest, bits] = sample(i32, ix, min, units, m.sampleGrid, bits);
        if (name === m.name && !m.isRoot) { const h = new Uint8Array(keep.length * REC); keep.forEach((i, k) => h.set(u8.subarray(i * REC, i * REC + REC), k * REC)); held = h.buffer; }
        else { const blob = await encode(V, keep instanceof Uint32Array ? keep : Uint32Array.from(keep), min, units, m.attrs, m.comp); nodes.push({ name, count: keep.length, blob: blob.buffer }); tr.push(blob.buffer); }
        if (rest.length) { const h = units / 2, cnt = new Uint32Array(8), dd = new Uint8Array(rest.length); for (let q = 0; q < rest.length; q++) { const p = rest[q] * 10; const d = (i32[p + 2] - min[0] >= h ? 1 : 0) | (i32[p + 3] - min[1] >= h ? 2 : 0) | (i32[p + 4] - min[2] >= h ? 4 : 0); dd[q] = d; cnt[d]++; }
          const kids = Array.from(cnt, c => new Uint32Array(c)), at = new Uint32Array(8); for (let q = 0; q < rest.length; q++) kids[dd[q]][at[dd[q]]++] = rest[q];
          kids.forEach((k, d) => { if (k.length) stack.push([name + d, [min[0] + (d & 1) * h, min[1] + ((d >> 1) & 1) * h, min[2] + ((d >> 2) & 1) * h], h, k]); }); } }
      if (held) tr.push(held); return [{ nodes, held, prof: Object.assign({}, PROF) }, tr];
    }
    async function upper(m) { // a node above the chunks: its points come up from its children
      const [min, units] = nodeCube(m.name, m.cube); const gl = Math.log2(m.sampleGrid), ul = Math.log2(units), sh = ul >= gl ? ul - gl : 0, gg = ul >= gl ? m.sampleGrid : units, d = 2 ** sh; const bitsA = new Uint32Array((gg * gg * gg + 31) >> 5);
      const acc = [], nodes = [], tr = [];
      for (const kd of m.kids) { const u8 = new Uint8Array(kd.buf), V = views(kd.buf), i32 = V.i32, n = u8.length / REC, rest = [];
        for (let i = 0; i < n; i++) { const p = i * 10; const cx = Math.min(gg - 1, Math.floor((i32[p + 2] - min[0]) / d)), cy = Math.min(gg - 1, Math.floor((i32[p + 3] - min[1]) / d)), cz = Math.min(gg - 1, Math.floor((i32[p + 4] - min[2]) / d)); const c = (cx * gg + cy) * gg + cz; const w = c >> 5, b = 1 << (c & 31); if (bitsA[w] & b) rest.push(i); else { bitsA[w] |= b; acc.push(u8.subarray(i * REC, i * REC + REC)); } }
        const [km, ku] = nodeCube(kd.name, m.cube); const blob = await encode(V, Uint32Array.from(rest), km, ku, m.attrs, m.comp); nodes.push({ name: kd.name, count: rest.length, blob: blob.buffer }); tr.push(blob.buffer); }
      const h = new Uint8Array(acc.length * REC); acc.forEach((r, k) => h.set(r, k * REC));
      if (m.name === 'r') { const blob = await encode(views(h.buffer), Uint32Array.from(acc.keys()), min, units, m.attrs, m.comp); nodes.push({ name: 'r', count: acc.length, blob: blob.buffer }); tr.push(blob.buffer); return [{ nodes, held: null }, tr]; }
      tr.push(h.buffer); return [{ nodes, held: h.buffer }, tr];
    }
    self.onmessage = async e => {
      const m = e.data;
      if (m.op === 'ack') { const a = ackP; ackP = null; a && a(); return; }
      try {
        if (m.op === 'init') { wasm = m.wasm; self.postMessage({ id: m.id, r: true }); return; }
        if (m.op === 'lut') { LUT = m.lut; self.postMessage({ id: m.id, r: true }); return; }
        if (m.op === 'count') {
          const G = m.G, sh = m.shift, cnt = new Uint32Array(G * G * G); let n = 0, used = 0, h1 = 0, h2 = 0; const t = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
          const st = await readUnit(m, async (buf, k) => { const V = views(buf), i32 = V.i32, u16 = V.u16, u8 = V.u8, f64 = V.f64, dsh = 2 ** sh; for (let i = 0; i < k; i++) { const q = i * 10, x = i32[q + 2], y = i32[q + 3], z = i32[q + 4], q16 = i * 20, q8 = i * 40;
              cnt[(Math.floor(x / dsh) * G + Math.floor(y / dsh)) * G + Math.floor(z / dsh)]++; if (x < t[0]) t[0] = x; if (y < t[1]) t[1] = y; if (z < t[2]) t[2] = z; if (x > t[3]) t[3] = x; if (y > t[4]) t[4] = y; if (z > t[5]) t[5] = z;
              const I = u16[q16 + 10], r = u16[q16 + 11] | u16[q16 + 12] | u16[q16 + 13], c = u8[q8 + 34], rr = u8[q8 + 35] | u8[q8 + 36], fl = u8[q8 + 37], ch = u8[q8 + 39], us = u8[q8 + 38], an = u16[q16 + 15], ps = u16[q16 + 14], gp = f64[i * 5];
              used |= (I ? 1 : 0) | (r ? 2 : 0) | (c ? 4 : 0) | (rr ? 8 : 0) | (fl ? 16 : 0) | (ch ? 32 : 0) | (us ? 64 : 0) | (an ? 128 : 0) | (ps ? 256 : 0) | (gp ? 512 : 0);
              h1 = (h1 + Math.imul(x ^ Math.imul(y, 0x9e3779b1) ^ Math.imul(z, 0x85ebca77), 0xc2b2ae3d)) | 0; h2 = (h2 + Math.imul(I ^ (r << 16) ^ (c << 8) ^ rr ^ (ps << 4), 0x27d4eb2f)) | 0; } n += k; self.postMessage({ id: m.id, progress: k }); });
          self.postMessage({ id: m.id, r: { cnt, n, used, t, h1: h1 >>> 0, h2: h2 >>> 0, outside: st.outside, skipped: st.skipped } }, [cnt.buffer]); return; }
        if (m.op === 'dist') {
          const G = m.G, sh = m.shift;
          await readUnit(m, async (buf, k) => { const i32 = new Int32Array(buf), ids = new Int32Array(k), dsh = 2 ** sh; for (let i = 0; i < k; i++) { const q = i * 10; ids[i] = LUT[(Math.floor(i32[q + 2] / dsh) * G + Math.floor(i32[q + 3] / dsh)) * G + Math.floor(i32[q + 4] / dsh)]; }
            // counting sort by chunk
            const keys = new Map(); for (let i = 0; i < k; i++) keys.set(ids[i], (keys.get(ids[i]) || 0) + 1); const gid = [...keys.keys()].sort((a, b) => a - b), st = [], pos = new Map(); let acc = 0; for (const g of gid) { st.push(acc); pos.set(g, acc); acc += keys.get(g); } st.push(k);
            const out = new Float64Array(k * 5), src = new Float64Array(buf); for (let i = 0; i < k; i++) { const j = pos.get(ids[i]); pos.set(ids[i], j + 1); out.set(src.subarray(i * 5, i * 5 + 5), j * 5); }
            const wait = new Promise(r => { ackP = r; }); self.postMessage({ id: m.id, batch: { ids: gid, starts: st, buf: out.buffer } }, [out.buffer]); await wait; });
          self.postMessage({ id: m.id, r: true }); return; }
        if (m.op === 'bounds') { const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; await readUnit(m, async (buf, k) => { const dv = new DataView(buf); for (let i = 0; i < k; i++) for (let j = 0; j < 3; j++) { const v = m.grid.offset[j] + dv.getInt32(i * REC + 8 + j * 4, true) * m.grid.scale[j]; if (v < b[j]) b[j] = v; if (v > b[j + 3]) b[j + 3] = v; } }); self.postMessage({ id: m.id, r: b }); return; }
        if (m.op === 'index') { const [r, tr] = await indexChunk(m); self.postMessage({ id: m.id, r }, tr); return; }
        if (m.op === 'upper') { const [r, tr] = await upper(m); self.postMessage({ id: m.id, r }, tr); return; }
      } catch (err) { self.postMessage({ id: m.id, err: String(err && err.stack || err) }); }
    };
  }

  // ---------------- main thread ----------------
  class Pool {
    constructor(n, wasm) { const src = 'self.window = self;\n' + document.getElementById('src-laz').textContent + '\n' + document.getElementById('src-io').textContent + '\n' + (document.getElementById('src-fflate') ? document.getElementById('src-fflate').textContent : '') + '\n(' + workerMain.toString() + ')();';
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' })); this.ws = []; this.seq = 0; this.cb = new Map(); this.free = [];
      for (let i = 0; i < n; i++) { const w = new Worker(url); w.onmessage = e => this.msg(w, e.data); w.onerror = e => { const c = w.cur && this.cb.get(w.cur); if (c) { this.cb.delete(w.cur); c.rej(new Error(e.message || 'worker failed')); } }; this.ws.push(w); }
      this.wasm = wasm; }
    msg(w, d) { const c = this.cb.get(d.id); if (!c) return; if (d.progress !== undefined) { c.onProgress && c.onProgress(d.progress); return; } if (d.batch) { Promise.resolve(c.onBatch(d.batch)).then(() => w.postMessage({ op: 'ack' }), err => { this.cb.delete(d.id); c.rej(err); }); return; } this.cb.delete(d.id); w.cur = null; d.err ? c.rej(new Error(d.err)) : c.res(d.r); }
    call(w, m, tr, extra) { const id = ++this.seq; w.cur = id; return new Promise((res, rej) => { this.cb.set(id, Object.assign({ res, rej }, extra)); w.postMessage(Object.assign(m, { id }), tr || []); }); }
    async init() { await Promise.all(this.ws.map(w => this.call(w, { op: 'init', wasm: this.wasm }))); }
    async all(m) { await Promise.all(this.ws.map(w => this.call(w, Object.assign({}, m)))); }
    async map(items, fn, stop) { let i = 0; const out = new Array(items.length); await Promise.all(this.ws.map(async w => { while (i < items.length) { if (stop && stop()) throw new Error('Conversion stopped.'); const k = i++; out[k] = await fn(w, items[k], k); } })); return out; }
    close() { this.ws.forEach(w => w.terminate()); }
  }
  async function lasHead(file) {
    const h = new Uint8Array(await file.slice(0, Math.min(file.size, 375)).arrayBuffer()), dv = new DataView(h.buffer); if (cstr(h.subarray(0, 4)) !== 'LASF') throw new Error(file.name + ' is not a LAS/LAZ file');
    const r = { vmaj: h[24], vmin: h[25], hs: dv.getUint16(94, true), po: dv.getUint32(96, true), nv: dv.getUint32(100, true), fb: h[104], rl: dv.getUint16(105, true), cnt: dv.getUint32(107, true), scale: [131, 139, 147].map(o => dv.getFloat64(o, true)), offset: [155, 163, 171].map(o => dv.getFloat64(o, true)), max: [179, 195, 211].map(o => dv.getFloat64(o, true)), min: [187, 203, 219].map(o => dv.getFloat64(o, true)) };
    r.fmt = r.fb & 0x3f; r.laz = !!(r.fb & 0xc0); if (r.vmin >= 4 && r.hs >= 375) { const c = Number(dv.getBigUint64(247, true)); if (c) r.cnt = c; r.evStart = Number(dv.getBigUint64(235, true)); r.nev = dv.getUint32(243, true); }
    const hdr = new Uint8Array(await file.slice(0, r.hs).arrayBuffer()), vb = new Uint8Array(await file.slice(r.hs, r.po).arrayBuffer()), vd = new DataView(vb.buffer); const vlrs = []; let p = 0, wkt = null, gk = null;
    while (p + 54 <= vb.length && vlrs.length < r.nv) { const len = vd.getUint16(p + 20, true), uid = cstr(vb.subarray(p + 2, p + 18)), rid = vd.getUint16(p + 18, true), data = vb.subarray(p + 54, p + 54 + len);
      if (uid === 'laszip encoded' && rid === 22204) r.chunkSize = new DataView(data.buffer, data.byteOffset).getUint32(12, true); if (uid === 'LASF_Projection' && rid === 2112) wkt = cstr(data); if (uid === 'LASF_Projection' && rid === 34735) { const g = new DataView(data.buffer, data.byteOffset, data.byteLength); gk = {}; for (let k = 0; k < g.getUint16(6, true); k++) { const q = 8 + k * 8; if (q + 8 > data.length) break; const id = g.getUint16(q, true), loc = g.getUint16(q + 2, true), v = g.getUint16(q + 6, true); if (loc) continue; if (id === 3072) gk.projected = v; if (id === 2048) gk.geographic = v; if (id === 4096) gk.vertical = v; } }
      vlrs.push({ userId: uid, recordId: rid, description: cstr(vb.subarray(p + 22, p + 54)), length: len, laszip: uid === 'laszip encoded', b64: b64(vb.subarray(p, p + 54 + len)) }); p += 54 + len; }
    const evlrs = []; if (r.nev && r.evStart && r.evStart < file.size) { const eb = new Uint8Array(await file.slice(r.evStart, Math.min(file.size, r.evStart + 64e6)).arrayBuffer()), ed = new DataView(eb.buffer); let q = 0; while (q + 60 <= eb.length && evlrs.length < r.nev) { const len = Number(ed.getBigUint64(q + 20, true)), uid = cstr(eb.subarray(q + 2, q + 18)), rid = ed.getUint16(q + 18, true); if (uid === 'LASF_Projection' && rid === 2112) wkt = cstr(eb.subarray(q + 60, q + 60 + len)); evlrs.push({ userId: uid, recordId: rid, description: cstr(eb.subarray(q + 22, q + 54)), length: len, b64: b64(eb.subarray(q, q + 60 + len)) }); q += 60 + len; } }
    const epsg = w => { let best = null; for (const re of [/AUTHORITY\["EPSG","(\d+)"\]/g, /ID\["EPSG",(\d+)\]/g]) { let mm; while ((mm = re.exec(w))) best = [mm.index, +mm[1]]; } return best && best[1]; };
    if (wkt || gk) { r.crs = {}; if (wkt) { r.crs.wkt = wkt; const e = epsg(wkt); if (e) r.crs.epsg = e; } if (gk) { r.crs.geokeys = gk; const e = gk.projected || gk.geographic; if (!r.crs.epsg && e && e !== 32767) r.crs.epsg = e; } }
    r.meta = { format: r.laz ? 'LAZ' : 'LAS', version: r.vmaj + '.' + r.vmin, pointFormat: r.fmt, recordLength: r.rl, points: r.cnt, scale: r.scale, offset: r.offset, bounds: { min: r.min, max: r.max }, systemIdentifier: cstr(h.subarray(26, 58)), generatingSoftware: cstr(h.subarray(58, 90)), creationDate: dv.getUint16(92, true) + '-' + String(dv.getUint16(90, true)).padStart(3, '0'), globalEncoding: dv.getUint16(6, true), fileSourceId: dv.getUint16(4, true), header: b64(hdr), vlrs, evlrs };
    return r;
  }
  async function lazUnits(file, h, si, per) { // the LAZ chunk table → units of whole chunks
    const dv = new DataView(await file.slice(h.po, h.po + 8).arrayBuffer()); let ts = Number(dv.getBigInt64(0, true)); if (ts === -1) ts = Number(new DataView(await file.slice(file.size - 8, file.size).arrayBuffer()).getBigInt64(0, true));
    const tEnd = h.evStart && h.evStart > ts ? h.evStart : file.size; const T = SB.SBIO.lazChunkSizes(new Uint8Array(await file.slice(ts, tEnd).arrayBuffer()), h.chunkSize === 0xFFFFFFFF);
    const units = []; let off = h.po + 8, done = 0, cur = null;
    for (let c = 0; c < T.sizes.length; c++) { const n = T.totals ? T.totals[c] : Math.min(h.chunkSize, h.cnt - done); if (!cur || cur.count + n > per) { cur = { si, kind: 'laz', byteOff: off, sizes: [], counts: [], count: 0 }; units.push(cur); } cur.sizes.push(T.sizes[c]); cur.counts.push(n); cur.count += n; off += T.sizes[c]; done += n; }
    return units;
  }
  function e57Sources(f, file, fi) {
    const out = []; const scans = f.scans(); let crsS = ''; try { const root = f.xml && f.xml.tag === 'e57Root' ? f.xml : (f.xml && f.xml.children || []).find(c => c.tag === 'e57Root') || f.xml; crsS = ((xChild(root, 'coordinateMetadata') || { text: '' }).text || '').trim(); } catch (e) { }
    scans.forEach((sc, i) => { const pts = xChild(sc, 'points'), count = Number(pts.attrs.recordCount || 0), proto = xChild(pts, 'prototype'); const pose = xChild(sc, 'pose'); let R = [1, 0, 0, 0, 1, 0, 0, 0, 1], T = [0, 0, 0], q = null;
      if (pose) { const r = xChild(pose, 'rotation'), t = xChild(pose, 'translation'); if (r) { q = [xNum(xChild(r, 'w'), 1), xNum(xChild(r, 'x'), 0), xNum(xChild(r, 'y'), 0), xNum(xChild(r, 'z'), 0)]; R = quatToMat(...q); } if (t) T = [xNum(xChild(t, 'x'), 0), xNum(xChild(t, 'y'), 0), xNum(xChild(t, 'z'), 0)]; }
      const il = xChild(sc, 'intensityLimits'), cl = xChild(sc, 'colorLimits'), ip = xChild(proto, 'intensity'); const lim = (n, tag, d) => n ? xNum(xChild(n, tag), d) : d;
      const iMin = lim(il, 'intensityMinimum', ip ? Number(ip.attrs.minimum ?? 0) : 0), iMax = lim(il, 'intensityMaximum', ip ? Number(ip.attrs.maximum ?? 1) : 1);
      const cMin = ['Red', 'Green', 'Blue'].map(c => lim(cl, 'color' + c + 'Minimum', xChild(proto, 'color' + c) ? Number(xChild(proto, 'color' + c).attrs.minimum ?? 0) : 0)), cMax = ['Red', 'Green', 'Blue'].map(c => lim(cl, 'color' + c + 'Maximum', xChild(proto, 'color' + c) ? Number(xChild(proto, 'color' + c).attrs.maximum ?? 255) : 255));
      let bounds = null; const cb = xChild(sc, 'cartesianBounds'); if (cb) { const v = ['xMinimum', 'xMaximum', 'yMinimum', 'yMaximum', 'zMinimum', 'zMaximum'].map(t => xNum(xChild(cb, t), NaN)); if (v.every(Number.isFinite)) { const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; for (let k = 0; k < 8; k++) { const p = [v[k & 1], v[2 + ((k >> 1) & 1)], v[4 + ((k >> 2) & 1)]]; const w = [0, 1, 2].map(r => R[r * 3] * p[0] + R[r * 3 + 1] * p[1] + R[r * 3 + 2] * p[2] + T[r]); for (let j = 0; j < 3; j++) { mn[j] = Math.min(mn[j], w[j]); mx[j] = Math.max(mx[j], w[j]); } } bounds = [...mn, ...mx]; } }
      if (!bounds) { const sb = xChild(sc, 'sphericalBounds'); const rm = sb ? xNum(xChild(sb, 'rangeMaximum'), NaN) : NaN; if (Number.isFinite(rm)) bounds = [T[0] - rm, T[1] - rm, T[2] - rm, T[0] + rm, T[1] + rm, T[2] + rm]; }
      const txt = tag => (xChild(sc, tag) || { text: '' }).text.trim(); const name = txt('name');
      out.push({ file, fi, kind: 'e57', scan: i, label: file.name + ' · ' + (name || 'scan ' + (i + 1)), points: count, bytes: Math.round(file.size / scans.length), bounds, R, T, iMin, iMax, cMin, cMax, has: { intensity: !!ip, rgb: !!xChild(proto, 'colorRed'), las: false }, crs: crsS ? { wkt: crsS } : null,
        meta: { format: 'E57', scanIndex: i, name, guid: txt('guid'), description: txt('description'), records: count, pose: q ? { rotation: { w: q[0], x: q[1], y: q[2], z: q[3] }, translation: T } : null, sensor: { vendor: txt('sensorVendor'), model: txt('sensorModel'), serial: txt('sensorSerialNumber'), hardware: txt('sensorHardwareVersion'), software: txt('sensorSoftwareVersion'), firmware: txt('sensorFirmwareVersion') }, hasColor: !!xChild(proto, 'colorRed'), hasIntensity: !!ip, intensityLimits: [iMin, iMax], colorLimits: { min: cMin, max: cMax } } }); });
    return out;
  }
  // paged hierarchy (Potree 2 style), as scanlod writes it
  function hierarchy(map, step) {
    const mask = n => { let m = 0; for (let d = 0; d < 8; d++) if (map.has(n + d)) m |= 1 << d; return m; };
    const pages = [], roots = ['r']; for (let i = 0; i < roots.length; i++) { const r = roots[i], lim = r.length - 1 + step, list = [], q = [r]; while (q.length) { const n = q.shift(), m = mask(n), proxy = n.length - 1 === lim && m && n !== r; list.push([n, proxy]); if (proxy) { roots.push(n); continue; } for (let d = 0; d < 8; d++) if (m & (1 << d)) q.push(n + d); } pages.push([r, list]); }
    const at = new Map(); let off = 0; for (const [r, l] of pages) { at.set(r, [off, l.length * 22]); off += l.length * 22; }
    const out = new Uint8Array(off), dv = new DataView(out.buffer); let p = 0, depth = 0;
    for (const [, l] of pages) for (const [n, proxy] of l) { const nr = map.get(n), m = mask(n); depth = Math.max(depth, n.length - 1); const [t, o, s] = proxy ? [2, ...at.get(n)] : [m ? 0 : 1, nr.off, nr.size]; dv.setUint8(p, t); dv.setUint8(p + 1, m); dv.setUint32(p + 2, nr.count, true); dv.setBigUint64(p + 6, BigInt(o), true); dv.setBigUint64(p + 14, BigInt(s), true); p += 22; }
    return [out, at.get('r')[1], depth];
  }
  async function writeFile(dir, name, data) { const w = await (await dir.getFileHandle(name, { create: true })).createWritable(); await w.write(data); await w.close(); }

  async function run(o) {
    const t0 = performance.now(), log = o.onLog || (() => {}), prog = o.onProgress || (() => {}), stop = () => o.signal && o.signal.stop; let pool = null;
    const say = s => log('[' + fmtT((performance.now() - t0) / 1000) + '] ' + s);
    const out = o.out; let tmp = null;
    try {
      const files = [...o.files].filter(f => /\.(las|laz|e57)$/i.test(f.name)); if (!files.length) throw new Error('Choose .e57, .las or .laz files.');
      say(files.length + ' file(s), ' + (files.reduce((a, f) => a + f.size, 0) / 1e9).toFixed(2) + ' GB');
      // ---- sources and units ----
      const srcs = [], units = []; const PER = 2e7;
      for (const [fi, f] of files.entries()) {
        if (/\.e57$/i.test(f.name)) { const ef = new E57File(fileSource(f)); await ef.init(); for (const s of e57Sources(ef, f, fi)) { s.si = srcs.length; srcs.push(s); units.push({ si: s.si, kind: 'e57', count: s.points }); } }
        else { const h = await lasHead(f); const s = { file: f, fi, kind: 'las', label: f.name, points: h.cnt, bytes: f.size, bounds: [...h.min, ...h.max], h, has: { intensity: true, rgb: [2, 3, 5, 7, 8, 10].includes(h.fmt), las: true }, crs: h.crs || null, meta: h.meta, si: srcs.length };
          if (!(h.max[0] >= h.min[0]) || (h.min[0] === 0 && h.max[0] === 0 && h.cnt > 1)) s.bounds = null; srcs.push(s);
          if (h.laz) units.push(...await lazUnits(f, h, s.si, PER)); else for (let a = 0; a < h.cnt; a += PER) units.push({ si: s.si, kind: 'las', start: a, count: Math.min(PER, h.cnt - a) }); }
      }
      if (srcs.length > 65535) throw new Error('Too many sources (files and E57 scans): the limit is 65,535.');
      units.sort((a, b) => b.count - a.count);
      const total0 = srcs.reduce((a, s) => a + s.points, 0); say(srcs.length + ' source(s), ' + fmtN(total0) + ' points in the headers');
      const threads = Math.max(1, Math.min(o.threads || 8, (navigator.hardwareConcurrency || 4) - 1 || 1)); const mem = (o.memoryGB || 2) * 1e9;
      pool = new Pool(threads, Uint8Array.from(atob(window.LAZ_WASM_B64), c => c.charCodeAt(0))); await pool.init();
      const srcMsg = s => s.kind === 'las' ? { kind: 'las', fmt: s.h.fmt, rl: s.h.rl, laz: s.h.laz, po: s.h.po, scale: s.h.scale, offset: s.h.offset } : { kind: 'e57', scan: s.scan, R: s.R, T: s.T, iMin: s.iMin, iMax: s.iMax, cMin: s.cMin, cMax: s.cMax };
      const job = (op, u, grid, extra) => ({ op, file: srcs[u.si].file, si: u.si, src: srcMsg(srcs[u.si]), unit: u, grid, ...extra });
      // ---- bounds ----
      let B = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; const grow = b => { for (let k = 0; k < 3; k++) { B[k] = Math.min(B[k], b[k]); B[k + 3] = Math.max(B[k + 3], b[k + 3]); } };
      const scanB = async list => { prog('Reading bounds', 0); const bs = await pool.map(list, (w, u) => pool.call(w, job('bounds', u, { offset: [-1e7, -1e7, -1e7], scale: [0.01, 0.01, 0.01] })), stop); bs.forEach(b => grow([b[0] - 0.02, b[1] - 0.02, b[2] - 0.02, b[3] + 0.02, b[4] + 0.02, b[5] + 0.02])); };
      srcs.forEach(s => s.bounds && grow(s.bounds)); const need = units.filter(u => !srcs[u.si].bounds); if (need.length) await scanB(need);
      if (!(B[0] <= B[3])) throw new Error('No points found.');
      for (let attempt = 1; ; attempt++) {
        // ---- plan ----
        const lasS = srcs.filter(s => s.kind === 'las').map(s => Math.min(...s.h.scale)); let sc = o.scale || (lasS.length ? Math.max(1e-4, Math.min(...lasS)) : 1e-4); const base = (srcs.find(s => s.kind === 'las') || { h: { offset: [0, 0, 0] } }).h.offset; let offset, cube;
        for (;;) { offset = [0, 1, 2].map(k => base[k] + Math.floor((B[k] - base[k]) / sc) * sc - sc); const ext = Math.max(...[0, 1, 2].map(k => Math.ceil((B[k + 3] - offset[k]) / sc) + 2)); cube = pow2(ext); if (cube <= 2 ** 31) break; sc *= 10; say('The data spans too far for that precision; using ' + sc + ' m.'); }
        const grid = { offset, scale: [sc, sc, sc] }; let G = Math.min(cube, total0 > 2e9 ? 256 : 128); const shift = Math.log2(cube / G);
        const nodePoints = o.nodePoints || 50000, sampleGrid = o.sampleGrid || 128, chunkPts = Math.max(5e5, Math.min(8e6, Math.floor(mem * 0.6 / (threads * 160)), Math.ceil(total0 / (threads * 3))));
        if (attempt === 1) say('Plan: grid ' + sc + ' m, cube ' + (cube * sc).toFixed(1) + ' m, ' + threads + ' workers, chunks up to ' + fmtN(chunkPts) + ' points, count grid ' + G + '³');
        // ---- pass 1: count ----
        let done = 0; const tc = performance.now(); prog('Pass 1 of 2: counting', 0);
        const cnt = new Uint32Array(G * G * G); let total = 0, used = 0, outside = 0, skipped = 0; const tight = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; const ck = srcs.map(() => ({ n: 0, h1: 0, h2: 0 }));
        await pool.map(units, async (w, u) => { const r = await pool.call(w, job('count', u, grid, { G, shift }), null, { onProgress: k => { done += k; prog('Pass 1 of 2: counting', done / total0, fmtN(done / ((performance.now() - tc) / 1000)) + ' points/s'); } });
          for (let i = 0; i < r.cnt.length; i++) if (r.cnt[i]) cnt[i] += r.cnt[i]; total += r.n; used |= r.used; outside += r.outside; skipped += r.skipped; for (let k = 0; k < 3; k++) { tight[k] = Math.min(tight[k], r.t[k]); tight[k + 3] = Math.max(tight[k + 3], r.t[k + 3]); } const c = ck[u.si]; c.n += r.n; c.h1 = (c.h1 + r.h1) >>> 0; c.h2 = (c.h2 + r.h2) >>> 0; }, stop);
        if (outside) { if (attempt > 1) throw new Error(fmtN(outside) + ' points still fall outside the planned extent.'); say(fmtN(outside) + ' points lie outside the bounds in the file headers; reading the true bounds and counting again.'); B = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; await scanB(units); continue; }
        if (!total) throw new Error('The files contain no valid points.'); if (skipped) say(fmtN(skipped) + ' points without a valid position were skipped.');
        say('Counted ' + fmtN(total) + ' points in ' + fmtT((performance.now() - tc) / 1000));
        const anyLas = srcs.some(s => s.kind === 'las'), drop = new Set(o.drop || []);
        const attrs = { intensity: !!(used & 1), rgb: !!(used & 2), classification: anyLas, return_number: !!(used & 8), number_of_returns: !!(used & 8), flags: !!(used & 16), scanner_channel: !!(used & 32), user_data: !!(used & 64), scan_angle: !!(used & 128), point_source_id: !!(used & 256), gps_time: !!(used & 512), source: srcs.length > 1 };
        for (const d of drop) { if (d === 'returns') { attrs.return_number = attrs.number_of_returns = false; } else if (d in attrs) attrs[d] = false; }
        // ---- chunks ----
        const L = Math.log2(G); const lv = [cnt]; for (let s = G; s > 1; s /= 2) { const h = s / 2, prev = lv[lv.length - 1], v = new Float64Array(h * h * h); for (let x = 0; x < s; x++) for (let y = 0; y < s; y++) for (let z = 0; z < s; z++) v[((x >> 1) * h + (y >> 1)) * h + (z >> 1)] += prev[(x * s + y) * s + z]; lv.push(v); } lv.reverse();
        const chunks = [], lut = new Int32Array(G * G * G).fill(-1);
        const rc = (l, c) => { const s = 2 ** l, n = lv[l][(c[0] * s + c[1]) * s + c[2]]; if (!n) return; if (n > chunkPts && l < L) { for (let d = 0; d < 8; d++) rc(l + 1, [c[0] * 2 + (d & 1), c[1] * 2 + ((d >> 1) & 1), c[2] * 2 + ((d >> 2) & 1)]); return; }
          let name = 'r'; for (let i = 1; i <= l; i++) { const sh = l - i; name += ((c[0] >> sh) & 1) | ((c[1] >> sh) & 1) << 1 | ((c[2] >> sh) & 1) << 2; } const id = chunks.length; chunks.push({ name, n }); const k = 2 ** (L - l);
          for (let x = c[0] * k; x < (c[0] + 1) * k; x++) for (let y = c[1] * k; y < (c[1] + 1) * k; y++) for (let z = c[2] * k; z < (c[2] + 1) * k; z++) lut[(x * G + y) * G + z] = id; };
        rc(0, [0, 0, 0]); say(chunks.length + ' chunk(s); largest ' + fmtN(Math.max(...chunks.map(c => c.n))) + ' points');
        // ---- pass 2: distribute into one temporary file, each chunk at a known place ----
        tmp = await out.getDirectoryHandle('.scanlod-tmp', { create: true }); let acc = 0; for (const c of chunks) { c.off = acc; c.w = 0; acc += c.n * REC; }
        const cw = await (await tmp.getFileHandle('chunks.bin', { create: true })).createWritable(); done = 0; const td = performance.now(); prog('Pass 2 of 2: sorting points into chunks', 0);
        await pool.all({ op: 'lut', lut });
        await pool.map(units, (w, u) => pool.call(w, job('dist', u, grid, { G, shift }), null, { onBatch: async b => { const u8 = new Uint8Array(b.buf); for (let k = 0; k < b.ids.length; k++) { const c = chunks[b.ids[k]], a = b.starts[k] * REC, e = b.starts[k + 1] * REC, pos = c.off + c.w; c.w += e - a; await cw.write({ type: 'write', position: pos, data: u8.subarray(a, e) }); } done += u8.length / REC; prog('Pass 2 of 2: sorting points into chunks', done / total, fmtN(done / ((performance.now() - td) / 1000)) + ' points/s'); } }), stop);
        await cw.close(); for (const c of chunks) if (c.w !== c.n * REC) throw new Error('chunk ' + c.name + ' received ' + c.w / REC + ' points, expected ' + c.n);
        say('Chunks written in ' + fmtT((performance.now() - td) / 1000));
        // ---- octree ----
        const ow = await (await out.getFileHandle('octree.bin', { create: true })).createWritable(); let opos = 0; const nodes = new Map(); const comp = o.compress !== false;
        const put = async list => { for (const nd of list) { const u = new Uint8Array(nd.blob), off = opos; opos += u.length; nodes.set(nd.name, { count: nd.count, off, size: u.length }); if (u.length) await ow.write({ type: 'write', position: off, data: u }); } };
        const upDir = await tmp.getDirectoryHandle('up', { create: true }); const cf = await (await tmp.getFileHandle('chunks.bin')).getFile(); done = 0; const ti = performance.now(); prog('Building the octree', 0);
        const order = chunks.map((c, i) => i).sort((a, b) => chunks[b].n - chunks[a].n);
        await pool.map(order, async (w, ci) => { const c = chunks[ci]; const buf = await cf.slice(c.off, c.off + c.n * REC).arrayBuffer(); const r = await pool.call(w, { op: 'index', buf, name: c.name, cube, nodePoints, sampleGrid, attrs, comp, isRoot: c.name === 'r', seed: ci + 1 }, [buf]);
          if (r.prof && o.onLog && o.profile) say('prof ' + JSON.stringify(r.prof, (k, v) => typeof v === 'number' ? Math.round(v) : v)); const tp = performance.now(); await put(r.nodes); if (r.held) await writeFile(upDir, c.name + '.bin', r.held); if (o.profile) say('main write ' + Math.round(performance.now() - tp) + ' ms'); done += c.n; prog('Building the octree', done / total, fmtN(done / ((performance.now() - ti) / 1000)) + ' points/s'); }, stop);
        // ---- levels above the chunks ----
        const roots = chunks.filter(c => c.name.length > 1).map(c => c.name); const upper = new Set(); for (const r of roots) for (let l = 1; l < r.length; l++) upper.add(r.slice(0, l));
        const byL = []; for (const u of upper) (byL[u.length - 1] = byL[u.length - 1] || []).push(u);
        for (let l = byL.length - 1; l >= 0; l--) { if (!byL[l]) continue; await pool.map(byL[l], async (w, u) => { const kids = []; for (let d = 0; d < 8; d++) { const nm = u + d; try { const f = await (await upDir.getFileHandle(nm + '.bin')).getFile(); kids.push({ name: nm, buf: await f.arrayBuffer() }); } catch (e) { } }
            const r = await pool.call(w, { op: 'upper', name: u, kids, cube, sampleGrid, attrs, comp }, kids.map(k => k.buf)); await put(r.nodes); if (r.held) await writeFile(upDir, u + '.bin', r.held); for (const k of kids) await upDir.removeEntry(k.name + '.bin').catch(() => {}); }, stop); }
        await ow.close();
        // ---- index and JSON ----
        const stored = [...nodes.values()].reduce((a, n) => a + n.count, 0); if (stored !== total) throw new Error('internal check failed: ' + stored + ' points stored, ' + total + ' read');
        for (const k of nodes.keys()) if (k.length > 1 && !nodes.has(k.slice(0, -1))) throw new Error('internal check failed: node ' + k + ' has no parent');
        const [hb, first, depth] = hierarchy(nodes, o.step || 4); await writeFile(out, 'hierarchy.bin', hb);
        let crs = o.crs ? (typeof o.crs === 'object' ? { id: o.crs.id, name: o.crs.name, epsg: o.crs.epsg || undefined, wkt: o.crs.wkt, source: 'chosen' } : /^\s*(EPSG:)?\d+\s*$/i.test(o.crs) ? { epsg: +o.crs.replace(/\D/g, ''), source: 'chosen' } : { wkt: o.crs, source: 'chosen' }) : (srcs.find(s => s.crs) || {}).crs || null;
        if (o.vertical && o.vertical.id) { crs = Object.assign({}, crs || {}, { vertical: { datum: o.vertical.datum, geoid: o.vertical.geoid || null, epsg: o.vertical.epsg || null, name: o.vertical.name } });
          if (crs.wkt && o.vertical.datum === 'AHD' && /^PROJCS/.test(crs.wkt)) crs.wkt = 'COMPD_CS["' + (crs.name || 'projected') + ' + AHD height",' + crs.wkt + ',VERT_CS["AHD height",VERT_DATUM["Australian Height Datum",2005,AUTHORITY["EPSG","5111"]],UNIT["metre",1],AXIS["Up",UP],AUTHORITY["EPSG","5711"]]]'; }
        const name = o.name || (files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '') : out.name);
        const LIST = [['intensity', 'uint16', 1], ['rgb', 'uint16', 3], ['classification', 'uint8', 1], ['return_number', 'uint8', 1], ['number_of_returns', 'uint8', 1], ['flags', 'uint8', 1], ['scanner_channel', 'uint8', 1], ['user_data', 'uint8', 1], ['scan_angle', 'int16', 1], ['point_source_id', 'uint16', 1], ['gps_time', 'float64', 1], ['source', 'uint16', 1]];
        const attributes = [{ name: 'position', type: 'uint32', components: 3, note: 'integer offset from the node\'s minimum corner; world = offset + (nodeMin + value) * scale' }, ...LIST.filter(a => attrs[a[0]]).map(([n, t, c]) => ({ name: n, type: t, components: c }))];
        const bpp = attributes.reduce((a, x) => a + { uint8: 1, uint16: 2, int16: 2, uint32: 4, float64: 8 }[x.type] * x.components, 0);
        const ds = { format: 'scanbench-lod', version: 1, name, generator: 'ScanBench converter (browser)', created: Math.floor(Date.now() / 1000), points: total, skippedPoints: skipped, nodes: nodes.size, depth,
          scale: [sc, sc, sc], offset, bounds: { min: [0, 1, 2].map(k => offset[k] + tight[k] * sc), max: [0, 1, 2].map(k => offset[k] + tight[k + 3] * sc) }, cube: { min: offset, size: cube * sc, units: cube }, spacing: cube * sc / sampleGrid,
          nodeNaming: 'r, then one digit per level: digit = x | y<<1 | z<<2 (1 = upper half)', crs, attributes, bytesPerPoint: bpp, encoding: comp ? 'gzip' : 'none', octree: { file: 'octree.bin', bytes: opos }, hierarchy: { file: 'hierarchy.bin', firstChunkSize: first, stepSize: o.step || 4, entryBytes: 22, bytes: hb.length },
          sources: srcs.map((s, i) => ({ index: i, label: s.label, file: s.file.name, kind: s.kind, scan: s.kind === 'e57' ? s.scan : null, points: ck[i].n, headerPoints: s.points, bytes: s.bytes, crs: s.crs, checksum: { scheme: 'browser-32', a: ck[i].h1.toString(16), b: ck[i].h2.toString(16) }, metadata: s.meta })),
          settings: { workers: threads, memoryBytes: mem, chunkPoints: chunkPts, chunks: chunks.length, nodePoints, samplingGrid: sampleGrid, countGrid: G }, seconds: (performance.now() - t0) / 1000 };
        await writeFile(out, 'dataset.json', JSON.stringify(ds, null, 1));
        let hasProj = false; try { await out.getFileHandle('project.json'); hasProj = true; } catch (e) { }
        if (!hasProj) await writeFile(out, 'project.json', JSON.stringify({ format: 'scanbench-project', version: 1, name, created: ds.created, datasets: [{ id: 'd1', name, path: 'dataset.json', visible: true }], annotations: [], measurements: [], models: [], views: [], boxes: [] }, null, 1));
        // a viewer in the folder, set to open this project
        if (o.viewer) { try { const v = await o.viewer(); if (v) { const hid = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)); const home = 'window.SB_HOME=' + JSON.stringify({ name, points: total, created: ds.created, id: hid }).replace(/</g, '\\u003c') + ';'; const mark = 'window.SB_HOME=/*SB_' + 'HOME*/null;'; const html = v.replace(mark, home); if (html !== v) { await writeFile(out, 'ScanBench.html', html); say('Wrote ScanBench.html: open it to view this project.'); try { await new Promise((res, rej) => { const r = indexedDB.open('scanbench-home', 1); r.onupgradeneeded = () => r.result.createObjectStore('h'); r.onerror = () => rej(r.error); r.onsuccess = () => { const t = r.result.transaction('h', 'readwrite'); t.objectStore('h').put(out, 'proj:' + hid); t.oncomplete = res; t.onerror = () => rej(t.error); }; }); } catch (e) { } /* ScanBench.html in that folder finds the folder here (same browser, same origin) */ } } } catch (e) { say('Could not add ScanBench.html (' + e.message + '); open the folder from ScanBench instead.'); } }
        try { await out.removeEntry('.scanlod-tmp', { recursive: true }); } catch (e) { }
        const el = (performance.now() - t0) / 1000; say('Done: ' + fmtN(total) + ' points in ' + nodes.size + ' tiles, ' + (depth + 1) + ' levels, ' + (opos / 1e9).toFixed(2) + ' GB (' + (opos / total).toFixed(1) + ' bytes per point), ' + fmtT(el) + ' at ' + fmtN(total / el) + ' points/s');
        prog('Done', 1); return ds;
      }
    } finally { if (pool) pool.close(); }
  }
  return { run, supported, fmtN, fmtT, CRS, VERT };
})();
