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

/** Utility: permissive matcher for *.myshoplazza.com or *.myshoplaza.com */
const SHOP_HOST_RE = /^[a-z0-9-]+\.(myshoplazza|myshoplaza)\.com$/i;
const SHOPLAZZA_BASE_DOMAIN = (process.env.SHOPLAZZA_BASE_DOMAIN || 'myshoplaza.com').toLowerCase();

/**
 * Accept a slug ("rg-demo") or a full host ("rg-demo.myshoplazza.com")
 * and return a normalized host like "rg-demo.myshoplazza.com".
 * Prefer the modern "myshoplazza.com" domain when a slug is provided.
 */
function normalizeShopHost(input) {
  if (!input) return null;
  const trimmed = String(input).trim().toLowerCase();

  // If they pasted a URL, extract hostname
  let host = trimmed;
  try {
    const maybeUrl = new URL(/^[a-z]+:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`);
    host = maybeUrl.hostname;
  } catch {
    /* not a URL */
  }

  // If they gave a bare slug, append the configured base domain
  if (!host.includes('.')) host = `${host}.${SHOPLAZZA_BASE_DOMAIN}`;

  // Validate
  if (!SHOP_HOST_RE.test(host)) return null;
  return host;
}

/**
 * Resolve Shoplazza app credentials for a given shop host.
 * Priority:
 *  1) DB lookup (TODO: wire to Kysely)
 *  2) Env JSON map SHOPLAZZA_APP_MAP (e.g., {"rg-demo.myshoplazza.com":{"client_id":"...","client_secret":"..."}})
 *  3) Fallback to single-tenant env (SHOPLAZZA_CLIENT_ID / SHOPLAZZA_CLIENT_SECRET)
 */
function resolveShopCredentials(shopHost) {
  let fromMap;
  if (process.env.SHOPLAZZA_APP_MAP) {
    try {
      const map = JSON.parse(process.env.SHOPLAZZA_APP_MAP);
      fromMap = map?.[shopHost];
    } catch (e) {
      console.warn('Invalid SHOPLAZZA_APP_MAP JSON; falling back to single-tenant env.', e);
    }
  }

  const client_id = fromMap?.client_id || process.env.SHOPLAZZA_CLIENT_ID;
  const client_secret = fromMap?.client_secret || process.env.SHOPLAZZA_CLIENT_SECRET;

  return { client_id, client_secret };
}

/**
 * GET /auth/start
 * Initiates OAuth. Accepts ?shop=<slug or *.myshoplazza.com>.
 * Multi-tenant: resolves client_id per shop.
 */
router.get('/start', (req, res) => {
  try {
    const { SHOPLAZZA_REDIRECT_URL, SHOPLAZZA_SCOPES } = process.env;

    if (!SHOPLAZZA_REDIRECT_URL) {
      return res.status(500).send('Missing required OAuth env: SHOPLAZZA_REDIRECT_URL');
    }

    // Normalize shop input
    const shopParam = (req.query?.shop || '').toString();
    const shopHost = normalizeShopHost(shopParam);
    if (!shopHost) {
      return res
        .status(400)
        .send('Invalid ?shop; enter a slug like "your-store" or a *.myshoplazza.com address.');
    }

    // Resolve per-shop credentials
    const { client_id } = resolveShopCredentials(shopHost);
    if (!client_id) {
      return res
        .status(400)
        .send(
          `No client_id configured for ${shopHost}. (Add it to SHOPLAZZA_APP_MAP or set SHOPLAZZA_CLIENT_ID)`
        );
    }

    // Generate state and store it (pair with shop)
    const state = crypto.randomUUID();
    OAUTH_STATES.set(state, { shop: shopHost, ts: Date.now() });

    // Cookie copy (works in top-level; may be blocked in iframes)
    res.cookie('oauth_state', JSON.stringify({ state, shop: shopHost }), {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: 10 * 60 * 1000,
    });

    // Build store-specific authorize URL
    const u = new URL(`https://${shopHost}/admin/oauth/authorize`);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', client_id);
    u.searchParams.set('redirect_uri', SHOPLAZZA_REDIRECT_URL);
    if (SHOPLAZZA_SCOPES) u.searchParams.set('scope', SHOPLAZZA_SCOPES); // space-separated
    u.searchParams.set('state', state);
    u.searchParams.set('shop', shopHost); // parity

    return res.redirect(302, u.toString());
  } catch (err) {
    console.error('OAuth start error:', err);
    return res.status(500).send('Internal error starting OAuth.');
  }
});

/**
 * GET /auth/callback
 * OAuth callback route
 * Exchanges code -> access_token and stores it with the shop identifier.
 * Also auto-registers webhooks for the shop.
 */
router.get('/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query || {};
    let { shop } = req.query || {};

    if (error) {
      return res.status(400).send(`<h1>Auth error</h1><p>${String(error)}</p>`);
    }

    // Normalize & validate shop
    shop = normalizeShopHost(shop);
    if (!shop) {
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
      } catch (e) {
        console.warn('Failed to parse oauth_state cookie:', e);
      }
      if (!bundle?.state || !bundle?.shop || state !== bundle.state || shop !== bundle.shop) {
        return res.status(400).send('<h1>Auth failed</h1><p>Invalid or missing state/shop.</p>');
      }
      res.clearCookie('oauth_state');
    }

    // Env vars needed for token exchange
    const { SHOPLAZZA_REDIRECT_URL } = process.env;
    const { client_id, client_secret } = resolveShopCredentials(shop);
    const missingBits = [];
    if (!client_id) missingBits.push('client_id');
    if (!client_secret) missingBits.push('client_secret');
    if (!SHOPLAZZA_REDIRECT_URL) missingBits.push('SHOPLAZZA_REDIRECT_URL');
    if (missingBits.length) {
      console.error('❌ Missing OAuth config:', missingBits);
      return res.status(500).send('Missing OAuth config: ' + missingBits.join(', '));
    }

    // Exchange authorization code -> access token (per-store endpoint)
    const tokenUrl = `https://${shop}/admin/oauth/token`;

    let tokenResp;
    try {
      tokenResp = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: String(code),
          client_id,
          client_secret,
          redirect_uri: SHOPLAZZA_REDIRECT_URL,
        }),
      });
    } catch (e) {
      console.error('Token exchange network error:', e);
      return res.status(502).send('<h1>Token exchange failed</h1><p>Network error.</p>');
    }

    if (!tokenResp.ok) {
      const text = await tokenResp.text().catch(() => '(no body)');
      console.warn('Token exchange HTTP error:', tokenResp.status, text.slice(0, 500));
      return res
        .status(502)
        .send(`<h1>Token exchange failed</h1><pre>${escapeHtml(text).slice(0, 2000)}</pre>`);
    }

    let tokenJson;
    try {
      tokenJson = await tokenResp.json();
    } catch (e) {
      console.error('Token JSON parse error:', e);
      return res.status(502).send('<h1>Token exchange failed</h1><p>Invalid JSON.</p>');
    }

    const accessToken = tokenJson.access_token;
    const scope = tokenJson.scope ?? null;

    if (!accessToken) {
      return res
        .status(502)
        .send(
          `<h1>Token exchange failed</h1><pre>${escapeHtml(JSON.stringify(tokenJson, null, 2))}</pre>`
        );
    }

    // ✅ Persist shop credentials (DB)
    try {
      await upsertShop({ shop, accessToken, scope });
    } catch (e) {
      console.error('upsertShop failed:', e);
      // We still proceed to register webhooks; merchant is installed but persistence failed.
      // If you prefer to fail hard, return 500 here instead.
    }

    // Best-effort: register webhooks for this shop
    try {
      await registerWebhooksForShop({ shop, accessToken });
    } catch (e) {
      console.warn('registerWebhooksForShop failed:', e);
      // Non-fatal: installation can still complete; you can provide a link to retry
    }

    // Clear cookie (safe even if already cleared above)
    res.clearCookie('oauth_state');

    // Success page
    return res.redirect(`/installed.html?shop=${encodeURIComponent(shop)}`);
  } catch (err) {
    console.error('OAuth callback error:', err);
    return res.status(500).send('<h1>Server error</h1><pre>' + escapeHtml(String(err)) + '</pre>');
  }
});

/**
 * Registers webhooks needed for our flow.
 * For now: "orders/paid" -> /callbacks/notify
 * NOTE: Adjust endpoints/headers to match Shoplazza’s current API spec.
 */
async function registerWebhooksForShop({ shop, accessToken }) {
  const version = process.env.SHOPLAZZA_API_VERSION || '2022-01';
  const url = `https://${shop}/openapi/${version}/webhooks`;
  const target = `${process.env.APP_BASE_URL}/callbacks/notify`;

  const body = {
    topic: 'orders/paid', // add/adjust topics as needed
    address: target,
    format: 'json',
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Access-Token': accessToken, // Shoplazza header
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '(no body)');
    throw new Error(`Webhook register failed: ${resp.status} ${text.slice(0, 500)}`);
  }
}

/** Tiny HTML escaper for safe rendering in error/success pages */
function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export default router;
