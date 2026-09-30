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
const results = await runM0({
  client,
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
