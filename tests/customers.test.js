'use strict';

/**
 * tests/customers.test.js
 *
 * Cubre las rutas de /api/customers:
 *   - GET  /           — listado
 *   - POST /save       — crear y editar con validación
 *   - DELETE /:id      — eliminación con auth requireOwner
 */

const request = require('supertest');
const { buildTestApp } = require('./helpers/testApp');

// ── Helper ─────────────────────────────────────────────────────
function makeCustomer(native, overrides = {}) {
  return native.prepare(
    `INSERT INTO customers (name, phone, email, visits, totalSpent, points)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    overrides.name       ?? 'Cliente Test',
    overrides.phone      ?? '1122334455',
    overrides.email      ?? 'test@test.com',
    overrides.visits     ?? 0,
    overrides.totalSpent ?? 0,
    overrides.points     ?? 0
  ).lastInsertRowid;
}

// ══════════════════════════════════════════════════════════════
//  GET /api/customers
// ══════════════════════════════════════════════════════════════
describe('GET /api/customers', () => {
  let app, db;
  beforeEach(() => ({ app, db } = buildTestApp()));

  test('devuelve array vacío cuando no hay clientes', async () => {
    const res = await request(app).get('/api/customers');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
  });

  test('devuelve clientes existentes', async () => {
    const native = db._native;
    makeCustomer(native, { name: 'Juan' });
    makeCustomer(native, { name: 'María' });
    const res = await request(app).get('/api/customers');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
    expect(res.body.map(c => c.name)).toEqual(expect.arrayContaining(['Juan', 'María']));
  });
});

// ══════════════════════════════════════════════════════════════
//  POST /api/customers/save — CREAR
// ══════════════════════════════════════════════════════════════
describe('POST /api/customers/save — crear', () => {
  let app, db;
  beforeEach(() => ({ app, db } = buildTestApp()));

  test('crea cliente con datos válidos', async () => {
    const res = await request(app)
      .post('/api/customers/save')
      .send({ name: 'Carlos López', phone: '1133445566', email: 'carlos@test.com' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const row = db._native.prepare("SELECT * FROM customers WHERE name = 'Carlos López'").get();
    expect(row).toBeTruthy();
    expect(row.phone).toBe('1133445566');
  });

  test('crea cliente solo con name (phone y email opcionales)', async () => {
    const res = await request(app)
      .post('/api/customers/save')
      .send({ name: 'Ana Pérez' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('400 si name falta', async () => {
    const res = await request(app)
      .post('/api/customers/save')
      .send({ phone: '1122334455' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('400 si name tiene menos de 2 caracteres', async () => {
    const res = await request(app)
      .post('/api/customers/save')
      .send({ name: 'A' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('400 si name supera 100 caracteres', async () => {
    const res = await request(app)
      .post('/api/customers/save')
      .send({ name: 'A'.repeat(101) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('400 si email supera 120 caracteres', async () => {
    const res = await request(app)
      .post('/api/customers/save')
      .send({ name: 'Test User', email: 'a'.repeat(121) + '@test.com' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('visits y totalSpent negativos se normalizan a 0', async () => {
    const res = await request(app)
      .post('/api/customers/save')
      .send({ name: 'Test Negativo', visits: -10, totalSpent: -500, points: -99 });
    expect(res.status).toBe(200);
    const row = db._native.prepare("SELECT * FROM customers WHERE name = 'Test Negativo'").get();
    expect(row.visits).toBe(0);
    expect(row.totalSpent).toBe(0);
    expect(row.points).toBe(0);
  });

  test('401 sin sesión', async () => {
    const { app: anonApp } = buildTestApp({ withOwnerSession: false });
    const res = await request(anonApp)
      .post('/api/customers/save')
      .send({ name: 'Intruso' });
    expect(res.status).toBe(401);
  });
});

// ══════════════════════════════════════════════════════════════
//  POST /api/customers/save — EDITAR
// ══════════════════════════════════════════════════════════════
describe('POST /api/customers/save — editar', () => {
  let app, db;
  beforeEach(() => ({ app, db } = buildTestApp()));

  test('actualiza cliente existente', async () => {
    const native = db._native;
    const id = makeCustomer(native, { name: 'Viejo Nombre' });
    const res = await request(app)
      .post('/api/customers/save')
      .send({ id, name: 'Nuevo Nombre', phone: '9988776655' });
    expect(res.status).toBe(200);
    const row = native.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    expect(row.name).toBe('Nuevo Nombre');
    expect(row.phone).toBe('9988776655');
  });

  test('400 si name inválido al editar', async () => {
    const native = db._native;
    const id = makeCustomer(native);
    const res = await request(app)
      .post('/api/customers/save')
      .send({ id, name: '' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

// ══════════════════════════════════════════════════════════════
//  DELETE /api/customers/:id
// ══════════════════════════════════════════════════════════════
describe('DELETE /api/customers/:id', () => {
  let app, db;
  beforeEach(() => ({ app, db } = buildTestApp()));

  test('elimina cliente existente (requireOwner)', async () => {
    const native = db._native;
    const id = makeCustomer(native);
    const res = await request(app).delete(`/api/customers/${id}`);
    expect(res.status).toBe(200);
    const row = native.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    expect(row).toBeDefined();
    expect(row.deleted).toBe(1);
  });

  test('400 si id no es número positivo', async () => {
    const res = await request(app).delete('/api/customers/0');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('400 si id es negativo', async () => {
    const res = await request(app).delete('/api/customers/-1');
    expect(res.status).toBe(400);
  });

  test('401 sin sesión', async () => {
    const { app: anonApp } = buildTestApp({ withOwnerSession: false });
    const native = db._native;
    const id = makeCustomer(native);
    const res = await request(anonApp).delete(`/api/customers/${id}`);
    expect(res.status).toBe(401);
  });
});
