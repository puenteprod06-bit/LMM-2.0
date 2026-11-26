# INVENTORY_SYNC_PHASE_2B5_1_ARCHITECTURE_DESIGN.md

## Fase 2B.5.1 — Diseño de Arquitectura de Sincronización Offline-First

**Proyecto:** La Mente Maestra 3.0 (POS)  
**Tecnologías:** Electron, Node.js, Express, SQLite, Supabase  
**Fecha:** 20/11/2026  
**Modalidad:** DISEÑO Y ANÁLISIS — SIN IMPLEMENTACIÓN  
**Estado:** PROPUESTA LISTA PARA REVISIÓN  

---

## 1. Contexto

La auditoría 2B.5 encontró los siguientes problemas críticos en el mecanismo de sincronización actual:

| # | Hallazgo | Archivo / Función | Severidad |
|---|----------|-------------------|-----------|
| H1 | `stock_movements` no está en `SYNC_TABLES` | `db.js:786` | CRÍTICO |
| H2 | Stock sincronizado como valor absoluto (`stock = valor_local`) | `sync-engine.js:flushQueue` | CRÍTICO |
| H3 | Resolución de conflictos por `updated_at` local (relojes no sincronizados) | `sync-engine.js:applyRemoteRow` | CRÍTICO |
| H4 | No hay reconstrucción remota del stock a partir de movimientos | `sync-engine.js` | ALTO |
| H5 | Cancelaciones/reaperturas no trazables remotamente | `db.js:SYNC_TABLES` | ALTO |
| H6 | `flushQueue` sin mutex ni estados de cola (`processing/failed`) | `sync-engine.js:startPushLoop` | ALTO |

El escenario de dos dispositivos confirmó que se pueden perder ventas: A vende 3 (stock 10→7), B vende 4 (stock 10→6), el último en escribir deja 7 u 6, perdiendo una venta. El resultado correcto sería 3.

---

## 2. Objetivo

Diseñar una arquitectura de sincronización offline-first que:

1. Permita trabajar sin conexión (SQLite local operativo).
2. No pierda ni duplique movimientos de inventario.
3. Sincronice movimientos (`stock_movements`) como fuente de trazabilidad.
4. Actualice stock aplicando deltas, no valores absolutos.
5. Sea idempotente en servidor (Supabase RPC).
6. Resuelva conflictos entre dispositivos sin depender únicamente de timestamps locales.
7. Recupere automáticamente después de desconexiones y reinicios de Electron.
8. Conserve las reglas comerciales existentes (faltantes, stock negativo con auth, reintegros).

---

## 3. Arquitectura actual vs. propuesta

### 3.1 Arquitectura actual

```
┌──────────────┐     HTTP/Express     ┌──────────────────┐
│  Frontend    │◄─────────────────────►│  Servidor Node   │
│  (Electron)  │     SQLite local     │  + sync-engine   │
└──────────────┘     (db.js)           └────────┬────────┘
                                                │ HTTPS/WSS
                                                ▼
                                       ┌─────────────────┐
                                       │   Supabase      │
                                       │  sync_* tablas  │
                                       │ (valor absoluto)│
                                       └─────────────────┘
```

Problemas: `stock_movements` fuera de `SYNC_TABLES`, stock absoluto, conflictos por `updated_at`, `flushQueue` sin mutex.

### 3.2 Arquitectura propuesta

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   Local      │────▶│   Outbox         │────▶│   Supabase       │
│   SQLite     │     │   sync_queue     │────▶│   sync_* tablas  │
│  (stock +    │     │  + estados       │────▶│  + RPC transaccional│
│   movements) │     │   (pending/..)   │     │  (idempotente)   │
└──────────────┘     └──────────────────┘     └────────┬─────────┘
                                                       │ Realtime
                                                       ▼
                                               ┌─────────────────┐
                                               │   Aplicación    │
                                               │   remota local  │
                                               │  (applyRemote)  │
                                               └─────────────────┘
```

Componentes clave:

| Componente | Responsabilidad |
|------------|-----------------|
| `sync_queue` (ampliada) | Outbox persistente con estados `pending/processing/synced/failed` |
| `stock_movements` en `SYNC_TABLES` | Cada movimiento se encola y sincroniza como entidad propia |
| UUID determinístico | Identidad única de cada operación, generada localmente |
| Supabase RPC `apply_inventory_movement` | Transacción remota: valida UUID, aplica movimiento, actualiza stock delta |
| Columna `version` | Detección de conflictos semánticos (no solo timestamp) |
| Mutex de cola | Evitar que dos procesos procesen la misma operación |

---

## 4. Diseño de la outbox local

### 4.1 Tabla `sync_queue` (ampliada)

No se crea todavía (fase de diseño). Estructura propuesta:

```sql
CREATE TABLE IF NOT EXISTS sync_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  row_uuid TEXT NOT NULL,
  operation TEXT NOT NULL,           -- 'upsert' | 'delete' | 'movement'
  payload TEXT NOT NULL,             -- JSON con datos de la operación
  idempotency_key TEXT NOT NULL,     -- UUID determinístico de la operación
  status TEXT NOT NULL DEFAULT 'pending', -- pending|processing|synced|failed
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  processed_at INTEGER,
  device_id TEXT NOT NULL,
  UNIQUE (idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status, created_at);
CREATE INDEX IF NOT EXISTS idx_sync_queue_idempotency ON sync_queue(idempotency_key);
```

### 4.2 Inserción dentro de la misma transacción

Cuando una operación local modifica inventario (venta, cancelación, reapertura, modificación):

```sql
BEGIN TRANSACTION;
  -- 1. Actualizar inventory.stock (delta, no absoluto)
  UPDATE inventory SET stock = COALESCE(stock,0) - ? WHERE id = ?;
  
  -- 2. Registrar stock_movements (con UUID determinístico)
  INSERT OR IGNORE INTO stock_movements (... uuid, idempotency_key ...) VALUES (...);
  
  -- 3. Encolar en sync_queue (misma transacción)
  INSERT INTO sync_queue (table_name, row_uuid, operation, payload, idempotency_key, status, created_at, device_id)
  VALUES ('stock_movements', <movement_uuid>, 'movement', <payload_json>, <idempotency_key>, 'pending', <now>, <device_id>);
  
  -- 4. Si aplica, encolar order_items / orders también
  ...
COMMIT;
```

**Propiedad clave:** Si la transacción falla en cualquier paso, se deshace todo: ni stock, ni movimiento, ni entrada de outbox quedan parcialmente aplicados.

### 4.3 Evitar procesamiento simultáneo de la misma operación

Cuando `flushQueue` (o un worker) quiere procesar una operación:

```sql
BEGIN TRANSACTION;
  SELECT id, payload, status FROM sync_queue
  WHERE status = 'pending'
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;  -- o equivalent en better-sqlite3
  
  -- Marcar como processing dentro de la misma transacción
  UPDATE sync_queue SET status = 'processing', attempts = attempts + 1, processed_at = <now>
  WHERE id = ? AND status = 'pending';
COMMIT;
```

Mejor aún, en better-sqlite3 (síncrono), se puede usar una transacción con `UPDATE ... WHERE status = 'pending'` y verificar `changes > 0` para asegurar que solo un proceso/ejecución reclame la operación. Si dos procesos intentan reclamar la misma fila, solo uno obtendrá `changes > 0`.

### 4.4 Estados de la outbox

| Estado | Significado | Transición siguiente |
|--------|-------------|---------------------|
| `pending` | Lista para procesar | `processing` |
| `processing` | Enviándose a Supabase | `synced` o `failed` |
| `synced` | Confirmada en servidor | (borrada tras 24h) |
| `failed` | Error permanente tras N intentos | revisión manual o reintento forzado |

---

## 5. Diseño de Supabase

### 5.1 Función RPC transaccional propuesta

Nombre: `apply_inventory_movement`

Parámetros de entrada:

| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `p_uuid` | uuid | Identidad única de la operación (idem a `stock_movements.uuid`) |
| `p_idempotency_key` | text | Clave determinística para idempotencia |
| `p_inventory_id` | int | ID del producto (local) |
| `p_product_name` | text | Nombre del producto |
| `p_movement_type` | text | 'sale', 'return', 'shortage', 'adjustment' |
| `p_quantity` | numeric | Cantidad del movimiento |
| `p_stock_before` | numeric | Stock antes del movimiento (local) |
| `p_stock_after` | numeric | Stock después del movimiento (local) |
| `p_shortage_quantity` | numeric | Faltante, si aplica |
| `p_reference_type` | text | 'order', 'decrement', etc. |
| `p_reference_id` | int | ID de referencia (orden, etc.) |
| `p_authorized_by` | text | Usuario que autorizó (si aplica) |
| `p_user_name` | text | Usuario responsable |
| `p_user_role` | text | Rol del usuario |
| `p_device_id` | text | ID del dispositivo origen |
| `p_created_at` | bigint | Timestamp de creación local |

Lógica interna (pseudo-SQL PL/pgSQL):

```sql
CREATE OR REPLACE FUNCTION apply_inventory_movement(
  p_uuid uuid,
  p_idempotency_key text,
  p_inventory_id int,
  p_product_name text,
  p_movement_type text,
  p_quantity numeric,
  p_stock_before numeric,
  p_stock_after numeric,
  p_shortage_quantity numeric DEFAULT 0,
  p_reference_type text,
  p_reference_id int,
  p_authorized_by text,
  p_user_name text,
  p_user_role text,
  p_device_id text,
  p_created_at bigint
)
RETURNS json AS $$
DECLARE
  v_existing int;
  v_current_stock numeric;
BEGIN
  -- 1. Idempotencia: si ya se aplicó este UUID, devolver resultado previo
  SELECT COUNT(*) INTO v_existing
  FROM stock_movements_sync
  WHERE uuid = p_uuid;

  IF v_existing > 0 THEN
    RETURN json_build_object(
      'status', 'already_applied',
      'uuid', p_uuid,
      'applied_at', (SELECT created_at FROM stock_movements_sync WHERE uuid = p_uuid LIMIT 1)
    );
  END IF;

  -- 2. Registrar movimiento (tabla de sincronización en Supabase)
  INSERT INTO stock_movements_sync (
    uuid, idempotency_key, inventory_id, product_name, movement_type,
    quantity, stock_before, stock_after, shortage_quantity,
    reference_type, reference_id, authorized_by, user_name, user_role,
    device_id, created_at, synced_at
  ) VALUES (
    p_uuid, p_idempotency_key, p_inventory_id, p_product_name, p_movement_type,
    p_quantity, p_stock_before, p_stock_after, p_shortage_quantity,
    p_reference_type, p_reference_id, p_authorized_by, p_user_name, p_user_role,
    p_device_id, p_created_at, now()
  );

  -- 3. Actualizar stock aplicando delta (no valor absoluto)
  --    stock_after_local - stock_before_local = delta
  UPDATE inventory_sync
  SET stock = COALESCE(stock, 0) + (p_stock_after - p_stock_before),
      updated_at = now(),
      device_id = p_device_id
  WHERE id = p_inventory_id;

  -- 4. Si el producto no existe en Supabase, crearlo con el stock recibido
  IF NOT FOUND THEN
    INSERT INTO inventory_sync (id, name, stock, device_id, created_at, updated_at)
    VALUES (p_inventory_id, p_product_name, p_stock_after, p_device_id, now(), now());
  END IF;

  RETURN json_build_object(
    'status', 'applied',
    'uuid', p_uuid,
    'stock_after', COALESCE((SELECT stock FROM inventory_sync WHERE id = p_inventory_id), 0)
  );

EXCEPTION
  WHEN unique_violation THEN
    -- UUID duplicado (carrera entre dos procesos del servidor)
    RETURN json_build_object('status', 'already_applied', 'uuid', p_uuid);
  WHEN OTHERS THEN
    RAISE;
END;
$$ LANGUAGE plpgsql;
```

### 5.2 Restricciones UNIQUE e índices

| Objeto | Tipo | Propósito |
|--------|------|-----------|
| `stock_movements_sync.uuid` | UNIQUE | Evitar duplicados de movimiento |
| `stock_movements_sync.idempotency_key` | UNIQUE | Idempotencia por clave determinística |
| `inventory_sync.id` | PRIMARY KEY | Identidad del producto |
| `inventory_sync.uuid` | UNIQUE | UUID estable del producto |

### 5.3 Políticas RLS

- `stock_movements_sync`: solo INSERT por clientes autenticados con `anon key`; SELECT restringido a roles de servicio.
- `inventory_sync`: UPDATE solo vía RPC `apply_inventory_movement` (no directo desde cliente).
- El cliente local (Electron) usa `supabase_anon_key`; nunca `service_role`.

### 5.4 ¿Por qué RPC y no upsert directo?

Un `upsert` directo de `inventory` con `stock = valor_local` permite sobrescribir stock ajeno (H2, H3). La RPC:
- Aplica **delta** (`stock_after - stock_before`), no valor absoluto.
- Valida UUID antes de aplicar (idempotencia).
- Ejecuta todo en una transacción de servidor (movimiento + stock atómico).
- Devuelve resultado confirmado al cliente.

---

## 6. Conflictos entre dispositivos

### 6.1 Elementos de identidad (distinguir claramente)

| Concepto | Significado |
|----------|-------------|
| **Orden de recepción en servidor** | Secuencia en que Supabase recibe la RPC (para auditoría, no para decidir validez) |
| **Identidad de operación** | `uuid` + `idempotency_key` (quién es la operación) |
| **Momento de creación local** | `created_at` (cuando se generó en el dispositivo, solo informativo) |
| **Versión del registro** | `version` en `inventory` (incremental por cambio) |
| **Estado de sincronización** | `sync_queue.status` (pendiente, procesando, sincronizada, fallida) |

### 6.2 Resolución de conflictos

**Regla principal:** Nunca usar `updated_at` local como única autoridad para decidir qué stock prevalece.

**Escenario: Dos ventas simultáneas offline**

| Paso | Dispositivo A | Dispositivo B |
|------|---------------|---------------|
| Stock inicial (ambos) | 10 | 10 |
| Venta A de 3 | stock local → 7, movimiento `sale` qty=3 UUID-A | — |
| Venta B de 4 | — | stock local → 6, movimiento `sale` qty=4 UUID-B |
| A sincroniza | RPC: delta = -3, stock remoto → 7 | — |
| B sincroniza | — | RPC: delta = -4, stock remoto → 3 |

**Resultado:** stock remoto = 3. Ambas ventas aplicadas. ✓

**Escenario: Venta y cancelación simultáneas**

| Paso | Dispositivo A (venta) | Dispositivo B (cancelación) |
|------|-----------------------|-----------------------------|
| Stock inicial | 10 | 10 |
| A vende 3 | stock 7, `sale` qty=3 | — |
| B cancela orden de 3 | — | stock 10, `return` qty=3 |
| A sincroniza | stock remoto → 7 | — |
| B sincroniza | — | stock remoto → 7+3 = 10 |

**Resultado:** stock 10, cancelación aplicada correctamente. ✓

**Escenario: Reapertura mientras otro dispositivo modifica**

| Paso | Dispositivo A (reabre) | Dispositivo B (modifica) |
|------|------------------------|--------------------------|
| Estado orden | cancelada | activa |
| Stock | 10 | 10 |
| A reabre | `sale` qty=3 (re-discount SUM(sale)), stock → 7 | — |
| B modifica orden (3→5) | — | `sale` delta=+2, stock → 8 |
| A sincroniza | stock remoto → 7 | — |
| B sincroniza | — | stock remoto → 8-2 = 6 |

**Resultado:** stock 6. ✓

### 6.3 Stock negativo remoto por operaciones offline concurrentes

Si dos dispositivos venden sin autorización y el stock local de cada uno llega a 0, pero ambos envían `sale`:

| Paso | Dispositivo A | Dispositivo B |
|------|---------------|---------------|
| Stock inicial remoto | 5 | 5 |
| A vende 8 sin auth | stock local → 0, `sale` qty=5, `shortage` qty=3 | — |
| B vende 8 sin auth | — | stock local → 0, `sale` qty=5, `shortage` qty=3 |
| A sincroniza | RPC delta=-5, stock remoto → 0 | — |
| B sincroniza | — | RPC delta=-5, stock remoto → -5 |

**Resultado:** stock remoto = -5 (negativo). Esto es **aceptable y esperado** porque representa ventas reales confirmadas localmente. El sistema debe:
- Registrar el stock negativo en Supabase como estado válido.
- Informar en el dashboard de sincronización que existe stock negativo.
- Permitir que un administrador ajuste el stock manualmente (ajuste de inventario registrado como `adjustment`).

**Regla:** La sincronización no debe rechazar silenciosamente ventas confirmadas localmente. El stock negativo remoto se reconcilia mediante ajuste de inventario (`movement_type = 'adjustment'`), no descartando operaciones originales.

---

## 7. Reglas comerciales obligatorias (conservadas)

| Regla | Comportamiento local | Comportamiento al sincronizar |
|-------|---------------------|------------------------------|
| Stock suficiente | Descuento normal | `sale` qty = cantidad solicitada, delta negativo |
| Stock insuficiente sin auth | Venta permitida, stock → 0, `shortage` registrado | `sale` qty = disponible, `shortage` qty = faltante |
| Auth admin válida | Stock negativo permitido | `sale` qty = cantidad completa, delta negativo (stock puede quedar negativo remoto) |
| Cancelación | Reintegra `SUM(sale) - SUM(return)` | `return` qty = efectivo descontado, delta positivo |
| Reapertura | Re-descuenta `SUM(sale)` reconstruido | `sale` qty = efectivo vendido, delta negativo |
| Modificación | Diff-based reconciliation | `sale`/`return` deltas según diferencia |
| Ningún reintento duplica | `INSERT OR IGNORE` local | UUID + `idempotency_key` en servidor |

---

## 8. Arquitectura de recuperación

### 8.1 Reintentos con backoff

- `flushQueue` intenta enviar operaciones `pending` cada 3s.
- Si falla, `status` pasa a `failed` tras `attempts >= MAX_ATTEMPTS` (ej. 5).
- Backoff exponencial entre reintentos: 3s, 10s, 30s, 2min, 5min.
- Operaciones `failed` pueden reintentarse manualmente desde `/api/config/resync`.

### 8.2 Recuperación de estados `processing` abandonados

- Si una operación queda en `processing` por más de `TTL_PROCESSING` (ej. 2 min) sin transición a `synced` o `failed`, se asume abandono (proceso murió).
- Al reiniciar, `flushQueue` recupera operaciones `processing` expiradas y las vuelve a `pending`.

### 8.3 Mutex entre procesos

- better-sqlite3 es síncrono; dentro de un mismo proceso Node, `flushQueue` no se solapa si se ejecuta de forma secuencial.
- Si hubiera múltiples procesos (no es el caso actual de Electron), se usaría `UPDATE sync_queue SET status='processing' WHERE id=? AND status='pending'` y verificar `changes > 0` para reclamar exclusivamente.

### 8.4 Confirmación de operaciones

- El cliente considera una operación sincronizada solo cuando `sync_queue.status = 'synced'` (tras respuesta exitosa de la RPC).
- Si la respuesta de la RPC se pierde pero el servidor aplicó la operación, el reenvío es idempotente (UUID ya existe → `already_applied`).

### 8.5 Errores permanentes

- Operaciones en `failed` tras MAX_ATTEMPTS se marcan para revisión manual.
- El dashboard de sincronización muestra conteo de `failed` y último error.
- Un administrador puede forzar reintento o descartar la operación.

### 8.6 Observabilidad y logs

- `flushQueue` loguea: items leídos, enviados, errores, cambios de estado.
- `applyRemoteRow` loguea: UUID aplicado, tabla, resultado (UPDATE/INSERT/skip).
- Endpoint `/api/config/sync-status` expone: `enabled`, `isOnline`, `pendingCount`, `failedCount`, `deviceId`.
- Endpoint `/api/config/sync-check` compara conteos local vs remoto por tabla.

### 8.7 Reconciliación ante inconsistencias

- `checkIntegrity` compara conteos de filas no borradas por tabla entre local y remoto.
- Si hay desfasaje, se reporta (no se repara automáticamente para evitar sobrescrituras ciegas).
- Un administrador puede forzar `resync` (re-encolar operaciones pendientes).

---

## 9. Migración y compatibilidad

### 9.1 ¿Qué se debe migrar?

| Elemento | Acción |
|----------|--------|
| Stock existente | Se mantiene como valor actual en `inventory.stock`. No se recalcula. |
| Productos existentes | Se les asigna `uuid` (ya existe backfill en `db.js` líneas 820-835). |
| Movimientos locales históricos | Quedan en SQLite local como trazabilidad. No se suben automáticamente (evitar aplicar miles de movimientos antiguos). |
| Operaciones pendientes | Quedan en `sync_queue` con `synced = 0`. Se reintentan al activar el nuevo motor. |
| Registros remotos existentes | Se mantienen. La nueva RPC `apply_inventory_movement` coexiste con el `upsert` actual durante un período de transición. |

### 9.2 Trazabilidad histórica

- No se generan movimientos retroactivos para ventas pasadas (sería inventar datos).
- A partir de la activación de la nueva arquitectura, todos los movimientos nuevos se sincronizan.
- Los dispositivos existentes con versión antigua siguen funcionando con el mecanismo actual (valor absoluto) hasta que se actualicen.

### 9.3 Compatibilidad de versiones de base de datos

- No se asume que todos los dispositivos tienen la misma versión.
- `applyRemoteRow` valida columnas contra `ALLOWED_COLUMNS`; columnas desconocidas se descartan.
- Si un dispositivo remoto envía un movimiento con campos que el local no reconoce, se ignoran esos campos sin fallar.

### 9.4 Evitar aplicar movimientos antiguos dos veces

- Cada movimiento tiene `uuid` determinístico.
- `INSERT OR IGNORE` local + `UNIQUE (uuid)` remoto evitan duplicados.
- Al activar la nueva arquitectura, los movimientos ya sincronizados bajo el esquema anterior (si los hubiera) se reconocen por su `uuid` y no se vuelven a aplicar.

---

## 10. Comparación de alternativas

| Criterio | A: Valor absoluto (actual) | B: Solo movimientos | C: Híbrida (movimientos + outbox + stock materializado) |
|----------|---------------------------|---------------------|----------------------------------------------------------|
| Pierde ventas concurrentes | Sí (último escribe gana) | No | No |
| Trazabilidad de movimientos | No | Sí | Sí |
| Stock materializado disponible | Sí | No (derivado) | Sí |
| Complejidad de implementación | Baja | Media | Media-Alta |
| Migración necesaria | No | Sí (nueva tabla sync) | Sí (outbox + version + RPC) |
| Compatible con reglas actuales | Parcial | Sí | Sí |
| Resuelve conflictos sin timestamps | No | Sí (todos los movimientos aplican) | Sí (deltas + versión) |

**Recomendación: Alternativa C (híbrida).**

Justificación:
- Mantiene `inventory.stock` materializado para consultas rápidas del POS (compatible con la UI actual).
- Sincroniza `stock_movements` como fuente de trazabilidad y para reconstrucción si es necesario.
- Usa deltas en la RPC para no perder actualizaciones concurrentes.
- Outbox con estados garantiza supervivencia a reinicios y reintentos seguros.
- Es la menor desviación del código actual que resuelve H1-H6.

---

## 11. Diagrama de componentes (propuesto)

```
┌─────────────────────────────────────────────────────────────┐
│                   DISPOSITIVO LOCAL (Electron)              │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐   │
│  │  Express     │  │   SQLite     │  │   sync-engine   │   │
│  │  routes      │  │   local      │  │   (flushQueue)  │   │
│  └──────┬───────┘  └──────┬───────┘  └────────┬────────┘   │
│         │                 │                   │             │
│         │  INSERT/UPDATE  │                   │             │
│         │  (transacción)  │                   │             │
│         ▼                 ▼                   ▼             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │           sync_queue (outbox local)                 │   │
│  │  id | table | uuid | operation | payload | status   │   │
│  │                                                        │
│  │  estados: pending → processing → synced / failed    │   │
│  └─────────────────────────────────────────────────────┘   │
│         │                                                   │
│         │ HTTPS (anon key)                                  │
│         ▼                                                   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │           SUPABASE (remoto)                         │   │
│  │  ┌─────────────────────────────────────────────┐  │   │
│  │  │  RPC apply_inventory_movement (transacción)   │  │   │
│  │  │  - valida UUID (idempotencia)                 │  │   │
│  │  │  - registra stock_movements_sync              │  │   │
│  │  │  - actualiza inventory_sync (delta)           │  │   │
│  │  └─────────────────────────────────────────────┘  │   │
│  │  ┌─────────────────────────────────────────────┐  │   │
│  │  │  Realtime → applyRemoteRow (pull)             │  │   │
│  │  └─────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## 12. Flujo local (venta con stock insuficiente, sin auth)

1. Usuario vende 8 unidades de producto con stock 5.
2. `routes/inventory.js` / `routes/orders.js`:
   - `BEGIN TRANSACTION`
   - `UPDATE inventory SET stock = COALESCE(stock,0) - 5 WHERE id = ?` → stock = 0
   - `INSERT INTO stock_movements (..., movement_type='sale', quantity=5, stock_before=5, stock_after=0, shortage_quantity=3, ..., idempotency_key='order-123-sale-inv-5')`
   - `INSERT INTO stock_movements (..., movement_type='shortage', quantity=3, ..., idempotency_key='order-123-shortage-inv-3')`
   - `INSERT INTO sync_queue (table_name='stock_movements', row_uuid=<uuid>, operation='movement', payload=<json>, idempotency_key=..., status='pending', ...)`
   - `COMMIT`
3. `flushQueue` (cada 3s) lee `sync_queue WHERE status='pending'`.
4. Envía payload a Supabase vía `apply_inventory_movement`.
5. Servidor aplica: `sale` qty=5, `shortage` qty=3, stock remoto = 0.
6. Respuesta exitosa → `sync_queue.status = 'synced'`.

---

## 13. Plan de implementación por etapas

| Etapa | Objetivo | Archivos que se modificarían |
|-------|----------|------------------------------|
| 1 | Ampliar `sync_queue` con estados, intentos, errores, idempotency_key | `db.js` |
| 2 | Añadir `stock_movements` a `SYNC_TABLES` y triggers de outbox | `db.js` |
| 3 | Añadir entradas en `ALLOWED_COLUMNS` y `OUTPUT_COLUMNS` para `stock_movements` | `sync-engine.js` |
| 4 | Modificar `flushQueue` para usar estados de cola y mutex de reclamación | `sync-engine.js` |
| 5 | Crear RPC `apply_inventory_movement` en Supabase (delta + idempotencia) | Supabase (SQL, fuera del repo) |
| 6 | Modificar `applyRemoteRow` para manejar `stock_movements` y resolución de conflictos por versión | `sync-engine.js` |
| 7 | Añadir columna `version` a tablas de inventario para detección de conflictos | `db.js` |
| 8 | Endpoints de administración: `failed` count, reintento forzado, `checkIntegrity` ampliado | `routes/config.js` |

---

## 14. Plan de pruebas (futura implementación)

Todas las pruebas usan SQLite aislada en memoria y un entorno Supabase de pruebas. Nunca producción.

| Prueba | Qué verificar | Consultas de verificación |
|--------|--------------|---------------------------|
| Dos dispositivos vendiendo simultáneamente | Stock final = inicial - suma de ventas | `SELECT stock FROM inventory WHERE id=?` en ambos dispositivos y remoto |
| Dos procesos de sincronización | No se procesa la misma operación dos veces | `SELECT status, attempts FROM sync_queue WHERE idempotency_key=?` |
| Reintentos duplicados | Mismo UUID aplicado una sola vez | `SELECT COUNT(*) FROM stock_movements_sync WHERE uuid=?` |
| Confirmación perdida | Reenvío es idempotente (`already_applied`) | Respuesta RPC y `sync_queue.status` |
| Caída durante RPC | Operación queda en `processing` y se recupera al reiniciar | `SELECT * FROM sync_queue WHERE status='processing'` |
| Reinicio de Electron | `sync_queue` persiste, operaciones pendientes se reintentan | `SELECT COUNT(*) FROM sync_queue WHERE status='pending'` |
| Desconexión prolongada | Operaciones se acumulan en outbox y se envían al reconectar | `SELECT COUNT(*) FROM sync_queue WHERE status='pending'` |
| Cancelación offline | `return` registrado, stock reintegrado local y remoto | `SELECT movement_type, quantity FROM stock_movements WHERE reference_id=?` |
| Reapertura offline | Re-discount = `SUM(sale)` reconstruido | `SELECT stock FROM inventory WHERE id=?` |
| Stock negativo autorizado | Stock negativo permitido con auth | `SELECT stock FROM inventory WHERE id=?` (puede ser < 0) |
| Faltantes sin auth | Stock → 0, `shortage` registrado | `SELECT stock FROM inventory`, `SELECT * FROM stock_movements WHERE movement_type='shortage'` |
| Producto nuevo offline | UUID estable, sincronizado al reconectar | `SELECT uuid FROM inventory WHERE id=?` |
| Conflictos y recuperación | `processing` expirado vuelve a `pending` | `SELECT status FROM sync_queue WHERE id=?` |

---

## 15. Riesgos pendientes

| Riesgo | Descripción | Mitigación |
|--------|-------------|------------|
| Relojes locales no sincronizados | `updated_at` no es confiable para conflictos | Usar `version` incremental y delta, no timestamp para decidir validez |
| Dos procesos Node sobre misma SQLite | No es el caso actual (Electron monoplanta), pero si ocurre | Mutex de reclamación en `sync_queue` (`status='pending' → 'processing'`) |
| RPC de Supabase caída | Operaciones quedan en `failed` | Backoff + reintento manual + observabilidad |
| Dispositivos con versión antigua | Siguen usando valor absoluto | Coexistencia temporal; nuevas versiones usan RPC con delta |
| Movimientos históricos no subidos | Trazabilidad solo desde la activación | Documentar límite; no inventar datos pasados |

---

## 16. Archivos que se modificarían posteriormente

| Archivo | Cambio previsto |
|---------|-----------------|
| `db.js` | Ampliar `sync_queue` (estados, intentos, errores, idempotency_key); añadir `stock_movements` a `SYNC_TABLES`; triggers de outbox para `stock_movements`; columna `version` en tablas de inventario |
| `sync-engine.js` | Entradas en `ALLOWED_COLUMNS`/`OUTPUT_COLUMNS` para `stock_movements`; `flushQueue` con estados y mutex; `applyRemoteRow` con manejo de `stock_movements` y conflictos por versión |
| `routes/config.js` | Endpoints de administración de cola (`failed`, reintento, `checkIntegrity` ampliado) |
| `routes/inventory.js` | Posible validación semántica de stock remoto entrante (sin modificar reglas locales) |
| `routes/orders.js` | Sin cambios esperados (ya usa `recordStockMovement` con UUID determinístico) |
| Supabase (SQL externo) | Tabla `stock_movements_sync`, tabla `inventory_sync` (o usar tablas existentes con RLS), función RPC `apply_inventory_movement` |

---

## 17. Confirmación de no modificación

- ✅ No se modificó ningún archivo del proyecto durante esta fase.
- ✅ No se crearon tablas ni migraciones.
- ✅ No se ejecutaron `UPDATE`/`INSERT`/`DELETE` sobre la base de producción.
- ✅ No se modificaron datos de Supabase.
- ✅ No se ejecutaron sincronizaciones reales.
- ✅ No se cambiaron credenciales ni configuraciones.
- ✅ No se instalaron dependencias.
- ✅ Este documento es exclusivamente diseño y análisis.

---

**Fase 2B.5.1 completada. Diseño listo para revisión. Detenido a la espera de autorización explícita para pasar a implementación.**