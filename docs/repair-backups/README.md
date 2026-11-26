# Copias archivadas fuera de `public/`

Estos archivos no son cargados por `public/index.html`. Se movieron fuera de `public/` porque `build/minify-js.js` toma los archivos `public/pos-*.js`; mantener allí copias de JavaScript con errores de sintaxis hacía que el proceso de minificación intentara procesarlas.

- `pos-auth.js.pre-repair`: copia exacta del archivo recibido antes de la reparación.
- `pos-dashboard-original.js`: copia histórica incluida en el ZIP; contiene un error de sintaxis.
- `pos-dashboard-repair.js`: copia histórica incluida en el ZIP; contiene un error de sintaxis.
- `pos-dashboard.js.backup`: copia de respaldo incluida en el ZIP.
- `pos-dashboard.js.bak`: copia de respaldo incluida en la raíz del ZIP.

No cargar estos archivos desde la aplicación.
