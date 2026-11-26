# SYNC_SECURITY_REPORT.md
# Informe de auditoría y reparación de seguridad — Sincronización SQLite <-> Supabase

**Proyecto:** La Mente Maestra (POS) — Node.js, Express, Electron, SQLite, Supabase  
**Fecha:** 18/11/2026  
**Archivo auditado:** `sync-engine.js`  
**Archivos modificados:** `sync-engine.js`  
**Backups:** `scripts/backups/sync-security-20261118/sync-engine.js.bak`, `db.js.bak`  
**Estado:** Reparación aplicada y verificada con pruebas

---

## 1. Vulnerabilidad original

El motor de sincronización (`sync-engine.js`) aplicaba registros remotos provenientes de Supabase (vía Realtime o `initialPull`) en la base de datos SQLite local a través de la función `applyRemoteRow(table, remote)`.

El flujo crítico era:

```js
const data = { ...(remote.data || {}) };
let cols = Object.keys(data).filter((k) => k !== 'id');
// ...
const setClause = cols.map((c) => `${c} = ?`).join(', ');
_db.prepare(`UPDATE ${table} SET ${setClause} WHERE uuid = ?`).run(...cols.map((c) => data[c]), remote.uuid);
```

### Problemas identificados

| # | Problema | Riesgo |
|---|----------|--------|
| 1 | **Nombres de columna no validados** | `cols` provenía de `Object.keys(remote.data)` sin lista blanca. Un identificador como `name = 1; DROP TABLE employees--` se interpolaba directamente en el SQL (`${c} = ?`), permitiendo **inyección SQL vía nombre de columna**. |
| 2 | **Nombres de tabla sin validación centralizada** | `applyRemoteRow` tenía una lista blanca local, pero `flushQueue` usaba `table_name` de `sync_queue` en `SELECT * FROM ${table}` sin validar contra lista blanca. Si la base local era manipulada, podía inyectarse SQL. |
| 3 | **Payload `remote.data` no validado** | Si `remote.data` no era un objeto (null, string, array), `Object.keys` se comportaba de forma inesperada o falleba silenciosamente. |
| 4 | **Campos sensibles expuestos** | `remote.data` podía contener `pin`, `master_pass`, `session_token`, etc., y se escribían en la DB local sin filtro. |
| 5 | **Sin lista blanca de columnas por tabla** | No existía definición explícita de qué columnas son escribibles por tabla, lo que permitía escribir columnas internas o inexistentes. |

---

## 2. Causa raíz

La aplicación confiaba en que los datos recibidos de Supabase eran "seguros porque vienen de la nube". Los nombres de columna y tabla se interpolaban directamente en sentencias SQL dinámicas (`UPDATE ... SET ${col} = ?`, `INSERT INTO ${table} (...)`) sin validar contra una lista blanca definida en código. Esto viola el principio de **nunca confiar en datos externos**, incluso de fuentes consideradas confiables.

---

## 3. Correcciones aplicadas (en `sync-engine.js`)

### 3.1. Lista blanca explícita de tablas (`ALLOWED_SYNC_TABLES`)

```js
const ALLOWED_SYNC_TABLES = [
  'employees', 'categories', 'subcategories', 'menu_items',
  'inventory', 'customers', 'tables', 'orders', 'order_items',
];
```

Coincide con `SYNC_TABLES` de `db.js`. Cualquier tabla fuera de esta lista es rechazada.

### 3.2. Lista blanca de columnas por tabla (`ALLOWED_COLUMNS`)

Cada tabla tiene definidas únicamente las columnas escribibles desde remoto. Ejemplo:

```js
const ALLOWED_COLUMNS = {
  employees: ['name', 'role', 'phone', 'active'],
  categories: ['name', 'emoji', 'image_url'],
  // ...
  tables: ['capacity', 'status', 'waiterId', 'waiterName', 'zona', 'numero', 'guests', ...],
  orders: ['subtotal', 'tax', 'total', ..., 'taxRate'],
  order_items: ['order_id', 'name', 'price', 'qty', 'lineTotal', 'note', ...],
};
```

Las columnas de control interno (`uuid`, `updated_at`, `device_id`, `deleted`) y el `id` autoincremental **no** se aceptan del payload remoto.

### 3.3. Función `isAllowedTable(table)`

Valida que el nombre de tabla sea string y esté en `ALLOWED_SYNC_TABLES`. Rechaza inyecciones como `employees; DROP TABLE...`, `employees' OR '1'='1`, valores no string, etc.

### 3.4. Función `sanitizeRemoteColumns(table, data)`

- Verifica que `data` sea un objeto válido (no null, no array, no string, no número).
- Filtra columnas contra la lista blanca de la tabla.
- Descarta columnas desconocidas (con log de advertencia).
- Descarta el `id` local autoincremental.
- Retorna `null` si no quedan columnas escribibles.

### 3.5. Campos sensibles excluidos (`SENSITIVE_FIELDS`)

```js
const SENSITIVE_FIELDS = new Set([
  'pin', 'master_pass', 'session_token', 'supabase_anon_key',
  'cloud_restaurant_id', 'supabase_url', 'password', 'token',
]);
```

Estos campos **nunca** se escriben desde un registro remoto, incluso si aparecen en `remote.data`. Motivo: evitar que un atacante con acceso a Supabase sobrescriba hashes de PIN de empleados, contraseñas del propietario o tokens de sesión en los dispositivos locales.

### 3.6. Validación en `flushQueue`

Se agregó validación de `table_name` de `sync_queue` contra `ALLOWED_SYNC_TABLES` antes de usarlo en `SELECT * FROM ${table}`. Si la tabla no está autorizada, se omite y se registra advertencia.

### 3.7. Parámetros SQL para todos los valores

Todos los valores de columna se pasan como parámetros (`?`) de `better-sqlite3`. Solo los identificadores (nombres de tabla y columna) se interpolan, y únicamente **después** de validarlos contra las listas blancas.

### 3.8. Exportación para pruebas

Se exportaron `applyRemoteRow`, `isAllowedTable`, `sanitizeRemoteColumns`, `ALLOWED_SYNC_TABLES`, `ALLOWED_COLUMNS` y `SENSITIVE_FIELDS` para permitir pruebas unitarias de seguridad.

---

## 4. Campos excluidos y motivos

| Campo | Tabla | Motivo de exclusión |
|-------|-------|---------------------|
| `pin` | employees | Hash de PIN de empleado; nunca debe escribirse desde remoto |
| `master_pass` | config (no en sync) | Contraseña del propietario; no está en tablas de sync, pero se protege por si acaso |
| `session_token` | — | Token de sesión local |
| `supabase_anon_key`, `cloud_restaurant_id`, `supabase_url` | config | Credenciales de nube; nunca se replican |
| `password`, `token` | — | Genéricos de credenciales |
| `id` | todas | ID autoincremental local; nunca se sobrescribe desde remoto |
| `uuid`, `updated_at`, `device_id`, `deleted` | todas | Columnas de control interno gestionadas por triggers de `db.js` |

---

## 5. Pruebas ejecutadas

Archivo: `tests/sync-security.test.js` (17 pruebas)

| # | Prueba | Resultado |
|---|--------|-----------|
| 1 | `ALLOWED_SYNC_TABLES` contiene tablas del dominio POS | ✅ PASS |
| 2 | Tabla permitida devuelve true (`isAllowedTable`) | ✅ PASS |
| 3 | Tabla no permitida devuelve false | ✅ PASS |
| 4 | Inyección SQL vía nombre de tabla rechazada | ✅ PASS |
| 5 | Valores no string rechazados | ✅ PASS |
| 6 | Columnas permitidas se conservan | ✅ PASS |
| 7 | Columnas no permitidas se descartan | ✅ PASS |
| 8 | Inyección SQL vía nombre de columna descartada | ✅ PASS |
| 9 | Campos sensibles excluidos (`pin`, `master_pass`, `session_token`) | ✅ PASS |
| 10 | `id` local nunca se escribe desde remoto | ✅ PASS |
| 11 | Payload nulo/no objeto retorna null | ✅ PASS |
| 12 | Tabla sin lista blanca retorna null | ✅ PASS |
| 13 | Payload sin columnas escribibles retorna null | ✅ PASS |
| 14 | `SENSITIVE_FIELDS` contiene campos críticos | ✅ PASS |
| 15 | Tabla no permitida rechazada sin tocar BD | ✅ PASS |
| 16 | Payload no objeto rechazado | ✅ PASS |
| 17 | Payload sin uuid rechazado | ✅ PASS |

**Suite completa:** 12 suites, **212 tests**, todos pasan (sin regresiones en tests preexistentes de auth, seguridad, orders, employees, customers, tables, db, etc.).

---

## 6. Diferencias antes/después

| Aspecto | Antes | Después |
|---------|-------|---------|
| Validación de tabla | Lista blanca local en `applyRemoteRow` | Lista blanca centralizada `ALLOWED_SYNC_TABLES` + validación en `flushQueue` |
| Validación de columna | Ninguna (`Object.keys` sin filtro) | Lista blanca por tabla (`ALLOWED_COLUMNS`) |
| Columnas desconocidas | Se escribían en SQL | Se descartan con advertencia |
| Campos sensibles | Se escribían si venían en `remote.data` | Se excluyen explícitamente (`SENSITIVE_FIELDS`) |
| Payload `remote.data` | No validado | Validado como objeto, no array, no null |
| `id` local | Filtrado solo por nombre `id` | Filtrado explícito, nunca escribible desde remoto |
| Identificadores SQL | Interpolados sin validación | Interpolados solo tras validación contra lista blanca |
| Exportación para pruebas | No exportadas | Exportadas para auditoría |

---

## 7. Riesgos pendientes

1. **`applyRemoteRow` no está conectada a una DB en memoria en las pruebas.** Las pruebas validan la entrada (antes de tocar BD) pero no ejercen el `UPDATE`/`INSERT` real contra SQLite, porque `_db` de `db.js` apunta a la DB de producción y no se puede apuntar a `:memory:` sin modificar `db.js`. Se recomienda una prueba de integración con una instancia separada de `better-sqlite3` si se requiere cobertura del camino de escritura SQL.

2. **`flushQueue` envía `data: localRow` completo a Supabase.** Esto incluye todas las columnas de la fila local (incluyendo las que se escriben). No se filtran campos sensibles al hacer push hacia la nube, aunque `pushPublicSettings` sí filtra la config pública. Se debería revisar si `localRow` contiene campos que no deben subir a Supabase.

3. **`checkIntegrity` usa `SYNC_TABLES` de `db.js`.** Esta lista es segura (definida en código), pero está duplicada con `ALLOWED_SYNC_TABLES` en `sync-engine.js`. Se recomienda unificar en una sola fuente de verdad para evitar desincronización futura.

4. **No se modificó `db.js`.** Los triggers de sincronización en `db.js` siguen generando `sync_queue` con `table_name` derivado del nombre de tabla real. La defensa en profundidad en `flushQueue` mitiga el riesgo, pero no elimina la dependencia de que los triggers sean correctos.

5. **Supabase Realtime payloads.** `applyRemoteRow` recibe `payload.new || payload.old`. Si `payload.new` es null (evento de delete), `remote` sería null y se rechaza. Si un evento trae columnas inesperadas, se descartan. Comportamiento seguro.

---

## 8. Conclusión

Se aplicaron listas blancas explícitas de tablas y columnas, validación de payloads, exclusión de campos sensibles y uso de parámetros SQL para todos los valores en `applyRemoteRow` y `flushQueue`. Las pruebas de seguridad pasan (17/17) y la suite completa no muestra regresiones (212/212).

**Se detiene aquí y espera autorización antes de continuar con pedidos y dinero.**
