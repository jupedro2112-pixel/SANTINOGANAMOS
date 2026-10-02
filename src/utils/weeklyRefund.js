'use strict';
/**
 * REEMBOLSO SEMANAL POR ARCHIVO (#215, GANAMOS sin API).
 *
 * Parte PURA (sin DB ni red, se prueba en frío con scripts/test-weekly-refund.js):
 * lee la planilla semanal de movimientos (la hoja "TOTAL"/"SEMANA N" del Drive del
 * owner: columnas Type | User | Amount | fecha) y calcula, por usuario, lo mismo que
 * hacía su Apps Script para Telegram:
 *
 *   depositos = Σ Amount de las filas "deposit"
 *   retiros   = Σ Amount de las filas "withdraw" / "withdrawal"
 *   neto      = depositos − retiros
 *   rango     = el de mayor `min` que cumpla  neto >= min   (sin rango → sin reembolso)
 *   reembolso = neto × pct%
 *
 * Los rangos son editables desde el panel (Config['weeklyRefund'].tiers); los default
 * son los del script: BRONCE 50.000 → 3% · PLATA 100.001 → 5% · ORO 300.001 → 10%.
 */

const DEFAULT_TIERS = [
  { name: 'BRONCE', min: 50000, pct: 3 },
  { name: 'PLATA', min: 100001, pct: 5 },
  { name: 'ORO', min: 300001, pct: 10 }
];
const MAX_TIERS = 6;
const MAX_ROWS = 200000;

function _noAccents(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Valida y normaliza una escalera cruda [{name, min, pct}]. Tira Error (en castellano,
 * para mostrárselo al admin) si algo no cierra. Devuelve ordenada por `min` ascendente.
 */
function normalizeTiers(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('Tiene que haber al menos un rango.');
  if (raw.length > MAX_TIERS) throw new Error(`Máximo ${MAX_TIERS} rangos.`);
  const out = raw.map((t, i) => {
    const name = String((t && t.name) || '').trim().slice(0, 24);
    const min = Math.round(Number(t && t.min));
    const pct = Math.round(Number(t && t.pct) * 10) / 10;
    if (!name) throw new Error(`Rango ${i + 1}: falta el nombre.`);
    if (!Number.isFinite(min) || min < 1) throw new Error(`Rango "${name}": el "desde $" tiene que ser un número mayor a 0.`);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new Error(`Rango "${name}": el % tiene que estar entre 0,1 y 100.`);
    return { name, min, pct };
  }).sort((a, b) => a.min - b.min);
  for (let i = 1; i < out.length; i++) {
    if (out[i].min <= out[i - 1].min) throw new Error(`Los rangos "${out[i - 1].name}" y "${out[i].name}" arrancan en el mismo monto.`);
  }
  return out;
}

/** Escalera válida SIEMPRE: la guardada si está bien, si no los default (nunca rompe un cálculo). */
function safeTiers(raw) {
  try { return normalizeTiers(raw); } catch (_) { return DEFAULT_TIERS.map((t) => ({ ...t })); }
}

/** Rango para un neto: { name, pct, min, falta, nextName } o null si no llega al primero. */
function tierFor(neto, tiers) {
  const n = Number(neto);
  if (!Number.isFinite(n)) return null;
  let idx = -1;
  for (let i = 0; i < tiers.length; i++) if (n >= tiers[i].min) idx = i;
  if (idx < 0) return null;
  const next = tiers[idx + 1] || null;
  return { name: tiers[idx].name, pct: tiers[idx].pct, min: tiers[idx].min, falta: next ? Math.max(0, next.min - n) : 0, nextName: next ? next.name : null };
}

/** Lo que le falta a un neto SIN rango para entrar al primero (para mostrar en la vista previa). */
function faltaParaPrimerRango(neto, tiers) {
  return tiers.length ? Math.max(0, tiers[0].min - Number(neto || 0)) : 0;
}

/**
 * "50000" · "50.000" · "50.000,50" · "50,000.50" · "$ 5.384" · 5384 → número. NaN si no es un monto.
 * Con un solo separador: si lo siguen exactamente 3 dígitos es de miles; si no, decimal.
 */
function parseAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  let s = String(v == null ? '' : v).trim().replace(/[\s$]|ARS/gi, '');
  if (!s) return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s[0] === '-') { neg = true; s = s.slice(1); }
  if (!/^[\d.,]+$/.test(s)) return NaN;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',';
    const tho = dec === '.' ? ',' : '.';
    s = s.split(tho).join('').replace(dec, '.');
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const parts = s.split(sep);
    const allThousands = parts.length > 1 && parts[0].length >= 1 && parts[0].length <= 3 && parts.slice(1).every((p) => p.length === 3);
    s = allThousands ? parts.join('') : (parts.length === 2 ? parts[0] + '.' + parts[1] : NaN);
    if (typeof s !== 'string') return NaN;
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  return neg ? -n : n;
}

/** Separa una línea respetando comillas ("a,b" es un solo campo; "" = comilla). */
function splitLine(line, delim) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** Tab (pegado desde la planilla) → ; → , según lo que más aparezca en las primeras líneas. */
function detectDelimiter(lines) {
  const sample = lines.slice(0, 20).join('\n');
  const count = (ch) => sample.split(ch).length - 1;
  if (count('\t') > 0) return '\t';
  return count(';') > count(',') ? ';' : ',';
}

const TYPE_DEPOSIT = new Set(['deposit', 'deposits', 'deposito', 'depositos', 'carga', 'cargas']);
const TYPE_WITHDRAW = new Set(['withdraw', 'withdrawal', 'withdrawals', 'retiro', 'retiros']);
function normType(v) {
  const t = _noAccents(v).toLowerCase().trim();
  if (TYPE_DEPOSIT.has(t)) return 'deposit';
  if (TYPE_WITHDRAW.has(t)) return 'withdraw';
  return null;
}

const HEADER_TYPE = ['type', 'tipo'];
const HEADER_USER = ['user', 'usuario', 'username', 'users'];
const HEADER_AMOUNT = ['amount', 'monto', 'importe'];

/**
 * Texto crudo (CSV descargado de Sheets, o las celdas copiadas y pegadas) → filas.
 * Encabezado opcional: si la primera línea trae Type/User/Amount (o Tipo/Usuario/Monto)
 * se usan esas columnas; si no, se asume A=tipo, B=usuario, C=monto.
 * Devuelve { rows:[{type,user,amount,line}], stats }.
 */
function parseSheetText(text) {
  const raw = String(text == null ? '' : text).replace(/^﻿/, '');
  const lines = raw.split(/\r\n|\n|\r/);
  const stats = { lines: 0, header: false, deposits: 0, withdraws: 0, otherType: 0, badAmount: 0, noUser: 0, truncated: false, sampleBad: [] };
  const rows = [];
  const nonEmpty = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].trim()) nonEmpty.push({ text: lines[i], n: i + 1 });
  if (!nonEmpty.length) return { rows, stats };
  const delim = detectDelimiter(nonEmpty.map((l) => l.text));
  let iType = 0, iUser = 1, iAmount = 2;
  let start = 0;
  const first = splitLine(nonEmpty[0].text, delim).map((c) => _noAccents(c).toLowerCase());
  const hT = first.findIndex((c) => HEADER_TYPE.includes(c));
  const hU = first.findIndex((c) => HEADER_USER.includes(c));
  const hA = first.findIndex((c) => HEADER_AMOUNT.includes(c));
  if (hT >= 0 && hU >= 0 && hA >= 0) { iType = hT; iUser = hU; iAmount = hA; start = 1; stats.header = true; }
  const bad = (n, why, txt) => { if (stats.sampleBad.length < 8) stats.sampleBad.push({ line: n, why, text: String(txt).slice(0, 80) }); };
  for (let k = start; k < nonEmpty.length; k++) {
    if (rows.length >= MAX_ROWS) { stats.truncated = true; break; }
    const { text: ln, n } = nonEmpty[k];
    stats.lines++;
    const cells = splitLine(ln, delim);
    const type = normType(cells[iType]);
    if (!type) { stats.otherType++; if (String(cells[iType] || '').trim()) bad(n, 'tipo desconocido', ln); continue; }
    const user = String(cells[iUser] || '').trim();
    if (!user) { stats.noUser++; bad(n, 'sin usuario', ln); continue; }
    const amount = parseAmount(cells[iAmount]);
    if (!Number.isFinite(amount)) { stats.badAmount++; bad(n, 'monto inválido', ln); continue; }
    if (type === 'deposit') stats.deposits++; else stats.withdraws++;
    rows.push({ type, user, amount: Math.abs(amount), line: n });
  }
  return { rows, stats };
}

/**
 * Filas → reembolso por usuario. Mismo criterio que el script del owner; el usuario se
 * agrupa sin distinguir mayúsculas. `items` trae sólo los que tienen rango (orden: neto
 * desc); `sinBeneficio` los que no llegaron al primero.
 */
function computeWeeklyRefunds(rows, tiersRaw) {
  const tiers = safeTiers(tiersRaw);
  const stats = new Map();
  let totalDepositos = 0;
  let totalRetiros = 0;
  for (const r of rows) {
    const key = String(r.user).trim().toLowerCase();
    if (!key) continue;
    let s = stats.get(key);
    if (!s) { s = { username: String(r.user).trim(), usernameLower: key, depositos: 0, retiros: 0, count: 0 }; stats.set(key, s); }
    if (r.type === 'deposit') { s.depositos += r.amount; s.count += 1; totalDepositos += r.amount; }
    else { s.retiros += r.amount; totalRetiros += r.amount; }
  }
  const items = [];
  const sinBeneficio = [];
  let totalBeneficio = 0;
  for (const s of stats.values()) {
    const neto = s.depositos - s.retiros;
    const tier = tierFor(neto, tiers);
    if (!tier) { sinBeneficio.push({ ...s, neto, falta: faltaParaPrimerRango(neto, tiers) }); continue; }
    const amount = Math.round(neto * tier.pct / 100);
    if (!(amount > 0)) { sinBeneficio.push({ ...s, neto, falta: 0 }); continue; }
    totalBeneficio += amount;
    items.push({ ...s, neto, tierName: tier.name, pct: tier.pct, falta: tier.falta, nextTierName: tier.nextName, amount });
  }
  items.sort((a, b) => b.neto - a.neto);
  sinBeneficio.sort((a, b) => b.neto - a.neto);
  return {
    tiers,
    items,
    sinBeneficio,
    totals: {
      usuarios: stats.size,
      conBeneficio: items.length,
      sinBeneficio: sinBeneficio.length,
      totalDepositos,
      totalRetiros,
      totalNeto: totalDepositos - totalRetiros,
      totalBeneficio
    }
  };
}

module.exports = {
  DEFAULT_TIERS,
  MAX_TIERS,
  normalizeTiers,
  safeTiers,
  tierFor,
  parseAmount,
  splitLine,
  detectDelimiter,
  parseSheetText,
  computeWeeklyRefunds
};
