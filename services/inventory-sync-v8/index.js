'use strict';
const decimal = require('./decimal');
const canonical = require('./canonical');
const { computeSaleEffect } = require('./effect');
const { applySchema } = require('./schema');
const outbox = require('./outbox');
const reconcile = require('./reconcile');
const { createEngine } = require('./engine');
const hook = require('./hook');
const { createRpc } = require('./rpc');
const vouchers = require('./vouchers');
const activation = require('./activation');
const migration = require('./migration');

/**
 * Interruptor general. Por defecto APAGADO. Usa la MISMA condición que db.js,
 * sync-engine.js y las rutas: flag + nube vinculada + credenciales completas.
 */
function activationState(db) {
  if (db) return activation.state(db);
  try {
    const dbApi = require('../../db');
    const activeDb = typeof dbApi.getDb === 'function' ? dbApi.getDb() : dbApi.getDbForTesting();
    return activation.state(activeDb);
  } catch (_) {
    return activation.evaluate(null);
  }
}
function isEnabled(db) { return activationState(db).enabled; }

module.exports = { isEnabled, activationState, activation, migration, decimal, canonical, computeSaleEffect, applySchema, outbox, reconcile, createEngine, hook, createRpc, vouchers };
