# ORDERS_MONEY_AUDIT_REPORT.md
# Informe de Auditoría de Seguridad e Integridad — Pedidos y Dinero

**Proyecto:** La Mente Maestra 3.0 (POS) — Node.js, Express, Electron, SQLite  
**Fecha:** 18/11/2026  
**Tipo:** Investigación y diagnóstico únicamente (SIN correcciones de código)  
**Estado:** Pendiente de autorización para fase de reparación

---

## 1. Archivos inspeccionados

| Archivo | Qué cubre |
|---|---|
| `routes/orders.js` | Todas las rutas `/api/orders/*` (finalize, pay, update-status, update-table, modify-items, update-item-status, update-bulk-items, reopen, active-count, history) |
| `routes/mercadopago.js` | Integración Mercado Pago QR dinámico (`/api/mp/config`, `/api/mp/qr`, `/api/mp/qr/:externalRef`, `/api/mp/qr` DELETE) |
| `routes/inventory.js` | Rutas de inventario (`/api/inventory/save`, `/api/inventory/decrement`, DELETE) |
| `db.js` | Esquema de tablas `orders`, `order_items`, `tables`, `inventory`, triggers de sincronización |
| `tests/orders.test.js` | Pruebas existentes de rutas de órdenes |
| `tests/helpers/testApp.js` | Fábrica de app Express para tests (SQLite en memoria) |

---

## 2. Endpoints y funciones involucradas

### 2.1. Endpoints de órdenes (`routes/orders.js`)

| Endpoint | Método | Propósito | Protección |
|---|---|---|---|
| `/api/orders` | GET | Listar pedidos no cancelados con items | `requireSession` |
| `/api/orders/finalize` | POST | Crear orden nueva o mergear con abierta de misma mesa | `requireSession` |
| `/api/orders/pay` | POST | Cerrar orden, registrar pago, liberar mesa | `requireSession` |
| `/api/orders/update-status` | POST | Cambiar estado de orden | `requireSession` |
| `/api/orders/update-table` | POST | Cambiar mesa de orden | `requireSession` |
| `/api/orders/modify-items` | POST | Reemplazar ítems de orden (soft-delete + reinsert) | `requireSession` |
| `/api/orders/update-item-status` | POST | Cambiar estado de un ítem | `requireSession` |
| `/api/orders/update-bulk-items` | POST | Cambiar estado de ítems por área | `requireSession` |
| `/api/orders/reopen` | POST | Reabrir orden pagada (quitar paymentMethod) | `requireSession` |
| `/api/orders/active-count` | GET | Contar mesas con órdenes activas | `requireSession` |
| `/api/orders/history` | GET | Historial paginado de pedidos pagados | `requireSession` |

### 2.2. Endpoints de Mercado Pago (`routes/mercadopago.js`)

| Endpoint | Método | Propósito | Protección |
|---|---|---|---|
| `/api/mp/config` | GET | Ver configuración MP (sin token) | `requireSession` |
| `/api/mp/config` | POST | Guardar credenciales MP | `requireOwner` |
| `/api/mp/qr` | POST | Generar orden QR dinámica en MP | `requireSession` |
| `/api/mp/qr/:externalRef` | GET | Consultar estado de pago en MP | `requireSession` |
| `/api/mp/qr` | DELETE | Cancelar QR activo | `requireSession` |

### 2.3. Endpoints de inventario (`routes/inventory.js`)

| Endpoint | Método | Propósito | Protección |
|---|---|---|---|
| `/api/inventory/save` | POST | Crear/editar producto de inventario | `requireOwner` |
| `/api/inventory/decrement` | POST | Descontar stock atómicamente | `requireSession` |
| `/api/inventory/:id` | DELETE | Soft-delete de producto | `requireOwner` |

### 2.4. Funciones internas clave

| Función | Ubicación | Qué hace |
|---|---|---|
| `finalize` | routes/orders.js:119 | Crea orden o mergea, inserta items, descuenta stock, notifica |
| `pay` | routes/orders.js:251 | Cierra orden, deriva total de BD, libera mesa dine-in |
| `modify-items` | routes/orders.js:376 | Soft-delete items existentes, reinserta nuevos, recalcula subtotal (NO total) |
| `decrementInventoryStock` | routes/orders.js:77 | Descanta stock de ítems tipo inventory (sin transacción, sin verificar stock suficiente) |
| `reopen` | routes/orders.js:518 | Quita paymentMethod, pone status='active' (NO devuelve stock) |
| `getOrderById` | routes/orders.js:61 | Lee orden + items desde SQLite |
| `mpFetch` | routes/mercadopago.js:24 | Helper para llamar a API de Mercado Pago |
| `/api/mp/qr` POST | routes/mercadopago.js:147 | Crea QR en MP con total e items del cliente (sin verificar contra BD) |

---

## 3. Problemas encontrados

### 3.1. Ausencia de transacciones atómicas (CRÍTICO)

**Inspección de código.** `routes/orders.js` no usa `BEGIN TRANSACTION` / `COMMIT` en ninguna operación. Cada `db.run` / `stmt.run` se ejecuta de forma independiente.

Operaciones que deberían ser atómicas pero NO lo son:

| Operación | Pasos separados sin transacción |
|---|---|
| `finalize` (orden nueva) | 1. INSERT en `orders` → 2. N× INSERT en `order_items` → 3. `decrementInventoryStock` (N× UPDATE en `inventory`) |
| `finalize` (merge) | 1. N× INSERT en `order_items` → 2. UPDATE totales en `orders` → 3. `decrementInventoryStock` |
| `pay` | 1. UPDATE `orders` (paymentMethod, total, closedAt, paidAt) → 2. UPDATE `tables` (liberar mesa) |
| `modify-items` | 1. UPDATE `order_items SET deleted=1` → 2. N× INSERT en `order_items` → 3. UPDATE `subtotal` en `orders` |
| `reopen` | 1. UPDATE `orders` (quitar pago) — sin devolver stock |

**Riesgo:** Si el proceso falla a mitad (error de disco, reinicio, pérdida de conexión), quedan datos inconsistentes: orden sin ítems, ítems sin orden, stock descontado sin orden, mesa liberada sin orden cerrada, etc.

**Estado:** Detectado mediante inspección de código. No reproducido (requiere forzar fallos a mitad de operación).

---

### 3.2. `finalize` acepta subtotal/tax/total del cliente sin recalcular desde BD (CRÍTICO)

**Inspección de código.** `routes/orders.js:131-142` valida solo que `total >= subtotal + tax`. No recalcula nada desde los precios de `menu_items` o `inventory`.

**Ejemplo concreto de fallo posible:**

Un cliente envía desde DevTools:
```json
{
  "items": [{ "name": "Agua", "price": 50, "qty": 1, "lineTotal": 50 }],
  "subtotal": 0,
  "tax": 0,
  "total": 999999
}
```
Validación: `999999 >= 0 + 0` → **true**. La orden se guarda con `total = 999999` en la base.

Al pagar, `pay` deriva el total de BD: `dbTotal = 999999`, cobra 999999.

**Estado:** Detectado mediante inspección. Los tests existentes usan valores consistentes (BASE_ORDER con subtotal=200, tax=20, total=220) y no prueban este escenario de manipulación.

---

### 3.3. `finalize` merge suma valores del cliente sin recalcular (CRÍTICO)

**Inspección de código.** `routes/orders.js:184-193`:
```sql
UPDATE orders SET subtotal = subtotal + ?, tax = tax + ?, total = total + ?
```
Los valores `subtotal`, `tax`, `total` vienen del cuerpo de la solicitud del cliente. No se recalculan desde los ítems insertados ni desde precios de BD.

**Riesgo:** Un cliente puede inflar el total de una orden existente enviando valores arbitrarios en el cuerpo de `finalize` con `type: 'dine-in'` y una `tableId` que ya tenga una orden abierta.

**Estado:** Detectado mediante inspección. No reproducido.

---

### 3.4. `modify-items` recalcula `subtotal` pero NO actualiza `total` (ALTO)

**Inspección de código.** `routes/orders.js:447-463`: Solo se ejecuta `UPDATE orders SET subtotal = ?, updatedAt = ?`. Los campos `total`, `tax`, `discountAmt` no se tocan.

**Consecuencia:** Después de `modify-items`, el `total` de la orden queda desincronizado respecto al `subtotal` recalculado. Si luego se paga, `pay` usa `order.total` (desactualizado) como base, no el subtotal real de los ítems.

**Estado:** Detectado mediante inspección. Los tests existentes solo verifican `res.body.subtotal`, no el `total` persistido.

---

### 3.5. `pay` deriva total de BD (BIEN), pero el total de BD puede estar ya inflado (MEDIO)

**Inspección de código.** `routes/orders.js:281-282`:
```javascript
const dbTotal = Number(order.total) || 0;
const finalTotal = dbTotal + (nCommission ?? 0);
```
Esto evita que el cliente inflen el total en el momento del pago. **Pero** si el total de BD ya fue inflado por `finalize` o `modify-items` (ver 3.2 y 3.4), el pago cobra el monto inflado.

**Estado:** Detectado mediante inspección. Los tests `pay — seguridad de totales` verifican que un `total` menor del cliente es ignorado, pero no prueban el caso donde el total de BD ya está inflado por una operación previa.

---

### 3.6. No hay devolución de stock al cancelar o reabrir (ALTO)

**Inspección de código.** `update-status` permite poner `status = 'cancelled'` (líneas 330-347) pero NO restaura el stock de ítems tipo inventory. `reopen` (líneas 518-551) quita `paymentMethod` y pone `status = 'active'` pero tampoco devuelve stock.

**Riesgo:** Un producto vendido y luego cancelado (o reabierto) queda con stock descontado permanentemente. El inventario se agota sin que haya venta real.

**Estado:** Detectado mediante inspección. No hay endpoint dedicado de "cancelar con devolución de stock".

---

### 3.7. `decrementInventoryStock` no verifica stock suficiente (MEDIO)

**Inspección de código.** `routes/orders.js:77-94`:
```javascript
const qty = Number(item.qty) || 0;
if (qty > 0) { stmt.run(qty, item.invId); any = true; }
```
Simplemente descuenta `stock = stock - qty` sin verificar si `stock >= qty`. El stock puede quedar negativo.

**Nota:** `inventory/decrement` (routes/inventory.js:78) SÍ usa `MAX(0, stock - qty)`, pero `finalize` llama a `decrementInventoryStock` (de orders.js), no a ese endpoint.

**Estado:** Detectado mediante inspección. Los tests verifican que el stock se descuenta (10 → 7), pero no prueban stock insuficiente.

---

### 3.8. Mercado Pago `/qr` acepta total e items del cliente sin verificar contra BD (ALTO)

**Inspección de código.** `routes/mercadopago.js:156-185`: Los campos `total`, `items` (con `unit_price`, `quantity`) vienen del cuerpo de la solicitud y se envían directamente a Mercado Pago. No se consulta la orden en SQLite para verificar que el total coincida.

**Riesgo:** Un cliente puede generar un QR con un total menor al real, pagar ese monto menor, y el sistema no tiene forma de detectar la discrepancia porque no hay reconciliación entre el pago aprobado en MP y la orden local.

**Estado:** Detectado mediante inspección. No hay pagos reales ejecutados (por restricción del entorno).

---

### 3.9. Mercado Pago no vincula el pago a la orden local (ALTO)

**Inspección de código.** `/api/mp/qr` genera el QR y devuelve `external_reference` (`LMM-{orderId}-{timestamp}`), pero:
- No guarda el `in_store_order_id` de MP en la orden local
- No hay endpoint de webhook de MP para confirmar el pago y marcar la orden como pagada
- `/api/mp/qr/:externalRef` solo consulta estado (polling) pero no actualiza la orden local

**Riesgo:** Un cliente puede pagar el QR en MP, pero la orden en SQLite queda como `pending` sin `paymentMethod`. No hay reconciliación automática.

**Estado:** Detectado mediante inspección. No reproducible sin credenciales MP reales.

---

### 3.10. No hay protección contra doble pago concurrente (MEDIO)

**Inspección de código.** `pay` verifica `order.paymentMethod` para idempotencia (línea 272), pero:
1. Dos requests concurrentes de `pay` pueden leer `paymentMethod = NULL` ambas antes de que cualquiera escriba.
2. Ambas pasarían la validación y ambas escribirían `paymentMethod`, resultando en doble cobro.

**Riesgo:** Doble cobro si el cliente toca "Pagar" dos veces rápido o hay dos terminales en la misma mesa.

**Estado:** Detectado mediante inspección de código. No hay transacción ni bloqueo de fila (`SELECT ... FOR UPDATE` no existe en better-sqlite3 de esta forma).

---

### 3.11. `order_items` carece de columnas de auditoría en el schema base (BAJO)

**Inspección de código.** `db.js:355-365`: `order_items` se crea sin columnas `deleted`, `updated_at`, `device_id`, `uuid`. Estas se agregan después por `addColumnIfMissing` (líneas 701, 690 del sync), pero el CREATE TABLE base no las incluye.

**Riesgo:** Si `addColumnIfMissing` falla o no se ejecuta, los soft-deletes de `modify-items` y los triggers de sync no funcionan correctamente.

**Estado:** Detectado mediante inspección del schema.

---

## 4. Riesgos clasificados por criticidad

| Nivel | Problema | Impacto | Probabilidad |
|---|---|---|---|
| **CRÍTICO** | No hay transacciones en finalize/pay/modify-items | Inconsistencia de datos, pérdida de ítems, stock desincronizado | Media (requiere fallo a mitad) |
| **CRÍTICO** | `finalize` acepta total inflado del cliente | Cobro excesivo al cliente | Alta (fácil desde DevTools) |
| **CRÍTICO** | `finalize` merge suma valores del cliente | Inflado de totales en órdenes existentes | Media |
| **ALTO** | `modify-items` no actualiza `total` | Cobro con total desactualizado al pagar | Media |
| **ALTO** | MP `/qr` acepta total del cliente sin verificar contra BD | Pago menor al real sin detección | Media (requiere MP configurado) |
| **ALTO** | MP no vincula pago a orden local / sin webhook | Órdenes pagadas en MP que quedan pendientes localmente | Media |
| **ALTO** | No hay devolución de stock al cancelar/reabrir | Pérdida de inventario | Media |
| **MEDIO** | `decrementInventoryStock` no verifica stock suficiente | Stock negativo | Baja-Media |
| **MEDIO** | No hay protección contra doble pago concurrente | Doble cobro | Baja (requiere concurrencia exacta) |
| **BAJO** | `order_items` sin columnas `deleted`/`updated_at` en schema base | Soft-delete y sync pueden fallar | Baja |

---

## 5. Estado de las transacciones SQLite

**No hay transacciones explícitas en `routes/orders.js`.** Todas las operaciones usan `db.run` / `stmt.run` individualmente.

| Operación | ¿Atómica? | Detalle |
|---|---|---|
| `finalize` (nueva) | NO | INSERT orden + N INSERT items + N UPDATE inventory son separados |
| `finalize` (merge) | NO | N INSERT items + UPDATE totales + N UPDATE inventory son separados |
| `pay` | NO | UPDATE orden + UPDATE mesa son separados |
| `modify-items` | NO | UPDATE deleted + N INSERT items + UPDATE subtotal son separados |
| `reopen` | NO | Solo un UPDATE, pero sin devolver stock |
| `inventory/decrement` | SÍ | Usa `native.transaction()` en routes/inventory.js:92 |

**Nota:** `better-sqlite3` ejecuta cada statement en su propia transacción implícita si no se envuelve en `native.transaction()`. No hay `BEGIN IMMEDIATE` ni bloqueo de filas para prevenir condiciones de carrera.

---

## 6. Estado de los cálculos de importes

| Cálculo | ¿Server-side? | ¿Desde BD confiable? | Observación |
|---|---|---|---|
| `finalize` subtotal/tax/total | Parcial | NO | Valida total >= subtotal+tax, pero acepta valores del cliente |
| `finalize` merge | Parcial | NO | Suma valores del cliente a los existentes en BD |
| `modify-items` subtotal | SÍ | Parcial | Usa precio de BD para items de menú, pero solo actualiza `subtotal`, no `total` |
| `modify-items` total | NO | NO | Nunca se recalcula |
| `pay` total | SÍ | SÍ | Deriva de `order.total` de BD + comisión |
| `pay` commission | Parcial | Parcial | Se suma al total de BD, no se valida contra porcentaje |
| MP `/qr` total | NO | NO | Viene del cliente, no se verifica contra orden local |

---

## 7. Estado de los movimientos de stock

| Operación | ¿Descuenta stock? | ¿Devuelve stock? | ¿Verifica stock disponible? | ¿Transacción? |
|---|---|---|---|---|
| `finalize` (ítems inventory) | SÍ (`decrementInventoryStock`) | NO | NO | NO |
| `modify-items` | NO (solo reinserta ítems) | NO | NO | NO |
| `pay` | NO | NO | NO | NO |
| `update-status` → cancelled | NO | NO | NO | NO |
| `reopen` | NO | NO | NO | NO |
| `inventory/decrement` | SÍ | NO | SÍ (`MAX(0, stock-qty)`) | SÍ |

**Brecha:** `finalize` usa `decrementInventoryStock` (orders.js) que no usa `MAX(0, ...)` ni verifica stock, mientras que `inventory/decrement` sí lo hace. Inconsistencia entre las dos vías de descuento.

---

## 8. Estado de la integración Mercado Pago

| Aspecto | Estado | Observación |
|---|---|---|
| Validación de credenciales | ✅ | Verifica token con `/v1/users/me` |
| Generación de QR | ✅ | Crea orden en MP, devuelve `qr_data` |
| Verificación de pago (polling) | ✅ | Consulta `/v1/payments/search` por external_reference |
| Validación de importe vs orden local | ❌ | `total` e `items` vienen del cliente, no se verifican contra BD |
| Vinculación pago → orden local | ❌ | No guarda `in_store_order_id` en la orden |
| Webhook de confirmación | ❌ | No hay endpoint de webhook de MP |
| Reconciliación MP ↔ SQLite | ❌ | No hay proceso que confirme pagos y actualice órdenes |
| Tokens | ✅ | Se guarda hasheado/máscarado, se valida formato `APP_USR-` |

---

## 9. Pruebas existentes y pruebas faltantes

### 9.1. Pruebas existentes (`tests/orders.test.js`)

Cubren: active-count, GET /orders, history, finalize (crear, insertar items, descuento de stock, merge, notificación, 401), pay (cerrar, liberar mesa, validación, 404, idempotencia, notificación, 401), update-status, update-table, update-item-status, update-bulk-items, modify-items (validaciones, precio de BD, 401), reopen, pay seguridad de totales (total menor ignorado, total negativo, 400 sin method).

### 9.2. Pruebas faltantes (propuestas)

| # | Prueba | ¿Por qué es necesaria? |
|---|---|---|
| 1 | `finalize` con `total` muy inflado (ej. subtotal=0, total=999999) debe rechazar | Evita inflado de precios desde cliente |
| 2 | `finalize` recalcula totales desde precios de BD, no confía en `lineTotal` del cliente | Evita precios manipulados |
| 3 | `modify-items` debe actualizar `total` además de `subtotal` | Evita total desactualizado al pagar |
| 4 | `pay` con orden cuyo total de BD fue inflado previamente | Detecta inflado persistido |
| 5 | `finalize` con cantidad negativa en qty | Valida cantidades |
| 6 | `finalize` con descuento que hace total negativo | Valida descuentos |
| 7 | Dos `pay` concurrentes sobre la misma orden | Detecta doble cobro |
| 8 | `finalize` con stock insuficiente, verificar que no descanta más de lo disponible | Evita stock negativo |
| 9 | `update-status` → `cancelled` debe devolver stock | Evita pérdida de inventario |
| 10 | `reopen` debe devolver stock de ítems inventory | Evita pérdida de inventario |
| 11 | `finalize` fallido a mitad (simulado) no deja orden parcial | Prueba atomicidad (requiere mock de DB que falle) |
| 12 | MP `/qr` rechaza si `total` no coincide con orden en BD | Evita pago menor al real |
| 13 | `pay` con comisión negativa debe rechazar | Ya testeado parcialmente, completar |

---

## 10. Plan de reparación ordenado por prioridad

### P1 — CRÍTICO (hacer primero)

1. **Agregar transacciones SQLite** (`native.transaction`) a `finalize`, `pay`, `modify-items`, `reopen` para atomicidad.
2. **Recalcular totales en `finalize` desde precios de BD** (`menu_items.price` para menú, `inventory.salePrice` para inventario), no confiar en `subtotal`/`tax`/`total`/`lineTotal` del cliente.
3. **Recalcular `total` en `modify-items`** además de `subtotal`, basado en los ítems reinsertados con precios de BD.
4. **Agregar `deleted` y `updated_at` al schema base de `order_items`** en `db.js` para consistencia con soft-delete y sync.

### P2 — ALTO

5. **Devolver stock al cancelar (`update-status` → cancelled) y al reabrir (`reopen`).**
6. **Verificar stock suficiente antes de descontar** en `decrementInventoryStock` (o usar `inventory/decrement` que ya tiene `MAX(0, ...)`).
7. **Validar total de MP `/qr` contra la orden en SQLite** antes de crear el QR.
8. **Guardar `in_store_order_id` de MP en la orden local** y agregar endpoint de webhook para confirmar pagos.

### P3 — MEDIO

9. **Protección contra doble pago concurrente** (bloqueo de fila o verificación de `paymentMethod` dentro de la transacción de `pay`).
10. **Usar `inventory/decrement` (que ya es atómico y seguro) en lugar de `decrementInventoryStock`** en `finalize`, o hacer que `decrementInventoryStock` use la misma lógica `MAX(0, ...)`.

---

## 11. Confirmación

- ✅ No se modificaron archivos de producción durante esta auditoría
- ✅ No se modificó la base de datos real
- ✅ No se ejecutaron cobros reales ni solicitudes a Mercado Pago
- ✅ No se alteraron datos de clientes
- ✅ No se cambió la autenticación
- ✅ No se modificó la sincronización ya reparada
- ✅ No se ejecutó `npm audit fix --force`
- ✅ No se eliminaron pruebas existentes
- ✅ No se realizaron refactorizaciones generales

**Estado:** Auditoría completa. **No se han implementado correcciones.** Se espera autorización para proceder con la fase de reparación (Fase 2 implementación).
