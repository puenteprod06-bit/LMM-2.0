'use strict';

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

async function finalizeOrder(app, invId, qty, opts = {}) {
  const price = 50;
  const res = await request(app).post('/api/orders/finalize').send({
    subtotal: price * qty, tax: 0, total: price * qty,
    discount: 0, discountAmt: 0,
    type: 'takeaway', tableId: null,
    customer: 'Test', status: 'pending',
    waiterName: 'Test', openedAt: Date.now(),
    paymentMethod: null,
    adminAuthorized: opts.adminAuthorized ?? false,
    items: [{ name: 'Producto', price, qty, lineTotal: price * qty, itemType: 'inventory', invId, area: 'bar', id: invId }]
  });
  return res;
}

describe('Cancel/Reopen inventory integrity (Fase 2B.4)', () => {
  // 1. Cancelar pedido con stock suficiente
  test('1. Cancelar pedido con stock suficiente reintegra stock', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { stock: 10, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 3);
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(7);

    const cancelRes = await request(app).post('/api/orders/update-status').send({ id: orderId, status: 'cancelled' });
    expect(cancelRes.status).toBe(200);

    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(10);

    // return movement recorded
    const movs = native.prepare("SELECT movement_type, quantity FROM stock_movements WHERE reference_id = ? AND movement_type = 'return'").all(orderId);
    expect(movs.length).toBeGreaterThanOrEqual(1);
    expect(movs[0].quantity).toBe(3);
  });

  // 2. Cancelar pedido con faltantes previos
  test('2. Cancelar pedido con faltantes reintegra solo lo descontado', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { stock: 5, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 8, { adminAuthorized: false });
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(0);

    const cancelRes = await request(app).post('/api/orders/update-status').send({ id: orderId, status: 'cancelled' });
    expect(cancelRes.status).toBe(200);

    // effectivePrev = 5, so return 5, not 8
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(5);
  });

  // 3. Cancelar pedido con auth admin y stock negativo
  test('3. Cancelar pedido con stock negativo (auth) reintegra todo', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { stock: 5, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 8, { adminAuthorized: true });
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(-3);

    const cancelRes = await request(app).post('/api/orders/update-status').send({ id: orderId, status: 'cancelled' });
    expect(cancelRes.status).toBe(200);

    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(5);
  });

  // 4. Cancelar pedido modificado
  test('4. Cancelar pedido modificado reintegra lo efectivo', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { stock: 10, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 3);
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;

    // modify 3 -> 5
    await request(app).post('/api/orders/modify-items').send({
      orderId, items: [{ name: 'Producto', price: 50, qty: 5, itemType: 'inventory', invId, area: 'bar' }],
      adminAuthorized: false
    });
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(5);

    const cancelRes = await request(app).post('/api/orders/update-status').send({ id: orderId, status: 'cancelled' });
    expect(cancelRes.status).toBe(200);

    // effectivePrev = 5, return 5
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(10);
  });

  // 5. Cancelar pedido con varios productos
  test('5. Cancelar pedido con varios productos reintegra todos', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId1 = makeInvItem(native, { name: 'P1', stock: 10, salePrice: 50 });
    const invId2 = makeInvItem(native, { name: 'P2', stock: 10, salePrice: 30 });

    const res = await request(app).post('/api/orders/finalize').send({
      subtotal: 50 * 2 + 30 * 3, tax: 0, total: 50 * 2 + 30 * 3,
      discount: 0, discountAmt: 0,
      type: 'takeaway', tableId: null, customer: 'Test', status: 'pending',
      waiterName: 'Test', openedAt: Date.now(), paymentMethod: null,
      items: [
        { name: 'P1', price: 50, qty: 2, lineTotal: 100, itemType: 'inventory', invId: invId1, area: 'bar', id: invId1 },
        { name: 'P2', price: 30, qty: 3, lineTotal: 90, itemType: 'inventory', invId: invId2, area: 'bar', id: invId2 }
      ]
    });
    expect(res.status).toBe(200);
    const orderId = res.body.id;

    const cancelRes = await request(app).post('/api/orders/update-status').send({ id: orderId, status: 'cancelled' });
    expect(cancelRes.status).toBe(200);

    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId1).stock).toBe(10);
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId2).stock).toBe(10);
  });

  // 6. Cancelar pedido dos veces (idempotencia)
  test('6. Cancelar dos veces no duplica reintegro', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { stock: 10, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 3);
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;

    await request(app).post('/api/orders/update-status').send({ id: orderId, status: 'cancelled' });
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(10);

    // Second cancel
    await request(app).post('/api/orders/update-status').send({ id: orderId, status: 'cancelled' });
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(10);
  });

  // 7. Reabrir pedido cancelado
  test('7. Reabrir pedido cancelado re-descuenta stock', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { stock: 10, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 3);
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;

    await request(app).post('/api/orders/update-status').send({ id: orderId, status: 'cancelled' });
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(10);

    const reopenRes = await request(app).post('/api/orders/reopen').send({ id: orderId });
    expect(reopenRes.status).toBe(200);
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(7);
    expect(native.prepare('SELECT status FROM orders WHERE id = ?').get(orderId).status).toBe('active');
  });

  // 8. Reabrir pedido dos veces
  test('8. Reabrir dos veces no duplica descuento', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { stock: 10, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 3);
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;

    await request(app).post('/api/orders/update-status').send({ id: orderId, status: 'cancelled' });
    await request(app).post('/api/orders/reopen').send({ id: orderId });
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(7);

    // Second reopen (already active)
    await request(app).post('/api/orders/reopen').send({ id: orderId });
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(7);
  });

  // 9. Reabrir y volver a finalizar
  test('9. Reabrir y cancelar de nuevo es consistente', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { stock: 10, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 3);
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;

    await request(app).post('/api/orders/update-status').send({ id: orderId, status: 'cancelled' });
    await request(app).post('/api/orders/reopen').send({ id: orderId });
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(7);

    await request(app).post('/api/orders/update-status').send({ id: orderId, status: 'cancelled' });
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(10);
  });

  // 10. Cancelar después de reabrir
  test('10. Cancelar despues de reabrir reintegra stock', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { stock: 10, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 3);
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;

    await request(app).post('/api/orders/update-status').send({ id: orderId, status: 'cancelled' });
    await request(app).post('/api/orders/reopen').send({ id: orderId });
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(7);

    const cancelRes = await request(app).post('/api/orders/update-status').send({ id: orderId, status: 'cancelled' });
    expect(cancelRes.status).toBe(200);
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(10);
  });

  // 11. No reintegros duplicados
  test('11. No reintegros duplicados en cancel repetido', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { stock: 10, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 3);
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;

    await request(app).post('/api/orders/update-status').send({ id: orderId, status: 'cancelled' });
    const returnCount1 = native.prepare("SELECT COUNT(*) AS c FROM stock_movements WHERE reference_id = ? AND movement_type = 'return'").get(orderId).c;

    await request(app).post('/api/orders/update-status').send({ id: orderId, status: 'cancelled' });
    const returnCount2 = native.prepare("SELECT COUNT(*) AS c FROM stock_movements WHERE reference_id = ? AND movement_type = 'return'").get(orderId).c;

    expect(returnCount2).toBe(returnCount1);
  });

  // 12. No descuentos duplicados
  test('12. No descuentos duplicados en reopen repetido', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { stock: 10, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 3);
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;

    await request(app).post('/api/orders/update-status').send({ id: orderId, status: 'cancelled' });
    await request(app).post('/api/orders/reopen').send({ id: orderId });
    const saleCount1 = native.prepare("SELECT COUNT(*) AS c FROM stock_movements WHERE reference_id = ? AND movement_type = 'sale'").get(orderId).c;

    await request(app).post('/api/orders/reopen').send({ id: orderId });
    const saleCount2 = native.prepare("SELECT COUNT(*) AS c FROM stock_movements WHERE reference_id = ? AND movement_type = 'sale'").get(orderId).c;

    expect(saleCount2).toBe(saleCount1);
  });

  // 13. Movimientos return con stock_before/stock_after
  test('13. Movimiento return tiene stock_before y stock_after correctos', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { stock: 10, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 3);
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;

    await request(app).post('/api/orders/update-status').send({ id: orderId, status: 'cancelled' });

    const mov = native.prepare("SELECT stock_before, stock_after, quantity FROM stock_movements WHERE reference_id = ? AND movement_type = 'return'").get(orderId);
    expect(mov).toBeDefined();
    expect(mov.stock_before).toBe(7);
    expect(mov.stock_after).toBe(10);
    expect(mov.quantity).toBe(3);
  });

  // 14. stock_before/stock_after en reopen
  test('14. Movimiento sale en reopen tiene stock_before/stock_after correctos', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { stock: 10, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 3);
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;

    await request(app).post('/api/orders/update-status').send({ id: orderId, status: 'cancelled' });
    await request(app).post('/api/orders/reopen').send({ id: orderId });

    const movs = native.prepare("SELECT stock_before, stock_after, quantity FROM stock_movements WHERE reference_id = ? AND movement_type = 'sale' ORDER BY id DESC").all(orderId);
    const lastSale = movs[0];
    expect(lastSale.stock_before).toBe(10);
    expect(lastSale.stock_after).toBe(7);
    expect(lastSale.quantity).toBe(3);
  });

  // 15. Usuario responsable registrado
  test('15. Movimiento registra usuario responsable', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { stock: 10, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 3);
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;

    await request(app).post('/api/orders/update-status').send({ id: orderId, status: 'cancelled' });

    const mov = native.prepare("SELECT user_name, user_role FROM stock_movements WHERE reference_id = ? AND movement_type = 'return'").get(orderId);
    expect(mov.user_name).toBe('Test Owner');
    expect(mov.user_role).toBe('owner');
  });

  // 16. Usuario sin permisos
  test('16. Usuario sin sesion no puede cancelar', async () => {
    const { app: anonApp } = buildTestApp({ withOwnerSession: false });
    const res = await request(anonApp).post('/api/orders/update-status').send({ id: 1, status: 'cancelled' });
    expect(res.status).toBe(401);
  });

  // 17. Rollback ante errores
  test('17. Cancelar orden inexistente no modifica stock', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { stock: 10, salePrice: 50 });

    const stockBefore = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock;

    const cancelRes = await request(app).post('/api/orders/update-status').send({ id: 99999, status: 'cancelled' });
    expect(cancelRes.status).toBe(404);

    const stockAfter = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock;
    expect(stockAfter).toBe(stockBefore);
  });

  // 18. Consistencia stock y movimientos
  test('18. Consistencia: stock final = inicial - neto movimientos', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { stock: 10, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 3);
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;

    await request(app).post('/api/orders/update-status').send({ id: orderId, status: 'cancelled' });
    await request(app).post('/api/orders/reopen').send({ id: orderId });

    const stock = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock;
    expect(stock).toBe(7);

    const sales = native.prepare("SELECT COALESCE(SUM(quantity),0) AS s FROM stock_movements WHERE reference_id=? AND inventory_id=? AND movement_type='sale'").get(orderId, invId).s;
    const returns = native.prepare("SELECT COALESCE(SUM(quantity),0) AS s FROM stock_movements WHERE reference_id=? AND inventory_id=? AND movement_type='return'").get(orderId, invId).s;
    expect(sales - returns).toBe(3);
  });

  // 19. Pedidos sin descuento previo no generan reintegros
  test('19. Pedido sin items de inventario no genera reintegro', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);

    const menuId = native.prepare("INSERT INTO menu_items (name, price, catId, available) VALUES ('Burger', 100, 1, 1)").run().lastInsertRowid;
    const orderId = native.prepare(`
      INSERT INTO orders (subtotal, tax, total, discount, discountAmt, type, customer, status, createdAt, waiterName, openedAt)
      VALUES (100, 10, 110, 0, 0, 'takeaway', 'Test', 'pending', ?, 'Test', ?)
    `).run(Date.now(), Date.now()).lastInsertRowid;
    native.prepare(`
      INSERT INTO order_items (order_id, name, price, qty, lineTotal, itemType, area, status, createdAt, deleted)
      VALUES (?, 'Burger', 100, 1, 100, 'menu', 'cocina', 'pending', ?, 0)
    `).run(orderId, Date.now());

    const returnCountBefore = native.prepare("SELECT COUNT(*) AS c FROM stock_movements WHERE reference_id = ? AND movement_type = 'return'").get(orderId).c;

    const cancelRes = await request(app).post('/api/orders/update-status').send({ id: orderId, status: 'cancelled' });
    expect(cancelRes.status).toBe(200);

    const returnCountAfter = native.prepare("SELECT COUNT(*) AS c FROM stock_movements WHERE reference_id = ? AND movement_type = 'return'").get(orderId).c;
    expect(returnCountAfter).toBe(returnCountBefore);
  });

  // 21. Prueba critica: cancelar, reabrir y finalizar no duplica descuento
  test('21. Cancelar -> reabrir -> finalizar: stock se mantiene', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { stock: 10, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 3);
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(7);

    await request(app).post('/api/orders/update-status').send({ id: orderId, status: 'cancelled' });
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(10);

    await request(app).post('/api/orders/reopen').send({ id: orderId });
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(7);

    const finRes2 = await finalizeOrder(app, invId, 3);
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(7);
  });

  // 22. Faltantes: cancelar, reabrir, finalizar
  test('22. Con faltantes: cancelar -> reabrir -> finalizar consistente', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { stock: 5, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 8, { adminAuthorized: false });
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(0);

    await request(app).post('/api/orders/update-status').send({ id: orderId, status: 'cancelled' });
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(5);

    await request(app).post('/api/orders/reopen').send({ id: orderId });
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(0);

    const finRes2 = await finalizeOrder(app, invId, 8, { adminAuthorized: false });
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(0);
  });

  // 23. Auth admin
  test('23. Con auth admin: cancelar -> reabrir -> finalizar consistente', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { stock: 5, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 8, { adminAuthorized: true });
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(-3);

    await request(app).post('/api/orders/update-status').send({ id: orderId, status: 'cancelled' });
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(5);

    await request(app).post('/api/orders/reopen').send({ id: orderId });
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(-3);

    const finRes2 = await finalizeOrder(app, invId, 8, { adminAuthorized: true });
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(-3);
  });

  // 24. Modificado
  test('24. Modificado: cancelar -> reabrir -> finalizar consistente', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { stock: 10, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 3);
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;

    await request(app).post('/api/orders/modify-items').send({
      orderId, items: [{ name: 'Producto', price: 50, qty: 5, itemType: 'inventory', invId, area: 'bar' }],
      adminAuthorized: false
    });
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(5);

    await request(app).post('/api/orders/update-status').send({ id: orderId, status: 'cancelled' });
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(10);

    await request(app).post('/api/orders/reopen').send({ id: orderId });
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(5);

    const finRes2 = await finalizeOrder(app, invId, 5);
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(5);
  });

  // 20. Reopen de orden delivered (no cancelada) no cambia stock
  test('20. Reopen de orden delivered no modifica stock', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { stock: 10, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 3);
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;

    // Mark as delivered (simulate pay)
    await request(app).post('/api/orders/update-status').send({ id: orderId, status: 'delivered' });

    const stockBefore = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock;
    expect(stockBefore).toBe(7);

    const reopenRes = await request(app).post('/api/orders/reopen').send({ id: orderId });
    expect(reopenRes.status).toBe(200);

    const stockAfter = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock;
    expect(stockAfter).toBe(7);
  });
});