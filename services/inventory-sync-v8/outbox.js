'use strict';
/**
 * Outbox local de operaciones de inventario/pedido (V8 §14).
 * Las funciones que NO abren transacción pueden llamarse dentro de la transacción de venta
 * (para que venta + movimientos provisionales + outbox sean atómicos). El motor abre las suyas.
 */
const crypto = require('crypto');
const { canonicalJson, intentHash } = require('./canonical');

const LEASE_MS = 120000;
const HTTP_TIMEOUT_MS = 30000;
const MAX_SERVER_FAILURES = 10;
const BACKOFF_BASE_MS = 5000;
const BACKOFF_CAP_MS = 300000;

const OP_KINDS = ['sale', 'modify', 'return', 'cancel', 'reopen', 'adjust_in', 'adjust_out', 'catalog_upsert'];

function partitionFor(entityType, entityUuid) {
  return entityType === 'order' ? `order:${entityUuid}` : `inv:${entityUuid}`;
}

/**
 * Encola una operación. NUNCA reemplaza ni borra operaciones existentes.
 * purposeSeq (opcional): ordinal LÓGICO que forma la idempotency_key (p. ej. 0 para la venta de un pedido,
 * expected_version para modify/cancel/reopen). Dos encolados del mismo propósito colapsan en la misma fila.
 * Si no se da, se usa entity_seq (ordinal local), que siempre es nuevo. La clave incluye device_id (V8.1, A-01):
 * el ordinal es local, así que sin el dispositivo dos equipos podrían generar la misma clave para operaciones distintas.
 * NO abre transacción.
 */
function enqueue(db, o) {
  const { opKind, entityType, entityUuid, intent, deviceId, restaurantId } = o;
  if (!OP_KINDS.includes(opKind)) throw new Error(`op_kind inválido: ${opKind}`);
  const now = o.now ?? Date.now();
  const entitySeq = db.prepare(
    `SELECT COALESCE(MAX(entity_seq),0)+1 AS n FROM inventory_outbox WHERE entity_type=? AND entity_uuid=?`
  ).get(entityType, entityUuid).n;
  const key = `${opKind}:${entityUuid}:${deviceId}:${o.purposeSeq ?? entitySeq}`;   // incluye el dispositivo: dos equipos nunca colisionan

  const dup = db.prepare(`SELECT outbox_id, operation_id FROM inventory_outbox WHERE idempotency_key=?`).get(key);
  if (dup) return { outboxId: dup.outbox_id, operationId: dup.operation_id, deduplicated: true };

  const operationId = o.operationId || crypto.randomUUID();
  const fullIntent = { kind: opKind, entity_type: entityType, entity_uuid: entityUuid, ...intent };
  const envelope = {
    schema_version: 1,
    operation_id: operationId,
    idempotency_key: key,
    device_id: deviceId,
    client_created_at: new Date(now).toISOString(),
    intent: fullIntent,
  };
  if (o.clientActor) envelope.client_actor = String(o.clientActor).slice(0, 120);

  const r = db.prepare(
    `INSERT INTO inventory_outbox
       (operation_id, idempotency_key, op_kind, entity_type, entity_uuid, entity_seq, partition_key,
        depends_on_operation_id, request_payload, request_hash, status, created_at, device_id, restaurant_id)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'pending', ?,?,?)`
  ).run(operationId, key, opKind, entityType, entityUuid, entitySeq, partitionFor(entityType, entityUuid),
        o.dependsOn || null, canonicalJson(envelope), intentHash(fullIntent), now, deviceId, restaurantId);
  return { outboxId: Number(r.lastInsertRowid), operationId, deduplicated: false };
}

const CLAIM_SQL = `
UPDATE inventory_outbox
   SET status='claimed', lease_owner=:owner, lease_expires_at=:now+:lease_ms, claimed_at=:now, attempts=attempts+1
 WHERE outbox_id = (
   SELECT o.outbox_id FROM inventory_outbox o
    WHERE ( (o.status IN ('pending','retry_wait') AND COALESCE(o.next_attempt_at,0) <= :now)
         OR (o.status = 'claimed' AND o.lease_expires_at <= :now) )
      AND NOT EXISTS (SELECT 1 FROM inventory_outbox p
                       WHERE p.partition_key = o.partition_key AND p.outbox_id < o.outbox_id
                         AND p.status IN ('pending','claimed','retry_wait','dead_letter','conflict'))
      AND (o.depends_on_operation_id IS NULL OR EXISTS (SELECT 1 FROM inventory_outbox d
                       WHERE d.operation_id = o.depends_on_operation_id AND d.status = 'applied'))
    ORDER BY o.outbox_id LIMIT 1)
RETURNING outbox_id, operation_id, request_payload, attempts, entity_type, entity_uuid, op_kind`;

/** Reclamo atómico (una sola sentencia). Devuelve la fila o undefined. */
function claim(db, owner, now = Date.now(), leaseMs = LEASE_MS) {
  return db.prepare(CLAIM_SQL).get({ owner, now, lease_ms: leaseMs });
}

/** Opcional al arrancar: libera reclamos de un arranque anterior del mismo dispositivo. */
function recoverOnBoot(db, deviceId, bootId) {
  return db.prepare(
    `UPDATE inventory_outbox SET status='pending', lease_owner=NULL, lease_expires_at=NULL
      WHERE status='claimed' AND lease_owner NOT LIKE ?`
  ).run(`${deviceId}:${bootId}%`).changes;
}

function backoffMs(serverFailures, rnd = Math.random) {
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, serverFailures - 1));
  return Math.round(base * (0.8 + rnd() * 0.4));
}

const OPEN = `('claimed','pending','retry_wait')`;

function markApplied(db, outboxId, responsePayload, now = Date.now(), note = null) {
  return db.prepare(
    `UPDATE inventory_outbox SET status='applied', response_payload=?, applied_at=?, lease_owner=NULL,
            lease_expires_at=NULL, resolution_note=COALESCE(?, resolution_note)
      WHERE outbox_id=? AND status IN ${OPEN}`
  ).run(typeof responsePayload === 'string' ? responsePayload : JSON.stringify(responsePayload), now, note, outboxId).changes;
}

function markConflict(db, outboxId, code, details, responsePayload = null) {
  return db.prepare(
    `UPDATE inventory_outbox SET status='conflict', last_error_code=?, last_error=?, response_payload=?,
            lease_owner=NULL, lease_expires_at=NULL
      WHERE outbox_id=? AND status IN ${OPEN}`
  ).run(code, details ? JSON.stringify(details) : null,
        responsePayload ? JSON.stringify(responsePayload) : null, outboxId).changes;
}

function markDeadLetter(db, outboxId, code, message, httpStatus = null) {
  return db.prepare(
    `UPDATE inventory_outbox SET status='dead_letter', last_error_code=?, last_error=?, http_status=?,
            lease_owner=NULL, lease_expires_at=NULL
      WHERE outbox_id=? AND status IN ${OPEN}`
  ).run(code, message ? String(message).slice(0, 500) : null, httpStatus, outboxId).changes;
}

/**
 * Falla transitoria. countFailure=false para "sin red" (estar offline no agota los intentos).
 * Devuelve el estado resultante ('retry_wait' o 'dead_letter').
 */
function markRetry(db, outboxId, { now = Date.now(), code = null, message = null, httpStatus = null, countFailure = true, rnd } = {}) {
  const row = db.prepare(`SELECT server_failures FROM inventory_outbox WHERE outbox_id=?`).get(outboxId);
  if (!row) return null;
  const failures = row.server_failures + (countFailure ? 1 : 0);
  if (countFailure && failures >= MAX_SERVER_FAILURES) {
    markDeadLetter(db, outboxId, 'too_many_failures', message || code, httpStatus);
    return 'dead_letter';
  }
  const delay = backoffMs(Math.max(1, failures), rnd);
  db.prepare(
    `UPDATE inventory_outbox SET status='retry_wait', server_failures=?, next_attempt_at=?, last_error_code=?,
            last_error=?, http_status=?, lease_owner=NULL, lease_expires_at=NULL
      WHERE outbox_id=? AND status IN ${OPEN}`
  ).run(failures, now + delay, code, message ? String(message).slice(0, 500) : null, httpStatus, outboxId);
  return 'retry_wait';
}

/** Clasifica un fallo de la llamada RPC (V8 §14.4). Entrada: { status, code, message, network } */
function classifyFailure(f = {}) {
  const code = f.code || '';
  const st = f.status || 0;
  if (f.network || (!st && !code)) return { action: 'retry_network', code: 'network' };
  if (st === 401 || code === 'PT401') return { action: 'auth_refresh', code: 'unauthenticated' };
  if (st === 403 || code === 'PT403') return { action: 'dead_letter', code: 'device_revoked_or_unbound' };
  if (st === 409 || code === 'PT409') return { action: 'dead_letter', code: 'conflict_tampering_or_bug' };
  if (st === 422 || code === 'PT422') return { action: 'dead_letter', code: 'invalid_intent' };
  return { action: 'retry_server', code: code || `http_${st}` };
}

/** Pendientes (cualquier estado no terminal) — útil para la UI. */
function pendingCount(db) {
  return db.prepare(`SELECT COUNT(*) AS c FROM inventory_outbox WHERE status IN ('pending','claimed','retry_wait')`).get().c;
}

module.exports = {
  LEASE_MS, HTTP_TIMEOUT_MS, MAX_SERVER_FAILURES, OP_KINDS,
  enqueue, claim, recoverOnBoot, backoffMs, markApplied, markConflict, markDeadLetter, markRetry,
  classifyFailure, pendingCount, partitionFor,
};
