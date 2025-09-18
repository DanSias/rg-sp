// src/db/shops.js
/**
 * Kysely-backed shop store (portable: sqlite, postgres, mysql).
 * API:
 *   - upsertShop({ shop, accessToken?, scope? })
 *   - getShop(shop)
 *   - listShops()
 *   - resetShops()
 */

import { sql } from 'kysely';

import { db } from './connection.js';

function normDomain(s) {
  return String(s || '')
    .trim()
    .toLowerCase();
}

/**
 * Insert or update a shop record.
 * - `shop` can be a slug or full host; we store normalized domain.
 * - Upsert refreshes access_token/scopes and timestamps.
 */
export async function upsertShop({ shop, accessToken, scope }) {
  if (!shop) throw new Error('upsertShop: "shop" is required');
  if (!accessToken) throw new Error('upsertShop: "accessToken" is required');

  const shop_domain = normDomain(shop);

  await db
    .insertInto('shops')
    .values({
      shop_domain,
      access_token: accessToken,
      scopes: scope ?? null,
      // installed_at / created_at / updated_at have defaults in migrations
    })
    .onConflict((oc) =>
      oc.column('shop_domain').doUpdateSet({
        access_token: accessToken,
        scopes: scope ?? null,
        // keep installed_at as originally created
        uninstalled_at: null,
        updated_at: sql`CURRENT_TIMESTAMP`,
      })
    )
    .execute();

  return await getShop(shop_domain);
}

/**
 * Fetch a single shop by domain/slug.
 * Returns: { shop, accessToken, scope, installedAt, updatedAt } | null
 */
export async function getShop(shop) {
  const shop_domain = normDomain(shop);

  const row = await db
    .selectFrom('shops')
    .select([
      'shop_domain as shop',
      'access_token as accessToken',
      'scopes as scope',
      'installed_at as installedAt',
      'updated_at as updatedAt',
    ])
    .where('shop_domain', '=', shop_domain)
    .executeTakeFirst();

  return row ?? null;
}

/**
 * List latest shops (defaults to 50).
 * Returns array of { shop, accessToken, scope, installedAt, updatedAt }
 */
export async function listShops({ limit = 50 } = {}) {
  const rows = await db
    .selectFrom('shops')
    .select([
      'shop_domain as shop',
      'access_token as accessToken',
      'scopes as scope',
      'installed_at as installedAt',
      'updated_at as updatedAt',
    ])
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();

  return rows;
}

/**
 * Dev-only: clear table.
 */
export async function resetShops() {
  await db.deleteFrom('shops').execute();
}

export default { upsertShop, getShop, listShops, resetShops };
