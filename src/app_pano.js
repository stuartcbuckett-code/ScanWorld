// ---------- 360° VIEWS: scan stations from E57 files (a panorama made from the scan's own points, or the photos inside the E57) and imported geo-referenced 360° photos ----------
// Standing at a station: the camera sits on the scanner's position and turns on the spot; wheel zooms the lens. Measuring still picks real scan points.
const PANO = { list: [], active: null, scene: null, cam: null, mesh: null, overlay: false, saved: null, fov0: 50, idc: 1 };
const TAU = Math.PI * 2;
const panoLocal = (R, v) => [R[0] * v[0] + R[3] * v[1] + R[6] * v[2], R[1] * v[0] + R[4] * v[1] + R[7] * v[2], R[2] * v[0] + R[5] * v[1] + R[8] * v[2]];   // Rᵀ·v
const panoWorld = (R, v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];   // R·v
const rotZ = a => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
// equirectangular convention used everywhere here: u = 0.5 + flip·az/2π + off (az from +x towards +y), v from +90° (top row) to −90°
function panoUV(d, flip, off) { const az = Math.atan2(d[1], d[0]), el = Math.asin(Math.max(-1, Math.min(1, d[2] / (Math.hypot(d[0], d[1], d[2]) || 1)))); let u = 0.5 + flip * az / TAU + off; u -= Math.floor(u); return [u, 0.5 - el / Math.PI]; }

function panoMaterial() {
  return new THREE.ShaderMaterial({ side: THREE.BackSide, depthTest: false, depthWrite: false,
    uniforms: { tMap: { value: null }, uRinv: { value: new THREE.Matrix3() }, uFlip: { value: 1 }, uOff: { value: 0 } },
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform sampler2D tMap; uniform mat3 uRinv; uniform float uFlip; uniform float uOff; varying vec3 vP; void main(){ vec3 d = normalize(uRinv * normalize(vP)); float az = atan(d.y, d.x); float el = asin(clamp(d.z,-1.0,1.0)); vec2 uv = vec2(fract(0.5 + uFlip*az/6.28318530718 + uOff), 0.5 + el/3.14159265359); gl_FragColor = vec4(texture2D(tMap, uv).rgb, 1.0); }' });
}
function panoTex(src) { const t = new THREE.Texture(src); t.needsUpdate = true; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false; t.wrapS = THREE.RepeatWrapping; return t; }

// ----- a panorama from the scan's own points: each point lands on the pixel of its direction, nearest wins, gaps filled from neighbours -----
async function panoFromPoints(L, st) {
  const [a, b] = st.range, n = b - a; if (n < 100) return null;
  const W_ = Math.max(1024, Math.min(4096, 2 ** Math.round(Math.log2(Math.sqrt(n * 2))))), H_ = W_ / 2, N = W_ * H_;
  const rng = new Float32Array(N).fill(Infinity), col = new Uint8ClampedArray(N * 4), P = L.pos, C = L.rgb, I = L.intensity, c = st.pos;
  for (let i = a; i < b; i++) {
    const v = panoLocal(st.R, [P[i * 3] - c.x, P[i * 3 + 1] - c.y, P[i * 3 + 2] - c.z]); const r = Math.hypot(v[0], v[1], v[2]); if (!(r > 0.05)) continue;
    const [u, w] = panoUV(v, 1, 0); const k = Math.min(H_ - 1, Math.floor(w * H_)) * W_ + Math.min(W_ - 1, Math.floor(u * W_));
    if (r < rng[k]) { rng[k] = r; if (C) { col[k * 4] = C[i * 3]; col[k * 4 + 1] = C[i * 3 + 1]; col[k * 4 + 2] = C[i * 3 + 2]; } else { const g = I ? Math.round(I[i] * 255) : 180; col[k * 4] = col[k * 4 + 1] = col[k * 4 + 2] = g; } col[k * 4 + 3] = 255; }
    if ((i & 0xfffff) === 0) await tick();
  }
  // fill gaps: up to 4 passes, each empty pixel takes its nearest-range neighbour (wrapping across the seam)
  for (let pass = 0; pass < 4; pass++) {
    const src = rng.slice(), sc = col.slice(); let filled = 0;
    for (let y = 0; y < H_; y++) for (let x = 0; x < W_; x++) {
      const k = y * W_ + x; if (src[k] !== Infinity) continue; let best = Infinity, bk = -1;
      for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= H_) continue; for (let dx = -1; dx <= 1; dx++) { const kk = yy * W_ + ((x + dx + W_) % W_); if (src[kk] < best) { best = src[kk]; bk = kk; } } }
      if (bk >= 0) { rng[k] = best; col[k * 4] = sc[bk * 4]; col[k * 4 + 1] = sc[bk * 4 + 1]; col[k * 4 + 2] = sc[bk * 4 + 2]; col[k * 4 + 3] = 255; filled++; }
    }
    if (!filled) break; await tick();
  }
  for (let k = 0; k < N; k++) if (!col[k * 4 + 3]) { col[k * 4] = 14; col[k * 4 + 1] = 18; col[k * 4 + 2] = 24; col[k * 4 + 3] = 255; }   // never seen: dark
  const cv = document.createElement('canvas'); cv.width = W_; cv.height = H_; cv.getContext('2d').putImageData(new ImageData(col, W_, H_), 0, 0); return cv;
}

// ----- photos inside the E57: spherical ones are used as they are, pinhole ones are stitched onto a sphere. Orientation conventions differ between scanners,
// so each candidate is scored against the scan's own colours (or intensity) and the best one kept. -----
function panoSamples(L, st, max = 4000) {
  const [a, b] = st.range, n = b - a, step = Math.max(1, Math.floor(n / max)), out = [];
  for (let i = a; i < b; i += step) { const p = [L.pos[i * 3], L.pos[i * 3 + 1], L.pos[i * 3 + 2]]; const lum = L.rgb ? (0.3 * L.rgb[i * 3] + 0.59 * L.rgb[i * 3 + 1] + 0.11 * L.rgb[i * 3 + 2]) : L.intensity ? L.intensity[i] * 255 : null; if (lum === null) return []; out.push({ p, lum }); }
  return out;
}
function corr(xs, ys) { const n = xs.length; if (n < 30) return -1; let mx = 0, my = 0; for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; } mx /= n; my /= n; let sxy = 0, sx = 0, sy = 0; for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; sxy += a * b; sx += a * a; sy += b * b; } return sxy / Math.sqrt(sx * sy || 1); }
async function decodeImg(bytes, mime) { return createImageBitmap(new Blob([bytes], { type: mime })); }
function bitmapPixels(bm, maxW = 2048) { const s = Math.min(1, maxW / bm.width), w = Math.max(1, Math.round(bm.width * s)), h = Math.max(1, Math.round(bm.height * s)); const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(bm, 0, 0, w, h); return { w, h, d: g.getImageData(0, 0, w, h).data }; }
const lumAt = (px, u, v) => { const x = Math.min(px.w - 1, Math.max(0, Math.floor(u * px.w))), y = Math.min(px.h - 1, Math.max(0, Math.floor(v * px.h))), k = (y * px.w + x) * 4; return 0.3 * px.d[k] + 0.59 * px.d[k + 1] + 0.11 * px.d[k + 2]; };

async function panoFromSpherical(L, st, im) {
  const bm = await decodeImg(await im.read(), im.mime); const R = im.R || st.R, c = im.T ? [im.T[0] - S.origin[0], im.T[1] - S.origin[1], im.T[2] - S.origin[2]] : [st.pos.x, st.pos.y, st.pos.z];
  let best = { flip: -1, off: 0, score: -2 }; const smp = panoSamples(L, st);
  if (smp.length) { const px = bitmapPixels(bm, 1024); for (const flip of [-1, 1]) for (const off of [0, 0.25, 0.5, 0.75]) { const xs = [], ys = []; for (const s of smp) { const v = panoLocal(R, [s.p[0] - c[0], s.p[1] - c[1], s.p[2] - c[2]]); const [u, w] = panoUV(v, flip, off); xs.push(lumAt(px, u, w)); ys.push(s.lum); } const sc = corr(xs, ys); if (sc > best.score) best = { flip, off, score: sc }; } }
  return { img: bm, R, flip: best.flip, off: best.off, score: best.score };
}
async function panoFromPinholes(L, st, ims) {
  const views = []; for (const im of ims) { try { const bm = await decodeImg(await im.read(), im.mime); const px = bitmapPixels(bm, 1600); const f = im.pixelWidth > 0 ? im.focalLength / im.pixelWidth : im.width; const s = px.w / (im.width || px.w);
    views.push({ px, R: im.R || st.R, f: f * s, cx: (isFinite(im.cx) ? im.cx : im.width / 2) * s, cy: (isFinite(im.cy) ? im.cy : im.height / 2) * s }); } catch (e) { } }
  if (!views.length) return null;
  // camera conventions: A looks along +z with y down (computer vision); B looks along −z with y up (OpenGL)
  const proj = (V, d, conv) => { const q = panoLocal(V.R, d); const z = conv === 'A' ? q[2] : -q[2]; if (z <= 1e-6) return null; const x = V.cx + V.f * q[0] / z, y = conv === 'A' ? V.cy + V.f * q[1] / z : V.cy - V.f * q[1] / z; return x >= 0 && y >= 0 && x < V.px.w && y < V.px.h ? [x, y] : null; };
  let conv = 'A'; const smp = panoSamples(L, st);
  if (smp.length) { let bs = -2; for (const cv of ['A', 'B']) { const xs = [], ys = []; for (const s of smp) { const d = [s.p[0] - st.pos.x, s.p[1] - st.pos.y, s.p[2] - st.pos.z]; for (const V of views) { const r = proj(V, d, cv); if (r) { const k = (Math.floor(r[1]) * V.px.w + Math.floor(r[0])) * 4; xs.push(0.3 * V.px.d[k] + 0.59 * V.px.d[k + 1] + 0.11 * V.px.d[k + 2]); ys.push(s.lum); break; } } } const sc = corr(xs, ys); if (sc > bs) { bs = sc; conv = cv; } } }
  const W_ = 4096, H_ = 2048, out = new Uint8ClampedArray(W_ * H_ * 4);
  for (let y = 0; y < H_; y++) {
    const el = Math.PI / 2 - (y + 0.5) / H_ * Math.PI;
    for (let x = 0; x < W_; x++) {
      const az = ((x + 0.5) / W_ - 0.5) * TAU; const dl = [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)]; const d = panoWorld(st.R, dl); const k = (y * W_ + x) * 4;
      let hit = false; for (const V of views) { const r = proj(V, d, conv); if (r) { const j = (Math.floor(r[1]) * V.px.w + Math.floor(r[0])) * 4; out[k] = V.px.d[j]; out[k + 1] = V.px.d[j + 1]; out[k + 2] = V.px.d[j + 2]; out[k + 3] = 255; hit = true; break; } }
      if (!hit) { out[k] = 14; out[k + 1] = 18; out[k + 2] = 24; out[k + 3] = 255; }
    }
    if ((y & 63) === 0) await tick();
  }
  const cv = document.createElement('canvas'); cv.width = W_; cv.height = H_; cv.getContext('2d').putImageData(new ImageData(out, W_, H_), 0, 0); return cv;
}

// ----- stations from an E57 that was just loaded -----
function addE57Stations(L, data) {
  const scans = (data.meta && data.meta.scans) || []; const ims = data.images2D || []; let added = 0;
  scans.forEach((sc, si) => {
    if (!sc.range || !sc.pose) return; const T = sc.pose.T;
    const myIms = ims.filter(im => (sc.guid && im.scanGuid === sc.guid) || (!im.scanGuid && scans.length === 1));
    PANO.list.push({ id: PANO.idc++, kind: 'station', name: sc.name || 'Scan ' + (si + 1), layer: L, range: sc.range, R: sc.pose.R, pos: new THREE.Vector3(T[0] - S.origin[0], T[1] - S.origin[1], T[2] - S.origin[2]), photos: myIms, show: myIms.length ? 'photo' : 'scan', flip: 1, off: 0, tex: {} });
    added++;
  });
  if (added) { refreshPanoPanel(); panoMarkers(); toast(added + ' scan station' + (added > 1 ? 's' : '') + ' found' + (ims.length ? ' with ' + ims.length + ' embedded photo' + (ims.length > 1 ? 's' : '') : '') + '. Open one from "360° views" (left panel) to stand at the scanner.'); }
}
const _addCloudP = addCloud;
addCloud = function (name, data, extra) { const L = _addCloudP(name, data, extra); try { if (data && data.meta && data.meta.scans && data.meta.scans.some(s => s.range)) addE57Stations(L, data); } catch (e) { console.warn(e); } return L; };

// ----- geo-referenced 360° photos (equirectangular JPEGs): position from EXIF GPS, or from a CSV/TXT list of name, E, N, Z, heading -----
function exifGeo(buf) {
  const dv = new DataView(buf); if (dv.getUint16(0) !== 0xFFD8) return null; let p = 2, res = {};
  while (p + 4 < dv.byteLength) {
    const m = dv.getUint16(p), len = dv.getUint16(p + 2); if ((m & 0xFF00) !== 0xFF00) break;
    if (m === 0xFFE1) {
      const head = String.fromCharCode(...new Uint8Array(buf, p + 4, 6));
      if (head.startsWith('Exif')) { try { Object.assign(res, tiffGps(new DataView(buf, p + 10, len - 8))); } catch (e) { } }
      else { const s = new TextDecoder().decode(new Uint8Array(buf, p + 4, len - 2)); const g = k => { const r = s.match(new RegExp('GPano:' + k + '(?:="|>)\\s*(-?[\\d.]+)')); return r ? +r[1] : undefined; }; ['PoseHeadingDegrees', 'PosePitchDegrees', 'PoseRollDegrees'].forEach(k => { const v = g(k); if (v !== undefined) res[k] = v; }); if (/ProjectionType(?:="|>)\s*equirectangular/.test(s)) res.equirect = true; }
    }
    if (m === 0xFFDA) break; p += 2 + len;
  }
  return res;
}
function tiffGps(dv) {
  const le = dv.getUint16(0) === 0x4949, u16 = o => dv.getUint16(o, le), u32 = o => dv.getUint32(o, le);
  const ifd = (o, f) => { const n = u16(o); for (let i = 0; i < n; i++) { const e = o + 2 + i * 12; f(u16(e), u16(e + 2), u32(e + 4), e + 8); } };
  let gpsOff = 0; ifd(u32(4), (tag, type, cnt, vo) => { if (tag === 0x8825) gpsOff = u32(vo); }); if (!gpsOff) return {};
  const rat = (o, k) => u32(o + k * 8) / (u32(o + k * 8 + 4) || 1); const g = {};
  ifd(gpsOff, (tag, type, cnt, vo) => { const off = cnt * (type === 5 ? 8 : 1) > 4 ? u32(vo) : vo;
    if (tag === 1) g.latRef = String.fromCharCode(dv.getUint8(vo)); if (tag === 3) g.lonRef = String.fromCharCode(dv.getUint8(vo)); if (tag === 5) g.altRef = dv.getUint8(vo);
    if (tag === 2) g.lat = rat(off, 0) + rat(off, 1) / 60 + rat(off, 2) / 3600; if (tag === 4) g.lon = rat(off, 0) + rat(off, 1) / 60 + rat(off, 2) / 3600; if (tag === 6) g.alt = rat(off, 0); if (tag === 17) g.dir = rat(off, 0); });
  if (g.lat === undefined || g.lon === undefined) return {};
  return { lat: g.latRef === 'S' ? -g.lat : g.lat, lon: g.lonRef === 'W' ? -g.lon : g.lon, alt: g.alt !== undefined ? (g.altRef === 1 ? -g.alt : g.alt) : undefined, dir: g.dir };
}
function parsePosList(text) {   // name, E, N, Z[, heading[, pitch, roll]] — or name, lat, lon, h — with or without a header line; comma, tab, semicolon or spaces
  const out = {}; for (const line of text.split(/\r?\n/)) { const f = line.trim().split(/\s*[,;\t]\s*|\s+/); if (f.length < 4) continue; const nums = f.slice(1).map(Number); if (!isFinite(nums[0]) || !isFinite(nums[1])) continue;
    const key = f[0].replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').toLowerCase(); out[key] = { a: nums[0], b: nums[1], z: isFinite(nums[2]) ? nums[2] : 0, heading: isFinite(nums[3]) ? nums[3] : undefined, pitch: isFinite(nums[4]) ? nums[4] : 0, roll: isFinite(nums[5]) ? nums[5] : 0 }; }
  return out;
}
async function importPanos(files) {
  const lists = {}; for (const f of files.filter(f => /\.(csv|txt)$/i.test(f.name))) Object.assign(lists, parsePosList(await f.text()));
  const imgs = files.filter(f => /\.(jpe?g|png)$/i.test(f.name)); let added = 0, skipped = [];
  const C = S.crs ? X_.byId(S.crs) : null;
  for (const f of imgs) {
    const key = f.name.replace(/\.[^.]+$/, '').toLowerCase(); const row = lists[key]; let ex = {}; try { ex = exifGeo(await f.slice(0, 256 * 1024).arrayBuffer()) || {}; } catch (e) { }
    let world = null, heading = row && row.heading !== undefined ? row.heading : ex.PoseHeadingDegrees !== undefined ? ex.PoseHeadingDegrees : ex.dir;
    if (row) { const geo = Math.abs(row.a) <= 90 && Math.abs(row.b) <= 180 && Math.abs(row.a) > 0.001 && Math.abs(row.b) > 0.001; if (geo) { if (!C || C.type === 'local') { skipped.push(f.name + ' (latitude/longitude needs the project coordinate system set)'); continue; } world = C.type === 'geo' ? [row.b, row.a, row.z] : X_.convertPoint(row.b, row.a, row.z, C.datum, S.crs); world[2] = row.z; } else world = [row.a, row.b, row.z]; }
    else if (ex.lat !== undefined) { if (!C || C.type === 'local') { skipped.push(f.name + ' (has GPS; set the project coordinate system first)'); continue; } const z = ex.alt !== undefined ? ex.alt : 0; world = C.type === 'geo' ? [ex.lon, ex.lat, z] : X_.convertPoint(ex.lon, ex.lat, z, C.datum, S.crs); world[2] = z; }
    if (!world) { skipped.push(f.name + ' (no GPS and not in a position list)'); continue; }
    if (!S.origin) S.origin = [Math.round(world[0]), Math.round(world[1]), Math.round(world[2])];
    // a 360° camera image: the centre column looks along the heading (degrees clockwise from north) and the image runs clockwise to the right
    const hdg = (heading || 0) * Math.PI / 180;
    PANO.list.push({ id: PANO.idc++, kind: 'photo', name: f.name, file: f, R: rotZ(Math.PI / 2 - hdg), pos: new THREE.Vector3(world[0] - S.origin[0], world[1] - S.origin[1], world[2] - S.origin[2]), show: 'photo', flip: -1, off: 0, tex: {}, heading: heading || 0, noHeading: heading === undefined });
    added++;
  }
  refreshPanoPanel(); panoMarkers(); S.dirty = true;
  if (added) toast(added + ' 360° photo' + (added > 1 ? 's' : '') + ' placed.' + (skipped.length ? ' Skipped: ' + skipped.join('; ') : '')); else if (skipped.length) toast('No photos placed. ' + skipped.join('; '), true);
  return added;
}

// ----- textures, built when a view is first opened -----
async function panoTexture(st) {
  const mode = st.show; if (st.tex[mode]) return st.tex[mode];
  if (st.kind === 'photo') { const bm = await createImageBitmap(st.file); st.tex.photo = { tex: panoTex(bm), flip: -1, off: 0 }; return st.tex.photo; }
  if (mode === 'photo' && st.photos && st.photos.length) {
    const sph = st.photos.find(p => p.kind === 'spherical');
    if (sph) { const r = await busy('Reading the panoramic photo…', async () => panoFromSpherical(st.layer, st, sph)); if (r) { st.tex.photo = { tex: panoTex(r.img), flip: r.flip, off: r.off, R: r.R }; return st.tex.photo; } }
    const pin = st.photos.filter(p => p.kind === 'pinhole');
    if (pin.length) { const cv = await busy('Stitching ' + pin.length + ' photo' + (pin.length > 1 ? 's' : '') + ' into a panorama…', async () => panoFromPinholes(st.layer, st, pin)); if (cv) { st.tex.photo = { tex: panoTex(cv), flip: 1, off: 0 }; return st.tex.photo; } }
    st.show = 'scan';
  }
  const cv = await busy('Building the panorama from the scan points…', async () => panoFromPoints(st.layer, st)); if (!cv) return null;
  st.tex.scan = { tex: panoTex(cv), flip: 1, off: 0 }; return st.tex.scan;
}

// ----- standing at a station -----
async function panoOpen(st) {
  const t = await panoTexture(st); if (!t) { toast('Not enough points in that scan to build a view.', true); return; }
  if (!PANO.active) { PANO.saved = camState(); PANO.fov0 = persp.fov; }
  if (!PANO.scene) { PANO.scene = new THREE.Scene(); PANO.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), panoMaterial()); PANO.mesh.frustumCulled = false; PANO.scene.add(PANO.mesh); PANO.cam = new THREE.PerspectiveCamera(); }
  PANO.active = st; const u = PANO.mesh.material.uniforms; u.tMap.value = t.tex; panoOrient(st, t);
  if (S.cam.ortho) toggleOrtho();
  S.cam.target.copy(st.pos); S.cam.dist = 0.01; if (S.cam.pitch > 0.3) S.cam.pitch = 0.05; updateCamera(); panoChip(); refreshPanoPanel(); S.dirty = true;
}
function panoOrient(st, t) {
  const R = t.R || st.R, extra = (st.userRot || 0) * Math.PI / 180; const m = new THREE.Matrix3().set(R[0], R[1], R[2], R[3], R[4], R[5], R[6], R[7], R[8]);
  const u = PANO.mesh.material.uniforms; u.uRinv.value.copy(m).transpose(); u.uFlip.value = t.flip; u.uOff.value = t.off + extra / TAU * t.flip;
}
function panoClose() {
  if (!PANO.active) return; PANO.active = null; persp.fov = PANO.fov0; persp.updateProjectionMatrix(); if (PANO.saved) tweenCam(PANO.saved, 600); const c = $('#panoChip'); if (c) c.remove(); refreshPanoPanel(); S.dirty = true;
}
function panoStep(k) { const L = PANO.list; if (!L.length) return; const i = L.indexOf(PANO.active); panoOpen(L[(i + k + L.length) % L.length]); }
function panoChip() {
  let c = $('#panoChip'); if (c) c.remove(); const st = PANO.active; if (!st) return;
  const sw = st.kind === 'station' && st.photos && st.photos.length ? el('button', { class: 'btn small', onclick: () => { st.show = st.show === 'photo' ? 'scan' : 'photo'; panoOpen(st); } }, st.show === 'photo' ? 'Show scan colours' : 'Show photo') : null;
  const rot = el('input', { type: 'range', min: -180, max: 180, step: 1, value: st.userRot || 0, style: 'width:90px', title: 'Turn the image if it does not line up with the points', 'aria-label': 'Turn image' });
  rot.addEventListener('input', () => { st.userRot = +rot.value; panoOrient(st, st.tex[st.show] || {}); S.dirty = true; });
  const ov = el('button', { class: 'btn small' + (PANO.overlay ? ' on' : ''), title: 'Draw the scan points over the image, to check they line up', onclick: () => { PANO.overlay = !PANO.overlay; ov.classList.toggle('on', PANO.overlay); S.dirty = true; } }, 'Points on top');
  c = el('div', { id: 'panoChip', class: 'modechip', style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;max-width:92%' },
    el('b', {}, '◎ ' + st.name), el('button', { class: 'btn small', onclick: () => panoStep(-1), 'aria-label': 'Previous view' }, '◀'), el('button', { class: 'btn small', onclick: () => panoStep(1), 'aria-label': 'Next view' }, '▶'), sw, ov,
    el('span', { class: 'hint' }, 'Turn'), rot, el('button', { class: 'btn small primary', onclick: panoClose }, 'Leave (Esc)'));
  vp.append(c);
}
// keep the camera on the station: wheel zooms the lens instead of moving; panning away leaves the view
canvas.addEventListener('wheel', e => { if (!PANO.active) return; e.preventDefault(); e.stopImmediatePropagation(); persp.fov = Math.max(12, Math.min(110, persp.fov * Math.exp(e.deltaY * 0.0012))); persp.updateProjectionMatrix(); S.dirty = true; }, { capture: true, passive: false });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && PANO.active) panoClose(); });
const _drawP = draw;
draw = function () {
  const st = PANO.active;
  if (st && (S.cam.target.distanceTo(st.pos) > 0.3 || S.cam.dist > 1 || S.cam.ortho)) { PANO.active = null; persp.fov = PANO.fov0; persp.updateProjectionMatrix(); const c = $('#panoChip'); if (c) c.remove(); refreshPanoPanel(); }
  if (!PANO.active) { panoMarkVis(true); return _drawP(); }
  const hid = []; if (!PANO.overlay) { for (const L of S.layers) if (L.obj && L.obj.visible && L.kind === 'cloud') { L.obj.visible = false; hid.push(L.obj); } for (const D of S.streams || []) if (D.root && D.root.visible) { D.root.visible = false; hid.push(D.root); } }
  panoMarkVis(false); try { _drawP(); } finally { for (const o of hid) o.visible = true; }
};
const _globeRenderP = globeRender;
globeRender = function (cam, bg) {
  if (!PANO.active || !cam.isPerspectiveCamera) return _globeRenderP(cam, bg);
  const g = PANO.cam; g.fov = cam.fov; g.aspect = cam.aspect; g.near = 0.1; g.far = 10; g.position.set(0, 0, 0); g.quaternion.copy(cam.quaternion); g.updateProjectionMatrix(); g.updateMatrixWorld();
  PANO.scene.background = bg; renderer.render(PANO.scene, g); return true;
};

// ----- markers in the 3D view, clickable -----
function panoMarkers() {
  for (const st of PANO.list) {
    if (st.label) continue; st.label = addLabel(st.pos, (st.kind === 'photo' ? '◉ ' : '◎ ') + esc(st.name));
    st.label.el.style.pointerEvents = 'auto'; st.label.el.style.cursor = 'pointer'; st.label.el.title = 'Stand here (360° view)'; st.label.el.addEventListener('click', ev => { ev.stopPropagation(); panoOpen(st); });
  }
}
function panoMarkVis(on) { for (const st of PANO.list) if (st.label) st.label.el.style.visibility = on && PANO.show !== false ? '' : 'hidden'; }
function panoRemove(st) { if (PANO.active === st) panoClose(); removeLabel(st.label); for (const t of Object.values(st.tex)) if (t && t.tex) t.tex.dispose(); PANO.list = PANO.list.filter(x => x !== st); refreshPanoPanel(); S.dirty = true; }
// a layer that goes away takes its stations with it
const _removeLayerP = removeLayer; removeLayer = function (L) { for (const st of PANO.list.filter(s => s.layer === L)) panoRemove(st); return _removeLayerP(L); };

function refreshPanoPanel() {
  let host = $('#panoSec'); if (!host) { host = el('div', { class: 'sec', id: 'panoSec' }); $('#leftPane').append(host); }
  host.textContent = ''; const pick = el('input', { type: 'file', multiple: true, hidden: true, accept: '.jpg,.jpeg,.png,.csv,.txt' }); pick.addEventListener('change', () => { const fs = [...pick.files]; pick.value = ''; importPanos(fs); });
  const showT = el('input', { type: 'checkbox', checked: PANO.show !== false }); showT.addEventListener('change', () => { PANO.show = showT.checked; panoMarkVis(true); });
  host.append(el('h3', {}, '360° views'), el('div', { class: 'note' }, 'Scan stations from E57 files appear here; click one (or its ◎ marker) to stand at the scanner and look around. Import 360° photos with GPS in the file, or with a CSV/TXT of name, E, N, Z, heading.'),
    el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: () => pick.click() }, 'Import 360° photos…'), el('label', { class: 'row', style: 'gap:4px;font-size:12px' }, showT, 'Markers')), pick);
  for (const st of PANO.list) host.append(el('div', { class: 'row', style: 'justify-content:space-between;gap:6px;margin-top:4px' + (PANO.active === st ? ';font-weight:600' : '') },
    el('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px', title: st.name }, (st.kind === 'photo' ? '◉ ' : '◎ ') + st.name + (st.kind === 'station' && st.photos && st.photos.length ? ' · photo' : '')),
    el('span', { class: 'row', style: 'gap:4px' }, el('button', { class: 'btn small', onclick: () => panoOpen(st) }, 'View'), el('button', { class: 'btn small', title: 'Remove', 'aria-label': 'Remove ' + st.name, onclick: () => panoRemove(st) }, '×'))));
}
refreshPanoPanel();
// dropped or opened files: 360° photos and position lists go here (an image with a world file or a GeoTIFF is an aerial, handled by the image module)
const _loadFilesP = loadFiles;
loadFiles = async function (files) {
  const isPos = f => /\.(csv|txt)$/i.test(f.name) && files.some(g => /\.(jpe?g|png)$/i.test(g.name));
  const worldFile = f => files.some(g => g !== f && g.name.replace(/\.[^.]+$/, '').toLowerCase() === f.name.replace(/\.[^.]+$/, '').toLowerCase() && /\.(jgw|jpgw|pgw|pngw|wld|tfw)$/i.test(g.name));
  const panos = files.filter(f => /\.(jpe?g|png)$/i.test(f.name) && !worldFile(f)); const pos = files.filter(isPos);
  if (panos.length) await importPanos([...panos, ...pos]);
  const rest = files.filter(f => !panos.includes(f) && !pos.includes(f)); if (rest.length) return _loadFilesP(rest);
};
