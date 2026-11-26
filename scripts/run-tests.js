#!/usr/bin/env node
/**
 * run-tests.js
 * Ejecuta la suite de tests (jest) bajo el Node embebido de Electron.
 *
 * La app usa módulos nativos (better-sqlite3, bcrypt) compilados para el
 * runtime de Electron (ABI 130). Correr jest con el Node del sistema (p.ej.
 * v20 / ABI 115) falla al cargar esos módulos por incompatibilidad de ABI.
 *
 * Usando `ELECTRON_RUN_AS_NODE=1` se ejecuta jest con el mismo Node que usa
 * la app, así los tests corren contra la build de módulos ya instalada, sin
 * tener que recompilar nada y sin romper el arranque de Electron.
 *
 * Cross-platform: funciona igual en Windows (cmd) y Unix (sh), ya que aquí
 * se setea la variable de entorno desde Node en lugar de depender de la
 * sintaxis de cada shell.
 *
 * Uso: node scripts/run-tests.js [args de jest...]
 */

const { spawn } = require('child_process');
const path = require('path');

process.env.ELECTRON_RUN_AS_NODE = '1';

// Resuelve el binario de Electron local (evita depender del PATH)
function resolveElectronBin() {
  const candidates = [
    path.join(__dirname, '..', 'node_modules', 'electron', 'cli.js'),
    path.join(__dirname, '..', 'node_modules', '.bin', 'electron'),
  ];
  for (const c of candidates) {
    try {
      require.resolve(c);
      return require.resolve(c);
    } catch (_) { /* seguir probando */ }
  }
  throw new Error('No se encontró Electron en node_modules');
}

// Resuelve el binario de jest
function resolveJestBin() {
  const c = path.join(__dirname, '..', 'node_modules', 'jest', 'bin', 'jest.js');
  try {
    require.resolve(c);
    return require.resolve(c);
  } catch (_) {
    throw new Error('No se encontró jest en node_modules');
  }
}

const electronBin = resolveElectronBin();
const jestBin = resolveJestBin();
const extraArgs = process.argv.slice(2);

console.log(`🔬 [run-tests] Electron runtime: ${electronBin}`);
console.log(`🔬 [run-tests] jest: ${jestBin}`);
console.log(`🔬 [run-tests] args: ${extraArgs.join(' ') || '(defaults)'}`);

const child = spawn(process.execPath, [electronBin, jestBin, ...extraArgs], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  env: process.env,
});

child.on('error', (err) => {
  console.error('❌ [run-tests] Error al iniciar Electron:', err.message);
  process.exit(1);
});

child.on('close', (code) => {
  process.exit(code || 0);
});
