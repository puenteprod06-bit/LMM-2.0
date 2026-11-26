'use strict';

/**
 * tests/inspect-real-db.test.js
 *
 * Inspeccion de SOLO LECTURA de la base de datos real de Electron.
 * No modifica nada. Solo lee local_session para documentar el estado actual.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

describe('Inspeccion de DB real de Electron (solo lectura)', () => {
  test('ruta de base de datos y estado de sesion', () => {
    const appData = process.env.APPDATA || path.join(process.env.HOME, '.local', 'share');
    const dbPath = path.join(appData, 'la-mente-maestra', 'database.sqlite');

    console.log('\n============================================================');
    console.log('Ruta de base de datos activa (Electron):', dbPath);
    console.log('Existe:', fs.existsSync(dbPath));

    if (!fs.existsSync(dbPath)) {
      console.log('La DB de Electron no existe todavia.');
      return;
    }

    // Abrir en modo readonly para NO modificar nada
    const db = new Database(dbPath, { readonly: true });

    try {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='local_session'"
      ).all();

      if (tables.length === 0) {
        console.log('La tabla local_session NO existe.');
        return;
      }

      const row = db.prepare('SELECT * FROM local_session WHERE id = 1').get();

      if (!row) {
        console.log('No existe fila en local_session (id=1).');
        console.log('Estado: SIN SESION ACTIVA.');
        return;
      }

      const emailRaw = row.email || '';
      const anonId = emailRaw.length > 0
        ? emailRaw.substring(0, 2) + '*** (' + emailRaw.length + ' chars)'
        : '(vacio)';

      console.log('\n--- Estado de local_session (id=1) ---');
      console.log('Usuario anonimizado:', anonId);
      console.log('role:', row.role, '(typeof:', typeof row.role + ')');
      console.log('is_client:', row.is_client, '(typeof:', typeof row.is_client + ')');
      console.log('name presente:', !!row.name);
      console.log('restaurant presente:', !!row.restaurant);
      console.log('last_login:', row.last_login ? new Date(Number(row.last_login)).toISOString() : 'N/A');
      console.log('last_license:', row.last_license ? new Date(Number(row.last_license)).toISOString() : 'N/A');
      console.log('app_version:', row.app_version || 'N/A');
      console.log('device_id presente:', !!row.device_id);

      let loginTipo = 'desconocido';
      if (row.role === 'owner' && (row.is_client === 0 || row.is_client === '0')) {
        loginTipo = 'propietario (/api/login/owner)';
      } else if (row.is_client === 1 || row.is_client === '1') {
        loginTipo = 'empleado / staff (/api/login/staff)';
      } else if (row.role === 'owner') {
        loginTipo = 'propietario (is_client ambiguo)';
      }
      console.log('Tipo de login deducido:', loginTipo);

      const isOwner = (row.role === 'owner' && (row.is_client === 0 || row.is_client === '0'));
      console.log('\n--- Evaluacion de requireOwner ---');
      console.log('role === owner:', row.role === 'owner');
      console.log('is_client === 1:', row.is_client === 1 || row.is_client === '1');
      console.log('Resultado: ', isOwner ? 'PERMITIDO (owner)' : 'RECHAZADO (403 FORBIDDEN)');
      console.log('============================================================\n');

      expect(tables.length).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });
});
