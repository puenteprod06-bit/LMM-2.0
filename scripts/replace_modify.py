import re

with open('routes/orders.js', 'r', encoding='utf-8') as f:
    content = f.read()

old_block = """        // ── VERIFICACIÓN DEFINITIVA DE STOCK (dentro de la transacción) ──
        const txShortages = checkStockShortages(safeItems);
        const txHasShortage = txShortages.length > 0;

        const txIsAdmin = isAdminSession(req.session);
        const txIsAuthorized = adminAuthorized === true && txIsAdmin;

        // Aplicar descuento de stock según autorización
        const stockResult = applyStockDiscount(safeItems, txIsAuthorized, {
          referenceType: 'order',
          referenceId: orderId,
          userName: req.session.name || null,
          userRole: req.session.role || null,
        });

        // Registrar faltantes en log
        if (stockResult.hasShortage) {
          logger.info(
            `[INVENTORY] Faltante registrado en modify-items: ${stockResult.shortages.map(s => `${s.name}: disponible=${s.available}, solicitado=${s.requested}, faltante=${s.shortage}, autorizado=${txIsAuthorized}`).join('; ')}`
          );
        }

        // Soft-delete de los items existentes y se reinsertan como nuevos.
        // (antes era un DELETE físico: no se propagaba a la nube y dejaba
        // huérfanos en Supabase cuando se editaba una orden desde otro dispositivo)
        db.prepare(
          `UPDATE order_items SET deleted = 1 WHERE order_id = ? AND (deleted IS NULL OR deleted = 0)`
        ).run(orderId);

        const stmtItems = db.prepare(
          `INSERT INTO order_items
             (order_id, name, price, qty, lineTotal, note, itemType, invId, area, status, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
        );
        for (const item of safeItems) {
          stmtItems.run(
            orderId, item.name, item.price, item.qty, item.lineTotal,
            item.note, item.itemType, item.invId, item.area, now
          );
        }

        // Actualizar totales de la orden
        db.prepare(
          `UPDATE orders
             SET subtotal = ?, tax = ?, total = ?, discountAmt = ?,
                 discount = ?, discountType = ?, taxRate = ?, updatedAt = ?
           WHERE id = ?`
        ).run(subtotal, tax, total, discountAmt, nDiscount, nDiscountType, nTaxRate, now, orderId);

        // NOTA: El descuento de stock ya se aplicó en applyStockDiscount arriba.
        // No se llama a decrementInventoryStock para evitar doble descuento.

        return { order: getOrderByIdSync(orderId), hasShortage: stockResult.hasShortage, shortages: stockResult.shortages };"""

new_block = """        // ── VERIFICACIÓN DEFINITIVA DE STOCK (dentro de la transacción) ──
        const txIsAdmin = isAdminSession(req.session);
        const txIsAuthorized = adminAuthorized === true && txIsAdmin;

        // ── Reconciliación de stock: leer cantidades anteriores ANTES de soft-delete ──
        const previousItems = db.prepare(
          `SELECT invId, qty FROM order_items WHERE order_id = ? AND (deleted IS NULL OR deleted = 0) AND itemType = 'inventory'`
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
        db.prepare(
          `UPDATE order_items SET deleted = 1 WHERE order_id = ? AND (deleted IS NULL OR deleted = 0)`
        ).run(orderId);

        const stmtItems = db.prepare(
          `INSERT INTO order_items
             (order_id, name, price, qty, lineTotal, note, itemType, invId, area, status, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
        );
        for (const item of safeItems) {
          stmtItems.run(
            orderId, item.name, item.price, item.qty, item.lineTotal,
            item.note, item.itemType, item.invId, item.area, now
          );
        }

        // Actualizar totales de la orden
        db.prepare(
          `UPDATE orders
             SET subtotal = ?, tax = ?, total = ?, discountAmt = ?,
                 discount = ?, discountType = ?, taxRate = ?, updatedAt = ?
           WHERE id = ?`
        ).run(subtotal, tax, total, discountAmt, nDiscount, nDiscountType, nTaxRate, now, orderId);

        // ── Reconciliación de stock ──────────────────────────────────
        const allInvIds = new Set([...Object.keys(prevQtyByInv), ...Object.keys(newQtyByInv)].map(Number));
        const reconcileShortages = [];

        for (const invId of allInvIds) {
          const prevQty = prevQtyByInv[invId] || 0;
          const newQty = newQtyByInv[invId] || 0;
          const diff = newQty - prevQty;

          if (diff === 0) continue;

          if (diff > 0) {
            const inv = db.prepare(
              `SELECT id, name, stock FROM inventory WHERE id = ? AND (deleted IS NULL OR deleted = 0)`
            ).get(invId);
            if (inv) {
              const available = Number(inv.stock) || 0;
              const shortage = Math.max(0, diff - available);
              const actualQty = txIsAuthorized ? diff : Math.min(diff, available);

              if (actualQty > 0) {
                db.prepare(
                  `UPDATE inventory SET stock = COALESCE(stock,0) - ? WHERE id = ? AND (deleted IS NULL OR deleted = 0)`
                ).run(actualQty, invId);
              }

              if (shortage > 0) {
                reconcileShortages.push({
                  invId,
                  name: inv.name,
                  available,
                  requested: diff,
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
                idempotencyKey: `order-${orderId}-modify-sale-${invId}-${diff}`,
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
                  idempotencyKey: `order-${orderId}-modify-shortage-${invId}-${shortage}`,
                });
              }
            }
          } else if (diff < 0) {
            const reintegrateQty = Math.abs(diff);
            db.prepare(
              `UPDATE inventory SET stock = COALESCE(stock,0) + ? WHERE id = ? AND (deleted IS NULL OR deleted = 0)`
            ).run(reintegrateQty, invId);

            const inv = db.prepare(
              `SELECT id, name, stock FROM inventory WHERE id = ? AND (deleted IS NULL OR deleted = 0)`
            ).get(invId);

            const { recordStockMovement } = require('../db');
            recordStockMovement({
              inventoryId: invId,
              productName: inv ? inv.name : 'Producto',
              movementType: 'return',
              quantity: reintegrateQty,
              stockBefore: inv ? inv.stock - reintegrateQty : 0,
              stockAfter: inv ? inv.stock : reintegrateQty,
              shortageQuantity: 0,
              referenceType: 'order',
              referenceId: orderId,
              authorizedBy: null,
              userName: req.session.name || null,
              userRole: req.session.role || null,
              idempotencyKey: `order-${orderId}-modify-return-${invId}-${reintegrateQty}`,
            });
          }
        }

        return { order: getOrderByIdSync(orderId), hasShortage: reconcileShortages.length > 0, shortages: reconcileShortages };"""

assert old_block in content, "old_block not found!"
content = content.replace(old_block, new_block)

with open('routes/orders.js', 'w', encoding='utf-8') as f:
    f.write(content)

print("Replacement done")
PYEOF