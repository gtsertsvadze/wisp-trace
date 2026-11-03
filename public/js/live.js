// Live feed enhancement for / and /live (UI-1). Pages render server-side and work without this file.
//
// Page contract:
//   [data-live-list data-buffer=N data-visible=N data-filter=all|done|failed data-cursor=…]  the row list
//   <template data-live-row>   one row; fields marked data-f="task|kind|path|outcome|steps|mins|stepsmins|model|app"
//                              plus an optional .seed-tag (hidden via .is-hidden when not a seed agent)
//   [data-live-counter]        big counter (animates toward stats.traces_total)
//   [data-live-agents] [data-live-permin] [data-live-shown] [data-live-empty]
//
// Polls /api/public/live?after=<cursor> every ~4 s, queues new items and drips them in at <= 1 per second.
// Nothing here ever shows a time: items carry no timestamps and the cursor is opaque.
(() => {
  'use strict';
  const list = document.querySelector('[data-live-list]');
  if (!list || !('fetch' in window)) return;
  const tpl = document.querySelector('template[data-live-row]');
  if (!tpl) return;

  const BUFFER = Math.max(1, Number(list.dataset.buffer) || 7);
  const VISIBLE = Math.max(1, Number(list.dataset.visible) || BUFFER);
  const FILTER = list.dataset.filter || 'all';
  const POLL_MS = 4000;
  const MAX_BACKOFF = 60000;
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let cursor = list.dataset.cursor || '';
  const queue = [];
  const known = new Set();
  list.querySelectorAll('[data-key]').forEach(el => el.dataset.key && known.add(el.dataset.key));

  const counterEl = document.querySelector('[data-live-counter]');
  const agentsEl = document.querySelector('[data-live-agents]');
  const perMinEl = document.querySelector('[data-live-permin]');
  const shownEl = document.querySelector('[data-live-shown]');
  const emptyEl = document.querySelector('[data-live-empty]');

  // ---------------------------------------------------------------- counter
  const fmt = n => Math.round(n).toLocaleString('en-US');
  let shown = Number(counterEl && counterEl.dataset.liveCounter) || 0;
  let target = shown;
  let raf = 0;
  function tickCounter() {
    raf = 0;
    if (!counterEl) return;
    const diff = target - shown;
    if (Math.abs(diff) < 0.5) { shown = target; counterEl.textContent = fmt(shown); return; }
    // Ease toward the target over roughly the poll interval, at least one unit per frame when far away.
    shown += Math.sign(diff) * Math.max(Math.abs(diff) / 70, Math.min(Math.abs(diff), 0.35));
    counterEl.textContent = fmt(shown);
    raf = requestAnimationFrame(tickCounter);
  }
  function setCounter(n) {
    if (!counterEl || typeof n !== 'number' || !isFinite(n)) return;
    target = n;
    if (reduced) { shown = n; counterEl.textContent = fmt(n); return; }
    if (!raf) raf = requestAnimationFrame(tickCounter);
  }

  // ---------------------------------------------------------------- rows
  const TICK = { o: 't-ok', r: 't-retry', f: 't-fail' };
  function buildPath(el, ticks) {
    el.textContent = '';
    const all = String(ticks || '').split('').filter(t => t in TICK);
    const max = 40;
    const shownTicks = all.length > max ? all.slice(0, max - 1).concat(all[all.length - 1]) : all;
    for (const t of shownTicks) { const s = document.createElement('span'); s.className = TICK[t]; el.appendChild(s); }
    if (all.length > shownTicks.length) {
      const more = document.createElement('span'); more.className = 'path-more'; more.textContent = '+' + (all.length - shownTicks.length); el.appendChild(more);
    }
    const fails = all.filter(t => t === 'f').length, retries = all.filter(t => t === 'r').length;
    el.setAttribute('aria-label', all.length + ' steps' + (retries ? ', ' + retries + ' retried' : '') + (fails ? ', ' + fails + ' failed' : ''));
  }
  const outcomeLabel = o => (o === 'done' ? 'done' : o === 'handed_back' ? 'handed back' : 'failed');
  function render(item) {
    const frag = tpl.content.cloneNode(true);
    const row = frag.firstElementChild;
    if (!row) return null;
    row.dataset.key = item.key;
    row.dataset.outcome = item.outcome;
    row.removeAttribute('hidden');
    const set = (f, v) => { const el = row.querySelector('[data-f="' + f + '"]'); if (el) el.textContent = v; };
    set('task', item.task); set('kind', item.kind);
    set('steps', String(item.steps)); set('mins', String(item.mins));
    set('stepsmins', item.steps + ' steps · ' + item.mins + ' min');
    set('model', item.model); set('app', item.app);
    const path = row.querySelector('.path'); if (path) buildPath(path, item.ticks);
    const out = row.querySelector('.outcome'); if (out) { out.className = 'outcome is-' + item.outcome; out.textContent = outcomeLabel(item.outcome); }
    const seed = row.querySelector('.seed-tag'); if (seed) seed.classList.toggle('is-hidden', !item.seed);
    const model = row.querySelector('.live-model'); if (model) model.dataset.meta = item.steps + ' st · ' + item.mins + ' m';
    return row;
  }
  function passesFilter(item) {
    if (FILTER === 'done') return item.outcome === 'done';
    if (FILTER === 'failed') return item.outcome !== 'done';
    return true;
  }
  function trim() {
    const rows = list.querySelectorAll('[data-key]');
    rows.forEach((el, i) => {
      if (i >= BUFFER) { known.delete(el.dataset.key); el.remove(); return; }
      if (i >= VISIBLE) el.setAttribute('hidden', ''); else el.removeAttribute('hidden');
    });
    if (shownEl) shownEl.textContent = String(Math.min(rows.length, VISIBLE));
  }
  function insert(item) {
    const row = render(item);
    if (!row) return;
    list.querySelectorAll('.is-new').forEach(el => el.classList.remove('is-new'));
    row.classList.add('is-new');
    list.prepend(row);
    known.add(item.key);
    if (emptyEl) emptyEl.setAttribute('hidden', '');
    trim();
  }

  // Drip: at most one new row per second so bursts read as a stream, not a jump.
  let dripTimer = 0;
  function drip() {
    dripTimer = 0;
    if (document.hidden) return;
    const item = queue.shift();
    if (item) insert(item);
    if (queue.length) dripTimer = setTimeout(drip, 1000);
  }
  function enqueue(items) {
    // API returns newest first; drip oldest first so the newest ends up on top.
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (!it || !it.key || known.has(it.key) || !passesFilter(it)) continue;
      if (queue.some(q => q.key === it.key)) continue;
      queue.push(it);
    }
    while (queue.length > BUFFER) queue.shift();
    if (queue.length && !dripTimer) dripTimer = setTimeout(drip, 50);
  }

  // ---------------------------------------------------------------- polling
  let pollTimer = 0;
  let backoff = POLL_MS;
  let inflight = false;
  function schedule(ms) { clearTimeout(pollTimer); pollTimer = setTimeout(poll, ms); }
  async function poll() {
    pollTimer = 0;
    if (document.hidden) return;
    if (inflight) { schedule(backoff); return; }
    inflight = true;
    try {
      const url = '/api/public/live?limit=' + BUFFER + '&filter=' + encodeURIComponent(FILTER) + (cursor ? '&after=' + encodeURIComponent(cursor) : '');
      const res = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
      if (!res.ok) throw new Error('status ' + res.status);
      const data = await res.json();
      if (data && Array.isArray(data.items)) enqueue(data.items);
      if (data && typeof data.cursor === 'string' && data.cursor) cursor = data.cursor;
      if (data && data.stats) {
        setCounter(data.stats.traces_total);
        if (agentsEl && typeof data.stats.agents_total === 'number') agentsEl.textContent = fmt(data.stats.agents_total);
        if (perMinEl && typeof data.stats.per_min === 'number') perMinEl.textContent = String(data.stats.per_min);
      }
      backoff = POLL_MS;
    } catch (_) {
      backoff = Math.min(MAX_BACKOFF, backoff * 2);
    } finally {
      inflight = false;
      if (!document.hidden) schedule(backoff);
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(pollTimer); pollTimer = 0; clearTimeout(dripTimer); dripTimer = 0; return; }
    if (queue.length && !dripTimer) dripTimer = setTimeout(drip, 50);
    schedule(200);
  });
  schedule(POLL_MS);
})();
