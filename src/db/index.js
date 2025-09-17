// src/db/index.js
// Single import/export hub for all DB access.
// Uses a shared better-sqlite3 connection so every module
// (shops, payments, orders) runs on the same file/transaction context.

export { db } from './connection.js';

// Shops (SQLite)
export { upsertShop, getShop, listShops, resetShops } from './shops.js';

// Payments (SQLite) — forward-only state machine preserved
export { createOrUpdatePayment, getPayment, setPaymentStatus, resetPayments } from './payments.js';

// Orders (SQLite)
export { createOrder, getOrder, listOrders, updateOrder, resetOrders } from './orders.js';
