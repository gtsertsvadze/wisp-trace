// STUB — owned by UI-0 (design system), who replaces it with a designed 404/500 using the shared Layout.
import type { Context } from 'hono';
import type { AppEnv } from '../env';

export function notFoundPage(c: Context<AppEnv>) {
  return c.html('<!doctype html><title>Not found · wisptrace</title><h1>Not found</h1>', 404);
}

export function errorPage(c: Context<AppEnv>) {
  return c.html('<!doctype html><title>Error · wisptrace</title><h1>Something went wrong</h1>', 500);
}
