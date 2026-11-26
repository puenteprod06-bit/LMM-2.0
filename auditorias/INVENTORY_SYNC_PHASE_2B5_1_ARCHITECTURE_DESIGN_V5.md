# INVENTORY_SYNC_PHASE_2B5_1_ARCHITECTURE_DESIGN_V5.md

## Fase 2B.5.1 — Diseño de Arquitectura de Sincronización de Inventario (Versión 5 — Corrección Definitiva)

**Proyecto:** La Mente Maestra 3.0 (POS)  
**Archivo de origen:** `INVENTORY_SYNC_PHASE_2B5_1_ARCHITECTURE_DESIGN_V4.md`  
**Fecha:** 20/11/2026  
**Modalidad:** SOLO ANÁLISIS Y DOCUMENTACIÓN — PROHIBIDO IMPLEMENTAR  
**Estado:** PROPUESTA V5 LISTA PARA REVISIÓN  

---

## 1. Resumen ejecutivo

La V4 contenía errores críticos que impiden su implementación directa:

1. **Pseudocódigo PL/pgSQL inválido:** `ON CONFLICT` se usó dentro de una construcción `SELECT CASE`, lo cual no es sintaxis válida de PostgreSQL.
2. **Reglas de stock ambiguas:** `quantity` se usaba indistintamente como cantidad solicitada, cantidad descontada y delta de stock, sin distinguir `requested_quantity`, `stock_decrement_quantity`, `shortage_quantity` y `stock_delta`.
3. **Contradicción de seguridad:** Se declaró `SECURITY INVOKER` pero se denegaron permisos directos de escritura a `authenticated`, lo cual genera una contradicción sin resolver.
4. **Modelo de pedidos incompleto:** No se definieron `order_uuid`, `expected_order_version`, `current_order_version`, estado remoto ni relaciones con movimientos.
5. **Contrato de eventos incompleto:** No se definió el evento propio ni el comportamiento del cursor al recibir un evento propio.
6. **Ajustes sin signo:** La cantidad se asumió siempre positiva, impidiendo ajustes negativos sin ambigüedad.
7. **Pruebas con números incorrectos:** El escenario de dos dispositivos con stock 5 vendiendo 8 cada uno sin auth se resolvió incorrectamente como "dos faltantes de 3", ignorando que el servidor serializa sobre el saldo central.

La V5 corrige todos estos puntos con pseudocódigo PostgreSQL válido, reglas de stock separadas, elección explícita de modelo de seguridad, modelo de pedidos completo, contrato de eventos completo, 26 pruebas corregidas y matriz de trazabilidad completa.

---

## 2. Matriz V4 → V5

| ID | Problema en V4 | Severidad | Corrección en V5 | Sección |
|----|----------------|-----------|------------------|---------|
| V4-1 | `ON CONFLICT` en `SELECT CASE` es sintaxis inválida | CRÍTICO | RPC reescrita con `INSERT ... ON CONFLICT` para operación padre y `INSERT ... ON CONFLICT` para movimientos hijos, bloques `IF` separados | 7 |
| V4-2 | `quantity` ambiguo (solicitada/descontada/delta) | CRÍTICO | Campos separados: `requested_quantity`, `stock_decrement_quantity`, `shortage_quantity`, `stock_delta` | 9 |
| V4-3 | `SECURITY INVOKER` vs denegación de permisos a `authenticated` | CRÍTICO | Elección explícita `SECURITY DEFINER` con `search_path` fijo, validaciones explícitas, privilegios mínimos | 12 |
| V4-4 | Modelo de pedidos incompleto (sin `order_uuid`, versiones, estado remoto) | ALTO | Entidades `orders_sync`, `order_items_sync`, `order_operations_sync` con versiones y relaciones | 5 |
| V4-5 | Contrato de eventos incompleto (sin evento propio, sin cursor correcto) | ALTO | Contrato completo con `event_id`, `event_seq`, `event_type`, `payload`, `applied_locally`, propio vs ajeno | 11 |
| V4-6 | Ajustes siempre positivos, sin representación negativa | MEDIO | `stock_delta` con signo, `adjustment_type` (`positive`, `negative`) | 9 |
| V4-7 | Escenario de dos dispositivos stock 5 vendiendo 8: dos faltantes de 3 (incorrecto) | ALTO | Servidor serializa sobre saldo central: primero descuenta 5 (stock 0, shortage 3), segundo descuenta 0 (stock 0, shortage 8) | 9, prueba 15 |
| V4-8 | Pruebas con números incorrectos y criterios faltantes | ALTO | 26 pruebas reescritas con datos iniciales, pasos, resultado esperado y criterio cuantificable | 15 |

---

## 3. Arquitectura general

### 3.1 Principios rectores

1. **SQLite local es el almacenamiento operativo.** El POS funciona totalmente sin conexión.
2. **Cada operación de negocio tiene identidad global única (UUID).** No se usan IDs enteros locales como identificadores globales.
3. **`stock_movements` es la fuente de trazabilidad.** El stock materializado es un derivado.
4. **Los movimientos se sincronizan como operaciones agrupadas.** Nunca se sincroniza stock como valor absoluto.
5. **Idempotencia en servidor.** Una operación con el mismo UUID y contenido se aplica una sola vez.
6. **No se mantiene una transacción SQLite abierta durante una llamada HTTP.**
7. **Realtime es notificación, no única fuente de verdad.** Existe un cursor remoto monotónico por restaurante.
8. **Nunca confiar en `user_role`, `authorized_by` ni `device_id` recibidos del cliente sin validación JWT.**
9. **Una operación confirmada localmente nunca desaparece silenciosamente por un conflicto remoto.**

### 3.2 Componentes lógicos

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
│  │  │  RPC apply_inventory_operation (TX PostgreSQL implícita) │ │   │
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
│  │  - evento propio: confirmar y avanzar cursor sin duplicar     │   │   │
│  │  - stock materializado = stock local + delta remoto           │   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Modelo SQLite local

### 4.1 `inventory` (existente, se conserva y amplía)

| Columna | Tipo | Rol |
|---------|------|-----|
| `id` | INTEGER PK | Identificador local operativo (NUNCA se envía como global) |
| `uuid` | TEXT UNIQUE NOT NULL | Identificador estable global del producto |
| `stock` | REAL | Stock materializado local (derivado) |
| `version` | INTEGER NOT NULL DEFAULT 1 | Versión para control de concurrencia optimista |
| `device_id` | TEXT | Dispositivo que originó el último cambio |
| `updated_at` | INTEGER | Timestamp local de última modificación |
| `deleted` | INTEGER DEFAULT 0 | Borrado lógico |

### 4.2 `stock_movements` (existente, se conserva y amplía)

| Columna | Tipo | Rol |
|---------|------|-----|
| `id` | INTEGER PK | Identificador local |
| `movement_uuid` | TEXT UNIQUE NOT NULL | UUID del movimiento individual (PK lógica remota) |
| `idempotency_key` | TEXT UNIQUE NOT NULL | Clave determinística para idempotencia |
| `inventory_uuid` | TEXT NOT NULL | UUID del producto (referencia estable) |
| `order_uuid` | TEXT | UUID del pedido relacionado |
| `operation_id` | TEXT NOT NULL | UUID de la operación de negocio padre |
| `movement_type` | TEXT NOT NULL | `sale`, `return`, `shortage`, `adjustment` |
| `requested_quantity` | REAL | Cantidad solicitada en el pedido |
| `stock_decrement_quantity` | REAL | Cantidad efectivamente descontada del stock |
| `shortage_quantity` | REAL DEFAULT 0 | Cantidad de faltante |
| `stock_delta` | REAL | Variación efectiva del stock (positiva o negativa) |
| `stock_before` | REAL | Stock materializado local antes (solo referencia) |
| `stock_after` | REAL | Stock materializado local después (solo referencia) |
| `reference_type` | TEXT | `order`, `decrement`, `adjustment` |
| `reference_id` | TEXT | ID de referencia |
| `authorized_by` | TEXT | Usuario que autorizó |
| `user_name` | TEXT | Usuario responsable |
| `user_role` | TEXT | Rol del usuario responsable |
| `device_id` | TEXT | Dispositivo origen |
| `created_at` | INTEGER NOT NULL | Timestamp de creación local |
| `synced_at` | INTEGER | Timestamp de confirmación remota |
| `deleted` | INTEGER DEFAULT 0 | Borrado lógico |

### 4.3 `sync_queue` (outbox de inventario)

| Columna | Tipo | Rol |
|---------|------|-----|
| `id` | INTEGER PK | Identificador local de la cola |
| `operation_id` | TEXT UNIQUE NOT NULL | UUID de la operación de negocio padre |
| `entity_type` | TEXT NOT NULL | `inventory_operation`, `order`, `order_item` |
| `entity_uuid` | TEXT NOT NULL | UUID de la entidad afectada |
| `op_type` | TEXT NOT NULL | Tipo de operación |
| `payload` | TEXT NOT NULL (JSON) | Datos completos de la operación agrupada |
| `idempotency_key` | TEXT UNIQUE NOT NULL | Clave determinística |
| `status` | TEXT NOT NULL DEFAULT 'pending' | `pending`, `claimed`, `synced`, `failed`, `dead`, `conflict` |
| `lease_owner` | TEXT | ID del proceso que reclamó |
| `lease_expires_at` | INTEGER | Vencimiento del lease (ms epoch) |
| `attempts` | INTEGER NOT NULL DEFAULT 0 | Número de intentos |
| `next_attempt_at` | INTEGER | Próximo momento de intento |
| `last_error` | TEXT | Último mensaje de error |
| `created_at` | INTEGER NOT NULL | Fecha de creación |
| `claimed_at` | INTEGER | Fecha de última reclamación |
| `synced_at` | INTEGER | Fecha de confirmación remota |
| `device_id` | TEXT NOT NULL | Dispositivo origen |
| `restaurant_id` | TEXT NOT NULL | Restaurante para aislamiento |

### 4.4 `sync_events_local` (cursor de eventos remotos aplicados)

| Columna | Tipo | Rol |
|---------|------|-----|
| `event_seq` | INTEGER PK | Secuencia local de aplicación |
| `event_id` | TEXT UNIQUE NOT NULL | ID del evento remoto |
| `event_type` | TEXT | Tipo de evento |
| `operation_id` | TEXT | UUID de la operación aplicada |
| `entity_type` | TEXT | Tipo de entidad |
| `op_type` | TEXT | Tipo de operación |
| `payload_hash` | TEXT | Hash del payload aplicado |
| `is_own_event` | INTEGER NOT NULL DEFAULT 0 | 1 si el evento fue originado por este dispositivo |
| `applied_at` | INTEGER NOT NULL | Momento de aplicación local |

---

## 5. Modelo PostgreSQL remoto (Supabase)

### 5.1 `inventory_sync`

| Columna | Tipo | Rol |
|---------|------|-----|
| `uuid` | UUID PK | Identificador estable del producto |
| `restaurant_id` | UUID NOT NULL | Aislamiento de negocio |
| `stock` | REAL NOT NULL DEFAULT 0 | Stock materializado remoto |
| `version` | INTEGER NOT NULL DEFAULT 1 | Versión para control de concurrencia optimista |
| `device_id` | TEXT | Dispositivo última modificación |
| `updated_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | Última actualización remota |
| `deleted` | BOOLEAN NOT NULL DEFAULT FALSE | Borrado lógico |

### 5.2 `orders_sync`

| Columna | Tipo | Rol |
|---------|------|-----|
| `order_uuid` | UUID PK | Identificador estable del pedido |
| `restaurant_id` | UUID NOT NULL | Aislamiento de negocio |
| `current_order_version` | INTEGER NOT NULL DEFAULT 1 | Versión actual del pedido |
| `status` | TEXT NOT NULL | `pending`, `preparing`, `ready`, `delivered`, `cancelled`, `active` |
| `device_id` | TEXT | Dispositivo última modificación |
| `updated_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | Última actualización |
| `deleted` | BOOLEAN NOT NULL DEFAULT FALSE | Borrado lógico |

### 5.3 `order_items_sync`

| Columna | Tipo | Rol |
|---------|------|-----|
| `item_uuid` | UUID PK | Identificador estable del ítem |
| `order_uuid` | UUID NOT NULL | Pedido al que pertenece |
| `inventory_uuid` | UUID | Producto de inventario |
| `name` | TEXT NOT NULL | Nombre del ítem |
| `price` | REAL NOT NULL | Precio unitario |
| `qty` | REAL NOT NULL | Cantidad solicitada |
| `item_type` | TEXT NOT NULL | `menu` o `inventory` |
| `status` | TEXT NOT NULL DEFAULT 'pending' | Estado del ítem |
| `deleted` | BOOLEAN NOT NULL DEFAULT FALSE | Borrado lógico |

### 5.4 `order_operations_sync`

| Columna | Tipo | Rol |
|---------|------|-----|
| `operation_id` | UUID PK | Operación de negocio sobre pedido |
| `order_uuid` | UUID NOT NULL | Pedido afectado |
| `expected_order_version` | INTEGER NOT NULL | Versión que el cliente esperaba |
| `current_order_version` | INTEGER NOT NULL | Versión del servidor al aplicar |
| `op_type` | TEXT NOT NULL | `create`, `modify`, `cancel`, `reopen` |
| `payload` | JSONB NOT NULL | Datos completos |
| `status` | TEXT NOT NULL DEFAULT 'applied' | `applied`, `rejected`, `conflict` |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | Momento de aplicación |

### 5.5 `stock_movements_sync`

| Columna | Tipo | Rol |
|---------|------|-----|
| `movement_uuid` | UUID PK | Identificador estable del movimiento |
| `operation_id` | UUID NOT NULL | Operación de negocio padre |
| `idempotency_key` | TEXT UNIQUE NOT NULL | Clave determinística |
| `restaurant_id` | UUID NOT NULL | Aislamiento de negocio |
| `inventory_uuid` | UUID NOT NULL | Referencia al producto |
| `order_uuid` | UUID | Referencia al pedido |
| `movement_type` | TEXT NOT NULL | `sale`, `return`, `shortage`, `adjustment` |
| `requested_quantity` | REAL | Cantidad solicitada |
| `stock_decrement_quantity` | REAL | Cantidad efectivamente descontada |
| `shortage_quantity` | REAL NOT NULL DEFAULT 0 | Cantidad de faltante |
| `stock_delta` | REAL NOT NULL | Variación efectiva del stock |
| `reference_type` | TEXT | Tipo de referencia |
| `reference_id` | TEXT | ID de referencia |
| `user_name` | TEXT NOT NULL | Usuario responsable |
| `user_role` | TEXT NOT NULL | Rol responsable |
| `authorized_by` | TEXT | Autorizador (si aplica) |
| `device_id` | TEXT NOT NULL | Dispositivo origen |
| `created_at` | TIMESTAMPTZ NOT NULL | Momento de creación local original |
| `synced_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | Confirmación remota |
| `deleted` | BOOLEAN NOT NULL DEFAULT FALSE | Borrado lógico |

### 5.6 `inventory_operations` (operaciones agrupadas)

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

### 5.7 `restaurant_seq` (cursor remoto monotónico)

| Columna | Tipo | Rol |
|---------|------|-----|
| `restaurant_id` | UUID PK | Identificador del restaurante |
| `next_event_seq` | BIGINT NOT NULL DEFAULT 1 | Siguiente secuencia de evento |
| `updated_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | Última actualización del cursor |

### 5.8 `sync_events` (registro de eventos remotos)

| Columna | Tipo | Rol |
|---------|------|-----|
| `event_id` | UUID PK | Identificador estable del evento |
| `event_seq` | BIGINT NOT NULL | Secuencia secuencial por restaurante |
| `restaurant_id` | UUID NOT NULL | Restaurante |
| `operation_id` | UUID NOT NULL | Operación asociada |
| `entity_type` | TEXT NOT NULL | Tipo de entidad |
| `op_type` | TEXT NOT NULL | Tipo de operación |
| `payload_hash` | TEXT | Hash del payload del evento |
| `is_own_event` | BOOLEAN NOT NULL DEFAULT FALSE | Evento originado por este dispositivo |
| `commit_ts` | TIMESTAMPTZ NOT NULL DEFAULT now() | Momento de confirmación de transacción |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | Momento de inserción |

**Restricciones UNIQUE e índices remotos:**
- `stock_movements_sync.movement_uuid` → PK
- `stock_movements_sync.idempotency_key` → UNIQUE
- `inventory_operations.operation_id` → PK
- `inventory_operations.idempotency_key` → UNIQUE
- `orders_sync.order_uuid` → PK
- `restaurant_seq.restaurant_id` → PK
- `sync_events.event_id` → PK
- `sync_events.event_seq` → UNIQUE por `restaurant_id`
- `sync_events.operation_id` → INDEX

---

## 6. Contratos completos

### 6.1 Identidades separadas (formal)

| Identidad | Propósito | Formato | Tabla PK remota |
|-----------|-----------|---------|-----------------|
| `operation_id` | UUID de la operación de negocio padre | UUID v4 válido, sin prefijos | `inventory_operations.operation_id` |
| `movement_uuid` | UUID de un movimiento individual | UUID v4 válido, sin prefijos | `stock_movements_sync.movement_uuid` |
| `order_uuid` | UUID del pedido relacionado | UUID v4 válido, sin prefijos | `orders_sync.order_uuid` |
| `inventory_uuid` | UUID del producto | UUID v4 válido, sin prefijos | `inventory_sync.uuid` |
| `event_id` | UUID del evento remoto | UUID v4 válido, sin prefijos | `sync_events.event_id` |
| `idempotency_key` | Clave determinística | Texto derivado de `(operation_id, movement_uuid, tipo, qty)` | `inventory_operations.idempotency_key` (UNIQUE), `stock_movements_sync.idempotency_key` (UNIQUE) |

### 6.2 Entrada RPC `apply_inventory_operation`

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `operation_id` | UUID | Sí | Identidad global de la operación padre |
| `idempotency_key` | TEXT | Sí | Clave determinística |
| `entity_type` | TEXT | Sí | `order` o `inventory` |
| `entity_uuid` | UUID | Sí | UUID de la entidad principal |
| `op_type` | TEXT | Sí | Tipo de operación de negocio |
| `movements` | JSONB [] | Sí | Array de movimientos hijos |
| `restaurant_id` | UUID | Sí | Validado contra JWT, no se confía en payload |

Cada movimiento hijo contiene:
- `movement_uuid` UUID
- `inventory_uuid` UUID
- `order_uuid` UUID (opcional)
- `movement_type` TEXT (`sale`, `return`, `shortage`, `adjustment`)
- `requested_quantity` REAL
- `stock_decrement_quantity` REAL
- `shortage_quantity` REAL (default 0)
- `stock_delta` REAL
- `reference_type` TEXT
- `reference_id` TEXT
- `user_name` TEXT
- `user_role` TEXT
- `authorized_by` TEXT (opcional)
- `device_id` TEXT
- `created_at` TIMESTAMPTZ

---

## 7. Pseudocódigo PostgreSQL válido (RPC `apply_inventory_operation`)

**Nota crítica:** Una función PL/pgSQL ejecutada como RPC se ejecuta dentro de una transacción implícita iniciada por el cliente. **NO usar `BEGIN`/`COMMIT` explícito** dentro de la función.

```sql
CREATE OR REPLACE FUNCTION apply_inventory_operation(
    p_operation_id UUID,
    p_idempotency_key TEXT,
    p_entity_type TEXT,
    p_entity_uuid UUID,
    p_op_type TEXT,
    p_movements JSONB,
    p_restaurant_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_existing_ops RECORD;
    v_existing_mov RECORD;
    v_payload_hash TEXT;
    v_event_seq BIGINT;
    v_movement RECORD;
    v_delta REAL;
    v_inv_stock REAL;
BEGIN
    -- 1. Validar restaurante desde JWT (no del payload)
    -- p_restaurant_id se compara con auth.jwt() ->> 'restaurant_id'
    -- Si no coinciden, lanzar excepción de seguridad

    -- 2. Idempotencia de operación padre: inserción atómica con ON CONFLICT
    v_payload_hash := encode(digest(p_movements::text, 'sha256'), 'hex');

    INSERT INTO inventory_operations (
        operation_id, idempotency_key, restaurant_id,
        entity_type, entity_uuid, op_type, payload, payload_hash, status
    ) VALUES (
        p_operation_id, p_idempotency_key, p_restaurant_id,
        p_entity_type, p_entity_uuid, p_op_type,
        p_movements, v_payload_hash, 'applied'
    )
    ON CONFLICT (operation_id) DO
    UPDATE SET
        status = CASE
            WHEN inventory_operations.idempotency_key = EXCLUDED.idempotency_key
             AND inventory_operations.payload_hash = EXCLUDED.payload_hash
             AND inventory_operations.entity_type = EXCLUDED.entity_type
             AND inventory_operations.entity_uuid = EXCLUDED.entity_uuid
             AND inventory_operations.op_type = EXCLUDED.op_type
            THEN inventory_operations.status
            ELSE 'rejected'
        END
    WHERE inventory_operations.operation_id = EXCLUDED.operation_id
    RETURNING * INTO v_existing_ops;

    -- 3. Si la operación ya existía y fue rechazada por contenido diferente, abortar
    IF v_existing_ops.status = 'rejected' THEN
        RAISE EXCEPTION 'operation_id_reused_with_different_content';
    END IF;

    -- 4. Si la operación ya existía y fue aplicada con mismo contenido, devolver resultado original
    IF v_existing_ops.status = 'applied'
       AND v_existing_ops.idempotency_key = p_idempotency_key
       AND v_existing_ops.payload_hash = v_payload_hash THEN
        RETURN json_build_object(
            'status', 'already_applied',
            'operation_id', p_operation_id,
            'message', 'Operación ya aplicada previamente'
        );
    END IF;

    -- 5. Registrar cada movimiento hijo y aplicar efecto sobre stock
    FOREACH v_movement IN ARRAY (p_movements::jsonb[]) LOOP
        -- 5a. Idempotencia del movimiento hijo
        INSERT INTO stock_movements_sync (
            movement_uuid, operation_id, idempotency_key, restaurant_id,
            inventory_uuid, order_uuid, movement_type,
            requested_quantity, stock_decrement_quantity, shortage_quantity,
            stock_delta, reference_type, reference_id,
            user_name, user_role, authorized_by, device_id, created_at
        ) VALUES (
            (v_movement->>'movement_uuid')::UUID,
            p_operation_id,
            v_movement->>'idempotency_key',
            p_restaurant_id,
            (v_movement->>'inventory_uuid')::UUID,
            NULLIF(v_movement->>'order_uuid', '')::UUID,
            v_movement->>'movement_type',
            (v_movement->>'requested_quantity')::REAL,
            (v_movement->>'stock_decrement_quantity')::REAL,
            (v_movement->>'shortage_quantity')::REAL,
            (v_movement->>'stock_delta')::REAL,
            v_movement->>'reference_type',
            v_movement->>'reference_id',
            v_movement->>'user_name',
            v_movement->>'user_role',
            v_movement->>'authorized_by',
            v_movement->>'device_id',
            (v_movement->>'created_at')::TIMESTAMPTZ
        )
        ON CONFLICT (movement_uuid) DO
        UPDATE SET
            status = CASE
                WHEN stock_movements_sync.idempotency_key = EXCLUDED.idempotency_key
                 AND stock_movements_sync.stock_delta = EXCLUDED.stock_delta
                 AND stock_movements_sync.movement_type = EXCLUDED.movement_type
                THEN stock_movements_sync.status
                ELSE 'rejected'
            END
        WHERE stock_movements_sync.movement_uuid = EXCLUDED.movement_uuid
        RETURNING * INTO v_existing_mov;

        -- 5b. Si el movimiento ya existía con contenido diferente, rechazar
        IF v_existing_mov.status = 'rejected' THEN
            RAISE EXCEPTION 'movement_uuid_reused_with_different_content';
        END IF;

        -- 5c. Si el movimiento ya existía con mismo contenido, no aplicar efecto dos veces
        IF v_existing_mov.status = 'applied'
           AND v_existing_mov.idempotency_key = v_movement->>'idempotency_key'
           AND v_existing_mov.stock_delta = (v_movement->>'stock_delta')::REAL THEN
            CONTINUE;
        END IF;

        -- 5d. Validar tipo de movimiento
        IF v_movement->>'movement_type' NOT IN ('sale','return','shortage','adjustment') THEN
            RAISE EXCEPTION 'invalid_movement_type';
        END IF;

        -- 5e. Aplicar efecto sobre stock únicamente cuando el movimiento se insertó por primera vez
        --     stock_delta es la variación efectiva (positiva o negativa)
        UPDATE inventory_sync
        SET stock = COALESCE(stock, 0) + (v_movement->>'stock_delta')::REAL,
            version = version + 1,
            device_id = v_movement->>'device_id',
            updated_at = now()
        WHERE uuid = (v_movement->>'inventory_uuid')::UUID
          AND restaurant_id = p_restaurant_id
          AND deleted = FALSE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'inventory_not_found';
        END IF;
    END LOOP;

    -- 6. Asignar secuencia de evento dentro de la misma transacción
    UPDATE restaurant_seq
    SET next_event_seq = next_event_seq + 1,
        updated_at = now()
    WHERE restaurant_id = p_restaurant_id
    RETURNING next_event_seq - 1 INTO v_event_seq;

    -- 7. Registrar evento en cursor remoto
    INSERT INTO sync_events (
        event_id, event_seq, restaurant_id,
        operation_id, entity_type, op_type, payload_hash,
        is_own_event, commit_ts
    ) VALUES (
        gen_random_uuid(), v_event_seq, p_restaurant_id,
        p_operation_id, p_entity_type, p_op_type, v_payload_hash,
        FALSE, now()
    );

    RETURN json_build_object(
        'status', 'applied',
        'operation_id', p_operation_id,
        'event_seq', v_event_seq
    );
END;
$$;
```

### 7.1 Colisiones y resolución

| Colisión | Mecanismo | Resultado |
|----------|-----------|-----------|
| `operation_id` duplicado, mismo payload | `ON CONFLICT (operation_id)` + comparación de `payload_hash` | `already_applied`, sin duplicar efectos |
| `operation_id` duplicado, payload diferente | `ON CONFLICT` + detección de diferencia | `rejected`, excepción `operation_id_reused_with_different_content` |
| `movement_uuid` duplicado, mismo contenido | `ON CONFLICT (movement_uuid)` + comparación | No aplicar efecto dos veces |
| `movement_uuid` duplicado, contenido diferente | `ON CONFLICT` + detección de diferencia | Excepción `movement_uuid_reused_with_different_content` |
| `idempotency_key` duplicado | Restricción UNIQUE en ambas tablas | Mismo que UUID duplicado |

---

## 8. Idempotencia y concurrencia

### 8.1 Estrategia para dos RPC simultáneas con mismo `operation_id`

**Problema:** Dos solicitudes llegan al mismo tiempo con el mismo `operation_id` pero aún no existe ninguna fila. Un `SELECT FOR UPDATE` sobre fila inexistente no bloquea nada.

**Solución:** `INSERT ... ON CONFLICT (operation_id)`. La restricción UNIQUE garantiza que solo una transacción inserte la fila. La segunda entra en la rama `ON CONFLICT` y compara contenido.

**Carrera entre dos solicitudes idénticas:**

1. Tx A: `INSERT` → adquiere lock en página del índice UNIQUE.
2. Tx B: `INSERT` → bloquea esperando a A.
3. Tx A: confirma (transacción implícita de RPC).
4. Tx B: despierta, detecta conflicto, compara `idempotency_key` y `payload_hash`.
5. Si son idénticos → `already_applied`. Si difieren → excepción.

**Carrera entre dos solicitudes diferentes:**

1. Tx A: inserta `operation_id='X'` con payload P1.
2. Tx B: intenta insertar `operation_id='X'` con payload P2, bloquea.
3. Tx A: confirma.
4. Tx B: entra en `ON CONFLICT`, detecta diferencia → excepción.

### 8.2 Stock bloqueado por producto

El servidor serializa operaciones que modifican el mismo producto mediante el `UPDATE ... WHERE uuid = ?` dentro de la transacción. PostgreSQL bloquea la fila de `inventory_sync` durante el `UPDATE`, garantizando que dos ventas concurrentes sobre el mismo producto se procesen secuencialmente sobre el saldo remoto actual.

---

## 9. Reglas comerciales de stock

### 9.1 Campos formales (separados inequívocamente)

| Campo | Significado |
|-------|-------------|
| `requested_quantity` | Cantidad que el cliente quiere vender |
| `stock_decrement_quantity` | Cantidad efectivamente descontada del stock |
| `shortage_quantity` | Faltante de inventario (`requested_quantity - stock_decrement_quantity` cuando no hay auth) |
| `stock_delta` | Variación efectiva del stock (`-stock_decrement_quantity` para `sale`, `+stock_decrement_quantity` para `return`, `0` para `shortage`, signo para `adjustment`) |

### 9.2 Reglas por escenario

| Escenario | Condición | `stock_decrement_quantity` | `shortage_quantity` | `stock_delta` | Stock final |
|-----------|-----------|---------------------------|---------------------|---------------|-------------|
| Stock suficiente | `solicitada <= disponible` | `solicitada` | 0 | `-solicitada` | `disponible - solicitada` |
| Stock insuficiente sin auth | `solicitada > disponible` | `disponible` | `solicitada - disponible` | `-disponible` | 0 |
| Stock insuficiente con auth admin | `solicitada > disponible` | `solicitada` | 0 | `-solicitada` | `disponible - solicitada` (puede ser negativo) |

### 9.3 Escenario de dos dispositivos con stock 5 vendiendo 8 cada uno sin auth

**Resultado correcto (servidor serializa sobre saldo central):**

1. Dispositivo A vende 8 (sin auth): servidor descuenta 5, stock remoto = 0, `shortage_quantity = 3`.
2. Dispositivo B vende 8 (sin auth): servidor descuenta 0 (stock ya es 0), stock remoto = 0, `shortage_quantity = 8`.

**Stock final remoto:** 0.
**Movimientos:** dos `sale` (qty 5 y qty 0) y dos `shortage` (3 y 8).

**No es correcto:** "dos faltantes de 3" (esto ignoraría que el servidor procesa sobre el saldo central, no sobre la copia local de cada dispositivo).

### 9.4 Pseudocódigo de lógica de stock (servidor)

```
FUNCTION calcular_descuento(disponible, solicitada, autorizado_admin):
  SI solicitada <= disponible:
    RETORNAR { descontada: solicitada, faltante: 0, delta: -solicitada }
  SINO SI autorizado_admin:
    RETORNAR { descontada: solicitada, faltante: 0, delta: -solicitada }
  SINO:
    RETORNAR { descontada: disponible, faltante: solicitada - disponible, delta: -disponible }
```

---

## 10. Pedidos y conflictos offline

### 10.1 Entidades de pedido remoto

#### `orders_sync`

| Columna | Tipo | Rol |
|---------|------|-----|
| `order_uuid` | UUID PK | Identificador estable del pedido |
| `restaurant_id` | UUID NOT NULL | Aislamiento de negocio |
| `current_order_version` | INTEGER NOT NULL DEFAULT 1 | Versión actual del pedido |
| `status` | TEXT NOT NULL | `pending`, `preparing`, `ready`, `delivered`, `cancelled`, `active` |
| `device_id` | TEXT | Dispositivo última modificación |
| `updated_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | Última actualización |
| `deleted` | BOOLEAN NOT NULL DEFAULT FALSE | Borrado lógico |

#### `order_operations_sync`

| Columna | Tipo | Rol |
|---------|------|-----|
| `operation_id` | UUID PK | Operación de negocio sobre pedido |
| `order_uuid` | UUID NOT NULL | Pedido afectado |
| `expected_order_version` | INTEGER NOT NULL | Versión que el cliente esperaba |
| `current_order_version` | INTEGER NOT NULL | Versión del servidor al aplicar |
| `op_type` | TEXT NOT NULL | `create`, `modify`, `cancel`, `reopen` |
| `payload` | JSONB NOT NULL | Datos completos |
| `status` | TEXT NOT NULL DEFAULT 'applied' | `applied`, `rejected`, `conflict` |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | Momento de aplicación |

### 10.2 Estados explícitos de operación

| Estado | Significado |
|--------|-------------|
| `pendiente` | Creada localmente, no enviada |
| `aplicada` | Confirmada por servidor (UUID existe) |
| `rechazada` | Servidor rechazó (conflicto, UUID reutilizado, producto inexistente) |
| `en_conflicto` | No puede aplicarse por versión desactualizada |

### 10.3 Escenarios de conflictos

| Escenario | Resolución |
|-----------|------------|
| Venta offline después de cancelación | Servidor rechaza: `order_status = 'cancelled'`, versión no coincide. `en_conflicto`. |
| Cancelación después de venta | `return` qty = `SUM(sale) - SUM(return)` efectivo. Stock vuelve al previo. |
| Devolución antes de venta original | Rechazada: `return_exceeds_sale` (no hay venta a la que referenciar). |
| Dos modificaciones simultáneas mismo pedido | Primera se aplica. Segunda: `CONFLICT_ORDER_VERSION`, `en_conflicto`. |
| Operación local confirmada rechazada por versión | `en_conflicto`. Cliente debe refrescar, regenerar y reenviar. |
| Reapertura después de cancelación | `sale` qty = `SUM(sale)` reconstruido (respetando reglas de auth). |
| Dos operaciones agrupadas, distintos productos mismo pedido | Ambas se aplican (no hay conflicto de stock entre productos distintos). |
| Dos cancelaciones | Segunda es `en_conflicto` (ya cancelada), no se reintegra de nuevo. |
| Dos reaperturas | Segunda es `en_conflicto` (ya activa), no se re-descuenta de nuevo. |

### 10.4 Devoluciones vinculadas a ventas originales

- Un `return` debe referenciar una `sale` original del mismo `order_uuid` + `inventory_uuid`.
- `return.stock_decrement_quantity` no puede exceder `SUM(sale.stock_decrement_quantity) - SUM(return.stock_decrement_quantity)` previas para esa orden+producto.
- Si se excede, servidor rechaza con `return_exceeds_sale_available`.

### 10.5 Política de conflictos

**Regla de oro:** Una operación confirmada localmente nunca desaparece silenciosamente. Si hay conflicto de versión, el servidor rechaza con error explícito y el cliente debe resolver manualmente.

---

## 11. Eventos y cursor remoto

### 11.1 Contrato de evento remoto

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `event_id` | UUID PK | Identificador estable del evento |
| `event_seq` | BIGINT | Secuencia secuencial por restaurante |
| `restaurant_id` | UUID | Restaurante |
| `operation_id` | UUID | Operación asociada |
| `entity_type` | TEXT | Tipo de entidad |
| `op_type` | TEXT | Tipo de operación |
| `payload_hash` | TEXT | Hash del payload |
| `is_own_event` | BOOLEAN | 1 si el dispositivo originó el evento |
| `commit_ts` | TIMESTAMPTZ | Fecha de confirmación remota |

### 11.2 RPC de lectura de eventos: `get_sync_events`

**Entrada:** `p_restaurant_id UUID`, `p_from_seq BIGINT`, `p_limit INT`

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
      "payload_hash": "sha256hex",
      "is_own_event": false,
      "commit_ts": "2026-11-20T10:00:00Z"
    }
  ],
  "next_seq": 43,
  "has_more": true
}
```

### 11.3 Cursor remoto por restaurante

Tabla `restaurant_seq`:

| Columna | Tipo | Rol |
|---------|------|-----|
| `restaurant_id` | UUID PK | Restaurante |
| `next_event_seq` | BIGINT NOT NULL DEFAULT 1 | Siguiente secuencia |
| `updated_at` | TIMESTAMPTZ NOT NULL | Última actualización |

**Asignación dentro de la misma transacción que registra operación y evento:**

```sql
UPDATE restaurant_seq
SET next_event_seq = next_event_seq + 1,
    updated_at = now()
WHERE restaurant_id = p_restaurant_id
RETURNING next_event_seq - 1 INTO v_event_seq;
```

**Comportamiento de transacciones concurrentes:**

| Paso | Tx A | Tx B |
|------|------|------|
| 1 | `UPDATE restaurant_seq` (bloquea fila R) | `UPDATE restaurant_seq` (bloqueada) |
| 2 | Obtiene `event_seq = 5` | — |
| 3 | Inserta operación + evento seq=5 | — |
| 4 | COMMIT | — |
| 5 | — | Obtiene `event_seq = 6` |
| 6 | — | Inserta operación + evento seq=6 |
| 7 | — | COMMIT |

**Resultado:** `event_seq` 5 y 6 son consecutivos sin huecos. No puede haber evento tardío con secuencia inferior al cursor confirmado porque la secuencia se asigna dentro de la transacción que confirma el evento.

### 11.4 Evento propio

Si un dispositivo recibe un evento que él mismo originó (`is_own_event = true` o `device_id = DEVICE_ID`):

1. Verificar que el `event_id` ya existe en `sync_events_local`.
2. Si existe: marcar como procesado, avanzar cursor, no duplicar movimientos.
3. Si no existe: registrar como procesado, avanzar cursor, no duplicar movimientos.

**No ignorar el evento sin actualizar el cursor.** El cursor debe avanzar para no solicitar el mismo evento repetidamente.

### 11.5 Recuperación ante fallos

| Situación | Acción |
|-----------|--------|
| Caída de Electron | `sync_events_local` persiste; al reiniciar se reanuda desde `last_synced_seq` |
| Error al aplicar movimiento hijo | Transacción SQLite se revierte; evento no se marca aplicado; cursor no avanza |
| Realtime desconectado | Polling del cursor `sync_events` cada intervalo configurable |
| Evento duplicado | `event_id` ya existe → ignorar, avanzar cursor |
| Evento fuera de orden | Detener en `event_seq` faltante, solicitar recuperación |
| Evento propio | Confirmar como procesado, avanzar cursor, no duplicar |
| Evento referencia producto inexistente | Cola de espera, aplicar cuando el producto se sincronice |

**Regla:** El cursor local solo avanza después de confirmar la aplicación completa en SQLite.

---

## 12. Seguridad y permisos Supabase

### 12.1 Elección: `SECURITY DEFINER`

**Decisión:** `SECURITY DEFINER` con `search_path` fijo y validaciones explícitas.

**Justificación:**
- `SECURITY INVOKER` con permisos denegados a `authenticated` genera contradicción: la función no podría escribir en las tablas.
- `SECURITY DEFINER` permite que la función escriba con privilegios del propietario, mientras RLS y validaciones explícitas controlan qué puede hacer cada usuario.
- Se debe establecer `search_path` explícitamente para evitar inyección a través de funciones con nombres similares en esquemas públicos.

### 12.2 GRANT y REVOKE

| Objeto | Rol | Permiso |
|--------|-----|---------|
| `inventory_sync` | `authenticated` | REVOKE ALL |
| `stock_movements_sync` | `authenticated` | REVOKE ALL |
| `orders_sync` | `authenticated` | REVOKE ALL |
| `order_items_sync` | `authenticated` | REVOKE ALL |
| `order_operations_sync` | `authenticated` | REVOKE ALL |
| `inventory_operations` | `authenticated` | REVOKE ALL |
| `sync_events` | `authenticated` | REVOKE ALL |
| `restaurant_seq` | `authenticated` | REVOKE ALL |
| Función `apply_inventory_operation` | `authenticated` | EXECUTE |
| Función `get_sync_events` | `authenticated` | EXECUTE |

### 12.3 Políticas RLS (solo para consultas de lectura si se necesita)

| Tabla | Política |
|-------|----------|
| `inventory_sync` | `restaurant_id = auth.jwt() ->> 'restaurant_id'` (solo SELECT si se expone) |
| `stock_movements_sync` | `restaurant_id = auth.jwt() ->> 'restaurant_id'` |
| `orders_sync` | `restaurant_id = auth.jwt() ->> 'restaurant_id'` |
| `sync_events` | `restaurant_id = auth.jwt() ->> 'restaurant_id'` |

### 12.4 Validaciones en la RPC

| Elemento | Origen | Validación |
|----------|--------|------------|
| `restaurant_id` | JWT claim | Debe coincidir con restaurante del dispositivo |
| `user_name` | JWT claim | No se acepta del payload |
| `user_role` | JWT claim | No se acepta del payload |
| `authorized_by` | JWT claim | Solo si rol es `owner` o `admin` |
| `device_id` | Payload + JWT | Debe estar en tabla `devices` del restaurante |
| `search_path` | Función | `SET search_path = pg_catalog, public` dentro de la función |

### 12.5 Revocación de dispositivos

Tabla `devices`:

| Columna | Tipo | Rol |
|---------|------|-----|
| `device_id` | UUID PK | Identificador del dispositivo |
| `restaurant_id` | UUID NOT NULL | Restaurante |
| `activo` | BOOLEAN NOT NULL DEFAULT TRUE | Estado del dispositivo |
| `revocado_en` | TIMESTAMPTZ | Momento de revocación |

La RPC verifica que el `device_id` exista y esté `activo = TRUE` para el `restaurant_id` de la sesión JWT. Revocación: `activo = FALSE`, `revocado_en = now()`. JWT antiguo mantiene permisos hasta su expiración; se recomienda expiración corta de JWT.

### 12.6 Prohibiciones absolutas

- `service_role` en Electron y renderer: **prohibido**.
- Confiar en `restaurant_id`, `user_role`, `user_name`, `authorized_by`, `device_id` del payload sin validación JWT: **prohibido**.
- Permisos implícitos: **prohibidos**. Todo debe ser explícito mediante GRANT/REVOKE y RLS.

---

## 13. Outbox

### 13.1 Reclamo atómico (SQLite / better-sqlite3)

```sql
UPDATE sync_queue
SET status = 'claimed',
    lease_owner = ?,
    lease_expires_at = ?,
    claimed_at = ?,
    attempts = attempts + 1
WHERE id = ?
  AND status = 'pending'
  AND (lease_expires_at IS NULL OR lease_expires_at < ?);
```

- Verificar `changes = 1` para confirmar reclamación exclusiva.
- **Nunca** mantener transacción SQLite abierta durante HTTP. El lease se establece, COMMIT, luego llamada HTTP, luego actualizar estado en transacción separada.

### 13.2 Lease y expiración

| Campo | Propósito |
|-------|-----------|
| `lease_owner` | `device_id:pid` del proceso |
| `lease_expires_at` | `ahora + 120000 ms` |
| `claimed_at` | Momento de última reclamación |

### 13.3 Recuperación tras caída

Al iniciar, escanear operaciones en `claimed` con `lease_expires_at < ahora` y volverlas a `pending`.

### 13.4 Backoff

| Intento | Retraso |
|---------|---------|
| 1 | inmediato |
| 2 | 5s |
| 3 | 15s |
| 4 | 60s |
| 5+ | 300s |

Tras 7 intentos, `status = dead`.

### 13.5 Estados

| Estado | Significado | Transición |
|--------|-------------|------------|
| `pending` | Lista para procesar | `claimed` |
| `claimed` | Enviándose | `synced`, `failed`, `dead` |
| `synced` | Confirmada | (retención 30 días) |
| `failed` | Error transitorio | `pending` (reintento manual) |
| `dead` | Error permanente | revisión manual |
| `conflict` | Conflicto de versión | revisión manual |

### 13.6 Estados de error

- `failed`: puede volver a `pending` cuando se resuelva el error transitorio.
- `dead`: no se reintenta automáticamente, requiere intervención manual.
- `conflict`: requiere resolución manual del usuario.

### 13.7 Dependencias entre operaciones

- Operaciones de un mismo pedido comparten `order_uuid` en el payload.
- El cliente debe esperar a que una `sale` esté `synced` antes de enviar la `return` que depende de ella.

### 13.8 Retención y auditoría

- `synced`: mínimo 30 días.
- `dead` y `conflict`: indefinidamente para revisión manual.

---

## 14. Bootstrap y migración

### 14.1 Procedimiento de bootstrap centralizado

1. **Detención de sincronizadores:** Todos los dispositivos deben detener `flushQueue` y Realtime.
2. **Bloqueo temporal de escrituras incompatibles:** Clientes antiguos que envíen `stock = valor absoluto` son bloqueados.
3. **Selección de saldo inicial canónico:** Un dispositivo de referencia (o el servidor) define el saldo canónico para cada producto.
4. **Conciliación de diferencias:** Si dos dispositivos tienen stock diferente para el mismo producto, se registra un `adjustment` central con autorización admin.
5. **Registro de ajustes auditables:** Cada ajuste se registra como movimiento `adjustment` con `user_name` y `user_role` del administrador.
6. **Migración de productos y UUID:** Productos sin `uuid` reciben uno (backfill). Se añade columna `version` (INTEGER DEFAULT 1).
7. **Tratamiento de movimientos históricos:** Conservados localmente como trazabilidad, **no se suben automáticamente** a Supabase.
8. **Tratamiento de colas antiguas:** Entradas existentes en `sync_queue` se clasifican:
   - Compatibles → se reintentan con RPC idempotente.
   - Incompatibles (stock absoluto) → cuarentena para revisión manual.
9. **Bloqueo de clientes antiguos:** Modo solo lectura para inventario hasta actualizar.
10. **Verificación de integridad:** `checkIntegrity` compara conteos local vs remoto por restaurante antes de reactivar cada dispositivo.
11. **Reanudación controlada:** Reactivar dispositivo por dispositivo.

### 14.2 Reglas de migración

- **No generar movimientos históricos inventados.** La trazabilidad remota comienza desde la activación.
- **No reenviar automáticamente colas antiguas incompatibles.** Se clasifican y ponen en cuarentena.
- **La conciliación produce una única operación central autorizada**, no un ajuste independiente por cada dispositivo.

---

## 15. Plan de pruebas (26 pruebas)

Todas las pruebas usan **dos bases SQLite independientes** y un **entorno Supabase de pruebas**. Nunca producción. Las pruebas que requieran Supabase se ejecutan únicamente en proyecto aislado durante futura fase de implementación.

| # | Prueba | Datos iniciales | Operaciones concurrentes | Resultado esperado | Stock final | Movimientos | Eventos | Outbox | Criterio cuantificable |
|---|--------|----------------|-------------------------|-------------------|-------------|-------------|---------|--------|----------------------|
| 1 | Dos SQLite independientes | A: stock 10. B: stock 10. | A vende 3, B vende 4 (offline). Sincronizan. | Stock remoto = 3. Dos `sale` UUID distintos. | 3 | 2 | 2 | 2 `synced` | `stock` = 3; `COUNT(movement_type='sale')` = 2 |
| 2 | Dos procesos Node misma outbox | `sync_queue` con 3 operaciones pendientes. | Dos procesos reclaman al mismo tiempo. | Cada operación procesada exactamente una vez. | — | — | — | 3 `synced` | `changes=1` en cada reclamo; sin duplicados |
| 3 | Dos RPC concurrentes mismo operation_id | Operación `sale` UUID-X qty=3. | Dos solicitudes RPC simultáneas, mismo UUID, payload idéntico. | Aplicada una sola vez. | — | 1 | 1 | 1 `synced` | `COUNT(movement_uuid=?)` = 1 |
| 4 | Reintento payload idéntico | Operación ya aplicada UUID-X. | Reenviar misma operación. | `already_applied`, sin duplicar. | — | 1 | 1 | — | `COUNT(movement_uuid=?)` = 1 |
| 5 | Reintento payload diferente | Operación UUID-X qty=3 aplicada. | Reenviar UUID-X qty=5. | Rechazado. | — | 1 | 1 | — | Error `operation_id_reused_with_different_content` |
| 6 | Reutilización movement_uuid | Movimiento UUID-M qty=3 aplicado. | Reenviar UUID-M qty=5. | Rechazado. | — | 1 | 1 | — | Error `movement_uuid_reused_with_different_content` |
| 7 | Respuesta remota perdida | Cliente envía, servidor aplica, respuesta se pierde. | Cliente reenvía misma operación. | No hay duplicación. | — | 1 | 1 | — | `COUNT(movement_uuid=?)` = 1 |
| 8 | Caída durante envío | Cliente envía, proceso muere antes de respuesta. | Operación queda en `claimed`. | Al reiniciar, lease expira, se recupera a `pending`. | — | — | — | `claimed` → `pending` | `status` pasa `claimed` a `pending` tras reinicio |
| 9 | Recuperación de lease | Operación en `claimed` con lease expirado. | Nuevo proceso reclama. | Operación pasa a `pending` y se reintenta. | — | — | — | `pending` | `status` = `pending` tras recuperación |
| 10 | Venta y cancelación concurrentes | Orden activa, stock 10. | A vende 3, B cancela. | Stock remoto = 10. Cancelación registrada. | 10 | 2 | 2 | 2 `synced` | `stock` = 10; `return` qty=3 |
| 11 | Venta posterior a cancelación | Orden cancelada, stock 10. | Intentar vender sobre orden cancelada. | Venta rechazada, `en_conflicto`. | 10 | 0 | 0 | `conflict` | `order_status='cancelled'`; operación en `en_conflicto` |
| 12 | Modificaciones simultáneas pedido | Pedido qty=3, versión v1. | A modifica a 5 (espera v1), B modifica a 4 (espera v1). | Una se aplica; otra `CONFLICT_ORDER_VERSION`. | — | — | — | 1 `synced`, 1 `conflict` | Una `synced`; otra `en_conflicto` |
| 13 | Reapertura repetida | Orden cancelada. | Reabrir dos veces. | Segunda es `en_conflicto` (no-op). | — | 1 | 1 | 1 `synced`, 1 `conflict` | Solo un `sale` de re-discount |
| 14 | Cancelación repetida | Orden activa con venta. | Cancelar dos veces. | Segunda es `en_conflicto` (no-op). | — | 1 | 1 | 1 `synced`, 1 `conflict` | Solo un `return` |
| 15 | Dos ventas offline stock insuficiente | Stock 5 en servidor. | A vende 8 (sin auth), B vende 8 (sin auth). | Stock remoto = 0. A: descuenta 5, shortage 3. B: descuenta 0, shortage 8. | 0 | 2 sale + 2 shortage | 2 | 2 `synced` | `stock` = 0; `stock_decrement_quantity` suma 5 |
| 16 | Venta sin autorización | Stock 5. | Vender 8 sin auth. | Stock = 0, `shortage` = 3. | 0 | 1 sale + 1 shortage | 1 | 1 `synced` | `stock` = 0; `shortage_quantity` = 3 |
| 17 | Venta con autorización administrativa | Stock 5, admin auth. | Vender 8. | Stock remoto = -3. | -3 | 1 sale | 1 | 1 `synced` | `stock` = -3; `stock_decrement_quantity` = 8 |
| 18 | Ajuste positivo y negativo | Stock 10. | Admin ajuste +5, luego ajuste -3. | Stock remoto = 12. | 12 | 2 adjustment | 2 | 2 `synced` | `stock` = 12; dos movimientos `adjustment` |
| 19 | Realtime desconectado | Operaciones pendientes. | Desconectar Realtime, hacer polling del cursor. | Eventos aplicados al recuperar. | — | — | — | `synced` | `last_synced_seq` avanza |
| 20 | Recuperación del cursor | `last_synced_seq=5`, evento `seq=8` llega primero. | Dispositivo se detiene en `seq=6`. | Solicita recuperación de `seq=6,7`. | — | — | — | — | No se aplica `seq=8` antes de `6,7` |
| 21 | Error parcial aplicación local | Evento con 2 movimientos hijos. | Error al aplicar segundo hijo. | Transacción SQLite se revierte. | — | 0 | 0 | — | Ningún movimiento aplicado; `last_synced_seq` no avanza |
| 22 | Dispositivo revocado | Dispositivo D revocado. | D intenta enviar operación. | HTTP 403. | — | 0 | 0 | — | Operación no aplicada |
| 23 | Migración de colas antiguas | Cola con operación stock absoluto. | Ejecutar bootstrap. | Operación en cuarentena. | — | — | — | `dead` o `conflict` | `status` = `dead` o `conflict` para incompatibles |
| 24 | Reconciliación saldo inicial | Dos dispositivos stock diferente mismo producto. | Bootstrap centralizado. | Un solo `adjustment` central. | — | 1 adjustment | 1 | 1 `synced` | Un `adjustment` con autorización admin |
| 25 | Dos commits concurrentes orden eventos | Dos transacciones concurrentes en servidor. | Evento lento confirma después de rápido. | `event_seq` refleja orden de publicación. | — | — | — | — | Sin huecos en `event_seq` aplicados |
| 26 | Carrera idempotencia dos transacciones reales | Operación UUID-X no existente. | Dos Tx RPC simultáneas mismo UUID. | Una aplica, otra `already_applied`. | — | 1 | 1 | 1 `synced` | `COUNT(movement_uuid=?)` = 1 |

---

## 16. Riesgos residuales

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

## 17. Criterios objetivos de aceptación

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
12. **Evento propio** se confirma sin duplicar movimientos y avanza el cursor.
13. **Ajuste negativo** se representa con signo en `stock_delta`, no con cantidad positiva forzada.
14. **Todas las 26 pruebas del plan de pruebas pasan** en entorno aislado.

---

**Fase 2B.5.1 (V5) completada. Arquitectura lista para revisión final. Detenido a la espera de autorización explícita para pasar a implementación.**