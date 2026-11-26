'use strict';

const { Router }     = require('express');
const logger     = require('../logger');
const bcrypt        = require('bcrypt');
const { loadSampleData }  = require('../seeds/sample-data');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ============================================================
//  RUTAS DE SISTEMA  —  /api/system/*
//  Incluye: reset de datos, import/export, factory-reset
// ============================================================
module.exports = function systemRoutes(db, { requireOwner, notifyChange }) {
  const router = Router();

  // POST /api/system/reset  — borrar datos operativos (pedidos, menú, etc.)
  router.post('/reset', requireOwner, asyncHandler(async (req, res) => {
    const { password } = req.body;
    if (!password) {
      logger.warn('[RESET] Intento sin contraseña — rechazado');
      return res.status(400).json({ success: false, error: 'Contraseña requerida' });
    }

    const native = db._native;
    if (!native) return res.status(500).json({ success: false, error: 'Error interno: instancia DB no disponible' });

    const configRow = native.prepare('SELECT master_pass FROM config WHERE id = 1').get();
    if (!configRow || !configRow.master_pass) {
      return res.status(500).json({ success: false, error: 'Configuración no encontrada' });
    }

    const isLegacy = !configRow.master_pass.startsWith('$2b$');
    const valid    = isLegacy ? password === configRow.master_pass : bcrypt.compareSync(password, configRow.master_pass);

    if (!valid) {
      logger.warn('[RESET] Contraseña incorrecta — acceso denegado');
      return res.status(401).json({ success: false, error: 'Contraseña incorrecta' });
    }

    if (isLegacy) {
      try {
        native.prepare('UPDATE config SET master_pass = ? WHERE id = 1').run(bcrypt.hashSync(password, 10));
        logger.info('[RESET] Contraseña migrada a bcrypt correctamente');
      } catch (migrateErr) {
        logger.warn('[RESET] No se pudo migrar la contraseña a bcrypt:', migrateErr.message);
      }
    }

    logger.info('[RESET] Autenticación OK — iniciando formateo del sistema...');
    try {
      native.transaction(() => {
        native.prepare('DELETE FROM order_items').run();
        native.prepare('DELETE FROM orders').run();
        native.prepare('DELETE FROM menu_ingredients').run();
        native.prepare('DELETE FROM menu_items').run();
        native.prepare('DELETE FROM inventory').run();
        native.prepare('DELETE FROM customers').run();
        native.prepare('DELETE FROM employees').run();
        native.prepare('DELETE FROM categories').run();
        native.prepare('DELETE FROM tables').run();
        try { native.prepare('DELETE FROM sqlite_sequence').run(); } catch (e) { /* ok */ }
      })();

      logger.info('[RESET] Formateo completado correctamente');
      notifyChange('data:updated');
      res.json({ success: true, message: 'Base de datos limpiada' });
    } catch (err) {
      logger.error('[RESET] Error durante el formateo:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  }));

  // POST /api/system/import  — restaurar backup JSON
  router.post('/import', requireOwner, asyncHandler(async (req, res) => {
    const data = req.body;
    const requiredKeys = ['config', 'menuItems', 'inventory', 'categories'];
    for (const key of requiredKeys) {
      if (!data[key]) return res.status(400).json({ success: false, error: `Falta la sección crítica: ${key}` });
    }

    const native = db._native;
    try {
      native.transaction((backup) => {
        native.prepare('DELETE FROM menu_ingredients').run();
        native.prepare('DELETE FROM order_items').run();
        native.prepare('DELETE FROM orders').run();
        native.prepare('DELETE FROM menu_items').run();
        native.prepare('DELETE FROM inventory').run();
        native.prepare('DELETE FROM categories').run();
        native.prepare('DELETE FROM customers').run();
        native.prepare('DELETE FROM employees').run();
        native.prepare('DELETE FROM tables').run();
        native.prepare('DELETE FROM zones').run();
        native.prepare('DELETE FROM subcategories').run();

        const cfg = backup.config;
        native.prepare(`UPDATE config SET restaurant_name=?, address=?, phone=?, currency=?, taxRate=?, ticketFooter=?, commissions=?, pay_methods=?, logo=? WHERE id=1`)
              .run(cfg.restaurant_name || cfg.name, cfg.address, cfg.phone, cfg.currency, cfg.taxRate, cfg.ticketFooter, JSON.stringify(cfg.commissions), JSON.stringify(cfg.payMethods), cfg.logo);

        const insertCat = native.prepare('INSERT INTO categories (id, name, emoji) VALUES (?, ?, ?)');
        backup.categories.forEach(c => insertCat.run(c.id, c.name, c.emoji));

        if (backup.zones) {
          const insertZone = native.prepare('INSERT INTO zones (name) VALUES (?)');
          backup.zones.forEach(z => insertZone.run(z.name));
        }
        if (backup.subcategories) {
          const insertSub = native.prepare('INSERT INTO subcategories (id, name, category_id) VALUES (?, ?, ?)');
          backup.subcategories.forEach(s => insertSub.run(s.id, s.name, s.category_id));
        }

        const insertInv = native.prepare(`INSERT INTO inventory (id, name, stock, minStock, unit, cost, salePrice, category, expirationDate, notes, emoji, showInPOS, area) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        backup.inventory.forEach(i => insertInv.run(i.id, i.name, i.stock, i.minStock, i.unit, i.cost, i.salePrice, i.category, i.expirationDate, i.notes, i.emoji, i.showInPOS ? 1 : 0, i.area || 'bar'));

        const insertMenu = native.prepare(`INSERT INTO menu_items (id, name, price, cost, catId, subcatId, emoji, available, area) VALUES (?,?,?,?,?,?,?,?,?)`);
        const insertIng  = native.prepare(`INSERT INTO menu_ingredients (menu_item_id, inv_id, qty) VALUES (?, ?, ?)`);
        backup.menuItems.forEach(m => {
          insertMenu.run(m.id, m.name, m.price, m.cost, m.catId, m.subcatId, m.emoji, m.available ? 1 : 0, m.area || 'cocina');
          if (m.ingredients && Array.isArray(m.ingredients)) {
            m.ingredients.forEach(ing => insertIng.run(m.id, ing.invId, ing.qty));
          }
        });

        if (backup.customers) {
          const insertCust = native.prepare(`INSERT INTO customers (id, name, phone, email, visits, totalSpent, points) VALUES (?,?,?,?,?,?,?)`);
          backup.customers.forEach(c => insertCust.run(c.id, c.name, c.phone, c.email, c.visits, c.totalSpent, c.points));
        }
        if (backup.employees) {
          const insertEmp = native.prepare(`INSERT INTO employees (id, name, role, pin, phone, active) VALUES (?,?,?,?,?,?)`);
          backup.employees.forEach(e => {
            const pinToStore = e.pin && e.pin.startsWith('$2b$') ? e.pin : bcrypt.hashSync((e.pin || '').toString(), 10);
            insertEmp.run(e.id, e.name, e.role, pinToStore, e.phone, e.active ? 1 : 0);
          });
        }
        if (backup.tables && backup.tables.length > 0) {
          const insertTable = native.prepare(`INSERT INTO tables (id, numero, capacity, zona, status, waiterId) VALUES (?,?,?,?,?,?)`);
          backup.tables.forEach(t => {
            insertTable.run(t.id, t.numero || t.id, t.capacity || 4, t.zona || 'Salón', t.status || 'free', t.waiterId || null);
          });
        }
      })(data);

      logger.info('[IMPORT] Importación masiva completada con éxito');
      notifyChange('data:updated');
      res.json({ success: true, message: 'Datos restaurados correctamente' });
    } catch (error) {
      logger.error('[IMPORT] Error durante importación:', error.message);
      res.status(500).json({ success: false, error: 'Error interno al procesar el archivo: ' + error.message });
    }
  }));

  // POST /api/system/factory-reset  — reseteo total de fábrica
  router.post('/factory-reset', requireOwner, asyncHandler(async (req, res) => {
    const { password } = req.body;
    if (!password) return res.status(400).json({ success: false, error: 'Contraseña requerida' });

    db.get('SELECT master_pass FROM config WHERE id = 1', [], (err, row) => {
      if (err || !row) return res.status(500).json({ success: false, error: 'Error de sistema' });

      const isLegacy = !row.master_pass.startsWith('$2b$');
      const valid    = isLegacy ? password === row.master_pass : bcrypt.compareSync(password, row.master_pass);
      if (!valid) return res.status(401).json({ success: false, error: 'Contraseña de propietario incorrecta' });

      const native = db._native;
      try {
        native.transaction(() => {
          native.prepare('DELETE FROM order_items').run();
          native.prepare('DELETE FROM orders').run();
          native.prepare('DELETE FROM menu_ingredients').run();
          native.prepare('DELETE FROM menu_items').run();
          native.prepare('DELETE FROM inventory').run();
          native.prepare('DELETE FROM customers').run();
          native.prepare('DELETE FROM employees').run();
          native.prepare('DELETE FROM categories').run();
          native.prepare('DELETE FROM tables').run();
          native.prepare('DELETE FROM zones').run();
          native.prepare('DELETE FROM subcategories').run();
          native.prepare('DELETE FROM sqlite_sequence').run();
          native.prepare(`UPDATE config SET restaurant_name='Mi Restaurante', address='', phone='', logo=NULL, commissions='{}', pay_methods='{}' WHERE id=1`).run();
        })();

        logger.warn('[FACTORY-RESET] Reseteo total ejecutado por el usuario.');
        notifyChange('data:updated');
        res.json({ success: true, message: 'Sistema restaurado a valores de fábrica' });
      } catch (dbErr) {
        logger.error('[FACTORY-RESET] Error en reseteo:', dbErr.message);
        res.status(500).json({ success: false, error: 'Fallo crítico al limpiar la base de datos' });
      }
    });
  }));

  // POST /api/system/load-sample-data
  // Carga datos de ejemplo solo cuando el usuario lo confirma en el onboarding.
  // Falla con 409 si ya existen productos (idempotente).
  router.post('/load-sample-data', requireOwner, asyncHandler(async (req, res) => {
    const native = db._native;
    if (!native) return res.status(500).json({ success: false, error: 'Error interno: instancia DB no disponible' });

    try {
      const stats = loadSampleData(native);
      logger.info('[SAMPLE-DATA] Datos de ejemplo cargados:', JSON.stringify(stats));
      notifyChange('data:updated');
      res.json({ success: true, message: 'Datos de ejemplo cargados correctamente', stats });
    } catch (err) {
      // loadSampleData lanza si ya hay datos → 409 Conflict
      const status = err.message.includes('Ya existen') ? 409 : 500;
      logger.warn('[SAMPLE-DATA] No se cargaron datos:', err.message);
      res.status(status).json({ success: false, error: err.message });
    }
  }));

  // GET /api/system/export  — exportar toda la DB como JSON
  router.get('/export', requireOwner, asyncHandler(async (req, res) => {
    const native = db._native;
    if (!native) return res.status(500).json({ success: false, error: 'Error interno' });
    try {
      const config = native.prepare('SELECT * FROM config WHERE id=1').get() || {};
      const categories    = native.prepare('SELECT * FROM categories').all();
      const subcategories = native.prepare('SELECT * FROM subcategories').all();
      const zones         = native.prepare('SELECT * FROM zones').all();
      const menuItems     = native.prepare('SELECT * FROM menu_items').all().map(m => ({
        ...m,
        ingredients: native.prepare('SELECT inv_id AS invId, qty FROM menu_ingredients WHERE menu_item_id=?').all(m.id)
      }));
      const inventory  = native.prepare('SELECT * FROM inventory').all();
      const employees  = native.prepare('SELECT id, name, role, pin, phone, active FROM employees').all();
      const customers  = native.prepare('SELECT * FROM customers').all();
      const tables     = native.prepare('SELECT * FROM tables').all();

      const payload = {
        exportedAt: new Date().toISOString(),
        version: '2.0.0',
        config: {
          ...config,
          master_pass: undefined,   // nunca exportar el hash de contraseña
          commissions: config.commissions ? JSON.parse(config.commissions) : {},
          payMethods:  config.pay_methods  ? JSON.parse(config.pay_methods)  : {}
        },
        categories, subcategories, zones,
        menuItems, inventory, employees, customers, tables
      };

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="lmm-backup-${Date.now()}.json"`);
      res.json(payload);
      logger.info('[EXPORT] Backup JSON generado');
    } catch (err) {
      logger.error('[EXPORT] Error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  }));


  // ── POST /api/system/cleanup-ghost-orders ─────────────────
  // Cancela pedidos sin items (residuos del bug de db.js stmt.finalize)
  router.post('/cleanup-ghost-orders', requireOwner, asyncHandler(async (req, res) => {
    const native = db._native;
    if (!native) {
      return res.status(500).json({ success: false, error: 'Error interno: instancia DB no disponible' });
    }
    try {
      const { count } = native.prepare(`
        SELECT COUNT(*) as count FROM orders
        WHERE id NOT IN (SELECT DISTINCT order_id FROM order_items)
          AND status NOT IN ('delivered', 'cancelled')
          AND paymentMethod IS NULL
      `).get();

      if (count === 0) {
        return res.json({ success: true, cancelled: 0, message: 'No hay pedidos fantasma para limpiar.' });
      }

      const result = native.prepare(`
        UPDATE orders
        SET status = 'cancelled',
            paymentMethod = 'error-vacios',
            closedAt = ?
        WHERE id NOT IN (SELECT DISTINCT order_id FROM order_items)
          AND status NOT IN ('delivered', 'cancelled')
          AND paymentMethod IS NULL
      `).run(Date.now());

      logger.info(`[CLEANUP] ${result.changes} pedidos fantasma cancelados`);
      notifyChange('data:updated', { source: 'system/cleanup-ghost-orders' });

      res.json({
        success: true,
        cancelled: result.changes,
        message: `Se cancelaron ${result.changes} pedido(s) sin items.`
      });
    } catch (err) {
      logger.error('[CLEANUP] Error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  }));

  return router;
};