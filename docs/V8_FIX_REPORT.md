# Informe de corrección V8 / V8.1 — La Mente Maestra 3.0

Fecha: 2026-11-24, actualizado 2026-11-26. Proyecto: `LMM_V8_proyecto_completo.zip`
(carpeta de trabajo confirmada en la sesión). Se modificaron archivos reales;
**nunca** se ejecutó migración, SQL ni prueba contra Supabase de producción ni
contra la base SQLite real del POS. La validación hosted se hizo únicamente en
un proyecto Supabase **nuevo y desechable**.

## Resumen ejecutivo

- El interruptor `LMM_INVENTORY_SYNC_V8` **sigue APAGADO** (`0` por defecto).
  No se cambió configuración productiva ni se rotaron credenciales.
- V8.1 unificó la activación en **una sola condición**: flag `=1` **y**
  `config.cloud_restaurant_id` **y** `supabase_url` + `supabase_anon_key`.
  Si falta algo, el esquema V8 no se instala, el motor no arranca y se
  registran las razones (`flag_off`, `missing_cloud_restaurant_id`, etc.).
- Sync apagado = BD local intacta: sin columnas/triggers/colas V8 ni
  `device_id` persistente (UUID efímero en memoria).
- La migración SQL completa se **ejecutó en PostgreSQL aislado (PGlite 0.6.0,
  PostgreSQL 19 WASM, en memoria)** y pasó **14/14** comprobaciones, incluidas
  C-01..C-04, A-01..A-04, permisos/RLS y una carrera lógica de idempotencia.
- Además, la migración se aplicó y probó en un **proyecto Supabase hosted
  desechable** (PostgreSQL 17.6): **6/6** comprobaciones PASS con `auth.uid()`,
  `pgcrypto`, RLS y PostgREST reales, más **3/3** de concurrencia física con dos
  sesiones paralelas. Ver las secciones correspondientes más abajo.
- Se implementó la migración local segura (§17): análisis solo lectura,
  validación que exige decisión por producto, aplicación auditada que nunca
  sobrescribe `stock`, cuarentena de `sync_queue` sin borrar filas, conteos de
  errores y rollback antes del punto de no retorno.
- Suite focal: **6 suites / 137 pruebas PASS**. Suite completa local (excepto
  la que lee la BD real): **20 suites / 386 pruebas PASS**.
- **Conclusión:** el interruptor **NO es seguro de activar en producción todavía**.
  La validación técnica en Supabase aislado —incluida la concurrencia física—
  ya pasó. G0 (export solo lectura del destino) y G2 (ensayo de migración y
  rollback sobre copias) también pasaron; queda **G1: decisiones reales de
  saldo, IDs de restaurante y confirmación del propietario**. Ver
  `docs/V8_ACTIVATION_PLAN.md` y `docs/V8_G1_G2_REHEARSAL_RESULT.json`.

## V8.1: activación única

| Archivo | Cambio |
|---|---|
| `services/inventory-sync-v8/activation.js` | **Nuevo.** `evaluate(config, env)`, `state(db, env)`, `isEnabled(db, env)`. Única fuente de verdad; devuelve `enabled` + `reasons`. |
| `db.js` | `getV8ActivationState()` / `isV8Enabled()`; `applySyncSchema(db, { includeV8 })` instala V8 solo cuando corresponde; `initializeSchemaForStartup(db, env)` devuelve `v8Enabled`, `v8Reasons`, `v8SchemaApplied`. `isSyncEnabled()` queda reducido a detección de nube vinculada (legacy). |
| `sync-engine.js` | `startV8Engine()` usa la condición única; las exclusiones de stock absoluto (`pushQueue`, `applyRemoteRow`) también. Se eliminaron las comprobaciones directas del flag. |
| `routes/config.js` | `link-cloud` solo llama a `startV8Engine()` si `isV8Enabled(db._native)`; si no, lo registra en logs. |
| `services/inventory-sync-v8/index.js` | `isEnabled()` / `activationState()` delegan en `activation.js`. |
| `tests/v8-hardening.test.js` | Añadidos: flag apagado con nube vinculada, configuración incompleta (tres variantes), motor no arranca con configuración incompleta y `activation.evaluate()`. |

La configuración segura actual sigue siendo: **cloud sin vincular en producción
+ interruptor `0`**. No se modificó `.env`, `.env.runtime` ni plantillas con
secretos reales.

## Validación aislada del SQL (PGlite)

Scripts/ dependencias añadidos:

- `scripts/validate-v8-sql.js` (versionado) y devDependency
  `@electric-sql/pglite@0.6.0` en `package.json` / `package-lock.json`.
- Comando: `npm run validate:v8-sql` (o `node scripts/validate-v8-sql.js`).

Entorno: crea esquemas `auth`/`extensions`, roles `anon`/`authenticated`/
`service_role`, un stub de `auth.uid()` y stubs de `crypt`/`gen_salt`, ejecuta
el SQL completo y datos **sintéticos** (UUID efímeros). Nunca abre red ni la BD
real. Resultado real:

```
PostgreSQL aislado: PostgreSQL 19.0 (PGlite 0.6.0) ...
PASS migración SQL completa se ejecuta en PostgreSQL aislado
PASS configuración de vales en lmm.app_config (5 / 720 / 48)
PASS C-01: operación aplicada y estado final persistido por clave
PASS A-01: misma idempotency_key con otra operation_id deduplica sin reaplicar
PASS A-02: idempotency_key ausente y clave de sobre desconocida => PT422
PASS C-04: item_uuid de otro pedido se rechaza con PT409
PASS C-02: devolución independiente con source_operation_id
PASS C-03: cursor de eventos, ACK y resync_required tras purga
PASS A-04: vales limitados a 5 por dispositivo; el sexto se rechaza
PASS A-03: la gracia de 48 h es SOLO para vales offline
PASS A-04: device binding, scope y revocación se verifican en servidor
PASS Permisos: solo authenticated ejecuta RPC; migrate_open_order no expuesto
PASS Autenticación: anon no puede invocar la RPC (42501/PT401)
PASS Concurrencia lógica: dos cierres del mismo operation_id no duplican efecto

Resultado: 14/14 comprobaciones PASS
```

Hallazgos del propio arnés (aceptados y documentados, no defectos del SQL):

- `auth.uid()` y `crypt/gen_salt` son **stubs**: PGlite no trae `pgcrypto`.
  La autenticación por PIN real queda pendiente de Supabase aislado.
- `migrate_open_order` no tiene `EXECUTE` para `anon`/`authenticated` y las
  tablas `lmm` tienen RLS; se comprobó con `has_function_privilege` y
  `pg_class.relrowsecurity`.
- PGlite no ofrece sesiones paralelas reales: la "concurrencia" se validó como
  dos cierres consecutivos del mismo `operation_id` (deduplicación y un único
  efecto sobre el stock). La concurrencia física sigue pendiente.
- La prohibición a `anon` se manifiesta como `42501` (falta de privilegio de
  esquema/función) antes que como `PT401`; la prueba acepta ambos códigos.

## Migración local segura (§17)

Nuevos archivos:

- `services/inventory-sync-v8/migration.js`
- `scripts/v8-migrate-local.js`
- `tests/v8-migration.test.js`

Contrato implementado:

| Operación | Garantía verificable |
|---|---|
| `analyze(db, {remoteBalances, deviceReports})` | Solo lectura. Marca productos `discrepante` cuando los dispositivos no coinciden; lista `sync_queue` heredada pendiente y pedidos abiertos. `decision_required: true` para **todos** los productos. |
| `validate(db, {decisions, backupVerified:true})` | Falla con `falta_decision:<key>`, `decision_invalida`, `decision_producto_desconocido` o `backup_no_verificado`. Devuelve saldos aceptados en milésimas. No escribe. |
| `apply(...)` | Transacción única; **no escribe `inventory.stock`**. Escribe `stock_confirmed_milli` y `confirmed_version`, marca movimientos `legacy`, copia cada fila `sync_queue/inventory` a `v8_migration_queue_quarantine` y hace `synced=1` **sin borrarla**. Registra corrida, decisiones, conteos (`queue_rows_deleted: 0`) y cada valor previo en `v8_migration_changes`. |
| `rollback(db, {runId, remoteUntouched:true})` | Exige confirmar que no hay operaciones V8 aplicadas en remoto. Restaura columnas y `synced`, marca la cuarentena como `restored=1` y conserva **todas** las filas de auditoría. |

La CLI rechaza la ruta real del POS incluso con `--copy-confirmed` y exige
`--copy-confirmed`, `--backup-verified` y `--confirm` según el comando.
Comprobación real:

```
node scripts/v8-migrate-local.js analyze --db "C:\Users\agust\AppData\Roaming\la-mente-maestra\database.sqlite" --copy-confirmed
ERROR: RUTA REAL RECHAZADA: usa una copia en directorio temporal (...)
```

Ensayo sobre una copia descartable en `%TEMP%` (`analyze → validate → apply →
rollback`), resultados reales:

```
analyze  -> products: 1, discrepant: 0, pending_inventory_queue: 1, open_orders: 1
validate -> ok: true, errors: [], accepted: { "1": 10500 }
apply    -> runId 1, status applied, products 1, legacy_movements_marked 1,
            queue_quarantined 1, queue_rows_deleted 0
rollback -> runId 1, status rolled_back, inventory_columns_restored 2,
            queue_rows_restored 1, quarantine_rows_kept 1
```

Nota técnica: `better-sqlite3` está compilado para la ABI del Node de Electron;
cuando se ejecuta con Node 22 la CLI cae automáticamente al SQLite embebido de
Node (`node:sqlite`). Las pruebas ya usaban ese mismo mecanismo de respaldo.

## Pruebas ejecutadas

1. Focales (sin tocar la BD real):
   ```
   node scripts/run-tests.js tests/orders.test.js tests/orders-money-security.test.js tests/inventory-sync-v8.test.js tests/sync-security.test.js tests/v8-hardening.test.js tests/v8-migration.test.js --forceExit
   ```
   Resultado: **6 suites, 137 pruebas, todas PASS**.

2. Todas las suites locales excepto `tests/inspect-real-db.test.js` (lee la BD
   real del POS, excluida a propósito):
   ```
   node scripts/run-tests.js --testPathIgnorePatterns=tests/inspect-real-db.test.js --forceExit
   ```
   Resultado: **20 suites, 386 pruebas, todas PASS**.

3. Sintaxis:
   ```
   node --check db.js sync-engine.js server.js routes/config.js ... (17 archivos JS modificados)
   ```
   Resultado: **17/17 OK**.

El runner Electron emite `CreateFile: El sistema no puede encontrar el archivo
especificado. (0x2)` en stderr, pero Jest terminó con `PASS` y código 0.

## Cobertura de hallazgos

| Hallazgo | Cliente | SQL en PGlite |
|---|---|---|
| C-01 (estado final por clave) | reconciliación/outbox + `applySchema` | PASS |
| C-02 (devolución independiente) | `onOrderReturned` + `POST /orders/return` | PASS (`source_operation_id`) |
| C-03 (cursor/eventos) | `reconcile.js` + `pollEvents` | PASS (ACK + `resync_required`) |
| C-04 (ítem de otro pedido) | dedup `entity/seq` | PASS (`PT409`) |
| A-01 (idempotencia) | `outbox.enqueue` + `recoverOnBoot` | PASS (replay + dedup) |
| A-02 (clave ausente/sobre) | `classifyFailure` | PASS (`PT422`) |
| A-03 (gracia solo offline) | `vouchers.validateForOperation` | PASS |
| A-04 (scope/dispositivo/revocación) | `vouchers` + hook | PASS |

## Archivos cambiados: índice

- **Aplicación:** `db.js`, `sync-engine.js`, `server.js`, `routes/config.js`,
  `routes/orders.js`, `routes/inventory.js`.
- **Servicio V8:** `activation.js` (nuevo), `migration.js` (nuevo), `index.js`,
  `hook.js`, `schema.js`, `rpc.js`, `vouchers.js`, `README.md`.
- **Herramientas:** `scripts/validate-v8-sql.js` (nuevo),
  `scripts/v8-migrate-local.js` (nuevo), `package.json`, `package-lock.json`.
- **Pruebas:** `tests/v8-hardening.test.js` (ampliable), `tests/v8-migration.test.js`
  (nuevo), `tests/inventory-sync-v8.test.js`, `tests/orders.test.js`,
  `tests/orders-money-security.test.js`, `tests/sync-security.test.js`.
- **Documentación:** este informe, `services/inventory-sync-v8/README.md`.
- **Respaldo/revisión:** `scripts/backups/pre-fix-20261124/*.bak`. No hay
  repositorio Git, por lo que no hay `git diff`; los `.bak` permiten comparar.
- `node_modules` cambió al añadir PGlite como devDependency; `package.json` y
  `package-lock.json` quedaron actualizados de forma reproducible.

## Validación real en Supabase aislado (EJECUTADA, 2026-11-26)

Proyecto **nuevo y desechable**, nunca el productivo. Credenciales solo en
`.env.isolated` (ignorado por Git); no se copiaron a plantillas ni se imprimieron.
Comando ejecutado (se usa `node` directo porque `npm run ... -- <flag>` se lo
come):

```
node scripts/validate-v8-supabase.js all --confirm-isolated --reset-throwaway
```

`--reset-throwaway` está protegido por `--confirm-isolated` y solo elimina el
esquema `lmm` y las RPC `public.lmm_*` de **ese** proyecto para poder repetir la
prueba. El validador aplicó las **103 sentencias** del SQL (221 ms): 15 tablas,
31 funciones, 15 tablas con RLS. Resultado **6/6 PASS**:

```
  PASS conectividad: PostgreSQL 17.6
  PASS C-01: apply_operation devuelve applied — HTTP 200
  PASS A-01: replay por operation_id — HTTP 200
  PASS R-03: PT422 mapeado por PostgREST — HTTP 422 código PT422
  PASS C-03: get_events con ACK — HTTP 200
  PASS A-03/A-04: PIN bcrypt real + vale offline — HTTP 200
  PASS SE: anon no invoca RPC — HTTP 401
```

Evidencia: `docs/V8_SUPABASE_ISOLATED_RESULT.json` (sin credenciales; solo IDs
sintéticos). Tras los arreglos se repitieron PGlite (**14/14**) y la suite
completa local excepto la BD real (**20 suites / 386 pruebas PASS**).

### Hallazgos de plataforma corregidos en la migración SQL

1. **Propiedad de RPC públicas (DEC-05).** `ALTER FUNCTION ... OWNER TO
   lmm_owner` sobre `public.lmm_*` falla en Supabase con *permission denied for
   schema public* (ese rol no tiene `CREATE` en `public`). Ahora solo el schema
   `lmm` y sus funciones pasan a `lmm_owner`; las RPC públicas quedan con
   `postgres`, el fallback previsto. Sus privilegios no cambiaron: `EXECUTE`
   solo para `authenticated`.
2. **Trigger diferido en el COMMIT.** `lmm_apply_operation` devolvía HTTP 403
   `42501 permission denied for schema lmm`: la constraint trigger
   `operations_not_processing` se dispara al hacer COMMIT, cuando PostgREST ya
   restauró el rol `authenticated` (sin `USAGE` en `lmm`). Se declaró
   `lmm.tg_operations_not_processing()` como `SECURITY DEFINER` para que la
   comprobación final pueda leer `lmm.operations`.
3. **Claves `sb_secret_*`.** No son JWT: van en `apikey` **y** en
   `Authorization: Bearer`, sin mezclarse con la clave anon (si no, Auth admin
   responde `bad_jwt`). El validador ya las usa así.

## Concurrencia física en Supabase aislado (EJECUTADA, 2026-11-26)

`node scripts/validate-v8-supabase-concurrency.js --confirm-isolated` (también
`npm run validate:v8-concurrency`, pasando el flag con `node` directo). Dos
sesiones PostgREST reales con JWT de usuarios distintos, contra el mismo
proyecto desechable. Resultado **3/3 PASS**:

```
  PASS C-A: dos ventas paralelas no sobrevenden — HTTP 200/200, aplicado=5 de 5
  PASS C-B: stock final 0 y ningún movimiento negativo — stock=0, version=3
  PASS C-C: mismo operation_id en paralelo => 1 apply + 1 replay, 1 evento
```

Evidencia: `docs/V8_SUPABASE_CONCURRENCY_RESULT.json` (sin credenciales). El
primer intento de C-A devolvió un 401 transitorio de Auth al crear dos usuarios
en paralelo; el arnés reintenta una vez y el resultado es estable.

Recomendación: rotar las claves que quedaron visibles en el chat y actualizar
`.env.isolated` antes de reutilizar el proyecto desechable.

## Pendientes / recomendación

1. ~~Exportar el esquema remoto real de `sync_*` (R-01).~~ **Hecho en G0:** el
   destino indicado tiene 0 tablas `sync%`, por lo que no hay heredado que
   migrar. Sigue pendiente decidir el tratamiento del cliente móvil (R-02) y
   actualizar la SQLite, que aún apunta al proyecto desechable.
2. Cerrar G1: el propietario debe confirmar los 10 saldos propuestos en
   `docs/V8_BALANCE_DECISIONS.json`, poner `owner_confirmed=true`, completar
   `restaurant_id` / `cloud_restaurant_id` y lograr 8/8 en
   `verify-v8-migration-inputs.js`. El backup verificado ya existe en
   `backups/g1-20261126/database.sqlite` (ignorado por Git).
3. ~~Hacer el ensayo completo de migración y rollback sobre copias.~~ **Hecho en
   G2 con confirmación simulada:** 130 cuarentenas, 0 filas borradas, rollback
   limpio. Se corrigió un bug de triggers legacy que inflaban `sync_queue`.
4. Solo entonces activar por etapas: staging → un restaurante piloto (todos sus
   dispositivos a la vez) → resto. Inventario no admite convivencia de clientes
   V7 y V8.
5. Mantener `LMM_INVENTORY_SYNC_V8=0` en producción hasta completar los puntos
   anteriores. No se borraron ni reescribieron datos del usuario.

**No se encendió ningún flag de producción en esta sesión.** "Activar todo"
requiere decisiones del propietario y acceso a producción; se detuvo aquí por
seguridad de datos.

**Estado del interruptor: APAGADO. No seguro para producción aún.**
