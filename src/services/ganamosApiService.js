/**
 * ganamosApiService.js — cliente de la API del PANEL DE AGENTE de GANAMOS
 * (agents.ganamos.co). Tercer modo de plataforma (#191, 2026-09-29), con el MISMO
 * contrato que giroxService/ganamosPlatformService. Se elige con PLATFORM_MODE=ganamos_api.
 *
 * A DIFERENCIA de 1girox, esta API es el panel de agente (no una Partner API pensada
 * para integrar), así que hay tres cosas que cambian todo y están tratadas acá:
 *
 *  1. AUTENTICACIÓN POR SESIÓN (no API key fija). Se hace `POST /api/sign/login` con
 *     usuario+clave del AGENTE (GANAMOS_AGENT_USER / GANAMOS_AGENT_PASS desde SSM) y la
 *     respuesta trae la cookie `session` (un JWT). Se guarda en memoria, se manda en
 *     cada request, y si un request vuelve 401/403 se re-loguea UNA vez y reintenta.
 *     Hay un mutex para que N requests simultáneos compartan un solo login.
 *     ⚠️ NUNCA hardcodear una cookie de sesión: vencen y son un secreto de la cuenta.
 *
 *  2. ❗ NO HAY CLAVE DE IDEMPOTENCIA. El body de una carga es `{operation, amount}`,
 *     sin `reference`. Reintentar un pago = cargar DOS veces. Por eso:
 *       - Las LECTURAS (GET) reintentan ante fallos transitorios (son idempotentes).
 *       - Los PAGOS (`payment`) se intentan UNA sola vez. Si la respuesta se pierde
 *         (timeout / red / 5xx), se devuelve `{ success:false, indeterminate:true,
 *         code:'unknown_result' }` y el CALLER NO debe reintentar: tiene que verificar
 *         con el saldo o el reporte de movimientos y, si hace falta, dejarlo para
 *         revisión manual. server.js trata `indeterminate` como "no acreditado pero
 *         PODRÍA haberse acreditado" (nota al agente), nunca como para reintentar.
 *
 *  3. CLOUDFLARE. El dominio está detrás de Cloudflare con anti-bot. Desde un navegador
 *     logueado anda; desde un server (AWS EB) PUEDE devolver 403 al login. Si pasa, se
 *     detecta (`code:'cloudflare_blocked'`) y se avisa fuerte: no es que la clave esté
 *     mal. Solución si bloquea: pedirle a GANAMOS que permita la IP del server, o usar
 *     un proxy residencial. Kill switch: PLATFORM_MODE=manual vuelve al modo bandeja.
 *
 * Endpoints confirmados por captura del panel (2026-05):
 *   POST /api/sign/login                              { username, password, language }
 *   GET  /api/agent_admin/user/search/?username=X     buscar jugador (devuelve lista)
 *   GET  /api/agent_admin/user/{id}/                  detalle + saldo del jugador
 *   POST /api/agent_admin/user/{id}/payment/          { operation, amount }  carga/retiro
 *   GET  /api/agent_admin/payment/requests/?date_from=&date_to=&count=&page=  reporte
 *
 * ⚠️ VERIFICAR CONTRA UNA RESPUESTA REAL (las capturas no traían el body de respuesta):
 *   - Nombres de campo del saldo/id/username en user/{id} y user/search (mapeo abajo,
 *     con varios alias; ajustar con `GANAMOS_DEBUG_SHAPES=1` que loguea el JSON crudo).
 *   - El `operation` del RETIRO (la carga es 0; el retiro se probó como 1 — CONFIRMAR
 *     antes de usarlo con plata real). Configurable por env sin deploy.
 *   - No hay endpoint de ALTA de jugador en las capturas: `createPlatformUser` queda
 *     como no soportado hasta capturar el "CREAR USUARIO" del panel (ver abajo).
 */
const axios = require('axios');
const _fileLogger = require('../utils/logger');

// ============================================================
// PROXY DE SALIDA (2026-09-29): Cloudflare bloqueó el login desde la IP de datacenter de
// Render/AWS (403 directo). Con GANAMOS_PROXY_URL (o el histórico PROXY_URL, el mismo
// nombre que usaban los clientes de JUGAYGANA) TODO el tráfico a agents.ganamos.co sale
// por ese proxy (formato http://usuario:clave@host:puerto). Lazy: SSM carga después del
// require y `https-proxy-agent` puede no estar en un entorno sin node_modules (tests).
// ⚠️ `proxy:false` en axios es obligatorio: si no, axios ignora el agent y/o lee
// HTTPS_PROXY del entorno por su cuenta.
// ============================================================
let _proxyAgentCache = { url: null, agent: null };
function _proxyUrl() { return (process.env.GANAMOS_PROXY_URL || process.env.PROXY_URL || '').trim(); }
function _proxyAgent() {
  const url = _proxyUrl();
  if (!url) return null;
  if (_proxyAgentCache.url === url && _proxyAgentCache.agent) return _proxyAgentCache.agent;
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    _proxyAgentCache = { url, agent: new HttpsProxyAgent(url) };
    return _proxyAgentCache.agent;
  } catch (e) {
    logger.error(`[ganamos-api] PROXY configurado pero no se pudo crear el agent (${e.message}) — saliendo SIN proxy`);
    return null;
  }
}
/** Proxy sin credenciales, para logs: "host:puerto" o "sin proxy". */
function getProxySummary() {
  const url = _proxyUrl();
  if (!url) return 'sin proxy';
  // URL.port viene vacío cuando es el puerto por defecto del esquema (http→80, https→443).
  try { const u = new URL(url); return `proxy ${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`; } catch (_) { return 'proxy (URL inválida)'; }
}

// ⚠️ En producción winston escribe SOLO a archivo (logs/*.log), que EB no muestra. Todo lo
// que el owner necesita ver en el log de AWS (login OK, JSON crudo con GANAMOS_DEBUG_SHAPES)
// va TAMBIÉN por console.log — si no, el diagnóstico del modo API es invisible.
const logger = {
  info: (...a) => { try { _fileLogger.info(...a); } catch (_) {} try { console.log(`[${new Date().toISOString()}]`, ...a); } catch (_) {} },
  warn: (...a) => { try { _fileLogger.warn(...a); } catch (_) {} try { console.warn(`[${new Date().toISOString()}]`, ...a); } catch (_) {} },
  error: (...a) => { try { _fileLogger.error(...a); } catch (_) {} try { console.error(`[${new Date().toISOString()}]`, ...a); } catch (_) {} }
};

// ============================================================
// CONFIG (lazy — SSM carga después del require)
// ============================================================
function getBaseUrl() { return (process.env.GANAMOS_AGENT_API_URL || 'https://agents.ganamos.co').replace(/\/+$/, ''); }
function getPlayUrl() { return (process.env.GANAMOS_PLAY_URL || 'https://ganamos.net').replace(/\/+$/, ''); }
function _agentUser() { return process.env.GANAMOS_AGENT_USER || ''; }
function _agentPass() { return process.env.GANAMOS_AGENT_PASS || ''; }
function isEnabled() { return !!(_agentUser() && _agentPass()); }
// Códigos de operación del endpoint payment (configurables: la carga es 0, el retiro
// se probó como 1 pero HAY QUE CONFIRMARLO antes de mover plata real).
function _opDeposit() { const n = Number(process.env.GANAMOS_OP_DEPOSIT); return Number.isFinite(n) ? n : 0; }
function _opWithdraw() { const n = Number(process.env.GANAMOS_OP_WITHDRAW); return Number.isFinite(n) ? n : 1; }
const TIMEOUT_MS = Number(process.env.GANAMOS_TIMEOUT_MS || 20000);
const BROWSER_UA = process.env.GANAMOS_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

// Hooks del contrato (inyectados desde server.js). Acá el rollover NO se aplica en la
// plataforma (el panel no expone bonos con rollover por API): se ignora, y el rollover
// global de bonos deja de tener efecto real → conviene apagarlo (Config) en este modo.
let _rolloverResolver = null, _cashierHook = null, _keyResolver = null;
function setRolloverResolver(fn) { _rolloverResolver = typeof fn === 'function' ? fn : null; }
function setCashierBalanceHook(fn) { _cashierHook = typeof fn === 'function' ? fn : null; }
function setKeyResolver(fn) { _keyResolver = typeof fn === 'function' ? fn : null; }

// ============================================================
// SESIÓN — login y cookie en memoria (con mutex de login)
// ============================================================
let _sessionCookie = null;     // "session=<jwt>"
let _sessionAt = 0;
let _loginInFlight = null;
const SESSION_TTL_MS = Number(process.env.GANAMOS_SESSION_TTL_MS || 30 * 60 * 1000);

function _isCloudflareBlock(status, data) {
  if (status === 403) {
    const s = typeof data === 'string' ? data : '';
    return /cloudflare|forbidden|not a bot|attention required/i.test(s) || s.length < 4000;
  }
  return false;
}

/** Loguea al panel y guarda la cookie `session`. Devuelve { success } | { success:false, code, error }. */
async function _login(force = false) {
  if (!isEnabled()) return { success: false, code: 'not_configured', error: 'Faltan GANAMOS_AGENT_USER / GANAMOS_AGENT_PASS' };
  if (!force && _sessionCookie && (Date.now() - _sessionAt) < SESSION_TTL_MS) return { success: true, cached: true };
  if (_loginInFlight) return _loginInFlight; // mutex: un solo login concurrente
  _loginInFlight = (async () => {
    try {
      const agent = _proxyAgent();
      const resp = await axios.post(`${getBaseUrl()}/api/sign/login`,
        { username: _agentUser(), password: _agentPass(), language: 'es' },
        {
          timeout: TIMEOUT_MS,
          validateStatus: () => true,
          ...(agent ? { httpsAgent: agent, httpAgent: agent, proxy: false } : {}),
          headers: {
            'content-type': 'application/json;charset=UTF-8',
            'accept': 'application/json, text/plain, */*',
            'origin': getBaseUrl(),
            'referer': `${getBaseUrl()}/login`,
            'user-agent': BROWSER_UA
          }
        });
      if (process.env.GANAMOS_DEBUG_SHAPES === '1') {
        const sc = resp.headers && resp.headers['set-cookie'];
        logger.info(`[ganamos-api] SHAPE LOGIN (HTTP ${resp.status}) set-cookie=${Array.isArray(sc) ? sc.map((c) => c.split('=')[0]).join(',') : 'ninguna'} body=${JSON.stringify(resp.data).slice(0, 1500)}`);
      }
      if (_isCloudflareBlock(resp.status, resp.data)) {
        logger.error(`[ganamos-api] LOGIN bloqueado por Cloudflare (403) [${getProxySummary()}]. La IP del server no pasa el anti-bot. ` +
          'Pedir whitelisting de la IP a GANAMOS o usar proxy (GANAMOS_PROXY_URL / PROXY_URL). NO es la clave.');
        return { success: false, code: 'cloudflare_blocked', error: 'Cloudflare bloqueó el login del servidor (403).' };
      }
      const setCookie = resp.headers && resp.headers['set-cookie'];
      let cookie = null;
      if (Array.isArray(setCookie)) {
        const s = setCookie.find((c) => /^session=/.test(c));
        if (s) cookie = s.split(';')[0];
      }
      // Algunos backends devuelven el token en el body en vez de Set-Cookie.
      if (!cookie && resp.data && typeof resp.data === 'object') {
        const tok = resp.data.session || resp.data.token || (resp.data.data && resp.data.data.session);
        if (tok) cookie = `session=${tok}`;
      }
      if (resp.status >= 200 && resp.status < 300 && cookie) {
        _sessionCookie = cookie; _sessionAt = Date.now();
        logger.info(`[ganamos-api] login OK como ${_agentUser()} (${getProxySummary()})`);
        return { success: true };
      }
      logger.error(`[ganamos-api] login falló (status ${resp.status}) — ${JSON.stringify(resp.data).slice(0, 200)}`);
      return { success: false, code: resp.status === 401 ? 'bad_credentials' : 'login_failed', error: `Login falló (HTTP ${resp.status})`, httpStatus: resp.status };
    } catch (e) {
      logger.error(`[ganamos-api] login excepción: ${e.message}`);
      return { success: false, code: 'network', error: e.message };
    } finally {
      _loginInFlight = null;
    }
  })();
  return _loginInFlight;
}

/**
 * Request autenticado. `retryOn401` re-loguea y reintenta UNA vez (para lecturas y
 * para un pago que fue RECHAZADO por sesión antes de tocar plata). `idempotent=false`
 * (pagos) → NO se reintenta por red/timeout/5xx: se devuelve indeterminado.
 */
async function _req(method, path, { body = null, idempotent = true, referer = null } = {}) {
  const lg = await _login();
  if (!lg.success) return { ok: false, code: lg.code, error: lg.error, httpStatus: lg.httpStatus, indeterminate: false };

  const agent = _proxyAgent();
  const doCall = async () => {
    return axios({
      method, url: `${getBaseUrl()}${path}`,
      data: body || undefined,
      timeout: TIMEOUT_MS,
      validateStatus: () => true,
      ...(agent ? { httpsAgent: agent, httpAgent: agent, proxy: false } : {}),
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json;charset=UTF-8',
        'cookie': _sessionCookie,
        'origin': getBaseUrl(),
        'referer': referer || `${getBaseUrl()}/`,
        'user-agent': BROWSER_UA
      }
    });
  };

  let resp;
  try {
    resp = await doCall();
  } catch (e) {
    // Red/timeout: en un GET reintenta; en un PAGO es INDETERMINADO (pudo acreditar).
    if (idempotent) {
      try { resp = await doCall(); } catch (e2) { return { ok: false, code: 'network', error: e2.message, indeterminate: false }; }
    } else {
      logger.error(`[ganamos-api] PAGO ${path} sin respuesta (${e.message}) — RESULTADO INDETERMINADO, NO reintentar`);
      return { ok: false, code: 'unknown_result', error: e.message, indeterminate: true };
    }
  }

  // Sesión vencida → re-login y UN reintento (seguro también para el pago: 401 = no tocó plata).
  if (resp.status === 401 || (resp.status === 403 && !_isCloudflareBlock(resp.status, resp.data))) {
    const re = await _login(true);
    if (!re.success) return { ok: false, code: re.code, error: re.error, indeterminate: false };
    try { resp = await doCall(); }
    catch (e) { return idempotent ? { ok: false, code: 'network', error: e.message } : { ok: false, code: 'unknown_result', indeterminate: true, error: e.message }; }
  }

  if (_isCloudflareBlock(resp.status, resp.data)) {
    return { ok: false, code: 'cloudflare_blocked', error: 'Cloudflare bloqueó el request (403).', indeterminate: !idempotent };
  }
  if (resp.status >= 500) {
    return { ok: false, code: 'server_error', httpStatus: resp.status, error: `HTTP ${resp.status}`, indeterminate: !idempotent };
  }
  if (resp.status < 200 || resp.status >= 300) {
    const msg = (resp.data && (resp.data.message || resp.data.error || resp.data.detail)) || `HTTP ${resp.status}`;
    return { ok: false, code: 'http_' + resp.status, httpStatus: resp.status, error: String(msg), data: resp.data, indeterminate: false };
  }
  // GANAMOS_DEBUG_SHAPES=1 → JSON crudo COMPLETO (hasta 4000 chars) para ajustar el mapeo de
  // campos (saldo/id/txId). Se loguea también el status. Apagar cuando el mapeo esté confirmado.
  if (process.env.GANAMOS_DEBUG_SHAPES === '1') logger.info(`[ganamos-api] SHAPE ${method.toUpperCase()} ${path} (HTTP ${resp.status}) → ${JSON.stringify(resp.data).slice(0, 4000)}`);
  return { ok: true, data: resp.data, httpStatus: resp.status };
}

// ============================================================
// HELPERS
// ============================================================
function errToString(err) {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === 'object') return err.message || err.error || (() => { try { return JSON.stringify(err); } catch (_) { return String(err); } })();
  return String(err);
}
function validateUsername(username) {
  const u = String(username || '').trim();
  if (u.length < 3) return { valid: false, reason: 'menos de 3 caracteres' };
  if (u.length > 30) return { valid: false, reason: `${u.length} caracteres (máximo 30)` };
  if (!/^[A-Za-z0-9_.-]+$/.test(u)) return { valid: false, reason: 'símbolos no permitidos (solo letras, números, _ . -)' };
  return { valid: true };
}
function _amount(a) { const n = Number(a); if (!Number.isFinite(n) || n <= 0) return null; return Math.round(n * 100) / 100; }
function _num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
// Extrae {id, username, balance} de un objeto jugador tolerando varios nombres de campo
// (las capturas no traían el body — AJUSTAR con GANAMOS_DEBUG_SHAPES si algún alias falla).
function _pickPlayer(o) {
  if (!o || typeof o !== 'object') return null;
  const id = _num(o.id != null ? o.id : (o.user_id != null ? o.user_id : o.userId));
  const username = o.username || o.user_name || o.login || null;
  const balRaw = o.balance != null ? o.balance : (o.amount != null ? o.amount : (o.balance_amount != null ? o.balance_amount : (o.wallet && o.wallet.balance)));
  return { id, username, balance: _num(balRaw), raw: o };
}
function _unwrapList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.results)) return data.results;
  if (data && Array.isArray(data.data)) return data.data;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && Array.isArray(data.users)) return data.users;
  return [];
}

// ============================================================
// JUGADORES / SALDO
// ============================================================
async function _findByUsername(username) {
  const u = String(username || '').trim();
  if (!u) return null;
  const r = await _req('get', `/api/agent_admin/user/search/?username=${encodeURIComponent(u)}&is_direct_structure=false`,
    { referer: `${getBaseUrl()}/users/all` });
  if (!r.ok) return { error: r };
  const list = _unwrapList(r.data).map(_pickPlayer).filter(Boolean);
  const exact = list.find((p) => p.username && p.username.toLowerCase() === u.toLowerCase());
  return exact || list[0] || null;
}

async function _getById(id) {
  const r = await _req('get', `/api/agent_admin/user/${encodeURIComponent(id)}/`, { referer: `${getBaseUrl()}/users/all` });
  if (!r.ok) return { error: r };
  const p = _pickPlayer(r.data && (r.data.user || r.data.data || r.data));
  return p;
}

async function getUserInfoByName(username) {
  const found = await _findByUsername(username);
  if (!found || found.error) return null;
  // Si la búsqueda ya trae saldo, alcanza; si no, se completa con el detalle por id.
  let p = found;
  if ((p.balance == null || p.id == null) && found.id != null) {
    const det = await _getById(found.id);
    if (det && !det.error) p = det;
  }
  if (!p || p.id == null) return null;
  return {
    id: p.id, username: p.username || String(username), email: null, active: true,
    balance: p.balance, available: p.balance, locked: 0, bonusLocked: 0,
    claimableTotal: 0, claimable: [], wagering: null, createdAt: null
  };
}

async function getUserBalance(username) {
  const info = await getUserInfoByName(username);
  if (!info) return { success: false, error: 'No se pudo leer el jugador en GANAMOS.', code: 'player_not_found' };
  return { success: true, username: info.username, balance: info.balance, available: info.available, locked: 0, bonusLocked: 0, claimableTotal: 0, wagering: null };
}
async function getUserBalanceWithRetry(username, { maxAttempts = 3, baseDelayMs = 400 } = {}) {
  let last = null;
  for (let i = 1; i <= maxAttempts; i++) {
    last = await getUserBalance(username);
    if (last.success) return last;
    if (i < maxAttempts) await new Promise((r) => setTimeout(r, baseDelayMs * i));
  }
  return { ...last, attemptsExhausted: true };
}
async function checkUserExists(username) { return !!(await getUserInfoByName(username)); }
async function readPlayerWithKey(_k, username) { const i = await getUserInfoByName(username); return i ? { found: true, username: i.username, balance: i.balance } : { found: false, code: 'player_not_found' }; }

async function ping() {
  const lg = await _login();
  if (!lg.success) return { ok: false, estado: lg.code === 'cloudflare_blocked' ? 'cloudflare' : 'sin_sesion', detalle: lg.error };
  return { ok: true, estado: 'ok', detalle: `Sesión de agente activa (${_agentUser()})` };
}

// ============================================================
// PLATA — carga / retiro (SIN idempotencia: un solo intento)
// ============================================================
async function _payment(username, amount, operation, kind) {
  const amt = _amount(amount);
  if (amt === null) return { success: false, error: 'Monto inválido', code: 'invalid_amount' };
  const info = await getUserInfoByName(username);
  if (!info || info.id == null) return { success: false, error: `No se encontró al jugador ${username} en GANAMOS.`, code: 'player_not_found' };

  const r = await _req('post', `/api/agent_admin/user/${info.id}/payment/`,
    { body: { operation, amount: amt }, idempotent: false, referer: `${getBaseUrl()}/user/deposit/${info.id}` });

  if (!r.ok) {
    // indeterminate=true → el caller NO reintenta: verifica saldo/reporte y, si duda, a revisión.
    return { success: false, error: r.error || 'Fallo la operación', code: r.code, httpStatus: r.httpStatus, indeterminate: !!r.indeterminate };
  }
  const d = r.data || {};
  const txId = d.id != null ? String(d.id) : (d.transaction_id != null ? String(d.transaction_id) : (d.payment_id != null ? String(d.payment_id) : null));
  const balAfter = _num(d.balance != null ? d.balance : (d.user_balance != null ? d.user_balance : (d.new_balance)));
  if (_cashierHook) { try { _cashierHook({ balance: balAfter, opAmount: (kind === 'withdraw' ? -amt : amt), opKind: kind, username, at: new Date() }); } catch (_) {} }
  return {
    success: true, duplicate: false,
    data: { transfer_id: txId, transferId: txId, user_balance_after: balAfter == null ? undefined : balAfter, reference: null, type: kind }
  };
}

async function depositToUser(username, amount /* , description, reference, wagering */) {
  return _payment(username, amount, _opDeposit(), 'deposit');
}
async function withdrawFromUser(username, amount /* , description, reference */) {
  return _payment(username, amount, _opWithdraw(), 'withdraw');
}
// Regalos/bonos: el panel no expone bonos con rollover por API → se acreditan como
// una CARGA normal (fichas retirables). El rollover pedido se ignora (no hay dónde
// aplicarlo); conviene tener el rollover global de bonos APAGADO en este modo.
async function creditGift(username, amount, opts = {}) {
  const r = await _payment(username, amount, _opDeposit(), 'deposit');
  if (r && r.success) { r.creditedAs = 'deposit'; r.via = 'deposit'; r.rolloverApplied = 0; r.claimRequired = false; }
  return r;
}
async function creditUserBalance(username, amount, reference = null, opts = {}) {
  return creditGift(username, amount, opts);
}
function getGiftModeSummary() { return 'API de agente GANAMOS (carga directa, sin rollover)'; }

// ============================================================
// ALTA / CLAVE / SESIÓN / STATS — según lo que la API expone
// ============================================================
// ❗ No hay endpoint de ALTA en las capturas. Hasta capturar el "CREAR USUARIO" del
// panel, el alta automática NO está disponible: el agente crea el jugador a mano y la
// web solo lo VINCULA (syncUserToPlatform lo busca). Si aparece el endpoint, se
// implementa acá (probable: POST /api/agent_admin/user/ con {username,password,...}).
async function createPlatformUser({ username }) {
  const found = await getUserInfoByName(username);
  if (found) return { success: true, player: { id: found.id, username: found.username } };
  return { success: false, code: 'create_not_supported', error: 'El alta de jugador por API todavía no está mapeada: creá el usuario en el panel de GANAMOS y después vinculalo.' };
}
async function syncUserToPlatform({ username }) {
  const found = await getUserInfoByName(username);
  if (found) return { success: true, alreadyExists: true, platformUsername: found.username, player: found };
  return { success: false, code: 'player_not_found', error: 'Ese usuario no existe en GANAMOS. Crealo en el panel de agente primero.' };
}
async function validateCredentials(username) {
  // No hay endpoint para validar la clave de un JUGADOR (esto es el panel de agente).
  // El login de la web queda contra la base local (mismo criterio que el modo manual).
  return { success: true, valid: false, manual: true, error: 'La validación de clave del jugador no está disponible por la API de agente.' };
}
async function changeUserPassword() { return { success: false, code: 'not_supported', error: 'Cambio de clave del jugador no disponible por la API de agente.' }; }
async function createSession() { return { success: true, redirectUrl: getPlayUrl(), token: null, manual: true }; }
async function getUserMovements() { return { success: false, code: 'not_supported', error: 'Usar el reporte /payment/requests si hace falta.' }; }
async function getPlayerStats() { return { success: false, code: 'not_supported', error: 'El netwin no está disponible por la API de agente (reembolsos apagados en este modo).' }; }
async function getPlayersStatsBatch() { return { success: false, code: 'not_supported', results: {} }; }
function formatStatsDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const opts = { timeZone: 'America/Argentina/Buenos_Aires' };
  return `${d.toLocaleDateString('en-CA', opts)} ${d.toLocaleTimeString('en-GB', { ...opts, hour12: false })}`;
}
async function getPlatformConfig() { return { success: true, cached: true, config: { manual: false, ganamosApi: true, bonus: { enabled: false, standalone_enabled: false, multipliers: [], fixed_min: 0, fixed_max: 0 } } }; }
async function claimPendingBonus() { return { success: true, amount: 0, claimed: [], wagering: null }; }

// Diagnóstico (radiografía de boot)
function getReadsKeysCount() { return 0; }
function getReadsKeysSummary() { return 'n/a (API agente)'; }
function getPublisherKeyOverridesCount() { return 0; }
function getPublisherMaxRpm() { return 0; }
function getMasterMaxRpm() { return 0; }
function getPlayerCacheTtlMs() { return 0; }

module.exports = {
  errToString, setCashierBalanceHook, isEnabled, getPlayUrl, getBaseUrl, validateUsername, getProxySummary,
  setKeyResolver, createPlatformUser, getUserInfoByName, readPlayerWithKey, checkUserExists,
  ping, syncUserToPlatform, validateCredentials, changeUserPassword, createSession,
  depositToUser, creditGift, setRolloverResolver, withdrawFromUser, creditUserBalance,
  getUserBalance, getUserBalanceWithRetry, getPlayerStats, getPlayersStatsBatch, formatStatsDate,
  getPlatformConfig, claimPendingBonus, getGiftModeSummary, getUserMovements,
  getReadsKeysCount, getReadsKeysSummary, getPublisherKeyOverridesCount, getPublisherMaxRpm,
  getMasterMaxRpm, getPlayerCacheTtlMs,
  GANAMOS_API_MODE: true,
  // internos (para el test en frío)
  _login, _pickPlayer, _unwrapList, _opDeposit, _opWithdraw
};
