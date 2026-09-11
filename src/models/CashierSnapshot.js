/**
 * Modelo CashierSnapshot — saldo del CAJERO (cuenta agente de 1girox) visto en
 * cada operación (#155 del gemelo; acá #183).
 *
 * ⚠️ 1girox: la Partner API (manual v1.15) devuelve en /deposit, /withdraw y
 * /bonus SOLO el saldo del JUGADOR — no el del agente — y no tiene endpoint de
 * saldo del agente. `giroxService.setCashierBalanceHook` está cableado para
 * reportar `agent_balance` si la API lo agrega algún día; mientras tanto esta
 * colección queda VACÍA y el cierre diario informa el cruce 2 como `sin_datos`.
 * Lo guardaríamos en cada operación exitosa junto con el movimiento que la produjo
 * (`opAmount`, con signo desde el punto de vista del cajero: una carga al cliente
 * es negativa, un retiro es positiva). Con eso el cierre diario compara:
 *   saldo al fin del día − saldo al inicio  vs  Σ opAmount del día
 * Si no coincide, alguien movió plata en 1girox por fuera del sistema (carga
 * directa en su panel, etc.).
 * TTL 120 días (índice en `at`).
 */
const mongoose = require('mongoose');

const cashierSnapshotSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now, index: true },
  balance: { type: Number, required: true },      // saldo del cajero DESPUÉS de la operación (ARS)
  opAmount: { type: Number, default: 0 },         // efecto de la operación sobre el cajero (ARS, con signo)
  opKind: { type: String, default: null },        // deposit | withdraw | bonus
  username: { type: String, default: null },
  verified: { type: Boolean, default: false }     // true si el éxito se confirmó por saldo (sin respuesta JSON) → opAmount estimado
}, {
  timestamps: false
});

cashierSnapshotSchema.index({ at: 1 }, { expireAfterSeconds: 120 * 24 * 3600 });

module.exports = mongoose.models['CashierSnapshot'] || mongoose.model('CashierSnapshot', cashierSnapshotSchema);
