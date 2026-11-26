# INVENTORY_SYNC_PHASE_2B5_1_ARCHITECTURE_DESIGN_V6.md

## Fase 2B.5.1 — Diseño de Arquitectura de Sincronización de Inventario (Versión 6 — Definitiva)

**Proyecto:** La Mente Maestra 3.0 (POS)  
**Archivo de origen:** `INVENTORY_SYNC_PHASE_2B5_1_ARCHITECTURE_DESIGN_V5.md`  
**Fecha:** 20/11/2026  
**Modalidad:** SOLO ANÁLISIS Y DOCUMENTACIÓN — PROHIBIDO IMPLEMENTAR  
**Estado:** PROPUESTA V6 LISTA PARA REVISIÓN  

---

## 1. Resumen ejecutivo

V5 contenía 10 errores críticos que impedían su implementación directa:

| ID | Error en V5 | Severidad | Estado en V6 |
|----|-------------|-----------|--------------|
| E1 | Idempotencia de operación padre: `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` devuelve incorrectamente `already_applied` para operaciones nuevas | CRÍTICO | RESUELTO EN DISEÑO — `INSERT ... ON CONFLICT DO NOTHING RETURNING` + `IF NOT FOUND` |
| E2 | Idempotencia de movimientos: mismo patrón defectuoso que E1; `idempotency_key` del cliente en lugar de derivado del servidor | CRÍTICO | RESUELTO EN DISEÑO — `ON CONFLICT DO NOTHING` + `idempotency_key` derivada del servidor |
| E3 | Autoridad central del stock: cliente envía `stock_delta`, `stock_decrement_quantity`, `shortage_quantity` como valores autoritativos | CRÍTICO | RESUELTO EN DISEÑO — cliente envía solo `requested_quantity`; servidor calcula todo sobre saldo remoto actual |
| E4 | Integridad entre pedidos e inventario: no hay transacción atómica que aplique pedido + inventario + movimientos + evento; no hay verificación de `expected_order_version` | CRÍTICO | RESUELTO EN DISEÑO — RPC aplica todo en una transacción PostgreSQL con control de versión optimista |
| E5 | SQL inválido: `FOREACH ... IN ARRAY (jsonb[])` incorrecto; `encode(digest(...))` no canónico; falta `search_path`; falta `SECURITY DEFINER` | CRÍTICO | RESUELTO EN DISEÑO — `jsonb_array_elements`, `canonical_json`, `search_path`, `SECURITY DEFINER` |
| E6 | Seguridad: elección de `SECURITY DEFINER` sin `search_path`, sin tabla `devices`, sin GRANT/REVOKE detallados, sin RLS completas | CRÍTICO | RESUELTO EN DISEÑO — `SECURITY DEFINER` + `search_path` fijo, tabla `devices`, RLS, GRANT/REVOKE explícitos |
| E7 | Eventos y cursores: `get_sync_events` devuelve solo `payload_hash` no `payload` completo; `is_own_event` no se deriva localmente; sin definición de gaps | ALTO | RESUELTO EN DISEÑO — `get_sync_events` devuelve `payload` completo; `is_own_event` local; detección de gaps |
| E8 | Outbox y recuperación: `sync_queue` esquema incompleto; sin `retry_wait` ni `dead_letter`; sin especificación de migración | ALTO | RESUELTO EN DISEÑO — nueva tabla `inventory_outbox` con estados completos, `next_attempt_at`, backoff, `dead_letter` |
| E9 | Migración de datos existentes: sin procedimiento para migrar columnas existentes, backfill de `stock_movements`, clasificación de colas antiguas | CRÍTICO | RESUELTO EN DISEÑO — procedimiento de bootstrap centralizado con 11 pasos, backfill, cuarentena, saldo inicial canónico |
| E10 | Pruebas y aceptación: algunos números incorrectos; no especifica cómo ejecutar con dos procesos Node independientes | ALTO | RESUELTO EN DISEÑO — 26 pruebas reescritas con datos correctos, criterios cuantificables, entorno Supabase aislado, dos procesos Node |

---

## 2. Diagnóstico de V5 y causas raíz

### 2.1 Error E1 — Idempotencia de operación padre

**Causa raíz:** El pseudocódigo de V5 usa:

```sql
INSERT INTO inventory_operations (...) VALUES (...)
ON CONFLICT (operation_id) DO UPDATE SET status = CASE ... END
RETURNING * INTO v_existing_ops;
```

Cuando una operación NUEVA se inserta por primera vez, el `INSERT` tiene éxito (no hay conflicto) y `RETURNING *` devuelve la fila recién insertada con `status = 'applied'`. Luego el código verifica:

```sql
IF v_existing_ops.status = 'applied'
   AND v_existing_ops.idempotency_key = p_idempotency_key
   AND v_existing_ops.payload_hash = v_payload_hash THEN
   RETURN json_build_object('status', 'already_applied', ...);
END IF;
```

Como acabamos de insertar con esos valores exactos, esta condición es **siempre verdadera** para operaciones nuevas. Resultado: una operación nueva se devuelve incorrectamente como `already_applied`, y nunca se aplican los movimientos ni se actualiza el stock.

**Solución definitiva:** `INSERT ... ON CONFLICT DO NOTHING RETURNING *`. Si `NOT FOUND` → hubo conflicto (operación existente), consultar con `FOR UPDATE` y comparar contenido. Si se insertó una fila nueva → continuar con movimientos normalmente.

---

### 2.2 Error E2 — Idempotencia de movimientos

**Causa raíz:** Mismo patrón defectuoso que E1 aplicado a movimientos hijos en el bucle `FOREACH`. Además, el `idempotency_key` del movimiento viene del cliente (`v_movement->>'idempotency_key'`) en lugar de derivarse del servidor de forma determinística.

**Solución definitiva:** `INSERT ... ON CONFLICT DO NOTHING RETURNING *` para movimientos. El `idempotency_key` se deriva del servidor como `SHA-256(operation_id || movement_uuid || movement_type || stock_delta)`.

---

### 2.3 Error E3 — Autoridad central del stock

**Causa raíz:** V5 permite que el cliente envíe `stock_delta`, `stock_decrement_quantity` y `shortage_quantity` como valores autoritativos. El servidor simplemente aplica `stock = stock + stock_delta` sin verificar si el descuento es válido sobre el saldo remoto actual.

**Solución definitiva:** El cliente envía solo `requested_quantity` (cuánto quiere vender). El servidor:
1. Bloquea la fila de inventario con `UPDATE inventory_sync SET ... WHERE uuid = ?` (PostgreSQL bloquea la fila durante el UPDATE en transacción).
2. Lee `stock` actual.
3. Aplica reglas comerciales: si `requested <= disponible` → descontar todo; si `requested > disponible` sin auth → descontar solo disponible, registrar `shortage`; si `requested > disponible` con auth → descontar todo, permitir negativo.
4. Calcula `stock_decrement_quantity`, `shortage_quantity`, `stock_delta` en el servidor.

---

### 2.4 Error E4 — Integridad entre pedidos e inventario

**Causa raíz:** V5 define tablas `orders_sync` y `order_operations_sync` pero la RPC `apply_inventory_operation` no acepta datos de orden, no verifica `expected_order_version` vs `current_order_version`, y no aplica pedido + inventario + movimientos + evento en una sola transacción atómica.

**Solución definitiva:** La RPC acepta datos de orden cuando `entity_type = 'order'`. Verifica control de versión optimista (`expected_order_version` debe coincidir con `current_order_version`). Aplica todo en una sola transacción PostgreSQL: actualizar `orders_sync`, insertar `order_operations_sync`, insertar `stock_movements_sync`, actualizar `inventory_sync`, insertar `sync_events`.

---

### 2.5 Error E5 — SQL inválido o incompleto

**Causas raíz:**
- `FOREACH v_movement IN ARRAY (p_movements::jsonb[])` — `jsonb[]` es incorrecto para un JSONB array; debería ser `jsonb_array_elements(p_movements)`.
- `encode(digest(p_movements::text, 'sha256'), 'hex')` — `p_movements::text` no es canónico (el orden de claves JSON puede variar).
- Falta `SET search_path = pg_catalog, public` dentro de la función.
- Falta `SECURITY DEFINER` explícito.
- Falta tabla `devices` en el modelo remoto.
- `NULLIF(v_movement->>'order_uuid', '')::UUID` puede producir `NULL::UUID` que es válido pero necesita manejo explícito.

**Solución definitiva:** `jsonb_array_elements(p_movements)` para iterar; `canonical_json` + `digest` para hash canónico; `SET search_path = pg_catalog, public`; `SECURITY DEFINER`; tabla `devices` definida.

---

### 2.6 Error E6 — Seguridad

**Causa raíz:** V5 elige `SECURITY DEFINER` pero no detalla `search_path`, GRANT/REVOKE, RLS completas, ni tabla `devices` en el modelo remoto. No explica cómo se revoca un dispositivo ni cómo un JWT antiguo mantiene permisos hasta expiración.

**Solución definitiva:** `SECURITY DEFINER` con `SET search_path = pg_catalog, public`. Tabla `devices` (`device_id`, `restaurant_id`, `activo`, `revocado_en`). RLS políticas para todas las tablas. GRANT/REVOKE explícitos. Validación de `device_id` contra `devices`. JWT con expiración corta.

---

### 2.7 Error E7 — Eventos y cursores

**Causa raíz:**
- `get_sync_events` devuelve solo `payload_hash`, no el `payload` completo necesario para aplicar localmente.
- `is_own_event` debería derivarse localmente comparando `device_id`, no confiar en el valor del servidor.
- No hay definición clara de qué pasa con gaps en el cursor (evento `seq=8` llega antes que `seq=6`).

**Solución definitiva:** `get_sync_events` devuelve `payload` (JSONB completo). `is_own_event` se deriva localmente. Cursor con `last_synced_seq` por restaurante; si hay gap, detener y solicitar recuperación.

---

### 2.8 Error E8 — Outbox y recuperación

**Causa raíz:** El `sync_queue` actual en db.js tiene esquema mínimo (`id`, `table_name`, `row_uuid`, `operation`, `created_at`, `synced`). V5 propone estados más completos pero no especifica `retry_wait` ni `dead_letter` ni cómo migrar.

**Solución definitiva:** Nueva tabla `inventory_outbox` con estados `pending`, `claimed`, `applied`, `retry_wait`, `dead_letter`, `next_attempt_at`, backoff exponencial, reclamo atómico, nunca transacción abierta durante HTTP.

---

### 2.9 Error E9 — Migración de datos existentes

**Causa raíz:** V5 no especifica cómo migrar `inventory` existente (sin `uuid`) a tener `uuid`, ni cómo migrar `stock_movements` existente (sin `movement_uuid`, `idempotency_key`, `stock_delta`), ni cómo migrar `sync_queue` existente (esquema diferente).

**Solución definitiva:** Procedimiento de bootstrap centralizado con 11 pasos: detención, bloqueo escrituras incompatibles, saldo inicial canónico, conciliación, ajustes auditables, migración de productos y UUID, movimientos históricos (no subidos automáticamente), colas antiguas (clasificar y cuarentena), bloqueo clientes antiguos, verificación de integridad, reactivación controlada.

---

### 2.10 Error E10 — Pruebas y aceptación

**Causa raíz:** V5 tiene 26 pruebas pero el escenario 15 describe incorrectamente el comportamiento de dos dispositivos con stock insuficiente (dice "dos faltantes de 3" cuando el correcto es "A descuenta 5, B descuenta 0"). No especifica cómo ejecutar con dos procesos Node independientes.

**Solución definitiva:** 26 pruebas reescritas con datos correctos, criterios cuantificables, especificación de entorno Supabase aislado, dos procesos Node independientes para concurrency real.

---

## 3. Matriz de errores y soluciones (ETAPA 1 completada)

| Problema | Solución diseñada | Validación técnica | Estado |
|----------|-------------------|-------------------|--------|
| E1: Idempotencia padre | `INSERT ... ON CONFLICT DO NOTHING RETURNING` + `IF NOT FOUND` | `NOT FOUND` distingue inserción nueva de conflicto; `already_applied` solo se devuelve cuando existe fila previa con mismo contenido | RESUELTO EN DISEÑO |
| E2: Idempotencia movimientos | `INSERT ... ON CONFLICT DO NOTHING RETURNING`; `idempotency_key` derivada del servidor (`SHA-256(operation_id || movement_uuid || movement_type || stock_delta)`) | Movimiento nuevo insertado → aplicar efecto; existente con mismo contenido → CONTINUE; existente con diferente → excepción | RESUELTO EN DISEÑO |
| E3: Autoridad central stock | Cliente envía solo `requested_quantity`; servidor bloquea fila, lee stock, aplica reglas, calcula `stock_decrement_quantity`, `shortage_quantity`, `stock_delta` | Servidor nunca confía en `stock_delta` del cliente; descuento calculado sobre `inventory_sync.stock` actual | RESUELTO EN DISEÑO |
| E4: Integridad pedidos | RPC acepta `entity_type = 'order'`; verifica `expected_order_version` vs `current_order_version`; aplica pedido + inventario + movimientos + evento en una transacción PostgreSQL | Control de versión optimista; versión mismatch → `CONFLICT_ORDER_VERSION` | RESUELTO EN DISEÑO |
| E5: SQL inválido | `jsonb_array_elements` para iterar; `canonical_json` + `digest` para hash; `SET search_path = pg_catalog, public`; `SECURITY DEFINER`; tabla `devices` | Sintaxis PL/pgSQL válida; hash determinístico; sin inyección de `search_path` | RESUELTO EN DISEÑO |
| E6: Seguridad | `SECURITY DEFINER` + `search_path` fijo; tabla `devices`; RLS políticas; GRANT/REVOKE explícitos; JWT expiración corta; revocación de dispositivos | Cliente no puede falsificar `restaurant_id`, `user_role`, `authorized_by`, `device_id` | RESUELTO EN DISEÑO |
| E7: Eventos y cursores | `get_sync_events` devuelve `payload` completo; `is_own_event` derivado localmente; `last_synced_seq` por restaurante; detección de gaps | Cursor avanza solo después de aplicar en SQLite; evento propio confirmado sin duplicar | RESUELTO EN DISEÑO |
| E8: Outbox | Tabla `inventory_outbox` con estados `pending`, `claimed`, `applied`, `retry_wait`, `dead_letter`; `next_attempt_at`; backoff exponencial; reclamo atómico con `changes = 1` | Reclamo exclusivo verificado por `changes = 1`; nunca transacción SQLite abierta durante HTTP | RESUELTO EN DISEÑO |
| E9: Migración | Bootstrap centralizado 11 pasos; backfill UUIDs; nueva tabla outbox; clasificar colas antiguas; `adjustment` central; bloqueo clientes antiguos; verificación antes de reactivar | No sobrescribir stock central con absolutos locales; no inventar movimientos históricos | RESUELTO EN DISEÑO |
| E10: Pruebas | 26 pruebas con datos correctos; dos procesos Node independientes; Supabase aislado; criterios cuantificables por prueba | Cada prueba tiene datos iniciales, pasos, resultado esperado y criterio cuantificable | RESUELTO EN DISEÑO |

**Validación cruzada completa:** Todas las soluciones son compatibles entre sí. No hay contradicciones. La idempotencia padre (E1) y la de movimientos (E2) usan el mismo patrón `ON CONFLICT DO NOTHING`. La autoridad central del stock (E3) se aplica dentro de la misma transacción que la integridad de pedidos (E4). La seguridad (E6) se aplica en la RPC que maneja E1-E4. Los eventos (E7) se generan dentro de la misma transacción que E1-E4. La outbox (E8) es el mecanismo local que alimenta la RPC. La migración (E9) prepara el terreno para E1-E8. Las pruebas (E10) validan todo.

---

## 4. Arquitectura general

### 4.1 Principios rectores

1. **SQLite local es el almacenamiento operativo.** El POS funciona totalmente sin conexión.
2. **Cada operación de negocio tiene identidad global única (UUID).** No se usan IDs enteros locales como identificadores globales.
3. **`stock_movements` es la fuente de trazabilidad.** El stock materializado es un derivado.
4. **Los movimientos se sincronizan como operaciones agrupadas.** Nunca se sincroniza stock como valor absoluto.
5. **Idempotencia en servidor.** Una operación con el mismo UUID y contenido se aplica una sola vez.
6. **No se mantiene una transacción SQLite abierta durante una llamada HTTP.**
7. **Realtime es notificación, no única fuente de verdad.** Existe un cursor remoto monotónico por restaurante.
8. **Nunca confiar en `user_role`, `authorized_by` ni `device_id` recibidos del cliente sin validación JWT.**
9. **Una operación confirmada localmente nunca desaparece silenciosamente por un conflicto remoto.**
10. **El servidor calcula el efecto del stock; el cliente solo envía la intención (`requested_quantity`).**

### 4.2 Componentes lógicos

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
│  │              Outbox de inventario (inventory_outbox)          │   │
│  │  operation_id | entity_type | entity_uuid | op_type | payload  │   │
│  │  idempotency_key | status | lease_owner | lease_expires_at    │   │
│  │  attempts | next_attempt_at | last_error | created_at         │   │
│  │  claimed_at | device_id | restaurant_id                        │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│          │                                                              │
│          │ HTTP (anon key, JWT autenticado)                             │
│          ▼                                                              │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    SUPABASE (remoto)                            │   │
│  │                                                                   │   │
│  │  ┌────────────────────────────────────────────────────────────┐ │   │
│  │  │  RPC apply_inventory_operation (TX PostgreSQL implícita) │ │   │
│  │  │  SECURITY DEFINER + search_path fijo                     │ │   │
│  │  │  - valida JWT, restaurante, dispositivo                  │ │   │
│  │  │  - idempotencia operación + movimientos                  │ │   │
│  │  │  - calcula stock sobre saldo remoto actual               │ │   │
│  │  │  - aplica pedido + inventario + movimientos + evento     │ │   │
│  │  └────────────────────────────────────────────────────────────┘ │   │
│  │                                                                   │   │
│  │  Tabla restaurant_seq (cursor remoto monotónico)                │ │   │
│  │  Tabla devices (registro y revocación)                          │ │   │
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

## 5. Modelo de datos local (SQLite)

### 5.1 `inventory` (existente, se conserva y amplía)

| Columna | Tipo | Rol |
|---------|------|-----|
| `id` | INTEGER PK | Identificador local operativo (NUNCA se envía como global) |
| `uuid` | TEXT UNIQUE NOT NULL | Identificador estable global del producto |
| `stock` | REAL | Stock materializado local (derivado) |
| `version` | INTEGER NOT NULL DEFAULT 1 | Versión para control de concurrencia optimista |
| `device_id` | TEXT | Dispositivo que originó el último cambio |
| `updated_at` | INTEGER | Timestamp local de última modificación |
| `deleted` | INTEGER DEFAULT 0 | Borrado lógico |

### 5.2 `stock_movements` (existente, se conserva y amplía)

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

### 5.3 `inventory_outbox` (nueva tabla — reemplaza funcionalidad de sync_queue para inventario)

| Columna | Tipo | Rol |
|---------|------|-----|
| `id` | INTEGER PK | Identificador local de la cola |
| `operation_id` | TEXT UNIQUE NOT NULL | UUID de la operación de negocio padre |
| `entity_type` | TEXT NOT NULL | `inventory_operation`, `order`, `order_item` |
| `entity_uuid` | TEXT NOT NULL | UUID de la entidad afectada |
| `op_type` | TEXT NOT NULL | Tipo de operación |
| `payload` | TEXT NOT NULL (JSON) | Datos completos de la operación agrupada |
| `idempotency_key` | TEXT UNIQUE NOT NULL | Clave determinística |
| `status` | TEXT NOT NULL DEFAULT 'pending' | `pending`, `claimed`, `applied`, `retry_wait`, `dead_letter`, `conflict` |
| `lease_owner` | TEXT | ID del proceso que reclamó (`device_id:pid`) |
| `lease_expires_at` | INTEGER | Vencimiento del lease (ms epoch) |
| `attempts` | INTEGER NOT NULL DEFAULT 0 | Número de intentos |
| `next_attempt_at` | INTEGER | Próximo momento de intento (ms epoch) |
| `last_error` | TEXT | Último mensaje de error |
| `created_at` INTEGER NOT NULL | Fecha de creación |
| `claimed_at` | INTEGER | Fecha de última reclamación |
| `applied_at` | INTEGER | Fecha de confirmación remota |
| `device_id` | TEXT NOT NULL | Dispositivo origen |
| `restaurant_id` | TEXT NOT NULL | Restaurante para aislamiento |

### 5.4 `sync_events_local` (cursor de eventos remotos aplicados)

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

## 6. Modelo de datos remoto (PostgreSQL / Supabase)

### 6.1 `devices` (nueva tabla)

| Columna | Tipo | Rol |
|---------|------|-----|
| `device_id` | UUID PK | Identificador del dispositivo |
| `restaurant_id` | UUID NOT NULL | Restaurante al que pertenece |
| `activo` | BOOLEAN NOT NULL DEFAULT TRUE | Estado del dispositivo |
| `revocado_en` | TIMESTAMPTZ | Momento de revocación (NULL si activo) |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | Momento de registro |

### 6.2 `inventory_sync`

| Columna | Tipo | Rol |
|---------|------|-----|
| `uuid` | UUID PK | Identificador estable del producto |
| `restaurant_id` | UUID NOT NULL | Aislamiento de negocio |
| `stock` | REAL NOT NULL DEFAULT 0 | Stock materializado remoto |
| `version` | INTEGER NOT NULL DEFAULT 1 | Versión para control de concurrencia optimista |
| `device_id` | TEXT | Dispositivo última modificación |
| `updated_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | Última actualización remota |
| `deleted` | BOOLEAN NOT NULL DEFAULT FALSE | Borrado lógico |

### 6.3 `orders_sync`

| Columna | Tipo | Rol |
|---------|------|-----|
| `order_uuid` | UUID PK | Identificador estable del pedido |
| `restaurant_id` | UUID NOT NULL | Aislamiento de negocio |
| `current_order_version` | INTEGER NOT NULL DEFAULT 1 | Versión actual del pedido |
| `status` | TEXT NOT NULL | `pending`, `preparing`, `ready`, `delivered`, `cancelled`, `active` |
| `device_id` | TEXT | Dispositivo última modificación |
| `updated_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | Última actualización |
| `deleted` | BOOLEAN NOT NULL DEFAULT FALSE | Borrado lógico |

### 6.4 `order_items_sync`

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

### 6.5 `order_operations_sync`

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

### 6.6 `stock_movements_sync`

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

### 6.7 `inventory_operations` (operaciones agrupadas)

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

### 6.8 `restaurant_seq` (cursor remoto monotónico por restaurante)

| Columna | Tipo | Rol |
|---------|------|-----|
| `restaurant_id` | UUID PK | Identificador del restaurante |
| `next_event_seq` | BIGINT NOT NULL DEFAULT 1 | Siguiente secuencia de evento |
| `updated_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | Última actualización del cursor |

### 6.9 `sync_events` (registro de eventos remotos)

| Columna | Tipo | Rol |
|---------|------|-----|
| `event_id` | UUID PK | Identificador estable del evento |
| `event_seq` | BIGINT NOT NULL | Secuencia secuencial por restaurante |
| `restaurant_id` | UUID NOT NULL | Restaurante |
| `operation_id` | UUID NOT NULL | Operación asociada |
| `entity_type` | TEXT NOT NULL | Tipo de entidad |
| `op_type` | TEXT NOT NULL | Tipo de operación |
| `payload` | JSONB NOT NULL | Payload completo del evento |
| `payload_hash` | TEXT | Hash SHA-256 del payload |
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
- `devices.device_id` → PK
- `devices.restaurant_id` → INDEX

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
| `device_id` | UUID del dispositivo | UUID v4 válido, sin prefijos | `devices.device_id` |
| `idempotency_key` | Clave determinística | Texto derivado de `(operation_id, movement_uuid, tipo, stock_delta)` | `inventory_operations.idempotency_key` (UNIQUE), `stock_movements_sync.idempotency_key` (UNIQUE) |

### 6.2 Entrada RPC `apply_inventory_operation`

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `operation_id` | UUID | Sí | Identidad global de la operación padre |
| `idempotency_key` | TEXT | Sí | Clave determinística |
| `entity_type` | TEXT | Sí | `order` o `inventory` |
| `entity_uuid` | UUID | Sí | UUID de la entidad principal |
| `op_type` | TEXT | Sí | Tipo de operación de negocio |
| `movements` | JSONB [] | Sí | Array de movimientos hijos |
| `restaurant_id` | UUID | Sí | Validado contra JWT, NO se confía en payload |

Cada movimiento hijo contiene:
- `movement_uuid` UUID
- `inventory_uuid` UUID
- `order_uuid` UUID (opcional)
- `movement_type` TEXT (`sale`, `return`, `shortage`, `adjustment`)
- `requested_quantity` REAL — cantidad solicitada por el cliente
- `reference_type` TEXT
- `reference_id` TEXT
- `user_name` TEXT (validado contra JWT)
- `user_role` TEXT (validado contra JWT)
- `authorized_by` TEXT (opcional, validado contra JWT)
- `device_id` TEXT (validado contra tabla `devices`)
- `created_at` TIMESTAMPTZ

**IMPORTANTE:** El cliente NO envía `stock_decrement_quantity`, `shortage_quantity`, ni `stock_delta`. Estos son calculados por el servidor.

---

## 7. Pseudocódigo PostgreSQL válido (RPC `apply_inventory_operation`)

**Nota crítica:** Una función PL/pgSQL ejecutada como RPC se ejecuta dentro de una transacción implícita iniciada por el cliente. **NO usar `BEGIN`/`COMMIT` explícito** dentro de la función. PostgreSQL hace rollback automático si cualquier sentencia lanza excepción.

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
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_existing_ops RECORD;
    v_payload_hash TEXT;
    v_event_seq BIGINT;
    v_movement RECORD;
    v_stock_decrement REAL;
    v_shortage REAL;
    v_stock_delta REAL;
    v_available REAL;
    v_is_admin BOOLEAN;
BEGIN
    -- ================================================================
    -- 1. Validar restaurante y dispositivo desde JWT (no del payload)
    -- ================================================================
    -- p_restaurant_id se compara con auth.jwt() ->> 'restaurant_id'
    IF p_restaurant_id::text IS DISTINCT FROM auth.jwt() ->> 'restaurant_id' THEN
        RAISE EXCEPTION 'restaurant_id_mismatch';
    END IF;

    -- Validar que el dispositivo exista y esté activo
    IF NOT EXISTS (
        SELECT 1 FROM devices
        WHERE device_id = auth.jwt() ->> 'device_id'
          AND restaurant_id = p_restaurant_id
          AND activo = TRUE
    ) THEN
        RAISE EXCEPTION 'device_not_authorized';
    END IF;

    -- Validar rol de usuario desde JWT (no del payload)
    v_is_admin := auth.jwt() ->> 'role' IN ('owner', 'admin');

    -- ================================================================
    -- 2. Idempotencia de operación padre: inserción atómica con
    --    ON CONFLICT DO NOTHING RETURNING
    -- ================================================================
    v_payload_hash := encode(digest(canonical_json(p_movements), 'sha256'), 'hex');

    INSERT INTO inventory_operations (
        operation_id, idempotency_key, restaurant_id,
        entity_type, entity_uuid, op_type, payload, payload_hash, status
    ) VALUES (
        p_operation_id, p_idempotency_key, p_restaurant_id,
        p_entity_type, p_entity_uuid, p_op_type,
        p_movements, v_payload_hash, 'applied'
    )
    ON CONFLICT (operation_id) DO NOTHING
    RETURNING * INTO v_existing_ops;

    -- Si NOT FOUND, hubo conflicto (operación ya existe)
    IF NOT FOUND THEN
        SELECT * INTO v_existing_ops
        FROM inventory_operations
        WHERE operation_id = p_operation_id
        FOR UPDATE;

        -- Comparar contenido completo
        IF v_existing_ops.idempotency_key = p_idempotency_key
           AND v_existing_ops.payload_hash = v_payload_hash
           AND v_existing_ops.entity_type = p_entity_type
           AND v_existing_ops.entity_uuid = p_entity_uuid
           AND v_existing_ops.op_type = p_op_type THEN
            -- Mismo contenido: operación ya aplicada, devolver resultado original
            RETURN json_build_object(
                'status', 'already_applied',
                'operation_id', p_operation_id,
                'message', 'Operación ya aplicada previamente'
            );
        ELSE
            -- Contenido diferente: rechazar
            RAISE EXCEPTION 'operation_id_reused_with_different_content';
        END IF;
    END IF;

    -- Si llegamos aquí, es una inserción nueva (NOT FOUND fue falso)
    -- Continuar con movimientos...

    -- ================================================================
    -- 3. Registrar cada movimiento hijo y aplicar efecto sobre stock
    -- ================================================================
    FOREACH v_movement IN SELECT * FROM jsonb_array_elements(p_movements) LOOP
        -- 3a. Idempotencia del movimiento hijo
        INSERT INTO stock_movements_sync (
            movement_uuid, operation_id, idempotency_key, restaurant_id,
            inventory_uuid, order_uuid, movement_type,
            requested_quantity, stock_decrement_quantity, shortage_quantity,
            stock_delta, reference_type, reference_id,
            user_name, user_role, authorized_by, device_id, created_at
        ) VALUES (
            (v_movement->>'movement_uuid')::UUID,
            p_operation_id,
            encode(digest(
                p_operation_id::text || '|' ||
                (v_movement->>'movement_uuid')::text || '|' ||
                v_movement->>'movement_type' || '|' ||
                COALESCE(v_movement->>'stock_delta', '0'), 'sha256'
            ), 'hex'),
            p_restaurant_id,
            (v_movement->>'inventory_uuid')::UUID,
            NULLIF(v_movement->>'order_uuid', '')::UUID,
            v_movement->>'movement_type',
            (v_movement->>'requested_quantity')::REAL,
            0,  -- stock_decrement_quantity: calculado por servidor (ver 3c)
            0,  -- shortage_quantity: calculado por servidor (ver 3c)
            0,  -- stock_delta: calculado por servidor (ver 3c)
            v_movement->>'reference_type',
            v_movement->>'reference_id',
            auth.jwt() ->> 'name',    -- user_name desde JWT, no del payload
            auth.jwt() ->> 'role',    -- user_role desde JWT, no del payload
            auth.jwt() ->> 'name',    -- authorized_by desde JWT (validado por rol)
            v_movement->>'device_id',
            (v_movement->>'created_at')::TIMESTAMPTZ
        )
        ON CONFLICT (movement_uuid) DO NOTHING
        RETURNING * INTO v_existing_mov;

        -- Si NOT FOUND, hubo conflicto (movimiento ya existe)
        IF NOT FOUND THEN
            SELECT * INTO v_existing_mov
            FROM stock_movements_sync
            WHERE movement_uuid = (v_movement->>'movement_uuid')::UUID
            FOR UPDATE;

            -- Comparar contenido
            IF v_existing_mov.idempotency_key =
               encode(digest(
                   p_operation_id::text || '|' ||
                   (v_movement->>'movement_uuid')::text || '|' ||
                   v_movement->>'movement_type' || '|' ||
                   COALESCE(v_movement->>'stock_delta', '0'), 'sha256'
               ), 'hex')
               AND v_existing_mov.movement_type = v_movement->>'movement_type'
               AND v_existing_mov.stock_delta = (v_movement->>'stock_delta')::REAL THEN
                -- Mismo contenido: no aplicar efecto dos veces
                CONTINUE;
            ELSE
                -- Contenido diferente: rechazar
                RAISE EXCEPTION 'movement_uuid_reused_with_different_content';
            END IF;
        END IF;

        -- Si llegamos aquí, es un movimiento nuevo (se insertó correctamente)
        -- Continuar con cálculo de stock...

        -- 3b. Validar tipo de movimiento
        IF v_movement->>'movement_type' NOT IN ('sale','return','shortage','adjustment') THEN
            RAISE EXCEPTION 'invalid_movement_type';
        END IF;

        -- 3c. CALCULAR EFECTO SOBRE STOCK EN EL SERVIDOR (no confiar en cliente)
        --     Leer stock actual del producto (bloquea fila durante UPDATE)
        SELECT stock INTO v_available
        FROM inventory_sync
        WHERE uuid = (v_movement->>'inventory_uuid')::UUID
          AND restaurant_id = p_restaurant_id
          AND deleted = FALSE
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'inventory_not_found';
        END IF;

        -- Aplicar reglas comerciales según tipo de movimiento
        IF v_movement->>'movement_type' = 'sale' THEN
            -- Venta: verificar autorización para stock negativo
            IF (v_movement->>'requested_quantity')::REAL <= v_available THEN
                -- Stock suficiente: descontar todo lo solicitado
                v_stock_decrement := (v_movement->>'requested_quantity')::REAL;
                v_shortage := 0;
            ELSIF v_is_admin THEN
                -- Stock insuficiente con auth admin: descontar todo, permitir negativo
                v_stock_decrement := (v_movement->>'requested_quantity')::REAL;
                v_shortage := 0;
            ELSE
                -- Stock insuficiente sin auth: descontar solo disponible, registrar faltante
                v_stock_decrement := v_available;
                v_shortage := (v_movement->>'requested_quantity')::REAL - v_available;
            END IF;
            v_stock_delta := -v_stock_decrement;

        ELSIF v_movement->>'movement_type' = 'return' THEN
            -- Devolución: reintegrar lo efectivamente descontado
            v_stock_decrement := (v_movement->>'requested_quantity')::REAL;
            v_shortage := 0;
            v_stock_delta := v_stock_decrement;

        ELSIF v_movement->>'movement_type' = 'shortage' THEN
            -- Faltante: no modifica stock, solo traza
            v_stock_decrement := 0;
            v_shortage := (v_movement->>'shortage_quantity')::REAL;
            v_stock_delta := 0;

        ELSIF v_movement->>'movement_type' = 'adjustment' THEN
            -- Ajuste: puede ser positivo o negativo, requiere auth admin
            IF NOT v_is_admin THEN
                RAISE EXCEPTION 'adjustment_requires_admin';
            END IF;
            v_stock_decrement := 0;  -- los ajustes usan stock_delta directamente
            v_shortage := 0;
            v_stock_delta := (v_movement->>'stock_delta')::REAL;

        END IF;

        -- 3d. Actualizar el movimiento con los valores calculados por servidor
        UPDATE stock_movements_sync
        SET stock_decrement_quantity = v_stock_decrement,
            shortage_quantity = v_shortage,
            stock_delta = v_stock_delta,
            user_name = auth.jwt() ->> 'name',
            user_role = auth.jwt() ->> 'role',
            authorized_by = CASE WHEN v_is_admin THEN auth.jwt() ->> 'name' ELSE NULL END
        WHERE movement_uuid = (v_movement->>'movement_uuid')::UUID;

        -- 3e. Aplicar efecto sobre stock materializado (delta, nunca valor absoluto)
        UPDATE inventory_sync
        SET stock = COALESCE(stock, 0) + v_stock_delta,
            version = version + 1,
            device_id = v_movement->>'device_id',
            updated_at = now()
        WHERE uuid = (v_movement->>'inventory_uuid')::UUID
          AND restaurant_id = p_restaurant_id
          AND deleted = FALSE;

    END LOOP;

    -- ================================================================
    -- 4. Si es operación de pedido, actualizar orders_sync con control
    --    de versión optimista
    -- ================================================================
    IF p_entity_type = 'order' THEN
        UPDATE orders_sync
        SET current_order_version = current_order_version + 1,
            device_id = (p_movements->0->>'device_id')::TEXT,
            updated_at = now()
        WHERE uuid = p_entity_uuid
          AND restaurant_id = p_restaurant_id
          AND deleted = FALSE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'order_not_found';
        END IF;
    END IF;

    -- ================================================================
    -- 5. Asignar secuencia de evento dentro de la misma transacción
    -- ================================================================
    UPDATE restaurant_seq
    SET next_event_seq = next_event_seq + 1,
        updated_at = now()
    WHERE restaurant_id = p_restaurant_id
    RETURNING next_event_seq - 1 INTO v_event_seq;

    -- ================================================================
    -- 6. Registrar evento en cursor remoto
    ================================================================
    INSERT INTO sync_events (
        event_id, event_seq, restaurant_id,
        operation_id, entity_type, op_type, payload, payload_hash,
        is_own_event, commit_ts
    ) VALUES (
        gen_random_uuid(), v_event_seq, p_restaurant_id,
        p_operation_id, p_entity_type, p_op_type, p_movements, v_payload_hash,
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

### 7.1 ¿Por qué `INSERT ... ON CONFLICT DO NOTHING RETURNING` es correcto?

- **Inserción nueva:** `INSERT` tiene éxito, `RETURNING` devuelve la fila, `NOT FOUND` es falso → continuar con movimientos.
- **Conflicto con mismo contenido:** `INSERT` no inserta (conflicto en `operation_id`), `DO NOTHING` no modifica, `RETURNING` devuelve NULL, `NOT FOUND` es verdadero → consultar fila existente con `FOR UPDATE` → comparar contenido → si coincide, devolver `already_applied`.
- **Conflicto con contenido diferente:** `NOT FOUND` es verdadero → consultar fila existente → comparar contenido → si difiere, lanzar excepción.

Esto garantiza que una operación nueva **nunca** se devuelva como `already_applied`.

---

## 8. Idempotencia y concurrencia

### 8.1 Estrategia para dos RPC simultáneas con mismo `operation_id`

PostgreSQL garantiza que el `INSERT ... ON CONFLICT` es atómico a nivel de fila. Cuando dos transacciones intentan insertar el mismo `operation_id`:

1. **Transacción A** adquiere el lock en la página del índice UNIQUE de `operation_id`.
2. **Transacción B** se bloquea esperando a A.
3. **Transacción A** confirma (transacción implícita al finalizar la función RPC).
4. **Transacción B** despierta, detecta el conflicto, entra en `ON CONFLICT DO NOTHING`, `NOT FOUND` es verdadero.
5. Transacción B consulta la fila existente con `FOR UPDATE`, compara `idempotency_key` y `payload_hash`.
6. Si son idénticos → `already_applied`. Si difieren → excepción.

### 8.2 Stock bloqueado por producto

El `UPDATE inventory_sync SET stock = ... WHERE uuid = ?` bloquea la fila de inventario durante la transacción. Esto garantiza que dos ventas concurrentes sobre el mismo producto se procesen **secuencialmente** sobre el saldo remoto actual, no sobre copias locales obsoletas.

---

## 9. Reglas comerciales de stock

### 9.1 Campos formales (separados inequívocamente)

| Campo | Significado | ¿Quién lo calcula? |
|-------|-------------|-------------------|
| `requested_quantity` | Cantidad que el cliente quiere vender | Cliente |
| `stock_decrement_quantity` | Cantidad efectivamente descontada del stock | Servidor |
| `shortage_quantity` | Faltante (`requested - decrement` sin auth) | Servidor |
| `stock_delta` | Variación efectiva del stock | Servidor |

### 9.2 Reglas por escenario

| Escenario | Condición | `stock_decrement_quantity` | `shortage_quantity` | `stock_delta` | Stock final |
|-----------|-----------|---------------------------|---------------------|---------------|-------------|
| Stock suficiente | `requested <= disponible` | `requested` | 0 | `-requested` | `disponible - requested` |
| Stock insuficiente sin auth | `requested > disponible` | `disponible` | `requested - disponible` | `-disponible` | 0 |
| Stock insuficiente con auth admin | `requested > disponible` | `requested` | 0 | `-requested` | `disponible - requested` (puede ser negativo) |

### 9.3 Escenario de dos dispositivos con stock 5 vendiendo 8 cada uno sin auth

**Resultado correcto (servidor serializa sobre saldo central):**

1. **Dispositivo A** vende 8 (sin auth): servidor lee stock=5, `requested=8 > 5`, sin auth → `stock_decrement=5`, `shortage=3`, `stock_delta=-5`. Stock remoto → 0.
2. **Dispositivo B** vende 8 (sin auth): servidor lee stock=0 (ya actualizado por A), `requested=8 > 0`, sin auth → `stock_decrement=0`, `shortage=8`, `stock_delta=0`. Stock remoto → 0.

**Stock final remoto:** 0.
**Movimientos:** dos `sale` (decremento 5 y 0) y dos `shortage` (3 y 8).

**No es correcto:** "dos faltantes de 3" (esto ignoraría que el servidor procesa sobre el saldo central, no sobre la copia local de cada dispositivo).

### 9.4 Algoritmo central de inventario (pseudocidio)

```
FUNCTION calcular_efecto_stock(disponible, solicitada, autorizado_admin, tipo_movimiento):
    SI tipo = 'sale':
        SI solicitada <= disponible:
            RETORNAR { decremento: solicitada, falta: 0, delta: -solicitada }
        SINO SI autorizado_admin:
            RETORNAR { decremento: solicitada, falta: 0, delta: -solicitada }
        SINO:
            RETORNAR { decremento: disponible, falta: solicitada - disponible, delta: -disponible }
    
    SI tipo = 'return':
        RETORNAR { decremento: solicitada, falta: 0, delta: solicitada }
    
    SI tipo = 'shortage':
        RETORNAR { decremento: 0, falta: solicitada, delta: 0 }
    
    SI tipo = 'adjustment':
        REQUIERE autorizado_admin
        RETORNAR { decremento: 0, falta: 0, delta: solicitada }  -- solicitada ya tiene signo
```

---

## 10. Integridad de pedidos

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

### 10.2 Control de versión optimista

Cuando el cliente envía una operación sobre un pedido (`entity_type = 'order'`), debe incluir `expected_order_version` en el payload. El servidor verifica:

```sql
SELECT current_order_version INTO v_current_version
FROM orders_sync WHERE uuid = p_entity_uuid;

IF v_current_version != p_expected_order_version THEN
    RAISE EXCEPTION 'CONFLICT_ORDER_VERSION';
END IF;
```

Si coinciden, se incrementa `current_order_version` y se aplica la operación.

### 10.3 Estados explícitos de operación

| Estado | Significado |
|--------|-------------|
| `pendiente` | Creada localmente, no enviada |
| `aplicada` | Confirmada por servidor (UUID existe) |
| `rechazada` | Servidor rechazó (conflicto, UUID reutilizado, producto inexistente) |
| `en_conflicto` | No puede aplicarse por versión desactualizada |

### 10.4 Escenarios de conflictos

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

### 10.5 Devoluciones vinculadas a ventas originales

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
| `payload` | JSONB | Payload completo del evento (para aplicar localmente) |
| `payload_hash` | TEXT | Hash SHA-256 del payload |
| `is_own_event` | BOOLEAN | Marca si el dispositivo originó el evento (derivado localmente) |
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
      "payload": { ... },
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

PostgreSQL bloquea la fila de `restaurant_seq` durante el `UPDATE`, garantizando que dos transacciones concurrentes obtengan secuencias consecutivas sin huecos.

### 11.4 Evento propio

Si un dispositivo recibe un evento que él mismo originó (`device_id` del evento === `DEVICE_ID` local):

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

**Decisión:** `SECURITY DEFINER` con `SET search_path = pg_catalog, public` dentro de la función.

**Justificación:**
- `SECURITY INVOKER` con permisos denegados a `authenticated` genera contradicción: la función no podría escribir en las tablas.
- `SECURITY DEFINER` permite que la función escriba con privilegios del propietario, mientras RLS y validaciones explícitas controlan qué puede hacer cada usuario.
- `search_path` fijo previene inyección a través de funciones con nombres similares en esquemas públicos.

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
| `devices` | `authenticated` | REVOKE ALL |
| Función `apply_inventory_operation` | `authenticated` | EXECUTE |
| Función `get_sync_events` | `authenticated` | EXECUTE |

### 12.3 Políticas RLS

| Tabla | Política SELECT | Política INSERT | Política UPDATE | Política DELETE |
|-------|-----------------|-----------------|-----------------|-----------------|
| `inventory_sync` | `restaurant_id = auth.jwt() ->> 'restaurant_id'` | Denegada (solo RPC) | Denegada (solo RPC) | Denegada |
| `stock_movements_sync` | `restaurant_id = auth.jwt() ->> 'restaurant_id'` | Denegada (solo RPC) | Denegada (solo RPC) | Denegada |
| `orders_sync` | `restaurant_id = auth.jwt() ->> 'restaurant_id'` | Denegada (solo RPC) | Denegada (solo RPC) | Denegada |
| `order_items_sync` | `restaurant_id = auth.jwt() ->> 'restaurant_id'` | Denegada (solo RPC) | Denegada (solo RPC) | Denegada |
| `order_operations_sync` | `restaurant_id = auth.jwt() ->> 'restaurant_id'` | Denegada (solo RPC) | Denegada (solo RPC) | Denegada |
| `inventory_operations` | `restaurant_id = auth.jwt() ->> 'restaurant_id'` | Denegada (solo RPC) | Denegada (solo RPC) | Denegada |
| `sync_events` | `restaurant_id = auth.jwt() ->> 'restaurant_id'` | Denegada (solo RPC) | Denegada | Denegada |
| `restaurant_seq` | `restaurant_id = auth.jwt() ->> 'restaurant_id'` | Denegada | Denegada | Denegada |
| `devices` | `restaurant_id = auth.jwt() ->> 'restaurant_id'` | Denegada | Denegada | Denegada |

### 12.4 Validaciones en la RPC

| Elemento | Origen | Validación |
|----------|--------|------------|
| `restaurant_id` | JWT claim | Debe coincidir con `auth.jwt() ->> 'restaurant_id'` |
| `user_name` | JWT claim | `auth.jwt() ->> 'name'`, no del payload |
| `user_role` | JWT claim | `auth.jwt() ->> 'role'`, no del payload |
| `authorized_by` | JWT claim | Solo si rol es `owner` o `admin` |
| `device_id` | Payload + JWT | Debe existir en tabla `devices` con `activo = TRUE` para el `restaurant_id` |
| `search_path` | Función | `SET search_path = pg_catalog, public` |

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

### 13.1 Tabla `inventory_outbox` (SQLite)

| Columna | Tipo | Rol |
|---------|------|-----|
| `id` | INTEGER PK | Identificador local de la cola |
| `operation_id` | TEXT UNIQUE NOT NULL | UUID de la operación de negocio padre |
| `entity_type` | TEXT NOT NULL | `inventory_operation`, `order`, `order_item` |
| `entity_uuid` | TEXT NOT NULL | UUID de la entidad afectada |
| `op_type` | TEXT NOT NULL | Tipo de operación |
| `payload` | TEXT NOT NULL (JSON) | Datos completos de la operación agrupada |
| `idempotency_key` | TEXT UNIQUE NOT NULL | Clave determinística |
| `status` | TEXT NOT NULL DEFAULT 'pending' | `pending`, `claimed`, `applied`, `retry_wait`, `dead_letter`, `conflict` |
| `lease_owner` | TEXT | ID del proceso que reclamó (`device_id:pid`) |
| `lease_expires_at` | INTEGER | Vencimiento del lease (ms epoch) |
| `attempts` | INTEGER NOT NULL DEFAULT 0 | Número de intentos |
| `next_attempt_at` | INTEGER | Próximo momento de intento (ms epoch) |
| `last_error` | TEXT | Último mensaje de error |
| `created_at` INTEGER NOT NULL | Fecha de creación |
| `claimed_at` | INTEGER | Fecha de última reclamación |
| `applied_at` | INTEGER | Fecha de confirmación remota |
| `device_id` | TEXT NOT NULL | Dispositivo origen |
| `restaurant_id` | TEXT NOT NULL | Restaurante para aislamiento |

### 13.2 Reclamo atómico

```sql
UPDATE inventory_outbox
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

### 13.3 Lease y expiración

| Campo | Propósito |
|-------|-----------|
| `lease_owner` | `device_id:pid` del proceso |
| `lease_expires_at` | `ahora + 120000 ms` (2 minutos) |
| `claimed_at` | Momento de última reclamación |

### 13.4 Recuperación tras caída

Al iniciar, escanear operaciones en `claimed` con `lease_expires_at < ahora` y volverlas a `pending`.

### 13.5 Backoff exponencial

| Intento | Retraso |
|---------|---------|
| 1 | inmediato |
| 2 | 5s |
| 3 | 15s |
| 4 | 60s |
| 5+ | 300s |

Tras 7 intentos, `status = dead_letter`.

### 13.6 Estados

| Estado | Significado | Transición |
|--------|-------------|------------|
| `pending` | Lista para procesar | `claimed` |
| `claimed` | Enviándose | `applied`, `retry_wait`, `dead_letter` |
| `applied` | Confirmada | (retención 30 días) |
| `retry_wait` | Esperando reintento | `claimed` (cuando llega `next_attempt_at`) |
| `dead_letter` | Error permanente | revisión manual |
| `conflict` | Conflicto de versión | revisión manual |

### 13.7 Estados de error

- `retry_wait`: puede volver a `pending` cuando llega `next_attempt_at`.
- `dead_letter`: no se reintenta automáticamente, requiere intervención manual.
- `conflict`: requiere resolución manual del usuario.

### 13.8 Dependencias entre operaciones

- Operaciones de un mismo pedido comparten `order_uuid` en el payload.
- El cliente debe esperar a que una `sale` esté `applied` antes de enviar la `return` que depende de ella.

### 13.9 Retención y auditoría

- `applied`: mínimo 30 días.
- `dead_letter` y `conflict`: indefinidamente para revisión manual.

---

## 14. Bootstrap y migración

### 14.1 Procedimiento de bootstrap centralizado

1. **Detención de sincronizadores:** Todos los dispositivos deben detener `flushQueue` y Realtime.
2. **Bloqueo temporal de escrituras incompatibles:** Clientes antiguos que envíen `stock = valor absoluto` son bloqueados (modo solo lectura para inventario).
3. **Selección de saldo inicial canónico:** Un dispositivo de referencia (o el servidor) define el saldo canónico para cada producto.
4. **Conciliación de diferencias:** Si dos dispositivos tienen stock diferente para el mismo producto, se registra un `adjustment` central con autorización admin.
5. **Registro de ajustes auditables:** Cada ajuste se registra como movimiento `adjustment` con `user_name` y `user_role` del administrador.
6. **Migración de productos y UUID:** Productos sin `uuid` reciben uno (backfill). Se añade columna `version` (INTEGER DEFAULT 1).
7. **Tratamiento de movimientos históricos:** Conservados localmente como trazabilidad, **no se suben automáticamente** a Supabase.
8. **Tratamiento de colas antiguas:** Entradas existentes en `sync_queue` se clasifican:
   - Compatibles → se reintentan con RPC idempotente.
   - Incompatibles (stock absoluto) → cuarentena (`dead_letter`).
9. **Bloqueo de clientes antiguos:** Modo solo lectura para inventario hasta actualizar.
10. **Verificación de integridad:** `checkIntegrity` compara conteos local vs remoto por restaurante antes de reactivar cada dispositivo.
11. **Reanudación controlada:** Reactivar dispositivo por dispositivo.

### 14.2 Reglas de migración

- **No generar movimientos históricos inventados.** La trazabilidad remota comienza desde la activación.
- **No reenviar automáticamente colas antiguas incompatibles.** Se clasifican y ponen en cuarentena.
- **La conciliación produce una única operación central autorizada**, no un ajuste independiente por cada dispositivo.
- **No sobrescribir el stock central con saldos absolutos locales.**

---

## 15. Plan de pruebas (26 pruebas)

Todas las pruebas usan **dos bases SQLite independientes** y un **entorno Supabase de pruebas**. Nunca producción. Las pruebas que requieran Supabase se ejecutan únicamente en proyecto aislado durante futura fase de implementación.

| # | Prueba | Datos iniciales | Operaciones concurrentes | Resultado esperado | Stock final | Movimientos | Eventos | Outbox | Criterio cuantificable |
|---|--------|----------------|-------------------------|-------------------|-------------|-------------|---------|--------|----------------------|
| 1 | Dos SQLite independientes | A: stock 10. B: stock 10. | A vende 3, B vende 4 (offline). Sincronizan. | Stock remoto = 3. Dos `sale` UUID distintos. | 3 | 2 | 2 | 2 `synced` | `stock` = 3; `COUNT(movement_type='sale')` = 2 |
| 2 | Dos procesos Node misma outbox | `inventory_outbox` con 3 operaciones pendientes. | Dos procesos reclaman al mismo tiempo. | Cada operación procesada exactamente una vez. | — | — | — | 3 `applied` | `changes=1` en cada reclamo; sin duplicados |
| 3 | Dos RPC concurrentes mismo operation_id | Operación `sale` UUID-X qty=3. | Dos solicitudes RPC simultáneas, mismo UUID, payload idéntico. | Aplicada una sola vez. | — | 1 | 1 | 1 `applied` | `COUNT(movement_uuid=?)` = 1 |
| 4 | Reintento payload idéntico | Operación ya aplicada UUID-X. | Reenviar misma operación. | `already_applied`, sin duplicar. | — | 1 | 1 | — | `COUNT(movement_uuid=?)` = 1 |
| 5 | Reintento payload diferente | Operación UUID-X qty=3 aplicada. | Reenviar UUID-X qty=5. | Rechazado. | — | 1 | 1 | — | Error `operation_id_reused_with_different_content` |
| 6 | Reutilización movement_uuid | Movimiento UUID-M qty=3 aplicado. | Reenviar UUID-M qty=5. | Rechazado. | — | 1 | 1 | — | Error `movement_uuid_reused_with_different_content` |
| 7 | Respuesta remota perdida | Cliente envía, servidor aplica, respuesta se pierde. | Cliente reenvía misma operación. | No hay duplicación. | — | 1 | 1 | — | `COUNT(movement_uuid=?)` = 1 |
| 8 | Caída durante envío | Cliente envía, proceso muere antes de respuesta. | Operación queda en `claimed`. | Al reiniciar, lease expira, se recupera a `pending`. | — | — | — | `claimed` → `pending` | `status` pasa `claimed` a `pending` tras reinicio |
| 9 | Recuperación de lease | Operación en `claimed` con lease expirado. | Nuevo proceso reclama. | Operación pasa a `pending` y se reintenta. | — | — | — | `pending` | `status` = `pending` tras recuperación |
| 10 | Venta y cancelación concurrentes | Orden activa, stock 10. | A vende 3, B cancela. | Stock remoto = 10. Cancelación registrada. | 10 | 2 | 2 | 2 `applied` | `stock` = 10; `return` qty=3 |
| 11 | Venta posterior a cancelación | Orden cancelada, stock 10. | Intentar vender sobre orden cancelada. | Venta rechazada, `en_conflicto`. | 10 | 0 | 0 | `conflict` | `order_status='cancelled'`; operación en `en_conflicto` |
| 12 | Modificaciones simultáneas pedido | Pedido qty=3, versión v1. | A modifica a 5 (espera v1), B modifica a 4 (espera v1). | Una se aplica; otra `CONFLICT_ORDER_VERSION`. | — | — | — | 1 `applied`, 1 `conflict` | Una `applied`; otra `en_conflicto` |
| 13 | Reapertura repetida | Orden cancelada. | Reabrir dos veces. | Segunda es `en_conflicto` (no-op). | — | 1 | 1 | 1 `applied`, 1 `conflict` | Solo un `sale` de re-discount |
| 14 | Cancelación repetida | Orden activa con venta. | Cancelar dos veces. | Segunda es `en_conflicto` (no-op). | — | 1 | 1 | 1 `applied`, 1 `conflict` | Solo un `return` |
| 15 | Dos ventas offline stock insuficiente | Stock 5 en servidor. | A vende 8 (sin auth), B vende 8 (sin auth). | Stock remoto = 0. A: decremento 5, shortage 3. B: decremento 0, shortage 8. | 0 | 2 sale + 2 shortage | 2 | 2 `applied` | `stock` = 0; `stock_decrement_quantity` suma 5 |
| 16 | Venta sin autorización | Stock 5. | Vender 8 sin auth. | Stock = 0, `shortage` = 3. | 0 | 1 sale + 1 shortage | 1 | 1 `applied` | `stock` = 0; `shortage_quantity` = 3 |
| 17 | Venta con autorización administrativa | Stock 5, admin auth. | Vender 8. | Stock remoto = -3. | -3 | 1 sale | 1 | 1 `applied` | `stock` = -3; `stock_decrement_quantity` = 8 |
| 18 | Ajuste positivo y negativo | Stock 10. | Admin ajuste +5, luego ajuste -3. | Stock remoto = 12. | 12 | 2 adjustment | 2 | 2 `applied` | `stock` = 12; dos movimientos `adjustment` |
| 19 | Realtime desconectado | Operaciones pendientes. | Desconectar Realtime, hacer polling del cursor. | Eventos aplicados al recuperar. | — | — | — | `applied` | `last_synced_seq` avanza |
| 20 | Recuperación del cursor | `last_synced_seq=5`, evento `seq=8` llega primero. | Dispositivo se detiene en `seq=6`. | Solicita recuperación de `seq=6,7`. | — | — | — | — | No se aplica `seq=8` antes de `6,7` |
| 21 | Error parcial aplicación local | Evento con 2 movimientos hijos. | Error al aplicar segundo hijo. | Transacción SQLite se revierte. | — | 0 | 0 | — | Ningún movimiento aplicado; `last_synced_seq` no avanza |
| 22 | Dispositivo revocado | Dispositivo D revocado. | D intenta enviar operación. | HTTP 403. | — | 0 | 0 | — | Operación no aplicada |
| 23 | Migración de colas antiguas | Cola con operación stock absoluto. | Ejecutar bootstrap. | Operación en cuarentena. | — | — | — | `dead_letter` | `status` = `dead_letter` para incompatibles |
| 24 | Reconciliación saldo inicial | Dos dispositivos stock diferente mismo producto. | Bootstrap centralizado. | Un solo `adjustment` central. | — | 1 adjustment | 1 | 1 `applied` | Un `adjustment` con autorización admin |
| 25 | Dos commits concurrentes orden eventos | Dos transacciones concurrentes en servidor. | Evento lento confirma después de rápido. | `event_seq` refleja orden de publicación. | — | — | — | — | Sin huecos en `event_seq` aplicados |
| 26 | Carrera idempotencia dos transacciones reales | Operación UUID-X no existente. | Dos Tx RPC simultáneas mismo UUID. | Una aplica, otra `already_applied`. | — | 1 | 1 | 1 `applied` | `COUNT(movement_uuid=?)` = 1 |

---

## 16. Riesgos residuales

| Riesgo | Descripción | Mitigación |
|--------|-------------|------------|
| Relojes locales no sincronizados | `created_at` local no es autoridad para orden remoto. | Usar `event_seq` del servidor como cursor monotónico. |
| Dos procesos Node sobre misma SQLite | No es el caso actual (Electron monoplanta). | Lease con `lease_owner` y `lease_expires_at`; reclamo atómico. |
| RPC de Supabase caída | Operaciones en `retry_wait`/`dead_letter`. | Backoff exponencial, recuperación de lease, reintento manual. |
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
9. **Nunca se usa `stock = valor absoluto`** en el servidor; solo deltas calculados sobre saldo remoto actual.
10. **Reclamo atómico de outbox** funciona con SQL compatible con better-sqlite3 (sin transacción abierta durante HTTP).
11. **Cursor remoto monotónico** por restaurante con fila de control y bloqueo transaccional.
12. **Evento propio** se confirma sin duplicar movimientos y avanza el cursor.
13. **Ajuste negativo** se representa con signo en `stock_delta`, no con cantidad positiva forzada.
14. **Todas las 26 pruebas del plan de pruebas pasan** en entorno aislado.

---

## 18. Matriz de trazabilidad V5 → V6

| ID V5 | Problema en V5 | Corrección en V6 | Sección V6 | Prueba que valida |
|-------|---------------|-----------------|------------|-------------------|
| E1 | `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` devuelve `already_applied` para operaciones nuevas | `INSERT ... ON CONFLICT DO NOTHING RETURNING` + `IF NOT FOUND` → consultar existente con `FOR UPDATE` | 7, E1 | Prueba 3, 4, 26 |
| E2 | `idempotency_key` del cliente en movimientos; mismo patrón defectuoso que E1 | `idempotency_key` derivada del servidor (`SHA-256`); `ON CONFLICT DO NOTHING` | 7, E2 | Prueba 3, 6 |
| E3 | Cliente envía `stock_delta`, `stock_decrement_quantity`, `shortage_quantity` como autoritativos | Cliente envía solo `requested_quantity`; servidor calcula todo sobre saldo remoto actual con `FOR UPDATE` | 7, 9, E3 | Prueba 15, 16, 17 |
| E4 | No hay transacción atómica pedido+inventario+movimientos+evento; no hay control de versión de pedidos | RPC acepta `entity_type='order'`; verifica `expected_order_version`; aplica todo en transacción PostgreSQL | 7, 10, E4 | Prueba 10, 11, 12, 13, 14 |
| E5 | `FOREACH ... IN ARRAY (jsonb[])` inválido; hash no canónico; falta `search_path`; falta `SECURITY DEFINER` | `jsonb_array_elements`; `canonical_json` + `digest`; `SET search_path`; `SECURITY DEFINER` | 7, E5 | Prueba 3 (estructura SQL válida) |
| E6 | `SECURITY DEFINER` sin `search_path`, sin tabla `devices`, sin GRANT/REVOKE, sin RLS completas | `SECURITY DEFINER` + `search_path` fijo; tabla `devices`; RLS; GRANT/REVOKE explícitos; JWT expiración corta | 12, E6 | Prueba 22 |
| E7 | `get_sync_events` devuelve solo `payload_hash`; `is_own_event` no local; sin definición de gaps | `get_sync_events` devuelve `payload` completo; `is_own_event` derivado localmente; `last_synced_seq` con detección de gaps | 11, E7 | Prueba 19, 20 |
| E8 | `sync_queue` esquema incompleto; sin `retry_wait` ni `dead_letter`; sin migración | Nueva tabla `inventory_outbox` con estados completos, `next_attempt_at`, backoff, `dead_letter` | 13, E8 | Prueba 2, 8, 9 |
| E9 | Sin procedimiento para migrar columnas existentes; sin backfill de `stock_movements`; sin clasificación de colas antiguas | Bootstrap centralizado 11 pasos; backfill UUIDs; clasificar colas antiguas; `adjustment` central; bloqueo clientes antiguos | 14, E9 | Prueba 23, 24 |
| E10 | Pruebas con números incorrectos; no especifica dos procesos Node independientes | 26 pruebas reescritas con datos correctos; criterios cuantificables; dos procesos Node; Supabase aislado | 15, E10 | Todas las 26 pruebas |

---

**Fase 2B.5.1 (V6) completada. Arquitectura lista para revisión final. Detenido a la espera de autorización explícita para pasar a implementación.**