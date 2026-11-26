'use strict';

/**
 * tests/employees.test.js
 *
 * Cubre las rutas de /api/employees:
 *   - GET    /             — listado de empleados
 *   - POST   /save         — crear y editar empleado (requireOwner)
 *   - DELETE /delete/:id   — eliminar empleado (requireOwner)
 *   - Protección: staff (is_client=1) no puede gestionar empleados
 */

const request = require('supertest');
const bcrypt = require('bcrypt');
const { buildTestApp } = require('./helpers/testApp');

// ── Helpers ───────────────────────────────────────────────────
function makeEmployee(native, overrides = {}) {
  const r = native.prepare(
    `INSERT INTO employees (name, role, pin, phone, active) VALUES (?, ?, ?, ?, ?)`
  ).run(
    overrides.name   ?? 'Empleado Test',
    overrides.role   ?? 'waiter',
    overrides.pin    ?? '1234',
    overrides.phone  ?? '',
    overrides.active ?? 1
  );
  return r.lastInsertRowid;
}

// App con sesión de owner (puede gestionar empleados)
function ownerApp() {
  return buildTestApp({ withOwnerSession: true });
}

// App con sesión de staff (is_client=1 → no puede)
function staffApp() {
  const built = buildTestApp({ withOwnerSession: false });
  built.db._native.prepare(
    `INSERT INTO local_session (id, user_id, role, name, is_client) VALUES (1, ?, ?, ?, 1)`
  ).run('staff-1', 'owner', 'Mozo'); // role=owner pero is_client=1 → bloqueado
  return built;
}

// ═══════════════════════════════════════════════════════════════
//  GET /api/employees
// ═══════════════════════════════════════════════════════════════
describe('GET /api/employees', () => {

  test('sin empleados devuelve array vacío', async () => {
    const { app } = ownerApp();
    const res = await request(app).get('/api/employees');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  test('devuelve todos los empleados insertados', async () => {
    const { app, db } = ownerApp();
    makeEmployee(db._native, { name: 'Ana',    role: 'cashier' });
    makeEmployee(db._native, { name: 'Carlos', role: 'waiter'  });

    const res = await request(app).get('/api/employees');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const names = res.body.map(e => e.name);
    expect(names).toContain('Ana');
    expect(names).toContain('Carlos');
  });

  test('incluye empleados inactivos', async () => {
    const { app, db } = ownerApp();
    makeEmployee(db._native, { name: 'Activo',   active: 1 });
    makeEmployee(db._native, { name: 'Inactivo', active: 0 });

    const res = await request(app).get('/api/employees');
    expect(res.body).toHaveLength(2);
  });

  test('ruta accesible sin sesión (pública para la pantalla de login)', async () => {
    const { app } = buildTestApp({ withOwnerSession: false });
    const res = await request(app).get('/api/employees');
    expect(res.status).toBe(200); // requireOwner solo aplica en /save y /delete
  });

});

// ═══════════════════════════════════════════════════════════════
//  POST /api/employees/save — crear
// ═══════════════════════════════════════════════════════════════
describe('POST /api/employees/save — crear', () => {

  test('crea empleado correctamente', async () => {
    const { app, db } = ownerApp();

    const res = await request(app)
      .post('/api/employees/save')
      .send({ name: 'Luis', role: 'waiter', pin: '4321', phone: '555-1234' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const emp = db._native.prepare(`SELECT * FROM employees WHERE name = 'Luis'`).get();
    expect(emp).toBeDefined();
    expect(emp.role).toBe('waiter');
    expect(emp.pin).not.toBe('4321');
    expect(emp.pin).toMatch(/^\$2[aby]\$/);
    expect(bcrypt.compareSync('4321', emp.pin)).toBe(true);
    expect(emp.active).toBe(1);
  });

  test('sin nombre devuelve 400', async () => {
    const { app } = ownerApp();
    const res = await request(app)
      .post('/api/employees/save')
      .send({ role: 'waiter', pin: '1234' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('sin PIN devuelve 400', async () => {
    const { app } = ownerApp();
    const res = await request(app)
      .post('/api/employees/save')
      .send({ name: 'Test', role: 'waiter' });
    expect(res.status).toBe(400);
  });

  test('sin rol devuelve 400', async () => {
    const { app } = ownerApp();
    const res = await request(app)
      .post('/api/employees/save')
      .send({ name: 'Test', pin: '1234' });
    expect(res.status).toBe(400);
  });

  test('staff (is_client=1) no puede crear empleados — 403', async () => {
    const built = staffApp();
    const res = await request(built.app)
      .post('/api/employees/save')
      .send({ name: 'Intruso', role: 'waiter', pin: '0000' });
    expect(res.status).toBe(403);
  });

  test('sin sesión devuelve 401', async () => {
    const { app } = buildTestApp({ withOwnerSession: false });
    const res = await request(app)
      .post('/api/employees/save')
      .send({ name: 'Test', role: 'waiter', pin: '1234' });
    expect(res.status).toBe(401);
  });

  test('notifica employees:updated al crear', async () => {
    const { app, notifyChange } = ownerApp();
    await request(app)
      .post('/api/employees/save')
      .send({ name: 'Pepe', role: 'waiter', pin: '9999' });
    expect(notifyChange).toHaveBeenCalledWith('employees:updated');
  });

});

// ═══════════════════════════════════════════════════════════════
//  POST /api/employees/save — editar
// ═══════════════════════════════════════════════════════════════
describe('POST /api/employees/save — editar', () => {

  test('edita empleado existente por id', async () => {
    const { app, db } = ownerApp();
    const empId = makeEmployee(db._native, { name: 'Original', role: 'waiter', pin: '1111' });

    const res = await request(app)
      .post('/api/employees/save')
      .send({ id: empId, name: 'Modificado', role: 'cashier', pin: '2222', active: 1 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const emp = db._native.prepare('SELECT * FROM employees WHERE id = ?').get(empId);
    expect(emp.name).toBe('Modificado');
    expect(emp.role).toBe('cashier');
    expect(emp.pin).not.toBe('2222');
    expect(emp.pin).toMatch(/^\$2[aby]\$/);
    expect(bcrypt.compareSync('2222', emp.pin)).toBe(true);
  });

  test('puede desactivar un empleado (active=false)', async () => {
    const { app, db } = ownerApp();
    const empId = makeEmployee(db._native, { active: 1 });

    await request(app)
      .post('/api/employees/save')
      .send({ id: empId, name: 'Test', role: 'waiter', pin: '1234', active: false });

    const emp = db._native.prepare('SELECT active FROM employees WHERE id = ?').get(empId);
    expect(emp.active).toBe(0);
  });

  test('preserva hash bcrypt si se envía como PIN (toggle de estado)', async () => {
    const { app, db } = ownerApp();
    const bcrypt = require('bcrypt');
    const hash = bcrypt.hashSync('securepin', 10);
    const empId = makeEmployee(db._native, { pin: hash });

    await request(app)
      .post('/api/employees/save')
      .send({ id: empId, name: 'Test', role: 'waiter', pin: hash, active: 1 });

    const emp = db._native.prepare('SELECT pin FROM employees WHERE id = ?').get(empId);
    expect(emp.pin).toBe(hash); // no se re-hashea, se preserva
  });

});

// ═══════════════════════════════════════════════════════════════
//  DELETE /api/employees/delete/:id
// ═══════════════════════════════════════════════════════════════
describe('DELETE /api/employees/delete/:id', () => {

  test('elimina el empleado correctamente', async () => {
    const { app, db } = ownerApp();
    const empId = makeEmployee(db._native);

    const res = await request(app).delete(`/api/employees/delete/${empId}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const emp = db._native.prepare('SELECT * FROM employees WHERE id = ?').get(empId);
    expect(emp).toBeDefined();
    expect(emp.deleted).toBe(1);
  });

  test('eliminar id inexistente igual devuelve 200 (idempotente)', async () => {
    const { app } = ownerApp();
    const res = await request(app).delete('/api/employees/delete/99999');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('staff (is_client=1) no puede eliminar — 403', async () => {
    const { app, db } = staffApp();
    const empId = makeEmployee(db._native);
    const res = await request(app).delete(`/api/employees/delete/${empId}`);
    expect(res.status).toBe(403);
  });

  test('sin sesión devuelve 401', async () => {
    const { app } = buildTestApp({ withOwnerSession: false });
    const res = await request(app).delete('/api/employees/delete/1');
    expect(res.status).toBe(401);
  });

  test('notifica employees:updated al eliminar', async () => {
    const { app, db, notifyChange } = ownerApp();
    const empId = makeEmployee(db._native);
    await request(app).delete(`/api/employees/delete/${empId}`);
    expect(notifyChange).toHaveBeenCalledWith('employees:updated');
  });

});
