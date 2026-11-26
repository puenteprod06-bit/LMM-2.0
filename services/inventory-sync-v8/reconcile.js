'use strict';
/**
 * Reconciliación offline (V8 §16). Todas las funciones *Tx asumen una transacción SQLite abierta
 * por quien llama: o se aplica todo o nada (cierre inesperado incluido).
 */
const { toMilli, milliFromLegacyNumber } = require('./decimal');
const { sha256Hex, canonicalJson } = require('./canonical');

const MOVE_TYPE = { sale: 'sale', shortage: 'shortage', return: 'return', adjustment_in: 'adjustment_in', adjustment_out: 'adjustment_out' };

function resultHash(res) { return sha256Hex(canonicalJson(JSON.parse(JSON.stringify(res)))); }

/** Stock confirmado / provisional de un producto (V8 §16.1). */
function stockView(db, inventoryUuid) {
  const inv = db.prepare(`SELECT stock, stock_confirmed_milli AS c FROM inventory WHERE uuid=?`).get(inventoryUuid);
  if (!inv) return null;
  const pend = db.prepare(
    `SELECT COALESCE(SUM(delta_milli),0) AS d, COUNT(*) AS n FROM stock_movements
      WHERE inventory_uuid=? AND confirmation_state='provisional'`
  ).get(inventoryUuid);
  if (inv.c === null || inv.c === undefined) {
    return { confirmedMilli: null, pendingDeltaMilli: pend.d, provisionalMilli: milliFromLegacyNumber(inv.stock), pendingCount: pend.n, isProvisional: false, legacy: true };
  }
  return { confirmedMilli: inv.c, pendingDeltaMilli: pend.d, provisionalMilli: inv.c + pend.d, pendingCount: pend.n, isProvisional: pend.n > 0, legacy: false };
}

/** Refresca la caché inventory.stock (REAL, compatibilidad) = confirmado + provisional. */
function refreshStockCacheTx(db, inventoryUuid) {
  const v = stockView(db, inventoryUuid);
  if (!v || v.legacy) return;
  db.prepare(`UPDATE inventory SET stock=? WHERE uuid=?`).run(v.provisionalMilli / 1000, inventoryUuid);
}

function closeOutboxTx(db, operationId, status, res, now, note) {
  const row = db.prepare(`SELECT outbox_id, status FROM inventory_outbox WHERE operation_id=?`).get(operationId);
  if (!row) return false;
  if (status === 'applied') {
    db.prepare(
      `UPDATE inventory_outbox SET status='applied', response_payload=?, applied_at=?, lease_owner=NULL,
              lease_expires_at=NULL, resolution_note=COALESCE(?, resolution_note)
        WHERE outbox_id=? AND status IN ('claimed','pending','retry_wait')`
    ).run(JSON.stringify(res), now, note || null, row.outbox_id);
  } else if (status === 'conflict') {
    db.prepare(
      `UPDATE inventory_outbox SET status='conflict', last_error_code=?, last_error=?, response_payload=?,
              lease_owner=NULL, lease_expires_at=NULL
        WHERE outbox_id=? AND status IN ('claimed','pending','retry_wait')`
    ).run(res.reject_code || 'rejected', JSON.stringify(res.details || {}), JSON.stringify(res), row.outbox_id);
  }
  return true;
}

/**
 * Aplica un resultado autoritativo (respuesta de la RPC, evento propio o evento ajeno).
 * Idempotente por operation_id (applied_results). Nunca borra la venta ni duplica movimientos.
 * ctx: { source:'response'|'event', originDeviceId, deviceId, now, ownOperationId?, entityUuid? }
 * Lanza Error('inventory_unknown:<uuid>') si falta el producto local: el llamador revierte y detiene el cursor.
 */
function applyAuthoritativeResultTx(db, res, ctx) {
  const now = ctx.now ?? Date.now();
  const opId = res.operation_id;
  const ownOp = ctx.ownOperationId || opId;

  // Alias de deduplicación (V8.1 §16.2, C-03): si el servidor respondió con el resultado de OTRA operación
  // (deduplicated_of), la operación propia NO tuvo efecto en el stock. Sus movimientos provisionales se
  // descartan ('rejected') para que dejen de contar y no queden huérfanos; la fila de outbox propia se cierra
  // y la de la operación original (si existe en este dispositivo) se concilia con su propio resultado.
  const aliased = ownOp !== opId;
  const dropAliasProvisionals = () => {
    if (aliased) db.prepare(`UPDATE stock_movements SET confirmation_state='rejected' WHERE operation_id=? AND confirmation_state='provisional'`).run(ownOp);
  };
  const touchedByAlias = () => db.prepare(`SELECT DISTINCT inventory_uuid u FROM stock_movements WHERE operation_id=? AND inventory_uuid IS NOT NULL`).all(ownOp).map((r) => r.u);

  const seen = db.prepare(`SELECT 1 FROM applied_results WHERE operation_id=?`).get(opId);
  if (seen) {                                                   // reproceso: no-op, pero se cierra la outbox si seguía abierta
    if (aliased) { dropAliasProvisionals(); for (const u of touchedByAlias()) refreshStockCacheTx(db, u); }
    if (res.operation_status === 'rejected') closeOutboxTx(db, ownOp, 'conflict', res, now);
    else closeOutboxTx(db, ownOp, 'applied', res, now, aliased ? `deduplicated_of:${opId}` : null);
    return { noop: true };
  }

  if (res.operation_status === 'rejected') {
    closeOutboxTx(db, ownOp, 'conflict', res, now);             // movimientos siguen provisionales hasta resolver
    db.prepare(`INSERT INTO applied_results(operation_id,event_seq,source,result_hash,applied_at) VALUES (?,?,?,?,?)`)
      .run(opId, null, ctx.source, resultHash(res), now);
    return { rejected: true };
  }

  const isOwn = ctx.originDeviceId === ctx.deviceId;
  const orderUuid = (res.order && res.order.order_uuid) || ctx.entityUuid || null;
  const localOrder = orderUuid ? db.prepare(`SELECT id FROM orders WHERE uuid=?`).get(orderUuid) : null;
  const touched = new Set();
  const keep = new Set();

  for (const m of res.movements || []) {
    keep.add(`${m.line_id}|${m.kind}`);
    const inv = db.prepare(`SELECT id, name FROM inventory WHERE uuid=?`).get(m.inventory_uuid);
    if (!inv) throw new Error(`inventory_unknown:${m.inventory_uuid}`);
    touched.add(m.inventory_uuid);
    const req = toMilli(m.requested_qty), app = toMilli(m.applied_qty), sh = toMilli(m.shortage_qty);
    const delta = toMilli(m.stock_delta, { signed: true });
    const local = db.prepare(`SELECT id FROM stock_movements WHERE operation_id=? AND line_id=? AND kind=?`).get(opId, m.line_id, m.kind);
    if (local) {                                                 // reconciliar SOBRE LA MISMA FILA
      db.prepare(
        `UPDATE stock_movements SET requested_milli=?, applied_milli=?, shortage_milli=?, delta_milli=?,
                quantity=?, shortage_quantity=?, stock_before=?, stock_after=?, server_movement_id=?,
                confirmation_state='confirmed', updated_at=? WHERE id=?`
      ).run(req, app, sh, delta, m.kind === 'shortage' ? sh / 1000 : app / 1000, sh / 1000,
            toMilli(m.stock_before, { signed: true }) / 1000, toMilli(m.stock_after, { signed: true }) / 1000, m.movement_id, now, local.id);
    } else {                                                     // p. ej. el 'shortage' que calculó el servidor, o movimiento ajeno
      db.prepare(
        `INSERT OR IGNORE INTO stock_movements
           (inventory_id, product_name, movement_type, quantity, stock_before, stock_after, shortage_quantity,
            reference_type, reference_id, created_at, uuid, updated_at, device_id, deleted,
            inventory_uuid, operation_id, line_id, kind, requested_milli, applied_milli, shortage_milli, delta_milli,
            confirmation_state, origin, server_movement_id, source_operation_id)
         VALUES (?,?,?,?,?,?,?, ?,?,?,?,?,?,0, ?,?,?,?,?,?,?,?, 'confirmed',?,?,?)`
      ).run(inv.id, inv.name, MOVE_TYPE[m.kind] || m.kind, m.kind === 'shortage' ? sh / 1000 : app / 1000,
            toMilli(m.stock_before, { signed: true }) / 1000, toMilli(m.stock_after, { signed: true }) / 1000, sh / 1000,
            localOrder ? 'order' : null, localOrder ? localOrder.id : null, now, m.movement_id, now, ctx.originDeviceId || null,
            m.inventory_uuid, opId, m.line_id, m.kind, req, app, sh, delta,
            isOwn ? 'local' : 'remote', m.movement_id, m.source_operation_id || null);
    }
  }

  // Provisionales propios que el servidor no confirmó (p. ej. un faltante local que el servidor no registró): dejan de contar.
  if (isOwn) {
    const prov = db.prepare(`SELECT id, line_id, kind FROM stock_movements WHERE operation_id=? AND confirmation_state='provisional'`).all(opId);
    for (const p of prov) {
      if (!keep.has(`${p.line_id}|${p.kind}`)) db.prepare(`UPDATE stock_movements SET confirmation_state='rejected' WHERE id=?`).run(p.id);
    }
  }

  // Saldos confirmados con guarda por versión: un resultado viejo no retrocede el saldo.
  for (const i of res.inventory || []) {
    touched.add(i.inventory_uuid);
    const exists = db.prepare(`SELECT 1 FROM inventory WHERE uuid=?`).get(i.inventory_uuid);
    if (!exists) {
      if (i.name) continue;                                      // alta de catálogo: la crea la capa de catálogo
      throw new Error(`inventory_unknown:${i.inventory_uuid}`);
    }
    db.prepare(
      `UPDATE inventory SET stock_confirmed_milli=?, confirmed_version=? WHERE uuid=? AND ? > confirmed_version`
    ).run(toMilli(i.stock, { signed: true }), i.version, i.inventory_uuid, i.version);
  }
  for (const u of touched) refreshStockCacheTx(db, u);

  if (res.order && res.order.order_uuid) {
    db.prepare(
      `UPDATE orders SET remote_version=?, remote_status=? WHERE uuid=? AND ? >= COALESCE(remote_version,0)`
    ).run(res.order.version, res.order.status, res.order.order_uuid, res.order.version);
  }

  if (aliased) {
    const aliasInv = touchedByAlias();
    dropAliasProvisionals();
    for (const u of aliasInv) refreshStockCacheTx(db, u);
    closeOutboxTx(db, opId, 'applied', res, now);                 // la operación original, si es de este dispositivo
  }
  closeOutboxTx(db, ownOp, 'applied', res, now, aliased ? `deduplicated_of:${opId}` : null);
  db.prepare(`INSERT INTO applied_results(operation_id,event_seq,source,result_hash,applied_at) VALUES (?,?,?,?,?)`)
    .run(opId, res.event_seq ?? null, ctx.source, resultHash(res), now);
  return { applied: true };
}

function getCursor(db, restaurantId) {
  const r = db.prepare(`SELECT last_applied_seq AS s FROM sync_cursor WHERE restaurant_id=?`).get(restaurantId);
  return r ? r.s : 0;
}

/**
 * Procesa UN evento en orden estricto (V8 §15.4). Devuelve 'applied' | 'duplicate' | 'gap'.
 * Abre su propia transacción: el cursor avanza en la misma transacción que aplica el evento.
 */
function processEvent(db, restaurantId, ev, ctx) {
  const cursor = getCursor(db, restaurantId);
  if (ev.event_seq <= cursor) return 'duplicate';
  if (ev.event_seq !== cursor + 1) return 'gap';
  db.exec('BEGIN IMMEDIATE');
  try {
    const dupe = db.prepare(`SELECT 1 FROM sync_events_local WHERE event_id=?`).get(ev.event_id);
    if (!dupe) {
      db.prepare(
        `INSERT INTO sync_events_local(event_seq,event_id,operation_id,origin_device_id,is_own,payload_hash,applied_at)
         VALUES (?,?,?,?,?,?,?)`
      ).run(ev.event_seq, ev.event_id, ev.operation_id, ev.device_id, ev.device_id === ctx.deviceId ? 1 : 0, ev.payload_hash || null, ctx.now ?? Date.now());
      applyAuthoritativeResultTx(db, ev.payload, {
        source: 'event', originDeviceId: ev.device_id, deviceId: ctx.deviceId, now: ctx.now, entityUuid: ev.entity_uuid,
      });
    }
    db.prepare(
      `INSERT INTO sync_cursor(restaurant_id,last_applied_seq,updated_at) VALUES (?,?,?)
       ON CONFLICT(restaurant_id) DO UPDATE SET last_applied_seq=excluded.last_applied_seq, updated_at=excluded.updated_at`
    ).run(restaurantId, ev.event_seq, ctx.now ?? Date.now());
    db.exec('COMMIT');
    return 'applied';
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ya revertida */ }
    throw e;
  }
}

/** Reemplaza el saldo confirmado con el de un snapshot (resync_required). Mantiene los provisionales. */
function applySnapshot(db, restaurantId, snap, now = Date.now()) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const i of snap.inventory || []) {
      const ex = db.prepare(`SELECT 1 FROM inventory WHERE uuid=?`).get(i.inventory_uuid);
      if (!ex) continue;
      db.prepare(`UPDATE inventory SET stock_confirmed_milli=?, confirmed_version=? WHERE uuid=?`)
        .run(toMilli(i.stock, { signed: true }), i.version, i.inventory_uuid);
      refreshStockCacheTx(db, i.inventory_uuid);
    }
    db.prepare(
      `INSERT INTO sync_cursor(restaurant_id,last_applied_seq,updated_at) VALUES (?,?,?)
       ON CONFLICT(restaurant_id) DO UPDATE SET last_applied_seq=excluded.last_applied_seq, updated_at=excluded.updated_at`
    ).run(restaurantId, snap.last_event_seq, now);
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
}

module.exports = { stockView, refreshStockCacheTx, applyAuthoritativeResultTx, processEvent, applySnapshot, getCursor };
