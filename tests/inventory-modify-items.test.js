'use strict';

/**
 * tests/inventory-modify-items.test.js
 *
 * Pruebas de integridad de stock al modificar pedidos (Fase 2B.3).
 * Valida la reconciliacion de stock en modify-items.
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

function addOrderItem(native, orderId, overrides = {}) {
  const r = native.prepare(`
    INSERT INTO order_items (order_id, name, price, qty, lineTotal, note, itemType, invId, area, status, createdAt, deleted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    orderId,
    overrides.name ?? 'Producto',
    overrides.price ?? 50,
    overrides.qty ?? 1,
    overrides.lineTotal ?? 50,
    overrides.note ?? '',
    overrides.itemType ?? 'inventory',
    overrides.invId ?? null,
    overrides.area ?? 'bar',
    overrides.status ?? 'pending',
    overrides.createdAt ?? Date.now()
  );
  return r.lastInsertRowid;
}

async function finalizeOrder(app, invId, qty, stock) {
  const price = 50;
  const res = await request(app).post('/api/orders/finalize').send({
    subtotal: price * qty, tax: 0, total: price * qty,
    discount: 0, discountAmt: 0,
    type: 'takeaway', tableId: null,
    customer: 'Test', status: 'pending',
    waiterName: 'Test', openedAt: Date.now(),
    paymentMethod: null,
    items: [{ name: 'Producto', price, qty, lineTotal: price * qty, itemType: 'inventory', invId, area: 'bar', id: invId }]
  });
  return res;
}

describe('POST /api/orders/modify-items — reconciliacion de stock (Fase 2B.3)', () => {
  // Test 1: Eliminar un producto reintegra stock
  test('1. Eliminar producto reintegra stock', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { name: 'Prod', stock: 10, salePrice: 50 });

    // Finalize order with 3 units
    const finRes = await finalizeOrder(app, invId, 3, 10);
    expect(finRes.status).toBe(200);

    const invAfterFinalize = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(invAfterFinalize.stock).toBe(7); // 10 - 3

    // Get orderId
    const orderId = finRes.body.id;

    // Modify: remove product (empty-ish, but need at least one item... use menu item)
    // Actually modify to remove inventory item entirely - send only a menu item? 
    // But we need to test removal. Let's send empty inventory by using a menu item.
    // Instead, create a menu item for the replacement
    const menuId = native.prepare("INSERT INTO menu_items (name, price, catId, available) VALUES ('MenuX', 10, 1, 1)").run().lastInsertRowid;

    const modRes = await request(app).post('/api/orders/modify-items').send({
      orderId,
      items: [{ id: menuId, name: 'MenuX', price: 10, qty: 1, itemType: 'menu', area: 'cocina' }],
      adminAuthorized: false
    });
    expect(modRes.status).toBe(200);

    const invAfterModify = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(invAfterModify.stock).toBe(10); // reintegrated 3
  });

  // Test 2: Reducir cantidad reintegra diferencia
  test('2. Reducir cantidad reintegra diferencia', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { name: 'Prod', stock: 10, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 5, 10);
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;

    const invAfterFinalize = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(invAfterFinalize.stock).toBe(5); // 10 - 5

    // Modify: reduce to 2
    const modRes = await request(app).post('/api/orders/modify-items').send({
      orderId,
      items: [{ name: 'Producto', price: 50, qty: 2, itemType: 'inventory', invId, area: 'bar' }],
      adminAuthorized: false
    });
    expect(modRes.status).toBe(200);

    const invAfterModify = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(invAfterModify.stock).toBe(8); // 5 + (5-2) = 8
  });

  // Test 3: Aumentar cantidad con stock suficiente
  test('3. Aumentar cantidad con stock suficiente', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { name: 'Prod', stock: 10, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 2, 10);
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;

    const invAfterFinalize = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(invAfterFinalize.stock).toBe(8); // 10 - 2

    // Modify: increase to 5 (need 3 more, stock has 8)
    const modRes = await request(app).post('/api/orders/modify-items').send({
      orderId,
      items: [{ name: 'Producto', price: 50, qty: 5, itemType: 'inventory', invId, area: 'bar' }],
      adminAuthorized: false
    });
    expect(modRes.status).toBe(200);

    const invAfterModify = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(invAfterModify.stock).toBe(5); // 8 - 3 = 5
  });

  // Test 4: Aumentar cantidad con stock insuficiente sin autorizacion
  test('4. Aumentar cantidad stock insuficiente sin auth: stock queda en 0', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { name: 'Prod', stock: 10, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 2, 10);
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;

    const invAfterFinalize = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(invAfterFinalize.stock).toBe(8);

    // Modify: increase to 20 (need 18 more, only 8 available)
    const modRes = await request(app).post('/api/orders/modify-items').send({
      orderId,
      items: [{ name: 'Producto', price: 50, qty: 20, itemType: 'inventory', invId, area: 'bar' }],
      adminAuthorized: false
    });
    expect(modRes.status).toBe(200);

    const invAfterModify = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(invAfterModify.stock).toBe(0); // 8 - 8 = 0
  });

  // Test 5: Aumentar cantidad con autorizacion admin valida
  test('5. Aumentar cantidad con auth admin: stock negativo permitido', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { name: 'Prod', stock: 10, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 2, 10);
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;

    const invAfterFinalize = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(invAfterFinalize.stock).toBe(8);

    // Modify: increase to 20 with admin auth
    const modRes = await request(app).post('/api/orders/modify-items').send({
      orderId,
      items: [{ name: 'Producto', price: 50, qty: 20, itemType: 'inventory', invId, area: 'bar' }],
      adminAuthorized: true
    });
    expect(modRes.status).toBe(200);

    const invAfterModify = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    // 8 - 18 = -10
    expect(invAfterModify.stock).toBe(-10);
  });

  // Test 6: Agregar producto nuevo
  test('6. Agregar producto nuevo descuenta stock', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId1 = makeInvItem(native, { name: 'Prod1', stock: 10, salePrice: 50 });
    const invId2 = makeInvItem(native, { name: 'Prod2', stock: 10, salePrice: 30 });

    const finRes = await finalizeOrder(app, invId1, 2, 10);
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;

    const inv1After = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId1);
    expect(inv1After.stock).toBe(8);

    // Modify: keep prod1 at 2, add prod2 with 3
    const modRes = await request(app).post('/api/orders/modify-items').send({
      orderId,
      items: [
        { name: 'Producto', price: 50, qty: 2, itemType: 'inventory', invId: invId1, area: 'bar' },
        { name: 'Prod2', price: 30, qty: 3, itemType: 'inventory', invId: invId2, area: 'bar' }
      ],
      adminAuthorized: false
    });
    expect(modRes.status).toBe(200);

    const inv1Final = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId1);
    expect(inv1Final.stock).toBe(8); // unchanged

    const inv2Final = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId2);
    expect(inv2Final.stock).toBe(7); // 10 - 3
  });

  // Test 7: Eliminar todos los productos
  test('7. Eliminar todos los productos reintegra stock', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { name: 'Prod', stock: 10, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 4, 10);
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;

    const invAfterFinalize = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(invAfterFinalize.stock).toBe(6); // 10 - 4

    // Need at least one item in modify-items. Use a menu item.
    const menuId = native.prepare("INSERT INTO menu_items (name, price, catId, available) VALUES ('MenuX', 10, 1, 1)").run().lastInsertRowid;

    const modRes = await request(app).post('/api/orders/modify-items').send({
      orderId,
      items: [{ id: menuId, name: 'MenuX', price: 10, qty: 1, itemType: 'menu', area: 'cocina' }],
      adminAuthorized: false
    });
    expect(modRes.status).toBe(200);

    const invAfterModify = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(invAfterModify.stock).toBe(10); // reintegrated 4
  });

  // Test 8: Modificar varios productos simultaneamente
  test('8. Modificar varios productos simultaneamente', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId1 = makeInvItem(native, { name: 'Prod1', stock: 10, salePrice: 50 });
    const invId2 = makeInvItem(native, { name: 'Prod2', stock: 10, salePrice: 30 });

    // Finalize with both products
    const price1 = 50, price2 = 30;
    const res = await request(app).post('/api/orders/finalize').send({
      subtotal: price1 * 2 + price2 * 3, tax: 0, total: price1 * 2 + price2 * 3,
      discount: 0, discountAmt: 0,
      type: 'takeaway', tableId: null,
      customer: 'Test', status: 'pending',
      waiterName: 'Test', openedAt: Date.now(),
      paymentMethod: null,
      items: [
        { name: 'Prod1', price: price1, qty: 2, lineTotal: price1 * 2, itemType: 'inventory', invId: invId1, area: 'bar', id: invId1 },
        { name: 'Prod2', price: price2, qty: 3, lineTotal: price2 * 3, itemType: 'inventory', invId: invId2, area: 'bar', id: invId2 }
      ]
    });
    expect(res.status).toBe(200);
    const orderId = res.body.id;

    const inv1 = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId1);
    const inv2 = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId2);
    expect(inv1.stock).toBe(8); // 10 - 2
    expect(inv2.stock).toBe(7); // 10 - 3

    // Modify: prod1 from 2 to 4 (increase 2), prod2 from 3 to 1 (decrease 2)
    const modRes = await request(app).post('/api/orders/modify-items').send({
      orderId,
      items: [
        { name: 'Prod1', price: 50, qty: 4, itemType: 'inventory', invId: invId1, area: 'bar' },
        { name: 'Prod2', price: 30, qty: 1, itemType: 'inventory', invId: invId2, area: 'bar' }
      ],
      adminAuthorized: false
    });
    expect(modRes.status).toBe(200);

    const inv1Final = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId1);
    const inv2Final = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId2);
    expect(inv1Final.stock).toBe(6); // 8 - 2 = 6
    expect(inv2Final.stock).toBe(9); // 7 + 2 = 9
  });

  // Test 9: Productos con stock negativo
  test('9. Productos con stock negativo (admin auth)', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { name: 'Prod', stock: 5, salePrice: 50 });

    // Finalize with shortage (admin auth)
    const res = await request(app).post('/api/orders/finalize').send({
      subtotal: 50 * 8, tax: 0, total: 50 * 8,
      discount: 0, discountAmt: 0,
      type: 'takeaway', tableId: null,
      customer: 'Test', status: 'pending',
      waiterName: 'Test', openedAt: Date.now(),
      paymentMethod: null,
      adminAuthorized: true,
      items: [{ name: 'Prod', price: 50, qty: 8, lineTotal: 50 * 8, itemType: 'inventory', invId, area: 'bar', id: invId }]
    });
    expect(res.status).toBe(200);
    const orderId = res.body.id;

    const invAfterFinalize = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(invAfterFinalize.stock).toBe(-3); // 5 - 8 = -3

    // Modify: reduce to 6 (reintegrate 2)
    const modRes = await request(app).post('/api/orders/modify-items').send({
      orderId,
      items: [{ name: 'Prod', price: 50, qty: 6, itemType: 'inventory', invId, area: 'bar' }],
      adminAuthorized: false
    });
    expect(modRes.status).toBe(200);

    const invAfterModify = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(invAfterModify.stock).toBe(-1); // -3 + 2 = -1
  });

  // Test 10: Productos que previamente tuvieron faltantes
  test('10. Productos con faltantes previos', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { name: 'Prod', stock: 5, salePrice: 50 });

    // Finalize with shortage (no auth) -> stock 0, shortage 3
    const res = await request(app).post('/api/orders/finalize').send({
      subtotal: 50 * 8, tax: 0, total: 50 * 8,
      discount: 0, discountAmt: 0,
      type: 'takeaway', tableId: null,
      customer: 'Test', status: 'pending',
      waiterName: 'Test', openedAt: Date.now(),
      paymentMethod: null,
      adminAuthorized: false,
      items: [{ name: 'Prod', price: 50, qty: 8, lineTotal: 50 * 8, itemType: 'inventory', invId, area: 'bar', id: invId }]
    });
    expect(res.status).toBe(200);
    const orderId = res.body.id;

    const invAfterFinalize = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(invAfterFinalize.stock).toBe(0); // 5 - 5 = 0 (shortage 3)

    // Modify: reduce to 4 (reintegrate 4? No - prev was 8 requested but only 5 discounted)
    // The reconciliation uses prevQty=8 (order_items qty), newQty=4
    // diff = 4 - 8 = -4 -> reintegrate 4
    const modRes = await request(app).post('/api/orders/modify-items').send({
      orderId,
      items: [{ name: 'Prod', price: 50, qty: 4, itemType: 'inventory', invId, area: 'bar' }],
      adminAuthorized: false
    });
    expect(modRes.status).toBe(200);

    const invAfterModify = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    // Stock was 0, efectivamente descontado 5, reintegro 5 - min(4,5) = 1 -> 1
    expect(invAfterModify.stock).toBe(1);
  });

  // Test 11: Reintentar la misma modificacion (idempotencia)
  test('11. Reintentar misma modificacion no duplica', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { name: 'Prod', stock: 10, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 3, 10);
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;

    const invAfterFinalize = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(invAfterFinalize.stock).toBe(7);

    // Modify twice with same change
    const modRes1 = await request(app).post('/api/orders/modify-items').send({
      orderId,
      items: [{ name: 'Prod', price: 50, qty: 5, itemType: 'inventory', invId, area: 'bar' }],
      adminAuthorized: false
    });
    expect(modRes1.status).toBe(200);

    const stockAfterFirst = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    // 7 - 2 = 5
    expect(stockAfterFirst.stock).toBe(5);

    // Second modify: same target qty 5 (diff = 0 now since already 5)
    const modRes2 = await request(app).post('/api/orders/modify-items').send({
      orderId,
      items: [{ name: 'Prod', price: 50, qty: 5, itemType: 'inventory', invId, area: 'bar' }],
      adminAuthorized: false
    });
    expect(modRes2.status).toBe(200);

    const stockAfterSecond = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(stockAfterSecond.stock).toBe(5); // no change
  });

  // Test 12: Error durante transaccion y rollback
  test('12. Error durante transaccion: rollback', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { name: 'Prod', stock: 10, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 3, 10);
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;

    const stockBefore = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(stockBefore.stock).toBe(7);

    // Modify with invalid item (bad area) -> should fail before transaction
    const modRes = await request(app).post('/api/orders/modify-items').send({
      orderId,
      items: [{ name: 'Prod', price: 50, qty: 5, itemType: 'inventory', invId, area: 'INVALIDA' }],
      adminAuthorized: false
    });
    expect(modRes.status).toBe(400);

    const stockAfter = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(stockAfter.stock).toBe(7); // unchanged
  });

  // Test 13: Verificar movimientos registrados
  test('13. Movimientos registrados en stock_movements', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { name: 'Prod', stock: 10, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 3, 10);
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;

    // Modify: reduce to 1 (reintegrate 2)
    const modRes = await request(app).post('/api/orders/modify-items').send({
      orderId,
      items: [{ name: 'Prod', price: 50, qty: 1, itemType: 'inventory', invId, area: 'bar' }],
      adminAuthorized: false
    });
    expect(modRes.status).toBe(200);

    // Check stock_movements for return movement
    const movements = native.prepare(
      "SELECT * FROM stock_movements WHERE reference_type = 'order' AND reference_id = ? AND movement_type = 'return'"
    ).all(orderId);
    expect(movements.length).toBeGreaterThanOrEqual(1);
    expect(movements[0].quantity).toBe(2);
  });

  // Test 14: Verificar que no se duplique stock
  test('14. No duplicar stock en re-modificacion', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { name: 'Prod', stock: 10, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 3, 10);
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;

    // First modify: 3 -> 5 (increase 2)
    const modRes1 = await request(app).post('/api/orders/modify-items').send({
      orderId,
      items: [{ name: 'Prod', price: 50, qty: 5, itemType: 'inventory', invId, area: 'bar' }],
      adminAuthorized: false
    });
    expect(modRes1.status).toBe(200);

    const stock1 = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(stock1.stock).toBe(5); // 7 - 2 = 5

    // Second modify: 5 -> 5 (no change)
    const modRes2 = await request(app).post('/api/orders/modify-items').send({
      orderId,
      items: [{ name: 'Prod', price: 50, qty: 5, itemType: 'inventory', invId, area: 'bar' }],
      adminAuthorized: false
    });
    expect(modRes2.status).toBe(200);

    const stock2 = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(stock2.stock).toBe(5); // unchanged
  });

  // Test 16: Venta con faltante y posterior eliminacion del producto
  test('16. Faltante + eliminacion: stock se reintegra correctamente', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { name: 'Prod', stock: 5, salePrice: 50 });

    const finRes = await request(app).post('/api/orders/finalize').send({
      subtotal: 50 * 8, tax: 0, total: 50 * 8, discount: 0, discountAmt: 0,
      type: 'takeaway', tableId: null, customer: 'Test', status: 'pending',
      waiterName: 'Test', openedAt: Date.now(), paymentMethod: null,
      adminAuthorized: false,
      items: [{ name: 'Prod', price: 50, qty: 8, lineTotal: 50 * 8, itemType: 'inventory', invId, area: 'bar', id: invId }]
    });
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(0);

    const menuId = native.prepare("INSERT INTO menu_items (name, price, catId, available) VALUES ('MenuX', 10, 1, 1)").run().lastInsertRowid;
    const modRes = await request(app).post('/api/orders/modify-items').send({
      orderId, items: [{ id: menuId, name: 'MenuX', price: 10, qty: 1, itemType: 'menu', area: 'cocina' }],
      adminAuthorized: false
    });
    expect(modRes.status).toBe(200);
    // effectivePrev = 5, newQty = 0 -> returnQty = 5 - 0 = 5
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(5);
  });

  // Test 17: Venta con faltante y posterior aumento de cantidad
  test('17. Faltante + aumento: stock se ajusta correctamente', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { name: 'Prod', stock: 5, salePrice: 50 });

    const finRes = await request(app).post('/api/orders/finalize').send({
      subtotal: 50 * 8, tax: 0, total: 50 * 8, discount: 0, discountAmt: 0,
      type: 'takeaway', tableId: null, customer: 'Test', status: 'pending',
      waiterName: 'Test', openedAt: Date.now(), paymentMethod: null,
      adminAuthorized: false,
      items: [{ name: 'Prod', price: 50, qty: 8, lineTotal: 50 * 8, itemType: 'inventory', invId, area: 'bar', id: invId }]
    });
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(0);

    // Increase to 10 (2 more)
    const modRes = await request(app).post('/api/orders/modify-items').send({
      orderId, items: [{ name: 'Prod', price: 50, qty: 10, itemType: 'inventory', invId, area: 'bar' }],
      adminAuthorized: false
    });
    expect(modRes.status).toBe(200);
    // effectivePrev = 5, increase = 2, available = 0 -> shortage 2, stock stays 0
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(0);
  });

  // Test 18: Venta con auth admin y posterior eliminacion
  test('18. Auth admin + eliminacion: stock se reintegra todo', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { name: 'Prod', stock: 5, salePrice: 50 });

    const finRes = await request(app).post('/api/orders/finalize').send({
      subtotal: 50 * 8, tax: 0, total: 50 * 8, discount: 0, discountAmt: 0,
      type: 'takeaway', tableId: null, customer: 'Test', status: 'pending',
      waiterName: 'Test', openedAt: Date.now(), paymentMethod: null,
      adminAuthorized: true,
      items: [{ name: 'Prod', price: 50, qty: 8, lineTotal: 50 * 8, itemType: 'inventory', invId, area: 'bar', id: invId }]
    });
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(-3);

    const menuId = native.prepare("INSERT INTO menu_items (name, price, catId, available) VALUES ('MenuX', 10, 1, 1)").run().lastInsertRowid;
    const modRes = await request(app).post('/api/orders/modify-items').send({
      orderId, items: [{ id: menuId, name: 'MenuX', price: 10, qty: 1, itemType: 'menu', area: 'cocina' }],
      adminAuthorized: false
    });
    expect(modRes.status).toBe(200);
    // effectivePrev = 8, newQty = 0 -> returnQty = 8
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(5);
  });

  // Test 19: Modificacion sucesiva 3 -> 5 -> 3 -> 5
  test('19. Modificacion sucesiva 3->5->3->5 registra todos los movimientos', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { name: 'Prod', stock: 10, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 3, 10);
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(7);

    // 3 -> 5
    const m1 = await request(app).post('/api/orders/modify-items').send({
      orderId, items: [{ name: 'Producto', price: 50, qty: 5, itemType: 'inventory', invId, area: 'bar' }],
      adminAuthorized: false
    });
    expect(m1.status).toBe(200);
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(5);

    // 5 -> 3
    const m2 = await request(app).post('/api/orders/modify-items').send({
      orderId, items: [{ name: 'Producto', price: 50, qty: 3, itemType: 'inventory', invId, area: 'bar' }],
      adminAuthorized: false
    });
    expect(m2.status).toBe(200);
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(7);

    // 3 -> 5
    const m3 = await request(app).post('/api/orders/modify-items').send({
      orderId, items: [{ name: 'Producto', price: 50, qty: 5, itemType: 'inventory', invId, area: 'bar' }],
      adminAuthorized: false
    });
    expect(m3.status).toBe(200);
    expect(native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock).toBe(5);

    // Should have multiple sale/return movements
    const movs = native.prepare("SELECT movement_type FROM stock_movements WHERE reference_id = ?").all(orderId);
    expect(movs.length).toBeGreaterThanOrEqual(4);
  });

  // Test 20: Dos modificaciones legitimas con iguales cantidades finales en momentos diferentes
  test('20. Dos mods con igual cantidad final registran movimientos distintos', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { name: 'Prod', stock: 10, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 2, 10);
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;

    // 2 -> 4
    await request(app).post('/api/orders/modify-items').send({
      orderId, items: [{ name: 'Producto', price: 50, qty: 4, itemType: 'inventory', invId, area: 'bar' }],
      adminAuthorized: false
    });
    // 4 -> 2
    await request(app).post('/api/orders/modify-items').send({
      orderId, items: [{ name: 'Producto', price: 50, qty: 2, itemType: 'inventory', invId, area: 'bar' }],
      adminAuthorized: false
    });
    // 2 -> 4 (again, legitimate)
    await request(app).post('/api/orders/modify-items').send({
      orderId, items: [{ name: 'Producto', price: 50, qty: 4, itemType: 'inventory', invId, area: 'bar' }],
      adminAuthorized: false
    });

    const saleMovs = native.prepare("SELECT COUNT(*) AS c FROM stock_movements WHERE reference_id = ? AND movement_type = 'sale'").get(orderId);
    // finalize sale + 2 increases = at least 3 sale movements
    expect(saleMovs.c).toBeGreaterThanOrEqual(3);
  });

  // Test 21: Consistencia descuentos/faltantes/reintegros
  test('21. Consistencia: stock final coincide con suma de movimientos', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: true });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);
    const invId = makeInvItem(native, { name: 'Prod', stock: 10, salePrice: 50 });

    const finRes = await finalizeOrder(app, invId, 3, 10);
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;

    // 3 -> 6 (increase 3)
    await request(app).post('/api/orders/modify-items').send({
      orderId, items: [{ name: 'Producto', price: 50, qty: 6, itemType: 'inventory', invId, area: 'bar' }],
      adminAuthorized: false
    });

    // Verify stock
    const stock = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId).stock;
    // 10 - 3 - 3 = 4
    expect(stock).toBe(4);

    // Verify movements sum
    const sales = native.prepare("SELECT COALESCE(SUM(quantity),0) AS s FROM stock_movements WHERE reference_id=? AND inventory_id=? AND movement_type='sale'").get(orderId, invId).s;
    const returns = native.prepare("SELECT COALESCE(SUM(quantity),0) AS s FROM stock_movements WHERE reference_id=? AND inventory_id=? AND movement_type='return'").get(orderId, invId).s;
    // net discounted = sales - returns = 6 (final qty)
    expect(sales - returns).toBe(6);
  });

  // Test 15: Usuario comun no puede autorizar stock negativo
  test('15. Usuario comun no puede autorizar stock negativo en modify', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: false });
    const native = db._native;
    const { setDbForTesting } = require('../db');
    setDbForTesting(native);

    // Insert non-admin session
    native.prepare(
      `INSERT INTO local_session (id, email, role, name, restaurant, is_client)
       VALUES (1, 'waiter@test.com', 'waiter', 'Mesero', 'Resto', 1)`
    ).run();

    const invId = makeInvItem(native, { name: 'Prod', stock: 10, salePrice: 50 });

    // Create order directly in DB (stock not discounted via finalize since no admin)
    // Use finalize with no shortage first
    const finRes = await request(app).post('/api/orders/finalize').send({
      subtotal: 50 * 2, tax: 0, total: 50 * 2,
      discount: 0, discountAmt: 0,
      type: 'takeaway', tableId: null,
      customer: 'Test', status: 'pending',
      waiterName: 'Test', openedAt: Date.now(),
      paymentMethod: null,
      items: [{ name: 'Prod', price: 50, qty: 2, lineTotal: 100, itemType: 'inventory', invId, area: 'bar', id: invId }]
    });
    expect(finRes.status).toBe(200);
    const orderId = finRes.body.id;

    const invAfterFinalize = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    expect(invAfterFinalize.stock).toBe(8);

    // Modify: increase to 20 with adminAuthorized=true (but session is waiter)
    const modRes = await request(app).post('/api/orders/modify-items').send({
      orderId,
      items: [{ name: 'Prod', price: 50, qty: 20, itemType: 'inventory', invId, area: 'bar' }],
      adminAuthorized: true
    });
    expect(modRes.status).toBe(200);

    const invAfterModify = native.prepare('SELECT stock FROM inventory WHERE id = ?').get(invId);
    // Only 8 available, so stock goes to 0 (not negative)
    expect(invAfterModify.stock).toBe(0);
  });
});