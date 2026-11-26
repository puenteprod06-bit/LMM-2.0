#!/usr/bin/env node
/**
 * make-backup-zip.js
 * Genera un ZIP de respaldo del código fuente excluyendo archivos sensibles.
 * Uso: node scripts/make-backup-zip.js
 *
 * NUNCA incluye:
 *   - .env, .env.runtime (credenciales de Firebase)
 *   - node_modules/
 *   - dist/
 *   - coverage/
 *   - .git/
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const { execSync } = require('child_process');

const ROOT    = path.resolve(__dirname, '..');
const pkg     = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version || 'dev';
const ts      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outName = `LMMAPP-source-v${version}-${ts}.zip`;
const outPath = path.join(ROOT, outName);

const EXCLUDE = [
  '.env',
  '.env.runtime',
  'telemetry-server/.env',       // claves del servidor de telemetría
  'telemetry-server/*.sqlite',   // BD del servidor de telemetría
  'telemetry-server/*.db',
  'node_modules',
  'dist',
  'coverage',
  '.git',
  '*.sqlite',
  '*.db',
  outName,
];

const excludeArgs = EXCLUDE.map(e => `--exclude="${e}"`).join(' ');

console.log(`📦 Generando backup ZIP: ${outName}`);
console.log('🔒 Excluye: .env, .env.runtime, telemetry-server/.env, node_modules, dist, coverage, .git, DBs\n');

try {
  execSync(`zip -r "${outPath}" . ${excludeArgs}`, { cwd: ROOT, stdio: 'inherit' });
  const size = (fs.statSync(outPath).size / 1024).toFixed(0);
  console.log(`\n✅ ZIP creado: ${outName} (${size} KB)`);
  console.log('⚠️  Recordá completar .env.runtime en el destino con las credenciales reales.');
} catch (err) {
  console.error('❌ Error generando ZIP:', err.message);
  process.exit(1);
}