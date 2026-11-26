'use strict';
/**
 * Esquema SQLite local de V8 (§5). Estrictamente ADITIVO e idempotente:
 * no renombra ni borra nada; las rutas actuales siguen funcionando.
 */
function hasColumn(db, table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}
function tableExists(db, table) {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table);
}
function addCol(db, table, col, def) {
  if (!tableExists(db, table)) return;
  if (!hasColumn(db, table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

function applySchema(db) {
  // inventory
  addCol(db, 'inventory', 'stock_confirmed_milli', 'INTEGER');
  addCol(db, 'inventory', 'confirmed_version', 'INTEGER NOT NULL DEFAULT 0');
  // stock_movements (los movimientos existentes quedan como 'legacy')
  addCol(db, 'stock_movements', 'inventory_uuid', 'TEXT');
  addCol(db, 'stock_movements', 'operation_id', 'TEXT');
  addCol(db, 'stock_movements', 'line_id', 'TEXT');
  addCol(db, 'stock_movements', 'kind', 'TEXT');
  addCol(db, 'stock_movements', 'requested_milli', 'INTEGER');
  addCol(db, 'stock_movements', 'applied_milli', 'INTEGER');
  addCol(db, 'stock_movements', 'shortage_milli', 'INTEGER');
  addCol(db, 'stock_movements', 'delta_milli', 'INTEGER');
  addCol(db, 'stock_movements', 'confirmation_state', `TEXT NOT NULL DEFAULT 'legacy'`);
  addCol(db, 'stock_movements', 'origin', `TEXT NOT NULL DEFAULT 'legacy'`);
  addCol(db, 'stock_movements', 'server_movement_id', 'TEXT');
  addCol(db, 'stock_movements', 'source_operation_id', 'TEXT');
  // orders (espejo del control de versión remoto)
  addCol(db, 'orders', 'remote_version', 'INTEGER');
  addCol(db, 'orders', 'remote_status', 'TEXT');

  if (tableExists(db, 'stock_movements')) {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_sm_op_line_kind
               ON stock_movements(operation_id, line_id, kind) WHERE operation_id IS NOT NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS ix_sm_inv_state ON stock_movements(inventory_uuid, confirmation_state)`);
  }

  db.exec(`
CREATE TABLE IF NOT EXISTS inventory_outbox (
  outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  op_kind TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_uuid TEXT NOT NULL,
  entity_seq INTEGER NOT NULL,
  partition_key TEXT NOT NULL,
  depends_on_operation_id TEXT,
  request_payload TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','claimed','applied','retry_wait','dead_letter','conflict')),
  lease_owner TEXT, lease_expires_at INTEGER, claimed_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  server_failures INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error_code TEXT, last_error TEXT, http_status INTEGER,
  response_payload TEXT,
  resolved_at INTEGER, resolution_note TEXT,
  created_at INTEGER NOT NULL, applied_at INTEGER,
  device_id TEXT NOT NULL, restaurant_id TEXT NOT NULL,
  UNIQUE (entity_type, entity_uuid, entity_seq)
);
CREATE INDEX IF NOT EXISTS ix_outbox_ready ON inventory_outbox(status, next_attempt_at, outbox_id);
CREATE INDEX IF NOT EXISTS ix_outbox_partition ON inventory_outbox(partition_key, outbox_id);

CREATE TABLE IF NOT EXISTS applied_results (
  operation_id TEXT PRIMARY KEY,
  event_seq INTEGER,
  source TEXT NOT NULL CHECK (source IN ('response','event')),
  result_hash TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_cursor (
  restaurant_id TEXT PRIMARY KEY,
  last_applied_seq INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS sync_events_local (
  event_seq INTEGER PRIMARY KEY,
  event_id TEXT UNIQUE,
  operation_id TEXT,
  origin_device_id TEXT,
  is_own INTEGER NOT NULL DEFAULT 0,
  payload_hash TEXT,
  applied_at INTEGER
);

CREATE TABLE IF NOT EXISTS local_authorizations (
  authorization_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  order_uuid TEXT,
  inventory_uuid TEXT,
  max_milli INTEGER,
  valid_until INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','attached','used','expired'))
);
`);
  // Columnas añadidas por la política DEC-02 (ADITIVO, para bases ya creadas).
  addCol(db, 'local_authorizations', 'issued_to_device_id', 'TEXT');
  addCol(db, 'local_authorizations', 'offline_grace', 'INTEGER NOT NULL DEFAULT 0');
  addCol(db, 'local_authorizations', 'revoked', 'INTEGER NOT NULL DEFAULT 0');
}

module.exports = { applySchema, hasColumn, tableExists };
