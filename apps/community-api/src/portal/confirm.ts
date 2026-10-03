// SPDX-License-Identifier: AGPL-3.0-or-later
import { STAFF_ROLES, normalizeEmail, type StaffRole } from '@thefold/core';
import type { PoolClient } from 'pg';
import { writeAudit } from '../db/audit.js';

/**
 * Staff confirming a sign-in that could not be linked to a person automatically (ADR 0007): a shared family
 * address, or two adults on one address. A person at the church who knows the family says which adult this is.
 *
 * Only `admin` and `welcome_lead` may do it, and only to an adult whose record in the church's records carries
 * the address that signed in: staff cannot attach an account to an arbitrary person.
 *
 * Everything runs inside `withTenant`.
 */
export const CONFIRMING_ROLES: readonly StaffRole[] = ['admin', 'welcome_lead'];

export async function activeStaffRoles(c: PoolClient, personId: string): Promise<StaffRole[]> {
  const { rows } = await c.query<{ role: StaffRole }>(
    `SELECT DISTINCT role FROM staff_role_assignment WHERE twenty_person_id = $1 AND revoked_at IS NULL ORDER BY role`,
    [personId],
  );
  return rows.map((r) => r.role);
}

export const canConfirmSignIns = (roles: readonly StaffRole[]): boolean =>
  roles.some((r) => CONFIRMING_ROLES.includes(r));

export interface Candidate {
  personId: string;
  firstName: string;
  lastName: string;
}

export interface WaitingSignIn {
  accountId: string;
  email: string;
  lastSignedInAt: string | null;
  /** The adults whose records use this address. Children are never offered. */
  candidates: Candidate[];
}

async function adultsUsing(c: PoolClient, email: string): Promise<Candidate[]> {
  const { rows } = await c.query<{
    twenty_person_id: string;
    first_name: string;
    last_name: string;
    emails: string[];
    shared_email: boolean;
  }>(
    `SELECT twenty_person_id, first_name, last_name, emails, shared_email FROM person_read
      WHERE deleted_at IS NULL AND lifecycle_stage <> 'DECEASED' AND NOT is_minor
        AND EXISTS (SELECT 1 FROM unnest(emails) e WHERE lower(btrim(e)) = $1)
      ORDER BY first_name, last_name, twenty_person_id`,
    [email],
  );
  return rows.map((r) => ({
    personId: r.twenty_person_id,
    firstName: r.first_name,
    lastName: r.last_name,
  }));
}

/** Accounts that have signed in but are linked to no one yet, oldest first. */
export async function waitingSignIns(c: PoolClient): Promise<WaitingSignIn[]> {
  const { rows } = await c.query<{ id: string; email: string; last_login_at: Date | null }>(
    `SELECT a.id, a.email, a.last_login_at FROM portal_account a
      WHERE a.status = 'ACTIVE' AND a.last_login_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM person_link l WHERE l.account_id = a.id)
      ORDER BY a.last_login_at, a.id`,
  );
  const out: WaitingSignIn[] = [];
  for (const r of rows)
    out.push({
      accountId: r.id,
      email: r.email,
      lastSignedInAt: r.last_login_at?.toISOString() ?? null,
      candidates: await adultsUsing(c, r.email),
    });
  return out;
}

export type ConfirmResult =
  { ok: true } | { ok: false; reason: 'NOT_FOUND' | 'ALREADY_LINKED' | 'NOT_A_CANDIDATE' };

export async function confirmSignIn(
  c: PoolClient,
  r: { staffPersonId: string; accountId: string; personId: string; now: Date },
): Promise<ConfirmResult> {
  const account = (
    await c.query<{ email: string }>(
      `SELECT email FROM portal_account WHERE id = $1 AND status = 'ACTIVE'`,
      [r.accountId],
    )
  ).rows[0];
  if (!account) return { ok: false, reason: 'NOT_FOUND' };
  const email = normalizeEmail(account.email);
  const candidates = email ? await adultsUsing(c, email) : [];
  if (!candidates.some((p) => p.personId === r.personId))
    return { ok: false, reason: 'NOT_A_CANDIDATE' };

  const inserted = await c.query(
    `INSERT INTO person_link (tenant_id, account_id, twenty_person_id, status, method, confirmed_by_person, confirmed_at)
     VALUES (fold_current_tenant(), $1, $2, 'VERIFIED', 'staff_confirmed', $3, $4)
     ON CONFLICT (tenant_id, account_id) DO NOTHING`,
    [r.accountId, r.personId, r.staffPersonId, r.now],
  );
  if (inserted.rowCount === 0) return { ok: false, reason: 'ALREADY_LINKED' };
  await writeAudit(c, {
    actorPersonId: r.staffPersonId,
    actorRoles: await activeStaffRoles(c, r.staffPersonId),
    action: 'portal.link_confirmed',
    subjectType: 'portal_account',
    subjectId: r.accountId,
    // How many adults the address could have meant, for review.
    meta: { personId: r.personId, candidates: candidates.length },
  });
  return { ok: true };
}

export const isStaffRole = (v: string): v is StaffRole =>
  (STAFF_ROLES as readonly string[]).includes(v);

/** Operator command: give a person in the church's records a staff role in the portal. Idempotent. */
export async function grantStaffRole(
  c: PoolClient,
  personId: string,
  role: StaffRole,
): Promise<'GRANTED' | 'ALREADY' | 'NO_SUCH_PERSON'> {
  const known = await c.query(
    `SELECT 1 FROM person_read WHERE twenty_person_id = $1 AND deleted_at IS NULL AND NOT is_minor`,
    [personId],
  );
  if (known.rowCount === 0) return 'NO_SUCH_PERSON';
  const existing = await c.query(
    `SELECT 1 FROM staff_role_assignment WHERE twenty_person_id = $1 AND role = $2 AND revoked_at IS NULL`,
    [personId, role],
  );
  if ((existing.rowCount ?? 0) > 0) return 'ALREADY';
  await c.query(
    `INSERT INTO staff_role_assignment (tenant_id, twenty_person_id, role) VALUES (fold_current_tenant(), $1, $2)`,
    [personId, role],
  );
  await writeAudit(c, {
    actorPersonId: null,
    action: 'staff.role_granted',
    subjectType: 'person',
    subjectId: personId,
    via: 'cli',
    meta: { role },
  });
  return 'GRANTED';
}

export async function revokeStaffRole(
  c: PoolClient,
  personId: string,
  role: StaffRole,
  now: Date,
): Promise<'REVOKED' | 'NOT_HELD'> {
  const r = await c.query(
    `UPDATE staff_role_assignment SET revoked_at = $3
      WHERE twenty_person_id = $1 AND role = $2 AND revoked_at IS NULL`,
    [personId, role, now],
  );
  if ((r.rowCount ?? 0) === 0) return 'NOT_HELD';
  await writeAudit(c, {
    actorPersonId: null,
    action: 'staff.role_revoked',
    subjectType: 'person',
    subjectId: personId,
    via: 'cli',
    meta: { role },
  });
  return 'REVOKED';
}
