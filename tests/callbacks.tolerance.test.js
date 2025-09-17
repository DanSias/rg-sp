/**
 * Tests webhook replay protection.
 * - Ensures callbacks with stale timestamps are rejected (401),
 *   even if the HMAC signature is valid.
 */

import crypto from 'crypto';

import request from 'supertest';
import { describe, it, expect } from 'vitest';

import { app } from '../src/index.js';

describe('callbacks timestamp tolerance', () => {
  const route = '/callbacks/notify';
  const body = JSON.stringify({
    shoplazzaOrderId: 'O-TS',
    status: 'paid',
    amount: 1,
    currency: 'USD',
  });

  it('401 when timestamp is too old', async () => {
    // Turn ON verification
    app.locals.verifySignatures = true;
    process.env.SHOPLAZZA_WEBHOOK_SECRET = 'dev_webhook_secret';
    process.env.SHOPLAZZA_SIGNATURE_HEADER = 'X-Shoplazza-Signature';
    process.env.SHOPLAZZA_TIMESTAMP_HEADER = 'X-Shoplazza-Timestamp';
    process.env.SHOPLAZZA_SIGNATURE_ENCODING = 'base64';
    process.env.SHOPLAZZA_TS_TOLERANCE_SECONDS = '60';

    // Sign correctly, but with an old timestamp
    const ts = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    const sig = crypto
      .createHmac('sha256', process.env.SHOPLAZZA_WEBHOOK_SECRET)
      .update(Buffer.from(body))
      .digest('base64');

    const res = await request(app)
      .post(route)
      .set('Content-Type', 'application/json')
      .set('X-Shoplazza-Signature', sig)
      .set('X-Shoplazza-Timestamp', String(ts))
      .send(body);

    expect(res.status).toBe(401);

    // reset flag for other tests
    app.locals.verifySignatures = false;
  });
});
