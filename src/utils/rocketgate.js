// src/utils/rocketgate.js
import crypto from 'crypto';

/**
 * Utility: parse boolean-like env values safely.
 */
function parseBool(v, def = false) {
  if (v == null) return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

/**
 * Resolve the Hosted Page base URL from env with safe fallbacks.
 * Priority:
 *  1) ROCKETGATE_HOSTED_BASE_URL [+ optional ROCKETGATE_HOSTED_PATH]
 *  2) ROCKETGATE_ENV: 'prod-secure'/'production' => prod; else dev
 */
function getHostedPageBase() {
  const baseFromEnv = process.env.ROCKETGATE_HOSTED_BASE_URL;
  const pathFromEnv = process.env.ROCKETGATE_HOSTED_PATH;

  if (baseFromEnv) {
    const base = baseFromEnv.replace(/\/+$/, '');
    const path = pathFromEnv ? `/${pathFromEnv.replace(/^\/+/, '')}` : '';
    return `${base}${path}`;
  }

  const env = (process.env.ROCKETGATE_ENV || 'dev-secure').toLowerCase();
  const isProd = env === 'prod-secure' || env === 'production' || env === 'prod';

  // Your original defaults, preserved:
  return isProd
    ? 'https://secure.rocketgate.com/hostedpage/servlet/HostedPagePurchase'
    : 'https://dev-secure.rocketgate.com/hostedpage/servlet/HostedPagePurchase';
}

/**
 * Optionally assert that the generated URL host matches ROCKETGATE_EXPECTED_HOST.
 * Set ROCKETGATE_ENFORCE_EXPECTED_HOST=true to throw on mismatch.
 */
function maybeAssertExpectedHost(fullUrl) {
  const expected = process.env.ROCKETGATE_EXPECTED_HOST;
  const enforce = parseBool(process.env.ROCKETGATE_ENFORCE_EXPECTED_HOST, false);
  if (!expected) return;

  try {
    const { host } = new URL(fullUrl);
    if (host !== expected && enforce) {
      throw new Error(
        `Hosted Page host mismatch: expected "${expected}" but built "${host}". ` +
          `Check ROCKETGATE_* env config.`
      );
    }
  } catch {
    // If URL parsing fails, let the caller handle the final URL anyway.
  }
}

/**
 * Build the canonical string for HMAC signing.
 * We preserve your original signed fields and order (id, merch, amount, purchase, time)
 * to match RocketGate expectations. If RG later changes signing rules, update this in one place.
 */
function canonicalStringToHash(signedParams) {
  const SIGNED_ORDER = ['id', 'merch', 'amount', 'purchase', 'time'];
  return SIGNED_ORDER.map((k) => `${k}=${signedParams[k]}`).join('&');
}

/**
 * Compute HMAC-SHA256 digest over the canonical string.
 * Encoding defaults to base64 (matches your original code). You can override via env:
 *  ROCKETGATE_HASH_ENCODING=base64|hex
 */
function hmacSHA256(message, secret) {
  const encoding = (process.env.ROCKETGATE_HASH_ENCODING || 'base64').toLowerCase();
  return crypto.createHmac('sha256', secret).update(message, 'utf8').digest(encoding);
}

/**
 * PRIMARY API (kept compatible with your existing usage)
 *
 * Returns a RocketGate Hosted Page redirect URL string.
 *
 * @param {Object} options
 * @param {string} options.id           - Customer ID
 * @param {string} [options.merch]      - Merchant ID (falls back to env ROCKETGATE_MERCHANT_ID)
 * @param {string|number} options.amount- Amount (pass minor units or your chosen format as RG expects)
 * @param {string} [options.hashSecret] - HMAC secret (falls back to env ROCKETGATE_HASH_SECRET)
 * @param {Object} [options.extra]      - Extra query params (invoice, currency, success, fail, etc.)
 *
 * Example:
 *   buildHostedPageUrl({
 *     id: 'CUST-123',
 *     merch: process.env.ROCKETGATE_MERCHANT_ID,
 *     amount: '1299',
 *     hashSecret: process.env.ROCKETGATE_HASH_SECRET,
 *     extra: {
 *       invoice: 'ORD-999',
 *       currency: 'USD',
 *       success: 'https://app.example.com/callbacks/complete-payment?orderId=ORD-999&result=success',
 *       fail: 'https://app.example.com/callbacks/complete-payment?orderId=ORD-999&result=fail'
 *     }
 *   })
 */
export function buildHostedPageUrl({ id, merch, amount, hashSecret, extra = {} }) {
  const resolvedMerch = merch ?? process.env.ROCKETGATE_MERCHANT_ID;
  const resolvedSecret = hashSecret ?? process.env.ROCKETGATE_HASH_SECRET;
  if (!resolvedMerch) throw new Error('RocketGate merchant id (merch) missing.');
  if (!resolvedSecret) throw new Error('RocketGate hash secret missing.');

  const base = getHostedPageBase();
  const nowSeconds = Math.floor(Date.now() / 1000);

  // Keep your original signed set + order
  const signedParams = {
    id,
    merch: resolvedMerch,
    amount: String(amount),
    purchase: 'true',
    time: nowSeconds,
  };

  const params = new URLSearchParams({
    ...signedParams,
    ...extra, // invoice, currency, success, fail, descriptor, etc.
  });

  const stringToHash = canonicalStringToHash(signedParams);
  const hash = hmacSHA256(stringToHash, resolvedSecret);
  params.append('hash', hash);

  const fullUrl = `${base}?${params.toString()}`;
  maybeAssertExpectedHost(fullUrl);
  return fullUrl;
}

/**
 * OPTIONAL: Structured variant that returns useful metadata for logging/tests.
 * Same inputs as buildHostedPageUrl, but returns { redirectUrl, signedParams, hash, base, env }.
 */
export function buildHostedPageUrlDetailed({ id, merch, amount, hashSecret, extra = {} }) {
  const resolvedMerch = merch ?? process.env.ROCKETGATE_MERCHANT_ID;
  const resolvedSecret = hashSecret ?? process.env.ROCKETGATE_HASH_SECRET;
  if (!resolvedMerch) throw new Error('RocketGate merchant id (merch) missing.');
  if (!resolvedSecret) throw new Error('RocketGate hash secret missing.');

  const base = getHostedPageBase();
  const env = process.env.ROCKETGATE_ENV || 'dev-secure';
  const nowSeconds = Math.floor(Date.now() / 1000);

  const signedParams = {
    id,
    merch: resolvedMerch,
    amount: String(amount),
    purchase: 'true',
    time: nowSeconds,
  };

  const params = new URLSearchParams({
    ...signedParams,
    ...extra,
  });

  const stringToHash = canonicalStringToHash(signedParams);
  const hash = hmacSHA256(stringToHash, resolvedSecret);
  params.append('hash', hash);

  const redirectUrl = `${base}?${params.toString()}`;
  maybeAssertExpectedHost(redirectUrl);
  return { redirectUrl, signedParams, hash, base, env };
}

/**
 * OPTIONAL: Verify a Hosted Page hash if you ever need to recompute it for testing.
 * Provide the same 5 signed fields and the secret.
 */
export function verifyHostedPageHash(
  { id, merch, amount, purchase = 'true', time },
  hashSecret,
  providedHash
) {
  const message = canonicalStringToHash({
    id,
    merch,
    amount: String(amount),
    purchase: String(purchase),
    time: Number(time),
  });
  const computed = hmacSHA256(message, hashSecret);
  // Constant-time compare
  return (
    typeof providedHash === 'string' &&
    providedHash.length === computed.length &&
    crypto.timingSafeEqual(Buffer.from(providedHash), Buffer.from(computed))
  );
}

/**
 * OPTIONAL: Placeholder for a server-to-server confirm by invoice/orderId.
 * Wire this up to RocketGate's Transaction/History API if/when you add reconciliation.
 */
export async function confirmWithServerByInvoice(/* invoice */) {
  // Implement with fetch/axios against process.env.ROCKETGATE_API_BASE_URL
  // Return a normalized shape: { status, rocketgateTxnId, raw }
  return null;
}
