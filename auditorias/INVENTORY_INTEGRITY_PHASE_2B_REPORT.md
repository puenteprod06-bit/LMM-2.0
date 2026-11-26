# INVENTORY_INTEGRITY_PHASE_2B_REPORT.md
# Informe de Fase 2B.1 — Protección del Stock y Autorización Administrativa

**Proyecto:** La Mente Maestra 3.0 (POS) — Node.js, Express, Electron, SQLite  
**Fecha:** 19/11/2026  
**Etapa:** 2B.1 — Protección del stock y autorización administrativa  
**Estado:** Implementación completada y verificada — 273 pruebas aprobadas  
**Próximo paso:** Esperar autorización antes de continuar con Fase 2B.2

---

## 1. Estado Inicial

Antes de esta fase, el sistema de inventario presentaba los siguientes problemas críticos identificados en `INVENTORY_INTEGRITY_AUDIT_PHASE_2B.md`:

1. `decrementInventoryStock` usaba `MAX(0, COALESCE(stock,0) - ?)` que ocultaba los faltantes de stock (el stock quedaba en 0 sin advertencia).
2. `inventory/decrement` usaba la misma lógica `MAX(0, ...)`.
3. No se verificaba stock suficiente antes de descontar.
4. No había autorización administrativa para stock negativo.
5. No se calculaba ni registraba la cantidad faltante.
6. No había pruebas automatizadas para escenarios de stock insuficiente, autorización, concurrencia, etc.

---

## 2. Problemas Confirmados

| # | Problema | Archivo | Evidencia |
|---|----------|---------|-----------|
| 1 | `MAX(0, ...)` ocultaba faltantes de stock | `routes/orders.js` (línea original 143) | `UPDATE inventory SET stock = MAX(0, COALESCE(stock,0) - ?)` |
| 2 | `inventory/decrement` usaba misma lógica | `routes/inventory.js` (línea original 93) | `UPDATE inventory SET stock = MAX(0, COALESCE(stock,0) - ?)` |
| 3 | Sin verificación de stock suficiente | `routes/orders.js` (línea original 145-149) | `stmt.run(qty, item.invId)` sin SELECT previo |
| 4 | Sin autorización admin para stock negativo | No existía | No había verificación de rol en el flujo de descuento |
| 5 | Sin registro de faltante | No existía | No se calculaba ni retornaba `shortage` |

---

## 3. Archivos Inspeccionados

| Archivo | Qué se inspeccionó |
|---------|---------------------|
| `routes/orders.js` | Función `decrementInventoryStock`, endpoint `finalize` (líneas 178-341), endpoint `modify-items` (líneas 469-588) |
| `routes/inventory.js` | Endpoint `inventory/decrement` (líneas 78-109), `inventory/save`, `inventory/:id` DELETE |
| `db.js` | Esquema de `inventory`, `order_items`, `orders`, `stock_alert_config` |
| `middleware/requireAuth.js` | `requireSession`, `requireOwner` |
| `tests/orders.test.js` | Prueba existente de descuento de stock (línea 267) |
| `tests/helpers/testApp.js` | Fábrica de app Express para tests |

---

## 4. Archivos Modificados

| Archivo | Cambios |
|---------|---------|
| `routes/orders.js` | Reemplazó `decrementInventoryStock` por `checkStockShortages` + `decrementInventoryStock` (sin MAX(0)). Agregó función `isAdminSession`. Agregó pre-verificación de stock y autorización admin en `finalize` y `modify-items`. Agregó `shortages` a la respuesta JSON. |
| `routes/inventory.js` | Reemplazó `MAX(0, COALESCE(stock,0) - ?)` por `COALESCE(stock,0) - ?`. Agregó pre-verificación de stock y autorización admin en `inventory/decrement`. Agregó `shortages` a la respuesta JSON. |
| `tests/inventory-stock-security.test.js` | Nuevo archivo con 13 pruebas de seguridad de stock |

No se modificó: `db.js`, `auth.js`, `server.js`, `middleware/requireAuth.js`, `sync-engine.js`, `routes/config.js`, `routes/mercadopago.js`.

---

## 5. Cambios Realizados

### 5.1. `routes/orders.js` — `decrementInventoryStock` reemplazada

**Antes:**
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

**Después:**
```javascript
// checkStockShortages: lee stock actual, calcula faltante, NO modifica BD
function checkStockShortages(items) {
  const shortages = [];
  const selectStmt = db.prepare(
    `SELECT id, name, stock FROM inventory WHERE id = ? AND (deleted IS NULL OR deleted = 0)`
  );
  for (const item of items) {
    if (item && item.itemType === 'inventory' && item.invId) {
      const qty = Number(item.qty) || 0;
      if (qty > 0) {
        const inv = selectStmt.get(item.invId);
        if (inv) {
          const available = Number(inv.stock) || 0;
          const shortage = Math.max(0, qty - available);
          if (shortage > 0) {
            shortages.push({ invId: item.invId, name: inv.name, available, requested: qty, shortage });
          }
        }
      }
    }
  }
  return shortages;
}

// decrementInventoryStock: descuenta stock sin MAX(0), permite negativo
function decrementInventoryStock(items) {
  if (!Array.isArray(items) || items.length === 0) return;
  const stmt = db.prepare(
    `UPDATE inventory SET stock = COALESCE(stock,0) - ? WHERE id = ? AND (deleted IS NULL OR deleted = 0)`
  );
  for (const item of items) {
    if (item && item.itemType === 'inventory' && item.invId) {
      const qty = Number(item.qty) || 0;
      if (qty > 0) stmt.run(qty, item.invId);
    }
  }
}

// isAdminSession: verifica rol admin desde la sesión de SQLite (no confía en frontend)
function isAdminSession(session) {
  if (!session) return false;
  if (session.role === 'owner' && (session.is_client === 0 || session.is_client === '0')) return true;
  if (session.role === 'admin' && (session.is_client === 1 || session.is_client === '1')) return true;
  return false;
}
```

### 5.2. `routes/orders.js` — `finalize` (líneas ~222-300)

Se agregó pre-verificación de stock y autorización admin **antes** de la transacción:
- `checkStockShortages(safeItems)` → calcula faltantes
- Si hay faltante y no hay autorización admin → retorna `400` con `code: 'STOCK_SHORTAGE'` y detalles del faltante
- Si hay autorización admin válida → registra en log y procede
- Si no hay faltante → procede normalmente
- La respuesta incluye `shortages` si hubo faltante

### 5.3. `routes/orders.js` — `modify-items` (líneas ~469-590)

Se agregó la misma pre-verificación y autorización admin antes de la transacción. La respuesta incluye `shortages` si hubo faltante.

### 5.4. `routes/inventory.js` — `inventory/decrement` (líneas 78-130)

- Eliminado `MAX(0, COALESCE(stock,0) - ?)` → ahora `COALESCE(stock,0) - ?`
- Pre-verificación de stock antes de la transacción
- Autorización admin requerida para stock negativo
- Respuesta incluye `shortages` si hubo faltante

---

## 6. Decisiones Técnicas

### 6.1. Autorización administrativa

No se inventó un nuevo sistema de roles. Se reutiliza el sistema existente:
- `session.role === 'owner'` con `is_client === 0` → administrador (propietario)
- `session.role === 'admin'` con `is_client === 1` → administrador (empleado con rol admin)

La autorización se basa en la sesión almacenada en SQLite (`local_session`), **nunca** en datos del frontend como `isAdmin: true`.

El frontend envía `adminAuthorized: true` como intención explícita, pero el backend verifica que la sesión sea de administrador. Un cliente que falsifique `adminAuthorized: true` sin sesión de admin es rechazado.

### 6.2. Stock negativo

El stock puede quedar negativo cuando hay autorización administrativa. No se usa `MAX(0, ...)` que ocultaba el faltante. El faltante se calcula como `max(0, qty - available_stock)` y se retorna en la respuesta para que el frontend muestre la advertencia.

### 6.3. Transacciones atómicas

- `finalize`: pre-verificación → transacción (orden + items + stock)
- `modify-items`: pre-verificación → transacción (soft-delete + items + stock + totales)
- `inventory/decrement`: pre-verificación → transacción (descuento stock)
- Si hay error en cualquier paso, se hace `ROLLBACK` y no se aplica ninguna operación parcial.

### 6.4. Reintentos

Cada llamada a `finalize` con los mismos items crea una nueva orden y descuenta stock de nuevo. No hay idempotencia implementada en esta fase. Esto es un riesgo pendiente (ver sección 10).

---

## 7. Pruebas Ejecutadas

Archivo: `tests/inventory-stock-security.test.js` — **13 pruebas, todas pasan**

| # | Prueba | Resultado | Qué demuestra |
|---|--------|-----------|---------------|
| 1 | Stock suficiente: venta normal, stock se descuenta | ✅ PASS | Stock 10 → 7 (10 - 3) |
| 2 | Stock exactamente igual a qty: stock queda en 0 | ✅ PASS | Stock 5 → 0 (5 - 5) |
| 3 | Stock insuficiente sin admin: rechazado con 400 | ✅ PASS | Stock 5, qty 8 → 400 STOCK_SHORTAGE, stock sin cambios |
| 4 | Stock insuficiente con admin: permite venta, stock negativo | ✅ PASS | Stock 5, qty 8 → stock -3, shortages retornado |
| 5 | Usuario sin rol admin: no puede autorizar | ✅ PASS | Sesión waiter → 400 STOCK_SHORTAGE, stock sin cambios |
| 6 | Cliente falsifica adminAuthorized: rechazado | ✅ PASS | Sesión cashier → 400 STOCK_SHORTAGE, stock sin cambios |
| 7 | Dos finalize concurrentes: stock se descuenta correctamente | ✅ PASS | Stock 10, dos ventas de 5 → stock 0 (10 - 5 - 5) |
| 8 | Cantidades decimales: stock se descuenta correctamente | ✅ PASS | Stock 10, qty 1.5 → stock 8.5 |
| 9 | Rollback ante error: no se descuenta stock parcialmente | ✅ PASS | Item inválido en segundo posición → stock sin cambios |
| 10 | Reintento de misma solicitud: dos finalize crean dos órdenes | ✅ PASS | No hay idempotencia → dos órdenes, stock descontado dos veces |
| 11 | inventory/decrement con admin → stock negativo | ✅ PASS | Stock 5, qty 8 → stock -3, shortages retornado |
| 11b | inventory/decrement sin admin → rechazado | ✅ PASS | Stock 5, qty 8 → 400 STOCK_SHORTAGE, stock sin cambios |
| 12 | Compatibilidad con pedidos existentes con stock suficiente | ✅ PASS | Stock 10, qty 3 → stock 7, sin shortages |

---

## 8. Resultado de la Suite Completa

| Métrica | Valor |
|---------|-------|
| Suites de prueba | 15 |
| Tests totales | **273** |
| Tests pasando | **273** |
| Tests fallando | 0 |

Todas las suites pasan: `auth`, `security`, `security-hardening`, `orders`, `orders-money-security`, `employees`, `customers`, `db`, `utils`, `tables-save-auth`, `sync-security`, `sync-integration`, `flow-reproduction`, `inspect-real-db`, `inventory-stock-security`.

---

## 9. Riesgos Pendientes

| # | Riesgo | Severidad | Descripción |
|---|--------|-----------|-------------|
| 1 | No hay devolución de stock en cancelación/reapertura | ALTO | `update-status` (cancelled) y `reopen` no restauran stock. Requiere diseño de reglas comerciales (Fase 2B.4). |
| 2 | No hay tabla de movimientos de stock | ALTO | No hay trazabilidad de quién, cuándo, cuánto y por qué se modificó el stock. Requiere Fase 2B.2. |
| 3 | No hay protección contra doble descuento en finalize | MEDIO | Dos clics rápidos crean dos órdenes y descuentan stock dos veces. |
| 4 | `modify-items` no reintegra stock de ítems eliminados | ALTO | Soft-delete de ítems existentes no restaura su stock. Requiere Fase 2B.3. |
| 5 | Sincronización por upsert absoluto de stock | MEDIO | Si dos dispositivos descuentan el mismo producto, el último sobrescribe. Requiere Fase 2B.5. |
| 6 | No hay verificación de stock suficiente antes de descontar (en `finalize`, se permite stock negativo con admin) | BAJO | Esto es por diseño según reglas comerciales. |
| 7 | `decrementInventoryStock` no usa `MAX(0, ...)` | BAJO | Esto es por diseño: permite stock negativo con autorización. |

---

## 10. Backup Generado y Ubicación

| Archivo | Ruta del backup |
|---------|-----------------|
| `routes/orders.js` | `scripts/backups/phase-2b-20261118/routes/orders.js.bak` |
| `routes/inventory.js` | `scripts/backups/phase-2b-20261118/routes/inventory.js.bak` |
| `db.js` | `scripts/backups/phase-2b-20261118/db.js.bak` |

---

## 11. Confirmación de que no se Modificó la Base de Datos Real

- ✅ No se ejecutaron queries de escritura sobre la base de datos de producción
- ✅ Todas las pruebas usaron SQLite en memoria (`:memory:`) vía `buildTestApp`
- ✅ No se modificó ningún dato real del negocio
- ✅ No se ejecutó `npm audit fix --force`

---

## 12. Pasos para Reproducir las Verificaciones

1. Ejecutar la suite de pruebas de stock:
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

La Fase 2B.1 está completada. Se implementó:
- ✅ Eliminación de `MAX(0, ...)` que ocultaba faltantes
- ✅ Cálculo y registro de faltante (`shortage`)
- ✅ Autorización administrativa basada en sesión de SQLite (no en frontend)
- ✅ Operaciones atómicas con `db._native.transaction`
- ✅ No hay descuentos parciales ante errores
- ✅ 13 pruebas nuevas, todas pasan
- ✅ 273 tests totales, sin regresiones

**Se detiene aquí y espera autorización antes de continuar con la Fase 2B.2 (trazabilidad de movimientos).**
