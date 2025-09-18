// src/utils/shoplazzaAuth.js
import crypto from 'crypto';

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(a || '', 'utf8');
  const bb = Buffer.from(b || '', 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function verifyShoplazzaSignature(req) {
  const {
    SHOPLAZZA_WEBHOOK_SECRET,
    SHOPLAZZA_SIGNATURE_HEADER = 'X-Shoplazza-Signature',
    SHOPLAZZA_TIMESTAMP_HEADER = 'X-Shoplazza-Timestamp',
    SHOPLAZZA_SIGNATURE_ENCODING = 'base64',
    SHOPLAZZA_TS_TOLERANCE_SECONDS = '300',
  } = process.env;

  if (!SHOPLAZZA_WEBHOOK_SECRET) throw new Error('Missing SHOPLAZZA_WEBHOOK_SECRET');

  const sigHeader = req.header(SHOPLAZZA_SIGNATURE_HEADER) || '';
  const tsHeader = req.header(SHOPLAZZA_TIMESTAMP_HEADER) || '';

  // Optional replay protection
  if (tsHeader) {
    const tolerance = Number(SHOPLAZZA_TS_TOLERANCE_SECONDS);
    const delta = Math.abs(Math.floor(Date.now() / 1000) - Number(tsHeader));
    if (!Number.isFinite(delta) || delta > tolerance) return false;
  }

  const raw = req.rawBody ?? Buffer.from('');
  const digest = crypto
    .createHmac('sha256', SHOPLAZZA_WEBHOOK_SECRET)
    .update(raw)
    .digest(SHOPLAZZA_SIGNATURE_ENCODING);

  return timingSafeEqualStr(digest, sigHeader);
}

export function maybeVerifyShoplazzaSignature(req, res, next) {
  // Prefer runtime flag set by tests; fallback to env
  const runtimeFlag = req.app?.locals?.verifySignatures;
  const envFlag =
    String(process.env.VERIFY_SHOPLAZZA_SIGNATURE || 'false').toLowerCase() === 'true';
  const on = runtimeFlag ?? envFlag;

  if (!on) return next();

  try {
    if (!verifyShoplazzaSignature(req)) {
      return res.status(401).json({ error: { code: 'INVALID_SIGNATURE' } });
    }
    return next();
  } catch (err) {
    return res
      .status(500)
      .json({ error: { code: 'SIGNATURE_VERIFY_ERROR', message: err.message } });
  }
}

/**
 * Verify Shoplazza embedded-launch HMAC on the query string.
 * - Expects `hmac` param (hex) and sorts the remaining keys lexicographically.
 * - Compares in constant time.
 */
export function verifyLaunchHmac(query, clientSecret) {
  if (!query || !clientSecret) return { ok: false, reason: 'missing' };

  const provided = String(query.hmac || '');
  if (!provided) return { ok: false, reason: 'no_hmac' };

  // Build canonical string: key=value joined by '&', excluding 'hmac'
  const pairs = Object.keys(query)
    .filter((k) => k !== 'hmac')
    .sort()
    .map((k) => {
      const v = query[k];
      const val = Array.isArray(v) ? v.join(',') : String(v);
      return `${k}=${val}`;
    })
    .join('&');

  const calc = crypto.createHmac('sha256', clientSecret).update(pairs).digest('hex');

  const A = Buffer.from(calc, 'utf8');
  const B = Buffer.from(provided.toLowerCase(), 'utf8');
  const ok = A.length === B.length && crypto.timingSafeEqual(A, B);
  return ok ? { ok: true } : { ok: false, reason: 'mismatch' };
}

export function verifyShoplazzaHmac(query, clientSecret) {
  if (!query.hmac) return false;

  const { hmac, ...rest } = query;
  const sorted = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join('&');

  const digest = crypto.createHmac('sha256', clientSecret).update(sorted).digest('hex');

  return digest === hmac;
}
