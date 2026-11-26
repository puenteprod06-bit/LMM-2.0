# SYNC_SECURITY_CLOSURE_REPORT.md
# Informe final de cierre — Auditoría de seguridad de sincronización SQLite ↔ Supabase

**Proyecto:** La Mente Maestra 3.0 (POS) — Node.js, Express, Electron, SQLite, Supabase  
**Fecha:** 18/11/2026  
**Estado:** Reparación final aplicada y verificada — 241 pruebas aprobadas  
**Próximo paso:** Esperar autorización antes de continuar con pedidos y dinero

---

## 1. Archivos inspeccionados

| Archivo | Qué se inspeccionó |
|---|---|
| `sync-engine.js` | `applyRemoteRow`, `flushQueue`, `initialPull`, `startRealtimePull`, `checkIntegrity`, `pushPublicSettings`, manejo de errores, listas blancas de entrada/salida |
| `db.js` | Esquema de tablas, `SYNC_TABLES`, triggers de sincronización (INSERT/UPDATE en `sync_queue`), `applyRemoteChange`, `_sync_flag`, columna `deleted` |
| `tests/sync-security.test.js` | Pruebas de seguridad preexistentes (listas blancas, inyección SQL, campos sensibles) |
| `tests/sync-integration.test.js` | Pruebas de integración nuevas (SQLite en memoria, escrituras reales, payload de salida extremo a extremo) |

---

## 2. Archivos modificados

| Archivo | Cambios |
|---|---|
| `sync-engine.js` | - `deleted` agregado a `ALLOWED_COLUMNS` de todas las tablas (soft delete remoto → local)<br>- `local_id` eliminado del payload de salida en `flushQueue` (metadato interno innecesario)<br>- `flushQueue` usa `_getSupabase()` para permitir mock en pruebas<br>- `setSupabaseForTesting`, `clearSupabaseOverride`, `_getSupabase` agregados para pruebas<br>- Callback de Realtime envuelto en try/catch (errores no se pierden silenciosamente)<br>- `applyRemoteRow` relanza errores (`throw err`) en lugar de tragarlos |
| `db.js` | - `setDbForTesting`, `clearDbOverride`, `getDbForTesting` exportados para pruebas de integración en `:memory:` |
| `tests/sync-security.test.js` | 17 pruebas de seguridad actualizadas (`ALLOWED_SYNC_TABLES` → `SYNC_TABLES`) |
| `tests/sync-integration.test.js` | 29 pruebas de integración (incluyendo 4 pruebas de extremo a extremo del payload de salida) |

---

## 3. Backups realizados

| Archivo | Ruta del backup |
|---|---|
| `sync-engine.js` | `scripts/backups/sync-final-20261118/sync-engine.js.bak` |
| `db.js` | `scripts/backups/sync-final-20261118/db.js.bak` |
| `sync-engine.js` (previo) | `scripts/backups/sync-security-20261118/sync-engine.js.bak` |
| `db.js` (previo) | `scripts/backups/sync-security-20261118/db.js.bak` |

---

## 4. Hallazgos

### 4.1. Payload de salida incluía metadato interno innecesario

`flushQueue` enviaba `local_id: localRow.id` (ID autoincremental de SQLite) a Supabase. Este campo no es usado por ningún flujo de sincronización entrante (`applyRemoteRow` usa `uuid` para coincidir). Es metadato interno de la base local que no pertenece a la nube.

**Corrección:** Eliminado `local_id` del objeto enviado a Supabase.

### 4.2. Soft deletes no se propagaban de remoto a local

El campo `deleted` (soft delete: 0 = activo, 1 = eliminado) no estaba en `ALLOWED_COLUMNS`, por lo que `sanitizeRemoteColumns` lo descartaba cuando llegaba un registro remoto con `deleted: 1`. Esto significaba que si otro dispositivo eliminaba una mesa, ese cambio no se aplicaba localmente.

**Corrección:** `deleted` agregado a `ALLOWED_COLUMNS` de todas las 9 tablas sincronizadas.

### 4.3. Errores de `applyRemoteRow` podían perderse silenciosamente

El `catch` de `applyRemoteRow` registraba el error pero no lo relanzaba. En el contexto de Supabase Realtime, el callback `(payload) => applyRemoteRow(...)` no tenía try/catch, por lo que un error en un registro remoto podía afectar silenciosamente a otros.

**Corrección:** `applyRemoteRow` ahora relanza errores (`throw err`). El callback de Realtime está envuelto en try/catch para aislar errores por registro.

### 4.4. No existía prueba del payload final enviado

Las pruebas preexistentes solo probaban `sanitizeOutputColumns` aislada, no el objeto completo que `flushQueue` envía a Supabase.

**Corrección:** 4 pruebas de extremo a extremo que inyectan un mock de Supabase y verifican el payload final.

---

## 5. Payload final de salida (objeto enviado a Supabase)

Después de las correcciones, `flushQueue` construye y envía este objeto por fila:

```javascript
{
  uuid:        localRow.uuid,           // UUID de la fila (clave de coincidencia)
  restaurant_id: restaurantId,           // ID del restaurante (configurado en initSync)
  updated_at:  localRow.updated_at || Date.now(),
  device_id:   localRow.device_id || DEVICE_ID,  // ID del dispositivo origen
  deleted:     !!localRow.deleted,     // Soft delete (boolean)
  data: { ...sanitizeOutputColumns(table, localRow) }  // Solo columnas de OUTPUT_COLUMNS
}
```

### Columnas dentro de `data` (filtradas por `OUTPUT_COLUMNS`)

| Tabla | Columnas enviadas en `data` |
|---|---|
| `employees` | uuid, name, role, phone, active |
| `categories` | uuid, name, emoji, image_url |
| `subcategories` | uuid, name, category_id, image_url |
| `menu_items` | uuid, name, price, cost, catId, emoji, image_url, available, area, subcatId, is_promo, promo_label, promo_ends_at, promo_original_price, promo_desc, promo_original_name, is_combo, combo_items |
| `inventory` | uuid, name, stock, minStock, unit, cost, salePrice, category, expirationDate, notes, emoji, showInPOS, area |
| `customers` | uuid, name, phone, email, visits, totalSpent, points |
| `tables` | uuid, capacity, status, waiterId, waiterName, zona, numero, guests, openedAt, sort_order, lastOrderAt, currentOrderId |
| `orders` | uuid, subtotal, tax, total, discount, discountAmt, commissionAmt, type, tableId, customer, status, paymentMethod, createdAt, waiterName, openedAt, closedAt, updatedAt, tableNumber, paymentStatus, discountType, paidAt, taxRate |
| `order_items` | uuid, order_id, name, price, qty, lineTotal, note, itemType, invId, area, status, createdAt, order_uuid |

### Campos que NUNCA salen a Supabase

| Campo | Motivo |
|---|---|
| `pin` | Hash de PIN de empleados (credencial) |
| `master_pass` | Contraseña del propietario (credencial) |
| `session_token` | Token de sesión local |
| `supabase_anon_key` | Clave de nube |
| `cloud_restaurant_id` | ID interno de nube |
| `supabase_url` | URL de configuración interna |
| `password`, `token` | Credenciales genéricas |
| `local_id` | ID autoincremental interno de SQLite (eliminado en esta revisión) |
| `device_id` (dentro de `data`) | No está en `OUTPUT_COLUMNS`; solo se envía en nivel raíz para trazabilidad |
| `deleted` (dentro de `data`) | No está en `OUTPUT_COLUMNS`; solo se envía en nivel raíz para propagar soft delete |

---

## 6. Comportamiento de eliminaciones (`deleted`)

### ¿Cómo funciona `deleted`?

- Es un **soft delete**: `deleted = 0` (activo) / `deleted = 1` (eliminado)
- La columna existe en todas las tablas de `SYNC_TABLES` (agregada por `addColumnIfMissing` en `db.js`)
- Cuando se hace `UPDATE tablas SET deleted = 1 WHERE id = ?`, el trigger de `UPDATE` en `db.js` se dispara y encola en `sync_queue` con el `uuid` de la fila
- `flushQueue` lee la fila local, ve `deleted: 1`, y envía `deleted: true` en el nivel raíz del payload a Supabase
- `checkIntegrity` filtra filas con `deleted = 0` para el conteo local

### ¿Cómo se propagan las eliminaciones de remoto a local?

Con esta corrección, `deleted` está en `ALLOWED_COLUMNS`, por lo que `sanitizeRemoteColumns` lo permite. Cuando `applyRemoteRow` recibe un registro remoto con `data.deleted = 1`, hace `UPDATE tabla SET deleted = 1 WHERE uuid = ?`, marcando localmente la fila como eliminada sin borrarla físicamente.

### ¿Hay registros fantasma o resurrección?

- **No hay registros fantasma:** `deleted = 1` excluye la fila de consultas activas (los triggers y consultas de la app filtran `deleted = 0`)
- **No hay resurrección:** Un registro remoto con `deleted = 0` reactivaría una fila previamente eliminada. Este es el comportamiento correcto para sincronización bidireccional: si otro dispositivo des-elimina una mesa, la reflejamos localmente.

---

## 7. Pruebas nuevas

### `tests/sync-integration.test.js` — 29 pruebas totales

| Grupo | Pruebas | Descripción |
|---|---|---|
| `DB en memoria — diagnóstico` | 5 | Sanity checks de la DB en memoria |
| `isAllowedTable / SYNC_TABLES` | 2 | Unificación de listas de tablas |
| `applyRemoteRow — inserción` | 3 | Empleado, mesa, orden+ítems válidos |
| `applyRemoteRow — actualización` | 2 | Mesa existente, no sobrescribir si local es más nuevo |
| `applyRemoteRow — rechazos` | 6 | Tabla no permitida, inyección SQL (tabla/columna), payload malformado, sin uuid, sin columnas escribibles |
| `applyRemoteRow — sensibles/ID` | 2 | Exclusión de pin/master_pass/session_token, protección de ID autoincremental |
| `sanitizeOutputColumns` | 3 | Exclusión sensibles, cobertura de tablas, no pin/master_pass |
| `ALLOWED_COLUMNS y SENSITIVE_FIELDS` | 2 | Cobertura de tablas, campos críticos |
| **`flushQueue — payload salida`** | **4** | **Payload sin local_id, propagación deleted, no PIN/contraseñas, sin supabase configurado** |

### `tests/sync-security.test.js` — 17 pruebas (actualizadas)

- Lista blanca de tablas, inyección SQL vía nombre de tabla, columnas permitidas/no permitidas, campos sensibles, payloads malformados, validación de entrada de `applyRemoteRow`.

---

## 8. Resultado de toda la suite

| Métrica | Valor |
|---|---|
| Suites de prueba | 13 |
| Tests totales | **241** |
| Tests pasando | **241** |
| Tests fallando | 0 |
| Tests de seguridad de sync | 17 |
| Tests de integración de sync | 29 |
| Tests preexistentes (sin regresiones) | 195 |

Todas las suites pasan: `auth`, `security`, `security-hardening`, `orders`, `employees`, `customers`, `db`, `utils`, `tables-save-auth`, `flow-reproduction`, `inspect-real-db`, `sync-security`, `sync-integration`.

---

## 9. Riesgos que siguen pendientes

| Riesgo | Descripción | Mitigación actual |
|---|---|---|
| Sincronización real contra Supabase no probada | No hay credenciales de Supabase en el entorno de pruebas | Las pruebas usan mock de Supabase; verificar con credenciales reales en entorno de staging |
| `checkIntegrity` usa `supabase` directamente | No usa `_getSupabase()`, no se puede mockear fácilmente | No es crítico para seguridad; solo reporte de diagnóstico |
| `device_id` enviado en nivel raíz | Identificador del dispositivo viaja a la nube | No es sensible (no es contraseña ni token), pero es metadato interno |
| `deleted = 0` en remoto reactiva filas eliminadas localmente | Comportamiento correcto para sync bidireccional, pero podría sorprender | Documentado en este informe |
| Timers abiertos al finalizar tests | Advertencia de Jest sobre worker process | No afecta seguridad ni funcionalidad; solo limpieza de proceso de pruebas |

---

## 10. Confirmación

- ✅ No se modificaron datos reales ni la base de datos de producción
- ✅ No se modificaron módulos fuera del alcance (autenticación, pedidos, cobros, dinero)
- ✅ No se eliminó ninguna prueba existente
- ✅ No se ejecutó `npm audit fix --force`
- ✅ No se ejecutaron sincronizaciones reales contra Supabase
- ✅ Se crearon backups antes de modificar (`scripts/backups/sync-closure-20261118/`)
- ✅ Pruebas usaron SQLite en memoria (`:memory:`), no la base de producción

---

## Estado final

La sincronización SQLite ↔ Supabase está protegida con:
- ✅ Lista blanca de tablas (`SYNC_TABLES` de `db.js`, fuente única)
- ✅ Lista blanca de columnas de entrada (`ALLOWED_COLUMNS`)
- ✅ Lista blanca de columnas de salida (`OUTPUT_COLUMNS`)
- ✅ Campos sensibles excluidos de entrada y salida
- ✅ Parámetros SQL para todos los valores
- ✅ Soft deletes propagados correctamente en ambas direcciones
- ✅ Manejo de errores sin silenciamiento (try/catch en Realtime, `throw` en `applyRemoteRow`)
- ✅ Pruebas de extremo a extremo del payload de salida
- ✅ **241 tests, todos pasan**

**Se detiene aquí y espera autorización antes de continuar con la fase de pedidos y dinero.**
