// ============================================================
//  printer-client.js — Motor de Impresión Frontend
//  La Mente Maestra · PuenteProd
//
//  CARGA: en index.html DESPUÉS de script.js y socket.io
//    <script src="printer-client.js"></script>
//
//  RESPONSABILIDADES:
//    1. Escuchar el evento Socket.IO "print:ticket" del servidor
//    2. Imprimir el HTML recibido via iframe oculto (sin diálogo)
//    3. Exponer printAreaTicket() para el botón manual de comandas
//    4. Exponer window.POSPrinter para uso desde script.js
//
//  COMPATIBILIDAD: No modifica ninguna función existente.
// ============================================================

'use strict';

(function () {

  // ── Utilidades de log ─────────────────────────────────────
  const TAG = '[🖨️ PrinterClient]';
  const log  = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, '⚠️', ...a);
  const err  = (...a) => console.error(TAG, '❌', ...a);

  // ── Anti-duplicación: evita reimprimir el mismo ticket ────
  const _printed = new Set();          // guarda "orderId-area"
  const COOLDOWN_MS = 3000;            // 3 s entre reimpresiones del mismo ticket

  // En printer-client.js
function isDuplicate(orderId, area) {
  // Clave única: Pedido + Área (ej: "36-cocina", "36-bar")
  const key = `${orderId}-${area}`; 
  if (_printed.has(key)) return true;
  _printed.add(key);
  setTimeout(() => _printed.delete(key), 5000); // 5 segundos de gracia
  return false;
}

  // ============================================================
  //  MOTOR DE IMPRESIÓN: iframe oculto
  //  Ventaja: no abre ventana nueva, no necesita allowPopups,
  //  funciona en Electron y en navegadores modernos.
  // ============================================================

  /**
   * Imprime un HTML usando un iframe oculto.
   * El iframe se inyecta, se carga el HTML, se llama print()
   * y luego se elimina automáticamente.
   *
   * @param {string} html   - HTML completo del ticket
   * @param {string} [label] - Etiqueta para el log
   */
  function printViaIframe(html, label = 'ticket') {
    return new Promise((resolve, reject) => {
      // Crear iframe oculto
      const frame = document.createElement('iframe');
      frame.style.cssText = [
        'position:fixed',
        'top:-9999px',
        'left:-9999px',
        'width:0',
        'height:0',
        'border:0',
        'visibility:hidden'
      ].join(';');
      frame.setAttribute('aria-hidden', 'true');

      document.body.appendChild(frame);

      const cleanup = () => {
        try { document.body.removeChild(frame); } catch (_) {}
      };

      frame.onload = () => {
        try {
          // Dar tiempo al navegador de renderizar el HTML
          setTimeout(() => {
            try {
              frame.contentWindow.focus();
              frame.contentWindow.print();
              log(`Impresión enviada — ${label}`);
              resolve();
            } catch (printErr) {
              err('Error al llamar print():', printErr.message);
              reject(printErr);
            } finally {
              // Eliminar iframe después de la impresión
              setTimeout(cleanup, 1500);
            }
          }, 350);
        } catch (loadErr) {
          cleanup();
          reject(loadErr);
        }
      };

      frame.onerror = (e) => {
        cleanup();
        reject(new Error('Error cargando iframe de impresión'));
      };

      // Escribir el HTML en el iframe
      try {
        const doc = frame.contentDocument || frame.contentWindow.document;
        doc.open();
        doc.write(html);
        doc.close();
      } catch (writeErr) {
        cleanup();
        reject(writeErr);
      }
    });
  }

  // ============================================================
  //  ESCUCHAR EVENTO SOCKET.IO: print:ticket
  //  El servidor emite este evento desde splitAndPrint() cuando
  //  la impresora física no está disponible (fallback-web).
  //  Payload: { area: 'cocina'|'bar'|'caja', html: string, orderId: number }
  // ============================================================

  function hookSocketPrintEvent() {
    // Espera a que el socket esté listo (puede tardar un poco)
    const MAX_WAIT = 8000;
    const POLL_MS  = 200;
    let waited = 0;

    const tryHook = () => {
      // _socket está definido en script.js (scope global)
      if (typeof _socket !== 'undefined' && _socket !== null) {
        attachPrintListener(_socket);
        log('Socket encontrado — listener "print:ticket" registrado ✓');
        return;
      }
      waited += POLL_MS;
      if (waited < MAX_WAIT) {
        setTimeout(tryHook, POLL_MS);
      } else {
        warn('Socket no disponible tras', MAX_WAIT / 1000, 's — impresión por socket desactivada');
      }
    };

    tryHook();
  }

  function attachPrintListener(socket) {
    // Remover listener previo si existía (hot-reload)
    socket.off('print:ticket');
    socket.off('print:receipt');

    socket.on('print:ticket', async (payload) => {
      const { area, html, orderId } = payload || {};

      if (!html) {
        warn('Evento "print:ticket" sin HTML — ignorado');
        return;
      }

      // Solo la PC (Electron) procesa este evento.
      // El celular no tiene impresora conectada — ignorar para evitar
      // que el navegador móvil abra el diálogo de impresión.
      if (!window.electronAPI) {
        log(`print:ticket #${orderId} recibido en móvil/navegador — ignorado (solo PC imprime)`);
        return;
      }

      // Guardia anti-duplicación
      if (isDuplicate(orderId, area)) {
        log(`Ticket #${orderId}-${area} ya impreso — ignorando duplicado`);
        return;
      }

      log(`📨 Recibido print:ticket — Pedido #${orderId} · Área: ${area}`);

      try {
        // ── Usar PrintManager si está disponible (Electron) ──
        // Así la primera vez pide impresora y guarda la preferencia,
        // las siguientes veces imprime silenciosamente sin diálogo.
        if (window.PrintManager) {
          await window.PrintManager.print(
            window.PrintManager.TYPES.COMANDA,
            html,
            `comanda-#${orderId}-${area}`
          );
        } else {
          // Fallback: iframe directo (sin Electron)
          await printViaIframe(html, `#${orderId}-${area}`);
        }
        // Notificar al usuario con el sistema de toast existente
        if (typeof toast === 'function') {
          const areaEmoji = { cocina: '🍳', bar: '🍹', caja: '💰' }[area] || '🖨️';
          toast(`${areaEmoji} Comanda ${area} #${orderId} enviada a imprimir`, 'success');
        }
      } catch (printErr) {
        err('Error imprimiendo ticket:', printErr.message);
        if (typeof toast === 'function') {
          toast(`Error al imprimir comanda ${area}`, 'error');
        }
      }
    });

    // ── print:receipt — Ticket de cierre de mesa/delivery/takeaway ──
    // Emitido por el servidor cuando cualquier cliente llama a _autoImprimirTicket.
    // Así la PC imprime aunque el cobro lo haya hecho el teléfono.
    socket.on('print:receipt', async (payload) => {
      const { html, orderId, label } = payload || {};

      if (!html) {
        warn('Evento "print:receipt" sin HTML — ignorado');
        return;
      }

      // Solo la PC (Electron) procesa este evento.
      // El celular no tiene impresora conectada — ignorar para evitar
      // que el navegador móvil abra el diálogo de impresión.
      if (!window.electronAPI) {
        log(`print:receipt #${orderId} recibido en móvil/navegador — ignorado (solo PC imprime)`);
        return;
      }

      // Anti-duplicado: evitar que el mismo cliente imprima dos veces
      if (isDuplicate(orderId, 'receipt')) {
        log(`Receipt #${orderId} ya impreso — ignorando duplicado`);
        return;
      }

      log(`🧾 Recibido print:receipt — Pedido #${orderId} (${label || ''})`);

      try {
        // Usar PrintManager.printForced: pide impresora la 1ra vez y luego
        // imprime silenciosamente. No verifica el toggle (la acción viene
        // del celular, es intencional siempre).
        if (window.PrintManager) {
          await window.PrintManager.printForced(
            window.PrintManager.TYPES.TICKET,
            html,
            label || `receipt-#${orderId}`
          );
        } else {
          await printViaIframe(html, label || `receipt-#${orderId}`);
        }
        if (typeof toast === 'function') {
          toast(`🧾 Ticket #${orderId} enviado a imprimir`, 'success');
        }
      } catch (printErr) {
        err('Error imprimiendo receipt:', printErr.message);
        if (typeof toast === 'function') {
          toast('Error al imprimir ticket de cobro', 'error');
        }
      }
    });
  }

  // ============================================================
  //  API PÚBLICA: POSPrinter
  //  Permite llamar la impresión manualmente desde cualquier
  //  parte de script.js o de los módulos.
  // ============================================================

  /**
   * Solicita al servidor que genere e imprima los tickets de un pedido.
   * Llama a POST /api/printer/reprint y usa el fallback HTML si la
   * impresora física no está disponible.
   *
   * @param {number|string} orderId  - ID del pedido
   * @param {string}        [area]   - 'cocina'|'bar'|'caja'|'all'
   * @returns {Promise<void>}
   */
  async function reprintOrder(orderId, area = 'all') {
    if (!orderId) { warn('reprintOrder: orderId requerido'); return; }

    try {
      const res = await fetch('/api/printer/reprint', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ orderId, area })
      });

      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      const results = data.results || [];

      // Procesar cada área devuelta
      for (const r of results) {
        if (r.method === 'fallback-web' && r.html) {
          // La impresora física no está — imprimimos desde el cliente
          if (!isDuplicate(orderId, r.area)) {
            await printViaIframe(r.html, `reprint-#${orderId}-${r.area}`);
          }
        } else if (r.method === 'skipped') {
          log(`Área '${r.area}' sin ítems — omitida`);
        } else if (r.success) {
          log(`Área '${r.area}' → impreso por impresora física (${r.method})`);
        } else {
          warn(`Área '${r.area}' → error:`, r.error);
        }
      }
    } catch (fetchErr) {
      err('reprintOrder:', fetchErr.message);
      if (typeof toast === 'function') {
        toast('Error de conexión con impresora', 'error');
      }
    }
  }

  /**
   * Imprime un ticket de prueba para verificar la conexión.
   * @param {string} [area='cocina']
   */
  async function printTestTicket(area = 'cocina') {
    try {
      const res = await fetch('/api/printer/test', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ area })
      });
      const data = await res.json();
      const r = (data.results || []).find(x => x.area === area);
      if (r && r.method === 'fallback-web' && r.html) {
        await printViaIframe(r.html, `test-${area}`);
        if (typeof toast === 'function') toast('Ticket de prueba enviado', 'success');
      } else if (r && r.success) {
        if (typeof toast === 'function') toast('Ticket de prueba impreso por impresora física', 'success');
      } else {
        throw new Error((r && r.error) || 'Sin respuesta');
      }
    } catch (e) {
      err('printTestTicket:', e.message);
      if (typeof toast === 'function') toast('Error en ticket de prueba', 'error');
    }
  }

  // ============================================================
  //  printAreaTicket — Función global para botón manual
  //  Usado por el HTML generado en script.js:
  //    onclick="printAreaTicket(orderId, 'cocina')"
  // ============================================================

  /**
   * Imprime manualmente el ticket de un área específica.
   * Esta función se usa desde los botones generados por script.js.
   *
   * @param {number} orderId
   * @param {string} area - 'cocina' | 'bar' | 'caja' | 'all'
   */
  window.printAreaTicket = async function (orderId, area) {
    if (!orderId) return;
    log(`Manual: printAreaTicket(${orderId}, '${area}')`);
    await reprintOrder(orderId, area);
  };

  // ============================================================
  //  CONFIGURAR IMPRESORA USB — endpoint de configuración
  //  Permite cambiar la config desde la UI de Configuración
  // ============================================================

  /**
   * Actualiza la configuración de una impresora en el servidor.
   * Ejemplo de uso desde la UI de Configuración:
   *   POSPrinter.configure('cocina', { type:'usb', enabled:true })
   *
   * @param {string} area     - 'cocina' | 'bar' | 'caja'
   * @param {Object} settings - { type, ip, port, enabled, encoding }
   */
  async function configurePrinter(area, settings) {
    try {
      const res = await fetch('/api/printer/config', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ area, ...settings })
      });
      const data = await res.json();
      if (data.success) {
        log(`Config '${area}' actualizada ✓`);
        if (typeof toast === 'function') toast(`Impresora ${area} configurada`, 'success');
      }
      return data;
    } catch (e) {
      err('configurePrinter:', e.message);
    }
  }

  /**
   * Lee la configuración actual de las impresoras.
   * @returns {Promise<Object>}
   */
  async function getPrinterConfig() {
    try {
      const res = await fetch('/api/printer/config');
      const data = await res.json();
      return data.config || {};
    } catch (e) {
      err('getPrinterConfig:', e.message);
      return {};
    }
  }

  // ============================================================
  //  EXPONER API PÚBLICA
  // ============================================================

  window.POSPrinter = {
    reprint:       reprintOrder,
    test:          printTestTicket,
    configure:     configurePrinter,
    getConfig:     getPrinterConfig,
    printViaIframe // expuesto para usos avanzados
  };

  // ============================================================
  //  INICIALIZACIÓN
  // ============================================================

  function init() {
    log('Módulo cargado — hookeando socket...');
    hookSocketPrintEvent();
  }

  // Esperar a que el DOM esté listo
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();