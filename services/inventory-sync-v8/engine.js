'use strict';
/**
 * Motor de sincronización V8 (cliente). Sin dependencias de Supabase: recibe un `rpc` inyectable
 *   rpc.applyOperation(envelope)            -> { data, error }
 *   rpc.getEvents({deviceId, fromSeq, limit, ackSeq}) -> { data, error }
 *   rpc.getSnapshot(deviceId)               -> { data, error }
 *   rpc.refreshSession?()                   -> Promise
 * error: { status, code, message, network }
 * Nunca mantiene una transacción SQLite abierta durante la llamada de red.
 */
const outbox = require('./outbox');
const rec = require('./reconcile');

function createEngine({ db, deviceId, restaurantId, rpc, bootId = String(process.pid || 'boot'), now = () => Date.now(), logger = console, leaseMs = outbox.LEASE_MS }) {
  const owner = `${deviceId}:${bootId}`;

  function inTx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
  }

  /** Reclama y envía UNA operación. Devuelve null si no hay nada que enviar. */
  async function sendOne() {
    const row = outbox.claim(db, owner, now(), leaseMs);
    if (!row) return null;
    const envelope = JSON.parse(row.request_payload);
    let resp;
    try {
      resp = await rpc.applyOperation(envelope);
    } catch (e) {
      resp = { error: { network: true, message: e && e.message } };
    }
    if (resp && resp.error) {
      const c = outbox.classifyFailure(resp.error);
      if (c.action === 'retry_network') outbox.markRetry(db, row.outbox_id, { now: now(), code: c.code, message: resp.error.message, countFailure: false });
      else if (c.action === 'auth_refresh') {
        try { if (rpc.refreshSession) await rpc.refreshSession(); } catch (_) { /* se reintenta */ }
        outbox.markRetry(db, row.outbox_id, { now: now(), code: c.code, message: resp.error.message, countFailure: false });
      } else if (c.action === 'dead_letter') outbox.markDeadLetter(db, row.outbox_id, c.code, resp.error.message, resp.error.status || null);
      else outbox.markRetry(db, row.outbox_id, { now: now(), code: c.code, message: resp.error.message, httpStatus: resp.error.status || null, countFailure: true });
      return { outboxId: row.outbox_id, outcome: c.action };
    }
    try {
      inTx(() => rec.applyAuthoritativeResultTx(db, resp.data, {
        source: 'response', originDeviceId: deviceId, deviceId, now: now(),
        ownOperationId: row.operation_id, entityUuid: row.entity_uuid,
      }));
    } catch (e) {                                          // p. ej. producto local desconocido: no se pierde el resultado, se reintenta
      outbox.markRetry(db, row.outbox_id, { now: now(), code: 'apply_error', message: e.message, countFailure: true });
      logger.warn && logger.warn('[INV-V8] no se pudo aplicar el resultado:', e.message);
      return { outboxId: row.outbox_id, outcome: 'apply_error' };
    }
    return { outboxId: row.outbox_id, outcome: resp.data.operation_status === 'rejected' ? 'conflict' : 'applied' };
  }

  /** Envía todo lo que esté listo (respeta partición, dependencias y backoff). */
  async function drain(max = 200) {
    const results = [];
    for (let i = 0; i < max; i++) {
      const r = await sendOne();
      if (!r) break;
      results.push(r);
    }
    return results;
  }

  /** Consulta eventos por cursor y los aplica en orden estricto. */
  async function pollEvents({ limit = 200, maxPages = 20 } = {}) {
    let applied = 0;
    for (let page = 0; page < maxPages; page++) {
      const cursor = rec.getCursor(db, restaurantId);
      let resp;
      try { resp = await rpc.getEvents({ deviceId, fromSeq: cursor, limit, ackSeq: cursor }); }
      catch (e) { return { applied, status: 'network' }; }
      if (resp.error) return { applied, status: 'error', error: resp.error };
      const d = resp.data;
      if (d.status === 'resync_required') {
        const snap = await rpc.getSnapshot(deviceId);
        if (snap.error) return { applied, status: 'error', error: snap.error };
        rec.applySnapshot(db, restaurantId, snap.data, now());
        continue;
      }
      for (const ev of d.events) {
        const r = rec.processEvent(db, restaurantId, ev, { deviceId, now: now() });
        if (r === 'applied') applied++;
        else if (r === 'gap') return { applied, status: 'gap', expected: cursor + 1, got: ev.event_seq };
      }
      if (!d.has_more) return { applied, status: 'ok' };
    }
    return { applied, status: 'ok' };
  }

  async function runCycle() {
    const sent = await drain();
    const polled = await pollEvents();
    return { sent, polled };
  }

  return { sendOne, drain, pollEvents, runCycle, owner };
}

module.exports = { createEngine };
