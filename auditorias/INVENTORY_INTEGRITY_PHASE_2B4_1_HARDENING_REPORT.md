# INVENTORY_INTEGRITY_PHASE_2B4_1_HARDENING_REPORT.md

## Fase 2B.4.1 — Hardening de Cancelaciones, Reaperturas e Idempotencia

**Fecha:** 20/11/2026
**Estado:** APROBADO — todas las pruebas pasan

---

## 1. Auditoría

### Endpoints inspeccionados

| Endpoint | Ruta | Comportamiento antes del hardening |
|----------|------|------------------------------------|
| Cancelar | `POST /api/orders/update-status` (`status='cancelled'`) | Cambiaba estado sin tocar stock. Sin idempotencia de stock. |
| Reabrir | `POST /api/orders/reopen` | Cambiaba estado a 'active' sin tocar stock. |
| Finalizar | `POST /api/orders/finalize` | Descontaba stock; sin protección contra re-finalize tras reopen. |
| Modificar ítems | `POST /api/orders/modify-items` | Reconciliación por diff (Fase 2B.3.1). |

### Problemas detectados

1. **Reopen re-descontaba la cantidad completa del pedido** (`order_items.qty`) en vez de la cantidad efectivamente vendida (`SUM(sale)`). Con faltantes, esto re-descontaba de más.

2. **Finalize tras reopen podía duplicar descuento.** Al reabrir, el stock ya se había re-descontado; un `finalize` posterior sobre el mismo pedido (o uno idéntico) descontaba de nuevo.

3. **No se verificaba autorización en reopen de forma consistente** con la regla de faltantes (stock→0 sin admin, negativo con admin).

---

## 2. Correcciones aplicadas

### `routes/orders.js`

#### Reopen (`POST /api/orders/reopen`)
- Re-discount ahora usa `SUM(sale)` (cantidad efectivamente vendida reconstruida de `stock_movements`) en vez de `order_items.qty`.
  - Ejemplo: stock 5, pedido 8 sin auth → sale=5. Cancel → return 5. Reopen → re-discount SUM(sale)=5 → stock 0 (no -3).
- Mantiene reglas de autorización: owner/admin permite stock negativo; sin auth limita a disponible y registra shortage.
- Movimientos `sale`/`shortage` registrados con UUID determinístico e idempotency key.
- Todo dentro de `db._native.transaction()`.

#### Finalize (`POST /api/orders/finalize`)
- Nueva verificación de idempotencia: si existe una orden activa (no delivered/cancelled, sin pagar) con los mismos ítems de inventario Y esa orden tiene un movimiento `return` (es decir, fue cancelada y reabierta), el finalize devuelve sin descontar stock nuevamente.
  - Cubre el flujo: cancelar → reabrir → finalizar (el stock ya se re-descontó al reabrir).
- Todo dentro de la transacción existente.

#### Cancelar (`POST /api/orders/update-status` → `status='cancelled'`)
- Ya implementado en 2B.4: reintegra `effectivePrev = SUM(sale) - SUM(return)`, idempotente por estado.

---

## 3. Estrategia de idempotencia

- **Cancelar repetido:** si ya está `cancelled`, no-op (no segundo reintegro).
- **Reabrir repetido:** si ya está `active`/`pending`, no-op de stock (solo timestamps).
- **Finalize tras reopen:** detección de orden activa con items idénticos y movimiento `return` → no-op de stock.
- **UUID determinístico:** keys `order-{id}-{op}-{orderStateId}-{type}-{invId}-{qty}` donde `orderStateId = orders.updatedAt` captura el estado previo, diferenciando operaciones legítimas de reintentos.
- `INSERT OR IGNORE` en `recordStockMovement` evita duplicados a nivel de BD.

---

## 4. Pruebas nuevas (`tests/inventory-cancel-reopen.test.js`)

| # | Caso | Resultado |
|---|------|-----------|
| 1 | Cancelar con stock suficiente reintegra stock | ✅ |
| 2 | Cancelar con faltantes reintegra solo lo descontado (5, no 8) | ✅ |
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
| 21 | **Crítica**: cancelar → reabrir → finalizar, stock se mantiene | ✅ |
| 22 | **Crítica con faltantes**: cancelar → reabrir → finalizar | ✅ |
| 23 | **Crítica con auth admin**: cancelar → reabrir → finalizar | ✅ |
| 24 | **Crítica modificado**: cancelar → reabrir → finalizar | ✅ |

### Verificación directa de tablas
Todas las pruebas consultan `inventory`, `orders`, `order_items` y `stock_movements` directamente (no solo respuestas HTTP).

---

## 5. Concurrencia

Se verificó con solicitudes simultáneas (`Promise.all`):
- Dos cancelaciones simultáneas → stock correcto, sin duplicación.
- Cancelar y reabrir simultáneos → stock consistente (7 u 10, no corrupto).

**Limitación documentada:** las pruebas de concurrencia real con `better-sqlite3` (síncrono) dentro de una sola instancia de Node muestran que las transacciones serializan las escrituras, pero no se puede garantizar comportamiento bajo carga multi-proceso real sin un entorno de stress dedicado. No se afirma cobertura completa de concurrencia bajo carga productiva.

---

## 6. Verificación de autorización

| Escenario | Resultado |
|-----------|-----------|
| Reabrir con admin y stock insuficiente | Permite stock negativo (registro shortage) |
| Reabrir con usuario común y stock insuficiente | Stock → 0, registra shortage |
| Reabrir sin sesión | 401 |
| Permisos falsos desde frontend | Rechazado (backend verifica sesión vía `isAdminSession`) |

---

## 7. Resultados de validación

- **Suite completa:** 338 tests, 18 suites — TODOS PASAN
- **Pruebas cancel/reopen:** 24/24 pasan
- **node --check:** sin errores en `routes/orders.js`

---

## 8. Archivos modificados

| Archivo | Cambio |
|---------|--------|
| `routes/orders.js` | Reopen re-discount SUM(sale); finalize idempotencia post-reopen; cancel ya existente |
| `tests/inventory-cancel-reopen.test.js` | 24 pruebas (20 originales + 4 críticas) |
| `tests/orders.test.js` | Test reopen 404: 500→404 (mejora de API) |

### Backup
- `scripts/backups/phase-2b3-20261119/routes/orders.js.bak` (2B.3)
- `scripts/backups/phase-2b3-20261119/routes/orders.js.bak2` (2B.4)

---

## 9. Riesgos pendientes

- Reopen usa `isAdminSession` de la sesión actual (no hay flag `adminAuthorized` en reopen). El frontend requiere PIN de supervisor para reabrir, por lo que el usuario autenticado es el responsable.
- Concurrencia bajo carga multi-proceso real no se verificó exhaustivamente.
- No se modificó sincronización Supabase, Mercado Pago, autenticación general ni mesas.

---

## 10. Confirmación

- ✅ No se modificó la base de datos real de producción.
- ✅ Todas las pruebas usan SQLite en memoria.
- ✅ No se eliminaron features existentes.
- ✅ No se avanzó a Fase 2B.5.

---

**Condición de cierre:** Fase aprobada. Detenido a la espera de autorización explícita.**