'use strict';

const { Router } = require('express');
const logger = require('../logger');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { _db } = require('../db');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Hashing del PIN de supervisor. Usamos bcrypt (hash con salt) en lugar del
// SHA-256 plano de antes por seguridad. Se mantiene compatibilidad con PINs
// legacy guardados como sha256 (sin salt): se verifican y se migran a bcrypt.
function hashPin(pin) {
  return bcrypt.hashSync(String(pin), 10);
}

function pinMatches(pin, stored) {
  if (!stored) return false;
  if (stored.startsWith('$2b$') || stored.startsWith('$2a$')) {
    return bcrypt.compareSync(String(pin), stored);
  }
  // Legacy: PIN guardado como sha256 hexadecimal (sin salt)
  return crypto.createHash('sha256').update(String(pin)).digest('hex') === stored;
}

// ============================================================
//  RUTAS DE CONFIGURACIÓN  —  /api/config/*
// ============================================================
module.exports = function configRoutes(db, { requireSession, requireOwner, notifyChange }) {
  const router = Router();

  // ── GET /api/config ─────────────────────────────────────────
  // Accesible pre-login (necesario para la pantalla de licencia/idioma),
  // por lo que NUNCA debe exponer secretos. Se eliminan credenciales y
  // claves de nube de la respuesta; el frontend solo necesita datos
  // públicos (nombre, moneda, etc.) y los secretos se configuran por otros
  // endpoints protegidos (link-cloud, security).
  const SENSITIVE_KEYS = new Set([
    'master_pass', 'session_token', 'supabase_anon_key', 'supabase_url',
    'supabase_secret', 'cloud_restaurant_id', 'mp_access_token'
  ]);
  router.get('/', asyncHandler(async (req, res) => {
    db.get('SELECT * FROM config WHERE id = 1', (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (row) {
        for (const key of Object.keys(row)) {
          if (SENSITIVE_KEYS.has(key)) delete row[key];
        }
        if (row.commissions) { try { row.commissions = JSON.parse(row.commissions); } catch { row.commissions = {}; } }
        if (row.pay_methods) { try { row.pay_methods = JSON.parse(row.pay_methods); } catch { row.pay_methods = {}; } }
      }
      res.json(row || {});
    });
  }));

  // ── POST /api/config/full-save ───────────────────────────────
  router.post('/full-save', requireOwner, asyncHandler(async (req, res) => {
    const { restaurant_name, name, address, phone, currency, taxRate, ticketFooter, commissions, payMethods, logo } = req.body;
    const finalName = restaurant_name || name || 'Mi Restaurante';
    db.run(
      `UPDATE config SET restaurant_name=?,address=?,phone=?,currency=?,taxRate=?,ticketFooter=?,commissions=?,pay_methods=?,logo=? WHERE id=1`,
      [finalName, address, phone, currency, (taxRate != null ? Number(taxRate) : 0), ticketFooter,
       JSON.stringify(commissions||{}), JSON.stringify(payMethods||{}), logo],
      function(err) {
        if (err) { logger.error('❌ Config save:', err.message); return res.status(500).json({ success:false, error:err.message }); }
        notifyChange('config:updated');
        try { require('../sync-engine').pushPublicSettings(); } catch {}
        res.json({ success: true });
      }
    );
  }));

  // ── POST /api/config/save ────────────────────────────────────
  router.post('/save', requireOwner, asyncHandler(async (req, res) => {
    const { name, email } = req.body;
    db.run('UPDATE config SET restaurant_name=?,master_email=? WHERE id=1', [name, email], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      notifyChange('config:updated');
      try { require('../sync-engine').pushPublicSettings(); } catch {}
      res.json({ success: true });
    });
  }));

  // ══════════════════════════════════════════════════════════════
  //  SEGURIDAD
  // ══════════════════════════════════════════════════════════════

  // GET /api/config/security
  router.get('/security', asyncHandler(async (req, res) => {
    db.get('SELECT * FROM security_config WHERE id=1', (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      const r = row || {};
      res.json({
        pin_set:          !!r.supervisor_pin,
        pin_triggers:     r.pin_triggers     ? JSON.parse(r.pin_triggers)     : {},
        role_permissions: r.role_permissions ? JSON.parse(r.role_permissions) : {},
      });
    });
  }));

  // POST /api/config/security/pin
  router.post('/security/pin', requireOwner, asyncHandler(async (req, res) => {
    const { new_pin, old_pin } = req.body;
    if (!new_pin || String(new_pin).length < 4)
      return res.status(400).json({ success:false, error:'PIN debe tener al menos 4 dígitos' });

    db.get('SELECT supervisor_pin FROM security_config WHERE id=1', (err, row) => {
      if (err) return res.status(500).json({ success:false, error:err.message });

      // Si ya hay PIN configurado, siempre verificar el viejo (sin importar si se mandó o no)
      if (row && row.supervisor_pin) {
        if (!pinMatches(old_pin, row.supervisor_pin))
          return res.status(401).json({ success:false, error:'PIN actual incorrecto' });
      }

      db.run('UPDATE security_config SET supervisor_pin=? WHERE id=1', [hashPin(new_pin)], (err2) => {
        if (err2) return res.status(500).json({ success:false, error:err2.message });
        res.json({ success:true });
      });
    });
  }));

  // DELETE /api/config/security/pin
  router.delete('/security/pin', requireOwner, asyncHandler(async (req, res) => {
    db.run('UPDATE security_config SET supervisor_pin=NULL WHERE id=1', (err) => {
      if (err) return res.status(500).json({ success:false, error:err.message });
      res.json({ success:true });
    });
  }));

  // POST /api/config/security/verify-pin
  router.post('/security/verify-pin', requireSession, asyncHandler(async (req, res) => {
    const { pin } = req.body;
    db.get('SELECT supervisor_pin FROM security_config WHERE id=1', (err, row) => {
      if (err) return res.status(500).json({ valid:false });
      if (!row || !row.supervisor_pin) return res.json({ valid:true }); // sin PIN = acceso libre
      const valid = pinMatches(pin, row.supervisor_pin);
      // Migrar PIN legacy (sha256) a bcrypt al primer acceso correcto
      if (valid && !row.supervisor_pin.startsWith('$2')) {
        db.run('UPDATE security_config SET supervisor_pin=? WHERE id=1', [hashPin(pin)], () => {});
      }
      res.json({ valid });
    });
  }));

  // POST /api/config/security/triggers
  router.post('/security/triggers', requireOwner, asyncHandler(async (req, res) => {
    const { key, value } = req.body;
    db.get('SELECT pin_triggers FROM security_config WHERE id=1', (err, row) => {
      if (err) return res.status(500).json({ success:false });
      const triggers = row?.pin_triggers ? JSON.parse(row.pin_triggers) : {};
      triggers[key] = !!value;
      db.run('UPDATE security_config SET pin_triggers=? WHERE id=1', [JSON.stringify(triggers)], (err2) => {
        if (err2) return res.status(500).json({ success:false });
        res.json({ success:true });
      });
    });
  }));

  // POST /api/config/security/permissions
  router.post('/security/permissions', requireOwner, asyncHandler(async (req, res) => {
    const { permissions } = req.body;
    db.run('UPDATE security_config SET role_permissions=? WHERE id=1', [JSON.stringify(permissions||{})], (err) => {
      if (err) return res.status(500).json({ success:false, error:err.message });
      res.json({ success:true });
    });
  }));

  // ══════════════════════════════════════════════════════════════
  //  DESCUENTOS PREDEFINIDOS
  // ══════════════════════════════════════════════════════════════

  // GET /api/config/discounts
  router.get('/discounts', asyncHandler(async (req, res) => {
    db.all('SELECT * FROM predefined_discounts WHERE active=1 ORDER BY id', (err, rows) => {
      if (err) return res.status(500).json({ error:err.message });
      res.json({ discounts: rows || [] });
    });
  }));

  // POST /api/config/discounts
  router.post('/discounts', requireOwner, asyncHandler(async (req, res) => {
    const { name, value, type } = req.body;
    if (!name || value == null) return res.status(400).json({ success:false, error:'Faltan datos' });
    db.run(
      'INSERT INTO predefined_discounts (name,value,type) VALUES (?,?,?)',
      [name.trim(), Number(value), type||'percent'],
      function(err) {
        if (err) return res.status(500).json({ success:false, error:err.message });
        res.json({ success:true, id:this.lastID });
      }
    );
  }));

  // DELETE /api/config/discounts/:id
  router.delete('/discounts/:id', requireOwner, asyncHandler(async (req, res) => {
    db.run('UPDATE predefined_discounts SET active=0 WHERE id=?', [req.params.id], (err) => {
      if (err) return res.status(500).json({ success:false });
      res.json({ success:true });
    });
  }));

  // ══════════════════════════════════════════════════════════════
  //  CAJA — APERTURA / CIERRE
  // ══════════════════════════════════════════════════════════════

  // GET /api/config/caja/current
  router.get('/caja/current', asyncHandler(async (req, res) => {
    db.get("SELECT * FROM caja_sessions WHERE status='open' ORDER BY id DESC LIMIT 1", (err, row) => {
      if (err) return res.status(500).json({ error:err.message });
      res.json({ session: row || null });
    });
  }));

  // POST /api/config/caja/open
  router.post('/caja/open', requireSession, asyncHandler(async (req, res) => {
    const { opening_amount, opened_by } = req.body;
    // Cerrar sesiones abiertas huérfanas
    db.run("UPDATE caja_sessions SET status='closed',closed_at=? WHERE status='open'", [Date.now()], () => {
      db.run(
        'INSERT INTO caja_sessions (status,opening_amount,opened_at,opened_by) VALUES (?,?,?,?)',
        ['open', Number(opening_amount)||0, Date.now(), opened_by||'Desconocido'],
        function(err) {
          if (err) return res.status(500).json({ success:false, error:err.message });
          notifyChange('caja:opened');
          res.json({ success:true, id:this.lastID });
        }
      );
    });
  }));

  // POST /api/config/caja/close
  router.post('/caja/close', requireSession, asyncHandler(async (req, res) => {
    const { session_id, closing_amount, notes, closed_by } = req.body;
    db.run(
      "UPDATE caja_sessions SET status='closed',closing_amount=?,closed_at=?,notes=?,closed_by=? WHERE id=? AND status='open'",
      [Number(closing_amount)||0, Date.now(), notes||'', closed_by||'Desconocido', session_id],
      function(err) {
        if (err) return res.status(500).json({ success:false, error:err.message });
        if (this.changes === 0) return res.status(404).json({ success:false, error:'Sesión no encontrada o ya cerrada' });
        notifyChange('caja:closed');
        res.json({ success:true });
      }
    );
  }));

  // ══════════════════════════════════════════════════════════════
  //  TICKET — FORMATO Y AUTO-IMPRESIÓN
  // ══════════════════════════════════════════════════════════════

  // GET /api/config/ticket-format
  router.get('/ticket-format', asyncHandler(async (req, res) => {
    db.get('SELECT * FROM ticket_config WHERE id=1', (err, row) => {
      if (err) return res.status(500).json({ error:err.message });
      res.json({
        format:    row?.format    ? JSON.parse(row.format)    : {},
        autoprint: row?.autoprint ? JSON.parse(row.autoprint) : {},
      });
    });
  }));

  // POST /api/config/ticket-format
  router.post('/ticket-format', requireOwner, asyncHandler(async (req, res) => {
    const { format } = req.body;
    db.run('UPDATE ticket_config SET format=? WHERE id=1', [JSON.stringify(format||{})], (err) => {
      if (err) return res.status(500).json({ success:false, error:err.message });
      res.json({ success:true });
    });
  }));

  // POST /api/config/auto-print
  router.post('/auto-print', requireOwner, asyncHandler(async (req, res) => {
    const { autoprint } = req.body;
    db.run('UPDATE ticket_config SET autoprint=? WHERE id=1', [JSON.stringify(autoprint||{})], (err) => {
      if (err) return res.status(500).json({ success:false, error:err.message });
      res.json({ success:true });
    });
  }));

  // ══════════════════════════════════════════════════════════════
  //  HORARIOS DEL LOCAL
  // ══════════════════════════════════════════════════════════════

  // GET /api/config/business-hours
  router.get('/business-hours', asyncHandler(async (req, res) => {
    db.get('SELECT hours FROM business_hours WHERE id=1', (err, row) => {
      if (err) return res.status(500).json({ error:err.message });
      res.json({ hours: row?.hours ? JSON.parse(row.hours) : {} });
    });
  }));

  // POST /api/config/business-hours
  router.post('/business-hours', requireOwner, asyncHandler(async (req, res) => {
    const { hours } = req.body;
    db.run('UPDATE business_hours SET hours=? WHERE id=1', [JSON.stringify(hours||{})], (err) => {
      if (err) return res.status(500).json({ success:false, error:err.message });
      res.json({ success:true });
    });
  }));

  // ══════════════════════════════════════════════════════════════
  //  ALERTAS DE STOCK
  // ══════════════════════════════════════════════════════════════

  // GET /api/config/stock-alerts
  router.get('/stock-alerts', asyncHandler(async (req, res) => {
    db.get('SELECT * FROM stock_alert_config WHERE id=1', (err, row) => {
      if (err) return res.status(500).json({ error:err.message });
      res.json({ alerts: { enabled: row?.enabled !== 0, threshold: row?.threshold ?? 5 } });
    });
  }));

  // POST /api/config/stock-alerts
  router.post('/stock-alerts', requireOwner, asyncHandler(async (req, res) => {
    const { enabled, threshold } = req.body;
    db.run('UPDATE stock_alert_config SET enabled=?,threshold=? WHERE id=1',
      [enabled ? 1 : 0, Number(threshold)||5],
      (err) => {
        if (err) return res.status(500).json({ success:false, error:err.message });
        res.json({ success:true });
      }
    );
  }));

  // ══════════════════════════════════════════════════════════════
  //  TURNOS DEL DÍA
  // ══════════════════════════════════════════════════════════════

  // GET /api/config/shifts
  router.get('/shifts', asyncHandler(async (req, res) => {
    db.all('SELECT * FROM work_shifts WHERE active=1 ORDER BY start_time', (err, rows) => {
      if (err) return res.status(500).json({ error:err.message });
      res.json({ shifts: rows || [] });
    });
  }));

  // POST /api/config/shifts
  router.post('/shifts', requireOwner, asyncHandler(async (req, res) => {
    const { name, start_time, end_time } = req.body;
    if (!name || !start_time || !end_time)
      return res.status(400).json({ success:false, error:'Faltan datos' });
    db.run(
      'INSERT INTO work_shifts (name,start_time,end_time) VALUES (?,?,?)',
      [name.trim(), start_time, end_time],
      function(err) {
        if (err) return res.status(500).json({ success:false, error:err.message });
        res.json({ success:true, id:this.lastID });
      }
    );
  }));

  // DELETE /api/config/shifts/:id
  router.delete('/shifts/:id', requireOwner, asyncHandler(async (req, res) => {
    db.run('UPDATE work_shifts SET active=0 WHERE id=?', [req.params.id], (err) => {
      if (err) return res.status(500).json({ success:false });
      res.json({ success:true });
    });
  }));

  // ══════════════════════════════════════════════════════════════
  //  SINCRONIZACIÓN CON LA NUBE (Supabase)
  // ══════════════════════════════════════════════════════════════

  // GET /api/config/sync-status
  router.get('/sync-status', asyncHandler(async (req, res) => {
    let status = { enabled: false, isOnline: false, pendingCount: 0 };
    try {
      status = require('../sync-engine').getSyncStatus();
    } catch (err) {
      status.error = err.message;
    }
    // Para poder precargar el formulario en el frontend (nunca devolvemos la key completa)
    try {
      const cfg = _db.prepare('SELECT cloud_restaurant_id, supabase_url, supabase_anon_key FROM config WHERE id = 1').get();
      if (cfg) {
        status.savedRestaurantId = cfg.cloud_restaurant_id || null;
        status.savedSupabaseUrl = cfg.supabase_url || null;
        status.hasSavedKey = !!cfg.supabase_anon_key;
      }
    } catch {}
    res.json(status);
  }));

  // GET /api/config/sync-check
  // Compara cantidad de filas local vs. Supabase, tabla por tabla.
  // Sirve para confirmar que el desktop y la nube "tienen la misma info".
  router.get('/sync-check', requireOwner, asyncHandler(async (req, res) => {
    try {
      const report = await require('../sync-engine').checkIntegrity();
      if (!report) return res.status(400).json({ success: false, error: 'La sincronización no está activa (¿vinculaste la nube?)' });
      res.json({ success: true, report });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }));

  // POST /api/config/resync
  // Re-encola para subir todo lo que haya local (con el filtro correcto:
  // solo pedidos ABIERTOS, no el historial completo). Útil si instalaste
  // el parche antes del fix de "pedidos fantasma" y ya se subieron pedidos
  // viejos/cerrados que no debían subirse.
  router.post('/resync', requireOwner, asyncHandler(async (req, res) => {
    try {
      const { runInitialCloudBackfill } = require('../db');
      const result = runInitialCloudBackfill(true);
      require('../sync-engine').flushQueue();
      res.json({ success: true, result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }));

  // POST /api/config/link-cloud
  // Vincula este local a un restaurante en Supabase. Se hace UNA vez.
  // El restaurant_id lo generás insertando una fila en la tabla `restaurants`
  // de tu proyecto Supabase (ver 01_supabase_schema.sql).
  router.post('/link-cloud', requireOwner, asyncHandler(async (req, res) => {
    const { restaurant_id, supabase_url, supabase_anon_key } = req.body;
    if (!restaurant_id || !supabase_url || !supabase_anon_key) {
      return res.status(400).json({ success: false, error: 'Faltan restaurant_id, supabase_url o supabase_anon_key' });
    }
    db.run(
      'UPDATE config SET cloud_restaurant_id=?, supabase_url=?, supabase_anon_key=? WHERE id=1',
      [restaurant_id.trim(), supabase_url.trim(), supabase_anon_key.trim()],
      function (err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (!this.changes) {
          // No existía la fila config#1 (instalación sin login inicial completo)
          return res.status(500).json({ success: false, error: 'No se encontró la configuración del local (config#1). Completá el login inicial de la app antes de vincular la nube.' });
        }
        try {
          const { initSync, startV8Engine } = require('../sync-engine');
          initSync({ supabaseUrl: supabase_url.trim(), supabaseAnonKey: supabase_anon_key.trim(), restaurantId: restaurant_id.trim(), notifyChange });
          // Misma condición única que el motor; con el flag apagado no se inicia V8.
          if (require('../db').isV8Enabled(db._native)) {
            startV8Engine({ supabaseUrl: supabase_url.trim(), supabaseAnonKey: supabase_anon_key.trim(), restaurantId: restaurant_id.trim(), notifyChange });
          } else {
            logger.info('[INV-V8] Vincular nube no inicia V8: activación incompleta/apagada');
          }
        } catch (syncErr) {
          logger.error('❌ [SYNC] No se pudo iniciar sync tras vincular:', syncErr.message);
          // Se guardó en config igual (se reintentará solo al reiniciar la app),
          // pero avisamos del error real en vez de taparlo.
          return res.status(500).json({
            success: false,
            error: 'Se guardó la configuración, pero el motor de sync no pudo arrancar: ' + syncErr.message +
                   '. Probablemente falta instalar @supabase/supabase-js (correr "npm install" de nuevo).'
          });
        }
        notifyChange('config:updated');
        res.json({ success: true });
      }
    );
  }));

  // POST /api/config/unlink-cloud
  router.post('/unlink-cloud', requireOwner, asyncHandler(async (req, res) => {
    db.run('UPDATE config SET cloud_restaurant_id=NULL, supabase_url=NULL, supabase_anon_key=NULL WHERE id=1', (err) => {
      if (err) return res.status(500).json({ success: false, error: err.message });
      try { require('../sync-engine').stopSync(); } catch {}
      res.json({ success: true });
    });
  }));

  return router;
};