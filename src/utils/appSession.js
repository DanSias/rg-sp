// src/utils/appSession.js
import crypto from 'node:crypto';

const COOKIE_NAME = 'rg_app_session';

function b64u(s) {
  return Buffer.from(s, 'utf8').toString('base64url');
}
function ub64u(s) {
  return Buffer.from(s, 'base64url').toString('utf8');
}
function sign(base64Payload, secret) {
  return crypto.createHmac('sha256', secret).update(base64Payload).digest('hex');
}

export function issueAppSession(res, { shop, storeId }, opts = {}) {
  const ttlMin = Number(process.env.SESSION_TTL_MINUTES || 20);
  const exp = Date.now() + ttlMin * 60 * 1000;
  const payload = JSON.stringify({ shop, storeId: storeId ?? null, exp });
  const b = b64u(payload);
  const sig = sign(b, process.env.APP_SESSION_SECRET || 'dev-secret');
  const value = `${b}.${sig}`;

  res.cookie(COOKIE_NAME, value, {
    httpOnly: true,
    secure: true, // required for SameSite=None on HTTPS
    sameSite: 'none',
    maxAge: ttlMin * 60 * 1000,
    path: '/',
  });
}

export function readAppSession(req) {
  const value = req.cookies?.[COOKIE_NAME];
  if (!value) return null;
  const [b, sig] = String(value).split('.');
  if (!b || !sig) return null;

  const expected = sign(b, process.env.APP_SESSION_SECRET || 'dev-secret');
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;

  let payload = null;
  try {
    payload = JSON.parse(ub64u(b));
  } catch {
    return null;
  }
  if (!payload?.shop || !payload?.exp || Date.now() > payload.exp) return null;
  return payload; // { shop, storeId, exp }
}

/** Middleware: require a valid app session for API routes */
export function requireAppSession(req, res, next) {
  if (String(process.env.REQUIRE_APP_SESSION || 'true').toLowerCase() !== 'true') return next();

  const sess = readAppSession(req);
  if (sess?.shop) {
    req.shopFromSession = sess.shop;
    req.storeIdFromSession = sess.storeId ?? null;
    return next();
  }
  return res.status(401).json({ ok: false, error: 'no_session' });
}
