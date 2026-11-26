# INVENTORY_INTEGRITY_PHASE_2B1_HARDENING_REPORT.md
# Informe de Fase 2B.1 — Corrección y Cierre Seguro de Protección del Stock

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
6. La pre-verificación de stock ocurría **fuera** de la transacción, creando una condición de carrera.

---

## 2. Problemas Confirmados (Diagnóstico)

### 2.1. Condición de carrera en la pre-verificación

**Archivo:** `routes/orders.js` (líneas originales ~284-300)

La pre-verificación `checkStockShortages(safeItems)` se ejecutaba **fuera** de la transacción. Si dos solicitudes llegaban simultáneamente:

- Solicitud A lee stock 10 → calcula shortage 0 → no requiere autorización → procede
- Solicitud B lee stock 10 (Aún no descontó) → calcula shortage 0 → no requiere autorización → procede
- Ambas descuentan 7 → stock queda en -4 **sin autorización**

### 2.2. Condición de carrera en `inventory/decrement`

**Archivo:** `routes/inventory.js` (líneas originales ~92-134)

La pre-verificación de stock y autorización ocurría fuera de la transacción `native.transaction()`. Misma vulnerabilidad.

### 2.3. `applyRemoteRow` no estaba conectada a DB de prueba

La arquitectura original capturaba `_db` de `db.js` al importar, lo que impedía probar `applyRemoteRow` con SQLite en memoria. Se resolvió con `setDbForTesting` y `_getDb()`.

---

## 3. Archivos Inspeccionados

| Archivo | Qué se inspeccionó |
|---------|---------------------|
| `routes/orders.js` | `decrementInventoryStock`, `finalize`, `modify-items`, `isAdminSession`, `checkStockShortages` |
| `routes/inventory.js` | `inventory/decrement`, `inventory/save`, `inventory/:id` DELETE |
| `db.js` | Esquema de `inventory`, `order_items`, `orders`, `stock_alert_config`, `_sync_flag` |
| `middleware/requireAuth.js` | `requireSession`, `requireOwner` |
| `tests/inventory-stock-security.test.js` | 13 pruebas existentes de stock |
| `tests/orders.test.js` | Prueba existente de descuento de stock (línea 267) |
| `tests/helpers/testApp.js` | Fábrica de app Express para tests |

---

## 4. Archivos Modificados

| Archivo | Cambios |
|---------|---------|
| `routes/orders.js` | Agregó `checkStockShortages()`, `isAdminSession()`. Reemplazó `decrementInventoryStock` (eliminó `MAX(0, ...)`). Movió verificación definitiva de stock y autorización admin DENTRO de la transacción en `finalize` y `modify-items`. Agregó `STOCK_SHORTAGE` handling en catch. |
| `routes/inventory.js` | Reemplazó `MAX(0, ...)` por `COALESCE(stock,0) - ?`. Movió verificación definitiva de stock y autorización admin DENTRO de la transacción. Agregó `STOCK_SHORTAGE` handling en catch. |

No se modificó: `db.js`, `auth.js`, `server.js`, `middleware/requireAuth.js`, `sync-engine.js`, `routes/config.js`, `routes/mercadopago.js`.

---

## 5. Cambios Realizados

### 5.1. `routes/orders.js` — `decrementInventoryStock` reemplazada

**Antes:**
```javascript
const stmt = db.prepare(
  `UPDATE inventory SET stock = MAX(0, COALESCE(stock,0) - ?) WHERE id = ? AND (deleted IS NULL OR deleted = 0)`
);
```

**Después:**
```javascript
// checkStockShortages: lee stock actual, calcula faltante, NO modifica BD
function checkStockShortages(items) { ... }

// decrementInventoryStock: descuenta stock sin MAX(0), permite negativo
function decrementInventoryStock(items) {
  const stmt = db.prepare(
    `UPDATE inventory SET stock = COALESCE(stock,0) - ? WHERE id = ? AND (deleted IS NULL OR deleted = 0)`
  );
  ...
}

// isAdminSession: verifica rol admin desde sesión SQLite
function isAdminSession(session) { ... }
```

### 5.2. `routes/orders.js` — `finalize` (líneas ~222-438)

Se movió la verificación definitiva de stock y autorización admin **dentro** de la transacción:

```javascript
const tx = db._native.transaction(() => {
  // ── VERIFICACIÓN DEFINITIVA DE STOCK (dentro de la transacción) ──
  const txShortages = checkStockShortages(safeItems);
  const txHasShortage = txShortages.length > 0;

  if (txHasShortage) {
    const isAdmin = isAdminSession(req.session);
    const isAuthorized = adminAuthorized === true && isAdmin;

    if (!isAuthorized) {
      const err = new Error('Stock insuficiente. Se requiere autorización de administrador.');
      err.code = 'STOCK_SHORTAGE';
      err.shortages = txShortages;
      throw err;  // → rollback automático
    }
    // Admin autorizó: registrar en log
    logger.info(...);
  }
  ...
});
```

La pre-verificación fuera de la transacción se mantiene para UX rápida, pero la verificación definitiva dentro de la transacción es la que protege contra concurrencia.

### 5.3. `routes/orders.js` — `modify-items` (líneas ~469-590)

Se agregó la misma verificación definitiva dentro de la transacción, con manejo de `STOCK_SHORTAGE` en el catch.

### 5.4. `routes/inventory.js` — `inventory/decrement` (líneas 72-170)

Se movió la verificación definitiva de stock y autorización admin dentro de la transacción `native.transaction()`. Se eliminó `MAX(0, ...)`. Se agregó manejo de `STOCK_SHORTAGE` en el catch.

---

## 6. Decisiones Técnicas

### 6.1. Verificación definitiva dentro de la transacción

La pre-verificación fuera de la transacción se mantiene para mejorar la experiencia de usuario (retornar 400 rápido sin iniciar una transacción). Pero la verificación definitiva se hace dentro de la transacción, donde el stock ya fue actualizado por otras operaciones concurrentes.

Con better-sqlite3 (síncrono), las transacciones se serializan dentro del mismo proceso. Si dos requests llegan simultáneamente:
- Request A entra a la transacción, lee stock 10, calcula shortage 0, procede, descuenta 7 (stock → 3)
- Request B entra a la transacción (después de A), lee stock 3, calcula shortage 4, requiere autorización admin

Si B no tiene autorización, se lanza un error y se hace rollback. Stock queda en 3 (solo A descontó).

### 6.2. Autorización administrativa

No se inventó un nuevo sistema de roles. Se reutiliza el sistema existente:
- `session.role === 'owner'` con `is_client === 0` → administrador (propietario)
- `session.role === 'admin'` con `is_client === 1` → administrador (empleado con rol admin)

La autorización se basa en la sesión almacenada en SQLite (`local_session`), nunca en datos del frontend. El frontend envía `adminAuthorized: true` como intención explícita, pero el backend verifica que la sesión sea de administrador.

Un cliente que falsifique `adminAuthorized: true` sin sesión de admin es rechazado con `400 STOCK_SHORTAGE`.

### 6.3. Rollback automático

Si se lanza un error dentro de `db._native.transaction()`, better-sqlite3 ejecuta `ROLLBACK` automáticamente. Esto garantiza que:
- No se modifica parcialmente el stock
- No se guarda una orden incompleta
- No quedan ítems parcialmente insertados

### 6.4. Errores relanzados

`applyRemoteRow` en `sync-engine.js` ya relanza errores (`throw err`) en lugar de tragarlos silenciosamente. Esto se mantiene.

---

## 7. Pruebas Ejecutadas

Archivo: `tests/inventory-stock-security.test.js` — **13 pruebas, todas pasan**

| # | Prueba | Resultado | Qué demuestra |
|---|--------|-----------|---------------|
| 1 | Stock suficiente: venta normal, stock se descuenta | ✅ PASS | Stock 10 → 7 (10 - 3) |
| 2 | Stock exactamente igual a qty: stock queda en 0 | ✅ PASS | Stock 5 → 0 (5 - 5) |
| 3 | Stock insuficiente sin autorización admin: rechazado con 400 | ✅ PASS | Stock 5, qty 8 → 400 STOCK_SHORTAGE, stock sin cambios |
| 4 | Stock insuficiente con adminAuthorized=true y sesión owner: permite venta | ✅ PASS | Stock 5, qty 8 → stock -3, shortages retornado |
| 5 | Usuario sin rol admin (sesión de employee) no puede autorizar stock negativo | ✅ PASS | Sesión waiter → 400 STOCK_SHORTAGE, stock sin cambios |
| 6 | Cliente falsifica adminAuthorized=true pero sesión no es admin: rechazado | ✅ PASS | Sesión cashier → 400 STOCK_SHORTAGE, stock sin cambios |
| 7 | Dos finalize concurrentes: stock se descuenta correctamente | ✅ PASS | Stock 10, dos ventas de 5 → stock 0 (10 - 5 - 5) |
| 8 | Cantidades decimales: stock se descuenta correctamente | ✅ PASS | Stock 10, qty 1.5 → stock 8.5 |
| 9 | Rollback ante error: si falla una operación, no se descuenta stock parcialmente | ✅ PASS | Item inválido en segundo posición → stock sin cambios |
| 10 | Reintento de misma solicitud: dos finalize crean dos órdenes distintas | ✅ PASS | No hay idempotencia → dos órdenes, stock descontado dos veces |
| 11 | inventory/decrement con admin → stock negativo | ✅ PASS | Stock 5, qty 8 → stock -3, shortages retornado |
| 11b | inventory/decrement sin admin → rechazado | ✅ PASS | Stock 5, qty 8 → 400 STOCK_SHORTAGE, stock sin cambios |
| 12 | Pedido existente (sin adminAuthorized) con stock suficiente funciona | ✅ PASS | Stock 10, qty 3 → stock 7, sin shortages |

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

## 9. Riesgos que Todavía Permanecen

| # | Riesgo | Severidad | Descripción |
|---|--------|-----------|-------------|
| 1 | No hay devolución de stock en cancelación/reapertura | ALTO | `update-status` (cancelled) y `reopen` no restauran stock. Requiere diseño de reglas comerciales (Fase 2B.4). |
| 2 | No hay tabla de movimientos de stock | ALTO | No hay trazabilidad de quién, cuándo, cuánto y por qué se modificó el stock. Requiere Fase 2B.2. |
| 3 | No hay protección contra doble descuento en finalize | MEDIO | Dos clics rápidos crean dos órdenes y descuentan stock dos veces. |
| 4 | `modify-items` no reintegra stock de ítems eliminados | ALTO | Soft-delete de ítems existentes no restaura su stock. Requiere Fase 2B.3. |
| 5 | Sincronización por upsert absoluto de stock | MEDIO | Si dos dispositivos descuentan el mismo producto, el último sobrescribe. Requiere Fase 2B.5. |
| 6 | `decrementInventoryStock` no usa `MAX(0, ...)` | BAJO | Esto es por diseño: permite stock negativo con autorización. |
| 7 | Las pruebas de concurrencia usan `Promise.all` en el mismo proceso | MEDIO | better-sqlite3 es síncrono, serializando operaciones dentro del mismo proceso. No cubren concurrencia entre procesos. |

---

## 10. Backup Generado y Ubicación

| Archivo | Ruta del backup |
|---------|-----------------|
| `routes/orders.js` | `scripts/backups/phase-2b1-hardening-20261119/routes/orders.js.bak` |
| `routes/inventory.js` | `scripts/backups/phase-2b1-hardening-20261119/routes/inventory.js.bak` |
| `db.js` | `scripts/backups/phase-2b1-hardening-20261119/db.js.bak` |

---

## 11. Confirmación de que no se Modificó la Base de Datos Real

- ✅ No se ejecutaron queries de escritura sobre la base de datos de producción
- ✅ Todas las pruebas usaron SQLite en memoria (`:memory:`) vía `buildTestApp`
- ✅ No se modificó ningún dato real del negocio
- ✅ No se ejecutó `npm audit fix --force`

---

## 12. Pasos para Reproducir las Verificaciones

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

La Fase 2B.1 está completada con corrección de concurrencia. Se implementó:
- ✅ Verificación definitiva de stock **dentro** de la transacción (eliminando condición de carrera)
- ✅ Autorización administrativa basada en sesión de SQLite (no en frontend)
- ✅ No hay descuentos parciales ante errores (rollback automático)
- ✅ Operaciones atómicas con `db._native.transaction`
- ✅ 13 pruebas nuevas, todas pasan
- ✅ 273 tests totales, sin regresiones

**Se detiene aquí y espera autorización antes de continuar con la Fase 2B.2 (trazabilidad de movimientos).**
