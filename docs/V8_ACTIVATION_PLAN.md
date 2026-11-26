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

## Compuertas

### G0 — Esquema `sync_*` de producción (solo lectura)

1. Crear `.env.production-readonly` (ignorado por Git) con un `DATABASE_URL` de
   **usuario solo lectura**. Nunca usar el usuario maestro si hay uno limitado.
2. Ejecutar:
   ```
   node scripts/export-production-sync-schema.js --confirm-readonly
   ```
   La sesión se fuerza a `TRANSACTION READ ONLY`; solo consulta catálogos y
   `count(*)`. Salidas: `docs/PRODUCTION_SYNC_SCHEMA.sql` y
   `docs/PRODUCTION_SYNC_SCHEMA.json` (sin credenciales).
3. Revisar conjuntamente R-01 (tablas/columnas/fila(s)) y R-02 (cliente móvil:
   qué dispositivos siguen escribiendo en `sync_*`).

**Bloqueante:** todavía no hay credenciales de solo lectura de producción.

### G1 — Backup verificado y decisiones de saldo

1. Hacer una **copia** de la SQLite del POS (nunca migrar la original) y
   calcular su `sha256`.
2. Copiar `docs/V8_BALANCE_DECISIONS.example.json` a
   `docs/V8_BALANCE_DECISIONS.json` y rellenar **una fila por producto** con
   `local_stock`, `remote_stock`, `decided_initial_stock`, `decision` y
   `reason`. La migración nunca sobrescribe `stock` sin una decisión explícita.
3. Ejecutar:
   ```
   node scripts/verify-v8-migration-inputs.js docs/V8_BALANCE_DECISIONS.json
   ```
   Comprueba que la ruta no es la BD real, que el `sha256` coincide, que
   `PRAGMA integrity_check` pasa **sobre una copia temporal**, y que cada
   producto tiene decisión. Resultado: `docs/V8_MIGRATION_INPUTS_RESULT.json`.

**Bloqueante:** decisiones del propietario y backup verificado.

### G2 — Ensayo de migración sobre copias

Con la copia de G1, ejecutar el flujo completo sobre **copias descartables**:

```
node scripts/v8-migrate-local.js analyze --db <copia.sqlite> --remote <json> --out <json>
node scripts/v8-migrate-local.js validate --db <copia.sqlite> --plan <json>
node scripts/v8-migrate-local.js apply --db <copia.sqlite> --plan <json> --copy-confirmed --run <id> --remote-untouched --confirm
node scripts/v8-migrate-local.js rollback --db <copia.sqlite> --copy-confirmed --run <id> --remote-untouched --confirm
```

Criterio de paso: cero filas borradas, `sync_queue` en cuarentena, auditoría
completa y rollback restore el estado previo. La CLI rechaza rutas reales.

### G3 — Staging

1. Aplicar la migración SQL al proyecto Supabase de staging (el desechable ya
   validado sirve como plantilla, pero staging debe tener el esquema `sync_*`
   exportado en G0).
2. Arrancar la app sobre una **copia** de SQLite con
   `LMM_INVENTORY_SYNC_V8=1`, `cloud_restaurant_id`, `supabase_url` y
   `supabase_anon_key` apuntando a staging.
3. Repetir C-01/A-01/C-03/A-03 con datos sintéticos y verificar que el flag
   aparece como `enabled` en los logs y que la BD local no se altera al
   apagarlo.

### G4 — Piloto y resto (requiere autorización explícita)

1. Elegir **un restaurante piloto** y migrar **todos** sus dispositivos a la vez.
   Inventario no admite convivencia de clientes V7 y V8.
2. Observar 24–48 h: cola de eventos sin crecimiento anómalo, cero
   `UNAUTHORIZED_PRICE`, vales offline dentro del límite.
3. Solo después extender al resto por restaurantes, nunca a medias.

**En este momento no se ha ejecutado G0, G1, G2 ni G3 en producción.** El flag
sigue en `0`; no se ha conectado al Supabase productivo ni a la SQLite real del
POS para escribir.
