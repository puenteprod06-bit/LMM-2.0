# Plan de activación por etapas V8 / V8.1

Estado: **flag `LMM_INVENTORY_SYNC_V8=0`**. Este documento describe las compuertas
que deben cerrarse antes de encenderlo. No sustituye la autorización explícita
del propietario en cada etapa.

## Ya verificado (no se repite)

| Prueba | Resultado |
|---|---|
| SQL en PGlite (sin red) | 14/14 |
| Suite local (sin BD real) | 20 suites / 386 pruebas |
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

La SQLite del POS todavía apunta al proyecto desechable
(`vzwpbviq…`, `cloud_restaurant_id=27990c98-…`). Antes de G3/G4 debe apuntar al
proyecto indicado y al `cloud_restaurant_id` correcto.

### G1 — Backup verificado y decisiones de saldo — ⚠️ PREPARADO, BLOQUEANTE

1. Se hizo una **copia** de la SQLite del POS en
   `backups/g1-20261126/database.sqlite` (ignorada por Git), `sha256`
   `aebd7dd3…` e `integrity_check=ok`. La original no se abrió para escribir.
2. Se generó `docs/V8_BALANCE_DECISIONS.json` con **10 propuestas** de saldo.
   Todavía no son decisiones: `owner_confirmed=false`, los `reason` dicen
   `PROPUESTA`, y faltan `restaurant_id` / `cloud_restaurant_id`.
3. Verificación actual:
   ```
   node scripts/verify-v8-migration-inputs.js docs/V8_BALANCE_DECISIONS.json
   ```
   Resultado `docs/V8_MIGRATION_INPUTS_RESULT.json`: **5 PASS / 3 FAIL**.
   Los fallos son exactamente las compuertas que faltan.

**Para cerrar G1 el propietario debe:**

- revisar los 10 `decided_initial_stock` (el destino no tiene saldo remoto: las
  propuestas conservan el stock local; Papas/Fideos/Dulce parecen gramos);
- poner `owner_confirmed=true` y quitar los textos `PROPUESTA` de `reason`;
- completar `restaurant_id` y `cloud_restaurant_id`;
- repetir el comando de verificación hasta 8/8;
- generar el input de la CLI:
  ```
  node scripts/build-v8-migration-input.js --out docs/V8_MIGRATION_CLI_INPUT.json
  ```

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
   por defecto de la propia migración; ningún dato del POS ni usuario sembrado.
   Evidencia: `docs/V8_PRODUCTION_SCHEMA_RESULT.json`.
2. `LMM_INVENTORY_SYNC_V8` **sigue en 0**. No se tocó la SQLite real del POS.
3. **Smoke sintético en staging: 6/6 PASS** el 2026-11-27 con
   `node scripts/validate-v8-supabase.js all --confirm-isolated
   --reset-throwaway --out docs/V8_STAGING_SMOKE_RESULT.json`: conectividad,
   C-01, A-01, R-03, C-03, A-03/A-04 y rechazo `anon`. El proyecto desechable
   queda con datos sintéticos creados por el propio validador; nada de producción.
4. Pendiente: verificar que la app apunte al proyecto correcto y, sobre una
   **copia** de SQLite en staging, probar C-01/A-01/C-03/A-03 con el flag en 1.

**Bloqueante:** G1 real (saldos/IDs) y la prueba de la app sobre copia con flag
en 1. No se ha activado V8 en producción.

### G4 — Piloto y resto (requiere autorización explícita)

1. Elegir **un restaurante piloto** y migrar **todos** sus dispositivos a la vez.
   Inventario no admite convivencia de clientes V7 y V8.
2. Observar 24–48 h: cola de eventos sin crecimiento anómalo, cero
   `UNAUTHORIZED_PRICE`, vales offline dentro del límite.
3. Solo después extender al resto por restaurantes, nunca a medias.

**En este momento G0, G2, el esquema SQL de G3 en producción y el smoke
sintético en staging están listos; G1 sigue bloqueante y G4 no se ha
ejecutado.** El flag sigue en `0`; no se ha conectado a la SQLite real del POS
para escribir y no se activó V8 en producción. Los únicos datos sembrados son
sintéticos y están en el proyecto desechable.
