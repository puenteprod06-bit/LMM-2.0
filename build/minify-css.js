// build/minify-css.js
// Minifica public/styles.css → public/styles.css antes del empaquetado.
// Ejecutado automáticamente por "npm run dist" vía el script "minify:css".
//
// Uso manual:  node build/minify-css.js
// ============================================================

const postcss  = require('postcss');
const cssnano  = require('cssnano');
const fs       = require('fs');
const path     = require('path');

const SRC  = path.join(__dirname, '..', 'public', 'styles.css');
const DEST = path.join(__dirname, '..', 'public', 'styles.css'); // sobreescribe in-place

async function minify() {
  const css      = fs.readFileSync(SRC, 'utf8');
  const srcBytes = Buffer.byteLength(css, 'utf8');

  const result = await postcss([
    cssnano({
      preset: ['default', {
        discardComments:      { removeAll: true },  // elimina todos los comentarios
        normalizeWhitespace:  true,                 // colapsa espacios/saltos
        cssDeclarationSorter: false,                // no reordenar props (seguro)
        reduceIdents:         false,                // no renombrar @keyframes
        mergeRules:           false,                // evitar merges que rompan especificidad
      }]
    })
  ]).process(css, { from: SRC, to: DEST });

  fs.writeFileSync(DEST, result.css, 'utf8');

  const destBytes = Buffer.byteLength(result.css, 'utf8');
  const saved     = srcBytes - destBytes;
  const pct       = ((saved / srcBytes) * 100).toFixed(1);

  console.log(`✅ CSS minificado`);
  console.log(`   Original : ${(srcBytes  / 1024).toFixed(1)} KB`);
  console.log(`   Minificado: ${(destBytes / 1024).toFixed(1)} KB`);
  console.log(`   Ahorro    : ${(saved     / 1024).toFixed(1)} KB (${pct}%)`);
}

minify().catch(err => {
  console.error('❌ Error minificando CSS:', err.message);
  process.exit(1);
});