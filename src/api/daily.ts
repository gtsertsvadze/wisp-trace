// GET /api/public/stat-of-the-day[?date=YYYY-MM-DD] -> { ok, date, kind, text, card_url, link }
// For the daily posting pipeline. The pick is deterministic per date; 404 no_stat_yet while nothing is published.
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { dayOf } from '../lib/time';
import { origin } from '../cards/data';
import { isDate, statOfTheDay } from '../cards/stat';

const app = new Hono<AppEnv>();

app.get('/', async c => {
  const today = dayOf(Date.now());
  const date = c.req.query('date') ?? today;
  if (!isDate(date)) return c.json({ ok: false, error: 'invalid_date', message: 'date must be YYYY-MM-DD' }, 400);
  if (date > today) return c.json({ ok: false, error: 'future_date' }, 400);
  const pick = await statOfTheDay(c.env, date);
  c.header('Cache-Control', 'public, max-age=600');
  if (!pick) return c.json({ ok: false, error: 'no_stat_yet', date, message: 'Not enough published data for a stat yet.' }, 404);
  return c.json({
    ok: true,
    date,
    kind: pick.kind,
    text: pick.text,
    card_url: `${origin(c.env)}/card/stat.png?date=${date}`,
    link: pick.link,
  });
});

export default app;
