# Plan de activación por etapas V8 / V8.1

Estado: **piloto V8 encendido solo en la instalación local** (`LMM_INVENTORY_SYNC_V8=1`
en `.env`, ignorado por Git). El resto de instalaciones y la plantilla
`.env.runtime.example` siguen con el flag apagado. Este documento registra las
compuertas cerradas y lo que aún falta para extender el piloto.

## Ya verificado (no se repite)

| Prueba | Resultado |
|---|---|
| SQL en PGlite (sin red) | 14/14 |
| Suite local (sin BD real) | 21 suites / 390 pruebas |
| Supabase hosted desechable | 6/6 |
| Concurrencia física (2 sesiones PostgREST) | 3/3 |
| Migración local con triggers legacy reales | 6/6 pruebas |
| Ensayo G1/G2 sobre copias | ver `docs/V8_G1_G2_REHEARSAL_RESULT.json` |

## Compuertas

### G0 — Esquema `sync_*` del destino (solo lectura) — ✅ EJECUTADO

1. Se creó `.env.production-readonly` (ignorado por Git) y se conectó por el
   pooler con la sesión forzada a `TRANSACTION READ ONLY`.
2. Se ejecutó:
   ```
   node scripts/export-production-sync-schema.js --confirm-readonly
   ```
3. Resultado: **0 tablas `sync%`**, 0 tablas de usuario en `public`. R-01 queda
   cerrado: no hay esquema heredado que migrar. Salidas:
   `docs/PRODUCTION_SYNC_SCHEMA.sql` y `docs/PRODUCTION_SYNC_SCHEMA.json`.

La SQLite del POS fue actualizada al proyecto productivo
(`fxkxfid…`) y al `cloud_restaurant_id` del piloto
`96fbd1a2-1e33-4940-82c3-e44c30eaed97`. Evidencia:
`docs/V8_PRODUCTION_PILOT_LOCAL_RESULT.json`.

### G1 — Backup verificado y decisiones de saldo — ✅ CERRADO

1. Copia verificada: `backups/g1-20261126/database.sqlite` (ignorada por Git),
   `sha256 aebd7dd3…`, `integrity_check=ok`.
2. El propietario confirmó usar los **stocks locales** como saldo inicial y
   autorizó generar los UUID del piloto. `docs/V8_BALANCE_DECISIONS.json` quedó
   con `owner_confirmed=true`, 10 razones confirmadas (sin `PROPUESTA`) e IDs:
   `restaurant_id=48631601-eee3-423f-9ccc-e258dfa83bca`,
   `cloud_restaurant_id=96fbd1a2-1e33-4940-82c3-e44c30eaed97`
   (`docs/V8_PILOT_IDS.json`).
3. `node scripts/verify-v8-migration-inputs.js docs/V8_BALANCE_DECISIONS.json`
   → **8/8 PASS** (`docs/V8_MIGRATION_INPUTS_RESULT.json`).

Input generado con `node scripts/build-v8-migration-input.js --out
docs/V8_MIGRATION_CLI_INPUT.json`. Los productos Papas/Fideos/Dulce conservan
sus valores en gramos, tal como fueron confirmados.

### G2 — Ensayo de migración sobre copias — ✅ EJECUTADO (confirmación simulada)

Con una confirmación **simulada** (nunca tus decisiones) sobre copias
descartables:

```
node scripts/v8-migrate-local.js analyze  --db <copia.sqlite> --copy-confirmed --input <input.json>
node scripts/v8-migrate-local.js validate --db <copia.sqlite> --copy-confirmed --backup-verified --input <input.json>
node scripts/v8-migrate-local.js apply    --db <copia.sqlite> --copy-confirmed --backup-verified --confirm --input <input.json>
node scripts/v8-migrate-local.js rollback --db <copia.sqlite> --copy-confirmed --confirm --remote-untouched --run <id>
```

Resultado:

- `analyze`: 10 productos, 130 filas `inventory` pendientes, 658 de otras
  tablas, 47 órdenes abiertas, 168 movimientos legacy.
- `apply`: 10 saldos escritos en `stock_confirmed_milli`, **130 cuarentenas**,
  **0 filas borradas**, `sync_queue` 794 → 794.
- `rollback`: 20 columnas restauradas, 130 filas des-cuarentenadas, auditoría
  conservada, `sync_queue` 794 → 794, todos los saldos confirmados en `null`.

Se encontró y corrigió un bug real: los triggers legacy insertaban filas nuevas
en `sync_queue` durante `apply`/`rollback`. Ahora ambas funciones silencian
`_sync_flag.applying_remote` dentro de la transacción y verifican que el total
de la cola no cambie. Evidencia: `docs/V8_G1_G2_REHEARSAL_RESULT.json`.

Tras la confirmación real se aplicó la migración a la SQLite del POS con
`node scripts/activate-v8-pilot-local.js --confirm-production-activation`:
`run_id=1`, 10 productos, 130 cuarentenas, **0 filas borradas**, `sync_queue`
794 → 794 (`docs/V8_PRODUCTION_PILOT_LOCAL_RESULT.json`).

### G3 — Staging y esquema productivo

0. **Staging desechable (`vzwpbviq…`)**: se aplicó el esquema (15 tablas, 31
   funciones, 15 tablas con RLS; `docs/V8_STAGING_SCHEMA_RESULT.json`) y
   posteriormente se **limpió** el esquema `lmm` y las RPC `public.lmm_*` a
   petición del propietario (`docs/V8_STAGING_CLEAN_RESULT.json`). El proyecto
   Supabase sigue existiendo; solo se borró ese esquema sintético. La evidencia
   original 6/6 se conserva en `docs/V8_SUPABASE_ISOLATED_RESULT.json`.
1. **Producción (`fxkxfid…`)**: el propietario autorizó aplicar **solo el SQL**.
   Se ejecutó `node scripts/apply-v8-production.js --confirm-production`.
   Resultado: **15 tablas, 31 funciones, RLS en `app_config`**. Verificación en
   sesión `TRANSACTION READ ONLY`: 15 tablas, solo `app_config` con 5 valores
   por defecto de la propia migración; en ese momento no había datos del POS ni
   usuarios sembrados (el piloto se aprovisionó después, ver punto 4).
   Evidencia: `docs/V8_PRODUCTION_SCHEMA_RESULT.json`.
2. La SQLite del POS quedó apuntando a producción y al piloto; ver G1/G2.
3. **Smoke sintético en staging: 6/6 PASS** el 2026-11-27 con
   `node scripts/validate-v8-supabase.js all --confirm-isolated
   --reset-throwaway --out docs/V8_STAGING_SMOKE_RESULT.json`: conectividad,
   C-01, A-01, R-03, C-03, A-03/A-04 y rechazo `anon`. El proyecto desechable
   queda con datos sintéticos creados por el propio validador; nada de producción.
4. **Identidad y catálogo del piloto aprovisionados en producción**: se crearon
   usuario owner, usuario dispositivo, membresía, dispositivo y los 10 productos
   con los saldos confirmados. Las RPC exigen `authenticated`, por lo que
   `services/inventory-sync-v8/rpc.js` ahora inicia/renueva sesión con
   `SUPABASE_AUTH_EMAIL`/`SUPABASE_AUTH_PASSWORD` desde `.env`. Verificación real:
   login Auth + `lmm_get_snapshot` con 10 productos y `lmm_get_events` OK.
   El aprovisionador es idempotente: en la corrida final ya existían las filas,
   por eso `created.*` es `false` y `inventory_rows=0` en la evidencia.
   Evidencia: `docs/V8_PRODUCTION_PILOT_AUTH_RESULT.json`.

**Sin bloqueantes para el piloto.** No se ha extendido V8 a otros restaurantes.

### G4 — Piloto y resto (requiere autorización explícita)

1. **Piloto encendido** el 2026-11-27 en esta instalación con
   `node scripts/activate-v8-pilot-flag.js --confirm-production-activation`.
   Antes: `flag_off`. Después: sin razones de bloqueo. `LMM_INVENTORY_SYNC_V8=1`
   solo en `.env` local; `.env.runtime.example` sigue en `0`.
   Evidencia: `docs/V8_PRODUCTION_PILOT_ACTIVATION_RESULT.json`.
2. Hay **un solo dispositivo** en el piloto (`bc6022ef…`), por lo que no hay
   convivencia de clientes V7 y V8 dentro del restaurante piloto.
3. **Venta real de prueba sincronizada** el 2026-11-27: 1 × Agua mineral 500 ml
   (orden 112). Stock confirmado local 40 → 39 y remoto 40 → 39, operación V8
   `sale` aplicada con evento `operation.applied` (seq 1), outbox `applied`,
   movimiento local `confirmed` y sin `dead_letter`/`UNAUTHORIZED_PRICE`.
   Antes de la venta se corrigieron tres fallos de arranque/puesta en marcha:
   carga de `.env` antes de `server.js`, transporte `ws` para Node 20 en el
   cliente Supabase y lectura de la BD activa desde `isEnabled()`. El intent
   llevaba la clave local `invId`, rechazada por la nube; ahora el payload es
   canónico y el mapeo local queda fuera de la operación.
   Evidencia: `docs/V8_PRODUCTION_PILOT_TEST_SALE_RESULT.json`.
4. Pendiente: observar 24–48 h (eventos sin crecimiento anómalo, cero
   `UNAUTHORIZED_PRICE`, vales offline dentro del límite).
5. Solo después extender al resto por restaurantes, nunca a medias.

**Estado final de esta etapa:** G0, G1, G2, G3 y el encendido del piloto G4 están
cerrados. La SQLite real del POS fue migrada y configurada contra `fxkxfid…`.
El flag V8 está en `1` únicamente en esta instalación piloto; el resto sigue
apagado. Los datos sintéticos siguen confinados al proyecto desechable.
Queda únicamente el periodo de observación de 24–48 h del piloto.
