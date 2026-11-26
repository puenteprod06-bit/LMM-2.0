'use strict';
/**
 * Cantidades decimales exactas (V8 §4.1 / §7.4).
 * Local: enteros en milésimas. Cable: strings decimales canónicos.
 * Nunca se usa Number para convertir cantidades que viajan al servidor.
 */
const QTY_RE = /^(0|[1-9][0-9]*)(\.[0-9]{0,2}[1-9])?$/;      // hasta 3 decimales, sin ceros finales
const MONEY_RE = /^(0|[1-9][0-9]*)(\.[0-9]?[1-9])?$/;         // hasta 2 decimales, sin ceros finales
const MAX_MILLI = 1000000 * 1000;                               // 1.000.000 unidades

function isCanonicalQty(s) { return typeof s === 'string' && QTY_RE.test(s); }
function isCanonicalMoney(s) { return typeof s === 'string' && MONEY_RE.test(s); }

/** "1.25" -> 1250 (Number entero). Lanza si no es canónico. Admite signo '-' solo si opts.signed. */
function toMilli(s, opts = {}) {
  let str = s;
  let neg = false;
  if (opts.signed && typeof str === 'string' && str.startsWith('-')) { neg = true; str = str.slice(1); }
  if (!isCanonicalQty(str)) throw new Error(`decimal no canónico: ${JSON.stringify(s)}`);
  const [i, f = ''] = str.split('.');
  const v = Number(i) * 1000 + Number((f + '000').slice(0, 3));
  if (!Number.isSafeInteger(v) || v > MAX_MILLI * 1000) throw new Error(`cantidad fuera de rango: ${s}`);
  return neg ? -v : v;
}

/** 1250 -> "1.25"; -3000 -> "-3"; 0 -> "0" */
function fromMilli(n) {
  if (!Number.isInteger(n)) throw new Error(`milésimas no entero: ${n}`);
  const neg = n < 0;
  const a = Math.abs(n);
  const i = Math.floor(a / 1000);
  const f = String(a % 1000).padStart(3, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + i + (f ? '.' + f : '');
}

/** Valor legado REAL (p.ej. 2.5) -> milésimas, redondeando a 3 decimales (solo para migración/bordes locales). */
function milliFromLegacyNumber(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000);
}

module.exports = { QTY_RE, MONEY_RE, isCanonicalQty, isCanonicalMoney, toMilli, fromMilli, milliFromLegacyNumber };
