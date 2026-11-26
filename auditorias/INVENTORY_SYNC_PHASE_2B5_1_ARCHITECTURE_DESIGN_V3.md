# INVENTORY_SYNC_PHASE_2B5_1_ARCHITECTURE_DESIGN_V3.md

## Fase 2B.5.1 — Diseño de Arquitectura de Sincronización de Inventario (Versión 3 — Definitiva)

**Proyecto:** La Mente Maestra 3.0 (POS)  
**Archivo de origen:** `INVENTORY_SYNC_PHASE_2B5_1_ARCHITECTURE_DESIGN_V2.md`  
**Fecha:** 20/11/2026  
**Modalidad:** SOLO ANÁLISIS Y DOCUMENTACIÓN — PROHIBIDO IMPLEMENTAR  
**Estado:** PROPUESTA V3 LISTA PARA REVISIÓN  

---

## Matriz de trazabilidad de hallazgos

| ID | Hallazgo (2B.5 / V1 / V2) | Severidad | Dónde se resuelve en V3 |
|----|---------------------------|-----------|-------------------------|
| H1 | `stock_movements` no está en `SYNC_TABLES` | CRÍTICO | Sección 2 (tablas remotas), Sección 3 (RPC), Sección 8 (reconciliación) |
| H2 | Stock sincronizado como valor absoluto (`stock = valor_local`) | CRÍTICO | Sección 3 (delta en RPC), Sección 8 (prohibición de sobrescritura absoluta) |
| H3 | Resolución de conflictos por `updated_at` local | CRÍTICO | Sección 2 (versión), Sección 4 (precondiciones de versión), Sección 7 (cursor remoto) |
| H4 | No hay reconstrucción remota del stock a partir de movimientos | ALTO | Sección 3 (movimientos + stock materializado derivado), Sección 8 |
| H5 | Cancelaciones/reaperturas no trazables remotamente | ALTO | Sección 3 (movimientos `return`/`sale` vía RPC), Sección 4 |
| H6 | `flushQueue` sin mutex ni estados de cola | ALTO | Sección 6 (outbox con lease, estados, reclamo atómico) |
| V2-1 | `operation_id` vs `movement_uuid` no separados | ALTO | Sección 2 (modelo de datos), Sección 3 (contrato RPC) |
| V2-2 | `BEGIN/COMMIT` explícito en pseudocódigo PL/pgSQL | ALTO | Sección 3 (nota sobre transacción implícita de PostgreSQL) |
| V2-3 | Cursor `BIGSERIAL` insuficiente para orden de confirmación | ALTO | Sección 7 (cursor monotónico con `event_seq` + `commit_ts`) |
| V2-4 | Operaciones no agrupadas como unidad de negocio | ALTO | Sección 3.4 (operación agrupada con movimientos hijos) |
| V2-5 | Concurrencia de pedidos no resuelta formalmente | CRÍTICO | Sección 4 (7 escenarios, dependencias causales, política de conflictos) |
| V2-6 | Migración permite stocks absolutos por dispositivo | CRÍTICO | Sección 9 (bootstrap centralizado, saldo inicial canónico) |
| V2-7 | Dispositivos nuevos con registro implícito | ALTO | Sección 8 (registro explícito, revocación, no registro implícito) |

---

## 1. Arquitectura definitiva

### 1.1 Principios rectores

1. **SQLite local es el almacenamiento operativo.** El POS funciona sin conexión.
2. **Cada operación de negocio tiene identidad global única (UUID).** No se usa `id` entero local como identificador global.
3. **`stock_movements` es la fuente de trazabilidad.** El stock materializado es un derivado.
4. **Los movimientos se sincronizan como operaciones individuales agrupadas.** Nunca se sincroniza stock como valor absoluto.
5. **Idempotencia en servidor.** Una operación con el mismo UUID y contenido se aplica una sola vez.
6. **No se mantiene una transacción SQLite abierta durante una llamada HTTP.**
7. **Realtime es notificación, no única fuente de verdad.** Existe un cursor remoto monotónico por restaurante para recuperación.
8. **Nunca confiar en `user_role`, `authorized_by` ni `device_id` recibidos del cliente sin validación JWT.**
9. **Una operación confirmada localmente nunca desaparece silenciosamente por un conflicto remoto.**

### 1.2 Componentes lógicos

```
┌─────────────────────────────────────────────────────────────────────┐
│                   DISPOSITIVO LOCAL (Electron + Node)               │
│                                                                     │
│  ┌─────────────────┐    ┌──────────────────┐    ┌──────────────┐   │
│  │   Express       │    │   SQLite local   │    │  sync-engine │   │
│  │   (routes)      │    │   (db.js)        │    │   (outbox)   │   │
│  └───────┬─────────┘    └────────┬─────────┘    └──────┬──────┘   │
│          │ Transacción atómica │                      │            │
│          │ (stock + movimientos│                      │            │
│          │  + outbox)          │                      │            │
│          ▼                     ▼                     ▼            │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │              Outbox de inventario (sync_queue)               │   │
│  │  operation_id (UUID) | entity_type | entity_uuid | op_type   │   │
│  │  payload (JSON) | idempotency_key | status | lease           │   │
│  │  attempts | last_error | created_at | claimed_at | device_id  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│          │                                                          │
│          │ HTTP (anon key, JWT autenticado)                         │
│          ▼                                                          │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    SUPABASE (remoto)                          │   │
│  │                                                                   │   │
│  │  ┌─────────────────────────────────────────────────────────┐   │   │
│  │  │  RPC apply_inventory_operation (TX implícita PostgreSQL)│   │   │
│  │  │  - valida UUID e idempotency_key                        │   │   │
│  │  │  - compara contenido si ya existe                       │   │   │
│  │  │  - registra operación agrupada + movimientos hijos      │   │   │
│  │  │  - actualiza stock materializado (delta)                │   │   │
│  │  │  - valida RLS y permisos de sesión JWT                  │   │   │
│  │  └─────────────────────────────────────────────────────────┘   │   │
│  │                                                                   │   │
│  │  Tabla sync_events (cursor remoto monotónico)                  │   │   │
│  │  Realtime (canal por restaurant_id) → notificación             │   │   │
│  └──────────────────────────────────────────────────────────────┘   │
│          │                                                          │
│          │ Evento remoto aplicado una sola vez (UUID)               │
│          ▼                                                          │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Aplicación local de evento remoto (applyRemoteRow)          │   │   │
│  │  - solo si UUID no existe localmente                         │   │   │
│  │  - stock materializado = stock local + delta remoto          │   │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Modelo de datos completo

### 2.1 Tablas locales (SQLite) — descripción lógica

#### `inventory` (existente, se conserva y amplía)
| Columna | Tipo | Rol |
|---------|------|-----|
| `id` | INTEGER PK | Identificador local operativo (NUNCA se envía como global) |
| `uuid` | TEXT UNIQUE NOT NULL | Identificador estable global del producto |
| `stock` | REAL | Stock materializado local (derivado) |
| `version` | INTEGER NOT NULL DEFAULT 1 | Versión del registro para control de concurrencia (se incrementa en cada cambio) |
| `device_id` | TEXT | Dispositivo que originó el último cambio |
| `updated_at` | INTEGER | Timestamp local de última modificación |
| `deleted` | INTEGER DEFAULT 0 | Borrado lógico |

#### `stock_movements` (existente, se conserva y amplía)
| Columna | Tipo | Rol |
|---------|------|-----|
| `id` | INTEGER PK | Identificador local |
| `uuid` | TEXT UNIQUE NOT NULL | Identificador global del movimiento |
| `idempotency_key` | TEXT UNIQUE NOT NULL | Clave determinística para idempotencia |
| `inventory_uuid` | TEXT NOT NULL | UUID del producto (referencia estable) |
| `order_uuid` | TEXT | UUID del pedido relacionado (si aplica) |
| `operation_id` | TEXT NOT NULL | UUID de la operación de negocio padre |
| `movement_uuid` | TEXT UNIQUE NOT NULL | UUID del movimiento individual (hijo) |
| `movement_type` | TEXT NOT NULL | `sale`, `return`, `shortage`, `adjustment` |
| `quantity` | REAL NOT NULL | Cantidad positiva (magnitud) |
| `stock_before` | REAL | Stock materializado local antes (solo referencia) |
| `stock_after` | REAL | Stock materializado local después (solo referencia) |
| `shortage_quantity` | REAL DEFAULT 0 | Cantidad de faltante |
| `reference_type` | TEXT | `order`, `decrement`, `adjustment` |
| `reference_id` | TEXT | ID de referencia (texto para UUIDs) |
| `authorized_by` | TEXT | Usuario que autorizó (validado en servidor) |
| `user_name` | TEXT | Usuario responsable |
| `user_role` | TEXT | Rol del usuario responsable |
| `device_id` | TEXT | Dispositivo origen |
| `created_at` | INTEGER NOT NULL | Timestamp de creación local |
| `synced_at` | INTEGER | Timestamp de confirmación remota |
| `deleted` | INTEGER DEFAULT 0 | Borrado lógico |

#### `sync_queue` (outbox de inventario — diseño)
| Columna | Tipo | Rol |
|---------|------|-----|
| `id` | INTEGER PK | Identificador local de la cola |
| `operation_id` | TEXT UNIQUE NOT NULL | UUID de la operación de negocio padre |
| `entity_type` | TEXT NOT NULL | `inventory_operation`, `order`, `order_item` |
| `entity_uuid` | TEXT NOT NULL | UUID de la entidad afectada |
| `op_type` | TEXT NOT NULL | `sale`, `return`, `shortage`, `adjustment`, `create`, `update`, `delete` |
| `payload` | TEXT NOT NULL (JSON) | Datos completos de la operación agrupada |
| `idempotency_key` | TEXT UNIQUE NOT NULL | Clave determinística para idempotencia remota |
| `status` | TEXT NOT NULL DEFAULT 'pending' | `pending`, `claimed`, `synced`, `failed`, `dead` |
| `lease_owner` | TEXT | ID del proceso que reclamó la operación |
| `lease_expires_at` | INTEGER | Vencimiento del lease (ms epoch) |
| `attempts` | INTEGER NOT NULL DEFAULT 0 | Número de intentos |
| `last_error` | TEXT | Último mensaje de error |
| `created_at` | INTEGER NOT NULL | Fecha de creación |
| `claimed_at` | INTEGER | Fecha de última reclamación |
| `synced_at` | INTEGER | Fecha de confirmación remota |
| `device_id` | TEXT NOT NULL | Dispositivo que originó la operación |
| `restaurant_id` | TEXT NOT NULL | ID del restaurante para aislamiento |

#### `sync_events_local` (cursor de eventos remotos aplicados localmente)
| Columna | Tipo | Rol |
|---------|------|-----|
| `event_seq` | INTEGER PK | Secuencia local de aplicación |
| `remote_event_id` | TEXT UNIQUE NOT NULL | ID del evento remoto (UUID del sync_events remoto) |
| `operation_id` | TEXT | UUID de la operación aplicada |
| `entity_type` | TEXT | Tipo de entidad |
| `op_type` | TEXT | Tipo de operación |
| `applied_at` | INTEGER NOT NULL | Momento de aplicación local |

### 2.2 Tablas remotas (Supabase) — diseño lógico

#### `inventory_sync`
| Columna | Tipo | Rol |
|---------|------|-----|
| `uuid` | UUID PK | Identificador estable del producto |
| `restaurant_id` | UUID NOT NULL | Aislamiento de negocio |
| `stock` | REAL NOT NULL DEFAULT 0 | Stock materializado remoto |
| `version` | INTEGER NOT NULL DEFAULT 1 | Versión para control de concurrencia (optimista) |
| `device_id` | TEXT | Dispositivo última modificación |
| `updated_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | Última actualización remota |
| `deleted` | BOOLEAN NOT NULL DEFAULT FALSE | Borrado lógico |

#### `stock_movements_sync`
| Columna | Tipo | Rol |
|---------|------|-----|
| `movement_uuid` | UUID PK | Identificador estable del movimiento |
| `operation_id` | UUID NOT NULL | UUID de la operación de negocio padre |
| `idempotency_key` | TEXT UNIQUE NOT NULL | Clave determinística |
| `restaurant_id` | UUID NOT NULL | Aislamiento de negocio |
| `inventory_uuid` | UUID NOT NULL | Referencia al producto |
| `order_uuid` | UUID | Referencia al pedido |
| `movement_type` | TEXT NOT NULL | `sale`, `return`, `shortage`, `adjustment` |
| `quantity` | REAL NOT NULL | Cantidad positiva |
| `shortage_quantity` | REAL NOT NULL DEFAULT 0 | Faltante |
| `reference_type` | TEXT | Tipo de referencia |
| `reference_id` | TEXT | ID de referencia |
| `user_name` | TEXT NOT NULL | Usuario responsable |
| `user_role` | TEXT NOT NULL | Rol responsable |
| `authorized_by` | TEXT | Autorizador (si aplica) |
| `device_id` | TEXT NOT NULL | Dispositivo origen |
| `created_at` | TIMESTAMPTZ NOT NULL | Momento de creación local original |
| `synced_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | Confirmación remota |
| `deleted` | BOOLEAN NOT NULL DEFAULT FALSE | Borrado lógico |

#### `inventory_operations` (operaciones agrupadas)
| Columna | Tipo | Rol |
|---------|------|-----|
| `operation_id` | UUID PK | Identidad global de la operación |
| `idempotency_key` | TEXT UNIQUE NOT NULL | Clave determinística |
| `restaurant_id` | UUID NOT NULL | Aislamiento de negocio |
| `entity_type` | TEXT NOT NULL | `order`, `inventory` |
| `entity_uuid` | UUID NOT NULL | UUID de la entidad principal |
| `op_type` | TEXT NOT NULL | Tipo de operación de negocio |
| `payload` | JSONB NOT NULL | Datos completos de la operación |
| `status` | TEXT NOT NULL DEFAULT 'applied' | `applied`, `rejected` |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | Momento de aplicación remota |

#### `sync_events` (cursor remoto monotónico)
| Columna | Tipo | Rol |
|---------|------|-----|
| `event_seq` | BIGSERIAL PK | Secuencia de publicación remota |
| `operation_id` | UUID NOT NULL | Operación aplicada |
| `entity_type` | TEXT NOT NULL | Tipo de entidad |
| `op_type` | TEXT NOT NULL | Tipo de operación |
| `restaurant_id` | UUID NOT NULL | Restaurante |
| `commit_ts` | TIMESTAMPTZ NOT NULL DEFAULT now() | Momento de confirmación de transacción |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | Momento de inserción |

**Restricciones UNIQUE e índices remotos:**
- `stock_movements_sync.movement_uuid` → PK
- `stock_movements_sync.idempotency_key` → UNIQUE
- `stock_movements_sync.operation_id` → INDEX (para consultas por operación)
- `inventory_operations.operation_id` → PK
- `inventory_operations.idempotency_key` → UNIQUE
- `sync_events.event_seq` → PK (monotónico automático)
- `sync_events.operation_id` → INDEX

---

## 3. Contratos de operaciones y RPC

### 3.1 Identidades separadas (formal)

| Identidad | Propósito | Ejemplo |
|-----------|-----------|---------|
| `operation_id` | UUID de la operación de negocio padre (agrupa movimientos hijos) | `op-123e4567-e89b-12d3-a456-426614174000` |
| `movement_uuid` | UUID de un movimiento individual dentro de la operación | `mov-123e4567-e89b-12d3-a456-426614174001` |
| `order_uuid` | UUID del pedido relacionado | `ord-123e4567-e89b-12d3-a456-426614174002` |
| `inventory_uuid` | UUID del producto | `inv-123e4567-e89b-12d3-a456-426614174003` |
| `idempotency_key` | Clave determinística derivada de `(operation_id, movement_uuid, tipo, qty)` | `order-{orderId}-modify-sale-{invId}-{qty}` |

### 3.2 RPC: `apply_inventory_operation`

**Propósito:** Registrar una operación agrupada de inventario y actualizar stock en una única transacción PostgreSQL implícita.

**Entrada (JSON):**

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `operation_id` | UUID | Sí | Identidad global de la operación padre |
| `idempotency_key` | TEXT | Sí | Clave determinística |
| `entity_type` | TEXT | Sí | `order` o `inventory` |
| `entity_uuid` | UUID | Sí | UUID de la entidad principal |
| `op_type` | TEXT | Sí | Tipo de operación de negocio |
| `movements` | JSONB [] | Sí | Array de movimientos hijos: `{ movement_uuid, inventory_uuid, order_uuid, movement_type, quantity, shortage_quantity, reference_type, reference_id, user_name, user_role, authorized_by, device_id, created_at }` |
| `restaurant_id` | UUID | Sí | Aislamiento (validado por JWT, no del payload) |

**Lógica del servidor (PL/pgSQL — NOTA: PostgreSQL envuelve la función en una transacción implícita; NO usar BEGIN/COMMIT explícito):**

```sql
-- 1. Idempotencia de operación padre
SELECT operation_id, idempotency_key, status, payload
FROM inventory_operations
WHERE operation_id = p_operation_id
FOR UPDATE;

IF FOUND THEN
  -- Comparar contenido completo
  IF existing.idempotency_key = p_idempotency_key
     AND existing.entity_type = p_entity_type
     AND existing.entity_uuid = p_entity_uuid
     AND existing.op_type = p_op_type
     AND existing.payload = p_payload THEN
     RETURN json_build_object('status','already_applied','operation_id',p_operation_id);
  ELSE
    RAISE EXCEPTION 'operation_id_reused_with_different_content';
  END IF;
END IF;

-- 2. Validar restaurante desde JWT (no del payload)
--    p_restaurant_id se ignora; se usa auth.jwt() ->> 'restaurant_id'

-- 3. Registrar operación padre
INSERT INTO inventory_operations (operation_id, idempotency_key, restaurant_id, entity_type, entity_uuid, op_type, payload)
VALUES (p_operation_id, p_idempotency_key, p_restaurant_id, p_entity_type, p_entity_uuid, p_op_type, p_payload);

-- 4. Registrar cada movimiento hijo y actualizar stock
FOREACH movement IN ARRAY p_movements LOOP
  -- 4a. Idempotencia del movimiento hijo
  SELECT movement_uuid FROM stock_movements_sync WHERE movement_uuid = movement.movement_uuid FOR UPDATE;
  IF FOUND THEN
    -- Ya existe: no duplicar, continuar con el siguiente hijo
    CONTINUE;
  END IF;

  -- 4b. Validar tipo y cantidad
  IF movement.movement_type NOT IN ('sale','return','shortage','adjustment') THEN
    RAISE EXCEPTION 'invalid_movement_type';
  END IF;
  IF movement.quantity <= 0 AND movement.movement_type <> 'adjustment' THEN
    RAISE EXCEPTION 'quantity_must_be_positive';
  END IF;

  -- 4c. Insertar movimiento
  INSERT INTO stock_movements_sync (
    movement_uuid, operation_id, idempotency_key, restaurant_id,
    inventory_uuid, order_uuid, movement_type, quantity, shortage_quantity,
    reference_type, reference_id, user_name, user_role, authorized_by,
    device_id, created_at
  ) VALUES (
    movement.movement_uuid, p_operation_id,
    gen_random_uuid()::text || '-' || movement.movement_uuid::text, -- idempotency_key derivado
    p_restaurant_id, movement.inventory_uuid, movement.order_uuid,
    movement.movement_type, movement.quantity, movement.shortage_quantity,
    movement.reference_type, movement.reference_id, movement.user_name,
    movement.user_role, movement.authorized_by, movement.device_id,
    movement.created_at
  );

  -- 4d. Actualizar stock materializado por DELTA (no valor absoluto)
  --    sale:     stock = stock - quantity
  --    return:   stock = stock + quantity
  --    shortage: stock = stock (sin cambio, solo traza)
  --    adjustment: stock = stock + quantity (cualquier signo)
  UPDATE inventory_sync
  SET stock = COALESCE(stock, 0) +
              CASE movement.movement_type
                WHEN 'sale' THEN -movement.quantity
                WHEN 'return' THEN movement.quantity
                WHEN 'shortage' THEN 0
                WHEN 'adjustment' THEN movement.quantity
              END,
      version = version + 1,
      device_id = movement.device_id,
      updated_at = now()
  WHERE uuid = movement.inventory_uuid
    AND restaurant_id = p_restaurant_id
    AND deleted = FALSE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory_not_found';
  END IF;
END LOOP;

-- 5. Registrar evento en cursor remoto monotónico
INSERT INTO sync_events (operation_id, entity_type, op_type, restaurant_id)
VALUES (p_operation_id, p_entity_type, p_op_type, p_restaurant_id);

RETURN json_build_object('status','applied','operation_id',p_operation_id);
```

**Excepciones definidas:**
- `operation_id_reused_with_different_content` → HTTP 409 Conflict
- `inventory_not_found` → HTTP 404 Not Found
- `invalid_movement_type` → HTTP 400 Bad Request
- `quantity_must_be_positive` → HTTP 400 Bad Request
- Violación RLS / rol insuficiente → HTTP 403 Forbidden

**Seguridad de la RPC:**
- Ejecutada con privilegios del usuario autenticado (RLS activo).
- `restaurant_id` se obtiene de `auth.jwt() ->> 'restaurant_id'`, NUNCA del payload.
- `user_name`, `user_role` se obtienen del JWT.
- `authorized_by` solo se permite si el JWT tiene rol `owner` o `admin` en ese restaurante.
- `device_id` se valida contra dispositivos registrados del restaurante (no registro implícito).

### 3.3 ¿Por qué no BEGIN/COMMIT explícito?

En PostgreSQL, una función PL/pgSQL ejecutada como RPC se ejecuta dentro de una transacción implícita iniciada por el cliente. Usar `BEGIN`/`COMMIT` dentro de la función provocaría error (`cannot begin/end transactions inside a function`). La atomicidad está garantizada por el motor: si cualquier `INSERT`/`UPDATE` falla, toda la función revierte.

---

## 4. Pedidos y concurrencia

### 4.1 Identidad y versión de pedido

Cada pedido tiene:
- `order_uuid` (UUID estable).
- `order_version` (entero incremental, se incrementa en cada modificación del pedido).
- `order_status` (`pending`, `preparing`, `ready`, `delivered`, `cancelled`, `active`).

Cada operación sobre un pedido lleva:
- `operation_id` (UUID de la operación específica).
- `expected_order_version` (versión que el cliente creía al generar la operación).

### 4.2 Reglas de concurrencia por escenario

| Escenario | Dispositivo A | Dispositivo B | Resultado correcto | Mecanismo de resolución |
|-----------|---------------|---------------|-------------------|------------------------|
| **Venta y cancelación simultáneas** | Vende 3 (stock 10→7) | Cancela orden (stock 7→10) | Stock 10, cancelación registrada | Cada operación tiene `operation_id` único; `return` referencia ventas originales; `SUM(sale)-SUM(return)` define efectivo |
| **Cancelación recibida antes de la venta** | — | Cancela orden (stock 10) | Luego llega venta con `expected_order_version` desactualizado | Servidor rechaza venta: versión del pedido no coincide con la esperada (ya cancelado) |
| **Reapertura antes de recibir la cancelación** | Reabre orden (stock 10→7) | Cancela orden (stock 7→10) | Stock 10, orden cancelada | Cada transición tiene su propio `operation_id`; la cancelación posterior reintegra lo efectivo |
| **Dos modificaciones concurrentes** | Modifica 3→5 | Modifica 3→4 | Solo una se aplica; la otra recibe `CONFLICT_ORDER_VERSION` | `expected_order_version` verifica que `order.version = expected` antes de aplicar |
| **Modificación y cancelación simultáneas** | Modifica pedido | Cancela pedido | Una se aplica; la otra rechaza por versión o estado | Verificación de `order_status` y `order_version` en servidor |
| **Dos reaperturas** | Reabre orden cancelada | Reabre orden cancelada | Segunda es no-op (idempotencia por estado) | Si `order_status` ya es `active`, no se re-aplica descuento |
| **Dos cancelaciones** | Cancela orden | Cancela orden | Segunda es no-op | Si `order_status` ya es `cancelled`, no se reintegra de nuevo |
| **Reintentos con respuesta perdida** | Envía operación, no recibe respuesta | Reenvía misma operación | RPC detecta UUID existente, devuelve `already_applied` | Idempotencia por `operation_id` + comparación de contenido |
| **Operación offline con versión incompatible** | Vende offline con versión v1 | Servidor tiene versión v2 (modificado por otro dispositivo) | Servidor rechaza: versión incompatible | `expected_order_version` no coincide; cliente debe refrescar y regenerar |

### 4.3 Devoluciones y referencias

- Un `return` debe referenciar una `sale` original del mismo `order_uuid` + `inventory_uuid`.
- `return.quantity` nunca debe exceder `SUM(sale.quantity) - SUM(return.quantity)` previas para esa orden+producto.
- Si se intenta devolver más de lo efectivamente vendido, el servidor rechaza con `return_exceeds_sale`.

### 4.4 Política de conflictos

**Regla de oro:** Una operación confirmada localmente nunca desaparece silenciosamente. Si hay conflicto de versión, el servidor rechaza con error explícito y el cliente debe resolver manualmente (refrescar, regenerar operación, reenviar).

**Dependencias causales:**
- `return` depende causalmente de al menos una `sale` previa del mismo pedido+producto.
- `shortage` depende causalmente de una `sale` donde `quantity < cantidad_solicitada`.
- `adjustment` no tiene dependencia causal (es independiente).

---

## 5. Orden y cursor remoto

### 5.1 Problema con `BIGSERIAL`

`BIGSERIAL` garantiza unicidad y orden de inserción, pero **no** garantiza orden de confirmación de transacciones concurrentes. Dos transacciones pueden insertar con secuencias cercanas pero confirmarse en orden inverso.

### 5.2 Cursor remoto monotónico por restaurante

Diseño de `sync_events`:

| Columna | Tipo | Propósito |
|---------|------|-----------|
| `event_seq` | BIGSERIAL | Orden de inserción en la tabla |
| `commit_ts` | TIMESTAMPTZ | Momento real de confirmación de la transacción |
| `operation_id` | UUID | Operación asociada |
| `restaurant_id` | UUID | Aislamiento de negocio |

**Regla de orden:** El cursor monotónico es `event_seq`, pero para recuperación se usa el par `(event_seq, commit_ts)`. Un dispositivo solicita eventos con `event_seq > last_synced_seq`. Si dos eventos tienen `event_seq` consecutivos pero `commit_ts` desordenado, el dispositivo aplica por `event_seq` (orden de publicación del servidor), que es determinista.

### 5.3 Recuperación de eventos

- Cada dispositivo almacena `last_synced_seq` por restaurante.
- Al recuperar sincronización, solicita `SELECT * FROM sync_events WHERE restaurant_id = ? AND event_seq > ? ORDER BY event_seq ASC`.
- Realtime se usa como notificación push de nuevos eventos, pero el dispositivo puede hacer polling del cursor si Realtime no está disponible.
- Eventos duplicados: el dispositivo verifica si `remote_event_id` (UUID del `operation_id`) ya existe en `sync_events_local` antes de aplicar.

### 5.4 Eventos retrasados

Si un evento se confirma tarde (transacción lenta), recibe un `event_seq` posterior a los ya publicados. El dispositivo lo aplicará cuando alcance ese `event_seq` en el cursor. No hay pérdida porque el cursor es monotónico y sin huevos (gap-free) dentro de un restaurante.

---

## 6. Outbox

### 6.1 Inserción atómica con la operación local

Cuando una operación local modifica inventario:

```sql
BEGIN TRANSACTION;
  -- 1. Actualizar inventory.stock (delta local)
  UPDATE inventory SET stock = COALESCE(stock,0) - ?, version = version + 1 WHERE id = ?;
  
  -- 2. Registrar movimientos en stock_movements (con UUIDs determinísticos)
  INSERT OR IGNORE INTO stock_movements (... uuid, movement_uuid, operation_id, ...);
  
  -- 3. Encolar operación agrupada en sync_queue (misma transacción)
  INSERT INTO sync_queue (operation_id, entity_type, entity_uuid, op_type, payload, idempotency_key, status, created_at, device_id, restaurant_id)
  VALUES (?, 'inventory_operation', ?, 'sale', ?, ?, 'pending', ?, ?, ?);
COMMIT;
```

**Propiedad clave:** Si la transacción falla en cualquier paso, se deshace todo. Ni stock, ni movimientos, ni entrada de outbox quedan parcialmente aplicados.

### 6.2 Reclamación atómica (SQLite / better-sqlite3)

```sql
UPDATE sync_queue
SET status = 'claimed',
    lease_owner = ?,
    lease_expires_at = ?,
    claimed_at = ?
WHERE id = ?
  AND status = 'pending'
  AND (lease_expires_at IS NULL OR lease_expires_at < ?);
```

- Se verifica `changes = 1` para confirmar reclamación exclusiva.
- **Nunca** se mantiene una transacción SQLite abierta durante una llamada HTTP. El lease se establece, se hace COMMIT, luego se hace la llamada HTTP, y finalmente se actualiza el estado a `synced` o `failed` en una transacción separada.

### 6.3 Lease y vencimiento

| Campo | Propósito |
|-------|-----------|
| `lease_owner` | Identificador del proceso (`device_id:pid`) |
| `lease_expires_at` | Vencimiento (ej. `ahora + 120000 ms`) |
| `claimed_at` | Momento de última reclamación |

Si un proceso muere con operación en `claimed`, el lease expira y otra ejecución puede reclamarla.

### 6.4 Recuperación de procesos interrumpidos

Al iniciar `flushQueue`, se escanean operaciones en `claimed` con `lease_expires_at < ahora` y se vuelven a `pending`. Se reintentan normalmente (la RPC es idempotente).

### 6.5 Reintentos y backoff

| Intento | Retraso |
|---------|---------|
| 1 | inmediato |
| 2 | 5s |
| 3 | 15s |
| 4 | 60s |
| 5+ | 300s |

Tras `MAX_ATTEMPTS` (ej. 7), la operación pasa a `dead` para revisión manual.

### 6.6 Errores transitorios vs permanentes

| Tipo | Ejemplo | Acción |
|------|---------|--------|
| Transitorio | Timeout, 503, 504 | Reintentar con backoff |
| Permanente | 400, 403, 404, UUID reutilizado con contenido diferente | `dead` inmediatamente, sin reintentar |

### 6.7 Dependencias entre operaciones

- Las operaciones de un mismo pedido se encolan con el mismo `order_uuid` en el payload.
- El servidor aplica cada operación agrupada como una unidad atómica.
- Si una operación depende de otra (ej. `return` requiere `sale` previa), el cliente debe esperar a que la `sale` esté `synced` antes de enviar la `return`.

### 6.8 Retención y auditoría

- Operaciones `synced`: conservar mínimo 30 días.
- Operaciones `dead`: conservar indefinidamente para revisión manual.
- `sync_events` remoto mantiene cursor de todas las operaciones aplicadas.

---

## 7. Seguridad

### 7.1 Supabase Auth y JWT

- El cliente local se autentica contra Supabase Auth con credenciales del empleado.
- JWT claims: `sub` (usuario), `email`, `role`, `restaurant_id`.
- **Nunca** se expone `service_role` al cliente ni al renderer de Electron.

### 7.2 RLS (Row Level Security)

| Tabla | SELECT | INSERT | UPDATE |
|-------|--------|--------|--------|
| `inventory_sync` | Solo `restaurant_id` de sesión | Solo RPC | Solo RPC |
| `stock_movements_sync` | Solo `restaurant_id` de sesión | Solo RPC | Solo RPC |
| `inventory_operations` | Solo `restaurant_id` de sesión | Solo RPC | Solo RPC |
| `sync_events` | Solo `restaurant_id` de sesión | Solo RPC | Ninguna |

### 7.3 RPC y autenticación

- `apply_inventory_operation` se ejecuta con contexto del usuario autenticado.
- `restaurant_id` se obtiene del JWT, no del payload.
- `user_name`, `user_role` se obtienen del JWT.
- `authorized_by` solo si el JWT tiene rol `owner`/`admin` en ese restaurante.

### 7.4 Registro y revocación de dispositivos

- `device_id` se genera localmente (UUID persistente).
- **No se aceptan dispositivos nuevos con registro implícito.** El dispositivo debe estar pre-registrado en una tabla `devices` del restaurante (o activarse por un administrador).
- Revocación: eliminar o marcar inactivo el `device_id` en `devices`; el servidor rechaza operaciones de dispositivos revocados.

### 7.5 Autorización administrativa

- `user_role` del JWT determina si puede hacer `adjustment` o `sale` con stock negativo.
- `authorized_by` se rellena con el nombre del usuario autenticado si la operación requiere autorización y el usuario es admin/owner.
- **Nunca** se confía en `user_role` o `authorized_by` enviados en el payload sin validación contra el JWT.

### 7.6 Aislamiento de negocios

- Todas las consultas filtran por `restaurant_id` obtenido de la sesión JWT.
- Un dispositivo de un restaurante no puede ver ni modificar movimientos de otro.

### 7.7 Protección de credenciales

- `supabase_url` y `supabase_anon_key` en `config` (SQLite local).
- `supabase_anon_key` es pública por definición; no tiene privilegios de escritura directa sin RLS.
- `service_role` nunca se almacena en el cliente.

### 7.8 Pruebas de aislamiento necesarias

| Prueba | Resultado esperado |
|--------|-------------------|
| Usuario de restaurante A lee movimientos de restaurante B | 0 filas o error RLS |
| Dispositivo revocado envía operación | HTTP 403 |
| Usuario sin rol admin envía `adjustment` | HTTP 403 |
| Payload con `authorized_by` falsificado | Se ignora; se usa el del JWT |

---

## 9. Migración

### 9.1 Saldo inicial canónico

**Prohibido:** permitir que cada dispositivo envíe su `stock` local como valor absoluto durante la inicialización (esto causaría sobrescrituras y pérdidas).

**Procedimiento de bootstrap centralizado:**

1. **Detención de sincronización:** Todos los dispositivos deben detener `flushQueue` y Realtime antes de iniciar la migración.
2. **Selección de saldo inicial canónico:** Se elige un dispositivo de referencia (o el servidor) como fuente del saldo canónico para cada producto.
3. **Conciliación de diferencias:** Si dos dispositivos tienen stock diferente para el mismo producto, se registra un `adjustment` con autorización admin para llevar todos al saldo canónico.
4. **Registro de ajustes auditables:** Cada ajuste se registra como movimiento `adjustment` con `user_name` y `user_role` del administrador.
5. **Migración de productos y UUID:** Los productos existentes reciben `uuid` si no tienen (backfill). Se añade columna `version` (INTEGER DEFAULT 1).
6. **Tratamiento de movimientos históricos:** Los `stock_movements` locales existentes se conservan como trazabilidad local, pero **no se suben automáticamente** a Supabase.
7. **Tratamiento de colas antiguas:** Las entradas existentes en `sync_queue` se mantienen y se reintentan con el nuevo mecanismo (RPC idempotente).
8. **Bloqueo de clientes antiguos:** Clientes que todavía envían `stock = valor absoluto` son bloqueados o puestos en modo solo lectura hasta actualizar.
9. **Reanudación controlada:** Se reactiva la sincronización dispositivo por dispositivo, verificando con `checkIntegrity` que los conteos coincidan.

### 9.2 No inventar movimientos históricos

No se generan movimientos retroactivos para ventas pasadas. La trazabilidad remota comienza desde la activación de la nueva arquitectura.

---

## 10. Recuperación local (aplicación de eventos remotos)

### 10.1 Reglas de aplicación

Cuando llega un evento remoto (vía Realtime o polling del cursor):

1. **No duplicar movimientos:** Verificar si `movement_uuid` ya existe en `stock_movements` local. Si existe, ignorar el evento.
2. **No reaplicar operaciones propias:** Si `device_id` del evento === `DEVICE_ID` local, ignorar (eco propio).
3. **No sobrescribir operaciones locales pendientes:** Los eventos remotos se aplican como deltas sobre el stock materializado actual, sin tocar `sync_queue` local.
4. **No perder eventos por cursor adelantado:** El dispositivo aplica eventos en orden de `event_seq` desde `last_synced_seq`. Si falta un evento intermedio, se detiene y solicita recuperación.
5. **No aplicar devoluciones antes de ventas:** El servidor garantiza el orden causal; el cliente aplica eventos en el orden que llegan del cursor remoto.
6. **No corromper stock materializado:** El stock local se actualiza como `stock = stock + delta_remoto`, nunca como `stock = valor_remoto`.

### 10.2 Recuperación sin Realtime

Si Realtime no está disponible, el dispositivo hace polling del cursor `sync_events` cada intervalo configurable, aplicando eventos con `event_seq > last_synced_seq`.

---

## 11. Plan de pruebas obligatorio

Todas las pruebas usan **dos bases SQLite independientes** y un **entorno Supabase de pruebas**. Nunca producción.

| # | Prueba | Datos iniciales | Pasos | Resultado esperado | Criterio de aprobación |
|---|--------|----------------|-------|-------------------|----------------------|
| 1 | Dos SQLite independientes | Dispositivo A: stock 10. Dispositivo B: stock 10. | A vende 3, B vende 4 (offline). Ambos sincronizan. | Stock remoto = 3. Dos movimientos `sale` con UUID distintos. | `SELECT stock FROM inventory_sync WHERE uuid=?` = 3; `COUNT(*) FROM stock_movements_sync WHERE movement_type='sale'` = 2 |
| 2 | Dos procesos Node simultáneos | Una `sync_queue` con operaciones pendientes. | Dos procesos leen la cola al mismo tiempo. | Cada operación procesada exactamente una vez. | Sin duplicados en `synced`; `changes=1` en reclamo |
| 3 | Dos dispositivos offline | Stock 5 en ambos. | A vende 8 (sin auth), B vende 8 (sin auth). | Stock remoto = 0 (no negativo sin auth). Dos `shortage` de 3 cada uno. | `stock` = 0; `shortage_quantity` suma 6 |
| 4 | RPC concurrentes mismo UUID | Operación `sale` UUID-X. | Dos solicitudes RPC simultáneas con mismo UUID y payload idéntico. | Aplicada una sola vez. | `COUNT(*) FROM stock_movements_sync WHERE movement_uuid=?` = 1 |
| 5 | Mismo UUID contenido diferente | Operación `sale` UUID-X qty=3. | Segunda solicitud mismo UUID qty=5. | Servidor rechaza. | Error `operation_id_reused_with_different_content` |
| 6 | Confirmación perdida | Cliente envía operación, servidor aplica, respuesta se pierde. | Cliente reenvía misma operación. | No hay duplicación. | `COUNT(*) FROM stock_movements_sync WHERE movement_uuid=?` = 1 |
| 7 | Caída durante transacción | Cliente envía, proceso muere antes de recibir respuesta. | Operación queda en `claimed`. | Al reiniciar, lease expira y se recupera a `pending`. | `status` pasa de `claimed` a `pending` tras reinicio |
| 8 | Cursor con commits fuera de orden | Dos transacciones concurrentes en servidor. | Evento lento confirma después de evento rápido. | `event_seq` refleja orden de publicación; dispositivo aplica en ese orden. | No hay huecos en `event_seq` aplicados localmente |
| 9 | Operaciones agrupadas | Modificar pedido 3→5 (genera `sale` + `return`). | Enviar operación agrupada. | Ambos movimientos hijos aplicados atómicamente. | Ambos `movement_uuid` existen; `stock` refleja delta neto |
| 10 | Cancelación anterior a venta | Orden activa. | Cancelar orden, luego intentar vender sobre ella. | Venta rechazada (orden cancelada). | `order_status = 'cancelled`; venta no aplica |
| 11 | Modificaciones concurrentes | Pedido qty=3, versión v1. | Dispositivo A modifica a 5 (espera v1). Dispositivo B modifica a 4 (espera v1). | Una se aplica; la otra recibe `CONFLICT_ORDER_VERSION`. | Una operación `synced`; la otra rechazada con error de versión |
| 12 | Reaperturas | Orden cancelada. | Reabrir dos veces. | Segunda es no-op. | Solo un `sale` de re-discount |
| 13 | Dos cancelaciones | Orden activa con venta. | Cancelar dos veces. | Segunda es no-op. | Solo un `return` |
| 14 | Ajustes | Stock 10. | Admin hace ajuste +5. | Stock remoto = 15. | `stock` = 15; movimiento `adjustment` registrado |
| 15 | Faltantes | Stock 5. | Vender 8 sin auth. | Stock = 0, `shortage` = 3. | `stock` = 0; `shortage_quantity` = 3 |
| 16 | Stock negativo | Stock 5, admin auth. | Vender 8. | Stock remoto = -3. | `stock` = -3; `sale.quantity` = 8 |
| 17 | Migración | Productos existentes sin `uuid`. | Ejecutar bootstrap centralizado. | Todos tienen `uuid`; no se inventan movimientos históricos. | `COUNT(*) FROM inventory WHERE uuid IS NULL` = 0 |
| 18 | Clientes antiguos | Cliente envía `stock = valor absoluto`. | Enviar a RPC. | Servidor rechaza. | Error de validación (no aplica delta absoluto) |
| 19 | Seguridad entre restaurantes | Usuario restaurante A. | Intentar leer movimientos de restaurante B. | Acceso denegado por RLS. | 0 filas o error 403 |
| 20 | Revocación de dispositivos | Dispositivo D revocado. | D intenta enviar operación. | HTTP 403. | Operación no aplicada |

---

## 12. Riesgos residuales

| Riesgo | Descripción | Mitigación |
|--------|-------------|------------|
| Relojes locales no sincronizados | `created_at` local no es autoridad para orden remoto. | Usar `event_seq` del servidor como cursor monotónico. |
| Dos procesos Node sobre misma SQLite | No es el caso actual (Electron monoplanta). | Lease con `lease_owner` y `lease_expires_at`; reclamo atómico. |
| RPC de Supabase caída | Operaciones en `failed`/`claimed`. | Backoff exponencial, recuperación de lease, reintento manual. |
| Clientes antiguos con valor absoluto | Pueden sobrescribir stock. | Bloqueo de clientes antiguos, modo solo lectura hasta actualizar. |
| Stock negativo acumulado | Ventas offline concurrentes dejan stock negativo. | Aceptado como estado válido; reconciliación mediante `adjustment` con auth admin. |
| Movimientos históricos no subidos | Trazabilidad solo desde activación. | Documentar límite explícito; no inventar datos pasados. |

---

## 13. Criterios de aceptación objetivos

La arquitectura se considera aprobada cuando:

1. **No se pierde ninguna venta** en escenario de dos dispositivos concurrentes (stock remoto = inicial - suma de ventas).
2. **No se duplica ningún movimiento** ante reintentos, respuestas perdidas o UUID duplicados (conteo = operaciones únicas).
3. **Stock negativo autorizado** se permite y registra correctamente.
4. **Faltantes sin autorización** dejan stock en 0 y registran `shortage` sin descuento doble.
5. **Cancelaciones y reaperturas** son idempotentes.
6. **Operaciones pendientes sobreviven a reinicio** de Electron y se sincronizan al recuperar conexión.
7. **RLS impide acceso cruzado** entre restaurantes.
8. **UUID reutilizado con contenido diferente** es rechazado por el servidor.
9. **Nunca se usa `stock = valor absoluto`** en el servidor; solo deltas.
10. **Reclamo atómico de outbox** funciona con SQL compatible con better-sqlite3 (sin transacción abierta durante HTTP).
11. **Todas las 20 pruebas del plan de pruebas pasan** en entorno aislado.

---

**Fase 2B.5.1 (V3) completada. Arquitectura lista para revisión final. Detenido a la espera de autorización explícita para pasar a implementación.**