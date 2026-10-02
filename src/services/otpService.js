
/**
 * Servicio OTP - One-Time Password
 * Gestiona generación, envío y verificación de códigos OTP para:
 * - Verificación de teléfono en el registro ('register')
 * - Reset de contraseña por SMS ('reset')
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const OtpCode = require('../models/OtpCode');
const { sendSMS } = require('./smsService');

const OTP_LENGTH = 6;
const MAX_ATTEMPTS = 3;
const RATE_LIMIT_SECONDS = 60;    // No reenviar si hay OTP válido creado hace menos de 60 segundos
const MAX_OTPS_PER_HOUR = 3;      // Máximo 3 OTPs por número por hora

/**
 * Genera un código OTP numérico de 6 dígitos.
 * @returns {string} código de 6 dígitos como string
 */
function generateCode() {
  // crypto.randomInt: generador criptográficamente seguro (no Math.random).
  const num = crypto.randomInt(0, 1000000);
  return String(num).padStart(OTP_LENGTH, '0');
}

/**
 * Construye el texto del SMS OTP para el purpose dado.
 * Usa solo caracteres ASCII puro (sin tildes, sin ñ) para forzar codificación
 * GSM-7 en AWS SNS y garantizar entrega en 1 sola parte (~160 chars).
 *
 * @param {string} purpose - 'register' | 'reset' | 'change-password' | 'login'
 * @param {string} code    - Código OTP de 6 dígitos
 * @returns {string} Texto del SMS listo para enviar
 */
// Marca y dominio del SMS: salen del entorno (lazy: SSM carga en el bootstrap async).
// Antes decían "VIPCARGAS ... vipcargas .com" fijo, también en los clones (#218).
function _smsBrand() {
  const b = String(process.env.BRAND_NAME || 'GANAMOS').normalize('NFD').replace(/[^\x20-\x7E]/g, '').trim().toUpperCase();
  return b || 'GANAMOS';
}
// Dominio de PUBLIC_BASE_URL con un espacio antes del último punto ("cargasganamos .com").
// '' si no hay URL pública cargada (el SMS sale sin dominio, nunca con uno ajeno).
function _smsDomain() {
  try {
    const host = new URL(String(process.env.PUBLIC_BASE_URL || '')).hostname.replace(/^www\./, '');
    if (!host || !/^[\x21-\x7E]+$/.test(host) || host.indexOf('.') === -1) return '';
    const k = host.lastIndexOf('.');
    return ` ${host.slice(0, k)} ${host.slice(k)}`;
  } catch (_) { return ''; }
}

function buildOtpMessage(purpose, code) {
  // El espacio en "dominio .com" es intencional: rompe la detección de URL
  // que usan los filtros antispam de los carriers LATAM (sobre todo Tigo/Claro
  // en Paraguay y Argentina), evitando que el SMS caiga en spam. El usuario
  // sigue entendiendo el dominio sin problema. Sigue siendo 1 SMS (GSM-7,
  // ~80 chars, muy por debajo del límite de 160).
  const brand = _smsBrand();
  const tail = `Valido 5 min.${_smsDomain()}`;
  if (purpose === 'register') {
    return `${brand}: codigo de verificacion ${code}. ${tail}`;
  } else if (purpose === 'reset') {
    return `${brand}: codigo para restablecer contrasena ${code}. ${tail}`;
  } else if (purpose === 'change-password') {
    return `${brand}: codigo para cambiar contrasena ${code}. ${tail}`;
  } else if (purpose === 'login') {
    return `${brand}: codigo de inicio de sesion ${code}. ${tail}`;
  } else {
    return `${brand}: codigo de verificacion ${code}. ${tail}`;
  }
}

/**
 * Genera un OTP, lo hashea, lo guarda en DB y lo envía por SMS.
 * Rate limit: no envía si ya hay un OTP válido para ese phone+purpose creado hace menos de 60s.
 * Máximo 3 OTPs por número por hora.
 *
 * @param {string} phone - Teléfono normalizado (ej: +5491155551234)
 * @param {string} purpose - 'register' o 'reset'
 * @returns {Promise<{success: boolean, error?: string, smsSent?: boolean}>}
 */
async function generateAndSendOTP(phone, purpose) {
  const now = new Date();

  // Rate limit: no reenviar si hay un OTP válido reciente (menos de 60 segundos)
  const recentOtp = await OtpCode.findOne({
    phone,
    purpose,
    createdAt: { $gte: new Date(now.getTime() - RATE_LIMIT_SECONDS * 1000) }
  });

  if (recentOtp) {
    return {
      success: false,
      error: `Espera ${RATE_LIMIT_SECONDS} segundos antes de solicitar un nuevo código`
    };
  }

  // Rate limit: máximo 3 OTPs por número por hora
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const recentCount = await OtpCode.countDocuments({
    phone,
    purpose,
    createdAt: { $gte: oneHourAgo }
  });

  if (recentCount >= MAX_OTPS_PER_HOUR) {
    return {
      success: false,
      error: 'Demasiados intentos. Espera una hora antes de solicitar un nuevo código.'
    };
  }

  // Generar código y hashear
  const code = generateCode();
  const codeHash = await bcrypt.hash(code, 10);

  // Eliminar OTPs anteriores del mismo phone+purpose para evitar acumulación
  await OtpCode.deleteMany({ phone, purpose });

  // Guardar en DB
  await OtpCode.create({ phone, codeHash, purpose });

  // Enviar SMS
  const message = buildOtpMessage(purpose, code);

  const smsResult = await sendSMS(phone, message);

  if (!smsResult.success) {
    if (smsResult.error === 'SMS service not configured') {
      return { success: false, error: 'El servicio de SMS no está configurado. Contacta al administrador.' };
    }
    // Error real de SMS
    console.error('[otpService] Error enviando SMS OTP:', smsResult.error);
    return { success: false, error: 'No se pudo enviar el SMS. Intenta nuevamente.' };
  }

  return { success: true, smsSent: true };
}

/**
 * Verifica un código OTP contra el hash almacenado en DB.
 * Si attempts >= MAX_ATTEMPTS, invalida el código.
 *
 * @param {string} phone - Teléfono normalizado
 * @param {string} code - Código de 6 dígitos ingresado por el usuario
 * @param {string} purpose - 'register' o 'reset'
 * @returns {Promise<{valid: boolean, error?: string}>}
 */
async function verifyOTP(phone, code, purpose) {
  const otp = await OtpCode.findOne({ phone, purpose });

  if (!otp) {
    return { valid: false, error: 'Código incorrecto o expirado' };
  }

  // Si ya se agotaron los intentos, invalidar
  if (otp.attempts >= MAX_ATTEMPTS) {
    await OtpCode.deleteOne({ _id: otp._id });
    return { valid: false, error: 'Código bloqueado por demasiados intentos incorrectos. Solicita uno nuevo.' };
  }

  const isValid = await bcrypt.compare(String(code).trim(), otp.codeHash);

  if (!isValid) {
    // Incrementar intentos
    await OtpCode.updateOne({ _id: otp._id }, { $inc: { attempts: 1 } });
    const remaining = MAX_ATTEMPTS - (otp.attempts + 1);
    return {
      valid: false,
      error: remaining > 0
        ? `Código incorrecto. Te quedan ${remaining} intento(s).`
        : 'Código bloqueado por demasiados intentos incorrectos. Solicita uno nuevo.'
    };
  }

  // Código correcto: eliminar para que no pueda reutilizarse
  await OtpCode.deleteOne({ _id: otp._id });

  return { valid: true };
}

module.exports = { generateAndSendOTP, verifyOTP, buildOtpMessage };
