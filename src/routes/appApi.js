import { Router } from 'express';

import { getShop } from '../db/shops.js';
import { requireAppSession } from '../utils/appSession.js';

const router = Router();
router.use(requireAppSession);

// TODO: persist these per shop (new table). For now, stash in memory for speed.
const RG_SETTINGS = new Map(); // key: shop_domain -> { merchantId, merchantPassword, mode, returnUrl, cancelUrl }

router.post('/rg-settings', async (req, res, next) => {
  try {
    // Trust the session for the shop identity
    const shop = req.shopFromSession;
    const { merchantId, merchantPassword, mode, returnUrl, cancelUrl } = req.body || {};
    if (!shop) return res.status(400).json({ ok: false, error: 'Missing shop' });

    // sanity: ensure shop exists/installed
    const s = await getShop(shop);
    if (!s) return res.status(404).json({ ok: false, error: 'Unknown shop' });

    RG_SETTINGS.set(shop.toLowerCase(), {
      merchantId,
      merchantPassword,
      mode,
      returnUrl,
      cancelUrl,
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.post('/test-hosted-page', async (req, res, next) => {
  try {
    const shop = req.shopFromSession;
    const { amount, currency } = req.body || {};
    if (!shop) return res.status(400).json({ ok: false, error: 'Missing shop' });
    const s = await getShop(shop);
    if (!s) return res.status(404).json({ ok: false, error: 'Unknown shop' });

    const cfg = RG_SETTINGS.get(shop.toLowerCase());
    if (!cfg?.merchantId || !cfg?.merchantPassword) {
      return res
        .status(400)
        .json({ ok: false, error: 'Missing RocketGate credentials (save settings first).' });
    }

    // Build a simple Hosted Page URL placeholder (we'll wire exact fields next)
    const params = new URLSearchParams({
      merchant_id: cfg.merchantId,
      merchant_password: cfg.merchantPassword,
      amount: String(amount || '0.00'),
      currency: String(currency || 'USD'),
      mode: cfg.mode || 'test',
      return_url: cfg.returnUrl || '',
      cancel_url: cfg.cancelUrl || '',
    });
    // Replace with your real RG Hosted Page base from your docs/credentials
    const url = `${process.env.RG_HOSTEDPAGE_BASE || 'https://hosted.rocketgate.com/pay'}?${params}`;

    res.json({ ok: true, url });
  } catch (e) {
    next(e);
  }
});

export default router;
