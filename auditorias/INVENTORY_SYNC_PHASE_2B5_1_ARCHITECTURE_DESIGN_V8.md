# INVENTORY_SYNC_PHASE_2B5_1_ARCHITECTURE_DESIGN_V8.md

## Fase 2B.5.1 — Arquitectura de sincronización de inventario (Versión 8)

**Proyecto:** La Mente Maestra 3.0 (POS)
**Documento de origen auditado:** `INVENTORY_SYNC_PHASE_2B5_1_ARCHITECTURE_DESIGN_V7.md`
**Fecha:** 21/11/2026
**Modalidad:** diseño y validación (V8). **Actualización:** por instrucción posterior del usuario se inició una implementación **aditiva y apagada por defecto** (ver 24.3 y `services/inventory-sync-v8/README.md`). Supabase y producción siguen sin tocarse.
**Estado:** V8.1 — diseño corregido tras la auditoría externa (ver 23.3). **No es una autorización de implementación.**

> Este documento es autocontenido: define todos los contratos, tablas, funciones, reglas y pruebas sin requerir V7. Las referencias a V7 existen solo en la sección 22 (trazabilidad).

---

## 1. Resumen ejecutivo

V7 declaraba resueltos diez errores de V6, pero la auditoría de V8 encontró **30 defectos** en V7 (14 críticos, 9 altos, 7 medios). Tres de ellos hacían que la arquitectura **violara las reglas comerciales** aunque la prosa afirmara lo contrario:

1. **Stock negativo + venta sin autorización aumentaba el saldo.** El texto de V7 (§9.4) decía "no se descuenta más", pero su pseudocódigo hacía `v_stock_decrement := v_available` (= −3) y `stock_delta = +3`.
2. **La autorización era el rol de la sesión**, no una autorización por operación, y además leía `auth.jwt() ->> 'role'`, que en Supabase vale `authenticated` (nunca `admin`).
3. **La reconciliación offline no existía.** V7 proponía `stock local + delta remoto`, que **duplica** el descuento ya aplicado localmente.

V8 reemplaza esas piezas, no las parchea. Las decisiones centrales:

| Tema | Decisión V8 |
|---|---|
| Autoridad del saldo | El servidor. El cliente solo envía **intención** (producto, cantidad, pedido, `operation_id`). |
| Precisión | Cantidades `NUMERIC(14,3)` en PostgreSQL; **enteros en milésimas** en SQLite; viajan como **strings decimales canónicos**. Nunca `REAL`. |
| Idempotencia | Una operación = una fila en `lmm.operations` con `payload_hash` del *intent* canónico y `result_payload` persistido. Se distingue "nueva" de "duplicada" con `ROW_COUNT`, no con `RETURNING`. |
| Movimientos hijos | Identidad propia (`movement_id`, `line_id`), `UNIQUE (operation_id, line_id, kind)`; su idempotencia deriva de la de la operación padre y se refuerza con restricciones. |
| Rechazos de negocio | Se **devuelven y persisten** (`operation_status='rejected'`); las excepciones quedan para manipulación, errores de sistema y reintentos. |
| Faltantes | Movimiento `sale` (con `requested/applied/shortage`) **más** movimiento `shortage` separado. Disponible para venta = `GREATEST(stock, 0)`. |
| Autorización | Por operación, emitida por el servidor tras verificar un PIN de administrador (`lmm.stock_authorizations`); de un solo uso, atada a dispositivo y pedido/producto. |
| Identidad | `auth.uid()` → `lmm.devices` → restaurante. Membresías en `lmm.restaurant_memberships`. Ningún dato de identidad se toma del payload. |
| Concurrencia | Orden global de bloqueos: operación → autorización → pedido → ledger → inventario (por UUID ascendente) → contador de eventos. |
| Eventos | `event_seq` sin huecos (contador bloqueado hasta el commit), con `device_id` de origen y **resultado autoritativo** en el payload. |
| Reconciliación | Stock **confirmado** (autoridad) + movimientos **provisionales** locales = stock **provisional**. El resultado remoto se aplica **una vez** (`applied_results`), actualiza el movimiento local en lugar de duplicarlo y no retrocede por eventos viejos (guarda por versión). |
| Outbox | Claim atómico, lease, recuperación en caliente, backoff con jitter, bloqueo por partición (pedido), estados terminales claros. |

**Veredicto resumido (detalle en la sección 24):** V8 corrige los 30 defectos **en el diseño**. El SQL de PostgreSQL fue revisado manualmente pero **no ejecutado** (no hay PostgreSQL en el entorno de análisis y la regla de la tarea prohíbe tocar Supabase). Lo ejecutable en SQLite y el JSON canónico sí se verificó (sección 19.2). Quedan decisiones abiertas y riesgos explícitos (sección 21).

---

## 2. Alcance y restricciones

**Dentro del alcance:** inventario, movimientos de stock, su relación atómica con pedidos (venta, modificación, cancelación, reapertura), devoluciones, ajustes, autorización, eventos, outbox local, reconciliación offline, seguridad Supabase, migración, pruebas.

**Limitación explícita sobre precios (M-02):** el servidor calcula `line_total = ROUND(unit_price·qty, 2)`, pero `unit_price` lo envía el cliente y **no se valida contra una fuente autoritativa de precios** (el menú no está en `lmm`). V8 protege el **inventario**, no la integridad comercial de los importes; un dispositivo comprometido podría enviar precios arbitrarios. Si se necesita esa garantía, hay que sincronizar un catálogo de precios autoritativo y validar contra él (fuera de esta fase).

**Fuera del alcance:** cobros y medios de pago, impuestos y descuentos (se conservan en `snapshot` del pedido sin validación del servidor), recetas (`menu_ingredients`: hoy el POS solo descuenta ítems `itemType='inventory'` y V8 mantiene ese alcance), impresión, empleados, mesas.

**Restricciones de esta tarea:** análisis y documentación únicamente. No se modificó `db.js`, `sync-engine.js`, `routes/*`, `server.js`, `main.js`, frontend, SQLite local ni Supabase; no se ejecutaron migraciones, RPC ni sincronizaciones; no se instalaron dependencias. Las verificaciones ejecutadas usaron una base SQLite **en memoria** fuera del proyecto (`/tmp`).

**Hechos del sistema actual relevantes (leídos del código, no supuestos):**

- `inventory(id INTEGER PK, name, stock REAL, …)` y `uuid` agregado por backfill; `stock_movements(inventory_id, product_name, movement_type, quantity, stock_before, stock_after, shortage_quantity, reference_type, reference_id INTEGER, authorized_by, user_name, user_role, created_at, uuid, device_id, deleted)`.
- Hoy una venta registra un movimiento `sale` con `quantity = cantidad efectivamente descontada` y, si hay faltante, un movimiento `shortage` aparte.
- La autorización local es `adminAuthorized === true && isAdmin` (admin de sesión **más** confirmación explícita de la operación).
- `sync_queue(table_name, row_uuid, operation, created_at, synced)` **no guarda payload**: al enviar se lee la fila actual y se hace `upsert` con `onConflict: 'uuid'` (valor absoluto de `stock`).
- El motor usa **clave anónima de Supabase** y `cloud_restaurant_id` tomado de la configuración local; tablas remotas `sync_<tabla>` filtradas por `restaurant_id`. No hay JWT con claims de restaurante, dispositivo o rol.
- Stack: Electron 33, better-sqlite3 ^11.7 (SQLite ≥ 3.35, soporta `RETURNING`), supabase-js ^2.45.
- Existe un cliente móvil (comentarios en `sync-engine.js`) que empuja pedidos a `sync_orders`; su código **no está** en el material analizado (ver riesgo R-02).

---

## 3. Arquitectura general

### 3.1 Principios rectores

1. SQLite local es el almacén operativo; el POS vende sin conexión.
2. Toda entidad sincronizable tiene UUID global; los enteros locales nunca viajan como identidad.
3. **El servidor es la única autoridad del saldo confirmado.** Nunca se envía ni se acepta un stock absoluto, un `stock_delta`, una cantidad descontada ni un faltante desde el cliente.
4. `stock_movements` es la fuente de trazabilidad; el stock materializado es derivado.
5. Una operación de negocio es atómica: pedido + ítems + ledger + inventario + movimientos + operación + evento, en **una** transacción PostgreSQL.
6. Toda operación es idempotente por `operation_id`; los reintentos devuelven el resultado persistido.
7. Ninguna transacción SQLite permanece abierta durante una llamada HTTP.
8. Realtime, si se usa, es solo una pista de que hay eventos nuevos; la fuente de verdad es el cursor `event_seq`.
9. Una operación local confirmada nunca desaparece por un conflicto remoto: queda en un estado visible (`conflict`, `dead_letter`).
10. Los saldos no confirmados se muestran como provisionales.

### 3.2 Definiciones obligatorias (distinguir cuatro conceptos)

| Concepto | Definición | Ejemplo (stock −3, venta de 2) |
|---|---|---|
| **Stock negativo existente** | Saldo remoto actual, puede ser < 0 por ventas autorizadas previas. | −3 |
| **Stock disponible para venta sin autorización** | `GREATEST(stock, 0)`. Un saldo negativo **nunca** es disponible. | 0 |
| **Stock descontable con autorización** | La cantidad solicitada completa, aunque el saldo quede negativo. | 2 |
| **Faltante de la operación** | `GREATEST(solicitada − disponible_sin_autorización, 0)`; se registra con o sin autorización. | 2 |

Resultado sin autorización: descuento 0, faltante 2, saldo −3 (no cambia). Con autorización: descuento 2, faltante 2, saldo −5.

### 3.3 Vocabulario de cantidades

| Campo | Significado | Quién lo calcula |
|---|---|---|
| `requested_qty` | Lo que el cliente quiere vender/devolver/ajustar | Cliente (intención) |
| `applied_qty` | Lo efectivamente movido en el stock (descontado, reintegrado o ajustado, siempre ≥ 0) | **Servidor** |
| `shortage_qty` | Faltante de la operación | **Servidor** |
| `stock_delta` | Variación firmada del saldo | **Servidor** |
| `returned_qty` | Acumulado devuelto (en el ledger) | **Servidor** |

---

## 4. Diagrama de componentes

```
┌──────────────────────────── DISPOSITIVO (Electron + Node) ─────────────────────────────┐
│                                                                                          │
│  UI/POS ──► routes (orders/inventory) ──► db.js  ── TX SQLite única (sin HTTP) ──┐      │
│                                                                                   ▼      │
│   pedido local + movimientos PROVISIONALES + stock caché + fila en inventory_outbox      │
│                                                                                          │
│  sync-engine ─ claim atómico (lease) ─► POST RPC ─┐        ┌─ poll por cursor ◄─┐        │
│        ▲                                           │        │                    │        │
│        │ applyAuthoritativeResult() — TX SQLite única, idempotente (applied_results)     │
└────────┼───────────────────────────────────────────┼────────┼────────────────────┼───────┘
         │                                           ▼        ▼                    │
┌────────┴──────────────────────────── SUPABASE ───────────────────────────────────┴───────┐
│  public.lmm_apply_operation(jsonb)   public.lmm_get_events(...)   public.lmm_get_snapshot │
│  public.lmm_issue_authorization(...) public.lmm_enroll_device / lmm_revoke_device ...    │
│  (SECURITY DEFINER, search_path = '', propietario lmm_owner, EXECUTE solo authenticated)  │
│        │ auth.uid() → lmm.devices → restaurant_id          (nada de identidad del payload)│
│        ▼                                                                                  │
│  schema lmm (NO expuesto por PostgREST; sin GRANT a anon/authenticated):                  │
│   restaurants · restaurant_memberships · devices · device_enrollments · inventory         │
│   orders · order_items · order_inventory_ledger · operations · stock_movements            │
│   stock_authorizations · sync_events · restaurant_event_counters · legacy_stock_movements │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Modelo de datos local (SQLite)

Principio: se **amplía** el esquema existente sin renombrar ni borrar columnas, para que `routes/*` y el frontend actuales sigan funcionando mientras se migran. Las sentencias de esta sección fueron ejecutadas en una base SQLite en memoria (sección 19.2).

### 5.1 Unidades y precisión

- Cantidades locales nuevas: **INTEGER en milésimas** (`*_milli`). 1,250 kg = `1250`.
- Conversión solo en el borde, con decimales **canónicos** (`^(0|[1-9][0-9]*)(\.[0-9]{0,2}[1-9])?$`: hasta 3 decimales, sin ceros finales, sin signo, sin exponente). Se prohíbe usar `Number` para convertir.
- `inventory.stock` (REAL) y `stock_movements.quantity` (REAL) se **conservan como caché de compatibilidad**; en V8 `stock` = `(confirmed + pendiente) / 1000` redondeado a 3 decimales y **nunca** se envía al servidor.
- Se decide escala 3 (ver decisión abierta DEC-03).

### 5.2 `inventory` (ampliada)

| Columna | Tipo | Rol |
|---|---|---|
| `id` | INTEGER PK | Identificador local (existente). Nunca viaja como global. |
| `uuid` | TEXT UNIQUE NOT NULL | `inventory_uuid` global (existente por backfill; se hace NOT NULL en migración). |
| `stock` | REAL | Caché de compatibilidad = stock provisional. |
| `stock_confirmed_milli` | INTEGER NULL | **Stock confirmado** por el servidor. `NULL` = nunca confirmado (producto no migrado). |
| `confirmed_version` | INTEGER NOT NULL DEFAULT 0 | Versión del inventario remoto con la que se obtuvo `stock_confirmed_milli`. Guarda contra eventos viejos. |

**Stock provisional** = `stock_confirmed_milli + SUM(delta_milli de movimientos con confirmation_state = 'provisional')`. Es una vista calculada, no una columna independiente (evita divergencias).

### 5.3 `stock_movements` (ampliada)

Se agregan columnas; las existentes (`quantity`, `reference_id INTEGER`, etc.) se conservan.

| Columna nueva | Tipo | Rol |
|---|---|---|
| `inventory_uuid` | TEXT | Referencia estable al producto. |
| `operation_id` | TEXT | Operación de negocio padre (NULL en movimientos legacy). |
| `line_id` | TEXT | Identidad de la línea de la intención (para ventas = `item_uuid`). |
| `kind` | TEXT | `sale`, `shortage`, `return`, `adjustment_in`, `adjustment_out`. |
| `requested_milli` / `applied_milli` / `shortage_milli` | INTEGER | Solicitado / efectivo / faltante. |
| `delta_milli` | INTEGER | Variación firmada del saldo. |
| `confirmation_state` | TEXT | `legacy`, `provisional`, `confirmed`, `rejected` (no cuenta en el saldo). |
| `origin` | TEXT | `local`, `remote` (movimiento de otro dispositivo), `legacy`. |
| `server_movement_id` | TEXT | `movement_id` autoritativo remoto, una vez confirmado. |
| `source_operation_id` | TEXT | En devoluciones: operación de venta original. |

Índice único: `UNIQUE (operation_id, line_id, kind) WHERE operation_id IS NOT NULL`. Los movimientos provisionales **se actualizan** al confirmarse; no se reemplazan ni se borran.

### 5.4 `inventory_outbox` (nueva; reemplaza a `sync_queue` solo para operaciones de inventario/pedido V8)

| Columna | Tipo | Rol |
|---|---|---|
| `outbox_id` | INTEGER PK AUTOINCREMENT | Orden local FIFO. |
| `operation_id` | TEXT UNIQUE NOT NULL | UUID v4 de la operación (generado **antes** de cualquier envío y persistido). |
| `idempotency_key` | TEXT UNIQUE NOT NULL | `"<kind>:<entity_uuid>:<device_id>:<seq>"`. |
| `op_kind` | TEXT NOT NULL | `sale`, `modify`, `return`, `cancel`, `reopen`, `adjust_in`, `adjust_out`, `catalog_upsert`. |
| `entity_type` | TEXT NOT NULL | `order` o `inventory` (mismo vocabulario que el remoto). |
| `entity_uuid` | TEXT NOT NULL | UUID del pedido o del producto. |
| `entity_seq` | INTEGER NOT NULL | Contador local por entidad (1, 2, 3…); `UNIQUE (entity_type, entity_uuid, entity_seq)`. |
| `partition_key` | TEXT NOT NULL | `order:<uuid>` o `inv:<uuid>`: las operaciones de una partición se envían en orden. |
| `depends_on_operation_id` | TEXT NULL | Dependencia explícita (p. ej. devolución que cita una venta aún no confirmada). |
| `request_payload` | TEXT NOT NULL | Sobre completo, **JSON canónico** (inmutable una vez creado). |
| `request_hash` | TEXT NOT NULL | SHA-256 del `intent` canónico. |
| `status` | TEXT NOT NULL | `pending`, `claimed`, `applied`, `retry_wait`, `dead_letter`, `conflict`. |
| `lease_owner`, `lease_expires_at`, `claimed_at` | TEXT / INTEGER | Lease del reclamo. |
| `attempts` | INTEGER | Reclamos totales (diagnóstico). |
| `server_failures` | INTEGER | Fallos transitorios **con respuesta del servidor** (base de `dead_letter`). |
| `next_attempt_at` | INTEGER | Próximo intento (ms epoch). |
| `last_error_code`, `last_error`, `http_status` | | Último error. |
| `response_payload` | TEXT | Resultado autoritativo recibido (se conserva para reprocesar). |
| `resolved_at`, `resolution_note` | INTEGER / TEXT | Cierre manual de `conflict`/`dead_letter` (14.7). |
| `created_at`, `applied_at` | INTEGER | Tiempos locales. |
| `device_id`, `restaurant_id` | TEXT NOT NULL | Contexto. |

### 5.5 Tablas locales auxiliares

| Tabla | Columnas | Rol |
|---|---|---|
| `applied_results` | `operation_id TEXT PK`, `event_seq INTEGER`, `source TEXT ('response'\|'event')`, `result_hash TEXT`, `applied_at INTEGER` | Garantiza que un resultado autoritativo se aplique **una sola vez** (respuesta o evento propio, lo que llegue primero). |
| `sync_cursor` | `restaurant_id TEXT PK`, `last_applied_seq INTEGER NOT NULL DEFAULT 0`, `updated_at INTEGER` | Cursor remoto aplicado. |
| `sync_events_local` | `event_seq INTEGER PK`, `event_id TEXT UNIQUE`, `operation_id TEXT`, `origin_device_id TEXT`, `is_own INTEGER`, `payload_hash TEXT`, `applied_at INTEGER` | Eventos ya aplicados (derivados: `is_own = origin_device_id = DEVICE_ID`). |
| `local_authorizations` | `authorization_id TEXT PK`, `scope`, `order_uuid`, `inventory_uuid`, `max_milli`, `valid_until INTEGER`, `status ('available'\|'attached'\|'used'\|'expired')` | Autorizaciones emitidas por el servidor, disponibles incluso sin conexión (ver 13.6). |

### 5.6 Estado de una operación mientras espera confirmación

El estado vive en `inventory_outbox.status` y se proyecta a la UI:

| Estado UI | Condición | Qué ve el usuario |
|---|---|---|
| **Pendiente** | outbox `pending`/`retry_wait`/`claimed`; movimientos `provisional` | Venta registrada, saldo marcado "provisional" |
| **Confirmada** | outbox `applied`, resultado igual al provisional | Saldo confirmado |
| **Confirmada con ajuste** | `applied` pero `applied_milli`/`shortage_milli` distintos del provisional | Aviso "se descontó X, faltante Y" |
| **Rechazada / Conflicto** | outbox `conflict` | Requiere revisión manual; el pedido **no se borra** |
| **Bloqueada** | outbox `dead_letter` | Requiere soporte; la partición queda detenida |

### 5.7 Transacción local de una venta (sin HTTP)

En **una** transacción `better-sqlite3`: (1) crear/actualizar pedido e ítems locales; (2) calcular el efecto provisional con la **misma función pura** que usa el servidor (`computeSaleEffect(stock_provisional_milli, qty_milli, hasAuthorization)`); (3) insertar movimientos `provisional` (`sale` y, si corresponde, `shortage`); (4) refrescar la caché `inventory.stock`; (5) insertar la fila de `inventory_outbox` con el sobre canónico. Si algo falla, todo se revierte. El envío ocurre después, desde el motor.

---

## 6. Modelo de datos remoto (PostgreSQL / Supabase)

Todas las tablas viven en el schema **`lmm`**, que **no** está en la lista de schemas expuestos de PostgREST y sobre el que `anon`/`authenticated` no tienen `USAGE`. El acceso es únicamente mediante las funciones `public.lmm_*` (secciones 8 y 18). Propietario de schema, tablas y funciones: rol `NOLOGIN` **`lmm_owner`** (si Supabase impide crearlo o usarlo, se acepta `postgres` como propietario — decisión DEC-05, a validar en staging).

Convenciones: toda tabla tiene `restaurant_id`; **toda PK y UNIQUE de negocio incluye `restaurant_id`** (evita que un conflicto revele la existencia de datos de otro restaurante); cantidades `NUMERIC(14,3)`; dinero `NUMERIC(14,2)`; tiempos `timestamptz` generados por el servidor (`created_at`) con el reloj del dispositivo solo como dato informativo (`client_created_at`).

### 6.1 DDL

```sql
CREATE SCHEMA lmm AUTHORIZATION lmm_owner;

-- ── Restaurantes y contador de eventos ───────────────────────────────────
CREATE TABLE lmm.restaurants (
  restaurant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lmm.restaurant_event_counters (
  restaurant_id    uuid PRIMARY KEY REFERENCES lmm.restaurants(restaurant_id) ON DELETE RESTRICT,
  last_event_seq   bigint NOT NULL DEFAULT 0 CHECK (last_event_seq >= 0),
  min_retained_seq bigint NOT NULL DEFAULT 1 CHECK (min_retained_seq >= 1)
);
-- La fila de control nace con el restaurante (trigger) y, por defensa,
-- la RPC hace INSERT ... ON CONFLICT DO NOTHING antes de incrementar.
CREATE FUNCTION lmm.tg_restaurant_counter() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  INSERT INTO lmm.restaurant_event_counters (restaurant_id) VALUES (NEW.restaurant_id)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER restaurants_counter AFTER INSERT ON lmm.restaurants
  FOR EACH ROW EXECUTE FUNCTION lmm.tg_restaurant_counter();

-- ── Identidad ────────────────────────────────────────────────────────────
CREATE TABLE lmm.restaurant_memberships (
  membership_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id        uuid NOT NULL REFERENCES lmm.restaurants(restaurant_id),
  auth_user_id         uuid NOT NULL,            -- auth.users.id (sin FK: ver 13.1)
  role                 text NOT NULL CHECK (role IN ('owner','admin','manager','cashier','waiter')),
  display_name         text NOT NULL,
  approval_pin_hash    text,                     -- bcrypt (extensions.crypt); solo owner/admin
  pin_failed_attempts  integer NOT NULL DEFAULT 0,
  pin_locked_until     timestamptz,
  active               boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  revoked_at           timestamptz,
  UNIQUE (restaurant_id, auth_user_id),
  UNIQUE (restaurant_id, membership_id),
  CHECK (active = (revoked_at IS NULL))
);

CREATE TABLE lmm.devices (
  device_id                  uuid PRIMARY KEY,
  restaurant_id              uuid NOT NULL REFERENCES lmm.restaurants(restaurant_id),
  auth_user_id               uuid NOT NULL UNIQUE,   -- cuenta Supabase Auth propia del dispositivo
  label                      text NOT NULL,
  status                     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  enrolled_by_membership_id  uuid NOT NULL,
  last_ack_seq               bigint NOT NULL DEFAULT 0,
  last_seen_at               timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  revoked_at                 timestamptz,
  revoked_by_membership_id   uuid,
  UNIQUE (restaurant_id, device_id),
  FOREIGN KEY (restaurant_id, enrolled_by_membership_id)
    REFERENCES lmm.restaurant_memberships(restaurant_id, membership_id),
  CHECK ((status = 'active') = (revoked_at IS NULL))
);

CREATE TABLE lmm.device_enrollments (
  enrollment_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id            uuid NOT NULL REFERENCES lmm.restaurants(restaurant_id),
  code_hash                text NOT NULL UNIQUE,     -- sha256 del código de un solo uso
  label                    text NOT NULL,
  created_by_membership_id uuid NOT NULL,
  expires_at               timestamptz NOT NULL,
  consumed_at              timestamptz,
  consumed_by_device_id    uuid,
  FOREIGN KEY (restaurant_id, created_by_membership_id)
    REFERENCES lmm.restaurant_memberships(restaurant_id, membership_id)
);

-- ── Inventario, pedidos y ledger ─────────────────────────────────────────
CREATE TABLE lmm.inventory (
  restaurant_id  uuid NOT NULL REFERENCES lmm.restaurants(restaurant_id),
  inventory_uuid uuid NOT NULL,
  name           text NOT NULL,
  unit           text NOT NULL DEFAULT 'unidad',
  stock          numeric(14,3) NOT NULL DEFAULT 0,      -- puede ser negativo (sin CHECK >= 0)
  version        bigint NOT NULL DEFAULT 1,
  deleted        boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, inventory_uuid)
);

CREATE TABLE lmm.orders (
  restaurant_id         uuid NOT NULL REFERENCES lmm.restaurants(restaurant_id),
  order_uuid            uuid NOT NULL,
  version               bigint NOT NULL DEFAULT 1,
  status                text NOT NULL CHECK (status IN ('open','cancelled')),
  snapshot              jsonb NOT NULL DEFAULT '{}'::jsonb,   -- tipo, mesa, cliente, totales, estado operativo local
  created_by_device_id  uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, order_uuid),
  FOREIGN KEY (restaurant_id, created_by_device_id) REFERENCES lmm.devices(restaurant_id, device_id)
);

CREATE TABLE lmm.order_items (
  restaurant_id  uuid NOT NULL,
  item_uuid      uuid NOT NULL,
  order_uuid     uuid NOT NULL,
  item_type      text NOT NULL CHECK (item_type IN ('menu','inventory')),
  inventory_uuid uuid,
  name           text NOT NULL,
  unit_price     numeric(14,2) NOT NULL CHECK (unit_price >= 0),
  qty            numeric(14,3) NOT NULL CHECK (qty > 0),
  line_total     numeric(14,2) NOT NULL,                -- calculado por el servidor: unit_price * qty
  note           text,
  deleted        boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, item_uuid),
  FOREIGN KEY (restaurant_id, order_uuid) REFERENCES lmm.orders(restaurant_id, order_uuid),
  FOREIGN KEY (restaurant_id, inventory_uuid) REFERENCES lmm.inventory(restaurant_id, inventory_uuid),
  CHECK ((item_type = 'inventory') = (inventory_uuid IS NOT NULL))
);
CREATE INDEX order_items_order_ix ON lmm.order_items (restaurant_id, order_uuid);

-- Ledger por (pedido, producto): serializa devoluciones/cancelaciones y respalda con CHECK.
CREATE TABLE lmm.order_inventory_ledger (
  restaurant_id    uuid NOT NULL,
  order_uuid       uuid NOT NULL,
  inventory_uuid   uuid NOT NULL,
  requested_net    numeric(14,3) NOT NULL DEFAULT 0 CHECK (requested_net >= 0),   -- unidades que el pedido CONTIENE (no cambia con devoluciones explícitas)
  discounted_total numeric(14,3) NOT NULL DEFAULT 0 CHECK (discounted_total >= 0), -- efectivamente descontado
  returned_total   numeric(14,3) NOT NULL DEFAULT 0 CHECK (returned_total >= 0),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, order_uuid, inventory_uuid),
  FOREIGN KEY (restaurant_id, order_uuid) REFERENCES lmm.orders(restaurant_id, order_uuid),
  FOREIGN KEY (restaurant_id, inventory_uuid) REFERENCES lmm.inventory(restaurant_id, inventory_uuid),
  CHECK (returned_total <= discounted_total)
);

-- ── Operaciones (idempotencia) ───────────────────────────────────────────
CREATE TABLE lmm.operations (
  restaurant_id     uuid NOT NULL REFERENCES lmm.restaurants(restaurant_id),
  operation_id      uuid NOT NULL,
  idempotency_key   text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  op_kind           text NOT NULL CHECK (op_kind IN
                      ('sale','modify','return','cancel','reopen','adjust_in','adjust_out','catalog_upsert')),
  entity_type       text NOT NULL CHECK (entity_type IN ('order','inventory')),
  entity_uuid       uuid NOT NULL,
  device_id         uuid NOT NULL,
  intent            jsonb NOT NULL,                     -- contenido canónico e inmutable de la solicitud
  payload_hash      text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  operation_status  text NOT NULL CHECK (operation_status IN ('processing','applied','rejected')),
  reject_code       text,
  result_payload    jsonb NOT NULL,                     -- resultado autoritativo (lo calculado por el servidor)
  event_seq         bigint,
  client_created_at timestamptz,
  client_actor      text,                               -- informativo, NO confiable
  created_at        timestamptz NOT NULL DEFAULT now(),
  applied_at        timestamptz,
  PRIMARY KEY (restaurant_id, operation_id),
  CONSTRAINT operations_idem_uk UNIQUE (restaurant_id, idempotency_key),
  FOREIGN KEY (restaurant_id, device_id) REFERENCES lmm.devices(restaurant_id, device_id),
  CHECK ((operation_status = 'applied')  = (event_seq IS NOT NULL)),
  CHECK ((operation_status = 'rejected') = (reject_code IS NOT NULL))
);
CREATE INDEX operations_entity_ix ON lmm.operations (restaurant_id, entity_type, entity_uuid);

-- 'processing' solo existe dentro de la transacción: no puede sobrevivir al COMMIT.
CREATE FUNCTION lmm.tg_operations_not_processing() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_status text;
BEGIN
  -- NEW es la imagen de la fila EN EL EVENTO que disparó el trigger. En un trigger diferido, el evento del
  -- INSERT conserva la imagen 'processing' aunque la fila se haya actualizado después en la misma transacción;
  -- por eso NO se usa NEW: se consulta el estado FINAL persistido por clave (V8.1, hallazgo C-01).
  SELECT o.operation_status INTO v_status
    FROM lmm.operations o
   WHERE o.restaurant_id = NEW.restaurant_id AND o.operation_id = NEW.operation_id;
  IF v_status = 'processing' THEN
    RAISE EXCEPTION 'operation_left_processing' USING ERRCODE = 'PT500';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER operations_not_processing AFTER INSERT OR UPDATE ON lmm.operations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION lmm.tg_operations_not_processing();

-- ── Autorizaciones administrativas ───────────────────────────────────────
CREATE TABLE lmm.stock_authorizations (
  restaurant_id            uuid NOT NULL,
  authorization_id         uuid NOT NULL,
  scope                    text NOT NULL CHECK (scope IN ('negative_stock','adjustment')),
  issued_by_membership_id  uuid NOT NULL,
  issued_to_device_id      uuid NOT NULL,
  order_uuid               uuid,                       -- NULL = cualquier pedido del dispositivo
  inventory_uuid           uuid,                       -- obligatorio para 'adjustment'
  max_quantity             numeric(14,3) CHECK (max_quantity > 0),
  issued_at                timestamptz NOT NULL DEFAULT now(),
  valid_until              timestamptz NOT NULL,
  status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active','consumed','revoked')),
  consumed_by_operation_id uuid,
  consumed_at              timestamptz,
  offline_grace            boolean NOT NULL DEFAULT false,   -- solo los vales pre-emitidos para uso offline tienen gracia (V8.1, A-03)
  PRIMARY KEY (restaurant_id, authorization_id),
  FOREIGN KEY (restaurant_id, issued_by_membership_id) REFERENCES lmm.restaurant_memberships(restaurant_id, membership_id),
  FOREIGN KEY (restaurant_id, issued_to_device_id)     REFERENCES lmm.devices(restaurant_id, device_id),
  CHECK (scope <> 'adjustment' OR inventory_uuid IS NOT NULL),
  CHECK ((status = 'consumed') = (consumed_by_operation_id IS NOT NULL))
);

-- ── Movimientos ──────────────────────────────────────────────────────────
CREATE TABLE lmm.stock_movements (
  restaurant_id            uuid NOT NULL,
  movement_id              uuid NOT NULL,
  operation_id             uuid NOT NULL,
  line_id                  uuid NOT NULL,
  kind                     text NOT NULL CHECK (kind IN ('sale','shortage','return','adjustment_in','adjustment_out')),
  inventory_uuid           uuid NOT NULL,
  order_uuid               uuid,
  source_operation_id      uuid,                       -- devoluciones: venta original
  requested_qty            numeric(14,3) NOT NULL CHECK (requested_qty >= 0),
  applied_qty              numeric(14,3) NOT NULL CHECK (applied_qty >= 0),
  shortage_qty             numeric(14,3) NOT NULL DEFAULT 0 CHECK (shortage_qty >= 0),
  stock_delta              numeric(14,3) NOT NULL,
  stock_before             numeric(14,3) NOT NULL,
  stock_after              numeric(14,3) NOT NULL,
  reason_code              text,
  reason_text              text,
  authorization_id         uuid,
  authorized_by_membership_id uuid,
  authorized_by_name       text,                       -- copia del display_name del autorizador al momento
  device_id                uuid NOT NULL,
  client_actor             text,                       -- informativo, NO confiable
  client_created_at        timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, movement_id),
  CONSTRAINT movements_line_uk UNIQUE (restaurant_id, operation_id, line_id, kind),
  FOREIGN KEY (restaurant_id, operation_id)      REFERENCES lmm.operations(restaurant_id, operation_id),
  FOREIGN KEY (restaurant_id, inventory_uuid)    REFERENCES lmm.inventory(restaurant_id, inventory_uuid),
  FOREIGN KEY (restaurant_id, device_id)         REFERENCES lmm.devices(restaurant_id, device_id),
  FOREIGN KEY (restaurant_id, authorization_id)  REFERENCES lmm.stock_authorizations(restaurant_id, authorization_id),
  CHECK (stock_after = stock_before + stock_delta),
  CHECK (CASE kind
           WHEN 'sale'           THEN stock_delta = -applied_qty AND applied_qty <= requested_qty
           WHEN 'shortage'       THEN stock_delta = 0 AND applied_qty = 0
           WHEN 'return'         THEN stock_delta =  applied_qty AND source_operation_id IS NOT NULL
           WHEN 'adjustment_in'  THEN stock_delta =  applied_qty AND reason_code IS NOT NULL AND authorization_id IS NOT NULL
           WHEN 'adjustment_out' THEN stock_delta = -applied_qty AND reason_code IS NOT NULL AND authorization_id IS NOT NULL
         END)
);
CREATE INDEX movements_inv_ix    ON lmm.stock_movements (restaurant_id, inventory_uuid, created_at);
CREATE INDEX movements_order_ix  ON lmm.stock_movements (restaurant_id, order_uuid, inventory_uuid, kind);
CREATE INDEX movements_source_ix ON lmm.stock_movements (restaurant_id, source_operation_id, inventory_uuid) WHERE kind = 'return';

-- ── Eventos ──────────────────────────────────────────────────────────────
CREATE TABLE lmm.sync_events (
  restaurant_id uuid NOT NULL,
  event_seq     bigint NOT NULL CHECK (event_seq > 0),
  event_id      uuid NOT NULL DEFAULT gen_random_uuid(),
  event_type    text NOT NULL CHECK (event_type IN ('operation.applied')),
  entity_type   text NOT NULL,
  entity_uuid   uuid NOT NULL,
  operation_id  uuid NOT NULL,
  device_id     uuid NOT NULL,                         -- dispositivo de ORIGEN
  payload       jsonb NOT NULL,                        -- resultado autoritativo
  payload_hash  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, event_seq),
  UNIQUE (restaurant_id, event_id),
  UNIQUE (restaurant_id, operation_id),
  FOREIGN KEY (restaurant_id, operation_id) REFERENCES lmm.operations(restaurant_id, operation_id),
  FOREIGN KEY (restaurant_id, device_id)    REFERENCES lmm.devices(restaurant_id, device_id)
);

-- ── Archivo histórico (migración; sin efecto sobre saldos) ───────────────
CREATE TABLE lmm.legacy_stock_movements (
  restaurant_id  uuid NOT NULL REFERENCES lmm.restaurants(restaurant_id),
  device_id      uuid NOT NULL,
  legacy_uuid    text NOT NULL,
  inventory_uuid uuid,
  legacy_payload jsonb NOT NULL,
  imported_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, device_id, legacy_uuid)
);

CREATE TABLE lmm.app_config (
  key text PRIMARY KEY, value jsonb NOT NULL
);  -- min_client_version, authorization_grace_hours (48), events_retention_days (30), ...
```

### 6.2 Notas sobre el DDL

- **Sin FK a `auth.users`:** crear una FK hacia el schema `auth` exige privilegios que Supabase gestionado puede no conceder. La existencia del usuario se valida en el enrolamiento (sección 13.1). Es una decisión consciente, no un olvido.
- **Dispositivos en cadena de FK:** `orders`, `operations`, `movements`, `sync_events` referencian `(restaurant_id, device_id)`, por eso un dispositivo **nunca se borra**, solo se revoca.
- **`stock` sin `CHECK >= 0`:** el saldo negativo es un estado válido por regla comercial 4.3.
- **`lmm.legacy_stock_movements`** conserva trazabilidad histórica sin tocar saldos.

---

## 7. Contratos de operaciones

### 7.1 Identidades (separadas y con propósito único)

| Identidad | Quién la genera | Propósito | Formato | Dónde es única |
|---|---|---|---|---|
| `operation_id` | Cliente (antes de enviar; persistida en outbox) | Identidad de **una** operación de negocio | UUID v4 | `lmm.operations (restaurant_id, operation_id)` |
| `idempotency_key` | Cliente | Detectar el **mismo propósito de negocio** emitido dos veces con `operation_id` distintos (doble clic, doble encolado). Formato `"<kind>:<entity_uuid>:<device_id>:<seq>"` | texto 8–200 | `lmm.operations (restaurant_id, idempotency_key)` |
| `line_id` | Cliente (= `item_uuid` en ventas; UUID por línea en devoluciones) | Identidad de la línea dentro de la intención | UUID v4 | `lmm.stock_movements (restaurant_id, operation_id, line_id, kind)` |
| `movement_id` | **Servidor**: `line_id` para el movimiento principal; `derive_uuid('shortage', line_id)` para el faltante; derivados deterministas en `modify/cancel/reopen` | Identidad del movimiento | UUID | `lmm.stock_movements (restaurant_id, movement_id)` |
| `payload_hash` | Servidor (y cliente, para verificar) | SHA-256 del **intent canónico** | hex 64 | `lmm.operations.payload_hash` |
| `event_id` / `event_seq` | Servidor | Identidad y orden del evento | UUID / bigint | `lmm.sync_events` |
| `device_id` | Servidor (enrolamiento) | Identidad del dispositivo, **vinculada** a `auth.uid()` | UUID | `lmm.devices` |

`idempotency_key` **no** es una identidad independiente del cliente: es una red de seguridad. Cambiarla no permite reaplicar una operación (la unicidad real es `operation_id`).

### 7.2 Sobre (envelope) de `lmm_apply_operation`

```json
{
  "schema_version": 1,
  "operation_id": "6f1c0f0e-5d57-4a52-9d0c-0e3f0f3b8a11",
  "idempotency_key": "sale:2b8c…:a3b1…:0",
  "device_id": "a3b1…",
  "client_created_at": "2026-11-21T14:03:11.120Z",
  "client_actor": "María (cajera)",
  "intent": { "kind": "sale", "...": "..." }
}
```

- Claves de primer nivel permitidas: exactamente las anteriores. **Cualquier otra clave se rechaza** (`PT422 unknown_envelope_key`).
- **No existe** `restaurant_id`, `role`, `is_admin`, `authorized_by`, `user_role` ni timestamps autoritativos. `device_id` se incluye solo para **verificar** que coincide con el dispositivo vinculado a `auth.uid()`; no se usa para decidir nada.
- `client_actor` y `client_created_at` son informativos y se guardan marcados como no confiables.

### 7.3 Qué pertenece al payload de entrada y qué es resultado (E2)

| Pertenece al **intent** (hasheado, inmutable) | **Resultado del servidor** (nunca en el hash, nunca aceptado del cliente) |
|---|---|
| `kind`, `entity_type`, `entity_uuid` | `operation_status`, `reject_code` |
| `expected_version` | versión del pedido tras aplicar, `order.status` resultante |
| `items[]` (`item_uuid`, `item_type`, `inventory_uuid`, `name`, `unit_price`, `qty`, `note`), `snapshot` | `line_total`, `subtotal` |
| `lines[]` (`line_id`, `inventory_uuid`, `source_operation_id`, `qty`, `reason_text`) | `applied_qty`, `shortage_qty`, `stock_delta`, `stock_before`, `stock_after` |
| `qty`, `reason_code`, `reason_text`, `reference` (ajustes) | `movement_id` derivados, `inventory.version` |
| `authorization_id` | `authorized_by_*`, consumo de la autorización |
| — | `event_seq`, `created_at`, `applied_at` |

Excluidos del hash por ser metadatos del sobre: `operation_id` (se compara por PK), `idempotency_key` (se compara aparte), `device_id` (se compara contra el dispositivo almacenado), `client_created_at`, `client_actor`, `schema_version` (debe ser 1).

### 7.4 JSON canónico (`canonical_json`) — normativo

Cliente y servidor **deben** producir los mismos bytes. Reglas:

1. Codificación UTF-8, sin BOM, sin espacios ni saltos de línea fuera de los strings.
2. Objetos: claves ordenadas por **orden binario de bytes UTF-8** (`COLLATE "C"` en PostgreSQL; `Buffer.compare` en Node). Claves duplicadas prohibidas.
3. Arrays: se conserva el orden.
4. Strings: escape JSON estándar mínimo: `\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, y `\u00xx` (hex **minúscula**) para el resto de caracteres de control; los demás caracteres (incluidos no ASCII) **sin escapar**; sin normalización Unicode.
5. Números JSON: **solo enteros** (`schema_version`, `expected_version`). Cantidades y dinero viajan como **strings decimales canónicos** (cantidad: `^(0|[1-9][0-9]*)(\.[0-9]{0,2}[1-9])?$`; dinero: `^(0|[1-9][0-9]*)(\.[0-9]?[1-9])?$`). Un número no entero o un decimal no canónico se rechaza con `PT422`.
6. `true`, `false`, `null` en minúscula.

`jsonb::text` **no** es canónico (reordena claves por longitud, agrega espacios) y por eso V7 no podía hashear con él. La implementación PostgreSQL está en 18.1; la de Node (verificada) en 19.2. Se exigen vectores de prueba compartidos (pruebas PR-01…PR-06).

### 7.5 Intents por operación

Todos llevan `kind`, `entity_type`, `entity_uuid`. Los campos `authorization_id` son `null` o UUID de una autorización emitida por el servidor (13.5).

**Venta — `sale`** (crea el pedido y descuenta; `expected_version` debe ser `0`):

```json
{ "kind": "sale", "entity_type": "order", "entity_uuid": "<order_uuid>", "expected_version": 0,
  "snapshot": { "order_type": "mesa", "table_ref": "12", "local_status": "preparing" },
  "items": [
    { "item_uuid": "<uuid>", "item_type": "inventory", "inventory_uuid": "<uuid>", "name": "Coca 500", "unit_price": "2500", "qty": "2", "note": null },
    { "item_uuid": "<uuid>", "item_type": "menu", "inventory_uuid": null, "name": "Milanesa", "unit_price": "8900", "qty": "1", "note": "sin sal" } ],
  "authorization_id": null }
```

**Modificación — `modify`** (conjunto **completo** deseado de ítems; el servidor calcula las diferencias):

```json
{ "kind": "modify", "entity_type": "order", "entity_uuid": "<order_uuid>", "expected_version": 3,
  "snapshot": { }, "items": [ "…lista completa deseada…" ], "authorization_id": null }
```

**Devolución — `return`**:

```json
{ "kind": "return", "entity_type": "order", "entity_uuid": "<order_uuid>",
  "lines": [ { "line_id": "<uuid>", "inventory_uuid": "<uuid>", "source_operation_id": "<operation_id de la venta original>", "qty": "1.5", "reason_text": "producto en mal estado" } ],
  "authorization_id": null }
```

**Cancelación — `cancel`** (el servidor reintegra lo efectivamente descontado y aún no devuelto):

```json
{ "kind": "cancel", "entity_type": "order", "entity_uuid": "<order_uuid>", "expected_version": 4 }
```

**Reapertura — `reopen`** (el servidor vuelve a aplicar la regla de venta sobre los ítems vigentes del pedido):

```json
{ "kind": "reopen", "entity_type": "order", "entity_uuid": "<order_uuid>", "expected_version": 5, "authorization_id": null }
```

**Ajuste positivo / negativo — `adjust_in` / `adjust_out`** (cantidad **siempre positiva**; el signo lo da el `kind`):

```json
{ "kind": "adjust_out", "entity_type": "inventory", "entity_uuid": "<inventory_uuid>", "qty": "3",
  "reason_code": "damage", "reason_text": "rotura en cámara fría", "reference": "ACTA-118", "authorization_id": "<uuid>" }
```

`reason_code` ∈ `count_correction`, `damage`, `expiry`, `theft`, `opening_balance`, `transfer`, `other`. `reason_text` obligatorio (3–500 caracteres). `authorization_id` **obligatorio**.

**Alta/edición de catálogo — `catalog_upsert`** (nunca toca el stock; un producto nuevo nace con saldo 0 y su saldo inicial se establece con un ajuste `opening_balance`):

```json
{ "kind": "catalog_upsert", "entity_type": "inventory", "entity_uuid": "<inventory_uuid>", "name": "Coca 500", "unit": "unidad" }
```

**No existe ninguna operación genérica con `stock_delta`.** Ningún `kind` acepta `stock`, `stock_delta`, `applied_qty`, `shortage_qty` ni `quantity` firmada.

### 7.6 Límites de validación

Máximo 200 líneas por operación; `qty` entre `0,001` y `1.000.000`; `unit_price` ≤ `99.999.999,99`; `snapshot` ≤ 64 KB; sobre ≤ 256 KB; UUID v4 con regex estricta; strings sin `\u0000`. Cualquier violación: `PT422 invalid_intent` con la ruta (`$.items[3].qty`).

### 7.7 Contrato de salida (resultado autoritativo)

```json
{
  "schema_version": 1,
  "operation_id": "…",
  "op_kind": "sale",
  "operation_status": "applied",
  "reject_code": null,
  "replayed": false,
  "deduplicated_of": null,
  "event_seq": 128,
  "order": { "order_uuid": "…", "version": 1, "status": "open",
             "items": [ { "item_uuid": "…", "item_type": "inventory", "inventory_uuid": "…", "name": "Coca 500", "unit_price": "2500", "qty": "4", "line_total": "10000", "deleted": false } ] },
  "movements": [
    { "movement_id": "…", "line_id": "…", "kind": "sale", "inventory_uuid": "…",
      "requested_qty": "4", "applied_qty": "1", "shortage_qty": "3", "stock_delta": "-1",
      "stock_before": "1", "stock_after": "0" },
    { "movement_id": "…", "line_id": "…", "kind": "shortage", "inventory_uuid": "…",
      "requested_qty": "4", "applied_qty": "0", "shortage_qty": "3", "stock_delta": "0",
      "stock_before": "0", "stock_after": "0" } ],
  "inventory": [ { "inventory_uuid": "…", "stock": "0", "version": 9 } ],
  "authorization": { "authorization_id": null, "consumed": false, "authorized_by": null }
}
```

- Cantidades siempre como **string decimal** (nunca `float`).
- `replayed: true` cuando es un reintento idéntico (se devuelve exactamente el `result_payload` guardado; solo cambian `replayed`/`deduplicated_of`).
- `deduplicated_of`: `operation_id` original cuando otra `operation_id` distinta, con la misma `idempotency_key` y el mismo contenido, ya fue aplicada. El cliente aplica **ese** resultado, descarta (`rejected`) los movimientos provisionales de su propia operación (que no tuvo efecto) y marca su fila de outbox como `applied` (ver 16.2, paso 1). Solo se deduplica dentro del mismo dispositivo.
- `order.items` se incluye en `sale`, `modify` y `reopen` (contenido autoritativo del pedido para otros dispositivos); se omite en el resto.
- Para `operation_status = "rejected"`: `reject_code` y `details`, sin `event_seq` ni movimientos.
- `inventory[].stock` es el saldo **confirmado** tras la operación y `version` la versión del inventario; son lo que usa la reconciliación (sección 16).

### 7.8 Rechazos y errores

**Rechazos de negocio** (HTTP 200, `operation_status = "rejected"`, **persistidos**; el reintento devuelve el mismo rechazo):

| `reject_code` | Cuándo |
|---|---|
| `order_already_exists` | `sale` sobre un `order_uuid` ya existente |
| `order_not_found` | `modify/return/cancel/reopen` sobre pedido inexistente |
| `order_not_open` | `modify/cancel` sobre pedido cancelado |
| `order_not_cancelled` | `reopen` sobre pedido no cancelado |
| `order_version_conflict` | `expected_version` ≠ versión actual (`details.current_version`) |
| `inventory_not_found` | producto inexistente o borrado |
| `authorization_invalid` | `details.reason`: `missing`, `not_found`, `expired`, `consumed`, `revoked`, `wrong_device`, `wrong_scope`, `wrong_order`, `wrong_inventory`, `quantity_exceeds`, `issuer_inactive` |
| `source_operation_invalid` | la venta citada no existe, no es de ese pedido o no fue aplicada |
| `return_exceeds_remaining` | devolución mayor al remanente retornable (`details.remaining`) |

**Errores (excepciones SQL; no se persiste nada; PostgREST los traduce a HTTP por `PTnnn`)**:

| SQLSTATE | HTTP | Mensaje | Tratamiento del cliente |
|---|---|---|---|
| `PT401` | 401 | `unauthenticated` | renovar sesión y reintentar (no cuenta como fallo) |
| `PT403` | 403 | `device_not_authorized` | `dead_letter` con código `device_revoked_or_unbound` |
| `PT409` | 409 | `operation_id_reused_with_different_content`, `idempotency_key_reused_with_different_content`, `line_id_belongs_to_other_operation`, `operation_device_mismatch` | `dead_letter` (manipulación o bug); alerta |
| `PT422` | 422 | `invalid_intent: <ruta>`, `unknown_envelope_key`, `unsupported_schema_version` | `dead_letter` (bug del cliente) |
| `55P03`, `40P01`, `40001`, `57014` | 5xx | bloqueo no disponible, deadlock, serialización, timeout | transitorio → `retry_wait` |
| `PT500` | 500 | `internal_error` | transitorio acotado |

La verificación de que PostgREST asigna HTTP desde `PTnnn` y expone `code`/`message` se hace en staging (riesgo R-09).

---

## 8. RPC principal: `public.lmm_apply_operation(p_request jsonb) RETURNS jsonb`

Una sola función, una sola transacción (la de la petición PostgREST). **Sin `BEGIN/COMMIT` explícitos**; cualquier excepción revierte todo. `SECURITY DEFINER`, `SET search_path = ''`, `SET lock_timeout = '3s'`, `SET statement_timeout = '15s'`. El código completo está en 18.3–18.7.

### 8.1 Pipeline (los diez pasos requeridos)

| # | Paso | Fase |
|---|---|---|
| 0 | Identidad: `auth.uid()` → `lmm.devices` activo → `restaurant_id`; verificar `device_id` del sobre | — |
| 1 | Validar forma del sobre e intent; canonicalizar y hashear el intent | — |
| 2 | **Insertar la operación** (`ON CONFLICT DO NOTHING`, `GET DIAGNOSTICS ROW_COUNT`): nueva / repetida / clave reutilizada | Idempotencia |
| 3 | Si es repetida: comparar identidad y hash; devolver `result_payload` o `PT409` | Idempotencia |
| 4 | **Fase A — validar y bloquear** (puede *rechazar*; no escribe nada de negocio): validar pedido y versión esperada, detectar conflicto de edición, validar autorización, bloquear recursos en el orden global | A |
| 5 | **Fase B — aplicar** (no puede rechazar; solo errores de sistema): actualizar pedido e ítems, ledger, inventario | B |
| 6 | Registrar movimientos | B |
| 7 | Asignar `event_seq` (contador bloqueado hasta el commit) | B |
| 8 | Insertar el evento con el resultado autoritativo | B |
| 9 | Finalizar la fila de `operations` (`applied`, `result_payload`, `event_seq`) | B |
| 10 | Devolver el resultado | — |

**Invariante de las fases:** una vez que la Fase A termina sin rechazo, la Fase B **no tiene ramas de rechazo**; si algo falla es una excepción y la transacción completa se revierte (se deshacen operación, pedido, ledger, inventario y movimientos). Si la Fase A rechaza, solo se escribe la fila `operations` con `operation_status='rejected'`.

### 8.2 Orden global y estable de bloqueos

Todas las operaciones adquieren los bloqueos **en este orden fijo** (los pasos que no aplican se omiten):

```
1. lmm.operations           (la fila recién insertada)
2. lmm.stock_authorizations (FOR UPDATE por authorization_id)
3. lmm.orders               (FOR UPDATE; o INSERT ... ON CONFLICT DO NOTHING al crear)
4. lmm.order_inventory_ledger  (FOR UPDATE, ORDER BY inventory_uuid ASC)
5. lmm.inventory               (FOR UPDATE, ORDER BY inventory_uuid ASC)
6. lmm.restaurant_event_counters (UPDATE; se mantiene hasta el COMMIT)
```

Como todas las transacciones siguen el mismo orden total, no puede formarse un ciclo de espera ⇒ **no hay deadlocks entre operaciones de esta RPC**. `lock_timeout = 3s` protege ante esperas anómalas; el cliente trata `55P03/40P01` como transitorios. Las sentencias de bloqueo son `SELECT … FOR UPDATE` (nunca `UPDATE … FOR UPDATE`, que no existe en SQL):

```sql
-- pedido
SELECT o.version, o.status INTO v_ord_version, v_ord_status
  FROM lmm.orders o
 WHERE o.restaurant_id = v_rid AND o.order_uuid = v_order_uuid
 FOR UPDATE;

-- inventario (varios productos, orden estable)
PERFORM 1
   FROM lmm.inventory i
  WHERE i.restaurant_id = v_rid AND i.inventory_uuid = ANY (v_inv_ids)
  ORDER BY i.inventory_uuid
  FOR UPDATE;
```

(`ORDER BY` + `FOR UPDATE` adquiere los bloqueos en el orden de salida; es la práctica estándar y la que la prueba de concurrencia OR-18 debe confirmar.)

El contador de eventos se bloquea **último** y se retiene hasta el commit: eso es lo que garantiza que `event_seq` coincida con el orden de commit (15.1). El costo es que todas las operaciones de un restaurante se serializan en su tramo final; para un POS de restaurante es aceptable (R-07).

### 8.3 Aislamiento

La RPC corre en `READ COMMITTED` (valor por defecto). La corrección no depende de `SERIALIZABLE`: depende de (a) la inserción atómica de `operations`, (b) los bloqueos de fila en orden fijo y (c) las restricciones `CHECK/UNIQUE` como respaldo. Después de obtener un bloqueo se **relee** el estado (las lecturas de saldo ocurren después del `FOR UPDATE`).

---

## 9. Idempotencia

### 9.1 Campos requeridos

| Campo | Dónde | Definición |
|---|---|---|
| `operation_id` | `operations` PK `(restaurant_id, operation_id)` | Identidad de la operación |
| `idempotency_key` | `operations` UNIQUE `(restaurant_id, idempotency_key)` | Clave de negocio |
| `payload_hash` | `operations` | `sha256(canonical_json(intent))` |
| `operation_status` | `operations` | `processing` (solo intra-transacción) → `applied` \| `rejected` |
| `result_payload` | `operations` | Resultado autoritativo persistido |
| `created_at` | `operations` | Reloj del servidor al insertar |
| `applied_at` | `operations` | Reloj del servidor al finalizar `applied` |

### 9.2 Tabla de decisión (el contrato de idempotencia)

| Caso | Detección | Resultado | Efectos de stock |
|---|---|---|---|
| **Primera solicitud** | `INSERT … ON CONFLICT (restaurant_id, operation_id) DO NOTHING` → `ROW_COUNT = 1` | Se aplica | Sí, una vez |
| **Reintento idéntico** | `ROW_COUNT = 0`; fila existente con mismo `device_id`, `idempotency_key`, `op_kind`, `entity_*` y `payload_hash` | Se devuelve `result_payload` guardado (`replayed: true`); si estaba `rejected`, se devuelve el rechazo | **Ninguno** |
| **Mismo `operation_id`, contenido distinto** | `ROW_COUNT = 0` y algún campo difiere | `PT409 operation_id_reused_with_different_content` | Ninguno |
| **Mismo `operation_id`, otro dispositivo** | `ROW_COUNT = 0`, `device_id` distinto | `PT409 operation_device_mismatch` | Ninguno |
| **Otra `operation_id`, misma `idempotency_key`, mismo contenido y mismo dispositivo** | `unique_violation` sobre `operations_idem_uk` | Se devuelve el resultado de la operación original con `deduplicated_of` | Ninguno |
| **Otra `operation_id`, misma `idempotency_key`, contenido distinto** | ídem, hash distinto | `PT409 idempotency_key_reused_with_different_content` | Ninguno |
| **Una línea cita un `line_id` de otra operación** | `SELECT` previo en `stock_movements` | `PT409 line_id_belongs_to_other_operation` | Ninguno |
| **Error intermedio** | excepción en Fase B | Rollback total (operación, pedido, ledger, inventario, movimientos, evento) | Ninguno |

### 9.3 Por qué `ROW_COUNT` y no `RETURNING … INTO` + `FOUND`

V6 usaba `ON CONFLICT DO UPDATE … RETURNING`, que devuelve fila **tanto** si insertó como si actualizó (nueva y duplicada son indistinguibles). V7 cambió a `DO NOTHING` + `RETURNING`, que funciona, pero `GET DIAGNOSTICS v_rows = ROW_COUNT` expresa la intención sin depender de la semántica de `FOUND` con `RETURNING` y permite además el tercer resultado (clave de negocio duplicada) dentro del mismo bloque. V8 usa `ROW_COUNT`.

### 9.4 Dos procesos independientes con el mismo `operation_id`

1. La transacción **A** inserta la fila; la inserción en el índice único queda "pendiente" hasta que A termine.
2. La transacción **B** intenta insertar la misma clave: **espera** a que A confirme o aborte.
3. Si A **confirma**: B ejecuta `DO NOTHING` (`ROW_COUNT = 0`), y su `SELECT … FOR SHARE` siguiente (sentencia nueva ⇒ nueva instantánea en `READ COMMITTED`) ve la fila final de A ⇒ devuelve el resultado persistido.
4. Si A **aborta**: la inserción de B procede (`ROW_COUNT = 1`) y B aplica la operación; A no dejó ningún efecto.

En ningún caso B ve una fila `processing`: `processing` solo existe dentro de la transacción de A y un *constraint trigger* diferido impide que sobreviva al `COMMIT`. El trigger **consulta el estado final de la fila por su clave** (no usa `NEW`): un evento diferido conserva la imagen que tenía la fila al dispararse (para el `INSERT`, `processing`), de modo que usar `NEW` revertiría **todas** las operaciones (hallazgo C-01 de la auditoría externa). Se prueba en PostgreSQL real el camino `applied` y el `rejected` (IDM-15).

### 9.5 Idempotencia de movimientos hijos (E2)

Un movimiento solo puede crearse como parte de **su** operación, y una operación solo se aplica **una vez**. Esa es la garantía principal; las restricciones son la red de seguridad:

| Requisito | Mecanismo |
|---|---|
| Un movimiento nuevo se inserta una sola vez | `PK (restaurant_id, movement_id)` + `UNIQUE (restaurant_id, operation_id, line_id, kind)` |
| Un movimiento duplicado no vuelve a modificar el stock | Un reintento nunca llega a la Fase B: el paso 3 devuelve el resultado guardado antes de tocar stock |
| Un movimiento de otra operación no se acepta en silencio | Antes de aplicar se verifica `NOT EXISTS (SELECT 1 FROM lmm.stock_movements WHERE restaurant_id = … AND (line_id = ANY(v_ids) OR movement_id = ANY(v_ids)) AND operation_id <> v_op_id)` (con `v_ids` = identificadores del intent y los derivados); si existe ⇒ `PT409 line_id_belongs_to_other_operation` |
| Mismo identificador con contenido distinto ⇒ conflicto | El contenido de las líneas forma parte del `intent` hasheado; cualquier cambio altera `payload_hash` ⇒ `PT409` |
| `line_id` repetido dentro del mismo intent | Validación del intent (`PT422 duplicate_line_id`) |
| Rollback elimina efectos parciales | Una única transacción; sin subtransacciones que oculten errores en la Fase B |
| Hash sobre contenido de entrada, no sobre resultados | `payload_hash` cubre solo el `intent` (7.3); `applied_qty`, `shortage_qty`, `stock_delta` se calculan después y **no** participan |

`movement_id` derivado: `derive_uuid(tag, base)` = primeros 16 bytes de `sha256(tag || ':' || base)` con bits de versión (5) y variante (`10xx`) fijados. Es determinista, por lo que un reproceso hipotético generaría el mismo identificador.

---

## 10. Reglas de inventario

### 10.1 Algoritmo de venta (por línea de inventario; fuente única de verdad)

```
entrada:  stock (saldo remoto actual, ya bloqueado y releído)
          qty   (cantidad solicitada, > 0)
          autorizada (la autorización fue validada por el servidor)

disponible = MAX(stock, 0)                       -- un saldo negativo nunca es disponible
faltante   = MAX(qty − disponible, 0)            -- se registra SIEMPRE que exista
descontado = autorizada ? qty : MIN(qty, disponible)
delta      = −descontado
stock_nuevo = stock + delta
```

Propiedades que se verifican con pruebas (ST-xx): `descontado ≥ 0`; sin autorización `stock_nuevo ≥ MIN(stock, 0)` y **nunca** `stock_nuevo > stock`; sin autorización y `stock ≥ 0` ⇒ `stock_nuevo ≥ 0`; con autorización `stock_nuevo = stock − qty`.

Movimientos generados por línea: un `sale` (`requested = qty`, `applied = descontado`, `shortage = faltante`, `delta = −descontado`) y, **si `faltante > 0`**, un `shortage` separado (`requested = qty`, `applied = 0`, `shortage = faltante`, `delta = 0`, `stock_before = stock_after`). Así se distinguen cantidad solicitada, descontada y faltante, y el modelo de movimientos coincide con la prueba "dos `sale` + dos `shortage`".

### 10.2 Tabla de casos (valores exactos; son las pruebas ST de la sección 19)

| Stock | Solicitado | Autorizada | Descontado | Faltante | Delta | Stock final |
|---:|---:|:---:|---:|---:|---:|---:|
| 10 | 3 | no | 3 | 0 | −3 | 7 |
| 5 | 5 (exacto) | no | 5 | 0 | −5 | 0 |
| 0 | 2 | no | 0 | 2 | 0 | 0 |
| **−3** | **2** | **no** | **0** | **2** | **0** | **−3** |
| −3 | 2 | sí | 2 | 2 | −2 | −5 |
| 5 | 8 | no | 5 | 3 | −5 | 0 |
| 5 | 8 | sí | 8 | 3 | −8 | −3 |
| 1 | 4 | no | 1 | 3 | −1 | 0 |
| 2,500 | 1,250 | no | 1,250 | 0 | −1,250 | 1,250 |
| 0,300 | 0,500 | no | 0,300 | 0,200 | −0,300 | 0 |

### 10.3 Ejemplo del enunciado: dos dispositivos offline, stock central 5

A y B venden 4 sin conexión (cada uno calcula provisionalmente stock 1). Al reconectar, el servidor serializa:

1. **A** (primero): stock 5, solicitado 4 ⇒ descontado 4, faltante 0, final 1.
2. **B**: stock 1, solicitado 4, sin autorización ⇒ descontado **1**, faltante **3**, final **0**.

Si ambos venden 8 sin autorización con stock 5: A descuenta 5 (faltante 3) y B descuenta 0 (faltante 8); final 0. El resultado depende del **orden de llegada al servidor**, no del orden de las ventas reales; eso es inherente a "el servidor es la autoridad" y queda como riesgo R-04.

### 10.4 Una sola implementación del algoritmo en cada lado

El servidor lo implementa en `lmm.apply_sale_line` (18.4). El cliente usa `computeSaleEffect(stockMilli, qtyMilli, autorizada)` **solo para el cálculo provisional**. Ambas comparten los vectores de prueba de 10.2. Si difieren, manda el servidor (el movimiento local pasa a "confirmada con ajuste").

---

## 11. Pedidos y atomicidad

### 11.1 Modelo remoto de pedido

- `lmm.orders`: `status ∈ {open, cancelled}` y `version` (control optimista). Los estados operativos locales (preparando, listo, entregado, pagado, medio de pago, mesa) viajan en `snapshot` y **no** afectan el inventario.
- `lmm.order_items`: ítems con `qty NUMERIC(14,3)` y `line_total` calculado por el servidor (`ROUND(unit_price * qty, 2)`).
- `lmm.order_inventory_ledger` por `(pedido, producto)`: `requested_net` (unidades que el pedido **contiene**; las devoluciones explícitas no lo modifican), `discounted_total` (efectivamente descontado), `returned_total`. Derivados:
  - `efectivo_neto = discounted_total − returned_total` (unidades realmente salidas del stock),
  - `no_cumplido = requested_net − efectivo_neto` (la parte del pedido que **no está fuera del stock**: faltante o unidades ya devueltas),
  - **remanente retornable = `efectivo_neto`**.
  - Invariante: `requested_net ≥ efectivo_neto` y `returned_total ≤ discounted_total` (esta última, con `CHECK`).

Nombres de columna: el pedido se identifica **siempre** por `order_uuid` (V7 mezclaba `uuid` y `order_uuid`).

### 11.2 Semántica de cada operación sobre pedido

| `kind` | Precondiciones (Fase A) | Efecto (Fase B) | Versión del pedido |
|---|---|---|---|
| `sale` | `expected_version = 0`; el pedido no existe (la inserción `ON CONFLICT DO NOTHING` es el bloqueo de creación); productos existen; autorización válida si se envía | Crea pedido (`open`) e ítems; por cada ítem de inventario aplica 10.1; ledger `requested_net += qty`, `discounted_total += descontado` | pasa a **1** |
| `modify` | Pedido existe y está `open`; `expected_version` = actual | Upsert de ítems (los ausentes del intent se marcan `deleted`); diferencias por producto (11.3) | +1 |
| `cancel` | Pedido `open`; `expected_version` = actual | Devuelve el `efectivo_neto` de cada producto; `requested_net := 0`; estado `cancelled` | +1 |
| `reopen` | Pedido `cancelled`; `expected_version` = actual; autorización válida si se envía | Estado `open`; vuelve a aplicar 10.1 sobre los ítems **vigentes** (no `deleted`) | +1 |
| `return` | Pedido existe; fuentes válidas | Ver 12.1 | sin cambio |

Una finalización repetida (mismo `operation_id`) devuelve el resultado guardado; una segunda `sale` sobre el mismo pedido con otro `operation_id` y otra clave se rechaza con `order_already_exists`; con la misma clave y contenido, `deduplicated_of`.

Correspondencia con el POS actual: `sale` es el momento en que hoy corre `applyStockDiscount` al crear el pedido; la fusión de ítems en un pedido abierto y `POST /modify-items` son `modify`; la cancelación y la reapertura mantienen su nombre.

### 11.3 Modificación de cantidades después de una venta

El cliente envía el **conjunto deseado** de ítems (no deltas). El servidor agrupa por producto:

```
deseado[inv]  = SUM(qty) de ítems de inventario no eliminados
Para cada inv en (productos deseados ∪ productos del ledger del pedido):
    dif = deseado[inv] − ledger.requested_net

    dif > 0:  venta incremental → aplicar 10.1 con qty = dif
              (movimientos sale/shortage; ledger: requested_net += dif; discounted_total += descontado)

    dif < 0:  reducir = −dif
              no_cumplido = ledger.requested_net − (ledger.discounted_total − ledger.returned_total)
              baja_de_faltante = MIN(reducir, no_cumplido)   -- unidades que no están fuera del stock (faltante o ya devueltas)
              a_devolver       = reducir − baja_de_faltante  -- ≤ efectivo_neto, por construcción
              ledger.requested_net −= reducir
              si a_devolver > 0: devolver FIFO por operación fuente (12.1) y returned_total += a_devolver
```

Reducir primero el faltante evita "devolver" al stock unidades que nunca se descontaron (que inflaría el saldo).

### 11.4 Control de versión optimista y conflicto de edición

`expected_version` es la versión del pedido que el cliente vio. Si no coincide: **rechazo persistido** `order_version_conflict` con `details.current_version`. El cliente debe refrescar el pedido y emitir una **nueva** operación (nuevo `operation_id`, nuevo `entity_seq`). El rechazo no consume autorizaciones ni genera evento.

### 11.5 Comportamiento ante concurrencia (determinista por bloqueos)

| Escenario | Resolución |
|---|---|
| **Dos `modify` simultáneos del mismo pedido** (ambos esperan v3) | Ambos piden `FOR UPDATE` sobre el pedido; el primero en obtenerlo aplica (v3→v4). El segundo, al obtener el bloqueo, relee v4 ≠ 3 ⇒ `order_version_conflict`. Ningún efecto de stock del segundo. |
| **`cancel` concurrente con `sale` del mismo pedido** | Una `sale` solo crea; un `cancel` exige que el pedido exista. Si la `sale` gana el bloqueo de creación, el `cancel` (esperando) ve el pedido `open` y devuelve lo descontado. Si el `cancel` llega primero ⇒ `order_not_found` (rechazo persistido); la `sale` posterior crea un pedido nuevo normalmente. |
| **`cancel` concurrente con `modify`** | Serializados por el bloqueo del pedido. Gana uno: si `cancel` primero, `modify` ve `cancelled` ⇒ `order_not_open`; si `modify` primero, `cancel` ve versión nueva ⇒ `order_version_conflict` (el cliente reintenta con la versión actual). |
| **`reopen` concurrente con `cancel`** | Ídem: el segundo ve estado/versión distintos ⇒ `order_not_cancelled` o `order_version_conflict`. Nunca se reabre un pedido ya abierto ni se cancela uno ya cancelado. |
| **Reintento de finalización** | Mismo `operation_id` ⇒ `replayed`; otro `operation_id` con la misma clave ⇒ `deduplicated_of`; sin clave igual ⇒ `order_already_exists`. Nunca se descuenta dos veces. |
| **`modify` después de la venta** | 11.3; el stock se ajusta por la diferencia, no se reaplica la venta completa. |
| **Falla después de actualizar el pedido** (p. ej. violación de `CHECK` en inventario) | Excepción ⇒ rollback de **toda** la transacción: el pedido, los ítems, el ledger, los movimientos y la fila de `operations` desaparecen; el cliente reintenta con el mismo `operation_id` como si fuera la primera vez. |
| **Cancelación + `return` concurrentes** | El `return` toma el bloqueo del pedido; el que llega segundo ve el ledger actualizado; si `cancel` ganó, el remanente es 0 ⇒ `return_exceeds_remaining`. |

### 11.6 Integración con las tablas de V7

V7 listaba `orders_sync`, `order_items_sync`, `order_operations_sync`, `inventory_sync`, `inventory_movements_sync`, `inventory_operations`, `sync_events`. En V8 equivalen a: `lmm.orders`, `lmm.order_items`, `lmm.operations` (absorbe `order_operations_sync` e `inventory_operations`: una sola tabla de operaciones evita la divergencia de versiones), `lmm.inventory`, `lmm.stock_movements`, `lmm.sync_events`, más `lmm.order_inventory_ledger` (nueva).

---

## 12. Devoluciones y ajustes

### 12.1 Devolución (`return`)

**Regla:** una devolución no puede superar lo **efectivamente descontado** de la venta original, no puede devolver dos veces las mismas unidades y debe referenciar inequívocamente la operación original (`source_operation_id`).

**Algoritmo (Fase A, tras bloquear pedido y ledger):**

1. El pedido existe (si no: `order_not_found`).
2. Para cada línea: la operación `source_operation_id` existe, está `applied`, pertenece a **ese** pedido y tiene movimientos `sale` de ese producto (si no: `source_operation_invalid`).
3. Se **agregan** las líneas por `(source_operation_id, inventory_uuid)` (varias líneas del mismo par suman).
4. `remanente_fuente = SUM(sale.applied_qty de la fuente y el producto) − SUM(return.applied_qty con esa fuente y producto)`.
5. `remanente_pedido = ledger.discounted_total − ledger.returned_total`.
6. Si algún agregado supera `remanente_fuente` **o** `remanente_pedido` ⇒ rechazo `return_exceeds_remaining` con `details.remaining`.

**Fase B:** por línea, `stock += qty`, movimiento `return` (`requested = applied = qty`, `delta = +qty`, `source_operation_id` completo) y `ledger.returned_total += qty`. **`requested_net` no cambia** y la devolución **no** modifica los ítems del pedido ni su versión (hallazgo C-02).

**Semántica única (V8.1):** `requested_net` es lo que el pedido **contiene**; una devolución es un movimiento de stock independiente (el cliente se llevó el producto y lo devolvió). Por eso, tras vender 5 y devolver 2, un `modify` que conserva la cantidad 5 calcula `dif = 5 − 5 = 0` y **no** vuelve a descontar. Las unidades ya devueltas cuentan como "no cumplidas" (`no_cumplido = requested_net − efectivo_neto`); si después se reduce el pedido, se bajan primero esas unidades y no se devuelven de nuevo (sin doble reintegro). Quien quiera que el pedido refleje la devolución debe emitir un `modify` que reduzca la cantidad (que devuelve solo lo que aún no se devolvió).

Una devolución reintegra solo lo que realmente salió del stock; un faltante **nunca** se devuelve.

| Venta original (stock 5, solicitó 8, sin autorización) | Descontado 5, faltante 3 |
|---|---|
| Devolver 2 | OK → stock 2 (efectivo_neto 3) |
| Devolver 3 más | OK → stock 5 (efectivo_neto 0) |
| Devolver 1 más | `return_exceeds_remaining` (remanente 0) |
| Devolver 8 de una vez | `return_exceeds_remaining` (remanente 5) |
| Dos devoluciones simultáneas de 3 (remanente 5) | Serializadas por el bloqueo del pedido y del ledger: la primera OK, la segunda `return_exceeds_remaining` (remanente 2); `CHECK (returned_total <= discounted_total)` es el respaldo |

**Idempotencia:** mismo `operation_id` ⇒ resultado guardado. Otro `operation_id` con las mismas unidades ⇒ no se duplica porque el segundo ve el remanente ya consumido.

**Atomicidad:** stock, movimiento, ledger y evento en la misma transacción.

### 12.2 Cancelación y reapertura (resumen)

`cancel` reintegra, por producto, el `efectivo_neto` actual atribuyéndolo FIFO a las operaciones fuente (una devolución por fuente, con `reason = 'cancel'` en el resultado) y deja `requested_net = 0`. `reopen` vuelve a descontar según 10.1 los ítems vigentes (con la regla de autorización normal: una reapertura con stock insuficiente y sin autorización descuenta solo lo disponible y registra faltante).

### 12.3 Ajustes (`adjust_in` / `adjust_out`)

| Requisito | Diseño |
|---|---|
| Positivo y negativo explícitos | Dos `kind` distintos; `qty` siempre `> 0`; el servidor deriva el signo del `kind`. |
| Autorización válida | `authorization_id` obligatorio; `scope = 'adjustment'`, atada al `inventory_uuid`, con `max_quantity` y de un solo uso (13.5). |
| Motivo, usuario, referencia | `reason_code` (enum) y `reason_text` obligatorios; `reference` opcional; se guardan además `authorized_by_membership_id` y `authorized_by_name` (nombre del administrador que aprobó, verificado por PIN) y `device_id`. |
| Delta calculado por el servidor | `delta = +qty` (in) o `−qty` (out); no existe campo de delta en el contrato. |
| Saldo | `adjust_out` puede dejar saldo negativo; queda marcado `authorized` y se informa en el resultado (decisión DEC-06). |

Movimiento: `adjustment_in/out` con `applied_qty = qty`, `requested_qty = qty`, `stock_before/after`. El **saldo inicial** de un producto nuevo o migrado es un `adjust_in` con `reason_code = 'opening_balance'`.

---

## 13. Seguridad

### 13.1 Modelo de identidad (no depende de claims del JWT)

**Problema de V7:** asumía claims `restaurant_id`, `device_id`, `name`, `role` en el JWT. El sistema actual usa la clave anónima y un `cloud_restaurant_id` de la configuración local; esos claims no existen, y `auth.jwt() ->> 'role'` en Supabase es el **rol de Postgres** (`authenticated`), no un rol de negocio.

**Modelo V8:**

```
JWT de Supabase Auth (firma validada por PostgREST)
   └─ auth.uid() ─────────────► lmm.devices.auth_user_id  (UNIQUE) ──► device_id + restaurant_id + status
                                lmm.restaurant_memberships.auth_user_id ──► rol de negocio (solo humanos administradores)
```

- Cada dispositivo tiene **su propia cuenta de Supabase Auth**. La RPC deduce dispositivo y restaurante con una consulta en cada llamada; por eso la **revocación es inmediata** (no hay que esperar la expiración del JWT).
- `restaurant_id` **nunca** se recibe: sale de `lmm.devices`.
- Que el cliente envíe `device_id` es solo una verificación cruzada: debe coincidir con el dispositivo vinculado a `auth.uid()`.

**Enrolamiento de un dispositivo (una vez):**

1. Un `owner/admin` (autenticado como persona, desde un panel web o app administrativa) llama a `lmm_create_enrollment(restaurant_id, label)` ⇒ devuelve un código de un solo uso con vencimiento (15 min); se guarda solo su `sha256`.
2. El dispositivo crea su cuenta de Supabase Auth (decisión DEC-01: inicio de sesión anónimo habilitado, o cuenta provisionada) y llama a `lmm_enroll_device(code, device_id)`. La función valida: código vigente y no consumido, `auth.uid()` no registrado, y registra `lmm.devices(device_id, restaurant_id, auth_user_id = auth.uid(), status='active')`.
3. El código se marca consumido en la misma transacción. Un código reusado o vencido es rechazado.

### 13.2 Roles y permisos

| Capacidad | `owner` | `admin` | `manager` | `cashier` / `waiter` | Dispositivo (JWT) |
|---|:--:|:--:|:--:|:--:|:--:|
| `lmm_apply_operation`, `lmm_get_events`, `lmm_get_snapshot` | — | — | — | — | ✔ |
| Emitir autorización (verifica PIN del aprobador) | aprobador | aprobador | ✘ | ✘ | solicita (el servidor verifica el PIN) |
| Crear enrolamiento / revocar dispositivo | ✔ | ✔ | ✘ | ✘ | ✘ |
| Configurar PIN de aprobación | propio | propio | ✘ | ✘ | ✘ |

Limitación honesta (R-06): el servidor sabe **qué dispositivo** opera, no **qué empleado local** lo usa; los permisos entre empleados se siguen aplicando localmente. Lo que sí queda blindado en el servidor son las acciones peligrosas (stock negativo y ajustes), porque exigen el PIN de un administrador verificado por el servidor.

### 13.3 Funciones privilegiadas

- Propietario: `lmm_owner` (NOLOGIN). `SECURITY DEFINER` solo en las funciones `public.lmm_*`; las auxiliares `lmm.*` son invocadas desde ellas y **no** tienen `EXECUTE` para ningún rol de la API.
- `SET search_path = ''` en **todas** las funciones; todo objeto se referencia con schema (`lmm.`, `auth.`, `extensions.`, `pg_catalog.`). `pg_catalog` siempre se busca primero de forma implícita, por lo que las funciones nativas y operadores siguen resolviendo; el riesgo de objetos plantados en `public` (que V7 dejaba en el `search_path`) desaparece.
- Hash: `pg_catalog.sha256(bytea)` (PostgreSQL ≥ 11), sin depender de `pgcrypto`/`digest()`, que en Supabase vive en el schema `extensions` y no estaba alcanzable con el `search_path` de V7. Solo el PIN usa `extensions.crypt` (bcrypt), con `GRANT USAGE ON SCHEMA extensions` y `EXECUTE` a `lmm_owner`.
- `auth.uid()` se llama calificado; `lmm_owner` recibe `USAGE` sobre `auth` y `EXECUTE` sobre `auth.uid()`.

```sql
-- Propietario y accesos mínimos a schemas ajenos
CREATE ROLE lmm_owner NOLOGIN;
GRANT USAGE ON SCHEMA auth, extensions TO lmm_owner;
GRANT EXECUTE ON FUNCTION auth.uid() TO lmm_owner;
GRANT EXECUTE ON FUNCTION extensions.crypt(text, text), extensions.gen_salt(text) TO lmm_owner;

-- Schema privado: nadie de la API entra
REVOKE ALL ON SCHEMA lmm FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE lmm_owner IN SCHEMA lmm REVOKE ALL ON TABLES    FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE lmm_owner IN SCHEMA lmm REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL TABLES    IN SCHEMA lmm FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lmm FROM PUBLIC, anon, authenticated, service_role;

-- RLS activado en todas las tablas (defensa en profundidad; sin políticas = denegar todo a no propietarios)
ALTER TABLE lmm.restaurants               ENABLE ROW LEVEL SECURITY;
ALTER TABLE lmm.restaurant_event_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE lmm.restaurant_memberships    ENABLE ROW LEVEL SECURITY;
ALTER TABLE lmm.devices                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE lmm.device_enrollments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE lmm.inventory                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE lmm.orders                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE lmm.order_items               ENABLE ROW LEVEL SECURITY;
ALTER TABLE lmm.order_inventory_ledger    ENABLE ROW LEVEL SECURITY;
ALTER TABLE lmm.operations                ENABLE ROW LEVEL SECURITY;
ALTER TABLE lmm.stock_authorizations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE lmm.stock_movements           ENABLE ROW LEVEL SECURITY;
ALTER TABLE lmm.sync_events               ENABLE ROW LEVEL SECURITY;
ALTER TABLE lmm.legacy_stock_movements    ENABLE ROW LEVEL SECURITY;
ALTER TABLE lmm.app_config                ENABLE ROW LEVEL SECURITY;

-- Superficie pública: solo EXECUTE a authenticated, nada a anon/PUBLIC.
-- (Supabase otorga EXECUTE por defecto a anon/authenticated/service_role sobre funciones nuevas de public:
--  por eso el REVOKE explícito va DESPUÉS de cada CREATE FUNCTION.)
REVOKE ALL ON FUNCTION public.lmm_apply_operation(jsonb)                          FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.lmm_get_events(uuid, bigint, integer, bigint)       FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.lmm_get_snapshot(uuid)                              FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.lmm_issue_authorization(jsonb)                      FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.lmm_create_enrollment(uuid, text)                   FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.lmm_enroll_device(text, uuid)                       FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.lmm_revoke_device(uuid, uuid)                       FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.lmm_apply_operation(jsonb)                       TO authenticated;
GRANT EXECUTE ON FUNCTION public.lmm_get_events(uuid, bigint, integer, bigint)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.lmm_get_snapshot(uuid)                           TO authenticated;
GRANT EXECUTE ON FUNCTION public.lmm_issue_authorization(jsonb)                   TO authenticated;
GRANT EXECUTE ON FUNCTION public.lmm_create_enrollment(uuid, text)                TO authenticated;
GRANT EXECUTE ON FUNCTION public.lmm_enroll_device(text, uuid)                    TO authenticated;
GRANT EXECUTE ON FUNCTION public.lmm_revoke_device(uuid, uuid)                    TO authenticated;
```

`lmm_create_enrollment` y `lmm_revoke_device` verifican **dentro** de la función que `auth.uid()` tiene membresía `owner/admin` activa (los puede llamar cualquier `authenticated`, pero solo actúan si hay membresía). Las funciones de dispositivo verifican `lmm.devices`. `anon` no ejecuta nada. `service_role` no se usa en Electron ni en el renderer (prohibido); las tareas de operación (`lmm.purge_events`, `lmm.migrate_open_order`, alta de restaurantes) se ejecutan con scripts administrativos con credenciales fuera de la app; **no** tienen `EXECUTE` para `anon`/`authenticated` (viven en el schema privado `lmm`).

### 13.4 Políticas RLS (coherentes con "sin acceso directo")

Línea base: **ningún `GRANT` de tabla** a `anon`/`authenticated` y RLS activado sin políticas ⇒ el acceso directo es denegado dos veces (por privilegios y por RLS). Esto resuelve la contradicción de V7 (`REVOKE ALL` junto a políticas `SELECT` que nunca podían ejecutarse y que además comparaban `uuid = text`).

Si en el futuro se habilita lectura directa para un panel administrativo, la plantilla es (toda tabla tiene `restaurant_id`, incluida `order_items`):

```sql
CREATE FUNCTION lmm.is_member(p_restaurant uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM lmm.restaurant_memberships m
                  WHERE m.restaurant_id = p_restaurant
                    AND m.auth_user_id = (SELECT auth.uid())
                    AND m.active);
$$;
-- Ejemplo (NO se activa en la línea base):
-- CREATE POLICY inv_member_read ON lmm.inventory FOR SELECT TO authenticated USING (lmm.is_member(restaurant_id));
-- + GRANT SELECT ON lmm.inventory TO authenticated;
-- INSERT/UPDATE/DELETE: sin política ⇒ denegado.
```

### 13.5 Autorización administrativa (por operación, verificada en el servidor)

`public.lmm_issue_authorization(p_request jsonb)`; entrada: `device_id`, `approver_membership_id`, `pin`, `scope` (`negative_stock` \| `adjustment`), opcionales `order_uuid`, `inventory_uuid` (obligatorio en `adjustment`), `max_quantity`, `ttl_minutes` (1–720).

1. Se valida el dispositivo (13.1).
2. El aprobador debe ser una membresía **activa** `owner/admin` del **mismo** restaurante.
3. Si `pin_locked_until > now()` ⇒ rechazo `approver_locked`.
4. Se verifica `extensions.crypt(pin, approval_pin_hash) = approval_pin_hash`. Si falla: `pin_failed_attempts + 1`; con 5 fallos, `pin_locked_until = now() + 15 min`. **El contador se persiste** porque el fallo se devuelve como resultado (no como excepción, que lo revertiría).
5. Si acierta: contador a 0 e inserción en `lmm.stock_authorizations` (`status = 'active'`, `issued_to_device_id`, `valid_until = now() + ttl`).
6. Devuelve `authorization_id`, `valid_until`, `approver_display_name`.

**Uso:** el `authorization_id` va en el intent. En la Fase A el servidor bloquea la fila y exige: existe, `status = 'active'`, mismo restaurante, `issued_to_device_id` = dispositivo de la operación, `scope` adecuado, `order_uuid` nulo o igual, `inventory_uuid` igual (ajustes), cantidad ≤ `max_quantity`, no vencida (13.6) y emisor aún `active`. Si cumple, queda `consumed` por esa operación en la Fase B. El PIN **no se guarda** ni se reenvía: solo viaja en la petición de emisión sobre TLS.

El frontend jamás envía un booleano "autorizado": envía un identificador que el servidor puede (o no) validar.

### 13.6 Autorización sin conexión

Un administrador no puede ser verificado sin conexión. Diseño: **vales pre-emitidos**. Con conexión, el administrador emite uno o varios vales (`negative_stock`, `order_uuid` nulo, `valid_until` de hasta 12 h, un uso cada uno) que el dispositivo guarda en `local_authorizations`. Sin conexión, una venta con faltante puede **adjuntar** un vale disponible (lo marca `attached`); si no hay vales, la venta se registra igual **sin** autorización (descuenta solo lo disponible y registra faltante), que es la regla 4.2.

Como el servidor evalúa la vigencia con su reloj y las ventas offline se sincronizan más tarde, **solo los vales emitidos con `offline_voucher = true`** (`offline_grace = true`) se pueden consumir hasta `valid_until + authorization_grace_hours` (48 h por defecto, `lmm.app_config`). Las autorizaciones **online** (`offline_voucher = false`, vigencia máxima de 60 min) **no tienen gracia**: vencen en `valid_until` (hallazgo A-03; el servidor no puede distinguir una venta realmente offline de un uso diferido deliberado, por eso la gracia queda restringida a los vales que el administrador emitió expresamente para ese fin). Ventana de abuso acotada por: un solo uso, atado al dispositivo, un tope de vales pendientes por dispositivo y revocación inmediata. Riesgo residual R-05; la política (¿se permiten vales offline? ¿cuántos y por cuánto tiempo?) es la decisión DEC-02.

### 13.7 Revocación de dispositivos

`lmm_revoke_device(restaurant_id, device_id)` (owner/admin): `status='revoked'`, `revoked_at`, `revoked_by_membership_id`, y marca las autorizaciones activas de ese dispositivo como `revoked`. Efecto **inmediato** en la siguiente llamada (cada RPC consulta `lmm.devices`). Opcionalmente un proceso administrativo (con `service_role` fuera de la app) cierra la sesión Auth del dispositivo. Las operaciones del dispositivo revocado que quedaron en su outbox no se pierden: el servidor responde `PT403` y la outbox las deja en `dead_letter` con código `device_revoked_or_unbound` para revisión; un administrador decide si se re-emiten desde un dispositivo nuevo.

### 13.8 Qué no se confía y de dónde sale

| Dato | Se confía del cliente | Origen real |
|---|:--:|---|
| `restaurant_id` | ✘ (ni se recibe) | `lmm.devices` vía `auth.uid()` |
| `device_id` del payload | ✘ (solo verificación cruzada) | `lmm.devices` |
| Rol / `is_admin` | ✘ (no existe en el contrato) | `restaurant_memberships` del aprobador (PIN verificado) |
| `authorized_by` | ✘ (no existe) | `authorized_by_membership_id/name` copiados de la autorización |
| `user_name`, `user_role` | ✘ | `client_actor` se guarda como informativo no confiable |
| Timestamps | ✘ | `created_at/applied_at` del servidor; `client_created_at` informativo |
| Cantidad aplicada, faltante, delta, saldo | ✘ | Calculados por el servidor |
| Totales de línea | ✘ | `ROUND(unit_price * qty, 2)` |

### 13.9 Realtime

Línea base V8: **sin Realtime**; el cliente consulta `lmm_get_events` por cursor (por ejemplo cada 5 s en línea, y de inmediato tras cada respuesta de `lmm_apply_operation`). Si se quisiera una "pista" para bajar la latencia, solo podría usar *Broadcast* privado con política sobre `realtime.messages` y **sin datos de negocio** (solo `event_seq`): `postgres_changes` requeriría `SELECT` directo sobre las tablas, contrario al modelo de acceso. La pista nunca se aplica como evento.

### 13.10 Amenazas y mitigaciones

| Amenaza | Mitigación |
|---|---|
| Cliente manipulado envía más descuento/menos faltante | No hay campos para eso; el servidor calcula |
| Reenvío (replay) de una operación | Idempotencia por `operation_id` |
| Acceso a otro restaurante | Restaurante derivado de `auth.uid()`; PK/UNIQUE incluyen `restaurant_id`; schema privado |
| Escalada a administrador | La autorización exige PIN verificado en servidor; nada de roles en el payload |
| Fuerza bruta del PIN | Bloqueo tras 5 intentos / 15 min; PIN bcrypt |
| Dispositivo robado | Revocación inmediata en `lmm.devices` |
| Enumeración por colisiones | Claves únicas con `restaurant_id` |
| Inyección SQL / `search_path` | Sin SQL dinámico; `search_path = ''`; schemas calificados |
| Llamada a función privilegiada sin permiso | `REVOKE … FROM PUBLIC, anon`; verificación interna de dispositivo/membresía |

---

## 14. Outbox local y recuperación

### 14.1 Estados y transiciones

| Estado | Significado | Transiciones permitidas |
|---|---|---|
| `pending` | Lista para enviarse | → `claimed` |
| `claimed` | Reclamada por un proceso con **lease** | → `applied`, `retry_wait`, `conflict`, `dead_letter`; → reclamable de nuevo si el lease venció |
| `retry_wait` | Falla transitoria; espera `next_attempt_at` | → `claimed` (cuando llega la hora) |
| `applied` | Resultado autoritativo recibido **y** aplicado localmente | terminal (retención 30 días) |
| `conflict` | El servidor devolvió un rechazo de negocio | terminal hasta resolución manual |
| `dead_letter` | Error permanente (manipulación, bug, dispositivo revocado, demasiados fallos) | terminal hasta resolución manual |

V7 decía `retry_wait → claimed` en una tabla y `retry_wait → pending` en otra, y su sentencia de reclamo solo aceptaba `pending`: una operación en `retry_wait` **nunca** se reclamaba. En V8 el reclamo acepta `pending`, `retry_wait` vencido y `claimed` con lease vencido.

### 14.2 Reclamo atómico (ejecutado y verificado en SQLite)

Una única sentencia `UPDATE … WHERE outbox_id = (SELECT …) RETURNING …`; en `better-sqlite3` cada `run/get` es atómico y el motor es de un solo escritor, por lo que dos reclamos nunca obtienen la misma fila.

```sql
UPDATE inventory_outbox
   SET status='claimed', lease_owner=:owner, lease_expires_at=:now+:lease_ms,
       claimed_at=:now, attempts=attempts+1
 WHERE outbox_id = (
   SELECT o.outbox_id FROM inventory_outbox o
    WHERE ( (o.status IN ('pending','retry_wait') AND COALESCE(o.next_attempt_at,0) <= :now)
         OR (o.status = 'claimed' AND o.lease_expires_at <= :now) )               -- lease vencido
      AND NOT EXISTS (SELECT 1 FROM inventory_outbox p                          -- orden por partición
                       WHERE p.partition_key = o.partition_key AND p.outbox_id < o.outbox_id
                         AND p.status IN ('pending','claimed','retry_wait','dead_letter','conflict'))
      AND (o.depends_on_operation_id IS NULL OR EXISTS (SELECT 1 FROM inventory_outbox d
                       WHERE d.operation_id = o.depends_on_operation_id AND d.status = 'applied'))
    ORDER BY o.outbox_id LIMIT 1)
RETURNING outbox_id, operation_id, request_payload, attempts;
```

- `lease_owner = "<device_id>:<boot_id>"`; `lease` = 120 s; timeout HTTP = 30 s (menor que el lease).
- **No** se mantiene ninguna transacción abierta durante la llamada HTTP: reclamar (commit) → enviar → aplicar resultado (otra transacción).
- Cerrar una operación: `UPDATE … WHERE outbox_id=? AND status IN ('claimed','pending','retry_wait')`. Si un proceso lento vuelve tarde después de que otro reclamó la fila, ambos envían el mismo `operation_id`: el servidor es idempotente y `applied_results` evita aplicar dos veces el resultado local.

### 14.3 Recuperación de leases vencidos y arranque

- **En caliente:** el propio predicado de reclamo toma `claimed` con `lease_expires_at <= now`; no depende de un reinicio (V7 solo recuperaba al iniciar).
- **Al iniciar Electron** (opcional, acelera): `UPDATE … SET status='pending', lease_owner=NULL WHERE status='claimed' AND lease_owner NOT LIKE :device_id || ':' || :boot_id`. Si coexisten dos procesos del mismo dispositivo, el peor caso es un reenvío idempotente.
- Una operación **no puede quedar atrapada** en `claimed`: o la cierra su dueño, o vence el lease y se reclama.

### 14.4 Clasificación de errores y backoff

| Resultado del envío | Transición | `server_failures` |
|---|---|---|
| Sin red / timeout sin respuesta | `retry_wait` | **no** incrementa (estar offline no agota los intentos) |
| 401 (JWT vencido) | refrescar sesión; `pending` | no |
| 5xx, `55P03`, `40P01`, `40001`, `57014`, `PT500` | `retry_wait` | +1 |
| 200 con `applied` / `replayed` / `deduplicated_of` | `applied` (tras aplicar el resultado) | — |
| 200 con `rejected` | `conflict` | — |
| 403 / `PT403` (dispositivo revocado o no vinculado) | `dead_letter` (`device_revoked_or_unbound`) | — |
| 409 / `PT409`, 422 / `PT422` | `dead_letter` (bug o manipulación) | — |
| `server_failures ≥ 10` | `dead_letter` (`too_many_failures`) | — |

Backoff: `delay = MIN(300 s, 5 s · 2^(server_failures − 1)) · (1 ± 0,2 aleatorio)`; primer intento inmediato; `next_attempt_at = now + delay`.

### 14.5 Orden y dependencias

- Las operaciones de una misma partición (`order:<uuid>` o `inv:<uuid>`) se envían en orden `outbox_id`: una operación no se reclama si hay una **anterior** de su partición en `pending/claimed/retry_wait/dead_letter/conflict`. Particiones distintas se procesan en paralelo.
- Una devolución cuya venta original aún no está confirmada comparte partición con ella (mismo pedido) y además guarda `depends_on_operation_id = <operation_id de la venta>`: **espera** hasta que la venta esté `applied`.
- Si la predecesora termina en `conflict` o `dead_letter`, **la partición queda bloqueada** (visible en la UI como "bloqueada por operación X") hasta resolución manual; no se envía una devolución sobre una venta que el servidor rechazó.
- Las ventas de pedidos distintos sobre el mismo producto **no** dependen entre sí (el servidor las serializa por el bloqueo de inventario).

### 14.6 Cero pérdida por deduplicación

Encolar usa `INSERT` simple. `UNIQUE(operation_id)` y `UNIQUE(idempotency_key)` solo colapsan un **mismo propósito ya encolado** (en ese caso `enqueue` devuelve la fila existente); nunca reemplazan ni borran una operación pendiente distinta. `entity_seq` se asigna dentro de la transacción local de encolado (`MAX+1`), con `UNIQUE(entity_type, entity_uuid, entity_seq)` como respaldo. A diferencia del mecanismo actual (`sync_queue`, donde varias entradas de la misma fila se funden en un `upsert` del estado final), **cada operación de inventario se conserva individualmente**.

### 14.7 Resolución manual y retención

- `conflict`: el usuario elige **Rehacer** (se crea una operación nueva con `entity_seq + 1` a partir del estado fresco; los movimientos provisionales se re-vinculan a la operación nueva) o **Descartar** (solo administrador local; los movimientos provisionales pasan a `rejected` y dejan de contar). Hasta resolver, los movimientos siguen contando como provisionales (el POS no muestra más stock del que podría haber).
- Se registran `resolved_at` y `resolution_note`.
- Retención: `applied` ≥ 30 días (luego se purga la fila; `applied_results` se conserva); `conflict` y `dead_letter` indefinidamente.

---

## 15. Eventos y cursor remoto

### 15.1 Contrato del evento

Un evento por operación **aplicada** (los rechazos no generan evento). Campos de `lmm.sync_events`: `event_id`, `restaurant_id`, `event_seq`, `event_type` (`operation.applied`), `entity_type`, `entity_uuid`, `operation_id`, `device_id` (**origen**), `payload` (el **resultado autoritativo** de 7.7: movimientos con `applied/shortage/delta/stock_after`, saldos e `inventory.version`, resumen del pedido), `payload_hash`, `created_at`.

V7 guardaba en el evento la **intención del cliente**; otro dispositivo que la aplicara habría usado cantidades solicitadas y no las efectivamente descontadas. V8 publica lo que el servidor decidió.

### 15.2 `event_seq` sin huecos

```
UPDATE lmm.restaurant_event_counters
   SET last_event_seq = last_event_seq + 1
 WHERE restaurant_id = v_rid
RETURNING last_event_seq INTO v_seq;
```

- La fila existe desde el alta del restaurante (trigger) y, por defensa, la RPC ejecuta `INSERT … ON CONFLICT DO NOTHING` antes del `UPDATE` (V7 no inicializaba la fila: el `UPDATE … RETURNING` devolvía `NULL` y el `NOT NULL` de `event_seq` hacía fallar toda operación del restaurante).
- El `UPDATE` toma el bloqueo de la fila y **lo retiene hasta el `COMMIT`**. Otra transacción del mismo restaurante espera. Si la primera aborta, su incremento se revierte y la segunda obtiene el mismo número.
- Invariantes: **I-EV-1** los `event_seq` confirmados forman `1..N` sin huecos; **I-EV-2** el orden de `event_seq` coincide con el orden de commit; **I-EV-3** un lector nunca ve el evento `n+1` sin ver el `n` (el lector toma su instantánea después de que `n` salió del `ProcArray`, porque `n+1` esperó a `n`). I-EV-3 se apoya en el comportamiento interno de PostgreSQL y **debe confirmarse con la prueba de concurrencia EV-04** antes de darlo por cierto.
- Costo: todas las operaciones de un restaurante se serializan en su tramo final. Aceptable para un POS (R-07).

### 15.3 `public.lmm_get_events(p_device_id uuid, p_from_seq bigint, p_limit integer DEFAULT 200, p_ack_seq bigint DEFAULT NULL) RETURNS jsonb`

Entrada: dispositivo (validado contra `auth.uid()`), último `event_seq` aplicado, tamaño de página (acotado a 1–500) y, opcionalmente, el último seq aplicado para registrar `last_ack_seq`.

```json
{ "status": "ok",
  "events": [ { "event_id": "…", "event_seq": 43, "event_type": "operation.applied", "entity_type": "order",
                "entity_uuid": "…", "operation_id": "…", "device_id": "…", "payload": { }, "payload_hash": "…",
                "created_at": "2026-11-21T14:03:12Z" } ],
  "has_more": false, "last_event_seq": 43 }
```

`status = "resync_required"` (con `min_retained_seq`, `last_event_seq`) cuando `p_from_seq + 1 < min_retained_seq` (los eventos pedidos ya fueron purgados): el cliente debe pedir un snapshot (15.7).

### 15.4 Algoritmo del cliente (estrictamente secuencial)

```
loop:
  r = lmm_get_events(device, cursor.last_applied_seq, 200, cursor.last_applied_seq)
  si r.status = 'resync_required' → resync()
  para cada ev en r.events (orden ascendente):
     si ev.event_seq <= cursor.last_applied_seq            → duplicado: ignorar
     si ev.event_seq != cursor.last_applied_seq + 1        → GAP: detenerse; reintentar la consulta;
                                                              si persiste → alerta 'event_gap' (no se salta nada)
     TX SQLite (única):
        INSERT sync_events_local (event_id UNIQUE)         -- eventos duplicados chocan aquí
        applyAuthoritativeResultTx(ev.payload, source='event', origin=ev.device_id)
        UPDATE sync_cursor SET last_applied_seq = ev.event_seq
     COMMIT
  si no r.has_more → esperar (poll) o disparo inmediato tras una respuesta propia
```

El cursor **solo avanza** dentro de la misma transacción que aplica el evento. Si la aplicación falla, la transacción se revierte, el cursor no avanza y el evento se reintenta; no se salta ningún evento (alerta `event_apply_error` tras N fallos).

### 15.5 Eventos propios y ajenos

| Tipo | Detección | Tratamiento |
|---|---|---|
| **Propio** | `ev.device_id = DEVICE_ID` | Se ejecuta `applyAuthoritativeResultTx`, que es **no-op** si el resultado ya se aplicó con la respuesta (`applied_results`); si la respuesta nunca llegó (cierre inesperado), el evento propio **reconcilia** el saldo local y cierra la fila de outbox. **Nunca** reaplica un descuento. Siempre avanza el cursor. |
| **Ajeno** | `ev.device_id ≠ DEVICE_ID` | Se insertan los movimientos como `origin='remote'`, `confirmed` (trazabilidad compartida) y se actualiza el saldo **confirmado** con la guarda por versión; los movimientos provisionales propios se conservan. |

`is_own` es **derivado localmente** (columna de `sync_events_local`); V7 guardaba una columna `is_own_event` remota que no tenía sentido y no almacenaba el `device_id` de origen, por lo que el evento propio no era detectable.

### 15.6 Duplicados y fuera de orden

- **Duplicado:** `event_id` ya presente o `event_seq ≤ cursor` ⇒ se ignora y se sigue.
- **Fuera de orden:** la API entrega eventos ordenados; un evento con `event_seq > cursor + 1` es un gap y **no se aplica** hasta tener los intermedios.
- Una "pista" de Realtime nunca se aplica; solo dispara una consulta.

### 15.7 Recuperación, retención y reproceso

- **Desconexión:** al volver, el polling continúa desde `last_applied_seq`; las operaciones pendientes de la outbox se envían (idempotentes) y sus respuestas se aplican.
- **Retención:** `lmm_purge_events()` (tarea administrativa) elimina eventos con `event_seq ≤ MIN(last_ack_seq de dispositivos activos)` y de más de 30 días, y actualiza `min_retained_seq`. `lmm.operations` y `lmm.stock_movements` **no se purgan**: una operación aplicada cuyo evento fue purgado se puede seguir reconciliando reenviándola (devuelve el `result_payload`).
- **Resincronización (`resync_required`):** `lmm_get_snapshot(device)` devuelve en **una sola sentencia** (una instantánea consistente): `last_event_seq`, todos los productos con `stock` y `version`, y los pedidos abiertos con ítems. El cliente, en una transacción: fija `stock_confirmed_milli` y `confirmed_version` de cada producto, `last_applied_seq = last_event_seq`, y recalcula el stock provisional. La trazabilidad ajena perdida no se reconstruye desde el snapshot (se consulta aparte; R-10).
- **Reprocesamiento:** `applied_results` y `sync_events_local` hacen idempotente reprocesar cualquier resultado o evento.

---

## 16. Reconciliación offline y stock local

### 16.1 Definiciones

| Concepto | Definición |
|---|---|
| **Stock confirmado** | `inventory.stock_confirmed_milli`: el último saldo decidido por el servidor que este dispositivo conoce (con `confirmed_version`). Es la única cifra "definitiva". |
| **Stock provisional** | `confirmado + SUM(delta_milli)` de los movimientos locales aún `provisional`. Es lo que permite seguir vendiendo sin conexión; se muestra marcado como no definitivo. |
| **Movimientos locales pendientes** | Filas de `stock_movements` con `confirmation_state='provisional'`, cada una atada a una operación de la outbox. |
| **Resultado remoto aplicado** | Fila en `applied_results` (por `operation_id`). |
| **Reconciliación de movimientos** | Reemplazar los valores provisionales de un movimiento por los autoritativos **sobre la misma fila**, sin borrar ni duplicar. |
| **Estado de la operación** | El de la outbox (5.6). |

### 16.2 `applyAuthoritativeResultTx(res, source, originDeviceId)`

Se ejecuta **dentro de una transacción SQLite abierta por quien llama** (respuesta de la RPC, evento propio o evento ajeno):

```
1. Si el resultado es de OTRA operación (`res.operation_id` ≠ operación propia; `deduplicated_of`): la operación propia **no tuvo efecto** en el stock (la original ya lo aplicó). Alias (V8.1, C-03): sus movimientos locales `provisional` pasan a `rejected` (dejan de contar y no quedan huérfanos), se refresca la caché de stock de esos productos, la fila de outbox **propia** se cierra como `applied` (nota `deduplicated_of:<id>`) y, si la operación original es de este dispositivo, **sus** movimientos provisionales se concilian con el resultado (paso 4, por `(operation_id original, line_id, kind)`) y su fila de outbox también se cierra. El servidor solo deduplica dentro del **mismo dispositivo**; con la clave que incluye `device_id` no hay deduplicación entre dispositivos.
2. Si applied_results ya contiene res.operation_id → NO-OP (la outbox se cierra igual si estaba abierta).
3. Si res.operation_status = 'rejected':
       outbox → conflict (código y detalles); movimientos provisionales quedan provisional;
       registrar en applied_results; terminar.
4. Por cada movimiento m del resultado:
       local = fila con (operation_id, line_id, kind)
       si existe  → UPDATE requested/applied/shortage/delta + server_movement_id,
                          confirmation_state = 'confirmed'            (la venta NO se borra)
       si no      → INSERT (origin = 'local' si originDeviceId = DEVICE_ID, si no 'remote'),
                          confirmation_state = 'confirmed'            (p. ej. el 'shortage' que calculó el servidor)
   Movimientos provisionales de la operación que el servidor no confirmó (p. ej. un faltante local que
   el servidor no registró) → confirmation_state = 'rejected' (dejan de contar).
5. Por cada inventario res.inventory[i]:
       UPDATE inventory SET stock_confirmed_milli = :stock, confirmed_version = :version
        WHERE uuid = :uuid AND :version > confirmed_version          -- guarda: un resultado viejo no retrocede el saldo
   Refrescar inventory.stock (caché) = confirmado + SUM(provisionales)
6. Espejo del pedido: UPDATE orders SET remote_version, remote_status WHERE uuid = … AND :v >= COALESCE(remote_version,0)
7. Outbox: si existe la fila de res.operation_id → status='applied', response_payload, applied_at.
8. INSERT applied_results (operation_id, event_seq, source, result_hash, applied_at).
```

Las ocho acciones ocurren en **la misma** transacción: o se aplica todo o nada. Esto cubre el cierre inesperado: no existe un instante persistido en el que la respuesta se haya aplicado pero la outbox siga abierta (ni al revés).

### 16.3 Recorrido del caso obligatorio (valores verificados en SQLite en memoria)

Stock central 5. A y B sin conexión; cada uno vende 4 y calcula provisionalmente stock 1.

| Momento (en B) | Confirmado | Movimientos provisionales | Provisional mostrado |
|---|---:|---|---:|
| B vende 4 sin conexión | 5 | `sale` −4 (provisional) | **1** (marcado provisional) |
| B sigue sin conexión; el servidor procesa A (descuenta 4, v8). B se conecta y llega el **evento ajeno** de A | **1** (v8) | `sale` −4 (provisional) | **−3** — B ve que su venta, vista contra la realidad, excede lo disponible |
| Llega el **resultado autoritativo de B**: `applied 1`, `shortage 3`, `stock_after 0`, v9 | **0** (v9) | `sale` pasa a `confirmed` (applied 1, shortage 3) + se inserta `shortage` 3 `confirmed` | **0** |
| Llega el **evento propio** de B | 0 | sin cambios | 0 — no-op |
| Llega tarde un evento ajeno viejo (v8) | 0 (la guarda por versión lo ignora) | — | 0 |

Resultado: la venta de B **no se borra**, el movimiento **no se duplica** (se actualiza la misma fila), el descuento **no se reaplica**, el saldo local **no queda incorrecto** (0 = saldo central), el faltante (3) **se conserva** y el evento propio **no se duplica**. El estado de la operación de B pasa de "Pendiente" a "Confirmada con ajuste" (descontó 1, faltante 3).

### 16.4 Otros casos

| Caso | Comportamiento |
|---|---|
| **Cierre inesperado después del commit remoto y antes del ACK local** | La fila sigue `claimed`; vence el lease; se reenvía el mismo `operation_id`; el servidor devuelve el `result_payload` guardado (`replayed: true`); se aplica una vez. Alternativa: lo aplica antes el evento propio. |
| **Respuesta perdida** | Idéntico al anterior. |
| **El evento propio llega antes que la respuesta** | Lo aplica el evento (reconcilia y cierra la outbox); la respuesta posterior es no-op. |
| **La respuesta llega antes que el evento propio** | La aplica la respuesta; el evento es no-op y avanza el cursor. |
| **Dos operaciones propias pendientes sobre el mismo producto** | El provisional suma ambas; al confirmarse la primera cambia el confirmado pero la segunda sigue contando hasta su propia confirmación. |
| **Operación rechazada (`conflict`)** | El pedido local se conserva; sus movimientos siguen contando como provisionales hasta resolver (14.7). |
| **Resincronización por snapshot** | El confirmado se reemplaza por el del snapshot; los provisionales pendientes se mantienen. |
| **Reproceso de un resultado ya aplicado** | `applied_results` ⇒ no-op. |
| **Provisional negativo** | Se muestra (el POS no impide vender: regla 4.2); sirve de aviso de que el saldo real podría ser menor. |

### 16.5 Qué muestra el POS

El saldo se presenta como **confirmado** cuando no hay movimientos provisionales del producto; con provisionales pendientes se muestra el provisional con la marca "sin confirmar" (y, opcionalmente, el confirmado entre paréntesis). El POS sigue registrando pedidos sin conexión sin presentar como definitivo un saldo todavía no confirmado.

---

## 17. Migración desde el sistema actual

La migración **no** importa stock absoluto de dispositivos como fuente autoritativa. Los valores de los dispositivos son **insumos de un informe** que un propietario revisa; el saldo inicial lo establece una operación auditada (`adjust_in/out` con `reason_code = 'opening_balance'` y autorización del propietario).

### 17.1 Hechos del origen que condicionan el plan

- El stock se sincroniza hoy como valor absoluto vía `sync_queue` (sin payload) y `upsert onConflict uuid` en tablas remotas `sync_<tabla>`; el **esquema remoto real no está en el material analizado** (R-01): debe exportarse (`information_schema`) y compararse antes de implementar.
- `stock_movements` **no** está en `SYNC_TABLES`: los movimientos históricos existen solo en cada dispositivo (su semántica: `quantity` = cantidad efectiva, `reference_id INTEGER` = id local del pedido).
- Los `uuid` de `inventory` se asignaron localmente por backfill; dos dispositivos pueden haber generado UUID distintos para el mismo producto antes de sincronizar.
- Hay un cliente móvil que escribe pedidos en `sync_orders` (R-02).

### 17.2 Los 13 pasos

| # | Paso | Contenido |
|---|---|---|
| 1 | **Precondiciones** | Diseño auditado; staging con el esquema remoto real y las 19.x pruebas de concurrencia aprobadas; todos los dispositivos con la versión nueva instalable; decisiones DEC-01…DEC-08 cerradas; PIN del propietario configurado; ventana operativa acordada; definido el tratamiento del cliente móvil (R-02). |
| 2 | **Backup** | Local: copia consistente de cada SQLite (`VACUUM INTO` o API de backup de `better-sqlite3`) + checksum. Remoto: `pg_dump` de las tablas `sync_*` y configuración. Se **prueba la restauración** en staging (puerta de control). |
| 3 | **Detención de escrituras** | Ventana de mantenimiento por restaurante: ventas en pausa (contingencia en papel; DEC-07). Se evita así que haya movimientos entre el drenaje y la activación. |
| 4 | **Bloqueo de sincronización antigua** | Tras el drenaje (paso 5), `REVOKE INSERT, UPDATE, DELETE` sobre las tablas remotas legacy de inventario para `anon/authenticated`; el motor antiguo no puede volver a escribir stock absoluto. |
| 5 | **Drenaje** | Cada dispositivo vacía su `sync_queue` por la vía antigua mientras tiene conexión. Pendientes no drenables (dispositivo perdido) se declaran en el informe. |
| 6 | **Determinación del saldo canónico** | Por producto: propuesta = saldo remoto legacy tras el drenaje. Se compara con cada dispositivo; si todos coinciden ⇒ `consistente`; si difieren ⇒ `discrepante` y se exige **conteo físico**. El propietario confirma o corrige cada valor. Nunca se promedia ni se toma "el mayor/menor" automáticamente. |
| 7 | **Conciliación de movimientos** | Los movimientos locales históricos no se reinterpretan ni se suben como operaciones: se marcan `legacy` y (opcional, DEC-08) se archivan en `lmm.legacy_stock_movements`, sin efecto sobre saldos. |
| 8 | **UUID globales** | `inventory_uuid` canónico = `uuid` del registro remoto legacy. Casos: coincide ⇒ ok; solo local ⇒ producto nuevo; mismo nombre con UUID distinto en dispositivos ⇒ **duplicado**: informe y fusión manual (se reasigna el `uuid` local y `movements.inventory_uuid`); solo remoto ⇒ llega por el snapshot; `order_items.invId` sin producto o movimientos sin producto ⇒ **huérfanos**: se archivan y se excluyen. |
| 9 | **Backfill local** | `ALTER TABLE` con columnas nuevas (5.2–5.5); `stock_movements.inventory_uuid` por unión con `inventory`; `confirmation_state='legacy'`, `origin='legacy'` para todo lo existente; `stock_confirmed_milli` = valor aceptado × 1000 y `confirmed_version` = versión del bootstrap. |
| 10 | **Clasificación de colas pendientes** | Ver 17.3. |
| 11 | **Bootstrap remoto** | Alta de `restaurants`, membresías (owner/admin) y PIN; enrolamiento de los dispositivos; `catalog_upsert` de productos; **ajustes `opening_balance`** con los valores aceptados (ejecutados por una herramienta de migración enrolada como dispositivo `migration-tool`); pedidos **abiertos** migrados con `lmm_migrate_open_order` (función **solo de migración**, sin `EXECUTE` para `authenticated`): crea pedido, ítems y ledger con `discounted_total`/`returned_total` calculados desde los movimientos locales históricos, **sin volver a descontar**; si el pedido no tiene movimientos rastreables, su ledger queda en 0 (la cancelación no devolverá nada: conservador, informado). Es idempotente por `order_uuid`. |
| 12 | **Validaciones y activación gradual** | Puertas: remoto = saldo aceptado en el 100 % de los productos; conteos de productos y pedidos abiertos iguales; `stock_confirmed_milli` local = remoto en cada dispositivo; permisos (`has_function_privilege`) correctos; cero filas en `outbox`. Activación: staging → **un restaurante piloto** (todos sus dispositivos a la vez; el inventario no admite dispositivos viejos y nuevos conviviendo) → resto. Las pruebas de humo de venta/devolución se hacen en staging, no en producción. |
| 13 | **Plan de rollback** | Ver 17.4. |

### 17.3 Clasificación de `sync_queue` (cola actual sin payload)

| Entrada pendiente | Qué significa | Tratamiento |
|---|---|---|
| `table_name='inventory'` (cualquier `operation`) | "Subir el stock actual de este producto" ⇒ valor absoluto local, **incompatible** | **Cuarentena**: se exporta a un informe (`device`, `uuid`, stock local, `created_at`) y recién entonces se marca `synced=1`. **Nunca se envía.** |
| `orders` / `order_items` pendientes | Ediciones de pedido sin subir | Deben **drenarse por la vía antigua** antes del congelamiento (paso 5); si no, el dispositivo se declara perdido y sus pedidos se reingresan manualmente (informe). |
| `menu_items`, `tables`, `customers`, `employees`, `categories`, `subcategories` | No afectadas por V8 | Siguen por la vía antigua. |
| `synced = 1` | Ya subidas | Ignorar. |

### 17.4 Rollback

- **Antes del punto de no retorno** (la primera operación `applied` en `lmm` para el restaurante): rollback completo y seguro: reponer privilegios de escritura en tablas legacy, reinstalar el cliente anterior, restaurar los backups locales si se alteraron; el schema `lmm` queda sin uso. Las tablas legacy **no se modifican ni se borran** durante la migración.
- **Después**: **no se promete reversibilidad.** Volver atrás perdería operaciones y trazabilidad confirmadas. La vía es hacia adelante (correcciones y ajustes auditados). Una reversión forzada exigiría exportar `lmm.operations`/`stock_movements` y reconstruir saldos absolutos manualmente; se documenta como último recurso y con pérdida de trazabilidad.

### 17.5 Datos contradictorios entre dispositivos

Dos dispositivos con histórico o saldo contradictorio para el mismo producto ⇒ el producto pasa a `discrepante`; no se importa ningún valor automáticamente; se exige conteo físico y decisión del propietario, que queda registrada en el ajuste `opening_balance` (motivo, autorizador, referencia al informe). Los registros duplicados se listan; los huérfanos se archivan sin efecto sobre saldos.

---

## 18. Pseudocódigo SQL (PostgreSQL / PL/pgSQL)

**Estado de validación:** este código fue **revisado manualmente** contra el DDL de 6.1 (nombres de columna, tipos, bloqueos, variables declaradas) y su **sintaxis fue validada con el parser real de PostgreSQL** (V-6). **No fue ejecutado**: el entorno de análisis no tiene PostgreSQL y la tarea prohíbe conectarse a Supabase. Su ejecución en un proyecto aislado es puerta obligatoria antes de implementar (sección 20, etapa 1). Se usan `pg_catalog.` y `lmm.` explícitos; con `search_path = ''` los operadores y funciones nativas siguen resolviendo porque `pg_catalog` se busca siempre primero.

Correcciones de sintaxis respecto de V7 que este código incorpora: iteración con una variable `jsonb` escalar (`FOR v_item IN SELECT t.value FROM jsonb_array_elements(…) WITH ORDINALITY AS t(value, ord)`) en vez de `RECORD` con `->>`; `GET DIAGNOSTICS … ROW_COUNT`; `SELECT … FOR UPDATE` (no `UPDATE … FOR UPDATE`); `RETURNS jsonb` con `jsonb_build_object` (V7 mezclaba `json_build_object`); `order_uuid` en todas las consultas; ninguna línea de texto suelta fuera de comentarios.

### 18.1 Utilidades

```sql
-- JSON canónico (7.4). Solo enteros como números; cantidades y dinero viajan como string.
CREATE FUNCTION lmm.canonical_json(p jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = '' AS $$
DECLARE
  r text;
  n numeric;
BEGIN
  CASE pg_catalog.jsonb_typeof(p)
    WHEN 'object' THEN
      SELECT '{' || COALESCE(pg_catalog.string_agg(
               pg_catalog.to_json(e.key)::text || ':' || lmm.canonical_json(e.value),
               ',' ORDER BY e.key COLLATE "C"), '') || '}'
        INTO r
        FROM pg_catalog.jsonb_each(p) AS e;
    WHEN 'array' THEN
      SELECT '[' || COALESCE(pg_catalog.string_agg(
               lmm.canonical_json(a.value), ',' ORDER BY a.ord), '') || ']'
        INTO r
        FROM pg_catalog.jsonb_array_elements(p) WITH ORDINALITY AS a(value, ord);
    WHEN 'string' THEN
      r := pg_catalog.to_json(p #>> '{}')::text;
    WHEN 'number' THEN
      n := (p #>> '{}')::numeric;
      IF n <> pg_catalog.trunc(n) THEN
        RAISE EXCEPTION 'invalid_intent: non_integer_number' USING ERRCODE = 'PT422';
      END IF;
      r := n::bigint::text;
    WHEN 'boolean' THEN r := p::text;
    WHEN 'null'    THEN r := 'null';
  END CASE;
  RETURN r;
END $$;

-- UUID determinista (versión 5, variante RFC 4122) a partir de (tag, base)
CREATE FUNCTION lmm.derive_uuid(p_tag text, p_base text) RETURNS uuid
LANGUAGE sql IMMUTABLE STRICT SET search_path = '' AS $$
  SELECT (pg_catalog.substr(h, 1, 8)  || '-' || pg_catalog.substr(h, 9, 4) || '-5' ||
          pg_catalog.substr(h, 14, 3) || '-a' || pg_catalog.substr(h, 18, 3) || '-' ||
          pg_catalog.substr(h, 21, 12))::uuid
    FROM (SELECT pg_catalog.encode(pg_catalog.sha256(
                   pg_catalog.convert_to(p_tag || ':' || p_base, 'UTF8')), 'hex') AS h) s
$$;

CREATE FUNCTION lmm.sha256_hex(p text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path = '' AS $$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p, 'UTF8')), 'hex')
$$;

-- Cantidad -> string decimal canónico para resultados (4.000 -> '4', 0.250 -> '0.25', -3 -> '-3')
CREATE FUNCTION lmm.qty_text(p numeric) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path = '' AS $$ SELECT pg_catalog.trim_scale(p)::text $$;

CREATE FUNCTION lmm.parse_uuid(p text) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF p IS NULL OR p !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     AND p !~ '^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'invalid_intent: uuid' USING ERRCODE = 'PT422';
  END IF;
  RETURN p::uuid;
END $$;

CREATE FUNCTION lmm.reject(p_op uuid, p_kind text, p_code text, p_details jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT pg_catalog.jsonb_build_object('schema_version', 1, 'operation_id', p_op, 'op_kind', p_kind,
           'operation_status', 'rejected', 'reject_code', p_code, 'details', p_details)
$$;
```

`lmm.validate_intent`, `lmm.assert_lines_free`, `lmm.order_json`, `lmm.inventory_json` y `lmm.op_catalog` están en 18.7. Un `client_created_at` inválido y una `idempotency_key` ausente o fuera de 8–200 caracteres se rechazan con `PT422` en `lmm_apply_operation`.

### 18.2 Identidad del dispositivo

```sql
CREATE FUNCTION lmm.require_device(p_device uuid) RETURNS lmm.devices
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_dev lmm.devices;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = 'PT401';
  END IF;
  SELECT d.* INTO v_dev FROM lmm.devices d WHERE d.auth_user_id = v_uid;
  IF NOT FOUND OR v_dev.status <> 'active' OR v_dev.device_id IS DISTINCT FROM p_device
     OR NOT EXISTS (SELECT 1 FROM lmm.restaurants r
                     WHERE r.restaurant_id = v_dev.restaurant_id AND r.active) THEN
    RAISE EXCEPTION 'device_not_authorized' USING ERRCODE = 'PT403';
  END IF;
  RETURN v_dev;
END $$;
```

### 18.3 RPC principal

```sql
CREATE FUNCTION public.lmm_apply_operation(p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '' SET lock_timeout = '3s' SET statement_timeout = '15s'
AS $fn$
DECLARE
  c_keys constant text[] := ARRAY['schema_version','operation_id','idempotency_key','device_id',
                                  'client_created_at','client_actor','intent'];
  v_dev    lmm.devices;
  v_rid    uuid;
  v_op     uuid;
  v_idem   text;
  v_intent jsonb;
  v_kind   text;
  v_etype  text;
  v_euuid  uuid;
  v_hash   text;
  v_actor  text;
  v_cts    timestamptz;
  v_rows   integer;
  v_cname  text;
  v_ex     lmm.operations;
  v_other  lmm.operations;
  v_res    jsonb;
  v_seq    bigint;
BEGIN
  -- 0/1. Forma del sobre e identidad (nada de restaurante/rol/autorizador del cliente)
  IF pg_catalog.jsonb_typeof(p_request) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid_intent: $' USING ERRCODE = 'PT422';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_request) AS k WHERE k <> ALL (c_keys)) THEN
    RAISE EXCEPTION 'unknown_envelope_key' USING ERRCODE = 'PT422';
  END IF;
  IF p_request ->> 'schema_version' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'unsupported_schema_version' USING ERRCODE = 'PT422';
  END IF;

  v_dev    := lmm.require_device(lmm.parse_uuid(p_request ->> 'device_id'));
  v_rid    := v_dev.restaurant_id;                       -- único origen del restaurante
  v_op     := lmm.parse_uuid(p_request ->> 'operation_id');
  v_idem   := p_request ->> 'idempotency_key';
  IF v_idem IS NULL OR pg_catalog.length(v_idem) NOT BETWEEN 8 AND 200 THEN       -- A-02: ausente => PT422 controlado
    RAISE EXCEPTION 'invalid_intent: $.idempotency_key' USING ERRCODE = 'PT422';
  END IF;
  v_actor  := pg_catalog.left(p_request ->> 'client_actor', 120);
  BEGIN
    v_cts := (p_request ->> 'client_created_at')::timestamptz;      -- informativo
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation THEN
    RAISE EXCEPTION 'invalid_intent: $.client_created_at' USING ERRCODE = 'PT422';
  END;
  v_intent := p_request -> 'intent';
  PERFORM lmm.validate_intent(v_intent);
  v_kind  := v_intent ->> 'kind';
  v_etype := v_intent ->> 'entity_type';
  v_euuid := lmm.parse_uuid(v_intent ->> 'entity_uuid');
  v_hash  := lmm.sha256_hex(lmm.canonical_json(v_intent));           -- solo el INTENT

  -- 2. Insertar la operación: nueva / repetida / clave de negocio reutilizada
  BEGIN
    INSERT INTO lmm.operations (restaurant_id, operation_id, idempotency_key, op_kind, entity_type,
                                entity_uuid, device_id, intent, payload_hash, operation_status,
                                result_payload, client_created_at, client_actor)
    VALUES (v_rid, v_op, v_idem, v_kind, v_etype, v_euuid, v_dev.device_id, v_intent, v_hash,
            'processing', '{}'::jsonb, v_cts, v_actor)
    ON CONFLICT (restaurant_id, operation_id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;                -- 1 = nueva, 0 = ya existía
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_cname = CONSTRAINT_NAME;
    IF v_cname IS DISTINCT FROM 'operations_idem_uk' THEN RAISE; END IF;
    v_rows := -1;                                      -- misma idempotency_key, OTRA operation_id
  END;

  -- 3. Repetida: bloquear, comparar identidad y hash, devolver lo persistido o conflicto
  IF v_rows = 0 THEN
    SELECT o.* INTO v_ex FROM lmm.operations o
     WHERE o.restaurant_id = v_rid AND o.operation_id = v_op
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'operation_vanished' USING ERRCODE = 'PT500';
    END IF;
    IF v_ex.device_id <> v_dev.device_id THEN
      RAISE EXCEPTION 'operation_device_mismatch' USING ERRCODE = 'PT409';
    END IF;
    IF v_ex.payload_hash = v_hash AND v_ex.idempotency_key = v_idem AND v_ex.op_kind = v_kind
       AND v_ex.entity_type = v_etype AND v_ex.entity_uuid = v_euuid THEN
      RETURN v_ex.result_payload || pg_catalog.jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'operation_id_reused_with_different_content' USING ERRCODE = 'PT409';
  ELSIF v_rows = -1 THEN
    SELECT o.* INTO v_other FROM lmm.operations o
     WHERE o.restaurant_id = v_rid AND o.idempotency_key = v_idem
     FOR SHARE;
    IF FOUND AND v_other.payload_hash = v_hash AND v_other.device_id = v_dev.device_id
       AND v_other.op_kind = v_kind AND v_other.entity_uuid = v_euuid THEN
      RETURN v_other.result_payload
             || pg_catalog.jsonb_build_object('replayed', true, 'deduplicated_of', v_other.operation_id);
    END IF;
    RAISE EXCEPTION 'idempotency_key_reused_with_different_content' USING ERRCODE = 'PT409';
  END IF;

  -- 4-6. Operación NUEVA: Fase A (validar/bloquear; puede rechazar) y Fase B (aplicar)
  PERFORM lmm.assert_lines_free(v_rid, v_op, v_intent);              -- 9.5
  IF    v_kind = 'sale'           THEN v_res := lmm.op_sale  (v_rid, v_dev.device_id, v_op, v_intent, v_actor, v_cts);
  ELSIF v_kind = 'modify'         THEN v_res := lmm.op_modify(v_rid, v_dev.device_id, v_op, v_intent, v_actor, v_cts);
  ELSIF v_kind = 'return'         THEN v_res := lmm.op_return(v_rid, v_dev.device_id, v_op, v_intent, v_actor, v_cts);
  ELSIF v_kind = 'cancel'         THEN v_res := lmm.op_cancel(v_rid, v_dev.device_id, v_op, v_intent, v_actor, v_cts);
  ELSIF v_kind = 'reopen'         THEN v_res := lmm.op_reopen(v_rid, v_dev.device_id, v_op, v_intent, v_actor, v_cts);
  ELSIF v_kind IN ('adjust_in','adjust_out')
                                  THEN v_res := lmm.op_adjust(v_rid, v_dev.device_id, v_op, v_intent, v_actor, v_cts);
  ELSIF v_kind = 'catalog_upsert' THEN v_res := lmm.op_catalog(v_rid, v_dev.device_id, v_op, v_intent);
  ELSE RAISE EXCEPTION 'invalid_intent: $.kind' USING ERRCODE = 'PT422';
  END IF;

  -- Rechazo de negocio: se persiste SOLO la operación (la Fase A no escribió nada más)
  IF v_res ->> 'operation_status' = 'rejected' THEN
    UPDATE lmm.operations
       SET operation_status = 'rejected', reject_code = v_res ->> 'reject_code', result_payload = v_res
     WHERE restaurant_id = v_rid AND operation_id = v_op;
    RETURN v_res || pg_catalog.jsonb_build_object('replayed', false, 'deduplicated_of', NULL::uuid);
  END IF;

  -- 7. Secuencia de evento: el bloqueo del contador se retiene hasta el COMMIT
  INSERT INTO lmm.restaurant_event_counters (restaurant_id) VALUES (v_rid) ON CONFLICT DO NOTHING;
  UPDATE lmm.restaurant_event_counters
     SET last_event_seq = last_event_seq + 1
   WHERE restaurant_id = v_rid
  RETURNING last_event_seq INTO v_seq;

  v_res := v_res || pg_catalog.jsonb_build_object('event_seq', v_seq);

  -- 8. Evento con el resultado autoritativo
  INSERT INTO lmm.sync_events (restaurant_id, event_seq, event_type, entity_type, entity_uuid,
                               operation_id, device_id, payload, payload_hash)
  VALUES (v_rid, v_seq, 'operation.applied', v_etype, v_euuid, v_op, v_dev.device_id,
          v_res, lmm.sha256_hex(lmm.canonical_json(v_res)));

  -- 9. Cerrar la operación
  UPDATE lmm.operations
     SET operation_status = 'applied', result_payload = v_res, event_seq = v_seq, applied_at = pg_catalog.now()
   WHERE restaurant_id = v_rid AND operation_id = v_op;

  -- 10. Resultado autoritativo
  RETURN v_res || pg_catalog.jsonb_build_object('replayed', false, 'deduplicated_of', NULL::uuid);
END
$fn$;
```

### 18.4 Autorización y línea de venta (la regla comercial, en un solo lugar)

```sql
-- Valida y BLOQUEA la autorización (rango de bloqueo 2). No la consume (eso es Fase B).
CREATE FUNCTION lmm.check_authorization(
  p_rid uuid, p_dev uuid, p_auth uuid, p_scope text, p_order uuid, p_inv uuid, p_qty numeric,
  OUT ok boolean, OUT reason text, OUT member uuid, OUT member_name text)
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  a      lmm.stock_authorizations;
  v_grace numeric;
  v_limit timestamptz;
BEGIN
  ok := false; member := NULL; member_name := NULL;
  IF p_auth IS NULL THEN reason := 'missing'; RETURN; END IF;

  SELECT COALESCE((SELECT (c.value #>> '{}')::numeric FROM lmm.app_config c
                    WHERE c.key = 'authorization_grace_hours'), 48) INTO v_grace;   -- antes del SELECT que fija FOUND
  SELECT s.* INTO a FROM lmm.stock_authorizations s
   WHERE s.restaurant_id = p_rid AND s.authorization_id = p_auth
   FOR UPDATE;
  -- Vigencia: las autorizaciones online vencen en valid_until; solo los vales offline suman la gracia (A-03).
  -- (Se calcula ANTES de la cadena IF: un CASE...THEN dentro de la condición de un IF rompe el parser de PL/pgSQL.)
  v_limit := a.valid_until + pg_catalog.make_interval(hours => CASE WHEN a.offline_grace THEN v_grace::int ELSE 0 END);

  IF NOT FOUND                                              THEN reason := 'not_found';
  ELSIF a.status = 'consumed'                               THEN reason := 'consumed';
  ELSIF a.status = 'revoked'                                THEN reason := 'revoked';
  ELSIF a.issued_to_device_id <> p_dev                      THEN reason := 'wrong_device';
  ELSIF a.scope <> p_scope                                  THEN reason := 'wrong_scope';
  ELSIF a.order_uuid IS NOT NULL AND a.order_uuid IS DISTINCT FROM p_order
                                                            THEN reason := 'wrong_order';
  ELSIF p_inv IS NOT NULL AND a.inventory_uuid IS NOT NULL AND a.inventory_uuid <> p_inv
                                                            THEN reason := 'wrong_inventory';
  ELSIF a.max_quantity IS NOT NULL AND p_qty IS NOT NULL AND p_qty > a.max_quantity
                                                            THEN reason := 'quantity_exceeds';
  ELSIF pg_catalog.now() > v_limit                          THEN reason := 'expired';
  ELSE
    SELECT m.membership_id, m.display_name INTO member, member_name
      FROM lmm.restaurant_memberships m
     WHERE m.restaurant_id = p_rid AND m.membership_id = a.issued_by_membership_id
       AND m.active AND m.role IN ('owner','admin');
    IF NOT FOUND THEN reason := 'issuer_inactive'; ELSE ok := true; reason := NULL; END IF;
  END IF;
END $$;
```

(`max_quantity` solo se emite para `adjustment`; `lmm_issue_authorization` lo rechaza para `negative_stock`.)

```sql
-- Aplica la regla 10.1 a UNA línea de venta. Precondición: la fila de inventario y la del ledger ya están bloqueadas.
CREATE FUNCTION lmm.apply_sale_line(
  p_rid uuid, p_op uuid, p_dev uuid, p_order uuid, p_line uuid, p_inv uuid, p_qty numeric,
  p_authorized boolean, p_auth_id uuid, p_auth_member uuid, p_auth_name text,
  p_actor text, p_cts timestamptz)
RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_stock   numeric(14,3);
  v_avail   numeric(14,3);
  v_short   numeric(14,3);
  v_applied numeric(14,3);
  v_after   numeric(14,3);
  v_ver     bigint;
  v_moves   jsonb;
BEGIN
  SELECT i.stock INTO STRICT v_stock
    FROM lmm.inventory i WHERE i.restaurant_id = p_rid AND i.inventory_uuid = p_inv;   -- ya bloqueada

  v_avail   := GREATEST(v_stock, 0);                                 -- un saldo negativo nunca es disponible
  v_short   := GREATEST(p_qty - v_avail, 0);                         -- faltante (con o sin autorización)
  v_applied := CASE WHEN p_authorized THEN p_qty ELSE LEAST(p_qty, v_avail) END;
  v_after   := v_stock - v_applied;

  UPDATE lmm.inventory
     SET stock = v_after, version = version + 1, updated_at = pg_catalog.now()
   WHERE restaurant_id = p_rid AND inventory_uuid = p_inv
  RETURNING version INTO v_ver;

  INSERT INTO lmm.stock_movements (restaurant_id, movement_id, operation_id, line_id, kind, inventory_uuid,
      order_uuid, requested_qty, applied_qty, shortage_qty, stock_delta, stock_before, stock_after,
      authorization_id, authorized_by_membership_id, authorized_by_name, device_id, client_actor, client_created_at)
  VALUES (p_rid, p_line, p_op, p_line, 'sale', p_inv, p_order, p_qty, v_applied, v_short, -v_applied,
      v_stock, v_after,
      CASE WHEN p_authorized THEN p_auth_id END, CASE WHEN p_authorized THEN p_auth_member END,
      CASE WHEN p_authorized THEN p_auth_name END, p_dev, p_actor, p_cts);

  v_moves := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'movement_id', p_line, 'line_id', p_line, 'kind', 'sale', 'inventory_uuid', p_inv,
      'requested_qty', lmm.qty_text(p_qty), 'applied_qty', lmm.qty_text(v_applied),
      'shortage_qty', lmm.qty_text(v_short), 'stock_delta', lmm.qty_text(-v_applied),
      'stock_before', lmm.qty_text(v_stock), 'stock_after', lmm.qty_text(v_after)));

  IF v_short > 0 THEN                                                -- movimiento 'shortage' separado
    INSERT INTO lmm.stock_movements (restaurant_id, movement_id, operation_id, line_id, kind, inventory_uuid,
        order_uuid, requested_qty, applied_qty, shortage_qty, stock_delta, stock_before, stock_after,
        authorization_id, authorized_by_membership_id, authorized_by_name, device_id, client_actor, client_created_at)
    VALUES (p_rid, lmm.derive_uuid('shortage', p_line::text), p_op, p_line, 'shortage', p_inv, p_order,
        p_qty, 0, v_short, 0, v_after, v_after,
        CASE WHEN p_authorized THEN p_auth_id END, CASE WHEN p_authorized THEN p_auth_member END,
        CASE WHEN p_authorized THEN p_auth_name END, p_dev, p_actor, p_cts);
    v_moves := v_moves || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'movement_id', lmm.derive_uuid('shortage', p_line::text), 'line_id', p_line, 'kind', 'shortage',
        'inventory_uuid', p_inv, 'requested_qty', lmm.qty_text(p_qty), 'applied_qty', '0',
        'shortage_qty', lmm.qty_text(v_short), 'stock_delta', '0',
        'stock_before', lmm.qty_text(v_after), 'stock_after', lmm.qty_text(v_after)));
  END IF;

  UPDATE lmm.order_inventory_ledger
     SET requested_net = requested_net + p_qty, discounted_total = discounted_total + v_applied,
         updated_at = pg_catalog.now()
   WHERE restaurant_id = p_rid AND order_uuid = p_order AND inventory_uuid = p_inv;

  RETURN pg_catalog.jsonb_build_object('movements', v_moves,
           'inventory', pg_catalog.jsonb_build_object('inventory_uuid', p_inv,
                          'stock', lmm.qty_text(v_after), 'version', v_ver));
END $$;
```

Comprobación manual de la regla con el caso obligatorio: `v_stock = −3`, `p_qty = 2`, `p_authorized = false` ⇒ `v_avail = 0`, `v_short = 2`, `v_applied = LEAST(2, 0) = 0`, `v_after = −3 − 0 = −3` (el saldo **no** aumenta). Con `p_authorized = true` ⇒ `v_applied = 2`, `v_after = −5`.

```sql
-- Devuelve qty a partir de las ventas fuente, FIFO. Precondición: ledger e inventario bloqueados.
CREATE FUNCTION lmm.return_fifo(p_rid uuid, p_op uuid, p_dev uuid, p_order uuid, p_inv uuid,
                                p_qty numeric, p_tag text, p_actor text, p_cts timestamptz)
RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_left   numeric(14,3) := p_qty;
  v_take   numeric(14,3);
  v_src    RECORD;
  v_stock  numeric(14,3);
  v_after  numeric(14,3);
  v_ver    bigint;
  v_mid    uuid;
  v_moves  jsonb := '[]'::jsonb;
BEGIN
  FOR v_src IN
    SELECT s.operation_id AS src,
           s.sold - COALESCE((SELECT SUM(r.applied_qty) FROM lmm.stock_movements r
                               WHERE r.restaurant_id = p_rid AND r.kind = 'return'
                                 AND r.source_operation_id = s.operation_id
                                 AND r.inventory_uuid = p_inv), 0) AS remaining
      FROM (SELECT m.operation_id, SUM(m.applied_qty) AS sold, MIN(m.created_at) AS first_at
              FROM lmm.stock_movements m
             WHERE m.restaurant_id = p_rid AND m.order_uuid = p_order
               AND m.inventory_uuid = p_inv AND m.kind = 'sale'
             GROUP BY m.operation_id) s
     ORDER BY s.first_at, s.operation_id
  LOOP
    EXIT WHEN v_left <= 0;
    CONTINUE WHEN v_src.remaining <= 0;
    v_take := LEAST(v_left, v_src.remaining);
    v_mid  := lmm.derive_uuid(p_tag, p_op::text || ':' || v_src.src::text || ':' || p_inv::text);

    SELECT i.stock INTO STRICT v_stock FROM lmm.inventory i
     WHERE i.restaurant_id = p_rid AND i.inventory_uuid = p_inv;
    v_after := v_stock + v_take;
    UPDATE lmm.inventory SET stock = v_after, version = version + 1, updated_at = pg_catalog.now()
     WHERE restaurant_id = p_rid AND inventory_uuid = p_inv RETURNING version INTO v_ver;

    INSERT INTO lmm.stock_movements (restaurant_id, movement_id, operation_id, line_id, kind, inventory_uuid,
        order_uuid, source_operation_id, requested_qty, applied_qty, shortage_qty, stock_delta,
        stock_before, stock_after, reason_text, device_id, client_actor, client_created_at)
    VALUES (p_rid, v_mid, p_op, v_mid, 'return', p_inv, p_order, v_src.src, v_take, v_take, 0, v_take,
        v_stock, v_after, p_tag, p_dev, p_actor, p_cts);

    UPDATE lmm.order_inventory_ledger
       SET returned_total = returned_total + v_take, updated_at = pg_catalog.now()
     WHERE restaurant_id = p_rid AND order_uuid = p_order AND inventory_uuid = p_inv;

    v_moves := v_moves || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'movement_id', v_mid, 'line_id', v_mid, 'kind', 'return', 'inventory_uuid', p_inv,
        'requested_qty', lmm.qty_text(v_take), 'applied_qty', lmm.qty_text(v_take), 'shortage_qty', '0',
        'stock_delta', lmm.qty_text(v_take), 'stock_before', lmm.qty_text(v_stock), 'stock_after', lmm.qty_text(v_after),
        'source_operation_id', v_src.src));
    v_left := v_left - v_take;
  END LOOP;

  IF v_left > 0 THEN   -- por construcción del ledger no debe ocurrir: revertir todo
    RAISE EXCEPTION 'internal_ledger_inconsistency' USING ERRCODE = 'PT500';
  END IF;
  RETURN pg_catalog.jsonb_build_object('movements', v_moves);
END $$;
```

### 18.5 Operaciones

**Venta (completa):**

```sql
CREATE FUNCTION lmm.op_sale(p_rid uuid, p_dev uuid, p_op uuid, p_in jsonb, p_actor text, p_cts timestamptz)
RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_order  uuid := (p_in ->> 'entity_uuid')::uuid;
  v_items  jsonb := p_in -> 'items';
  v_item   jsonb;
  v_ids    uuid[];
  v_auth   uuid  := NULLIF(p_in ->> 'authorization_id', '')::uuid;
  v_ok     boolean := false;
  v_reason text;
  v_member uuid;
  v_mname  text;
  v_rows   integer;
  v_line   jsonb;
  v_moves  jsonb := '[]'::jsonb;
  v_invmap jsonb := '{}'::jsonb;
BEGIN
  ------------------------------------------------------------------ Fase A (puede rechazar)
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT (x.value ->> 'inventory_uuid')::uuid), ARRAY[]::uuid[])
    INTO v_ids
    FROM pg_catalog.jsonb_array_elements(v_items) AS x(value)
   WHERE x.value ->> 'item_type' = 'inventory';

  IF (SELECT pg_catalog.count(*) FROM lmm.inventory i
       WHERE i.restaurant_id = p_rid AND i.inventory_uuid = ANY (v_ids) AND NOT i.deleted)
     <> pg_catalog.cardinality(v_ids) THEN
    RETURN lmm.reject(p_op, 'sale', 'inventory_not_found');
  END IF;

  IF v_auth IS NOT NULL THEN                                         -- bloqueo 2: autorización
    SELECT c.ok, c.reason, c.member, c.member_name INTO v_ok, v_reason, v_member, v_mname
      FROM lmm.check_authorization(p_rid, p_dev, v_auth, 'negative_stock', v_order, NULL, NULL) c;
    IF NOT v_ok THEN
      RETURN lmm.reject(p_op, 'sale', 'authorization_invalid', pg_catalog.jsonb_build_object('reason', v_reason));
    END IF;
  END IF;

  INSERT INTO lmm.orders (restaurant_id, order_uuid, version, status, snapshot, created_by_device_id)   -- bloqueo 3 (creación)
  VALUES (p_rid, v_order, 1, 'open', COALESCE(p_in -> 'snapshot', '{}'::jsonb), p_dev)
  ON CONFLICT (restaurant_id, order_uuid) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN lmm.reject(p_op, 'sale', 'order_already_exists');
  END IF;

  ------------------------------------------------------------------ Fase B (sin rechazos de negocio)
  INSERT INTO lmm.order_inventory_ledger (restaurant_id, order_uuid, inventory_uuid)             -- bloqueo 4
  SELECT p_rid, v_order, u FROM pg_catalog.unnest(v_ids) AS u ON CONFLICT DO NOTHING;
  PERFORM 1 FROM lmm.order_inventory_ledger l
   WHERE l.restaurant_id = p_rid AND l.order_uuid = v_order AND l.inventory_uuid = ANY (v_ids)
   ORDER BY l.inventory_uuid FOR UPDATE;
  PERFORM 1 FROM lmm.inventory i                                                                  -- bloqueo 5
   WHERE i.restaurant_id = p_rid AND i.inventory_uuid = ANY (v_ids)
   ORDER BY i.inventory_uuid FOR UPDATE;

  INSERT INTO lmm.order_items (restaurant_id, item_uuid, order_uuid, item_type, inventory_uuid,
                              name, unit_price, qty, line_total, note)
  SELECT p_rid, x.item_uuid, v_order, x.item_type, x.inventory_uuid, x.name, x.unit_price, x.qty,
         pg_catalog.round(x.unit_price * x.qty, 2), x.note
    FROM pg_catalog.jsonb_to_recordset(v_items)
         AS x(item_uuid uuid, item_type text, inventory_uuid uuid, name text,
              unit_price numeric, qty numeric, note text)
  ON CONFLICT (restaurant_id, item_uuid) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> pg_catalog.jsonb_array_length(v_items) THEN     -- V8.1 (C-04): el pedido es nuevo; un conflicto es un ítem de OTRO pedido
    RAISE EXCEPTION 'item_uuid_belongs_to_other_order' USING ERRCODE = 'PT409';
  END IF;

  FOR v_item IN
    SELECT t.value FROM pg_catalog.jsonb_array_elements(v_items) WITH ORDINALITY AS t(value, ord) ORDER BY t.ord
  LOOP
    IF v_item ->> 'item_type' = 'inventory' THEN
      v_line := lmm.apply_sale_line(p_rid, p_op, p_dev, v_order,
                  (v_item ->> 'item_uuid')::uuid, (v_item ->> 'inventory_uuid')::uuid,
                  (v_item ->> 'qty')::numeric, v_auth IS NOT NULL, v_auth, v_member, v_mname, p_actor, p_cts);
      v_moves  := v_moves || (v_line -> 'movements');
      v_invmap := v_invmap || pg_catalog.jsonb_build_object(v_line -> 'inventory' ->> 'inventory_uuid', v_line -> 'inventory');
    END IF;
  END LOOP;

  IF v_auth IS NOT NULL THEN
    UPDATE lmm.stock_authorizations
       SET status = 'consumed', consumed_by_operation_id = p_op, consumed_at = pg_catalog.now()
     WHERE restaurant_id = p_rid AND authorization_id = v_auth;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'schema_version', 1, 'operation_id', p_op, 'op_kind', 'sale', 'operation_status', 'applied',
    'reject_code', NULL::text,
    'order', lmm.order_json(p_rid, v_order),                         -- {order_uuid, version, status, items[]}
    'movements', v_moves,
    'inventory', COALESCE((SELECT pg_catalog.jsonb_agg(e.value ORDER BY e.key)
                             FROM pg_catalog.jsonb_each(v_invmap) AS e), '[]'::jsonb),
    'authorization', pg_catalog.jsonb_build_object('authorization_id', v_auth,
                       'consumed', v_auth IS NOT NULL, 'authorized_by', v_mname));
END $$;
```

**Devolución (validación + aplicación):**

```sql
CREATE FUNCTION lmm.op_return(p_rid uuid, p_dev uuid, p_op uuid, p_in jsonb, p_actor text, p_cts timestamptz)
RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_order uuid := (p_in ->> 'entity_uuid')::uuid;
  v_ids   uuid[];
  v_agg   RECORD;
  v_line  jsonb;
  v_stock numeric(14,3);
  v_after numeric(14,3);
  v_ver   bigint;
  v_rem_src numeric;
  v_rem_ord numeric;
  v_moves jsonb := '[]'::jsonb;
  v_invmap jsonb := '{}'::jsonb;
BEGIN
  ------------------------------------------------------------------ Fase A
  PERFORM 1 FROM lmm.orders o WHERE o.restaurant_id = p_rid AND o.order_uuid = v_order FOR UPDATE;   -- bloqueo 3
  IF NOT FOUND THEN RETURN lmm.reject(p_op, 'return', 'order_not_found'); END IF;

  SELECT COALESCE(pg_catalog.array_agg(DISTINCT (l.value ->> 'inventory_uuid')::uuid), ARRAY[]::uuid[])
    INTO v_ids FROM pg_catalog.jsonb_array_elements(p_in -> 'lines') AS l(value);
  PERFORM 1 FROM lmm.order_inventory_ledger g                                                         -- bloqueo 4
   WHERE g.restaurant_id = p_rid AND g.order_uuid = v_order AND g.inventory_uuid = ANY (v_ids)
   ORDER BY g.inventory_uuid FOR UPDATE;
  PERFORM 1 FROM lmm.inventory i                                                                       -- bloqueo 5
   WHERE i.restaurant_id = p_rid AND i.inventory_uuid = ANY (v_ids) ORDER BY i.inventory_uuid FOR UPDATE;

  FOR v_agg IN
    SELECT (l.value ->> 'source_operation_id')::uuid AS src,
           (l.value ->> 'inventory_uuid')::uuid      AS inv,
           SUM((l.value ->> 'qty')::numeric)         AS qty
      FROM pg_catalog.jsonb_array_elements(p_in -> 'lines') AS l(value)
     GROUP BY 1, 2 ORDER BY 2, 1
  LOOP
    IF NOT EXISTS (SELECT 1 FROM lmm.operations s
                    WHERE s.restaurant_id = p_rid AND s.operation_id = v_agg.src
                      AND s.operation_status = 'applied' AND s.entity_type = 'order' AND s.entity_uuid = v_order)
       OR NOT EXISTS (SELECT 1 FROM lmm.stock_movements m
                       WHERE m.restaurant_id = p_rid AND m.operation_id = v_agg.src
                         AND m.inventory_uuid = v_agg.inv AND m.kind = 'sale') THEN
      RETURN lmm.reject(p_op, 'return', 'source_operation_invalid',
               pg_catalog.jsonb_build_object('source_operation_id', v_agg.src));
    END IF;

    SELECT COALESCE(SUM(m.applied_qty) FILTER (WHERE m.kind = 'sale'), 0)
         - COALESCE(SUM(m.applied_qty) FILTER (WHERE m.kind = 'return' AND m.source_operation_id = v_agg.src), 0)
      INTO v_rem_src
      FROM lmm.stock_movements m
     WHERE m.restaurant_id = p_rid AND m.inventory_uuid = v_agg.inv
       AND ((m.kind = 'sale' AND m.operation_id = v_agg.src)
         OR (m.kind = 'return' AND m.source_operation_id = v_agg.src));

    SELECT COALESCE(g.discounted_total - g.returned_total, 0) INTO v_rem_ord
      FROM lmm.order_inventory_ledger g
     WHERE g.restaurant_id = p_rid AND g.order_uuid = v_order AND g.inventory_uuid = v_agg.inv;

    IF v_agg.qty > v_rem_src OR v_agg.qty > COALESCE(v_rem_ord, 0) THEN
      RETURN lmm.reject(p_op, 'return', 'return_exceeds_remaining',
               pg_catalog.jsonb_build_object('inventory_uuid', v_agg.inv,
                 'remaining', lmm.qty_text(LEAST(v_rem_src, COALESCE(v_rem_ord, 0)))));
    END IF;
  END LOOP;

  ------------------------------------------------------------------ Fase B
  FOR v_line IN
    SELECT t.value FROM pg_catalog.jsonb_array_elements(p_in -> 'lines') WITH ORDINALITY AS t(value, ord) ORDER BY t.ord
  LOOP
    SELECT i.stock INTO STRICT v_stock FROM lmm.inventory i
     WHERE i.restaurant_id = p_rid AND i.inventory_uuid = (v_line ->> 'inventory_uuid')::uuid;
    v_after := v_stock + (v_line ->> 'qty')::numeric;
    UPDATE lmm.inventory SET stock = v_after, version = version + 1, updated_at = pg_catalog.now()
     WHERE restaurant_id = p_rid AND inventory_uuid = (v_line ->> 'inventory_uuid')::uuid RETURNING version INTO v_ver;

    INSERT INTO lmm.stock_movements (restaurant_id, movement_id, operation_id, line_id, kind, inventory_uuid,
        order_uuid, source_operation_id, requested_qty, applied_qty, shortage_qty, stock_delta,
        stock_before, stock_after, reason_text, device_id, client_actor, client_created_at)
    VALUES (p_rid, (v_line ->> 'line_id')::uuid, p_op, (v_line ->> 'line_id')::uuid, 'return',
        (v_line ->> 'inventory_uuid')::uuid, v_order, (v_line ->> 'source_operation_id')::uuid,
        (v_line ->> 'qty')::numeric, (v_line ->> 'qty')::numeric, 0, (v_line ->> 'qty')::numeric,
        v_stock, v_after, v_line ->> 'reason_text', p_dev, p_actor, p_cts);

    -- V8.1 (C-02): una devolución es un movimiento independiente. NO reduce requested_net (lo que el pedido
    -- contiene): si lo hiciera, un `modify` posterior que conserve la cantidad volvería a descontar lo devuelto.
    UPDATE lmm.order_inventory_ledger
       SET returned_total = returned_total + (v_line ->> 'qty')::numeric,
           updated_at = pg_catalog.now()
     WHERE restaurant_id = p_rid AND order_uuid = v_order AND inventory_uuid = (v_line ->> 'inventory_uuid')::uuid;

    v_moves := v_moves || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'movement_id', v_line ->> 'line_id', 'line_id', v_line ->> 'line_id', 'kind', 'return',
        'inventory_uuid', v_line ->> 'inventory_uuid', 'source_operation_id', v_line ->> 'source_operation_id',
        'requested_qty', lmm.qty_text((v_line ->> 'qty')::numeric), 'applied_qty', lmm.qty_text((v_line ->> 'qty')::numeric),
        'shortage_qty', '0', 'stock_delta', lmm.qty_text((v_line ->> 'qty')::numeric),
        'stock_before', lmm.qty_text(v_stock), 'stock_after', lmm.qty_text(v_after)));
    v_invmap := v_invmap || pg_catalog.jsonb_build_object(v_line ->> 'inventory_uuid',
        pg_catalog.jsonb_build_object('inventory_uuid', v_line ->> 'inventory_uuid',
                                      'stock', lmm.qty_text(v_after), 'version', v_ver));
  END LOOP;

  RETURN pg_catalog.jsonb_build_object(
    'schema_version', 1, 'operation_id', p_op, 'op_kind', 'return', 'operation_status', 'applied',
    'reject_code', NULL::text, 'movements', v_moves,
    'inventory', COALESCE((SELECT pg_catalog.jsonb_agg(e.value ORDER BY e.key)
                             FROM pg_catalog.jsonb_each(v_invmap) AS e), '[]'::jsonb),
    'authorization', pg_catalog.jsonb_build_object('authorization_id', NULL::uuid, 'consumed', false, 'authorized_by', NULL::text));
END $$;
```

**Ajuste (`adjust_in` / `adjust_out`):**

```sql
CREATE FUNCTION lmm.op_adjust(p_rid uuid, p_dev uuid, p_op uuid, p_in jsonb, p_actor text, p_cts timestamptz)
RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_inv    uuid    := (p_in ->> 'entity_uuid')::uuid;
  v_qty    numeric := (p_in ->> 'qty')::numeric;
  v_in     boolean := (p_in ->> 'kind') = 'adjust_in';
  v_auth   uuid    := NULLIF(p_in ->> 'authorization_id', '')::uuid;
  v_ok     boolean; v_reason text; v_member uuid; v_mname text;
  v_stock  numeric(14,3); v_after numeric(14,3); v_delta numeric(14,3); v_ver bigint;
BEGIN
  ------------------------------------------------------------------ Fase A
  IF NOT EXISTS (SELECT 1 FROM lmm.inventory i
                  WHERE i.restaurant_id = p_rid AND i.inventory_uuid = v_inv AND NOT i.deleted) THEN
    RETURN lmm.reject(p_op, p_in ->> 'kind', 'inventory_not_found');
  END IF;
  SELECT c.ok, c.reason, c.member, c.member_name INTO v_ok, v_reason, v_member, v_mname
    FROM lmm.check_authorization(p_rid, p_dev, v_auth, 'adjustment', NULL, v_inv, v_qty) c;
  IF NOT v_ok THEN
    RETURN lmm.reject(p_op, p_in ->> 'kind', 'authorization_invalid', pg_catalog.jsonb_build_object('reason', v_reason));
  END IF;

  ------------------------------------------------------------------ Fase B
  SELECT i.stock INTO STRICT v_stock FROM lmm.inventory i
   WHERE i.restaurant_id = p_rid AND i.inventory_uuid = v_inv FOR UPDATE;          -- bloqueo 5
  v_delta := CASE WHEN v_in THEN v_qty ELSE -v_qty END;                              -- el signo lo da el kind, no el cliente
  v_after := v_stock + v_delta;
  UPDATE lmm.inventory SET stock = v_after, version = version + 1, updated_at = pg_catalog.now()
   WHERE restaurant_id = p_rid AND inventory_uuid = v_inv RETURNING version INTO v_ver;

  INSERT INTO lmm.stock_movements (restaurant_id, movement_id, operation_id, line_id, kind, inventory_uuid,
      requested_qty, applied_qty, shortage_qty, stock_delta, stock_before, stock_after,
      reason_code, reason_text, authorization_id, authorized_by_membership_id, authorized_by_name,
      device_id, client_actor, client_created_at)
  VALUES (p_rid, lmm.derive_uuid('adjust', p_op::text), p_op, lmm.derive_uuid('adjust-line', p_op::text),
      CASE WHEN v_in THEN 'adjustment_in' ELSE 'adjustment_out' END, v_inv,
      v_qty, v_qty, 0, v_delta, v_stock, v_after,
      p_in ->> 'reason_code', p_in ->> 'reason_text', v_auth, v_member, v_mname, p_dev, p_actor, p_cts);

  UPDATE lmm.stock_authorizations
     SET status = 'consumed', consumed_by_operation_id = p_op, consumed_at = pg_catalog.now()
   WHERE restaurant_id = p_rid AND authorization_id = v_auth;

  RETURN pg_catalog.jsonb_build_object(
    'schema_version', 1, 'operation_id', p_op, 'op_kind', p_in ->> 'kind', 'operation_status', 'applied',
    'reject_code', NULL::text,
    'movements', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'movement_id', lmm.derive_uuid('adjust', p_op::text), 'line_id', lmm.derive_uuid('adjust-line', p_op::text),
        'kind', CASE WHEN v_in THEN 'adjustment_in' ELSE 'adjustment_out' END, 'inventory_uuid', v_inv,
        'requested_qty', lmm.qty_text(v_qty), 'applied_qty', lmm.qty_text(v_qty), 'shortage_qty', '0',
        'stock_delta', lmm.qty_text(v_delta), 'stock_before', lmm.qty_text(v_stock), 'stock_after', lmm.qty_text(v_after))),
    'inventory', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'inventory_uuid', v_inv, 'stock', lmm.qty_text(v_after), 'version', v_ver)),
    'authorization', pg_catalog.jsonb_build_object('authorization_id', v_auth, 'consumed', true, 'authorized_by', v_mname));
END $$;
```

**`modify`, `cancel`, `reopen`, `lmm.validate_intent`, `lmm.assert_lines_free`, `lmm.order_json` y `lmm.op_catalog`:** código completo en 18.7.

### 18.6 Eventos y autorización

```sql
CREATE FUNCTION public.lmm_get_events(p_device_id uuid, p_from_seq bigint,
                                      p_limit integer DEFAULT 200, p_ack_seq bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET statement_timeout = '10s' AS $fn$
DECLARE
  v_dev    lmm.devices;
  v_limit  integer := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
  v_cnt    lmm.restaurant_event_counters;
  v_events jsonb;
  v_max    bigint;
BEGIN
  v_dev := lmm.require_device(p_device_id);
  IF p_from_seq IS NULL OR p_from_seq < 0 THEN
    RAISE EXCEPTION 'invalid_intent: from_seq' USING ERRCODE = 'PT422';
  END IF;

  IF p_ack_seq IS NOT NULL THEN
    UPDATE lmm.devices d
       SET last_ack_seq = GREATEST(d.last_ack_seq, LEAST(p_ack_seq,
             (SELECT c.last_event_seq FROM lmm.restaurant_event_counters c WHERE c.restaurant_id = d.restaurant_id))),
           last_seen_at = pg_catalog.now()
     WHERE d.device_id = v_dev.device_id;
  END IF;

  SELECT c.* INTO v_cnt FROM lmm.restaurant_event_counters c WHERE c.restaurant_id = v_dev.restaurant_id;
  IF p_from_seq + 1 < v_cnt.min_retained_seq THEN
    RETURN pg_catalog.jsonb_build_object('status', 'resync_required',
             'min_retained_seq', v_cnt.min_retained_seq, 'last_event_seq', v_cnt.last_event_seq);
  END IF;

  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(e) - 'restaurant_id' ORDER BY e.event_seq), '[]'::jsonb),
         COALESCE(pg_catalog.max(e.event_seq), p_from_seq)
    INTO v_events, v_max
    FROM (SELECT * FROM lmm.sync_events s
           WHERE s.restaurant_id = v_dev.restaurant_id AND s.event_seq > p_from_seq
           ORDER BY s.event_seq LIMIT v_limit) e;

  SELECT c.last_event_seq INTO v_cnt.last_event_seq
    FROM lmm.restaurant_event_counters c WHERE c.restaurant_id = v_dev.restaurant_id;

  RETURN pg_catalog.jsonb_build_object('status', 'ok', 'events', v_events,
           'has_more', v_max < v_cnt.last_event_seq, 'last_event_seq', v_cnt.last_event_seq);
END $fn$;
```

```sql
CREATE FUNCTION public.lmm_issue_authorization(p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_dev    lmm.devices;
  v_m      lmm.restaurant_memberships;
  v_scope  text := p_request ->> 'scope';
  v_ttl    integer := LEAST(GREATEST(COALESCE((p_request ->> 'ttl_minutes')::integer, 10), 1), 720);
  v_pin    text := p_request ->> 'pin';
  v_id     uuid := pg_catalog.gen_random_uuid();
  v_max    numeric := (p_request ->> 'max_quantity')::numeric;
  v_off    boolean := COALESCE((p_request ->> 'offline_voucher')::boolean, false);
BEGIN
  v_dev := lmm.require_device(lmm.parse_uuid(p_request ->> 'device_id'));
  IF NOT v_off AND v_ttl > 60 THEN v_ttl := 60; END IF;       -- las autorizaciones online duran como máximo 60 min y sin gracia
  IF v_scope NOT IN ('negative_stock','adjustment')
     OR (v_scope = 'negative_stock' AND v_max IS NOT NULL)
     OR (v_scope = 'adjustment' AND (p_request ->> 'inventory_uuid') IS NULL) THEN
    RAISE EXCEPTION 'invalid_intent: scope' USING ERRCODE = 'PT422';
  END IF;

  SELECT m.* INTO v_m FROM lmm.restaurant_memberships m
   WHERE m.restaurant_id = v_dev.restaurant_id
     AND m.membership_id = lmm.parse_uuid(p_request ->> 'approver_membership_id')
     AND m.active AND m.role IN ('owner','admin')
   FOR UPDATE;
  IF NOT FOUND OR v_m.approval_pin_hash IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'rejected', 'reject_code', 'approver_invalid');
  END IF;
  IF v_m.pin_locked_until IS NOT NULL AND v_m.pin_locked_until > pg_catalog.now() THEN
    RETURN pg_catalog.jsonb_build_object('status', 'rejected', 'reject_code', 'approver_locked');
  END IF;

  IF v_pin IS NULL OR extensions.crypt(v_pin, v_m.approval_pin_hash) <> v_m.approval_pin_hash THEN
    UPDATE lmm.restaurant_memberships m                       -- el contador PERSISTE (no hay excepción)
       SET pin_failed_attempts = m.pin_failed_attempts + 1,
           pin_locked_until = CASE WHEN m.pin_failed_attempts + 1 >= 5
                                   THEN pg_catalog.now() + interval '15 minutes' END
     WHERE m.membership_id = v_m.membership_id;
    RETURN pg_catalog.jsonb_build_object('status', 'rejected', 'reject_code', 'pin_invalid');
  END IF;

  UPDATE lmm.restaurant_memberships SET pin_failed_attempts = 0, pin_locked_until = NULL
   WHERE membership_id = v_m.membership_id;

  INSERT INTO lmm.stock_authorizations (restaurant_id, authorization_id, scope, issued_by_membership_id,
      issued_to_device_id, order_uuid, inventory_uuid, max_quantity, valid_until, offline_grace)
  VALUES (v_dev.restaurant_id, v_id, v_scope, v_m.membership_id, v_dev.device_id,
      NULLIF(p_request ->> 'order_uuid', '')::uuid, NULLIF(p_request ->> 'inventory_uuid', '')::uuid,
      v_max, pg_catalog.now() + pg_catalog.make_interval(mins => v_ttl), v_off);

  RETURN pg_catalog.jsonb_build_object('status', 'issued', 'authorization_id', v_id,
           'valid_until', pg_catalog.now() + pg_catalog.make_interval(mins => v_ttl),
           'approver_display_name', v_m.display_name);
END $fn$;
```

`lmm_get_snapshot`, `lmm_create_enrollment`, `lmm_enroll_device`, `lmm_revoke_device` y `lmm_purge_events` siguen el mismo patrón (identidad por `lmm.require_device` o membresía activa `owner/admin` por `auth.uid()`, consultas con schema explícito, resultado `jsonb`); su contrato está en 13.1, 13.7 y 15.7.

### 18.7 Funciones auxiliares restantes (código)

```sql
-- Resultado de inventario para un conjunto de productos (saldo confirmado y versión actuales)
CREATE FUNCTION lmm.inventory_json(p_rid uuid, p_ids uuid[]) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$   -- STABLE: comparte la instantánea de la sentencia que la llama (lmm_get_snapshot)
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'inventory_uuid', i.inventory_uuid, 'stock', lmm.qty_text(i.stock), 'version', i.version)
         ORDER BY i.inventory_uuid), '[]'::jsonb)
    FROM lmm.inventory i WHERE i.restaurant_id = p_rid AND i.inventory_uuid = ANY (p_ids)
$$;

-- Pedido autoritativo (para el resultado y el evento)
CREATE FUNCTION lmm.order_json(p_rid uuid, p_order uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$   -- STABLE: ver nota en inventory_json
  SELECT pg_catalog.jsonb_build_object(
           'order_uuid', o.order_uuid, 'version', o.version, 'status', o.status,
           'items', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                        'item_uuid', i.item_uuid, 'item_type', i.item_type, 'inventory_uuid', i.inventory_uuid,
                        'name', i.name, 'unit_price', lmm.qty_text(i.unit_price), 'qty', lmm.qty_text(i.qty),
                        'line_total', lmm.qty_text(i.line_total), 'deleted', i.deleted) ORDER BY i.item_uuid)
                       FROM lmm.order_items i
                      WHERE i.restaurant_id = o.restaurant_id AND i.order_uuid = o.order_uuid), '[]'::jsonb))
    FROM lmm.orders o WHERE o.restaurant_id = p_rid AND o.order_uuid = p_order
$$;

-- Identificadores candidatos de la operación: ninguno puede pertenecer a otra operación u otro pedido (9.5)
CREATE FUNCTION lmm.assert_lines_free(p_rid uuid, p_op uuid, p_intent jsonb) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_ids   uuid[];
  v_items uuid[];
BEGIN
  SELECT COALESCE(pg_catalog.array_agg((i.value ->> 'item_uuid')::uuid), ARRAY[]::uuid[]) INTO v_items
    FROM pg_catalog.jsonb_array_elements(COALESCE(p_intent -> 'items', '[]'::jsonb)) AS i(value);

  SELECT COALESCE(pg_catalog.array_agg(s.x), ARRAY[]::uuid[]) INTO v_ids FROM (
    SELECT u AS x FROM pg_catalog.unnest(v_items) AS u
    UNION SELECT lmm.derive_uuid('shortage', u::text) FROM pg_catalog.unnest(v_items) AS u
    UNION SELECT (l.value ->> 'line_id')::uuid
            FROM pg_catalog.jsonb_array_elements(COALESCE(p_intent -> 'lines', '[]'::jsonb)) AS l(value)
    UNION SELECT lmm.derive_uuid('adjust', p_op::text)      WHERE p_intent ->> 'kind' IN ('adjust_in','adjust_out')
    UNION SELECT lmm.derive_uuid('adjust-line', p_op::text) WHERE p_intent ->> 'kind' IN ('adjust_in','adjust_out')
  ) s;

  IF EXISTS (SELECT 1 FROM lmm.stock_movements m
              WHERE m.restaurant_id = p_rid AND m.operation_id <> p_op
                AND (m.line_id = ANY (v_ids) OR m.movement_id = ANY (v_ids))) THEN
    RAISE EXCEPTION 'line_id_belongs_to_other_operation' USING ERRCODE = 'PT409';
  END IF;

  -- Comprobación temprana (barata). La defensa real contra la carrera es el ON CONFLICT ... WHERE de op_sale/op_modify (C-04).
  IF p_intent ->> 'entity_type' = 'order' AND EXISTS (
       SELECT 1 FROM lmm.order_items i
        WHERE i.restaurant_id = p_rid AND i.item_uuid = ANY (v_items)
          AND i.order_uuid <> (p_intent ->> 'entity_uuid')::uuid) THEN
    RAISE EXCEPTION 'item_uuid_belongs_to_other_order' USING ERRCODE = 'PT409';
  END IF;
END $$;

-- Helpers de validación (V8.1, A-02): devuelven SIEMPRE true/false, NUNCA NULL. Con un campo ausente,
-- `jsonb_typeof(NULL)` es NULL y una condición `IF <NULL>` no se cumple: por eso se valida con helpers que
-- convierten "ausente" en false y se usa `IF NOT lmm.ok_xxx(...)`. El orden de evaluación de AND/OR no está
-- garantizado en SQL, así que los casts ocurren dentro de un CASE.
CREATE FUNCTION lmm.ok_qty(j jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN pg_catalog.jsonb_typeof(j) = 'string'
               AND (j #>> '{}') ~ '^(0|[1-9][0-9]*)(\.[0-9]{0,2}[1-9])?$'
              THEN (j #>> '{}')::numeric BETWEEN 0.001 AND 1000000
              ELSE false END
$$;
CREATE FUNCTION lmm.ok_money(j jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN pg_catalog.jsonb_typeof(j) = 'string'
               AND (j #>> '{}') ~ '^(0|[1-9][0-9]*)(\.[0-9]?[1-9])?$'
              THEN (j #>> '{}')::numeric <= 99999999.99
              ELSE false END
$$;
CREATE FUNCTION lmm.ok_text(j jsonb, p_min integer, p_max integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN pg_catalog.jsonb_typeof(j) = 'string'
              THEN pg_catalog.length(j #>> '{}') BETWEEN p_min AND p_max
              ELSE false END
$$;
CREATE FUNCTION lmm.ok_one_of(j jsonb, p_vals text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN pg_catalog.jsonb_typeof(j) = 'string' THEN (j #>> '{}') = ANY (p_vals) ELSE false END
$$;
CREATE FUNCTION lmm.ok_array_len(j jsonb, p_max integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN pg_catalog.jsonb_typeof(j) = 'array'
              THEN pg_catalog.jsonb_array_length(j) BETWEEN 1 AND p_max
              ELSE false END
$$;
CREATE FUNCTION lmm.ok_version(j jsonb) RETURNS boolean   -- entero >= 1
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN pg_catalog.jsonb_typeof(j) = 'number'
              THEN (j #>> '{}')::numeric >= 1 AND (j #>> '{}')::numeric = pg_catalog.trunc((j #>> '{}')::numeric)
              ELSE false END
$$;

-- Validación estructural del intent (7.5-7.6). Lanza PT422 con la ruta del error.
CREATE FUNCTION lmm.validate_intent(p jsonb) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_kind    text;
  v_etype   text;
  v_allowed text[];
  v_it      jsonb;
  v_seen    text[] := ARRAY[]::text[];
  v_id      text;
BEGIN
  IF pg_catalog.jsonb_typeof(p) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid_intent: $' USING ERRCODE = 'PT422';
  END IF;
  v_kind := p ->> 'kind';
  v_allowed := CASE
    WHEN v_kind IN ('sale','modify') THEN ARRAY['kind','entity_type','entity_uuid','expected_version','snapshot','items','authorization_id']
    WHEN v_kind = 'return'           THEN ARRAY['kind','entity_type','entity_uuid','lines','authorization_id']
    WHEN v_kind = 'cancel'           THEN ARRAY['kind','entity_type','entity_uuid','expected_version']
    WHEN v_kind = 'reopen'           THEN ARRAY['kind','entity_type','entity_uuid','expected_version','authorization_id']
    WHEN v_kind IN ('adjust_in','adjust_out')
                                     THEN ARRAY['kind','entity_type','entity_uuid','qty','reason_code','reason_text','reference','authorization_id']
    WHEN v_kind = 'catalog_upsert'   THEN ARRAY['kind','entity_type','entity_uuid','name','unit']
  END;
  IF v_allowed IS NULL THEN RAISE EXCEPTION 'invalid_intent: $.kind' USING ERRCODE = 'PT422'; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p) AS k WHERE k <> ALL (v_allowed)) THEN
    RAISE EXCEPTION 'invalid_intent: unknown_key' USING ERRCODE = 'PT422';      -- p. ej. stock_delta, restaurant_id, role
  END IF;
  v_etype := CASE WHEN v_kind IN ('adjust_in','adjust_out','catalog_upsert') THEN 'inventory' ELSE 'order' END;
  IF p ->> 'entity_type' IS DISTINCT FROM v_etype THEN      -- (un CASE...THEN dentro de la condición de un IF rompe el parser de PL/pgSQL)
    RAISE EXCEPTION 'invalid_intent: $.entity_type' USING ERRCODE = 'PT422';
  END IF;
  PERFORM lmm.parse_uuid(p ->> 'entity_uuid');                -- lanza PT422 si falta o es inválido
  IF p ? 'authorization_id' AND pg_catalog.jsonb_typeof(p -> 'authorization_id') <> 'null' THEN
    PERFORM lmm.parse_uuid(p ->> 'authorization_id');
  END IF;

  IF v_kind = 'sale' THEN
    IF p -> 'expected_version' IS DISTINCT FROM '0'::jsonb THEN
      RAISE EXCEPTION 'invalid_intent: $.expected_version' USING ERRCODE = 'PT422';
    END IF;
  ELSIF v_kind IN ('modify','cancel','reopen') THEN
    IF NOT lmm.ok_version(p -> 'expected_version') THEN
      RAISE EXCEPTION 'invalid_intent: $.expected_version' USING ERRCODE = 'PT422';
    END IF;
  END IF;

  IF p ? 'snapshot' AND (pg_catalog.jsonb_typeof(p -> 'snapshot') <> 'object'
                         OR pg_catalog.octet_length((p -> 'snapshot')::text) > 65536) THEN
    RAISE EXCEPTION 'invalid_intent: $.snapshot' USING ERRCODE = 'PT422';
  END IF;

  IF v_kind IN ('sale','modify') THEN
    IF NOT lmm.ok_array_len(p -> 'items', 200) THEN
      RAISE EXCEPTION 'invalid_intent: $.items' USING ERRCODE = 'PT422';
    END IF;
    FOR v_it IN SELECT t.value FROM pg_catalog.jsonb_array_elements(p -> 'items') AS t(value) LOOP
      IF pg_catalog.jsonb_typeof(v_it) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'invalid_intent: $.items[]' USING ERRCODE = 'PT422';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(v_it) AS k
                  WHERE k <> ALL (ARRAY['item_uuid','item_type','inventory_uuid','name','unit_price','qty','note'])) THEN
        RAISE EXCEPTION 'invalid_intent: $.items[].unknown_key' USING ERRCODE = 'PT422';
      END IF;
      v_id := lmm.parse_uuid(v_it ->> 'item_uuid')::text;
      IF v_id = ANY (v_seen) THEN RAISE EXCEPTION 'invalid_intent: duplicate_item_uuid' USING ERRCODE = 'PT422'; END IF;
      v_seen := v_seen || v_id;
      IF NOT lmm.ok_one_of(v_it -> 'item_type', ARRAY['menu','inventory']) THEN
        RAISE EXCEPTION 'invalid_intent: $.items[].item_type' USING ERRCODE = 'PT422';
      END IF;
      -- inventory <=> inventory_uuid presente (un campo ausente cuenta como "no presente", nunca como NULL)
      IF (v_it ->> 'item_type' = 'inventory')
         IS DISTINCT FROM COALESCE(pg_catalog.jsonb_typeof(v_it -> 'inventory_uuid') = 'string', false) THEN
        RAISE EXCEPTION 'invalid_intent: $.items[].inventory_uuid' USING ERRCODE = 'PT422';
      END IF;
      IF v_it ->> 'item_type' = 'inventory' THEN PERFORM lmm.parse_uuid(v_it ->> 'inventory_uuid'); END IF;
      IF NOT lmm.ok_qty(v_it -> 'qty') THEN
        RAISE EXCEPTION 'invalid_intent: $.items[].qty' USING ERRCODE = 'PT422';
      END IF;
      IF NOT lmm.ok_money(v_it -> 'unit_price') THEN
        RAISE EXCEPTION 'invalid_intent: $.items[].unit_price' USING ERRCODE = 'PT422';
      END IF;
      IF NOT lmm.ok_text(v_it -> 'name', 1, 200) THEN
        RAISE EXCEPTION 'invalid_intent: $.items[].name' USING ERRCODE = 'PT422';
      END IF;
      IF v_it ? 'note' AND pg_catalog.jsonb_typeof(v_it -> 'note') <> 'null'
         AND NOT lmm.ok_text(v_it -> 'note', 0, 500) THEN
        RAISE EXCEPTION 'invalid_intent: $.items[].note' USING ERRCODE = 'PT422';
      END IF;
    END LOOP;

  ELSIF v_kind = 'return' THEN
    IF NOT lmm.ok_array_len(p -> 'lines', 200) THEN
      RAISE EXCEPTION 'invalid_intent: $.lines' USING ERRCODE = 'PT422';
    END IF;
    FOR v_it IN SELECT t.value FROM pg_catalog.jsonb_array_elements(p -> 'lines') AS t(value) LOOP
      IF pg_catalog.jsonb_typeof(v_it) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'invalid_intent: $.lines[]' USING ERRCODE = 'PT422';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(v_it) AS k
                  WHERE k <> ALL (ARRAY['line_id','inventory_uuid','source_operation_id','qty','reason_text'])) THEN
        RAISE EXCEPTION 'invalid_intent: $.lines[].unknown_key' USING ERRCODE = 'PT422';
      END IF;
      v_id := lmm.parse_uuid(v_it ->> 'line_id')::text;
      IF v_id = ANY (v_seen) THEN RAISE EXCEPTION 'invalid_intent: duplicate_line_id' USING ERRCODE = 'PT422'; END IF;
      v_seen := v_seen || v_id;
      PERFORM lmm.parse_uuid(v_it ->> 'inventory_uuid');
      PERFORM lmm.parse_uuid(v_it ->> 'source_operation_id');
      IF NOT lmm.ok_qty(v_it -> 'qty') THEN
        RAISE EXCEPTION 'invalid_intent: $.lines[].qty' USING ERRCODE = 'PT422';
      END IF;
      IF v_it ? 'reason_text' AND pg_catalog.jsonb_typeof(v_it -> 'reason_text') <> 'null'
         AND NOT lmm.ok_text(v_it -> 'reason_text', 0, 500) THEN
        RAISE EXCEPTION 'invalid_intent: $.lines[].reason_text' USING ERRCODE = 'PT422';
      END IF;
    END LOOP;

  ELSIF v_kind IN ('adjust_in','adjust_out') THEN
    IF NOT lmm.ok_qty(p -> 'qty') THEN
      RAISE EXCEPTION 'invalid_intent: $.qty' USING ERRCODE = 'PT422';
    END IF;
    IF NOT lmm.ok_one_of(p -> 'reason_code',
         ARRAY['count_correction','damage','expiry','theft','opening_balance','transfer','other']) THEN
      RAISE EXCEPTION 'invalid_intent: $.reason_code' USING ERRCODE = 'PT422';
    END IF;
    IF NOT lmm.ok_text(p -> 'reason_text', 3, 500) THEN
      RAISE EXCEPTION 'invalid_intent: $.reason_text' USING ERRCODE = 'PT422';
    END IF;
    IF p ? 'reference' AND pg_catalog.jsonb_typeof(p -> 'reference') <> 'null'
       AND NOT lmm.ok_text(p -> 'reference', 0, 120) THEN
      RAISE EXCEPTION 'invalid_intent: $.reference' USING ERRCODE = 'PT422';
    END IF;

  ELSIF v_kind = 'catalog_upsert' THEN
    IF NOT lmm.ok_text(p -> 'name', 1, 200) THEN
      RAISE EXCEPTION 'invalid_intent: $.name' USING ERRCODE = 'PT422';
    END IF;
    IF p ? 'unit' AND pg_catalog.jsonb_typeof(p -> 'unit') <> 'null' AND NOT lmm.ok_text(p -> 'unit', 1, 30) THEN
      RAISE EXCEPTION 'invalid_intent: $.unit' USING ERRCODE = 'PT422';
    END IF;
  END IF;
END $$;

-- Alta/edición de catálogo: NUNCA toca el stock (un producto nuevo nace con saldo 0)
CREATE FUNCTION lmm.op_catalog(p_rid uuid, p_dev uuid, p_op uuid, p_in jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_inv   uuid := (p_in ->> 'entity_uuid')::uuid;
  v_stock numeric(14,3);
  v_ver   bigint;
BEGIN
  INSERT INTO lmm.inventory (restaurant_id, inventory_uuid, name, unit)
  VALUES (p_rid, v_inv, p_in ->> 'name', COALESCE(p_in ->> 'unit', 'unidad'))
  ON CONFLICT (restaurant_id, inventory_uuid)
  DO UPDATE SET name = EXCLUDED.name, unit = EXCLUDED.unit,
                version = lmm.inventory.version + 1, updated_at = pg_catalog.now()
  RETURNING stock, version INTO v_stock, v_ver;
  RETURN pg_catalog.jsonb_build_object(
    'schema_version', 1, 'operation_id', p_op, 'op_kind', 'catalog_upsert', 'operation_status', 'applied',
    'reject_code', NULL::text, 'movements', '[]'::jsonb,
    'inventory', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'inventory_uuid', v_inv, 'name', p_in ->> 'name', 'unit', COALESCE(p_in ->> 'unit', 'unidad'),
        'stock', lmm.qty_text(v_stock), 'version', v_ver)));
END $$;
```

```sql
-- Cancelación: reintegra el efectivo_neto de cada producto del pedido
CREATE FUNCTION lmm.op_cancel(p_rid uuid, p_dev uuid, p_op uuid, p_in jsonb, p_actor text, p_cts timestamptz)
RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_order  uuid := (p_in ->> 'entity_uuid')::uuid;
  v_ver    bigint;
  v_status text;
  v_ids    uuid[];
  v_inv    uuid;
  v_rem    numeric;
  v_r      jsonb;
  v_moves  jsonb := '[]'::jsonb;
BEGIN
  ------------------------------------------------------------------ Fase A
  SELECT o.version, o.status INTO v_ver, v_status FROM lmm.orders o
   WHERE o.restaurant_id = p_rid AND o.order_uuid = v_order FOR UPDATE;                   -- bloqueo 3
  IF NOT FOUND THEN RETURN lmm.reject(p_op, 'cancel', 'order_not_found'); END IF;
  IF v_status <> 'open' THEN RETURN lmm.reject(p_op, 'cancel', 'order_not_open'); END IF;
  IF v_ver <> (p_in ->> 'expected_version')::bigint THEN
    RETURN lmm.reject(p_op, 'cancel', 'order_version_conflict', pg_catalog.jsonb_build_object('current_version', v_ver));
  END IF;

  ------------------------------------------------------------------ Fase B
  SELECT COALESCE(pg_catalog.array_agg(g.inventory_uuid ORDER BY g.inventory_uuid), ARRAY[]::uuid[]) INTO v_ids
    FROM lmm.order_inventory_ledger g WHERE g.restaurant_id = p_rid AND g.order_uuid = v_order;
  PERFORM 1 FROM lmm.order_inventory_ledger g                                              -- bloqueo 4
   WHERE g.restaurant_id = p_rid AND g.order_uuid = v_order ORDER BY g.inventory_uuid FOR UPDATE;
  PERFORM 1 FROM lmm.inventory i                                                           -- bloqueo 5
   WHERE i.restaurant_id = p_rid AND i.inventory_uuid = ANY (v_ids) ORDER BY i.inventory_uuid FOR UPDATE;

  FOR v_inv, v_rem IN
    SELECT g.inventory_uuid, g.discounted_total - g.returned_total
      FROM lmm.order_inventory_ledger g
     WHERE g.restaurant_id = p_rid AND g.order_uuid = v_order ORDER BY g.inventory_uuid
  LOOP
    IF v_rem > 0 THEN
      v_r := lmm.return_fifo(p_rid, p_op, p_dev, v_order, v_inv, v_rem, 'cancel', p_actor, p_cts);
      v_moves := v_moves || (v_r -> 'movements');
    END IF;
  END LOOP;

  UPDATE lmm.order_inventory_ledger SET requested_net = 0, updated_at = pg_catalog.now()
   WHERE restaurant_id = p_rid AND order_uuid = v_order;
  UPDATE lmm.orders SET status = 'cancelled', version = version + 1, updated_at = pg_catalog.now()
   WHERE restaurant_id = p_rid AND order_uuid = v_order;

  RETURN pg_catalog.jsonb_build_object(
    'schema_version', 1, 'operation_id', p_op, 'op_kind', 'cancel', 'operation_status', 'applied',
    'reject_code', NULL::text, 'order', lmm.order_json(p_rid, v_order),
    'movements', v_moves, 'inventory', lmm.inventory_json(p_rid, v_ids),
    'authorization', pg_catalog.jsonb_build_object('authorization_id', NULL::uuid, 'consumed', false, 'authorized_by', NULL::text));
END $$;

-- Reapertura: vuelve a aplicar la regla de venta (10.1) sobre los ítems vigentes
CREATE FUNCTION lmm.op_reopen(p_rid uuid, p_dev uuid, p_op uuid, p_in jsonb, p_actor text, p_cts timestamptz)
RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_order  uuid := (p_in ->> 'entity_uuid')::uuid;
  v_auth   uuid := NULLIF(p_in ->> 'authorization_id', '')::uuid;
  v_ok     boolean := false; v_reason text; v_member uuid; v_mname text;
  v_ver    bigint; v_status text;
  v_ids    uuid[];
  v_it     RECORD;
  v_line   jsonb;
  v_moves  jsonb := '[]'::jsonb;
BEGIN
  ------------------------------------------------------------------ Fase A
  IF v_auth IS NOT NULL THEN                                                                  -- bloqueo 2
    SELECT c.ok, c.reason, c.member, c.member_name INTO v_ok, v_reason, v_member, v_mname
      FROM lmm.check_authorization(p_rid, p_dev, v_auth, 'negative_stock', v_order, NULL, NULL) c;
    IF NOT v_ok THEN
      RETURN lmm.reject(p_op, 'reopen', 'authorization_invalid', pg_catalog.jsonb_build_object('reason', v_reason));
    END IF;
  END IF;
  SELECT o.version, o.status INTO v_ver, v_status FROM lmm.orders o
   WHERE o.restaurant_id = p_rid AND o.order_uuid = v_order FOR UPDATE;                       -- bloqueo 3
  IF NOT FOUND THEN RETURN lmm.reject(p_op, 'reopen', 'order_not_found'); END IF;
  IF v_status <> 'cancelled' THEN RETURN lmm.reject(p_op, 'reopen', 'order_not_cancelled'); END IF;
  IF v_ver <> (p_in ->> 'expected_version')::bigint THEN
    RETURN lmm.reject(p_op, 'reopen', 'order_version_conflict', pg_catalog.jsonb_build_object('current_version', v_ver));
  END IF;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT i.inventory_uuid), ARRAY[]::uuid[]) INTO v_ids
    FROM lmm.order_items i
   WHERE i.restaurant_id = p_rid AND i.order_uuid = v_order AND NOT i.deleted AND i.item_type = 'inventory';
  IF (SELECT pg_catalog.count(*) FROM lmm.inventory x
       WHERE x.restaurant_id = p_rid AND x.inventory_uuid = ANY (v_ids) AND NOT x.deleted)
     <> pg_catalog.cardinality(v_ids) THEN
    RETURN lmm.reject(p_op, 'reopen', 'inventory_not_found');
  END IF;

  ------------------------------------------------------------------ Fase B
  INSERT INTO lmm.order_inventory_ledger (restaurant_id, order_uuid, inventory_uuid)
  SELECT p_rid, v_order, u FROM pg_catalog.unnest(v_ids) AS u ON CONFLICT DO NOTHING;
  PERFORM 1 FROM lmm.order_inventory_ledger g
   WHERE g.restaurant_id = p_rid AND g.order_uuid = v_order AND g.inventory_uuid = ANY (v_ids)
   ORDER BY g.inventory_uuid FOR UPDATE;
  PERFORM 1 FROM lmm.inventory i
   WHERE i.restaurant_id = p_rid AND i.inventory_uuid = ANY (v_ids) ORDER BY i.inventory_uuid FOR UPDATE;

  FOR v_it IN
    SELECT i.item_uuid, i.inventory_uuid, i.qty FROM lmm.order_items i
     WHERE i.restaurant_id = p_rid AND i.order_uuid = v_order AND NOT i.deleted AND i.item_type = 'inventory'
     ORDER BY i.item_uuid
  LOOP
    v_line := lmm.apply_sale_line(p_rid, p_op, p_dev, v_order,
                lmm.derive_uuid('reopen', p_op::text || ':' || v_it.item_uuid::text), v_it.inventory_uuid, v_it.qty,
                v_auth IS NOT NULL, v_auth, v_member, v_mname, p_actor, p_cts);
    v_moves := v_moves || (v_line -> 'movements');
  END LOOP;

  IF v_auth IS NOT NULL THEN
    UPDATE lmm.stock_authorizations SET status = 'consumed', consumed_by_operation_id = p_op, consumed_at = pg_catalog.now()
     WHERE restaurant_id = p_rid AND authorization_id = v_auth;
  END IF;
  UPDATE lmm.orders SET status = 'open', version = version + 1, updated_at = pg_catalog.now()
   WHERE restaurant_id = p_rid AND order_uuid = v_order;

  RETURN pg_catalog.jsonb_build_object(
    'schema_version', 1, 'operation_id', p_op, 'op_kind', 'reopen', 'operation_status', 'applied',
    'reject_code', NULL::text, 'order', lmm.order_json(p_rid, v_order),
    'movements', v_moves, 'inventory', lmm.inventory_json(p_rid, v_ids),
    'authorization', pg_catalog.jsonb_build_object('authorization_id', v_auth, 'consumed', v_auth IS NOT NULL, 'authorized_by', v_mname));
END $$;
```

```sql
-- Modificación: el cliente envía el conjunto deseado; el servidor calcula las diferencias (11.3)
CREATE FUNCTION lmm.op_modify(p_rid uuid, p_dev uuid, p_op uuid, p_in jsonb, p_actor text, p_cts timestamptz)
RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_order  uuid := (p_in ->> 'entity_uuid')::uuid;
  v_auth   uuid := NULLIF(p_in ->> 'authorization_id', '')::uuid;
  v_ok     boolean := false; v_reason text; v_member uuid; v_mname text;
  v_ver    bigint; v_status text;
  v_items  jsonb := p_in -> 'items';
  v_new    uuid[];     -- productos del intent
  v_all    uuid[];     -- productos del intent ∪ productos del ledger del pedido (ordenados)
  v_inv    uuid;
  v_want   numeric; v_req numeric; v_disc numeric; v_ret numeric;
  v_dif    numeric; v_red numeric; v_eff numeric; v_nocump numeric; v_drop numeric; v_back numeric;
  v_line   jsonb;
  v_rows   integer;
  v_moves  jsonb := '[]'::jsonb;
BEGIN
  ------------------------------------------------------------------ Fase A (orden: autorización → pedido)
  IF v_auth IS NOT NULL THEN                                                                  -- bloqueo 2
    SELECT c.ok, c.reason, c.member, c.member_name INTO v_ok, v_reason, v_member, v_mname
      FROM lmm.check_authorization(p_rid, p_dev, v_auth, 'negative_stock', v_order, NULL, NULL) c;
    IF NOT v_ok THEN
      RETURN lmm.reject(p_op, 'modify', 'authorization_invalid', pg_catalog.jsonb_build_object('reason', v_reason));
    END IF;
  END IF;

  SELECT COALESCE(pg_catalog.array_agg(DISTINCT (x.value ->> 'inventory_uuid')::uuid), ARRAY[]::uuid[]) INTO v_new
    FROM pg_catalog.jsonb_array_elements(v_items) AS x(value) WHERE x.value ->> 'item_type' = 'inventory';
  IF (SELECT pg_catalog.count(*) FROM lmm.inventory i
       WHERE i.restaurant_id = p_rid AND i.inventory_uuid = ANY (v_new) AND NOT i.deleted)
     <> pg_catalog.cardinality(v_new) THEN
    RETURN lmm.reject(p_op, 'modify', 'inventory_not_found');
  END IF;

  SELECT o.version, o.status INTO v_ver, v_status FROM lmm.orders o
   WHERE o.restaurant_id = p_rid AND o.order_uuid = v_order FOR UPDATE;                       -- bloqueo 3
  IF NOT FOUND THEN RETURN lmm.reject(p_op, 'modify', 'order_not_found'); END IF;
  IF v_status <> 'open' THEN RETURN lmm.reject(p_op, 'modify', 'order_not_open'); END IF;
  IF v_ver <> (p_in ->> 'expected_version')::bigint THEN
    RETURN lmm.reject(p_op, 'modify', 'order_version_conflict', pg_catalog.jsonb_build_object('current_version', v_ver));
  END IF;

  ------------------------------------------------------------------ Fase B
  INSERT INTO lmm.order_inventory_ledger (restaurant_id, order_uuid, inventory_uuid)
  SELECT p_rid, v_order, u FROM pg_catalog.unnest(v_new) AS u ON CONFLICT DO NOTHING;

  SELECT COALESCE(pg_catalog.array_agg(s.x ORDER BY s.x), ARRAY[]::uuid[]) INTO v_all FROM (
    SELECT u AS x FROM pg_catalog.unnest(v_new) AS u
    UNION SELECT g.inventory_uuid FROM lmm.order_inventory_ledger g
           WHERE g.restaurant_id = p_rid AND g.order_uuid = v_order) s;

  PERFORM 1 FROM lmm.order_inventory_ledger g                                                 -- bloqueo 4
   WHERE g.restaurant_id = p_rid AND g.order_uuid = v_order ORDER BY g.inventory_uuid FOR UPDATE;
  PERFORM 1 FROM lmm.inventory i                                                              -- bloqueo 5
   WHERE i.restaurant_id = p_rid AND i.inventory_uuid = ANY (v_all) ORDER BY i.inventory_uuid FOR UPDATE;

  INSERT INTO lmm.order_items (restaurant_id, item_uuid, order_uuid, item_type, inventory_uuid,
                              name, unit_price, qty, line_total, note)
  SELECT p_rid, x.item_uuid, v_order, x.item_type, x.inventory_uuid, x.name, x.unit_price, x.qty,
         pg_catalog.round(x.unit_price * x.qty, 2), x.note
    FROM pg_catalog.jsonb_to_recordset(v_items)
         AS x(item_uuid uuid, item_type text, inventory_uuid uuid, name text,
              unit_price numeric, qty numeric, note text)
  ON CONFLICT (restaurant_id, item_uuid) DO UPDATE
     SET item_type = EXCLUDED.item_type, inventory_uuid = EXCLUDED.inventory_uuid, name = EXCLUDED.name, unit_price = EXCLUDED.unit_price,
         qty = EXCLUDED.qty, line_total = EXCLUDED.line_total, note = EXCLUDED.note,
         deleted = false, updated_at = pg_catalog.now()
   WHERE lmm.order_items.order_uuid = EXCLUDED.order_uuid;     -- V8.1 (C-04): nunca modifica un ítem de otro pedido
  GET DIAGNOSTICS v_rows = ROW_COUNT;                          -- las filas omitidas por el WHERE no cuentan
  IF v_rows <> pg_catalog.jsonb_array_length(v_items) THEN
    RAISE EXCEPTION 'item_uuid_belongs_to_other_order' USING ERRCODE = 'PT409';   -- rollback total
  END IF;

  UPDATE lmm.order_items i SET deleted = true, updated_at = pg_catalog.now()
   WHERE i.restaurant_id = p_rid AND i.order_uuid = v_order AND NOT i.deleted
     AND i.item_uuid <> ALL (SELECT (t.value ->> 'item_uuid')::uuid FROM pg_catalog.jsonb_array_elements(v_items) AS t(value));

  FOREACH v_inv IN ARRAY v_all LOOP                       -- FOREACH sobre un uuid[] real (en V7 se usaba sobre filas jsonb)
    SELECT COALESCE(pg_catalog.sum((x.value ->> 'qty')::numeric), 0) INTO v_want
      FROM pg_catalog.jsonb_array_elements(v_items) AS x(value)
     WHERE x.value ->> 'item_type' = 'inventory' AND (x.value ->> 'inventory_uuid')::uuid = v_inv;
    SELECT g.requested_net, g.discounted_total, g.returned_total INTO v_req, v_disc, v_ret
      FROM lmm.order_inventory_ledger g
     WHERE g.restaurant_id = p_rid AND g.order_uuid = v_order AND g.inventory_uuid = v_inv;

    v_dif := v_want - v_req;
    IF v_dif > 0 THEN                                     -- venta incremental
      v_line := lmm.apply_sale_line(p_rid, p_op, p_dev, v_order,
                  lmm.derive_uuid('inc', p_op::text || ':' || v_inv::text), v_inv, v_dif,
                  v_auth IS NOT NULL, v_auth, v_member, v_mname, p_actor, p_cts);
      v_moves := v_moves || (v_line -> 'movements');
    ELSIF v_dif < 0 THEN                                  -- reducción: primero se baja el faltante
      v_red    := -v_dif;
      v_eff    := v_disc - v_ret;
      v_nocump := v_req - v_eff;
      v_drop   := LEAST(v_red, v_nocump);
      v_back   := v_red - v_drop;
      UPDATE lmm.order_inventory_ledger SET requested_net = requested_net - v_red, updated_at = pg_catalog.now()
       WHERE restaurant_id = p_rid AND order_uuid = v_order AND inventory_uuid = v_inv;
      IF v_back > 0 THEN
        v_line := lmm.return_fifo(p_rid, p_op, p_dev, v_order, v_inv, v_back, 'modify', p_actor, p_cts);
        v_moves := v_moves || (v_line -> 'movements');
      END IF;
    END IF;
  END LOOP;

  IF v_auth IS NOT NULL THEN
    UPDATE lmm.stock_authorizations SET status = 'consumed', consumed_by_operation_id = p_op, consumed_at = pg_catalog.now()
     WHERE restaurant_id = p_rid AND authorization_id = v_auth;
  END IF;
  UPDATE lmm.orders
     SET version = version + 1, snapshot = COALESCE(p_in -> 'snapshot', snapshot), updated_at = pg_catalog.now()
   WHERE restaurant_id = p_rid AND order_uuid = v_order;

  RETURN pg_catalog.jsonb_build_object(
    'schema_version', 1, 'operation_id', p_op, 'op_kind', 'modify', 'operation_status', 'applied',
    'reject_code', NULL::text, 'order', lmm.order_json(p_rid, v_order),
    'movements', v_moves, 'inventory', lmm.inventory_json(p_rid, v_all),
    'authorization', pg_catalog.jsonb_build_object('authorization_id', v_auth, 'consumed', v_auth IS NOT NULL, 'authorized_by', v_mname));
END $$;
```

Con esto, **todas** las funciones invocadas desde `lmm_apply_operation` tienen definición en este documento. Las funciones de administración, snapshot, purga y migración están en 18.8.

### 18.8 Funciones de administración, snapshot, purga y migración (código)

```sql
-- Snapshot consistente: UNA sola sentencia = UNA instantánea. order_json es STABLE para compartirla.
CREATE FUNCTION public.lmm_get_snapshot(p_device_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET statement_timeout = '20s' AS $fn$
DECLARE
  v_dev lmm.devices;
  v_res jsonb;
BEGIN
  v_dev := lmm.require_device(p_device_id);
  SELECT pg_catalog.jsonb_build_object(
           'last_event_seq', c.last_event_seq,
           'inventory', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                          'inventory_uuid', i.inventory_uuid, 'name', i.name, 'unit', i.unit,
                          'stock', lmm.qty_text(i.stock), 'version', i.version) ORDER BY i.inventory_uuid)
                         FROM lmm.inventory i WHERE i.restaurant_id = c.restaurant_id AND NOT i.deleted), '[]'::jsonb),
           'open_orders', COALESCE((SELECT pg_catalog.jsonb_agg(lmm.order_json(o.restaurant_id, o.order_uuid) ORDER BY o.order_uuid)
                         FROM lmm.orders o WHERE o.restaurant_id = c.restaurant_id AND o.status = 'open'), '[]'::jsonb))
    INTO v_res
    FROM lmm.restaurant_event_counters c
   WHERE c.restaurant_id = v_dev.restaurant_id;
  RETURN v_res;
END $fn$;

-- Enrolamiento, paso 1: un owner/admin del restaurante crea un código de un solo uso (15 min).
CREATE FUNCTION public.lmm_create_enrollment(p_restaurant uuid, p_label text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_m    lmm.restaurant_memberships;
  v_code text := pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');   -- 122 bits de azar, sin pgcrypto
  v_exp  timestamptz := pg_catalog.now() + interval '15 minutes';
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'unauthenticated' USING ERRCODE = 'PT401'; END IF;
  SELECT m.* INTO v_m FROM lmm.restaurant_memberships m
   WHERE m.restaurant_id = p_restaurant AND m.auth_user_id = auth.uid()
     AND m.active AND m.role IN ('owner','admin');
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE = 'PT403'; END IF;
  IF p_label IS NULL OR pg_catalog.length(p_label) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'invalid_intent: label' USING ERRCODE = 'PT422';
  END IF;
  INSERT INTO lmm.device_enrollments (restaurant_id, code_hash, label, created_by_membership_id, expires_at)
  VALUES (p_restaurant, lmm.sha256_hex(v_code), p_label, v_m.membership_id, v_exp);
  RETURN pg_catalog.jsonb_build_object('status', 'created', 'code', v_code, 'expires_at', v_exp);   -- el código en claro se muestra UNA vez
END $fn$;

-- Enrolamiento, paso 2: la cuenta Auth del dispositivo canjea el código y queda vinculada (auth.uid() -> device_id).
CREATE FUNCTION public.lmm_enroll_device(p_code text, p_device_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_e   lmm.device_enrollments;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'unauthenticated' USING ERRCODE = 'PT401'; END IF;
  IF p_code IS NULL OR p_device_id IS NULL THEN RAISE EXCEPTION 'invalid_intent: enrollment' USING ERRCODE = 'PT422'; END IF;
  SELECT e.* INTO v_e FROM lmm.device_enrollments e WHERE e.code_hash = lmm.sha256_hex(p_code) FOR UPDATE;
  IF NOT FOUND OR v_e.consumed_at IS NOT NULL OR v_e.expires_at <= pg_catalog.now() THEN
    RETURN pg_catalog.jsonb_build_object('status', 'rejected', 'reject_code', 'enrollment_invalid');
  END IF;
  IF EXISTS (SELECT 1 FROM lmm.devices d WHERE d.auth_user_id = v_uid OR d.device_id = p_device_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'rejected', 'reject_code', 'already_enrolled');
  END IF;
  INSERT INTO lmm.devices (device_id, restaurant_id, auth_user_id, label, enrolled_by_membership_id)
  VALUES (p_device_id, v_e.restaurant_id, v_uid, v_e.label, v_e.created_by_membership_id);
  UPDATE lmm.device_enrollments
     SET consumed_at = pg_catalog.now(), consumed_by_device_id = p_device_id
   WHERE enrollment_id = v_e.enrollment_id;
  RETURN pg_catalog.jsonb_build_object('status', 'enrolled', 'device_id', p_device_id, 'restaurant_id', v_e.restaurant_id);
END $fn$;

-- Revocación inmediata (cada RPC consulta lmm.devices): también revoca las autorizaciones activas del dispositivo.
CREATE FUNCTION public.lmm_revoke_device(p_restaurant uuid, p_device_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_m    lmm.restaurant_memberships;
  v_rows integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'unauthenticated' USING ERRCODE = 'PT401'; END IF;
  SELECT m.* INTO v_m FROM lmm.restaurant_memberships m
   WHERE m.restaurant_id = p_restaurant AND m.auth_user_id = auth.uid()
     AND m.active AND m.role IN ('owner','admin');
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE = 'PT403'; END IF;
  UPDATE lmm.devices d
     SET status = 'revoked', revoked_at = pg_catalog.now(), revoked_by_membership_id = v_m.membership_id
   WHERE d.restaurant_id = p_restaurant AND d.device_id = p_device_id AND d.status = 'active';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'rejected', 'reject_code', 'device_not_found_or_revoked');
  END IF;
  UPDATE lmm.stock_authorizations
     SET status = 'revoked'
   WHERE restaurant_id = p_restaurant AND issued_to_device_id = p_device_id AND status = 'active';
  RETURN pg_catalog.jsonb_build_object('status', 'revoked', 'device_id', p_device_id);
END $fn$;

-- Purga de eventos (herramienta administrativa; NO expuesta a la API: sin EXECUTE para anon/authenticated).
-- Solo borra eventos ya confirmados por TODOS los dispositivos activos y con más de p_retention_days días.
CREATE FUNCTION lmm.purge_events(p_restaurant uuid, p_retention_days integer DEFAULT 30) RETURNS bigint
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_last    bigint;
  v_min_ack bigint;
  v_cut     bigint;
  v_deleted bigint;
BEGIN
  -- Se bloquea el contador: ninguna operación del restaurante se confirma mientras se actualiza min_retained_seq.
  SELECT c.last_event_seq INTO v_last FROM lmm.restaurant_event_counters c
   WHERE c.restaurant_id = p_restaurant FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  SELECT COALESCE(pg_catalog.min(d.last_ack_seq), 0) INTO v_min_ack
    FROM lmm.devices d WHERE d.restaurant_id = p_restaurant AND d.status = 'active';   -- sin dispositivos activos: no se purga nada
  SELECT COALESCE(pg_catalog.max(e.event_seq), 0) INTO v_cut
    FROM lmm.sync_events e
   WHERE e.restaurant_id = p_restaurant AND e.event_seq <= v_min_ack
     AND e.created_at < pg_catalog.now() - pg_catalog.make_interval(days => p_retention_days);
  DELETE FROM lmm.sync_events WHERE restaurant_id = p_restaurant AND event_seq <= v_cut;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  UPDATE lmm.restaurant_event_counters
     SET min_retained_seq = GREATEST(min_retained_seq, v_cut + 1)
   WHERE restaurant_id = p_restaurant;
  RETURN v_deleted;
END $$;

-- Migración de pedidos ABIERTOS (solo herramienta de migración; sin EXECUTE para la API).
-- Crea pedido, ítems y ledger SIN tocar el stock (el descuento ya ocurrió en el sistema anterior). Idempotente por order_uuid.
-- p_order = { order_uuid, snapshot, items:[{item_uuid,item_type,inventory_uuid,name,unit_price,qty,note}],
--             ledger:[{inventory_uuid,requested_net,discounted_total,returned_total}] }
CREATE FUNCTION lmm.migrate_open_order(p_restaurant uuid, p_device uuid, p_order jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_order uuid := lmm.parse_uuid(p_order ->> 'order_uuid');
  v_rows  integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lmm.devices d WHERE d.restaurant_id = p_restaurant AND d.device_id = p_device) THEN
    RAISE EXCEPTION 'device_not_authorized' USING ERRCODE = 'PT403';
  END IF;
  INSERT INTO lmm.orders (restaurant_id, order_uuid, version, status, snapshot, created_by_device_id)
  VALUES (p_restaurant, v_order, 1, 'open', COALESCE(p_order -> 'snapshot', '{}'::jsonb), p_device)
  ON CONFLICT (restaurant_id, order_uuid) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_migrated', 'order_uuid', v_order);
  END IF;

  INSERT INTO lmm.order_items (restaurant_id, item_uuid, order_uuid, item_type, inventory_uuid,
                              name, unit_price, qty, line_total, note)
  SELECT p_restaurant, x.item_uuid, v_order, x.item_type, x.inventory_uuid, x.name, x.unit_price, x.qty,
         pg_catalog.round(x.unit_price * x.qty, 2), x.note
    FROM pg_catalog.jsonb_to_recordset(COALESCE(p_order -> 'items', '[]'::jsonb))
         AS x(item_uuid uuid, item_type text, inventory_uuid uuid, name text, unit_price numeric, qty numeric, note text)
  ON CONFLICT (restaurant_id, item_uuid) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> pg_catalog.jsonb_array_length(COALESCE(p_order -> 'items', '[]'::jsonb)) THEN
    RAISE EXCEPTION 'item_uuid_belongs_to_other_order' USING ERRCODE = 'PT409';
  END IF;

  INSERT INTO lmm.order_inventory_ledger (restaurant_id, order_uuid, inventory_uuid,
                                          requested_net, discounted_total, returned_total)
  SELECT p_restaurant, v_order, x.inventory_uuid, x.requested_net, x.discounted_total, x.returned_total
    FROM pg_catalog.jsonb_to_recordset(COALESCE(p_order -> 'ledger', '[]'::jsonb))
         AS x(inventory_uuid uuid, requested_net numeric, discounted_total numeric, returned_total numeric);

  RETURN pg_catalog.jsonb_build_object('status', 'migrated', 'order_uuid', v_order);
END $$;
```

Con esto **todas** las funciones del diseño tienen código en este documento. Las funciones `lmm.purge_events` y `lmm.migrate_open_order` son herramientas administrativas: no se exponen a la API (ver 13.3).

---

## 19. Matriz de pruebas

### 19.1 Estado de las pruebas (separación obligatoria)

| Categoría | Cantidad | Detalle |
|---|---:|---|
| **Propuestas** | 164 | Las de 19.3 (IDs únicos). |
| **Implementadas** | 0 | No existe código de pruebas de V8; esta fase no implementa. |
| **Ejecutadas (matriz)** | 0 | Ninguna prueba de 19.3 se ejecutó. |
| **Aprobadas (matriz)** | 0 | — |
| **Verificaciones de diseño ejecutadas** (no son pruebas de la matriz) | V-1 … V-8 | Ver 19.2. |

### 19.2 Verificaciones de diseño realmente ejecutadas en esta fase

Se ejecutaron con Node 22 y SQLite en memoria **fuera del proyecto** (`/tmp`); no tocaron `db.js`, bases reales ni Supabase.

| # | Qué verifica | Resultado |
|---|---|---|
| V-1 | DDL local de 5.2–5.5 (incluye `CHECK`, índice único parcial, `UNIQUE` de outbox); sentencia de **reclamo atómico** de 14.2 con `RETURNING`: FIFO, bloqueo por partición, lease vencido recuperado en caliente, `retry_wait` respeta `next_attempt_at`, predecesora en `conflict` bloquea la partición, dos reclamos consecutivos no devuelven la misma fila | **OK** (9 comprobaciones) |
| V-2 | **Conciliación** del caso A/B de 16.3 (stock 5; ambos venden 4): provisional 1 → evento ajeno → resultado autoritativo → evento propio → evento viejo; sin doble descuento, venta conservada una vez, faltante 3 registrado, guarda por versión | **OK** (7 comprobaciones) |
| V-3 | **JSON canónico** y decimales: orden de claves, rechazo de números no enteros, conversión decimal↔milésimas exacta, `0,1 + 0,2` exacto en milésimas (y no en `REAL`), rechazo de `1.0`, `01`, `1.2345`, `.5`, `-1`, `1e3` | **OK** (10 comprobaciones; total de V-1 a V-3: **26**, 0 fallos) |
| V-4 | **Modelo de reglas** (secciones 10–12): tabla 10.2 (10 casos) contra el algoritmo; 20.000 escenarios aleatorios de 30 operaciones (venta, `modify`, devolución, cancelación, reapertura, con y sin autorización, saldos negativos y fraccionarios) con invariantes: saldo = inicial + Σ delta; `returned ≤ discounted`; devuelto ≤ vendido por fuente; venta sin autorización nunca aumenta el saldo ni lo deja negativo si partía ≥ 0; cancelación deja `efectivo_neto = 0`; y el escenario C-02 (vender 5, devolver 2, modificar conservando 5 ⇒ diferencia 0; con la semántica anterior daba +2) | **OK** |
| V-5 | **Sensibilidad**: el mismo verificador con la regla de V7 (disponible = saldo, aunque sea negativo) **falla** exactamente en el caso stock −3 / venta 2 (descuento −3, delta +3, saldo 0) | **Detecta el defecto de V7** |

| V-6 | **Sintaxis** de toda la migración SQL (`supabase/migrations/20261123000000_lmm_inventory_sync_v8.sql`, 103 sentencias, 38 funciones) y de las 26 funciones PL/pgSQL, con el parser real de PostgreSQL (`pglast`/`libpg_query`) | **OK** tras corregir 1 defecto real (`CASE … THEN` dentro de un `IF` en `validate_intent`). Solo sintaxis: el SQL sigue sin ejecutarse |
| V-7 | 25 pruebas del módulo `services/inventory-sync-v8` (`tests/inventory-sync-v8.test.js`): decimales, canónico, regla 10.2, outbox, conciliación A/B, reenvío tras commit remoto, servidor caído, hook de pedidos; ejecutadas con un mini-shim de jest sobre SQLite embebido | **25 de 25 OK** |
| V-8 | Esquema local V8 aplicado sobre las tablas **reales** extraídas de `db.js`; idempotente; los `INSERT` legados de `recordStockMovement` siguen funcionando y quedan como `legacy` | **OK** |

**No se ejecutó** (y por eso no se declara validado): la ejecución real del SQL/PL/pgSQL de la sección 18 (solo se validó su sintaxis), las políticas y privilegios de la sección 13, el comportamiento real de PostgREST con `PTnnn`, la concurrencia entre conexiones reales y el comportamiento de Supabase Auth.

### 19.3 Matriz (todas propuestas; ninguna ejecutada)

Convenciones: `S` = stock remoto; `Mov` = movimientos remotos; `Ev` = eventos; `Ob` = estado de la outbox del dispositivo que envía; **Idem** = resultado de idempotencia. Los saldos son los **finales**. "Dos conexiones" = dos sesiones PostgreSQL reales, no dos llamadas secuenciales. Dispositivos "independientes" = dos procesos Node con dos bases SQLite distintas.

#### Idempotencia (IDM)

| ID | Estado inicial | Operaciones / concurrencia | Resultado esperado · saldo final | Mov · Ev | Ob | Idem |
|---|---|---|---|---|---|---|
| IDM-01 | S=10; pedido inexistente | `sale` qty 3 (op1) | `applied`; **S=7** | 1 sale · 1 | `applied` | creada |
| IDM-02 | tras IDM-01 | reenviar op1 idéntica | mismo `result_payload`, `replayed:true`; S=7 | sin cambio · sin cambio | `applied` | `replayed` |
| IDM-03 | tras IDM-01 | op1 con qty 5 | `PT409 operation_id_reused_with_different_content`; S=7 | sin cambio | `dead_letter` | conflicto explícito |
| IDM-04 | tras IDM-01 | op2 (otra `operation_id`), misma `idempotency_key` y contenido | resultado de op1 con `deduplicated_of=op1`; S=7 | sin cambio | op2 `applied` (nota) | `deduplicated_of` |
| IDM-05 | tras IDM-01 | op3 con la misma key y contenido distinto | `PT409 idempotency_key_reused_with_different_content`; S=7 | sin cambio | `dead_letter` | conflicto |
| IDM-06 | tras IDM-01 | op1 enviada por **otro dispositivo** del mismo restaurante | `PT409 operation_device_mismatch`; S=7 | sin cambio | `dead_letter` | conflicto |
| IDM-07 | op1 aplicada con ítem `i1` | op4 nueva reutiliza `line_id = i1` | `PT409 line_id_belongs_to_other_operation`; sin efectos | sin cambio | `dead_letter` | conflicto |
| IDM-08 | op1 con faltante (movimiento `shortage` derivado) | op5 usa como `line_id` el `movement_id` derivado de ese `shortage` | `PT409`; sin efectos | sin cambio | `dead_letter` | conflicto |
| IDM-09 | S=10 | `sale` op6 con **fallo inyectado** tras insertar `operations` | rollback: sin fila en `operations`; S=10; luego op6 reintentada aplica normal | 0 → 1 · 0 → 1 | `retry_wait` → `applied` | sin huella parcial |
| IDM-10 | S=10 | `sale` op7 con fallo inyectado tras insertar movimientos | rollback total: sin movimientos, sin pedido, sin ledger; S=10 | 0 · 0 | `retry_wait` | sin huella parcial |
| IDM-11 | S=10 | **dos conexiones** envían op8 idéntica simultáneamente | una `replayed:false`, otra `replayed:true`; S=7 | 1 · 1 | `applied` | una sola aplicación |
| IDM-12 | pedido ya existente | `sale` op9 sobre ese `order_uuid` → rechazo; reenviar op9 | mismo rechazo `order_already_exists` en ambos; S igual | 0 · 0 | `conflict` | rechazo persistido y repetible |
| IDM-13 | S=10 | `sale` op10 con fallo inyectado **después** de `UPDATE orders` | rollback: pedido, ítems, ledger, movimientos, operación y evento inexistentes | 0 · 0 | `retry_wait` | sin huella parcial |
| IDM-14 | restaurante A y B | `operation_id` de A reutilizado por B | se aplica en B sin revelar A (PK incluye `restaurant_id`) | 1 · 1 | `applied` | independientes |
| IDM-15 | S=10 | en una misma sesión: una `sale` que termina `applied` y otra operación que termina `rejected`; `COMMIT` | ambas confirman sin `PT500`: el *constraint trigger* consulta el estado **final** de la fila (no `NEW`); ninguna fila queda `processing` (C-01) | 1 sale · 1 (la rechazada sin evento) | `applied` / `conflict` | `applied` y rechazo persistidos |
| IDM-16 | pedido `P` existente | dispositivos A y B generan cada uno una `modify` con `seq` local 2 y contenido distinto | ambas se aplican (o una `order_version_conflict` legítima), **sin** `PT409` por colisión de clave: la clave incluye `device_id` (A-01) | según versión | `applied` / `conflict` | claves distintas |
| IDM-17 | pedidos `P1` (con ítem `i1`) y `P2` inexistente | **dos conexiones**: `sale` de `P2` reutilizando `item_uuid = i1`, mientras `P1` ya lo tiene | `PT409 item_uuid_belongs_to_other_order`; el ítem y el stock de `P1` **intactos**; `P2` no se crea (C-04) | 0 · 0 | `dead_letter` | sin efectos |

#### Stock y reglas comerciales (ST)

| ID | Estado inicial | Operaciones | Resultado esperado · saldo final | Mov · Ev | Ob | Idem |
|---|---|---|---|---|---|---|
| ST-01 | S=10 | `sale` 3 sin auth | descontado 3, faltante 0; **S=7** | 1 sale · 1 | `applied` | creada |
| ST-02 | S=5 | `sale` 5 (exacto) | descontado 5, faltante 0; **S=0** | 1 sale · 1 | `applied` | creada |
| ST-03 | S=0 | `sale` 2 sin auth | descontado 0, faltante 2; **S=0** | sale(0) + shortage(2) · 1 | `applied` | creada |
| ST-04 | **S=−3** | `sale` 2 sin auth | descontado 0, faltante 2; **S=−3** (no aumenta) | sale(0) + shortage(2) · 1 | `applied` | creada |
| ST-05 | S=5 | `sale` 8 sin auth | descontado 5, faltante 3; **S=0** | sale(5) + shortage(3) · 1 | `applied` | creada |
| ST-06 | S=5; autorización válida | `sale` 8 con `authorization_id` | descontado 8, faltante 3; **S=−3**; autorización `consumed` | sale(8) + shortage(3) · 1 | `applied` | creada |
| ST-07 | S=−3; autorización válida | `sale` 2 con auth | descontado 2, faltante 2; **S=−5** | sale(2) + shortage(2) · 1 | `applied` | creada |
| ST-08 | S=2,5 | `sale` 1,25 | **S=1,25** | 1 sale · 1 | `applied` | creada |
| ST-09 | S=0,3 | `sale` 0,5 sin auth | descontado 0,3, faltante 0,2; **S=0** | sale(0,3) + shortage(0,2) · 1 | `applied` | creada |
| ST-10 | S=0 | `adjust_in` 0,1 y luego `adjust_in` 0,2 (autorizados) | **S=0,3 exacto** | 2 adjustment_in · 2 | `applied` ×2 | creadas |
| ST-11 | S=5 | un pedido con 2 líneas del mismo producto: 3 y 4, sin auth | línea 1: 3 (falt. 0); línea 2: 2 (falt. 2); **S=0** | 2 sale + 1 shortage · 1 | `applied` | creada |
| ST-12 | S=10 | `adjust_in` 5 (aut. `adjustment`) | **S=15**; `reason_code`, autorizador y dispositivo registrados | 1 adjustment_in · 1 | `applied` | creada |
| ST-13 | S=15 | `adjust_out` 3 (aut.) | **S=12** | 1 adjustment_out · 1 | `applied` | creada |
| ST-14 | S=10 | `adjust_out` 3 **sin** `authorization_id` | rechazo `authorization_invalid {missing}`; **S=10** | 0 · 0 | `conflict` | rechazo persistido |
| ST-15 | S=10; autorización con `max_quantity=2` | `adjust_out` 3 | rechazo `quantity_exceeds`; **S=10**; autorización sigue `active` | 0 · 0 | `conflict` | rechazo persistido |
| ST-16 | S=10 | intent con `stock_delta`, `applied_qty` o `stock` | `PT422 invalid_intent` (clave no permitida); **S=10** | 0 · 0 | `dead_letter` | sin efectos |
| ST-17 | autorización ya `consumed` | `sale` con ese `authorization_id` | rechazo `authorization_invalid {consumed}`; S sin cambio | 0 · 0 | `conflict` | rechazo persistido |
| ST-18 | autorización emitida al dispositivo B | `sale` desde A con ese id | rechazo `{wrong_device}` | 0 · 0 | `conflict` | rechazo persistido |
| ST-19 | autorización con `valid_until + gracia` vencida | `sale` con ese id | rechazo `{expired}` | 0 · 0 | `conflict` | rechazo persistido |
| ST-20 | S=10; autorización válida adjunta | `sale` 3 (no la necesitaba) | **S=7**; autorización `consumed` (un solo uso por operación) | 1 sale · 1 | `applied` | creada |
| ST-21 | — | `qty` con 4 decimales ("1.2345") | `PT422` | 0 · 0 | `dead_letter` | — |
| ST-22 | — | `qty` no canónica ("1.0", "01", ".5") | `PT422` | 0 · 0 | `dead_letter` | — |
| ST-23 | S=5 | `sale` de producto **borrado** o inexistente | rechazo `inventory_not_found`; **S=5** | 0 · 0 | `conflict` | rechazo persistido |
| ST-24 | — | intents sin `qty`, sin `unit_price`, sin `name`, sin `item_type` o `inventory` sin `inventory_uuid` | `PT422 invalid_intent` **controlado** (no un error de restricción posterior); sin efectos (A-02) | 0 · 0 | `dead_letter` | — |
| ST-25 | — | sobre sin `idempotency_key`, con clave de 3 caracteres o con `client_created_at` inválido | `PT422`; sin efectos | 0 · 0 | `dead_letter` | — |

#### Devoluciones (RT)

| ID | Estado inicial | Operaciones | Resultado esperado · saldo final | Mov · Ev | Ob | Idem |
|---|---|---|---|---|---|---|
| RT-01 | S=10 → venta 3 (S=7, op V) | `return` 3 citando V | **S=10**; ledger `returned=3` | +1 return · +1 | `applied` | creada |
| RT-02 | idem | `return` 1 | **S=8**; remanente 2 | +1 return · +1 | `applied` | creada |
| RT-03 | devuelto 3 de 3 | `return` 1 (otra `operation_id`) | rechazo `return_exceeds_remaining {remaining:0}`; S=10 | 0 · 0 | `conflict` | rechazo persistido |
| RT-04 | venta S=5, pidió 8 (descontó 5, faltante 3) | `return` 6 | rechazo `{remaining:5}`; S=0 | 0 · 0 | `conflict` | rechazo persistido |
| RT-05 | ídem RT-04 | `return` 8 (intentar devolver el faltante) | rechazo `{remaining:5}` | 0 · 0 | `conflict` | rechazo persistido |
| RT-06 | descontado 5 sin devolver | **dos conexiones**: `return` 3 y `return` 3 | una `applied` (S=3), otra rechazo `{remaining:2}`; **S=3** | +1 return · +1 | `applied` / `conflict` | independientes |
| RT-07 | venta de otro pedido | `return` citándola | rechazo `source_operation_invalid` | 0 · 0 | `conflict` | rechazo persistido |
| RT-08 | tras RT-01 | reenviar la misma `return` | `replayed`; S sin doble reintegro | sin cambio | `applied` | `replayed` |
| RT-09 | descontado 5 | un intent con 2 líneas `qty 3` del mismo producto y fuente | rechazo agregado `{remaining:5}` (3+3>5); S sin cambio | 0 · 0 | `conflict` | rechazo persistido |
| RT-10 | sin ledger para ese producto | `return` 1 | rechazo (`source_operation_invalid` o `return_exceeds_remaining {0}`) | 0 · 0 | `conflict` | rechazo persistido |
| RT-11 | S=10 → venta 5 (S=5, op V) | `return` 2 (S=7) y luego `modify` que **conserva** la cantidad 5 (`expected_version` vigente) | la `modify` **no** genera movimientos: `dif = 5 − requested_net(5) = 0`; **S=7**; sin re-descuento (C-02) | +1 return · +1 (la `modify` aplica sin movimientos) | `applied` ×2 | creadas |
| RT-12 | tras RT-11 | `modify` que reduce 5→3 | baja 2 unidades "no cumplidas" (ya devueltas) y **no** devuelve de nuevo; **S=7** | 0 de stock · +1 | `applied` | creada |

#### Pedidos (OR)

| ID | Estado inicial | Operaciones / concurrencia | Resultado esperado · saldo final | Mov · Ev | Ob | Idem |
|---|---|---|---|---|---|---|
| OR-01 | pedido `P` vendido (v1) | reenviar la finalización (mismo `operation_id`) | `replayed`; sin doble descuento | sin cambio | `applied` | `replayed` |
| OR-02 | pedido `P` existe | `sale` con otro `operation_id` y otra key | rechazo `order_already_exists` | 0 · 0 | `conflict` | rechazo persistido |
| OR-03 | S=7 tras vender 3 (v1) | `modify` qty 3→5 (`expected_version=1`) | S=5; pedido v2; venta incremental de 2 | +1 sale · +1 | `applied` | creada |
| OR-04 | S=5 tras vender 5 (sin faltante) | `modify` qty 5→2 | devuelve 3; **S=8**; v2 | +1 return · +1 | `applied` | creada |
| OR-05 | pidió 8, descontó 5 (faltante 3), S=0 | `modify` a 6 | baja de faltante 2; **no** devuelve; **S=0** | 0 mov de stock · +1 | `applied` | creada |
| OR-06 | ídem OR-05 | `modify` a 4 | baja de faltante 3 y devuelve 1; **S=1** | +1 return · +1 | `applied` | creada |
| OR-07 | venta que descontó 5 (S=0) | `cancel` | **S=5**; estado `cancelled`; v+1; `requested_net=0` | +1 return · +1 | `applied` | creada |
| OR-08 | pedido cancelado | `cancel` (otra `operation_id`) | rechazo `order_not_open`; sin doble reintegro | 0 · 0 | `conflict` | rechazo persistido |
| OR-09 | pedido cancelado; S=10; ítem 3 | `reopen` | S=7; estado `open`; v+1 | +1 sale · +1 | `applied` | creada |
| OR-10 | ídem; S=1 | `reopen` sin auth | descuenta 1, faltante 2; **S=0** | sale + shortage · 1 | `applied` | creada |
| OR-11 | pedido abierto | `reopen` | rechazo `order_not_cancelled` | 0 · 0 | `conflict` | rechazo persistido |
| OR-12 | `order_uuid` nuevo; S=10 | **dos conexiones**: `sale` (3) y `cancel` del mismo pedido | resultado A: venta aplicada y luego cancelación (**S=10**) o B: `cancel` rechazado `order_not_found` y venta aplicada (**S=7**); nunca un estado intermedio; ledger consistente | según A/B | `applied` / `conflict` | independientes |
| OR-13 | pedido v1 | **dos conexiones**: `modify` A y `modify` B, ambos `expected_version=1` | una `applied` (v2); otra `order_version_conflict {current_version:2}`; stock refleja **solo** la aplicada | +1 (una) | `applied` / `conflict` | independientes |
| OR-14 | pedido v1 | **dos conexiones**: `cancel` y `modify` simultáneos | gana uno; el otro `order_not_open` o `order_version_conflict`; sin efectos del perdedor | según ganador | `applied` / `conflict` | independientes |
| OR-15 | pedido cancelado v2 | **dos conexiones**: `reopen` y `cancel` | `reopen` aplica y `cancel` rechaza (o `cancel` ve no abierto); nunca doble reintegro ni doble descuento | según ganador | `applied` / `conflict` | independientes |
| OR-16 | pedido v3 | `modify` con `expected_version=2` | `order_version_conflict {current_version:3}` | 0 · 0 | `conflict` | rechazo persistido |
| OR-17 | — | `sale` con `expected_version=1` | `PT422` | 0 · 0 | `dead_letter` | — |
| OR-18 | productos A y B | **dos conexiones**: venta con ítems (A,B) y otra con (B,A) | ambas `applied`, **sin deadlock** (orden de bloqueo por `inventory_uuid`); S coherente | 2 sale · 2 | `applied` ×2 | independientes |
| OR-19 | pedido con ítems de menú y de inventario | `sale` | solo los de inventario mueven stock; `line_total = ROUND(unit_price·qty,2)` | solo inventario | `applied` | creada |
| OR-20 | pedidos `P1` (ítem `i1`) y `P2` | **dos conexiones**: `modify` de `P2` incluyendo `item_uuid = i1` | `PT409 item_uuid_belongs_to_other_order`; los datos del ítem de `P1` **no cambian**; rollback total de `P2` (C-04) | 0 · 0 | `dead_letter` | sin efectos |

#### Reconciliación offline y dispositivos (SY)

| ID | Estado inicial | Operaciones / concurrencia | Resultado esperado · saldo final | Mov · Ev | Ob | Idem |
|---|---|---|---|---|---|---|
| SY-01 | S=5; A y B sincronizados, luego offline | A vende 4 y B vende 4 offline; reconectan (A primero) | A: descontó 4; B: descontó **1**, faltante **3**; **S=0**; B local: confirmado 0, provisional 0; venta de B conservada | A: 1 sale; B: sale + shortage · 2 | ambas `applied` | creadas |
| SY-02 | S=5 | A y B venden 8 sin auth | A: 5 (falt. 3); B: 0 (falt. 8); **S=0** | 2 sale + 2 shortage · 2 | `applied` ×2 | creadas |
| SY-03 | S=10; **dos procesos Node independientes** con dos SQLite | ambos venden en paralelo sobre el mismo producto durante 60 s (ventas de 1) | **S = 10 − Σ descontado**; sin duplicados; `event_seq` contiguos; cada local converge al remoto | N sale · N | todas `applied` | sin duplicación |
| SY-04 | outbox con op en `claimed` | se mata el proceso antes de enviar | vence el lease; se reclama y envía; un solo efecto | 1 · 1 | `claimed`→`applied` | creada |
| SY-05 | op enviada | el servidor **confirma** y el proceso se mata **antes del ACK local** | al reiniciar: reenvío ⇒ `replayed:true`; se reconcilia **una vez**; sin doble descuento ni movimiento duplicado | 1 · 1 | `claimed`→`applied` | `replayed` |
| SY-06 | B con provisional | llega la respuesta autoritativa de B | movimiento local pasa a `confirmed` **sobre la misma fila**; se inserta `shortage`; confirmado = remoto | sin duplicados | `applied` | — |
| SY-07 | ídem | llega primero la **respuesta**, luego el **evento propio** | el evento es no-op y avanza el cursor | sin cambio | `applied` | `applied_results` |
| SY-08 | ídem | llega primero el **evento propio** (respuesta perdida) | el evento reconcilia y cierra la outbox; la respuesta tardía es no-op | sin cambio | `applied` | `applied_results` |
| SY-09 | confirmado v9 | llega un evento ajeno con inventario v8 | el confirmado **no retrocede** | — | — | — |
| SY-10 | B con provisional | evento **ajeno** de A | se insertan los movimientos de A como `origin='remote'` `confirmed`; el provisional de B intacto; confirmado actualizado | +movs remotos | — | — |
| SY-11 | operación con 2 movimientos | falla al aplicar el segundo | rollback SQLite: ningún movimiento aplicado; cursor **no** avanza; se reintenta | 0 | `claimed`/`retry_wait` | — |
| SY-12 | op1 y op2 (mismo dispositivo) con efecto provisional local sobre la misma línea | llega `deduplicated_of=op1` | se concilia op1; los movimientos de op2 pasan a `rejected`; **saldo provisional = confirmado** (sin doble descuento ni movimientos huérfanos); filas de outbox de op1 y op2 `applied` | 1 confirmado + 1 `rejected` | op1 y op2 `applied` | `deduplicated_of` |
| SY-13 | confirmado 5; 2 ventas pendientes (−2, −1) | consultar saldo | provisional = 2 (marcado); confirmado = 5 | — | `pending` ×2 | — |
| SY-14 | operación local en curso | cierre inesperado **entre** pasos de la transacción local (venta + provisionales + outbox) | todo o nada: o existe la venta con su fila de outbox o no existe nada | consistente | consistente | — |
| SY-15 | op rechazada (`conflict`) | consultar saldo | movimientos siguen provisionales hasta resolver; pedido local conservado | — | `conflict` | — |

#### Eventos y cursor (EV)

| ID | Estado inicial | Operaciones | Resultado esperado | Mov · Ev | Ob | Idem |
|---|---|---|---|---|---|---|
| EV-01 | cursor=5 | llega dos veces el evento 6 | se aplica una vez; cursor=6 | 1 · 1 | — | `event_id` único |
| EV-02 | cursor=5 | llega el evento 8 antes que 6 y 7 | 8 no se aplica; se piden 6 y 7; luego 8; cursor=8 | — | — | — |
| EV-03 | cursor=5 | el servidor devuelve 6 y 8 (hueco simulado) | se aplica 6; alerta `event_gap`; no se salta 7 | — | — | — |
| EV-04 | restaurante con carga | **dos conexiones** escritoras + una lectora en bucle (≥ 10.000 iteraciones) | el lector **nunca** observa `n+1` sin `n`; (valida I-EV-3) | — | — | — |
| EV-05 | contador en 0 | 50 transacciones concurrentes, 10 forzadas a abortar | `event_seq` = 1..40 sin huecos; orden = orden de commit | 40 · 40 | — | — |
| EV-06 | restaurante sin fila de contador | primera operación | la fila se crea; `event_seq=1` | 1 · 1 | `applied` | creada |
| EV-07 | evento purgado (`min_retained_seq` > cursor+1) | `lmm_get_events` | `resync_required`; `lmm_get_snapshot` coherente en una instantánea; confirmado reemplazado; provisional conservado | — | — | — |
| EV-08 | operación aplicada cuyo evento fue purgado | reenviarla | `replayed` con el `result_payload` original | sin cambio | `applied` | `replayed` |
| EV-09 | Realtime desconectado | polling | los eventos se aplican; cursor avanza | — | — | — |
| EV-10 | evento propio | procesarlo | no reaplica movimientos; cursor avanza | sin cambio | — | no-op |
| EV-11 | evento ajeno con producto desconocido localmente | procesarlo | se detiene el cursor y se alerta `event_apply_error`; no se salta | — | — | — |
| EV-12 | `p_ack_seq` mayor que `last_event_seq` | `lmm_get_events` | el ack se acota a `last_event_seq` | — | — | — |
| EV-13 | carga concurrente de escrituras | `lmm_get_snapshot` repetido | cada snapshot es **coherente en una instantánea**: el stock equivale a aplicar los eventos hasta `last_event_seq` (`order_json`/`inventory_json` `STABLE`) | — | — | — |
| EV-14 | dispositivo activo con `last_ack_seq` atrasado | `lmm.purge_events` | no se elimina ningún evento posterior al menor `ack` ni más reciente que la retención; `min_retained_seq` coherente | — | — | — |

#### Outbox (OB)

| ID | Estado inicial | Operaciones | Resultado esperado | Mov · Ev | Ob | Idem |
|---|---|---|---|---|---|---|
| OB-01 | fila `claimed` con lease vencido | llamar al reclamo **sin reiniciar** | la fila se reclama de nuevo (`attempts`+1) | — | `claimed` | — |
| OB-02 | 3 pendientes | dos procesos reclaman a la vez | cada fila se entrega a **un solo** reclamante | — | `applied` ×3 | sin duplicados |
| OB-03 | `server_failures` 1..6 | fallos 5xx | retrasos ≈ 5, 10, 20, 40, 80, 160 s (±20 %); tope 300 s | — | `retry_wait` | — |
| OB-04 | servidor caído y luego disponible | reintento | `applied`; un solo efecto | 1 · 1 | `retry_wait`→`applied` | `replayed` si ya aplicó |
| OB-05 | sin conexión durante 2 h | N intentos fallidos de red | `server_failures` **no** aumenta; no hay `dead_letter` | — | `retry_wait` | — |
| OB-06 | 10 fallos 5xx con respuesta | siguiente fallo | `dead_letter` (`too_many_failures`) | — | `dead_letter` | — |
| OB-07 | rechazo de negocio | respuesta `rejected` | `conflict`; la partición queda bloqueada; **otras particiones siguen** | — | `conflict` | rechazo persistido |
| OB-08 | `return` depende de `sale` aún `pending` | ejecutar el motor | la `return` espera; al aplicarse la `sale`, se envía | — | `pending`→`applied` | — |
| OB-09 | `sale` en `dead_letter` | ejecutar el motor | la `return` **no** se envía (partición bloqueada) | — | `pending` | — |
| OB-10 | misma key encolada dos veces | `enqueue` ×2 | una sola fila (devuelve la existente) | — | 1 fila | sin pérdida |
| OB-11 | dos intents distintos sobre el mismo producto | `enqueue` ×2 | **dos** filas (no se pierde ninguna) | — | 2 filas | — |
| OB-12 | dos `enqueue` simultáneos del mismo pedido | concurrencia local | `entity_seq` 1 y 2 sin repetir | — | 2 filas | — |
| OB-13 | JWT vencido | respuesta 401 | se renueva la sesión; reintento; **no** suma `server_failures` | — | `pending` | — |
| OB-14 | dispositivo revocado | `PT403` | `dead_letter` (`device_revoked_or_unbound`) | 0 · 0 | `dead_letter` | — |
| OB-15 | `PT409` o `PT422` | respuesta | `dead_letter` con el código | 0 · 0 | `dead_letter` | — |
| OB-16 | 3 filas `claimed` tras cierre de Electron | reinicio | las 3 se recuperan y envían; cada efecto una sola vez | 3 · 3 | `applied` ×3 | `replayed` si ya aplicó |
| OB-17 | durante el envío | instrumentar el acceso a SQLite | no hay transacción SQLite abierta durante la llamada HTTP | — | — | — |
| OB-18 | `conflict` | "Rehacer" | nueva operación (`entity_seq`+1); movimientos provisionales re-vinculados | — | `conflict` + nueva `pending` | nueva `operation_id` |
| OB-19 | `conflict` | "Descartar" (admin local) | movimientos `rejected`; dejan de contar; `resolution_note` | — | `conflict` resuelta | — |

#### Seguridad (SE)

| ID | Estado inicial | Operaciones | Resultado esperado | Mov · Ev | Ob | Idem |
|---|---|---|---|---|---|---|
| SE-01 | rol `anon` | llamar a cualquier `lmm_*` | `permission denied` (sin `EXECUTE`) | 0 · 0 | — | — |
| SE-02 | usuario autenticado **sin** dispositivo ni membresía | `lmm_apply_operation` | `PT403` | 0 · 0 | `dead_letter` | — |
| SE-03 | dispositivo revocado; JWT aún vigente | `lmm_apply_operation` | `PT403` inmediato | 0 · 0 | `dead_letter` | — |
| SE-04 | dispositivo del restaurante X | operar sobre pedido/producto de Y | `inventory_not_found`/`order_not_found` (sin fuga); datos de Y intactos | 0 · 0 | `conflict` | — |
| SE-05 | token inválido o expirado | cualquier RPC | 401 de PostgREST | 0 · 0 | `pending` (renovar) | — |
| SE-06 | — | sobre con `role`, `is_admin`, `authorized_by` o `user_role` | `PT422 unknown_envelope_key` / `invalid_intent` | 0 · 0 | `dead_letter` | — |
| SE-07 | — | sobre con `restaurant_id` | `PT422`; el restaurante sigue saliendo de `lmm.devices` | 0 · 0 | `dead_letter` | — |
| SE-08 | — | `authorization_id` inventado / de otro restaurante / booleano `authorized:true` | `authorization_invalid {not_found}` / `PT422` | 0 · 0 | `conflict`/`dead_letter` | — |
| SE-09 | sesión `authenticated` | `SELECT/INSERT/UPDATE` directo sobre `lmm.*` | `permission denied for schema lmm` | 0 · 0 | — | — |
| SE-10 | — | petición REST a `/lmm/...` | no expuesto (404/406) | — | — | — |
| SE-11 | — | `has_function_privilege` de `anon`/`authenticated` sobre `lmm.*` y de `anon` sobre `public.lmm_*` | todo `false` salvo `authenticated` sobre las 7 `public.lmm_*` | — | — | — |
| SE-12 | objeto homónimo plantado en `public` | ejecutar RPC | sin efecto (`search_path = ''`) | — | — | — |
| SE-13 | PIN erróneo | 5 intentos | `approver_locked` 15 min; PIN correcto durante el bloqueo es rechazado | — | — | — |
| SE-14 | PIN correcto | emitir y usar desde otro dispositivo | `wrong_device` | 0 · 0 | `conflict` | — |
| SE-15 | aprobador de otro restaurante | `lmm_issue_authorization` | `approver_invalid` | — | — | — |
| SE-16 | aprobador revocado tras emitir | usar la autorización | `authorization_invalid {issuer_inactive}` | 0 · 0 | `conflict` | — |
| SE-17 | código de enrolamiento usado / vencido / de otro restaurante | `lmm_enroll_device` | rechazado; ningún dispositivo creado | — | — | — |
| SE-18 | dispositivo con autorizaciones activas | `lmm_revoke_device` | autorizaciones `revoked`; dispositivo `revoked` | — | — | — |
| SE-19 | `client_created_at` años en el futuro/pasado | `sale` | `created_at` y orden de eventos son del servidor | 1 · 1 | `applied` | — |
| SE-20 | tras la migración | cliente antiguo con clave anónima escribe `sync_inventory` | denegado | — | — | — |
| SE-21 | `GRANT SELECT` accidental a `authenticated` en una tabla | `SELECT` | 0 filas (RLS sin políticas) | — | — | — |
| SE-22 | no-administrador | `lmm_create_enrollment` / `lmm_revoke_device` | rechazado (sin membresía `owner/admin`) | — | — | — |
| SE-23 | sobre > 256 KB, > 200 líneas, `\u0000` | `lmm_apply_operation` | `PT422` | 0 · 0 | `dead_letter` | — |
| SE-24 | autorización **online** emitida con `valid_until` pasado hace 1 min (`offline_grace=false`) | `sale` con ese id | rechazo `{expired}` (sin gracia); un **vale offline** (`offline_grace=true`) con el mismo atraso dentro de 48 h sí se acepta (A-03) | 0 · 0 / 1 · 1 | `conflict` / `applied` | rechazo persistido |
| SE-25 | membresía `admin` de otro restaurante | `lmm_create_enrollment(R, …)` y `lmm_revoke_device(R, …)` | `PT403 not_authorized`; ningún efecto | 0 · 0 | — | — |
| SE-26 | — | `lmm_enroll_device` con código usado, vencido o inexistente; y con `auth.uid()` ya enrolado | `enrollment_invalid` / `already_enrolled`; ningún dispositivo nuevo | — | — | — |

#### Migración (MG)

| ID | Estado inicial | Operaciones | Resultado esperado | Mov · Ev | Ob | Idem |
|---|---|---|---|---|---|---|
| MG-01 | `sync_queue` con `inventory` pendiente | clasificar | cuarentena + informe; **nunca enviada**; luego `synced=1` | 0 · 0 | — | — |
| MG-02 | dos dispositivos con stock distinto del mismo producto | determinar saldo | producto `discrepante`; ningún valor automático; requiere decisión | 0 · 0 | — | — |
| MG-03 | mismo nombre con UUID distinto | informe | duplicado listado; fusión manual reasigna `inventory.uuid` y `movements.inventory_uuid` | — | — | — |
| MG-04 | `order_items.invId` sin producto | clasificar | huérfano archivado, excluido | — | — | — |
| MG-05 | pedido abierto con movimientos locales | `lmm_migrate_open_order` | ledger = historial local; `cancel` posterior devuelve lo descontado; sin movimientos ⇒ ledger 0 | — | — | idempotente |
| MG-06 | backups | restaurar en staging | datos idénticos (checksums) | — | — | — |
| MG-07 | antes del punto de no retorno | rollback | legacy operativo; `lmm` sin uso | — | — | — |
| MG-08 | migración interrumpida | repetir `opening_balance` | no duplica saldo (misma `operation_id`/key) | 1 · 1 | — | `replayed` |
| MG-09 | tras activación | dispositivo con build antiguo | no puede escribir stock | — | — | — |
| MG-10 | producto aceptado con saldo negativo | opening balance | `adjust_out` con motivo `opening_balance` y autorización de propietario | 1 · 1 | — | — |

#### Precisión y canónico (PR)

| ID | Estado inicial | Operaciones | Resultado esperado | Mov · Ev | Ob | Idem |
|---|---|---|---|---|---|---|
| PR-01 | vectores compartidos (orden de claves, escapes, Unicode, enteros) | `canonical_json` en Node y en PostgreSQL | salida idéntica byte a byte | — | — | — |
| PR-02 | mismo intent | hash en cliente y en servidor | `payload_hash` idéntico | — | — | — |
| PR-03 | S=0 | `0,1 + 0,2` con `NUMERIC(14,3)` y con milésimas | exactamente `0,3` | — | — | — |
| PR-04 | — | decimales no canónicos | rechazados en cliente y servidor | — | — | — |
| PR-05 | — | `ROUND(unit_price·qty, 2)` | valores esperados con redondeo comercial | — | — | — |
| PR-06 | 100.000 valores aleatorios | milésimas ↔ string ida y vuelta | sin pérdida | — | — | — |

---

## 20. Plan de implementación por etapas

Este plan **no autoriza** implementar. Cada etapa tiene una puerta de salida; no se avanza sin cumplirla. La implementación real requiere una fase posterior con aprobación explícita.

| Etapa | Contenido | Puerta de salida |
|---|---|---|
| **0. Cierre de insumos** | Cerrar las decisiones DEC-01…DEC-08; exportar el esquema remoto real (`information_schema` de las tablas `sync_*` y políticas); obtener o describir el cliente móvil (R-02); confirmar versiones (Supabase, `better-sqlite3`, Electron). | Decisiones firmadas; esquema remoto comparado con 17.1; estrategia del móvil definida. |
| **1. Supabase aislado (sin producción)** | Crear un proyecto de pruebas; roles y schema `lmm` (6.1, 13.3); ejecutar **todo** el SQL de la sección 18 y corregir lo que falle; confirmar supuestos de plataforma (G2 de 24.2). Ejecutar IDM, ST, RT, OR, SE y EV-04…EV-06 con **conexiones reales concurrentes**. | 100 % de esas pruebas aprobadas; verificación de privilegios (`has_function_privilege`) y de acceso directo denegado; I-EV-3 confirmada o rediseñada. |
| **2. Núcleo local aislado** | Módulo de inventario aislado (decimales en milésimas, JSON canónico con vectores compartidos Node↔PostgreSQL, `computeSaleEffect`, outbox, `applyAuthoritativeResultTx`, cursor) sobre **copias** de SQLite; pruebas PR, OB, SY, EV con dos o más SQLite y procesos Node independientes contra el proyecto de la etapa 1. | PR, OB, SY, EV aprobadas; vectores de 10.2 idénticos en cliente y servidor. |
| **3. Integración en el POS (tras feature flag)** | Reemplazar en `routes/orders.js` y `routes/inventory.js` el descuento local por cálculo provisional + outbox; UI de estados (5.6) y saldo provisional/confirmado; modo mantenimiento; enrolamiento y revocación de dispositivos; vales offline según DEC-02. | Suite actual de pruebas del repositorio sin regresiones; pruebas nuevas de integración aprobadas. |
| **4. Herramientas de migración** | Informe de saldos por producto, cuarentena de `sync_queue`, reconciliación de UUID, bootstrap remoto, `opening_balance`, `lmm_migrate_open_order`; **ensayo completo y ensayo de rollback** sobre copias de datos reales. | MG-01…MG-10 aprobadas; restauración verificada; informe de discrepancias revisado por el propietario. |
| **5. Auditoría final y caos** | Auditoría independiente del código resultante; pruebas de caos (cortes de red, caídas de proceso, relojes desfasados, carga con ≥ 10 dispositivos simulados). | Sin hallazgos críticos/altos abiertos. |
| **6. Piloto y despliegue** | Un restaurante piloto (todos sus dispositivos a la vez), monitoreo (cantidad de `conflict`/`dead_letter`, divergencia entre confirmado local y remoto, latencia de cursor); luego el resto. | Métricas dentro de umbral durante el período acordado. |

---

## 21. Riesgos, supuestos y decisiones abiertas

### 21.1 Riesgos

| ID | Riesgo | Severidad | Mitigación / estado |
|---|---|---|---|
| R-01 | El **esquema remoto real** (tablas `sync_*`, políticas, tipos) no está en el material analizado. | Alta | Etapa 0: exportarlo y compararlo con 17.1 antes de implementar. **Abierto.** |
| R-02 | Un **cliente móvil** escribe pedidos en `sync_orders`; su código no se analizó. Si crea pedidos con ítems de inventario, el efecto de stock debe pasar por V8. | Alta | Definir en la etapa 0 (opciones: móvil de solo lectura de inventario; o el móvil envía `sale` por la RPC con su propio dispositivo enrolado; o proyección de solo lectura de `lmm.orders`). **Abierto; puerta G3.** |
| R-03 | **El SQL de PostgreSQL no fue ejecutado.** Supuestos de plataforma a confirmar: `jsonb_to_recordset` con cantidades como string; `ORDER BY … FOR UPDATE` bloquea en el orden de salida; `trim_scale` (PG ≥ 13); `extensions.crypt`; creación de `lmm_owner` y sus `GRANT`. | Alta | Etapa 1 (puerta G1/G2). |
| R-04 | El saldo se asigna por **orden de llegada** al servidor: quién recibe el faltante no depende del orden real de las ventas offline. | Media | Inherente a "el servidor es la autoridad"; el faltante queda trazado y visible; los administradores pueden ajustar. |
| R-05 | Ventana de abuso de **vales offline** (consumo hasta `valid_until + 48 h`). | Media | Un uso, atado al dispositivo, tope de vales pendientes, revocación inmediata; política en DEC-02. |
| R-06 | El servidor identifica el **dispositivo**, no al empleado local. | Media | Las acciones peligrosas exigen PIN de administrador verificado en el servidor; los permisos entre empleados siguen locales. |
| R-07 | Todas las operaciones de un restaurante se serializan al tomar el contador de eventos. | Baja | Aceptable para un POS; medir en la etapa 1/5. |
| R-08 | Relojes de los dispositivos desfasados. | Baja | Ningún orden ni decisión depende de ellos. |
| R-09 | `PTnnn`→HTTP y estructura de errores de PostgREST no verificados. | Media | Etapa 1. Alternativa: devolver errores como `jsonb` con `status`. |
| R-10 | La trazabilidad de movimientos **ajenos** anterior a un `resync` no se reconstruye desde el snapshot. | Baja | Consulta de movimientos por producto; los datos remotos nunca se purgan. |
| R-11 | Saldos negativos acumulados por ventas autorizadas. | Baja | Estado válido por regla comercial; ajustes auditados. |
| R-12 | Una operación en `conflict`/`dead_letter` **bloquea** las siguientes de su pedido. | Media | Visible en la UI; resolución manual (14.7); no afecta a otros pedidos. |
| R-13 | Depende de la configuración de **Supabase Auth** (cuentas de dispositivo). | Media | DEC-01; validar en etapa 1. |
| R-14 | **Ventana de mantenimiento** con ventas pausadas durante la migración. | Media | DEC-07; ensayo previo para acotar el tiempo. |
| R-15 | Recetas (`menu_ingredients`) no descuentan inventario hoy y quedan fuera de alcance. | Baja | Documentado en 2. |
| R-16 | Pedidos de la migración sin movimientos rastreables tendrán ledger 0 (la cancelación no devolverá stock). | Baja | Conservador; informado en el reporte de migración. |
| R-17 | `jsonb` no preserva formato numérico (`1.0`); por eso el intent solo admite enteros y strings. | Baja | Validación estricta (18.7). |
| R-18 | **Precios no validados** por el servidor (M-02): `unit_price` es del cliente. | Media | Documentado en 2; requiere catálogo de precios autoritativo (fuera de alcance). |

### 21.2 Decisiones abiertas (con valor por defecto propuesto)

| ID | Decisión | Propuesta |
|---|---|---|
| DEC-01 | Cuentas de Supabase Auth de dispositivos: inicio de sesión anónimo habilitado vs. cuentas provisionadas | Cuentas provisionadas por enrolamiento si el proyecto no admite anónimos |
| DEC-02 | Vales de autorización offline: ¿se permiten?, ¿cuántos?, ¿vigencia? | Sí; hasta 5 por dispositivo; 12 h; gracia 48 h |
| DEC-03 | Escala de cantidades | 3 decimales (confirmar con unidades reales, p. ej. g vs kg) |
| DEC-04 | Retención de eventos | 30 días y `ack` de todos los dispositivos activos |
| DEC-05 | Propietario de funciones | `lmm_owner`; si Supabase no lo permite, `postgres` |
| DEC-06 | ¿Un ajuste negativo autorizado puede dejar saldo negativo? | Sí, con advertencia en el resultado |
| DEC-07 | Contingencia durante la ventana de migración | Venta en papel y registro posterior |
| DEC-08 | ¿Archivar el histórico local en `lmm.legacy_stock_movements`? | Sí, sin efecto sobre saldos |

---

## 22. Matriz de trazabilidad V7 → V8

### 22.1 Requisitos E1–E14 de la tarea

| Req. | Tema | Solución en V8 | Secciones | Pruebas |
|---|---|---|---|---|
| E1 | Idempotencia de operaciones | `operations` + `ROW_COUNT` + `result_payload`; tabla de decisión | 9, 18.3 | IDM-01…IDM-14 |
| E2 | Idempotencia de hijos | identidad propia, `UNIQUE (op, line, kind)`, `assert_lines_free`, hash solo del intent | 7.3, 9.5, 18.7 | IDM-07, IDM-08, IDM-10 |
| E3 | Stock solo en servidor; caso −3 | intents sin campos calculados; `GREATEST(stock,0)`; cuatro conceptos | 3.2, 7.5, 10, 18.4 | ST-01…ST-11 |
| E4 | Devoluciones y ajustes | contratos separados; ledger; autorización de ajustes | 7.5, 12, 18.5 | RT-01…RT-10, ST-12…ST-16 |
| E5 | Pedidos atómicos | RPC única con Fase A/B; orden de bloqueos; versión optimista | 8, 11, 18 | OR-01…OR-19, IDM-13 |
| E6 | SQL ejecutable | corrección de cada defecto de sintaxis; funciones definidas; tipos `NUMERIC` | 18, 19.2 | revisión cruzada A; IDM-01 (ejecución en etapa 1) |
| E7 | Seguridad | identidad por `auth.uid()`, membresías, dispositivos, `search_path = ''`, `REVOKE/GRANT`, RLS | 13 | SE-01…SE-23 |
| E8 | Eventos y cursor | contador gap-free, `device_id` de origen, resultado autoritativo, snapshot | 15 | EV-01…EV-12 |
| E9 | Outbox | estados, claim, lease en caliente, backoff, partición | 14 | OB-01…OB-19 |
| E10 | Reconciliación offline | confirmado/provisional, `applied_results`, guarda por versión | 16 | SY-01…SY-15 |
| E11 | Faltantes | movimiento `shortage` separado; vocabulario de cantidades | 3.3, 10.1 | ST-03…ST-07 |
| E12 | Esquemas y RLS | DDL con PK/FK/CHECK/índices; todas las tablas con `restaurant_id` | 6, 13.4 | SE-09, SE-21 |
| E13 | Migración | 13 pasos, cuarentena, saldo por decisión del propietario | 17 | MG-01…MG-10 |
| E14 | Pruebas | matriz con estado inicial/concurrencia/resultado/saldo/movimientos/eventos/outbox/idempotencia | 19 | — |

### 22.2 Registro de defectos de V7 (30)

Severidad: **C** crítica, **A** alta, **M** media.

| ID | Sev | Defecto en V7 (verificado en su texto) | Corrección en V8 | Secciones | Pruebas |
|---|:--:|---|---|---|---|
| V7-D01 | C | Venta sin autorización con saldo negativo **aumenta** el saldo: `v_stock_decrement := v_available` (−3) ⇒ `delta = +3`, aunque §9.4 decía lo contrario | disponible = `GREATEST(stock, 0)`; propiedad "nunca aumenta" | 3.2, 10.1, 18.4 | ST-04, ST-07, V-4, V-5 |
| V7-D02 | C | Autorización = rol de la sesión (`v_is_admin`); además `auth.jwt() ->> 'role'` en Supabase es `authenticated` | autorización por operación, emitida con PIN verificado en el servidor, de un solo uso | 13.5, 18.4, 18.6 | ST-06, ST-14…ST-19, SE-08, SE-13…SE-16 |
| V7-D03 | C | El servidor tomaba del cliente `shortage_quantity` (movimiento `shortage`), `stock_delta` (ajustes) y la cantidad de devolución, contradiciendo su propio §6.2 | intents cerrados con lista blanca; signo por `kind`; devolución validada contra ledger | 7.5, 12, 18.7 | ST-16, SE-06 |
| V7-D04 | C | `v_movement RECORD` accedido con `->>` (un `RECORD` de `jsonb_array_elements` tiene una columna `value`); la función no ejecuta | variable `jsonb` escalar en `FOR … IN SELECT t.value …`; `FOREACH` solo sobre arrays reales | 18.5, 18.7 | IDM-01 (etapa 1) |
| V7-D05 | C | Idempotencia de hijos rota: compara `stock_delta` con un campo que el cliente no envía (NULL ⇒ toda repetición lanza conflicto) y el hash del hijo incluye `stock_delta`, un resultado calculado | hash solo del intent; unicidad `(op, line, kind)`; chequeo de pertenencia | 9.5, 18.7 | IDM-07, IDM-08 |
| V7-D06 | C | El reintento idéntico no devuelve el resultado persistido (no existe `result_payload`); contrato §6.3 ≠ implementación; `RETURNS JSONB` con `json_build_object` | `result_payload`; `RETURNS jsonb` | 7.7, 9, 18.3 | IDM-02, IDM-11 |
| V7-D07 | C | Pedido: `UPDATE orders_sync … WHERE uuid` (la columna es `order_uuid`), sin `expected_order_version` en la RPC, sin actualizar ítems ni estado; variable no declarada en §10.2 | `orders/order_items/ledger`; versión optimista; Fase A/B | 6, 11, 18.5 | OR-01…OR-19 |
| V7-D08 | C | Devoluciones sin validar venta original ni remanente (§10.5 lo exigía, §7 no lo hacía) | ledger, fuentes y remanente; bloqueos | 12.1, 18.5 | RT-01…RT-10 |
| V7-D09 | C | Eventos con la **intención** del cliente como payload; sin `device_id` (pero §11.4 lo usaba); contador sin inicializar ⇒ `event_seq` NULL | resultado autoritativo; `device_id` de origen; trigger + `ON CONFLICT DO NOTHING` | 15 | EV-04…EV-06, SY-07, SY-08 |
| V7-D10 | C | Sin reconciliación offline: "stock local + delta remoto" duplica el descuento ya aplicado localmente | confirmado + provisional; `applied_results`; guarda por versión | 16 | SY-01…SY-15 |
| V7-D11 | C | Seguridad: `uuid = text` en la validación del dispositivo y en RLS; claims inexistentes en la autenticación actual; `device_id` del movimiento tomado del payload; sin membresías; `order_items_sync` sin `restaurant_id`; `REVOKE ALL` junto a políticas `SELECT` inalcanzables; sin `REVOKE` para `anon`/`PUBLIC` en funciones | identidad por `auth.uid()` → `lmm.devices`; schema privado; `REVOKE/GRANT`; RLS defensivo | 13 | SE-01…SE-23 |
| V7-D12 | C | `search_path = pg_catalog, public`; `digest()` no alcanzable (vive en `extensions`); `canonical_json()` nunca definida; sin propietario; funciones sin schema | `search_path = ''`; `sha256` nativa; `canonical_json` definida; `lmm_owner` | 7.4, 13.3, 18.1 | SE-12, PR-01, PR-02 |
| V7-D13 | C | Con autorización el faltante se registraba en 0 (la regla 4.3 pide registrarlo) y no se generaban movimientos `shortage` pese a que las pruebas los esperaban | faltante siempre; movimiento `shortage` separado | 10.1, 18.4 | ST-03…ST-07, SY-02 |
| V7-D14 | C | `REAL` para cantidades (4 bytes en PostgreSQL, no 8 como decía V7) | `NUMERIC(14,3)`; milésimas enteras; strings canónicos | 5.1, 6.1, 7.4 | ST-08…ST-10, PR-03…PR-06 |
| V7-D15 | A | `idempotency_key` UNIQUE global sin mapear (23505 crudo); PK/UNIQUE sin `restaurant_id` (filtra existencia entre restaurantes) | claves con `restaurant_id`; manejo de `unique_violation` | 6.1, 9.2, 18.3 | IDM-04, IDM-05, IDM-14 |
| V7-D16 | A | Rechazos de negocio imposibles de persistir: todo error es excepción y se revierte; estados `rejected/conflict` inalcanzables | rechazos devueltos y persistidos; excepciones solo para manipulación/sistema | 7.8, 8.1 | IDM-12, ST-14, OB-07 |
| V7-D17 | A | Orden de bloqueo indefinido (inventario según el array, luego pedido y contador); sin `lock_timeout`; sin tratamiento de `40P01/55P03` | orden global fijo; `lock_timeout`; clasificación en la outbox | 8.2, 14.4 | OR-18 |
| V7-D18 | A | Outbox: `retry_wait` nunca reclamable; lease solo al arrancar; sin orden ni dependencias; sin respuesta almacenada; backoff incoherente (tabla vs "7 intentos") | claim redefinido, partición, `depends_on`, `response_payload`, clasificación | 14 | OB-01…OB-19, V-1 |
| V7-D19 | A | Migración sin considerar el esquema real, con "dispositivo de referencia" que impone un saldo absoluto, sin rollback ni backup ni pedidos abiertos | 13 pasos con decisión del propietario y rollback | 17 | MG-01…MG-10 |
| V7-D20 | A | Pruebas contradictorias e incompletas (sin devoluciones, fraccionarios, stock cero/exacto/negativo, seguridad, outbox, eventos propios/ajenos; sin el caso 4+4) | matriz de 164 pruebas con separación propuestas/ejecutadas | 19 | todas |
| V7-D21 | A | `created_at` remoto = reloj del dispositivo | `created_at` del servidor; `client_*` informativos | 6.1, 13.8 | SE-19 |
| V7-D22 | A | El contrato exige `restaurant_id` del cliente y "valida" `user_name/user_role` contra claims inexistentes | sobre sin esos campos | 7.2, 13.8 | SE-06, SE-07 |
| V7-D23 | A | Sin FK/CHECK/índices; tipos inconsistentes (`device_id` TEXT vs UUID); `entity_type` local ≠ remoto | DDL completo con integridad referencial | 5.4, 6.1 | revisión cruzada A |
| V7-D24 | M | Numeración duplicada (§10.5 ×2), explicaciones imprecisas (§8.1–8.2), tablas mal formateadas | reescritura | todo | — |
| V7-D25 | M | Sin retención de eventos, resincronización ni gaps accionables | `min_retained_seq`, snapshot, gap | 15.4, 15.7 | EV-02, EV-03, EV-07, EV-08 |
| V7-D26 | M | Cancelación/reapertura basadas en `SUM(sale)`; modificación de cantidades sin definir | `efectivo_neto`/`no_cumplido`; algoritmo de `modify` | 11.3, 12.2 | OR-03…OR-10 |
| V7-D27 | M | Autorización offline no contemplada | vales pre-emitidos | 13.6 | ST-19, SE-14 |
| V7-D28 | M | Estado de operación en espera sin definir (estados en español distintos a los remotos) | estados unificados | 5.6 | SY-13, SY-15 |
| V7-D29 | M | Se ignora la coexistencia con las tablas `sync_*` actuales y el cliente móvil (y nombres invertidos `inventory_sync`/`sync_inventory`) | convención de nombres `lmm.*`; compatibilidad como decisión abierta | 17.1, 21 (R-02) | puerta G3 |
| V7-D30 | M | Plan y riesgos sin puertas de salida; criterio "las 26 pruebas pasan" sobre pruebas inconsistentes | plan con puertas; criterios medibles | 20, 23 | — |

Totales: **30 defectos** (14 C, 9 A, 7 M); **30 corregidos en el diseño**; **0 pendientes como defectos de diseño**. V7-D29 queda condicionado a decisiones externas (R-02), identificadas y no ocultas.

---

## 23. Criterios de aceptación y revisión cruzada

### 23.1 Criterios de aceptación

| # | Criterio | Estado | Evidencia / condición |
|---|---|---|---|
| 1 | No hay SQL conceptualmente inválido | **Cumple en revisión; no ejecutado** | Revisión manual y automatizada (23.2-A); puerta G1: ejecutar en Supabase aislado |
| 2 | Los nombres de columnas coinciden con los DDL | **Cumple** | Verificación automática: 15 tablas; 0 desajustes en `INSERT/UPDATE` |
| 3 | Contratos de entrada/salida coinciden con la implementación propuesta | **Cumple** | 7.5/7.7 contra 18.3–18.7 (lista blanca en `validate_intent`; resultado construido por las `op_*`) |
| 4 | El servidor calcula todos los efectos de stock | **Cumple** | Intents sin campos calculados; 10.1; V-4 |
| 5 | Las devoluciones respetan lo efectivamente descontado | **Cumple** | 12.1; V-4 (devuelto ≤ vendido por fuente); RT-* |
| 6 | Los ajustes están autorizados y auditados | **Cumple** | 12.3, 13.5; ST-12…ST-15 |
| 7 | Pedidos e inventario atómicos | **Cumple** | 8, 11, 18.5 (una transacción; Fase A/B); IDM-13, OR-* |
| 8 | Idempotencia en operaciones y movimientos hijos | **Cumple** | 9; IDM-* |
| 9 | Eventos y cursores no pierden operaciones confirmadas | **Cumple en diseño; I-EV-3 por confirmar** | 15.2; EV-04 |
| 10 | La outbox se recupera de cualquier interrupción | **Cumple** | 14; V-1; OB-01, OB-16 |
| 11 | Reconciliación offline definida de extremo a extremo | **Cumple** | 16; V-2; SY-* |
| 12 | La seguridad no depende de datos del cliente | **Cumple en diseño** | 13.8; SE-*; ejecución en etapa 1 |
| 13 | La migración contempla los datos históricos reales | **Cumple** | 17 (esquema leído del código) |
| 14 | Sin contradicciones entre pruebas, SQL, esquemas y contratos | **Cumple** | 23.2-F |
| 15 | Riesgos no resueltos identificados y no ocultos | **Cumple** | 21 |

### 23.2 Revisiones cruzadas (resultado)

| Revisión | Método | Hallazgos de la propia redacción de V8 (todos corregidos antes de cerrar) | Resultado |
|---|---|---|---|
| **A — Esquemas contra SQL** | Script que extrae columnas del DDL y las contrasta con cada `INSERT`/`UPDATE` del pseudocódigo y con las funciones invocadas; lectura manual | (1) `FOUND` sobrescrito por una consulta intermedia en `check_authorization`; (2) `movement_id` de ajuste igual al `operation_id` (riesgo de colisión de PK); (3) `assert_lines_free` ignoraba `movement_id`; (4) colisión de `item_uuid` entre pedidos sin conflicto explícito; (5) el `upsert` de ítems no actualizaba `item_type`; (6) **siete funciones invocadas sin definición** (ahora en 18.7); (12) `validate_intent` tenía un `CASE … THEN` dentro de la condición de un `IF` (el `THEN` del `CASE` termina la condición en PL/pgSQL): detectado al validar la sintaxis con el parser real de PostgreSQL (`pglast`) y corregido | **Aprobada**: 15 tablas, 0 desajustes de columnas, 0 funciones sin definir |
| **B — Contratos contra reglas comerciales** | Simulación independiente (V-4/V-5), tabla 10.2, revisión de cada `kind` | (7) El orden autorización → pedido en `modify/reopen` rompía el orden global de bloqueos | **Aprobada**: 20.000 escenarios sin violar invariantes; la regla de V7 es detectada como defectuosa |
| **C — Idempotencia contra concurrencia** | Análisis del bloqueo de índice único y de `READ COMMITTED`; tabla de decisión | — | **Aprobada en diseño**; carrera real pendiente (IDM-11, EV-05) |
| **D — Seguridad contra funciones privilegiadas** | Recorrido función por función: identidad, `EXECUTE`, `search_path`, datos del cliente | (8) El contador de PIN erróneo se revertiría si el fallo fuera excepción ⇒ se devuelve como resultado (13.5); (9) el `ack` del cursor podía superar el contador ⇒ acotado (`LEAST`) | **Aprobada en diseño**; verificación de privilegios real pendiente (SE-11) |
| **E — Eventos contra reconciliación** | Verificación en SQLite (V-2) | (10) El evento no llevaba el contenido del pedido para otros dispositivos ⇒ `order.items` en el resultado; (11) faltaba el estado local `rejected` y las columnas de resolución de la outbox | **Aprobada** |
| **F — Pruebas contra arquitectura** | Script que verifica que cada ID de prueba citado en 22 exista en 19.3 y que cada requisito E1–E14 y cada defecto tenga al menos una prueba o una puerta | — | **Aprobada** (resultado en el informe final) |

**Hallazgos propios corregidos:** 12. Ninguno queda abierto.

### 23.3 Auditoría externa de V8 (hallazgos y resolución) — revisión V8.1

Una auditoría externa de V8 rechazó la aprobación por cuatro hallazgos críticos. Se verificó cada uno contra el texto de V8 y **todos eran reales**.

| ID | Hallazgo | Veredicto | Corrección en V8.1 | Dónde | Prueba |
|---|---|---|---|---|---|
| C-01 | El *constraint trigger* diferido usaba `NEW` (imagen `processing` del `INSERT`) y habría revertido **todas** las operaciones | **Real** (los eventos diferidos conservan la imagen de la fila al dispararse) | el trigger consulta el estado final por clave | 6.1, 9.4 | IDM-15 |
| C-02 | La devolución reducía `requested_net` sin tocar ítems; un `modify` posterior volvía a descontar | **Real** (reproducido en la simulación: +2) | semántica única: la devolución **no** modifica `requested_net`, ítems ni versión | 11.1, 11.3, 12.1, 18.5 | RT-11, RT-12, V-4 |
| C-03 | La deduplicación dejaba movimientos provisionales sin conciliar (y duplicaba movimientos) | **Real** | alias: provisionales propios → `rejected`; se cierran outbox propia y original | 16.2, 7.7 | SY-12 + prueba del módulo |
| C-04 | `ON CONFLICT DO UPDATE` podía modificar un ítem de otro pedido; la comprobación previa no es segura ante carreras | **Real** | `ON CONFLICT … WHERE order_uuid = EXCLUDED.order_uuid` + verificación de filas afectadas (`PT409`); en `sale`, `DO NOTHING` + verificación | 18.5, 18.7 | IDM-17, OR-20 |
| A-01 | `idempotency_key` con ordinal local podía colisionar entre dispositivos | **Real** | la clave incluye `device_id` | 7.1, 5.4 | IDM-16 + prueba del módulo |
| A-02 | Campos ausentes producían condiciones `NULL` que no disparaban `PT422` | **Real** | helpers `lmm.ok_*` que nunca devuelven `NULL`; `idempotency_key` y `client_created_at` validados | 18.7, 18.3 | ST-24, ST-25 |
| A-03 | La gracia de 48 h se aplicaba a toda autorización | **Real** | solo los vales offline (`offline_grace`) tienen gracia; las online vencen en `valid_until` | 6.1, 13.5, 13.6, 18.4 | SE-24 |
| A-04 | Funciones de administración sin código | **Real** | código en 18.8 (`lmm_get_snapshot`, enrolamiento, revocación, `lmm.purge_events`, `lmm.migrate_open_order`) | 18.8 | SE-25, SE-26, EV-13, EV-14, MG-05 |
| M-01 | Política de vales offline abierta (DEC-02) | **Vigente** | sigue como decisión abierta; ahora con `offline_voucher` explícito | 13.6, 21.2 | — |
| M-02 | `unit_price` del cliente no se valida | **Real** | limitación documentada (R-18) | 2, 21.1 | — |
| M-03 | La matriz no está ejecutada | **Correcto** | sin cambios: se mantiene la separación propuestas/ejecutadas | 19.1 | — |
| M-04 | El documento no adjunta código ni diff | **Correcto** | el código y el diff se entregan como archivos aparte (`LMM_V8_*.zip`, `cambios_archivos_existentes.diff`); este documento solo describe el diseño | 24.3 | — |

Hallazgo adicional propio (misma familia que A-02): `lmm.order_json` y `lmm.inventory_json` debían ser `STABLE` para que `lmm_get_snapshot` use **una** instantánea (una función `VOLATILE` toma una instantánea nueva por sentencia).

**Lo que la revisión no puede cerrar:** el SQL sigue **sin ejecutarse** (solo se validó su sintaxis); C-01 y C-04 dependen de comportamientos internos de PostgreSQL que deben confirmarse en la etapa 1 (puerta G1).

---

## 24. Veredicto final

### 24.1 Veredicto

**V8.1 — CORRECCIONES DE AUDITORÍA EXTERNA APLICADAS; PENDIENTE DE RE-AUDITORÍA. NO LISTA PARA IMPLEMENTAR.**

Esto significa que: los hallazgos críticos y altos de la auditoría externa se corrigieron **en el diseño y en el SQL**; los 30 defectos de V7 siguen corregidos; las reglas comerciales de stock se verificaron con una simulación independiente; la reconciliación offline, la outbox y el JSON canónico se verificaron en SQLite; y la sintaxis de toda la migración se validó con el parser de PostgreSQL. **No significa** que el SQL esté validado en ejecución: por la cantidad de defectos que encontró cada ronda de revisión, hay que asumir que una ejecución real (puerta G1) encontrará más.

### 24.2 Puertas obligatorias antes de implementar

| Puerta | Condición |
|---|---|
| **G1** | Ejecutar todo el SQL de la sección 18 en un proyecto Supabase aislado y aprobar IDM, ST, RT, OR, SE y EV con conexiones concurrentes reales. |
| **G2** | Confirmar los supuestos de plataforma de R-03 y R-09 (incluida I-EV-3). |
| **G3** | Exportar el esquema remoto real y definir el tratamiento del cliente móvil (R-01, R-02). |
| **G4** | Cerrar DEC-01…DEC-08. |
| **G5** | Aprobar las pruebas locales (SY, OB, PR) con dos o más SQLite y procesos Node independientes. |
| **G6** | Ensayo completo de migración y de rollback sobre copias. |
| **G7** | Auditoría final independiente. |
| **G8** | Aprobación explícita para pasar a implementación. |

### 24.3 Declaración de alcance (actualizada)

Fase de diseño: se entregó este documento sin tocar código. **Fase posterior (instrucción explícita del usuario de modificar archivos):** se creó una implementación inicial, **aditiva y apagada por defecto**:

| Archivo | Cambio |
|---|---|
| `services/inventory-sync-v8/*` (nuevo) | decimales, JSON canónico, regla de venta, esquema local, outbox, conciliación, motor, hook, README |
| `supabase/migrations/20261123000000_lmm_inventory_sync_v8.sql` (nuevo) | esquema remoto `lmm`, funciones y privilegios del diseño. **No ejecutado** contra ninguna base |
| `tests/inventory-sync-v8.test.js` (nuevo) | 25 pruebas del módulo |
| `db.js` | llama a `applySchema` (columnas/tablas nuevas, sin cambiar comportamiento) |
| `routes/orders.js` | hook en la **creación** de pedidos, solo si `LMM_INVENTORY_SYNC_V8=1`, dentro de `try/catch` |
| `sync-engine.js` | con el interruptor encendido, no sube ni aplica stock absoluto (`inventory`) |

No se tocó Supabase ni producción; no se ejecutó la migración remota ni ninguna RPC. Con `LMM_INVENTORY_SYNC_V8` sin definir, el POS se comporta como antes (solo se agregan columnas y tablas vacías). **El interruptor no debe encenderse todavía**: `merge/modify/cancel/reopen/devoluciones/ajustes` aún no se encolan y falta el cliente real de Supabase (puertas G1–G8 vigentes).
