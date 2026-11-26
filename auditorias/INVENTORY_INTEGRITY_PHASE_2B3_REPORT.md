# INVENTORY_INTEGRITY_PHASE_2B3_REPORT.md

## Fase 2B.3 — Integridad del Stock al Modificar Pedidos

**Fecha:** 19/11/2026
**Estado:** APROBADO — todas las pruebas pasan

---

## 1. Auditoría inicial

### Archivos inspeccionados
- `routes/orders.js`: finalize, modify-items, applyStockDiscount, checkStockShortages, isAdminSession, calculateOrderTotals, getAuthorizedPrice
- `db.js`: schema (orders, order_items, inventory, stock_movements), recordStockMovement
- `tests/helpers/testApp.js`: in-memory SQLite schema

### Problema identificado
En `modify-items`, los ítems existentes se eliminaban lógicamente (`UPDATE order_items SET deleted=1`) y se reinsertaban como nuevos, pero el stock NO se reconciliaba:
- No se reintegraba stock al eliminar/reducir productos.
- Se aplicaba `applyStockDiscount` sobre la cantidad NUEVA completa, lo que causaba doble descuento (el stock original ya había sido descontado en `finalize`).
- No se registraban movimientos de reintegro.

### Cómo se registraba el stock descontado
- `finalize` llama `applyStockDiscount` que descuenta stock y registra movimientos `sale`/`shortage` con idempotency keys `order-{id}-sale-{invId}-{qty}`.
- `order_items` guarda `qty` por ítem (cantidad pedida), no la cantidad efectivamente descontada.
- Los faltantes se registran en `stock_movements` con movement_type `shortage`.

---

## 2. Estrategia de reconciliación

Comparar cantidades anteriores vs nuevas por `invId`:

```
diff = newQty - prevQty
diff > 0 → descontar diff (regla de faltante: stock→0 sin auth, negativo con auth)
diff < 0 → reintegrar |diff|
diff = 0 → no-op
```

- Cantidades anteriores se leen ANTES del soft-delete.
- Todo dentro de una transacción SQLite (`db._native.transaction()`).
- Movimientos registrados con UUID determinísticos (idempotencia).

### Reglas comerciales aplicadas
1. Eliminar producto → reintegrar cantidad descontada efectivamente (diff negativo).
2. Reducir cantidad → reintegrar solo la diferencia.
3. Aumentar cantidad → aplicar regla de faltante (Fase 2B.1).
4. Agregar producto nuevo → misma regla de faltante.
5. Stock insuficiente sin auth → venta continúa, stock→0, faltante registrado.
6. Auth admin válida → stock negativo permitido.
7. `adminAuthorized` del frontend NUNCA se confía; backend verifica sesión (`isAdminSession`).
8. Todo en una transacción atómica.
9. Movimientos con referencia al pedido y usuario.
10. Idempotencia vía UUID determinístico + INSERT OR IGNORE.

---

## 3. Archivos modificados

### `routes/orders.js`
- **modify-items handler**: reemplazado el bloque `applyStockDiscount` + soft-delete por:
  - Lectura de ítems anteriores (prevQtyByInv) antes del soft-delete.
  - Cálculo de newQtyByInv.
  - Soft-delete + reinsert.
  - Actualización de totales.
  - Reconciliación de stock por invId (diff-based).
  - Registro de movimientos: `sale`, `shortage`, `return`.

### `tests/inventory-modify-items.test.js` (nuevo)
- 15 casos de prueba (ver sección 4).

### Backup
- `scripts/backups/phase-2b3-20261119/routes/orders.js.bak`

---

## 4. Casos de prueba

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
| 10 | Productos con faltantes previos | ✅ |
| 11 | Reintentar misma modificación no duplica | ✅ |
| 12 | Error durante transacción → rollback | ✅ |
| 13 | Movimientos registrados en stock_movements | ✅ |
| 14 | No duplicar stock en re-modificación | ✅ |
| 15 | Usuario común no puede autorizar stock negativo | ✅ |

---

## 5. Resultados de validación

- **Suite completa:** 308 tests, 17 suites — TODOS PASAN
- **Nuevas pruebas:** 15/15 pasan
- **Pruebas existentes de inventario:** pasan
- **Pruebas de pedidos:** pasan
- **node --check:** sin errores de sintaxis

---

## 6. Riesgos pendientes

- La pre-verificación (UX) en modify-items sigue usando `checkStockShortages` sobre la cantidad completa nueva, no sobre el diff. Esto solo afecta logs informativos, no la lógica de stock.
- `recordStockMovement` usa `_getDb()` que requiere `setDbForTesting` en tests; en producción usa la BD real automáticamente.
- No se modificó la cancelación de pedidos ni la reapertura (fuera de scope).

---

## 7. Confirmación

- ✅ No se modificó la base de datos real de producción.
- ✅ Todas las pruebas usan SQLite en memoria.
- ✅ No se eliminaron features existentes.
- ✅ No se modificó auth/sync/payments fuera de scope.

---

**Condición de cierre:** Fase aprobada. Detenido a la espera de autorización para Fase 2B.4.
"