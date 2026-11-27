/**
 * Regresiones de la pantalla Venta: texto legible, una sola pestaña por
 * categoría, tarjetas compactas, carrito vacío compacto y controles visibles.
 */
const fs = require('fs');
const path = require('path');

const VENTA_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'pos-venta.js'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

describe('UI de Venta', () => {
  test('selector de mesa y estados usan texto legible, sin mojibake ni emojis', () => {
    expect(VENTA_SRC).not.toMatch(/ðŸ|Ã³|Ã¡|Ã­|â”€|â€œ|â€/);
    expect(VENTA_SRC).toContain('<option value="">Seleccionar mesa...</option>');
    expect(VENTA_SRC).toContain('<option value="">Seleccionar mesero...</option>');
    expect(VENTA_SRC).toContain('"Ocupada":"billing"===t.status?"En cuenta":"Libre"');
  });

  test('las categorías de inventario se fusionan con las del menú por nombre', () => {
    expect(VENTA_SRC).toContain('function normalizePOSCategoryName');
    expect(VENTA_SRC).toContain('catId:posCategoryIdForInventory(t.category)');
    expect(VENTA_SRC).toContain('if(e.has(o))return;e.add(o);a.push(');
  });

  test('carrito vacío usa un estado compacto y los botones siguen visibles', () => {
    expect(VENTA_SRC).toContain('pos-order-items${0===s.items.length?" is-empty":""}');
    expect(VENTA_SRC).toContain('classList.toggle("is-empty"');
    expect(CSS_SRC).toContain('.pos-order-items.is-empty{');
    expect(CSS_SRC).toContain('.btn-pos.btn-cobrar{');
    expect(CSS_SRC).toContain('body:has(.pos-layout){');
  });

  test('tarjetas compactas y sin foto de fondo en Venta', () => {
    expect(CSS_SRC).toContain('height:132px!important');
    expect(CSS_SRC).toContain('background-image:linear-gradient(135deg,#0b1018 0%,#111a28 100%)!important');
    expect(CSS_SRC).not.toContain('body:has(.pos-layout){background-image:url');
  });
});
