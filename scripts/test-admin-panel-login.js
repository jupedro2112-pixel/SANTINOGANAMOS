#!/usr/bin/env node
// Test en frío del LOGIN del panel admin (#239). Sin node_modules ni navegador: evalúa
// public/adminprivado2026/admin.js en un DOM mínimo armado con los ids/clases REALES de
// index.html (lo que no existe en el HTML devuelve null, como en el navegador) y corre
// handleLogin() con una respuesta de login como la del server. Si algo de lo que corre
// después del login tira una excepción (p. ej. una función global pisada por un dato con
// el mismo nombre, un elemento que ya no está en el HTML), el panel muestra "Error de
// conexión" aunque el server haya aceptado las credenciales. Este script lo detecta.
//
// Uso: node scripts/test-admin-panel-login.js
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public', 'adminprivado2026');
const src = fs.readFileSync(path.join(ROOT, 'admin.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const classes = new Set();
for (const m of html.matchAll(/\sclass="([^"]+)"/g)) m[1].split(/\s+/).forEach((c) => c && classes.add(c));
const dataAttrs = new Set([...html.matchAll(/\s(data-[a-z-]+)=/g)].map((m) => m[1]));

function el(tag, id) {
  return {
    tagName: String(tag || 'div').toUpperCase(), id: id || '', value: '', textContent: '', innerHTML: '', style: {}, dataset: {},
    children: [], childNodes: [], options: [], files: [], checked: false, disabled: false, selectedIndex: 0, onclick: null,
    scrollTop: 0, scrollHeight: 0, clientHeight: 0, offsetHeight: 0, offsetWidth: 0,
    parentNode: null, parentElement: null, firstChild: null, lastChild: null, nextElementSibling: null, previousElementSibling: null,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute: () => null, removeAttribute() {}, hasAttribute: () => false,
    appendChild(c) { return c; }, append() {}, prepend() {}, removeChild() {}, remove() {}, insertAdjacentHTML() {}, replaceWith() {},
    querySelector: (s) => qs(s), querySelectorAll: (s) => qsa(s), closest: () => null, contains: () => false, cloneNode() { return el(tag); },
    focus() {}, blur() {}, click() {}, scrollIntoView() {}, dispatchEvent() {}, getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
    getContext: () => null, play: () => Promise.resolve(), pause() {}, load() {},
  };
}
function qs(sel) {
  const s = String(sel).trim();
  let m;
  if ((m = s.match(/^#([\w-]+)$/))) return ids.has(m[1]) ? el('div', m[1]) : null;
  if ((m = s.match(/^\.([\w-]+)$/))) return classes.has(m[1]) ? el('div') : null;
  if ((m = s.match(/\[(data-[\w-]+)(?:="[^"]*")?\]/))) return dataAttrs.has(m[1]) ? el('div') : null;
  const first = s.split(/[\s>,]/)[0];
  if ((m = first.match(/^\.([\w-]+)/))) return classes.has(m[1]) ? el('div') : null;
  if ((m = first.match(/^#([\w-]+)/))) return ids.has(m[1]) ? el('div', m[1]) : null;
  return el('div');
}
function qsa(sel) { const e = qs(sel); return e ? [e] : []; }
const storage = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; }, clear() {} }; };

const doc = {
  getElementById: (id) => (ids.has(id) ? el('div', id) : null), querySelector: qs, querySelectorAll: qsa,
  createElement: (t) => el(t), createTextNode: (t) => ({ textContent: t }), createDocumentFragment: () => el('frag'),
  body: el('body'), head: el('head'), documentElement: el('html'), addEventListener() {}, removeEventListener() {},
  hidden: false, visibilityState: 'visible', title: '', cookie: '', activeElement: null, readyState: 'complete',
};
const errors = [];
const win = {
  document: doc,
  location: { hostname: 'x', origin: 'https://x', pathname: '/adminprivado2026/', search: '', href: 'https://x/adminprivado2026/', protocol: 'https:', host: 'x', hash: '', reload() {} },
  localStorage: storage(), sessionStorage: storage(),
  navigator: { serviceWorker: { register: () => Promise.resolve({}), ready: Promise.resolve({}), addEventListener() {}, getRegistrations: () => Promise.resolve([]) }, userAgent: 'test', language: 'es', onLine: true, clipboard: { writeText: () => Promise.resolve() } },
  console: { log() {}, warn() {}, info() {}, debug() {}, group() {}, groupEnd() {}, table() {}, error: (...a) => errors.push(a.map((x) => (x && x.stack ? x.stack.split('\n').slice(0, 4).join('\n') : String(x))).join(' ')) },
  setInterval: () => 0, setTimeout: () => 0, clearInterval() {}, clearTimeout() {}, requestAnimationFrame: () => 0,
  fetch: null, io: null,
  firebase: { apps: [], initializeApp: () => ({}), messaging: () => ({ getToken: () => Promise.resolve(null), onMessage() {} }) },
  Notification: { permission: 'default', requestPermission: () => Promise.resolve('default') },
  URL, URLSearchParams, Date, Math, JSON, Object, Array, Promise, Map, Set, Number, String, Boolean, RegExp, Error, TypeError,
  parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, Intl, Symbol, Proxy, Reflect, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer,
  structuredClone: (x) => x, queueMicrotask: () => {}, atob: (s) => Buffer.from(s, 'base64').toString('binary'), btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  WebSocket: function () {}, Image: function () { return el('img'); }, Blob: function () {}, FormData: function () {}, FileReader: function () {}, Audio: function () { return el('audio'); },
  AbortController: function () { this.signal = {}; this.abort = () => {}; }, MutationObserver: function () { this.observe = () => {}; }, IntersectionObserver: function () { this.observe = () => {}; }, ResizeObserver: function () { this.observe = () => {}; },
  CustomEvent: function () {}, Event: function () {}, HTMLElement: function () {}, Node: function () {}, DOMParser: function () { this.parseFromString = () => doc; }, XMLHttpRequest: function () {},
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }), addEventListener() {}, removeEventListener() {},
  alert() {}, confirm: () => true, prompt: () => '', open() {}, scrollTo() {}, getComputedStyle: () => ({ getPropertyValue: () => '' }),
  crypto: { randomUUID: () => 'u', getRandomValues: (a) => a }, performance: { now: () => 0 }, history: { pushState() {}, replaceState() {} },
  screen: { width: 1200, height: 800 }, innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1,
};
win.window = win; win.self = win; win.globalThis = win;
const ctx = vm.createContext(win);

let failed = 0;
function check(ok, label) { console.log(`${ok ? '✅' : '❌'} ${label}`); if (!ok) failed++; }

try { vm.runInContext(src, ctx, { filename: 'admin.js' }); check(true, 'admin.js se evalúa sin error de nivel superior'); }
catch (e) { check(false, 'admin.js se evalúa sin error de nivel superior: ' + e.message); console.log(e.stack); process.exit(1); }

// Login de cada rol como lo responde POST /api/auth/login para el staff (token + user + modo).
const FEATURES_MANUAL = { api: false, tasks: true, balance: false, stats: false, sso: false, signup: false, rollover: false, bonus: false, cashier: false };
async function loginAs(role, platformMode, platformFeatures) {
  errors.length = 0;
  const loginResp = { token: 'x.y.z', user: { id: 'u1', username: 'tester', role }, platformMode, platformFeatures, playUrl: 'https://example.invalid' };
  win.fetch = (url) => {
    const body = String(url).includes('/api/auth/login') ? loginResp : { success: true, features: {}, items: [], users: [], conversations: [], commands: [] };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)), headers: { get: () => null } });
  };
  win.io = () => ({ on() {}, emit() {}, off() {}, connect() {}, disconnect() {}, connected: false, io: { on() {} } });
  const seen = { loginError: null, toasts: [] };
  ctx.showLoginError = (m) => { seen.loginError = m; };
  ctx.showToast = (m, t) => { seen.toasts.push(`${t}:${m}`); };
  await vm.runInContext("elements.username.value='tester'; elements.password.value='pw'; handleLogin({ preventDefault(){} })", ctx);
  // Dejar correr las promesas encadenadas (loadFeatureNav, badges…) sin que tiren.
  await new Promise((r) => setImmediate(r));
  return { seen, errors: errors.slice() };
}

(async () => {
  for (const [role, mode, feats] of [
    ['admin', 'manual', FEATURES_MANUAL],
    ['depositor', 'manual', FEATURES_MANUAL],
    ['withdrawer', 'manual', FEATURES_MANUAL],
    ['comunidad', 'manual', FEATURES_MANUAL],
    ['admin', 'manual', undefined], // server viejo sin platformFeatures
    ['admin', 'mijoker', { api: true, tasks: false, balance: true, stats: false, sso: false, signup: true, rollover: false, bonus: false, cashier: false }],
    ['admin', 'girox', { api: true, tasks: false, balance: true, stats: true, sso: true, signup: true, rollover: true, bonus: true, cashier: true }],
  ]) {
    const r = await loginAs(role, mode, feats);
    const ok = r.seen.loginError === null && r.seen.toasts.includes('success:Login exitoso') && r.errors.length === 0;
    check(ok, `login ${role} en modo ${mode}${feats ? '' : ' (sin platformFeatures)'} termina en "Login exitoso"`);
    if (!ok) { if (r.seen.loginError) console.log('   showLoginError →', r.seen.loginError); r.errors.forEach((e) => console.log('   console.error →', e)); }
  }
  // La función de capacidades tiene que seguir siendo función después del login.
  const stillFn = vm.runInContext("typeof _platformFeatures === 'function' && typeof _platformFeatures().tasks === 'boolean'", ctx);
  check(stillFn, '_platformFeatures() sigue siendo una función después del login (#239: window._platformFeatures la pisaba)');
  console.log(failed ? `\n❌ ${failed} chequeo(s) fallaron` : '\n✅ LOGIN DEL PANEL OK');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('❌ excepción:', e.stack); process.exit(1); });
