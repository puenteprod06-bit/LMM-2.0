'use strict';

const logger = require('../logger');

// ============================================================
//  MIDDLEWARE DE MANEJO DE ERRORES GLOBAL
//  Registrar al final de todos los app.use() y rutas.
// ============================================================
function errorHandler(err, req, res, next) {
  logger.error(`[EXPRESS ERROR] ${req.method} ${req.url} - ${err.message}`);
  logger.error(`Stack Trace: ${err.stack}`);

  // No enviamos err.stack al cliente por seguridad
  res.status(500).json({
    success: false,
    error: 'Error interno del servidor',
    code:  'INTERNAL_SERVER_ERROR'
  });
}

module.exports = errorHandler;