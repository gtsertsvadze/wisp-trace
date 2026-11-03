// /recipes: instant client-side filtering on site + task. Owned by UI-3.
// Without JS the search form submits ?q= and the server hides non-matching cards; this only makes it instant.
// Same rule as matchesQuery() in src/data/recipes.ts: case-insensitive substring on site or task title.
(() => {
  'use strict';
  const form = document.querySelector('.rc-filters');
  const input = document.getElementById('rc-q');
  const grid = document.getElementById('rc-grid');
  if (!form || !input || !grid) return;
  const cards = Array.from(grid.querySelectorAll('.rc-card'));
  const nomatch = document.querySelector('.rc-nomatch-wrap');
  const chips = Array.from(form.querySelectorAll('.rc-chips a'));

  function apply() {
    const q = input.value.trim().toLowerCase();
    let shown = 0;
    for (const card of cards) {
      const hit = !q || (card.dataset.site || '').includes(q) || (card.dataset.task || '').includes(q);
      card.hidden = !hit;
      if (hit) shown++;
    }
    if (nomatch) nomatch.hidden = shown > 0;

    // Keep the URL and the status chips in step with the query, so reloads and chip clicks keep it.
    const url = new URL(location.href);
    if (q) url.searchParams.set('q', input.value.trim());
    else url.searchParams.delete('q');
    history.replaceState(null, '', url.pathname + url.search);
    for (const a of chips) {
      const u = new URL(a.href, location.href);
      if (q) u.searchParams.set('q', input.value.trim());
      else u.searchParams.delete('q');
      a.setAttribute('href', u.pathname + u.search);
    }
  }

  let t = 0;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(apply, 60); });
  form.addEventListener('submit', e => { e.preventDefault(); apply(); });
})();
