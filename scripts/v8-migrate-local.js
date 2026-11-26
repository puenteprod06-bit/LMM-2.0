#!/usr/bin/env node
'use strict';
/**
 * CLI de migración local V8 (§17). SOLO sobre una COPIA descartable.
 *
 * Uso:
 *   node scripts/v8-migrate-local.js analyze   --db <copia.sqlite> [--input datos.json]
 *   node scripts/v8-migrate-local.js validate  --db <copia.sqlite> --input datos.json
 *   node scripts/v8-migrate-local.js apply     --db <copia.sqlite> --input datos.json --confirm --backup-verified
 *   node scripts/v8-migrate-local.js rollback  --db <copia.sqlite> --run <id> --remote-untouched --confirm
 *
 * datos.json = { remoteBalances: {uuid: valor}, deviceReports: [{device_id, balances:{uuid: valor}}],
 *                 decisions: {uuid: valor}, notes?: string }
 *
 * NUNCA acepta la BD real del POS: la ruta se compara contra los directorios
 * conocidos y contra `--db` sin `--copy-confirmed` (que obliga a declarar que
 * es una copia). No contacta Supabase.
 */
const fs = require('fs');
const path = require('path');
const migration = require('../services/inventory-sync-v8/migration');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (['confirm', 'backup-verified', 'remote-untouched', 'copy-confirmed'].includes(key)) {
      out[key] = true;
    } else {
      out[key] = argv[++i];
      if (out[key] === undefined) throw new Error(`falta valor para --${key}`);
    }
  }
  return out;
}

function openDb(file) {
  // better-sqlite3 suele estar compilado para el Node de Electron (ABI 130);
  // si este Node tiene otra ABI se cae al SQLite embebido de Node 22.
  try {
    const Database = require('better-sqlite3');
    return new Database(file);
  } catch (_) {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(file);
  }
}

function assertSafeCopy(file, args) {
  const resolved = path.resolve(file);
  const normalized = resolved.toLowerCase();
  const forbidden = [
    path.join('AppData', 'Roaming', 'la-mente-maestra').toLowerCase(),
    path.join('la-mente-maestra', 'database.sqlite').toLowerCase(),
    'database.sqlite',
  ];
  if (forbidden.some((p) => normalized.includes(p))) {
    throw new Error('RUTA REAL RECHAZADA: usa una copia en directorio temporal (' + resolved + ')');
  }
  if (!args['copy-confirmed']) {
    throw new Error('falta --copy-confirmed: declara explícitamente que --db es una COPIA descartable');
  }
  return resolved;
}

function readInput(args) {
  if (!args.input) return {};
  const raw = fs.readFileSync(path.resolve(args.input), 'utf8');
  return JSON.parse(raw);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!['analyze', 'validate', 'apply', 'rollback'].includes(command)) {
    throw new Error('comando inválido: usa analyze | validate | apply | rollback');
  }
  if (!args.db) throw new Error('falta --db <copia.sqlite>');
  const file = assertSafeCopy(args.db, args);
  const input = readInput(args);
  const db = openDb(file);
  try {
    let result;
    if (command === 'analyze') {
      result = migration.analyze(db, input);
    } else if (command === 'validate') {
      result = migration.validate(db, { ...input, backupVerified: !!args['backup-verified'] });
    } else if (command === 'apply') {
      if (!args.confirm) throw new Error('falta --confirm para aplicar');
      if (!args['backup-verified']) throw new Error('falta --backup-verified para aplicar');
      result = migration.apply(db, { ...input, backupVerified: true });
    } else {
      if (!args.confirm) throw new Error('falta --confirm para revertir');
      if (!args['remote-untouched']) throw new Error('falta --remote-untouched: el rollback solo es seguro antes de la primera operación remota aplicada');
      result = migration.rollback(db, {
        runId: Number(args.run), remoteUntouched: true, notes: input.notes || null,
      });
    }
    console.log(JSON.stringify(result, null, 2));
    if (command === 'validate' && !result.ok) process.exitCode = 2;
  } finally {
    db.close();
  }
}

try { main(); }
catch (err) { console.error('ERROR: ' + err.message); process.exitCode = 1; }
