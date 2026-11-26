// ============================================================
//  auth.js — Módulo de Autenticación
//  UBICACIÓN: raíz del proyecto (mismo nivel que server.js)
//
//  Lógica de login propietario:
//  ┌─────────────────────────────────────────────────────────┐
//  │  PC NUEVA (sin config local):                           │
//  │    → Intenta verificar en Firebase (opcional)           │
//  │    → Si Firebase falla/no disponible: igual permite     │
//  │      el login y guarda credenciales localmente          │
//  │                                                         │
//  │  PC CONFIGURADA (tiene email+pass local):               │
//  │    → Verifica email + contraseña localmente             │
//  │    → Firebase solo se consulta para suspensión/pendiente│
//  │    → Si Firebase falla: igual deja entrar               │
//  └─────────────────────────────────────────────────────────┘
// ============================================================

const { db, saveLocalSession, getLocalSession, clearLocalSession,
        updateLicenseTimestamp, safeLower, safeStr, safeJSON } = require('./db');

const logger    = require('./logger');
const bcrypt    = require('bcrypt');
const rateLimit = require('express-rate-limit');
const path      = require('path');

const FIREBASE_URL = process.env.FIREBASE_DATABASE_URL;

// ============================================================
//  checkFirebaseLicense — NUNCA lanza excepción, siempre resuelve
//  Retorna: { estado: 'activo'|'pendiente'|'suspendido'|'sin_conexion'|'no_encontrado', data: {} }
// ============================================================
async function checkFirebaseLicense(email, timeoutMs = 5000, idToken = null) {
  const cleanEmail = safeLower(email);
  if (!cleanEmail || !FIREBASE_URL) return { estado: 'sin_conexion', data: null };

  const userKey = cleanEmail.replace(/\./g, '_');

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Construir URL con auth token si está disponible (requerido por las nuevas reglas RTDB)
    const url = idToken
      ? `${FIREBASE_URL}/licencias/${userKey}.json?auth=${encodeURIComponent(idToken)}`
      : `${FIREBASE_URL}/licencias/${userKey}.json`;

    const resp = await fetch(url, {
      cache: 'no-store',
      signal: controller.signal
    });
    clearTimeout(timer);

    // 403/401 = App Check activo o reglas restrictivas → tratar como sin_conexion
    if (resp.status === 403 || resp.status === 401) {
      logger.warn(`[Licencia] Firebase bloqueó el acceso (${resp.status}) — modo offline`);
      return { estado: 'sin_conexion', data: null };
    }

    if (!resp.ok) {
      logger.warn(`[Licencia] Firebase status ${resp.status}`);
      return { estado: 'sin_conexion', data: null };
    }

    const data = await resp.json();
    if (!data) return { estado: 'no_encontrado', data: null };

    const estado = (data && typeof data === 'object') ? data.estado : data;
    logger.info(`[Licencia] Estado Firebase para ${cleanEmail}: ${estado}`);
    return { estado: safeStr(estado, 'no_encontrado'), data };

  } catch (err) {
    if (err.name === 'AbortError') {
      logger.warn(`[Licencia] Timeout Firebase para ${cleanEmail}`);
    } else {
      logger.warn(`[Licencia] Firebase no disponible: ${err.message}`);
    }
    return { estado: 'sin_conexion', data: null };
  }
}

// ============================================================
//  registerInFirebase — registra cuenta nueva como 'pendiente'
// ============================================================
async function registerInFirebase(userData) {
  const cleanEmail = safeLower(userData.email);
  if (!cleanEmail || !FIREBASE_URL) return false;

  const userKey = cleanEmail.replace(/\./g, '_');
  const payload = {
    email:          cleanEmail,
    restaurant:     safeStr(userData.restaurant, 'Sin nombre'),
    name:           safeStr(userData.name, 'Propietario'),
    estado:         'pendiente',
    registeredAt:   new Date().toISOString(),
    lastConnection: Date.now()
  };

  try {
    const resp = await fetch(`${FIREBASE_URL}/${userKey}.json`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });
    return resp.ok;
  } catch (err) {
    logger.error('[Auth] Error registrando en Firebase:', err.message);
    return false;
  }
}

// ============================================================
//  RUTAS
//
//  _ctx (opcional, solo en tests) permite inyectar:
//    { db, getLocalSession, saveLocalSession, clearLocalSession, updateLicenseTimestamp }
//  En producción se omite y se usan los singletons de ./db
// ============================================================
function registerAuthRoutes(app, notifyChange, _ctx = null) {

  // ── Resolución de dependencias (producción vs tests) ──────
  const _db              = _ctx?.db                      || db;
  const _getLocal        = _ctx?.getLocalSession         || getLocalSession;
  const _saveLocal       = _ctx?.saveLocalSession        || saveLocalSession;
  const _clearLocal      = _ctx?.clearLocalSession       || clearLocalSession;
  const _updateLicense   = _ctx?.updateLicenseTimestamp  || updateLicenseTimestamp;

  // Rate limiter: 10 intentos por IP cada 15 minutos
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    handler: (_req, res) => {
      res.status(429).json({
        success: false,
        message: 'Demasiados intentos. Acceso bloqueado 15 minutos por seguridad.'
      });
    },
    standardHeaders: true,
    legacyHeaders:   false
  });

  app.use('/api/login/', loginLimiter);
  app.use('/api/auth/register', loginLimiter);

  // Rate limiter específico para staff PIN (más estricto: PIN de 4 dígitos tiene
  // sólo 10.000 combinaciones — un límite bajo es esencial contra fuerza bruta).
  const staffPinLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 10,                   // 10 intentos por IP y ventana
    skipSuccessfulRequests: false,
    handler: (_req, res) => {
      res.status(429).json({
        success: false,
        message: 'Demasiados intentos de PIN. Acceso bloqueado 15 minutos por seguridad.'
      });
    },
    standardHeaders: true,
    legacyHeaders:   false
  });
  app.use('/api/login/staff', staffPinLimiter);

  // ── AUTO-LOGIN ────────────────────────────────────────────
  app.get('/api/auth/session', async (_req, res) => {
    try {
      const session = await _getLocal();
      if (!session) return res.json({ success: false, reason: 'no_session' });

      res.json({
        success: true,
        user: {
          email:      safeStr(session.email),
          name:       safeStr(session.name, 'Usuario'),
          role:       safeStr(session.role, 'staff'),
          restaurant: safeStr(session.restaurant),
          isClient:   session.is_client === 1,
          lastLogin:  session.last_login || 0
        }
      });
    } catch (err) {
      logger.error('[Auth] Error en /api/auth/session:', err.message);
      res.status(500).json({ success: false, reason: 'server_error' });
    }
  });

  // ── LOGIN PROPIETARIO ─────────────────────────────────────
  app.post('/api/login/owner', async (req, res) => {

    // 1. Extraer campos
    const rawEmail    = req.body?.email;
    const rawPassword = req.body?.password;

    if (!rawEmail || !rawPassword) {
      return res.status(400).json({ success: false, message: 'Email y contraseña son requeridos' });
    }

    const email = safeLower(rawEmail);

    // 2. Decodificar contraseña (el frontend la envía en Base64 con btoa())
    let password;
    try {
      password = safeStr(Buffer.from(rawPassword, 'base64').toString('utf8'));
    } catch (_) {
      password = safeStr(rawPassword);
    }

    // 3. Validaciones básicas
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(email)) {
      return res.status(400).json({ success: false, message: 'Formato de email inválido' });
    }
    if (password.length < 4) {
      return res.status(400).json({ success: false, message: 'Contraseña demasiado corta' });
    }

    logger.info(`[Auth] Intento de login propietario: ${email}`);

    // ══════════════════════════════════════════════════════════════
    //  PASO 1: Verificar credenciales en Firebase Authentication
    //  Usamos la REST API de Firebase Auth para validar email+pass.
    //  Si Firebase no responde, caemos al flujo local (offline).
    // ═════════════════════════════════════════════════════════════
    const firebaseApiKey = process.env.FIREBASE_API_KEY;
    let firebaseAuthOk   = false;  // true = Firebase confirmo las credenciales
    let firebaseAuthErr  = null;   // 'INVALID_PASSWORD' | 'EMAIL_NOT_FOUND' | 'sin_conexion'
    let firebaseIdToken  = null;   // idToken para leer RTDB autenticado

    if (firebaseApiKey) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 6000);

        const fbAuthRes = await fetch(
          `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseApiKey}`,
          {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ email, password, returnSecureToken: true }),
            signal:  controller.signal
          }
        );
        clearTimeout(timer);

        const fbAuthData = await fbAuthRes.json();

        if (fbAuthRes.ok && fbAuthData.localId) {
          // Firebase confirmo email + contrasena correctos
          firebaseAuthOk  = true;
          firebaseIdToken = fbAuthData.idToken || null; // guardar para leer RTDB autenticado
          logger.info(`[Auth] Firebase Auth OK para: ${email}`);
        } else {
          // Firebase respondio con error de credenciales
          const errCode = fbAuthData?.error?.message || 'UNKNOWN';
          logger.warn(`[Auth] Firebase Auth rechazo: ${email} -- ${errCode}`);

          if (errCode.includes('INVALID_PASSWORD') || errCode.includes('INVALID_LOGIN_CREDENTIALS')) {
            firebaseAuthErr = 'INVALID_PASSWORD';
          } else if (errCode.includes('EMAIL_NOT_FOUND') || errCode.includes('USER_NOT_FOUND')) {
            firebaseAuthErr = 'EMAIL_NOT_FOUND';
          } else if (errCode.includes('USER_DISABLED')) {
            firebaseAuthErr = 'USER_DISABLED';
          } else if (errCode.includes('TOO_MANY_ATTEMPTS') || errCode.includes('TOO_MANY_REQUESTS')) {
            return res.status(429).json({
              success: false,
              message: 'Cuenta bloqueada temporalmente por demasiados intentos. Intenta en unos minutos.'
            });
          } else {
            firebaseAuthErr = 'sin_conexion'; // error desconocido -> modo offline
          }
        }
      } catch (err) {
        // Timeout o sin internet -> modo offline
        logger.warn(`[Auth] Firebase Auth no disponible: ${err.message}`);
        firebaseAuthErr = 'sin_conexion';
      }
    } else {
      // Sin API key configurada -> modo offline directo
      logger.warn('[Auth] FIREBASE_API_KEY no configurada -- verificacion solo local');
      firebaseAuthErr = 'sin_conexion';
    }

    // Si Firebase confirmo que las credenciales son INCORRECTAS, rechazar ya
    // Solo bloqueamos si Firebase respondio con certeza (no si fue timeout/sin_conexion)
    if (firebaseAuthErr === 'INVALID_PASSWORD') {
      return res.status(401).json({ success: false, message: 'Email o contrasena incorrectos' });
    }
    if (firebaseAuthErr === 'EMAIL_NOT_FOUND') {
      return res.status(401).json({ success: false, message: 'No existe una cuenta con ese email' });
    }
    if (firebaseAuthErr === 'USER_DISABLED') {
      return res.status(403).json({ success: false, message: 'Esta cuenta ha sido deshabilitada' });
    }
    // Si firebaseAuthErr === 'sin_conexion' -> continuamos con verificacion local


    _db.get('SELECT * FROM config WHERE id = 1', async (err, row) => {
      if (err) {
        logger.error('[Auth] Error leyendo config:', err.message);
        return res.status(500).json({ success: false, message: 'Error interno del servidor' });
      }

      const isFirstLogin = !row || !row.master_email || row.master_email.trim() === '';

      // ══════════════════════════════════════════════════════
      //  CASO A: PC nueva (sin config local)
      //  → Intentar Firebase; si no responde, igual crear cuenta
      // ══════════════════════════════════════════════════════
      if (isFirstLogin) {
        logger.info('[Auth] PC nueva — verificando licencia en Firebase...');

        const { estado: licenseStatus, data: fbData } = await checkFirebaseLicense(email, 5000, firebaseIdToken);

        // Solo bloqueamos en casos explícitos
        if (licenseStatus === 'suspendido') {
          return res.status(403).json({
            success: false,
            message: '⛔ La licencia ha sido suspendida. Contactá al soporte.',
            licenseStatus: 'suspendido'
          });
        }
        if (licenseStatus === 'pendiente') {
          return res.status(403).json({
            success: false,
            message: '⏳ Tu cuenta está pendiente de activación. Contactá al soporte.',
            licenseStatus: 'pendiente'
          });
        }

        // 'activo', 'no_encontrado', 'sin_conexion' → crear cuenta local
        logger.info(`[Auth] Firebase: ${licenseStatus} — vinculando PC`);

        const restaurantName = (fbData && fbData.restaurant)
          ? safeStr(fbData.restaurant)
          : (fbData && fbData.restaurante)
            ? safeStr(fbData.restaurante)
            : 'Mi Restaurante';

        const ownerName = (fbData && fbData.name)
          ? safeStr(fbData.name)
          : (fbData && fbData.propietario)
            ? safeStr(fbData.propietario)
            : 'Propietario';

        const hashedPassword = bcrypt.hashSync(password, 10);

        _db.run(
          `INSERT OR REPLACE INTO config (id, restaurant_name, master_email, master_pass, currency)
           VALUES (1, ?, ?, ?, '$')`,
          [restaurantName, email, hashedPassword],
          (insertErr) => {
            if (insertErr) {
              logger.error('[Auth] Error vinculando cuenta:', insertErr.message);
              return res.status(500).json({ success: false, message: 'Error al guardar cuenta local' });
            }

            const userData = {
              email,
              name:          ownerName,
              role:          'owner',
              restaurant:    restaurantName,
              isClient:      false,
              licenseStatus: licenseStatus === 'activo' ? 'activo' : 'sin_conexion'
            };

            _saveLocal(userData);
            if (licenseStatus === 'activo') _updateLicense();
            notifyChange('config:updated');

            logger.info(`[Auth] ✅ PC vinculada: ${email}`);
            return res.json({ success: true, user: userData });
          }
        );
        return;
      }

      // ══════════════════════════════════════════════════════
      //  CASO B: PC ya configurada
      // ══════════════════════════════════════════════════════
      const storedEmail = safeLower(row.master_email);
      const storedPass  = safeStr(row.master_pass);

      // ── B0: Email diferente al guardado ───────────────────
      if (storedEmail !== email) {
        logger.info(`[Auth] Email distinto (${storedEmail} vs ${email}) — verificando Firebase...`);

        const { estado: b0Status, data: b0Data } = await checkFirebaseLicense(email, 5000, firebaseIdToken);

        if (b0Status === 'suspendido') {
          return res.status(403).json({ success: false, message: '⛔ Licencia suspendida.', licenseStatus: 'suspendido' });
        }
        if (b0Status === 'pendiente') {
          return res.status(403).json({ success: false, message: '⏳ Cuenta pendiente de activación.', licenseStatus: 'pendiente' });
        }
        if (b0Status === 'no_encontrado') {
          return res.status(401).json({ success: false, message: '❌ No se encontró una cuenta con este email.' });
        }

        // 'activo' o 'sin_conexion' → vincular
        const hashedNewPass    = bcrypt.hashSync(password, 10);
        const restaurantFromFb = (b0Data && b0Data.restaurant)
          ? safeStr(b0Data.restaurant)
          : (b0Data && b0Data.restaurante)
            ? safeStr(b0Data.restaurante)
            : safeStr(row.restaurant_name, 'Mi Restaurante');
        const nameFromFb = (b0Data && b0Data.name)
          ? safeStr(b0Data.name)
          : (b0Data && b0Data.propietario)
            ? safeStr(b0Data.propietario)
            : 'Propietario';

        _db.run(
          'UPDATE config SET master_email = ?, master_pass = ?, restaurant_name = ? WHERE id = 1',
          [email, hashedNewPass, restaurantFromFb],
          (e) => { if (e) logger.error('[Auth] Error vinculando cuenta:', e.message); }
        );

        const userData = {
          email, name: nameFromFb, role: 'owner',
          restaurant: restaurantFromFb, isClient: false,
          licenseStatus: b0Status === 'activo' ? 'activo' : 'sin_conexion'
        };
        _saveLocal(userData);
        if (b0Status === 'activo') _updateLicense();
        return res.json({ success: true, user: userData });
      }

      // ── B1: Email coincide → verificar contraseña ─────────
      // Soporte para hashes $2a$ (bcrypt antiguo) y $2b$ (bcrypt moderno)
      const isBcryptHash = storedPass.startsWith('$2b$') || storedPass.startsWith('$2a$');
      const isLegacy     = !isBcryptHash;
      const passMatches  = isBcryptHash
        ? bcrypt.compareSync(password, storedPass)
        : storedPass === password;

      if (passMatches) {
        logger.info('[Auth] ✅ Credenciales locales correctas');

        if (isLegacy) {
          logger.info('[Auth] Migrando contraseña a bcrypt...');
          _db.run('UPDATE config SET master_pass = ? WHERE id = 1', [bcrypt.hashSync(password, 10)]);
        }

        // Firebase solo para detectar suspensión/pendiente; si falla no importa
        const { estado: licenseStatus } = await checkFirebaseLicense(email, 5000, firebaseIdToken);

        if (licenseStatus === 'suspendido') {
          return res.status(403).json({
            success: false,
            message: '⛔ La licencia ha sido suspendida.',
            licenseStatus: 'suspendido'
          });
        }
        if (licenseStatus === 'pendiente') {
          return res.status(403).json({
            success: false,
            message: '⏳ Cuenta pendiente de activación.',
            licenseStatus: 'pendiente'
          });
        }

        const userData = {
          email:         safeStr(row.master_email, email),
          name:          'Propietario',
          role:          'owner',
          restaurant:    safeStr(row.restaurant_name, 'Mi Restaurante'),
          isClient:      false,
          licenseStatus: licenseStatus === 'activo' ? 'activo' : 'sin_conexion'
        };

        _saveLocal(userData);
        if (licenseStatus === 'activo') _updateLicense();

        logger.info(`[Auth] ✅ Login exitoso: ${email}`);
        return res.json({ success: true, user: userData });
      }

      // ── B2: Contraseña incorrecta — último recurso Firebase ─
      logger.info('[Auth] Contraseña local incorrecta — verificando Firebase...');

      const { estado: fallbackStatus } = await checkFirebaseLicense(email, 5000, firebaseIdToken);

      if (fallbackStatus === 'activo') {
        logger.info(`[Auth] ✅ Firebase activo — actualizando credenciales: ${email}`);
        const hashedNewPass = bcrypt.hashSync(password, 10);
        _db.run(
          'UPDATE config SET master_email = ?, master_pass = ? WHERE id = 1',
          [email, hashedNewPass],
          (e) => { if (e) logger.error('[Auth] Error actualizando credenciales:', e.message); }
        );
        const userData = {
          email, name: 'Propietario', role: 'owner',
          restaurant: safeStr(row.restaurant_name, 'Mi Restaurante'),
          isClient: false, licenseStatus: 'activo'
        };
        _saveLocal(userData);
        _updateLicense();
        return res.json({ success: true, user: userData });
      }

      if (fallbackStatus === 'suspendido') {
        return res.status(403).json({ success: false, message: '⛔ Licencia suspendida.', licenseStatus: 'suspendido' });
      }
      if (fallbackStatus === 'pendiente') {
        return res.status(403).json({ success: false, message: '⏳ Cuenta pendiente.', licenseStatus: 'pendiente' });
      }

      // No hay "fallback offline" que deje entrar con contraseña incorrecta.
      // Antes existía un bypass (email coincidía + Firebase sin conexión = login
      // automático + re-hash de la contraseña), pero era inseguro: cualquier
      // persona con el email del dueño podía acceder offline con cualquier
      // contraseña y además corrompía el hash guardado. La contraseña local
      // siempre debe verificarse contra el hash de la BD.

      // Firebase no disponible + contraseña incorrecta + email diferente = rechazar
      logger.warn(`[Auth] Login fallido: ${email} — pass incorrecta, Firebase: ${fallbackStatus}`);
      return res.status(401).json({ success: false, message: 'Email o contraseña incorrectos' });
    });
  });

  // ── LOGIN STAFF ───────────────────────────────────────────
  app.post('/api/login/staff', (req, res) => {
    const rawRestaurant = req.body?.restaurant;
    const rawName       = req.body?.name;
    const rawPin        = req.body?.pin;

    if (!rawRestaurant || !rawName || !rawPin) {
      return res.status(400).json({ success: false, message: 'Nombre del local, nombre y PIN son requeridos' });
    }

    const restaurant = safeStr(rawRestaurant);
    const name       = safeStr(rawName);
    const pin        = safeStr(rawPin);

    _db.get('SELECT restaurant_name FROM config WHERE id = 1', (err, config) => {
      if (err) {
        logger.error('[Auth] Error leyendo config para staff:', err.message);
        return res.status(500).json({ success: false, message: 'Error interno del servidor' });
      }

      const officialName = safeStr(config?.restaurant_name);
      if (!officialName || safeLower(restaurant) !== safeLower(officialName)) {
        return res.status(401).json({ success: false, message: 'Nombre del local incorrecto' });
      }

      _db.get(
        'SELECT * FROM employees WHERE name = ? AND active = 1',
        [name],
        (empErr, emp) => {
          if (empErr) {
            logger.error('[Auth] Error validando empleado:', empErr.message);
            return res.status(500).json({ success: false, message: 'Error interno del servidor' });
          }
          if (!emp) {
            return res.status(401).json({ success: false, message: 'Nombre o PIN incorrecto' });
          }

          // Soporte legacy: PINs aún en plano (antes de la migración a bcrypt)
          const isLegacyPin = !emp.pin.startsWith('$2b$');
          const validPin = isLegacyPin
            ? pin === emp.pin
            : bcrypt.compareSync(pin, emp.pin);

          if (!validPin) {
            return res.status(401).json({ success: false, message: 'PIN incorrecto' });
          }

          // Migrar PIN legacy a bcrypt en segundo plano
          if (isLegacyPin) {
            const hashed = bcrypt.hashSync(pin, 10);
            _db.run('UPDATE employees SET pin = ? WHERE id = ?', [hashed, emp.id], (migrErr) => {
              if (migrErr) logger.warn('[Auth] No se pudo migrar PIN a bcrypt:', migrErr.message);
              else logger.info(`[Auth] PIN de ${emp.name} migrado a bcrypt`);
            });
          }

          const userData = {
            email:      null,
            name:       safeStr(emp.name),
            role:       safeStr(emp.role, 'waiter'),
            restaurant: officialName,
            isClient:   true
          };

          _saveLocal(userData);
          logger.info(`[Auth] ✅ Login staff: ${emp.name} (${emp.role})`);
          res.json({ success: true, user: userData });
        }
      );
    });
  });

  // ── REGISTRO ──────────────────────────────────────────────
  app.post('/api/auth/register', async (req, res) => {
    const rawRestaurant = req.body?.restaurant;
    const rawName       = req.body?.name;
    const rawEmail      = req.body?.email;
    const rawPassword   = req.body?.password;

    if (!rawRestaurant || !rawName || !rawEmail || !rawPassword) {
      return res.status(400).json({ success: false, message: 'Todos los campos son requeridos' });
    }

    const email          = safeLower(rawEmail);
    const name           = safeStr(rawName);
    const restaurant     = safeStr(rawRestaurant);
    const password       = safeStr(rawPassword);
    const hashedPassword = bcrypt.hashSync(password, 10);

    const firebaseOk = await registerInFirebase({ email, name, restaurant });
    if (!firebaseOk) {
      logger.warn('[Auth] No se pudo registrar en Firebase — solo local');
    }

    _db.run(
      `INSERT OR REPLACE INTO config (id, restaurant_name, master_email, master_pass, currency)
       VALUES (1, ?, ?, ?, '$')`,
      [restaurant, email, hashedPassword],
      (err) => {
        if (err) {
          logger.error('[Auth] Error guardando registro:', err.message);
          return res.status(500).json({ success: false, message: 'Error al guardar registro' });
        }

        logger.info(`[Auth] ✅ Propietario registrado: ${email}`);
        notifyChange('config:updated');

        res.json({
          success: true,
          licenseStatus: firebaseOk ? 'pendiente' : 'local',
          message: firebaseOk
            ? 'Cuenta creada. Contactá al soporte para activar tu licencia.'
            : 'Cuenta creada localmente. Conectate a Internet para sincronizar tu licencia.'
        });
      }
    );
  });

  // ── LOGOUT ────────────────────────────────────────────────
  app.post('/api/auth/logout', (_req, res) => {
    _clearLocal();
    res.json({ success: true });
  });

  // ── CAMBIO DE CONTRASEÑA ──────────────────────────────────
  app.post('/api/auth/change-password', (req, res) => {
    const rawCurrentPass = req.body?.currentPassword;
    const rawNewPass     = req.body?.newPassword;

    if (!rawCurrentPass || !rawNewPass) {
      return res.status(400).json({ success: false, message: 'Contraseña actual y nueva son requeridas' });
    }

    const currentPass = safeStr(rawCurrentPass);
    const newPass     = safeStr(rawNewPass);

    _db.get('SELECT master_pass FROM config WHERE id = 1', (err, row) => {
      if (err)  return res.status(500).json({ success: false, message: 'Error interno' });
      if (!row) return res.status(404).json({ success: false, message: 'No existe configuración' });

      const isLegacy = !row.master_pass.startsWith('$2b$');
      const matches  = isLegacy
        ? row.master_pass === currentPass
        : bcrypt.compareSync(currentPass, row.master_pass);

      if (!matches) {
        return res.status(401).json({ success: false, message: 'Contraseña actual incorrecta' });
      }

      _db.run('UPDATE config SET master_pass = ? WHERE id = 1', [bcrypt.hashSync(newPass, 10)], (e) => {
        if (e) return res.status(500).json({ success: false, message: 'Error al actualizar contraseña' });
        logger.info('[Auth] ✅ Contraseña actualizada');
        res.json({ success: true });
      });
    });
  });

  // ── VERIFICAR LICENCIA ────────────────────────────────────
  app.get('/api/auth/license', async (req, res) => {
    const email = safeLower(req.query?.email);
    if (!email) return res.status(400).json({ success: false, message: 'Email requerido' });

    // Sin idToken disponible en esta ruta GET — la función cae a modo offline si la regla
    // requiere autenticación. El token idToken sólo existe durante el flujo de login.
    const { estado: licenseStatus } = await checkFirebaseLicense(email, 5000, null);
    if (licenseStatus === 'activo') _updateLicense();
    res.json({ success: true, licenseStatus });
  });


  // ── RESET DE EMERGENCIA (para migración de BD antigua) ────
  // Solo funciona si el email enviado coincide con el master_email guardado.
  // Rate-limited via loginLimiter (ya aplicado a /api/auth/*) para prevenir abuso.
  // El token opcional se lee del .env (NUNCA hardcodeado): si el operador no lo
  // configura en el entorno, la única barrera de seguridad es que el email tenga
  // que coincidir exactamente con master_email + el rate-limit por IP.
  app.post('/api/auth/reset-local', loginLimiter, (req, res) => {
    const rawEmail   = req.body?.email;
    const rawPassword = req.body?.password;
    const resetToken  = req.body?.token;
    const RESET_TOKEN = process.env.RESET_TOKEN || '';

    if (!rawEmail || !rawPassword) {
      return res.status(400).json({ success: false, message: 'Datos invalidos' });
    }
    // Si hay un RESET_TOKEN configurado en el entorno, debe coincidir.
    if (RESET_TOKEN && resetToken !== RESET_TOKEN) {
      return res.status(400).json({ success: false, message: 'Datos invalidos o token incorrecto' });
    }

    const email = safeLower(rawEmail);
    let password;
    try {
      password = safeStr(Buffer.from(rawPassword, 'base64').toString('utf8'));
    } catch (_) {
      password = safeStr(rawPassword);
    }

    // Validaciones mínimas sobre la contraseña ANTES de tocar la BD
    if (!password || password.length < 4) {
      return res.status(400).json({ success: false, message: 'La contraseña debe tener al menos 4 caracteres.' });
    }
    if (password.length > 128) {
      return res.status(400).json({ success: false, message: 'La contraseña es demasiado larga.' });
    }

    _db.get('SELECT * FROM config WHERE id = 1', (err, row) => {
      if (err || !row) return res.status(404).json({ success: false, message: 'Sin configuracion guardada' });
      if (safeLower(row.master_email) !== email)
        return res.status(403).json({ success: false, message: 'El email no coincide con el registrado' });

      const newHash = bcrypt.hashSync(password, 10);
      _db.run('UPDATE config SET master_pass = ? WHERE id = 1', [newHash], (e) => {
        if (e) return res.status(500).json({ success: false, message: 'Error al actualizar contrasena' });
        logger.info('[Auth] Reset de emergencia aplicado: ' + email);
        // Nunca devolver la contraseña en la respuesta
        res.json({ success: true, message: 'Contrasena reseteada. Ya podes iniciar sesion.' });
      });
    });
  });

  logger.info('✅ [Auth] Rutas de autenticación registradas');
}

module.exports = { registerAuthRoutes, checkFirebaseLicense, registerInFirebase };
// NOTE: patch applied below — reset route injected before module.exports