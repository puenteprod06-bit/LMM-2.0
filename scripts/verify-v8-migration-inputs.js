#!/usr/bin/env node
'use strict';
/**
 * Verifica los INSUMOS de la migración V8 antes de tocar nada:
 *  - backup Copia (nunca la SQLite real del POS) con sha256 e integrity_check;
 *  - decisión de saldo inicial para CADA producto.
 * Solo lee: no migra, no escribe en la BD del POS.
 *
 * Uso: node scripts/verify-v8-migration-inputs.js docs/V8_BALANCE_DECISIONS.json
 * Resultado: docs/V8_MIGRATION_INPUTS_RESULT.json
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'V8_MIGRATION_INPUTS_RESULT.json');
const DECISIONS = new Set(['local', 'remote', 'manual']);
const REAL_DB = /(?:\\|\/)la-mente-maestra(?:\\|\/)database\.sqlite$/i;

function check(name, ok, detail, checks) {
  checks.push({ name, ok: !!ok, detail });
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
}

async function main() {
  const arg = process.argv[2];
  if (!arg) throw new Error('falta la ruta al JSON de decisiones');
  const decisionsPath = path.resolve(process.cwd(), arg);
  const d = JSON.parse(fs.readFileSync(decisionsPath, 'utf8'));
  const checks = [];
  const backupPath = d.backup && String(d.backup.copy_path || '');

  check('backup es una COPIA, no la BD real del POS',
    !!backupPath && !REAL_DB.test(backupPath) && fs.existsSync(backupPath),
    backupPath ? (fs.existsSync(backupPath) ? 'copia existe' : 'no existe') : 'sin ruta', checks);

  if (backupPath && fs.existsSync(backupPath)) {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex');
    const declared = String(d.backup.sha256 || '').trim().toLowerCase();
    check('sha256 del backup coincide', !declared || declared === sha,
      declared ? (declared === sha ? 'coincide' : 'NO coincide') : 'no declarado (incompleto)', checks);
    // integrity_check se ejecuta SIEMPRE sobre una copia temporal, nunca sobre la original.
    const tmp = path.join(os.tmpdir(), 'lmm-v8-check-' + crypto.randomBytes(6).toString('hex') + '.sqlite');
    try {
      fs.copyFileSync(backupPath, tmp);
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(tmp, { readOnly: true });
      const rows = db.prepare('PRAGMA integrity_check').all();
      db.close();
      const result = rows.map((r) => r.integrity_check).join(';');
      check('PRAGMA integrity_check sobre copia temporal', result === 'ok', result, checks);
    } catch (e) {
      check('PRAGMA integrity_check sobre copia temporal', false, e.message, checks);
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }

  const products = Array.isArray(d.products) ? d.products : [];
  check('hay productos declarados', products.length > 0, products.length + ' productos', checks);
  const bad = [];
  products.forEach((p, i) => {
    const stock = Number(p.decided_initial_stock);
    if (!p.product_key || !Number.isFinite(stock) || stock < 0 ||
        !DECISIONS.has(p.decision) || (p.decision === 'manual' && !p.reason)) {
      bad.push('#' + (i + 1) + ' ' + (p.product_key || 'sin clave'));
    }
  });
  check('cada producto tiene decisión de saldo válida', bad.length === 0,
    bad.length ? bad.join(', ') : 'todos válidos', checks);
  check('restaurante destino declarado', !!d.restaurant_id && !!d.cloud_restaurant_id,
    [d.restaurant_id ? 'local' : '', d.cloud_restaurant_id ? 'cloud' : ''].filter(Boolean).join(' + ') || 'faltan', checks);

  const out = {
    checked_at: new Date().toISOString(),
    decisions_file: path.relative(ROOT, decisionsPath).replace(/\\/g, '/'),
    checks,
    summary: { checks: checks.length, passed: checks.filter((c) => c.ok).length,
      failed: checks.filter((c) => !c.ok).length },
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log('\nResultado: ' + path.relative(ROOT, OUT));
  if (out.summary.failed) process.exitCode = 1;
}

main().catch((e) => { console.error('ERROR: ' + e.message); process.exitCode = 1; });
