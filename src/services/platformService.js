/**
 * platformService.js — SELECTOR del cliente de la plataforma de juego.
 *
 *   PLATFORM_MODE=manual (DEFAULT en este repo: GANAMOS no tiene API)
 *       → src/services/ganamosPlatformService.js: cada operación de plata se
 *         registra como PlatformTask y la ejecuta un agente en el panel de GANAMOS.
 *   PLATFORM_MODE=girox
 *       → src/services/giroxService.js: la Partner API REST de 1girox (el wrapper
 *         original VIPCARGAS). Se conserva entero para poder volver.
 *
 * Los dos exponen el MISMO contrato; server.js y los servicios requieren ESTE
 * módulo (nunca a giroxService directo) y usan `girox.MANUAL_MODE` cuando un flujo
 * necesita saber si está hablando con una persona o con una API.
 */
const mode = String(process.env.PLATFORM_MODE || 'manual').trim().toLowerCase();
const client = mode === 'girox'
  ? require('./giroxService')
  : require('./ganamosPlatformService');

if (!client.MANUAL_MODE) client.MANUAL_MODE = false;
client.PLATFORM_MODE = mode === 'girox' ? 'girox' : 'manual';

module.exports = client;
