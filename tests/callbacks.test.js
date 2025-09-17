/**
 * Tests /callbacks endpoints:
 * - Buyer return (/callbacks/complete-payment) sets returned_* and stores transactId when present.
 * - Async notify (/callbacks/notify) upgrades to paid and supports optional HMAC verification.
 */

import crypto from 'crypto';

import request from 'supertest';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { app } from '../src/index.js';

const ORIGINAL_ENV = { ...process.env };

describe('callbacks', () => {
  beforeEach(() => {
    // default: signature verification OFF
    process.env.VERIFY_ROCKETGATE_NOTIFY_SIGNATURE = 'false';
    delete process.env.ROCKETGATE_NOTIFY_SIGNATURE_HEADER;
    delete process.env.ROCKETGATE_NOTIFY_SIGNATURE_SECRET;
    delete process.env.ROCKETGATE_NOTIFY_SIGNATURE_ENCODING;

    // Ensure pay/init can run to seed rows when needed
    process.env.ROCKETGATE_MERCHANT_ID = '1483462469';
    process.env.ROCKETGATE_HASH_SECRET = 'test_hash_secret';
    process.env.ROCKETGATE_ENV = 'dev-secure';
    process.env.PUBLIC_BASE_URL = 'https://example.test';
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, ORIGINAL_ENV);
  });

  it('complete-payment (GET) marks returned_success and stores transactId', async () => {
    // Seed the order via /pay/init
    const orderId = 'O-CB-1';
    const init = await request(app)
      .post('/pay/init')
      .send({
        orderId,
        amount: '9.99',
        currency: 'USD',
        customer: { id: 'CUST_CB1' },
      });
    expect(init.status).toBe(200);

    // Simulate buyer return from Hosted Page
    const ret = await request(app)
      .get('/callbacks/complete-payment')
      .query({ orderId, result: 'success', transactId: 'RG-TXN-abc123' });

    expect(ret.status).toBe(200);
    expect(ret.body?.ok).toBe(true);
    // We expect state to reflect returned_success and to have rocketgate txn stored
    expect(ret.body?.state?.status ?? ret.body?.state).toBeDefined();
    // Try both shapes: some helpers may return just the status; others return a record
    if (typeof ret.body.state === 'string') {
      expect(ret.body.state).toBe('returned_success');
    } else {
      expect(ret.body.state.status).toBe('returned_success');
      expect(ret.body.state.rocketgate_txn || ret.body.state.rocketgateTxnId).toBe('RG-TXN-abc123');
    }
  });

  it('notify (no signature) upgrades to paid', async () => {
    const orderId = 'O-CB-2';

    // Seed to returned_success so we can test forward-only upgrade to paid
    await request(app)
      .post('/pay/init')
      .send({
        orderId,
        amount: '12.34',
        currency: 'USD',
        customer: { id: 'CUST_CB2' },
      });
    await request(app)
      .get('/callbacks/complete-payment')
      .query({ orderId, result: 'success', transactId: 'RG-TXN-seed' });

    // Async notify from RocketGate (no signature enforcement)
    const body = {
      invoice: orderId,
      status: 'approved', // mapped to "paid"
      transactId: 'RG-TXN-paid-1',
    };

    const res = await request(app).post('/callbacks/notify').send(body);
    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    if (typeof res.body.state === 'string') {
      expect(res.body.state).toBe('paid');
    } else {
      expect(res.body.state.status).toBe('paid');
      expect(res.body.state.rocketgate_txn || res.body.state.rocketgateTxnId).toBe('RG-TXN-paid-1');
    }
  });

  it('notify enforces RocketGate HMAC when enabled (valid/invalid cases)', async () => {
    const orderId = 'O-CB-3';

    // Seed row (notify is authoritative but we ensure the row exists)
    await request(app)
      .post('/pay/init')
      .send({
        orderId,
        amount: '5.00',
        currency: 'USD',
        customer: { id: 'CUST_CB3' },
      });

    // Enable signature verification for RocketGate notify
    process.env.VERIFY_ROCKETGATE_NOTIFY_SIGNATURE = 'true';
    process.env.ROCKETGATE_NOTIFY_SIGNATURE_HEADER = 'X-RG-Signature';
    process.env.ROCKETGATE_NOTIFY_SIGNATURE_SECRET = 'rg_notify_secret';
    process.env.ROCKETGATE_NOTIFY_SIGNATURE_ENCODING = 'hex';

    const plainBody = JSON.stringify({
      invoice: orderId,
      status: 'approved',
      transactId: 'RG-TXN-secure-1',
    });

    // Valid signature → 200
    const validSig = crypto
      .createHmac('sha256', process.env.ROCKETGATE_NOTIFY_SIGNATURE_SECRET)
      .update(Buffer.from(plainBody))
      .digest(process.env.ROCKETGATE_NOTIFY_SIGNATURE_ENCODING);

    const ok = await request(app)
      .post('/callbacks/notify')
      .set('Content-Type', 'application/json')
      .set('X-RG-Signature', validSig)
      .send(plainBody);
    expect(ok.status).toBe(200);

    // Missing/invalid signature → 400
    const bad = await request(app)
      .post('/callbacks/notify')
      .set('Content-Type', 'application/json')
      .send(plainBody);
    expect(bad.status).toBe(400);
  });
});
