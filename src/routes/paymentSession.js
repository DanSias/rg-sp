// src/routes/paymentSession.js
import express, { Router } from 'express';

import { createOrUpdatePayment } from '../db/index.js';
import { getRgSettings } from '../db/rgSettings.js';
import { buildHostedPageUrl } from '../utils/rocketgate.js';
import { canonicalShopHost } from '../utils/shopHost.js';
import { maybeVerifyShoplazzaSignature } from '../utils/shoplazzaAuth.js';

const router = Router();

/**
 * POST /payments/session
 * This is your "Payment Session URL" configured in Shoplazza.
 * Body: application/x-www-form-urlencoded
 */
router.post(
  '/session',
  // Shoplazza posts urlencoded; req.rawBody is already captured in index.js for HMAC
  express.urlencoded({ extended: false }),
  maybeVerifyShoplazzaSignature, // honors app.locals.verifySignatures
  async (req, res, next) => {
    try {
      // Important: field names here are based on our earlier test payloads.
      // If Shoplazza sends different names, mirror the real ones here.
      const {
        id: paymentId, // required: Shoplazza payment attempt id
        shoplazza_order_id: orderId, // required: merchant order id
        amount, // required
        currency, // required
        cancel_url, // optional (nice to have)
        complete_url, // required: Shoplazza “Complete Payment” endpoint (sync)
        callback_url, // required: Shoplazza “Notify Payment” endpoint (async)
        test, // optional
        shop, // optional: if Shoplazza includes the shop host directly
      } = req.body || {};

      // Basic validation
      if (!paymentId || !orderId || !amount || !currency || !complete_url || !callback_url) {
        return res.status(400).json({ code: 'INVALID', message: 'Missing required fields' });
      }

      // Determine which shop this session is for:
      // 1) explicit `shop` param from payload
      // 2) hostname of complete_url (usually https://{shop}.myshoplaza.com/openapi/...)
      let shopHost = canonicalShopHost(shop);
      if (!shopHost && typeof complete_url === 'string') {
        try {
          const host = new URL(complete_url).hostname;
          shopHost = canonicalShopHost(host);
        } catch {
          // ignore URL parse error
        }
      }

      if (!shopHost) {
        return res.status(400).json({
          code: 'SHOP_UNDETERMINED',
          message: 'Unable to determine shop host from payload',
        });
      }

      // Load per-shop RocketGate settings from DB
      const settings = await getRgSettings(shopHost);
      if (!settings || !settings.merchantId || !settings.merchantKey) {
        return res.status(400).json({
          ok: false,
          code: 'RG_SETTINGS_MISSING',
          message:
            `RocketGate settings not configured for ${shopHost}. ` +
            `Please set Merchant ID/Key in the app first.`,
        });
      }

      // Persist a pending payment row for reconciliation later
      // (Adjust to your payments DAL shape if needed.)
      const normalizedAmount =
        typeof amount === 'number' ? amount.toFixed(2) : String(amount).trim();

      createOrUpdatePayment({
        orderId: String(orderId),
        paymentId: String(paymentId),
        customerId: String(paymentId), // we use the payment attempt id as a per-attempt "customer"
        amount: typeof amount === 'number' ? amount.toFixed(2) : String(amount),
        currency: String(currency).toUpperCase(),
        status: 'pending',
      });

      // Success/fail return URLs back to our app (Shoplazza continues via `complete_url`)
      const base = process.env.APP_BASE_URL || 'http://localhost:3000';

      const success = new URL(`${base}/callbacks/complete-payment`);
      success.searchParams.set('orderId', String(orderId));
      success.searchParams.set('status', 'success');
      success.searchParams.set('spz_payment_id', String(paymentId));
      success.searchParams.set('spz_complete', String(complete_url));
      if (cancel_url) success.searchParams.set('spz_cancel', String(cancel_url));
      success.searchParams.set('spz_callback', String(callback_url));
      success.searchParams.set('shop', shopHost);
      if (typeof test !== 'undefined') success.searchParams.set('spz_test', String(test));

      const fail = new URL(`${base}/callbacks/complete-payment`);
      fail.searchParams.set('orderId', String(orderId));
      fail.searchParams.set('status', 'fail');
      fail.searchParams.set('spz_payment_id', String(paymentId));
      fail.searchParams.set('spz_complete', String(complete_url));
      if (cancel_url) fail.searchParams.set('spz_cancel', String(cancel_url));
      fail.searchParams.set('spz_callback', String(callback_url));
      fail.searchParams.set('shop', shopHost);
      if (typeof test !== 'undefined') fail.searchParams.set('spz_test', String(test));

      // Build RocketGate Hosted Page URL using per-shop settings
      const redirect_url = buildHostedPageUrl({
        id: String(paymentId), // your "customer/account id" for RG (ok to reuse paymentId)
        merch: settings.merchantId, // per-shop Merchant ID
        amount: normalizedAmount,
        hashSecret: settings.merchantKey, // per-shop Merchant Key (used for RG signature)
        extra: {
          invoice: String(orderId),
          currency: String(currency).toUpperCase(),
          purchase: 'true',
          mode: settings.mode || 'test', // if your HP supports test vs live flags
          success: success.toString(),
          fail: fail.toString(),
          // TODO: add billing/shipping/email when Shoplazza gives them in create-payment
        },
      });

      // Shoplazza expects { redirect_url } and will 302 the buyer.
      return res.json({ redirect_url });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
