// src/routes/callbacks.js
import crypto from 'crypto';

import { Router } from 'express';

import { getPayment, setPaymentStatus, createOrUpdatePayment } from '../db/index.js';
import { getShop } from '../db/shops.js';

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
 * Normalize buyer-return fields from query/body.
 * Supports our current flow that includes `spz_*` params from /payments/session.
 */
function extractReturnFields(req) {
  const q = req.query || {};
  const b = req.body || {};

  const orderId = b.orderId || b.invoice || q.orderId || q.invoice || null;
  const resultRaw = (b.result ?? b.status ?? q.result ?? q.status)?.toString().toLowerCase() || '';

  const rocketgateTxnId =
    b.rocketgateTxnId ||
    b.transactId ||
    b.transaction_id ||
    q.rocketgateTxnId ||
    q.transactId ||
    q.transaction_id ||
    null;

  // Shoplazza integration params we appended to the Hosted Page return links:
  const completeUrl = b.spz_complete || q.spz_complete || null;
  const cancelUrl = b.spz_cancel || q.spz_cancel || null;
  const callbackUrl = b.spz_callback || q.spz_callback || null;
  const shop = b.shop || q.shop || null;

  return { orderId, resultRaw, rocketgateTxnId, completeUrl, cancelUrl, callbackUrl, shop };
}

/**
 * Map buyer return result to our forward-only state.
 */
function mapReturnResult(resultRaw) {
  if (resultRaw === 'success') return 'returned_success';
  if (resultRaw === 'fail' || resultRaw === 'failure') return 'returned_fail';
  return 'returned_unknown';
}

/**
 * Normalize RocketGate notify fields (multiple shapes tolerated).
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
 * Additionally, if `spz_complete` and `shop` are present, we *best-effort*
 * POST to Shoplazza's Complete Payment endpoint with the shop's Access-Token.
 */
async function completePaymentHandler(req, res) {
  console.log('🔔 [complete-payment] q:', req.query);
  if (req.method !== 'GET') console.log('🔔 [complete-payment] b:', req.body);
  if (req.rawBody) console.log('🔒 [complete-payment] raw len:', req.rawBody.length);

  const { orderId, resultRaw, rocketgateTxnId, completeUrl, cancelUrl, callbackUrl, shop } =
    extractReturnFields(req);

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

  // Forward-only update (setPaymentStatus should enforce no regressions)
  const state = setPaymentStatus({
    orderId,
    status: translated,
    rocketgateTxnId: rocketgateTxnId || null,
  });

  // Notify Shoplazza's Complete Payment endpoint
  let completeNotified = false;
  const version = process.env.SHOPLAZZA_API_VERSION || '2022-01';
  const appId = process.env.SHOPLAZZA_CLIENT_ID;

  if (shop && appId) {
    try {
      // 1) Load access token for this shop
      const shopRow = await getShop(String(shop));
      const accessToken = shopRow?.accessToken || null;

      // 2) Build endpoint and body
      const endpoint = `https://${shop}/openapi/${version}/payments_apps/complete_callbacks`;

      // We don’t always have all fields here yet; populate what we know.
      // If you’ve stored amount/currency in your payments table, read them instead of fallbacks.
      const bodyObj = {
        app_id: String(appId),
        payment_id: String(req.query.spz_payment_id || 'unknown-payment'),
        amount: Number(state?.amount ?? 0), // TODO: read from your payments row if available
        currency: String(state?.currency || 'USD'), // TODO: read from your payments row if available
        transaction_no: String(state?.rocketgate_txn || 'pending'), // or the RG transactId if you have it
        type: 'sale', // or 'authorization' if you’re doing auth/capture
        test: !!(req.query.spz_test && String(req.query.spz_test).toLowerCase() === 'true'),
        status: 'paying', // per docs, this call is to tell SP the user finished checkout, not final result
        timestamp: new Date().toISOString(),
        // extension: { ... }    // optional custom fields
      };

      const bodyJson = JSON.stringify(bodyObj);

      // 3) Compute Shoplazza HMAC over the raw JSON body using your app’s client secret
      const clientSecret = process.env.SHOPLAZZA_CLIENT_SECRET || '';
      const hmac = crypto.createHmac('sha256', clientSecret).update(bodyJson).digest('hex');

      // 4) POST with required headers
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Access-Token': accessToken || '',
          'Shoplazza-Shop-Domain': String(shop),
          'Shoplazza-Hmac-Sha256': hmac,
        },
        body: bodyJson,
      });

      completeNotified = resp.ok;

      // Attach compact debug so you can see what happened (visible in the JSON you return)
      const dbg = {
        endpoint,
        status: resp.status,
        ok: resp.ok,
        sent: { ...bodyObj, transaction_no: bodyObj.transaction_no }, // safe summary
      };
      try {
        dbg.resText = (await resp.text()).slice(0, 400);
      } catch (err) {
        console.warn('Error reading complete response text', err);
      }
      req._completeDebug = dbg;

      if (!resp.ok) {
        console.warn('Complete Payment failed:', dbg);
      }
    } catch (err) {
      console.warn('Complete Payment fetch error:', err);
      req._completeDebug = { error: String(err) };
    }
  }

  // Dev-friendly JSON response (swap to a redirect if you prefer buyer UX)
  return res.json({
    ok: true,
    orderId,
    state,
    completeNotified,
    completeDebug: req._completeDebug || null,
    callbackUrl: callbackUrl || null,
    cancelUrl: cancelUrl || null,
    shop: shop || null,
  });
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
  console.log('🔔 [notify] body:', req.body);
  if (req.rawBody) console.log('🔒 [notify] raw len:', req.rawBody.length);

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

  return res.json({ ok: true, state: updated });
});

export default router;
