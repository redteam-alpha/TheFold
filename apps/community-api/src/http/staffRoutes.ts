// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { html } from 'hono/html';
import { withTenant } from '../db/tenant.js';
import {
  activeStaffRoles,
  canConfirmSignIns,
  confirmSignIn,
  waitingSignIns,
  type WaitingSignIn,
} from '../portal/confirm.js';
import type { PortalKit } from './portal.js';

const SMALL_BODY = bodyLimit({ maxSize: 8 * 1024 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type StaffGate =
  | { ok: true; tenantId: string; church: string; personId: string }
  | { ok: false; status: 401 | 403 | 404; church: string };

/**
 * The staff queue of sign-ins waiting for a person to confirm who they are (ADR 0007). Only for a confirmed
 * member who holds `admin` or `welcome_lead` (granted with `community-api grant-role`).
 */
export function mountStaffRoutes(app: Hono, k: PortalKit): void {
  const gate = async (c: Context): Promise<StaffGate> => {
    const tenantId = await k.tenantOf(c);
    if (!tenantId) return { ok: false, status: 404, church: '' };
    const church = await k.churchName(tenantId);
    const m = await k.member(c, tenantId);
    if (!m) return { ok: false, status: 401, church };
    const personId = m.person?.id;
    if (!personId) return { ok: false, status: 403, church };
    const roles = await withTenant(k.pool, tenantId, (x) => activeStaffRoles(x, personId));
    if (!canConfirmSignIns(roles)) return { ok: false, status: 403, church };
    return { ok: true, tenantId, church, personId };
  };

  const confirm = (g: Extract<StaffGate, { ok: true }>, accountId: string, personId: unknown) =>
    typeof personId === 'string' && UUID.test(personId) && UUID.test(accountId)
      ? withTenant(k.pool, g.tenantId, (x) =>
          confirmSignIn(x, { staffPersonId: g.personId, accountId, personId, now: k.now() }),
        )
      : Promise.resolve({ ok: false as const, reason: 'NOT_FOUND' as const });

  app.get('/v1/staff/sign-ins', async (c) => {
    const g = await gate(c);
    if (!g.ok) return c.json({ error: 'not allowed' }, g.status);
    c.header('Cache-Control', 'no-store');
    return c.json({ waiting: await withTenant(k.pool, g.tenantId, (x) => waitingSignIns(x)) });
  });

  app.post('/v1/staff/sign-ins/:accountId', SMALL_BODY, async (c) => {
    const g = await gate(c);
    if (!g.ok) return c.json({ error: 'not allowed' }, g.status);
    if (!k.sameOrigin(c)) return c.json({ error: 'cross-site request refused' }, 403);
    const body = (await c.req.json().catch(() => null)) as { personId?: unknown } | null;
    const r = await confirm(g, c.req.param('accountId'), body?.personId);
    return c.json(r, r.ok ? 200 : r.reason === 'ALREADY_LINKED' ? 409 : 404);
  });

  const entry = (w: WaitingSignIn) =>
    html`<li>
      <strong>${w.email}</strong>
      ${
        w.candidates.length === 0
          ? html`<p class="small">
              No adult in the church's records uses this address. Add it to the right person in
              Twenty first; it will show here after the next sync.
            </p>`
          : html`<form method="post" action="/staff/sign-ins/${w.accountId}">
              <p class="small">Which person is this?</p>
              ${w.candidates.map(
                (p, i) =>
                  html`<label class="choice"
                    ><input
                      type="radio"
                      name="personId"
                      value="${p.personId}"
                      ${i === 0 ? 'checked' : ''}
                    />
                    ${p.firstName} ${p.lastName}</label
                  >`,
              )}
              <button type="submit">Confirm</button>
            </form>`
      }
    </li>`;

  app.get('/staff/sign-ins', async (c) => {
    const g = await gate(c);
    if (!g.ok)
      return g.status === 401
        ? c.redirect('/sign-in', 303)
        : c.json({ error: 'not allowed' }, g.status);
    const waiting = await withTenant(k.pool, g.tenantId, (x) => waitingSignIns(x));
    return k.page(
      c,
      g.church,
      'Confirm sign-ins',
      html`<h1>Confirm sign-ins</h1>
        <p class="small">
          These people signed in with an address the church's records share between several adults,
          or have no single match for. Confirm only someone you know.
        </p>
        ${
          waiting.length === 0
            ? html`<p>No one is waiting.</p>`
            : html`<ul class="list">
                ${waiting.map(entry)}
              </ul>`
        }
        <p><a href="/">Back</a></p>`,
    );
  });

  app.post('/staff/sign-ins/:accountId', SMALL_BODY, async (c) => {
    const g = await gate(c);
    if (!g.ok)
      return g.status === 401
        ? c.redirect('/sign-in', 303)
        : c.json({ error: 'not allowed' }, g.status);
    if (!k.sameOrigin(c)) return c.json({ error: 'cross-site request refused' }, 403);
    const form = await c.req.parseBody();
    const r = await confirm(g, c.req.param('accountId'), form['personId']);
    if (r.ok) return c.redirect('/staff/sign-ins', 303);
    return k.page(
      c,
      g.church,
      'Confirm sign-ins',
      html`<h1>That didn't work</h1>
        <p>
          ${
            r.reason === 'ALREADY_LINKED'
              ? 'Someone has already confirmed this sign-in.'
              : 'That person is not one of the choices for this address.'
          }
        </p>
        <p><a href="/staff/sign-ins">Back to the list</a></p>`,
      r.reason === 'ALREADY_LINKED' ? 409 : 404,
    );
  });
}
