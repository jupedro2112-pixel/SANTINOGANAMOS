/**
 * OutboundWebhookQueue (#334) — cola persistente de avisos salientes (registro /
 * primera carga / carga / retiro) que NO pudieron entregarse a un destino tras los
 * reintentos inmediatos. El worker de outboundWebhookService los reintenta cada
 * 5 min hasta MAX_TOTAL_ATTEMPTS y después los descarta.
 */
const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  destId: { type: String, required: true, index: true },   // id del destino (Config['outboundWebhooks'])
  event: { type: String, required: true },
  eventId: { type: String, required: true },
  payload: { type: Object, required: true },               // body exacto que se firma y se manda
  attempts: { type: Number, default: 0 },
  lastError: { type: String, default: null },
  nextRetryAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now }
});

schema.index({ nextRetryAt: 1 });

module.exports = mongoose.models['OutboundWebhookQueue']
  || mongoose.model('OutboundWebhookQueue', schema);
