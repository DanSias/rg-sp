// src/routes/pay.js
import { Router } from 'express';

import { getPayment, createOrUpdatePayment } from '../db/index.js';
import { buildHostedPageUrl } from '../utils/rocketgate.js';

const router = Router();

/**
 * Normalize a major-unit amount (e.g., "12.99") to a strict 2-decimal string.
 */
function normalizeMajorAmountStr(v) {
  if (v == null) return null;
  // Accept number or string; strip commas/spaces, then parse
  const s = String(v).replace(/[, ]+/g, '');
  const num = Number(s);
  if (!Number.isFinite(num)) return null;
  // Always two decimals (RocketGate hosted page typically expects major units)
  return num.toFixed(2);
}

/**
 * Build absolute callback URLs from PUBLIC_BASE_URL (defensive: trim trailing slash).
 */
function buildReturnUrls(orderId) {
  const base =
    (process.env.PUBLIC_BASE_URL && process.env.PUBLIC_BASE_URL.replace(/\/+$/, '')) ||
    `http://localhost:${process.env.PORT || 3000}`;

  // Use "result" to match the callbacks implementation we outlined
  const success = `${base}/callbacks/complete-payment?orderId=${encodeURIComponent(
    orderId
  )}&result=success`;
  const fail = `${base}/callbacks/complete-payment?orderId=${encodeURIComponent(
    orderId
  )}&result=fail`;

  return { success, fail };
}

/**
 * Idempotent initializer for a payment session.
 * - Creates the DB row if it doesn't exist (status: initiated)
 * - If it exists with the same base fields, returns a fresh Hosted Page URL
 * - If it exists with conflicting fields, returns 409 Conflict
 *
 * Accepted body:
 *   {
 *     orderId: string,
 *     currency: string,               // e.g., "USD"
 *     amountMinor?: number,           // preferred: integer cents (e.g., 1299)
 *     amount?: number|string,         // fallback: major units (e.g., 12.99)
 *     customer: { id: string }
 *   }
 */
router.post('/init', (req, res) => {
  try {
    const { ROCKETGATE_MERCHANT_ID, ROCKETGATE_HASH_SECRET } = process.env;
    if (!ROCKETGATE_MERCHANT_ID || !ROCKETGATE_HASH_SECRET) {
      return res.status(500).json({
        error: {
          code: 'MISCONFIGURED_ENV',
          message:
            'RocketGate merchant credentials not configured. Set ROCKETGATE_MERCHANT_ID and ROCKETGATE_HASH_SECRET.',
        },
      });
    }

    const { orderId, amountMinor, amount, currency, customer } = req.body || {};

    // Basic validation
    if (!orderId || !currency || !customer?.id) {
      return res.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Missing orderId, currency, or customer.id',
        },
      });
    }

    // Amount normalization (prefer minor units if provided)
    let normalizedAmountMajor; // string like "12.99"
    if (Number.isInteger(amountMinor)) {
      normalizedAmountMajor = (amountMinor / 100).toFixed(2);
    } else {
      normalizedAmountMajor = normalizeMajorAmountStr(amount);
    }

    if (!normalizedAmountMajor) {
      return res.status(400).json({
        error: {
          code: 'INVALID_AMOUNT',
          message: 'Provide amountMinor (integer cents) or amount (major units).',
        },
      });
    }

    const normalizedCurrency = String(currency).trim().toUpperCase();
    if (normalizedCurrency.length !== 3) {
      return res.status(400).json({
        error: { code: 'INVALID_CURRENCY', message: 'Currency must be a 3-letter code.' },
      });
    }

    const customerId = String(customer.id);

    // Idempotency check
    const existing = getPayment(orderId); // your db helper; typically returns row or undefined

    if (existing) {
      const existingAmountMajor = normalizeMajorAmountStr(existing.amount ?? null);
      const conflicts = [];

      if (existingAmountMajor && existingAmountMajor !== normalizedAmountMajor) {
        conflicts.push({
          field: 'amount',
          existing: existingAmountMajor,
          requested: normalizedAmountMajor,
        });
      }
      if (existing.currency && existing.currency !== normalizedCurrency) {
        conflicts.push({
          field: 'currency',
          existing: existing.currency,
          requested: normalizedCurrency,
        });
      }
      if (existing.customer_id && existing.customer_id !== customerId) {
        conflicts.push({
          field: 'customer.id',
          existing: existing.customer_id,
          requested: customerId,
        });
      }

      if (conflicts.length > 0) {
        return res.status(409).json({
          error: {
            code: 'IDEMPOTENCY_CONFLICT',
            message: 'Order already initialized with different parameters',
            conflicts,
          },
        });
      }

      // Backfill any missing base fields without changing existing values
      if (!existing.amount || !existing.currency || !existing.customer_id || !existing.status) {
        createOrUpdatePayment({
          orderId,
          customerId: existing.customer_id ?? customerId,
          amount: existing.amount ?? normalizedAmountMajor,
          currency: existing.currency ?? normalizedCurrency,
          status: existing.status ?? 'initiated',
        });
      }
    } else {
      // Fresh insert
      createOrUpdatePayment({
        orderId,
        customerId,
        amount: normalizedAmountMajor, // store major units string to match current schema/usage
        currency: normalizedCurrency,
        status: 'initiated',
      });
    }

    // Build buyer return URLs
    const { success, fail } = buildReturnUrls(orderId);

    // Construct Hosted Page URL with signed params
    const redirectUrl = buildHostedPageUrl({
      id: customerId,
      merch: ROCKETGATE_MERCHANT_ID,
      amount: normalizedAmountMajor, // RocketGate Hosted Page usually expects major units
      hashSecret: ROCKETGATE_HASH_SECRET,
      extra: {
        invoice: orderId,
        currency: normalizedCurrency,
        success,
        fail,
      },
    });

    // Keep response lean and useful for the client
    return res.status(200).json({
      paymentSessionId: `ps_${Date.now()}`, // if you later want real session ids, swap this
      redirectUrl,
      // Buyer typically has ~15 minutes to complete the hosted page; adjust as needed.
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });
  } catch (err) {
    // Prefer structured errors but avoid leaking internals
    req.log?.error?.(err);
    return res.status(502).json({
      error: { code: 'INIT_FAILED', message: 'Failed to initialize RocketGate Hosted Page.' },
    });
  }
});

export default router;
