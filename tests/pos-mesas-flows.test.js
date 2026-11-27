/**
 * Regresiones de UI para división de cuenta / separación por persona y
 * fusión de mesas. `public/pos-mesas.js` es un script de navegador minificado:
 * se evalúa en un VM con stubs mínimos para poder ejercitar las funciones reales.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'pos-mesas.js'), 'utf8');

function loadPosMesas({ orders = [], tables = [], config = {}, elements = {}, fetchImpl } = {}) {
  const timeouts = [];
  const tickets = [];
  const modals = [];
  const fetches = [];
  const dom = {
    getElementById: id => elements[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, appendChild() {} }),
    body: { appendChild() {} },
    head: { appendChild() {} },
  };
  const ctx = {
    S: {
      orders, tables,
      config: { name: 'Test', payMethods: { cash: true, card: true, transfer: true }, commissions: {}, taxRate: 0, ...config },
    },
    window: {},
    document: dom,
    localStorage: { getItem: () => null, setItem() {} },
    confirm: () => true,
    fetch: (url, opts) => {
      fetches.push({ url, opts: opts || {}, body: opts && opts.body ? JSON.parse(opts.body) : null });
      return fetchImpl ? fetchImpl(url, opts) : Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    },
    setTimeout: fn => { timeouts.push(fn); return timeouts.length; },
    clearTimeout() {},
    toast() {}, addNotif() {}, render() {}, saveState() {}, syncAppData: () => Promise.resolve(),
    setTableStatus() {}, closeModal() {},
    openModal: (title, body, footer) => modals.push({ title, body, footer }),
    escapeHtml: x => String(x), fmt: x => String(x), console,
  };
  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx);
  ctx._autoImprimirTicket = (ticket, change) => tickets.push({ ticket, change });
  return { ctx, timeouts, tickets, modals, fetches, elements };
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
}

describe('pos-mesas: tickets de division y cuenta unida', () => {
  test('dividir por personas emite un ticket por persona con id unico y metodo elegido', async () => {
    const elements = {
      'split-personas-input': { value: '2' },
      'split-pay-method': { value: 'card' },
      'split-pay-received': { value: '500' },
    };
    const h = loadPosMesas({
      orders: [{ id: 12, tableId: 4, type: 'dine-in', status: 'pending', total: 1000, subtotal: 1000,
        items: [{ name: 'Agua', qty: 2, price: 500, lineTotal: 1000 }] }],
      tables: [{ id: 4, numero: 4 }],
      elements,
    });
    const { ctx } = h;

    // El panel de cobro confirma cada parte con el método elegido.
    ctx.openSplitPaymentPanel = () => ctx.confirmarSplitPago(4, 500);
    ctx.dividirPorPersonas(4, 1000);
    expect(ctx.window._splitQueue.splits).toHaveLength(2);
    expect(ctx.window._splitQueue.splits[0]).toMatchObject({ label: 'Persona 1', amount: 500 });
    expect(ctx.window._splitQueue.splits[0].items[0].name).toBe('Persona 1');

    while (h.timeouts.length) {
      h.timeouts.shift()();
      await flush();
    }
    await flush();

    expect(h.tickets).toHaveLength(2);
    expect(h.tickets[0].ticket.id).toBe('12-split-1');
    expect(h.tickets[1].ticket.id).toBe('12-split-2');
    expect(h.tickets[0].ticket.total).toBe(500);
    expect(h.tickets[0].ticket.paymentMethod).toBe('card');
    expect(h.fetches.filter(f => f.url === '/api/orders/pay')).toHaveLength(1);
  });

  test('separar por persona conserva los items reales asignados a cada ticket', async () => {
    const h = loadPosMesas({
      orders: [{ id: 30, tableId: 7, type: 'dine-in', status: 'pending', total: 900, items: [] }],
      tables: [{ id: 7, numero: 7 }],
      elements: {
        'sep-n-personas': { value: '2' },
        'i1-persona': { value: '1' },
        'i2-persona': { value: '2' },
        'split-pay-method': { value: 'cash' },
        'split-pay-received': { value: '400' },
      },
    });
    const { ctx } = h;
    ctx.window._sepItems = [
      { _uid: 'i1', name: 'Café', qty: 1, price: 400, lineTotal: 400 },
      { _uid: 'i2', name: 'Torta', qty: 1, price: 500, lineTotal: 500 },
    ];
    ctx.openSplitPaymentPanel = () => ctx.confirmarSplitPago(7, 400);
    ctx.ejecutarSeparacionPersonas(7);
    const splits = ctx.window._splitQueue.splits;
    expect(splits).toHaveLength(2);
    expect(splits[0].items.map(i => i.name)).toEqual(['Café']);
    expect(splits[1].items.map(i => i.name)).toEqual(['Torta']);

    while (h.timeouts.length) {
      h.timeouts.shift()();
      await flush();
    }
    await flush();
    expect(h.tickets).toHaveLength(2);
    expect(h.tickets[0].ticket.items[0].name).toBe('Café');
    expect(h.tickets[1].ticket.items[0].name).toBe('Torta');
  });

  test('mesas fusionadas se cobran y se imprimen como una sola cuenta', async () => {
    const elements = {
      'caja-pay-method': { value: 'cash' },
      'caja-pay-recv': { value: '1650' },
      'caja-pay-total': { style: {} },
      'caja-comm-note': { style: {} },
      'caja-pay-change': { style: {} },
    };
    const h = loadPosMesas({
      orders: [
        { id: 116, tableId: null, type: 'takeaway', status: 'pending', groupKey: 'mesa-5',
          subtotal: 700, tax: 0, discountAmt: 0, total: 700,
          items: [{ name: 'Agua', qty: 1, price: 700, lineTotal: 700 }] },
        { id: 117, tableId: null, type: 'takeaway', status: 'pending', groupKey: 'mesa-5',
          subtotal: 800, tax: 0, discountAmt: 0, total: 800,
          items: [{ name: 'Café', qty: 1, price: 800, lineTotal: 800 }] },
      ],
      config: { commissions: { cash: 10 } },
      elements,
    });
    const { ctx } = h;

    ctx.openCajaActions();
    expect(h.modals).toHaveLength(1);
    expect(h.modals[0].body).toContain('2 pedidos unidos');
    expect((h.modals[0].body.match(/Cobrar<\/button>/g) || [])).toHaveLength(1);

    ctx.openCajaGroupPayment('mesa-5');
    await ctx.confirmCajaGroupPayment('mesa-5', 1500);

    const payCalls = h.fetches.filter(f => f.url === '/api/orders/pay');
    expect(payCalls).toHaveLength(2);
    expect(payCalls.map(f => f.body.id)).toEqual([116, 117]);
    expect(payCalls.reduce((a, f) => a + f.body.total, 0)).toBe(1650);

    expect(h.tickets).toHaveLength(1);
    expect(h.tickets[0].ticket.id).toBe('116-grp');
    expect(h.tickets[0].ticket.items.map(i => i.name)).toEqual(['Agua', 'Café']);
    expect(h.tickets[0].ticket.total).toBe(1650);
  });
});
