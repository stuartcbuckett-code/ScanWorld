// ===== CAD deliverables to a layer standard: survey linework written into a copy of a DXF template (its layers, linetypes, blocks kept) =====
(function (G) {
  // what the scan can give, with words that identify a matching layer in any standard; s551 = the Water Corporation S551 code
  const FEATURES = [
    { k: 'spot', name: 'Spot heights (natural surface)', s551: 'TPNAT', kw: ['natural surface', 'spot height', 'spot level', 'ns level', 'surface level'] },
    { k: 'spotText', name: 'Spot height values (text)', s551: 'TETPE', kw: ['point elevation', 'elevation text', 'level text', 'spot text', 'height text'] },
    { k: 'breakTop', name: 'Top of bank', s551: 'TPBTP', kw: ['bank - top', 'bank top', 'top of bank', 'batter top', 'top of batter', 'embankment top'] },
    { k: 'breakToe', name: 'Toe of bank', s551: 'TPBTO', kw: ['bank - toe', 'bank toe', 'toe of bank', 'batter toe', 'toe of batter'] },
    { k: 'breakline', name: 'Other breaklines', s551: 'TPBRK', kw: ['breakline', 'break line', 'grade break'] },
    { k: 'contMajor', name: 'Contours, major', s551: 'TPCMA', kw: ['contour major', 'major contour', 'index contour', 'contour index'] },
    { k: 'contMinor', name: 'Contours, minor', s551: 'TPCMI', kw: ['contour minor', 'minor contour', 'intermediate contour'] },
    { k: 'tin', name: 'DTM triangles (TIN)', s551: 'TPTIN', kw: ['dtm tin', 'tin', 'triangulation', 'dtm'] },
    { k: 'tree', name: 'Trees (symbol and canopy)', s551: 'VETRE', kw: ['vegetation tree', 'tree'], not: ['trunk', 'dead', 'line', 'stump'] },
    { k: 'treeText', name: 'Tree height and spread (text)', s551: 'TETPD', kw: ['point description', 'description text', 'tree text'] },
    { k: 'bldg', name: 'Building outlines (at ground)', s551: 'STBUI', kw: ['building', 'house', 'structure outline'] },
    { k: 'roof', name: 'Roof lines (at roof height)', s551: 'STRFL', kw: ['roof line', 'roofline', 'eave', 'roof'] },
    { k: 'wallTop', name: 'Walls and fences, top', s551: 'STWLT', kw: ['wall - top', 'top of wall', 'wall top'], not: ['retaining'] },
    { k: 'wallToe', name: 'Walls and fences, toe', s551: 'STWLB', kw: ['wall - toe', 'toe of wall', 'wall toe', 'base of wall'], not: ['retaining'] },
    { k: 'pole', name: 'Poles', s551: 'ELPWP', kw: ['power pole', 'light pole', 'pole'], not: ['stay'] },
    { k: 'roadEdge', name: 'Sealed road edge (no kerb)', s551: 'RDSED', kw: ['road sealed - edge', 'sealed - edge', 'edge of seal', 'sealed edge', 'road edge', 'edge of bitumen'], not: ['airport', 'unsealed'] },
    { k: 'roadCentre', name: 'Sealed road centreline', s551: 'RDSCE', kw: ['road sealed - centreline', 'sealed - centreline', 'road centreline', 'road centre line', 'centreline', 'centre line', 'road cl'], not: ['airport', 'unsealed', 'gravel', 'track', 'pipe', 'drain', 'rail', 'driveway', 'water course'] },
    { k: 'kerbFront', name: 'Kerb, front (lip)', s551: 'RDKFE', kw: ['kerb - front', 'kerb front', 'lip of kerb', 'kerb lip', 'face of kerb', 'kerb face', 'kerb invert', 'channel invert'] },
    { k: 'kerbBack', name: 'Kerb, back (top)', s551: 'RDKRB', kw: ['kerb - back', 'kerb back', 'back of kerb', 'top of kerb', 'kerb top'] },
    { k: 'pathEdge', name: 'Footpath edges', s551: 'RDFPE', kw: ['footpath', 'path edge', 'pathway', 'paving edge'] },
    { k: 'trackEdge', name: 'Unsealed road / track edges', s551: 'RDUNE', kw: ['unsealed - edge', 'unsealed edge', 'gravel edge', 'track edge'], not: ['airport'] },
    { k: 'trackCentre', name: 'Unsealed road / track centreline', s551: 'RDUNC', kw: ['unsealed - centreline', 'unsealed centreline', 'track centreline'], not: ['airport'] },
    { k: 'water', name: 'Water edges', s551: 'TPWBD', kw: ['water body - edge', 'water body edge', 'water edge', "water's edge", 'waters edge', 'water body'] },
    { k: 'contText', name: 'Contour values (text)', s551: 'TPCMA', kw: ['contour text', 'contour label'] },
  ];
  const norm = s => String(s || '').toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ');
  function matchLayers(layers, standard) {   // feature → layer name, by the standard's codes when it is S551, otherwise by the words in the layer names and descriptions
    const out = {};
    for (const F of FEATURES) {
      if (standard === 's551') { const L = layers.find(l => l.code === F.s551); if (L) { out[F.k] = L.name; continue; } }
      let best = null, bs = 0;
      for (const L of layers) { const t = norm(L.name + ' ' + (L.description || '')); if ((F.not || []).some(w => t.includes(w))) continue; let sc = 0; F.kw.forEach((w, i) => { if (t.includes(w)) sc = Math.max(sc, w.length + (F.kw.length - i)); }); if (sc > bs) { bs = sc; best = L; } }
      if (best) out[F.k] = best.name;
    }
    return out;
  }
  // ----- a DXF file as group-code pairs -----
  function pairs(txt) { const l = txt.split(/\r?\n/); const p = []; for (let i = 0; i + 1 < l.length; i += 2) p.push([l[i].trim(), l[i + 1]]); return p; }
  function readTemplate(txt) {
    const p = pairs(txt); const T = { txt, p, layers: [], blocks: new Set(), handseed: 0, msHandle: null, layerTable: null, ver: '', maxH: 0 };
    let sec = null, tab = null;
    for (let i = 0; i < p.length; i++) { const [c, v] = p[i];
      if (c === '5' || c === '105') { const h = parseInt(v, 16); if (h > T.maxH) T.maxH = h; }
      if (c === '0' && v === 'SECTION') { sec = p[i + 1][1]; continue; }
      if (c === '9' && v === '$HANDSEED') T.handseed = parseInt(p[i + 1][1], 16);
      if (c === '9' && v === '$ACADVER') T.ver = p[i + 1][1].trim();
      if (sec === 'TABLES' && c === '0' && v === 'TABLE') { tab = p[i + 2] && p[i + 1][0] === '2' ? p[i + 1][1].trim() : null; for (let j = i + 1; j < i + 6 && j < p.length; j++) if (p[j][0] === '5') { if (tab === 'LAYER') T.layerTable = p[j][1].trim(); break; } }
      if (sec === 'TABLES' && c === '0' && v === 'LAYER') { const L = { name: '', color: 7, linetype: 'CONTINUOUS', description: '' }; for (let j = i + 1; j < p.length && p[j][0] !== '0'; j++) { const [cc, vv] = p[j]; if (cc === '2') L.name = vv.trim(); else if (cc === '62') L.color = Math.abs(+vv); else if (cc === '6') L.linetype = vv.trim(); else if (cc === '1000' && !L.description) L.description = vv.trim(); } if (L.name) T.layers.push(L); }
      if (sec === 'TABLES' && c === '0' && v === 'BLOCK_RECORD') { let nm = '', h = ''; for (let j = i + 1; j < p.length && p[j][0] !== '0'; j++) { if (p[j][0] === '2') nm = p[j][1].trim(); if (p[j][0] === '5') h = p[j][1].trim(); } if (/^\*model_space$/i.test(nm)) T.msHandle = h; }
      if (sec === 'BLOCKS' && c === '0' && v === 'BLOCK') { for (let j = i + 1; j < p.length && p[j][0] !== '0'; j++) if (p[j][0] === '2') { T.blocks.add(p[j][1].trim()); break; } }
    }
    for (const L of T.layers) { const m = L.description.match(/^([A-Z]{4,6}) - (.*)$/); if (m) { L.code = m[1]; L.description = m[2]; } }
    T.modern = T.ver >= 'AC1015' && !!T.msHandle; return T;
  }
  // ----- entities, in the template's own version -----
  function writeInto(T, ents, opts = {}) {
    const f = v => (Math.round(v * 1e4) / 1e4).toString(); let h = Math.max(T.handseed, T.maxH + 1); const H = () => (h++).toString(16).toUpperCase();
    const M = T.modern, ms = T.msHandle; const o = []; const head = (type, layer, sub) => { o.push('0', type); let hd = null; if (M) { hd = H(); o.push('5', hd, '330', ms, '100', 'AcDbEntity'); } o.push('8', layer); if (M && sub) o.push('100', sub); return hd; };
    const newLayers = new Map();
    for (const e of ents) { if (!T.layers.some(L => L.name === e.layer) && !newLayers.has(e.layer)) newLayers.set(e.layer, e.color || 7); }
    for (const e of ents) {
      const L = e.layer;
      if (e.type === 'POINT') { head('POINT', L, 'AcDbPoint'); o.push('10', f(e.p[0]), '20', f(e.p[1]), '30', f(e.p[2])); }
      else if (e.type === 'LINE') { head('LINE', L, 'AcDbLine'); o.push('10', f(e.a[0]), '20', f(e.a[1]), '30', f(e.a[2]), '11', f(e.b[0]), '21', f(e.b[1]), '31', f(e.b[2])); }
      else if (e.type === 'CIRCLE') { head('CIRCLE', L, 'AcDbCircle'); o.push('10', f(e.p[0]), '20', f(e.p[1]), '30', f(e.p[2]), '40', f(e.r)); }
      else if (e.type === 'TEXT') { head('TEXT', L, 'AcDbText'); o.push('10', f(e.p[0]), '20', f(e.p[1]), '30', f(e.p[2]), '40', f(e.h || 0.25), '1', String(e.text).replace(/[\r\n]+/g, ' ')); if (e.rot) o.push('50', f(e.rot)); if (M) o.push('100', 'AcDbText'); }
      else if (e.type === 'INSERT') { if (!T.blocks.has(e.block)) { head('POINT', L, 'AcDbPoint'); o.push('10', f(e.p[0]), '20', f(e.p[1]), '30', f(e.p[2])); continue; } head('INSERT', L, 'AcDbBlockReference'); o.push('2', e.block, '10', f(e.p[0]), '20', f(e.p[1]), '30', f(e.p[2])); if (e.s && e.s !== 1) o.push('41', f(e.s), '42', f(e.s), '43', f(e.s)); }
      else if (e.type === '3DFACE') { const q = e.pts, d = q[3] || q[2]; head('3DFACE', L, 'AcDbFace'); o.push('10', f(q[0][0]), '20', f(q[0][1]), '30', f(q[0][2]), '11', f(q[1][0]), '21', f(q[1][1]), '31', f(q[1][2]), '12', f(q[2][0]), '22', f(q[2][1]), '32', f(q[2][2]), '13', f(d[0]), '23', f(d[1]), '33', f(d[2])); }
      else if (e.type === 'POLY') {
        if (e.pts.length < 2) continue; const ph = head('POLYLINE', L, 'AcDb3dPolyline'); o.push('66', '1', '10', '0', '20', '0', '30', '0', '70', String(8 | (e.closed ? 1 : 0)));
        for (const p of e.pts) { o.push('0', 'VERTEX'); if (M) o.push('5', H(), '330', ph, '100', 'AcDbEntity'); o.push('8', L); if (M) o.push('100', 'AcDbVertex', '100', 'AcDb3dPolylineVertex'); o.push('10', f(p[0]), '20', f(p[1]), '30', f(p[2]), '70', '32'); }
        o.push('0', 'SEQEND'); if (M) o.push('5', H(), '330', ph, '100', 'AcDbEntity'); o.push('8', L);
      }
    }
    // layers the template does not have (only when a feature was mapped to a new name)
    const lay = []; for (const [nm, col] of newLayers) { lay.push('0', 'LAYER'); if (M) lay.push('5', H(), '330', T.layerTable || '0', '100', 'AcDbSymbolTableRecord', '100', 'AcDbLayerTableRecord'); lay.push('2', nm, '70', '0', '62', String(col), '6', 'CONTINUOUS'); if (M) lay.push('370', '-3', '390', '0'); }
    // splice into the template text
    const lines = T.txt.split(/\r?\n/); const outL = []; let sec = null, inLayerTab = false, done = false;
    for (let i = 0; i + 1 < lines.length; i += 2) { const c = lines[i].trim(), v = lines[i + 1];
      if (c === '0' && v.trim() === 'SECTION') sec = lines[i + 3] ? lines[i + 3].trim() : null;
      if (sec === 'TABLES' && c === '0' && v.trim() === 'TABLE' && lines[i + 3] && lines[i + 3].trim() === 'LAYER') inLayerTab = true;
      if (inLayerTab && c === '0' && v.trim() === 'ENDTAB') { for (const x of lay) outL.push(x); inLayerTab = false; }
      if (sec === 'ENTITIES' && c === '0' && v.trim() === 'ENDSEC' && !done) { for (const x of o) outL.push(x); done = true; }
      if (c === '9' && v.trim() === '$HANDSEED') { outL.push(lines[i], v, lines[i + 2], '__HANDSEED__'); i += 2; continue; }
      if (c === '9' && (v.trim() === '$EXTMIN' || v.trim() === '$EXTMAX') && opts.ext) { const e = v.trim() === '$EXTMIN' ? opts.ext[0] : opts.ext[1]; outL.push(lines[i], v); let j = i + 2; const xyz = {}; while (j + 1 < lines.length && /^(10|20|30)$/.test(lines[j].trim())) { xyz[lines[j].trim()] = 1; j += 2; } outL.push(' 10', f(e[0]), ' 20', f(e[1]), ' 30', f(e[2])); i = j - 2; continue; }
      outL.push(lines[i], v);
    }
    if (!done) { const tail = outL.splice(outL.length - 2, 2); outL.push('0', 'SECTION', '2', 'ENTITIES'); for (const x of o) outL.push(x); outL.push('0', 'ENDSEC', ...tail); }
    return outL.join('\n').replace('__HANDSEED__', h.toString(16).toUpperCase()) + '\n';
  }
  G.SBCAD = { FEATURES, matchLayers, readTemplate, writeInto };
})(typeof window !== 'undefined' ? window : globalThis);
