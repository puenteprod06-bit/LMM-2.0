# INVENTORY_INTEGRITY_PHASE_2B1_CORRECTION_REPORT.md
# Informe de Corrección Definitiva — Fase 2B.1: Protección del Stock

**Proyecto:** La Mente Maestra 3.0 (POS) — Node.js, Express, Electron, SQLite  
**Fecha:** 19/11/2026  
**Etapa:** 2B.1 — Corrección definitiva de reglas de stock  
**Estado:** Implementación completada y verificada — 273 pruebas aprobadas  
**Próximo paso:** Esperar autorización antes de continuar con Fase 2B.2

---

## 1. Problema Original

La Fase 2B.1 anterior implementó controles de stock que **rechazaban la venta** cuando no había stock suficiente, incluso sin autorización administrativa. Esto violaba la regla comercial del propietario:

> "La falta de stock NUNCA debe bloquear una venta."

Además:
- El stock se limitaba a 0 con `MAX(0, ...)` (ocultando el faltante).
- La autorización admin se validaba **fuera** de la transacción (condición de carrera).
- No se registraba el faltante de forma persistente.
- El cliente podía enviar `adminAuthorized: true` y, si la sesión era de admin, se permitía stock negativo.

---

## 2. Causa Raíz

La lógica de `checkStockShortages` + `isAdminSession` rechazaba la operación cuando había shortage y no había autorización admin. Esto era incorrecto porque:

1. La venta debe completarse siempre, incluso sin stock suficiente.
2. Solo el stock **negativo** requiere autorización admin.
3. Sin autorización, el stock se limita a 0 (se descuenta solo lo disponible).
4. Con autorización, el stock puede quedar negativo.

Además, la verificación de stock ocurría fuera de la transacción, permitiendo una condición de carrera donde dos solicitudes simultáneas leían el mismo stock y ambas procedían sin autorización.

---

## 3. Solución Implementada

### 3.1. Nueva función `applyStockDiscount(items, isAdminAuthorized)`

Reemplaza `decrementInventoryStock` con lógica que:
- Lee el stock actual para cada ítem de inventario
- Calcula el faltante: `shortage = max(0, qty - available)`
- Si hay shortage y NO hay autorización admin: descuenta solo `min(qty, available)` (stock → 0)
- Si hay shortage y SÍ hay autorización admin: descuenta `qty` completa (stock puede quedar negativo)
- Si no hay shortage: descuenta `qty` completa
- Retorna `{ shortages, hasShortage }` para registro y respuesta

### 3.2. Pre-verificación (UX rápida, informativa)

Fuera de la transacción, se calcula el faltante y se informa al frontend. **No se rechaza la venta**. Solo se registra en log.

### 3.3. Verificación definitiva (dentro de la transacción)

Dentro de `db._native.transaction()`:
- Se re-verifica el stock (evita condición de carrera)
- Se determina autorización admin desde la sesión SQLite
- Se llama a `applyStockDiscount` que aplica el descuento correcto
- Se registran faltantes en log
- Si falla cualquier operación, se hace rollback automático

### 3.4. Autorización administrativa

No se inventó un nuevo sistema de roles. Se reutiliza el existente:
- `session.role === 'owner'` con `is_client === 0` → administrador (propietario)
- `session.role === 'admin'` con `is_client === 1` → administrador (empleado con rol admin)

La autorización se basa en la sesión almacenada en SQLite (`local_session`), **nunca** en datos del frontend como `adminAuthorized: true`.

Un cliente que falsifique `adminAuthorized: true` sin sesión de admin es tratado como usuario sin autorización: la venta se completa pero el stock queda en 0 (no negativo).

---

## 4. Archivos Modificados

| Archivo | Cambios |
|---------|---------|
| `routes/orders.js` | Agregó `applyStockDiscount()`. Reemplazó `decrementInventoryStock`. Movió verificación definitiva de stock dentro de la transacción en `finalize` y `modify-items`. Cambió lógica para permitir venta con stock insuficiente (stock → 0 sin admin, stock → negativo con admin). Agregó `shortages` a la respuesta. |
| `routes/inventory.js` | Reemplazó `MAX(0, ...)` por lógica de descuento según autorización. Movió verificación definitiva dentro de la transacción. Agregó `shortages` a la respuesta. |

No se modificó: `db.js`, `auth.js`, `server.js`, `middleware/requireAuth.js`, `sync-engine.js`, `routes/config.js`, `routes/mercadopago.js`.

---

## 5. Decisiones Técnicas

### 5.1. Autorización administrativa

No se inventó un nuevo sistema de roles. Se reutiliza el sistema existente:
- `session.role === 'owner'` con `is_client === 0` → administrador (propietario)
- `session.role === 'admin'` con `is_client === 1` → administrador (empleado con rol admin)

La autorización se basa en la sesión almacenada en SQLite (`local_session`), **nunca** en datos del frontend.

### 5.2. Stock negativo

El stock puede quedar negativo cuando hay autorización administrativa. No se usa `MAX(0, ...)` que ocultaba el faltante. El faltante se calcula como `max(0, qty - available_stock)` y se retorna en la respuesta para que el frontend muestre la advertencia.

### 5.3. Transacciones atómicas

- `finalize`: pre-verificación → transacción (orden + items + stock)
- `modify-items`: pre-verificación → transacción (soft-delete + items + stock + totales)
- `inventory/decrement`: pre-verificación → transacción (descuento stock)
- Si hay error en cualquier paso, se hace `ROLLBACK` y no se aplica ninguna operación parcial.

### 5.4. Reintentos

Cada llamada a `finalize` con los mismos items crea una nueva orden y descuenta stock de nuevo. No hay idempotencia implementada en esta fase. Esto es un riesgo pendiente.

---

## 6. Reglas Comerciales Verificadas

| Escenario | Resultado esperado | Test |
|-----------|-------------------|------|
| Stock 5, venta 3 (suficiente) | Venta OK, stock 2 | ✅ Test 1 |
| Stock 5, venta 5 (exacto) | Venta OK, stock 0 | ✅ Test 2 |
| Stock 5, venta 8 (sin admin) | Venta OK, stock 0, faltante 3 | ✅ Test 3 |
| Stock 5, venta 8 (con admin) | Venta OK, stock -3, faltante 3 | ✅ Test 4 |
| Stock 5, venta 8, user sin rol admin | Venta OK, stock 0, faltante 3 | ✅ Test 5 |
| Stock 5, venta 8, falso adminAuthorized | Venta OK, stock 0, faltante 3 | ✅ Test 6 |
| Stock 10, dos ventas de 5 concurrentes | Ambas OK, stock 0 | ✅ Test 7 |
| Stock 10, venta 1.5 (decimal) | Venta OK, stock 8.5 | ✅ Test 8 |
| Error durante inserción | Rollback, stock sin cambios | ✅ Test 9 |
| Reintento de misma solicitud | Dos órdenes, stock descontado dos veces | ✅ Test 10 |
| inventory/decrement con admin | Stock -3, faltante 3 | ✅ Test 11 |
| inventory/decrement sin admin | Stock 0, faltante 3 | ✅ Test 11b |
| Pedido existente (sin adminAuthorized) con stock suficiente | Venta OK, stock 7, sin faltante | ✅ Test 12 |

---

## 7. Seguridad de Autorización

- **No confía en `localStorage`**: la autorización se verifica contra `local_session` de SQLite.
- **No confía en `adminAuthorized: true` del frontend**: se verifica que la sesión sea de administrador (owner o admin employee).
- **Condición de carrera mitigada**: la verificación definitiva ocurre dentro de la transacción SQLite (síncrona, serializada).
- **No hay descuentos parciales**: si falla cualquier operación, se hace rollback automático.

---

## 8. Evidencia de Registro Persistente

El faltante se registra en el log del servidor (escrito a archivo por el logger de Winston). Cada registro incluye:
- Nombre del producto
- Stock disponible antes de la operación
- Cantidad solicitada
- Cantidad faltante
- Si hubo autorización administrativa
- Timestamp (implícito en el log)

**Propuesta de tabla `stock_shortages`** (pendiente de aprobación):
```sql
CREATE TABLE IF NOT EXISTS stock_shortages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inventory_id INTEGER NOT NULL,
  product_name TEXT NOT NULL,
  available_stock REAL NOT NULL,
  requested_qty REAL NOT NULL,
  shortage_qty REAL NOT NULL,
  admin_authorized INTEGER DEFAULT 0,
  authorized_by TEXT,
  operation_type TEXT NOT NULL,
  reference_id INTEGER,
  created_at INTEGER NOT NULL,
  uuid TEXT,
  device_id TEXT,
  deleted INTEGER DEFAULT 0
);
```

Esta tabla es compatible con el esquema existente y no es destructiva (`CREATE TABLE IF NOT EXISTS`). Se propone para la Fase 2B.2.

---

## 9. Pruebas Ejecutadas

### `tests/inventory-stock-security.test.js` — 13 pruebas, todas pasan

| # | Prueba | Resultado |
|---|--------|-----------|
| 1 | Stock suficiente: venta normal, stock se descuenta | ✅ PASS |
| 2 | Stock exactamente igual a qty: stock queda en 0 | ✅ PASS |
| 3 | Stock insuficiente sin admin: venta se completa, stock queda en 0 | ✅ PASS |
| 4 | Stock insuficiente con admin: permite venta, stock negativo | ✅ PASS |
| 5 | Usuario sin rol admin: venta se completa, stock queda en 0 | ✅ PASS |
| 6 | Cliente falsifica adminAuthorized: stock queda en 0 | ✅ PASS |
| 7 | Dos finalize concurrentes: stock se descuenta correctamente | ✅ PASS |
| 8 | Cantidades decimales: stock se descuenta correctamente | ✅ PASS |
| 9 | Rollback ante error: no se descuenta stock parcialmente | ✅ PASS |
| 10 | Reintento de misma solicitud: dos finalize crean dos órdenes | ✅ PASS |
| 11 | inventory/decrement con admin → stock negativo | ✅ PASS |
| 11b | inventory/decrement sin admin → stock queda en 0 | ✅ PASS |
| 12 | Pedido existente con stock suficiente funciona | ✅ PASS |

### Suite Completa

| Métrica | Valor |
|---------|-------|
| Suites de prueba | 15 |
| Tests totales | **273** |
| Tests pasando | **273** |
| Tests fallando | 0 |

Todas las suites pasan: `auth`, `security`, `security-hardening`, `orders`, `orders-money-security`, `employees`, `customers`, `db`, `utils`, `tables-save-auth`, `sync-security`, `sync-integration`, `flow-reproduction`, `inspect-real-db`, `inventory-stock-security`.

---

## 10. Limitaciones Pendientes

| # | Limitación | Descripción |
|---|-----------|-------------|
| 1 | No hay tabla de movimientos de stock | El faltante se registra en log (archivo), no en BD. Se propone tabla `stock_shortages` para Fase 2B.2. |
| 2 | Pruebas de concurrencia limitadas | `Promise.all` en un solo proceso no cubre concurrencia entre procesos (múltiples instancias de Electron). better-sqlite3 es síncrono y serializa dentro del mismo proceso. |
| 3 | No hay devolución de stock en cancelación/reapertura | `update-status` (cancelled) y `reopen` no restauran stock. Requiere Fase 2B.4. |
| 4 | No hay protección contra doble descuento en finalize | Dos clics rápidos crean dos órdenes y descuentan stock dos veces. |
| 5 | Sincronización por upsert absoluto de stock | Si dos dispositivos descuentan el mismo producto, el último sobrescribe. Requiere Fase 2B.5. |
| 6 | `decrementInventoryStock` no usa `MAX(0, ...)` | Esto es por diseño: permite stock negativo con autorización. |

---

## 11. Backup Generado y Ubicación

| Archivo | Ruta del backup |
|---------|-----------------|
| `routes/orders.js` | `scripts/backups/phase-2b1-correction-20261119/routes/orders.js.bak` |
| `routes/inventory.js` | `scripts/backups/phase-2b1-correction-20261119/routes/inventory.js.bak` |
| `db.js` | `scripts/backups/phase-2b1-correction-20261119/db.js.bak` |

---

## 12. Confirmación de que no se Modificó la Base de Datos Real

- ✅ No se ejecutaron queries de escritura sobre la base de datos de producción
- ✅ Todas las pruebas usaron SQLite en memoria (`:memory:`) vía `buildTestApp`
- ✅ No se modificó ningún dato real del negocio
- ✅ No se ejecutó `npm audit fix --force`

---

## 13. Pasos para Reproducir las Verificaciones

1. Ejecutar las pruebas de stock:
   ```
   node scripts/run-tests.js tests/inventory-stock-security.test.js
   ```
2. Ejecutar la suite completa:
   ```
   node scripts/run-tests.js --testPathPattern=tests/
   ```
3. Verificar que todos los 273 tests pasen.

---

## Estado Final

La Fase 2B.1 está completada con corrección definitiva de reglas de stock. Se implementó:
- ✅ La venta NUNCA se bloquea por falta de stock
- ✅ El stock se limita a 0 sin autorización (se descuenta solo lo disponible)
- ✅ El stock negativo requiere autorización de administrador (verificada en backend)
- ✅ El faltante se calcula y registra en log
- ✅ La autorización se basa en sesión SQLite, no en datos del frontend
- ✅ Operaciones atómicas con `db._native.transaction`
- ✅ No hay descuentos parciales ante errores
- ✅ 13 pruebas nuevas, todas pasan
- ✅ 273 tests totales, sin regresiones

**Se detiene aquí y espera autorización antes de continuar con la Fase 2B.2 (trazabilidad de movimientos).**
