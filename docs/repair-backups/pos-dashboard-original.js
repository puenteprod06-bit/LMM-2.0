function renderDashboard(){
const e=today(),a=S.orders.filter(a=>a.createdAt>=e&&"delivered"===a.status&&a.paymentMethod),t=S.orders.filter(a=>a.createdAt>=e-6*dayMs&&"delivered"===a.status&&a.paymentMethod),s=a.reduce((e,a)=>e+a.total,0),n=t.reduce((e,a)=>e+a.total,0),l=S.tables.filter(e=>"occupied"===e.status||"billing"===e.status).length,o=getExpiringItems(),g=a.reduce((acc,ord)=>acc+ord.items.reduce((s,i)=>{const mi=S.menuItems.find(m=>m.id===i.id);return s+(i.lineTotal||i.price*i.qty)-(mi?mi.cost:i.cost||0)*i.qty},0),0);
$("content").innerHTML=`<div class="stats-grid">
    <div class="stat-card" style="cursor:pointer;border-color:rgba(34,197,94,.3)" onclick="showSalesDetail('today')">
      <div class="top"><span class="label">Ventas Hoy</span><div class="icon-box" style="background:rgba(34,197,94,.15);color:var(--green)"><span class="material-symbols-rounded">payments</span></div></div>
      <div class="value">${fmt(s)}</div>
      <div class="change up">${a.length} pedidos · <span style="color:var(--accent)">Ver detalle →</span></div>
      <div style="font-size:0.72rem;color:var(--green);font-weight:700;margin-top:4px"><span class="material-symbols-rounded" style="font-size:13px;vertical-align:middle">trending_up</span> Ganancia estimada: ${fmt(g)}</div>
    </div>
    <div class="stat-card" style="cursor:pointer" onclick="showSalesDetail('week')">
      <div class="top"><span class="label">Esta Semana</span><div class="icon-box" style="background:rgba(59,130,246,.15);color:var(--blue)"><span class="material-symbols-rounded">bar_chart</span></div></div>
      <div class="value">${fmt(n)}</div>
      <div class="change up">${t.length} pedidos · <span style="color:var(--accent)">Ver detalle →</span></div>
    </div>
    <div class="stat-card" style="cursor:pointer" onclick="document.querySelector('[data-page=tables]').click">
      <div class="top">
        <span class="label">Mesas Ocupadas</span>
        <div class="icon-box" style="background:rgba(168,85,247,.15);color:var(--purple)"><span class="material-symbols-rounded">restaurant</span></div>
      </div>
      <div class="value">${l}/${S.tables.filter(e=>!e.isCaja).length}</div>
      <div class="change ${l>0?"up":""}">
        <span class="material-symbols-rounded" style="font-size:14px; vertical-align:middle">cooking</span>
        En cocina: ${S.orders.filter(e=>"pending"===e.status||"preparing"===e.status).length} pedidos
      </div>
    </div>
    <div class="stat-card" style="cursor:pointer" onclick="document.querySelector('[data-page=inventory]').click">
      <div class="top"><span class="label">Alertas</span><div class="icon-box" style="background:rgba(245,158,11,.15);color:var(--accent)">${o.length?'<span class="pulse-dot" style="background:var(--red)"></span>':'<span class="material-symbols-rounded" style="font-size:1rem">check_circle</span>'}</div></div>
      <div class="value" style="color:${o.length?"var(--red)":"var(--green)"};">${o.length}</div>
      <div class="change" style="color:var(--text3)">Productos por vencer</div>
    </div>
  </div>
  <div class="grid-2">
    <div class="panel">
      <div class="panel-header" style="display:flex; justify-content:space-between; align-items:center;">
        <div style="display:flex; align-items:center; gap:8px">
          <span class="panel-title-icon"><span class="material-symbols-rounded">analytics</span></span>
          <h3>Análisis de Ingresos</h3>
        </div>
        <div class="chart-head-actions"><button class="btn btn-sm btn-outline" onclick="forceRefresh()"><span class="material-symbols-rounded" style="font-size:16px">refresh</span> Actualizar</button><div class="chart-filters"><button class="btn-chart-filter" id="filter-today" onclick="updateDashboardChart('today')">Hoy</button><button class="btn-chart-filter" id="filter-week" onclick="updateDashboardChart('week')">Semana</button><button class="btn-chart-filter" id="filter-month" onclick="updateDashboardChart('month')">Mes</button></div></div>
      </div>
      <div class="panel-body">
        <div class="chart-container-dashboard" style="height: 350px; position: relative; width: 100%;">
          <canvas id="main-sales-chart"></canvas>
        </div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-header">
        <div style="display:flex; align-items:center; gap:8px">
          <span class="panel-title-icon"><span class="material-symbols-rounded">history</span></span>
          <h3>Pedidos Recientes</h3>
        </div>
        <button class="btn btn-sm btn-secondary" onclick="showSalesDetail('today')">Ver todos</button>
      </div>
      <div class="panel-body" style="max-height:400px; overflow-y:auto; padding:0;">
        ${S.orders.filter(e=>"cancelled"!==e.status).sort((e,a)=>a.createdAt-e.createdAt).slice(0,10).map(e=>{const a=S.tables.find(a=>a.id===e.tableId),t={"dine-in":{color:"#10b981",icon:"table_restaurant",label:`Mesa ${(a?a.numero:e.tableId)||""}`},delivery:{color:"#3b82f6",icon:"moped",label:"Delivery"},takeaway:{color:"#f59e0b",icon:"shopping_bag",label:"Llevar"}}[e.type]||{color:"#10b981",icon:"restaurant",label:e.type},s={pending:{icon:"schedule",text:"Pendiente"},preparing:{icon:"cooking",text:"Preparando"},ready:{icon:"check_circle",text:"Listo"},delivered:{icon:"payments",text:"Cobrado"}}[e.status]||{icon:"help",text:e.status},n=!!e.paymentMethod;return`<div class="recent-order-row" onclick="openChargeFromKitchen(${e.id})">
                <div class="order-type-indicator" style="background: ${t.color}20; color: ${t.color}"><span class="material-symbols-rounded" style="font-size:18px">${t.icon}</span></div>
                <div style="flex:1">
                  <div style="display:flex; align-items:center; gap:6px">
                    <span style="font-weight:800;font-size:0.85rem">#${e.id}</span>
                    <span style="font-size:0.7rem; color:var(--text3)">hace ${getRelativeTime(e.createdAt)}</span>
                  </div>
                  <div style="font-size:0.75rem; color:var(--text2)">${t.label} · ${e.items.length} items</div>
                </div>
                <div style="text-align:right">
                  <div style="font-weight:700;font-size:0.85rem">${fmt(e.total)}</div>
                  <div style="display:inline-flex; align-items:center; justify-content:flex-end; gap:3px;font-size:0.65rem;font-weight:800;padding:3px 9px;border-radius:20px;background:${n?"rgba(16,185,129,.12)":"rgba(148,163,184,.12)"};border:1px solid ${n?"rgba(16,185,129,.3)":"rgba(148,163,184,.25)"};box-shadow:${n?"0 0 8px rgba(16,185,129,.25)":"none"};color:${n?"#10b981":"var(--text3)"}"><span class="material-symbols-rounded" style="font-size:12px">${n?"check_circle":s.icon}</span>${n?"COBRADO":s.text.toUpperCase()}</div>
                </div>
              </div>`}).join("")}
      </div>
    </div>
  </div>}`function updateDashboardChart(e){
const a=document.getElementById("main-sales-chart");if(!a)return console.warn("Canvas 'main-sales-chart' no encontrado, reintentando en 100ms..."),void setTimeout(()=>updateDashboardChart(e),100);document.querySelectorAll(".btn-chart-filter").forEach(e=>e.classList.remove("active"));const t=document.getElementById("filter-"+e);t&&t.classList.add("active");const s=a.getContext("2d"),n=getSalesDataForRange(e);mainChartInstance&&mainChartInstance.destroy();const _dk="dark"===document.documentElement.getAttribute("data-theme"),_tick=_dk?"#aeb8cc":"#4a5568",_grid=_dk?"rgba(255,255,255,.07)":"rgba(0,0,0,.07)",_h=a.parentElement.clientHeight||320,_chartGrad=s.createLinearGradient(0,0,0,_h);_chartGrad.addColorStop(0,"rgba(214,173,104,.45)"),_chartGrad.addColorStop(.6,"rgba(214,173,104,.12)"),_chartGrad.addColorStop(1,"rgba(214,173,104,0)");const _glow={id:"lineGlow",beforeDatasetDraw(c,r){if(0!==r.index)return;const x=c.ctx;x.save(),x.shadowColor="rgba(214,173,104,.55)",x.shadowBlur=14,x.shadowOffsetY=4},afterDatasetDraw(c,r){0===r.index&&c.ctx.restore()}};mainChartInstance=new Chart(s,{type:"line",plugins:[_glow],data:{labels:n.labels,datasets:[{label:"Ventas Actuales",data:n.current,orderColor:"#D6AD68",backgroundColor:_chartGrad,fill:!0,tension:.4,borderWidth:3,pointRadius:0,pointHoverRadius:6,pointHitRadius:14,pointBackgroundColor:"#D6AD68",pointBorderColor:"#fff",pointBorderWidth:2},{label:"Período Anterior",data:n.comparison,borderColor:"rgba(148,163,184,.55)",borderDash:[6,6],borderWidth:2,fill:!1,tension:.4,pointRadius:0,pointHoverRadius:4}]},options:{responsive:!0,maintainAspectRatio:!1,interaction:{mode:"index",intersect:!1},animation:{duration:700,easing:"easeOutQuart"},plugins:{legend:{position:"top",align:"end",labels:{color:_tick,usePointStyle:!0,pointStyle:"circle",boxWidth:8,boxHeight:8,padding:16,font:{size:11,weight:"600"}}},tooltip:{backgroundColor:"rgba(10,15,24,.88)",titleColor:"#D6AD68",bodyColor:"#e8ecf4",borderColor:"rgba(214,173,104,.35)",borderWidth:1,padding:12,cornerRadius:12,boxPadding:6,usePointStyle:!0,callbacks:{label:e=>` ${e.dataset.label}: ${fmt(e.parsed.y)}"}}},scales:{y:{beginAtZero:!0,grid:{color:_grid,drawBorder:!1},border:{display:!1},ticks:{color:_tick,font:{size:10},padding:8,callback:e=>fmt(e)}},x:{grid:{display:!1},border:{display:!1},ticks:{color:_tick,font:{size:10},padding:6}}}}}),setTimeout(()=>{window.positionChartPulseDot&&window.positionChartPulseDot()},550)}let mainChartInstance=null;function getSalesDataForRange(e){const a=today();let t=[],s=[],n=[];const l=(e,a)=>S.orders.filter(t=>{const s=Number(t.createdAt);return s>=e&&s<a&&("delivered"===t.status||t.paymentMethod)}).reduce((e,a)=>e+Number(a.total),0);if("today"===e)for(let e=0;e<12;e++){const o=a+e*(dayMs/12);t.push(2*e+"h"),s.push(l(o,o+dayMs/12)),n.push(l(o-dayMs,o-dayMs+dayMs/12))}else if("week"===e)for(let e=6;e>=0;e--){const o=a-e*dayMs;t.push(new Date(o).toLocaleDateString("es-AR",{weekday:"short"})) ,s.push(l(o,o+dayMs)),n.push(l(o-7*dayMs,o-7*dayMs+dayMs))}else for(let e=29;e>=0;e--){const o=a-e*dayMs;e%5==0?t.push(new Date(o).toLocaleDateString("es-AR",{day:"numeric",month:"short"})):t.push(""),s.push(l(o,o+dayMs)),n.push(l(o-30*dayMs,o-30*dayMs+dayMs))}return{labels:t,current:s,comparison:n}}// Nuevas funciones para evitar recargas innecesas
function updateStatValor(id, valor){const el=$(`[data-stat=${id}]`);if(el){el.textContent=valor}}function updateStatCambio(id, cantidad, texto, color){const el=$(`.stat-card.change[data-stat=${id}]`);if(el){el.innerHTML=`<div class="change ${color}">${cantidad} ${texto}</div>`}}function updateStatGanancia(valor){const el=$(`[data-stat="ganancia"]`);if(el){el.textContent=valor}}function updateAlertasExpiring(items){const el=$("alertas");if(el){el.innerHTML=items.length?'<span class="pulse-dot" style="background:var(--red)"></span>':'<span class="material-symbols-rounded" style="font-size:1rem">check_circle</span>';el.style.color=items.length?"var(--red)":"var(--green)"}}function updateChartData(chartInstance, range){if(!chartInstance)return;const n=getSalesDataForRange(range);chartInstance.data.labels=n.labels;chartInstance.data.datasets[0].data=n.current;chartInstance.data.datasets[1].data=n.comparison;chartInstance.update({duration:500})}// Reutilizar la función existente de formateo y hoy
function today(){const t=new Date;return new Date(t.getFullYear(),t.getMonth(),t.getDate()).getTime()}const dayMs=864e5;// El setTimeout auto de 200ms fue movido al final de renderDashboard// Ahora las actualizaciones vienen vía Socket.IO o al hacer clic en "Actualizar"