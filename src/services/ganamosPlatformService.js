/**
 * ganamosPlatformService.js — ADAPTADOR MANUAL de la plataforma (GANAMOS, sin API).
 *
 * GANAMOS no expone ninguna API: las cargas, retiros y bonos los ejecuta UNA PERSONA
 * en el panel de GANAMOS. Este módulo implementa EXACTAMENTE el mismo contrato que
 * `giroxService.js` (mismos nombres, mismos parámetros, mismas formas de retorno)
 * para que los ~130 puntos de server.js que hablaban con 1girox sigan funcionando
 * sin reescribirlos — pero en vez de pegarle a una API:
 *
 *   - Cada operación de plata se registra como `PlatformTask` (bandeja "Pendientes
 *     GANAMOS" del panel). Las que nacen de un clic del agente (`agentExecuted:true`
 *     en las opciones: Depositar, aprobar retiro, Bonificación) quedan `done` al
 *     instante porque el agente YA las hizo en GANAMOS; las que dispara el server
 *     solo (hgcash, ruleta, fueguito, VIP, referidos, lotes…) quedan `pending`
 *     hasta que un agente las marque hechas.
 *   - La `reference` sigue siendo la llave de idempotencia (índice único): un
 *     reintento con la misma reference devuelve `duplicate:true` sin crear otra
 *     tarea, igual que hacía la Partner API.
 *   - No hay saldo: `getUserBalance` devuelve `success:false, code:'manual_mode'`.
 *     Los flujos que dependían del saldo (validación de retiro, guards de bono)
 *     tienen que tolerar esa respuesta (lo hacen: es el mismo camino que "no se
 *     pudo leer el saldo").
 *   - No hay netwin: `getPlayerStats` devuelve `manual_mode` (reembolsos y comisión
 *     de referidos quedan apagados por config mientras no haya fuente de datos).
 *   - Alta de usuario: el jugador YA existe en GANAMOS (viene derivado de WhatsApp);
 *     `syncUserToPlatform` sólo valida el username y lo da por vinculado.
 *   - Botón CASINO: `createSession` devuelve la URL pública de GANAMOS
 *     (`GANAMOS_PLAY_URL`), sin token.
 *
 * Selección del cliente: `src/services/platformService.js` (PLATFORM_MODE).
 */
const { v4: uuidv4 } = require('uuid');
const _fileLogger = require('../utils/logger');
const PlatformTask = require('../models/PlatformTask');

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
function getPlayUrl() {
  return (process.env.GANAMOS_PLAY_URL || 'https://ganamos.net').replace(/\/+$/, '');
}
function getBaseUrl() { return 'manual://ganamos'; }
/** Siempre "habilitado": en modo manual no hay credenciales que puedan faltar. */
function isEnabled() { return true; }

// Hooks que server.js inyecta (mismo contrato que giroxService). Se guardan por
// contrato; el resolver de rollover NO se usa (#196: GANAMOS no tiene rollover).
let _rolloverResolver = null;
let _cashierHook = null;
let _keyResolver = null;
function setRolloverResolver(fn) { _rolloverResolver = typeof fn === 'function' ? fn : null; }
function setCashierBalanceHook(fn) { _cashierHook = (typeof fn === 'function') ? fn : null; }
function setKeyResolver(fn) { _keyResolver = typeof fn === 'function' ? fn : null; }
async function _globalRollover() {
  if (!_rolloverResolver) return null;
  try {
    const v = await _rolloverResolver();
    const n = Number(v);
    return (v == null || !Number.isFinite(n) || n < 0) ? null : Math.round(n);
  } catch (_) { return null; }
}

// Resolver de userId por username (inyectado desde server.js para no acoplar el
// adaptador al modelo User; si no está, la tarea queda sin userId y el panel la
// muestra igual por username).
let _userIdResolver = null;
function setUserIdResolver(fn) { _userIdResolver = typeof fn === 'function' ? fn : null; }
async function _userIdFor(username) {
  if (!_userIdResolver || !username) return null;
  try { return (await _userIdResolver(String(username))) || null; } catch (_) { return null; }
}

// Callback opcional de eventos de la bandeja: (event, task) con event =
// 'created' (tarea NUEVA pendiente) | 'done' | 'rejected'. server.js lo usa para
// avisar al cliente y dejar la nota en el chat del panel.
let _taskListener = null;
function setTaskListener(fn) { _taskListener = typeof fn === 'function' ? fn : null; }
async function _emitTask(event, task) {
  if (!_taskListener || !task) return;
  try { await _taskListener(event, task); } catch (e) { logger.warn(`[ganamos] listener ${event} tarea ${task._id}: ${e.message}`); }
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

function validateUsername(username) {
  const u = String(username || '').trim();
  if (u.length < 3) return { valid: false, reason: 'menos de 3 caracteres' };
  if (u.length > 30) return { valid: false, reason: `${u.length} caracteres (máximo 30)` };
  if (!/^[A-Za-z0-9_.-]+$/.test(u)) return { valid: false, reason: 'tiene caracteres no permitidos (sólo letras, números, _ . -)' };
  return { valid: true };
}

function _normalizeAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

function _buildReference(prefix, explicit) {
  if (explicit) return String(explicit).slice(0, 100);
  const generated = `${prefix}-${uuidv4()}`;
  logger.warn(`[ganamos] operación SIN reference estable — se generó ${generated}. ` +
    'Pasar una reference persistida para tener idempotencia real entre requests.');
  return generated;
}

/** Flujo de origen deducido del prefijo de la reference (cuando el caller no lo pasa). */
const _REF_FLOWS = [
  ['vip-hg-', 'hgcash'], ['vip-dep-', 'admin_deposit'], ['vip-wd-', 'admin_withdrawal'], ['vip-bonus-', 'admin_bonus'],
  ['vip-payoutref', 'payout_refund'], ['vip-payout-', 'payout'], ['vip-roulette-', 'roulette'], ['vip-fire', 'fire'],
  ['vip-lvl-', 'vip'], ['vip-levelup', 'vip'], ['vip-nbatch', 'batch'], ['vip-welcome-', 'welcome_code'], ['vip-rf-', 'refund'],
  ['vip-cbk-', 'cashback'], ['vip-rake', 'rakeback'], ['vip-refcom-', 'referral'], ['vip-sdep-', 'movements'], ['vip-swd-', 'movements']
];
function _flowFromReference(reference) {
  const r = String(reference || '');
  const hit = _REF_FLOWS.find(([p]) => r.startsWith(p));
  return hit ? hit[1] : null;
}

/** Misma forma que `_moneyResult` de giroxService, con `pending`/`task` extra. */
function _taskResult(task, duplicate) {
  const id = String(task._id);
  return {
    success: true,
    duplicate: !!duplicate,
    pending: task.status === 'pending',
    manual: true,
    taskId: id,
    data: {
      transfer_id: id,
      transferId: id,
      user_balance_after: undefined,
      reference: task.reference,
      ledger_id: null,
      type: task.kind,
      created_at: task.createdAt || null,
      duplicate: !!duplicate,
      wagering: null,
      pending: task.status === 'pending',
      taskId: id
    }
  };
}

/**
 * Registra (o recupera) la tarea con esa reference. Atómico por el índice único:
 * dos instancias que corran el mismo flujo con la misma reference no duplican.
 */
async function _recordTask({ kind, username, amount, description, reference, bonus, rolloverX, flow, agentExecuted, agentName, meta }) {
  const existing = await PlatformTask.findOne({ reference }).lean();
  if (existing) {
    logger.info(`[ganamos] ${kind}(${username}, $${amount}) ref=${reference} — DUPLICADA (tarea ${existing._id}, ${existing.status})`);
    return _taskResult(existing, true);
  }
  const doc = {
    kind,
    status: agentExecuted ? 'done' : 'pending',
    reference,
    username: String(username),
    userId: await _userIdFor(username),
    amount,
    description: String(description || '').slice(0, 500),
    bonus: {
      amount: bonus && bonus.amount != null ? Number(bonus.amount) : null,
      percent: bonus && bonus.percent != null ? Number(bonus.percent) : null,
      multiplier: bonus && bonus.multiplier != null ? Number(bonus.multiplier) : null
    },
    rolloverX: rolloverX != null ? Number(rolloverX) : null,
    source: agentExecuted ? 'agent' : 'server',
    flow: flow || _flowFromReference(reference),
    createdBy: agentExecuted ? (agentName || null) : null,
    doneBy: agentExecuted ? (agentName || null) : null,
    doneAt: agentExecuted ? new Date() : null,
    meta: meta || {}
  };
  try {
    const task = await PlatformTask.create(doc);
    logger.info(`[ganamos] ${kind}(${username}, $${amount}) ref=${reference} → tarea ${task._id} ${task.status}` +
      (flow ? ` [${flow}]` : ''));
    if (task.status === 'pending') await _emitTask('created', task.toObject ? task.toObject() : task);
    return _taskResult(task, false);
  } catch (e) {
    if (e && e.code === 11000) {
      const again = await PlatformTask.findOne({ reference }).lean();
      if (again) return _taskResult(again, true);
    }
    logger.error(`[ganamos] no se pudo registrar ${kind}(${username}, $${amount}) ref=${reference}: ${e.message}`);
    return { success: false, error: `No se pudo registrar la operación: ${e.message}`, code: 'task_write_failed' };
  }
}

// ============================================================
// JUGADORES
// ============================================================
/** El jugador ya existe en GANAMOS (viene de WhatsApp): sólo se valida el nombre. */
async function createPlatformUser({ username }) {
  const check = validateUsername(username);
  if (!check.valid) {
    return { success: false, error: `Usuario inválido para la plataforma: ${check.reason}`, code: 'invalid_username' };
  }
  return { success: true, player: { id: null, username: String(username), manual: true } };
}

/**
 * Sin API no hay lectura de jugador. Devuelve un objeto "vacío" (saldo null) para
 * que los flujos que sólo necesitan `username`/`id` sigan; los guards de bono
 * (`bonusLocked + claimableTotal`) ven 0 y no bloquean.
 */
async function getUserInfoByName(username) {
  const u = String(username || '').trim();
  if (!u) return null;
  return {
    id: null,
    username: u,
    email: null,
    active: true,
    balance: null,
    available: null,
    locked: 0,
    bonusLocked: 0,
    claimableTotal: 0,
    claimable: [],
    wagering: null,
    createdAt: null,
    manual: true
  };
}

async function readPlayerWithKey(_apiKey, username) {
  return { found: true, username: String(username), balance: null, manual: true };
}

async function checkUserExists() { return true; }

async function ping() {
  return { ok: true, estado: 'manual', detalle: 'Modo MANUAL (GANAMOS sin API): las operaciones van a la bandeja de pendientes del panel.' };
}

async function syncUserToPlatform({ username }) {
  const check = validateUsername(username);
  if (!check.valid) {
    return { success: false, error: `Usuario inválido para la plataforma: ${check.reason}`, code: 'invalid_username' };
  }
  return { success: true, alreadyExists: true, platformUsername: String(username), player: { id: null, username: String(username), manual: true } };
}

/**
 * ⚠️ SEGURIDAD: sin API NO se puede validar una clave contra GANAMOS. El login de
 * server.js crea la cuenta local cuando la plataforma "valida" al jugador, así que
 * acá SIEMPRE es `valid:false`: nadie entra a una cuenta que no exista en la web
 * (la crea el agente desde el panel y le manda el link de acceso).
 */
async function validateCredentials(username) {
  return { success: true, valid: false, player: null, manual: true, error: 'En modo manual no se valida contra la plataforma' };
}

/** La clave de GANAMOS la maneja el agente; acá no hay nada que sincronizar. */
async function changeUserPassword(username, newPassword) {
  if (!newPassword || String(newPassword).length < 6) {
    return { success: false, error: 'La contraseña debe tener al menos 6 caracteres', code: 'invalid_password' };
  }
  return { success: true, manual: true };
}

/** Botón CASINO: link fijo a GANAMOS (el jugador entra con su usuario y clave de GANAMOS). */
async function createSession() {
  return { success: true, redirectUrl: getPlayUrl(), token: null, manual: true };
}

// ============================================================
// PLATA — todo termina en PlatformTask
// ============================================================
/**
 * @param {object} [wagering] { multiplier, bonusPercent, bonusAmount, bonusMultiplier,
 *   ignoreGlobalRollover, agentExecuted, agentName, flow, meta }
 */
async function depositToUser(username, amount, description = '', reference = null, wagering = null) {
  const amt = _normalizeAmount(amount);
  if (amt === null) return { success: false, error: 'Monto inválido', code: 'invalid_amount' };
  const w = wagering || {};
  // #196 GANAMOS NO tiene rollover: el bono de la carga es siempre x0 (plata libre).
  // Se ignora tanto el multiplier del caller como el resolver global.
  const bonusMultiplier = 0;
  return _recordTask({
    kind: 'deposit',
    username,
    amount: amt,
    description,
    reference: _buildReference('dep', reference),
    bonus: { amount: w.bonusAmount, percent: w.bonusPercent, multiplier: bonusMultiplier },
    rolloverX: 0, // #196 sin rollover en GANAMOS
    flow: w.flow || null,
    agentExecuted: !!w.agentExecuted,
    agentName: w.agentName || null,
    meta: w.meta || {}
  });
}

async function withdrawFromUser(username, amount, description = '', reference = null, opts = {}) {
  const amt = _normalizeAmount(amount);
  if (amt === null) return { success: false, error: 'Monto inválido', code: 'invalid_amount' };
  const o = opts || {};
  return _recordTask({
    kind: 'withdraw',
    username,
    amount: amt,
    description,
    reference: _buildReference('wd', reference),
    flow: o.flow || null,
    agentExecuted: !!o.agentExecuted,
    agentName: o.agentName || null,
    meta: o.meta || {}
  });
}

async function creditGift(username, amount, opts = {}) {
  const amt = _normalizeAmount(amount);
  if (amt === null) return { success: false, error: 'Monto inválido', code: 'invalid_amount' };
  const o = opts || {};
  // #196 GANAMOS NO tiene rollover: todo regalo es plata libre (x0), venga con el
  // rolloverX que venga y esté o no el resolver global.
  const roll = 0;
  const r = await _recordTask({
    kind: 'gift',
    username,
    amount: amt,
    description: o.description || '',
    reference: _buildReference('bonus', o.reference),
    rolloverX: roll,
    flow: o.flow || null,
    agentExecuted: !!o.agentExecuted,
    agentName: o.agentName || null,
    meta: o.meta || {}
  });
  if (r && r.success) {
    r.creditedAs = 'bonus';
    r.via = 'manual';
    r.rolloverApplied = roll;
    r.claimRequired = false;
  }
  return r;
}

async function creditUserBalance(username, amount, reference = null, opts = {}) {
  const o = opts || {};
  const explicit = o.multiplier != null ? Number(o.multiplier) : null;
  return creditGift(username, amount, {
    reference,
    description: o.description || '',
    rolloverX: explicit != null ? explicit : 0,
    ignoreGlobalRollover: !!o.ignoreGlobalRollover,
    agentExecuted: !!o.agentExecuted,
    agentName: o.agentName || null,
    flow: o.flow || null,
    meta: o.meta || {}
  });
}

function getGiftModeSummary() { return 'manual (tarea para el agente en GANAMOS)'; }

// ============================================================
// SALDO / STATS — no disponibles sin API
// ============================================================
const MANUAL_ERR = { success: false, code: 'manual_mode', manual: true };

async function getUserBalance(username) {
  return { ...MANUAL_ERR, username: String(username || ''), error: 'El saldo no está disponible: GANAMOS no tiene API (el agente lo consulta en el panel de GANAMOS).' };
}
async function getUserBalanceWithRetry(username) {
  return { ...(await getUserBalance(username)), attemptsExhausted: true };
}
async function getUserMovements() {
  return { success: false, error: 'El historial de movimientos no está disponible en modo manual.', code: 'not_supported' };
}
function formatStatsDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const opts = { timeZone: 'America/Argentina/Buenos_Aires' };
  return `${d.toLocaleDateString('en-CA', opts)} ${d.toLocaleTimeString('en-GB', { ...opts, hour12: false })}`;
}
async function getPlayerStats() {
  return { ...MANUAL_ERR, error: 'El netwin no está disponible: GANAMOS no tiene API.' };
}
async function getPlayersStatsBatch() {
  return { ...MANUAL_ERR, error: 'El netwin no está disponible: GANAMOS no tiene API.', results: {} };
}
async function getPlatformConfig() {
  // #196 GANAMOS: sin rollover → el único multiplicador permitido es 0.
  return { success: true, cached: true, config: { manual: true, bonus: { enabled: true, standalone_enabled: true, multipliers: [0], fixed_min: 0, fixed_max: 0 }, rollover: { enabled: false } } };
}
async function claimPendingBonus() {
  return { success: true, amount: 0, claimed: [], wagering: null, manual: true };
}

// ============================================================
// DIAGNÓSTICO (radiografía de boot)
// ============================================================
function getReadsKeysCount() { return 0; }
function getReadsKeysSummary() { return 'n/a (manual)'; }
function getPublisherKeyOverridesCount() { return 0; }
function getPublisherMaxRpm() { return 0; }
function getMasterMaxRpm() { return 0; }
function getPlayerCacheTtlMs() { return 0; }

// ============================================================
// BANDEJA — la usa el panel (endpoints en server.js)
// ============================================================
async function listTasks({ status = 'pending', limit = 200, username = null } = {}) {
  const q = {};
  if (status && status !== 'all') q.status = status;
  if (username) q.username = new RegExp('^' + String(username).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
  return PlatformTask.find(q).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 200, 1000)).lean();
}
async function countPending() {
  return PlatformTask.countDocuments({ status: 'pending' });
}
/** Marca hecha/rechazada. Idempotente: si ya no está pending, devuelve el estado actual. */
async function settleTask(taskId, { status, by, note }) {
  if (!['done', 'rejected'].includes(status)) return { success: false, error: 'Estado inválido', code: 'invalid_status' };
  const task = await PlatformTask.findOneAndUpdate(
    { _id: taskId, status: 'pending' },
    { $set: { status, doneBy: by || null, doneAt: new Date(), note: String(note || '').slice(0, 500) } },
    { new: true }
  ).lean();
  if (!task) {
    const cur = await PlatformTask.findById(taskId).lean();
    if (!cur) return { success: false, error: 'Tarea inexistente', code: 'not_found' };
    return { success: true, task: cur, alreadySettled: true };
  }
  await _emitTask(status, task);
  return { success: true, task };
}

module.exports = {
  errToString,
  setCashierBalanceHook,
  isEnabled,
  getPlayUrl,
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
  // propios del modo manual
  MANUAL_MODE: true,
  setUserIdResolver,
  setTaskListener,
  listTasks,
  countPending,
  settleTask,
  PlatformTask
};
