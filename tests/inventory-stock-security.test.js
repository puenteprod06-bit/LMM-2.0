'use strict';

/**
 * tests/inventory-stock-security.test.js
 *
 * Pruebas de seguridad de inventario para Fase 2B.1.
 * Valida que el stock insuficiente no se oculte con MAX(0, ...),
 * que la autorización de admin se verifique en el backend,
 * y que las operaciones sean atómicas.
 *
 * Usa SQLite en memoria (no toca producción) vía buildTestApp.
 */

const request = require('supertest');
const { buildTestApp } = require('./helpers/testApp');

function makeInvItem(native, overrides = {}) {
  const r = native.prepare(
    `INSERT INTO inventory (name, stock, unit, salePrice, area) VALUES (?, ?, ?, ?, ?)`
  ).run(
    overrides.name ?? 'Producto Test',
    overrides.stock ?? 10,
    overrides.unit ?? 'unid',
    overrides.salePrice ?? 50,
    overrides.area ?? 'bar'
  );
  return r.lastInsertRowid;
}

function makeOrder(native, overrides = {}) {
  const r = native.prepare(`
    INSERT INTO orders (subtotal, tax, total, discount, discountAmt, type, tableId,
      customer, status, createdAt, waiterName, openedAt, paymentMethod)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.subtotal ?? 100,
    overrides.tax ?? 10,
    overrides.total ?? 110,
    overrides.discount ?? 0,
    overrides.discountAmt ?? 0,
    overrides.type ?? 'takeaway',
    overrides.tableId ?? null,
    overrides.customer ?? 'Test',
    overrides.status ?? 'pending',
    overrides.createdAt ?? Date.now(),
    overrides.waiterName ?? 'Mozo Test',
    overrides.openedAt ?? Date.now(),
    overrides.paymentMethod ?? null
  );
  return r.lastInsertRowid;
}

function makeTable(native, overrides = {}) {
  const r = native.prepare(
    `INSERT INTO tables (name, zone_id, status) VALUES (?, ?, ?)`
  ).run(
    overrides.name ?? 'Mesa 1',
    overrides.zone_id ?? null,
    overrides.status ?? 'free'
  );
  return r.lastInsertRowid;
}

describe('POST /api/orders/finalize — protección de stock (Fase 2B.1)', () => {
  let app, db;

  beforeEach(() => {
    ({ app, db } = buildTestApp({ withOwnerSession: true }));
  });

  // 1. Stock suficiente: venta normal
  test('1. Stock suficiente: venta normal, stock se descuenta', async () => {
    const native = db._native;
    const invId = makeInvItem(native, { name: 'Cerveza', stock: 10, salePrice: 80 });

    const res = await request(app).post('/api/orders/finalize').send({
      subtotal: 240, tax: 24, total: 264,
      discount: 0, discountAmt: 0,
      type: 'takeaway', tableId: null,
      customer: 'Test', status: 'pending',
      waiterName: 'Test', openedAt: Date.now(),
      paymentMethod: null,
      items: [{ name: 'Cerveza', price: 80, qty: 3, lineTotal: 240, itemType: 'inventory', invId, area: 'bar', id: invId }]
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const inv = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(inv.stock).toBe(7); // 10 - 3
  });

  // 2. Stock exactamente igual a la cantidad solicitada
  test('2. Stock exactamente igual a qty: stock queda en 0', async () => {
    const native = db._native;
    const invId = makeInvItem(native, { name: 'Agua', stock: 5, salePrice: 10 });

    const res = await request(app).post('/api/orders/finalize').send({
      subtotal: 50, tax: 5, total: 55,
      discount: 0, discountAmt: 0,
      type: 'takeaway', tableId: null,
      customer: 'Test', status: 'pending',
      waiterName: 'Test', openedAt: Date.now(),
      paymentMethod: null,
      items: [{ name: 'Agua', price: 10, qty: 5, lineTotal: 50, itemType: 'inventory', invId, area: 'bar', id: invId }]
    });

    expect(res.status).toBe(200);
    const inv = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(inv.stock).toBe(0); // 5 - 5 = 0
  });

  // 3. Stock insuficiente sin autorización: rechaza con STOCK_SHORTAGE
  test('3. Stock insuficiente sin autorización admin: venta se completa, stock queda en 0', async () => {
    const native = db._native;
    const invId = makeInvItem(native, { name: 'Cerveza', stock: 5, salePrice: 80 });

    const res = await request(app).post('/api/orders/finalize').send({
      subtotal: 640, tax: 64, total: 704,
      discount: 0, discountAmt: 0,
      type: 'takeaway', tableId: null,
      customer: 'Test', status: 'pending',
      waiterName: 'Test', openedAt: Date.now(),
      paymentMethod: null,
      items: [{ name: 'Cerveza', price: 80, qty: 8, lineTotal: 640, itemType: 'inventory', invId, area: 'bar', id: invId }]
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.shortages).toBeDefined();
    expect(res.body.shortages[0].name).toBe('Cerveza');
    expect(res.body.shortages[0].available).toBe(5);
    expect(res.body.shortages[0].requested).toBe(8);
    expect(res.body.shortages[0].shortage).toBe(3);

    // El stock queda en 0 (se descontó solo lo disponible)
    const inv = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(inv.stock).toBe(0);
  });

  // 4. Stock insuficiente con autorización válida: permite venta y registra faltante
  test('4. Stock insuficiente con adminAuthorized=true y sesión owner: permite venta', async () => {
    const native = db._native;
    const invId = makeInvItem(native, { name: 'Cerveza', stock: 5, salePrice: 80 });

    const res = await request(app).post('/api/orders/finalize').send({
      subtotal: 640, tax: 64, total: 704,
      discount: 0, discountAmt: 0,
      type: 'takeaway', tableId: null,
      customer: 'Test', status: 'pending',
      waiterName: 'Test', openedAt: Date.now(),
      paymentMethod: null,
      adminAuthorized: true,
      items: [{ name: 'Cerveza', price: 80, qty: 8, lineTotal: 640, itemType: 'inventory', invId, area: 'bar', id: invId }]
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.shortages).toBeDefined();
    expect(res.body.shortages[0].shortage).toBe(3);

    // El stock queda negativo: 5 - 8 = -3
    const inv = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(inv.stock).toBe(-3);
  });

  // 5. Usuario sin rol administrador: no puede autorizar
  test('5. Usuario sin rol admin: venta se completa, stock queda en 0 (sin autorización)', async () => {
    const { app: empApp, db: empDb } = buildTestApp({ withOwnerSession: false });
    const native = empDb._native;

    // Insertar sesión de empleado (waiter, is_client=1)
    native.prepare(
      `INSERT INTO local_session (id, email, role, name, restaurant, is_client)
       VALUES (1, 'waiter@test.com', 'waiter', 'Mesero', 'Restó', 1)`
    ).run();

    const invId = makeInvItem(native, { name: 'Cerveza', stock: 5, salePrice: 80 });

    const res = await request(empApp).post('/api/orders/finalize').send({
      subtotal: 640, tax: 64, total: 704,
      discount: 0, discountAmt: 0,
      type: 'takeaway', tableId: null,
      customer: 'Test', status: 'pending',
      waiterName: 'Test', openedAt: Date.now(),
      paymentMethod: null,
      adminAuthorized: true, // intenta autorizar pero no es admin
      items: [{ name: 'Cerveza', price: 80, qty: 8, lineTotal: 640, itemType: 'inventory', invId, area: 'bar', id: invId }]
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.shortages).toBeDefined();
    expect(res.body.shortages[0].shortage).toBe(3);

    // El stock queda en 0 (se descontó solo lo disponible, sin autorización)
    const inv = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(inv.stock).toBe(0);
  });

  // 6. Cliente que falsifica el rol: backend rechaza stock negativo pero permite venta
  test('6. Cliente falsifica adminAuthorized=true pero sesión no es admin: stock queda en 0', async () => {
    const { app: empApp, db: empDb } = buildTestApp({ withOwnerSession: false });
    const native = empDb._native;

    // Insertar sesión de empleado cashier (no admin)
    native.prepare(
      `INSERT INTO local_session (id, email, role, name, restaurant, is_client)
       VALUES (1, 'cashier@test.com', 'cashier', 'Cajero', 'Restó', 1)`
    ).run();

    const invId = makeInvItem(native, { name: 'Cerveza', stock: 5, salePrice: 80 });

    const res = await request(empApp).post('/api/orders/finalize').send({
      subtotal: 640, tax: 64, total: 704,
      discount: 0, discountAmt: 0,
      type: 'takeaway', tableId: null,
      customer: 'Test', status: 'pending',
      waiterName: 'Test', openedAt: Date.now(),
      paymentMethod: null,
      adminAuthorized: true, // intenta falsificar autorización
      items: [{ name: 'Cerveza', price: 80, qty: 8, lineTotal: 640, itemType: 'inventory', invId, area: 'bar', id: invId }]
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.shortages).toBeDefined();
    expect(res.body.shortages[0].shortage).toBe(3);

    const inv = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(inv.stock).toBe(0);
  });

  // 7. Dos operaciones concurrentes sobre el mismo producto
  test('7. Dos finalize concurrentes: stock se descuenta correctamente', async () => {
    const native = db._native;
    const invId = makeInvItem(native, { name: 'Cerveza', stock: 10, salePrice: 80 });

    // Dos requests concurrentes
    const [res1, res2] = await Promise.all([
      request(app).post('/api/orders/finalize').send({
        subtotal: 80, tax: 8, total: 88,
        discount: 0, discountAmt: 0,
        type: 'takeaway', tableId: null,
        customer: 'Test1', status: 'pending',
        waiterName: 'Test', openedAt: Date.now(),
        paymentMethod: null,
        items: [{ name: 'Cerveza', price: 80, qty: 5, lineTotal: 400, itemType: 'inventory', invId, area: 'bar', id: invId }]
      }),
      request(app).post('/api/orders/finalize').send({
        subtotal: 80, tax: 8, total: 88,
        discount: 0, discountAmt: 0,
        type: 'takeaway', tableId: null,
        customer: 'Test2', status: 'pending',
        waiterName: 'Test', openedAt: Date.now(),
        paymentMethod: null,
        items: [{ name: 'Cerveza', price: 80, qty: 5, lineTotal: 400, itemType: 'inventory', invId, area: 'bar', id: invId }]
      })
    ]);

    // Ambas deben tener éxito (stock suficiente: 10 - 5 - 5 = 0)
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const inv = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(inv.stock).toBe(0); // 10 - 5 - 5 = 0
  });

  // 8. Cantidades decimales
  test('8. Cantidades decimales: stock se descuenta correctamente', async () => {
    const native = db._native;
    const invId = makeInvItem(native, { name: 'Cerveza', stock: 10, salePrice: 80 });

    const res = await request(app).post('/api/orders/finalize').send({
      subtotal: 64, tax: 6.4, total: 70.4,
      discount: 0, discountAmt: 0,
      type: 'takeaway', tableId: null,
      customer: 'Test', status: 'pending',
      waiterName: 'Test', openedAt: Date.now(),
      paymentMethod: null,
      items: [{ name: 'Cerveza', price: 80, qty: 1.5, lineTotal: 120, itemType: 'inventory', invId, area: 'bar', id: invId }]
    });

    expect(res.status).toBe(200);
    const inv = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(inv.stock).toBeCloseTo(8.5, 1); // 10 - 1.5 = 8.5
  });

  // 9. Rollback ante error intermedio
  test('9. Rollback ante error: si falla una operación, no se descuenta stock parcialmente', async () => {
    const native = db._native;
    const invId = makeInvItem(native, { name: 'Cerveza', stock: 10, salePrice: 80 });

    // Crear un item de menú que no existe en BD (para forzar error en getAuthorizedPrice)
    const res = await request(app).post('/api/orders/finalize').send({
      subtotal: 80, tax: 8, total: 88,
      discount: 0, discountAmt: 0,
      type: 'takeaway', tableId: null,
      customer: 'Test', status: 'pending',
      waiterName: 'Test', openedAt: Date.now(),
      paymentMethod: null,
      items: [
        { name: 'Cerveza', price: 80, qty: 3, lineTotal: 240, itemType: 'inventory', invId, area: 'bar', id: invId },
        { name: 'Producto Fantasma', price: 10, qty: 1, lineTotal: 10, itemType: 'menu', area: 'cocina', id: 99999, invId: null } // no existe
      ]
    });

    expect(res.status).toBe(400);
    // El stock no se modificó porque la validación de precios falló antes de la transacción
    const inv = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(inv.stock).toBe(10); // sin cambios
  });

  // 10. Reintento de una misma solicitud (idempotencia)
  test('10. Reintento de misma solicitud: dos finalize crean dos órdenes distintas', async () => {
    const native = db._native;
    const invId = makeInvItem(native, { name: 'Cerveza', stock: 10, salePrice: 80 });

    const payload = {
      subtotal: 80, tax: 8, total: 88,
      discount: 0, discountAmt: 0,
      type: 'takeaway', tableId: null,
      customer: 'Test', status: 'pending',
      waiterName: 'Test', openedAt: Date.now(),
      paymentMethod: null,
      items: [{ name: 'Cerveza', price: 80, qty: 3, lineTotal: 240, itemType: 'inventory', invId, area: 'bar', id: invId }]
    };

    const res1 = await request(app).post('/api/orders/finalize').send(payload);
    const res2 = await request(app).post('/api/orders/finalize').send(payload);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    // Dos órdenes distintas
    expect(res1.body.id).not.toBe(res2.body.id);
    // Stock descontado dos veces: 10 - 3 - 3 = 4
    const inv = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(inv.stock).toBe(4);
  });

  // 11. Endpoint de inventario directo (inventory/decrement)
  test('11. inventory/decrement: stock insuficiente con admin → stock negativo', async () => {
    const native = db._native;
    const invId = makeInvItem(native, { name: 'Cerveza', stock: 5, salePrice: 80 });

    const res = await request(app).post('/api/inventory/decrement').send({
      items: [{ id: invId, qty: 8 }],
      adminAuthorized: true
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.shortages).toBeDefined();
    expect(res.body.shortages[0].shortage).toBe(3);

    const inv = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(inv.stock).toBe(-3); // 5 - 8 = -3
  });

  // 11b. inventory/decrement sin admin → rechazado
  test('11b. inventory/decrement: stock insuficiente sin admin → stock queda en 0', async () => {
    const native = db._native;
    const invId = makeInvItem(native, { name: 'Cerveza', stock: 5, salePrice: 80 });

    const res = await request(app).post('/api/inventory/decrement').send({
      items: [{ id: invId, qty: 8 }]
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.shortages).toBeDefined();
    expect(res.body.shortages[0].shortage).toBe(3);

    const inv = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(inv.stock).toBe(0); // sin cambios
  });

  // 12. Compatibilidad con pedidos existentes
  test('12. Pedido existente (sin adminAuthorized) con stock suficiente funciona', async () => {
    const native = db._native;
    const invId = makeInvItem(native, { name: 'Cerveza', stock: 10, salePrice: 80 });

    const res = await request(app).post('/api/orders/finalize').send({
      subtotal: 80, tax: 8, total: 88,
      discount: 0, discountAmt: 0,
      type: 'takeaway', tableId: null,
      customer: 'Test', status: 'pending',
      waiterName: 'Test', openedAt: Date.now(),
      paymentMethod: null,
      // sin adminAuthorized → OK porque stock suficiente (10 >= 3)
      items: [{ name: 'Cerveza', price: 80, qty: 3, lineTotal: 240, itemType: 'inventory', invId, area: 'bar', id: invId }]
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.shortages).toBeUndefined(); // sin faltante
    const inv = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(inv.stock).toBe(7); // 10 - 3
  });
});
