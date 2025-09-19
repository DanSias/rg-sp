// src/index.js
import fs from 'node:fs';
import path from 'node:path';

import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import express from 'express';
import morgan from 'morgan';

import { runMigrations } from './db/index.js';

dotenv.config();

export const app = express();

/**
 * Configure runtime flag for verifying Shoplazza signatures.
 *
 * By default, we check the VERIFY_SHOPLAZZA_SIGNATURE value in .env.
 * This populates app.locals.verifySignatures, which middleware can
 * read at request time. It allows us to:
 *   - Enforce signature verification in production when the env is true.
 *   - Override/toggle signature checks dynamically in tests by
 *     setting app.locals.verifySignatures = true/false.
 */
app.locals.verifySignatures =
  String(process.env.VERIFY_SHOPLAZZA_SIGNATURE || 'false').toLowerCase() === 'true';

/**
 * ⚠️ Important: Capture the raw request body
 *
 * Shoplazza signs its callback/webhook payloads with HMAC.
 * To validate those signatures later, we need the *exact raw bytes*
 * of the body — not just the parsed JSON.
 *
 * This verify function saves the raw buffer into `req.rawBody`
 * while still letting Express parse JSON normally into `req.body`.
 */
app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      // NOTE: do not mutate buf; keep exact bytes for HMAC validation
      req.rawBody = buf;
    },
  })
);

// Optional: also accept application/x-www-form-urlencoded with raw capture
app.use(
  express.urlencoded({
    extended: true,
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

/**
 * Morgan HTTP logger
 * Example output: "POST /pay/init 200 15ms"
 * Helpful for debugging request flow between Shoplazza and RocketGate.
 */
app.use(morgan('tiny'));

// Cookie parser for session middleware
app.use(cookieParser());

// Mount all sub-routers in a single place (routes/index.js).
// Keeps src/index.js clean by centralizing /admin, /auth, /app-api, /pay, /payments, etc.
// Each router stays focused, and adding new routes only requires updating routes/index.js.
import mountRoutes from './routes/index.js';
mountRoutes(app);

// Static LAST (serve public files; app.html will be session-gated by routes/index.js)
app.use(express.static(path.join(process.cwd(), 'public'), { extensions: ['html'] }));

/**
 * Minimal error handler — surfaces unexpected errors and avoids silent failures.
 * (Place after routes; before listen.)
 */
app.use((err, req, res, _next) => {
  console.error(`[${req.method} ${req.url}]`, err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal Server Error' });
});

/**
 * Boot sequence:
 * 1) Ensure SQLite data dir (for dev) so `better-sqlite3` can create the file.
 * 2) Run idempotent Kysely migrations (portable across sqlite/pg/mysql).
 * 3) Start HTTP server.
 */
async function boot() {
  // 1) Ensure data dir for sqlite dev
  const client = (process.env.DB_CLIENT || 'sqlite').toLowerCase();
  const dbUrl = process.env.DB_URL || './data/dev.db';
  if (client === 'sqlite') {
    const dir = path.dirname(path.isAbsolute(dbUrl) ? dbUrl : path.join(process.cwd(), dbUrl));
    fs.mkdirSync(dir, { recursive: true });
  }

  // 2) Run migrations
  await runMigrations();

  // 3) Start server (only outside tests)
  if (process.env.NODE_ENV !== 'test') {
    const port = process.env.PORT || 3000;
    app.listen(port, () => {
      console.log(`🚀 RG × Shoplazza app listening on :${port}`);
    });
  }
}

// Kick off boot (top-level await alternative for Node ESM)
boot().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
