// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  aadFor,
  decryptText,
  encryptText,
  generateDataKey,
  kekFromEnv,
  unwrapKey,
  wrapKey,
} from '../src/crypto/envelope.js';
import { uuidv7 } from '../src/ids.js';

const aad = aadFor({ tenantId: 't1', purpose: 'prayer_request', recordId: 'r1' });

describe('envelope encryption', () => {
  it('round-trips text, including unicode and empty strings', () => {
    const dek = generateDataKey();
    for (const s of ['', 'Please pray for Mom’s surgery 🙏', 'x'.repeat(10_000)]) {
      expect(decryptText(dek, encryptText(dek, s, aad), aad)).toBe(s);
    }
  });

  it('property: any string round-trips', () => {
    const dek = generateDataKey();
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary', maxLength: 500 }),
        (s) => decryptText(dek, encryptText(dek, s, aad), aad) === s,
      ),
    );
  });

  it('does not contain the plaintext and uses a fresh nonce every time', () => {
    const dek = generateDataKey();
    const blobs = Array.from({ length: 200 }, () => encryptText(dek, 'secret prayer', aad));
    expect(blobs.every((b) => !b.includes(Buffer.from('secret prayer')))).toBe(true);
    expect(new Set(blobs.map((b) => b.subarray(0, 12).toString('hex'))).size).toBe(200);
  });

  it('rejects any tampering with nonce, ciphertext or tag', () => {
    const dek = generateDataKey();
    const blob = encryptText(dek, 'hello', aad);
    for (const i of [0, 5, 11, 12, blob.length - 17, blob.length - 1]) {
      const bad = Buffer.from(blob);
      bad[i] = (bad[i] as number) ^ 0x01;
      expect(() => decryptText(dek, bad, aad), `flipped byte ${i}`).toThrow('Decryption failed');
    }
    expect(() => decryptText(dek, blob.subarray(0, 20), aad)).toThrow('too short');
  });

  it('is bound to its tenant, purpose and record: it cannot be replayed elsewhere', () => {
    const dek = generateDataKey();
    const blob = encryptText(dek, 'hello', aad);
    for (const other of [
      aadFor({ tenantId: 't2', purpose: 'prayer_request', recordId: 'r1' }),
      aadFor({ tenantId: 't1', purpose: 'care_note', recordId: 'r1' }),
      aadFor({ tenantId: 't1', purpose: 'prayer_request', recordId: 'r2' }),
    ]) {
      expect(() => decryptText(dek, blob, other)).toThrow('Decryption failed');
    }
  });

  it('does not decrypt under a different key', () => {
    const blob = encryptText(generateDataKey(), 'hello', aad);
    expect(() => decryptText(generateDataKey(), blob, aad)).toThrow('Decryption failed');
  });

  it('wraps and unwraps data keys, bound to their context', () => {
    const kek = randomBytes(32);
    const dek = generateDataKey();
    const wrapped = wrapKey(dek, kek, 't1|tenant_secret|data_key|1');
    expect(unwrapKey(wrapped, kek, 't1|tenant_secret|data_key|1').equals(dek)).toBe(true);
    expect(() => unwrapKey(wrapped, kek, 't1|tenant_secret|data_key|2')).toThrow();
    expect(() => unwrapKey(wrapped, randomBytes(32), 't1|tenant_secret|data_key|1')).toThrow();
  });

  it('insists on 32-byte keys', () => {
    expect(() => encryptText(Buffer.alloc(16), 'x', aad)).toThrow(RangeError);
  });

  describe('kekFromEnv', () => {
    it('reads a base64 32-byte key', () => {
      const raw = randomBytes(32);
      expect(kekFromEnv({ FOLD_KEK: raw.toString('base64') }).equals(raw)).toBe(true);
    });
    it('fails loudly when missing or the wrong size', () => {
      expect(() => kekFromEnv({})).toThrow(/FOLD_KEK is not set/);
      expect(() => kekFromEnv({ FOLD_KEK: randomBytes(16).toString('base64') })).toThrow(
        /32 bytes/,
      );
    });
  });
});

describe('uuidv7', () => {
  const zeros = (n: number) => new Uint8Array(n);

  it('has the version and variant bits and encodes the timestamp', () => {
    const now = Date.UTC(2026, 8, 30, 12, 0, 0);
    const id = uuidv7(now, randomBytes);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(now);
  });

  it('is strictly increasing, even within one millisecond', () => {
    const base = Date.UTC(2030, 0, 1);
    const ids = Array.from({ length: 5000 }, () => uuidv7(base, zeros));
    expect(new Set(ids).size).toBe(5000);
    expect([...ids].sort()).toEqual(ids);
  });

  it('sorts by time across milliseconds', () => {
    const base = Date.UTC(2031, 0, 1);
    const ids = [base, base + 1, base + 1000, base + 86_400_000].map((t) => uuidv7(t, randomBytes));
    expect([...ids].sort()).toEqual(ids);
  });
});
