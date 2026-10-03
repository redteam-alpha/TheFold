// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context } from 'hono';
import { html } from 'hono/html';
import { withTenant } from '../db/tenant.js';
import type { Member } from '../portal/signIn.js';
import type { PortalKit } from './portal.js';

export type Gate =
  | { ok: true; tenantId: string; church: string; personId: string; member: Member }
  | { ok: false; reason: 'UNKNOWN_CHURCH' | 'SIGNED_OUT' | 'UNCONFIRMED'; church: string };

/**
 * The door to everything member-only (groups, posts): a signed-in account the church has linked to an adult
 * (`VERIFIED`). An account not yet confirmed sees nothing about anyone.
 */
export function memberGate(k: PortalKit) {
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
      'Not yet',
      html`<h1>Not yet</h1>
        <p>
          Before you can see groups, someone at ${g.church} needs to confirm which person in the
          church's records you are. Please ask at the welcome desk.
        </p>
        <p><a href="/">Back</a></p>`,
      403,
    );
  };

  return { gate, inTenant, jsonRefusal, pageRefusal };
}
