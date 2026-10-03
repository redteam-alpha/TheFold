// SPDX-License-Identifier: AGPL-3.0-or-later
import type { GroupRole, MembershipStatus } from '@thefold/core';
import { expect } from 'vitest';
import {
  upsertGroupRead,
  upsertMembershipRead,
  upsertPersonRead,
  type GroupReadInput,
  type PersonReadInput,
} from '../../src/db/readModels.js';
import { withTenant } from '../../src/db/tenant.js';
import { buildApi } from '../../src/http/app.js';
import { silentLogger } from '../../src/log.js';
import type { MailMessage } from '../../src/mail/mailer.js';
import { processOutbox } from '../../src/workers/outbox.js';
import { seedTenant, type TestDb } from './db.js';
import { MemoryGateway } from './memoryGateway.js';

export const BASE = 'thefold.test';
let n = 0;

/**
 * A church with its own API, clock, outbox, memory Twenty and inbox, plus helpers to put people, groups and
 * memberships in its read models and to sign a person in through the real emailed-link flow.
 */
export async function portalChurch(db: TestDb) {
  const slug = `portal-${++n}`;
  const t = await seedTenant(db, slug);
  const clock = { now: new Date('2026-10-02T12:00:00Z') };
  const sent: MailMessage[] = [];
  const gateway = new MemoryGateway();
  const app = buildApi({
    pool: db.appPool,
    kek: Buffer.alloc(32, 9),
    log: silentLogger,
    tenancy: { baseDomain: BASE, defaultSubdomain: null },
    trustProxy: false,
    turnstileSecret: null,
    cardRateLimit: 5,
    now: () => clock.now,
    remoteAddress: () => '203.0.113.9',
    portal: { secureCookies: false, signInRateLimit: 100 },
  });
  const host = `${slug}.${BASE}`;
  const inT = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db.appPool, t.id, fn);
  const req = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    app.request(path, { ...init, headers: { host, ...init.headers } });

  const person = (id: string, over: Partial<PersonReadInput> = {}) =>
    inT((c) =>
      upsertPersonRead(c, {
        twentyPersonId: id,
        twentyUpdatedAt: new Date('2026-10-01T00:00:00Z'),
        firstName: 'Test',
        lastName: 'Person',
        emails: [],
        phones: [],
        isMinor: false,
        sharedEmail: false,
        householdId: null,
        lifecycleStage: 'CONNECTED',
        doNotContact: false,
        awayUntil: null,
        deletedAt: null,
        ...over,
      }),
    );
  const group = (id: string, over: Partial<GroupReadInput> = {}) =>
    inT((c) =>
      upsertGroupRead(c, {
        twentyGroupId: id,
        twentyUpdatedAt: new Date('2026-10-01T00:00:00Z'),
        name: 'A group',
        groupType: 'SMALL_GROUP',
        openness: 'CLOSED',
        childFriendly: false,
        pausedUntil: null,
        campusId: null,
        description: null,
        schedule: null,
        capacity: null,
        deletedAt: null,
        ...over,
      }),
    );
  let m = 0;
  /** A membership both Twenty (memory) and the read model already hold, as after a sync. */
  const membership = (
    groupId: string,
    personId: string,
    status: MembershipStatus,
    role: GroupRole = 'MEMBER',
  ) => {
    const id = `00000000-0000-4000-8000-${String(++m).padStart(12, '0')}`;
    gateway.memberships.set(`${groupId}:${personId}`, {
      id,
      membership: { groupId, personId, status, role },
      joinedAt: null,
    });
    return inT((c) =>
      upsertMembershipRead(c, {
        twentyMembershipId: id,
        twentyUpdatedAt: new Date('2026-10-01T00:00:00Z'),
        groupId,
        personId,
        role,
        status,
        deletedAt: null,
      }),
    );
  };

  /** The worker's part: sends queued mail and queued writes to (memory) Twenty. */
  const work = () =>
    processOutbox(db.appPool, t.id, gateway, {
      now: clock.now,
      mail: {
        mailer: { send: (msg) => (sent.push(msg), Promise.resolve()) },
        publicUrl: (sub) => `http://${sub}.${BASE}`,
      },
    });

  /** Signs `email` in through the emailed link and returns the session cookie. */
  const signIn = async (email: string): Promise<string> => {
    clock.now = new Date(clock.now.getTime() + 61_000); // a fresh minute: a fresh request
    const ask = await req('/v1/auth/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    expect(ask.status).toBe(202);
    await work();
    const token = /[?&]token=([A-Za-z0-9_-]+)/.exec(sent.at(-1)?.text ?? '')?.[1];
    expect(token, `a link was emailed to ${email}`).toBeTruthy();
    const res = await req('/sign-in/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: token as string }).toString(),
    });
    expect(res.status).toBe(303);
    return res.headers.get('set-cookie')?.split(';')[0] ?? '';
  };

  const getJson = async (cookie: string, path: string) => {
    const res = await req(path, { headers: { cookie } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const postJson = (cookie: string, path: string, body: unknown = {}) =>
    req(path, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const postForm = (cookie: string, path: string, fields: Record<string, string> = {}) =>
    req(path, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

  return {
    t,
    slug,
    host,
    clock,
    sent,
    gateway,
    inT,
    req,
    person,
    group,
    membership,
    work,
    signIn,
    getJson,
    postJson,
    postForm,
  };
}
