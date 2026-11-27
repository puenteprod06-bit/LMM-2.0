'use strict';

const { Router } = require('express');
const logger = require('../logger');

const asyncHandler = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ============================================================
//  RUTAS DE ÓRDENES  —  /api/orders/*
// ============================================================
module.exports = function ordersRoutes(db, { requireSession, notifyChange }) {
  const router = Router();

  // ── Listas blancas (validación de entrada) ─────────────────
  const VALID_STATUSES = new Set([
    'pending', 'preparing', 'ready', 'delivered', 'cancelled', 'active'
  ]);
  const VALID_ITEM_STATUSES = new Set(['pending', 'preparing', 'ready', 'delivered', 'cancelled']);
  const VALID_AREAS = new Set(['cocina', 'bar', 'todas']);
  const VALID_TYPES = new Set(['dine-in', 'takeaway', 'delivery', 'mesa', 'rapida']);

  // ── Helpers ────────────────────────────────────────────────
  function rowToOrder(row, items) {
    return {
      id:            row.id,
      subtotal:      row.subtotal,
      tax:           row.tax,
      total:         row.total,
      discount:      row.discount,
      discountType:  row.discountType || 'percent',
      discountAmt:   row.discountAmt,
      commissionAmt: row.commissionAmt || 0,
      type:          row.type,
      tableId:       row.tableId,
      tableNumber:   row.tableNumber,
      customer:      row.customer || '',
      status:        row.status,
      paymentMethod: row.paymentMethod || null,
      waiterName:    row.waiterName || '',
      groupKey:      row.groupKey || null,
      taxRate:       row.taxRate || 0,
      createdAt:     row.createdAt,
      openedAt:      row.openedAt || null,
      closedAt:      row.closedAt || null,
      paidAt:        row.paidAt || null,
      items:         items || [],
    };
  }

  function getOrderItems(orderId) {
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT id, order_id, name, price, qty, lineTotal, note, itemType, invId, menuItemId, area,
                status, createdAt
           FROM order_items WHERE order_id = ? AND (deleted IS NULL OR deleted = 0)`,
        [orderId],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });
  }

  function getOrderById(id) {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM orders WHERE id = ?', [id], async (err, row) => {
        if (err) return reject(err);
        if (!row) return resolve(null);
        try {
          const items = await getOrderItems(id);
          resolve(rowToOrder(row, items));
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  // ── getOrderByIdSync — versión síncrona para usar dentro de transacciones ──
  function getOrderByIdSync(id) {
    const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!row) return null;
    const items = db.prepare(
      `SELECT id, order_id, name, price, qty, lineTotal, note, itemType, invId, menuItemId, area,
              status, createdAt
       FROM order_items WHERE order_id = ? AND (deleted IS NULL OR deleted = 0)`
    ).all(id);
    return rowToOrder(row, items);
  }

  // ── catalogMenuItemId — id real de menu_items de un ítem ──────────
  // OJO: `id` en GET /api/orders es order_items.id (fila), NO menu_items.id.
  // El cliente reenvía `menuItemId` para desambiguar:
  //   · presente y numérico → id de catálogo (se valida el precio);
  //   · presente y null     → fila legacy sin catálogo (se conserva snapshot);
  //   · ausente             → viene del POS como id de menú (compatibilidad).
  function catalogMenuItemId(item) {
    if (!item || item.itemType !== 'menu') return null;
    if (Object.prototype.hasOwnProperty.call(item, 'menuItemId')) {
      if (item.menuItemId == null) return null;
      const n = Number(item.menuItemId);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    if (item.id == null) return null;
    const n = Number(item.id);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // ── getAuthorizedPrice — obtiene el precio autorizado desde SQLite ──
  //  menu → menu_items.price
  //  inventory → inventory.salePrice
  //  combo/otro / filas legacy sin precio → null (sin fuente autoritativa;
  //  se conserva el precio enviado por el cliente como snapshot).
  //  Un precio de BD ausente, nulo o cero NO autoriza un precio: solo indica
  //  que no hay referencia contra la cual verificar.
  function getAuthorizedPrice(item) {
    const menuId = catalogMenuItemId(item);
    if (menuId) {
      const row = db.prepare('SELECT price FROM menu_items WHERE id = ?').get(menuId);
      if (!row) throw new Error(`Producto de menú no encontrado: ${menuId}`);
      const price = Number(row.price);
      return Number.isFinite(price) && price > 0 ? price : null;
    }
    if (item.itemType === 'inventory' && item.invId != null && !Number.isNaN(Number(item.invId))) {
      const row = db.prepare(
        `SELECT salePrice FROM inventory WHERE id = ? AND (deleted IS NULL OR deleted = 0)`
      ).get(Number(item.invId));
      if (!row) throw new Error(`Producto de inventario no encontrado: ${item.invId}`);
      const price = Number(row.salePrice);
      return Number.isFinite(price) && price > 0 ? price : null;
    }
    return null;
  }

  // ── callV8Hook — puente opcional con la sincronización V8 ──────────
  //  Llamar DENTRO de la transacción. Nunca lanza: un fallo del hook no puede
  //  romper la operación local. Con LMM_INVENTORY_SYNC_V8 !== '1' no hace nada.
  function callV8Hook(name, ctx) {
    try {
      const v8 = require('../services/inventory-sync-v8');
      if (!v8.isEnabled()) return;
      const r = v8.hook[name](db._native, {
        ...ctx,
        deviceId: ctx.deviceId || require('../db').DEVICE_ID,
      });
      if (!r.enqueued) logger.warn(`[INV-V8] ${name} no encolado (${r.reason}${r.error ? ': ' + r.error : ''})`);
    } catch (e) {
      logger.warn(`[INV-V8] hook ${name} falló: ${e.message}`);
    }
  }

  // ── calculateOrderTotals — calcula todos los importes en el servidor ──
  //  Reglas:
  //    subtotal   = sum(price * qty)  (precios de BD)
  //    discountAmt = percent ? subtotal * discount/100 : discount  (fixed)
  //    taxableBase = max(0, subtotal - discountAmt)
  //    tax         = taxableBase * taxRate / 100
  //    total       = taxableBase + tax
  function calculateOrderTotals(items, discount, discountType, taxRate) {
    let subtotal = 0;
    for (const item of items) {
      subtotal += Number(item.price) * Number(item.qty);
    }
    subtotal = Number(subtotal.toFixed(2));

    let discountAmt = 0;
    if (discountType === 'percent') {
      discountAmt = subtotal * (Number(discount) / 100);
    } else if (discountType === 'fixed') {
      discountAmt = Number(discount);
    }
    discountAmt = Number(discountAmt.toFixed(2));
    if (discountAmt < 0) discountAmt = 0;
    if (discountAmt > subtotal) discountAmt = subtotal;

    const taxableBase = Math.max(0, subtotal - discountAmt);
    const tax = Number((taxableBase * (Number(taxRate) / 100)).toFixed(2));
    const total = Number((taxableBase + tax).toFixed(2));

    return { subtotal, discountAmt, tax, total };
  }

  // ── checkStockShortages — verifica si algún ítem dejaría stock negativo ──
  //  Retorna un array de shortages (vacío si todo el stock es suficiente).
  //  No modifica la base de datos.
  function checkStockShortages(items) {
    const shortages = [];
    const selectStmt = db.prepare(
      `SELECT id, name, stock FROM inventory WHERE id = ? AND (deleted IS NULL OR deleted = 0)`
    );
    for (const item of items) {
      if (item && item.itemType === 'inventory' && item.invId) {
        const qty = Number(item.qty) || 0;
        if (qty > 0) {
          const inv = selectStmt.get(item.invId);
          if (inv) {
            const available = Number(inv.stock) || 0;
            const shortage = Math.max(0, qty - available);
            if (shortage > 0) {
              shortages.push({
                invId: item.invId,
                name: inv.name,
                available,
                requested: qty,
                shortage,
              });
            }
          }
        }
      }
    }
    return shortages;
  }

  // ── applyStockDiscount — descuenta stock según autorización admin ──
  //  Regla comercial:
  //    - Sin autorización: descuenta solo stock disponible (stock → 0, faltante registrado)
  //    - Con autorización: descuenta toda la cantidad (stock puede quedar negativo)
  //  Retorna: { shortages: [...], hasShortage: boolean }
  //  También registra movimientos en stock_movements si se proporciona ctx.
  function applyStockDiscount(items, isAdminAuthorized, ctx = {}) {
    const shortages = [];
    const updateStmt = db.prepare(
      `UPDATE inventory SET stock = COALESCE(stock,0) - ? WHERE id = ? AND (deleted IS NULL OR deleted = 0)`
    );
    const selectStmt = db.prepare(
      `SELECT id, name, stock FROM inventory WHERE id = ? AND (deleted IS NULL OR deleted = 0)`
    );

    const { recordStockMovement } = require('../db');

    for (const item of items) {
      if (item && item.itemType === 'inventory' && item.invId) {
        const qty = Number(item.qty) || 0;
        if (qty > 0) {
          const inv = selectStmt.get(item.invId);
          if (inv) {
            const available = Number(inv.stock) || 0;
            const shortage = Math.max(0, qty - available);

            if (shortage > 0) {
              shortages.push({
                invId: item.invId,
                name: inv.name,
                available,
                requested: qty,
                shortage,
              });
            }

            // Calcular cantidad a descontar
            const actualQty = isAdminAuthorized ? qty : Math.min(qty, available);

            if (actualQty > 0) {
              updateStmt.run(actualQty, item.invId);

              // Registrar movimiento de venta en stock_movements
              recordStockMovement({
                inventoryId: item.invId,
                productName: inv.name,
                movementType: 'sale',
                quantity: actualQty,
                stockBefore: available,
                stockAfter: available - actualQty,
                shortageQuantity: shortage,
                referenceType: ctx.referenceType || 'order',
                referenceId: ctx.referenceId || null,
                authorizedBy: isAdminAuthorized ? (ctx.userName || null) : null,
                userName: ctx.userName || null,
                userRole: ctx.userRole || null,
                idempotencyKey: ctx.referenceId
                  ? `order-${ctx.referenceId}-sale-${item.invId}-${actualQty}`
                  : null,
              });
            }

            // Registrar faltante si hay
            if (shortage > 0) {
              recordStockMovement({
                inventoryId: item.invId,
                productName: inv.name,
                movementType: 'shortage',
                quantity: shortage,
                stockBefore: available - actualQty,
                stockAfter: available - actualQty,
                shortageQuantity: shortage,
                referenceType: ctx.referenceType || 'order',
                referenceId: ctx.referenceId || null,
                authorizedBy: isAdminAuthorized ? (ctx.userName || null) : null,
                userName: ctx.userName || null,
                userRole: ctx.userRole || null,
                idempotencyKey: ctx.referenceId
                  ? `order-${ctx.referenceId}-shortage-${item.invId}-${shortage}`
                  : null,
              });
            }
          }
        }
      }
    }

    return { shortages, hasShortage: shortages.length > 0 };
  }

  // ── isAdminSession — verifica si la sesión actual es de administrador ──
  //  No confía en datos del frontend. Lee la sesión de SQLite.
  //  Owner (role='owner', is_client=0) o empleado con role='admin' (is_client=1).
  function isAdminSession(session) {
    if (!session) return false;
    if (session.role === 'owner' && (session.is_client === 0 || session.is_client === '0')) return true;
    if (session.role === 'admin' && (session.is_client === 1 || session.is_client === '1')) return true;
    return false;
  }
  // Returns all non-cancelled orders with their items
  router.get('/', requireSession, asyncHandler(async (req, res) => {
    db.all(
      `SELECT * FROM orders WHERE status != 'cancelled' AND (deleted IS NULL OR deleted = 0) ORDER BY createdAt DESC`,
      [],
      async (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        try {
          const orders = await Promise.all(
            (rows || []).map(async row => {
              const items = await getOrderItems(row.id);
              return rowToOrder(row, items);
            })
          );
          res.json(orders);
        } catch (e) {
          res.status(500).json({ error: e.message });
        }
      }
    );
  }));

  // ── POST /api/orders/finalize  ─────────────────────────────
  // Creates a new order (or merges into existing table order)
  // Todos los importes se calculan en el servidor a partir de precios de BD.
  // Toda la operación (orden + ítems + stock) se ejecuta en una transacción.
  router.post('/finalize', requireSession, asyncHandler(async (req, res) => {
    const {
      items, discount, discountType, taxRate,
      type, tableId, tableNumber, customer, status, waiterName,
      adminAuthorized, // explícita autorización de admin para stock negativo
    } = req.body;

    if (!items || !items.length) {
      return res.status(400).json({ error: 'No hay ítems en el pedido' });
    }

    // ── Validación de campos de control ───────────────────────────
    const nDiscount = Number(discount || 0);
    const nDiscountType = discountType || 'percent';
    const nTaxRate = Number(taxRate || 0);

    if (!Number.isFinite(nDiscount) || nDiscount < 0) {
      return res.status(400).json({ error: 'Descuento inválido' });
    }
    if (nDiscountType !== 'percent' && nDiscountType !== 'fixed') {
      return res.status(400).json({ error: 'Tipo de descuento inválido' });
    }
    if (!Number.isFinite(nTaxRate) || nTaxRate < 0) {
      return res.status(400).json({ error: 'Tasa de impuesto inválida' });
    }

    // ── Validar ítems y obtener precios autorizados de BD ─────────
    const safeItems = [];
    for (const item of items) {
      if (!item || typeof item.name !== 'string' || !item.name.trim()) {
        return res.status(400).json({ error: 'Cada ítem debe tener name' });
      }
      const qty = Number(item.qty) || 0;
      if (!Number.isFinite(qty) || qty <= 0) {
        return res.status(400).json({ error: 'Cantidad inválida' });
      }

      let authorizedPrice;
      try {
        authorizedPrice = getAuthorizedPrice(item);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }

      // ── Verificación de precio contra fuente autoritativa ──
      // Si hay precio de catálogo, el precio del cliente debe coincidir
      // (tolerancia 0.01); si no coincide se rechaza con UNAUTHORIZED_PRICE.
      // Sin precio de catálogo (ítems combo/otro o filas legacy sin precio)
      // se conserva el precio enviado como snapshot y se registra el hecho.
      let price = authorizedPrice;
      if (authorizedPrice === null) {
        price = Number(item.price) || 0;
        logger.debug(`[PRICE] Sin precio autoritativo para ${item.itemType} ${item.id || item.invId || item.name}; se usa snapshot del cliente`);
      } else if (item.price !== undefined && item.price !== null) {
        const clientPrice = Number(item.price);
        if (Number.isFinite(clientPrice) && Math.abs(clientPrice - authorizedPrice) > 0.01) {
          return res.status(400).json({
            error: 'Precio de ítem no autorizado: no coincide con el precio del catálogo',
            code: 'UNAUTHORIZED_PRICE',
          });
        }
      }

      safeItems.push({
        name: item.name.trim(),
        price,
        qty,
        note: item.note || '',
        itemType: item.itemType || 'menu',
        invId: item.invId || null,
        menuItemId: catalogMenuItemId(item),
        area: (item.area || 'cocina').toLowerCase(),
        lineTotal: price * qty,
      });
    }

    // ── Idempotencia: si ya existe una orden activa con los mismos items, no re-descontar ──
    // (cubre el caso reopen + re-finalize: la orden ya fue re-descontada al reabrir)
    try {
      const activeOrders = db.prepare(
        `SELECT o.id FROM orders o WHERE o.status NOT IN ('delivered','cancelled') AND o.paymentMethod IS NULL`
      ).all();
      for (const ao of activeOrders) {
        const aoItems = db.prepare(
          `SELECT invId, qty, itemType FROM order_items WHERE order_id = ? AND (deleted IS NULL OR deleted = 0)`
        ).all(ao.id);
        // Comparar items de inventario
        const reqInv = safeItems.filter(i => i.itemType === 'inventory' && i.invId).map(i => ({ invId: i.invId, qty: i.qty })).sort((a,b) => a.invId - b.invId);
        const aoInv = aoItems.filter(i => i.itemType === 'inventory' && i.invId).map(i => ({ invId: i.invId, qty: Number(i.qty) })).sort((a,b) => a.invId - b.invId);
        // Solo considerar no-op si la orden fue cancelada y reabierta (tiene movimiento 'return')
        const hasReturn = db.prepare(
          "SELECT COUNT(*) AS c FROM stock_movements WHERE reference_id = ? AND movement_type = 'return'"
        ).get(ao.id).c > 0;
        if (hasReturn && reqInv.length > 0 && reqInv.length === aoInv.length && reqInv.every((r, idx) => r.invId === aoInv[idx].invId && r.qty === aoInv[idx].qty)) {
          // Orden reabierta con items idénticos → devolver sin descontar
          const existingOrder = getOrderByIdSync(ao.id);
          return res.json({ success: true, merged: false, id: ao.id, order: existingOrder, shortages: undefined });
        }
      }
    } catch (e) {
      // Si falla la verificación, continuar normalmente
    }

    // ── Calcular todos los importes en el servidor ─────────────────
    const { subtotal, discountAmt, tax, total } = calculateOrderTotals(
      safeItems, nDiscount, nDiscountType, nTaxRate
    );

    // ── Pre-verificación de stock (UX rápida, no es la verificación definitiva) ──
    const preShortages = checkStockShortages(safeItems);
    const preHasShortage = preShortages.length > 0;

    if (preHasShortage) {
      const isAdmin = isAdminSession(req.session);
      const isAuthorized = adminAuthorized === true && isAdmin;

      if (!isAuthorized) {
        // No hay autorización: informar al frontend pero NO rechazar la venta.
        // El stock se limitará a lo disponible (stock → 0) sin autorización.
        logger.info(
          `[INVENTORY] Stock insuficiente sin autorización: ${preShortages.map(s => `${s.name}: ${s.available} disp, ${s.requested} solicitado, faltante ${s.shortage}`).join('; ')}`
        );
      } else {
        logger.info(
          `[INVENTORY] Stock negativo autorizado por ${req.session.name || 'admin'} ` +
          `(${req.session.role}): ${preShortages.map(s => `${s.name}: ${s.available} disp, ${s.requested} solicitado, faltante ${s.shortage}`).join('; ')}`
        );
      }
    }

    const now = Date.now();

    try {
      // Toda la operación en una transacción atómica
      const tx = db._native.transaction(() => {
        let orderId;

        // ── VERIFICACIÓN DEFINITIVA DE STOCK (dentro de la transacción) ──
        //  Re-verificamos dentro de la transacción para evitar la condición
        //  de carrera: otra operación pudo haber cambiado el stock entre
        //  la pre-verificación y la transacción.
        // txShortages removed - reconciliation handles stock now

        // Determinar autorización admin (basada en sesión SQLite, no frontend)
        const txIsAdmin = isAdminSession(req.session);
        const txIsAuthorized = adminAuthorized === true && txIsAdmin;

        // Verificar si ya existe una orden abierta (no pagada) para esta mesa (dine-in)
        if (type === 'dine-in' && tableId) {
          const existing = db.prepare(
            `SELECT id FROM orders
              WHERE tableId = ? AND status NOT IN ('delivered','cancelled')
                AND paymentMethod IS NULL
              ORDER BY createdAt ASC LIMIT 1`
          ).get(tableId);

          if (existing) {
            // ── MERGE: agregar ítems a la orden existente ───────────
            orderId = existing.id;
            const stmtItems = db.prepare(
              `INSERT INTO order_items
                 (order_id, name, price, qty, lineTotal, note, itemType, invId, menuItemId, area, status, createdAt)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
            );
            for (const item of safeItems) {
              stmtItems.run(
                orderId, item.name, item.price, item.qty, item.lineTotal,
                item.note, item.itemType, item.invId, item.menuItemId, item.area, now
              );
            }

            // Recalcular totales sumando a los existentes
            const existingOrder = db.prepare(
              `SELECT subtotal, tax, total, discountAmt FROM orders WHERE id = ?`
            ).get(orderId);
            const newSubtotal = Number(existingOrder.subtotal) + subtotal;
            const newTax = Number(existingOrder.tax) + tax;
            const newTotal = Number(existingOrder.total) + total;
            const newDiscountAmt = Number(existingOrder.discountAmt) + discountAmt;
            db.prepare(
              `UPDATE orders SET subtotal = ?, tax = ?, total = ?, discountAmt = ?, updatedAt = ? WHERE id = ?`
            ).run(newSubtotal, newTax, newTotal, newDiscountAmt, now, orderId);

            // Aplicar descuento de stock según autorización (dentro de la transacción)
            const stockResult = applyStockDiscount(safeItems, txIsAuthorized, {
              referenceType: 'order',
              referenceId: orderId,
              userName: req.session.name || null,
              userRole: req.session.role || null,
            });

            // Registrar faltantes en log
            if (stockResult.hasShortage) {
              logger.info(
                `[INVENTORY] Faltante registrado en merge: ${stockResult.shortages.map(s => `${s.name}: disponible=${s.available}, solicitado=${s.requested}, faltante=${s.shortage}, autorizado=${txIsAuthorized}`).join('; ')}`
              );
            }

            // V8: el merge es una operación 'modify' de la orden abierta.
            callV8Hook('onOrderModified', {
              orderId,
              expectedVersion: req.body.expectedVersion,
              authorizationId: req.body.authorizationId || null,
              userName: req.session.name || null,
            });

            const merged = getOrderByIdSync(orderId);
            return { merged, orderId, isMerge: true, hasShortage: stockResult.hasShortage, shortages: stockResult.shortages };
          }
        }

        // ── CREAR orden nueva ───────────────────────────────────────
        db._native.prepare(
          `INSERT INTO orders
             (subtotal, tax, total, discount, discountType, discountAmt,
              type, tableId, tableNumber, customer, status, waiterName, taxRate, createdAt, openedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            subtotal, tax, total, nDiscount, nDiscountType, discountAmt,
            type, tableId || null, tableNumber || null, customer || '',
            status || 'pending', waiterName || '', nTaxRate, now, now,
          ]
        ).run(
          subtotal, tax, total, nDiscount, nDiscountType, discountAmt,
          type, tableId || null, tableNumber || null, customer || '',
          status || 'pending', waiterName || '', nTaxRate, now, now
        );
        orderId = db._native.prepare('SELECT last_insert_rowid() as id').get().id;

        const stmtItems = db.prepare(
          `INSERT INTO order_items
             (order_id, name, price, qty, lineTotal, note, itemType, invId, menuItemId, area, status, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
        );
        for (const item of safeItems) {
          stmtItems.run(
            orderId, item.name, item.price, item.qty, item.lineTotal,
            item.note, item.itemType, item.invId, item.menuItemId, item.area, now
          );
        }

        // Aplicar descuento de stock según autorización (dentro de la transacción)
        const stockResult = applyStockDiscount(safeItems, txIsAuthorized, {
          referenceType: 'order',
          referenceId: orderId,
          userName: req.session.name || null,
          userRole: req.session.role || null,
        });

        // Registrar faltantes en log
        if (stockResult.hasShortage) {
          logger.info(
            `[INVENTORY] Faltante registrado: ${stockResult.shortages.map(s => `${s.name}: disponible=${s.available}, solicitado=${s.requested}, faltante=${s.shortage}, autorizado=${txIsAuthorized}`).join('; ')}`
          );
        }

        // V8 (apagado por defecto): encola la venta y marca los movimientos
        // como provisionales dentro de la transacción.
        callV8Hook('onOrderCreated', {
          orderId, userName: req.session.name || null, authorized: txIsAuthorized,
        });

        const newOrder = getOrderByIdSync(orderId);
        return { newOrder, orderId, isMerge: false, hasShortage: stockResult.hasShortage, shortages: stockResult.shortages };
      });

      const txResult = tx();

      // Notificar FUERA de la transacción (después del commit)
      if (txResult.isMerge) {
        notifyChange('data:updated', { source: 'orders/finalize' });
        notifyChange('orders:updated', txResult.merged);
        return res.json({ ...txResult.merged, success: true, merged: true, id: txResult.orderId, shortages: txResult.hasShortage ? txResult.shortages : undefined });
      } else {
        notifyChange('new_order', { orderId: txResult.orderId });
        notifyChange('orders:updated', txResult.newOrder);
        return res.json({ ...txResult.newOrder, success: true, merged: false, id: txResult.orderId, shortages: txResult.hasShortage ? txResult.shortages : undefined });
      }
    } catch (err) {
      if (err.code === 'STOCK_SHORTAGE') {
        return res.status(400).json({
          error: err.message,
          code: 'STOCK_SHORTAGE',
          shortages: err.shortages,
        });
      }
      return res.status(500).json({ error: err.message });
    }
  }));

  // ── POST /api/orders/pay  ──────────────────────────────────
  router.post('/pay', requireSession, asyncHandler(async (req, res) => {
    const { id, method, total, commission, openedAt, closedAt } = req.body;
    if (!id || !method) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', error: 'id y method son requeridos' });
    }
    // Validación de entrada: total/commission deben ser números finitos no negativos
    // si se envían (evita guardar NaN/valores corruptos en la base).
    const nTotal = total !== undefined && total !== null ? Number(total) : null;
    const nCommission = commission !== undefined && commission !== null ? Number(commission) : null;
    if (nTotal !== null && (!Number.isFinite(nTotal) || nTotal < 0)) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', error: 'total inválido' });
    }
    if (nCommission !== null && (!Number.isFinite(nCommission) || nCommission < 0)) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', error: 'commission inválido' });
    }

    const order = await getOrderById(id);
    if (!order) {
      return res.status(404).json({ code: 'ORDER_NOT_FOUND', error: 'Orden no encontrada' });
    }
    // Idempotencia: si la orden ya fue pagada/cerrada, no se vuelve a procesar.
    if (order.paymentMethod) {
      return res.status(404).json({ code: 'ORDER_NOT_FOUND', error: 'La orden ya está cerrada' });
    }

    const now = Date.now();
    // Seguridad de totales: el total de la orden se deriva SIEMPRE de la base
    // de datos, nunca del input del cliente. El cliente no puede ni bajar ni
    // INFLAR el total (evita cobrar de más). La única variación permitida es
    // la comisión por método de pago, que se suma server-side desde dbTotal.
    const dbTotal = Number(order.total) || 0;
    const finalTotal = dbTotal + (nCommission ?? 0);

    try {
      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE orders
              SET paymentMethod = ?, status = 'delivered',
                  total = ?, commissionAmt = COALESCE(?, commissionAmt),
                  closedAt = ?, paidAt = ?, updatedAt = ?
            WHERE id = ?`,
          [method, finalTotal, nCommission, closedAt || now, now, now, id],
          function (err) {
            if (err) return reject(err);
            if (this.changes === 0) {
              return reject(Object.assign(new Error('ORDER_NOT_FOUND'), { status: 404 }));
            }
            resolve();
          }
        );
      });
    } catch (err) {
      if (err.status === 404) {
        return res.status(404).json({ code: 'ORDER_NOT_FOUND', error: 'Orden no encontrada' });
      }
      throw err;
    }

    // Liberar la mesa asociada a una orden dine-in al cerrarla.
    if (order.type === 'dine-in' && order.tableId) {
      await new Promise((resolve) => {
        db.run(
          `UPDATE tables
              SET status = 'available', currentOrderId = NULL,
                  waiterId = NULL, waiterName = NULL, openedAt = NULL, guests = NULL
            WHERE id = ?`,
          [order.tableId],
          () => resolve()
        );
      });
    }

    const updated = await getOrderById(id);
    notifyChange('data:updated', { source: 'orders/pay', orderId: id });
    notifyChange('orders:updated', updated);
    res.json({ success: true, order: updated });
  }));

  // ── POST /api/orders/update-status  ───────────────────────
  router.post('/update-status', requireSession, asyncHandler(async (req, res) => {
    const { id, status } = req.body;
    if (!id || !status) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', error: 'id y status son requeridos' });
    }
    if (!VALID_STATUSES.has(status)) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', error: 'status inválido' });
    }
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', error: 'id inválido' });
    }

    // ── Cancelación: reintegrar stock ──
    if (status === 'cancelled') {
      try {
        const tx = db._native.transaction(() => {
          const existing = db.prepare('SELECT id, status, createdAt, updatedAt FROM orders WHERE id = ?').get(numericId);
          if (!existing) throw new Error('ORDER_NOT_FOUND');
          // Idempotencia: si ya está cancelado, no hacer nada
          if (existing.status === 'cancelled') {
            return { alreadyCancelled: true };
          }

          const orderStateId = existing.updatedAt || existing.createdAt || 0;

          // Leer items activos
          const items = db.prepare(
            `SELECT invId, qty FROM order_items WHERE order_id = ? AND (deleted IS NULL OR deleted = 0) AND itemType = 'inventory'`
          ).all(numericId);

          // Agrupar por invId
          const qtyByInv = {};
          for (const it of items) {
            if (it.invId) {
              qtyByInv[it.invId] = (qtyByInv[it.invId] || 0) + (Number(it.qty) || 0);
            }
          }

          const reconcileShortages = [];
          for (const invId of Object.keys(qtyByInv).map(Number)) {
            const prevQty = qtyByInv[invId];
            // Cantidad efectivamente descontada
            const saleRows = db.prepare(
              "SELECT COALESCE(SUM(quantity),0) AS s FROM stock_movements WHERE reference_type = 'order' AND reference_id = ? AND inventory_id = ? AND movement_type = 'sale'"
            ).get(numericId, invId);
            const returnRows = db.prepare(
              "SELECT COALESCE(SUM(quantity),0) AS s FROM stock_movements WHERE reference_type = 'order' AND reference_id = ? AND inventory_id = ? AND movement_type = 'return'"
            ).get(numericId, invId);
            const effectivePrev = Math.max(0, (Number(saleRows.s) || 0) - (Number(returnRows.s) || 0));

            if (effectivePrev > 0) {
              db.prepare(
                "UPDATE inventory SET stock = COALESCE(stock,0) + ? WHERE id = ? AND (deleted IS NULL OR deleted = 0)"
              ).run(effectivePrev, invId);

              const inv = db.prepare(
                "SELECT id, name, stock FROM inventory WHERE id = ? AND (deleted IS NULL OR deleted = 0)"
              ).get(invId);

              const { recordStockMovement } = require('../db');
              recordStockMovement({
                inventoryId: invId,
                productName: inv ? inv.name : 'Producto',
                movementType: 'return',
                quantity: effectivePrev,
                stockBefore: inv ? inv.stock - effectivePrev : 0,
                stockAfter: inv ? inv.stock : effectivePrev,
                shortageQuantity: 0,
                referenceType: 'order',
                referenceId: numericId,
                authorizedBy: null,
                userName: req.session.name || null,
                userRole: req.session.role || null,
                idempotencyKey: "order-" + numericId + "-cancel-" + orderStateId + "-return-" + invId + "-" + effectivePrev,
              });
            }
          }

          // Actualizar estado
          db.prepare(
            `UPDATE orders SET status = ?, updatedAt = ? WHERE id = ?`
          ).run('cancelled', Date.now(), numericId);

          // V8: cancelación con reintegro de stock (op 'cancel').
          callV8Hook('onOrderCancelled', {
            orderId: numericId,
            expectedVersion: req.body.expectedVersion,
            userName: req.session.name || null,
          });

          return { alreadyCancelled: false };
        });

        const txResult = tx();
        notifyChange('data:updated', { source: 'orders/update-status', orderId: numericId });
        res.json({ success: true, changes: txResult.alreadyCancelled ? 0 : 1 });
      } catch (err) {
        if (err.message === 'ORDER_NOT_FOUND') {
          return res.status(404).json({ code: 'ORDER_NOT_FOUND', error: err.message });
        }
        return res.status(500).json({ error: err.message });
      }
      return;
    }

    // ── Otros estados: solo actualizar ──
    db.run(
      `UPDATE orders SET status = ?, updatedAt = ? WHERE id = ?`,
      [status, Date.now(), numericId],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        notifyChange('data:updated', { source: 'orders/update-status', orderId: numericId });
        res.json({ success: true, changes: this.changes });
      }
    );
  }));

  // ── POST /api/orders/update-table  ────────────────────────
  router.post('/update-table', requireSession, asyncHandler(async (req, res) => {
    const { orderId, newTableId, type, groupKey } = req.body;
    if (!orderId) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', error: 'orderId es requerido' });
    }
    const sets = ['tableId = ?', 'updatedAt = ?'];
    const params = [newTableId !== undefined ? newTableId : null, Date.now()];
    // Whitelist de type: si viene uno inválido se descarta (no se persiste).
    if (type && VALID_TYPES.has(type)) {
      sets.push('type = ?');
      params.push(type);
    }
    // groupKey es solo local: une órdenes de una mesa fusionada para cobrar
    // e imprimir una única cuenta. Nunca viaja a la nube (no es campo V8).
    if (groupKey !== undefined) {
      sets.push('groupKey = ?');
      params.push(groupKey == null || groupKey === '' ? null : String(groupKey).slice(0, 80));
    }
    params.push(orderId);

    db.run(
      `UPDATE orders SET ${sets.join(', ')} WHERE id = ?`,
      params,
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        notifyChange('data:updated', { source: 'orders/update-table', orderId });
        res.json({ success: true });
      }
    );
  }));

  // ── POST /api/orders/modify-items  ────────────────────────
  router.post('/modify-items', requireSession, asyncHandler(async (req, res) => {
    const { orderId, items, discount, discountType, taxRate, adminAuthorized } = req.body;
    if (!orderId || !Array.isArray(items)) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', error: 'orderId e items son requeridos' });
    }
    if (!items.length) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', error: 'items no puede ser vacío' });
    }

    // ── Validación de campos de control ───────────────────────────
    const nDiscount = Number(discount || 0);
    const nDiscountType = discountType || 'percent';
    const nTaxRate = Number(taxRate || 0);
    if (!Number.isFinite(nDiscount) || nDiscount < 0) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', error: 'Descuento inválido' });
    }
    if (nDiscountType !== 'percent' && nDiscountType !== 'fixed') {
      return res.status(400).json({ code: 'VALIDATION_ERROR', error: 'Tipo de descuento inválido' });
    }
    if (!Number.isFinite(nTaxRate) || nTaxRate < 0) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', error: 'Tasa de impuesto inválido' });
    }

    // ── Validar ítems y obtener precios autorizados de BD ─────────
    const safeItems = [];
    for (const item of items) {
      if (!item || typeof item.name !== 'string' || !item.name.trim()) {
        return res.status(400).json({ code: 'VALIDATION_ERROR', error: 'cada ítem debe tener name' });
      }
      const qty = Number(item.qty) || 0;
      if (!Number.isFinite(qty) || qty <= 0) {
        return res.status(400).json({ code: 'VALIDATION_ERROR', error: 'Cantidad inválida' });
      }
      const area = (item.area || 'cocina').toLowerCase();
      if (!VALID_AREAS.has(area)) {
        return res.status(400).json({ code: 'VALIDATION_ERROR', error: 'área inválida' });
      }

      let authorizedPrice;
      try {
        authorizedPrice = getAuthorizedPrice(item);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }

      // ── Verificación de precio contra fuente autoritativa ──
      // Si hay precio de catálogo, el precio del cliente debe coincidir
      // (tolerancia 0.01); si no coincide se rechaza con UNAUTHORIZED_PRICE.
      // Sin precio de catálogo (ítems combo/otro o filas legacy sin precio)
      // se conserva el precio enviado como snapshot y se registra el hecho.
      let price = authorizedPrice;
      if (authorizedPrice === null) {
        price = Number(item.price) || 0;
        logger.debug(`[PRICE] Sin precio autoritativo para ${item.itemType} ${item.id || item.invId || item.name}; se usa snapshot del cliente`);
      } else if (item.price !== undefined && item.price !== null) {
        const clientPrice = Number(item.price);
        if (Number.isFinite(clientPrice) && Math.abs(clientPrice - authorizedPrice) > 0.01) {
          return res.status(400).json({
            error: 'Precio de ítem no autorizado: no coincide con el precio del catálogo',
            code: 'UNAUTHORIZED_PRICE',
          });
        }
      }

      safeItems.push({
        name: item.name.trim(),
        price,
        qty,
        note: item.note || '',
        itemType: item.itemType || 'menu',
        invId: item.invId || null,
        menuItemId: catalogMenuItemId(item),
        area,
        lineTotal: price * qty,
      });
    }

    // ── Calcular nuevos totales en el servidor ────────────────────
    const { subtotal, discountAmt, tax, total } = calculateOrderTotals(
      safeItems, nDiscount, nDiscountType, nTaxRate
    );

    // ── Pre-verificación de stock (UX rápida, informativa) ──
    const preShortages = checkStockShortages(safeItems);
    const preHasShortage = preShortages.length > 0;

    if (preHasShortage) {
      const isAdmin = isAdminSession(req.session);
      const isAuthorized = adminAuthorized === true && isAdmin;

      if (!isAuthorized) {
        logger.info(
          `[INVENTORY] Stock insuficiente sin autorización en modify-items: ${preShortages.map(s => `${s.name}: ${s.available} disp, ${s.requested} solicitado, faltante ${s.shortage}`).join('; ')}`
        );
      } else {
        logger.info(
          `[INVENTORY] Stock negativo autorizado por ${req.session.name || 'admin'} ` +
          `(${req.session.role}) en modify-items: ${preShortages.map(s => `${s.name}: ${s.available} disp, ${s.requested} solicitado, faltante ${s.shortage}`).join('; ')}`
        );
      }
    }

    const now = Date.now();

    try {
      // Toda la operación en una transacción atómica
      const tx = db._native.transaction(() => {
        // Verificar que la orden exista
        const existing = db.prepare('SELECT id, createdAt, updatedAt FROM orders WHERE id = ?').get(orderId);
        if (!existing) {
          throw new Error('Orden no encontrada');
        }
        // Identificador del estado de la orden ANTES de esta modificación
        // (para idempotencia: distingue operaciones distintas con misma transición)
        const orderStateId = existing.updatedAt || existing.createdAt || 0;

        // ── VERIFICACIÓN DEFINITIVA DE STOCK (dentro de la transacción) ──
        const txIsAdmin = isAdminSession(req.session);
        const txIsAuthorized = adminAuthorized === true && txIsAdmin;

        // ── Reconciliación de stock: leer cantidades anteriores ANTES de soft-delete ──
        const previousItems = db.prepare(
          "SELECT invId, qty FROM order_items WHERE order_id = ? AND (deleted IS NULL OR deleted = 0) AND itemType = 'inventory'"
        ).all(orderId);

        const prevQtyByInv = {};
        for (const pi of previousItems) {
          if (pi.invId) {
            prevQtyByInv[pi.invId] = (prevQtyByInv[pi.invId] || 0) + (Number(pi.qty) || 0);
          }
        }

        const newQtyByInv = {};
        for (const item of safeItems) {
          if (item.itemType === 'inventory' && item.invId) {
            newQtyByInv[item.invId] = (newQtyByInv[item.invId] || 0) + (Number(item.qty) || 0);
          }
        }

        // Soft-delete de los items existentes y se reinsertan como nuevos.
        // (antes era un DELETE físico: no se propagaba a la nube y dejaba
        // huérfanos en Supabase cuando se editaba una orden desde otro dispositivo)
        db.prepare(
          `UPDATE order_items SET deleted = 1 WHERE order_id = ? AND (deleted IS NULL OR deleted = 0)`
        ).run(orderId);

        const stmtItems = db.prepare(
          `INSERT INTO order_items
             (order_id, name, price, qty, lineTotal, note, itemType, invId, menuItemId, area, status, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
        );
        for (const item of safeItems) {
          stmtItems.run(
            orderId, item.name, item.price, item.qty, item.lineTotal,
            item.note, item.itemType, item.invId, item.menuItemId, item.area, now
          );
        }

        // Actualizar totales de la orden
        db.prepare(
          `UPDATE orders
             SET subtotal = ?, tax = ?, total = ?, discountAmt = ?,
                 discount = ?, discountType = ?, taxRate = ?, updatedAt = ?
           WHERE id = ?`
        ).run(subtotal, tax, total, discountAmt, nDiscount, nDiscountType, nTaxRate, now, orderId);

        // ── Reconciliación de stock (cantidades efectivas + ajuste por diferencia) ──
        // Estrategia híbrida:
        //   effectivePrev = sum(sale) - sum(return) para este pedido+producto
        //     (cantidad REALMENTE descontada, reconstruida de movimientos)
        //   Reducción (newQty < prevQty):
        //     returnQty = effectivePrev - min(newQty, effectivePrev)
        //     (cubre faltantes: si se pidió 8 con stock 5 (eff 5) y se reduce a 4,
        //      se reintegra 5 - min(4,5) = 1, no 4)
        //     Sin re-evaluar autorización (solo se devuelve stock).
        //   Aumento (newQty > prevQty):
        //     increaseQty = newQty - prevQty
        //     Se aplica con reglas de autorización (descuento disponible + faltante).
        //   Sin cambio (newQty == prevQty): no-op.
        const allInvIds = new Set([...Object.keys(prevQtyByInv), ...Object.keys(newQtyByInv)].map(Number));
        const reconcileShortages = [];

        for (const invId of allInvIds) {
          const prevQty = prevQtyByInv[invId] || 0;
          const newQty = newQtyByInv[invId] || 0;

          if (prevQty === 0 && newQty === 0) continue;
          if (prevQty === newQty) continue;

          // ── Cantidad efectivamente descontada (reconstruida de movimientos) ──
          const saleRows = db.prepare(
            "SELECT COALESCE(SUM(quantity),0) AS s FROM stock_movements WHERE reference_type = 'order' AND reference_id = ? AND inventory_id = ? AND movement_type = 'sale'"
          ).get(orderId, invId);
          const returnRows = db.prepare(
            "SELECT COALESCE(SUM(quantity),0) AS s FROM stock_movements WHERE reference_type = 'order' AND reference_id = ? AND inventory_id = ? AND movement_type = 'return'"
          ).get(orderId, invId);
          const effectivePrev = Math.max(0, (Number(saleRows.s) || 0) - (Number(returnRows.s) || 0));

          if (newQty < prevQty) {
            // ── Reducción: reintegrar diferencia efectiva ──
            const returnQty = effectivePrev - Math.min(newQty, effectivePrev);
            if (returnQty > 0) {
              db.prepare(
                "UPDATE inventory SET stock = COALESCE(stock,0) + ? WHERE id = ? AND (deleted IS NULL OR deleted = 0)"
              ).run(returnQty, invId);

              const inv = db.prepare(
                "SELECT id, name, stock FROM inventory WHERE id = ? AND (deleted IS NULL OR deleted = 0)"
              ).get(invId);

              const { recordStockMovement } = require('../db');
              recordStockMovement({
                inventoryId: invId,
                productName: inv ? inv.name : 'Producto',
                movementType: 'return',
                quantity: returnQty,
                stockBefore: inv ? inv.stock - returnQty : 0,
                stockAfter: inv ? inv.stock : returnQty,
                shortageQuantity: 0,
                referenceType: 'order',
                referenceId: orderId,
                authorizedBy: null,
                userName: req.session.name || null,
                userRole: req.session.role || null,
                idempotencyKey: "order-" + orderId + "-modify-" + orderStateId + "-return-" + invId + "-" + returnQty,
              });
            }
          } else {
            // ── Aumento: aplicar diferencia con reglas de autorización ──
            const increaseQty = newQty - prevQty;
            const inv = db.prepare(
              "SELECT id, name, stock FROM inventory WHERE id = ? AND (deleted IS NULL OR deleted = 0)"
            ).get(invId);
            if (inv) {
              const available = Number(inv.stock) || 0;
              const shortage = txIsAuthorized ? 0 : Math.max(0, increaseQty - available);
              const actualQty = txIsAuthorized ? increaseQty : Math.min(increaseQty, available);

              if (actualQty > 0) {
                db.prepare(
                  "UPDATE inventory SET stock = COALESCE(stock,0) - ? WHERE id = ? AND (deleted IS NULL OR deleted = 0)"
                ).run(actualQty, invId);
              }

              if (shortage > 0) {
                reconcileShortages.push({
                  invId,
                  name: inv.name,
                  available,
                  requested: increaseQty,
                  shortage,
                });
              }

              const { recordStockMovement } = require('../db');
              recordStockMovement({
                inventoryId: invId,
                productName: inv.name,
                movementType: 'sale',
                quantity: actualQty,
                stockBefore: available,
                stockAfter: available - actualQty,
                shortageQuantity: shortage,
                referenceType: 'order',
                referenceId: orderId,
                authorizedBy: txIsAuthorized ? (req.session.name || null) : null,
                userName: req.session.name || null,
                userRole: req.session.role || null,
                idempotencyKey: "order-" + orderId + "-modify-" + orderStateId + "-sale-" + invId + "-" + increaseQty,
              });

              if (shortage > 0) {
                recordStockMovement({
                  inventoryId: invId,
                  productName: inv.name,
                  movementType: 'shortage',
                  quantity: shortage,
                  stockBefore: available - actualQty,
                  stockAfter: available - actualQty,
                  shortageQuantity: shortage,
                  referenceType: 'order',
                  referenceId: orderId,
                  authorizedBy: txIsAuthorized ? (req.session.name || null) : null,
                  userName: req.session.name || null,
                  userRole: req.session.role || null,
                  idempotencyKey: "order-" + orderId + "-modify-" + orderStateId + "-shortage-" + invId + "-" + shortage,
                });
              }
            }
          }
        }

        // V8: modificación de una orden abierta (op 'modify').
        callV8Hook('onOrderModified', {
          orderId,
          expectedVersion: req.body.expectedVersion,
          authorizationId: req.body.authorizationId || null,
          userName: req.session.name || null,
        });

        return { order: getOrderByIdSync(orderId), hasShortage: reconcileShortages.length > 0, shortages: reconcileShortages };
      });

      const txResult = tx();

      // Notificar FUERA de la transacción (después del commit)
      notifyChange('data:updated', { source: 'orders/modify-items', orderId });
      res.json({ success: true, subtotal: txResult.order.subtotal, order: txResult.order, shortages: txResult.hasShortage ? txResult.shortages : undefined });
    } catch (err) {
      if (err.message === 'Orden no encontrada') {
        return res.status(404).json({ code: 'ORDER_NOT_FOUND', error: err.message });
      }
      if (err.code === 'STOCK_SHORTAGE') {
        return res.status(400).json({
          error: err.message,
          code: 'STOCK_SHORTAGE',
          shortages: err.shortages,
        });
      }
      return res.status(500).json({ error: err.message });
    }
  }));

  // ── POST /api/orders/update-item-status  ──────────────────
  router.post('/update-item-status', requireSession, asyncHandler(async (req, res) => {
    const { itemId, status } = req.body;
    if (!itemId || !status) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', error: 'itemId y status son requeridos' });
    }
    if (!VALID_ITEM_STATUSES.has(status)) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', error: 'status inválido' });
    }
    db.run(
      `UPDATE order_items SET status = ? WHERE id = ?`,
      [status, itemId],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        notifyChange('data:updated', { source: 'orders/update-item-status' });
        res.json({ success: true, changes: this.changes });
      }
    );
  }));

  // ── POST /api/orders/update-bulk-items  ───────────────────
  router.post('/update-bulk-items', requireSession, asyncHandler(async (req, res) => {
    const { orderId, area, status } = req.body;
    if (!orderId || !status) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', error: 'orderId y status son requeridos' });
    }
    if (!VALID_ITEM_STATUSES.has(status)) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', error: 'status inválido' });
    }
    if (area && area !== 'todas' && !VALID_AREAS.has(area)) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', error: 'área inválida' });
    }

    let sql = `UPDATE order_items SET status = ? WHERE order_id = ?`;
    const params = [status, orderId];

    if (area && area !== 'todas') {
      sql += ` AND (area = ? OR area IS NULL)`;
      params.push(area);
    }

    db.run(sql, params, function (err) {
      if (err) return res.status(500).json({ error: err.message });
      notifyChange('data:updated', { source: 'orders/update-bulk-items', orderId });
      res.json({ success: true, changes: this.changes });
    });
  }));

  // ── POST /api/orders/reopen  ──────────────────────────────
  router.post('/reopen', requireSession, asyncHandler(async (req, res) => {
    const { id } = req.body;
    if (id === undefined || id === null || id === '') {
      return res.status(400).json({ code: 'VALIDATION_ERROR', error: 'id es requerido' });
    }
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', error: 'id inválido' });
    }

    try {
      const tx = db._native.transaction(() => {
        const existing = db.prepare('SELECT id, status, createdAt, updatedAt FROM orders WHERE id = ?').get(numericId);
        if (!existing) throw new Error('ORDER_NOT_FOUND');

        // Idempotencia: si ya está activo, no hacer nada
        if (existing.status === 'active' || existing.status === 'pending') {
          db.prepare(
            `UPDATE orders SET paymentMethod = NULL, closedAt = NULL, paidAt = NULL, updatedAt = ? WHERE id = ?`
          ).run(Date.now(), numericId);
          return { wasCancelled: false };
        }

        const wasCancelled = existing.status === 'cancelled';
        const orderStateId = existing.updatedAt || existing.createdAt || 0;

        // Si estaba cancelado, re-descontar stock (revivir la venta).
        // Re-discount igual a lo efectivamente vendido: SUM(sale) de este pedido+producto.
        // Esto evita re-descontar la cantidad completa del pedido cuando hubo faltantes.
        if (wasCancelled) {
          const items = db.prepare(
            `SELECT invId, qty FROM order_items WHERE order_id = ? AND (deleted IS NULL OR deleted = 0) AND itemType = 'inventory'`
          ).all(numericId);

          const invIds = [];
          for (const it of items) {
            if (it.invId && invIds.indexOf(it.invId) === -1) {
              invIds.push(it.invId);
            }
          }

          const txIsAdmin = isAdminSession(req.session);
          // Reopen no tiene adminAuthorized del frontend; usar sesión
          const txIsAuthorized = txIsAdmin;

          for (const invId of invIds.map(Number)) {
            // Cantidad efectivamente vendida (reconstruida de movimientos de venta)
            const saleRows = db.prepare(
              "SELECT COALESCE(SUM(quantity),0) AS s FROM stock_movements WHERE reference_type = 'order' AND reference_id = ? AND inventory_id = ? AND movement_type = 'sale'"
            ).get(numericId, invId);
            const reopenQty = Math.max(0, Number(saleRows.s) || 0);

            if (reopenQty <= 0) continue;

            const inv = db.prepare(
              "SELECT id, name, stock FROM inventory WHERE id = ? AND (deleted IS NULL OR deleted = 0)"
            ).get(invId);
            if (inv) {
              const available = Number(inv.stock) || 0;
              const shortage = txIsAuthorized ? 0 : Math.max(0, reopenQty - available);
              const actualQty = txIsAuthorized ? reopenQty : Math.min(reopenQty, available);

              if (actualQty > 0) {
                db.prepare(
                  "UPDATE inventory SET stock = COALESCE(stock,0) - ? WHERE id = ? AND (deleted IS NULL OR deleted = 0)"
                ).run(actualQty, invId);
              }

              const { recordStockMovement } = require('../db');
              recordStockMovement({
                inventoryId: invId,
                productName: inv.name,
                movementType: 'sale',
                quantity: actualQty,
                stockBefore: available,
                stockAfter: available - actualQty,
                shortageQuantity: shortage,
                referenceType: 'order',
                referenceId: numericId,
                authorizedBy: txIsAuthorized ? (req.session.name || null) : null,
                userName: req.session.name || null,
                userRole: req.session.role || null,
                idempotencyKey: "order-" + numericId + "-reopen-" + orderStateId + "-sale-" + invId + "-" + reopenQty,
              });

              if (shortage > 0) {
                recordStockMovement({
                  inventoryId: invId,
                  productName: inv.name,
                  movementType: 'shortage',
                  quantity: shortage,
                  stockBefore: available - actualQty,
                  stockAfter: available - actualQty,
                  shortageQuantity: shortage,
                  referenceType: 'order',
                  referenceId: numericId,
                  authorizedBy: txIsAuthorized ? (req.session.name || null) : null,
                  userName: req.session.name || null,
                  userRole: req.session.role || null,
                  idempotencyKey: "order-" + numericId + "-reopen-" + orderStateId + "-shortage-" + invId + "-" + shortage,
                });
              }
            }
          }
        }

        // Actualizar estado
        db.prepare(
          `UPDATE orders SET paymentMethod = NULL, status = 'active',
              closedAt = NULL, paidAt = NULL, updatedAt = ?
            WHERE id = ?`
        ).run(Date.now(), numericId);

        // V8: reapertura de la orden (op 'reopen').
        callV8Hook('onOrderReopened', {
          orderId: numericId,
          expectedVersion: req.body.expectedVersion,
          userName: req.session.name || null,
        });

        return { wasCancelled };
      });

      const txResult = tx();
      notifyChange('data:updated', { source: 'orders/reopen', orderId: numericId });
      res.json({ success: true, reopened: true, wasCancelled: txResult.wasCancelled });
    } catch (err) {
      if (err.message === 'ORDER_NOT_FOUND') {
        return res.status(404).json({ code: 'ORDER_NOT_FOUND', error: err.message });
      }
      return res.status(500).json({ error: err.message });
    }
  }));

  // ── POST /api/orders/return ────────────────────────────────
  //  Devolución explícita de ítems de inventario. Es un movimiento
  //  independiente de la venta (C-02): referencia source_operation_id.
  router.post('/return', requireSession, asyncHandler(async (req, res) => {
    const { orderId, items, authorizationId, sourceOperationId } = req.body;
    const numericOrderId = Number(orderId);
    if (!Number.isInteger(numericOrderId) || numericOrderId <= 0) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', error: 'orderId inválido' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', error: 'items no puede estar vacío' });
    }

    try {
      const result = db._native.transaction(() => {
        const order = db.prepare('SELECT id, uuid FROM orders WHERE id = ?').get(numericOrderId);
        if (!order) throw new Error('ORDER_NOT_FOUND');

        const { recordStockMovement } = require('../db');
        for (const item of items) {
          const qty = Number(item.qty);
          const invId = Number(item.invId);
          if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(invId) || invId <= 0) {
            throw new Error('ITEM_INVALID');
          }
          const inv = db.prepare('SELECT id, name, stock FROM inventory WHERE id = ? AND (deleted IS NULL OR deleted = 0)').get(invId);
          if (!inv) throw new Error('INVENTORY_NOT_FOUND');

          db.prepare('UPDATE inventory SET stock = COALESCE(stock,0) + ? WHERE id = ?').run(qty, invId);
          recordStockMovement({
            inventoryId: invId,
            productName: inv.name,
            movementType: 'return',
            quantity: qty,
            stockBefore: inv.stock,
            stockAfter: Number(inv.stock) + qty,
            shortageQuantity: 0,
            referenceType: 'order',
            referenceId: numericOrderId,
            userName: req.session.name || null,
            userRole: req.session.role || null,
            idempotencyKey: `order-${numericOrderId}-return-${invId}-${qty}`,
          });
        }

        callV8Hook('onOrderReturned', {
          orderId: numericOrderId,
          expectedVersion: req.body.expectedVersion,
          authorizationId: authorizationId || null,
          sourceOperationId: sourceOperationId || null,
          userName: req.session.name || null,
          items: items.map((i) => ({
            invId: Number(i.invId),
            name: i.name || 'item',
            price: Number(i.price) || 0,
            qty: Number(i.qty),
          })),
        });
        return true;
      });
      result();
      notifyChange('data:updated', { source: 'orders/return', orderId: numericOrderId });
      res.json({ success: true, returned: true });
    } catch (err) {
      if (err.message === 'ORDER_NOT_FOUND') return res.status(404).json({ code: 'ORDER_NOT_FOUND', error: err.message });
      if (err.message === 'ITEM_INVALID' || err.message === 'INVENTORY_NOT_FOUND') {
        return res.status(400).json({ code: 'VALIDATION_ERROR', error: err.message });
      }
      return res.status(500).json({ error: err.message });
    }
  }));

  // ── GET /api/orders/active-count  ──────────────────────────
  // Resumen de pedidos activos con mesa (para el panel/dashboard).
  router.get('/active-count', requireSession, asyncHandler(async (req, res) => {
    db.all(
      `SELECT tableId FROM orders
        WHERE status NOT IN ('delivered','cancelled')
          AND tableId IS NOT NULL
          AND (deleted IS NULL OR deleted = 0)`,
      [],
      (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const list = rows || [];
        const tableCount = new Set(list.map(r => r.tableId)).size;
        res.json({ success: true, orderCount: list.length, tableCount });
      }
    );
  }));

  // ── GET /api/orders/history  ───────────────────────────────
  // Historial paginado de pedidos pagados (con paymentMethod).
  // Query: page, limit, waiter
  router.get('/history', requireSession, asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 50));
    const waiter = String(req.query.waiter || '').trim();

    const where = ['paymentMethod IS NOT NULL', '(deleted IS NULL OR deleted = 0)'];
    const params = [];
    if (waiter) { where.push('waiterName = ?'); params.push(waiter); }
    const whereSql = 'WHERE ' + where.join(' AND ');

    db.get(`SELECT COUNT(*) AS c FROM orders ${whereSql}`, params, (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      const total = row ? row.c : 0;
      const pages = Math.ceil(total / limit);
      const offset = (page - 1) * limit;
      db.all(
        `SELECT * FROM orders ${whereSql} ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset],
        async (err2, rows) => {
          if (err2) return res.status(500).json({ error: err2.message });
          try {
            const orders = await Promise.all(
              (rows || []).map(async r => {
                const items = await getOrderItems(r.id);
                return rowToOrder(r, items);
              })
            );
            res.json({ orders, total, pages, currentPage: page });
          } catch (e) {
            res.status(500).json({ error: e.message });
          }
        }
      );
    });
  }));

  return router;
};