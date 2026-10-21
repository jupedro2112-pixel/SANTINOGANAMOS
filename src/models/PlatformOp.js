/**
 * Modelo PlatformOp — LIBRO MAYOR LOCAL de las operaciones de plata contra una API
 * SIN idempotencia (PLATFORM_MODE=mijoker, Operator API v0.1 de mijoker.com).
 *
 * La Operator API no acepta `reference`: `POST /account-transfers` acredita o debita
 * cada vez que se la llama. Para conservar la REGLA DE ORO del repo (misma reference
 * = misma operación, reintento = `duplicate:true`, nunca dos veces la misma plata)
 * el cliente registra ACÁ cada operación ANTES de llamar a la API y decide por el
 * estado guardado:
 *
 *   - `pending`  → en vuelo (otra instancia la está mandando, o este proceso murió
 *                  en el medio: pasados IN_FLIGHT_MS se trata como `unknown`).
 *   - `done`     → la API respondió 200: un reintento devuelve `duplicate:true`.
 *   - `failed`   → la API la rechazó SIN moverla (400/403/404/429, o el rate limit
 *                  local): se puede reintentar con la misma reference.
 *   - `unknown`  → timeout / red / 5xx: NO se sabe si se acreditó. Antes de volver a
 *                  mandar hay que RECONCILIAR contra `balance-history` (monto +
 *                  operación + ventana de tiempo). Si aparece → `done`; si el
 *                  historial dice que no está → `failed` (reintentable); si el
 *                  historial no responde, queda `unknown` y el flujo falla con
 *                  `code:'unknown_outcome'` (nunca se reintenta a ciegas).
 *
 * `reference` es ÚNICA (índice): dos instancias con la misma reference no duplican.
 * Ver src/services/mijokerService.js (`_moneyOp`, `_reconcile`).
 */
const mongoose = require('mongoose');

const platformOpSchema = new mongoose.Schema({
  reference: { type: String, required: true, unique: true, index: true },
  // deposit = carga · withdraw = retiro · gift = bono/regalo/premio (todo es INCOME/OUTCOME en la API)
  kind: { type: String, enum: ['deposit', 'withdraw', 'gift'], required: true, index: true },
  operation: { type: String, enum: ['INCOME', 'OUTCOME'], required: true },
  username: { type: String, required: true, index: true },
  usernameLower: { type: String, index: true },
  platformUserId: { type: Number, default: null },
  amount: { type: Number, required: true },
  description: { type: String, default: '' },
  flow: { type: String, default: null, index: true },
  status: { type: String, enum: ['pending', 'done', 'failed', 'unknown'], default: 'pending', index: true },
  attempts: { type: Number, default: 0 },
  startedAt: { type: Date, default: null },
  finishedAt: { type: Date, default: null },
  // Lo que devolvió la API (200) o lo que encontró la reconciliación.
  balanceAfter: { type: Number, default: null },
  platformTxId: { type: String, default: null },
  reconciled: { type: Boolean, default: false },
  ambiguous: { type: Boolean, default: false },
  error: { type: String, default: null },
  errorCode: { type: String, default: null },
  httpStatus: { type: Number, default: null },
  meta: { type: mongoose.Schema.Types.Mixed, default: {} }
}, {
  timestamps: true
});

platformOpSchema.index({ status: 1, updatedAt: -1 });
platformOpSchema.index({ usernameLower: 1, status: 1, finishedAt: -1 });

module.exports = mongoose.models['PlatformOp'] || mongoose.model('PlatformOp', platformOpSchema);
