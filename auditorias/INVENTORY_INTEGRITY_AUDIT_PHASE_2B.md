# INVENTORY_INTEGRITY_AUDIT_PHASE_2B.md
# Informe de Auditoría de Integridad del Inventario — Fase 2B

**Proyecto:** La Mente Maestra 3.0 (POS) — Node.js, Express, Electron, SQLite  
**Fecha:** 19/11/2026  
**Tipo:** Auditoría de investigación y diagnóstico (SIN modificaciones de código)  
**Estado:** Informe final — Pendiente de autorización para Fase 2B implementación

---

## 1. Resumen Ejecutivo

La auditoría de inventario identificó múltiples riesgos críticos en el flujo de stock:

1. **No existe tabla de movimientos de stock** — No hay trazabilidad de quién, cuándo, cuánto y por qué cambió el stock de cada producto.
2. **No se verifica stock suficiente antes de descontar** — `decrementInventoryStock` usa `MAX(0, stock - qty)` que permite stock cero pero no rechaza cuando no hay suficiente; puede dejar stock en 0 sin advertencia.
3. **No hay devolución de stock al cancelar/reabrir/modificar** — `update-status` (cancelled), `reopen`, y `modify-items` no restauran el stock de ítems eliminados o reducidos.
4. **`modify-items` puede causar doble descuento** — Hace soft-delete de ítems existentes y descuenta stock de los nuevos, pero no reintegra el stock de los ítems soft-deleted.
5. **No hay protección contra doble descuento en `finalize`** — Un pedido puede ser finalizado múltiples veces si no hay control de estado previo.
6. **Sincronización de inventario por upsert de stock absoluto** — Si dos dispositivos descuentan el mismo producto, el último sobrescribe el stock del primero (no hay reconciliación de movimientos).
7. **No hay transacción que abarque pedido + stock en `pay`** — `pay` solo actualiza la orden, no toca el stock (el descuento ocurre en `finalize`).

---

## 2. Arquitectura Actual del Inventario

### 2.1 Tablas Relacionadas (db.js)

| Tabla | Columnas relevantes | Propósito |
|-------|---------------------|-----------|
| `inventory` | id, name, stock, minStock, unit, cost, salePrice, category, deleted, uuid, updated_at, device_id, area | Stock actual de productos |
| `order_items` | id, order_id, name, price, qty, lineTotal, itemType, invId, area, status, deleted, uuid | Ítems de pedidos (invId referencia a inventory.id) |
| `orders` | id, subtotal, tax, total, status, paymentMethod, tableId, ... | Órdenes/pedidos |
| `stock_alert_config` | id, enabled, threshold | Configuración de alerta de stock mínimo (no es movimiento) |
| `sync_queue` | id, table_name, row_uuid, operation, created_at, synced | Cola de cambios para sincronización |
| `_sync_flag` | rowid_pk, applying_remote | Bandera para evitar loops de sincronización |

**No existe tabla `stock_movements`** ni equivalente para rastrear movimientos individuales de stock.

### 2.2 Columnas de `inventory` (db.js líneas 298-311)

```sql
CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  stock REAL DEFAULT 0,
  minStock REAL DEFAULT 5,
  unit TEXT DEFAULT 'unidad',
  cost REAL DEFAULT 0,
  salePrice REAL DEFAULT 0,
  category TEXT DEFAULT 'General',
  expirationDate TEXT,
  notes TEXT,
  emoji TEXT DEFAULT '📦',
  showInPOS INTEGER DEFAULT 0
);
```

Columnas de sincronización agregadas vía `addColumnIfMissing`: uuid, updated_at, device_id, deleted.

---

## 3. Flujo Completo del Stock (ETAPA 3)

### 3.1. Crear un pedido (finalize — routes/orders.js:178)

| Paso | Función | Tabla modificada | Stock | Transacción |
|------|---------|------------------|-------|-------------|
| 1 | `finalize` → INSERT en `orders` | `orders` | No | Sí (db._native.transaction) |
| 2 | `finalize` → INSERT en `order_items` | `order_items` | No | Sí |
| 3 | `finalize` → `decrementInventoryStock()` | `inventory` | **Descuenta** `stock = stock - qty` por cada ítem con `itemType === 'inventory'` | Sí |

**Riesgo:** No verifica `stock >= qty` antes de descontar. Usa `MAX(0, stock - qty)` que permite llegar a 0 pero no rechaza si no hay suficiente.

### 3.2. Agregar productos (modify-items — routes/orders.js:469)

| Paso | Función | Tabla modificada | Stock | Transacción |
|------|---------|------------------|-------|-------------|
| 1 | `modify-items` → UPDATE `order_items SET deleted = 1` | `order_items` | No (soft-delete) | Sí |
| 2 | `modify-items` → INSERT nuevos ítems en `order_items` | `order_items` | No | Sí |
| 3 | `modify-items` → `decrementInventoryStock()` con los NUEVOS ítems | `inventory` | **Descuenta** stock de nuevos ítems | Sí |
| 4 | `modify-items` → UPDATE `orders` (totales) | `orders` | No | Sí |

**Riesgo CRÍTICO:** Los ítems soft-deleted (paso 1) ya tuvieron su stock descontado cuando se crearon originalmente. Al hacer `decrementInventoryStock` solo con los nuevos ítems (paso 3), el stock de los ítems eliminados **no se reintegra**, causando doble descuento si el usuario reduce cantidades o elimina productos.

### 3.3. Finalizar pedido (pay — routes/orders.js:343)

| Paso | Función | Tabla modificada | Stock | Transacción |
|------|---------|------------------|-------|-------------|
| 1 | `pay` → UPDATE `orders` (paymentMethod, status='delivered') | `orders` | No | No (db.run individual, sin transacción con stock) |
| 2 | `pay` → UPDATE `tables` (liberar mesa) | `tables` | No | No |

**Observación:** `pay` NO descuenta stock. El descuento ya ocurrió en `finalize`. `pay` solo marca la orden como entregada.

### 3.4. Modificar pedido (modify-items)

Ver sección 3.2 arriba. El stock de ítems eliminados no se reintegra.

### 3.5. Cancelar pedido (update-status — routes/orders.js:422)

| Paso | Función | Tabla modificada | Stock | Transacción |
|------|---------|------------------|-------|-------------|
| 1 | `update-status` → UPDATE `orders SET status = 'cancelled'` | `orders` | No | No |

**Riesgo:** Al cancelar una orden, **no se devuelve el stock** que se descontó en `finalize`. El stock queda permanentemente reducido aunque la orden esté cancelada.

### 3.6. Reabrir pedido (reopen — routes/orders.js:639)

| Paso | Función | Tabla modificada | Stock | Transacción |
|------|---------|------------------|-------|-------------|
| 1 | `reopen` → UPDATE `orders` (paymentMethod=NULL, status='active') | `orders` | No | No |

**Riesgo:** Al reabrir una orden cancelada o entregada, **no se devuelve el stock**. Además, si la orden se vuelve a finalizar, el stock se descontaría **segunda vez**.

### 3.7. Sincronización con Supabase (sync-engine.js)

| Paso | Función | Tabla modificada | Stock | Transacción |
|------|---------|------------------|-------|-------------|
| 1 | Triggers de db.js encolan en `sync_queue` | `sync_queue` | No | Sí (dentro de trigger) |
| 2 | `flushQueue()` lee `sync_queue` y hace upsert a Supabase | `sync_inventory` (nube) | Envía `stock` actual | No (async) |
| 3 | `applyRemoteRow()` aplica cambios remotos localmente | `inventory` | **Sobreescribe** `stock` con valor remoto | Sí (transacción local) |

**Riesgo:** El upsert de Supabase escribe el `stock` absoluto, no el delta. Si dos dispositivos descuentan el mismo producto, el último escribe sobre el primero, perdiendo el descuento del primero.

---

## 4. Funciones y Archivos Involucrados

| Archivo | Función | Líneas | Rol en inventario |
|---------|---------|--------|-------------------|
| `routes/orders.js` | `decrementInventoryStock()` | 139-151 | Descuenta stock de ítems tipo inventory |
| `routes/orders.js` | `finalize` | 178-341 | Crea orden, descuenta stock en transacción |
| `routes/orders.js` | `modify-items` | 469-588 | Soft-delete ítems, inserta nuevos, descuenta stock de nuevos |
| `routes/orders.js` | `pay` | 343-420 | Cierra orden, no toca stock |
| `routes/orders.js` | `reopen` | 639-672 | Reabre orden, no devuelve stock |
| `routes/orders.js` | `update-status` | 422-440 | Cambia estado, no devuelve stock al cancelar |
| `routes/inventory.js` | `inventory/save` | 23-59 | Crea/edita producto, puede establecer stock inicial |
| `routes/inventory.js` | `inventory/decrement` | 78-109 | Descuento atómico con `MAX(0, stock - qty)` |
| `routes/inventory.js` | `inventory/:id` DELETE | 62-70 | Soft-delete de producto |
| `db.js` | Triggers de sync_queue | ~838-925 | Encolan cambios de inventory en sync_queue |
| `sync-engine.js` | `applyRemoteRow()` | 505-592 | Aplica cambios remotos de inventory (sobrescribe stock) |
| `sync-engine.js` | `flushQueue()` | 307-374 | Envía stock local a Supabase |

---

## 5. Hallazgos Técnicos

### 5.1. Hallazgo 1: No existe tabla de movimientos de stock

**Archivo:** `db.js` (líneas 298-311 para tabla `inventory`, líneas 528-533 para `stock_alert_config`)

**Comportamiento actual:** Solo existe `stock_alert_config` que almacena configuración de alerta (umbral), no movimientos históricos. No hay tabla `stock_movements` ni equivalente.

**Riesgo:** No hay trazabilidad de:
- Quién modificó el stock
- Cuándo se modificó
- Cuánto se modificó
- Por qué (venta, ajuste, pérdida, robo)
- Qué orden o usuario originó el cambio

**Ejemplo reproducible:** Si el stock de "Cerveza" pasa de 10 a 7, no hay registro de que 3 unidades se descontaron por la orden #45 en la Mesa 1.

---

### 5.2. Hallazgo 2: No se verifica stock suficiente antes de descontar

**Archivo:** `routes/orders.js` línea 140-151 (`decrementInventoryStock`)

**Comportamiento actual:**
```javascript
const stmt = db.prepare(
  `UPDATE inventory SET stock = MAX(0, COALESCE(stock,0) - ?) WHERE id = ? AND (deleted IS NULL OR deleted = 0)`
);
for (const item of items) {
  if (item && item.itemType === 'inventory' && item.invId) {
    const qty = Number(item.qty) || 0;
    if (qty > 0) stmt.run(qty, item.invId);
  }
}
```

**Riesgo:** Si hay stock de 5 y se intenta descontar 10, el stock queda en 0 sin advertencia. No hay error, no hay rechazo. El cliente cree que compró 10 unidades pero solo había 5.

**Comparación:** `routes/inventory.js` línea 78-109 (`inventory/decrement`) usa la misma lógica `MAX(0, COALESCE(stock,0) - ?)`, tampoco verifica stock suficiente.

---

### 5.3. Hallazgo 3: No hay devolución de stock al cancelar (update-status)

**Archivo:** `routes/orders.js` línea 422-440 (`update-status`)

**Comportamiento actual:** Cuando se cambia el estado de una orden a `'cancelled'`, solo se actualiza el campo `status` en `orders`. No se devuelve el stock de los ítems tipo inventory.

**Riesgo:** Un pedido cancelado sigue teniendo su stock descontado. El producto queda "consumido" aunque nunca se entregó.

---

### 5.4. Hallazgo 4: No hay devolución de stock al reabrir (reopen)

**Archivo:** `routes/orders.js` línea 639-672 (`reopen`)

**Comportamiento actual:** `reopen` solo hace:
```sql
UPDATE orders SET paymentMethod = NULL, status = 'active', closedAt = NULL, paidAt = NULL, updatedAt = ?
```

**Riesgo:** Si una orden fue pagada y entregada (stock descontado en finalize), y se reabre, el stock **no se devuelve**. Si luego se vuelve a finalizar la misma orden, el stock se descuenta **segunda vez**.

---

### 5.5. Hallazgo 5: `modify-items` puede causar doble descuento de stock

**Archivo:** `routes/orders.js` línea 469-588 (`modify-items`)

**Comportamiento actual:**
1. Soft-delete de ítems existentes: `UPDATE order_items SET deleted = 1` (los ítems ya tuvieron su stock descontado cuando se crearon)
2. Insertar nuevos ítems
3. `decrementInventoryStock(safeItems)` — solo descuenta los **nuevos** ítems

**Riesgo:** Si un pedido tiene 2 cervezas (stock -2) y el usuario modifica para tener solo 1 cerveza:
- El ítem original se soft-delete (pero su stock -1 ya no se devuelve)
- El nuevo ítem tiene qty=1 (stock -1 adicional)
- Stock total descontado: 2 (original) + 1 (nuevo) = 3, pero solo debería ser 1.

---

### 5.6. Hallazgo 6: `finalize` no tiene protección contra doble ejecución

**Archivo:** `routes/orders.js` línea 178-341 (`finalize`)

**Comportamiento actual:** Para orden nueva, siempre inserta en `orders` y `order_items` y descuenta stock. No verifica si la orden ya fue procesada previamente.

**Riesgo:** Si el cliente hace clic en "Finalizar" dos veces rápido, o si hay un reintento de red, se podrían crear dos órdenes con el mismo contenido y descontar stock dos veces.

---

### 5.7. Hallazgo 8: Sincronización de stock por upsert absoluto (no delta)

**Archivo:** `sync-engine.js` línea 307-374 (`flushQueue`) y línea 505-592 (`applyRemoteRow`)

**Comportamiento actual:** Cuando se sube inventory a Supabase, se envía el objeto completo con `stock` actual. Cuando se recibe un cambio remoto, se hace `UPDATE inventory SET stock = ? WHERE uuid = ?`.

**Riesgo:** Si dos dispositivos descuentan el mismo producto simultáneamente:
- Dispositivo A: stock 10 → descuenta 3 → stock 7
- Dispositivo B: stock 10 → descuenta 2 → stock 8
- El último en sincronizar escribe stock 8 (o 7), perdiendo el descuento del otro.

No hay reconciliación de movimientos, solo sobrescritura de valor absoluto.

---

## 6. Riesgos Clasificados por Severidad

| Severidad | Problema | Archivo | Líneas |
|-----------|----------|---------|--------|
| CRÍTICO | `modify-items` no reintegra stock de ítems soft-deleted → doble descuento | `routes/orders.js` | 469-588 |
| CRÍTICO | `reopen` no devuelve stock → doble descuento al volver a finalizar | `routes/orders.js` | 639-672 |
| CRÍTICO | `update-status` (cancelled) no devuelve stock | `routes/orders.js` | 422-440 |
| CRÍTICO | No existe tabla de movimientos de stock → no hay trazabilidad | `db.js` | 298-311 |
| ALTO | `decrementInventoryStock` no verifica stock suficiente → stock negativo | `routes/orders.js` | 139-151 |
| ALTO | Sincronización por upsert absoluto → pérdida de descuentos concurrentes | `sync-engine.js` | 307-374, 505-592 |
| ALTO | `finalize` sin protección contra doble ejecución → doble descuento | `routes/orders.js` | 178-341 |
| MEDIO | `inventory/decrement` (ruta separada) tampoco verifica stock suficiente | `routes/inventory.js` | 78-109 |
| MEDIO | No hay transacción que abarque `pay` + posible ajuste de stock | `routes/orders.js` | 343-420 |

---

## 7. Matriz de Pruebas Existentes y Faltantes

### 7.1. Pruebas Existentes

| Prueba | Archivo | Línea | Qué cubre |
|--------|---------|-------|-----------|
| `descuenta stock de inventario al usar itemType=inventory` | `tests/orders.test.js` | 267-280 | Verifica que `finalize` descuenta stock de ítems tipo inventory |
| (ninguna más) | — | — | No hay pruebas de cancelación, reapertura, modify-items, stock insuficiente, doble descuento, sincronización |

### 7.2. Pruebas Faltantes (identificadas pero no escritas)

| # | Escenario | Por qué es necesaria |
|---|-----------|----------------------|
| 1 | Stock insuficiente: intentar descontar más de lo disponible | Verificar que no permita stock negativo |
| 2 | Stock exactamente igual a qty | Verificar límite exacto |
| 3 | Cantidades decimales en stock | Verificar manejo de decimales |
| 4 | Dos operaciones simultáneas (race condition) | Verificar integridad bajo concurrencia |
| 5 | Finalización duplicada (mismo pedido dos veces) | Verificar idempotencia |
| 6 | Error durante descuento de stock (rollback) | Verificar que no quede orden sin stock descontado ni stock descontado sin orden |
| 7 | Modificación de cantidades en modify-items | Verificar que se ajuste stock correctamente |
| 8 | Eliminación de ítems en modify-items | Verificar que se reintegre stock de ítems eliminados |
| 9 | Cancelación de orden (update-status cancelled) | Verificar si se devuelve stock |
| 10 | Reapertura de orden (reopen) | Verificar si se devuelve stock |
| 11 | Devolución duplicada (cancelar dos veces) | Verificar que no se devuelva dos veces |
| 12 | Sincronización repetida de mismo cambio | Verificar idempotencia en sync |
| 13 | Recuperación después de cierre inesperado | Verificar consistencia después de fallo |

---

## 8. Propuesta de Reparación Dividida en Etapas

### Etapa 1: Trazabilidad (infraestructura)
- Crear tabla `stock_movements` con columnas: id, inventory_id, order_id, order_item_id, quantity_change, type ('sale'|'return'|'adjustment'), reason, user_id, created_at, uuid, device_id, deleted
- Agregar columnas `created_by` y `movement_type` si es necesario

### 2. Ajuste de stock en `finalize`
- Agregar verificación de stock suficiente ANTES de descontar
- Rechazar con 400 si stock insuficiente
- Registrar movimiento en `stock_movements`

### 3. Devolución de stock en `modify-items`
- Calcular diferencia entre qty antigua y nueva por ítem
- Reintegrar stock de ítems reducidos o eliminados
- Descontar solo la diferencia positiva de ítems nuevos o aumentados

### 4. Devolución de stock en `update-status` (cancelled)
- Al cambiar a 'cancelled', reintegrar stock de todos los ítems tipo inventory de la orden

### 5. Devolución de stock en `reopen`
- Al reabrir, reintegrar stock de todos los ítems tipo inventory de la orden (si la orden estaba pagada/entregada)

### 6. Protección contra doble descuento en `finalize`
- Verificar que la orden no haya sido finalizada previamente (paymentMethod == NULL y status != 'delivered')

### 7. Sincronización de inventario
- Cambiar de upsert de stock absoluto a sincronización de movimientos (delta)
- O al menos, aplicar `stock = stock - delta_remoto` en lugar de `stock = valor_remoto`

---

## 9. Reglas Comerciales que Necesitan Confirmación

Antes de implementar cualquier corrección, se deben confirmar las siguientes reglas de negocio con el cliente:

1. **¿Qué pasa si un cliente pide más stock del disponible?** ¿Se rechaza la orden completa o solo los ítems sin stock?
2. **¿Se permite stock negativo en algún caso?** (ej. pedidos por proveedor en camino)
3. **¿Cuándo se descuenta stock?** ¿Al crear la orden (finalize) o al pagarla (pay)? Actualmente es en finalize.
4. **¿Cuándo se devuelve stock?** ¿Solo al cancelar, también al reabrir, también al modificar cantidades a la baja?
5. **¿Quién es el usuario responsable de un movimiento de stock?** ¿Existe sesión de usuario en el contexto de la operación?
6. **¿El stock de productos tipo `menu` también se descuenta?** Actualmente solo `itemType === 'inventory'` descuenta stock.

---

## 10. Archivos que Deberían Modificarse en Futura Implementación

| Archivo | Cambio esperado |
|---------|-----------------|
| `db.js` | Agregar tabla `stock_movements` |
| `routes/orders.js` | `finalize`: verificar stock suficiente, registrar movimiento; `modify-items`: reintegrar stock de ítems eliminados/reducidos; `reopen`: devolver stock; `update-status`: devolver stock al cancelar |
| `routes/inventory.js` | `inventory/decrement`: verificar stock suficiente antes de descontar |
| `sync-engine.js` | Sincronizar movimientos de stock (delta) en lugar de stock absoluto |

---

## 10. Evidencia de Cada Hallazgo

### Evidencia 1: No hay tabla de movimientos
**Archivo:** `db.js` líneas 298-311 — La tabla `inventory` solo tiene `stock` como valor actual. No hay tabla relacionada para rastrear cambios individuales.

### Evidencia 2: No se verifica stock suficiente
**Archivo:** `routes/orders.js` línea 143-149 — `stmt.run(qty, item.invId)` se ejecuta sin verificar `stock >= qty`. Solo usa `MAX(0, ...)` para evitar negativo, pero no rechaza la operación.

### Evidencia 3: No hay devolución al cancelar
**Archivo:** `routes/orders.js` línea 422-440 — `update-status` solo hace `UPDATE orders SET status = ?`. No hay código que toque `inventory`.

### Evidencia 4: No hay devolución al reabrir
**Archivo:** `routes/orders.js` línea 639-672 — `reopen` solo hace `UPDATE orders SET paymentMethod = NULL, status = 'active'`. No toca `inventory`.

### Evidencia 5: Doble descuento en modify-items
**Archivo:** `routes/orders.js` línea 545-547 (soft-delete) y 568-572 (decrementInventoryStock con nuevos ítems solo). Los ítems soft-deleted ya tuvieron stock descatdo originalmente, pero no se reintegra.

### Evidencia 6: Sincronización por upsert absoluto
**Archivo:** `sync-engine.js` línea 344-351 (`rowsToUpsert.push` con `data: sanitizeOutputColumns(table, localRow)` que incluye `stock`) y línea 557-561 (`UPDATE ${table} SET ${setClause} WHERE uuid = ?` que sobrescribe stock).

---

**Fin del informe. No se ha modificado ningún archivo de producción durante esta auditoría.** Se espera autorización expresa para comenzar la implementación de la Fase 2B (reparación).
