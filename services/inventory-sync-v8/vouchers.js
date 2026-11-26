'use strict';
/**
 * Política de vales offline (V8 §DEC-02 / A-03).
 *
 * Reglas:
 *   - Alcance: SOLO 'negative_stock' y 'adjustment'.
 *   - Hasta 5 vales offline vigentes por dispositivo.
 *   - Vigencia máxima del vale offline: 12 h (720 min).
 *   - Gracia de 48 h SOLO si offline_grace = true (vales pre-emitidos para
 *     uso sin conexión). Las autorizaciones online vencen en valid_until.
 *   - Vinculadas al device_id que las solicitó; revocables.
 *
 * Este módulo es complemento del servidor: la política definitiva la aplica
 * lmm_issue_authorization / lmm.check_authorization en PostgreSQL. Aquí se
 * valida antes de emitir y antes de adjuntar un vale a una operación local.
 */

const POLICY = Object.freeze({
  maxPerDevice: 5,
  offlineTtlMs: 12 * 60 * 60 * 1000,
  graceMs: 48 * 60 * 60 * 1000,
  scopes: Object.freeze(['negative_stock', 'adjustment']),
});

function nowMs(now) {
  return Number.isFinite(now) ? now : Date.now();
}

/** Normaliza y valida una solicitud de emisión antes de llamar al RPC. */
function validateRequest(request = {}, now) {
  const scope = request.scope;
  if (!POLICY.scopes.includes(scope)) return { ok: false, reason: 'invalid_scope' };
  if (!request.device_id) return { ok: false, reason: 'missing_device' };
  if (!request.approver_membership_id || !request.pin) return { ok: false, reason: 'missing_approver' };

  const offline = request.offline_voucher === true;
  const requestedTtl = Number(request.ttl_minutes ?? 10);
  // Un TTL absurdo se rechaza; un TTL largo se LIMITA a la política (12 h
  // offline / 60 min online) en vez de fallar, para no bloquear al operador.
  if (!Number.isFinite(requestedTtl) || requestedTtl < 1 || requestedTtl > 10080) {
    return { ok: false, reason: 'invalid_ttl' };
  }
  const ttlMinutes = Math.min(requestedTtl, offline ? POLICY.offlineTtlMs / 60000 : 60);
  if (scope === 'adjustment' && !request.inventory_uuid) return { ok: false, reason: 'missing_inventory' };
  if (scope === 'negative_stock' && request.max_quantity != null) return { ok: false, reason: 'invalid_quantity' };

  return {
    ok: true,
    request: {
      ...request,
      scope,
      ttl_minutes: ttlMinutes,
      offline_voucher: offline,
      valid_until: nowMs(now) + ttlMinutes * 60000,
    },
  };
}

/** Cuenta los vales offline vigentes de un dispositivo en la base local. */
function countActiveOffline(db, deviceId, now) {
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM local_authorizations
      WHERE issued_to_device_id = ? AND offline_grace = 1 AND revoked = 0
        AND status IN ('available','attached') AND valid_until > ?`
  ).get(deviceId, nowMs(now));
  return Number(row && row.c) || 0;
}

/** Guarda el vale devuelto por el RPC, ligado al dispositivo y con su gracia. */
function saveIssued(db, voucher, request, deviceId) {
  if (!voucher || !voucher.authorization_id) return { ok: false, reason: 'missing_authorization_id' };
  const validUntil = Date.parse(voucher.valid_until) || Number(voucher.valid_until) || nowMs(request.valid_until);
  db.prepare(
    `INSERT OR REPLACE INTO local_authorizations
       (authorization_id, scope, order_uuid, inventory_uuid, max_milli, valid_until, status,
        issued_to_device_id, offline_grace, revoked)
     VALUES (?, ?, ?, ?, NULL, ?, 'available', ?, ?, 0)`
  ).run(
    voucher.authorization_id,
    request.scope,
    request.order_uuid || null,
    request.inventory_uuid || null,
    validUntil,
    deviceId || request.device_id,
    request.offline_voucher ? 1 : 0
  );
  return { ok: true, authorization_id: voucher.authorization_id };
}

/**
 * Verifica que un vale pueda adjuntarse a una operación local.
 * Devuelve { ok, reason } y NUNCA lanza.
 */
function validateForOperation(db, { authorizationId, deviceId, scope, orderUuid, inventoryUuid, now }) {
  if (!authorizationId) return { ok: false, reason: 'missing_authorization' };
  let v;
  try {
    v = db.prepare(`SELECT * FROM local_authorizations WHERE authorization_id = ?`).get(authorizationId);
  } catch (e) {
    return { ok: false, reason: 'store_error', error: e.message };
  }
  if (!v) return { ok: false, reason: 'not_found' };
  if (v.revoked || v.status === 'expired' || v.status === 'used') return { ok: false, reason: 'revoked_or_used' };
  if (v.issued_to_device_id && deviceId && v.issued_to_device_id !== deviceId) return { ok: false, reason: 'wrong_device' };
  if (scope && v.scope !== scope) return { ok: false, reason: 'wrong_scope' };
  if (v.scope === 'adjustment' && inventoryUuid && v.inventory_uuid && v.inventory_uuid !== inventoryUuid) {
    return { ok: false, reason: 'wrong_inventory' };
  }
  if (v.order_uuid && orderUuid && v.order_uuid !== orderUuid) return { ok: false, reason: 'wrong_order' };

  const t = nowMs(now);
  const offline = !!v.offline_grace;
  const limit = Number(v.valid_until) + (offline ? POLICY.graceMs : 0);
  if (t > limit) return { ok: false, reason: offline ? 'offline_grace_expired' : 'expired' };

  return { ok: true, voucher: v, expires_at: limit, offline };
}

function markAttached(db, authorizationId) {
  db.prepare(
    `UPDATE local_authorizations SET status = 'attached' WHERE authorization_id = ? AND status = 'available'`
  ).run(authorizationId);
}

function revokeLocal(db, authorizationId) {
  db.prepare(
    `UPDATE local_authorizations SET revoked = 1, status = 'expired' WHERE authorization_id = ?`
  ).run(authorizationId);
}

module.exports = {
  POLICY,
  validateRequest,
  countActiveOffline,
  saveIssued,
  validateForOperation,
  markAttached,
  revokeLocal,
};
