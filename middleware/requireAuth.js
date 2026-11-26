'use strict';

const logger = require('../logger');

// ============================================================
//  MIDDLEWARES DE AUTENTICACIÓN
// ============================================================

// requireSession — cualquier usuario con sesión activa (owner o staff).
// Usar en rutas operativas: órdenes, mesas, clientes, cocina.
function requireSession(db) {
  return function (req, res, next) {
    try {
      const session = db._native.prepare('SELECT * FROM local_session WHERE id = 1').get();
      if (!session) {
        return res.status(401).json({ success: false, error: 'Sesión requerida', code: 'NO_SESSION' });
      }
      req.session = session;
      next();
    } catch (err) {
      logger.error('[Auth Middleware] Error leyendo sesión:', err.message);
      res.status(500).json({ success: false, error: 'Error interno de autenticación' });
    }
  };
}

// requireOwner — solo el propietario (role = 'owner', is_client = 0).
// Usar en rutas de configuración, empleados, menú, inventario, sistema.
function requireOwner(db) {
  return function (req, res, next) {
    try {
      const session = db._native.prepare('SELECT * FROM local_session WHERE id = 1').get();
      if (!session) {
        return res.status(401).json({ success: false, error: 'Sesión requerida', code: 'NO_SESSION' });
      }
      if (session.role !== 'owner' || session.is_client === 1) {
        return res.status(403).json({ success: false, error: 'Se requieren permisos de propietario', code: 'FORBIDDEN' });
      }
      req.session = session;
      next();
    } catch (err) {
      logger.error('[Auth Middleware] Error verificando propietario:', err.message);
      res.status(500).json({ success: false, error: 'Error interno de autenticación' });
    }
  };
}

module.exports = { requireSession, requireOwner };