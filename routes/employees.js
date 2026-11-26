'use strict';

const { Router } = require('express');
const bcrypt     = require('bcrypt');

const BCRYPT_ROUNDS = 10;

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ============================================================
//  RUTAS DE EMPLEADOS  —  /api/employees/*
// ============================================================
module.exports = function employeesRoutes(db, { requireOwner, notifyChange, Validator }) {
  const router = Router();

  // GET /api/employees — nunca exponemos el hash del PIN
  router.get('/', asyncHandler(async (req, res) => {
    db.all('SELECT id, name, role, phone, active FROM employees WHERE deleted IS NULL OR deleted = 0', [], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  }));

  // POST /api/employees/save
  router.post('/save', requireOwner, asyncHandler(async (req, res) => {
    // ── Validación server-side con Validator ──────────────────
    const validation = Validator.validate({
      name: { required: true, type: 'string', minLen: 2, maxLen: 80 },
      role: { required: true, type: 'string', maxLen: 40 },
      pin:  { required: true, type: 'string', pattern: 'pin' }
    }, req.body);

    if (!validation.valid) {
      return res.status(400).json({ success: false, message: validation.errors.join(' ') });
    }

    const { id, phone, active } = req.body;
    const { name, role, pin } = validation.data;

    // Hash bcrypt del PIN. Si el valor ya es un hash válido (ej: toggle de estado
    // sin reeditar el PIN) se preserva para evitar doble-hasheo.
    const pinToStore = pin.startsWith('$2b$') ? pin : bcrypt.hashSync(pin.toString(), BCRYPT_ROUNDS);

    if (id) {
      db.run(
        `UPDATE employees SET name=?, role=?, pin=?, phone=?, active=? WHERE id=?`,
        [name, role, pinToStore, phone || '', active ? 1 : 0, id],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });
          notifyChange('employees:updated');
          res.json({ success: true });
        }
      );
    } else {
      db.run(
        `INSERT INTO employees (name, role, pin, phone, active) VALUES (?,?,?,?,?)`,
        [name, role, pinToStore, phone || '', 1],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });
          notifyChange('employees:updated');
          res.json({ success: true });
        }
      );
    }
  }));

  // DELETE /api/employees/delete/:id
  router.delete('/delete/:id', requireOwner, asyncHandler(async (req, res) => {
    db.run('UPDATE employees SET deleted = 1 WHERE id = ?', [req.params.id], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      notifyChange('employees:updated');
      res.json({ success: true });
    });
  }));

  return router;
};