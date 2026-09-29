/**
 * Modelo PlatformTask — BANDEJA DE OPERACIONES A EJECUTAR EN GANAMOS (modo manual).
 *
 * GANAMOS no tiene API: toda operación sobre el saldo del jugador (carga, retiro,
 * regalo/bono) la ejecuta UNA PERSONA en el panel de GANAMOS. Este modelo es el
 * registro de cada una de esas operaciones tal como el server las "habría mandado"
 * a la Partner API de 1girox:
 *
 *   - `status:'pending'` → la generó el SERVER solo (transferencia hgcash detectada,
 *     premio de la ruleta, fueguito, nivel VIP, comisión de referidos, lote...) y un
 *     agente TODAVÍA tiene que acreditarla/debitarla en GANAMOS. Aparece en la
 *     sección "Pendientes GANAMOS" del panel hasta que la marquen hecha o rechazada.
 *   - `status:'done'` → ya está ejecutada. Las operaciones que dispara el propio
 *     agente desde el panel (Depositar, aprobar retiro, Bonificación) nacen `done`
 *     porque el clic del agente ES la confirmación de que ya lo hizo en GANAMOS.
 *   - `status:'rejected'` → el agente decidió no ejecutarla (con nota).
 *
 * `reference` es la MISMA llave de idempotencia que se mandaba a 1girox (vip-hg-*,
 * vip-roulette-*, etc.) y es ÚNICA: un reintento del mismo flujo con la misma
 * reference NO genera una segunda tarea (devuelve duplicate:true, igual que la API).
 * Ver src/services/ganamosPlatformService.js.
 */
const mongoose = require('mongoose');

const platformTaskSchema = new mongoose.Schema({
  // deposit = acreditar carga · withdraw = debitar retiro · gift = bono/regalo/premio
  kind: { type: String, enum: ['deposit', 'withdraw', 'gift'], required: true, index: true },
  status: { type: String, enum: ['pending', 'done', 'rejected'], default: 'pending', index: true },
  // Llave de idempotencia (la reference que iba a la Partner API). Única.
  reference: { type: String, required: true, unique: true, index: true },
  username: { type: String, required: true, index: true },
  userId: { type: String, default: null, index: true },
  amount: { type: Number, required: true },
  description: { type: String, default: '' },
  // Bono que acompaña una carga (agente o automático) y rollover pedido.
  bonus: {
    amount: { type: Number, default: null },
    percent: { type: Number, default: null },
    multiplier: { type: Number, default: null }
  },
  rolloverX: { type: Number, default: null },
  // Quién la originó: 'server' (automática, queda pendiente) o 'agent' (nace hecha).
  source: { type: String, enum: ['server', 'agent'], default: 'server', index: true },
  // Flujo de origen para el panel (hgcash, roulette, fire, vip, referral, batch,
  // welcome_code, refund, admin_deposit, admin_bonus, payout, payout_refund...).
  flow: { type: String, default: null, index: true },
  createdBy: { type: String, default: null },   // username del agente si source='agent'
  doneBy: { type: String, default: null },
  doneAt: { type: Date, default: null },
  note: { type: String, default: '' },
  // Datos libres del flujo (transactionId, movementId, spinId...) para cruzar.
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now, index: true }
}, {
  timestamps: true
});

platformTaskSchema.index({ status: 1, createdAt: -1 });
platformTaskSchema.index({ username: 1, status: 1 });

module.exports = mongoose.models['PlatformTask'] || mongoose.model('PlatformTask', platformTaskSchema);
