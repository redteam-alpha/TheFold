// SPDX-License-Identifier: AGPL-3.0-or-later
import { REACTION_KINDS, type ReactionKind, type ReactionSummary } from '@thefold/core';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { html } from 'hono/html';
import {
  createComment,
  createPost,
  listPosts,
  moderate,
  openReports,
  postDetail,
  react,
  removeOwn,
  reportContent,
  type CommentView,
  type FeedResult,
  type OpenReport,
  type PostView,
  type Subject,
} from '../portal/feed.js';
import { memberGate, type Gate } from './memberGate.js';
import type { PortalKit } from './portal.js';

const BODY = bodyLimit({ maxSize: 24 * 1024 });

const REACTION_LABEL: Record<ReactionKind, string> = {
  THANKS: 'Thanks',
  PRAYED: 'Praying',
  CARE: 'Care',
};
const KINDNESS =
  'Write as you would speak to someone at the table: kindly, and only what you would be glad for the whole group to read.';

const statusOf = (r: FeedResult) =>
  r.ok
    ? 200
    : r.reason === 'NOT_FOUND'
      ? 404
      : r.reason === 'INVALID'
        ? 400
        : r.reason === 'RATE_LIMITED'
          ? 429
          : 409;

/** Only our own pages are redirect targets: a post, a group's posts, or its reports. */
const LOCAL_BACK = /^\/(?:posts\/[0-9a-f-]{36}|groups\/[0-9a-f-]{36}\/(?:posts|reports))$/i;
const safeBack = (v: unknown, fallback: string) =>
  typeof v === 'string' && LOCAL_BACK.test(v) ? v : fallback;

/**
 * A group's posts for its active members (ADR 0009): JSON for the portal app and plain pages for now. Every
 * write is a form post or JSON request from this host; all text is escaped when shown.
 */
export function mountFeedRoutes(app: Hono, k: PortalKit): void {
  const { gate, inTenant, jsonRefusal, pageRefusal } = memberGate(k);

  const refuseCrossSite = (c: Context) =>
    k.sameOrigin(c) ? null : c.json({ error: 'cross-site request refused' }, 403);

  // ---- JSON ----------------------------------------------------------------------------------------------

  app.get('/v1/groups/:id/posts', async (c) => {
    const g = await gate(c);
    if (!g.ok) return jsonRefusal(c, g);
    c.header('Cache-Control', 'no-store');
    const page = await inTenant(g.tenantId, (x) =>
      listPosts(x, g.personId, c.req.param('id'), c.req.query('before')),
    );
    return page ? c.json(page) : c.json({ error: 'not found' }, 404);
  });

  app.post('/v1/groups/:id/posts', BODY, async (c) => {
    const g = await gate(c);
    if (!g.ok) return jsonRefusal(c, g);
    const refused = refuseCrossSite(c);
    if (refused) return refused;
    const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
    const r = await inTenant(g.tenantId, (x) =>
      createPost(x, g.personId, c.req.param('id'), body?.text, k.now()),
    );
    return c.json(r, r.ok ? 201 : statusOf(r));
  });

  app.get('/v1/posts/:id', async (c) => {
    const g = await gate(c);
    if (!g.ok) return jsonRefusal(c, g);
    c.header('Cache-Control', 'no-store');
    const d = await inTenant(g.tenantId, (x) => postDetail(x, g.personId, c.req.param('id')));
    return d ? c.json(d) : c.json({ error: 'not found' }, 404);
  });

  app.post('/v1/posts/:id/comments', BODY, async (c) => {
    const g = await gate(c);
    if (!g.ok) return jsonRefusal(c, g);
    const refused = refuseCrossSite(c);
    if (refused) return refused;
    const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
    const r = await inTenant(g.tenantId, (x) =>
      createComment(x, g.personId, c.req.param('id'), body?.text, k.now()),
    );
    return c.json(r, r.ok ? 201 : statusOf(r));
  });

  app.put('/v1/posts/:id/reaction', BODY, async (c) => {
    const g = await gate(c);
    if (!g.ok) return jsonRefusal(c, g);
    const refused = refuseCrossSite(c);
    if (refused) return refused;
    const body = (await c.req.json().catch(() => null)) as { kind?: unknown } | null;
    const r = await inTenant(g.tenantId, (x) =>
      react(x, g.personId, c.req.param('id'), body?.kind ?? '', k.now()),
    );
    return c.json(r, statusOf(r));
  });

  app.delete('/v1/posts/:id/reaction', async (c) => {
    const g = await gate(c);
    if (!g.ok) return jsonRefusal(c, g);
    const refused = refuseCrossSite(c);
    if (refused) return refused;
    const r = await inTenant(g.tenantId, (x) =>
      react(x, g.personId, c.req.param('id'), null, k.now()),
    );
    return c.json(r, statusOf(r));
  });

  for (const [path, subject] of [
    ['/v1/posts/:id/remove', 'POST'],
    ['/v1/comments/:id/remove', 'COMMENT'],
  ] as const)
    app.post(path, async (c) => {
      const g = await gate(c);
      if (!g.ok) return jsonRefusal(c, g);
      const refused = refuseCrossSite(c);
      if (refused) return refused;
      const r = await inTenant(g.tenantId, (x) =>
        removeOwn(x, g.personId, subject, c.req.param('id')),
      );
      return c.json(r, statusOf(r));
    });

  app.post('/v1/reports', BODY, async (c) => {
    const g = await gate(c);
    if (!g.ok) return jsonRefusal(c, g);
    const refused = refuseCrossSite(c);
    if (refused) return refused;
    const body = (await c.req.json().catch(() => null)) as {
      subject?: unknown;
      id?: unknown;
      reason?: unknown;
    } | null;
    if ((body?.subject !== 'POST' && body?.subject !== 'COMMENT') || typeof body.id !== 'string')
      return c.json({ ok: false, reason: 'INVALID' }, 400);
    const { subject, id, reason } = body;
    const r = await inTenant(g.tenantId, (x) =>
      reportContent(x, g.personId, subject, id, reason, k.now()),
    );
    return c.json(r, r.ok ? 201 : statusOf(r));
  });

  app.get('/v1/groups/:id/reports', async (c) => {
    const g = await gate(c);
    if (!g.ok) return jsonRefusal(c, g);
    c.header('Cache-Control', 'no-store');
    const reports = await inTenant(g.tenantId, (x) =>
      openReports(x, g.personId, c.req.param('id')),
    );
    return reports ? c.json({ reports }) : c.json({ error: 'not found' }, 404);
  });

  app.post('/v1/reports/:id', BODY, async (c) => {
    const g = await gate(c);
    if (!g.ok) return jsonRefusal(c, g);
    const refused = refuseCrossSite(c);
    if (refused) return refused;
    const body = (await c.req.json().catch(() => null)) as { action?: unknown } | null;
    const r = await inTenant(g.tenantId, (x) =>
      moderate(x, g.personId, c.req.param('id'), body?.action, k.now()),
    );
    return c.json(r, r.ok ? 200 : r.reason === 'NOT_ALLOWED' ? 403 : statusOf(r));
  });

  // ---- Pages ---------------------------------------------------------------------------------------------

  const timeZone = (tenantId: string) =>
    inTenant(tenantId, async (x) => {
      const r = await x.query<{ timezone: string }>('SELECT timezone FROM tenant');
      return r.rows[0]?.timezone ?? 'UTC';
    });
  const when = (iso: string, tz: string) =>
    new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(
      new Date(iso),
    );

  const reactionLine = (r: ReactionSummary) => {
    if (!r.counts) return '';
    const parts = REACTION_KINDS.filter((kind) => (r.counts?.[kind] ?? 0) > 0).map(
      (kind) => `${r.counts?.[kind]} ${REACTION_LABEL[kind]}`,
    );
    return html`<p class="small">
      ${parts.length > 0 ? `Only you see this: ${parts.join(', ')}.` : 'No responses yet.'}
    </p>`;
  };

  const postBlock = (p: PostView, tz: string, link: boolean) =>
    html`<article class="post">
      <p class="small">${p.author} · ${when(p.createdAt, tz)}</p>
      ${
        p.removed
          ? html`<p class="note">
              ${p.text === null ? 'This post was removed.' : 'You removed this post, or a leader did.'}
            </p>`
          : ''
      }
      ${p.text !== null ? html`<p class="text">${p.text}</p>` : ''}
      ${link && !p.removed ? html`<p><a href="/posts/${p.id}">Open and reply</a></p>` : ''}
    </article>`;

  const failure = (c: Context, g: Extract<Gate, { ok: true }>, r: FeedResult, back: string) => {
    const message = r.ok
      ? ''
      : r.reason === 'INVALID'
        ? 'Please write something (and not too much).'
        : r.reason === 'RATE_LIMITED'
          ? "You've posted a lot in the last hour. Please give it a little while."
          : r.reason === 'NOT_ALLOWED'
            ? "That isn't possible here."
            : "That couldn't be found.";
    return k.page(
      c,
      g.church,
      'Posts',
      html`<h1>That didn't work</h1>
        <p>${message}</p>
        <p><a href="${back}">Back</a></p>`,
      statusOf(r) === 200 ? 400 : statusOf(r),
    );
  };

  app.get('/groups/:id/posts', async (c) => {
    const g = await gate(c);
    if (!g.ok) return pageRefusal(c, g);
    const groupId = c.req.param('id');
    const page = await inTenant(g.tenantId, (x) =>
      listPosts(x, g.personId, groupId, c.req.query('before')),
    );
    if (!page)
      return k.page(
        c,
        g.church,
        'Posts',
        html`<h1>Not found</h1>
          <p><a href="/groups">All groups</a></p>`,
        404,
      );
    const tz = await timeZone(g.tenantId);
    return k.page(
      c,
      g.church,
      page.groupName,
      html`<h1>${page.groupName}</h1>
        <form method="post" action="/groups/${groupId}/posts">
          <label for="text">Share with the group</label>
          <textarea id="text" name="text" rows="4" maxlength="5000" required></textarea>
          <p class="small">${KINDNESS}</p>
          <button type="submit">Post</button>
        </form>
        ${page.posts.length === 0 ? html`<p>No posts yet.</p>` : page.posts.map((p) => postBlock(p, tz, true))}
        ${
          page.next
            ? html`<p>
                <a href="/groups/${groupId}/posts?before=${encodeURIComponent(page.next)}"
                  >Older posts</a
                >
              </p>`
            : ''
        }
        <p>
          <a href="/groups/${groupId}">About the group</a>
          ${page.canModerate ? html` · <a href="/groups/${groupId}/reports">Reports</a>` : ''}
        </p>`,
    );
  });

  app.post('/groups/:id/posts', BODY, async (c) => {
    const g = await gate(c);
    if (!g.ok) return pageRefusal(c, g);
    const groupId = c.req.param('id');
    const back = `/groups/${groupId}/posts`;
    if (!k.sameOrigin(c)) return failure(c, g, { ok: false, reason: 'NOT_ALLOWED' }, back);
    const form = await c.req.parseBody();
    const r = await inTenant(g.tenantId, (x) =>
      createPost(x, g.personId, groupId, form['text'], k.now()),
    );
    return r.ok ? c.redirect(back, 303) : failure(c, g, r, back);
  });

  const commentBlock = (m: CommentView, tz: string, postId: string) =>
    html`<li>
      <p class="small">${m.author} · ${when(m.createdAt, tz)}</p>
      ${m.removed ? html`<p class="note">${m.text === null ? 'This reply was removed.' : 'This reply was removed.'}</p>` : ''}
      ${m.text !== null ? html`<p class="text">${m.text}</p>` : ''}
      ${
        !m.removed && m.mine
          ? html`<form method="post" action="/comments/${m.id}/remove" class="inline">
              <input type="hidden" name="back" value="/posts/${postId}" />
              <button type="submit" class="secondary">Remove</button>
            </form>`
          : ''
      }
      ${!m.removed && !m.mine ? reportForm('COMMENT', m.id, `/posts/${postId}`) : ''}
    </li>`;

  const reportForm = (subject: Subject, id: string, back: string) =>
    html`<details class="report">
      <summary>Report</summary>
      <form method="post" action="/reports">
        <input type="hidden" name="subject" value="${subject}" />
        <input type="hidden" name="id" value="${id}" />
        <input type="hidden" name="back" value="${back}" />
        <label for="reason-${id}"
          >What is wrong? The group's leaders will see this, not your name.</label
        >
        <input id="reason-${id}" name="reason" maxlength="1000" required />
        <button type="submit" class="secondary">Send to the leaders</button>
      </form>
    </details>`;

  app.get('/posts/:id', async (c) => {
    const g = await gate(c);
    if (!g.ok) return pageRefusal(c, g);
    const postId = c.req.param('id');
    const d = await inTenant(g.tenantId, (x) => postDetail(x, g.personId, postId));
    if (!d)
      return k.page(
        c,
        g.church,
        'Posts',
        html`<h1>Not found</h1>
          <p><a href="/groups">All groups</a></p>`,
        404,
      );
    const tz = await timeZone(g.tenantId);
    const p = d.post;
    return k.page(
      c,
      g.church,
      d.groupName,
      html`<p class="small"><a href="/groups/${p.groupId}/posts">${d.groupName}</a></p>
        ${postBlock(p, tz, false)}
        ${
          !p.removed && !p.mine
            ? html`<form method="post" action="/posts/${p.id}/reaction" class="reactions">
                ${REACTION_KINDS.map(
                  (kind) =>
                    html`<button
                      type="submit"
                      name="kind"
                      value="${kind}"
                      class="${p.reactions.mine === kind ? '' : 'secondary'}"
                      aria-pressed="${p.reactions.mine === kind ? 'true' : 'false'}"
                    >
                      ${REACTION_LABEL[kind]}
                    </button>`,
                )}
                ${p.reactions.mine ? html`<button type="submit" name="kind" value="none" class="secondary">Take back</button>` : ''}
              </form>`
            : ''
        }
        ${reactionLine(p.reactions)}
        ${
          !p.removed && p.mine
            ? html`<form method="post" action="/posts/${p.id}/remove">
                <button type="submit" class="secondary">Remove my post</button>
              </form>`
            : ''
        }
        ${!p.removed && !p.mine ? reportForm('POST', p.id, `/posts/${p.id}`) : ''}
        <h2>Replies</h2>
        ${
          d.comments.length === 0
            ? html`<p class="small">No replies yet.</p>`
            : html`<ul class="list">
                ${d.comments.map((m) => commentBlock(m, tz, p.id))}
              </ul>`
        }
        ${
          !p.removed
            ? html`<form method="post" action="/posts/${p.id}/comments">
                <label for="reply">Reply</label>
                <textarea id="reply" name="text" rows="3" maxlength="2000" required></textarea>
                <button type="submit">Reply</button>
              </form>`
            : ''
        }`,
    );
  });

  app.post('/posts/:id/comments', BODY, async (c) => {
    const g = await gate(c);
    if (!g.ok) return pageRefusal(c, g);
    const back = safeBack(`/posts/${c.req.param('id')}`, '/groups');
    if (!k.sameOrigin(c)) return failure(c, g, { ok: false, reason: 'NOT_ALLOWED' }, back);
    const form = await c.req.parseBody();
    const r = await inTenant(g.tenantId, (x) =>
      createComment(x, g.personId, c.req.param('id'), form['text'], k.now()),
    );
    return r.ok ? c.redirect(back, 303) : failure(c, g, r, back);
  });

  app.post('/posts/:id/reaction', BODY, async (c) => {
    const g = await gate(c);
    if (!g.ok) return pageRefusal(c, g);
    const back = safeBack(`/posts/${c.req.param('id')}`, '/groups');
    if (!k.sameOrigin(c)) return failure(c, g, { ok: false, reason: 'NOT_ALLOWED' }, back);
    const form = await c.req.parseBody();
    const kind = form['kind'] === 'none' ? null : form['kind'];
    const r = await inTenant(g.tenantId, (x) =>
      react(x, g.personId, c.req.param('id'), kind ?? '', k.now()),
    );
    return r.ok ? c.redirect(back, 303) : failure(c, g, r, back);
  });

  for (const [path, subject] of [
    ['/posts/:id/remove', 'POST'],
    ['/comments/:id/remove', 'COMMENT'],
  ] as const)
    app.post(path, BODY, async (c) => {
      const g = await gate(c);
      if (!g.ok) return pageRefusal(c, g);
      const form = await c.req.parseBody();
      const back = safeBack(
        form['back'],
        subject === 'POST' ? `/posts/${c.req.param('id')}` : '/groups',
      );
      if (!k.sameOrigin(c)) return failure(c, g, { ok: false, reason: 'NOT_ALLOWED' }, back);
      const r = await inTenant(g.tenantId, (x) =>
        removeOwn(x, g.personId, subject, c.req.param('id')),
      );
      return r.ok ? c.redirect(back, 303) : failure(c, g, r, back);
    });

  app.post('/reports', BODY, async (c) => {
    const g = await gate(c);
    if (!g.ok) return pageRefusal(c, g);
    const form = await c.req.parseBody();
    const back = safeBack(form['back'], '/groups');
    if (!k.sameOrigin(c)) return failure(c, g, { ok: false, reason: 'NOT_ALLOWED' }, back);
    const subject = form['subject'];
    const id = form['id'];
    if ((subject !== 'POST' && subject !== 'COMMENT') || typeof id !== 'string')
      return failure(c, g, { ok: false, reason: 'INVALID' }, back);
    const r = await inTenant(g.tenantId, (x) =>
      reportContent(x, g.personId, subject, id, form['reason'], k.now()),
    );
    if (!r.ok) return failure(c, g, r, back);
    return k.page(
      c,
      g.church,
      'Reported',
      html`<h1>Thank you</h1>
        <p>The group's leaders will look at it. They see your reason, not your name.</p>
        <p><a href="${back}">Back</a></p>`,
    );
  });

  const reportItem = (r: OpenReport, groupId: string, tz: string) =>
    html`<li>
      <p class="small">
        ${r.subject === 'POST' ? 'A post' : 'A reply'} by ${r.author} · reported
        ${when(r.createdAt, tz)}
      </p>
      <p class="text">${r.text}</p>
      <p><strong>Reason:</strong> ${r.reason}</p>
      <p class="small"><a href="/posts/${r.postId}">See it in context</a></p>
      <form method="post" action="/reports/${r.id}" class="inline">
        <input type="hidden" name="group" value="${groupId}" />
        <button type="submit" name="action" value="REMOVE">Remove it</button>
        <button type="submit" name="action" value="DISMISS" class="secondary">Keep it</button>
      </form>
    </li>`;

  app.get('/groups/:id/reports', async (c) => {
    const g = await gate(c);
    if (!g.ok) return pageRefusal(c, g);
    const groupId = c.req.param('id');
    const reports = await inTenant(g.tenantId, (x) => openReports(x, g.personId, groupId));
    if (!reports)
      return k.page(
        c,
        g.church,
        'Reports',
        html`<h1>Not found</h1>
          <p><a href="/groups">All groups</a></p>`,
        404,
      );
    const tz = await timeZone(g.tenantId);
    return k.page(
      c,
      g.church,
      'Reports',
      html`<h1>Reports</h1>
        <p class="small">
          Things members of your group asked you to look at. Remove what breaks the group's trust;
          keep what is only a disagreement.
        </p>
        ${
          reports.length === 0
            ? html`<p>Nothing to look at.</p>`
            : html`<ul class="list">
                ${reports.map((r) => reportItem(r, groupId, tz))}
              </ul>`
        }
        <p><a href="/groups/${groupId}/posts">Back to the posts</a></p>`,
    );
  });

  app.post('/reports/:id', BODY, async (c) => {
    const g = await gate(c);
    if (!g.ok) return pageRefusal(c, g);
    const form = await c.req.parseBody();
    const group = form['group'];
    const back = safeBack(typeof group === 'string' ? `/groups/${group}/reports` : '', '/groups');
    if (!k.sameOrigin(c)) return failure(c, g, { ok: false, reason: 'NOT_ALLOWED' }, back);
    const r = await inTenant(g.tenantId, (x) =>
      moderate(x, g.personId, c.req.param('id'), form['action'], k.now()),
    );
    return r.ok ? c.redirect(back, 303) : failure(c, g, r, back);
  });
}
