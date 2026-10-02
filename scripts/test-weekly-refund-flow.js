#!/usr/bin/env node
// (SIN 'use strict' a propósito: el `eval` del bloque tiene que declarar sus funciones en
// este scope para que los dobles de abajo —girox.settleTask— puedan llamarlas.)
/**
 * Test en frío del FLUJO del reembolso semanal por planilla (#215). No hay node_modules
 * local, así que no se puede levantar el server: este arnés extrae el bloque REAL
 * "#215 REEMBOLSO SEMANAL POR ARCHIVO" de server.js, lo ejecuta contra una base falsa en
 * memoria (modelos, girox, mensajes) y recorre todo: vista previa → publicar → avisos →
 * reclamar (doble toque) → marcar como entregado → vencimiento → anular y resubir → rangos.
 *   node scripts/test-weekly-refund-flow.js
 * Correrlo tras tocar ese bloque de server.js. (El cálculo puro: test-weekly-refund.js.)
 * Si falla por "no encuentro el bloque", se movieron/renombraron los comentarios-marca.
 */
const fs = require('fs');
const path = require('path');
const repo = process.argv[2] || path.join(__dirname, '..');
const src = fs.readFileSync(path.join(repo, 'server.js'), 'utf8');
const a = src.indexOf('// #215 REEMBOLSO SEMANAL POR ARCHIVO (GANAMOS sin API, owner');
const b = src.indexOf('// COMUNIDAD — config del link de la comunidad');
if (a < 0 || b < 0) throw new Error('no encuentro el bloque');
const block = src.slice(src.lastIndexOf('// ====', a), src.lastIndexOf('// ====', b));

let fail = 0;
const ok = (c, m) => { if (!c) fail++; console.log((c ? '✅' : '❌') + ' ' + m); };

// ---------- base falsa ----------
function match(doc, q) {
  for (const k of Object.keys(q || {})) {
    const v = q[k];
    if (k === '$or') { if (!v.some((s) => match(doc, s))) return false; continue; }
    const dv = doc[k];
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('$in' in v && !v.$in.includes(dv)) return false;
      if ('$ne' in v && dv === v.$ne) return false;
      if ('$lt' in v && !(dv != null && dv < v.$lt)) return false;
      if ('$regex' in v && !new RegExp(v.$regex).test(String(dv))) return false;
    } else if (v === null) { if (dv != null) return false; } else if (dv !== v) return false;
  }
  return true;
}
class Q {
  constructor(fn) { this.fn = fn; this._sort = null; this._limit = null; }
  sort(s) { this._sort = s; return this; }
  limit(n) { this._limit = n; return this; }
  select() { return this; }
  lean() { return this; }
  exec() {
    let r = this.fn();
    if (Array.isArray(r)) {
      if (this._sort) { const [k, d] = Object.entries(this._sort)[0]; r = r.slice().sort((x, y) => (x[k] > y[k] ? 1 : x[k] < y[k] ? -1 : 0) * d); }
      if (this._limit) r = r.slice(0, this._limit);
      r = r.map((x) => ({ ...x }));
    } else if (r && typeof r === 'object') r = { ...r };
    return r;
  }
  then(res, rej) { try { return Promise.resolve(this.exec()).then(res, rej); } catch (e) { return Promise.reject(e).then(res, rej); } }
  catch(rej) { return this.then((x) => x, rej); }
}
function model(uniqueKey) {
  const rows = [];
  const dupCheck = (d) => { if (uniqueKey && rows.some((r) => uniqueKey(r) === uniqueKey(d))) { const e = new Error('E11000 duplicate key'); e.code = 11000; throw e; } };
  const apply = (r, u) => { if (u.$set) Object.assign(r, u.$set); else Object.assign(r, u); };
  return {
    rows,
    find: (q, _p) => new Q(() => rows.filter((r) => match(r, q))),
    findOne: (q) => { const qq = new Q(() => rows.filter((r) => match(r, q))); const ex = qq.exec.bind(qq); qq.exec = () => ex()[0] || null; return qq; },
    findById: (id) => new Q(() => rows.find((r) => String(r._id) === String(id)) || null),
    countDocuments: async (q) => rows.filter((r) => match(r, q)).length,
    create: async (d) => { dupCheck(d); rows.push({ _id: 't' + (rows.length + 1), ...d }); return rows[rows.length - 1]; },
    insertMany: async (ds) => { for (const d of ds) { dupCheck(d); rows.push({ ...d }); } },
    updateOne: (q, u) => new Q(() => { const r = rows.find((x) => match(x, q)); if (r) apply(r, u); return { modifiedCount: r ? 1 : 0 }; }),
    updateMany: async (q, u) => { const rs = rows.filter((x) => match(x, q)); rs.forEach((r) => apply(r, u)); return { modifiedCount: rs.length }; },
    findOneAndUpdate: (q, u, o) => new Q(() => { let r = rows.find((x) => match(x, q)); if (!r && o && o.upsert) { r = { ...q }; rows.push(r); } if (r) apply(r, u); return r || null; }),
    deleteMany: (q) => new Q(() => { for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i], q)) rows.splice(i, 1); return {}; }),
    deleteOne: (q) => new Q(() => { const i = rows.findIndex((x) => match(x, q)); if (i >= 0) rows.splice(i, 1); return {}; }),
    aggregate: async (pipe) => {
      const m = rows.filter((r) => match(r, pipe[0].$match));
      const g = {};
      for (const r of m) { const k = r.batchId + '|' + r.status; g[k] = g[k] || { _id: { b: r.batchId, s: r.status }, n: 0, total: 0 }; g[k].n++; g[k].total += r.amount; }
      return Object.values(g);
    }
  };
}

const WeeklyRefund = model((d) => d.batchId + '|' + d.usernameLower);
const RefundBatch = model((d) => d.activeKey);
const Transaction = model();
const PlatformTask = model((d) => d.reference);
const User = model();
User.rows.push({ id: 'u1', username: 'BigOscar072', usernameLower: 'bigoscar072', role: 'user' }, { id: 'u2', username: 'zyromaria510', usernameLower: 'zyromaria510', role: 'user' });
const ChatStatus = model();
const commands = {};
const Command = { findOne: (q) => new Q(() => (commands[q.name] ? { name: q.name, response: commands[q.name] } : null)) };
const cfg = {};
const getConfig = async (k, d = null) => (k in cfg ? cfg[k] : d);
const setConfig = async (k, v) => { cfg[k] = v; };
const sent = []; const notes = []; const pushes = []; const adminEvents = [];
const renderSystemCommand = async (name, fallback, vars = {}) => { let o = fallback; for (const [k, v] of Object.entries(vars)) o = o.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v)); return o; };
const _sendSystemMessageToUser = async (userId, username, content) => { sent.push({ userId, username, content }); };
const _emitAdminOnlyChatNote = async (userId, username, content) => { notes.push({ userId, content }); };
const sendPushIfOffline = async (user, title, body) => { pushes.push({ u: user.username, title, body }); return {}; };
const notifyAdmins = (ev, data) => adminEvents.push({ ev, ...data });
const io = { to: () => ({ emit: () => {} }) };
const logger = { info: () => {}, warn: (m) => console.log('   warn:', m), error: (m) => { console.log('   ERROR:', m); fail++; } };
let uid = 0; const uuidv4 = () => 'id' + (++uid);
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const _canSettlePlatformTask = (role, kind) => role === 'admin' || (kind === 'withdraw' ? role === 'withdrawer' : role === 'depositor' || role === 'comunidad');
const getTeamsConfig = async () => ({ general: {}, list: [{ prefix: 'big', name: 'BIG' }, { prefix: 'zyro', name: 'ZYRO' }] });
const resolveTeamForUsername = (u, c) => c.list.find((t) => String(u).startsWith(t.prefix)) || null;
const findUserByUsernameCI = async (u) => User.rows.find((x) => x.usernameLower === String(u).toLowerCase()) || null;
const PLATFORM_MANUAL = true;
const weeklyRefundCalc = require(path.join(repo, 'src/utils/weeklyRefund'));
const routes = {};
const reg = (m) => (p, ...h) => { routes[m + ' ' + p] = h[h.length - 1]; };
const app = { get: reg('GET'), post: reg('POST') };
const authMiddleware = null, adminMiddleware = null;
const girox = {
  PlatformTask,
  creditGift: async (username, amount, o) => {
    const ex = PlatformTask.rows.find((t) => t.reference === o.reference);
    if (ex) return { success: true, duplicate: true, pending: ex.status === 'pending', manual: true, data: { transfer_id: ex._id } };
    const t = await PlatformTask.create({ kind: 'gift', status: 'pending', reference: o.reference, username, amount, flow: o.flow, description: o.description, userId: 'u?' });
    return { success: true, duplicate: false, pending: true, manual: true, data: { transfer_id: t._id } };
  },
  settleTask: async (id, { status, by, note }) => {
    const t = PlatformTask.rows.find((x) => x._id === id);
    if (!t) return { success: false, error: 'Tarea inexistente' };
    if (t.status !== 'pending') return { success: true, task: { ...t }, alreadySettled: true };
    Object.assign(t, { status, doneBy: by, note });
    await _wrfOnTaskSettled(status === 'done' ? 'done' : 'rejected', { ...t }); // lo que hace el listener real
    return { success: true, task: { ...t } };
  }
};
const _si = global.setInterval; const setInterval = () => 0; const setImmediate = (fn) => fn(); // sin crons
eval(block);

function call(key, { user, body, query, params } = {}) {
  return new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(j) { resolve({ code: this.code, body: j }); } };
    routes[key]({ user: user || {}, body: body || {}, query: query || {}, params: params || {} }, res);
  });
}
const admin = { role: 'admin', username: 'ignite1000' };
const cargas = { role: 'depositor', username: 'cajero1' };
const pagos = { role: 'withdrawer', username: 'pagos1' };
const sheet = ['Type\tUser\tAmount\tfecha', 'deposit\tbigoscar072\t80000\t23/11', 'withdraw\tbigoscar072\t10000\t24/11', 'deposit\tzyromaria510\t350000\t23/11',
  'withdrawal\tzyromaria510\t20000\t25/11', 'deposit\tluxcaro990\t15000\t23/11', 'deposit\tcirnuevo1\t120000\t23/11'].join('\n');

(async () => {
  let r = await call('POST /api/admin/weekly-refund/preview', { user: cargas, body: { text: sheet } });
  ok(r.code === 403, 'preview: un cajero no puede (403)');
  r = await call('POST /api/admin/weekly-refund/preview', { user: admin, body: { text: sheet } });
  ok(r.code === 200 && r.body.totals.conBeneficio === 3 && r.body.totals.sinBeneficio === 1 && r.body.totals.sinCuenta === 1 && r.body.totals.totalBeneficio === 2100 + 33000 + 6000, 'preview: 3 con reembolso, 1 sin, 1 sin cuenta, total $41.100');
  ok(r.body.teams.find((t) => t.team === 'BIG').regalado === 2100 && r.body.teams.some((t) => t.team === 'SIN EQUIPO'), 'preview: resumen por equipo');
  ok(WeeklyRefund.rows.length === 0, 'preview no guarda nada');

  r = await call('POST /api/admin/weekly-refund/batches', { user: admin, body: { text: sheet, fromDate: '2026-11-23', toDate: '2026-11-29' } });
  ok(r.code === 200 && r.body.reembolsos === 3 && r.body.label === '23/11 al 29/11' && r.body.claimHours === 48, 'publicar: 3 reembolsos, etiqueta y 48 h');
  const batchId = r.body.batchId;
  await new Promise((x) => setTimeout(x, 400));
  ok(sent.length === 2 && pushes.length === 2 && /BigOscar072, tenés un REEMBOLSO de \$2\.100/.test(sent.map((s) => s.content).join('|')), 'avisos: chat + push a los 2 que tienen cuenta');
  ok(WeeklyRefund.rows.find((x) => x.usernameLower === 'cirnuevo1').notifyState === 'no_account' && RefundBatch.rows[0].notifyDone === true, 'aviso: el sin cuenta queda no_account y el lote cierra los avisos');
  r = await call('POST /api/admin/weekly-refund/batches', { user: admin, body: { text: sheet, fromDate: '2026-11-23', toDate: '2026-11-29' } });
  ok(r.code === 409, 'publicar la misma semana dos veces → 409');

  r = await call('GET /api/weekly-refund/status', { user: { userId: 'u1', username: 'BigOscar072' } });
  ok(r.body.pending.length === 1 && r.body.pending[0].amount === 2100 && r.body.pending[0].tierName === 'BRONCE' && r.body.pending[0].msLeft > 0 && r.body.tiers.length === 3, 'cliente: ve su reembolso por reclamar con el detalle');
  r = await call('GET /api/weekly-refund/status', { user: { userId: 'u9', username: 'otro' } });
  ok(r.body.items.length === 0, 'cliente sin reembolso: lista vacía');
  const itemId = WeeklyRefund.rows.find((x) => x.usernameLower === 'bigoscar072').id;
  r = await call('POST /api/weekly-refund/claim', { user: { userId: 'u2', username: 'zyromaria510' }, body: { id: itemId } });
  ok(r.code === 404, 'no se puede reclamar el reembolso de otro');
  const [c1, c2] = await Promise.all([
    call('POST /api/weekly-refund/claim', { user: { userId: 'u1', username: 'BigOscar072' }, body: { id: itemId } }),
    call('POST /api/weekly-refund/claim', { user: { userId: 'u1', username: 'BigOscar072' }, body: { id: itemId } })
  ]);
  ok([c1.code, c2.code].sort().join() === '200,409' || [c1.code, c2.code].sort().join() === '200,404', `doble toque en RECLAMAR: uno solo gana (${c1.code}/${c2.code})`);
  ok(PlatformTask.rows.length === 1 && PlatformTask.rows[0].amount === 2100 && PlatformTask.rows[0].reference === 'vip-wrf-2026-11-23-bigoscar072' && PlatformTask.rows[0].flow === 'weekly_refund', 'una sola tarea pendiente, con reference estable');
  ok(notes.length === 1 && /REEMBOLSO SEMANAL RECLAMADO — \$2\.100 ✅ VERIFICADO POR EL SISTEMA/.test(notes[0].content), 'nota al agente con el detalle verificado');
  ok(ChatStatus.rows.length === 1, 'el reclamo trae el chat a la lista');
  ok(sent.some((s) => /Reclamo recibido! Tu reembolso de \$2\.100/.test(s.content)), 'mensaje al cliente de reclamo recibido');

  r = await call('GET /api/admin/weekly-refund/user/:userId', { user: cargas, params: { userId: 'u1' } });
  ok(r.body.items.length === 1 && r.body.items[0].status === 'claimed' && r.body.canSettle === true, 'cartel del chat: reclamado, con botón para el cajero');
  r = await call('GET /api/admin/weekly-refund/items', { user: cargas, query: { status: 'claimed' } });
  ok(r.body.items.length === 1, 'lista "por entregar"');
  r = await call('POST /api/admin/weekly-refund/items/:id/delivered', { user: pagos, params: { id: itemId } });
  ok(r.code === 403, 'pagos no puede entregar (403)');
  const other = WeeklyRefund.rows.find((x) => x.usernameLower === 'zyromaria510').id;
  r = await call('POST /api/admin/weekly-refund/items/:id/delivered', { user: cargas, params: { id: other } });
  ok(r.code === 400, 'no se puede entregar uno que el cliente no reclamó');
  const before = sent.length;
  r = await call('POST /api/admin/weekly-refund/items/:id/delivered', { user: cargas, params: { id: itemId } });
  ok(r.code === 200 && r.body.item.status === 'delivered' && r.body.item.deliveredBy === 'cajero1', 'marcar como entregado');
  ok(sent.length === before + 1 && /Tu reembolso de \$2\.100 \(semana 23\/11 al 29\/11\) ya está acreditado/.test(sent[sent.length - 1].content), 'aviso automático de entrega al cliente (uno solo)');
  ok(Transaction.rows.length === 1 && Transaction.rows[0].type === 'refund' && Transaction.rows[0].amount === 2100 && Transaction.rows[0].metadata.source === 'weekly_refund', 'queda la Transaction de reembolso');
  r = await call('POST /api/admin/weekly-refund/items/:id/delivered', { user: admin, params: { id: itemId } });
  ok(r.code === 200 && r.body.alreadyDelivered === true && sent.length === before + 1 && Transaction.rows.length === 1, 'marcar dos veces: no repite aviso ni Transaction');
  r = await call('POST /api/weekly-refund/claim', { user: { userId: 'u1', username: 'BigOscar072' }, body: { id: itemId } });
  ok(r.code === 409, 'reclamar uno ya entregado → 409');

  // vencimiento
  WeeklyRefund.rows.find((x) => x.usernameLower === 'zyromaria510').expiresAt = new Date(Date.now() - 1000);
  r = await call('POST /api/weekly-refund/claim', { user: { userId: 'u2', username: 'zyromaria510' }, body: { id: other } });
  ok(r.code === 410 && WeeklyRefund.rows.find((x) => x.id === other).status === 'expired', 'fuera de plazo → vencido (410)');

  r = await call('GET /api/admin/weekly-refund/batches', { user: cargas });
  const cts = r.body.batches[0].counts;
  ok(cts.delivered.n === 1 && cts.delivered.total === 2100 && cts.expired.n === 1 && cts.claim_pending.n === 1 && r.body.canUpload === false, 'resumen de la semana por estado');

  // anular y volver a subir: el que ya cobró no vuelve a entrar; reference repetida no paga dos veces
  r = await call('POST /api/admin/weekly-refund/batches/:id/cancel', { user: cargas, params: { id: batchId } });
  ok(r.code === 403, 'anular: sólo admin general');
  r = await call('POST /api/admin/weekly-refund/batches/:id/cancel', { user: admin, params: { id: batchId } });
  ok(r.code === 200 && r.body.cancelados === 1 && r.body.quedan === 1, 'anular: cancela lo no reclamado, deja lo entregado');
  r = await call('POST /api/admin/weekly-refund/batches', { user: admin, body: { text: sheet, fromDate: '2026-11-23', toDate: '2026-11-29', notify: false } });
  ok(r.code === 200 && r.body.reembolsos === 2 && r.body.yaReclamados === 1, 'resubir la semana: el que ya cobró queda afuera');

  // rangos
  r = await call('POST /api/admin/weekly-refund/config', { user: cargas, body: { tiers: [{ name: 'X', min: 1, pct: 1 }] } });
  ok(r.code === 403, 'rangos: sólo admin general');
  r = await call('POST /api/admin/weekly-refund/config', { user: admin, body: { tiers: [{ name: 'A', min: 100, pct: 3 }, { name: 'B', min: 100, pct: 5 }] } });
  ok(r.code === 400, 'rangos inválidos → 400 con el motivo');
  r = await call('POST /api/admin/weekly-refund/config', { user: admin, body: { tiers: [{ name: 'UNICO', min: 10000, pct: 2 }] } });
  ok(r.code === 200 && cfg.weeklyRefund.tiers.length === 1, 'rangos guardados');
  r = await call('POST /api/admin/weekly-refund/preview', { user: admin, body: { text: sheet } });
  ok(r.body.totals.conBeneficio === 4 && r.body.items.find((i) => i.username === 'luxcaro990').amount === 300, 'la vista previa usa los rangos nuevos');
  commands['/sys_refund_claim_hours'] = '72';
  console.log(fail ? `\n❌ FALLARON ${fail}` : '\n✅ FLUJO COMPLETO OK');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('EXCEPCIÓN', e); process.exit(1); });
