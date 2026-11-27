/**
 * Los productos del POS no deben mostrar ni persistir emojis:
 * el campo `emoji` se usa solo para nombres de iconos Material Symbols.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const request = require('supertest');
const { buildTestApp } = require('./helpers/testApp');

const STATE_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'pos-state.js'), 'utf8');

function loadState() {
  const ctx = {
    console,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    window: {},
    document: { documentElement: { classList: { add() {}, remove() {} } } },
  };
  vm.createContext(ctx);
  vm.runInContext(STATE_SRC, ctx);
  // `S` es un `let` de ámbito del script: se lee evaluando dentro del VM.
  ctx.getState = () => vm.runInContext('S', ctx);
  return ctx;
}

describe('productos sin emojis', () => {
  test('updateState descarta emojis en menú e inventario pero conserva iconos Material Symbols', () => {
    const ctx = loadState();
    ctx.updateState('menuItems', [
      { id: 1, name: 'Hamburguesa', emoji: '🍔' },
      { id: 2, name: 'Pizza', emoji: 'local_pizza' },
    ]);
    ctx.updateState('inventory', [
      { id: 1, name: 'Carne', emoji: '🥩' },
      { id: 2, name: 'Agua', emoji: 'inventory_2' },
    ]);

    const state = ctx.getState();
    expect(state.menuItems[0].emoji).toBeNull();
    expect(state.menuItems[1].emoji).toBe('local_pizza');
    expect(state.inventory[0].emoji).toBeNull();
    expect(state.inventory[1].emoji).toBe('inventory_2');
  });

  test('las tarjetas del POS ya no incrustan el emoji del producto', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'pos-venta.js'), 'utf8');
    expect(src).not.toContain('>${t.emoji||"restaurant"}</span><img');
    expect(src).not.toContain('>${o.emoji}</span>');
  });

  test('la API guarda iconos seguros aunque el cliente envíe emojis', async () => {
    const { app, db } = buildTestApp();
    const menuRes = await request(app)
      .post('/api/menu/save')
      .send({ name: 'Plato sin emoji', price: 100, catId: 1, area: 'cocina', emoji: '🍔' });
    expect(menuRes.status).toBe(200);
    const menuRow = db._native.prepare('SELECT emoji FROM menu_items WHERE name = ?').get('Plato sin emoji');
    expect(menuRow.emoji).toBe('restaurant');

    const invRes = await request(app)
      .post('/api/inventory/save')
      .send({ name: 'Insumo sin emoji', stock: 5, emoji: '🥩' });
    expect(invRes.status).toBe(200);
    const invRow = db._native.prepare('SELECT emoji FROM inventory WHERE name = ?').get('Insumo sin emoji');
    expect(invRow.emoji).toBe('inventory_2');
  });
});
