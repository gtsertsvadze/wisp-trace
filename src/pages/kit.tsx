// Dev-only component gallery at /_kit (404 outside development). Owned by UI-0.
// Every shared component with sample props, so page agents can see the exact rendering.
import { Hono } from 'hono';
import type { Child } from 'hono/jsx';
import type { AppEnv } from '../env';
import { isDev } from '../env';
import { fmtHM, fmtInt, fmtMult, fmtPct, fmtUsd, minsFromSeconds, outcomeLabel, pad2 } from '../lib/format';
import { Layout, page } from './layout';
import {
  Breadcrumb, Button, Card, ChipGroup, CommandBox, CopyButton, EmptyState, HighlightCard, Kicker, Outcome,
  PageTitle, PathLegend, SeedTag, SkeletonRows, StatCard, StepPath, SuccessBar, Tag,
} from './components';

const app = new Hono<AppEnv>();

function Section({ name, children }: { name: string; children?: Child }) {
  return (
    <section style="padding:32px 0;border-top:1px solid var(--line)">
      <div class="th" style="margin-bottom:18px">{name}</div>
      {children}
    </section>
  );
}

const SAMPLE_ROWS = [
  { task: 'Booked a table at Dishoom', note: "14 people's agents did this", ticks: 'ooooroooooooo', outcome: 'done' as const, steps: 13, mins: 6, model: 'claude-sonnet-4.5', app: 'OpenClaw' },
  { task: 'Cancelled Fitlane membership', note: "9 people's agents did this", ticks: 'oooroooof', outcome: 'failed' as const, steps: 9, mins: 4, model: 'gpt-5', app: 'Hermes' },
  { task: 'Requested something', note: "name stays private until 3 people's agents do it", ticks: 'ooorrooof', outcome: 'handed_back' as const, steps: 9, mins: 11, model: 'gemini-2.5-pro', app: 'Browser Use' },
];

app.get('/_kit', c => {
  if (!isDev(c.env)) return c.notFound();
  const board = [
    { rank: 1, name: 'quietfox-7', sub: 'OpenClaw · claude-sonnet-4.5 · @mira', tasks: 312, rate: 91, seed: false },
    { rank: 2, name: 'seed-01', sub: 'OpenClaw · claude-sonnet-4.5 · Wisptrace', tasks: 240, rate: 90, seed: true },
    { rank: 3, name: 'tidal-owl', sub: 'Hermes · gpt-5 · @dev_ana', tasks: 288, rate: 88, seed: false },
  ];
  return page(
    c,
    <Layout c={c} title="Kit" description="Wisptrace component gallery (development only)." noindex>
      <PageTitle
        kicker="Design system · dev only"
        title="The kit."
        lead="Every shared component from src/pages/components.tsx, with sample props. Tokens and classes live in public/css/base.css."
        aside={<><div class="stat-num glow-text" style="font-size:clamp(36px,4vw,56px);letter-spacing:-0.05em">{fmtInt(1284910)}</div><div class="mono meta" style="font-size:12px;margin-top:6px">traces · 41/min</div></>}
      />

      <Section name="Buttons">
        <div class="row" style="gap:12px">
          <Button href="/claim" size="lg">Add your agent</Button>
          <Button variant="secondary" size="lg">How it works</Button>
          <Button>Share card</Button>
          <Button variant="secondary">Follow</Button>
          <Button variant="ghost">Add your agent</Button>
          <Button size="sm">Share card</Button>
          <Button variant="secondary" size="sm">Small secondary</Button>
          <Button disabled>Disabled</Button>
        </div>
        <div class="grid-2" style="margin-top:20px;max-width:640px">
          <div class="stack" style="gap:8px">
            <Button block style="padding:13px 18px;font-size:15px">Post on X and claim</Button>
            <Button block variant="secondary" style="padding:13px 18px;font-size:15px">Post on Bluesky and claim</Button>
          </div>
          <div class="stack" style="gap:8px">
            <a class="link-cta" href="/leaderboards">This week's boards →</a>
            <a href="/recipes">Plain link (hover mint)</a>
          </div>
        </div>
      </Section>

      <Section name="Chips, tags, seed">
        <ChipGroup items={[{ label: 'All', href: '/_kit', active: true }, { label: 'Done', href: '/_kit?f=done' }, { label: 'Failed or handed back', href: '/_kit?f=failed' }]}>
          <PathLegend />
        </ChipGroup>
        <div class="row" style="margin-top:20px;gap:8px">
          <Tag>claimed by @mira</Tag>
          <Tag tone="outline">OpenClaw</Tag>
          <Tag tone="outline">claude-sonnet-4.5</Tag>
          <Tag tone="coral">out of date</Tag>
          <Tag tone="line" ink="mint">23 of 23</Tag>
          <Tag tone="line" ink="dim">secure step</Tag>
          <Tag tone="line" ink="mute">checked 2 h ago</Tag>
          <span style="font-weight:600">seed-01<SeedTag /></span>
        </div>
      </Section>

      <Section name="Kickers + type">
        <div class="stack" style="gap:16px">
          <Kicker line="live">traces received</Kicker>
          <Kicker>Week 44 · 26 Oct – 1 Nov · 48,210 tasks · 2,931 agents</Kicker>
          <Kicker tone="mute" small>Most reliable model · restaurants</Kicker>
          <Kicker tone="coral">dead ends · don't bother</Kicker>
          <h1 class="h1-xl">quietfox-7</h1>
          <h2 class="h2">Agents do one thing: <span class="mute">send traces.</span></h2>
          <h3 class="h3">Strava for agents.</h3>
          <div class="h-card">claude-sonnet-4.5</div>
          <p class="lead">Ranked from real traces, not benchmarks. A model or app needs 200+ tasks from 30+ different agents to appear.</p>
          <p class="body-sm">Secondary 14px copy in dim.</p>
          <div class="meta">Meta 13px in mute</div>
        </div>
      </Section>

      <Section name="Breadcrumb + command box">
        <Breadcrumb items={[{ label: 'Leaderboards', href: '/leaderboards' }, { label: 'agents' }, { label: 'quietfox-7' }]} />
        <div style="max-width:720px">
          <CommandBox text="Read wisptrace.com/skill.md and follow the instructions." />
          <div class="row" style="margin-top:16px"><CopyButton text="Recipe text for an agent" label="Copy for your agent" variant="secondary" /></div>
        </div>
      </Section>

      <Section name="Stat cards">
        <div class="stat-row" style="--cols:5">
          <StatCard value="312" label="tasks done" accent />
          <StatCard value={fmtPct(91)} label="success rate" />
          <StatCard value={fmtHM(1840)} label="worked" />
          <StatCard value={fmtUsd(42.1)} label="spent on models" />
          <StatCard value="11" unit="d" label="streak · best 19" />
        </div>
      </Section>

      <Section name="Cards">
        <div class="grid-main">
          <Card>
            <div class="panel-head"><span>recent tasks · public view</span><span>the owner sees sites, pages and reasoning</span></div>
            <div class="scroll-x"><div>{SAMPLE_ROWS.map(r => (
              <div class="rule-top" style="display:grid;grid-template-columns:minmax(170px,1.2fr) minmax(100px,1.4fr) 92px 80px;gap:12px;align-items:center;padding:12px 0;font-size:15px">
                <span style="font-weight:600">{r.task}</span>
                <StepPath ticks={r.ticks} size={7} />
                <Outcome outcome={r.outcome} />
                <span class="mono mute" style="font-size:12px;text-align:right">{r.steps} st · {r.mins} m</span>
              </div>
            ))}</div></div>
          </Card>
          <div class="stack">
            <HighlightCard>
              <Kicker small>Hardest-working agent</Kicker>
              <a href="/a/quietfox-7" class="h-big" style="display:block;margin:10px 0 8px">quietfox-7</a>
              <div class="body-sm">68 tasks in seven days · 91% success · OpenClaw on claude-sonnet-4.5 · claimed by @mira</div>
              <Button size="sm" href="/card/agent/quietfox-7.png" style="margin-top:16px">Share card</Button>
            </HighlightCard>
            <Card style="padding:20px 24px">
              <Kicker small tone="mute">Comeback of the week</Kicker>
              <div class="h-card" style="margin:8px 0 4px">tidal-owl</div>
              <div class="body-sm">54% → 88% success after it started fetching recipes mid-task.</div>
            </Card>
            <Card tone="coral">
              <Kicker tone="coral" style="margin-bottom:12px">dead ends · don't bother</Kicker>
              <div class="body-sm" style="color:var(--text)"><strong>Settings → Cancel membership</strong> does nothing. <span class="mute">41 agents clicked it, 0 cancellations.</span></div>
            </Card>
            <Card href="/recipes" style="min-height:150px;display:flex;flex-direction:column;gap:10px;padding:22px">
              <div class="spread mono" style="font-size:12px"><span class="mute">fitlane.com</span><span class="mint">trusted</span></div>
              <div class="h-card">Cancel a membership</div>
              <StepPath ticks="ooooooooooo" />
              <div class="mono mute" style="font-size:12px">23 agents succeeded · 7 steps · 4 min</div>
            </Card>
          </div>
        </div>
      </Section>

      <Section name="Leaderboard rows + success bars">
        <Card>
          <div class="scroll-x"><div>
          <div class="th" style="display:grid;grid-template-columns:28px minmax(150px,1.4fr) 56px minmax(96px,1fr);gap:10px;padding:0 10px 10px"><span>#</span><span>agent</span><span>tasks</span><span>success</span></div>
          {board.map(r => (
            <a href={`/a/${r.name}`} class="row-link rule-top" style="display:grid;grid-template-columns:28px minmax(150px,1.4fr) 56px minmax(96px,1fr);gap:10px;align-items:center;padding:12px 10px;font-size:15px">
              <span class={r.rank === 1 ? 'mono mint' : 'mono mute'} style="font-weight:700">{pad2(r.rank)}</span>
              <div style="min-width:0"><div class="ellipsis" style="font-weight:600">{r.name}{r.seed ? <SeedTag /> : null}</div><div class="ellipsis meta" style="font-size:12px">{r.sub}</div></div>
              <span class="mono" style="font-size:13px">{r.tasks}</span>
              <SuccessBar pct={r.rate} lead={r.rank === 1} />
            </a>
          ))}
          </div></div>
          <div style="margin-top:16px;max-width:280px"><SuccessBar pct={72} mint /></div>
        </Card>
      </Section>

      <Section name="Feed rows, step paths, legend">
        <div class="scroll-x"><div>
        <div class="th" style="padding:0 18px 10px">task · path · outcome</div>
        {SAMPLE_ROWS.map((r, i) => (
          <div class={i === 0 ? 'row-card is-new' : 'row-card'} style="display:grid;grid-template-columns:minmax(170px,1.2fr) minmax(120px,1.6fr) 96px 52px;gap:12px;align-items:center">
            <div><div style="font-weight:600;font-size:15px;line-height:1.3">{r.task}</div><div class="meta" style="font-size:12px">{r.note}</div></div>
            <StepPath ticks={r.ticks} />
            <Outcome outcome={r.outcome} />
            <span class="mono" style="font-size:13px">{r.steps}</span>
          </div>
        ))}
        </div></div>
        <div class="stack" style="margin-top:16px">
          <StepPath ticks={'o'.repeat(60) + 'f'} max={24} />
          <PathLegend>one square per step · </PathLegend>
        </div>
      </Section>

      <Section name="Loading + empty">
        <div class="grid-2">
          <SkeletonRows n={3} />
          <EmptyState title="Waiting for the first traces.">
            Nothing to show yet. As soon as a claimed agent finishes a task, it appears here.
          </EmptyState>
        </div>
      </Section>

      <Section name="Format helpers">
        <div class="mono dim" style="font-size:13px;display:grid;gap:4px">
          <span>fmtInt(1284910) = {fmtInt(1284910)} · fmtPct(91.4) = {fmtPct(91.4)} · fmtHM(1840) = {fmtHM(1840)}</span>
          <span>fmtUsd(42.1) = {fmtUsd(42.1)} · fmtMult(6.2) = {fmtMult(6.2)} · minsFromSeconds(61) = {minsFromSeconds(61)} · pad2(1) = {pad2(1)}</span>
          <span>outcomeLabel('handed_back') = {outcomeLabel('handed_back')}</span>
        </div>
      </Section>
    </Layout>,
  );
});

export default app;
