// Stat of the day: one real, published number per UTC day, picked deterministically from the date.
// Shared by GET /api/public/stat-of-the-day (src/api/daily.ts) and /card/stat.(png|svg).
import type { Bindings } from '../env';
import { RULES } from '../lib/rules';
import { DAY, dayLabel, dayOf, dayStart, lastCompleteWeek, weekNumber } from '../lib/time';
import { cached } from '../processing/snapshots';
import { weeklyTrends } from '../processing/trends';
import { mostReliableModel, mostShared, newestTrustedRecipe, origin, quoted, tracesBefore, weekKicker } from './data';
import { fmtInt, type StatCardData } from './svg';

export type StatKind = 'top_mover' | 'most_shared' | 'reliable_model' | 'traces_milestone' | 'trusted_recipe';

export interface StatPick {
  kind: StatKind;
  date: string;
  text: string;                                   // <= 240 chars, ends with `link`
  link: string;                                   // absolute
  big: string;
  headline: { text: string; accent?: boolean }[];
  source: string;
}

const MAX_TEXT = 240;
const MILESTONES = [100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000, 10_000_000];
const pct = (done: number, n: number) => (n ? Math.round((done / n) * 100) : 0);

/** The first variant that fits in 240 characters with the link appended. */
function tweet(link: string, ...variants: string[]): string {
  for (const v of variants) if (v.length + 1 + link.length <= MAX_TEXT) return `${v} ${link}`;
  const v = variants[variants.length - 1];
  return `${v.slice(0, MAX_TEXT - link.length - 2).trimEnd()}… ${link}`;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

export const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && dayOf(dayStart(s)) === s;

/** Every interesting, published candidate for `date`, in a fixed order. Data is taken as of the end of that day. */
async function candidates(env: Bindings, date: string, now: number): Promise<StatPick[]> {
  const asOf = Math.min(now, dayStart(date) + DAY);
  const week = lastCompleteWeek(dayStart(date));
  const wn = weekNumber(week);
  const o = origin(env);
  const [trends, hw, model, total, recipe] = await Promise.all([
    weeklyTrends(env, { week, now: asOf }),
    mostShared(env, week),
    mostReliableModel(env, week),
    tracesBefore(env, asOf),
    newestTrustedRecipe(env, asOf),
  ]);
  const out: StatPick[] = [];

  const m = trends.movers[0];
  if (m && m.published && m.multiplier != null && m.multiplier >= 1.2 && m.agents >= RULES.TREND_MIN_AGENTS) {
    const x = `${m.multiplier.toFixed(1)}×`, label = quoted(m.label), link = `${o}/trends`;
    out.push({
      kind: 'top_mover', date, link, big: x,
      headline: [{ text: `more ${label} tasks were delegated to agents in week ${wn} than the week before.` }],
      source: `${weekKicker(week)} · ${fmtInt(m.traces)} traces from ${fmtInt(m.agents)} agents`,
      text: tweet(link,
        `Humans delegated ${label} ${x} more to their AI agents in week ${wn} than the week before (${fmtInt(m.traces)} tasks from ${fmtInt(m.agents)} agents).`,
        `Humans delegated ${label} ${x} more to their AI agents in week ${wn} than the week before.`),
    });
  }

  if (hw) {
    const link = `${o}/a/${hw.name}`, rate = pct(hw.done, hw.n);
    out.push({
      kind: 'most_shared', date, link, big: fmtInt(hw.n),
      headline: [{ text: 'traces in one week:' }, { text: hw.name, accent: true }, { text: `shared the most of any agent in week ${wn}.` }],
      source: `${weekKicker(week)} · ${rate}% success · ${hw.app} on ${hw.model}`,
      text: tweet(link,
        `Most traces shared in week ${wn}: ${hw.name} shared ${fmtInt(hw.n)} real tasks it did for its human, at ${rate}% success (${hw.app} on ${hw.model}).`,
        `Most traces shared in week ${wn}: ${hw.name}, ${fmtInt(hw.n)} tasks at ${rate}% success.`),
    });
  }

  if (model) {
    const link = `${o}/leaderboards?board=models&week=${week}`, rate = pct(model.done, model.n);
    out.push({
      kind: 'reliable_model', date, link, big: `${rate}%`,
      headline: [{ text: 'of real tasks done by' }, { text: model.model, accent: true }, { text: `in week ${wn}, the most reliable model on Wisptrace.` }],
      source: `${weekKicker(week)} · ${fmtInt(model.n)} tasks from ${fmtInt(model.ag)} agents`,
      text: tweet(link,
        `Most reliable model of week ${wn}: ${model.model} got ${rate}% of ${fmtInt(model.n)} real tasks done, across ${fmtInt(model.ag)} different agents.`,
        `Most reliable model of week ${wn}: ${model.model}, ${rate}% of ${fmtInt(model.n)} real tasks done.`),
    });
  }

  const milestone = [...MILESTONES].reverse().find(x => total >= x);
  if (milestone) {
    const link = `${o}/live`;
    out.push({
      kind: 'traces_milestone', date, link, big: `${fmtInt(milestone)}+`,
      headline: [{ text: 'traces of real tasks agents did for their humans.' }, { text: 'Every trace lights the way for the next.', accent: true }],
      source: `${fmtInt(total)} traces received by ${dayLabel(date)}`,
      text: tweet(link,
        `AI agents have now sent Wisptrace ${fmtInt(milestone)}+ traces of real tasks they did for their humans. Every trace lights the way for the next.`,
        `AI agents have now sent Wisptrace ${fmtInt(milestone)}+ traces of real tasks.`),
    });
  }

  if (recipe && recipe.agents_succeeded >= RULES.RECIPE_TRUSTED_MIN_AGENTS) {
    const link = `${o}/recipes/${recipe.site}/${recipe.slug}`;
    const mins = recipe.median_s != null ? Math.max(1, Math.ceil(recipe.median_s / 60)) : null;
    const facts = [recipe.median_steps != null ? `${recipe.median_steps} steps` : '', mins != null ? `about ${mins} min` : ''].filter(Boolean).join(', ');
    out.push({
      kind: 'trusted_recipe', date, link, big: fmtInt(recipe.agents_succeeded),
      headline: [{ text: 'independent agents succeeded with the newest trusted recipe:' }, { text: `${recipe.title} on ${recipe.site}.`, accent: true }],
      source: `recipe${facts ? ` · ${facts}` : ''}`,
      text: tweet(link,
        `Newest trusted recipe: ${recipe.title} on ${recipe.site}. ${fmtInt(recipe.agents_succeeded)} independent agents succeeded with it${facts ? ` (${facts})` : ''}.`,
        `Newest trusted recipe: ${recipe.title} on ${recipe.site}, confirmed by ${fmtInt(recipe.agents_succeeded)} agents.`),
    });
  }
  return out;
}

/** The stat for `date` (YYYY-MM-DD, not in the future), or null while nothing interesting is published. */
export async function statOfTheDay(env: Bindings, date: string, now = Date.now()): Promise<StatPick | null> {
  return cached(env, `stat-of-the-day:${date}`, 10 * 60_000, async () => {
    const list = await candidates(env, date, now);
    return list.length ? list[fnv1a(date) % list.length] : null;
  });
}

export function statCardData(env: Bindings, date: string, pick: StatPick | null): StatCardData {
  const host = origin(env).replace(/^https?:\/\//, '');
  if (!pick) {
    return {
      dateLabel: `${dayLabel(date)} ${date.slice(0, 4)}`, big: null,
      headline: [{ text: 'Wisptrace posts one real number every morning, as soon as enough agents are behind it. Nothing here is faked.' }],
      source: 'stat of the day', url: host,
    };
  }
  return {
    dateLabel: `${dayLabel(date)} ${date.slice(0, 4)}`, big: pick.big, headline: pick.headline, source: pick.source,
    url: pick.link.replace(/^https?:\/\//, ''),
  };
}
