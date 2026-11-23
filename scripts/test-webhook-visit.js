// #257 (réplica #235 de CARGASGIROXactivo) Evento 'visita' de los webhooks salientes. En frío: sin base ni red.
//   node scripts/test-webhook-visit.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const root = path.join(__dirname, '..');
const sent = [];
const users = { u1: { id: 'u1', role: 'user', username: 'jugador', createdAt: new Date('2026-01-01'), acquisitionCampaign: 'CAMP', lastVisitWebhookAt: null },
  adm: { id: 'adm', role: 'admin', lastVisitWebhookAt: null } };
const User = {
  updateOne: async (q, upd) => {
    const u = users[q.id]; if (!u || (q.role && u.role !== q.role)) return { modifiedCount: 0 };
    const cut = q.$or[1].lastVisitWebhookAt.$lt;
    if (u.lastVisitWebhookAt && !(u.lastVisitWebhookAt < cut)) return { modifiedCount: 0 };
    u.lastVisitWebhookAt = upd.$set.lastVisitWebhookAt; return { modifiedCount: 1 };
  },
  findOne: (q) => ({ select: () => ({ lean: async () => users[q.id] || null }) })
};
const origLoad = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === 'axios') return { post: async (url, body, o) => { sent.push({ url, body: JSON.parse(body), headers: o.headers }); return { status: 200, data: 'ok' }; } };
  if (/models\/OutboundWebhookQueue$/.test(req)) return { create: async () => {}, find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }), countDocuments: async () => 0 };
  if (/models\/User$/.test(req)) return User;
  if (/utils\/logger$/.test(req)) return { warn() {}, info() {}, error() {} };
  return origLoad.call(this, req, parent, ...rest);
};
const outboundWebhook = require(path.join(root, 'src/services/outboundWebhookService'));
let dests = [];
outboundWebhook.configure({ getDestinations: async () => dests, resolveScope: async () => ({ publisher: 'Pub', campaignCode: 'CAMP' }), publicBaseUrl: () => 'https://sitio.test' });
// `_notifyVisit` tal cual está en server.js
const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const a = src.indexOf('function _notifyVisit('); const b = src.indexOf('\n}\n', a);
assert.ok(a > 0 && b > a, 'no encontré _notifyVisit en server.js');
const _notifyVisit = new Function('outboundWebhook', 'User', 'logger', src.slice(a, b + 2) + '\nreturn _notifyVisit;')(outboundWebhook, User, { warn() {} });
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const dest = (ev) => ({ id: 'd1', name: 'Destino', url: 'https://receptor.test/h', secret: 's3cr3t', enabled: true, scope: 'all', events: Object.assign({ registro: true, primera_carga: true }, ev), fields: {} });

(async () => {
  let n = 0; const ok = (name) => { n++; console.log('  ✅ ' + name); };

  dests = [dest({})];
  _notifyVisit({ userId: 'u1', role: 'user' }); await wait();
  assert.strictEqual(sent.length, 0); assert.strictEqual(users.u1.lastVisitWebhookAt, null);
  ok('ningún destino pidió visitas: no manda nada y no toca la base');

  dests = [dest({ visita: true })];
  _notifyVisit({ userId: 'u1', role: 'user' }, { installed: true }); await wait();
  assert.strictEqual(sent.length, 1);
  const p = sent[0].body;
  assert.strictEqual(p.event, 'visita'); assert.strictEqual(p.user.id, 'u1'); assert.strictEqual(p.user.campaign, 'CAMP'); assert.strictEqual(p.user.publisher, 'Pub');
  assert.strictEqual(p.user.username, undefined, 'el username no viaja (#344)');
  assert.deepStrictEqual(p.visit, { installed: true }); assert.strictEqual(p.amount, null); assert.strictEqual(p.transaction_id, null);
  assert.ok(/^visita_u1_\d+$/.test(p.event_id)); assert.strictEqual(sent[0].headers['X-Webhook-Event'], 'visita');
  assert.strictEqual(sent[0].headers['X-Webhook-Signature'], outboundWebhook.sign('s3cr3t', sent[0].headers['X-Webhook-Timestamp'], JSON.stringify(p)));
  ok('visita: sale con el mismo bloque user que los demás eventos, firmada, sin username');

  _notifyVisit({ userId: 'u1', role: 'user' }); _notifyVisit({ userId: 'u1', role: 'user' }); await wait();
  assert.strictEqual(sent.length, 1);
  ok('otra entrada dentro de los 30 min: no repite');

  users.u1.lastVisitWebhookAt = new Date(Date.now() - outboundWebhook.VISIT_GAP_MS - 1000);
  _notifyVisit({ userId: 'u1', role: 'user' }); await wait();
  assert.strictEqual(sent.length, 2); assert.notStrictEqual(sent[1].body.event_id, sent[0].body.event_id); assert.deepStrictEqual(sent[1].body.visit, { installed: false });
  ok('pasados los 30 min: manda una visita nueva con otro event_id');

  _notifyVisit({ userId: 'adm', role: 'admin' }); _notifyVisit(null); _notifyVisit({}); await wait();
  assert.strictEqual(sent.length, 2);
  ok('admins / sin sesión: no cuentan como visita');

  users.u1.lastVisitWebhookAt = null; dests = [Object.assign(dest({ visita: true }), { scope: 'publishers', publishers: ['Otro'] })];
  _notifyVisit({ userId: 'u1', role: 'user' }); await wait();
  assert.strictEqual(sent.length, 2);
  ok('destino limitado a otro publicista: no recibe la visita de este jugador');

  dests = [dest({ carga: true, retiro: true })]; sent.length = 0;
  outboundWebhook.notify('registro', users.u1); await wait();
  assert.strictEqual(sent.length, 1); assert.strictEqual(sent[0].body.event, 'registro'); assert.strictEqual(sent[0].body.visit, undefined);
  ok('los demás eventos no cambian (sin bloque visit)');

  console.log('\n✅ Todo OK (' + n + ')');
})().catch((e) => { console.error('❌ ' + (e && e.stack || e)); process.exit(1); });
