// src/db/connection.js
import { createRequire } from 'node:module';

import { Kysely, SqliteDialect, PostgresDialect, MysqlDialect, sql } from 'kysely';

const require = createRequire(import.meta.url);

export const DB_CLIENT = (process.env.DB_CLIENT || 'sqlite').toLowerCase();
const DB_URL = process.env.DB_URL || './data/dev.db';

// Allow destructive reset of payments during dev only if explicitly set.
const RESET_PAYMENTS_ON_BOOT =
  String(process.env.RESET_PAYMENTS_ON_BOOT || 'false').toLowerCase() === 'true';

// 🔸 Keep a handle to the native sqlite DB for legacy APIs
let sqliteNative = null;

function makeDialect() {
  if (DB_CLIENT === 'sqlite') {
    const Database = require('better-sqlite3');
    // Busy timeout helps avoid SQLITE_BUSY during rapid dev reloads
    sqliteNative = new Database(DB_URL, { timeout: 3000 });
    // Sensible defaults for local dev
    try {
      sqliteNative.pragma('journal_mode = WAL');
      sqliteNative.pragma('foreign_keys = ON');
      sqliteNative.pragma('synchronous = NORMAL');
    } catch (_) {
      // ignore if pragma not supported
    }
    return new SqliteDialect({ database: sqliteNative });
  }

  if (DB_CLIENT === 'postgres') {
    try {
      const { Pool } = require('pg');
      // Optional SSL toggle for hosted PG (e.g., Neon/Render/Heroku)
      const ssl =
        String(process.env.PGSSL || 'false').toLowerCase() === 'true'
          ? { rejectUnauthorized: false }
          : undefined;

      const pool = new Pool({
        connectionString: DB_URL,
        max: Number(process.env.PG_POOL_MAX || 10),
        idleTimeoutMillis: Number(process.env.PG_POOL_IDLE || 30_000),
        connectionTimeoutMillis: Number(process.env.PG_POOL_CONN_TIMEOUT || 10_000),
        ssl,
      });
      return new PostgresDialect({ pool });
    } catch {
      throw new Error('DB_CLIENT=postgres requires the "pg" package. Run: npm i pg');
    }
  }

  if (DB_CLIENT === 'mysql') {
    try {
      const mysql = require('mysql2/promise');
      // mysql2 accepts a URL string or an options object.
      const pool =
        typeof DB_URL === 'string'
          ? mysql.createPool(DB_URL)
          : mysql.createPool({
              uri: DB_URL,
            });
      return new MysqlDialect({ pool });
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
  db.exec = async (sqlText) => {
    if (typeof sqlText !== 'string' || !sqlText.trim()) return;
    sqliteNative.exec(sqlText);
  };

  db.prepare = (sqlText) => {
    const stmt = sqliteNative.prepare(sqlText);
    return {
      get: (...args) => stmt.get(...args),
      all: (...args) => stmt.all(...args),
      run: (...args) => stmt.run(...args),
      pluck: (...args) => stmt.pluck?.(...args),
      raw: stmt.raw,
      bind: (...args) => stmt.bind?.(...args),
    };
  };
} else {
  db.exec = async () => {
    throw new Error('db.exec is only available under sqlite legacy shim.');
  };
  db.prepare = () => {
    throw new Error('db.prepare is only available under sqlite legacy shim.');
  };
}

/**
 * Graceful shutdown helper (use in tests or on process exit)
 */
export async function closeDb() {
  try {
    // Kysely itself doesn’t hold connections for sqlite; pools do for pg/mysql
    if (DB_CLIENT === 'postgres') {
      const { pool } = db.getExecutor().adapter;
      await pool?.end?.();
    }
    if (DB_CLIENT === 'mysql') {
      const { pool } = db.getExecutor().adapter;
      await pool?.end?.();
    }
    if (sqliteNative) sqliteNative.close();
  } catch (_) {
    /* ignore close errors */
  }
}

/**
 * Idempotent, portable migrations.
 */
export async function runMigrations() {
  const isPg = DB_CLIENT === 'postgres';
  const isMy = DB_CLIENT === 'mysql';

  // --- shops (idempotent) ---
  await db.schema
    .createTable('shops')
    .ifNotExists()
    .addColumn('shop', 'varchar(191)', (col) => col.primaryKey())
    .addColumn('access_token', 'text')
    .addColumn('scope', 'text')
    .addColumn('installed_at', isPg ? 'timestamptz' : 'text', (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`)
    )
    .addColumn('updated_at', isPg ? 'timestamptz' : 'text', (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`)
    )
    .execute();

  // --- webhook_logs (idempotent) ---
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

  // --- rg_settings (idempotent) ---
  await db.schema
    .createTable('rg_settings')
    .ifNotExists()
    .addColumn('shop_domain', 'varchar(191)', (col) => col.primaryKey())
    .addColumn('merchant_id', 'varchar(191)')
    .addColumn('merchant_key', 'varchar(191)')
    .addColumn('mode', 'varchar(16)', (col) => col.defaultTo('test'))
    .addColumn('return_url', 'text')
    .addColumn('cancel_url', 'text')
    .addColumn('updated_at', isPg ? 'timestamptz' : 'text', (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`)
    )
    .execute();

  // --- payments (reset only if explicitly allowed) ---
  if (RESET_PAYMENTS_ON_BOOT) {
    await db.schema.dropTable('payments').ifExists().execute();
  }

  // Create if missing
  await db.schema
    .createTable('payments')
    .ifNotExists()
    .addColumn('id', isPg ? 'serial' : 'integer', (col) =>
      isPg ? col.primaryKey() : col.primaryKey().autoIncrement()
    )

    // Keys & identity
    .addColumn('shop_domain', 'varchar(191)', (col) => col.notNull())
    .addColumn('order_id', 'varchar(191)', (col) => col.notNull())
    .addColumn('payment_id', 'varchar(191)', (col) => col.notNull())
    .addColumn('customer_id', 'varchar(191)')

    // Money
    .addColumn('amount', isMy ? 'decimal(18,2)' : isPg ? 'numeric' : 'real')
    .addColumn('currency', 'varchar(8)')

    // State
    .addColumn('status', 'varchar(64)', (col) => col.notNull())

    // RocketGate linkage
    .addColumn('rocketgate_txn', 'varchar(191)')

    // Debug / traceability
    .addColumn('status_history', 'text')
    .addColumn('rg_raw_notify', 'text')
    .addColumn('spz_raw_complete', 'text')

    // Timestamps
    .addColumn('created_at', isPg ? 'timestamptz' : 'text', (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull()
    )
    .addColumn('updated_at', isPg ? 'timestamptz' : 'text', (col) =>
      col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull()
    )

    // Uniqueness
    .addUniqueConstraint('ux_payments_shop_order_payment', [
      'shop_domain',
      'order_id',
      'payment_id',
    ])
    .execute();

  // Helpful indexes (all guarded with ifNotExists)
  await db.schema
    .createIndex('idx_payments_order_id')
    .ifNotExists()
    .on('payments')
    .column('order_id')
    .execute();

  await db.schema
    .createIndex('idx_payments_payment_id')
    .ifNotExists()
    .on('payments')
    .column('payment_id')
    .execute();

  await db.schema
    .createIndex('idx_payments_shop_domain')
    .ifNotExists()
    .on('payments')
    .column('shop_domain')
    .execute();

  await db.schema
    .createIndex('idx_payments_status_updated_at')
    .ifNotExists()
    .on('payments')
    .columns(['status', 'updated_at'])
    .execute();
}
