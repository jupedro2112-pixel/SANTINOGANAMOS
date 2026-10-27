// ============================================
// META CONVERSIONS API (CAPI) SERVICE
// --------------------------------------------
// Envía eventos server-side a Meta para complementar el pixel del navegador.
// Mejora la precisión bajo iOS / adblockers y permite deduplicar con event_id.
//
// Variables de entorno requeridas:
//   META_PIXEL_ID                 — ID numérico del Pixel
//   META_CAPI_ACCESS_TOKEN        — Token de acceso CAPI (Eventos → Configuración → Conversions API)
//   META_TEST_EVENT_CODE          — (opcional) código de Test Events para validar antes de prod
//
// 2º PIXEL OPCIONAL (partner de tracking, 2026-08-19): cuando un tercero (ej. la
// pauta) pide recibir los MISMOS eventos server-side en SU pixel, se cargan estas
// y TODOS los eventos se disparan también a su pixel, en paralelo, sin tocar código:
//   META_PIXEL_ID_2               — Pixel ID del partner
//   META_CAPI_ACCESS_TOKEN_2      — Access Token CAPI del partner
//   META_TEST_EVENT_CODE_2        — (opcional) su código de Test Events para verificar
//
// Si no hay ningún pixel configurado, el módulo queda en no-op (warning una vez).
// Nunca lanza ni bloquea el flujo de negocio: errores se loguean como warning.
// ============================================

const crypto = require('crypto');
const axios = require('axios');

let logger = console;
try { logger = require('../utils/logger') || console; } catch (e) { /* fallback */ }

const GRAPH_API_VERSION = 'v22.0';
let _missingConfigLogged = false;

// Píxeles configurados (env/SSM, se leen en cada envío porque SSM carga en el bootstrap async, después del require):
//   n=1: META_PIXEL_ID + META_CAPI_ACCESS_TOKEN (+ META_TEST_EVENT_CODE) = el propio, recibe TODO.
//   n=2..9: META_PIXEL_ID_n + META_CAPI_ACCESS_TOKEN_n (+ META_TEST_EVENT_CODE_n) y META_PIXEL_PUBLISHER_n (códigos de campaña, nombres de
//   publicista o '*', por coma). #214 (réplica del #990 de PICA ROJA): hasta acá la CAPI
//   sólo mandaba al propio y al _2 (y el _2 recibía los eventos de TODOS los clientes); los _3.._9 sólo servían para el navegador de la landing.
//   Ahora un píxel con token recibe por CAPI los eventos de SUS clientes (los de las campañas/publicistas de META_PIXEL_PUBLISHER_n, o todos
//   con '*'); sin META_PIXEL_PUBLISHER_n sigue recibiendo todo (el "partner" de siempre). Sin token = sólo navegador.
// #214: píxeles cargados desde el PANEL (Configuración → Píxeles de Meta por publicista). El server los lee de Config['metaPixels'] (token cifrado),
// los descifra y los deja acá con setConfigPixels(); valen igual que los de SSM. Cada uno: { id, label, pixelId, token, scope[], testCode, capiOnly }.
let _cfgPixels = [];
function setConfigPixels(list) { _cfgPixels = Array.isArray(list) ? list.filter((p) => p && p.pixelId) : []; }
function listPixels() {
  const out = [];
  if (process.env.META_PIXEL_ID) out.push({ n: 1, label: 'propio', pixelId: String(process.env.META_PIXEL_ID), token: process.env.META_CAPI_ACCESS_TOKEN || '', testCode: process.env.META_TEST_EVENT_CODE || '', scope: ['*'], capiOnly: false });
  for (let i = 2; i <= 9; i++) {
    const pid = String(process.env['META_PIXEL_ID_' + i] || '').trim(); if (!pid) continue;
    const scope = _parsePixelScope(process.env['META_PIXEL_PUBLISHER_' + i]);
    out.push({ n: i, label: scope.length ? ('publicista ' + scope.join('/')) : 'partner (recibe todo)', pixelId: pid, token: String(process.env['META_CAPI_ACCESS_TOKEN_' + i] || ''), testCode: String(process.env['META_TEST_EVENT_CODE_' + i] || ''),
      scope: scope.length ? scope : ['*'], capiOnly: /^(1|true|on|yes)$/i.test(String(process.env['META_PIXEL_CAPIONLY_' + i] || '')), source: 'ssm' });
  }
  _cfgPixels.forEach((p) => { const scope = Array.isArray(p.scope) && p.scope.length ? p.scope : ['*'];
    out.push({ n: 'c' + p.id, id: p.id, label: p.label || ('publicista ' + scope.join('/')), pixelId: String(p.pixelId), token: String(p.token || ''), testCode: String(p.testCode || ''), scope, capiOnly: !!p.capiOnly, source: 'panel' }); });
  return out;
}
function _scopeMatches(scope, info) {
  if (!scope || !scope.length || scope.includes('*')) return true;
  if (!info) return false;
  const code = info.campaignCode ? String(info.campaignCode).trim().toUpperCase() : '', pub = info.publisher ? String(info.publisher).trim().toLowerCase() : '';
  return scope.some((s) => (code && s.toUpperCase() === code) || (pub && s.toLowerCase() === pub));
}
// Destinos de la CAPI para un evento: los píxeles con token cuyo alcance incluye al cliente del evento (info = { publisher, campaignCode } o null).
// Sin `info` (p. ej. isConfigured) devuelve todos los que tienen token.
// El alcance rige para TODOS los píxeles con alcance, incluido el `_2` de SSM (en el gemelo el `_2` era el píxel de un publicista:
// hasta ahora recibía los eventos de TODOS los clientes; owner: "son dos pautas distintas, no mezclar"). Sin META_PIXEL_PUBLISHER_n = recibe todo.
function _capiDestinations(info) {
  const all = listPixels().filter((p) => p.token && (info === undefined || _scopeMatches(p.scope, info)));
  // #216: el MISMO píxel cargado en SSM y en el panel ⇒ un solo envío por evento (gana el del panel, que es el que se puede editar/probar).
  const byId = new Map();
  for (const p of all) { const cur = byId.get(p.pixelId); if (!cur || (p.source === 'panel' && cur.source !== 'panel')) byId.set(p.pixelId, p); }
  return [...byId.values()];
}

// ---- Resolución del "dueño" de un evento (publicista + campaña) — #197 (réplica
// del #334 del gemelo AUTOGIROXcompartido). Lo usan los WEBHOOKS SALIENTES para
// decidir qué destino recibe cada aviso. Lookup lazy (los modelos ya están
// registrados por el server) con cache corto para no pegarle a Mongo en cada
// evento. Orden para el usuario: campaña de alta → campaña dueña de la key.
// (`lastTouchCampaign` queda primero por compatibilidad con el gemelo: en este
// repo el campo no existe y el select lo ignora.)
const _campaignPubCache = new Map(); // code → { publisher, ts }
const CAMPAIGN_CACHE_MS = 5 * 60 * 1000;
async function _publisherOfCampaign(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  const hit = _campaignPubCache.get(c);
  if (hit && Date.now() - hit.ts < CAMPAIGN_CACHE_MS) return hit.publisher;
  let publisher = null;
  try {
    const Campaign = require('../models/Campaign');
    const doc = await Campaign.findOne({ code: c }).select('publisher').lean();
    publisher = doc && doc.publisher ? String(doc.publisher) : null;
  } catch (_) {}
  _campaignPubCache.set(c, { publisher, ts: Date.now() });
  return publisher;
}
// Devuelve { publisher, campaignCode } o null. Acepta opts.publisher /
// opts.campaignCode explícitos (evita el lookup) o resuelve por el usuario
// (`userInfo.externalId` = User.id).
// #797 (réplica del #198 de CARGASGIROX): píxeles de Meta para el NAVEGADOR de la landing, por campaña/publicista.
// META_PIXEL_ID_n (n = 2..9) + META_PIXEL_PUBLISHER_n = lista separada por coma de códigos de campaña, nombres de publicista o '*'.
// META_PIXEL_CAPIONLY_n=1 ⇒ ese píxel sólo recibe eventos server-side (no se entrega al navegador). Los valores viven en SSM, nunca acá.
function _parsePixelScope(raw) {
  return String(raw || '').split(',').map((x) => x.trim()).filter(Boolean);
}
async function pixelIdsForCampaign(campaignCode) {
  const code = String(campaignCode || '').trim().toUpperCase();
  if (!code) return [];
  const publisher = await _publisherOfCampaign(code);
  const info = { publisher, campaignCode: code };
  // #214: los de SSM (n ≥ 2 con META_PIXEL_PUBLISHER_n) y los del panel; nunca el propio (n=1) ni los "sólo CAPI". Un píxel de SSM sin alcance
  // (partner) tampoco va al navegador (como antes: sólo recibe por CAPI).
  const ids = [];
  listPixels().forEach((p) => {
    if (p.n === 1 || p.capiOnly) return;
    if (p.source === 'ssm' && !_parsePixelScope(process.env['META_PIXEL_PUBLISHER_' + p.n]).length) return;
    if (_scopeMatches(p.scope, info) && !ids.includes(p.pixelId)) ids.push(p.pixelId);
  });
  return ids;
}
async function resolveEventScope(userInfo, opts) {
  const o = opts || {};
  if (o.publisher || o.campaignCode) {
    const publisher = o.publisher || await _publisherOfCampaign(o.campaignCode);
    return { publisher: publisher || null, campaignCode: o.campaignCode || null };
  }
  const userId = userInfo && userInfo.externalId != null ? String(userInfo.externalId) : null;
  if (!userId) return null;
  try {
    const User = require('../models/User');
    const u = await User.findOne({ id: userId }).select('lastTouchCampaign acquisitionCampaign giroxOwnerCampaign').lean();
    if (!u) return null;
    const code = u.lastTouchCampaign || u.acquisitionCampaign || u.giroxOwnerCampaign || null;
    if (!code) return null;
    return { publisher: await _publisherOfCampaign(code), campaignCode: code };
  } catch (_) { return null; }
}


function isConfigured() {
  return _capiDestinations().length > 0;
}

function sha256(value) {
  if (value === undefined || value === null) return undefined;
  const str = String(value).trim().toLowerCase();
  if (!str) return undefined;
  return crypto.createHash('sha256').update(str).digest('hex');
}

// Normaliza teléfono a sólo dígitos antes de hashear (requisito de Meta).
// Fix móviles AR: los formularios suelen guardar el celular sin el "9" móvil
// (ej: +54 11 2275-5331 → 541122755331), pero Facebook/WhatsApp almacenan los
// móviles AR con el "9" intercalado (5491122755331). Sin esa corrección los
// hashes nunca matchean y el Custom Audience pierde a casi todos los usuarios.
// La heurística es conservadora: sólo agrega el 9 si el número tiene 12
// dígitos, empieza con 54, y no tiene ya un 9 móvil. Cualquier otro país o
// fijo internacional queda intacto. Único falso positivo posible: un fijo
// AMBA de 12 dígitos — aceptable porque la app es de cargas/apuestas y el
// 99% de los teléfonos cargados son celulares.
function normalizePhone(phone) {
  if (!phone) return undefined;
  let digits = String(phone).replace(/\D/g, '');
  if (!digits) return undefined;
  if (digits.length === 12 && digits.startsWith('54') && digits[2] !== '9') {
    digits = '549' + digits.slice(2);
  }
  return digits;
}

function newEventId() {
  return crypto.randomUUID();
}

// Construye el bloque user_data hasheando PII según especificación de Meta.
// userInfo: { email, phone, externalId, firstName, lastName, country, city, gender, dateOfBirth }
// requestCtx: { ip, userAgent, fbp, fbc }
function buildUserData(userInfo = {}, requestCtx = {}) {
  const user_data = {};

  const emailHash = sha256(userInfo.email);
  if (emailHash) user_data.em = [emailHash];

  const phoneHash = sha256(normalizePhone(userInfo.phone));
  if (phoneHash) user_data.ph = [phoneHash];

  const externalIdHash = sha256(userInfo.externalId);
  if (externalIdHash) user_data.external_id = [externalIdHash];

  const fnHash = sha256(userInfo.firstName);
  if (fnHash) user_data.fn = [fnHash];

  const lnHash = sha256(userInfo.lastName);
  if (lnHash) user_data.ln = [lnHash];

  const countryHash = sha256(userInfo.country);
  if (countryHash) user_data.country = [countryHash];

  const cityHash = sha256(userInfo.city);
  if (cityHash) user_data.ct = [cityHash];

  const genderHash = sha256(userInfo.gender);
  if (genderHash) user_data.ge = [genderHash];

  const dobHash = sha256(userInfo.dateOfBirth);
  if (dobHash) user_data.db = [dobHash];

  // #241 (acá; #213 en CARGASGIROX): sin request (auto-carga del banco, crons) se usa la IP/navegador del JUGADOR persistidos en su registro (userInfo.clientIp / clientUserAgent).
  const clientIp = requestCtx.ip || userInfo.clientIp;
  const clientUa = requestCtx.userAgent || userInfo.clientUserAgent;
  if (clientIp) user_data.client_ip_address = clientIp;
  if (clientUa) user_data.client_user_agent = clientUa;
  // fbp / fbc — identificadores de Meta Ads (fbp = navegador, fbc = clic del
  // anuncio, clave para atribuir conversiones a la pauta).
  // Prioridad: la cookie viva del request (eventos browser-side / self-service).
  // Fallback: el valor persistido en el usuario (userInfo.fbc / userInfo.fbp).
  // El fallback es imprescindible para eventos server-side como Purchase
  // disparado desde un request de admin, donde la cookie del jugador no existe
  // en req.headers.cookie.
  const fbp = requestCtx.fbp || userInfo.fbp;
  const fbc = requestCtx.fbc || userInfo.fbc;
  if (fbp) user_data.fbp = fbp;
  if (fbc) user_data.fbc = fbc;

  return user_data;
}

// Extrae fbp/fbc/ip/userAgent de una request Express.
function extractRequestContext(req) {
  if (!req) return {};
  const cookies = parseCookies(req.headers && req.headers.cookie);
  return {
    ip: req.ip || (req.headers && req.headers['x-forwarded-for'] && String(req.headers['x-forwarded-for']).split(',')[0].trim()) || null,
    userAgent: req.headers && req.headers['user-agent'] ? String(req.headers['user-agent']) : null,
    fbp: cookies._fbp || null,
    fbc: cookies._fbc || null
  };
}

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return out;
  cookieHeader.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  });
  return out;
}

// Envía un evento a Conversions API. Nunca lanza.
// args:
//   eventName       — string ('Purchase', 'CompleteRegistration', 'Lead', etc. o custom)
//   userInfo        — datos del usuario (se hashea internamente)
//   customData      — { value, currency, content_name, ... } pasado tal cual a Meta
//   options         — { eventId, eventSourceUrl, actionSource, testEventCode, req }
async function sendEvent(eventName, userInfo, customData, options) {
  const opts0 = options || {};
  // #214: a qué publicista/campaña pertenece el cliente del evento (para los píxeles con alcance). Si no se puede saber, sólo los píxeles sin alcance.
  let scopeInfo = null; try { scopeInfo = await resolveEventScope(userInfo || {}, { publisher: opts0.publisher, campaignCode: opts0.campaignCode }); } catch (_) { scopeInfo = null; }
  const dests = _capiDestinations(scopeInfo);
  if (!dests.length) {
    if (_capiDestinations().length) return { sent: false, reason: 'no_pixel_for_scope', scope: scopeInfo }; // hay píxeles, pero ninguno para este cliente
    if (!_missingConfigLogged) {
      _missingConfigLogged = true;
      logger.warn('[MetaCAPI] META_PIXEL_ID o META_CAPI_ACCESS_TOKEN no configurados — eventos server-side deshabilitados');
    }
    return { sent: false, reason: 'not_configured' };
  }

  if (!eventName || typeof eventName !== 'string') {
    return { sent: false, reason: 'invalid_event' };
  }

  const opts = options || {};
  const req = opts.req || null;
  const requestCtx = extractRequestContext(req);

  const user_data = buildUserData(userInfo || {}, requestCtx);

  // El MISMO event_id para todos los destinos (cada pixel deduplica por su lado).
  const event = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: opts.eventId || newEventId(),
    action_source: opts.actionSource || 'website',
    user_data,
    custom_data: customData || {}
  };

  if (opts.eventSourceUrl) {
    event.event_source_url = opts.eventSourceUrl;
  } else if (req && req.headers && req.headers.referer) {
    event.event_source_url = String(req.headers.referer);
  }

  // Se dispara a CADA pixel configurado (propio + partner) en paralelo. Un fallo
  // en uno no afecta al otro. Cada destino usa su propio test_event_code.
  const results = await Promise.all(dests.map(async (d) => {
    const payload = { data: [event] };
    const tc = opts.testEventCode || d.testCode;
    if (tc) payload.test_event_code = tc;
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${d.pixelId}/events`;
    try {
      const response = await axios.post(url, payload, {
        params: { access_token: d.token },
        timeout: 5000
      });
      _noteResult(d.n, eventName, true, response.data);
      return { dest: d.label, n: d.n, sent: true, data: response.data };
    } catch (err) {
      const detail = err.response && err.response.data ? JSON.stringify(err.response.data) : err.message;
      logger.warn(`[MetaCAPI] Error enviando evento ${eventName} a pixel ${d.label} (#${d.n}): ${detail}`);
      _noteResult(d.n, eventName, false, detail);
      return { dest: d.label, n: d.n, sent: false, error: detail };
    }
  }));

  return { sent: results.some((r) => r.sent), eventId: event.event_id, results };
}

// #214: último resultado por píxel (en memoria de la instancia) para el diagnóstico del panel: GET /api/admin/meta-pixels.
const _lastByPixel = new Map();
function _noteResult(n, eventName, ok, detail) {
  const prev = _lastByPixel.get(n) || { ok: 0, fail: 0 };
  prev[ok ? 'ok' : 'fail']++; prev.last = { at: new Date().toISOString(), event: eventName, ok, detail: typeof detail === 'string' ? detail.slice(0, 300) : detail };
  _lastByPixel.set(n, prev);
}
function stats() { const o = {}; _lastByPixel.forEach((v, k) => { o[k] = v; }); return o; }
// #214: envío de PRUEBA a un píxel puntual (panel): un evento con nombre propio para ver si Meta lo acepta (token válido, píxel correcto).
async function testPixel(n, testEventCode) {
  const p = listPixels().find((x) => String(x.n) === String(n)); if (!p) return { ok: false, error: 'no hay píxel ' + n };
  if (!p.token) return { ok: false, error: 'el píxel ' + n + ' no tiene token: sólo navegador. ' + (p.source === 'panel' ? 'Cargale el token en el panel.' : 'Falta META_CAPI_ACCESS_TOKEN' + (n === 1 ? '' : '_' + n) + ' en SSM.') };
  const event = { event_name: 'GanamosTest', event_time: Math.floor(Date.now() / 1000), event_id: 'test_' + Date.now(), action_source: 'website', user_data: { client_user_agent: 'ganamos-panel-test', external_id: [sha256('ganamos-test')] }, custom_data: { source: 'panel' } };
  const payload = { data: [event] }; const tc = testEventCode || p.testCode; if (tc) payload.test_event_code = tc;
  try {
    const r = await axios.post(`https://graph.facebook.com/${GRAPH_API_VERSION}/${p.pixelId}/events`, payload, { params: { access_token: p.token }, timeout: 8000 });
    return { ok: true, n: p.n, pixelId: p.pixelId, testEventCode: tc || null, response: r.data };
  } catch (err) {
    const data = err.response && err.response.data; const e = data && data.error;
    return { ok: false, n: p.n, pixelId: p.pixelId, http: err.response && err.response.status, error: e ? { message: e.message, type: e.type, code: e.code, subcode: e.error_subcode, fbtrace_id: e.fbtrace_id } : err.message,
      pista: e && e.code === 190 ? 'Token inválido o vencido: generar uno nuevo en Eventos → Configuración → API de conversiones del PÍXEL del publicista y cargarlo en SSM.' : (e && /permission|not have|does not exist/i.test(e.message || '') ? 'El token no es de este píxel (o el ID del píxel está mal): el token tiene que crearse en el mismo conjunto de datos/píxel.' : null) };
  }
}
// Radiografía para el log de arranque (esta repo la imprime en el bootstrap).
function destinationsSummary() {
  const all = listPixels(); if (!all.length) return 'no configurado';
  return all.map((p) => `#${p.n} ${p.label}${p.token ? '' : ' (sin token: sólo navegador)'} ${String(p.pixelId).slice(0, 6)}…`).join(' · ');
}
// Fire-and-forget. Útil para no bloquear el response del endpoint.
function track(eventName, userInfo, customData, options) {
  return sendEvent(eventName, userInfo, customData, options).catch((e) => {
    logger.warn(`[MetaCAPI] track() fallo no esperado: ${e.message}`);
    return { sent: false, reason: 'unexpected', error: e.message };
  });
}

// ============================================
// ADVANCED MATCHING (browser pixel)
// --------------------------------------------
// Devuelve los hashes precalculados que el frontend pasa a `fbq('init', ID, {...})`
// para que cada evento browser-side incluya identificadores hasheados del usuario.
// Mantiene la normalización en un solo lugar (este archivo) y evita exponer PII
// en cleartext al cliente. `country` default 'ar' porque el negocio opera en AR.
// `external_id` se hashea para consistencia con los eventos server-side; Meta
// acepta tanto hasheado como en texto plano.
// ============================================
function buildAdvancedMatching(userInfo) {
  if (!userInfo) return null;
  const matching = {};
  const em = sha256(userInfo.email);
  if (em) matching.em = em;
  const ph = sha256(normalizePhone(userInfo.phone));
  if (ph) matching.ph = ph;
  const ext = sha256(userInfo.externalId);
  if (ext) matching.external_id = ext;
  const fn = sha256(userInfo.firstName);
  if (fn) matching.fn = fn;
  const ln = sha256(userInfo.lastName);
  if (ln) matching.ln = ln;
  const country = sha256(userInfo.country || 'ar');
  if (country) matching.country = country;
  return Object.keys(matching).length ? matching : null;
}

// ============================================
// VALUE BUCKETS (Purchase content_category)
// --------------------------------------------
// Buckets de monto para alimentar Value Optimization de Meta Ads. Los umbrales
// están pensados para cargas en ARS — si cambia la moneda, recalibrar.
// ============================================
function valueCategory(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (n < 5000) return 'low';
  if (n < 20000) return 'medium';
  if (n < 50000) return 'high';
  return 'whale';
}

module.exports = {
  destinationsSummary,
  listPixels, setConfigPixels, stats, testPixel, _capiDestinations, _scopeMatches, // #214
  resolveEventScope,
  pixelIdsForCampaign, // #797
  isConfigured,
  newEventId,
  extractRequestContext,
  sendEvent,
  track,
  buildAdvancedMatching,
  valueCategory
};
