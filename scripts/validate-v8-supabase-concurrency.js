#!/usr/bin/env node
'use strict';
/**
 * Concurrencia FÍSICA V8 contra un proyecto SUPABASE AISLADO Y DESECHABLE.
 * Dos sesiones PostgREST reales en paralelo. Nunca se conecta a producción.
 *
 * Uso:
 *   node scripts/validate-v8-supabase-concurrency.js --confirm-isolated
 *
 * Requiere que la migración ya esté aplicada en ese proyecto (ver
 * validate-v8-supabase.js all). Escribe docs/V8_SUPABASE_CONCURRENCY_RESULT.json
 * sin credenciales.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({
  path: path.join(__dirname, '..', '.env.isolated'),
  override: true,
});

const ROOT = path.resolve(__dirname, '..');
const RESULT_FILE = path.join(ROOT, 'docs', 'V8_SUPABASE_CONCURRENCY_RESULT.json');
const BASE = () => process.env.SUPABASE_URL.replace(/\/$/, '');

function assertGuard() {
  if (!process.argv.includes('--confirm-isolated') &&
      process.env.LMM_V8_SUPABASE_CONFIRM !== 'ISOLATED_THROWAWAY') {
    throw new Error('falta --confirm-isolated: confirma explícitamente que el proyecto es desechable');
  }
  for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL']) {
    if (!process.env[k]) throw new Error('falta ' + k + ' en .env.isolated');
  }
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

async function createUser(email, password) {
  const res = await fetch(BASE() + '/auth/v1/admin/users', {
    method: 'POST',
    headers: {
      // sb_secret_* son API keys, no JWT: van en apikey y Bearer.
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.id) throw new Error('crear usuario falló (HTTP ' + res.status + ')');
  return body.id;
}

async function signIn(email, password) {
  const res = await fetch(BASE() + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: process.env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error('login falló (HTTP ' + res.status + ')');
  return body.access_token;
}

async function rpc(name, args, token) {
  const send = () => fetch(BASE() + '/rest/v1/rpc/' + name, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(args),
  });
  let res = await send();
  if (res.status === 401) {
    // Auth recién creó el usuario: a veces el JWT tarda en ser aceptado por
    // PostgREST. Un solo reintento evita falsos negativos del arnés.
    await new Promise((resolve) => setTimeout(resolve, 750));
    res = await send();
  }
  return { http_status: res.status, body: await res.json().catch(() => null) };
}

function record(checks, name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
}

function envelope(deviceId, inventoryUuid, qty) {
  const op = crypto.randomUUID();
  return {
    schema_version: '1', operation_id: op, idempotency_key: 'conc-' + op.slice(0, 8),
    device_id: deviceId, client_created_at: new Date().toISOString(),
    client_actor: 'supabase-concurrency',
    intent: {
      kind: 'sale', entity_type: 'order', entity_uuid: crypto.randomUUID(), expected_version: 0,
      snapshot: { origin: 'supabase-concurrency' },
      items: [{ item_uuid: crypto.randomUUID(), item_type: 'inventory',
        inventory_uuid: inventoryUuid, name: 'Cerveza', unit_price: '80', qty: String(qty) }],
    },
  };
}

async function main() {
  assertGuard();
  const startedAt = new Date().toISOString();
  const checks = [];
  const suffix = crypto.randomBytes(6).toString('hex');
  const password = 'V8-' + crypto.randomBytes(12).toString('hex') + '!';
  const [ownerId, devAId, devBId] = await Promise.all([
    createUser(`v8c-owner-${suffix}@example.invalid`, password),
    createUser(`v8c-deva-${suffix}@example.invalid`, password),
    createUser(`v8c-devb-${suffix}@example.invalid`, password),
  ]);
  const [tokA, tokB] = await Promise.all([
    signIn(`v8c-deva-${suffix}@example.invalid`, password),
    signIn(`v8c-devb-${suffix}@example.invalid`, password),
  ]);

  const rid = crypto.randomUUID();
  const membership = crypto.randomUUID();
  const devA = crypto.randomUUID();
  const devB = crypto.randomUUID();
  const invA = crypto.randomUUID();
  const invB = crypto.randomUUID();

  await withPg(async (client) => {
    const exists = await client.query(`select to_regclass('lmm.app_config') as oid`);
    if (!exists.rows[0].oid) throw new Error('la migración V8 no está aplicada en este proyecto');
    await client.query(`insert into lmm.restaurants(restaurant_id,name) values ($1::uuid,$2)`,
      [rid, 'V8 concurrencia ' + suffix]);
    const pinHash = (await client.query(
      `select extensions.crypt('0000', extensions.gen_salt('bf')) as h`)).rows[0].h;
    await client.query(`insert into lmm.restaurant_memberships
      (membership_id,restaurant_id,auth_user_id,role,display_name,approval_pin_hash)
      values ($1::uuid,$2::uuid,$3::uuid,'owner','Owner concurrencia',$4)`,
      [membership, rid, ownerId, pinHash]);
    for (const [dev, authId] of [[devA, devAId], [devB, devBId]]) {
      await client.query(`insert into lmm.devices
        (device_id,restaurant_id,auth_user_id,label,enrolled_by_membership_id)
        values ($1::uuid,$2::uuid,$3::uuid,'POS concurrencia',$4::uuid)`,
        [dev, rid, authId, membership]);
    }
    await client.query(`insert into lmm.inventory(restaurant_id,inventory_uuid,name,stock,version)
      values ($1::uuid,$2::uuid,'Stock 5',5,1),($1::uuid,$3::uuid,'Stock 2',2,1)`,
      [rid, invA, invB]);
  });

  // C-A: dos dispositivos venden 3 cada uno sobre un stock de 5.
  const reqA = envelope(devA, invA, 3);
  const reqB = envelope(devB, invA, 3);
  const [resA, resB] = await Promise.all([
    rpc('lmm_apply_operation', { p_request: reqA }, tokA),
    rpc('lmm_apply_operation', { p_request: reqB }, tokB),
  ]);
  const applied = [resA, resB].filter((r) => r.http_status === 200 &&
    r.body && r.body.operation_status === 'applied');
  const appliedQty = applied.reduce((sum, r) => sum + (r.body.movements || [])
    .filter((m) => m.kind === 'sale')
    .reduce((s, m) => s + Number(m.applied_qty || 0), 0), 0);
  record(checks, 'C-A: dos ventas paralelas no sobrevenden',
    applied.length === 2 && appliedQty === 5,
    `HTTP ${resA.http_status}/${resB.http_status}, aplicado=${appliedQty} de 5` +
    (resA.http_status !== 200 ? ' A=' + JSON.stringify(resA.body || {}).slice(0, 200) : '') +
    (resB.http_status !== 200 ? ' B=' + JSON.stringify(resB.body || {}).slice(0, 200) : ''));

  const final = await withPg(async (client) => {
    const inv = await client.query(`select stock, version from lmm.inventory
      where restaurant_id=$1::uuid and inventory_uuid=$2::uuid`, [rid, invA]);
    const neg = await client.query(`select count(*)::int as n from lmm.stock_movements
      where restaurant_id=$1::uuid and inventory_uuid=$2::uuid and stock_after < 0`, [rid, invA]);
    return { stock: Number(inv.rows[0].stock), version: Number(inv.rows[0].version), negative: neg.rows[0].n };
  });
  record(checks, 'C-B: stock final 0 y ningún movimiento negativo',
    final.stock === 0 && final.version === 3 && final.negative === 0,
    `stock=${final.stock}, version=${final.version}, negativos=${final.negative}`);

  // C-C: el MISMO operation_id enviado dos veces en paralelo => una apply, un replay.
  const same = envelope(devA, invB, 1);
  const [dupA, dupB] = await Promise.all([
    rpc('lmm_apply_operation', { p_request: same }, tokA),
    rpc('lmm_apply_operation', { p_request: same }, tokA),
  ]);
  const replays = [dupA, dupB].filter((r) => r.http_status === 200 && r.body && r.body.replayed === true).length;
  const applies = [dupA, dupB].filter((r) => r.http_status === 200 && r.body && r.body.replayed === false).length;
  const events = await withPg(async (client) => (await client.query(
    `select count(*)::int as n from lmm.sync_events
      where restaurant_id=$1::uuid and operation_id=$2::uuid`, [rid, same.operation_id])).rows[0].n);
  const invBFinal = await withPg(async (client) => Number((await client.query(
    `select stock from lmm.inventory where restaurant_id=$1::uuid and inventory_uuid=$2::uuid`,
    [rid, invB])).rows[0].stock));
  record(checks, 'C-C: mismo operation_id en paralelo => 1 apply + 1 replay, 1 evento',
    applies === 1 && replays === 1 && events === 1 && invBFinal === 1,
    `apply=${applies} replay=${replays} eventos=${events} stock=${invBFinal}`);

  const output = {
    started_at: startedAt, finished_at: new Date().toISOString(),
    project_url: process.env.SUPABASE_URL, command: 'concurrency',
    checks, synthetic_ids: { restaurant_id: rid, device_a: devA, device_b: devB },
    summary: { checks: checks.length, passed: checks.filter((c) => c.ok).length,
      failed: checks.filter((c) => !c.ok).length },
  };
  fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
  fs.writeFileSync(RESULT_FILE, JSON.stringify(output, null, 2));
  console.log('\nResultado guardado en ' + path.relative(ROOT, RESULT_FILE));
  if (output.summary.failed) process.exitCode = 1;
}

main().catch((e) => { console.error('ERROR: ' + e.message); process.exitCode = 1; });
