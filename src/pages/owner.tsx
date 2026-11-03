// /owner/:token — the private owner view of one agent: every trace with its private details (task text, site,
// exact time), the masked raw trace, and deletes. noindex, no-store, no-referrer. Enhanced by public/js/owner.js
// (which calls /api/owner with the token from the URL path); every action also works as a plain form POST.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import type { AppEnv } from '../env';
import type { AgentRow } from '../types';
import { agentByOwnerToken } from '../lib/auth';
import { fmtHM, fmtInt, fmtUsd, outcomeLabel, pad2 } from '../lib/format';
import { RULES } from '../lib/rules';
import { ago } from '../lib/time';
import {
  deleteAllOwnerTraces, deleteOwnerAgent, deleteOwnerTrace, getOwnerTrace, isTraceId, listOwnerTraces, ownerTotals,
  type OwnerTraceDetail, type OwnerTraceItem, type OwnerTotals,
} from '../data/owner';
import { Layout, page } from './layout';
import { Breadcrumb, Button, EmptyState, Kicker, Outcome, SeedTag, StatCard, StepPath, Tag } from './components';
import { notFoundPage } from './errors';

const app = new Hono<AppEnv>();

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Exact time, owner view only. owner.js rewrites [data-ts] into the viewer's local time. */
function fmtExact(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}
const Time = ({ ms, short }: { ms: number | null | undefined; short?: boolean }) =>
  <time data-ts={ms ? String(ms) : undefined} data-short={short ? '1' : undefined} datetime={ms ? new Date(ms).toISOString() : undefined}>{fmtExact(ms)}</time>;

const fmtCost = (n: number | null) => (n == null ? '—' : n > 0 && n < 0.01 ? '<$0.01' : fmtUsd(n));
const fmtDur = (s: number | null) => (s == null ? '—' : s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ''}`.trim());

function privateHeaders(c: Context<AppEnv>) {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Robots-Tag', 'noindex, nofollow');
}

const base = (token: string) => `/owner/${token}`;

// ------------------------------------------------------------------------------------------- pieces

function Confirm({ label, question, action, token, what, id, compact }: {
  label: string; question: Child; action: string; token: string; what: 'trace' | 'all' | 'agent'; id?: string; compact?: boolean;
}) {
  return (
    <details class={`ow-confirm${compact ? ' is-compact' : ''}`}>
      <summary class="btn btn-secondary btn-sm ow-danger-btn">{label}</summary>
      <form method="post" action={`${base(token)}/delete`} class="ow-confirm-box" data-ow-delete={what} data-id={id}>
        <input type="hidden" name="what" value={what} />
        {id ? <input type="hidden" name="id" value={id} /> : null}
        <input type="hidden" name="confirm" value="yes" />
        <div class="ow-confirm-q">{question}</div>
        <div class="row">
          <button type="submit" class="btn btn-sm ow-danger-go">{action}</button>
          <button type="button" class="btn btn-secondary btn-sm" data-ow-cancel>Cancel</button>
        </div>
        <p class="ow-confirm-err" role="alert" hidden></p>
      </form>
    </details>
  );
}

function AgentHead({ agent, token, totals, now, sub }: { agent: AgentRow; token: string; totals: OwnerTotals; now: number; sub?: boolean }) {
  return (
    <div class={`page-title has-aside ow-head${sub ? ' is-sub' : ''}`}>
      <div>
        <Kicker>Private · owner view</Kicker>
        <h1 class={sub ? 'h1' : 'h1-xl'}>
          {sub ? <a href={base(token)}>{agent.name}</a> : agent.name}
          {agent.is_seed ? <SeedTag /> : null}
        </h1>
        <div class="row ow-chips">
          {agent.owner_handle ? <Tag>claimed by {agent.owner_handle}</Tag> : null}
          <Tag tone="outline">{agent.app}</Tag>
          <Tag tone="outline">{agent.model}</Tag>
        </div>
        {sub ? null : (
          <div class="meta ow-meta">
            {agent.claimed_at ? <>Claimed {ago(agent.claimed_at, now)}</> : 'Claimed'}
            {totals.last_trace_at ? <> · last trace {ago(totals.last_trace_at, now)}</> : <> · no traces yet</>}
          </div>
        )}
      </div>
      <div class="page-title-aside">
        <Button href={`/a/${agent.name}`} variant="secondary">Open the public profile</Button>
      </div>
    </div>
  );
}

function PrivacyNote() {
  return (
    <div class="card card-mint ow-note">
      <Kicker small>Only you can see this page</Kicker>
      <p>
        Anyone with this link can read and delete these traces, so don't share it. Everything here was masked on your agent's
        machine and again on arrival: names, emails, phone numbers, addresses and card details show up as labels like
        <span class="ow-label">[EMAIL]</span>; passwords, keys and cookies were stripped. Public pages show a task by its name
        (“Cancelled Netflix subscription”) only once {RULES.TASK_PUBLIC_MIN_CROWD} different people's agents have done it, plus steps,
        minutes and outcome — never the task text below, the pages visited or the time.
      </p>
    </div>
  );
}

function TraceRow({ t, token }: { t: OwnerTraceItem; token: string }) {
  return (
    <li>
      <a href={`${base(token)}?trace=${t.id}`} class="row-card row-link ow-row">
        <div class="ow-when mono"><Time ms={t.occurred_at} short /></div>
        <div class="ow-task">
          <div class="ow-task-label">{t.task}{t.task_public ? null : <span class="meta"> · private name</span>}</div>
          {t.task_text ? <div class="ow-task-text">{t.task_text}</div> : null}
        </div>
        <div class="ow-site mono ellipsis">{t.site ?? '—'}</div>
        <StepPath ticks={t.ticks} class="ow-path" />
        <Outcome outcome={t.outcome} />
        <div class="ow-nums mono">{t.steps} st · {t.mins} m · {fmtCost(t.cost)}</div>
      </a>
    </li>
  );
}

// ------------------------------------------------------------------------------------------- detail

type RawStep = {
  type?: unknown; action?: unknown; target?: unknown; url?: unknown; result?: unknown; observation?: unknown;
  error?: unknown; model_response?: unknown; sensitive?: unknown; duration_ms?: unknown;
};
type RawMsg = { role?: unknown; content?: unknown };
const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);

interface ViewStep { type: string; action: string; target: string | null; where: string | null; result: string; observation: string | null; error: string | null; model: string | null; sensitive: string | null }

function stepsFrom(d: OwnerTraceDetail): ViewStep[] {
  const raw = rec(d.raw);
  if (raw && Array.isArray(raw.steps)) {
    return (raw.steps as RawStep[]).map(st => ({
      type: s(st?.type) ?? 'other',
      action: s(st?.action) ?? '(no description)',
      target: s(st?.target),
      where: s(st?.url),
      result: s(st?.result) ?? 'ok',
      observation: s(st?.observation),
      error: s(st?.error),
      model: s(st?.model_response),
      sensitive: s(st?.sensitive),
    }));
  }
  return [];
}

const RESULT_CLASS: Record<string, string> = { ok: 'is-ok', retry: 'is-retry', fail: 'is-fail' };
const RESULT_LABEL: Record<string, string> = { ok: 'worked', retry: 'retried', fail: 'failed' };

function Detail({ d, token }: { d: OwnerTraceDetail; token: string }) {
  const t = d.trace;
  const steps = stepsFrom(d);
  const raw = rec(d.raw);
  const messages = raw && Array.isArray(raw.messages) ? (raw.messages as RawMsg[]).filter(m => s(m?.content)) : [];
  const json = d.raw != null ? JSON.stringify(d.raw, null, 2) : null;
  const facts: [string, Child][] = [
    ['started', <Time ms={t.started_at} />],
    ['finished', <Time ms={t.ended_at ?? t.occurred_at} />],
    ['received', <Time ms={t.received_at} />],
    ['duration', fmtDur(t.duration_s)],
    ['steps', `${t.steps} (${t.mins} min public)`],
    ['cost', fmtCost(t.cost)],
    ['model · app', `${t.model} · ${t.app}`],
    ['sites', t.sites.length ? t.sites.join(', ') : t.site ?? '—'],
    ['masked', `${fmtInt(t.mask_client)} on the agent · ${fmtInt(t.mask_server)} more on arrival`],
    ['task name', `${t.task_public ? `public · ${fmtInt(t.task_crowd)} people's agents did it` : `private until ${RULES.TASK_PUBLIC_MIN_CROWD} people's agents do it`} · named by ${t.task_source === 'agent' ? 'your agent' : t.task_source === 'llm' ? 'Wisptrace (model)' : 'Wisptrace (from the description)'}`],
  ];
  if (t.recipe_id) facts.push(['followed recipe', t.recipe_id]);

  return (
    <div class="ow-detail anim-rise-fast">
      <div class="ow-detail-head">
        <div class="row">
          <Outcome outcome={t.outcome} />
          {t.site ? <Tag tone="outline">{t.site}</Tag> : null}
          {t.blocked_by_site ? <Tag tone="coral">site blocks agents</Tag> : null}
        </div>
        <h2 class="h2">{t.task}</h2>
        {t.task_text ? <p class="ow-task-full">{t.task_text}</p> : null}
        {t.fail_reason ? <p class="ow-fail"><strong>{outcomeLabel(t.outcome) === 'failed' ? 'Why it failed:' : 'Why it was handed back:'}</strong> {t.fail_reason}</p> : null}
      </div>

      <div class="grid-main ow-detail-grid">
        <div class="stack-lg">
          <div class="card">
            <div class="panel-head"><span>Steps, in order</span><StepPath ticks={t.ticks} size={7} /></div>
            {d.raw_missing ? (
              <p class="meta ow-missing">
                The full trace for this one is missing, so there are no steps to show.
              </p>
            ) : null}
            {steps.length ? (
              <ol class="ow-steps">
                {steps.map((st, i) => (
                  <li class={`ow-step ${RESULT_CLASS[st.result] ?? 'is-ok'}`}>
                    <div class="ow-step-n mono">step {pad2(i + 1)}</div>
                    <div class="ow-step-body">
                      <div class="ow-step-action">
                        {st.action}
                        {st.sensitive ? <Tag tone="line" ink="dim" class="ow-step-tag">secure · {st.sensitive}</Tag> : null}
                      </div>
                      <div class="ow-step-meta mono">
                        <span>{st.type}</span>
                        {st.target ? <span>“{st.target}”</span> : null}
                        {st.where ? <span class="ow-step-where">{st.where}</span> : null}
                      </div>
                      {st.observation ? <div class="ow-step-obs">{st.observation}</div> : null}
                      {st.error ? <div class="ow-step-err">{st.error}</div> : null}
                      {st.model ? <blockquote class="ow-step-model"><span class="th">model</span>{st.model}</blockquote> : null}
                    </div>
                    <div class={`ow-step-result mono ${RESULT_CLASS[st.result] ?? ''}`}>{RESULT_LABEL[st.result] ?? st.result}</div>
                  </li>
                ))}
              </ol>
            ) : <EmptyState title="No steps recorded">This trace arrived without steps.</EmptyState>}
          </div>

          {messages.length ? (
            <div class="card">
              <div class="panel-head"><span>Model responses</span><span>{messages.length}</span></div>
              <div class="ow-msgs">
                {messages.map(m => (
                  <div class={`ow-msg is-${s(m.role) ?? 'other'}`}>
                    <div class="th">{s(m.role) ?? 'message'}</div>
                    <div class="ow-msg-text">{s(m.content)}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <details class="card ow-raw">
            <summary><span class="th">Raw JSON (masked)</span><span class="meta">{json ? `${fmtInt(json.length)} characters` : 'not stored'}</span></summary>
            {json ? (
              <>
                <div class="ow-raw-tools"><button type="button" class="copy-chip" data-copy="" data-copy-target="#ow-raw-json">copy JSON</button></div>
                <pre id="ow-raw-json" class="ow-raw-pre">{json}</pre>
              </>
            ) : <p class="meta">The full trace for this one is missing.</p>}
          </details>
        </div>

        <div class="stack-lg">
          <div class="card">
            <div class="panel-head"><span>Details</span></div>
            <dl class="ow-facts">
              {facts.map(([k, v]) => <><dt class="th">{k}</dt><dd>{v}</dd></>)}
            </dl>
          </div>
          <div class="card card-coral ow-danger">
            <Kicker small tone="coral">Delete</Kicker>
            <p class="body-sm">Removes this trace and its stored full JSON for good. Recipes, task counts and upvotes rebuild without it.</p>
            <Confirm token={token} what="trace" id={t.id} label="Delete this trace"
              question="Delete this trace forever? This can't be undone." action="Yes, delete it" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------- page

async function ownerPage(c: Context<AppEnv>, token: string, agent: AgentRow) {
  const now = Date.now();
  const traceId = c.req.query('trace');
  const cursor = c.req.query('cursor') ?? null;
  const done = c.req.query('done');
  const totals = await ownerTotals(c.env, agent.id, now);

  const layout = (body: Child, status: 200 | 404 = 200) => page(
    c,
    <Layout c={c} title={`${agent.name} · private`} description="Private owner view." css={['owner']} scripts={['owner']} noindex>
      {body}
    </Layout>,
    status,
  );

  if (traceId) {
    const d = isTraceId(traceId) ? await getOwnerTrace(c.env, agent.id, traceId) : null;
    return layout(
      <div data-ow-root>
        <Breadcrumb items={[{ label: agent.name, href: base(token) }, { label: 'traces', href: base(token) }, { label: d ? d.trace.task : 'not found' }]} />
        <AgentHead agent={agent} token={token} totals={totals} now={now} sub />
        {d ? <Detail d={d} token={token} /> : (
          <EmptyState title="That trace isn't here">It was deleted, or it belongs to another agent. <a href={base(token)} class="link-cta">Back to every trace →</a></EmptyState>
        )}
      </div>,
      d ? 200 : 404,
    );
  }

  const list = await listOwnerTraces(c.env, agent.id, { cursor });
  const flash = done === 'trace' ? 'Trace deleted.' : done === 'all' ? 'Every trace deleted.' : null;

  return layout(
    <div data-ow-root>
      <AgentHead agent={agent} token={token} totals={totals} now={now} />
      {flash ? <div class="ow-flash anim-rise-fast" role="status">{flash}</div> : null}

      <div class="stat-row ow-stats" style="--cols:5">
        <StatCard value={fmtInt(totals.tasks)} label="tasks sent" accent />
        <StatCard value={totals.tasks ? `${totals.success_pct}%` : '—'} label="done without handing back" />
        <StatCard value={fmtHM(totals.minutes)} label="time working" />
        <StatCard value={fmtUsd(totals.cost_usd)} label="model cost reported" />
        <StatCard value={totals.streak} unit="d" label={`streak · best ${totals.best_streak}`} />
      </div>

      <PrivacyNote />

      <section class="ow-list">
        <div class="panel-head ow-list-head">
          <span>{cursor ? 'Older traces' : 'Every trace · newest first'}</span>
          <span>{fmtInt(totals.tasks)} total · times in your timezone</span>
        </div>
        {list.items.length ? (
          <>
            <div class="ow-cols th" aria-hidden="true">
              <span>when</span><span>task</span><span>site</span><span>path</span><span>outcome</span><span class="ow-cols-r">st · min · cost</span>
            </div>
            <ol class="ow-rows">{list.items.map(t => <TraceRow t={t} token={token} />)}</ol>
          </>
        ) : cursor ? (
          <EmptyState title="Nothing older">That was the oldest trace. <a href={base(token)} class="link-cta">Back to the newest →</a></EmptyState>
        ) : (
          <EmptyState title="Waiting for the first traces">
            Your agent sends one after each task it finishes. They show up here with every private detail, and on its public
            profile as anonymised totals.
          </EmptyState>
        )}
        <div class="row ow-pager">
          {cursor ? <a href={base(token)} class="btn btn-secondary btn-sm">← Newest</a> : null}
          {list.cursor ? <a href={`${base(token)}?cursor=${encodeURIComponent(list.cursor)}`} class="btn btn-secondary btn-sm push">Older traces →</a> : null}
        </div>
      </section>

      <section class="card card-coral ow-danger ow-danger-zone">
        <Kicker small tone="coral">Delete</Kicker>
        <div class="ow-danger-grid">
          <div class="stack">
            <div class="h-card">Delete every trace</div>
            <p class="body-sm">Removes all {fmtInt(totals.tasks)} traces and their raw JSON. The agent stays claimed and keeps reporting new tasks.</p>
            {totals.tasks ? (
              <Confirm token={token} what="all" label="Delete all traces"
                question={`Delete all ${fmtInt(totals.tasks)} traces forever? This can't be undone.`} action="Yes, delete every trace" />
            ) : <span class="meta">Nothing to delete yet.</span>}
          </div>
          <div class="stack">
            <div class="h-card">Delete {agent.name}</div>
            <p class="body-sm">Removes every trace, takes the profile down and revokes the agent's key and this link. Its traces stop being accepted.</p>
            <Confirm token={token} what="agent" label="Delete the agent"
              question={<>Delete <strong>{agent.name}</strong>, its profile and every trace? This link stops working right away.</>}
              action="Yes, delete the agent" />
          </div>
        </div>
      </section>
    </div>,
  );
}

function goodbyePage(c: Context<AppEnv>, name: string, traces: number) {
  return page(
    c,
    <Layout c={c} title="Agent deleted" description="Private owner view." css={['owner']} noindex>
      <div class="ow-gone anim-rise-fast">
        <Kicker>Deleted</Kicker>
        <h1 class="h1">{name} is gone.</h1>
        <p class="lead">
          Its profile is down, {fmtInt(traces)} {traces === 1 ? 'trace was' : 'traces were'} deleted, and its key and this owner link
          no longer work. Recipes and trends rebuild without its traces within minutes.
        </p>
        <div class="row ow-gone-actions">
          <Button href="/">Back to the start</Button>
          <Button href="/claim" variant="secondary">Add another agent</Button>
        </div>
      </div>
    </Layout>,
  );
}

app.get('/owner/:token', async c => {
  privateHeaders(c);
  const token = c.req.param('token');
  const agent = await agentByOwnerToken(c.env, token);
  if (!agent) return notFoundPage(c);
  return ownerPage(c, token, agent);
});

// No-JS fallback for the delete buttons (owner.js uses the DELETE API instead).
app.post('/owner/:token/delete', async c => {
  privateHeaders(c);
  const token = c.req.param('token');
  const agent = await agentByOwnerToken(c.env, token);
  if (!agent) return notFoundPage(c);
  const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
  const what = form.what;
  if (form.confirm !== 'yes') return c.redirect(base(token), 303);
  if (what === 'trace' && typeof form.id === 'string') {
    await deleteOwnerTrace(c.env, agent.id, form.id);
    return c.redirect(`${base(token)}?done=trace`, 303);
  }
  if (what === 'all') {
    await deleteAllOwnerTraces(c.env, agent.id);
    return c.redirect(`${base(token)}?done=all`, 303);
  }
  if (what === 'agent') {
    const { traces } = await deleteOwnerAgent(c.env, agent);
    return goodbyePage(c, agent.name, traces);
  }
  return c.redirect(base(token), 303);
});

export default app;
