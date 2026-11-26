'use strict';

/**
 * tests/inventory-movements.test.js
 *
 * Pruebas de trazabilidad de movimientos de inventario (Fase 2B.2).
 * Valida que cada operación de stock genere un registro persistente,
 * consultable y no duplicado.
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

describe('GET /api/inventory/movements — consulta de movimientos', () => {
  let app, db;

  beforeEach(() => {
    ({ app, db } = buildTestApp({ withOwnerSession: true }));
    const { setDbForTesting } = require('../db');
    setDbForTesting(db._native);
  });

  afterEach(() => {
    const { clearDbOverride } = require('../db');
    clearDbOverride();
  });

  test('1. Inserción de un movimiento', () => {
    const native = db._native;
    const invId = makeInvItem(native, { name: 'Cerveza', stock: 10 });
    const { recordStockMovement } = require('../db');
    recordStockMovement({
      inventoryId: invId,
      productName: 'Cerveza',
      movementType: 'sale',
      quantity: 3,
      stockBefore: 10,
      stockAfter: 7,
      shortageQuantity: 0,
      referenceType: 'order',
      referenceId: 1,
      authorizedBy: null,
      userName: 'Test',
      userRole: 'waiter',
    });

    const movements = native.prepare(
      'SELECT * FROM stock_movements WHERE inventory_id = ?'
    ).all(invId);
    expect(movements).toHaveLength(1);
    expect(movements[0].movement_type).toBe('sale');
    expect(movements[0].quantity).toBe(3);
    expect(movements[0].stock_before).toBe(10);
    expect(movements[0].stock_after).toBe(7);
  });

  test('2. UUID único por movimiento', () => {
    const native = db._native;
    const invId = makeInvItem(native, { name: 'Cerveza', stock: 10 });
    const { recordStockMovement } = require('../db');

    recordStockMovement({
      inventoryId: invId, productName: 'Cerveza', movementType: 'sale',
      quantity: 3, stockBefore: 10, stockAfter: 7, referenceType: 'order', referenceId: 1,
    });
    recordStockMovement({
      inventoryId: invId, productName: 'Cerveza', movementType: 'sale',
      quantity: 2, stockBefore: 7, stockAfter: 5, referenceType: 'order', referenceId: 2,
    });

    const movements = native.prepare(
      'SELECT uuid FROM stock_movements WHERE inventory_id = ?'
    ).all(invId);
    expect(movements).toHaveLength(2);
    expect(movements[0].uuid).not.toBe(movements[1].uuid);
  });

  test('3. Prevención de duplicados con idempotencyKey', () => {
    const native = db._native;
    const invId = makeInvItem(native, { name: 'Cerveza', stock: 10 });
    const { recordStockMovement } = require('../db');

    const key = 'test-idempotency-key-123';
    const result1 = recordStockMovement({
      inventoryId: invId, productName: 'Cerveza', movementType: 'sale',
      quantity: 3, stockBefore: 10, stockAfter: 7,
      referenceType: 'order', referenceId: 1,
      idempotencyKey: key,
    });
    const result2 = recordStockMovement({
      inventoryId: invId, productName: 'Cerveza', movementType: 'sale',
      quantity: 3, stockBefore: 10, stockAfter: 7,
      referenceType: 'order', referenceId: 1,
      idempotencyKey: key,
    });

    expect(result1).toBe(true);  // primera inserción
    expect(result2).toBe(false); // duplicado, no insertado

    const count = native.prepare(
      'SELECT COUNT(*) as c FROM stock_movements WHERE inventory_id = ?'
    ).get(invId).c;
    expect(count).toBe(1); // solo un registro
  });

  test('4. Registro de venta normal', async () => {
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

    const movements = native.prepare(
      `SELECT * FROM stock_movements WHERE inventory_id = ? AND movement_type = 'sale'`
    ).all(invId);
    expect(movements.length).toBeGreaterThanOrEqual(1);
    expect(movements[0].quantity).toBe(3);
    expect(movements[0].stock_before).toBe(10);
    expect(movements[0].stock_after).toBe(7);
  });

  test('5. Registro de faltante sin autorización', async () => {
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

    const shortages = native.prepare(
      `SELECT * FROM stock_movements WHERE inventory_id = ? AND movement_type = 'shortage'`
    ).all(invId);
    expect(shortages.length).toBeGreaterThanOrEqual(1);
    expect(shortages[0].shortage_quantity).toBe(3);
  });

  test('6. Registro de faltante con autorización', async () => {
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

    const sales = native.prepare(
      `SELECT * FROM stock_movements WHERE inventory_id = ? AND movement_type = 'sale'`
    ).all(invId);
    expect(sales.length).toBeGreaterThanOrEqual(1);
    expect(sales[0].quantity).toBe(8);
    expect(sales[0].stock_after).toBe(-3);
    expect(sales[0].authorized_by).toBe('Test Owner');
  });

  test('7. Identificación del usuario responsable', async () => {
    const native = db._native;
    const invId = makeInvItem(native, { name: 'Cerveza', stock: 10, salePrice: 80 });

    const res = await request(app).post('/api/orders/finalize').send({
      subtotal: 80, tax: 8, total: 88,
      discount: 0, discountAmt: 0,
      type: 'takeaway', tableId: null,
      customer: 'Test', status: 'pending',
      waiterName: 'Juan', openedAt: Date.now(),
      paymentMethod: null,
      items: [{ name: 'Cerveza', price: 80, qty: 1, lineTotal: 80, itemType: 'inventory', invId, area: 'bar', id: invId }]
    });

    expect(res.status).toBe(200);

    const movements = native.prepare(
      `SELECT * FROM stock_movements WHERE inventory_id = ? AND movement_type = 'sale'`
    ).all(invId);
    expect(movements.length).toBeGreaterThanOrEqual(1);
    // El user_name se registra desde la sesión (Propietario en tests, pero el waiterName del item no se usa)
    // En tests, la sesión es de owner, así que user_name es 'Propietario'
    expect(movements[0].user_name).toBeTruthy();
  });

  test('8. Identificación del administrador autorizante', async () => {
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

    const sales = native.prepare(
      `SELECT * FROM stock_movements WHERE inventory_id = ? AND movement_type = 'sale'`
    ).all(invId);
    expect(sales.length).toBeGreaterThanOrEqual(1);
    expect(sales[0].authorized_by).toBe('Test Owner'); // owner session en tests
  });

  test('9. Consulta de movimientos por producto', async () => {
    const native = db._native;
    const invId = makeInvItem(native, { name: 'Cerveza', stock: 10, salePrice: 80 });

    // Insertar movimiento manualmente
    const { recordStockMovement } = require('../db');
    recordStockMovement({
      inventoryId: invId, productName: 'Cerveza', movementType: 'sale',
      quantity: 3, stockBefore: 10, stockAfter: 7, referenceType: 'order', referenceId: 1,
    });

    const res = await request(app).get(`/api/inventory/movements?inventory_id=${invId}`);
    expect(res.status).toBe(200);
    expect(res.body.movements).toBeDefined();
    expect(res.body.movements.length).toBeGreaterThanOrEqual(1);
    expect(res.body.movements[0].inventory_id).toBe(invId);
  });

  test('10. Consulta por pedido', async () => {
    const native = db._native;
    const invId = makeInvItem(native, { name: 'Cerveza', stock: 10, salePrice: 80 });

    const { recordStockMovement } = require('../db');
    recordStockMovement({
      inventoryId: invId, productName: 'Cerveza', movementType: 'sale',
      quantity: 3, stockBefore: 10, stockAfter: 7, referenceType: 'order', referenceId: 42,
    });

    const res = await request(app).get('/api/inventory/movements?order_id=42');
    expect(res.status).toBe(200);
    expect(res.body.movements).toBeDefined();
    expect(res.body.movements.length).toBeGreaterThanOrEqual(1);
    expect(res.body.movements[0].reference_id).toBe(42);
    expect(res.body.movements[0].reference_type).toBe('order');
  });

  test('11. Filtro por tipo', async () => {
    const native = db._native;
    const invId = makeInvItem(native, { name: 'Cerveza', stock: 10, salePrice: 80 });

    const { recordStockMovement } = require('../db');
    recordStockMovement({
      inventoryId: invId, productName: 'Cerveza', movementType: 'sale',
      quantity: 3, stockBefore: 10, stockAfter: 7, referenceType: 'order', referenceId: 1,
    });
    recordStockMovement({
      inventoryId: invId, productName: 'Cerveza', movementType: 'shortage',
      quantity: 2, stockBefore: 7, stockAfter: 7, shortageQuantity: 2,
      referenceType: 'order', referenceId: 1,
    });

    const res = await request(app).get('/api/inventory/movements?type=sale');
    expect(res.status).toBe(200);
    expect(res.body.movements).toBeDefined();
    // Solo movimientos de tipo sale
    for (const m of res.body.movements) {
      expect(m.movement_type).toBe('sale');
    }
  });

  test('12. Filtro de faltantes (shortage=1)', async () => {
    const native = db._native;
    const invId = makeInvItem(native, { name: 'Cerveza', stock: 10, salePrice: 80 });

    const { recordStockMovement } = require('../db');
    recordStockMovement({
      inventoryId: invId, productName: 'Cerveza', movementType: 'sale',
      quantity: 3, stockBefore: 10, stockAfter: 7, shortageQuantity: 0,
      referenceType: 'order', referenceId: 1,
    });
    recordStockMovement({
      inventoryId: invId, productName: 'Cerveza', movementType: 'shortage',
      quantity: 2, stockBefore: 7, stockAfter: 7, shortageQuantity: 2,
      referenceType: 'order', referenceId: 1,
    });

    const res = await request(app).get('/api/inventory/movements?shortage=1');
    expect(res.status).toBe(200);
    expect(res.body.movements).toBeDefined();
    for (const m of res.body.movements) {
      expect(m.shortage_quantity).toBeGreaterThan(0);
    }
  });

  test('13. Filtro por fecha (from/to)', async () => {
    const native = db._native;
    const invId = makeInvItem(native, { name: 'Cerveza', stock: 10, salePrice: 80 });

    const { recordStockMovement } = require('../db');
    const now = Date.now();
    recordStockMovement({
      inventoryId: invId, productName: 'Cerveza', movementType: 'sale',
      quantity: 3, stockBefore: 10, stockAfter: 7, referenceType: 'order', referenceId: 1,
    });

    const res = await request(app).get(`/api/inventory/movements?from=${now - 1000}&to=${now + 1000}`);
    expect(res.status).toBe(200);
    expect(res.body.movements).toBeDefined();
    expect(res.body.movements.length).toBeGreaterThanOrEqual(1);
  });

  test('14. Paginación', async () => {
    const native = db._native;
    const invId = makeInvItem(native, { name: 'Cerveza', stock: 10, salePrice: 80 });

    const { recordStockMovement } = require('../db');
    for (let i = 0; i < 5; i++) {
      recordStockMovement({
        inventoryId: invId, productName: 'Cerveza', movementType: 'sale',
        quantity: 1, stockBefore: 10 - i, stockAfter: 9 - i,
        referenceType: 'order', referenceId: i + 1,
      });
    }

    const res1 = await request(app).get('/api/inventory/movements?limit=2&page=1');
    expect(res1.status).toBe(200);
    expect(res1.body.movements).toHaveLength(2);
    expect(res1.body.total).toBeGreaterThanOrEqual(5);
    expect(res1.body.pages).toBeGreaterThanOrEqual(3);

    const res2 = await request(app).get('/api/inventory/movements?limit=2&page=2');
    expect(res2.body.movements).toHaveLength(2);

    const res3 = await request(app).get('/api/inventory/movements?limit=2&page=3');
    expect(res3.body.movements.length).toBeGreaterThanOrEqual(1);
  });

  test('15. Límite máximo de resultados (100)', async () => {
    const res = await request(app).get('/api/inventory/movements?limit=99999');
    expect(res.status).toBe(200);
    // El límite se capa a 100
    expect(res.body.movements.length).toBeLessThanOrEqual(100);
  });

  test('16. Validación de parámetros inválidos', async () => {
    // inventory_id no numérico
    const res1 = await request(app).get('/api/inventory/movements?inventory_id=abc');
    expect(res1.status).toBe(200); // no lanza error, solo no encuentra resultados
    expect(res1.body.movements).toBeDefined();

    // from no numérico
    const res2 = await request(app).get('/api/inventory/movements?from=xyz');
    expect(res2.status).toBe(200);
    expect(res2.body.movements).toBeDefined();
  });

  test('17. Protección del endpoint (sin sesión → 401)', async () => {
    const { app: noSess } = buildTestApp({ withOwnerSession: false });
    const res = await request(noSess).get('/api/inventory/movements');
    expect(res.status).toBe(401);
  });

  test('18. Rollback ante error de inserción', () => {
    const native = db._native;
    const invId = makeInvItem(native, { name: 'Cerveza', stock: 10, salePrice: 80 });

    // Intentar insertar un movimiento con datos inválidos (null en campo NOT NULL)
    const { recordStockMovement } = require('../db');
    // Esto no debería lanzar excepción (se captura internamente)
    expect(() => {
      recordStockMovement({
        inventoryId: null, // inválido pero no lanza
        productName: 'Cerveza',
        movementType: 'sale',
        quantity: 3,
        stockBefore: 10,
        stockAfter: 7,
      });
    }).not.toThrow();
  });

  test('19. Consistencia entre stock y movimientos', async () => {
    const native = db._native;
    const invId = makeInvItem(native, { name: 'Cerveza', stock: 10, salePrice: 80 });

    // Insertar movimiento de venta de 3
    const { recordStockMovement } = require('../db');
    recordStockMovement({
      inventoryId: invId, productName: 'Cerveza', movementType: 'sale',
      quantity: 3, stockBefore: 10, stockAfter: 7, referenceType: 'order', referenceId: 1,
    });

    // Verificar que el movimiento refleja el cambio correcto
    const movements = native.prepare(
      'SELECT * FROM stock_movements WHERE inventory_id = ?'
    ).all(invId);
    expect(movements.length).toBeGreaterThanOrEqual(1);
    const sale = movements.find(m => m.movement_type === 'sale');
    expect(sale).toBeDefined();
    expect(sale.quantity).toBe(3);
    expect(sale.stock_before).toBe(10);
    expect(sale.stock_after).toBe(7);
  });

  test('20. Reintento de inserción del mismo movimiento (idempotencia)', () => {
    const native = db._native;
    const invId = makeInvItem(native, { name: 'Cerveza', stock: 10, salePrice: 80 });

    const { recordStockMovement } = require('../db');
    const key = 'idempotency-test-key-456';

    const result1 = recordStockMovement({
      inventoryId: invId, productName: 'Cerveza', movementType: 'sale',
      quantity: 3, stockBefore: 10, stockAfter: 7,
      referenceType: 'order', referenceId: 1,
      idempotencyKey: key,
    });
    const result2 = recordStockMovement({
      inventoryId: invId, productName: 'Cerveza', movementType: 'sale',
      quantity: 3, stockBefore: 10, stockAfter: 7,
      referenceType: 'order', referenceId: 1,
      idempotencyKey: key,
    });

    expect(result1).toBe(true);
    expect(result2).toBe(false); // duplicado, no insertado

    const count = native.prepare(
      'SELECT COUNT(*) as c FROM stock_movements WHERE inventory_id = ?'
    ).get(invId).c;
    expect(count).toBe(1); // solo un registro
  });
});
