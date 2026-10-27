// #235 (owner 2026-10-26; réplica del #208 de CARGASGIROX): INTERRUPTORES de las funciones replicadas de PICA ROJA (PICAROJA30).
// Todas arrancan APAGADAS y se prenden/apagan desde el panel → COMANDOS → "🧩 Funciones" (solo admin
// general). Viven en Config['features'] = { datosIa, fraudRadar, notifCenter, autopilot, stories, legacyNotifs }.
// Cache de 30 s por proceso (en AWS EB cada instancia refresca sola; apagar algo tarda como mucho 30 s).
//
// `legacyNotifs` es el sistema de notificaciones automáticas ANTERIOR de esta página (estrategia programada
// `ScheduledNotif`, reglas `NotificationRule`, motor de encuesta y recordatorios sin regalos #209): el owner lo dejó apagado al replicar el
// Centro de avisos + piloto automático nuevos. Los envíos MANUALES del panel (compositor, lotes, campañas del
// cronograma creadas a mano) NO dependen de este flag.
const Config = require('../models/Config');

const KEY = 'features';
const TTL_MS = 30 * 1000;

const DEFAULTS = Object.freeze({
  datosIa: false,      // panel → Datos IA 🔒 (+ ping de actividad de la app)
  fraudRadar: false,   // panel → Alertas de estafa
  notifCenter: false,  // panel → Centro de avisos (recorrido de retención, recordatorios de reembolso, preferencias)
  autopilot: false,    // cronograma → piloto automático de notificaciones (1 campaña/día a las 19 h)
  stories: false,      // historias (manuales + automáticas) en la app
  legacyNotifs: false, // sistema de notificaciones automáticas anterior (ScheduledNotif + reglas + encuesta)
  landingSignup: false // #242 alta por landing en modo manual: la cuenta nace local y un agente la crea en GANAMOS
});

const LABELS = Object.freeze({
  datosIa: 'Datos IA 🔒 (análisis, comparativa, panorama, cierre e historial; mide el uso de la app)',
  fraudRadar: 'Alertas de estafa (cruce de CBU, celular, teléfono, bonos y retiros; caso completo y bloqueo)',
  notifCenter: 'Centro de avisos (recorrido de retención por cliente, tope diario/mensual, aviso del reembolso semanal, qué avisos quiere cada uno)',
  autopilot: 'Notificaciones programadas automáticas (una campaña por día a las 19 h en 3 tandas, sólo a quien tiene la app)',
  stories: 'Historias (manuales con bono +X% y automáticas: 5 por día, partidos, slot de la semana)',
  legacyNotifs: 'Sistema de notificaciones automáticas ANTERIOR (estrategia programada + reglas + encuesta + recordatorios sin regalos)',
  landingSignup: 'Alta por LANDING sin API (la landing crea la cuenta en la web y queda una tarea "crear usuario en GANAMOS" para el agente; el cliente ve usuario y clave y entra a la app)'
});

let _cache = { at: 0, v: null };

function _normalize(raw) {
  const out = { ...DEFAULTS };
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(DEFAULTS)) if (typeof raw[k] === 'boolean') out[k] = raw[k];
  }
  return out;
}

async function getAll() {
  const now = Date.now();
  if (_cache.v && now - _cache.at < TTL_MS) return _cache.v;
  let raw = null;
  try { raw = await Config.get(KEY, null); } catch (_) { /* sin DB: todo apagado */ }
  _cache = { at: now, v: _normalize(raw) };
  return _cache.v;
}

async function isOn(name) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULTS, name)) return false;
  const all = await getAll();
  return all[name] === true;
}

// `patch` = { flag: boolean, ... }; devuelve { before, after, changed:[flag...] }.
async function set(patch, updatedBy) {
  const before = { ...(await getAll()) };
  const after = { ...before };
  const changed = [];
  for (const k of Object.keys(DEFAULTS)) {
    if (patch && typeof patch[k] === 'boolean' && patch[k] !== before[k]) { after[k] = patch[k]; changed.push(k); }
  }
  if (changed.length) await Config.set(KEY, after, updatedBy || null);
  invalidate();
  return { before, after, changed };
}

function invalidate() { _cache = { at: 0, v: null }; }

module.exports = { KEY, DEFAULTS, LABELS, getAll, isOn, set, invalidate };
