const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

// 1. Determinar la ruta de logs (Compatible con Child Process)
const appDataPath = process.env.APPDATA 
  || (process.platform === 'darwin'
      ? path.join(process.env.HOME, 'Library', 'Preferences')
      : path.join(process.env.HOME, '.local', 'share'));

const logDir = path.join(appDataPath, 'la-mente-maestra', 'logs');

// Crear la carpeta si no existe
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

// 2. Definir formatos
const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(info => `[${info.timestamp}] [${info.level.toUpperCase()}]: ${info.message}`)
);

// 3. Configurar Winston
const logger = winston.createLogger({
    level: 'info',
    format: logFormat,
    transports: [
        // Rotación diaria para errores
        new winston.transports.DailyRotateFile({
            filename: path.join(logDir, 'error-%DATE%.log'),
            datePattern: 'YYYY-MM-DD',
            level: 'error',
            maxFiles: '7d' // Mantener 7 días
        }),
        // Rotación diaria para todos los logs (info, warn, error)
        new winston.transports.DailyRotateFile({
            filename: path.join(logDir, 'combined-%DATE%.log'),
            datePattern: 'YYYY-MM-DD',
            maxFiles: '7d'
        })
    ]
});

// 4. Si estamos en desarrollo, loguear a consola con colores
if (process.env.NODE_ENV === 'development' || !process.env.NODE_ENV) {
    logger.add(new winston.transports.Console({
        format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
        )
    }));
}

module.exports = logger;