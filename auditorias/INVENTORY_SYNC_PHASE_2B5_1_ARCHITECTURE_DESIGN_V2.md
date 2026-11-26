# INVENTORY_SYNC_PHASE_2B5_1_ARCHITECTURE_DESIGN_V2.md

## Fase 2B.5.1 — Diseño de Arquitectura de Sincronización Offline-First (Revisión Integral)

**Proyecto:** La Mente Maestra 3.0 (POS)  
**Tecnologías:** Electron, Node.js, Express, SQLite, Supabase  
**Fecha:** 20/11/2026  
**Modalidad:** SOLO ANÁLISIS Y DOCUMENTACIÓN — PROHIBIDO IMPLEMENTAR  
**Estado:** PROPUESTA V2 LISTA PARA REVISIÓN  
**Archivo reemplazado:** `INVENTORY_SYNC_PHASE_2B5_1_ARCHITECTURE_DESIGN.md` (se reemplaza por esta versión)

---

## 1. Arquitectura definitiva

### 1.1 Principios rectores

1. **SQLite es el almacenamiento operativo local.** El POS funciona totalmente sin conexión.
2. **Cada operación de inventario tiene identidad global única (UUID).** No se usa `id` entero local como identificador global.
3. **`stock_movements` es la fuente de trazabilidad.** El stock materializado es un derivado, no la verdad única.
4. **Los movimientos se sincronizan como operaciones individuales.** No se sincroniza stock como valor absoluto.
5. **Idempotencia en servidor.** Una operación con el mismo UUID y contenido se aplica una sola vez.
6. **No se mantiene una transacción SQLite abierta durante una llamada de red.**
7. **Realtime es notificación, no única fuente de verdad.** Existe un cursor remoto monotónico para recuperación.
8. **Nunca confiar en `user_role`, `authorized_by` ni `device_id` recibidos del cliente sin validación.**

### 1.2 Componentes lógicos

```
┌─────────────────────────────────────────────────────────────────────┐
│                   DISPOSITIVO LOCAL (Electron + Node)               │
│                                                                     │
│  ┌─────────────────┐    ┌──────────────────┐    ┌──────────────┐   │
│  │   Express       │    │   SQLite local   │    │  sync-engine │   │
│  │   (routes)      │    │   (db.js)        │    │   (outbox)   │   │
│  └───────┬─────────┘    └────────┬─────────┘    └──────┬──────┘   │
│          │                     │                      │            │
│          │ Transacción atómica │                     │            │
│          │ (stock + movimiento │                     │            │
│          │  + outbox)          │                     │            │
│          ▼                     ▼                     ▼            │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │              Outbox de inventario (sync_queue)               │   │
│  │  operation_id (UUID) | entity_type | entity_uuid | op_type   │   │
│  │  payload (JSON) | idempotency_key | status | lease           │   │
│  │  attempts | last_error | created_at | claimed_at | device_id  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│          │                                                          │
│          │ HTTP (anon key, autenticado)                             │
│          ▼                                                          │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    SUPABASE (remoto)                          │   │
│  │                                                                   │   │
│  │  ┌─────────────────────────────────────────────────────────┐   │   │
│  │  │  RPC apply_inventory_operation (transacción servidor)   │   │   │
│  │  │  - valida UUID e idempotency_key                        │   │   │
│  │  │  - compara contenido si ya existe                       │   │   │
│  │  │  - registra movimiento                                  │   │   │
│  │  │  - actualiza stock materializado (delta)                │   │   │
│  │  │  - valida RLS y permisos de sesión                      │   │   │
│  │  └─────────────────────────────────────────────────────────┘   │   │
│  │                                                                   │   │
│  │  Realtime (canal por restaurant_id) → notificación de evento   │   │   │
│  │  Cursor remoto monotónico (last_synced_event_id)              │   │   │
│  └──────────────────────────────────────────────────────────────┘   │
│          │                                                          │
│          │ Evento remoto aplicado una sola vez (UUID)              │
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

### 2.1 Tablas locales (SQLite) — descripción lógica (sin crear)

#### `inventory` (existente, se conserva)
| Columna | Tipo | Rol |
|---------|------|-----|
| `id` | INTEGER PK | Identificador local operativo (NUNCA se envía como global) |
| `uuid` | TEXT UNIQUE | Identificador estable global del producto |
| `stock` | REAL | Stock materializado local (derivado) |
| `version` | INTEGER | Versión del registro para control de concurrencia (se incrementa en cada cambio) |
| `device_id` | TEXT | Dispositivo que originó el cambio |
| `updated_at` | INTEGER | Timestamp local de última modificación |

#### `stock_movements` (existente, se conserva)
| Columna | Tipo | Rol |
|---------|------|-----|
| `id` | INTEGER PK | Identificador local |
| `uuid` | TEXT UNIQUE | Identificador global del movimiento |
| `idempotency_key` | TEXT UNIQUE | Clave determinística para idempotencia |
| `inventory_uuid` | TEXT | UUID del producto (referencia estable, no `id` entero) |
| `order_uuid` | TEXT | UUID del pedido relacionado (si aplica) |
| `operation_uuid` | TEXT | UUID de la operación de negocio que originó el movimiento |
| `movement_type` | TEXT | `sale`, `return`, `shortage`, `adjustment` |
| `quantity` | REAL | Cantidad positiva (magnitud) |
| `stock_before` | REAL | Stock materializado local antes del movimiento (solo referencia) |
| `stock_after` | REAL | Stock materializado local después del movimiento (solo referencia) |
| `shortage_quantity` | REAL | Cantidad de faltante (solo para `shortage`) |
| `reference_type` | TEXT | `order`, `decrement`, `adjustment` |
| `reference_id` | INTEGER | ID local de referencia |
| `authorized_by` | TEXT | Usuario que autorizó (validado en servidor) |
| `user_name` | TEXT | Usuario responsable |
| `user_role` | TEXT | Rol del usuario responsable |
| `device_id` | TEXT | Dispositivo origen |
| `created_at` | INTEGER | Timestamp de creación local |
| `deleted` | INTEGER | Borrado lógico |

#### `sync_queue` (outbox específico de inventario — diseño)
| Columna | Tipo | Rol |
|---------|------|-----|
| `id` | INTEGER PK | Identificador local de la cola |
| `operation_id` | TEXT UNIQUE | UUID de la operación de negocio |
| `entity_type` | TEXT | `inventory_movement`, `order`, `order_item` |
| `entity_uuid` | TEXT | UUID de la entidad afectada |
| `op_type` | TEXT | `sale`, `return`, `shortage`, `adjustment`, `create`, `update`, `delete` |
| `payload` | TEXT (JSON) | Datos completos de la operación |
| `idempotency_key` | TEXT UNIQUE | Clave determinística para idempotencia remota |
| `status` | TEXT | `pending`, `claimed`, `synced`, `failed`, `dead` |
| `lease_owner` | TEXT | ID del proceso que reclamó la operación |
| `lease_expires_at` | INTEGER | Vencimiento del lease |
| `attempts` | INTEGER | Número de intentos |
| `last_error` | TEXT | Último mensaje de error |
| `created_at` | INTEGER | Fecha de creación |
| `claimed_at` | INTEGER | Fecha de última reclamación |
| `synced_at` | INTEGER | Fecha de confirmación |
| `device_id` | TEXT | Dispositivo que originó la operación |
| `restaurant_id` | TEXT | ID del restaurante para aislamiento |

### 2.2 Tablas remotas (Supabase) — diseño lógico (sin crear)

#### `inventory_sync`
| Columna | Tipo | Rol |
|---------|------|-----|
| `uuid` | UUID PK | Identificador estable del producto |
| `stock` | REAL | Stock materializado remoto |
| `version` | INTEGER | Versión para control de concurrencia |
| `device_id` | TEXT | Dispositivo última modificación |
| `updated_at` | TIMESTAMPTZ | Última actualización remota |
| `restaurant_id` | UUID | Aislamiento de negocio |

#### `stock_movements_sync`
| Columna | Tipo | Rol |
|---------|------|-----|
| `uuid` | UUID PK | Identificador estable del movimiento |
| `idempotency_key` | TEXT UNIQUE | Clave determinística |
| `inventory_uuid` | UUID | Referencia al producto |
| `order_uuid` | UUID | Referencia al pedido |
| `operation_uuid` | UUID | Operación de negocio origen |
| `movement_type` | TEXT | `sale`, `return`, `shortage`, `adjustment` |
| `quantity` | REAL | Cantidad positiva |
| `shortage_quantity` | REAL | Faltante |
| `reference_type` | TEXT | Tipo de referencia |
| `reference_id` | TEXT | ID de referencia (texto para UUIDs) |
| `user_name` | TEXT | Usuario responsable |
| `user_role` | TEXT | Rol responsable |
| `authorized_by` | TEXT | Autorizador (si aplica) |
| `device_id` | TEXT | Dispositivo origen |
| `created_at` | TIMESTAMPTZ | Creación local original |
| `synced_at` | TIMESTAMPTZ | Confirmación remota |
| `restaurant_id` | UUID | Aislamiento de negocio |

#### `sync_events` (cursor remoto monotónico)
| Columna | Tipo | Rol |
|---------|------|-----|
| `id` | BIGSERIAL PK | Cursor remoto monotónico |
| `operation_id` | UUID | Operación aplicada |
| `entity_type` | TEXT | Tipo de entidad |
| `op_type` | TEXT | Tipo de operación |
| `restaurant_id` | UUID | Restaurante |
| `created_at` | TIMESTAMPTZ | Momento de aplicación remota |

---

## 3. Semántica de movimientos (formal)

### 3.1 Definición de tipos

| Tipo | Significado | Efecto en stock materializado | Signo del delta | Validaciones |
|------|-------------|------------------------------|-----------------|--------------|
| `sale` | Venta confirmada | Resta cantidad vendida | Negativo | `quantity > 0`; `shortage_quantity >= 0` |
| `return` | Reintegro por cancelación | Suma cantidad devuelta | Positivo | `quantity > 0`; debe referenciar un `sale` previo de la misma orden/producto |
| `shortage` | Faltante registrado | No modifica stock (solo traza) | Cero | `shortage_quantity > 0`; acompaña a un `sale` donde `quantity < cantidad_solicitada` |
| `adjustment` | Ajuste manual de inventario | Suma o resta según necesidad | Cualquier signo | `quantity != 0`; requiere autorización administrativa |

### 3.2 Reglas de composición

**Regla del faltante (Fase 2B.1):**
- Si se solicita vender `Q` unidades y hay stock `S` disponible sin autorización:
  - `sale.quantity = min(Q, S)`
  - `shortage.quantity = max(0, Q - S)`
  - `stock_after = S - sale.quantity` (puede ser 0)
  - El `shortage` NO descuenta stock adicional; solo registra lo que no se pudo servir.

- Con autorización administrativa válida:
  - `sale.quantity = Q`
  - `shortage.quantity = 0`
  - `stock_after = S - Q` (puede ser negativo)

**Regla de cancelación (Fase 2B.4):**
- Al cancelar una orden, se calcula `effective_discount = SUM(sale.quantity) - SUM(return.quantity)` para esa orden+producto.
- Se registra un `return` con `quantity = effective_discount`.
- El stock materializado se incrementa por `effective_discount`.

**Regla de reapertura (Fase 2B.4):**
- Al reabrir una orden cancelada, se re-aplica el descuento efectivo: `SUM(sale.quantity)` de la orden.
- Se registra un `sale` con esa cantidad (respetando reglas de autorización de la sesión actual).

**Regla de modificación (Fase 2B.3.1):**
- `effective_prev = SUM(sale.quantity) - SUM(return.quantity)` del pedido anterior.
- Si se reduce: `return.quantity = effective_prev - min(new_qty, effective_prev)`.
- Si se aumenta: `sale.quantity = new_qty - prev_qty_requested` (con reglas de faltante).

### 3.3 `stock_before` / `stock_after` son solo referencia local

Los campos `stock_before` y `stock_after` en `stock_movements` capturan el estado del stock **materializado local** en el momento del movimiento. **No se usan para determinar el saldo remoto.** El servidor remoto calcula su propio stock aplicando deltas sobre su stock materializado actual.

---

## 4. Contratos de operaciones y RPC

### 4.1 RPC remota: `apply_inventory_operation`

**Propósito:** Registrar un movimiento de inventario y actualizar el stock materializado en una sola transacción de servidor, con idempotencia completa.

**Entrada (JSON):**

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `operation_id` | UUID | Sí | Identidad global de la operación |
| `idempotency_key` | TEXT | Sí | Clave determinística (ej. `order-{id}-modify-sale-{inv}-{qty}`) |
| `entity_type` | TEXT | Sí | `inventory_movement` |
| `entity_uuid` | UUID | Sí | UUID del movimiento |
| `inventory_uuid` | UUID | Sí | UUID del producto |
| `order_uuid` | UUID | No | UUID del pedido relacionado |
| `operation_uuid` | UUID | Sí | UUID de la operación de negocio |
| `movement_type` | TEXT | Sí | `sale`, `return`, `shortage`, `adjustment` |
| `quantity` | REAL | Sí | Cantidad positiva |
| `shortage_quantity` | REAL | No (default 0) | Cantidad de faltante |
| `reference_type` | TEXT | No | Tipo de referencia |
| `reference_id` | TEXT | No | ID de referencia |
| `user_name` | TEXT | Sí | Usuario responsable (validado por sesión) |
| `user_role` | TEXT | Sí | Rol responsable (validado por sesión) |
| `authorized_by` | TEXT | No | Autorizador (validado por sesión RLS) |
| `device_id` | TEXT | Sí | Dispositivo origen (validado) |
| `created_at` | TIMESTAMPTZ | Sí | Momento de creación local |
| `restaurant_id` | UUID | Sí | Aislamiento de negocio (validado por sesión) |

**Lógica del servidor (pseudo-SQL PL/pgSQL):**

```sql
BEGIN;

-- 1. Idempotencia: buscar si ya existe esta operación
SELECT movement_type, quantity, shortage_quantity, status
FROM stock_movements_sync
WHERE uuid = p_operation_id
FOR UPDATE;

IF FOUND THEN
  -- 2. Comparar contenido: si el idempotency_key y los campos clave coinciden,
  --    devolver resultado previo sin repetir efecto.
  IF existing.idempotency_key = p_idempotency_key
     AND existing.movement_type = p_movement_type
     AND existing.quantity = p_quantity
     AND existing.shortage_quantity = p_shortage_quantity THEN
     RETURN json_build_object('status', 'already_applied', 'operation_id', p_operation_id);
  ELSE
    -- 3. Rechazar UUID reutilizado con contenido diferente
    RAISE EXCEPTION 'operation_id_reused_with_different_content';
  END IF;
END IF;

-- 4. Validar movimiento (tipos, cantidades, referencias)
--    Validación hecha por RLS y restricciones de CHECK, no confiando en cliente.

-- 5. Registrar movimiento
INSERT INTO stock_movements_sync (...)
VALUES (p_operation_id, p_idempotency_key, ...);

-- 6. Actualizar stock materializado aplicando DELTA (no valor absoluto)
--    sale/return: delta = signo * quantity
--    shortage: delta = 0
--    adjustment: delta = quantity
UPDATE inventory_sync
SET stock = COALESCE(stock, 0) + p_delta,
    version = version + 1,
    device_id = p_device_id,
    updated_at = now()
WHERE uuid = p_inventory_uuid
  AND restaurant_id = p_restaurant_id;

-- 7. Si el producto no existe en remoto, rechazar (no inventar stock inicial)
--    El producto debe existir primero (sincronización de catálogo).

-- 8. Registrar evento en cursor remoto
INSERT INTO sync_events (operation_id, entity_type, op_type, restaurant_id)
VALUES (p_operation_id, 'inventory_movement', p_movement_type, p_restaurant_id);

COMMIT;

RETURN json_build_object('status', 'applied', 'operation_id', p_operation_id);
```

**Seguridad de la RPC:**
- Ejecutada con privilegios del usuario autenticado (RLS activo).
- `user_name`, `user_role`, `authorized_by`, `device_id` se validan contra la sesión JWT de Supabase Auth, no se confía en valores enviados en el payload para autorización.
- `restaurant_id` se obtiene de la sesión, no del payload, para aislamiento de negocio.
- Solo roles autorizados pueden ejecutar `adjustment`; `sale`/`return`/`shortage` requieren sesión válida.

---

## 5. Diseño de la outbox (operaciones de inventario)

### 5.1 Reclamo atómico (SQLite, compatible con better-sqlite3)

```sql
-- Reclamar una operación pendiente (única reclamación por proceso)
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
- **Nunca** se mantiene una transacción SQLite abierta durante una llamada de red. El lease se establece, se hace COMMIT, luego se hace la llamada HTTP, y finalmente se actualiza el estado a `synced` o `failed` en una transacción separada.

### 5.2 Lease y vencimiento

| Campo | Propósito |
|-------|-----------|
| `lease_owner` | Identificador del proceso que reclamó (ej. `device_id:pid`) |
| `lease_expires_at` | Momento en que expira el lease (ej. `created_at + 120000 ms`) |
| `claimed_at` | Momento de la última reclamación |

Si un proceso muere mientras tiene una operación en `claimed`, el lease expira y otra ejecución puede reclamarla.

### 5.3 Recuperación de procesos interrumpidos

- Al iniciar `flushQueue`, se escanean operaciones en `claimed` con `lease_expires_at < ahora` y se vuelven a `pending`.
- Estas operaciones se reintentan normalmente (la RPC es idempotente).

### 5.4 Reintentos y backoff

| Intento | Retraso antes del siguiente intento |
|---------|-------------------------------------|
| 1 | inmediato |
| 2 | 5 segundos |
| 3 | 15 segundos |
| 4 | 60 segundos |
| 5+ | 300 segundos (máximo) |

Tras `MAX_ATTEMPTS` (ej. 7), la operación pasa a `dead` y se requiere intervención manual.

### 5.5 Errores transitorios vs permanentes

| Tipo | Ejemplo | Acción |
|------|---------|--------|
| Transitorio | Timeout de red, 503, 504 | Reintentar con backoff; `status` = `failed` solo tras agotar intentos |
| Permanente | 400, 403, 404, UUID reutilizado con contenido diferente | `status` = `dead` inmediatamente; no reintentar |

### 5.6 Confirmación del servidor y respuesta perdida

- El cliente envía la operación a la RPC.
- Si recibe respuesta `200 OK` con `status: 'applied'` o `already_applied`: marca `synced` en `sync_queue`.
- Si no recibe respuesta (timeout, conexión cerrada): la operación queda en `claimed` con lease vencido. Al reiniciar, se recupera a `pending` y se reenvía. La RPC es idempotente, por lo que no hay duplicación.

### 5.7 Retención y auditoría

- Operaciones `synced` se conservan mínimo 30 días para auditoría.
- Operaciones `dead` se conservan indefinidamente para revisión manual.
- `sync_events` en Supabase mantiene el cursor remoto monotónico de todas las operaciones aplicadas.

---

## 6. Pedidos y concurrencia (resolución formal)

### 6.1 Identidad de operación y versión de pedido

Cada pedido tiene:
- `order_uuid` (UUID estable, generado localmente).
- `order_version` (entero incremental, se incrementa en cada modificación del pedido).

Cada operación sobre un pedido lleva:
- `operation_uuid` (UUID de la operación específica).
- `expected_order_version` (versión del pedido que el cliente creía al generar la operación).

### 6.2 Reglas de concurrencia por escenario

#### Escenario A: Dos ventas simultáneas (mismo producto, dispositivos diferentes)

| Paso | Dispositivo A | Dispositivo B |
|------|---------------|---------------|
| Stock inicial remoto | 10 | 10 |
| Vende 3 (offline) | stock local 7, `sale` UUID-A | — |
| Vende 4 (offline) | — | stock local 6, `sale` UUID-B |
| Sincroniza A | RPC delta=-3, stock remoto → 7 | — |
| Sincroniza B | — | RPC delta=-4, stock remoto → 3 |

**Resultado:** stock remoto 3. Ambas ventas aplicadas. No se pierde ninguna.

**Por qué funciona:** Cada operación tiene UUID distinto y se aplica como delta independiente. No hay "último estado de fila" que se sobreescriba.

#### Escenario B: Venta y cancelación simultáneas

| Paso | Dispositivo A (venta) | Dispositivo B (cancelación) |
|------|-----------------------|-----------------------------|
| Orden | activa, stock 10 | activa, stock 10 |
| A vende 3 | stock 7, `sale` UUID-A | — |
| B cancela orden | — | `return` UUID-B (qty=3), stock 10 |
| A sincroniza | stock remoto → 7 | — |
| B sincroniza | — | stock remoto → 10 (7+3) |

**Resultado:** stock remoto 10. La cancelación reintegra lo efectivamente vendido.

#### Escenario C: Cancelación y reapertura

| Paso | Dispositivo |
|------|-------------|
| Vende 3 | stock 7, `sale` UUID-A |
| Cancela | stock 10, `return` UUID-B (qty=3) |
| Reabre | stock 7, `sale` UUID-C (qty=3, re-discount SUM(sale)) |
| Cancela de nuevo | stock 10, `return` UUID-D (qty=3) |

**Resultado:** Cada transición tiene su propio UUID. No hay duplicación porque cada `operation_id` es único.

#### Escenario D: Dos modificaciones del mismo pedido

| Paso | Operación |
|------|-----------|
| Pedido: qty=3 | `sale` UUID-A (qty=3) |
| Modifica a 5 | `sale` UUID-B (qty=2, delta de aumento) |
| Modifica a 3 | `return` UUID-C (qty=2, delta de reducción) |

**Resultado:** stock neto = 10 - 3 = 7. Los deltas se aplican secuencialmente.

#### Escenario E: Devoluciones repetidas

Una misma cancelación no genera dos `return` porque:
1. La primera cancelación registra `return` con `operation_uuid` único.
2. Una segunda cancelación de la misma orden encuentra `order_status = 'cancelled'` y es no-op (idempotencia por estado de pedido).
3. Si se reabre y se cancela de nuevo, es una operación nueva con `operation_uuid` nuevo.

### 6.3 Precondiciones de versión para pedidos

Cuando se modifica un pedido existente:
- El cliente envía `expected_order_version`.
- El servidor verifica que `order.version = expected_order_version` antes de aplicar.
- Si no coinciden, se rechaza con `CONFLICT_ORDER_VERSION` y el cliente debe refrescar.

Esto evita que dos modificaciones concurrentes se pierdan mutuamente.

---

## 7. Sincronización remota

### 7.1 Prohibiciones absolutas

1. **No permitir sobrescrituras absolutas del stock.** Nunca `stock = valor_local` en el servidor. Siempre `stock = stock + delta`.
2. **No incorporar `stock_movements` al sincronizador genérico (`flushQueue` con deduplicación por último estado de fila).** Los movimientos son operaciones individuales con UUID único; cada uno se envía por separado y se aplica por RPC.
3. **No usar `updated_at` local como única autoridad** para decidir qué stock prevalece entre dispositivos.

### 7.2 Cursor remoto monotónico

- Tabla `sync_events` con `id` BIGSERIAL como cursor remoto.
- Cada dispositivo local almacena `last_synced_event_id` (el último evento remoto aplicado).
- Al recuperar sincronización, el dispositivo solicita eventos con `id > last_synced_event_id`.
- Realtime se usa como notificación de nuevos eventos, pero el dispositivo también puede hacer polling del cursor si Realtime se cae.

### 7.3 Aplicación de eventos remotos localmente

Cada evento remoto llega con su `operation_id` (UUID).
- El dispositivo verifica si ya existe un movimiento local con ese `uuid` en `stock_movements`.
- Si existe: no se aplica de nuevo (idempotencia local).
- Si no existe: se inserta el movimiento y se actualiza el stock materializado local aplicando el delta (`stock = stock + delta_remoto`).
- El evento propio (enviado por este dispositivo) tiene `device_id = DEVICE_ID` y se ignora al llegar por Realtime (eco).

### 7.4 Interacción con operaciones locales pendientes

- Las operaciones locales pendientes en `sync_queue` tienen prioridad de envío.
- Los eventos remotos se aplican localmente sin bloquear el envío de operaciones pendientes.
- Si una operación local y un evento remoto afectan el mismo producto, ambos se aplican como deltas independientes; el stock materializado final refleja la suma de ambos.

---

## 8. Estrategia de seguridad

### 8.1 Supabase Auth

- El cliente local se autentica contra Supabase Auth con credenciales del empleado.
- Se obtiene un JWT con claims: `sub` (usuario), `email`, `role`, `restaurant_id`.
- **Nunca** se expone `service_role` al cliente ni al frontend.

### 8.2 RLS (Row Level Security)

| Tabla | Política SELECT | Política INSERT | Política UPDATE |
|-------|-----------------|-----------------|-----------------|
| `inventory_sync` | Solo filas de su `restaurant_id` | Solo servicio (RPC) | Solo servicio (RPC) |
| `stock_movements_sync` | Solo filas de su `restaurant_id` | Solo servicio (RPC) | Solo servicio (RPC) |
| `sync_events` | Solo filas de su `restaurant_id` | Solo servicio (RPC) | Ninguna |

### 8.3 RPC y autenticación

- `apply_inventory_operation` se ejecuta con el contexto del usuario autenticado.
- `restaurant_id` se obtiene de `auth.jwt() ->> 'restaurant_id'`, no del payload.
- `user_name`, `user_role` se obtienen del JWT, no del payload.
- `authorized_by` solo se permite si el usuario tiene rol de admin/owner en su restaurante.

### 8.4 Identidad del dispositivo

- `device_id` se genera localmente (UUID persistente en `local_session`).
- Se valida que el `device_id` del payload coincida con un dispositivo registrado para ese restaurante (o se acepta si es nuevo, con registro implícito).
- `device_id` nunca se usa como única autorización; siempre se combina con sesión de usuario.

### 8.5 Identidad del empleado y autorizaciones admin

- `user_role` del JWT determina si puede hacer `adjustment` o `sale` con stock negativo.
- `authorized_by` en el movimiento se rellena con el nombre del usuario autenticado si la operación requiere autorización y el usuario es admin/owner.
- **Nunca** se confía en `user_role` o `authorized_by` enviados en el payload del cliente sin validación contra el JWT.

### 8.6 Aislamiento de negocios

- Todas las consultas filtran por `restaurant_id` obtenido de la sesión.
- Un dispositivo de un restaurante no puede ver ni modificar movimientos de otro restaurante.

### 8.7 Protección de credenciales

- `supabase_url` y `supabase_anon_key` se almacenan en `config` (SQLite local).
- `supabase_anon_key` es pública por definición de Supabase; no tiene privilegios de escritura directa sin RLS.
- `service_role` nunca se almacena en el cliente.

---

## 9. Migración y compatibilidad

### 9.1 Saldo inicial canónico

Al activar la nueva arquitectura:
- El `stock` actual de cada producto en SQLite se toma como saldo inicial canónico.
- No se generan movimientos retroactivos para ventas pasadas (evitar inventar datos).
- Los productos existentes reciben un `uuid` si no tienen uno (backfill existente en `db.js`).

### 9.2 Conciliación entre dispositivos

Al sincronizar por primera vez con la nueva arquitectura:
- Cada dispositivo envía sus productos existentes con su `stock` actual como valor absoluto (solo para el catálogo inicial).
- A partir de ese momento, todos los cambios se hacen por delta mediante movimientos.
- Si dos dispositivos tienen stock diferente para el mismo producto al activar, se registra un `adjustment` para reconciliar (requiere autorización admin).

### 9.3 Migración de productos existentes

- Se añade columna `uuid` a `inventory` (ya existe en backfill de `db.js`).
- Se añade columna `version` (INTEGER DEFAULT 1) para control de concurrencia.
- Los productos sin `uuid` reciben uno generado.

### 9.4 Tratamiento de movimientos históricos

- Los `stock_movements` locales existentes se conservan como trazabilidad local.
- **No se suben automáticamente** a Supabase (evitar aplicar miles de movimientos antiguos).
- Solo los movimientos generados después de la activación se sincronizan.

### 9.5 Tratamiento de operaciones pendientes antiguas

- Las entradas existentes en `sync_queue` (si las hay) se mantienen con su estado actual.
- Se reintentan con el nuevo mecanismo (RPC idempotente).
- Si una operación antigua usa el esquema de valor absoluto, se detecta y se maneja como ajuste de stock.

### 9.6 Bloqueo de clientes antiguos

- Los clientes que todavía escriben `stock = valor absoluto` deben ser bloqueados o migrados.
- Se puede implementar una versión mínima de cliente requerida para sincronizar con el nuevo esquema.
- El servidor RPC rechaza operaciones que intenten establecer stock absoluto sin delta.

### 9.7 Procedimiento de actualización y recuperación

1. Detener sincronización en todos los dispositivos.
2. Aplicar cambios de esquema (`uuid`, `version`, columnas de `sync_queue` ampliada).
3. Crear tablas remotas y RPC en Supabase.
4. Reactivar sincronización dispositivo por dispositivo.
5. Verificar con `checkIntegrity` que los conteos coincidan.

### 9.8 Compatibilidad de versiones

- SQLite: better-sqlite3 local (sin cambios de versión).
- Esquema: cambios aditivos (columnas nuevas, tablas nuevas) para no romper consultas existentes.
- Clientes antiguos: modo de solo lectura para inventario hasta que se actualicen.

---

## 10. Plan de pruebas (futura implementación)

Todas las pruebas usan **dos bases SQLite independientes** (simulando dos dispositivos) y un **entorno Supabase de pruebas**. Nunca producción.

| # | Prueba | Configuración | Resultado esperado | Criterio de aprobación |
|---|--------|---------------|-------------------|------------------------|
| 1 | Dos dispositivos vendiendo simultáneamente | Dispositivo A: stock 10, vende 3. Dispositivo B: stock 10, vende 4. Ambos offline. | Stock remoto final = 3. Ambos movimientos `sale` existen con UUID distintos. | `SELECT stock FROM inventory_sync WHERE uuid=?` = 3; `SELECT COUNT(*) FROM stock_movements_sync WHERE movement_type='sale'` = 2 |
| 2 | Dos procesos de sincronización | Dos procesos leen la misma `sync_queue` simultáneamente. | Cada operación procesada exactamente una vez. | `SELECT status, COUNT(*) FROM sync_queue GROUP BY status` → sin duplicados en `synced` |
| 3 | Reintentos duplicados | Mismo UUID enviado dos veces con payload idéntico. | Operación aplicada una sola vez. | `SELECT COUNT(*) FROM stock_movements_sync WHERE uuid=?` = 1 |
| 4 | UUID duplicado con payload diferente | Mismo UUID, campos de cantidad distintos. | Servidor rechaza con error. | RPC devuelve error `operation_id_reused_with_different_content` |
| 5 | Confirmación perdida | Cliente envía, servidor aplica, respuesta se pierde. Cliente reenvía. | No hay duplicación. | `SELECT COUNT(*) FROM stock_movements_sync WHERE uuid=?` = 1 |
| 6 | Caída durante RPC | Cliente envía, proceso del cliente muere antes de recibir respuesta. | Operación queda en `claimed` con lease vencido; al reiniciar se recupera. | `SELECT status FROM sync_queue WHERE operation_id=?` → `claimed` luego `pending` al reiniciar |
| 7 | Reinicio de Electron | Operaciones pendientes en `sync_queue` antes del reinicio. | Operaciones persisten y se reintentan tras reinicio. | `SELECT COUNT(*) FROM sync_queue WHERE status='pending'` > 0 después del reinicio |
| 8 | Desconexión prolongada | Venta offline, sin Internet por 10 min, luego reconecta. | Venta se sincroniza al reconectar. | `stock` remoto refleja la venta |
| 9 | Stock negativo | Admin autorizado vende 8 con stock 5. | Stock remoto = -3. | `SELECT stock FROM inventory_sync WHERE uuid=?` = -3 |
| 10 | Faltantes sin auth | Vende 8 con stock 5 sin auth. | Stock remoto = 0, `shortage` registrado = 3. | `stock` = 0; `SELECT * FROM stock_movements_sync WHERE movement_type='shortage'` existe |
| 11 | Ajustes | Admin hace ajuste de +10 en producto. | Stock remoto incrementa 10. | `SELECT stock FROM inventory_sync` antes y después difiere en +10 |
| 12 | Cancelación | Vende 3, cancela. | Stock remoto vuelve al valor original. | `stock` remoto = inicial |
| 13 | Reapertura | Cancela, reabre. | Stock remoto se re-descuenta (si aplica reglas). | `stock` remoto = inicial - 3 |
| 14 | Cancelar-reabrir-cancelar | Ciclo completo dos veces. | Stock consistente, movimientos sin duplicar. | `SELECT COUNT(*) FROM stock_movements_sync WHERE order_uuid=?` = número esperado de movimientos |
| 15 | Migración | Productos existentes sin `uuid`. | Reciben `uuid` y se sincronizan como catálogo inicial. | Todos los productos tienen `uuid` no nulo |
| 16 | Seguridad RLS | Usuario de restaurante A intenta leer movimientos de restaurante B. | Acceso denegado. | Consulta devuelve 0 filas o error de RLS |
| 17 | Cliente antiguo | Cliente que envía `stock = valor absoluto` sin delta. | Servidor rechaza. | RPC devuelve error de validación |

---

## 11. Riesgos residuales

| Riesgo | Descripción | Mitigación |
|--------|-------------|------------|
| Relojes locales no sincronizados | `created_at` local no es confiable para ordenar eventos remotos. | Usar `sync_events.id` (cursor remoto monotónico) como autoridad de orden remoto. |
| Dos procesos Node sobre misma SQLite | No es el caso actual (Electron monoplanta), pero posible en futuro. | Lease con `lease_owner` y `lease_expires_at`; reclamación atómica con `changes = 1`. |
| RPC de Supabase caída | Operaciones quedan en `failed` o `claimed`. | Backoff exponencial, recuperación de lease vencido, reintento manual. |
| Dispositivos con versión antigua | Siguen usando valor absoluto. | Bloqueo de clientes antiguos, versión mínima requerida, modo solo lectura para inventario. |
| Movimientos históricos no subidos | Trazabilidad solo desde activación. | Documentar límite explícito; no inventar datos pasados. |
| Stock negativo remoto acumulado | Ventas offline concurrentes pueden dejar stock negativo. | Aceptado como estado válido; reconciliación mediante `adjustment` con autorización admin. |

---

## 12. Criterios objetivos de aceptación

La fase se considera aprobada cuando:

1. **No se pierde ninguna venta** en escenario de dos dispositivos concurrentes (stock remoto = inicial - suma de ventas).
2. **No se duplica ningún movimiento** ante reintentos, respuestas perdidas o UUID duplicados (conteo de movimientos = número de operaciones únicas).
3. **Stock negativo autorizado** se permite y se registra correctamente.
4. **Faltantes sin autorización** dejan stock en 0 y registran `shortage` sin descontar dos veces.
5. **Cancelaciones y reaperturas** son idempotentes (segunda cancelación es no-op).
6. **Operaciones pendientes sobreviven a reinicio** de Electron y se sincronizan al recuperar conexión.
7. **RLS impide acceso cruzado** entre restaurantes.
8. **UUID reutilizado con contenido diferente** es rechazado por el servidor.
9. **Nunca se usa `stock = valor absoluto`** en el servidor; solo deltas.
10. **Todas las pruebas del plan de pruebas (sección 10) pasan** en entorno aislado.

---

**Fase 2B.5.1 (V2) completada. Diseño listo para revisión. Detenido a la espera de autorización explícita para pasar a implementación.**