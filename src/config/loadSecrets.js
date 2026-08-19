/**
 * loadSecrets.js
 *
 * Carga parámetros desde AWS Systems Manager Parameter Store y los setea
 * como variables de entorno (process.env) antes de que el resto de la app
 * los lea.
 *
 * Si SSM_PATH no está definido (modo Render / dev local), no hace nada y
 * deja que dotenv / las env vars del proceso ya estén disponibles.
 *
 * El cliente SSM usa el IAM Role del EC2 automáticamente cuando no hay
 * Access Keys explícitas en el entorno.
 */

const { SSMClient, GetParametersByPathCommand } = require('@aws-sdk/client-ssm');

async function loadSecretsFromSSM() {
    const ssmPath = process.env.SSM_PATH;
    if (!ssmPath) {
        console.log('[SSM] SSM_PATH no definido, saltando carga desde Parameter Store (modo .env local)');
        return;
    }

    // SSM_SKIP_KEYS (entornos CLON): lista coma-separada de NOMBRES de claves
    // que NO se sobreescriben desde SSM. Un clon que comparte el SSM_PATH de
    // producción puede así setear su propia MONGODB_URI / PUBLIC_BASE_URL como
    // propiedades de entorno (ej. SSM_SKIP_KEYS=MONGODB_URI,PUBLIC_BASE_URL).
    // Producción no define la env → comportamiento idéntico (cero riesgo).
    // ⚠️ Las keys de la plataforma siguen compartidas: las cargas/retiros del
    // clon pegan a la plataforma REAL — aislar la DB evita ensuciar usuarios.
    const skipKeys = new Set(
        String(process.env.SSM_SKIP_KEYS || '')
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean)
    );

    const region = process.env.AWS_REGION || 'sa-east-1';
    const ssm = new SSMClient({ region });

    let nextToken;
    let count = 0;
    const skipped = [];

    try {
        do {
            const response = await ssm.send(new GetParametersByPathCommand({
                Path: ssmPath,
                WithDecryption: true,
                Recursive: false,
                MaxResults: 10,
                NextToken: nextToken
            }));

            for (const param of response.Parameters || []) {
                const key = param.Name.replace(ssmPath, '').replace(/^\/+/, '');
                if (!key) continue;
                if (skipKeys.has(key)) {
                    skipped.push(key);
                    continue;
                }
                process.env[key] = param.Value;
                count++;
            }

            nextToken = response.NextToken;
        } while (nextToken);

        console.log(`[SSM] Cargados ${count} parámetros desde ${ssmPath}` +
            (skipped.length ? ` (${skipped.length} NO sobrescritos por SSM_SKIP_KEYS: ${skipped.join(', ')})` : ''));
    } catch (err) {
        console.error('[SSM] Error cargando parámetros desde Parameter Store:', err.message);
        throw err;
    }
}

module.exports = { loadSecretsFromSSM };
