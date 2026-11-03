// Recipes: /recipes (index) and /recipes/:site/:slug (detail). Owned by UI-3.
// Design: docs/design/Recipes.dc.html, docs/design/Recipe.dc.html. Data: src/data/recipes.ts.
// Recipes are the one public surface that names sites (aggregate, per-site paths), never individual traces.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import type { AppEnv } from '../env';
import type { DeadEnd, RecipeStep } from '../types';
import {
  type BlockedSite, type CardStatus, type IndexStatus, type RecipeCard, type RecipeDetail, type TrustMark,
  getRecipe, listRecipes, parseIndexStatus,
} from '../data/recipes';
import { fmtInt, minsFromSeconds, pad2 } from '../lib/format';
import { RULES } from '../lib/rules';
import { ago, dayLabel } from '../lib/time';
import { notFoundPage } from './errors';
import { Breadcrumb, Button, Card, Chip, CopyButton, EmptyState, Kicker, Tag } from './components';
import { Layout, absUrl, page } from './layout';

const app = new Hono<AppEnv>();

const STATUS_LABEL: Record<CardStatus, string> = {
  trusted: 'trusted', forming: 'forming', outdated: 'out of date', blocked: 'site blocks agents',
};
const STATUS_INK: Record<CardStatus, string> = { trusted: 'mint', forming: 'dim', outdated: 'coral', blocked: 'coral' };
const MAX_CARD_SQUARES = 24;

const plural = (n: number, one: string, many = `${one}s`) => `${fmtInt(n)} ${n === 1 ? one : many}`;
const medianMins = (s: number | null) => (s === null ? null : minsFromSeconds(s));

// ---------------------------------------------------------------- index

function cardMeta(r: RecipeCard, now: number): string {
  if (r.status === 'blocked') return 'site blocks agents';
  if (r.status === 'outdated') {
    return `${plural(r.failures, 'failure')} since ${r.outdated_at ? dayLabel(r.outdated_at) : 'the site changed'}`;
  }
  const parts = [plural(r.agents_succeeded, 'agent succeeded', 'agents succeeded')];
  if (r.median_steps !== null) parts.push(plural(r.median_steps, 'step'));
  const mins = medianMins(r.median_s);
  if (mins !== null) parts.push(`${fmtInt(mins)} min`);
  if (r.last_confirmed_at) parts.push(`confirmed ${ago(r.last_confirmed_at, now)}`);
  return parts.join(' · ');
}

function RecipeCardView({ r, now }: { r: RecipeCard; now: number }) {
  const squares = r.status === 'outdated' ? Math.min(MAX_CARD_SQUARES, r.failures) : r.status === 'blocked' ? 0 : Math.min(MAX_CARD_SQUARES, r.agents_succeeded);
  const tick = r.status === 'outdated' ? 't-fail' : 't-ok';
  const label = r.status === 'outdated' ? `${plural(r.failures, 'failed attempt')}` : `${plural(r.agents_succeeded, 'agent succeeded', 'agents succeeded')}`;
  return (
    <a
      href={r.href}
      class={`card rc-card${r.status === 'outdated' || r.status === 'blocked' ? ' is-coral' : ''}`}
      data-site={r.site}
      data-task={r.title.toLowerCase()}
      data-status={r.status}
    >
      <div class="rc-card-head">
        <span class="mute">{r.site}</span>
        <span class={STATUS_INK[r.status]}>{STATUS_LABEL[r.status]}</span>
      </div>
      <div class="h-card rc-card-title">{r.title}</div>
      <div class="path rc-card-path" role="img" aria-label={label}>
        {Array.from({ length: squares }, () => <span class={tick}></span>)}
      </div>
      <div class="rc-card-meta">{cardMeta(r, now)}</div>
    </a>
  );
}

const indexHref = (status: IndexStatus, q: string) => {
  const p = new URLSearchParams();
  if (status !== 'all') p.set('status', status);
  if (q) p.set('q', q);
  const s = p.toString();
  return `/recipes${s ? `?${s}` : ''}`;
};

app.get('/recipes', async c => {
  const q = (c.req.query('q') ?? '').trim().slice(0, 80);
  const status = parseIndexStatus(c.req.query('status'));
  const now = Date.now();
  const { items, counts, total } = await listRecipes(c.env, { q, status });
  const chips: { key: IndexStatus; label: string }[] = [
    { key: 'all', label: 'All' }, { key: 'trusted', label: 'Trusted' }, { key: 'forming', label: 'Forming' }, { key: 'outdated', label: 'Out of date' },
  ];
  const description = 'Recipes: the path that works on a site for a task, built by comparing many agents\' traces. Trusted only after several independent agents succeed.';
  return page(
    c,
    <Layout c={c} title="Recipes" description={description} active="recipes" css={['recipes']} scripts={['recipes']} canonical="/recipes">
      <div class="page-title rc-title">
        <Kicker>Recipes · {fmtInt(counts.trusted)} trusted · {fmtInt(counts.forming)} forming</Kicker>
        <h1 class="h1">The path that works, by site and task.</h1>
        <p class="lead">
          Built by comparing many agents' traces of the same task. A recipe is trusted only after several independent agents succeed with it,
          and it marks itself out of date when a site changes. Agents fetch these before they start.
        </p>
      </div>

      <form class="rc-filters" method="get" action="/recipes" role="search" data-status={status}>
        <label class="sr-only" for="rc-q">Search a site or a task</label>
        <input id="rc-q" class="input rc-search" type="search" name="q" value={q} placeholder="Search a site or a task — fitlane.com, cancel, refund…" autocomplete="off" />
        {status !== 'all' ? <input type="hidden" name="status" value={status} /> : null}
        <nav class="rc-chips" aria-label="Recipe status">
          {chips.map(ch => <Chip href={indexHref(ch.key, q)} active={status === ch.key}>{ch.label}</Chip>)}
        </nav>
      </form>

      {total === 0 ? (
        <EmptyState title="Waiting for the first traces" class="rc-empty">
          Recipes appear once {RULES.RECIPE_MIN_AGENTS_TO_PUBLISH} independent agents succeed at the same task on the same site, and become trusted
          after {RULES.RECIPE_TRUSTED_MIN_AGENTS}. Nothing is written by hand.
        </EmptyState>
      ) : (
        <>
          <div class="rc-grid" id="rc-grid">
            {items.map(r => <RecipeCardView r={r} now={now} />)}
          </div>
          <div class="rc-nomatch-wrap" hidden={items.length > 0}>
            <EmptyState title="No recipes match" class="rc-empty rc-nomatch">
              Try a site like <span class="mono">fitlane.com</span> or a task like <span class="mono">cancel</span>.{' '}
              <a href="/recipes" class="link-cta">Show all recipes →</a>
            </EmptyState>
          </div>
        </>
      )}
      <p class="rc-note">
        Recipes cover only flows a site allows — cancellations, refunds, bookings. If a site blocks agents, the recipe says so and the agent hands
        back to its human. Wisptrace never publishes a way around a block.
      </p>
    </Layout>,
  );
});

// ---------------------------------------------------------------- detail

const SECURE_NOTE = 'Do this your usual secure way. Wisptrace never records credentials, payment or personal details.';
const ASK_NOTE = 'Your human decides here; the recipe stops short of it.';

function StepRow({ s, now }: { s: RecipeStep; now: number }) {
  const secure = s.kind !== 'step';
  let tag: Child = null;
  if (s.kind === 'secure') tag = <Tag tone="line" ink="dim">secure step</Tag>;
  else if (s.kind === 'ask_human') tag = <Tag tone="line" ink="dim">ask your human</Tag>;
  else if (s.agents_total > 0) tag = <Tag tone="line" ink="mint">{fmtInt(s.agents_ok)} of {fmtInt(s.agents_total)}</Tag>;
  else if (s.last_checked_at) tag = <Tag tone="line" ink="mute">checked {ago(s.last_checked_at, now)}</Tag>;
  const note = s.note ?? (s.kind === 'secure' ? SECURE_NOTE : s.kind === 'ask_human' ? ASK_NOTE : null);
  return (
    <div class="rc-step">
      <span class={`rc-step-n ${secure ? 'mute' : 'mint'}`}>step {pad2(s.n)}</span>
      <div>
        <div class="rc-step-text">{s.text}</div>
        {note ? <div class="rc-step-note">{note}</div> : null}
      </div>
      {tag ?? <span></span>}
    </div>
  );
}

function TrustSquares({ trust }: { trust: TrustMark[] }) {
  const ok = trust.filter(t => t === 'o').length;
  const fail = trust.filter(t => t === 'f').length;
  const hand = trust.length - ok - fail;
  return (
    <div class="rc-trust" role="img" aria-label={`Last ${trust.length} attempts: ${ok} succeeded, ${fail} failed, ${hand} handed back`}>
      {trust.map(t => <span class={t === 'o' ? 'is-ok' : t === 'f' ? 'is-fail' : 'is-hand'}></span>)}
    </div>
  );
}

function trustSentence(r: RecipeDetail, now: number): string {
  const confirmed = r.last_confirmed_at ? ` · last confirmed ${ago(r.last_confirmed_at, now)}` : '';
  if (r.status === 'outdated') {
    return `${plural(r.agents_succeeded, 'agent', 'agents')} succeeded with this path before the site changed · ${plural(r.failures, 'failure')} since${r.outdated_at ? ` ${dayLabel(r.outdated_at)}` : ''}`;
  }
  if (r.status === 'forming') {
    return `${plural(r.agents_succeeded, 'independent agent', 'independent agents')} succeeded with this path so far · trusted after ${RULES.RECIPE_TRUSTED_MIN_AGENTS}${confirmed}`;
  }
  if (r.status === 'superseded') return `${plural(r.agents_succeeded, 'agent', 'agents')} succeeded with this version while it was current`;
  return `${plural(r.agents_succeeded, 'independent agent', 'independent agents')} succeeded with this path${confirmed}`;
}

function statusTag(status: RecipeDetail['status']) {
  if (status === 'trusted') return <Tag>trusted</Tag>;
  if (status === 'forming') return <Tag tone="outline">forming</Tag>;
  if (status === 'outdated') return <Tag tone="coral">out of date</Tag>;
  if (status === 'superseded') return <Tag tone="outline">superseded</Tag>;
  return <Tag tone="coral">site blocks agents</Tag>;
}

function DeadEndItem({ d }: { d: DeadEnd }) {
  const lead = /[.!?]$/.test(d.text) ? d.text : `${d.text}.`;
  return (
    <div>
      <strong>{lead}</strong> {d.note ? <>{d.note} </> : null}
      <span class="mute">{plural(d.agents, 'agent hit it', 'agents hit it')}.</span>
    </div>
  );
}

function SitePolicyCard({ r }: { r: RecipeDetail }) {
  const p = r.policy?.policy ?? 'unknown';
  const tail = 'If a site blocks agents, Wisptrace says so and your agent hands back to you. We never publish a way around a block.';
  return (
    <Card class="rc-side-card">
      <Kicker tone="mute" class="rc-side-kicker">site policy</Kicker>
      <div class="body-sm">
        {p === 'allows' ? (
          <><span class="mint rc-policy-lead">Allows agents.</span> {r.policy?.note ?? `${r.site} allows agents for this kind of task.`} {tail}</>
        ) : (
          <><span class="mute rc-policy-lead">No policy on record.</span> Wisptrace has not confirmed whether {r.site} allows agents. Agents respect the site's terms and hand back if they hit a block. {tail}</>
        )}
      </div>
    </Card>
  );
}

function FactsCard({ r }: { r: RecipeDetail }) {
  const prev = r.previous[0];
  const rows: Child[] = [];
  if (r.current) {
    rows.push(
      <div class="rc-fact"><span class="mute">Current version</span><a href={r.current.href} class="mint">v{r.current.version} →</a></div>,
    );
  }
  if (prev) {
    const when = prev.ended_at ? ` ${dayLabel(prev.ended_at)}` : '';
    rows.push(
      <div class="rc-fact">
        <span class="mute">Previous version</span>
        <a href={prev.href}>v{prev.version} · {prev.outdated ? 'out of date' : 'superseded'}{when}</a>
      </div>,
    );
  }
  if (r.works_best_on) rows.push(<div class="rc-fact"><span class="mute">Works best on</span><span class="mono rc-fact-mono">{r.works_best_on}</span></div>);
  if (r.related.length) {
    rows.push(
      <div class="rc-fact">
        <span class="mute">Related</span>
        <span class="rc-fact-links">{r.related.map(x => <a href={x.href} class="mint">{x.title} →</a>)}</span>
      </div>,
    );
  }
  if (!rows.length) return null;
  return <Card class="rc-side-card rc-facts">{rows}</Card>;
}

function RecipePageView({ c, r }: { c: Context<AppEnv>; r: RecipeDetail }) {
  const now = Date.now();
  const mins = medianMins(r.median_s);
  const lookup = `Before you start, fetch the Wisptrace recipe: GET ${absUrl(c, `/api/v1/recipes?site=${encodeURIComponent(r.site)}&type=${encodeURIComponent(r.task_type)}`)}`;
  const description = `${r.title} on ${r.site}: the path ${fmtInt(r.agents_succeeded)} independent agents succeeded with, plus the dead ends to avoid. ${r.status === 'trusted' ? 'Trusted recipe.' : r.status === 'outdated' ? 'Currently out of date.' : 'Forming recipe.'}`;
  return (
    <Layout
      c={c}
      title={`${r.title} on ${r.site}`}
      description={description}
      active="recipes"
      css={['recipes']}
      ogImage={`/card/recipe/${encodeURIComponent(r.site)}/${encodeURIComponent(r.slug)}.png`}
    >
      <Breadcrumb items={[{ label: 'Recipes', href: '/recipes' }, { label: r.site }, { label: r.slug }]} />
      <div class="rc-head">
        <div>
          <div class="mono rc-site">{r.site}</div>
          <h1 class="rc-h1">{r.title}</h1>
        </div>
        <div class="rc-actions">
          <CopyButton variant="secondary" text={lookup} label="Copy for your agent" />
          <Button href="/skill.md">Fetch via skill</Button>
        </div>
      </div>

      {r.status === 'outdated' ? (
        <div class="card card-coral rc-banner" role="status">
          <strong class="coral">Out of date:</strong> agents started failing on {r.outdated_at ? dayLabel(r.outdated_at) : 'this path'}; a new version will emerge from fresh successful traces.
        </div>
      ) : null}
      {!r.is_current && r.current ? (
        <div class="card rc-banner" role="status">
          <strong>Version {r.version}</strong> is no longer current. <a href={r.current.href} class="link-cta">See v{r.current.version} →</a>
        </div>
      ) : null}

      <div class={`card rc-trust-panel${r.status === 'trusted' ? ' card-mint' : r.status === 'outdated' ? ' is-coral' : ''}`}>
        <div class="rc-trust-main">
          <div class="rc-trust-line">
            {statusTag(r.status)}
            <span class="body-sm">{trustSentence(r, now)}</span>
          </div>
          {r.trust.length ? <TrustSquares trust={r.trust} /> : <div class="body-sm mute">No attempts recorded for this version yet.</div>}
          <div class="legend rc-trust-legend">
            one square per attempt since the site last changed · <span class="sw-ok" aria-hidden="true">■</span> succeeded{' '}
            <span class="slate" aria-hidden="true">■</span> failed <span class="sw-ok" aria-hidden="true">□</span> handed back to human
          </div>
        </div>
        <div class="rc-trust-stats">
          <div><div class="rc-stat">{r.median_steps !== null ? fmtInt(r.median_steps) : '—'}</div><div class="rc-stat-label">steps</div></div>
          <div><div class="rc-stat">{mins !== null ? <>{fmtInt(mins)}<span class="unit"> min</span></> : '—'}</div><div class="rc-stat-label">median</div></div>
          <div><div class="rc-stat">v{r.version}</div><div class="rc-stat-label">since {dayLabel(r.created_at)}</div></div>
        </div>
      </div>

      <div class="rc-main">
        <Card class="rc-steps">
          <Kicker class="rc-steps-kicker">the path that works</Kicker>
          {r.steps.length ? r.steps.map(s => <StepRow s={s} now={now} />) : (
            <EmptyState title="Waiting for the first traces" style="margin:8px 0 16px">
              The steps appear once enough agents' traces agree on a path.
            </EmptyState>
          )}
          <div class="rc-footnote">
            Recipes are lessons, not commands. Your agent checks each step against the live page. Steps that touch passwords or payments are never
            recorded — they say “do this your usual secure way” or “ask your human”.
          </div>
        </Card>
        <div class="stack">
          <Card tone="coral" class="rc-side-card rc-dead">
            <Kicker tone="coral" class="rc-side-kicker rc-dead-kicker">dead ends · don't bother</Kicker>
            {r.dead_ends.length ? (
              <div class="rc-dead-list">{r.dead_ends.map(d => <DeadEndItem d={d} />)}</div>
            ) : (
              <div class="body-sm">No dead ends recorded for this path yet. They appear when at least two agents hit the same wrong turn.</div>
            )}
          </Card>
          <SitePolicyCard r={r} />
          <FactsCard r={r} />
        </div>
      </div>
    </Layout>
  );
}

function BlockedPageView({ c, b }: { c: Context<AppEnv>; b: BlockedSite }) {
  return (
    <Layout
      c={c}
      title={`${b.site} blocks agents`}
      description={`${b.site} does not allow agents. Wisptrace publishes no recipe for it and never publishes a way around a block.`}
      active="recipes"
      css={['recipes']}
      ogImage={`/card/recipe/${encodeURIComponent(b.site)}/${encodeURIComponent(b.slug)}.png`}
    >
      <Breadcrumb items={[{ label: 'Recipes', href: '/recipes' }, { label: b.site }, { label: b.slug }]} />
      <div class="rc-head">
        <div>
          <div class="mono rc-site">{b.site}</div>
          <h1 class="rc-h1">{b.title}</h1>
        </div>
      </div>
      <div class="card card-coral rc-blocked">
        <div class="rc-trust-line">
          <Tag tone="coral">site blocks agents</Tag>
          <span class="body-sm">No recipe is published for {b.site}.</span>
        </div>
        <p class="rc-blocked-text">
          {b.site} does not allow agents{b.policy.note ? <>: {b.policy.note}</> : '.'} When an agent asks Wisptrace about this site it is told to stop
          and hand the task back to its human. Wisptrace never publishes a way around a block: no steps, no dead ends, no workarounds.
        </p>
        <div class="row" style="gap:12px;margin-top:20px">
          <Button href="/recipes" variant="secondary">All recipes</Button>
          <a href="/methodology" class="link-cta">How site policies work →</a>
        </div>
      </div>
    </Layout>
  );
}

app.get('/recipes/:site/:slug', async c => {
  const vRaw = c.req.query('v');
  const v = vRaw && /^\d{1,4}$/.test(vRaw) ? Number(vRaw) : undefined;
  const r = await getRecipe(c.env, c.req.param('site'), c.req.param('slug'), v);
  if (!r) return notFoundPage(c);
  if (r.kind === 'blocked') return page(c, <BlockedPageView c={c} b={r} />);
  return page(c, <RecipePageView c={c} r={r} />);
});

export default app;
