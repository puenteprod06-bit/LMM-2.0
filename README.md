# La Mente Maestra

Sistema POS de gestión gastronómica para restaurantes. Aplicación de escritorio
(Electron) con servidor Express local, SQLite y sincronización opcional con
Supabase.

## Estado actual

- Versión: **2.3.2**.
- POS operativo con venta piloto sincronizada mediante el motor de inventario
  **V8**, en observación (24–48 h).
- `LMM_INVENTORY_SYNC_V8=1` solo en el `.env` local de la instalación piloto.
  La plantilla `.env.runtime.example` permanece en `0` y no debe modificarse.
- Los cuatro reportes del POS (reemplazo en comanda, dividir cuenta, separar por
  persona y cuenta unida al convertir para llevar) quedaron corregidos y
  validados; evidencia en `docs/POS_FOUR_BUGS_VALIDATION.json`.
- Los productos del POS no muestran emojis: el campo `emoji` solo acepta nombres
  de iconos Material Symbols.

## Requisitos

- Windows con Node.js y npm.
- Electron 33 (Node 20 / ABI 130).
- Módulos nativos compilados para Electron: `better-sqlite3`, `bcrypt`.

## Instalación y arranque

```powershell
npm install
npm run rebuild
npm start
```

La app levanta el servidor en `http://localhost:3000/`.

> `npm start` es un proceso de larga duración: en shells con timeout puede
> recibir `SIGTERM`. Para dejarlo corriendo desacoplado, iniciar Electron con
> `Start-Process`.

## Configuración

Las credenciales **nunca** se versionan. Archivos ignorados por Git:

| Archivo | Uso |
|---|---|
| `.env` | Configuración local de desarrollo/producción (leída por `main.js`). |
| `.env.runtime` | Configuración que el instalador copia como `.env`. |
| `.env.production-readonly`, `.env.isolated` | Solo lectura / pruebas aisladas. |

Plantilla sin secretos: `.env.runtime.example`.

Variables principales: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, campos Firebase,
`PORT` y `LMM_INVENTORY_SYNC_V8`. El motor V8 solo arranca si están activadas
**las tres condiciones**: flag en `1`, `cloud_restaurant_id` configurado y
credenciales Supabase completas. Detalle en
`services/inventory-sync-v8/README.md`.

## Comandos útiles

| Comando | Descripción |
|---|---|
| `npm start` | Inicia la app Electron. |
| `npm test` | Suite completa (23 suites / 399 tests). |
| `npm run test:watch` | Tests en modo watch. |
| `npm run rebuild` | Recompila módulos nativos para Electron. |
| `npm run minify` | Minifica CSS y JS de `public/`. |
| `npm run dist` | Reconstruye y genera instalador Windows. |
| `npm run validate:v8-sql` | Valida el SQL V8 en PGlite, sin red ni credenciales. |
| `npm run validate:v8-migration` | Pruebas de migración V8. |
| `npm run verify:v8-inputs` | Verifica entradas de migración. |
| `npm run build:v8-input` | Genera entradas de migración. |
| `npm run migrate:v8-local` | CLI de migración local sobre una **copia**. |

> Usar siempre `npm test` o `node scripts/run-tests.js ...`. Ejecutar `npx jest`
> directamente falla por el ABI de Electron (`NODE_MODULE_VERSION`). En
> PowerShell, separar comandos con `;` (no `&&`).

## Estructura

```text
main.js                  entrada Electron; carga dotenv antes de server.js
server.js                Express + Socket.IO
db.js                    esquema SQLite, migraciones aditivas, flags de sync
routes/                  API REST (menú, inventario, pedidos, mesas, caja…)
public/                  frontend del POS (JS/CSS minificados)
services/inventory-sync-v8/  motor V8: activación, outbox, reconcile, RPC, hooks
sync-engine.js           sincronización legacy + arranque del motor V8
scripts/                 runners de tests, validaciones y migraciones
seeds/                   datos de ejemplo
docs/                    reportes de repair, V8 y validaciones del POS
tests/                   suites Jest ejecutadas con el runtime de Electron
```

La base de datos real vive en
`%APPDATA%\la-mente-maestra\database.sqlite`. No borrarla ni reaplicar la
migración V8 sobre una instalación ya migrada. Los backups verificados están en
`backups/`.

## Notas de operación

- `http://localhost:3000/` responde 200; `/api/health` no existe (404) y no
  indica fallo del servidor.
- No propagar el flag V8 a otras instalaciones durante la observación del
  piloto.
- No commitear `.env`, `.sqlite`, `.zip`, logs ni credenciales.
- Antes de cualquier cambio de esquema, verificar backup y usar siempre una
  copia de la base de datos.

## Documentación adicional

- `docs/V8_ACTIVATION_PLAN.md` — plan y estado del piloto.
- `docs/V8_BALANCE_DECISIONS.json` — saldos iniciales confirmados.
- `docs/V8_PRODUCTION_PILOT_TEST_SALE_RESULT.json` — venta piloto real.
- `docs/POS_FOUR_BUGS_VALIDATION.json` — validación de los cuatro bugs del POS.
- `docs/REPAIR_REPORT.md` — informe de reparación.
- `services/inventory-sync-v8/README.md` — arquitectura y políticas del motor V8.
