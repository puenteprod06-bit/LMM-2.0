#!/usr/bin/env node
'use strict';
/**
 * Validación V8 contra un proyecto SUPABASE AISLADO Y DESECHABLE.
 * NUNCA se conecta a producción: exige --confirm-isolated y un .env.isolated
 * creado por el usuario. No imprime secretos.
 *
 * Uso:
 *   node scripts/validate-v8-supabase.js connect --confirm-isolated
 *   node scripts/validate-v8-supabase.js apply   --confirm-isolated
 *   node scripts/validate-v8-supabase.js smoke   --confirm-isolated
 *   node scripts/validate-v8-supabase.js all     --confirm-isolated
 *
 * Escribe docs/V8_SUPABASE_ISOLATED_RESULT.json sin credenciales.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({
  path: path.join(__dirname, '..', '.env.isolated'),
  override: true,
});

const ROOT = path.resolve(__dirname, '..');
const SQL_FILE = path.join(ROOT, 'supabase', 'migrations', '20261123000000_lmm_inventory_sync_v8.sql');
const RESULT_FILE = path.join(ROOT, 'docs', 'V8_SUPABASE_ISOLATED_RESULT.json');
const REQUIRED = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL'];

function assertGuard() {
  if (!process.argv.includes('--confirm-isolated') &&
      process.env.LMM_V8_SUPABASE_CONFIRM !== 'ISOLATED_THROWAWAY') {
    throw new Error('falta --confirm-isolated: confirma explícitamente que el proyecto es desechable');
  }
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) throw new Error('faltan variables en .env.isolated: ' + missing.join(', '));
}

async function withPg(fn) {
  const { Client } = require('pg');
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
    query_timeout: 120000,
  });
  await client.connect();
  try { return await fn(client); }
  finally { await client.end(); }
}

async function resetThrowaway(client) {
  // Solo se usa con --confirm-isolated: el proyecto es desechable y los datos
  // son sintéticos creados por este propio validador.
  await client.query(`DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p
             JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public' AND p.proname LIKE 'lmm\\_%' LOOP
      EXECUTE format('DROP FUNCTION IF EXISTS %s', r.sig);
    END LOOP; END $$;`);
  await client.query(`DROP SCHEMA IF EXISTS lmm CASCADE`);
  console.log('  RESET: esquema lmm y RPC public.lmm_* eliminados del proyecto desechable');
}

async function applyMigration(client) {
  if (process.argv.includes('--reset-throwaway')) await resetThrowaway(client);
  const exists = await client.query(`select to_regclass('lmm.app_config') as oid`);
  if (exists.rows[0].oid && !process.argv.includes('--force-reapply')) {
    throw new Error('el esquema lmm ya existe; usa un proyecto desechable nuevo o --force-reapply');
  }
  const sql = fs.readFileSync(SQL_FILE, 'utf8');
  const started = Date.now();
  await client.query(sql);
  const counts = await client.query(`
    select
      (select count(*)::int from information_schema.tables where table_schema='lmm') as tables,
      (select count(*)::int from information_schema.routines where routine_schema='lmm') as functions,
      (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='lmm' and c.relkind='r' and c.relrowsecurity) as rls_tables
  `);
  return { applied: true, elapsed_ms: Date.now() - started, counts: counts.rows[0] };
}

async function adminUser(email, password) {
  const res = await fetch(process.env.SUPABASE_URL.replace(/\/$/, '') + '/auth/v1/admin/users', {
    method: 'POST',
    headers: {
      // Las claves nuevas sb_secret_* son API keys, no JWT: van en apikey y
      // también como Bearer, pero nunca mezcladas con la clave anon.
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.id) {
    throw new Error('crear usuario admin falló (HTTP ' + res.status + '): ' + JSON.stringify(body).slice(0, 300));
  }
  return body.id;
}

async function signIn(email, password) {
  const res = await fetch(process.env.SUPABASE_URL.replace(/\/$/, '') + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: process.env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error('login de dispositivo falló (HTTP ' + res.status + '): ' + JSON.stringify(body).slice(0, 300));
  }
  return body.access_token;
}

async function rpc(name, args, token) {
  const res = await fetch(process.env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/rpc/' + name, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => null);
  return { http_status: res.status, body };
}

function record(checks, name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
}

async function smoke() {
  const checks = [];
  const suffix = crypto.randomBytes(6).toString('hex');
  const ownerEmail = `v8-owner-${suffix}@example.invalid`;
  const deviceEmail = `v8-device-${suffix}@example.invalid`;
  const password = 'V8-' + crypto.randomBytes(12).toString('hex') + '!';
  const ownerId = await adminUser(ownerEmail, password);
  const deviceAuthId = await adminUser(deviceEmail, password);
  const token = await signIn(deviceEmail, password);
  const rid = crypto.randomUUID();
  const membership = crypto.randomUUID();
  const device = crypto.randomUUID();
  const inv = crypto.randomUUID();
  const op = crypto.randomUUID();
  const order = crypto.randomUUID();
  const item = crypto.randomUUID();

  await withPg(async (client) => {
    await client.query(`insert into lmm.restaurants(restaurant_id,name) values ($1::uuid,$2)`,
      [rid, 'V8 isolated ' + suffix]);
    const pinSql = `extensions.crypt('0000', extensions.gen_salt('bf'))`;
    let pinHash;
    try {
      pinHash = (await client.query(`select ${pinSql} as h`)).rows[0].h;
    } catch (_) {
      pinHash = (await client.query(`select crypt('0000', gen_salt('bf')) as h`)).rows[0].h;
    }
    await client.query(`insert into lmm.restaurant_memberships
      (membership_id,restaurant_id,auth_user_id,role,display_name,approval_pin_hash)
      values ($1::uuid,$2::uuid,$3::uuid,'owner','Owner aislado',$4)`,
      [membership, rid, ownerId, pinHash]);
    await client.query(`insert into lmm.devices
      (device_id,restaurant_id,auth_user_id,label,enrolled_by_membership_id)
      values ($1::uuid,$2::uuid,$3::uuid,'POS aislado',$4::uuid)`,
      [device, rid, deviceAuthId, membership]);
    await client.query(`insert into lmm.inventory(restaurant_id,inventory_uuid,name,stock,version)
      values ($1::uuid,$2::uuid,'Cerveza',10,1)`, [rid, inv]);
  });

  const envelope = {
    schema_version: '1', operation_id: op, idempotency_key: 'idem-' + op.slice(0, 8),
    device_id: device, client_created_at: new Date().toISOString(), client_actor: 'supabase-validation',
    intent: {
      kind: 'sale', entity_type: 'order', entity_uuid: order, expected_version: 0,
      snapshot: { origin: 'supabase-validation' },
      items: [{ item_uuid: item, item_type: 'inventory', inventory_uuid: inv,
                name: 'Cerveza', unit_price: '80', qty: '2' }],
    },
  };
  const first = await rpc('lmm_apply_operation', { p_request: envelope }, token);
  record(checks, 'C-01: apply_operation devuelve applied', first.http_status === 200 &&
    first.body && first.body.operation_status === 'applied',
    'HTTP ' + first.http_status + ' ' + JSON.stringify(first.body || {}).slice(0, 300));
  const replay = await rpc('lmm_apply_operation', { p_request: envelope }, token);
  record(checks, 'A-01: replay por operation_id', replay.http_status === 200 &&
    replay.body && replay.body.replayed === true,
    'HTTP ' + replay.http_status + ' ' + JSON.stringify(replay.body || {}).slice(0, 300));

  const bad = JSON.parse(JSON.stringify(envelope));
  bad.operation_id = crypto.randomUUID();
  delete bad.idempotency_key;
  const invalid = await rpc('lmm_apply_operation', { p_request: bad }, token);
  const invalidCode = invalid.body && (invalid.body.code || invalid.body.message || '');
  record(checks, 'R-03: PT422 mapeado por PostgREST', invalid.http_status >= 400 &&
    String(invalidCode).includes('PT422'), 'HTTP ' + invalid.http_status + ' código ' + invalidCode);

  const events = await rpc('lmm_get_events', {
    p_device_id: device, p_from_seq: 0, p_limit: 100,
    p_ack_seq: first.body && first.body.event_seq ? first.body.event_seq : null,
  }, token);
  record(checks, 'C-03: get_events con ACK', events.http_status === 200 &&
    events.body && events.body.status === 'ok', 'HTTP ' + events.http_status);

  const voucher = await rpc('lmm_issue_authorization', { p_request: {
    device_id: device, scope: 'negative_stock', approver_membership_id: membership,
    pin: '0000', offline_voucher: true, ttl_minutes: 720,
  } }, token);
  record(checks, 'A-03/A-04: PIN bcrypt real + vale offline', voucher.http_status === 200 &&
    voucher.body && voucher.body.status === 'issued', 'HTTP ' + voucher.http_status);

  const anonDenied = await fetch(process.env.SUPABASE_URL.replace(/\/$/, '') +
    '/rest/v1/rpc/lmm_get_snapshot', {
      method: 'POST',
      headers: { apikey: process.env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_device_id: device }),
    });
  record(checks, 'SE: anon no invoca RPC', anonDenied.status >= 400, 'HTTP ' + anonDenied.status);

  return { checks, synthetic_ids: { restaurant_id: rid, device_id: device, inventory_uuid: inv } };
}

async function main() {
  assertGuard();
  const arg = process.argv[2];
  const cmd = arg && !arg.startsWith('--') ? arg : 'all';
  const startedAt = new Date().toISOString();
  const output = { started_at: startedAt, project_url: process.env.SUPABASE_URL, command: cmd, checks: [] };

  if (cmd === 'connect' || cmd === 'all') {
    const info = await withPg(async (client) => {
      const r = await client.query(`select current_setting('server_version') as version,
        current_user as db_user, current_database() as db`);
      return r.rows[0];
    });
    output.connect = { ok: true, postgres_version: info.version, db: info.db };
    console.log('  PASS conectividad: PostgreSQL ' + info.version);
  }
  if (cmd === 'apply' || cmd === 'all') output.apply = await withPg(applyMigration);
  if (cmd === 'smoke' || cmd === 'all') {
    const result = await smoke();
    output.checks = result.checks;
    output.synthetic_ids = result.synthetic_ids;
  }
  output.finished_at = new Date().toISOString();
  output.summary = {
    checks: output.checks.length,
    passed: output.checks.filter((c) => c.ok).length,
    failed: output.checks.filter((c) => !c.ok).length,
  };
  fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
  fs.writeFileSync(RESULT_FILE, JSON.stringify(output, null, 2));
  console.log('\nResultado guardado en ' + path.relative(ROOT, RESULT_FILE));
  if (output.summary.failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error('ERROR: ' + e.message);
  process.exitCode = 1;
});
