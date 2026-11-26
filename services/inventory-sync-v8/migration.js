'use strict';
/**
 * Migración LOCAL (SQLite) hacia V8 §17. Nunca toca Supabase ni la BD real.
 *
 * Contratos:
 *  - analyze(): solo lectura; propone saldos pero NO decide por el propietario.
 *  - validate(): exige una decisión explícita para CADA producto; no aplica nada.
 *  - apply(): transacción única; NUNCA escribe `inventory.stock` (columna legacy),
 *             escribe `stock_confirmed_milli` y deja auditoría completa.
 *             Pone en cuarentena `sync_queue` de inventory SIN BORRAR filas:
 *             copia la fila y marca `synced=1`.
 *  - rollback(): solo antes del punto de no retorno (sin operaciones V8 aplicadas
 *             en remoto); revierte cambios y marcus cuarentena como restaurada,
 *             conservando todas las filas de auditoría.
 *
 * El llamador debe pasar un handle SQLite ya abierto sobre una COPIA descartable.
 */
const { milliFromLegacyNumber, fromMilli } = require('./decimal');

const AUDIT_TABLES = `
CREATE TABLE IF NOT EXISTS v8_migration_runs (
  run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  command TEXT NOT NULL,
  status TEXT NOT NULL,
  decisions_json TEXT NOT NULL,
  counts_json TEXT NOT NULL,
  notes TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS v8_migration_products (
  run_id INTEGER NOT NULL,
  inventory_id INTEGER NOT NULL,
  inventory_uuid TEXT,
  name TEXT,
  legacy_stock_milli INTEGER NOT NULL,
  accepted_milli INTEGER NOT NULL,
  decision_source TEXT,
  PRIMARY KEY (run_id, inventory_id)
);
CREATE TABLE IF NOT EXISTS v8_migration_changes (
  change_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  table_name TEXT NOT NULL,
  row_key TEXT NOT NULL,
  column_name TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT
);
CREATE TABLE IF NOT EXISTS v8_migration_queue_quarantine (
  quarantine_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  queue_id INTEGER NOT NULL UNIQUE,
  table_name TEXT NOT NULL,
  row_uuid TEXT,
  operation TEXT,
  created_at INTEGER,
  old_synced INTEGER,
  payload_json TEXT,
  restored INTEGER NOT NULL DEFAULT 0
);
`;

function exists(db, table) {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table);
}
function hasColumn(db, table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}
function keyFor(row) {
  return row.uuid || (row.id !== undefined ? `id:${row.id}` : String(row.inventory_uuid || ''));
}
function lookup(map, row) {
  if (!map) return undefined;
  const candidates = [keyFor(row), row.uuid, row.id !== undefined ? `id:${row.id}` : null,
    row.inventory_uuid].filter((x) => x !== undefined && x !== null && x !== '');
  for (const k of candidates) if (Object.prototype.hasOwnProperty.call(map, k)) return map[k];
  return undefined;
}
function toMilliSafe(value) {
  if (typeof value === 'string' && /^-?\d+(\.\d{1,3})?$/.test(value.trim())) {
    return Math.round(Number(value) * 1000);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 1000);
  return null;
}
function begin(db) { db.exec('BEGIN'); }
function commit(db) { db.exec('COMMIT'); }
function rollback(db) { db.exec('ROLLBACK'); }

/** Solo lectura. Devuelve propuestas y hallazgos; NO escribe nada. */
function analyze(db, options = {}) {
  const deviceReports = Array.isArray(options.deviceReports) ? options.deviceReports : [];
  const remoteBalances = options.remoteBalances || null;
  const inventory = exists(db, 'inventory')
    ? db.prepare(`SELECT id, uuid, name, stock FROM inventory ORDER BY id`).all()
    : [];
  const products = inventory.map((row) => {
    const key = keyFor(row);
    const legacyMilli = milliFromLegacyNumber(row.stock);
    const remote = lookup(remoteBalances, row);
    const remoteMilli = remote === undefined ? null : toMilliSafe(remote);
    const observations = deviceReports
      .filter((rep) => rep && rep.balances && lookup(rep.balances, row) !== undefined)
      .map((rep) => ({
        device_id: rep.device_id || 'desconocido',
        balance_milli: toMilliSafe(lookup(rep.balances, row)),
        balance: lookup(rep.balances, row),
      }));
    const valid = observations.every((o) => o.balance_milli !== null);
    const candidate = remoteMilli !== null && remoteMilli !== undefined ? remoteMilli : legacyMilli;
    const allAgree = valid && observations.every((o) => o.balance_milli === candidate);
    return {
      inventory_id: row.id,
      inventory_uuid: row.uuid || null,
      key,
      name: row.name,
      legacy_stock_milli: legacyMilli,
      remote_legacy_milli: remoteMilli,
      device_observations: observations,
      proposed_milli: candidate,
      status: valid && !allAgree ? 'discrepante' : 'consistente',
      decision_required: true, // §17: ningún saldo se adopta automáticamente
    };
  });
  const pendingQueue = exists(db, 'sync_queue')
    ? db.prepare(`SELECT id, table_name, row_uuid, operation, created_at, synced
                    FROM sync_queue WHERE table_name='inventory'
                      AND (synced IS NULL OR synced=0) ORDER BY id`).all()
    : [];
  const otherPending = exists(db, 'sync_queue')
    ? db.prepare(`SELECT table_name, COUNT(*) AS n FROM sync_queue
                   WHERE table_name<>'inventory' AND (synced IS NULL OR synced=0)
                   GROUP BY table_name ORDER BY table_name`).all()
    : [];
  const openOrders = exists(db, 'orders')
    ? db.prepare(`SELECT COUNT(*) AS n FROM orders
                   WHERE status IS NULL OR lower(status) NOT IN
                     ('closed','cerrado','cancelled','cancelado','paid','pagado')`).get().n
    : 0;
  const movements = exists(db, 'stock_movements')
    ? db.prepare(`SELECT COUNT(*) AS n FROM stock_movements`).get().n
    : 0;
  return {
    version: 1,
    generated_at: Date.now(),
    counts: {
      products: products.length,
      discrepant: products.filter((p) => p.status === 'discrepante').length,
      pending_inventory_queue: pendingQueue.length,
      other_pending_queue: otherPending.reduce((a, r) => a + r.n, 0),
      open_orders: openOrders,
      legacy_movements: movements,
    },
    products,
    pending_inventory_queue: pendingQueue,
    other_pending_queue: otherPending,
    notes: [
      'El saldo inicial NO se implementa automáticamente: cada producto requiere decisión del propietario.',
      'Las filas pendientes de sync_queue/inventory se pondrán en cuarentena; NUNCA se envían ni se borran.',
      'Los movimientos legacy se conservan y no se reinterpretan como operaciones V8.',
    ],
  };
}

/** Verifica decisiones antes de escribir. No modifica la BD. */
function validate(db, input = {}) {
  const report = input.report || analyze(db, input);
  const decisions = input.decisions || {};
  const errors = [];
  const accepted = new Map();
  const knownKeys = new Set(report.products.map((p) => p.key));
  for (const p of report.products) {
    if (!Object.prototype.hasOwnProperty.call(decisions, p.key)) {
      errors.push(`falta_decision:${p.key}`);
      continue;
    }
    const milli = toMilliSafe(decisions[p.key]);
    if (milli === null) errors.push(`decision_invalida:${p.key}`);
    else accepted.set(p.inventory_id, milli);
  }
  for (const k of Object.keys(decisions)) {
    if (!knownKeys.has(k)) errors.push(`decision_producto_desconocido:${k}`);
  }
  if (input.backupVerified !== true) errors.push('backup_no_verificado');
  return {
    ok: errors.length === 0,
    errors,
    accepted: Object.fromEntries([...accepted].map(([id, milli]) => [id, milli])),
    counts: report.counts,
  };
}

function ensureAudit(db) {
  db.exec(AUDIT_TABLES);
}

function recordChange(db, runId, table, rowKey, column, oldValue, newValue) {
  db.prepare(`INSERT INTO v8_migration_changes
    (run_id, table_name, row_key, column_name, old_value, new_value)
    VALUES (?,?,?,?,?,?)`).run(runId, table, String(rowKey), column,
      JSON.stringify(oldValue === undefined ? null : oldValue),
      JSON.stringify(newValue === undefined ? null : newValue));
}

/** Aplica la migración en una ÚNICA transacción; exige validate() previo. */
function apply(db, input = {}) {
  const validation = validate(db, input);
  if (!validation.ok) {
    throw new Error('validación fallida: ' + validation.errors.join(', '));
  }
  // El esquema V8 es aditivo e idempotente; se instala aquí para que las
  // columnas de saldo confirmado existan antes de escribirlas.
  require('./schema').applySchema(db);
  ensureAudit(db);
  const report = input.report || analyze(db, input);
  const decisions = input.decisions || {};
  const notes = input.notes || null;
  const started = Date.now();
  let runId;
  const counts = { products: 0, legacy_movements_marked: 0, queue_quarantined: 0,
    queue_rows_deleted: 0, queue_total_before: 0, queue_total_after: 0 };
  try {
    begin(db);
    // Los triggers legacy insertan en sync_queue cada UPDATE de inventory. Si no se
    // silencian, la migración crearía filas nuevas y luego las pondría en cuarentena.
    const flagExists = exists(db, '_sync_flag') && hasColumn(db, '_sync_flag', 'applying_remote');
    const oldFlag = flagExists
      ? (db.prepare(`SELECT applying_remote FROM _sync_flag WHERE rowid_pk=1`).get() || {}).applying_remote
      : null;
    if (flagExists) {
      db.prepare(`UPDATE _sync_flag SET applying_remote=1 WHERE rowid_pk=1`).run();
    }
    const queueTable = exists(db, 'sync_queue');
    counts.queue_total_before = queueTable
      ? db.prepare(`SELECT COUNT(*) AS n FROM sync_queue`).get().n : 0;
    // Snapshot ANTES de escribir: nunca se incluyen filas generadas por la propia migración.
    const queuedRows = queueTable
      ? db.prepare(`SELECT id, table_name, row_uuid, operation, created_at, synced
          FROM sync_queue WHERE table_name='inventory' AND (synced IS NULL OR synced=0)
            AND id NOT IN (SELECT queue_id FROM v8_migration_queue_quarantine) ORDER BY id`).all()
      : [];
    runId = Number(db.prepare(`INSERT INTO v8_migration_runs
      (command, status, decisions_json, counts_json, notes, created_at)
      VALUES ('apply','applying',?,?,?,?)`).run(
        JSON.stringify(decisions), JSON.stringify(counts), notes, started).lastInsertRowid);
    for (const p of report.products) {
      const before = db.prepare(`SELECT stock_confirmed_milli, confirmed_version FROM inventory WHERE id=?`).get(p.inventory_id);
      if (!before) throw new Error(`producto desapareció durante la migración: ${p.key}`);
      const nextVersion = Number(before.confirmed_version || 0) + 1;
      recordChange(db, runId, 'inventory', p.inventory_id, 'stock_confirmed_milli',
        before.stock_confirmed_milli, validation.accepted[p.inventory_id]);
      recordChange(db, runId, 'inventory', p.inventory_id, 'confirmed_version',
        before.confirmed_version, nextVersion);
      db.prepare(`UPDATE inventory SET stock_confirmed_milli=?, confirmed_version=? WHERE id=?`)
        .run(validation.accepted[p.inventory_id], nextVersion, p.inventory_id);
      db.prepare(`INSERT INTO v8_migration_products
        (run_id, inventory_id, inventory_uuid, name, legacy_stock_milli, accepted_milli, decision_source)
        VALUES (?,?,?,?,?,?,?)`).run(runId, p.inventory_id, p.inventory_uuid, p.name,
          p.legacy_stock_milli, validation.accepted[p.inventory_id],
          typeof decisions[p.key] === 'object' && decisions[p.key] ? decisions[p.key].source || null : null);
      counts.products += 1;
    }
    if (exists(db, 'stock_movements')) {
      const marked = db.prepare(`UPDATE stock_movements SET confirmation_state='legacy', origin='legacy'
        WHERE confirmation_state IS NULL OR origin IS NULL`).run().changes;
      counts.legacy_movements_marked = marked;
    }
    for (const q of queuedRows) {
      db.prepare(`INSERT INTO v8_migration_queue_quarantine
        (run_id, queue_id, table_name, row_uuid, operation, created_at, old_synced, payload_json)
        VALUES (?,?,?,?,?,?,?,?)`).run(runId, q.id, q.table_name, q.row_uuid, q.operation,
          q.created_at, q.synced === null ? null : Number(q.synced), JSON.stringify(q));
      // Conserva la fila; solo la marca como procesada para que el motor
      // legacy NO vuelva a enviar un stock absoluto incompatible con V8.
      db.prepare(`UPDATE sync_queue SET synced=1 WHERE id=?`).run(q.id);
      counts.queue_quarantined += 1;
    }
    counts.queue_total_after = queueTable
      ? db.prepare(`SELECT COUNT(*) AS n FROM sync_queue`).get().n : 0;
    if (counts.queue_total_after !== counts.queue_total_before) {
      throw new Error(`sync_queue cambió durante la migración: ${counts.queue_total_before} -> ${counts.queue_total_after}`);
    }
    if (flagExists) {
      db.prepare(`UPDATE _sync_flag SET applying_remote=? WHERE rowid_pk=1`)
        .run(oldFlag === undefined ? 0 : oldFlag);
    }
    db.prepare(`UPDATE v8_migration_runs SET status='applied', counts_json=?, finished_at=? WHERE run_id=?`)
      .run(JSON.stringify(counts), Date.now(), runId);
    commit(db);
  } catch (err) {
    rollback(db);
    // La transacción se revirtió; se registra el fallo en una corrida separada.
    ensureAudit(db);
    db.prepare(`INSERT INTO v8_migration_runs
      (command, status, decisions_json, counts_json, notes, created_at, finished_at)
      VALUES ('apply','failed',?,?,?,?,?)`).run(JSON.stringify(input.decisions || {}),
        JSON.stringify({ ...counts, error: err.message }), notes, started, Date.now());
    throw err;
  }
  return { runId, status: 'applied', counts, errors: [] };
}

/** Revierte una corrida aplicada SOLO si el remoto sigue intacto. Conserva auditoría. */
function rollbackRun(db, input = {}) {
  if (input.remoteUntouched !== true) {
    throw new Error('rollback requiere confirmar remoteUntouched=true (sin operaciones V8 aplicadas en remoto)');
  }
  ensureAudit(db);
  const run = db.prepare(`SELECT * FROM v8_migration_runs WHERE run_id=?`).get(input.runId);
  if (!run) throw new Error(`corrida no encontrada: ${input.runId}`);
  if (run.status !== 'applied') throw new Error(`la corrida ${input.runId} no está en estado applied`);
  const changes = db.prepare(`SELECT * FROM v8_migration_changes WHERE run_id=? ORDER BY change_id DESC`).all(input.runId);
  const counts = { inventory_columns_restored: 0, queue_rows_restored: 0,
    quarantine_rows_kept: 0, queue_total_before: 0, queue_total_after: 0 };
  try {
    begin(db);
    // Igual que en apply: los triggers legacy NO deben crear filas nuevas al revertir.
    const flagExists = exists(db, '_sync_flag') && hasColumn(db, '_sync_flag', 'applying_remote');
    const oldFlag = flagExists
      ? (db.prepare(`SELECT applying_remote FROM _sync_flag WHERE rowid_pk=1`).get() || {}).applying_remote
      : null;
    if (flagExists) {
      db.prepare(`UPDATE _sync_flag SET applying_remote=1 WHERE rowid_pk=1`).run();
    }
    counts.queue_total_before = exists(db, 'sync_queue')
      ? db.prepare(`SELECT COUNT(*) AS n FROM sync_queue`).get().n : 0;
    for (const c of changes) {
      const old = c.old_value === null ? null : JSON.parse(c.old_value);
      db.prepare(`UPDATE ${c.table_name} SET ${c.column_name}=? WHERE id=?`).run(old, c.row_key);
      counts.inventory_columns_restored += 1;
    }
    const qrows = db.prepare(`SELECT * FROM v8_migration_queue_quarantine WHERE run_id=? AND restored=0`).all(input.runId);
    for (const q of qrows) {
      db.prepare(`UPDATE sync_queue SET synced=? WHERE id=?`).run(q.old_synced === null ? 0 : q.old_synced, q.queue_id);
      db.prepare(`UPDATE v8_migration_queue_quarantine SET restored=1 WHERE quarantine_id=?`).run(q.quarantine_id);
      counts.queue_rows_restored += 1;
    }
    counts.quarantine_rows_kept = db.prepare(`SELECT COUNT(*) AS n FROM v8_migration_queue_quarantine WHERE run_id=?`).get(input.runId).n;
    counts.queue_total_after = exists(db, 'sync_queue')
      ? db.prepare(`SELECT COUNT(*) AS n FROM sync_queue`).get().n : 0;
    if (counts.queue_total_after !== counts.queue_total_before) {
      throw new Error(`sync_queue cambió durante el rollback: ${counts.queue_total_before} -> ${counts.queue_total_after}`);
    }
    if (flagExists) {
      db.prepare(`UPDATE _sync_flag SET applying_remote=? WHERE rowid_pk=1`)
        .run(oldFlag === undefined ? 0 : oldFlag);
    }
    db.prepare(`UPDATE v8_migration_runs SET status='rolled_back', notes=?, finished_at=? WHERE run_id=?`)
      .run(input.notes || 'rollback local; auditoría conservada', Date.now(), input.runId);
    commit(db);
  } catch (err) {
    rollback(db);
    throw err;
  }
  return { runId: Number(input.runId), status: 'rolled_back', counts, errors: [] };
}

module.exports = { analyze, validate, apply, rollback: rollbackRun, keyFor, fromMilli };
