// SPDX-License-Identifier: AGPL-3.0-or-later
// Fails if a tracked source file is missing the AGPL SPDX header in its first 5 lines.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const EXTENSIONS = /\.(ts|tsx|js|mjs|cjs|sql|sh)$/;
const REQUIRED = 'SPDX-License-Identifier: AGPL-3.0-or-later';
const EXEMPT = [/^pnpm-lock\.yaml$/, /(^|\/)\.twenty\//, /(^|\/)dist\//];

const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);

const missing = [];
for (const file of tracked) {
  if (!EXTENSIONS.test(file) || EXEMPT.some((re) => re.test(file))) continue;
  let head;
  try {
    head = readFileSync(file, 'utf8').split('\n', 5).join('\n');
  } catch {
    continue; // deleted in the working tree
  }
  if (!head.includes(REQUIRED)) missing.push(file);
}

if (missing.length > 0) {
  console.error(`Missing "${REQUIRED}" header in:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `SPDX header OK (${tracked.filter((f) => EXTENSIONS.test(f)).length} source files checked)`,
);
