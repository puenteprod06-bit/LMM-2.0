/**
 * Regresiones de la pantalla Venta: texto legible, una sola pestaña por
 * categoría, tarjetas grandes y uniformes, carrito compacto y controles visibles.
 */
const fs = require('fs');
const path = require('path');

const VENTA_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'pos-venta.js'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

function ruleContaining(selector, marker) {
  let start = -1;
  while ((start = CSS_SRC.indexOf(selector, start + 1)) >= 0) {
    const block = CSS_SRC.slice(start, CSS_SRC.indexOf('}', start) + 1);
    if (block.includes(marker)) return block;
  }
  return '';
}

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

  test('las cards usan un único generador y ajustan el texto sin tocar ventas', () => {
    expect(VENTA_SRC).toContain('function posProductCardHTML');
    expect(VENTA_SRC).toContain('r.map(t=>posProductCardHTML(');
    expect(VENTA_SRC).toContain('return posProductCardHTML(t,{stock:stock,stockColor:stockColor})');
    expect(VENTA_SRC).toContain('function fitPOSCardText');
    expect(VENTA_SRC.split('fitPOSCardText()').length - 1).toBe(3);
    expect(VENTA_SRC).toContain('class="price-main"');
    expect(VENTA_SRC).toContain('window.addEventListener("resize"');
    expect(VENTA_SRC).toContain('new ResizeObserver');
    expect(VENTA_SRC).not.toContain('object-fit:cover');
  });

  test('la imagen va completa en un contenedor fijo con object-fit contain', () => {
    expect(CSS_SRC).toContain('.pos-card-media{');
    expect(CSS_SRC).toContain('object-fit:contain!important');
    expect(CSS_SRC).toContain('background:#070c13');
    expect(ruleContaining('.pos-card-media img', 'object-fit:contain')).toContain('height:100%');
    expect(VENTA_SRC).toContain('class="pos-card-media"');
  });

  test('grilla uniforme, nombre de hasta 3 líneas y precio dorado alineado', () => {
    expect(CSS_SRC).toContain('--card-h:248px');
    expect(CSS_SRC).toContain('height:var(--card-h)');
    expect(CSS_SRC).toContain('grid-template-columns:repeat(auto-fill,minmax(180px,1fr))');
    const nameRule = ruleContaining('.pos-item .name{', 'height:var(--name-h)');
    expect(nameRule).toContain('height:var(--name-h)');
    expect(nameRule).toContain('line-height:1.25');
    expect(nameRule).not.toContain('-webkit-line-clamp');
    const priceRule = ruleContaining('.pos-item .price{', 'height:var(--price-h)');
    expect(priceRule).toContain('height:var(--price-h)');
    expect(priceRule).toContain('white-space:nowrap');
    expect(priceRule).toContain('color:var(--accent)!important');
  });

  test('distribución responsive sin deformar tarjetas', () => {
    for (const query of [
      '@media (max-width:1200px)',
      '@media (max-width:900px)',
      '@media (max-width:768px)',
      '@media (max-width:520px)',
    ]) {
      expect(CSS_SRC).toContain(query);
    }
    expect(CSS_SRC).toContain('grid-template-columns:repeat(3,minmax(0,1fr))');
    expect(CSS_SRC).toContain('grid-template-columns:repeat(2,minmax(0,1fr))');
    expect(CSS_SRC).toContain('--card-h:228px');
    expect(CSS_SRC).toContain('--card-h:216px');
    expect(CSS_SRC).toContain('--card-h:212px');
    expect(CSS_SRC).toContain('--media-h:72px');
    expect(CSS_SRC).toContain('--name-h:50px');
  });
});
