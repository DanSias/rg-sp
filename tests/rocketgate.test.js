/**
 * Unit tests for RocketGate utility functions (rocketgate.js).
 * - Validates HostedPage URL builder, hash generation, and querystring encoding.
 */

import crypto from 'crypto';
import { URL } from 'node:url';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { buildHostedPageUrl } from '../src/utils/rocketgate.js';

describe('buildHostedPageUrl', () => {
  // freeze time so time + hash are deterministic
  const fixedTime = 1_757_514_470; // seconds
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixedTime * 1000));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a deterministic URL with correctly encoded hash', () => {
    const url = buildHostedPageUrl({
      id: 'CUST001',
      merch: '1483462469',
      amount: '14.34',
      hashSecret: 'test_hash_secret',
      extra: { invoice: 'O-123', currency: 'USD' },
    });

    const u = new URL(url);

    expect(u.searchParams.get('id')).toBe('CUST001');
    expect(u.searchParams.get('merch')).toBe('1483462469');
    expect(u.searchParams.get('amount')).toBe('14.34');
    expect(u.searchParams.get('purchase')).toBe('true');
    expect(u.searchParams.get('time')).toBe(String(fixedTime));
    expect(u.searchParams.get('invoice')).toBe('O-123');
    expect(u.searchParams.get('currency')).toBe('USD');

    const stringToHash = `id=CUST001&merch=1483462469&amount=14.34&purchase=true&time=${fixedTime}`;
    const expectedB64 = crypto
      .createHmac('sha256', 'test_hash_secret')
      .update(stringToHash, 'utf8')
      .digest('base64');

    expect(decodeURIComponent(u.searchParams.get('hash'))).toBe(expectedB64);
  });
});
