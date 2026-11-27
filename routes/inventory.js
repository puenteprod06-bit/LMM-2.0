'use strict';

const { Router } = require('express');
const logger = require('../logger');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ============================================================
//  RUTAS DE INVENTARIO  —  /api/inventory/*
// ============================================================
module.exports = function inventoryRoutes(db, { requireSession, requireOwner, notifyChange, Validator }) {
  const router = Router();
  const { recordStockMovement } = require('../db');

  // GET /api/inventory
  router.get('/', requireSession, asyncHandler(async (req, res) => {
    db.all('SELECT * FROM inventory WHERE deleted IS NULL OR deleted = 0 ORDER BY id', [], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const inventory = rows.map(r => ({ ...r, showInPOS: r.showInPOS === 1 }));
      res.json(inventory);
    });
  }));

  // POST /api/inventory/save
  router.post('/save', requireOwner, asyncHandler(async (req, res) => {
    const { id, name, stock, minStock, unit, cost, salePrice, category, expirationDate, notes, emoji, showInPOS } = req.body;

    // ── Validación server-side ────────────────────────────────
    const validation = Validator.validate({
      name:      { required: true,  type: 'string',  minLen: 1, maxLen: 150 },
      stock:     { required: false, type: 'number',  min: 0 },
      minStock:  { required: false, type: 'number',  min: 0 },
      cost:      { required: false, type: 'number',  min: 0 },
      salePrice: { required: false, type: 'number',  min: 0 },
    }, req.body);
    if (!validation.valid) return res.status(400).json({ error: validation.errors });

    const show = showInPOS ? 1 : 0;
    // Los productos usan nombres de iconos Material Symbols; nunca emojis.
    const safeEmoji = /^[a-z0-9_]+$/.test(emoji || '') ? emoji : 'inventory_2';

    if (id) {
      db.run(
        `UPDATE inventory SET name=?, stock=?, minStock=?, unit=?, cost=?, salePrice=?, category=?, expirationDate=?, notes=?, emoji=?, showInPOS=? WHERE id=?`,
        [name, stock || 0, minStock || 0, unit || 'unidad', cost || 0, salePrice || 0, category || 'General', expirationDate, notes, safeEmoji, show, id],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });
          notifyChange('inventory:updated');
          res.json({ success: true });
        }
      );
    } else {
      db.run(
        `INSERT INTO inventory (name, stock, minStock, unit, cost, salePrice, category, expirationDate, notes, emoji, showInPOS) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [name, stock || 0, minStock || 0, unit || 'unidad', cost || 0, salePrice || 0, category || 'General', expirationDate, notes, safeEmoji, show],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });
          notifyChange('inventory:updated');
          res.json({ success: true, id: this.lastID });
        }
      );
    }
  }));

  // DELETE /api/inventory/:id
  router.delete('/:id', requireOwner, asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    db.run('UPDATE inventory SET deleted = 1 WHERE id = ?', id, function (err) {
      if (err) return res.status(500).json({ error: err.message });
      notifyChange('inventory:updated');
      res.json({ success: true });
    });
  }));

  // POST /api/inventory/decrement — descuento atómico de stock en transacción.
  // Body: { items: [{ id, qty }], adminAuthorized: boolean }
  // Regla comercial: stock insuficiente permite la operación con advertencia.
  // Stock negativo requiere autorización explícita de un administrador.
  // El faltante se calcula y se registra, no se oculta con MAX(0, ...).
  router.post('/decrement', requireSession, asyncHandler(async (req, res) => {
    const items = Array.isArray(req.body) ? req.body : req.body?.items;
    const adminAuthorized = req.body?.adminAuthorized === true;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Faltan items a descontar' });
    }
    const clean = items.map(it => ({
      id: parseInt(it.id, 10),
      qty: Number(it.qty)
    })).filter(it => Number.isInteger(it.id) && Number.isFinite(it.qty) && it.qty >= 0);
    if (clean.length === 0) {
      return res.status(400).json({ error: 'Items inválidos' });
    }

    // ── Pre-verificación de stock (UX rápida, no es la verificación definitiva) ──
    const preShortages = [];
    const native = db._native;
    for (const it of clean) {
      const inv = native.prepare(
        `SELECT id, name, stock FROM inventory WHERE id = ? AND (deleted IS NULL OR deleted = 0)`
      ).get(it.id);
      if (inv) {
        const available = Number(inv.stock) || 0;
        const shortage = Math.max(0, it.qty - available);
        if (shortage > 0) {
          preShortages.push({
            invId: it.id,
            name: inv.name,
            available,
            requested: it.qty,
            shortage,
          });
        }
      }
    }

    const preHasShortage = preShortages.length > 0;
    if (preHasShortage) {
      const isAdmin = (req.session && req.session.role === 'owner' && (req.session.is_client === 0 || req.session.is_client === '0')) ||
                      (req.session && req.session.role === 'admin' && (req.session.is_client === 1 || req.session.is_client === '1'));
      const isAuthorized = adminAuthorized === true && isAdmin;

      if (!isAuthorized) {
        // Informar pero NO rechazar: el stock se limitará a lo disponible
        const logger = require('../logger');
        logger.info(
          `[INVENTORY] Stock insuficiente sin autorización: ${preShortages.map(s => `${s.name}: ${s.available} disp, ${s.requested} solicitado, faltante ${s.shortage}`).join('; ')}`
        );
      } else {
        const logger = require('../logger');
        logger.info(
          `[INVENTORY] Stock negativo autorizado por ${req.session?.name || 'admin'} ` +
          `(${req.session?.role}): ${preShortages.map(s => `${s.name}: ${s.available} disp, ${s.requested} solicitado, faltante ${s.shortage}`).join('; ')}`
        );
      }
    }

    try {
      const updated = native.transaction(() => {
        // ── VERIFICACIÓN DEFINITIVA DE STOCK (dentro de la transacción) ──
        const txShortages = [];
        for (const it of clean) {
          const inv = native.prepare(
            `SELECT id, name, stock FROM inventory WHERE id = ? AND (deleted IS NULL OR deleted = 0)`
          ).get(it.id);
          if (inv) {
            const available = Number(inv.stock) || 0;
            const shortage = Math.max(0, it.qty - available);
            if (shortage > 0) {
              txShortages.push({
                invId: it.id,
                name: inv.name,
                available,
                requested: it.qty,
                shortage,
              });
            }
          }
        }

        const txHasShortage = txShortages.length > 0;
        const txIsAdmin = (req.session && req.session.role === 'owner' && (req.session.is_client === 0 || req.session.is_client === '0')) ||
                          (req.session && req.session.role === 'admin' && (req.session.is_client === 1 || req.session.is_client === '1'));
        const txIsAuthorized = adminAuthorized === true && txIsAdmin;

        if (txHasShortage) {
          const logger = require('../logger');
          if (txIsAuthorized) {
            logger.info(
              `[INVENTORY] Stock negativo autorizado por ${req.session?.name || 'admin'} ` +
              `(${req.session?.role}): ${txShortages.map(s => `${s.name}: ${s.available} disp, ${s.requested} solicitado, faltante ${s.shortage}`).join('; ')}`
            );
          } else {
            logger.info(
              `[INVENTORY] Stock insuficiente sin autorización: ${txShortages.map(s => `${s.name}: ${s.available} disp, ${s.requested} solicitado, faltante ${s.shortage}`).join('; ')}`
            );
          }
        }

        const stmt = native.prepare(`UPDATE inventory SET stock = COALESCE(stock,0) - ? WHERE id = ? AND (deleted IS NULL OR deleted = 0)`);
        const rows = [];
        for (const it of clean) {
          const inv = native.prepare(
            `SELECT id, name, stock FROM inventory WHERE id = ? AND (deleted IS NULL OR deleted = 0)`
          ).get(it.id);
          const available = inv ? (Number(inv.stock) || 0) : 0;
          const shortage = Math.max(0, it.qty - available);

          if (shortage > 0 && !txIsAuthorized) {
            // Sin autorización: descontar solo stock disponible
            const actualQty = Math.min(it.qty, available);
            if (actualQty > 0) {
              const info = stmt.run(actualQty, it.id);
              if (info.changes > 0) {
                const row = native.prepare(`SELECT id, stock, minStock, name FROM inventory WHERE id = ?`).get(it.id);
                if (row) rows.push(row);
              }
            }
            // Registrar movimiento de venta
            if (inv) {
              recordStockMovement({
                inventoryId: it.id,
                productName: inv.name,
                movementType: 'sale',
                quantity: Math.min(it.qty, available),
                stockBefore: available,
                stockAfter: available - Math.min(it.qty, available),
                shortageQuantity: shortage,
                referenceType: 'decrement',
                referenceId: null,
                authorizedBy: null,
                userName: req.session?.name || null,
                userRole: req.session?.role || null,
                idempotencyKey: `decrement-${it.id}-${it.qty}-${Math.floor(Date.now() / 1000)}`,
              });
            }
            // Registrar faltante
            if (shortage > 0) {
              recordStockMovement({
                inventoryId: it.id,
                productName: inv.name,
                movementType: 'shortage',
                quantity: shortage,
                stockBefore: available - Math.min(it.qty, available),
                stockAfter: available - Math.min(it.qty, available),
                shortageQuantity: shortage,
                referenceType: 'decrement',
                referenceId: null,
                authorizedBy: null,
                userName: req.session?.name || null,
                userRole: req.session?.role || null,
                idempotencyKey: `decrement-${it.id}-shortage-${shortage}-${Math.floor(Date.now() / 1000)}`,
              });
            }
          } else {
            // Con autorización o sin shortage: descontar todo
            const info = stmt.run(it.qty, it.id);
            if (info.changes > 0) {
              const row = native.prepare(`SELECT id, stock, minStock, name FROM inventory WHERE id = ?`).get(it.id);
              if (row) rows.push(row);
            }
            // Registrar movimiento de venta
            if (inv) {
              recordStockMovement({
                inventoryId: it.id,
                productName: inv.name,
                movementType: 'sale',
                quantity: it.qty,
                stockBefore: available,
                stockAfter: available - it.qty,
                shortageQuantity: shortage,
                referenceType: 'decrement',
                referenceId: null,
                authorizedBy: txIsAuthorized ? (req.session?.name || null) : null,
                userName: req.session?.name || null,
                userRole: req.session?.role || null,
                idempotencyKey: `decrement-${it.id}-${it.qty}-${Math.floor(Date.now() / 1000)}`,
              });
            }
            // Registrar faltante si hay
            if (shortage > 0) {
              recordStockMovement({
                inventoryId: it.id,
                productName: inv.name,
                movementType: 'shortage',
                quantity: shortage,
                stockBefore: available - it.qty,
                stockAfter: available - it.qty,
                shortageQuantity: shortage,
                referenceType: 'decrement',
                referenceId: null,
                authorizedBy: txIsAuthorized ? (req.session?.name || null) : null,
                userName: req.session?.name || null,
                userRole: req.session?.role || null,
                idempotencyKey: `decrement-${it.id}-shortage-${shortage}-${Math.floor(Date.now() / 1000)}`,
              });
            }
          }
        }

        return { rows, hasShortage: txHasShortage, shortages: txShortages };
      })();

      notifyChange('inventory:updated');
      res.json({ success: true, updated: updated.rows.length, rows: updated.rows, shortages: updated.hasShortage ? updated.shortages : undefined });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }));

  // ── GET /api/inventory/movements — consultar historial de movimientos ──
  //  Query params:
  //    inventory_id  → movimientos de un producto específico
  //    order_id      → movimientos de un pedido (reference_id con reference_type='order')
  //    type          → filtrar por tipo de movimiento (sale, shortage, adjustment, etc.)
  //    shortage      → '1' para solo faltantes
  //    from          → fecha inicio (timestamp ms)
  //    to            → fecha fin (timestamp ms)
  //    page, limit   → paginación
  // POST /api/inventory/adjust — ajuste manual de stock (V8 op adjust_in/out).
  router.post('/adjust', requireOwner, asyncHandler(async (req, res) => {
    const { inventoryId, qty, direction, reason, authorizationId } = req.body;
    const amount = Number(qty);
    const invId = Number(inventoryId);
    const dir = direction === 'out' ? 'out' : 'in';
    if (!Number.isInteger(invId) || invId <= 0 || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'inventoryId y qty deben ser positivos' });
    }

    try {
      db._native.transaction(() => {
        const inv = db._native.prepare(
          'SELECT id, name, stock FROM inventory WHERE id = ? AND (deleted IS NULL OR deleted = 0)'
        ).get(invId);
        if (!inv) throw new Error('INVENTORY_NOT_FOUND');

        const delta = dir === 'in' ? amount : -amount;
        db._native.prepare('UPDATE inventory SET stock = COALESCE(stock,0) + ? WHERE id = ?').run(delta, invId);
        recordStockMovement({
          inventoryId: invId,
          productName: inv.name,
          movementType: dir === 'in' ? 'adjustment_in' : 'adjustment_out',
          quantity: amount,
          stockBefore: inv.stock,
          stockAfter: Number(inv.stock) + delta,
          shortageQuantity: 0,
          referenceType: 'manual',
          referenceId: null,
          userName: req.session.name || null,
          userRole: req.session.role || null,
          idempotencyKey: `adjust-${invId}-${Date.now()}-${dir}-${amount}`,
        });

        try {
          const v8 = require('../services/inventory-sync-v8');
          if (v8.isEnabled()) {
            const r = v8.hook.onInventoryAdjusted(db._native, {
              inventoryId: invId,
              opKind: dir === 'in' ? 'adjust_in' : 'adjust_out',
              qty: amount,
              reason: reason || null,
              authorizationId: authorizationId || null,
              expectedVersion: Number(req.body.expectedVersion || 0),
              userName: req.session.name || null,
            });
            if (!r.enqueued) logger.warn('[INV-V8] ajuste no encolado:', r.reason);
          }
        } catch (e) {
          logger.warn('[INV-V8] hook de ajuste falló:', e.message);
        }
      })();
      notifyChange('inventory:updated');
      res.json({ success: true, adjusted: true, direction: dir, qty: amount });
    } catch (err) {
      if (err.message === 'INVENTORY_NOT_FOUND') return res.status(404).json({ error: err.message });
      return res.status(500).json({ error: err.message });
    }
  }));

  router.get('/movements', requireSession, asyncHandler(async (req, res) => {
    const {
      inventory_id, order_id, type, shortage,
      from, to, page: pageParam, limit: limitParam
    } = req.query;

    const page = Math.max(1, parseInt(pageParam, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(limitParam, 10) || 50));
    const offset = (page - 1) * limit;

    const conditions = ['deleted IS NULL OR deleted = 0'];
    const params = [];

    if (inventory_id) {
      conditions.push('inventory_id = ?');
      params.push(parseInt(inventory_id, 10));
    }
    if (order_id) {
      conditions.push('reference_type = ? AND reference_id = ?');
      params.push('order', parseInt(order_id, 10));
    }
    if (type) {
      conditions.push('movement_type = ?');
      params.push(String(type));
    }
    if (shortage === '1') {
      conditions.push('shortage_quantity > 0');
    }
    if (from) {
      conditions.push('created_at >= ?');
      params.push(Number(from));
    }
    if (to) {
      conditions.push('created_at <= ?');
      params.push(Number(to));
    }

    const whereSql = 'WHERE ' + conditions.join(' AND ');

    const total = db._native.prepare(
      `SELECT COUNT(*) AS c FROM stock_movements ${whereSql}`
    ).get(...params).c;

    const movements = db._native.prepare(
      `SELECT * FROM stock_movements ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);

    res.json({
      movements,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
    });
  }));

  return router;
};