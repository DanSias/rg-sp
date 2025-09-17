/**
 * Ensures buildHostedPageUrl picks the correct RocketGate base depending on ROCKETGATE_ENV.
 * Also freezes time so the generated hash is deterministic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { buildHostedPageUrl } from '../src/utils/rocketgate.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // Reset env and freeze time to a known epoch (e.g., 2025-01-01T00:00:00Z)
  process.env = { ...ORIGINAL_ENV };
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z')); // time -> 1735689600
});

afterEach(() => {
  vi.useRealTimers();
  process.env = { ...ORIGINAL_ENV };
});

function baseOf(url) {
  const [base] = url.split('?');
  return base;
}

describe('buildHostedPageUrl: environment base selection', () => {
  const commonArgs = {
    id: 'CUST_TEST',
    merch: '1483462469',
    amount: '10.00',
    hashSecret: 'test_hash_secret',
    extra: { invoice: 'O-ENV', currency: 'USD' },
  };

  it('uses dev-secure base when ROCKETGATE_ENV is unset or dev-secure', () => {
    delete process.env.ROCKETGATE_ENV; // unset
    const url1 = buildHostedPageUrl(commonArgs);
    expect(baseOf(url1)).toBe(
      'https://dev-secure.rocketgate.com/hostedpage/servlet/HostedPagePurchase'
    );

    process.env.ROCKETGATE_ENV = 'dev-secure';
    const url2 = buildHostedPageUrl(commonArgs);
    expect(baseOf(url2)).toBe(
      'https://dev-secure.rocketgate.com/hostedpage/servlet/HostedPagePurchase'
    );

    // Sanity: query has success params from extra passthrough (invoice, currency here)
    const q = new URL(url2).searchParams;
    expect(q.get('invoice')).toBe('O-ENV');
    expect(q.get('currency')).toBe('USD');
    expect(q.get('id')).toBe('CUST_TEST');
    expect(q.get('amount')).toBe('10.00');
    expect(q.get('merch')).toBe('1483462469');
    expect(q.get('hash')).toBeTruthy(); // hash is present
  });

  it('uses prod-secure base when ROCKETGATE_ENV=prod-secure', () => {
    process.env.ROCKETGATE_ENV = 'prod-secure';
    const url = buildHostedPageUrl(commonArgs);
    expect(baseOf(url)).toBe('https://secure.rocketgate.com/hostedpage/servlet/HostedPagePurchase');

    // Make sure the rest of the URL is still well-formed
    const q = new URL(url).searchParams;
    expect(q.get('id')).toBe('CUST_TEST');
    expect(q.get('merch')).toBe('1483462469');
    expect(q.get('amount')).toBe('10.00');
    expect(q.get('purchase')).toBe('true');
    expect(q.get('time')).toBe(
      String(Math.floor(new Date('2025-01-01T00:00:00Z').getTime() / 1000))
    );
    expect(q.get('hash')).toBeTruthy();
  });
});
