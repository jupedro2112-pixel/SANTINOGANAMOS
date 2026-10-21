/**
 * test-mijoker-adapter.js — test EN FRÍO del cliente de la Operator API (#231, PLATFORM_MODE=mijoker).
 * No necesita node_modules ni Mongo: stubea axios con una API falsa en memoria (usuarios,
 * saldos, historial) y el modelo PlatformOp con un array. Correr: `node scripts/test-mijoker-adapter.js`.
 * Verifica: (1) mismo contrato que giroxService; (2) alta/vinculación y el candado de
 * registro público; (3) carga OK + duplicate por reference sin segunda llamada; (4) timeout
 * CON acreditación → reconciliación por historial → hecha, sin doble carga; (5) timeout SIN
 * acreditación → failed → reintento acredita UNA vez; (6) 400 → failed sin plata; (7) historial
 * caído → unknown_outcome y NUNCA reintento a ciegas; (8) hermanas con el mismo monto no se
 * confunden; (9) retiro/saldo/clave/sesión/ping; (10) carga con bono = dos INCOME.
 */
const Module = require('module');
const path = require('path');
const origLoad = Module._load;

// ---------- API falsa ----------
const api = { users: new Map(), history: [], calls: [], seq: 100, failNext: null, historyDown: false };
function _u(name) { return api.users.get(String(name).toLowerCase()); }
function _item(user, operation, amount) {
  const before = user.balance;
  user.balance = Math.round((before + (operation === 'INCOME' ? amount : -amount)) * 100) / 100;
  const it = { transactionId: 'tx' + (++api.seq), operation, amount: String(amount), balanceBefore: String(before), balanceAfter: String(user.balance),
    createdAt: new Date().toISOString(), fromUsername: 'agente', fromUserRole: 'AGENT', toUsername: user.username, toUserRole: 'PLAYER', userFromId: 1, userToId: user.id, subprovider: null,
    canCreateOnlyPlayersFrom: false, canCreateOnlyPlayersTo: false };
  api.history.push(it);
  return it;
}
function httpErr(status, message) { const e = new Error('HTTP ' + status); e.response = { status, data: { message }, headers: {} }; return e; }
function timeoutErr() { const e = new Error('timeout of 20000ms exceeded'); e.code = 'ECONNABORTED'; return e; }
async function fakeAxios(cfg) {
  const url = cfg.url.replace('https://api.test/api/operator/v1', '');
  const m = String(cfg.method).toLowerCase();
  api.calls.push(m + ' ' + url + (cfg.params ? ' ' + JSON.stringify(cfg.params) : ''));
  if (!/^Bearer tok$/.test(cfg.headers.Authorization)) throw httpErr(403, 'Unauthorized');
  if (m === 'get' && url === '/users') {
    const u = _u(cfg.params.username);
    if (!u) throw httpErr(404, 'user not found');
    return { status: 200, data: { id: u.id, username: u.username, status: u.status, email: null, createdAt: u.createdAt } };
  }
  if (m === 'get' && url === '/users/balance') {
    const u = _u(cfg.params.username);
    if (!u) throw httpErr(404, 'user balance not found');
    return { status: 200, data: { balance: String(u.balance), currency: 'ARS' } };
  }
  if (m === 'post' && url === '/users') {
    const b = cfg.data;
    if (!b.agentName || !b.playerName || !b.password) throw httpErr(400, 'Invalid input');
    if (_u(b.playerName)) throw httpErr(400, 'User already exists');
    const u = { id: ++api.seq, username: b.playerName, status: 'ACTIVE', balance: 0, createdAt: new Date().toISOString() };
    api.users.set(b.playerName.toLowerCase(), u);
    return { status: 201, data: { userId: u.id } };
  }
  if (m === 'post' && url === '/account-transfers') {
    const b = cfg.data;
    api.lastIdem = cfg.headers['idempotency-key'] || null; // #232
    const u = _u(b.targetUserName);
    if (!u) throw httpErr(404, 'account transaction not found');
    if (!(b.amount > 0)) throw httpErr(400, 'Invalid input');
    if (b.operation === 'OUTCOME' && u.balance < b.amount) throw httpErr(400, 'Insufficient balance');
    const f = api.failNext; api.failNext = null;
    if (f && f.kind === 'timeout') { if (f.apply) _item(u, b.operation, b.amount); throw timeoutErr(); }
    if (f && f.kind === '500') { if (f.apply) _item(u, b.operation, b.amount); throw httpErr(500, 'boom'); }
    const it = _item(u, b.operation, b.amount);
    return { status: 200, data: { newBalance: it.balanceAfter } };
  }
  const h = url.match(/^\/users\/(\d+)\/balance-history$/);
  if (m === 'get' && h) {
    if (api.historyDown) throw timeoutErr();
    const id = Number(h[1]);
    const p = cfg.params;
    if (p.operations && !['INCOME', 'OUTCOME'].includes(p.operations)) throw httpErr(400, 'Invalid input');
    const from = new Date(p.dateFrom).getTime(); const to = new Date(p.dateTo).getTime();
    let items = api.history.filter((it) => it.userToId === id && new Date(it.createdAt).getTime() >= from && new Date(it.createdAt).getTime() <= to);
    if (p.operations) items = items.filter((it) => it.operation === p.operations);
    items = items.slice().reverse().slice(p.offset, p.offset + p.limit);
    return { status: 200, data: { items } };
  }
  const rp = url.match(/^\/users\/([^/]+)\/reset-password$/);
  if (m === 'patch' && rp) {
    const u = _u(decodeURIComponent(rp[1]));
    if (!u) throw httpErr(404, 'user not found');
    if (!/^[a-zA-Z0-9\-_ `~!@#$%^&*()+={}[\]\\|;:'"<>,.?/]{3,32}$/.test(cfg.data.password)) throw httpErr(400, 'Invalid input');
    return { status: 200, data: { password: cfg.data.password, success: true } };
  }
  const st = url.match(/^\/users\/([^/]+)\/status$/);
  if (m === 'patch' && st) {
    const u = _u(decodeURIComponent(st[1]));
    if (!u) throw httpErr(404, 'user not found');
    u.status = cfg.data.status;
    return { status: 200, data: { success: true } };
  }
  throw httpErr(404, 'no route ' + m + ' ' + url);
}

// ---------- PlatformOp falso ----------
const store = [];
let opSeq = 0;
function matches(doc, q) {
  return Object.entries(q || {}).every(([k, v]) => {
    const dv = doc[k];
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('$in' in v) return v.$in.includes(dv);
      if ('$ne' in v) return dv !== v.$ne;
      if ('$gte' in v) return dv != null && new Date(dv).getTime() >= new Date(v.$gte).getTime();
    }
    return dv === v;
  });
}
function clone(d) { return d ? Object.assign({}, d) : null; }
const FakeOp = {
  async create(doc) {
    if (store.some((t) => t.reference === doc.reference)) { const e = new Error('dup'); e.code = 11000; throw e; }
    const t = { _id: 'op' + (++opSeq), createdAt: new Date(), updatedAt: new Date(), ...doc }; store.push(t); return { ...t, toObject: () => clone(t) };
  },
  findOne(q) { const hit = store.find((t) => matches(t, q)); return { lean: async () => clone(hit) }; },
  findOneAndUpdate(q, u) { const t = store.find((x) => matches(x, q)); if (t) { Object.assign(t, u.$set || {}); for (const [k, n] of Object.entries(u.$inc || {})) t[k] = (t[k] || 0) + n; t.updatedAt = new Date(); } return { lean: async () => clone(t) }; },
  async updateOne(q, u) { const t = store.find((x) => matches(x, q)); if (t) Object.assign(t, u.$set || {}); return { modifiedCount: t ? 1 : 0 }; },
  find(q) { const r = store.filter((t) => matches(t, q)).map(clone); const c = { select() { return c; }, sort() { return c; }, limit() { return c; }, lean: async () => r }; return c; },
  async countDocuments(q) { return store.filter((t) => matches(t, q)).length; }
};

const stubs = {
  axios: Object.assign(fakeAxios, {}),
  uuid: { v4: () => 'uuid-' + (++opSeq) },
  mongoose: { Schema: class { constructor() {} index() {} static get Types() { return { Mixed: {} }; } }, models: {}, model: () => FakeOp },
  crypto: require('crypto')
};
Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request];
  if (request.endsWith('utils/logger')) return { info() {}, warn() {}, error() {} };
  if (request.endsWith('/models/PlatformOp')) return FakeOp;
  if (request.endsWith('/models/PlatformTask')) return {};
  return origLoad.call(this, request, parent, isMain);
};
const origWarn = console.warn, origErr = console.error; console.warn = () => {}; console.error = () => {};

process.env.MIJOKER_API_URL = 'https://api.test/';
process.env.MIJOKER_API_TOKEN = 'tok';
process.env.MIJOKER_AGENT_NAME = 'agente';
process.env.MIJOKER_IN_FLIGHT_MS = '200';

const girox = require(path.join(__dirname, '..', 'src', 'services', 'giroxService'));
const mj = require(path.join(__dirname, '..', 'src', 'services', 'mijokerService'));

let fails = 0;
const ok = (cond, msg) => { if (cond) console.log('  ✅', msg); else { fails++; console.log('  ❌', msg); } };
const transfers = () => api.calls.filter((c) => c.startsWith('post /account-transfers')).length;
const op = (ref) => store.find((t) => t.reference === ref);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('1) contrato');
  const missing = Object.keys(girox).filter((k) => !(k in mj));
  ok(missing.length === 0, `todas las exports de giroxService existen en mijokerService${missing.length ? ' — faltan: ' + missing.join(', ') : ''}`);
  ok(mj.MANUAL_MODE === false && mj.isEnabled() === true, 'MANUAL_MODE=false, isEnabled()=true con URL+token');
  const events = [];
  mj.setOpListener(async (ev, o) => events.push([ev, o.reference]));

  console.log('2) alta / vinculación');
  const c1 = await mj.createPlatformUser({ username: 'pepe', password: 'clave123' });
  ok(c1.success && c1.player.id > 0 && api.users.has('pepe'), 'createPlatformUser → POST /users con agentName, devuelve id');
  ok((await mj.createPlatformUser({ username: 'pepe', password: 'clave123' })).code === 'username_taken', 'alta repetida → username_taken');
  ok((await mj.createPlatformUser({ username: 'ana', password: 'ñandú1' })).code === 'invalid_password', 'clave con ñ/acentos → invalid_password (patrón de la API)');
  const s1 = await mj.syncUserToPlatform({ username: 'pepe', password: 'x', selfSignup: true });
  ok(!s1.success && s1.code === 'username_taken', 'registro PÚBLICO con username existente → rebota (no vincula cuentas ajenas)');
  const s2 = await mj.syncUserToPlatform({ username: 'pepe', password: 'x' });
  ok(s2.success && s2.alreadyExists === true && s2.player.id === c1.player.id, 'alta por agente con username existente → vincula (alreadyExists)');
  const s3 = await mj.syncUserToPlatform({ username: 'luis', password: 'clave123', selfSignup: true });
  ok(s3.success && s3.alreadyExists === false && api.users.has('luis'), 'registro público con username nuevo → lo crea');
  ok((await mj.validateCredentials('pepe', 'clave123')).valid === false, 'validateCredentials SIEMPRE valid:false');

  console.log('3) carga OK + idempotencia');
  _u('pepe').balance = 1000;
  const d1 = await mj.depositToUser('pepe', 5000, 'Carga manual', 'vip-dep-1', { flow: 'admin_deposit', agentExecuted: true });
  ok(d1.success && !d1.duplicate && d1.pending === false && d1.data.user_balance_after === 6000, 'depositToUser → INCOME, saldo 6000, pending:false');
  ok(api.lastIdem === 'vip-dep-1', '#232 header idempotency-key = reference en la transferencia');
  ok(op('vip-dep-1').status === 'done' && op('vip-dep-1').flow === 'admin_deposit' && op('vip-dep-1').operation === 'INCOME', 'PlatformOp done, flow, INCOME');
  const n1 = transfers();
  const d2 = await mj.depositToUser('pepe', 5000, 'Carga manual', 'vip-dep-1');
  ok(d2.success && d2.duplicate === true && transfers() === n1 && _u('pepe').balance === 6000, 'misma reference → duplicate:true, SIN llamada a la API, saldo intacto');
  ok(events.some((e) => e[0] === 'done' && e[1] === 'vip-dep-1'), "evento 'done'");

  console.log('4) timeout CON acreditación → reconciliación');
  api.failNext = { kind: 'timeout', apply: true };
  const d3 = await mj.depositToUser('pepe', 777, 'hgcash', 'vip-hg-1');
  ok(d3.success && d3.data.reconciled === true && _u('pepe').balance === 6777, 'timeout pero figura en el historial → success, reconciled, saldo 6777 (UNA sola carga)');
  ok(op('vip-hg-1').status === 'done' && op('vip-hg-1').platformTxId && op('vip-hg-1').reconciled === true, 'PlatformOp done con transactionId del historial');
  const n2 = transfers();
  const d3b = await mj.depositToUser('pepe', 777, 'hgcash', 'vip-hg-1');
  ok(d3b.duplicate === true && transfers() === n2, 'reintento tras reconciliar → duplicate, sin llamada');

  console.log('5) timeout SIN acreditación → failed → reintento acredita UNA vez');
  api.failNext = { kind: 'timeout', apply: false };
  const d4 = await mj.depositToUser('pepe', 300, 'ruleta', 'vip-roulette-1');
  ok(!d4.success && d4.retryable === true && op('vip-roulette-1').status === 'failed', 'no figura en el historial → failed, retryable');
  const d4b = await mj.depositToUser('pepe', 300, 'ruleta', 'vip-roulette-1');
  ok(d4b.success && !d4b.duplicate && _u('pepe').balance === 7077 && op('vip-roulette-1').attempts === 2, 'reintento → acredita una vez (saldo 7077), attempts=2');

  console.log('6) rechazo 4xx → failed sin plata');
  const d5 = await mj.depositToUser('nadie', 100, '', 'vip-dep-2');
  ok(!d5.success && d5.code === 'player_not_found' && op('vip-dep-2').status === 'failed', '404 → player_not_found, failed');
  const w1 = await mj.withdrawFromUser('pepe', 99999, 'retiro', 'vip-payout-1');
  ok(!w1.success && w1.code === 'insufficient_funds' && _u('pepe').balance === 7077, 'OUTCOME sin saldo → insufficient_funds, saldo intacto');
  const w2 = await mj.withdrawFromUser('pepe', 77, 'retiro', 'vip-payout-2');
  ok(w2.success && w2.data.user_balance_after === 7000 && op('vip-payout-2').operation === 'OUTCOME', 'OUTCOME ok → saldo 7000');

  console.log('7) historial caído → unknown_outcome, NUNCA reintento a ciegas');
  api.failNext = { kind: '500', apply: true };
  api.historyDown = true;
  const d6 = await mj.depositToUser('pepe', 250, 'fire', 'vip-fire-1');
  ok(!d6.success && d6.code === 'unknown_outcome' && op('vip-fire-1').status === 'unknown', '5xx + historial caído → unknown_outcome, op unknown');
  ok(events.some((e) => e[0] === 'unknown' && e[1] === 'vip-fire-1'), "evento 'unknown' (server.js avisa al agente)");
  const n3 = transfers();
  const d6b = await mj.depositToUser('pepe', 250, 'fire', 'vip-fire-1');
  ok(!d6b.success && d6b.code === 'unknown_outcome' && transfers() === n3, 'reintento con historial caído → sigue unknown_outcome, SIN segunda llamada');
  api.historyDown = false;
  const rc = await mj.reconcileOp('vip-fire-1');
  ok(rc.success && rc.found === true && op('vip-fire-1').status === 'done' && _u('pepe').balance === 7250, 'reconcileOp con historial vivo → hecha (se había acreditado), saldo 7250');
  ok((await mj.depositToUser('pepe', 250, 'fire', 'vip-fire-1')).duplicate === true && transfers() === n3, 'y el reintento → duplicate');

  console.log('8) hermanas con el mismo monto');
  const h1 = await mj.depositToUser('pepe', 500, 'a', 'vip-nbatch-a');
  api.failNext = { kind: 'timeout', apply: false };
  const h2 = await mj.depositToUser('pepe', 500, 'b', 'vip-nbatch-b');
  ok(h1.success && !h2.success && op('vip-nbatch-b').status === 'failed', 'la carga hecha (a) NO se confunde con la que falló (b): b queda failed, no "done"');
  api.failNext = { kind: 'timeout', apply: true };
  const h3 = await mj.depositToUser('pepe', 500, 'c', 'vip-nbatch-c');
  ok(h3.success && h3.data.reconciled && op('vip-nbatch-c').platformTxId !== op('vip-nbatch-a').platformTxId && _u('pepe').balance === 8250, 'c (timeout con acreditación) matchea SU ítem, no el de a');

  console.log('9) pendiente vencida (proceso muerto) → unknown → reconcilia');
  store.push({ _id: 'opX', reference: 'vip-dep-dead', kind: 'deposit', operation: 'INCOME', username: 'pepe', usernameLower: 'pepe', amount: 10, status: 'pending', attempts: 1, startedAt: new Date(Date.now() - 1000), createdAt: new Date(Date.now() - 1000) });
  const dd = await mj.depositToUser('pepe', 10, 'x', 'vip-dep-dead');
  ok(dd.success && !dd.duplicate && op('vip-dep-dead').status === 'done' && op('vip-dep-dead').attempts === 2, 'pending vieja → no figura → se manda → done');
  store.push({ _id: 'opY', reference: 'vip-dep-live', kind: 'deposit', operation: 'INCOME', username: 'pepe', usernameLower: 'pepe', amount: 10, status: 'pending', attempts: 1, startedAt: new Date(), createdAt: new Date() });
  ok((await mj.depositToUser('pepe', 10, 'x', 'vip-dep-live')).code === 'in_progress', 'pending reciente → in_progress (otra instancia la tiene)');

  console.log('10) carga con bono = dos INCOME');
  const db = await mj.depositToUser('pepe', 1000, 'Carga', 'vip-dep-3', { bonusAmount: 200, bonusMultiplier: 3 });
  ok(db.success && op('vip-dep-3').status === 'done' && op('vip-dep-3-bonus').status === 'done' && op('vip-dep-3-bonus').amount === 200 && db.rolloverApplied === 0, 'carga 1000 + bono 200 → vip-dep-3 y vip-dep-3-bonus, rollover 0');
  const g = await mj.creditGift('pepe', 50, { reference: 'vip-wrf-sem-pepe', rolloverX: 3, flow: 'weekly_refund' });
  ok(g.success && g.pending === false && g.creditedAs === 'deposit' && g.rolloverApplied === 0 && g.claimRequired === false && op('vip-wrf-sem-pepe').flow === 'weekly_refund', 'creditGift → INCOME directo, sin pending ni rollover');

  console.log('11) lecturas / clave / sesión / ping');
  const bal = await mj.getUserBalance('pepe', { fresh: true });
  ok(bal.success && bal.balance === _u('pepe').balance && bal.available === bal.balance && bal.locked === 0, 'getUserBalance → balance = available, locked 0');
  const info = await mj.getUserInfoByName('pepe', { fresh: true });
  ok(info && info.id === c1.player.id && info.active === true && info.balance === bal.balance && info.bonusLocked === 0, 'getUserInfoByName → id, active, saldo');
  ok((await mj.getUserInfoByName('nadie')) === null, 'jugador inexistente → null');
  ok((await mj.changeUserPassword('pepe', 'Nueva-Clave_2026')).success === true, 'changeUserPassword → PATCH reset-password');
  ok((await mj.changeUserPassword('pepe', 'ñ')).code === 'invalid_password', 'clave inválida rebota antes de llamar');
  const ses = await mj.createSession('pepe');
  ok(ses.success && ses.openInTab === true && /^https?:\/\//.test(ses.redirectUrl), 'createSession → URL en pestaña (sin SSO)');
  const pg = await mj.ping();
  ok(pg.ok === true && pg.httpStatus === 404, 'ping → 404 esperado = API viva y token válido');
  process.env.MIJOKER_API_TOKEN = 'malo';
  ok((await mj.ping()).estado === 'credenciales_rechazadas', 'ping con token malo → credenciales_rechazadas');
  process.env.MIJOKER_API_TOKEN = 'tok';
  ok((await mj.setUserStatus('pepe', 'BANNED')).success && _u('pepe').status === 'BANNED', 'setUserStatus BANNED');
  ok((await mj.getPlayerStats('pepe')).code === 'not_supported', 'getPlayerStats → not_supported');
  const cfg = await mj.getPlatformConfig();
  ok(cfg.success && cfg.config.bonus.multipliers[0] === 0 && cfg.config.rollover.enabled === false, 'getPlatformConfig: multiplicador 0, sin rollover');
  const mv = await mj.getUserMovements('pepe', { page: 1, pageSize: 10 });
  ok(mv.success && Array.isArray(mv.movements) && mv.movements.length > 0 && mv.movements[0].transactionId, 'getUserMovements → historial mapeado');
  ok((await mj.depositToUser('pepe', 0, '', 'vip-x')).code === 'invalid_amount', 'monto 0 → invalid_amount');
  ok((await mj.countUnknown()) === 0 && (await mj.listOps({ status: 'all' })).length === store.length, 'listOps/countUnknown');

  console.log(fails ? `\n❌ ${fails} chequeo(s) fallaron` : '\n✅ Todos los chequeos del cliente mijoker pasan');
  console.warn = origWarn; console.error = origErr;
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.warn = origWarn; console.error = origErr; console.error('💥', e); process.exit(1); });
