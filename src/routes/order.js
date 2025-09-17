// src/routes/order.js
import { Router } from 'express';

import {
  createOrder, // insert new order row
  getOrder, // read one
  listOrders, // read all (new)
  updateOrder, // patch fields (status, rocketgateTxnId)
} from '../db/index.js';

const router = Router();

/**
 * POST /order
 *
 * Purpose:
 * - Create a new order record before redirecting to RocketGate Hosted Page.
 * - Persists to SQLite so callbacks/notify and GETs stay in sync across restarts.
 *
 * Expected body:
 * {
 *   orderId: "O-123",          // required
 *   amount: "14.34",           // required (string or number)
 *   currency: "USD",           // required
 *   customer: { id: "C-001" }  // optional (stored as JSON)
 * }
 *
 * Response: 201 + normalized order JSON
 */
router.post('/', (req, res) => {
  const { orderId, amount, currency, customer } = req.body || {};

  if (!orderId || !amount || !currency) {
    return res.status(400).json({ error: 'Missing required fields: orderId, amount, currency' });
  }

  try {
    const created = createOrder({
      orderId,
      amount,
      currency,
      customer: customer ?? null,
    });

    console.log(`📝 [orders] Created order ${orderId} (SQLite)`);
    return res.status(201).json({ ok: true, orderId: created.orderId });
  } catch (err) {
    console.error('Create order error:', err);
    return res.status(500).json({ error: 'Failed to create order' });
  }
});

/**
 * GET /order/:id
 *
 * Purpose:
 * - Fetch a single order by ID from SQLite.
 *
 * Response:
 * {
 *   orderId, amount, currency, customer, status,
 *   rocketgateTxnId, createdAt, updatedAt
 * }
 */
router.get('/:id', (req, res) => {
  const row = getOrder(req.params.id);
  if (!row) return res.status(404).json({ error: 'Order not found' });
  return res.json(row);
});

/**
 * GET /order
 *
 * Purpose:
 * - List all orders (dev/debug UI, admin pages, etc.)
 *
 * Response: Array<order>
 */
router.get('/', (_req, res) => {
  const rows = listOrders();
  return res.json(rows);
});

/**
 * PATCH /order/:id
 *
 * Purpose:
 * - Update an order (typically driven by callbacks).
 * - This route is lenient; it accepts partial body and only applies provided fields.
 *
 * Body:
 * {
 *   status?: "pending" | "returned_success" | "paid" | "refunded" | ...
 *   rocketgateTxnId?: "RG-XYZ"
 * }
 *
 * NOTE:
 * - The Orders table does NOT enforce forward-only transitions. That logic
 *   lives in the Payments table via setPaymentStatus. Here we simply
 *   record what the app decides is current. Keep this in mind if you
 *   choose to mirror status into payments as an authoritative ledger.
 */
router.patch('/:id', (req, res) => {
  const orderId = req.params.id;
  const exists = getOrder(orderId);
  if (!exists) return res.status(404).json({ error: 'Order not found' });

  const { status, rocketgateTxnId } = req.body || {};
  try {
    const updated = updateOrder(orderId, {
      status: status ? String(status) : undefined,
      rocketgateTxnId: rocketgateTxnId ?? undefined,
    });
    return res.json(updated);
  } catch (err) {
    console.error('Update order error:', err);
    return res.status(500).json({ error: 'Failed to update order' });
  }
});

export default router;
