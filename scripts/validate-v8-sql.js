#!/usr/bin/env node
'use strict';
/**
 * Validación AISLADA del SQL de sincronización V8 (Fase 2B.5.1).
 *
 * Usa PGlite = PostgreSQL real compilado a WASM, en memoria, sin daemon, sin
 * red y sin credenciales. NUNCA se conecta a Supabase ni a una base real.
 * Limitaciones documentadas en docs/V8_FIX_REPORT.md: auth.uid() y pgcrypto
 * se sustituyen por stubs locales, y PGlite no ofrece sesiones paralelas.
 *
 * Uso: node scripts/validate-v8-sql.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert/strict');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.resolve(__dirname, '..');
const SQL_FILE = path.join(ROOT, 'supabase', 'migrations', '20261123000000_lmm_inventory_sync_v8.sql');
const checks = [];

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { checks.push({ name, ok: true }); console.log('  PASS ' + name); })
    .catch((e) => { checks.push({ name, ok: false, error: e.message }); console.log('  FAIL ' + name + ' — ' + e.message); throw e; });
}

async function rows(db, sql, params = []) { return (await db.query(sql, params)).rows; }
async function row(db, sql, params = []) { return (await rows(db, sql, params))[0]; }
async function scalar(db, sql, params = []) { const r = await row(db, sql, params); return r && Object.values(r)[0]; }
async function throwsCode(db, sql, params, code) {
  try { await db.query(sql, params); }
  catch (e) {
    assert.match(String(e.code || e.message), new RegExp(code), `se esperaba ${code}, se obtuvo ${e.code || e.message}`);
    return e;
  }
  throw new Error(`se esperaba el error ${code} y la consulta terminó sin error`);
}

async function main() {
  assert.ok(fs.existsSync(SQL_FILE), 'no se encontró la migración SQL: ' + SQL_FILE);
  const db = new PGlite();
  try {
    console.log('PostgreSQL aislado: ' + (await scalar(db, 'select version()')));

    // ── Entorno aislado: esquemas/roles de Supabase emulados (sin secretos) ──
    await db.exec(`
      create schema auth;
      create schema extensions;
      create role anon;
      create role authenticated;
      create role service_role;
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      -- stub SOLO para validación: la plataforma real usa extensions.pgcrypto/bcrypt.
      -- Se ignora el salt para que crypt(PIN, hash) == hash con un hash sintético.
      create function extensions.crypt(text, text) returns text language sql immutable
        as $$ select md5($1) $$;
      create function extensions.gen_salt(text) returns text language sql volatile
        as $$ select md5(random()::text) $$;
    `);

    const sql = fs.readFileSync(SQL_FILE, 'utf8');
    await check('migración SQL completa se ejecuta en PostgreSQL aislado', async () => {
      await db.exec(sql);
      const tables = await scalar(db,
        `select count(*)::int from information_schema.tables where table_schema='lmm'`);
      assert.ok(tables >= 15, `solo ${tables} tablas en lmm`);
    });

    await check('configuración de vales en lmm.app_config (5 / 720 / 48)', async () => {
      const cfg = await rows(db, `select key, value #>> '{}' as v from lmm.app_config where key = any($1::text[])`,
        [['offline_voucher_max_per_device', 'offline_voucher_ttl_minutes', 'authorization_grace_hours']]);
      const map = Object.fromEntries(cfg.map((c) => [c.key, c.v]));
      assert.equal(map.offline_voucher_max_per_device, '5');
      assert.equal(map.offline_voucher_ttl_minutes, '720');
      assert.equal(map.authorization_grace_hours, '48');
    });

    // ── Datos sintéticos (UUID efímeros; nada de producción) ────────────────
    const rid = crypto.randomUUID();
    const member = crypto.randomUUID();
    const device = crypto.randomUUID();
    const otherDevice = crypto.randomUUID();
    const authUser = crypto.randomUUID();
    const inv = crypto.randomUUID();
    await db.query(`insert into lmm.restaurants(restaurant_id, name) values ($1::uuid, 'Test aislado')`, [rid]);
    await db.query(`
      insert into lmm.restaurant_memberships
        (membership_id, restaurant_id, auth_user_id, role, display_name, approval_pin_hash)
      values ($1::uuid, $2::uuid, $3::uuid, 'owner', 'Propietario prueba', md5('0000'))`,
      [member, rid, authUser]);
    await db.query(`
      insert into lmm.devices (device_id, restaurant_id, auth_user_id, label, enrolled_by_membership_id)
      values ($1::uuid, $2::uuid, $3::uuid, 'POS aislado', $4::uuid)`,
      [device, rid, authUser, member]);
    await db.query(`
      insert into lmm.devices (device_id, restaurant_id, auth_user_id, label, enrolled_by_membership_id)
      values ($1::uuid, $2::uuid, $3::uuid, 'Otro dispositivo', $4::uuid)`,
      [otherDevice, rid, crypto.randomUUID(), member]);
    await db.query(`
      insert into lmm.inventory (restaurant_id, inventory_uuid, name, stock, version)
      values ($1::uuid, $2::uuid, 'Cerveza', 10, 1)`, [rid, inv]);

    // Las lecturas de verificación se hacen como propietario (el schema lmm es
    // privado a propósito); SOLO las RPC se invocan con el rol authenticated.
    await db.exec(`set request.jwt.claim.sub = '${authUser}'`);
    async function asAuthenticated(sql, params = []) {
      await db.exec('set role authenticated');
      try { return await rows(db, sql, params); }
      finally { await db.exec('reset role'); }
    }

    const envelope = (op, idem, intent) => ({
      schema_version: '1', operation_id: op, idempotency_key: idem, device_id: device,
      client_created_at: new Date().toISOString(), client_actor: 'validation', intent,
    });
    const apply = async (request) => (await asAuthenticated(
      `select public.lmm_apply_operation($1::jsonb) as result`, [JSON.stringify(request)]))[0].result;
    const item = (order, itemUuid) => ({
      item_uuid: itemUuid, item_type: 'inventory', inventory_uuid: inv,
      name: 'Cerveza', unit_price: '80', qty: '2',
    });
    const saleIntent = (order, itemUuid, auth = null, extra = {}) => ({
      kind: 'sale', entity_type: 'order', entity_uuid: order, expected_version: 0,
      snapshot: { origin: 'validation' }, items: [item(order, itemUuid)],
      ...(auth ? { authorization_id: auth } : {}), ...extra,
    });
    const stock = async () => Number(await scalar(db,
      `select stock from lmm.inventory where restaurant_id=$1::uuid and inventory_uuid=$2::uuid`, [rid, inv]));

    let op1, order1, result1;
    await check('C-01: operación aplicada y estado final persistido por clave', async () => {
      op1 = crypto.randomUUID(); order1 = crypto.randomUUID();
      const itemUuid = crypto.randomUUID();
      result1 = await apply(envelope(op1, 'idem-c01-' + op1.slice(0, 8), saleIntent(order1, itemUuid)));
      assert.equal(result1.operation_status, 'applied');
      assert.equal(await stock(), 8);

      const replay = await apply(envelope(op1, 'idem-c01-' + op1.slice(0, 8), saleIntent(order1, itemUuid)));
      assert.equal(replay.replayed, true);
      assert.equal(replay.event_seq, result1.event_seq);
      assert.equal(await stock(), 8);
      assert.equal(await scalar(db, `select count(*)::int from lmm.operations where restaurant_id=$1::uuid and operation_id=$2::uuid`, [rid, op1]), 1);
      assert.equal(await scalar(db, `select count(*)::int from lmm.sync_events where restaurant_id=$1::uuid and operation_id=$2::uuid`, [rid, op1]), 1);
    });

    await check('A-01: misma idempotency_key con otra operation_id deduplica sin reaplicar', async () => {
      const op = crypto.randomUUID();
      const res = await apply(envelope(op, 'idem-c01-' + op1.slice(0, 8), saleIntent(order1, result1.order.items[0].item_uuid)));
      assert.equal(res.replayed, true);
      assert.equal(res.deduplicated_of, op1);
      assert.equal(await stock(), 8);
    });

    await check('A-02: idempotency_key ausente y clave de sobre desconocida => PT422', async () => {
      const req = envelope(crypto.randomUUID(), null, saleIntent(crypto.randomUUID(), crypto.randomUUID()));
      delete req.idempotency_key;
      await throwsCode(db, `select public.lmm_apply_operation($1::jsonb)`, [JSON.stringify(req)], 'PT422');
      const extra = envelope(crypto.randomUUID(), 'idem-a02-' + crypto.randomUUID().slice(0, 8), saleIntent(crypto.randomUUID(), crypto.randomUUID()));
      extra.restaurant_id = rid;      // el cliente NO puede elegir restaurante
      await throwsCode(db, `select public.lmm_apply_operation($1::jsonb)`, [JSON.stringify(extra)], 'PT422');
    });

    await check('C-04: item_uuid de otro pedido se rechaza con PT409', async () => {
      const op = crypto.randomUUID();
      const otherOrder = crypto.randomUUID();
      const req = envelope(op, 'idem-c04-' + op.slice(0, 8), saleIntent(otherOrder, result1.order.items[0].item_uuid));
      await throwsCode(db, `select public.lmm_apply_operation($1::jsonb)`, [JSON.stringify(req)], 'PT409');
      assert.equal(await stock(), 8);
    });

    await check('C-02: devolución independiente con source_operation_id', async () => {
      const op = crypto.randomUUID();
      const intent = {
        kind: 'return', entity_type: 'order', entity_uuid: order1,
        // line_id identifica el NUEVO movimiento de devolución; source_operation_id
        // apunta a la venta original (C-02). Reutilizar el line_id de la venta
        // sería un conflicto legítimo (assert_lines_free).
        lines: [{ line_id: crypto.randomUUID(), inventory_uuid: inv, source_operation_id: op1, qty: '1' }],
      };
      const res = await apply(envelope(op, 'idem-c02-' + op.slice(0, 8), intent));
      assert.equal(res.operation_status, 'applied');
      assert.equal(await stock(), 9);
      const src = await scalar(db,
        `select count(*)::int from lmm.stock_movements where restaurant_id=$1::uuid and source_operation_id=$2::uuid and kind='return'`, [rid, op1]);
      assert.equal(src, 1);
    });

    await check('C-03: cursor de eventos, ACK y resync_required tras purga', async () => {
      const authAdj = (await asAuthenticated(
        `select public.lmm_issue_authorization($1::jsonb) as result`, [JSON.stringify({
          device_id: device, scope: 'adjustment', inventory_uuid: inv,
          approver_membership_id: member, pin: '0000', offline_voucher: false,
        })]))[0].result;
      assert.equal(authAdj.status, 'issued');
      const before = await apply(envelope(crypto.randomUUID(), 'idem-c03-' + crypto.randomUUID().slice(0, 8), {
        kind: 'adjust_in', entity_type: 'inventory', entity_uuid: inv, qty: '1',
        reason_code: 'count_correction', reason_text: 'Conteo aislado',
        authorization_id: authAdj.authorization_id,
      }));
      assert.equal(before.operation_status, 'applied');
      const ev = (await asAuthenticated(
        `select public.lmm_get_events($1::uuid, $2::bigint, 100, $3::bigint) as result`,
        [device, 0, before.event_seq]))[0];
      assert.equal(ev.result.status, 'ok');
      assert.ok(ev.result.events.length >= 3);
      assert.equal(Number(await scalar(db, `select last_ack_seq from lmm.devices where device_id=$1::uuid`, [device])), before.event_seq);

      // purge_events exige que TODOS los dispositivos activos hayan confirmado.
      await db.query(`update lmm.devices set last_ack_seq=$2::bigint where device_id=$1::uuid`, [otherDevice, before.event_seq]);
      const purged = await scalar(db, `select lmm.purge_events($1::uuid, 0)::int`, [rid]);
      assert.ok(purged >= 1);
      const resync = (await asAuthenticated(
        `select public.lmm_get_events($1::uuid, $2::bigint, 100, null::bigint) as result`, [device, 0]))[0];
      assert.equal(resync.result.status, 'resync_required');
      assert.ok(resync.result.min_retained_seq > 0);
    });

    // ── Autorizaciones: A-03 y A-04 (se emiten como dispositivo enrolado) ────
    const issueRequest = (extra) => JSON.stringify({
      device_id: device, scope: 'negative_stock', approver_membership_id: member,
      pin: '0000', offline_voucher: true, ttl_minutes: 720, ...extra,
    });
    const issue = async (extra) => (await asAuthenticated(
      `select public.lmm_issue_authorization($1::jsonb) as result`, [issueRequest(extra)]))[0].result;

    await check('A-04: vales limitados a 5 por dispositivo; el sexto se rechaza', async () => {
      for (let i = 0; i < 5; i++) {
        assert.equal((await issue({})).status, 'issued');
      }
      const sixth = await issue({});
      assert.equal(sixth.reject_code, 'offline_voucher_limit');
      assert.equal(await scalar(db,
        `select count(*)::int from lmm.stock_authorizations
          where issued_to_device_id=$1::uuid and offline_grace and status='active'`, [device]), 5);
      // Libera un cupo para las pruebas siguientes sin borrar filas (consumo auditado).
      await db.query(`update lmm.stock_authorizations
                         set status='consumed', consumed_by_operation_id=$2::uuid, consumed_at=now()
                       where authorization_id=(select authorization_id from lmm.stock_authorizations
                         where issued_to_device_id=$1::uuid and offline_grace limit 1)`, [device, crypto.randomUUID()]);
    });

    await check('A-03: la gracia de 48 h es SOLO para vales offline', async () => {
      const online = await issue({ offline_voucher: false });   // se limita a 60 min
      assert.equal(online.status, 'issued', JSON.stringify(online));
      const mins = await scalar(db,
        `select extract(epoch from (valid_until - now()))/60 from lmm.stock_authorizations where authorization_id=$1::uuid`,
        [online.authorization_id]);
      assert.ok(Number(mins) <= 60.01, `TTL online ${mins} min > 60`);

      // Vale caducado hace 1 h: online vence; offline sigue vigente por la gracia.
      await db.query(`update lmm.stock_authorizations set valid_until = now() - interval '1 hour'
                      where authorization_id=$1::uuid`, [online.authorization_id]);
      const offline = await issue({ offline_voucher: true });
      assert.equal(offline.status, 'issued');
      await db.query(`update lmm.stock_authorizations set valid_until = now() - interval '1 hour' where authorization_id=$1::uuid`, [offline.authorization_id]);

      const cOnline = await row(db, `select * from lmm.check_authorization($1::uuid,$2::uuid,$3::uuid,'negative_stock',null::uuid,null::uuid,null::numeric) c`,
        [rid, device, online.authorization_id]);
      assert.equal(cOnline.ok, false);
      assert.equal(cOnline.reason, 'expired');
      const cOffline = await row(db, `select * from lmm.check_authorization($1::uuid,$2::uuid,$3::uuid,'negative_stock',null::uuid,null::uuid,null::numeric) c`,
        [rid, device, offline.authorization_id]);
      assert.equal(cOffline.ok, true);
    });

    await check('A-04: device binding, scope y revocación se verifican en servidor', async () => {
      const issued = (await asAuthenticated(
        `select public.lmm_issue_authorization($1::jsonb) as result`, [JSON.stringify({
          device_id: device, scope: 'adjustment', inventory_uuid: inv, approver_membership_id: member,
          pin: '0000', offline_voucher: false,
        })]))[0].result;
      assert.equal(issued.status, 'issued');
      const aid = issued.authorization_id;
      const checkAuth = (dev, scope, invUuid) => row(db,
        `select * from lmm.check_authorization($1::uuid,$2::uuid,$3::uuid,$4::text,null::uuid,$5::uuid,'1'::numeric) c`,
        [rid, dev, aid, scope, invUuid]);

      assert.equal((await checkAuth(device, 'adjustment', inv)).ok, true);
      assert.equal((await checkAuth(otherDevice, 'adjustment', inv)).reason, 'wrong_device');
      assert.equal((await checkAuth(device, 'negative_stock', null)).reason, 'wrong_scope');
      await db.query(`update lmm.stock_authorizations set status='revoked' where authorization_id=$1::uuid`, [aid]);
      assert.equal((await checkAuth(device, 'adjustment', inv)).reason, 'revoked');
    });

    await check('Permisos: solo authenticated ejecuta RPC; migrate_open_order no expuesto', async () => {
      const grants = await rows(db, `
        select p.proname,
               has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_ok,
               has_function_privilege('anon', p.oid, 'EXECUTE') as anon_ok
          from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname like 'lmm_%'`, []);
      const byName = Object.fromEntries(grants.map((g) => [g.proname, g]));
      for (const name of ['lmm_apply_operation', 'lmm_get_events', 'lmm_get_snapshot',
                          'lmm_issue_authorization', 'lmm_enroll_device', 'lmm_revoke_device']) {
        assert.equal(byName[name] && byName[name].auth_ok, true, `${name} no ejecutable por authenticated`);
        assert.equal(byName[name] && byName[name].anon_ok, false, `${name} ejecutable por anon`);
      }
      assert.equal(await scalar(db,
        `select has_function_privilege('authenticated', 'lmm.migrate_open_order(uuid,uuid,jsonb)', 'EXECUTE')`), false);
      const rls = await scalar(db,
        `select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='lmm' and c.relkind='r' and not c.relrowsecurity`);
      assert.equal(rls, 0, `${rls} tablas lmm sin RLS`);
    });

    await check('Autenticación: anon no puede invocar la RPC (42501/PT401)', async () => {
      await db.exec(`set role anon`);
      try {
        await throwsCode(db, `select public.lmm_get_snapshot($1::uuid)`, [device], '42501|PT401');
      } finally {
        await db.exec('reset role');
      }
    });

    await check('Concurrencia lógica: dos cierres del mismo operation_id no duplican efecto', async () => {
      const auth = (await asAuthenticated(
        `select public.lmm_issue_authorization($1::jsonb) as result`, [JSON.stringify({
          device_id: device, scope: 'adjustment', inventory_uuid: inv,
          approver_membership_id: member, pin: '0000', offline_voucher: false,
        })]))[0].result;
      assert.equal(auth.status, 'issued', JSON.stringify(auth));
      const op = crypto.randomUUID();
      const intent = {
        kind: 'adjust_out', entity_type: 'inventory', entity_uuid: inv, qty: '1',
        reason_code: 'damage', reason_text: 'Dano aislado', authorization_id: auth.authorization_id,
      };
      const req = envelope(op, 'idem-conc-' + op.slice(0, 8), intent);
      const s0 = await stock();
      // PGlite no ofrece sesiones paralelas: se simula la carrera con dos
      // cierres consecutivos del mismo operation_id sobre la misma conexión.
      const a = await asAuthenticated(`select public.lmm_apply_operation($1::jsonb) as result`, [JSON.stringify(req)]);
      const b = await asAuthenticated(`select public.lmm_apply_operation($1::jsonb) as result`, [JSON.stringify(req)]);
      assert.equal(a[0].result.operation_status, 'applied');
      assert.equal(b[0].result.replayed, true);
      assert.equal(await stock(), s0 - 1);
    });

    console.log(`\nResultado: ${checks.filter((c) => c.ok).length}/${checks.length} comprobaciones PASS`);
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error('\nVALIDACIÓN SQL FALLIDA: ' + e.message);
  process.exitCode = 1;
});
