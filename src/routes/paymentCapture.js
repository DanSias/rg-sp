// src/routes/paymentCapture.js
import crypto from 'node:crypto';

import { Router } from 'express';

import { saveWebhookLog } from '../db/utils.js';

const router = Router();

/**
 * POST /payments/create
 * Captures raw Shoplazza payload + headers to webhook_logs.
 * If VERIFY_SHOPLAZZA_SIGNATURE=true, computes HMAC and reports result
 * (but does NOT reject yet — we’re in discovery mode).
 */
router.post('/create', async (req, res, next) => {
  try {
    const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : (v ?? '')])
    );

    const idempotencyKey =
      headers['x-shoplazza-request-id'] ||
      headers['x-request-id'] ||
      headers['x-idempotency-key'] ||
      null;

    // Optional HMAC check (report only)
    let hmacCheck = { verified: false, reason: 'skipped' };
    if (req.app?.locals?.verifySignatures) {
      const provided = headers['x-shoplazza-hmac-sha256'] || headers['x-hmac-sha256'];
      const secret = process.env.SHOPLAZZA_CLIENT_SECRET || '';
      if (provided && secret) {
        const digest = crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('base64');
        hmacCheck.verified = safeEq(digest, provided);
        hmacCheck.reason = hmacCheck.verified ? 'match' : 'mismatch';
      } else {
        hmacCheck.reason = 'missing header or secret';
      }
    }

    await saveWebhookLog({
      source: 'shoplazza',
      topic: 'payments/create',
      idempotencyKey,
      headers: JSON.stringify(headers, null, 2),
      payloadJson: raw,
    });

    // TEMP response — once we have a sample, we’ll replace this with a redirect object.
    return res.status(200).json({ ok: true, captured: true, hmac: hmacCheck });
  } catch (err) {
    return next(err);
  }
});

function safeEq(a, b) {
  const A = Buffer.from(String(a) || '', 'utf8');
  const B = Buffer.from(String(b) || '', 'utf8');
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

export default router;
