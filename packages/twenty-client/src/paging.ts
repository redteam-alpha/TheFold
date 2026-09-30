// SPDX-License-Identifier: AGPL-3.0-or-later

/** Twenty's batch endpoints accept at most 60 records. */
export const MAX_BATCH = 60;

export function chunk<T>(items: readonly T[], size: number = MAX_BATCH): T[][] {
  if (!Number.isInteger(size) || size < 1)
    throw new RangeError('chunk size must be a positive integer');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface Page<T> {
  items: T[];
  /** Null or undefined when this is the last page. */
  nextCursor?: string | null;
}

/**
 * Walks a cursor-paginated endpoint. Throws if the server hands back a cursor it already gave us
 * (a misbehaving endpoint must never turn into an infinite loop that eats the rate limit).
 */
export async function* paginate<T>(
  fetchPage: (cursor: string | null) => Promise<Page<T>>,
): AsyncGenerator<T[], void, void> {
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const page: Page<T> = await fetchPage(cursor);
    if (page.items.length > 0) yield page.items;
    const next = page.nextCursor ?? null;
    if (next === null) return;
    if (seen.has(next)) throw new Error(`Pagination cursor repeated: ${next}`);
    seen.add(next);
    cursor = next;
  }
}

export async function collect<T>(pages: AsyncGenerator<T[], void, void>): Promise<T[]> {
  const all: T[] = [];
  for await (const page of pages) all.push(...page);
  return all;
}
