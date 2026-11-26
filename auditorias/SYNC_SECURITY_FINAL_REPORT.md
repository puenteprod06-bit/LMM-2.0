# SYNC_SECURITY_FINAL_REPORT.md
# Informe final de auditoría y reparación de seguridad — Sincronización SQLite ↔ Supabase

**Proyecto:** La Mente Maestra 3.0 (POS) — Node.js, Express, Electron, SQLite, Supabase  
**Fecha:** 18/11/2026  
**Estado:** Reparación aplicada y verificada — 237 tests aprobados  
**Próximo paso:** Esperar autorización antes de continuar con pedidos y dinero

---

## 1. Archivos inspeccionados

| Archivo | Qué se inspeccionó |
|---|---|
| `sync-engine.js` | Motor de sincronización: `applyRemoteRow`, `flushQueue`, `initialPull`, `startRealtimePull`, `checkIntegrity`, `pushPublicSettings` |
| `db.js` | Esquema de tablas, `SYNC_TABLES`, triggers de sincronización, `applyRemoteChange`, `_sync_flag` |
| `tests/sync-security.test.js` | Pruebas de seguridad preexistentes (listas blancas, inyección SQL, campos sensibles) |
| `tests/sync-integration.test.js` | Pruebas de integración nuevas (SQLite en memoria, escrituras reales de `applyRemoteRow`) |

---

## 2. Archivos modificados

| Archivo | Cambios |
|---|---|
| `sync-engine.js` | Lista blanca unificada de tablas (`SYNC_TABLES` de db.js), lista blanca de columnas de entrada (`ALLOWED_COLUMNS`), lista blanca de columnas de salida (`OUTPUT_COLUMNS`), campos sensibles excluidos (`SENSITIVE_FIELDS`), validación de payloads remotos, rechazo de tablas/columnas no autorizadas, uso de parámetros SQL para valores, inyección de DB para pruebas (`setDbForTesting`/`getDbForTesting`), escritura explícita de `uuid` en INSERT remoto, preservación de `updated_at` para comparación de timestamps |
| `db.js` | Sobreescritura de DB para pruebas (`setDbForTesting`/`clearDbOverride`/`getDbForTesting`), `applyRemoteChange` usa `_getDb()` para respetar el override de testing |
| `tests/sync-security.test.js` | 17 pruebas de seguridad (listas blancas, inyección SQL vía tabla/columna, campos sensibles, payloads malformados) |
| `tests/sync-integration.test.js` | 25 pruebas de integración contra SQLite en memoria (inserción, actualización, rechazos, campos sensibles, protección de ID, sanitización de salida) |

---

## 3. Backups realizados

| Archivo | Ruta del backup |
|---|---|
| `sync-engine.js` | `scripts/backups/sync-final-20261118/sync-engine.js.bak` |
| `db.js` | `scripts/backups/sync-final-20261118/db.js.bak` |
| (Previos) `sync-engine.js` | `scripts/backups/sync-security-20261118/sync-engine.js.bak` |
| (Previos) `db.js` | `scripts/backups/sync-security-20261118/db.js.bak` |

---

## 4. Listas blancas implementadas

### 4.1. Tablas autorizadas (`SYNC_TABLES` — fuente única de verdad en `db.js`)

```
orders, order_items, tables, menu_items, inventory, customers, employees, categories, subcategories
```

Tablas EXPLÍCITAMENTE EXCLUIDAS (nunca se sincronizan): `config`, `local_session`, `sync_queue`, `sqlite_master`, `_sync_flag`, `security_config`, `predefined_discounts`, `caja_sessions`, `ticket_config`, `business_hours`, `stock_alert_config`, `work_shifts`.

### 4.2. Columnas autorizadas para ENTRADA (remoto → local, `ALLOWED_COLUMNS`)

| Tabla | Columnas permitidas para escritura remota |
|---|---|
| `employees` | name, role, phone, active, updated_at |
| `categories` | name, emoji, image_url, updated_at |
| `subcategories` | name, category_id, image_url, updated_at |
| `menu_items` | name, price, cost, catId, emoji, image_url, available, area, subcatId, is_promo, promo_label, promo_ends_at, promo_original_price, promo_desc, promo_original_name, is_combo, combo_items, updated_at |
| `inventory` | name, stock, minStock, unit, cost, salePrice, category, expirationDate, notes, emoji, showInPOS, area, updated_at |
| `customers` | name, phone, email, visits, totalSpent, points, updated_at |
| `tables` | capacity, status, waiterId, waiterName, zona, numero, guests, openedAt, sort_order, lastOrderAt, currentOrderId, updated_at |
| `orders` | subtotal, tax, total, discount, discountAmt, commissionAmt, type, tableId, customer, status, paymentMethod, createdAt, waiterName, openedAt, closedAt, updatedAt, tableNumber, paymentStatus, discountType, paidAt, taxRate, updated_at |
| `order_items` | order_id, name, price, qty, lineTotal, note, itemType, invId, area, status, createdAt, order_uuid, updated_at |

### 4.3. Columnas autorizadas para SALIDA (local → Supabase, `OUTPUT_COLUMNS`)

| Tabla | Columnas enviadas a Supabase |
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

**Nota:** `uuid` se incluye explícitamente en los INSERT remotos porque el trigger de `db.js` está deshabilitado durante `applyRemoteRow` (`applying_remote = 1`).

---

## 5. Campos sensibles excluidos (`SENSITIVE_FIELDS`)

Estos campos **nunca** se escriben desde remoto ni se envían a Supabase:

| Campo | Motivo |
|---|---|
| `pin` | Hash de PIN de empleados — credencial de acceso |
| `master_pass` | Contraseña del propietario — credencial de acceso |
| `session_token` | Token de sesión local |
| `supabase_anon_key` | Clave anónima de Supabase — credencial de nube |
| `cloud_restaurant_id` | ID de restaurante en la nube — identificador interno |
| `supabase_url` | URL de Supabase — configuración interna |
| `password` | Contraseña genérica — credencial de acceso |
| `token` | Token genérico — credencial de acceso |

Además, `id` (autoincremental local) nunca se escribe desde remoto, y `uuid`/`device_id`/`deleted` se gestionan mediante triggers de `db.js`.

---

## 6. Resultado de las pruebas de integración SQLite

Archivo: `tests/sync-integration.test.js` — **25/25 pruebas pasan**

| # | Prueba | Resultado |
|---|--------|-----------|
| 1 | `SYNC_TABLES` coincide con tablas del esquema | ✅ PASS |
| 2 | `isAllowedTable` devuelve true para tablas de `SYNC_TABLES` | ✅ PASS |
| 3 | Inserción de empleado válido | ✅ PASS |
| 4 | Inserción de mesa válida | ✅ PASS |
| 5 | Inserción de orden y sus ítems (compatibilidad) | ✅ PASS |
| 6 | Actualización de mesa existente | ✅ PASS |
| 7 | No sobrescribe si local es igual o más nuevo | ✅ PASS |
| 8 | Rechaza tabla no permitida | ✅ PASS |
| 9 | Rechaza inyección SQL vía nombre de tabla | ✅ PASS |
| 10 | Rechaza inyección SQL vía nombres de columna | ✅ PASS |
| 11 | Rechaza payload malformado (no objeto) | ✅ PASS |
| 12 | Rechaza payload sin uuid | ✅ PASS |
| 13 | Rechaza payload sin columnas escribibles | ✅ PASS |
| 14 | Excluye pin/master_pass/session_token de la escritura | ✅ PASS |
| 15 | No escribe el ID autoincremental desde remoto | ✅ PASS |
| 16 | `sanitizeOutputColumns` excluye campos sensibles | ✅ PASS |
| 17 | `OUTPUT_COLUMNS` cubre todas las tablas de `SYNC_TABLES` | ✅ PASS |
| 18 | No incluye pin/master_pass en ninguna salida | ✅ PASS |
| 19 | `ALLOWED_COLUMNS` cubre todas las tablas | ✅ PASS |
| 20 | `SENSITIVE_FIELDS` contiene campos críticos | ✅ PASS |
| 21-25 | Sanity checks de DB en memoria | ✅ PASS |

---

## 7. Resultado de las pruebas generales

Suite completa: **13 suites, 237 tests, todos pasan** (sin regresiones)

| Suite | Tests | Estado |
|---|---|---|
| `tests/orders.test.js` | — | ✅ PASS |
| `tests/employees.test.js` | — | ✅ PASS |
| `tests/security.test.js` | — | ✅ PASS |
| `tests/db.test.js` | — | ✅ PASS |
| `tests/auth.test.js` | — | ✅ PASS |
| `tests/sync-security.test.js` | 17 | ✅ PASS |
| `tests/security-hardening.test.js` | — | ✅ PASS |
| `tests/customers.test.js` | — | ✅ PASS |
| `tests/flow-reproduction.test.js` | — | ✅ PASS |
| `tests/tables-save-auth.test.js` | — | ✅ PASS |
| `tests/utils.test.js` | — | ✅ PASS |
| `tests/inspect-real-db.test.js` | — | ✅ PASS |
| `tests/sync-integration.test.js` | 25 | ✅ PASS |
| **Total** | **237** | ✅ **TODOS PASSAN** |

---

## 8. Riesgos pendientes

1. **`flushQueue` envía `data` como JSON a Supabase.** `sanitizeOutputColumns` filtra campos sensibles, pero `local_id` y otros campos internos se incluyen en el payload. No son secretos, pero son metadatos internos que podrían no ser necesarios en la nube.
2. **Listas blancas duplicadas lógicamente.** `SYNC_TABLES` (en `db.js`) es la fuente única de tablas, pero `ALLOWED_COLUMNS` y `OUTPUT_COLUMNS` (en `sync-engine.js`) son listas separadas que deben mantenerse sincronizadas manualmente con el esquema real.
3. **`applyRemoteRow` lanza errores siempre.** El `catch` ahora relanza (`throw err`) en lugar de tragar silenciosamente. En producción, el handler global de Express capturará estos errores. Esto es más seguro que silenciar errores, pero podría afectar la estabilidad del motor de sync si Supabase envía datos inesperados recurrentemente.
4. **No se verificó sincronización real contra Supabase.** Las pruebas usan SQLite en memoria. No hay credenciales de Supabase configuradas en el entorno de pruebas.
5. **Triggers de `db.js` usan interpolación de string para nombres de tabla.** Los nombres provienen de `SYNC_TABLES` (definida en código), por lo que son seguros, pero cualquier modificación futura de `SYNC_TABLES` debe mantener esta propiedad.

---

## 9. Diferencias entre el esquema real y las listas blancas

| Tabla | Columnas en esquema real | Columnas en `ALLOWED_COLUMNS` (entrada) | Columnas en `OUTPUT_COLUMNS` (salida) | Notas |
|---|---|---|---|---|
| `employees` | id, name, role, pin, phone, active, uuid, updated_at, device_id, deleted | name, role, phone, active, updated_at | uuid, name, role, phone, active | `pin`, `device_id`, `deleted` excluidos (sensibles/internos) |
| `categories` | id, name, emoji, image_url, uuid, updated_at, device_id, deleted | name, emoji, image_url, updated_at | uuid, name, emoji, image_url | `device_id`, `deleted` excluidos |
| `subcategories` | id, name, category_id, image_url, uuid, updated_at, device_id, deleted | name, category_id, image_url, updated_at | uuid, name, category_id, image_url | `device_id`, `deleted` excluidos |
| `menu_items` | id, name, price, cost, catId, emoji, image_url, available, area, subcatId, is_promo, promo_label, promo_ends_at, promo_original_price, promo_desc, promo_original_name, is_combo, combo_items, uuid, updated_at, device_id, deleted | Todas las columnas de datos + updated_at | uuid + todas las columnas de datos | `device_id`, `deleted` excluidos |
| `inventory` | id, name, stock, minStock, unit, cost, salePrice, category, expirationDate, notes, emoji, showInPOS, area, uuid, updated_at, device_id, deleted | Todas las columnas de datos + updated_at | uuid + todas las columnas de datos | `device_id`, `deleted` excluidos |
| `customers` | id, name, phone, email, visits, totalSpent, points, uuid, updated_at, device_id, deleted | name, phone, email, visits, totalSpent, points, updated_at | uuid, name, phone, email, visits, totalSpent, points | `device_id`, `deleted` excluidos |
| `tables` | id, capacity, status, waiterId, waiterName, zona, numero, guests, openedAt, sort_order, lastOrderAt, currentOrderId, uuid, updated_at, device_id, deleted | Todas las columnas de datos + updated_at | uuid + todas las columnas de datos | `device_id`, `deleted` excluidos |
| `orders` | id, subtotal, tax, total, discount, discountAmt, commissionAmt, type, tableId, customer, status, paymentMethod, createdAt, waiterName, openedAt, closedAt, updatedAt, tableNumber, paymentStatus, discountType, paidAt, taxRate, uuid, updated_at, device_id, deleted | Todas las columnas de datos + updated_at | uuid + todas las columnas de datos | `device_id`, `deleted` excluidos |
| `order_items` | id, order_id, name, price, qty, lineTotal, note, itemType, invId, area, status, createdAt, order_uuid, uuid, updated_at, device_id, deleted | Todas las columnas de datos + updated_at | uuid + todas las columnas de datos | `device_id`, `deleted` excluidos |

**Observación:** Las columnas de control interno (`uuid`, `updated_at`, `device_id`, `deleted`, `id`) se gestionan mediante triggers de `db.js` o se agregan explícitamente en `applyRemoteRow`. No se aceptan del payload remoto excepto `updated_at` (para comparación de timestamps) y `uuid` (para el INSERT inicial).

---

## 10. Confirmación

- ✅ No se modificaron datos reales ni la base de datos de producción.
- ✅ No se modificaron módulos fuera del alcance (autenticación, pedidos, cobros, menú, inventario, etc.).
- ✅ No se eliminó ninguna prueba existente.
- ✅ No se ejecutó `npm audit fix --force`.
- ✅ No se ejecutaron sincronizaciones reales contra Supabase.
- ✅ Se crearon backups antes de modificar.
- ✅ Se utilizó SQLite en memoria (`:memory:`) para pruebas, no la base de producción.

---

## Estado final

La sincronización SQLite ↔ Supabase está protegida con listas blancas explícitas de tablas y columnas (entrada y salida), exclusión de campos sensibles, uso de parámetros SQL para todos los valores, y validación rigurosa de payloads remotos. Las pruebas de integración contra SQLite en memoria verifican escrituras reales de `applyRemoteRow`, y la suite completa de 237 tests pasa sin regresiones.

**Se detiene aquí y espera autorización antes de continuar con la fase de pedidos y dinero.**
