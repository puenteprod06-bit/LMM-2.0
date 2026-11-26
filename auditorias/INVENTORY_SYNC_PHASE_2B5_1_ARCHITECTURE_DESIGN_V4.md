# INVENTORY_SYNC_PHASE_2B5_1_ARCHITECTURE_DESIGN_V4.md

## Fase 2B.5.1 — Diseño de Arquitectura de Sincronización de Inventario (Versión 4 — Corrección Final)

**Proyecto:** La Mente Maestra 3.0 (POS)  
**Archivo de origen:** `INVENTORY_SYNC_PHASE_2B5_1_ARCHITECTURE_DESIGN_V3.md`  
**Fecha:** 20/11/2026  
**Modalidad:** SOLO ANÁLISIS Y DOCUMENTACIÓN — PROHIBIDO IMPLEMENTAR  
**Estado:** PROPUESTA V4 LISTA PARA REVISIÓN  

---

## Matriz de trazabilidad de problemas V3 → V4

| ID | Problema en V3 | Severidad | Corrección aplicada en V4 | Sección | Prueba que demuestra la solución | Riesgo residual |
|----|----------------|-----------|---------------------------|---------|----------------------------------|-----------------|
| V3-1 | `BIGSERIAL + commit_ts` afirmado como gap-free sin demostrar | CRÍTICO | Cursor por restaurante con fila de control, bloqueo transaccional, asignación de secuencia dentro de la misma transacción que registra operación y evento | 1, 6 | Prueba 14 (cursor con operaciones concurrentes y commits fuera de orden) | Dos transacciones podrían intentar insertar el mismo `event_seq` si la fila de control no se bloquea correctamente |
| V3-2 | `SELECT FOR UPDATE` sobre fila inexistente como único mecanismo de exclusión | CRÍTICO | Restricción UNIQUE real en `operation_id`, inserción atómica, manejo explícito de `ON CONFLICT`, hash criptográfico de payload | 2 | Prueba 4 (dos solicitudes RPC concurrentes con mismo UUID) | Carrera entre `INSERT ... ON CONFLICT` y lectura posterior si el control de aislamiento no es `SERIALIZABLE` o `REPEATABLE READ` |
| V3-3 | Reglas de stock insuficiente no definidas con campos explícitos | CRÍTICO | Campos: cantidad solicitada, efectivamente descontada, faltante, vendida; 3 ejemplos numéricos; pseudocódigo RPC | 4 | Prueba 16 (stock insuficiente concurrente), Prueba 17 (stock insuficiente sin auth), Prueba 18 (stock negativo autorizado) | Dos ventas offline concurrentes que parten de la misma copia podrían ser serializadas incorrectamente si el servidor no bloquea el producto |
| V3-4 | Conflictos de pedidos offline sin estados explícitos | CRÍTICO | Estados: `pendiente`, `aplicada`, `rechazada`, `en_conflicto`; mecanismo de resolución manual y automática; devoluciones referencian venta original | 5 | Prueba 10 (venta y cancelación concurrentes), Prueba 11 (modificaciones simultáneas), Prueba 12 (reaperturas), Prueba 13 (dos cancelaciones) | Operación local confirmada rechazada por versión requiere intervención manual del usuario |
| V3-5 | Contrato de eventos remotos incompleto | ALTO | `event_id` UUID, `event_seq` secuencial por restaurante, `operation_id`, `restaurant_id`, tipo, fecha confirmación; endpoint de lectura; aplicación transaccional en SQLite | 7 | Prueba 15 (realtime desconectado), Prueba 19 (recuperación del cursor), Prueba 20 (aplicación local parcial fallida) | Evento que referencia producto inexistente localmente requiere cola de espera |
| V3-6 | Seguridad Supabase sin elección explícita INVOKER/DEFINER | ALTO | Elección `SECURITY INVOKER`, políticas RLS completas, grants, validación JWT, revocación de dispositivos | 8 | Prueba 21 (dispositivo revocado), Prueba 22 (seguridad entre restaurantes) | Token comprometido permite operaciones hasta su expiración |
| V3-7 | Migración permite stocks absolutos por dispositivo | CRÍTICO | Bootstrap centralizado, detención de sincronizadores, saldo inicial canónico, ajustes auditables, cuarentena de colas antiguas | 9 | Prueba 23 (migración de colas antiguas), Prueba 24 (reconciliación del saldo inicial) | Dispositivos antiguos que no se actualicen permanecen bloqueados |
| V3-8 | Identificadores con prefijos (`op-`, `mov-`) y duplicación uuid/movement_uuid | MEDIO | UUID válidos sin prefijos; `movement_uuid` es PK de movimiento, `operation_id` es PK de operación agrupada | 3 | Prueba 25 (compatibilidad con tablas actuales) | Migración de registros existentes requiere mapeo explícito |
| V3-9 | Outbox sin detalles de reclamo atómico y lease | ALTO | Reclamo atómico, procesamiento por lotes, lease y expiración, recuperación tras caída, backoff, estados de conflicto | 9 | Prueba 2 (dos procesos Node), Prueba 6 (respuestas perdidas), Prueba 7 (caídas durante transacciones) | Dos procesos podrían reclamar si `changes` no se verifica estrictamente |
| V3-10 | Plan de pruebas insuficiente | MEDIO | 24 pruebas cubriendo todos los escenarios listados en la corrección | 10 | Todas las pruebas listadas | Algunas pruebas requieren entorno Supabase de pruebas que no está disponible localmente |

---

## 1. Arquitectura general

### 1.1 Principios rectores

1. **SQLite local es el almacenamiento operativo.** El POS funciona totalmente sin conexión.
2. **Cada operación de negocio tiene identidad global única (UUID).** No se usan IDs enteros locales como identificadores globales.
3. **`stock_movements` es la fuente de trazabilidad.** El stock materializado es un derivado.
4. **Los movimientos se sincronizan como operaciones agrupadas.** Nunca se sincroniza stock como valor absoluto.
5. **Idempotencia en servidor.** Una operación con el mismo UUID y contenido se aplica una sola vez.
6. **No se mantiene una transacción SQLite abierta durante una llamada HTTP.**
7. **Realtime es notificación, no única fuente de verdad.** Existe un cursor remoto monotónico por restaurante.
8. **Nunca confiar en `user_role`, `authorized_by` ni `device_id` recibidos del cliente sin validación JWT.**
9. **Una operación confirmada localmente nunca desaparece silenciosamente por un conflicto remoto.**

### 1.2 Componentes lógicos

```
┌─────────────────────────────────────────────────────────────────────────┐
│                   DISPOSITIVO LOCAL (Electron + Node)                   │
│                                                                         │
│  ┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐   │
│  │   Express       │    │   SQLite local   │    │  sync-engine    │   │
│  │   (routes)      │    │   (db.js)        │    │   (outbox)      │   │
│  └───────┬─────────┘    └────────┬─────────┘    └────────┬────────┘   │
│          │ Transacción atómica │                         │            │
│          │ (stock + movimientos│                         │            │
│          │  + outbox)          │                         │            │
│          ▼                     ▼                         ▼            │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │              Outbox de inventario (sync_queue)                │   │
│  │  operation_id | entity_type | entity_uuid | op_type | payload  │   │
│  │  idempotency_key | status | lease_owner | lease_expires_at    │   │
│  │  attempts | last_error | created_at | claimed_at | device_id   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│          │                                                              │
│          │ HTTP (anon key, JWT autenticado)                             │
│          ▼                                                              │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    SUPABASE (remoto)                            │   │
│  │                                                                   │   │
│  │  ┌────────────────────────────────────────────────────────────┐ │   │
│  │  │  RPC apply_inventory_operation (TX implícita PostgreSQL) │ │   │
│  │  │  - valida UUID e idempotency_key                         │ │   │
│  │  │  - compara contenido si ya existe                        │ │   │
│  │  │  - registra operación agrupada + movimientos hijos       │ │   │
│  │  │  - actualiza stock materializado (delta)                 │ │   │
│  │  │  - valida RLS y permisos de sesión JWT                   │ │   │
│  │  └────────────────────────────────────────────────────────────┘ │   │
│  │                                                                   │   │
│  │  Tabla restaurant_seq (cursor remoto monotónico)                │ │   │
│  │  Realtime (canal por restaurant_id) → notificación              │ │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│          │                                                              │
│          │ Evento remoto aplicado una sola vez (event_id)               │
│          ▼                                                              │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Aplicación local de evento remoto (applyRemoteRow)           │   │   │
│  │  - solo si event_id no existe localmente                      │   │   │
│  │  - stock materializado = stock local + delta remoto           │   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
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
| `version` | INTEGER NOT NULL DEFAULT 1 | Versión del registro para control de concurrencia optimista |
| `device_id` | TEXT | Dispositivo que originó el último cambio |
| `updated_at` | INTEGER | Timestamp local de última modificación |
| `deleted` | INTEGER DEFAULT 0 | Borrado lógico |

#### `stock_movements` (existente, se conserva y amplía)
| Columna | Tipo | Rol |
|---------|------|-----|
| `id` | INTEGER PK | Identificador local |
| `movement_uuid` | TEXT UNIQUE NOT NULL | UUID del movimiento individual (PK lógica remota) |
| `idempotency_key` | TEXT UNIQUE NOT NULL | Clave determinística para idempotencia |
| `inventory_uuid` | TEXT NOT NULL | UUID del producto (referencia estable) |
| `order_uuid` | TEXT | UUID del pedido relacionado (si aplica) |
| `operation_id` | TEXT NOT NULL | UUID de la operación de negocio padre |
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

#### `sync_queue` (outbox de inventario)
| Columna | Tipo | Rol |
|---------|------|-----|
| `id` | INTEGER PK | Identificador local de la cola |
| `operation_id` | TEXT UNIQUE NOT NULL | UUID de la operación de negocio padre |
| `entity_type` | TEXT NOT NULL | `inventory_operation`, `order`, `order_item` |
| `entity_uuid` | TEXT NOT NULL | UUID de la entidad afectada |
| `op_type` | TEXT NOT NULL | `sale`, `return`, `shortage`, `adjustment`, `create`, `update`, `delete` |
| `payload` | TEXT NOT NULL (JSON) | Datos completos de la operación agrupada |
| `idempotency_key` | TEXT UNIQUE NOT NULL | Clave determinística para idempotencia remota |
| `status` | TEXT NOT NULL DEFAULT 'pending' | `pending`, `claimed`, `synced`, `failed`, `dead`, `conflict` |
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
| `event_id` | TEXT UNIQUE NOT NULL | ID del evento remoto (UUID) |
| `operation_id` | TEXT | UUID de la operación aplicada |
| `entity_type` | TEXT | Tipo de entidad |
| `op_type` | TEXT | Tipo de operación |
| `applied_at` | INTEGER NOT NULL | Momento de aplicación local |

---

### 2.2 Tablas remotas (Supabase) — diseño lógico

#### `inventory_sync`
| Columna | Tipo | Rol |
|---------|------|-----|
| `uuid` | UUID PK | Identificador estable del producto |
| `restaurant_id` | UUID NOT NULL | Aislamiento de negocio |
| `stock` | REAL NOT NULL DEFAULT 0 | Stock materializado remoto |
| `version` | INTEGER NOT NULL DEFAULT 1 | Versión para control de concurrencia optimista |
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
| `entity_type` | TEXT NOT NULL | `order` o `inventory` |
| `entity_uuid` | UUID NOT NULL | UUID de la entidad principal |
| `op_type` | TEXT NOT NULL | Tipo de operación de negocio |
| `payload` | JSONB NOT NULL | Datos completos de la operación |
| `payload_hash` | TEXT NOT NULL | Hash SHA-256 del payload canónico |
| `status` | TEXT NOT NULL DEFAULT 'applied' | `applied`, `rejected`, `conflict` |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | Momento de aplicación remota |

#### `restaurant_seq` (cursor remoto monotónico por restaurante)
| Columna | Tipo | Rol |
|---------|------|-----|
| `restaurant_id` | UUID PK | Identificador del restaurante |
| `next_event_seq` | BIGINT NOT NULL DEFAULT 1 | Siguiente secuencia de evento a asignar |
| `updated_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | Última actualización del cursor |

#### `sync_events` (registro de eventos remotos)
| Columna | Tipo | Rol |
|---------|------|-----|
| `event_id` | UUID PK | Identificador estable del evento |
| `event_seq` | BIGINT NOT NULL | Secuencia secuencial por restaurante |
| `restaurant_id` | UUID NOT NULL | Restaurante |
| `operation_id` | UUID NOT NULL | Operación asociada |
| `entity_type` | TEXT NOT NULL | Tipo de entidad |
| `op_type` | TEXT NOT NULL | Tipo de operación |
| `commit_ts` | TIMESTAMPTZ NOT NULL DEFAULT now() | Momento de confirmación de transacción |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | Momento de inserción |

**Restricciones UNIQUE e índices remotos:**
- `stock_movements_sync.movement_uuid` → PK
- `stock_movements_sync.idempotency_key` → UNIQUE
- `inventory_operations.operation_id` → PK
- `inventory_operations.idempotency_key` → UNIQUE
- `restaurant_seq.restaurant_id` → PK
- `sync_events.event_id` → PK
- `sync_events.event_seq` → UNIQUE por `restaurant_id`
- `sync_events.operation_id` → INDEX

---

## 3. Contratos de operaciones y RPC

### 3.1 Identidades separadas (formal)

| Identidad | Propósito | Formato |
|-----------|-----------|---------|
| `operation_id` | UUID de la operación de negocio padre (agrupa movimientos hijos) | UUID v4 válido, sin prefijos |
| `movement_uuid` | UUID de un movimiento individual dentro de la operación | UUID v4 válido, sin prefijos |
| `order_uuid` | UUID del pedido relacionado | UUID v4 válido, sin prefijos |
| `inventory_uuid` | UUID del producto | UUID v4 válido, sin prefijos |
| `event_id` | UUID del evento remoto en el cursor | UUID v4 válido, sin prefijos |
| `idempotency_key` | Clave determinística derivada de `(operation_id, movement_uuid, tipo, qty)` | Texto, formato libre |

### 3.2 RPC: `apply_inventory_operation`

**Propósito:** Registrar una operación agrupada de inventario y actualizar stock en una única transacción PostgreSQL implícita.

**Nota crítica sobre transacciones en PostgreSQL:** Una función PL/pgSQL ejecutada como RPC se ejecuta dentro de una transacción implícita iniciada por el cliente. **NO usar `BEGIN`/`COMMIT` explícito** dentro de la función (provocaría error). La atomicidad está garantizada por el motor: si cualquier sentencia falla, toda la función revierte.

**Entrada (JSON):**

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `operation_id` | UUID | Sí | Identidad global de la operación padre |
| `idempotency_key` | TEXT | Sí | Clave determinística |
| `entity_type` | TEXT | Sí | `order` o `inventory` |
| `entity_uuid` | UUID | Sí | UUID de la entidad principal |
| `op_type` | TEXT | Sí | Tipo de operación de negocio |
| `movements` | JSONB [] | Sí | Array de movimientos hijos |
| `restaurant_id` | UUID | Sí | Validado contra JWT, no se confía en el payload |

Cada movimiento hijo contiene:
- `movement_uuid` UUID
- `inventory_uuid` UUID
- `order_uuid` UUID (opcional)
- `movement_type` TEXT (`sale`, `return`, `shortage`, `adjustment`)
- `quantity` REAL (positivo)
- `shortage_quantity` REAL (default 0)
- `reference_type` TEXT
- `reference_id` TEXT
- `user_name` TEXT
- `user_role` TEXT
- `authorized_by` TEXT (opcional)
- `device_id` TEXT
- `created_at` TIMESTAMPTZ

**Lógica del servidor (PL/pgSQL):**

```sql
-- 1. Idempotencia de operación padre: inserción atómica con ON CONFLICT
INSERT INTO inventory_operations (
  operation_id, idempotency_key, restaurant_id,
  entity_type, entity_uuid, op_type, payload, payload_hash, status
)
VALUES (
  p_operation_id, p_idempotency_key, p_restaurant_id,
  p_entity_type, p_entity_uuid, p_op_type, p_payload,
  sha256(canonical_json(p_payload))::text, 'applied'
)
ON CONFLICT (operation_id) DO
  -- Si ya existe, comparar contenido completo
  SELECT CASE
    WHEN inventory_operations.idempotency_key = EXCLUDED.idempotency_key
     AND inventory_operations.payload_hash = EXCLUDED.payload_hash
     AND inventory_operations.entity_type = EXCLUDED.entity_type
     AND inventory_operations.entity_uuid = EXCLUDED.entity_uuid
     AND inventory_operations.op_type = EXCLUDED.op_type
    THEN
      -- Mismo UUID y mismo payload: devolver resultado original sin aplicar
      (SELECT json_build_object('status','already_applied','operation_id',EXCLUDED.operation_id))
    ELSE
      -- Mismo UUID pero contenido diferente: rechazar
      RAISE EXCEPTION 'operation_id_reused_with_different_content'
  END;

-- 2. Validar restaurante desde JWT (no del payload)
--    p_restaurant_id se compara con auth.jwt() ->> 'restaurant_id'

-- 3. Registrar cada movimiento hijo y actualizar stock
FOREACH movement IN ARRAY p_movements LOOP
  -- 3a. Idempotencia del movimiento hijo
  INSERT INTO stock_movements_sync (
    movement_uuid, operation_id, idempotency_key, restaurant_id,
    inventory_uuid, order_uuid, movement_type, quantity, shortage_quantity,
    reference_type, reference_id, user_name, user_role, authorized_by,
    device_id, created_at
  ) VALUES (
    movement.movement_uuid, p_operation_id,
    movement.idempotency_key, p_restaurant_id,
    movement.inventory_uuid, movement.order_uuid,
    movement.movement_type, movement.quantity, movement.shortage_quantity,
    movement.reference_type, movement.reference_id, movement.user_name,
    movement.user_role, movement.authorized_by, movement.device_id,
    movement.created_at
  )
  ON CONFLICT (movement_uuid) DO
    -- Mismo movement_uuid: comparar contenido
    SELECT CASE
      WHEN stock_movements_sync.idempotency_key = EXCLUDED.idempotency_key
       AND stock_movements_sync.quantity = EXCLUDED.quantity
       AND stock_movements_sync.movement_type = EXCLUDED.movement_type
      THEN
        -- Mismo movimiento: no aplicar dos veces
        NULL
      ELSE
        -- Mismo movement_uuid con contenido diferente: rechazar
        RAISE EXCEPTION 'movement_uuid_reused_with_different_content'
    END;

  -- 3b. Validar tipo y cantidad comercial
  IF movement.movement_type NOT IN ('sale','return','shortage','adjustment') THEN
    RAISE EXCEPTION 'invalid_movement_type';
  END IF;
  IF movement.quantity <= 0 AND movement.movement_type <> 'adjustment' THEN
    RAISE EXCEPTION 'quantity_must_be_positive';
  END IF;

  -- 3c. Actualizar stock materializado por DELTA (nunca valor absoluto)
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

-- 4. Asignar secuencia de evento dentro de la misma transacción
--    Bloquear fila de control del restaurante para evitar carreras
UPDATE restaurant_seq
SET next_event_seq = next_event_seq + 1,
    updated_at = now()
WHERE restaurant_id = p_restaurant_id
RETURNING next_event_seq - 1 INTO v_event_seq;

-- 5. Registrar evento en cursor remoto
INSERT INTO sync_events (
  event_id, event_seq, restaurant_id,
  operation_id, entity_type, op_type, commit_ts
) VALUES (
  gen_random_uuid(), v_event_seq, p_restaurant_id,
  p_operation_id, p_entity_type, p_op_type, now()
);

RETURN json_build_object(
  'status', 'applied',
  'operation_id', p_operation_id,
  'event_seq', v_event_seq
);
```

**Excepciones definidas:**
- `operation_id_reused_with_different_content` → HTTP 409 Conflict
- `movement_uuid_reused_with_different_content` → HTTP 409 Conflict
- `inventory_not_found` → HTTP 404 Not Found
- `invalid_movement_type` → HTTP 400 Bad Request
- `quantity_must_be_positive` → HTTP 400 Bad Request
- Violación RLS / rol insuficiente → HTTP 403 Forbidden

**Seguridad de la RPC:**
- Ejecutada con `SECURITY INVOKER` (justificación en Sección 8).
- `restaurant_id` se obtiene de `auth.jwt() ->> 'restaurant_id'`, NUNCA del payload.
- `user_name`, `user_role` se obtienen del JWT.
- `authorized_by` solo se permite si el JWT tiene rol `owner` o `admin` en ese restaurante.
- `device_id` se valida contra dispositivos registrados del restaurante.

---

## 4. Idempotencia concurrente

### 4.1 Estrategia real para dos RPC simultáneas con el mismo `operation_id`

**Problema:** Dos solicitudes llegan al mismo tiempo con el mismo `operation_id` pero aún no existe ninguna fila. Un `SELECT FOR UPDATE` sobre una fila inexistente no bloquea nada.

**Solución:** Inserción atómica con `INSERT ... ON CONFLICT (operation_id)`. La restricción UNIQUE en `operation_id` garantiza que solo una transacción pueda insertar la fila. La segunda transacción que intente insertar el mismo `operation_id` entrará en la rama `ON CONFLICT`.

**Secuencia de carrera entre dos solicitudes idénticas:**

1. Transacción A: `INSERT INTO inventory_operations (operation_id='X', ...)` → adquiere lock en la página del índice UNIQUE.
2. Transacción B: `INSERT INTO inventory_operations (operation_id='X', ...)` → bloquea esperando a A.
3. Transacción A: confirma (COMMIT implícito al finalizar la función RPC).
4. Transacción B: despierta, detecta conflicto en `operation_id='X'`, ejecuta rama `ON CONFLICT`.
5. Transacción B: compara `idempotency_key` y `payload_hash`. Si son idénticos → devuelve `already_applied`. Si difieren → lanza excepción.

**Secuencia de carrera entre dos solicitudes diferentes (mismo UUID, payload distinto):**

1. Transacción A: inserta `operation_id='X'` con payload P1.
2. Transacción B: intenta insertar `operation_id='X'` con payload P2, bloquea.
3. Transacción A: confirma.
4. Transacción B: entra en `ON CONFLICT`, compara `idempotency_key` y `payload_hash`, detectan diferencia → lanza excepción `operation_id_reused_with_different_content`.

### 4.2 Comparación de payloads

- `payload_hash = SHA-256(canonical_json(payload))` donde `canonical_json` ordena claves alfabéticamente y elimina espacios en blanco.
- Comparación en `ON CONFLICT` usa `idempotency_key` + `payload_hash` + campos clave (`entity_type`, `entity_uuid`, `op_type`).

### 4.3 No aplicar dos veces los movimientos

- Cada `movement_uuid` tiene restricción UNIQUE en `stock_movements_sync`.
- `INSERT ... ON CONFLICT (movement_uuid)` compara `idempotency_key`, `quantity`, `movement_type`.
- Si coinciden → no aplicar (NULL). Si difieren → excepción.

---

## 5. Cursor remoto por restaurante

### 5.1 Diseño de fila de control

Tabla `restaurant_seq`:

| Columna | Tipo | Rol |
|---------|------|-----|
| `restaurant_id` | UUID PK | Identificador del restaurante |
| `next_event_seq` | BIGINT NOT NULL DEFAULT 1 | Siguiente secuencia de evento |
| `updated_at` | TIMESTAMPTZ NOT NULL | Última actualización |

### 5.2 Asignación de secuencia dentro de la transacción

La secuencia de evento se asigna **dentro de la misma transacción** que registra la operación y el evento:

1. `UPDATE restaurant_seq SET next_event_seq = next_event_seq + 1 WHERE restaurant_id = ? RETURNING next_event_seq - 1`
2. `INSERT INTO sync_events (event_id, event_seq, restaurant_id, operation_id, ...)`

Esto garantiza que:
- Dos transacciones concurrentes no obtienen el mismo `event_seq` (bloqueo de fila en `restaurant_seq`).
- El `event_seq` se confirma atómicamente con la operación (si la transacción revierte, la secuencia se libera).
- No hay huecos en el cursor por restaurante (cada `event_seq` se asigna una sola vez).

### 5.3 Comportamiento de transacciones concurrentes

| Paso | Transacción A | Transacción B |
|------|---------------|---------------|
| 1 | `UPDATE restaurant_seq` (bloquea fila restaurante R) | `UPDATE restaurant_seq` (bloqueada, espera) |
| 2 | Obtiene `event_seq = 5` | — |
| 3 | Inserta operación + evento con `seq=5` | — |
| 4 | COMMIT (libera lock) | — |
| 5 | — | Obtiene `event_seq = 6` |
| 6 | — | Inserta operación + evento con `seq=6` |
| 7 | — | COMMIT |

**Resultado:** `event_seq` 5 y 6 son consecutivos y sin huecos. No puede producirse un evento tardío con secuencia inferior al cursor ya confirmado porque la secuencia se asigna dentro de la transacción que confirma el evento.

### 5.4 Recuperación sin saltar eventos

- Cada dispositivo almacena `last_synced_seq` por restaurante.
- Solicita: `SELECT * FROM sync_events WHERE restaurant_id = ? AND event_seq > ? ORDER BY event_seq ASC`.
- Si falta un evento intermedio (por ejemplo, se recibió `seq=8` pero `last_synced_seq=5`), el dispositivo se detiene en `seq=6` y solicita recuperación desde el servidor.
- El cursor solo avanza después de confirmar la aplicación de la operación en SQLite local.

---

## 6. Reglas comerciales de inventario

### 6.1 Campos formales

| Campo | Significado |
|-------|-------------|
| `cantidad_solicitada` | Cantidad que el cliente quiere vender |
| `cantidad_efectivamente_descontada` | Cantidad realmente descontada del stock |
| `cantidad_faltante` | `cantidad_solicitada - cantidad_efectivamente_descontada` |
| `cantidad_vendida` | Sinónimo de `cantidad_efectivamente_descontada` para movimientos `sale` |

### 6.2 Reglas por escenario

| Escenario | Condición | `cantidad_efectivamente_descontada` | `cantidad_faltante` | Stock después |
|-----------|-----------|-------------------------------------|---------------------|---------------|
| Stock suficiente | `solicitada <= disponible` | `solicitada` | 0 | `disponible - solicitada` |
| Stock insuficiente sin auth | `solicitada > disponible` | `disponible` | `solicitada - disponible` | 0 |
| Stock insuficiente con auth admin | `solicitada > disponible` | `solicitada` | 0 | `disponible - solicitada` (puede ser negativo) |

### 6.3 Pseudocódigo de la lógica de stock (servidor)

```
FUNCTION calcular_descuento(producto, cantidad_solicitada, autorizado_admin):
  disponible = producto.stock
  
  si cantidad_solicitada <= disponible:
    cantidad_descontada = cantidad_solicitada
    cantidad_faltante = 0
  sino si autorizado_admin:
    cantidad_descontada = cantidad_solicitada
    cantidad_faltante = 0
  sino:
    cantidad_descontada = disponible
    cantidad_faltante = cantidad_solicitada - disponible
  
  retorno {
    cantidad_descontada,
    cantidad_faltante,
    stock_nuevo = disponible - cantidad_descontada
  }
```

### 6.4 Ejemplos numéricos

**Ejemplo 1: Stock suficiente**
- Stock inicial: 10
- Venta: 3 unidades, sin auth
- `cantidad_descontada = 3`, `cantidad_faltante = 0`
- Stock final: 7

**Ejemplo 2: Stock insuficiente sin autorización**
- Stock inicial: 5
- Venta: 8 unidades, sin auth
- `cantidad_descontada = 5`, `cantidad_faltante = 3`
- Stock final: 0
- Movimientos: `sale` qty=5, `shortage` qty=3

**Ejemplo 3: Stock insuficiente con autorización admin**
- Stock inicial: 5
- Venta: 8 unidades, con auth admin
- `cantidad_descontada = 8`, `cantidad_faltante = 0`
- Stock final: -3
- Movimiento: `sale` qty=8

### 6.5 Dos ventas offline concurrentes desde la misma copia de stock

Dispositivo A y B tienen stock local 10. Ambos venden sin auth:
- A vende 3 → stock local A = 7, `sale` qty=3
- B vende 4 → stock local B = 6, `sale` qty=4
- A sincroniza: servidor aplica delta -3, stock remoto = 7
- B sincroniza: servidor aplica delta -4, stock remoto = 3
- **Resultado:** stock remoto = 3 (correcto: 10 - 3 - 4)

El servidor serializa las operaciones que modifican el mismo producto y aplica la regla comercial sobre el saldo remoto actual en cada transacción.

---

## 7. Pedidos y conflictos offline

### 7.1 Estados explícitos de operación

| Estado | Significado |
|--------|-------------|
| `pendiente` | Operación creada localmente, no enviada al servidor |
| `aplicada` | Operación confirmada por el servidor (UUID existe en `inventory_operations`) |
| `rechazada` | Servidor rechazó la operación (conflicto de versión, UUID reutilizado, producto inexistente) |
| `en_conflicto` | Operación local no puede aplicarse porque el estado remoto es incompatible (versión de pedido desactualizada) |

### 7.2 Escenarios de conflictos

| Escenario | Resolución |
|-----------|------------|
| Venta offline llega después de una cancelación | El servidor rechaza la venta: `order_status = 'cancelled'`, versión no coincide. Operación pasa a `en_conflicto`. |
| Cancelación llega después de una venta | Cancelación aplica `return` qty = `SUM(sale) - SUM(return)` efectivo. Stock vuelve al valor previo a la venta. |
| Devolución llega antes que su venta original | Servidor rechaza: `return_exceeds_sale` (no hay venta original a la que referenciar). |
| Dos dispositivos modifican simultáneamente el mismo pedido | Solo una se aplica (primera en confirmar). La otra recibe `CONFLICT_ORDER_VERSION` y pasa a `en_conflicto`. |
| Operación local confirmada es rechazada por versión | Operación pasa a `en_conflicto`. El cliente debe refrescar, regenerar y reenviar. |
| Reapertura llega después de una cancelación | Reapertura aplica `sale` qty = `SUM(sale)` reconstruido (respetando reglas de auth). |
| Dos operaciones agrupadas afectan distintos productos del mismo pedido | Ambas se aplican si son para productos distintos (no hay conflicto de stock entre productos diferentes). |

### 7.3 Devoluciones y referencias

- Un `return` debe referenciar una `sale` original del mismo `order_uuid` + `inventory_uuid`.
- `return.quantity` no puede exceder `SUM(sale.quantity) - SUM(return.quantity)` previas para esa orden+producto.
- Si se intenta devolver más de lo efectivamente descontado y no devuelto, el servidor rechaza con `return_exceeds_sale_available`.

### 7.4 Mecanismo de resolución

**Automática:**
- Si el conflicto es por versión de pedido, el cliente recibe el estado actual del pedido y puede regenerar la operación.

**Manual:**
- Operaciones en `en_conflicto` se muestran en el dashboard de sincronización.
- Un administrador puede: descartar la operación, forzar la aplicación, o crear un `adjustment` para reconciliar el stock.

**Regla de oro:** Una operación confirmada localmente nunca desaparece silenciosamente. Siempre se notifica al cliente del resultado (aplicada, rechazada o en_conflicto).

---

## 8. Contrato de eventos remotos

### 8.1 Estructura del evento

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `event_id` | UUID PK | Identificador estable del evento |
| `event_seq` | BIGINT | Secuencia secuencial por restaurante |
| `restaurant_id` | UUID | Restaurante |
| `operation_id` | UUID | Operación asociada |
| `entity_type` | TEXT | Tipo de entidad |
| `op_type` | TEXT | Tipo de operación |
| `commit_ts` | TIMESTAMPTZ | Fecha de confirmación remota |

### 8.2 Endpoint/RPC de lectura de eventos

**RPC:** `get_sync_events(p_restaurant_id UUID, p_from_seq BIGINT, p_limit INT)`

**Respuesta:**
```json
{
  "events": [
    {
      "event_id": "uuid",
      "event_seq": 42,
      "restaurant_id": "uuid",
      "operation_id": "uuid",
      "entity_type": "order",
      "op_type": "sale",
      "commit_ts": "2026-11-20T10:00:00Z"
    }
  ],
  "next_seq": 43,
  "has_more": true
}
```

### 8.3 Aplicación transaccional en SQLite

Cada operación remota completa se aplica localmente en una transacción SQLite:

```sql
BEGIN TRANSACTION;
  -- Verificar si el evento ya fue aplicado
  SELECT 1 FROM sync_events_local WHERE event_id = ?;
  
  -- Si no existe, aplicar movimientos hijos y actualizar stock
  INSERT INTO sync_events_local (event_seq, event_id, operation_id, entity_type, op_type, applied_at)
  VALUES (?, ?, ?, ?, ?, ?);
  
  -- Aplicar cada movimiento: stock = stock + delta
  UPDATE inventory SET stock = COALESCE(stock,0) + delta, version = version + 1 WHERE uuid = ?;
COMMIT;
```

### 8.4 Recuperación ante fallos

| Situación | Acción |
|-----------|--------|
| Caída de Electron | `sync_events_local` persiste; al reiniciar se reanuda desde `last_synced_seq` |
| Error al aplicar un movimiento hijo | Transacción SQLite se revierte; evento no se marca como aplicado; `last_synced_seq` no avanza |
| Realtime desconectado | Dispositivo hace polling del cursor `sync_events` cada intervalo configurable |
| Evento duplicado | `event_id` ya existe en `sync_events_local` → ignorar |
| Evento recibido fuera de orden | Dispositivo se detiene en el `event_seq` faltante y solicita recuperación |
| Evento propio | `device_id` del evento === `DEVICE_ID` local → ignorar (eco) |
| Evento que referencia producto inexistente localmente | Evento se coloca en cola de espera; se aplica cuando el producto se sincronice |

**Regla:** El cursor local solo avanza después de confirmar la aplicación de la operación en SQLite.

---

## 9. Seguridad Supabase

### 8.1 Elección: `SECURITY INVOKER`

**Decisión:** `SECURITY INVOKER` para la RPC `apply_inventory_operation`.

**Justificación:**
- La RPC se ejecuta con los privilegios del usuario autenticado (JWT).
- RLS se evalúa con el contexto del usuario real, no de un superusuario.
- Evita escalada de privilegios: un usuario comprometido solo puede hacer lo que su rol permite.
- `SECURITY DEFINER` requeriría proteger `search_path` meticulosamente y sería más propenso a errores de configuración.

### 8.2 Políticas RLS completas

| Tabla | Política SELECT | Política INSERT | Política UPDATE | Política DELETE |
|-------|-----------------|-----------------|-----------------|-----------------|
| `inventory_sync` | `restaurant_id = auth.jwt() ->> 'restaurant_id'` | Denegada (solo RPC) | Denegada (solo RPC) | Denegada |
| `stock_movements_sync` | `restaurant_id = auth.jwt() ->> 'restaurant_id'` | Denegada (solo RPC) | Denegada (solo RPC) | Denegada |
| `inventory_operations` | `restaurant_id = auth.jwt() ->> 'restaurant_id'` | Denegada (solo RPC) | Denegada (solo RPC) | Denegada |
| `sync_events` | `restaurant_id = auth.jwt() ->> 'restaurant_id'` | Denegada (solo RPC) | Denegada | Denegada |
| `restaurant_seq` | `restaurant_id = auth.jwt() ->> 'restaurant_id'` | Denegada | Denegada | Denegada |

### 8.3 Grants

| Objeto | Rol | Permisos |
|--------|-----|----------|
| `inventory_sync` | `authenticated` | Ninguno directo (solo vía RPC) |
| `stock_movements_sync` | `authenticated` | Ninguno directo (solo vía RPC) |
| `inventory_operations` | `authenticated` | Ninguno directo (solo vía RPC) |
| `sync_events` | `authenticated` | Ninguno directo (solo vía RPC) |
| `restaurant_seq` | `authenticated` | Ninguno directo (solo vía RPC) |
| Función `apply_inventory_operation` | `authenticated` | `EXECUTE` |
| Función `get_sync_events` | `authenticated` | `EXECUTE` |

### 8.4 Validaciones

| Elemento | Origen | Validación |
|----------|--------|------------|
| `restaurant_id` | JWT claim | Debe coincidir con el restaurante del dispositivo registrado |
| `user_name` | JWT claim | No se acepta del payload |
| `user_role` | JWT claim | No se acepta del payload |
| `authorized_by` | JWT claim | Solo si rol es `owner` o `admin` |
| `device_id` | Payload | Debe estar en tabla `devices` del restaurante (registro explícito, no implícito) |
| `service_role` | — | Prohibida en Electron y renderer |

### 8.5 Revocación de dispositivos

- Tabla `devices` con columnas: `device_id` UUID PK, `restaurant_id` UUID, `activo` BOOLEAN, `revocado_en` TIMESTAMPTZ.
- La RPC verifica que el `device_id` exista y esté activo para el `restaurant_id` de la sesión.
- Revocación: actualizar `activo = FALSE` y `revocado_en = now()`. Las operaciones subsiguientes del dispositivo son rechazadas.

### 8.6 Protección contra falsificación

- `restaurant_id` del payload se ignora; se usa el del JWT.
- `user_role` del payload se ignora; se usa el del JWT.
- `authorized_by` del payload solo se acepta si coincide con el usuario del JWT y tiene rol admin.
- `device_id` del payload se valida contra la tabla `devices`.

### 8.7 Pruebas de aislamiento necesarias

| Prueba | Resultado esperado |
|--------|-------------------|
| Usuario de restaurante A lee movimientos de restaurante B | 0 filas o error RLS |
| Dispositivo revocado envía operación | HTTP 403 |
| Usuario sin rol admin envía `adjustment` | HTTP 403 |
| Payload con `authorized_by` falsificado | Se ignora; se usa el del JWT |
| Cliente sin `service_role` intenta acceso directo | Denegado por RLS |

---

## 9. Migración y bootstrap

### 9.1 Procedimiento de bootstrap centralizado

1. **Detención de sincronizadores:** Todos los dispositivos deben detener `flushQueue` y Realtime antes de iniciar.
2. **Bloqueo temporal de escrituras incompatibles:** Se deshabilita la escritura de stock absoluto desde clientes antiguos.
3. **Selección de saldo inicial canónico:** Se elige un dispositivo de referencia (o el servidor) como fuente del saldo canónico para cada producto.
4. **Conciliación de diferencias:** Si dos dispositivos tienen stock diferente para el mismo producto, se registra un `adjustment` central con autorización admin para llevar todos al saldo canónico.
5. **Registro de ajustes auditables:** Cada ajuste se registra como movimiento `adjustment` con `user_name` y `user_role` del administrador.
6. **Migración de productos y UUID:** Los productos existentes reciben `uuid` si no tienen (backfill). Se añade columna `version` (INTEGER DEFAULT 1).
7. **Tratamiento de movimientos históricos:** Los `stock_movements` locales existentes se conservan como trazabilidad local, pero **no se suben automáticamente** a Supabase.
8. **Tratamiento de colas antiguas:** Las entradas existentes en `sync_queue` se clasifican:
   - Compatibles con el nuevo esquema → se reintentan con el RPC idempotente.
   - Incompatibles (stock absoluto) → se ponen en cuarentena para revisión manual.
9. **Bloqueo de clientes antiguos:** Clientes que envíen `stock = valor absoluto` son bloqueados o puestos en modo solo lectura.
10. **Verificación de integridad:** `checkIntegrity` compara conteos local vs remoto por restaurante antes de reactivar cada dispositivo.
11. **Reanudación controlada:** Se reactiva la sincronización dispositivo por dispositivo.

### 9.2 Reglas de migración

- **No generar movimientos históricos inventados.** La trazabilidad remota comienza desde la activación.
- **No reenviar automáticamente colas antiguas incompatibles.** Se clasifican y ponen en cuarentena.
- **La conciliación produce una única operación central autorizada**, no un ajuste independiente por cada dispositivo.

---

## 9. Modelo de identificadores

| Identidad | Propósito | Formato | Tabla PK |
|-----------|-----------|---------|----------|
| `operation_id` | UUID de la operación de negocio padre | UUID v4 válido, sin prefijos | `inventory_operations.operation_id` |
| `movement_uuid` | UUID de un movimiento individual | UUID v4 válido, sin prefijos | `stock_movements_sync.movement_uuid` |
| `inventory_uuid` | UUID del producto | UUID v4 válido, sin prefijos | `inventory_sync.uuid` |
| `order_uuid` | UUID del pedido relacionado | UUID v4 válido, sin prefijos | (referencia en `stock_movements_sync`) |
| `event_id` | UUID del evento remoto | UUID v4 válido, sin prefijos | `sync_events.event_id` |
| `idempotency_key` | Clave determinística | Texto derivado de `(operation_id, movement_uuid, tipo, qty)` | `inventory_operations.idempotency_key` (UNIQUE), `stock_movements_sync.idempotency_key` (UNIQUE) |

**Reglas:**
- Todos los UUID son UUID válidos RFC 4122, sin prefijos como `op-` o `mov-`.
- No se usan IDs enteros locales en claves globales.
- `movement_uuid` es la PK lógica de cada movimiento remoto; no se duplica con `uuid` de tabla local.
- `inventory_id` (entero local) se conserva en SQLite para operaciones locales, pero no se envía a Supabase; se usa `inventory_uuid` en el lado remoto.
- `reference_id` (texto en `stock_movements_sync`) almacena IDs de referencia como UUIDs cuando corresponden.

**Migración de registros existentes:**
- Productos sin `uuid`: se les genera uno mediante backfill.
- `stock_movements` existentes: se les asigna `movement_uuid` y `idempotency_key` si faltan, pero no se suben automáticamente.

---

## 10. Outbox

### 10.1 Reclamo atómico

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

- Se verifica `changes = 1` para confirmar que solo un proceso reclamó la operación.
- **Nunca** se mantiene una transacción SQLite abierta durante una llamada HTTP. El lease se establece, se hace COMMIT, luego se hace la llamada HTTP, y finalmente se actualiza el estado en una transacción separada.

### 10.2 Procesamiento por lotes

- `flushQueue` lee hasta 200 operaciones `pending` ordenadas por `created_at`.
- Agrupa por `restaurant_id` y `entity_type`.
- Deduplica por `operation_id` (queda el estado más reciente).
- Envía cada operación agrupada como una sola llamada RPC.

### 10.3 Lease y expiración

| Campo | Propósito |
|-------|-----------|
| `lease_owner` | `device_id:pid` del proceso que reclamó |
| `lease_expires_at` | `ahora + 120000 ms` (2 minutos) |
| `claimed_at` | Momento de última reclamación |

### 10.4 Recuperación tras caída

- Al iniciar, se escanean operaciones en `claimed` con `lease_expires_at < ahora` y se vuelven a `pending`.
- Operaciones en `synced` no se reenvían (idempotencia del servidor).

### 10.5 Backoff

| Intento | Retraso |
|---------|---------|
| 1 | inmediato |
| 2 | 5s |
| 3 | 15s |
| 4 | 60s |
| 5+ | 300s |

Tras 7 intentos, la operación pasa a `dead`.

### 10.6 Errores

| Tipo | Ejemplo | Acción |
|------|---------|--------|
| Transitorio | Timeout, 503, 504 | Reintentar con backoff; `status = failed` tras agotar intentos |
| Permanente | 400, 403, 404, UUID reutilizado con contenido diferente | `dead` inmediatamente, sin reintentar |

### 10.7 Dependencias entre operaciones

- Operaciones de un mismo pedido comparten `order_uuid` en el payload.
- El cliente debe esperar a que una `sale` esté `synced` antes de enviar la `return` que depende de ella.
- El servidor aplica cada operación agrupada como unidad atómica.

### 10.8 Estados de conflicto

- `conflict`: Operación que no pudo aplicarse por conflicto de versión. Requiere resolución manual.
- `dead`: Operación que falló permanentemente tras agotar reintentos.

### 10.9 Retención y auditoría

- Operaciones `synced`: conservar mínimo 30 días.
- Operaciones `dead` y `conflict`: conservar indefinidamente para revisión manual.

---

## 11. Eventos remotos y recuperación local

### 11.1 Reglas de aplicación

Cuando llega un evento remoto:

1. **No duplicar movimientos:** Verificar si `movement_uuid` (o `event_id`) ya existe localmente. Si existe, ignorar.
2. **No reaplicar operaciones propias:** Si `device_id` del evento === `DEVICE_ID` local, ignorar (eco).
3. **No sobrescribir operaciones locales pendientes:** Los eventos remotos se aplican como deltas sobre el stock materializado actual.
4. **No perder eventos por cursor adelantado:** Aplicar en orden de `event_seq` desde `last_synced_seq`.
5. **No aplicar devoluciones antes de ventas:** El servidor garantiza el orden causal.
6. **No corromper stock materializado:** `stock = stock + delta_remoto`, nunca `stock = valor_remoto`.

### 11.2 Recuperación sin Realtime

Si Realtime no está disponible, polling del cursor `sync_events` cada intervalo configurable, aplicando eventos con `event_seq > last_synced_seq`.

### 11.3 Cursor local

- `last_synced_seq` por restaurante en tabla local o metadata.
- Solo avanza después de confirmar la aplicación completa en SQLite.
- Si falla la aplicación de un evento, el cursor no avanza y se reintenta.

---

## 12. Plan de pruebas ampliado

Todas las pruebas usan **dos bases SQLite independientes** y un **entorno Supabase de pruebas**. Nunca producción.

| # | Prueba | Datos iniciales | Pasos | Resultado esperado | Criterio cuantificable |
|---|--------|----------------|-------|-------------------|----------------------|
| 1 | Dos SQLite independientes | A: stock 10. B: stock 10. | A vende 3, B vende 4 (offline). Sincronizan. | Stock remoto = 3. Dos `sale` con UUID distintos. | `stock` = 3; `COUNT(movement_type='sale')` = 2 |
| 2 | Dos procesos Node simultáneos | `sync_queue` con operaciones pendientes. | Dos procesos leen la cola al mismo tiempo. | Cada operación procesada exactamente una vez. | `changes=1` en reclamo; sin duplicados en `synced` |
| 3 | Dos solicitudes RPC concurrentes mismo UUID | Operación `sale` UUID-X. | Dos solicitudes RPC simultáneas, mismo UUID, payload idéntico. | Aplicada una sola vez. | `COUNT(movement_uuid=?)` = 1 |
| 4 | Mismo UUID contenido diferente | Operación `sale` UUID-X qty=3. | Segunda solicitud mismo UUID qty=5. | Servidor rechaza. | Error `operation_id_reused_with_different_content` |
| 5 | Mismo movement_uuid contenido diferente | Movimiento UUID-M qty=3. | Segunda solicitud mismo UUID qty=5. | Servidor rechaza. | Error `movement_uuid_reused_with_different_content` |
| 6 | Confirmación perdida | Cliente envía, servidor aplica, respuesta se pierde. | Cliente reenvía misma operación. | No hay duplicación. | `COUNT(movement_uuid=?)` = 1 |
| 7 | Caída durante transacción | Cliente envía, proceso muere antes de respuesta. | Operación queda en `claimed`. | Al reiniciar, lease expira y se recupera a `pending`. | `status` pasa `claimed` → `pending` |
| 8 | Cursor con commits fuera de orden | Dos transacciones concurrentes en servidor. | Evento lento confirma después de evento rápido. | `event_seq` refleja orden de publicación. | Sin huecos en `event_seq` aplicados localmente |
| 9 | Dos restaurantes diferentes | Restaurante A y B con productos distintos. | Usuario de A intenta acceder a movimientos de B. | Acceso denegado por RLS. | 0 filas o error 403 |
| 10 | Venta y cancelación concurrentes | Orden activa, stock 10. | A vende 3, B cancela. | Stock remoto = 10. Cancelación registrada. | `stock` = 10; `return` qty=3 |
| 11 | Cancelación antes de venta | Orden cancelada. | Intentar vender sobre orden cancelada. | Venta rechazada. | `order_status='cancelled`; operación en `en_conflicto` |
| 12 | Modificaciones simultáneas | Pedido qty=3, versión v1. | A modifica a 5 (espera v1), B modifica a 4 (espera v1). | Una se aplica; otra recibe `CONFLICT_ORDER_VERSION`. | Una `synced`; otra `en_conflicto` |
| 13 | Reaperturas | Orden cancelada. | Reabrir dos veces. | Segunda es no-op. | Solo un `sale` de re-discount |
| 14 | Dos cancelaciones | Orden activa con venta. | Cancelar dos veces. | Segunda es no-op. | Solo un `return` |
| 15 | Stock insuficiente concurrente | Stock 5 en ambos dispositivos. | A vende 8 (sin auth), B vende 8 (sin auth). | Stock remoto = 0. Dos `shortage` de 3. | `stock` = 0; suma `shortage_quantity` = 6 |
| 16 | Stock insuficiente sin auth | Stock 5. | Vender 8 sin auth. | Stock = 0, `shortage` = 3. | `stock` = 0; `shortage_quantity` = 3 |
| 17 | Stock negativo autorizado | Stock 5, admin auth. | Vender 8. | Stock remoto = -3. | `stock` = -3; `sale.quantity` = 8 |
| 18 | Ajustes | Stock 10. | Admin hace ajuste +5. | Stock remoto = 15. | `stock` = 15; movimiento `adjustment` |
| 19 | Realtime desconectado | Operaciones pendientes. | Desconectar Realtime, hacer polling del cursor. | Eventos aplicados al recuperar. | `last_synced_seq` avanza |
| 20 | Recuperación del cursor | `last_synced_seq=5`, evento `seq=8` llega primero. | Dispositivo se detiene en `seq=6`. | Solicita recuperación de `seq=6,7`. | No se aplica `seq=8` antes de `6,7` |
| 21 | Aplicación local parcial fallida | Evento con 2 movimientos hijos. | Error al aplicar el segundo hijo. | Transacción SQLite se revierte. | Ningún movimiento aplicado; `last_synced_seq` no avanza |
| 22 | Dispositivo revocado | Dispositivo D revocado. | D intenta enviar operación. | HTTP 403. | Operación no aplicada |
| 23 | Migración de colas antiguas | Cola con operación stock absoluto. | Ejecutar bootstrap. | Operación en cuarentena. | `status='dead'` o `conflict` para operaciones incompatibles |
| 24 | Reconciliación del saldo inicial | Dos dispositivos con stock diferente para mismo producto. | Bootstrap centralizado. | Un solo `adjustment` central. | Un `adjustment` con autorización admin |

---

## 13. Riesgos residuales

| Riesgo | Descripción | Mitigación |
|--------|-------------|------------|
| Relojes locales no sincronizados | `created_at` local no es autoridad para orden remoto. | Usar `event_seq` del servidor como cursor monotónico. |
| Dos procesos Node sobre misma SQLite | No es el caso actual (Electron monoplanta). | Lease con `lease_owner` y `lease_expires_at`; reclamo atómico. |
| RPC de Supabase caída | Operaciones en `failed`/`claimed`. | Backoff exponencial, recuperación de lease, reintento manual. |
| Clientes antiguos con valor absoluto | Pueden sobrescribir stock. | Bloqueo de clientes antiguos, modo solo lectura hasta actualizar. |
| Stock negativo acumulado | Ventas offline concurrentes dejan stock negativo. | Aceptado como estado válido; reconciliación mediante `adjustment` con auth admin. |
| Movimientos históricos no subidos | Trazabilidad solo desde activación. | Documentar límite explícito; no inventar datos pasados. |
| Token comprometido | Permite operaciones hasta su expiración. | Expiración corta de JWT, revocación de dispositivos. |

---

## 14. Criterios objetivos de aceptación

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
11. **Cursor remoto monotónico** por restaurante con fila de control y bloqueo transaccional.
12. **Todas las 24 pruebas del plan de pruebas pasan** en entorno aislado.

---

**Fase 2B.5.1 (V4) completada. Arquitectura lista para revisión final. Detenido a la espera de autorización explícita para pasar a implementación.**