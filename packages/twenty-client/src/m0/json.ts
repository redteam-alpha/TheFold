// SPDX-License-Identifier: AGPL-3.0-or-later

/** Reads `value.a.b.c` from an untrusted JSON document without throwing; `undefined` when any step is missing. */
export function dig(value: unknown, ...path: string[]): unknown {
  let node = value;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}
