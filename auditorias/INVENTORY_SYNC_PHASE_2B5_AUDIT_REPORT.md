# INVENTORY_SYNC_PHASE_2B5_AUDIT_REPORT.md

## Fase 2B.5 — Auditoría de Sincronización Segura del Inventario (SOLO LECTURA)

**Fecha:** 20/11/2026  
**Estado:** AUDITORÍA COMPLETADA — NO SE IMPLEMENTÓ NINGÚN CAMBIO  
**Entorno:** `C:\Users\agust\OneDrive\Desktop\PROYECTOS\La_Mente_Maestra_reparado\mente-maestra-reparado`  
**Node:** v20.x (Electron 33.0.0) | **npm:** 10.x  
**Proyecto:** La Mente Maestra 3.0 (POS) — versión 2.3.2

---

## 1. Resumen ejecutivo

Se auditó integralmente el mecanismo de sincronización offline-first entre SQLite local y Supabase. El sistema cuenta con un motor de sync (`sync-engine.js`) basado en outbox (`sync_queue`), triggers SQLite, lista blanca de columnas, UUID determinísticos e `INSERT OR IGNORE` para movimientos locales.

**Hallazgo principal:** El mecanismo actual protege contra inyección y bucles de eco, pero **no protege la integridad del inventario ante sincronización concurrente ni pierde la trazabilidad de movimientos**, porque:

1. **`stock_movements` NO está sincronizado** (no está en `SYNC_TABLES`).
2. El stock se sincroniza como **valor absoluto** (`inventory.stock`) con resolución de conflictos por "último en escribir gana" basado en `updated_at` local.
3. No existe control de versiones ni reconstrucción remota del stock a partir de movimientos.

Clasificación de hallazgos: **3 CRÍTICO, 3 ALTO, 2 MEDIO, 1 BAJO**.

---

## 2. Archivos inspeccionados

| Archivo | Rol |
|---------|-----|
| `sync-engine.js` | Motor de sync local ↔ Supabase (push, pull, realtime, inicial pull, check-integrity) |
| `db.js` | Capa de datos: `SYNC_TABLES`, triggers de `sync_queue`, `_sync_flag`, `recordStockMovement`, `applyRemoteChange`, `DEVICE_ID` |
| `routes/orders.js` | `finalize`, `modify-items`, `update-status` (cancel), `reopen` — generan cambios de stock y movimientos |
| `routes/inventory.js` | `inventory/save`, `inventory/decrement`, `GET /movements` |
| `routes/config.js` | Endpoints `/sync-status`, `/sync-check`, `/resync`, `/link-cloud` |
| `routes/system.js` | Endpoints de sistema (sin endpoints de sync aparte de config) |
| `server.js` | Inicialización de `initSync` al arrancar si hay config de nube |
| `main.js` | Electron main: reanuda `initSync` si ya está vinculada la nube |
| `public/pos-sync.js` | Frontend: `syncAppData()` — sondea endpoints locales Express (no escribe directo a Supabase) |
| `tests/sync-security.test.js` | Pruebas de seguridad de sync (listas blancas, columnas sensibles, UUID) |
| `tests/sync-integration.test.js` | Pruebas de integración de sync con mock de Supabase |

---

## 3. Arquitectura actual

### 3.1 Capas

```
┌─────────────────┐      HTTP (Express)       ┌─────────────────┐
│   Frontend      │◄───────────────────────────►│   Servidor      │
│  (Electron      │                            │  (Node + SQLite)│
│   renderer)     │      SQLite local (db.js)   │   + sync-engine │
└─────────────────┘                            └────────┬────────┘
                                                        │ HTTPS/WSS
                                                        ▼
                                               ┌─────────────────┐
                                               │   Supabase      │
                                               │  (sync_* tablas)│
                                               └─────────────────┘
```

### 3.2 Flujo de datos

**Local → Remoto (PUSH):**
1. Trigger SQLite (AFTER INSERT/UPDATE en cada tabla de `SYNC_TABLES`) inserta en `sync_queue` (outbox).
2. `flushQueue()` cada 3s lee `sync_queue WHERE synced = 0`, agrupa por tabla, dedupe por `row_uuid` (quedando el último estado), lee la fila local completa y hace `upsert` a `sync_<tabla>` en Supabase con `onConflict: 'uuid'`.
3. Marca `synced = 1` en `sync_queue` y borra entradas > 24h.

**Remoto → Local (PULL):**
1. `initialPull()` al arrancar: descarga todas las filas de cada `sync_<tabla>` filtradas por `restaurant_id` y las aplica con `applyRemoteRow()`.
2. `startRealtimePull()`: canal Supabase Realtime escucha `postgres_changes` en cada `sync_<tabla>` y aplica `applyRemoteRow()` al llegar.
3. `applyRemoteRow()` valida tabla/columnas contra listas blancas, ignora eco (`device_id === DEVICE_ID`), requiere `uuid`, compara `updated_at` (local >= remoto → no sobrescribe), hace `UPDATE` o `INSERT` con `_sync_flag.applying_remote = 1` para no reencolar.

### 3.3 Tablas sincronizadas (`SYNC_TABLES`)

```
orders, order_items, tables, menu_items, inventory,
customers, employees, categories, subcategories
```

**`stock_movements` NO está en `SYNC_TABLES`.**

### 3.4 Columnas sincronizadas de `inventory` (salida, `OUTPUT_COLUMNS`)

`uuid, name, stock, minStock, unit, cost, salePrice, category, expirationDate, notes, emoji, showInPOS, area`

→ Incluye `stock` como valor absoluto.

---

## 4. Flujo local → remoto (detalle)

### Paso 1: Generación de la cola (triggers en `db.js`)

Cada tabla de `SYNC_TABLES` tiene dos triggers:

- `trg_<tabla>_after_insert` (AFTER INSERT): completa `uuid`, `updated_at`, `device_id` si faltan, e inserta en `sync_queue (table_name, row_uuid, operation, created_at)`.
- `trg_<tabla>_queue_update` (AFTER UPDATE): actualiza `updated_at`, `device_id` e inserta en `sync_queue`.

Guardia: `WHEN (SELECT applying_remote FROM _sync_flag WHERE rowid_pk = 1) = 0` — evita que cambios aplicados desde remoto se reencolen (evita bucle infinito).

### Paso 2: Vaciado de la cola (`flushQueue` en `sync-engine.js`)

- Lee `sync_queue WHERE synced = 0 ORDER BY created_at ASC LIMIT 200`.
- Agrupa por `table_name`. Valida tabla contra `isAllowedTable()`.
- Dedupe por `row_uuid` (`latestByUuid`) — conserva solo el último estado por fila.
- Para cada uuid, lee la fila local completa (`SELECT * FROM <tabla> WHERE uuid = ?`).
- Construye `data` con `sanitizeOutputColumns()` (lista blanca de salida, excluye `SENSITIVE_FIELDS`).
- Ejecuta `supabase.from('sync_<tabla>').upsert(rows, { onConflict: 'uuid' })`.
- Si falla el upsert de una tabla: `continue` (los items de esa tabla NO se marcan como `synced` → se reintentan).
- Si éxito: marca `synced = 1` para todos los `id` de esa tabla y borra `sync_queue` con `synced = 1` y `created_at < ahora - 24h`.

### Paso 3: Backfill inicial (`runInitialCloudBackfill` en `db.js`)

Al vincular la nube, encola una sola vez las filas existentes (solo pedidos ABIERTOS para `orders`/`order_items`, todas las demás tablas). Marca `cloud_initial_backfill_done = 1`.

---

## 5. Flujo remoto → local (detalle)

### Paso 1: `initialPull()` (sync-engine.js, línea 230)

Orden de descarga: employees, categories, subcategories, menu_items, inventory, customers, tables, orders, order_items. Para cada tabla: `SELECT * FROM sync_<tabla> WHERE restaurant_id = ?` → `applyRemoteRow(table, remote)`.

### Paso 2: `startRealtimePull()` (línea 380)

Canal Supabase `restaurant-<restaurantId>`, escucha `postgres_changes` con `event: '*'` en cada `sync_<tabla>` filtrado por `restaurant_id`. Al llegar un evento: `applyRemoteRow(table, payload.new || payload.old)`.

### Paso 3: `applyRemoteRow()` (línea 505)

1. Valida tabla contra `SYNC_TABLES`.
2. Valida que `remote` sea objeto con `uuid` válido.
3. **Ignora eco propio:** si `remote.device_id === DEVICE_ID` retorna sin hacer nada.
4. Sanitiza columnas con `sanitizeRemoteColumns()` (lista blanca de entrada, excluye `SENSITIVE_FIELDS`, descarta `id`).
5. Añade `updated_at` del nivel superior del payload.
6. Lee local: `SELECT id, updated_at FROM <tabla> WHERE uuid = ?`.
7. **Conflicto:** si `local && local.updated_at >= remote.updated_at` → retorna sin escribir (local es igual o más nuevo).
8. Pone `_sync_flag.applying_remote = 1`, ejecuta `UPDATE` o `INSERT`, pone flag a 0.
9. Si la tabla es `orders` y había ítems pendientes en `pendingItemsByOrderUuid`, los aplica.

---

## 6. Auditoría de `inventory`

### 6.1 Estructura local (db.js)

```sql
CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  stock REAL,
  minStock REAL,
  unit TEXT,
  cost REAL,
  salePrice REAL,
  category TEXT,
  expirationDate TEXT,
  notes TEXT,
  emoji TEXT,
  showInPOS INTEGER DEFAULT 0,
  area TEXT DEFAULT 'bar',
  deleted INTEGER DEFAULT 0
);
-- columnas de sync añadidas: uuid TEXT, updated_at INTEGER, device_id TEXT
```

### 6.2 Identificador estable

- `id` (autoincremental local) — NO se envía a Supabase (descartado por `sanitizeRemoteColumns` y no está en OUTPUT_COLUMNS).
- `uuid` (generado por trigger o backfill) — identificador estable que viaja a la nube.
- `device_id` — identificador del dispositivo que originó el cambio.

### 6.3 ¿Cómo se identifica un producto local y remotamente?

Por `uuid`. La columna `id` es solo local.

### 6.4 ¿Existe `local_id` excluido del payload remoto?

Sí. `sanitizeOutputColumns` filtra por `OUTPUT_COLUMNS[inventory]`, que no incluye `id`. También `sanitizeRemoteColumns` descarta explícitamente `id`.

### 6.5 ¿Cómo se sincronizan los cambios de stock?

**Como valor absoluto.** `flushQueue` lee `localRow.stock` y lo envía en `data.stock`. `applyRemoteRow` hace:

```sql
UPDATE inventory SET stock = ?, ... WHERE uuid = ?
```

No hay cálculo de diferencias, no hay reconstrucción a partir de movimientos, no hay `stock = stock - delta`.

### 6.6 Punto crítico: `stock = valor_local`

**Sí, el sistema hace efectivamente `stock = valor_local`.** Esto puede destruir una actualización remota válida cuando:

- Dispositivo A: stock 10, vende 3 → stock 7 (updated_at A1).
- Dispositivo B: stock 10, vende 4 → stock 6 (updated_at B1).
- Si A push después de B y `updated_at` de A > `updated_at` de B → stock queda 7 (pierde la venta de 4 de B).
- Si B push después de A y `updated_at` de B > `updated_at` de A → stock queda 6 (pierde la venta de 3 de A).

En cualquier caso, el resultado correcto sería stock 3. La sincronización por valor absoluto con last-write-wins por `updated_at` **pierde actualizaciones concurrentes**.

### 6.7 ¿Existe control de versiones o vector clocks?

No. Solo `updated_at` (timestamp local en milisegundos, generado por trigger SQLite con `strftime('%s','now') * 1000`). Los relojes de diferentes dispositivos no están sincronizados, por lo que la comparación de timestamps para detectar conflictos es poco fiable.

### 6.8 ¿Existen conflictos de escritura?

Sí, implícitamente. Dos dispositivos pueden editar el mismo producto (o el mismo pedido que afecta stock) simultáneamente. El último `upsert` que llegue a Supabase con `updated_at` mayor prevalece, sin detectar que el stock divergió.

---

## 7. Auditoría de `stock_movements`

### 7.1 Estructura local (db.js, línea 543)

```sql
CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inventory_id INTEGER NOT NULL,
  product_name TEXT NOT NULL,
  movement_type TEXT NOT NULL,   -- 'sale', 'return', 'shortage'
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

### 7.2 ¿Está en `SYNC_TABLES`?

**NO.** `stock_movements` no está en la lista de `SYNC_TABLES` (db.js línea 786). Consecuencias:

- No hay trigger que encole cambios en `sync_queue`.
- `flushQueue` nunca lee ni envía `stock_movements` a Supabase.
- `initialPull` nunca descarga movimientos.
- `startRealtimePull` no escucha cambios de `sync_stock_movements`.
- `checkIntegrity` no verifica `stock_movements`.

### 7.3 Idempotencia local

Sí existe a nivel local: `recordStockMovement()` usa `INSERT OR IGNORE` con `uuid` determinístico (generado a partir de `idempotencyKey` via SHA-256). El índice único `idx_stock_movements_uuid` evita duplicados locales.

### 7.4 ¿Qué campos se conservan localmente?

Todos: `inventory_id`, `product_name`, `movement_type`, `quantity`, `stock_before`, `stock_after`, `shortage_quantity`, `reference_type`, `reference_id`, `authorized_by`, `user_name`, `user_role`, `created_at`, `uuid`, `updated_at`, `device_id`, `deleted`.

### 7.5 ¿Qué sucede con los movimientos al sincronizar?

**Nada: no se sincronizan.** La nube nunca recibe `sale`, `return` ni `shortage`. La nube solo ve el valor absoluto de `inventory.stock`.

### 7.6 ¿Se reconstruye el stock remoto a partir de movimientos?

**No.** No existe mecanismo en Supabase para reconstruir stock a partir de movimientos. El stock remoto es el valor absoluto sincronizado desde `inventory.stock`.

### 7.7 ¿Puede un movimiento fallido volver a intentarse?

No existe cola outbox para `stock_movements`. Un movimiento registrado localmente nunca se envía a Supabase, por lo que no hay reintento ni pérdida detectable remota.

---

## 8. Resultados de los ocho escenarios de fallo

### Escenario A — Sin Internet

| Paso | Qué sucede actualmente |
|------|------------------------|
| Venta de producto | SQLite descuenta stock, registra `sale` en `stock_movements`, trigger encola en `sync_queue`. |
| Pierde Internet | `flushQueue` falla al hacer upsert a Supabase (`catch`), `isOnline = false`, los items quedan `synced = 0`. |
| Reinicia Electron | `sync_queue` persiste en SQLite. Al arrancar, `server.js` / `main.js` intentan `initSync` si hay credenciales; si no hay Internet, falla silenciosamente y queda en modo solo-local. |
| Recupera Internet | `flushQueue` cada 3s reintenta los items pendientes. `pendingSweepTimer` cada 10s revisa `pendingItemsByOrderUuid`. |

**Evaluación:** La operación pendiente se conserva y se reintenta. **Riesgo:** si el dispositivo se reinicia antes de sincronizar y se borra la DB local (no es el caso normal), se perdería. No hay pérdida por reinicio normal porque `sync_queue` persiste.

### Escenario B — Sincronización repetida

| Paso | Qué sucede actualmente |
|------|------------------------|
| Venta registrada | Se inserta en `sync_queue` con `synced = 0`. |
| Sincroniza correctamente | `flushQueue` hace upsert a Supabase, marca `synced = 1`. |
| No recibe confirmación / se repite | Los items con `synced = 1` ya no son leídos por `flushQueue` (filtra `synced = 0`). No se reenvían. |

**Evaluación:** No hay duplicación de envío para la misma fila de `sync_queue`. **Pero:** si el mismo producto cambia varias veces antes de sincronizar, `latestByUuid` conserva solo el último estado; los estados intermedios se pierden (aceptable para valor absoluto, inaceptable para trazabilidad de movimientos).

### Escenario C — Dos dispositivos (pérdida de actualización concurrente)

| Paso | Dispositivo A | Dispositivo B |
|------|---------------|---------------|
| Stock inicial | 10 | 10 |
| A vende 3 | stock → 7 | — |
| B vende 4 | — | stock → 6 |
| A sincroniza | stock remoto = 7 | — |
| B sincroniza | — | stock remoto = 6 (si B es más reciente) |

**Resultado:** stock final 6 u 7 según quién escriba último. **Correcto sería 3.** Se pierde una de las ventas.

**Severidad: CRÍTICO.** Sincronización por valor absoluto sin detectar divergencia de stock.

### Escenario D — Conflicto de escritura (stock 5 local vs 8 remoto)

| Paso | Qué sucede |
|------|------------|
| SQLite stock = 5, Supabase stock = 8 | `applyRemoteRow` compara `updated_at`. Si remoto `updated_at` > local `updated_at`, se sobrescribe local con 8. Si local > remoto, se sobrescribe remoto con 5 en el siguiente push. |

**Evaluación:** No hay criterio semántico (ej. "el stock más bajo prevalece" o "fusionar cambios"). Solo timestamp. Los relojes locales pueden no estar sincronizados.

**Severidad: ALTO.**

### Escenario E — Cancelación sin conexión

| Paso | Qué sucede |
|------|------------|
| Venta registrada (stock descontado, `sale` registrado) | Local: stock ↓, `stock_movements.sale` ✓. `sync_queue` orden + items ✓, movimientos ✗ (no están en cola). |
| Cancela sin Internet | Local: `orders.status = 'cancelled'`, `UPDATE inventory stock + qty` (return), `stock_movements.return` ✓. `sync_queue` orden ✓, movimientos ✗. |
| Recupera Internet | Se sincroniza `orders` (estado cancelado) y `inventory` (stock absoluto devuelto). **No se sincronizan ni `sale` ni `return`.** |

**Evaluación:** La nube ve la orden como "cancelada" y el stock devuelto al valor absoluto, pero no tiene rastro de por qué (no hay movimientos). Si el stock absoluto llega inconsistente (escenario C), la nube no puede reconstruir el historial.

**Severidad: ALTO (pérdida de trazabilidad).**

### Escenario F — Reapertura sin conexión

| Paso | Qué sucede |
|------|------------|
| Cancela (stock devuelto) | Local: `return` registrado, stock sube. |
| Reabre (stock re-descontado) | Local: `sale` registrado con `SUM(sale)` reconstruido (Fase 2B.4.1), stock baja. |
| Pierde Internet | `sync_queue` orden ✓, inventario ✓, movimientos ✗. |
| Recupera Internet | Se sincroniza estado y stock absoluto. Movimientos perdidos para la nube. |

**Evaluación:** Mismo problema que E. Además, si el re-discount en reopen falla por falta de stock (regla de faltante), la nube nunca lo sabe.

**Severidad: ALTO.**

### Escenario G — Producto creado sin conexión

| Paso | Qué sucede |
|------|------------|
| Crea producto en SQLite | `INSERT inventory`, trigger genera `uuid`, encola en `sync_queue`. |
| Registra stock inicial | `UPDATE inventory stock`, `sync_queue` actualización. |
| Crea movimientos | `stock_movements` local solo, no en cola. |
| Sincroniza después | Producto e inventario se suben. Movimientos no. |

**Evaluación:** El producto y su stock se sincronizan, pero no hay rastro de cómo se estableció ese stock inicial.

**Severidad: MEDIO.**

### Escenario H — Eliminación lógica

| Paso | Qué sucede |
|------|------------|
| Marca producto/movimiento como `deleted = 1` | Trigger encola actualización en `sync_queue`. `deleted` está en `OUTPUT_COLUMNS[inventory]` y `ALLOWED_COLUMNS[inventory]`. |
| Sincroniza | `upsert` envía `deleted: true`. La nube marca el registro como borrado. |
| Otro dispositivo con versión anterior | Recibe el `upsert` con `deleted: true` vía realtime o pull, aplica localmente. |

**Evaluación:** La eliminación lógica sí se propaga para tablas en `SYNC_TABLES`. Pero para `stock_movements` (no sincronizada), una eliminación local nunca se propaga.

**Severidad: MEDIO (solo para tablas sincronizadas; stock_movements queda fuera).**

---

## 9. Auditoría de concurrencia y transacciones

| Pregunta | Respuesta |
|----------|-----------|
| ¿Puede ejecutarse sincronización dos veces simultáneamente? | `flushQueue` se llama cada 3s vía `setInterval`. Si una ejecución tarda más de 3s, la siguiente se solapa. No hay mutex ni lock. better-sqlite3 es síncrono, pero las llamadas a Supabase son async. Dos `flushQueue` concurrentes podrían leer los mismos items pendientes y hacer upsert duplicado (aunque `onConflict: 'uuid'` lo absorbe a nivel de Supabase, dos procesos podrían marcar `synced = 1` sobre los mismos ids). |
| ¿Existen locks o exclusión? | No hay mecanismo de exclusión para `flushQueue`. |
| ¿Procesos de sync en segundo plano? | `pushTimer` (3s), `pendingSweepTimer` (10s), canal Realtime. Todos en el mismo proceso Node/Electron. |
| ¿Electron y servidor pueden iniciar sync simultáneamente? | `initSync` se llama tanto en `server.js` (línea 226) como en `main.js` (línea 453). Si ambos procesos comparten la misma DB SQLite (Electron ejecuta el servidor dentro del mismo proceso), podría haber doble inicialización. Revisar: `server.js` y `main.js` parecen ser el mismo proceso (Electron ejecuta server.js). No hay evidencia de dos procesos Node independientes sobre la misma DB. |
| ¿Puede modificarse una operación local mientras se prepara su payload? | `flushQueue` lee la fila local después de dedupe. Si otra operación modifica esa fila entre el `SELECT * FROM <tabla> WHERE uuid = ?` y el `upsert`, se enviaría un estado intermedio. No hay transacción que abarque la lectura de la cola y el envío remoto. |
| ¿Se sincronizan stock y movimientos en una misma unidad lógica? | No. `stock_movements` no se sincroniza. `inventory.stock` y `orders`/`order_items` se sincronizan por separado, sin atomicidad cruzada. |
| ¿Riesgo de pérdida entre confirmar SQLite y confirmar Supabase? | Sí. El trigger encola en `sync_queue` (SQLite) inmediatamente. Si el proceso muere antes de `flushQueue`, la operación está en la cola y sobrevivirá al reinicio. Pero si `flushQueue` hace upsert exitoso y el proceso muere antes de marcar `synced = 1`, al reiniciar se reenvía (idempotente por `onConflict: 'uuid'` en Supabase, pero se reenvía innecesariamente). |

**Ventanas de inconsistencia:**
1. Entre el cambio local y el `flushQueue` (hasta 3s).
2. Entre el `upsert` exitoso a Supabase y el marcado de `synced = 1`.
3. Entre dispositivos sin conexión (ventana ilimitada hasta que se reconectan).

**Severidad: ALTO (ventana de inconsistencia sin resolución de conflictos).**

---

## 10. Auditoría de seguridad

| Pregunta | Respuesta |
|----------|-----------|
| ¿Dónde se almacenan credenciales de Supabase? | En `config` (SQLite local): `cloud_restaurant_id`, `supabase_url`, `supabase_anon_key`. También en `.env.runtime` (copiado a `.env` en build). |
| ¿Llega `service_role` al frontend? | No. Solo `supabase_anon_key` (clave pública/anónima). No hay evidencia de `service_role` en el código. |
| ¿Están protegidas las escrituras remotas por RLS? | No se auditó el esquema de Supabase (no accesible sin credenciales). El cliente usa `anon key`, por lo que depende de RLS del servidor. |
| ¿Puede un usuario modificar stock remotamente sin autorización? | Depende de RLS de Supabase. Desde el cliente local, solo el servidor Express valida sesión antes de permitir cambios de stock. El sync-engine empuja cambios locales sin validar reglas comerciales (empuja lo que sea que esté en SQLite). |
| ¿Validan sesión los endpoints de sync? | `/api/config/sync-status` no requiere autenticación (devuelve estado sin credenciales). `/sync-check`, `/resync`, `/link-cloud` requieren `requireOwner`. |
| ¿Se puede falsificar un movimiento desde el cliente? | Los movimientos `stock_movements` se escriben solo localmente vía rutas protegidas (`requireSession`, `requireOwner`). No hay endpoint remoto para escribir movimientos directamente. |
| ¿Se validan cantidades, tipos y referencias en sync? | `sanitizeRemoteColumns` valida columnas contra lista blanca, pero no valida rangos (ej. `stock >= 0`) ni referencias integridad (`inventory_id` existente). Un registro remoto con `stock = -999999` sería aceptado si pasa la lista blanca y el timestamp. |
| ¿Pueden errores remotos exponer información sensible? | Los errores de `flushQueue` se loguean (`logger.warn`) pero no se devuelven al cliente. `checkIntegrity` devuelve conteos, no datos. |

**Severidad: MEDIO (falta validación semántica de datos remotos entrantes; dependencia de RLS no verificada).**

---

## 11. Estrategias posibles

### Alternativa A — Sincronización por valores absolutos (actual)

- **Ventajas:** Simple, ya implementado, `onConflict: 'uuid'` maneja idempotencia a nivel de fila.
- **Desventajas:** Pierde actualizaciones concurrentes (escenario C), no hay trazabilidad de movimientos, `updated_at` no confiable entre dispositivos.
- **Riesgos:** CRÍTICO para inventario (pérdida de stock).
- **Complejidad:** Baja (ya implementado).
- **Compatibilidad:** Total con lo actual.
- **Migraciones:** Ninguna.

### Alternativa B — Sincronización basada en movimientos

- **Ventajas:** Cada operación de stock es un movimiento único e idempotente; el stock remoto se reconstruye sumando movimientos; no se pierden actualizaciones concurrentes (se aplican todos los movimientos).
- **Desventajas:** Requiere añadir `stock_movements` a `SYNC_TABLES` y crear outbox para ella; el stock remoto es derivado, no materializado (o se mantiene materializado y se actualiza delta a delta).
- **Riesgos:** Necesita garantizar orden de aplicación (sale antes que return); posible reconstrucción inconsistente si se pierde un movimiento intermedio.
- **Complejidad:** Media-Alta.
- **Compatibilidad:** Requiere cambios en `SYNC_TABLES`, triggers, `sync-engine.js`, y posiblemente esquema de Supabase.
- **Migraciones:** Sí (agregar `stock_movements` a tablas sincronizadas, asegurar `uuid` en esa tabla — ya existe).

### Alternativa C — Híbrida con control de versiones

- **Ventajas:** Movimientos como fuente de trazabilidad + stock materializado + `version` o `vector_clock` para detectar conflictos; resolución semántica (ej. stock = min(local, remoto) o merge de deltas).
- **Desventajas:** Más complejo, requiere esquema adicional (`version` por fila, tabla de conflictos).
- **Riesgos:** Complejidad operativa.
- **Complejidad:** Alta.
- **Compatencial:** Requiere migraciones y rediseño del motor de sync.
- **Migraciones:** Sí (tabla de versiones/conflictos, columna `version` en tablas sincronizadas).

**Recomendación:** Alternativa B (mínimo viable) con elementos de C (control de versión básico por fila para detectar conflictos de stock absoluto).

---

## 12. Diseño recomendado (arquitectura objetivo)

### Principios
1. Cada operación de inventario tiene identidad única persistente (`uuid` + `idempotencyKey`).
2. Ningún movimiento se aplica dos veces (`INSERT OR IGNORE` + `onConflict: 'uuid'`).
3. Las operaciones pendientes sobreviven a reinicios (`sync_queue` persistente).
4. Los reintentos son seguros (idempotencia a nivel de fila y de movimiento).
5. Los movimientos mantienen orden lógico (secuencia por `created_at`).
6. Los conflictos se detectan explícitamente (timestamp + versión).
7. Las actualizaciones antiguas no sobrescriben datos nuevos.
8. Los errores remotos no se ocultan (logging + estado `failed` en cola).
9. SQLite sigue siendo funcional sin Internet.
10. La sincronización preserva las reglas comerciales (stock → 0 sin auth, negativo con auth).

### Componentes propuestos

1. **Tabla local de outbox unificada** (ya existe `sync_queue`) ampliada para incluir `stock_movements`.
2. **`stock_movements` en `SYNC_TABLES`:** para que sus cambios se encoelen y sincronicen.
3. **Columna `version` (entero incremental) en tablas sincronizadas** para detectar conflictos semánticos (no solo timestamp).
4. **Resolución de conflictos de stock:** en lugar de `stock = valor_local`, aplicar `stock = stock - delta` cuando se conozca el delta, o usar `GREATEST`/`menor stock` como política de seguridad.
5. **Estado de cola:** `pending` → `processing` → `synced` / `failed`, con `attempts` y `last_error`, para evitar que dos procesos procesen la misma operación (`SELECT ... WHERE status = 'pending' LIMIT 1` + `UPDATE ... SET status = 'processing' WHERE id = ? AND status = 'pending'`).

### Diagrama de arquitectura propuesta

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
│   Local      │     │   Outbox (SQLite)│     │   Supabase   │
│  SQLite      │────▶│   sync_queue     │────▶│  sync_*      │
│  (stock +    │     │  + stock_movements│     │  (versioned) │
│   movements) │     │   (pending/failed│     │              │
└──────────────┘     │    / synced)     │     └──────┬───────┘
                     └──────────────────┘            │ HTTPS upsert
                                                      │ onConflict uuid
                                                      ▼
                                               ┌──────────────┐
                                               │  Realtime    │
                                               │  pull        │
                                               └──────┬───────┘
                                                      ▼
                                               ┌──────────────┐
                                               │   Local      │
                                               │  applyRemote │
                                               │  (version +  │
                                               │   timestamp) │
                                               └──────────────┘
```

---

## 13. Plan de implementación por etapas

**Etapa 1 — Auditoría (COMPLETADA):** Este documento.

**Etapa 2 — Añadir `stock_movements` a `SYNC_TABLES`:**
- Agregar columnas `uuid`, `updated_at`, `device_id`, `deleted` a `stock_movements` si faltan.
- Añadir a `SYNC_TABLES` en `db.js`.
- Añadir triggers de `sync_queue` para `stock_movements`.
- Añadir entradas en `ALLOWED_COLUMNS` y `OUTPUT_COLUMNS` en `sync-engine.js`.

**Etapa 3 — Control de versión por fila:**
- Agregar columna `version` (INTEGER DEFAULT 1) a tablas de inventario y pedidos.
- Incrementar `version` en cada UPDATE local.
- `applyRemoteRow` rechaza cambios con `version` menor o igual.

**Etapa 4 — Resolución semántica de conflictos de stock:**
- Cuando se recibe un cambio remoto de `inventory.stock`, no sobrescribir directamente: calcular delta y aplicar de forma segura, o marcar como conflicto para revisión manual.

**Etapa 5 — Estados de cola y reintentos seguros:**
- `sync_queue` con estados `pending/processing/synced/failed`.
- `attempts` y `last_error`.
- Bloqueo optimista al reclamar items pendientes.

**Etapa 6 — Pruebas:**
- Pruebas de sincronización con mock de Supabase (escenarios A-H).
- Pruebas de concurrencia (dos dispositivos simulados).
- Pruebas de idempotencia de reintentos.

---

## 14. Plan de pruebas (futura implementación)

| Prueba | Qué verificar | Tablas a consultar |
|--------|---------------|-------------------|
| Sincronización normal | Venta local aparece en remoto | `inventory`, `stock_movements`, `sync_queue` |
| Reintentos | Upsert fallido se reintenta sin duplicar | `sync_queue`, `sync_stock_movements` |
| Duplicación de mensajes | Mismo `uuid` enviado dos veces → una sola fila | `sync_stock_movements` (índice único uuid) |
| Pérdida de Internet | Operaciones pendientes sobreviven al reinicio | `sync_queue` (`synced = 0`) |
| Reinicio durante sync | Cola no se corrompe | `sync_queue`, `_sync_flag` |
| Dos dispositivos | Stock final = inicial - suma de ventas | `inventory.stock` en ambos |
| Conflictos de versiones | Cambio con versión antigua rechazado | `inventory.version` |
| Cancelación | `return` sincronizado, stock consistente | `stock_movements.movement_type = 'return'` |
| Reapertura | Re-discount sincronizado sin duplicar | `stock_movements`, `orders.status` |
| Modificación de pedido | Diff de stock sincronizado | `stock_movements`, `order_items` |
| Stock negativo autorizado | `shortage` registrado, stock negativo permitido | `stock_movements.shortage_quantity` |
| Faltantes sin auth | Stock → 0, `shortage` registrado | `inventory.stock = 0`, `stock_movements` |
| Producto nuevo | UUID estable, relaciones intactas | `inventory.uuid`, `order_items.invId` |
| Eliminación lógica | `deleted = 1` propaga, no reaparece | `inventory.deleted` |
| Recuperación tras fallo | Cola `failed` se reintenta | `sync_queue.status = 'failed'` |

Todas las pruebas deben usar SQLite aislada en memoria y un entorno Supabase de pruebas. Nunca producción.

---

## 15. Archivos que habría que modificar en una futura fase

| Archivo | Cambio previsto |
|---------|-----------------|
| `db.js` | Añadir `stock_movements` a `SYNC_TABLES`; columnas `uuid`/`updated_at`/`device_id`/`deleted`/`version` en tablas sincronizadas; triggers de `sync_queue` para `stock_movements`; estados de cola en `sync_queue`. |
| `sync-engine.js` | Entradas en `ALLOWED_COLUMNS` y `OUTPUT_COLUMNS` para `stock_movements`; lógica de resolución de conflictos de stock (no solo `stock = valor_local`); manejo de estados `processing/failed` en `flushQueue`. |
| `routes/inventory.js` | Si se añade validación semántica de stock remoto entrante. |
| `routes/orders.js` | Sin cambios esperados (ya usa `recordStockMovement` con UUID determinístico). |
| `tests/sync-security.test.js` | Ampliar para incluir `stock_movements`. |
| `tests/sync-integration.test.js` | Pruebas de push/pull de movimientos, idempotencia, conflictos. |

---

## 16. Confirmación de no modificación

- ✅ No se modificó ningún archivo del proyecto durante esta fase.
- ✅ No se crearon migraciones.
- ✅ No se ejecutaron `UPDATE`/`INSERT`/`DELETE` sobre la base de producción.
- ✅ No se modificaron datos de Supabase.
- ✅ No se ejecutaron sincronizaciones manuales.
- ✅ No se cambiaron credenciales ni configuraciones.
- ✅ No se ejecutó `npm audit fix`.
- ✅ No se actualizaron dependencias.
- ✅ No se cambiaron versiones de Node, Electron o SQLite.
- ✅ No se eliminaron archivos ni backups.

---

## 17. Hallazgos clasificados por severidad

| ID | Severidad | Hallazgo | Archivo / Función | Evidencia |
|----|-----------|----------|-------------------|-----------|
| H1 | CRÍTICO | `stock_movements` no se sincroniza (no está en `SYNC_TABLES`) | `db.js` línea 786; `sync-engine.js` líneas 325-364 | `SYNC_TABLES = ['orders', 'order_items', 'tables', 'menu_items', 'inventory', 'customers', 'employees', 'categories', 'subcategories']` — no incluye `stock_movements` |
| H2 | CRÍTICO | Stock sincronizado como valor absoluto (`stock = valor_local`) sin resolución de conflictos semánticos | `sync-engine.js` `flushQueue` línea 356 (`upsert` con `data.stock`); `applyRemoteRow` línea 560 (`UPDATE ... SET stock = ?`) | `OUTPUT_COLUMNS.inventory` incluye `'stock'` (línea 99); `applyRemoteRow` hace `UPDATE ${table} SET ${setClause}` con `stock` como columna cualquiera |
| H3 | CRÍTICO | Last-write-wins por `updated_at` local sin relojes sincronizados → pérdida de actualizaciones concurrentes | `sync-engine.js` `applyRemoteRow` línea 546 (`local.updated_at >= remote.updated_at`) | Comparación de timestamps locales generados por trigger SQLite (`strftime('%s','now') * 1000`, `db.js` línea 963) |
| H4 | ALTO | No hay reconstrucción remota del stock a partir de movimientos; la nube solo ve el valor absoluto | `sync-engine.js` (ninguna lógica de reconstrucción de stock desde movimientos) | Ausencia de cualquier lógica que sume `stock_movements` para calcular `inventory.stock` remoto |
| H5 | ALTO | Cancelaciones/reaperturas no son trazables remotamente (movimientos `return`/`sale` no se envían) | `db.js` `SYNC_TABLES` (línea 786); `sync-engine.js` `flushQueue` | `stock_movements` no encolado por triggers ni enviado por `flushQueue` |
| H6 | ALTO | `flushQueue` no usa transacción ni mutex; posible solapamiento de ejecuciones cada 3s | `sync-engine.js` `startPushLoop` línea 301-305 (`setInterval(flushQueue, 3000)`) | Sin mecanismo de exclusión para `flushQueue` |
| H7 | MEDIO | Datos remotos entrantes no validan rangos semánticos (ej. `stock` negativo arbitrario) | `sync-engine.js` `sanitizeRemoteColumns` línea 437 (solo valida columnas, no valores) | `safeCols` acepta cualquier valor para columnas en lista blanca |
| H8 | MEDIO | `applyRemoteRow` aplica cambios fila por fila sin transacción cruzada (orden + ítems) | `sync-engine.js` `applyRemoteRow` líneas 553-574 (UPDATE/INSERT individuales) | `pendingItemsByOrderUuid` buffer solo para order_items huérfanos, no transaccional |
| H9 | BAJO | No hay estados de cola (`processing/failed`) ni conteo de reintentos | `db.js` `sync_queue` (línea 857: solo `synced INTEGER DEFAULT 0`) | Cola binaria (synced 0/1) sin estados intermedios ni `attempts` |

---

## 18. Riesgos que requieren corrección (antes de producción multi-dispositivo)

1. **Pérdida de stock en ventas concurrentes** (H2, H3): dos dispositivos vendiendo el mismo producto pueden perder una de las operaciones.
2. **Pérdida de trazabilidad** (H1, H4, H5): la nube no sabe por qué cambió el stock, no hay historial de `sale`/`return`/`shortage`.
3. **Datos remotos no validados semánticamente** (H7): un registro remoto con `stock` absurdo se acepta si pasa la lista blanca de columnas.
4. **Sin reintentos controlados** (H9): cola binaria sin estados de fallo ni límite de reintentos.

**No se declara aprobada la implementación de sincronización para entornos multi-dispositivo hasta que H1-H5 se resuelvan.**

---

**Fin de la auditoría. Fase 2B.5 completada en modo SOLO LECTURA. Detenido a la espera de autorización explícita para la siguiente etapa.**