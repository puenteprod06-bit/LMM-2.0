// ============================================================
//  db.js — Adaptador que emula la API asíncrona de sqlite3
//  usando better-sqlite3 internamente
// ============================================================

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

logger.info('🔧 [DB] Cargando adaptador de base de datos...');

// Ruta de la base de datos
const appDataPath = process.env.APPDATA 
  || (process.platform === 'darwin'
      ? path.join(process.env.HOME, 'Library', 'Preferences')
      : path.join(process.env.HOME, '.local', 'share'));

const dbDir = path.join(appDataPath, 'la-mente-maestra');
const dbPath = path.join(dbDir, 'database.sqlite');

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
  logger.info('📁 [DB] Carpeta de datos creada en:', dbDir);
}

logger.info('-------------------------------------------');
logger.info('📁 Ruta:', dbPath);
logger.info('-------------------------------------------');

// Abrir base de datos
const _db = new Database(dbPath);
_db.pragma('journal_mode = WAL');

// ═════════════════════════════════════════════════════════════════════════
//  SOBRESCRITURA DE DB PARA PRUEBAS
//
//  Permite inyectar una instancia de better-sqlite3 independiente (p. ej.
//  :memory:) para pruebas de integración sin tocar la base de producción.
//  applyRemoteChange usa _getDb() para respetar el override.
// ═════════════════════════════════════════════════════════════════════════

let _dbOverride = null;

function _getDb() {
  return _dbOverride || _db;
}

function setDbForTesting(db) {
  _dbOverride = db;
}

function clearDbOverride() {
  _dbOverride = null;
}

// ══════════════════════════════════════════════════════════════════════════
//  REGISTRO DE MIGRACIONES — política de esquema explícita
//
//  schema_migrations versióna cada cambio aplicado a la base local, con una
//  marca sync_required que indica si la migración solo debe ejecutarse cuando
//  la sincronización con la nube está habilitada. Con el interruptor apagado,
//  ninguna migración de sincronización se aplica al arrancar el POS: la base
//  local solo recibe el esquema mínimo que necesita la app.
// ══════════════════════════════════════════════════════════════════════════

// Migración local que instala el esquema del módulo inventory-sync-v8.
// sync_required = 1: NUNCA se aplica automáticamente con el interruptor apagado.
const SYNC_SCHEMA_MIGRATION = Object.freeze({
  version: 2026112301,
  name: 'inventory_sync_v8_local_schema',
  syncRequired: true,
});

function ensureSchemaMigrationsTable(db = _getDb()) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      sync_required INTEGER NOT NULL DEFAULT 0,
      applied_at INTEGER NOT NULL
    );
  `);
}

function migrationApplied(version, db = _getDb()) {
  const row = db.prepare(`SELECT 1 FROM schema_migrations WHERE version = ?`).get();
  return !!row;
}

function recordMigration(version, name, syncRequired, db = _getDb()) {
  db.prepare(
    `INSERT OR IGNORE INTO schema_migrations (version, name, sync_required, applied_at) VALUES (?, ?, ?, ?)`
  ).run(version, name, syncRequired ? 1 : 0, Date.now());
}

/**
 * Sincronización LEGACY (nube vinculada): solo comprueba restaurant_id.
 * NO autoriza V8. V8 usa getV8ActivationState()/isV8Enabled() más abajo.
 */
function isSyncEnabled(db = _getDb()) {
  try {
    const row = db.prepare(`SELECT cloud_restaurant_id FROM config WHERE id = 1`).get();
    return !!(row && row.cloud_restaurant_id);
  } catch (e) {
    return false;
  }
}

/**
 * CONDICIÓN ÚNICA DE V8 (flag + nube vinculada + credenciales completas).
 * Todos los puntos que encienden el motor o instalan su esquema usan esta
 * función; nunca se comprueba LMM_INVENTORY_SYNC_V8 por separado.
 */
function getV8ActivationState(db = _getDb(), env = process.env) {
  return activation.state(db, env);
}
function isV8Enabled(db = _getDb(), env = process.env) {
  return getV8ActivationState(db, env).enabled;
}

/**
 * Obtiene (o crea) el device_id persistente. Solo se persiste en local_session
 * cuando la sincronización está habilitada; con el interruptor apagado se
 * devuelve un id efímero SIN ESCRIBIR en la base (política "sync off = DB intacta").
 */
function computeDeviceId(db, syncEnabled) {
  if (!syncEnabled) return crypto.randomUUID();
  addColumnIfMissing('local_session', 'device_id', 'TEXT', db);
  try {
    const row = db.prepare("SELECT device_id FROM local_session WHERE id = 1").get();
    if (row && row.device_id) return row.device_id;
    const newId = crypto.randomUUID();
    db.prepare("INSERT OR IGNORE INTO local_session (id) VALUES (1)").run();
    db.prepare("UPDATE local_session SET device_id = COALESCE(device_id, ?) WHERE id = 1").run(newId);
    return db.prepare("SELECT device_id FROM local_session WHERE id = 1").get().device_id || newId;
  } catch (err) {
    logger.warn('⚠️ [SYNC] No se pudo persistir device_id, usando uno efímero:', err.message);
    return crypto.randomUUID();
  }
}

logger.info('✅ [DB] Conectado a better-sqlite3');

// ============================================================
//  Helper para sanitizar parámetros (convierte undefined en null)
// ============================================================
function sanitizeParams(params) {
  if (!params) return [];
  if (!Array.isArray(params)) return [params];
  return params.map(p => (p === undefined ? null : p));
}

// ============================================================
//  Objeto que emula la API asíncrona de sqlite3
// ============================================================
const db = {
  // Método para ejecutar SQL (con callback)
  run: function(sql, params, callback) {
    let actualParams = [];
    let actualCallback = callback;
    
    if (typeof params === 'function') {
      actualCallback = params;
      actualParams = [];
    } else if (params !== undefined && params !== null) {
      actualParams = sanitizeParams(params);
    }
    
    if (typeof actualCallback === 'function') {
      try {
        const stmt = _db.prepare(sql);
        const result = stmt.run(actualParams);
        // Bind result as `this` so routes can use `this.lastID` (compatible con la API original de sqlite3)
        actualCallback.call({ lastID: result.lastInsertRowid, changes: result.changes }, null);
      } catch (err) {
        actualCallback.call({}, err);
      }
    } else {
      const stmt = _db.prepare(sql);
      return stmt.run(actualParams);
    }
    return this;
  },

  // Método para obtener una fila
  get: function(sql, params, callback) {
    let actualParams = [];
    let actualCallback = callback;
    
    if (typeof params === 'function') {
      actualCallback = params;
      actualParams = [];
    } else if (params !== undefined && params !== null) {
      actualParams = sanitizeParams(params);
    }
    
    try {
      const stmt = _db.prepare(sql);
      const row = stmt.get(actualParams);
      if (typeof actualCallback === 'function') {
        actualCallback(null, row);
      }
      return row;
    } catch (err) {
      if (typeof actualCallback === 'function') {
        actualCallback(err);
      } else {
        throw err;
      }
    }
  },

  // Método para obtener todas las filas
  all: function(sql, params, callback) {
    let actualParams = [];
    let actualCallback = callback;
    
    if (typeof params === 'function') {
      actualCallback = params;
      actualParams = [];
    } else if (params !== undefined && params !== null) {
      actualParams = sanitizeParams(params);
    }
    
    try {
      const stmt = _db.prepare(sql);
      const rows = stmt.all(actualParams);
      if (typeof actualCallback === 'function') {
        actualCallback(null, rows);
      }
      return rows;
    } catch (err) {
      if (typeof actualCallback === 'function') {
        actualCallback(err);
      } else {
        throw err;
      }
    }
  },

  // Método para ejecutar múltiples operaciones en serie
  serialize: function(callback) {
    try {
      if (callback) callback();
    } catch (err) {
      logger.error('Error en serialize:', err);
    }
    return this;
  },

  // Método para ejecutar SQL directamente
  exec: function(sql, callback) {
    try {
      _db.exec(sql);
      if (callback) callback(null);
    } catch (err) {
      if (callback) callback(err);
      else throw err;
    }
    return this;
  },

  // Método para preparar una declaración
  prepare: function(sql) {
    const stmt = _db.prepare(sql);
    return {
      // Acepta tanto un array como argumentos posicionales (spread), igual que sqlite3.
      // Ej: stmt.run([a,b,c]) o stmt.run(a, b, c) o stmt.run(a, b, callback)
      run: function(...args) {
        const lastArg = args[args.length - 1];
        const callback = typeof lastArg === 'function' ? args.pop() : null;
        const actualParams = args.length === 1 && Array.isArray(args[0])
          ? sanitizeParams(args[0])
          : args.map(p => (p === undefined ? null : p));
        try {
          const result = stmt.run(actualParams);
          if (callback) callback.call({ lastID: result.lastInsertRowid, changes: result.changes }, null);
          return result;
        } catch (err) {
          if (callback) callback(err);
          throw err;
        }
      },
      get: function(...args) {
        const lastArg = args[args.length - 1];
        const callback = typeof lastArg === 'function' ? args.pop() : null;
        const actualParams = args.length === 1 && Array.isArray(args[0])
          ? sanitizeParams(args[0])
          : args.map(p => (p === undefined ? null : p));
        try {
          const row = stmt.get(actualParams);
          if (callback) callback(null, row);
          return row;
        } catch (err) {
          if (callback) callback(err);
          throw err;
        }
      },
      all: function(...args) {
        const lastArg = args[args.length - 1];
        const callback = typeof lastArg === 'function' ? args.pop() : null;
        const actualParams = args.length === 1 && Array.isArray(args[0])
          ? sanitizeParams(args[0])
          : args.map(p => (p === undefined ? null : p));
        try {
          const rows = stmt.all(actualParams);
          if (callback) callback(null, rows);
          return rows;
        } catch (err) {
          if (callback) callback(err);
          throw err;
        }
      },
      // better-sqlite3 no necesita finalize(), pero muchas rutas heredadas lo llaman.
      // No-op para compatibilidad con la API de sqlite3.
      finalize: function(callback) {
        if (typeof callback === 'function') callback(null);
      }
    };
  },

  // Propiedad para acceder a la instancia original
  _native: _db
};

// ============================================================
//  FUNCIÓN PARA AGREGAR COLUMNAS
// ============================================================
function addColumnIfMissing(table, column, definition, db) {
  const d = db || _getDb();
  try {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    logger.info(`✅ Columna ${table}.${column} agregada`);
  } catch (err) {
    if (!err.message.includes('duplicate column column') && !err.message.includes('duplicate column name')) {
      logger.warn(`⚠️ No se pudo agregar ${table}.${column}:`, err.message);
    }
  }
}

// ============================================================
//  CREACIÓN DE TABLAS
// ============================================================
try {
  db.exec(`
  CREATE TABLE IF NOT EXISTS zones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
  );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      emoji TEXT,
      image_url TEXT
    );

    CREATE TABLE IF NOT EXISTS config (
      id INTEGER PRIMARY KEY,
      restaurant_name TEXT,
      master_email TEXT,
      master_pass TEXT,
      address TEXT,
      phone TEXT,
      currency TEXT,
      taxRate REAL,
      ticketFooter TEXT,
      commissions TEXT,
      pay_methods TEXT,
      logo TEXT
    );

    CREATE TABLE IF NOT EXISTS menu_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      cost REAL DEFAULT 0,
      catId INTEGER DEFAULT 1,
      emoji TEXT DEFAULT 'restaurant',
      available INTEGER DEFAULT 1,
      image_url TEXT
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      stock REAL DEFAULT 0,
      minStock REAL DEFAULT 5,
      unit TEXT DEFAULT 'unidad',
      cost REAL DEFAULT 0,
      salePrice REAL DEFAULT 0,
      category TEXT DEFAULT 'General',
      expirationDate TEXT,
      notes TEXT,
      emoji TEXT DEFAULT 'inventory_2',
      showInPOS INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS menu_ingredients (
      menu_item_id INTEGER,
      inv_id INTEGER,
      qty REAL
    );

    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      role TEXT,
      pin TEXT,
      phone TEXT,
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      phone TEXT,
      email TEXT,
      visits INTEGER DEFAULT 0,
      totalSpent REAL DEFAULT 0,
      points INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subtotal REAL,
      tax REAL,
      total REAL,
      discount INTEGER,
      discountAmt REAL,
      commissionAmt REAL DEFAULT 0,
      type TEXT,
      tableId INTEGER,
      customer TEXT,
      status TEXT,
      paymentMethod TEXT,
      createdAt INTEGER,
      waiterName TEXT,
      groupKey TEXT
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER,
      name TEXT,
      price REAL,
      qty REAL,
      lineTotal REAL,
      note TEXT,
      itemType TEXT,
      invId INTEGER,
      menuItemId INTEGER
    );

    CREATE TABLE IF NOT EXISTS tables (
      id INTEGER PRIMARY KEY,
      capacity INTEGER,
      status TEXT,
      waiterId INTEGER,
      waiterName TEXT,
      zona TEXT DEFAULT 'Salón',
      numero INTEGER,
      guests INTEGER
    );

    CREATE TABLE IF NOT EXISTS local_session (
      id INTEGER PRIMARY KEY DEFAULT 1,
      email TEXT,
      role TEXT,
      name TEXT,
      restaurant TEXT,
      is_client INTEGER DEFAULT 0,
      last_login INTEGER,
      last_license INTEGER,
      app_version TEXT
    );
  `);
  logger.info("✅ [DB] Tablas creadas");
} catch (err) {
  logger.error("❌ Error creando tablas:", err.message);
}

// Agregar columnas faltantes
addColumnIfMissing('config', 'pay_methods', 'TEXT');
addColumnIfMissing('config', 'logo', 'TEXT');
addColumnIfMissing('config', 'printer_config', 'TEXT');
addColumnIfMissing('config', 'session_token',  'TEXT');
addColumnIfMissing('tables', 'zona', "TEXT DEFAULT 'Salón'");
addColumnIfMissing('tables', 'numero', 'INTEGER');
addColumnIfMissing('tables', 'guests', 'INTEGER');
addColumnIfMissing('menu_items', 'area', "TEXT DEFAULT 'cocina'");
addColumnIfMissing('menu_items', 'subcatId', 'INTEGER');
// Columnas para el sistema de promociones temporales
addColumnIfMissing('menu_items', 'is_promo',             'INTEGER DEFAULT 0');
addColumnIfMissing('menu_items', 'promo_label',          'TEXT');
addColumnIfMissing('menu_items', 'promo_ends_at',        'INTEGER');
addColumnIfMissing('menu_items', 'promo_original_price', 'REAL');
addColumnIfMissing('menu_items', 'promo_desc',           'TEXT');
addColumnIfMissing('menu_items', 'promo_original_name',  'TEXT');
// Columnas para el sistema de combos
addColumnIfMissing('menu_items', 'is_combo',    'INTEGER DEFAULT 0');
addColumnIfMissing('menu_items', 'combo_items', 'TEXT DEFAULT NULL'); // JSON array de {id, qty}
addColumnIfMissing('inventory', 'area', "TEXT DEFAULT 'bar'");
addColumnIfMissing('order_items', 'area', "TEXT DEFAULT 'cocina'");
addColumnIfMissing('order_items', 'status', "TEXT DEFAULT 'pending'");
// id real de menu_items. El `id` de la fila NO sirve para validar precios.
addColumnIfMissing('order_items', 'menuItemId', 'INTEGER');
addColumnIfMissing('tables', 'openedAt',       'INTEGER');
addColumnIfMissing('tables', 'sort_order',     'INTEGER DEFAULT 0');
addColumnIfMissing('tables', 'lastOrderAt',    'INTEGER');
addColumnIfMissing('tables', 'currentOrderId', 'INTEGER');
addColumnIfMissing('orders', 'openedAt', 'INTEGER');
addColumnIfMissing('orders', 'closedAt', 'INTEGER');
addColumnIfMissing('orders', 'updatedAt', 'INTEGER');
addColumnIfMissing('orders', 'tableNumber', 'INTEGER');
addColumnIfMissing('orders', 'paymentStatus', "TEXT DEFAULT 'pending'");
addColumnIfMissing('orders', 'discountType', "TEXT DEFAULT 'percent'");
addColumnIfMissing('orders', 'paidAt', 'INTEGER');
addColumnIfMissing('orders', 'taxRate', 'REAL DEFAULT 0');
// Agrupa las órdenes de una mesa fusionada para cobrar/imprimir una sola cuenta.
addColumnIfMissing('orders', 'groupKey', 'TEXT');
addColumnIfMissing('order_items', 'status', "TEXT DEFAULT 'pending'");
addColumnIfMissing('order_items', 'createdAt', 'INTEGER');

// ============================================================
//  FUNCIÓN PARA AGREGAR ÍNDICES (SI NO EXISTEN)
// ============================================================
function addIndexIfMissing(indexName, table, columns) {
  const columnList = Array.isArray(columns) ? columns.join(', ') : columns;
  const sql = `CREATE INDEX IF NOT EXISTS ${indexName} ON ${table} (${columnList})`;
  try {
    _db.exec(sql);
    logger.info(`✅ Índice ${indexName} creado en ${table}(${columnList})`);
  } catch (err) {
    logger.warn(`⚠️ No se pudo crear índice ${indexName}:`, err.message);
  }
}

// ============================================================
//  CREACIÓN DE ÍNDICES ESTRATÉGICOS PARA OPTIMIZACIÓN
// ============================================================
logger.info('📇 [DB] Creando índices para optimización de consultas...');

// Órdenes activas por mesa (la más crítica)
addIndexIfMissing('idx_orders_table_status', 'orders', ['tableId', 'status']);

// Reportes por fecha
addIndexIfMissing('idx_orders_created_at', 'orders', 'createdAt');

// Órdenes activas por mesero
addIndexIfMissing('idx_orders_waiter_status', 'orders', ['waiterName', 'status']);

// Items de una orden con estado (útil para cocina/barra)
addIndexIfMissing('idx_order_items_order_status', 'order_items', ['order_id', 'status']);

// Vista de cocina por área (status + area)
addIndexIfMissing('idx_order_items_status_area', 'order_items', ['status', 'area']);

// Menú por categoría filtrando solo activos
addIndexIfMissing('idx_menu_items_cat_available', 'menu_items', ['catId', 'available']);

// Asegurar tabla subcategories con todas sus columnas (por si ya existía incompleta)
try {
  _db.exec(`CREATE TABLE IF NOT EXISTS subcategories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category_id INTEGER NOT NULL DEFAULT 0,
    image_url TEXT
  )`);
} catch(e) {}
addColumnIfMissing('subcategories', 'name', 'TEXT NOT NULL DEFAULT ""');
addColumnIfMissing('subcategories', 'category_id', 'INTEGER NOT NULL DEFAULT 0');

// ============================================================
//  NUEVAS TABLAS: SEGURIDAD, VENTAS, OPERACIÓN
// ============================================================
try {
  _db.exec(`
    CREATE TABLE IF NOT EXISTS security_config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      supervisor_pin TEXT,
      pin_triggers TEXT DEFAULT '{}',
      role_permissions TEXT DEFAULT '{}'
    );
    INSERT OR IGNORE INTO security_config (id) VALUES (1);

    CREATE TABLE IF NOT EXISTS predefined_discounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      value REAL NOT NULL,
      type TEXT NOT NULL DEFAULT 'percent',
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS caja_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL DEFAULT 'open',
      opening_amount REAL DEFAULT 0,
      closing_amount REAL,
      opened_at INTEGER NOT NULL,
      closed_at INTEGER,
      opened_by TEXT,
      closed_by TEXT,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS ticket_config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      format TEXT DEFAULT '{}',
      autoprint TEXT DEFAULT '{}'
    );
    INSERT OR IGNORE INTO ticket_config (id) VALUES (1);

    CREATE TABLE IF NOT EXISTS business_hours (
      id INTEGER PRIMARY KEY DEFAULT 1,
      hours TEXT DEFAULT '{}'
    );
    INSERT OR IGNORE INTO business_hours (id) VALUES (1);

    CREATE TABLE IF NOT EXISTS stock_alert_config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      enabled INTEGER DEFAULT 1,
      threshold REAL DEFAULT 5
    );
    INSERT OR IGNORE INTO stock_alert_config (id) VALUES (1);

    CREATE TABLE IF NOT EXISTS work_shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
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
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_movements_uuid ON stock_movements(uuid);
  `);
  logger.info('✅ [DB] Tablas de configuración extendida creadas');
} catch(e) {
  logger.warn('⚠️ [DB] Tablas de config extendida (ya existen o error menor):', e.message);
}

// ============================================================
//  IMPORTANTE: NO insertamos fila vacía en config
//  La fila se creará SOLO cuando el primer login exitoso ocurra
//  Esto evita el conflicto de "PC nueva vs PC configurada"
// ============================================================
logger.info('[DB] Configuración: Esperando primer login para crear registro');

// ── Zona por defecto (solo estructura, sin datos de menú hardcodeados) ──
// Los datos de ejemplo se cargan SOLO si el usuario lo confirma
// en el onboarding → POST /api/system/load-sample-data
db.get("SELECT COUNT(*) as count FROM zones", (err, row) => {
  if (row && row.count === 0) {
    db.run("INSERT INTO zones (name) VALUES ('Salón')");
  }
});

// ============================================================
//  HELPERS DE SESIÓN LOCAL
// ============================================================

function saveLocalSession(sessionData) {
  const { email, role, name, restaurant, isClient } = sessionData;
  const { version: appVersion } = require('./package.json');
  try {
    addColumnIfMissing('local_session', 'app_version', 'TEXT');
    const stmt = _db.prepare(`INSERT OR REPLACE INTO local_session 
      (id, email, role, name, restaurant, is_client, last_login, app_version)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)`);
    stmt.run(safeLower(email), role || 'staff', name || '', restaurant || '', isClient ? 1 : 0, Date.now(), appVersion);
    logger.info('💾 [DB] Sesión guardada (v' + appVersion + ')');
  } catch (err) {
    logger.error('Error guardando sesión:', err.message);
  }
}

function getLocalSession() {
  return new Promise((resolve) => {
    try {
      addColumnIfMissing('local_session', 'app_version', 'TEXT');
      const row = _db.prepare("SELECT * FROM local_session WHERE id = 1").get();
      if (!row) return resolve(null);

      // Si la sesión fue guardada por una versión mayor diferente, limpiarla
      // para forzar re-login sin perder los datos del restaurante
      const { version: currentVersion } = require('./package.json');
      const currentMajor = parseInt(currentVersion.split('.')[0], 10);
      const sessionMajor = row.app_version
        ? parseInt(row.app_version.split('.')[0], 10)
        : 0; // sesión vieja sin versión → siempre limpiar

      if (sessionMajor !== currentMajor) {
        logger.info(`[DB] Sesión de v${row.app_version || '?'} detectada en v${currentVersion} — limpiando sesión (datos intactos)`);
        _db.prepare("DELETE FROM local_session WHERE id = 1").run();
        return resolve(null);
      }

      resolve(row);
    } catch (err) {
      logger.error('Error leyendo sesión:', err.message);
      resolve(null);
    }
  });
}

function clearLocalSession() {
  try {
    _db.prepare("DELETE FROM local_session WHERE id = 1").run();
    logger.info('🗑️ [DB] Sesión borrada');
  } catch (err) {
    logger.error('Error borrando sesión:', err.message);
  }
}

function updateLicenseTimestamp() {
  try {
    _db.prepare("UPDATE local_session SET last_license = ? WHERE id = 1").run(Date.now());
  } catch (err) {
    logger.error('Error actualizando timestamp:', err.message);
  }
}

// ============================================================
//  HELPER: REGISTRAR MOVIMIENTO DE STOCK
//  Inserta un registro en stock_movements para trazabilidad.
//  Se llama desde routes/orders.js y routes/inventory.js.
// ============================================================
function recordStockMovement({
  inventoryId,
  productName,
  movementType,
  quantity,
  stockBefore,
  stockAfter,
  shortageQuantity = 0,
  referenceType = null,
  referenceId = null,
  authorizedBy = null,
  userName = null,
  userRole = null,
  deviceId = DEVICE_ID,
  idempotencyKey = null,
}) {
  try {
    // UUID determinístico para idempotencia: si se proporciona un idempotencyKey,
    // se usa para generar el UUID. Si no, se genera uno aleatorio.
    // Esto permite que reintentos de la misma operación no generen duplicados.
    let uuid;
    if (idempotencyKey) {
      const crypto = require('crypto');
      // Generar un UUID v4-formato determinístico a partir del hash del key
      const hash = crypto.createHash('sha256').update(idempotencyKey).digest('hex');
      uuid = [
        hash.substring(0, 8),
        hash.substring(8, 12),
        '4' + hash.substring(13, 16), // version 4
        ((parseInt(hash.substring(16, 17), 16) & 0x3) | 0x8).toString(16) + hash.substring(17, 20),
        hash.substring(20, 32),
      ].join('-');
    } else {
      uuid = require('crypto').randomUUID();
    }

    // INSERT OR IGNORE: si el UUID ya existe, no se inserta (idempotencia)
    const result = _getDb().prepare(`INSERT OR IGNORE INTO stock_movements
      (inventory_id, product_name, movement_type, quantity, stock_before, stock_after,
       shortage_quantity, reference_type, reference_id, authorized_by, user_name, user_role,
       created_at, uuid, updated_at, device_id, deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        inventoryId, productName, movementType, quantity, stockBefore, stockAfter,
        shortageQuantity, referenceType, referenceId, authorizedBy, userName, userRole,
        Date.now(), uuid, Date.now(), deviceId, 0
      );

    return result.changes > 0; // true si se insertó, false si ya existía
  } catch (err) {
    logger.error('[STOCK] Error registrando movimiento:', err.message);
    return false;
  }
}

function safeLower(val) {
  if (val === null || val === undefined) return '';
  return String(val).toLowerCase().trim();
}

function safeStr(val, fallback = '') {
  if (val === null || val === undefined || val === '') return fallback;
  return String(val).trim();
}

function safeJSON(str, fallback = {}) {
  try {
    if (!str) return fallback;
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

// ── Migración de inicio: corregir inconsistencias de estado ──────────────
// 1. Mesas con status='available' (bug del /api/orders/pay anterior) → 'free'
// 2. Órdenes sin paymentMethod cuya mesa ya está libre → cancelar como huérfanas
// 3. Mesas libres que aún tienen mesero/guests/openedAt asignado → limpiar
try {
  _db.exec(`UPDATE tables SET status='free' WHERE status='available'`);

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  // Cancelar órdenes huérfanas (sin pago, mesa libre, de días anteriores)
  const orphanIds = _db.prepare(`
    SELECT o.id FROM orders o
    LEFT JOIN tables t ON t.id = o.tableId
    WHERE o.paymentMethod IS NULL
      AND o.status NOT IN ('delivered','cancelled')
      AND o.tableId IS NOT NULL
      AND (t.status IN ('free','available') OR t.id IS NULL)
      AND o.createdAt < ?
  `).all(startOfToday.getTime()).map(r => r.id);

  if (orphanIds.length > 0) {
    _db.prepare(
      `UPDATE orders SET status='cancelled', paymentMethod='voided_orphan', closedAt=?
       WHERE id IN (${orphanIds.map(() => '?').join(',')})`
    ).run(Date.now(), ...orphanIds);
    console.warn(`[DB Init] Auto-canceladas ${orphanIds.length} orden(es) huérfana(s): [${orphanIds.join(',')}]`);
  }

  // Limpiar mesero/guests/openedAt de mesas que están libres pero tienen datos sucios
  // (ocurre cuando la mesa quedó como 'available'/'free' pero el cierre fue incompleto)
  const dirtyFreeTables = _db.prepare(`
    SELECT id FROM tables
    WHERE status = 'free'
      AND (waiterId IS NOT NULL OR waiterName IS NOT NULL OR openedAt IS NOT NULL OR guests IS NOT NULL)
  `).all();

  if (dirtyFreeTables.length > 0) {
    const tIds = dirtyFreeTables.map(t => t.id);
    _db.prepare(
      `UPDATE tables SET waiterId=NULL, waiterName=NULL, openedAt=NULL, guests=NULL, currentOrderId=NULL
       WHERE id IN (${tIds.map(() => '?').join(',')})`
    ).run(...tIds);
    console.warn(`[DB Init] Limpiadas ${dirtyFreeTables.length} mesa(s) libre(s) con datos sucios: [${tIds.join(',')}]`);
  }
} catch (migErr) {
  console.warn('[DB Init] Error en migración de inicio:', migErr.message);
}

// ============================================================
//  SINCRONIZACIÓN CON LA NUBE (Supabase)
// ============================================================
const crypto = require('crypto');
const activation = require('./services/inventory-sync-v8/activation');

// Tablas que se sincronizan con la nube
const SYNC_TABLES = ['orders', 'order_items', 'tables', 'menu_items', 'inventory', 'customers', 'employees', 'categories', 'subcategories'];

const OPEN_ORDER_FILTER = `
  (paymentMethod IS NULL OR paymentMethod = '')
  AND (status IS NULL OR status NOT IN ('delivered','cancelled'))
  AND (deleted IS NULL OR deleted = 0)
`;

/**
 * Aplica el esquema específico de sincronización (columnas uuid/device_id/
 * updated_at, order_uuid, tabla sync_queue, bandera _sync_flag, triggers de
 * cola, backfill de uuid y el esquema local del módulo inventory-sync-v8).
 *
 * Solo debe ejecutarse cuando la sincronización con la nube está habilitada
 * (isSyncEnabled()). Con el interruptor apagado, NINGUNA de estas
 * modificaciones se aplica al arrancar el POS: la base local conserva el
 * esquema mínimo de la app y no se toca.
 */
function applySyncSchema(db, opts = {}) {
  // El esquema LEGACY sigue ligado a "nube vinculada". La parte V8 solo se
  // instala cuando la condición única de activación es verdadera.
  const includeV8 = opts.includeV8 !== undefined ? !!opts.includeV8 : isV8Enabled(db);
  // 0. Registro de migración: solo se crea/schema_migrations cuando este
  //    código se ejecuta explícitamente (sync encendido o migración manual).
  ensureSchemaMigrationsTable(db);

  // 1. Columnas de control en config (solo con sincronización)
  addColumnIfMissing('config', 'cloud_restaurant_id', 'TEXT', db);
  addColumnIfMissing('config', 'supabase_url', 'TEXT', db);
  addColumnIfMissing('config', 'supabase_anon_key', 'TEXT', db);

  // 2. Columnas de sincronización en las tablas sincronizables.
  //    'deleted' es CORE (soft-delete usado por la app) y se aplica siempre;
  //    aquí solo van uuid/device_id/updated_at, que son infraestructura de sync.
  for (const table of SYNC_TABLES) {
    addColumnIfMissing(table, 'uuid', 'TEXT', db);
    addColumnIfMissing(table, 'updated_at', 'INTEGER', db);
    addColumnIfMissing(table, 'device_id', 'TEXT', db);
  }

  addColumnIfMissing('order_items', 'order_uuid', 'TEXT', db);
  addColumnIfMissing('local_session', 'device_id', 'TEXT', db);
  addColumnIfMissing('local_session', 'cloud_initial_backfill_done', 'INTEGER DEFAULT 0', db);

  // 3. Backfill: order_items viejos -> completan order_uuid desde su orden padre.
  try {
    db.exec(`
      UPDATE order_items SET order_uuid = (
        SELECT uuid FROM orders WHERE orders.id = order_items.order_id
      ) WHERE order_uuid IS NULL AND order_id IS NOT NULL
    `);
  } catch (err) {
    logger.warn('⚠️ [SYNC] Error en backfill de order_uuid:', err.message);
  }

  // 4. Rellenar uuid en filas viejas que no lo tienen.
  try {
    for (const table of SYNC_TABLES) {
      const rows = db.prepare(`SELECT id FROM ${table} WHERE uuid IS NULL`).all();
      if (rows.length === 0) continue;
      const stmt = db.prepare(`UPDATE ${table} SET uuid = ?, updated_at = COALESCE(updated_at, ?) WHERE id = ?`);
      const now = Date.now();
      const backfill = db.transaction((items) => {
        for (const row of items) stmt.run(crypto.randomUUID(), now, row.id);
      });
      backfill(rows);
      logger.info(`🔄 [SYNC] ${rows.length} filas de ${table} recibieron uuid`);
    }
  } catch (err) {
    logger.warn('⚠️ [SYNC] Error en backfill de uuid:', err.message);
  }

  // 5. Tabla outbox y bandera de aplicación remota.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      row_uuid TEXT NOT NULL,
      operation TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      synced INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sync_queue_pending ON sync_queue (synced, created_at);

    CREATE TABLE IF NOT EXISTS _sync_flag (rowid_pk INTEGER PRIMARY KEY DEFAULT 1, applying_remote INTEGER DEFAULT 0);
  `);
  db.prepare(`INSERT OR IGNORE INTO _sync_flag (rowid_pk, applying_remote) VALUES (1, 0)`).run();

  // 6. Triggers SQLite: auto-completan uuid/updated_at/device_id en cada INSERT
  //    y encolan cada INSERT/UPDATE en sync_queue. Cuando el motor de sync
  //    aplica un cambio que vino DE la nube, usa applyRemoteChange() para
  //    levantar la bandera _sync_flag y así NO reencolar ese cambio
  //    (evita loop infinito local -> nube -> local -> nube...).
  for (const table of SYNC_TABLES) {
    if (table === 'order_items') continue; // caso especial, ver más abajo

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_${table}_after_insert
      AFTER INSERT ON ${table}
      WHEN (SELECT applying_remote FROM _sync_flag WHERE rowid_pk = 1) = 0
      BEGIN
        UPDATE ${table} SET
          uuid = COALESCE(uuid,
                 lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
                 substr(hex(randomblob(2)),2) || '-' || substr('89ab',abs(random())%4+1,1) ||
                 substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))),
          updated_at = (strftime('%s','now') * 1000),
          device_id = '${DEVICE_ID}'
        WHERE rowid = NEW.rowid;

        INSERT INTO sync_queue (table_name, row_uuid, operation, created_at)
        SELECT '${table}', uuid, 'upsert', (strftime('%s','now') * 1000)
        FROM ${table} WHERE rowid = NEW.rowid;
      END;
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_${table}_queue_update
      AFTER UPDATE ON ${table}
      WHEN (SELECT applying_remote FROM _sync_flag WHERE rowid_pk = 1) = 0
      BEGIN
        UPDATE ${table} SET
          updated_at = (strftime('%s','now') * 1000),
          device_id = '${DEVICE_ID}'
        WHERE rowid = NEW.rowid AND uuid IS NOT NULL;
        INSERT INTO sync_queue (table_name, row_uuid, operation, created_at)
        SELECT '${table}', uuid, 'upsert', (strftime('%s','now') * 1000)
        FROM ${table} WHERE rowid = NEW.rowid AND uuid IS NOT NULL;
      END;
    `);
  }

  // ── order_items: caso especial ──
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_order_items_after_insert
    AFTER INSERT ON order_items
    WHEN (SELECT applying_remote FROM _sync_flag WHERE rowid_pk = 1) = 0
    BEGIN
      UPDATE order_items SET
        uuid = COALESCE(uuid,
               lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
               substr(hex(randomblob(2)),2) || '-' || substr('89ab',abs(random())%4+1,1) ||
               substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))),
        updated_at = (strftime('%s','now') * 1000),
        device_id = '${DEVICE_ID}',
        order_uuid = COALESCE(order_uuid, (SELECT uuid FROM orders WHERE orders.id = order_items.order_id))
      WHERE rowid = NEW.rowid;

      INSERT INTO sync_queue (table_name, row_uuid, operation, created_at)
      SELECT 'order_items', uuid, 'upsert', (strftime('%s','now') * 1000)
      FROM order_items WHERE rowid = NEW.rowid;
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_order_items_queue_update
    AFTER UPDATE ON order_items
    WHEN (SELECT applying_remote FROM _sync_flag WHERE rowid_pk = 1) = 0
    BEGIN
      UPDATE order_items SET
        updated_at = (strftime('%s','now') * 1000),
        device_id = '${DEVICE_ID}',
        order_uuid = COALESCE(order_uuid, (SELECT uuid FROM orders WHERE orders.id = order_items.order_id))
      WHERE rowid = NEW.rowid AND uuid IS NOT NULL;
      INSERT INTO sync_queue (table_name, row_uuid, operation, created_at)
      SELECT 'order_items', uuid, 'upsert', (strftime('%s','now') * 1000)
      FROM order_items WHERE rowid = NEW.rowid;
    END;
  `);

  // Rellena order_uuid de los ítems hijos cuando la orden padre recibe su uuid.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_orders_fill_children_uuid
    AFTER UPDATE OF uuid ON orders
    WHEN NEW.uuid IS NOT NULL
    BEGIN
      UPDATE order_items SET order_uuid = NEW.uuid
      WHERE order_id = NEW.id AND order_uuid IS NULL;
    END;
  `);

  logger.info('✅ [SYNC] Triggers de sincronización instalados en:', SYNC_TABLES.join(', '));

  // 7. Esquema local del módulo inventory-sync-v8 (ADITIVO).
  //    Solo con la condición única de activación; nunca se instala a medias.
  if (includeV8) {
    try {
      require('./services/inventory-sync-v8').applySchema(db);
      recordMigration(
        SYNC_SCHEMA_MIGRATION.version,
        SYNC_SCHEMA_MIGRATION.name,
        SYNC_SCHEMA_MIGRATION.syncRequired,
        db
      );
    } catch (err) {
      logger.warn('⚠️ [INV-V8] No se pudo aplicar el esquema local V8:', err.message);
      throw err;
    }
  } else {
    const st = getV8ActivationState(db);
    logger.info('ℹ️ [INV-V8] Esquema V8 no instalado (' + st.reasons.join(', ') + ')');
  }
}

// ── Primera subida: encola los datos existentes antes de activar la
//    sincronización. Solo tiene sentido con sync_queue presente (sync encendido).
function runInitialCloudBackfill(force = false, db = _getDb()) {
  try {
    if (!isSyncEnabled(db)) return { skipped: true, reason: 'sync_disabled' };
    const flagRow = db.prepare(`SELECT cloud_initial_backfill_done FROM local_session WHERE id = 1`).get();
    if (!force && flagRow && flagRow.cloud_initial_backfill_done) return { skipped: true };

    let totalEnqueued = 0;
    const enqueueAll = db.transaction(() => {
      for (const table of SYNC_TABLES) {
        const now = Date.now();
        let info;
        if (table === 'orders') {
          info = db.prepare(
            `INSERT INTO sync_queue (table_name, row_uuid, operation, created_at)
             SELECT ?, uuid, 'upsert', ? FROM orders WHERE uuid IS NOT NULL AND ${OPEN_ORDER_FILTER}`
          ).run(table, now);
        } else if (table === 'order_items') {
          info = db.prepare(
            `INSERT INTO sync_queue (table_name, row_uuid, operation, created_at)
             SELECT ?, uuid, 'upsert', ? FROM order_items
             WHERE uuid IS NOT NULL AND order_id IN (SELECT id FROM orders WHERE ${OPEN_ORDER_FILTER})`
          ).run(table, now);
        } else {
          info = db.prepare(
            `INSERT INTO sync_queue (table_name, row_uuid, operation, created_at)
             SELECT ?, uuid, 'upsert', ? FROM ${table} WHERE uuid IS NOT NULL`
          ).run(table, now);
        }
        totalEnqueued += info.changes;
      }
      db.prepare(`UPDATE local_session SET cloud_initial_backfill_done = 1 WHERE id = 1`).run();
    });
    enqueueAll();
    logger.info(`📤 [SYNC] Primera subida: ${totalEnqueued} fila(s) existente(s) encolada(s) para Supabase`);
    return { skipped: false, totalEnqueued };
  } catch (err) {
    logger.warn('⚠️ [SYNC] Error encolando datos existentes para la primera subida:', err.message);
    return { error: err.message };
  }
}

/**
 * Política de esquema aplicada al arrancar. Se expone para poder verificarla
 * con una base SQLite aislada (:memory:) sin tocar la base real.
 *
 * sync OFF  → no crea tablas, no añade columnas, no instala triggers,
 *             no escribe device_id y no encola backfill. La BD queda intacta.
 * sync ON   → instala el esquema de sincronización, registra la migración V8
 *             y encola el backfill inicial una sola vez.
 */
function initializeSchemaForStartup(db = _getDb(), env = process.env) {
  const enabled = isSyncEnabled(db);                 // legacy: nube vinculada
  const v8 = getV8ActivationState(db, env);          // condición única de V8
  const deviceId = computeDeviceId(db, enabled);
  if (!enabled) {
    return {
      syncEnabled: false, schemaChanged: false, deviceId,
      v8Enabled: false, v8Reasons: v8.reasons, v8SchemaApplied: false,
      skipped: 'sync_disabled',
    };
  }
  applySyncSchema(db, { includeV8: v8.enabled });
  const backfill = runInitialCloudBackfill(false, db);
  return {
    syncEnabled: true, schemaChanged: true, deviceId,
    v8Enabled: v8.enabled, v8Reasons: v8.reasons, v8SchemaApplied: v8.enabled, backfill,
  };
}

// ── Device ID persistente (solo se escribe si la sincronización está encendida) ──
const syncEnabled = isSyncEnabled();
const DEVICE_ID = computeDeviceId(_getDb(), syncEnabled);
logger.info('📱 [SYNC] Device ID:', DEVICE_ID);

if (syncEnabled) {
  applySyncSchema(_getDb(), { includeV8: isV8Enabled(_getDb()) });
  runInitialCloudBackfill(false);
}

// Helper para que sync-engine.js aplique cambios remotos SIN volver a
// encolarlos (evita loop infinito local <-> nube). Solo es llamado cuando
// la sincronización está encendida (applyRemoteRow solo se invoca entonces).
function applyRemoteChange(fn) {
  _getDb().prepare("UPDATE _sync_flag SET applying_remote = 1 WHERE rowid_pk = 1").run();
  try {
    fn();
  } finally {
    _getDb().prepare("UPDATE _sync_flag SET applying_remote = 0 WHERE rowid_pk = 1").run();
  }
}

module.exports = {
  db,
  saveLocalSession,
  getLocalSession,
  clearLocalSession,
  updateLicenseTimestamp,
  safeLower,
  safeStr,
  safeJSON,
  recordStockMovement,
  // sync
  SYNC_TABLES,
  DEVICE_ID,
  applyRemoteChange,
  runInitialCloudBackfill,
  _db,
  // acceso a la BD activa (respeta el override de pruebas)
  getDb: _getDb,
  // override de db para pruebas
  setDbForTesting,
  clearDbOverride,
  getDbForTesting: _getDb,
  // política de esquema (migraciones)
  ensureSchemaMigrationsTable,
  migrationApplied,
  recordMigration,
  isSyncEnabled,
  getV8ActivationState,
  isV8Enabled,
  applySyncSchema,
  computeDeviceId,
  initializeSchemaForStartup,
  SYNC_SCHEMA_MIGRATION,
};
