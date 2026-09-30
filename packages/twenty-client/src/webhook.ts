// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Twenty signs webhook deliveries with HMAC-SHA256 and sends `X-Twenty-Webhook-Signature` and
 * `X-Twenty-Webhook-Timestamp` (docs research, 2026-09-30).
 *
 * UNVERIFIED: the exact string that is signed and the signature's encoding. The default below is the
 * common `HMAC(secret, "<timestamp>.<rawBody>")` as lowercase hex. The M0 harness (scripts/m0) checks
 * this against a real Twenty webhook; if it differs, change `signedPayload` and nothing else.
 */
export const SIGNATURE_HEADER = 'x-twenty-webhook-signature';
export const TIMESTAMP_HEADER = 'x-twenty-webhook-timestamp';

export const defaultSignedPayload = (timestamp: string, rawBody: string): string =>
  `${timestamp}.${rawBody}`;

export type WebhookVerdict =
  { ok: true } | { ok: false; reason: 'MALFORMED' | 'STALE' | 'BAD_SIGNATURE' };

export function signWebhook(
  secret: string,
  timestamp: string,
  rawBody: string,
  signedPayload: (t: string, b: string) => string = defaultSignedPayload,
): string {
  return createHmac('sha256', secret).update(signedPayload(timestamp, rawBody)).digest('hex');
}

/**
 * Verifies a delivery. Always pass the RAW request body (before JSON parsing). Rejects timestamps
 * outside the tolerance window in either direction, which stops replays of captured deliveries.
 */
export function verifyWebhook(input: {
  secret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  now: number;
  toleranceSeconds?: number;
  signedPayload?: (t: string, b: string) => string;
}): WebhookVerdict {
  const { secret, timestamp, signature, rawBody } = input;
  if (!timestamp || !signature || !/^\d+$/.test(timestamp) || !/^[0-9a-f]+$/i.test(signature)) {
    return { ok: false, reason: 'MALFORMED' };
  }
  // Twenty's timestamp unit is UNVERIFIED; accept seconds or milliseconds.
  const tsMs = timestamp.length > 11 ? Number(timestamp) : Number(timestamp) * 1000;
  const tolerance = (input.toleranceSeconds ?? 300) * 1000;
  if (Math.abs(input.now - tsMs) > tolerance) return { ok: false, reason: 'STALE' };

  const expected = Buffer.from(signWebhook(secret, timestamp, rawBody, input.signedPayload), 'hex');
  const given = Buffer.from(signature, 'hex');
  const equal = expected.length === given.length && timingSafeEqual(expected, given);
  return equal ? { ok: true } : { ok: false, reason: 'BAD_SIGNATURE' };
}
