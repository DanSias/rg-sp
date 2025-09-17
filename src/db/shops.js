// src/db/shops.js
/**
 * SQLite-backed shop store.
 * API:
 *   - upsertShop({ shop, accessToken?, scope? })
 *   - getShop(shop)
 *   - listShops()
 *   - resetShops()
 */
import { db } from './connection.js';

// Schema (idempotent)
db.exec(`
  CREATE TABLE IF NOT EXISTS shops (
    shop          TEXT PRIMARY KEY,
    access_token  TEXT,
    scope         TEXT,
    installed_at  INTEGER,
    updated_at    INTEGER
  );
`);

const stmtSelectOne = db.prepare(`
  SELECT
    shop,
    access_token  AS accessToken,
    scope,
    installed_at  AS installedAt,
    updated_at    AS updatedAt
  FROM shops
  WHERE shop = ?
`);

const stmtSelectAll = db.prepare(`
  SELECT
    shop,
    access_token  AS accessToken,
    scope,
    installed_at  AS installedAt,
    updated_at    AS UpdatedAt
  FROM shops
  ORDER BY updated_at DESC
`);

const stmtInsertUpsert = db.prepare(`
  INSERT INTO shops (shop, access_token, scope, installed_at, updated_at)
  VALUES (@shop, @accessToken, @scope, @installedAt, @updatedAt)
  ON CONFLICT(shop) DO UPDATE SET
    access_token = COALESCE(excluded.access_token, shops.access_token),
    scope        = COALESCE(excluded.scope,        shops.scope),
    installed_at = COALESCE(shops.installed_at,    excluded.installed_at),
    updated_at   = excluded.updated_at
`);

const stmtDeleteAll = db.prepare(`DELETE FROM shops`);

export function upsertShop(rec) {
  if (!rec?.shop) throw new Error('upsertShop: "shop" is required');
  const now = Date.now();
  const prev = getShop(rec.shop);

  const toWrite = {
    shop: rec.shop,
    accessToken: rec.accessToken ?? prev?.accessToken ?? null,
    scope: rec.scope ?? prev?.scope ?? null,
    installedAt: prev?.installedAt ?? rec.installedAt ?? now,
    updatedAt: now,
  };

  stmtInsertUpsert.run(toWrite);
  return getShop(rec.shop);
}

export function getShop(shop) {
  return stmtSelectOne.get(shop) ?? null;
}

export function listShops() {
  return stmtSelectAll.all();
}

export function resetShops() {
  stmtDeleteAll.run();
}

export default { upsertShop, getShop, listShops, resetShops };
