'use strict';
/**
 * JSON canónico (V8 §7.4): claves ordenadas por bytes UTF-8, sin espacios,
 * solo enteros como números (cantidades y dinero viajan como string).
 * Debe producir exactamente los mismos bytes que lmm.canonical_json en PostgreSQL.
 */
const crypto = require('crypto');

function canonicalJson(x) {
  if (x === null) return 'null';
  if (Array.isArray(x)) return '[' + x.map(canonicalJson).join(',') + ']';
  switch (typeof x) {
    case 'string': return JSON.stringify(x);
    case 'boolean': return x ? 'true' : 'false';
    case 'number':
      if (!Number.isInteger(x)) throw new Error('canonicalJson: número no entero prohibido (use string decimal)');
      return String(x);
    case 'object': {
      const keys = Object.keys(x).filter((k) => x[k] !== undefined)
        .sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(x[k])).join(',') + '}';
    }
    default: throw new Error('canonicalJson: tipo no soportado: ' + typeof x);
  }
}

function sha256Hex(text) { return crypto.createHash('sha256').update(text, 'utf8').digest('hex'); }
function intentHash(intent) { return sha256Hex(canonicalJson(intent)); }

module.exports = { canonicalJson, sha256Hex, intentHash };
