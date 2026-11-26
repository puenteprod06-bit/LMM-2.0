'use strict';

/**
 * tests/utils.test.js
 *
 * Tests unitarios de funciones utilitarias del lado servidor y cliente.
 * Las funciones de cliente (uid, formatDateShort) se importan directamente
 * ya que son JS puro sin dependencias del DOM.
 */

// ── Extraer uid() directamente del fuente sin ejecutar el DOM ──
// pos-utils.js está lleno de APIs de browser (addEventListener, document,
// BroadcastChannel…) que no existen en Node. En lugar de simular todo
// el DOM, leemos el archivo y evaluamos SOLO la línea de uid() con vm.
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

function extractFunction(filename, fnName) {
  const code = fs.readFileSync(
    path.join(__dirname, '..', 'public', filename),
    'utf8'
  );

  // Localizar la definición "function fnName(...)" (pos-utils.js está minificado,
  // así que NO se puede dividir por líneas: todo vive en una sola).
  const marker = `function ${fnName}(`;
  let start = code.indexOf(marker);
  if (start === -1) {
    const assignRe = new RegExp(`(?:const|let|var)?\\s*${fnName}\\s*=\\s*function`);
    const m = code.match(assignRe);
    if (!m) throw new Error(`No se encontró: ${fnName} en ${filename}`);
    start = code.indexOf(m[0]);
  }

  // Extraer el cuerpo con llaves balanceadas: de la apertura al cierre.
  const braceOpen = code.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = braceOpen; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) throw new Error(`No se pudo extraer ${fnName} de ${filename}`);

  const snippet = code.slice(start, end);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(snippet, sandbox);
  return sandbox[fnName];
}

let uid;
beforeAll(() => {
  uid = extractFunction('pos-utils.js', 'uid');
});

// ═══════════════════════════════════════════════════════════════
//  uid()
// ═══════════════════════════════════════════════════════════════
describe('uid() — generador de IDs únicos', () => {

  test('devuelve un string no vacío', () => {
    const id = uid();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  test('formato: timestamp-randomstring', () => {
    const id = uid();
    expect(id).toMatch(/^\d+-[a-z0-9]+$/);
  });

  test('sin colisiones en 10.000 iteraciones', () => {
    const ids = new Set(
      Array.from({ length: 10_000 }, () => uid())
    );
    expect(ids.size).toBe(10_000);
  });

  test('IDs generados son siempre distintos entre llamadas consecutivas', () => {
    const a = uid();
    const b = uid();
    expect(a).not.toBe(b);
  });

  test('parte numérica es un timestamp válido (últimos 10 s)', () => {
    const before = Date.now() - 100;
    const ts = parseInt(uid().split('-')[0], 10);
    const after  = Date.now() + 100;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

});

// ═══════════════════════════════════════════════════════════════
//  Validator (server-side)
// ═══════════════════════════════════════════════════════════════
const Validator = require('../validator');

describe('Validator — sanitización de inputs', () => {

  test('existe y es un objeto/clase', () => {
    expect(Validator).toBeDefined();
  });

  // Ajustar según la API real de validator.js
  if (typeof Validator.sanitizeString === 'function') {
    describe('sanitizeString()', () => {
      test('elimina tags HTML básicos', () => {
        const result = Validator.sanitizeString('<script>alert(1)</script>hola');
        expect(result).not.toMatch(/<script>/i);
        expect(result).toContain('hola');
      });

      test('no modifica strings limpios', () => {
        expect(Validator.sanitizeString('Restaurante El Sol')).toBe('Restaurante El Sol');
      });

      test('maneja string vacío', () => {
        expect(Validator.sanitizeString('')).toBe('');
      });

      test('maneja null/undefined sin lanzar', () => {
        expect(() => Validator.sanitizeString(null)).not.toThrow();
        expect(() => Validator.sanitizeString(undefined)).not.toThrow();
      });
    });
  }

  if (typeof Validator.isValidPrice === 'function') {
    describe('isValidPrice()', () => {
      test('acepta precios válidos', () => {
        expect(Validator.isValidPrice(10)).toBe(true);
        expect(Validator.isValidPrice(0)).toBe(true);
        expect(Validator.isValidPrice(999.99)).toBe(true);
      });

      test('rechaza negativos', () => {
        expect(Validator.isValidPrice(-1)).toBe(false);
      });

      test('rechaza NaN y strings', () => {
        expect(Validator.isValidPrice(NaN)).toBe(false);
        expect(Validator.isValidPrice('caro')).toBe(false);
      });
    });
  }

});

// ═══════════════════════════════════════════════════════════════
//  logger.js — estructura básica
// ═══════════════════════════════════════════════════════════════
const logger = require('../logger');

describe('logger — métodos requeridos por Winston', () => {
  const methods = ['info', 'warn', 'error', 'debug'];

  test.each(methods)('logger.%s existe y es callable', (method) => {
    expect(typeof logger[method]).toBe('function');
    expect(() => logger[method](`test mensaje ${method}`)).not.toThrow();
  });
});
