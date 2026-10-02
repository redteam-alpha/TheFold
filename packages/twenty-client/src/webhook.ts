// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Twenty signs webhook deliveries with HMAC-SHA256 and sends `X-Twenty-Webhook-Signature` and
 * `X-Twenty-Webhook-Timestamp`.
 *
 * Read from the v2.43.0 build (`call-webhook.job.js`, 2026-10-02), not yet seen in a delivery: the signed
 * string is `"<timestamp>:<JSON body>"` (a colon; the docs we first worked from implied a dot), the
 * signature is lowercase hex, the timestamp is `Date.now()` in milliseconds, and a third header,
 * `X-Twenty-Webhook-Nonce`, is sent but not signed. With no secret on the webhook Twenty sends none of them.
 * If a real delivery disagrees, change `defaultSignedPayload` and nothing else (docs/verification-status.md).
 */
export const SIGNATURE_HEADER = 'x-twenty-webhook-signature';
export const TIMESTAMP_HEADER = 'x-twenty-webhook-timestamp';

export const defaultSignedPayload = (timestamp: string, rawBody: string): string =>
  `${timestamp}:${rawBody}`;

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
  // v2.43.0 sends milliseconds (read from the build); seconds are accepted too, in case that ever changes.
  const tsMs = timestamp.length > 11 ? Number(timestamp) : Number(timestamp) * 1000;
  const tolerance = (input.toleranceSeconds ?? 300) * 1000;
  if (Math.abs(input.now - tsMs) > tolerance) return { ok: false, reason: 'STALE' };

  const expected = Buffer.from(signWebhook(secret, timestamp, rawBody, input.signedPayload), 'hex');
  const given = Buffer.from(signature, 'hex');
  const equal = expected.length === given.length && timingSafeEqual(expected, given);
  return equal ? { ok: true } : { ok: false, reason: 'BAD_SIGNATURE' };
}
