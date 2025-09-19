// src/routes/appApi.js
import { Router, json, urlencoded } from 'express';

import { getRgSettings, upsertRgSettings } from '../db/rgSettings.js';
import { requireAppSession } from '../utils/appSession.js';
import { buildHostedPageUrl } from '../utils/rocketgate.js';

const router = Router();

// All app APIs require a verified embedded-app session
router.use(requireAppSession);

/**
 * GET /app-api/rg-settings
 * Load RocketGate settings for the current shop.
 * (merchantKey is masked in responses)
 */
router.get('/rg-settings', async (req, res, next) => {
  try {
    const shop = req.shopFromSession;
    const row = await getRgSettings(shop);
    res.json({
      ok: true,
      settings: row ? { ...row, merchantKey: row.merchantKey ? '********' : '' } : null,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /app-api/rg-settings
 * Upsert RocketGate settings for the current shop.
 * If merchantKey is an empty string or omitted, the existing key is preserved.
 */

router.post(
  '/rg-settings',
  // accept both JSON (fetch) and classic form posts
  urlencoded({ extended: false }),
  json(),
  async (req, res, next) => {
    try {
      const shop = req.shopFromSession;
      const body = req.body || {};

      // Support either field name:
      //  - merchantKey (from fetch JSON)
      //  - merchantPassword (from your current HTML form)
      const rawKey =
        typeof body.merchantKey === 'string'
          ? body.merchantKey
          : typeof body.merchantPassword === 'string'
            ? body.merchantPassword
            : undefined;

      const merchantKey = rawKey && rawKey.trim().length > 0 ? rawKey.trim() : undefined;

      const saved = await upsertRgSettings({
        shop,
        merchantId: body.merchantId,
        merchantKey, // undefined → keep current
        mode: body.mode,
        returnUrl: body.returnUrl,
        cancelUrl: body.cancelUrl,
      });

      // If this was a classic form POST, redirect back to app.html (PRG pattern)
      if (req.headers['content-type']?.includes('application/x-www-form-urlencoded')) {
        const u = new URL('/app.html', `${req.protocol}://${req.get('host')}`);
        u.searchParams.set('shop', shop);
        return res.redirect(303, u.toString());
      }

      // JSON clients get a JSON response
      res.json({
        ok: true,
        saved: { ...saved, merchantKey: saved.merchantKey ? '********' : '' },
      });
    } catch (e) {
      next(e);
    }
  }
);

/**
 * POST /app-api/test-hosted-page
 * Quick smoke test: build a RocketGate HostedPage URL using saved RG settings.
 * Accepts JSON or form data: { amount, currency }
 */
router.post(
  '/test-hosted-page',
  json(),
  urlencoded({ extended: false }),
  async (req, res, next) => {
    try {
      const shop = req.shopFromSession;
      const { amount, currency } = req.body || {};

      const rg = await getRgSettings(shop);
      if (!rg?.merchantId || !rg?.merchantKey) {
        return res.status(412).json({
          ok: false,
          code: 'RG_SETTINGS_MISSING',
          error: 'Missing RocketGate credentials. Save settings first.',
        });
      }

      const amt = typeof amount === 'number' ? amount.toFixed(2) : String(amount || '0.00');
      const cur = String(currency || 'USD').toUpperCase();

      // Build success/fail URLs pointing back to this app (simple placeholders for now)
      const base = process.env.APP_BASE_URL || 'http://localhost:3000';
      const success = new URL(`${base}/callbacks/complete-payment`);
      success.searchParams.set('shop', shop);
      success.searchParams.set('status', 'success');
      const fail = new URL(`${base}/callbacks/complete-payment`);
      fail.searchParams.set('shop', shop);
      fail.searchParams.set('status', 'fail');

      // Build the RocketGate Hosted Page URL with saved creds
      const url = buildHostedPageUrl({
        id: `test-${Date.now()}`, // demo id for a test link
        merch: rg.merchantId,
        amount: amt,
        hashSecret: rg.merchantKey,
        extra: {
          currency: cur,
          purchase: 'true',
          success: success.toString(),
          fail: fail.toString(),
          // optionally: rg.returnUrl / rg.cancelUrl if your RG config requires fixed URLs
        },
      });

      return res.json({ ok: true, url });
    } catch (e) {
      next(e);
    }
  }
);

/**
 * GET /app-api/whoami
 * Tiny debug endpoint to confirm session binding.
 */
router.get('/whoami', (req, res) => {
  res.json({
    ok: true,
    shop: req.shopFromSession,
    storeId: req.storeIdFromSession ?? null,
  });
});

export default router;
