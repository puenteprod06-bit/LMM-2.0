#!/usr/bin/env node
'use strict';
/**
 * Aprovisiona la IDENTIDAD y el CATÁLOGO inicial del piloto V8 en PRODUCCIÓN.
 *
 * - Crea usuario Auth owner y usuario Auth dispositivo, membresía y dispositivo.
 * - Crea el restaurante piloto y carga el catálogo con los saldos confirmados
 *   localmente (stock_confirmed_milli / 1000). No borra ni sobrescribe saldos
 *   remotos ya existentes.
 * - Guarda credenciales del dispositivo y el PIN del owner en `.env` (ignorado).
 * - NO activa LMM_INVENTORY_SYNC_V8.
 *
 * Uso:
 *   node scripts/provision-v8-production-pilot.js --confirm-production-pilot
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env.production-readonly'), override: true });

const EXPECTED_REF = 'fxkxfidvdzpqqsmktxoq';
const REAL_DB = 'C:\\Users\\agust\\AppData\\Roaming\\la-mente-maestra\\database.sqlite';
const IDS_FILE = path.join(ROOT, 'docs', 'V8_PILOT_IDS.json');
const DECISIONS_FILE = path.join(ROOT, 'docs', 'V8_BALANCE_DECISIONS.json');
const VERIFICATION_FILE = path.join(ROOT, 'docs', 'V8_MIGRATION_INPUTS_RESULT.json');
const ENV_FILE = path.join(ROOT, '.env');
const OUT_FILE = path.join(ROOT, 'docs', 'V8_PRODUCTION_PILOT_AUTH_RESULT.json');

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function guard() {
  if (!process.argv.includes('--confirm-production-pilot')) {
    throw new Error('falta --confirm-production-pilot: confirma la escritura en PRODUCCIÓN');
  }
  if (!process.env.DATABASE_URL || !process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    throw new Error('faltan credenciales en .env.production-readonly');
  }
  let apiRef, dbRef;
  try {
    apiRef = new URL(process.env.SUPABASE_URL).hostname.match(/^([a-z0-9]+)\.supabase\.co$/i)?.[1];
    const u = new URL(process.env.DATABASE_URL);
    dbRef = u.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/i)?.[1] ||
      decodeURIComponent(u.username).match(/^postgres\.([a-z0-9]+)$/i)?.[1];
  } catch (_) { /* se reporta abajo */ }
  if (apiRef !== EXPECTED_REF || dbRef !== EXPECTED_REF) {
    throw new Error(`ref de producción no autorizado: api=${apiRef || '?'} db=${dbRef || '?'}`);
  }
}

function parseEnv(text) {
  const lines = text.split(/\r?\n/);
  return { lines, index: new Map(lines.map((l, i) => [String(l).match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1], i]).filter(([k]) => k)) };
}

function setEnv(parsed, key, value) {
  const i = parsed.index.get(key);
  const line = `${key}=${value}`;
  if (i == null) { parsed.lines.push(line); parsed.index.set(key, parsed.lines.length - 1); }
  else parsed.lines[i] = line;
}

function readLocal() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(REAL_DB, { readOnly: true });
  try {
    const device = db.prepare('SELECT device_id FROM local_session WHERE id=1').get();
    const inventory = db.prepare(`SELECT uuid, name, stock_confirmed_milli, confirmed_version
      FROM inventory WHERE uuid IS NOT NULL AND stock_confirmed_milli IS NOT NULL ORDER BY id`).all();
    return { deviceId: device && device.device_id, inventory };
  } finally { db.close(); }
}

async function hashWithPg(client, text) {
  for (const expr of [
    `extensions.crypt($1, extensions.gen_salt('bf'))`,
    `crypt($1, gen_salt('bf'))`,
  ]) {
    try {
      const r = await client.query(`select ${expr} as h`, [text]);
      if (r.rows[0] && r.rows[0].h) return r.rows[0].h;
    } catch (_) { /* prueba la siguiente */ }
  }
  throw new Error('no se pudo calcular hash bcrypt en PostgreSQL');
}

async function insertAuthUser(client, id, email, passwordHash) {
  const exists = await client.query('select id from auth.users where email=$1', [email]);
  if (exists.rowCount) return { id: exists.rows[0].id, created: false };
  await client.query(`insert into auth.users
    (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
     confirmation_token, recovery_token, email_change_token_new, email_change,
     raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    values ('00000000-0000-0000-0000-000000000000'::uuid, $1::uuid, 'authenticated', 'authenticated',
            $2, $3, now(), '', '', '', '',
            '{"provider":"email","providers":["email"]}'::jsonb, '{"email_verified":true}'::jsonb,
            now(), now())`, [id, email, passwordHash]);
  await client.query(`insert into auth.identities
    (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
    values ($1::uuid, $2::uuid,
            jsonb_build_object('sub', $2::text, 'email', $3::text, 'email_verified', false, 'phone_verified', false),
            'email', $2::text, now(), now(), now())`,
    [crypto.randomUUID(), id, email]);
  return { id, created: true };
}

async function normalizeAuthTokens(client, id) {
  await client.query(`update auth.users set
    confirmation_token='', recovery_token='', email_change_token_new='', email_change=''
    where id=$1::uuid`, [id]);
}

async function main() {
  guard();
  const ids = readJson(IDS_FILE);
  const decisions = readJson(DECISIONS_FILE);
  const verification = readJson(VERIFICATION_FILE);
  if (!verification.summary || verification.summary.failed !== 0 ||
      !verification.checks.every((c) => c.ok)) {
    throw new Error('la verificación de decisiones no está 8/8');
  }
  if (decisions.restaurant_id !== ids.restaurant_id ||
      decisions.cloud_restaurant_id !== ids.cloud_restaurant_id) {
    throw new Error('los IDs del piloto no coinciden');
  }
  const local = readLocal();
  if (!local.deviceId || !/^[0-9a-f-]{36}$/i.test(local.deviceId)) {
    throw new Error('no hay device_id persistente en la SQLite del POS');
  }
  if (!local.inventory.length) throw new Error('no hay saldos confirmados en la SQLite del POS');

  const tag = ids.cloud_restaurant_id.replace(/-/g, '').slice(0, 8);
  const envText = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const parsed = parseEnv(envText);
  const get = (k) => {
    const i = parsed.index.get(k);
    return i == null ? null : String(parsed.lines[i]).replace(new RegExp(`^\\s*${k}\\s*=\\s*`), '').trim();
  };
  const credentials = {
    ownerEmail: get('SUPABASE_PILOT_OWNER_EMAIL') || `v8-owner-${tag}@example.invalid`,
    ownerPassword: get('SUPABASE_PILOT_OWNER_PASSWORD') || crypto.randomBytes(18).toString('base64url'),
    deviceEmail: get('SUPABASE_AUTH_EMAIL') || `v8-device-${tag}@example.invalid`,
    devicePassword: get('SUPABASE_AUTH_PASSWORD') || crypto.randomBytes(18).toString('base64url'),
    pin: get('LMM_PILOT_ADMIN_PIN') || String(crypto.randomInt(100000, 999999)),
  };
  setEnv(parsed, 'SUPABASE_PILOT_OWNER_EMAIL', credentials.ownerEmail);
  setEnv(parsed, 'SUPABASE_PILOT_OWNER_PASSWORD', credentials.ownerPassword);
  setEnv(parsed, 'SUPABASE_AUTH_EMAIL', credentials.deviceEmail);
  setEnv(parsed, 'SUPABASE_AUTH_PASSWORD', credentials.devicePassword);
  setEnv(parsed, 'LMM_PILOT_ADMIN_PIN', credentials.pin);
  fs.writeFileSync(ENV_FILE, parsed.lines.join('\n').replace(/\n+$/, '') + '\n', 'utf8');

  const { Client } = require('pg');
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
    query_timeout: 120000,
  });
  await client.connect();
  let result;
  const restaurantId = ids.restaurant_id;
  try {
    // El pooler productivo puede abrir la sesión en READ ONLY; este script
    // necesita escribir el piloto y lo hace con confirmación explícita.
    await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE');
    const ownerHash = await hashWithPg(client, credentials.ownerPassword);
    const deviceHash = await hashWithPg(client, credentials.devicePassword);
    const pinHash = await hashWithPg(client, credentials.pin);
    await client.query('BEGIN');
    try {
      const rest = await client.query('select restaurant_id from lmm.restaurants where restaurant_id=$1::uuid', [restaurantId]);
      let restaurantCreated = false;
      if (!rest.rowCount) {
        await client.query(`insert into lmm.restaurants(restaurant_id,name) values ($1::uuid,$2)`,
          [restaurantId, 'Piloto La Mente Maestra']);
        restaurantCreated = true;
      }
      const owner = await insertAuthUser(client, crypto.randomUUID(), credentials.ownerEmail, ownerHash);
      const deviceUser = await insertAuthUser(client, crypto.randomUUID(), credentials.deviceEmail, deviceHash);
      await normalizeAuthTokens(client, owner.id);
      await normalizeAuthTokens(client, deviceUser.id);

      let membershipId;
      const mem = await client.query(`select membership_id from lmm.restaurant_memberships
        where restaurant_id=$1::uuid and auth_user_id=$2::uuid`, [restaurantId, owner.id]);
      if (mem.rowCount) membershipId = mem.rows[0].membership_id;
      else {
        membershipId = crypto.randomUUID();
        await client.query(`insert into lmm.restaurant_memberships
          (membership_id,restaurant_id,auth_user_id,role,display_name,approval_pin_hash)
          values ($1::uuid,$2::uuid,$3::uuid,'owner','Owner piloto',$4)`,
          [membershipId, restaurantId, owner.id, pinHash]);
      }

      let deviceCreated = false;
      const dev = await client.query('select device_id from lmm.devices where device_id=$1::uuid', [local.deviceId]);
      if (!dev.rowCount) {
        await client.query(`insert into lmm.devices
          (device_id,restaurant_id,auth_user_id,label,enrolled_by_membership_id)
          values ($1::uuid,$2::uuid,$3::uuid,'POS piloto',$4::uuid)`,
          [local.deviceId, restaurantId, deviceUser.id, membershipId]);
        deviceCreated = true;
      }

      let inventoryInserted = 0;
      for (const p of local.inventory) {
        const stock = (Number(p.stock_confirmed_milli) / 1000).toFixed(3);
        const r = await client.query(`insert into lmm.inventory
          (restaurant_id,inventory_uuid,name,stock,version,deleted)
          values ($1::uuid,$2::uuid,$3,$4::numeric,$5,false)
          on conflict (restaurant_id,inventory_uuid) do nothing`,
          [restaurantId, p.uuid, p.name, stock, Number(p.confirmed_version) || 1]);
        inventoryInserted += r.rowCount;
      }
      const remote = await client.query(`select inventory_uuid::text, name, stock::text, version::text
        from lmm.inventory where restaurant_id=$1::uuid order by inventory_uuid`, [restaurantId]);
      await client.query('COMMIT');

      result = {
        provisioned_at: new Date().toISOString(),
        command: 'provision-production-pilot',
        project_ref: EXPECTED_REF,
        flag: 'LMM_INVENTORY_SYNC_V8 NO tocado por este script',
        restaurant_id: restaurantId,
        cloud_restaurant_id: ids.cloud_restaurant_id,
        device_id: local.deviceId,
        created: {
          restaurant: restaurantCreated,
          owner_user: owner.created,
          device_user: deviceUser.created,
          device: deviceCreated,
          inventory_rows: inventoryInserted,
        },
        remote_inventory: remote.rows,
        credentials_written_to: '.env (ignorado por Git; valores no impresos)',
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally { await client.end(); }

  // Verificación real: login Auth + snapshot RPC con el dispositivo piloto.
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const login = await fetch(base + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: process.env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: credentials.deviceEmail, password: credentials.devicePassword }),
  });
  const loginBody = await login.json().catch(() => ({}));
  if (!login.ok || !loginBody.access_token) {
    throw new Error('login Auth del piloto falló: HTTP ' + login.status + ' ' + JSON.stringify(loginBody).slice(0, 200));
  }
  const snap = await fetch(base + '/rest/v1/rpc/lmm_get_snapshot', {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + loginBody.access_token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_device_id: local.deviceId }),
  });
  const snapBody = await snap.json().catch(() => ({}));
  if (!snap.ok || !snapBody || snapBody.inventory === undefined) {
    throw new Error('snapshot RPC falló: HTTP ' + snap.status + ' ' + JSON.stringify(snapBody).slice(0, 300));
  }
  result.rpc_verification = {
    login_http_status: login.status,
    snapshot_http_status: snap.status,
    inventory_rows: Array.isArray(snapBody.inventory) ? snapBody.inventory.length : null,
    last_event_seq: snapBody.last_event_seq,
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log('PILOTO PRODUCCIÓN APROVISIONADO: restaurante=' + restaurantId.slice(0, 8) +
    ', dispositivo=' + local.deviceId.slice(0, 8) + ', catálogo=' + result.created.inventory_rows +
    ', snapshot=' + result.rpc_verification.inventory_rows + ' filas');
  console.log('Credenciales del dispositivo escritas en .env (no impresas). Flag sigue SIN TOCAR.');
  console.log('Resultado: ' + path.relative(ROOT, OUT_FILE));
}

try { main().catch((e) => { console.error('ERROR: ' + e.message); process.exitCode = 1; }); }
catch (e) { console.error('ERROR: ' + e.message); process.exitCode = 1; }
