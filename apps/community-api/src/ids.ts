// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';

let lastMs = 0;
let sequence = 0;

/**
 * RFC 9562 UUIDv7: 48-bit millisecond timestamp, then random bits. Ids sort by creation time, which
 * is what makes keyset pagination on `id DESC` a chronological feed. Strictly increasing within a
 * process even inside one millisecond (the 12-bit `rand_a` field carries a counter).
 */
export function uuidv7(
  nowMs: number = Date.now(),
  random: (n: number) => Uint8Array = randomBytes,
): string {
  if (nowMs > lastMs) {
    lastMs = nowMs;
    sequence = random(2).reduce((acc, b) => ((acc << 8) | b) & 0x7ff, 0); // leave headroom for increments
  } else {
    sequence++;
    if (sequence > 0xfff) {
      lastMs++;
      sequence = 0;
    }
  }
  const r = random(8);
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, Math.floor(lastMs / 0x10000));
  view.setUint16(4, lastMs % 0x10000);
  view.setUint16(6, 0x7000 | sequence);
  bytes.set(r, 8);
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
