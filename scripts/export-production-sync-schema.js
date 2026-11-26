#!/usr/bin/env node
'use strict';
/**
 * Exporta (SOLO LECTURA) el esquema sync_* del Supabase PRODUCTIVO.
 * Nunca escribe, nunca aplica migraciones y nunca imprime credenciales.
 *
 * Uso:
 *   1) Crear .env.production-readonly (ignorado por Git) con:
 *      DATABASE_URL=postgresql://<usuario_solo_lectura>:<pwd>@<host>:5432/postgres
 *   2) node scripts/export-production-sync-schema.js --confirm-readonly
 *
 * Salidas: docs/PRODUCTION_SYNC_SCHEMA.sql y docs/PRODUCTION_SYNC_SCHEMA.json
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({
  path: path.join(__dirname, '..', '.env.production-readonly'),
  override: true,
});

const ROOT = path.resolve(__dirname, '..');
const SQL_OUT = path.join(ROOT, 'docs', 'PRODUCTION_SYNC_SCHEMA.sql');
const JSON_OUT = path.join(ROOT, 'docs', 'PRODUCTION_SYNC_SCHEMA.json');

function guard() {
  if (!process.argv.includes('--confirm-readonly')) {
    throw new Error('falta --confirm-readonly: confirma que SOLO se leerá el catálogo de producción');
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('falta DATABASE_URL en .env.production-readonly');
  }
  if (/\/\[YOUR-|<PASSWORD|TU_PASSWORD/i.test(process.env.DATABASE_URL)) {
    throw new Error('DATABASE_URL parece ser una plantilla; rellénala en .env.production-readonly');
  }
}

async function main() {
  guard();
  const { Client } = require('pg');
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
    query_timeout: 120000,
  });
  await client.connect();
  try {
    // Defensa en profundidad: aunque el rol tuviera permisos de escritura,
    // esta sesión no puede ejecutar INSERT/UPDATE/DELETE/DDL.
    await client.query(`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`);
    const ro = await client.query(`show transaction_read_only`);
    if (ro.rows[0].transaction_read_only !== 'on') {
      throw new Error('la sesión no quedó en modo solo lectura; abortando');
    }

    const tablesRes = await client.query(`
      select table_schema, table_name
        from information_schema.tables
       where table_schema not in ('pg_catalog','information_schema')
         and table_name like 'sync%'
       order by 1,2`);
    const tables = tablesRes.rows;
    const lines = [
      '-- Esquema sync_* exportado de Supabase PRODUCCIÓN (solo lectura).',
      '-- Generado por scripts/export-production-sync-schema.js. NO aplicar directamente.',
      '-- Fecha: ' + new Date().toISOString(),
      '',
    ];
    const inventory = { exported_at: new Date().toISOString(), tables: [], related_functions: [] };

    for (const t of tables) {
      const qname = `"${t.table_schema}"."${t.table_name}"`;
      inventory.tables.push({ schema: t.table_schema, name: t.table_name });
      lines.push(`-- ===== ${qname} =====`);
      const cols = await client.query(`
        select column_name, data_type, character_maximum_length, numeric_precision, numeric_scale,
               is_nullable, column_default, identity_generation
          from information_schema.columns
         where table_schema=$1 and table_name=$2
         order by ordinal_position`, [t.table_schema, t.table_name]);
      const defs = cols.rows.map((c) => {
        let typ = c.data_type;
        if (c.character_maximum_length) typ += `(${c.character_maximum_length})`;
        else if (c.numeric_precision != null) typ += `(${c.numeric_precision},${c.numeric_scale ?? 0})`;
        let d = `  "${c.column_name}" ${typ}`;
        if (c.is_nullable === 'NO') d += ' NOT NULL';
        if (c.identity_generation) d += ` GENERATED ${c.identity_generation}`;
        if (c.column_default && !c.identity_generation) d += ` DEFAULT ${c.column_default}`;
        return d;
      });
      const pk = await client.query(`
        select pg_get_constraintdef(c.oid) as def
          from pg_constraint c join pg_class r on r.oid=c.conrelid
          join pg_namespace n on n.oid=r.relnamespace
         where n.nspname=$1 and r.relname=$2 and c.contype='p'`, [t.table_schema, t.table_name]);
      if (pk.rows.length) defs.push('  CONSTRAINT "' + t.table_name + '_pkey" ' + pk.rows[0].def.replace(/^PRIMARY KEY\s*/i, 'PRIMARY KEY '));
      lines.push(`CREATE TABLE ${qname} (`, defs.join(',\n'), ');', '');

      const idx = await client.query(`
        select indexname, indexdef from pg_indexes
         where schemaname=$1 and tablename=$2 order by indexname`, [t.table_schema, t.table_name]);
      for (const i of idx.rows) {
        if (/PRIMARY KEY|UNIQUE INDEX/.test(i.indexdef)) continue;
        lines.push(i.indexdef + ';');
      }
      if (idx.rows.length) lines.push('');

      const cons = await client.query(`
        select conname, contype, pg_get_constraintdef(c.oid) as def
          from pg_constraint c join pg_class r on r.oid=c.conrelid
          join pg_namespace n on n.oid=r.relnamespace
         where n.nspname=$1 and r.relname=$2 and c.contype in ('f','u','c')
         order by conname`, [t.table_schema, t.table_name]);
      for (const c of cons.rows) {
        const kind = c.contype === 'f' ? 'FOREIGN KEY' : c.contype === 'u' ? 'UNIQUE' : 'CHECK';
        lines.push(`ALTER TABLE ${qname} ADD CONSTRAINT "${c.conname}" ${kind} ${c.def.replace(/^(FOREIGN KEY|UNIQUE|CHECK)\s*/i, '')};`);
      }
      if (cons.rows.length) lines.push('');

      const trg = await client.query(`
        select tgname, pg_get_triggerdef(t.oid) as def
          from pg_trigger t join pg_class r on r.oid=t.tgrelid
          join pg_namespace n on n.oid=r.relnamespace
         where n.nspname=$1 and r.relname=$2 and not t.tgisinternal
         order by tgname`, [t.table_schema, t.table_name]);
      for (const g of trg.rows) lines.push(g.def + ';');
      if (trg.rows.length) lines.push('');

      const cnt = await client.query(`select count(*)::int as n from ${qname}`);
      inventory.tables[inventory.tables.length - 1].row_count = cnt.rows[0].n;
    }

    const funcs = await client.query(`
      select n.nspname as schema, p.proname as name, p.oid::regprocedure as signature
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname not in ('pg_catalog','information_schema')
         and (p.proname ilike '%sync%' or p.prosrc ilike '%sync_%')
       order by 1,2`);
    for (const f of funcs.rows) {
      inventory.related_functions.push({ schema: f.schema, name: f.name, signature: f.signature });
    }
    lines.push('-- Funciones/triggers que referencian sync_* (inventario; NO se regenera el cuerpo):');
    for (const f of inventory.related_functions) lines.push('--   ' + f.signature);

    fs.mkdirSync(path.dirname(SQL_OUT), { recursive: true });
    fs.writeFileSync(SQL_OUT, lines.join('\n') + '\n', 'utf8');
    fs.writeFileSync(JSON_OUT, JSON.stringify(inventory, null, 2), 'utf8');
    console.log('SOLO LECTURA OK: ' + tables.length + ' tablas, ' +
      inventory.related_functions.length + ' funciones relacionadas');
    console.log('Esquema: ' + path.relative(ROOT, SQL_OUT));
    console.log('Inventario: ' + path.relative(ROOT, JSON_OUT));
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error('ERROR: ' + e.message); process.exitCode = 1; });
