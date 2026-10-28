/**
 * mijokerService.js — CLIENTE de la Operator API v0.1 (mijoker.com) — PLATFORM_MODE=mijoker.
 *
 * Plataforma "copia de GANAMOS" que SÍ expone una API REST (doc transcripta en
 * `docs/API-MIJOKER-OPERATOR-v0.1.md`). Este módulo implementa EXACTAMENTE el mismo
 * contrato que `giroxService.js` / `ganamosPlatformService.js` (mismos nombres,
 * parámetros y formas de retorno; `scripts/test-mijoker-adapter.js` lo verifica
 * export por export) para que los ~130 puntos de server.js no cambien.
 *
 * Qué tiene la API: alta de jugador, datos y saldo por username, transferencia
 * INCOME/OUTCOME (carga/descuento), historial de saldo por id, cambio de clave y
 * estado ACTIVE/BANNED. Qué NO tiene: reference/idempotencia, bonos, rollover,
 * netwin, SSO, validación de clave del jugador, saldo del agente.
 *
 * ⚠️ IDEMPOTENCIA SIN IDEMPOTENCIA (la parte delicada):
 *   `POST /account-transfers` acredita cada vez que se llama. Para mantener la regla
 *   de oro del repo (misma reference = misma plata, reintento = duplicate:true) cada
 *   operación se registra ANTES en `PlatformOp` (índice único por reference):
 *     - ya `done`      → duplicate:true sin tocar la API.
 *     - ya `pending`   → `in_progress` (otra instancia la está mandando); si lleva
 *                        más de IN_FLIGHT_MS, el proceso murió → se trata como unknown.
 *     - `failed`       → la API la rechazó sin moverla: se vuelve a mandar.
 *     - `unknown`      → timeout/red/5xx: ANTES de mandar de nuevo se reconcilia con
 *                        `balance-history` (monto + operación + ventana desde que se
 *                        mandó, sin contar ítems ya atribuidos a otra operación).
 *   La llamada de plata NUNCA se reintenta sola (retryable:false). Si el resultado
 *   queda sin confirmar y el historial tampoco responde, el flujo recibe
 *   `code:'unknown_outcome'` y un listener (server.js) deja la nota al agente.
 *
 * Config (lazy, SSM carga después del require): MIJOKER_API_URL (base, sin barra
 * final; el Swagger sólo muestra localhost:3000, la real la da la plataforma),
 * MIJOKER_API_TOKEN (Bearer), MIJOKER_AGENT_NAME (agentName del alta),
 * MIJOKER_PLAY_URL (botón CASINO, pestaña), MIJOKER_TIMEOUT_MS (20000),
 * MIJOKER_MAX_RPM (55, limitador local por proceso), MIJOKER_PLAYER_CACHE_MS (8000).
 */
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const _fileLogger = require('../utils/logger');
const PlatformOp = require('../models/PlatformOp');

const logger = {
  info: (...a) => { try { _fileLogger.info(...a); } catch (_) {} },
  warn: (...a) => {
    try { _fileLogger.warn(...a); } catch (_) {}
    try { console.warn(`[${new Date().toISOString()}]`, ...a); } catch (_) {}
  },
  error: (...a) => {
    try { _fileLogger.error(...a); } catch (_) {}
    try { console.error(`[${new Date().toISOString()}]`, ...a); } catch (_) {}
  }
};

// ============================================================
// CONFIG (lazy)
// ============================================================
function getBaseUrl() { return String(process.env.MIJOKER_API_URL || '').trim().replace(/\/+$/, ''); }
function getApiToken() { return process.env.MIJOKER_API_TOKEN || null; }
function getAgentName() { return String(process.env.MIJOKER_AGENT_NAME || '').trim() || null; }
// #247: override desde COMANDOS (/sys_casino_url), igual que en el adaptador manual.
let _playUrlOverride = null;
function setPlayUrlOverride(url) { _playUrlOverride = url ? String(url).trim() : null; }
function getPlayUrl() { return (_playUrlOverride || process.env.MIJOKER_PLAY_URL || 'https://mijoker.com').replace(/\/+$/, ''); }
/** true si el cliente puede operar (URL + token; el agentName sólo hace falta para el alta). */
function isEnabled() { return !!(getBaseUrl() && getApiToken()); }
function _timeoutMs() { return Number(process.env.MIJOKER_TIMEOUT_MS || 20000); }
// #232 el proveedor confirmó que HOY no hay rate limit (si lo activan: 429 + Retry-After, ya
// contemplado). El límite local queda como freno para no quedar marcados como "volumen excesivo".
function _maxRpm() { return Number(process.env.MIJOKER_MAX_RPM || 120); }
/** #232 el token vence al AÑO de generado (panel de administración, máx. 3 activos). Opcional:
 *  MIJOKER_TOKEN_EXPIRES_AT=YYYY-MM-DD para que el boot y "Probar conexión" avisen antes. */
function getTokenExpiry() {
  const raw = String(process.env.MIJOKER_TOKEN_EXPIRES_AT || '').trim();
  if (!raw) return null;
  const d = new Date(raw.length === 10 ? raw + 'T23:59:59-03:00' : raw);
  return Number.isNaN(d.getTime()) ? null : d;
}
function tokenExpiryWarning() {
  const d = getTokenExpiry();
  if (!d) return null;
  const days = Math.floor((d.getTime() - Date.now()) / 86400000);
  if (days < 0) return `⚠️ el token de la Operator API VENCIÓ el ${d.toLocaleDateString('es-AR')} (MIJOKER_TOKEN_EXPIRES_AT): generá uno nuevo en el panel de administración de la plataforma y cargalo en SSM`;
  if (days <= 30) return `⚠️ el token de la Operator API vence en ${days} día(s) (${d.toLocaleDateString('es-AR')}): generá uno nuevo en el panel de administración de la plataforma antes`;
  return null;
}
function _playerCacheTtlMs() { return Number(process.env.MIJOKER_PLAYER_CACHE_MS || 8000); }

const API_PREFIX = '/api/operator/v1';
// Una operación `pending` más vieja que esto no está en vuelo: el proceso murió.
const IN_FLIGHT_MS = Number(process.env.MIJOKER_IN_FLIGHT_MS || 120000);
// Ventana hacia atrás (tolerancia de reloj) al buscar la operación en el historial.
const RECONCILE_SKEW_MS = 60000;
const RECONCILE_MAX_PAGES = 3; // 3 × 30 ítems
const RETRY_DELAYS_MS = [2000, 5000, 15000]; // sólo lecturas y escrituras NO de plata

// ============================================================
// HOOKS inyectados por server.js (mismo contrato que giroxService)
// ============================================================
let _rolloverResolver = null;
let _cashierHook = null;
let _keyResolver = null;
let _opListener = null;
function setRolloverResolver(fn) { _rolloverResolver = typeof fn === 'function' ? fn : null; } // ignorado: sin rollover
function setCashierBalanceHook(fn) { _cashierHook = (typeof fn === 'function') ? fn : null; }    // la API no informa saldo del agente
function setKeyResolver(fn) { _keyResolver = typeof fn === 'function' ? fn : null; }            // un solo token
/** (event, op) con event = 'unknown' | 'done' | 'failed' | 'reconciled'. server.js avisa al agente. */
function setOpListener(fn) { _opListener = typeof fn === 'function' ? fn : null; }
async function _emitOp(event, op) {
  if (!_opListener || !op) return;
  try { await _opListener(event, op); } catch (e) { logger.warn(`[mijoker] listener ${event} ${op.reference}: ${e.message}`); }
}

// ============================================================
// HELPERS
// ============================================================
function errToString(err) {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === 'object') return err.message || err.error || (function () { try { return JSON.stringify(err); } catch (_) { return String(err); } })();
  return String(err);
}
function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function validateUsername(username) {
  const u = String(username || '').trim();
  if (u.length < 3) return { valid: false, reason: 'menos de 3 caracteres' };
  if (u.length > 30) return { valid: false, reason: `${u.length} caracteres (máximo 30)` };
  if (!/^[A-Za-z0-9_.-]+$/.test(u)) return { valid: false, reason: 'tiene caracteres no permitidos (sólo letras, números, _ . -)' };
  return { valid: true };
}
// Patrón de la API para la clave (ChangePasswordRequestBodyDto): 3-32 caracteres de ese set.
const PASSWORD_RE = /^[a-zA-Z0-9\-_ `~!@#$%^&*()+={}[\]\\|;:'"<>,.?/]{3,32}$/;
function validatePassword(password) {
  const p = String(password || '');
  if (p.length < 6) return { valid: false, reason: 'La contraseña debe tener al menos 6 caracteres' };
  if (p.length > 32) return { valid: false, reason: 'La contraseña no puede tener más de 32 caracteres' };
  if (!PASSWORD_RE.test(p)) return { valid: false, reason: 'La contraseña tiene caracteres que la plataforma no acepta (usá letras, números y símbolos comunes, sin acentos ni ñ)' };
  return { valid: true };
}

function _normalizeAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100; // pesos con 2 decimales, SIN centavos
}
function _num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function _sameAmount(a, b) { return Math.abs(Number(a) - Number(b)) < 0.005; }

function _buildReference(prefix, explicit) {
  if (explicit) return String(explicit).slice(0, 100);
  const generated = `${prefix}-${uuidv4()}`;
  logger.warn(`[mijoker] operación SIN reference estable — se generó ${generated}. ` +
    'Pasar una reference persistida para tener idempotencia real entre requests.');
  return generated;
}

const _REF_FLOWS = [
  ['vip-hg-', 'hgcash'], ['vip-dep-', 'admin_deposit'], ['vip-wd-', 'admin_withdrawal'], ['vip-bonus-', 'admin_bonus'],
  ['vip-payoutref', 'payout_refund'], ['vip-payout-', 'payout'], ['vip-roulette-', 'roulette'], ['vip-fire', 'fire'],
  ['vip-lvl-', 'vip'], ['vip-levelup', 'vip'], ['vip-nbatch', 'batch'], ['vip-welcome-', 'welcome_code'], ['vip-rf-', 'refund'],
  ['vip-wrf-', 'weekly_refund'], ['vip-cbk-', 'cashback'], ['vip-rake', 'rakeback'], ['vip-refcom-', 'referral'],
  ['vip-sdep-', 'movements'], ['vip-swd-', 'movements'], ['vip-install', 'install']
];
function _flowFromReference(reference) {
  const r = String(reference || '');
  const hit = _REF_FLOWS.find(([p]) => r.startsWith(p));
  return hit ? hit[1] : null;
}

// ============================================================
// RATE LIMIT local (por proceso; con N instancias el techo real es N×)
// ============================================================
const WINDOW_MS = 60000;
const MAX_QUEUE_WAIT_MS = 30000;
let _timestamps = [];
async function _acquireSlot() {
  const started = Date.now();
  for (;;) {
    const now = Date.now();
    _timestamps = _timestamps.filter((t) => now - t < WINDOW_MS);
    if (_timestamps.length < _maxRpm()) { _timestamps.push(now); return true; }
    if (now - started > MAX_QUEUE_WAIT_MS) return false;
    await _sleep(Math.max(50, _timestamps[0] + WINDOW_MS - now));
  }
}

// ============================================================
// HTTP
// ============================================================
function _headers(extra) {
  return { Authorization: `Bearer ${getApiToken()}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(extra || {}) };
}
function _extractMessage(body) {
  if (!body) return null;
  if (typeof body === 'string') return body.slice(0, 300);
  const m = body.message || (body.error && (body.error.message || body.error)) || body.detail || null;
  if (Array.isArray(m)) return m.join(' | ').slice(0, 300);
  return m ? String(m).slice(0, 300) : null;
}
/** Normaliza un error de axios a { error, code, httpStatus, retryable, sent, detail, body }. */
function _normalizeError(e, label) {
  if (!e.response) {
    const isTimeout = e.code === 'ECONNABORTED' || /timeout/i.test(e.message || '');
    return {
      error: isTimeout ? 'La plataforma está demorada. Reintentá en un momento.' : 'No se pudo conectar con la plataforma. Reintentá en un momento.',
      code: isTimeout ? 'timeout' : (e.code || 'network_error'),
      httpStatus: null,
      retryable: true,
      // No se sabe si la request llegó: para la plata es "resultado desconocido".
      sent: true,
      detail: `${label}: ${e.code || ''} ${e.message || ''}`.trim()
    };
  }
  const httpStatus = e.response.status;
  const body = e.response.data || {};
  const apiMessage = _extractMessage(body);
  const map = {
    400: { code: 'invalid_input', error: apiMessage || 'La plataforma rechazó los datos (400).' },
    401: { code: 'unauthorized', error: 'La plataforma rechazó nuestras credenciales. Avisale al soporte.' },
    403: { code: 'not_authorized', error: apiMessage || 'La plataforma no nos autoriza a operar sobre ese usuario.' },
    404: { code: 'player_not_found', error: apiMessage || 'El usuario no existe en la plataforma.' },
    429: { code: 'rate_limited', error: 'La plataforma está saturada. Reintentá en un minuto.' }
  };
  const hit = map[httpStatus] || { code: `http_${httpStatus}`, error: apiMessage || `Error de la plataforma (HTTP ${httpStatus}).` };
  // Un 400 por saldo: la API no documenta el código; se detecta por el texto.
  if (httpStatus === 400 && /insufficient|balance|saldo|funds/i.test(String(apiMessage || ''))) {
    hit.code = 'insufficient_funds'; hit.error = 'Saldo insuficiente.';
  }
  const ra = e.response.headers && (e.response.headers['retry-after'] || e.response.headers['Retry-After']);
  const retryAfterMs = ra && Number.isFinite(Number(ra)) ? Math.min(Number(ra) * 1000, 60000) : null;
  return {
    ...hit,
    httpStatus,
    retryable: httpStatus === 429 || httpStatus >= 500,
    retryAfterMs,
    detail: `${label}: HTTP ${httpStatus} ${JSON.stringify(body).slice(0, 300)}`,
    body
  };
}

/**
 * Request contra la Operator API con rate limit local y reintentos (sólo si
 * `retryable`). Devuelve { ok:true, data, httpStatus } | { ok:false, ...error, sent }.
 * `sent:false` = la request NO salió (rate limit local o config faltante).
 */
async function _request({ method, path, body, params, label, retryable = true, headers = null }) {
  if (!isEnabled()) {
    logger.error('[mijoker] MIJOKER_API_URL / MIJOKER_API_TOKEN no configurados');
    return { ok: false, error: 'La plataforma no está configurada. Avisale al soporte.', code: 'not_configured', httpStatus: null, sent: false };
  }
  const url = `${getBaseUrl()}${API_PREFIX}${path}`;
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const wait = lastErr && lastErr.retryAfterMs ? lastErr.retryAfterMs : RETRY_DELAYS_MS[attempt - 1];
      logger.warn(`[mijoker] ${label} — reintento ${attempt}/${RETRY_DELAYS_MS.length} en ${wait}ms (${lastErr && lastErr.code})`);
      await _sleep(wait);
    }
    if (!(await _acquireSlot())) {
      logger.warn(`[mijoker] ${label} — rate limit local saturado (${_maxRpm()}/min), abortando`);
      return { ok: false, error: 'La plataforma está saturada. Reintentá en un minuto.', code: 'rate_limited_local', httpStatus: null, sent: false };
    }
    try {
      const resp = await axios({ method, url, data: body, params, headers: _headers(headers), timeout: _timeoutMs(), proxy: false });
      return { ok: true, data: resp.data || {}, httpStatus: resp.status };
    } catch (e) {
      lastErr = _normalizeError(e, label);
      logger.warn(`[mijoker] ${lastErr.detail}`);
      if (!retryable || !lastErr.retryable || attempt === RETRY_DELAYS_MS.length) return { ok: false, ...lastErr };
    }
  }
  return { ok: false, ...(lastErr || { error: 'Error desconocido', code: 'unknown', httpStatus: null, sent: true }) };
}

// ============================================================
// CACHE corto de lecturas (saldo / jugador) + id numérico por username
// ============================================================
const _cache = new Map();       // key → { data, ts }
const _inflight = new Map();    // key → Promise
const _idByUser = new Map();    // usernameLower → id numérico (no cambia)
function _key(kind, username) { return `${kind}:${String(username || '').toLowerCase()}`; }
function _invalidatePlayer(username) {
  _cache.delete(_key('player', username));
  _cache.delete(_key('balance', username));
}
async function _cached(kind, username, fresh, fetcher) {
  const key = _key(kind, username);
  if (!fresh) {
    const hit = _cache.get(key);
    if (hit && (Date.now() - hit.ts) < _playerCacheTtlMs()) return hit.data;
    const inflight = _inflight.get(key);
    if (inflight) return inflight;
  }
  const p = fetcher().then((data) => {
    if (data && !data.__error) _cache.set(key, { data, ts: Date.now() });
    return data;
  });
  if (!fresh) {
    _inflight.set(key, p);
    p.finally(() => { if (_inflight.get(key) === p) _inflight.delete(key); }).catch(() => {});
  }
  return p;
}

/** GET /users?username= crudo. { found:true, user } | { found:false } | { found:false, error, code }. */
async function _fetchUser(username, { retryable = true } = {}) {
  const r = await _request({ method: 'get', path: '/users', params: { username: String(username) }, label: `getUser(${username})`, retryable });
  if (r.ok) {
    const u = r.data || {};
    if (u.id != null) _idByUser.set(String(username).toLowerCase(), Number(u.id));
    return { found: true, user: u };
  }
  if (r.httpStatus === 404) return { found: false, code: 'player_not_found' };
  return { found: false, error: r.error, code: r.code, httpStatus: r.httpStatus };
}
/** GET /users/balance?username= crudo. { ok, balance, currency } | { ok:false, error, code }. */
async function _fetchBalance(username, { retryable = true } = {}) {
  const r = await _request({ method: 'get', path: '/users/balance', params: { username: String(username) }, label: `getBalance(${username})`, retryable });
  if (!r.ok) return { ok: false, error: r.error, code: r.httpStatus === 404 ? 'player_not_found' : r.code, httpStatus: r.httpStatus };
  return { ok: true, balance: _num(r.data && r.data.balance) || 0, currency: (r.data && r.data.currency) || null };
}
async function _resolvePlatformId(username) {
  const k = String(username || '').toLowerCase();
  if (_idByUser.has(k)) return _idByUser.get(k);
  const u = await _fetchUser(username);
  return u.found && u.user.id != null ? Number(u.user.id) : null;
}

// ============================================================
// JUGADORES
// ============================================================
/** POST /users { agentName, playerName, password } → { success, player:{id, username} } | { success:false, error, code, alreadyExists? } */
async function createPlatformUser({ username, password }) {
  const check = validateUsername(username);
  if (!check.valid) return { success: false, error: `Usuario inválido para la plataforma: ${check.reason}`, code: 'invalid_username' };
  const pw = validatePassword(password);
  if (!pw.valid) return { success: false, error: pw.reason, code: 'invalid_password' };
  const agentName = getAgentName();
  if (!agentName) return { success: false, error: 'Falta MIJOKER_AGENT_NAME (el agente bajo el que se crean los jugadores).', code: 'not_configured' };

  // Alta NO reintentada a ciegas: un timeout puede haber creado al jugador. Si falla,
  // se consulta si existe y se resuelve por ahí.
  const r = await _request({
    method: 'post', path: '/users',
    body: { agentName, playerName: String(username), password: String(password) },
    label: `createPlayer(${username})`, retryable: false
  });
  if (r.ok) {
    const id = r.data && r.data.userId != null ? Number(r.data.userId) : null;
    if (id != null) _idByUser.set(String(username).toLowerCase(), id);
    _invalidatePlayer(username);
    return { success: true, player: { id, username: String(username) } };
  }
  if (r.httpStatus === 400 && /exist|taken|already|en uso|ya existe/i.test(String(r.error || ''))) {
    return { success: false, error: r.error, code: 'username_taken', alreadyExists: true };
  }
  if (r.httpStatus === 400 || r.httpStatus == null || r.httpStatus >= 500) {
    // 400 sin texto claro, timeout o 5xx: ¿quedó creado? Una lectura lo dice.
    const probe = await _fetchUser(username);
    if (probe.found) return { success: false, error: r.error || 'El usuario ya existe en la plataforma', code: 'username_taken', alreadyExists: true, player: { id: _num(probe.user.id), username: probe.user.username || String(username) } };
  }
  return { success: false, error: r.error, code: r.code, httpStatus: r.httpStatus };
}

/**
 * Jugador + saldo (dos GET: /users y /users/balance), misma forma que giroxService.
 * Cacheado (MIJOKER_PLAYER_CACHE_MS) con coalescing; `fresh:true` saltea el cache.
 * @returns { id, username, email, active, status, balance, available, locked:0, bonusLocked:0, claimableTotal:0, claimable:[], wagering:null, createdAt } | null
 */
async function getUserInfoByName(username, opts = {}) {
  const u = String(username || '').trim();
  if (!u) return null;
  const data = await _cached('player', u, !!(opts && opts.fresh), async () => {
    const r = await _fetchUser(u);
    if (!r.found) return null;
    const b = await _fetchBalance(u);
    const balance = b.ok ? b.balance : null;
    return {
      id: r.user.id != null ? Number(r.user.id) : null,
      username: r.user.username || u,
      email: r.user.email || null,
      active: String(r.user.status || 'ACTIVE').toUpperCase() === 'ACTIVE',
      status: r.user.status || null,
      balance,
      available: balance, // sin rollover: todo el saldo es retirable
      locked: 0,
      bonusLocked: 0,
      claimableTotal: 0,
      claimable: [],
      wagering: null,
      currency: b.ok ? b.currency : null,
      createdAt: r.user.createdAt || null
    };
  });
  return data || null;
}

/** La API tiene UN solo token: la key se ignora; lectura directa sin cache. */
async function readPlayerWithKey(_apiKey, username) {
  const r = await _fetchUser(username, { retryable: false });
  if (!r.found) return { found: false, error: r.error, code: r.code || 'player_not_found' };
  const b = await _fetchBalance(username, { retryable: false });
  return { found: true, username: r.user.username || String(username), balance: b.ok ? b.balance : null };
}

async function checkUserExists(username) {
  const r = await _fetchUser(username);
  return !!r.found;
}

/**
 * Health check real: consulta un jugador inexistente. Esperado: 404 (la API responde y
 * el token vale). 401/403 = token rechazado. 200 = inesperado.
 */
async function ping() {
  if (!isEnabled()) return { ok: false, estado: 'sin_configurar', detalle: 'Faltan MIJOKER_API_URL y/o MIJOKER_API_TOKEN' };
  const probe = 'zz_probe_' + Date.now().toString(36).slice(-8);
  const r = await _request({ method: 'get', path: '/users', params: { username: probe }, label: `ping(${probe})`, retryable: false });
  if (r.ok) return { ok: false, estado: 'inesperado', detalle: 'Devolvió datos para un jugador que no existe', httpStatus: r.httpStatus };
  if (r.httpStatus === 404) return { ok: true, estado: 'ok', detalle: `Operator API responde en ${getBaseUrl()} y el token es válido${getAgentName() ? '' : ' (⚠️ falta MIJOKER_AGENT_NAME para el alta de jugadores)'}${tokenExpiryWarning() ? ' — ' + tokenExpiryWarning() : ''}`, httpStatus: 404, code: r.code };
  if (r.httpStatus === 401 || r.httpStatus === 403) return { ok: false, estado: 'credenciales_rechazadas', detalle: `La API rechazó el token (HTTP ${r.httpStatus})`, httpStatus: r.httpStatus, code: r.code };
  return { ok: false, estado: 'error', detalle: r.error, httpStatus: r.httpStatus, code: r.code };
}

/**
 * Vincula o crea al jugador. `selfSignup:true` (registro público / landing): si el
 * username YA existe en la plataforma NO se vincula (la API no valida la clave →
 * sería robar la cuenta de otro jugador) y rebota con `username_taken`.
 */
async function syncUserToPlatform({ username, password, selfSignup = false }) {
  const check = validateUsername(username);
  if (!check.valid) return { success: false, error: `Usuario inválido para la plataforma: ${check.reason}`, code: 'invalid_username' };
  const existing = await _fetchUser(username);
  if (!existing.found && existing.error) return { success: false, error: existing.error, code: existing.code };
  if (existing.found) {
    if (selfSignup) {
      return { success: false, code: 'username_taken', error: 'Ese nombre de usuario ya está en uso en la plataforma. Elegí otro.' };
    }
    const player = { id: _num(existing.user.id), username: existing.user.username || String(username), status: existing.user.status || null };
    return { success: true, alreadyExists: true, platformUsername: player.username, player };
  }
  const created = await createPlatformUser({ username, password });
  if (created.success) return { success: true, alreadyExists: false, platformUsername: String(username), player: created.player };
  if (created.alreadyExists) {
    // La lectura no lo vio pero el alta dice "ya existe": es de otro agente.
    return { success: false, foreignUsername: true, code: 'username_taken_foreign', error: 'Ese nombre de usuario ya está en uso en la plataforma (pertenece a otra estructura). Elegí otro nombre.' };
  }
  return { success: false, error: created.error, code: created.code };
}

/**
 * ⚠️ SEGURIDAD: la Operator API no valida la clave de un jugador. El login de
 * server.js crea la cuenta local cuando la plataforma "valida" → acá SIEMPRE
 * `valid:false`: nadie entra a una cuenta que no exista en la web (la crea el agente
 * o el registro público, que crea al jugador en la plataforma).
 */
async function validateCredentials(username) {
  return { success: true, valid: false, player: null, error: 'La plataforma no permite validar la clave del jugador' };
}

/** PATCH /users/{username}/reset-password { password } → { success } */
async function changeUserPassword(username, newPassword) {
  const pw = validatePassword(newPassword);
  if (!pw.valid) return { success: false, error: pw.reason, code: 'invalid_password' };
  const r = await _request({
    method: 'patch', path: `/users/${encodeURIComponent(String(username))}/reset-password`,
    body: { password: String(newPassword) }, label: `changePassword(${username})`, retryable: true
  });
  if (!r.ok) return { success: false, error: r.error, code: r.code, httpStatus: r.httpStatus };
  return { success: true };
}

/** PATCH /users/{username}/status { status: ACTIVE|BANNED } (propio de mijoker). */
async function setUserStatus(username, status) {
  const st = String(status || '').toUpperCase();
  if (!['ACTIVE', 'BANNED'].includes(st)) return { success: false, error: 'Estado inválido (ACTIVE | BANNED)', code: 'invalid_status' };
  const r = await _request({
    method: 'patch', path: `/users/${encodeURIComponent(String(username))}/status`,
    body: { status: st }, label: `setStatus(${username}, ${st})`, retryable: true
  });
  if (!r.ok) return { success: false, error: r.error, code: r.code, httpStatus: r.httpStatus };
  _invalidatePlayer(username);
  return { success: true, status: st };
}

/** Sin SSO: el botón CASINO abre la web de la plataforma en una pestaña. */
async function createSession() {
  return { success: true, redirectUrl: getPlayUrl(), token: null, openInTab: true };
}

// ============================================================
// HISTORIAL DE SALDO — GET /users/{id}/balance-history
// ============================================================
function _mapHistoryItem(it) {
  return {
    transactionId: it.transactionId != null ? String(it.transactionId) : null,
    operation: it.operation || null,
    amount: _num(it.amount),
    balanceBefore: _num(it.balanceBefore),
    balanceAfter: _num(it.balanceAfter),
    createdAt: it.createdAt ? new Date(it.createdAt) : null,
    fromUsername: it.fromUsername || null,
    fromUserRole: it.fromUserRole || null,
    toUsername: it.toUsername || null,
    toUserRole: it.toUserRole || null,
    subprovider: it.subprovider || null,
    userFromId: _num(it.userFromId),
    userToId: _num(it.userToId)
  };
}
/**
 * Una página del historial. `operations` se manda si viene; ante 400 se reintenta UNA
 * vez sin el parámetro (la doc no dice el formato) y se filtra acá.
 * @returns { ok, items } | { ok:false, error, code }
 */
async function getBalanceHistory(username, { from, to, operations = null, limit = 30, offset = 0 } = {}) {
  const id = await _resolvePlatformId(username);
  if (id == null) return { ok: false, error: 'El usuario no existe en la plataforma.', code: 'player_not_found' };
  const dateFrom = (from instanceof Date ? from : new Date(from)).toISOString();
  const dateTo = (to instanceof Date ? to : new Date(to)).toISOString();
  const base = { limit: Math.max(1, Math.min(30, Number(limit) || 30)), offset: Math.max(0, Number(offset) || 0), dateFrom, dateTo };
  const path = `/users/${id}/balance-history`;
  let r = await _request({ method: 'get', path, params: operations ? { ...base, operations } : base, label: `history(${username}, ${offset})` });
  if (!r.ok && r.httpStatus === 400 && operations) {
    r = await _request({ method: 'get', path, params: base, label: `history-noop(${username}, ${offset})` });
  }
  if (!r.ok) return { ok: false, error: r.error, code: r.code, httpStatus: r.httpStatus };
  let items = Array.isArray(r.data && r.data.items) ? r.data.items.map(_mapHistoryItem) : [];
  if (operations) items = items.filter((it) => it.operation === operations);
  return { ok: true, items, platformUserId: id };
}

/** Contrato viejo (`GET /api/movements`): historial del jugador paginado. */
async function getUserMovements(username, { startDate, endDate, page = 1, pageSize = 30 } = {}) {
  const to = endDate ? new Date(endDate) : new Date();
  const from = startDate ? new Date(startDate) : new Date(to.getTime() - 30 * 86400000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return { success: false, error: 'Rango de fechas inválido', code: 'invalid_range' };
  const limit = Math.max(1, Math.min(30, Number(pageSize) || 30));
  const offset = (Math.max(1, Number(page) || 1) - 1) * limit;
  const r = await getBalanceHistory(username, { from, to, limit, offset });
  if (!r.ok) return { success: false, error: r.error, code: r.code };
  return { success: true, page: Math.max(1, Number(page) || 1), pageSize: limit, movements: r.items };
}

// ============================================================
// PLATA — libro mayor PlatformOp + POST /account-transfers
// ============================================================
function _moneyResult(op, duplicate) {
  const id = String(op.platformTxId || op._id);
  return {
    success: true,
    duplicate: !!duplicate,
    pending: false,
    opId: String(op._id),
    data: {
      transfer_id: id,
      transferId: id,
      user_balance_after: op.balanceAfter != null ? Number(op.balanceAfter) : undefined,
      reference: op.reference,
      ledger_id: null,
      type: op.kind,
      created_at: op.finishedAt || op.createdAt || null,
      duplicate: !!duplicate,
      wagering: null,
      reconciled: !!op.reconciled
    }
  };
}

/**
 * Busca en el historial la operación de `op` (misma operación, mismo monto, creada
 * desde que la mandamos), excluyendo ítems ya atribuidos a OTRA operación hecha del
 * mismo usuario. @returns { ok:true, found:true, item, ambiguous } | { ok:true, found:false } | { ok:false, error }
 */
async function _reconcile(op) {
  const startedAt = op.startedAt ? new Date(op.startedAt) : new Date(op.createdAt || Date.now());
  const from = new Date(startedAt.getTime() - RECONCILE_SKEW_MS);
  const to = new Date(Date.now() + RECONCILE_SKEW_MS);
  // Operaciones hechas del mismo usuario en la ventana: sus ítems no cuentan.
  let siblings = [];
  try {
    siblings = await PlatformOp.find({
      usernameLower: String(op.username).toLowerCase(), status: 'done', reference: { $ne: op.reference },
      finishedAt: { $gte: new Date(from.getTime() - 600000) }
    }).select('platformTxId balanceAfter amount operation').lean();
  } catch (e) { logger.warn(`[mijoker] reconcile ${op.reference}: no se pudieron leer las operaciones hermanas: ${e.message}`); }
  const takenTx = new Set(siblings.map((s) => s.platformTxId).filter(Boolean));
  const takenBal = siblings.filter((s) => s.balanceAfter != null && s.operation === op.operation).map((s) => ({ amount: s.amount, balanceAfter: s.balanceAfter }));

  const candidates = [];
  let lastErr = null;
  for (let page = 0; page < RECONCILE_MAX_PAGES; page++) {
    const r = await getBalanceHistory(op.username, { from, to, operations: op.operation, limit: 30, offset: page * 30 });
    if (!r.ok) { lastErr = r; break; }
    for (const it of r.items) {
      if (it.operation !== op.operation || !_sameAmount(it.amount, op.amount)) continue;
      if (it.createdAt && it.createdAt.getTime() < from.getTime()) continue;
      if (it.transactionId && takenTx.has(it.transactionId)) continue;
      if (it.balanceAfter != null && takenBal.some((b) => _sameAmount(b.amount, it.amount) && _sameAmount(b.balanceAfter, it.balanceAfter))) continue;
      candidates.push(it);
    }
    if (r.items.length < 30) break;
  }
  if (lastErr && !candidates.length) return { ok: false, error: lastErr.error, code: lastErr.code };
  if (!candidates.length) return { ok: true, found: false };
  candidates.sort((a, b) => (b.createdAt ? b.createdAt.getTime() : 0) - (a.createdAt ? a.createdAt.getTime() : 0));
  return { ok: true, found: true, item: candidates[0], ambiguous: candidates.length > 1 };
}

async function _markDone(op, { balanceAfter, platformTxId, reconciled, ambiguous }) {
  const set = { status: 'done', finishedAt: new Date(), error: null, errorCode: null, reconciled: !!reconciled, ambiguous: !!ambiguous };
  if (balanceAfter != null) set.balanceAfter = balanceAfter;
  if (platformTxId) set.platformTxId = String(platformTxId);
  const upd = await PlatformOp.findOneAndUpdate({ reference: op.reference }, { $set: set }, { new: true }).lean();
  _invalidatePlayer(op.username);
  return upd || { ...op, ...set };
}
async function _markStatus(op, status, { error, errorCode, httpStatus } = {}) {
  const set = { status, finishedAt: new Date(), error: error ? String(error).slice(0, 500) : null, errorCode: errorCode || null, httpStatus: httpStatus != null ? httpStatus : null };
  const upd = await PlatformOp.findOneAndUpdate({ reference: op.reference }, { $set: set }, { new: true }).lean();
  return upd || { ...op, ...set };
}

/** Reconcilia una operación `unknown` (o `pending` vencida). Devuelve el PlatformOp actualizado. */
async function reconcileOp(reference) {
  const op = await PlatformOp.findOne({ reference }).lean();
  if (!op) return { success: false, error: 'Operación inexistente', code: 'not_found' };
  if (op.status === 'done') return { success: true, op, alreadyDone: true };
  if (op.status === 'pending' && op.startedAt && (Date.now() - new Date(op.startedAt).getTime()) < IN_FLIGHT_MS) {
    return { success: false, error: 'La operación todavía está en vuelo', code: 'in_progress', op };
  }
  const rec = await _reconcile(op);
  if (!rec.ok) return { success: false, error: `No se pudo leer el historial: ${rec.error}`, code: rec.code || 'history_unavailable', op };
  if (rec.found) {
    const done = await _markDone(op, { balanceAfter: rec.item.balanceAfter, platformTxId: rec.item.transactionId, reconciled: true, ambiguous: rec.ambiguous });
    logger.warn(`[mijoker] ${op.reference} RECONCILIADA como hecha (tx ${rec.item.transactionId}${rec.ambiguous ? ', AMBIGUA' : ''})`);
    await _emitOp('reconciled', done);
    return { success: true, op: done, found: true, ambiguous: rec.ambiguous };
  }
  const failed = await _markStatus(op, 'failed', { error: 'No figura en el historial de la plataforma: no se acreditó', errorCode: 'not_in_history' });
  return { success: true, op: failed, found: false };
}

/**
 * Núcleo de TODA operación de plata. Ver el encabezado del archivo.
 * @returns { success, duplicate, data } | { success:false, error, code, httpStatus?, retryable? }
 */
async function _moneyOp({ kind, operation, username, amount, description, reference, flow, meta }, _depth = 0) {
  const now = new Date();
  let op = await PlatformOp.findOne({ reference }).lean();
  if (op) {
    if (op.status === 'done') {
      logger.info(`[mijoker] ${kind}(${username}, $${amount}) ref=${reference} — DUPLICADA (ya hecha)`);
      return _moneyResult(op, true);
    }
    if (op.status === 'pending') {
      const age = now.getTime() - new Date(op.startedAt || op.createdAt || now).getTime();
      if (age < IN_FLIGHT_MS) {
        return { success: false, error: 'Esa operación ya está en curso. Esperá un momento antes de reintentar.', code: 'in_progress', retryable: true };
      }
      // El proceso que la mandó murió: resultado desconocido.
      await PlatformOp.updateOne({ reference, status: 'pending' }, { $set: { status: 'unknown', error: 'proceso interrumpido con la operación en vuelo', errorCode: 'interrupted' } });
      op = await PlatformOp.findOne({ reference }).lean();
    }
    if (op.status === 'unknown') {
      const rec = await _reconcile(op);
      if (!rec.ok) {
        logger.error(`[mijoker] ${reference} sigue SIN CONFIRMAR y el historial no responde (${rec.error}): no se reintenta`);
        return { success: false, error: 'No se pudo confirmar si la operación anterior se acreditó. No se reintenta sola: un agente tiene que revisar el historial del jugador en la plataforma.', code: 'unknown_outcome', retryable: false };
      }
      if (rec.found) {
        const done = await _markDone(op, { balanceAfter: rec.item.balanceAfter, platformTxId: rec.item.transactionId, reconciled: true, ambiguous: rec.ambiguous });
        logger.warn(`[mijoker] ${reference} estaba SIN CONFIRMAR y figura en el historial → hecha (tx ${rec.item.transactionId})`);
        await _emitOp('reconciled', done);
        return _moneyResult(done, true);
      }
      // No figura: no se acreditó → se vuelve a mandar con la misma reference.
    }
    const re = await PlatformOp.findOneAndUpdate(
      { reference, status: { $in: ['failed', 'unknown'] } },
      { $set: { status: 'pending', startedAt: now, finishedAt: null, error: null, errorCode: null, httpStatus: null }, $inc: { attempts: 1 } },
      { new: true }
    ).lean();
    if (!re) return { success: false, error: 'Esa operación ya está en curso en otra instancia.', code: 'in_progress', retryable: true };
    op = re;
    logger.info(`[mijoker] ${kind}(${username}, $${amount}) ref=${reference} — reintento #${op.attempts}`);
  } else {
    try {
      const created = await PlatformOp.create({
        reference, kind, operation, username: String(username), usernameLower: String(username).toLowerCase(),
        platformUserId: _idByUser.get(String(username).toLowerCase()) || null,
        amount, description: String(description || '').slice(0, 500), flow: flow || _flowFromReference(reference),
        status: 'pending', attempts: 1, startedAt: now, meta: meta || {}
      });
      op = created.toObject ? created.toObject() : created;
    } catch (e) {
      if (e && e.code === 11000 && _depth < 1) return _moneyOp({ kind, operation, username, amount, description, reference, flow, meta }, _depth + 1);
      logger.error(`[mijoker] no se pudo registrar ${kind}(${username}, $${amount}) ref=${reference}: ${e.message}`);
      return { success: false, error: `No se pudo registrar la operación: ${e.message}`, code: 'op_write_failed' };
    }
  }

  const r = await _request({
    method: 'post', path: '/account-transfers',
    body: { amount, operation, targetUserName: String(username) },
    // #232 el proveedor va a soportar Idempotency-Key en account-transfers y pidió que ya lo
    // mandemos: la reference (única y estable por operación) es exactamente eso. Hasta que
    // esté activo lo ignoran; el libro mayor PlatformOp sigue siendo la garantía.
    headers: { 'idempotency-key': String(reference).slice(0, 255) },
    label: `${operation}(${username}, $${amount}, ref=${reference})`,
    retryable: false // NUNCA a ciegas: sin reference la API acreditaría dos veces
  });
  if (r.ok) {
    const done = await _markDone(op, { balanceAfter: _num(r.data && r.data.newBalance) });
    logger.info(`[mijoker] ${kind}(${username}, $${amount}) ref=${reference} → OK (saldo ${done.balanceAfter})`);
    await _emitOp('done', done);
    return _moneyResult(done, false);
  }
  // ¿La API la procesó? No salió (rate limit local / sin config) o la rechazó (4xx) → NO movió plata.
  const notProcessed = r.sent === false || (r.httpStatus != null && r.httpStatus >= 400 && r.httpStatus < 500);
  if (notProcessed) {
    const failed = await _markStatus(op, 'failed', { error: r.error, errorCode: r.code, httpStatus: r.httpStatus });
    await _emitOp('failed', failed);
    return { success: false, error: r.error, code: r.code, httpStatus: r.httpStatus, retryable: !!r.retryable };
  }
  // Timeout / red / 5xx: resultado DESCONOCIDO → reconciliar ya.
  let unk = await _markStatus(op, 'unknown', { error: r.error, errorCode: r.code, httpStatus: r.httpStatus });
  const rec = await _reconcile(unk);
  if (rec.ok && rec.found) {
    const done = await _markDone(unk, { balanceAfter: rec.item.balanceAfter, platformTxId: rec.item.transactionId, reconciled: true, ambiguous: rec.ambiguous });
    logger.warn(`[mijoker] ${reference} dio ${r.code} pero FIGURA en el historial → hecha (tx ${rec.item.transactionId}${rec.ambiguous ? ', AMBIGUA' : ''})`);
    await _emitOp('reconciled', done);
    return _moneyResult(done, false);
  }
  if (rec.ok && !rec.found) {
    const failed = await _markStatus(unk, 'failed', { error: r.error, errorCode: r.code, httpStatus: r.httpStatus });
    logger.warn(`[mijoker] ${reference} dio ${r.code} y NO figura en el historial → no se acreditó (reintentable)`);
    await _emitOp('failed', failed);
    return { success: false, error: r.error, code: r.code, httpStatus: r.httpStatus, retryable: true };
  }
  logger.error(`[mijoker] ${reference} SIN CONFIRMAR (${r.code}) y el historial tampoco responde (${rec.error}). Queda unknown.`);
  await _emitOp('unknown', unk);
  return {
    success: false,
    error: 'La plataforma no confirmó la operación y no se pudo verificar en su historial. NO se reintenta sola: revisar el historial del jugador en la plataforma.',
    code: 'unknown_outcome', httpStatus: r.httpStatus, retryable: false, opId: String(unk._id)
  };
}

/**
 * @param {object} [wagering] se toleran las opciones de los otros clientes (bonus*, multiplier,
 *   agentExecuted, agentName, flow, meta). Sin rollover ni bonos en la API: el bono de la carga
 *   (si viene `bonusAmount`) se acredita como un SEGUNDO INCOME con reference `<ref>-bonus`.
 */
async function depositToUser(username, amount, description = '', reference = null, wagering = null) {
  const amt = _normalizeAmount(amount);
  if (amt === null) return { success: false, error: 'Monto inválido', code: 'invalid_amount' };
  const w = wagering || {};
  const ref = _buildReference('dep', reference);
  const out = await _moneyOp({ kind: 'deposit', operation: 'INCOME', username, amount: amt, description, reference: ref, flow: w.flow || null, meta: w.meta || {} });
  if (!out.success) return out;
  const bonusAmt = _normalizeAmount(w.bonusAmount);
  if (bonusAmt !== null) {
    const b = await _moneyOp({ kind: 'gift', operation: 'INCOME', username, amount: bonusAmt, description: `Bono de la carga (${description || ref})`, reference: `${ref}-bonus`, flow: w.flow || null, meta: { ...(w.meta || {}), bonusOf: ref } });
    if (!b.success) {
      logger.error(`[mijoker] deposit(${username}) — la carga se acreditó pero el BONO $${bonusAmt} falló (${b.code}): ${b.error}`);
      out.bonusFailed = true;
      out.bonusError = b.error;
    } else {
      out.bonusOpId = b.opId;
      if (b.data && b.data.user_balance_after != null) out.data.user_balance_after = b.data.user_balance_after;
    }
  }
  out.rolloverApplied = 0;
  return out;
}

async function withdrawFromUser(username, amount, description = '', reference = null, opts = {}) {
  const amt = _normalizeAmount(amount);
  if (amt === null) return { success: false, error: 'Monto inválido', code: 'invalid_amount' };
  const o = opts || {};
  return _moneyOp({ kind: 'withdraw', operation: 'OUTCOME', username, amount: amt, description, reference: _buildReference('wd', reference), flow: o.flow || null, meta: o.meta || {} });
}

/** Regalo = INCOME liso (sin bonos ni rollover en la API). Misma forma que giroxService.creditGift. */
async function creditGift(username, amount, opts = {}) {
  const amt = _normalizeAmount(amount);
  if (amt === null) return { success: false, error: 'Monto inválido', code: 'invalid_amount' };
  const o = opts || {};
  const r = await _moneyOp({ kind: 'gift', operation: 'INCOME', username, amount: amt, description: o.description || '', reference: _buildReference('bonus', o.reference), flow: o.flow || null, meta: o.meta || {} });
  if (r && r.success) {
    r.creditedAs = 'deposit';
    r.via = 'mijoker';
    r.rolloverApplied = 0;
    r.claimRequired = false;
  }
  return r;
}

async function creditUserBalance(username, amount, reference = null, opts = {}) {
  const o = opts || {};
  return creditGift(username, amount, { reference, description: o.description || '', rolloverX: 0, ignoreGlobalRollover: true, flow: o.flow || null, meta: o.meta || {} });
}

function getGiftModeSummary() { return 'mijoker (INCOME directo por la Operator API, sin bono ni rollover)'; }

// ============================================================
// SALDO / STATS
// ============================================================
async function getUserBalance(username, opts = {}) {
  const u = String(username || '').trim();
  const b = await _cached('balance', u, !!(opts && opts.fresh), async () => {
    const r = await _fetchBalance(u);
    return r.ok ? { balance: r.balance, currency: r.currency } : { __error: true, error: r.error, code: r.code };
  });
  if (!b || b.__error) return { success: false, error: (b && b.error) || 'No se pudo leer el saldo en la plataforma.', code: (b && b.code) || 'player_not_found' };
  return { success: true, username: u, balance: b.balance, available: b.balance, locked: 0, bonusLocked: 0, claimableTotal: 0, wagering: null, currency: b.currency };
}
async function getUserBalanceWithRetry(username, { maxAttempts = 3, baseDelayMs = 500, fresh = false } = {}) {
  let last = null;
  for (let i = 1; i <= maxAttempts; i++) {
    last = await getUserBalance(username, { fresh });
    if (last.success) return last;
    if (i < maxAttempts) await _sleep(baseDelayMs * Math.pow(2, i - 1));
  }
  return { ...last, attemptsExhausted: true };
}

function formatStatsDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const opts = { timeZone: 'America/Argentina/Buenos_Aires' };
  return `${d.toLocaleDateString('en-CA', opts)} ${d.toLocaleTimeString('en-GB', { ...opts, hour12: false })}`;
}
const NO_STATS = { success: false, code: 'not_supported', error: 'La Operator API no informa el netwin del jugador.' };
async function getPlayerStats() { return { ...NO_STATS }; }
async function getPlayersStatsBatch() { return { ...NO_STATS, results: {} }; }
async function getPlatformConfig() {
  return { success: true, cached: true, config: { mijoker: true, bonus: { enabled: true, standalone_enabled: true, multipliers: [0], fixed_min: 0, fixed_max: 0 }, rollover: { enabled: false } } };
}
async function claimPendingBonus() { return { success: true, amount: 0, claimed: [], wagering: null }; }

// ============================================================
// DIAGNÓSTICO (radiografía de boot)
// ============================================================
function getReadsKeysCount() { return 0; }
function getReadsKeysSummary() { return 'n/a (mijoker: un solo token)'; }
function getPublisherKeyOverridesCount() { return 0; }
function getPublisherMaxRpm() { return 0; }
function getMasterMaxRpm() { return _maxRpm(); }
function getPlayerCacheTtlMs() { return _playerCacheTtlMs(); }

// ============================================================
// LIBRO MAYOR — lo usa el panel/endpoints admin
// ============================================================
async function listOps({ status = 'unknown', limit = 200, username = null } = {}) {
  const q = {};
  if (status && status !== 'all') q.status = status;
  if (username) q.usernameLower = String(username).toLowerCase();
  return PlatformOp.find(q).sort({ updatedAt: -1 }).limit(Math.min(Number(limit) || 200, 1000)).lean();
}
async function countUnknown() {
  return PlatformOp.countDocuments({ status: 'unknown' });
}

module.exports = {
  errToString,
  setCashierBalanceHook,
  isEnabled,
  getPlayUrl,
  setPlayUrlOverride,
  getBaseUrl,
  validateUsername,
  setKeyResolver,
  createPlatformUser,
  getUserInfoByName,
  readPlayerWithKey,
  checkUserExists,
  ping,
  syncUserToPlatform,
  validateCredentials,
  changeUserPassword,
  createSession,
  depositToUser,
  creditGift,
  setRolloverResolver,
  withdrawFromUser,
  creditUserBalance,
  getUserBalance,
  getUserBalanceWithRetry,
  getPlayerStats,
  getPlayersStatsBatch,
  formatStatsDate,
  getPlatformConfig,
  claimPendingBonus,
  getGiftModeSummary,
  getUserMovements,
  getReadsKeysCount,
  getReadsKeysSummary,
  getPublisherKeyOverridesCount,
  getPublisherMaxRpm,
  getMasterMaxRpm,
  getPlayerCacheTtlMs,
  // propios de mijoker
  MANUAL_MODE: false,
  getAgentName,
  getTokenExpiry,
  tokenExpiryWarning,
  validatePassword,
  setUserStatus,
  getBalanceHistory,
  setOpListener,
  reconcileOp,
  listOps,
  countUnknown,
  PlatformOp
};
