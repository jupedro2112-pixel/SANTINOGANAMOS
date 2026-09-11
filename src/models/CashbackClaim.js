/**
 * CashbackClaim — reembolso ACUMULATIVO de por vida ("reembolso en vivo"),
 * según docs/ESPEC-REEMBOLSO-1GIROX.md (2026-09-11).
 *
 * Cada reclamo paga lo reclamable en ese momento: pct% de la pérdida REAL
 * acumulada (netwin de casino de por vida − todo lo regalado) menos lo ya
 * cobrado. Se acredita en 1girox como BONO con rollover (§4.4).
 *
 * IDEMPOTENCIA: reference = vip-cbk-<userId>-<dateKey>-<seq>. `seq` sale del
 * índice único (userId, dateKey, seq): si la acreditación falla y se borra el
 * doc, el reintento reusa el MISMO seq → misma reference → la plataforma
 * deduplica y jamás se paga dos veces (mismo patrón que los reembolsos por
 * período, ver ARCHITECTURE §4.4).
 *
 * Los reclamos `pending` también cuentan como cobrado (§4.2): cierran la
 * carrera de dos reclamos simultáneos.
 */
const mongoose = require('mongoose');

const cashbackClaimSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  username: { type: String, required: true, trim: true, index: true },
  dateKey: { type: String, required: true, index: true }, // YYYY-MM-DD ART
  seq: { type: Number, required: true },
  amount: { type: Number, required: true, min: 0 },       // ARS acreditados
  pct: { type: Number, default: 0 },                      // % vigente al reclamar
  rolloverX: { type: Number, default: 0 },
  lossAtClaim: { type: Number, default: 0 },              // pérdida real acumulada al reclamar
  status: { type: String, enum: ['pending', 'credited'], default: 'pending', index: true },
  transactionId: { type: String, default: null },
  creditedAs: { type: String, default: null },            // 'bonus' | 'deposit' (fallback)
  createdAt: { type: Date, default: Date.now, index: true }
});

cashbackClaimSchema.index({ userId: 1, dateKey: 1, seq: 1 }, { name: 'unique_user_day_seq', unique: true });
cashbackClaimSchema.index({ userId: 1, createdAt: 1 });

module.exports = mongoose.models['CashbackClaim'] ||
  mongoose.model('CashbackClaim', cashbackClaimSchema);
