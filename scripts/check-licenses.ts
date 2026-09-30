// SPDX-License-Identifier: AGPL-3.0-or-later
// Fails the build if any dependency (dev or prod) has a license that is denied or not yet reviewed.
import { execFileSync } from 'node:child_process';
import { evaluateLicense } from './lib/licensePolicy.js';

interface PnpmLicensePkg {
  name: string;
  versions?: string[];
}

const raw = execFileSync('pnpm', ['licenses', 'list', '--json'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const groups = JSON.parse(raw) as Record<string, PnpmLicensePkg[]>;

const problems: string[] = [];
let checked = 0;
for (const [license, packages] of Object.entries(groups)) {
  for (const pkg of packages) {
    checked++;
    const verdict = evaluateLicense(license, pkg.name);
    if (!verdict.ok) problems.push(`${pkg.name} (${license}): ${verdict.reason}`);
  }
}

if (problems.length > 0) {
  console.error(
    `License check failed for ${problems.length} package(s):\n  ${problems.join('\n  ')}`,
  );
  console.error(
    '\nIf a license is fine, add it to scripts/lib/licensePolicy.ts with a reason. If not, replace the dependency (ADR 0005).',
  );
  process.exit(1);
}
console.log(`License check OK (${checked} packages)`);
