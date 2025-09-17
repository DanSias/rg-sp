// src/db/orders.js
/**
 * SQLite-backed orders store used by /order routes.
 * API:
 *   - createOrder({ orderId, amount, currency, customer })
 *   - getOrder(orderId)
 *   - listOrders()
 *   - updateOrder(orderId, { status?, rocketgateTxnId? })
 *   - resetOrders()
 */
import { db } from './connection.js';

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    order_id        TEXT PRIMARY KEY,
    amount          TEXT,
    currency        TEXT,
    customer_json   TEXT,
    status          TEXT,
    rocketgate_txn  TEXT,
    created_at      INTEGER,
    updated_at      INTEGER
  );
`);

const selOne = db.prepare(`
  SELECT
    order_id        AS orderId,
    amount,
    currency,
    customer_json   AS customerJson,
    status,
    rocketgate_txn  AS rocketgateTxnId,
    created_at      AS createdAtMs,
    updated_at      AS updatedAtMs
  FROM orders
  WHERE order_id = ?
`);

const selAll = db.prepare(`
  SELECT
    order_id        AS orderId,
    amount,
    currency,
    customer_json   AS customerJson,
    status,
    rocketgate_txn  AS rocketgateTxnId,
    created_at      AS createdAtMs,
    updated_at      AS updatedAtMs
  FROM orders
  ORDER BY created_at DESC
`);

const insert = db.prepare(`
  INSERT INTO orders (order_id, amount, currency, customer_json, status, rocketgate_txn, created_at, updated_at)
  VALUES (@orderId, @amount, @currency, @customerJson, @status, @rocketgateTxnId, @createdAtMs, @updatedAtMs)
`);

const updateStmt = db.prepare(`
  UPDATE orders
  SET status = COALESCE(@status, status),
      rocketgate_txn = COALESCE(@rocketgateTxnId, rocketgate_txn),
      updated_at = @updatedAtMs
  WHERE order_id = @orderId
`);

const delAll = db.prepare(`DELETE FROM orders`);

function rowToPublic(row) {
  if (!row) return null;
  return {
    orderId: row.orderId,
    amount: row.amount,
    currency: row.currency,
    customer: row.customerJson ? JSON.parse(row.customerJson) : null,
    status: row.status,
    rocketgateTxnId: row.rocketgateTxnId ?? null,
    createdAt: new Date(row.createdAtMs).toISOString(),
    updatedAt: row.updatedAtMs ? new Date(row.updatedAtMs).toISOString() : null,
  };
}

export function createOrder({ orderId, amount, currency, customer }) {
  if (!orderId || !amount || !currency) {
    throw new Error('createOrder: orderId, amount, currency are required');
  }
  const now = Date.now();
  insert.run({
    orderId,
    amount: String(amount),
    currency: String(currency).toUpperCase(),
    customerJson: customer ? JSON.stringify(customer) : null,
    status: 'pending',
    rocketgateTxnId: null,
    createdAtMs: now,
    updatedAtMs: null,
  });
  return getOrder(orderId);
}

export function getOrder(orderId) {
  const row = selOne.get(orderId);
  return rowToPublic(row);
}

export function listOrders() {
  return selAll.all().map(rowToPublic);
}

export function updateOrder(orderId, { status, rocketgateTxnId } = {}) {
  const now = Date.now();
  updateStmt.run({
    orderId,
    status: status ?? null,
    rocketgateTxnId: rocketgateTxnId ?? null,
    updatedAtMs: now,
  });
  return getOrder(orderId);
}

export function resetOrders() {
  delAll.run();
}

export default { createOrder, getOrder, listOrders, updateOrder, resetOrders };
