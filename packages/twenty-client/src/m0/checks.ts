// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TwentyClient } from '../client.js';
import { unwrapRecords, type TwentyRecord } from '../client.js';
import { TwentyHttpError } from '../errors.js';
import { careRequestPermissions } from './careChecks.js';
import {
  defaultSignedPayload,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyWebhook,
} from '../webhook.js';

/**
 * M0: run The Fold's open assumptions about Twenty against a REAL instance and say exactly what happened.
 *
 * Statuses:
 *   PASS    the assumption held
 *   FAIL    it did not; `detail` says what was observed
 *   INFO    an observation to record (a limit, a header), with no pass/fail
 *   SKIP    not attempted (an opt-in check was not enabled)
 *   MANUAL  cannot be automated through the API; `detail` lists the steps a person must do
 *
 * Every check cleans up after itself, with `adminClient` when there is one (a restricted role usually cannot
 * delete people), and whatever still cannot be deleted is listed in a `cleanup` row. Nothing here is a substitute
 * for reading the result: paste the
 * table into docs/verification-status.md with the date and the Twenty version.
 */
export type CheckStatus = 'PASS' | 'FAIL' | 'INFO' | 'SKIP' | 'MANUAL';

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
}

export interface ModelExpectation {
  /** `nameSingular` of every custom object the app should have installed. */
  objects: readonly string[];
  /** Names of the fields the app adds to Person. */
  personFields: readonly string[];
}

export interface M0Context {
  /** The client the checks run as. Use the service-account key to test the least privilege the real services get. */
  client: TwentyClient;
  /**
   * An admin client, used ONLY for what a least-privilege role may not do and the real services never need:
   * reading workspace metadata (the `app-installed` check) and deleting the records the checks create. Defaults
   * to `client`. The service-account role cannot read metadata or delete people or households, so a run as that
   * role needs this.
   */
  adminClient?: TwentyClient;
  baseUrl: string;
  apiKey: string;
  fetch: typeof fetch;
  model: ModelExpectation;
  env: Record<string, string | undefined>;
  /** Unique per run so leftovers from a crashed run are recognisable and never collide. */
  runId?: string;
  log?: (message: string) => void;
}

/**
 * Deletes a record a check created, with the cleanup client. It never throws: a refused delete is recorded and
 * reported in the `cleanup` row, and must not turn a check that passed into one that failed.
 */
export type RemoveRecord = (
  plural: string,
  id: string,
  priority?: Parameters<TwentyClient['deleteRecord']>[2],
) => Promise<void>;

/** What a check is given: the context, with a run id, a logger and the never-throwing `remove`. */
export type CheckContext = Required<Pick<M0Context, 'runId' | 'log'>> &
  M0Context & { remove: RemoveRecord };
export type CheckOutcome = Omit<CheckResult, 'id' | 'title'>;
type Check = (ctx: CheckContext) => Promise<CheckOutcome>;

const pass = (detail: string) => ({ status: 'PASS' as const, detail });
const fail = (detail: string) => ({ status: 'FAIL' as const, detail });
const info = (detail: string) => ({ status: 'INFO' as const, detail });

/** Collects `nameSingular` values and, for Person, its field names, from whatever shape the metadata API returns. */
export function readMetadata(json: unknown): { objects: Set<string>; personFields: Set<string> } {
  const objects = new Set<string>();
  const personFields = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    if (typeof o['nameSingular'] === 'string') {
      objects.add(o['nameSingular']);
      if (o['nameSingular'] === 'person') {
        const fields = o['fields'] ?? (o['fields'] as { edges?: unknown } | undefined)?.edges;
        const list = Array.isArray(fields) ? fields : [];
        for (const f of list) {
          const name =
            (f as { name?: string; node?: { name?: string } }).name ??
            (f as { node?: { name?: string } }).node?.name;
          if (name) personFields.add(name);
        }
      }
    }
    Object.values(o).forEach(walk);
  };
  walk(json);
  return { objects, personFields };
}

const CHECKS: { id: string; title: string; run: Check }[] = [
  {
    id: 'health',
    title: 'Server answers /healthz',
    run: async (ctx) => {
      const res = await ctx.fetch(new URL('/healthz', ctx.baseUrl));
      return res.ok ? pass(`HTTP ${res.status}`) : fail(`HTTP ${res.status}`);
    },
  },
  {
    id: 'auth-and-rest',
    title:
      'A bearer API key can call the REST API and the response has the shape the client expects',
    run: async (ctx) => {
      const json = await ctx.client.request('GET', '/rest/people', { query: { limit: 1 } });
      const shaped = json !== null && typeof json === 'object' && 'data' in json;
      return shaped
        ? pass(`GET /rest/people → keys: ${Object.keys(json).join(', ')}`)
        : fail(`unexpected body: ${JSON.stringify(json)?.slice(0, 200)}`);
    },
  },
  {
    id: 'app-installed',
    title:
      'The Fold app is installed: every custom object exists and Person has the extension fields (defineField on a standard object works)',
    run: async (ctx) => {
      let json: unknown;
      try {
        // Metadata is an administrative read: the service-account role is not meant to have it.
        json = await (ctx.adminClient ?? ctx.client).request('GET', '/rest/metadata/objects');
      } catch (error) {
        if (error instanceof TwentyHttpError && (error.status === 401 || error.status === 403))
          return fail(
            `this key may not read workspace metadata (HTTP ${error.status}). A least-privilege role such as the ` +
              'service account is not meant to; set FOLD_M0_ADMIN_API_KEY to an admin key and run again. This is ' +
              'a limit of the key, not evidence about the install',
          );
        throw error;
      }
      const seen = readMetadata(json);
      const missingObjects = ctx.model.objects.filter((o) => !seen.objects.has(o));
      const missingFields =
        seen.personFields.size === 0
          ? ['(could not read Person fields from the metadata response)']
          : ctx.model.personFields.filter((f) => !seen.personFields.has(f));
      return missingObjects.length === 0 && missingFields.length === 0
        ? pass(
            `${ctx.model.objects.length} objects and ${ctx.model.personFields.length} Person fields present`,
          )
        : fail(
            `missing objects: [${missingObjects.join(', ')}]; missing Person fields: [${missingFields.join(', ')}]. If the app has not been installed yet, run 'npx twenty apply --force --no-delete' in apps/fold-app (see infra/README.md); every check below that touches a custom object fails until then`,
          );
    },
  },
  {
    id: 'sourceref-idempotent',
    title:
      'sourceRef filters and the unique constraint make creates idempotent: retries cannot duplicate, and a lookup never returns someone else’s record',
    run: async (ctx) => {
      const refA = `m0:${ctx.runId}:idem-a`;
      const refB = `m0:${ctx.runId}:idem-b`;
      const refNone = `m0:${ctx.runId}:idem-none`;
      const cleanup: string[] = [];
      try {
        const a1 = await ctx.client.upsertBySourceRef('followUps', refA, {
          name: `M0 ${ctx.runId} A`,
        });
        cleanup.push(a1.record.id);
        const a2 = await ctx.client.upsertBySourceRef('followUps', refA, {
          name: `M0 ${ctx.runId} A`,
        });
        const b1 = await ctx.client.upsertBySourceRef('followUps', refB, {
          name: `M0 ${ctx.runId} B`,
        });
        cleanup.push(b1.record.id);
        // With two records present, a filter that is silently ignored returns the wrong one, or one for a ref that does not exist.
        const foundA = await ctx.client.findBySourceRef('followUps', refA);
        const foundB = await ctx.client.findBySourceRef('followUps', refB);
        const foundNone = await ctx.client.findBySourceRef('followUps', refNone);
        const problems: string[] = [];
        if (!a1.created) problems.push('first upsert did not create');
        if (a2.created || a2.record.id !== a1.record.id)
          problems.push(
            'second upsert for the same ref created or returned a different record (retries would duplicate)',
          );
        if (!b1.created)
          problems.push(
            'a different ref was not created: the lookup returned some other record (the filter is being ignored: an upsert would silently lose data)',
          );
        if (foundA?.id !== a1.record.id) problems.push('lookup by ref A did not return record A');
        if (foundB?.id !== b1.record.id) problems.push('lookup by ref B did not return record B');
        if (foundNone !== null)
          problems.push(
            'lookup of a ref that does not exist returned a record (the filter is being ignored)',
          );
        return problems.length === 0
          ? pass(
              'created once, found again, distinct refs stayed distinct, an unknown ref found nothing',
            )
          : fail(problems.join('; '));
      } finally {
        for (const id of cleanup) await ctx.remove('followUps', id);
      }
    },
  },
  {
    id: 'select-defaults',
    title:
      'SELECT and BOOLEAN defaults (written as "\'OPEN\'" and false) apply as intended, on our object and on Person',
    run: async (ctx) => {
      const made: [string, string][] = [];
      try {
        const fu = await ctx.client.createRecord('followUps', {
          name: `M0 ${ctx.runId} default`,
          sourceRef: `m0:${ctx.runId}:def`,
        });
        made.push(['followUps', fu.id]);
        const person = await ctx.client.createRecord('people', {
          name: { firstName: 'M0', lastName: ctx.runId },
          sourceRef: `m0:${ctx.runId}:person`,
        });
        made.push(['people', person.id]);
        const problems: string[] = [];
        if (fu['status'] !== 'OPEN')
          problems.push(
            `followUp.status = ${JSON.stringify(fu['status'])} (expected "OPEN"; a value with quotes means the default is being stored literally)`,
          );
        if (person['lifecycleStage'] !== 'NEW_GUEST')
          problems.push(
            `person.lifecycleStage = ${JSON.stringify(person['lifecycleStage'])} (expected "NEW_GUEST")`,
          );
        if (person['doNotContact'] !== false)
          problems.push(
            `person.doNotContact = ${JSON.stringify(person['doNotContact'])} (expected false)`,
          );
        return problems.length === 0 ? pass('defaults applied') : fail(problems.join('; '));
      } finally {
        for (const [plural, id] of made) await ctx.remove(plural, id);
      }
    },
  },
  {
    id: 'person-shapes',
    title:
      'Person accepts composite emails/phones and relations set through <field>Id (household, guardian), and they read back',
    run: async (ctx) => {
      const made: [string, string][] = [];
      try {
        const email = `m0-${ctx.runId}@example.com`;
        const household = await ctx.client.createRecord('households', {
          name: `M0 ${ctx.runId} household`,
          sourceRef: `m0:${ctx.runId}:hh`,
        });
        made.push(['households', household.id]);
        const parent = await ctx.client.createRecord('people', {
          name: { firstName: 'M0', lastName: ctx.runId },
          emails: { primaryEmail: email },
          phones: { primaryPhoneNumber: '+15551230000' },
          householdId: household.id,
          sourceRef: `m0:${ctx.runId}:parent`,
        });
        made.push(['people', parent.id]);
        const child = await ctx.client.createRecord('people', {
          name: { firstName: 'M0kid', lastName: ctx.runId },
          isMinor: true,
          guardianId: parent.id,
          householdId: household.id,
          sourceRef: `m0:${ctx.runId}:child`,
        });
        made.push(['people', child.id]);

        const backParent = await ctx.client.findBySourceRef('people', `m0:${ctx.runId}:parent`);
        const backChild = await ctx.client.findBySourceRef('people', `m0:${ctx.runId}:child`);
        const problems: string[] = [];
        const emails = backParent?.['emails'] as { primaryEmail?: string } | undefined;
        const phones = backParent?.['phones'] as { primaryPhoneNumber?: string } | undefined;
        if (emails?.primaryEmail !== email)
          problems.push(`emails.primaryEmail read back as ${JSON.stringify(emails)}`);
        if (!String(phones?.primaryPhoneNumber ?? '').includes('5551230000'))
          problems.push(`phones.primaryPhoneNumber read back as ${JSON.stringify(phones)}`);
        if (backParent?.['householdId'] !== household.id)
          problems.push(
            `householdId read back as ${JSON.stringify(backParent?.['householdId'])} (relations may not be settable through <field>Id)`,
          );
        if (backChild?.['guardianId'] !== parent.id)
          problems.push(
            `guardianId (a self-relation on Person) read back as ${JSON.stringify(backChild?.['guardianId'])}`,
          );
        if (backChild?.['isMinor'] !== true) problems.push('isMinor did not persist');
        return problems.length === 0
          ? pass('composite emails/phones and household/guardian relations round-trip')
          : fail(problems.join('; '));
      } finally {
        for (const [plural, id] of made.reverse()) await ctx.remove(plural, id);
      }
    },
  },
  {
    id: 'batch-limit-and-paging',
    title:
      'Batch create accepts 60, and pagination + updatedAt filter walk 61 records exactly once',
    run: async (ctx) => {
      const refs = Array.from({ length: 61 }, (_, i) => `m0:${ctx.runId}:att:${i}`);
      const created: TwentyRecord[] = [];
      try {
        // 61 records: two batches (60 + 1), and two pages (60 + 1) when listing.
        created.push(
          ...(await ctx.client.batchCreate(
            'attendances',
            refs.map((r, i) => ({ name: `M0 ${i}`, sourceRef: r, kind: 'SERVICE' })),
          )),
        );
        const since = new Date(Date.now() - 60 * 60_000).toISOString();
        const pages: number[] = [];
        const seen: TwentyRecord[] = [];
        for await (const page of ctx.client.listUpdatedSince('attendances', since, 'interactive')) {
          pages.push(page.length);
          seen.push(...page);
        }
        const mine = seen.filter(
          (r) =>
            typeof r['sourceRef'] === 'string' && r['sourceRef'].startsWith(`m0:${ctx.runId}:att:`),
        );
        const ids = new Set(mine.map((r) => r.id));
        return created.length === 61 && mine.length === 61 && ids.size === 61
          ? pass(
              `created 61 in 2 batches; listing returned pages of ${pages.join(', ')} and saw each record exactly once`,
            )
          : fail(
              `created ${created.length}; listing saw ${mine.length} of ours (${ids.size} distinct); pages: ${pages.join(', ')}`,
            );
      } finally {
        for (const r of created) await ctx.remove('attendances', r.id, 'background');
      }
    },
  },
  {
    id: 'batch-61',
    title: 'What does the server do with a batch of 61? (informational)',
    run: async (ctx) => {
      const made: TwentyRecord[] = [];
      try {
        const body = Array.from({ length: 61 }, (_, i) => ({
          name: `M0 over ${i}`,
          sourceRef: `m0:${ctx.runId}:over:${i}`,
        }));
        try {
          const json = await ctx.client.request('POST', '/rest/batch/attendances', {
            body,
            idempotent: false,
          });
          made.push(...unwrapRecords(json));
          return info(
            `accepted ${made.length} records in one request; the client still chunks at 60 to be safe`,
          );
        } catch (error) {
          return error instanceof TwentyHttpError
            ? info(`rejected with HTTP ${error.status}: ${error.bodySnippet}`)
            : fail(String(error));
        }
      } finally {
        for (const r of made) await ctx.remove('attendances', r.id, 'background');
      }
    },
  },
  {
    id: 'rate-limit',
    title: 'Where does the API start returning 429? (opt-in: FOLD_M0_RATE_TEST=1; sends ~150 GETs)',
    run: async (ctx) => {
      if (ctx.env['FOLD_M0_RATE_TEST'] !== '1')
        return { status: 'SKIP', detail: 'set FOLD_M0_RATE_TEST=1 to measure' };
      let first429 = -1;
      let headers = '';
      const started = Date.now();
      for (let i = 1; i <= 150; i++) {
        const res = await ctx.fetch(new URL('/rest/people?limit=1', ctx.baseUrl), {
          headers: { authorization: `Bearer ${ctx.apiKey}` },
        });
        if (res.status === 429) {
          first429 = i;
          headers = [...res.headers]
            .filter(([k]) => /retry|rate|limit/i.test(k))
            .map(([k, v]) => `${k}: ${v}`)
            .join('; ');
          break;
        }
      }
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      return info(
        first429 === -1
          ? `no 429 in 150 requests over ${secs}s (self-host limit may be off or higher)`
          : `first 429 at request ${first429} after ${secs}s; headers: ${headers || '(none)'}`,
      );
    },
  },
  {
    id: 'webhook-signature',
    title:
      'Webhook deliveries: header names, timestamp unit and the signed string (opt-in: FOLD_M0_WEBHOOK_HOST)',
    run: async (ctx) => {
      const host = ctx.env['FOLD_M0_WEBHOOK_HOST'];
      if (!host)
        return {
          status: 'SKIP',
          detail:
            'set FOLD_M0_WEBHOOK_HOST to a hostname Twenty can reach this machine at (e.g. host.docker.internal)',
        };

      const received: { headers: Record<string, string>; body: string }[] = [];
      const server = createServer((req, res) => {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString('utf8')));
        req.on('end', () => {
          received.push({
            headers: Object.fromEntries(
              Object.entries(req.headers).map(([k, v]) => [k, String(v)]),
            ),
            body,
          });
          res.writeHead(200).end('ok');
        });
      });
      await new Promise<void>((r) => server.listen(0, '0.0.0.0', r));
      const port = (server.address() as AddressInfo).port;
      const made: [string, string][] = [];
      try {
        const hook = await ctx.client.createRecord('webhooks', {
          targetUrl: `http://${host}:${port}/m0`,
          operations: ['person.created'],
          description: `M0 ${ctx.runId}`,
        });
        made.push(['webhooks', hook.id]);
        const person = await ctx.client.createRecord('people', {
          name: { firstName: 'M0hook', lastName: ctx.runId },
          sourceRef: `m0:${ctx.runId}:hook`,
        });
        made.push(['people', person.id]);
        for (let i = 0; i < 60 && received.length === 0; i++)
          await new Promise((r) => setTimeout(r, 500));
        const delivery = received[0];
        if (!delivery)
          return fail(
            'no delivery received within 30s (can Twenty reach that host and port? is the workspace allowed to call private addresses?)',
          );

        const secret =
          ctx.env['FOLD_M0_WEBHOOK_SECRET'] ??
          (typeof hook['secret'] === 'string' ? hook['secret'] : undefined);
        const sig = delivery.headers[SIGNATURE_HEADER];
        const ts = delivery.headers[TIMESTAMP_HEADER];
        const seen = `headers seen: ${
          Object.keys(delivery.headers)
            .filter((h) => /twenty|sign|time|webhook/i.test(h))
            .join(', ') || '(none matching)'
        }; timestamp="${ts ?? '?'}"`;
        if (!secret) return info(`${seen}. Set FOLD_M0_WEBHOOK_SECRET to also test the signature`);
        const candidates: Record<string, (t: string, b: string) => string> = {
          '<timestamp>.<body>': defaultSignedPayload,
          '<body>': (_t, b) => b,
          '<timestamp><body>': (t, b) => `${t}${b}`,
          'v0:<timestamp>:<body>': (t, b) => `v0:${t}:${b}`,
        };
        const matches = Object.entries(candidates).filter(
          ([, f]) =>
            verifyWebhook({
              secret,
              timestamp: ts,
              signature: sig,
              rawBody: delivery.body,
              now: Date.now(),
              toleranceSeconds: 3600,
              signedPayload: f,
            }).ok,
        );
        return matches.length > 0
          ? pass(
              `signature verifies with signed string "${matches[0]?.[0]}"; ${seen}; timestamp unit ${ts && ts.length > 11 ? 'milliseconds' : 'seconds'}`,
            )
          : fail(
              `no candidate matched. ${seen}; signature="${sig ?? '?'}"; body starts: ${delivery.body.slice(0, 120)}`,
            );
      } finally {
        for (const [plural, id] of made.reverse()) await ctx.remove(plural, id);
        await new Promise<void>((r) => server.close(() => r()));
      }
    },
  },
  {
    id: 'care-permissions-api',
    title:
      'A user without the care team role cannot see a care request through REST, GraphQL, global search or the timeline, and cannot create one',
    run: careRequestPermissions,
  },
];

/** Things that cannot be checked through the API. The steps are the deliverable. */
export const MANUAL_CHECKS: Omit<CheckResult, 'status'>[] = [
  {
    id: 'no-enterprise-key',
    title: 'Everything works with NO enterprise key set (ENTERPRISE_KEY empty)',
    detail:
      'Start the stack from infra/docker-compose.yml without ENTERPRISE_KEY. Install the app, then use each view, role and workflow. Note anything that asks for a subscription.',
  },
  {
    id: 'care-permissions',
    title:
      'The care-request object is invisible to the wrong roles in the web UI (the API surfaces are the automated care-permissions-api check)',
    detail:
      'Signed in to the web UI as a "Church staff" user (a private window), with a fake care request in existence: the "Care requests" object is not in the sidebar; its direct URL (/objects/careRequests) is denied or empty; the global search box (Ctrl/Cmd+K) finds nothing for the fake care request; the fake person’s page shows no care request under any tab, including the timeline; exporting People to CSV contains no care data. Repeat as "Care team": they see all of it. The REST, GraphQL, search and timeline calls are checked by care-permissions-api once the test users exist (infra/README.md).',
  },
  {
    id: 'workflow-bypass',
    title: 'A workflow run by a low-privilege user cannot read or write objects that user cannot',
    detail:
      'As "Church staff", create a workflow with a "Search records" action on careRequests and run it manually. It must fail or return nothing. Twenty may run workflows with elevated rights; if so, restrict workflow editing to admins (ADR 0004).',
  },
  {
    id: 'multi-workspace',
    title:
      'IS_MULTIWORKSPACE_ENABLED: licensed for self-host? Can a workspace be created by script?',
    detail:
      'Set IS_MULTIWORKSPACE_ENABLED=true, DEFAULT_SUBDOMAIN, SERVER_URL with a wildcard domain. Create two workspaces. Check for licence prompts. Then find out whether workspace creation and app install can be done by API/CLI without a browser. Decides ADR 0002 (shared workspaces vs one stack per church).',
  },
  {
    id: 'logic-functions-off',
    title:
      'LOGIC_FUNCTION_TYPE / CODE_INTERPRETER_TYPE default to DISABLED in production, and The Fold works with them disabled',
    detail:
      'Leave both unset. Install the app; confirm no logic function is required and nothing errors. (The Fold deliberately uses none.)',
  },
  {
    id: 'app-install',
    title: 'The app builds and installs with the pinned SDK on Node 24',
    detail:
      'In apps/fold-app run: npx twenty remote:add --url <server> --api-key <key> --as thefold (not "local": that is the built-in remote of the CLI and it ignores --url), then npx twenty apply --force --no-delete for the first install (plan only works once the app is registered). app:install is for a published app, not for local source. Confirm every object, Person field, role and view from apps/fold-app/src/model appears, and the "The Fold" navigation folder is in the sidebar.',
  },
  {
    id: 'self-relations',
    title: 'Self-relations on Person work (primaryShepherd/shepherdedPeople, guardian/dependents)',
    detail:
      'Open a Person, set "Primary shepherd" to another Person, confirm the other person lists them under "People they shepherd". Same for Guardian/Dependents.',
  },
  {
    id: 'person-merge',
    title: 'What happens to record ids and webhooks when two Persons are merged in Twenty?',
    detail:
      'Merge two test Persons. Record which id survives, whether a webhook fires for the loser (deleted? merged?), and whether relations (followUps, attendances) move. The portal keeps a person_alias table for this.',
  },
];

export async function runM0(ctx: M0Context): Promise<CheckResult[]> {
  const adminClient = ctx.adminClient ?? ctx.client;
  const leftBehind: { plural: string; id: string; reason: string }[] = [];
  const remove: RemoveRecord = async (plural, id, priority) => {
    try {
      await adminClient.deleteRecord(plural, id, priority);
    } catch (error) {
      const reason =
        error instanceof TwentyHttpError
          ? `HTTP ${error.status}`
          : error instanceof Error
            ? error.message
            : String(error);
      leftBehind.push({ plural, id, reason });
    }
  };
  const full = {
    ...ctx,
    runId: ctx.runId ?? randomUUID().slice(0, 8),
    log: ctx.log ?? (() => undefined),
    remove,
  };
  const results: CheckResult[] = [];
  for (const c of CHECKS) {
    full.log(`… ${c.id}`);
    try {
      results.push({ id: c.id, title: c.title, ...(await c.run(full)) });
    } catch (error) {
      results.push({
        id: c.id,
        title: c.title,
        status: 'FAIL',
        detail: `threw: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  if (leftBehind.length > 0) results.push(cleanupResult(leftBehind, full.runId));
  for (const m of MANUAL_CHECKS) results.push({ ...m, status: 'MANUAL' });
  return results;
}

/** Records a run leaves behind when the cleanup key may not delete them: INFO, because it is not an assumption failing. */
function cleanupResult(
  left: readonly { plural: string; id: string; reason: string }[],
  runId: string,
): CheckResult {
  const shown = left.slice(0, 10).map((r) => `${r.plural}/${r.id} (${r.reason})`);
  const more = left.length > shown.length ? ` and ${left.length - shown.length} more` : '';
  return {
    id: 'cleanup',
    title: 'Test records this run could not delete',
    status: 'INFO',
    detail:
      `${left.length} record(s) were left behind: ${shown.join(', ')}${more}. They belong to run ${runId} ` +
      'and are safe to delete in Twenty. To avoid this, run again with FOLD_M0_ADMIN_API_KEY set to an ' +
      'admin key: the checks then run as FOLD_M0_API_KEY (the least-privilege role under test) and only ' +
      'the cleanup uses the admin key.',
  };
}

/**
 * Makes arbitrary text safe inside one cell of a markdown table. The backslash must be escaped FIRST: otherwise
 * an input that already contains `\|` becomes `\\|`, where the backslash escapes the backslash and the pipe
 * is live again, splitting the cell. (CodeQL: "Incomplete string escaping or encoding".) Line breaks would end
 * the row, so they become spaces; a lone `\r` counts as one because some renderers treat it as a line ending.
 * Details come from a server's responses and error bodies, so treat them as data.
 */
export function escapeTableCell(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r\n|\r|\n/g, ' ');
}

export function renderReport(
  results: readonly CheckResult[],
  meta: { date: string; twentyVersion: string; baseUrl: string },
): string {
  const rows = results.map(
    (r) =>
      `| ${r.status} | \`${r.id}\` | ${escapeTableCell(r.title)} | ${escapeTableCell(r.detail)} |`,
  );
  const counts = (['PASS', 'FAIL', 'INFO', 'SKIP', 'MANUAL'] as const)
    .map((s) => `${results.filter((r) => r.status === s).length} ${s}`)
    .join(' · ');
  return [
    `### M0 run — ${meta.date} — Twenty ${meta.twentyVersion} — ${meta.baseUrl}`,
    '',
    counts,
    '',
    '| Status | Check | What it verifies | Observed |',
    '|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}
