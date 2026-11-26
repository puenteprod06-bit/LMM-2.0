'use strict';

// ============================================================
//  SERVICIO DE IMPRESIÓN — Motor ESC/POS + Fallback HTML
//  Soporta: USB (Epson TM-T20III), Red TCP/IP, Fallback web
//
//  CONFIGURACIÓN USB: Cambiar enabled:true en PRINTER_CONFIG
//  CONFIGURACIÓN RED: Cambiar type:'network' + IP + enabled:true
// ============================================================

// ── Carga opcional de drivers ESC/POS ────────────────────────
const logger = require('../logger');
let escpos, EscposUSB, EscposNetwork;
try {
  escpos    = require('escpos');
  EscposUSB = require('escpos-usb');
  escpos.USB = EscposUSB;
  logger.info('🖨️  [Printer] Driver USB cargado ✓');
} catch (_) {
  logger.warn('🖨️  [Printer] escpos-usb no instalado — USB desactivado (normal si no hay impresora)');
}
try {
  EscposNetwork = require('escpos-network');
  logger.info('🖨️  [Printer] Driver Network cargado ✓');
} catch (_) {
  logger.warn('🖨️  [Printer] escpos-network no instalado — Red desactivada');
}

// ── Configuración por defecto ─────────────────────────────────
// ⚙️  EDITAR AQUÍ para configurar tu hardware:
//   type: 'usb'     → Epson conectada por USB al servidor
//   type: 'network' → Epson con IP fija en la red local
//   enabled: true   → Activar impresión física
//   enabled: false  → Solo fallback HTML (imprime en el navegador)
const DEFAULT_PRINTER_CONFIG = {
  cocina: { type: 'usb', enabled: true, encoding: 'CP858' },
  bar:    { type: 'usb', enabled: true, encoding: 'CP858' },
  caja:   { type: 'usb', enabled: true, encoding: 'CP858' }
};

// PRINTER_CONFIG se inicializa con el default y se sobreescribe desde la DB al arrancar
let PRINTER_CONFIG = JSON.parse(JSON.stringify(DEFAULT_PRINTER_CONFIG));

function loadPrinterConfigFromDB(dbInstance) {
  try {
    const row = dbInstance.prepare('SELECT printer_config FROM config WHERE id = 1').get();
    if (row && row.printer_config) {
      const saved = JSON.parse(row.printer_config);
      for (const area of ['cocina', 'bar', 'caja']) {
        if (saved[area]) {
          PRINTER_CONFIG[area] = Object.assign({}, DEFAULT_PRINTER_CONFIG[area], saved[area]);
        }
      }
      logger.info('🖨️  [Printer] Config cargada desde DB ✓');
    } else {
      logger.info('🖨️  [Printer] Sin config en DB → usando defaults');
    }
  } catch (e) {
    logger.warn('🖨️  [Printer] Error cargando config desde DB:', e.message, '→ usando defaults');
  }
}

function getPrinterConfig() { return PRINTER_CONFIG; }
function getDefaultPrinterConfig() { return DEFAULT_PRINTER_CONFIG; }

// ── Helpers de formato ────────────────────────────────────────
function _padLine(left, right, width = 48) {
  const sp = width - left.length - right.length;
  return left + ' '.repeat(Math.max(1, sp)) + right;
}
function _center(text, width = 48) {
  const pad = Math.max(0, Math.floor((width - text.length) / 2));
  return ' '.repeat(pad) + text;
}
function _divider(c = '-', w = 48) { return c.repeat(w); }

// ── Texto plano ESC/POS para impresoras físicas ───────────────
function _buildEscposText(order, area, config = {}) {
  const W        = 48;
  const now      = new Date();
  const timeStr  = now.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  const dateStr  = now.toLocaleDateString('es-AR');
  const restaurant = config.restaurant_name || 'Restaurante';

  let headerLine;
  if (order.type === 'delivery') {
    headerLine = _center('*** DELIVERY ***', W);
  } else if (order.type === 'takeaway') {
    headerLine = _center('*** PARA LLEVAR ***', W);
  } else {
    const mesaVisual = order.tableNumber || order.tableId;
    headerLine = _center(`*** MESA ${mesaVisual} ***`, W);
  }

  const areaLabel = { cocina: '[ COCINA ]', bar: '[ BAR ]', caja: '[ CAJA ]' }[area] || `[ ${area.toUpperCase()} ]`;

  const items = (order.items || []).filter(i =>
    area === 'all' || area === 'caja' || (i.area || 'cocina').toLowerCase() === area.toLowerCase()
  );

  const itemLines = items.map(i => {
    const line = `  x${i.qty}  ${i.name.toUpperCase()}`;
    const note = i.note ? `      -> ${i.note}` : '';
    return note ? `${line}\n${note}` : line;
  }).join('\n');

  const customerLine = order.customer ? `Cliente: ${order.customer.toUpperCase()}\n` : '';

  return [
    _center(restaurant, W),
    _divider('-', W),
    _center(areaLabel, W),
    _divider('-', W),
    `Pedido #${order.id}`,
    headerLine,
    customerLine,
    `Fecha: ${dateStr}  Hora: ${timeStr}`,
    `Mozo: ${order.waiterName || 'Staff'}`,
    _divider('-', W),
    itemLines,
    _divider('=', W),
    ''
  ].join('\n');
}

// ── HTML para fallback web (impresión en navegador) ───────────
function buildTicketHTML(order, area, config = {}) {
  const now        = new Date();
  const timeStr    = now.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  const dateStr    = now.toLocaleDateString('es-AR');
  const currency   = config.currency || '$';
  const restaurant = config.restaurant_name || 'Restaurante';

  const areaColors = { cocina: '#e74c3c', bar: '#2980b9', caja: '#27ae60', all: '#2c3e50' };
  const areaColor  = areaColors[area] || '#333';
  const areaLabel  = { cocina: '🍳 COCINA', bar: '🍹 BAR', caja: '💰 CAJA', all: '📋 COMANDA' }[area] || area.toUpperCase();

  let encabezadoPrincipal = '';
  let colorFondoEtiqueta  = '#000';

  if (order.type === 'delivery') {
    encabezadoPrincipal = 'DELIVERY 🛵';
    colorFondoEtiqueta  = '#2b6cb0';
  } else if (order.type === 'takeaway') {
    encabezadoPrincipal = 'PARA LLEVAR 🥡';
    colorFondoEtiqueta  = '#c05621';
  } else {
    const mesaVisual = order.tableNumber || order.tableId;
    encabezadoPrincipal = `MESA ${mesaVisual}`;
    colorFondoEtiqueta  = '#000';
  }

  const items = (order.items || []).filter(item => {
    if (area === 'all' || area === 'caja') return true;
    return (item.area || 'cocina').toLowerCase() === area.toLowerCase();
  });

  if (items.length === 0 && area !== 'caja') return null;

  const itemsHTML = items.map(item => `
    <tr>
      <td colspan="2" style="padding:4px 0; font-size:15px; font-weight:700">
        ● x${item.qty} — ${item.name.toUpperCase()}
        ${item.note ? '<br><span style="font-size:12px; font-weight:800; color:#000; display:block; padding:1px 0 2px 4px; letter-spacing:0.03em">&#8627; ' + item.note.toUpperCase() + '</span>' : ''}
      </td>
    </tr>`).join('');

  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: 'Courier New', monospace; font-size:12px; color:#000; background:#fff; width:280px; padding:8px; }
  .header { text-align:center; margin-bottom:6px; }
  .restaurant { font-size:14px; font-weight:700; }
  .area-label { font-size:13px; font-weight:700; color:${areaColor}; border:1px solid ${areaColor}; border-radius:4px; display:inline-block; padding:2px 10px; margin:4px 0; }
  .order-id { font-size:16px; font-weight:900; margin:4px 0; }
  table { width:100%; border-collapse:collapse; }
  td { vertical-align:top; font-size:12px; }
  hr { border:none; border-top:1px dashed #999; margin:5px 0; }
  @media print { body { width:280px; } @page { margin:0; size:80mm auto; } }
</style>
</head><body>
<div class="header">
  <div class="restaurant">${restaurant}</div>
  <div class="area-label">${areaLabel}</div>
  <div class="order-id">Pedido #${order.id}</div>
  <div style="font-size:20px; font-weight:900; margin:5px 0; background: ${colorFondoEtiqueta}; color: #fff; display:inline-block; padding:5px 15px; border-radius: 5px; border:2px solid #000;">
    ${encabezadoPrincipal}
  </div>
  <div style="margin-top:5px;">${dateStr} — ${timeStr}</div>
  <div>Mozo: ${order.waiterName || 'Staff'}</div>
  ${order.customer ? `<div style="font-weight:bold; margin-top:3px;">Cliente: ${order.customer.toUpperCase()}</div>` : ''}
</div>
<hr>
<table>${itemsHTML}</table>
<hr>
</body></html>`;
}

// ── Impresión vía USB ─────────────────────────────────────────
async function _printViaUSB(ticketText, areaConfig) {
  return new Promise((resolve, reject) => {
    if (!escpos || !EscposUSB) {
      return reject(new Error('Driver escpos-usb no disponible. Instalá: npm install escpos escpos-usb'));
    }
    let devices;
    try {
      devices = EscposUSB.findPrinter();
    } catch (e) {
      return reject(new Error(`Error buscando impresoras USB: ${e.message}`));
    }
    if (!devices || devices.length === 0) {
      return reject(new Error('No se encontró ninguna impresora USB conectada'));
    }
    const device  = new EscposUSB(devices[0]);
    const printer = new escpos.Printer(device, { encoding: areaConfig.encoding || 'CP858' });
    const timeout = setTimeout(() => reject(new Error('Timeout abriendo conexión USB (5s)')), 5000);
    device.open((openErr) => {
      clearTimeout(timeout);
      if (openErr) return reject(new Error(`Error abriendo USB: ${openErr.message}`));
      try {
        printer.font('a').align('lt').size(1, 1).text(ticketText).cut().close();
        resolve();
      } catch (printErr) {
        reject(new Error(`Error durante impresión USB: ${printErr.message}`));
      }
    });
  });
}

// ── Impresión vía red TCP ─────────────────────────────────────
async function _printViaNetwork(ticketText, areaConfig) {
  return new Promise((resolve, reject) => {
    if (!escpos || !EscposNetwork) {
      return reject(new Error('Driver escpos-network no disponible. Instalá: npm install escpos-network'));
    }
    const device  = new EscposNetwork(areaConfig.ip, areaConfig.port || 9100);
    const printer = new escpos.Printer(device, { encoding: areaConfig.encoding || 'CP858' });
    const timeout = setTimeout(() => reject(new Error(`Timeout conectando a ${areaConfig.ip}:${areaConfig.port} (5s)`)), 5000);
    device.open((openErr) => {
      clearTimeout(timeout);
      if (openErr) return reject(new Error(`Error conectando a ${areaConfig.ip}: ${openErr.message}`));
      try {
        printer.font('a').align('lt').size(1, 1).text(ticketText).cut().close();
        resolve();
      } catch (printErr) {
        reject(new Error(`Error durante impresión en red: ${printErr.message}`));
      }
    });
  });
}

// ── printTicket: función principal ────────────────────────────
// Intenta impresora física primero; si falla → fallback HTML.
// Nunca lanza excepción (fire-and-forget seguro).
async function printTicket(order, area, config = {}) {
  const areas   = area === 'all' ? ['cocina', 'bar', 'caja'] : [area];
  const results = [];

  for (const a of areas) {
    const areaConfig = PRINTER_CONFIG[a] || {};
    const areaItems  = (order.items || []).filter(i =>
      a === 'all' || a === 'caja' || (i.area || 'cocina').toLowerCase() === a.toLowerCase()
    );
    if (areaItems.length === 0 && a !== 'caja') {
      results.push({ area: a, success: true, method: 'skipped' });
      continue;
    }
    const html = buildTicketHTML(order, a, config);
    if (html === null) {
      results.push({ area: a, success: true, method: 'skipped' });
      continue;
    }
    if (areaConfig.enabled) {
      const escText = _buildEscposText(order, a, config);
      try {
        if (areaConfig.type === 'usb') {
          await _printViaUSB(escText, areaConfig);
          logger.info(`🖨️  [Printer] [${a}] ✓ USB`);
          results.push({ area: a, success: true, method: 'usb' });
          continue;
        }
        if (areaConfig.type === 'network') {
          await _printViaNetwork(escText, areaConfig);
          logger.info(`🖨️  [Printer] [${a}] ✓ Network (${areaConfig.ip})`);
          results.push({ area: a, success: true, method: 'network' });
          continue;
        }
      } catch (hwErr) {
        logger.warn(`🖨️  [Printer] [${a}] Impresora física falló (${hwErr.message}) → fallback HTML`);
      }
    }
    if (!areaConfig.enabled) {
      results.push({ area: a, success: true, method: 'skipped' });
    } else {
      results.push({ area: a, success: true, method: 'fallback-web', html });
    }
  }
  return results;
}

// ── Anti-duplicado de impresión ───────────────────────────────
// Clave: String(orderId) → timestamp de primer registro
// TTL:   12 segundos (suficiente para cualquier round-trip)
const _printedOrderIds = new Map();

function _registerPrintJob(orderId) {
  if (!orderId) return;
  const key = String(orderId);
  if (_printedOrderIds.has(key)) return;
  _printedOrderIds.set(key, Date.now());
  setTimeout(() => _printedOrderIds.delete(key), 12000);
}

function _isPrintJobDuplicate(orderId) {
  if (!orderId) return false;
  const ts = _printedOrderIds.get(String(orderId));
  return !!ts && (Date.now() - ts) < 12000;
}

// ── splitAndPrint — Separador de comandas por área ────────────
// Recibe un pedido con items mixtos y genera UN ticket por área.
// Nunca lanza excepción (fire-and-forget seguro).
async function splitAndPrint(order, config, notify, onlyItems = null) {
  _registerPrintJob(order.id);

  const baseOrder = onlyItems ? { ...order, items: onlyItems } : order;
  const allItems  = baseOrder.items || [];
  const AREAS     = ['cocina', 'bar', 'caja'];

  for (const area of AREAS) {
    const itemsArea = area === 'caja'
      ? allItems  // caja imprime todos los items del pedido
      : allItems.filter(i => (i.area || 'cocina').toLowerCase() === area);
    if (itemsArea.length === 0) continue;

    logger.info(`🖨️ Procesando comanda de: ${area.toUpperCase()}`);

    const areaOrder = { ...baseOrder, items: itemsArea };
    try {
      const results = await printTicket(areaOrder, area, config);
      const r = results.find(x => x.area === area);
      if (r && r.method === 'fallback-web' && r.html) {
        await new Promise(resolve => setTimeout(resolve, 800));
        notify('print:ticket', { area, html: r.html, orderId: order.id });
      }
    } catch (printErr) {
      logger.error(`❌ Error imprimiendo área ${area}:`, printErr.message);
    }
  }
}

module.exports = {
  loadPrinterConfigFromDB,
  getPrinterConfig,
  getDefaultPrinterConfig,
  printTicket,
  buildTicketHTML,
  splitAndPrint,
  _registerPrintJob,
  _isPrintJobDuplicate,
  EscposUSB: () => EscposUSB   // getter lazy para evitar problemas de referencia
};