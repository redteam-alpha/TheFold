// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { webhookHintSchema, type WebhookHint } from '@thefold/shared';

/**
 * Distils a Twenty webhook delivery into a hint: "this record of this object may have changed".
 *
 * UNVERIFIED: Twenty's payload shape. Documentation describes `eventName` as `<object>.<action>` (e.g.
 * `person.updated`) and the record under `record`; this reads that first and tolerates the obvious variants,
 * so a slightly different shape still works and a very different one is ignored (returns null), never
 * mis-applied. Nothing in the payload is trusted as data: the worker refetches the record from Twenty.
 *
 * The delivery id deduplicates exact redeliveries. If Twenty sends no id, a hash of the raw body is used: a
 * redelivery of the same bytes is then still recognised.
 */
const ACTIONS: Record<string, WebhookHint['action']> = {
  created: 'created',
  updated: 'updated',
  upserted: 'updated',
  restored: 'updated',
  deleted: 'deleted',
  destroyed: 'deleted',
};

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

export function hintFromTwentyWebhook(input: {
  body: unknown;
  rawBody: string;
  tenantId: string;
  receivedAt: number;
}): WebhookHint | null {
  const b = obj(input.body);
  if (!b) return null;
  const eventName = str(b['eventName']) ?? str(b['event']) ?? str(b['type']);
  const [eventObject, eventAction] = eventName?.split('.') ?? [];
  const objectType = str(obj(b['objectMetadata'])?.['nameSingular']) ?? eventObject;
  const action = eventAction ? ACTIONS[eventAction] : undefined;
  const record = obj(b['record']) ?? obj(b['data']);
  const recordId = str(record?.['id']) ?? str(b['recordId']);
  if (!objectType || !action || !recordId) return null;

  const deliveryId =
    str(b['eventId']) ??
    str(b['id']) ??
    `sha256:${createHash('sha256').update(input.rawBody).digest('hex')}`;
  const parsed = webhookHintSchema.safeParse({
    tenantId: input.tenantId,
    objectType,
    recordId,
    action,
    deliveryId: deliveryId.slice(0, 200),
    receivedAt: input.receivedAt,
  });
  return parsed.success ? parsed.data : null;
}
