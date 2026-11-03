import { describe, expect, it } from 'vitest';
import { absorbs, genericDone, nameFromDescription, nameFromTag, sensitiveKind, similarity } from '../src/lib/tasks';
import { buildTicks, normalizeOutcome, stepSig } from '../src/processing/ingest';
import { generateAgentName, isReservedName, normalizeAgentName, normalizeApp, normalizeModel, registrableDomain } from '../src/lib/normalize';

describe('task names', () => {
  // Different wordings of the same task must land on the same key; that is what makes recipes and trends add up.
  const same: [string, string | null, 'tag' | 'desc'][] = [
    ['Cancel Netflix subscription', 'netflix.com', 'tag'],
    ['Cancel my Netflix plan', 'netflix.com', 'tag'],
    ['cancelled netflix membership', null, 'tag'],
    ['Unsubscribe from Netflix', 'netflix.com', 'tag'],
    ['Please cancel my Netflix subscription before it renews on [DATE]', 'netflix.com', 'desc'],
  ];
  const name = (t: string, site: string | null, k: 'tag' | 'desc') => (k === 'tag' ? nameFromTag(t, site) : nameFromDescription(t, site));
  it('merges wordings of the same task', () => {
    for (const [t, site, k] of same) expect(name(t, site, k)?.key, t).toBe('cancel|netflix subscription');
  });
  it('labels and past tense', () => {
    const n = nameFromTag('Cancel my Netflix subscription', 'netflix.com')!;
    expect(n.label).toBe('Cancel Netflix subscription');
    expect(n.done).toBe('Cancelled Netflix subscription');
    expect(genericDone(n.verb)).toBe('Cancelled something');
  });
  it('adds the site brand when the name names no service', () => {
    expect(nameFromTag('Cancel membership', 'fitlane.com')!.label).toBe('Cancel membership on Fitlane');
    expect(nameFromTag('Book a table at Dishoom', 'opentable.com')!.key).toBe('book|dishoom table');
  });
  it('drops personal details: numbers, dates, mask labels, pronouns', () => {
    const n = nameFromDescription('Book a table for 4 at 7:30pm on Friday for [NAME] and my wife', 'tablehop.com')!;
    expect(n.label).toBe('Book a table on Tablehop');
    expect(nameFromTag('Buy a PS5 Slim for £449 delivered by 28/11', 'argos.co.uk')!.label).toBe('Buy a PS5 Slim');
    expect(nameFromTag('Email [NAME] at [EMAIL] about order 88412', null)?.label ?? '').not.toMatch(/NAME|EMAIL|88412/);
  });
  it('flags sensitive tasks by category, conservatively but not on everyday words', () => {
    expect(nameFromTag('Book a dentist appointment', null)!.sensitiveKind).toBe('health');
    expect(nameFromTag('Apply for a payday loan', null)!.sensitiveKind).toBe('money');
    expect(sensitiveKind(['fix', 'payments', 'test'])).toBeNull();
    expect(sensitiveKind(['football', 'match', 'ticket'])).toBeNull();
  });
  it('merges one way only, so a public name never carries one person’s extra word', () => {
    const a = nameFromTag('Cancel Fitlane membership', 'fitlane.com')!;
    const b = nameFromDescription('Cancel my gym membership at fitlane.com', 'fitlane.com')!;
    expect(absorbs(a, b)).toBe(true);   // the task "Cancel Fitlane membership" takes in the wordier one
    expect(absorbs(b, a)).toBe(false);  // never the other way round
    const mira = nameFromTag('Cancel Mira Netflix subscription', 'netflix.com')!;
    const plain = nameFromTag('Cancel Netflix subscription', 'netflix.com')!;
    expect(absorbs(mira, plain)).toBe(false);
    expect(similarity(a, nameFromTag('Book a table', 'fitlane.com')!)).toBe(0);
  });
});

describe('normalizeModel', () => {
  it.each([
    ['anthropic/claude-sonnet-4-5-20250929', 'claude-sonnet-4.5'],
    ['claude-3-5-sonnet-latest', 'claude-3.5-sonnet'],
    ['openai/gpt-5-2025-08-07', 'gpt-5'],
    ['models/gemini-2.5-pro', 'gemini-2.5-pro'],
    ['us.anthropic.claude-opus-4-1-20250805-v1:0', 'claude-opus-4.1'],
    ['claude-haiku-4-5@20251001', 'claude-haiku-4.5'],
    ['GPT-4o-mini-2024-07-18', 'gpt-4o-mini'],
    ['gpt-4-0613', 'gpt-4'],
    ['', 'unknown'],
  ])('%s -> %s', (input, want) => expect(normalizeModel(input)).toBe(want));
});

describe('registrableDomain', () => {
  it.each([
    ['https://www.shop.fitlane.co.uk/a?b', 'fitlane.co.uk'],
    ['www.opentable.com', 'opentable.com'],
    ['booking.com', 'booking.com'],
    ['https://my.account.example.com.au/x', 'example.com.au'],
    ['tickets.example.co.jp', 'example.co.jp'],
    ['HTTPS://Accounts.Google.COM:443/path', 'google.com'],
    ['co.uk', null],
    ['localhost', null],
    ['http://localhost:8787/x', null],
    ['192.168.1.10', null],
    ['http://[::1]/', null],
    ['not a domain', null],
  ])('%s -> %s', (input, want) => expect(registrableDomain(input)).toBe(want));
});

describe('names, apps, derivations', () => {
  it('normalizes apps', () => {
    expect(normalizeApp('openclaw')).toBe('OpenClaw');
    expect(normalizeApp('browser_use/0.7.1')).toBe('Browser Use');
    expect(normalizeApp('claude-code')).toBe('Claude Code');
    expect(normalizeApp('my cool agent')).toBe('My Cool Agent');
    expect(normalizeApp(undefined)).toBe('Unknown');
  });
  it('normalizes agent names', () => {
    expect(normalizeAgentName('Quiet Fox')).toBe('quiet-fox');
    expect(normalizeAgentName('ab')).toBeNull();
    expect(isReservedName('seed-scout')).toBe(true);
    expect(isReservedName('wisptrace-bot')).toBe(true);
    for (let i = 0; i < 50; i++) {
      const n = generateAgentName();
      expect(normalizeAgentName(n)).toBe(n);
      expect(isReservedName(n)).toBe(false);
    }
  });
  it('derives outcome, ticks, sigs', () => {
    expect(normalizeOutcome('success')).toBe('done');
    expect(normalizeOutcome('handed_back')).toBe('handed_back');
    expect(normalizeOutcome('weird')).toBe('failed');
    expect(buildTicks(['ok', 'retry', 'ok'], 'failed')).toBe('orf');
    expect(buildTicks(Array(70).fill('ok').concat(['fail']), 'failed')).toHaveLength(60);
    expect(stepSig('click', "Order #12345 'Cancel'", null, '')).toBe(stepSig('click', "Order #98 'Cancel'", null, ''));
    expect(stepSig('navigate', null, '/orders/88412/return', '')).toBe('navigate:/orders/:id/return');
  });
});
