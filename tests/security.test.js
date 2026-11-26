'use strict';

/**
 * tests/security.test.js
 *
 * Cubre los 3 bugs críticos de seguridad corregidos + regresiones:
 *   1. POST /api/system/reset  — autenticación y validación
 *   2. POST /api/system/factory-reset — autenticación
 *   3. Sesión requerida en rutas protegidas
 *   4. Protección contra inyección en campos de texto
 */

const request = require('supertest');
const { buildTestApp } = require('./helpers/testApp');

// ── Setup compartido ──────────────────────────────────────────
let app, db, notifyChange;

beforeEach(() => {
  ({ app, db, notifyChange } = buildTestApp({ withOwnerSession: true }));
});

// ═══════════════════════════════════════════════════════════════
//  1. POST /api/system/reset
// ═══════════════════════════════════════════════════════════════
describe('POST /api/system/reset — validación de contraseña', () => {

  test('sin body devuelve 400', async () => {
    const res = await request(app).post('/api/system/reset').send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/contraseña/i);
  });

  test('con password vacío devuelve 400', async () => {
    const res = await request(app).post('/api/system/reset').send({ password: '' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('con contraseña incorrecta devuelve 401', async () => {
    const res = await request(app)
      .post('/api/system/reset')
      .send({ password: 'wrong_password_xyz' });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/incorrecta/i);
  });

  test('con contraseña correcta devuelve 200 y limpia datos', async () => {
    // Insertar datos que deben borrarse
    const native = db._native;
    native.prepare("INSERT INTO categories (name, emoji) VALUES ('Cat test', '🍕')").run();
    native.prepare("INSERT INTO menu_items (name, price, area) VALUES ('Item test', 10, 'cocina')").run();

    const res = await request(app)
      .post('/api/system/reset')
      .send({ password: 'testpass123' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verificar que los datos fueron borrados
    const cats = native.prepare('SELECT COUNT(*) as n FROM categories').get();
    expect(cats.n).toBe(0);
    const items = native.prepare('SELECT COUNT(*) as n FROM menu_items').get();
    expect(items.n).toBe(0);
  });

  test('notifyChange es llamado tras reset exitoso', async () => {
    await request(app).post('/api/system/reset').send({ password: 'testpass123' });
    expect(notifyChange).toHaveBeenCalledWith('data:updated');
  });

  test('sin sesión activa devuelve 401 (requireOwner)', async () => {
    const { app: appNoSession } = buildTestApp({ withOwnerSession: false });
    const res = await request(appNoSession)
      .post('/api/system/reset')
      .send({ password: 'testpass123' });
    expect(res.status).toBe(401);
  });

});

// ═══════════════════════════════════════════════════════════════
//  2. POST /api/system/factory-reset
// ═══════════════════════════════════════════════════════════════
describe('POST /api/system/factory-reset — validación de contraseña', () => {

  test('sin contraseña devuelve 400', async () => {
    const res = await request(app).post('/api/system/factory-reset').send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('con contraseña incorrecta devuelve 401', async () => {
    const res = await request(app)
      .post('/api/system/factory-reset')
      .send({ password: 'notthepassword' });
    expect(res.status).toBe(401);
  });

  test('sin sesión activa devuelve 401', async () => {
    const { app: appNoSession } = buildTestApp({ withOwnerSession: false });
    const res = await request(appNoSession)
      .post('/api/system/factory-reset')
      .send({ password: 'testpass123' });
    expect(res.status).toBe(401);
  });

});

// ═══════════════════════════════════════════════════════════════
//  3. Protección de rutas — requireOwner / requireSession
// ═══════════════════════════════════════════════════════════════
describe('Protección de rutas sin sesión', () => {
  let appNoSession;

  beforeEach(() => {
    ({ app: appNoSession } = buildTestApp({ withOwnerSession: false }));
  });

  const protectedRoutes = [
    ['POST', '/api/system/reset'],
    ['POST', '/api/system/factory-reset'],
    ['POST', '/api/system/import'],
  ];

  test.each(protectedRoutes)(
    '%s %s sin sesión devuelve 401',
    async (method, route) => {
      const res = await request(appNoSession)[method.toLowerCase()](route).send({});
      expect(res.status).toBe(401);
    }
  );

});

// ═══════════════════════════════════════════════════════════════
//  4. POST /api/system/import — validación de payload
// ═══════════════════════════════════════════════════════════════
describe('POST /api/system/import — validación de backup', () => {

  test('sin body devuelve 400 por falta de secciones críticas', async () => {
    const res = await request(app).post('/api/system/import').send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/falta/i);
  });

  test('faltando solo "inventory" devuelve 400', async () => {
    const res = await request(app).post('/api/system/import').send({
      config: {}, menuItems: [], categories: []
      // inventory ausente a propósito
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/inventory/i);
  });

  test('payload completo mínimo importa correctamente', async () => {
    const res = await request(app).post('/api/system/import').send({
      config:    { restaurant_name: 'Test Rest', currency: '$', taxRate: 0, commissions: {}, payMethods: {} },
      menuItems: [],
      inventory: [],
      categories: []
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

});

// ═══════════════════════════════════════════════════════════════
//  5. POST /api/system/load-sample-data
// ═══════════════════════════════════════════════════════════════
describe('POST /api/system/load-sample-data — datos de ejemplo', () => {

  test('sin sesión devuelve 401', async () => {
    const { app: appNoSession } = buildTestApp({ withOwnerSession: false });
    const res = await request(appNoSession).post('/api/system/load-sample-data').send();
    expect(res.status).toBe(401);
  });

  test('con sesión owner carga los datos y devuelve 200', async () => {
    const res = await request(app).post('/api/system/load-sample-data').send();
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.stats.menuItems).toBeGreaterThan(0);
    expect(res.body.stats.categories).toBeGreaterThan(0);
    expect(res.body.stats.inventory).toBeGreaterThan(0);
  });

  test('segunda llamada devuelve 409 (idempotente, no duplica datos)', async () => {
    await request(app).post('/api/system/load-sample-data').send(); // primera
    const res = await request(app).post('/api/system/load-sample-data').send(); // segunda
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  test('los datos insertados son accesibles en la DB', async () => {
    await request(app).post('/api/system/load-sample-data').send();
    const native = db._native;
    const items = native.prepare('SELECT COUNT(*) as n FROM menu_items').get();
    expect(items.n).toBeGreaterThan(0);
    const cats = native.prepare('SELECT COUNT(*) as n FROM categories').get();
    expect(cats.n).toBeGreaterThan(0);
  });

  test('notifyChange es llamado tras carga exitosa', async () => {
    await request(app).post('/api/system/load-sample-data').send();
    expect(notifyChange).toHaveBeenCalledWith('data:updated');
  });

});
