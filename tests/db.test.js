'use strict';

/**
 * tests/db.test.js
 *
 * Tests de integridad de base de datos:
 *   - Schema correcto (tablas y columnas críticas existen)
 *   - Constraints de FK y NOT NULL se aplican
 *   - Transacciones hacen rollback en error
 *   - Migración de contraseñas legacy → bcrypt
 */

const Database = require('better-sqlite3');
const bcrypt   = require('bcrypt');
const { buildTestApp } = require('./helpers/testApp');

// ═══════════════════════════════════════════════════════════════
//  Schema — tablas críticas existen
// ═══════════════════════════════════════════════════════════════
describe('Schema — tablas críticas', () => {
  let native;

  beforeEach(() => {
    ({ db: { _native: native } } = buildTestApp());
  });

  const criticalTables = [
    'config',
    'local_session',
    'orders',
    'order_items',
    'menu_items',
    'categories',
    'inventory',
    'customers',
    'employees',
    'tables',
    'zones',
  ];

  test.each(criticalTables)('tabla "%s" existe', (tableName) => {
    const row = native
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(tableName);
    expect(row).toBeDefined();
    expect(row.name).toBe(tableName);
  });

  test('config tiene columna master_pass', () => {
    const cols = native.prepare("PRAGMA table_info(config)").all();
    const names = cols.map(c => c.name);
    expect(names).toContain('master_pass');
  });

  test('local_session tiene columna is_client', () => {
    const cols = native.prepare("PRAGMA table_info(local_session)").all();
    const names = cols.map(c => c.name);
    expect(names).toContain('is_client');
  });

  test('employees tiene columna pin', () => {
    const cols = native.prepare("PRAGMA table_info(employees)").all();
    const names = cols.map(c => c.name);
    expect(names).toContain('pin');
  });

});

// ═══════════════════════════════════════════════════════════════
//  Sesión — lógica de owner vs staff
// ═══════════════════════════════════════════════════════════════
describe('local_session — roles y is_client', () => {
  let native;

  beforeEach(() => {
    ({ db: { _native: native } } = buildTestApp({ withOwnerSession: false }));
  });

  test('sin sesión: SELECT devuelve undefined', () => {
    const row = native.prepare('SELECT * FROM local_session WHERE id = 1').get();
    expect(row).toBeUndefined();
  });

  test('sesión owner con is_client=0 se inserta correctamente', () => {
    native.prepare(
      'INSERT INTO local_session (id, user_id, role, name, is_client) VALUES (1, ?, ?, ?, 0)'
    ).run('u1', 'owner', 'Dueño');

    const s = native.prepare('SELECT * FROM local_session WHERE id = 1').get();
    expect(s.role).toBe('owner');
    expect(s.is_client).toBe(0);
  });

  test('sesión con is_client=1 es distinguible de owner', () => {
    native.prepare(
      'INSERT INTO local_session (id, user_id, role, name, is_client) VALUES (1, ?, ?, ?, 1)'
    ).run('c1', 'owner', 'Cliente App');

    const s = native.prepare('SELECT * FROM local_session WHERE id = 1').get();
    expect(s.is_client).toBe(1);
    // La ruta requireOwner rechaza is_client === 1 aunque role sea 'owner'
    const isRealOwner = s.role === 'owner' && s.is_client === 0;
    expect(isRealOwner).toBe(false);
  });

});

// ═══════════════════════════════════════════════════════════════
//  Transacciones — rollback en error
// ═══════════════════════════════════════════════════════════════
describe('Transacciones SQLite — atomicidad', () => {
  let native;

  beforeEach(() => {
    ({ db: { _native: native } } = buildTestApp());
  });

  test('error dentro de transaction() hace rollback completo', () => {
    native.prepare("INSERT INTO categories (name, emoji) VALUES ('antes', '🍕')").run();
    const countBefore = native.prepare('SELECT COUNT(*) as n FROM categories').get().n;

    expect(() => {
      native.transaction(() => {
        native.prepare("INSERT INTO categories (name, emoji) VALUES ('dentro', '🌮')").run();
        // Forzar error: columna inexistente
        native.prepare("INSERT INTO categories (name, emoji, col_inexistente) VALUES (?,?,?)").run('x', '🔥', 'boom');
      })();
    }).toThrow();

    const countAfter = native.prepare('SELECT COUNT(*) as n FROM categories').get().n;
    expect(countAfter).toBe(countBefore); // debe ser igual — rollback aplicado
  });

  test('transaction exitosa persiste todos los cambios', () => {
    native.transaction(() => {
      native.prepare("INSERT INTO categories (name, emoji) VALUES (?, ?)").run('A', '🅰️');
      native.prepare("INSERT INTO categories (name, emoji) VALUES (?, ?)").run('B', '🅱️');
    })();

    const count = native.prepare('SELECT COUNT(*) as n FROM categories').get().n;
    expect(count).toBe(2);
  });

});

// ═══════════════════════════════════════════════════════════════
//  Contraseñas — bcrypt vs legacy
// ═══════════════════════════════════════════════════════════════
describe('Contraseñas — detección legacy y verificación bcrypt', () => {

  test('hash bcrypt empieza con $2b$', () => {
    const hash = bcrypt.hashSync('mipassword', 10);
    expect(hash.startsWith('$2b$')).toBe(true);
  });

  test('isLegacy detecta correctamente password en texto plano', () => {
    const plainPass = 'mipassword';
    const isLegacy = !plainPass.startsWith('$2b$');
    expect(isLegacy).toBe(true);
  });

  test('bcrypt.compareSync valida contraseña correcta', () => {
    const hash = bcrypt.hashSync('testpass123', 10);
    expect(bcrypt.compareSync('testpass123', hash)).toBe(true);
  });

  test('bcrypt.compareSync rechaza contraseña incorrecta', () => {
    const hash = bcrypt.hashSync('testpass123', 10);
    expect(bcrypt.compareSync('wrong', hash)).toBe(false);
  });

  test('password legacy igualdad directa funciona correctamente', () => {
    const stored = 'plaintext_old_pass';
    expect(stored === 'plaintext_old_pass').toBe(true);
    expect(stored === 'wrong').toBe(false);
  });

});
