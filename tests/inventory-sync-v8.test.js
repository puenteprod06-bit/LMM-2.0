/**
 * Pruebas del módulo services/inventory-sync-v8 (V8): decimales, JSON canónico, regla de venta,
 * outbox, conciliación offline y motor contra un servidor simulado en memoria.
 * Usa better-sqlite3 si está disponible (entorno de la app) y, si no, el SQLite embebido de Node.
 */
'use strict';
const v8 = require('../services/inventory-sync-v8');
const { toMilli, fromMilli } = v8.decimal;

function openDb() {
  let db;
  try { const Database = require('better-sqlite3'); db = new Database(':memory:'); }
  catch (_) { const { DatabaseSync } = require('node:sqlite'); db = new DatabaseSync(':memory:'); }
  db.exec(`
    CREATE TABLE config (id INTEGER PRIMARY KEY, cloud_restaurant_id TEXT);
    INSERT INTO config(id, cloud_restaurant_id) VALUES (1, 'rest-1');
    CREATE TABLE inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE, name TEXT NOT NULL, stock REAL DEFAULT 0, deleted INTEGER DEFAULT 0);
    CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE, status TEXT);
    CREATE TABLE order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT, order_id INTEGER, name TEXT, price REAL, qty REAL, note TEXT, itemType TEXT, invId INTEGER);
    CREATE TABLE stock_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT, inventory_id INTEGER NOT NULL, product_name TEXT NOT NULL, movement_type TEXT NOT NULL,
      quantity REAL NOT NULL, stock_before REAL NOT NULL, stock_after REAL NOT NULL, shortage_quantity REAL DEFAULT 0,
      reference_type TEXT, reference_id INTEGER, authorized_by TEXT, user_name TEXT, user_role TEXT, created_at INTEGER NOT NULL,
      uuid TEXT, updated_at INTEGER, device_id TEXT, deleted INTEGER DEFAULT 0);
    CREATE UNIQUE INDEX idx_stock_movements_uuid ON stock_movements(uuid);
  `);
  v8.applySchema(db);
  return db;
}
const addProduct = (db, uuid, name, stock) =>
  db.prepare('INSERT INTO inventory(uuid,name,stock,stock_confirmed_milli,confirmed_version) VALUES (?,?,?,?,?)')
    .run(uuid, name, stock, Math.round(stock * 1000), 1);

// ───────────────────────── Servidor simulado (reglas V8 §9/§10, solo 'sale') ─────────────────────────
function fakeServer() {
  const s = { stock: {}, version: {}, ops: new Map(), events: [], seq: 0, calls: 0 };
  const setStock = (u, v) => { s.stock[u] = toMilli(String(v)); s.version[u] = 1; };
  async function applyOperation(env, deviceId) {
    s.calls++;
    const hash = v8.canonical.intentHash(env.intent);
    const ex = s.ops.get(env.operation_id);
    if (ex) {
      if (ex.hash !== hash) return { error: { status: 409, code: 'PT409', message: 'operation_id_reused_with_different_content' } };
      return { data: { ...ex.result, replayed: true } };
    }
    const movements = []; const invOut = {};
    for (const it of env.intent.items.filter((i) => i.item_type === 'inventory')) {
      const u = it.inventory_uuid; const q = toMilli(it.qty);
      const e = v8.computeSaleEffect(s.stock[u], q, false);
      const before = s.stock[u]; s.stock[u] = e.after; s.version[u]++;
      movements.push({ movement_id: it.item_uuid, line_id: it.item_uuid, kind: 'sale', inventory_uuid: u, requested_qty: fromMilli(q),
        applied_qty: fromMilli(e.applied), shortage_qty: fromMilli(e.shortage), stock_delta: fromMilli(e.delta), stock_before: fromMilli(before), stock_after: fromMilli(e.after) });
      if (e.shortage > 0) movements.push({ movement_id: 'sh-' + it.item_uuid, line_id: it.item_uuid, kind: 'shortage', inventory_uuid: u, requested_qty: fromMilli(q),
        applied_qty: '0', shortage_qty: fromMilli(e.shortage), stock_delta: '0', stock_before: fromMilli(e.after), stock_after: fromMilli(e.after) });
      invOut[u] = { inventory_uuid: u, stock: fromMilli(e.after), version: s.version[u] };
    }
    s.seq++;
    const result = { schema_version: 1, operation_id: env.operation_id, op_kind: 'sale', operation_status: 'applied', reject_code: null,
      event_seq: s.seq, order: { order_uuid: env.intent.entity_uuid, version: 1, status: 'open' }, movements, inventory: Object.values(invOut) };
    s.ops.set(env.operation_id, { hash, result });
    s.events.push({ event_id: 'ev-' + s.seq, event_seq: s.seq, event_type: 'operation.applied', entity_type: 'order', entity_uuid: env.intent.entity_uuid,
      operation_id: env.operation_id, device_id: deviceId, payload: result, payload_hash: 'x' });
    return { data: { ...result, replayed: false } };
  }
  const rpcFor = (deviceId, opts = {}) => ({
    applyOperation: async (env) => { if (opts.down) return { error: { network: true, message: 'offline' } }; const r = await applyOperation(env, deviceId); if (opts.loseResponse) { opts.loseResponse = false; return { error: { network: true, message: 'timeout' } }; } return r; },
    getEvents: async ({ fromSeq, limit }) => { const evs = s.events.filter((e) => e.event_seq > fromSeq).slice(0, limit); return { data: { status: 'ok', events: evs, has_more: false, last_event_seq: s.seq } }; },
    getSnapshot: async () => ({ data: { last_event_seq: s.seq, inventory: Object.keys(s.stock).map((u) => ({ inventory_uuid: u, stock: fromMilli(s.stock[u]), version: s.version[u] })) } }),
  });
  return { s, setStock, rpcFor };
}

function saleIntentItems(invUuid, qty, itemUuid) {
  return [{ item_uuid: itemUuid, item_type: 'inventory', inventory_uuid: invUuid, name: 'Coca', unit_price: '2500', qty, note: null }];
}
function localSale(db, deviceId, orderUuid, itemUuid, invUuid, qtyStr) {
  // lo que haría la venta local: movimiento provisional + stock caché + outbox, en una transacción
  const q = toMilli(qtyStr);
  db.exec('BEGIN IMMEDIATE');
  const v = v8.reconcile.stockView(db, invUuid);
  const e = v8.computeSaleEffect(v.provisionalMilli, q, false);
  const inv = db.prepare('SELECT id,name FROM inventory WHERE uuid=?').get(invUuid);
  const opq = v8.outbox.enqueue(db, { opKind: 'sale', entityType: 'order', entityUuid: orderUuid, purposeSeq: 0,
    intent: { expected_version: 0, snapshot: {}, items: saleIntentItems(invUuid, qtyStr, itemUuid), authorization_id: null },
    deviceId, restaurantId: 'rest-1' });
  const ins = (kind, applied, short, delta) => db.prepare(
    `INSERT INTO stock_movements(inventory_id,product_name,movement_type,quantity,stock_before,stock_after,created_at,uuid,inventory_uuid,operation_id,line_id,kind,
       requested_milli,applied_milli,shortage_milli,delta_milli,confirmation_state,origin)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'provisional','local')`)
    .run(inv.id, inv.name, kind, applied / 1000, v.provisionalMilli / 1000, e.after / 1000, Date.now(), 'loc-' + kind + opq.operationId, invUuid, opq.operationId, itemUuid, kind, q, applied, short, delta);
  ins('sale', e.applied, e.shortage, e.delta);
  if (e.shortage > 0) ins('shortage', 0, e.shortage, 0);
  v8.reconcile.refreshStockCacheTx(db, invUuid);
  db.exec('COMMIT');
  return opq;
}

// ───────────────────────────────────────── pruebas ─────────────────────────────────────────
describe('decimal y JSON canónico', () => {
  test('milésimas exactas y rechazo de formatos no canónicos', () => {
    expect(toMilli('1.25')).toBe(1250);
    expect(fromMilli(1250)).toBe('1.25');
    expect(fromMilli(-3000)).toBe('-3');
    expect(toMilli('0.1') + toMilli('0.2')).toBe(toMilli('0.3'));
    for (const bad of ['1.0', '01', '1.2345', '.5', '-1', '1e3', '']) expect(() => toMilli(bad)).toThrow();
  });
  test('canonicalJson: orden de claves, escapes y solo enteros', () => {
    expect(v8.canonical.canonicalJson({ b: '2.5', a: [{ z: null, y: true }] })).toBe('{"a":[{"y":true,"z":null}],"b":"2.5"}');
    expect(v8.canonical.canonicalJson({ a: 1, b: 2 })).toBe(v8.canonical.canonicalJson({ b: 2, a: 1 }));
    expect(() => v8.canonical.canonicalJson({ q: 1.5 })).toThrow();
    expect(v8.canonical.canonicalJson({ s: 'x"y\n\u0001ñ' })).toBe('{"s":"x\\"y\\n\\u0001ñ"}');
  });
});

describe('regla de venta (V8 §10.2)', () => {
  const rows = [[10, 3, false, 3, 0, 7], [5, 5, false, 5, 0, 0], [0, 2, false, 0, 2, 0], [-3, 2, false, 0, 2, -3], [-3, 2, true, 2, 2, -5],
    [5, 8, false, 5, 3, 0], [5, 8, true, 8, 3, -3], [1, 4, false, 1, 3, 0], [2.5, 1.25, false, 1.25, 0, 1.25], [0.3, 0.5, false, 0.3, 0.2, 0]];
  test.each(rows)('stock %p, pide %p, autorizada %p', (stock, qty, auth, applied, short, after) => {
    const r = v8.computeSaleEffect(Math.round(stock * 1000), Math.round(qty * 1000), auth);
    expect([r.applied, r.shortage, r.after]).toEqual([Math.round(applied * 1000), Math.round(short * 1000), Math.round(after * 1000)]);
  });
  test('stock -3 sin autorización NUNCA aumenta el saldo (defecto de V7)', () => {
    const r = v8.computeSaleEffect(-3000, 2000, false);
    expect(r.after).toBe(-3000);
    expect(r.delta).toBe(0);
  });
});

describe('outbox', () => {
  const mk = (db, kind, entity, uuid, extra = {}) => v8.outbox.enqueue(db, { opKind: kind, entityType: entity, entityUuid: uuid, intent: { expected_version: 0, items: [] }, deviceId: 'dev', restaurantId: 'r', ...extra });
  test('reclamo FIFO, bloqueo por partición, lease vencido en caliente', () => {
    const db = openDb(); const T = 1_000_000;
    mk(db, 'sale', 'order', 'o1', { now: T }); mk(db, 'modify', 'order', 'o1', { now: T + 1 }); mk(db, 'sale', 'order', 'o2', { now: T + 2 });
    expect(v8.outbox.claim(db, 'a', T + 10, 120000).entity_uuid).toBe('o1');
    expect(v8.outbox.claim(db, 'a', T + 11, 120000).entity_uuid).toBe('o2');        // salta la 2ª de o1
    expect(v8.outbox.claim(db, 'a', T + 12, 120000)).toBeUndefined();               // nada listo
    const again = v8.outbox.claim(db, 'b', T + 10 + 120001, 120000);                // lease vencido de o1
    expect(again.entity_uuid).toBe('o1');
    expect(again.attempts).toBe(2);
  });
  test('misma idempotency_key colapsa; intents distintos NO se pierden', () => {
    const db = openDb();
    const a = mk(db, 'sale', 'order', 'o1', { purposeSeq: 0 }); const b = mk(db, 'sale', 'order', 'o1', { purposeSeq: 0 });
    expect(b.deduplicated).toBe(true); expect(b.operationId).toBe(a.operationId);
    mk(db, 'modify', 'order', 'o1'); mk(db, 'modify', 'order', 'o1');
    expect(db.prepare('SELECT COUNT(*) c FROM inventory_outbox').get().c).toBe(3);
  });
  test('backoff exponencial con tope, dead_letter a los 10 fallos, offline no cuenta', () => {
    expect(v8.outbox.backoffMs(1, () => 0.5)).toBe(5000);
    expect(v8.outbox.backoffMs(4, () => 0.5)).toBe(40000);
    expect(v8.outbox.backoffMs(20, () => 0.5)).toBe(300000);
    const db = openDb(); const q = mk(db, 'sale', 'order', 'o1');
    for (let i = 0; i < 5; i++) v8.outbox.markRetry(db, q.outboxId, { countFailure: false });
    expect(db.prepare('SELECT server_failures f, status s FROM inventory_outbox').get()).toEqual({ f: 0, s: 'retry_wait' });
    let st; for (let i = 0; i < 10; i++) st = v8.outbox.markRetry(db, q.outboxId, { code: '503' });
    expect(st).toBe('dead_letter');
  });
  test('clasificación de errores', () => {
    const c = v8.outbox.classifyFailure;
    expect(c({ network: true }).action).toBe('retry_network');
    expect(c({ status: 401 }).action).toBe('auth_refresh');
    expect(c({ status: 403, code: 'PT403' }).code).toBe('device_revoked_or_unbound');
    expect(c({ status: 409 }).action).toBe('dead_letter');
    expect(c({ status: 422 }).action).toBe('dead_letter');
    expect(c({ status: 503 }).action).toBe('retry_server');
  });
  test('conflict bloquea la partición pero no otras', () => {
    const db = openDb(); const T = 5_000_000;
    const a = mk(db, 'sale', 'order', 'o1', { now: T }); mk(db, 'modify', 'order', 'o1', { now: T + 1 }); mk(db, 'sale', 'order', 'o2', { now: T + 2 });
    const c1 = v8.outbox.claim(db, 'x', T + 5); v8.outbox.markConflict(db, c1.outbox_id, 'order_version_conflict', {});
    expect(v8.outbox.claim(db, 'x', T + 6).entity_uuid).toBe('o2');
    expect(v8.outbox.claim(db, 'x', T + 7)).toBeUndefined();
    expect(a.outboxId).toBe(c1.outbox_id);
  });
});

describe('conciliación offline (caso del enunciado: stock 5, A y B venden 4 sin conexión)', () => {
  test('B recibe el resultado autoritativo sin duplicar, borrar ni perder el faltante', async () => {
    const srv = fakeServer(); srv.setStock('inv1', 5);
    const A = openDb(), B = openDb();
    addProduct(A, 'inv1', 'Coca', 5); addProduct(B, 'inv1', 'Coca', 5);
    const eA = v8.createEngine({ db: A, deviceId: 'devA', restaurantId: 'rest-1', rpc: srv.rpcFor('devA') });
    const eB = v8.createEngine({ db: B, deviceId: 'devB', restaurantId: 'rest-1', rpc: srv.rpcFor('devB') });

    localSale(A, 'devA', 'ordA', 'itemA', 'inv1', '4');            // ambos offline: cada uno ve provisional 1
    localSale(B, 'devB', 'ordB', 'itemB', 'inv1', '4');
    expect(v8.reconcile.stockView(A, 'inv1').provisionalMilli).toBe(1000);
    expect(v8.reconcile.stockView(B, 'inv1').provisionalMilli).toBe(1000);
    expect(v8.reconcile.stockView(B, 'inv1').isProvisional).toBe(true);

    await eA.runCycle();                                            // el servidor procesa A primero
    await eB.runCycle();                                            // luego B: solo queda 1 -> descuenta 1, faltante 3

    expect(srv.s.stock.inv1).toBe(0);
    const vb = v8.reconcile.stockView(B, 'inv1');
    expect(vb.confirmedMilli).toBe(0); expect(vb.provisionalMilli).toBe(0); expect(vb.isProvisional).toBe(false);
    const sale = B.prepare(`SELECT * FROM stock_movements WHERE operation_id IN (SELECT operation_id FROM inventory_outbox) AND kind='sale' AND origin='local'`).all();
    expect(sale.length).toBe(1);                                    // la venta de B se conserva, una sola vez
    expect(sale[0].applied_milli).toBe(1000); expect(sale[0].shortage_milli).toBe(3000); expect(sale[0].confirmation_state).toBe('confirmed');
    const sh = B.prepare(`SELECT shortage_milli s FROM stock_movements WHERE kind='shortage' AND origin='local'`).all();
    expect(sh.length).toBe(1); expect(sh[0].s).toBe(3000);          // el faltante no se pierde
    expect(B.prepare('SELECT status FROM inventory_outbox').get().status).toBe('applied');
    expect(B.prepare('SELECT COUNT(*) c FROM applied_results').get().c).toBe(2);   // B: su propio resultado + el evento ajeno de A
    expect(A.prepare('SELECT stock_confirmed_milli c FROM inventory').get().c).toBe(1000); // A aún no vio el evento de B (próximo ciclo)
    await eA.pollEvents();
    expect(v8.reconcile.stockView(A, 'inv1').confirmedMilli).toBe(0);
  });

  test('evento propio y respuesta no duplican (idempotencia local); evento viejo no retrocede el saldo', async () => {
    const srv = fakeServer(); srv.setStock('inv1', 5);
    const B = openDb(); addProduct(B, 'inv1', 'Coca', 5);
    const eB = v8.createEngine({ db: B, deviceId: 'devB', restaurantId: 'rest-1', rpc: srv.rpcFor('devB') });
    localSale(B, 'devB', 'ordB', 'itemB', 'inv1', '2');
    await eB.runCycle();                                            // respuesta + evento propio
    expect(B.prepare(`SELECT COUNT(*) c FROM stock_movements WHERE kind='sale'`).get().c).toBe(1);
    expect(v8.reconcile.stockView(B, 'inv1').confirmedMilli).toBe(3000);
    // un evento ajeno viejo (versión menor) no debe retroceder
    B.exec('BEGIN IMMEDIATE');
    v8.reconcile.applyAuthoritativeResultTx(B, { schema_version: 1, operation_id: 'old', operation_status: 'applied', movements: [], inventory: [{ inventory_uuid: 'inv1', stock: '9', version: 1 }] },
      { source: 'event', originDeviceId: 'devZ', deviceId: 'devB', now: Date.now() });
    B.exec('COMMIT');
    expect(v8.reconcile.stockView(B, 'inv1').confirmedMilli).toBe(3000);
  });

  test('cierre tras el commit remoto y antes del ACK local: el reenvío devuelve el resultado guardado y se aplica una vez', async () => {
    const srv = fakeServer(); srv.setStock('inv1', 5);
    const B = openDb(); addProduct(B, 'inv1', 'Coca', 5);
    const opts = { loseResponse: true };
    const eB = v8.createEngine({ db: B, deviceId: 'devB', restaurantId: 'rest-1', rpc: srv.rpcFor('devB', opts), leaseMs: 1000 });
    localSale(B, 'devB', 'ordB', 'itemB', 'inv1', '2');
    const r1 = await eB.sendOne();                                  // el servidor aplicó, la respuesta se perdió
    expect(r1.outcome).toBe('retry_network');
    expect(srv.s.stock.inv1).toBe(3000);
    B.exec(`UPDATE inventory_outbox SET next_attempt_at=0`);
    const r2 = await eB.sendOne();                                  // reenvío con el MISMO operation_id
    expect(r2.outcome).toBe('applied');
    expect(srv.s.stock.inv1).toBe(3000);                            // sin doble descuento
    expect(v8.reconcile.stockView(B, 'inv1').provisionalMilli).toBe(3000);
    expect(B.prepare(`SELECT COUNT(*) c FROM stock_movements WHERE kind='sale'`).get().c).toBe(1);
  });

  test('servidor caído: la venta sigue como pendiente y el saldo provisional es visible', async () => {
    const srv = fakeServer(); srv.setStock('inv1', 5);
    const B = openDb(); addProduct(B, 'inv1', 'Coca', 5);
    const eB = v8.createEngine({ db: B, deviceId: 'devB', restaurantId: 'rest-1', rpc: srv.rpcFor('devB', { down: true }) });
    localSale(B, 'devB', 'ordB', 'itemB', 'inv1', '2');
    await eB.drain();
    expect(B.prepare('SELECT status, server_failures f FROM inventory_outbox').get()).toEqual({ status: 'retry_wait', f: 0 });
    const v = v8.reconcile.stockView(B, 'inv1');
    expect(v.isProvisional).toBe(true); expect(v.provisionalMilli).toBe(3000);
  });
});

describe('hook de pedidos (V8 §4.7)', () => {
  test('encola la venta y marca los movimientos legados como provisionales, sin tocar otros datos', () => {
    const db = openDb();
    addProduct(db, 'inv1', 'Coca', 5);
    db.exec(`INSERT INTO orders(uuid,status) VALUES ('ord-1','pending')`);
    db.exec(`INSERT INTO order_items(uuid,order_id,name,price,qty,itemType,invId) VALUES (NULL,1,'Coca',2500,2,'inventory',1)`);
    db.exec(`INSERT INTO stock_movements(inventory_id,product_name,movement_type,quantity,stock_before,stock_after,shortage_quantity,reference_type,reference_id,created_at,uuid)
             VALUES (1,'Coca','sale',2,5,3,0,'order',1,1,'legacy-1')`);
    const r = v8.hook.onOrderCreated(db, { orderId: 1, deviceId: 'dev', userName: 'Ana' });
    expect(r.enqueued).toBe(true);
    const env = JSON.parse(db.prepare('SELECT request_payload p FROM inventory_outbox').get().p);
    expect(env.intent.items[0].qty).toBe('2');
    expect(env.intent.items[0].unit_price).toBe('2500');
    expect(env.intent.expected_version).toBe(0);
    const m = db.prepare('SELECT confirmation_state s, applied_milli a, delta_milli d, kind k FROM stock_movements').get();
    expect(m).toEqual({ s: 'provisional', a: 2000, d: -2000, k: 'sale' });
    expect(db.prepare('SELECT uuid FROM order_items').get().uuid).toBeTruthy();
    // reintento del mismo pedido: no duplica la operación
    expect(v8.hook.onOrderCreated(db, { orderId: 1, deviceId: 'dev' }).deduplicated).toBe(true);
    expect(db.prepare('SELECT COUNT(*) c FROM inventory_outbox').get().c).toBe(1);
  });
});

describe('auditoría V8.1', () => {
  test('C-03: una operación deduplicada no deja provisionales huérfanos ni duplica movimientos', () => {
    const db = openDb(); addProduct(db, 'inv1', 'Coca', 5);
    // el dispositivo registró (por doble encolado) dos operaciones con efecto provisional local sobre la misma línea
    const mk = (op, key) => db.prepare(`INSERT INTO inventory_outbox(operation_id,idempotency_key,op_kind,entity_type,entity_uuid,entity_seq,partition_key,request_payload,request_hash,status,created_at,device_id,restaurant_id)
      VALUES (?,?,?,?,?,?,?,?,?,'claimed',1,'devA','rest-1')`).run(op, key, 'sale', 'order', 'ord1', key === 'k1' ? 1 : 2, 'order:ord1', '{}', 'h');
    mk('op1', 'k1'); mk('op2', 'k2');
    const prov = (op, kind, applied, short, delta) => db.prepare(
      `INSERT INTO stock_movements(inventory_id,product_name,movement_type,quantity,stock_before,stock_after,created_at,uuid,inventory_uuid,operation_id,line_id,kind,requested_milli,applied_milli,shortage_milli,delta_milli,confirmation_state,origin)
       VALUES (1,'Coca',?,?,5,3,1,?,'inv1',?,'lineX',?,2000,?,?,?,'provisional','local')`).run(kind, applied / 1000, 'u-' + op + kind, op, kind, applied, short, delta);
    prov('op1', 'sale', 2000, 0, -2000); prov('op2', 'sale', 2000, 0, -2000);
    expect(v8.reconcile.stockView(db, 'inv1').pendingDeltaMilli).toBe(-4000);          // doble descuento provisional
    const res = { schema_version: 1, operation_id: 'op1', operation_status: 'applied', replayed: true, deduplicated_of: 'op1', event_seq: 7,
      order: { order_uuid: 'ord1', version: 1, status: 'open' },
      movements: [{ movement_id: 'm1', line_id: 'lineX', kind: 'sale', inventory_uuid: 'inv1', requested_qty: '2', applied_qty: '2', shortage_qty: '0', stock_delta: '-2', stock_before: '5', stock_after: '3' }],
      inventory: [{ inventory_uuid: 'inv1', stock: '3', version: 2 }] };
    db.exec('BEGIN IMMEDIATE');
    v8.reconcile.applyAuthoritativeResultTx(db, res, { source: 'response', originDeviceId: 'devA', deviceId: 'devA', ownOperationId: 'op2', now: 10 });
    db.exec('COMMIT');
    const v = v8.reconcile.stockView(db, 'inv1');
    expect(v.confirmedMilli).toBe(3000); expect(v.pendingDeltaMilli).toBe(0); expect(v.provisionalMilli).toBe(3000);
    const st = db.prepare('SELECT operation_id o, confirmation_state s FROM stock_movements ORDER BY id').all();
    expect(st).toEqual([{ o: 'op1', s: 'confirmed' }, { o: 'op2', s: 'rejected' }]);   // ningún movimiento duplicado ni huérfano
    expect(db.prepare('SELECT status s FROM inventory_outbox ORDER BY outbox_id').all()).toEqual([{ s: 'applied' }, { s: 'applied' }]);
  });
  test('A-01: la idempotency_key incluye el dispositivo (dos equipos no colisionan)', () => {
    const db = openDb();
    const a = v8.outbox.enqueue(db, { opKind: 'modify', entityType: 'order', entityUuid: 'P', intent: { expected_version: 1, items: [] }, deviceId: 'devA', restaurantId: 'r', purposeSeq: 2 });
    const b = v8.outbox.enqueue(db, { opKind: 'modify', entityType: 'order', entityUuid: 'P', intent: { expected_version: 1, items: [] }, deviceId: 'devB', restaurantId: 'r', purposeSeq: 2 });
    expect(b.deduplicated).toBe(false);
    const keys = db.prepare('SELECT idempotency_key k FROM inventory_outbox').all().map((r) => r.k);
    expect(keys).toEqual(['modify:P:devA:2', 'modify:P:devB:2']);
  });
});
