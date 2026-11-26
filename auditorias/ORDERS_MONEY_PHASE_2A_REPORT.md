# ORDERS_MONEY_PHASE_2A_REPORT.md
# Informe de Fase 2A — Reparación de integridad de pedidos y dinero

**Proyecto:** La Mente Maestra 3.0 (POS) — Node.js, Express, Electron, SQLite  
**Fecha:** 18/11/2026  
**Etapa:** 2A — Reparación de integridad de pedidos y dinero  
**Estado:** Reparación aplicada y verificada — 252 pruebas aprobadas  
**Próximo paso:** Esperar autorización antes de continuar con Fase 2B

---

## 1. Archivos modificados

| Archivo | Cambios |
|---|---|
| `routes/orders.js` | Reparación de `finalize`, `modify-items` y agregado de helpers `getOrderByIdSync`, `getAuthorizedPrice`, `calculateOrderTotals` |
| `tests/orders-money-security.test.js` | Nuevo archivo con 11 pruebas de seguridad e integridad |

No se modificó: `db.js`, `routes/inventory.js`, `routes/mercadopago.js`, `routes/config.js`, `auth.js`, `middleware/requireAuth.js`, `sync-engine.js`.

---

## 2. Backups realizados

| Archivo | Ruta del backup |
|---|---|
| `routes/orders.js` | `scripts/backups/phase-2a-20261118/routes/orders.js.bak` |
| `db.js` | `scripts/backups/phase-2a-20261118/db.js.bak` |

---

## 3. Reglas de cálculo implementadas

Todas las fórmulas se calculan en el servidor a partir de precios autorizados de SQLite. El frontend puede enviar `subtotal`, `tax`, `total`, `lineTotal`, `price` pero son ignorados para el cálculo final.

| Paso | Fórmula | Fuente |
|---|---|---|
| `precio_unitario` | `menu_items.price` (para tipo menu) / `inventory.salePrice` (para tipo inventory) / precio del cliente (solo para otros tipos, como snapshot) | SQLite |
| `line_total` | `precio_unitario * qty` | Servidor |
| `subtotal` | `SUM(line_total)` de todos los ítems | Servidor |
| `discountAmt` | `percent`: `subtotal * discount/100` / `fixed`: `discount` | Servidor |
| `discountAmt` (ajuste) | Limitado a `[0, subtotal]` | Servidor |
| `taxable_base` | `MAX(0, subtotal - discountAmt)` | Servidor |
| `tax` | `taxable_base * tax_rate / 100` | Servidor |
| `total` | `taxable_base + tax` | Servidor |

---

## 4. Fuentes de precios utilizadas

| Tipo de ítem | Fuente del precio | Tabla | Columna |
|---|---|---|---|
| `menu` | Precio del menú | `menu_items` | `price` |
| `inventory` | Precio de venta | `inventory` | `salePrice` |
| `combo` / otros | Precio enviado por el cliente (snapshot) | `req.body` | `price` |

El precio de BD se guarda como snapshot histórico en `order_items.price` para que nunca se pierda el precio real al momento de la venta.

---

## 5. Operaciones protegidas con transacciones

Todas las operaciones de escritura de pedidos ahora se ejecutan dentro de una transacción SQLite atómica (`db._native.transaction`):

| Operación | ¿Transacción? | Qué incluye |
|---|---|---|
| `finalize` (orden nueva) | SÍ | INSERT orden + N INSERT ítems + descuento stock |
| `finalize` (merge) | SÍ | N INSERT ítems + UPDATE totales + descuento stock |
| `modify-items` | SÍ | Soft-delete ítems viejos + N INSERT ítems nuevos + UPDATE totales + descuento stock |

Si cualquier operación dentro de la transacción falla, se ejecuta `ROLLBACK` automático y no se persisten cambios parciales.

**Nota:** `pay` no se modificó en esta fase. Ya deriva el total de BD. Se documenta como pendiente para Fase 2B (ver sección 10).

---

## 6. Compatibilidad con pedidos existentes

| Flujo | ¿Mantiene compatibilidad? | Comentario |
|---|---|---|
| Dine-in (mesa) | ✅ Sí | Merge con orden abierta funciona |
| Delivery | ✅ Sí | Sin merge, orden nueva |
| Mostrador (takeaway) | ✅ Sí | Sin merge, orden nueva |
| Pedidos con múltiples ítems | ✅ Sí | Se procesan todos en la transacción |
| Combos | ✅ Sí | Tipo `combo` usa precio enviado como snapshot |
| Productos de inventario | ✅ Sí | Se descuenta stock dentro de la transacción |
| Upsert de mesas (requireOwner) | ✅ No modificado | No tocado |

---

## 7. Pruebas nuevas y resultados

Archivo: `tests/orders-money-security.test.js` — **11 pruebas, todas pasan**

| # | Prueba | Resultado |
|---|--------|-----------|
| 1 | Total inflado desde frontend es ignorado, se calcula desde BD | ✅ PASS |
| 2 | Precio unitario manipulado se reemplaza por precio de BD | ✅ PASS |
| 3 | lineTotal manipulado se reemplaza por precio × qty | ✅ PASS |
| 4 | Cantidad negativa es rechazada (400) | ✅ PASS |
| 5 | Cantidad cero es rechazada (400) | ✅ PASS |
| 6 | Descuento negativo es rechazado; descuento >100% se ajusta a 0 | ✅ PASS |
| 7 | Merge con importes manipulados usa precios de BD | ✅ PASS |
| 8 | Total se recalcula después de modify-items | ✅ PASS |
| 9 | Error durante inserción no deja orden huérfana | ✅ PASS |
| 11 | Precio histórico preservado en ítems (finalize) | ✅ PASS |
| 11 | Precio histórico preservado después de modify-items | ✅ PASS |

---

## 8. Resultado de la suite completa

| Métrica | Valor |
|---|---|
| Suites de prueba | 14 |
| Tests totales | **252** |
| Tests pasando | **252** |
| Tests fallando | 0 |

Todas las suites pasan: `auth`, `security`, `security-hardening`, `orders`, `employees`, `customers`, `db`, `utils`, `tables-save-auth`, `flow-reproduction`, `inspect-real-db`, `sync-security`, `sync-integration`, `orders-money-security`.

---

## 9. Riesgos pendientes

| Riesgo | Descripción | Severidad |
|---|---|---|
| `pay` no usa transacción | `pay` actualiza `orders` y luego `orders` + `tables` en dos operaciones separadas. Si falla entre ambas, queda inconsistencia. | ALTO |
| `pay` no verifica que el total de BD no haya sido inflado previamente | Si `finalize` infló el total antes, `pay` cobra el monto inflado. | ALTO |
| No hay devolución de stock al cancelar/reabrir | `update-status` → `cancelled` y `reopen` no restauran stock. | ALTO |
| `decrementInventoryStock` no usa `MAX(0, stock-qty)` | Puede dejar stock negativo si hay más de un descuento concurrente. | MEDIO |
| No hay protección contra doble pago concurrente | Dos `pay` simultáneos podrían pasar la validación de `paymentMethod IS NULL`. | MEDIO |
| Mercado Pago `/qr` acepta total del cliente | No verifica contra la orden en SQLite antes de generar el QR. | ALTO |

Estos riesgos ya fueron identificados en `ORDERS_MONEY_AUDIT_REPORT.md` y se documentan aquí para seguimiento.

---

## 10. Cambios que requieren autorización adicional (Fase 2B)

Los siguientes cambios están identificados pero **no implementados** en esta fase. Requieren autorización explícita antes de proceder:

1. **Transacción atómica en `pay`**: envolver `UPDATE orders` + `UPDATE tables` en `db._native.transaction`.
2. **Validación de total en `pay` contra precio de BD**: verificar que el total derivado de BD coincida con los ítems.
3. **Devolución de stock en `update-status` (cancelled) y `reopen`**: restaurar stock de ítems tipo inventory.
4. **Bloqueo contra doble pago en `pay`**: verificar `paymentMethod IS NULL` dentro de la transacción.
5. **Validación de importe en Mercado Pago `/qr`**: verificar que `total` coincida con la orden en SQLite antes de crear el QR.
6. **Endpoint de webhook de Mercado Pago**: para confirmar pagos y marcar órdenes como pagadas localmente.

**No se procederá a la Fase 2B hasta recibir autorización explícita.**

---

## Confirmación

- ✅ No se modificaron datos reales ni la base de datos de producción
- ✅ No se modificaron módulos fuera del alcance (autenticación, sincronización, Mercado Pago, pedidos fuera de `routes/orders.js`)
- ✅ No se eliminó ninguna prueba existente
- ✅ No se ejecutó `npm audit fix --force`
- ✅ Pruebas usaron SQLite en memoria (`:memory:`), no la base de producción
- ✅ Se crearon backups antes de modificar

**La Fase 2A está completa. Se detiene aquí y espera autorización antes de continuar con la Fase 2B.**
