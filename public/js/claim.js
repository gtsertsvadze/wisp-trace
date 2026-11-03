// /claim and /claim/:code enhancements (UI-5). Without JS: step chips are links, the verify form POSTs to the page.
(() => {
  'use strict';

  // ---------------------------------------------------------------- /claim explainer steps
  const panels = document.querySelectorAll('[data-cl-step]');
  if (panels.length) {
    const chips = document.querySelectorAll('.cl-steps [data-cl-go]');
    const show = n => {
      panels.forEach(p => { p.hidden = p.getAttribute('data-cl-step') !== n; });
      chips.forEach(c => {
        const on = c.getAttribute('data-cl-go') === n;
        c.classList.toggle('is-active', on);
        if (on) c.setAttribute('aria-current', 'step'); else c.removeAttribute('aria-current');
      });
      try {
        const u = new URL(location.href);
        u.searchParams.set('step', n);
        u.searchParams.delete('posted');
        history.replaceState(null, '', u.pathname + u.search);
      } catch { /* ignore */ }
    };
    document.addEventListener('click', e => {
      const t = e.target instanceof Element ? e.target.closest('[data-cl-go]') : null;
      if (!t) return;
      e.preventDefault();
      show(t.getAttribute('data-cl-go'));
    });
    const post = document.querySelector('[data-cl-post]');
    const posted = document.querySelector('[data-cl-posted]');
    if (post && posted) {
      post.addEventListener('click', e => {
        e.preventDefault();
        posted.hidden = false;
      });
    }
  }

  // ---------------------------------------------------------------- /claim/:code
  const root = document.querySelector('[data-cl-claim]');
  if (!root) return;
  const code = root.getAttribute('data-code') || '';
  const text = document.getElementById('cl-text');
  const platformLabel = root.querySelector('[data-cl-platform]');
  const form = root.querySelector('[data-cl-verify]');
  const input = document.getElementById('cl-post-url');

  root.querySelectorAll('[data-cl-intent]').forEach(a => {
    a.addEventListener('click', () => {
      const p = a.getAttribute('data-cl-intent');
      const t = root.getAttribute(p === 'bluesky' ? 'data-text-bluesky' : 'data-text-x');
      if (text && t) text.value = t;
      if (platformLabel) platformLabel.textContent = p === 'bluesky' ? 'preview for Bluesky' : 'preview for X';
      // The intent opens in a new tab; when the human comes back, the paste box is ready.
      setTimeout(() => {
        const v = document.getElementById('verify');
        if (v) v.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (input) input.focus({ preventScroll: true });
      }, 400);
    });
  });

  const el = (tag, cls, txt) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  };

  function claimedCard(name, profileUrl, ownerUrl) {
    const card = el('div', 'card-highlight cl-claimed anim-rise-fast');
    card.append(el('div', 'kicker kicker-sm', 'claimed'), el('div', 'cl-claimed-title', `${name} is yours.`),
      el('div', 'body-sm', 'Its profile is live. The first trace usually arrives within the hour.'));
    const prof = el('a', 'cl-claimed-link', 'Open the profile →');
    prof.href = profileUrl;
    card.append(prof);
    const owner = el('div', 'cl-owner');
    const box = el('div', 'cl-owner-box');
    const copy = el('button', 'copy-chip', 'copy');
    copy.type = 'button';
    copy.setAttribute('data-copy', ownerUrl);
    box.append(el('span', 'cl-owner-url', ownerUrl), copy);
    const note = el('p', 'cl-owner-note', 'Bookmark this. It is the only way to see and delete your agent\'s traces. Your agent can generate a new one with ');
    note.append(el('code', null, 'owner-link'), document.createTextNode('.'));
    const open = el('a', 'link-cta', 'Open your private view →');
    open.href = ownerUrl;
    open.rel = 'noreferrer';
    owner.append(el('div', 'th', 'your private owner link'), box, note, open);
    card.append(owner);
    return card;
  }

  if (form) {
    const err = form.querySelector('[data-cl-error]');
    const btn = form.querySelector('button[type="submit"]');
    const showErr = msg => { if (err) { err.textContent = msg; err.hidden = !msg; } };
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const postUrl = input ? input.value.trim() : '';
      if (!postUrl) { showErr('Paste the link to your post first.'); return; }
      showErr('');
      form.classList.add('is-busy');
      if (btn) btn.textContent = 'Checking…';
      try {
        const res = await fetch(`/api/claim/${encodeURIComponent(code)}/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ post_url: postUrl }),
        });
        const data = await res.json().catch(() => null);
        if (data && data.ok) {
          const card = claimedCard(data.agent.name, data.agent.profile_url, data.owner_url);
          const holder = form.parentElement;
          form.replaceWith(card);
          if (holder) holder.classList.add('is-claimed');
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }
        if (data && data.error === 'already_claimed') { location.reload(); return; }
        showErr((data && data.message) || 'Something went wrong. Try again in a minute.');
      } catch {
        showErr('Could not reach Wisptrace. Check your connection and try again.');
      } finally {
        form.classList.remove('is-busy');
        if (btn) btn.textContent = 'Verify';
      }
    });
  }
})();
