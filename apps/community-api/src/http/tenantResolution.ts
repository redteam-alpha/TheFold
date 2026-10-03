// SPDX-License-Identifier: AGPL-3.0-or-later

const LABEL = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/**
 * Which church a request is for, from its Host header: `grace.thefold.app` → `grace` when the base domain is
 * `thefold.app`. A host that is not under the base domain (localhost, an IP, a single-church install's own
 * name) falls back to `fallback`. Anything else (the bare base domain, nested labels, junk) is no church.
 */
export function subdomainFromHost(
  host: string | undefined,
  baseDomain: string | null,
  fallback: string | null,
): string | null {
  if (!host) return fallback;
  const name = host.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (baseDomain) {
    const base = baseDomain.toLowerCase();
    if (name === base) return null;
    if (name.endsWith(`.${base}`)) {
      const label = name.slice(0, -(base.length + 1));
      return LABEL.test(label) ? label : null;
    }
  }
  return fallback;
}
