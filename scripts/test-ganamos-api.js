/**
 * test-ganamos-api.js — test EN FRÍO del cliente de la API de agente GANAMOS (#191).
 * Stubea axios (NO toca la red) y verifica el contrato y las reglas de plata:
 *  - contrato completo vs giroxService;
 *  - login una sola vez (mutex) y cookie reusada;
 *  - carga = operation 0, retiro = operation 1 (configurable);
 *  - LECTURA reintenta ante fallo de red; PAGO NO reintenta y devuelve indeterminate;
 *  - 401 → re-login + 1 reintento; Cloudflare 403 → code cloudflare_blocked;
 *  - resolución username→id por search + detalle.
 * Correr: `node scripts/test-ganamos-api.js`
 */
const Module = require('module');
const path = require('path');

// ---- stub de axios ----
let calls = [];
let loginCount = 0;
let scenario = 'ok';
function res(status, data, headers = {}) { return { status, data, headers }; }
const fakeAxios = function (cfg) { // axios({...})
  calls.push({ method: cfg.method, url: cfg.url, body: cfg.data, cookie: cfg.headers && cfg.headers.cookie });
  const p = cfg.url;
  if (/\/user\/search\//.test(p)) return Promise.resolve(res(200, { results: [{ id: 33090669, username: 'bigjos', balance: 1234 }] }));
  if (/\/user\/\d+\/payment\//.test(p)) {
    if (scenario === 'pay_timeout') return Promise.reject(new Error('timeout'));
    if (scenario === 'pay_401_then_ok') { scenario = 'ok'; return Promise.resolve(res(401, 'unauthorized')); }
    return Promise.resolve(res(200, { id: 999, balance: 1734 }));
  }
  if (/\/user\/\d+\/$/.test(p)) {
    if (scenario === 'read_flaky') { scenario = 'ok'; return Promise.reject(new Error('ECONNRESET')); }
    return Promise.resolve(res(200, { id: 33090669, username: 'bigjos', balance: 1234 }));
  }
  return Promise.resolve(res(404, { message: 'not found' }));
};
fakeAxios.post = function (url, body, cfg) { // login
  calls.push({ method: 'post', url, body, cookie: cfg && cfg.headers && cfg.headers.cookie });
  if (/\/api\/sign\/login$/.test(url)) {
    loginCount++;
    if (scenario === 'cf') return Promise.resolve(res(403, '<html>Forbidden cloudflare</html>'));
    return Promise.resolve(res(200, { ok: true }, { 'set-cookie': ['session=JWTFAKE.' + loginCount + '; Path=/; HttpOnly'] }));
  }
  return fakeAxios({ method: 'post', url, data: body, headers: cfg && cfg.headers });
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'axios') return fakeAxios;
  if (request.endsWith('utils/logger') || request.endsWith('/utils/logger')) return { info() {}, warn() {}, error() {} };
  return origLoad.call(this, request, parent, isMain);
};
const origWarn = console.warn; console.warn = () => {};

process.env.GANAMOS_AGENT_USER = 'agent1';
process.env.GANAMOS_AGENT_PASS = 'secret';
const girox = require(path.join(__dirname, '..', 'src', 'services', 'giroxService'));
const api = require(path.join(__dirname, '..', 'src', 'services', 'ganamosApiService'));

let fails = 0;
const ok = (c, m) => { if (c) console.log('  ✅', m); else { fails++; console.log('  ❌', m); } };
const reset = (sc = 'ok') => { calls = []; scenario = sc; };

(async () => {
  console.log('1) contrato');
  const missing = Object.keys(girox).filter((k) => !(k in api));
  ok(missing.length === 0, `todas las exports de giroxService existen${missing.length ? ' — faltan: ' + missing.join(', ') : ''}`);
  ok(api.GANAMOS_API_MODE === true && api.isEnabled() === true, 'GANAMOS_API_MODE=true, isEnabled()=true (hay credenciales)');

  console.log('2) login único + saldo');
  reset();
  const bal = await api.getUserBalance('bigjos');
  ok(bal.success && bal.balance === 1234, 'getUserBalance → 1234 (search + detalle)');
  const loginsBefore = loginCount;
  await Promise.all([api.getUserBalance('bigjos'), api.getUserBalance('bigjos'), api.getUserBalance('bigjos')]);
  ok(loginCount === loginsBefore, 'sesión cacheada: no re-loguea en cada request');

  console.log('3) carga y retiro (operation)');
  reset();
  const dep = await api.depositToUser('bigjos', 500);
  const payCall = calls.find((c) => /payment\//.test(c.url));
  ok(dep.success && payCall && JSON.stringify(payCall.body) === JSON.stringify({ operation: 0, amount: 500 }), 'carga → POST payment {operation:0, amount:500}');
  ok(dep.data.user_balance_after === 1734, 'saldo posterior leído de la respuesta');
  reset();
  const wd = await api.withdrawFromUser('bigjos', 200);
  const wdCall = calls.find((c) => /payment\//.test(c.url));
  ok(wd.success && wdCall.body.operation === 1, 'retiro → operation 1 (configurable)');

  console.log('4) idempotencia: pago NO reintenta, lectura SÍ');
  reset('pay_timeout');
  const payToBefore = calls.length;
  const p = await api.depositToUser('bigjos', 500);
  const payAttempts = calls.filter((c) => /payment\//.test(c.url)).length;
  ok(!p.success && p.indeterminate === true && p.code === 'unknown_result', 'timeout en pago → indeterminate:true, code unknown_result');
  ok(payAttempts === 1, 'el pago se intentó UNA sola vez (no reintenta)');
  reset('read_flaky');
  const b2 = await api.getUserBalance('bigjos');
  ok(b2.success, 'lectura con fallo transitorio → reintenta y devuelve saldo');

  console.log('5) sesión vencida (401) en pago → re-login + 1 reintento seguro');
  reset('pay_401_then_ok');
  const lc = loginCount;
  const p2 = await api.depositToUser('bigjos', 500);
  ok(p2.success && loginCount === lc + 1, '401 en pago → re-loguea una vez y reintenta (401 = no tocó plata)');

  console.log('6) Cloudflare');
  reset('cf');
  api._login && (async () => {})();
  // forzar expiración de sesión para que reintente login:
  const before = loginCount;
  // manipular TTL: llamamos login(true)
  const cf = await api._login(true);
  ok(!cf.success && cf.code === 'cloudflare_blocked', 'login 403 Cloudflare → code cloudflare_blocked (no "clave mal")');

  console.log(fails ? `\n❌ ${fails} chequeo(s) fallaron` : '\n✅ Todos los chequeos del cliente API pasan');
  console.warn = origWarn;
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('💥', e); process.exit(1); });
