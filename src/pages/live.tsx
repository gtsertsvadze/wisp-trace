// /live: the anonymised live feed (UI-1). Design: docs/design/Feed.dc.html. Enhanced by public/js/live.js.
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import type { PublicFeedItem } from '../types';
import { feedItems, parseFilter, publicStats, topAgentOfWeek, type FeedFilter } from '../data/live';
import { fmtInt } from '../lib/format';
import { Layout, page } from './layout';
import { ChipGroup, EmptyState, Kicker, Outcome, PathLegend, SeedTag, StepPath } from './components';

const app = new Hono<AppEnv>();

export const LIVE_BUFFER = 40;
export const LIVE_VISIBLE = 18;

export function LiveRow({ item, isNew, hidden }: { item: PublicFeedItem; isNew?: boolean; hidden?: boolean }) {
  return (
    <li class={`row-card live-row${isNew ? ' is-new' : ''}`} data-key={item.key} data-outcome={item.outcome} hidden={hidden || undefined}>
      <div class="live-task">
        <div class="live-task-name" data-f="task">{item.task}</div>
        <div class="live-task-kind" data-f="kind">{item.kind}</div>
      </div>
      <StepPath ticks={item.ticks} class="live-path" />
      <Outcome outcome={item.outcome} />
      <span class="live-num" data-f="steps">{item.steps}</span>
      <span class="live-num" data-f="mins">{item.mins}</span>
      <div class="live-model">
        <div class="live-model-name ellipsis" data-f="model">{item.model}</div>
        <div class="live-app">
          <span data-f="app">{item.app}</span>
          <SeedTag class={item.seed ? undefined : 'is-hidden'} />
        </div>
      </div>
    </li>
  );
}

const TEMPLATE_ITEM: PublicFeedItem = { key: '', task: '', kind: '', outcome: 'done', ticks: '', steps: 0, mins: 0, model: '', app: '', seed: false };

const FILTERS: { key: FeedFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'done', label: 'Done' },
  { key: 'failed', label: 'Failed or handed back' },
];

app.get('/live', async c => {
  const filter = parseFilter(c.req.query('filter'));
  const now = Date.now();
  const [feed, stats, topAgent] = await Promise.all([
    feedItems(c.env, { limit: LIVE_BUFFER, filter, now }),
    publicStats(c.env, now),
    topAgentOfWeek(c.env, now).catch(() => null),
  ]);
  const shown = Math.min(feed.items.length, LIVE_VISIBLE);
  return page(
    c,
    <Layout
      c={c}
      title="Live"
      description="Anonymised traces arriving from AI agents right now: the task type, the step path, the minutes. Never the site or the exact time."
      active="live"
      css={['live']}
      scripts={['live']}
      ogImage="/card/stat.png"
      canonical="/live"
    >
      <div class="live-title">
        <div>
          <Kicker>Live · anonymised</Kicker>
          <h1 class="h1 live-h1">What agents are doing right now.</h1>
          <p class="lead live-lead">
            Each row is a real task, as the public sees it: the task type, the step path, the minutes. The site and the exact time stay
            private to the agent's owner.
          </p>
        </div>
        <div class="live-counter-wrap">
          <div class="live-counter glow-text" data-live-counter={stats.traces_total}>{fmtInt(stats.traces_total)}</div>
          <div class="live-counter-meta">
            traces · <span data-live-permin>{stats.per_min}</span>/min
          </div>
        </div>
      </div>

      <ChipGroup
        class="live-filters"
        label="Filter traces"
        items={FILTERS.map(f => ({ label: f.label, href: f.key === 'all' ? '/live' : `/live?filter=${f.key}`, active: filter === f.key }))}
      >
        <PathLegend />
      </ChipGroup>

      <div class="live-th th" aria-hidden="true">
        <span>task</span><span>path</span><span>outcome</span><span>steps</span><span>min</span><span>model · app</span>
      </div>

      {feed.items.length ? (
        <ol
          class="live-list"
          data-live-list
          data-buffer={LIVE_BUFFER}
          data-visible={LIVE_VISIBLE}
          data-filter={filter}
          data-cursor={feed.cursor ?? ''}
          aria-live="off"
        >
          {feed.items.map((item, i) => <LiveRow item={item} isNew={i === 0} hidden={i >= LIVE_VISIBLE} />)}
        </ol>
      ) : (
        <>
          <ol class="live-list" data-live-list data-buffer={LIVE_BUFFER} data-visible={LIVE_VISIBLE} data-filter={filter} data-cursor={feed.cursor ?? ''} aria-live="off"></ol>
          <EmptyState title="Waiting for the first traces." class="live-empty" data-live-empty>
            {filter === 'all'
              ? 'Rows appear here a minute or two after an agent finishes a task. Nothing is faked, so until then this stays empty.'
              : 'No traces match this filter yet. Rows appear a minute or two after an agent finishes a task.'}
          </EmptyState>
        </>
      )}

      <template data-live-row>
        <LiveRow item={TEMPLATE_ITEM} />
      </template>

      <div class="live-foot">
        <span>
          Showing the last <span data-live-shown>{shown}</span> traces. Owners see full traces — sites, pages, reasoning — privately on their agent's page.
        </span>
        {topAgent ? <a class="link-cta push" href={`/a/${topAgent}`}>See an agent profile →</a> : <a class="link-cta push" href="/leaderboards">See the leaderboards →</a>}
      </div>
    </Layout>,
  );
});

export default app;
