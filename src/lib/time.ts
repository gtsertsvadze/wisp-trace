// UTC day / ISO-week helpers. Weeks run Monday 00:00 UTC to the next Monday (exclusive).

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const dayStart = (day: string): number => Date.parse(`${day}T00:00:00Z`);

export function isoWeek(ms: number): string {
  const d = new Date(ms);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const weekNo = Math.ceil(((date.getTime() - yearStart) / DAY + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/** Monday 00:00 UTC of an ISO week like '2026-W44'. */
export function weekStart(week: string): number {
  const [y, w] = week.split('-W').map(Number);
  const jan4 = Date.UTC(y, 0, 4);
  const jan4Day = new Date(jan4).getUTCDay() || 7;
  return jan4 - (jan4Day - 1) * DAY + (w - 1) * WEEK;
}

export const weekEnd = (week: string): number => weekStart(week) + WEEK; // exclusive
export const shiftWeek = (week: string, n: number): string => isoWeek(weekStart(week) + n * WEEK + DAY);
export const weekNumber = (week: string): number => Number(week.split('-W')[1]);

/** '26 Oct – 1 Nov' */
export function weekLabel(week: string): string {
  const a = new Date(weekStart(week));
  const b = new Date(weekEnd(week) - DAY);
  return `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]} – ${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]}`;
}

/** '26 Oct' */
export function dayLabel(msOrDay: number | string): string {
  const d = new Date(typeof msOrDay === 'string' ? dayStart(msOrDay) : msOrDay);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** The last fully completed ISO week before `now`. */
export const lastCompleteWeek = (now: number): string => shiftWeek(isoWeek(now), -1);

/** Coarse relative time for aggregates only ('12 min ago', '2 h ago', '3 d ago'). Never for individual traces. */
export function ago(ms: number | null | undefined, now: number): string {
  if (!ms) return '—';
  const d = Math.max(0, now - ms);
  if (d < HOUR) return `${Math.max(1, Math.round(d / MIN))} min ago`;
  if (d < DAY) return `${Math.round(d / HOUR)} h ago`;
  return `${Math.round(d / DAY)} d ago`;
}

export const BLACK_FRIDAY = Date.UTC(2026, 10, 27); // 27 Nov 2026
export const daysUntil = (target: number, now: number) => Math.max(0, Math.ceil((target - now) / DAY));
