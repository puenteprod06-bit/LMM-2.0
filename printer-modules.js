'use strict';

const { Router } = require('express');
const logger = require('../logger');
const {
  getPrinterConfig,
  getDefaultPrinterConfig,
  printTicket,
  _registerPrintJob,
  _isPrintJobDuplicate,
  EscposUSB: getEscposUSB
} = require('../services/printer');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ============================================================
//  RUTAS DE IMPRESORA  —  /api/printer/*  /api/printer-config  /print
// ============================================================
module.exports = function printerRoutes(db, { notifyChange, io }) {
  const router = Router();

  // GET /api/printer/config
  router.get('/config', asyncHandler(async (req, res) => {
    res.json({ success: true, config: getPrinterConfig() });
  }));

  // POST /api/printer/config — actualizar un área
  router.post('/config', asyncHandler(async (req, res) => {
    const PRINTER_CONFIG = getPrinterConfig();
    const { area, ...settings } = req.body;
    if (!area || !PRINTER_CONFIG[area]) {
      return res.status(400).json({ error: 'Área inválida. Usar: cocina | bar | caja' });
    }
    Object.assign(PRINTER_CONFIG[area], settings);
    try {
      db.prepare('UPDATE config SET printer_config = ? WHERE id = 1').run(JSON.stringify(PRINTER_CONFIG));
    } catch (dbErr) {
      logger.warn('🖨️  [Printer] No se pudo guardar en DB:', dbErr.message);
    }
    logger.info(`🖨️  [Printer] Config '${area}' actualizada:`, PRINTER_CONFIG[area]);
    res.json({ success: true, config: PRINTER_CONFIG[area] });
  }));

  // GET /api/printer-config  (alias panel de Ajustes)
  router.get('-config', asyncHandler(async (req, res) => {
    res.json({ success: true, config: getPrinterConfig() });
  }));

  // POST /api/printer-config  (guardar config completa desde panel)
  router.post('-config', asyncHandler(async (req, res) => {
    const { config } = req.body;
    if (!config || typeof config !== 'object') {
      return res.status(400).json({ error: 'Body debe incluir { config: { cocina, bar, caja } }' });
    }
    const PRINTER_CONFIG = getPrinterConfig();
    const DEFAULT        = getDefaultPrinterConfig();
    for (const area of ['cocina', 'bar', 'caja']) {
      if (config[area]) PRINTER_CONFIG[area] = Object.assign({}, DEFAULT[area], config[area]);
    }
    db.prepare('UPDATE config SET printer_config = ? WHERE id = 1').run(JSON.stringify(PRINTER_CONFIG));
    logger.info('🖨️  [Printer] Config completa guardada en DB');
    res.json({ success: true, config: PRINTER_CONFIG });
  }));

  // POST /api/printer/test — ticket de prueba
  router.post('/test', asyncHandler(async (req, res) => {
    const { area = 'cocina' } = req.body;
    const testOrder = {
      id: 'TEST', type: 'dine-in', tableId: 99, waiterName: 'Demo',
      items: [
        { name: 'Hamburguesa Clásica', qty: 2, price: 8.5,  lineTotal: 17, area: 'cocina' },
        { name: 'Coca Cola',           qty: 1, price: 3.0,  lineTotal: 3,  area: 'bar'    }
      ],
      subtotal: 20, tax: 0, total: 20, discountAmt: 0
    };
    try {
      const results = await printTicket(testOrder, area, { restaurant_name: 'La Mente Maestra' });
      res.json({ success: true, results });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }));

  // POST /api/printer/reprint — reimprimir pedido existente
  router.post('/reprint', asyncHandler(async (req, res) => {
    const { orderId, area = 'all' } = req.body;
    if (!orderId) return res.status(400).json({ error: 'orderId requerido' });

    db.get('SELECT * FROM orders WHERE id = ?', [orderId], async (oErr, order) => {
      if (oErr || !order) return res.status(404).json({ error: 'Pedido no encontrado' });

      db.all('SELECT * FROM order_items WHERE order_id = ?', [orderId], async (iErr, items) => {
        if (iErr) return res.status(500).json({ error: iErr.message });
        const fullOrder = { ...order, items: items || [] };
        db.get('SELECT * FROM config WHERE id = 1', [], async (_cErr, cfg) => {
          try {
            const results = await printTicket(fullOrder, area, cfg || {});
            res.json({ success: true, results });
          } catch (e) {
            res.status(500).json({ error: e.message });
          }
        });
      });
    });
  }));

  // GET /api/printer/usb-devices
  router.get('/usb-devices', asyncHandler(async (req, res) => {
    const EscposUSB = getEscposUSB();
    if (!EscposUSB) {
      return res.json({ success: false, devices: [], message: 'Driver escpos-usb no instalado' });
    }
    try {
      const devices = EscposUSB.findPrinter();
      res.json({
        success: true,
        count:   devices ? devices.length : 0,
        devices: devices ? devices.map((d, i) => ({
          index:     i,
          vendorId:  d.deviceDescriptor?.idVendor?.toString(16).toUpperCase(),
          productId: d.deviceDescriptor?.idProduct?.toString(16).toUpperCase()
        })) : []
      });
    } catch (e) {
      res.json({ success: false, devices: [], message: e.message });
    }
  }));

  // POST /print  — endpoint directo desde cliente LAN con anti-duplicado
  router.post('/direct-print', asyncHandler(async (req, res) => {
    const order = req.body;
    if (!order || !order.items || order.items.length === 0) {
      return res.status(400).json({ error: 'Pedido vacío o sin ítems' });
    }
    if (order.id && _isPrintJobDuplicate(order.id)) {
      logger.info(`🖨️  [/print] Pedido #${order.id} ya impreso vía splitAndPrint — ignorando duplicado`);
      return res.json({ success: true, results: [], note: 'already-printed-via-split' });
    }
    _registerPrintJob(order.id);
    db.get('SELECT * FROM config WHERE id = 1', [], async (_cErr, cfg) => {
      try {
        const results = await printTicket(order, 'all', cfg || {});
        logger.info(`🖨️  [/print] Pedido #${order.id || 'sin-id'} impreso directamente`);
        res.json({ success: true, results });
      } catch (e) {
        logger.error('🖨️  [/print] Error:', e.message);
        res.status(500).json({ error: e.message });
      }
    });
  }));

  // POST /api/printer/ticket — recibe HTML de ticket desde cualquier cliente
  // y lo emite por Socket.IO a TODOS los clientes conectados (incluida la PC).
  // Así el teléfono no imprime localmente sino que la PC recibe y hace print().
  router.post('/ticket', asyncHandler(async (req, res) => {
    const { html, orderId, label } = req.body;
    if (!html) return res.status(400).json({ error: 'html requerido' });

    logger.info(`🖨️  [/ticket] Emitiendo ticket #${orderId || '?'} a todos los clientes via socket`);

    // Intentar imprimir físicamente en el servidor si hay impresora de caja
    db.get('SELECT * FROM config WHERE id = 1', [], async (_err, cfg) => {
      try {
        const { buildTicketHTML, printTicket } = require('../services/printer');
        // Solo intentar USB/red si hay config de caja activa — si falla, seguir igual
        // (el fallback es el socket al cliente PC)
      } catch (_) {}
    });

    // Emitir a TODOS los clientes via socket — la PC lo recibe y lo imprime
    if (io) {
      io.emit('print:receipt', { html, orderId, label: label || `ticket-#${orderId}` });
      logger.info(`🖨️  [/ticket] Socket emit "print:receipt" → ${io.engine.clientsCount} cliente(s)`);
    }

    res.json({ success: true, emitted: io ? io.engine.clientsCount : 0 });
  }));

  logger.info('🖨️  [Printer] Rutas registradas: /print, /api/printer/*');
  return router;
};