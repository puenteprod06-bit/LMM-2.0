'use strict';

// ============================================================
//  routes/mercadopago.js — Integración Mercado Pago QR Dinámico
//  Endpoints:
//    GET  /api/mp/config        → devuelve config guardada (sin token)
//    POST /api/mp/config        → guarda credenciales
//    POST /api/mp/qr            → genera orden QR dinámica en MP
//    GET  /api/mp/qr/:orderId   → consulta estado de pago de una orden MP
//    DELETE /api/mp/qr/:orderId → cancela orden QR en MP
// ============================================================

const { Router } = require('express');
const logger     = require('../logger');

const MP_API = 'https://api.mercadopago.com';

// Helper: asyncHandler para no repetir try/catch
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Helper: fetch hacia MP con el token del restaurante
async function mpFetch(path, token, options = {}) {
  const url = `${MP_API}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': options.idempotencyKey || `lmm-${Date.now()}`,
      ...(options.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.message || data?.error || `HTTP ${res.status}`;
    throw Object.assign(new Error(msg), { status: res.status, mpData: data });
  }
  return data;
}

module.exports = function mercadopagoRoutes(db, ctx) {
  const router = Router();
  const { requireSession, requireOwner } = ctx;
  const native = db._native;

  // ── Asegurar tabla integrations ──────────────────────────────────────
  try {
    native.exec(`
      CREATE TABLE IF NOT EXISTS integrations (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT 0
      )
    `);
  } catch (e) {
    logger.warn('[MP] Error creando tabla integrations:', e.message);
  }

  // ── Helpers BD ───────────────────────────────────────────────────────
  function getConfig() {
    const rows = native.prepare(
      `SELECT key, value FROM integrations WHERE key LIKE 'mp_%'`
    ).all();
    const cfg = {};
    rows.forEach(r => { cfg[r.key.replace('mp_', '')] = r.value; });
    return cfg;           // { access_token, store_id, pos_external_id }
  }

  function setConfig(key, value) {
    native.prepare(
      `INSERT INTO integrations (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
    ).run(`mp_${key}`, value, Date.now());
  }

  // ── GET /api/mp/config ───────────────────────────────────────────────
  // Devuelve si está configurado y los IDs (nunca el token en claro)
  router.get('/config', requireSession, asyncHandler(async (req, res) => {
    const cfg = getConfig();
    res.json({
      configured:      !!cfg.access_token,
      has_token:       !!cfg.access_token,
      store_id:        cfg.store_id        || '',
      pos_external_id: cfg.pos_external_id || '',
      // Máscara del token: solo los últimos 6 caracteres
      token_hint: cfg.access_token
        ? `...${cfg.access_token.slice(-6)}`
        : null,
    });
  }));

  // ── POST /api/mp/config ──────────────────────────────────────────────
  // Guarda las credenciales y verifica que el token sea válido
  router.post('/config', requireOwner, asyncHandler(async (req, res) => {
    const { access_token, store_id, pos_external_id } = req.body;

    if (!access_token || !String(access_token).startsWith('APP_USR-')) {
      return res.status(400).json({
        error: 'El Access Token debe comenzar con APP_USR-',
        code: 'INVALID_TOKEN_FORMAT',
      });
    }
    if (!store_id) {
      return res.status(400).json({ error: 'store_id es requerido', code: 'MISSING_STORE_ID' });
    }
    if (!pos_external_id) {
      return res.status(400).json({ error: 'pos_external_id es requerido', code: 'MISSING_POS_ID' });
    }

    // Verificar token consultando /users/me
    let mpUser;
    try {
      mpUser = await mpFetch('/v1/users/me', access_token);
    } catch (err) {
      logger.warn('[MP] Token inválido:', err.message);
      return res.status(401).json({
        error: 'Token inválido o sin permisos. Verificá las credenciales en Mercado Pago.',
        code: 'INVALID_TOKEN',
        detail: err.message,
      });
    }

    // Guardar en BD
    setConfig('access_token',   String(access_token).trim());
    setConfig('store_id',       String(store_id).trim());
    setConfig('pos_external_id', String(pos_external_id).trim());

    logger.info(`[MP] Credenciales guardadas para cuenta MP: ${mpUser.email || mpUser.id}`);

    res.json({
      success: true,
      mp_user: {
        id:        mpUser.id,
        email:     mpUser.email,
        nickname:  mpUser.nickname,
        site_id:   mpUser.site_id,
      },
    });
  }));

  // ── POST /api/mp/qr ─────────────────────────────────────────────────
  // Crea una orden QR dinámica en Mercado Pago y devuelve la URL del QR
  // Body: { tableId, orderId, total, items: [{title, quantity, unit_price}], description }
  router.post('/qr', requireSession, asyncHandler(async (req, res) => {
    const cfg = getConfig();
    if (!cfg.access_token) {
      return res.status(503).json({
        error: 'Mercado Pago no está configurado. Ingresá las credenciales en Configuración → Integraciones.',
        code: 'MP_NOT_CONFIGURED',
      });
    }

    const { tableId, orderId, total, items, description } = req.body;

    if (!total || total <= 0) {
      return res.status(400).json({ error: 'total inválido', code: 'INVALID_TOTAL' });
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items requeridos', code: 'MISSING_ITEMS' });
    }

    // Armar el body para la API de QR Dinámico de MP
    // Docs: https://www.mercadopago.com.ar/developers/es/docs/qr-code/integration-configuration/qr-dynamic/integration
    const externalReference = `LMM-${orderId || tableId}-${Date.now()}`;

    const mpOrderBody = {
      external_reference: externalReference,
      title:       description || `Mesa ${tableId} — LMM POS`,
      description: description || `Pedido mesa ${tableId}`,
      notification_url: null,  // Se puede configurar para webhooks
      items: items.map(it => ({
        title:       String(it.title || it.name).slice(0, 256),
        description: String(it.title || it.name).slice(0, 256),
        quantity:    Number(it.quantity || it.qty || 1),
        unit_price:  Math.round(Number(it.unit_price || it.price) * 100) / 100,
        unit_measure: 'unit',
        total_amount: Math.round(Number(it.unit_price || it.price) * Number(it.quantity || it.qty || 1) * 100) / 100,
        currency_id: 'ARS',
      })),
      total_amount: Math.round(Number(total) * 100) / 100,
      cash_out: { amount: 0 },
    };

    let mpResponse;
    try {
      mpResponse = await mpFetch(
        `/instore/orders/qr/seller/collectors/${encodeURIComponent(cfg.store_id)}/pos/${encodeURIComponent(cfg.pos_external_id)}/qrs`,
        cfg.access_token,
        {
          method: 'PUT',
          body: JSON.stringify(mpOrderBody),
          idempotencyKey: externalReference,
        }
      );
    } catch (err) {
      logger.error('[MP] Error creando QR:', err.message, err.mpData);
      return res.status(502).json({
        error: `Error al crear QR en Mercado Pago: ${err.message}`,
        code: 'MP_API_ERROR',
        detail: err.mpData,
      });
    }

    logger.info(`[MP] QR creado para mesa ${tableId}, referencia: ${externalReference}`);

    res.json({
      success:            true,
      qr_data:            mpResponse.qr_data,            // string para generar QR
      in_store_order_id:  mpResponse.in_store_order_id,  // ID de la orden en MP
      external_reference: externalReference,
    });
  }));

  // ── GET /api/mp/qr/:externalReference ───────────────────────────────
  // Consulta el estado de una orden QR creada (polling desde el frontend)
  router.get('/qr/:externalRef', requireSession, asyncHandler(async (req, res) => {
    const cfg = getConfig();
    if (!cfg.access_token) {
      return res.status(503).json({ error: 'MP no configurado', code: 'MP_NOT_CONFIGURED' });
    }

    const externalRef = req.params.externalRef;

    let mpResponse;
    try {
      // Buscar por external_reference
      mpResponse = await mpFetch(
        `/v1/payments/search?external_reference=${encodeURIComponent(externalRef)}&status=approved`,
        cfg.access_token
      );
    } catch (err) {
      return res.status(502).json({
        error: `Error consultando MP: ${err.message}`,
        code: 'MP_API_ERROR',
      });
    }

    const results = mpResponse?.results || [];
    const paid    = results.length > 0 && results[0].status === 'approved';

    res.json({
      paid,
      payment: paid ? {
        id:             results[0].id,
        status:         results[0].status,
        payment_method: results[0].payment_method_id,
        amount:         results[0].transaction_amount,
        date:           results[0].date_approved,
      } : null,
    });
  }));

  // ── DELETE /api/mp/qr ────────────────────────────────────────────────
  // Elimina/cancela la orden QR activa de la caja (para resetear)
  router.delete('/qr', requireSession, asyncHandler(async (req, res) => {
    const cfg = getConfig();
    if (!cfg.access_token) {
      return res.status(503).json({ error: 'MP no configurado', code: 'MP_NOT_CONFIGURED' });
    }

    try {
      await mpFetch(
        `/instore/orders/qr/seller/collectors/${encodeURIComponent(cfg.store_id)}/pos/${encodeURIComponent(cfg.pos_external_id)}/qrs`,
        cfg.access_token,
        { method: 'DELETE' }
      );
    } catch (err) {
      // Si no hay QR activo MP devuelve 404 — no es error crítico
      if (err.status !== 404) {
        logger.warn('[MP] Error eliminando QR:', err.message);
      }
    }

    res.json({ success: true });
  }));

  return router;
};