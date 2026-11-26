'use strict';
/**
 * Regla comercial de venta (V8 §10.1). Función PURA, en milésimas.
 * El servidor implementa lo mismo en lmm.apply_sale_line; esta versión
 * solo sirve para el cálculo PROVISIONAL local. Si difieren, manda el servidor.
 */
function computeSaleEffect(stockMilli, qtyMilli, authorized) {
  if (!Number.isInteger(stockMilli) || !Number.isInteger(qtyMilli) || qtyMilli <= 0) {
    throw new Error('computeSaleEffect: argumentos inválidos');
  }
  const available = Math.max(stockMilli, 0);                 // un saldo negativo nunca es disponible
  const shortage = Math.max(qtyMilli - available, 0);        // faltante, con o sin autorización
  const applied = authorized ? qtyMilli : Math.min(qtyMilli, available);
  return { available, shortage, applied, delta: 0 - applied, after: stockMilli - applied };
}

module.exports = { computeSaleEffect };
