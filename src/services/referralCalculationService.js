/**
 * Servicio de Cálculo Mensual de Referidos
 * Fase A: calcula comisiones por período sin pagar
 *
 * Fuente del revenue: la Partner API de 1girox (`giroxService.getPlayersStatsBatch`,
 * v1.9). Antes el netwin se sacaba del PANEL de administración
 * (`giroxReportsService`), que necesitaba un Bearer de sesión propio y el ID NUMÉRICO
 * del jugador (`User.giroxUserId`). Desde la v1.9 el netwin está en la Partner API
 * misma, por USERNAME y con la misma API key que el resto, así que:
 *   1) ya no hace falta resolver ni cachear el ID numérico para cobrar comisiones
 *      (el que no tenía `giroxUserId` antes quedaba SIN comisión: ese agujero se cerró);
 *   2) entran 100 jugadores en UNA request, no uno por request;
 *   3) desaparece la dependencia del panel, que era el punto más frágil de la
 *      integración (si 1girox le cambiaba el HTML/Bearer, se caían las comisiones).
 *
 * La comisión del owner NO la define el proveedor — es NUESTRA tasa fija
 * (ver `utils/referralRate.js`, 8% por defecto).
 * Los montos vienen en PESOS: no se divide por 100 en ningún lado.
 */
const { v4: uuidv4 } = require('uuid');
const { User, ReferralCommission, ReferralPayout } = require('../models');
const giroxService = require('./platformService');
const { getReferralRateForUser, getConfiguredRate } = require('../utils/referralRate');
const { getPeriodRange } = require('../utils/periodKey');
const logger = require('../utils/logger');

/** Tope duro de la API: 100 usernames por request de `/players/stats/batch`. */
const STATS_BATCH_SIZE = 100;

/**
 * Alcance del netwin: 'casino' (default, decisión del owner 2026-07-31) o 'total'
 * (casino + sports). Mismo criterio y misma env que usan los reembolsos
 * (`GIROX_NETWIN_SCOPE`), para que un jugador no genere comisión sobre una base y
 * reembolso sobre otra.
 *
 * Getter LAZY a propósito: las envs se cargan desde SSM DESPUÉS de los `require()`.
 */
function getNetwinScope() {
  return (process.env.GIROX_NETWIN_SCOPE || 'casino').toLowerCase() === 'total' ? 'total' : 'casino';
}

/**
 * ⚠️ CÓMO SE CALCULA LA COMISIÓN DE REFERIDOS (decisión del owner, 2026-07-31)
 *
 *     comisión del referidor = netwin del referido × 8%
 *
 * Y NADA MÁS. Una sola tasa, aplicada una sola vez.
 *
 * Historia, porque el código venía de otro lado: en JUGAYGANA había DOS tasas
 * encadenadas — el proveedor nos daba una comisión sobre el GGR
 * (`providers[].owner_commission`) y sobre ESE resultado se aplicaba la tasa del
 * referidor (7%). En 1girox todos los campos `commission` del reporte vuelven en 0,
 * así que al migrar se puso el 8% en el primer eslabón… y quedó multiplicándose por
 * el 7% del segundo: el referidor terminaba cobrando 0,56% del netwin en vez de 8%.
 *
 * Se eliminó el encadenamiento. Ahora:
 *   - `totalOwnerRevenue` = el netwin CRUDO que generó el referido (sin tocar).
 *   - `referralRate`      = lo que se lleva el referidor (8%, ver utils/referralRate).
 *   - `commissionAmount`  = totalOwnerRevenue × referralRate.
 *
 * Se mantiene así porque toda la maquinaria de liquidación (deltas contra
 * `alreadySettledRevenue`, pagos parciales) trabaja sobre `totalOwnerRevenue`.
 * La tasa vive en UN solo lugar: `src/utils/referralRate.js`.
 */

/**
 * Traduce las stats de UN jugador (shape de la Partner API v1.9) al shape que este
 * servicio y el modelo ReferralCommission esperan desde la época de JUGAYGANA.
 *
 * @param {Object} stats - entrada de `players[username]` de getPlayersStatsBatch
 *                         (o el resultado de getPlayerStats: mismo shape)
 * @returns {Object} { success, totalGgr, totalBets, totalWins, totalOwnerRevenue, providers, ... }
 */
function mapStatsToRevenue(stats) {
  const scope = getNetwinScope();
  const cats = (stats && stats.categories) || {};
  const casino = cats.casino || { wagered: 0, payout: 0, netwin: 0 };
  const sports = cats.sports || { wagered: 0, payout: 0, netwin: 0 };
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  // ⚠️ ALCANCE (decisión del owner 2026-07-31): sólo CASINO. La API trae casino y
  // sports separados; sports queda afuera hasta que se decida incorporarlo
  // (GIROX_NETWIN_SCOPE=total). Apostado y pagado se toman del MISMO alcance que el
  // netwin: si el netwin es sólo de casino, mostrar el apostado total confundiría al
  // admin al revisar de dónde salió la comisión.
  const inScope = scope === 'total'
    ? [{ key: 'casino', ...casino }, { key: 'sports', ...sports }]
    : [{ key: 'casino', ...casino }];

  const netwin = scope === 'total' ? num(stats.netwin) : num(stats.casinoNetwin);
  const totalBets = inScope.reduce((a, c) => a + num(c.wagered), 0);
  const totalWins = inScope.reduce((a, c) => a + num(c.payout), 0);

  // Netwin negativo = el jugador GANÓ en el período: no hay nada que repartir. Se
  // corta en 0 para no arrastrar deuda al mes siguiente (el referidor no "debe" nada
  // porque su referido tuvo un buen mes).
  //
  // ⚠️ Acá NO se aplica ninguna tasa. `totalOwnerRevenue` es el netwin CRUDO; el 8%
  // del referidor se aplica UNA sola vez, más abajo (commissionAmount). Antes se
  // multiplicaba en los dos lugares y el referidor cobraba 0,56% en vez de 8%.
  const ownerRevenue = netwin > 0 ? netwin : 0;

  // providersBreakdown conserva el shape histórico del modelo
  // ({providerName, ggr, ownerCommissionRate, ownerRevenue}) — NO se toca el schema.
  // El endpoint nuevo NO desglosa por proveedor (Pragmatic, Evolution…), sólo por
  // CATEGORÍA, así que se usan las categorías como "proveedores": es lo único que hay
  // y mantiene la columna del panel con información real en vez de vacía.
  // `ownerCommissionRate` queda en 1 porque la tasa del referidor no corresponde a
  // este nivel (se aplica una sola vez, sobre el total).
  const providers = inScope.map((c) => {
    const cNetwin = num(c.netwin);
    return {
      providerName: c.key,
      ggr: cNetwin,
      ownerCommissionRate: 1,
      ownerRevenue: cNetwin > 0 ? cNetwin : 0
    };
  });

  return {
    success: true,
    giroxUserId: stats && stats.playerId != null ? Number(stats.playerId) : null,
    totalGgr: netwin,                    // netwin del referido (montos en PESOS, no centavos)
    totalBets,
    totalWins,                           // "wins" = lo pagado al jugador
    totalOwnerRevenue: ownerRevenue,     // = netwin crudo; la tasa se aplica una sola vez
    ownerCommissionRate: 1,
    netwinScope: scope,
    providers,
    revenueScope: 'perUser',
    revenueSourceField: 'username'
  };
}

/** Revenue "vacío" (sin actividad computable). Se usa para los `not_found` de la API. */
function emptyRevenue(extra = {}) {
  return {
    success: true,
    giroxUserId: null,
    totalGgr: 0,
    totalBets: 0,
    totalWins: 0,
    totalOwnerRevenue: 0,
    ownerCommissionRate: 1,
    netwinScope: getNetwinScope(),
    providers: [],
    revenueScope: 'perUser',
    revenueSourceField: 'username',
    ...extra
  };
}

/**
 * Trae el netwin del período de TODOS los referidos, en tandas de 100.
 *
 * ⚠️ Antes acá había un batching artesanal con `REVENUE_CONCURRENCY = 5`: cada
 * jugador era UNA request contra el panel, así que con 59 referidos eran 59 requests
 * (en serie tardaba minutos y el ALB cortaba con un 504 HTML → el panel reventaba con
 * "JSON.parse: unexpected character"). Con `/players/stats/batch` entran 100 jugadores
 * por request: 59 referidos = 1 sola request. Ya no hay nada que paralelizar ni límite
 * de concurrencia que cuidar — las tandas se hacen en SERIE justamente para no
 * comernos el rate limit de 60 req/min de la Partner API (que igual es inalcanzable:
 * harían falta más de 6.000 referidos para llegar).
 *
 * @param {Array} users     usuarios referidos (lean) a consultar
 * @param {string} periodKey "2026-07" (para logs)
 * @param {Date} fromDate
 * @param {Date} toDate
 * @returns {{ revenueByUserId: Map<string,Object>, requests: number }}
 */
async function fetchRevenuesForUsers(users, periodKey, fromDate, toDate) {
  const revenueByUserId = new Map();
  let requests = 0;

  for (let i = 0; i < users.length; i += STATS_BATCH_SIZE) {
    const chunk = users.slice(i, i + STATS_BATCH_SIZE);
    const usernames = chunk.map((u) => u.username).filter(Boolean);
    const tanda = `${Math.floor(i / STATS_BATCH_SIZE) + 1}`;

    // Tanda sin un solo username usable (dato corrupto): no se gasta una request.
    if (usernames.length === 0) {
      for (const u of chunk) {
        revenueByUserId.set(u.id, {
          success: false,
          code: 'no_username',
          error: 'El usuario no tiene username: no se puede consultar su netwin en 1girox.',
          giroxUserId: u.giroxUserId || null
        });
      }
      continue;
    }

    let res;
    requests++;
    try {
      res = await giroxService.getPlayersStatsBatch(
        usernames, fromDate, toDate, `refcom ${periodKey} tanda ${tanda}`
      );
    } catch (err) {
      res = { success: false, error: err.message, code: 'exception' };
    }

    if (!res.success) {
      // La tanda entera falló. NO se asume revenue 0: eso escondería el problema y
      // dejaría al referidor sin cobrar sin que nadie se entere. Se marca error por
      // usuario para que aparezca en `results.errors` y el admin pueda recalcular.
      logger.error(
        `[ReferralCalc] Batch de stats FALLÓ | period=${periodKey} tanda=${tanda} ` +
        `usuarios=${usernames.length} error=${res.error} code=${res.code || '-'}`
      );
      for (const u of chunk) {
        revenueByUserId.set(u.id, { success: false, error: res.error, code: res.code || null, giroxUserId: u.giroxUserId || null });
      }
      continue;
    }

    // `not_found` mezcla "no existe en la plataforma" con "no es de nuestro agente"
    // (la API no los distingue). En los dos casos no hay netwin que repartir: se
    // tratan como revenue 0, pero se loguean fuerte porque un referido que debería
    // existir y no aparece suele ser un alta fallida (giroxSyncStatus=error o
    // invalid_username) que hay que arreglar.
    const notFoundSet = new Set((res.notFound || []).map((n) => String(n).toLowerCase()));
    if (notFoundSet.size > 0) {
      logger.warn(
        `[ReferralCalc] Referidos sin stats en 1girox (not_found) | period=${periodKey} ` +
        `tanda=${tanda} cantidad=${notFoundSet.size} usuarios=${(res.notFound || []).join(', ')} ` +
        `→ se calculan con netwin=0 (revisar si el alta en la plataforma falló)`
      );
    }

    const statsByUsername = new Map();
    for (const [uname, st] of Object.entries(res.players || {})) {
      statsByUsername.set(String(uname).toLowerCase(), st);
    }

    for (const u of chunk) {
      const key = String(u.username || '').toLowerCase();
      const stats = statsByUsername.get(key);
      if (stats) {
        revenueByUserId.set(u.id, mapStatsToRevenue(stats));
      } else if (notFoundSet.has(key)) {
        revenueByUserId.set(u.id, emptyRevenue({ notFoundInPlatform: true, code: 'not_found' }));
      } else {
        // Ni en `players` ni en `not_found`: la API no dijo nada de este usuario.
        // No se inventa un 0 — se marca error para que quede visible.
        revenueByUserId.set(u.id, {
          success: false,
          code: 'missing_in_batch',
          error: 'La plataforma no devolvió stats para este usuario en el batch.',
          giroxUserId: u.giroxUserId || null
        });
      }
    }

    logger.info(
      `[ReferralCalc] Batch de stats OK | period=${periodKey} tanda=${tanda} ` +
      `pedidos=${usernames.length} conStats=${statsByUsername.size} notFound=${notFoundSet.size}`
    );
  }

  return { revenueByUserId, requests };
}

/**
 * Fallback defensivo: stats de UN solo jugador. Sólo se usa si un usuario quedó
 * fuera del pre-fetch (no debería pasar); no es el camino normal.
 */
async function fetchReferredRevenue(referredUser, periodKey, fromDate, toDate) {
  const r = await giroxService.getPlayerStats(
    referredUser.username, fromDate, toDate, `refcom ${periodKey} ${referredUser.username}`
  );
  if (!r.success) {
    return { success: false, error: r.error, code: r.code || null, giroxUserId: referredUser.giroxUserId || null };
  }
  return mapStatsToRevenue(r);
}

/**
 * Calcular comisiones de referidos para un período
 * @param {string} periodKey - e.g. "2026-04"
 * @param {Object} [options]
 * @param {boolean} [options.dryRun=false] - si true no guarda en DB
 * @param {string} [options.referrerUserId] - calcular solo para un referidor
 * @returns {Object} resultado del cálculo
 */
async function calculateCommissionsForPeriod(periodKey, options = {}) {
  const { dryRun = false, referrerUserId = null } = options;
  const mode = dryRun ? 'preview' : 'calculate';

  logger.info(`[ReferralCalc] Iniciando cálculo | period=${periodKey} mode=${mode}`);

  const results = {
    periodKey,
    dryRun,
    mode,
    referrersProcessed: 0,
    referredsProcessed: 0,
    commissionsCreated: 0,
    commissionsSkipped: 0,
    commissionsExcluded: 0,
    errors: [],
    details: []
  };

  // providerCallsCount = requests REALES contra la plataforma (antes era 1 por
  // referido; ahora 1 cada 100). revenueLookups = referidos cuyo revenue se leyó.
  let providerCallsCount = 0;
  let revenueLookups = 0;

  // Armar mapa de referidores -> referidos
  // Buscar usuarios que tienen referredByUserId establecido (son los referidos)
  const referredQuery = {
    role: 'user',
    isActive: true,
    referredByUserId: { $ne: null, $exists: true }
  };
  // Si se filtró por referidor, solo buscar referidos de ese referidor
  if (referrerUserId) {
    referredQuery.referredByUserId = referrerUserId;
  }

  const referredUsers = await User.find(referredQuery).lean();

  // Armar mapa de referidores -> sus referidos
  const referrers = new Map();
  for (const user of referredUsers) {
    const referrerId = user.referredByUserId;
    if (!referrers.has(referrerId)) {
      referrers.set(referrerId, []);
    }
    referrers.get(referrerId).push(user);
  }

  if (referrers.size === 0) {
    logger.info('[ReferralCalc] No hay referidores activos con referidos asignados');
    return results;
  }

  results.referrersProcessed = referrers.size;

  // Cargar datos de los referidores por sus IDs (sin restricción de rol/estado para que funcione incluso si el referidor fue desactivado)
  const referrerIds = Array.from(referrers.keys());
  const referrerDocs = await User.find({ id: { $in: referrerIds } }).lean();
  const referrerMap = new Map();
  for (const u of referrerDocs) {
    referrerMap.set(u.id, u);
  }

  // ── Pre-fetch de revenues en TANDAS DE 100 (1 request por tanda) ─────────
  // El loop principal lee de un Map (O(1)); acá se traen todos de una.
  // El rango del período se resuelve UNA vez: la API recibe fechas, no un periodKey.
  //
  // ⚠️ HUSO (pendiente, igual que con el panel — no es un cambio de esta migración):
  // `getPeriodRange` arma las Date en la hora LOCAL DEL PROCESO y giroxService las
  // formatea en hora ARGENTINA. Si la instancia corre en UTC, el mes queda corrido 3
  // horas (entran las últimas 3 h del mes anterior y se pierden las últimas 3 h del
  // mes). Se mantiene el mismo comportamiento que antes para no mover la base de
  // cálculo sin verificarlo; si se corrige, corregir también los reembolsos.
  const { fromDate, toDate } = getPeriodRange(periodKey);
  const usersNeedingRevenue = referredUsers.filter(u => !u.excludedFromReferral);
  const prefetch = await fetchRevenuesForUsers(usersNeedingRevenue, periodKey, fromDate, toDate);
  const revenueByReferredId = prefetch.revenueByUserId;
  const batchRequests = prefetch.requests;
  providerCallsCount += batchRequests;
  logger.info(
    `[ReferralCalc] Pre-fetch revenues completado | period=${periodKey} usuarios=${usersNeedingRevenue.length} ` +
    `requests=${batchRequests} (tandas de ${STATS_BATCH_SIZE}) tasaReferidor=${getConfiguredRate()}`
  );

  for (const [referrerId, usersReferredByThisReferrer] of referrers) {
    const referrer = referrerMap.get(referrerId);
    if (!referrer) {
      logger.warn(`[ReferralCalc] Referidor ${referrerId} no encontrado en la base de datos`);
      continue;
    }

    const referralRate = getReferralRateForUser(referrer);

    // ── Load authoritative settlement state from payout history ──────────────
    // ReferralPayout documents are the source of truth for what was already paid.
    // Relying solely on ReferralCommission.settledOwnerRevenue was fragile: running
    // calculate() more than once after a payout caused the field to be overwritten
    // with 0 (because existingIsPaid was false on the second run), which made the
    // next payout treat the already-settled slice as pending again (double payment).
    //
    // We query once per referrer and build a map keyed by referredUserId so the
    // inner loop has O(1) lookup.  The maximum cumulative value across all payouts
    // for a given referred user is taken because:
    //   • each successive payout's alreadySettled already includes all prior payouts
    //   • commissions are never negative, so the highest cumulative is always the
    //     most recent and complete settlement baseline
    //
    // referrerId comes from referredByUserId stored in the users collection.  That
    // field is populated during registration from user-provided input.  We use a
    // capturing regex (/^([a-zA-Z0-9_-]{1,128})$/) so that only the captured group
    // referrerId comes from referredByUserId stored in the users collection.  That
    // field is populated during registration from user-provided input.  We use a
    // capturing regex (/^([a-zA-Z0-9_-]{1,128})$/) so that only the captured group
    // — derived exclusively from safe characters — is used in the DB query.  This
    // breaks the taint chain: the query value is a new string produced by the regex
    // engine from safe character matches, not the original tainted input.
    // Only coerce to string for a primitive referrerId; objects (e.g. with a custom
    // toString) are rejected by the regex and result in safeReferrerId=null.
    const referrerIdPrimitive = (typeof referrerId === 'string' || typeof referrerId === 'number')
      ? String(referrerId) : '';
    const SAFE_ID_CAPTURE = /^([a-zA-Z0-9_-]{1,128})$/;
    const idMatch = SAFE_ID_CAPTURE.exec(referrerIdPrimitive);
    const safeReferrerId = idMatch ? idMatch[1] : null;

    if (!safeReferrerId) {
      logger.warn(
        `[ReferralCalc] referrerId contains unsafe characters — skipping payout history lookup ` +
        `referrer=${referrer.username} period=${periodKey}`
      );
    }

    const paidPayoutsForReferrer = safeReferrerId
      ? await ReferralPayout.find({
          periodKey,
          referrerUserId: safeReferrerId,
          status: 'paid'
        }).lean()
      : [];

    // settlementByReferred: Map<referredUserId, { settledRevenue, settledCommission }>
    // Helper: compute cumulative settled amount from a single payout detail entry
    const cumulative = (already, delta) => (already || 0) + (delta || 0);

    const settlementByReferred = new Map();
    for (const payout of paidPayoutsForReferrer) {
      const perReferredDetails = payout.details?.perReferredDetails;
      if (!Array.isArray(perReferredDetails)) continue;
      for (const detail of perReferredDetails) {
        if (!detail.referredUserId) continue;
        const cumRevenue = cumulative(detail.alreadySettledRevenue, detail.newDeltaRevenue);
        const cumCommission = cumulative(detail.alreadySettledCommission, detail.newDeltaCommission);
        const prev = settlementByReferred.get(detail.referredUserId);
        // Take the entry with the highest cumulative revenue.
        // If revenue is equal, prefer the entry with higher settled commission
        // (tie-breaker for duplicate or concurrent payout records).
        if (!prev || cumRevenue > prev.settledRevenue ||
            (cumRevenue === prev.settledRevenue && cumCommission > prev.settledCommission)) {
          settlementByReferred.set(detail.referredUserId, {
            settledRevenue: cumRevenue,
            settledCommission: cumCommission
          });
        }
      }
    }

    logger.info(
      `[ReferralCalc] paidPayoutsLoaded=${paidPayoutsForReferrer.length} ` +
      `referrer=${referrer.username} period=${periodKey} ` +
      `referredsWithSettlement=${settlementByReferred.size}`
    );
    // ─────────────────────────────────────────────────────────────────────────

    for (const referredUser of usersReferredByThisReferrer) {
      results.referredsProcessed++;

      // Verificar exclusión
      if (referredUser.excludedFromReferral) {
        logger.info(`[ReferralCalc] Usuario ${referredUser.username} excluido de referidos`);
        results.commissionsExcluded++;

        results.details.push({
          referredUsername: referredUser.username,
          referrerUsername: referrer.username,
          totalOwnerRevenue: 0,
          commissionAmount: 0,
          status: 'excluded',
          reason: 'Usuario marcado como excluido del sistema de referidos'
        });

        if (!dryRun) {
          // Find existing record first so we can preserve its id on update.
          const excludedExisting = await ReferralCommission.findOne({
            periodKey, referredUserId: referredUser.id
          }).lean();
          const excludedId = excludedExisting?.id || uuidv4();
          // Use $set so stale excluded records are corrected (data is always refreshed).
          // The id is included in $set to ensure it is always present, whether inserting or updating.
          await ReferralCommission.findOneAndUpdate(
            { periodKey, referredUserId: referredUser.id },
            {
              $set: {
                id: excludedId,
                periodKey,
                referrerUserId: referrerId,
                referrerUsername: referrer.username,
                referredUserId: referredUser.id,
                referredUsername: referredUser.username,
                currency: 'ARS',
                totalBets: 0,
                totalWins: 0,
                totalGgr: 0,
                totalOwnerRevenue: 0,
                referralRate,
                commissionAmount: 0,
                providersBreakdown: [],
                status: 'excluded',
                calculatedAt: new Date()
              }
            },
            { upsert: true, new: true }
          ).catch(err => {
            if (err.code !== 11000) {
              logger.error(`[ReferralCalc] Error guardando excluded para ${referredUser.username}:`, err.message);
            }
          });
        }
        continue;
      }

      // Verificar si ya existe comisión para este período y usuario referido.
      // Se consulta siempre (tanto en preview como en calculate) para poder hacer upsert correcto.
      const existing = await ReferralCommission.findOne({
        periodKey,
        referredUserId: referredUser.id
      }).lean();

      const existingCalculationFound = !!existing;
      const existingIsPaid = existingCalculationFound && existing.status === 'paid';
      // Will replace when: not dryRun and record exists (paid records get delta recalculation).
      const existingCalculationWillBeReplaced = existingCalculationFound && !dryRun;

      logger.info(
        `[ReferralCalc] mode=${mode} period=${periodKey} referrer=${referrer.username} ` +
        `referredUser=${referredUser.username} ` +
        `existingCalculationFound=${existingCalculationFound} ` +
        `existingIsPaid=${existingIsPaid} ` +
        `existingCalculationWillBeReplaced=${existingCalculationWillBeReplaced} ` +
        `calculationSource=fresh`
      );

      // Revenue real en 1girox: se pide por USERNAME (Partner API v1.9). El netwin
      // que vuelve es el de ESE jugador, no el agregado del agente. El pre-fetch de
      // arriba ya lo trajo en tandas de 100; acá sólo se lee del Map.
      revenueLookups++;

      // Fallback defensivo por si el usuario no entró en ninguna tanda (no debería
      // pasar para no-excluidos): una consulta individual, contada como request.
      let revenueResult = revenueByReferredId.get(referredUser.id);
      if (!revenueResult) {
        providerCallsCount++;
        revenueResult = await fetchReferredRevenue(referredUser, periodKey, fromDate, toDate);
      }

      // El ID numérico ya no se necesita para calcular, pero la API lo devuelve y el
      // panel lo muestra en el detalle: se conserva para trazabilidad.
      const giroxUserId = revenueResult.giroxUserId || referredUser.giroxUserId || null;

      logger.info(
        `[ReferralCalc] Revenue (pre-fetch) | mode=${mode} referido=${referredUser.username} ` +
        `giroxUserId=${giroxUserId} período=${periodKey} revenueLookups=${revenueLookups} ` +
        `providerCallsCount=${providerCallsCount} ` +
        `revenueScope=perUser commissionCalculationMode=individual_revenue`
      );

      if (!revenueResult.success) {
        // El error viene con un `code` corto de la Partner API (http_401, rate_limited,
        // missing_in_batch…). No hay ya el diagnóstico de auth que traía JUGAYGANA.
        const providerCode = revenueResult.code || null;
        logger.error(
          `[ReferralCalc] Error revenue | referido=${referredUser.username} ` +
          `giroxUserId=${giroxUserId} período=${periodKey} error=${revenueResult.error}` +
          (providerCode ? ` providerCode=${providerCode}` : '')
        );

        // Razón descriptiva para el detalle del admin
        let reason = `Error consultando revenue: ${revenueResult.error}`;
        if (providerCode === 'missing_in_batch') {
          reason = '1girox no devolvió stats de este usuario (ni datos ni "no encontrado"). ' +
            'Reintentar el cálculo; si persiste, revisar el alta del jugador en la plataforma.';
        } else if (providerCode === 'rate_limited') {
          reason = 'La plataforma respondió 429 (límite de 60 req/min). Reintentar el cálculo en un minuto.';
        } else if (providerCode) {
          reason += ` | code=${providerCode}`;
        }

        results.errors.push({
          referredUsername: referredUser.username,
          giroxUserId,
          periodKey,
          error: revenueResult.error,
          providerCode
        });
        results.details.push({
          referredUsername: referredUser.username,
          referrerUsername: referrer.username,
          giroxUserId,
          periodKey,
          revenueOk: false,
          totalBets: 0,
          totalWins: 0,
          totalGgr: 0,
          totalOwnerRevenue: 0,
          commissionAmount: 0,
          status: 'error',
          reason,
          providerCode
        });
        continue;
      }

      const { totalOwnerRevenue, totalBets, totalWins, totalGgr, providers } = revenueResult;

      // ── Incremental settlement: delta calculation ─────────────────────────────
      // Primary source: payout history ledger (paidPayoutsForReferrer, built above).
      // This is authoritative and resilient to multiple calculate() runs because it
      // reads directly from persisted ReferralPayout documents rather than from
      // the mutable ReferralCommission.settledOwnerRevenue field.
      //
      // Fallback: ReferralCommission.settledOwnerRevenue (for backward compatibility
      // with payouts created before the perReferredDetails field was introduced, and
      // for any edge case where the payout document lacks that sub-structure).
      const historySettlement = settlementByReferred.get(referredUser.id);
      let alreadySettledRevenue = historySettlement?.settledRevenue || 0;
      let alreadySettledCommission = historySettlement?.settledCommission || 0;
      // Track how the settlement baseline was resolved (for logging and debugging)
      let settlementSource = historySettlement ? 'payoutLedger' : 'none';

      // Second fallback: if payout history has no entry for this referred user but the
      // commission record itself carries settled amounts (e.g. old payouts without
      // perReferredDetails, or the current record was freshly marked 'paid'), use them.
      if (alreadySettledRevenue === 0 && existing) {
        const fallbackRevenue = existing.settledOwnerRevenue || 0;
        if (fallbackRevenue > 0) {
          alreadySettledRevenue = fallbackRevenue;
          alreadySettledCommission = existing.settledCommissionAmount || 0;
          settlementSource = 'commissionFallback';
          logger.info(
            `[ReferralCalc] settlementFallbackUsed=true referido=${referredUser.username} ` +
            `fallbackSettledRevenue=${fallbackRevenue.toFixed(2)} period=${periodKey} ` +
            `referrerUserId=${referrerId} referredUserId=${referredUser.id}`
          );
        }
      }

      // Third fallback: legacy payout without perReferredDetails — use the commission's
      // payoutId to find the matching paid payout and reconstruct the settlement baseline.
      // This handles the case where: (a) the startup backfill migration could not run or
      // failed for this record, AND (b) settledOwnerRevenue is still 0. The commission's
      // payoutId field is set during every payout (old and new) and is preserved across
      // subsequent calculate() runs because the update $set does not include payoutId.
      if (alreadySettledRevenue === 0 && existing && existing.payoutId) {
        const matchingPayout = paidPayoutsForReferrer.find(p => p.id === existing.payoutId);
        if (matchingPayout && matchingPayout.totalCommissionAmount > 0) {
          const commissionIds = matchingPayout.details?.commissionIds;
          const N = Array.isArray(commissionIds) ? commissionIds.length : 0;
          const rate = existing.referralRate || referralRate;
          if (N > 0 && rate > 0) {
            let estimatedSettledCommission;
            if (N === 1) {
              // Exact reconstruction for single-commission payouts
              estimatedSettledCommission = matchingPayout.totalCommissionAmount;
            } else {
              // For multi-commission payouts the exact per-user commission amounts at payout
              // time are no longer available (the commissionAmount field is overwritten by each
              // Calculate run). Equal share is used here as a conservative lower bound.
              // Note: the startup backfill migration (backfillLegacyPayoutSettlements) reaches
              // this branch first and uses a revenue-proportional split which is more accurate.
              // The inline fallback here only fires when that migration was skipped or failed for
              // this specific record, so equal share is an acceptable safety-net approximation.
              estimatedSettledCommission = matchingPayout.totalCommissionAmount / N;
            }
            alreadySettledRevenue = estimatedSettledCommission / rate;
            alreadySettledCommission = estimatedSettledCommission;
            settlementSource = 'legacyPayoutReconstruction';
            logger.info(
              `[ReferralCalc] legacyPayoutFallbackUsed=true referido=${referredUser.username} ` +
              `payoutId=${existing.payoutId} ` +
              `totalPayoutAmount=${matchingPayout.totalCommissionAmount.toFixed(2)} ` +
              `commissionIdsInPayout=${N} rate=${rate} ` +
              `historicalPaidAmountByReferred=${estimatedSettledCommission.toFixed(2)} ` +
              `historicalSettledRevenueByReferred=${alreadySettledRevenue.toFixed(2)} ` +
              `historicalSettledCommissionByReferred=${alreadySettledCommission.toFixed(2)} ` +
              `period=${periodKey} referrerUserId=${referrerId} referredUserId=${referredUser.id}`
            );
          }
        }
      }

      logger.info(
        `[ReferralCalc] settlementBaseline referido=${referredUser.username} period=${periodKey} ` +
        `periodKey=${periodKey} referrerUserId=${referrerId} referredUserId=${referredUser.id} ` +
        `ledgerPayouts=${paidPayoutsForReferrer.length} ` +
        `historicalPaidAmountByReferrer=${paidPayoutsForReferrer.reduce((s, p) => s + p.totalCommissionAmount, 0).toFixed(2)} ` +
        `historicalSettledRevenueByReferred=${alreadySettledRevenue.toFixed(2)} ` +
        `historicalSettledCommissionByReferred=${alreadySettledCommission.toFixed(2)} ` +
        `settlementSource=${settlementSource}`
      );

      // Revenue not yet settled
      const newPendingRevenue = Math.max(0, totalOwnerRevenue - alreadySettledRevenue);
      // Commission on new pending revenue only (delta)
      const commissionAmount = newPendingRevenue > 0
        ? newPendingRevenue * referralRate
        : 0;

      const calculationWindowStart = alreadySettledRevenue > 0
        ? `after-settlement(${alreadySettledRevenue.toFixed(2)})`
        : 'full-period';

      logger.info(
        `[ReferralCalc] Revenue obtenido | referido=${referredUser.username} giroxUserId=${giroxUserId} ` +
        `netwin=${totalGgr?.toFixed(2)} ownerCommissionRate=${revenueResult.ownerCommissionRate} ` +
        `ownerRevenue=${totalOwnerRevenue?.toFixed(2)} ` +
        `alreadyPaidCommission=${alreadySettledCommission.toFixed(2)} ` +
        `alreadySettledRevenue=${alreadySettledRevenue.toFixed(2)} ` +
        `newPendingRevenue=${newPendingRevenue.toFixed(2)} ` +
        `pendingCommission=${commissionAmount.toFixed(2)} ` +
        `calculationWindowStart=${calculationWindowStart} ` +
        `calculationWindowEnd=period-end ` +
        `revenueScope=${revenueResult.revenueScope || 'perUser'} ` +
        `netwinScope=${revenueResult.netwinScope || 'casino'} ` +
        `revenueSourceField=${revenueResult.revenueSourceField || 'username'} ` +
        `notFoundInPlatform=${revenueResult.notFoundInPlatform === true} ` +
        `commissionCalculationMode=${alreadySettledRevenue > 0 ? 'delta_after_settlement' : 'individual_revenue'}`
      );
      // Mandatory per-referred audit log (matches problem-statement logging requirements)
      logger.info(
        `[ReferralCalc] perReferredAudit` +
        ` periodKey=${periodKey}` +
        ` referrerUserId=${referrerId}` +
        ` referredUserId=${referredUser.id}` +
        ` historicalPaidAmountByReferrer=${paidPayoutsForReferrer.reduce((s, p) => s + p.totalCommissionAmount, 0).toFixed(2)}` +
        ` historicalSettledRevenueByReferred=${alreadySettledRevenue.toFixed(2)}` +
        ` historicalSettledCommissionByReferred=${alreadySettledCommission.toFixed(2)}` +
        ` calculatedPendingRevenueByReferred=${newPendingRevenue.toFixed(2)}` +
        ` calculatedPendingCommissionByReferred=${commissionAmount.toFixed(2)}` +
        ` settlementSource=${settlementSource}` +
        ` stateRecoveredFromDatabase=true`
      );
      // ─────────────────────────────────────────────────────────────────────────

      // Status: calculated only if there is something to pay; skipped if zero revenue;
      // 'paid' kept for records where everything was already settled and revenue hasn't grown.
      // NOTE: when commissionAmount === 0 but totalOwnerRevenue > 0 it means the full period
      // revenue is already settled — we keep status='paid' so the record shows as fully settled
      // (not pending). This is correct: there is nothing new to pay for this commission record.
      const status = commissionAmount > 0
        ? 'calculated'
        : (totalOwnerRevenue <= 0 ? 'skipped' : 'paid');
      const reason = commissionAmount <= 0
        ? (totalOwnerRevenue <= 0
            ? (revenueResult.notFoundInPlatform
                // Se distingue del "$0 porque no jugó": acá 1girox directamente no
                // conoce al jugador (o no es de nuestro agente). Suele ser un alta
                // fallida y hay que arreglarla, no es un mes flojo.
                ? 'El jugador no existe en 1girox (o no pertenece a nuestro agente): se calculó con netwin $0. ' +
                  'Revisar el alta del usuario en la plataforma.'
                : `Revenue del período es $0 (GGR: $${(totalGgr ?? 0).toFixed(2)}, apuestas: $${(totalBets ?? 0).toFixed(2)}, ganancias: $${(totalWins ?? 0).toFixed(2)})`)
            : `Todo el revenue del período ya fue liquidado en un pago anterior (settledRevenue=$${alreadySettledRevenue.toFixed(2)})`)
        : null;

      const commissionData = {
        id: existing?.id || uuidv4(),
        periodKey,
        referrerUserId: referrerId,
        referrerUsername: referrer.username,
        referredUserId: referredUser.id,
        referredUsername: referredUser.username,
        currency: 'ARS',
        totalBets,
        totalWins,
        totalGgr,
        totalOwnerRevenue,
        referralRate,
        commissionAmount,
        settledOwnerRevenue: alreadySettledRevenue,
        settledCommissionAmount: alreadySettledCommission,
        providersBreakdown: providers || [],
        status,
        calculatedAt: new Date()
      };

      results.details.push({
        referredUsername: referredUser.username,
        referrerUsername: referrer.username,
        giroxUserId,
        periodKey,
        revenueOk: true,
        ownerCommissionRate: revenueResult.ownerCommissionRate,
        totalBets,
        totalWins,
        totalGgr,
        totalOwnerRevenue,
        alreadySettledRevenue,
        alreadySettledCommission,
        newPendingRevenue,
        referralRate,
        commissionAmount,
        status,
        reason: reason || undefined,
        notFoundInPlatform: revenueResult.notFoundInPlatform === true,
        isDelta: alreadySettledRevenue > 0
      });

      if (!dryRun) {
        if (existing) {
          const { status: _omit, ...dataWithoutStatus } = commissionData;
          await ReferralCommission.updateOne(
            { _id: existing._id },
            { $set: { ...dataWithoutStatus, status } }
          );
          if (alreadySettledRevenue > 0 && commissionAmount > 0) {
            logger.info(
              `[ReferralCalc] Delta commission calculated after last payment | mode=${mode} period=${periodKey} ` +
              `referrer=${referrer.username} referredUser=${referredUser.username} ` +
              `historicalCommission=${alreadySettledCommission.toFixed(2)} ` +
              `newCommissionSinceLastSettlement=${commissionAmount.toFixed(2)} ` +
              `alreadySettledRevenueFloor=${alreadySettledRevenue.toFixed(2)} newPendingRevenue=${newPendingRevenue.toFixed(2)} ` +
              `upsertPerformed=true paymentApplied=false`
            );
          } else {
            logger.info(
              `[ReferralCalc] Reemplazando cálculo previo | mode=${mode} period=${periodKey} ` +
              `referrer=${referrer.username} referredUser=${referredUser.username} ` +
              `upsertPerformed=true calculationSource=fresh existingCalculationFound=true ` +
              `finalCommission=${commissionAmount.toFixed(2)}`
            );
          }
        } else {
          await ReferralCommission.create(commissionData).catch(err => {
            if (err.code === 11000) {
              logger.warn(`[ReferralCalc] Conflicto de duplicado para ${referredUser.username} - ignorando`);
            } else {
              throw err;
            }
          });
          logger.info(
            `[ReferralCalc] Nuevo registro guardado | mode=${mode} period=${periodKey} ` +
            `referrer=${referrer.username} referredUser=${referredUser.username} ` +
            `upsertPerformed=true calculationSource=fresh existingCalculationFound=false ` +
            `finalCommission=${commissionAmount.toFixed(2)}`
          );
        }
      }

      if (status === 'calculated') {
        results.commissionsCreated++;
      } else {
        results.commissionsSkipped++;
      }
    }
  }

  logger.info(
    `[ReferralCalc] Período ${periodKey} | mode=${mode} providerCallsCount=${providerCallsCount} ` +
    `(requests reales a 1girox, tandas de ${STATS_BATCH_SIZE}) revenueLookups=${revenueLookups} ` +
    `netwinScope=${getNetwinScope()} ` +
    `commissionsCreated=${results.commissionsCreated} commissionsSkipped=${results.commissionsSkipped} ` +
    `commissionsExcluded=${results.commissionsExcluded} errors=${results.errors.length}`
  );

  if (!dryRun) {
    logger.info(`[ReferralCalc] calculate aligned with preview for period ${periodKey}`);
  }

  return results;
}

/**
 * Obtener resumen de comisiones pendientes por referidor para un período
 * @param {string} periodKey
 * @returns {Array}
 */
async function getPendingCommissionsSummary(periodKey) {
  return ReferralCommission.aggregate([
    { $match: { periodKey, status: 'calculated' } },
    {
      $group: {
        _id: '$referrerUserId',
        referrerUsername: { $first: '$referrerUsername' },
        totalCommission: { $sum: '$commissionAmount' },
        referralCount: { $sum: 1 }
      }
    },
    { $sort: { totalCommission: -1 } }
  ]);
}

module.exports = {
  calculateCommissionsForPeriod,
  getPendingCommissionsSummary
};
