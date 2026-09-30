// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FOLD_ID_NAMESPACE, id, isUuid, sha1, uid, uuidV5 } from '../src/index.js';

const nodeSha1 = (s: string) => new Uint8Array(createHash('sha1').update(s).digest());

describe('sha1', () => {
  it.each([
    '',
    'abc',
    'The quick brown fox jumps over the lazy dog',
    'a'.repeat(55),
    'a'.repeat(56),
    'a'.repeat(64),
    'é世界🙂',
  ])('matches node:crypto for %j', (s) => {
    expect(sha1(new TextEncoder().encode(s))).toEqual(nodeSha1(s));
  });

  it('property: agrees with node:crypto on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (s) => {
        expect(sha1(new TextEncoder().encode(s))).toEqual(nodeSha1(s));
      }),
      { numRuns: 300 },
    );
  });
});

describe('uuidV5', () => {
  const DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

  it('matches the reference vector (Python: uuid5(NAMESPACE_DNS, "python.org"))', () => {
    expect(uuidV5('python.org', DNS)).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
  });

  it('sets version 5 and the RFC 4122 variant', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (name) => {
        const u = uuidV5(name, DNS);
        expect(isUuid(u)).toBe(true);
        expect(u[14]).toBe('5');
        expect('89ab').toContain(u[19]);
      }),
    );
  });

  it('rejects a malformed namespace', () => {
    expect(() => uuidV5('x', 'not-a-uuid')).toThrow(RangeError);
  });

  it('is deterministic and namespace-sensitive', () => {
    expect(uuidV5('x', DNS)).toBe(uuidV5('x', DNS));
    expect(uuidV5('x', DNS)).not.toBe(uuidV5('x', randomUUID()));
  });
});

describe('universalIdentifier registry', () => {
  it('uses a valid namespace', () => {
    expect(isUuid(FOLD_ID_NAMESPACE)).toBe(true);
  });

  it('PINS known identifiers. If this fails you changed a key or the namespace: existing workspaces would orphan their data', () => {
    expect(uid('object.household')).toBe(uuidV5('object.household', FOLD_ID_NAMESPACE));
    expect({
      application: id.application(),
      followUp: id.object('followUp'),
      dueAt: id.field('followUp', 'dueAt'),
      lifecycleStage: id.field('person', 'lifecycleStage'),
    }).toMatchInlineSnapshot(`
      {
        "application": "e9d9ab0a-110c-5b69-98f8-983cf0cc8ed9",
        "dueAt": "1d27a6d5-87ab-57bd-a9ba-a33ee94a5c11",
        "followUp": "e711521b-27fd-513d-a41e-1d0826879156",
        "lifecycleStage": "0425eab9-b2d6-5f5c-872d-9aa97820f92d",
      }
    `);
  });

  it('rejects keys that do not look like registry keys', () => {
    for (const bad of [
      'household',
      'Object.household',
      'object.',
      'object.house hold',
      'object..x',
      '',
    ]) {
      expect(() => uid(bad)).toThrow(RangeError);
    }
  });

  it('gives different entities different identifiers', () => {
    const keys = [
      'object.a',
      'object.b',
      'field.a.x',
      'field.a.y',
      'field.b.x',
      'role.a',
      'view.a',
      'nav.a',
    ];
    expect(new Set(keys.map(uid)).size).toBe(keys.length);
  });
});
