// ============================================
// WEBHOOKS SALIENTES (#334) — registro / primera carga / carga / retiro
// --------------------------------------------
// Owner 2026-10-08: además del pixel de Meta (que sigue igual, en paralelo),
// avisar por WEBHOOK a uno o varios destinos: un publicista, varios, o TODOS.
// Cada destino se configura desde el panel (Config['outboundWebhooks']):
//   { id, name, url, secret (cifrado), enabled,
//     scope: 'all' | 'publishers', publishers: ['Ok2026', 'PWAUTO', …]  // nombre del
//            publicista (Campaign.publisher) o código de campaña,
//     events: { registro, primera_carga, carga, retiro },               // qué recibe
//     fields: { atribucion, contacto } }                                 // opcionales
//
// Aviso (POST JSON):
//   headers: X-Webhook-Event, X-Webhook-Id, X-Webhook-Timestamp (unix seg),
//            X-Webhook-Signature = HMAC-SHA256 hex de `${timestamp}.${body}` con el
//            secreto del destino (mismo esquema que GH Wallet: el receptor valida con
//            el body EXACTO). Idempotencia: `event_id` fijo por evento (repetir un
//            reintento manda el MISMO id).
//   body: { event, event_id, sent_at, site, test, user:{…}, amount, currency,
//           first_deposit, transaction_id, occurred_at, attribution?, contact? }
//
// Entrega: 3 reintentos inmediatos (1s/4s/16s); si falla, cola en Mongo
// (OutboundWebhookQueue) reintentada cada 5 min hasta 10 intentos. 4xx (salvo
// 408/429) no se reintenta. Fire-and-forget: NUNCA frena el handler que lo llama.
// ============================================

const axios = require('axios');
const crypto = require('crypto');
const OutboundWebhookQueue = require('../models/OutboundWebhookQueue');

let logger = console;
try { logger = require('../utils/logger') || console; } catch (e) { /* fallback */ }

const RETRY_DELAYS_MS = [1000, 4000, 16000];
const MAX_TOTAL_ATTEMPTS = 10;
const QUEUE_RETRY_MS = 5 * 60 * 1000;
const POST_TIMEOUT_MS = 8000;
const EVENTS = ['registro', 'primera_carga', 'carga', 'retiro'];

// Inyectado desde server.js: cómo leer los destinos (con el secreto ya descifrado),
// cómo resolver publicista/campaña de un usuario y la URL pública del sitio.
let _cfg = { getDestinations: async () => [], resolveScope: async () => null, publicBaseUrl: () => '' };
function configure(opts) { _cfg = Object.assign({}, _cfg, opts || {}); }

// Estadísticas por destino (por instancia, desde el arranque): último resultado.
const _stats = new Map();
function _stat(destId, ok, err, event) {
  const st = _stats.get(destId) || { ok: 0, fail: 0, lastAt: null, lastOk: null, lastError: null, lastEvent: null };
  if (ok) st.ok++; else { st.fail++; st.lastError = String(err || '').slice(0, 200); }
  st.lastAt = new Date(); st.lastOk = !!ok; st.lastEvent = event || st.lastEvent;
  _stats.set(destId, st);
}
function getStats(destId) { return _stats.get(destId) || null; }

function sign(secret, timestamp, body) {
  return crypto.createHmac('sha256', String(secret)).update(String(timestamp) + '.' + body).digest('hex');
}

function _fbclidFromFbc(fbc) {
  const m = String(fbc || '').match(/^fb\.\d+\.\d+\.(.+)$/);
  return m ? m[1] : null;
}

function _scopeAllows(dest, scope) {
  if (!dest || dest.scope !== 'publishers') return true;
  const list = (dest.publishers || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
  if (!list.length) return false;
  if (!scope) return false;
  const pub = String(scope.publisher || '').trim().toLowerCase();
  const code = String(scope.campaignCode || '').trim().toLowerCase();
  return (pub && list.includes(pub)) || (code && list.includes(code));
}

// Arma el body para un destino (respeta sus opcionales).
function buildPayload({ event, eventId, user, scope, opts, dest }) {
  const u = user || {};
  const o = opts || {};
  const body = {
    event,
    event_id: eventId,
    sent_at: new Date().toISOString(),
    site: _cfg.publicBaseUrl() || null,
    test: o.test === true,
    // Sin username (#344): el publicista identifica al jugador por `id` (UUID interno,
    // opaco y estable; el panel → Usuarios lo busca pegándolo en el buscador). Que no
    // sepa el usuario exacto de cada persona.
    user: {
      id: u.id || null,
      created_at: u.createdAt ? new Date(u.createdAt).toISOString() : null,
      campaign: scope && scope.campaignCode ? scope.campaignCode : (u.acquisitionCampaign || null),
      publisher: scope && scope.publisher ? scope.publisher : null,
      influencer: u.acquisitionInfluencer || null,
      // `source` = URL COMPLETA de origen (dominio + ruta + parámetros con la que entró el
      // jugador; la landing manda location.href). Lo pidió PulWin (#348) para asignar el
      // tráfico por dominio/ruta; antes iba 'landing'/'panel', que ahora es `channel`.
      // #248: sale de `originUrl` (first-touch, fija desde el registro): `landingUrl` se pisa en
      // cada login con la URL de la app (cargasganamos.com/) y PulWin rechazaba las cargas por
      // "origen distinto del registro". Cuentas viejas sin originUrl: la migración del boot la copia.
      source: u.originUrl || u.landingUrl || null,
      channel: u.acquisitionSource || null
    },
    amount: o.amount != null ? Number(o.amount) : null,
    currency: o.amount != null ? 'ARS' : null,
    first_deposit: o.firstDeposit === true,
    transaction_id: o.transactionId || null,
    occurred_at: (o.occurredAt ? new Date(o.occurredAt) : new Date()).toISOString()
  };
  if (dest && dest.fields && dest.fields.atribucion) {
    const utm = u.acquisitionUtm && typeof u.acquisitionUtm === 'object' ? u.acquisitionUtm : {};
    body.attribution = {
      fbclid: _fbclidFromFbc(u.metaFbc),
      fbc: u.metaFbc || null,
      fbp: u.metaFbp || null,
      utm_source: utm.source || utm.utm_source || null,
      utm_medium: utm.medium || utm.utm_medium || null,
      utm_campaign: utm.campaign || utm.utm_campaign || null,
      utm_content: utm.content || utm.utm_content || null,
      utm_term: utm.term || utm.utm_term || null,
      landing_url: u.originUrl || u.landingUrl || null,
      last_url: u.landingUrl || null,
      registration_ip: u.registrationIp || null
    };
  }
  if (dest && dest.fields && dest.fields.contacto) {
    body.contact = { email: u.email || null, phone: u.phone || null, phone_verified: u.phoneVerified === true };
  }
  return body;
}

async function _post(dest, payload) {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'ganamos-webhook/1.0',
    'X-Webhook-Event': payload.event,
    'X-Webhook-Id': payload.event_id,
    'X-Webhook-Timestamp': ts,
    'X-Webhook-Signature': sign(dest.secret || '', ts, body)
  };
  // Modo de autenticación extra según lo que pide el receptor (#346; ver _normalizeOutboundDest).
  const auth = dest.auth || {};
  const secret = dest.secret || '';
  if (auth.mode === 'hmac_body') {
    const h = crypto.createHmac('sha256', String(secret)).update(body).digest('hex');
    headers[auth.header || 'X-Signature'] = (auth.prefix || '') + h;
  } else if (auth.mode === 'bearer') {
    headers['Authorization'] = 'Bearer ' + secret;
  } else if (auth.mode === 'header' && auth.header) {
    headers[auth.header] = (auth.prefix || '') + secret;
  }
  return _send(dest.url, body, headers);
}
async function _send(url, body, headers) {
  const resp = await axios.post(url, body, { headers, timeout: POST_TIMEOUT_MS, maxRedirects: 0, validateStatus: () => true });
  if (resp.status >= 200 && resp.status < 300) return { ok: true, status: resp.status };
  const retryable = resp.status >= 500 || resp.status === 408 || resp.status === 429;
  // Lo que respondió el receptor (recortado) para que el panel diga POR QUÉ rechazó
  // (401 "invalid signature" vs "missing token" cambia qué hay que arreglar).
  let detail = '';
  try {
    const d = resp.data;
    const txt = d == null ? '' : (typeof d === 'string' ? d : JSON.stringify(d));
    detail = txt.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  } catch (_) {}
  return { ok: false, status: resp.status, retryable, error: `HTTP ${resp.status}${detail ? ': ' + detail : ''}` };
}

async function _deliver(dest, payload, attemptsSoFar) {
  let attempts = attemptsSoFar || 0;
  let lastErr = null;
  for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
    attempts++;
    try {
      const r = await _post(dest, payload);
      if (r.ok) { _stat(dest.id, true, null, payload.event); return { ok: true, attempts }; }
      lastErr = r.error;
      if (!r.retryable) { _stat(dest.id, false, lastErr, payload.event); return { ok: false, attempts, fatal: true, error: lastErr }; }
    } catch (e) {
      lastErr = e.code === 'ECONNABORTED' ? 'timeout' : e.message;
    }
    if (i < RETRY_DELAYS_MS.length - 1) await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[i]));
  }
  _stat(dest.id, false, lastErr, payload.event);
  return { ok: false, attempts, fatal: false, error: lastErr };
}

async function _enqueue(dest, payload, attempts, lastError) {
  try {
    await OutboundWebhookQueue.create({ destId: dest.id, event: payload.event, eventId: payload.event_id, payload, attempts, lastError: String(lastError || '').slice(0, 200), nextRetryAt: new Date(Date.now() + QUEUE_RETRY_MS) });
  } catch (e) { logger.warn(`[webhooks] no se pudo encolar (${dest.name || dest.id}): ${e.message}`); }
}

async function _sendToDest(dest, payload) {
  const r = await _deliver(dest, payload, 0);
  if (r.ok) return;
  if (r.fatal) { logger.warn(`[webhooks] ${dest.name || dest.id}: ${payload.event} rechazado (${r.error}) — no se reintenta`); return; }
  logger.warn(`[webhooks] ${dest.name || dest.id}: ${payload.event} no entregado (${r.error}) — a la cola`);
  await _enqueue(dest, payload, r.attempts, r.error);
}

/**
 * Notifica un evento. `event`: 'registro' | 'carga' | 'retiro'. Para 'carga', opts.firstDeposit
 * decide si el destino lo recibe como 'primera_carga'. `user` = doc (o {id}) del usuario.
 * opts: { amount, firstDeposit, transactionId, occurredAt, campaignCode, publisher, test }.
 * Fire-and-forget: devuelve enseguida; todo corre en background.
 */
function notify(event, user, opts) {
  setImmediate(() => { _notify(event, user, opts).catch((e) => logger.warn(`[webhooks] notify ${event} falló: ${e.message}`)); });
}
async function _notify(event, user, opts) {
  const o = opts || {};
  let dests = [];
  try { dests = (await _cfg.getDestinations()) || []; } catch (e) { return; }
  dests = dests.filter((d) => d && d.enabled && d.url);
  if (!dests.length) return;
  let u = user;
  if (u && u.id && (!u.username || u.acquisitionCampaign === undefined)) {
    try {
      const User = require('../models/User');
      u = (await User.findOne({ id: String(u.id) }).select('id username createdAt acquisitionCampaign acquisitionInfluencer acquisitionSource lastTouchCampaign giroxOwnerCampaign acquisitionUtm metaFbc metaFbp landingUrl originUrl registrationIp email phone phoneVerified').lean()) || u;
    } catch (_) {}
  }
  if (!u) return;
  let scope = null;
  try { scope = await _cfg.resolveScope({ externalId: u.id }, { campaignCode: o.campaignCode, publisher: o.publisher }); } catch (_) {}
  const outEvent = event === 'carga' ? (o.firstDeposit ? 'primera_carga' : 'carga') : event;
  const baseId = o.eventKey || `${outEvent}_${u.id}_${o.transactionId || o.payoutId || (event === 'registro' ? 'reg' : Date.now())}`;
  for (const dest of dests) {
    const ev = dest.events || {};
    const wants = outEvent === 'primera_carga' ? (ev.primera_carga || ev.carga) : ev[outEvent];
    if (!wants) continue;
    if (!_scopeAllows(dest, scope)) continue;
    const payload = buildPayload({ event: outEvent, eventId: baseId, user: u, scope, opts: o, dest });
    _sendToDest(dest, payload).catch(() => {});
  }
}

/** Manda un aviso de PRUEBA a un destino (desde el panel). Devuelve el resultado del POST. */
async function sendTest(dest) {
  const payload = buildPayload({
    event: 'prueba', eventId: 'prueba_' + Date.now(),
    user: { id: 'prueba-0000-0000-0000-000000000000', createdAt: new Date(), acquisitionCampaign: 'PRUEBA', acquisitionSource: 'landing', landingUrl: (_cfg.publicBaseUrl() || 'https://ejemplo.com') + '/PRUEBA', email: 'prueba@ejemplo.com', phone: '+5491100000000', metaFbc: 'fb.1.1700000000000.AbCdEf', metaFbp: 'fb.1.1700000000000.123456' },
    scope: { publisher: 'Publicista de prueba', campaignCode: 'PRUEBA' },
    opts: { amount: 5000, firstDeposit: true, transactionId: 'tx_prueba', test: true }, dest
  });
  try {
    const r = await _post(dest, payload);
    _stat(dest.id, r.ok, r.error, 'prueba');
    return Object.assign({ payload }, r);
  } catch (e) {
    const err = e.code === 'ECONNABORTED' ? 'timeout' : e.message;
    _stat(dest.id, false, err, 'prueba');
    return { ok: false, error: err, payload };
  }
}

// Worker: reintenta lo encolado. Un item se descarta si pasó MAX_TOTAL_ATTEMPTS o si
// el destino ya no existe / está apagado.
async function processQueue() {
  let dests = [];
  try { dests = (await _cfg.getDestinations()) || []; } catch (_) { return; }
  const byId = new Map(dests.map((d) => [d.id, d]));
  let items = [];
  try { items = await OutboundWebhookQueue.find({ nextRetryAt: { $lte: new Date() } }).sort({ nextRetryAt: 1 }).limit(50).lean(); } catch (_) { return; }
  for (const it of items) {
    const dest = byId.get(it.destId);
    if (!dest || !dest.enabled || !dest.url || it.attempts >= MAX_TOTAL_ATTEMPTS) {
      await OutboundWebhookQueue.deleteOne({ _id: it._id }).catch(() => {});
      continue;
    }
    const r = await _deliver(dest, it.payload, it.attempts);
    if (r.ok || r.fatal) { await OutboundWebhookQueue.deleteOne({ _id: it._id }).catch(() => {}); continue; }
    await OutboundWebhookQueue.updateOne({ _id: it._id }, { $set: { attempts: r.attempts, lastError: String(r.error || '').slice(0, 200), nextRetryAt: new Date(Date.now() + QUEUE_RETRY_MS) } }).catch(() => {});
  }
}
let _worker = null;
function startWorker() {
  if (_worker) return;
  setTimeout(() => { processQueue().catch(() => {}); }, 60 * 1000);
  _worker = setInterval(() => { processQueue().catch(() => {}); }, QUEUE_RETRY_MS);
  if (_worker.unref) _worker.unref();
}
async function pendingCount(destId) {
  try { return await OutboundWebhookQueue.countDocuments(destId ? { destId } : {}); } catch (_) { return 0; }
}

module.exports = { EVENTS, configure, notify, sendTest, processQueue, startWorker, getStats, pendingCount, sign, buildPayload };
