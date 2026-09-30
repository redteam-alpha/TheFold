// SPDX-License-Identifier: AGPL-3.0-or-later
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for confidential text (prayer requests, care notes, questions).
 *
 *   KEK (key-encryption key, held OUTSIDE the database: env today, a KMS later)
 *     wraps -> per-tenant DEK (data-encryption key, stored wrapped in tenant_secret)
 *       encrypts -> each confidential field, with AES-256-GCM
 *
 * Every ciphertext is bound (as GCM additional authenticated data) to its tenant, purpose and record
 * id, so a stolen or copied blob cannot be replayed into another row, table or tenant.
 * Blob layout: nonce(12) || ciphertext || tag(16).
 */
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function generateDataKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** Additional authenticated data that pins a ciphertext to where it belongs. */
export function aadFor(parts: { tenantId: string; purpose: string; recordId: string }): string {
  return `${parts.tenantId}|${parts.purpose}|${parts.recordId}`;
}

function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  if (key.length !== KEY_BYTES) throw new RangeError('AES-256 key must be 32 bytes');
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
}

function open(key: Buffer, blob: Buffer, aad: string): Buffer {
  if (key.length !== KEY_BYTES) throw new RangeError('AES-256 key must be 32 bytes');
  if (blob.length < NONCE_BYTES + TAG_BYTES) throw new Error('Ciphertext is too short');
  const nonce = blob.subarray(0, NONCE_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const ciphertext = blob.subarray(NONCE_BYTES, blob.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    // Deliberately vague: do not reveal whether the key, the AAD or the bytes were wrong.
    throw new Error('Decryption failed', { cause: error });
  }
}

export const encryptText = (dek: Buffer, plaintext: string, aad: string): Buffer =>
  seal(dek, Buffer.from(plaintext, 'utf8'), aad);
export const decryptText = (dek: Buffer, blob: Buffer, aad: string): string =>
  open(dek, blob, aad).toString('utf8');

export const wrapKey = (dek: Buffer, kek: Buffer, aad: string): Buffer => seal(kek, dek, aad);
export const unwrapKey = (wrapped: Buffer, kek: Buffer, aad: string): Buffer =>
  open(kek, wrapped, aad);

/** The key-encryption key from `FOLD_KEK` (base64, 32 bytes). Fails loudly if missing or malformed. */
export function kekFromEnv(env: Record<string, string | undefined> = process.env): Buffer {
  const raw = env['FOLD_KEK'];
  if (!raw) throw new Error('FOLD_KEK is not set (generate one with: openssl rand -base64 32)');
  const kek = Buffer.from(raw, 'base64');
  if (kek.length !== KEY_BYTES) throw new Error('FOLD_KEK must decode to exactly 32 bytes');
  return kek;
}
