/**
 * pos-venta-fx.js
 * Mejoras de comodidad para la pantalla de Punto de Venta. No modifica
 * la lógica de ventas existente (pos-venta.js): todo acá es adicional
 * (observadores de DOM, un listener de teclado, clicks sintéticos sobre
 * los mismos botones que ya existen).
 */
(function () {

  // ---------- 7) Foco automático en el buscador ----------
  function maybeFocusSearch() {
    const input = document.getElementById('pos-search-input');
    if (!input) return;
    const modalOpen = document.getElementById('modal-overlay')?.classList.contains('open');
    const searchOverlay = document.getElementById('pos-search-overlay');
    const searchOverlayOpen = searchOverlay && getComputedStyle(searchOverlay).display !== 'none';
    if (modalOpen || searchOverlayOpen) return;
    // Solo si no hay nada puntualmente enfocado (ej. recién se pintó la página o se agregó un item)
    if (document.activeElement === document.body) input.focus();
  }

  // ---------- 1) Flash dorado al agregar un producto ----------
  function attachFlashDelegation() {
    const content = document.getElementById('content');
    if (!content || content.__posFlashAttached) return;
    content.__posFlashAttached = true;
    content.addEventListener('click', (e) => {
      const card = e.target.closest('.pos-item');
      if (!card || card.classList.contains('unavailable')) return;
      card.classList.remove('pos-item-flash');
      void card.offsetWidth; // fuerza reflow para poder re-disparar la animación
      card.classList.add('pos-item-flash');
    });
  }

  // ---------- 2) Indicadores deslizantes de categorías / subcategorías ----------
  function positionIndicator(containerSel, activeSel, indicatorClass) {
    const wrap = document.querySelector(containerSel);
    if (!wrap) return;
    const active = wrap.querySelector(activeSel);
    let indicator = wrap.querySelector('.' + indicatorClass);
    if (!active) {
      if (indicator) indicator.style.opacity = '0';
      return;
    }
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.className = indicatorClass;
      wrap.prepend(indicator);
    }
    const wrapRect = wrap.getBoundingClientRect();
    const btnRect = active.getBoundingClientRect();
    indicator.style.opacity = '1';
    indicator.style.left = (btnRect.left - wrapRect.left) + 'px';
    indicator.style.top = (btnRect.top - wrapRect.top) + 'px';
    indicator.style.width = btnRect.width + 'px';
    indicator.style.height = btnRect.height + 'px';
  }
  function positionPosIndicators() {
    positionIndicator('.pos-categories', '.pos-cat.active', 'pos-cat-indicator');
    positionIndicator('.pos-subcat-bar', '.pos-subcat-btn.active', 'pos-subcat-indicator');
  }

  // ---------- Reenganche tras cada re-render de la página (innerHTML nuevo) ----------
  function onContentRendered() {
    attachFlashDelegation();
    setTimeout(() => {
      positionPosIndicators();
      maybeFocusSearch();
    }, 30);
  }

  function watchContent() {
    const content = document.getElementById('content');
    if (!content) return;
    const mo = new MutationObserver(onContentRendered);
    mo.observe(content, { childList: true });
    onContentRendered();
    window.addEventListener('resize', positionPosIndicators);
  }

  // ---------- 8) Atajos de teclado en el POS ----------
  document.addEventListener('keydown', function (ev) {
    if (typeof S === 'undefined' || S.currentPage !== 'pos') return;

    const modalOpen = document.getElementById('modal-overlay')?.classList.contains('open');
    const searchOverlay = document.getElementById('pos-search-overlay');
    const searchOverlayOpen = searchOverlay && getComputedStyle(searchOverlay).display !== 'none';
    if (modalOpen || searchOverlayOpen) return;

    const tag = document.activeElement?.tagName;
    const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || document.activeElement?.isContentEditable;

    // 1-9: agrega rápido el producto visible en esa posición (misma acción que tocarlo con el mouse)
    if (!ev.ctrlKey && !ev.altKey && !ev.metaKey && !inField && ev.key >= '1' && ev.key <= '9') {
      const cards = document.querySelectorAll('#pos-items .pos-item');
      const card = cards[Number(ev.key) - 1];
      if (card && !card.classList.contains('unavailable')) {
        ev.preventDefault();
        ev.stopPropagation(); // evita que el atajo global de "enfocar buscador al tipear" se dispare también
        card.click();
      }
      return;
    }

    // Enter: cobrar (si el carrito tiene items)
    if (ev.key === 'Enter' && !inField) {
      const btn = document.querySelector('.btn-cobrar');
      if (btn && !btn.disabled) {
        ev.preventDefault();
        btn.click();
      }
      return;
    }

    // Escape: limpiar el carrito
    if (ev.key === 'Escape' && !inField) {
      if (typeof S !== 'undefined' && S.currentOrder && S.currentOrder.items && S.currentOrder.items.length && typeof clearOrder === 'function') {
        clearOrder();
      }
    }
  }, true); // capture:true para adelantarse al listener global de "enfocar buscador al tipear"

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watchContent);
  } else {
    watchContent();
  }
})();
