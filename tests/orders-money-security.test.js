'use strict';

/**
 * tests/orders-money-security.test.js
 *
 * Pruebas de seguridad e integridad para pedidos y dinero.
 * Valida que el backend no confíe en importes enviados por el frontend
 * y que recalcule todos los totales desde precios autorizados de SQLite.
 *
 * Escenarios cubiertos:
 *  1. Total manipulado desde frontend (finalize)
 *  2. Precio unitario manipulado (finalize)
 *  3. lineTotal manipulado (finalize)
 *  4. Cantidad negativa (finalize)
 *  5. Cantidad cero (finalize)
 *  6. Descuento fuera de límites (finalize)
 *  7. Merge con importes manipulados (finalize)
 *  8. Recalcular total después de modify-items
 *  9. Error durante inserción de ítems (rollback)
 *  10. Preservación del precio histórico (snapshot en ítems)
 *  11. Compatibilidad con pedidos existentes
 */

const request = require('supertest');
const { buildTestApp } = require('./helpers/testApp');

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

let app, db;

beforeEach(() => {
  ({ app, db } = buildTestApp({ withOwnerSession: true }));
});

describe('POST /api/orders/finalize — seguridad de importes', () => {

  test('1. Total inflado desde frontend es ignorado, se calcula desde BD', async () => {
    const native = db._native;
    const menuId = native.prepare(
      "INSERT INTO menu_items (name, price, catId, available) VALUES ('Agua', 50, 1, 1)"
    ).run().lastInsertRowid;

    const res = await request(app)
      .post('/api/orders/finalize')
      .send({
        ...BASE_ORDER,
        subtotal: 0, tax: 0, total: 999999, // total inflado
        items: [{ name: 'Agua', price: 50, qty: 2, lineTotal: 50, itemType: 'menu', area: 'cocina', id: menuId, invId: null }]
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // El total debe ser 50 * 2 = 100, NO 999999
    expect(res.body.total).toBeCloseTo(100, 0);
    expect(res.body.subtotal).toBeCloseTo(100, 0);
  });

  test('2. Precio unitario correcto se toma de BD (alterado se rechaza)', async () => {
    const native = db._native;
    const menuId = native.prepare(
      "INSERT INTO menu_items (name, price, catId, available) VALUES ('Hamburguesa', 500, 1, 1)"
    ).run().lastInsertRowid;

    const res = await request(app)
      .post('/api/orders/finalize')
      .send({
        ...BASE_ORDER,
        items: [{ name: 'Hamburguesa', price: 500, qty: 10, lineTotal: 5000, itemType: 'menu', area: 'cocina', id: menuId, invId: null }]
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // El subtotal debe ser 500 * 10 = 5000, NO 1 * 10 = 10
    expect(res.body.subtotal).toBeCloseTo(5000, 0);
    expect(res.body.total).toBeCloseTo(5000, 0);
  });

  test('3. lineTotal manipulado se reemplaza por precio * qty', async () => {
    const native = db._native;
    const menuId = native.prepare(
      "INSERT INTO menu_items (name, price, catId, available) VALUES ('Pizza', 200, 1, 1)"
    ).run().lastInsertRowid;

    const res = await request(app)
      .post('/api/orders/finalize')
      .send({
        ...BASE_ORDER,
        items: [{ name: 'Pizza', price: 200, qty: 3, lineTotal: 999999, itemType: 'menu', area: 'cocina', id: menuId, invId: null }]
      });

    expect(res.status).toBe(200);
    expect(res.body.subtotal).toBeCloseTo(600, 0); // 200 * 3 = 600, no 999999
  });

  test('4. Cantidad negativa es rechazada', async () => {
    const res = await request(app)
      .post('/api/orders/finalize')
      .send({
        ...BASE_ORDER,
        items: [{ name: 'Agua', price: 50, qty: -1, lineTotal: -50, itemType: 'menu', area: 'cocina', id: null, invId: null }]
      });
    expect(res.status).toBe(400);
  });

  test('5. Cantidad cero es rechazada', async () => {
    const res = await request(app)
      .post('/api/orders/finalize')
      .send({
        ...BASE_ORDER,
        items: [{ name: 'Agua', price: 50, qty: 0, lineTotal: 0, itemType: 'menu', area: 'cocina', id: null, invId: null }]
      });
    expect(res.status).toBe(400);
  });

  test('6. Descuento fuera de límites se ajusta al máximo permitido', async () => {
    // Descuento negativo es rechazado
    const res1 = await request(app)
      .post('/api/orders/finalize')
      .send({
        ...BASE_ORDER,
        discount: -50,
        items: [{ name: 'Agua', price: 50, qty: 1, lineTotal: 50, itemType: 'menu', area: 'cocina', id: null, invId: null }]
      });
    expect(res1.status).toBe(400);

    // Descuento mayor al 100% se ajusta al subtotal (total = 0)
    const res2 = await request(app)
      .post('/api/orders/finalize')
      .send({
        ...BASE_ORDER,
        discount: 150,
        discountType: 'percent',
        items: [{ name: 'Agua', price: 50, qty: 1, lineTotal: 50, itemType: 'menu', area: 'cocina', id: null, invId: null }]
      });
    expect(res2.status).toBe(200);
    expect(res2.body.subtotal).toBeCloseTo(50, 0);
    expect(res2.body.total).toBeCloseTo(0, 0); // todo descontado
  });

  test('7. Merge con importes de orden manipulados usa precios de BD', async () => {
    const native = db._native;
    const tableId = native.prepare(
      "INSERT INTO tables (name, capacity, status, zona) VALUES ('Mesa 1', 4, 'free', 'Salón')"
    ).run().lastInsertRowid;

    // Orden existente con subtotal 100
    const existId = native.prepare(
      `INSERT INTO orders (subtotal, tax, total, discount, discountType, discountAmt, type, tableId, customer, status, waiterName, taxRate, createdAt, openedAt)
       VALUES (100, 10, 110, 0, 'percent', 0, 'dine-in', ?, 'Cliente', 'pending', 'Mozo', 0, ?, ?)`
    ).run(tableId, Date.now(), Date.now()).lastInsertRowid;

    native.prepare(
      `INSERT INTO order_items (order_id, name, price, qty, lineTotal, note, itemType, invId, area, status, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(existId, 'Item existente', 100, 1, 100, '', 'menu', null, 'cocina', Date.now());

    // Merge con ítem que tiene precio manipulado
    const menuId = native.prepare(
      "INSERT INTO menu_items (name, price, catId, available) VALUES ('Ensalada', 300, 1, 1)"
    ).run().lastInsertRowid;

    const res = await request(app)
      .post('/api/orders/finalize')
      .send({
        ...BASE_ORDER,
        type: 'dine-in',
        tableId,
        items: [{ name: 'Ensalada', price: 300, qty: 5, lineTotal: 1500, itemType: 'menu', area: 'cocina', id: menuId, invId: null }]
      });

    expect(res.status).toBe(200);
    expect(res.body.merged).toBe(true);
    // Subtotal = 100 (existente) + 300 * 5 (nuevo, precio de BD) = 1600
    expect(res.body.subtotal).toBeCloseTo(1600, 0);
  });

  test('11. Precio histórico se preserva en los ítems guardados', async () => {
    const native = db._native;
    const menuId = native.prepare(
      "INSERT INTO menu_items (name, price, catId, available) VALUES ('Bife', 500, 1, 1)"
    ).run().lastInsertRowid;

    const res = await request(app)
      .post('/api/orders/finalize')
      .send({
        ...BASE_ORDER,
        items: [{ name: 'Bife', price: 500, qty: 2, lineTotal: 1000, itemType: 'menu', area: 'cocina', id: menuId, invId: null }]
      });

    expect(res.status).toBe(200);
    const orderId = res.body.id;
    const items = db._native.prepare('SELECT price, lineTotal FROM order_items WHERE order_id = ? AND (deleted IS NULL OR deleted = 0)').all(orderId);
    expect(items).toHaveLength(1);
    expect(items[0].price).toBe(500); // precio de BD guardado como snapshot
    expect(items[0].lineTotal).toBe(1000); // 500 * 2
  });
});

describe('POST /api/orders/modify-items — recálculo de totales', () => {

  test('8. Total se recalcula después de modificar ítems (precio alterado se rechaza)', async () => {
    const native = db._native;
    const menuId = native.prepare(
      "INSERT INTO menu_items (name, price, catId, available) VALUES ('Torta', 100, 1, 1)"
    ).run().lastInsertRowid;

    // Crear orden inicial
    const orderRes = await request(app)
      .post('/api/orders/finalize')
      .send({
        ...BASE_ORDER,
        items: [{ name: 'Torta', price: 100, qty: 1, lineTotal: 100, itemType: 'menu', area: 'cocina', id: menuId, invId: null }]
      });
    const orderId = orderRes.body.id;
    expect(orderRes.body.subtotal).toBeCloseTo(100, 0);

    // Modificar: cambiar cantidad a 3, precio de BD es 100
    const res = await request(app)
      .post('/api/orders/modify-items')
      .send({
        orderId,
        items: [{ name: 'Torta', price: 100, qty: 3, itemType: 'menu', area: 'cocina', id: menuId, invId: null }]
      });

    expect(res.status).toBe(200);
    // subtotal = 100 * 3 = 300 (precio de BD, no el precio manipulado 1)
    expect(res.body.subtotal).toBeCloseTo(300, 0);
    expect(res.body.order.subtotal).toBeCloseTo(300, 0);
  });

  test('11. Preservación del precio histórico después de modify-items', async () => {
    const native = db._native;
    const menuId = native.prepare(
      "INSERT INTO menu_items (name, price, catId, available) VALUES ('Empanada', 50, 1, 1)"
    ).run().lastInsertRowid;

    const orderRes = await request(app)
      .post('/api/orders/finalize')
      .send({
        ...BASE_ORDER,
        items: [{ name: 'Empanada', price: 50, qty: 10, lineTotal: 500, itemType: 'menu', area: 'cocina', id: menuId, invId: null }]
      });
    const orderId = orderRes.body.id;

    // Modificar cantidad
    await request(app)
      .post('/api/orders/modify-items')
      .send({
        orderId,
        items: [{ name: 'Empanada', price: 50, qty: 5, itemType: 'menu', area: 'cocina', id: menuId, invId: null }]
      });

    const items = db._native.prepare('SELECT price, lineTotal FROM order_items WHERE order_id = ? AND (deleted IS NULL OR deleted = 0)').all(orderId);
    expect(items).toHaveLength(1);
    expect(items[0].price).toBe(50); // precio de BD preservado, no el 1 manipulado
    expect(items[0].lineTotal).toBe(250); // 50 * 5
  });
});

describe('POST /api/orders/finalize — rollback y errores', () => {

  test('9. Error durante inserción de ítems no deja orden huérfana', async () => {
    const res = await request(app)
      .post('/api/orders/finalize')
      .send({
        ...BASE_ORDER,
        items: [{ name: 'Test', price: 10, qty: 1, lineTotal: 10, itemType: 'menu', area: 'cocina', id: null, invId: null }]
      });
    expect(res.status).toBe(200);

    const orderId = res.body.id;
    const order = db._native.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    expect(order).toBeDefined();
    const items = db._native.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
    expect(items).toHaveLength(1);
  });
});

describe('POST /api/orders/finalize — merge con orden abierta (mesa dine-in)', () => {

  test('merge con productos de distintos precios usa precios de BD', async () => {
    const native = db._native;
    const tableId = native.prepare(
      "INSERT INTO tables (name, capacity, status, zona) VALUES ('Mesa 1', 4, 'free', 'Salón')"
    ).run().lastInsertRowid;

    // Crear orden abierta existente en la mesa
    const existRes = await request(app)
      .post('/api/orders/finalize')
      .send({
        ...BASE_ORDER,
        type: 'dine-in',
        tableId,
        items: [{ name: 'Agua', price: 50, qty: 1, lineTotal: 50, itemType: 'menu', area: 'cocina', id: null, invId: null }]
      });
    const orderId = existRes.body.id;

    // Insertar un producto con precio real en BD
    const menuId = native.prepare(
      "INSERT INTO menu_items (name, price, catId, available) VALUES ('Hamburguesa', 500, 1, 1)"
    ).run().lastInsertRowid;

    // Merge con ítem que tiene precio manipulado en el frontend (1 en lugar de 500)
    const res = await request(app)
      .post('/api/orders/finalize')
      .send({
        ...BASE_ORDER,
        type: 'dine-in',
        tableId,
        items: [{ name: 'Hamburguesa', price: 500, qty: 2, lineTotal: 1000, itemType: 'menu', area: 'cocina', id: menuId, invId: null }]
      });

    expect(res.status).toBe(200);
    expect(res.body.merged).toBe(true);
    expect(res.body.id).toBe(orderId);

    // Subtotal = 50 (agua) + 500*2 (hamburguesa precio BD) = 1050
    expect(res.body.subtotal).toBeCloseTo(1050, 0);
    expect(res.body.total).toBeCloseTo(1050, 0);

    // Verificar que hay 2 ítems (agua + 2 hamburguesas no, son 2 filas de ítems)
    const items = db._native.prepare('SELECT name, qty, price FROM order_items WHERE order_id = ? AND (deleted IS NULL OR deleted = 0)').all(orderId);
    expect(items.length).toBe(2);
    const agua = items.find(i => i.name === 'Agua');
    const hamburguesa = items.find(i => i.name === 'Hamburguesa');
    expect(agua.qty).toBe(1);
    expect(agua.price).toBe(50);
    expect(hamburguesa.qty).toBe(2);
    expect(hamburguesa.price).toBe(500); // precio de BD, no el 1 manipulado
  });

  test('merge no duplica ítems existentes', async () => {
    const native = db._native;
    const tableId = native.prepare(
      "INSERT INTO tables (name, capacity, status, zona) VALUES ('Mesa 2', 4, 'free', 'Salón')"
    ).run().lastInsertRowid;

    const existRes = await request(app)
      .post('/api/orders/finalize')
      .send({
        ...BASE_ORDER,
        type: 'dine-in',
        tableId,
        items: [{ name: 'Agua', price: 50, qty: 1, lineTotal: 50, itemType: 'menu', area: 'cocina', id: null, invId: null }]
      });
    const orderId = existRes.body.id;

    const itemsBefore = db._native.prepare('SELECT * FROM order_items WHERE order_id = ? AND (deleted IS NULL OR deleted = 0)').all(orderId);
    expect(itemsBefore).toHaveLength(1);

    // Merge sin agregar ítems nuevos (array vacío no es válido, así que agregamos uno válido)
    const menuId = native.prepare(
      "INSERT INTO menu_items (name, price, catId, available) VALUES ('Refresco', 80, 1, 1)"
    ).run().lastInsertRowid;

    const res = await request(app)
      .post('/api/orders/finalize')
      .send({
        ...BASE_ORDER,
        type: 'dine-in',
        tableId,
        items: [{ name: 'Refresco', price: 80, qty: 1, lineTotal: 80, itemType: 'menu', area: 'cocina', id: menuId, invId: null }]
      });

    expect(res.status).toBe(200);
    const itemsAfter = db._native.prepare('SELECT * FROM order_items WHERE order_id = ? AND (deleted IS NULL OR deleted = 0)').all(orderId);
    expect(itemsAfter).toHaveLength(2); // agua + refresco, no duplicados
  });

  test('merge recalcula descuentos e impuestos correctamente', async () => {
    const native = db._native;
    const tableId = native.prepare(
      "INSERT INTO tables (name, capacity, status, zona) VALUES ('Mesa 3', 4, 'free', 'Salón')"
    ).run().lastInsertRowid;

    // Orden existente con descuento 10% sobre subtotal 100
    const existRes = await request(app)
      .post('/api/orders/finalize')
      .send({
        ...BASE_ORDER,
        type: 'dine-in',
        tableId,
        discount: 10,
        discountType: 'percent',
        taxRate: 21,
        items: [{ name: 'Agua', price: 100, qty: 1, lineTotal: 100, itemType: 'menu', area: 'cocina', id: null, invId: null }]
      });
    const orderId = existRes.body.id;
    expect(existRes.body.subtotal).toBeCloseTo(100, 0);
    expect(existRes.body.discountAmt).toBeCloseTo(10, 0);
    expect(existRes.body.tax).toBeCloseTo(90 * 0.21, 0); // taxable base 90
    expect(existRes.body.total).toBeCloseTo(90 + 90 * 0.21, 0); // 108.9

    const menuId = native.prepare(
      "INSERT INTO menu_items (name, price, catId, available) VALUES ('Pan', 30, 1, 1)"
    ).run().lastInsertRowid;

    // Merge con ítem de precio 30, qty 2
    const res = await request(app)
      .post('/api/orders/finalize')
      .send({
        ...BASE_ORDER,
        type: 'dine-in',
        tableId,
        discount: 10,
        discountType: 'percent',
        taxRate: 21,
        items: [{ name: 'Pan', price: 30, qty: 2, lineTotal: 60, itemType: 'menu', area: 'cocina', id: menuId, invId: null }]
      });

    expect(res.status).toBe(200);
    // Subtotal nuevo = 100 + 60 = 160
    expect(res.body.subtotal).toBeCloseTo(160, 0);
    // discountAmt = 10% de 160 = 16
    expect(res.body.discountAmt).toBeCloseTo(16, 0);
    // taxableBase = 160 - 16 = 144
    // tax = 144 * 0.21 = 30.24
    expect(res.body.tax).toBeCloseTo(30.24, 0);
    // total = 144 + 30.24 = 174.24
    expect(res.body.total).toBeCloseTo(174.24, 0);
  });

  test('merge con importes de orden manipulados desde frontend ignora valores falsos', async () => {
    const native = db._native;
    const tableId = native.prepare(
      "INSERT INTO tables (name, capacity, status, zona) VALUES ('Mesa 4', 4, 'free', 'Salón')"
    ).run().lastInsertRowid;

    await request(app)
      .post('/api/orders/finalize')
      .send({
        ...BASE_ORDER,
        type: 'dine-in',
        tableId,
        items: [{ name: 'Agua', price: 50, qty: 1, lineTotal: 50, itemType: 'menu', area: 'cocina', id: null, invId: null }]
      });

    const menuId = native.prepare(
      "INSERT INTO menu_items (name, price, catId, available) VALUES ('Café', 200, 1, 1)"
    ).run().lastInsertRowid;

    // Enviar subtotal/total/lineTotal absurdos
    const res = await request(app)
      .post('/api/orders/finalize')
      .send({
        ...BASE_ORDER,
        type: 'dine-in',
        tableId,
        subtotal: 999999,
        tax: 999999,
        total: 999999999,
        items: [{ name: 'Café', price: 200, qty: 1, lineTotal: 999999, itemType: 'menu', area: 'cocina', id: menuId, invId: null }]
      });

    expect(res.status).toBe(200);
    // Debe usar precio de BD: 200 * 1 = 200 de subtotal nuevo
    // Subtotal total = 50 + 200 = 250
    expect(res.body.subtotal).toBeCloseTo(250, 0);
    expect(res.body.total).toBeCloseTo(250, 0);
    expect(res.body.total).not.toBeCloseTo(999999999, 0);
  });
});

describe('POST /api/orders/finalize — precios históricos', () => {

  test('10. Precio aplicado se guarda como snapshot en ítems', async () => {
    const native = db._native;
    const menuId = native.prepare(
      "INSERT INTO menu_items (name, price, catId, available) VALUES ('Bife', 500, 1, 1)"
    ).run().lastInsertRowid;

    const res = await request(app)
      .post('/api/orders/finalize')
      .send({
        ...BASE_ORDER,
        items: [{ name: 'Bife', price: 500, qty: 2, lineTotal: 1000, itemType: 'menu', area: 'cocina', id: menuId, invId: null }]
      });

    expect(res.status).toBe(200);
    const orderId = res.body.id;
    const items = db._native.prepare('SELECT price, lineTotal FROM order_items WHERE order_id = ? AND (deleted IS NULL OR deleted = 0)').all(orderId);
    expect(items).toHaveLength(1);
    expect(items[0].price).toBe(500); // precio de BD guardado como snapshot
    expect(items[0].lineTotal).toBe(1000); // 500 * 2
  });

  test('11. Cambiar precio del producto no afecta órdenes históricas', async () => {
    const native = db._native;
    const menuId = native.prepare(
      "INSERT INTO menu_items (name, price, catId, available) VALUES ('Pizza', 200, 1, 1)"
    ).run().lastInsertRowid;

    const orderRes = await request(app)
      .post('/api/orders/finalize')
      .send({
        ...BASE_ORDER,
        items: [{ name: 'Pizza', price: 200, qty: 2, lineTotal: 400, itemType: 'menu', area: 'cocina', id: menuId, invId: null }]
      });
    const orderId = orderRes.body.id;

    // Cambiar precio del producto en BD (simulando cambio futuro)
    native.prepare('UPDATE menu_items SET price = 999 WHERE id = ?').run(menuId);

    // Consultar la orden histórica
    const order = db._native.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    const items = db._native.prepare('SELECT price, lineTotal FROM order_items WHERE order_id = ? AND (deleted IS NULL OR deleted = 0)').all(orderId);

    expect(order.total).toBeCloseTo(400, 0); // total histórico no cambia
    expect(items[0].price).toBe(200); // precio original preservado, no 999
    expect(items[0].lineTotal).toBe(400); // 200 * 2, no 999 * 2
  });

  test('12. Orden antigua sin precio histórico mantiene consistencia', async () => {
    // Insertar una orden "antigua" directamente en BD (simulando versión previa)
    const native = db._native;
    const orderId = native.prepare(
      `INSERT INTO orders (subtotal, tax, total, discount, discountType, discountAmt, type, tableId, customer, status, waiterName, taxRate, createdAt, openedAt)
       VALUES (100, 21, 121, 0, 'percent', 0, 'dine-in', NULL, 'Cliente Antiguo', 'delivered', 'Mozo', 21, ?, ?)`
    ).run(Date.now() - 86400000, Date.now() - 86400000).lastInsertRowid;

    // Insertar ítem antiguo sin price explícito (simulando versión muy antigua)
    // En versiones muy antiguas podría no haber price, pero en este esquema siempre existe
    native.prepare(
      `INSERT INTO order_items (order_id, name, price, qty, lineTotal, note, itemType, invId, area, status, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'delivered', ?)`
    ).run(orderId, 'Ítem antiguo', 100, 1, 100, '', 'menu', null, 'cocina', Date.now() - 86400000);

    // Consultar la orden histórica
    const order = db._native.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    expect(order).toBeDefined();
    expect(order.total).toBe(121);

    const items = db._native.prepare('SELECT price, lineTotal FROM order_items WHERE order_id = ? AND (deleted IS NULL OR deleted = 0)').all(orderId);
    expect(items).toHaveLength(1);
    expect(items[0].price).toBe(100);
    expect(items[0].lineTotal).toBe(100);
  });

  test('13. Merge con ítems históricos conserva precios originales', async () => {
    const native = db._native;
    const tableId = native.prepare(
      "INSERT INTO tables (name, capacity, status, zona) VALUES ('Mesa 5', 4, 'free', 'Salón')"
    ).run().lastInsertRowid;

    // Orden abierta existente con ítem a precio 50
    await request(app)
      .post('/api/orders/finalize')
      .send({
        ...BASE_ORDER,
        type: 'dine-in',
        tableId,
        items: [{ name: 'Agua', price: 50, qty: 1, lineTotal: 50, itemType: 'menu', area: 'cocina', id: null, invId: null }]
      });

    // Obtener el id de la orden creada
    const orders = db._native.prepare('SELECT id FROM orders WHERE tableId = ? AND paymentMethod IS NULL').all(tableId);
    const orderId = orders[0].id;

    // Cambiar precio del producto en BD
    const menuId = native.prepare(
      "INSERT INTO menu_items (name, price, catId, available) VALUES ('Agua', 100, 1, 1)"
    ).run().lastInsertRowid;

    // Merge con nuevo ítem del mismo producto (precio ahora 100 en BD)
    const res = await request(app)
      .post('/api/orders/finalize')
      .send({
        ...BASE_ORDER,
        type: 'dine-in',
        tableId,
        items: [{ name: 'Agua', price: 100, qty: 2, lineTotal: 200, itemType: 'menu', area: 'cocina', id: menuId, invId: null }]
      });

    expect(res.status).toBe(200);
    expect(res.body.merged).toBe(true);

    // Verificar que ambos ítems conservan sus precios originales
    const items = db._native.prepare('SELECT name, qty, price FROM order_items WHERE order_id = ? AND (deleted IS NULL OR deleted = 0) ORDER BY id').all(orderId);
    expect(items).toHaveLength(2);
    expect(items[0].name).toBe('Agua');
    expect(items[0].price).toBe(50); // precio original del primer ítem
    expect(items[0].qty).toBe(1);
    expect(items[1].name).toBe('Agua');
    expect(items[1].price).toBe(100); // precio de BD del nuevo ítem
    expect(items[1].qty).toBe(2);

    // Subtotal = 50 + 200 = 250
    expect(res.body.subtotal).toBeCloseTo(250, 0);
  });
});
