// SPDX-License-Identifier: AGPL-3.0-or-later
import { TwentyClient, unwrapRecords } from '../client.js';
import { TwentyHttpError } from '../errors.js';
import type { CheckContext, CheckOutcome } from './checks.js';
import { dig } from './json.js';
import { loginWithPassword, TwentyLoginError } from './login.js';

/**
 * The privacy check that decides whether a real congregation can be hosted: can a user WITHOUT the care team's
 * role see a care request through any API surface? Care requests carry metadata only (the confidential text is
 * not in Twenty at all, ADR 0004), but the fact that someone is receiving care is itself sensitive.
 *
 * It signs in as two real test users (a person's role cannot be given to an API key, so there is no other way
 * to be one), seeds a fake person and care request, and then asks every surface for it. A "leak" is the seeded
 * care request's id or text turning up in any response, or a write succeeding.
 *
 * Two rules keep it honest:
 *  - Controls first. If the care team cannot read the record, or the staff token cannot read anything at all, a
 *    "denied" proves nothing, so the check says that instead of passing.
 *  - Never PASS on what was not tested. A surface that could not be exercised (the server has no search, the
 *    admin key was not given for the timeline) is listed, and the result is INFO, not PASS.
 */

const ENV = {
  staffEmail: 'FOLD_M0_STAFF_EMAIL',
  staffPassword: 'FOLD_M0_STAFF_PASSWORD',
  careEmail: 'FOLD_M0_CARE_EMAIL',
  carePassword: 'FOLD_M0_CARE_PASSWORD',
} as const;

export const CARE_SETUP_STEPS =
  'Needs two test users, which the harness cannot create: in Twenty (Settings → Members) invite two fake ' +
  'addresses, accept the invitations from the mail inbox, set passwords, and give one the "Church staff" role ' +
  'and the other "Care team". Then set FOLD_M0_STAFF_EMAIL, FOLD_M0_STAFF_PASSWORD, FOLD_M0_CARE_EMAIL and ' +
  'FOLD_M0_CARE_PASSWORD (infra/README.md). The check then asks, as the staff user, for a seeded care request ' +
  'over REST, GraphQL, global search and the timeline, and fails if any of them returns it.';

/** Statuses that mean "you may not": some servers answer 400 or 404 for an object a role cannot see. */
const DENIED = new Set([400, 401, 403, 404]);

interface Seed {
  personId: string;
  careId: string;
  marker: string;
}

interface Probe {
  ok: boolean;
  status: number;
  json: unknown;
  /** The whole response body as text, so a leak is found wherever it hides. */
  text: string;
}

type Verdict = { kind: 'ok' | 'leak' | 'untested'; text: string };
const ok = (text: string): Verdict => ({ kind: 'ok', text });
const leak = (text: string): Verdict => ({ kind: 'leak', text });
const untested = (text: string): Verdict => ({ kind: 'untested', text });

const leaked = (text: string, s: Seed): boolean =>
  text.includes(s.careId) || text.includes(s.marker);

async function probe(
  client: TwentyClient,
  method: string,
  path: string,
  o: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
): Promise<Probe> {
  try {
    const json = await client.request(method, path, { ...o, retry: false });
    return { ok: true, status: 200, json, text: JSON.stringify(json ?? null) };
  } catch (error) {
    if (error instanceof TwentyHttpError)
      return { ok: false, status: error.status, json: undefined, text: error.bodySnippet };
    throw error;
  }
}

const gql = (client: TwentyClient, query: string, variables?: Record<string, string>) =>
  probe(client, 'POST', '/graphql', { body: { query, ...(variables ? { variables } : {}) } });

const CARE_LIST = '{ careRequests { edges { node { id name } } } }';
const SEARCH =
  'query ($q: String!) { search(searchInput: $q, limit: 20) { edges { node { recordId objectNameSingular label } } } }';

const edgesOf = (p: Probe, key: string): unknown[] => {
  const edges = dig(p.json, 'data', key, 'edges');
  return Array.isArray(edges) ? edges : [];
};
const hasGraphQlErrors = (p: Probe): boolean => {
  const errors = dig(p.json, 'errors');
  return Array.isArray(errors) && errors.length > 0;
};

/** One REST read as the staff user: denied, empty, or a leak. */
async function restRead(
  client: TwentyClient,
  seed: Seed,
  label: string,
  path: string,
  o: { query?: Record<string, string | number | undefined>; noRecords?: boolean } = {},
): Promise<Verdict> {
  const p = await probe(client, 'GET', path, o.query ? { query: o.query } : {});
  if (leaked(p.text, seed)) return leak(`${label}: the care request was returned`);
  if (!p.ok)
    return DENIED.has(p.status)
      ? ok(`${label}: denied (HTTP ${p.status})`)
      : untested(`${label}: unexpected HTTP ${p.status}`);
  if (o.noRecords && unwrapRecords(p.json).length > 0)
    return leak(`${label}: care requests were listed`);
  return ok(`${label}: nothing returned`);
}

function judgeGraphQl(p: Probe, seed: Seed, label: string, listKey?: string): Verdict {
  if (leaked(p.text, seed)) return leak(`${label}: the care request was returned`);
  if (listKey && edgesOf(p, listKey).length > 0) return leak(`${label}: care requests were listed`);
  if (!p.ok)
    return DENIED.has(p.status)
      ? ok(`${label}: denied (HTTP ${p.status})`)
      : untested(`${label}: unexpected HTTP ${p.status}`);
  return hasGraphQlErrors(p)
    ? ok(`${label}: denied (GraphQL error)`)
    : ok(`${label}: nothing returned`);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A client that acts as that user, or the FAIL to report. Passwords and tokens never reach the message. */
async function signIn(
  ctx: CheckContext,
  roleLabel: string,
  email: string,
  password: string,
): Promise<TwentyClient | CheckOutcome> {
  try {
    const token = await loginWithPassword({
      baseUrl: ctx.baseUrl,
      email,
      password,
      fetch: ctx.fetch,
    });
    return new TwentyClient({ baseUrl: ctx.baseUrl, apiKey: token, fetch: ctx.fetch });
  } catch (error) {
    const why = error instanceof TwentyLoginError ? error.message : 'unexpected error';
    return {
      status: 'FAIL',
      detail:
        `could not sign in as the ${roleLabel} test user: ${why}. The login mutations come from the v2.43.0 ` +
        'schema but have not been seen working against a live server; if the credentials are right, do this ' +
        'check by hand (infra/README.md) and tell us what the server answered',
    };
  }
}

export async function careRequestPermissions(ctx: CheckContext): Promise<CheckOutcome> {
  const staffEmail = ctx.env[ENV.staffEmail];
  const staffPassword = ctx.env[ENV.staffPassword];
  const careEmail = ctx.env[ENV.careEmail];
  const carePassword = ctx.env[ENV.carePassword];
  if (!staffEmail || !staffPassword || !careEmail || !carePassword)
    return { status: 'SKIP', detail: CARE_SETUP_STEPS };

  // ---- sign in as both users -------------------------------------------------------------------
  const staffSession = await signIn(ctx, 'Church staff', staffEmail, staffPassword);
  if (!(staffSession instanceof TwentyClient)) return staffSession;
  const careSession = await signIn(ctx, 'Care team', careEmail, carePassword);
  if (!(careSession instanceof TwentyClient)) return careSession;
  const staff = staffSession;
  const care = careSession;
  const admin = ctx.adminClient ?? ctx.client;

  // ---- seed fake data as the service account; the cleanup (admin) removes it ------------------
  const marker = `M0 care ${ctx.runId}`;
  const writeRef = `m0:${ctx.runId}:care-write`;
  const person = await ctx.client.createRecord('people', {
    name: { firstName: 'M0Care', lastName: ctx.runId },
    sourceRef: `m0:${ctx.runId}:care-person`,
  });
  let careId: string | undefined;
  try {
    const record = await ctx.client.createRecord('careRequests', {
      name: marker,
      personId: person.id,
      sourceRef: `m0:${ctx.runId}:care-request`,
    });
    careId = record.id;
    const seed: Seed = { personId: person.id, careId: record.id, marker };

    // ---- controls: a denial only means something if the same request works for the care team ----
    const careRead = await probe(care, 'GET', `/rest/careRequests/${seed.careId}`);
    if (!careRead.ok || !careRead.text.includes(seed.marker))
      return {
        status: 'FAIL',
        detail:
          `the Care team user could not read the seeded care request over REST (${careRead.ok ? 'it came back without the record' : `HTTP ${careRead.status}`}). ` +
          'Either that user does not have the "Care team" role or the role is too narrow for the care team to do ' +
          'its job. Every denial below would be meaningless, so none was recorded',
      };
    const staffControl = await probe(staff, 'GET', '/rest/people', { query: { limit: 1 } });
    if (!staffControl.ok)
      return {
        status: 'FAIL',
        detail:
          `the Church staff user could not read even people (HTTP ${staffControl.status}), so its token or role ` +
          'is not usable and a denial of care requests would mean nothing',
      };

    const verdicts: Verdict[] = [];

    // ---- staff over REST ---------------------------------------------------------------------
    verdicts.push(
      await restRead(staff, seed, 'REST list', '/rest/careRequests', { noRecords: true }),
    );
    verdicts.push(await restRead(staff, seed, 'REST by id', `/rest/careRequests/${seed.careId}`));
    verdicts.push(
      await restRead(staff, seed, 'REST person with relations', `/rest/people/${seed.personId}`, {
        query: { depth: 2 },
      }),
    );

    // The person page is only a meaningful test if the relation really shows for someone allowed to see it.
    const careViewOfPerson = await probe(care, 'GET', `/rest/people/${seed.personId}`, {
      query: { depth: 2 },
    });
    if (!careViewOfPerson.ok || !careViewOfPerson.text.includes(seed.careId))
      verdicts[verdicts.length - 1] = untested(
        'REST person with relations: the care request does not appear on the person even for the Care team ' +
          '(relation not expanded?), so a clean answer for staff proves nothing',
      );

    // A write by staff must fail, and must not have happened anyway.
    const write = await probe(staff, 'POST', '/rest/careRequests', {
      body: { name: `${marker} written by staff`, sourceRef: writeRef },
    });
    const written = await ctx.client.findBySourceRef('careRequests', writeRef);
    if (written) await ctx.remove('careRequests', written.id);
    verdicts.push(
      write.ok || written
        ? leak('REST create: staff created a care request')
        : DENIED.has(write.status)
          ? ok(`REST create: denied (HTTP ${write.status})`)
          : untested(`REST create: unexpected HTTP ${write.status}`),
    );

    // ---- staff over GraphQL ------------------------------------------------------------------
    const careList = await gql(care, CARE_LIST);
    if (careList.text.includes(seed.careId)) {
      verdicts.push(
        judgeGraphQl(await gql(staff, CARE_LIST), seed, 'GraphQL careRequests', 'careRequests'),
      );
    } else {
      verdicts.push(
        untested(
          `GraphQL careRequests: the same query failed for the Care team too (${hasGraphQlErrors(careList) ? 'GraphQL error' : 'no record'}), so its shape may be wrong for this server`,
        ),
      );
    }

    // ---- global search -----------------------------------------------------------------------
    const careSearch = await gql(care, SEARCH, { q: seed.marker });
    if (careSearch.text.includes(seed.careId) || careSearch.text.includes(seed.marker)) {
      verdicts.push(
        judgeGraphQl(await gql(staff, SEARCH, { q: seed.marker }), seed, 'global search'),
      );
    } else {
      verdicts.push(
        untested(
          'global search: the Care team could not find the care request either (no such query, not indexed ' +
            'yet, or a different shape); check it by hand in the UI and with the curl steps in infra/README.md',
        ),
      );
    }

    // ---- the timeline ------------------------------------------------------------------------
    // Prove an entry exists (read with the admin key; the service account may not read timelines), then
    // ask for it as staff, and ask for the person's timeline, where it would also show.
    const waitMs = Number(ctx.env['FOLD_M0_TIMELINE_WAIT_MS'] ?? 6000);
    const attempts = Math.max(1, Math.ceil(waitMs / 750));
    const byRecord = { filter: `linkedRecordId[eq]:"${seed.careId}"`, limit: 20 };
    let entryExists = false;
    let adminDenied = false;
    for (let i = 0; i < attempts && !entryExists; i++) {
      const p = await probe(admin, 'GET', '/rest/timelineActivities', { query: byRecord });
      if (!p.ok) {
        adminDenied = DENIED.has(p.status);
        break;
      }
      entryExists = unwrapRecords(p.json).length > 0;
      if (!entryExists && i < attempts - 1) await sleep(750);
    }
    if (entryExists) {
      verdicts.push(
        await restRead(staff, seed, 'timeline of the care request', '/rest/timelineActivities', {
          query: byRecord,
          noRecords: true,
        }),
      );
      verdicts.push(
        await restRead(staff, seed, 'timeline of the person', '/rest/timelineActivities', {
          query: { filter: `targetPersonId[eq]:"${seed.personId}"`, limit: 60 },
        }),
      );
    } else {
      verdicts.push(
        untested(
          adminDenied
            ? 'timeline: the admin key could not read timeline entries, so there is no proof one exists'
            : 'timeline: no entry was created for the care request within the wait, so there was nothing to leak',
        ),
      );
    }

    // ---- verdict -----------------------------------------------------------------------------
    const leaks = verdicts.filter((v) => v.kind === 'leak').map((v) => v.text);
    const gaps = verdicts.filter((v) => v.kind === 'untested').map((v) => v.text);
    const fine = verdicts.filter((v) => v.kind === 'ok').map((v) => v.text);
    if (leaks.length > 0)
      return {
        status: 'FAIL',
        detail:
          `LEAK as the Church staff user: ${leaks.join('; ')}. ${fine.length > 0 ? `Held: ${fine.join('; ')}. ` : ''}` +
          'Do not host a real congregation until this passes',
      };
    if (gaps.length > 0)
      return {
        status: 'INFO',
        detail:
          `no leak found on ${fine.length} surface(s): ${fine.join('; ')}. NOT tested, do these by hand: ` +
          `${gaps.join('; ')}. The Care team user could read the record (control)`,
      };
    return {
      status: 'PASS',
      detail:
        `as the Church staff user every surface denied or hid the care request: ${fine.join('; ')}. ` +
        'The Care team user could read it (control)',
    };
  } finally {
    if (careId) await ctx.remove('careRequests', careId);
    await ctx.remove('people', person.id);
  }
}
