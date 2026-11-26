/**
 * Pruebas AISLADAS de la migración local V8 (§17).
 * SQLite en memoria: NUNCA se abre la BD real ni se contacta Supabase.
 */
'use strict';
const migration = require('../services/inventory-sync-v8/migration');

function openDb() {
  let Database;
  try { Database = require('better-sqlite3'); }
  catch (_) { Database = require('node:sqlite').DatabaseSync; }
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE inventory (id INTEGER PRIMARY KEY, uuid TEXT UNIQUE, name TEXT, stock REAL,
      stock_confirmed_milli INTEGER, confirmed_version INTEGER DEFAULT 0);
    INSERT INTO inventory (id, uuid, name, stock) VALUES
      (1, 'inv-1', 'Cerveza', 10), (2, 'inv-2', 'Café', 3.5);
    CREATE TABLE stock_movements (id INTEGER PRIMARY KEY, inventory_id INTEGER, quantity REAL,
      confirmation_state TEXT, origin TEXT);
    INSERT INTO stock_movements VALUES (1, 1, 2, NULL, NULL), (2, 2, 1, 'legacy', 'legacy');
    CREATE TABLE orders (id INTEGER PRIMARY KEY, uuid TEXT, status TEXT);
    INSERT INTO orders VALUES (1, 'ord-1', 'open'), (2, 'ord-2', 'closed');
    CREATE TABLE sync_queue (id INTEGER PRIMARY KEY, table_name TEXT, row_uuid TEXT,
      operation TEXT, created_at INTEGER, synced INTEGER);
    INSERT INTO sync_queue VALUES
      (10, 'inventory', 'inv-1', 'upsert', 1000, 0),
      (11, 'inventory', 'inv-2', 'upsert', 1001, 1),
      (12, 'orders', 'ord-1', 'upsert', 1002, 0);
  `);
  return db;
}
function snapshot(db) {
  return db.prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`).all();
}
function decisions() { return { 'inv-1': '10.25', 'inv-2': 3.5 }; }
function input(extra = {}) {
  return { decisions: decisions(), backupVerified: true, ...extra };
}

describe('migración local V8 (§17)', () => {
  test('analyze solo lee, marca discrepancias y detecta cola heredada', () => {
    const db = openDb();
    const before = snapshot(db);
    const report = migration.analyze(db, {
      remoteBalances: { 'inv-1': '10', 'inv-2': '3.5' },
      deviceReports: [
        { device_id: 'dev-a', balances: { 'inv-1': '10', 'inv-2': '3.5' } },
        { device_id: 'dev-b', balances: { 'inv-1': '9', 'inv-2': '3.5' } },
      ],
    });
    expect(snapshot(db)).toEqual(before);
    expect(report.counts.products).toBe(2);
    expect(report.counts.discrepant).toBe(1);
    expect(report.counts.pending_inventory_queue).toBe(1);
    expect(report.counts.open_orders).toBe(1);
    expect(report.products[0].status).toBe('discrepante');
    expect(report.products.every((p) => p.decision_required)).toBe(true);
    db.close();
  });

  test('validate exige decisión por producto y backup verificado', () => {
    const db = openDb();
    const missing = migration.validate(db, input({ decisions: { 'inv-1': 10 } }));
    expect(missing.ok).toBe(false);
    expect(missing.errors).toContain('falta_decision:inv-2');

    const noBackup = migration.validate(db, input({ backupVerified: false }));
    expect(noBackup.errors).toContain('backup_no_verificado');

    const unknown = migration.validate(db, input({ decisions: { ...decisions(), 'inv-otro': 1 } }));
    expect(unknown.errors).toContain('decision_producto_desconocido:inv-otro');

    const ok = migration.validate(db, input());
    expect(ok.ok).toBe(true);
    expect(ok.accepted['1']).toBe(10250);
    expect(ok.accepted['2']).toBe(3500);
    db.close();
  });

  test('apply no sobrescribe stock legacy, registra saldo aceptado y pone en cuarentena sin borrar', () => {
    const db = openDb();
    const validation = migration.validate(db, input());
    expect(validation.ok).toBe(true);
    const res = migration.apply(db, input({ notes: 'conteo físico 2026-11-24' }));

    expect(res.status).toBe('applied');
    expect(res.counts.products).toBe(2);
    expect(res.counts.legacy_movements_marked).toBe(1);
    expect(res.counts.queue_quarantined).toBe(1);
    expect(res.counts.queue_rows_deleted).toBe(0);

    // La columna legacy NO se toca: el saldo inicial solo vive en V8.
    expect(db.prepare(`SELECT stock FROM inventory WHERE id=1`).get().stock).toBe(10);
    expect(db.prepare(`SELECT stock_confirmed_milli, confirmed_version FROM inventory WHERE id=1`).get())
      .toEqual({ stock_confirmed_milli: 10250, confirmed_version: 1 });

    // Cuarentena: la fila sigue existiendo; solo se marca synced=1.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sync_queue`).get().n).toBe(3);
    expect(db.prepare(`SELECT synced FROM sync_queue WHERE id=10`).get().synced).toBe(1);
    const q = db.prepare(`SELECT * FROM v8_migration_queue_quarantine`).all();
    expect(q).toHaveLength(1);
    expect(q[0].queue_id).toBe(10);
    expect(JSON.parse(q[0].payload_json).row_uuid).toBe('inv-1');

    const run = db.prepare(`SELECT * FROM v8_migration_runs WHERE run_id=?`).get(res.runId);
    expect(run.status).toBe('applied');
    expect(JSON.parse(run.counts_json)).toEqual(res.counts);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM v8_migration_products WHERE run_id=?`).get(res.runId).n).toBe(2);
    expect(db.prepare(`SELECT confirmation_state, origin FROM stock_movements WHERE id=1`).get())
      .toEqual({ confirmation_state: 'legacy', origin: 'legacy' });
    db.close();
  });

  test('rollback revierte saldos y cuarentena, conserva auditoría y exige remoto intacto', () => {
    const db = openDb();
    const applied = migration.apply(db, input());
    expect(() => migration.rollback(db, { runId: applied.runId })).toThrow(/remoteUntouched/);

    const res = migration.rollback(db, { runId: applied.runId, remoteUntouched: true });
    expect(res.status).toBe('rolled_back');
    expect(res.counts.inventory_columns_restored).toBe(4);
    expect(res.counts.queue_rows_restored).toBe(1);
    expect(db.prepare(`SELECT stock_confirmed_milli, confirmed_version FROM inventory WHERE id=1`).get())
      .toEqual({ stock_confirmed_milli: null, confirmed_version: 0 });
    expect(db.prepare(`SELECT synced FROM sync_queue WHERE id=10`).get().synced).toBe(0);
    expect(db.prepare(`SELECT restored FROM v8_migration_queue_quarantine`).get().restored).toBe(1);
    expect(db.prepare(`SELECT status FROM v8_migration_runs WHERE run_id=?`).get(applied.runId).status)
      .toBe('rolled_back');
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sync_queue`).get().n).toBe(3);
    db.close();
  });

  test('los triggers legacy no crean filas nuevas en sync_queue durante apply', () => {
    const db = openDb();
    db.exec(`
      CREATE TABLE _sync_flag (rowid_pk INTEGER PRIMARY KEY, applying_remote INTEGER DEFAULT 0);
      INSERT INTO _sync_flag (rowid_pk, applying_remote) VALUES (1, 0);
      CREATE TRIGGER trg_inv_queue_legacy AFTER UPDATE ON inventory
        WHEN (SELECT applying_remote FROM _sync_flag WHERE rowid_pk=1) = 0
      BEGIN
        INSERT INTO sync_queue (table_name, row_uuid, operation, created_at, synced)
        VALUES ('inventory', NEW.uuid, 'upsert', 9999, 0);
      END;
    `);
    const res = migration.apply(db, input());
    expect(res.counts.queue_total_before).toBe(3);
    expect(res.counts.queue_total_after).toBe(3);
    expect(res.counts.queue_quarantined).toBe(1);
    expect(db.prepare(`SELECT applying_remote FROM _sync_flag WHERE rowid_pk=1`).get().applying_remote).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sync_queue`).get().n).toBe(3);

    const rb = migration.rollback(db, { runId: res.runId, remoteUntouched: true });
    expect(rb.counts.queue_total_before).toBe(3);
    expect(rb.counts.queue_total_after).toBe(3);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sync_queue`).get().n).toBe(3);
    expect(db.prepare(`SELECT applying_remote FROM _sync_flag WHERE rowid_pk=1`).get().applying_remote).toBe(0);
    db.close();
  });

  test('un fallo a mitad de apply revierte todo y registra la corrida fallida', () => {
    const db = openDb();
    db.exec(`CREATE TRIGGER fail_inv BEFORE UPDATE ON inventory WHEN NEW.id=2
             BEGIN SELECT RAISE(ABORT, 'fallo inyectado'); END`);
    expect(() => migration.apply(db, input())).toThrow(/fallo inyectado/);
    db.exec('DROP TRIGGER fail_inv');
    expect(db.prepare(`SELECT stock_confirmed_milli FROM inventory WHERE id=1`).get().stock_confirmed_milli)
      .toBeNull();
    expect(db.prepare(`SELECT synced FROM sync_queue WHERE id=10`).get().synced).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM v8_migration_products`).get().n).toBe(0);
    const failed = db.prepare(`SELECT status, counts_json FROM v8_migration_runs WHERE status='failed'`).get();
    expect(failed).toBeTruthy();
    expect(JSON.parse(failed.counts_json).error).toMatch(/fallo inyectado/);
    db.close();
  });
});
