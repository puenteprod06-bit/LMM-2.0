'use strict';

// ============================================================
//  server.js — Setup + registro de rutas + startServer()
// ============================================================

const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const path       = require('path');
const http       = require('http');
const { Server } = require('socket.io');

const appRoot = __dirname;

const logger                 = require(path.join(appRoot, 'logger.js'));
const { db }                 = require(path.join(appRoot, 'db.js'));
const { registerAuthRoutes } = require(path.join(appRoot, 'auth.js'));
const Validator              = require(path.join(appRoot, 'validator.js'));

const { startAutoBackup }                        = require('./services/backup');
const { loadPrinterConfigFromDB, splitAndPrint } = require('./services/printer');
const { requireSession, requireOwner }           = require('./middleware/requireAuth');
const errorHandler                               = require('./middleware/errorHandler');

// ── Rutas por dominio ─────────────────────────────────────────
const configRoutes                                  = require('./routes/config');
const { menuRouter, categoriesRouter, subcategoriesRouter } = require('./routes/menu');
const inventoryRoutes                               = require('./routes/inventory');
const employeesRoutes                               = require('./routes/employees');
const customersRoutes                               = require('./routes/customers');
const { tablesRouter, zonesRouter }                 = require('./routes/tables');
const ordersRoutes                                  = require('./routes/orders');
const printerRoutes                                 = require('./routes/printer');
const systemRoutes                                  = require('./routes/system');
const mercadopagoRoutes                             = require('./routes/mercadopago');

// ── CORS ──────────────────────────────────────────────────────
const allowedOriginRegex = /^(https?:\/\/(?:localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[0-1])\.\d+\.\d+)(?::\d+)?)$/;

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOriginRegex.test(origin)) return callback(null, true);
    logger.warn(`[CORS] Bloqueado: ${origin}`);
    callback(new Error('No permitido por CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
};

// ── App + HTTP + Socket.IO ────────────────────────────────────
const app        = express();
app.set('trust proxy', 1);
const httpServer = http.createServer(app);
const io         = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || allowedOriginRegex.test(origin)) return callback(null, true);
      callback(new Error('Origen WebSocket no permitido'));
    },
    methods: ['GET', 'POST']
  },
  transports:   ['websocket', 'polling'],
  pingTimeout:  60000,
  pingInterval: 25000
});

// ── Middleware global ─────────────────────────────────────────
app.use(cors(corsOptions));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(appRoot, 'public')));

// ── notifyChange + sync-check ─────────────────────────────────
let lastDatabaseChange = Date.now();

// Mapeo de alias: la vista KDS/cocina escucha variantes con guión bajo
// (data_updated, new_order) mientras que el resto de la app usa guiones
// (data:updated, order:new). Notificamos ambas variantes para no romper
// ningún cliente y unificar el protocolo en una sola fuente.
const SOCKET_EVENT_ALIASES = {
  'data:updated': 'data_updated',
  'data_updated': 'data:updated',
  'order:new':    'new_order',
  'new_order':    'order:new'
};

function notifyChange(event = 'data:updated', payload = {}) {
  lastDatabaseChange = Date.now();
  if (io) {
    const body = { ...payload, timestamp: lastDatabaseChange };
    io.emit(event, body);
    // Siempre avisar "hay datos nuevos" en ambas variantes (algunos clientes solo
    // escuchan data_updated para refrescarse).
    if (event === 'data:updated' || event === 'data_updated') {
      io.emit('data:updated', body);
      io.emit('data_updated', body);
    } else {
      io.emit('data:updated', { source: event, timestamp: lastDatabaseChange });
      io.emit('data_updated', { source: event, timestamp: lastDatabaseChange });
      // Propagar también el alias del evento (order:new ⇄ new_order)
      const alias = SOCKET_EVENT_ALIASES[event];
      if (alias) io.emit(alias, body);
    }
    logger.info(`[Socket.IO] emit:"${event}" → ${io.engine.clientsCount} cliente(s)`);
  }
}

app.get('/api/sync-check', requireSession(db), (req, res) => res.json({ lastChange: lastDatabaseChange }));

// ── Emergencia — broadcast a todos los clientes ───────────────
app.post('/api/emergency', requireSession(db), (req, res) => {
  const { tipo, tableId, mesa, label, icon, timestamp } = req.body || {};
  if (!tipo || !label) return res.status(400).json({ ok: false, error: 'Faltan datos' });
  notifyChange('emergency:alert', { tipo, tableId, mesa, label, icon, timestamp: timestamp || Date.now() });
  res.json({ ok: true });
});
// Mantener compatibilidad con el fetch viejo (sin broadcast)
app.post('/api/emergency-log', requireSession(db), (req, res) => res.json({ ok: true }));

// ── Socket.IO ─────────────────────────────────────────────────
io.on('connection', (socket) => {
  const ip = socket.handshake.address;
  logger.info(`[Socket.IO] conexión: ${socket.id} (${ip}) — Total: ${io.engine.clientsCount}`);
  socket.emit('sync:welcome', { lastChange: lastDatabaseChange });

  socket.on('client:request-sync', () =>
    socket.emit('data:updated', { timestamp: lastDatabaseChange })
  );
  socket.on('client:register-role', ({ role } = {}) => {
    ['waiter', 'kitchen', 'admin', 'cashier', 'owner'].forEach(r => socket.leave(`role:${r}`));
    if (role) socket.join(`role:${role}`);
  });
  socket.on('disconnect', (reason) =>
    logger.info(`[Socket.IO] desconexión: ${socket.id} — ${reason}`)
  );
  socket.on('error', (err) =>
    logger.error(`[Socket.IO] error en socket: ${err.message}`)
  );
});

// ── Contexto inyectado en rutas ───────────────────────────────
const ctx = {
  requireSession: requireSession(db),
  requireOwner:   requireOwner(db),
  notifyChange,
  Validator,
  io,
  splitAndPrint
};

// ── Registro de rutas ─────────────────────────────────────────
// Cada router se monta en su prefijo exacto — sin duplicar paths.
registerAuthRoutes(app, notifyChange);

app.use('/api/config',        configRoutes(db, ctx));
app.use('/api/menu',          menuRouter(db, ctx));
app.use('/api/categories',    categoriesRouter(db, ctx));
app.use('/api/subcategories', subcategoriesRouter(db, ctx));
app.use('/api/inventory',     inventoryRoutes(db, ctx));
app.use('/api/employees',     employeesRoutes(db, ctx));
app.use('/api/customers',     customersRoutes(db, ctx));
app.use('/api/tables',        tablesRouter(db, ctx));
app.use('/api/zones',         zonesRouter(db, ctx));
app.use('/api/orders',        ordersRoutes(db, ctx));
app.use('/api/printer',       printerRoutes(db, ctx));
app.use('/api/system',        systemRoutes(db, ctx));
app.use('/api/mp',            mercadopagoRoutes(db, ctx));

// /api/printer-config — alias explicito para el panel de configuracion
// Express Router no acepta paths que empiezan con '-', asi que lo manejamos aqui
app.get('/api/ping', requireSession(db), (req, res) => {
  res.json({
    app: 'LMMAPP',
    name: 'LMMAPP Server',
    version: '1.0.0',
    uptime: Math.floor(process.uptime()),
  })
})

app.get('/api/printer-config', requireSession(db), (req, res) => {
  const { getPrinterConfig } = require('./services/printer');
  res.json({ success: true, config: getPrinterConfig() });
});
app.post('/api/printer-config', requireOwner(db), (req, res) => {
  const { getPrinterConfig, getDefaultPrinterConfig } = require('./services/printer');
  const log = require('./logger');
  const { config } = req.body || {};
  if (!config || typeof config !== 'object') {
    return res.status(400).json({ success: false, error: 'Body debe incluir { config: { cocina, bar, caja } }' });
  }
  const PRINTER_CONFIG = getPrinterConfig();
  const DEFAULT        = getDefaultPrinterConfig();
  for (const area of ['cocina', 'bar', 'caja']) {
    if (config[area]) PRINTER_CONFIG[area] = Object.assign({}, DEFAULT[area], config[area]);
  }
  try {
    db._native.prepare('UPDATE config SET printer_config = ? WHERE id = 1').run(JSON.stringify(PRINTER_CONFIG));
    log.info('[Printer] Config completa guardada desde /api/printer-config');
  } catch (dbErr) {
    log.warn('[Printer] No se pudo persistir en DB:', dbErr.message);
  }
  return res.json({ success: true, config: PRINTER_CONFIG });
});

// /print — endpoint directo LAN (sin prefijo /api)
app.post('/print', requireSession(db), (req, res, next) => {
  req.url = '/direct-print';
  printerRoutes(db, ctx)(req, res, next);
});

// ── Servicios background ──────────────────────────────────────
loadPrinterConfigFromDB(db._native);
startAutoBackup();

// ── Reanudar sincronización con la nube si ya estaba vinculada ──
// (initSync antes solo se llamaba desde el botón "Vincular con la
// nube"; si la app se reiniciaba, se perdía la sincronización hasta
// volver a tocar ese botón a mano)
try {
  const cloudCfg = db._native.prepare(
    `SELECT cloud_restaurant_id, supabase_url, supabase_anon_key FROM config WHERE id = 1`
  ).get();
  if (cloudCfg && cloudCfg.cloud_restaurant_id && cloudCfg.supabase_url && cloudCfg.supabase_anon_key) {
    const { initSync } = require('./sync-engine');
    initSync({
      supabaseUrl: cloudCfg.supabase_url,
      supabaseAnonKey: cloudCfg.supabase_anon_key,
      restaurantId: cloudCfg.cloud_restaurant_id,
      notifyChange,
    });
    const { startV8Engine } = require('./sync-engine');
    startV8Engine({
      supabaseUrl: cloudCfg.supabase_url,
      supabaseAnonKey: cloudCfg.supabase_anon_key,
      restaurantId: cloudCfg.cloud_restaurant_id,
      notifyChange,
    });
    logger.info('🔄 [SYNC] Reanudando sincronización con la nube (ya estaba vinculada)');
  }
} catch (err) {
  logger.warn('⚠️ [SYNC] No se pudo reanudar la sincronización automáticamente:', err.message);
}

// ── Error handler global ──────────────────────────────────────
app.use(errorHandler);

// ── startServer ───────────────────────────────────────────────
const startServer = () => new Promise((resolve, reject) => {
  try {
    const PORT = process.env.PORT || 3000;
    httpServer.listen(PORT, '0.0.0.0', () => {
      logger.info(`Servidor activo en puerto ${PORT}`);
      resolve(PORT);
    });
  } catch (err) {
    reject(err);
  }
});

module.exports = startServer;