#!/usr/bin/env node
'use strict';
/**
 * Convierte docs/V8_BALANCE_DECISIONS.json en el --input de v8-migrate-local.js.
 * Se NIEGA a generar nada hasta que verify-v8-migration-inputs.js haya pasado
 * sin fallos y el propietario haya marcado owner_confirmed=true.
 *
 * Uso:
 *   node scripts/build-v8-migration-input.js --out <archivo.json>
 * Opcional: --decisions <json> --verification <json>
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DECISIONS = path.join(ROOT, 'docs', 'V8_BALANCE_DECISIONS.json');
const DEFAULT_VERIFICATION = path.join(ROOT, 'docs', 'V8_MIGRATION_INPUTS_RESULT.json');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error('argumento inesperado: ' + a);
    const key = a.slice(2);
    if (!['out', 'decisions', 'verification'].includes(key)) throw new Error('opción desconocida: --' + key);
    out[key] = argv[++i];
    if (!out[key]) throw new Error('falta valor para --' + key);
  }
  if (!out.out) throw new Error('falta --out <archivo.json>');
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const decisions = readJson(args.decisions || DEFAULT_DECISIONS);
  const verification = readJson(args.verification || DEFAULT_VERIFICATION);

  if (decisions.owner_confirmed !== true) {
    throw new Error('owner_confirmed no es true: el propietario aún no aprobó los saldos');
  }
  if (!verification.summary || verification.summary.failed !== 0 ||
      !verification.checks.every((c) => c.ok)) {
    throw new Error('verify-v8-migration-inputs no pasó completamente; ejecútalo de nuevo');
  }

  const verdictByKey = new Map(verification.checks.map((c) => [c.name, c.ok]));
  if (verdictByKey.get('backup es una COPIA, no la BD real del POS') !== true) {
    throw new Error('el backup verificado no es una copia segura');
  }

  const products = Array.isArray(decisions.products) ? decisions.products : [];
  const outDecisions = {};
  for (const p of products) {
    const key = String(p.product_key || '').trim();
    const value = Number(p.decided_initial_stock);
    if (!key || !Number.isFinite(value) || value < 0) {
      throw new Error('decisión inválida para ' + (key || 'producto sin clave'));
    }
    if (Object.prototype.hasOwnProperty.call(outDecisions, key)) {
      throw new Error('product_key duplicado: ' + key);
    }
    outDecisions[key] = value;
  }

  const result = {
    generated_at: new Date().toISOString(),
    source_decisions: path.relative(ROOT, path.resolve(args.decisions || DEFAULT_DECISIONS)).replace(/\\/g, '/'),
    remoteBalances: {},
    deviceReports: [],
    decisions: outDecisions,
    notes: 'Saldos aceptados explícitamente por el propietario. Sin remoto heredado (G0: 0 tablas sync_*).',
  };

  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log('INPUT V8: ' + outPath);
  console.log('PRODUCTOS: ' + Object.keys(outDecisions).length);
}

try { main(); }
catch (err) { console.error('ERROR: ' + err.message); process.exitCode = 1; }
