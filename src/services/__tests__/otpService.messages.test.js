/**
 * Tests for OTP SMS message templates in otpService.js
 *
 * Validates that all templates use pure ASCII characters so that AWS SNS
 * uses GSM-7 encoding (160 chars/SMS, 1 part) instead of UCS-2 (70 chars/SMS, 2 parts).
 */

// Marca y dominio salen del entorno (#218): BRAND_NAME (default GANAMOS) + PUBLIC_BASE_URL.
process.env.PUBLIC_BASE_URL = 'https://www.cargasganamos.com';
const { buildOtpMessage } = require('../otpService');

const ASCII_REGEX = /^[\x00-\x7F]*$/;
const PURPOSES = ['register', 'reset', 'change-password', 'login', 'unknown'];
const SAMPLE_CODE = '123456';

describe('OTP SMS message templates', () => {
  test.each(PURPOSES)(
    'purpose "%s": message is ASCII-only, ≤160 chars, and contains required strings',
    (purpose) => {
      const message = buildOtpMessage(purpose, SAMPLE_CODE);

      expect(ASCII_REGEX.test(message)).toBe(true);
      expect(message.length).toBeLessThanOrEqual(160);
      expect(message).toContain(SAMPLE_CODE);
      // Espacio intencional para evitar detección como URL por filtros antispam
      // de los carriers (sobre todo en Paraguay y Argentina).
      expect(message).toContain('cargasganamos .com');
      expect(message).toContain('GANAMOS:');
      expect(message).not.toContain('VIPCARGAS');
    }
  );
});
