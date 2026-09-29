/**
 * platformService.js — SELECTOR del cliente de la plataforma de juego.
 *
 *   PLATFORM_MODE=manual (DEFAULT en este repo)
 *       → src/services/ganamosPlatformService.js: cada operación de plata se registra
 *         como PlatformTask y la ejecuta un agente en el panel de GANAMOS (sin API).
 *   PLATFORM_MODE=ganamos_api
 *       → src/services/ganamosApiService.js: automático contra la API del panel de
 *         agente (agents.ganamos.co). Login con usuario+clave del AGENTE (SSM), sin
 *         idempotencia (pagos de un solo intento) y detrás de Cloudflare. Ver #191.
 *   PLATFORM_MODE=girox
 *       → src/services/giroxService.js: la Partner API REST de 1girox (wrapper VIPCARGAS).
 *
 * Los tres exponen el MISMO contrato; server.js y los servicios requieren ESTE módulo
 * (nunca a un cliente directo) y usan `girox.MANUAL_MODE` / `girox.GANAMOS_API_MODE`
 * cuando un flujo necesita saber con qué está hablando.
 */
const mode = String(process.env.PLATFORM_MODE || 'manual').trim().toLowerCase();

let client;
if (mode === 'girox') client = require('./giroxService');
else if (mode === 'ganamos_api') client = require('./ganamosApiService');
else client = require('./ganamosPlatformService');

if (!client.MANUAL_MODE) client.MANUAL_MODE = false;
if (!client.GANAMOS_API_MODE) client.GANAMOS_API_MODE = false;
client.PLATFORM_MODE = (mode === 'girox' || mode === 'ganamos_api') ? mode : 'manual';

module.exports = client;
