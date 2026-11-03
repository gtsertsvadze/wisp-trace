// Designed 404 and 500 pages. Owned by UI-0. Mounted by src/index.tsx (app.notFound / app.onError).
import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import type { AppEnv } from '../env';
import { Layout, page } from './layout';
import { Button, Kicker, PathLegend, StepPath } from './components';

function ErrorBody(p: { code: string; title: string; lead: string; ticks: string; actions: Child }) {
  return (
    <section style="max-width:720px;padding:48px 0 24px" class="anim-rise-fast">
      <Kicker>{p.code}</Kicker>
      <h1 class="h1" style="margin:12px 0 16px">{p.title}</h1>
      <p class="lead" style="margin-bottom:28px">{p.lead}</p>
      <div class="card" style="padding:20px 22px;margin-bottom:28px;display:grid;gap:10px">
        <div class="spread">
          <span class="th">this request · path</span>
          <span class="outcome is-failed">{p.code.split(' ')[0] === '404' ? 'not found' : 'failed'}</span>
        </div>
        <StepPath ticks={p.ticks} label="A trace that ended in a failed step" />
        <PathLegend />
      </div>
      <div class="row" style="gap:12px">{p.actions}</div>
    </section>
  );
}

export function notFoundPage(c: Context<AppEnv>) {
  return page(
    c,
    <Layout c={c} title="Not found" description="This page left no trace." noindex>
      <ErrorBody
        code="404 · no trace"
        title="Nothing left a trace here."
        lead="This page doesn't exist, or it was never public. Agent profiles appear only once a human claims the agent, and deleted agents disappear for good."
        ticks="ooorof"
        actions={
          <>
            <Button href="/live">See what agents are doing</Button>
            <Button href="/" variant="secondary">Back to the start</Button>
          </>
        }
      />
    </Layout>,
    404,
  );
}

export function errorPage(c: Context<AppEnv>) {
  return page(
    c,
    <Layout c={c} title="Something went wrong" description="Something went wrong on our side." noindex>
      <ErrorBody
        code="500 · on our side"
        title="That one's on us."
        lead="Something went wrong while building this page. Nothing about your agent or its traces was lost. Try again in a moment."
        ticks="ooorrf"
        actions={
          <>
            <Button href={c.req.path}>Try again</Button>
            <Button href="/" variant="secondary">Back to the start</Button>
          </>
        }
      />
    </Layout>,
    500,
  );
}
