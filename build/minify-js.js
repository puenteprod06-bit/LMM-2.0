// build/minify-js.js
// Minifica los archivos JS del frontend (public/*.js) usando terser.
// Ejecutado automáticamente por "npm run minify:js" antes del empaquetado.
//
// Uso manual:  node build/minify-js.js
// ============================================================

const { minify } = require('terser');
const fs   = require('fs');
const path = require('path');
const glob = require('glob');

const PUBLIC = path.join(__dirname, '..', 'public');

// Archivos JS del frontend a minificar (excluir libs de terceros si las hubiera)
const files = glob.sync(`${PUBLIC}/pos-*.js`).concat(
  glob.sync(`${PUBLIC}/*-module.js`),
  glob.sync(`${PUBLIC}/print-manager.js`),
  glob.sync(`${PUBLIC}/theme-manager.js`),
  glob.sync(`${PUBLIC}/waiter-notify.js`)
);

async function minifyAll() {
  let totalSaved = 0;
  for (const file of files) {
    const src      = fs.readFileSync(file, 'utf8');
    const srcBytes = Buffer.byteLength(src, 'utf8');
    try {
      const result   = await minify(src, {
        compress: { drop_console: false },   // conservar console en POS
        mangle:   true,
        format:   { comments: false }
      });
      fs.writeFileSync(file, result.code, 'utf8');
      const destBytes = Buffer.byteLength(result.code, 'utf8');
      const saved     = srcBytes - destBytes;
      totalSaved     += saved;
      console.log(`✅ ${path.basename(file)} — ahorro: ${(saved / 1024).toFixed(1)} KB`);
    } catch (err) {
      console.error(`❌ Error minificando ${path.basename(file)}: ${err.message}`);
    }
  }
  console.log(`\n🎯 Total ahorrado: ${(totalSaved / 1024).toFixed(1)} KB`);
}

minifyAll().catch(err => {
  console.error('Error en minify-js:', err.message);
  process.exit(1);
});
