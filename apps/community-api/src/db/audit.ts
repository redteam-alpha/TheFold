// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PoolClient } from 'pg';

export interface AuditEntry {
  actorPersonId: string | null;
  actorRoles?: readonly string[];
  action: string;
  subjectType: string;
  subjectId: string | null;
  via?: string | null;
  reason?: string | null;
  meta?: Record<string, unknown>;
}

/** Appends to the immutable audit log. Must run inside `withTenant`, in the same transaction as the read it records. */
export async function writeAudit(client: PoolClient, e: AuditEntry): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (tenant_id, actor_person_id, actor_roles, action, subject_type, subject_id, via, reason, meta)
     VALUES (fold_current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      e.actorPersonId,
      [...(e.actorRoles ?? [])],
      e.action,
      e.subjectType,
      e.subjectId,
      e.via ?? null,
      e.reason ?? null,
      JSON.stringify(e.meta ?? {}),
    ],
  );
}
