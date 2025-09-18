// src/routes/appProxy.js
import crypto from 'node:crypto';

import { Router } from 'express';

import { getPayment, createOrUpdatePayment } from '../db/index.js';
import { buildHostedPageUrl } from '../utils/rocketgate.js';

const router = Router();

/**
 * Verify App Proxy signature:
 * - Remove "signature" from query
 * - Sort remaining query keys, URL-encode as k=v joined by &
 * - HMAC-SHA256 with SHOPLAZZA_PROXY_SHARED_SECRET (hex)
 * - Compare timing-safe
 */
function verifyProxySignature(req, res, next) {
  const shared = process.env.SHOPLAZZA_PROXY_SHARED_SECRET;
  if (!shared) return res.status(500).json({ error: 'Missing SHOPLAZZA_PROXY_SHARED_SECRET' });

  const { signature, ...rest } = req.query || {};
  if (!signature) return res.status(401).json({ error: 'Missing signature' });

  const entries = Object.entries(rest).map(([k, v]) => [
    k,
    Array.isArray(v) ? v.join(',') : String(v),
  ]);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const msg = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const h = crypto.createHmac('sha256', shared).update(msg).digest('hex');
  const ok = crypto.timingSafeEqual(Buffer.from(h), Buffer.from(String(signature)));
  if (!ok) return res.status(401).json({ error: 'Invalid signature' });

  return next();
}

/**
 * GET /app-proxy/init
 *
 * This endpoint is intended to be called via Shoplazza App Proxy from the storefront.
 * Query params (minimal):
 *   - orderId   (string, required)
 *   - amount    (string/number, required)
 *   - currency  (string, required, e.g. "USD")
 *   - customerId (string, required)
 *
 * Behavior:
 *   - Idempotent upsert of a pending payment row
 *   - Build RocketGate Hosted Page URL with success/fail return links
 *   - 302 redirect the buyer to RocketGate
 *
 * NOTE: In production, validate the App Proxy signature on the querystring.
 * Shoplazza App Proxy forwards signed requests; add a verifier once you have the proxy secret.
 */
router.get('/init', verifyProxySignature, (req, res) => {
  const { orderId, amount, currency, customerId } = req.query;

  if (!orderId || !amount || !currency || !customerId) {
    return res.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Missing orderId, amount, currency, or customerId',
      },
    });
  }

  const normalizedAmount = typeof amount === 'number' ? amount.toFixed(2) : String(amount);
  const normalizedCurrency = String(currency).toUpperCase();

  // Idempotent base record
  const existing = getPayment(orderId);
  if (existing) {
    // conflict if caller tries to change core fields
    const conflicts = [];
    if (existing.amount && existing.amount !== normalizedAmount)
      conflicts.push({ field: 'amount' });
    if (existing.currency && existing.currency !== normalizedCurrency)
      conflicts.push({ field: 'currency' });
    if (existing.customer_id && existing.customer_id !== String(customerId))
      conflicts.push({ field: 'customerId' });

    if (conflicts.length > 0) {
      return res.status(409).json({
        error: {
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'Order already initialized with different parameters',
          conflicts,
        },
      });
    }

    // backfill missing base fields (don’t clobber existing)
    if (!existing.amount || !existing.currency || !existing.customer_id) {
      createOrUpdatePayment({
        orderId,
        customerId: existing.customer_id ?? String(customerId),
        amount: existing.amount ?? normalizedAmount,
        currency: existing.currency ?? normalizedCurrency,
        status: existing.status ?? 'pending',
      });
    }
  } else {
    createOrUpdatePayment({
      orderId,
      customerId: String(customerId),
      amount: normalizedAmount,
      currency: normalizedCurrency,
      status: 'pending',
    });
  }

  // Build return URLs and Hosted Page URL
  const host = process.env.APP_BASE_URL || 'http://localhost:3000';
  const success = `${host}/callbacks/complete-payment?orderId=${encodeURIComponent(orderId)}&status=success`;
  const fail = `${host}/callbacks/complete-payment?orderId=${encodeURIComponent(orderId)}&status=fail`;

  const { ROCKETGATE_MERCHANT_ID, ROCKETGATE_HASH_SECRET } = process.env;
  const hostedUrl = buildHostedPageUrl({
    id: String(customerId),
    merch: ROCKETGATE_MERCHANT_ID,
    amount: normalizedAmount,
    hashSecret: ROCKETGATE_HASH_SECRET,
    extra: { invoice: orderId, currency: normalizedCurrency, success, fail },
  });

  // 302 redirect the buyer to RocketGate Hosted Page
  return res.redirect(302, hostedUrl);
});

export default router;
