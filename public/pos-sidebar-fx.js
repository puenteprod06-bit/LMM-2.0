/**
 * pos-sidebar-fx.js
 * Barrita/panel de selección que se desliza suavemente entre ítems del
 * sidebar al cambiar de sección, en vez de que el resaltado aparezca/
 * desaparezca seco. No modifica la lógica de navegación existente
 * (pos-nav.js / pos-search.js): solo observa cuándo cambia la clase
 * "active" y mueve un indicador visual detrás del ítem correspondiente.
 */
(function () {
  function positionIndicator() {
    const nav = document.querySelector('.sidebar-nav');
    const indicator = document.getElementById('nav-active-indicator');
    if (!nav || !indicator) return;
    const active = nav.querySelector('.nav-item.active');
    if (!active || getComputedStyle(active).display === 'none') {
      indicator.style.opacity = '0';
      return;
    }
    const navRect = nav.getBoundingClientRect();
    const itemRect = active.getBoundingClientRect();
    indicator.style.opacity = '1';
    indicator.style.top = (itemRect.top - navRect.top + nav.scrollTop) + 'px';
    indicator.style.height = itemRect.height + 'px';
  }

  function init() {
    const nav = document.querySelector('.sidebar-nav');
    if (!nav) return;

    if (!document.getElementById('nav-active-indicator')) {
      const ind = document.createElement('div');
      ind.id = 'nav-active-indicator';
      ind.className = 'nav-active-indicator';
      nav.prepend(ind);
    }

    const mo = new MutationObserver(() => positionIndicator());
    mo.observe(nav, { attributes: true, attributeFilter: ['class', 'style'], subtree: true });

    window.addEventListener('resize', positionIndicator);
    setTimeout(positionIndicator, 60);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Número de versión al pie del sidebar (mismo patrón que el login)
  function setSidebarVersion() {
    const el = document.getElementById('sidebar-app-version');
    if (el) el.textContent = 'v' + (window.electronAPI?.appVersion || '2.3.2');
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setSidebarVersion);
  } else {
    setSidebarVersion();
  }
})();
