// ===== Converter screen (used in the stand-alone converter page and in ScanBench's LOD projects panel) =====
function convUI(host, opts = {}) {
  const E = (tag, attrs = {}, ...kids) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v === true) n.setAttribute(k, ''); else if (v !== false && v != null) n.setAttribute(k, v); } for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c))); return n; };
  const st = { files: [], out: null, job: null, running: false };
  const gb = b => (b / 1e9).toFixed(b < 1e10 ? 2 : 1) + ' GB';
  host.textContent = '';
  if (!SBConv.supported()) { host.append(E('div', { class: 'conv-warn' }, 'This needs Chrome or Microsoft Edge on a computer (it writes the project straight into a folder you choose). Open this page in one of those.')); return; }
  const list = E('div', { class: 'conv-files' }), outL = E('div', { class: 'conv-files' }), log = E('pre', { class: 'conv-log', hidden: true }), bar = E('div', { class: 'conv-bar-in' }), stage = E('div', { class: 'conv-stage' }), done = E('div', { class: 'conv-done', hidden: true });
  const name = E('input', { type: 'text', placeholder: 'Dataset name (optional)', 'aria-label': 'Dataset name' });
  const mem = E('select', { 'aria-label': 'Memory to use' }, ...[[1, '1 GB'], [2, '2 GB'], [4, '4 GB'], [8, '8 GB']].map(([v, t]) => E('option', { value: v, selected: v === Math.min(4, Math.max(1, Math.floor((navigator.deviceMemory || 8) / 4))) }, t)));
  const hc = navigator.hardwareConcurrency || 4; const wk = E('select', { 'aria-label': 'Workers' }, ...[1, 2, 4, 6, 8, 12, 16].filter(v => v <= Math.max(1, hc)).map(v => E('option', { value: v, selected: v === Math.max(1, Math.min(8, hc - 1)) || (hc <= 2 && v === 1) }, String(v))));
  const crs = E('input', { type: 'text', placeholder: 'e.g. EPSG:7850 (only if the scans have none)', 'aria-label': 'Coordinate system' });
  const go = E('button', { class: 'btn primary', disabled: true }, 'Convert'), stopB = E('button', { class: 'btn', hidden: true }, 'Stop');
  const refresh = () => {
    list.textContent = ''; for (const f of st.files) list.append(E('div', {}, f.name + ' · ' + gb(f.size)));
    if (st.files.length > 1) list.append(E('div', { class: 'conv-sum' }, st.files.length + ' files, ' + gb(st.files.reduce((a, f) => a + f.size, 0)) + ' (they become one dataset)'));
    outL.textContent = st.out ? 'Output folder: ' + st.out.name : ''; go.disabled = st.running || !st.files.length || !st.out;
  };
  const pickFiles = async () => {
    try { if (window.showOpenFilePicker) { const hs = await window.showOpenFilePicker({ multiple: true, types: [{ description: 'Scans', accept: { 'application/octet-stream': ['.e57', '.las', '.laz'] } }] }); for (const h of hs) st.files.push(await h.getFile()); }
      else { const i = E('input', { type: 'file', multiple: true, accept: '.e57,.las,.laz', hidden: true }); document.body.append(i); await new Promise(r => { i.addEventListener('change', r); i.click(); }); st.files.push(...i.files); i.remove(); } } catch (e) { if (e.name !== 'AbortError') alert(e.message); }
    refresh();
  };
  const pickFolderIn = async () => {
    try { const h = await window.showDirectoryPicker({ mode: 'read' }); const walk = async d => { for await (const [nm, e] of d.entries()) { if (e.kind === 'directory') await walk(e); else if (/\.(e57|las|laz)$/i.test(nm)) st.files.push(await e.getFile()); } }; await walk(h); } catch (e) { if (e.name !== 'AbortError') alert(e.message); }
    refresh();
  };
  const pickOut = async () => {
    try { const h = await window.showDirectoryPicker({ mode: 'readwrite', id: 'scanlod-out' }); let has = false; try { await h.getFileHandle('dataset.json'); has = true; } catch (e) { }
      if (has && !confirm(h.name + ' already holds a converted dataset. Replace it?')) return; st.out = h; } catch (e) { if (e.name !== 'AbortError') alert(e.message); }
    refresh();
  };
  go.addEventListener('click', async () => {
    st.running = true; refresh(); go.hidden = true; stopB.hidden = false; log.hidden = false; log.textContent = ''; done.hidden = true; st.job = { stop: false };
    const total = st.files.reduce((a, f) => a + f.size, 0); const est = total * 3.2; // temporary chunks (~40 bytes a point) plus the octree, against typical LAZ/E57 sizes
    try { if (navigator.storage && navigator.storage.estimate) { /* the output folder is outside browser storage; nothing to check here */ } } catch (e) { }
    const t0 = performance.now(); let sStage = '', sT = t0;
    try {
      const ds = await SBConv.run({ files: st.files, out: st.out, name: name.value.trim() || null, memoryGB: +mem.value, threads: +wk.value, crs: crs.value.trim() || null, signal: st.job,
        onLog: s => { log.textContent += s + '\n'; log.scrollTop = log.scrollHeight; },
        onProgress: (s, f, rate) => { if (s !== sStage) { sStage = s; sT = performance.now(); } const el = (performance.now() - sT) / 1000, eta = f > 0.02 ? el / f - el : 0; bar.style.width = (Math.max(0, Math.min(1, f)) * 100).toFixed(1) + '%'; stage.textContent = s + ' · ' + (f * 100).toFixed(0) + '%' + (rate ? ' · ' + rate : '') + (eta > 5 ? ' · about ' + SBConv.fmtT(eta) + ' left in this step' : ''); } });
      stage.textContent = 'Finished in ' + SBConv.fmtT((performance.now() - t0) / 1000) + ': ' + SBConv.fmtN(ds.points) + ' points, ' + (ds.octree.bytes / 1e9).toFixed(2) + ' GB.'; bar.style.width = '100%';
      done.hidden = false; done.textContent = ''; done.append(E('div', {}, 'The project is in the folder "' + st.out.name + '" (project.json, dataset.json, hierarchy.bin, octree.bin).'));
      if (opts.onDone) done.append(E('button', { class: 'btn primary', onclick: () => opts.onDone(st.out, ds) }, 'Open it now'));
      else done.append(E('div', {}, 'To view it: open ScanBench, then LOD projects → Open project folder…, and choose "' + st.out.name + '".'), opts.viewerUrl ? E('a', { class: 'btn primary', href: opts.viewerUrl, target: '_blank', rel: 'noopener' }, 'Open ScanBench') : null);
    } catch (e) { stage.textContent = 'Stopped: ' + e.message; log.textContent += 'Stopped: ' + (e.stack || e.message) + '\n'; }
    st.running = false; go.hidden = false; stopB.hidden = true; refresh();
  });
  stopB.addEventListener('click', () => { if (st.job) st.job.stop = true; stopB.disabled = true; stage.textContent = 'Stopping after the current piece of work…'; setTimeout(() => { stopB.disabled = false; }, 3000); });
  host.append(
    E('div', { class: 'conv-step' }, E('b', {}, '1. Scans'), E('div', { class: 'conv-row' }, E('button', { class: 'btn', onclick: pickFiles }, 'Choose files…'), E('button', { class: 'btn', onclick: pickFolderIn }, 'Choose a folder of tiles…'), E('button', { class: 'btn', onclick: () => { st.files = []; refresh(); } }, 'Clear')), list),
    E('div', { class: 'conv-step' }, E('b', {}, '2. Where to put the project'), E('div', { class: 'conv-row' }, E('button', { class: 'btn', onclick: pickOut }, 'Choose output folder…')), outL, E('div', { class: 'conv-note' }, 'Use an empty folder on a drive with room. While converting it needs about 40 bytes per point (about 4× the size of LAZ files, about 2× E57); the finished project is about 17 bytes per point.')),
    E('div', { class: 'conv-step' }, E('b', {}, '3. Options'), E('div', { class: 'conv-grid' }, E('label', {}, 'Name', name), E('label', {}, 'Memory', mem), E('label', {}, 'Workers', wk), E('label', {}, 'Coordinate system', crs))),
    E('div', { class: 'conv-row' }, go, stopB), E('div', { class: 'conv-bar' }, bar), stage, done, log);
  refresh();
}
