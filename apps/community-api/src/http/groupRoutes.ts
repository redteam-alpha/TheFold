// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { html } from 'hono/html';
import { withTenant } from '../db/tenant.js';
import {
  decideRequest,
  groupDetail,
  leaveGroup,
  listGroups,
  requestToJoin,
  type GroupAction,
  type GroupDetail,
  type GroupView,
} from '../portal/groups.js';
import type { Member } from '../portal/signIn.js';
import type { PortalKit } from './portal.js';

const SMALL_BODY = bodyLimit({ maxSize: 8 * 1024 });

type Gate =
  | { ok: true; tenantId: string; church: string; personId: string; member: Member }
  | { ok: false; reason: 'UNKNOWN_CHURCH' | 'SIGNED_OUT' | 'UNCONFIRMED'; church: string };

const STATUS_TEXT: Record<string, string> = {
  INTERESTED: 'Invited',
  REQUESTED: 'You asked to join',
  ACTIVE: "You're a member",
  PAUSED: 'Membership paused',
  LEFT: '',
};

/**
 * Groups for signed-in members (ADR 0008). Only VERIFIED members get past the gate: an account the church has
 * not yet confirmed sees nothing about anyone. Every write is a form post or JSON request from this host.
 */
export function mountGroupRoutes(app: Hono, k: PortalKit): void {
  const gate = async (c: Context): Promise<Gate> => {
    const tenantId = await k.tenantOf(c);
    if (!tenantId) return { ok: false, reason: 'UNKNOWN_CHURCH', church: '' };
    const church = await k.churchName(tenantId);
    const member = await k.member(c, tenantId);
    if (!member) return { ok: false, reason: 'SIGNED_OUT', church };
    if (!member.person) return { ok: false, reason: 'UNCONFIRMED', church };
    return { ok: true, tenantId, church, personId: member.person.id, member };
  };

  const inTenant = <T>(tenantId: string, fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(k.pool, tenantId, fn);

  const jsonRefusal = (c: Context, g: Exclude<Gate, { ok: true }>) =>
    g.reason === 'UNKNOWN_CHURCH'
      ? c.json({ error: 'unknown church' }, 404)
      : g.reason === 'SIGNED_OUT'
        ? c.json({ error: 'not signed in' }, 401)
        : c.json({ error: 'your church has not confirmed your account yet' }, 403);

  const pageRefusal = (c: Context, g: Exclude<Gate, { ok: true }>) => {
    if (g.reason === 'UNKNOWN_CHURCH') return c.json({ error: 'unknown church' }, 404);
    if (g.reason === 'SIGNED_OUT') return c.redirect('/sign-in', 303);
    return k.page(
      c,
      g.church,
      'Groups',
      html`<h1>Groups</h1>
        <p>
          Before you can see groups, someone at ${g.church} needs to confirm which person in the
          church's records you are. Please ask at the welcome desk.
        </p>
        <p><a href="/">Back</a></p>`,
      403,
    );
  };

  const actionStatus = (r: GroupAction) =>
    r.ok ? 202 : r.reason === 'NOT_FOUND' ? 404 : (409 as const);

  // ---- JSON ----------------------------------------------------------------------------------------------

  app.get('/v1/groups', async (c) => {
    const g = await gate(c);
    if (!g.ok) return jsonRefusal(c, g);
    c.header('Cache-Control', 'no-store');
    return c.json({ groups: await inTenant(g.tenantId, (x) => listGroups(x, g.personId)) });
  });

  app.get('/v1/groups/:id', async (c) => {
    const g = await gate(c);
    if (!g.ok) return jsonRefusal(c, g);
    c.header('Cache-Control', 'no-store');
    const detail = await inTenant(g.tenantId, (x) => groupDetail(x, g.personId, c.req.param('id')));
    return detail ? c.json(detail) : c.json({ error: 'not found' }, 404);
  });

  app.post('/v1/groups/:id/join', SMALL_BODY, async (c) => {
    const g = await gate(c);
    if (!g.ok) return jsonRefusal(c, g);
    if (!k.sameOrigin(c)) return c.json({ error: 'cross-site request refused' }, 403);
    const r = await inTenant(g.tenantId, (x) =>
      requestToJoin(x, g.personId, c.req.param('id'), k.now()),
    );
    return c.json(r, actionStatus(r));
  });

  app.post('/v1/groups/:id/leave', SMALL_BODY, async (c) => {
    const g = await gate(c);
    if (!g.ok) return jsonRefusal(c, g);
    if (!k.sameOrigin(c)) return c.json({ error: 'cross-site request refused' }, 403);
    const r = await inTenant(g.tenantId, (x) =>
      leaveGroup(x, g.personId, c.req.param('id'), k.now()),
    );
    return c.json(r, actionStatus(r));
  });

  app.post('/v1/groups/:id/requests/:personId', SMALL_BODY, async (c) => {
    const g = await gate(c);
    if (!g.ok) return jsonRefusal(c, g);
    if (!k.sameOrigin(c)) return c.json({ error: 'cross-site request refused' }, 403);
    const body = (await c.req.json().catch(() => null)) as { approve?: unknown } | null;
    if (typeof body?.approve !== 'boolean')
      return c.json({ error: 'expected {"approve": true|false}' }, 400);
    const approve = body.approve;
    const r = await inTenant(g.tenantId, (x) =>
      decideRequest(x, g.personId, c.req.param('id'), c.req.param('personId'), approve, k.now()),
    );
    return c.json(r, r.ok ? 202 : r.reason === 'NOT_FOUND' ? 404 : 403);
  });

  // ---- Pages ---------------------------------------------------------------------------------------------

  const groupLine = (v: GroupView) =>
    html`<li>
      <a href="/groups/${v.id}">${v.name}</a>
      ${v.myStatus && STATUS_TEXT[v.myStatus] ? html` <span class="small">· ${STATUS_TEXT[v.myStatus]}</span>` : ''}
      ${v.schedule ? html`<br /><span class="small">${v.schedule}</span>` : ''}
    </li>`;

  app.get('/groups', async (c) => {
    const g = await gate(c);
    if (!g.ok) return pageRefusal(c, g);
    const groups = await inTenant(g.tenantId, (x) => listGroups(x, g.personId));
    const mine = groups.filter((v) => v.myStatus === 'ACTIVE' || v.myStatus === 'PAUSED');
    const others = groups.filter((v) => !mine.includes(v));
    return k.page(
      c,
      g.church,
      'Groups',
      html`<h1>Groups</h1>
        ${
          mine.length > 0
            ? html`<h2>Yours</h2>
                <ul class="list">
                  ${mine.map(groupLine)}
                </ul>`
            : ''
        }
        <h2>${mine.length > 0 ? 'Others' : 'Find a group'}</h2>
        ${
          others.length > 0
            ? html`<ul class="list">
                ${others.map(groupLine)}
              </ul>`
            : html`<p>No other groups to show yet.</p>`
        }
        <p><a href="/">Back</a></p>`,
    );
  });

  const detailPage = (d: GroupDetail) =>
    html`<h1>${d.name}</h1>
      ${d.pausedUntil ? html`<p class="note">Paused until ${d.pausedUntil}.</p>` : ''}
      ${d.schedule ? html`<p>${d.schedule}</p>` : ''}
      ${d.description ? html`<p>${d.description}</p>` : ''}
      ${d.childFriendly ? html`<p class="small">Children welcome.</p>` : ''}
      ${d.leaders.length > 0 ? html`<p class="small">Led by ${d.leaders.join(', ')}.</p>` : ''}
      ${d.myStatus && STATUS_TEXT[d.myStatus] ? html`<p><strong>${STATUS_TEXT[d.myStatus]}.</strong></p>` : ''}
      ${
        d.canRequestToJoin
          ? html`<form method="post" action="/groups/${d.id}/join">
              <button type="submit">Ask to join</button>
              <p class="small">A leader of the group will answer your request.</p>
            </form>`
          : ''
      }
      ${
        d.members
          ? html`<h2>Members</h2>
              <ul class="list">
                ${d.members.map((m) => html`<li>${m.name}${m.leads ? html` <span class="small">(leads)</span>` : ''}</li>`)}
              </ul>`
          : ''
      }
      ${
        d.requests
          ? html`<h2>Asking to join</h2>
              ${
                d.requests.length === 0
                  ? html`<p class="small">No one is waiting.</p>`
                  : html`<ul class="list">
                      ${d.requests.map(
                        (r) =>
                          html`<li>
                            ${r.name}
                            <form
                              method="post"
                              action="/groups/${d.id}/requests/${r.personId}"
                              class="inline"
                            >
                              <button type="submit" name="decision" value="approve">Welcome</button>
                              <button
                                type="submit"
                                name="decision"
                                value="decline"
                                class="secondary"
                              >
                                Not now
                              </button>
                            </form>
                          </li>`,
                      )}
                    </ul>`
              }`
          : ''
      }
      ${
        d.canLeave
          ? html`<form method="post" action="/groups/${d.id}/leave">
              <button type="submit" class="secondary">
                ${d.myStatus === 'REQUESTED' ? 'Withdraw my request' : d.myStatus === 'INTERESTED' ? 'No thanks' : 'Leave this group'}
              </button>
            </form>`
          : ''
      }
      <p><a href="/groups">All groups</a></p>`;

  app.get('/groups/:id', async (c) => {
    const g = await gate(c);
    if (!g.ok) return pageRefusal(c, g);
    const d = await inTenant(g.tenantId, (x) => groupDetail(x, g.personId, c.req.param('id')));
    if (!d)
      return k.page(
        c,
        g.church,
        'Groups',
        html`<h1>Not found</h1>
          <p><a href="/groups">All groups</a></p>`,
        404,
      );
    return k.page(c, g.church, d.name, detailPage(d));
  });

  const afterAction = async (
    c: Context,
    g: Extract<Gate, { ok: true }>,
    r: GroupAction,
    id: string,
  ) => {
    if (r.ok) return c.redirect(`/groups/${id}`, 303);
    return k.page(
      c,
      g.church,
      'Groups',
      html`<h1>That didn't work</h1>
        <p>It may already be done, or no longer possible.</p>
        <p><a href="/groups/${id}">Back to the group</a></p>`,
      r.reason === 'NOT_FOUND' ? 404 : 409,
    );
  };

  app.post('/groups/:id/join', SMALL_BODY, async (c) => {
    const g = await gate(c);
    if (!g.ok) return pageRefusal(c, g);
    if (!k.sameOrigin(c))
      return afterAction(c, g, { ok: false, reason: 'NOT_ALLOWED' }, c.req.param('id'));
    const id = c.req.param('id');
    return afterAction(
      c,
      g,
      await inTenant(g.tenantId, (x) => requestToJoin(x, g.personId, id, k.now())),
      id,
    );
  });

  app.post('/groups/:id/leave', SMALL_BODY, async (c) => {
    const g = await gate(c);
    if (!g.ok) return pageRefusal(c, g);
    if (!k.sameOrigin(c))
      return afterAction(c, g, { ok: false, reason: 'NOT_ALLOWED' }, c.req.param('id'));
    const id = c.req.param('id');
    return afterAction(
      c,
      g,
      await inTenant(g.tenantId, (x) => leaveGroup(x, g.personId, id, k.now())),
      id,
    );
  });

  app.post('/groups/:id/requests/:personId', SMALL_BODY, async (c) => {
    const g = await gate(c);
    if (!g.ok) return pageRefusal(c, g);
    const id = c.req.param('id');
    if (!k.sameOrigin(c)) return afterAction(c, g, { ok: false, reason: 'NOT_ALLOWED' }, id);
    const form = await c.req.parseBody();
    const decision = form['decision'];
    if (decision !== 'approve' && decision !== 'decline')
      return afterAction(c, g, { ok: false, reason: 'NOT_ALLOWED' }, id);
    const r = await inTenant(g.tenantId, (x) =>
      decideRequest(x, g.personId, id, c.req.param('personId'), decision === 'approve', k.now()),
    );
    return afterAction(c, g, r, id);
  });
}
