// Display formatting shared by every page. All output is en-US, matching the design copy.
import type { Outcome } from '../types';

const num = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

/** 1284910 -> '1,284,910' */
export const fmtInt = (n: number): string => Math.round(num(n)).toLocaleString('en-US');

/** 91.4 -> '91%'. Pass a 0-100 value; use fmtPct(rate * 100) for fractions. */
export const fmtPct = (n: number): string => `${Math.round(num(n))}%`;

/** 6 -> '6 min' */
export const fmtMins = (n: number): string => `${fmtInt(n)} min`;

/** Minutes -> '30h 40m' (under an hour: '40m'). */
export function fmtHM(mins: number): string {
  const m = Math.max(0, Math.round(num(mins)));
  const h = Math.floor(m / 60);
  return h ? `${fmtInt(h)}h ${m % 60}m` : `${m}m`;
}

/** 42.1 -> '$42.10' */
export const fmtUsd = (n: number): string =>
  `$${num(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** 6.2 -> '6.2×' (one decimal; drops nothing so 2 -> '2.0×'). */
export const fmtMult = (n: number): string => `${num(n).toFixed(1)}×`;

export type OutcomeLabel = 'done' | 'handed back' | 'failed';
export const outcomeLabel = (o: Outcome): OutcomeLabel => (o === 'done' ? 'done' : o === 'handed_back' ? 'handed back' : 'failed');

/** Seconds -> whole minutes, rounded up, minimum 1 (the public minutes rule). */
export const minsFromSeconds = (s: number): number => Math.max(1, Math.ceil(num(s) / 60));

/** 1 -> '01' */
export const pad2 = (n: number): string => String(Math.trunc(num(n))).padStart(2, '0');
