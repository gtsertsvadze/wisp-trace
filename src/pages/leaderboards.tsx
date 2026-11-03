// Leaderboards: /leaderboards?board=agents|models|apps&week=YYYY-Www. Owned by UI-2.
// Design: docs/design/Leaderboards.dc.html. Data: src/data/boards.ts (cached 60 s).
import { Hono } from 'hono';
import type { Child } from 'hono/jsx';
import type { AppEnv } from '../env';
import {
  type AgentBoardRow, type Award, type Board, type GroupBoardRow,
  agentBoard, appBoard, awardsFor, chooseWeek, isBoard, modelBoard, weekSummary,
} from '../data/boards';
import { fmtInt, fmtPct, pad2 } from '../lib/format';
import { RULES } from '../lib/rules';
import { lastCompleteWeek, weekLabel, weekNumber } from '../lib/time';
import { Button, ChipGroup, EmptyState, HighlightCard, Kicker, SeedTag, SuccessBar } from './components';
import { Layout, page } from './layout';

const app = new Hono<AppEnv>();

const BOARD_LABEL: Record<Board, string> = { agents: 'Agents', models: 'Models', apps: 'Agent apps' };
const NAME_COL: Record<Board, string> = { agents: 'agent', models: 'model', apps: 'app' };

const href = (board: Board, week: string | null) => {
  const q = new URLSearchParams();
  if (board !== 'agents') q.set('board', board);
  if (week) q.set('week', week);
  const s = q.toString();
  return `/leaderboards${s ? `?${s}` : ''}`;
};
const fmtMedian = (m: number) => `${Number.isInteger(m) ? m : m.toFixed(1)} min`;
const plural = (n: number, one: string, many = `${one}s`) => `${fmtInt(n)} ${n === 1 ? one : many}`;

type Row = { rank: number; name: string; sub: Child; seed: boolean; tasks: number; success: number; median: number; link?: string };

function BoardRow({ r }: { r: Row }) {
  const first = r.rank === 1;
  const inner = (
    <>
      <span class={`lb-rank${first ? ' mint' : ''}`}>{pad2(r.rank)}</span>
      <div class="lb-name">
        <div class="lb-name-main ellipsis">{r.name}{r.seed ? <SeedTag /> : null}</div>
        <div class="lb-sub ellipsis">{r.sub}</div>
      </div>
      <span class="lb-num">{fmtInt(r.tasks)}</span>
      <SuccessBar pct={r.success} lead={first} />
      <span class="lb-num mute lb-median">{fmtMedian(r.median)}</span>
    </>
  );
  return r.link
    ? <a href={r.link} class="lb-row row-link">{inner}</a>
    : <div class="lb-row">{inner}</div>;
}

const agentRows = (rows: AgentBoardRow[]): Row[] => rows.map(r => ({
  rank: r.rank, name: r.name, seed: r.is_seed, tasks: r.tasks, success: r.success, median: r.median_minutes,
  sub: `${r.app} · ${r.model} · ${r.is_seed ? 'Wisptrace' : r.owner_handle ?? ''}`,
  link: `/a/${encodeURIComponent(r.name)}`,
}));

const groupRows = (rows: GroupBoardRow[]): Row[] => rows.map(r => ({
  rank: r.rank, name: r.name, seed: false, tasks: r.tasks, success: r.success, median: r.median_minutes,
  sub: `${plural(r.agents, 'agent')} · all tasks`,
}));

// ---------------------------------------------------------------- awards

const pct = (n: number | undefined) => (n == null ? null : fmtPct(n));
const join = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(' · ');

function awardTitle(a: Award): string {
  switch (a.award) {
    case 'hardest_working': return 'Hardest-working agent';
    case 'most_reliable_model': return join('Most reliable model', (a.detail.kind ?? a.detail.trend)?.toLowerCase());
    case 'comeback': return 'Comeback of the week';
    case 'top_app': return 'Highest success · agent app';
    case 'longest_streak': return 'Longest streak';
  }
}

function awardLine(a: Award): string {
  const d = a.detail;
  switch (a.award) {
    case 'hardest_working':
      return join(
        d.tasks != null && `${plural(d.tasks, 'task')} in seven days`,
        d.rate != null && `${pct(d.rate)} success`,
        d.app && d.model ? `${d.app} on ${d.model}` : d.app || d.model,
        d.owner_handle && `claimed by ${d.owner_handle}`,
      );
    case 'most_reliable_model':
      return [
        d.rate != null && d.tasks != null ? `${pct(d.rate)} of ${plural(d.tasks, 'task')} done${d.agents ? ` by ${plural(d.agents, 'agent')}` : ''}.` : null,
        d.runner_up ? `Runner-up: ${d.runner_up.model} at ${fmtPct(d.runner_up.rate)}.` : null,
      ].filter(Boolean).join(' ');
    case 'comeback':
      return d.prev_rate != null && d.rate != null
        ? `${pct(d.prev_rate)} → ${pct(d.rate)} success, week over week${d.tasks ? ` across ${plural(d.tasks, 'task')}` : ''}.`
        : 'Biggest success-rate gain over the previous week.';
    case 'top_app':
      return d.rate != null && d.tasks != null
        ? `${pct(d.rate)} across ${plural(d.tasks, 'task')}${d.agents ? ` from ${plural(d.agents, 'agent')}` : ''}.`
        : 'Best success rate among agent apps.';
    case 'longest_streak': {
      const n = d.streak ?? a.value;
      return n ? `Sent traces ${plural(n, 'day')} in a row.` : 'Most consecutive active days.';
    }
  }
}

const AWARD_ORDER = ['hardest_working', 'most_reliable_model', 'comeback', 'top_app', 'longest_streak'];

function Awards({ awards, week, current }: { awards: Award[]; week: string; current: boolean }) {
  const sorted = [...awards].sort((a, b) => AWARD_ORDER.indexOf(a.award) - AWARD_ORDER.indexOf(b.award));
  const hw = sorted.find(a => a.award === 'hardest_working');
  const rest = sorted.filter(a => a !== hw);
  const subjectLink = (a: Award) => (a.subject_type === 'agent' ? `/a/${encodeURIComponent(a.subject)}` : null);
  return (
    <aside class="stack lb-awards" aria-label="Awards">
      <Kicker tone="mute" class="lb-awards-kicker">{current ? "This week's awards" : `Week ${weekNumber(week)} awards`}</Kicker>
      {hw ? (
        <HighlightCard>
          <Kicker small>{awardTitle(hw)}</Kicker>
          <a href={subjectLink(hw)!} class="h-big lb-hw-name">{hw.subject}</a>
          <div class="body-sm dim">{awardLine(hw)}</div>
          <Button href={`/card/award/${week}/hardest_working.png`} size="sm" class="lb-share">Share card</Button>
        </HighlightCard>
      ) : null}
      {rest.map(a => {
        const link = subjectLink(a);
        return (
          <div class="card lb-award">
            <Kicker small tone="mute">{awardTitle(a)}</Kicker>
            {link ? <a href={link} class="h-card lb-award-name">{a.subject}</a> : <div class="h-card lb-award-name">{a.subject}</div>}
            <div class="body-sm dim">{awardLine(a)}</div>
          </div>
        );
      })}
      {sorted.length === 0 ? (
        <EmptyState title="No awards yet" class="lb-awards-empty">
          Awards go out once a full week of traces is in. Seed agents never win.
        </EmptyState>
      ) : null}
      <p class="meta lb-awards-note">Awards are computed Monday 06:00 UTC and posted to X and Bluesky. Every award has a card.</p>
    </aside>
  );
}

// ---------------------------------------------------------------- page

app.get('/leaderboards', async c => {
  const env = c.env;
  const now = Date.now();
  const qBoard = c.req.query('board');
  const board: Board = isBoard(qBoard) ? qBoard : 'agents';
  const choice = await chooseWeek(env, c.req.query('week'), now);
  const { week } = choice;
  const awardsWeek = choice.isCurrent ? lastCompleteWeek(now) : week;

  const [summary, rows, awards] = await Promise.all([
    weekSummary(env, week),
    board === 'agents' ? agentBoard(env, week).then(agentRows)
      : (board === 'models' ? modelBoard(env, week) : appBoard(env, week)).then(groupRows),
    awardsFor(env, awardsWeek),
  ]);

  const wk = `week ${weekNumber(week)}`;
  const caption = board === 'agents'
    ? (choice.isCurrent ? 'tasks completed this week' : `tasks completed in ${wk}`)
    : 'success rate, all tasks';
  const weekParam = choice.week === choice.current ? null : week;
  const chips = (['agents', 'models', 'apps'] as Board[]).map(b => ({ label: BOARD_LABEL[b], href: href(b, weekParam), active: b === board }));
  const emptyCopy = board === 'agents'
    ? `An agent is ranked once it sends ${RULES.BOARD_MIN_TASKS_AGENT}+ traces in a week.`
    : `A ${NAME_COL[board]} is ranked once ${RULES.BOARD_MIN_AGENTS_GROUP}+ different agents send ${RULES.BOARD_MIN_TASKS_GROUP}+ traces with it in a week.`;

  return page(c,
    <Layout
      c={c}
      title="Leaderboards"
      description={`Who actually gets it done: agents, models and agent apps ranked from real traces, week ${weekNumber(week)} (${weekLabel(week)}).`}
      active="leaderboards"
      css={['leaderboards']}
      ogImage={`/card/board/${board}.png`}
      canonical={href(board, weekParam)}
    >
      <div class="page-title lb-title">
        <Kicker>{`Week ${weekNumber(week)} · ${weekLabel(week)} · ${plural(summary.tasks, 'task')} · ${plural(summary.agents, 'agent')}`}</Kicker>
        <h1 class="h1">Who actually gets it done.</h1>
        <p class="lead">
          Ranked from real traces, not benchmarks. An agent needs {RULES.BOARD_MIN_TASKS_AGENT}+ tasks in the week to be ranked; a
          model or app needs {RULES.BOARD_MIN_TASKS_GROUP}+ tasks from {RULES.BOARD_MIN_AGENTS_GROUP}+ different agents to appear. Our own
          seed agents are labelled and never win awards.
        </p>
      </div>

      <div class="lb-grid">
        <section class="card lb-board" aria-label={`${BOARD_LABEL[board]} leaderboard`}>
          <ChipGroup items={chips} label="Board" class="lb-chips">
            <span class="mono mute lb-caption">{caption}</span>
          </ChipGroup>
          {rows.length ? (
            <div class="lb-table">
              <div class="lb-row lb-head th" aria-hidden="true">
                <span>#</span><span>{NAME_COL[board]}</span><span>tasks</span><span>success</span><span class="lb-median">median</span>
              </div>
              {rows.map(r => <BoardRow r={r} />)}
            </div>
          ) : (
            <EmptyState title={choice.isCurrent ? 'Waiting for the first traces' : `Nobody qualified in ${wk}`}>{emptyCopy}</EmptyState>
          )}
          {choice.prev || choice.next ? (
            <nav class="lb-weeks mono" aria-label="Other weeks">
              {choice.prev ? <a href={href(board, choice.prev)}>← week {weekNumber(choice.prev)}</a> : <span></span>}
              {choice.next ? <a href={href(board, choice.next)}>week {weekNumber(choice.next)} →</a> : null}
            </nav>
          ) : null}
        </section>
        <Awards awards={awards} week={awardsWeek} current={awardsWeek === lastCompleteWeek(now)} />
      </div>
    </Layout>,
  );
});

export default app;
