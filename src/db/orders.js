// src/db/orders.js
// Kysely-based orders store.
// API:
//   - createOrder({ orderId, amount, currency, customer })
//   - getOrder(orderId)
//   - listOrders()
//   - updateOrder(orderId, { status?, rocketgateTxnId? })
//   - resetOrders()

import { sql } from 'kysely';

import { db } from './connection.js';

const DB_CLIENT = (process.env.DB_CLIENT || 'sqlite').toLowerCase();
const isPg = DB_CLIENT === 'postgres';
const isMy = DB_CLIENT === 'mysql';

// --- Minimal, idempotent schema bootstrap (safe to keep until we add it to runMigrations) ---
await db.schema
  .createTable('orders')
  .ifNotExists()
  .addColumn('order_id', 'varchar(191)', (col) => col.primaryKey())
  .addColumn('amount', isMy ? 'decimal(18,2)' : isPg ? 'numeric' : 'real')
  .addColumn('currency', 'varchar(8)')
  .addColumn('customer_json', 'text')
  .addColumn('status', 'varchar(64)') // e.g., pending | paid | refunded | voided | ...
  .addColumn('rocketgate_txn', 'varchar(191)')
  .addColumn('created_at', isPg ? 'timestamptz' : 'text', (col) =>
    col.defaultTo(sql`CURRENT_TIMESTAMP`)
  )
  .addColumn('updated_at', isPg ? 'timestamptz' : 'text', (col) =>
    col.defaultTo(sql`CURRENT_TIMESTAMP`)
  )
  .execute();

// --- Row ↔ public model helpers ---
function rowToPublic(row) {
  if (!row) return null;
  return {
    orderId: row.order_id,
    amount:
      row.amount == null
        ? null
        : // keep amount as string to avoid float surprises across dialects
          String(row.amount),
    currency: row.currency || null,
    customer: row.customer_json ? safeParse(row.customer_json) : null,
    status: row.status || null,
    rocketgateTxnId: row.rocketgate_txn || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// --- Public API ---

export async function createOrder({ orderId, amount, currency, customer }) {
  if (!orderId || amount == null || !currency) {
    throw new Error('createOrder: orderId, amount, currency are required');
  }

  const toInsert = {
    order_id: String(orderId),
    amount: typeof amount === 'number' ? amount : String(amount),
    currency: String(currency).toUpperCase(),
    customer_json: customer ? JSON.stringify(customer) : null,
    status: 'pending',
    rocketgate_txn: null,
  };

  await db.insertInto('orders').values(toInsert).execute();

  return await getOrder(orderId);
}

export async function getOrder(orderId) {
  const row = await db
    .selectFrom('orders')
    .selectAll()
    .where('order_id', '=', String(orderId))
    .executeTakeFirst();

  return rowToPublic(row);
}

export async function listOrders() {
  const rows = await db.selectFrom('orders').selectAll().orderBy('created_at', 'desc').execute();

  return rows.map(rowToPublic);
}

export async function updateOrder(orderId, { status, rocketgateTxnId } = {}) {
  const patch = {
    ...(status != null ? { status } : {}),
    ...(rocketgateTxnId != null ? { rocketgate_txn: rocketgateTxnId } : {}),
    updated_at: sql`CURRENT_TIMESTAMP`,
  };

  await db.updateTable('orders').set(patch).where('order_id', '=', String(orderId)).execute();

  return await getOrder(orderId);
}

export async function resetOrders() {
  // Use truncate for pg/mysql later; delete is fine here and portable.
  await db.deleteFrom('orders').execute();
}

export default { createOrder, getOrder, listOrders, updateOrder, resetOrders };
