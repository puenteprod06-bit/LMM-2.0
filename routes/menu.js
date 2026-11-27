'use strict';

const { Router } = require('express');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ============================================================
//  RUTAS DE MENÚ, CATEGORÍAS Y SUBCATEGORÍAS
//  Exporta TRES routers independientes para montarlos en sus
//  prefijos exactos sin duplicar paths:
//    menuRouter       → app.use('/api/menu',          menuRouter)
//    categoriesRouter → app.use('/api/categories',    categoriesRouter)
//    subcatRouter     → app.use('/api/subcategories', subcatRouter)
// ============================================================

function menuRouter(db, { requireOwner, notifyChange, Validator }) {
  const router = Router();

  // ── Helper: insertar ingredientes de un ítem ──────────────
  function insertIngredients(menuItemId, ingredients, res, event = 'menu:updated') {
    if (!ingredients.length) {
      db.run('COMMIT');
      notifyChange(event);
      return res.json({ success: true, id: menuItemId });
    }
    const placeholders = ingredients.map(() => '(?, ?, ?)').join(', ');
    const values = [];
    ingredients.forEach(ing => values.push(menuItemId, ing.invId, ing.qty));
    db.run(
      `INSERT INTO menu_ingredients (menu_item_id, inv_id, qty) VALUES ${placeholders}`,
      values,
      function (err) {
        if (err) { db.run('ROLLBACK'); return res.status(500).json({ error: err.message }); }
        db.run('COMMIT');
        notifyChange(event);
        res.json({ success: true, id: menuItemId });
      }
    );
  }

  // GET /api/menu
  router.get('/', asyncHandler(async (req, res) => {
    db.all('SELECT * FROM menu_items WHERE deleted IS NULL OR deleted = 0 ORDER BY id', [], (err, menuItems) => {
      if (err) return res.status(500).json({ error: err.message });
      if (menuItems.length === 0) return res.json([]);
      let completed = 0;
      menuItems.forEach(item => {
        // Parsear combo_items si existe
        if (item.combo_items) {
          try { item.combo_items = JSON.parse(item.combo_items); }
          catch { item.combo_items = []; }
        } else {
          item.combo_items = [];
        }
        item.is_combo = !!item.is_combo;
        db.all('SELECT inv_id AS invId, qty FROM menu_ingredients WHERE menu_item_id = ?', [item.id], (err, ingredients) => {
          item.ingredients = ingredients || [];
          completed++;
          if (completed === menuItems.length) res.json(menuItems);
        });
      });
    });
  }));

  // POST /api/menu/save
  router.post('/save', requireOwner, asyncHandler(async (req, res) => {
    // ── Validación server-side ────────────────────────────────
    const validation = Validator.validate({
      name:  { required: true,  type: 'string', minLen: 1, maxLen: 120 },
      price: { required: true,  type: 'number', positive: true },
      area:  { required: true,  type: 'string', maxLen: 40 }
    }, req.body);
    if (!validation.valid) {
      return res.status(400).json({ success: false, message: validation.errors.join(' ') });
    }
    // ─────────────────────────────────────────────────────────
    const { id, catId, subcatId, emoji, available, ingredients,
            is_combo, combo_items } = req.body;
    const { name, price, area } = validation.data;
    const cost = parseFloat(req.body.cost) || 0;
    // Los productos usan nombres de iconos Material Symbols; nunca emojis.
    const safeEmoji = /^[a-z0-9_]+$/.test(emoji || '') ? emoji : 'restaurant';
    if (!catId) {
      return res.status(400).json({ success: false, message: 'Información de producto incompleta o errónea' });
    }
    const avail      = (available === false || available === 0) ? 0 : 1;
    const isComboVal = is_combo ? 1 : 0;
    const comboJSON  = (is_combo && Array.isArray(combo_items) && combo_items.length)
                       ? JSON.stringify(combo_items) : null;
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      if (id) {
        db.run(
          `UPDATE menu_items SET name=?, price=?, cost=?, catId=?, subcatId=?, emoji=?, available=?, area=?, is_combo=?, combo_items=? WHERE id=?`,
          [name, price, cost || 0, catId || 1, subcatId, safeEmoji, avail, area, isComboVal, comboJSON, id],
          function (err) {
            if (err) { db.run('ROLLBACK'); return res.status(500).json({ error: err.message }); }
            db.run('DELETE FROM menu_ingredients WHERE menu_item_id = ?', [id], (delErr) => {
              if (delErr) { db.run('ROLLBACK'); return res.status(500).json({ error: delErr.message }); }
              insertIngredients(id, ingredients || [], res, 'menu:updated');
            });
          }
        );
      } else {
        db.run(
          `INSERT INTO menu_items (name, price, cost, catId, subcatId, emoji, available, area, is_combo, combo_items) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [name, price, cost || 0, catId || 1, subcatId, safeEmoji, avail, area, isComboVal, comboJSON],
          function (err) {
            if (err) { db.run('ROLLBACK'); return res.status(500).json({ error: err.message }); }
            insertIngredients(this.lastID, ingredients || [], res, 'menu:updated');
          }
        );
      }
    });
  }));

  // POST /api/menu/promo/save  — crear o actualizar promo en un ítem
  router.post('/promo/save', requireOwner, asyncHandler(async (req, res) => {
    const { id, promo_label, promo_desc, promo_price, promo_ends_at, promo_display_name } = req.body;
    if (!id || !promo_price || !promo_ends_at) {
      return res.status(400).json({ success: false, message: 'Faltan campos: id, promo_price, promo_ends_at' });
    }
    // Guardar precio y nombre actuales como originales si todavía no es promo
    const item = db._native.prepare('SELECT name, price, is_promo, promo_original_price, promo_original_name FROM menu_items WHERE id = ?').get(id);
    if (!item) return res.status(404).json({ success: false, message: 'Ítem no encontrado' });
    const originalPrice = (item.is_promo && item.promo_original_price) ? item.promo_original_price : item.price;
    const originalName  = (item.is_promo && item.promo_original_name)  ? item.promo_original_name  : item.name;
    // Nombre a mostrar durante la promo (si no se provee, se mantiene el original)
    const displayName = (promo_display_name && promo_display_name.trim()) ? promo_display_name.trim() : originalName;

    db._native.prepare(`
      UPDATE menu_items SET
        is_promo = 1,
        promo_label = ?,
        promo_desc  = ?,
        promo_ends_at = ?,
        promo_original_price = ?,
        promo_original_name  = ?,
        price = ?,
        name  = ?
      WHERE id = ?
    `).run(promo_label || 'PROMO', promo_desc || '', Number(promo_ends_at), originalPrice, originalName, Number(promo_price), displayName, id);

    notifyChange('menu:updated');
    res.json({ success: true });
  }));

  // POST /api/menu/promo/deactivate  — desactivar promo y restaurar precio original
  router.post('/promo/deactivate', requireOwner, asyncHandler(async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: 'Falta id' });

    const item = db._native.prepare('SELECT promo_original_price FROM menu_items WHERE id = ?').get(id);
    if (!item) return res.status(404).json({ success: false, message: 'Ítem no encontrado' });

    db._native.prepare(`
      UPDATE menu_items SET
        is_promo = 0,
        promo_label = NULL,
        promo_desc  = NULL,
        promo_ends_at = NULL,
        price = COALESCE(promo_original_price, price),
        promo_original_price = NULL,
        name  = COALESCE(promo_original_name, name),
        promo_original_name  = NULL
      WHERE id = ?
    `).run(id);

    notifyChange('menu:updated');
    res.json({ success: true });
  }));

  // POST /api/menu/promo/check-expired  — desactivar promos vencidas (llamar periodicamente)
  router.post('/promo/check-expired', requireOwner, asyncHandler(async (req, res) => {
    const now = Date.now();
    const expired = db._native.prepare(
      'SELECT id, promo_original_price FROM menu_items WHERE is_promo = 1 AND promo_ends_at IS NOT NULL AND promo_ends_at < ?'
    ).all(now);

    for (const item of expired) {
      db._native.prepare(`
        UPDATE menu_items SET
          is_promo = 0, promo_label = NULL, promo_desc = NULL,
          promo_ends_at = NULL, price = COALESCE(promo_original_price, price), promo_original_price = NULL,
          name = COALESCE(promo_original_name, name), promo_original_name = NULL
        WHERE id = ?
      `).run(item.id);
    }

    if (expired.length > 0) notifyChange('menu:updated');
    res.json({ success: true, expired: expired.length });
  }));

  // DELETE /api/menu/:id
  router.delete('/:id', requireOwner, asyncHandler(async (req, res) => {
    db.run('UPDATE menu_items SET deleted = 1 WHERE id = ?', req.params.id, function (err) {
      if (err) return res.status(500).json({ error: err.message });
      notifyChange('menu:updated');
      res.json({ success: true });
    });
  }));

  return router;
}

// ── Categorías ─────────────────────────────────────────────
function categoriesRouter(db, { requireOwner, notifyChange }) {
  const router = Router();

  // GET /api/categories
  router.get('/', asyncHandler(async (req, res) => {
    db.all('SELECT * FROM categories', [], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    });
  }));

  // POST /api/categories/save
  router.post('/save', requireOwner, asyncHandler(async (req, res) => {
    const { id, name, emoji } = req.body;
    db.run(
      `INSERT OR REPLACE INTO categories (id, name, emoji) VALUES (?, ?, ?)`,
      [id || null, name, emoji],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        notifyChange('categories:updated');
        res.json({ success: true, id: this.lastID || id });
      }
    );
  }));

  // DELETE /api/categories/:id
  router.delete('/:id', requireOwner, asyncHandler(async (req, res) => {
    db.run('DELETE FROM categories WHERE id = ?', [req.params.id], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      notifyChange('categories:updated');
      res.json({ success: true });
    });
  }));

  return router;
}

// ── Subcategorías ──────────────────────────────────────────
function subcategoriesRouter(db, { requireOwner, notifyChange }) {
  const router = Router();

  // GET /api/subcategories
  router.get('/', asyncHandler(async (req, res) => {
    db.all('SELECT * FROM subcategories ORDER BY category_id, name ASC', [], (err, rows) => {
      if (err) return res.status(500).json([]);
      res.json(rows || []);
    });
  }));

  // GET /api/subcategories/by-category/:catId
  // IMPORTANT: must be registered BEFORE /:id to avoid shadowing
  router.get('/by-category/:catId', asyncHandler(async (req, res) => {
    db.all('SELECT * FROM subcategories WHERE category_id = ? ORDER BY name ASC', [req.params.catId], (err, rows) => {
      if (err) return res.status(500).json([]);
      res.json(rows || []);
    });
  }));

  // POST /api/subcategories/save
  router.post('/save', requireOwner, asyncHandler(async (req, res) => {
    const { name, category_id } = req.body;
    if (!name || !category_id) return res.status(400).json({ error: 'Nombre y categoría requeridos' });
    db.run('INSERT INTO subcategories (name, category_id) VALUES (?, ?)', [name.trim(), category_id], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      notifyChange('categories:updated');
      res.json({ success: true, id: this.lastID });
    });
  }));

  // DELETE /api/subcategories/:id
  router.delete('/:id', requireOwner, asyncHandler(async (req, res) => {
    db.run('UPDATE menu_items SET subcatId = NULL WHERE subcatId = ?', [req.params.id], () => {
      db.run('DELETE FROM subcategories WHERE id = ?', [req.params.id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        notifyChange('categories:updated');
        res.json({ success: true });
      });
    });
  }));

  return router;
}

module.exports = { menuRouter, categoriesRouter, subcategoriesRouter };