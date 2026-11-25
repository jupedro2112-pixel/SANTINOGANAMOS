// #258–#261 (réplica #236–#239 de CARGASGIROXactivo) Regalo con rollover a un jugador que ya tiene un bono activo: por
// defecto se UNIFICA (un bono nuevo por viejo + regalo, con rollover) — nunca como depósito, que 1girox muestra como Carga.
// En frío: se simula la API de 1girox (se prueba giroxService directo, que es lo que entrega platformService con
// PLATFORM_MODE=girox). Al final, chequeos ESTÁTICOS del cableado en server.js / servicios.   node scripts/test-gift-fallback.js
const assert = require('assert');
const path = require('path');
const Module = require('module');
process.env.GIROX_API_URL = 'https://api.prueba.test/v1'; process.env.GIROX_API_KEY = 'k-prueba'; delete process.env.GIROX_GIFT_AS_BONUS;
const calls = [];
const state = { bonusLocked: 0, cfg: { bonus: { enabled: true, standalone_enabled: true, multipliers: [0, 3, 5], fixed_min: 2, fixed_max: 500000 } }, bonusFail: null };
const origLoad = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === 'axios') {
    return async ({ method, url, data }) => {
      const p = url.replace(process.env.GIROX_API_URL, ''); const m = String(method).toLowerCase();
      calls.push({ m, p, data });
      if (m === 'get' && p === '/config') return { status: 200, data: state.cfg };
      if (m === 'get' && /^\/players\/[^/]+$/.test(p)) return { status: 200, data: { player: { username: 'jug', balance: 1000, wagering: { available: 1000, locked: state.bonusLocked, bonus_locked: state.bonusLocked, claimable_total: state.claimable || 0 } } } };
      if (m === 'post' && /\/bonus$/.test(p)) {
        if (state.bonusFail && data.multiplier > 0) { const e = new Error('422'); e.response = { status: 422, data: { error: { code: state.bonusFail, message: 'x' }, code: state.bonusFail } }; throw e; }
        // saldo antes = 1000. Con multiplier > 0, 1girox debita el resto del bono viejo y acredita el nuevo.
        const after = data.multiplier > 0 ? 1000 - (state.noDebit ? 0 : state.bonusLocked) + data.amount : 1000 + data.amount;
        return { status: 200, data: { balance: after, operation: { ledger_id: 77, reference: data.reference, type: 'bonus' } } };
      }
      if (m === 'post' && /\/deposit$/.test(p)) return { status: 200, data: { operation: { ledger_id: 88, reference: data.reference, type: 'deposit' } } };
      return { status: 200, data: {} };
    };
  }
  if (/utils\/logger$/.test(req)) return { warn() {}, info() {}, error() {}, debug() {} };
  return origLoad.call(this, req, parent, ...rest);
};
const girox = require(path.join(__dirname, '..', 'src/services/giroxService'));
let mode = undefined;
girox.setRolloverResolver(async () => 3);          // rollover GLOBAL x3 encendido
girox.setGiftFallbackResolver(async () => mode);
const anomalies = [];
girox.setGiftMergeAnomalyHook((a) => anomalies.push(a));
const posts = () => calls.filter((c) => c.m === 'post').map((c) => c.p.split('/').pop() + (c.data.multiplier != null ? ':x' + c.data.multiplier : ''));
const reset = (o) => { calls.length = 0; anomalies.length = 0; Object.assign(state, { bonusLocked: 0, bonusFail: null, claimable: 0, noDebit: false }, o || {}); };

(async () => {
  let n = 0; const ok = (t) => { n++; console.log('  ✅ ' + t); };

  reset(); mode = undefined;
  let r = await girox.creditUserBalance('jug', 1000, 'vip-rf-1', { giftFlow: 'refund' });
  assert.ok(r.success); assert.deepStrictEqual(posts(), ['bonus:x3']); assert.strictEqual(r.creditedAs, 'bonus'); assert.strictEqual(r.rolloverApplied, 3);
  ok('sin bono activo: sale como bono con el rollover global (igual que antes)');

  // ---- #237 UNIFICAR (default) ----
  reset({ bonusLocked: 5000 }); mode = undefined;
  r = await girox.creditUserBalance('jug', 1000, 'vip-rf-2', { giftFlow: 'refund' });
  assert.ok(r.success); assert.deepStrictEqual(posts(), ['bonus:x3'], 'un solo bono, nunca /deposit');
  let b = calls.filter((c) => c.m === 'post')[0].data;
  assert.strictEqual(b.amount, 6000, 'bono nuevo = resto del viejo (5000) + regalo (1000)'); assert.strictEqual(b.reference, 'vip-rf-2');
  assert.strictEqual(r.creditedAs, 'bonus'); assert.strictEqual(r.rolloverApplied, 3); assert.strictEqual(r.mergedOld, 5000); assert.strictEqual(r.mergedTotal, 6000);
  assert.strictEqual(anomalies.length, 0);
  ok('jugador CON bono activo: se UNIFICA — bono nuevo por viejo + regalo, con rollover, sin depósito');

  reset({ bonusLocked: 5000 }); mode = 'merge';
  r = await girox.creditGift('jug', 500, { rolloverX: 5, reference: 'vip-roulette-1', description: 'Premio ruleta' });
  b = calls.filter((c) => c.m === 'post')[0].data;
  assert.deepStrictEqual(posts(), ['bonus:x3']); assert.strictEqual(b.amount, 5500); assert.ok(/bono anterior/.test(b.description));
  ok('ruleta / fueguito (creditGift) con bono activo: también unifica');

  reset({ bonusLocked: 5000, noDebit: true }); mode = undefined;
  r = await girox.creditUserBalance('jug', 1000, 'vip-rf-2b', { giftFlow: 'refund' });
  assert.ok(r.success); assert.strictEqual(anomalies.length, 1); assert.strictEqual(anomalies[0].gained, 6000); assert.strictEqual(anomalies[0].old, 5000);
  ok('control: si 1girox NO debita el bono viejo (el saldo sube de más) → avisa para apagar la unificación');

  reset({ bonusLocked: 5000, claimable: 300 }); mode = undefined;
  r = await girox.creditUserBalance('jug', 1000, 'vip-rf-2c', { giftFlow: 'refund' });
  assert.deepStrictEqual(posts(), ['deposit:x3']); assert.strictEqual(r.creditedAs, 'deposit');
  assert.ok(/^BONO \(contar como BONO, NO como carga\): /.test(calls.filter((c) => c.m === 'post')[0].data.description), '#238 la descripción avisa que es un bono');
  ok('tiene un bono cumplido sin reclamar: no se unifica → depósito con rollover (queda marcado)');

  reset({ bonusLocked: 499500 }); mode = undefined;
  r = await girox.creditUserBalance('jug', 1000, 'vip-rf-2d', { giftFlow: 'refund' });
  assert.deepStrictEqual(posts(), ['deposit:x3']);
  ok('unificado superaría el máximo de bono de la plataforma: depósito con rollover');

  reset({ bonusLocked: 40 }); mode = undefined;
  r = await girox.creditUserBalance('jug', 1000, 'vip-rf-2e', { giftFlow: 'refund' });
  assert.deepStrictEqual(posts(), ['bonus:x3']); assert.strictEqual(calls.filter((c) => c.m === 'post')[0].data.amount, 1000); assert.strictEqual(r.mergedOld, undefined);
  ok('resto de bono mínimo (hasta $50): bono normal, como siempre');

  reset({ bonusLocked: 5000 }); mode = 'bonus0';
  r = await girox.creditUserBalance('jug', 1000, 'vip-rf-2f', { giftFlow: 'refund' });
  assert.deepStrictEqual(posts(), ['bonus:x0']); assert.strictEqual(r.rolloverApplied, 0);
  ok('opción del panel "bono sin rollover": sale como bono 0');

  reset({ bonusLocked: 5000 }); mode = 'deposit';
  r = await girox.creditUserBalance('jug', 1000, 'vip-rf-3', { giftFlow: 'refund' });
  assert.ok(r.success); assert.deepStrictEqual(posts(), ['deposit:x3']); assert.strictEqual(r.creditedAs, 'deposit'); assert.strictEqual(r.rolloverApplied, 3); assert.ok(r.fallbackReason);
  ok('opción del panel "depósito con rollover": se comporta como antes y avisa que fue depósito');

  reset({ bonusFail: 'bonus_out_of_range' }); mode = 'bonus0';
  r = await girox.creditUserBalance('jug', 1000, 'vip-rf-4', { giftFlow: 'refund' });
  assert.ok(r.success); assert.deepStrictEqual(posts(), ['bonus:x3', 'bonus:x0']); assert.strictEqual(r.creditedAs, 'bonus');
  assert.strictEqual(calls.filter((c) => c.m === 'post')[0].data.reference, calls.filter((c) => c.m === 'post')[1].data.reference, 'misma reference en los dos intentos');
  ok('la plataforma rechaza el bono con rollover: reintenta como bono sin rollover con la MISMA reference');

  reset({ bonusLocked: 5000 }); mode = 'bonus0';
  r = await girox.creditUserBalance('jug', 1, 'vip-rf-5', { giftFlow: 'refund', description: 'Reembolso diario (2026-11-25)' });
  assert.ok(r.success); assert.deepStrictEqual(posts(), ['deposit']); assert.strictEqual(r.creditedAs, 'deposit');
  assert.ok(/contar como BONO.*Reembolso diario.*limitación de la API/.test(calls.filter((c) => c.m === 'post')[0].data.description));
  ok('único caso que sigue yendo a depósito: monto fuera de lo que 1girox acepta como bono (ej. $1) — queda marcado');

  reset(); mode = undefined;
  r = await girox.creditUserBalance('jug', 1000, 'vip-payoutref-bonus-1', { ignoreGlobalRollover: true });
  assert.deepStrictEqual(posts(), ['bonus:x0']);
  ok('devolución / comisión (sin rollover global): no cambia');

  // ---- reintento del mismo regalo (misma reference) ----
  reset({ bonusLocked: 5000 }); mode = undefined;
  await girox.creditUserBalance('jug', 1000, 'vip-rf-6', { giftFlow: 'refund' });
  await girox.creditUserBalance('jug', 1000, 'vip-rf-6', { giftFlow: 'refund' });
  const two = calls.filter((c) => c.m === 'post');
  assert.strictEqual(two.length, 2); assert.strictEqual(two[0].data.reference, two[1].data.reference, 'el reintento usa la MISMA reference (la plataforma deduplica)');
  ok('reintento de un regalo unificado: misma reference en los dos envíos');

  // ---- ESTÁTICOS: cableado en server.js y servicios ----
  const fs = require('fs');
  const rd = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const server = rd('server.js'), vip = rd('src/services/vipLevelService.js'), ref = rd('src/services/referralPayoutService.js');
  const adminJs = rd('public/adminprivado2026/admin.js'), adminHtml = rd('public/adminprivado2026/index.html');
  const st = (t, cond) => { assert.ok(cond, t); ok(t); };
  st('server.js inyecta el modo y el aviso de anomalía (con guarda por si el cliente no los expone)',
    /if \(typeof girox\.setGiftFallbackResolver === 'function'\) girox\.setGiftFallbackResolver\(/.test(server) && /if \(typeof girox\.setGiftMergeAnomalyHook === 'function'\) girox\.setGiftMergeAnomalyHook\(/.test(server));
  st('la anomalía apaga la unificación (fallback → deposit) y avisa', /fallback: 'deposit', mergeOffAt:/.test(server) && /\[gift-merge\]/.test(server));
  st('default del modo = merge', /function _giftFallbackFromCfg\(raw\) \{ return raw && \(raw\.fallback === 'deposit' \|\| raw\.fallback === 'bonus0'\) \? raw\.fallback : 'merge'; \}/.test(server));
  st('POST /api/admin/bonus-rollover guarda fallback (y conserva el anterior si no viene)', /Config\.set\('bonusRolloverGlobal', \{ enabled, x, fallback \}/.test(server) && /_giftFallbackFromCfg\(prevCfg\)/.test(server));
  st('reembolsos diario / semanal / mensual: descripción a la plataforma + _giftMeta', (server.match(/\{ description: _platDesc\(`REEMBOLSO (diario|semanal|mensual) del /g) || []).length === 3 && (server.match(/\.\.\._giftMeta\(depositResult\)/g) || []).length === 4);
  st('references de los regalos sin tocar', /_refundReference\(_refundPeriodKey, userId\), \{ description:/.test(server) && /reference: `vip-roulette-\$\{spin\.id\}`, description: _platDesc\(/.test(server) && /`vip-payoutref-bonus-\$\{payout\.id\}`, \{ ignoreGlobalRollover: true, description:/.test(server));
  st('fueguito, reembolso en vivo, ruleta, lotes, rakeback, bono manual y código de bienvenida mandan el TIPO primero',
    ['REGALO — Fueguito (racha diaria)', 'REEMBOLSO EN VIVO — ', 'REGALO — Premio de la ruleta diaria', 'REGALO — Fichas de regalo del lote', 'REGALO — Rakeback semanal VIP', 'BONO manual — ', 'BONO — Bono sorpresa', 'DEVOLUCIÓN de retiro rechazado'].every((t) => server.includes(t)));
  st('fuera de 1girox la descripción es la de siempre (_platDesc)', /function _platDesc\(detailed, legacy\) \{ return _PLAT_IS_GIROX \? detailed : \(legacy \|\| ''\); \}/.test(server) && /function _giftMeta\(r\) \{\s*if \(!_PLAT_IS_GIROX\) return \{\};/.test(server));
  st('mergedBonus en fueguito, reembolso en vivo y ruleta', (server.match(/mergedOld \? \{ mergedBonus: Number\(/g) || []).length === 3);
  st('resumen de Transacciones: giftsAsDeposit y mergedBonus', /giftsAsDeposit, giftsAsDepositCount,/.test(server) && /mergedBonus, mergedBonusCount,/.test(server) && /'metadata\.mergedBonus': \{ \$gt: 0 \}/.test(server));
  st('nivel VIP y referidos: TIPO primero solo hacia 1girox; la Transaction local no cambia', /BONO — Premio por alcanzar el nivel VIP/.test(vip) && /COMISIÓN de referidos — /.test(ref) && /\{ description: platformDescription, ignoreGlobalRollover: true \}/.test(ref) && /type: 'referral_commission',[\s\S]{0,200}?\n\s+description,/.test(ref));
  st('panel: radios del modo y las dos tarjetas', (adminHtml.match(/name="brFallback"/g) || []).length === 3 && /summary\.giftsAsDeposit > 0/.test(adminJs) && /summary\.mergedBonus > 0/.test(adminJs) && /fallback: \(\(document\.querySelector\('input\[name="brFallback"\]:checked'\)/.test(adminJs));

  console.log('\n✅ Todo OK (' + n + ')');
})().catch((e) => { console.error('❌ ' + (e && e.stack || e)); console.error(JSON.stringify(calls.slice(-6))); process.exit(1); });
