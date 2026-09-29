/**
 * platformService.js — SELECTOR del cliente de la plataforma de juego.
 *
 *   PLATFORM_MODE=manual (DEFAULT en este repo)
 *       → src/services/ganamosPlatformService.js: cada operación de plata se registra
 *         como PlatformTask y la ejecuta un agente en el panel de GANAMOS (sin API).
 *   PLATFORM_MODE=girox
 *       → src/services/giroxService.js: la Partner API REST de 1girox (wrapper VIPCARGAS).
 *
 * Los dos exponen el MISMO contrato; server.js y los servicios requieren ESTE módulo
 * (nunca a un cliente directo) y usan `girox.MANUAL_MODE` cuando un flujo necesita
 * saber con qué está hablando.
 *
 * Hubo un tercer modo `ganamos_api` (#191–#193, cliente automático contra la API del
 * panel de agente agents.ganamos.co). Se ELIMINÓ el 2026-09-29 (#194): GANAMOS lo
 * bloquea con Cloudflare + un desafío JS de Servicepipe y no es usable desde un server.
 * Cualquier otro valor de PLATFORM_MODE cae a `manual`.
 */
const mode = String(process.env.PLATFORM_MODE || 'manual').trim().toLowerCase();

let client;
if (mode === 'girox') client = require('./giroxService');
else client = require('./ganamosPlatformService');

if (!client.MANUAL_MODE) client.MANUAL_MODE = false;
client.PLATFORM_MODE = mode === 'girox' ? 'girox' : 'manual';

module.exports = client;
