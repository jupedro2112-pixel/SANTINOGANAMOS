#!/usr/bin/env node
'use strict';
/**
 * Test en frío del REEMBOLSO SEMANAL POR ARCHIVO (#215): parser de la planilla y cálculo
 * por usuario. Sin DB ni red. Correr tras tocar src/utils/weeklyRefund.js:
 *   node scripts/test-weekly-refund.js
 * El cálculo tiene que dar lo mismo que el Apps Script del owner (rango sobre el NETO).
 */
const wr = require('../src/utils/weeklyRefund');

let fail = 0;
function eq(got, want, msg) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? '✅' : '❌'} ${msg}${ok ? '' : `\n     esperado: ${JSON.stringify(want)}\n     obtenido: ${JSON.stringify(got)}`}`);
}

// ---- Montos
eq(wr.parseAmount('50000'), 50000, 'monto entero');
eq(wr.parseAmount(5384), 5384, 'monto numérico');
eq(wr.parseAmount('50.000'), 50000, 'miles con punto');
eq(wr.parseAmount('1.250.000'), 1250000, 'millones con punto');
eq(wr.parseAmount('50.000,50'), 50000.5, 'es-AR con decimales');
eq(wr.parseAmount('50,000.50'), 50000.5, 'en-US con decimales');
eq(wr.parseAmount('50,000'), 50000, 'miles con coma');
eq(wr.parseAmount('1500,5'), 1500.5, 'decimal con coma');
eq(wr.parseAmount('1500.5'), 1500.5, 'decimal con punto');
eq(wr.parseAmount('$ 5.384'), 5384, 'con signo $');
eq(wr.parseAmount('-2000'), -2000, 'negativo');
eq(Number.isNaN(wr.parseAmount('abc')), true, 'texto → NaN');
eq(Number.isNaN(wr.parseAmount('')), true, 'vacío → NaN');

// ---- Rangos (los cortes del script: 50000 / 100001 / 300001)
const T = wr.DEFAULT_TIERS;
eq(wr.tierFor(49999, T), null, '49.999 → sin rango');
eq(wr.tierFor(50000, T).name, 'BRONCE', '50.000 → BRONCE');
eq(wr.tierFor(100000, T).name, 'BRONCE', '100.000 → BRONCE');
eq(wr.tierFor(100000, T).falta, 1, '100.000 → le falta $1 para PLATA');
eq(wr.tierFor(100001, T).name, 'PLATA', '100.001 → PLATA');
eq(wr.tierFor(300000, T).name, 'PLATA', '300.000 → PLATA');
eq(wr.tierFor(300001, T).name, 'ORO', '300.001 → ORO');
eq(wr.tierFor(300001, T).falta, 0, 'ORO → rango máximo (falta 0)');
eq(wr.tierFor(-5000, T), null, 'neto negativo → sin rango');

// ---- normalizeTiers
eq(wr.normalizeTiers([{ name: 'B', min: 300, pct: 10 }, { name: 'A', min: 100, pct: 3 }]).map((t) => t.name), ['A', 'B'], 'ordena por "desde"');
let threw = false; try { wr.normalizeTiers([{ name: 'A', min: 100, pct: 3 }, { name: 'B', min: 100, pct: 5 }]); } catch (_) { threw = true; }
eq(threw, true, 'rangos con el mismo "desde" → error');
threw = false; try { wr.normalizeTiers([{ name: 'A', min: 100, pct: 0 }]); } catch (_) { threw = true; }
eq(threw, true, '% 0 → error');
eq(wr.safeTiers('basura').length, 3, 'config rota → default');

// ---- Parser: pegado desde la planilla (tabs, con encabezado y columna fecha)
const pegado = [
  'Type\tUser\tAmount\tfecha',
  'deposit\tbigoscar072\t50000\t23/11',
  'deposit\tBigOscar072\t30000\t24/11',
  'withdraw\tbigoscar072\t10000\t24/11',
  'deposit\tluxcaro990\t5000\t23/11',
  'deposit\tluxcaro990\t10000\t23/11',
  'withdrawal\tzyromaria510\t20000\t25/11',
  'deposit\tzyromaria510\t350000\t23/11',
  'bonus\tzyromaria510\t9999\t23/11',
  'deposit\t\t1000\t23/11',
  'deposit\tmetjuan145\tabc\t23/11',
  ''
].join('\n');
const p1 = wr.parseSheetText(pegado);
eq(p1.stats.header, true, 'detecta el encabezado');
eq(p1.rows.length, 7, 'filas válidas');
eq([p1.stats.otherType, p1.stats.noUser, p1.stats.badAmount], [1, 1, 1], 'descarta tipo desconocido / sin usuario / monto inválido');
const c1 = wr.computeWeeklyRefunds(p1.rows);
eq(c1.totals, { usuarios: 3, conBeneficio: 2, sinBeneficio: 1, totalDepositos: 445000, totalRetiros: 30000, totalNeto: 415000, totalBeneficio: 35100 }, 'totales');
eq(c1.items.map((i) => [i.usernameLower, i.depositos, i.retiros, i.neto, i.count, i.tierName, i.pct, i.amount, i.falta]),
  [['zyromaria510', 350000, 20000, 330000, 1, 'ORO', 10, 33000, 0], ['bigoscar072', 80000, 10000, 70000, 2, 'BRONCE', 3, 2100, 30001]],
  'por usuario (agrupa sin distinguir mayúsculas, cuenta sólo cargas, orden por neto)');
eq(c1.sinBeneficio.map((s) => [s.usernameLower, s.neto, s.falta]), [['luxcaro990', 15000, 35000]], 'sin beneficio + lo que le falta');

// ---- Parser: CSV con comas, sin encabezado, montos con separador de miles entre comillas
const csv = 'deposit,cirdiego525,"120,000",23/11\r\nwithdraw,cirdiego525,"19.999",24/11\r\n';
const p2 = wr.parseSheetText(csv);
eq(p2.stats.header, false, 'CSV sin encabezado');
const c2 = wr.computeWeeklyRefunds(p2.rows);
eq(c2.items.map((i) => [i.usernameLower, i.neto, i.tierName, i.amount]), [['cirdiego525', 100001, 'PLATA', 5000]], 'CSV con comillas y miles → PLATA 5% (redondeo a pesos)');

// ---- Parser: punto y coma + encabezado en castellano
const p3 = wr.parseSheetText('Tipo;Usuario;Monto\ncarga;metjuan145;60.000\nretiro;metjuan145;5.000\n');
eq(wr.computeWeeklyRefunds(p3.rows).items.map((i) => [i.usernameLower, i.neto, i.amount]), [['metjuan145', 55000, 1650]], 'separador ; + Tipo/Usuario/Monto + carga/retiro');

// ---- Escalera propia
const c4 = wr.computeWeeklyRefunds(p1.rows, [{ name: 'UNICO', min: 10000, pct: 2.5 }]);
eq(c4.items.map((i) => [i.usernameLower, i.amount]), [['zyromaria510', 8250], ['bigoscar072', 1750], ['luxcaro990', 375]], 'escalera propia de un rango');

// ---- Vacío
eq(wr.parseSheetText('').rows.length, 0, 'texto vacío');
eq(wr.computeWeeklyRefunds([]).totals.usuarios, 0, 'sin filas');

console.log(fail ? `\n❌ FALLARON ${fail}` : '\n✅ TODO OK');
process.exit(fail ? 1 : 0);
