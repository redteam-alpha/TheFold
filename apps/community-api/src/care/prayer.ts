// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  canViewPrayer,
  type PrayerAccess,
  type PrayerRequestAccessMeta,
  type PrayerStatus,
  type PrayerTier,
  type PrayerViewer,
  type StaffRole,
} from '@thefold/core';
import type { PrayerRequestCreate } from '@thefold/shared';
import type { PoolClient } from 'pg';
import { decryptText, encryptText, aadFor } from '../crypto/envelope.js';
import { getCurrentDataKey, getDataKeyVersion } from '../crypto/tenantKeys.js';
import { writeAudit } from '../db/audit.js';
import { enqueueOutbox } from '../db/outbox.js';
import { uuidv7 } from '../ids.js';

/** Requests leave the congregation's view after 90 days unless the author renews or answers them. */
export const PRAYER_LIFETIME_DAYS = 90;
const DAY_MS = 86_400_000;

async function tenantId(client: PoolClient): Promise<string> {
  const { rows } = await client.query<{ id: string | null }>('SELECT fold_current_tenant() AS id');
  const id = rows[0]?.id;
  if (!id) throw new Error('No tenant context: run inside withTenant');
  return id;
}

export interface CreatePrayerInput extends PrayerRequestCreate {
  authorPersonId: string;
  now: Date;
}

/**
 * Stores the request encrypted, records the consent, and -- when a follow-up was asked for or the
 * request is care-only -- queues a metadata-only CareRequest for Twenty. The text itself never
 * goes to Twenty (ADR 0004).
 */
export async function createPrayerRequest(
  client: PoolClient,
  kek: Buffer,
  input: CreatePrayerInput,
): Promise<{ id: string; careRequestQueued: boolean }> {
  const tid = await tenantId(client);
  const { dek, version } = await getCurrentDataKey(client, kek);
  const id = uuidv7(input.now.getTime());
  const ciphertext = encryptText(
    dek,
    input.body,
    aadFor({ tenantId: tid, purpose: 'prayer_request', recordId: id }),
  );
  const needsCare = input.tier === 'CARE_ONLY' || input.followUpWanted;

  await client.query(
    `INSERT INTO prayer_request (id, tenant_id, author_person_id, body_ciphertext, key_version, tier, group_id,
                                 anonymous_to_community, about_someone_else, follow_up_wanted, care_request_ref,
                                 consent_version, consented_at, created_at, expires_at)
     VALUES ($1, fold_current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, $13)`,
    [
      id,
      input.authorPersonId,
      ciphertext,
      version,
      input.tier,
      input.groupId ?? null,
      input.anonymousToCommunity,
      input.aboutSomeoneElse,
      input.followUpWanted,
      needsCare ? id : null,
      input.consentVersion,
      input.now,
      new Date(input.now.getTime() + PRAYER_LIFETIME_DAYS * DAY_MS),
    ],
  );
  await client.query(
    `INSERT INTO consent_log (tenant_id, person_id, kind, version, granted, source, at)
     VALUES (fold_current_tenant(), $1, 'prayer_request', $2, true, 'portal', $3)`,
    [input.authorPersonId, input.consentVersion, input.now],
  );
  if (needsCare) {
    await enqueueOutbox(client, {
      kind: 'twenty.createCareRequest',
      idempotencyKey: `care:prayer:${id}`,
      careRequest: {
        personId: input.authorPersonId,
        ownerPersonId: null,
        priority: 'NORMAL',
        category: 'PRAYER',
        communityRef: id,
      },
    });
  }
  return { id, careRequestQueued: needsCare };
}

/** Who is asking: roles from portal-side assignments, groups from the Twenty read model. */
export async function loadViewer(client: PoolClient, personId: string): Promise<PrayerViewer> {
  const roles = await client.query<{ role: StaffRole }>(
    `SELECT DISTINCT role FROM staff_role_assignment WHERE twenty_person_id = $1 AND revoked_at IS NULL`,
    [personId],
  );
  const groups = await client.query<{ group_id: string }>(
    `SELECT group_id FROM membership_read WHERE person_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL`,
    [personId],
  );
  // A verified member is an ADULT whose portal account is linked to this Person and confirmed.
  const verified = await client.query(
    `SELECT 1
       FROM person_link l
       JOIN person_read p ON p.tenant_id = l.tenant_id AND p.twenty_person_id = l.twenty_person_id
      WHERE l.twenty_person_id = $1 AND l.status = 'VERIFIED' AND p.is_minor = false AND p.deleted_at IS NULL`,
    [personId],
  );
  return {
    personId,
    roles: roles.rows.map((r) => r.role),
    isVerifiedMember: verified.rowCount === 1,
    activeGroupIds: groups.rows.map((g) => g.group_id),
  };
}

export type PrayerReadResult =
  | { allowed: false; reason: Extract<PrayerAccess, { allow: false }>['reason'] | 'NOT_FOUND' }
  | {
      allowed: true;
      id: string;
      body: string;
      tier: PrayerTier;
      status: PrayerStatus;
      /** Null when the author asked to be anonymous to the community and the viewer is not the author or care path. */
      authorPersonId: string | null;
      prayedCount: number;
    };

/**
 * The only read path for prayer text. Decides access with `canViewPrayer`, audits every care-path read
 * (and every denied attempt by someone holding a care role) in the same transaction, then decrypts.
 * The response for a request you may not see is identical whether or not it exists.
 */
export async function readPrayerRequest(
  client: PoolClient,
  kek: Buffer,
  viewer: PrayerViewer,
  requestId: string,
  ctx: { breakGlassReason?: string | null } = {},
): Promise<PrayerReadResult> {
  const tid = await tenantId(client);
  const { rows } = await client.query<{
    id: string;
    author_person_id: string;
    body_ciphertext: Buffer;
    key_version: number;
    tier: PrayerTier;
    group_id: string | null;
    status: PrayerStatus;
    anonymous_to_community: boolean;
    assigned_care_owner_id: string | null;
    prayed: string;
  }>(
    `SELECT r.id, r.author_person_id, r.body_ciphertext, r.key_version, r.tier, r.group_id, r.status,
            r.anonymous_to_community, r.assigned_care_owner_id,
            (SELECT count(*) FROM prayer_reaction x WHERE x.request_id = r.id) AS prayed
       FROM prayer_request r WHERE r.id = $1`,
    [requestId],
  );
  const row = rows[0];
  if (!row) return { allowed: false, reason: 'NOT_FOUND' };

  const meta: PrayerRequestAccessMeta = {
    authorPersonId: row.author_person_id,
    tier: row.tier,
    groupId: row.group_id,
    status: row.status,
    assignedCareOwnerId: row.assigned_care_owner_id,
    anonymousToCommunity: row.anonymous_to_community,
  };
  const access = canViewPrayer(viewer, meta, ctx);
  const holdsCareRole = viewer.roles.includes('care_team') || viewer.roles.includes('pastor');

  if (!access.allow) {
    if (holdsCareRole) {
      await writeAudit(client, {
        actorPersonId: viewer.personId,
        actorRoles: viewer.roles,
        action: 'PRAYER_READ_DENIED',
        subjectType: 'PRAYER_REQUEST',
        subjectId: requestId,
        reason: ctx.breakGlassReason ?? null,
        meta: { deniedBecause: access.reason },
      });
    }
    return { allowed: false, reason: access.reason };
  }

  if (access.audit) {
    await writeAudit(client, {
      actorPersonId: viewer.personId,
      actorRoles: viewer.roles,
      action: 'PRAYER_READ',
      subjectType: 'PRAYER_REQUEST',
      subjectId: requestId,
      via: access.via,
      reason: ctx.breakGlassReason ?? null,
    });
  }

  const dek = await getDataKeyVersion(client, kek, row.key_version);
  const body = decryptText(
    dek,
    row.body_ciphertext,
    aadFor({ tenantId: tid, purpose: 'prayer_request', recordId: row.id }),
  );
  return {
    allowed: true,
    id: row.id,
    body,
    tier: row.tier,
    status: row.status,
    authorPersonId: access.showAuthor ? row.author_person_id : null,
    prayedCount: Number(row.prayed),
  };
}

/** Marks requests past their 90 days as EXPIRED so they leave the congregation's view. Returns the ids (to prompt authors). */
export async function expirePrayerRequests(client: PoolClient, now: Date): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `UPDATE prayer_request SET status = 'EXPIRED' WHERE status = 'ACTIVE' AND expires_at <= $1 RETURNING id`,
    [now],
  );
  return rows.map((r) => r.id);
}

/** For the author's "How we care" page: how many *different* care-team members opened their request. Never names. */
export async function countCareViews(client: PoolClient, requestId: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(DISTINCT actor_person_id) AS n FROM audit_log
      WHERE subject_type = 'PRAYER_REQUEST' AND subject_id = $1 AND action = 'PRAYER_READ'`,
    [requestId],
  );
  return Number(rows[0]?.n ?? 0);
}
