-- ============================================================================
-- La Mente Maestra 3.0 — Inventory Sync V8 (Fase 2B.5.1) — esquema remoto `lmm`
-- Fuente: INVENTORY_SYNC_PHASE_2B5_1_ARCHITECTURE_DESIGN_V8.md (secciones 6, 13 y 18).
--
-- ESTADO: NO EJECUTADA contra ninguna base de datos. Solo se validó su SINTAXIS con el
-- parser de PostgreSQL (pglast/libpg_query). Antes de usarla:
--   1) correrla en un proyecto Supabase AISLADO (nunca en producción),
--   2) aprobar la matriz de pruebas IDM/ST/RT/OR/SE/EV de la sección 19 del diseño,
--   3) confirmar los supuestos de plataforma de R-03 (PTnnn -> HTTP, lmm_owner, extensions.crypt, ...).
-- Revisión V8.1: incluye las correcciones de la auditoría externa (C-01..C-04, A-01..A-04) y las funciones
-- de administración (lmm_get_snapshot, enrolamiento, revocación, lmm.purge_events, lmm.migrate_open_order).
-- ============================================================================

-- 1. Rol propietario y accesos mínimos a schemas ajenos
-- Propietario y accesos mínimos a schemas ajenos
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lmm_owner') THEN
    CREATE ROLE lmm_owner NOLOGIN;
  END IF;
END $$;
GRANT lmm_owner TO CURRENT_USER;
GRANT USAGE ON SCHEMA auth, extensions TO lmm_owner;
GRANT EXECUTE ON FUNCTION auth.uid() TO lmm_owner;
GRANT EXECUTE ON FUNCTION extensions.crypt(text, text), extensions.gen_salt(text) TO lmm_owner;


-- 2. Tablas
CREATE SCHEMA IF NOT EXISTS lmm;

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
-- SECURITY DEFINER: esta constraint trigger es DEFERRABLE y se dispara en el
-- COMMIT, cuando PostgREST ya restauró el rol 'authenticated' (sin USAGE en lmm).
-- Sin DEFINER, el COMMIT de cualquier RPC que inserte en lmm.operations falla
-- con "permission denied for schema lmm" (42501/HTTP 403).
CREATE FUNCTION lmm.tg_operations_not_processing() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
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

-- Configuración por defecto
INSERT INTO lmm.app_config (key, value) VALUES
  ('authorization_grace_hours',          '48'::jsonb),  -- DEC-02/A-03: gracia SOLO para vales offline
  ('offline_voucher_max_per_device',     '5'::jsonb),   -- DEC-02: hasta 5 vales vigentes por dispositivo
  ('offline_voucher_ttl_minutes',       '720'::jsonb),  -- DEC-02: 12 h de vigencia del vale offline
  ('events_retention_days',             '30'::jsonb),
  ('min_client_version',                '"0"'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 3. Funciones
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
  v_off_ttl integer := 720;                                   -- DEC-02: 12 h
  v_off_max integer := 5;                                     -- DEC-02: 5 por dispositivo
  v_active integer := 0;
BEGIN
  v_dev := lmm.require_device(lmm.parse_uuid(p_request ->> 'device_id'));
  IF NOT v_off AND v_ttl > 60 THEN v_ttl := 60; END IF;       -- las autorizaciones online duran como máximo 60 min y sin gracia
  IF v_scope NOT IN ('negative_stock','adjustment')
     OR (v_scope = 'negative_stock' AND v_max IS NOT NULL)
     OR (v_scope = 'adjustment' AND (p_request ->> 'inventory_uuid') IS NULL) THEN
    RAISE EXCEPTION 'invalid_intent: scope' USING ERRCODE = 'PT422';
  END IF;

  -- DEC-02: política de vales offline, leída de app_config para poder ajustarla
  -- sin cambiar código. Alcance ya restringido a negative_stock/adjustment arriba.
  SELECT COALESCE((SELECT (c.value #>> '{}')::integer FROM lmm.app_config c
                    WHERE c.key = 'offline_voucher_ttl_minutes'), 720),
         COALESCE((SELECT (c.value #>> '{}')::integer FROM lmm.app_config c
                    WHERE c.key = 'offline_voucher_max_per_device'), 5)
    INTO v_off_ttl, v_off_max;
  IF v_off THEN
    v_ttl := LEAST(v_ttl, v_off_ttl);
    SELECT COUNT(*) INTO v_active FROM lmm.stock_authorizations s
     WHERE s.restaurant_id = v_dev.restaurant_id
       AND s.issued_to_device_id = v_dev.device_id
       AND s.offline_grace
       AND s.status = 'active'
       AND s.valid_until > pg_catalog.now();
    IF v_active >= v_off_max THEN
      RETURN pg_catalog.jsonb_build_object('status', 'rejected', 'reject_code', 'offline_voucher_limit');
    END IF;
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

-- Propiedad: el schema privado lmm pasa a lmm_owner (DEC-05).
-- Las RPC públicas NO se transfieren: en Supabase lmm_owner no tiene CREATE en
-- "public" y ALTER FUNCTION ... OWNER fallaría con "permission denied for schema
-- public". Se quedan con postgres (propietario de la plataforma), que es el
-- fallback previsto en DEC-05. Sus privilegios se ajustan más abajo.
ALTER SCHEMA lmm OWNER TO lmm_owner;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT schemaname, tablename FROM pg_tables WHERE schemaname = 'lmm' LOOP
    EXECUTE format('ALTER TABLE %I.%I OWNER TO lmm_owner', r.schemaname, r.tablename);
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS sig
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'lmm' LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO lmm_owner', r.sig);
  END LOOP;
END $$;

-- 4. Privilegios y RLS
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
