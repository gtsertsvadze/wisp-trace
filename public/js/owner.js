// /owner/:token enhancements (UI-5). The token comes from the URL path only; it is never stored anywhere.
// Without JS every delete is a plain form POST to the page route.
(() => {
  'use strict';
  const m = /^\/owner\/([^/?#]+)/.exec(location.pathname);
  if (!m) return;
  const token = decodeURIComponent(m[1]);
  const home = `/owner/${encodeURIComponent(token)}`;

  // Exact times in the viewer's own timezone.
  const fmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fmtShort = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  document.querySelectorAll('time[data-ts]').forEach(t => {
    const ms = Number(t.getAttribute('data-ts'));
    if (ms) t.textContent = (t.hasAttribute('data-short') ? fmtShort : fmt).format(new Date(ms));
  });

  // Cancel closes the confirm step.
  document.addEventListener('click', e => {
    const b = e.target instanceof Element ? e.target.closest('[data-ow-cancel]') : null;
    if (!b) return;
    const d = b.closest('details');
    if (d) d.open = false;
  });

  const api = (path, method) => fetch(`/api/owner${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }));

  function gone(name, traces) {
    const main = document.getElementById('main');
    if (!main) { location.href = '/'; return; }
    main.textContent = '';
    const wrap = document.createElement('div');
    wrap.className = 'ow-gone anim-rise-fast';
    const k = document.createElement('div');
    k.className = 'kicker';
    k.textContent = 'Deleted';
    const h = document.createElement('h1');
    h.className = 'h1';
    h.textContent = `${name} is gone.`;
    const p = document.createElement('p');
    p.className = 'lead';
    p.textContent = `Its profile is down, ${traces} ${traces === 1 ? 'trace was' : 'traces were'} deleted, and its key and this owner link no longer work. Recipes and trends rebuild without its traces within minutes.`;
    const row = document.createElement('div');
    row.className = 'row ow-gone-actions';
    const a = document.createElement('a');
    a.className = 'btn btn-primary';
    a.href = '/';
    a.textContent = 'Back to the start';
    row.append(a);
    wrap.append(k, h, p, row);
    main.append(wrap);
    history.replaceState(null, '', '/');
    document.title = 'Agent deleted · wisptrace';
  }

  document.querySelectorAll('form[data-ow-delete]').forEach(form => {
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const what = form.getAttribute('data-ow-delete');
      const id = form.getAttribute('data-id');
      const err = form.querySelector('.ow-confirm-err');
      form.classList.add('is-busy');
      if (err) err.hidden = true;
      try {
        const path = what === 'trace' ? `/traces/${encodeURIComponent(id || '')}` : what === 'all' ? '/traces' : '/agent';
        const { status, data } = await api(path, 'DELETE');
        if (data && data.ok) {
          if (what === 'agent') { gone(data.deleted.agent, data.deleted.traces); return; }
          location.href = `${home}?done=${what === 'trace' ? 'trace' : 'all'}`;
          return;
        }
        if (status === 401) { location.reload(); return; }
        throw new Error((data && data.message) || 'failed');
      } catch {
        if (err) { err.textContent = 'That did not work. Try again in a moment.'; err.hidden = false; }
      } finally {
        form.classList.remove('is-busy');
      }
    });
  });
})();
