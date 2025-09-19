// src/db/payments.js
/**
 * Kysely-backed payments store.
 * Table: payments (created by runMigrations in src/db/connection.js)
 *
 * Columns (see connection.js):
 *   id, shop_domain, order_id, payment_id, customer_id,
 *   amount, currency, status, rocketgate_txn,
 *   status_history (text JSON), rg_raw_notify (text), spz_raw_complete (text),
 *   created_at, updated_at
 *
 * API:
 *   - createOrUpdatePayment({ shopDomain, orderId, paymentId?, customerId?, amount?, currency?, status?, rocketgateTxnId?, appendHistory? })
 *   - getPayment(orderId)                       // by Shoplazza order id (legacy-friendly)
 *   - getPaymentByPaymentId(paymentId)          // by Shoplazza payment attempt id
 *   - setPaymentStatus({ orderId, status, rocketgateTxnId?, appendHistory? })
 *   - resetPayments()
 *
 * Notes:
 * - Status is "forward-only" via rank precedence to avoid accidental downgrades.
 * - Status history is stored as a JSON array in `status_history`.
 */

import { sql } from 'kysely';

import { db } from './connection.js';

// -------------------------- Forward-only rank ---------------------------

const RANK = new Map([
  ['initiated', 0],
  ['pending', 1],
  ['returned_fail', 2],
  ['returned_success', 3],
  ['paid', 4],
  ['refunded', 5],
  ['voided', 6],
  ['chargeback', 7],
  ['error', 8],
  ['declined', 9],
]);

function canAdvance(oldStatus, newStatus) {
  if (!oldStatus) return true;
  const oldR = RANK.has(oldStatus) ? RANK.get(oldStatus) : 0;
  const newR = RANK.has(newStatus) ? RANK.get(newStatus) : 0;
  return newR >= oldR;
}

function nowIso() {
  // Use ISO for history entries; updated_at uses DB CURRENT_TIMESTAMP
  return new Date().toISOString();
}

/**
 * Internal: append a history entry to an existing JSON array (stored as TEXT).
 */
function appendHistoryText(prevText, entry) {
  try {
    const arr = prevText ? JSON.parse(prevText) : [];
    arr.push(entry);
    return JSON.stringify(arr);
  } catch {
    // If existing is malformed, start fresh with current entry.
    return JSON.stringify([entry]);
  }
}

// ------------------------------ Reads ----------------------------------

export async function getPayment(orderId) {
  if (!orderId) return null;
  const row = await db
    .selectFrom('payments')
    .selectAll()
    .where('order_id', '=', String(orderId))
    .executeTakeFirst();
  return row ?? null;
}

export async function getPaymentByPaymentId(paymentId) {
  if (!paymentId) return null;
  const row = await db
    .selectFrom('payments')
    .selectAll()
    .where('payment_id', '=', String(paymentId))
    .executeTakeFirst();
  return row ?? null;
}

// ------------------------------ Upserts --------------------------------

/**
 * Upsert/merge a payment row. Ignores status if it would downgrade.
 * Accepts both the “new” shape and the older one (for current callers).
 */
export async function createOrUpdatePayment({
  shopDomain = null,
  orderId,
  paymentId = null,
  customerId = null,
  amount = null,
  currency = null,
  status = null,
  rocketgateTxnId = null,
  appendHistory = true,
} = {}) {
  if (!orderId) throw new Error('createOrUpdatePayment: orderId is required');

  const prev = await getPayment(orderId);

  const nextStatus =
    status && canAdvance(prev?.status, status) ? status : (prev?.status ?? status ?? 'pending');

  const historyEntry = { ts: nowIso(), status: nextStatus, source: 'createOrUpdate' };
  const status_history = appendHistory
    ? appendHistoryText(prev?.status_history ?? null, historyEntry)
    : (prev?.status_history ?? null);

  // Build write set
  const toWrite = {
    shop_domain: shopDomain ?? prev?.shop_domain ?? null,
    order_id: String(orderId),
    payment_id: paymentId ?? prev?.payment_id ?? null,
    customer_id: customerId ?? prev?.customer_id ?? null,
    amount: amount ?? prev?.amount ?? null,
    currency: currency ?? prev?.currency ?? null,
    status: nextStatus,
    rocketgate_txn: rocketgateTxnId ?? prev?.rocketgate_txn ?? null,
    status_history,
  };

  // Upsert keyed by (shop_domain, order_id, payment_id) if present; otherwise by order_id as fallback
  // We’ll use the unique constraint from migrations (shop_domain, order_id, payment_id).
  // If payment_id is null, uniqueness falls back effectively to (shop_domain, order_id).
  await db
    .insertInto('payments')
    .values(toWrite)
    .onConflict((oc) =>
      oc.columns(['shop_domain', 'order_id', 'payment_id']).doUpdateSet((eb) => ({
        shop_domain: eb.ref('excluded.shop_domain'),
        customer_id: eb
          .case()
          .when(sql`excluded.customer_id IS NOT NULL`)
          .then(eb.ref('excluded.customer_id'))
          .else(eb.ref('payments.customer_id'))
          .end(),
        amount: eb
          .case()
          .when(sql`excluded.amount IS NOT NULL`)
          .then(eb.ref('excluded.amount'))
          .else(eb.ref('payments.amount'))
          .end(),
        currency: eb
          .case()
          .when(sql`excluded.currency IS NOT NULL`)
          .then(eb.ref('excluded.currency'))
          .else(eb.ref('payments.currency'))
          .end(),
        rocketgate_txn: eb
          .case()
          .when(sql`excluded.rocketgate_txn IS NOT NULL`)
          .then(eb.ref('excluded.rocketgate_txn'))
          .else(eb.ref('payments.rocketgate_txn'))
          .end(),
        // Forward-only for status
        status: sql`CASE
                        WHEN ${nextStatus} IS NOT NULL THEN ${nextStatus}
                        ELSE payments.status
                      END`,
        status_history: toWrite.status_history ?? eb.ref('payments.status_history'),
        updated_at: sql`CURRENT_TIMESTAMP`,
      }))
    )
    .execute();

  return await getPayment(orderId);
}

/**
 * Forward-only status update. Returns the new row.
 */
export async function setPaymentStatus({
  orderId,
  status,
  rocketgateTxnId = null,
  appendHistory = true,
}) {
  if (!orderId || !status) throw new Error('setPaymentStatus: orderId and status are required');
  const prev = await getPayment(orderId);

  if (!prev) {
    // Insert minimal row if missing
    return await createOrUpdatePayment({ orderId, status, rocketgateTxnId, appendHistory });
  }

  if (!canAdvance(prev.status, status)) {
    // no-op downgrade
    return prev;
  }

  const history = appendHistory
    ? appendHistoryText(prev.status_history ?? null, { ts: nowIso(), status, source: 'setStatus' })
    : (prev.status_history ?? null);

  await db
    .updateTable('payments')
    .set({
      status,
      rocketgate_txn: rocketgateTxnId ?? prev.rocketgate_txn ?? null,
      status_history: history,
      updated_at: sql`CURRENT_TIMESTAMP`,
    })
    .where('order_id', '=', String(orderId))
    .execute();

  return await getPayment(orderId);
}

// ------------------------------ Utilities ------------------------------

export async function resetPayments() {
  await db.deleteFrom('payments').execute();
}

export default {
  createOrUpdatePayment,
  getPayment,
  getPaymentByPaymentId,
  setPaymentStatus,
  resetPayments,
};
