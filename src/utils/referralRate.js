/**
 * referralRate.js — Cuánto se lleva el referidor.
 *
 * REGLA DE NEGOCIO (owner, 2026-09-29, #195):
 *
 *     comisión del referidor = netwin del referido × {porcentaje de referidos}
 *
 * Una sola tasa, aplicada UNA sola vez. Si un referido perdió $100.000 jugando en el
 * mes y el porcentaje es 3%, su referidor cobra $3.000 en fichas.
 *
 * DE DÓNDE SALE EL PORCENTAJE (prioridad):
 *   1. Comando `/sys_referral_pct` de la sección COMANDOS del panel: su `response` es
 *      el NÚMERO (ej. "3", "3%", "2,5"). El owner lo edita ahí y TODOS los textos que
 *      muestran el % (Información del Servicio, modal Mis Referidos, variable
 *      `{referral_pct}` de cualquier /sys_*) lo toman de acá. Se cachea 30 s.
 *   2. Env `GIROX_REFERRAL_COMMISSION_PCT` (en PORCENTAJE: 3 = 3%).
 *   3. `DEFAULT_REFERRAL_PCT` (3).
 * Por usuario, `referralRateOverride` (en DECIMAL: 0.05 = 5%) pisa todo lo anterior
 * para acuerdos puntuales.
 *
 * ⚠️ HISTORIA — por qué esto está comentado tan fuerte:
 * El default era 7% y se aplicaba SOBRE una comisión previa (en JUGAYGANA, la que nos
 * daba el proveedor sobre el GGR). O sea, dos tasas encadenadas. Al migrar a 1girox
 * —donde el proveedor devuelve todas sus comisiones en 0— se puso un 8% en el primer
 * eslabón y quedó multiplicándose por el 7% de acá: el referidor cobraba **0,56%** del
 * netwin en vez del 8%. El encadenamiento se eliminó (ver
 * referralCalculationService.fetchReferredRevenue) y esta es ahora la ÚNICA tasa del
 * cálculo. Si alguien vuelve a multiplicar por otra cosa, se repite el bug.
 *
 * Los getters SINCRÓNICOS (`getConfiguredRate`, `getReferralRateForUser`) devuelven el
 * último valor cacheado del comando; el motor de referidos llama `refreshReferralPct()`
 * antes de calcular para que el cache esté fresco. Los flujos async usan
 * `getReferralPct()` directamente.
 */

/** Nombre del comando editable desde COMANDOS cuya response es el porcentaje. */
const REFERRAL_PCT_COMMAND = '/sys_referral_pct';

/** Porcentaje por defecto. 3 = 3% del netwin del referido. */
const DEFAULT_REFERRAL_PCT = 3;
/** Tasa por defecto, en decimal (compat con los consumidores viejos). */
const DEFAULT_REFERRAL_RATE = DEFAULT_REFERRAL_PCT / 100;

const CACHE_TTL_MS = 30 * 1000;
let _cache = { pct: null, at: 0 };

/** "3", "3%", "3,5 %", " 2.5" → número; basura → null. Rango válido (0, 100]. */
function parsePct(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().replace('%', '').replace(',', '.').trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return null;
  return n;
}

/** Porcentaje de env o default (sin DB). */
function envOrDefaultPct() {
  const pct = parsePct(process.env.GIROX_REFERRAL_COMMISSION_PCT);
  return pct != null ? pct : DEFAULT_REFERRAL_PCT;
}

/**
 * Relee el comando `/sys_referral_pct` (si el cache venció o `force`). Nunca lanza.
 * @returns {Promise<number>} porcentaje vigente (ej. 3)
 */
async function refreshReferralPct(force = false) {
  const now = Date.now();
  if (!force && _cache.pct != null && now - _cache.at < CACHE_TTL_MS) return _cache.pct;
  let pct = null;
  try {
    // Lazy: evita ciclos de require (models → services → utils) y funciona sin DB.
    const Command = require('../models/Command');
    const cmd = await Command.findOne({ name: REFERRAL_PCT_COMMAND, isActive: true }).lean();
    if (cmd) pct = parsePct(cmd.response);
  } catch (e) {
    try { require('./logger').warn(`[referralRate] ${REFERRAL_PCT_COMMAND}: ${e.message} — usando env/default`); } catch (_) { /* sin logger */ }
  }
  _cache = { pct: pct != null ? pct : envOrDefaultPct(), at: now };
  return _cache.pct;
}

/** Porcentaje vigente (async, con cache de 30 s). Ej. 3. */
async function getReferralPct() {
  return refreshReferralPct(false);
}

/**
 * Tasa configurada, en decimal, SIN esperar a la DB: usa el último valor cacheado del
 * comando o, si todavía no se leyó, env/default. Los flujos que pagan plata llaman
 * `refreshReferralPct()` antes.
 */
function getConfiguredRate() {
  const pct = _cache.pct != null ? _cache.pct : envOrDefaultPct();
  return pct / 100;
}

/**
 * Tasa de comisión aplicable a un referidor.
 * @param {Object} user - documento del usuario referidor
 * @returns {number} tasa decimal (ej. 0.03 para 3%)
 */
function getReferralRateForUser(user) {
  // Override por usuario (acuerdos puntuales). Se valida el rango: un valor corrupto
  // acá se paga en plata real.
  if (user && typeof user.referralRateOverride === 'number' &&
      Number.isFinite(user.referralRateOverride) &&
      user.referralRateOverride > 0 && user.referralRateOverride <= 1) {
    return user.referralRateOverride;
  }
  return getConfiguredRate();
}

/** Porcentaje (ej. 3) aplicable a un usuario, para mostrarlo en textos. */
async function getReferralPctForUser(user) {
  const pct = await getReferralPct();
  const rate = getReferralRateForUser(user);
  const userPct = Math.round(rate * 100 * 100) / 100;
  return user && user.referralRateOverride ? userPct : pct;
}

module.exports = {
  REFERRAL_PCT_COMMAND,
  DEFAULT_REFERRAL_PCT,
  DEFAULT_REFERRAL_RATE,
  parsePct,
  refreshReferralPct,
  getReferralPct,
  getReferralPctForUser,
  getConfiguredRate,
  getReferralRateForUser
};
