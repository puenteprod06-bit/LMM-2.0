#!/usr/bin/env node
'use strict';
/**
 * Aplica SOLO el SQL de esquema V8 al proyecto PRODUCTIVO indicado.
 *
 * NUNCA:
 *  - activa LMM_INVENTORY_SYNC_V8;
 *  - siembra datos sintéticos;
 *  - toca la SQLite del POS;
 *  - ejecuta reset/drop de esquemas.
 *
 * Uso:
 *   node scripts/apply-v8-production.js --confirm-production
 *
 * Lee exclusivamente .env.production-readonly (ignorado por Git) y exige que
 * DATABASE_URL y SUPABASE_URL apunten al ref autorizado. No imprime secretos.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({
  path: path.join(__dirname, '..', '.env.production-readonly'),
  override: true,
});

const ROOT = path.resolve(__dirname, '..');
const SQL_FILE = path.join(ROOT, 'supabase', 'migrations', '20261123000000_lmm_inventory_sync_v8.sql');
const EXPECTED_REF = 'fxkxfidvdzpqqsmktxoq';

function guard() {
  const argv = process.argv.slice(2);
  if (!argv.includes('--confirm-production')) {
    throw new Error('falta --confirm-production: confirma explícitamente la escritura en PRODUCCIÓN');
  }
  if (argv.some((a) => /^--(reset|reset-throwaway|force-reapply|seed)/i.test(a))) {
    throw new Error('producción nunca se resetea ni se siembra; opción no permitida');
  }
  if (!process.env.DATABASE_URL || !process.env.SUPABASE_URL) {
    throw new Error('faltan DATABASE_URL o SUPABASE_URL en .env.production-readonly');
  }
  let apiRef, dbRef;
  try {
    apiRef = new URL(process.env.SUPABASE_URL).hostname.match(/^([a-z0-9]+)\.supabase\.co$/i)?.[1];
    const u = new URL(process.env.DATABASE_URL);
    dbRef = u.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/i)?.[1] ||
      decodeURIComponent(u.username).match(/^postgres\.([a-z0-9]+)$/i)?.[1];
  } catch (_) { /* se reporta abajo */ }
  if (apiRef !== EXPECTED_REF || dbRef !== EXPECTED_REF) {
    throw new Error(`ref de producción no autorizado: api=${apiRef || '?'} db=${dbRef || '?'}; esperado=${EXPECTED_REF}`);
  }
}

async function main() {
  guard();
  const { Client } = require('pg');
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
    query_timeout: 300000,
  });
  await client.connect();
  try {
    const exists = await client.query(`select to_regclass('lmm.app_config') as oid`);
    if (exists.rows[0].oid) {
      throw new Error('el esquema lmm ya existe en producción; abortando (no se reaplica)');
    }
    const sql = fs.readFileSync(SQL_FILE, 'utf8');
    const started = Date.now();
    await client.query('BEGIN');
    try {
      await client.query(sql);
      const counts = await client.query(`
        select
          (select count(*)::int from information_schema.tables where table_schema='lmm') as tables,
          (select count(*)::int from information_schema.routines where routine_schema='lmm') as functions,
          (select pg_class.relrowsecurity::int from pg_class join pg_namespace n on n.oid=pg_class.relnamespace
             where n.nspname='lmm' and pg_class.relname='app_config' limit 1) as app_config_rls
      `);
      await client.query('COMMIT');
      const result = {
        applied_at: new Date().toISOString(),
        command: 'apply-production-schema-only',
        project_url: process.env.SUPABASE_URL,
        expected_ref: EXPECTED_REF,
        applied: true,
        elapsed_ms: Date.now() - started,
        counts: counts.rows[0],
        flag: 'LMM_INVENTORY_SYNC_V8 no tocado (permanece 0)',
        data_seeded: false,
        pos_sqlite_touched: false,
      };
      const outArg = process.argv.indexOf('--out');
      const outFile = outArg >= 0
        ? path.resolve(process.cwd(), process.argv[outArg + 1] || '')
        : path.join(ROOT, 'docs', 'V8_PRODUCTION_SCHEMA_RESULT.json');
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n', 'utf8');
      console.log('SCHEMA PRODUCCIÓN APLICADO: tablas=' + result.counts.tables +
        ', funciones=' + result.counts.functions + ', RLS app_config=' + result.counts.app_config_rls);
      console.log('Resultado: ' + path.relative(ROOT, outFile));
      console.log('Flag V8: SIN TOCAR (0). SQLite del POS: SIN TOCAR. Datos sembrados: NO.');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error('ERROR: ' + e.message); process.exitCode = 1; });
