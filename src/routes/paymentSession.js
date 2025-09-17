// src/routes/paymentSession.js
import express, { Router } from 'express';

import { createOrUpdatePayment } from '../db/index.js';
import { buildHostedPageUrl } from '../utils/rocketgate.js';
import { maybeVerifyShoplazzaSignature } from '../utils/shoplazzaAuth.js';

const router = Router();

// This route is configured as your "Payment Session URL" in Shoplazza.
// Shoplazza sends x-www-form-urlencoded, so add urlencoded middleware here.
router.post(
  '/session',
  express.urlencoded({ extended: false }),
  maybeVerifyShoplazzaSignature, // verifies Shoplazza-Hmac-Sha256 (keep env-driven)
  (req, res) => {
    const {
      id: paymentId, // Shoplazza payment attempt id
      shoplazza_order_id: orderId, // merchant order id
      amount,
      currency,
      cancel_url,
      complete_url, // Complete Payment API endpoint (sync)
      callback_url, // Notify Payment API endpoint (async)
      test,
    } = req.body || {};

    if (!paymentId || !orderId || !amount || !currency || !complete_url || !callback_url) {
      return res.status(400).json({ code: 'INVALID', message: 'Missing required fields' });
    }

    // Persist a stub so callbacks can find the row later
    createOrUpdatePayment({
      orderId,
      customerId: paymentId, // using paymentId as a unique per-attempt "customer" for RG
      amount: typeof amount === 'number' ? amount.toFixed(2) : String(amount),
      currency: String(currency).toUpperCase(),
      status: 'pending',
    });

    const base = process.env.PUBLIC_BASE_URL || 'http://localhost:3000';
    const success = new URL(`${base}/callbacks/complete-payment`);
    success.searchParams.set('orderId', orderId);
    success.searchParams.set('status', 'success');
    success.searchParams.set('spz_payment_id', paymentId);
    success.searchParams.set('spz_complete', complete_url);
    success.searchParams.set('spz_cancel', cancel_url);
    success.searchParams.set('spz_callback', callback_url);
    if (typeof test !== 'undefined') success.searchParams.set('spz_test', String(test));

    const fail = new URL(`${base}/callbacks/complete-payment`);
    fail.searchParams.set('orderId', orderId);
    fail.searchParams.set('status', 'fail');
    fail.searchParams.set('spz_payment_id', paymentId);
    fail.searchParams.set('spz_complete', complete_url);
    fail.searchParams.set('spz_cancel', cancel_url);
    fail.searchParams.set('spz_callback', callback_url);
    if (typeof test !== 'undefined') fail.searchParams.set('spz_test', String(test));

    // Build the RocketGate Hosted Page link
    const redirect_url = buildHostedPageUrl({
      id: paymentId, // OK to reuse paymentId; RG treats this as your customer/account id
      merch: process.env.ROCKETGATE_MERCHANT_ID,
      amount: typeof amount === 'number' ? amount.toFixed(2) : String(amount),
      hashSecret: process.env.ROCKETGATE_HASH_SECRET,
      extra: {
        invoice: orderId,
        currency: String(currency).toUpperCase(),
        purchase: 'true',
        success: success.toString(),
        fail: fail.toString(),
      },
    });

    // Per Shoplazza spec: return the URL; Shoplazza will 301 the buyer to it.
    // (Do NOT 302 the browser yourself from here.)
    return res.json({ redirect_url });
  }
);

export default router;
