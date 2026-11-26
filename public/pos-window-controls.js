/**
 * pos-window-controls.js
 * La ventana de Electron ahora es "frameless" (sin marco nativo) para poder
 * mostrar el login como una ventanita flotante sobre el escritorio.
 * Estas funciones exponen los controles mínimos (minimizar/maximizar/cerrar)
 * que antes daba gratis el marco nativo de Windows.
 * No tocan ninguna lógica de negocio de la app.
 */
function winMinimize() {
  window.electronAPI?.winMinimize?.();
}
function winToggleMaximize() {
  window.electronAPI?.winToggleMaximize?.();
}
function winClose() {
  window.electronAPI?.winClose?.();
}

/**
 * Ajuste automático de altura de la ventanita de login.
 * El formulario de "Propietario" es más corto que el de "Staff" (numpad),
 * así que en vez de una altura fija, medimos la tarjeta real y le pedimos
 * a Electron que redimensione la ventana para que quede justa siempre,
 * sin espacio de sobra ni contenido cortado.
 */
(function () {
  let debounceTimer = null;

  function sendSize() {
    if (!window.electronAPI?.resizeLoginWindow) return;
    const wall = document.getElementById('register-wall');
    const card = document.getElementById('login-float-card');
    if (!wall || !card) return;
    if (getComputedStyle(wall).display === 'none') return; // ya se inició sesión, no tocar el tamaño
    const h = Math.ceil(card.getBoundingClientRect().height);
    if (h > 0) window.electronAPI.resizeLoginWindow(h);
  }

  // Debounce: la transición entre pestañas (Propietario ⇄ Staff) dispara
  // varios cambios de tamaño intermedios mientras anima (~200ms). Esperamos
  // a que se asiente antes de pedir el resize, así siempre se aplica la
  // medida FINAL y no una intermedia que quede pisada por otra.
  function scheduleSendSize() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(sendSize, 220);
  }

  function init() {
    const card = document.getElementById('login-float-card');
    if (!card) return;
    if ('ResizeObserver' in window) {
      new ResizeObserver(scheduleSendSize).observe(card);
    }
    setTimeout(sendSize, 80); // primer ajuste al cargar

    // Refuerzo: al cambiar de pestaña (Propietario ⇄ Staff) forzamos también
    // un ajuste una vez terminada la animación (~400ms cubre de sobra el
    // fade-out + fade-in de switchLoginTab), sin depender únicamente del
    // ResizeObserver.
    if (typeof window.switchLoginTab === 'function' && !window.switchLoginTab.__sizePatched) {
      const original = window.switchLoginTab;
      const patched = function (tab) {
        const result = original.apply(this, arguments);
        setTimeout(sendSize, 400);
        return result;
      };
      patched.__sizePatched = true;
      window.switchLoginTab = patched;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
