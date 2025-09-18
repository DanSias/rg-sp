// src/routes/appLaunch.js
import { Router } from 'express';

import { issueAppSession } from '../utils/appSession.js';
import { verifyLaunchHmac } from '../utils/shoplazzaAuth.js';

const router = Router();

/**
 * GET /app-start?hmac=...&shop=...&store_id=...&install_from=admin
 * - Verifies the embedded-launch HMAC
 * - Issues a short-lived session cookie
 * - Redirects to /app.html?shop=...&store_id=... (HMAC stripped)
 */
router.get('/', (req, res) => {
  const verifyFlag = String(process.env.VERIFY_EMBED_HMAC || 'true').toLowerCase() === 'true';
  if (verifyFlag) {
    const result = verifyLaunchHmac(req.query, process.env.SHOPLAZZA_CLIENT_SECRET || '');
    if (!result.ok) {
      return res
        .status(401)
        .send(`<h1>Unauthorized</h1><p>Launch HMAC ${result.reason || 'invalid'}</p>`);
    }
  }

  const shop = String(req.query.shop || '').toLowerCase();
  const store_id = req.query.store_id ? String(req.query.store_id) : null;

  issueAppSession(res, { shop, storeId: store_id });

  // Build clean redirect without hmac to avoid leaking it around
  const q = new URLSearchParams();
  if (shop) q.set('shop', shop);
  if (store_id) q.set('store_id', store_id);
  return res.redirect(302, `/app.html?${q.toString()}`);
});

export default router;
