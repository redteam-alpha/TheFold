// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { evaluateLicense } from '../lib/licensePolicy.js';

const ok = (expr: string, pkg?: string) => evaluateLicense(expr, pkg).ok;

describe('licensePolicy', () => {
  it.each([
    'MIT',
    'Apache-2.0',
    'ISC',
    'BSD-3-Clause',
    'MPL-2.0',
    '0BSD',
    'BlueOak-1.0.0',
    'Python-2.0',
    'AGPL-3.0-or-later',
    'GPL-3.0-only',
  ])('allows %s', (l) => {
    expect(ok(l)).toBe(true);
  });

  it.each([
    'CAL-1.0',
    'Cryptographic Autonomy License 1.0',
    'SSPL-1.0',
    'Server Side Public License',
    'BUSL-1.1',
    'Business Source License 1.1',
    'Commons-Clause',
    'Elastic-2.0',
    'Sustainable Use License',
    'AGPL-1.0',
    'GPL-2.0-only',
    'UNLICENSED',
    'Proprietary',
  ])('denies %s', (l) => {
    expect(ok(l)).toBe(false);
  });

  it('denies anything the CAL-licensed OSSN would carry, so copying it in fails the build', () => {
    expect(evaluateLicense('CAL-1.0', 'opensource-socialnetwork').ok).toBe(false);
  });

  it('treats a missing or unknown license as a failure that needs a human', () => {
    for (const l of ['', 'unknown', 'UNKNOWN', 'SEE LICENSE IN LICENSE.txt', 'Some-Made-Up-1.0'])
      expect(ok(l), l).toBe(false);
  });

  it('understands OR (any acceptable alternative is enough) and AND (all parts must be)', () => {
    expect(ok('(MIT OR CC0-1.0)')).toBe(true);
    expect(ok('(GPL-2.0-only OR MIT)')).toBe(true);
    expect(ok('MIT AND BSD-3-Clause')).toBe(true);
    expect(ok('MIT AND Some-Made-Up-1.0')).toBe(false);
    expect(ok('(Some-Made-Up-1.0 OR Other-Unknown-2.0)')).toBe(false);
  });

  it('allows LGPL only for the named native-binary packages, with a reason', () => {
    expect(evaluateLicense('LGPL-3.0-or-later', '@img/sharp-libvips-linux-x64')).toMatchObject({
      ok: true,
    });
    expect(evaluateLicense('LGPL-3.0-or-later', '@img/sharp-libvips-linux-x64').reason).toMatch(
      /libvips/,
    );
    expect(ok('LGPL-3.0-or-later', 'some-other-package')).toBe(false);
  });
});
