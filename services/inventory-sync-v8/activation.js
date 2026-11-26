'use strict';
/**
 * ÚNICA condición de activación de la sincronización V8.
 *
 * V8 exige las TRES cosas a la vez:
 *   1) LMM_INVENTORY_SYNC_V8 === '1'  (opt-in explícito; apagado por defecto)
 *   2) config.cloud_restaurant_id     (nube vinculada)
 *   3) config.supabase_url + config.supabase_anon_key (configuración completa)
 *
 * Cualquier configuración incompleta deja el motor apagado y devuelve las
 * razones, para que los logs y las pruebas digan exactamente por qué.
 * Este módulo no depende de db.js (evita ciclos) y es usado por db.js,
 * sync-engine.js, el índice del servicio y las rutas que inician el motor.
 */

const FLAG = 'LMM_INVENTORY_SYNC_V8';

function evaluate(config, env = process.env) {
  const reasons = [];
  if (!env || env[FLAG] !== '1') reasons.push('flag_off');
  if (!config || !config.cloud_restaurant_id) reasons.push('missing_cloud_restaurant_id');
  if (!config || !config.supabase_url) reasons.push('missing_supabase_url');
  if (!config || !config.supabase_anon_key) reasons.push('missing_supabase_anon_key');
  return { enabled: reasons.length === 0, reasons };
}

function readConfig(db) {
  try {
    return db.prepare(
      'SELECT cloud_restaurant_id, supabase_url, supabase_anon_key FROM config WHERE id = 1'
    ).get() || null;
  } catch (_) {
    return null;
  }
}

/** Estado de activación leyendo la configuración real de una BD inyectada. */
function state(db, env = process.env) {
  return evaluate(readConfig(db), env);
}

function isEnabled(db, env = process.env) {
  return state(db, env).enabled;
}

module.exports = { FLAG, evaluate, readConfig, state, isEnabled };
