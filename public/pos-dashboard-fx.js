/**
 * pos-dashboard-fx.js
 * Dos mejoras visuales del Dashboard, ambas "no invasivas" (no tocan la
 * lógica de pos-dashboard.js, solo observan el DOM que ya se genera):
 *
 * 1) Punto pulsante ("en vivo") al final de la línea de Ventas Actuales.
 * 2) Indicador deslizante detrás de los botones Hoy / Semana / Mes.
 *
 * El dashboard se re-renderiza por completo (innerHTML) cada vez que se
 * navega a él, así que reenganchamos todo observando #content.
 */
(function () {
  // ---------- 1) Punto pulsante del gráfico ----------
  function positionChartPulseDot() {
    if (typeof mainChartInstance === 'undefined' || !mainChartInstance) return;
    const canvas = document.getElementById('main-sales-chart');
    if (!canvas) return;
    const container = canvas.closest('.chart-container-dashboard');
    if (!container) return;

    let meta;
    try {
      meta = mainChartInstance.getDatasetMeta(0);
    } catch (e) { return; }
    const pts = meta && meta.data;
    if (!pts || !pts.length) return;
    const last = pts[pts.length - 1];
    if (!last) return;

    let dot = container.querySelector('.chart-pulse-dot');
    if (!dot) {
      dot = document.createElement('div');
      dot.className = 'chart-pulse-dot';
      container.style.position = container.style.position || 'relative';
      container.appendChild(dot);
    }
    dot.style.left = last.x + 'px';
    dot.style.top = last.y + 'px';
  }
  window.positionChartPulseDot = positionChartPulseDot; // pos-dashboard.js la llama tras crear el chart

  // ---------- 2) Indicador deslizante Hoy / Semana / Mes ----------
  function positionFilterIndicator() {
    const wrap = document.querySelector('.chart-filters');
    if (!wrap) return;
    const active = wrap.querySelector('.btn-chart-filter.active');
    let indicator = wrap.querySelector('.filter-indicator');
    if (!active) {
      if (indicator) indicator.style.opacity = '0';
      return;
    }
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.className = 'filter-indicator';
      wrap.prepend(indicator);
    }
    const wrapRect = wrap.getBoundingClientRect();
    const btnRect = active.getBoundingClientRect();
    indicator.style.opacity = '1';
    indicator.style.left = (btnRect.left - wrapRect.left) + 'px';
    indicator.style.width = btnRect.width + 'px';
  }

  function attachFilterObserver() {
    const wrap = document.querySelector('.chart-filters');
    if (!wrap || wrap.__fxObserved) return;
    wrap.__fxObserved = true;
    const mo = new MutationObserver(positionFilterIndicator);
    mo.observe(wrap, { attributes: true, attributeFilter: ['class'], subtree: true });
    window.addEventListener('resize', positionFilterIndicator);
    setTimeout(positionFilterIndicator, 250);
  }

  // ---------- Reenganche automático al re-renderizarse el dashboard ----------
  function onDashboardRendered() {
    attachFilterObserver();
    setTimeout(positionChartPulseDot, 300);
  }

  function watchContent() {
    const content = document.getElementById('content');
    if (!content) return;
    const mo = new MutationObserver(onDashboardRendered);
    mo.observe(content, { childList: true });
    onDashboardRendered(); // por si el dashboard ya está pintado al cargar
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watchContent);
  } else {
    watchContent();
  }
})();
