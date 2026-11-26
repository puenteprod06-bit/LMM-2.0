'use strict';

/**
 * tests/auth.test.js
 *
 * Cubre la lógica de auth.js a través del helper buildTestApp.
 * Las rutas /api/auth/* y /api/login/* no usan Firebase en tests
 * (FIREBASE_URL no está seteado → checkFirebaseLicense devuelve sin_conexion).
 *
 * Escenarios cubiertos:
 *   - GET  /api/auth/session    — con y sin sesión activa
 *   - POST /api/login/owner     — PC nueva, PC configurada (B1/B2), validaciones
 *   - POST /api/login/staff     — restaurante correcto/incorrecto, PIN válido/inválido
 *   - POST /api/auth/logout
 *   - POST /api/auth/change-password
 *   - POST /api/auth/register
 */

const request = require('supertest');
const bcrypt  = require('bcrypt');
const express = require('express');
const bodyParser = require('body-parser');
const Database = require('better-sqlite3');

const { registerAuthRoutes } = require('../auth');
const { requireSession, requireOwner } = require('../middleware/requireAuth');

// ── Schema mínimo para auth ───────────────────────────────────
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS config (
    id INTEGER PRIMARY KEY,
    master_email TEXT,
    master_pass  TEXT,
    restaurant_name TEXT DEFAULT 'Test Resto',
    currency TEXT DEFAULT '$'
  );
  CREATE TABLE IF NOT EXISTS local_session (
    id INTEGER PRIMARY KEY,
    email TEXT, role TEXT, name TEXT,
    restaurant TEXT, is_client INTEGER DEFAULT 0,
    last_login INTEGER, last_license INTEGER
  );
  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, role TEXT, pin TEXT,
    phone TEXT, active INTEGER DEFAULT 1
  );
`;

// Contraseña de prueba: 'testpass'
const BCRYPT_PASS = bcrypt.hashSync('testpass', 10);

function buildAuthApp({ withConfig = true, withSession = false, withStaff = false } = {}) {
  const native = new Database(':memory:');
  native.exec(SCHEMA);

  if (withConfig) {
    native.prepare(
      `INSERT INTO config (id, master_email, master_pass, restaurant_name) VALUES (1, ?, ?, ?)`
    ).run('owner@test.com', BCRYPT_PASS, 'Mi Restó');
  }

  if (withSession) {
    native.prepare(
      `INSERT INTO local_session (id, email, role, name, restaurant, is_client) VALUES (1, ?, ?, ?, ?, 0)`
    ).run('owner@test.com', 'owner', 'Test Owner', 'Mi Restó');
  }

  if (withStaff) {
    native.prepare(
      `INSERT INTO employees (name, role, pin, active) VALUES (?, ?, ?, 1)`
    ).run('Carlos', 'waiter', '1234'); // PIN en texto plano (legacy)
  }

  // Wrapper db compatible con la API callback-style que usa auth.js internamente
  const dbWrapper = {
    _native: native,
    get(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      const p = Array.isArray(params) ? params : (params !== undefined ? [params] : []);
      try {
        const row = native.prepare(sql).get(...p);
        if (typeof cb === 'function') cb(null, row);
        return row;
      } catch (err) {
        if (typeof cb === 'function') cb(err);
        else throw err;
      }
    },
    run(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      const p = Array.isArray(params) ? params : (params !== undefined ? [params] : []);
      try {
        const result = native.prepare(sql).run(...p);
        if (typeof cb === 'function') cb.call({ lastID: result.lastInsertRowid, changes: result.changes }, null);
        return result;
      } catch (err) {
        if (typeof cb === 'function') cb(err);
        else throw err;
      }
    },
    all(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      const p = Array.isArray(params) ? params : (params !== undefined ? [params] : []);
      try {
        const rows = native.prepare(sql).all(...p);
        if (typeof cb === 'function') cb(null, rows);
        return rows;
      } catch (err) {
        if (typeof cb === 'function') cb(err);
        else throw err;
      }
    }
  };

  // Helpers de sesión que operan sobre la DB in-memory
  const ctx = {
    db: dbWrapper,
    getLocalSession() {
      return Promise.resolve(
        native.prepare('SELECT * FROM local_session WHERE id = 1').get() || null
      );
    },
    saveLocalSession({ email, role, name, restaurant, isClient }) {
      native.prepare(
        `INSERT OR REPLACE INTO local_session
         (id, email, role, name, restaurant, is_client, last_login)
         VALUES (1, ?, ?, ?, ?, ?, ?)`
      ).run(
        (email || '').toLowerCase().trim(),
        role       || 'staff',
        name       || '',
        restaurant || '',
        isClient   ? 1 : 0,
        Date.now()
      );
    },
    clearLocalSession() {
      native.prepare('DELETE FROM local_session WHERE id = 1').run();
    },
    updateLicenseTimestamp() {
      native.prepare('UPDATE local_session SET last_license = ? WHERE id = 1').run(Date.now());
    }
  };

  const notifyChange = jest.fn();
  const app = express();
  app.use(bodyParser.json());

  // Montar auth inyectando la DB in-memory (sin rate limiter de producción en tests)
  registerAuthRoutes(app, notifyChange, ctx);

  return { app, db: dbWrapper, native, notifyChange };
}

// ── Helpers ───────────────────────────────────────────────────
// El frontend envía la contraseña en Base64
function b64(str) { return Buffer.from(str).toString('base64'); }

// ═══════════════════════════════════════════════════════════════
//  GET /api/auth/session
// ═══════════════════════════════════════════════════════════════
describe('GET /api/auth/session', () => {

  test('sin sesión devuelve success false', async () => {
    const { app } = buildAuthApp({ withSession: false });
    const res = await request(app).get('/api/auth/session');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.reason).toBe('no_session');
  });

  test('con sesión activa devuelve datos del usuario', async () => {
    const { app } = buildAuthApp({ withSession: true });
    const res = await request(app).get('/api/auth/session');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user.email).toBe('owner@test.com');
    expect(res.body.user.role).toBe('owner');
    expect(res.body.user.isClient).toBe(false);
  });

});

// ═══════════════════════════════════════════════════════════════
//  POST /api/login/owner — validaciones básicas
// ═══════════════════════════════════════════════════════════════
describe('POST /api/login/owner — validaciones', () => {

  test('sin body devuelve 400', async () => {
    const { app } = buildAuthApp();
    const res = await request(app).post('/api/login/owner').send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('email con formato inválido devuelve 400', async () => {
    const { app } = buildAuthApp();
    const res = await request(app)
      .post('/api/login/owner')
      .send({ email: 'no-es-un-email', password: b64('testpass') });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/email/i);
  });

  test('contraseña menor a 4 caracteres devuelve 400', async () => {
    const { app } = buildAuthApp();
    const res = await request(app)
      .post('/api/login/owner')
      .send({ email: 'owner@test.com', password: b64('abc') });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/corta/i);
  });

});

// ═══════════════════════════════════════════════════════════════
//  POST /api/login/owner — PC nueva (CASO A)
// ═══════════════════════════════════════════════════════════════
describe('POST /api/login/owner — CASO A: PC nueva', () => {

  test('vincula PC y guarda cuenta local cuando no hay config', async () => {
    // Sin config → isFirstLogin = true. Firebase no disponible (sin URL) → sin_conexion → permite
    const { app, native } = buildAuthApp({ withConfig: false });

    const res = await request(app)
      .post('/api/login/owner')
      .send({ email: 'nuevo@test.com', password: b64('mipassword') });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user.email).toBe('nuevo@test.com');
    expect(res.body.user.role).toBe('owner');

    // Debe haberse guardado en config
    const config = native.prepare('SELECT master_email FROM config WHERE id = 1').get();
    expect(config.master_email).toBe('nuevo@test.com');
  });

  test('guarda contraseña hasheada con bcrypt', async () => {
    const { app, native } = buildAuthApp({ withConfig: false });

    await request(app)
      .post('/api/login/owner')
      .send({ email: 'nuevo@test.com', password: b64('mipassword') });

    const config = native.prepare('SELECT master_pass FROM config WHERE id = 1').get();
    expect(config.master_pass.startsWith('$2b$')).toBe(true);
    expect(bcrypt.compareSync('mipassword', config.master_pass)).toBe(true);
  });

  test('notifica config:updated al vincular', async () => {
    const { app, notifyChange } = buildAuthApp({ withConfig: false });

    await request(app)
      .post('/api/login/owner')
      .send({ email: 'nuevo@test.com', password: b64('mipassword') });

    expect(notifyChange).toHaveBeenCalledWith('config:updated');
  });

});

// ═══════════════════════════════════════════════════════════════
//  POST /api/login/owner — PC configurada, email coincide (CASO B1)
// ═══════════════════════════════════════════════════════════════
describe('POST /api/login/owner — CASO B1: credenciales locales correctas', () => {

  test('login exitoso con credenciales correctas', async () => {
    const { app } = buildAuthApp({ withConfig: true });

    const res = await request(app)
      .post('/api/login/owner')
      .send({ email: 'owner@test.com', password: b64('testpass') });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user.email).toBe('owner@test.com');
    expect(res.body.user.role).toBe('owner');
  });

  test('guarda sesión local al hacer login', async () => {
    const { app, native } = buildAuthApp({ withConfig: true });

    await request(app)
      .post('/api/login/owner')
      .send({ email: 'owner@test.com', password: b64('testpass') });

    const session = native.prepare('SELECT * FROM local_session WHERE id = 1').get();
    expect(session).toBeDefined();
    expect(session.role).toBe('owner');
  });

  test('migra contraseña legacy (texto plano) a bcrypt al hacer login', async () => {
    const { app, native } = buildAuthApp({ withConfig: false });
    // Insertar config con pass en texto plano (legacy)
    native.prepare(
      `INSERT INTO config (id, master_email, master_pass, restaurant_name) VALUES (1, ?, ?, ?)`
    ).run('owner@test.com', 'testpass', 'Mi Restó');

    await request(app)
      .post('/api/login/owner')
      .send({ email: 'owner@test.com', password: b64('testpass') });

    const config = native.prepare('SELECT master_pass FROM config WHERE id = 1').get();
    expect(config.master_pass.startsWith('$2b$')).toBe(true);
  });

});

// ═══════════════════════════════════════════════════════════════
//  POST /api/login/owner — contraseña incorrecta (CASO B2)
// ═══════════════════════════════════════════════════════════════
describe('POST /api/login/owner — CASO B2: contraseña incorrecta', () => {

  test('sin Firebase disponible devuelve 401', async () => {
    const { app } = buildAuthApp({ withConfig: true });

    const res = await request(app)
      .post('/api/login/owner')
      .send({ email: 'owner@test.com', password: b64('wrongpassword') });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/incorrectos/i);
  });

});

// ═══════════════════════════════════════════════════════════════
//  POST /api/login/staff
// ═══════════════════════════════════════════════════════════════
describe('POST /api/login/staff', () => {

  test('sin body devuelve 400', async () => {
    const { app } = buildAuthApp({ withConfig: true });
    const res = await request(app).post('/api/login/staff').send({});
    expect(res.status).toBe(400);
  });

  test('nombre de restaurante incorrecto devuelve 401', async () => {
    const { app } = buildAuthApp({ withConfig: true, withStaff: true });

    const res = await request(app)
      .post('/api/login/staff')
      .send({ restaurant: 'Nombre Equivocado', name: 'Carlos', pin: '1234' });

    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/local/i);
  });

  test('empleado inexistente devuelve 401', async () => {
    const { app } = buildAuthApp({ withConfig: true, withStaff: true });

    const res = await request(app)
      .post('/api/login/staff')
      .send({ restaurant: 'Mi Restó', name: 'Fantasma', pin: '1234' });

    expect(res.status).toBe(401);
  });

  test('PIN incorrecto devuelve 401', async () => {
    const { app } = buildAuthApp({ withConfig: true, withStaff: true });

    const res = await request(app)
      .post('/api/login/staff')
      .send({ restaurant: 'Mi Restó', name: 'Carlos', pin: '9999' });

    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/PIN/i);
  });

  test('login staff exitoso con PIN correcto (legacy plano)', async () => {
    const { app } = buildAuthApp({ withConfig: true, withStaff: true });

    const res = await request(app)
      .post('/api/login/staff')
      .send({ restaurant: 'Mi Restó', name: 'Carlos', pin: '1234' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user.name).toBe('Carlos');
    expect(res.body.user.role).toBe('waiter');
    expect(res.body.user.isClient).toBe(true);
  });

  test('login staff con PIN bcrypt hasheado funciona', async () => {
    const { app, native } = buildAuthApp({ withConfig: true });
    // Insertar empleado con PIN ya hasheado
    native.prepare(
      `INSERT INTO employees (name, role, pin, active) VALUES (?, ?, ?, 1)`
    ).run('Ana', 'cashier', bcrypt.hashSync('5678', 10));

    const res = await request(app)
      .post('/api/login/staff')
      .send({ restaurant: 'Mi Restó', name: 'Ana', pin: '5678' });

    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('Ana');
  });

  test('login exitoso guarda sesión con is_client=1', async () => {
    const { app, native } = buildAuthApp({ withConfig: true, withStaff: true });

    await request(app)
      .post('/api/login/staff')
      .send({ restaurant: 'Mi Restó', name: 'Carlos', pin: '1234' });

    const session = native.prepare('SELECT is_client FROM local_session WHERE id = 1').get();
    expect(session.is_client).toBe(1);
  });

});

// ═══════════════════════════════════════════════════════════════
//  POST /api/auth/logout
// ═══════════════════════════════════════════════════════════════
describe('POST /api/auth/logout', () => {

  test('limpia la sesión y devuelve success true', async () => {
    const { app, native } = buildAuthApp({ withSession: true });

    const before = native.prepare('SELECT * FROM local_session WHERE id = 1').get();
    expect(before).toBeDefined();

    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const after = native.prepare('SELECT * FROM local_session WHERE id = 1').get();
    expect(after).toBeUndefined();
  });

});

// ═══════════════════════════════════════════════════════════════
//  POST /api/auth/change-password
// ═══════════════════════════════════════════════════════════════
describe('POST /api/auth/change-password', () => {

  test('sin body devuelve 400', async () => {
    const { app } = buildAuthApp();
    const res = await request(app).post('/api/auth/change-password').send({});
    expect(res.status).toBe(400);
  });

  test('contraseña actual incorrecta devuelve 401', async () => {
    const { app } = buildAuthApp();

    const res = await request(app)
      .post('/api/auth/change-password')
      .send({ currentPassword: 'wrong', newPassword: 'nuevapass' });

    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/incorrecta/i);
  });

  test('cambia la contraseña correctamente', async () => {
    const { app, native } = buildAuthApp();

    const res = await request(app)
      .post('/api/auth/change-password')
      .send({ currentPassword: 'testpass', newPassword: 'nuevapass123' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verificar que la nueva contraseña quedó guardada
    const config = native.prepare('SELECT master_pass FROM config WHERE id = 1').get();
    expect(bcrypt.compareSync('nuevapass123', config.master_pass)).toBe(true);
  });

  test('devuelve 404 si no existe configuración', async () => {
    const { app } = buildAuthApp({ withConfig: false });

    const res = await request(app)
      .post('/api/auth/change-password')
      .send({ currentPassword: 'testpass', newPassword: 'nueva' });

    expect(res.status).toBe(404);
  });

});

// ═══════════════════════════════════════════════════════════════
//  POST /api/auth/register
// ═══════════════════════════════════════════════════════════════
describe('POST /api/auth/register', () => {

  test('sin campos requeridos devuelve 400', async () => {
    const { app } = buildAuthApp({ withConfig: false });
    const res = await request(app).post('/api/auth/register').send({ email: 'a@b.com' });
    expect(res.status).toBe(400);
  });

  test('registra propietario y guarda en config', async () => {
    const { app, native } = buildAuthApp({ withConfig: false });

    const res = await request(app).post('/api/auth/register').send({
      restaurant: 'La Trattoria',
      name: 'Luigi',
      email: 'luigi@trattoria.com',
      password: 'supersecret'
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const config = native.prepare('SELECT * FROM config WHERE id = 1').get();
    expect(config.master_email).toBe('luigi@trattoria.com');
    expect(config.restaurant_name).toBe('La Trattoria');
    expect(config.master_pass.startsWith('$2b$')).toBe(true);
  });

  test('notifica config:updated al registrar', async () => {
    const { app, notifyChange } = buildAuthApp({ withConfig: false });

    await request(app).post('/api/auth/register').send({
      restaurant: 'La Trattoria',
      name: 'Luigi',
      email: 'luigi@trattoria.com',
      password: 'supersecret'
    });

    expect(notifyChange).toHaveBeenCalledWith('config:updated');
  });

  test('email se normaliza a minúsculas', async () => {
    const { app, native } = buildAuthApp({ withConfig: false });

    await request(app).post('/api/auth/register').send({
      restaurant: 'Restó',
      name: 'Owner',
      email: 'OWNER@UPPER.COM',
      password: 'password'
    });

    const config = native.prepare('SELECT master_email FROM config WHERE id = 1').get();
    expect(config.master_email).toBe('owner@upper.com');
  });

});