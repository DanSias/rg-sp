// src/db/index.js
// Single import/export hub for all DB access.

export { db, runMigrations } from './connection.js';

// Shops (SQLite)
export { upsertShop, getShop, listShops, resetShops } from './shops.js';

// Payments (SQLite) — forward-only state machine preserved
export { createOrUpdatePayment, getPayment, setPaymentStatus, resetPayments } from './payments.js';

// Orders (SQLite)
export { createOrder, getOrder, listOrders, updateOrder, resetOrders } from './orders.js';
