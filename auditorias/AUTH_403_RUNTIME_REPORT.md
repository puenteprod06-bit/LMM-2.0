# AUTH_403_RUNTIME_REPORT.md
# Informe de diagnóstico en tiempo de ejecución — Error 403 al guardar mesas

**Proyecto:** La Mente Maestra (POS) — Node.js, Express, Electron, SQLite  
**Fecha:** 18/11/2026  
**Endpoint:** `POST /api/tables/save`  
**Estado:** CAUSA RAÍZ IDENTIFICADA Y REPRODUCIDA

---

## 1. Ruta de la base de datos activa

La aplicación Electron utiliza una base de datos SQLite ubicada en el directorio de datos de usuario del sistema operativo:

| Entorno | Ruta de la base de datos |
|---|---|
| Electron (Windows, producción) | `C:\Users\agust\AppData\Roaming\la-mente-maestra\database.sqlite` |
| Tests (Jest) | SQLite en memoria (`:memory:`) — aislado, no toca producción |

**Confirmado:** La base de datos de Electron existe y es la única utilizada por el servidor Express en tiempo de ejecución (mismo archivo que abre `db.js` mediante `better-sqlite3`).

No existe más de una base de datos activa. Los tests usan una instancia en memoria separada, idéntica en esquema pero sin persistencia.

---

## 2. Estado de sesión después de cada login

### 2.1. Estado real en la base de datos de Electron (inspección de solo lectura)

La inspección de `local_session` (id = 1) en la DB real de Electron arrojó:

| Campo | Valor (anonimizado) |
|---|---|
| `role` | `admin` |
| `typeof role` | `string` |
| `is_client` | `1` |
| `typeof is_client` | `number` |
| `name` | presente |
| `restaurant` | presente |
| `last_login` | `2026-11-18T07:25:04.074Z` |
| `app_version` | `2.3.2` |
| `device_id` | presente |

**Tipo de login deducido:** empleado / staff (`/api/login/staff`)  
**Evaluación de `requireOwner`:** `role === owner` = `false`; `is_client === 1` = `true` → **RECHAZADO (403 FORBIDDEN)**

### 2.2. Estado tras cada paso del flujo reproducido (tests en memoria)

| Paso | Acción | `role` | `is_client` | `POST /api/tables/save` |
|---|---|---|---|---|
| A | Sin sesión (cerrado) | — | — | **401** `NO_SESSION` |
| B | Login propietario | `owner` | `0` | **200** `success: true` |
| C | Login empleado (sobrescribe sesión) | `admin` | `1` | **403** `FORBIDDEN` |
| D | Login propietario (sobrescribe sesión) | `owner` | `0` | **200** `success: true` |

**Observación clave:** Cada login llama a `saveLocalSession()`, que ejecuta `INSERT OR REPLACE` sobre la única fila (`id = 1`) de `local_session`. El último login **sobrescribe completamente** la sesión anterior. Si un empleado inicia sesión después del propietario, la sesión de propietario se pierde y el propietario recibe `403` hasta que vuelva a iniciar sesión como propietario.

---

## 3. Estado de sesión inmediatamente antes de guardar

**En la DB real de Electron (estado actual):**

```
role      = 'admin'     (no es 'owner')
is_client = 1           (es empleado/staff)
```

Esto significa que, en el momento de intentar guardar mesas, el servidor encuentra una sesión de empleado y `requireOwner` rechaza con `403`.

---

## 4. Respuestas HTTP obtenidas

| Escenario | Código | Cuerpo JSON |
|---|---|---|
| Sin sesión activa | `401` | `{ success: false, error: 'Sesión requerida', code: 'NO_SESSION' }` |
| Sesión de propietario | `200` | `{ success: true }` |
| Sesión de empleado (`role: 'admin'`, `is_client: 1`) | `403` | `{ success: false, error: 'Se requieren permisos de propietario', code: 'FORBIDDEN' }` |
| Sesión de empleado con `role: 'owner'` pero `is_client: 1` | `403` | `{ success: false, error: 'Se requieren permisos de propietario', code: 'FORBIDDEN' }` |
| Cuerpo manipulado con `role: 'owner'` desde el cliente sobre sesión de empleado | `403` | `{ success: false, error: 'Se requieren permisos de propietario', code: 'FORBIDDEN' }` |

**No hay elevación de privilegios posible desde el cuerpo de la solicitud**, ya que el backend ignora cualquier campo `role`/`is_client` enviado por el frontend y lee exclusivamente de `local_session`.

---

## 5. Causa raíz reproducida

**CONFIRMADA.** El `403` se debe a que la sesión almacenada en `local_session` de la base de datos de Electron corresponde a un **empleado / staff**, no a un propietario:

- `role = 'admin'` (debe ser `'owner'`)
- `is_client = 1` (debe ser `0`)

El middleware `requireOwner` funciona correctamente. El problema no está en el código de autorización, sino en **qué sesión está activa en el dispositivo**.

**Secuencia que produce el error:**
1. El usuario (o alguien con acceso al equipo) inició sesión como empleado mediante `/api/login/staff`.
2. `saveLocalSession()` guardó `role='admin'`, `is_client=1` en la única fila de `local_session`.
3. Al intentar guardar mesas, `requireOwner` rechaza porque la sesión no es de propietario.

**Secuencia que recupera el funcionamiento:**
1. Cerrar sesión (`/api/auth/logout` → `clearLocalSession()`).
2. Iniciar sesión como propietario mediante `/api/login/owner`.
3. `saveLocalSession()` guarda `role='owner'`, `is_client=0`.
4. Guardar mesas → `200`.

---

## 6. Diferencias entre tests y ejecución Electron

| Aspecto | Tests (Jest) | Ejecución Electron |
|---|---|---|
| Base de datos | SQLite en memoria (`:memory:`) | Archivo en `AppData\Roaming\la-mente-maestra\database.sqlite` |
| Sesión inicial | Inyectada por `buildTestApp` (owner por defecto) | Creada por el primer login exitoso |
| Persistencia | Se pierde al terminar el test | Persiste entre reinicios de la app |
| `requireOwner` | Misma implementación, pasa | Misma implementación, rechaza sesión de empleado |
| Resultado con sesión owner | `200` | `200` |
| Resultado con sesión empleado | `403` | `403` (estado actual de producción) |

Los tests confirman que el backend autoriza correctamente. La diferencia es que en producción la sesión activa es de empleado, mientras que en los tests se inyecta deliberadamente una sesión de propietario.

---

## 7. Revisión de sobrescrituras de `local_session`

Todos los lugares del código de producción que escriben en `local_session`:

| Archivo:Línea | Operación | ¿Cambia rol / is_client? | Contexto |
|---|---|---|---|
| `db.js:551` | `INSERT OR REPLACE` | **SÍ** (establece rol e is_client) | `saveLocalSession()`, llamado en cada login (owner y staff) |
| `db.js:578` | `DELETE` | N/A (borra toda la fila) | `getLocalSession()`, limpia si cambió major version de app |
| `db.js:592` | `DELETE` | N/A (borra toda la fila) | `clearLocalSession()`, logout |
| `db.js:601` | `UPDATE last_license` | NO | `updateLicenseTimestamp()`, solo timestamp |
| `db.js:739` | `INSERT OR IGNORE` | NO | `getOrCreateDeviceId()`, solo si no existe fila |
| `db.js:740` | `UPDATE device_id` | NO | `getOrCreateDeviceId()`, solo device_id |
| `db.js:819` | `UPDATE cloud_initial_backfill_done` | NO | Flag de sincronización con la nube |

**Conclusión:** El único proceso que cambia el rol después del login es el propio **siguiente login** (mediante `saveLocalSession` con `INSERT OR REPLACE`). No hay ningún proceso automático ni middleware que modifique el rol de forma silenciosa. El último login gana.

---

## 8. Recomendación de corrección

**No se requiere modificación de código de autorización.** El middleware `requireOwner` y el modelo de sesión son correctos y seguros. Las restricciones se cumplen:

- ✅ No se eliminó ningún middleware.
- ✅ No se permite que cualquier usuario guarde mesas.
- ✅ No se confía en el rol de `localStorage`.
- ✅ No se acepta el rol desde el cuerpo de la solicitud.
- ✅ No se modificó la base de datos de producción.
- ✅ No se cambió el modelo de autenticación global.

**Acción correctiva requerida (operativa, no de código):**

1. En el equipo del usuario, cerrar la sesión actual (`Cerrar Sesión` en la app).
2. Iniciar sesión nuevamente como **propietario** mediante el formulario de login de propietario (`/api/login/owner`).
3. Verificar que el sidebar muestre "Propietario" y que guardar mesas devuelva `200`.

**Mejoras sugeridas para evitar confusión futura (opcionales, no bloqueantes):**

- Mostrar en la UI un aviso claro cuando la sesión activa no es de propietario y el usuario intenta acceder a funciones de administración.
- Al iniciar sesión como empleado, advertir que esto desactiva las funciones de propietario en ese dispositivo hasta que el propietario vuelva a iniciar sesión.
- Considerar permitir sesiones concurrentes o distinguir mejor el contexto de propietario vs empleado en el mismo equipo (requiere cambios de arquitectura, fuera del alcance de esta reparación).

---

## 9. Pruebas ejecutadas y resultados

Suite completa: **11 suites, 195 tests, todos pasan** (sin regresiones).

Tests nuevos de diagnóstico y reproducción:
- `tests/inspect-real-db.test.js` — inspección de solo lectura de la DB real de Electron.
- `tests/flow-reproduction.test.js` — reproduce el flujo owner → empleado → owner.
- `tests/tables-save-auth.test.js` — cobertura de los 6 escenarios obligatorios de autorización.

---

## Estado final

**El problema está REPRODUCIDO y su causa raíz identificada:** la sesión activa en Electron pertenece a un empleado (`role: 'admin'`, `is_client: 1`), no a un propietario. El `403` es la respuesta correcta del sistema. No se declara el código como "corregido" porque no hay defecto de autorización que corregir; se requiere que el usuario inicie sesión como propietario para recuperar la capacidad de guardar mesas.
