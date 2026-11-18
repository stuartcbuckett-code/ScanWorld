// ---------- every button shows that it is working ----------
// Tools that report progress use the progress bar (busy). For everything else, a click (or a change of a drop-down) first puts up a
// "Working…" indicator, lets the browser draw it, and only then runs the tool, so even work that holds the page shows it is happening.
// The indicator fades in after a quarter of a second, so quick actions never flash it.
(function () {
  const css = document.createElement('style');
  css.textContent = '@keyframes sbWorkIn{to{opacity:1}}@keyframes sbSpin{to{transform:rotate(360deg)}}.sb-working{position:fixed;left:50%;top:64px;transform:translateX(-50%);z-index:300;display:flex;align-items:center;gap:10px;padding:8px 14px;border-radius:999px;background:var(--panel,#fff);color:var(--ink,#111);border:1px solid var(--line,#ccc);box-shadow:0 6px 24px rgba(0,0,0,.25);font:13px system-ui,sans-serif;opacity:0;animation:sbWorkIn .15s .25s forwards;pointer-events:none}.sb-working i{width:14px;height:14px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:sbSpin .8s linear infinite;display:block}';
  document.head.append(css);
  let replay = false, live = 0, pill = null;
  const show = label => { live++; if (!pill) { pill = document.createElement('div'); pill.className = 'sb-working'; pill.setAttribute('role', 'status'); pill.append(document.createElement('i'), document.createElement('span')); } pill.lastChild.textContent = (label ? label + ': ' : '') + 'working…'; if (!pill.isConnected) document.body.append(pill); };
  const hide = () => { live = Math.max(0, live - 1); if (!live && pill) pill.remove(); };
  const frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  // what counts: buttons in the tool panes, layer panel, toolbar and dialogs; not file pickers' labels, tabs that only switch, or the progress bar's own buttons
  const target = e => { const b = e.target.closest && e.target.closest('button'); if (!b || b.disabled) return null; if (b.closest('#prog, .sb-working, .modechip, [role=dialog].conv-ov')) return null; if (b.dataset.instant !== undefined) return null; return b; };
  const label = b => (b.textContent || b.getAttribute('aria-label') || '').trim().replace(/[…⌂▸▾◀▶×]/g, '').slice(0, 40);
  document.addEventListener('click', async e => {
    if (replay) return; const b = target(e); if (!b) return;
    e.stopImmediatePropagation(); e.preventDefault(); show(label(b)); await frames();
    replay = true; try { b.click(); } finally { replay = false; }
    setTimeout(hide, 0);   // after the tool's synchronous part; tools with their own progress bar take over from here
  }, true);
  document.addEventListener('change', async e => {
    const s = e.target; if (replay || !(s instanceof HTMLSelectElement) || s.dataset.instant !== undefined) return;
    e.stopImmediatePropagation(); show(s.getAttribute('aria-label') || 'Updating'); await frames();
    replay = true; try { s.dispatchEvent(new Event('change', { bubbles: true })); } finally { replay = false; }
    setTimeout(hide, 0);
  }, true);
  window.SBWorking = { show, hide };
})();
