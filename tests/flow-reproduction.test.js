'use strict';

/**
 * tests/flow-reproduction.test.js
 *
 * Reproduce el flujo completo de sesiones para demostrar que el 403
 * se debe a que la sesion activa es de empleado, no de propietario.
 *
 * Secuencia:
 *  A. Cerrar sesion (limpiar local_session)
 *  B. Iniciar sesion como propietario  -> guardar mesa: 200
 *  C. Iniciar sesion como empleado     -> guardar mesa: 403
 *  D. Volver a iniciar como propietario -> guardar mesa: 200
 *
 * Usa buildTestApp (SQLite en memoria, no toca produccion).
 */

const request = require('supertest');
const { buildTestApp } = require('./helpers/testApp');

function saveSession(db, { role, isClient, email, name, restaurant }) {
  db._native.prepare(
    `INSERT OR REPLACE INTO local_session
      (id, email, role, name, restaurant, is_client, last_login)
     VALUES (1, ?, ?, ?, ?, ?, ?)`
  ).run(
    (email || '').toLowerCase().trim(),
    role || 'staff',
    name || '',
    restaurant || '',
    isClient ? 1 : 0,
    Date.now()
  );
}

function clearSession(db) {
  db._native.prepare('DELETE FROM local_session WHERE id = 1').run();
}

function postSaveTable(app) {
  return request(app)
    .post('/api/tables/save')
    .send({ id: 99, numero: 99, status: 'free', capacity: 4, zona: 'Salon' });
}

describe('Flujo de reproduccion del 403 en mesas', () => {
  test('secuencia completa: owner=200, empleado=403, owner=200', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: false });

    // A. Cerrar sesion (ya sin sesion por withOwnerSession=false)
    clearSession(db);
    let res = await postSaveTable(app);
    expect(res.status).toBe(401);
    console.log('\n[A] Sin sesion -> POST /api/tables/save:', res.status);

    // B. Iniciar sesion como propietario
    saveSession(db, { role: 'owner', isClient: false, email: 'dueno@test.com', name: 'Dueno', restaurant: 'Restó' });
    res = await postSaveTable(app);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    console.log('[B] Login propietario -> POST /api/tables/save:', res.status);

    // C. Iniciar sesion como empleado (SOBREESCRIBE la sesion del propietario)
    saveSession(db, { role: 'admin', isClient: true, email: 'empleado@test.com', name: 'Empleado', restaurant: 'Restó' });
    res = await postSaveTable(app);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    console.log('[C] Login empleado   -> POST /api/tables/save:', res.status, res.body.code);

    // D. Volver a iniciar como propietario (SOBREESCRIBE la sesion del empleado)
    saveSession(db, { role: 'owner', isClient: false, email: 'dueno@test.com', name: 'Dueno', restaurant: 'Restó' });
    res = await postSaveTable(app);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    console.log('[D] Login propietario -> POST /api/tables/save:', res.status, '(recuperado)');

    // Verificar persistencia real
    const row = db._native.prepare('SELECT * FROM tables WHERE id = 99').get();
    expect(row).toBeDefined();
    console.log('\nMesa 99 persistente en BD:', row ? 'SI (id=' + row.id + ', status=' + row.status + ')' : 'NO');
  });

  test('empleado con role=admin e is_client=1 recibe 403', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: false });
    saveSession(db, { role: 'admin', isClient: true });
    const res = await postSaveTable(app);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  test('empleado con role=owner pero is_client=1 recibe 403 (defensa en profundidad)', async () => {
    const { app, db } = buildTestApp({ withOwnerSession: false });
    saveSession(db, { role: 'owner', isClient: true });
    const res = await postSaveTable(app);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });
});
