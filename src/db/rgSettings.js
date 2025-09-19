// src/db/rgSettings.js
/**
 * RocketGate per-shop settings store (Kysely).
 *
 * Purpose
 * -------
 * Persist merchant-scoped RocketGate configuration so Hosted Page and
 * direct API calls can be built per store.
 *
 * Table
 * -----
 * rg_settings (
 *   shop_domain  varchar(191) PK   // canonical single-z host (e.g. rg-demo.myshoplazza.com)
 *   merchant_id  varchar(191)
 *   merchant_key varchar(191)      // stored raw; NEVER return to UI unmasked
 *   mode         varchar(16)       // 'test' | 'live' (default 'test')
 *   return_url   text
 *   cancel_url   text
 *   updated_at   timestamptz/text  // default CURRENT_TIMESTAMP
 * )
 *
 * API
 * ---
 * - getRgSettings(shop)
 * - upsertRgSettings({ shop, merchantId, merchantKey?, mode?, returnUrl?, cancelUrl? })
 * - listRgSettings()
 * - resetRgSettings()
 *
 * Notes
 * -----
 * - Hosts are normalized via canonicalShopHost (single-z). For backward compat,
 *   getRgSettings will also read a legacy double-z row if present.
 * - upsert only updates merchant_key if a non-empty value is provided.
 * - Always mask merchantKey at the edge before returning to the browser.
 */

import { sql } from 'kysely';

import { canonicalShopHost } from '../utils/shopHost.js';

import { db } from './connection.js';

function normalizeMode(m) {
  return String(m ?? '')
    .trim()
    .toLowerCase() === 'live'
    ? 'live'
    : 'test';
}

/**
 * Fetch per-shop RocketGate settings.
 * Accepts slug/full host; stores canonical single-z host; falls back to legacy double-z.
 */
export async function getRgSettings(shop) {
  const canonical = canonicalShopHost(shop);
  if (!canonical) return null;

  // Try canonical (single-z)
  let row = await db
    .selectFrom('rg_settings')
    .select([
      'shop_domain as shop',
      'merchant_id as merchantId',
      'merchant_key as merchantKey',
      'mode',
      'return_url as returnUrl',
      'cancel_url as cancelUrl',
      'updated_at as updatedAt',
    ])
    .where('shop_domain', '=', canonical)
    .executeTakeFirst();

  if (row) return row;

  // Back-compat: legacy double-z if present
  const legacy = canonical.replace('.myshoplazza.com', '.myshoplaza.com');
  row = await db
    .selectFrom('rg_settings')
    .select([
      'shop_domain as shop',
      'merchant_id as merchantId',
      'merchant_key as merchantKey',
      'mode',
      'return_url as returnUrl',
      'cancel_url as cancelUrl',
      'updated_at as updatedAt',
    ])
    .where('shop_domain', '=', legacy)
    .executeTakeFirst();

  return row ?? null;
}

/**
 * Insert or update settings. Only overwrites merchant_key when a non-empty value
 * is provided (so you can keep the existing key by leaving the field blank in UI).
 */
export async function upsertRgSettings({
  shop,
  merchantId,
  merchantKey,
  mode = 'test',
  returnUrl,
  cancelUrl,
}) {
  const shop_domain = canonicalShopHost(shop);
  if (!shop_domain) throw new Error('upsertRgSettings: "shop" is required');

  const modeNorm = normalizeMode(mode);
  const keyTrim = typeof merchantKey === 'string' ? merchantKey.trim() : (merchantKey ?? undefined);
  const hasNewKey = Boolean(keyTrim);

  const values = {
    shop_domain, // single-z canonical
    merchant_id: merchantId ?? null,
    merchant_key: hasNewKey ? String(keyTrim) : null, // only set when provided
    mode: modeNorm,
    return_url: returnUrl ?? null,
    cancel_url: cancelUrl ?? null,
  };

  await db
    .insertInto('rg_settings')
    .values(values)
    .onConflict((oc) =>
      oc.column('shop_domain').doUpdateSet({
        merchant_id: values.merchant_id,
        ...(hasNewKey ? { merchant_key: values.merchant_key } : {}),
        mode: values.mode,
        return_url: values.return_url,
        cancel_url: values.cancel_url,
        updated_at: sql`CURRENT_TIMESTAMP`,
      })
    )
    .execute();

  return await getRgSettings(shop_domain);
}

/** List settings for all shops (never include merchantKey unless masked upstream). */
export async function listRgSettings() {
  return await db
    .selectFrom('rg_settings')
    .select([
      'shop_domain as shop',
      'merchant_id as merchantId',
      'mode',
      'return_url as returnUrl',
      'cancel_url as cancelUrl',
      'updated_at as updatedAt',
    ])
    .orderBy('updated_at', 'desc')
    .execute();
}

/** Danger: development helper to clear the table. */
export async function resetRgSettings() {
  await db.deleteFrom('rg_settings').execute();
}

export default { getRgSettings, upsertRgSettings, listRgSettings, resetRgSettings };
