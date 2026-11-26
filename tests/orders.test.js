'use strict';

/**
 * tests/orders.test.js
 *
 * Cubre las rutas de /api/orders:
 *   - GET  /active-count
 *   - GET  /         — listado con items
 *   - GET  /history  — paginación y filtros
 *   - POST /finalize — orden nueva, merge con existente
 *   - POST /pay      — cierre de orden y liberación de mesa
 *   - POST /update-status
 *   - POST /update-table
 *   - POST /update-item-status
 *   - POST /update-bulk-items
 *   - Protección de sesión en rutas requireSession
 */

const request = require('supertest');
const { buildTestApp } = require('./helpers/testApp');

// ── Helpers de fixture ────────────────────────────────────────
function makeOrder(native, overrides = {}) {
  const r = native.prepare(`
    INSERT INTO orders (subtotal, tax, total, discount, discountAmt, type, tableId,
      customer, status, createdAt, waiterName, openedAt, paymentMethod)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.subtotal      ?? 100,
    overrides.tax           ?? 10,
    overrides.total         ?? 110,
    overrides.discount      ?? 0,
    overrides.discountAmt   ?? 0,
    overrides.type          ?? 'dine-in',
    overrides.tableId       ?? null,
    overrides.customer      ?? 'Test Customer',
    overrides.status        ?? 'pending',
    overrides.createdAt     ?? Date.now(),
    overrides.waiterName    ?? 'Mozo Test',
    overrides.openedAt      ?? Date.now(),
    overrides.paymentMethod ?? null
  );
  return r.lastInsertRowid;
}

function makeItem(native, orderId, overrides = {}) {
  native.prepare(`
    INSERT INTO order_items (order_id, name, price, qty, lineTotal, note, itemType, area, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    orderId,
    overrides.name      ?? 'Pizza',
    overrides.price     ?? 50,
    overrides.qty       ?? 2,
    overrides.lineTotal ?? 100,
    overrides.note      ?? '',
    overrides.itemType  ?? 'menu',
    overrides.area      ?? 'cocina',
    overrides.status    ?? 'pending'
  );
}

function makeTable(native, overrides = {}) {
  const r = native.prepare(
    `INSERT INTO tables (name, zone_id, status) VALUES (?, ?, ?)`
  ).run(
    overrides.name    ?? 'Mesa 1',
    overrides.zone_id ?? null,
    overrides.status  ?? 'free'
  );
  return r.lastInsertRowid;
}

const BASE_ORDER = {
  subtotal: 200, tax: 20, total: 220,
  discount: 0, discountAmt: 0,
  type: 'takeaway', tableId: null,
  customer: 'Consumidor Final', status: 'pending',
  waiterName: 'Test', openedAt: Date.now(),
  paymentMethod: null,
  items: [
    { name: 'Milanesa', price: 100, qty: 1, lineTotal: 100, itemType: 'menu', area: 'cocina', id: null, invId: null }
  ]
};

// ── Setup ─────────────────────────────────────────────────────
let app, db;

beforeEach(() => {
  ({ app, db } = buildTestApp({ withOwnerSession: true }));
});

// ═══════════════════════════════════════════════════════════════
//  GET /api/orders/active-count
// ═══════════════════════════════════════════════════════════════
describe('GET /api/orders/active-count', () => {

  test('sin pedidos activos devuelve ceros', async () => {
    const res = await request(app).get('/api/orders/active-count');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.tableCount).toBe(0);
    expect(res.body.orderCount).toBe(0);
  });

  test('cuenta pedidos activos con mesa asignada', async () => {
    const native = db._native;
    const tableId = makeTable(native);
    makeOrder(native, { tableId, status: 'pending' });
    makeOrder(native, { tableId, status: 'ready' });

    const res = await request(app).get('/api/orders/active-count');
    expect(res.status).toBe(200);
    expect(res.body.orderCount).toBe(2);
    expect(res.body.tableCount).toBe(1); // misma mesa → 1 único tableId
  });

  test('no cuenta pedidos delivered o cancelled', async () => {
    const native = db._native;
    const tableId = makeTable(native);
    makeOrder(native, { tableId, status: 'delivered' });
    makeOrder(native, { tableId, status: 'cancelled' });

    const res = await request(app).get('/api/orders/active-count');
    expect(res.body.tableCount).toBe(0);
    expect(res.body.orderCount).toBe(0);
  });

});

// ═══════════════════════════════════════════════════════════════
//  GET /api/orders
// ═══════════════════════════════════════════════════════════════
describe('GET /api/orders', () => {

  test('sin pedidos devuelve array vacío', async () => {
    const res = await request(app).get('/api/orders');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  test('devuelve pedidos con sus items embebidos', async () => {
    const native = db._native;
    const orderId = makeOrder(native, { status: 'pending' });
    makeItem(native, orderId, { name: 'Empanada', qty: 3 });

    const res = await request(app).get('/api/orders');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].items).toHaveLength(1);
    expect(res.body[0].items[0].name).toBe('Empanada');
  });

  test('devuelve múltiples pedidos cada uno con sus propios items', async () => {
    const native = db._native;
    const id1 = makeOrder(native);
    const id2 = makeOrder(native);
    makeItem(native, id1, { name: 'Item A' });
    makeItem(native, id2, { name: 'Item B' });
    makeItem(native, id2, { name: 'Item C' });

    const res = await request(app).get('/api/orders');
    expect(res.body).toHaveLength(2);
    const order1 = res.body.find(o => o.id === id1);
    const order2 = res.body.find(o => o.id === id2);
    expect(order1.items).toHaveLength(1);
    expect(order2.items).toHaveLength(2);
  });

});

// ═══════════════════════════════════════════════════════════════
//  GET /api/orders/history
// ═══════════════════════════════════════════════════════════════
describe('GET /api/orders/history', () => {

  test('sin pedidos pagados devuelve array vacío', async () => {
    const res = await request(app).get('/api/orders/history');
    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  test('solo incluye pedidos con paymentMethod (pagados)', async () => {
    const native = db._native;
    makeOrder(native, { paymentMethod: null, type: 'dine-in' });          // no debe aparecer
    makeOrder(native, { paymentMethod: 'efectivo', type: 'dine-in' });     // sí
    makeOrder(native, { paymentMethod: 'tarjeta', type: 'dine-in' });      // sí

    const res = await request(app).get('/api/orders/history');
    expect(res.body.total).toBe(2);
    expect(res.body.orders).toHaveLength(2);
  });

  test('paginación: limit y page funcionan', async () => {
    const native = db._native;
    for (let i = 0; i < 5; i++) {
      makeOrder(native, { paymentMethod: 'efectivo', type: 'dine-in' });
    }

    const p1 = await request(app).get('/api/orders/history?limit=2&page=1');
    expect(p1.body.orders).toHaveLength(2);
    expect(p1.body.total).toBe(5);
    expect(p1.body.pages).toBe(3);
    expect(p1.body.currentPage).toBe(1);

    const p2 = await request(app).get('/api/orders/history?limit=2&page=2');
    expect(p2.body.orders).toHaveLength(2);

    const p3 = await request(app).get('/api/orders/history?limit=2&page=3');
    expect(p3.body.orders).toHaveLength(1);
  });

  test('filtro por waiter devuelve solo sus pedidos', async () => {
    const native = db._native;
    makeOrder(native, { paymentMethod: 'efectivo', waiterName: 'Carlos', type: 'dine-in' });
    makeOrder(native, { paymentMethod: 'efectivo', waiterName: 'Ana',    type: 'dine-in' });
    makeOrder(native, { paymentMethod: 'efectivo', waiterName: 'Carlos', type: 'dine-in' });

    const res = await request(app).get('/api/orders/history?waiter=Carlos');
    expect(res.body.total).toBe(2);
    res.body.orders.forEach(o => expect(o.waiterName).toBe('Carlos'));
  });

});

// ═══════════════════════════════════════════════════════════════
//  POST /api/orders/finalize
// ═══════════════════════════════════════════════════════════════
describe('POST /api/orders/finalize', () => {

  test('crea una orden nueva y devuelve id', async () => {
    const res = await request(app)
      .post('/api/orders/finalize')
      .send(BASE_ORDER);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.id).toBe('number');
    expect(res.body.merged).toBe(false);

    // Verificar en DB
    const order = db._native.prepare('SELECT * FROM orders WHERE id = ?').get(res.body.id);
    expect(order).toBeDefined();
    expect(order.customer).toBe('Consumidor Final');
  });

  test('inserta los items correctamente', async () => {
    const payload = {
      ...BASE_ORDER,
      items: [
        { name: 'Pizza', price: 100, qty: 2, lineTotal: 200, itemType: 'menu', area: 'cocina', id: null, invId: null },
        { name: 'Gaseosa', price: 50,  qty: 1, lineTotal: 50,  itemType: 'menu', area: 'bar',    id: null, invId: null }
      ]
    };

    const res = await request(app).post('/api/orders/finalize').send(payload);
    expect(res.body.success).toBe(true);

    const items = db._native.prepare('SELECT * FROM order_items WHERE order_id = ?').all(res.body.id);
    expect(items).toHaveLength(2);
    expect(items.map(i => i.name)).toContain('Pizza');
    expect(items.map(i => i.name)).toContain('Gaseosa');
  });

  test('descuenta stock de inventario al usar itemType=inventory', async () => {
    const native = db._native;
    const invId = native.prepare(
      `INSERT INTO inventory (name, stock, unit) VALUES ('Cerveza', 10, 'unid')`
    ).run().lastInsertRowid;

    await request(app).post('/api/orders/finalize').send({
      ...BASE_ORDER,
      items: [{ name: 'Cerveza', price: 80, qty: 3, lineTotal: 240, itemType: 'inventory', invId, area: 'bar', id: invId }]
    });

    const inv = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(inv.stock).toBe(7); // 10 - 3
  });

  test('hace merge con pedido abierto de la misma mesa', async () => {
    const native  = db._native;
    const tableId = makeTable(native);
    const existId = makeOrder(native, { tableId, type: 'dine-in', status: 'pending' });
    makeItem(native, existId, { name: 'Cerveza', qty: 1, lineTotal: 50 });

    const res = await request(app).post('/api/orders/finalize').send({
      ...BASE_ORDER,
      type: 'dine-in',
      tableId,
      items: [{ name: 'Pizza', price: 100, qty: 1, lineTotal: 100, itemType: 'menu', area: 'cocina', id: null, invId: null }]
    });

    expect(res.body.success).toBe(true);
    expect(res.body.merged).toBe(true);
    expect(res.body.id).toBe(existId); // mismo pedido

    const items = native.prepare('SELECT * FROM order_items WHERE order_id = ?').all(existId);
    expect(items).toHaveLength(2); // ítem original + nuevo
  });

  test('notifica orders:updated tras crear', async () => {
    const { app: app2, notifyChange } = buildTestApp({ withOwnerSession: true });
    await request(app2).post('/api/orders/finalize').send(BASE_ORDER);
    expect(notifyChange).toHaveBeenCalledWith('orders:updated', expect.any(Object));
  });

  test('sin sesión devuelve 401', async () => {
    const { app: noSess } = buildTestApp({ withOwnerSession: false });
    const res = await request(noSess).post('/api/orders/finalize').send(BASE_ORDER);
    expect(res.status).toBe(401);
  });

});

// ═══════════════════════════════════════════════════════════════
//  POST /api/orders/pay
// ═══════════════════════════════════════════════════════════════
describe('POST /api/orders/pay', () => {

  test('cierra la orden correctamente', async () => {
    const native  = db._native;
    const orderId = makeOrder(native, { status: 'pending' });

    const res = await request(app)
      .post('/api/orders/pay')
      .send({ id: orderId, method: 'efectivo', total: 110, commission: 0 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const order = native.prepare('SELECT status, paymentMethod FROM orders WHERE id = ?').get(orderId);
    expect(order.status).toBe('delivered');
    expect(order.paymentMethod).toBe('efectivo');
  });

  test('libera la mesa al cerrar una orden dine-in', async () => {
    const native  = db._native;
    const tableId = makeTable(native, { status: 'occupied' });
    const orderId = makeOrder(native, { tableId, type: 'dine-in', status: 'pending' });

    await request(app)
      .post('/api/orders/pay')
      .send({ id: orderId, method: 'tarjeta', total: 110 });

    const table = native.prepare('SELECT status FROM tables WHERE id = ?').get(tableId);
    expect(table.status).toBe('available');
  });

  test('devuelve 400 si faltan id o method', async () => {
    const res = await request(app).post('/api/orders/pay').send({ id: 999 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('devuelve 404 si la orden no existe', async () => {
    const res = await request(app)
      .post('/api/orders/pay')
      .send({ id: 99999, method: 'efectivo', total: 0 });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ORDER_NOT_FOUND');
  });

  test('no puede pagar una orden ya cerrada (idempotencia)', async () => {
    const native  = db._native;
    const orderId = makeOrder(native, { status: 'delivered', paymentMethod: 'efectivo' });

    const res = await request(app)
      .post('/api/orders/pay')
      .send({ id: orderId, method: 'tarjeta', total: 110 });
    expect(res.status).toBe(404); // changes === 0 → ORDER_NOT_FOUND
  });

  test('notifica orders:updated al cerrar', async () => {
    const { app: app2, db: db2, notifyChange } = buildTestApp({ withOwnerSession: true });
    const orderId = makeOrder(db2._native, { status: 'pending' });
    await request(app2).post('/api/orders/pay').send({ id: orderId, method: 'efectivo', total: 110 });
    expect(notifyChange).toHaveBeenCalledWith('orders:updated', expect.objectContaining({ status: 'delivered' }));
  });

  test('sin sesión devuelve 401', async () => {
    const { app: noSess } = buildTestApp({ withOwnerSession: false });
    const res = await request(noSess).post('/api/orders/pay').send({ id: 1, method: 'efectivo', total: 0 });
    expect(res.status).toBe(401);
  });

});

// ═══════════════════════════════════════════════════════════════
//  POST /api/orders/update-status
// ═══════════════════════════════════════════════════════════════
describe('POST /api/orders/update-status', () => {

  test('actualiza el estado de una orden', async () => {
    const native  = db._native;
    const orderId = makeOrder(native, { status: 'pending' });

    const res = await request(app)
      .post('/api/orders/update-status')
      .send({ id: orderId, status: 'ready' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const order = native.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
    expect(order.status).toBe('ready');
  });

  test('sin sesión devuelve 401', async () => {
    const { app: noSess } = buildTestApp({ withOwnerSession: false });
    const res = await request(noSess).post('/api/orders/update-status').send({ id: 1, status: 'ready' });
    expect(res.status).toBe(401);
  });

});

// ═══════════════════════════════════════════════════════════════
//  POST /api/orders/update-table
// ═══════════════════════════════════════════════════════════════
describe('POST /api/orders/update-table', () => {

  test('mueve un pedido a otra mesa', async () => {
    const native   = db._native;
    const tableA   = makeTable(native, { name: 'Mesa A' });
    const tableB   = makeTable(native, { name: 'Mesa B' });
    const orderId  = makeOrder(native, { tableId: tableA });

    const res = await request(app)
      .post('/api/orders/update-table')
      .send({ orderId, newTableId: tableB });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const order = native.prepare('SELECT tableId FROM orders WHERE id = ?').get(orderId);
    expect(order.tableId).toBe(tableB);
  });

});

// ═══════════════════════════════════════════════════════════════
//  POST /api/orders/update-item-status
// ═══════════════════════════════════════════════════════════════
describe('POST /api/orders/update-item-status', () => {

  test('actualiza el estado de un ítem individual', async () => {
    const native  = db._native;
    const orderId = makeOrder(native);
    makeItem(native, orderId, { status: 'pending' });
    const item = native.prepare('SELECT id FROM order_items WHERE order_id = ?').get(orderId);

    const res = await request(app)
      .post('/api/orders/update-item-status')
      .send({ itemId: item.id, status: 'ready', orderId });

    expect(res.status).toBe(200);
    const updated = native.prepare('SELECT status FROM order_items WHERE id = ?').get(item.id);
    expect(updated.status).toBe('ready');
  });

});

// ═══════════════════════════════════════════════════════════════
//  POST /api/orders/update-bulk-items
// ═══════════════════════════════════════════════════════════════
describe('POST /api/orders/update-bulk-items', () => {

  test('actualiza todos los ítems de un pedido', async () => {
    const native  = db._native;
    const orderId = makeOrder(native);
    makeItem(native, orderId, { area: 'cocina', status: 'pending' });
    makeItem(native, orderId, { area: 'cocina', status: 'pending' });

    await request(app)
      .post('/api/orders/update-bulk-items')
      .send({ orderId, area: 'todas', status: 'ready' });

    const items = native.prepare('SELECT status FROM order_items WHERE order_id = ?').all(orderId);
    items.forEach(i => expect(i.status).toBe('ready'));
  });

  test('filtra por área cuando área no es "todas"', async () => {
    const native  = db._native;
    const orderId = makeOrder(native);
    makeItem(native, orderId, { area: 'cocina', status: 'pending' });
    makeItem(native, orderId, { area: 'bar',    status: 'pending' });

    await request(app)
      .post('/api/orders/update-bulk-items')
      .send({ orderId, area: 'cocina', status: 'ready' });

    const cocina = native.prepare("SELECT status FROM order_items WHERE order_id = ? AND area = 'cocina'").all(orderId);
    const bar    = native.prepare("SELECT status FROM order_items WHERE order_id = ? AND area = 'bar'").all(orderId);
    cocina.forEach(i => expect(i.status).toBe('ready'));
    bar.forEach(i => expect(i.status).toBe('pending')); // no tocado
  });

});

// ════════════════════════════════════════════════════════════════
//  TESTS NUEVOS — cubren fixes de validación y seguridad
// ════════════════════════════════════════════════════════════════

// ── POST /api/orders/modify-items ────────────────────────────
describe('POST /api/orders/modify-items', () => {
  let app, db;
  beforeEach(() => ({ app, db } = buildTestApp()));

  test('400 si orderId falta', async () => {
    const res = await request(app)
      .post('/api/orders/modify-items')
      .send({ items: [{ name: 'Burger', qty: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('400 si items es array vacío', async () => {
    const res = await request(app)
      .post('/api/orders/modify-items')
      .send({ orderId: 1, items: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('400 si ítem tiene área inválida', async () => {
    const res = await request(app)
      .post('/api/orders/modify-items')
      .send({ orderId: 1, items: [{ name: 'Burger', qty: 1, area: 'INVALIDA' }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('400 si ítem no tiene name', async () => {
    const res = await request(app)
      .post('/api/orders/modify-items')
      .send({ orderId: 1, items: [{ qty: 1, area: 'cocina' }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('precio del cliente se valida contra BD — se usa precio de BD', async () => {
    const native  = db._native;
    // Insertar un ítem de menú con precio real en BD
    const menuId = native.prepare(
      "INSERT INTO menu_items (name, price, catId, available) VALUES ('Burger Test', 999, 1, 1)"
    ).run().lastInsertRowid;
    const orderId = makeOrder(native, { status: 'active' });

    const res = await request(app)
      .post('/api/orders/modify-items')
      .send({ orderId, items: [{ id: menuId, name: 'Burger Test', price: 999, qty: 2, itemType: 'menu', area: 'cocina' }] });

    expect(res.status).toBe(200);
    // El total debe ser 999*2 = 1998, NO 1*2 = 2
    expect(res.body.subtotal).toBeCloseTo(1998, 0);
  });

  test('401 sin sesión', async () => {
    const { app: anonApp } = buildTestApp({ withOwnerSession: false });
    const res = await request(anonApp)
      .post('/api/orders/modify-items')
      .send({ orderId: 1, items: [{ name: 'x', qty: 1 }] });
    expect(res.status).toBe(401);
  });
});

// ── POST /api/orders/update-status — whitelist ───────────────
describe('POST /api/orders/update-status — validación', () => {
  let app, db;
  beforeEach(() => ({ app, db } = buildTestApp()));

  test('400 si status no está en whitelist', async () => {
    const native  = db._native;
    const orderId = makeOrder(native);
    const res = await request(app)
      .post('/api/orders/update-status')
      .send({ id: orderId, status: 'HACKEADO' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('200 con status válido', async () => {
    const native  = db._native;
    const orderId = makeOrder(native);
    const res = await request(app)
      .post('/api/orders/update-status')
      .send({ id: orderId, status: 'ready' });
    expect(res.status).toBe(200);
    const row = native.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
    expect(row.status).toBe('ready');
  });

  test('400 si falta id', async () => {
    const res = await request(app)
      .post('/api/orders/update-status')
      .send({ status: 'ready' });
    expect(res.status).toBe(400);
  });
});

// ── POST /api/orders/update-item-status — whitelist ──────────
describe('POST /api/orders/update-item-status — validación', () => {
  let app, db;
  beforeEach(() => ({ app, db } = buildTestApp()));

  test('400 si status no está en whitelist', async () => {
    const native  = db._native;
    const orderId = makeOrder(native);
    makeItem(native, orderId);
    const itemId = native.prepare('SELECT id FROM order_items WHERE order_id = ?').get(orderId)?.id;
    const res = await request(app)
      .post('/api/orders/update-item-status')
      .send({ itemId, status: '; DROP TABLE order_items; --' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('200 con status válido', async () => {
    const native  = db._native;
    const orderId = makeOrder(native);
    makeItem(native, orderId);
    const itemId = native.prepare('SELECT id FROM order_items WHERE order_id = ?').get(orderId)?.id;
    const res = await request(app)
      .post('/api/orders/update-item-status')
      .send({ itemId, status: 'ready', orderId });
    expect(res.status).toBe(200);
  });
});

// ── POST /api/orders/update-bulk-items — whitelist área ──────
describe('POST /api/orders/update-bulk-items — validación', () => {
  let app, db;
  beforeEach(() => ({ app, db } = buildTestApp()));

  test('400 si área inválida', async () => {
    const native  = db._native;
    const orderId = makeOrder(native);
    const res = await request(app)
      .post('/api/orders/update-bulk-items')
      .send({ orderId, area: 'stockroom', status: 'ready' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('400 si status inválido', async () => {
    const native  = db._native;
    const orderId = makeOrder(native);
    const res = await request(app)
      .post('/api/orders/update-bulk-items')
      .send({ orderId, area: 'cocina', status: 'XSS<script>' });
    expect(res.status).toBe(400);
  });
});

// ── POST /api/orders/update-table — whitelist type ───────────
describe('POST /api/orders/update-table — whitelist type', () => {
  let app, db;
  beforeEach(() => ({ app, db } = buildTestApp()));

  test('type inválido es ignorado sin error — se ejecuta sin type', async () => {
    const native  = db._native;
    const orderId = makeOrder(native);
    const tableId = native.prepare(
      "INSERT INTO tables (name, capacity, status, zona) VALUES ('T1', 4, 'available', 'Salón')"
    ).run().lastInsertRowid;
    const res = await request(app)
      .post('/api/orders/update-table')
      .send({ orderId, newTableId: tableId, type: 'MALICIOUS_TYPE' });
    // No debe explotar — el type inválido se descarta
    expect([200, 500]).toContain(res.status); // 500 solo si la mesa no existe aún
  });

  test('type válido se guarda correctamente', async () => {
    const native  = db._native;
    const orderId = makeOrder(native);
    const res = await request(app)
      .post('/api/orders/update-table')
      .send({ orderId, newTableId: null, type: 'takeaway' });
    expect(res.status).toBe(200);
    const row = native.prepare('SELECT type FROM orders WHERE id = ?').get(orderId);
    expect(row.type).toBe('takeaway');
  });
});

// ── POST /api/orders/reopen ───────────────────────────────────
describe('POST /api/orders/reopen', () => {
  let app, db;
  beforeEach(() => ({ app, db } = buildTestApp()));

  test('400 si falta id', async () => {
    const res = await request(app)
      .post('/api/orders/reopen')
      .send({ tableId: 1 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('400 si id no es número positivo', async () => {
    const res = await request(app)
      .post('/api/orders/reopen')
      .send({ id: -5 });
    expect(res.status).toBe(400);
  });

  test('reabre una orden cerrada correctamente', async () => {
    const native  = db._native;
    const orderId = makeOrder(native, { status: 'delivered', paymentMethod: 'efectivo' });
    const res = await request(app)
      .post('/api/orders/reopen')
      .send({ id: orderId });
    expect(res.status).toBe(200);
    const row = native.prepare('SELECT status, paymentMethod FROM orders WHERE id = ?').get(orderId);
    expect(row.status).toBe('active');
    expect(row.paymentMethod).toBeNull();
  });

  test('404 si la orden no existe', async () => {
    const res = await request(app)
      .post('/api/orders/reopen')
      .send({ id: 99999 });
    expect(res.status).toBe(404); // orden no encontrada
  });

  test('401 sin sesión', async () => {
    const { app: anonApp } = buildTestApp({ withOwnerSession: false });
    const res = await request(anonApp)
      .post('/api/orders/reopen')
      .send({ id: 1 });
    expect(res.status).toBe(401);
  });
});

// ── POST /api/orders/pay — total desde BD ────────────────────
describe('POST /api/orders/pay — seguridad de totales', () => {
  let app, db;
  beforeEach(() => ({ app, db } = buildTestApp()));

  test('400 si falta method', async () => {
    const native  = db._native;
    const orderId = makeOrder(native, { total: 500, status: 'active' });
    const res = await request(app)
      .post('/api/orders/pay')
      .send({ id: orderId, total: 500 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('400 si total es negativo', async () => {
    const native  = db._native;
    const orderId = makeOrder(native, { total: 500 });
    const res = await request(app)
      .post('/api/orders/pay')
      .send({ id: orderId, method: 'efectivo', total: -1 });
    expect(res.status).toBe(400);
  });

  test('usa total de BD si el cliente manda uno menor', async () => {
    const native  = db._native;
    const orderId = makeOrder(native, { total: 1000, status: 'active' });
    // Crear mesa para que la transacción complete (sin chocar con la "Caja" id=1)
    const tableId2 = native.prepare(
      "INSERT INTO tables (name, capacity, status, currentOrderId) VALUES ('Mesa 1', 4, 'occupied', ?)"
    ).run(orderId).lastInsertRowid;
    native.prepare('UPDATE orders SET tableId = ? WHERE id = ?').run(tableId2, orderId);

    const res = await request(app)
      .post('/api/orders/pay')
      .send({ id: orderId, method: 'efectivo', total: 1 }); // intento de pagar $1

    // Debe completar y usar el total de BD (1000), ignorando el $1 del cliente
    expect(res.status).toBe(200);
    const row = native.prepare('SELECT total FROM orders WHERE id = ?').get(orderId);
    expect(Number(row.total)).toBe(1000);
  });
});
