import path from 'node:path';

import dotenv from 'dotenv';
import express from 'express';
import morgan from 'morgan';

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
    verify: (req, res, buf) => {
      req.rawBody = buf; // Store raw body for HMAC verification later
    },
  })
);

/**
 * Morgan HTTP logger
 * Example output: "POST /pay/init 200 15ms"
 * Helpful for debugging request flow between Shoplazza and RocketGate.
 */
app.use(morgan('tiny'));

// Route handlers
import appProxyRouter from './routes/appProxy.js';
import authRouter from './routes/auth.js';
import callbacksRouter from './routes/callbacks.js';
import orderRouter from './routes/order.js';
import payRouter from './routes/pay.js';
import paymentSessionRouter from './routes/paymentSession.js';

app.use('/app-proxy', appProxyRouter);
app.use('/auth', authRouter);
app.use('/callbacks', callbacksRouter);
app.use('/order', orderRouter);
app.use('/pay', payRouter);
app.use('/payments', paymentSessionRouter);

// Simple home so "App URL" has a landing page
app.use(express.static(path.join(process.cwd(), 'public'), { extensions: ['html'] }));

// Simple health check endpoint
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Only listen when run directly (not under Vitest)
if (process.env.NODE_ENV !== 'test') {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`🚀 RG × Shoplazza app listening on :${port}`);
  });
}
