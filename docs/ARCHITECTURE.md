# ARCHITECTURE — Cómo funciona VIPCARGASANTINO

> Mapa arquitectónico para entender el repo y modificarlo sin romper nada.
> **No reemplaza leer el código** del área puntual que vayas a tocar — el código es la
> verdad y este doc puede quedar viejo. Si encontrás algo desactualizado acá, corregilo
> (regla permanente en CLAUDE.md: este doc se actualiza junto con WORKLOG.md).
>
> Última actualización: **2026-09-29 (2ª)** — **API DE AGENTE GANAMOS** (§0.1:
> `ganamosApiService`, PLATFORM_MODE=ganamos_api, carga/retiro automáticos SIN
> idempotencia, Cloudflare). Antes (misma fecha): **MODO MANUAL sin API** (§0:
> adaptador `ganamosPlatformService`, `PlatformTask`, bandeja "Pendientes GANAMOS",
> PWA sin saldo/SSO/reembolsos, registro por agente; §4.8 envs; §9 trampas).
> Antes: 2026-09-18 — RULETA DIARIA con premios editables (dinero
> con rollover / bonificación % en la próxima carga / peso) y elegibilidad editable;
> BONO por instalar la app con tope y excedente; sugerencia automática del bono en
> Depositar (§2 DailyRouletteSpin/User, §5 ruleta y bono instalación, §6 panel, §7).
> Antes: 2026-09-16 — ROLLOVER GLOBAL de bonos (§4.5, §4.1 `creditGift`,
> §6 card, §9) + MULTICUENTA por TITULAR del comprobante (§2 Comprobante.originHolderKey,
> §5 comprobantes/auto-carga, §6 fraud-check, §9). Espec en
> `docs/ESPEC-ROLLOVER-GLOBAL-Y-MULTICUENTA-TITULAR.md`.
> Antes: 2026-09-11 (2ª tanda) — 🏦 BANDEJA DEL BANCO en tiempo real,
> carga manual anclada, bajadas y cierre diario (réplica del #155 del gemelo; §2 modelos
> BankSweep/DailyClose/CashierSnapshot + campos de BankMovement, §4.8 envs TELEGRAM_*,
> §5 auto-carga/bajadas/cierre, §6 panel, §7 cron, §9 trampas).
> Antes (misma sesión): REEMBOLSO EN VIVO acumulativo de por vida
> sobre plata real + reembolsos por período que descuentan `bonus.granted` y lo ya
> cobrado (espec en `docs/ESPEC-REEMBOLSO-1GIROX.md`; §2 CashbackClaim + campos
> User, §4.4 reference `vip-cbk`, §4.6 bloque `bonus` del /stats, §5 flujo, §6
> panel/PWA, §9 trampas).
> Antes: 2026-09-07 — regalos (reembolsos, ruleta, rakeback, bono
> VIP, referidos) pasan a acreditarse como BONO 0 "regalo directo" en vez de depósito
> (§4.5, §4.4 nota, §4.8 env `GIROX_GIFT_AS_BONUS`, §4.11, §9). Manual Partner API
> v1.15 guardado en `docs/PARTNER-APIv1.15.pdf`.
> Antes: 2026-08-14 — lote de features portadas del proyecto
> hermano (#153-#158): §2 (NotifBatch + PromoBonus con exención 'lote'), §4.4
> (reference vip-nbatch), §5 (mínimos de reembolso + flujo completo de lotes con
> regalo), §6 (Cerrados 48hs paginados, cards de lotes, Datos 2.0, admin-sw v31),
> §7 (motor _processNotifBatchQueue).
> Antes: 2026-08-03 — niveles VIP por apostado acumulado (réplica de
> Stake): §2 (VipWagerMonth + campos User), §4.4 (references vip-lvl/vip-rake), §4.6
> reescrita (el scraping del panel se ELIMINÓ en la v1.9 — ahora stats por username con
> la Partner API), §4.8 (envs VIP_*, se fueron las GIROX_ADMIN_*), §5 (flujo VIP +
> reembolsos corregido), §7 (crons VIP).
> Antes: 2026-07-31 — migración JUGAYGANA → 1girox (§4, flujos de plata de §5, trampas).
> Lectura integral previa: 2026-07-09 (server.js completo, 28 modelos, servicios, PWA y
> panel). Los números de línea derivan con cada cambio — usalos como referencia
> aproximada y confirmá con grep.

Índice:
1. Visión general del negocio
2. Modelos de datos y relaciones
3. Ciclo de request / autenticación / roles
4. Integración 1girox (Partner API + panel de reportes)
5. Flujos principales (paso a paso)
6. Front-end: PWA cliente y panel admin
7. Motores automáticos / crons
8. Convenciones importantes
9. Trampas / "no rompas esto"

---

## 0. ⚠️ MODO MANUAL — GANAMOS SIN API (#190, 2026-09-29) — LEER PRIMERO

Este repo es el clon de VIPCARGASANTINO para la sala **GANAMOS**, que **no expone
ninguna API**. Todo lo que abajo dice "1girox / Partner API" sigue siendo cierto
como DISEÑO (los flujos, referencias, idempotencia, mensajes) pero en este repo la
"plataforma" es **una persona con el panel de GANAMOS abierto**. Cómo se resuelve:

- **Selector `src/services/platformService.js`** (`PLATFORM_MODE`, default `manual`):
  `server.js` y los servicios hacen `require('./platformService')` y reciben o bien
  `giroxService` (modo `girox`, intacto) o bien **`ganamosPlatformService`**, que
  implementa EXACTAMENTE el mismo contrato (`scripts/test-ganamos-adapter.js` lo
  verifica export por export). `girox.MANUAL_MODE` / `PLATFORM_MANUAL` (server.js)
  es la bandera que usan los pocos flujos que necesitan saber si hablan con una API.
- **`PlatformTask`** (`src/models/PlatformTask.js`): cada operación de plata que el
  código "mandaba a la API" queda registrada con la MISMA `reference` (índice único
  → idempotencia idéntica: reintento = `duplicate:true`). `kind` deposit|withdraw|gift,
  `status` pending|done|rejected, `source` agent|server, `flow` (hgcash, roulette,
  fire, vip, batch, admin_deposit… deducido del prefijo `vip-*` si el caller no lo
  pasa), `bonus{amount,percent,multiplier}`, `rolloverX`, `meta`.
  - **`agentExecuted:true`** (lo pasan `/api/admin/deposit`, `/api/admin/withdrawal`,
    `/api/admin/bonus`, `_deductChipsAtConfirm`) → nace `done`: el clic del agente ES
    la confirmación de que ya lo hizo en GANAMOS. No va a la bandeja.
  - Sin esa opción (hgcash, ruleta, fueguito, VIP, lotes, welcome code, devolución,
    referidos) → nace **`pending`** y se ve en el panel **"⏳ Pendientes GANAMOS"**.
- **Eventos** (`girox.setTaskListener((event, task))`, cableado en server.js justo
  después del `setKeyResolver`): `created` → nota admin-only "⏳ PENDIENTE EN GANAMOS"
  en el chat del cliente (hgcash deja la suya) + socket `platform_task`; `done` →
  mensaje al cliente `/sys_ganamos_acreditado` (sólo tareas `source:'server'` que no
  sean retiro) + nota + `Transaction.metadata.platformTaskStatus`; `rejected` → nota
  con el motivo (obligatorio), nada se acredita.
- **Endpoints:** `GET /api/public/config` (sin auth: `platformMode`, `playUrl`,
  `publicRegister`, `brand`); `GET /api/admin/platform-tasks?status=&username=&limit=`
  (`count=1` → sólo `pendingCount`); `POST /api/admin/platform-tasks/:id/done|reject`
  (`_canSettlePlatformTask`: admin todo, depositor/comunidad cargas y bonos,
  withdrawer retiros). `/api/auth/verify` y `/api/admin/me` exponen `platformMode`.
- **Lo que devuelve el adaptador y cómo lo toleran los flujos:** saldo y netwin →
  `{success:false, code:'manual_mode'}` (`/api/balance(/live)` responde
  `{manual:true}`; reembolsos/VIP/cashback `{enabled:false}`; el retiro autogestionado
  no valida saldo y `_deductChipsAtConfirm` no lee ni verifica: registra `done`);
  `getUserInfoByName` → jugador "vacío" `manual:true` (saldo null, bonusLocked 0) para
  no bloquear guards ni lotes; **`validateCredentials` → `valid:false` SIEMPRE**
  (seguridad: el login no puede crear cuentas locales sin validar);
  `syncUserToPlatform` → `alreadyExists:true` (el jugador ya existe en GANAMOS);
  `createSession` → `GANAMOS_PLAY_URL` (la PWA abre una pestaña, sin iframe);
  `changeUserPassword` → ok sin hacer nada (la clave de GANAMOS la maneja el agente);
  `getPlatformConfig` → bonos habilitados, multiplicadores 0/2/3/5/10 (el rollover
  global se ANOTA en la tarea para que el agente lo aplique).
- **Registro público apagado** (`/api/auth/register` y `/api/landing/signup` → 410)
  salvo `PUBLIC_REGISTER_ENABLED=1`: el agente crea la cuenta desde el panel (mismo
  username que en GANAMOS) y manda el link de acceso. `check-username` sólo mira la
  base local.
- **PWA:** `public/js/platformmode.js` aplica el modo (oculta `.dash-balance`,
  `.dash-refunds`, `.dash-user`, menú Mi Perfil, botón Registrarse; CASINO →
  `window.open(playUrl)`); `syncBalance` corta el polling; `withdraw.js` sin tope de
  saldo; `refunds.js` oculta con `enabled:false`.
- **Para volver a 1girox:** `PLATFORM_MODE=girox` + `GIROX_API_URL/KEY`. Nada del
  cliente original se tocó.

## 0.1 API DE AGENTE GANAMOS (#191, PLATFORM_MODE=ganamos_api)

Tercer modo, ADEMÁS del manual (§0): en vez de una bandeja para el agente, el server
carga y descuenta SOLO contra la API del panel de agente `agents.ganamos.co`
(`src/services/ganamosApiService.js`, `GANAMOS_API_MODE=true`, `MANUAL_MODE=false` → el
server lo trata como plataforma real). Endpoints: `POST /api/sign/login` (cookie
`session` JWT, login con user+clave del AGENTE en SSM), `GET .../user/search/?username=`,
`GET .../user/{id}/` (saldo), `POST .../user/{id}/payment/` {operation,amount}
(carga=0, retiro configurable). Tres diferencias críticas con 1girox, todas resueltas
en el cliente:
- **Sin idempotencia:** el pago no lleva `reference`. UN solo intento; si la respuesta
  se pierde → `{success:false, indeterminate:true}` y el caller NO reintenta. Lecturas
  sí reintentan; un 401 en el pago sí re-loguea (no tocó plata).
- **Sesión, no API key:** login por credenciales, cookie en memoria con mutex y
  re-login al 401. Nunca hardcodear la cookie (vence, es secreto de la cuenta).
- **Cloudflare:** anti-bot; el login desde el server puede dar 403 →
  `code:'cloudflare_blocked'` (whitelisting de IP o proxy). **Confirmado el 2026-09-29
  desde Render (IP 74.220.49.198): 403 directo.** Con `GANAMOS_PROXY_URL`/`PROXY_URL`
  todo el tráfico del cliente sale por ese proxy (`httpsAgent` + `proxy:false` en axios).
En este modo `PLATFORM_NO_STATS/NO_SSO/NO_SELFSIGNUP` (server.js) apagan reembolsos/VIP
(sin netwin), abren el casino en pestaña (sin SSO) y dejan el alta al agente (no hay
endpoint de alta mapeado). El saldo SÍ es real. Test: `scripts/test-ganamos-api.js`.
Pendiente antes de plata real: confirmar el `operation` del retiro y los nombres de
campo del saldo (`GANAMOS_DEBUG_SHAPES=1`), y verificar que Cloudflare deje loguear.

## 1. Visión general del negocio

Sala de juegos para Argentina que es un **wrapper sobre 1girox** (plataforma de juego
externa; Partner API REST/JSON, panel de administración `admin.1girox.com`, web del
jugador `1girox.com`). Hasta el 2026-07-31 la plataforma era **JUGAYGANA**
(`admin.agentesadmin.bet` / `jugaygana44.bet`) — ver §4 para la migración.
El sistema VIPCARGAS:
- Capta jugadores (pauta/publicistas/referidos/orgánico) y los crea en 1girox por API.
- Gestiona **cargas** (manuales por agente, o AUTOMÁTICAS vía banco hgcash + IA de
  comprobantes) y **retiros** (self-service con confirmación de agente y pago
  automático por hgcash).
- Da **reembolsos** sobre la pérdida real/NETWIN (diario/semanal/mensual), **ruleta
  diaria**, **fueguito** (racha), **bono instalación $5.000**, **referidos** (8% de
  netwin → owner-revenue, y 7% de eso al referidor) y **campañas/publicistas** con
  sub-atribución por influencer.
- El "saldo real" del jugador vive en 1girox; VIPCARGAS guarda atribución, bonos,
  reclamos y el registro permanente de transacciones.
- Al casino se entra por **login único (SSO)**: el botón CASINO pide un link de acceso
  de un solo uso — el cliente ya no tipea usuario ni contraseña de la plataforma.

UX del cliente: PWA (`public/`) con chat en vivo (Socket.IO) + push (FCM). Los
agentes operan desde `public/adminprivado2026/`. Deploy: AWS Elastic Beanstalk
(posible multi-instancia → Redis para socket.io adapter, rate-limits y locks).
Secrets desde AWS SSM cargados async en el bootstrap (final de server.js).

## 2. Modelos de datos y relaciones (`src/models/`)

Todos los modelos canónicos viven en `src/models/`. `config/database.js` los
re-exporta (NO los redefine, salvo **ExternalUser** y **UserActivity** que son
exclusivos suyos) y es el `connectDB` REAL que usa server.js (TTL de mensajes con
autorreparación de índice). `src/models/index.js` tiene OTRO connectDB con las
migraciones de índices de referidos — **NO se usa desde server.js** (solo exporta
modelos); sus migraciones corren únicamente si algo llamara a ese connectDB.

### Núcleo
- **User** — jugadores y staff. Claves: `id` (uuid string — casi todo el código usa
  `id`, NO `_id`), `username` + **`usernameLower`** (copia indexada para búsquedas
  case-insensitive; la mantiene un pre-save + backfill en cada arranque — ver
  `findUserByUsernameCI`), `password` (bcrypt vía pre-save), `role`, `phone` +
  **`phoneKey`** (clave normalizada para unicidad — quita país/0/9 AR), `phoneVerified`,
  `phoneVerificationPending` (bloquea SOLO retiros), `mustChangePassword` (bloquea casi
  todo vía authMiddleware), `tokenVersion` (revocación de sesiones), `isBlocked`/
  `blockReason`. **1girox:** `giroxUserId` (ID numérico del jugador — desde la v1.9 lo
  devuelve el propio `stats` y se persiste "gratis"; ya no bloquea nada, todo va por
  username), `giroxSyncStatus`
  (`pending|synced|linked|error|invalid_username|not_applicable`), `giroxSyncError`,
  `giroxPasswordSynced` (la clave local es bcrypt irrecuperable: los migrados se crearon
  con clave random y la real se replica en el próximo login). Campos `jugaygana*`
  (`jugayganaUserId/Username/SyncStatus/SyncError`) y `source:'jugaygana'` **se conservan
  intactos para poder revertir** — ya no se usan para operar. FCM: `fcmToken` legacy + `fcmTokens[]`
  (multi-dispositivo, `context:'standalone'` = PWA instalada). Atribución:
  `acquisitionCampaign/Source/Influencer/Utm`, `createdByEmployeeId`. Referidos:
  `referralCode`, `referredByUserId`. Meta: `metaFbc/metaFbp/landingUrl`.
  Anti-multicuenta: `registrationIp/UserAgent`. Panel: `tags[]`, `adminNotes`,
  `tagHistory`. **VIP:** `lifetimeWagered` (cache de la suma de VipWagerMonth, sólo se
  actualiza con `$max`), `vipLevel` (0 = sin nivel; NUNCA baja; se avanza recién
  DESPUÉS de acreditar el bono del nivel), `vipLevelUpdatedAt`. Otros:
  `installBonusClaimed`, `notificationPlan`, `notifMonthlyCounts`,
  `loginWithoutPassword`, `withdrawalAccount`, `pendingAccessCode`.
- **Transaction** — registro PERMANENTE (sin TTL). `type`: deposit|withdrawal|bonus|
  refund|transfer|referral_commission|fire_reward|rakeback|vip_levelup|roulette
  (`roulette` desde 2026-09-07: antes la ruleta no escribía Transaction).
  `metadata.creditedAs` ('bonus'|'deposit') en ruleta y fueguito = cómo salió de
  verdad hacia 1girox (fallback a depósito queda registrado).
  `metadata.source` distingue regalos ('install_bonus','welcome_gift') y devoluciones
  ('payout_refund') que se EXCLUYEN de los reportes de carga real. **Fuente de toda la
  analítica.**
- **VipWagerMonth** — apostado de casino de un usuario en un mes calendario (ART).
  Base del acumulado VIP (`User.lifetimeWagered` = suma de estos buckets). Único por
  `userId+monthKey`; el motor SIEMPRE escribe con `$set` (nunca `$inc`) → recalcular
  es idempotente y multi-instancia-safe. `closed:true` = mes terminado y recalculado
  completo (no se vuelve a consultar a la plataforma).
- **Message** — chat. **TTL 3 días** (índice sobre `timestamp`, autorreparado en
  connectDB). `senderRole` define el lado; `adminOnly:true` = solo lo ven admins;
  `metadata.kind:'welcome'` = throttle de bienvenida.
- **ChatStatus** — estado de conversación (open/closed/payments/comunidad + category
  cargas/pagos). Se crea recién con ACTIVIDAD del usuario (welcome o primer mensaje),
  no al crear la cuenta. Lleva el reloj SLA (`pendingSince/Preview/Type`).
- **ChatDelay** — snapshot permanente de demoras de atención que superaron el umbral
  (sobrevive al TTL de Message). Umbrales: cargas 2min / pagos 30min (configurables).

### Plata / banco automático (hgcash)
- **BankMovement** — cada movimiento que hgcash notifica por webhook. `matchStatus`:
  pending→claiming→shadow_matched|auto_charged|manual_charged|needs_review|duplicate|
  error|ignored. Dedupe por `movementId` único.
- **Comprobante** — cada imagen que la IA (Claude vision) clasificó como comprobante.
  `originHolderKey` (#184) = titular de origen normalizado (`src/utils/holderKey.js`,
  ≥2 palabras y ≥8 letras) para cruzar multicuenta entre usuarios aunque el banco no
  tenga API.
  `dedupeKey` (N° operación normalizado, descartando CBU/CUIT) + `imageHash` (SHA-256)
  para detectar reutilización. `bankMatchStatus` para la auto-carga.
- **BankMovement** — cada movimiento que hgcash notifica por webhook (ver arriba).
  **Desde 2026-09-11 (#183):** `fromKey` (identidad bancaria normalizada del titular),
  `chargeSource` (auto | assigned | manual_link | legacy_amount | legacy_name |
  close_link), `transactionId` (Transaction.id de la acreditación vinculada),
  `assignedBy/At`, `resolution/resolutionNote/resolvedBy/At` ("no corresponde"),
  `outKind` (payout | sweep | unknown), `payoutId`, `sweepId`.
- **BankSweep** (#183) — BAJADAS: salidas de hgcash a un CBU externo (financiera) para no
  acumular capital; solo admin general / pagos; externalID `sweep-<id>`; registro permanente.
- **DailyClose** (#183) — cierre diario por `dateKey` ART: `summary`, `cashier` (cruce con
  el cajero 1girox — hoy `sin_datos`), `bank` (saldo hgcash), `diffs[]` con `key` estable y
  `resolved`.
- **CashierSnapshot** (#183) — saldo del cajero (cuenta agente 1girox) tras cada operación
  de plata + `opAmount` con signo; TTL 120 d. ⚠️ La Partner API v1.15 NO informa el saldo
  del agente → colección vacía hasta que 1girox lo agregue (`giroxService.
  setCashierBalanceHook` ya está cableado para `agent_balance`).
- **HgcashCharge** — candado de idempotencia de la carga automática: índice único por
  `chargeKey` (coelsaCode) — la MISMA transferencia se acredita UNA sola vez entre
  instancias. Si la carga falla en 1girox, el registro se BORRA para permitir retry
  (el retry manda la misma `reference`, así que no puede duplicar del otro lado).
- **PendingPayout** — retiro self-service pendiente de que un agente confirme.
  `deductAtPay:true` (flujo actual) = las fichas se descuentan AL CONFIRMAR, no al
  solicitar. `debitConfirmed` = verificación anti-retiro-fantasma (el saldo tiene que
  haber bajado de verdad). `status`: pending_review→paying→paid|failed|cancelled.

### Captación / marketing
- **Campaign** — publicista/pauta. `code` inmutable (va en la URL). **`giroxApiKey`**
  (`select:false`, texto plano, formato `pk_...`) = la cuenta del publicista en 1girox:
  una key sola reemplaza al par usuario+contraseña de sub-agente que había en JUGAYGANA
  (la jerarquía la define la key). **`hasGiroxKey`** es el espejo booleano SIN
  select:false para que el listado del panel muestre el badge sin traer el secreto —
  mantenerlo en sincronía en TODOS los caminos que escriben o limpian la key.
  **`giroxApiKeysExtra`** (2026-08-19, `[String]` select:false) = POOL de keys
  adicionales del MISMO publicista (ver §4.3: N keys = N×60/min). Los campos
  `jugayganaUsername/jugayganaPassword` quedan para revertir. También `influencers[]`
  (lista fija para sub-atribución analítica).
  **⚠️ RUTEO POR DUEÑO (2026-08-05):** la key MASTER NO ve por Partner API a los
  jugadores creados bajo un sub-agente. `User.giroxOwnerCampaign` marca la campaña
  dueña (se setea en el alta del publisher_admin con key OK) y `giroxService` firma
  TODAS las operaciones de ese jugador con la key de esa campaña (keyResolver
  inyectado desde server.js, cache 60s; el batch de stats se agrupa por key).
  Consecuencia: las cargas a esos jugadores salen del SALDO del sub-agente en
  1girox — mantenerlos fondeados.
- **CampaignClick** (TTL 90 días), **InfluencerStory** (placement con costo; la
  atribución de registros es por VENTANA HORARIA calculada a demanda en
  publisherAnalyticsService).
- **Referral**: ReferralEvent (atribución, 1 por referido), ReferralCommission
  (cálculo por período `YYYY-MM`, con liquidación INCREMENTAL/delta —
  `settledOwnerRevenue`), ReferralPayout (pagos, soporta múltiples por período).

### Notificaciones / retención
- **NotificationRule** (+ Suggestion con approval-gate 48h, + NotificationHistory con
  tracking de ROI), **NotifTemplate** (tipos: invitacion|regalo|reembolso — bono_50/100
  ELIMINADOS), **ScheduledNotif** (once/daily/weekly, worker cada 60s), **PromoBonus**
  (bono de carga vigente, 1 sola carga; cap de LECTURA a 30% en
  `_getActivePromoBonus` SOLO para bonos automáticos — los de LOTE,
  `sourceRuleCode:'lote'`, están EXENTOS porque los configura un agente a mano,
  hasta 200%; con `opts.includeFixed` el endpoint admin también ve regalos de
  $ fijo → cartel "REGALO PENDIENTE"), **NotifBatch** (lote de notificaciones
  con regalo, 2026-08-14: recipients embebidos con channel/delivery/claimedAt/
  promoBonusId/credited*, modos code/window, giftType percent/fixed, código
  público con maxClaims, `sendDone` para el motor reanudable — ver §7),
  **BonusStrategyConfig** + **StrategyEnrollment** (estrategia
  por voto de encuesta — APAGADA), **EncuestaVote/EncuestaFire** (motor encuesta —
  bonos apagados), **InactividadFire** (motor inactivos — APAGADO).
- **CashbackClaim** (2026-09-11) — reclamo del REEMBOLSO EN VIVO acumulativo
  (`docs/ESPEC-REEMBOLSO-1GIROX.md`). Índice único `userId+dateKey+seq` = candado
  del reclamo y fuente de la reference `vip-cbk-*`; `status` pending|credited (los
  pending cuentan como cobrado → cierran la carrera de doble click); `creditedAs`
  bonus|deposit. En `User`: `cashbackAnchorAt` / `cashbackCarryNet` (puede ser
  NEGATIVO) / `cashbackCarryGranted` = acumulador PLEGADO del neto de por vida
  (la API de stats admite 92 días por consulta). Ver §5.
- **DailyRouletteSpin** — 1 giro/día (índices únicos userId+dateKey y
  username+dateKey). Auto-crédito en 1girox; `credit_failed` → retry desde panel.
  **#188:** `prizeType` (cash | percent | none), `prizePct`, `rolloverX`; estados
  `percent_pending` / `percent_used` para los premios "% en la próxima carga", que
  quedan pendientes en `User.dailyRoulettePendingPct/Label/SpinId/At`.
- **Review** (1 por user, moderada), **OtpCode** (TTL 5 min, hash bcrypt, 3 intentos),
  **FbAdsWebhookQueue** (cola de reintentos al sistema externo fb-ads),
  **RefundClaim** (índice único userId+type+periodKey contra doble cobro),
  **FireStreak** (racha fueguito + premios pendientes), **Config** (key/value: cbu,
  hgcash, refundPercents, fireMilestones, flags de migración one-shot, etc.),
  **Command** (comandos `/...` y mensajes automáticos `/sys_*`, `isSystem:true`).

## 3. Ciclo de request / autenticación / roles

- `authMiddleware` (server.js ~L2497): JWT del header `Authorization: Bearer` o de la
  cookie httpOnly `admin_api_session` (el panel usa cookie). Valida firma HS256, busca
  el User por `id` con select mínimo (`AUTH_USER_FIELDS` — ⚠️ si un chequeo nuevo
  necesita otro campo, sumarlo ahí), chequea isActive/isBlocked/`tokenVersion`.
  publisher_admin: lockdown contra `PUBLISHER_ADMIN_ALLOWED_PATHS`. mustChangePassword:
  solo deja pasar `MUST_CHANGE_PASSWORD_ALLOWED_PATHS` (admins se auto-limpian).
- Middlewares de rol: `adminMiddleware` (admin/depositor/withdrawer/comunidad),
  `depositorMiddleware` (admin/depositor/comunidad), `withdrawerMiddleware`
  (admin/withdrawer), `publisherAdminMiddleware`. Acciones sensibles re-chequean
  `req.user.role === 'admin'` explícito (patrón obligatorio — ver #80).
- **`src/middlewares/auth.js` es OTRO sistema de auth** (access 15m + refresh 7d,
  blacklist EN MEMORIA no compartida entre instancias) usado SOLO por las rutas de
  referidos. Lazy getters de JWT_SECRET (SSM carga después del require).
- Secrets: `loadSecretsFromSSM()` en el bootstrap async → NUNCA leer secrets al
  require; leerlos en runtime.
- Cookies admin: `admin_session` (Path=/adminprivado2026) + `admin_api_session`
  (Path=/api), 8h, SameSite=Strict. `GET /api/admin/me` revalida la cookie contra DB
  y devuelve un token fresco para Socket.IO.
- Rate limiting: `generalLimiter` 300/min (keyed por cookie de sesión admin o IP; en
  memoria), `authLimiter` 10/min y `sensitiveLimiter` 10/15min (Redis compartido con
  fallback a memoria — `RedisBackedRateStore`), `smsIpLimiter`/`bulkSmsIpLimiter`/
  `registerIpLimiter` (Redis INCR+EXPIRE con fallback), `platformSessionLimiter`
  (SSO al casino: 20 cada 5 min **por userId, no por IP** — con el CGNAT de las
  telefónicas argentinas limitar por IP dejaría barrios enteros compartiendo cupo;
  además protege el presupuesto de 60 req/min de la Partner API).
- Socket.IO (~L7488): `authenticate` revalida contra DB (isActive/isBlocked/
  tokenVersion). Rooms: `admins`, `user_<id>`, `chat_<id>`. Maps `connectedUsers`/
  `connectedAdmins`. Entrega con ack-timeout 3s → fallback push FCM (socket fantasma).

## 4. Integración 1girox (Partner API + panel de reportes)

Migración hecha el **2026-07-31**. Los archivos de JUGAYGANA (`jugaygana.js`,
`jugaygana-movements.js`, `src/services/jugayganaService.js`,
`jugayganaPublisherSessions.js`, `referralRevenueService.js`,
`jugayganaUserLinkService.js`) **siguen en el repo pero NINGÚN código los importa** —
server.js los sacó de sus requires (~L428 hay una lápida explicando dónde vivían).
Quedan sólo para poder revertir; se borran más adelante. **No los uses para nada nuevo.**

### 4.1 Los módulos vivos

| Módulo | Usa | Para qué |
|---|---|---|
| `src/services/giroxService.js` | server.js (`girox.*`), migración | **Cliente ÚNICO de la Partner API.** Altas (`createPlatformUser`, `syncUserToPlatform`), consulta (`getUserInfoByName`, `getUserBalance(WithRetry)`), credenciales (`validateCredentials`, `changeUserPassword`), SSO (`createSession`) y plata (`depositToUser`, `withdrawFromUser`, `creditUserBalance`, `creditGift`). Auth por header `X-Api-Key`. Rate limit + reintentos propios. **Rollover GLOBAL (#184):** `setRolloverResolver(fn)` inyectado desde server.js; se aplica en los 3 puntos por donde pasa todo bono (`creditGift`, `creditUserBalance` con multiplier, `bonus_multiplier` de `depositToUser`) salvo `ignoreGlobalRollover:true`. |
| `src/services/giroxReportsService.js` | reembolsos, referidos (`giroxReports.*`) | **Netwin (GGR) por jugador y rango.** ⚠️ NO es la Partner API: habla con el PANEL `admin.1girox.com`. `getPlayerNetwinForDateRange`, `findPlayerIdByUsername`, `getPlayerInfoById`. |
| `src/services/giroxUserLinkService.js` | reembolsos, referidos | `resolveGiroxUserId(userId, username)` — lee `User.giroxUserId` y, si falta, lo backfillea al vuelo contra el panel (match EXACTO del nombre, doble verificación). |
| `src/services/giroxPublisherKeys.js` | publisher_admin create-user, panel | Alta de jugadores con la **API key de la campaña** (`Campaign.giroxApiKey`). `createUserAsPublisher`, `testKey`. `invalidateSession()` quedó como **no-op** (no hay sesiones que tirar). |
| `src/utils/periodRanges.js` | reembolsos | Rangos ayer/semana/mes en hora Argentina. Eran funciones de `jugaygana.js`; son PURAS y se movieron acá para que el cliente viejo se pueda borrar. **No tocar los strings de fecha: alimentan los `periodKey` de RefundClaim.** |
| `scripts/migrate-users-to-girox.js` | one-shot manual | Migración de la base de usuarios (ver §4.7). |

### 4.2 Qué DESAPARECIÓ (el doc viejo insistía con estas cosas)

- ❌ **Los ×100 de centavos.** 1girox trabaja en **PESOS** (admite 2 decimales).
  Multiplicar por 100 en cualquier lado sería cargar 100 veces de más.
- ❌ **Las 4 sesiones independientes / `ensureSession` / mutex de login / pool por
  publicista.** No hay login: la auth es un header `X-Api-Key` fijo. No hay token que
  venza ni sesión que invalidar → un cambio de key desde el panel tiene efecto
  inmediato en TODAS las instancias (con JUGAYGANA cada instancia de EB cacheaba su
  propio pool y sólo se invalidaba la que atendía el PUT: era un bug real).
- ❌ **El HTML de Cloudflare.** La Partner API responde JSON siempre (se pide con
  `Accept: application/json`). Ya no hace falta `isHtmlBlocked()` ni el tri-estado
  found/not_found/error de `lookupUserOrError`. **Ojo:** el PANEL de reportes SÍ está
  detrás de Cloudflare y su cliente conserva la detección de HTML.
- ❌ **`jugayganaUserId` como llave de las operaciones de plata.** Todo va por
  `username`. El ID numérico ahora sólo existe para los REPORTES (ver §4.6).

### 4.3 Rate limit — 60 req/min **POR API KEY** (2026-08-19) ⚠️ y POR INSTANCIA

La Partner API permite **60 requests por minuto POR API KEY** (confirmado por su
soporte; a pedido suben keys puntuales a 180) y devuelve 429 al pasarse. Desde
2026-08-19 el limitador local de `giroxService` es **por key ("carril")**, no una
ventana única: la master, cada key de consultas y cada key de publicista esperan
su propio cupo. Techos locales:

- **Master** (o sin key): `GIROX_MAX_RPM` (default 55).
- **Keys de publicista**: `GIROX_PUBLISHER_MAX_RPM` (default **30** — NO heredan
  el de la master, que puede tener el límite subido) + overrides por key con
  `GIROX_PUBLISHER_KEY_RPM=pk_x:90,...`.
- **Keys de consultas** (`GIROX_API_KEY_CONSULTAS=pk_a:90,pk_b:30`): sufijo
  `:rpm` propio; sin sufijo → `GIROX_MAX_RPM`. Son keys del MISMO agente que la
  master; las lecturas puras (`getPlayerStats`, batch del grupo master —
  `readOnly:true` en `_request`) firman con la que tenga más lugar libre. Nunca
  reemplazan la key de un publicista (es la única que ve a SUS jugadores).

Además hay **POOL de keys del MISMO publicista** (`Campaign.giroxApiKeysExtra`):
el resolver devuelve `[principal, ...extras]` y `_pickPublisherKey` elige la de
más lugar libre — **UNA vez por operación, antes del loop de reintentos** (la
reference no cambia entre reintentos). N keys = N×60/min de cupo. Se gestiona
desde el panel (campo multi-key coma-separado que SUMA al pool + endpoints
`pool-status`/`pool-remove`, solo admin).

Y hay **cache + coalescing de lecturas** (la causa raíz del lag nocturno era el
poll de saldo cada 30s × usuarios online del mismo publicista): jugador
`GIROX_PLAYER_CACHE_MS` (8s), netwin `GIROX_STATS_CACHE_MS` (90s), solo éxitos.
⚠️ REGLAS DE PLATA: tras cada operación de plata se invalida el cache del
usuario (con guard anti-race por timestamp contra lecturas en vuelo), y toda
DECISIÓN de plata pasa `{fresh:true}` (guards bono-sobre-bono, anti-fantasma
del retiro, claims de reembolso). Las lecturas de display van cacheadas. El
poll del front bajó a 90s (el socket `balance_updated` sigue instantáneo).

⚠️ **El limitador sigue siendo POR PROCESO.** En AWS EB con N instancias el
techo real por key es N×techo_local → criterio: **techo local = límite de la
key en la plataforma ÷ N instancias**. El 429 igual se reintenta respetando
`Retry-After`. El boot loguea la radiografía `[girox] config:` (a stdout, que
sí entra en los logs de EB — los warns del limitador también se espejan a
console desde 2026-08-19).

La misma cuota la comparte el script de migración: mientras corre, producción
sigue pidiendo saldos, cargas y retiros contra el mismo cupo de la master.

### 4.4 Idempotencia por `reference` — LA REGLA DE ORO

Cada operación de plata (deposit / withdraw / bonus) lleva una `reference` de hasta
**100 caracteres** que es su llave de idempotencia. Si se repite, 1girox NO vuelve a
mover plata: responde `duplicate:true` con los datos de la operación original.

**Regla de oro: ante timeout o error de red, reintentar SIEMPRE con la MISMA
reference.** Nunca generar una nueva para el mismo pago.

Una reference mal elegida rompe plata **en las dos direcciones**:
- Si **se repite entre operaciones distintas** → la segunda vuelve `duplicate:true` y
  el cliente **NO cobra** (parece exitosa: hay que mirar el flag).
- Si **cambia entre reintentos del mismo pago** → se paga **dos veces**.

Corolario: la reference tiene que salir de algo **estable y persistido** (un id de
Transaction generado ANTES de llamar, el periodKey del reembolso, el id del movimiento
bancario). `giroxService` genera una al vuelo si no se le pasa ninguna, pero **loguea
un warning**: eso cubre sólo los reintentos internos de esa llamada, no un reintento
del usuario o del agente.

Prefijos en uso hoy:

| Prefijo | Flujo | De dónde sale |
|---|---|---|
| `vip-dep-<txId>` | Carga manual del agente | uuid generado antes de llamar y reusado como `Transaction.id` |
| `vip-depbonus-<txId>` | Bonificación de esa misma carga | ídem (Transaction del bonus) |
| `vip-wd-<txId>` | Retiro manual del agente | ídem |
| `vip-sdep-<uuid>` | `POST /api/movements/deposit` (self-service) | uuid al vuelo |
| `vip-swd-<uuid>` | `POST /api/movements/withdraw` (self-service) | uuid al vuelo ⚠️ sin persistir: no protege contra un reintento del cliente |
| `vip-bonus-<txId>` | Bono manual desde el panel | uuid reusado como Transaction.id |
| `vip-rf-<periodKey>-<userId>` | Reembolsos | **derivada del PERÍODO, no del RefundClaim.id** (ver abajo) |
| `vip-hg-<coelsa\|movementId>` | Auto-carga hgcash | identificador del MOVIMIENTO bancario (el mismo `chargeKey` del candado) |
| `vip-roulette-<spinId>` | Premio de ruleta | id del DailyRouletteSpin |
| `vip-fire-<userId>-d<día>-<fecha>` | Premio de fueguito | userId + hito + día ART |
| `vip-install-<userId>` | Bono instalación $5.000 | userId (una sola vez en la vida) |
| `vip-payout-<payoutId>` | Débito al confirmar un retiro | PendingPayout.id |
| `vip-payoutref-<payoutId>` (+ `-chips-` / `-bonus-`) | Devolución de retiro rechazado | PendingPayout.id |
| `vip-refcom-<payoutId>` | Comisión de referidos | ReferralPayout.id (uuid persistido en Mongo ANTES de llamar; si un intento anterior quedó pending/failed se REUSA el documento ⇒ misma reference) |
| `vip-lvl-<userId>-<idx>` | Bono por alcanzar un nivel VIP | userId + índice del nivel (cada nivel se paga UNA vez en la vida; por eso NO se pueden reordenar los idx de vipLevels.js) |
| `vip-rake-<fromDateStr>-<userId>` | Rakeback semanal VIP | lunes de la semana reclamada + userId (derivada del PERÍODO, igual que los reembolsos y por el mismo motivo) |
| `vip-welcome-<userId>` | Bono sorpresa del código de bienvenida (tipo cash) | userId (uno por cuenta para siempre, como el de instalación) |
| `vip-nbatch-<batchId>-<userId>` | Regalo de fichas de un lote de notificaciones | id del NotifBatch + userId (uno por lote por usuario — los reintentos del motor o del canje jamás pagan dos veces) |
| `vip-cbk-<userId>-<YYYY-MM-DD>-<seq>` | Reembolso EN VIVO acumulativo | userId + día ART + `seq` del índice único de CashbackClaim: si el crédito falla se borra el doc y el reintento reusa el MISMO seq → misma reference → `duplicate:true` |

⚠️ **Por qué la del reembolso sale del período y no del id del claim** (`_refundReference`,
server.js ~L6086): si la acreditación falla, el handler BORRA el RefundClaim para que el
usuario pueda reintentar, y el reintento genera un id nuevo. Con una reference derivada
de ese id, un fallo FALSO (se acreditó pero se perdió la respuesta por timeout) pagaría
DOS VECES. Derivándola del `periodKey` (que ya es único por usuario+tipo+período), el
reintento manda la misma reference y la plataforma responde `duplicate:true`.

### 4.5 Rollover y bonos ACTIVOS en la plataforma

1girox tiene el feature "Rollover y Bonos" **activo**. Consecuencias:

- **Los retiros se validan contra `wagering.available`, NO contra `balance`.** El
  jugador puede tener saldo que todavía no puede retirar (objetivo de apuestas
  pendiente). `getUserBalance` devuelve `balance`, `available`, `locked`, `bonusLocked`.
  Validar contra `balance` ⇒ la plataforma rechaza con `rollover_locked` y queda un
  retiro colgado en el panel. El confirm de payouts (~L12898) ya usa `available`.
- **Regalos = BONO 0 "regalo directo" (2026-09-07; Partner API v1.10+, manual v1.15
  §2.9/§2.12).** `creditUserBalance(username, amount, reference)` SIN `multiplier`
  va por `POST /players/{username}/bonus` con `multiplier: 0`: la plata queda
  disponible/RETIRABLE al instante, **no pasa por el reclamo** ("el bono 0 nunca
  pasa por el claim: se acredita directo") y **no pisa el bono en curso**. En el
  ledger figura `type: "bonus"` → en el panel de 1girox se ve como **Bono**, no como
  Carga. Lo usan: reembolsos (`vip-rf-*`), ruleta (`vip-roulette-*`), rakeback
  (`vip-rake-*`), bono de nivel VIP (`vip-lvl-*`), comisiones de referidos
  (`vip-refcom-*`), fueguito con rollover 0 y la parte "bonus" de la devolución de
  un retiro rechazado (`vip-payoutref-bonus-*`).
  - **Precheck** contra `GET /config` (cacheado 10 min): `bonus.enabled`,
    `bonus.standalone_enabled`, `0 ∈ bonus.multipliers` y `fixed_min ≤ monto ≤
    fixed_max` (config real del owner: min 2 / max 1.000.000 → un reembolso de $1
    va por depósito). Si no pasa → **depósito libre con la MISMA reference** (log
    info). Si el precheck pasa pero la plataforma responde `feature_disabled`,
    `bonus_out_of_range`, un 422 de validación o `player_not_found` → mismo
    fallback (en un 422 no se mueve plata, reusar la reference es seguro). Errores
    transitorios (red/429/5xx) NO caen al depósito: se devuelven para que el caller
    reintente con la misma reference. El resultado trae `creditedAs:
    'bonus'|'deposit'`.
  - **Cinturón:** si la respuesta trajera el regalo "a reclamar" (`requirement_id`
    presente en `claimable`), se reclama SÓLO ese requirement — nunca claim-all
    (decisión del owner #162: no auto-reclamar el regalito que el cliente ya tenía).
  - **Kill switch sin deploy:** `GIROX_GIFT_AS_BONUS=0` → todo vuelve a depósito
    libre (comportamiento hasta 2026-09-07). La radiografía de boot `[girox]
    config:` y `GET /api/admin/girox/health` (`regalosComoBono`) muestran el modo.
  🪦 Entre la v1.7 (2026-07-31) y la v1.10 (2026-08-03) el bono 0 SÍ quedaba "a
  reclamar"; por eso hasta el 2026-09-07 todos los regalos iban por `/deposit` y
  figuraban como "Carga" (reclamo del owner con captura del panel).
- **ROLLOVER GLOBAL de bonos (2026-09-16, #184, espec §A):** `Config[
  'bonusRolloverGlobal'] = { enabled, x }` (default ENCENDIDO x3; opciones 0/2/3/5/10;
  card "🎯 Rollover GLOBAL de bonos" del panel, solo admin general). Mientras está
  encendido, TODOS los bonos/regalos salen con ese rollover y los individuales de cada
  flujo se ignoran (bonus del agente, Bonificación, código de bienvenida, lotes,
  fueguito, reembolso en vivo, reembolsos, rakeback, nivel VIP, ruleta). Apagado =
  cada flujo con el suyo (sin migración). `getGlobalBonusRollover()` valida `x`
  contra `bonus.multipliers` de la cuenta y usa el permitido más cercano hacia ARRIBA
  (`effective`, `snapped`). El owner pidió x3 habilitado en la cuenta (2026-09-16), así
  que el efectivo es x3; si alguna vez la plataforma lo quita, el panel avisa y usa x5.
  Se aplica en el CLIENTE (`giroxService`, resolver inyectado), no en los endpoints:
  `creditGift` (regalo como bono con rollover; con x0 = bono 0 de siempre; guard de
  bono activo > $50 y fallback a depósito con multiplier), `creditUserBalance` con
  `multiplier` y `depositToUser` cuando lleva `bonus_amount/bonus_percent`.
  **Excluidos:** comisiones de referidos y devolución de retiro rechazado
  (`ignoreGlobalRollover:true`). Lo que se le DICE al cliente (fueguito, reembolso en
  vivo, código de bienvenida, lotes) usa `applyGlobalRollover(valorDelFlujo)` para
  coincidir con lo acreditado; el cliente además devuelve `rolloverApplied`.
- **`opts.multiplier` EXPLÍCITO** (incluido 0) = `/bonus` ESTRICTO, sin fallback: un
  `bonus_out_of_range` se devuelve como error (botón Bonificación del panel, welcome
  code cash, lotes con regalo). Con multiplier >0 el bono queda bloqueado hasta
  apostar amount × multiplier, con `claim_required` puede quedar "a reclamar" (los
  callers hacen `claimPendingBonus`) y ⚠️ **PISA un bono activo previo** ("bono
  sobre bono": se debita lo que quedaba del viejo).
- **FUEGUITO (2026-09-07, `_creditFireReward` en server.js):** con rollover >0
  (Config['fireRolloverMultiplier'], default 5, editable en el panel — validado
  contra `bonus.multipliers`) el premio va por **`/bonus` con ese multiplier** →
  figura como BONO, jugable ya, retirable tras apostar multiplier × premio; con
  `claim_required` el jugador lo libera tocando el regalito del casino al
  completar el objetivo. Guard: si el jugador YA tiene bono activo
  (`bonus_locked + claimable > 0`, lectura fresh) — o el bono suelto está apagado,
  el multiplier no está permitido o el monto sale de fixed_min/max — cae al
  **depósito CON `multiplier`** de antes (mismo candado, figura como Carga, warn
  en logs) para no PISAR el bono en curso. Con rollover 0 = regalo directo (bono
  0). Misma reference `vip-fire-*` en todas las ramas. El viejo requisito de
  cargas (milestone.requireDeposits) ya NO se chequea (campos ignorados).
- **Devolución de retiro rechazado** (`vip-payoutref-*`) sigue siendo DEPÓSITO a
  propósito: no es un regalo, es plata real que vuelve (decisión 2026-09-07).
- `depositToUser` acepta `wagering` opcional (`multiplier`, `bonus_percent`,
  `bonus_amount`, `bonus_multiplier`). Caso raro documentado: la carga se acredita pero
  el bono falla (`wagering.bonus.status === 'failed'`) → se marca `bonusFailed` y se
  loguea en ERROR. **No reintentar el depósito completo** (la reference devolvería
  duplicate): escalar a soporte de 1girox.

### 4.6 Stats por jugador — netwin y apostado (Partner API v1.8/v1.9)

**Actualizado 2026-08-03.** Desde la v1.8/v1.9 (2026-07-31, WORKLOG #101) los stats
salen de la MISMA Partner API, con la misma `X-Api-Key` y por **username**:

- `GET /players/{username}/stats?from&to` → `girox.getPlayerStats()`.
- `POST /players/stats/batch` (hasta **100 usuarios** por request) →
  `girox.getPlayersStatsBatch()`. Es lo que hace viables los referidos y el motor
  VIP sin comerse el cupo de 60 req/min.
- Devuelven `totals` + `categories.casino/sports`, cada uno con `bets_count`,
  **`wagered` (apostado)**, `payout` y `netwin` — todo en **PESOS**.
- ⚠️ `netwin` POSITIVO = el jugador PERDIÓ (base del reembolso); negativo = ganó.
- **Bloque `bonus`** (soporte 1girox 2026-09-10, sección 2.10 del manual
  actualizado): `bonus.granted` = bono OTORGADO al jugador en el rango,
  `bonus.still_locked` = cuánto sigue con rollover. A nivel jugador, no por
  categoría. `getPlayerStats`/batch lo exponen como `bonusGranted` /
  `bonusStillLocked` (0 si la API no lo manda). Es el dato oficial para reembolsar
  sobre plata REAL (`netwin − granted`). NO existe "qué parte de cada apuesta fue
  bono": el bono entra al saldo unificado. Diagnóstico: `GET /api/admin/girox/
  stats-raw?username=X&days=30` (solo admin general, respuesta cruda).
- Rango **máximo 92 días** por consulta, evaluado en **hora argentina** del lado de
  la plataforma (`formatStatsDate` ancla a -03:00).
- **Sólo CASINO** por decisión del owner (2026-07-31): reembolsos y comisiones usan
  `casinoNetwin` (`GIROX_NETWIN_SCOPE=total` incluiría sports); el motor VIP usa
  `categories.casino.wagered` (`VIP_WAGER_SCOPE=total` ídem).
- El `not_found` del batch mezcla "no existe" y "no es tuyo" a propósito (lo aclara
  el manual): se trata igual — sin stats.

**La comisión de referidos no viene del proveedor:** 1girox devuelve todos los campos
`commission` en 0, así que la tasa es NUESTRA: `GIROX_REFERRAL_COMMISSION_PCT`
(default **8%** del netwin = owner-revenue), y sobre eso va la tasa del referidor.

**`giroxUserId`** — el propio `stats` devuelve el ID numérico del jugador y los flujos
lo persisten "gratis" (update condicional sólo si estaba vacío). Ya NO bloquea nada:
todo va por username.

🪦 **Lo que había acá antes:** `giroxReportsService.js` scrapeaba el panel
`admin.1girox.com` con un Bearer de sesión auto-renovable (base64+deflate) y el ID se
buscaba con `POST /users/fetch` (LIKE ambiguo). Era el punto más frágil de toda la
integración. **ELIMINADO el 2026-07-31** junto con `GIROX_ADMIN_USER/PASS/TOKEN`,
`GIROX_ADMIN_BASE_URL` y `GIROX_AGENT_USER_ID`.

### 4.7 Migración de la base (`scripts/migrate-users-to-girox.js`)

- **Dry-run por default**: sin flags no escribe nada (ni en Mongo ni en 1girox); para
  escribir hay que pasar `--execute`. Un argumento desconocido ABORTA. Otros flags:
  `--limit=N`, `--username=xxx`, `--retry-errors`.
- **Throttling**: cada usuario consume hasta 3 llamadas (existe? + alta + búsqueda del
  ID). Default `GIROX_MIGRATION_DELAY_MS=2500` (~24 usuarios/min). Si aparecen 429,
  **SUBIR** el delay: la cuota es compartida con producción.
- **Reanudable e idempotente**: el estado vive en Mongo (`giroxSyncStatus` /
  `giroxUserId`), no en un archivo. Los `synced`/`linked` con ID se saltean; a los que
  tienen cuenta pero les faltó el ID sólo se les reintenta el ID.
- **Las contraseñas NO se migran**: las locales son bcrypt, irrecuperables por diseño.
  Cada cuenta se crea en 1girox con una clave random fuerte que no se guarda en ningún
  lado, y el usuario queda con `giroxPasswordSynced:false`. No deja a nadie afuera: al
  casino se entra por SSO. La clave real se replica en el próximo login o cambio de
  contraseña en VIPCARGAS (server.js ~L3614) y ahí pasa a `true`.
- **No toca `jugaygana*`**: se conservan para revertir.
- Usernames válidos en 1girox: **3-18 caracteres, sólo `[A-Za-z0-9_]`**. Los que no
  pasan quedan en `giroxSyncStatus:'invalid_username'` y necesitan decisión manual.

### 4.8 Variables de entorno

Todas **lazy**: se leen en runtime, NUNCA en el `require()` (SSM carga después) —
por eso `giroxService`/`giroxReportsService`/`giroxPublisherKeys` usan getters y
construyen el cliente HTTP on-demand. Congelarlas en una const de módulo es el bug que
tenían los 4 clientes viejos.

| Variable | Default | Para qué |
|---|---|---|
| `PLATFORM_MODE` | `manual` | `manual` = GANAMOS sin API/bandeja (§0); **#191** `ganamos_api` = API del panel de agente (§0.1); `girox` = Partner API de 1girox |
| `GANAMOS_AGENT_USER` / `GANAMOS_AGENT_PASS` | — | **#191** Usuario y clave del AGENTE para `PLATFORM_MODE=ganamos_api`. **SSM, nunca en el repo** |
| `GANAMOS_AGENT_API_URL` | `https://agents.ganamos.co` | Base de la API del panel de agente |
| `GANAMOS_PROXY_URL` (o `PROXY_URL`) | — | **#193** Proxy de salida SOLO para el tráfico a la API de GANAMOS (`http://user:pass@host:port`, via `https-proxy-agent`). Cloudflare bloquea las IPs de datacenter (Render/AWS) con 403 → un proxy residencial argentino puede pasar. El boot y el "login OK" dicen `proxy host:puerto` |
| `GANAMOS_OP_DEPOSIT` / `GANAMOS_OP_WITHDRAW` | `0` / `1` | Códigos de operación de `payment` (retiro A CONFIRMAR) |
| `GANAMOS_PLAY_URL` | `https://ganamos.io` (placeholder) | URL pública de GANAMOS que abre el botón CASINO en modo manual. **Cargar la real en SSM** |
| `PUBLIC_REGISTER_ENABLED` | — | `1`/`true` = reabre el registro público en modo manual (default: alta sólo por agente, 410) |
| `BRAND_NAME` | `GANAMOS` | Marca que devuelve `GET /api/public/config` |
| `GIROX_API_URL` | — | Base de la Partner API, sin barra final (ej. `https://api.1girox.com/api/v1`) |
| `GIROX_API_KEY` | — | Header `X-Api-Key` de la cuenta MASTER (`pk_...`). **SSM, nunca en el repo** |
| `GIROX_PLAY_URL` | `https://1girox.com` | Sitio del jugador (fallback si el SSO falla) |
| `GIROX_NETWIN_SCOPE` | `casino` | `casino` \| `total` (incluiría sports) en reembolsos/comisiones |
| `GIROX_MAX_RPM` | `55` | Techo local de requests/min **por instancia** |
| `GIROX_REFERRAL_COMMISSION_PCT` | `8` | % de netwin que es owner-revenue (el proveedor ya no la informa) |
| `VIP_USD_ARS_RATE` | `1500` | Tasa USD→ARS de los umbrales VIP (los umbrales de Stake están en USD) |
| `VIP_WAGER_SCOPE` | `casino` | Qué apostado suma para el nivel (`casino` \| `total`) |
| `VIP_WAGER_EPOCH` | `2026-07` | Primer mes que se acumula (cuando arrancó 1girox) |
| `VIP_ACTIVE_DAYS` | `3` | Días de `lastLogin` que definen "activo" para el tick de 30 min |
| `GIROX_API_KEY_CONSULTAS` | — | Pool de keys SOLO-LECTURA coma-separadas, sufijo `:rpm` opcional (§4.3) |
| `GIROX_PUBLISHER_MAX_RPM` | `30` | Techo local por instancia de las keys de publicista |
| `GIROX_PUBLISHER_KEY_RPM` | — | Overrides `pk_x:rpm` por key de publicista puntual |
| `GIROX_PLAYER_CACHE_MS` | `8000` | TTL del cache de lectura de jugador/saldo |
| `GIROX_STATS_CACHE_MS` | `90000` | TTL del cache de netwin (status de reembolso) |
| `LANDING_SIGNUP_MAX_PER_IP_HOUR` | `8` | Límite de altas por landing por IP/hora (§4.10) |
| `LANDING_SIGNUP_DISABLED` | — | `true` = apaga el alta por landing (410) |
| `SSM_SKIP_KEYS` | — | Claves que SSM NO pisa (solo entornos clon; `loadSecrets.js`) |
| `META_PIXEL_ID_2` / `META_CAPI_ACCESS_TOKEN_2` / `META_TEST_EVENT_CODE_2` | — | 2º pixel CAPI del partner de tracking (mismo `event_id`, envío en paralelo) |
| `GIROX_GIFT_AS_BONUS` | (on) | `0`/`false`/`off` = los regalos vuelven a depósito libre en vez de bono 0 (§4.5). Kill switch sin deploy |
| `TELEGRAM_ALERT_BOT_TOKEN` / `TELEGRAM_ALERT_CHAT_ID` | — | Bot + grupo de Telegram para las BAJADAS y el CIERRE DIARIO del banco (#183, `src/services/telegramAlertService.js`). Sin ambos, no se manda nada |

Opcionales/afinado: `GIROX_TIMEOUT_MS` (20000) y las `GIROX_MIGRATION_*` del script.
🪦 `GIROX_ADMIN_*` y `GIROX_AGENT_USER_ID` se fueron con el scraping del panel (#101).

Si falta la config, el arranque lo grita por consola: `girox.isEnabled()` se chequea
en el bootstrap (y `GET /api/admin/girox/health` es el diagnóstico completo).

### 4.9 Login único (SSO) — el botón CASINO

`POST /api/platform/session` (alias histórico `POST /api/auth/platform-login`,
mismo handler, ~L4250) → `girox.createSession(username)` →
`POST /players/{username}/session` de 1girox → **`redirect_url` con un código de UN
SOLO USO que vence a los 60 segundos**. No se cachea ni se persiste; el front redirige
apenas lo recibe. **No se le pide la contraseña al usuario**: ya está autenticado en
VIPCARGAS con su JWT, y el cliente nunca más necesita conocer su clave del casino.

- ⚠️ **Trampa del bloqueador de pop-ups** (`VIP.ui.enterCasino`, `public/js/ui.js`): el
  link viene de un fetch asíncrono y los navegadores —sobre todo en mobile— bloquean
  `window.open` fuera del gesto del usuario. Por eso **la pestaña se abre PRIMERO,
  vacía** (con un "🎰 Entrando al casino…"), y recién después se le cambia la URL. Si
  igual la bloquearon, se navega en la pestaña actual. Si el SSO falla, se cierra la
  pestaña y se cae al modal de acceso manual. Hay guard anti-doble-click
  (`_casinoOpening`). **No mover el `window.open` después del `await`.**
- **Auto-reparación**: si 1girox responde `player_not_found` (usuario que el script de
  migración no alcanzó, o creado mientras la migración corría), el backend lo crea al
  vuelo con una contraseña random, actualiza `giroxSyncStatus` y reintenta UNA vez.

### 4.10 Alta por LANDING externa (2026-08-19)

`POST /api/landing/signup` (público, sin auth): una landing en un dominio puente
(`landing/index.html`, archivo suelto — NO en `public/`) pide SOLO un nombre →
username único derivado (base saneada + sufijo aleatorio, reglas de 1girox +
colisión local CI) + PIN de 6 dígitos → se crea en **1girox PRIMERO** (key del
publicista si la campaña la tiene → `giroxOwnerCampaign`; si no la master; si
falla, no queda cuenta local huérfana) → `User` con
`acquisitionSource:'landing'` (valor del enum) y `phoneVerificationPending`
(el SMS se exige recién al RETIRAR) → responde `{ accessUrl, username,
password }`. El `accessUrl` es el access-link de un solo uso + `&ir=casino`
(la PWA abre el casino directo al loguear) y su canje **NO fuerza
`mustChangePassword`** para cuentas de landing (ya vieron su clave en
pantalla). Anti-abuso: `landingIpLimiter` por IP/hora + kill-switch
`LANDING_SIGNUP_DISABLED`. CORS: ese path tiene CORS REFLEJADO (los dominios
puente rotan) y se saltea el `cors()` estricto global — ver el middleware
antes del `app.use(cors(...))` en server.js. Conversión: CompleteRegistration
a Meta CAPI (`signup_landing`) + webhook fb-ads.

### 4.11 Novedades del manual Partner API v1.11 (2026-08-13) — contexto, sin código

(El PDF no está en este repo — si se consigue, guardarlo como
`docs/PARTNER-APIv1.11.pdf`, igual que el repo original.)

1. **v1.11 — `agent_id` en `POST /players` + `GET /agents`:** la key de la
   cuenta raíz puede crear un jugador colgado de un sub-agente de su red, y
   `GET /agents` lista el subárbol (sirve de diagnóstico: una key de
   publicista devuelve lista vacía). ⚠️ Probado en vivo (en el repo original):
   es "crear y ENTREGAR" — apenas el jugador nace bajo el sub-agente, la key
   creadora recibe `404 player_not_found` en lectura Y en depósito. **NO
   reemplaza el ruteo por keys de publicista** (el pool por publicista, §4.3,
   sigue siendo la solución). Error nuevo: `422 agent_not_allowed`.
2. **v1.10 — bono con `multiplier: 0` = regalo directo:** se acredita
   disponible/retirable al instante, sin reclamo, y **ya no pisa el bono en
   curso**. **IMPLEMENTADO 2026-09-07** como vía por defecto de todos los
   regalos (§4.5). Queda PENDIENTE (sin pedido del owner): relajar los guards
   bono-sobre-bono para regalos con multiplicador 0 (hoy siguen estrictos).
3. **v1.12–1.15 (manual en `docs/PARTNER-APIv1.15.pdf`):** reglas automáticas
   de bono del agente (`promo_code` / `no_bonus` en el depósito, `bonus.auto_rules`
   en `GET /config`; un `/deposit` sin params de bono HEREDA la campaña vigente
   del agente — si el owner configura una "promo 1er depósito" en su panel, las
   cargas por API la aplican solas), `embed:true` en `/session` (oculta los
   controles de sesión del casino en el iframe), `GET /chip-requests` (listado de
   solicitudes de carga/retiro, requiere habilitación del operador) y whitelist
   de IPs por key (`401 ip_not_allowed`). Nada de esto está cableado.

## 5. Flujos principales

- **Username tomado por OTRA estructura de 1girox (2026-09-07):**
  `syncUserToPlatform` devuelve `code:'username_taken_foreign'` cuando el nombre
  está tomado en la plataforma pero nuestra key no lo ve (los usernames son
  únicos en TODA la plataforma, la visibilidad es por rama). TODAS las altas
  rebotan con 400 sin dejar cuenta local (registro, register-quick, POST
  /api/users, POST /api/admin/users — borran la local recién creada —, alta del
  publicista — sync ahora con await inline). El SSO marca `giroxSyncStatus:
  'error'` en cuentas ya rotas. No se rescatan: username nuevo.
- **Registro**: `POST /api/auth/register` (user+pass; OTP solo si manda teléfono) o
  `register-quick` (link de pauta con campaignCode válido, sin SMS,
  phoneVerificationPending=true → no puede retirar hasta verificar). Crea en 1girox
  PRIMERO (`girox.syncUserToPlatform`); guarda atribución, fbc/fbp, registrationIp.
  Crea ChatStatus solo el flujo público (los usuarios creados por admin/publisher NO —
  evita chats vacíos).
- **Login**: `POST /api/auth/login` (~L3361). `findUserByUsernameCI` con
  `critical:true` (fallback regex SIEMPRE disponible — nadie queda afuera). Si no existe
  local pero SÍ en 1girox, se crea la cuenta local al vuelo (cubre jugadores que nunca
  pasaron por VIPCARGAS). Soporta login por teléfono, OTP y `temporaryCode`. Roles staff
  reciben las cookies admin. JWT 30d (registro: 90d). **Efecto lateral importante**: si
  el usuario todavía tiene `giroxPasswordSynced:false`, acá se aprovecha que la clave
  viaja en claro para replicarla en 1girox (fire-and-forget, una sola vez por usuario).
- **Alta por publisher_admin**: `giroxPublisherKeys.createUserAsPublisher(campaignCode)`
  firma el `POST /players` con la **API key de la campaña**, así el jugador queda colgado
  del publicista correcto en la jerarquía. Sin key configurada (o si falla) → fallback a
  `girox.syncUserToPlatform` con la key master. ⚠️ Si el username YA existía en 1girox,
  queda bajo el agente que lo creó primero: recrearlo con otra key NO lo mueve de rama.
  Cargas, retiros y bonos van SIEMPRE por la key master (los depósitos salen del saldo
  del dueño de la key — que es lo que queremos).
- **Pauta / vanity URL**: `GET /:code` matchea Campaign.code exacto (DB directa) o slug
  del publisher (cache 30s). Setea cookie httpOnly `vip_campaign` (60 días) → el server
  reinyecta el código en CADA carga SPA (`renderIndexHtml`) para que "registro sin SMS"
  sea determinístico (las webviews de Meta rompen localStorage).
- **Bienvenida**: `POST /api/messages/welcome` — mensajes de SISTEMA + upsert de
  ChatStatus. Throttle 24h server-side. Guard `_isStaleClientWelcome` descarta
  bienvenidas-fantasma de PWA cacheadas viejas.
- **Multicuenta por TITULAR del comprobante (2026-09-16, #184, espec §B):**
  `_findHolderConflict(userId, holderName)` cruza el titular que leyó la IA contra
  comprobantes verificados de OTRAS cuentas (`originHolderKey` o nombre exacto para
  filas viejas) y movimientos bancarios de OTRAS cuentas (`fromKey`/`fromName`). Se
  usa (1) al verificar el comprobante → nota admin-only "🚨 MULTICUENTA POR TITULAR";
  (2) en `hgcashAutoCarga` tras el cruce de identidad bancaria (`_bankIdentityOr`) →
  la carga entra igual + alerta (acá la auto-carga no aplica bonos automáticos);
  (3) en el fraud-check del panel (señales `bank` 🏦 y `receipt_holder` 🧾). No
  bloquea a nadie solo (homónimos, cuentas familiares): avisa. Fail-open.
- **Chat**: HTTP `POST /api/messages/send` + socket `send_message` (misma lógica
  duplicada: validaciones, comandos `/`, SLA, comprobantes). Imagen de cliente →
  `analyzeComprobanteFromMessage` (IA, fire-and-forget) → aviso adminOnly
  (duplicado/verificado/manual) → `hgcashMatchFromComprobante`.
- **Carga manual**: `POST /api/admin/deposit` → `girox.depositToUser` con
  `reference = vip-dep-<txId>` (el uuid se genera ANTES de llamar y después se reusa
  como `Transaction.id`: así una operación de 1girox se rastrea hasta su fila local y
  viceversa). El bonus va como segunda llamada (`vip-depbonus-<txId>`); el mensaje al
  cliente refleja el resultado REAL y si el bonus falla → alerta adminOnly.
  Consume PromoBonus vigente y movimiento hgcash
  pendiente del mismo monto (`hgcashConsumeOnManualDeposit`). Mensajes `/sys_deposit*`,
  `/sys_reminder`, `/sys_install_app`, `/sys_recover_100`.
- **AUTO-CARGA hgcash** (`POST /api/hgcash/webhook`, firma HMAC sobre rawBody,
  fail-closed en prod): guarda BankMovement → matching contra Comprobantes por
  monto + (N° operación==coelsa/externalID, o nombre de origen + destino consistente)
  dentro de una ventana (60min desde comprobante / 10min desde movimiento). Ambigüedad
  → NO carga. `hgcashAutoCarga`: claims atómicos de movimiento y comprobante → modo
  sombra o real → **mínimo $2.000** (menor → needs_review + aviso) → candado
  HgcashCharge por coelsa → guard anti-duplicado (misma carga <8min → needs_review) →
  `depositToUser` con `reference = vip-hg-<coelsa|movementId>` (**doble candado**: el
  índice único de HgcashCharge de nuestro lado y la idempotencia de 1girox del otro) →
  Transaction + mensaje + SLA. Fallo → se BORRA el HgcashCharge y es reintentable hasta
  3 veces (la reference estable impide que el reintento duplique la carga).
  **Fan-out** (#94): reenvía el webhook crudo+firma a autoreembolsos.com
  (`HGCASH_FANOUT_URL`, 'off' para apagar).
  **BANDEJA DEL BANCO (#183, réplica del #155 del gemelo):** manda el MOVIMIENTO, no
  la foto. Todo entrante `done` termina en un estado: cargado auto (foto matcheó) ·
  **asignado** por un agente desde panel→🏦 Banco (`POST /api/admin/bank/movements/:id/
  assign` → `hgcashAutoCarga` con `assign`, mismo candado por coelsa, MISMA reference
  `vip-hg-*`, sin comprobante, sin mínimo, red anti-duplicado saltable con `force`) ·
  **manual anclado** (el modal Depositar manda `movementId`: monto exacto, claim
  atómico antes de acreditar, `chargeSource:'manual_link'`; sin movimiento, `origin`
  otro_banco|sin_movimiento) · vinculado a una carga manual ya hecha (`/link`) ·
  "no corresponde" (admin, con motivo). `hgcashConsumeOnManualDeposit` además
  retro-vincula por TITULAR (`fromKey` vs `originHolder` del comprobante, 6 h).
  Salientes clasificados por externalID (`sweep-<id>` bajada / pago / unknown).
  El panel se actualiza por socket `bank_movement` (doc entero, sin `raw`) sin
  recargar — `_emitHgcashUpdate(kind, movementId)`. `BankMovement.chargeSource/
  transactionId` y `Transaction.metadata.{movementId, origin}` son los vínculos en las
  dos direcciones que el cierre cruza. `hgcashAutoCarga` devuelve `{ok, reason|txId}`.
- **Bajadas** (#183): `POST /api/admin/bank/sweeps` (admin|withdrawer) → cash-out hgcash a
  un CBU externo (destino guardado en `Config['sweepDestinations']`, CBU o alias resuelto),
  externalID `sweep-<id>`; el webhook de estado (`_handleSweepStatusWebhook`) y el movimiento
  saliente (`outKind:'sweep'`) se vinculan solos. Telegram "🏦 BAJADA". Registro en BankSweep.
- **Cierre diario** (#183, `src/services/bankCloseService.js`): 3 cruces del día ART —
  banco↔sistema (entrantes sin acreditar / cargas sin transferencia ni origen / salidas sin
  pago ni bajada; vincula y PERSISTE pares inequívocos usuario+monto ±3 h), cajero 1girox
  (Σ opAmount de CashierSnapshot vs delta de saldo, tolerancia $5 — **hoy `sin_datos`**, la
  API no informa el saldo del agente) y errores (pago sin `debitConfirmed`, pago hgcash
  sin movimiento, ambiguos sin resolver). Cron `_runDailyCloseTick` a las 00:05 ART (claim
  `Config['dailyclose_last']`) → Telegram con arrastre + socket `bank_close`. Panel→🏦
  Banco→Cierre: recalcular, resolver diffs con nota (admin).
- **Retiro self-service**: `POST /api/withdrawal/request` — exige phoneVerified, lock
  anti-doble, chequeo de saldo (UX), dedup 10min → crea PendingPayout
  (`deductAtPay:true`, SIN descontar) → mueve el chat a Pagos. El AGENTE confirma:
  `POST /api/admin/payouts/:id/pay` → `_deductChipsAtConfirm` (saldo **`available`**, no
  `balance` — ver §4.5 → `withdrawFromUser` con `reference = vip-payout-<payoutId>` →
  verificación anti-fantasma de que bajó) → cash-out hgcash (externalID=payout.id =
  idempotencia; retry con accountId fresco ante 403) → webhook/poller confirma DONE →
  aviso `/sys_payout_paid` + comprobante PDF (foto vía mupdf + link permanente
  `/api/payout-receipt/:id`). Rechazo (`/cancel`): si NO se descontó → nada que
  devolver; si se descontó → devolución (split bonus/fichas para pagos legacy).
  `pay-other-bank` = pago manual (descuenta igual). Poller `_pollPayingPayouts` cada
  45s (últimas 2h) cubre webhooks perdidos.
- **REEMBOLSO EN VIVO acumulativo de por vida** (2026-09-11, espec completa en
  `docs/ESPEC-REEMBOLSO-1GIROX.md`; aritmética PURA en `src/utils/cashbackFormula.js`
  validada por `scripts/test-cashback-formula.js`; motor `_cashbackStateToday` en
  server.js tras `_refundReference`):
  `reclamable = floor(pct% × max(0, netoDePorVida − regalado) − cobrado)`, capado
  por `topeDiario − cobradoHoy`, con mínimo. `netoDePorVida` = `User.
  cashbackCarryNet` + netwin casino (ancla → hoy): cuando el tramo vivo pasa los
  85 días se PLIEGAN 60 días al carry con `updateOne` condicionado al ancla previa
  (multi-instancia safe). `regalado` = por tramo (< ancla / ≥ ancla) el MAYOR
  entre nuestras Transactions de regalo (`deposit.bonus` + bonus/fire_reward/
  refund/rakeback/vip_levelup/referral_commission/roulette, INCLUIDO el propio
  cashback cobrado → sin "reembolso del reembolso") y el `bonus.granted` oficial.
  ⚠️ La Transaction 'bonus' aparte de la carga con bonus del agente
  (`metadata.source:'deposit_bonus'` / "Bonificación incluida en depósito…") se
  EXCLUYE: ya está en `deposit.bonus`. La suma local matchea por `userId` O
  `username` (Transactions viejas de reembolso sin userId). Una ganancia grande
  resta PARA SIEMPRE; al reclamar queda en 0. Reclamo (`POST /api/cashback/
  claim`): recalcula fresh → reserva CashbackClaim (índice único userId+dateKey+
  seq) → guard 20 s contra otro reclamo → `_creditGiftWithRollover` (= el helper
  del fueguito: `/bonus` con el rollover del panel; cae a depósito CON multiplier
  si el jugador tiene bono activo o el feat no está) con reference `vip-cbk-*` →
  Transaction `bonus` + `metadata.source:'instant_cashback'` + nota admin-only.
  Config `Config['instantCashback']` ({enabled, pct, rolloverX, minArs,
  maxDailyArs}; default APAGADO) desde la card "📉 Reembolso en vivo" del panel
  (solo admin general). Status `GET /api/cashback/status` (`?fresh=1` con
  cooldown 30 s).
- **Reembolsos**: `POST /api/refunds/claim/{daily|weekly|monthly}` — lock Redis,
  ventanas de `models/refunds.js` (semanal: lunes/martes; mensual: desde día 7),
  rangos en hora ART de `src/utils/periodRanges.js`, NETWIN real de
  `girox.getPlayerStats(username, …)` (**sólo casino**, ver §4.6; por username, sin
  gate de ID). **Desde 2026-09-11 (espec §5):** `netLoss = max(0, casinoNetwin −
  bonusGranted)` del período (lo perdido de regalos no genera reembolso) y del
  monto calculado se resta lo ya cobrado como REEMBOLSO EN VIVO dentro del
  período (`_cashbackPaidBetween`) — en el status y en los 3 claims.
  El % sale del RANGO por pérdida del período
  (`src/utils/refundTiers.js`). **Desde 2026-08-05 los rangos son EDITABLES desde
  el panel y CADA PERÍODO tiene su propia escalera** (diario ≠ semanal ≠ mensual):
  `Config['refundTiersByPeriod']` (`{daily/weekly/monthly: [{name,pct,max}]}`),
  leída SIN cache por `getRefundTiersByPeriod()` (server.js) con fallback a
  `DEFAULT_TIERS` (3/6/10%) por período si falta/es inválida. Validación en
  `refundTiers.normalizeTiers` (1-6 rangos, % 0-100, umbrales crecientes, último
  sin techo). Endpoints `GET/POST /api/admin/refund-tiers` (solo admin general);
  el POST devuelve `commandWarnings` = comandos `/sys_*` cuyo texto menciona
  porcentajes (esos se editan A MANO desde COMANDOS). El status manda
  `tiersByPeriod` (+ `tiers` legacy = la del diario). Los viejos
  Config['refundPercents'] quedaron `enUso:false` y su card del panel fue
  reemplazada por el editor de rangos. **El RefundClaim se CREA antes de acreditar** (el índice único
  `userId+type+periodKey` es el candado atómico contra doble cobro; si el crédito
  falla se borra la reserva). El crédito va por `creditUserBalance` = **bono 0
  "regalo directo"** (§4.5; antes depósito libre) con la reference derivada del período.
  Ver #96 y §4.4. ⚠️ En la UI los reembolsos muestran SOLO el % — los nombres
  Bronce/Plata/Oro son del nivel VIP (abajo). **Mínimos para cobrar (2026-08-14):**
  `Config['refundMinimums']` = `{weekly:1500, monthly:5000}` (0 = sin mínimo; el
  diario no tiene), leída SIN cache por `getRefundMinimums()`. Si el reembolso
  CALCULADO da > $0 pero menos que el mínimo, el claim rechaza ANTES de la
  reserva atómica (no quema el una-vez-por-período) con el mínimo VIGENTE en el
  mensaje + `belowMinimum/minAmount`; el status expone `minAmount`/`belowMinimum`
  por período. Editables en la misma card del panel (POST acepta `minimums`
  OPCIONAL: un panel viejo cacheado no los pisa).
- **Lotes de notificaciones con regalo** (NotifBatch, 2026-08-14): envío masivo
  (o código público) con regalo. `percent` → PromoBonus `sourceRuleCode:'lote'`
  (cartel verde, LO APLICA EL AGENTE, exento del cap 30%); `fixed` → fichas
  AUTOMÁTICAS por `_creditNotifBatchGift` con **LEDGER DE INTENCIÓN**: la
  Transaction `bonus` (`metadata.source:'notif_batch'`, no cuenta como carga)
  se escribe ANTES de acreditar (status 'pending') y se completa después — da
  idempotencia real ante crashes (el reintento saltea el guard bono-sobre-bono
  y resuelve por `duplicate:true` con la reference estable `vip-nbatch-*`) y
  hace que los caps anti-abuso (3 créditos/24h, $300.000/7d por usuario
  cruzando todos los lotes; cuenta pending+completed → no se evaden por
  concurrencia) no dependan de un write fire-and-forget. Tope pasado →
  bloqueo + alerta `security_alert` (toast rojo en el panel + nota
  admin-only). Guard bono-sobre-bono solo en el PRIMER intento; auto-claim
  v1.7. Envío por motor reanudable (§7), NUNCA en la request; al VENCER el
  lote (`expiresAt`) el motor cierra los pendientes sin acreditar ni
  notificar (anti lote-zombie: la cola procesa los 20 más viejos). Los textos
  automáticos al cliente son editables por COMANDOS (`/sys_lote_aviso_*` para
  el bloque del regalo, `/sys_lote_canje_*` para el canje). Canje de códigos: hook
  `_tryClaimNotifBatchCode` al principio de `POST /api/community-code/claim`
  (null = no es de lote → sigue el welcome code intacto); membresía sin revelar
  códigos ajenos; público con append atómico + cupo (`$expr $size`); SIN gate
  de app instalada a propósito. Rollover del fixed validado contra
  `bonus.multipliers` (⚠️ no `rollover.multipliers`). Endpoints
  `/api/admin/notif-batches` (+`/preview`, `/:id`): enviar/preview
  admin+depositor, historial también withdrawer. La PWA canjea desde el modal
  "🎁 Reclamar Bono con Código" (los estados pending/used/credited del welcome
  code muestran un input extra para códigos de lote).
- **Niveles VIP** (2026-08-03, réplica de Stake): se sube por APOSTADO acumulado de
  por vida (buckets `VipWagerMonth`, ver §2 y el motor en
  `src/services/vipLevelService.js`). Escalera en `src/utils/vipLevels.js`: umbrales
  de Stake en USD × `VIP_USD_ARS_RATE` (1500) — Bronce $15M ARS … Diamante V $750.000M.
  Cada nivel destraba: (a) **bono one-time** al alcanzarlo (lo acredita el motor con
  depósito libre, reference `vip-lvl-<userId>-<idx>`, aviso por chat+push vía
  `/sys_vip_levelup`; `duplicate:true` = otra instancia ya pagó → no re-notificar) y
  (b) **rakeback semanal**: `POST /api/vip/rakeback/claim` paga `rakebackPct` del
  APOSTADO de casino de la semana pasada (gane o pierda) — mismo patrón de reserva
  atómica que los reembolsos (RefundClaim type `rakeback`, periodKey
  `rake:<lunes>`, reference `vip-rake-<lunes>-<userId>`). Estado:
  `GET /api/vip/status` (nivel, progreso, escalera, rakeback). El nivel NUNCA baja;
  `lifetimeWagered` sólo se escribe con `$max`. **On/off desde el panel** (SOLO admin
  general, `GET/POST /api/admin/vip-levels` → flag `vip_levels_disabled` en Config;
  apagado = no acumula, no paga, la PWA oculta la sección; reactivar recupera todo
  solo porque los buckets se recalculan con `$set`).
- **Referidos**: preview/calculate (delta incremental sobre ledger de payouts) /
  payout (acredita con `giroxService.creditUserBalance`, reference
  `vip-refcom-<payoutId>` reusando el documento de intentos fallidos). El revenue sale
  del netwin del panel × `GIROX_REFERRAL_COMMISSION_PCT` (8%) y sobre eso la tasa del
  referidor (7%). Ver §4.6.
- **Ruleta diaria** (#188, premios y elegibilidad EDITABLES): `Config['dailyRoulette']`
  = `{ prizes:[{label, emoji, type, value, rolloverX, weight}], minCargas30d,
  requireApp }` (`getDailyRouletteConfig`; default = pirámide histórica + 10 cargas +
  app). Elegible = (app instalada si `requireApp`) + MÁS de `minCargas30d` cargas
  reales en 30 días; si no, la PWA muestra la celda bloqueada con las cargas que
  faltan. Pick ponderado por `weight` + **budget pacing** (solo dinero). Premio
  `cash` → `girox.creditGift` con el `rolloverX` de la fila (el global lo pisa),
  reference `vip-roulette-<spinId>`; `credit_failed` → retry con la MISMA reference.
  Premio `percent` → pendiente en el User (+X% en la PRÓXIMA carga; el modal Depositar
  del panel lo sugiere y `_consumeRoulettePercent` lo marca usado al cargar con bono,
  o a mano con `POST /api/admin/users/:id/roulette-percent/use`). Escribe
  `Transaction type:'roulette'` (dinero; idempotente por `metadata.spinId`).
  Admin: `GET/PUT /api/admin/roulette/config`.
- **Fueguito**: reclamo diario sin requisitos; premios de hitos (editables en panel,
  Config['fireMilestones']) exigen actividad de cargas y expiran el mismo día. Crédito
  con depósito libre (`vip-fire-<userId>-d<día>-<fecha>`).
- **Bono por instalar la app** (#100: % en la PRÓXIMA carga, lo aplica el agente; ya no
  acredita monto): exige standalone real (token FCM), teléfono verificado (salvo creado
  por agente), anti-multicuenta por token, reserva atómica. **#188 regla con TOPE:**
  `Config['installBonus'] = { pct, capArs, excessPct }` (default 100% hasta $5.000 +
  20% del resto; `computeInstallBonus`, `installBonusRuleText`; `GET/POST /api/admin/
  install-bonus`). Todos los textos la muestran (cartel, `/sys_install_bonus` con
  `{pct} {tope} {excedente} {regla}`, Información del Servicio). **#189: lo aplica el
  SERVER solo** — `_pendingBonusFor(user, amount)` (bono instalación + % de ruleta) se
  usa en `/api/admin/deposit` (reemplaza el bono del agente si hay pendientes) y en
  `hgcashAutoCarga` (bonus nativo en la misma operación, salvo multicuenta); al éxito
  `_settlePendingBonuses` marca `firstChargeBonusStatus:'used'` y consume el % de
  ruleta. El botón manual "Marcar como usado" sigue para casos raros.
- **Link de acceso de un solo uso** (2026-08-03): el admin general o un DEPOSITOR
  generan `?acceso=<token>` para un cliente (`POST /api/admin/users/:userId/access-link`,
  también desde el alta del panel; regenerar pisa el anterior). En `User` vive SOLO
  el sha256 (`accessLinkHash`). El canje (`POST /api/auth/access-link`, público +
  authLimiter) borra el hash EN EL MISMO findOneAndUpdate (single-use a prueba de
  carreras), fuerza `mustChangePassword` y emite el mismo JWT del login → la PWA
  (auth.js `tryAccessLink`, disparado en el arranque por app.js) guarda el token,
  limpia la URL del historial y `verifyToken()` abre el recuadro obligatorio de
  crear contraseña (estilo WhatsApp claro/oscuro; piso front: 8+ chars con letras
  y números). No hay botón de logout en la app (eliminado a pedido del owner).
- **SLA demoras**: reloj en ChatStatus (`delayClockOnUserMessage`/`delayClockResolve`);
  responder (mensaje/comando/carga/retiro/CBU) o cerrar lo resuelve; sobre-umbral →
  ChatDelay. Reporte `GET /api/admin/chat-delays` (solo admin).

## 6. Front-end: PWA cliente y panel admin

### PWA (`public/`)
- Namespace global `window.VIP` (`VIP.config`/`VIP.state` en config.js; módulos IIFE:
  auth, socket, chat, ui, refunds, fire, roulette, reviews, promobonus, notifications,
  withdraw, installbonus, notifsurvey, publisherwelcome, campaign, meta-pixel, apptest,
  app). El orden real de carga está en index.html (el comentario de app.js está viejo).
- **SW único**: `firebase-messaging-sw.js` (CACHE_VERSION se bumpea por release —
  ver el valor actual en el archivo) — FCM + caché: `/js/` y `/css/`
  stale-while-revalidate (deploy llega en la SIGUIENTE carga sin bumpear versión),
  `/app.js` y manifest network-first, API/socket nunca. `user-sw.js` es un stub de
  auto-desregistro (no volver a registrarlo).
- **Header del chatScreen** (2026-08-03): [botón Información | menú hamburguesa ☰].
  TODAS las acciones (referidos, soporte con ícono de auricular, notificaciones,
  instalar app, canal, configuración, logout) viven en el desplegable `#mainMenu`
  DENTRO del `<header>`. ⚠️ Los IDs de los botones son los históricos — el JS los
  cablea por id; el inline de FCM reescribe el innerHTML de `#notificationBtn`.
- **Barra de escribir estilo WhatsApp** (réplica de foto del owner): íconos SVG de
  trazo fino sin fondo (`.wa-icon-btn`) — tarjeta = CBU, cámara = foto — + send
  verde. El fueguito NO va ahí: vive en la cabecera del chat (`.fire-topbar-btn`
  en `.chat-topbar`, ids fireBtn/fireStreak intactos). Modo oscuro vía `body.wa-dark`.
- **FCM**: todo el manejo real (getToken 3 tiers, refresh, register-token) está en el
  INLINE de index.html; `window.sendFcmTokenAfterLogin` del inline pisa a propósito la
  de notifications.js. Firebase config duplicada en index.html Y en el SW (cambiar
  ambas). iOS: push solo en PWA instalada.
- SPA sin router: `#loginScreen`/`#chatScreen` + modales. Estado de login en globals
  `window._loginMode` etc. Interceptor global de fetch (auth.js) reabre el modal
  obligatorio ante 403 MUST_CHANGE_PASSWORD.
- Server-side rendering mínimo: `renderIndexHtml` reemplaza placeholders
  (`__META_PIXEL_ID_PLACEHOLDER__`, `__VIP_PUBLIC_BASE_URL_PLACEHOLDER__`,
  `__VIP_CAMPAIGN_CODE_PLACEHOLDER__`) con cache en memoria por proceso.
- **Botón CASINO** (`#plataformaBtn` → `VIP.ui.enterCasino()`): login único contra
  1girox. Ver la trampa del pop-up blocker en §4.9. El modal de acceso manual sigue
  existiendo, pero **sólo como camino de respaldo** cuando el SSO falla.
- **Casino embebido a PANTALLA COMPLETA + widget de soporte** (2026-08-19,
  `VIP.ui._showCasinoFrame` y asociadas, todo estilos inline en ui.js): el overlay
  no tiene barra propia (respeta safe-area arriba/abajo en iPhone standalone); una
  burbuja 🎧 abajo a la derecha (con badge de no leídos por MutationObserver sobre
  `#chatMessages`) abre un widget flotante anclado a la esquina con acciones
  rápidas (Depositar → chips de monto, Retirar, Pedir CBU, Ya transferí, Hablar;
  todo termina como mensaje en el chat del cajero vía
  `VIP.ui.casinoQuickAction` — no es un bot) y escapes "Casino aparte"/"Salir".
  ⚠️ El chat real se **MUDA** al widget (placeholders + appendChild de los nodos
  reales `.chat-container`/`.chat-input-container`; mismos ids/listeners/socket) —
  `closeCasinoFrame` SIEMPRE desmonta primero o la pantalla principal queda sin
  chat. El watchdog del iframe se cancela en su `load`. El access-link con
  `ir=casino` (alta por landing, §4.10) abre el casino directo tras loguear.
  Poll de saldo: 90s (era 30s; parte del fix del lag, §4.3).
- **Información del Servicio** (#185): la tarjeta "Bonos en tus cargas" (infoModal) y el
  pie del grid del adServiceModal muestran "Todos los bonos y regalos tienen rollover xN"
  (N = `bonusRollover.x` de `/api/refunds/status`, el efectivo del panel; oculto si el
  global está apagado) + botón que abre `rolloverInfoModal` (explicación del rollover,
  deportes no suma). `VIP.refunds.updateRolloverLabels` / `showRolloverInfo`.
- Duplicados front/back a mantener sincronizados: mínimo retiro $4.999, bono $5.000,
  `VIP.config.PLATFORM_URL` = `https://1girox.com` (respaldo del SSO; también aparece
  hardcodeada en los mensajes `/sys_deposit*`, `/sys_bonus` y `/sys_welcome` sembrados
  en `initializeData()`), defaults de % de reembolso.
- **Perfil del jugador** (recuadro USUARIO → `VIP.refunds.showProfileModal`): nivel
  VIP con barra de progreso + botón de rakeback semanal + reembolsos por período
  (solo %) + escalera completa (viene de `GET /api/vip/status`, no se duplica). El
  rótulo del recuadro muestra la medalla del nivel (`updateDashVipBadge`).

### Panel admin (`public/adminprivado2026/`)
- `admin.js` (~12k líneas), auth mixta: login → Bearer en memoria + cookies httpOnly;
  `checkAdminSession()` (`GET /api/admin/me`) restaura sesión al recargar.
- Roles: admin ve todo; depositor (abiertos/cerrados); withdrawer (solo Pagos);
  comunidad (abiertos/cerrados/comunidad); **publisher_admin tiene vista propia**
  (`#publisherAdminSection`, early-return en setupRoleBasedUI, funciones `pa*`).
- Chat: `renderConversations` con coalescing rAF + delegación de eventos (#91);
  `selectConversation` → `loadUserInfo` → banners (bloqueo, fraude/multicuenta,
  fueguito 30%, tags/notas, payout pendiente con botones pay/other-bank/cancel/
  dismiss/sync, promo bonus). Races protegidas por `activeConversationId` +
  AbortController — **no romper ese patrón**. La cabecera muestra el nivel VIP del
  cliente (`user.vipLevelInfo`, resuelto por el backend) y la tabla de Usuarios la
  medalla junto al nombre.
- **Nombres legacy en la API de campañas** (deuda a propósito para no romper el panel):
  el body sigue mandando `jugayganaPassword` y el endpoint se llama
  `POST /api/admin/campaigns/:code/test-jugaygana-creds`, pero adentro se guarda y se
  prueba `giroxApiKey` (el panel valida que empiece con `pk_`). La respuesta del listado
  expone `hasJugayganaCreds` mapeado desde `hasGiroxKey`. El "probar login" ya no
  loguea: consulta un jugador inexistente — 404 = key válida, 401 = key rechazada.
- **Pestaña Cerrados con 48hs PAGINADAS (2026-08-14):** `GET /api/admin/conversations`
  con `status=closed` filtra `lastMessageAt ≥ now-48h` y pagina de a 100
  (`?page=N`, clamp a la última página real; responde `{page, hasMore,
  totalPages}`). Abiertos/pagos/comunidad siguen top-100 por actividad (un
  abierto viejo es trabajo pendiente). Panel: paginador `#closedPager` solo en
  Cerrados (ventana de 6 números + input con Enter), página 1 al cambiar de
  pestaña, y el cache de 30s por pestaña guarda SOLO la página 1 (helper único
  `_setConversationsCache`).
- **Sección Notificaciones** suma las cards "🎁 Lote con regalo" (formulario +
  Validar lista + confirm con conteo real + guía "❓ Cómo funciona") y "📤 Lotes
  enviados" (historial con progreso en vivo y detalle por usuario, cap 400
  filas). Listener socket `security_alert` → toast rojo.
- **Sección "📊 Datos 2.0"** (cohortes de retención): `GET /api/admin/datos2?days=N`
  (7..90) — camadas por día ART de registro, retención D1/D3/D7/D14/D30 por
  última carga con ELEGIBILIDAD por edad (celda "—" si la camada no cumplió esa
  edad), desglose pauta/agente/orgánico, $/nuevo y c3Pct10d; tablas con
  semáforo + "🎯 Rendimiento por campaña" (publisher de Campaign). Botones
  "❓ Cómo leer esta hoja" en Datos y Datos 2.0 (guía compartida).
- **Sección Transacciones** (`GET /api/admin/transactions`, paginado + resumen por
  aggregation sobre el rango sin filtro de tipo): tarjetas Depósitos / Retiros /
  Bonificaciones / Reembolsos / Reembolso en vivo / Referidos / Fueguito / Ruleta /
  Rakeback / Nivel VIP y **"Total regalos (no cargas)"** (`summary.gifts` = todo lo
  que no es deposit ni withdrawal — lo que en 1girox va como Bono); filtros por tipo
  incluyen roulette, rakeback, vip_levelup y `cashback` (= `type:'bonus'` +
  `metadata.source:'instant_cashback'`, separado de Bonificaciones en el resumen y
  en el filtro); etiquetas en `getTransactionTypeLabel` / `_txIsCashback` (tipo
  nuevo ⇒ sumar etiqueta + botón + case del resumen).
- **Ruleta diaria** (#188): card "🎁 PREMIOS Y PROBABILIDADES" (tabla editable + cargas
  mínimas + exigir app; guardar solo admin general) sobre el budget diario. Chat: banner
  violeta "RULETA: +X% EXTRA" con "Marcar aplicado". **Config → "📲 Bono por instalar la
  app"**: pct / tope / % excedente con ejemplo. **Modal Depositar:** bloque de bonos
  pendientes que pre-carga "Monto de Bonificación" (`renderDepositPendingBonus`, usa
  `window._chatUserInfo` del chat abierto).
- **Config → "🎯 Rollover GLOBAL de bonos"** (solo admin general, #184): switch + botones
  x0/x2/x3/x5/x10 (los no permitidos por la plataforma en gris con ⚠️), hint con el
  efectivo y aviso de `snapped`. Banner "POSIBLE MULTICUENTA" del chat: señales 📱 ☎️
  🏦 🧾 🌐.
- **Config → "📉 Reembolso en vivo"** (solo admin general): on/off, %, rollover
  (validado contra `bonus.multipliers`), mínimo y tope diario. En la PWA el cliente
  lo ve como botón en el modal 🎁 Reembolsos y como recuadro en el perfil
  (`refunds.js`: `loadCashbackStatus` / `showCashbackModal` / `claimCashback`).
- **🏦 Banco** (#183): nav para admin/depositor/withdrawer (badge = pendientes). Tabs
  Pendientes/Hoy/Otro día (filas en vivo por socket `bank_movement`), Bajadas (modal +
  destinos guardados; crear solo admin|withdrawer), Cierre (tiles + diffs resolubles). El
  modal Depositar tiene el bloque "¿De dónde viene la plata?" (transferencia pendiente /
  otro banco / sin transferencia) que alimenta `movementId`/`origin` de `/api/admin/deposit`.
  Funciones globales con los MISMOS nombres que el gemelo (bankSetTab, loadBankTray,
  openBankAssign, bankAssignConfirm, bankLink, bankResolve, bankReopen, openSweepModal,
  submitSweep, openBankClose, bankCloseResolve, getDepositOrigin…).
- `admin-sw.js` (v41, scope /adminprivado2026/ — vive en `public/admin-sw.js`):
  network-first no-store para el shell.
- Servido por handlers propios con cache en memoria (`readFileCached`) + ADMIN_HOST
  check opcional; el catch-all bloquea todo otro path bajo /adminprivado2026/.
- Secciones "Automatización" y "Estrategia de bonos" están marcadas "No se usa" en el
  sidebar pero siguen funcionales (candidatas a limpieza con el owner).
- La sección "Base de Datos" fue ELIMINADA por completo (2026-07-09): era inalcanzable.

## 7. Motores automáticos / crons (todos `setInterval` en server.js — corren en CADA instancia)

| Motor | Frecuencia | Estado | Idempotencia |
|---|---|---|---|
| `_runNotifRulesEvaluator` (reglas push) | 5 min | activo (reglas refund/tier inertes: PlayerStats no portado) | lastFiredAt + ventana |
| `_runEncuestaTick` | 5 min | pushes sí, **bonos apagados** (`bDays=[]`); el incentivo de la ruleta se eliminó (2026-09-07) | EncuestaFire.slotKey único |
| `_runInactividadTick` | 6 h | **APAGADO** (`INACTIVIDAD_DISABLED=true`) | InactividadFire.fireKey único |
| `_runBonusStrategy` | 10 min | **APAGADO** (`BONUS_STRATEGY_DISABLED=true`) | step en StrategyEnrollment |
| `_runDueSchedules` (ScheduledNotif) | 60 s | activo | lastRunAt |
| `_pollPayingPayouts` | 45 s | activo (confirma pagos si el webhook no llegó) | handlePayoutStatusWebhook idempotente |
| `_runVipTick` (niveles VIP) | 30 min | activo (se apaga desde el panel: Config → "Niveles VIP", flag `vip_levels_disabled` en Config, SOLO admin general — sin cache a propósito para que aplique al instante en todas las instancias) | buckets con `$set` idempotente + bono con reference `vip-lvl-*` (la plataforma dedupe) |
| `_runVipSweepCheck` (sweep VIP) | 1 h (corre a las 05 ART) | activo | claim atómico por día en Config (`vip_sweep_day`) → instancia única |
| `_runFcmPrune` | 24 h | activo | flag anti-overlap en memoria |
| `_runDailyCloseTick` (cierre diario del banco, #183) | 5 min (corre 1×/día desde las 00:05 ART) | activo | claim `Config['dailyclose_last']` + DailyClose único por dateKey |
| `_processNotifBatchQueue` (lotes con regalo) | 45 s (+ setImmediate al crear un lote) | activo | claim atómico por recipient (`findOneAndUpdate` posicional a 'sending'; un 'sending' colgado >10 min se re-reclama solo) + reference `vip-nbatch-*` — reanudable tras deploy y multi-instancia safe |
| `fbAdsWebhook.startWorker` | 5 min | activo | nextRetryAt |
| Limpieza mensajes >3d | 6 h | activo (red de seguridad del TTL) | deleteMany |

Migraciones one-shot: patrón flag en Config (`migration_*_done`) en `initializeData()`.
El backfill de `usernameLower` corre en CADA arranque (idempotente) y setea
`_usernameLowerReady`.

## 8. Convenciones importantes

- **Mensajes automáticos al usuario** → `renderSystemCommand(name, fallback, vars)` y
  sembrar el comando en `systemCmds` de `initializeData()`. Respuesta VACÍA en el panel
  = "no enviar" (null). Variables: montos como `${amount}` en el template y se
  reemplaza `{amount}` (el `$` queda como signo); texto como `{username}` sin `$`.
  **Todo mensaje que avise un BONO acreditado lleva la nota del rollover (#186):**
  variable `{rollover}` = `_rolloverNoteText(x)` con `x` = `r.rolloverApplied` del
  cliente de la API (o `applyGlobalRollover(flow)`); vacía con x0. Los mensajes
  armados en código usan la versión corta (`{ short: true }`) en toasts.
- **Identidad**: `user.id` (uuid), no `_id`. Username case-insensitive →
  `findUserByUsernameCI` (indexado + fallback), NUNCA regex nuevo.
- **periodKey**: `YYYY-MM` (referidos y VipWagerMonth); RefundClaim usa
  `daily:YYYY-MM-DD` / `weekly:YYYY-MM-DD` / `monthly:YYYY-MM` /
  `rake:YYYY-MM-DD` (lunes de la semana del rakeback VIP).
- **Montos 1girox: PESOS.** Se envían tal cual (2 decimales), y los balances y el netwin
  del panel vuelven en pesos. **NO multiplicar ni dividir por 100** — el ×100 de
  centavos era de JUGAYGANA y ya no existe.
- **Toda operación de plata lleva `reference`** estable y persistida (§4.4). Reintento
  ⇒ MISMA reference. Chequear `result.duplicate` antes de dar un pago por bueno.
- **Todo lo fire-and-forget** (tracking, comprobantes, fanout, SLA) va en try/catch y
  JAMÁS frena la respuesta al cliente — mantener ese patrón.
- **Crédito de plata al cliente = RESERVAR ATÓMICO ANTES de acreditar** (nunca acreditar
  y limpiar el flag después → TOCTOU/doble cobro). Patrón: `findOneAndUpdate` con guard
  del flag (ruleta, bono instalación, fueguito claim-reward) o `create` con índice único
  (reembolsos). Si el crédito falla, revertir la reserva. Ver #96.
- **Endpoints muertos**: se eliminan con comentario-lápida y rollback `git revert`.
- **Validación local**: sólo `node --check` (no hay node_modules en Tails).

## 9. Trampas / "no rompas esto"

- **MODO MANUAL (§0):** nunca hacer `require('./giroxService')` directo — siempre el
  selector `platformService`. Toda operación de plata NUEVA que dispare el server solo
  tiene que pasar una `reference` estable (nace `pending` en la bandeja); toda la que
  dispare un clic del agente tiene que pasar `agentExecuted:true` (o va a aparecer
  como pendiente y el agente la haría DOS veces). `validateCredentials` manual es
  `valid:false` a propósito: no "arreglarlo". Los flujos que leen saldo tienen que
  tolerar `code:'manual_mode'`.
- **DOS `connectDB`**: el real es `config/database.js`; el de `src/models/index.js` NO
  se usa. No definir schemas en config/database.js.
- **Secrets por SSM**: no leer `process.env.X` al require; lazy getters. Los módulos
  `girox*` ya siguen ese patrón (getters + cliente HTTP on-demand); los 4 clientes
  viejos congelaban `process.env` en consts de módulo — no copiar ese patrón.
- **Código muerto de JUGAYGANA**: `jugaygana.js`, `jugaygana-movements.js`,
  `jugayganaService.js`, `jugayganaPublisherSessions.js`, `referralRevenueService.js` y
  `jugayganaUserLinkService.js` siguen en el repo pero **nadie los importa** (sólo se
  importan entre ellos y desde `scripts/_archive/`). Están para revertir. No agregarles
  llamadas nuevas ni "arreglarlos".
- **Montos en PESOS** — el ×100 murió con JUGAYGANA (§8).
- **`reference` = plata** (§4.4): repetida entre operaciones distintas ⇒ la segunda NO
  se acredita (vuelve `duplicate:true`); cambiada entre reintentos del mismo pago ⇒ se
  paga dos veces. La del reembolso sale del **periodKey**, no del RefundClaim.id (si
  saliera del id, el reintento tras un fallo falso pagaría doble).
- **Retiros: validar contra `available`, no `balance`** — el rollover está activo en
  1girox y parte del saldo puede estar bloqueado (§4.5).
- **Reembolso EN VIVO (2026-09-11):** la base descuenta TODO lo regalado, incluidos
  los propios reembolsos cobrados (§3.2 de la espec) — no "arreglar" eso pensando
  que es doble descuento. Todo regalo nuevo tiene que quedar en Transaction con un
  tipo de `CASHBACK_GIFT_TX_TYPES` (o en `deposit.bonus`) o se reembolsaría. La
  Transaction 'bonus' aparte de la carga con bonus va con `metadata.source:
  'deposit_bonus'` (si no, se contaría dos veces). `User.cashbackCarryNet` puede
  ser negativo a propósito. No cambiar `CASHBACK_STATS_EPOCH` (2026-07-31) ni el
  orden del plegado sin releer §3.4.
- **Rollover GLOBAL (#184):** un flujo de bono NUEVO no tiene que resolver el rollover
  a mano — pasa por `creditGift`/`creditUserBalance`/`depositToUser` y el cliente lo
  aplica. Lo único a decidir es si es un BONO (global) o plata del cliente
  (`ignoreGlobalRollover:true`, como referidos y devoluciones). Un rollover que se
  muestre al cliente sale de `applyGlobalRollover(...)`, nunca del valor crudo del
  flujo. Un regalo NUEVO tiene que seguir escribiendo Transaction con tipo de regalo
  (base del reembolso en vivo). Test en frío: `node scripts/test-rollover-multicuenta.js`.
- **Regalos = bono 0 "regalo directo", NO depósito** (2026-09-07, §4.5): reembolsos,
  ruleta, rakeback, bono VIP y comisiones van por `creditUserBalance` SIN multiplier
  → `/bonus` con `multiplier: 0` (figuran como Bono en el panel de 1girox), con
  fallback automático a depósito libre y misma reference. NO volver a llamar
  `depositToUser` para un regalo (saldría como "Carga"). Un `multiplier` explícito
  >0 en `/bonus` puede quedar "a reclamar" y PISA un bono activo — sólo donde ya
  se hace (welcome code cash, lotes, Bonificación del panel).
- **Rate limit 60/min es POR INSTANCIA** (`GIROX_MAX_RPM`, default 55): con N instancias
  el techo real es N×55. Si aparecen 429, BAJAR el valor (§4.3).
- **Los reportes NO son la Partner API**: `giroxReportsService` scrapea el panel
  `admin.1girox.com` con un Bearer de sesión. Es lo más frágil que tenemos y de ahí
  dependen reembolsos y comisiones de referidos (§4.6). El netwin es **sólo casino**
  (`GIROX_NETWIN_SCOPE`).
- **Sin `User.giroxUserId` no hay reembolso ni comisión** para ese usuario. El buscador
  del panel hace LIKE: la coincidencia tiene que ser EXACTA o se le paga a otro (§4.6).
- **NINGUNA push puede mencionar la ruleta diaria** (2026-09-07): candado global
  `isRouletteText` al inicio de las 5 funciones de envío de
  `notificationService` (devuelve `blocked:'roulette'`), migración de reglas y
  plantillas guardadas en el seed del boot, y sin aviso push en "Reiniciar
  ruleta". La ruleta NO está activa; si se reactiva, sacar el candado.
- **Message TTL 3 días; Transaction permanente.** Snapshot en ChatDelay por eso.
- **ChatStatus se crea con actividad**, no al crear el usuario.
- **Atribución de publicista** se fija al registrar; el login NO la cambia. El referido
  (`?ref=`) tiene prioridad sobre publicista en el front.
- **publisher_admin**: endpoint nuevo para ese rol ⇒ sumarlo a
  `PUBLISHER_ADMIN_ALLOWED_PATHS`.
- **`adminMiddleware` deja pasar 4 roles** — todo endpoint sensible re-chequea
  `role==='admin'` explícito (patrón #80; los CRÍTICOS ya están cerrados).
- **Tope 30% en bonos automáticos** (owner 2026-07-08): cap de lectura en
  `_getActivePromoBonus`, validaciones ≤30 en configs, plantillas bono_50/100
  eliminadas + guard en `_runStrategyLaunch`. Los botones manuales +50/+100 del modal
  de depósito QUEDAN (herramienta del agente).
- **Multi-instancia**: crons corren en cada instancia — la idempotencia vive en los
  índices únicos (slotKey, fireKey, chargeKey, userId+dateKey) — ahora reforzada por la
  `reference` de 1girox del otro lado. No dropearlos. La blacklist JWT de
  src/middlewares/auth.js, `generalLimiter` y el limitador de RPM de `giroxService` son
  por-instancia.
- **USERS_LIST_FIELDS** (`GET /api/admin/users`) y la proyección de
  `AUTH_USER_FIELDS` (authMiddleware): campo nuevo consumido ⇒ sumarlo al select.
- **onclick inline** en panel y PWA dependen de `window.*` — no renombrar exports sin
  actualizar los strings. En `renderUsers` las comillas SIMPLES del onclick con JSON
  son a propósito.
- **CACHE de assets por proceso** (`readFileCached`, `_indexHtmlBase`,
  `_adminHtmlRendered`): index.html/admin.js/css se leen 1 vez por proceso — cambios
  llegan con el redeploy (que reinicia). No agregar contenido dinámico por-request al
  HTML sin pasar por `renderIndexHtml`.
- **Firebase config duplicada** (index.html + firebase-messaging-sw.js) y VAPID key en
  el inline: cambiar en ambos lados.
- **Vínculos banco↔carga (#183):** una transferencia = UNA acreditación. Cualquier flujo
  nuevo que acredite plata que entró por hgcash tiene que dejar `BankMovement.transactionId`
  + `chargeSource` y `Transaction.metadata.movementId` (o `origin:'otro_banco'`), o el cierre
  diario lo marca como diferencia. La carga asignada SIEMPRE va por `hgcashAutoCarga({assign})`
  (nunca un `depositToUser` suelto: perdería el candado por coelsa y la reference `vip-hg-*`).
  `_emitHgcashUpdate(kind, movementId)` con movementId para que la bandeja se actualice en vivo.
  Nombres de modelos/endpoints/funciones del panel = los del gemelo AUTOREEMBOLSOS (#155):
  no renombrar, así los parches se portan 1:1.
- **`Campaign.hasGiroxKey` es un espejo** de `giroxApiKey` (que es `select:false`):
  cualquier camino que escriba o limpie la key TIENE que actualizar el booleano, o el
  panel muestra el badge equivocado.
- **Trampa del pop-up blocker en el botón CASINO**: la pestaña se abre ANTES del fetch,
  dentro del gesto del usuario. Mover el `window.open` después del `await` rompe el SSO
  en mobile (§4.9).
- **`GET /api/movements` quedó sin backend**: la Partner API no expone historial de
  apuestas/movimientos, así que `girox.getUserMovements()` devuelve siempre
  `not_supported` (explícito a propósito, para fallar claro en vez de con un TypeError).
  El endpoint responde 400. Si alguien lo necesita, hay que pedirlo a 1girox o sacarlo.
- **`_communityRecommendCard` (roulette.js)**: feature pedida por el owner que nunca
  se conectó — lee `VIP.state.communityLink*` que nadie setea (el wiring real de
  comunidad es `loadCommunity()` inline → `/api/config/community`). Es MEJORA
  PENDIENTE (reconectar seteando VIP.state desde loadCommunity), no código muerto.
- **`checkUsernameAvailability` (PWA)**: existe pero no se dispara — mejora pendiente.
- **vercel.json es un artefacto** de un deploy anterior; el deploy real es AWS EB.
- **Env DB_PASSWORD ya no se usa** (sección Base de Datos eliminada 2026-07-09).
