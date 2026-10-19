/**
 * RefundBatch — una CARGA SEMANAL de reembolsos (#215, GANAMOS sin API).
 *
 * El admin general sube la planilla de movimientos de la semana (Type | User | Amount)
 * y el sistema calcula el reembolso de cada cliente (src/utils/weeklyRefund.js). Cada
 * cliente con rango queda en un `WeeklyRefund` de este lote, "por reclamar" hasta
 * `expiresAt` (horas del comando /sys_refund_claim_hours, congeladas al subir).
 *
 * `activeKey` (único) = el `periodKey` mientras el lote está activo → no se puede subir
 * dos veces la misma semana (multi-instancia: el índice es el candado). Al anular el
 * lote pasa a `cancelled:<id>` y la semana se puede volver a subir.
 */
const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  id:        { type: String, required: true, unique: true, index: true },
  periodKey: { type: String, required: true, index: true }, // YYYY-MM-DD del primer día de la semana
  activeKey: { type: String, required: true, unique: true },
  fromDate:  { type: String, required: true },              // YYYY-MM-DD
  toDate:    { type: String, required: true },
  label:     { type: String, required: true },              // "23/11 al 29/11"
  status:    { type: String, enum: ['active', 'cancelled'], default: 'active', index: true },
  claimHours: { type: Number, required: true },
  expiresAt: { type: Date, required: true },         // vence la ÚLTIMA tanda (#230)
  // #230 Programar + tandas: el aviso (y el plazo de cada cliente) arranca en `availableAt`
  // de su tanda, no al publicar. `publishAt` = cuándo sale la primera (null = al publicar),
  // `parts` = cantidad de tandas, `partGapMinutes` = separación, `partsPlan` = el plan.
  publishAt: { type: Date, default: null },
  parts:     { type: Number, default: 1 },
  partGapMinutes: { type: Number, default: 0 },
  partsPlan: { type: [{ _id: false, index: Number, count: Number, total: Number, availableAt: Date, expiresAt: Date, releasedBy: String }], default: [] },
  tiers:     { type: [{ _id: false, name: String, min: Number, pct: Number }], default: [] },
  totals: {
    filas: { type: Number, default: 0 },
    usuarios: { type: Number, default: 0 },
    conBeneficio: { type: Number, default: 0 },
    sinBeneficio: { type: Number, default: 0 },
    sinCuenta: { type: Number, default: 0 },
    yaReclamados: { type: Number, default: 0 }, // tenían un reclamo de una carga anterior de la misma semana
    totalDepositos: { type: Number, default: 0 },
    totalRetiros: { type: Number, default: 0 },
    totalNeto: { type: Number, default: 0 },
    totalBeneficio: { type: Number, default: 0 }
  },
  notify:     { type: Boolean, default: true },   // avisar a cada cliente por chat + push
  notifyDone: { type: Boolean, default: false, index: true },
  createdBy:  { type: String, default: null },
  createdAt:  { type: Date, default: Date.now, index: true },
  cancelledBy: { type: String, default: null },
  cancelledAt: { type: Date, default: null }
}, { timestamps: false });

module.exports = mongoose.models['RefundBatch'] || mongoose.model('RefundBatch', schema);
