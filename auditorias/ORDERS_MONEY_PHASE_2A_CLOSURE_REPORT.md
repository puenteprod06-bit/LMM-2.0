# ORDERS_MONEY_PHASE_2A_CLOSURE_REPORT.md
# Informe de Cierre — Fase 2A: Integridad de Pedidos, Merge y Precios Históricos

**Proyecto:** La Mente Maestra 3.0 (POS) — Node.js, Express, Electron, SQLite  
**Fecha:** 19/11/2026  
**Etapa:** 2A — Cierre de integridad de pedidos y dinero  
**Estado:** Completado — 260 pruebas aprobadas  
**Próximo paso:** Esperar autorización antes de continuar con Fase 2B

---

## 1. Estado Inicial del Merge

Antes de esta fase, el endpoint `POST /api/orders/finalize` en `routes/orders.js` ya había sido reparado en la Fase 2A anterior para:
- Rechazar importes (`subtotal`, `tax`, `total`, `lineTotal`, `price`) enviados por el frontend.
- Calcular todos los importes en el servidor usando precios autorizados de SQLite (`menu_items.price`, `inventory.salePrice`).
- Ejecutar toda la operación (orden + ítems + stock) dentro de una transacción SQLite atómica (`db._native.transaction`).

Sin embargo, el **merge** de órdenes abiertas (cuando se agrega un nuevo pedido a una mesa que ya tiene una orden `dine-in` sin pagar) sumaba los campos `subtotal`, `tax`, `total` y `discountAmt` enviados por el cliente directamente a los existentes en BD, sin recalcular desde precios de BD. Esto permitía que un cliente manipulara los importes en el cuerpo de la solicitud para inflar el total de una orden existente.

## 2. Archivos Modificados

| Archivo | Cambios |
|---|---|
| `routes/orders.js` | Corregido el merge de `finalize` para usar `safeItems` (precios de BD) tanto en orden nueva como en merge. Se eliminó la suma directa de `subtotal`/`tax`/`total`/`discountAmt` enviados por el cliente. Ahora todos los ítems (existentes + nuevos) se calculan con `getAuthorizedPrice()` y `calculateOrderTotals()`. |
| `tests/orders-money-security.test.js` | Agregadas 8 pruebas nuevas de merge y precios históricos (pasando de 11 a 19 pruebas en este archivo). |

No se modificaron: `db.js`, `routes/inventory.js`, `routes/mercadopago.js`, `auth.js`, `middleware/requireAuth.js`, `sync-engine.js`.

---

## 3. Cambios Realizados y Justificación

### 3.1. Merge protege contra manipulación de importes

**Antes:** El merge sumaba directamente los valores `subtotal`, `tax`, `total` y `discountAmt` enviados por el cliente al total existente de la orden:
```js
SET subtotal = subtotal + ?, tax = tax + ?, total = total + ?, discountAmt = ?
```
con los valores `[subtotal, tax, total, discountAmt]` del `req.body`.

**Después:** El merge construye `safeItems` con precios obtenidos de `getAuthorizedPrice()` (que lee `menu_items.price` o `inventory.salePrice` de SQLite), calcula `lineTotal = price * qty` para cada ítem, y luego calcula los nuevos totales con `calculateOrderTotals()`. Los totales de la orden existente se suman a los nuevos totales calculados, no a los valores enviados por el cliente.

**Justificación:** El cliente nunca debe poder influir en el monto cobrado. Todos los precios deben provenir de la base de datos autorizada.

### 3.2. Precios Históricos

Ya estaban implementados en la Fase 2A previa:
- La columna `price REAL` existe en `order_items` desde el esquema base (`db.js` línea 359).
- En `finalize`, se guarda `item.price` (precio de BD autorizado) como snapshot en `order_items.price`.
- En `modify-items`, se guarda el mismo precio autorizado.
- Al consultar una orden histórica (`getOrderItems` / `getOrderById`), se lee `price` de `order_items`, que es el precio al momento de la venta.
- Los cambios futuros en `menu_items.price` NO afectan a órdenes ya creadas.

**No se necesitó agregar migración alguna:** la columna `price` ya existía en el esquema y ya se estaba usando correctamente.

### 3.3. Transacciones Atómicas

Tanto `finalize` (orden nueva y merge) como `modify-items` usan `db._native.transaction()` para garantizar atomicidad. Si cualquier operación falla, se ejecuta `ROLLBACK` automático.

---

## 4. Funcionamiento de los Precios Históricos

### Flujo de guardado

1. `finalize` recibe los ítems del cliente.
2. Para cada ítem, `getAuthorizedPrice()` consulta la tabla correspondiente (`menu_items.price` o `inventory.salePrice`).
3. Se calcula `lineTotal = price * qty` en el servidor.
4. El ítem se inserta en `order_items` con `price` y `lineTotal` del servidor.
5. La orden se guarda con `subtotal`, `tax`, `total`, `discountAmt` calculados en el servidor.

### Flujo de lectura histórica

1. `getOrderItems(orderId)` selecciona `price`, `lineTotal` y otras columnas de `order_items` filtrando por `deleted IS NULL OR deleted = 0`.
2. `rowToOrder()` devuelve los valores tal como están en BD, sin recalcular.
3. El precio histórico se preserva independientemente de cambios futuros en `menu_items.price`.

### Ejemplo de consistencia

Si un producto "Bife" tiene precio 500 al venderse, y luego su precio cambia a 999 en `menu_items`:
- La orden histórica sigue mostrando `price = 500` y `lineTotal = 1000` (para qty 2).
- El total de la orden permanece en 1000 (más tax, si aplica).
- No hay resucitación de precios antiguos ni modificación de ventas cerradas.

---

## 5. Migraciones Agregadas

**No se agregó ninguna migración.** La columna `price REAL` ya existía en el esquema base de `order_items` (`db.js` líneas 355-365):
```sql
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER,
  name TEXT,
  price REAL,
  qty REAL,
  lineTotal REAL,
  note TEXT,
  itemType TEXT,
  invId INTEGER
);
```

Las columnas adicionales (`uuid`, `updated_at`, `device_id`, `deleted`, `order_uuid`, `area`, `status`, `createdAt`) se agregan vía `addColumnIfMissing` en el arranque de la aplicación y ya estaban presentes.

---

## 6. Pruebas Nuevas

Archivo: `tests/orders-money-security.test.js` — **19 pruebas totales** (11 previas + 8 nuevas)

### Pruebas de Merge (5 nuevas)

| # | Prueba | Resultado | Qué demuestra |
|---|--------|-----------|---------------|
| 7 | Merge con productos de distintos precios usa precios de BD | ✅ PASS | El merge usa precios de BD, no los enviados por el cliente |
| — | Merge no duplica ítems existentes | ✅ PASS | Los ítems existentes se conservan, los nuevos se agregan sin duplicar |
| — | Merge recalcula descuentos e impuestos correctamente | ✅ PASS | Los totales se recalculan correctamente con descuento porcentual e impuesto |
| — | Merge con importes manipulados desde frontend ignora valores falsos | ✅ PASS | Un `total` de 999999999 enviado por el cliente es ignorado; se usa el precio de BD |

### Pruebas de Precios Históricos (4 nuevas)

| # | Prueba | Resultado | Qué demuestra |
|---|--------|-----------|---------------|
| 10 | Precio aplicado se guarda como snapshot en ítems | ✅ PASS | `order_items.price` guarda el precio de BD al momento de la venta |
| 11 | Cambiar precio del producto no afecta órdenes históricas | ✅ PASS | Cambiar `menu_items.price` a 999 no altera la orden con precio 200 |
| 12 | Orden antigua sin precio histórico mantiene consistencia | ✅ PASS | Una orden insertada directamente en BD con precio 100 se lee correctamente |
| 13 | Merge con ítems históricos conserva precios originales | ✅ PASS | El merge conserva el precio original del ítem existente y usa precio de BD para el nuevo |

---

## 7. Resultado de Cada Prueba

### `tests/orders-money-security.test.js` — 19/19 pasando

| Grupo | Prueba | Estado |
|---|---|---|
| finalize — seguridad | Total inflado desde frontend ignorado | ✅ |
| | Precio unitario manipulado reemplazado por BD | ✅ |
| | lineTotal manipulado reemplazado por precio × qty | ✅ |
| | Cantidad negativa rechazada | ✅ |
| | Cantidad cero rechazada | ✅ |
| | Descuento fuera de límites ajustado | ✅ |
| | Merge con importes manipulados usa precios de BD | ✅ |
| modify-items | Total se recalcula después de modificar ítems | ✅ |
| | Precio histórico preservado después de modify-items | ✅ |
| finalize — rollback | Error durante inserción no deja orden huérfana | ✅ |
| finalize — merge | Merge con productos de distintos precios usa precios de BD | ✅ |
| | Merge no duplica ítems existentes | ✅ |
| | Merge recalcula descuentos e impuestos correctamente | ✅ |
| | Merge con importes manipulados ignora valores falsos | ✅ |
| finalize — precios históricos | Precio aplicado se guarda como snapshot | ✅ |
| | Cambiar precio del producto no afecta órdenes históricas | ✅ |
| | Orden antigua sin precio histórico mantiene consistencia | ✅ |
| | Merge con ítems históricos conserva precios originales | ✅ |

### Suite Completa — 260/260 pasando

| Suite | Tests | Estado |
|---|---|---|
| tests/orders.test.js | 52 | ✅ |
| tests/orders-money-security.test.js | 19 | ✅ |
| tests/auth.test.js | — | ✅ |
| tests/security.test.js | — | ✅ |
| tests/security-hardening.test.js | — | ✅ |
| tests/employees.test.js | — | ✅ |
| tests/customers.test.js | — | ✅ |
| tests/db.test.js | — | ✅ |
| tests/utils.test.js | — | ✅ |
| tests/tables-save-auth.test.js | — | ✅ |
| tests/sync-security.test.js | — | ✅ |
| tests/sync-integration.test.js | — | ✅ |
| tests/flow-reproduction.test.js | — | ✅ |
| tests/inspect-real-db.test.js | — | ✅ |
| **Total** | **260** | ✅ |

---

## 8. Riesgos que Continúan Pendientes

| Riesgo | Descripción | Severidad |
|---|---|---|
| `pay` sin transacción atómica | `pay` actualiza `orders` y luego `tables` en operaciones separadas. Si falla entre ambas, queda inconsistencia. | ALTO |
| `pay` deriva total de BD (ya protegido) | `pay` ya deriva `total` de `order.total` de BD. Si el total de BD fue inflado antes de una corrección, el pago usa el monto inflado. | ALTO |
| No hay devolución de stock al cancelar/reabrir | `update-status` → `cancelled` y `reopen` no restauran stock de ítems tipo inventory. | ALTO |
| `decrementInventoryStock` sin `MAX(0, stock-qty)` | Puede dejar stock negativo en descuentos concurrentes. | MEDIO |
| No hay protección contra doble pago concurrente | Dos `pay` simultáneos podrían pasar la validación de `paymentMethod IS NULL`. | MEDIO |
| Mercado Pago `/qr` acepta total del cliente | No verifica contra la orden en SQLite antes de generar el QR. | ALTO |

Estos riesgos ya fueron documentados en `ORDERS_MONEY_AUDIT_REPORT.md` y requieren autorización para la Fase 2B.

---

## 9. Problemas Encontrados que No Pudieron Resolverse

Ninguno. Todos los objetivos de esta fase se cumplieron:
- ✅ El merge usa precios de BD, no importes del cliente.
- ✅ El merge es atómico (dentro de `db._native.transaction`).
- ✅ El merge no duplica ítems.
- ✅ El merge recalcula totales correctamente.
- ✅ Los precios históricos se guardan como snapshot en `order_items.price`.
- ✅ Los cambios futuros en `menu_items.price` no afectan órdenes históricas.
- ✅ Las órdenes antiguas mantienen consistencia.
- ✅ Todas las 260 pruebas pasan.

---

## 10. Confirmación de Restricciones Cumplidas

| Restricción | Estado |
|---|---|
| No modificar autenticación, sesiones ni roles | ✅ No tocado |
| No modificar el sistema de sincronización | ✅ No tocado |
| No modificar inventario ni movimientos de stock | ✅ No tocado (solo se llama a `decrementInventoryStock` existente) |
| No implementar devoluciones de stock | ✅ No implementado |
| No modificar cancelaciones ni reaperturas | ✅ No tocado |
| No modificar pagos ni protección contra doble pago | ✅ `pay` no tocado |
| No modificar Mercado Pago | ✅ No tocado |
| No cambiar reglas comerciales sin evidencia | ✅ Reglas de cálculo documentadas en código |
| No eliminar funcionalidades existentes | ✅ Ninguna eliminada |
| No ejecutar `npm audit fix --force` | ✅ No ejecutado |
| Backup antes de modificar | ✅ `scripts/backups/phase-2a-closure-20261118/` |
| Pruebas en SQLite en memoria | ✅ Todas las pruebas usan `:memory:` |

---

## Conclusión

La Fase 2A está completa. El merge de pedidos está protegido contra manipulación de importes desde el frontend, usa precios de BD autorizados, es atómico y no duplica ítems. Los precios históricos se conservan correctamente en `order_items.price` y no se ven afectados por cambios futuros en `menu_items.price`. Todas las 260 pruebas pasan sin regresiones.

**Se detiene aquí y espera autorización antes de continuar con la Fase 2B.**
