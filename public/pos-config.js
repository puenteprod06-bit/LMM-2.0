// ============================================================
//  pos-config.js — CONFIGURACIÓN DEL SISTEMA (v3 — Tab Nav)
// ============================================================

let _settingsActiveTab = 'negocio';

// Alias corto de escapeHtml (definido en pos-utils.js, cargado antes) para
// sanitizar valores de usuario al insertarlos en atributos HTML / innerHTML.
function esc(v) { return typeof escapeHtml === 'function' ? escapeHtml(v) : String(v == null ? '' : v); }

const _CFG_STYLES = `<style id="cfg-styles">
.cfg-shell{display:flex;gap:0;min-height:calc(100vh - 100px);background:var(--bg1);border-radius:18px;overflow:hidden;border:1px solid var(--bg4);}
.cfg-nav{width:190px;min-width:170px;flex-shrink:0;display:flex;flex-direction:column;gap:3px;padding:16px 10px;background:var(--bg2);border-right:1px solid var(--bg4);overflow-y:auto;}
.cfg-nav-section{font-size:.58rem;font-weight:800;letter-spacing:1.2px;color:var(--text3);text-transform:uppercase;margin:10px 0 3px 8px;}
.cfg-nav-section:first-child{margin-top:2px;}
.cfg-nav-btn{display:flex;align-items:center;gap:9px;padding:9px 12px;border-radius:10px;font-size:.8rem;font-weight:600;color:var(--text2);background:transparent;border:none;cursor:pointer;text-align:left;width:100%;transition:background .15s,color .15s;}
.cfg-nav-btn:hover{background:var(--bg3);color:var(--text);}
.cfg-nav-btn.active{background:var(--accent);color:#fff;}
.cfg-nav-btn .material-symbols-rounded{font-size:1.05rem;flex-shrink:0;}
.cfg-nav-btn .cfg-prox{margin-left:auto;font-size:.52rem;font-weight:800;padding:2px 5px;border-radius:4px;background:var(--bg4);color:var(--accent);letter-spacing:.5px;}
.cfg-nav-btn.active .cfg-prox{background:rgba(255,255,255,.2);color:#fff;}
.cfg-main{flex:1;padding:22px 26px;min-width:0;overflow-y:auto;}
.cfg-tab-hd{margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--bg4);}
.cfg-tab-hd h2{font-size:1.2rem;font-weight:800;color:var(--text);display:flex;align-items:center;gap:10px;margin:0;}
.cfg-tab-hd h2 .material-symbols-rounded{color:var(--accent);font-size:1.3rem;}
.cfg-tab-hd p{font-size:.78rem;color:var(--text3);margin:5px 0 0 0;}
.cfg-card{background:var(--bg2);border:1px solid var(--bg4);border-radius:14px;overflow:hidden;margin-bottom:16px;}
.cfg-card-hd{display:flex;align-items:center;gap:10px;padding:13px 16px;background:var(--bg3);border-bottom:1px solid var(--bg4);}
.cfg-card-hd .material-symbols-rounded{font-size:1rem;color:var(--accent);}
.cfg-card-hd h3{font-size:.85rem;font-weight:700;color:var(--text);margin:0;}
.cfg-card-bd{padding:16px;}
.cfg-grid-2{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
.cfg-toggle-row{display:flex;align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--bg4);}
.cfg-toggle-row:last-child{border-bottom:none;padding-bottom:0;}
.cfg-toggle-row__info{flex:1;padding-right:14px;}
.cfg-toggle-row__lbl{font-size:.83rem;font-weight:600;color:var(--text);}
.cfg-toggle-row__desc{font-size:.7rem;color:var(--text3);margin-top:2px;}
.cfg-toggle{width:40px;height:22px;border-radius:11px;background:var(--bg4);border:none;cursor:pointer;position:relative;transition:background .2s;flex-shrink:0;}
.cfg-toggle.on{background:var(--accent);}
.cfg-toggle::after{content:'';position:absolute;width:16px;height:16px;border-radius:50%;background:#fff;top:3px;left:3px;transition:transform .2s;box-shadow:0 1px 3px rgba(0,0,0,.3);}
.cfg-toggle.on::after{transform:translateX(18px);}
.cfg-coming{text-align:center;padding:50px 20px;}
.cfg-coming .ci{font-size:3rem;margin-bottom:14px;}
.cfg-coming h3{font-size:1.3rem;font-weight:800;color:var(--text);margin-bottom:8px;}
.cfg-coming p{font-size:.82rem;color:var(--text3);max-width:300px;margin:0 auto 16px;}
.cfg-coming-badge{display:inline-block;padding:6px 18px;border-radius:20px;background:var(--bg3);border:1px solid var(--bg4);font-size:.68rem;font-weight:800;letter-spacing:1.2px;color:var(--accent);text-transform:uppercase;}
.perm-table{width:100%;border-collapse:collapse;}
.perm-table th,.perm-table td{padding:9px 10px;text-align:center;font-size:.78rem;border-bottom:1px solid var(--bg4);}
.perm-table th{font-weight:700;color:var(--text3);font-size:.68rem;background:var(--bg3);}
.perm-table td:first-child{text-align:left;font-weight:600;color:var(--text);padding-left:0;}
.perm-table tr:last-child td{border-bottom:none;}
.perm-table input[type=checkbox]{width:17px;height:17px;accent-color:var(--accent);cursor:pointer;}
.disc-item{display:flex;align-items:center;gap:10px;padding:10px 13px;background:var(--bg3);border-radius:10px;border:1px solid var(--bg4);margin-bottom:8px;}
.disc-item__name{flex:1;font-weight:600;font-size:.83rem;}
.disc-item__val{font-size:.78rem;font-weight:700;color:var(--accent);background:var(--bg4);padding:3px 10px;border-radius:6px;}
.shift-item{display:flex;align-items:center;gap:10px;padding:11px 13px;background:var(--bg3);border-radius:10px;border:1px solid var(--bg4);margin-bottom:8px;}
.shift-item__name{flex:1;font-weight:600;font-size:.83rem;}
.shift-item__time{font-size:.72rem;color:var(--text3);}
.caja-status{display:inline-flex;align-items:center;gap:8px;padding:10px 16px;border-radius:10px;font-weight:700;font-size:.85rem;margin-bottom:14px;}
.caja-status.abierta{background:rgba(34,197,94,.1);color:var(--green);border:1px solid rgba(34,197,94,.3);}
.caja-status.cerrada{background:rgba(239,68,68,.1);color:var(--red);border:1px solid rgba(239,68,68,.3);}
.hours-grid{display:grid;gap:8px;}
.hours-row{display:grid;grid-template-columns:85px 1fr 12px 1fr auto;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--bg4);}
.hours-row:last-child{border-bottom:none;}
.hours-row__day{font-weight:700;font-size:.82rem;}
.hours-row input[type=time]{padding:6px 8px;border-radius:8px;font-size:.8rem;background:var(--bg3);border:1px solid var(--bg4);color:var(--text);width:100%;}
@media(max-width:768px){
  .cfg-shell{flex-direction:column;}
  .cfg-nav{width:100%;flex-direction:row;flex-wrap:wrap;border-right:none;border-bottom:1px solid var(--bg4);padding:10px;}
  .cfg-nav-section{display:none;}
  .cfg-grid-2{grid-template-columns:1fr;}
  .hours-row{grid-template-columns:65px 1fr 8px 1fr auto;}
}
</style>`;

// ─── Render principal ─────────────────────────────────────────
function renderSettings() {
  const appVersion = window.electronAPI?.appVersion || 'dev';
  if (!document.getElementById('cfg-styles')) {
    document.head.insertAdjacentHTML('beforeend', _CFG_STYLES);
  }
  $('content').innerHTML = `
    <div class="cfg-shell">
      <nav class="cfg-nav">
        <div class="cfg-nav-section">General</div>
        ${_cfgBtn('negocio',   'storefront',      'Negocio')}
        ${_cfgBtn('finanzas',  'account_balance', 'Finanzas')}
        <div class="cfg-nav-section">Operaciones</div>
        ${_cfgBtn('seguridad', 'lock',            'Seguridad')}
        ${_cfgBtn('ventas',    'sell',            'Ventas')}
        ${_cfgBtn('ticket',    'receipt_long',    'Ticket')}
        ${_cfgBtn('operacion', 'schedule',        'Operación')}
        <div class="cfg-nav-section">Integraciones</div>
        ${_cfgBtn('integraciones', 'hub', 'Integraciones')}
        <div class="cfg-nav-section">Sistema</div>
        ${_cfgBtn('datos',     'database',        'Datos')}
      </nav>
      <div class="cfg-main" id="cfg-tab-content"></div>
    </div>
    <div style="text-align:center;opacity:.4;padding:16px 0 8px;font-size:.68rem;letter-spacing:.5px;">
      LA MENTE MAESTRA POS &nbsp;·&nbsp; v${appVersion} &nbsp;·&nbsp; &copy; ${new Date().getFullYear()} Puenteprod
    </div>`;
  _cfgSwitch(_settingsActiveTab);
}

function _cfgBtn(id, icon, label, prox = false) {
  return `<button class="cfg-nav-btn ${_settingsActiveTab===id?'active':''}"
    data-cfg-tab="${id}" onclick="_cfgSwitch('${id}')">
    <span class="material-symbols-rounded">${icon}</span>
    <span>${label}</span>
    ${prox ? '<span class="cfg-prox">PRONTO</span>' : ''}
  </button>`;
}

function _cfgSwitch(tab) {
  _settingsActiveTab = tab;
  document.querySelectorAll('.cfg-nav-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.cfgTab === tab)
  );
  const el = document.getElementById('cfg-tab-content');
  if (!el) return;
  switch (tab) {
    case 'negocio':   el.innerHTML = _tabNegocio();   break;
    case 'finanzas':  el.innerHTML = _tabFinanzas();  break;
    case 'seguridad': el.innerHTML = _tabSeguridad(); setTimeout(_loadSecConfig,    0); break;
    case 'ventas':    el.innerHTML = _tabVentas();    setTimeout(_loadVentasConfig, 0); break;
    case 'ticket':    el.innerHTML = _tabTicket();    setTimeout(() => { loadPrinterConfig(); _loadTicketConfig(); }, 0); break;
    case 'operacion': el.innerHTML = _tabOperacion(); setTimeout(_loadOperConfig,   0); break;
    case 'integraciones': el.innerHTML = _tabIntegraciones(); setTimeout(loadMpConfig, 100); setTimeout(_loadSyncStatus, 100); break;
    case 'datos':     el.innerHTML = _tabDatos();     break;
  }
}

// ─── Layout helpers ───────────────────────────────────────────
function _cfgTabHd(icon, title, desc = '') {
  return `<div class="cfg-tab-hd">
    <h2><span class="material-symbols-rounded">${icon}</span>${title}</h2>
    ${desc ? `<p>${desc}</p>` : ''}
  </div>`;
}
function _cfgCard(icon, title, body) {
  return `<div class="cfg-card">
    <div class="cfg-card-hd"><span class="material-symbols-rounded">${icon}</span><h3>${title}</h3></div>
    <div class="cfg-card-bd">${body}</div>
  </div>`;
}
function _cfgToggleRow(label, desc, checked, onchange) {
  const id = 'tgl_' + Math.random().toString(36).slice(2,8);
  return `<div class="cfg-toggle-row">
    <div class="cfg-toggle-row__info">
      <div class="cfg-toggle-row__lbl">${label}</div>
      ${desc ? `<div class="cfg-toggle-row__desc">${desc}</div>` : ''}
    </div>
    <button id="${id}" class="cfg-toggle ${checked?'on':''}"
      onclick="this.classList.toggle('on');${onchange}"></button>
  </div>`;
}

// ═══════════════════════════════════════════════════════════════
//  TAB: NEGOCIO
// ═══════════════════════════════════════════════════════════════
function _tabNegocio() {
  const reg = JSON.parse(localStorage.getItem('mente_maestra_registration') || '{}');
  const initial = reg.name ? reg.name.charAt(0).toUpperCase() : '?';
  const currentTheme = ThemeManager.getPreference();
  return `
    ${_cfgTabHd('storefront','Negocio','Identidad, apariencia y perfil de acceso del local.')}
    ${_cfgCard('storefront','Identidad del Negocio',`
      <div class="form-group" style="margin-bottom:16px">
        <p style="margin-bottom:8px;font-size:.8rem;font-weight:700">Logo del Menú Lateral</p>
        <div class="logo-settings-wrapper">
          <div class="logo-preview-container">
            <img id="settings-logo-preview" src="${S.config.logo||'logo.ico'}" alt="Logo">
          </div>
          <div class="logo-controls-content">
            <div class="logo-actions-group">
              <input type="file" id="logo-upload-input" accept="image/*" style="display:none" onchange="handleLogoUpload(this)">
              <button class="btn btn-secondary btn-sm" onclick="$('logo-upload-input').click()">
                <span class="material-symbols-rounded">upload</span> Cambiar Imagen
              </button>
              ${S.config.logo ? `<button class="btn btn-danger btn-sm" onclick="removeLogo()">
                <span class="material-symbols-rounded">delete</span> Eliminar
              </button>` : ''}
            </div>
            <p class="logo-helper-text">Se recomienda una imagen cuadrada PNG con fondo transparente.</p>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label for="cfg-name">Nombre del Restaurante</label>
        <input id="cfg-name" value="${esc(S.config.name)}"
          onchange="updateState('config.name',this.value,'pos-config');saveState();saveConfigServer();toast('Nombre actualizado')">
      </div>
      <div class="form-group">
        <label for="cfg-address">Dirección Física</label>
        <input id="cfg-address" value="${esc(S.config.address)}"
          onchange="updateState('config.address',this.value,'pos-config');saveState();saveConfigServer();toast('Dirección actualizada')">
      </div>
      <div class="form-group">
        <label for="cfg-phone">Teléfono de Contacto</label>
        <input id="cfg-phone" value="${esc(S.config.phone)}"
          onchange="updateState('config.phone',this.value,'pos-config');saveState();saveConfigServer();toast('Teléfono actualizado')">
      </div>
    `)}
    ${_cfgCard('palette','Apariencia',`
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
        <div>
          <div style="font-size:.85rem;font-weight:600;color:var(--text)">Tema de la interfaz</div>
          <div style="font-size:.72rem;color:var(--text3);margin-top:3px">"Automático" sigue la configuración del sistema en tiempo real.</div>
        </div>
        <select id="theme-selector" class="settings-select" style="min-width:180px"
          onchange="ThemeManager.setPreference(this.value);toast('Tema actualizado')">
          <option value="auto"  ${currentTheme==='auto' ?'selected':''}>🌗 Automático</option>
          <option value="light" ${currentTheme==='light'?'selected':''}>☀️ Claro</option>
          <option value="dark"  ${currentTheme==='dark' ?'selected':''}>🌙 Oscuro</option>
        </select>
      </div>
    `)}
    ${_cfgCard('person','Mi Perfil de Acceso',`
      <div class="user-profile-box" style="margin-bottom:14px">
        <div class="user-profile-avatar">${initial}</div>
        <div>
          <div style="font-weight:800;font-size:1.05rem">${reg.name||'—'}</div>
          <div style="font-size:.78rem;opacity:.8">${reg.email||'Staff de Local'}</div>
          <div style="font-size:.68rem;opacity:.6;margin-top:3px">Rol: ${reg.role==='owner'?'Propietario':'Staff'}</div>
        </div>
      </div>
      <button class="btn btn-danger btn-block" onclick="doLogout()">
        <span class="material-symbols-rounded">logout</span> Cerrar Sesión Segura
      </button>
    `)}`;
}

// ═══════════════════════════════════════════════════════════════
//  TAB: FINANZAS
// ═══════════════════════════════════════════════════════════════
function _tabFinanzas() {
  return `
    ${_cfgTabHd('account_balance','Finanzas','Moneda, impuestos, métodos de pago y comisiones.')}
    ${_cfgCard('account_balance','Ajustes Financieros',`
      <div class="cfg-grid-2">
        <div class="form-group">
          <label for="cfg-currency">Símbolo de Moneda</label>
          <select id="cfg-currency"
            onchange="updateState('config.currency',this.value,'pos-config');saveState();saveConfigServer();render()">
            <option value="$"  ${S.config.currency==='$' ?'selected':''}>$ (Peso/Dólar)</option>
            <option value="€"  ${S.config.currency==='€' ?'selected':''}>€ (Euro)</option>
            <option value="S/" ${S.config.currency==='S/'?'selected':''}>S/ (Sol)</option>
            <option value="Q"  ${S.config.currency==='Q' ?'selected':''}>Q (Quetzal)</option>
          </select>
        </div>
        <div class="form-group">
          <label for="cfg-tax">Impuesto (IVA/IGV) %</label>
          <input id="cfg-tax" type="number" value="${S.config.taxRate}" min="0" max="50"
            onchange="updateState('config.taxRate',+this.value,'pos-config');saveState();saveConfigServer();toast('Impuesto actualizado')">
        </div>
      </div>
      <div class="form-group">
        <label for="cfg-ticket-footer">Mensaje al pie del Ticket</label>
        <textarea id="cfg-ticket-footer" rows="3" style="resize:none"
          onchange="updateState('config.ticketFooter',this.value,'pos-config');saveState();saveConfigServer();toast('Ticket actualizado')">${S.config.ticketFooter}</textarea>
      </div>
    `)}
    ${_cfgCard('credit_score','Métodos de Pago & Comisiones',`
      <p style="font-size:.75rem;color:var(--text3);margin-bottom:14px">Activá métodos de pago y definí recargos automáticos por servicio.</p>
      <div style="display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:11px;background:var(--bg3);border-radius:11px;border:1px solid var(--bg4)">
          <div style="display:flex;align-items:center;gap:11px">
            <input type="checkbox" style="width:19px;height:19px;accent-color:var(--accent)"
              ${S.config.payMethods.cash?'checked':''}
              onchange="updateState('config.payMethods.cash',this.checked,'pos-config');saveState();saveConfigServer();toast('Efectivo actualizado')">
            <span style="font-weight:700"><span class="material-symbols-rounded">payments</span> Efectivo</span>
          </div>
          <span style="font-size:.63rem;color:var(--green);font-weight:800;letter-spacing:.5px">SIN RECARGO</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;padding:11px;background:var(--bg3);border-radius:11px;border:1px solid var(--bg4)">
          <div style="display:flex;align-items:center;gap:11px">
            <input type="checkbox" style="width:19px;height:19px;accent-color:var(--accent)"
              ${S.config.payMethods.card?'checked':''}
              onchange="updateState('config.payMethods.card',this.checked,'pos-config');saveState();saveConfigServer();toast('Tarjeta actualizada')">
            <span style="font-weight:700"><span class="material-symbols-rounded">credit_card</span> Tarjeta</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <label style="font-size:.63rem;font-weight:800;color:var(--text3);margin:0">RECARGO %</label>
            <input type="number" value="${S.config.commissions.card}"
              style="width:62px;padding:5px;text-align:center;font-weight:700"
              onchange="updateState('config.commissions.card',+this.value,'pos-config');saveState();saveConfigServer();toast('Comisión actualizada')">
          </div>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;padding:11px;background:var(--bg3);border-radius:11px;border:1px solid var(--bg4)">
          <div style="display:flex;align-items:center;gap:11px">
            <input type="checkbox" style="width:19px;height:19px;accent-color:var(--accent)"
              ${S.config.payMethods.transfer?'checked':''}
              onchange="updateState('config.payMethods.transfer',this.checked,'pos-config');saveState();saveConfigServer();toast('Transferencia actualizada')">
            <span style="font-weight:700"><span class="material-symbols-rounded">smartphone</span> Transferencia</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <label style="font-size:.63rem;font-weight:800;color:var(--text3);margin:0">RECARGO %</label>
            <input type="number" value="${S.config.commissions.transfer}"
              style="width:62px;padding:5px;text-align:center;font-weight:700"
              onchange="updateState('config.commissions.transfer',+this.value,'pos-config');saveState();saveConfigServer();toast('Comisión actualizada')">
          </div>
        </div>
      </div>
    `)}`;
}

// ═══════════════════════════════════════════════════════════════
//  TAB: SEGURIDAD
// ═══════════════════════════════════════════════════════════════
function _tabSeguridad() {
  return `
    ${_cfgTabHd('lock','Seguridad','PIN de supervisor y permisos por rol para controlar acceso a funciones críticas.')}
    ${_cfgCard('pin','PIN de Supervisor',`
      <p style="font-size:.78rem;color:var(--text3);margin-bottom:14px">El PIN de supervisor autoriza acciones sensibles: descuentos altos, cancelaciones y cierre de caja.</p>
      <div id="sec-pin-body"><div style="text-align:center;padding:20px;color:var(--text3)">Cargando...</div></div>
    `)}
    ${_cfgCard('admin_panel_settings','Requerir PIN Para...',`
      <div id="sec-pin-triggers"><div style="text-align:center;padding:20px;color:var(--text3)">Cargando...</div></div>
    `)}
    ${_cfgCard('manage_accounts','Permisos por Rol',`
      <p style="font-size:.78rem;color:var(--text3);margin-bottom:14px">Definí qué acciones puede realizar cada rol. Los propietarios siempre tienen acceso total.</p>
      <div id="sec-perms-body"><div style="text-align:center;padding:20px;color:var(--text3)">Cargando...</div></div>
    `)}`;
}

async function _loadSecConfig() {
  try {
    const res  = await fetch('/api/config/security');
    const data = await res.json();
    _renderSecPIN(data.pin_set || false);
    _renderSecTriggers(data.pin_triggers || {});
    _renderPermissions(data.role_permissions || {});
  } catch {
    _renderSecPIN(false);
    _renderSecTriggers({});
    _renderPermissions({});
  }
}

function _renderSecPIN(pinSet) {
  const el = document.getElementById('sec-pin-body');
  if (!el) return;
  el.innerHTML = pinSet
    ? `<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;padding:12px;background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.25);border-radius:10px">
        <span class="material-symbols-rounded" style="color:var(--green)">check_circle</span>
        <span style="font-weight:600;font-size:.85rem;color:var(--green)">PIN configurado</span>
      </div>
      <div class="cfg-grid-2" style="margin-bottom:10px">
        <div class="form-group">
          <label>PIN Actual</label>
          <input type="password" id="sec-pin-old" maxlength="6" placeholder="••••" style="letter-spacing:6px;font-size:1.2rem">
        </div>
        <div></div>
        <div class="form-group">
          <label>PIN Nuevo (4–6 dígitos)</label>
          <input type="password" id="sec-pin-new" maxlength="6" placeholder="••••" style="letter-spacing:6px;font-size:1.2rem">
        </div>
        <div class="form-group">
          <label>Confirmar PIN Nuevo</label>
          <input type="password" id="sec-pin-confirm" maxlength="6" placeholder="••••" style="letter-spacing:6px;font-size:1.2rem">
        </div>
      </div>
      <button class="btn btn-primary" onclick="saveSupervisorPin(true)">
        <span class="material-symbols-rounded">lock_reset</span> Cambiar PIN
      </button>
      <button class="btn btn-outline" style="margin-left:8px;color:var(--red);border-color:rgba(239,68,68,.3)" onclick="removeSupervisorPin()">
        <span class="material-symbols-rounded">no_encryption</span> Quitar PIN
      </button>`
    : `<p style="font-size:.78rem;color:var(--text3);margin-bottom:14px">Sin PIN configurado. Cualquier usuario puede realizar acciones de supervisor.</p>
      <div class="cfg-grid-2" style="margin-bottom:10px">
        <div class="form-group">
          <label>PIN Nuevo (4–6 dígitos)</label>
          <input type="password" id="sec-pin-new" maxlength="6" placeholder="••••" style="letter-spacing:6px;font-size:1.2rem">
        </div>
        <div class="form-group">
          <label>Confirmar PIN</label>
          <input type="password" id="sec-pin-confirm" maxlength="6" placeholder="••••" style="letter-spacing:6px;font-size:1.2rem">
        </div>
      </div>
      <button class="btn btn-primary" onclick="saveSupervisorPin(false)">
        <span class="material-symbols-rounded">lock</span> Activar PIN de Supervisor
      </button>`;
}

function _renderSecTriggers(triggers) {
  const el = document.getElementById('sec-pin-triggers');
  if (!el) return;
  const items = [
    { key:'discount',   label:'Aplicar descuentos',  desc:'Requerir PIN para aplicar cualquier descuento al total' },
    { key:'cancel',     label:'Cancelar órdenes',     desc:'Requerir PIN para cancelar una orden activa' },
    { key:'caja_close', label:'Cerrar caja',          desc:'Requerir PIN al cerrar el turno de caja' },
    { key:'refund',     label:'Emitir reembolsos',    desc:'Requerir PIN para devolver pagos o anular cobros' },
    { key:'edit_price', label:'Modificar precios',    desc:'Requerir PIN para cambiar el precio de un ítem en la orden' },
  ];
  el.innerHTML = items.map(i =>
    _cfgToggleRow(i.label, i.desc, !!triggers[i.key], `saveSecTrigger('${i.key}',this.classList.contains('on'))`)
  ).join('');
}

function _renderPermissions(perms) {
  const el = document.getElementById('sec-perms-body');
  if (!el) return;
  const ROLES    = ['mozo','cajero','supervisor'];
  const ROLE_LBL = { mozo:'Mozo', cajero:'Cajero', supervisor:'Supervisor' };
  const PERMS    = [
    { key:'ver_reportes',      label:'Ver reportes' },
    { key:'exportar_datos',    label:'Exportar datos' },
    { key:'gestionar_menu',    label:'Gestionar menú' },
    { key:'gestionar_emp',     label:'Gestionar empleados' },
    { key:'aplicar_desc',      label:'Aplicar descuentos' },
    { key:'cancelar_orden',    label:'Cancelar órdenes' },
    { key:'ver_inventario',    label:'Ver inventario' },
    { key:'editar_inventario', label:'Editar inventario' },
  ];
  const defaults = {
    mozo:       ['ver_inventario'],
    cajero:     ['ver_reportes','aplicar_desc','ver_inventario'],
    supervisor: ['ver_reportes','exportar_datos','gestionar_menu','aplicar_desc','cancelar_orden','ver_inventario','editar_inventario'],
  };
  const resolved = {};
  ROLES.forEach(r => { resolved[r] = perms[r] || defaults[r]; });
  el.innerHTML = `
    <div style="overflow-x:auto">
      <table class="perm-table">
        <thead><tr>
          <th style="text-align:left">Permiso</th>
          ${ROLES.map(r=>`<th>${ROLE_LBL[r]}</th>`).join('')}
        </tr></thead>
        <tbody>
          ${PERMS.map(p=>`<tr>
            <td>${p.label}</td>
            ${ROLES.map(r=>`<td><input type="checkbox" id="perm_${r}_${p.key}"
              ${resolved[r].includes(p.key)?'checked':''}
              onchange="saveRolePermissions()"></td>`).join('')}
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <button class="btn btn-primary" style="margin-top:14px" onclick="saveRolePermissions(true)">
      <span class="material-symbols-rounded">save</span> Guardar Permisos
    </button>`;
}

async function saveSupervisorPin(isChange) {
  const newPin     = document.getElementById('sec-pin-new')?.value.trim();
  const confirmPin = document.getElementById('sec-pin-confirm')?.value.trim();
  const oldPin     = document.getElementById('sec-pin-old')?.value.trim();
  if (!newPin || newPin.length < 4)  { toast('El PIN debe tener al menos 4 dígitos','error'); return; }
  if (newPin !== confirmPin)         { toast('Los PINs no coinciden','error'); return; }
  const body = { new_pin: newPin };
  if (isChange && oldPin) body.old_pin = oldPin;
  try {
    const res  = await fetch('/api/config/security/pin', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Error');
    toast('PIN de supervisor actualizado ✓','success');
    _renderSecPIN(true);
  } catch(e) { toast('Error: '+e.message,'error'); }
}

async function removeSupervisorPin() {
  if (!confirm('¿Estás seguro de que querés eliminar el PIN de supervisor?')) return;
  try {
    const res  = await fetch('/api/config/security/pin', { method:'DELETE', headers:{'Content-Type':'application/json'} });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Error');
    toast('PIN eliminado','success');
    _renderSecPIN(false);
  } catch(e) { toast('Error: '+e.message,'error'); }
}

async function saveSecTrigger(key, value) {
  try {
    await fetch('/api/config/security/triggers', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ key, value })
    });
  } catch(e) { console.error('[Security triggers]', e); }
}

async function saveRolePermissions(showToast = false) {
  const ROLES    = ['mozo','cajero','supervisor'];
  const PERM_KEYS = ['ver_reportes','exportar_datos','gestionar_menu','gestionar_emp','aplicar_desc','cancelar_orden','ver_inventario','editar_inventario'];
  const perms = {};
  ROLES.forEach(r => { perms[r] = PERM_KEYS.filter(p => document.getElementById(`perm_${r}_${p}`)?.checked); });
  try {
    const res  = await fetch('/api/config/security/permissions', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ permissions: perms })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Error');
    if (showToast) toast('Permisos guardados ✓','success');
  } catch(e) { if (showToast) toast('Error: '+e.message,'error'); }
}

// Función pública: verifica PIN mediante modal
async function verifySupervisorPin() {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:99999';
    overlay.innerHTML = `
      <div style="background:var(--bg2);border-radius:18px;padding:28px;width:280px;text-align:center;border:1px solid var(--bg4)">
        <span class="material-symbols-rounded" style="font-size:2.5rem;color:var(--accent);display:block;margin-bottom:12px">lock</span>
        <h3 style="font-size:1rem;font-weight:800;margin-bottom:6px">PIN de Supervisor</h3>
        <p style="font-size:.78rem;color:var(--text3);margin-bottom:16px">Ingresá el PIN para continuar</p>
        <input type="password" id="sv-pin-input" maxlength="6" placeholder="••••"
          style="width:100%;text-align:center;font-size:1.5rem;letter-spacing:8px;padding:10px;border-radius:10px;background:var(--bg3);border:1px solid var(--bg4);color:var(--text);margin-bottom:14px"
          onkeydown="if(event.key==='Enter')document.getElementById('sv-pin-ok').click()">
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary" style="flex:1" onclick="this.closest('[style*=fixed]').remove();window._svPinResolve&&window._svPinResolve(false)">Cancelar</button>
          <button id="sv-pin-ok" class="btn btn-primary" style="flex:1" onclick="window._checkSVPin()">Confirmar</button>
        </div>
      </div>`;
    window._svPinResolve = resolve;
    window._checkSVPin = async () => {
      const pin = document.getElementById('sv-pin-input')?.value;
      try {
        const res  = await fetch('/api/config/security/verify-pin', {
          method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ pin })
        });
        const data = await res.json();
        overlay.remove();
        resolve(data.valid === true);
      } catch { overlay.remove(); resolve(false); }
    };
    document.body.appendChild(overlay);
    setTimeout(() => document.getElementById('sv-pin-input')?.focus(), 50);
  });
}

// ═══════════════════════════════════════════════════════════════
//  TAB: VENTAS Y DESCUENTOS
// ═══════════════════════════════════════════════════════════════
function _tabVentas() {
  return `
    ${_cfgTabHd('sell','Ventas y Descuentos','Descuentos predefinidos y apertura/cierre de caja diario.')}
    ${_cfgCard('sell','Descuentos Predefinidos',`
      <p style="font-size:.78rem;color:var(--text3);margin-bottom:14px">Estos descuentos aparecen como acceso rápido en la pantalla de cobro.</p>
      <div id="disc-list"><div style="text-align:center;padding:16px;color:var(--text3)">Cargando...</div></div>
      <hr style="border:none;border-top:1px solid var(--bg4);margin:14px 0">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
        <div class="form-group" style="margin:0;flex:1;min-width:120px">
          <label>Nombre</label>
          <input id="disc-new-name" placeholder="Ej: Empleado">
        </div>
        <div class="form-group" style="margin:0;width:80px">
          <label>Valor</label>
          <input id="disc-new-val" type="number" min="0" placeholder="10">
        </div>
        <div class="form-group" style="margin:0;width:120px">
          <label>Tipo</label>
          <select id="disc-new-type">
            <option value="percent">% Porcentaje</option>
            <option value="fixed">$ Fijo</option>
          </select>
        </div>
        <button class="btn btn-primary" style="margin-bottom:0" onclick="addDiscount()">
          <span class="material-symbols-rounded">add</span> Agregar
        </button>
      </div>
    `)}
    ${_cfgCard('point_of_sale','Apertura y Cierre de Caja',`
      <p style="font-size:.78rem;color:var(--text3);margin-bottom:14px">Registrá el monto inicial y el cierre de cada turno para el control del efectivo.</p>
      <div id="caja-status-area"><div style="text-align:center;padding:16px;color:var(--text3)">Cargando...</div></div>
    `)}`;
}

async function _loadVentasConfig() {
  await Promise.all([_loadDiscounts(), _loadCajaStatus()]);
}

async function _loadDiscounts() {
  try {
    const res  = await fetch('/api/config/discounts');
    const data = await res.json();
    _renderDiscounts(data.discounts || []);
  } catch { _renderDiscounts([]); }
}

function _renderDiscounts(discounts) {
  const el = document.getElementById('disc-list');
  if (!el) return;
  if (!discounts.length) {
    el.innerHTML = `<div style="text-align:center;padding:12px;font-size:.8rem;color:var(--text3);font-style:italic">Sin descuentos configurados.</div>`;
    return;
  }
  el.innerHTML = discounts.map(d => `
    <div class="disc-item">
      <span class="disc-item__name">${esc(d.name)}</span>
      <span class="disc-item__val">${d.type==='percent' ? esc(d.value)+'%' : '$'+esc(d.value)}</span>
      <button class="btn btn-danger btn-sm" onclick="deleteDiscount(${d.id})">
        <span class="material-symbols-rounded">delete</span>
      </button>
    </div>`).join('');
}

async function addDiscount() {
  const name  = document.getElementById('disc-new-name')?.value.trim();
  const value = parseFloat(document.getElementById('disc-new-val')?.value);
  const type  = document.getElementById('disc-new-type')?.value;
  if (!name || isNaN(value) || value <= 0) { toast('Completá nombre y valor','error'); return; }
  try {
    const res  = await fetch('/api/config/discounts', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ name, value, type })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    document.getElementById('disc-new-name').value = '';
    document.getElementById('disc-new-val').value  = '';
    toast('Descuento agregado ✓','success');
    _loadDiscounts();
  } catch(e) { toast('Error: '+e.message,'error'); }
}

async function deleteDiscount(id) {
  try {
    await fetch(`/api/config/discounts/${id}`, { method:'DELETE' });
    toast('Descuento eliminado','success');
    _loadDiscounts();
  } catch(e) { toast('Error: '+e.message,'error'); }
}

async function _loadCajaStatus() {
  try {
    const res  = await fetch('/api/config/caja/current');
    const data = await res.json();
    _renderCajaStatus(data.session || null);
  } catch { _renderCajaStatus(null); }
}

function _renderCajaStatus(session) {
  const el = document.getElementById('caja-status-area');
  if (!el) return;
  if (session && session.status === 'open') {
    const since = new Date(session.opened_at).toLocaleString('es-AR');
    el.innerHTML = `
      <div class="caja-status abierta">
        <span class="material-symbols-rounded">lock_open</span> Caja Abierta desde ${since}
      </div>
      <div style="font-size:.78rem;color:var(--text3);margin-bottom:14px">
        Abierta por: <strong>${session.opened_by||'—'}</strong> &nbsp;·&nbsp;
        Monto inicial: <strong>${S.config.currency||'$'}${parseFloat(session.opening_amount||0).toFixed(2)}</strong>
      </div>
      <div class="form-group">
        <label for="caja-close-amount">Monto final en efectivo</label>
        <input id="caja-close-amount" type="number" placeholder="0.00">
      </div>
      <div class="form-group">
        <label for="caja-close-notes">Observaciones</label>
        <input id="caja-close-notes" placeholder="Opcional">
      </div>
      <button class="btn btn-danger" onclick="closeCaja(${session.id})">
        <span class="material-symbols-rounded">lock</span> Cerrar Caja
      </button>`;
  } else {
    el.innerHTML = `
      <div class="caja-status cerrada">
        <span class="material-symbols-rounded">lock</span> Caja Cerrada
      </div>
      <div class="form-group">
        <label for="caja-open-amount">Monto inicial en efectivo</label>
        <input id="caja-open-amount" type="number" placeholder="0.00">
      </div>
      <button class="btn btn-primary" onclick="openCaja()">
        <span class="material-symbols-rounded">lock_open</span> Abrir Caja
      </button>`;
  }
}

async function openCaja() {
  const amount = parseFloat(document.getElementById('caja-open-amount')?.value || 0);
  const reg    = JSON.parse(localStorage.getItem('mente_maestra_registration') || '{}');
  try {
    const res  = await fetch('/api/config/caja/open', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ opening_amount: amount, opened_by: reg.name||'Desconocido' })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Error');
    toast('Caja abierta ✓','success');
    _loadCajaStatus();
  } catch(e) { toast('Error: '+e.message,'error'); }
}

async function closeCaja(sessionId) {
  const amount = parseFloat(document.getElementById('caja-close-amount')?.value || 0);
  const notes  = document.getElementById('caja-close-notes')?.value || '';
  const reg    = JSON.parse(localStorage.getItem('mente_maestra_registration') || '{}');
  try {
    const res  = await fetch('/api/config/caja/close', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ session_id: sessionId, closing_amount: amount, notes, closed_by: reg.name||'Desconocido' })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Error');
    toast('Caja cerrada ✓','success');
    _loadCajaStatus();
  } catch(e) { toast('Error: '+e.message,'error'); }
}

// ═══════════════════════════════════════════════════════════════
//  TAB: TICKET E IMPRESIÓN
// ═══════════════════════════════════════════════════════════════
function _tabTicket() {
  return `
    ${_cfgTabHd('receipt_long','Ticket e Impresión','Formato del ticket, auto-impresión y configuración de impresoras físicas.')}
    ${_cfgCard('receipt_long','Formato del Ticket',`
      <div id="ticket-format-body"><div style="text-align:center;padding:16px;color:var(--text3)">Cargando...</div></div>
    `)}
    ${_cfgCard('print_connect','Auto-imprimir',`
      <div id="ticket-autoprint-body"><div style="text-align:center;padding:16px;color:var(--text3)">Cargando...</div></div>
    `)}
    ${_cfgCard('print','Configuración de Impresoras',`
      <p style="font-size:.8rem;color:var(--text3);margin-bottom:14px">Configurá cada impresora física (USB o Red TCP/IP) según su ubicación.</p>
      <div id="printer-areas-container"><div style="text-align:center;padding:20px;color:var(--text3)">Cargando...</div></div>
      <button class="btn btn-primary btn-block" style="margin-top:14px" onclick="savePrinterConfig()">
        <span class="material-symbols-rounded">save</span> Guardar Configuración de Impresoras
      </button>
      <button class="btn btn-secondary btn-block" style="margin-top:8px" onclick="testPrinterArea()">
        <span class="material-symbols-rounded">receipt_long</span> Imprimir Ticket de Prueba
      </button>
    `)}`;
}

async function _loadTicketConfig() {
  try {
    const res  = await fetch('/api/config/ticket-format');
    const data = await res.json();
    _renderTicketFormat(data.format || {});
    _renderAutoprint(data.autoprint || {});
  } catch {
    _renderTicketFormat({});
    _renderAutoprint({});
  }
}

function _renderTicketFormat(fmt) {
  const el = document.getElementById('ticket-format-body');
  if (!el) return;
  const width    = fmt.paper_width  || '80mm';
  const fontSize = fmt.font_size    || 'medium';
  const showLogo  = fmt.show_logo    !== false;
  const showAddr  = fmt.show_address !== false;
  const showNotes = fmt.show_notes   !== false;
  const showTax   = fmt.show_tax     !== false;
  const showQR    = !!fmt.show_qr;
  el.innerHTML = `
    <div class="cfg-grid-2" style="margin-bottom:14px">
      <div class="form-group">
        <label for="tkf-width">Ancho del Papel</label>
        <select id="tkf-width" onchange="_saveTicketFormat()">
          <option value="58mm" ${width==='58mm'?'selected':''}>58 mm (Compacto)</option>
          <option value="80mm" ${width==='80mm'?'selected':''}>80 mm (Estándar)</option>
        </select>
      </div>
      <div class="form-group">
        <label for="tkf-fontsize">Tamaño de Fuente</label>
        <select id="tkf-fontsize" onchange="_saveTicketFormat()">
          <option value="small"  ${fontSize==='small' ?'selected':''}>Pequeño</option>
          <option value="medium" ${fontSize==='medium'?'selected':''}>Mediano</option>
          <option value="large"  ${fontSize==='large' ?'selected':''}>Grande</option>
        </select>
      </div>
    </div>
    ${_cfgToggleRow('Mostrar logo en el ticket',        'Imprime el logo del negocio en el encabezado',                     showLogo,  '_saveTicketFormat()')}
    ${_cfgToggleRow('Mostrar dirección y teléfono',  'Imprime la dirección y teléfono del negocio',                         showAddr,  '_saveTicketFormat()')}
    ${_cfgToggleRow('Mostrar notas de items',         'Muestra las aclaraciones de cada producto (ej: + huevo, sin sal)',   showNotes, '_saveTicketFormat()')}
    ${_cfgToggleRow('Mostrar desglose de impuesto',  'Muestra subtotal + impuesto por separado',                            showTax,   '_saveTicketFormat()')}
    ${_cfgToggleRow('Mostrar código QR',             'Agrega un QR con el número de orden al pie',                         showQR,    '_saveTicketFormat()')}`;
}

function _renderAutoprint(ap) {
  const el = document.getElementById('ticket-autoprint-body');
  if (!el) return;

  const hasElectron = !!(window.electronAPI && window.electronAPI.getPrinters);

  function _printerInfo(type, typeLabel) {
    if (!hasElectron) return '';
    const saved = localStorage.getItem('lmma_printer_' + type);
    const escapedSaved = saved ? saved.replace(/'/g, "\\'") : '';
    const info = saved
      ? `Impresora: <strong style="color:var(--text)">${esc(saved)}</strong>
         &nbsp;<button class="btn btn-sm btn-secondary" style="padding:2px 9px;font-size:.67rem"
           onclick="PrintManager.clearPrinter('${type}');window._lastAp&&_renderAutoprint(window._lastAp);toast('Impresora de ${typeLabel} restablecida','info')">
           Cambiar
         </button>`
      : `<em style="color:var(--text3)">Se pedirá selección al primer uso</em>`;
    return `<div style="margin-top:5px;font-size:.72rem;display:flex;align-items:center;gap:6px">` +
           `<span class="material-symbols-rounded" style="font-size:.85rem;color:var(--accent)">print</span>` +
           `<span>${info}</span></div>`;
  }

  window._lastAp = ap;

  el.innerHTML =
    '<div class="cfg-toggle-row">' +
      '<div class="cfg-toggle-row__info">' +
        '<div class="cfg-toggle-row__lbl">Auto-imprimir comanda al confirmar pedido</div>' +
        '<div class="cfg-toggle-row__desc">Envía automáticamente a cocina/bar al guardar la orden</div>' +
        _printerInfo('comanda', 'comandas') +
      '</div>' +
      `<button class="cfg-toggle ${ap.comanda ? 'on' : ''}" onclick="this.classList.toggle('on');_saveAutoprint()"></button>` +
    '</div>' +
    '<div class="cfg-toggle-row">' +
      '<div class="cfg-toggle-row__info">' +
        '<div class="cfg-toggle-row__lbl">Auto-imprimir ticket al cobrar</div>' +
        '<div class="cfg-toggle-row__desc">Imprime el ticket del cliente automáticamente al cobrar</div>' +
        _printerInfo('ticket', 'tickets') +
      '</div>' +
      `<button class="cfg-toggle ${ap.ticket ? 'on' : ''}" onclick="this.classList.toggle('on');_saveAutoprint()"></button>` +
    '</div>' +
    '<div class="cfg-toggle-row">' +
      '<div class="cfg-toggle-row__info">' +
        '<div class="cfg-toggle-row__lbl">Auto-imprimir resumen al cerrar caja</div>' +
        '<div class="cfg-toggle-row__desc">Genera un resumen impreso al cierre del turno</div>' +
        _printerInfo('resumen', 'resumen') +
      '</div>' +
      `<button class="cfg-toggle ${ap.caja ? 'on' : ''}" onclick="this.classList.toggle('on');_saveAutoprint()"></button>` +
    '</div>';
}

async function _saveTicketFormat() {
  const toggles = document.querySelectorAll('#ticket-format-body .cfg-toggle');
  const format = {
    paper_width:  document.getElementById('tkf-width')?.value   || '80mm',
    font_size:    document.getElementById('tkf-fontsize')?.value || 'medium',
    show_logo:    toggles[0]?.classList.contains('on') ?? true,
    show_address: toggles[1]?.classList.contains('on') ?? true,
    show_notes:   toggles[2]?.classList.contains('on') ?? true,
    show_tax:     toggles[3]?.classList.contains('on') ?? true,
    show_qr:      toggles[4]?.classList.contains('on') ?? false,
  };
  try {
    await fetch('/api/config/ticket-format', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ format })
    });
    toast('Formato de ticket guardado ✓','success');
  } catch { toast('Error al guardar','error'); }
}

async function _saveAutoprint() {
  const toggles = document.querySelectorAll('#ticket-autoprint-body .cfg-toggle');
  const autoprint = {
    comanda: toggles[0]?.classList.contains('on') ?? false,
    ticket:  toggles[1]?.classList.contains('on') ?? false,
    caja:    toggles[2]?.classList.contains('on') ?? false,
  };
  try {
    await fetch('/api/config/auto-print', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ autoprint })
    });
    toast('Auto-impresión guardada ✓','success');
    // Invalidar cache de PrintManager para que lea la nueva config
    if (window.PrintManager) window.PrintManager.invalidateConfig();
  } catch { toast('Error al guardar','error'); }
}

// ═══════════════════════════════════════════════════════════════
//  TAB: OPERACIÓN DEL LOCAL
// ═══════════════════════════════════════════════════════════════
function _tabOperacion() {
  return `
    ${_cfgTabHd('schedule','Operación del Local','Horarios de atención, alertas de stock y turnos del día.')}
    ${_cfgCard('schedule','Horarios del Local',`
      <p style="font-size:.78rem;color:var(--text3);margin-bottom:14px">Definí el horario de apertura y cierre para cada día de la semana.</p>
      <div id="hours-body"><div style="text-align:center;padding:16px;color:var(--text3)">Cargando...</div></div>
      <button class="btn btn-primary" style="margin-top:14px" onclick="saveBusinessHours()">
        <span class="material-symbols-rounded">save</span> Guardar Horarios
      </button>
    `)}
    ${_cfgCard('warning','Alertas de Stock',`
      <div id="stock-alerts-body"><div style="text-align:center;padding:16px;color:var(--text3)">Cargando...</div></div>
    `)}
    ${_cfgCard('work_history','Turnos del Día',`
      <p style="font-size:.78rem;color:var(--text3);margin-bottom:14px">Definí los turnos de trabajo del personal para organizar reportes por turno.</p>
      <div id="shifts-body"><div style="text-align:center;padding:16px;color:var(--text3)">Cargando...</div></div>
      <hr style="border:none;border-top:1px solid var(--bg4);margin:14px 0">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
        <div class="form-group" style="margin:0;flex:1;min-width:100px">
          <label>Nombre del Turno</label>
          <input id="shift-new-name" placeholder="Ej: Tarde">
        </div>
        <div class="form-group" style="margin:0;width:100px">
          <label>Inicio</label>
          <input id="shift-new-start" type="time" value="12:00">
        </div>
        <div class="form-group" style="margin:0;width:100px">
          <label>Fin</label>
          <input id="shift-new-end" type="time" value="20:00">
        </div>
        <button class="btn btn-primary" style="margin-bottom:0" onclick="addShift()">
          <span class="material-symbols-rounded">add</span> Agregar
        </button>
      </div>
    `)}`;
}

async function _loadOperConfig() {
  await Promise.all([_loadBusinessHours(), _loadStockAlerts(), _loadShifts()]);
}

const _DAYS = [
  {key:'lun',label:'Lunes'},{key:'mar',label:'Martes'},{key:'mie',label:'Miércoles'},
  {key:'jue',label:'Jueves'},{key:'vie',label:'Viernes'},{key:'sab',label:'Sábado'},{key:'dom',label:'Domingo'},
];

async function _loadBusinessHours() {
  try {
    const res  = await fetch('/api/config/business-hours');
    const data = await res.json();
    _renderBusinessHours(data.hours || {});
  } catch { _renderBusinessHours({}); }
}

function _renderBusinessHours(hours) {
  const el = document.getElementById('hours-body');
  if (!el) return;
  const def = { open:true, from:'09:00', to:'23:00' };
  el.innerHTML = '<div class="hours-grid">' + _DAYS.map(d => {
    const h = hours[d.key] || def;
    return `<div class="hours-row">
      <div class="hours-row__day">${d.label}</div>
      <input type="time" id="hr-from-${d.key}" value="${esc(h.from||'09:00')}" ${!h.open?'disabled':''}>
      <span style="font-size:.8rem;color:var(--text3);text-align:center">—</span>
      <input type="time" id="hr-to-${d.key}" value="${esc(h.to||'23:00')}" ${!h.open?'disabled':''}>
      <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:.75rem;color:var(--text3);white-space:nowrap">
        <input type="checkbox" id="hr-open-${d.key}" ${h.open?'checked':''}
          style="accent-color:var(--accent)"
          onchange="
            document.getElementById('hr-from-${d.key}').disabled=!this.checked;
            document.getElementById('hr-to-${d.key}').disabled=!this.checked">
        Abierto
      </label>
    </div>`;
  }).join('') + '</div>';
}

async function saveBusinessHours() {
  const hours = {};
  _DAYS.forEach(d => {
    hours[d.key] = {
      open: document.getElementById(`hr-open-${d.key}`)?.checked ?? true,
      from: document.getElementById(`hr-from-${d.key}`)?.value || '09:00',
      to:   document.getElementById(`hr-to-${d.key}`)?.value   || '23:00',
    };
  });
  try {
    const res  = await fetch('/api/config/business-hours', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ hours })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    toast('Horarios guardados ✓','success');
  } catch(e) { toast('Error: '+e.message,'error'); }
}

async function _loadStockAlerts() {
  try {
    const res  = await fetch('/api/config/stock-alerts');
    const data = await res.json();
    _renderStockAlerts(data.alerts || {});
  } catch { _renderStockAlerts({}); }
}

function _renderStockAlerts(alerts) {
  const el = document.getElementById('stock-alerts-body');
  if (!el) return;
  const enabled   = alerts.enabled   !== false;
  const threshold = alerts.threshold ?? 5;
  el.innerHTML = `
    ${_cfgToggleRow('Activar alertas de stock bajo','Notificaciones cuando un ingrediente cae por debajo del mínimo', enabled, '_saveStockAlerts()')}
    <div style="display:flex;align-items:center;gap:14px;margin-top:14px">
      <div class="form-group" style="margin:0;flex:1">
        <label for="stock-threshold">Umbral de alerta global (unidades)</label>
        <input id="stock-threshold" type="number" min="0" value="${threshold}" style="max-width:120px" onchange="_saveStockAlerts()">
      </div>
    </div>
    <p style="font-size:.72rem;color:var(--text3);margin-top:8px">Podés definir un mínimo individual por ítem desde el módulo de Inventario.</p>`;
}

async function _saveStockAlerts() {
  const enabled   = document.querySelector('#stock-alerts-body .cfg-toggle')?.classList.contains('on') ?? true;
  const threshold = parseFloat(document.getElementById('stock-threshold')?.value || 5);
  try {
    await fetch('/api/config/stock-alerts', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ enabled, threshold })
    });
    toast('Alertas de stock guardadas ✓','success');
  } catch { toast('Error','error'); }
}

async function _loadShifts() {
  try {
    const res  = await fetch('/api/config/shifts');
    const data = await res.json();
    _renderShifts(data.shifts || []);
  } catch { _renderShifts([]); }
}

function _renderShifts(shifts) {
  const el = document.getElementById('shifts-body');
  if (!el) return;
  if (!shifts.length) {
    el.innerHTML = `<div style="text-align:center;padding:12px;font-size:.8rem;color:var(--text3);font-style:italic">Sin turnos configurados.</div>`;
    return;
  }
  el.innerHTML = shifts.map(s => `
    <div class="shift-item">
      <span class="shift-item__name">${esc(s.name)}</span>
      <span class="shift-item__time">${esc(s.start_time)} — ${esc(s.end_time)}</span>
      <button class="btn btn-danger btn-sm" onclick="deleteShift(${s.id})">
        <span class="material-symbols-rounded">delete</span>
      </button>
    </div>`).join('');
}

async function addShift() {
  const name  = document.getElementById('shift-new-name')?.value.trim();
  const start = document.getElementById('shift-new-start')?.value;
  const end   = document.getElementById('shift-new-end')?.value;
  if (!name || !start || !end) { toast('Completá todos los campos','error'); return; }
  try {
    const res  = await fetch('/api/config/shifts', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ name, start_time:start, end_time:end })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    document.getElementById('shift-new-name').value = '';
    toast('Turno agregado ✓','success');
    _loadShifts();
  } catch(e) { toast('Error: '+e.message,'error'); }
}

async function deleteShift(id) {
  try {
    await fetch(`/api/config/shifts/${id}`, { method:'DELETE' });
    toast('Turno eliminado','success');
    _loadShifts();
  } catch { toast('Error','error'); }
}

// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
//  TAB: INTEGRACIONES
// ═══════════════════════════════════════════════════════════════
function _tabIntegraciones() {
  function _intCard({ id, icon, name, desc, badge, badgeColor, fields, docsUrl }) {
    const badgeHtml = badge
      ? `<span style="font-size:.6rem;font-weight:800;padding:2px 8px;border-radius:20px;
                      background:${badgeColor || 'rgba(245,158,11,.15)'};
                      color:${badgeColor ? '#fff' : '#f59e0b'};letter-spacing:.5px">${badge}</span>`
      : '';
    const fieldsHtml = fields ? fields.map(f => `
      <div style="margin-bottom:10px">
        <label style="font-size:.72rem;font-weight:700;color:var(--text2);text-transform:uppercase;
                      letter-spacing:.5px;display:block;margin-bottom:4px">${esc(f.label)}</label>
        ${f.type === 'textarea'
          ? `<textarea rows="3" placeholder="${esc(f.placeholder || '')}"
               style="width:100%;background:var(--bg2);border:1px solid var(--bg4);border-radius:8px;
                      padding:8px 10px;color:var(--text);font-size:.82rem;resize:vertical;
                      font-family:monospace">${esc(f.value || '')}</textarea>`
          : `<input type="${f.type || 'text'}" placeholder="${esc(f.placeholder || '')}" value="${esc(f.value || '')}"
               style="width:100%;background:var(--bg2);border:1px solid var(--bg4);border-radius:8px;
                      padding:8px 10px;color:var(--text);font-size:.82rem;font-family:${f.mono ? 'monospace' : 'inherit'}">`
        }
        ${f.hint ? `<p style="font-size:.7rem;color:var(--text3);margin-top:3px">${esc(f.hint)}</p>` : ''}
      </div>`).join('') : '';

    const actionsHtml = fields
      ? `<div style="display:flex;gap:8px;margin-top:4px;flex-wrap:wrap">
           <button class="btn btn-primary" style="font-size:.8rem;padding:6px 14px"
             id="int-save-btn-${id}"
             onclick="_saveIntegration('${id}')">
             <span class="material-symbols-rounded" style="font-size:14px">save</span> GUARDAR
           </button>
           ${docsUrl ? `<a href="${docsUrl}" target="_blank" rel="noopener"
             style="display:inline-flex;align-items:center;gap:4px;font-size:.78rem;
                    color:var(--text2);text-decoration:none;padding:6px 10px;border-radius:8px;
                    border:1px solid var(--bg4);background:var(--bg3)">
             <span class="material-symbols-rounded" style="font-size:14px">open_in_new</span> Docs
           </a>` : ''}
         </div>`
      : `<span style="font-size:.72rem;color:var(--text3);font-style:italic">Disponible próximamente</span>`;

    return `
      <div id="int-card-${id}" style="background:var(--bg3);border:1px solid var(--bg4);border-radius:12px;
                                       margin-bottom:12px;overflow:hidden">
        <!-- Header -->
        <div style="display:flex;align-items:center;gap:12px;padding:14px 16px;cursor:pointer;
                    user-select:none;background:var(--bg2)"
             onclick="(()=>{const b=document.getElementById('int-body-${id}');
                            const a=document.getElementById('int-arrow-${id}');
                            const open=b.style.display!=='none';
                            b.style.display=open?'none':'block';
                            a.style.transform=open?'rotate(0deg)':'rotate(180deg)'})()">
          <span class="material-symbols-rounded" style="font-size:22px;color:var(--accent)">${icon}</span>
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:8px">
              <span style="font-weight:700;font-size:.92rem">${name}</span>
              ${badgeHtml}
            </div>
            <p style="font-size:.75rem;color:var(--text2);margin:0;white-space:nowrap;
                      overflow:hidden;text-overflow:ellipsis">${desc}</p>
          </div>
          <span id="int-arrow-${id}" class="material-symbols-rounded"
                style="color:var(--text3);transition:transform .2s;flex-shrink:0">expand_more</span>
        </div>
        <!-- Body -->
        <div id="int-body-${id}" style="display:none;padding:16px">
          ${fieldsHtml}
          ${actionsHtml}
        </div>
      </div>`;
  }

  return `
    ${_cfgTabHd('hub', 'Integraciones', 'Conectá LMM con servicios externos de pago, fiscales, delivery y analítica.')}

    <!-- ── MERCADO PAGO ── -->
    ${_intCard({
      id: 'mp',
      icon: 'payments',
      name: 'Mercado Pago',
      desc: 'Cobros con QR dinámico directo desde el ticket — los clientes escanean y pagan.',
      fields: [
        { label: 'Access Token de producción', type: 'password', id: 'mp-token', placeholder: 'APP_USR-...', mono: true,
          hint: 'Obtenelo en mercadopago.com.ar → Tu negocio → Credenciales' },
        { label: 'ID de Sucursal (store_id)', type: 'text', id: 'mp-store', placeholder: 'ej. 123456', mono: true,
          hint: 'Creá la sucursal en el panel de Mercado Pago Negocios' },
        { label: 'ID de Caja (pos external_id)', type: 'text', id: 'mp-pos', placeholder: 'ej. CAJA_01', mono: true,
          hint: 'Identificador único de esta caja dentro de la sucursal' },
      ],
      docsUrl: 'https://www.mercadopago.com.ar/developers/es/docs/qr-code/integration-configuration/qr-dynamic/integration'
    })}

    <!-- ── SINCRONIZACIÓN EN LA NUBE (Supabase) ── -->
    ${_intCard({
      id: 'sync',
      icon: 'cloud_sync',
      name: 'Sincronización en la nube',
      desc: 'Conectá este local con la app mobile y otros dispositivos en tiempo real.',
      fields: [
        { label: 'Restaurant ID', type: 'text', placeholder: 'uuid-de-tu-restaurante', mono: true,
          hint: 'Lo generás insertando una fila en la tabla "restaurants" de tu proyecto Supabase' },
        { label: 'Supabase URL', type: 'text', placeholder: 'https://tu-proyecto.supabase.co', mono: true },
        { label: 'Supabase Publishable Key', type: 'password', placeholder: 'sb_publishable_...', mono: true,
          hint: 'Project Settings → API Keys. Nunca uses la Secret Key acá.' }
      ],
      docsUrl: 'https://supabase.com/dashboard'
    })}

    <!-- ── FISCAL AR / AFIP ── -->
    ${_intCard({
      id: 'fiscal',
      icon: 'gavel',
      name: 'Fiscal AR — AFIP',
      desc: 'Facturación electrónica, tickets fiscales, libro IVA y CAE automático.',
      badge: 'PRÓXIMAMENTE',
      fields: [
        { label: 'CUIT del negocio', type: 'text', placeholder: 'ej. 20-12345678-9', mono: true },
        { label: 'Punto de Venta AFIP', type: 'text', placeholder: 'ej. 0001', mono: true,
          hint: 'Número de punto de venta habilitado ante AFIP por tu contador' },
        { label: 'Certificado digital (.crt)', type: 'textarea', placeholder: '-----BEGIN CERTIFICATE-----\n...',
          hint: 'Generado en el portal de AFIP → Administración de Certificados Digitales' },
        { label: 'Clave privada (.key)', type: 'textarea', placeholder: '-----BEGIN PRIVATE KEY-----\n...',
          hint: 'Archivo .key generado junto al certificado. Se guarda encriptado.' },
      ],
      docsUrl: 'https://www.afip.gob.ar/ws/documentacion/arquitectura-ws-aplicaciones.asp'
    })}

    <!-- ── PEDIDOSYA ── -->
    ${_intCard({
      id: 'pedidosya',
      icon: 'delivery_dining',
      name: 'PedidosYa',
      desc: 'Recibí pedidos de PedidosYa directo en el POS sin copiar manualmente.',
      badge: 'PRÓXIMAMENTE',
      badgeColor: '#e63946',
    })}

    <!-- ── RAPPI ── -->
    ${_intCard({
      id: 'rappi',
      icon: 'moped',
      name: 'Rappi',
      desc: 'Integración con Rappi para gestionar pedidos de delivery en tiempo real.',
      badge: 'PRÓXIMAMENTE',
      badgeColor: '#ff441f',
    })}

    <!-- ── GOOGLE ANALYTICS ── -->
    ${_intCard({
      id: 'analytics',
      icon: 'analytics',
      name: 'Google Analytics / Telemetría',
      desc: 'Métricas de uso de la app para seguimiento de rendimiento y errores.',
      badge: 'PRÓXIMAMENTE',
      fields: [
        { label: 'Measurement ID', type: 'text', placeholder: 'G-XXXXXXXXXX', mono: true,
          hint: 'Encontralo en Google Analytics → Administrador → Flujos de datos' },
        { label: 'Habilitar telemetría anónima', type: 'text', placeholder: 'Activo desde pos-telemetry.js',
          hint: 'La telemetría interna ya está activa. Este campo conecta con tu propio GA.' },
      ],
      docsUrl: 'https://developers.google.com/analytics/devguides/collection/ga4'
    })}

    <!-- ── WEBHOOKS ── -->
    ${_intCard({
      id: 'webhooks',
      icon: 'webhook',
      name: 'Webhooks personalizados',
      desc: 'Enviá eventos del POS (venta cerrada, pedido nuevo, caja cerrada) a cualquier URL.',
      badge: 'PRÓXIMAMENTE',
      fields: [
        { label: 'URL del endpoint', type: 'text', placeholder: 'https://mi-sistema.com/webhook', mono: true,
          hint: 'El sistema enviará un POST con JSON en cada evento configurado' },
        { label: 'Eventos activos', type: 'text', placeholder: 'order.created, order.paid, cashier.close',
          hint: 'Separados por coma. Próximamente con selector visual de eventos.' },
        { label: 'Secret (para verificar firma)', type: 'password', placeholder: 'mi_secreto_seguro', mono: true,
          hint: 'Se incluye como header X-LMM-Signature en cada llamada' },
      ],
    })}`;
}

//  TAB: PRÓXIMAMENTE
// ═══════════════════════════════════════════════════════════════
function _tabComingSoon(title, icon, desc) {
  return `
    ${_cfgTabHd('construction', title)}
    <div class="cfg-coming">
      <div class="ci">${icon}</div>
      <h3>${title}</h3>
      <p>${desc}</p>
      <span class="cfg-coming-badge">Próximamente</span>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════
//  TAB: DATOS Y BACKUP
// ═══════════════════════════════════════════════════════════════
function _tabDatos() {
  const history = JSON.parse(localStorage.getItem('mm_history') || '[]');
  return `
    ${_cfgTabHd('database','Datos y Backup','Exportar, importar, guardar versiones y restablecer el sistema.')}
    <div class="cfg-card" style="border-color:rgba(239,68,68,.2)">
      <div class="cfg-card-hd" style="background:rgba(239,68,68,.04)">
        <span class="material-symbols-rounded" style="color:var(--red)">database</span>
        <h3>Copia de Seguridad y Datos</h3>
      </div>
      <div class="cfg-card-bd">
        <p style="font-size:.8rem;color:var(--text3);margin-bottom:14px">Protege tu información o gestioná versiones locales de respaldo.</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
          <button class="btn btn-secondary" onclick="exportData()">
            <span class="material-symbols-rounded">download</span> Exportar .JSON
          </button>
          <button class="btn btn-secondary" onclick="$('imp').click()">
            <span class="material-symbols-rounded">upload</span> Importar .JSON
          </button>
        </div>
        <button class="btn btn-primary btn-block" id="btn-save-version" style="margin-bottom:20px" onclick="saveVersionManual(this)">
          <span class="material-symbols-rounded">save</span> Guardar Versión Actual
        </button>
        <input type="file" id="imp" accept=".json" style="display:none" onchange="importData(this)">
        <div class="backup-history">
          <p style="font-size:.65rem;font-weight:800;color:var(--text3);margin-bottom:8px;text-transform:uppercase;">Historial de Versiones Recientes</p>
          ${history.length === 0
            ? `<div style="text-align:center;padding:10px;font-size:.75rem;color:var(--text3);font-style:italic">No hay versiones guardadas.</div>`
            : history.map(b=>`
              <div class="backup-item">
                <div class="backup-info">
                  <span class="backup-date">${b.date}</span>
                  <span class="backup-tag">${b.label}</span>
                </div>
                <button class="btn-restore-mini" onclick="restoreBackup(${b.id})">Restaurar</button>
              </div>`).join('')}
        </div>
        <hr style="border:none;border-top:1px solid var(--bg4);margin:20px 0">
        <button class="btn btn-outline btn-block" style="color:#f59e0b;border-color:rgba(245,158,11,.3);margin-bottom:10px" onclick="cleanupGhostOrders()">
          <span class="material-symbols-rounded">auto_fix_high</span> Limpiar Pedidos Vacíos
        </button>
        <button class="btn btn-outline btn-block" style="color:var(--red);border-color:rgba(239,68,68,.3)" onclick="resetSystem()">
          <span class="material-symbols-rounded">delete_forever</span> Formatear Sistema
        </button>
      </div>
    </div>`;
}

// ============================================================
//  CONFIGURACIÓN DE IMPRESORAS (sin cambios respecto a v2)
// ============================================================
async function loadPrinterConfig() {
  const container = document.getElementById('printer-areas-container');
  if (!container) return;
  container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text3)">Buscando impresoras...</div>';
  try {
    const [configRes, usbRes] = await Promise.all([
      fetch('/api/printer/config'),
      fetch('/api/printer/usb-devices')
    ]);
    const { config }  = await configRes.json();
    const usbData     = await usbRes.json();
    const usbDevices  = usbData.devices || [];
    const usbDetected = usbDevices.length > 0;
    const usbBanner = usbDetected
      ? `<div style="display:flex;align-items:center;gap:8px;padding:10px 14px;background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.25);border-radius:10px;margin-bottom:14px">
           <span class="material-symbols-rounded" style="color:var(--green);font-size:1.1rem">usb</span>
           <span style="color:var(--green);font-size:.75rem;font-weight:700">${usbDevices.length} impresora(s) USB detectada(s): ${usbDevices.map(d=>`${d.vendorId}:${d.productId}`).join(', ')}</span>
         </div>`
      : `<div style="display:flex;align-items:center;gap:8px;padding:10px 14px;background:var(--bg3);border:1px solid var(--bg4);border-radius:10px;margin-bottom:14px">
           <span class="material-symbols-rounded" style="color:var(--text3);font-size:1.1rem">usb_off</span>
           <span style="color:var(--text3);font-size:.75rem">Sin impresoras USB detectadas — enchufá la impresora y recargá esta sección</span>
         </div>`;
    const areas = [
      { key:'cocina', label:'🍳 Cocina', desc:'Comandas de comida para la cocina' },
      { key:'bar',    label:'🍹 Bar',    desc:'Comandas de bebidas para el bar'  },
      { key:'caja',   label:'💰 Caja',   desc:'Tickets de cobro para el cliente' }
    ];
    container.innerHTML = usbBanner + areas.map(a => _buildPrinterAreaHTML(a, config[a.key]||{}, usbDetected)).join('');
  } catch(e) {
    container.innerHTML = `<div style="padding:14px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.25);border-radius:10px;color:var(--red);font-size:.8rem">
      <strong>Error al cargar la configuración:</strong> ${e.message}
      <br><button class="btn btn-secondary btn-sm" style="margin-top:8px" onclick="loadPrinterConfig()">Reintentar</button>
    </div>`;
  }
}

function _buildPrinterAreaHTML(area, cfg, usbDetected) {
  const enabled = !!cfg.enabled;
  const type    = cfg.type || 'usb';
  const ip      = cfg.ip   || '';
  const port    = cfg.port || 9100;
  return `
    <div style="border:1px solid var(--bg4);border-radius:12px;padding:14px;margin-bottom:10px;background:var(--bg2)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <span style="font-weight:700;font-size:.95rem">${area.label}</span>
        <label style="display:flex;align-items:center;gap:7px;cursor:pointer">
          <span style="font-size:.72rem;color:var(--text3)">Activar</span>
          <input type="checkbox" id="prt-enabled-${area.key}" ${enabled?'checked':''}
            style="width:18px;height:18px;accent-color:var(--accent)"
            onchange="_prtToggle('${area.key}',this.checked)">
        </label>
      </div>
      <p style="font-size:.72rem;color:var(--text3);margin-bottom:10px">${area.desc}</p>
      <div id="prt-fields-${area.key}" style="display:${enabled?'block':'none'}">
        <div style="margin-bottom:10px">
          <label style="font-size:.72rem;font-weight:700;color:var(--text3);display:block;margin-bottom:4px">Tipo de conexión</label>
          <select id="prt-type-${area.key}"
            style="width:100%;padding:8px 10px;border-radius:8px;background:var(--bg3);border:1px solid var(--bg4);color:var(--text);font-size:.85rem"
            onchange="_prtTypeChange('${area.key}',this.value)">
            <option value="usb"     ${type==='usb'    ?'selected':''}>🔌 USB (directo)</option>
            <option value="network" ${type==='network'?'selected':''}>🌐 Red TCP/IP</option>
          </select>
        </div>
        <div id="prt-usb-${area.key}" style="display:${type==='usb'?'block':'none'};font-size:.75rem;padding:8px 10px;background:var(--bg3);border-radius:8px;color:var(--text3)">
          ${usbDetected
            ? '<span style="color:var(--green)">● Impresora USB detectada.</span> La primera encontrada se usa automáticamente.'
            : '<span style="color:orange">⚠ Sin USB detectado.</span> Enchufá la impresora, guardá la config y volvé a abrir este panel.'}
        </div>
        <div id="prt-net-${area.key}" style="display:${type==='network'?'block':'none'}">
          <div style="display:grid;grid-template-columns:1fr 90px;gap:8px;margin-top:2px">
            <div>
              <label style="font-size:.72rem;color:var(--text3);display:block;margin-bottom:3px">Dirección IP</label>
              <input id="prt-ip-${area.key}" type="text" value="${esc(ip)}" placeholder="192.168.1.100"
                style="width:100%;padding:7px 10px;border-radius:8px;background:var(--bg3);border:1px solid var(--bg4);color:var(--text);font-size:.85rem">
            </div>
            <div>
              <label style="font-size:.72rem;color:var(--text3);display:block;margin-bottom:3px">Puerto</label>
              <input id="prt-port-${area.key}" type="number" value="${port}"
                style="width:100%;padding:7px 10px;border-radius:8px;background:var(--bg3);border:1px solid var(--bg4);color:var(--text);font-size:.85rem">
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

function _prtToggle(area, enabled) {
  const el = document.getElementById(`prt-fields-${area}`);
  if (el) el.style.display = enabled ? 'block' : 'none';
}
function _prtTypeChange(area, type) {
  document.getElementById(`prt-usb-${area}`).style.display = type==='usb'     ? 'block' : 'none';
  document.getElementById(`prt-net-${area}`).style.display = type==='network' ? 'block' : 'none';
}

async function savePrinterConfig() {
  const areas  = ['cocina','bar','caja'];
  const config = {};
  for (const a of areas) {
    const enabledEl = document.getElementById(`prt-enabled-${a}`);
    if (!enabledEl) continue;
    config[a] = {
      enabled:  enabledEl.checked,
      type:     document.getElementById(`prt-type-${a}`)?.value  || 'usb',
      ip:       document.getElementById(`prt-ip-${a}`)?.value    || '',
      port:     parseInt(document.getElementById(`prt-port-${a}`)?.value || '9100', 10),
      encoding: 'CP858'
    };
  }
  try {
    const res  = await fetch('/api/printer-config', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ config })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Error desconocido');
    toast('Configuración de impresoras guardada ✓','success');
  } catch(e) { toast('Error guardando config: '+e.message,'error'); }
}

async function testPrinterArea() {
  const areas = ['cocina','bar','caja'];
  let area    = 'cocina';
  for (const a of areas) {
    const el = document.getElementById(`prt-enabled-${a}`);
    if (el && el.checked) { area = a; break; }
  }
  toast(`Enviando ticket de prueba (${area})…`,'success');
  try {
    const res  = await fetch('/api/printer/test', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ area })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const result = (data.results||[]).find(r => r.area === area);
    if (!result) throw new Error('Sin respuesta del servidor');
    if (result.method === 'usb' || result.method === 'network') {
      toast(`✓ Ticket impreso (${result.method})`,'success');
    } else if (result.method === 'fallback-web' && result.html) {
      if (window.POSPrinter?.printViaIframe) {
        await POSPrinter.printViaIframe(result.html, `test-${area}`);
        toast('Ticket de prueba impreso (modo navegador)','success');
      } else {
        const win = window.open('','_blank','width=400,height=600');
        if (win) { win.document.write(result.html); win.print(); win.close(); }
        toast('Ticket abierto en ventana de impresión','success');
      }
    } else if (result.method === 'skipped') {
      toast('Activá al menos un área y guardá la configuración primero','warning');
    } else {
      throw new Error(result.error || 'Resultado inesperado');
    }
  } catch(e) { toast('Error en ticket de prueba: '+e.message,'error'); }
}

// ── saveConfigServer ──────────────────────────────────────────
async function saveConfigServer() {
  try {
    const res = await fetch('/api/config/full-save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name:         S.config.name,
        address:      S.config.address,
        phone:        S.config.phone,
        currency:     S.config.currency,
        taxRate:      S.config.taxRate,
        ticketFooter: S.config.ticketFooter,
        commissions:  S.config.commissions,
        payMethods:   S.config.payMethods,
        logo:         S.config.logo
      })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    console.log('[Config] Guardado en servidor ✓');
  } catch(e) {
    console.error('[Config] Error al guardar en servidor:', e.message);
    toast('Error al guardar configuración en servidor','error');
  }
}
// ============================================================
//  DATOS Y BACKUP — Implementación de funciones
// ============================================================

// ── Exportar .JSON ───────────────────────────────────────────
async function exportData() {
  try {
    toast('Generando backup...', 'info');
    const res  = await fetch('/api/system/export');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `lmm-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('✅ Backup exportado', 'success');
  } catch (e) {
    console.error('[Export]', e);
    toast('Error al exportar: ' + e.message, 'error');
  }
}

// ── Importar .JSON ───────────────────────────────────────────
function importData(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';

  confirmDialog(
    '⚠️ Importar datos',
    'Esto reemplazará menú, inventario, empleados, mesas y configuración con el contenido del archivo. ¿Continuás?',
    async function () {
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        toast('Importando...', 'info');
        const res = await fetch('/api/system/import', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(data)
        });
        const result = await res.json();
        if (!result.success) throw new Error(result.error || 'Error desconocido');
        toast('✅ Datos importados correctamente', 'success');
        setTimeout(() => window.location.reload(), 1000);
      } catch (e) {
        console.error('[Import]', e);
        toast('Error al importar: ' + e.message, 'error');
      }
    }
  );
}

// ── Guardar Versión Manual ───────────────────────────────────
// Guarda un snapshot completo en localStorage (hasta 10 versiones)
async function saveVersionManual(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }
  try {
    const res  = await fetch('/api/system/export');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    const history = JSON.parse(localStorage.getItem('mm_history') || '[]');
    const entry   = {
      id:    Date.now(),
      date:  new Date().toLocaleString('es-AR'),
      label: `Versión manual`,
      data
    };
    history.unshift(entry);
    if (history.length > 10) history.splice(10);
    localStorage.setItem('mm_history', JSON.stringify(history));

    toast('✅ Versión guardada en historial', 'success');
    // Refrescar la tab
    loadTab('datos');
  } catch (e) {
    console.error('[SaveVersion]', e);
    toast('Error al guardar versión: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-rounded">save</span> Guardar Versión Actual'; }
  }
}

// ── Restaurar desde historial ────────────────────────────────
function restoreBackup(id) {
  const history = JSON.parse(localStorage.getItem('mm_history') || '[]');
  const entry   = history.find(b => b.id === id);
  if (!entry) return toast('Versión no encontrada', 'error');

  confirmDialog(
    '⚠️ Restaurar versión',
    `Vas a restaurar la versión del ${entry.date}. Se reemplazarán los datos actuales. ¿Continuás?`,
    async function () {
      try {
        toast('Restaurando...', 'info');
        const res = await fetch('/api/system/import', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(entry.data)
        });
        const result = await res.json();
        if (!result.success) throw new Error(result.error || 'Error desconocido');
        toast(`✅ Versión del ${entry.date} restaurada`, 'success');
        setTimeout(() => window.location.reload(), 1000);
      } catch (e) {
        console.error('[Restore]', e);
        toast('Error al restaurar: ' + e.message, 'error');
      }
    }
  );
}

// ── Formatear Sistema ────────────────────────────────────────
async function resetSystem() {
  const ok = await confirmDialog(
    '🚨 Formatear Sistema',
    'Esto borrará TODOS los pedidos, menú, mesas, empleados e inventario. La configuración del local se mantiene. Esta acción NO se puede deshacer. ¿Estás seguro?'
  );
  if (!ok) return;

  // Segunda confirmación
  const ok2 = await confirmDialog(
    '🚨 Confirmación final',
    '¿Realmente querés formatear? Todos los datos operativos se perderán.'
  );
  if (!ok2) return;

  try {
    toast('Formateando sistema...', 'info');
    const session = S.session || {};
    // Obtener contraseña del propietario para autorizar
    openModal('Confirmar contraseña', `
      <p style="margin-bottom:12px;font-size:.85rem;color:var(--text3)">Ingresá tu contraseña para autorizar el formateo.</p>
      <input type="password" id="fmt-pass" placeholder="Contraseña" style="width:100%;padding:10px;background:var(--bg2);border:1px solid var(--bg4);border-radius:8px;color:var(--text)">
    `, `
      <button class="btn btn-secondary" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-danger" onclick="_doResetSystem()">
        <span class="material-symbols-rounded">delete_forever</span> Formatear
      </button>
    `);
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

async function _doResetSystem() {
  const pass = document.getElementById('fmt-pass')?.value;
  if (!pass) return toast('Ingresá tu contraseña', 'error');
  closeModal();
  try {
    const res = await fetch('/api/system/reset', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ password: pass })
    });
    const result = await res.json();
    if (!result.success) throw new Error(result.error || 'Contraseña incorrecta');
    toast('✅ Sistema formateado', 'success');
    setTimeout(() => syncAppData(), 800);
  } catch (e) {
    console.error('[Reset]', e);
    toast('Error al formatear: ' + e.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
//  INTEGRATIONS — Guardar / Cargar configuración real
// ═══════════════════════════════════════════════════════════════

// Carga la config de MP guardada y pre-rellena los campos del formulario
async function loadMpConfig() {
  try {
    const res = await fetch('/api/mp/config');
    if (!res.ok) return;
    const cfg = await res.json();
    if (!cfg.configured) return;

    // Mostrar máscara del token y los IDs guardados
    const tokenInput = document.querySelector('#int-body-mp input[type="password"]');
    const storeInput = document.querySelector('#int-body-mp input[placeholder*="123456"]');
    const posInput   = document.querySelector('#int-body-mp input[placeholder*="CAJA"]');

    if (tokenInput && cfg.token_hint) {
      tokenInput.placeholder = `Token guardado (${cfg.token_hint})`;
    }
    if (storeInput && cfg.store_id) {
      storeInput.value = cfg.store_id;
    }
    if (posInput && cfg.pos_external_id) {
      posInput.value = cfg.pos_external_id;
    }

    // Mostrar badge de conectado en el header
    const headerName = document.querySelector('#int-card-mp .int-status-badge');
    if (!headerName) {
      const nameEl = document.querySelector('#int-card-mp [style*="font-weight:700;font-size:.92rem"]');
      if (nameEl) {
        const badge = document.createElement('span');
        badge.className = 'int-status-badge';
        badge.style.cssText = 'font-size:.6rem;font-weight:800;padding:2px 8px;border-radius:20px;background:rgba(34,197,94,.15);color:#22c55e;letter-spacing:.5px;margin-left:4px';
        badge.textContent = '✓ CONECTADO';
        nameEl.parentNode.insertBefore(badge, nameEl.nextSibling);
      }
    }
  } catch (e) {
    console.warn('[MP] Error cargando config:', e.message);
  }
}

// Guarda la integración correspondiente al card ID
async function _saveIntegration(id) {
  if (id === 'mp') {
    await _saveMpConfig();
  } else if (id === 'sync') {
    await _saveSyncConfig();
  } else {
    toast('Esta integración estará disponible próximamente', 'info');
  }
}

async function _saveSyncConfig() {
  const btn = document.getElementById('int-save-btn-sync');
  const inputs = document.querySelectorAll('#int-body-sync input');
  const [restIdInput, urlInput, keyInput] = inputs;

  const restaurant_id = restIdInput?.value.trim();
  const supabase_url = urlInput?.value.trim();
  const supabase_anon_key = keyInput?.value.trim();

  if (!restaurant_id) return toast('Ingresá el Restaurant ID', 'error');
  if (!supabase_url) return toast('Ingresá la URL de Supabase', 'error');
  if (!supabase_anon_key) return toast('Ingresá la Publishable Key', 'error');
  if (supabase_anon_key.startsWith('sb_secret_')) {
    return toast('Esa es la Secret Key — usá la Publishable Key, no esta', 'error');
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Conectando...'; }

  try {
    const res = await fetch('/api/config/link-cloud', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurant_id, supabase_url, supabase_anon_key })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Error al vincular');
    toast('¡Local vinculado a la nube! Sincronizando...', 'success');
    setTimeout(_loadSyncStatus, 1500);
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-rounded" style="font-size:14px">save</span> GUARDAR'; }
  }
}

async function _loadSyncStatus() {
  try {
    const res = await fetch('/api/config/sync-status');
    if (!res.ok) return;
    const st = await res.json();

    // Precargar los campos con lo ya guardado (para que no parezca que "no se guardó")
    const inputs = document.querySelectorAll('#int-body-sync input');
    const [restIdInput, urlInput, keyInput] = inputs;
    if (restIdInput && st.savedRestaurantId && !restIdInput.value) restIdInput.value = st.savedRestaurantId;
    if (urlInput && st.savedSupabaseUrl && !urlInput.value) urlInput.value = st.savedSupabaseUrl;
    if (keyInput && st.hasSavedKey && !keyInput.value) keyInput.placeholder = 'Key guardada (oculta por seguridad)';

    const headerName = document.querySelector('#int-card-sync [style*="font-weight:700;font-size:.92rem"]');
    if (!headerName) return;

    let badge = document.querySelector('#int-card-sync .int-status-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'int-status-badge';
      badge.style.cssText = 'font-size:.6rem;font-weight:800;padding:2px 8px;border-radius:20px;letter-spacing:.5px;margin-left:4px';
      headerName.parentNode.insertBefore(badge, headerName.nextSibling);
    }

    if (!st.enabled) {
      badge.style.background = 'var(--bg4)'; badge.style.color = 'var(--text3)';
      badge.textContent = st.savedRestaurantId ? 'GUARDADO · SIN INICIAR' : 'NO VINCULADO';
      if (st.error) badge.title = st.error;
    } else if (st.isOnline) {
      badge.style.background = 'rgba(34,197,94,.15)'; badge.style.color = '#22c55e';
      badge.textContent = st.pendingCount > 0 ? `✓ EN LÍNEA · ${st.pendingCount} pend.` : '✓ EN LÍNEA';
    } else {
      badge.style.background = 'rgba(245,158,11,.15)'; badge.style.color = '#f59e0b';
      badge.textContent = `⏳ SIN CONEXIÓN · ${st.pendingCount} pend.`;
    }
  } catch (e) {
    console.warn('[SYNC] Error consultando estado:', e.message);
  }
}

async function _saveMpConfig() {
  const btn       = document.getElementById('int-save-btn-mp');
  const tokenInput = document.querySelector('#int-body-mp input[type="password"]');
  const storeInput = document.querySelector('#int-body-mp input[placeholder*="123456"]');
  const posInput   = document.querySelector('#int-body-mp input[placeholder*="CAJA"]');

  if (!tokenInput || !storeInput || !posInput) {
    return toast('Error interno: no se encontraron los campos', 'error');
  }

  const access_token   = tokenInput.value.trim();
  const store_id       = storeInput.value.trim();
  const pos_external_id = posInput.value.trim();

  // Si el token está vacío pero hay uno guardado (campo en placeholder), pedirlo
  if (!access_token) {
    return toast('Ingresá el Access Token de producción', 'error');
  }
  if (!store_id) {
    return toast('Ingresá el ID de Sucursal (store_id)', 'error');
  }
  if (!pos_external_id) {
    return toast('Ingresá el ID de Caja (pos external_id)', 'error');
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Verificando...'; }

  try {
    const res = await fetch('/api/mp/config', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ access_token, store_id, pos_external_id }),
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || `Error ${res.status}`);
    }

    // Éxito — limpiar token del campo (no queremos que quede visible)
    tokenInput.value = '';
    tokenInput.placeholder = `Token guardado (...${access_token.slice(-6)})`;

    toast(`✅ Mercado Pago conectado — cuenta: ${data.mp_user?.email || data.mp_user?.nickname || 'OK'}`, 'success');

    // Actualizar badge de estado
    const existingBadge = document.querySelector('#int-card-mp .int-status-badge');
    if (existingBadge) {
      existingBadge.textContent = '✓ CONECTADO';
      existingBadge.style.background = 'rgba(34,197,94,.15)';
      existingBadge.style.color = '#22c55e';
    } else {
      const nameEl = document.querySelector('#int-card-mp [style*="font-weight:700;font-size:.92rem"]');
      if (nameEl) {
        const badge = document.createElement('span');
        badge.className = 'int-status-badge';
        badge.style.cssText = 'font-size:.6rem;font-weight:800;padding:2px 8px;border-radius:20px;background:rgba(34,197,94,.15);color:#22c55e;letter-spacing:.5px;margin-left:4px';
        badge.textContent = '✓ CONECTADO';
        nameEl.parentNode.insertBefore(badge, nameEl.nextSibling);
      }
    }

    // Guardar en estado local para que el modal de cobro sepa que MP está disponible
    if (window.S) S.config.mpConfigured = true;

  } catch (e) {
    toast('❌ ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-rounded" style="font-size:14px">save</span> GUARDAR'; }
  }
}
async function cleanupGhostOrders() {
  try {
    const res = await fetch('/api/system/cleanup-ghost-orders', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const data = await res.json();
    if (data.success) {
      toast(data.cancelled > 0 ? `✅ ${data.message}` : '✅ No había pedidos para limpiar', 'success');
      if (data.cancelled > 0) await syncAppData();
    } else {
      toast('Error: ' + (data.error || 'desconocido'), 'error');
    }
  } catch (e) {
    toast('Error de conexión al limpiar pedidos', 'error');
  }
}