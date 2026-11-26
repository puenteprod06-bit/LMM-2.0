'use strict';

/**
 * tests/security-hardening.test.js
 *
 * Cubre los endurecimientos de seguridad y las correcciones funcionales
 * hechas en la auditoría integral:
 *
 *   - GET /api/config  NO debe filtrar secretos (master_pass, claves de nube…)
 *   - Rutas GET de /api/orders exigen sesión
 *   - POST /api/inventory/save funciona (fix validation.ok → validation.valid)
 *   - POST /api/orders/pay no permite "inflar" el total
 *   - POST /api/menu/promo/check-expired exige permisos de owner
 */

const request = require('supertest');
const { buildTestApp } = require('./helpers/testApp');

function makeOrder(native, overrides = {}) {
  return native.prepare(
    `INSERT INTO orders (subtotal, tax, total, discount, discountAmt, type, tableId,
       customer, status, createdAt, waiterName, openedAt, paymentMethod)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    overrides.subtotal ?? 100,
    overrides.tax      ?? 10,
    overrides.total    ?? 110,
    overrides.discount ?? 0,
    overrides.discountAmt ?? 0,
    overrides.type     ?? 'takeaway',
    overrides.tableId  ?? null,
    overrides.customer ?? 'Test',
    overrides.status   ?? 'pending',
    overrides.createdAt ?? Date.now(),
    overrides.waiterName ?? 'Mozo',
    overrides.openedAt ?? Date.now(),
    overrides.paymentMethod ?? null
  ).lastInsertRowid;
}

// ── GET /api/config — no filtra secretos ─────────────────────
describe('GET /api/config — no filtra secretos', () => {
  test('accesible pre-login (devuelve datos públicos)', async () => {
    const { app } = buildTestApp({ withOwnerSession: false });
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body.restaurant_name).toBe('Test');
  });

  test('NO expone master_pass ni claves de nube en la respuesta', async () => {
    const { app, db } = buildTestApp();
    db._native.prepare(
      `UPDATE config SET master_pass=?, supabase_url=?, supabase_anon_key=?, session_token=?, cloud_restaurant_id=? WHERE id=1`
    ).run('$2b$$10$hashsecreto', 'https://supabase.example', 'sb_anon_key', 'tok123', 'resto-1');

    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('master_pass');
    expect(res.body).not.toHaveProperty('supabase_url');
    expect(res.body).not.toHaveProperty('supabase_anon_key');
    expect(res.body).not.toHaveProperty('session_token');
    expect(res.body).not.toHaveProperty('cloud_restaurant_id');
  });

  test('devuelve datos públicos como restaurant_name y currency', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/config');
    expect(res.body.restaurant_name).toBeTruthy();
    // no debe haberse eliminado el nombre por accidente
    expect(res.body).toHaveProperty('restaurant_name');
  });
});

// ── Rutas GET de /api/orders exigen sesión ───────────────────
describe('GET /api/orders — protección de sesión', () => {
  test.each(['/', '/active-count', '/history'])(
    'GET %s devuelve 401 sin sesión',
    async (path) => {
      const { app } = buildTestApp({ withOwnerSession: false });
      const res = await request(app).get(`/api/orders${path}`);
      expect(res.status).toBe(401);
    }
  );

  test('GET / responde con lista cuando hay sesión', async () => {
    const { app, db } = buildTestApp();
    makeOrder(db._native, {});
    const res = await request(app).get('/api/orders');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ── POST /api/inventory/save — fix validation.ok ─────────────
describe('POST /api/inventory/save — validación corregida', () => {
  test('200 al crear un ítem válido (antes devolvía 400 por validation.ok)', async () => {
    const { app, db } = buildTestApp();
    const res = await request(app)
      .post('/api/inventory/save')
      .send({ name: 'Coca-Cola', stock: 50, minStock: 5, unit: 'unidad', salePrice: 120 });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.id).toBe('number');
  });

  test('200 al editar un ítem existente', async () => {
    const { app, db } = buildTestApp();
    const id = db._native.prepare(
      "INSERT INTO inventory (name, stock) VALUES ('Pan', 10)"
    ).run().lastInsertRowid;

    const res = await request(app)
      .post('/api/inventory/save')
      .send({ id, name: 'Pan Francés', stock: 20 });
    expect(res.status).toBe(200);
    const row = db._native.prepare('SELECT name, stock FROM inventory WHERE id=?').get(id);
    expect(row.name).toBe('Pan Francés');
    expect(row.stock).toBe(20);
  });

  test('400 si falta el nombre obligatorio', async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .post('/api/inventory/save')
      .send({ stock: 5 });
    expect(res.status).toBe(400);
  });

  test('401/403 en la protección de owner sin sesión', async () => {
    const { app } = buildTestApp({ withOwnerSession: false });
    const res = await request(app)
      .post('/api/inventory/save')
      .send({ name: 'X', stock: 1 });
    expect([401, 403]).toContain(res.status);
  });
});

// ── POST /api/orders/pay — no permite inflar el total ────────
describe('POST /api/orders/pay — no permite inflar el total', () => {
  test('un total enviado mayor al de BD NO se persiste', async () => {
    const { app, db } = buildTestApp();
    const orderId = makeOrder(db._native, { total: 100, status: 'active' });

    const res = await request(app)
      .post('/api/orders/pay')
      .send({ id: orderId, method: 'efectivo', total: 99999, commission: 0 });

    expect(res.status).toBe(200);
    const row = db._native.prepare('SELECT total, paymentMethod FROM orders WHERE id=?').get(orderId);
    expect(row.paymentMethod).toBe('efectivo');
    // el total queda en el valor de BD (100), no el inflado por el cliente
    expect(Number(row.total)).toBe(100);
  });

  test('la comisión legítima se suma al total de BD', async () => {
    const { app, db } = buildTestApp();
    const orderId = makeOrder(db._native, { total: 200, status: 'active' });

    const res = await request(app)
      .post('/api/orders/pay')
      .send({ id: orderId, method: 'efectivo', total: 210, commission: 10 });

    expect(res.status).toBe(200);
    const row = db._native.prepare('SELECT total, commissionAmt FROM orders WHERE id=?').get(orderId);
    expect(Number(row.total)).toBe(210); // 200 + 10 de comisión, derivado server-side
    expect(Number(row.commissionAmt)).toBe(10);
  });

  test('método split persiste el cobro (flujo de cuenta dividida)', async () => {
    const { app, db } = buildTestApp();
    const orderId = makeOrder(db._native, { total: 300, status: 'active' });

    const res = await request(app)
      .post('/api/orders/pay')
      .send({ id: orderId, method: 'split', total: 300, commission: 0 });

    expect(res.status).toBe(200);
    const row = db._native.prepare('SELECT total, paymentMethod, status FROM orders WHERE id=?').get(orderId);
    expect(row.paymentMethod).toBe('split');
    expect(row.status).toBe('delivered');
    expect(Number(row.total)).toBe(300);
  });
});

// ── POST /api/menu/promo/check-expired — requiere owner ──────
describe('POST /api/menu/promo/check-expired — protección de owner', () => {
  test('401 sin sesión', async () => {
    const { app } = buildTestApp({ withOwnerSession: false });
    const res = await request(app).post('/api/menu/promo/check-expired');
    expect(res.status).toBe(401);
  });

  test('200 con sesión de owner', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/api/menu/promo/check-expired');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('expired');
  });
});
