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

// Route handlers
import adminRouter from './routes/admin.js';
import appApiRouter from './routes/appApi.js';
import appLaunchRouter from './routes/appLaunch.js';
import appProxyRouter from './routes/appProxy.js';
import authRouter from './routes/auth.js';
import callbacksRouter from './routes/callbacks.js';
import orderRouter from './routes/order.js';
import payRouter from './routes/pay.js';
import paymentSessionRouter from './routes/paymentSession.js';

app.use('/admin', adminRouter);
app.use('/app-api', appApiRouter);
app.use('/app-proxy', appProxyRouter);
app.use('/auth', authRouter);
app.use('/callbacks', callbacksRouter);
app.use('/order', orderRouter);
app.use('/pay', payRouter);
app.use('/payments', paymentSessionRouter);

// If launched from Shoplazza admin, bounce to /app-start (keeps URL clean)
app.get('/', (req, res, next) => {
  if (req.query.install_from === 'admin' && (req.query.shop || req.query.hmac)) {
    const qs = new URLSearchParams(req.query).toString();
    return res.redirect(302, `/app-start?${qs}`);
  }
  return next(); // fall through to public/index.html for install page
});

// Gate /app.html by session (NOT by HMAC on every load)
import { readAppSession } from './utils/appSession.js';
app.get('/app.html', (req, res, next) => {
  const sess = readAppSession(req);
  if (sess?.shop) return next(); // ok, let static serve app.html
  // No session? send them through /app-start to verify HMAC and mint a session
  const qs = new URLSearchParams(req.query).toString();
  return res.redirect(302, `/app-start?${qs}`);
});

// Handle /app-start (this route verifies HMAC & sets the session)
app.use('/app-start', appLaunchRouter);

// Static LAST so app.html is served after the checks above
app.use(express.static(path.join(process.cwd(), 'public'), { extensions: ['html'] }));

// Simple public routing
app.use(express.static(path.join(process.cwd(), 'public'), { extensions: ['html'] }));

// Simple health check endpoint
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

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
