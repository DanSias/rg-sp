/**
 * Negative tests for /pay/init.
 * - Ensures invalid payloads (e.g., missing customer.id) return 400 with an error.
 * - Covers input validation branches to prevent bad data reaching RocketGate.
 */

import request from 'supertest';
import { describe, it, expect } from 'vitest';

import { app } from '../src/index.js';

describe('/pay/init validation', () => {
  it('400 when amount or customer.id missing', async () => {
    const res = await request(app)
      .post('/pay/init')
      .send({ orderId: 'O-TEST', amount: '10.00', currency: 'USD' }); // no customer.id
    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe('INVALID_REQUEST');
  });
});
