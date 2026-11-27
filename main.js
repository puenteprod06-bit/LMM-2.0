const { app, BrowserWindow, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const dotenv = require('dotenv');
const { ipcMain } = require('electron');

// ============================================================
//  DOTENV
// ============================================================
// Debe ir ANTES de require('./server.js'): server.js reanuda la sync y decide
// si arranca el motor V8 en el momento en que se carga el módulo.
const envPath = app.isPackaged
  ? path.join(process.resourcesPath, '.env')
  : path.join(__dirname, '.env');
dotenv.config({ path: envPath });

const startServer = require('./server.js');

// ============================================================
//  CRASH REPORTER
// ============================================================
function handleFatalError(error, type) {
  const timestamp = new Date().toLocaleString();
  const logPath = path.join(app.getPath('userData'), 'crash.log');
  const errorMsg = error instanceof Error ? error.stack : JSON.stringify(error);
  const logContent = `\n[${timestamp}] --- FATAL ${type} ---\n${errorMsg}\n${'='.repeat(50)}\n`;
  try {
    fs.appendFileSync(logPath, logContent, 'utf8');
  } catch (fsErr) {
    console.error('No se pudo escribir en crash.log:', fsErr);
  }
  dialog.showErrorBox(
    'Error Inesperado',
    'La aplicación encontró un error inesperado y debe cerrarse.\n\n' +
    'Se ha generado un reporte en: ' + logPath + '\n\n' +
    'Si el problema persiste, contactá a soporte.'
  );
  app.exit(1);
}

process.on('uncaughtException',   (err)    => handleFatalError(err, 'EXCEPTION'));
process.on('unhandledRejection',  (reason) => handleFatalError(reason, 'REJECTION'));

// ============================================================
//  SINGLE INSTANCE LOCK
// ============================================================
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ============================================================
//  VARIABLES GLOBALES
// ============================================================
let mainWindow  = null;
let splashWindow = null;

// Tamaño de la ventanita de login (flotante, sin marco) vs. la app completa
const LOGIN_WINDOW_SIZE = { width: 460, height: 730 };
const APP_WINDOW_SIZE   = { width: 1200, height: 800 };

// ============================================================
//  NAVEGACIÓN SEGURA (Electron hardening)
// ============================================================

// Bloquear apertura de nuevas ventanas (setWindowOpenHandler)
// El navegador de la app nunca debe abrir ventanas externas.
app.on('web-contents-created', (event, webContents) => {
  webContents.setWindowOpenHandler(() => ({
    action: 'deny',
  }));
});

// Bloquear navegación a URLs no permitidas (will-navigate)
// Solo se permite navegar a localhost del servidor interno o file:// (recursos locales).
app.on('web-contents-created', (event, webContents) => {
  webContents.on('will-navigate', (event, navigationUrl) => {
    const url = new URL(navigationUrl);
    const port = String(process.env.PORT || 3000);
    const isAllowed =
      url.protocol === 'file:' ||
      (url.protocol === 'http:' && url.hostname === 'localhost' && url.port === port);
    if (!isAllowed) {
      event.preventDefault();
      logger.warn('[Hardening] Navegación bloqueada:', navigationUrl);
    }
  });
});

// ============================================================
//  HELPERS
// ============================================================

/** Cierra el splash con un pequeño fade (150 ms) para evitar
 *  un corte brusco al mostrar la ventana principal. */
function closeSplash() {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  // Opacidad decreciente: 1 → 0 en ~150 ms (10 pasos × 15 ms)
  let opacity = 1.0;
  const step  = 0.1;
  const timer = setInterval(() => {
    opacity -= step;
    if (!splashWindow || splashWindow.isDestroyed()) {
      clearInterval(timer);
      return;
    }
    if (opacity <= 0) {
      clearInterval(timer);
      splashWindow.close();
    } else {
      splashWindow.setOpacity(opacity);
    }
  }, 15);
}

// ============================================================
//  VENTANA SPLASH
// ============================================================

// HTML del splash incrustado directamente como data URL.
// Esto elimina cualquier problema de rutas o timing con loadFile:
// el contenido ya está en memoria cuando la ventana se crea,
// así que ready-to-show siempre dispara con el contenido pintado.
function getSplashHTML(version) {
  // Probar múltiples rutas posibles en orden
  const candidatePaths = app.isPackaged
    ? [
        path.join(process.resourcesPath, 'app', 'public', 'logo.png'),
        path.join(process.resourcesPath, 'app.asar', 'public', 'logo.png'),
        path.join(process.resourcesPath, 'public', 'logo.png'),
        path.join(__dirname, 'public', 'logo.png'),
      ]
    : [
        path.join(__dirname, 'public', 'logo.png'),
        path.join(__dirname, 'public', 'Logo.png'),
      ];

  let logoSrc = '';
  for (const p of candidatePaths) {
    try {
      const raw = fs.readFileSync(p);
      logoSrc = `data:image/png;base64,${raw.toString('base64')}`;
      logger.info(`✅ Logo splash cargado desde: ${p}`);
      break;
    } catch (_) {
      logger.warn(`Logo no encontrado en: ${p}`);
    }
  }

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{
      background:#0d1726;color:white;
      display:flex;flex-direction:column;
      align-items:center;justify-content:center;
      height:100vh;
      font-family:'Segoe UI',system-ui,sans-serif;
      overflow:hidden;border:1px solid #c5a059;
      user-select:none;-webkit-app-region:drag;
    }
    .logo{width:72px;height:72px;object-fit:contain;margin-bottom:14px}
    .fallback{
      display:none;width:72px;height:72px;margin-bottom:14px;
      border-radius:16px;background:rgba(197,160,89,.15);
      border:2px solid #c5a059;
      align-items:center;justify-content:center;font-size:2rem;
    }
    .name{font-size:.82rem;color:#c5a059;letter-spacing:3px;
          text-transform:uppercase;font-weight:800}
    .sub{font-size:.65rem;color:rgba(255,255,255,.35);
         letter-spacing:1px;margin-top:4px;text-transform:uppercase}
    .track{width:160px;height:3px;background:rgba(255,255,255,.08);
           border-radius:10px;margin-top:22px;overflow:hidden}
    .bar{width:45%;height:100%;
         background:linear-gradient(90deg,transparent,#c5a059,transparent);
         border-radius:10px;animation:sweep 1.4s ease-in-out infinite}
    @keyframes sweep{0%{transform:translateX(-120%)}100%{transform:translateX(280%)}}
    .ver{position:absolute;bottom:10px;right:12px;
         font-size:.58rem;color:rgba(255,255,255,.2)}
  </style></head><body>
    ${logoSrc
      ? `<img class="logo" src="${logoSrc}" onerror="this.style.display='none';document.querySelector('.fallback').style.display='flex'">`
      : ''
    }
    <div class="fallback" ${logoSrc ? '' : 'style="display:flex"'}>🍽️</div>
    <span class="sub">Iniciando sistema…</span>
    <div class="track"><div class="bar"></div></div>
    ${version ? `<span class="ver">v${version}</span>` : ''}
  </body></html>`;
}

function createSplashWindow() {
  const version = require('./package.json').version;

  splashWindow = new BrowserWindow({
    width:           320,
    height:          240,
    frame:           false,
    alwaysOnTop:     true,
    transparent:     false,
    center:          true,
    resizable:       false,
    backgroundColor: '#0d1726',
    show:            false,
    webPreferences:  { nodeIntegration: false, contextIsolation: true, sandbox: true }
  });

  // loadURL con data: es síncrono desde el punto de vista del renderer —
  // el HTML ya está en memoria, no hay fetch de disco ni rutas que fallen.
  const html = getSplashHTML(version);
  splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  // Con data URL, ready-to-show dispara solo cuando el contenido está pintado.
  splashWindow.once('ready-to-show', () => splashWindow.show());
  splashWindow.on('closed', () => { splashWindow = null; });
}

// ============================================================
//  VENTANA PRINCIPAL
// ============================================================
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width:  LOGIN_WINDOW_SIZE.width,
    height: LOGIN_WINDOW_SIZE.height,
    show:   false,                                     // oculta hasta que cargue
    frame:  false,                                      // sin marco nativo: la ventanita de login "flota" sobre el escritorio
    resizable: true,                                     // debe quedar en true: en Windows, setSize() falla en ventanas frameless+resizable:false.
                                                          // Se "traba" el tamaño con setMinimumSize=setMaximumSize (ver más abajo), así el usuario
                                                          // no puede estirarla a mano, pero el código sigue pudiendo redimensionarla.
    center: true,
    icon:   path.join(__dirname, 'public/Logo.ico'),
    autoHideMenuBar: true,
    backgroundColor: '#0d1420',
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.setMenu(null);
  mainWindow.setMinimumSize(LOGIN_WINDOW_SIZE.width, LOGIN_WINDOW_SIZE.height);
  mainWindow.setMaximumSize(LOGIN_WINDOW_SIZE.width, LOGIN_WINDOW_SIZE.height);

  // ── Carga exitosa ──────────────────────────────────────────
  // did-finish-load se dispara cuando el DOM + recursos están
  // listos. Esperamos un tick adicional para que el primer
  // paint del renderer termine antes de cerrar el splash.
  mainWindow.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      closeSplash();
      mainWindow.show();
      mainWindow.focus();
      logger.info('✅ Ventana principal cargada y visible');

      // DevTools solo en desarrollo — nunca abre en los clientes
      if (!app.isPackaged) {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
      }
    }, 120);
  });

  // ── Error de carga (ej.: servidor caído tras iniciar) ──────
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDesc) => {
    // errorCode -3 es "ERR_ABORTED" (navegación cancelada por el propio Electron),
    // ocurre durante recargas normales y no debe tratarse como error.
    if (errorCode === -3) return;

    logger.error(`Error de carga (${errorCode}): ${errorDesc}`);
    closeSplash();
    dialog.showErrorBox(
      'Error de carga',
      `No se pudo cargar la aplicación (${errorDesc}).\n\nCódigo: ${errorCode}`
    );
    app.quit();
  });

  mainWindow.loadURL('http://localhost:3000').catch(err => {
    logger.error('Error en loadURL:', err);
    dialog.showErrorBox('Error de carga', 'No se pudo cargar la aplicación.');
    app.quit();
  });

  // ---- Guardia de cierre: avisa si hay mesas con ordenes activas ----
  let _forceClose = false; // evita loop infinito

  mainWindow.on('close', (e) => {
    if (_forceClose) return; // ya confirmado: dejar cerrar

    e.preventDefault(); // detener el cierre mientras consultamos

    const http = require('http');
    const req  = http.get('http://localhost:3000/api/orders/active-count', (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let tableCount = 0;
        try { tableCount = JSON.parse(raw).tableCount || 0; } catch (_) {}

        if (tableCount === 0) {
          // Sin mesas abiertas: cerrar directamente
          _forceClose = true;
          mainWindow.close();
          return;
        }

        // Hay mesas abiertas: mostrar dialogo nativo
        const mesa  = tableCount === 1 ? 'mesa' : 'mesas';
        const response = dialog.showMessageBoxSync(mainWindow, {
          type:    'warning',
          title:   'Ordenes activas',
          message: `Hay ${tableCount} ${mesa} con ordenes activas`,
          detail:  'Si cerras ahora se perdera el estado de las mesas abiertas.\n\xc2\xbfEstás seguro que querés cerrar?',
          buttons: ['Cancelar', 'Cerrar de todas formas'],
          defaultId: 0,
          cancelId:  0,
          noLink: true
        });

        if (response === 1) {
          _forceClose = true;
          mainWindow.close();
        }
        // response === 0 (Cancelar): no hacer nada, ventana sigue abierta
      });
    });

    req.on('error', () => {
      // Si el servidor no responde, dejar cerrar sin bloquear
      _forceClose = true;
      mainWindow.close();
    });
    req.setTimeout(2000, () => {
      req.destroy();
      _forceClose = true;
      mainWindow.close();
    });
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ============================================================
//  AUTO-UPDATER
// ============================================================
function setupAutoUpdater() {
  // No ejecutar en desarrollo
  if (!app.isPackaged) {
    logger.info('Auto-updater deshabilitado en modo desarrollo');
    return;
  }

  // Silencioso: descarga automática sin preguntar
  autoUpdater.autoDownload    = true;
  autoUpdater.autoInstallOnAppQuit = false; // lo manejamos manualmente
  autoUpdater.allowPrerelease = false;      // solo versiones estables
  autoUpdater.allowDowngrade  = false;      // no permitir downgrades

  autoUpdater.on('checking-for-update', () => {
    logger.info('🔍 Buscando actualizaciones...');
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.webContents.executeJavaScript(
        `document.querySelector('.sub') && (document.querySelector('.sub').textContent = 'Buscando actualizaciones…')`
      ).catch(() => {});
    }
  });

  autoUpdater.on('update-available', (info) => {
    logger.info(`📦 Actualización disponible: v${info.version}`);
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.webContents.executeJavaScript(
        `document.querySelector('.sub') && (document.querySelector('.sub').textContent = 'Descargando v${info.version}…')`
      ).catch(() => {});
    }
  });

  autoUpdater.on('update-not-available', () => {
    logger.info('✅ La app está actualizada');
  });

  autoUpdater.on('download-progress', (progress) => {
    const pct = Math.round(progress.percent);
    logger.info(`⬇️  Descargando: ${pct}%`);
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.webContents.executeJavaScript(
        `document.querySelector('.sub') && (document.querySelector('.sub').textContent = 'Descargando actualización… ${pct}%')`
      ).catch(() => {});
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    logger.info(`✅ Actualización descargada: v${info.version}. Instalando...`);
    // Cerrar splash si sigue visible y reiniciar para instalar
    closeSplash();
    // Dar 500ms para que el splash cierre limpiamente, luego instalar
    setTimeout(() => {
      autoUpdater.quitAndInstall(true, true); // isSilent=true, isForceRunAfter=true
    }, 500);
  });

  autoUpdater.on('error', (err) => {
    logger.warn('⚠️ Error en auto-updater (no crítico):', err?.message || err);
    // No bloquear el inicio por errores de actualización
  });

  // Iniciar verificación
  autoUpdater.checkForUpdates().catch(err => {
    logger.warn('No se pudo verificar actualizaciones:', err?.message);
  });
}

// ============================================================
//  ARRANQUE PRINCIPAL
// ============================================================
app.on('ready', async () => {
  // 1. Splash inmediato
  createSplashWindow();
  logger.info('🖼️ Splash visible');

  // 1b. Verificar actualizaciones (en background, no bloquea el arranque)
  setupAutoUpdater();

  // 2. Timeout de seguridad
  const serverTimeout = setTimeout(() => {
    dialog.showErrorBox(
      'Error de Inicio',
      'El servidor interno no respondió a tiempo (12s).\n\n' +
      'Por favor, cierra el programa e inténtalo de nuevo.\n' +
      'Si el problema persiste, reinstala la aplicación.'
    );
    app.quit();
  }, 12000);

  try {
    // 3. Esperar servidor Express
    await startServer();
    clearTimeout(serverTimeout);
    logger.info('🚀 Servidor listo');

    // 3b. Iniciar sync con la nube si el local ya está vinculado a un restaurant_id
    try {
      const { db: dbApi } = require('./db');
      const cfg = dbApi._native
        ? dbApi._native.prepare('SELECT cloud_restaurant_id, supabase_url, supabase_anon_key FROM config WHERE id = 1').get()
        : null;
      if (cfg && cfg.cloud_restaurant_id && cfg.supabase_url && cfg.supabase_anon_key) {
        const { initSync } = require('./sync-engine');
        initSync({
          supabaseUrl: cfg.supabase_url,
          supabaseAnonKey: cfg.supabase_anon_key,
          restaurantId: cfg.cloud_restaurant_id
        });
      } else {
        logger.info('ℹ️ [SYNC] Local aún no vinculado a la nube (falta configurar en Ajustes > Sincronización)');
      }
    } catch (syncErr) {
      logger.warn('⚠️ [SYNC] No se pudo iniciar el motor de sync:', syncErr.message);
    }

    // 4. Crear ventana principal (oculta)
    createMainWindow();
  } catch (err) {
    clearTimeout(serverTimeout);
    logger.error('Fallo al iniciar servidor:', err);
    dialog.showErrorBox('Fallo Crítico', `No se pudo iniciar el servidor:\n${err.message}`);
    app.quit();
  }
});

// ============================================================
//  EVENTOS DE CIERRE
// ============================================================
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createMainWindow();
});

// ============================================================
//  IPC CONTROLES DE VENTANA (la ventana es frameless)
// ============================================================
ipcMain.handle('win-minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});
ipcMain.handle('win-toggle-maximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle('win-close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});

// ============================================================
//  IPC TRANSICIÓN LOGIN ⇄ APP
//  El renderer avisa cuando el login fue exitoso (o cuando se
//  cierra sesión) para que la ventana pase de "ventanita flotante"
//  a "ventana de app completa" y viceversa. No toca ninguna
//  lógica de autenticación, solo el tamaño/estado de la ventana.
// ============================================================
ipcMain.handle('app-unlocked', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setMaximumSize(0, 0); // 0,0 = sin límite máximo (Electron)
  mainWindow.setMinimumSize(1000, 650);
  mainWindow.setSize(APP_WINDOW_SIZE.width, APP_WINDOW_SIZE.height);
  mainWindow.center();
});
ipcMain.handle('app-locked', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  mainWindow.setMinimumSize(LOGIN_WINDOW_SIZE.width, LOGIN_WINDOW_SIZE.height);
  mainWindow.setMaximumSize(LOGIN_WINDOW_SIZE.width, LOGIN_WINDOW_SIZE.height);
  mainWindow.setSize(LOGIN_WINDOW_SIZE.width, LOGIN_WINDOW_SIZE.height);
  mainWindow.center();
});

// El renderer mide la altura real de la tarjeta de login (Propietario vs
// Staff tienen distinto largo) y nos pide ajustar la ventana a esa altura
// exacta, para que nunca sobre ni falte espacio. El ancho no se toca.
ipcMain.handle('resize-login-window', (_event, height) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const h = Math.max(300, Math.round(Number(height) || 0));
  if (!h) return;
  const [currentWidth] = mainWindow.getSize();
  mainWindow.setMinimumSize(currentWidth, h);
  mainWindow.setMaximumSize(currentWidth, h);
  mainWindow.setSize(currentWidth, h);
  mainWindow.center();
});

// ============================================================
//  IPC PARA VERSIÓN
// ============================================================
const packageJson = require('./package.json');
ipcMain.handle('get-app-version', () => packageJson.version);

// ============================================================
//  IPC PARA CONFIGURACIÓN DE FIREBASE
//  Las claves se leen del .env (proceso principal de Electron),
//  nunca se exponen en el bundle JS público accesible con F12.
// ============================================================
ipcMain.handle('get-app-constants', () => {
  return {
    adminEmail: process.env.ADMIN_EMAIL,
  };
});

// ============================================================
//  IPC PARA ADMIN EMAIL
//  Mismo criterio: dato sensible fuera del bundle público.
// ============================================================
ipcMain.handle('get-admin-email', () => process.env.ADMIN_EMAIL);

// ============================================================
//  IPC TELEMETRY KEY
//  La clave se lee desde .env en el proceso principal y se
//  expone al renderer vía preload.js — nunca va en el bundle.
// ============================================================
ipcMain.handle('get-telemetry-key', () => process.env.TELEMETRY_API_KEY || '');

// ============================================================
//  IPC IMPRESIÓN — LISTA DE IMPRESORAS
//  El renderer la usa para mostrar el selector la primera vez.
// ============================================================
ipcMain.handle('get-printers', async () => {
  if (!mainWindow) return [];
  const printers = await mainWindow.webContents.getPrintersAsync();
  return printers.map(p => ({
    name:      p.name,
    isDefault: p.isDefault,
    status:    p.status,
  }));
});

// ============================================================
//  IPC IMPRESIÓN SILENCIOSA (sin diálogo)
//  Usa la impresora guardada en PrintManager (localStorage).
//  { html: string, printerName: string }
// ============================================================
ipcMain.handle('print-ticket-silent', async (event, { html, printerName }) => {
  return new Promise((resolve) => {
    const pw = new BrowserWindow({
      show:  false,
      title: 'La Mente Maestra – Impresión',
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    pw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

    pw.webContents.once('did-finish-load', () => {
      pw.webContents.print(
        {
          silent:          true,          // ← SIN diálogo
          printBackground: true,
          deviceName:      printerName,   // ← Impresora guardada
          margins:         { marginType: 'none' },
          color:           false,
        },
        (success, errorType) => {
          setTimeout(() => { try { pw.close(); } catch (_) {} }, 1200);
          resolve({ success, errorType: errorType || null });
        }
      );
    });

    // Timeout de seguridad: 15 s
    setTimeout(() => {
      try { pw.close(); } catch (_) {}
      resolve({ success: false, errorType: 'timeout' });
    }, 15000);
  });
});

// ============================================================
//  IPC IMPRESIÓN DE TICKETS
//  Crea una ventana oculta, carga el HTML del ticket y abre
//  el diálogo nativo de impresión de Windows/Mac/Linux.
// ============================================================
ipcMain.handle('print-ticket', async (event, html) => {
  const printWin = new BrowserWindow({
    width:  600,
    height: 800,
    show:   false,
    title:  'La Mente Maestra - Impresión',
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true
    }
  });

  // Cargar el HTML como data URL (tickets son pequeños, caben perfectamente)
  await printWin.loadURL(
    'data:text/html;charset=utf-8,' + encodeURIComponent(html)
  );

  return new Promise((resolve) => {
    printWin.webContents.print(
      { silent: false, printBackground: false, color: false },
      (success, errorType) => {
        // Esperar un poco antes de cerrar para que Windows no cancele el job
        setTimeout(() => { try { printWin.close(); } catch (_) {} }, 1200);
        resolve({ success, errorType: errorType || null });
      }
    );
  });
});