/**
 * Spin de la Ruleta Diaria.
 *
 * Cada user puede girar UNA sola vez por día (dateKey YYYY-MM-DD en hora
 * Argentina). El índice unique sobre (userId, dateKey) bloquea race
 * conditions y reinstalls. Resultado server-side, auditable.
 *
 * Acreditación AUTOMÁTICA: ni bien gana, se debita de JUGAYGANA al saldo
 * del user. Si falla, queda status='credit_failed' para retry manual.
 *
 * Si prizeARS === 0 (sin premio), igual queda registrado para que el
 * gate del próximo día respete el "1 spin por día".
 */
const mongoose = require('mongoose');

const spinSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },

  userId:   { type: String, required: true, index: true },
  username: { type: String, required: true, index: true, trim: true },

  // YYYY-MM-DD en hora Argentina (ART, UTC-3). Computado server-side.
  dateKey: { type: String, required: true, index: true },

  spunAt: { type: Date, default: Date.now, immutable: true, index: true },

  // Premio ganado: monto ARS. 0 = sin premio.
  prizeARS: { type: Number, required: true, default: 0, min: 0 },
  prizeLabel: { type: String, default: '' }, // ej. "$10.000", "SIN PREMIO"
  // #188 premios editables desde el panel: 'cash' (fichas, con rollover propio si
  // el global está apagado) | 'percent' (bonificación % en la PRÓXIMA carga, la
  // aplica el agente) | 'none'. Los giros viejos no tienen el campo (= cash/none por prizeARS).
  prizeType: { type: String, enum: ['cash', 'percent', 'none', null], default: null },
  prizePct: { type: Number, default: 0 },
  rolloverX: { type: Number, default: null },

  // Anti-fraude
  ipAddress: { type: String, default: null },
  userAgent: { type: String, default: null },

  // === ACREDITACIÓN AUTOMÁTICA (jugaygana) ===
  // status 'won' inmediato cuando gana, antes de intentar credit. Después
  // pasa a 'credited' si jugaygana confirma o 'credit_failed' si falla.
  // Si prizeARS=0, status='no_prize'.
  status: {
    type: String,
    // #197 FLUJO CON RECLAMO (2026-09-29): todo premio nace `claim_pending` y el
    // cliente tiene `claimExpiresAt` (N horas, comando /sys_roulette_claim_hours)
    // para tocar RECLAMAR en la app; si no, pasa a `expired`.
    //   dinero:  claim_pending → claimed (tarea en "Pendientes GANAMOS" / acreditado
    //            por API) → credited (el agente la marcó ✅) | credit_failed.
    //   %:       claim_pending → percent_pending (queda en el usuario para su
    //            próxima carga) → percent_used (aplicado por el agente).
    // `won` es el estado legacy (premio acreditado sin reclamo).
    enum: ['no_prize', 'won', 'credited', 'credit_failed', 'percent_pending', 'percent_used', 'claim_pending', 'claimed', 'expired'],
    default: 'won',
    index: true
  },
  // #197 reclamo con vencimiento
  claimExpiresAt: { type: Date, default: null, index: true },
  claimedAt: { type: Date, default: null },
  platformTaskId: { type: String, default: null }, // PlatformTask (modo manual) creada al reclamar dinero
  agentDoneAt: { type: Date, default: null },
  agentDoneBy: { type: String, default: null },
  creditTxId: { type: String, default: null, index: true },
  creditError: { type: String, default: null },
  creditedAt: { type: Date, default: null },
  creditAttempts: { type: Number, default: 0 }
}, { timestamps: true });

// Garantiza 1 spin/día por user — incluso con race / reinstall.
spinSchema.index(
  { userId: 1, dateKey: 1 },
  { name: 'unique_userid_datekey', unique: true }
);
spinSchema.index(
  { username: 1, dateKey: 1 },
  { name: 'unique_username_datekey', unique: true }
);

module.exports = mongoose.models['DailyRouletteSpin'] ||
  mongoose.model('DailyRouletteSpin', spinSchema);
