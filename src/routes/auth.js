// src/routes/auth.js
import crypto from 'node:crypto';

import { Router } from 'express';

import { upsertShop } from '../db/shops.js';

const router = Router();

/**
 * DEV-ONLY: In-memory OAuth state store.
 * We record {state -> { shop, ts }} so callback can validate even if cookies are blocked.
 * Swap for a DB/kv store later if needed.
 */
const OAUTH_STATES = new Map();

/**
 * GET /auth/start
 * Initiates OAuth. Accepts ?shop=<shop-domain> (e.g., rg-demo.myshoplaza.com).
 * - Validates shop shape
 * - Generates a CSRF 'state'
 * - Stores state both server-side and in a cookie
 * - Redirects to the store's own authorize URL
 */
router.get('/start', (req, res) => {
  const { SHOPLAZZA_CLIENT_ID, SHOPLAZZA_REDIRECT_URL, SHOPLAZZA_SCOPES } = process.env;

  const { shop } = req.query || {};

  if (!SHOPLAZZA_CLIENT_ID || !SHOPLAZZA_REDIRECT_URL) {
    return res.status(500).send('Missing required OAuth env (client_id / redirect_url)');
  }

  // Basic guard that shop looks like "*.myshoplaza.com"
  if (!shop || !/^[a-z0-9-]+\.myshoplaza\.com$/i.test(String(shop))) {
    return res.status(400).send('Invalid ?shop; expected something like store123.myshoplaza.com');
  }

  // Generate state and store in memory (for embedded contexts)
  const state = crypto.randomUUID();
  OAUTH_STATES.set(state, { shop, ts: Date.now() });

  // Also set a cookie (works in top-level flows; may be blocked in iframes)
  res.cookie('oauth_state', JSON.stringify({ state, shop }), {
    httpOnly: true,
    secure: true, // required when SameSite=None
    sameSite: 'none', // allow third-party/embedded contexts
    maxAge: 10 * 60 * 1000,
  });

  // Build the store-specific authorize URL
  const u = new URL(`https://${shop}/admin/oauth/authorize`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', SHOPLAZZA_CLIENT_ID);
  u.searchParams.set('redirect_uri', SHOPLAZZA_REDIRECT_URL);
  if (SHOPLAZZA_SCOPES) u.searchParams.set('scope', SHOPLAZZA_SCOPES); // space-separated scopes
  u.searchParams.set('state', state);
  u.searchParams.set('shop', String(shop)); // parity with docs

  return res.redirect(302, u.toString());
});

/**
 * GET /auth/callback
 * OAuth callback route
 * Exchanges code -> access_token and stores it with the shop identifier.
 * Also auto-registers webhooks for the shop.
 */
router.get('/callback', async (req, res) => {
  try {
    const { code, state, error, shop } = req.query || {};
    if (error) {
      return res.status(400).send(`<h1>Auth error</h1><p>${String(error)}</p>`);
    }

    // Validate shop format first
    if (!shop || !/^[a-z0-9-]+\.myshoplaza\.com$/i.test(String(shop))) {
      return res.status(400).send('<h1>Auth failed</h1><p>Invalid or missing shop.</p>');
    }
    if (!state) {
      return res.status(400).send('<h1>Auth failed</h1><p>Missing state.</p>');
    }

    // Prefer server-side state (works even if cookie is blocked in embedded context)
    const serverState = OAUTH_STATES.get(state);
    if (serverState && serverState.shop === shop) {
      OAUTH_STATES.delete(state); // one-time use
    } else {
      // Fallback: cookie-based validation if it arrived
      let bundle = null;
      try {
        bundle = req.cookies?.oauth_state ? JSON.parse(req.cookies.oauth_state) : null;
      } catch {
        // ignore cookie parse errors
      }
      if (!bundle?.state || !bundle?.shop || state !== bundle.state || shop !== bundle.shop) {
        return res.status(400).send('<h1>Auth failed</h1><p>Invalid or missing state/shop.</p>');
      }
      res.clearCookie('oauth_state');
    }

    const needed = [
      'SHOPLAZZA_CLIENT_ID',
      'SHOPLAZZA_CLIENT_SECRET',
      'SHOPLAZZA_REDIRECT_URL',
      'SHOPLAZZA_OAUTH_TOKEN_URL',
    ];
    const missing = needed.filter((k) => !process.env[k] || String(process.env[k]).trim() === '');
    if (missing.length) {
      console.error('❌ Missing OAuth env:', missing);
      return res.status(500).send('Missing token env: ' + missing.join(', '));
    }

    // Env vars needed for token exchange
    const {
      SHOPLAZZA_CLIENT_ID,
      SHOPLAZZA_CLIENT_SECRET,
      SHOPLAZZA_REDIRECT_URL,
      SHOPLAZZA_OAUTH_TOKEN_URL,
    } = process.env;

    if (
      !SHOPLAZZA_CLIENT_ID ||
      !SHOPLAZZA_CLIENT_SECRET ||
      !SHOPLAZZA_REDIRECT_URL ||
      !SHOPLAZZA_OAUTH_TOKEN_URL
    ) {
      return res.status(500).send('Missing token env');
    }

    // Exchange authorization code -> access token
    const tokenUrl = `https://${shop}/admin/oauth/token`; // per-store endpoint

    const tokenResp = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: String(code),
        client_id: SHOPLAZZA_CLIENT_ID,
        client_secret: SHOPLAZZA_CLIENT_SECRET,
        redirect_uri: SHOPLAZZA_REDIRECT_URL,
      }),
    });

    if (!tokenResp.ok) {
      const text = await tokenResp.text();
      return res.status(502).send(`<h1>Token exchange failed</h1><pre>${text}</pre>`);
    }

    const tokenJson = await tokenResp.json();
    const accessToken = tokenJson.access_token;
    const scope = tokenJson.scope ?? null;

    if (!accessToken) {
      return res
        .status(502)
        .send(`<h1>Token exchange failed</h1><pre>${JSON.stringify(tokenJson, null, 2)}</pre>`);
    }

    // Persist shop credentials (dev: in-memory; later: DB)
    upsertShop({ shop: String(shop), accessToken, scope });

    // Best-effort: register webhooks for this shop
    await registerWebhooksForShop({ shop: String(shop), accessToken });

    // Clear cookie (safe even if already cleared above)
    res.clearCookie('oauth_state');

    // Success page
    return res.status(200).send(
      `<h1>Shop connected</h1>
       <p>Shop: <strong>${shop}</strong></p>
       <p>Scopes: <code>${scope ?? 'n/a'}</code></p>
       <p>Webhooks registered.</p>
       <p><a href="/">Back to app home</a></p>`
    );
  } catch (err) {
    console.error('OAuth callback error:', err);
    return res.status(500).send('<h1>Server error</h1><pre>' + String(err) + '</pre>');
  }
});

/**
 * Registers webhooks needed for our flow.
 * For now: "orders/paid" -> /callbacks/notify
 * NOTE: Adjust endpoints/headers to match Shoplazza’s current API spec.
 */
async function registerWebhooksForShop({ shop, accessToken }) {
  // Choose a supported Admin API version
  const version = process.env.SHOPLAZZA_API_VERSION || '2022-01';

  // Per docs: https://{shop}.myshoplaza.com/openapi/{version}/{endpoint}
  // Webhook “create” endpoint: /webhooks
  const url = `https://${shop}/openapi/${version}/webhooks`;

  // const base = process.env.SHOPLAZZA_API_BASE;
  const target = `${process.env.PUBLIC_BASE_URL}/callbacks/notify`;

  const body = {
    topic: 'orders/paid', // add/adjust topics as needed
    address: target,
    format: 'json',
  };

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Access-Token': accessToken, // ← Shoplazza style
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    // Helpful diagnostics on failures
    if (!resp.ok) {
      const text = await resp.text();
      console.warn('Webhook register failed:', resp.status, text.slice(0, 500));
    }
  } catch (err) {
    console.warn('Webhook register fetch error:', err);
    // Don’t rethrow so OAuth flow can still complete
  }
}

export default router;
