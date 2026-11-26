// ============================================================
//  telemetry-server.js  —  Servidor central de soporte LMM
//
//  Setup:
//    npm install
//    cp .env.example .env
//    node telemetry-server.js
// ============================================================

require('dotenv').config();
const express  = require('express');
const Database = require('better-sqlite3');
const crypto   = require('crypto');

const app  = express();
const PORT = process.env.PORT || 4000;

const TELEMETRY_API_KEY = process.env.TELEMETRY_API_KEY;
const ADMIN_KEY         = process.env.ADMIN_KEY;

if (!TELEMETRY_API_KEY || !ADMIN_KEY) {
  console.error('❌ Faltan TELEMETRY_API_KEY o ADMIN_KEY en .env');
  process.exit(1);
}

// ── Base de datos ──────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || './telemetry.sqlite';
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS installations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    install_id    TEXT    NOT NULL UNIQUE,
    restaurant    TEXT    NOT NULL,
    email         TEXT,
    platform      TEXT,
    first_seen_at INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reports (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    install_id       TEXT    NOT NULL,
    app_version      TEXT,
    license_active   INTEGER NOT NULL DEFAULT 0,
    last_boot_at     INTEGER,
    last_backup_at   INTEGER,
    critical_errors  INTEGER NOT NULL DEFAULT 0,
    reported_at      INTEGER NOT NULL,
    ip               TEXT,
    FOREIGN KEY (install_id) REFERENCES installations(install_id)
  );

  CREATE INDEX IF NOT EXISTS idx_reports_install  ON reports(install_id);
  CREATE INDEX IF NOT EXISTS idx_reports_reported ON reports(reported_at);
`);

console.log('✅ [DB] Telemetría lista en:', DB_PATH);

// ── Middleware ─────────────────────────────────────────────
app.use(express.json({ limit: '16kb' }));

// Rate limiting simple por IP (sin librerías externas)
const _rateBuckets = new Map();
function rateLimit(maxPerHour = 30) {
  return (req, res, next) => {
    const ip     = req.ip;
    const now    = Date.now();
    const bucket = _rateBuckets.get(ip) || { count: 0, resetAt: now + 3_600_000 };
    if (now > bucket.resetAt) { bucket.count = 0; bucket.resetAt = now + 3_600_000; }
    bucket.count++;
    _rateBuckets.set(ip, bucket);
    if (bucket.count > maxPerHour) return res.status(429).json({ error: 'Rate limit exceeded' });
    next();
  };
}

// Auth POS
function authTelemetry(req, res, next) {
  try {
    const a = Buffer.from(TELEMETRY_API_KEY);
    const b = Buffer.from(req.headers['x-telemetry-key'] || '');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
      return res.status(401).json({ error: 'Unauthorized' });
  } catch { return res.status(401).json({ error: 'Unauthorized' }); }
  next();
}

// Auth admin dashboard
function authAdmin(req, res, next) {
  try {
    const a = Buffer.from(ADMIN_KEY);
    const b = Buffer.from(req.headers['x-admin-key'] || req.query.key || '');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
      return res.status(401).json({ error: 'Unauthorized' });
  } catch { return res.status(401).json({ error: 'Unauthorized' }); }
  next();
}

// ── Validación y sanitización ──────────────────────────────
function validate(d) {
  const e = [];
  if (!d.installId || typeof d.installId !== 'string') e.push('installId requerido');
  if (!d.restaurantName)                               e.push('restaurantName requerido');
  if (typeof d.licenseActive !== 'boolean')            e.push('licenseActive requerido');
  if (!Number.isInteger(d.reportedAt))                 e.push('reportedAt requerido');
  return e;
}

function sanitize(d) {
  return {
    installId:      String(d.installId).slice(0, 64),
    restaurantName: String(d.restaurantName).slice(0, 120),
    email:          d.email    ? String(d.email).slice(0, 100)    : null,
    appVersion:     d.appVersion ? String(d.appVersion).slice(0, 20) : null,
    platform:       d.platform   ? String(d.platform).slice(0, 40)   : null,
    licenseActive:  d.licenseActive ? 1 : 0,
    lastBootAt:     Number.isInteger(d.lastBootAt)    ? d.lastBootAt    : null,
    lastBackupAt:   Number.isInteger(d.lastBackupAt)  ? d.lastBackupAt  : null,
    criticalErrors: Number.isInteger(d.criticalErrors)
                      ? Math.min(d.criticalErrors, 9999) : 0,
    reportedAt:     d.reportedAt,
  };
}

// ── POST /telemetry ────────────────────────────────────────
app.post('/telemetry', rateLimit(30), authTelemetry, (req, res) => {
  const errors = validate(req.body);
  if (errors.length) return res.status(400).json({ error: 'Payload inválido', details: errors });

  const d   = sanitize(req.body);
  const ip  = req.ip;
  const now = Date.now();

  try {
    db.prepare(`
      INSERT INTO installations (install_id, restaurant, email, platform, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(install_id) DO UPDATE SET
        restaurant   = excluded.restaurant,
        email        = excluded.email,
        last_seen_at = excluded.last_seen_at
    `).run(d.installId, d.restaurantName, d.email, d.platform, now, now);

    db.prepare(`
      INSERT INTO reports
        (install_id, app_version, license_active, last_boot_at,
         last_backup_at, critical_errors, reported_at, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(d.installId, d.appVersion, d.licenseActive,
           d.lastBootAt, d.lastBackupAt, d.criticalErrors, d.reportedAt, ip);

    console.log(`[Telemetry] ✅ ${d.restaurantName} (${d.installId.slice(0,8)}…)`);
    res.json({ ok: true });

  } catch (e) {
    console.error('[Telemetry] Error DB:', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── GET /dashboard ─────────────────────────────────────────
app.get('/dashboard', authAdmin, (req, res) => {
  const since = Date.now() - 25 * 3_600_000;

  const installations = db.prepare(`
    SELECT i.install_id, i.restaurant, i.email, i.last_seen_at,
           r.app_version, r.license_active, r.last_backup_at,
           r.critical_errors, r.reported_at
    FROM installations i
    JOIN reports r ON r.install_id = i.install_id
      AND r.id = (
        SELECT id FROM reports WHERE install_id = i.install_id
        ORDER BY reported_at DESC LIMIT 1
      )
    ORDER BY r.reported_at DESC
  `).all();

  res.json({
    summary: {
      total:      installations.length,
      active24h:  installations.filter(x => x.last_seen_at > since).length,
      withErrors: installations.filter(x => x.critical_errors > 0).length,
      noLicense:  installations.filter(x => !x.license_active).length,
      noBackup7d: installations.filter(x =>
                    !x.last_backup_at ||
                    Date.now() - x.last_backup_at > 7 * 86_400_000).length,
    },
    installations,
  });
});

// ── GET /dashboard/alerts ──────────────────────────────────
app.get('/dashboard/alerts', authAdmin, (req, res) => {
  const now   = Date.now();
  const day7  = now - 7 * 86_400_000;
  const h48   = now - 48 * 3_600_000;

  const rows = db.prepare(`
    SELECT i.install_id, i.restaurant, i.email, i.last_seen_at,
           r.app_version, r.license_active, r.last_backup_at,
           r.critical_errors, r.reported_at
    FROM installations i
    JOIN reports r ON r.install_id = i.install_id
      AND r.id = (
        SELECT id FROM reports WHERE install_id = i.install_id
        ORDER BY reported_at DESC LIMIT 1
      )
    WHERE r.license_active = 0
       OR (r.last_backup_at IS NULL OR r.last_backup_at < ?)
       OR r.critical_errors > 5
       OR i.last_seen_at < ?
    ORDER BY r.critical_errors DESC, i.last_seen_at ASC
  `).all(day7, h48);

  const flagged = rows.map(r => ({
    ...r,
    alerts: [
      !r.license_active                                      && '⛔ Licencia inactiva',
      (!r.last_backup_at || r.last_backup_at < day7)         && '💾 Sin backup en +7 días',
      r.critical_errors > 5                                  && `🔴 ${r.critical_errors} errores críticos`,
      r.last_seen_at < h48                                   && '📴 Sin conexión en +48 h',
    ].filter(Boolean),
  }));

  res.json({ count: flagged.length, flagged });
});

// ── GET /dashboard/:id ─────────────────────────────────────
app.get('/dashboard/:id', authAdmin, (req, res) => {
  const info = db.prepare(
    'SELECT * FROM installations WHERE install_id = ?'
  ).get(req.params.id);

  if (!info) return res.status(404).json({ error: 'No encontrada' });

  const history = db.prepare(`
    SELECT app_version, license_active, last_boot_at,
           last_backup_at, critical_errors, reported_at, ip
    FROM reports WHERE install_id = ?
    ORDER BY reported_at DESC LIMIT 100
  `).all(req.params.id);

  res.json({ installation: info, history });
});

// ── Health check ───────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

// ── Start ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Telemetry server en puerto ${PORT}`);
});