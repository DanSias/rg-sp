/**
 * E2E-ish: init an order, simulate buyer return + async notify, assert final status.
 */
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';

import { app } from '../src/index.js';
import { resetOrders, getOrder } from '../src/routes/order.js';

beforeEach(() => resetOrders());

describe('Payment flow updates order status', () => {
  it('moves from pending -> returned_success -> paid', async () => {
    // 1) Create order
    const create = await request(app)
      .post('/order')
      .send({
        orderId: 'O-E2E-1',
        amount: '19.99',
        currency: 'USD',
        customer: { id: 'C1' },
      });
    expect(create.status).toBe(201);

    // 2) Simulate buyer return from Hosted Page (success)
    const ret = await request(app)
      .post('/callbacks/complete-payment')
      .send({ orderId: 'O-E2E-1', status: 'success' });
    expect(ret.status).toBe(200);
    expect(ret.body.state.status).toBe('returned_success');

    // 3) Simulate authoritative async notify (paid)
    const notify = await request(app)
      .post('/callbacks/notify')
      .send({ shoplazzaOrderId: 'O-E2E-1', status: 'paid' });
    expect(notify.status).toBe(200);
    expect(notify.body.state.status).toBe('paid');

    // 4) Confirm via /order API
    const get = await request(app).get('/order/O-E2E-1');
    expect(get.status).toBe(200);
    expect(get.body.status).toBe('paid');

    // 5) Ensure forward-only (paid should not regress)
    const failReturn = await request(app)
      .post('/callbacks/complete-payment')
      .send({ orderId: 'O-E2E-1', status: 'fail' });
    expect(failReturn.status).toBe(200);
    const final = getOrder('O-E2E-1');
    expect(final.status).toBe('paid');
  });
});
