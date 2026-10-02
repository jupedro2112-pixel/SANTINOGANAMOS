/**
 * WeeklyRefund — el reembolso semanal de UN cliente en un lote (RefundBatch, #215).
 *
 * Ciclo: `claim_pending` (por reclamar, hasta expiresAt) → el cliente toca RECLAMAR →
 * `claimed` (PlatformTask pendiente con reference `vip-wrf-<periodKey>-<usuario>`: el
 * agente lo carga a mano en GANAMOS) → el agente marca "entregado" → `delivered`.
 * Sin reclamar a tiempo → `expired` (barrido perezoso). Tarea rechazada → `rejected`.
 * Lote anulado → `cancelled` (sólo los que seguían por reclamar).
 *
 * Se identifica al cliente por `usernameLower` (el usuario de la planilla = el mismo
 * que en GANAMOS = el de la web). Si la cuenta de la web todavía no existe, el
 * reembolso le aparece igual cuando el agente se la crea con ese usuario.
 *
 * El índice único (batchId, usernameLower) impide dos reembolsos del mismo cliente en
 * un lote; la `reference` (estable por semana + usuario) impide pagarlo dos veces
 * aunque la semana se anule y se vuelva a subir.
 */
const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  id:            { type: String, required: true, unique: true, index: true },
  batchId:       { type: String, required: true, index: true },
  periodKey:     { type: String, required: true, index: true },
  label:         { type: String, required: true },
  username:      { type: String, required: true },
  usernameLower: { type: String, required: true, index: true },
  userId:        { type: String, default: null },
  team:          { type: String, default: null },
  depositos:     { type: Number, default: 0 },
  retiros:       { type: Number, default: 0 },
  neto:          { type: Number, default: 0 },
  count:         { type: Number, default: 0 }, // cantidad de cargas
  tierName:      { type: String, default: null },
  pct:           { type: Number, default: 0 },
  falta:         { type: Number, default: 0 }, // cuánto le faltó para el rango siguiente
  nextTierName:  { type: String, default: null },
  amount:        { type: Number, required: true },
  status:        { type: String, enum: ['claim_pending', 'claimed', 'delivered', 'expired', 'rejected', 'cancelled'], default: 'claim_pending', index: true },
  expiresAt:     { type: Date, required: true },
  claimedAt:     { type: Date, default: null },
  deliveredAt:   { type: Date, default: null },
  deliveredBy:   { type: String, default: null },
  rejectedNote:  { type: String, default: null },
  reference:     { type: String, default: null, index: true },
  platformTaskId: { type: String, default: null },
  // Aviso al cliente (chat + push): null = falta, sending = en curso, sent | no_account | error
  notifyState:   { type: String, default: null },
  notifyAt:      { type: Date, default: null },
  createdAt:     { type: Date, default: Date.now }
}, { timestamps: false });

schema.index({ batchId: 1, usernameLower: 1 }, { unique: true, name: 'unique_batch_user' });
schema.index({ usernameLower: 1, status: 1 });
schema.index({ status: 1, expiresAt: 1 });
schema.index({ batchId: 1, status: 1 });
schema.index({ batchId: 1, notifyState: 1 });

module.exports = mongoose.models['WeeklyRefund'] || mongoose.model('WeeklyRefund', schema);
