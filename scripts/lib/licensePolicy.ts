// SPDX-License-Identifier: AGPL-3.0-or-later
// Which dependency licenses may be combined with an AGPL-3.0-or-later product. Not legal advice; the point
// is that nothing incompatible arrives silently (ADR 0005). Unknown licenses FAIL: a person must decide.

/** Permissive or weak-copyleft licenses that combine cleanly with the AGPL. */
export const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'BlueOak-1.0.0',
  'Python-2.0',
  'CC0-1.0',
  'CC-BY-4.0',
  'Unlicense',
  'MPL-2.0', // file-level copyleft; fine to depend on unmodified
  'Zlib',
  'AGPL-3.0',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'GPL-3.0',
  'GPL-3.0-only',
  'GPL-3.0-or-later', // combinable with the AGPL under AGPLv3 section 13
]);

/**
 * Licenses that are allowed only for named packages, with the reason. Keep this list short and explained.
 */
export const ALLOWED_FOR_PACKAGE: Record<string, { licenses: string[]; reason: string }> = {
  '@img/sharp-libvips-linux-x64': {
    licenses: ['LGPL-3.0-or-later'],
    reason:
      'prebuilt libvips loaded dynamically by sharp (a dependency of twenty-sdk tooling); not distributed by us',
  },
  '@img/sharp-libvips-linuxmusl-x64': { licenses: ['LGPL-3.0-or-later'], reason: 'as above' },
  '@img/sharp-libvips-darwin-arm64': { licenses: ['LGPL-3.0-or-later'], reason: 'as above' },
  '@img/sharp-libvips-darwin-x64': { licenses: ['LGPL-3.0-or-later'], reason: 'as above' },
};

/** Never acceptable, whatever the package: incompatible with the AGPL or with offering a SaaS. */
export const DENIED = [
  /\bCAL-1\.0\b/i,
  /cryptographic autonomy/i,
  /\bSSPL\b/i,
  /server side public/i,
  /\bBUSL\b/i,
  /business source/i,
  /commons[- ]clause/i,
  /\belastic/i,
  /sustainable use/i,
  /\bGPL-2\.0(-only)?\b(?!.*\bOR\b)/i,
  /\bAGPL-1/i,
  /UNLICENSED/i,
  /proprietary/i,
];

export interface Verdict {
  ok: boolean;
  reason: string;
}

/** Evaluates an SPDX-ish expression such as `(MIT OR CC0-1.0)` or `MIT AND BSD-3-Clause`. */
export function evaluateLicense(expression: string, packageName = ''): Verdict {
  const expr = expression.trim();
  if (!expr || /^unknown$/i.test(expr))
    return { ok: false, reason: 'no license declared: needs a human decision' };

  const denied = DENIED.find((re) => re.test(expr));
  if (denied) return { ok: false, reason: `matches the deny-list (${denied.source})` };

  const stripped = expr.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  // OR: any alternative that is acceptable is enough. AND: every part must be acceptable.
  const alternatives = stripped
    .split(/\s+OR\s+/i)
    .map((alt) => alt.split(/\s+AND\s+/i).map((s) => s.trim()));
  const named = ALLOWED_FOR_PACKAGE[packageName];
  const acceptable = (id: string) => ALLOWED.has(id) || (named?.licenses.includes(id) ?? false);
  const ok = alternatives.some((all) => all.every(acceptable));
  if (ok)
    return {
      ok: true,
      reason:
        named && !alternatives.some((all) => all.every((id) => ALLOWED.has(id)))
          ? named.reason
          : 'allowed',
    };
  const unknown = [...new Set(alternatives.flat().filter((id) => !acceptable(id)))];
  return { ok: false, reason: `not on the allow-list: ${unknown.join(', ')}` };
}
