'use strict';

const path = require('path');
const logger = require('../logger');
const fs   = require('fs');

// ============================================================
//  SERVICIO DE BACKUP AUTOMÁTICO
//  Ejecuta una copia de la DB cada 24hs mientras el proceso
//  esté activo. Mantiene un máximo de 7 backups rotando los
//  más antiguos.
// ============================================================

async function runAutoBackupLogic() {
  logger.info('📦 [Backup] Verificando necesidad de respaldo...');

  const appDataPath = process.env.APPDATA
    || (process.platform === 'darwin'
      ? path.join(process.env.HOME, 'Library', 'Preferences')
      : path.join(process.env.HOME, '.local', 'share'));

  const dbDir     = path.join(appDataPath, 'la-mente-maestra');
  const dbPath    = path.join(dbDir, 'database.sqlite');
  const backupDir = path.join(dbDir, 'backups');

  try {
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('backup-') && f.endsWith('.sqlite'))
      .map(f => ({
        name: f,
        path: path.join(backupDir, f),
        time: fs.statSync(path.join(backupDir, f)).mtime.getTime()
      }))
      .sort((a, b) => b.time - a.time);

    const now      = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;

    if (files.length === 0 || (now - files[0].time) > oneDayMs) {
      const timestamp    = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const newBackupPath = path.join(backupDir, `backup-${timestamp}.sqlite`);

      fs.copyFile(dbPath, newBackupPath, (err) => {
        if (err) {
          logger.error('❌ [Backup] Error al crear copia:', err.message);
          return;
        }
        logger.info('✅ [Backup] Nuevo respaldo creado:', path.basename(newBackupPath));

        // Rotación: conservar solo los últimos 7
        const updated = fs.readdirSync(backupDir)
          .filter(f => f.startsWith('backup-'))
          .map(f => ({
            name: f,
            path: path.join(backupDir, f),
            time: fs.statSync(path.join(backupDir, f)).mtime.getTime()
          }))
          .sort((a, b) => b.time - a.time);

        if (updated.length > 7) {
          updated.slice(7).forEach(file => {
            fs.unlinkSync(file.path);
            logger.info('🗑️ [Backup] Limpieza: Eliminado respaldo antiguo:', file.name);
          });
        }
      });
    } else {
      logger.info('⌛ [Backup] Respaldo reciente detectado. No es necesario crear uno nuevo.');
    }
  } catch (err) {
    logger.error('⚠️ [Backup] Error en el gestor de backups:', err.message);
  }
}

// ── Triggers de ejecución ─────────────────────────────────────
// A. Al arrancar (con delay de 5s para que el server esté estable)
// B. Cada 24 horas exactas mientras esté encendido
function startAutoBackup() {
  setTimeout(runAutoBackupLogic, 5000);
  setInterval(runAutoBackupLogic, 24 * 60 * 60 * 1000);
}

module.exports = { runAutoBackupLogic, startAutoBackup };