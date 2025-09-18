// src/db/connection.js
import { createRequire } from 'node:module';

import { Kysely, SqliteDialect, PostgresDialect, MysqlDialect, sql } from 'kysely';

const require = createRequire(import.meta.url);

const DB_CLIENT = (process.env.DB_CLIENT || 'sqlite').toLowerCase();
const DB_URL = process.env.DB_URL || './data/dev.db';

// 🔸 Keep a handle to the native sqlite DB for legacy APIs
let sqliteNative = null;

function makeDialect() {
  if (DB_CLIENT === 'sqlite') {
    const Database = require('better-sqlite3');
    sqliteNative = new Database(DB_URL); // ⬅️ keep reference
    // Optional pragmas:
    // sqliteNative.pragma('journal_mode = WAL');
    // sqliteNative.pragma('foreign_keys = ON');
    return new SqliteDialect({ database: sqliteNative });
  }

  if (DB_CLIENT === 'postgres') {
    try {
      const { Pool } = require('pg');
      return new PostgresDialect({ pool: new Pool({ connectionString: DB_URL }) });
    } catch {
      throw new Error('DB_CLIENT=postgres requires the "pg" package. Run: npm i pg');
    }
  }

  if (DB_CLIENT === 'mysql') {
    try {
      const mysql = require('mysql2/promise');
      return new MysqlDialect({ pool: mysql.createPool(DB_URL) });
    } catch {
      throw new Error('DB_CLIENT=mysql requires the "mysql2" package. Run: npm i mysql2');
    }
  }

  throw new Error(`Unsupported DB_CLIENT: ${DB_CLIENT}`);
}

// Singleton Kysely instance
export const db = new Kysely({ dialect: makeDialect() });

/**
 * 🔸 Back-compat shims for legacy better-sqlite3 style code:
 *  - db.exec(sqlText)
 *  - db.prepare(sqlText) -> { get/all/run/... }
 * These are only provided in sqlite mode. On other dialects, they throw.
 */
if (DB_CLIENT === 'sqlite' && sqliteNative) {
  // Fast-path: use native exec directly
  db.exec = async (sqlText) => {
    if (typeof sqlText !== 'string' || !sqlText.trim()) return;
    sqliteNative.exec(sqlText);
  };

  db.prepare = (sqlText) => {
    const stmt = sqliteNative.prepare(sqlText);
    // Return a minimal facade with common methods used by your code
    return {
      get: (...args) => stmt.get(...args),
      all: (...args) => stmt.all(...args),
      run: (...args) => stmt.run(...args),
      // expose a couple of extras if you used them
      pluck: (...args) => stmt.pluck(...args),
      raw: stmt.raw,
      bind: (...args) => stmt.bind(...args),
    };
  };
} else {
  // Non-sqlite: make failures explicit if legacy calls leak through
  db.exec = async () => {
    throw new Error('db.exec is only available under sqlite legacy shim.');
  };
  db.prepare = () => {
    throw new Error('db.prepare is only available under sqlite legacy shim.');
  };
}

/**
 * Idempotent, portable migrations.
 */
export async function runMigrations() {
  const isPg = DB_CLIENT === 'postgres';
  const isMy = DB_CLIENT === 'mysql';

  // payments
  await db.schema
    .createTable('payments')
    .ifNotExists()
    .addColumn('id', isPg ? 'serial' : 'integer', (col) =>
      isPg ? col.primaryKey() : col.primaryKey().autoIncrement()
    )
    .addColumn('shoplazza_payment_id', 'varchar(191)')
    .addColumn('order_id', 'varchar(191)')
    .addColumn('amount', isMy ? 'decimal(18,2)' : isPg ? 'numeric' : 'real')
    .addColumn('currency', 'varchar(8)')
    .addColumn('status', 'varchar(64)')
    .addColumn('rg_txn_id', 'varchar(191)')
    .addColumn('created_at', isPg ? 'timestamptz' : 'text', (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`)
    )
    .addColumn('updated_at', isPg ? 'timestamptz' : 'text', (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`)
    )
    .execute();

  // webhook_logs
  await db.schema
    .createTable('webhook_logs')
    .ifNotExists()
    .addColumn('id', isPg ? 'serial' : 'integer', (col) =>
      isPg ? col.primaryKey() : col.primaryKey().autoIncrement()
    )
    .addColumn('source', 'varchar(32)')
    .addColumn('topic', 'varchar(128)')
    .addColumn('idempotency_key', 'varchar(191)')
    .addColumn('headers', 'text')
    .addColumn('payload_json', 'text')
    .addColumn('received_at', isPg ? 'timestamptz' : 'text', (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`)
    )
    .execute();

  // shops
  await db.schema
    .createTable('shops')
    .ifNotExists()
    .addColumn('id', isPg ? 'serial' : 'integer', (col) =>
      isPg ? col.primaryKey() : col.primaryKey().autoIncrement()
    )
    .addColumn('shop_domain', 'varchar(191)', (col) => col.notNull().unique())
    .addColumn('access_token', 'text', (col) => col.notNull())
    .addColumn('scopes', 'text')
    .addColumn('installed_at', isPg ? 'timestamptz' : 'text', (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`)
    )
    .addColumn('uninstalled_at', isPg ? 'timestamptz' : 'text')
    .addColumn('created_at', isPg ? 'timestamptz' : 'text', (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`)
    )
    .addColumn('updated_at', isPg ? 'timestamptz' : 'text', (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`)
    )
    .execute();
}
