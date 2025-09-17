// src/db/connection.js
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH || path.resolve('./data/app.db');

// Ensure directory exists (e.g., ./data)
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
