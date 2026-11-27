/**
 * Pruebas de endurecimiento V8 (correctoras de C-01..C-04, A-01..A-04,
 * precios autoritativos, esquema seguro y vales offline).
 *
 * Todas las bases son SQLite en memoria o la BD de test de tests/helpers/testApp.
 * NINGUNA prueba contacta Supabase ni toca la base real del POS.
 */
'use strict';

const request = require('supertest');
const { buildTestApp } = require('./helpers/testApp');
const v8 = require('../services/inventory-sync-v8');
const dbModule = require('../db');

function openDb({ cloudRestaurantId = 'rest-1', supabaseUrl = 'http://localhost:54321', supabaseAnonKey = 'test-anon-key' } = {}) {
  let db;
  try {
    const Database = require('better-sqlite3');
    db = new Database(':memory:');
  } catch (_) {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(':memory:');
  }
  db.exec(`
    CREATE TABLE config (id INTEGER PRIMARY KEY, cloud_restaurant_id TEXT, supabase_url TEXT, supabase_anon_key TEXT);
    INSERT INTO config (id, cloud_restaurant_id, supabase_url, supabase_anon_key)
      VALUES (1, ${cloudRestaurantId ? `'${cloudRestaurantId}'` : 'NULL'},
                 ${supabaseUrl ? `'${supabaseUrl}'` : 'NULL'},
                 ${supabaseAnonKey ? `'${supabaseAnonKey}'` : 'NULL'});
    CREATE TABLE local_session (id INTEGER PRIMARY KEY, device_id TEXT, cloud_initial_backfill_done INTEGER DEFAULT 0);
    CREATE TABLE inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE, name TEXT NOT NULL,
      stock REAL DEFAULT 0, deleted INTEGER DEFAULT 0, salePrice REAL);
    CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE, status TEXT, createdAt INTEGER);
    CREATE TABLE order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT, order_id INTEGER, name TEXT,
      price REAL, qty REAL, note TEXT, itemType TEXT, invId INTEGER);
    CREATE TABLE stock_movements (id INTEGER PRIMARY KEY AUTOINCREMENT, inventory_id INTEGER NOT NULL,
      product_name TEXT, movement_type TEXT NOT NULL, quantity REAL NOT NULL, stock_before REAL,
      stock_after REAL, shortage_quantity REAL DEFAULT 0, reference_type TEXT, reference_id INTEGER,
      created_at INTEGER NOT NULL, deleted INTEGER DEFAULT 0);
    CREATE TABLE tables (id INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE menu_items (id INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE customers (id INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE employees (id INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE subcategories (id INTEGER PRIMARY KEY AUTOINCREMENT);
  `);
  return db;
}

function snapshot(db) {
  return {
    master: db.prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`).all(),
    tables: ['config', 'local_session', 'inventory', 'orders', 'order_items'].map((t) => ({
      table: t,
      columns: db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name),
    })),
  };
}

const BASE_ORDER = {
  subtotal: 100, tax: 0, total: 100,
  discount: 0, discountAmt: 0,
  type: 'takeaway', tableId: null,
  customer: 'Test', status: 'pending',
  waiterName: 'Test', openedAt: Date.now(),
};

// ═══════════════════════════════════════════════════════════════════════════
//  1. Precio autoritativo (rechazo de precios alterados)
// ═══════════════════════════════════════════════════════════════════════════
describe('validación de precio autoritativo', () => {
  let app, db;
  beforeEach(() => { ({ app, db } = buildTestApp({ withOwnerSession: true })); });

  test('rechaza precio de menú alterado con UNAUTHORIZED_PRICE', async () => {
    const menuId = db._native.prepare(
      `INSERT INTO menu_items (name, price, catId, available) VALUES ('Milanesa', 500, 1, 1)`
    ).run().lastInsertRowid;

    const res = await request(app).post('/api/orders/finalize').send({
      ...BASE_ORDER,
      items: [{ name: 'Milanesa', id: menuId, itemType: 'menu', price: 1, qty: 2, area: 'cocina' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNAUTHORIZED_PRICE');
  });

  test('rechaza precio de inventario alterado con UNAUTHORIZED_PRICE', async () => {
    const invId = db._native.prepare(
      `INSERT INTO inventory (name, stock, unit, salePrice) VALUES ('Cerveza', 10, 'unid', 80)`
    ).run().lastInsertRowid;

    const res = await request(app).post('/api/orders/finalize').send({
      ...BASE_ORDER,
      items: [{ name: 'Cerveza', invId, id: invId, itemType: 'inventory', price: 1, qty: 2, area: 'bar' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNAUTHORIZED_PRICE');
    // El stock NO se descuenta cuando el precio fue rechazado.
    expect(db._native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(10);
  });

  test('acepta diferencia dentro de la tolerancia de 0.01', async () => {
    const menuId = db._native.prepare(
      `INSERT INTO menu_items (name, price, catId, available) VALUES ('Café', 200, 1, 1)`
    ).run().lastInsertRowid;

    const res = await request(app).post('/api/orders/finalize').send({
      ...BASE_ORDER,
      items: [{ name: 'Café', id: menuId, itemType: 'menu', price: 200.01, qty: 1, area: 'bar' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.subtotal).toBeCloseTo(200, 0); // se factura el precio de BD
  });

  test('filas legacy sin precio de BD usan el precio del cliente como snapshot', async () => {
    const invId = db._native.prepare(
      `INSERT INTO inventory (name, stock, unit) VALUES ('Cerveza legacy', 10, 'unid')`
    ).run().lastInsertRowid;

    const res = await request(app).post('/api/orders/finalize').send({
      ...BASE_ORDER,
      items: [{ name: 'Cerveza legacy', invId, itemType: 'inventory', price: 80, qty: 3, area: 'bar' }],
    });
    expect(res.status).toBe(200);
    expect(db._native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(7);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  2. Política de esquema: interruptor apagado = BD intacta
// ═══════════════════════════════════════════════════════════════════════════
describe('política de esquema SQLite', () => {
  const ON = { LMM_INVENTORY_SYNC_V8: '1' };
  const OFF = {};

  test('con sync apagado no cambia tablas, columnas ni device_id', () => {
    const db = openDb({ cloudRestaurantId: null });
    const before = snapshot(db);

    const result = dbModule.initializeSchemaForStartup(db, ON);

    expect(result.syncEnabled).toBe(false);
    expect(result.schemaChanged).toBe(false);
    expect(result.v8Enabled).toBe(false);
    expect(snapshot(db)).toEqual(before);
    expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE name='schema_migrations'`).get()).toBeUndefined();
    const sessionRow = db.prepare(`SELECT device_id FROM local_session WHERE id=1`).get();
    expect(sessionRow && sessionRow.device_id).toBeFalsy();
  });

  test('con flag apagado, aunque la nube esté vinculada, V8 no instala esquema', () => {
    const db = openDb();

    const result = dbModule.initializeSchemaForStartup(db, OFF);

    expect(result.syncEnabled).toBe(true);          // legacy sigue encendido
    expect(result.v8Enabled).toBe(false);
    expect(result.v8Reasons).toContain('flag_off');
    expect(result.v8SchemaApplied).toBe(false);
    // El esquema LEGACY puede instalarse; el V8 (aditivo) jamás.
    expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE name='inventory_outbox'`).get()).toBeUndefined();
    expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE name='local_authorizations'`).get()).toBeUndefined();
    const v8Migration = db.prepare(`SELECT 1 FROM schema_migrations WHERE version = ?`)
      .get(dbModule.SYNC_SCHEMA_MIGRATION.version);
    expect(v8Migration).toBeUndefined();
  });

  test('con configuración incompleta, V8 no instala esquema', () => {
    for (const missing of ['cloudRestaurantId', 'supabaseUrl', 'supabaseAnonKey']) {
      const db = openDb({ [missing]: null });
      const result = dbModule.initializeSchemaForStartup(db, ON);
      expect(result.v8Enabled).toBe(false);
      expect(result.v8SchemaApplied).toBe(false);
      expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE name='inventory_outbox'`).get()).toBeUndefined();
      db.close();
    }
  });

  test('con sync y V8 encendidos instala esquema V8 y registra la migración', () => {
    const db = openDb();

    const result = dbModule.initializeSchemaForStartup(db, ON);

    expect(result.syncEnabled).toBe(true);
    expect(result.schemaChanged).toBe(true);
    expect(result.v8Enabled).toBe(true);
    expect(result.v8Reasons).toEqual([]);
    expect(result.v8SchemaApplied).toBe(true);
    expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE name='inventory_outbox'`).get()).toBeTruthy();
    const m = db.prepare(`SELECT * FROM schema_migrations WHERE version = ?`).get(dbModule.SYNC_SCHEMA_MIGRATION.version);
    expect(m.name).toBe('inventory_sync_v8_local_schema');
    expect(m.sync_required).toBe(1);
    expect(db.prepare(`SELECT device_id FROM local_session WHERE id=1`).get().device_id).toBeTruthy();
  });
});

describe('activación única V8', () => {
  const full = {
    cloud_restaurant_id: 'rest-1', supabase_url: 'http://localhost:54321', supabase_anon_key: 'k',
  };
  test('requiere flag + nube vinculada + credenciales', () => {
    expect(v8.activation.evaluate(full, {}).enabled).toBe(false);
    expect(v8.activation.evaluate(full, { LMM_INVENTORY_SYNC_V8: '1' }).enabled).toBe(true);
    expect(v8.activation.evaluate({ ...full, cloud_restaurant_id: null }, { LMM_INVENTORY_SYNC_V8: '1' }).reasons)
      .toContain('missing_cloud_restaurant_id');
    expect(v8.activation.evaluate({ ...full, supabase_url: null }, { LMM_INVENTORY_SYNC_V8: '1' }).reasons)
      .toContain('missing_supabase_url');
    expect(v8.activation.evaluate({ ...full, supabase_anon_key: null }, { LMM_INVENTORY_SYNC_V8: '1' }).reasons)
      .toContain('missing_supabase_anon_key');
  });

  test('isEnabled() sin db argumento lee la BD activa (regresión _getDb)', () => {
    const activeDb = openDb();
    const previousDb = dbModule.getDbForTesting();
    const prevFlag = process.env.LMM_INVENTORY_SYNC_V8;
    dbModule.setDbForTesting(activeDb);
    try {
      delete process.env.LMM_INVENTORY_SYNC_V8;
      expect(v8.isEnabled()).toBe(false);
      process.env.LMM_INVENTORY_SYNC_V8 = '1';
      expect(v8.activationState()).toEqual({ enabled: true, reasons: [] });
      expect(v8.isEnabled()).toBe(true);
      expect(dbModule.isV8Enabled()).toBe(true);
    } finally {
      dbModule.setDbForTesting(previousDb);
      if (prevFlag === undefined) delete process.env.LMM_INVENTORY_SYNC_V8;
      else process.env.LMM_INVENTORY_SYNC_V8 = prevFlag;
      activeDb.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  3. Vales offline (DEC-02 / A-03)
// ═══════════════════════════════════════════════════════════════════════════
describe('política de vales offline', () => {
  const now = Date.now();
  const baseRequest = {
    device_id: 'dev-1', scope: 'negative_stock',
    approver_membership_id: 'm-1', pin: '0000',
  };

  test('rechaza scope no permitido y TTL mayor a 12 h', () => {
    expect(v8.vouchers.validateRequest({ ...baseRequest, scope: 'other' }, now).reason).toBe('invalid_scope');
    const r = v8.vouchers.validateRequest({ ...baseRequest, offline_voucher: true, ttl_minutes: 5000 }, now);
    expect(r.ok).toBe(true);
    expect(r.request.ttl_minutes).toBe(720);
  });

  test('vale online no recibe gracia; vale offline sí (48 h)', () => {
    const db = openDb();
    v8.applySchema(db);
    const mk = (id, offline, validUntil) => db.prepare(
      `INSERT INTO local_authorizations
         (authorization_id, scope, valid_until, status, issued_to_device_id, offline_grace, revoked)
       VALUES (?, 'negative_stock', ?, 'available', 'dev-1', ?, 0)`
    ).run(id, validUntil, offline);

    mk('online', 0, now + 60 * 60 * 1000);
    mk('offline', 1, now + 60 * 60 * 1000);

    expect(v8.vouchers.validateForOperation(db, { authorizationId: 'online', deviceId: 'dev-1', now: now + 2 * 60 * 60 * 1000 }).reason)
      .toBe('expired');
    expect(v8.vouchers.validateForOperation(db, { authorizationId: 'offline', deviceId: 'dev-1', now: now + 2 * 60 * 60 * 1000 }).ok)
      .toBe(true);
    expect(v8.vouchers.validateForOperation(db, { authorizationId: 'offline', deviceId: 'dev-1', now: now + 50 * 60 * 60 * 1000 }).reason)
      .toBe('offline_grace_expired');
  });

  test('vale queda ligado al dispositivo y se puede revocar', () => {
    const db = openDb();
    v8.applySchema(db);
    db.prepare(
      `INSERT INTO local_authorizations
         (authorization_id, scope, valid_until, status, issued_to_device_id, offline_grace, revoked)
       VALUES ('v1', 'adjustment', ?, 'available', 'dev-1', 1, 0)`
    ).run(now + 60 * 60 * 1000);

    expect(v8.vouchers.validateForOperation(db, { authorizationId: 'v1', deviceId: 'dev-2', scope: 'adjustment', now }).reason)
      .toBe('wrong_device');
    v8.vouchers.revokeLocal(db, 'v1');
    expect(v8.vouchers.validateForOperation(db, { authorizationId: 'v1', deviceId: 'dev-1', scope: 'adjustment', now }).reason)
      .toBe('revoked_or_used');
  });

  test('límite de 5 vales offline vigentes por dispositivo', () => {
    const db = openDb();
    v8.applySchema(db);
    for (let i = 0; i < 5; i++) {
      v8.vouchers.saveIssued(db, { authorization_id: `v${i}`, valid_until: new Date(now + 3600000).toISOString() },
        { scope: 'negative_stock', device_id: 'dev-1', offline_voucher: true }, 'dev-1');
    }
    expect(v8.vouchers.countActiveOffline(db, 'dev-1', now)).toBe(5);
    expect(v8.vouchers.countActiveOffline(db, 'dev-2', now)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  4. Encolado de modify / cancel / reopen / return / adjust
// ═══════════════════════════════════════════════════════════════════════════
describe('encolado V8 de operaciones posteriores a la venta', () => {
  function fixture() {
    const db = openDb();
    v8.applySchema(db);
    db.prepare(`INSERT INTO inventory (id, uuid, name, stock, salePrice) VALUES (1, 'inv-1', 'Cerveza', 10, 80)`).run();
    db.prepare(`INSERT INTO orders (id, uuid, status) VALUES (1, 'ord-1', 'active')`).run();
    db.prepare(`INSERT INTO order_items (id, uuid, order_id, name, price, qty, itemType, invId)
                VALUES (1, 'item-1', 1, 'Cerveza', 80, 2, 'inventory', 1)`).run();
    return db;
  }
  test('encola modify, cancel y reopen con deduplicación', () => {
    const db = fixture();
    const ctx = { orderId: 1, deviceId: 'dev-1', userName: 'Ana' };
    const m1 = v8.hook.onOrderModified(db, ctx);
    const m2 = v8.hook.onOrderModified(db, ctx);
    expect(m1.enqueued).toBe(true);
    expect(m2.deduplicated).toBe(true);

    const c = v8.hook.onOrderCancelled(db, { ...ctx, expectedVersion: 1 });
    const r = v8.hook.onOrderReopened(db, { ...ctx, expectedVersion: 2 });
    expect(c.enqueued).toBe(true);
    expect(r.enqueued).toBe(true);
    const ops = db.prepare(`SELECT op_kind FROM inventory_outbox ORDER BY outbox_id`).all().map((x) => x.op_kind);
    expect(ops).toEqual(['modify', 'cancel', 'reopen']);
  });

  test('encola return y adjust_in / adjust_out', () => {
    const db = fixture();
    const ret = v8.hook.onOrderReturned(db, {
      orderId: 1, deviceId: 'dev-1', userName: 'Ana',
      sourceOperationId: 'op-sale',
      items: [{ invId: 1, name: 'Cerveza', price: 80, qty: 1 }],
    });
    const adj = v8.hook.onInventoryAdjusted(db, {
      inventoryId: 1, deviceId: 'dev-1', opKind: 'adjust_in', qty: 3, reason: 'conteo',
    });
    expect(ret.enqueued).toBe(true);
    expect(adj.enqueued).toBe(true);
    const ops = db.prepare(`SELECT op_kind FROM inventory_outbox ORDER BY outbox_id`).all().map((x) => x.op_kind);
    expect(ops).toEqual(['return', 'adjust_in']);
  });

  test('un vale de otro dispositivo impide encolar la operación', () => {
    const db = fixture();
    db.prepare(
      `INSERT INTO local_authorizations
         (authorization_id, scope, valid_until, status, issued_to_device_id, offline_grace, revoked)
       VALUES ('v1', 'adjustment', ?, 'available', 'dev-2', 1, 0)`
    ).run(Date.now() + 3600000);
    const r = v8.hook.onInventoryAdjusted(db, {
      inventoryId: 1, deviceId: 'dev-1', qty: 1, authorizationId: 'v1',
    });
    expect(r.enqueued).toBe(false);
    expect(r.reason).toBe('authorization_wrong_device');
    expect(db.prepare(`SELECT COUNT(*) AS c FROM inventory_outbox`).get().c).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  5. RPC con mock y activación/desactivación del motor
// ═══════════════════════════════════════════════════════════════════════════
describe('RPC y ciclo de vida del motor V8', () => {
  test('createRpc usa el mock de Supabase y normaliza errores sin lanzar', async () => {
    const calls = [];
    const supabase = {
      rpc: async (name, args) => {
        calls.push({ name, args });
        if (name === 'lmm_get_events') return { error: { status: 401, message: 'no autorizado' } };
        return { data: { status: 'ok' } };
      },
    };
    const rpc = v8.createRpc({ supabase, deviceId: 'dev-1', restaurantId: 'rest-1' });

    const applied = await rpc.applyOperation({ operation_id: 'op-1' });
    expect(applied.data.status).toBe('ok');
    expect(calls[0].name).toBe('lmm_apply_operation');

    const events = await rpc.getEvents({ fromSeq: 0, limit: 10 });
    expect(events.error.code).toBe('PT401');
    expect(events.error.network).toBe(false);
  });

  test('createRpc renueva la sesión autenticada del dispositivo piloto', async () => {
    let session = null;
    const logins = [];
    const supabase = {
      auth: {
        getSession: async () => ({ data: { session } }),
        signInWithPassword: async ({ email, password }) => {
          logins.push({ email, password });
          session = { access_token: 'token', expires_at: Math.floor(Date.now() / 1000) + 3600 };
          return { error: null };
        },
      },
      rpc: async () => ({ data: { status: 'ok' } }),
    };
    const prevEmail = process.env.SUPABASE_AUTH_EMAIL;
    const prevPassword = process.env.SUPABASE_AUTH_PASSWORD;
    process.env.SUPABASE_AUTH_EMAIL = 'pilot@example.invalid';
    process.env.SUPABASE_AUTH_PASSWORD = 'secreto-de-prueba';
    try {
      const rpc = v8.createRpc({ supabase, deviceId: 'dev-1', restaurantId: 'rest-1' });
      expect((await rpc.getSnapshot()).data.status).toBe('ok');
      expect((await rpc.getSnapshot()).data.status).toBe('ok');
      expect(logins).toHaveLength(1);
      expect(logins[0].email).toBe('pilot@example.invalid');
    } finally {
      if (prevEmail === undefined) delete process.env.SUPABASE_AUTH_EMAIL;
      else process.env.SUPABASE_AUTH_EMAIL = prevEmail;
      if (prevPassword === undefined) delete process.env.SUPABASE_AUTH_PASSWORD;
      else process.env.SUPABASE_AUTH_PASSWORD = prevPassword;
    }
  });

  test('startV8Engine / stopV8Engine respetan la condición única', () => {
    const sync = require('../sync-engine');
    const db = openDb();
    v8.applySchema(db);
    sync.setDbForTesting(db);
    const prev = process.env.LMM_INVENTORY_SYNC_V8;
    const params = { supabaseUrl: 'http://localhost:54321', supabaseAnonKey: 'test-key', restaurantId: 'rest-1' };
    try {
      delete process.env.LMM_INVENTORY_SYNC_V8;
      sync.startV8Engine(params);
      expect(sync.getV8Engine()).toBeNull();

      process.env.LMM_INVENTORY_SYNC_V8 = '1';
      sync.startV8Engine(params);
      expect(sync.getV8Engine()).not.toBeNull();
      sync.stopV8Engine();
      expect(sync.getV8Engine()).toBeNull();
    } finally {
      sync.stopV8Engine();
      sync.clearDbOverride();
      if (prev === undefined) delete process.env.LMM_INVENTORY_SYNC_V8;
      else process.env.LMM_INVENTORY_SYNC_V8 = prev;
    }
  });

  test('startV8Engine no arranca con configuración incompleta', () => {
    const sync = require('../sync-engine');
    const prev = process.env.LMM_INVENTORY_SYNC_V8;
    const params = { supabaseUrl: 'http://localhost:54321', supabaseAnonKey: 'test-key', restaurantId: 'rest-1' };
    try {
      process.env.LMM_INVENTORY_SYNC_V8 = '1';
      for (const missing of ['cloudRestaurantId', 'supabaseUrl', 'supabaseAnonKey']) {
        const db = openDb({ [missing]: null });
        sync.setDbForTesting(db);
        sync.startV8Engine(params);
        expect(sync.getV8Engine()).toBeNull();
        db.close();
      }
    } finally {
      sync.stopV8Engine();
      sync.clearDbOverride();
      if (prev === undefined) delete process.env.LMM_INVENTORY_SYNC_V8;
      else process.env.LMM_INVENTORY_SYNC_V8 = prev;
    }
  });
});
