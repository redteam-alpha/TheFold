// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, dbAvailable, type TestDb } from './helpers/db.js';
import { portalChurch } from './helpers/portal.js';

const LEA = '00000000-0000-4000-8000-0000000e0001'; // leads Supper
const BEA = '00000000-0000-4000-8000-0000000e0002'; // a member
const CY = '00000000-0000-4000-8000-0000000e0003'; // a member
const DEE = '00000000-0000-4000-8000-0000000e0004'; // not in Supper
const KID = '00000000-0000-4000-8000-0000000e0005'; // a child in Supper
const SUPPER = '00000000-0000-4000-8000-0000000f0001';

type Post = {
  id: string;
  author: string;
  mine: boolean;
  text: string | null;
  removed: boolean;
  reactions: { mine: string | null; counts: Record<string, number> | null };
};

describe.skipIf(!dbAvailable)('group posts (ADR 0009)', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.drop();
  });

  async function setUp() {
    const c = await portalChurch(db);
    await c.person(LEA, { firstName: 'Lea', lastName: 'Lambert', emails: ['lea@example.com'] });
    await c.person(BEA, { firstName: 'Bea', lastName: 'Bower', emails: ['bea@example.com'] });
    await c.person(CY, { firstName: 'Cy', lastName: 'Carter', emails: ['cy@example.com'] });
    await c.person(DEE, { firstName: 'Dee', lastName: 'Dunn', emails: ['dee@example.com'] });
    await c.person(KID, { firstName: 'Kit', lastName: 'Carter', isMinor: true });
    await c.group(SUPPER, { name: 'Tuesday Supper', openness: 'CLOSED' });
    await c.membership(SUPPER, LEA, 'ACTIVE', 'LEADER');
    await c.membership(SUPPER, BEA, 'ACTIVE');
    await c.membership(SUPPER, CY, 'ACTIVE');
    await c.membership(SUPPER, KID, 'ACTIVE');
    const lea = await c.signIn('lea@example.com');
    const bea = await c.signIn('bea@example.com');
    const cy = await c.signIn('cy@example.com');
    const dee = await c.signIn('dee@example.com');
    const post = async (cookie: string, text: string) => {
      const res = await c.postJson(cookie, `/v1/groups/${SUPPER}/posts`, { text });
      expect(res.status).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };
    const feed = async (cookie: string) =>
      (await c.getJson(cookie, `/v1/groups/${SUPPER}/posts`)).body['posts'] as Post[];
    return { c, lea, bea, cy, dee, post, feed };
  }

  it('lets members post and read, newest first, and keeps everyone else out', async () => {
    const { c, bea, cy, dee, post, feed } = await setUp();
    await post(bea, 'Soup on Tuesday?');
    c.clock.now = new Date(c.clock.now.getTime() + 60_000);
    await post(cy, 'I can bring bread.');

    const seen = await feed(bea);
    expect(seen.map((p) => [p.author, p.text, p.mine])).toEqual([
      ['Cy C.', 'I can bring bread.', false],
      ['Bea B.', 'Soup on Tuesday?', true],
    ]);
    expect((await c.getJson(dee, `/v1/groups/${SUPPER}/posts`)).status).toBe(404);
    expect((await c.getJson(dee, `/v1/posts/${seen[0]?.id}`)).status).toBe(404);
    expect((await c.postJson(dee, `/v1/groups/${SUPPER}/posts`, { text: 'hi' })).status).toBe(404);

    const other = await portalChurch(db);
    await other.person(BEA, { firstName: 'Bea', emails: ['bea@example.com'] });
    const elsewhere = await other.signIn('bea@example.com');
    expect((await other.getJson(elsewhere, `/v1/posts/${seen[0]?.id}`)).status).toBe(404);
  });

  it('closes the feed the moment someone leaves the group', async () => {
    const { c, cy, post, feed } = await setUp();
    const id = await post(cy, 'Hello');
    expect(await feed(cy)).toHaveLength(1);
    await c.postJson(cy, `/v1/groups/${SUPPER}/leave`);
    expect((await c.getJson(cy, `/v1/groups/${SUPPER}/posts`)).status).toBe(404);
    expect((await c.getJson(cy, `/v1/posts/${id}`)).status).toBe(404);
    // Their own post stays theirs to take down.
    expect((await c.postJson(cy, `/v1/posts/${id}/remove`)).status).toBe(200);
  });

  it('pages through older posts without repeating or skipping one', async () => {
    const { c, bea } = await setUp();
    // More than a page, several in the same instant: the cursor must break ties.
    for (let i = 0; i < 25; i++) {
      if (i % 3 === 0) c.clock.now = new Date(c.clock.now.getTime() + 1000);
      await c.inT((x) =>
        x.query(
          `INSERT INTO post (tenant_id, author_person_id, audience, group_id, body, created_at)
           VALUES (fold_current_tenant(), $1, 'GROUP', $2, $3, $4)`,
          [BEA, SUPPER, `post ${i}`, c.clock.now],
        ),
      );
    }
    const first = (await c.getJson(bea, `/v1/groups/${SUPPER}/posts`)).body;
    const second = (
      await c.getJson(
        bea,
        `/v1/groups/${SUPPER}/posts?before=${encodeURIComponent(first['next'] as string)}`,
      )
    ).body;
    const texts = [...(first['posts'] as Post[]), ...(second['posts'] as Post[])].map(
      (p) => p.text,
    );
    expect(texts).toHaveLength(25);
    expect(new Set(texts).size).toBe(25);
    expect(second['next']).toBeNull();
  });

  it('keeps one response per person, and tells only the author how many', async () => {
    const { c, bea, cy, lea, post } = await setUp();
    const id = await post(bea, 'My mum is in hospital.');
    await c.req(`/v1/posts/${id}/reaction`, {
      method: 'PUT',
      headers: { cookie: cy, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'PRAYED' }),
    });
    for (const kind of ['THANKS', 'CARE'])
      await c.req(`/v1/posts/${id}/reaction`, {
        method: 'PUT',
        headers: { cookie: lea, 'content-type': 'application/json' },
        body: JSON.stringify({ kind }),
      });
    const like = await c.req(`/v1/posts/${id}/reaction`, {
      method: 'PUT',
      headers: { cookie: lea, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'LIKE' }),
    });
    expect(like.status).toBe(400);
    const own = await c.req(`/v1/posts/${id}/reaction`, {
      method: 'PUT',
      headers: { cookie: bea, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'THANKS' }),
    });
    expect(own.status).toBe(409); // not on your own post

    const author = (await c.getJson(bea, `/v1/posts/${id}`)).body['post'] as Post;
    expect(author.reactions).toEqual({ mine: null, counts: { THANKS: 0, PRAYED: 1, CARE: 1 } });
    const reader = (await c.getJson(cy, `/v1/posts/${id}`)).body['post'] as Post;
    expect(reader.reactions).toEqual({ mine: 'PRAYED', counts: null });
    const page = await (await c.req(`/posts/${id}`, { headers: { cookie: cy } })).text();
    expect(page).not.toContain('Only you see this');
    const authorPage = await (await c.req(`/posts/${id}`, { headers: { cookie: bea } })).text();
    expect(authorPage).toContain('Only you see this: 1 Praying, 1 Care.');

    const back = await c.req(`/v1/posts/${id}/reaction`, {
      method: 'DELETE',
      headers: { cookie: cy },
    });
    expect(back.status).toBe(200);
    const after = (await c.getJson(bea, `/v1/posts/${id}`)).body['post'] as Post;
    expect(after.reactions.counts).toEqual({ THANKS: 0, PRAYED: 0, CARE: 1 });
  });

  it('runs a report to the leader, who removes it; others then see only that it was removed', async () => {
    const { c, bea, cy, lea, post } = await setUp();
    const id = await post(cy, 'Something unkind');
    const reported = await c.postJson(bea, '/v1/reports', {
      subject: 'POST',
      id,
      reason: 'This was hurtful',
    });
    expect(reported.status).toBe(201);
    // Twice is still once.
    await c.postJson(bea, '/v1/reports', { subject: 'POST', id, reason: 'Again' });
    expect((await c.getJson(cy, `/v1/groups/${SUPPER}/reports`)).status).toBe(404);

    const reports = (await c.getJson(lea, `/v1/groups/${SUPPER}/reports`)).body['reports'] as {
      id: string;
      reason: string;
      text: string;
      author: string;
    }[];
    expect(reports).toEqual([
      expect.objectContaining({
        reason: 'This was hurtful',
        text: 'Something unkind',
        author: 'Cy C.',
      }),
    ]);
    expect(JSON.stringify(reports)).not.toContain('Bea'); // leaders do not see who reported
    expect(
      (await c.postJson(cy, `/v1/reports/${reports[0]?.id}`, { action: 'REMOVE' })).status,
    ).toBe(403);
    expect(
      (await c.postJson(lea, `/v1/reports/${reports[0]?.id}`, { action: 'REMOVE' })).status,
    ).toBe(200);

    const others = (await c.getJson(bea, `/v1/posts/${id}`)).body['post'] as Post;
    expect(others).toMatchObject({ removed: true, text: null });
    const authorView = (await c.getJson(cy, `/v1/posts/${id}`)).body['post'] as Post;
    expect(authorView).toMatchObject({ removed: true, text: 'Something unkind' });
    expect((await c.postJson(bea, `/v1/posts/${id}/comments`, { text: 'reply' })).status).toBe(409);
    expect(
      ((await c.getJson(lea, `/v1/groups/${SUPPER}/reports`)).body['reports'] as unknown[]).length,
    ).toBe(0);

    const audit = await c.inT((x) =>
      x.query<{ action: string; actor_person_id: string }>(
        `SELECT action, actor_person_id FROM audit_log WHERE action LIKE 'feed.%'`,
      ),
    );
    expect(audit.rows).toEqual([{ action: 'feed.content_removed', actor_person_id: LEA }]);
  });

  it('lets a leader keep reported content, and authors remove their own replies', async () => {
    const { c, bea, cy, lea, post } = await setUp();
    const id = await post(cy, 'I disagree with the plan');
    const comment = await c.postJson(bea, `/v1/posts/${id}/comments`, { text: 'Me too' });
    const commentId = ((await comment.json()) as { id: string }).id;
    await c.postJson(cy, '/v1/reports', { subject: 'COMMENT', id: commentId, reason: 'Off topic' });
    const [report] = (await c.getJson(lea, `/v1/groups/${SUPPER}/reports`)).body['reports'] as {
      id: string;
    }[];
    expect((await c.postJson(lea, `/v1/reports/${report?.id}`, { action: 'DISMISS' })).status).toBe(
      200,
    );
    let comments = (await c.getJson(cy, `/v1/posts/${id}`)).body['comments'] as Post[];
    expect(comments.map((m) => m.text)).toEqual(['Me too']);

    expect((await c.postJson(cy, `/v1/comments/${commentId}/remove`)).status).toBe(404); // not hers
    expect((await c.postJson(bea, `/v1/comments/${commentId}/remove`)).status).toBe(200);
    comments = (await c.getJson(cy, `/v1/posts/${id}`)).body['comments'] as Post[];
    expect(comments).toEqual([expect.objectContaining({ removed: true, text: null })]);
  });

  it('limits posting per hour, refuses empty or huge posts, and escapes what people write', async () => {
    const { c, bea, post } = await setUp();
    expect((await c.postJson(bea, `/v1/groups/${SUPPER}/posts`, { text: '   ' })).status).toBe(400);
    expect(
      (await c.postJson(bea, `/v1/groups/${SUPPER}/posts`, { text: 'x'.repeat(5001) })).status,
    ).toBe(400);
    const id = await post(bea, '<script>alert(1)</script>\nsecond line');
    const page = await (await c.req(`/posts/${id}`, { headers: { cookie: bea } })).text();
    expect(page).not.toContain('<script>alert(1)</script>');
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    for (let i = 1; i < 10; i++) await post(bea, `post ${i}`);
    expect(
      (await c.postJson(bea, `/v1/groups/${SUPPER}/posts`, { text: 'one too many' })).status,
    ).toBe(429);
    c.clock.now = new Date(c.clock.now.getTime() + 3_600_001);
    expect((await c.postJson(bea, `/v1/groups/${SUPPER}/posts`, { text: 'later' })).status).toBe(
      201,
    );
  });

  it('works through the plain pages, and refuses posts from other sites', async () => {
    const { c, bea, cy } = await setUp();
    const posted = await c.postForm(bea, `/groups/${SUPPER}/posts`, { text: 'From the page' });
    expect(posted.status).toBe(303);
    const page = await (await c.req(`/groups/${SUPPER}/posts`, { headers: { cookie: cy } })).text();
    expect(page).toContain('From the page');
    expect(page).toContain('Write as you would speak to someone at the table');
    expect(page).not.toContain('Kit'); // children are never named

    const forged = await c.req(`/v1/groups/${SUPPER}/posts`, {
      method: 'POST',
      headers: { cookie: bea, origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'forged' }),
    });
    expect(forged.status).toBe(403);
    const reportBack = await c.postForm(bea, '/reports', {
      subject: 'POST',
      id: '00000000-0000-4000-8000-000000000000',
      reason: 'x',
      back: 'https://evil.example/',
    });
    expect(reportBack.status).toBe(404);
    expect(await reportBack.text()).toContain('href="/groups"'); // never an outside address
  });
});
