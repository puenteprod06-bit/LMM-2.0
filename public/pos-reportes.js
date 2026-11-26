// ============================================================
//  pos-reportes.js — REPORTES E HISTORIAL
//  Requiere: pos-state.js · pos-utils.js · pos-auth.js
//  Provee:   renderReports(), renderHistory(), resetHistoryFilters(),
//            downloadReportPDF(), downloadReportCSV(), printReport(),
//            showSalesDetail(), verTicketDesdeHistorial(), updateReportsChart()
// ============================================================

//  REPORTES
// ============================================================
function renderReports() {
  const ts = today();
  const ad = S.orders.filter(o => o.status === 'delivered' && o.paymentMethod);
  const todayO = ad.filter(o => o.createdAt >= ts);
  const weekO = ad.filter(o => o.createdAt >= ts - 6 * dayMs);
  const monthO = ad.filter(o => o.createdAt >= ts - 29 * dayMs);
  const todayR = todayO.reduce((s, o) => s + o.total, 0);
  const weekR = weekO.reduce((s, o) => s + o.total, 0);
  const monthR = monthO.reduce((s, o) => s + o.total, 0);
  function calcCost(orders) {
    return orders.reduce((s, o) => s + o.items.reduce((a, i) => {
      const mi = S.menuItems.find(m => m.id === i.id || m.id === i.origId);
      return a + (mi ? mi.cost : (i.cost || 0)) * i.qty;
    }, 0), 0);
  }
  const todayCost = calcCost(todayO), weekCost = calcCost(weekO), monthCost = calcCost(monthO);
  const todayProfit = todayR - todayCost, weekProfit = weekR - weekCost, monthProfit = monthR - monthCost;
  const monthMargin = monthR > 0 ? Math.round(monthProfit / monthR * 100) : 0;
  const productStats = {};
  monthO.forEach(o => o.items.forEach(i => {
    if (!productStats[i.name]) productStats[i.name] = { qty: 0, revenue: 0, cost: 0 };
    const mi = S.menuItems.find(m => m.id === i.id || m.id === i.origId);
    productStats[i.name].qty += i.qty;
    productStats[i.name].revenue += (i.lineTotal || i.price * i.qty);
    productStats[i.name].cost += (mi ? mi.cost : (i.cost || 0)) * i.qty;
  }));
  const topProducts = Object.entries(productStats).sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 6);
  const maxRevenue = topProducts.length > 0 ? topProducts[0][1].revenue : 1;
  $('content').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:10px">
      <h3 style="font-size:.95rem;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:1px">📊 Reportes Financieros</h3>
      <div style="display:flex;gap:8px">
       <button class="btn-icon" onclick="forceRefresh()" title="Refrescar datos">
      <span class="material-symbols-rounded" style="font-size:18px">refresh</span>
    </button>
    <button class="btn btn-secondary btn-sm" onclick="showSalesDetail('month')"><span class="material-symbols-rounded">list_alt</span> Detalle mes</button>
    <!-- NUEVO BOTÓN DE DESCARGA -->
    <button id="btn-pdf" class="btn btn-danger btn-sm" onclick="downloadReportPDF()">
        <span class="material-symbols-rounded" style="font-size:16px">picture_as_pdf</span> DESCARGAR PDF
    </button>
    <button id="btn-print-report" class="btn btn-primary btn-sm" onclick="printReport()"><span class="material-symbols-rounded">print</span> Imprimir Reporte</button>
</div>
    </div>
    <div class="stats-grid" style="margin-bottom:20px">
      <div class="stat-card" style="cursor:pointer" onclick="showSalesDetail('today')">
        <div class="top"><span class="label">Ventas Hoy</span><div class="icon-box" style="background:rgba(34,197,94,.15);color:var(--green)"><span class="material-symbols-rounded">today</span></div></div>
        <div class="value">${fmt(todayR)}</div>
        <div class="change up">${todayO.length} pedidos · Gan: ${fmt(todayProfit)}</div>
      </div>
      <div class="stat-card" style="cursor:pointer" onclick="showSalesDetail('week')">
        <div class="top"><span class="label">Esta Semana</span><div class="icon-box" style="background:rgba(59,130,246,.15);color:var(--blue)"><span class="material-symbols-rounded">bar_chart</span></div></div>
        <div class="value">${fmt(weekR)}</div>
        <div class="change up">${weekO.length} pedidos · Gan: ${fmt(weekProfit)}</div>
      </div>
      <div class="stat-card" style="cursor:pointer" onclick="showSalesDetail('month')">
        <div class="top"><span class="label">Este Mes</span><div class="icon-box" style="background:rgba(168,85,247,.15);color:var(--purple)"><span class="material-symbols-rounded">trending_up</span></div></div>
        <div class="value">${fmt(monthR)}</div>
        <div class="change up">${monthO.length} pedidos · ${monthMargin}% margen</div>
      </div>
      <div class="stat-card">
        <div class="top"><span class="label">Ganancia del Mes</span><div class="icon-box" style="background:rgba(245,158,11,.15);color:var(--accent)"><span class="material-symbols-rounded">payments</span></div></div>
        <div class="value" style="color:var(--green)">${fmt(monthProfit)}</div>
        <div class="change">Costos: ${fmt(monthCost)} · Margen: ${monthMargin}%</div>
      </div>
    </div>
    <div class="grid-2">
      <div class="panel">
        <div class="panel-header"><h3><span class="material-symbols-rounded">trending_up</span> Ventas vs Ganancia (14 días)</h3></div>
        <div class="panel-body">
          <div class="chart-wrapper">
            <canvas id="rpt-main-chart"></canvas>
          </div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-header"><h3><span class="material-symbols-rounded">military_tech</span> Productos más rentables</h3></div>
        <div class="panel-body">
          <div class="profit-list-container">
            ${topProducts.length === 0 ? '<p style="color:var(--text3); padding:20px; text-align:center">Sin datos este mes</p>' :
            topProducts.map(([name, s]) => {
              const margin = s.revenue > 0 ? Math.round((s.revenue - s.cost) / s.revenue * 100) : 0;
              return `
              <div class="profit-item">
                  <div class="profit-item-header">
                      <div>
                          <span class="profit-item-name">${name}</span>
                          <span class="profit-item-units">${s.qty} uds</span>
                      </div>
                      <div class="profit-item-values">
                          <div style="font-size: 0.7rem; color: var(--green)">${margin}% · ${fmt(s.revenue - s.cost)}</div>
                          <div style="font-size: 0.85rem">${fmt(s.revenue)}</div>
                      </div>
                  </div>
                  <div class="profit-bar-wrapper">
                      <div class="profit-bar-fill" style="width: ${Math.round((s.revenue / maxRevenue) * 100)}%"></div>
                  </div>
              </div>`;
            }).join('')}
          </div>
        </div>
      </div>
    </div>
    <div class="finance-summary-row">
      <div class="finance-box"><span class="f-value">${fmt(monthR)}</span><span class="f-label"><span class="material-symbols-rounded">payments</span> Ingresos brutos</span></div>
      <div class="finance-box"><span class="f-value" style="color:var(--red)">${fmt(monthCost)}</span><span class="f-label"><span class="material-symbols-rounded">shopping_bag</span> Costos productos</span></div>
      <div class="finance-box"><span class="f-value" style="color:var(--green)">${fmt(monthProfit)}</span><span class="f-label"><span class="material-symbols-rounded">account_balance_wallet</span> Ganancia bruta</span></div>
      <div class="finance-box"><span class="f-value">${monthMargin}%</span><span class="f-label"><span class="material-symbols-rounded">analytics</span> Margen bruto</span></div>
      <div class="finance-box"><span class="f-value">${monthO.length}</span><span class="f-label"><span class="material-symbols-rounded">receipt_long</span> Pedidos cobrados</span></div>
      <div class="finance-box"><span class="f-value" style="color:var(--accent)">${monthO.length ? fmt(Math.round(monthR / monthO.length)) : '—'}</span><span class="f-label"><span class="material-symbols-rounded">ads_click</span> Ticket promedio</span></div>
    </div>`;
  setTimeout(() => {
    updateReportsChart();
  }, 150);
}

// ── Helper: deshabilita btn y restaura al terminar ────────────
function _withBtnProgress(btnId, loadingLabel, fn) {
    const btn = document.getElementById(btnId);
    const original = btn ? btn.innerHTML : null;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span class="material-symbols-rounded" style="animation:spin-lazy 1s linear infinite;font-size:16px">progress_activity</span> ${loadingLabel}`;
    }
    // setTimeout cede al navegador para pintar el estado antes de bloquear el hilo
    setTimeout(async () => {
        try {
            await fn();
        } catch (e) {
            toast('Error: ' + e.message, 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = original;
            }
        }
    }, 50);
}

async function downloadReportPDF() {
    _withBtnProgress('btn-pdf', 'Generando PDF…', _doDownloadReportPDF);
}
async function _doDownloadReportPDF() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const ts = today();
    const ad = S.orders.filter(o => o.status === 'delivered' && o.paymentMethod);
    const monthO = ad.filter(o => o.createdAt >= ts - 29 * dayMs);

    if (monthO.length === 0) return toast("No hay datos para exportar", "warning");

    // --- ENCABEZADO ---
    doc.setFillColor(13, 23, 38); // Color azul marino del logo
    doc.rect(0, 0, 210, 40, 'F');
    
    doc.setTextColor(197, 160, 89); // Color dorado
    doc.setFontSize(22);
    doc.setFont("helvetica", "bold");
    doc.text(S.config.name.toUpperCase(), 15, 20);
    
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.text(`REPORTE MENSUAL DE VENTAS`, 15, 30);
    doc.text(`Generado: ${new Date().toLocaleString('es-AR')}`, 140, 30);

    // --- RESUMEN ---
    const totalRev = monthO.reduce((s, o) => s + o.total, 0);
    const totalCost = monthO.reduce((s, o) => s + o.items.reduce((a, i) => {
        const mi = S.menuItems.find(m => m.id === i.id || m.id === i.origId);
        return a + (mi ? mi.cost : 0) * i.qty;
    }, 0), 0);
    const totalProfit = totalRev - totalCost;

    doc.setTextColor(0, 0, 0);
    doc.setFontSize(12);
    doc.text(`RESUMEN FINANCIERO:`, 15, 50);
    
    // Cuadros de resumen
    doc.setDrawColor(200, 200, 200);
    doc.line(15, 52, 195, 52);

    doc.setFontSize(11);
    doc.text(`Ventas Totales:`, 15, 60);
    doc.setFont("helvetica", "bold");
    doc.text(`${fmt(totalRev)}`, 50, 60);

    doc.setFont("helvetica", "normal");
    doc.text(`Ganancia Bruta:`, 15, 67);
    doc.setTextColor(47, 133, 90); // Verde
    doc.setFont("helvetica", "bold");
    doc.text(`${fmt(totalProfit)}`, 50, 67);

    doc.setTextColor(0,0,0);
    doc.setFont("helvetica", "normal");
    doc.text(`Total Pedidos:`, 120, 60);
    doc.text(`${monthO.length}`, 155, 60);

    // --- TABLA DE DETALLES ---
    const tableData = monthO.map(o => [
        new Date(o.createdAt).toLocaleDateString('es-AR'),
        `#${o.id}`,
        o.type === 'dine-in' ? 'Mesa' : o.type.toUpperCase(),
        o.paymentMethod.toUpperCase(),
        fmt(o.total)
    ]);

    doc.autoTable({
        startY: 75,
        head: [['FECHA', 'ID', 'TIPO', 'PAGO', 'TOTAL']],
        body: tableData,
        headStyles: { fillColor: [197, 160, 89], textColor: [255, 255, 255] },
        alternateRowStyles: { fillColor: [245, 245, 245] },
        margin: { left: 15, right: 15 }
    });

    // --- PIE DE PÁGINA ---
    const pageCount = doc.internal.getNumberOfPages();
    for(let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFontSize(8);
        doc.setTextColor(150, 150, 150);
        const _appVer = window.electronAPI?.appVersion || 'v2.x';
        doc.text(`App creada por PuenteProd - La Mente Maestra v${_appVer}`, 15, 285);
        doc.text(`Página ${i} de ${pageCount}`, 180, 285);
    }

    doc.save(`Reporte_${S.config.name.replace(/\s+/g, '_')}.pdf`);
    toast("PDF generado con éxito", "success");
}

function downloadReportCSV() {
    _withBtnProgress('btn-csv', 'Generando CSV…', _doDownloadReportCSV);
}
async function _doDownloadReportCSV() {
    const ts = today();
    // Filtramos todos los pedidos cobrados del último mes (cualquier tipo: mesa, delivery, takeaway)
    const ad = S.orders.filter(o => o.paymentMethod);
    const monthO = ad.filter(o => o.createdAt >= ts - 29 * dayMs);

    if (monthO.length === 0) {
        return toast("No hay datos para exportar en este período", "warning");
    }

    // Definir los encabezados del CSV
    let csvContent = "Fecha,Pedido ID,Tipo,Mesa/Ref,Metodo Pago,Total,Ganancia Est.\n";

    // Recorrer los pedidos y armar las filas
    monthO.forEach(o => {
        const date = new Date(o.createdAt).toLocaleDateString('es-AR');
        const typeMap = { 'dine-in': 'Mesa', 'delivery': 'Delivery', 'takeaway': 'Para llevar' };
        const type = typeMap[o.type] || o.type?.toUpperCase() || 'N/A';
        const ref = o.type === 'dine-in' ? (o.tableId || 'N/A') : (o.customerName || o.address || 'N/A');
        
        // Calcular costo para obtener ganancia aproximada
        const orderCost = o.items.reduce((acc, i) => {
            const mi = S.menuItems.find(m => m.id === i.id || m.id === i.origId);
            return acc + (mi ? mi.cost : 0) * i.qty;
        }, 0);
        const profit = o.total - orderCost;

        csvContent += `${date},#${o.id},${type},${ref},${o.paymentMethod},${o.total},${profit}\n`;
    });

    // Crear el archivo y disparar la descarga
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    
    link.setAttribute("href", url);
    link.setAttribute("download", `Reporte_Financiero_${S.config.name.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    toast("Reporte descargado correctamente");
}

function printReport() {
  // Feedback inmediato en el botón mientras se construye el HTML del reporte
  const btn = document.getElementById('btn-print-report');
  const original = btn ? btn.innerHTML : null;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="material-symbols-rounded" style="animation:spin-lazy 1s linear infinite;font-size:16px">progress_activity</span> Preparando…';
  }
  // Ceder el hilo al navegador antes de computar el HTML
  setTimeout(function () {
    try {
      _doPrintReport();
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = original;
      }
    }
  }, 50);
}
function _doPrintReport() {
  var ts = today();
  var ad = S.orders.filter(function (o) { return o.status === 'delivered' && o.paymentMethod; });
  var todayO = ad.filter(function (o) { return o.createdAt >= ts; });
  var weekO = ad.filter(function (o) { return o.createdAt >= ts - 6 * dayMs; });
  var monthO = ad.filter(function (o) { return o.createdAt >= ts - 29 * dayMs; });
  var todayR = todayO.reduce(function (s, o) { return s + o.total; }, 0);
  var weekR = weekO.reduce(function (s, o) { return s + o.total; }, 0);
  var monthR = monthO.reduce(function (s, o) { return s + o.total; }, 0);
  function cc(orders) { return orders.reduce(function (s, o) { return s + o.items.reduce(function (a, i) { var mi = S.menuItems.find(function (m) { return m.id === i.id; }); return a + (mi ? mi.cost : (i.cost || 0)) * i.qty; }, 0); }, 0); }
  var monthCost = cc(monthO);
  var monthProfit = monthR - monthCost;
  var monthMargin = monthR > 0 ? Math.round(monthProfit / monthR * 100) : 0;
  var bym = { cash: 0, card: 0, transfer: 0 };
  monthO.forEach(function (o) { bym[o.paymentMethod] = (bym[o.paymentMethod] || 0) + o.total; });
  var ps = {};
  monthO.forEach(function (o) { o.items.forEach(function (i) {
    if (!ps[i.name]) ps[i.name] = { qty: 0, revenue: 0, cost: 0 };
    var mi = S.menuItems.find(function (m) { return m.id === i.id; });
    ps[i.name].qty += i.qty;
    ps[i.name].revenue += (i.lineTotal || i.price * i.qty);
    ps[i.name].cost += (mi ? mi.cost : (i.cost || 0)) * i.qty;
  }); });
  var top = Object.entries(ps).sort(function (a, b) { return b[1].revenue - a[1].revenue; }).slice(0, 10);
  var rows = '';
  top.forEach(function (entry, i) {
    var name = entry[0]; var s = entry[1];
    var g = s.revenue - s.cost; var m = s.revenue > 0 ? Math.round(g / s.revenue * 100) : 0;
    rows += '   <td><b>' + (i + 1) + '</b>   <td>' + name + '   <td>' + s.qty + '   <td><b>' + fmt(s.revenue) + '</b>   <td style="color:#c53030">' + fmt(s.cost) + '   <td style="color:#276749;font-weight:700">' + fmt(g) + '   <td>' + (m >= 50 ? '<span style="color:#276749">' : '<span style="color:#c53030">') + m + '%</span>   ';
  });
  var now2 = new Date();
  var body = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Reporte ' + S.config.name + '</title>'
    + '<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:Arial,sans-serif;background:#fff;color:#111;padding:28px;font-size:13px;}'
    + '.hdr{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:14px;border-bottom:3px solid #e53e3e;}'
    + '.hdr h1{font-size:22px;font-weight:800;color:#e53e3e;}'
    + '.sec{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#e53e3e;margin:20px 0 10px;padding-bottom:5px;border-bottom:1px solid #eee;}'
    + '.srow{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px;}'
    + '.sbox{background:#f9f9f9;border:1px solid #eee;border-radius:6px;padding:12px;text-align:center;}'
    + '.sbox .v{font-size:16px;font-weight:800;} .sbox .l{font-size:10px;color:#888;margin-top:3px;}'
    + '.fg{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px;}'
    + '.fc{background:#f9f9f9;border-left:3px solid #e53e3e;padding:10px 12px;border-radius:0 6px 6px 0;}'
    + '.fc .t{font-size:10px;color:#888;} .fc .a{font-size:15px;font-weight:800;}'
    + '.pr{display:flex;gap:10px;margin-bottom:16px;}'
    + '.pb{flex:1;background:#f9f9f9;border-radius:6px;padding:10px;text-align:center;border:1px solid #eee;}'
    + '.pb .a{font-size:14px;font-weight:700;} .pb .l{font-size:10px;color:#888;margin-top:3px;}'
    + 'table{width:100%;border-collapse:collapse;} th{text-align:left;padding:7px 8px;font-size:10px;text-transform:uppercase;background:#f0f0f0;border-bottom:2px solid #e53e3e;}'
    + 'td{padding:7px 8px;border-bottom:1px solid #f0f0f0;font-size:12px;} tr:nth-child(even) td{background:#fafafa;}'
    + '.ftr{margin-top:24px;padding-top:12px;border-top:1px solid #eee;text-align:center;color:#999;font-size:10px;}'
    + '@media print{body{padding:12px;}@page{margin:1.5cm;}}</style></head><body>'
    + '<div class="hdr"><div><h1>' + S.config.name + '</h1>'
    + '<div style="font-size:11px;color:#666;margin-top:4px">' + (S.config.address || '') + (S.config.phone ? ' &middot; ' + S.config.phone : '') + '</div>'
    + '<div style="font-size:12px;font-weight:700;margin-top:6px;color:#e53e3e">REPORTE FINANCIERO &mdash; &Uacute;LTIMOS 30 D&Iacute;AS</div></div>'
    + '<div style="text-align:right;font-size:11px;color:#666">Generado: ' + now2.toLocaleString('es-AR') + '<br>Pedidos cobrados: <b>' + monthO.length + '</b></div></div>'
    + '<div class="sec">Resumen General</div>'
    + '<div class="srow">'
    + '<div class="sbox"><div class="v">' + fmt(todayR) + '</div><div class="l">Ventas Hoy</div></div>'
    + '<div class="sbox"><div class="v">' + fmt(weekR) + '</div><div class="l">Esta Semana</div></div>'
    + '<div class="sbox"><div class="v">' + fmt(monthR) + '</div><div class="l">Este Mes</div></div>'
    + '<div class="sbox"><div class="v" style="color:' + (monthProfit >= 0 ? '#276749' : '#c53030') + '">' + fmt(monthProfit) + '</div><div class="l">Ganancia del Mes</div></div>'
    + '</div>'
    + '<div class="sec">Desglose Financiero del Mes</div>'
    + '<div class="fg">'
    + '<div class="fc"><div class="t">Ingresos Brutos</div><div class="a">' + fmt(monthR) + '</div></div>'
    + '<div class="fc" style="border-left-color:#c53030"><div class="t">Costos de Productos</div><div class="a" style="color:#c53030">' + fmt(monthCost) + '</div></div>'
    + '<div class="fc" style="border-left-color:#276749"><div class="t">Ganancia Bruta</div><div class="a" style="color:#276749">' + fmt(monthProfit) + '</div></div>'
    + '<div class="fc"><div class="t">Margen Bruto</div><div class="a">' + monthMargin + '%</div></div>'
    + '<div class="fc"><div class="t">Ticket Promedio</div><div class="a">' + (monthO.length ? fmt(Math.round(monthR / monthO.length)) : '—') + '</div></div>'
    + '<div class="fc"><div class="t">Total Pedidos</div><div class="a">' + monthO.length + '</div></div>'
    + '</div>'
    + '<div class="sec">Metodos de Pago</div>'
    + '<div class="pr">'
    + '<div class="pb"><div class="a">' + fmt(bym.cash || 0) + '</div><div class="l">Efectivo</div></div>'
    + '<div class="pb"><div class="a">' + fmt(bym.card || 0) + '</div><div class="l">Tarjeta</div></div>'
    + '<div class="pb"><div class="a">' + fmt(bym.transfer || 0) + '</div><div class="l">Transferencia</div></div>'
    + '</div>'
    + '<div class="sec">Top Productos del Mes</div>'
    + '<table><thead><tr><th>#</th><th>Producto</th><th>Cant</th><th>Ingresos</th><th>Costo</th><th>Ganancia</th><th>Margen</th></tr></thead><tbody>' + rows + '</tbody></table>'
    + '<div class="ftr">' + S.config.name + ' &mdash; Reporte generado por La Mente Maestra &mdash; ' + now2.toLocaleDateString('es-AR') + '</div>'
    + '</body></html>';
  var pw = window.open('', '_blank', 'width=900,height=700');
  if (!pw) { toast('Activá los popups para imprimir el reporte', 'warning'); return; }
  pw.document.write(body);
  pw.document.close();
  toast('Abriendo diálogo de impresión…', 'success');
  setTimeout(function () { pw.print(); }, 500);
}
function showSalesDetail(period) {
  window._salesPeriod = period || 'today';
  _renderSalesModal();
}
function _renderSalesModal() {
  const period = window._salesPeriod || 'today';
  const ts = today();
  const ranges = {
    today: { start: ts, label: 'Hoy', days: 1 },
    week: { start: ts - 6 * dayMs, label: 'Esta Semana', days: 7 },
    month: { start: ts - 29 * dayMs, label: 'Este Mes', days: 30 }
  };
  const { start, label } = ranges[period];
  
  const allPaid = S.orders.filter(o => o.status === 'delivered' && o.paymentMethod);
  const orders = allPaid.filter(o => o.createdAt >= start).sort((a, b) => b.createdAt - a.createdAt);
  
  const total = orders.reduce((s, o) => s + o.total, 0);
  const cost = orders.reduce((s, o) => s + o.items.reduce((a, i) => a + (i.cost || 0) * i.qty, 0), 0);
  const byMethod = { cash: 0, card: 0, transfer: 0 };
  orders.forEach(o => { byMethod[o.paymentMethod] = (byMethod[o.paymentMethod] || 0) + o.total; });

  const tabs = ['today', 'week', 'month'].map(p => `
    <button onclick="window._salesPeriod='${p}';_renderSalesModal()" class="btn-chart-filter ${p === period ? 'active' : ''}" style="flex:1">
      ${{ today: 'Hoy', week: 'Semana', month: 'Mes' }[p]}
    </button>`).join('');

  const body = `
    <!-- TABS SUPERIORES -->
    <div style="display:flex; gap:6px; margin-bottom:16px; background:var(--bg3); padding:5px; border-radius:12px">${tabs}</div>
    
    <!-- RESUMEN DE VENTAS -->
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:15px">
      <div style="background:var(--bg3); padding:15px; border-radius:12px; text-align:center">
        <div style="font-size:1.4rem; font-weight:800; color:var(--accent)">${fmt(total)}</div>
        <div style="font-size:.65rem; color:var(--text3); text-transform:uppercase; font-weight:700">Ingresos Totales</div>
      </div>
      <div style="background:rgba(34,197,94,0.08); padding:15px; border-radius:12px; text-align:center; border:1px solid rgba(34,197,94,0.1)">
        <div style="font-size:1.4rem; font-weight:800; color:var(--green)">${fmt(total - cost)}</div>
        <div style="font-size:.65rem; color:var(--text3); text-transform:uppercase; font-weight:700">Ganancia Est.</div>
      </div>
    </div>

    <!-- MÉTODOS DE PAGO -->
    <div style="display:flex; gap:8px; margin-bottom:20px">
        <div style="flex:1; background:var(--bg3); padding:10px; border-radius:10px; text-align:center">
            <div style="font-size:0.85rem; font-weight:800; color:var(--text)">${fmt(byMethod.cash || 0)}</div>
            <div style="font-size:0.6rem; color:var(--text3); font-weight:700">EFECTIVO</div>
        </div>
        <div style="flex:1; background:var(--bg3); padding:10px; border-radius:10px; text-align:center">
            <div style="font-size:0.85rem; font-weight:800; color:var(--text)">${fmt(byMethod.card || 0)}</div>
            <div style="font-size:0.6rem; color:var(--text3); font-weight:700">TARJETA</div>
        </div>
        <div style="flex:1; background:var(--bg3); padding:10px; border-radius:10px; text-align:center">
            <div style="font-size:0.85rem; font-weight:800; color:var(--text)">${fmt(byMethod.transfer || 0)}</div>
            <div style="font-size:0.6rem; color:var(--text3); font-weight:700">TRANSFER.</div>
        </div>
    </div>

    <!-- LISTADO DE ÓRDENES (SIN TABLAS) -->
    <div style="max-height:50vh; overflow-y:auto; padding: 2px; display:flex; flex-direction:column; gap:12px;">
      ${orders.length === 0
        ? '<div style="text-align:center; color:var(--text3); padding:40px">Sin ventas aún</div>'
        : orders.map(o => {
            const typeCfg = {
              'dine-in': { color: '#c5a059', icon: 'table_restaurant', label: 'Mesa ' + (() => { const _t = S.tables.find(t => t.id === o.tableId); return _t?.numero || o.tableId || '-'; })() },
              'delivery': { color: '#3b82f6', icon: 'moped', label: 'Delivery' },
              'takeaway': { color: '#f59e0b', icon: 'shopping_bag', label: 'Llevar' }
            }[o.type] || { color: '#10b981', icon: 'restaurant', label: 'Venta' };

            const payIcon = { cash: 'payments', card: 'credit_card', transfer: 'account_balance' }[o.paymentMethod] || 'sell';

            return `
            <div class="sales-order-card" style="border: 1px solid var(--bg4); border-radius:15px; padding:15px; background:white; display:grid; grid-template-columns: auto 1fr auto; align-items:center; gap:12px; box-shadow: 0 2px 5px rgba(0,0,0,0.02);">
                
                <div style="width:40px; height:40px; border-radius:10px; background:${typeCfg.color}15; color:${typeCfg.color}; display:flex; align-items:center; justify-content:center">
                    <span class="material-symbols-rounded">${typeCfg.icon}</span>
                </div>

                <div style="display:flex; flex-direction:column; gap:2px">
                    <div style="font-weight:800; font-size:0.9rem; color:var(--text)">#${o.id} · ${typeCfg.label}</div>
                    <div style="font-size:0.7rem; color:var(--text3); font-weight:600">
                        ${new Date(o.createdAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})} hs · hace ${getRelativeTime(o.createdAt)}
                    </div>
                </div>

                <div style="text-align:right">
                    <div style="font-weight:900; font-size:1rem; color:var(--text); font-family:'JetBrains Mono'">${fmt(o.total)}</div>
                    <div style="display:flex; align-items:center; justify-content:flex-end; gap:4px; font-size:0.6rem; font-weight:800; color:var(--green)">
                        <span class="material-symbols-rounded" style="font-size:12px">${payIcon}</span> COBRADO
                    </div>
                </div>

                <button class="btn btn-sm btn-secondary" style="grid-column: 1 / -1; width:100%; margin-top:5px; border-radius:10px; justify-content:center" onclick="verTicketDesdeHistorial(${o.id})">
                    <span class="material-symbols-rounded" style="font-size:16px">visibility</span> VER TICKET DETALLADO
                </button>
            </div>`;
          }).join('')}
    </div>`;

  openModal(`Ventas — ${label}`, body, `
    <button class="btn btn-secondary" onclick="closeModal()">Cerrar</button>
    <button class="btn btn-primary" onclick="printReport()"><span class="material-symbols-rounded">print</span> REPORTE COMPLETO</button>
  `);
  setTimeout(() => { $('modal').style.maxWidth = '600px'; }, 10);
}
function verTicketDesdeHistorial(orderId) {
    const o = S.orders.find(x => x.id === orderId);
    if (!o) return;
    closeModal();
    setTimeout(() => {
        printReceipt(o, 0);
    }, 150);
}
let reportsChartInstance = null;
function updateReportsChart() {
    const canvas = document.getElementById('rpt-main-chart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const labels = [];
    const salesData = [];
    const profitData = [];
    for (let i = 13; i >= 0; i--) {
        const day = today() - (i * dayMs);
        labels.push(new Date(day).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' }));
        const dayOrders = S.orders.filter(o => o.createdAt >= day && o.createdAt < day + dayMs && o.status === 'delivered');
        const totalSales = dayOrders.reduce((a, b) => a + b.total, 0);
        salesData.push(totalSales);
        let totalCost = 0;
        dayOrders.forEach(o => {
            o.items.forEach(it => {
                const mi = S.menuItems.find(m => m.id === it.id || m.id === it.origId);
                totalCost += (mi ? mi.cost : 0) * it.qty;
            });
        });
        profitData.push(totalSales - totalCost);
    }
    if (reportsChartInstance) reportsChartInstance.destroy();
    reportsChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Ventas',
                    data: salesData,
                    borderColor: '#c5a059',
                    backgroundColor: 'rgba(197, 160, 89, 0.1)',
                    fill: true,
                    tension: 0.4,
                    borderWidth: 3,
                    pointRadius: 3,
                    pointBackgroundColor: '#c5a059'
                },
                {
                    label: 'Ganancia Bruta',
                    data: profitData,
                    borderColor: '#22c55e',
                    backgroundColor: 'transparent',
                    fill: false,
                    tension: 0.4,
                    borderWidth: 2,
                    borderDash: [5, 5],
                    pointRadius: 0
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: {
                padding: {
                    top: 10,
                    bottom: 0,
                    left: 0,
                    right: 10
                }
            },
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    align: 'end',
                    labels: { color: '#94a3b8', boxWidth: 12, font: { size: 11, weight: '600' } }
                },
                tooltip: {
                    backgroundColor: '#13202E',
                    titleColor: '#c5a059',
                    padding: 12,
                    callbacks: {
                        label: (item) => `${item.dataset.label}: ${fmt(item.parsed.y)}`
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { color: '#94a3b8', maxTicksLimit: 7 }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: '#94a3b8' }
                }
            }
        }
    });
}
// ============================================================
//  HISTORY CON PAGINACIÓN REAL (sin fetch externo)
// ============================================================
window._historyCurrentPage = 1;
const HISTORY_PAGE_SIZE = 15; // Órdenes por página

function renderHistoryFiltered() {
  // Resetea a página 1 cada vez que cambia un filtro
  window._historyCurrentPage = 1;
  renderHistory();
}

async function renderHistory() {
  // 1. Obtener todos los pedidos pagados (dine-in, delivery y takeaway)
  let orders = S.orders.filter(o => o.paymentMethod);
  
  // 2. Aplicar filtros de fecha, mesero y tipo
  const filterDate   = document.getElementById('hist-filter-date')?.value;
  const filterWaiter = document.getElementById('hist-filter-waiter')?.value;
  const filterType   = document.getElementById('hist-filter-type')?.value;

  if (filterDate) {
    orders = orders.filter(o => new Date(o.createdAt).toISOString().split('T')[0] === filterDate);
  }
  if (filterWaiter && filterWaiter !== 'all') {
    orders = orders.filter(o => o.waiterName === filterWaiter);
  }
  if (filterType && filterType !== 'all') {
    orders = orders.filter(o => o.type === filterType);
  }
  
  // 3. Ordenar por fecha descendente (más reciente primero)
  orders.sort((a, b) => b.createdAt - a.createdAt);
  
  // 4. Paginación
  const totalPages = Math.ceil(orders.length / HISTORY_PAGE_SIZE);
  const startIdx = (window._historyCurrentPage - 1) * HISTORY_PAGE_SIZE;
  const endIdx = startIdx + HISTORY_PAGE_SIZE;
  const ordersToShow = orders.slice(startIdx, endIdx);
  
  // 5. Obtener lista de meseros para el filtro
  const waiters = [...new Set(S.orders.filter(o => o.waiterName).map(o => o.waiterName))];
  
  // 6. Generar HTML (igual que antes, pero con paginación y controles)
  $('content').innerHTML = `
    <div class="history-wrapper" style="display: flex; flex-direction: column; gap: 15px;">
        <div class="panel" style="padding: 15px; background: #fff; border-radius: 12px; border: 1px solid var(--bg4);">
            <div style="display: flex; flex-direction: column; gap: 12px;">
                <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                    <div class="form-group" style="margin:0; flex: 1; min-width: 140px;">
                        <label style="font-size: 0.65rem; font-weight: 800; color: var(--text3); text-transform: uppercase;">Fecha</label>
                        <input type="date" id="hist-filter-date" value="${filterDate || ''}" 
                               style="width: 100%; padding: 10px; border-radius: 8px;"
                               onchange="renderHistoryFiltered()">
                    </div>
                    <div class="form-group" style="margin:0; flex: 1; min-width: 140px;">
                        <label style="font-size: 0.65rem; font-weight: 800; color: var(--text3); text-transform: uppercase;">Mesero</label>
                        <select id="hist-filter-waiter" 
                                style="width: 100%; padding: 10px; border-radius: 8px;"
                                onchange="renderHistoryFiltered()">
                            <option value="all">Todos</option>
                            ${waiters.map(w => `<option value="${w}" ${filterWaiter === w ? 'selected' : ''}>${w}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group" style="margin:0; flex: 1; min-width: 140px;">
                        <label style="font-size: 0.65rem; font-weight: 800; color: var(--text3); text-transform: uppercase;">Tipo</label>
                        <select id="hist-filter-type"
                                style="width: 100%; padding: 10px; border-radius: 8px;"
                                onchange="renderHistoryFiltered()">
                            <option value="all">Todos</option>
                            <option value="dine-in" ${filterType === 'dine-in' ? 'selected' : ''}>\xf0\x9f\x8d\xbd\xef\xb8\x8f Mesa</option>
                            <option value="delivery" ${filterType === 'delivery' ? 'selected' : ''}>\xf0\x9f\x9b\xb5 Delivery</option>
                            <option value="takeaway" ${filterType === 'takeaway' ? 'selected' : ''}>\xf0\x9f\x9b\x8d\xef\xb8\x8f Para llevar</option>
                        </select>
                    </div>
                </div>
                <button class="btn btn-secondary w-full" onclick="resetHistoryFilters()" style="justify-content: center;">
                    <span class="material-symbols-rounded">filter_alt_off</span> Limpiar Filtros
                </button>
            </div>
        </div>

        <!-- PAGINACIÓN (encima de la tabla) -->
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap;">
            <div style="font-size: 0.75rem; color: var(--text3);">
                Mostrando ${ordersToShow.length} de ${orders.length} pedidos
            </div>
            <div style="display: flex; gap: 8px;">
                <button class="btn btn-sm btn-secondary" onclick="changeHistoryPage(-1)" 
                    ${window._historyCurrentPage === 1 ? 'disabled' : ''}>
                    <span class="material-symbols-rounded">chevron_left</span> Anterior
                </button>
                <span style="padding: 6px 12px; background: var(--bg3); border-radius: 20px; font-size: 0.75rem;">
                    Página ${window._historyCurrentPage} de ${totalPages || 1}
                </span>
                <button class="btn btn-sm btn-secondary" onclick="changeHistoryPage(1)" 
                    ${window._historyCurrentPage === totalPages || totalPages === 0 ? 'disabled' : ''}>
                    Siguiente <span class="material-symbols-rounded">chevron_right</span>
                </button>
            </div>
        </div>

        <div class="panel" style="padding: 0; background: transparent; border: none;">
            <div style="overflow-x: auto;">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>MESA / FECHA</th>
                            <th>MESERO</th>
                            <th>HORARIO / DURACIÓN</th>
                            <th style="text-align: center;">PAGO</th>
                            <th style="text-align: right;">TOTAL</th>
                            <th style="text-align: right;">VER</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${ordersToShow.length === 0 ? 
                        `<tr><td colspan="6" style="text-align:center; padding:50px; color:var(--text3);">
                            <span class="material-symbols-rounded" style="font-size: 48px; display:block; margin-bottom:10px;">history_toggle_off</span>
                            No hay mesas registradas en el historial
                        </td></tr>` : 
                        ordersToShow.map(o => {
                            const mesa = S.tables.find(t => t.id === o.tableId);
                            const numMesa = mesa ? mesa.numero : (o.tableNumber || o.tableId);
                            const aperturaTs = o.openedAt || (o.createdAt - 1800000);
                            const cierreTs = o.closedAt || o.createdAt;
                            const hApertura = new Date(aperturaTs).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                            const hCierre = new Date(cierreTs).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                            const diffMins = Math.floor((cierreTs - aperturaTs) / 60000);
                            const duracionFinal = diffMins > 0 ? `${diffMins} min.` : 'pocos min.';
                            return `
                            <tr>
                                <td>
                                    <strong style="color:var(--accent); font-size: 1rem;">Mesa ${numMesa}</strong>
                                    <div style="font-size:0.75rem; color:var(--text3); font-weight:600;">${new Date(o.createdAt).toLocaleDateString()}</div>
                                </td>
                                <td data-label="MESERO">
                                    <span class="badge badge-blue" style="font-size: 0.7rem;">${o.waiterName || 'Staff'}</span>
                                </td>
                                <td data-label="HORARIO">
                                    <div style="font-weight:700; color:var(--text); font-size:0.85rem;">
                                        <span style="color:var(--green)">${hApertura}</span> ➔ <span style="color:var(--red)">${hCierre}</span>
                                    </div>
                                    <div style="font-size:0.7rem; color:var(--text3); font-weight:800;">⏱️ Estuvo abierta: ${duracionFinal}</div>
                                </td>
                                <td data-label="PAGO" style="text-align: center;">
                                    <span class="material-symbols-rounded" style="color:var(--text3)">
                                        ${o.paymentMethod === 'cash' ? 'payments' : 'credit_card'}
                                    </span>
                                </td>
                                <td data-label="TOTAL" style="text-align: right;">
                                    <strong style="font-size:1rem; color:var(--green); font-family:'JetBrains Mono'">${fmt(o.total)}</strong>
                                </td>
                                <td style="text-align: right;">
                                    <button class="btn-action" onclick="verTicketDesdeHistorial(${o.id})">
                                        <span class="material-symbols-rounded">visibility</span>
                                    </button>
                                </td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>
        
        <!-- PAGINACIÓN (debajo de la tabla) -->
        <div style="display: flex; justify-content: center; gap: 8px; margin-top: 10px;">
            <button class="btn btn-sm btn-secondary" onclick="changeHistoryPage(-1)" 
                ${window._historyCurrentPage === 1 ? 'disabled' : ''}>
                Anterior
            </button>
            <button class="btn btn-sm btn-secondary" onclick="changeHistoryPage(1)" 
                ${window._historyCurrentPage === totalPages || totalPages === 0 ? 'disabled' : ''}>
                Siguiente
            </button>
        </div>
    </div>`;
}

// Función auxiliar para cambiar de página
function changeHistoryPage(delta) {
    const newPage = window._historyCurrentPage + delta;
    if (newPage < 1) return;
    // No necesitamos calcular totalPages aquí, se recalcula en renderHistory
    window._historyCurrentPage = newPage;
    renderHistory();
}

// Resetear filtros (sin perder la página)
function resetHistoryFilters() {
    window._historyCurrentPage = 1;
    const dateInp = document.getElementById('hist-filter-date');
    const waiterSel = document.getElementById('hist-filter-waiter');
    const typeSel   = document.getElementById('hist-filter-type');
    if (dateInp)  dateInp.value  = '';
    if (waiterSel) waiterSel.value = 'all';
    if (typeSel)  typeSel.value  = 'all';
    renderHistory();
}