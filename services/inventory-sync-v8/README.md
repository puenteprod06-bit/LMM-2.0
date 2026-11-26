# inventory-sync-v8

Cliente de sincronización de inventario/pedidos V8 (diseño
`INVENTORY_SYNC_PHASE_2B5_1_ARCHITECTURE_DESIGN_V8.md`).
**Apagado por defecto**. La condición única de activación (V8.1) exige las tres
cosas a la vez: `LMM_INVENTORY_SYNC_V8=1`, `config.cloud_restaurant_id` y
`config.supabase_url` + `config.supabase_anon_key` completos. Si falta una,
el esquema V8 no se instala, el motor no arranca y las razones se registran en
logs/`activationState()`.

## Archivos

| Archivo | Rol |
|---|---|
| `activation.js` | **ÚNICA** condición de activación (flag + nube vinculada + credenciales) |
| `migration.js` | migración local §17: `analyze` / `validate` / `apply` / `rollback` sobre copias |
| `decimal.js` | cantidades en milésimas enteras y strings decimales canónicos |
| `canonical.js` | JSON canónico + SHA-256 del intent (idéntico al servidor) |
| `effect.js` | regla de venta (`computeSaleEffect`): el saldo negativo nunca es disponible |
| `schema.js` | esquema SQLite local aditivo (columnas, índices, outbox, vales) |
| `outbox.js` | cola local: deduplicación, lease atómico, backoff, partición, `recoverOnBoot` |
| `reconcile.js` | saldo confirmado/provisional, resultado autoritativo, cursor de eventos, snapshot |
| `engine.js` | motor `drain` / `pollEvents` con `rpc` inyectable (nunca red dentro de transacción) |
| `rpc.js` | cliente de `lmm_apply_operation`, `lmm_get_events`, `lmm_get_snapshot`, `lmm_issue_authorization`, `lmm_enroll_device`, `lmm_revoke_device` |
| `vouchers.js` | política de vales offline (alcance, límite, vigencia, gracia, device binding, revocación) |
| `hook.js` | puente con las rutas: `sale`, `modify`, `cancel`, `reopen`, `return`, `adjust_in/out` |

`sync-engine.js` arranca el motor (`startV8Engine`, ciclo cada 5 s) y lo detiene
con `stopSync()` / `stopV8Engine()`.

## Esquema local: política segura

`db.js` distingue dos niveles:

1. **Sync legacy**: `isSyncEnabled()` = nube vinculada (`cloud_restaurant_id`).
   Si está apagada, arrancar el POS no crea `schema_migrations`, `sync_queue`,
   columnas de sync ni triggers, y no escribe `device_id` (usa un UUID efímero
   en memoria).
2. **V8**: `getV8ActivationState(db, env)` / `isV8Enabled(db, env)` exigen
   además el flag y las credenciales. Solo entonces `applySyncSchema()` instala
   el esquema aditivo V8 y registra
   `2026112301 / inventory_sync_v8_local_schema`.

Lo usan `db.js`, `sync-engine.js` (incluidas las exclusiones de stock absoluto),
`services/inventory-sync-v8/index.js` y `routes/config.js`. Con nube vinculada
pero flag apagado, el esquema legacy puede instalarse; el V8 **jamás**.
`initializeSchemaForStartup(db, env)` expone la política para pruebas con
SQLite en memoria.

## Vales offline (DEC-02 / A-03)

- Alcance: únicamente `negative_stock` y `adjustment`.
- Hasta **5** vales offline vigentes por dispositivo.
- Vigencia máxima del vale offline: **12 h**.
- Gracia de **48 h** solo si `offline_grace = true`; las autorizaciones online
  vencen en `valid_until`.
- Vinculación al `device_id` que emitió el vale y revocación local/remota.

Servidor: `lmm_issue_authorization` lee `offline_voucher_max_per_device`,
`offline_voucher_ttl_minutes` y `authorization_grace_hours` de `lmm.app_config`;
`lmm.check_authorization` aplica el alcance, el dispositivo, el estado y la
gracia. Cliente: `vouchers.js` valida antes de emitir y antes de adjuntar el
vale a una operación; un vale inválido impide encolar esa operación.

## Precios

Para ítems `menu`/`inventory` con producto en BD, el precio se toma de
`menu_items.price` / `inventory.salePrice` y el precio enviado por el cliente
debe coincidir (tolerancia `0.01`); si no, la respuesta es `400
UNAUTHORIZED_PRICE`. Las filas legacy sin precio de BD y los combos/ítems sin
catálogo conservan el precio del cliente como snapshot.

## Migración local (§17)

`migration.js` trabaja SOLO con un handle SQLite ya abierto sobre una copia.

- `analyze(db, { remoteBalances, deviceReports })`: solo lectura; compara el
  saldo remoto heredado con cada dispositivo, marca discrepancias y lista la
  `sync_queue` heredada pendiente. **No decide ni escribe.**
- `validate(db, { decisions, backupVerified: true })`: exige una decisión
  explícita para **cada** producto y un backup verificado; devuelve
  `ok/errors/accepted` (milésimas). No escribe.
- `apply(...)`: transacción única; **nunca sobrescribe `inventory.stock`**.
  Guarda el saldo aceptado en `stock_confirmed_milli`, incrementa
  `confirmed_version`, deja movimientos históricos como `legacy` y pone en
  cuarentena las filas `sync_queue` de `inventory`: las copia a
  `v8_migration_queue_quarantine` y marca `synced=1` **sin borrarlas**.
  Registra corrida, conteos, decisiones y cada columna anterior en tablas de
  auditoría.
- `rollback(db, { runId, remoteUntouched: true })`: solo antes de la primera
  operación V8 aplicada en remoto. Restaura columnas y `synced`, marca la
  cuarentena como restaurada y conserva **toda** la auditoría.

CLI (rechaza la ruta real del POS y exige `--copy-confirmed`):

```powershell
node scripts/v8-migrate-local.js analyze --db <copia.sqlite> --copy-confirmed --input datos.json
node scripts/v8-migrate-local.js validate --db <copia.sqlite> --copy-confirmed --input datos.json --backup-verified
node scripts/v8-migrate-local.js apply --db <copia.sqlite> --copy-confirmed --input datos.json --confirm --backup-verified
node scripts/v8-migrate-local.js rollback --db <copia.sqlite> --copy-confirmed --run <id> --remote-untouched --confirm
```

## Validación AISLADA del SQL

`npm run validate:v8-sql` ejecuta la migración completa en **PGlite**
(PostgreSQL 19 compilado a WASM, en memoria): sin daemon, red ni credenciales.
`auth.uid()` y `crypt/gen_salt` se sustituyen por stubs locales: se valida
SQL/PLpgSQL, RLS, privilegios, idempotencia, vales y carreras lógicas (14/14).

Además, `node scripts/validate-v8-supabase.js all --confirm-isolated
--reset-throwaway` aplicó la migración en un proyecto Supabase **hosted
desechable** (PostgreSQL 17.6) con `auth.uid()`, `pgcrypto`, RLS y PostgREST
reales: **6/6 PASS** (`docs/V8_SUPABASE_ISOLATED_RESULT.json`). La concurrencia
física con dos sesiones PostgREST paralelas se validó con
`node scripts/validate-v8-supabase-concurrency.js --confirm-isolated`:
**3/3 PASS** (`docs/V8_SUPABASE_CONCURRENCY_RESULT.json`). Requiere
`.env.isolated` (ignorado por Git).

## Pruebas

```powershell
node scripts/run-tests.js tests/inventory-sync-v8.test.js tests/v8-hardening.test.js tests/v8-migration.test.js tests/orders.test.js tests/orders-money-security.test.js tests/sync-security.test.js --forceExit
npm run validate:v8-sql
npm run validate:v8-migration
```

Usan `better-sqlite3` si está disponible y, si no, el SQLite embebido de Node.
Ninguna prueba ejecuta migraciones contra Supabase real ni contra la base de
datos del POS.

## Pendiente antes de encender en producción

1. Exportar el esquema `sync_*` del Supabase productivo (acceso de solo lectura)
   y decidir el tratamiento del cliente móvil. La concurrencia física ya pasó
   3/3 en el proyecto aislado; no se conectó a producción.
2. Obtener backups verificados y decisiones del propietario para el saldo
   inicial de cada producto; ejecutar el ensayo de migración y de rollback con
   la CLI anterior sobre copias, nunca sobre la BD del POS.
3. Mantener `LMM_INVENTORY_SYNC_V8=0` en producción hasta completar los puntos
   anteriores. La activación es todo-o-nada: todos los dispositivos de un
   restaurante a la vez; inventario no admite clientes V7 y V8 conviviendo.
