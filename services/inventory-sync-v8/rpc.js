'use strict';
/**
 * Cliente RPC para el motor de sincronización V8.
 *
 * Envuelve las funciones remotas de Supabase definidas en
 * supabase/migrations/20261123000000_lmm_inventory_sync_v8.sql:
 *   - lmm_apply_operation(p_request jsonb)        -> aplica una operación de inventario/pedido
 *   - lmm_get_events(p_device_id, p_from_seq, p_limit, p_ack_seq) -> trae eventos por cursor
 *   - lmm_get_snapshot(p_device_id)               -> snapshot de saldos y pedidos abiertos
 *   - lmm_issue_authorization(p_request jsonb)    -> emite vale/autorización (online u offline)
 *   - lmm_enroll_device(p_code, p_device_id)      -> vincula dispositivo al restaurante
 *   - lmm_revoke_device(p_restaurant, p_device_id)-> revoca un dispositivo
 *
 * Todas las funciones devuelven { data } o { error: { status, code, message, network } }.
 * Nunca lanza: un fallo de red o de Supabase se normaliza a error.network / error.status.
 * Si no hay cliente Supabase (no configurado), todas las llamadas devuelven error de red
 * y el motor se queda en modo offline sin romper la venta local.
 */
const { createClient } = require('@supabase/supabase-js');
const logger = require('../../logger');

function normalizeError(err) {
  if (!err) return null;
  // Ya normalizado por el motor/outbox.
  if (err.network === true || err.isNetworkError || err.code === 'ECONNREFUSED') {
    return { network: true, message: err.message || 'error de red' };
  }
  const status = err.status || err.statusCode || 0;
  let code = err.code;
  if (!code) {
    if (status === 401) code = 'PT401';
    else if (status === 403) code = 'PT403';
    else if (status === 409) code = 'PT409';
    else if (status === 422) code = 'PT422';
    else code = `http_${status}`;
  }
  const message = err.message || err.error_description || err.error || String(err);
  return { status, code, message, network: status === 0 };
}

function createRpc({
  supabase,
  supabaseUrl,
  supabaseAnonKey,
  deviceId,
  restaurantId,
  log = logger,
} = {}) {
  let sb = supabase || null;
  let resolved = false;

  function ensureClient() {
    if (sb) return sb;
    if (resolved) return null; // ya se intentó y no hay credenciales
    resolved = true;
    const url = supabaseUrl || process.env.SUPABASE_URL;
    const key = supabaseAnonKey || process.env.SUPABASE_ANON_KEY;
    if (!url || !key) {
      log.warn && log.warn('[INV-V8][RPC] Supabase no configurado: modo offline (sin credenciales)');
      return null;
    }
    try {
      sb = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { params: { eventsPerSecond: 10 } },
      });
    } catch (e) {
      log.warn && log.warn('[INV-V8][RPC] No se pudo crear el cliente Supabase:', e.message);
      return null;
    }
    return sb;
  }

  function client() {
    const c = ensureClient();
    if (!c) throw new Error('supabase_no_configurado');
    return c;
  }

  async function applyOperation(envelope) {
    try {
      const c = client();
      const { data, error } = await c.rpc('lmm_apply_operation', { p_request: envelope });
      if (error) return { error: normalizeError(error) };
      return { data: data || null };
    } catch (err) {
      return { error: normalizeError(err) };
    }
  }

  async function getEvents({ fromSeq, limit = 200, ackSeq } = {}) {
    try {
      const c = client();
      const { data, error } = await c.rpc('lmm_get_events', {
        p_device_id: deviceId,
        p_from_seq: Number(fromSeq || 0),
        p_limit: Number(limit || 200),
        p_ack_seq: ackSeq != null ? Number(ackSeq) : null,
      });
      if (error) return { error: normalizeError(error) };
      return { data: data || null };
    } catch (err) {
      return { error: normalizeError(err) };
    }
  }

  async function getSnapshot() {
    try {
      const c = client();
      const { data, error } = await c.rpc('lmm_get_snapshot', { p_device_id: deviceId });
      if (error) return { error: normalizeError(error) };
      return { data: data || null };
    } catch (err) {
      return { error: normalizeError(err) };
    }
  }

  async function refreshSession() {
    // No hay sesión persistente; la clave anónima es suficiente. No-op exitoso.
    return { ok: true };
  }

  // ── Autorizaciones / vales (V8 §13, política de vales offline) ──
  async function issueAuthorization(request) {
    try {
      const c = client();
      const { data, error } = await c.rpc('lmm_issue_authorization', { p_request: request });
      if (error) return { error: normalizeError(error) };
      return { data: data || null };
    } catch (err) {
      return { error: normalizeError(err) };
    }
  }

  async function enrollDevice(code) {
    try {
      const c = client();
      const { data, error } = await c.rpc('lmm_enroll_device', { p_code: code, p_device_id: deviceId });
      if (error) return { error: normalizeError(error) };
      return { data: data || null };
    } catch (err) {
      return { error: normalizeError(err) };
    }
  }

  async function revokeDevice(restaurant_id) {
    try {
      const c = client();
      const { data, error } = await c.rpc('lmm_revoke_device', { p_restaurant: restaurant_id, p_device_id: deviceId });
      if (error) return { error: normalizeError(error) };
      return { data: data || null };
    } catch (err) {
      return { error: normalizeError(err) };
    }
  }

  function isConfigured() {
    try {
      return !!ensureClient();
    } catch (e) {
      return false;
    }
  }

  return {
    applyOperation,
    getEvents,
    getSnapshot,
    refreshSession,
    issueAuthorization,
    enrollDevice,
    revokeDevice,
    isConfigured,
    normalizeError,
  };
}

module.exports = { createRpc, normalizeError };
