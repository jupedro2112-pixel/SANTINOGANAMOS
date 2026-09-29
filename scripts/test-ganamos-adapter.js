/**
 * test-ganamos-adapter.js — test EN FRÍO del adaptador manual (#190, GANAMOS sin API).
 * No necesita node_modules ni Mongo: stubea mongoose/uuid/axios/logger y el modelo
 * PlatformTask con un array en memoria. Correr: `node scripts/test-ganamos-adapter.js`.
 * Verifica: (1) el adaptador exporta TODO lo que exporta giroxService (mismo contrato);
 * (2) idempotencia por reference (duplicate:true, sin segunda tarea); (3) agentExecuted
 * → nace `done`, sin evento 'created'; (4) server-initiated → `pending` + evento
 * 'created'; (5) settleTask → evento 'done' y es idempotente; (6) login seguro
 * (validateCredentials.valid === false); (7) saldo/netwin → code 'manual_mode';
 * (8) flow deducido del prefijo de la reference.
 */
const Module = require('module');
const path = require('path');
const origLoad = Module._load;
const store = []; // PlatformTask en memoria
let seq = 0;
function docOf(d) { return Object.assign({}, d); }
const FakeTask = {
  async create(doc) {
    if (store.some((t) => t.reference === doc.reference)) { const e = new Error('dup'); e.code = 11000; throw e; }
    const t = { _id: 'task' + (++seq), createdAt: new Date(), ...doc }; store.push(t); return { ...t, toObject: () => docOf(t) };
  },
  async countDocuments(q) { return store.filter((t) => t.status === q.status).length; },
  find() { return { sort() { return this; }, limit() { return this; }, lean: async () => store.map(docOf) }; },
  findOneAndUpdate(q, u) { const t = store.find((x) => x._id === q._id && x.status === q.status); if (t) Object.assign(t, u.$set); return { lean: async () => (t ? docOf(t) : null) }; }
};
// findOne(...).lean() en el adaptador: devolver objeto con .lean
FakeTask.findOne = function (q) { const hit = store.find((t) => t.reference === q.reference); return { lean: async () => (hit ? docOf(hit) : null) }; };
FakeTask.findById = function (id) { const t = store.find((x) => x._id === id); return { lean: async () => (t ? docOf(t) : null) }; };
const stubs = {
  mongoose: { Schema: class { constructor() {} index() {} static get Types() { return { Mixed: {} }; } }, models: {}, model: () => FakeTask },
  uuid: { v4: () => 'uuid-' + (++seq) },
  axios: {},
  crypto: require('crypto')
};
Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request];
  if (request.endsWith('/utils/logger') || request.endsWith('utils/logger')) return { info() {}, warn() {}, error() {} };
  if (request.endsWith('/models/PlatformTask')) return FakeTask;
  return origLoad.call(this, request, parent, isMain);
};
const origWarn = console.warn; console.warn = () => {};

const girox = require(path.join(__dirname, '..', 'src', 'services', 'giroxService'));
const manual = require(path.join(__dirname, '..', 'src', 'services', 'ganamosPlatformService'));

let fails = 0;
const ok = (cond, msg) => { if (cond) console.log('  ✅', msg); else { fails++; console.log('  ❌', msg); } };

(async () => {
  console.log('1) contrato');
  const missing = Object.keys(girox).filter((k) => !(k in manual));
  ok(missing.length === 0, `todas las exports de giroxService existen en el adaptador${missing.length ? ' — faltan: ' + missing.join(', ') : ''}`);
  ok(manual.MANUAL_MODE === true && manual.isEnabled() === true, 'MANUAL_MODE=true, isEnabled()=true');

  const events = [];
  manual.setTaskListener(async (ev, t) => events.push([ev, t.reference]));
  manual.setUserIdResolver(async (u) => (u === 'pepe' ? 'uid-pepe' : null));

  console.log('2) idempotencia por reference');
  const a = await manual.depositToUser('pepe', 10000, 'Carga automática (hgcash)', 'vip-hg-abc');
  const b = await manual.depositToUser('pepe', 10000, 'Carga automática (hgcash)', 'vip-hg-abc');
  ok(a.success && a.pending === true && a.duplicate === false, 'primera carga hgcash → success, pending, no duplicate');
  ok(b.success && b.duplicate === true && b.taskId === a.taskId, 'reintento misma reference → duplicate:true, misma tarea');
  ok(store.length === 1, 'una sola PlatformTask en la base');
  ok(a.data.transfer_id === a.taskId && store[0].userId === 'uid-pepe' && store[0].flow === 'hgcash', 'transfer_id = taskId, userId resuelto, flow deducido (hgcash)');
  ok(events.length === 1 && events[0][0] === 'created', "evento 'created' una sola vez");

  console.log('3) agente ejecutó → done sin evento');
  const c = await manual.depositToUser('pepe', 5000, 'Carga manual', 'vip-dep-1', { bonusAmount: 1000, bonusMultiplier: 3, agentExecuted: true, agentName: 'ana', flow: 'admin_deposit' });
  ok(c.success && c.pending === false, 'carga manual → success, pending:false');
  const tc = store.find((t) => t.reference === 'vip-dep-1');
  ok(tc.status === 'done' && tc.source === 'agent' && tc.doneBy === 'ana' && tc.bonus.amount === 1000 && tc.bonus.multiplier === 3, 'tarea done, source agent, bono 1000 x3');
  ok(events.length === 1, "sin evento 'created' para tareas del agente");
  const w = await manual.withdrawFromUser('pepe', 7000, 'Retiro confirmado', 'vip-payout-9', { agentExecuted: true, agentName: 'luis' });
  ok(w.success && store.find((t) => t.reference === 'vip-payout-9').kind === 'withdraw' && store.find((t) => t.reference === 'vip-payout-9').status === 'done', 'retiro del agente → kind withdraw, done');

  console.log('4) regalos del server → pending');
  const g = await manual.creditGift('pepe', 2000, { reference: 'vip-roulette-77', description: 'Ruleta diaria', rolloverX: 3 });
  ok(g.success && g.pending && g.creditedAs === 'bonus' && g.rolloverApplied === 3 && g.claimRequired === false, 'ruleta → pending, creditedAs bonus, rollover 3');
  ok(store.find((t) => t.reference === 'vip-roulette-77').flow === 'roulette', 'flow deducido: roulette');
  manual.setRolloverResolver(async () => 5);
  const g2 = await manual.creditUserBalance('pepe', 300, 'vip-lvl-1-2', { description: 'Nivel VIP' });
  ok(g2.rolloverApplied === 5 && store.find((t) => t.reference === 'vip-lvl-1-2').rolloverX === 5, 'rollover global (5) pisa el del flujo');
  const g3 = await manual.creditUserBalance('pepe', 300, 'vip-refcom-1', { description: 'Comisión', ignoreGlobalRollover: true });
  ok(g3.rolloverApplied === 0, 'ignoreGlobalRollover → x0 (referidos)');
  ok(await manual.countPending() === 4, 'countPending = 4 (hgcash + ruleta + VIP + referidos)');

  console.log('5) settle');
  const s1 = await manual.settleTask(a.taskId, { status: 'done', by: 'ana', note: '' });
  ok(s1.success && s1.task.status === 'done' && s1.task.doneBy === 'ana', 'settle → done por ana');
  ok(events.some((e) => e[0] === 'done' && e[1] === 'vip-hg-abc'), "evento 'done' emitido");
  const s2 = await manual.settleTask(a.taskId, { status: 'rejected', by: 'luis', note: 'x' });
  ok(s2.success && s2.alreadySettled && s2.task.status === 'done', 'segundo settle → alreadySettled, sigue done');
  const s3 = await manual.settleTask('nope', { status: 'done', by: 'ana' });
  ok(!s3.success && s3.code === 'not_found', 'tarea inexistente → not_found');
  const s4 = await manual.settleTask(g.taskId, { status: 'bad', by: 'ana' });
  ok(!s4.success && s4.code === 'invalid_status', 'estado inválido rechazado');

  console.log('6) seguridad / lecturas');
  const v = await manual.validateCredentials('pepe', 'loquesea');
  ok(v.success && v.valid === false, 'validateCredentials SIEMPRE valid:false (el login no crea cuentas)');
  const bal = await manual.getUserBalance('pepe');
  ok(!bal.success && bal.code === 'manual_mode', 'getUserBalance → manual_mode');
  const st = await manual.getPlayerStats('pepe', new Date(), new Date());
  ok(!st.success && st.code === 'manual_mode', 'getPlayerStats → manual_mode');
  const info = await manual.getUserInfoByName('pepe');
  ok(info && info.manual === true && info.balance === null && info.bonusLocked === 0 && info.claimableTotal === 0, 'getUserInfoByName → jugador "vacío" con manual:true');
  const sync = await manual.syncUserToPlatform({ username: 'pepe', password: 'x' });
  ok(sync.success && sync.alreadyExists === true, 'syncUserToPlatform → linked');
  ok(!(await manual.syncUserToPlatform({ username: 'a b', password: 'x' })).success, 'username inválido rebota');
  const ses = await manual.createSession('pepe');
  ok(ses.success && /^https?:\/\//.test(ses.redirectUrl), 'createSession → URL de GANAMOS');
  const cfg = await manual.getPlatformConfig();
  ok(cfg.success && cfg.config.bonus.multipliers.includes(3), 'getPlatformConfig permite x3');
  ok((await manual.depositToUser('pepe', 0, '', 'vip-x')).code === 'invalid_amount', 'monto 0 → invalid_amount');

  console.log(fails ? `\n❌ ${fails} chequeo(s) fallaron` : '\n✅ Todos los chequeos del adaptador manual pasan');
  console.warn = origWarn;
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('💥', e); process.exit(1); });
