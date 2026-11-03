import { describe, expect, it } from 'vitest';
import type { Bindings } from '../src/env';
import { classifyTask } from '../src/processing/classify';
import { buildTicks, normalizeOutcome, stepSig } from '../src/processing/ingest';
import { generateAgentName, isReservedName, normalizeAgentName, normalizeApp, normalizeModel, registrableDomain } from '../src/lib/normalize';

const env = { ENVIRONMENT: 'development' } as unknown as Bindings; // no ANTHROPIC_API_KEY: heuristic only

describe('classifyTask', () => {
  const cases: [string, string][] = [
    ['Cancel my gym membership at Fitlane', 'membership_cancellation'],
    ['Book a table for 4 at an Italian restaurant on Friday at 7pm', 'restaurant_booking'],
    ['Buy a birthday gift for my sister, under £40', 'gift_shopping'],
    ['Find the cheapest flight to Lisbon in December', 'flight_search'],
    ['Return the shoes from my last order and print the return label', 'return_item'],
    ['Order groceries for the week from Tesco', 'grocery_order'],
    ['Pay the parking fine (PCN) I got last week', 'parking_fine'],
    ['Cancel my Netflix subscription', 'subscription_cancellation'],
    ['Buy a USB-C cable', 'product_purchase'],
    ['Water the plants', 'other'],
  ];
  for (const [desc, want] of cases) {
    it(desc, async () => expect((await classifyTask(env, { description: desc })).task_type).toBe(want));
  }
  it('uses a valid type_hint', async () => {
    expect(await classifyTask(env, { description: 'whatever', type_hint: 'hotel_booking' })).toEqual({ task_type: 'hotel_booking', classifier: 'hint' });
    expect((await classifyTask(env, { description: 'Water the plants', type_hint: 'nope' })).classifier).toBe('heuristic');
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
