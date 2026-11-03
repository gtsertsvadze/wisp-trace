// Shared hono/jsx components. Owned by UI-0. Styles: public/css/base.css. Live gallery: /_kit (dev only).
//
// Every component accepts `class?` (extra classes) and most accept `style?` (inline CSS string) for one-off spacing. All are server-rendered; nothing needs JS
// except CommandBox/CopyButton, which use public/js/common.js (always loaded by Layout).
//
// StepPath({ ticks, size?, max?, label? })
//   ticks: string of 'o' (worked, mint) | 'r' (retried, slate) | 'f' (failed, coral), one per step (PublicFeedItem.ticks).
//   size: 8 (default; feed, recipes) or 7 (home hero, profile). max: cap squares (default 40); overflow keeps
//   the last square and appends "+N".
// PathLegend({ class? })               "■ worked ■ failed ■ retried" (mono 12px). Prefix text via children.
// Kicker({ children, line?, tone?, small?, as? })
//   mono uppercase label. tone 'mint' (default) | 'mute' | 'coral'. small: 11px card kicker.
//   line: text after a 40px mint rule (home: <Kicker line="live">traces received</Kicker>).
// Tag({ tone?, ink?, children })        mono pill. tone 'mint' (default, tinted) | 'outline' | 'coral' | 'line'
//   ('line' = small outlined status tag in the colour of ink: 'mint' | 'dim' | 'mute' | 'coral').
// SeedTag()                             the mint "seed" chip next to seed agent names. Always render it for is_seed.
// Chip({ href, active?, children })      single filter chip (a link).
// ChipGroup({ items: {label, href, active}[], label?, children? })
//   single-select filter links (no JS; use query params). children render right-aligned (legend, caption).
// Button({ href?, variant?, size?, ...attrs, children })
//   variant 'primary' (default) | 'secondary' | 'ghost'; size 'md' (page, default) | 'lg' (hero) | 'sm'.
//   With href renders <a>, otherwise <button type="button">. Extra attrs (id, data-*, aria-*, type, disabled…) pass through.
// Card({ small?, href?, tone?, children })   panel (20px radius). small: stat-card shape (16px radius, 20px pad).
//   href: whole card is a link with mint hover border. tone 'mint' (mint border) | 'coral' (dead-end fill).
// HighlightCard({ children })            mint gradient card (awards, Black Friday watch).
// StatCard({ value, unit?, label, accent? })  mono number (+ small mute unit) over a 13px label; accent = mint number.
//   Put several in <div class="stat-row" style="--cols:5">.
// SuccessBar({ pct, lead?, mint?, showPct? })  4px track + fill (lead: mint + glow; mint: plain mint; else slate)
//   and the mono % on the right (showPct default true). pct is 0-100.
// Breadcrumb({ items: {label, href?}[] }) "Leaderboards / agents / quietfox-7".
// CommandBox({ text, display? })         "› text [copy]" box; copies `text` (display overrides the shown text).
// CopyButton({ text, label?, variant? }) any button that copies text; label flips to "copied" for 1.5 s.
//   variant 'chip' (default, mint copy chip) | 'secondary' | 'primary' (full buttons).
// SkeletonRows({ n, height? })           n loading rows shaped like feed rows (default 58px).
// EmptyState({ title, children })        dashed plain-language empty state. Never show a blank page.
// Outcome({ outcome })                   mono 12px: done (mint) / handed back (dim) / failed (coral).
// PageTitle({ kicker, title, lead?, aside?, xl? })  standard title block: kicker, h1, lead paragraph;
//   aside renders right-aligned at the bottom (stacks under 760px). xl: profile/recipe-size h1.
//
// CSS classes worth knowing (base.css): .container .grid-2 .grid-main .stack .stack-lg .spread .row .push
// .rule-top .stat-row .row-card(.is-new) .row-link .panel-head .card-deep .th .h1 .h1-xl .h2 .h3 .h-card
// .h-big .stat-num .stat-label .lead .body-sm .meta .mono .dim .mute .mint .coral .slate .ellipsis .nowrap
// .link-cta .input .textarea .anim-rise .anim-in .sr-only. Formatting helpers: src/lib/format.ts.
import type { Child } from 'hono/jsx';
import type { Outcome as OutcomeKind } from '../types';
import { fmtPct, outcomeLabel } from '../lib/format';

const cx = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(' ');

type WithClass = { class?: string; style?: string };
type WithChildren = { children?: Child };

// ---------------------------------------------------------------- step path

const TICK_CLASS: Record<string, string> = { o: 't-ok', r: 't-retry', f: 't-fail' };

export function StepPath({ ticks, size = 8, max = 40, label, class: cls }: { ticks: string; size?: 7 | 8; max?: number; label?: string } & WithClass) {
  const all = [...(ticks ?? '')].filter(t => t in TICK_CLASS);
  const shown = all.length > max ? [...all.slice(0, Math.max(1, max - 1)), all[all.length - 1]!] : all;
  const more = all.length - shown.length;
  const fails = all.filter(t => t === 'f').length;
  const retries = all.filter(t => t === 'r').length;
  const aria = label ?? `${all.length} steps${retries ? `, ${retries} retried` : ''}${fails ? `, ${fails} failed` : ''}`;
  return (
    <div class={cx('path', size === 7 && 'path-7', cls)} role="img" aria-label={aria}>
      {shown.map(t => <span class={TICK_CLASS[t]}></span>)}
      {more > 0 ? <span class="path-more">+{more}</span> : null}
    </div>
  );
}

export function PathLegend({ class: cls, children }: WithClass & WithChildren) {
  return (
    <div class={cx('legend', cls)}>
      {children}
      <span class="sw-ok" aria-hidden="true">■</span> worked <span class="sw-fail" aria-hidden="true">■</span> failed{' '}
      <span class="sw-retry" aria-hidden="true">■</span> retried
    </div>
  );
}

// ---------------------------------------------------------------- labels

export function Kicker({ children, line, tone = 'mint', small, as = 'div', class: cls, style }: {
  line?: Child; tone?: 'mint' | 'mute' | 'coral'; small?: boolean; as?: 'div' | 'span' | 'p';
} & WithClass & WithChildren) {
  const className = cx('kicker', small && 'kicker-sm', tone !== 'mint' && `is-${tone}`, line != null && 'has-line', cls);
  const inner = line != null ? <>{children}<span class="kicker-line" aria-hidden="true"></span>{line}</> : children;
  if (as === 'span') return <span class={className} style={style}>{inner}</span>;
  if (as === 'p') return <p class={className} style={style}>{inner}</p>;
  return <div class={className} style={style}>{inner}</div>;
}

export function Tag({ tone = 'mint', ink, children, class: cls, style }: {
  tone?: 'mint' | 'outline' | 'coral' | 'line'; ink?: 'mint' | 'dim' | 'mute' | 'coral';
} & WithClass & WithChildren) {
  return <span class={cx('tag', `tag-${tone}`, tone === 'line' && (ink ?? 'mute'), cls)} style={style}>{children}</span>;
}

export function SeedTag({ class: cls }: WithClass) {
  return <span class={cx('seed-tag', cls)} title="Run by Wisptrace">seed</span>;
}

export function Chip({ href, active, children, class: cls }: { href: string; active?: boolean } & WithClass & WithChildren) {
  return (
    <a href={href} class={cx('chip', active && 'is-active', cls)} aria-current={active ? 'true' : undefined}>
      {children}
    </a>
  );
}

export function ChipGroup({ items, label, children, class: cls }: {
  items: { label: Child; href: string; active?: boolean }[]; label?: string;
} & WithClass & WithChildren) {
  return (
    <nav class={cx('chip-group', cls)} aria-label={label ?? 'Filter'}>
      {items.map(i => <Chip href={i.href} active={i.active}>{i.label}</Chip>)}
      {children != null ? <div class="chip-group-aside">{children}</div> : null}
    </nav>
  );
}

// ---------------------------------------------------------------- buttons

type ButtonProps = {
  href?: string;
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'md' | 'lg' | 'sm';
  block?: boolean;
  class?: string;
  children?: Child;
  [attr: string]: unknown;
};

export function Button({ href, variant = 'primary', size = 'md', block, class: cls, children, ...attrs }: ButtonProps) {
  const className = cx('btn', `btn-${variant}`, size !== 'md' && `btn-${size}`, block && 'btn-block', cls);
  const rest = attrs as Record<string, string | number | boolean | undefined>;
  if (href != null) return <a href={href} class={className} {...rest}>{children}</a>;
  return <button type="button" class={className} {...rest}>{children}</button>;
}

export function CopyButton({ text, label = 'copy', variant = 'chip', class: cls }: {
  text: string; label?: string; variant?: 'chip' | 'secondary' | 'primary';
} & WithClass) {
  const className = variant === 'chip' ? cx('copy-chip', cls) : cx('btn', `btn-${variant}`, cls);
  return <button type="button" class={className} data-copy={text}>{label}</button>;
}

// ---------------------------------------------------------------- cards

export function Card({ small, href, tone, children, class: cls, style }: {
  small?: boolean; href?: string; tone?: 'mint' | 'coral';
} & WithClass & WithChildren) {
  const className = cx('card', small && 'card-sm', tone && `card-${tone}`, cls);
  if (href != null) return <a href={href} class={className} style={style}>{children}</a>;
  return <div class={className} style={style}>{children}</div>;
}

export function HighlightCard({ children, class: cls, style }: WithClass & WithChildren) {
  return <div class={cx('card-highlight', cls)} style={style}>{children}</div>;
}

export function StatCard({ value, unit, label, accent, class: cls, style }: {
  value: Child; unit?: Child; label: Child; accent?: boolean;
} & WithClass) {
  return (
    <div class={cx('card', 'card-sm', cls)} style={style}>
      <div class={cx('stat-num', accent && 'mint')}>
        {value}
        {unit != null ? <span class="unit"> {unit}</span> : null}
      </div>
      <div class="stat-label">{label}</div>
    </div>
  );
}

export function SuccessBar({ pct, lead, mint, showPct = true, class: cls }: {
  pct: number; lead?: boolean; mint?: boolean; showPct?: boolean;
} & WithClass) {
  const w = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  return (
    <div class={cx('sbar', cls)}>
      <div class="bar" role="presentation">
        <div class={cx('bar-fill', lead && 'is-lead', !lead && mint && 'is-mint')} style={`width:${w.toFixed(1)}%`}></div>
      </div>
      {showPct ? <span class="sbar-pct">{fmtPct(w)}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------- navigation + boxes

export function Breadcrumb({ items, class: cls }: { items: { label: Child; href?: string }[] } & WithClass) {
  return (
    <nav class={cx('breadcrumb', cls)} aria-label="Breadcrumb">
      {items.map((it, i) => (
        <>
          {i > 0 ? <span class="sep" aria-hidden="true">/</span> : null}
          {it.href ? <a href={it.href}>{it.label}</a> : <span aria-current={i === items.length - 1 ? 'page' : undefined}>{it.label}</span>}
        </>
      ))}
    </nav>
  );
}

export function CommandBox({ text, display, class: cls }: { text: string; display?: Child } & WithClass) {
  return (
    <div class={cx('cmdbox', cls)}>
      <span class="cmdbox-prompt" aria-hidden="true">›</span>
      <span class="cmdbox-text">{display ?? text}</span>
      <button type="button" class="cmdbox-copy" data-copy={text} aria-label="Copy to clipboard">copy</button>
    </div>
  );
}

// ---------------------------------------------------------------- states

export function SkeletonRows({ n, height = 58, class: cls }: { n: number; height?: number } & WithClass) {
  return (
    <div class={cls} aria-busy="true" aria-label="Loading">
      {Array.from({ length: Math.max(0, n) }, () => <div class="skeleton skeleton-row" style={`height:${height}px`}></div>)}
    </div>
  );
}

export function EmptyState({ title, children, class: cls, style }: { title: Child } & WithClass & WithChildren) {
  return (
    <div class={cx('empty', cls)} style={style}>
      <div class="empty-title">{title}</div>
      {children != null ? <div>{children}</div> : null}
    </div>
  );
}

export function Outcome({ outcome, class: cls }: { outcome: OutcomeKind } & WithClass) {
  return <span class={cx('outcome', `is-${outcome}`, cls)}>{outcomeLabel(outcome)}</span>;
}

export function PageTitle({ kicker, title, lead, aside, xl, class: cls, style }: {
  kicker?: Child; title: Child; lead?: Child; aside?: Child; xl?: boolean;
} & WithClass) {
  const body = (
    <div>
      {kicker != null ? <Kicker>{kicker}</Kicker> : null}
      <h1 class={xl ? 'h1-xl' : 'h1'}>{title}</h1>
      {lead != null ? <p class="lead">{lead}</p> : null}
    </div>
  );
  return (
    <div class={cx('page-title', aside != null && 'has-aside', cls)} style={style}>
      {body}
      {aside != null ? <div class="page-title-aside">{aside}</div> : null}
    </div>
  );
}
