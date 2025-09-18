// src/routes/paymentSession.js
import crypto from 'node:crypto';

import express, { Router } from 'express';

import { db } from '../db/connection.js';
import { createOrUpdatePayment } from '../db/index.js';
import { buildHostedPageUrl } from '../utils/rocketgate.js';
import { maybeVerifyShoplazzaSignature } from '../utils/shoplazzaAuth.js';

const router = Router();

// Helpers
function header(req, name) {
  return req.headers[name] || req.headers[name.toLowerCase()] || null;
}
function normalizedShop(req) {
  // Prefer explicit param/body; fall back to header if Shoplazza sends one.
  const s =
    (req.query && req.query.shop) ||
    (req.body && req.body.shop) ||
    header(req, 'x-shop-domain') ||
    header(req, 'x-shoplazza-shop') ||
    '';
  return String(s || '')
    .trim()
    .toLowerCase();
}

/**
 * This route is configured as your "Payment Session URL" in Shoplazza.
 * Shoplazza sends x-www-form-urlencoded, so add urlencoded middleware here.
 *
 * Contract:
 *  - Verify HMAC via maybeVerifyShoplazzaSignature (env-driven)
 *  - Persist a 'pending' payment row (idempotent)
 *  - Build RocketGate HostedPage URL (success/fail include correlation params)
 *  - Return { redirect_url } to Shoplazza (they'll redirect the buyer)
 */
router.post(
  '/session',
  express.urlencoded({ extended: false }),
  maybeVerifyShoplazzaSignature,
  async (req, res) => {
    try {
      const {
        // Core identifiers
        id: paymentId, // Shoplazza payment attempt id (session id)
        shoplazza_order_id: orderId, // Merchant order id
        // Money
        amount,
        currency,
        // Shoplazza callback endpoints (you may or may not use these directly)
        cancel_url,
        complete_url, // Complete Payment API endpoint (sync)
        callback_url, // Notify Payment API endpoint (async)
        // Misc
        test,
      } = req.body || {};

      // Basic validation
      const missing = [];
      if (!paymentId) missing.push('id');
      if (!orderId) missing.push('shoplazza_order_id');
      if (!amount) missing.push('amount');
      if (!currency) missing.push('currency');
      if (!complete_url) missing.push('complete_url');
      if (!callback_url) missing.push('callback_url');

      if (missing.length) {
        return res.status(400).json({
          code: 'INVALID',
          message: 'Missing required fields: ' + missing.join(', '),
        });
      }

      const shop = normalizedShop(req);
      const idempotencyKey =
        header(req, 'x-request-id') || header(req, 'x-idempotency-key') || null;

      // Generate a per-session nonce to bind RG return/cancel to this row
      const nonce = crypto.randomBytes(12).toString('hex');

      // Persist a stub so callbacks can find the row later (idempotent upsert in your DAL)
      try {
        await createOrUpdatePayment({
          shop, // store domain (if available)
          shoplazza_payment_id: String(paymentId),
          order_id: String(orderId),
          amount: typeof amount === 'number' ? amount.toFixed(2) : String(amount),
          currency: String(currency).toUpperCase(),
          status: 'pending',
          idempotency_key: idempotencyKey,
          nonce,
        });
      } catch (e) {
        // Non-fatal for the redirect, but log loudly
        console.error('createOrUpdatePayment failed:', e);
      }

      // Keep a copy of the raw request in webhook_logs to aid debugging
      try {
        await db
          .insertInto('webhook_logs')
          .values({
            source: 'shoplazza',
            topic: 'payments/create',
            idempotency_key: idempotencyKey,
            headers: JSON.stringify(req.headers, null, 2),
            payload_json: JSON.stringify(req.body, null, 2),
          })
          .execute();
      } catch (e) {
        console.warn('webhook_logs insert failed:', e?.message || e);
      }

      // Build success/fail return URLs for RG → your app (carry correlation + Shoplazza endpoints)
      const base = process.env.APP_BASE_URL || 'http://localhost:3000';
      const success = new URL(`${base}/callbacks/complete-payment`);
      success.searchParams.set('orderId', String(orderId));
      success.searchParams.set('status', 'success');
      success.searchParams.set('spz_payment_id', String(paymentId));
      success.searchParams.set('spz_complete', String(complete_url));
      success.searchParams.set('spz_cancel', String(cancel_url || ''));
      success.searchParams.set('spz_callback', String(callback_url));
      if (typeof test !== 'undefined') success.searchParams.set('spz_test', String(test));
      if (shop) success.searchParams.set('shop', shop);
      success.searchParams.set('nonce', nonce);

      const fail = new URL(`${base}/callbacks/complete-payment`);
      fail.searchParams.set('orderId', String(orderId));
      fail.searchParams.set('status', 'fail');
      fail.searchParams.set('spz_payment_id', String(paymentId));
      fail.searchParams.set('spz_complete', String(complete_url));
      fail.searchParams.set('spz_cancel', String(cancel_url || ''));
      fail.searchParams.set('spz_callback', String(callback_url));
      if (typeof test !== 'undefined') fail.searchParams.set('spz_test', String(test));
      if (shop) fail.searchParams.set('shop', shop);
      fail.searchParams.set('nonce', nonce);

      // Build the RocketGate Hosted Page link
      const redirect_url = buildHostedPageUrl({
        id: String(paymentId), // reuse Shoplazza payment attempt id as RG "customer/account" id
        merch: process.env.ROCKETGATE_MERCHANT_ID,
        amount: typeof amount === 'number' ? amount.toFixed(2) : String(amount),
        hashSecret: process.env.ROCKETGATE_HASH_SECRET,
        extra: {
          invoice: String(orderId), // merchant invoice/order ref
          currency: String(currency).toUpperCase(),
          purchase: 'true',
          success: success.toString(),
          fail: fail.toString(),
          // (optionally) include additional RG-supported fields here from your HostedPage Fields.md
          // e.g., descriptor, email, address fields, etc., once the Shoplazza payload is mapped.
        },
      });

      // Per Shoplazza spec: return the URL; Shoplazza will redirect the buyer.
      // (Do NOT 302 the browser yourself from here.)
      return res.json({ redirect_url });
    } catch (err) {
      console.error('payments/session error:', err);
      return res.status(500).json({ code: 'SERVER_ERROR', message: 'Unhandled error' });
    }
  }
);

export default router;
