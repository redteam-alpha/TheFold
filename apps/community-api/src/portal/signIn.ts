// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  decidePortalLink,
  mayReceiveSignInLink,
  normalizeEmail,
  type PersonIdentity,
} from '@thefold/core';
import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { writeAudit } from '../db/audit.js';
import { enqueueOutbox } from '../db/outbox.js';

/**
 * Member sign-in by emailed link (ADR 0007). Every function here runs inside `withTenant`: row-level security
 * keeps a link, an account and a session inside their own church, so a token from one church is simply not
 * found under another's host.
 */

export const SIGN_IN_LINK_TTL_MS = 15 * 60_000;
export const SESSION_TTL_MS = 30 * 24 * 3_600_000;
/** At most this many links per address per window, whoever asks: the form cannot be used to flood an inbox. */
export const LINKS_PER_ADDRESS = 3;
export const LINK_WINDOW_MS = 15 * 60_000;

const TOKEN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest();

/** A random token for a link or a session; only its hash is ever stored. */
export function newToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

const emailSchema = z.email().max(254);

/**
 * Queues "email a sign-in link to this address". The answer never depends on whether the church knows the
 * address (that would tell a stranger who belongs); the worker decides, quietly, whether a link is sent.
 * Two requests for the same address in the same minute are one job.
 */
export async function requestSignIn(
  c: PoolClient,
  r: { email: string; ip: string | null; now: Date },
): Promise<{ ok: true } | { ok: false; reason: 'INVALID_EMAIL' }> {
  const email = normalizeEmail(r.email);
  if (!email || !emailSchema.safeParse(email).success)
    return { ok: false, reason: 'INVALID_EMAIL' };
  await enqueueOutbox(c, {
    kind: 'mail.signInLink',
    idempotencyKey: `sign-in:${email}:${Math.floor(r.now.getTime() / 60_000)}`,
    email,
    requestedIp: r.ip && isIP(r.ip) ? r.ip : null,
  });
  return { ok: true };
}

/** The adults and children in the church's records who use `email` (deleted and deceased people excluded). */
async function peopleUsing(c: PoolClient, email: string): Promise<PersonIdentity[]> {
  const { rows } = await c.query<{
    twenty_person_id: string;
    first_name: string;
    last_name: string;
    emails: string[];
    phones: string[];
    is_minor: boolean;
    shared_email: boolean;
    household_id: string | null;
  }>(
    `SELECT twenty_person_id, first_name, last_name, emails, phones, is_minor, shared_email, household_id
       FROM person_read
      WHERE deleted_at IS NULL AND lifecycle_stage <> 'DECEASED'
        AND EXISTS (SELECT 1 FROM unnest(emails) e WHERE lower(btrim(e)) = $1)`,
    [email],
  );
  return rows.map((r) => ({
    id: r.twenty_person_id,
    firstName: r.first_name,
    lastName: r.last_name,
    emails: r.emails,
    phones: r.phones,
    isMinor: r.is_minor,
    sharedEmail: r.shared_email,
    householdId: r.household_id,
  }));
}

export type PreparedLink =
  | { send: true; token: string; churchName: string; subdomain: string }
  | { send: false; reason: 'THROTTLED' | 'NOT_ELIGIBLE' };

/**
 * Worker side of a request: decides whether this address gets a link and, if so, stores the link's hash.
 * The caller emails the token after this transaction commits; a failed send retries with a fresh token.
 */
export async function prepareSignInLink(
  c: PoolClient,
  r: { email: string; ip: string | null; now: Date },
): Promise<PreparedLink> {
  const recent = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM magic_link WHERE email = $1 AND created_at > $2`,
    [r.email, new Date(r.now.getTime() - LINK_WINDOW_MS)],
  );
  if ((recent.rows[0]?.n ?? 0) >= LINKS_PER_ADDRESS) return { send: false, reason: 'THROTTLED' };

  if (!mayReceiveSignInLink(r.email, await peopleUsing(c, r.email)))
    return { send: false, reason: 'NOT_ELIGIBLE' };
  const disabled = await c.query(
    `SELECT 1 FROM portal_account WHERE email = $1 AND status = 'DISABLED'`,
    [r.email],
  );
  if ((disabled.rowCount ?? 0) > 0) return { send: false, reason: 'NOT_ELIGIBLE' };

  const { token, hash } = newToken();
  await c.query(
    `INSERT INTO magic_link (tenant_id, email, token_hash, requested_ip, created_at, expires_at)
     VALUES (fold_current_tenant(), $1, $2, $3, $4, $5)`,
    [r.email, hash, r.ip, r.now, new Date(r.now.getTime() + SIGN_IN_LINK_TTL_MS)],
  );
  const church = await c.query<{ name: string; subdomain: string }>(
    `SELECT name, subdomain FROM tenant WHERE id = fold_current_tenant()`,
  );
  const t = church.rows[0];
  if (!t) throw new Error('tenant not found');
  return { send: true, token, churchName: t.name, subdomain: t.subdomain };
}

export type LinkState = 'VERIFIED' | 'UNCONFIRMED';

export type Redeemed =
  | { ok: true; sessionToken: string; expiresAt: Date; accountId: string }
  | { ok: false; reason: 'INVALID' | 'DISABLED' };

/**
 * Uses a link: once, within its 15 minutes, in its own church. Creates the account on first use and links it
 * to a person only when exactly one adult uses the address and it is not a shared family address
 * (`decidePortalLink`); anything less certain waits for a person at the church to confirm. Never merges people.
 */
export async function redeemSignInLink(
  c: PoolClient,
  r: { token: string; now: Date },
): Promise<Redeemed> {
  if (!TOKEN.test(r.token)) return { ok: false, reason: 'INVALID' };
  const used = await c.query<{ email: string }>(
    `UPDATE magic_link SET used_at = $2
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2
      RETURNING email`,
    [hashToken(r.token), r.now],
  );
  const email = used.rows[0]?.email;
  if (!email) return { ok: false, reason: 'INVALID' };

  const account = await c.query<{ id: string; status: string }>(
    `INSERT INTO portal_account (tenant_id, email, last_login_at)
     VALUES (fold_current_tenant(), $1, $2)
     ON CONFLICT (tenant_id, email) DO UPDATE SET last_login_at = EXCLUDED.last_login_at
     RETURNING id, status`,
    [email, r.now],
  );
  const a = account.rows[0];
  if (!a) throw new Error('portal account upsert returned nothing');
  if (a.status !== 'ACTIVE') return { ok: false, reason: 'DISABLED' };

  // An existing link, including one staff rejected, is never re-decided here.
  const existing = await c.query<{ twenty_person_id: string }>(
    `SELECT twenty_person_id FROM person_link WHERE account_id = $1`,
    [a.id],
  );
  let personId = existing.rows[0]?.twenty_person_id ?? null;
  if (existing.rowCount === 0) {
    const decision = decidePortalLink(email, await peopleUsing(c, email));
    if (decision.decision === 'AUTO_LINK') {
      await c.query(
        `INSERT INTO person_link (tenant_id, account_id, twenty_person_id, status, method, confirmed_at)
         VALUES (fold_current_tenant(), $1, $2, 'VERIFIED', 'magic_link', $3)
         ON CONFLICT (tenant_id, account_id) DO NOTHING`,
        [a.id, decision.personId, r.now],
      );
      personId = decision.personId;
    }
  }

  const session = newToken();
  const expiresAt = new Date(r.now.getTime() + SESSION_TTL_MS);
  await c.query(
    `INSERT INTO portal_session (tenant_id, account_id, token_hash, created_at, expires_at)
     VALUES (fold_current_tenant(), $1, $2, $3, $4)`,
    [a.id, session.hash, r.now, expiresAt],
  );
  await writeAudit(c, {
    actorPersonId: personId,
    action: 'portal.signed_in',
    subjectType: 'portal_account',
    subjectId: a.id,
    via: 'magic_link',
  });
  return { ok: true, sessionToken: session.token, expiresAt, accountId: a.id };
}

export interface Member {
  accountId: string;
  email: string;
  /**
   * VERIFIED: the account is linked to an adult who is still in the church's records. UNCONFIRMED: not yet
   * (a shared address, several people, or a link that no longer holds); a person at the church confirms it.
   */
  link: LinkState;
  person: { id: string; firstName: string; lastName: string } | null;
}

/** The signed-in member for a session cookie, or null. Rechecked on every request, never cached. */
export async function memberForSession(
  c: PoolClient,
  token: string,
  now: Date,
): Promise<Member | null> {
  if (!TOKEN.test(token)) return null;
  const { rows } = await c.query<{
    account_id: string;
    email: string;
    person_id: string | null;
    first_name: string | null;
    last_name: string | null;
  }>(
    `SELECT a.id AS account_id, a.email, p.twenty_person_id AS person_id, p.first_name, p.last_name
       FROM portal_session s
       JOIN portal_account a ON a.id = s.account_id AND a.status = 'ACTIVE'
       LEFT JOIN person_link l ON l.account_id = a.id AND l.status = 'VERIFIED'
       LEFT JOIN person_read p ON p.twenty_person_id = l.twenty_person_id
                              AND p.deleted_at IS NULL AND NOT p.is_minor
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2`,
    [hashToken(token), now],
  );
  const m = rows[0];
  if (!m) return null;
  return {
    accountId: m.account_id,
    email: m.email,
    link: m.person_id ? 'VERIFIED' : 'UNCONFIRMED',
    person: m.person_id
      ? { id: m.person_id, firstName: m.first_name ?? '', lastName: m.last_name ?? '' }
      : null,
  };
}

export async function revokeSession(c: PoolClient, token: string, now: Date): Promise<void> {
  if (!TOKEN.test(token)) return;
  await c.query(
    `UPDATE portal_session SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(token), now],
  );
}

/**
 * Housekeeping. Links and sessions are kept 30 days past their end (for abuse review), then deleted. A sign-in
 * request's job holds the typed address, which may be a stranger's: it goes a day after it is done.
 */
export async function pruneSignIns(c: PoolClient, now: Date): Promise<void> {
  const day = 24 * 3_600_000;
  const month = new Date(now.getTime() - 30 * day);
  await c.query(`DELETE FROM magic_link WHERE expires_at < $1`, [month]);
  await c.query(
    `DELETE FROM portal_session WHERE expires_at < $1 OR (revoked_at IS NOT NULL AND revoked_at < $1)`,
    [month],
  );
  await c.query(
    `DELETE FROM outbox
      WHERE kind = 'mail.signInLink'
        AND ((status = 'DONE' AND done_at < $1) OR (status = 'DEAD' AND created_at < $2))`,
    [new Date(now.getTime() - day), month],
  );
}
