// src/db/payments.js
/**
 * SQLite-backed payments store.
 * API:
 *   - createOrUpdatePayment({ orderId, customerId?, amount?, currency?, status? })
 *   - getPayment(orderId)
 *   - setPaymentStatus({ orderId, status, rocketgateTxnId? }) // forward-only transitions
 *   - resetPayments()
 *
 * Notes:
 * - Status is "forward-only" via rank precedence to avoid accidental downgrades.
 */
import { db } from './connection.js';

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    order_id        TEXT PRIMARY KEY,
    customer_id     TEXT,
    amount          TEXT,
    currency        TEXT,
    rocketgate_txn  TEXT,
    status          TEXT,
    last_update     INTEGER
  );
`);

const selOne = db.prepare(`
  SELECT
    order_id        AS order_id,
    customer_id     AS customer_id,
    amount          AS amount,
    currency        AS currency,
    rocketgate_txn  AS rocketgate_txn,
    status          AS status,
    last_update     AS last_update
  FROM payments
  WHERE order_id = ?
`);

const upsert = db.prepare(`
  INSERT INTO payments (order_id, customer_id, amount, currency, rocketgate_txn, status, last_update)
  VALUES (@order_id, @customer_id, @amount, @currency, @rocketgate_txn, @status, @last_update)
  ON CONFLICT(order_id) DO UPDATE SET
    customer_id    = COALESCE(excluded.customer_id, payments.customer_id),
    amount         = COALESCE(excluded.amount,      payments.amount),
    currency       = COALESCE(excluded.currency,    payments.currency),
    rocketgate_txn = COALESCE(excluded.rocketgate_txn, payments.rocketgate_txn),
    status         = COALESCE(excluded.status,      payments.status),
    last_update    = excluded.last_update
`);

const updateMinimal = db.prepare(`
  UPDATE payments
  SET status = @status,
      rocketgate_txn = COALESCE(@rocketgate_txn, rocketgate_txn),
      last_update = @last_update
  WHERE order_id = @order_id
`);

const delAll = db.prepare(`DELETE FROM payments`);

export function getPayment(orderId) {
  return selOne.get(orderId) ?? null;
}

// rank: forward-only transitions
const RANK = new Map([
  ['pending', 0],
  ['returned_fail', 1],
  ['returned_success', 2],
  ['paid', 3],
  ['refunded', 4],
  ['voided', 5],
  ['chargeback', 6],
]);

function canAdvance(oldStatus, newStatus) {
  if (!oldStatus) return true;
  const oldR = RANK.has(oldStatus) ? RANK.get(oldStatus) : 0;
  const newR = RANK.has(newStatus) ? RANK.get(newStatus) : 0;
  return newR >= oldR;
}

/**
 * Upsert/merge a payment row. Ignores status if it would downgrade.
 */
export function createOrUpdatePayment({
  orderId,
  customerId = null,
  amount = null,
  currency = null,
  status = null,
  rocketgateTxnId = null,
}) {
  if (!orderId) throw new Error('createOrUpdatePayment: orderId is required');

  const prev = getPayment(orderId);
  const nextStatus =
    status && canAdvance(prev?.status, status) ? status : (prev?.status ?? status ?? 'pending');

  const row = {
    order_id: orderId,
    customer_id: customerId ?? prev?.customer_id ?? null,
    amount: amount ?? prev?.amount ?? null,
    currency: currency ?? prev?.currency ?? null,
    rocketgate_txn: rocketgateTxnId ?? prev?.rocketgate_txn ?? null,
    status: nextStatus ?? null,
    last_update: Date.now(),
  };

  upsert.run(row);
  return getPayment(orderId);
}

/**
 * Forward-only status update. Returns the new row.
 */
export function setPaymentStatus({ orderId, status, rocketgateTxnId = null }) {
  if (!orderId || !status) throw new Error('setPaymentStatus: orderId and status are required');

  const prev = getPayment(orderId);
  if (!prev) {
    // Insert minimal row if missing
    return createOrUpdatePayment({ orderId, status, rocketgateTxnId });
  }

  if (!canAdvance(prev.status, status)) {
    // no-op downgrade
    return prev;
  }

  updateMinimal.run({
    order_id: orderId,
    status,
    rocketgate_txn: rocketgateTxnId,
    last_update: Date.now(),
  });

  return getPayment(orderId);
}

export function resetPayments() {
  delAll.run();
}

export default { createOrUpdatePayment, getPayment, setPaymentStatus, resetPayments };
