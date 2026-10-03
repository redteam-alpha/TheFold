// SPDX-License-Identifier: AGPL-3.0-or-later

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export type CaptchaVerdict = 'PASSED' | 'FAILED' | 'UNAVAILABLE';

/**
 * Checks a Cloudflare Turnstile token. FAILED means Cloudflare looked at the token and said no; UNAVAILABLE
 * means we could not ask (network error, timeout, non-JSON). The caller fails closed on FAILED and open on
 * UNAVAILABLE: a Cloudflare outage must not turn every first-time guest away, and the honeypot and rate limit
 * still stand in front of the form.
 */
export async function verifyTurnstile(input: {
  secret: string;
  token: string;
  remoteIp: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<CaptchaVerdict> {
  const body = new URLSearchParams({ secret: input.secret, response: input.token });
  if (input.remoteIp) body.set('remoteip', input.remoteIp);
  try {
    const res = await (input.fetch ?? fetch)(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(input.timeoutMs ?? 5000),
    });
    if (!res.ok) return 'UNAVAILABLE';
    const json = (await res.json()) as { success?: unknown };
    return json.success === true ? 'PASSED' : 'FAILED';
  } catch {
    return 'UNAVAILABLE';
  }
}
