#!/usr/bin/env node
'use strict';
/**
 * Enciende LMM_INVENTORY_SYNC_V8 SOLO en el `.env` local del piloto.
 *
 * Verifica antes: decisiones 8/8, IDs del piloto, configuración de la SQLite
 * apuntando a producción y una llamada RPC autenticada con sesión real.
 * NO toca `.env.runtime` (plantilla de otros installations), NO modifica
 * Supabase y NO cambia la configuración de la SQLite.
 *
 * Uso:
 *   node scripts/activate-v8-pilot-flag.js --confirm-production-activation
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const dotenv = require(path.join(ROOT, 'node_modules', 'dotenv'));
dotenv.config({ path: path.join(ROOT, '.env.production-readonly'), override: true });
dotenv.config({ path: path.join(ROOT, '.env'), override: false });

const EXPECTED_REF = 'fxkxfidvdzpqqsmktxoq';
const REAL_DB = 'C:\\Users\\agust\\AppData\\Roaming\\la-mente-maestra\\database.sqlite';
const ENV_FILE = path.join(ROOT, '.env');
const OUT_FILE = path.join(ROOT, 'docs', 'V8_PRODUCTION_PILOT_ACTIVATION_RESULT.json');
const FLAG = 'LMM_INVENTORY_SYNC_V8';

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function guard() {
  if (!process.argv.includes('--confirm-production-activation')) {
    throw new Error('falta --confirm-production-activation: confirma encender V8 en el piloto local');
  }
  const ref = new URL(process.env.SUPABASE_URL || '').hostname.match(/^([a-z0-9]+)\.supabase\.co$/i)?.[1];
  if (ref !== EXPECTED_REF) throw new Error('SUPABASE_URL no apunta al proyecto productivo autorizado');
  if (!process.env.SUPABASE_AUTH_EMAIL || !process.env.SUPABASE_AUTH_PASSWORD) {
    throw new Error('faltan credenciales del dispositivo piloto en .env');
  }
}

function setEnvValue(text, key, value) {
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^\\s*${key}\\s*=`);
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) { lines[i] = `${key}=${value}`; found = true; break; }
  }
  if (!found) lines.push(`${key}=${value}`);
  return lines.join('\n').replace(/\n+$/, '') + '\n';
}

async function main() {
  guard();
  const ids = readJson(path.join(ROOT, 'docs', 'V8_PILOT_IDS.json'));
  const decisions = readJson(path.join(ROOT, 'docs', 'V8_BALANCE_DECISIONS.json'));
  const verification = readJson(path.join(ROOT, 'docs', 'V8_MIGRATION_INPUTS_RESULT.json'));
  if (!verification.summary || verification.summary.failed !== 0 ||
      !verification.checks.every((c) => c.ok)) {
    throw new Error('verify-v8-migration-inputs no está 8/8');
  }
  if (decisions.restaurant_id !== ids.restaurant_id ||
      decisions.cloud_restaurant_id !== ids.cloud_restaurant_id ||
      !decisions.owner_confirmed) {
    throw new Error('las decisiones confirmadas no coinciden con los IDs del piloto');
  }

  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(REAL_DB, { readOnly: true });
  let config, deviceId;
  try {
    config = db.prepare(`SELECT cloud_restaurant_id, supabase_url,
      length(supabase_anon_key) AS key_len FROM config WHERE id=1`).get();
    const d = db.prepare('SELECT device_id FROM local_session WHERE id=1').get();
    deviceId = d && d.device_id;
  } finally { db.close(); }
  if (!config || config.cloud_restaurant_id !== ids.cloud_restaurant_id ||
      new URL(config.supabase_url || '').hostname !== `${EXPECTED_REF}.supabase.co` ||
      !config.key_len) {
    throw new Error('la SQLite local no apunta al piloto/producto autorizado');
  }

  const activation = require(path.join(ROOT, 'services', 'inventory-sync-v8', 'activation'));
  const before = activation.evaluate({
    cloud_restaurant_id: config.cloud_restaurant_id,
    supabase_url: config.supabase_url,
    supabase_anon_key: 'present',
  }, { ...process.env, [FLAG]: '0' });

  const v8 = require(path.join(ROOT, 'services', 'inventory-sync-v8'));
  const rpc = v8.createRpc({
    supabaseUrl: config.supabase_url,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
    deviceId,
    restaurantId: ids.cloud_restaurant_id,
  });
  const snap = await rpc.getSnapshot();
  if (snap.error || !snap.data || !Array.isArray(snap.data.inventory)) {
    throw new Error('no se pudo verificar el snapshot autenticado: ' + JSON.stringify(snap.error || {}));
  }

  process.env[FLAG] = '1';
  const after = activation.evaluate({
    cloud_restaurant_id: config.cloud_restaurant_id,
    supabase_url: config.supabase_url,
    supabase_anon_key: 'present',
  }, process.env);
  if (!after.enabled) throw new Error('la activación no quedó habilitada: ' + after.reasons.join(','));

  const envText = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  fs.writeFileSync(ENV_FILE, setEnvValue(envText, FLAG, '1'), 'utf8');

  const result = {
    activated_at: new Date().toISOString(),
    command: 'activate-production-pilot-flag',
    scope: 'SOLO el .env local de esta instalación; .env.runtime permanece con el flag apagado',
    flag: { name: FLAG, value: '1', before: before.reasons, after: after.reasons },
    pilot: {
      restaurant_id: ids.restaurant_id,
      cloud_restaurant_id: ids.cloud_restaurant_id,
      device_id: deviceId,
    },
    verification: {
      migration_inputs: '8/8',
      snapshot_http: 'autenticado',
      inventory_rows: snap.data.inventory.length,
      last_event_seq: snap.data.last_event_seq,
    },
    files: { modified: '.env (ignorado por Git)', runtime_template_untouched: true },
    supabase_touched: false,
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log('FLAG V8 ENCENDIDO SOLO EN EL PILOTO LOCAL: ' + ids.cloud_restaurant_id.slice(0, 8));
  console.log('Antes=' + JSON.stringify(before.reasons) + ' Después=' + JSON.stringify(after.reasons));
  console.log('Resultado: ' + path.relative(ROOT, OUT_FILE));
}

try { main().catch((e) => { console.error('ERROR: ' + e.message); process.exitCode = 1; }); }
catch (e) { console.error('ERROR: ' + e.message); process.exitCode = 1; }
