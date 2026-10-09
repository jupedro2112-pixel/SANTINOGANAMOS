# CLAUDE.md — Contexto del proyecto SANTINOGANAMOS (clon de VIPCARGASANTINO para GANAMOS)

> 🟢 **ESTE REPO ES GANAMOS — PLATAFORMA SIN API (MODO MANUAL, #190, 2026-09-29).**
> Clon de VIPCARGASANTINO para la sala GANAMOS, que hoy opera por WhatsApp y **no
> expone API**: el cliente pide cargar/retirar por el chat de la web y **un agente lo
> ejecuta a mano en el panel de GANAMOS**. `PLATFORM_MODE=manual` (default) hace que
> `src/services/platformService.js` entregue **`ganamosPlatformService`** (mismo
> contrato que `giroxService`) y que cada carga/retiro/bono sea una **`PlatformTask`**:
> las del agente nacen `done`; las que genera el server solo (hgcash, ruleta,
> fueguito, VIP, lotes…) quedan `pending` en la sección **"⏳ Pendientes GANAMOS"**
> del panel hasta que un agente las marca hechas (el cliente recibe
> `/sys_ganamos_acreditado`). Sin saldo, sin SSO (CASINO abre `GANAMOS_PLAY_URL` en
> pestaña), **SIN reembolsos por netwin, SIN niveles VIP/rakeback y SIN rollover de bonos**
> (#196: todo eso se eliminó de la PWA y se cierra/oculta en backend y panel en modo
> manual — no volver a mencionarlos en ningún texto al cliente; la ÚNICA excepción es el
> **reembolso semanal por planilla**, #215, ver gotchas), registro público
> apagado (alta por agente con el MISMo username que en GANAMOS). **Leer `docs/ARCHITECTURE.md` §0 antes de tocar
> cualquier flujo de plata.** Todo lo que sigue sobre "1girox" es el diseño heredado
> (sigue vigente como modelo de flujos; el cliente real de 1girox queda para
> `PLATFORM_MODE=girox`). Test del adaptador: `node scripts/test-ganamos-adapter.js`.
> 
> 🚫 **NO existe modo con API de GANAMOS.** Hubo un `PLATFORM_MODE=ganamos_api` (#191–#193,
> cliente contra `agents.ganamos.co`) y se ELIMINÓ el 2026-09-29 (#194): GANAMOS bloquea
> esa API con Cloudflare + un desafío JS de Servicepipe y no se va a saltear. El único
> modo operativo de este repo es `manual`; `girox` queda para volver a 1girox. Si
> alguien pide "automatizar contra GANAMOS", la respuesta es: no hay acceso oficial.

> ⚠️ **LEER PRIMERO (continuidad entre sesiones).** El owner trabaja en **Tails sin
> almacenamiento persistente**: al reiniciar la PC se borra TODO lo local y vuelve a
> clonar este repo desde GitHub. Por eso el contexto vive ACÁ (en el repo), no en la
> memoria local del asistente.
>
> **REGLA PERMANENTE (los 3 docs vivos):** tras cada cambio significativo (feature,
> fix importante, decisión de diseño) mantené actualizados:
>   1. `WORKLOG.md` — QUÉ se hizo y por qué (diario de sesiones, entrada numerada).
>   2. `docs/ARCHITECTURE.md` — CÓMO funciona (si el cambio altera un flujo, modelo,
>      endpoint o agrega una trampa nueva, reflejalo ahí; corregí lo que quede stale).
>   3. `CLAUDE.md` (este archivo) — solo si cambió algo del CONTEXTO de arranque
>      (estructura, gotchas de primer nivel, reglas de trabajo).
> Commiteá y pusheá a GitHub para que la próxima sesión pueda seguir donde se dejó.
> Esta regla aplica siempre, sin que el owner tenga que pedirlo cada vez. El objetivo:
> que una sesión nueva en Tails sepa TODO leyendo estos docs, sin re-analizar el repo.
>
> Al iniciar una sesión nueva: leé `WORKLOG.md` (estado actual) y `docs/ARCHITECTURE.md`
> (mapa completo de modelos, flujos, front y trampas — actualizado 2026-07-09 tras una
> lectura de punta a punta del repo). Antes de modificar un flujo central, leé además
> el código puntual del área. El código es la verdad; los docs son el mapa.

---

## Qué es

Backend de una **sala de juegos** (mercado argentino) que opera como wrapper sobre la
plataforma externa **1girox** (Partner API REST/JSON; panel en `admin.1girox.com`).
Capta usuarios, los crea en la plataforma por API, gestiona cargas/retiros vía CBU,
reembolsos, ruleta, fueguito, referidos y campañas/publicistas. UX en PWA con
notificaciones push (FCM).

> **Migración 2026-07-31:** antes el wrapper era sobre **JUGAYGANA**
> (`admin.agentesadmin.bet`). Los 4 clientes viejos (`jugaygana.js`,
> `jugaygana-movements.js`, `src/services/jugayganaService.js`,
> `jugayganaPublisherSessions.js`) + `referralRevenueService.js` y
> `jugayganaUserLinkService.js` **siguen en el repo pero YA NADIE los importa**: se
> conservan sólo para poder revertir. No agregarles features ni tomarlos de referencia.

**Stack:** Node 20 · Express · MongoDB (Atlas) · Mongoose · Socket.IO (+ Redis adapter
para multi-instancia en AWS EB) · Firebase Admin (FCM) · AWS SNS (SMS OTP).
Deploy: AWS Elastic Beanstalk. Dominio público: vipcargas.com. Git user: jupedro2112-pixel.

## Estructura

- `server.js` (~15.7k líneas) — entry point. ~180 rutas, authMiddleware inline (~L2477),
  Socket.IO (~L7325), motores cron por setInterval (~L14100+), bootstrap async con SSM
  (final del archivo). Comentario dice "en migración" pero en la práctica sigue
  creciendo acá. (Los números de línea derivan con cada cambio — usar grep.)
- `config/database.js` — el `connectDB` que server.js realmente usa (TTL de mensajes,
  proxy a /src/models). **OJO: hay DOS connectDB** (este y `src/models/index.js`); el
  segundo NO se usa desde server.js. No tocar schemas en config/database.js (sólo
  define ExternalUser y UserActivity; el resto es proxy a /src/models).
- `src/services/platformService.js` — **SELECTOR** del cliente de plataforma
  (`PLATFORM_MODE`): `ganamosPlatformService.js` (manual, default — registra
  `PlatformTask`, sin API) o `giroxService.js` (Partner API de 1girox). Sólo esos dos. **Requerir
  siempre el selector, nunca giroxService directo.**
- `src/services/giroxService.js` — cliente de la Partner API de 1girox (altas, saldo,
  cargas, retiros, bonos, cambio de clave y login único/SSO). Sólo con `PLATFORM_MODE=girox`.
- `src/services/ganamosPlatformService.js` + `src/models/PlatformTask.js` — adaptador
  manual y bandeja "Pendientes GANAMOS" (#190). Opciones extra del contrato:
  `agentExecuted`, `agentName`, `flow`, `meta`.
- `src/services/giroxUserLinkService.js` — resuelve y cachea `User.giroxUserId`.
- `src/services/giroxPublisherKeys.js` — alta de jugadores con la API key del publicista.
- `src/utils/periodRanges.js` — rangos de fecha (ayer / semana / mes) en hora argentina.
- `jugaygana*.js` + `referralRevenueService.js` + `jugayganaUserLinkService.js` —
  **muertos**, sin consumidores. Ver la nota de migración arriba.
- `src/models/` — schemas Mongoose canónicos (fuente de verdad). Banco: BankMovement,
  BankSweep (bajadas), DailyClose (cierre), CashierSnapshot (saldo cajero 1girox — hoy
  vacío, la API no lo informa).
- `src/services/` — lógica (referidos, notificaciones, otp, metaCapi, fbAds, hgcash,
  comprobantes IA, analítica publicistas…).
- `public/` — PWA del cliente (namespace global `window.VIP`, SW único
  `firebase-messaging-sw.js`). `public/adminprivado2026/` — panel admin (~12k líneas
  de admin.js, cookie httpOnly, SW propio `admin-sw.js` con scope /adminprivado2026/).

## Cosas que NO hay que romper (gotchas)

- **JWT_SECRET y otros secrets** se cargan desde AWS SSM en el bootstrap async, NO al
  `require()`. Por eso hay lazy getters en `src/middlewares/auth.js` y rutas.
- **IDEMPOTENCIA POR `reference` (lo más importante de la plataforma nueva).** Cargas,
  retiros y bonos llevan una `reference` única por operación. Reintentar con la MISMA
  no duplica (la API devuelve `duplicate:true`). Se rompe plata en las dos direcciones:
  si dos operaciones DISTINTAS comparten reference, la segunda **no se acredita** (el
  cliente transfiere y no recibe fichas); si la reference **cambia** entre reintentos
  del mismo pago, se paga **dos veces**. Por eso cada flujo la deriva de una llave que
  ya es única y estable (id de Transaction, periodKey del reembolso, movimiento
  bancario, id del giro/payout). Ver la tabla de prefijos `vip-*` en ARCHITECTURE §.
- **Rate limit: 60 req/min** en la Partner API. Hay un limitador local (`GIROX_MAX_RPM`,
  default 55) pero es **por proceso** → con N instancias en EB el techo real es N×55 y
  el 429 sigue siendo posible (se reintenta respetando `Retry-After`).
- **Rollover ACTIVO en la plataforma:** el jugador puede tener saldo que NO puede
  retirar. Validar retiros contra `wagering.available`, **nunca** contra `balance`.
- **El netwin sale de la Partner API** (`GET /players/{username}/stats`, v1.8), por
  username y con la misma API key. ⚠️ `netwin` POSITIVO = el jugador PERDIÓ (es la base
  del reembolso); negativo = ganó. Máximo 92 días por consulta, y el rango se evalúa
  en hora argentina del lado de la plataforma. Para varios jugadores está el batch
  (`POST /players/stats/batch`, hasta 100) — es lo que hace viable el cálculo de
  comisiones de referidos sin comerse el límite de 60 req/min.
- **Reembolsos por RANGO** (Bronce 3% / Plata 6% / Oro 10%), según lo perdido EN EL
  PERÍODO que se reclama — no un acumulado. Ver `src/utils/refundTiers.js`. Desde
  2026-09-11 la base del período es `casinoNetwin − bonus.granted` y se descuenta
  lo ya cobrado como reembolso en vivo.
- **REEMBOLSO EN VIVO acumulativo (2026-09-11):** espec en
  `docs/ESPEC-REEMBOLSO-1GIROX.md` (leerla antes de tocar reembolsos). Fórmula pura
  en `src/utils/cashbackFormula.js` + test `scripts/test-cashback-formula.js`
  (correrlo tras cualquier cambio); motor `_cashbackStateToday` en server.js; modelo
  `CashbackClaim`; reference `vip-cbk-<userId>-<día>-<seq>`. La base descuenta
  TODO lo regalado (incluidos los reembolsos ya cobrados) → todo regalo nuevo tiene
  que quedar en Transaction con tipo de regalo o en `deposit.bonus`. Config en el
  panel (`Config['instantCashback']`, default apagado).
- **Regalos = BONO 0 "regalo directo" (2026-09-07, Partner API v1.10+/manual v1.15 en
  `docs/`):** `creditUserBalance` sin `multiplier` va por `POST /players/{u}/bonus`
  con `multiplier: 0` → disponible/retirable al instante, SIN reclamo, NO pisa el bono
  en curso, y en el panel de 1girox figura como **Bono** (antes iba por `/deposit` y
  reembolsos/ruleta/rakeback/VIP/referidos salían como "Carga"). Fallback automático
  a depósito libre con la MISMA reference si el bono suelto está apagado, 0 no está
  permitido o el monto sale de `fixed_min/fixed_max`. Kill switch `GIROX_GIFT_AS_BONUS=0`.
  Un `multiplier` EXPLÍCITO (>0) sí usa `/bonus` con rollover: puede quedar "a reclamar"
  (`girox.claimPendingBonus()`) y PISA un bono activo. El **fueguito** con rollover >0
  va por `/bonus` con ese multiplier (`_creditFireReward`) salvo que el jugador ya
  tenga bono activo → cae al depósito con `multiplier` de antes. **La ruleta escribe
  `Transaction type:'roulette'`**; tipo de Transaction nuevo ⇒ etiqueta + filtro +
  case del resumen en el panel (§6 de ARCHITECTURE). La devolución de retiro
  rechazado sigue como depósito (no es regalo).
- **REEMBOLSO SEMANAL POR PLANILLA (#215, 2026-10-02) — el único reembolso de GANAMOS:**
  el admin general sube la planilla de la semana (Type | User | Amount) en el panel →
  "Reembolsos semanales"; el server calcula por usuario `neto = cargas − retiros` → rango
  → % (`src/utils/weeklyRefund.js`, rangos en `Config['weeklyRefund']`). El cliente lo
  RECLAMA en la app dentro de `/sys_refund_claim_hours` (default 48 h) → `creditGift` con
  reference `vip-wrf-<semana>-<usuario>` (PlatformTask pendiente) → el agente lo carga en
  GANAMOS y toca "Marcar como entregado" → `/sys_refund_delivered`. Modelos `RefundBatch`
  + `WeeklyRefund`. Detalle en ARCHITECTURE §0.1. Tras tocarlo correr
  `node scripts/test-weekly-refund.js` y `node scripts/test-weekly-refund-flow.js` (este
  ejecuta el bloque REAL de server.js contra una base falsa: no mover sus comentarios-marca).
  Los comandos `/sys_refund_*` son los ÚNICOS que pueden decir "reembolso".
- **GANAMOS NO TIENE ROLLOVER NI REEMBOLSOS POR NETWIN (#196, 2026-09-29):** en modo manual
  `PLATFORM_NO_ROLLOVER` apaga el rollover global (x0 fijo, ignora la Config),
  `_rolloverNoteText` devuelve '' y el adaptador fuerza x0; reembolsos/cashback/
  rakeback/VIP: endpoints de reclamo 404, crons cortados, seeds y PWA sin esos
  textos, panel con `body.platform-manual`. Un texto nuevo al cliente NO puede
  decir "rollover", "rakeback" ni "nivel VIP" (ni "reembolso", salvo el semanal por
  planilla de arriba). La migración del boot pisa los `/sys_*` que todavía los
  mencionen (saltea `/sys_refund_*`). Todo lo de abajo sobre rollover y
  reembolsos aplica sólo a `PLATFORM_MODE=girox`.
- **ROLLOVER GLOBAL de bonos (2026-09-16):** espec en
  `docs/ESPEC-ROLLOVER-GLOBAL-Y-MULTICUENTA-TITULAR.md`. Se aplica en el CLIENTE
  (`giroxService`: `creditGift`, `creditUserBalance` con multiplier, `bonus_multiplier`
  de `depositToUser`) con un resolver inyectado desde server.js; default ENCENDIDO x3
  (decisión del owner 2026-09-16: TODO con x3; x3 habilitado en la cuenta). Un bono
  nuevo no resuelve el
  rollover a mano; solo referidos y devoluciones pasan `ignoreGlobalRollover:true`.
  Test en frío: `node scripts/test-rollover-multicuenta.js`. La misma espec (§B)
  cruza el TITULAR del comprobante (`Comprobante.originHolderKey`) contra otras
  cuentas: avisa, no bloquea.
- **Ruleta diaria y bono por instalar (2026-09-18):** los premios de la ruleta
  (tipo dinero/bonificación %, valor, rollover, peso) y la elegibilidad (cargas
  mínimas en 30 días, app requerida) viven en `Config['dailyRoulette']`; la regla
  del bono por instalar (% hasta un tope + % del excedente) en `Config['installBonus']`.
  No hardcodear "100%", "$5.000" ni "10 cargas": salen de la config y de las variables
  `{pct} {tope} {excedente} {regla}` de `/sys_install_bonus`. Desde #211 la regla también
  se edita en COMANDOS (`/sys_install_bonus_pct|_tope|_excedente`, mandan sobre la Config). Un premio "%" de la
  ruleta y el bono de instalación los APLICA EL SERVER solo en la carga (hgcash y
  manual, pisando el bono del agente si hay pendientes; nunca en multicuenta) vía
  `_pendingBonusFor` + `_settlePendingBonuses`. Un flujo de carga nuevo tiene que
  pasar por ahí.
- **Lotes con % (#198, réplica #172/#173 del gemelo, 2026-09-29):** el % de un lote lo
  aplica el SISTEMA en la carga (manual y hgcash) vía `_pendingBonusFor` con el
  MISMO tope del bono app (`_loteBonusAmount`: % hasta `capArs`, excedente al
  `excessPct`, `Config['installBonus']`); `_settlePendingBonuses` lo marca usado
  (`PromoBonus.bonoMonto`). Con código, el bono canjeado vence a las
  `NotifBatch.useHours` (default 24) del canje, no al vencer el lote. No hay
  franja horaria ni `applyMode` acá (eso es del gemelo).
- **Pushes de RULETA: candado APAGADO (#209, 2026-09-30):** `notificationService.ROULETTE_PUSH_BLOCKED = false`
  (la ruleta está activa y el owner quiere avisos de giro). Si se vuelve a poner en `true`,
  `isRouletteText` bloquea las 5 funciones de envío y el seed migra reglas guardadas.
- **RECORDATORIOS SIN REGALOS (#209):** `src/services/recordatoriosService.js` +
  `Config['recordatorios']` (panel → Inactivos, card "Recordatorios automáticos"): pushes
  de texto para inactivos (días sin entrar), "tu giro ya está disponible" y "tu premio
  vence pronto". NUNCA crea PromoBonus ni acredita. Los motores con BONOS
  (`INACTIVIDAD_DISABLED`, `BONUS_STRATEGY_DISABLED`, `CHARGE_BONUSES_DISABLED`)
  siguen APAGADOS: el owner los pausó porque "regalaba bonos a todos por todos lados".
- **Ruleta diaria = CON RECLAMO y vencimiento (#197, 2026-09-29):** ningún premio se
  acredita solo. Nace `claim_pending` y el cliente tiene las horas del comando
  `/sys_roulette_claim_hours` (COMANDOS, default 24) para tocar RECLAMAR en la app, si
  no pasa a `expired` (barrido perezoso `_rouletteExpireStale`, sin cron). Elegibilidad
  (#200): `minCargas30d` en `minCargasDays`, `spinsPerDay` (índice único
  userId+dateKey+seq) y `testUsers` que giran sin app para probar como cliente. Dinero
  reclamado → `creditGift` (manual: PlatformTask pendiente, spin `claimed` →
  `credited` cuando el agente marca ✅; el listener de tareas lo refleja). % reclamado
  → `percent_pending` en el usuario (se aplica en su próxima carga o "Marcar aplicado"
  en el panel). Requisito: app instalada con notificaciones (`requireApp`); sin eso la
  PWA muestra la celda bloqueada "Instalá la app". Mensajes: `/sys_roulette_won`,
  `/sys_roulette_claimed`.
- **Username tomado en 1girox por OTRA estructura** (2026-09-07):
  `syncUserToPlatform` devuelve `code:'username_taken_foreign'` y TODAS las altas
  rebotan sin dejar cuenta local (una cuenta así "vinculada" es inoperable para
  siempre: username nuevo).
- **Roles:** `user`, `admin` (todo), `depositor` (solo cargas), `withdrawer` (solo
  retiros), `publisher_admin` (solo crea usuarios de su publicista — lockdown via
  `PUBLISHER_ADMIN_ALLOWED_PATHS`).
- **Auth:** JWT por header Authorization O por cookie httpOnly `admin_api_session`
  (el panel admin usa cookie).
- **CORS (#219):** el MISMO origen siempre pasa (`corsOriginAllowed`: host del `Origin` ==
  `Host` del request); `ALLOWED_ORIGINS` es sólo para orígenes distintos. No volver a una
  allowlist pura: el sitio se bloquea a sí mismo (login "Algo salió mal") en cualquier
  dominio no listado. El adapter de Redis usa el canal `socket.io:<dominio>` para no
  cruzar eventos con otro proyecto que comparta el Redis.
- **SIN REFERIDOS en GANAMOS (#207, 2026-09-30):** en modo manual `/api/referrals/*`
  da 404, la PWA no tiene menú/modal/cards de referidos y el panel los oculta. El
  sistema (referralRate.js con `/sys_referral_pct`, controlador, payouts) queda sólo
  para `PLATFORM_MODE=girox`. No agregar textos de referidos al cliente.
- **EQUIPOS por inicio del usuario (#212–#214, #224):** `Config['teams']` (panel → COMANDOS →
  card Equipos): prefijo → WhatsApp y Telegram (comunidad) del equipo, + un general.
  El link de comunidad sale SIEMPRE de `_communityChannelResolved` / `_communityChannelUrl`
  (equipo → general → card Comunidad): lo usan `/api/config/community` y
  `/go/comunidad?u=<username>`. El cartel del login (`/api/config/team`) da SÓLO WhatsApp
  (equipo o general), nunca la comunidad (decisión del owner, #214). Nunca leer
  `communityConfig.channelUrl` directo para mandar a un cliente a la comunidad: terminaría
  en la de otro equipo. Con sesión se usa `resolveTeamForUsername` (estricta);
  `resolveTeamLoose` es sólo para el login. La comparación del inicio es CANÓNICA
  (`_teamNorm`: sin acentos, minúsculas, sólo letras/números → `MAR_juan` es de `mar`);
  no volver a comparar texto crudo. Un equipo SIN Telegram en su fila manda a sus clientes
  al general: si "todos caen en la misma comunidad", probarlo con "🔎 Probar con un
  usuario" en la card (`/api/admin/teams/resolve`) y mirar `[teams] comunidad para …` en el
  log. `req.user.username` es el de la BASE (no el del token).
- **Ruleta = ventana de 24 h REALES desde el último giro (#208):** `_rouletteSpinWindow`;
  no se renueva a las 00:00. `spinsPerDay` = giros por ventana.
- **Mensajes automáticos al usuario** son editables desde la sección COMANDOS
  (comandos `/sys_*`). Usar el helper `renderSystemCommand(name, fallback, vars)` para
  cualquier mensaje automático nuevo.
- **Transaction** (cargas/retiros) es permanente (sin TTL). **Message** tiene TTL de 3
  días. La analítica de clientes se basa en Transaction.
- **Montos en PESOS.** ⚠️ Ojo si mirás código o docs viejos: JUGAYGANA trabajaba en
  centavos y todo se multiplicaba ×100. **1girox NO** — se manda el monto tal cual, con
  decimales si hace falta. Multiplicar por 100 sería cargar 100 veces de más.
- **No hay NINGUNA sesión que renovar.** Auth por `X-Api-Key` fija en todo, incluido
  el netwin. Se fueron `ensureSession`, el mutex de login, `isHtmlBlocked` y el Bearer
  del panel (con `giroxReportsService`, eliminado el 2026-07-31).
- **Bonos automáticos APAGADOS por flags** (owner 2026-06-24): `INACTIVIDAD_DISABLED`
  y `BONUS_STRATEGY_DISABLED` (server.js) + `CHARGE_BONUSES_DISABLED`
  (notificationRulesService) + bonos de encuesta con `bDays=[]`. Tope 30% en TODO lo
  automático (cap de lectura en `_getActivePromoBonus` incluido).
- **Bandeja del banco / cierre diario (#183, réplica 1:1 del #155 del gemelo
  AUTOREEMBOLSOS):** una transferencia hgcash = UNA acreditación. Toda carga que venga
  del banco deja el vínculo en las dos direcciones (`BankMovement.transactionId` +
  `chargeSource` y `Transaction.metadata.movementId`), y la carga ASIGNADA desde la
  bandeja va SIEMPRE por `hgcashAutoCarga({assign})` (misma reference `vip-hg-*`, mismo
  candado por coelsa). Si no, el cierre diario (`src/services/bankCloseService.js`,
  Telegram 00:05 ART) lo marca. Mismos nombres de modelos/endpoints/funciones del panel
  que el gemelo: no renombrar. El cruce con el cajero queda `sin_datos` hasta que 1girox
  informe el saldo del agente.
- **hgcash: token/secreto/reenvío pueden venir del PANEL (#223):** `Config['hgcashCredentials']`
  (cifrado con `JWT_SECRET`) y `Config['hgcashFanout']` mandan sobre SSM. Leer SIEMPRE con
  `hgcashPay.getToken()` / `_hgcashWebhookSecrets()` / `_getHgcashFanout()`, nunca
  `process.env.HGCASH_*` directo. Cambiar `JWT_SECRET` invalida lo guardado en el panel.
- **Multi-instancia (AWS EB):** los crons son `setInterval` en CADA instancia; su
  idempotencia depende de índices únicos (EncuestaFire.slotKey, InactividadFire.fireKey,
  HgcashCharge.chargeKey, RecordatorioFire.fireKey, DailyRouletteSpin
  userId+dateKey+seq, RefundBatch.activeKey, WeeklyRefund batchId+usernameLower).
  No quitar esos índices.
- **Front frágil:** cientos de `onclick` inline dependen de funciones en `window.*`
  (no renombrar exports sin actualizar el HTML/strings). Tabla de usuarios del panel
  acoplada a `USERS_LIST_FIELDS` del backend (columna nueva ⇒ sumar campo al select).
  Detalle completo de trampas en `docs/ARCHITECTURE.md` §9.

## Flujo de trabajo del asistente

1. Leer `WORKLOG.md` al iniciar.
2. Hacer el cambio. Validar sintaxis (`node --check` en archivos tocados), **si se
   tocó el adaptador o el contrato de plataforma correr `node scripts/test-ganamos-adapter.js`**, **si se tocó
   el reembolso semanal correr `node scripts/test-weekly-refund.js` y
   `node scripts/test-weekly-refund-flow.js`**, **y, si se
   tocó `server.js`, correr `node scripts/check-tdz.js`** (detecta usos de nivel
   superior antes de su `require` y rutas antes de `const authMiddleware`: `node
   --check` NO los ve y tumban el server al arrancar — pasó el 2026-09-16). No hay
   node_modules local, así que no se puede correr el server; sólo syntax check).
3. Actualizar `WORKLOG.md` SIEMPRE y en el mismo cambio, y `CLAUDE.md` /
   `docs/ARCHITECTURE.md` cuando lo hecho cambia el contexto, un flujo o una trampa.
   Es AUTOMÁTICO: el owner no lo tiene que pedir (reiterado el 2026-10-01). Si al leer
   los docs aparece algo desactualizado, corregirlo en el momento.
4. Commitear y pushear a `main` AUTOMÁTICAMENTE después de cada cambio terminado y
   validado, sin esperar a que el owner lo pida (autorizado el 2026-10-01: trabaja en
   Tails y lo que no se pushea se pierde al reiniciar). Si una validación falla, NO
   pushear: avisar primero.
