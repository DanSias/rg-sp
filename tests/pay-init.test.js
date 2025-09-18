/**
 * Tests the /pay/init endpoint.
 * - Ensures valid requests return a paymentSessionId and Hosted Page URL.
 * - Verifies required query params are present and correctly normalized.
 * - Confirms idempotency and conflict behavior.
 * - Covers both major-unit ("amount") and minor-unit ("amountMinor") inputs.
 */

import { URL } from 'node:url';

import request from 'supertest';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { app } from '../src/index.js';

const ORIGINAL_ENV = { ...process.env };

describe('/pay/init', () => {
  beforeEach(() => {
    // Minimal env for the route to work
    process.env.ROCKETGATE_MERCHANT_ID = '1483462469';
    process.env.ROCKETGATE_HASH_SECRET = 'test_hash_secret';
    process.env.ROCKETGATE_ENV = 'dev-secure'; // use default dev base/paths from utils
    delete process.env.ROCKETGATE_HOSTED_BASE_URL;
    delete process.env.ROCKETGATE_HOSTED_PATH;

    process.env.APP_BASE_URL = 'https://example.test';
    process.env.PORT = '3000';
  });

  afterEach(() => {
    // restore env so tests remain isolated
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, ORIGINAL_ENV);
  });

  it('returns a redirectUrl with required params (major units)', async () => {
    const res = await request(app)
      .post('/pay/init')
      .send({
        orderId: 'O-TEST-1',
        amount: '10.00',
        currency: 'usd',
        customer: { id: 'CUST_TEST_1' },
      });

    expect(res.status).toBe(200);
    expect(res.body.paymentSessionId).toMatch(/^ps_\d+/);
    expect(res.body.redirectUrl).toBeTruthy();

    const u = new URL(res.body.redirectUrl);

    // Base should be dev-secure default from utils when ROCKETGATE_ENV=dev-secure
    expect(u.origin + u.pathname).toBe(
      'https://dev-secure.rocketgate.com/hostedpage/servlet/HostedPagePurchase'
    );

    // Required signed params + extras
    expect(u.searchParams.get('id')).toBe('CUST_TEST_1');
    expect(u.searchParams.get('merch')).toBe('1483462469');
    expect(u.searchParams.get('amount')).toBe('10.00'); // normalized to 2 decimals
    expect(u.searchParams.get('purchase')).toBe('true');
    expect(u.searchParams.get('time')).toBeTruthy();
    expect(u.searchParams.get('invoice')).toBe('O-TEST-1');
    expect(u.searchParams.get('currency')).toBe('USD');

    // success/fail URLs and results
    const success = u.searchParams.get('success');
    const fail = u.searchParams.get('fail');
    expect(success).toContain('/callbacks/complete-payment');
    expect(success).toContain('orderId=O-TEST-1');
    expect(success).toContain('result=success');
    expect(fail).toContain('result=fail');

    // HMAC present
    expect(u.searchParams.get('hash')).toBeTruthy();

    // ExpiresAt present & ISO string
    expect(typeof res.body.expiresAt).toBe('string');
    expect(() => new Date(res.body.expiresAt)).not.toThrow();
  });

  it('accepts amountMinor (cents) and converts to major-unit string', async () => {
    const res = await request(app)
      .post('/pay/init')
      .send({
        orderId: 'O-TEST-2',
        amountMinor: 1299, // $12.99
        currency: 'USD',
        customer: { id: 'CUST_TEST_2' },
      });

    expect(res.status).toBe(200);
    const u = new URL(res.body.redirectUrl);
    expect(u.searchParams.get('amount')).toBe('12.99'); // derived from cents -> two decimals
  });

  it('is idempotent for same params and 409 for conflicts', async () => {
    // First init
    const first = await request(app)
      .post('/pay/init')
      .send({
        orderId: 'O-TEST-3',
        amount: '15.50',
        currency: 'USD',
        customer: { id: 'CUST_X' },
      });
    expect(first.status).toBe(200);

    // Same inputs → 200 and a redirectUrl again
    const same = await request(app)
      .post('/pay/init')
      .send({
        orderId: 'O-TEST-3',
        amount: '15.50', // same
        currency: 'USD', // same
        customer: { id: 'CUST_X' }, // same
      });
    expect(same.status).toBe(200);
    expect(same.body.redirectUrl).toBeTruthy();

    // Conflicting amount → 409
    const conflictAmount = await request(app)
      .post('/pay/init')
      .send({
        orderId: 'O-TEST-3',
        amount: '15.75', // different
        currency: 'USD',
        customer: { id: 'CUST_X' },
      });
    expect(conflictAmount.status).toBe(409);
    expect(conflictAmount.body?.error?.code).toBe('IDEMPOTENCY_CONFLICT');

    // Conflicting customer → 409
    const conflictCustomer = await request(app)
      .post('/pay/init')
      .send({
        orderId: 'O-TEST-3',
        amount: '15.50',
        currency: 'USD',
        customer: { id: 'CUST_Y' }, // different
      });
    expect(conflictCustomer.status).toBe(409);
  });
});
