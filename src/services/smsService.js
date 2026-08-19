
/**
 * Servicio SMS via AWS SNS
 *
 * Variables de entorno:
 * AWS_REGION (o AWS_SNS_REGION): región de AWS SNS (ej: 'sa-east-1')
 * AWS_ACCESS_KEY_ID (opcional): access key de IAM. Si no se provee, el SDK
 *   usa el IAM Role del EC2 automáticamente (recomendado en AWS EB).
 * AWS_SECRET_ACCESS_KEY (opcional): secret key del mismo usuario IAM.
 *
 * El cliente SNS se inicializa de forma lazy (al primer uso) para que las
 * variables de entorno ya estén disponibles aunque vengan de SSM Parameter
 * Store cargado en el bootstrap de server.js.
 *
 * Si AWS_REGION no está configurada, el servicio no envía mensajes.
 */

const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

let snsClient = null;

/**
 * Devuelve el cliente SNS, inicializándolo si es la primera llamada.
 * Usa lazy initialization para asegurar que process.env ya tenga los
 * valores cargados desde SSM antes de construir el cliente.
 * @returns {SNSClient|null}
 */
function getSnsClient() {
  if (snsClient) return snsClient;

  const region = process.env.AWS_REGION || process.env.AWS_SNS_REGION;
  if (!region) {
    console.warn('[smsService] AWS SNS no configurado. Falta AWS_REGION. Los SMS no serán enviados.');
    return null;
  }

  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (accessKeyId && secretAccessKey) {
    snsClient = new SNSClient({
      region,
      credentials: { accessKeyId, secretAccessKey }
    });
    console.log('[smsService] AWS SNS inicializado con Access Keys explícitas');
  } else {
    snsClient = new SNSClient({ region });
    console.log('[smsService] AWS SNS inicializado con IAM Role (sin Access Keys)');
  }

  return snsClient;
}

/**
 * Envía un SMS transaccional via AWS SNS.
 * @param {string} phone - Número de teléfono en formato internacional (ej: +5491155551234)
 * @param {string} message - Texto del mensaje
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendSMS(phone, message) {
  const client = getSnsClient();
  if (!client) {
    return { success: false, error: 'SMS service not configured' };
  }

  try {
    const command = new PublishCommand({
      PhoneNumber: phone,
      Message: message,
      MessageAttributes: {
        'AWS.SNS.SMS.SMSType': {
          DataType: 'String',
          StringValue: 'Transactional'
        }
      }
    });

    const resp = await client.send(command);
    // MessageId a stdout (SIN el teléfono): separa "no se envió" de "no se
    // entregó" — la entrega la puede comer el límite de gasto de SMS de SNS,
    // que descarta en silencio al superarlo.
    console.log('[smsService] OK → SNS MessageId=' + (resp && resp.MessageId ? resp.MessageId : 'desconocido'));
    return { success: true };
  } catch (error) {
    // Avoid logging user-controlled phone number in format strings
    console.error('[smsService] Error enviando SMS:', error.message);
    return { success: false, error: error.message };
  }
}

module.exports = { sendSMS };
