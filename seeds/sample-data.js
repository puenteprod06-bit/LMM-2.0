'use strict';

/**
 * seeds/sample-data.js
 *
 * Datos de ejemplo para nuevas instalaciones.
 * NO se ejecuta automáticamente — solo cuando el usuario confirma
 * en el onboarding que quiere datos de prueba.
 *
 * Invocado por: POST /api/system/load-sample-data (routes/system.js)
 */

const SAMPLE_CATEGORIES = [
  { name: 'Principales', emoji: '🍽️' },
  { name: 'Bebidas',     emoji: '🥤' },
  { name: 'Postres',     emoji: '🍰' },
];

const SAMPLE_MENU_ITEMS = [
  { name: 'Hamburguesa Clásica', price: 8.50,  cost: 3.20, catIdx: 0, emoji: 'restaurant', area: 'cocina' },
  { name: 'Pizza Margarita',     price: 12.00, cost: 4.50, catIdx: 0, emoji: 'restaurant', area: 'cocina' },
  { name: 'Ensalada César',      price: 7.00,  cost: 2.10, catIdx: 0, emoji: 'restaurant', area: 'cocina' },
  { name: 'Papas Fritas',        price: 4.00,  cost: 0.80, catIdx: 0, emoji: 'restaurant', area: 'cocina' },
  { name: 'Limonada',            price: 3.00,  cost: 0.60, catIdx: 1, emoji: 'restaurant', area: 'bar'    },
  { name: 'Agua Mineral',        price: 2.00,  cost: 0.30, catIdx: 1, emoji: 'restaurant', area: 'bar'    },
  { name: 'Tiramisú',            price: 5.50,  cost: 1.80, catIdx: 2, emoji: 'restaurant', area: 'cocina' },
];

const SAMPLE_INVENTORY = [
  { name: 'Pan de hamburguesa', stock: 50, minStock: 10, unit: 'unidad', cost: 0.50, salePrice: 1.20, category: 'Panadería',   emoji: 'inventory_2' },
  { name: 'Carne molida',       stock: 20, minStock:  5, unit: 'kg',     cost: 6.00, salePrice: 12.00, category: 'Carnes',    emoji: 'inventory_2' },
  { name: 'Harina 000',         stock: 15, minStock:  3, unit: 'kg',     cost: 1.20, salePrice:  2.50, category: 'Almacén',   emoji: 'inventory_2' },
  { name: 'Tomate',             stock: 30, minStock: 10, unit: 'kg',     cost: 0.90, salePrice:  2.00, category: 'Verduras',  emoji: 'inventory_2' },
  { name: 'Limón',              stock: 40, minStock: 10, unit: 'unidad', cost: 0.10, salePrice:  0.30, category: 'Frutas',    emoji: 'inventory_2' },
];

const SAMPLE_TABLES = [
  { name: 'Mesa 1' },
  { name: 'Mesa 2' },
  { name: 'Mesa 3' },
  { name: 'Mesa 4' },
  { name: 'Barra 1' },
];

const SAMPLE_ZONE = 'Salón';

/**
 * Inserta todos los datos de ejemplo en una transacción atómica.
 * Si ya existen datos (menu_items > 0) lanza un error para evitar duplicados.
 *
 * @param {import('better-sqlite3').Database} native  - Instancia better-sqlite3
 * @returns {{ categories: number, menuItems: number, inventory: number, tables: number }}
 */
function loadSampleData(native) {
  const existing = native.prepare('SELECT COUNT(*) as n FROM menu_items').get();
  if (existing.n > 0) {
    throw new Error('Ya existen productos en el menú. Limpiá el sistema antes de cargar datos de ejemplo.');
  }

  let result;

  native.transaction(() => {
    // ── Zona ────────────────────────────────────────────────
    const zoneCount = native.prepare('SELECT COUNT(*) as n FROM zones').get();
    let zoneId;
    if (zoneCount.n === 0) {
      const z = native.prepare('INSERT INTO zones (name) VALUES (?)').run(SAMPLE_ZONE);
      zoneId = z.lastInsertRowid;
    } else {
      zoneId = native.prepare('SELECT id FROM zones LIMIT 1').get().id;
    }

    // ── Categorías ──────────────────────────────────────────
    const insertCat = native.prepare('INSERT INTO categories (name, emoji) VALUES (?, ?)');
    const catIds = SAMPLE_CATEGORIES.map(c => insertCat.run(c.name, c.emoji).lastInsertRowid);

    // ── Menú ────────────────────────────────────────────────
    const insertItem = native.prepare(
      'INSERT INTO menu_items (name, price, cost, catId, emoji, available, area) VALUES (?, ?, ?, ?, ?, 1, ?)'
    );
    SAMPLE_MENU_ITEMS.forEach(m => {
      insertItem.run(m.name, m.price, m.cost, catIds[m.catIdx], m.emoji, m.area);
    });

    // ── Inventario ──────────────────────────────────────────
    const insertInv = native.prepare(
      `INSERT INTO inventory
         (name, stock, minStock, unit, cost, salePrice, category, emoji, showInPOS, area)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'almacen')`
    );
    SAMPLE_INVENTORY.forEach(i => {
      insertInv.run(i.name, i.stock, i.minStock, i.unit, i.cost, i.salePrice, i.category, i.emoji);
    });

    // ── Mesas ───────────────────────────────────────────────
    const insertTable = native.prepare('INSERT INTO tables (name, zone_id, status) VALUES (?, ?, ?)');
    SAMPLE_TABLES.forEach(t => insertTable.run(t.name, zoneId, 'free'));

    result = {
      categories: catIds.length,
      menuItems:  SAMPLE_MENU_ITEMS.length,
      inventory:  SAMPLE_INVENTORY.length,
      tables:     SAMPLE_TABLES.length,
    };
  })();

  return result;
}

module.exports = { loadSampleData };
