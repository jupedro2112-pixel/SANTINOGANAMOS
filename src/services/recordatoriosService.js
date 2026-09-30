'use strict';
// =====================================================================
// recordatoriosService — motor de RECORDATORIOS por push, SIN REGALOS (#209,
// owner 2026-09-30: "solo reactivar inactivos, que entren a jugar, que no se
// olviden de su giro… sin regalar nada; antes se pausó todo porque regalaba bonos
// a todos por todos lados").
//
// Tres avisos, todos de TEXTO (nunca crean PromoBonus ni acreditan nada):
//   inactivo → escalera por días SIN ENTRAR (lastLogin): un push por escalón, y
//              después uno cada `repetirCadaDias`. Se reinicia cuando vuelve a entrar.
//   giro     → "tu giro ya está disponible": 24 h después del último giro (ventana
//              rodante de la ruleta), una vez por ventana, sólo a quien puede girar.
//   premio   → "tu premio vence pronto": premio por reclamar que vence en ≤ N horas.
//
// Candados: horario silencioso (default 00–09 ART), tope de avisos por usuario y
// día (default 1; el de premio no cuenta), idempotencia por `fireKey` único.
// El motor DUERME salvo que la config tenga isActive === true.
// =====================================================================

const DEFAULTS = {
  isActive: false,
  quietFrom: 0,   // hora ART desde la que NO se manda nada
  quietTo: 9,     // hora ART hasta la que NO se manda nada
  maxPorDia: 1,   // avisos (inactivo+giro) por usuario y día
  inactivos: {
    enabled: true,
    pasos: [
      { dias: 3,  title: '👋 ¿Andás por ahí, {username}?', body: 'Hace unos días que no entrás. La ruleta diaria te está esperando en GANAMOS 🎡' },
      { dias: 7,  title: '🎰 Te extrañamos en GANAMOS', body: 'Una semana sin jugar… hoy puede ser tu día. Entrá y probá suerte.' },
      { dias: 14, title: '🔥 Volvé a la acción', body: 'Ya pasaron dos semanas. Tu giro diario sigue disponible: entrá y girá.' },
      { dias: 30, title: '⭐ GANAMOS sigue acá', body: 'Un mes sin verte. Entrá cuando quieras, la sala está abierta 24/7.' }
    ],
    repetirCadaDias: 15,
    repetir: { title: '🎡 Tu giro diario te espera', body: 'Entrá a GANAMOS y girá la ruleta. ¡Suerte!' }
  },
  ruleta: {
    giroEnabled: true,
    giro: { title: '🎡 ¡Tu giro ya está disponible!', body: 'Pasaron 24 h desde tu último giro. Entrá a GANAMOS y girá la ruleta diaria.' },
    giroMaxHoras: 48, // no avisar si el último giro fue hace más de esto (de eso se ocupa "inactivo")
    premioEnabled: true,
    premioHorasAntes: 3,
    premio: { title: '⏰ Tu premio vence pronto', body: 'Tenés {premio} por reclamar hasta las {vence}. Entrá a GANAMOS y tocá RECLAMAR.' }
  }
};

function _n(v, def, min, max) { const x = Number(v); return Number.isFinite(x) && x >= min && x <= max ? x : def; }
function _txt(v, def, max) { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, max || 160) : def; }
function _clone(o) { return JSON.parse(JSON.stringify(o)); }

// Normaliza lo guardado en Config['recordatorios'] contra los defaults (todo editable).
function mergeConfig(saved) {
  const s = saved || {}, d = _clone(DEFAULTS);
  const inIn = s.inactivos || {}, ruIn = s.ruleta || {};
  const pasosIn = Array.isArray(inIn.pasos) && inIn.pasos.length ? inIn.pasos : d.inactivos.pasos;
  const pasos = pasosIn.map((p, i) => ({
    dias: _n(p && p.dias, (d.inactivos.pasos[i] || {}).dias || 7, 1, 365),
    title: _txt(p && p.title, (d.inactivos.pasos[i] || d.inactivos.repetir).title, 80),
    body: _txt(p && p.body, (d.inactivos.pasos[i] || d.inactivos.repetir).body, 200)
  })).filter(p => p.dias > 0).sort((a, b) => a.dias - b.dias).slice(0, 8);
  return {
    isActive: s.isActive === true,
    quietFrom: _n(s.quietFrom, d.quietFrom, 0, 23),
    quietTo: _n(s.quietTo, d.quietTo, 0, 23),
    maxPorDia: _n(s.maxPorDia, d.maxPorDia, 1, 5),
    inactivos: {
      enabled: inIn.enabled !== false,
      pasos,
      repetirCadaDias: _n(inIn.repetirCadaDias, d.inactivos.repetirCadaDias, 0, 365), // 0 = no repetir
      repetir: { title: _txt(inIn.repetir && inIn.repetir.title, d.inactivos.repetir.title, 80), body: _txt(inIn.repetir && inIn.repetir.body, d.inactivos.repetir.body, 200) }
    },
    ruleta: {
      giroEnabled: ruIn.giroEnabled !== false,
      giro: { title: _txt(ruIn.giro && ruIn.giro.title, d.ruleta.giro.title, 80), body: _txt(ruIn.giro && ruIn.giro.body, d.ruleta.giro.body, 200) },
      giroMaxHoras: _n(ruIn.giroMaxHoras, d.ruleta.giroMaxHoras, 24, 240),
      premioEnabled: ruIn.premioEnabled !== false,
      premioHorasAntes: _n(ruIn.premioHorasAntes, d.ruleta.premioHorasAntes, 1, 24),
      premio: { title: _txt(ruIn.premio && ruIn.premio.title, d.ruleta.premio.title, 80), body: _txt(ruIn.premio && ruIn.premio.body, d.ruleta.premio.body, 200) }
    }
  };
}

function _hourART(d) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', hour12: false }).formatToParts(d);
  return parseInt((parts.find(p => p.type === 'hour') || {}).value, 10) || 0;
}
function _dayART(d) { return new Date(d.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10); }
function _fmtHora(d) { try { return new Date(d).toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit', hour12: false }); } catch (_) { return ''; } }
function _render(tpl, vars) { let out = String(tpl || ''); for (const [k, v] of Object.entries(vars || {})) out = out.split('{' + k + '}').join(v == null ? '' : String(v)); return out; }
function _inQuiet(cfg, now) {
  const h = _hourART(now);
  if (cfg.quietFrom === cfg.quietTo) return false;
  return cfg.quietFrom < cfg.quietTo ? (h >= cfg.quietFrom && h < cfg.quietTo) : (h >= cfg.quietFrom || h < cfg.quietTo);
}
function _prizeText(sp) {
  if (sp.prizeType === 'percent' || (!(sp.prizeARS > 0) && sp.prizePct > 0)) return '+' + sp.prizePct + '% EXTRA en tu próxima carga';
  return '$' + Number(sp.prizeARS || 0).toLocaleString('es-AR');
}

// tick — lo llama el cron del server cada 30 min.
// deps: { cfg, models:{User, RecordatorioFire, DailyRouletteSpin}, sendPushFn(User,title,body,data,filter),
//         canSpin(user) → Promise<boolean> (elegibilidad de la ruleta), logger, now }
async function tick(deps) {
  const cfg = deps.cfg;
  const logger = deps.logger || console;
  if (!cfg || cfg.isActive !== true) return { skipped: 'inactive' };
  const now = deps.now || new Date();
  if (_inQuiet(cfg, now)) return { skipped: 'quiet' };
  const { User, RecordatorioFire, DailyRouletteSpin } = deps.models;
  const out = { inactivo: 0, giro: 0, premio: 0, errors: 0 };
  const todayStart = new Date(new Date(now.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10) + 'T03:00:00.000Z');

  // Cuántos avisos (inactivo+giro) recibió hoy cada usuario → tope maxPorDia.
  const todayCounts = new Map();
  try {
    const rows = await RecordatorioFire.aggregate([{ $match: { firedAt: { $gte: todayStart }, kind: { $in: ['inactivo', 'giro'] } } }, { $group: { _id: '$username', n: { $sum: 1 } } }]);
    for (const r of rows) todayCounts.set(r._id, r.n);
  } catch (_) {}
  const canSendDaily = (uname) => (todayCounts.get(uname) || 0) < cfg.maxPorDia;
  const fire = async (key, username, kind, step, title, body, data) => {
    try { await RecordatorioFire.create({ fireKey: key, username, kind, step: step || null, firedAt: now }); }
    catch (_) { return false; } // ya salió
    try {
      const r = await deps.sendPushFn(User, title, body, Object.assign({ kind: 'recordatorio_' + kind }, data || {}), { username });
      if (r && r.blocked) { logger.warn('[recordatorios] push bloqueada (' + r.blocked + '): ' + title); }
      todayCounts.set(username, (todayCounts.get(username) || 0) + 1);
      return true;
    } catch (e) { out.errors++; logger.error('[recordatorios] push a ' + username + ': ' + e.message); return false; }
  };

  // ── 1) PREMIO POR VENCER (no cuenta para el tope diario) ──
  if (cfg.ruleta.premioEnabled) {
    try {
      const until = new Date(now.getTime() + cfg.ruleta.premioHorasAntes * 3600 * 1000);
      const spins = await DailyRouletteSpin.find({ status: 'claim_pending', claimExpiresAt: { $gt: now, $lte: until } }).select('id username userId prizeARS prizeType prizePct claimExpiresAt').limit(500).lean();
      for (const sp of spins) {
        const uname = String(sp.username || '').toLowerCase();
        if (!uname) continue;
        const vars = { username: uname, premio: _prizeText(sp), vence: _fmtHora(sp.claimExpiresAt) };
        if (await fire('premio|' + sp.id, uname, 'premio', null, _render(cfg.ruleta.premio.title, vars), _render(cfg.ruleta.premio.body, vars), { spinId: sp.id })) out.premio++;
      }
    } catch (e) { out.errors++; logger.error('[recordatorios] premio: ' + e.message); }
  }

  // ── 2) GIRO DISPONIBLE (24 h después del último giro, una vez por ventana) ──
  if (cfg.ruleta.giroEnabled) {
    try {
      const minAgo = new Date(now.getTime() - 24 * 3600 * 1000);
      const maxAgo = new Date(now.getTime() - cfg.ruleta.giroMaxHoras * 3600 * 1000);
      const rows = await DailyRouletteSpin.aggregate([
        { $match: { spunAt: { $gte: maxAgo } } },
        { $sort: { spunAt: -1 } },
        { $group: { _id: '$userId', lastId: { $first: '$id' }, last: { $first: '$spunAt' }, username: { $first: '$username' } } },
        { $match: { last: { $lte: minAgo } } },
        { $limit: 2000 }
      ]);
      for (const r of rows) {
        const uname = String(r.username || '').toLowerCase();
        if (!uname || !canSendDaily(uname)) continue;
        // ¿ya existe el aviso de esta ventana? (evita consultar elegibilidad al pedo)
        const key = 'giro|' + r._id + '|' + r.lastId;
        const exists = await RecordatorioFire.findOne({ fireKey: key }).select('_id').lean();
        if (exists) continue;
        const user = await User.findOne({ id: r._id }).select('id username role isActive isBlocked fcmTokens fcmTokenContext').lean();
        if (!user || user.role !== 'user' || user.isActive === false || user.isBlocked === true) continue;
        let ok = true;
        try { ok = await deps.canSpin(user); } catch (_) { ok = false; }
        if (!ok) continue;
        const vars = { username: user.username };
        if (await fire(key, uname, 'giro', null, _render(cfg.ruleta.giro.title, vars), _render(cfg.ruleta.giro.body, vars), {})) out.giro++;
      }
    } catch (e) { out.errors++; logger.error('[recordatorios] giro: ' + e.message); }
  }

  // ── 3) INACTIVOS (días sin ENTRAR) ──
  if (cfg.inactivos.enabled && cfg.inactivos.pasos.length) {
    try {
      const pasos = cfg.inactivos.pasos;
      const cutoff = new Date(now.getTime() - pasos[0].dias * 86400000);
      const users = await User.find({
        role: 'user', isActive: { $ne: false }, isBlocked: { $ne: true },
        lastLogin: { $lte: cutoff, $ne: null },
        $or: [{ 'fcmTokens.0': { $exists: true } }, { fcmToken: { $exists: true, $ne: null } }]
      }).select('id username lastLogin').limit(5000).lean();
      for (const u of users) {
        const uname = String(u.username || '').toLowerCase();
        if (!uname || !canSendDaily(uname)) continue;
        const dias = Math.floor((now - new Date(u.lastLogin)) / 86400000);
        let paso = null;
        for (const p of pasos) if (dias >= p.dias) paso = p;
        if (!paso) continue;
        const base = 'inact|' + uname + '|' + _dayART(new Date(u.lastLogin));
        const vars = { username: u.username };
        const last = pasos[pasos.length - 1];
        let key, title, body, step;
        if (paso === last && cfg.inactivos.repetirCadaDias > 0 && dias >= last.dias + cfg.inactivos.repetirCadaDias) {
          const n = Math.floor((dias - last.dias) / cfg.inactivos.repetirCadaDias);
          key = base + '|rep|' + n; step = 'rep' + n;
          title = cfg.inactivos.repetir.title; body = cfg.inactivos.repetir.body;
        } else {
          key = base + '|' + paso.dias; step = String(paso.dias);
          title = paso.title; body = paso.body;
        }
        const exists = await RecordatorioFire.findOne({ fireKey: key }).select('_id').lean();
        if (exists) continue;
        if (await fire(key, uname, 'inactivo', step, _render(title, vars), _render(body, vars), { step })) out.inactivo++;
      }
    } catch (e) { out.errors++; logger.error('[recordatorios] inactivos: ' + e.message); }
  }
  return out;
}

module.exports = { tick, mergeConfig, DEFAULTS };
