'use strict';

const { Router } = require('express');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ============================================================
//  RUTAS DE CLIENTES  —  /api/customers/*
// ============================================================
module.exports = function customersRoutes(db, { requireSession, requireOwner, notifyChange, Validator }) {
  const router = Router();

  // GET /api/customers
  router.get('/', asyncHandler(async (req, res) => {
    db.all('SELECT * FROM customers WHERE deleted IS NULL OR deleted = 0', [], (err, rows) => res.json(rows || []));
  }));

  // POST /api/customers/save
  router.post('/save', requireSession, asyncHandler(async (req, res) => {
    const { id } = req.body;

    const validation = Validator.validate({
      name:  { required: true,  type: 'string', minLen: 2, maxLen: 100 },
      phone: { required: false, type: 'string', maxLen: 30 },
      email: { required: false, type: 'string', maxLen: 120 },
    }, req.body);

    if (!validation.valid) {
      return res.status(400).json({ success: false, message: validation.errors.join(' '), code: 'VALIDATION_ERROR' });
    }

    const { name, phone, email } = validation.data;
    const visits     = Math.max(0, parseInt(req.body.visits)     || 0);
    const totalSpent = Math.max(0, parseFloat(req.body.totalSpent) || 0);
    const points     = Math.max(0, parseInt(req.body.points)     || 0);

    if (id) {
      db.run(
        `UPDATE customers SET name=?, phone=?, email=?, visits=?, totalSpent=?, points=? WHERE id=?`,
        [name, phone || '', email || '', visits, totalSpent, points, id],
        (err) => {
          if (err) return res.status(500).json({ error: err.message });
          notifyChange('customers:updated');
          res.json({ success: true });
        }
      );
    } else {
      db.run(
        `INSERT INTO customers (name, phone, email, visits, totalSpent, points) VALUES (?,?,?,?,?,?)`,
        [name, phone || '', email || '', 0, 0, 0],
        (err) => {
          if (err) return res.status(500).json({ error: err.message });
          notifyChange('customers:updated');
          res.json({ success: true });
        }
      );
    }
  }));

  // DELETE /api/customers/:id
  router.delete('/:id', requireOwner, asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id || id < 1) return res.status(400).json({ error: 'ID inválido', code: 'VALIDATION_ERROR' });
    db.run('UPDATE customers SET deleted = 1 WHERE id = ?', [id], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      notifyChange('customers:updated');
      res.json({ success: true });
    });
  }));

  return router;
};