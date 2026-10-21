# Operator API v0.1 (mijoker.com) — transcripción de la documentación Swagger

> Transcripta el 2026-10-21 desde las capturas del Swagger UI publicado en
> `https://mijoker.com` (título "Operator API", "Operator API description • Version
> 0.1", OAS 3.0). La página está detrás de Cloudflare con desafío/captcha: desde un
> server (o desde Tails/Tor) devuelve 403, por eso la doc vive ACÁ y no se vuelve a
> bajar. Es la base de `src/services/mijokerService.js` (`PLATFORM_MODE=mijoker`).
>
> ⚠️ Lo que NO dice la doc (y el cliente trata como desconocido hasta probarlo en
> vivo): la URL base real (Swagger lista sólo `http://localhost:3000 - Development
> (local)` y un formulario "Add Custom Server"), el rate limit, el formato exacto de
> los errores (sólo hay descripciones por código HTTP), si `operations` del historial
> acepta uno o varios valores, y el orden de los ítems del historial.

## Autenticación

- **Bearer token** fijo: header `Authorization: Bearer <token>` en todas las
  requests ("Configure authorization (Bearer Token)" en el Swagger). No hay endpoint
  de login ni sesión que renovar.
- Todos los endpoints llevan candado (requieren el token).

## Endpoints

Prefijo común: `/api/operator/v1`.

### `POST /api/operator/v1/account-transfers` — cargar / descontar saldo

Body (`application/json`, requerido) — `CreateAccountTransferRequestDto`:

| campo | tipo | notas |
|---|---|---|
| `amount` | number | `minimum: 0`, `exclusiveMinimum: true` (estrictamente > 0) |
| `operation` | string | enum `INCOME` (acreditar al jugador) \| `OUTCOME` (debitar al jugador) |
| `targetUserName` | string | username del jugador |

Respuestas:

| código | descripción | body |
|---|---|---|
| 200 | Updated account transaction | `{ "newBalance": "string" }` (`CreateAccountTransferResponseDto`) |
| 400 | Invalid input | — |
| 403 | Not authorized to manage this user | — |
| 404 | account transaction not found | — |

⚠️ **NO tiene `reference`/idempotency key.** Un reintento a ciegas acredita dos
veces. Ver "Idempotencia" abajo.

### `GET /api/operator/v1/users?username=` — datos del jugador

Query: `username` (string, **requerido**).

| código | descripción | body |
|---|---|---|
| 200 | user details | `UserResponseDto` |
| 400 | Invalid input | — |
| 403 | Unauthorized | — |
| 404 | user not found | — |

`UserResponseDto`: `createdAt` (date-time, req.), `email` (email, nullable),
`id` (number, req.), `status` (enum `ACTIVE` \| `BANNED` \| `DELETED`, req.),
`username` (string, req.).

### `POST /api/operator/v1/users` — crear jugador

Body — `CreatePlayerRequestDto`: `agentName` (string, req.), `playerName`
(string, req.), `password` (string, req.).

| código | descripción | body |
|---|---|---|
| 201 | Created user | `{ "userId": 0 }` (`CreatePlayerResponseDto`) |
| 400 | Invalid input | — |
| 403 | Not authorized | — |

### `GET /api/operator/v1/users/{id}/balance-history` — historial de saldo

Path: `id` (number, requerido: el `id` numérico del jugador, NO el username).

Query:

| param | tipo | notas |
|---|---|---|
| `limit` | number | opcional, default 10, `minimum: 1`, `maximum: 30` |
| `offset` | number | **requerido**, `minimum: 0` |
| `dateFrom` | string ($date-time) | **requerido**, ej. `2025-10-13T00:00:00.000Z` |
| `dateTo` | string ($date-time) | **requerido** |
| `operations` | string | opcional (desplegable `--` en Swagger; valores del enum de `operation`) |

| código | descripción | body |
|---|---|---|
| 200 | balance history list | `BalanceHistoryResponseDto` |
| 400 | Invalid input | — |
| 403 | Unauthorized | — |

`BalanceHistoryResponseDto` = `{ items: [ ... ] }`; cada ítem:

| campo | tipo |
|---|---|
| `amount` | string |
| `balanceAfter` | string |
| `balanceBefore` | string |
| `canCreateOnlyPlayersFrom` | boolean |
| `canCreateOnlyPlayersTo` | boolean |
| `createdAt` | string ($date-time) |
| `fromUsername` | string |
| `fromUserRole` | string |
| `operation` | enum `INCOME` \| `OUTCOME` \| `WIN_INCOME` \| `BET_OUTCOME` \| `ROLLBACK` |
| `subprovider` | string, nullable |
| `toUsername` | string |
| `toUserRole` | string |
| `transactionId` | string |
| `userFromId` | number |
| `userToId` | number |

### `PATCH /api/operator/v1/users/{username}/reset-password` — cambiar clave

Path: `username`. Body — `ChangePasswordRequestBodyDto`: `password` (string,
req.) con patrón:

```
^[a-zA-Z0-9\-_ `~!@#$%^&*()+={}[\]\\|;:'"<>,.?/]{3,32}$
```

| código | descripción | body |
|---|---|---|
| 200 | Updated user | `{ "password": "string", "success": true }` (`ChangePasswordResponseDto`: password minLength 1 maxLength 32) |
| 400 | Invalid input | — |
| 403 | Not authorized to manage this user | — |
| 404 | user not found | — |

### `PATCH /api/operator/v1/users/{username}/status` — activar / banear

Path: `username`. Body — `UpdateUserStatusRequestDto`: `status` enum
`ACTIVE` \| `BANNED`.

| código | descripción | body |
|---|---|---|
| 200 | Updated user | `{ "success": true }` |
| 400 | Invalid input | — |
| 403 | Not authorized to manage this user | — |
| 404 | user not found | — |

### `GET /api/operator/v1/users/balance?id=&username=` — saldo del jugador

Query: `id` (number, opcional) y/o `username` (string, opcional).

| código | descripción | body |
|---|---|---|
| 200 | user balance details | `{ "balance": "string", "currency": "string" }` (`AccountBalanceResponseDto`) |
| 400 | Invalid input | — |
| 403 | Unauthorized | — |
| 404 | user balance not found | — |

## Lo que la API NO tiene (y cómo lo cubre el cliente)

- **Sin idempotencia** en las transferencias → `src/models/PlatformOp.js` es el
  libro mayor local: `reference` única por operación, estados
  `pending|done|failed|unknown`. Ante timeout/5xx se **reconcilia** contra
  `balance-history` (monto + operación + ventana de tiempo desde que se mandó,
  excluyendo ítems ya atribuidos a otra operación) antes de reintentar. Detalle en
  `docs/ARCHITECTURE.md` §0.3.
- **Sin validar clave del jugador** → `validateCredentials` devuelve `valid:false`
  siempre (el login no crea cuentas locales a partir de la plataforma).
- **Sin SSO/link de sesión** → el botón CASINO abre `MIJOKER_PLAY_URL` en pestaña.
- **Sin bonos ni rollover** → todo regalo es un `INCOME` liso (x0).
- **Sin netwin/stats** → reembolsos por netwin, VIP, cashback y referidos quedan
  apagados (igual que en manual). El historial trae `WIN_INCOME`/`BET_OUTCOME`
  por jugador, paginado de a 30: se podría derivar un netwin, pero no se hace.
- **Sin saldo del agente** → el cruce con el cajero del cierre diario queda
  `sin_datos`.
