# Testing de seguridad con OWASP ZAP — SANTINOGANAMOS

Pruebas de seguridad **sobre nuestra propia app**. Todo lo de acá es contra una
copia tuya o con permiso escrito del dueño del sistema. Nunca contra un tercero.

## Regla de oro: NUNCA contra producción con jugadores reales

El escaneo activo de ZAP **inyecta payloads y modifica datos**: puede crear y
borrar registros, disparar cargas/retiros, mandar SMS reales (AWS SNS = plata),
spamear push y dejar basura. Incluso el spider "pasivo" envía formularios.

Por eso se corre **solo contra una copia descartable con datos de mentira**. Los
endpoints que gastan plata o mandan SMS ya están excluidos en los dos planes,
pero esa es la segunda barrera, no la primera. La primera sos vos apuntando al
target correcto.

## 1. Instalar ZAP (se baja una vez, corre offline)

ZAP es una app de Java; una vez instalada no necesita internet para escanear.

1. Con internet, bajá el instalador de Linux de https://www.zaproxy.org/download/
   (el `.tar.gz` "cross platform" trae su propio Java).
2. Descomprimilo en un lugar **persistente** (en Tails, el volumen persistente;
   si no, se borra al reiniciar). El ejecutable es `zap.sh`.
3. Primera vez, actualizá los add-ons (con internet):
   `zap.sh -cmd -addonupdate`
   y sumá los que usamos: `zap.sh -cmd -addoninstall ascanrulesBeta -addoninstall pscanrulesBeta -addoninstall accessControl`
4. A partir de ahí, todo corre sin conexión.

## 2. Levantar la copia descartable (el target)

ZAP ataca una instancia corriendo. Como en Tails no hay `node_modules` ni la app
levantada, el grueso del trabajo es pararla aislada:

1. Clonar el repo en una máquina/VM aislada y `npm install`.
2. Una Mongo de juguete (local o una base `..._pentest` separada en Atlas). Nunca
   la base real.
3. Variables de entorno de mentira para que NO hable con servicios reales:
   - `JWT_SECRET` cualquiera (fuerte), `NODE_ENV=development`.
   - **Dejá SIN configurar** las credenciales de la plataforma externa, de AWS
     SNS, de FCM y de hgcash. Así las operaciones de plata/SMS fallan en vez de
     ejecutarse. `PLATFORM_MODE=manual` es el más inofensivo (no llama a ninguna
     API externa).
4. Crear a mano los usuarios de prueba, uno por rol (ver §4): `zap_admin`,
   `zap_depositor`, `zap_withdrawer`, `zap_player`.
5. Levantar el server (`node server.js`) y confirmar que responde en
   `http://localhost:3000`.

## 3. Correr los planes

Dos planes en esta carpeta, del más seguro al más agresivo:

```bash
# Variables (ajustá a tus usuarios de prueba)
export TARGET="http://localhost:3000"
export ZAP_ADMIN_USER="zap_admin"        ZAP_ADMIN_PASS="..."
export ZAP_DEPOSITOR_USER="zap_depositor" ZAP_DEPOSITOR_PASS="..."
export ZAP_WITHDRAWER_USER="zap_withdrawer" ZAP_WITHDRAWER_PASS="..."
export ZAP_PLAYER_USER="zap_player"      ZAP_PLAYER_PASS="..."

# Paso 1 — baseline pasivo (empezá acá siempre)
zap.sh -cmd -autorun security/zap/zap-baseline.yaml

# Paso 2 — escaneo activo (solo cuando confirmaste que el target es descartable)
zap.sh -cmd -autorun security/zap/zap-active.yaml
```

Los informes HTML quedan en `security/zap/reports/` (ignoralos en git, no los
subas: pueden tener datos de la copia).

El login está cableado en los planes: `POST /api/auth/login` con
`{"username","password"}`, respuesta con `token` + cookie httpOnly
`admin_api_session` (Path=/api). ZAP captura esa cookie y la reenvía; verifica la
sesión poleando `GET /api/auth/verify` (busca `"role":` = logueado, `401` =
caído). Si cambia el login, actualizá el bloque `authentication` de los dos YAML.

## 4. La parte que los escáneres NO encuentran: autorización, IDOR y lógica

Esto es lo más importante en una sala de plata, y es **manual**. Los roles del
sistema son `user`, `admin`, `depositor` (solo cargas), `withdrawer` (solo
retiros), `publisher_admin` (solo crea usuarios de su publicista).

Con ZAP de proxy (configurá el navegador para que pase por ZAP, 127.0.0.1:8080),
logueate con cada rol y probá, usando "Request" → botón derecho → "Resend" para
reenviar una request cambiando cosas:

- **Autorización rota.** Agarrá una acción de admin (p. ej. aprobar un retiro) y
  reenviala con el token/cookie de `depositor`, de `withdrawer` y de `player`.
  Debe dar 401/403. Si ejecuta, hay un endpoint sin chequeo de rol. Recorré así
  cada ruta `/api/admin/*` con un rol más bajo.
- **IDOR (lo primero que probaría, acá es plata).** En cada endpoint que lleva un
  id de usuario, transacción, giro o movimiento, cambiá el id por el de OTRO
  usuario y mirá si te devuelve o modifica su recurso. Antes de la primera corrida
  del plan activo, **completá en `zap-active.yaml` los patrones de exclusión de
  las rutas reales de carga/retiro/bono** (los dejé con palabras genéricas) para
  que el escáner no las dispare mientras hacés esto a mano.
- **Lógica de negocio / idempotencia.** Reenviá la misma carga o el mismo reclamo
  de bono con la MISMA `reference` (debe rebotar como duplicado) y con una
  reference distinta (no debe pagar dos veces). Probá montos negativos o cero.
  Lanzá la misma operación en paralelo (condición de carrera). Reclamá dos veces
  la ruleta o el reembolso semanal.
- **Firma del webhook hgcash.** Mandá un `POST /api/hgcash/webhook` con firma
  inválida y con firma ausente: debe rechazar. Nunca debe acreditar sin firma
  válida.
- **Fuerza bruta.** El login y los OTP tienen limitadores (`authLimiter`,
  `sensitiveLimiter`, `smsIpLimiter`). Confirmá que cortan de verdad: repetí login
  fallido y pedidos de OTP hasta que respondan 429.

El add-on **Access Control** de ZAP ayuda: cargás el contexto con los usuarios
por rol, definís qué ruta puede cada uno, y ZAP recorre marcando accesos que no
deberían pasar. Se arma desde la UI (Contexts → Access Control).

## 5. NoSQL injection (Mongo)

El riesgo acá no es SQL clásico sino operadores de Mongo que entran por el body
(p. ej. mandar `{"username": {"$ne": null}}` donde se espera un string). El
escaneo activo por defecto no lo cubre bien. Opciones:

- Revisá a mano cada `find`/`findOne` que use directo algo del `req.body`.
- Probá en los logins y búsquedas meter `{"$ne":""}`, `{"$gt":""}` como valor.
- Complementá con **Semgrep** (reglas de `javascript.express` y de NoSQLi) y
  **npm audit** sobre las dependencias: corren sin servidor, directo sobre el
  código.

## 6. Qué hacer con los hallazgos

Por cada hallazgo: cómo se reproduce (la request exacta), impacto y el arreglo.
Los de lógica de negocio (IDOR, doble pago, autorización) van primero porque son
plata directa. Los de cabeceras/cookies que tira el baseline suelen ser arreglos
de una línea (flags de cookie, headers de seguridad).
