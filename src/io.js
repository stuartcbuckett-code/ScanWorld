// ===== ScanBench I/O: readers and writers (no DOM) =====
// A "source" is {size, name, read(off,len)->Promise<ArrayBuffer>}.
const SB = (typeof globalThis !== 'undefined' ? globalThis : window);
const tick = () => new Promise(r => setTimeout(r, 0));

function fileSource(file) {
  return { name: file.name, size: file.size,
    read: async (off, len) => await file.slice(off, off + len).arrayBuffer() };
}

// ---------- shared output builder ----------
// Collects points relative to an origin (Float64 world -> Float32 local)
class CloudBuilder {
  constructor(cap, opts) {
    this.cap = Math.max(1, cap | 0); this.n = 0;
    this.pos = new Float32Array(this.cap * 3);
    this.rgb = opts.rgb ? new Uint8Array(this.cap * 3) : null;
    this.inten = opts.intensity ? new Float32Array(this.cap) : null;
    this.cls = opts.cls ? new Uint8Array(this.cap) : null;
    this.origin = opts.origin || null;
  }
  grow(need) {
    if (need <= this.cap) return;
    let c = Math.max(need, Math.ceil(this.cap * 1.5));
    const g = (a, k) => { if (!a) return null; const b = new a.constructor(c * k); b.set(a); return b; };
    this.pos = g(this.pos, 3); this.rgb = g(this.rgb, 3); this.inten = g(this.inten, 1); this.cls = g(this.cls, 1); this.cap = c;
  }
  setOrigin(x, y, z) { if (!this.origin) this.origin = [Math.floor(x), Math.floor(y), Math.floor(z)]; }
  finish() {
    const n = this.n, t = (a, k) => a ? a.slice(0, n * k) : null;
    return { n, pos: t(this.pos, 3), rgb: t(this.rgb, 3), intensity: t(this.inten, 1), cls: t(this.cls, 1), origin: this.origin || [0, 0, 0] };
  }
}

// ---------- LAS / LAZ ----------
function parseLasHeader(buf) {
  const dv = new DataView(buf);
  const sig = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (sig !== 'LASF') throw new Error('Not a LAS/LAZ file (missing LASF signature)');
  const h = {};
  h.major = dv.getUint8(24); h.minor = dv.getUint8(25);
  h.headerSize = dv.getUint16(94, true);
  h.pointOffset = dv.getUint32(96, true);
  h.numVlr = dv.getUint32(100, true);
  const fmtByte = dv.getUint8(104);
  h.compressed = (fmtByte & 0x80) !== 0;
  h.format = fmtByte & 0x3f;
  h.recLen = dv.getUint16(105, true);
  h.count = dv.getUint32(107, true);
  if (h.minor >= 4 && h.headerSize >= 375) {
    const c64 = Number(dv.getBigUint64(247, true));
    if (c64 > 0) h.count = c64;
  }
  h.scale = [dv.getFloat64(131, true), dv.getFloat64(139, true), dv.getFloat64(147, true)];
  h.offset = [dv.getFloat64(155, true), dv.getFloat64(163, true), dv.getFloat64(171, true)];
  h.max = [dv.getFloat64(179, true), dv.getFloat64(195, true), dv.getFloat64(211, true)];
  h.min = [dv.getFloat64(187, true), dv.getFloat64(203, true), dv.getFloat64(219, true)];
  return h;
}
function lasLayout(fmt) {
  const rgbOff = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 }[fmt];
  return { rgbOff: rgbOff === undefined ? -1 : rgbOff, clsOff: fmt >= 6 ? 16 : 15, clsMask: fmt >= 6 ? 0xff : 0x1f };
}

async function readLAS(src, opts = {}) {
  const budget = opts.budget || 10e6, onProgress = opts.onProgress || (() => {});
  const head = await src.read(0, Math.min(src.size, 4096));
  const h = parseLasHeader(head);
  const stride = Math.max(1, Math.ceil(h.count / budget));
  const L = lasLayout(h.format);
  const keep = Math.ceil(h.count / stride);
  const B = new CloudBuilder(keep, { rgb: L.rgbOff >= 0, intensity: true, cls: true });
  B.setOrigin(h.min[0], h.min[1], h.min[2]);
  const o = B.origin, sx = h.scale[0], sy = h.scale[1], sz = h.scale[2];
  const ox = h.offset[0] - o[0], oy = h.offset[1] - o[1], oz = h.offset[2] - o[2];
  let rgbMax = 0;
  const rgb16 = B.rgb ? new Uint16Array(keep * 3) : null;
  const handle = (dv, p) => {
    const i = B.n++;
    B.pos[i * 3] = dv.getInt32(p, true) * sx + ox;
    B.pos[i * 3 + 1] = dv.getInt32(p + 4, true) * sy + oy;
    B.pos[i * 3 + 2] = dv.getInt32(p + 8, true) * sz + oz;
    B.inten[i] = dv.getUint16(p + 12, true);
    B.cls[i] = dv.getUint8(p + L.clsOff) & L.clsMask;
    if (rgb16) {
      const r = dv.getUint16(p + L.rgbOff, true), g = dv.getUint16(p + L.rgbOff + 2, true), b = dv.getUint16(p + L.rgbOff + 4, true);
      rgb16[i * 3] = r; rgb16[i * 3 + 1] = g; rgb16[i * 3 + 2] = b;
      if (r > rgbMax) rgbMax = r; if (g > rgbMax) rgbMax = g; if (b > rgbMax) rgbMax = b;
    }
  };
  if (h.compressed) {
    if (!opts.lazPerf) throw new Error('LAZ decoder not available');
    const LP = await opts.lazPerf();
    const all = new Uint8Array(await src.read(0, src.size));
    const fptr = LP._malloc(all.length);
    LP.HEAPU8.set(all, fptr);
    const laz = new LP.LASZip();
    const pptr = LP._malloc(h.recLen + 64);
    try {
      laz.open(fptr, all.length);
      const cnt = laz.getCount();
      for (let k = 0; k < cnt; k++) {
        laz.getPoint(pptr);
        if (k % stride === 0 && B.n < keep) handle(new DataView(LP.HEAPU8.buffer, pptr, h.recLen), 0);
        if ((k & 0x3ffff) === 0) { onProgress(k / cnt); await tick(); }
      }
    } finally { laz.delete(); LP._free(pptr); LP._free(fptr); }
  } else {
    const chunkPts = 200000;
    for (let start = 0; start < h.count; start += chunkPts) {
      const m = Math.min(chunkPts, h.count - start);
      const ab = await src.read(h.pointOffset + start * h.recLen, m * h.recLen);
      const dv = new DataView(ab);
      let k0 = (stride - (start % stride)) % stride;
      for (let k = k0; k < m && B.n < keep; k += stride) handle(dv, k * h.recLen);
      onProgress((start + m) / h.count); await tick();
    }
  }
  const out = B.finish();
  if (rgb16) {
    const div = rgbMax > 255 ? 257 : 1;
    for (let i = 0; i < out.n * 3; i++) out.rgb[i] = Math.min(255, Math.round(rgb16[i] / div));
  }
  let imax = 0; for (let i = 0; i < out.n; i++) if (out.intensity[i] > imax) imax = out.intensity[i];
  if (imax > 0) for (let i = 0; i < out.n; i++) out.intensity[i] /= imax;
  out.meta = { format: (h.compressed ? 'LAZ ' : 'LAS ') + h.major + '.' + h.minor + ' (point format ' + h.format + ')', total: h.count, stride };
  return out;
}

// ---------- tiny XML parser (E57 XML section) ----------
function parseXML(s) {
  const root = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack = [root]; let i = 0;
  const ent = t => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) stack[stack.length - 1].text += ent(s.slice(i, lt));
    if (s.startsWith('<?', lt)) { i = s.indexOf('?>', lt) + 2; continue; }
    if (s.startsWith('<!--', lt)) { i = s.indexOf('-->', lt) + 3; continue; }
    if (s.startsWith('<![CDATA[', lt)) { const e = s.indexOf(']]>', lt); stack[stack.length - 1].text += s.slice(lt + 9, e); i = e + 3; continue; }
    if (s.startsWith('<!', lt)) { i = s.indexOf('>', lt) + 1; continue; }
    const gt = s.indexOf('>', lt);
    let body = s.slice(lt + 1, gt);
    if (body[0] === '/') { stack.pop(); i = gt + 1; continue; }
    const selfClose = body.endsWith('/');
    if (selfClose) body = body.slice(0, -1);
    const m = body.match(/^([^\s]+)/); const tag = m[1];
    const attrs = {}; const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g; let a;
    while ((a = re.exec(body))) attrs[a[1]] = ent(a[3] !== undefined ? a[3] : a[4]);
    const node = { tag: tag.includes(':') ? tag.split(':').pop() : tag, attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
    i = gt + 1;
  }
  return root;
}
const xChild = (n, tag) => n && n.children.find(c => c.tag === tag);
const xNum = (n, d) => { if (!n) return d; const t = n.text.trim(); return t === '' ? d : Number(t); };

// ---------- E57 ----------
class E57File {
  constructor(src) { this.src = src; }
  async init() {
    const dv = new DataView(await this.src.read(0, 48));
    let sig = ''; for (let i = 0; i < 8; i++) sig += String.fromCharCode(dv.getUint8(i));
    if (sig !== 'ASTM-E57') throw new Error('Not an E57 file');
    this.xmlOff = Number(dv.getBigUint64(24, true));
    this.xmlLen = Number(dv.getBigUint64(32, true));
    this.ps = Number(dv.getBigUint64(40, true)) || 1024;
    this.pd = this.ps - 4;
    const xb = await this.readLogical(this.xmlOff, this.xmlLen);
    this.xml = parseXML(new TextDecoder().decode(xb));
    this.e57Root = this.xml.children.find(c => c.tag === 'e57Root');
    if (!this.e57Root) throw new Error('E57 XML has no e57Root');
  }
  toLogical(phys) { return Math.floor(phys / this.ps) * this.pd + (phys % this.ps); }
  toPhys(log) { return Math.floor(log / this.pd) * this.ps + (log % this.pd); }
  async readLogical(physOff, len) {
    const L0 = this.toLogical(physOff);
    const pEnd = this.toPhys(L0 + len - 1) + 1;
    const raw = new Uint8Array(await this.src.read(physOff, pEnd - physOff));
    const out = new Uint8Array(len); let o = 0, p = 0, phys = physOff;
    while (o < len) {
      const inPage = phys % this.ps; const avail = Math.min(this.pd - inPage, len - o);
      out.set(raw.subarray(p, p + avail), o); o += avail; p += avail + 4; phys += avail + 4;
    }
    return out;
  }
  scans() {
    const d3 = xChild(this.e57Root, 'data3D');
    return d3 ? d3.children.filter(c => c.tag === 'vectorChild') : [];
  }
}

class LogicalStream {
  constructor(f, physOff) { this.f = f; this.phys = physOff; this.buf = new Uint8Array(0); this.p = 0; }
  async ensure(n) {
    while (this.buf.length - this.p < n) {
      const want = Math.max(n * 2, 4 << 20);
      const pageStart = Math.floor(this.phys / this.f.ps) * this.f.ps;
      let physLen = Math.ceil((want + (this.phys - pageStart)) / this.f.ps) * this.f.ps;
      physLen = Math.min(physLen, this.f.src.size - pageStart);
      if (physLen <= this.phys - pageStart) throw new Error('E57: unexpected end of file');
      const raw = new Uint8Array(await this.f.src.read(pageStart, physLen));
      const parts = []; let tot = 0;
      for (let pg = 0; pg < physLen; pg += this.f.ps) {
        const s = pg === 0 ? this.phys - pageStart : 0;
        const e = Math.min(pg + this.f.pd, physLen);
        if (pg + s < e) { parts.push(raw.subarray(pg + s, e)); tot += e - pg - s; }
      }
      const nb = new Uint8Array(this.buf.length - this.p + tot);
      nb.set(this.buf.subarray(this.p), 0); let o = this.buf.length - this.p;
      for (const q of parts) { nb.set(q, o); o += q.length; }
      this.buf = nb; this.p = 0; this.phys = pageStart + physLen;
    }
  }
  async take(n) { await this.ensure(n); const v = this.buf.subarray(this.p, this.p + n); this.p += n; return v; }
}

function bitsFor(min, max) { const r = max - min + 1; let b = 0; while (Math.pow(2, b) < r) b++; return b; }

// Decoder for one bytestream; writes every `stride`-th value to out[]
class StreamDecoder {
  constructor(proto, count, stride, out) {
    this.count = count; this.stride = stride; this.out = out; this.idx = 0;
    this.pending = new Uint8Array(0); this.bitPos = 0;
    const t = proto.attrs.type;
    if (t === 'Float') {
      this.kind = proto.attrs.precision === 'single' ? 'f32' : 'f64';
      this.bytes = this.kind === 'f32' ? 4 : 8;
    } else {
      this.kind = 'int';
      const min = Number(proto.attrs.minimum ?? (t === 'Integer' ? -2147483648 : 0));
      const max = Number(proto.attrs.maximum ?? 2147483647);
      this.min = min; this.bits = bitsFor(min, max);
      this.scale = t === 'ScaledInteger' ? Number(proto.attrs.scale ?? 1) : 1;
      this.offset = t === 'ScaledInteger' ? Number(proto.attrs.offset ?? 0) : 0;
    }
  }
  done() { return this.idx >= this.count; }
  put(v) { const i = this.idx++; if (i % this.stride === 0) { const j = i / this.stride; if (j < this.out.length) this.out[j] = v; } }
  feed(data) {
    if (this.done()) return;
    if (this.kind === 'int' && this.bits === 0) { // constant field: no bytes
      while (!this.done()) this.put(this.min * this.scale + this.offset);
      return;
    }
    let buf;
    if (this.pending.length) { buf = new Uint8Array(this.pending.length + data.length); buf.set(this.pending); buf.set(data, this.pending.length); }
    else buf = data;
    const base = this.idx, st = this.stride, out = this.out, cnt = this.count;
    const k0 = (st - (base % st)) % st;
    if (this.kind !== 'int') {
      const B = this.bytes, n = Math.floor(buf.length / B);
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
      for (let k = k0; k < n && base + k < cnt; k += st) { const j = (base + k) / st; if (j < out.length) out[j] = B === 4 ? dv.getFloat32(k * B, true) : dv.getFloat64(k * B, true); }
      this.idx = Math.min(cnt, base + n);
      this.pending = buf.slice(n * B);
      return;
    }
    const b = this.bits, totalBits = buf.length * 8 - this.bitPos;
    const n = Math.floor(totalBits / b);
    const mod = Math.pow(2, b), min = this.min, sc = this.scale, of = this.offset, bp = this.bitPos;
    for (let k = k0; k < n && base + k < cnt; k += st) {
      const o = bp + k * b, byteI = o >> 3, sh = o & 7, nb = (sh + b + 7) >> 3;
      let raw;
      if (b <= 45) { let acc = 0, m = 1; for (let j = 0; j < nb; j++) { acc += buf[byteI + j] * m; m *= 256; } raw = Math.floor(acc / (1 << sh)) % mod; }
      else { let acc = 0n; for (let j = nb - 1; j >= 0; j--) acc = (acc << 8n) | BigInt(buf[byteI + j]); raw = Number((acc >> BigInt(sh)) & ((1n << BigInt(b)) - 1n)); }
      const j = (base + k) / st; if (j < out.length) out[j] = (raw + min) * sc + of;
    }
    this.idx = Math.min(cnt, base + n);
    const used = bp + n * b;
    this.pending = buf.slice(used >> 3); this.bitPos = used & 7;
  }
}

function quatToMat(w, x, y, z) {
  const n = Math.hypot(w, x, y, z) || 1; w /= n; x /= n; y /= n; z /= n;
  return [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
}

async function readE57(src, opts = {}) {
  const budget = opts.budget || 10e6, onProgress = opts.onProgress || (() => {});
  const f = new E57File(src); await f.init();
  const scans = f.scans();
  if (!scans.length) throw new Error('E57 contains no point clouds (data3D is empty)');
  const info = scans.map(sc => {
    const pts = xChild(sc, 'points');
    return { node: sc, pts, count: Number(pts.attrs.recordCount || 0), name: (xChild(sc, 'name') || { text: '' }).text.trim() };
  });
  const total = info.reduce((a, s) => a + s.count, 0);
  const stride = Math.max(1, Math.ceil(total / budget));
  let anyColor = false;
  for (const s of info) { const proto = xChild(s.pts, 'prototype'); if (xChild(proto, 'colorRed')) anyColor = true; }
  const B = new CloudBuilder(Math.ceil(total / stride) + info.length, { rgb: anyColor, intensity: true, cls: false });
  let doneRecs = 0; const scanMeta = [];
  for (const s of info) {
    const proto = xChild(s.pts, 'prototype');
    const fields = proto.children;
    const m = Math.ceil(s.count / stride);
    const has = k => fields.some(c => c.tag === k);
    const cart = has('cartesianX');
    const want = cart ? ['cartesianX', 'cartesianY', 'cartesianZ'] : ['sphericalRange', 'sphericalAzimuth', 'sphericalElevation'];
    if (!want.every(has)) { scanMeta.push({ name: s.name, count: 0, skipped: 'no coordinates' }); continue; }
    const extra = ['intensity', 'colorRed', 'colorGreen', 'colorBlue', cart ? 'cartesianInvalidState' : 'sphericalInvalidState'];
    const cols = {}; const decs = [];
    fields.forEach((fp, i) => {
      if (want.includes(fp.tag) || extra.includes(fp.tag)) {
        cols[fp.tag] = new Float64Array(m);
        decs[i] = new StreamDecoder(fp, s.count, stride, cols[fp.tag]);
        if (fp.tag === 'intensity' || fp.tag.startsWith('color')) { cols[fp.tag].min = decs[i].min ?? 0; cols[fp.tag].max = Number(fp.attrs.maximum ?? 1); }
      } else decs[i] = null;
    });
    // section header
    const fileOff = Number(s.pts.attrs.fileOffset);
    const sh = await f.readLogical(fileOff, 32);
    const sdv = new DataView(sh.buffer, sh.byteOffset, 32);
    if (sdv.getUint8(0) !== 1) throw new Error('E57: bad compressed vector section');
    const secLen = Number(sdv.getBigUint64(8, true));
    const dataPhys = Number(sdv.getBigUint64(16, true));
    const secEndLog = f.toLogical(fileOff) + secLen;
    const stream = new LogicalStream(f, dataPhys);
    let logPos = f.toLogical(dataPhys);
    const active = decs.filter(Boolean);
    let lastP = 0;
    while (active.some(d => !d.done()) && logPos < secEndLog) {
      const hdr = await stream.take(4);
      const ptype = hdr[0], plen = (hdr[2] | (hdr[3] << 8)) + 1;
      const body = await stream.take(plen - 4); logPos += plen;
      if (ptype !== 1) continue;
      const bv = new DataView(body.buffer, body.byteOffset, body.length);
      const nbs = bv.getUint16(0, true);
      let off = 2 + nbs * 2;
      for (let k = 0; k < nbs; k++) {
        const L = bv.getUint16(2 + k * 2, true);
        if (decs[k] && L) decs[k].feed(body.subarray(off, off + L));
        off += L;
      }
      const prog = (doneRecs + (active[0] ? active[0].idx : 0)) / total;
      if (prog - lastP > 0.01) { lastP = prog; onProgress(prog); await tick(); }
    }
    // assemble with pose
    const pose = xChild(s.node, 'pose');
    let R = [1, 0, 0, 0, 1, 0, 0, 0, 1], T = [0, 0, 0];
    if (pose) {
      const r = xChild(pose, 'rotation'), t = xChild(pose, 'translation');
      if (r) R = quatToMat(xNum(xChild(r, 'w'), 1), xNum(xChild(r, 'x'), 0), xNum(xChild(r, 'y'), 0), xNum(xChild(r, 'z'), 0));
      if (t) T = [xNum(xChild(t, 'x'), 0), xNum(xChild(t, 'y'), 0), xNum(xChild(t, 'z'), 0)];
    }
    const il = xChild(s.node, 'intensityLimits'), cl = xChild(s.node, 'colorLimits');
    const I = cols.intensity, inv = cols.cartesianInvalidState || cols.sphericalInvalidState;
    let iMin = 0, iMax = 1;
    if (I) { iMin = il ? xNum(xChild(il, 'intensityMinimum'), I.min) : I.min; iMax = il ? xNum(xChild(il, 'intensityMaximum'), I.max) : I.max; }
    const cMin = [], cMax = [];
    ['Red', 'Green', 'Blue'].forEach((c, k) => {
      const col = cols['color' + c];
      cMin[k] = cl ? xNum(xChild(cl, 'color' + c + 'Minimum'), col ? col.min : 0) : (col ? col.min : 0);
      cMax[k] = cl ? xNum(xChild(cl, 'color' + c + 'Maximum'), col ? col.max : 255) : (col ? col.max : 255);
    });
    const X = cols[want[0]], Y = cols[want[1]], Z = cols[want[2]];
    const mm = Math.min(m, Math.ceil(Math.min(...active.map(d => d.idx)) / stride));
    B.grow(B.n + mm);
    let kept = 0;
    for (let i = 0; i < mm; i++) {
      if (inv && inv[i] !== 0) continue;
      let x, y, z;
      if (cart) { x = X[i]; y = Y[i]; z = Z[i]; }
      else { const r = X[i], az = Y[i], el = Z[i]; x = r * Math.cos(el) * Math.cos(az); y = r * Math.cos(el) * Math.sin(az); z = r * Math.sin(el); }
      if (!cart && X[i] === 0) continue;
      const wx = R[0] * x + R[1] * y + R[2] * z + T[0];
      const wy = R[3] * x + R[4] * y + R[5] * z + T[1];
      const wz = R[6] * x + R[7] * y + R[8] * z + T[2];
      if (!B.origin) B.setOrigin(wx, wy, wz);
      const j = B.n++;
      B.pos[j * 3] = wx - B.origin[0]; B.pos[j * 3 + 1] = wy - B.origin[1]; B.pos[j * 3 + 2] = wz - B.origin[2];
      B.inten[j] = I ? (I[i] - iMin) / ((iMax - iMin) || 1) : 0.5;
      if (B.rgb) {
        if (cols.colorRed) {
          for (let k = 0; k < 3; k++) {
            const c = cols['color' + ['Red', 'Green', 'Blue'][k]];
            B.rgb[j * 3 + k] = Math.max(0, Math.min(255, Math.round(((c ? c[i] : 0) - cMin[k]) / ((cMax[k] - cMin[k]) || 1) * 255)));
          }
        } else { B.rgb[j * 3] = B.rgb[j * 3 + 1] = B.rgb[j * 3 + 2] = 180; }
      }
      kept++;
    }
    scanMeta.push({ name: s.name || ('Scan ' + (scanMeta.length + 1)), count: s.count, kept, pose: { R, T } });
    doneRecs += s.count;
  }
  const out = B.finish();
  if (!I_hasAny(scans)) out.intensity = null;
  out.meta = { format: 'E57 (' + scans.length + ' scan' + (scans.length > 1 ? 's' : '') + ')', total, stride, scans: scanMeta };
  return out;
  function I_hasAny(sc) { return info.some(s => xChild(xChild(s.pts, 'prototype'), 'intensity')); }
}

// ---------- text XYZ / PTS / CSV ----------
async function readText(src, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const budget = opts.budget || 10e6;
  const est = Math.max(1, Math.floor(src.size / 30));
  const stride = Math.max(1, Math.ceil(est / budget));
  const B = new CloudBuilder(Math.min(est, budget) + 1000, { rgb: true, intensity: true });
  let hasRGB = false, hasI = false, ncols = 0, rec = 0, rest = '';
  const dec = new TextDecoder(); const CH = 8 << 20;
  let iMax = 0, isPts = /\.pts$/i.test(src.name), first = true;
  for (let off = 0; off < src.size; off += CH) {
    const txt = rest + dec.decode(await src.read(off, Math.min(CH, src.size - off)), { stream: off + CH < src.size });
    const lines = txt.split(/\r?\n/); rest = off + CH < src.size ? lines.pop() : '';
    for (const line of lines) {
      const t = line.trim(); if (!t) continue;
      const parts = t.split(/[\s,;]+/);
      if (first && isPts && parts.length === 1) { first = false; continue; }
      first = false;
      const v = parts.map(Number);
      if (v.length < 3 || isNaN(v[0]) || isNaN(v[1]) || isNaN(v[2])) continue;
      if (!ncols) { ncols = v.length; hasI = ncols === 4 || ncols >= 7; hasRGB = ncols >= 6; }
      if ((rec++) % stride) continue;
      B.grow(B.n + 1); B.setOrigin(v[0], v[1], v[2]);
      const j = B.n++, o = B.origin;
      B.pos[j * 3] = v[0] - o[0]; B.pos[j * 3 + 1] = v[1] - o[1]; B.pos[j * 3 + 2] = v[2] - o[2];
      const ci = ncols >= 7 ? 4 : 3;
      if (hasRGB) { B.rgb[j * 3] = v[ci]; B.rgb[j * 3 + 1] = v[ci + 1]; B.rgb[j * 3 + 2] = v[ci + 2]; }
      if (hasI) { B.inten[j] = v[3]; if (Math.abs(v[3]) > iMax) iMax = Math.abs(v[3]); }
    }
    onProgress(Math.min(1, (off + CH) / src.size)); await tick();
  }
  const out = B.finish();
  if (!hasRGB) out.rgb = null;
  if (!hasI) out.intensity = null;
  else if (iMax > 1) { const mn = Math.min(...out.intensity.subarray(0, Math.min(out.n, 1e5))); for (let i = 0; i < out.n; i++) out.intensity[i] = (out.intensity[i] - Math.min(mn, 0)) / (iMax - Math.min(mn, 0)); }
  out.meta = { format: 'Text (' + ncols + ' columns)', total: rec, stride };
  return out;
}

// ---------- PLY (points or mesh) ----------
async function readPLY(src, opts = {}) {
  const ab = await src.read(0, src.size);
  const u8 = new Uint8Array(ab);
  let hEnd = -1; const probe = new TextDecoder().decode(u8.subarray(0, Math.min(u8.length, 65536)));
  const he = probe.indexOf('end_header'); if (he < 0) throw new Error('PLY header not found');
  hEnd = probe.indexOf('\n', he) + 1;
  const lines = probe.slice(0, hEnd).split(/\r?\n/);
  let format = 'ascii'; const elems = []; let cur = null;
  for (const l of lines) {
    const p = l.trim().split(/\s+/);
    if (p[0] === 'format') format = p[1];
    else if (p[0] === 'element') { cur = { name: p[1], count: +p[2], props: [] }; elems.push(cur); }
    else if (p[0] === 'property') {
      if (p[1] === 'list') cur.props.push({ list: true, ct: p[2], it: p[3], name: p[4] });
      else cur.props.push({ t: p[1], name: p[2] });
    }
  }
  const sz = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
  const le = format === 'binary_little_endian';
  const dv = new DataView(ab);
  const rd = (t, o) => {
    switch (t) {
      case 'char': case 'int8': return dv.getInt8(o); case 'uchar': case 'uint8': return dv.getUint8(o);
      case 'short': case 'int16': return dv.getInt16(o, le); case 'ushort': case 'uint16': return dv.getUint16(o, le);
      case 'int': case 'int32': return dv.getInt32(o, le); case 'uint': case 'uint32': return dv.getUint32(o, le);
      case 'float': case 'float32': return dv.getFloat32(o, le); default: return dv.getFloat64(o, le);
    }
  };
  const vEl = elems.find(e => e.name === 'vertex'); const fEl = elems.find(e => e.name === 'face');
  if (!vEl) throw new Error('PLY has no vertex element');
  const V = new Float64Array(vEl.count * 3); const C = new Uint8Array(vEl.count * 3); let I = null;
  const pi = n => vEl.props.findIndex(p => p.name === n);
  const ix = pi('x'), iy = pi('y'), iz = pi('z'), ir = pi('red'), ig = pi('green'), ib = pi('blue');
  let ii = pi('intensity'); if (ii < 0) ii = pi('scalar_intensity'); if (ii < 0) ii = pi('scalar_Intensity');
  if (ii >= 0) I = new Float32Array(vEl.count);
  const faces = [];
  if (format === 'ascii') {
    const txt = new TextDecoder().decode(u8.subarray(hEnd)).split(/\r?\n/); let li = 0;
    for (const el of elems) for (let k = 0; k < el.count; k++) {
      const v = txt[li++].trim().split(/\s+/).map(Number);
      if (el === vEl) { V[k * 3] = v[ix]; V[k * 3 + 1] = v[iy]; V[k * 3 + 2] = v[iz]; if (ir >= 0) { C[k * 3] = v[ir]; C[k * 3 + 1] = v[ig]; C[k * 3 + 2] = v[ib]; } if (I) I[k] = v[ii]; }
      else if (el === fEl) { const n = v[0]; for (let j = 2; j < n; j++) faces.push(v[1], v[j], v[j + 1]); }
    }
  } else {
    if (format !== 'binary_little_endian' && format !== 'binary_big_endian') throw new Error('Unsupported PLY format ' + format);
    let o = hEnd;
    for (const el of elems) for (let k = 0; k < el.count; k++) {
      const vals = [];
      for (const p of el.props) {
        if (p.list) { const n = rd(p.ct, o); o += sz[p.ct]; const arr = []; for (let j = 0; j < n; j++) { arr.push(rd(p.it, o)); o += sz[p.it]; } vals.push(arr); }
        else { vals.push(rd(p.t, o)); o += sz[p.t]; }
      }
      if (el === vEl) { V[k * 3] = vals[ix]; V[k * 3 + 1] = vals[iy]; V[k * 3 + 2] = vals[iz]; if (ir >= 0) { C[k * 3] = vals[ir]; C[k * 3 + 1] = vals[ig]; C[k * 3 + 2] = vals[ib]; } if (I) I[k] = vals[ii]; }
      else if (el === fEl) { const a = vals[0]; for (let j = 1; j < a.length - 1; j++) faces.push(a[0], a[j], a[j + 1]); }
    }
  }
  if (fEl && faces.length) {
    const tris = new Float64Array(faces.length * 3);
    for (let i = 0; i < faces.length; i++) { const v = faces[i]; tris[i * 3] = V[v * 3]; tris[i * 3 + 1] = V[v * 3 + 1]; tris[i * 3 + 2] = V[v * 3 + 2]; }
    return { mesh: true, tris, meta: { format: 'PLY mesh', triangles: faces.length / 3 } };
  }
  const B = new CloudBuilder(vEl.count, { rgb: ir >= 0, intensity: !!I });
  for (let k = 0; k < vEl.count; k++) {
    B.setOrigin(V[0], V[1], V[2]); const o = B.origin, j = B.n++;
    B.pos[j * 3] = V[k * 3] - o[0]; B.pos[j * 3 + 1] = V[k * 3 + 1] - o[1]; B.pos[j * 3 + 2] = V[k * 3 + 2] - o[2];
    if (B.rgb) { B.rgb[j * 3] = C[k * 3]; B.rgb[j * 3 + 1] = C[k * 3 + 1]; B.rgb[j * 3 + 2] = C[k * 3 + 2]; }
    if (I) B.inten[j] = I[k];
  }
  const out = B.finish();
  if (out.intensity) { let mx = 0, mn = Infinity; for (const v of out.intensity) { if (v > mx) mx = v; if (v < mn) mn = v; } for (let i = 0; i < out.n; i++) out.intensity[i] = (out.intensity[i] - mn) / ((mx - mn) || 1); }
  out.meta = { format: 'PLY ' + format, total: vEl.count, stride: 1 };
  return out;
}

// ---------- STL / OBJ meshes (returns Float64 triangle soup, world coords) ----------
async function readSTL(src) {
  const ab = await src.read(0, src.size); const u8 = new Uint8Array(ab);
  const dv = new DataView(ab);
  const head = new TextDecoder().decode(u8.subarray(0, Math.min(512, u8.length)));
  const nb = u8.length >= 84 ? dv.getUint32(80, true) : 0;
  if (u8.length === 84 + nb * 50 && nb > 0) {
    const t = new Float64Array(nb * 9);
    for (let i = 0; i < nb; i++) for (let k = 0; k < 9; k++) t[i * 9 + k] = dv.getFloat32(84 + i * 50 + 12 + k * 4, true);
    return { mesh: true, tris: t, meta: { format: 'STL binary', triangles: nb } };
  }
  if (!/^\s*solid/.test(head)) throw new Error('Unrecognised STL');
  const txt = new TextDecoder().decode(u8); const re = /vertex\s+([-+\deE.]+)\s+([-+\deE.]+)\s+([-+\deE.]+)/g; const v = []; let m;
  while ((m = re.exec(txt))) v.push(+m[1], +m[2], +m[3]);
  return { mesh: true, tris: Float64Array.from(v), meta: { format: 'STL ASCII', triangles: v.length / 9 } };
}
async function readOBJ(src) {
  const txt = new TextDecoder().decode(await src.read(0, src.size));
  const V = [], T = [];
  for (const line of txt.split(/\r?\n/)) {
    if (line.startsWith('v ')) { const p = line.trim().split(/\s+/); V.push(+p[1], +p[2], +p[3]); }
    else if (line.startsWith('f ')) {
      const idx = line.trim().split(/\s+/).slice(1).map(s => { const i = parseInt(s.split('/')[0], 10); return i < 0 ? V.length / 3 + i : i - 1; });
      for (let j = 1; j < idx.length - 1; j++) for (const q of [idx[0], idx[j], idx[j + 1]]) T.push(V[q * 3], V[q * 3 + 1], V[q * 3 + 2]);
    }
  }
  return { mesh: true, tris: Float64Array.from(T), meta: { format: 'OBJ', triangles: T.length / 9 } };
}

async function readAny(src, opts) {
  const ext = (src.name.split('.').pop() || '').toLowerCase();
  if (ext === 'las' || ext === 'laz') return readLAS(src, opts);
  if (ext === 'e57') return readE57(src, opts);
  if (ext === 'ply') return readPLY(src, opts);
  if (ext === 'stl') return readSTL(src, opts);
  if (ext === 'obj') return readOBJ(src, opts);
  if (['xyz', 'txt', 'csv', 'pts', 'asc', 'neu'].includes(ext)) return readText(src, opts);
  throw new Error('Unsupported file type .' + ext);
}

// ---------- writers ----------
function writeLAS(L, origin) {
  // LAS 1.2 point format 2 (RGB) — widest compatibility
  const n = L.n, recLen = 26, hdr = 227;
  const buf = new ArrayBuffer(hdr + n * recLen); const dv = new DataView(buf); const u8 = new Uint8Array(buf);
  'LASF'.split('').forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
  dv.setUint8(24, 1); dv.setUint8(25, 2);
  const sw = 'ScanBench'; for (let i = 0; i < sw.length; i++) dv.setUint8(58 + i, sw.charCodeAt(i));
  const now = new Date(); const doy = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 864e5);
  dv.setUint16(90, doy, true); dv.setUint16(92, now.getFullYear(), true);
  dv.setUint16(94, hdr, true); dv.setUint32(96, hdr, true); dv.setUint32(100, 0, true);
  dv.setUint8(104, 2); dv.setUint16(105, recLen, true); dv.setUint32(107, n, true); dv.setUint32(111, n, true);
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { const v = L.pos[i * 3 + k] + origin[k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
  if (!n) { mn.fill(0); mx.fill(0); }
  const sc = 0.0001;
  const off = mn.map(v => Math.floor(v));
  for (let k = 0; k < 3; k++) { dv.setFloat64(131 + k * 8, sc, true); dv.setFloat64(155 + k * 8, off[k], true); }
  dv.setFloat64(179, mx[0], true); dv.setFloat64(187, mn[0], true); dv.setFloat64(195, mx[1], true); dv.setFloat64(203, mn[1], true); dv.setFloat64(211, mx[2], true); dv.setFloat64(219, mn[2], true);
  const d0 = origin.map((o, k) => o - off[k]);
  for (let i = 0; i < n; i++) {
    const p = hdr + i * recLen;
    dv.setInt32(p, Math.round((L.pos[i * 3] + d0[0]) / sc), true);
    dv.setInt32(p + 4, Math.round((L.pos[i * 3 + 1] + d0[1]) / sc), true);
    dv.setInt32(p + 8, Math.round((L.pos[i * 3 + 2] + d0[2]) / sc), true);
    dv.setUint16(p + 12, L.intensity ? Math.round(L.intensity[i] * 65535) : 0, true);
    dv.setUint8(p + 14, 0x09);
    dv.setUint8(p + 15, L.cls ? L.cls[i] & 31 : 1);
    if (L.rgb) { dv.setUint16(p + 20, L.rgb[i * 3] * 257, true); dv.setUint16(p + 22, L.rgb[i * 3 + 1] * 257, true); dv.setUint16(p + 24, L.rgb[i * 3 + 2] * 257, true); }
  }
  return u8;
}
function writePLY(L, origin) {
  const n = L.n, rec = 3 * 8 + 3 + 4 + (L.sf ? 4 : 0);
  const sfName = L.sfName || 'scalar';
  let head = 'ply\nformat binary_little_endian 1.0\ncomment ScanBench export\nelement vertex ' + n + '\nproperty double x\nproperty double y\nproperty double z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty float scalar_Intensity\n' + (L.sf ? 'property float scalar_' + sfName.replace(/\W+/g, '_') + '\n' : '') + 'end_header\n';
  const hb = new TextEncoder().encode(head);
  const u8 = new Uint8Array(hb.length + n * rec); u8.set(hb); const dv = new DataView(u8.buffer);
  for (let i = 0; i < n; i++) {
    let p = hb.length + i * rec;
    for (let k = 0; k < 3; k++) { dv.setFloat64(p, L.pos[i * 3 + k] + origin[k], true); p += 8; }
    for (let k = 0; k < 3; k++) dv.setUint8(p++, L.rgb ? L.rgb[i * 3 + k] : 200);
    dv.setFloat32(p, L.intensity ? L.intensity[i] : 0, true); p += 4;
    if (L.sf) dv.setFloat32(p, L.sf[i], true);
  }
  return u8;
}
function writeXYZ(L, origin, withHeader) {
  const parts = []; const cols = ['X', 'Y', 'Z'];
  if (L.rgb) cols.push('R', 'G', 'B'); if (L.intensity) cols.push('Intensity'); if (L.sf) cols.push(L.sfName || 'Scalar');
  if (withHeader) parts.push(cols.join(',') + '\n');
  let s = '';
  for (let i = 0; i < L.n; i++) {
    s += (L.pos[i * 3] + origin[0]).toFixed(4) + ',' + (L.pos[i * 3 + 1] + origin[1]).toFixed(4) + ',' + (L.pos[i * 3 + 2] + origin[2]).toFixed(4);
    if (L.rgb) s += ',' + L.rgb[i * 3] + ',' + L.rgb[i * 3 + 1] + ',' + L.rgb[i * 3 + 2];
    if (L.intensity) s += ',' + L.intensity[i].toFixed(4);
    if (L.sf) s += ',' + (isFinite(L.sf[i]) ? L.sf[i].toFixed(5) : '');
    s += '\n';
    if (s.length > 1 << 20) { parts.push(s); s = ''; }
  }
  parts.push(s); return parts;
}
// DXF R12: entities = [{type:'POINT',p}, {type:'LINE',a,b}, {type:'POLY',pts,closed}, {type:'TEXT',p,h,text}] with .layer
// opts: {layerColors: {LAYER: aciColour}, comment: 'text written as 999 comment lines'}
function writeDXF(entities, opts = {}) {
  const o = [];
  if (opts.comment) for (const line of String(opts.comment).split('\n')) o.push('999', line);
  // header extents help AutoCAD zoom-extents on open
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  const ext = p => { if (!p) return; for (let k = 0; k < 3; k++) { const v = p[k] || 0; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; } };
  for (const e of entities) { ext(e.p); ext(e.a); ext(e.b); ext(e.c); if (e.pts) for (const q of e.pts) ext(q); }
  const f = v => (Math.round(v * 1e5) / 1e5).toString();
  o.push('0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009');
  if (isFinite(mn[0])) o.push('9', '$EXTMIN', '10', f(mn[0]), '20', f(mn[1]), '30', f(mn[2]), '9', '$EXTMAX', '10', f(mx[0]), '20', f(mx[1]), '30', f(mx[2]));
  o.push('0', 'ENDSEC', '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', '0');
  const layers = [...new Set(entities.map(e => e.layer || '0'))]; const lc = opts.layerColors || {};
  layers.forEach((l, i) => o.push('0', 'LAYER', '2', l, '70', '0', '62', String(lc[l] || ((i % 6) + 1)), '6', 'CONTINUOUS'));
  o.push('0', 'ENDTAB', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES');
  for (const e of entities) {
    const L = e.layer || '0';
    if (e.type === 'POINT') o.push('0', 'POINT', '8', L, '10', f(e.p[0]), '20', f(e.p[1]), '30', f(e.p[2]));
    else if (e.type === 'LINE') o.push('0', 'LINE', '8', L, '10', f(e.a[0]), '20', f(e.a[1]), '30', f(e.a[2]), '11', f(e.b[0]), '21', f(e.b[1]), '31', f(e.b[2]));
    else if (e.type === 'TEXT') { o.push('0', 'TEXT', '8', L, '10', f(e.p[0]), '20', f(e.p[1]), '30', f(e.p[2]), '40', f(e.h || 0.1), '1', String(e.text).replace(/[\r\n]+/g, ' ')); if (e.rot) o.push('50', f(e.rot)); if (e.center) o.push('72', '1', '73', '2', '11', f(e.p[0]), '21', f(e.p[1]), '31', f(e.p[2])); }
    else if (e.type === 'CIRCLE') o.push('0', 'CIRCLE', '8', L, '10', f(e.p[0]), '20', f(e.p[1]), '30', f(e.p[2]), '40', f(e.r));
    else if (e.type === '3DFACE') { const q = e.pts, d = q[3] || q[2]; o.push('0', '3DFACE', '8', L, '10', f(q[0][0]), '20', f(q[0][1]), '30', f(q[0][2]), '11', f(q[1][0]), '21', f(q[1][1]), '31', f(q[1][2]), '12', f(q[2][0]), '22', f(q[2][1]), '32', f(q[2][2]), '13', f(d[0]), '23', f(d[1]), '33', f(d[2])); }
    else if (e.type === 'POLY') {
      o.push('0', 'POLYLINE', '8', L, '66', '1', '10', '0', '20', '0', '30', '0', '70', String(8 | (e.closed ? 1 : 0)));
      for (const p of e.pts) o.push('0', 'VERTEX', '8', L, '10', f(p[0]), '20', f(p[1]), '30', f(p[2]), '70', '32');
      o.push('0', 'SEQEND', '8', L);
    }
  }
  o.push('0', 'ENDSEC', '0', 'EOF');
  return o.join('\n') + '\n';
}
// Minimal ZIP (stored) so non-allowlisted formats can be downloaded inside a .zip
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function makeZip(files) { // files: [{name, data:Uint8Array}]
  const enc = new TextEncoder(); const parts = []; const central = []; let off = 0;
  for (const f of files) {
    const nm = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint32(14, crc, true); lh.setUint32(18, sz, true); lh.setUint32(22, sz, true); lh.setUint16(26, nm.length, true);
    parts.push(new Uint8Array(lh.buffer), nm, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint32(16, crc, true); ch.setUint32(20, sz, true); ch.setUint32(24, sz, true); ch.setUint16(28, nm.length, true); ch.setUint32(42, off, true);
    central.push(new Uint8Array(ch.buffer), nm);
    off += 30 + nm.length + sz;
  }
  const cs = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cs, true); end.setUint32(16, off, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

// ---------- LAZ chunk table (LASzip arithmetic-coded integers): lets LAZ files of any size be decoded chunk by chunk ----------
function lazChunkSizes(u8, variable) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); if (dv.getUint32(0, true) !== 0) throw new Error('Unsupported LAZ chunk table version.');
  const nChunks = dv.getUint32(4, true); let p = 8; const next = () => (p < u8.length ? u8[p++] : 0);
  let value = ((next() << 24) | (next() << 16) | (next() << 8) | next()) >>> 0, length = 0xFFFFFFFF; const MIN = 1 << 24;
  const renorm = () => { do { value = ((value << 8) | next()) >>> 0; length = (length << 8) >>> 0; } while (length < MIN); };
  const mul = (a, b) => Math.imul(a, b) >>> 0;
  const bitModel = () => ({ c0: 1, cn: 2, p0: 1 << 12, cyc: 4, left: 4 });
  const decBit = m => { const x = mul(m.p0, length >>> 13); const sym = value >= x ? 1 : 0; if (!sym) { length = x; m.c0++; } else { value = (value - x) >>> 0; length = (length - x) >>> 0; } if (length < MIN) renorm();
    if (--m.left === 0) { m.cn += m.cyc; if (m.cn > 8192) { m.cn = (m.cn + 1) >>> 1; m.c0 = (m.c0 + 1) >>> 1; if (m.c0 === m.cn) m.cn++; } const sc = Math.floor(0x80000000 / m.cn); m.p0 = mul(m.c0, sc) >>> 18; m.cyc = (5 * m.cyc) >>> 2; if (m.cyc > 64) m.cyc = 64; m.left = m.cyc; } return sym; };
  const symModel = n => { const m = { n, last: n - 1, dist: new Uint32Array(n), cnt: new Uint32Array(n).fill(1), total: 0, cyc: n, left: 0, table: null, tsize: 0, tshift: 0 };
    if (n > 16) { let tb = 3; while (n > (1 << (tb + 2))) tb++; m.tsize = 1 << tb; m.tshift = 15 - tb; m.table = new Uint32Array(m.tsize + 2); }
    symUpdate(m); m.left = m.cyc = (n + 6) >>> 1; return m; };
  const symUpdate = m => { if ((m.total += m.cyc) > 32768) { m.total = 0; for (let k = 0; k < m.n; k++) m.total += (m.cnt[k] = (m.cnt[k] + 1) >>> 1); }
    let sum = 0, s = 0; const sc = Math.floor(0x80000000 / m.total);
    if (m.table) { for (let k = 0; k < m.n; k++) { m.dist[k] = mul(sc, sum) >>> 16; sum += m.cnt[k]; const w = m.dist[k] >>> m.tshift; while (s < w) m.table[++s] = k - 1; } m.table[0] = 0; while (s <= m.tsize) m.table[++s] = m.n - 1; }
    else for (let k = 0; k < m.n; k++) { m.dist[k] = mul(sc, sum) >>> 16; sum += m.cnt[k]; }
    m.cyc = (5 * m.cyc) >>> 2; const mx = (m.n + 6) << 3; if (m.cyc > mx) m.cyc = mx; m.left = m.cyc; };
  const decSym = m => { let n, sym, x, y = length;
    if (m.table) { length >>>= 15; const d = Math.floor(value / length), t = d >>> m.tshift; sym = m.table[t]; n = m.table[t + 1] + 1; while (n > sym + 1) { const k = (sym + n) >>> 1; if (m.dist[k] > d) n = k; else sym = k; } x = mul(m.dist[sym], length); if (sym !== m.last) y = mul(m.dist[sym + 1], length); }
    else { x = sym = 0; length >>>= 15; n = m.n; let k = n >>> 1; do { const z = mul(length, m.dist[k]); if (z > value) { n = k; y = z; } else { sym = k; x = z; } } while ((k = (sym + n) >>> 1) !== sym); }
    value = (value - x) >>> 0; length = (y - x) >>> 0; if (length < MIN) renorm(); m.cnt[sym]++; if (--m.left === 0) symUpdate(m); return sym; };
  const readShort = () => { length >>>= 16; const s = Math.floor(value / length); value = (value - mul(length, s)) >>> 0; if (length < MIN) renorm(); return s; };
  const readBits = bits => { if (bits > 19) { const lo = readShort(); const hi = readBits(bits - 16); return ((hi << 16) | lo) >>> 0; } length >>>= bits; const s = Math.floor(value / length); value = (value - mul(length, s)) >>> 0; if (length < MIN) renorm(); return s; };
  // IntegerCompressor(bits 32, 2 contexts, bits_high 8)
  const mBits = [symModel(33), symModel(33)], c0 = bitModel(), mCorr = [null]; for (let i = 1; i <= 32; i++) mCorr.push(symModel(i <= 8 ? 1 << i : 256));
  const corrector = ctx => { const k = decSym(mBits[ctx]); let c; if (k) { if (k < 32) { if (k <= 8) c = decSym(mCorr[k]); else { const k1 = k - 8; c = decSym(mCorr[k]); c = ((c << k1) | readBits(k1)) >>> 0; } if (c >= ((1 << (k - 1)) >>> 0)) c += 1; else c -= ((1 << k) >>> 0) - 1; } else c = -2147483648; } else c = decBit(c0); return c; };
  const sizes = new Array(nChunks), totals = variable ? new Array(nChunks) : null;
  for (let i = 0; i < nChunks; i++) { if (variable) totals[i] = ((i ? totals[i - 1] : 0) + corrector(0)) >>> 0; sizes[i] = ((i ? sizes[i - 1] : 0) + corrector(1)) >>> 0; }
  return { sizes, totals };
}

const SBIO = { lazChunkSizes, fileSource, readAny, readLAS, readE57, readText, readPLY, readSTL, readOBJ, writeLAS, writePLY, writeXYZ, writeDXF, makeZip, crc32, parseXML };
if (typeof module !== 'undefined') module.exports = SBIO; else SB.SBIO = SBIO;
