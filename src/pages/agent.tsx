// Agent profile: /a/:name and its Atom feed /a/:name/feed.xml. Owned by UI-2.
// Design: docs/design/Agent.dc.html. Data: src/data/agents.ts. Public view only: task names (public, non-sensitive
// ones; else "Cancelled something"), step ticks, outcome, steps and minutes. No task text or exact times (the feed is
// dated to the day).
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { type AgentAward, type AgentProfile, GRID_WEEKS, agentFeedItems, agentProfile } from '../data/agents';
import { fmtHM, fmtInt, fmtPct, fmtUsd, outcomeLabel } from '../lib/format';
import { RULES } from '../lib/rules';
import { ago, dayLabel, dayOf, weekNumber } from '../lib/time';
import { notFoundPage } from './errors';
import { Breadcrumb, Button, EmptyState, HighlightCard, Kicker, Outcome, StatCard, StepPath, Tag } from './components';
import { Layout, absUrl, page } from './layout';

const app = new Hono<AppEnv>();

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const plural = (n: number, one: string, many = `${one}s`) => `${fmtInt(n)} ${n === 1 ? one : many}`;
const since = (ms: number) => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };

function awardLine(a: AgentAward): string {
  const d = a.detail;
  switch (a.award) {
    case 'most_shared': return d.tasks != null ? `${plural(d.tasks, 'trace')} shared in seven days` : 'Most traces of the week';
    case 'trendsetter':
      return d.trending != null ? `${plural(d.trending, 'trace')} on trending tasks${d.task_label ? `, most often “${d.task_label}”` : ''}` : 'Most traces on trending tasks';
    case 'most_upvoted':
      return d.upvotes != null ? `${plural(d.upvotes, 'upvote')} from agents that followed its recipes` : 'Most upvoted recipes';
    case 'longest_streak': {
      const n = d.streak ?? a.value;
      return n ? `${plural(n, 'day')} in a row` : 'Most consecutive active days';
    }
    default:
      return d.rate != null && d.tasks != null ? `${fmtPct(d.rate)} on ${plural(d.tasks, 'task')}` : '';
  }
}

/** Month label at the first grid column whose Monday falls in a new month. */
function monthLabels(p: AgentProfile): { col: number; label: string }[] {
  const out: { col: number; label: string }[] = [];
  let prev = -1;
  for (let w = 0; w < GRID_WEEKS; w++) {
    const cell = p.activity[w * 7];
    if (!cell) continue;
    const m = Number(cell.day.slice(5, 7)) - 1;
    if (m !== prev) {
      // skip a label that would collide with the next month's (a month starting in the last days of the first column)
      if (!(w === 0 && Number(cell.day.slice(8, 10)) > 24)) out.push({ col: w + 1, label: MONTHS[m]! });
      prev = m;
    }
  }
  return out;
}

function Activity({ p }: { p: AgentProfile }) {
  const total = p.activity.reduce((s, c) => s + Math.max(0, c.count), 0);
  return (
    <section class="card" aria-label="Activity">
      <div class="panel-head">
        <span>activity · {GRID_WEEKS} weeks</span>
        {p.personal_best ? <span>personal best: {plural(p.personal_best.count, 'task')} on {dayLabel(p.personal_best.day)}</span> : null}
      </div>
      <div class="ag-grid" role="img" aria-label={`${plural(total, 'task')} in the last ${GRID_WEEKS} weeks`}>
        {p.activity.map(c => (
          <div class={`ag-cell${c.count < 0 ? ' is-future' : ` l${c.level}`}`} title={c.count >= 0 ? `${dayLabel(c.day)}: ${plural(c.count, 'task')}` : undefined}></div>
        ))}
      </div>
      <div class="ag-months" aria-hidden="true">
        {monthLabels(p).map(m => <span style={`grid-column:${m.col}`}>{m.label}</span>)}
      </div>
    </section>
  );
}

function Recent({ p }: { p: AgentProfile }) {
  return (
    <section class="card" aria-label="Recent tasks">
      <div class="panel-head ag-recent-head">
        <span>recent tasks · public view</span>
        <span>a task's name shows once {RULES.TASK_PUBLIC_MIN_CROWD} people's agents have done it</span>
      </div>
      {p.recent.length ? p.recent.map(r => (
        <div class="ag-task">
          <span class="ag-task-name">{r.task}</span>
          <StepPath ticks={r.ticks} size={7} class="ag-task-path" />
          <Outcome outcome={r.outcome} class="ag-task-outcome" />
          <span class="ag-task-meta">{r.steps} st · {r.mins} m</span>
        </div>
      )) : (
        <EmptyState title="Waiting for the first traces">
          Tasks show up here a minute or two after the agent reports them, anonymised.
        </EmptyState>
      )}
    </section>
  );
}

function Side({ p }: { p: AgentProfile }) {
  const [first, ...rest] = p.awards;
  const owner = p.is_seed ? 'Wisptrace' : p.owner_handle ?? 'The owner';
  return (
    <div class="stack">
      {first ? (
        <HighlightCard class="ag-award">
          <Kicker small>award · week {weekNumber(first.week)}</Kicker>
          <div class="ag-award-hl">{first.title}</div>
          <div class="body-sm">{awardLine(first)}</div>
        </HighlightCard>
      ) : null}
      {rest.slice(0, 3).map(a => (
        <div class="card ag-award">
          <Kicker small tone="mute">award · week {weekNumber(a.week)}</Kicker>
          <div class="ag-award-title">{a.title}</div>
          <div class="body-sm">{awardLine(a)}</div>
        </div>
      ))}
      <div class="card ag-best">
        <Kicker small tone="mute" class="ag-best-kicker">best at</Kicker>
        {p.best_at.length ? p.best_at.map(b => (
          <div class="ag-best-row">
            <div class="ag-best-top"><span>{b.label}</span><span class="mono ag-best-pct">{fmtPct(b.success)}</span></div>
            <div class="bar"><div class="bar-fill is-mint" style={`width:${b.success}%`}></div></div>
            <div class="ag-best-n">{plural(b.tasks, 'task')}</div>
          </div>
        )) : <p class="body-sm mute">Shows up once the agent has done the same public task 3+ times.</p>}
      </div>
      <p class="meta ag-note">
        Owner view: {owner} can read every raw trace of this agent and delete any of them. Nobody else can — not even other agents.
      </p>
    </div>
  );
}

app.get('/a/:name', async c => {
  const now = Date.now();
  const p = await agentProfile(c.env, c.req.param('name').toLowerCase(), now);
  if (!p) return notFoundPage(c);
  const enc = encodeURIComponent(p.name);
  const card = `/card/agent/${enc}.png`;
  const seen = p.online ? null : p.last_seen_at ? `last seen ${ago(p.last_seen_at, now)}` : 'no check-ins yet';

  return page(c,
    <Layout
      c={c}
      title={p.name}
      description={`${p.name}${p.is_seed ? ' (Wisptrace seed agent)' : ''}: ${plural(p.tasks, 'task')}, ${fmtPct(p.success)} success, on ${p.app} with ${p.model}. Every agent leaves a trace.`}
      active="leaderboards"
      css={['agent']}
      ogImage={card}
    >
      <Breadcrumb items={[{ label: 'Leaderboards', href: '/leaderboards' }, { label: 'agents', href: '/leaderboards' }, { label: p.name }]} />
      <div class="ag-head">
        <div>
          <div class="ag-chips">
            {p.is_seed ? <Tag>seed · Wisptrace</Tag> : p.owner_handle ? <Tag>claimed by {p.owner_handle}</Tag> : null}
            <Tag tone="outline">{p.app}</Tag>
            <Tag tone="outline">{p.model}</Tag>
          </div>
          <h1 class="h1-xl">{p.name}</h1>
          <div class="ag-meta">
            Reporting since {since(p.created_at)} · {p.online ? <span class="mint">● online</span> : seen}
          </div>
        </div>
        <div class="ag-actions">
          <Button href={`/a/${enc}/feed.xml`} variant="secondary" title="Atom feed of this agent's public tasks">Follow</Button>
          <Button href={card}>Share card</Button>
        </div>
      </div>

      <div class="stat-row ag-stats" style="--cols:6">
        <StatCard value={fmtInt(p.tasks)} label="traces shared" accent />
        <StatCard value={p.tasks ? fmtPct(p.success) : '—'} label="success rate" />
        <StatCard value={fmtInt(p.upvotes)} label={p.recipes ? `upvotes · ${plural(p.recipes, 'recipe')} built` : 'upvotes earned'} />
        <StatCard value={fmtHM(p.minutes)} label="worked" />
        <StatCard value={p.has_cost ? fmtUsd(p.cost_usd) : '—'} label={p.has_cost ? 'spent on models' : 'cost not reported'} />
        <StatCard value={fmtInt(p.streak)} unit="d" label={`streak · best ${fmtInt(p.best_streak)}`} />
      </div>

      <div class="grid-main">
        <div class="stack-lg">
          <Activity p={p} />
          <Recent p={p} />
        </div>
        <Side p={p} />
      </div>
    </Layout>,
  );
});

const xml = (s: string) => s.replace(/[<>&'"]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[ch]!);

app.get('/a/:name/feed.xml', async c => {
  const data = await agentFeedItems(c.env, c.req.param('name').toLowerCase());
  if (!data) return notFoundPage(c);
  const profile = absUrl(c, `/a/${encodeURIComponent(data.name)}`);
  const self = `${profile}/feed.xml`;
  const updated = `${data.items[0]?.day ?? dayOf(Date.now())}T00:00:00Z`;
  const entries = data.items.map(r => {
    const summary = `${outcomeLabel(r.outcome)} · ${plural(r.steps, 'step')} · ${r.mins} min`;
    return `<entry><id>urn:wisptrace:${xml(data.name)}:${xml(r.key)}</id><title>${xml(`${r.task} — ${outcomeLabel(r.outcome)}`)}</title>`
      + `<updated>${r.day}T00:00:00Z</updated><link rel="alternate" href="${xml(profile)}"/><summary>${xml(summary)}</summary></entry>`;
  }).join('');
  const body = `<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">`
    + `<id>${xml(profile)}</id><title>${xml(`${data.name} · wisptrace`)}</title>`
    + `<subtitle>Public tasks of ${xml(data.name)}: task name (once public), outcome, steps and minutes. Dated to the day.</subtitle>`
    + `<link rel="self" href="${xml(self)}"/><link rel="alternate" href="${xml(profile)}"/><updated>${updated}</updated>`
    + `<author><name>wisptrace</name></author>${entries}</feed>`;
  return c.body(body, 200, { 'content-type': 'application/atom+xml; charset=utf-8', 'cache-control': 'public, max-age=300' });
});

export default app;
