'use strict';

/**
 * testApp.js — Fábrica de app Express aislada para tests
 *
 * Crea una instancia de Express con:
 *   - SQLite en memoria (sin tocar el archivo real)
 *   - Sesión de owner pre-insertada (para tests autenticados)
 *   - Todas las rutas montadas igual que en producción
 *
 * Uso:
 *   const { app, db } = buildTestApp();
 *   const { app, db } = buildTestApp({ withOwnerSession: false }); // sin sesión
 */

const express    = require('express');
const bodyParser = require('body-parser');
const Database   = require('better-sqlite3');
const bcrypt     = require('bcrypt');

const Validator      = require('../../validator');
const systemRoutes    = require('../../routes/system');
const configRoutes    = require('../../routes/config');
const menuRoute       = require('../../routes/menu');
const ordersRoutes    = require('../../routes/orders');
const employeesRoutes = require('../../routes/employees');
const customersRoutes = require('../../routes/customers');
const inventoryRoutes = require('../../routes/inventory');
const { tablesRouter, zonesRouter } = require('../../routes/tables');
const { requireSession, requireOwner } = require('../../middleware/requireAuth');
const errorHandler   = require('../../middleware/errorHandler');

// ── Definiciones de tablas ──────────────────────────────────────
// IMPORTANTE: se crean de una en una (no en un solo exec()) para evitar el
// error "object name reserved for internal use: sqlite_sequence" que ocurre
// cuando se ejecutan múltiples CREATE TABLE AUTOINCREMENT en un solo exec().
const TABLE_DEFINITIONS = [
  `CREATE TABLE IF NOT EXISTS config (
    id              INTEGER PRIMARY KEY,
    master_pass     TEXT,
    master_email    TEXT,
    restaurant_name TEXT    DEFAULT 'Test',
    address         TEXT    DEFAULT '',
    phone           TEXT    DEFAULT '',
    currency        TEXT    DEFAULT '$',
    taxRate         REAL    DEFAULT 0,
    ticketFooter    TEXT    DEFAULT '',
    commissions     TEXT    DEFAULT '{}',
    pay_methods     TEXT    DEFAULT '{}',
    printer_config  TEXT,
    logo            TEXT,
    supabase_url    TEXT,
    supabase_anon_key TEXT,
    session_token   TEXT,
    cloud_restaurant_id TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS local_session (
    id           INTEGER PRIMARY KEY,
    user_id      TEXT,
    email        TEXT,
    role         TEXT,
    name         TEXT,
    restaurant   TEXT,
    is_client    INTEGER DEFAULT 0,
    last_login   INTEGER,
    last_license INTEGER
  )`,

  // Schema completo de orders — debe coincidir con lo que usan las rutas
  `CREATE TABLE IF NOT EXISTS orders (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    subtotal       REAL,
    tax            REAL,
    total          REAL,
    discount       INTEGER,
    discountType   TEXT    DEFAULT 'percent',
    discountAmt    REAL,
    taxRate        REAL    DEFAULT 0,
    commissionAmt  REAL    DEFAULT 0,
    type           TEXT,
    tableId        INTEGER,
    customer       TEXT,
    status         TEXT,
    paymentMethod  TEXT,
    createdAt      INTEGER,
    waiterName     TEXT,
    openedAt       INTEGER,
    closedAt       INTEGER,
    updatedAt      INTEGER,
    paidAt         INTEGER,
    tableNumber    INTEGER,
    paymentStatus  TEXT    DEFAULT 'pending',
    deleted        INTEGER DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS order_items (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id  INTEGER,
    name      TEXT,
    price     REAL,
    qty       REAL,
    lineTotal REAL,
    note      TEXT,
    itemType  TEXT,
    invId     INTEGER,
    area      TEXT    DEFAULT 'cocina',
    status    TEXT    DEFAULT 'pending',
    createdAt INTEGER,
    deleted   INTEGER DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS menu_items (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT,
    price     REAL,
    cost      REAL,
    catId     INTEGER,
    subcatId  INTEGER,
    emoji     TEXT,
    available INTEGER DEFAULT 1,
    area      TEXT    DEFAULT 'cocina',
    is_promo  INTEGER DEFAULT 0,
    promo_label         TEXT,
    promo_desc          TEXT,
    promo_ends_at       INTEGER,
    promo_original_price REAL,
    promo_original_name TEXT,
    deleted   INTEGER DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS menu_ingredients (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    menu_item_id INTEGER,
    inv_id       INTEGER,
    qty          REAL
  )`,

  `CREATE TABLE IF NOT EXISTS inventory (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT,
    stock          REAL,
    minStock       REAL,
    unit           TEXT,
    cost           REAL,
    salePrice      REAL,
    category       TEXT,
    expirationDate TEXT,
    notes          TEXT,
    emoji          TEXT,
    showInPOS      INTEGER DEFAULT 0,
    area           TEXT    DEFAULT 'bar',
    deleted        INTEGER DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS categories (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT,
    emoji TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS subcategories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT,
    category_id INTEGER
  )`,

  `CREATE TABLE IF NOT EXISTS customers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT,
    phone      TEXT,
    email      TEXT,
    visits     INTEGER DEFAULT 0,
    totalSpent REAL    DEFAULT 0,
    points     INTEGER DEFAULT 0,
    deleted    INTEGER DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS employees (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    name   TEXT,
    role   TEXT,
    pin    TEXT,
    phone  TEXT,
    active INTEGER DEFAULT 1,
    deleted INTEGER DEFAULT 0
  )`,

  // Schema completo de tables — incluye columnas de zona, estado, etc.
  `CREATE TABLE IF NOT EXISTS tables (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT,
    zone_id        INTEGER,
    status         TEXT    DEFAULT 'free',
    waiterId       INTEGER,
    waiterName     TEXT,
    zona           TEXT    DEFAULT 'Salón',
    numero         INTEGER,
    guests         INTEGER,
    capacity       INTEGER,
    openedAt       INTEGER,
    lastOrderAt    INTEGER,
    currentOrderId INTEGER,
    deleted        INTEGER DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS zones (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS stock_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inventory_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    movement_type TEXT NOT NULL,
    quantity REAL NOT NULL,
    stock_before REAL NOT NULL,
    stock_after REAL NOT NULL,
    shortage_quantity REAL DEFAULT 0,
    reference_type TEXT,
    reference_id INTEGER,
    authorized_by TEXT,
    user_name TEXT,
    user_role TEXT,
    created_at INTEGER NOT NULL,
    uuid TEXT,
    updated_at INTEGER,
    device_id TEXT,
    deleted INTEGER DEFAULT 0
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_movements_uuid ON stock_movements(uuid)`,
];

// Hash bcrypt de 'testpass123' calculado una vez al cargar el módulo.
// Se usa en todas las instancias de buildTestApp para evitar recalcular.
const BCRYPT_HASH = bcrypt.hashSync('testpass123', 10);

/**
 * @param {object} opts
 * @param {boolean} [opts.withOwnerSession=true]  - Pre-insertar sesión de owner
 * @returns {{ app: import('express').Express, db: object, notifyChange: jest.Mock }}
 */
function buildTestApp({ withOwnerSession = true } = {}) {
  // DB en memoria — completamente aislada, sin side effects
  const native = new Database(':memory:');

  // Crear cada tabla por separado para evitar conflictos con sqlite_sequence
  for (const sql of TABLE_DEFINITIONS) {
    native.exec(sql);
  }

  // Insertar config con hash de 'testpass123'
  native.prepare('INSERT INTO config (id, master_pass) VALUES (1, ?)').run(BCRYPT_HASH);

  // Insertar la mesa "Caja" con id=1 (CAJA_TABLE_ID_SRV) para que los tests
  // que crean mesas con makeTable obtengan ids >= 2 y no colisionen con la Caja.
  native.prepare(`INSERT INTO tables (id, name, zone_id, status) VALUES (1, 'Caja', NULL, 'free')`).run();

  if (withOwnerSession) {
    native.prepare(
      `INSERT INTO local_session
         (id, user_id, email, role, name, restaurant, is_client)
       VALUES (1, ?, ?, ?, ?, ?, 0)`
    ).run('owner-test', 'owner@test.com', 'owner', 'Test Owner', 'Test Restó');
  }

  // Objeto db que imita la interfaz callback-style usada en las rutas de producción
  const db = {
    _native: native,

    get(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      const p = Array.isArray(params) ? params : (params !== undefined ? [params] : []);
      try {
        const row = native.prepare(sql).get(...p);
        if (typeof cb === 'function') cb(null, row);
        return row;
      } catch (e) {
        if (typeof cb === 'function') cb(e);
        else throw e;
      }
    },

    run(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      const p = Array.isArray(params) ? params : (params !== undefined ? [params] : []);
      try {
        const result = native.prepare(sql).run(...p);
        if (typeof cb === 'function') cb.call({ lastID: result.lastInsertRowid, changes: result.changes }, null);
        return result;
      } catch (e) {
        if (typeof cb === 'function') cb(e);
        else throw e;
      }
    },

    all(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      const p = Array.isArray(params) ? params : (params !== undefined ? [params] : []);
      try {
        const rows = native.prepare(sql).all(...p);
        if (typeof cb === 'function') cb(null, rows);
        return rows;
      } catch (e) {
        if (typeof cb === 'function') cb(e);
        else throw e;
      }
    },

    serialize(cb) { if (cb) cb(); return this; },

    // Shim de prepare(), espejo del adaptador de producción (db.js): permite
    // que las rutas que usan declaraciones preparadas (finalize, modify-items)
    // funcionen sobre la base en memoria del test.
    prepare(sql) {
      const stmt = native.prepare(sql);
      return {
        run: function (...args) {
          const lastArg = args[args.length - 1];
          const callback = typeof lastArg === 'function' ? args.pop() : null;
          const actualParams = args.length === 1 && Array.isArray(args[0])
            ? args[0]
            : args.map(p => (p === undefined ? null : p));
          try {
            const result = stmt.run(actualParams);
            if (callback) callback.call({ lastID: result.lastInsertRowid, changes: result.changes }, null);
            return result;
          } catch (e) {
            if (callback) callback(e);
            throw e;
          }
        },
        get: function (...args) {
          const lastArg = args[args.length - 1];
          const callback = typeof lastArg === 'function' ? args.pop() : null;
          const actualParams = args.length === 1 && Array.isArray(args[0])
            ? args[0]
            : args.map(p => (p === undefined ? null : p));
          try {
            const row = stmt.get(actualParams);
            if (callback) callback(null, row);
            return row;
          } catch (e) {
            if (callback) callback(e);
            throw e;
          }
        },
        all: function (...args) {
          const lastArg = args[args.length - 1];
          const callback = typeof lastArg === 'function' ? args.pop() : null;
          const actualParams = args.length === 1 && Array.isArray(args[0])
            ? args[0]
            : args.map(p => (p === undefined ? null : p));
          try {
            const rows = stmt.all(actualParams);
            if (callback) callback(null, rows);
            return rows;
          } catch (e) {
            if (callback) callback(e);
            throw e;
          }
        },
        finalize(cb) { if (typeof cb === 'function') cb(null); }
      };
    },
  };

  const notifyChange  = jest.fn(); // spy — verificable en tests
  const splitAndPrint = jest.fn().mockResolvedValue({ ok: true });

  const ctx = {
    requireSession: requireSession(db),
    requireOwner:   requireOwner(db),
    notifyChange,
    Validator,
    io:          null,
    splitAndPrint,
  };

  const app = express();
  app.use(bodyParser.json({ limit: '5mb' }));
  app.use(bodyParser.urlencoded({ extended: true }));

  app.use('/api/system',   systemRoutes(db, ctx));
  app.use('/api/config',   configRoutes(db, ctx));

  try {
    const { menuRouter, categoriesRouter, subcategoriesRouter } = menuRoute;
    app.use('/api/menu',          menuRouter(db, ctx));
    app.use('/api/categories',    categoriesRouter(db, ctx));
    app.use('/api/subcategories', subcategoriesRouter(db, ctx));
  } catch (_) { /* opcional */ }

  try {
    app.use('/api/inventory', inventoryRoutes(db, ctx));
  } catch (_) { /* opcional */ }

  try {
    app.use('/api/tables', tablesRouter(db, ctx));
    app.use('/api/zones',  zonesRouter(db, ctx));
  } catch (_) { /* opcional */ }

  try {
    app.use('/api/orders', ordersRoutes(db, ctx));
  } catch (_) { /* opcional */ }

  try {
    app.use('/api/employees', employeesRoutes(db, ctx));
  } catch (_) { /* opcional */ }

  try {
    app.use('/api/customers', customersRoutes(db, ctx));
  } catch (_) { /* opcional */ }

  app.use(errorHandler);

  return { app, db, notifyChange };
}

module.exports = { buildTestApp };