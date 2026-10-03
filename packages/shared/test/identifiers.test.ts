// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { deterministicUuid, FOLD_ID_NAMESPACE, id, isUuid, sha1, uid } from '../src/index.js';

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

describe('deterministicUuid', () => {
  const NS = 'b9c89a89-447d-4794-ae1c-23278b1a3ff5';
  const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('matches an independent implementation (Python hashlib, computed outside this repo)', () => {
    // python3: h = bytearray(hashlib.sha1(uuid.UUID(NS).bytes + name.encode()).digest()[:16]); h[6] = h[6]&15|0x40; h[8] = h[8]&63|0x80
    expect(deterministicUuid('application.thefold', NS)).toBe(
      'e9d9ab0a-110c-4b69-98f8-983cf0cc8ed9',
    );
    expect(deterministicUuid('object.followUp', NS)).toBe('e711521b-27fd-413d-a41e-1d0826879156');
    expect(deterministicUuid('field.followUp.dueAt', NS)).toBe(
      '1d27a6d5-87ab-47bd-a9ba-a33ee94a5c11',
    );
    expect(deterministicUuid('field.person.lifecycleStage', NS)).toBe(
      '0425eab9-b2d6-4f5c-872d-9aa97820f92d',
    );
  });

  it('always yields a valid UUID v4 (what Twenty’s tooling requires)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (name) => {
        expect(deterministicUuid(name, NS)).toMatch(V4);
      }),
    );
  });

  it('rejects a malformed namespace', () => {
    expect(() => deterministicUuid('x', 'not-a-uuid')).toThrow(RangeError);
  });

  it('is deterministic and namespace-sensitive', () => {
    expect(deterministicUuid('x', NS)).toBe(deterministicUuid('x', NS));
    expect(deterministicUuid('x', NS)).not.toBe(deterministicUuid('x', randomUUID()));
  });
});

describe('universalIdentifier registry', () => {
  it('uses a valid namespace', () => {
    expect(isUuid(FOLD_ID_NAMESPACE)).toBe(true);
  });

  it('PINS known identifiers. If this fails you changed a key or the namespace: existing workspaces would orphan their data', () => {
    expect({
      application: id.application(),
      followUp: id.object('followUp'),
      dueAt: id.field('followUp', 'dueAt'),
      lifecycleStage: id.field('person', 'lifecycleStage'),
    }).toEqual({
      application: 'e9d9ab0a-110c-4b69-98f8-983cf0cc8ed9',
      followUp: 'e711521b-27fd-413d-a41e-1d0826879156',
      dueAt: '1d27a6d5-87ab-47bd-a9ba-a33ee94a5c11',
      lifecycleStage: '0425eab9-b2d6-4f5c-872d-9aa97820f92d',
    });
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
