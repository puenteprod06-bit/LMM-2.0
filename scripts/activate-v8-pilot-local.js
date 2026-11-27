#!/usr/bin/env node
'use strict';
/**
 * Activa LOCALMENTE el piloto V8 en la SQLite REAL del POS, con backup verificado.
 * NO activa el flag de entorno y NO toca Supabase.
 *
 * Uso:
 *   node scripts/activate-v8-pilot-local.js --confirm-production-activation
 *
 * Solo tras: verify-v8-migration-inputs 8/8 y build-v8-migration-input.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
require('dotenv').config({
  path: path.join(__dirname, '..', '.env.production-readonly'),
  override: true,
});

const ROOT = path.resolve(__dirname, '..');
const REAL_DB = 'C:\\Users\\agust\\AppData\\Roaming\\la-mente-maestra\\database.sqlite';
const DECISIONS = path.join(ROOT, 'docs', 'V8_BALANCE_DECISIONS.json');
const VERIFICATION = path.join(ROOT, 'docs', 'V8_MIGRATION_INPUTS_RESULT.json');
const INPUT = path.join(ROOT, 'docs', 'V8_MIGRATION_CLI_INPUT.json');
const IDS = path.join(ROOT, 'docs', 'V8_PILOT_IDS.json');
const OUT = path.join(ROOT, 'docs', 'V8_PRODUCTION_PILOT_LOCAL_RESULT.json');
const EXPECTED_REF = 'fxkxfidvdzpqqsmktxoq';

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function openDb(file) {
  try { const D = require('better-sqlite3'); return new D(file); }
  catch (_) { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(file); }
}
function guard() {
  if (!process.argv.includes('--confirm-production-activation')) {
    throw new Error('falta --confirm-production-activation: confirma la escritura en la SQLite real del POS');
  }
  if (!fs.existsSync(REAL_DB)) throw new Error('no existe la SQLite real del POS: ' + REAL_DB);
  const apiRef = new URL(process.env.SUPABASE_URL || '').hostname.match(/^([a-z0-9]+)\.supabase\.co$/i)?.[1];
  if (apiRef !== EXPECTED_REF) {
    throw new Error(`SUPABASE_URL no apunta a producción autorizada: ${apiRef || '?'} (esperado ${EXPECTED_REF})`);
  }
  if (!process.env.SUPABASE_ANON_KEY) throw new Error('falta SUPABASE_ANON_KEY en .env.production-readonly');
}

function verifyBackup(decisions) {
  const backup = String((decisions.backup || {}).copy_path || '');
  if (!backup || !fs.existsSync(backup)) throw new Error('no existe el backup verificado');
  if (path.resolve(backup).toLowerCase() === REAL_DB.toLowerCase()) {
    throw new Error('el backup apunta a la BD real; abortando');
  }
  const sha = crypto.createHash('sha256').update(fs.readFileSync(backup)).digest('hex');
  const declared = String(decisions.backup.sha256 || '').toLowerCase();
  if (sha !== declared) throw new Error('sha256 del backup no coincide; abortando');
  const tmp = path.join(os.tmpdir(), 'lmm-activate-check-' + crypto.randomBytes(6).toString('hex') + '.sqlite');
  try {
    fs.copyFileSync(backup, tmp);
    const db = openDb(tmp);
    const result = db.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check).join(';');
    db.close();
    if (result !== 'ok') throw new Error('integrity_check falló: ' + result);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
  return backup;
}

function main() {
  guard();
  const decisions = readJson(DECISIONS);
  const verification = readJson(VERIFICATION);
  const ids = readJson(IDS);
  const migrationInput = readJson(INPUT);
  if (!verification.summary || verification.summary.failed !== 0 ||
      !verification.checks.every((c) => c.ok)) {
    throw new Error('verify-v8-migration-inputs no pasó 8/8; abortando');
  }
  if (decisions.restaurant_id !== ids.restaurant_id ||
      decisions.cloud_restaurant_id !== ids.cloud_restaurant_id) {
    throw new Error('los IDs del piloto no coinciden entre decisiones y V8_PILOT_IDS.json');
  }
  const backup = verifyBackup(decisions);

  const db = openDb(REAL_DB);
  try {
    const migration = require('../services/inventory-sync-v8/migration');
    const applied = migration.apply(db, {
      ...migrationInput,
      backupVerified: true,
      notes: 'Piloto producción: saldos locales confirmados por el propietario el 2026-11-27',
    });
    const before = db.prepare(
      'SELECT cloud_restaurant_id, supabase_url FROM config WHERE id=1'
    ).get() || {};
    db.exec('BEGIN');
    try {
      db.prepare(`UPDATE config SET cloud_restaurant_id=?, supabase_url=?, supabase_anon_key=? WHERE id=1`)
        .run(ids.cloud_restaurant_id, process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    const after = db.prepare(
      'SELECT cloud_restaurant_id, supabase_url FROM config WHERE id=1'
    ).get();
    const result = {
      applied_at: new Date().toISOString(),
      command: 'activate-pilot-local',
      flag: 'LMM_INVENTORY_SYNC_V8 NO modificado por este script (sigue 0 hasta activación explícita)',
      backup_verified: path.relative(ROOT, backup).replace(/\\/g, '/'),
      verification: { passed: verification.summary.passed, failed: verification.summary.failed },
      migration: { run_id: applied.runId, status: applied.status, counts: applied.counts },
      pilot_ids: { restaurant_id: ids.restaurant_id, cloud_restaurant_id: ids.cloud_restaurant_id },
      config_before: { cloud_restaurant_id: before.cloud_restaurant_id || null, supabase_url: before.supabase_url || null },
      config_after: { cloud_restaurant_id: after.cloud_restaurant_id, supabase_url: after.supabase_url,
        supabase_anon_key_updated: true },
      pos_sqlite_touched: true,
      supabase_touched: false,
    };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n', 'utf8');
    console.log('MIGRACIÓN LOCAL PILOTO APLICADA: run=' + applied.runId +
      ', productos=' + applied.counts.products +
      ', cuarentena=' + applied.counts.queue_quarantined +
      ', filas_borradas=' + applied.counts.queue_rows_deleted);
    console.log('CONFIG: cloud_restaurant_id y Supabase apuntan a producción; anon key actualizada (no impresa).');
    console.log('FLAG: SIN TOCAR (0). Resultado: ' + path.relative(ROOT, OUT));
  } finally {
    db.close();
  }
}

try { main(); }
catch (err) { console.error('ERROR: ' + err.message); process.exitCode = 1; }
