/**
 * preload.js  –  COMPLETE REPLACEMENT
 *
 * Runs in an isolated context between main and renderer.
 * Only explicitly whitelisted channels are exposed.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

  // ── App-level constants (adminEmail, etc.) ─────────────────
  getAppConstants: () => ipcRenderer.invoke('get-app-constants'),

  // ── Impresión de tickets via diálogo nativo de Electron ────
  // Renderer calls: await window.electronAPI.printTicket(htmlString)
  printTicket: (html) => ipcRenderer.invoke('print-ticket', html),

  // ── Lista de impresoras disponibles ────────────────────────
  // Renderer calls: const list = await window.electronAPI.getPrinters()
  // Retorna: [{ name, isDefault, status }]
  getPrinters: () => ipcRenderer.invoke('get-printers'),

  // ── Impresión silenciosa (sin diálogo) ──────────────────────
  // Renderer calls: await window.electronAPI.printTicketSilent(html, printerName)
  // Usa la impresora guardada — no abre ningún diálogo.
  printTicketSilent: (html, printerName) =>
    ipcRenderer.invoke('print-ticket-silent', { html, printerName }),

  // ── Telemetry API key — leída desde process.env en main ────
  // La clave nunca viaja en el bundle del renderer; se expone
  // de forma segura desde el proceso principal vía IPC.
  // Renderer calls: const key = await window.electronAPI.getTelemetryKey()
  getTelemetryKey: () => ipcRenderer.invoke('get-telemetry-key'),

  // ── Controles de ventana propios (la ventana es frameless) ─
  winMinimize:       () => ipcRenderer.invoke('win-minimize'),
  winToggleMaximize: () => ipcRenderer.invoke('win-toggle-maximize'),
  winClose:          () => ipcRenderer.invoke('win-close'),

  // ── Transición ventanita de login ⇄ ventana de app completa ─
  appUnlocked: () => ipcRenderer.invoke('app-unlocked'),
  appLocked:   () => ipcRenderer.invoke('app-locked'),

  // ── Ajuste automático de alto de la ventanita de login ──────
  resizeLoginWindow: (height) => ipcRenderer.invoke('resize-login-window', height),

});