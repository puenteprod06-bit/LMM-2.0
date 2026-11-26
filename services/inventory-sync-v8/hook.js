'use strict';
/**
 * Puente con el flujo de pedidos e inventario existente (routes/orders.js, routes/inventory.js).
 * SOLO actúa si LMM_INVENTORY_SYNC_V8=1.
 *
 * Se llama DENTRO de la transacción de la operación, para que operación +
 * movimientos provisionales + fila de outbox sean atómicos. No hace red.
 * Nunca lanza: un fallo aquí no puede romper la operación (se registra y
 * la operación sigue como antes).
 *
 * Alcance (V8 §4.7):
 *   - sale: creación de un pedido nuevo (ya existía).
 *   - modify: agregar ítems a una orden abierta existente (merge).
 *   - cancel: cancelar una orden y reintegrar su stock.
 *   - reopen: reabrir una orden cancelada/entregada.
 *   - return: devolver ítems de una orden (movimiento independiente de la venta).
 *   - adjust_in / adjust_out: ajuste manual de stock de inventario.
 */
const crypto = require('crypto');
const { fromMilli, milliFromLegacyNumber } = require('./decimal');
const outbox = require('./outbox');
const vouchers = require('./vouchers');

const OP_KINDS = new Set(outbox.OP_KINDS);

function moneyString(x) {
  const cents = Math.round((Number(x) || 0) * 100);
  const i = Math.floor(cents / 100);
  const f = String(cents % 100).padStart(2, '0').replace(/0+$/, '');
  return i + (f ? '.' + f : '');
}

function restaurantIdFromConfig(db) {
  try {
    const r = db.prepare('SELECT cloud_restaurant_id AS r FROM config LIMIT 1').get();
    if (r && r.r) return String(r.r);
  } catch (_) {}
  return 'local';
}

function deviceIdFromCtx(ctx) {
  return ctx.deviceId || (typeof require !== 'undefined' ? require('../db').DEVICE_ID : null) || 'local';
}

/**
 * Construye los ítems de intención a partir de las filas de order_items de una orden.
 * Cada ítem de inventario lleva inventory_uuid, qty como string canónico y unit_price.
 */
function buildIntentItems(db, orderId) {
  const rows = db.prepare(
    `SELECT id, uuid, itemType, invId, name, price, qty, note FROM order_items WHERE order_id=? ORDER BY id`
  ).all(orderId);
  const items = [];
  for (const r of rows) {
    let itemUuid = r.uuid;
    if (!itemUuid) {
      itemUuid = crypto.randomUUID();
      db.prepare('UPDATE order_items SET uuid=? WHERE id=?').run(itemUuid, r.id);
    }
    const isInv = r.itemType === 'inventory' && r.invId;
    let invUuid = null;
    if (isInv) {
      const inv = db.prepare('SELECT uuid FROM inventory WHERE id=?').get(r.invId);
      if (!inv || !inv.uuid) return null; // sin uuid de inventario no se puede sincronizar
      invUuid = inv.uuid;
    }
    const qtyMilli = milliFromLegacyNumber(r.qty);
    if (qtyMilli <= 0) continue;
    items.push({
      item_uuid: itemUuid,
      item_type: isInv ? 'inventory' : 'menu',
      inventory_uuid: invUuid,
      invId: r.invId || null,                  // clave numérica para casar con stock_movements.inventory_id
      name: String(r.name || 'item').slice(0, 200) || 'item',
      unit_price: moneyString(r.price),
      qty: fromMilli(qtyMilli),
      note: r.note ? String(r.note).slice(0, 500) : null,
    });
  }
  return items;
}

/**
 * Valida el vale offline antes de adjuntarlo a una operación. Nunca lanza.
 * Si no hay authorization_id, la operación sigue (puede no requerir vale).
 */
function checkedAuthorization(db, ctx, scope, { orderUuid = null, inventoryUuid = null } = {}) {
  if (!ctx.authorizationId) return { ok: true, authorizationId: null };
  const r = vouchers.validateForOperation(db, {
    authorizationId: ctx.authorizationId,
    deviceId: ctx.deviceId,
    scope,
    orderUuid,
    inventoryUuid,
  });
  if (!r.ok) return r;
  vouchers.markAttached(db, ctx.authorizationId);
  return { ok: true, authorizationId: ctx.authorizationId };
}

/**
 * Encola una operación de inventario/pedido en el outbox.
 * Devuelve el resultado de outbox.enqueue o { enqueued: false, reason }.
 */
function enqueueOp(db, { opKind, entityType, entityUuid, purposeSeq, intent, deviceId, restaurantId, clientActor, dependsOn }) {
  if (!OP_KINDS.has(opKind)) throw new Error(`op_kind inválido: ${opKind}`);
  const q = outbox.enqueue(db, {
    opKind, entityType, entityUuid, purposeSeq, intent, deviceId, restaurantId,
    clientActor, dependsOn,
  });
  return { enqueued: true, operationId: q.operationId, deduplicated: q.deduplicated, outboxId: q.outboxId };
}

/**
 * Marca los movimientos de stock de una orden (tipo sale/return) como provisionales
 * vinculados a una operación, para que el motor V8 los concilie con el resultado remoto.
 */
function markMovementsProvisional(db, orderId, operationId, firstItemByInv) {
  const moves = db.prepare(
    `SELECT m.id, m.inventory_id, m.movement_type, m.quantity, m.shortage_quantity, i.uuid AS inv_uuid
       FROM stock_movements m JOIN inventory i ON i.id = m.inventory_id
      WHERE m.reference_type='order' AND m.reference_id=? AND m.operation_id IS NULL
        AND (m.movement_type='sale' OR m.movement_type='return')
      ORDER BY m.id`
  ).all(orderId);
  const cursorByInv = new Map();
  for (const m of moves) {
    const list = firstItemByInv.get(m.inventory_id) || [];
    const key = `${m.inventory_id}|${m.movement_type}`;
    const k = cursorByInv.get(key) || 0;
    cursorByInv.set(key, k + 1);
    const lineId = list[Math.min(k, Math.max(0, list.length - 1))];
    if (!lineId) continue;
    const qtyM = milliFromLegacyNumber(m.quantity);
    const shM = m.movement_type === 'return' ? qtyM : milliFromLegacyNumber(m.shortage_quantity || 0);
    const applied = m.movement_type === 'sale' ? qtyM : 0;
    db.prepare(
      `UPDATE stock_movements SET operation_id=?, line_id=?, kind=?, inventory_uuid=?, requested_milli=?,
              applied_milli=?, shortage_milli=?, delta_milli=?, confirmation_state='provisional', origin='local'
        WHERE id=?`
    ).run(operationId, lineId, m.movement_type, m.inv_uuid, applied + shM, applied, shM, -applied, m.id);
  }
}

/**
 * Venta de un pedido nuevo (op 'sale'). Ya existía; se mantiene igual.
 */
function onOrderCreated(db, ctx) {
  try {
    const order = db.prepare('SELECT id, uuid FROM orders WHERE id=?').get(ctx.orderId);
    if (!order || !order.uuid) return { enqueued: false, reason: 'order_without_uuid' };

    const items = buildIntentItems(db, ctx.orderId);
    if (!items) return { enqueued: false, reason: 'inventory_without_uuid' };
    if (!items.length) return { enqueued: false, reason: 'no_items' };

    // Ítems de inventario de la orden, claveados por invId (numérico) para casar
    // con stock_movements.inventory_id al marcarlos provisionales.
    const firstItemByInv = new Map();
    for (const it of items) {
      if (it.item_type === 'inventory' && it.invId) {
        if (!firstItemByInv.has(it.invId)) firstItemByInv.set(it.invId, []);
        firstItemByInv.get(it.invId).push(it.item_uuid);
      }
    }

    const q = outbox.enqueue(db, {
      opKind: 'sale', entityType: 'order', entityUuid: order.uuid, purposeSeq: 0,
      intent: { expected_version: 0, snapshot: { origin: 'desktop' }, items, authorization_id: null },
      deviceId: ctx.deviceId, restaurantId: restaurantIdFromConfig(db), clientActor: ctx.userName || null,
    });
    if (!q) return { enqueued: false, reason: 'enqueue_failed' };

    markMovementsProvisional(db, ctx.orderId, q.operationId, firstItemByInv);
    return { enqueued: true, operationId: q.operationId, deduplicated: q.deduplicated };
  } catch (e) {
    return { enqueued: false, reason: 'error', error: e.message };
  }
}

/**
 * Modificación de una orden abierta (op 'modify'): agregar ítems.
 * expected_version = versión remota conocida de la orden (para control de versión del servidor).
 */
function onOrderModified(db, ctx) {
  try {
    const order = db.prepare('SELECT id, uuid FROM orders WHERE id=?').get(ctx.orderId);
    if (!order || !order.uuid) return { enqueued: false, reason: 'order_without_uuid' };

    const auth = checkedAuthorization(db, ctx, 'negative_stock', { orderUuid: order.uuid });
    if (!auth.ok) return { enqueued: false, reason: `authorization_${auth.reason}` };

    const items = buildIntentItems(db, ctx.orderId);
    if (!items) return { enqueued: false, reason: 'inventory_without_uuid' };
    if (!items.length) return { enqueued: false, reason: 'no_items' };

    // Ítems de inventario de la orden, claveados por invId (numérico) para casar
    // con stock_movements.inventory_id al marcarlos provisionales.
    const firstItemByInv = new Map();
    for (const it of items) {
      if (it.item_type === 'inventory' && it.invId) {
        if (!firstItemByInv.has(it.invId)) firstItemByInv.set(it.invId, []);
        firstItemByInv.get(it.invId).push(it.item_uuid);
      }
    }

    const q = outbox.enqueue(db, {
      opKind: 'modify', entityType: 'order', entityUuid: order.uuid, purposeSeq: Number(ctx.expectedVersion || 0),
      intent: {
        expected_version: Number(ctx.expectedVersion || 0),
        snapshot: { origin: 'desktop' }, items,
        authorization_id: auth.authorizationId,
      },
      deviceId: ctx.deviceId, restaurantId: restaurantIdFromConfig(db),
      clientActor: ctx.userName || null, dependsOn: ctx.dependsOnOperationId || null,
    });
    if (!q) return { enqueued: false, reason: 'enqueue_failed' };

    markMovementsProvisional(db, ctx.orderId, q.operationId, firstItemByInv);
    return { enqueued: true, operationId: q.operationId, deduplicated: q.deduplicated };
  } catch (e) {
    return { enqueued: false, reason: 'error', error: e.message };
  }
}

/**
 * Cancelación de una orden (op 'cancel'): reintegra stock y deja de ser modificable.
 */
function onOrderCancelled(db, ctx) {
  try {
    const order = db.prepare('SELECT id, uuid FROM orders WHERE id=?').get(ctx.orderId);
    if (!order || !order.uuid) return { enqueued: false, reason: 'order_without_uuid' };

    const q = outbox.enqueue(db, {
      opKind: 'cancel', entityType: 'order', entityUuid: order.uuid, purposeSeq: Number(ctx.expectedVersion || 0),
      intent: { expected_version: Number(ctx.expectedVersion || 0), snapshot: { origin: 'desktop' }, authorization_id: null },
      deviceId: ctx.deviceId, restaurantId: restaurantIdFromConfig(db),
      clientActor: ctx.userName || null, dependsOn: ctx.dependsOnOperationId || null,
    });
    if (!q) return { enqueued: false, reason: 'enqueue_failed' };

    // Los movimientos de devolución (return) de esta orden se marcan provisionales
    // vinculados a la operación de cancelación.
    const firstItemByInv = new Map(); // cancel no añade ítems; se usa solo para key de tipo return
    const rows = db.prepare(
      `SELECT id FROM order_items WHERE order_id=? ORDER BY id`
    ).all(ctx.orderId);
    // Ítems de inventario como referencia de línea (uno por ítem, repetido si hace falta)
    const invItems = rows.filter((r) => r.itemType === 'inventory' && r.invId);
    for (const r of invItems) {
      if (!firstItemByInv.has(r.invId)) firstItemByInv.set(r.invId, []);
      firstItemByInv.get(r.invId).push(r.uuid || crypto.randomUUID());
    }
    markMovementsProvisional(db, ctx.orderId, q.operationId, firstItemByInv);
    return { enqueued: true, operationId: q.operationId, deduplicated: q.deduplicated };
  } catch (e) {
    return { enqueued: false, reason: 'error', error: e.message };
  }
}

/**
 * Reapertura de una orden (op 'reopen'): vuelve a estar modificable.
 */
function onOrderReopened(db, ctx) {
  try {
    const order = db.prepare('SELECT id, uuid FROM orders WHERE id=?').get(ctx.orderId);
    if (!order || !order.uuid) return { enqueued: false, reason: 'order_without_uuid' };

    const q = outbox.enqueue(db, {
      opKind: 'reopen', entityType: 'order', entityUuid: order.uuid, purposeSeq: Number(ctx.expectedVersion || 0),
      intent: { expected_version: Number(ctx.expectedVersion || 0), snapshot: { origin: 'desktop' }, authorization_id: null },
      deviceId: ctx.deviceId, restaurantId: restaurantIdFromConfig(db),
      clientActor: ctx.userName || null, dependsOn: ctx.dependsOnOperationId || null,
    });
    return { enqueued: true, operationId: q.operationId, deduplicated: q.deduplicated };
  } catch (e) {
    return { enqueued: false, reason: 'error', error: e.message };
  }
}

/**
 * Devolución de ítems de una orden (op 'return'): movimiento independiente de la venta,
 * referencia source_operation_id a la venta original.
 */
function onOrderReturned(db, ctx) {
  try {
    const order = db.prepare('SELECT id, uuid FROM orders WHERE id=?').get(ctx.orderId);
    if (!order || !order.uuid) return { enqueued: false, reason: 'order_without_uuid' };

    const auth = checkedAuthorization(db, ctx, 'negative_stock', { orderUuid: order.uuid });
    if (!auth.ok) return { enqueued: false, reason: `authorization_${auth.reason}` };

    const items = ctx.items || [];
    const intentItems = [];
    for (const it of items) {
      const qtyMilli = milliFromLegacyNumber(it.qty);
      if (qtyMilli <= 0) continue;
      let invUuid = it.inventory_uuid;
      if (!invUuid && it.invId) {
        const inv = db.prepare('SELECT uuid FROM inventory WHERE id=?').get(it.invId);
        if (!inv || !inv.uuid) return { enqueued: false, reason: 'inventory_without_uuid' };
        invUuid = inv.uuid;
      }
      intentItems.push({
        item_uuid: it.item_uuid || crypto.randomUUID(),
        item_type: 'inventory',
        inventory_uuid: invUuid,
        name: String(it.name || 'item').slice(0, 200) || 'item',
        unit_price: moneyString(it.price),
        qty: fromMilli(qtyMilli),
        note: it.note ? String(it.note).slice(0, 500) : null,
      });
    }
    if (!intentItems.length) return { enqueued: false, reason: 'no_items' };

    const q = outbox.enqueue(db, {
      opKind: 'return', entityType: 'order', entityUuid: order.uuid, purposeSeq: Number(ctx.expectedVersion || 0),
      intent: {
        expected_version: Number(ctx.expectedVersion || 0),
        snapshot: { origin: 'desktop' }, items: intentItems,
        authorization_id: auth.authorizationId,
        source_operation_id: ctx.sourceOperationId || null,
      },
      deviceId: ctx.deviceId, restaurantId: restaurantIdFromConfig(db),
      clientActor: ctx.userName || null, dependsOn: ctx.dependsOnOperationId || null,
    });
    return { enqueued: true, operationId: q.operationId, deduplicated: q.deduplicated };
  } catch (e) {
    return { enqueued: false, reason: 'error', error: e.message };
  }
}

/**
 * Ajuste manual de stock de inventario (op 'adjust_in' / 'adjust_out').
 */
function onInventoryAdjusted(db, ctx) {
  try {
    const inv = db.prepare('SELECT uuid FROM inventory WHERE id=?').get(ctx.inventoryId);
    if (!inv || !inv.uuid) return { enqueued: false, reason: 'inventory_without_uuid' };

    const qtyMilli = milliFromLegacyNumber(ctx.qty);
    if (qtyMilli <= 0) return { enqueued: false, reason: 'qty_invalida' };

    const auth = checkedAuthorization(db, ctx, 'adjustment', { inventoryUuid: inv.uuid });
    if (!auth.ok) return { enqueued: false, reason: `authorization_${auth.reason}` };

    const q = outbox.enqueue(db, {
      opKind: ctx.opKind || 'adjust_in', entityType: 'inventory', entityUuid: inv.uuid,
      purposeSeq: Number(ctx.expectedVersion || 0),
      intent: {
        expected_version: Number(ctx.expectedVersion || 0),
        inventory_uuid: inv.uuid,
        qty: fromMilli(qtyMilli),
        reason: ctx.reason || null,
        authorization_id: auth.authorizationId,
      },
      deviceId: ctx.deviceId, restaurantId: restaurantIdFromConfig(db),
      clientActor: ctx.userName || null, dependsOn: ctx.dependsOnOperationId || null,
    });
    return { enqueued: true, operationId: q.operationId, deduplicated: q.deduplicated };
  } catch (e) {
    return { enqueued: false, reason: 'error', error: e.message };
  }
}

module.exports = {
  onOrderCreated,
  onOrderModified,
  onOrderCancelled,
  onOrderReopened,
  onOrderReturned,
  onInventoryAdjusted,
  moneyString,
  restaurantIdFromConfig,
  buildIntentItems,
  markMovementsProvisional,
  enqueueOp,
};
