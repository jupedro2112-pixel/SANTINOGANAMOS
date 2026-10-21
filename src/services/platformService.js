/**
 * platformService.js — SELECTOR del cliente de la plataforma de juego.
 *
 *   PLATFORM_MODE=manual (DEFAULT en este repo)
 *       → src/services/ganamosPlatformService.js: cada operación de plata se registra
 *         como PlatformTask y la ejecuta un agente en el panel de GANAMOS (sin API).
 *   PLATFORM_MODE=mijoker (#231, 2026-10-21)
 *       → src/services/mijokerService.js: Operator API v0.1 de mijoker.com (copia de
 *         GANAMOS CON API): alta, saldo, carga/retiro, historial, clave y estado.
 *         Sin bonos, rollover, netwin ni SSO; la idempotencia la pone el libro mayor
 *         local PlatformOp. Doc: docs/API-MIJOKER-OPERATOR-v0.1.md.
 *   PLATFORM_MODE=girox
 *       → src/services/giroxService.js: la Partner API REST de 1girox (wrapper VIPCARGAS).
 *
 * Los tres exponen el MISMO contrato; server.js y los servicios requieren ESTE módulo
 * (nunca a un cliente directo). Dos banderas para los flujos que necesitan saber con
 * qué hablan:
 *   - `girox.MANUAL_MODE`: true sólo en manual (bandeja de PlatformTask).
 *   - `girox.FEATURES`: capacidades de la plataforma ACTIVA (server.js deriva de acá
 *     PLATFORM_NO_ROLLOVER / NO_STATS / NO_SSO / NO_SELFSIGNUP; la PWA y el panel las
 *     reciben en /api/public/config, /api/auth/verify y /api/admin/me):
 *       api       tiene API (manual: false)
 *       tasks     las operaciones van a la bandeja "Pendientes" (sólo manual)
 *       balance   se puede leer el saldo del jugador
 *       stats     hay netwin → reembolsos por netwin / VIP / cashback / referidos
 *       sso       hay link de sesión (botón CASINO embebido); si no, pestaña
 *       signup    el registro público puede crear al jugador en la plataforma
 *       rollover  la plataforma tiene rollover de bonos
 *       bonus     hay bonos como entidad (reclamo, bono activo)
 *       cashier   se conoce el saldo del agente (cruce del cierre diario)
 *
 * Hubo un modo `ganamos_api` (#191–#193, cliente contra el panel de agente
 * agents.ganamos.co). Se ELIMINÓ el 2026-09-29 (#194): GANAMOS lo bloquea con
 * Cloudflare + Servicepipe. Cualquier otro valor de PLATFORM_MODE cae a `manual`.
 *
 * ⚠️ Se lee al require (antes de que SSM cargue): PLATFORM_MODE y
 * MIJOKER_PUBLIC_REGISTER van como propiedades del entorno de EB, no en SSM.
 */
const raw = String(process.env.PLATFORM_MODE || 'manual').trim().toLowerCase();
const mode = ['girox', 'mijoker'].includes(raw) ? raw : 'manual';

const FEATURES = {
  girox:   { api: true,  tasks: false, balance: true,  stats: true,  sso: true,  signup: true,  rollover: true,  bonus: true,  cashier: true },
  manual:  { api: false, tasks: true,  balance: false, stats: false, sso: false, signup: false, rollover: false, bonus: false, cashier: false },
  // MIJOKER_PUBLIC_REGISTER=0 cierra el registro público (alta sólo por agente, como en manual).
  mijoker: { api: true,  tasks: false, balance: true,  stats: false, sso: false, signup: String(process.env.MIJOKER_PUBLIC_REGISTER || '1') !== '0', rollover: false, bonus: false, cashier: false }
};

let client;
if (mode === 'girox') client = require('./giroxService');
else if (mode === 'mijoker') client = require('./mijokerService');
else client = require('./ganamosPlatformService');

if (!client.MANUAL_MODE) client.MANUAL_MODE = false;
client.PLATFORM_MODE = mode;
client.FEATURES = Object.freeze({ ...FEATURES[mode] });

module.exports = client;
