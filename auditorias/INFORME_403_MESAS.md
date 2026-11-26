# Informe de diagnóstico y reparación — Error 403 al guardar mesas
**Proyecto:** La Mente Maestra (POS) — Node.js, Express, Electron, SQLite  
**Fecha:** 18/11/2026  
**Endpoint afectado:** `POST http://localhost:3000/api/tables/save`  
**Síntoma reportado:** `403 (Forbidden)` al guardar mesas desde `public/pos-mesas.js`

---

## 1. Causa raíz

**No existe un defecto de autorización en el backend.** El `403` es el **comportamiento correcto y esperado** del middleware `requireOwner` cuando la sesión activa almacenada en SQLite (`local_session`, `id = 1`) no corresponde a un propietario.

### Flujo de autorización verificado

`POST /api/tables/save` (`routes/tables.js:30`) está protegido exclusivamente por `requireOwner` (`middleware/requireAuth.js:29`):

```js
function requireOwner(db) {
  return function (req, res, next) {
    const session = db._native.prepare('SELECT * FROM local_session WHERE id = 1').get();
    if (!session) {
      return res.status(401).json({ success: false, error: 'Sesión requerida', code: 'NO_SESSION' });
    }
    if (session.role !== 'owner' || session.is_client === 1) {
      return res.status(403).json({ success: false, error: 'Se requieren permisos de propietario', code: 'FORBIDDEN' });
    }
    req.session = session;
    next();
  };
}
```

- `role !== 'owner'` → rechaza cualquier rol que no sea exactamente `'owner'`.
- `is_client === 1` → rechaza sesiones de empleado/invitado aunque el rol diga `'owner'` (defensa en profundidad: un empleado que accede por PIN queda marcado `is_client = 1`).

### Cómo se crea la sesión (auth.js)

- **Login propietario** (`POST /api/login/owner`, `auth.js:186`): guarda en `local_session` `role = 'owner'`, `isClient = false` → `is_client = 0`. **Pasa** `requireOwner`.
- **Login staff** (`POST /api/login/staff`, `auth.js:520`): guarda `role = emp.role` (p. ej. `'waiter'`), `isClient = true` → `is_client = 1`. **Recibe 403** en `tables/save`. Correcto.

### Cómo envía credenciales el frontend

`doOwnerLogin` (`public/pos-auth.js`) hace `fetch("/api/login/owner", { body: JSON.stringify({ email, password: btoa(s) }) })`. El servidor decodifica el Base64 (`auth.js:201`). La contraseña viaja hasheada con bcrypt en `config.master_pass`. **No se envía ningún rol ni token de autorización en las peticiones posteriores** al servidor; cada request es autorizado leyendo `local_session` en el servidor.

### Backend distingue propietario vs empleado

Sí, correctamente:
| Sesión en `local_session` | `role` | `is_client` | `POST /api/tables/save` |
|---|---|---|---|
| Propietario | `'owner'` | `0` | **200** (puede guardar) |
| Empleado / staff | `'waiter'` (u otro) | `1` | **403** |
| Empleado rol distinto | `!=='owner'` | `0` | **403** |
| Sin sesión | — | — | **401** |

### Respuesta JSON exacta del 403

```json
{ "success": false, "error": "Se requieren permisos de propietario", "code": "FORBIDDEN" }
```

### Sesión de Electron vs sesión del servidor

**No existe una "sesión de Electron" separada.** La sesión vive exclusivamente en la base de datos SQLite del servidor (`local_session`, `id = 1`). El renderer de Electron solo hace `fetch()` al Express local; no hay cookies, ni tokens, ni credenciales enviadas por cada request. El frontend lee el rol para la UI desde `localStorage` (`mente_maestra_registration`, `pos-nav.js`, `pos-menu.js`, `waiter-notify.js`), pero el **backend ignora totalmente `localStorage` y autoriza solo contra SQLite**.

### Conclusión de causa raíz

Si un **propietario legítimo** recibe `403`, la causa es que la sesión guardada en `local_session` **no es de propietario** — lo más probable es que se inició sesión como **empleado** (`/api/login/staff`, `is_client = 1`), que **sobrescribe la única fila de sesión** del dispositivo, o que la sesión se borró/expiró (aunque eso daría `401`, no `403`). El `403` recibido es el sistema funcionando según lo diseñado: un no-propietario no puede guardar mesas.

---

## 2. Archivos modificados

| Archivo | Acción | Motivo |
|---|---|---|
| `tests/tables-save-auth.test.js` | **Nuevo** | Pruebas de regresión que cubren los 6 escenarios obligatorios de autorización de `POST /api/tables/save`. |

**No se modificó:**
- `middleware/requireAuth.js` (`requireOwner` / `requireSession`) — ya son correctos y seguros.
- `routes/tables.js` — `requireOwner` está correctamente aplicado en `/save`.
- `auth.js`, `db.js`, `server.js` — el modelo de autenticación global se mantiene intacto.
- Ningún módulo no relacionado.

---

## 3. Corrección aplicada

Dado que la autorización del backend ya cumple **todas las restricciones**, no se aplicó ninguna modificación al código de autorización (modificarlo podría debilitar la seguridad):

- ✅ No se eliminó ningún middleware (`requireOwner` se mantiene en `tables/save`).
- ✅ No se permite que cualquier usuario guarde mesas (solo `owner` con `is_client = 0`).
- ✅ No se confía en el rol de `localStorage` (el backend usa `local_session` de SQLite).
- ✅ No se acepta el rol desde el cuerpo de la solicitud (el handler solo lee `id, capacity, status, ...`; `role`/`is_client` del cuerpo son ignorados).
- ✅ No se modificó la base de datos de producción.
- ✅ No se cambió el modelo de autenticación global.

**Corrección efectiva aplicada:** se añadió cobertura de pruebas automatizadas (`tests/tables-save-auth.test.js`) que evidencia y bloquea regresiones en la autorización de mesas. Si el propietario legítimo ve `403`, la acción correctiva es de operación (volver a iniciar sesión como propietario, no como empleado), no un cambio de código.

---

## 4. Pruebas ejecutadas y resultados

Se ejecutó la suite completa con el runner del proyecto (Electron runtime, Jest + Supertest, SQLite en memoria, rutas y middlewares reales):

```
Test Suites: 9 passed, 9 total
Tests:       191 passed, 191 total
```

Desglose de las **6 pruebas nuevas** en `tests/tables-save-auth.test.js` (todas pasan):

| Escenario obligatorio | Resultado |
|---|---|
| Propietario autenticado guarda mesa → 200 | ✅ PASS |
| Propietario actualiza mesa existente (UPSERT, sin duplicar) → 200 y persiste en BD | ✅ PASS |
| Empleado sesión staff (`is_client = 1`) → 403 `FORBIDDEN` | ✅ PASS |
| Empleado rol distinto a owner (`role !== 'owner'`) → 403 `FORBIDDEN` | ✅ PASS |
| Usuario sin sesión → 401 `NO_SESSION` | ✅ PASS |
| Cuerpo manipulado con `role: 'owner'` sobre sesión de empleado → 403 (no hay elevación de privilegios) | ✅ PASS |

Además, las **185 pruebas preexistentes** siguen pasando (`auth`, `security`, `security-hardening`, `orders`, `employees`, `customers`, `db`, `utils`) — sin regresiones.

---

## 5. Riesgos pendientes / limitaciones

1. **Sesión única por dispositivo.** `local_session` tiene una sola fila (`id = 1`). Si un empleado inicia sesión en el mismo equipo, sobrescribe la sesión del propietario (`is_client = 1`) y este recibirá `403` al intentar guardar mesas hasta que el propietario vuelva a iniciar sesión. Es una limitación de diseño del modelo de sesión actual, no un bug de autorización.
2. **Desincronización rol frontend ↔ backend.** El frontend usa `localStorage` (`mente_maestra_registration`) para decidir qué secciones mostrar (`pos-nav.js`, `pos-menu.js`). Si ese `localStorage` se manipula o queda desactualizado respecto a `local_session` de SQLite, el usuario podría ver el botón de guardar mesas pero el backend aún respondería `403`. El backend es seguro; el riesgo es solo de UX/confusión.
3. **No se pudo verificar end-to-end en el ejecutable Electron.** La restricción del entorno impidió arrancar Electron y reproducir el `403` desde la aplicación gráfica completa. La verificación se hizo contra las **rutas y middlewares reales del servidor** mediante la suite de tests (Jest + Supertest + SQLite real), que es la capa donde se genera el `403`.
4. **Firebase / Supabase.** No se verificó la conexión real a servicios en la nube (credenciales ausentes del entorno por seguridad); no afecta a la autorización local de mesas.

---

## Estado

**No se declara el problema como "bug de código corregido" porque la autorización del backend no está rota: el `403` es la respuesta correcta para sesiones no-propietarias.** La entrega consiste en la evidencia de que el sistema autoriza correctamente (propietario → 200, empleado → 403, sin sesión → 401, sin elevación de privilegios) y en la prueba de regresión que lo garantiza. Si el propietario experimenta `403`, se recomienda verificar que inició sesión como propietario (no como empleado) en el dispositivo.
