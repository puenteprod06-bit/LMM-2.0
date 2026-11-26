'use strict';

/**
 * tests/sync-integration.test.js
 *
 * Pruebas de integración de sync-engine contra SQLite en memoria (:memory:).
 * Inyecta una instancia independiente de better-sqlite3 mediante
 * setDbForTesting() para NO tocar la base de producción.
 *
 * Cubre:
 *  1. Inserción de un registro válido vía applyRemoteRow.
 *  2. Actualización de un registro válido vía applyRemoteRow.
 *  3. Rechazo de tabla no permitida.
 *  4. Rechazo de columnas desconocidas.
 *  5. Rechazo de payloads malformados.
 *  6. Exclusión de campos sensibles (pin, master_pass, session_token).
 *  7. Protección del ID autoincremental (no se escribe desde remoto).
 *  8. Protección frente a inyección SQL (nombres de tabla y columna).
 *  9. Compatibilidad con registros legítimos de tablas sincronizadas.
 * 10. Sanitización de salida (sanitizeOutputColumns) excluye sensibles.
 */

const Database = require('better-sqlite3');
const syncEngine = require('../sync-engine');

const {
  applyRemoteRow,
  isAllowedTable,
  sanitizeRemoteColumns,
  sanitizeOutputColumns,
  flushQueue,
  setDbForTesting,
  clearDbOverride,
  getDbForTesting,
  setSupabaseForTesting,
  clearSupabaseOverride,
  SYNC_TABLES,
  ALLOWED_COLUMNS,
  OUTPUT_COLUMNS,
  SENSITIVE_FIELDS,
} = syncEngine;

const { DEVICE_ID } = require('../db');

// ══════════════════════════════════════════════════════════════════════════
//  Esquema de las tablas sincronizadas (mismo que db.js, columnas reales)
// ══════════════════════════════════════════════════════════════════════════

const SCHEMA = {
  _sync_flag: `
    CREATE TABLE _sync_flag (
      rowid_pk INTEGER PRIMARY KEY DEFAULT 1,
      applying_remote INTEGER DEFAULT 0
    );
    INSERT OR IGNORE INTO _sync_flag (rowid_pk, applying_remote) VALUES (1, 0)`,
  sync_queue: `
    CREATE TABLE sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      row_uuid TEXT NOT NULL,
      operation TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      synced INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sync_queue_pending ON sync_queue (synced, created_at)`,
  employees: `
    CREATE TABLE employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT, role TEXT, pin TEXT, phone TEXT, active INTEGER,
      uuid TEXT, updated_at INTEGER, device_id TEXT, deleted INTEGER DEFAULT 0
    )`,
  categories: `
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT, emoji TEXT, image_url TEXT,
      uuid TEXT, updated_at INTEGER, device_id TEXT, deleted INTEGER DEFAULT 0
    )`,
  subcategories: `
    CREATE TABLE subcategories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT, category_id INTEGER, image_url TEXT,
      uuid TEXT, updated_at INTEGER, device_id TEXT, deleted INTEGER DEFAULT 0
    )`,
  menu_items: `
    CREATE TABLE menu_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT, price REAL, cost REAL, catId INTEGER, emoji TEXT,
      image_url TEXT, available INTEGER, area TEXT, subcatId INTEGER,
      is_promo INTEGER, promo_label TEXT, promo_ends_at INTEGER,
      promo_original_price REAL, promo_desc TEXT, promo_original_name TEXT,
      is_combo INTEGER, combo_items TEXT,
      uuid TEXT, updated_at INTEGER, device_id TEXT, deleted INTEGER DEFAULT 0
    )`,
  inventory: `
    CREATE TABLE inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT, stock REAL, minStock REAL, unit TEXT, cost REAL,
      salePrice REAL, category TEXT, expirationDate TEXT, notes TEXT,
      emoji TEXT, showInPOS INTEGER, area TEXT,
      uuid TEXT, updated_at INTEGER, device_id TEXT, deleted INTEGER DEFAULT 0
    )`,
  customers: `
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT, phone TEXT, email TEXT, visits INTEGER,
      totalSpent REAL, points INTEGER,
      uuid TEXT, updated_at INTEGER, device_id TEXT, deleted INTEGER DEFAULT 0
    )`,
  tables: `
    CREATE TABLE tables (
      id INTEGER PRIMARY KEY,
      capacity INTEGER, status TEXT, waiterId INTEGER, waiterName TEXT,
      zona TEXT, numero INTEGER, guests INTEGER,
      openedAt INTEGER, sort_order INTEGER, lastOrderAt INTEGER,
      currentOrderId INTEGER,
      uuid TEXT, updated_at INTEGER, device_id TEXT, deleted INTEGER DEFAULT 0
    )`,
  orders: `
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subtotal REAL, tax REAL, total REAL, discount INTEGER,
      discountAmt REAL, commissionAmt REAL DEFAULT 0, type TEXT,
      tableId INTEGER, customer TEXT, status TEXT, paymentMethod TEXT,
      createdAt INTEGER, waiterName TEXT, openedAt INTEGER, closedAt INTEGER,
      updatedAt INTEGER, tableNumber INTEGER, paymentStatus TEXT,
      discountType TEXT, paidAt INTEGER, taxRate REAL,
      uuid TEXT, updated_at INTEGER, device_id TEXT, deleted INTEGER DEFAULT 0
    )`,
  order_items: `
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER, name TEXT, price REAL, qty REAL, lineTotal REAL,
      note TEXT, itemType TEXT, invId INTEGER, area TEXT, status TEXT,
      createdAt INTEGER, order_uuid TEXT,
      uuid TEXT, updated_at INTEGER, device_id TEXT, deleted INTEGER DEFAULT 0
    )`,
};

function makeMemoryDb() {
  const native = new Database(':memory:');
  for (const [table, sql] of Object.entries(SCHEMA)) {
    native.exec(sql);
  }
  return native;
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

beforeEach(() => {
  setDbForTesting(makeMemoryDb());
});

afterEach(() => {
  clearDbOverride();
  clearSupabaseOverride();
});

describe('DB en memoria — diagnóstico applyRemoteRow', () => {
  test('imprime DEVICE_ID para depuración', () => {
    console.log('DEVICE_ID:', DEVICE_ID);
    console.log('typeof DEVICE_ID:', typeof DEVICE_ID);
    expect(DEVICE_ID).toBeDefined();
  });

  test('sanitizeRemoteColumns para empleados válidos', () => {
    const safe = sanitizeRemoteColumns('employees', {
      name: 'Ana', role: 'waiter', phone: '123', active: 1,
    });
    expect(safe).toEqual({ name: 'Ana', role: 'waiter', phone: '123', active: 1 });
  });

  test('SELECT inicial retorna undefined para uuid inexistente', () => {
    const db = getDbForTesting();
    const local = db.prepare('SELECT id, updated_at FROM employees WHERE uuid = ?').get('no-existe');
    expect(local).toBeUndefined();
  });

  test('INSERT directo en empleados funciona', () => {
    const db = getDbForTesting();
    db.prepare(
      `INSERT INTO employees (name, role, phone, active, uuid, updated_at, device_id, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('Ana', 'waiter', '123', 1, 'test-uuid-direct', Date.now(), 'dev-test', 0);
    const row = db.prepare('SELECT * FROM employees WHERE uuid = ?').get('test-uuid-direct');
    expect(row).toBeDefined();
    expect(row.name).toBe('Ana');
  });

  test('UPDATE _sync_flag funciona en DB de prueba', () => {
    const db = getDbForTesting();
    const result = db.prepare("UPDATE _sync_flag SET applying_remote = 1 WHERE rowid_pk = 1").run();
    expect(result.changes).toBe(1);
    db.prepare("UPDATE _sync_flag SET applying_remote = 0 WHERE rowid_pk = 1").run();
  });
});

describe('sync-engine — integración SQLite (:memory:)', () => {
  describe('isAllowedTable / SYNC_TABLES (unificación)', () => {
    test('SYNC_TABLES coincide con las tablas del esquema', () => {
      for (const table of Object.keys(SCHEMA)) {
        if (table === '_sync_flag' || table === 'sync_queue') continue; // tablas de control, no de datos
        expect(SYNC_TABLES).toContain(table);
      }
      expect(SYNC_TABLES).not.toContain('config');
      expect(SYNC_TABLES).not.toContain('local_session');
      expect(SYNC_TABLES).not.toContain('sync_queue');
    });

    test('isAllowedTable devuelve true para tablas de SYNC_TABLES', () => {
      for (const table of SYNC_TABLES) {
        expect(isAllowedTable(table)).toBe(true);
      }
    });
  });

  describe('applyRemoteRow — inserción de registros válidos', () => {
    test('inserta un empleado válido', () => {
      const u = uuid();
      applyRemoteRow('employees', {
        uuid: u,
        device_id: 'otro-dispositivo',
        updated_at: Date.now(),
        data: { name: 'Ana', role: 'waiter', phone: '123', active: 1 },
      });
      const row = _getRow('employees', u);
      expect(row).toBeDefined();
      expect(row.name).toBe('Ana');
      expect(row.role).toBe('waiter');
    });

    test('inserta una mesa válida', () => {
      const u = uuid();
      applyRemoteRow('tables', {
        uuid: u,
        device_id: 'otro-dispositivo',
        updated_at: Date.now(),
        data: { capacity: 4, status: 'free', zona: 'Salón', numero: 5 },
      });
      const row = _getRow('tables', u);
      expect(row).toBeDefined();
      expect(row.capacity).toBe(4);
      expect(row.status).toBe('free');
    });

    test('inserta una orden y sus ítems (compatibilidad)', () => {
      const orderUuid = uuid();
      applyRemoteRow('orders', {
        uuid: orderUuid,
        device_id: 'otro-dispositivo',
        updated_at: Date.now(),
        data: {
          subtotal: 100, tax: 21, total: 121, type: 'dine-in',
          status: 'pending', tableId: 1, customer: 'Juan',
          paymentMethod: 'cash', createdAt: Date.now(),
        },
      });
      const order = _getRow('orders', orderUuid);
      expect(order).toBeDefined();
      expect(order.total).toBe(121);

      const itemUuid = uuid();
      applyRemoteRow('order_items', {
        uuid: itemUuid,
        device_id: 'otro-dispositivo',
        updated_at: Date.now(),
        data: {
          order_uuid: orderUuid, name: 'Pizza', price: 100, qty: 1,
          lineTotal: 100, status: 'pending',
        },
      });
      const item = _getRow('order_items', itemUuid);
      expect(item).toBeDefined();
      expect(item.name).toBe('Pizza');
      expect(item.order_uuid).toBe(orderUuid);
    });
  });

  describe('applyRemoteRow — actualización de registros existentes', () => {
    test('actualiza una mesa existente', () => {
      const u = uuid();
      // Inserción inicial
      applyRemoteRow('tables', {
        uuid: u, device_id: 'otro', updated_at: 1000,
        data: { capacity: 4, status: 'free', zona: 'Salón', numero: 1 },
      });
      // Actualización (más nueva)
      applyRemoteRow('tables', {
        uuid: u, device_id: 'otro', updated_at: 2000,
        data: { status: 'occupied', guests: 2 },
      });
      const row = _getRow('tables', u);
      expect(row.status).toBe('occupied');
      expect(row.guests).toBe(2);
      expect(row.capacity).toBe(4); // se conserva lo que no se actualizó
    });

    test('no sobrescribe si el local es igual o más nuevo', () => {
      const u = uuid();
      applyRemoteRow('employees', {
        uuid: u, device_id: 'otro', updated_at: 5000,
        data: { name: 'Viejo', role: 'waiter' },
      });
      // Intento con timestamp más antiguo: no debe cambiar
      applyRemoteRow('employees', {
        uuid: u, device_id: 'otro', updated_at: 1000,
        data: { name: 'Nuevo', role: 'cashier' },
      });
      const row = _getRow('employees', u);
      expect(row.name).toBe('Viejo');
    });
  });

  describe('applyRemoteRow — rechazos de seguridad', () => {
    test('rechaza tabla no permitida', () => {
      const u = uuid();
      expect(() => {
        applyRemoteRow('config', { uuid: u, device_id: 'x', data: { name: 'x' } });
      }).not.toThrow();
      expect(() => {
        applyRemoteRow('local_session', { uuid: u, device_id: 'x', data: { role: 'owner' } });
      }).not.toThrow();
      // No debe escribir nada
      expect(_getRow('employees', u)).toBeUndefined();
    });

    test('rechaza inyección SQL vía nombre de tabla', () => {
      const injections = [
        "employees; DROP TABLE employees--",
        "employees' OR '1'='1",
        "0; DELETE FROM sqlite_master--",
      ];
      for (const bad of injections) {
        expect(() => {
          applyRemoteRow(bad, { uuid: 'x', device_id: 'y', data: { name: 'x' } });
        }).not.toThrow();
      }
    });

    test('rechaza inyección SQL vía nombres de columna', () => {
      const u = uuid();
      const maliciousCols = {
        name: 'Juan',
        "role = 1; DROP TABLE employees--": 'x',
        "phone'; DELETE FROM employees--": 'x',
      };
      applyRemoteRow('employees', {
        uuid: u, device_id: 'otro', updated_at: Date.now(),
        data: maliciousCols,
      });
      const row = _getRow('employees', u);
      expect(row).toBeDefined();
      expect(row.name).toBe('Juan');
      // Las columnas inyectadas no deben existir
      const cols = _getDb().prepare(`PRAGMA table_info(employees)`).all().map((c) => c.name);
      expect(cols).not.toContain("role = 1; DROP TABLE employees--");
      expect(cols).not.toContain("phone'; DELETE FROM employees--");
    });

    test('rechaza payload malformado (no objeto)', () => {
      expect(() => applyRemoteRow('employees', null)).not.toThrow();
      expect(() => applyRemoteRow('employees', 'texto')).not.toThrow();
      expect(() => applyRemoteRow('employees', [1, 2])).not.toThrow();
      expect(() => applyRemoteRow('employees', 42)).not.toThrow();
    });

    test('rechaza payload sin uuid', () => {
      expect(() => {
        applyRemoteRow('employees', { data: { name: 'Juan' } });
      }).not.toThrow();
    });

    test('rechaza payload sin columnas escribibles', () => {
      expect(() => {
        applyRemoteRow('employees', { uuid: 'abc', data: { id: 1, pin: '1234' } });
      }).not.toThrow();
    });
  });

  describe('applyRemoteRow — exclusión de campos sensibles y protección de id', () => {
    test('excluye pin, master_pass, session_token de la escritura', () => {
      const u = uuid();
      applyRemoteRow('employees', {
        uuid: u, device_id: 'otro', updated_at: Date.now(),
        data: {
          name: 'Juan', role: 'waiter',
          pin: '1234', master_pass: 'hash', session_token: 'tok',
        },
      });
      const row = _getRow('employees', u);
      expect(row.name).toBe('Juan');
      expect(row.role).toBe('waiter');
      // pin no debe haberse escrito (queda NULL/default)
      expect(row.pin).toBeNull();
    });

    test('no escribe el id local autoincremental desde remoto', () => {
      const u = uuid();
      applyRemoteRow('employees', {
        uuid: u, device_id: 'otro', updated_at: Date.now(),
        data: { id: 99999, name: 'Juan' },
      });
      const row = _getRow('employees', u);
      expect(row).toBeDefined();
      // id debe ser el auto-generado, no 99999
      expect(row.id).not.toBe(99999);
      expect(typeof row.id).toBe('number');
    });
  });

  describe('sanitizeOutputColumns (envío a Supabase)', () => {
    test('excluye campos sensibles del payload de salida', () => {
      // Insertar una fila con campo sensible
      const u = uuid();
      const db = _getDb();
      db.prepare(`INSERT INTO employees (id, name, role, pin, active, uuid)
        VALUES (1, 'Juan', 'waiter', 'secreto-pin', 1, ?)`).run(u);

      const out = sanitizeOutputColumns('employees', {
        id: 1, name: 'Juan', role: 'waiter', pin: 'secreto-pin',
        master_pass: 'hash', active: 1, uuid: u,
      });
      expect(out.pin).toBeUndefined();
      expect(out.master_pass).toBeUndefined();
      expect(out.name).toBe('Juan');
      expect(out.role).toBe('waiter');
      expect(out.uuid).toBe(u);
    });

    test('OUTPUT_COLUMNS cubre todas las tablas de SYNC_TABLES', () => {
      for (const table of SYNC_TABLES) {
        expect(OUTPUT_COLUMNS[table]).toBeDefined();
        expect(Array.isArray(OUTPUT_COLUMNS[table])).toBe(true);
        expect(OUTPUT_COLUMNS[table].length).toBeGreaterThan(0);
      }
    });

    test('no incluye pin ni master_pass en ninguna salida', () => {
      for (const [table, cols] of Object.entries(OUTPUT_COLUMNS)) {
        expect(cols).not.toContain('pin');
        expect(cols).not.toContain('master_pass');
        expect(cols).not.toContain('session_token');
      }
    });
  });

  describe('ALLOWED_COLUMNS y SENSITIVE_FIELDS', () => {
    test('ALLOWED_COLUMNS cubre todas las tablas', () => {
      for (const table of SYNC_TABLES) {
        expect(ALLOWED_COLUMNS[table]).toBeDefined();
      }
    });

    test('SENSITIVE_FIELDS contiene campos críticos', () => {
      expect(SENSITIVE_FIELDS).toContain('pin');
      expect(SENSITIVE_FIELDS).toContain('master_pass');
      expect(SENSITIVE_FIELDS).toContain('session_token');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  Pruebas de extremo a extremo: payload final enviado a Supabase
  // ═══════════════════════════════════════════════════════════════════════════
  describe('flushQueue — payload de salida (extremo a extremo)', () => {
    const mockPayloads = [];

    function makeMockSupabase() {
      mockPayloads.length = 0;
      return {
        from: () => ({
          upsert: async (rows, _opts) => {
            mockPayloads.push(...rows);
            return { error: null };
          },
        }),
      };
    }

    beforeEach(() => {
      setSupabaseForTesting(makeMockSupabase());
    });

    afterEach(() => {
      clearSupabaseOverride();
    });

    test('envía payload sin local_id ni campos internos innecesarios', async () => {
      const u = uuid();
      const db = getDbForTesting();
      db.prepare(
        `INSERT INTO employees (name, role, phone, active, uuid, updated_at, device_id, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('Ana', 'waiter', '123', 1, u, Date.now(), 'dev-test', 0);
      // Encolar en sync_queue como lo haría el trigger de db.js
      db.prepare(
        `INSERT INTO sync_queue (table_name, row_uuid, operation, created_at, synced)
         VALUES (?, ?, ?, ?, ?)`
      ).run('employees', u, 'upsert', Date.now(), 0);

      await flushQueue();

      expect(mockPayloads.length).toBe(1);
      const payload = mockPayloads[0];

      // uuid, restaurant_id, updated_at, device_id, deleted en nivel raíz
      expect(payload.uuid).toBe(u);
      expect(payload.restaurant_id).toBeDefined();
      expect(typeof payload.updated_at).toBe('number');
      expect(payload.device_id).toBeDefined();
      expect(payload.deleted).toBe(false);

      // data contiene solo columnas de OUTPUT_COLUMNS
      expect(payload.data).toBeDefined();
      expect(payload.data.name).toBe('Ana');
      expect(payload.data.role).toBe('waiter');
      expect(payload.data.uuid).toBe(u);

      // No debe contener local_id (metadato interno de SQLite)
      expect(payload.local_id).toBeUndefined();

      // No debe contener campos sensibles dentro de data
      expect(payload.data.pin).toBeUndefined();
      expect(payload.data.master_pass).toBeUndefined();
      expect(payload.data.session_token).toBeUndefined();
    });

    test('propaga deleted=true cuando una fila está marcada como eliminada', async () => {
      const u = uuid();
      const db = getDbForTesting();
      db.prepare(
        `INSERT INTO tables (numero, status, zona, uuid, updated_at, device_id, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(5, 'free', 'Salón', u, Date.now(), 'dev-test', 1);
      db.prepare(
        `INSERT INTO sync_queue (table_name, row_uuid, operation, created_at, synced)
         VALUES (?, ?, ?, ?, ?)`
      ).run('tables', u, 'upsert', Date.now(), 0);

      await flushQueue();

      expect(mockPayloads.length).toBe(1);
      const payload = mockPayloads[0];
      expect(payload.deleted).toBe(true);
    });

    test('no envía PIN ni contraseñas en data de employees', async () => {
      const u = uuid();
      const db = getDbForTesting();
      db.prepare(
        `INSERT INTO employees (name, role, pin, active, uuid, updated_at, device_id, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('Juan', 'waiter', 'pin-secreto', 1, u, Date.now(), 'dev-test', 0);
      db.prepare(
        `INSERT INTO sync_queue (table_name, row_uuid, operation, created_at, synced)
         VALUES (?, ?, ?, ?, ?)`
      ).run('employees', u, 'upsert', Date.now(), 0);

      await flushQueue();

      expect(mockPayloads.length).toBe(1);
      const payload = mockPayloads[0];
      expect(payload.data.pin).toBeUndefined();
      expect(payload.data.name).toBe('Juan');
      expect(payload.data.role).toBe('waiter');
    });

    test('rechaza envío cuando supabase no está configurado', async () => {
      clearSupabaseOverride(); // supabase = null
      const u = uuid();
      const db = getDbForTesting();
      db.prepare(
        `INSERT INTO employees (name, role, uuid, updated_at, device_id, deleted)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('Ana', 'waiter', u, Date.now(), 'dev-test', 0);

      // No debe lanzar excepción
      await expect(flushQueue()).resolves.toBeUndefined();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Helpers internos
// ══════════════════════════════════════════════════════════════════════════

function _getDb() {
  return getDbForTesting();
}

function _getRow(table, uuid) {
  return _getDb()
    .prepare(`SELECT * FROM ${table} WHERE uuid = ?`)
    .get(uuid);
}
