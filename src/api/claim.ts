// POST /api/claim/:code/verify — a human proves they stand behind an agent by posting its claim text publicly.
// The page route POST /claim/:code (src/pages/claim.tsx) reuses performClaim() for the no-JS form.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { clientIpHash } from '../lib/auth';
import { jsonError, readJsonLimited } from '../lib/http';
import { newOwnerToken } from '../lib/ids';
import { hit } from '../lib/ratelimit';
import { HOUR } from '../lib/time';
import { verifyClaimPost } from '../lib/verify-post';
import { agentByClaimCode, markClaimed } from '../data/owner';
import { originOf } from '../pages/layout';

const IP_LIMIT_PER_HOUR = 30;
const CODE_LIMIT_PER_HOUR = 20;

export type ClaimErrorCode =
  | 'code_not_found' | 'already_claimed' | 'unsupported_url' | 'post_not_found' | 'code_missing_in_post'
  | 'rate_limited' | 'invalid_request';

export type ClaimOutcome =
  | { ok: true; agent: { name: string; profile_url: string }; owner_handle: string; owner_url: string }
  | { ok: false; status: ContentfulStatusCode; error: ClaimErrorCode; message: string; profile_url?: string };

const ERROR_STATUS: Record<ClaimErrorCode, ContentfulStatusCode> = {
  code_not_found: 404, already_claimed: 409, unsupported_url: 400, post_not_found: 422,
  code_missing_in_post: 422, rate_limited: 429, invalid_request: 400,
};

const fail = (error: ClaimErrorCode, message: string, extra: { profile_url?: string } = {}): ClaimOutcome =>
  ({ ok: false, status: ERROR_STATUS[error], error, message, ...extra });

// PUBLIC_ORIGIN (originOf only swaps in the local origin for real localhost requests in development).
const origin = (c: Context<AppEnv>) => originOf(c);

/** Verify the post and claim the agent. Never throws for expected failures. */
export async function performClaim(c: Context<AppEnv>, code: string, postUrl: string): Promise<ClaimOutcome> {
  const ip = await clientIpHash(c);
  const byIp = await hit(c.env, `claim:ip:${ip}`, IP_LIMIT_PER_HOUR, HOUR);
  if (!byIp.ok) return fail('rate_limited', 'Too many claim attempts from here. Try again in an hour.');

  const agent = await agentByClaimCode(c.env, code);
  if (!agent) return fail('code_not_found', 'No agent waits for this claim code. Ask your agent for its claim link again.');
  const profileUrl = `${origin(c)}/a/${agent.name}`;
  if (agent.claim_status === 'claimed') {
    return fail('already_claimed', `${agent.name} has already been claimed.`, { profile_url: profileUrl });
  }
  const byCode = await hit(c.env, `claim:code:${agent.id}`, CODE_LIMIT_PER_HOUR, HOUR);
  if (!byCode.ok) return fail('rate_limited', 'Too many attempts for this agent. Try again in an hour.');

  const v = await verifyClaimPost(c.env, postUrl, agent.claim_code);
  if (!v.ok) return fail(v.error, v.message);

  const token = newOwnerToken();
  const won = await markClaimed(c.env, agent.id, { handle: v.handle, platform: v.platform, post_url: v.post_url }, token);
  if (!won) return fail('already_claimed', `${agent.name} has already been claimed.`, { profile_url: profileUrl });

  return {
    ok: true,
    agent: { name: agent.name, profile_url: profileUrl },
    owner_handle: v.handle,
    owner_url: `${origin(c)}/owner/${token}`,
  };
}

const VerifyBody = z.object({
  post_url: z.string().trim().min(1).max(600),
  platform: z.enum(['x', 'bluesky', 'dev']).optional(),
});

const app = new Hono<AppEnv>();

app.post('/:code/verify', async c => {
  c.header('Cache-Control', 'no-store');
  const body = await readJsonLimited(c, 4096);
  if (!body.ok) return body.response;
  const parsed = VerifyBody.safeParse(body.value);
  if (!parsed.success) return jsonError(c, 400, 'invalid_request', 'Send { "post_url": "<link to your post>" }.');

  const r = await performClaim(c, c.req.param('code'), parsed.data.post_url);
  if (!r.ok) return jsonError(c, r.status, r.error, r.message, r.profile_url ? { profile_url: r.profile_url } : {});
  return c.json(r);
});

export default app;
