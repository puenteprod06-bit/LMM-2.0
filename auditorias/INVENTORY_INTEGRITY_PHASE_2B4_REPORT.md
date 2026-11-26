# INVENTORY_INTEGRITY_PHASE_2B4_REPORT.md

## Fase 2B.4 — Integridad del Inventario al Cancelar y Reabrir Pedidos

**Fecha:** 19/11/2026
**Estado:** APROBADO — todas las pruebas pasan

---

## 1. Auditoría inicial

### Hallazgos

1. **No existía endpoint de cancelación dedicado.** La cancelación se realizaba vía `POST /api/orders/update-status` con `status='cancelled'`, que solo cambiaba el estado del pedido SIN tocar el inventario. El stock descontado en `finalize` nunca se reintegraba.

2. **Reopen** (`POST /api/orders/reopen`) solo cambiaba el estado a 'active' sin ningún efecto en inventario.

3. **No había idempotencia:** cancelar o reabrir dos veces ejecutaba la operación cada vez (aunque update-status era idempotente en el sentido de que el estado ya era el target, no había protección de stock porque no había stock logic).

### Respuestas a las preguntas de auditoría

1. **¿Qué endpoint cancela?** `POST /api/orders/update-status` con `status='cancelled'`.
2. **¿Qué endpoint reabre?** `POST /api/orders/reopen`.
3. **¿Qué cambios de estado?** Cancel: → 'cancelled'. Reopen: → 'active' (desde 'delivered'/'cancelled'/'paid').
4. **¿Qué ocurre con el stock?** ANTES: nada. AHORA: cancel reintegra, reopen re-descuenta (solo si estaba cancelado).
5. **¿Qué ocurre si se repite?** AHORA: idempotente (segunda operación es no-op).
6. **¿Cancelar y reabrir?** Cancel retorna stock, reopen re-descuenta. Neto 0.
7. **¿Volver a finalizar?** Reopen re-descuenta; finalize posterior fusiona sin doble descuento.
8. **¿Cómo evitar doble?** Idempotencia por estado (si ya cancelado/activo, no-op) + effectivePrev reconstruction.

---

## 2. Semántica definida

### Cancelación
- Si el pedido ya está cancelado → no-op (idempotente).
- Si no: para cada producto, calcular `effectivePrev = SUM(sale) - SUM(return)`.
- Reintegrar `effectivePrev` al stock.
- Registrar movimiento `return` con stock_before/stock_after.
- Cambiar estado a 'cancelled'.
- Todo en una transacción.

### Reapertura
- Si ya está activo/pending → solo actualizar timestamps (no-op de stock).
- Si estaba cancelado → re-descontar stock (revivir la venta) con reglas de autorización. Registrar movimientos `sale`/`shortage`.
- Si estaba delivered/paid → solo cambiar a 'active' (sin cambio de stock; la venta sigue vigente, edición vía modify-items).
- Todo en una transacción.

---

## 3. Archivos modificados

### `routes/orders.js`
- `update-status`: ahora maneja cancelación con reintegro de stock (transacción, idempotente).
- `reopen`: ahora re-descuenta stock si el pedido estaba cancelado (transacción, idempotente).

### `tests/orders.test.js`
- Test "404 si la orden no existe" en reopen: actualizado de 500 a 404 (mejora de API).

### `tests/inventory-cancel-reopen.test.js` (nuevo)
- 20 casos de prueba.

### Backup
- `scripts/backups/phase-2b3-20261119/routes/orders.js.bak2`

---

## 4. Casos de prueba

| # | Caso | Resultado |
|---|------|-----------|
| 1 | Cancelar con stock suficiente | ✅ |
| 2 | Cancelar con faltantes (reintegra 5, no 8) | ✅ |
| 3 | Cancelar con stock negativo (auth) reintegra todo | ✅ |
| 4 | Cancelar pedido modificado | ✅ |
| 5 | Cancelar con varios productos | ✅ |
| 6 | Cancelar dos veces (idempotente) | ✅ |
| 7 | Reabrir pedido cancelado re-descuenta | ✅ |
| 8 | Reabrir dos veces (idempotente) | ✅ |
| 9 | Reabrir y cancelar de nuevo consistente | ✅ |
| 10 | Cancelar después de reabrir | ✅ |
| 11 | No reintegros duplicados | ✅ |
| 12 | No descuentos duplicados | ✅ |
| 13 | Movimiento return con stock_before/after | ✅ |
| 14 | Movimiento sale en reopen con stock_before/after | ✅ |
| 15 | Usuario responsable registrado | ✅ |
| 16 | Usuario sin sesión no puede cancelar | ✅ |
| 17 | Cancelar orden inexistente no modifica stock | ✅ |
| 18 | Consistencia stock y movimientos | ✅ |
| 19 | Pedido sin inventario no genera reintegro | ✅ |
| 20 | Reopen de delivered no modifica stock | ✅ |

---

## 5. Resultados de validación

- **Suite completa:** 334 tests, 18 suites — TODOS PASAN
- **Nuevas pruebas:** 20/20 pasan
- **node --check:** sin errores

---

## 6. Riesgos pendientes

- Reopen de órdenes canceladas usa `isAdminSession` de la sesión actual (no hay flag adminAuthorized en reopen). Si el usuario no es admin y el stock es insuficiente, se aplica regla de faltante (stock→0).
- Reopen de órdenes delivered no cambia stock (correcto: la venta sigue vigente).
- No se modificó la sincronización Supabase ni Mercado Pago.

---

## 7. Confirmación

- ✅ No se modificó la base de datos real de producción.
- ✅ Todas las pruebas usan SQLite en memoria.
- ✅ No se eliminaron features existentes.
- ✅ No se avanzó a Fase 2B.5.

---

**Condición de cierre:** Fase aprobada. Detenido a la espera de autorización.**