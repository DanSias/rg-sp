// src/routes/callbacks.js
import crypto from 'crypto';

import { Router } from 'express';

import { getPayment, setPaymentStatus, createOrUpdatePayment } from '../db/index.js';
// Optional: if you add server-to-server confirm, you can import it:
// import { confirmWithServerByInvoice } from '../utils/rocketgate.js';

const router = Router();

/* ------------------------------ Helpers ------------------------------ */

/**
 * Optional HMAC verification for RocketGate async notify.
 * Controlled by env:
 *   VERIFY_ROCKETGATE_NOTIFY_SIGNATURE=true|false
 *   ROCKETGATE_NOTIFY_SIGNATURE_HEADER=  (e.g., 'X-RG-Signature')
 *   ROCKETGATE_NOTIFY_SIGNATURE_SECRET=  (shared secret)
 *   ROCKETGATE_NOTIFY_SIGNATURE_ENCODING=hex|base64  (default: hex)
 *
 * NOTE: This assumes the signature is HMAC-SHA256 over the *raw* request body.
 * Ensure your app sets req.rawBody in middleware *before* JSON parsing if you enable this.
 */
function maybeVerifyRocketGateSignature(req, res, next) {
  const verify = String(process.env.VERIFY_ROCKETGATE_NOTIFY_SIGNATURE || 'false').toLowerCase();
  const shouldVerify = ['1', 'true', 'yes', 'on'].includes(verify);

  if (!shouldVerify) return next();

  const headerName = process.env.ROCKETGATE_NOTIFY_SIGNATURE_HEADER || '';
  const secret = process.env.ROCKETGATE_NOTIFY_SIGNATURE_SECRET || '';
  const encoding = (process.env.ROCKETGATE_NOTIFY_SIGNATURE_ENCODING || 'hex').toLowerCase();

  if (!headerName || !secret) {
    return res.status(500).send('Notify signature is enabled but not configured.');
  }

  const provided = req.get(headerName);
  if (!provided) return res.status(400).send('Missing RocketGate signature header.');

  if (!req.rawBody || !(req.rawBody instanceof Buffer)) {
    return res.status(400).send('Missing raw body for signature verification.');
  }

  try {
    const computed = crypto.createHmac('sha256', secret).update(req.rawBody).digest(encoding);
    const a = Buffer.from(provided);
    const b = Buffer.from(computed);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(400).send('Invalid RocketGate signature.');
    }
    return next();
  } catch (err) {
    req.log?.error?.(err);
    return res.status(400).send('Signature verification failed.');
  }
}

/**
 * Normalize RocketGate-ish fields from either query or body.
 * Supports both current flow and earlier dev payloads.
 */
function extractReturnFields(req) {
  const q = req.query || {};
  const b = req.body || {};

  const orderId = b.orderId || b.invoice || q.orderId || q.invoice || null;

  // We use "result" (success|fail) in our pay.js success/fail URLs.
  const resultRaw = (b.result ?? b.status ?? q.result ?? q.status)?.toString().toLowerCase() || '';

  const rocketgateTxnId =
    b.rocketgateTxnId ||
    b.transactId ||
    b.transaction_id ||
    q.rocketgateTxnId ||
    q.transactId ||
    q.transaction_id ||
    null;

  return { orderId, resultRaw, rocketgateTxnId };
}

/**
 * Map buyer return result to internal forward-only state.
 */
function mapReturnResult(resultRaw) {
  if (resultRaw === 'success') return 'returned_success';
  if (resultRaw === 'fail' || resultRaw === 'failure') return 'returned_fail';
  return 'returned_unknown';
}

/**
 * Normalize RocketGate notify fields.
 * Accepts various shapes so you can iterate without breaking.
 */
function extractNotifyFields(req) {
  const q = req.query || {};
  const b = req.body || {};

  const orderId =
    b.invoice ||
    b.orderId ||
    b.shoplazzaOrderId ||
    q.invoice ||
    q.orderId ||
    q.shoplazzaOrderId ||
    null;

  const statusRaw = (b.status ?? q.status)?.toString().toLowerCase() || '';

  const rocketgateTxnId =
    b.rocketgateTxnId ||
    b.transactId ||
    b.transaction_id ||
    q.rocketgateTxnId ||
    q.transactId ||
    q.transaction_id ||
    null;

  return { orderId, statusRaw, rocketgateTxnId };
}

/**
 * Map RocketGate status -> internal status.
 * Adjust if RocketGate confirms a different vocabulary.
 */
function mapNotifyStatus(statusRaw) {
  const map = {
    approved: 'paid',
    captured: 'paid',
    settled: 'paid',
    paid: 'paid',
    refunded: 'refunded',
    voided: 'voided',
    chargeback: 'chargeback',
    disputed: 'chargeback',
    decline: 'declined',
    declined: 'declined',
    error: 'error',
    failed: 'declined',
  };
  return map[statusRaw] || 'unknown';
}

/* ------------------------------ Routes ------------------------------ */

/**
 * GET/POST /callbacks/complete-payment
 *
 * Buyer returns from RocketGate Hosted Page. This is a buyer-facing result, not
 * the final settlement truth (notify is authoritative). We persist:
 *   - returned_success | returned_fail | returned_unknown
 *   - rocketgateTxnId (if provided)
 *
 * Notes:
 * - We support both GET (real redirect) and POST (manual/dev testing).
 * - We do *not* verify Shoplazza signatures here; this endpoint is hit by RocketGate/browsers.
 */
async function completePaymentHandler(req, res) {
  // Minimal debug logs during integration; remove or switch to structured logger later.
  console.log('🔔 [complete-payment] Parsed query:', req.query);
  if (req.method !== 'GET') console.log('🔔 [complete-payment] Parsed body:', req.body);
  if (req.rawBody) console.log('🔒 [complete-payment] Raw body length:', req.rawBody.length);

  const { orderId, resultRaw, rocketgateTxnId } = extractReturnFields(req);

  if (!orderId || !resultRaw) {
    return res.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'Missing orderId or result' },
    });
  }

  const translated = mapReturnResult(resultRaw);

  // Ensure a row exists (buyer can beat /pay/init to the punch in rare races)
  if (!getPayment(orderId)) {
    createOrUpdatePayment({
      orderId,
      customerId: null,
      amount: null,
      currency: null,
      status: translated,
    });
  }

  // Forward-only update; setPaymentStatus should enforce no regressions
  const state = setPaymentStatus({
    orderId,
    status: translated,
    rocketgateTxnId: rocketgateTxnId || null,
  });

  // Option A (dev-friendly): return JSON
  return res.json({ ok: true, orderId, state });

  // Option B (buyer UX): redirect to an order status page in your app/admin
  // return res.redirect(`/order/${encodeURIComponent(orderId)}?status=${translated}`);
}

router.get('/complete-payment', completePaymentHandler);
router.post('/complete-payment', completePaymentHandler);

/**
 * POST /callbacks/notify
 *
 * Authoritative async notification from RocketGate.
 * Moves an order to its final state (paid/refunded/voided/etc.).
 * Optional signature verification controlled by env (see helper).
 */
router.post('/notify', maybeVerifyRocketGateSignature, async (req, res) => {
  console.log('🔔 [notify] Parsed body:', req.body);
  if (req.rawBody) console.log('🔒 [notify] Raw body length:', req.rawBody.length);

  const { orderId, statusRaw, rocketgateTxnId } = extractNotifyFields(req);
  if (!orderId || !statusRaw) {
    return res.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'Missing invoice/orderId or status' },
    });
  }

  // Create a row if /pay/init hasn't run yet (webhooks can race)
  if (!getPayment(orderId)) {
    createOrUpdatePayment({
      orderId,
      customerId: null,
      amount: null,
      currency: null,
      status: 'initiated',
    });
  }

  const mapped = mapNotifyStatus(statusRaw);

  const updated = setPaymentStatus({
    orderId,
    status: mapped,
    rocketgateTxnId: rocketgateTxnId || null,
  });

  // (Optional) Belt-and-suspenders: confirm with server by invoice and reconcile if needed.
  // try {
  //   const confirm = await confirmWithServerByInvoice(orderId);
  //   // compare "confirm.status" with "mapped" and reconcile/log if different
  // } catch (e) {
  //   req.log?.warn?.({ err: e, orderId }, 'S2S confirm failed');
  // }

  return res.json({ ok: true, state: updated });
});

export default router;
