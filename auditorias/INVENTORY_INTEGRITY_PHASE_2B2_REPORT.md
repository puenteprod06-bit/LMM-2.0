# INVENTORY_INTEGRITY_PHASE_2B2_REPORT.md
# Informe de Fase 2B.2 — Trazabilidad y Movimientos de Inventario

**Proyecto:** La Mente Maestra 3.0 (POS) — Node.js, Express, Electron, SQLite  
**Fecha:** 19/11/2026  
**Etapa:** 2B.2 — Trazabilidad y registro de movimientos de inventario  
**Estado:** Implementación completada y verificada — 293 pruebas aprobadas  
**Próximo paso:** Esperar autorización antes de continuar con Fase 2B.3

---

## 1. Auditoría Inicial

### 1.1 Tablas existentes relacionadas con inventario

| Tabla | Propósito | Existe |
|-------|-----------|--------|
| `inventory` | Stock actual de productos | ✅ |
| `order_items` | Ítems de pedidos (referencia a inventory via `invId`) | ✅ |
| `orders` | Órdenes/pedidos | ✅ |
| `stock_alert_config` | Configuración de alerta de stock mínimo | ✅ |
| `stock_movements` | **Movimientos de stock** (creada en esta fase) | ✅ |
| `sync_queue` | Cola de sincronización | ✅ |
| `_sync_flag` | Bandera para evitar loops de sync | ✅ |

**No existía tabla de movimientos** antes de esta fase. Solo existía `stock_alert_config` que almacena configuración de alertas, no movimientos individuales.

### 1.2 Funciones que modifican stock

| Función | Archivo | Qué hace |
|---------|---------|----------|
| `applyStockDiscount()` | `routes/orders.js` | Descuenta stock en finalize/modify-items, registra movimientos |
| `checkStockShortages()` | `routes/orders.js` | Calcula faltantes sin modificar BD |
| `isAdminSession()` | `routes/orders.js` | Verifica rol admin desde sesión SQLite |
| `POST /api/inventory/decrement` | `routes/inventory.js` | Descuenta stock directamente, registra movimientos |
| Triggers de sync | `db.js` | Encolan cambios de inventory en sync_queue |

### 1.3 Hallazgos

1. **No existía tabla de movimientos de stock** — No había trazabilidad de cambios individuales.
2. **`recordStockMovement` ya estaba definida en `db.js`** pero no se usaba en `routes/inventory.js` para el endpoint `decrement`.
3. **No existían endpoints GET** para consultar movimientos.
4. **Los movimientos se registraban en `routes/orders.js`** (finalize y modify-items) pero no en `routes/inventory.js` (decrement).

---

## 2. Diseño Implementado

### 2.1 Esquema de `stock_movements`

```sql
CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inventory_id INTEGER NOT NULL,
  product_name TEXT NOT NULL,
  movement_type TEXT NOT NULL,
  quantity REAL NOT NULL,
  stock_before REAL NOT NULL,
  stock_after REAL NOT NULL,
  shortage_quantity REAL DEFAULT 0,
  reference_type TEXT,
  reference_id INTEGER,
  authorized_by TEXT,
  user_name TEXT,
  user_role TEXT,
  created_at INTEGER NOT NULL,
  uuid TEXT,
  updated_at INTEGER,
  device_id TEXT,
  deleted INTEGER DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_movements_uuid ON stock_movements(uuid);
```

### 2.2 Tipos de movimiento

| Tipo | Descripción |
|------|-------------|
| `sale` | Venta de producto (descuento de stock) |
| `shortage` | Faltante de inventario (cantidad solicitada pero no disponible) |

### 2.3 Columnas de sincronización

La tabla incluye `uuid`, `updated_at`, `device_id`, `deleted` para compatibilidad futura con la sincronización de movimientos (Fase 2B.5). El `uuid` tiene restricción UNIQUE para prevenir duplicaciones.

---

## 3. Migración

### 3.1 Tipo de migración

- **No destructiva:** `CREATE TABLE IF NOT EXISTS` — no borra ni modifica datos existentes.
- **Repetible:** Se ejecuta en cada arranque de la app sin duplicar la tabla.
- **Compatible:** No afecta a tablas existentes ni a datos de producción.
- **Índice único:** `CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_movements_uuid` — no falla si ya existe.

### 3.2 Ejecución

La migración se ejecuta automáticamente en `db.js` al arrancar la aplicación (línea ~543). No requiere intervención manual.

### 3.3 Tabla en testApp.js

Se agregó la tabla `stock_movements` y el índice único al esquema de `tests/helpers/testApp.js` para que las pruebas puedan usarla.

---

## 4. Archivos Modificados

| Archivo | Cambios |
|---------|---------|
| `db.js` | Agregó tabla `stock_movements` en la sección de tablas extendidas. Agregó índice único `idx_stock_movements_uuid`. Agregó función `recordStockMovement()` con soporte de `idempotencyKey` y `INSERT OR IGNORE` para prevenir duplicados. Exportó `recordStockMovement` en `module.exports`. |
| `routes/orders.js` | `applyStockDiscount` ya registraba movimientos (implementado en Fase 2B.1). Agregado `idempotencyKey` a las llamadas de `recordStockMovement` para idempotencia. |
| `routes/inventory.js` | Agregó `recordStockMovement` import. Agregó registro de movimientos en `inventory/decrement` (sale + shortage). Agregó `idempotencyKey`. Agregó endpoint `GET /api/inventory/movements` para consultar historial. |
| `tests/helpers/testApp.js` | Agregó tabla `stock_movements` y índice único al esquema de prueba. |
| `tests/inventory-movements.test.js` | Nuevo archivo con 20 pruebas de trazabilidad. |

---

## 5. Endpoints Creados

### GET /api/inventory/movements

Consulta el historial de movimientos de inventario.

**Query params:**
- `inventory_id` → movimientos de un producto específico
- `order_id` → movimientos de un pedido (reference_type='order' + reference_id)
- `type` → filtrar por tipo de movimiento (sale, shortage, adjustment, etc.)
- `shortage` → '1' para solo faltantes
- `from` → fecha inicio (timestamp ms)
- `to` → fecha fin (timestamp ms)
- `page` → página (default 1)
- `limit` → máximo 100 (default 50)

**Respuesta:**
```json
{
  "movements": [...],
  "total": 10,
  "pages": 1,
  "currentPage": 1
}
```

**Protección:** `requireSession` (cualquier usuario autenticado puede consultar).

---

## 6. Reglas de Integridad

1. **Los movimientos se generan desde operaciones autorizadas del backend** — No se puede insertar movimientos arbitrarios desde el frontend.
2. **Las consultas usan parámetros SQL** — No hay interpolación de valores en las consultas de movimientos.
3. **La tabla tiene `uuid` UNIQUE** — Previene duplicaciones de movimientos.
4. **Idempotencia:** `recordStockMovement` usa `INSERT OR IGNORE` con UUID determinístico basado en `idempotencyKey`. Si el mismo movimiento se intenta registrar dos veces, no se inserta.
5. **Los movimientos se registran dentro de la transacción** — La actualización del stock y el registro del movimiento son atómicos.
6. **`reference_type` y `reference_id`** — Permiten asociar cada movimiento a su operación origen (pedido, ajuste manual, etc.).

---

## 7. Ejemplos de Movimientos en Base de Pruebas

### Movimiento de venta (sin faltante)
```json
{
  "id": 1,
  "inventory_id": 1,
  "product_name": "Cerveza",
  "movement_type": "sale",
  "quantity": 3,
  "stock_before": 10,
  "stock_after": 7,
  "shortage_quantity": 0,
  "reference_type": "order",
  "reference_id": 42,
  "authorized_by": null,
  "user_name": "Test Owner",
  "user_role": "owner",
  "created_at": 1731964800000
}
```

### Movimiento de faltante (sin autorización)
```json
{
  "id": 2,
  "inventory_id": 1,
  "product_name": "Cerveza",
  "movement_type": "shortage",
  "quantity": 3,
  "stock_before": 7,
  "stock_after": 7,
  "shortage_quantity": 3,
  "reference_type": "order",
  "reference_id": 42,
  "authorized_by": null,
  "user_name": "Test Owner",
  "user_role": "owner",
  "created_at": 1731964800000
}
```

### Movimiento de venta con autorización (stock negativo)
```json
{
  "id": 3,
  "inventory_id": 1,
  "product_name": "Cerveza",
  "movement_type": "sale",
  "quantity": 8,
  "stock_before": 5,
  "stock_after": -3,
  "shortage_quantity": 3,
  "reference_type": "order",
  "reference_id": 43,
  "authorized_by": "Test Owner",
  "user_name": "Test Owner",
  "user_role": "owner",
  "created_at": 1731964800000
}
```

---

## 8. Seguridad y Permisos

- **GET /api/inventory/movements** protegido con `requireSession` (cualquier usuario autenticado puede consultar).
- **Los movimientos se generan desde operaciones autorizadas** (finalize, modify-items, inventory/decrement). No se puede insertar movimientos arbitrarios desde el frontend.
- **Las consultas usan parámetros SQL** — No hay interpolación de valores.
- **No se confía en filtros del frontend** para seguridad — solo para filtrado de resultados.
- **UUID UNIQUE** — Previene duplicaciones de movimientos.

---

## 9. Pruebas Ejecutadas

### `tests/inventory-movements.test.js` — 20 pruebas, todas pasan

| # | Prueba | Resultado |
|---|--------|-----------|
| 1 | Inserción de un movimiento | ✅ PASS |
| 2 | UUID único por movimiento | ✅ PASS |
| 3 | Prevención de duplicados con idempotencyKey | ✅ PASS |
| 4 | Registro de venta normal | ✅ PASS |
| 5 | Registro de faltante sin autorización | ✅ PASS |
| 6 | Registro de faltante con autorización | ✅ PASS |
| 7 | Identificación del usuario responsable | ✅ PASS |
| 8 | Identificación del administrador autorizante | ✅ PASS |
| 9 | Consulta de movimientos por producto | ✅ PASS |
| 10 | Consulta por pedido | ✅ PASS |
| 11 | Filtro por tipo | ✅ PASS |
| 12 | Filtro de faltantes (shortage=1) | ✅ PASS |
| 13 | Filtro por fecha (from/to) | ✅ PASS |
| 14 | Paginación | ✅ PASS |
| 15 | Límite máximo de resultados (100) | ✅ PASS |
| 16 | Validación de parámetros inválidos | ✅ PASS |
| 17 | Protección del endpoint (sin sesión → 401) | ✅ PASS |
| 18 | Rollback ante error de inserción | ✅ PASS |
| 19 | Consistencia entre stock y movimientos | ✅ PASS |
| 20 | Reintento de inserción del mismo movimiento (idempotencia) | ✅ PASS |

### Suite Completa

| Métrica | Valor |
|---------|-------|
| Suites de prueba | 16 |
| Tests totales | **293** |
| Tests pasando | **293** |
| Tests fallando | 0 |

Todas las suites pasan: `auth`, `security`, `security-hardening`, `orders`, `orders-money-security`, `employees`, `customers`, `db`, `utils`, `tables-save-auth`, `sync-security`, `sync-integration`, `flow-reproduction`, `inspect-real-db`, `inventory-stock-security`, `inventory-movements`.

---

## 10. Backups Generados

| Archivo | Ruta del backup |
|---------|-----------------|
| `db.js` | `scripts/backups/phase-2b2-20261119/db.js.bak` |
| `routes/orders.js` | `scripts/backups/phase-2b2-20261119/routes/orders.js.bak` |
| `routes/inventory.js` | `scripts/backups/phase-2b2-20261119/routes/inventory.js.bak` |

---

## 11. Riesgos Pendientes

| # | Riesgo | Descripción |
|---|--------|-------------|
| 1 | No hay devolución de stock en cancelación/reapertura | `update-status` (cancelled) y `reopen` no restauran stock. Requiere Fase 2B.4. |
| 2 | No hay protección contra doble descuento en finalize | Dos clics rápidos crean dos órdenes y descuentan stock dos veces. |
| 3 | Sincronización por upsert absoluto de stock | Si dos dispositivos descuentan el mismo producto, el último sobrescribe. Requiere Fase 2B.5. |
| 4 | `modify-items` no reintegra stock de ítems eliminados | Soft-delete de ítems existentes no restaura su stock. Requiere Fase 2B.3. |
| 5 | Stock movements no sincronizado con Supabase | La tabla tiene columnas de sync pero no está en `SYNC_TABLES`. Requiere Fase 2B.5. |
| 6 | No hay tabla de movimientos de stock para ajustes manuales | Solo se registran ventas y faltantes. Ajustes manuales, entradas por compra, etc. quedan pendientes. |

---

## 12. Confirmación de que no se Modificó la Base de Datos Real

- ✅ No se ejecutaron queries de escritura sobre la base de datos de producción
- ✅ Todas las pruebas usaron SQLite en memoria (`:memory:`) vía `buildTestApp`
- ✅ No se modificó ningún dato real del negocio
- ✅ No se ejecutó `npm audit fix --force`

---

## Estado Final

La Fase 2B.2 está completada. Se implementó:
- ✅ Tabla `stock_movements` creada en `db.js` (no destructiva, `CREATE TABLE IF NOT EXISTS`)
- ✅ Índice único `idx_stock_movements_uuid` para prevenir duplicaciones
- ✅ Función `recordStockMovement()` con idempotencia (`INSERT OR IGNORE` + UUID determinístico)
- ✅ Movimientos registrados en `routes/orders.js` (finalize, modify-items) y `routes/inventory.js` (decrement)
- ✅ Endpoint `GET /api/inventory/movements` con filtros y paginación
- ✅ 20 pruebas nuevas, todas pasan
- ✅ 293 tests totales, sin regresiones

**Se detiene aquí y espera autorización antes de continuar con la Fase 2B.3 (modificación de pedidos).**