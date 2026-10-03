// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  REACTION_KINDS,
  canModerate,
  canPost,
  canReadFeed,
  reactionSummary,
  shortName,
  visibleText,
  type ContentStatus,
  type ReactionKind,
  type ReactionSummary,
} from '@thefold/core';
import type { PoolClient } from 'pg';
import { writeAudit } from '../db/audit.js';
import { groupAccess } from './groups.js';

/**
 * A group's posts, comments, reactions and reports (ADR 0009). Who may read, write or moderate is decided by
 * `@thefold/core` (`canReadFeed`, `canPost`, `canModerate`, `reactionSummary`, `visibleText`); this module
 * reads and writes the rows. The words live only here, never in Twenty.
 *
 * Everything runs inside `withTenant`, for a VERIFIED member (`personId` is their linked Twenty person).
 * "Not found" and "not allowed to see it" look the same from outside.
 */

export const POSTS_PER_HOUR = 10;
export const COMMENTS_PER_HOUR = 60;
export const PAGE_SIZE = 20;
const POST_MAX = 5000;
const COMMENT_MAX = 2000;
const REASON_MAX = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FeedResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; reason: 'NOT_FOUND' | 'NOT_ALLOWED' | 'INVALID' | 'RATE_LIMITED' };

/**
 * Plain text, as typed: line breaks kept, other control characters dropped, trimmed. Never interpreted as
 * markup; the pages escape it.
 */
export function cleanText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const text = [...raw.replace(/\r\n?/g, '\n')]
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return ch === '\n' || ch === '\t' || (code >= 0x20 && code !== 0x7f);
    })
    .join('')
    .trim();
  return text.length >= 1 && text.length <= max ? text : null;
}

const authorName = (row: {
  first_name: string | null;
  last_name: string | null;
  gone: boolean | null;
}) =>
  row.first_name === null || row.gone
    ? 'A former member'
    : shortName(row.first_name, row.last_name ?? '');

export interface PostView {
  id: string;
  groupId: string;
  author: string;
  mine: boolean;
  /** Null when removed (for everyone but the author). */
  text: string | null;
  removed: boolean;
  createdAt: string;
  reactions: ReactionSummary;
}

interface PostRow {
  id: string;
  group_id: string;
  author_person_id: string;
  body: string;
  status: ContentStatus;
  created_at: Date;
  first_name: string | null;
  last_name: string | null;
  gone: boolean | null;
}

const postSelect = `SELECT p.id, p.group_id, p.author_person_id, p.body, p.status, p.created_at,
       a.first_name, a.last_name, (a.deleted_at IS NOT NULL) AS gone
  FROM post p LEFT JOIN person_read a ON a.twenty_person_id = p.author_person_id`;

async function reactionsFor(
  c: PoolClient,
  postIds: string[],
): Promise<Map<string, { personId: string; kind: ReactionKind }[]>> {
  const out = new Map<string, { personId: string; kind: ReactionKind }[]>();
  if (postIds.length === 0) return out;
  const { rows } = await c.query<{ subject_id: string; person_id: string; kind: ReactionKind }>(
    `SELECT subject_id, person_id, kind FROM reaction WHERE subject_type = 'POST' AND subject_id = ANY($1::uuid[])`,
    [postIds],
  );
  for (const r of rows) {
    const list = out.get(r.subject_id) ?? [];
    list.push({ personId: r.person_id, kind: r.kind });
    out.set(r.subject_id, list);
  }
  return out;
}

function postView(
  viewer: string,
  row: PostRow,
  reactions: Map<string, { personId: string; kind: ReactionKind }[]>,
): PostView | null {
  const v = visibleText(viewer, {
    authorPersonId: row.author_person_id,
    status: row.status,
    body: row.body,
  });
  if (!v) return null;
  return {
    id: row.id,
    groupId: row.group_id,
    author: authorName(row),
    mine: row.author_person_id === viewer,
    text: v.text,
    removed: v.removed,
    createdAt: row.created_at.toISOString(),
    reactions: reactionSummary(viewer, row.author_person_id, reactions.get(row.id) ?? []),
  };
}

/** The feed position after a page: "<created_at ISO>~<id>". Opaque to clients. */
const cursorOf = (row: PostRow) => `${row.created_at.toISOString()}~${row.id}`;
function parseCursor(raw: string | undefined): { at: Date; id: string } | null {
  if (!raw) return null;
  const [at, id] = raw.split('~');
  const t = at ? Date.parse(at) : NaN;
  return id && UUID.test(id) && !Number.isNaN(t) ? { at: new Date(t), id } : null;
}

/** A page of a group's posts, newest first. Null when the viewer is not an active member. */
export async function listPosts(
  c: PoolClient,
  personId: string,
  groupId: string,
  before?: string,
): Promise<{
  groupName: string;
  posts: PostView[];
  next: string | null;
  canModerate: boolean;
} | null> {
  const access = await groupAccess(c, personId, groupId);
  if (!access || !canReadFeed(access.facts, access.own)) return null;
  const cursor = parseCursor(before);
  const { rows } = await c.query<PostRow>(
    `${postSelect}
      WHERE p.audience = 'GROUP' AND p.group_id = $1
        AND ($2::timestamptz IS NULL OR (p.created_at, p.id) < ($2::timestamptz, $3::uuid))
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT $4`,
    [groupId, cursor?.at ?? null, cursor?.id ?? null, PAGE_SIZE + 1],
  );
  const page = rows.slice(0, PAGE_SIZE);
  const reactions = await reactionsFor(
    c,
    page.map((r) => r.id),
  );
  const last = page.at(-1);
  return {
    groupName: access.name,
    posts: page
      .map((r) => postView(personId, r, reactions))
      .filter((p): p is PostView => p !== null),
    next: rows.length > PAGE_SIZE && last ? cursorOf(last) : null,
    canModerate: canModerate(access.facts, access.own),
  };
}

export interface CommentView {
  id: string;
  author: string;
  mine: boolean;
  text: string | null;
  removed: boolean;
  createdAt: string;
}

async function readablePost(
  c: PoolClient,
  personId: string,
  postId: string,
): Promise<{ row: PostRow; access: NonNullable<Awaited<ReturnType<typeof groupAccess>>> } | null> {
  if (!UUID.test(postId)) return null;
  const row = (
    await c.query<PostRow>(`${postSelect} WHERE p.id = $1 AND p.audience = 'GROUP'`, [postId])
  ).rows[0];
  if (!row) return null;
  const access = await groupAccess(c, personId, row.group_id);
  if (!access || !canReadFeed(access.facts, access.own)) return null;
  return { row, access };
}

/** One post with its comments, oldest first. Null when it does not exist or the viewer may not read it. */
export async function postDetail(
  c: PoolClient,
  personId: string,
  postId: string,
): Promise<{ groupName: string; post: PostView; comments: CommentView[] } | null> {
  const found = await readablePost(c, personId, postId);
  if (!found) return null;
  const post = postView(personId, found.row, await reactionsFor(c, [postId]));
  if (!post) return null;
  const { rows } = await c.query<{
    id: string;
    author_person_id: string;
    body: string;
    status: ContentStatus;
    created_at: Date;
    first_name: string | null;
    last_name: string | null;
    gone: boolean | null;
  }>(
    `SELECT m.id, m.author_person_id, m.body, m.status, m.created_at,
            a.first_name, a.last_name, (a.deleted_at IS NOT NULL) AS gone
       FROM comment m LEFT JOIN person_read a ON a.twenty_person_id = m.author_person_id
      WHERE m.post_id = $1
      ORDER BY m.created_at, m.id`,
    [postId],
  );
  const comments: CommentView[] = [];
  for (const r of rows) {
    const v = visibleText(personId, {
      authorPersonId: r.author_person_id,
      status: r.status,
      body: r.body,
    });
    if (v)
      comments.push({
        id: r.id,
        author: authorName(r),
        mine: r.author_person_id === personId,
        text: v.text,
        removed: v.removed,
        createdAt: r.created_at.toISOString(),
      });
  }
  return { groupName: found.access.name, post, comments };
}

async function recentCount(
  c: PoolClient,
  table: 'post' | 'comment',
  personId: string,
  now: Date,
): Promise<number> {
  const { rows } = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE author_person_id = $1 AND created_at > $2`,
    [personId, new Date(now.getTime() - 3_600_000)],
  );
  return rows[0]?.n ?? 0;
}

export async function createPost(
  c: PoolClient,
  personId: string,
  groupId: string,
  body: unknown,
  now: Date,
): Promise<FeedResult<{ id: string }>> {
  const access = await groupAccess(c, personId, groupId);
  if (!access || !canPost(access.facts, access.own)) return { ok: false, reason: 'NOT_FOUND' };
  const text = cleanText(body, POST_MAX);
  if (!text) return { ok: false, reason: 'INVALID' };
  if ((await recentCount(c, 'post', personId, now)) >= POSTS_PER_HOUR)
    return { ok: false, reason: 'RATE_LIMITED' };
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO post (tenant_id, author_person_id, audience, group_id, body, created_at)
     VALUES (fold_current_tenant(), $1, 'GROUP', $2, $3, $4) RETURNING id`,
    [personId, groupId, text, now],
  );
  return { ok: true, id: (rows[0] as { id: string }).id };
}

export async function createComment(
  c: PoolClient,
  personId: string,
  postId: string,
  body: unknown,
  now: Date,
): Promise<FeedResult<{ id: string }>> {
  const found = await readablePost(c, personId, postId);
  if (!found || !canPost(found.access.facts, found.access.own))
    return { ok: false, reason: 'NOT_FOUND' };
  if (found.row.status !== 'PUBLISHED') return { ok: false, reason: 'NOT_ALLOWED' };
  const text = cleanText(body, COMMENT_MAX);
  if (!text) return { ok: false, reason: 'INVALID' };
  if ((await recentCount(c, 'comment', personId, now)) >= COMMENTS_PER_HOUR)
    return { ok: false, reason: 'RATE_LIMITED' };
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO comment (tenant_id, post_id, author_person_id, body, created_at)
     VALUES (fold_current_tenant(), $1, $2, $3, $4) RETURNING id`,
    [postId, personId, text, now],
  );
  return { ok: true, id: (rows[0] as { id: string }).id };
}

/** Thanks, Praying or Care on someone else's post; `null` takes it back. One per person per post. */
export async function react(
  c: PoolClient,
  personId: string,
  postId: string,
  kind: unknown,
  now: Date,
): Promise<FeedResult> {
  if (kind !== null && !(REACTION_KINDS as readonly unknown[]).includes(kind))
    return { ok: false, reason: 'INVALID' };
  const found = await readablePost(c, personId, postId);
  if (!found) return { ok: false, reason: 'NOT_FOUND' };
  if (found.row.status !== 'PUBLISHED' || found.row.author_person_id === personId)
    return { ok: false, reason: 'NOT_ALLOWED' };
  if (kind === null)
    await c.query(
      `DELETE FROM reaction WHERE subject_type = 'POST' AND subject_id = $1 AND person_id = $2`,
      [postId, personId],
    );
  else
    await c.query(
      `INSERT INTO reaction (tenant_id, subject_type, subject_id, person_id, kind, created_at)
       VALUES (fold_current_tenant(), 'POST', $1, $2, $3, $4)
       ON CONFLICT (tenant_id, subject_type, subject_id, person_id) DO UPDATE SET kind = EXCLUDED.kind`,
      [postId, personId, kind, now],
    );
  return { ok: true };
}

export type Subject = 'POST' | 'COMMENT';
const tableOf = (s: Subject) => (s === 'POST' ? 'post' : 'comment');

/** An author takes down their own post or comment. Allowed even after leaving the group. */
export async function removeOwn(
  c: PoolClient,
  personId: string,
  subject: Subject,
  id: string,
): Promise<FeedResult> {
  if (!UUID.test(id)) return { ok: false, reason: 'NOT_FOUND' };
  const r = await c.query(
    `UPDATE ${tableOf(subject)} SET status = 'REMOVED'
      WHERE id = $1 AND author_person_id = $2 AND status <> 'REMOVED'`,
    [id, personId],
  );
  return (r.rowCount ?? 0) > 0 ? { ok: true } : { ok: false, reason: 'NOT_FOUND' };
}

/** The group a post or comment belongs to, its author and status. */
async function subjectOf(
  c: PoolClient,
  subject: Subject,
  id: string,
): Promise<{ groupId: string; authorPersonId: string; status: ContentStatus } | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await c.query<{
    group_id: string;
    author_person_id: string;
    status: ContentStatus;
  }>(
    subject === 'POST'
      ? `SELECT group_id, author_person_id, status FROM post WHERE id = $1 AND audience = 'GROUP'`
      : `SELECT p.group_id, m.author_person_id, m.status FROM comment m JOIN post p ON p.id = m.post_id
          WHERE m.id = $1 AND p.audience = 'GROUP'`,
    [id],
  );
  const r = rows[0];
  return r ? { groupId: r.group_id, authorPersonId: r.author_person_id, status: r.status } : null;
}

/**
 * A member flags something for the group's leaders, with a short reason. The leaders see the reason and the
 * words, not who reported them (people should not fear reporting); the audit log keeps who did.
 */
export async function reportContent(
  c: PoolClient,
  personId: string,
  subject: Subject,
  id: string,
  reason: unknown,
  now: Date,
): Promise<FeedResult> {
  const s = await subjectOf(c, subject, id);
  if (!s) return { ok: false, reason: 'NOT_FOUND' };
  const access = await groupAccess(c, personId, s.groupId);
  if (!access || !canReadFeed(access.facts, access.own)) return { ok: false, reason: 'NOT_FOUND' };
  if (s.authorPersonId === personId || s.status !== 'PUBLISHED')
    return { ok: false, reason: 'NOT_ALLOWED' };
  const text = cleanText(reason, REASON_MAX);
  if (!text) return { ok: false, reason: 'INVALID' };
  await c.query(
    `INSERT INTO report (tenant_id, reporter_person_id, subject_type, subject_id, reason, created_at)
     VALUES (fold_current_tenant(), $1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, reporter_person_id, subject_type, subject_id) WHERE status = 'OPEN' DO NOTHING`,
    [personId, subject, id, text, now],
  );
  return { ok: true };
}

export interface OpenReport {
  id: string;
  subject: Subject;
  subjectId: string;
  postId: string;
  reason: string;
  author: string;
  text: string;
  createdAt: string;
}

/** Open reports on a group's posts and comments, for its leaders only. Null for anyone else. */
export async function openReports(
  c: PoolClient,
  personId: string,
  groupId: string,
): Promise<OpenReport[] | null> {
  const access = await groupAccess(c, personId, groupId);
  if (!access || !canModerate(access.facts, access.own)) return null;
  const { rows } = await c.query<{
    id: string;
    subject_type: Subject;
    subject_id: string;
    post_id: string;
    reason: string;
    body: string;
    created_at: Date;
    first_name: string | null;
    last_name: string | null;
    gone: boolean | null;
  }>(
    `SELECT r.id, r.subject_type, r.subject_id, coalesce(p.id, cp.id) AS post_id, r.reason, r.created_at,
            coalesce(p.body, m.body) AS body, a.first_name, a.last_name, (a.deleted_at IS NOT NULL) AS gone
       FROM report r
       LEFT JOIN post p ON r.subject_type = 'POST' AND p.id = r.subject_id
       LEFT JOIN comment m ON r.subject_type = 'COMMENT' AND m.id = r.subject_id
       LEFT JOIN post cp ON cp.id = m.post_id
       LEFT JOIN person_read a ON a.twenty_person_id = coalesce(p.author_person_id, m.author_person_id)
      WHERE r.status = 'OPEN' AND coalesce(p.group_id, cp.group_id) = $1
        AND coalesce(p.status, m.status) = 'PUBLISHED'
      ORDER BY r.created_at, r.id`,
    [groupId],
  );
  return rows.map((r) => ({
    id: r.id,
    subject: r.subject_type,
    subjectId: r.subject_id,
    postId: r.post_id,
    reason: r.reason,
    author: authorName(r),
    text: r.body,
    createdAt: r.created_at.toISOString(),
  }));
}

/**
 * A leader acts on a report: REMOVE takes the post or comment down and closes every open report on it;
 * DISMISS closes this report and leaves the content. Both are recorded (moderation_action and audit_log).
 */
export async function moderate(
  c: PoolClient,
  personId: string,
  reportId: string,
  action: unknown,
  now: Date,
): Promise<FeedResult> {
  if (action !== 'REMOVE' && action !== 'DISMISS') return { ok: false, reason: 'INVALID' };
  if (!UUID.test(reportId)) return { ok: false, reason: 'NOT_FOUND' };
  const report = (
    await c.query<{ subject_type: Subject; subject_id: string }>(
      `SELECT subject_type, subject_id FROM report WHERE id = $1 AND status = 'OPEN'`,
      [reportId],
    )
  ).rows[0];
  if (!report) return { ok: false, reason: 'NOT_FOUND' };
  const s = await subjectOf(c, report.subject_type, report.subject_id);
  if (!s) return { ok: false, reason: 'NOT_FOUND' };
  const access = await groupAccess(c, personId, s.groupId);
  if (!access || !canModerate(access.facts, access.own))
    return { ok: false, reason: 'NOT_ALLOWED' };

  if (action === 'REMOVE') {
    await c.query(`UPDATE ${tableOf(report.subject_type)} SET status = 'REMOVED' WHERE id = $1`, [
      report.subject_id,
    ]);
    await c.query(
      `UPDATE report SET status = 'ACTIONED' WHERE subject_type = $1 AND subject_id = $2 AND status = 'OPEN'`,
      [report.subject_type, report.subject_id],
    );
  } else {
    await c.query(`UPDATE report SET status = 'DISMISSED' WHERE id = $1`, [reportId]);
  }
  await c.query(
    `INSERT INTO moderation_action (tenant_id, report_id, moderator_person_id, action, subject_type, subject_id, at)
     VALUES (fold_current_tenant(), $1, $2, $3, $4, $5, $6)`,
    [reportId, personId, action, report.subject_type, report.subject_id, now],
  );
  await writeAudit(c, {
    actorPersonId: personId,
    actorRoles: ['group_leader'],
    action: action === 'REMOVE' ? 'feed.content_removed' : 'feed.report_dismissed',
    subjectType: report.subject_type.toLowerCase(),
    subjectId: report.subject_id,
    meta: { reportId, groupId: s.groupId },
  });
  return { ok: true };
}
