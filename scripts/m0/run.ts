// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs the M0 checks against a real Twenty. See infra/README.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { renderReport, runM0, TwentyClient } from '../../packages/twenty-client/src/index.js';
import { personFieldConfigs } from '../../apps/fold-app/src/model/build.js';
import { OBJECTS } from '../../apps/fold-app/src/model/spec.js';

const baseUrl = process.env['FOLD_M0_BASE_URL'];
const apiKey = process.env['FOLD_M0_API_KEY'];
if (!baseUrl || !apiKey) {
  console.error('Set FOLD_M0_BASE_URL and FOLD_M0_API_KEY (see infra/README.md).');
  process.exit(2);
}

const client = new TwentyClient({ baseUrl, apiKey });

// The checks run as FOLD_M0_API_KEY: use the service-account key to test the least privilege the real services get.
// That role deliberately cannot read workspace metadata or delete people and households, so a second, admin key
// does those two jobs and nothing else. Without it, `app-installed` fails with a hint, and whatever the key may not
// delete is listed in the `cleanup` row of the report.
const adminKey = process.env['FOLD_M0_ADMIN_API_KEY'];
const adminClient = adminKey ? new TwentyClient({ baseUrl, apiKey: adminKey }) : undefined;
console.error(
  adminClient
    ? 'FOLD_M0_ADMIN_API_KEY reads workspace metadata and deletes test records; every check runs as FOLD_M0_API_KEY.'
    : 'FOLD_M0_ADMIN_API_KEY is not set: everything runs as FOLD_M0_API_KEY, and a restricted key cannot read metadata or delete test records (see the report).',
);

const results = await runM0({
  client,
  ...(adminClient ? { adminClient } : {}),
  baseUrl,
  apiKey,
  fetch,
  model: {
    objects: OBJECTS.map((o) => o.nameSingular),
    personFields: personFieldConfigs().map((f) => f.name),
  },
  env: process.env,
  log: (m) => console.error(m),
});

const report = renderReport(results, {
  date: new Date().toISOString().slice(0, 10),
  twentyVersion: process.env['FOLD_M0_TWENTY_VERSION'] ?? process.env['TWENTY_TAG'] ?? 'unknown',
  baseUrl,
});
mkdirSync('.tmp', { recursive: true });
writeFileSync('.tmp/m0-report.md', report);
console.log(report);
process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
