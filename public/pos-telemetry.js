'use strict';

/**
 * pos-telemetry.js
 *
 * Módulo de telemetría — reporta métricas de uso al servidor en background.
 *
 * SEGURIDAD: La API key NO está hardcodeada aquí.
 * Se lee desde window.electronAPI.getTelemetryKey(), que a su vez
 * la obtiene de process.env.TELEMETRY_API_KEY en el proceso principal
 * via preload.js → ipcMain. Nunca viaja en el bundle distribuido.
 */

const POSTelemetry = (() => {
  const ENDPOINT      = 'http://localhost:4000/telemetry';
  const INTERVAL_MS   = 36e5;   // 1 hora
  const WINDOW_MS     = 864e5;  // 24 horas (ventana de errores críticos)
  const UUID_KEY      = 'mm_install_uuid';
  const BOOT_TS_KEY   = 'mm_last_boot_ts';

  let intervalId      = null;
  let criticalErrors  = [];
  let origConsoleErr  = null;

  // ── API key — leída desde Electron main via preload ──────────────────────
  // Retorna '' si no está disponible (modo web/dev sin Electron).
  async function getApiKey() {
    try {
      return (await window.electronAPI?.getTelemetryKey()) || '';
    } catch {
      return '';
    }
  }

  // ── UUID de instalación ─────────────────────────────────────────────────
  function getOrCreateInstallId() {
    let id = localStorage.getItem(UUID_KEY);
    if (!id) {
      id = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `lmm-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
      localStorage.setItem(UUID_KEY, id);
      console.info('[Telemetry] UUID de instalación generado:', id);
    }
    return id;
  }

  // ── Conteo de errores críticos en la ventana de 24h ────────────────────
  function countRecentCriticalErrors() {
    const cutoff = Date.now() - WINDOW_MS;
    criticalErrors = criticalErrors.filter(e => e.ts > cutoff);
    return criticalErrors.length;
  }

  // ── Construcción del payload ────────────────────────────────────────────
  function buildPayload() {
    const reg         = JSON.parse(localStorage.getItem('mente_maestra_registration') || '{}');
    const lastValTs   = parseInt(localStorage.getItem('_mm_last_val') || '0');
    const licenseActive = Date.now() - lastValTs < 9e7;
    const lastBackupAt  = parseInt(localStorage.getItem('mm_last_backup_ts') || '0') || null;
    const appVersion    = window.electronAPI?.appVersion || '1.6.3';

    return {
      installId:      getOrCreateInstallId(),
      restaurantName: window.S?.config?.name || reg.restaurante || 'Desconocido',
      email:          reg.email || null,
      appVersion,
      platform:       navigator.platform || 'unknown',
      licenseActive,
      lastBootAt:     parseInt(localStorage.getItem(BOOT_TS_KEY) || '0') || null,
      lastBackupAt,
      criticalErrors: countRecentCriticalErrors(),
      reportedAt:     Date.now(),
    };
  }

  // ── Envío del reporte ───────────────────────────────────────────────────
  async function sendReport() {
    const apiKey = await getApiKey();
    if (!apiKey) {
      console.warn('[Telemetry] API key no disponible — reporte omitido.');
      return;
    }

    const payload = buildPayload();
    try {
      const res = await fetch(ENDPOINT, {
        method:    'POST',
        headers:   { 'Content-Type': 'application/json', 'X-Telemetry-Key': apiKey },
        body:      JSON.stringify(payload),
        keepalive: true,
      });
      if (res.ok) {
        console.info('[Telemetry] Reporte enviado ✓');
      } else {
        console.warn('[Telemetry] Respuesta no OK:', res.status);
      }
    } catch (err) {
      console.warn('[Telemetry] Sin conexión:', err.message);
    }
  }

  // ── API pública ─────────────────────────────────────────────────────────
  return {

    init() {
      localStorage.setItem(BOOT_TS_KEY, Date.now().toString());

      // Interceptar console.error para contar errores críticos
      origConsoleErr = console.error.bind(console);
      console.error = function (...args) {
        criticalErrors.push({ ts: Date.now() });
        origConsoleErr(...args);
      };

      getOrCreateInstallId();
      setTimeout(sendReport, 1000);
      intervalId = setInterval(sendReport, INTERVAL_MS);
      console.info('[Telemetry] Iniciado — UUID:', localStorage.getItem(UUID_KEY));
    },

    stop() {
      if (intervalId) { clearInterval(intervalId); intervalId = null; }
      if (origConsoleErr) { console.error = origConsoleErr; }
    },

    sendNow() {
      return sendReport();
    },

    inspect() {
      return buildPayload();
    },

  };
})();