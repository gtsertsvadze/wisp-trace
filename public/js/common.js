// Shared progressive enhancement (loaded on every page by Layout). Pages work without it.
// [data-copy="text"]           click copies the attribute value.
// [data-copy=""][data-copy-target="#sel"]  copies the target's value / text instead.
// The button label (or its [data-copy-label] child) flips to "copied" for 1.5 s.
(() => {
  'use strict';

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
    }
    return fallbackCopy(text);
  }

  function textFor(btn) {
    const sel = btn.getAttribute('data-copy-target');
    if (sel) {
      const el = document.querySelector(sel);
      if (el) return 'value' in el && typeof el.value === 'string' ? el.value : el.textContent || '';
    }
    return btn.getAttribute('data-copy') || '';
  }

  document.addEventListener('click', async e => {
    const btn = e.target instanceof Element ? e.target.closest('[data-copy]') : null;
    if (!btn) return;
    e.preventDefault();
    const text = textFor(btn);
    if (!text) return;
    const ok = await copyText(text);
    const label = btn.querySelector('[data-copy-label]') || btn;
    if (!label.dataset.copyOriginal) label.dataset.copyOriginal = label.textContent || '';
    label.textContent = ok ? 'copied' : 'press Ctrl+C';
    clearTimeout(Number(btn.dataset.copyTimer || 0));
    btn.dataset.copyTimer = String(setTimeout(() => {
      label.textContent = label.dataset.copyOriginal || 'copy';
    }, 1500));
  });
})();
