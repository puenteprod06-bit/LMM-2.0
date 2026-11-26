# INVENTORY_INTEGRITY_PHASE_2B3_1_HARDENING_REPORT.md

## Fase 2B.3.1 — Hardening de Reconciliación de Stock e Idempotencia

**Fecha:** 19/11/2026
**Estado:** APROBADO — todas las pruebas pasan

---

## 1. Diagnóstico

### Riesgo 1: Cantidades efectivamente descontadas

La implementación original de Fase 2B.3 usaba:

```
diff = newQty - prevQty
```

Esto asumía que la cantidad pedida equivalía a la cantidad descontada. Pero cuando hay faltantes, la cantidad descontada es menor que la pedida.

**Ejemplo:**
- Stock inicial: 5
- Pedido original: 8 (sin auth)
- Stock descontado: 5, faltante: 3, stock final: 0
- Modificar pedido de 8 a 4
- Reintegro incorrecto (diff): 8 - 4 = 4 → stock final 4 (INCORRECTO)
- Reintegro correcto: 5 - min(4, 5) = 1 → stock final 1 (CORRECTO)

### Riesgo 2: Idempotencia de movimientos

Los UUID determinísticos se generaban con keys basadas en `(orderId, invId, diff/qty)`. Dos operaciones distintas con el mismo diff producían el mismo UUID, causando que `INSERT OR IGNORE` descartara movimientos válidos.

**Ejemplo de colisión:**
- Modificación A: 3 → 5 (diff +2) → key `...-sale-inv-2`
- Modificación B: 1 → 3 (diff +2) → key `...-sale-inv-2` → COLISIÓN → movimiento B descartado

---

## 2. Causa raíz

1. **Cantidades:** `order_items.qty` almacena la cantidad pedida, no la efectivamente descontada. No se reconstruía la cantidad real a partir de `stock_movements`.
2. **Idempotencia:** Las keys no incluían un identificador de operación, solo la transición numérica.

---

## 3. Algoritmo corregido

### Reconciliación híbrida

Para cada `invId` que participa (anterior o nuevo):

1. **Reconstruir cantidad efectivamente descontada:**
   ```
   effectivePrev = SUM(sale) - SUM(return)  [de stock_movements para este pedido+producto]
   ```

2. **Reducción (newQty < prevQty):**
   ```
   returnQty = effectivePrev - min(newQty, effectivePrev)
   ```
   - Reintegra `returnQty` al stock.
   - Registra movimiento `return`.
   - Sin re-evaluar autorización (solo se devuelve stock).

3. **Aumento (newQty > prevQty):**
   ```
   increaseQty = newQty - prevQty
   ```
   - Aplica `increaseQty` con reglas de autorización (descuento disponible + faltante).
   - Registra movimientos `sale`/`shortage`.

4. **Sin cambio (newQty == prevQty):** no-op.

### Cobertura de faltantes

- Si se pidió 8 con stock 5 (eff=5, faltante 3) y se reduce a 4:
  - returnQty = 5 - min(4, 5) = 5 - 4 = 1
  - Stock: 0 + 1 = 1 ✓

- Si se pidió 8 con stock 5 y se reduce a 6 (aún > 5):
  - returnQty = 5 - min(6, 5) = 5 - 5 = 0
  - Stock: 0 (sin cambio) ✓

- Si se pidió 8 con auth (eff=8, stock -3) y se reduce a 6:
  - returnQty = 8 - min(6, 8) = 8 - 6 = 2
  - Stock: -3 + 2 = -1 ✓

---

## 4. Estrategia de idempotencia

### Identificador de operación

Se lee `orders.updatedAt` (o `createdAt` si null) ANTES de la modificación:
```
orderStateId = existing.updatedAt || existing.createdAt || 0
```

Este valor representa el estado de la orden ANTES de esta operación.

### Keys de idempotencia

Todas las keys incluyen `orderStateId`:
- Return: `order-{orderId}-modify-{orderStateId}-return-{invId}-{returnQty}`
- Sale: `order-{orderId}-modify-{orderStateId}-sale-{invId}-{increaseQty}`
- Shortage: `order-{orderId}-modify-{orderStateId}-shortage-{invId}-{shortage}`

### Propiedades

1. **Reintento exacto:** Si se re-envía la misma modificación, `orderStateId` es el mismo (no se modificó la orden porque el primer intento falló o la orden ya está en el estado target). Pero si el primer intento tuvo éxito, la orden ya tiene los nuevos items, así que `prevQtyByInv == newQtyByInv` → todos los diffs son 0 → no-op. ✓

2. **Operación legítima nueva:** `orderStateId` cambió (porque la modificación anterior actualizó `updatedAt`), así que la key es nueva → movimiento registrado. ✓

3. **Volver a cantidad anterior:** La transición es diferente (5→3 vs 3→5), y `orderStateId` es diferente → no hay colisión. ✓

4. **Rollback:** Todo dentro de `db._native.transaction()`. Si falla, no se persiste ni stock ni movimientos. ✓

---

## 5. Archivos modificados

### `routes/orders.js`
- `modify-items`: 
  - Lectura de `existing.updatedAt/createdAt` para `orderStateId`.
  - Reconciliación híbrida (effectivePrev + reducción/aumento).
  - Keys de idempotencia con `orderStateId`.

### `tests/inventory-modify-items.test.js`
- 21 tests (15 originales + 6 nuevos).
- Nuevos: faltante+eliminación, faltante+aumento, auth+eliminación, sucesiva 3→5→3→5, dos mods iguales finales, consistencia.

### Backup
- `scripts/backups/phase-2b3-20261119/routes/orders.js.bak` (del 2B.3 original)

---

## 6. Casos de prueba

| # | Caso | Resultado |
|---|------|-----------|
| 1 | Eliminar producto reintegra stock | ✅ |
| 2 | Reducir cantidad reintegra diferencia | ✅ |
| 3 | Aumentar cantidad con stock suficiente | ✅ |
| 4 | Aumentar cantidad stock insuficiente sin auth → stock 0 | ✅ |
| 5 | Aumentar cantidad con auth admin → stock negativo | ✅ |
| 6 | Agregar producto nuevo descuenta stock | ✅ |
| 7 | Eliminar todos los productos reintegra stock | ✅ |
| 8 | Modificar varios productos simultáneamente | ✅ |
| 9 | Productos con stock negativo (admin auth) | ✅ |
| 10 | Productos con faltantes previos → stock 1 | ✅ |
| 11 | Reintentar misma modificación no duplica | ✅ |
| 12 | Error durante transacción → rollback | ✅ |
| 13 | Movimientos registrados en stock_movements | ✅ |
| 14 | No duplicar stock en re-modificación | ✅ |
| 15 | Usuario común no puede autorizar stock negativo | ✅ |
| 16 | Faltante + eliminación → stock 5 | ✅ |
| 17 | Faltante + aumento → stock 0 | ✅ |
| 18 | Auth admin + eliminación → stock 5 | ✅ |
| 19 | Sucesiva 3→5→3→5 registra todos los movimientos | ✅ |
| 20 | Dos mods con igual cantidad final → movimientos distintos | ✅ |
| 21 | Consistencia: stock final = suma de movimientos | ✅ |

---

## 7. Resultados de validación

- **Suite completa:** 314 tests, 17 suites — TODOS PASAN
- **Pruebas de inventario-modify:** 21/21 pasan
- **node --check:** sin errores

---

## 8. Riesgos pendientes

- La pre-verificación (UX) en modify-items sigue usando `checkStockShortages` sobre la cantidad completa nueva, no sobre el diff/increase. Solo afecta logs.
- Los movimientos antiguos (shortage de faltantes previos) permanecen como historial de auditoría; el stock actual es la fuente de verdad.
- No se modificó la cancelación de pedidos ni la reapertura (fuera de scope).

---

## 9. Confirmación

- ✅ No se modificó la base de datos real de producción.
- ✅ Todas las pruebas usan SQLite en memoria.
- ✅ No se eliminaron features existentes.
- ✅ Escenarios de faltantes y modificaciones sucesivas resueltos correctamente.

---

**Condición de cierre:** Fase aprobada. Detenido a la espera de autorización para Fase 2B.4.
"