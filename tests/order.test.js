/**
 * Tests for /order routes
 * - Create an order
 * - Fetch it by ID
 * - Update its status
 * - List all orders
 */
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';

import { app } from '../src/index.js';
import { resetOrders } from '../src/routes/order.js'; // 👈 reset helper

beforeEach(() => {
  resetOrders(); // ensure clean slate per test
});

describe('/order API', () => {
  const base = '/order';

  it('creates a new order and fetches it back', async () => {
    const orderPayload = {
      orderId: 'O-TEST-1',
      amount: '25.00',
      currency: 'USD',
      customer: { id: 'CUST-TEST-1' },
    };

    const resCreate = await request(app).post(base).send(orderPayload);
    expect(resCreate.status).toBe(201);
    expect(resCreate.body).toMatchObject({ ok: true, orderId: 'O-TEST-1' });

    const resGet = await request(app).get(`${base}/O-TEST-1`);
    expect(resGet.status).toBe(200);
    expect(resGet.body).toMatchObject({
      orderId: 'O-TEST-1',
      amount: '25.00',
      currency: 'USD',
      customer: { id: 'CUST-TEST-1' },
      status: 'pending',
    });
  });

  it('updates an order status with PATCH', async () => {
    await request(app)
      .post(base)
      .send({
        orderId: 'O-TEST-2',
        amount: '10.00',
        currency: 'USD',
        customer: { id: 'CUST-TEST-2' },
      });

    const resPatch = await request(app).patch(`${base}/O-TEST-2`).send({ status: 'paid' });
    expect(resPatch.status).toBe(200);
    expect(resPatch.body.status).toBe('paid');

    const resGet = await request(app).get(`${base}/O-TEST-2`);
    expect(resGet.body.status).toBe('paid');
  });

  it('returns 404 for missing orders', async () => {
    expect((await request(app).get(`${base}/MISSING`)).status).toBe(404);
    expect((await request(app).patch(`${base}/MISSING`).send({ status: 'paid' })).status).toBe(404);
  });

  it('lists all orders', async () => {
    await request(app)
      .post(base)
      .send({
        orderId: 'O-LIST-1',
        amount: '5.00',
        currency: 'USD',
        customer: { id: 'CUST-LIST-1' },
      });
    await request(app)
      .post(base)
      .send({
        orderId: 'O-LIST-2',
        amount: '15.00',
        currency: 'USD',
        customer: { id: 'CUST-LIST-2' },
      });

    const resList = await request(app).get(base);
    expect(resList.status).toBe(200);
    const ids = resList.body.map((o) => o.orderId);
    expect(ids).toEqual(expect.arrayContaining(['O-LIST-1', 'O-LIST-2']));
  });
});
