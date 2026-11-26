'use strict';

const { Router } = require('express');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ============================================================
//  RUTAS DE MESAS Y ZONAS — Dos routers independientes:
//    tablesRouter → app.use('/api/tables', tablesRouter)
//    zonesRouter  → app.use('/api/zones',  zonesRouter)
// ============================================================

const VALID_TABLE_STATUSES = [
  'free', 'occupied', 'billing', 'reserved',
  'blocked', 'blocked_vip', 'maintenance', 'no_use', 'cleaning',
];

function tablesRouter(db, { requireSession, requireOwner, notifyChange }) {
  const router = Router();

  // GET /api/tables
  router.get('/', requireSession, asyncHandler(async (req, res) => {
    db.all('SELECT * FROM tables WHERE deleted IS NULL OR deleted = 0', [], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    });
  }));

  // POST /api/tables/save
  router.post('/save', requireOwner, asyncHandler(async (req, res) => {
    const { id, capacity, status, waiterId, waiterName, zona, numero, guests, openedAt } = req.body;

    // ── Whitelist de status ───────────────────────────────────
    const safeStatus = VALID_TABLE_STATUSES.includes(status) ? status : 'free';

    // NOTA: usamos UPSERT real (no INSERT OR REPLACE) porque REPLACE borra
    // y recrea la fila, lo que pisaría uuid/deleted/updated_at usados para
    // sincronizar con la nube y crearía mesas duplicadas del lado de Supabase.
    db.run(
      `INSERT INTO tables (id, capacity, status, waiterId, waiterName, zona, numero, guests, openedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         capacity=excluded.capacity, status=excluded.status, waiterId=excluded.waiterId,
         waiterName=excluded.waiterName, zona=excluded.zona, numero=excluded.numero,
         guests=excluded.guests, openedAt=excluded.openedAt`,
      [id, capacity, safeStatus, waiterId || null, waiterName, zona || 'Salón', numero, guests || null, openedAt || null],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        notifyChange('tables:updated');
        res.json({ success: true });
      }
    );
  }));

  // POST /api/tables/reorder -- guarda sort_order y zona en bloque
  router.post('/reorder', requireOwner, asyncHandler(async (req, res) => {
    const { order } = req.body; // [{ id, sort_order, zona }]
    if (!Array.isArray(order) || order.length === 0) {
      return res.status(400).json({ error: 'order array requerido' });
    }
    let pending = order.length;
    let hasErr  = false;
    for (const { id, sort_order, zona } of order) {
      db.run(
        'UPDATE tables SET sort_order = ?, zona = ? WHERE id = ?',
        [sort_order ?? 0, zona || 'Salon', id],
        (err) => { if (err) hasErr = true; }
      );
    }
    // Notificar y responder luego de encolar todas las queries
    setTimeout(() => {
      notifyChange('tables:updated');
      if (hasErr) res.status(500).json({ error: 'Partial update error' });
      else        res.json({ success: true });
    }, 80);
  }));

  // DELETE /api/tables/delete/:id
  router.delete('/delete/:id', requireOwner, asyncHandler(async (req, res) => {
    db.run('UPDATE tables SET deleted = 1 WHERE id = ?', [req.params.id], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      notifyChange('tables:updated');
      res.json({ success: true });
    });
  }));

  return router;
}

function zonesRouter(db, { requireSession, requireOwner, notifyChange }) {
  const router = Router();

  // GET /api/zones
  router.get('/', requireSession, asyncHandler(async (req, res) => {
    db.all('SELECT * FROM zones ORDER BY name ASC', [], (err, rows) => {
      if (err) return res.status(500).json([]);
      res.json(rows || []);
    });
  }));

  // POST /api/zones
  router.post('/', requireOwner, asyncHandler(async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Nombre requerido' });
    db.run('INSERT OR IGNORE INTO zones (name) VALUES (?)', [name], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      notifyChange('tables:updated');
      res.json({ success: true });
    });
  }));

  // POST /api/zones/save  (alias usado por el frontend)
  router.post('/save', requireOwner, asyncHandler(async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).send('Falta nombre');
    db.run('INSERT OR IGNORE INTO zones (name) VALUES (?)', [name], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      notifyChange('tables:updated');
      res.json({ success: true });
    });
  }));

  // DELETE /api/zones/:name
  router.delete('/:name', requireOwner, asyncHandler(async (req, res) => {
    db.run('DELETE FROM zones WHERE name = ?', [req.params.name], () => {
      notifyChange('tables:updated');
      res.json({ success: true });
    });
  }));

  return router;
}

module.exports = { tablesRouter, zonesRouter };