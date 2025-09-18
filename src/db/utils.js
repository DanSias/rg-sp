// src/db/utils.js
import { db } from './index.js';

export async function saveWebhookLog({ source, topic, idempotencyKey, headers, payloadJson }) {
  const now = new Date().toISOString();
  // legacy shim path (sqlite): use .exec to keep this trivial
  await db.exec?.(`
    INSERT INTO webhook_logs (source, topic, idempotency_key, headers, payload_json, received_at)
    VALUES (
      '${escapeSql(source)}',
      '${escapeSql(topic)}',
      '${escapeSql(idempotencyKey || '')}',
      '${escapeSql(headers)}',
      '${escapeSql(payloadJson)}',
      CURRENT_TIMESTAMP
    );
  `);
}

function escapeSql(s) {
  return String(s ?? '').replaceAll("'", "''");
}
