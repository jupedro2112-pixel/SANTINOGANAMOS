/**
 * RecordatorioFire — registro de cada push de RECORDATORIO (sin regalos) enviada por
 * el motor `recordatoriosService` (#209): reactivación de inactivos, "tu giro ya está
 * disponible" y "tu premio vence pronto". El `fireKey` único es la idempotencia
 * multi-instancia (cada aviso sale UNA sola vez).
 */
const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  fireKey:  { type: String, required: true, unique: true, index: true },
  username: { type: String, required: true, index: true, lowercase: true, trim: true },
  kind:     { type: String, enum: ['inactivo', 'giro', 'premio'], required: true, index: true },
  step:     { type: String, default: null },
  firedAt:  { type: Date, default: Date.now, index: true }
}, { timestamps: false });

module.exports = mongoose.models['RecordatorioFire'] || mongoose.model('RecordatorioFire', schema);
