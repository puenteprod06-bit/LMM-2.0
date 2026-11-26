'use strict';

/**
 * tests/tables-save-auth.test.js
 *
 * Reproduce el error 403 al guardar mesas (POST /api/tables/save) y verifica
 * la autorización por rol sin confiar en localStorage ni en el cuerpo de la
 * solicitud. La fuente de verdad es la sesión en SQLite (local_session, id=1).
 *
 * Escenarios obligatorios:
 *  - Propietario autenticado → 200 (puede guardar mesas).
 *  - Empleado sin permiso     → 403.
 *  - Usuario sin sesión       → 401.
 *  - Cuerpo manipulado (role: owner) con sesión de empleado → 403 (sin elevación de privilegios).
 */

const request = require('supertest');
const { buildTestApp } = require('./helpers/testApp');

const mockFn = () => (..._args) => {};

function insertTable(native, overrides = {}) {
  return native.prepare(
    `INSERT INTO tables (id, numero, status, capacity, zona, waiterId, waiterName, guests)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    overrides.id ?? 10,
    overrides.numero ?? 10,
    overrides.status ?? 'free',
    overrides.capacity ?? 4,
    overrides.zona ?? 'Salón',
    overrides.waiterId ?? null,
    overrides.waiterName ?? null,
    overrides.guests ?? null
  );
}

describe('POST /api/tables/save — autorización por propietario', () => {
  // ── Sesión de propietario: puede guardar mesas ────────────────────
  test('propietario autenticado guarda mesa y devuelve 200', async () => {
    const { app, db } = buildTestApp();
    const res = await request(app)
      .post('/api/tables/save')
      .send({
        id: 10, numero: 10, status: 'free', capacity: 4,
        zona: 'Salón', waiterId: null, waiterName: null, guests: null
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verificar persistencia real en la base de datos
    const row = db._native.prepare('SELECT * FROM tables WHERE id = 10').get();
    expect(row).toBeDefined();
    expect(row.numero).toBe(10);
    expect(row.status).toBe('free');
    expect(row.zona).toBe('Salón');
  });

  test('propietario actualiza una mesa existente (UPSERT)', async () => {
    const { app, db } = buildTestApp();
    insertTable(db._native, { id: 11, numero: 11, status: 'free', zona: 'Salón' });

    const res = await request(app)
      .post('/api/tables/save')
      .send({ id: 11, numero: 11, status: 'occupied', zona: 'Terraza', guests: 2 });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const row = db._native.prepare('SELECT * FROM tables WHERE id = 11').get();
    expect(row.status).toBe('occupied');
    expect(row.zona).toBe('Terraza');
    expect(row.guests).toBe(2);
    // No se duplica la fila
    const count = db._native.prepare('SELECT COUNT(*) as n FROM tables WHERE id = 11').get();
    expect(count.n).toBe(1);
  });

  // ── Empleado sin permiso: 403 ─────────────────────────────────────
  test('empleado con sesión de staff (is_client = 1) recibe 403', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: false });
    // Insertar sesión de empleado (is_client = 1, role = waiter)
    db._native.prepare(
      `INSERT INTO local_session (id, email, role, name, restaurant, is_client)
       VALUES (1, 'empleado@test.com', 'waiter', 'Empleado', 'Restó', 1)`
    ).run();

    const res = await request(app)
      .post('/api/tables/save')
      .send({ id: 20, numero: 20, status: 'free' });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  test('empleado con rol distinto a owner (is_client = 0) recibe 403', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: false });
    db._native.prepare(
      `INSERT INTO local_session (id, email, role, name, restaurant, is_client)
       VALUES (1, 'admin@test.com', 'admin', 'Admin', 'Restó', 0)`
    ).run();

    const res = await request(app)
      .post('/api/tables/save')
      .send({ id: 21, numero: 21, status: 'free' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  // ── Sin sesión: 401 ───────────────────────────────────────────────
  test('sin sesión activa devuelve 401 (NO_SESSION)', async () => {
    const { app } = buildTestApp({ withOwnerSession: false });
    const res = await request(app)
      .post('/api/tables/save')
      .send({ id: 30, numero: 30, status: 'free' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('NO_SESSION');
  });

  // ── Solicitud manipulada: no puede elevar privilegios ─────────────
  test('cuerpo manipulado con role=owner no eleva privilegios de un empleado (403)', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: false });
    db._native.prepare(
      `INSERT INTO local_session (id, email, role, name, restaurant, is_client)
       VALUES (1, 'empleado@test.com', 'waiter', 'Empleado', 'Restó', 1)`
    ).run();

    const res = await request(app)
      .post('/api/tables/save')
      .send({
        id: 40, numero: 40, status: 'free',
        role: 'owner',      // intento de elevación desde el cuerpo — ignorado
        is_client: 0        // intento de elevación desde el cuerpo — ignorado
      });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });
});
