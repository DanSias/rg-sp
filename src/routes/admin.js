// src/routes/admin.js
import { Router } from 'express';

import { listShops } from '../db/shops.js';

const router = Router();

/** Optional token guard for all admin routes */
router.use((req, res, next) => {
  const required = process.env.ADMIN_TOKEN;
  if (!required) return next(); // no guard in dev unless you set a token
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== required) return res.status(403).json({ ok: false, error: 'Forbidden' });
  next();
});

/** Quick health */
router.get('/health', (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// List Shops
router.get('/shops', async (_req, res) => {
  try {
    const shops = await listShops();
    res.json({ ok: true, count: shops.length, shops });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/** DB self-test: write then read a row from webhook_logs */
router.get('/db-check', async (_req, res, next) => {
  try {
    const { db } = await import('../db/index.js');
    const now = new Date().toISOString();
    await db.exec?.(`
      INSERT INTO webhook_logs (source, topic, idempotency_key, headers, payload_json, received_at)
      VALUES ('internal', 'db-check', 'check-${now}', '{}', '{"ping":true}', CURRENT_TIMESTAMP);
    `);
    const row = db
      .prepare?.(
        `
      SELECT id, source, topic, idempotency_key, received_at
      FROM webhook_logs ORDER BY id DESC LIMIT 1
    `
      )
      .get();
    res.json({ ok: true, lastLog: row || null });
  } catch (err) {
    next(err);
  }
});

/** Logs index: filterable list (source/topic/limit) */
router.get('/logs', async (req, res, next) => {
  try {
    const { db } = await import('../db/index.js');
    const source = (req.query.source || '').toString();
    const topic = (req.query.topic || '').toString();
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));

    const where = [
      source ? `source='${source.replaceAll("'", "''")}'` : null,
      topic ? `topic='${topic.replaceAll("'", "''")}'` : null,
    ]
      .filter(Boolean)
      .join(' AND ');

    const sql = `SELECT id, source, topic, idempotency_key, received_at
       FROM webhook_logs ${where ? `WHERE ${where}` : ''}
       ORDER BY id DESC LIMIT ${limit}`;

    const rows = db.prepare?.(sql).all() || [];
    res.json({ ok: true, count: rows.length, rows });
  } catch (err) {
    next(err);
  }
});

/** Logs detail */
router.get('/logs/:id', async (req, res, next) => {
  try {
    const { db } = await import('../db/index.js');
    const row = db
      .prepare?.(`SELECT * FROM webhook_logs WHERE id = ? LIMIT 1`)
      .get(Number(req.params.id));
    res.json({ ok: true, row: row || null });
  } catch (err) {
    next(err);
  }
});

/** (Optional) Dev reset of sqlite file tables — keep commented unless you need it */
// router.post('/reset', async (_req, res, next) => {
//   try {
//     const { db } = await import('../db/index.js');
//     await db.exec?.(`DELETE FROM webhook_logs; DELETE FROM payments;`);
//     res.json({ ok: true });
//   } catch (err) {
//     next(err);
//   }
// });

export default router;
