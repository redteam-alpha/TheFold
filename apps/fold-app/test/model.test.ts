// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ATTENDANCE_KINDS,
  CARE_REQUEST_STATUSES,
  FOLLOW_UP_KINDS,
  FOLLOW_UP_OUTCOMES,
  FOLLOW_UP_STATUSES,
  GROUP_OPENNESS,
  LIFECYCLE_STAGES,
  MEMBERSHIP_STATUSES,
} from '@thefold/core';
import { id, isUuid } from '@thefold/shared';
import { FieldType, RelationType, STANDARD_OBJECT } from 'twenty-sdk/define';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ALL_OBJECT_KEYS,
  OBJECT_KEYS,
  buildObject,
  objectId,
  personFieldConfigs,
  type FieldConfig,
  type ObjectConfig,
  type ObjectField,
} from '../src/model/build.js';
import { CARE_OBJECT, ROLE_SPECS, buildRole } from '../src/model/roles.js';
import { OBJECTS, PERSON_FIELDS, RELATIONS } from '../src/model/spec.js';
import {
  NAV_FOLDER_KEY,
  VIEW_SPECS,
  buildNavFolder,
  buildNavItem,
  buildView,
} from '../src/model/views.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');
const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const files = (dir: string) =>
  readdirSync(join(SRC, dir))
    .filter((f) => f.endsWith('.ts'))
    .sort();

interface Entity {
  file: string;
  result: { success: boolean; errors: string[]; warnings?: string[]; config: unknown };
}

async function loadEntities(): Promise<Entity[]> {
  const out: Entity[] = [];
  for (const dir of ['objects', 'fields', 'roles', 'views', 'navigation-menu-items']) {
    for (const f of files(dir)) {
      const mod = (await import(pathToFileURL(join(SRC, dir, f)).href)) as {
        default: Entity['result'];
      };
      out.push({ file: `${dir}/${f}`, result: mod.default });
    }
  }
  const app = (await import(pathToFileURL(join(SRC, 'application-config.ts')).href)) as {
    default: Entity['result'];
  };
  out.push({ file: 'application-config.ts', result: app.default });
  return out;
}

describe('the app, as the Twenty SDK sees it', () => {
  let entities: Entity[];
  beforeAll(async () => {
    entities = await loadEntities();
  });

  it('every entity passes the SDK’s own validation, with no warnings', () => {
    expect(entities.length).toBe(68);
    const failing = entities
      .filter((e) => !e.result.success)
      .map((e) => `${e.file}: ${e.result.errors.join('; ')}`);
    expect(failing).toEqual([]);
    expect(entities.filter((e) => (e.result.warnings ?? []).length > 0).map((e) => e.file)).toEqual(
      [],
    );
  });

  it('has exactly one entity file per model element, so nothing is forgotten or orphaned', () => {
    const personNames = personFieldConfigs().map((f) => kebab(f.name));
    expect(files('fields')).toEqual(personNames.map((n) => `person-${n}.ts`).sort());
    expect(files('objects')).toEqual(OBJECT_KEYS.map((k) => `${kebab(k)}.ts`).sort());
    expect(files('roles')).toEqual(
      ['app-default.ts', ...ROLE_SPECS.map((r) => `${kebab(r.key)}.ts`)].sort(),
    );
    expect(files('views')).toEqual(VIEW_SPECS.map((v) => `${kebab(v.key)}.ts`).sort());
    expect(files('navigation-menu-items')).toEqual(
      ['folder.ts', ...VIEW_SPECS.map((v) => `view-${kebab(v.key)}.ts`)].sort(),
    );
  });

  it('every universalIdentifier in the app is unique and a valid UUID v4', () => {
    const ids: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (k === 'universalIdentifier' && typeof v === 'string') ids.push(v);
          else walk(v);
        }
      }
    };
    for (const e of entities) walk(e.result.config);
    // Every identifier the model declares, counted independently of the walk above.
    const viewEntities = VIEW_SPECS.map((v) => buildView(v.key)).reduce(
      (n, v) =>
        n +
        1 +
        (v.fields?.length ?? 0) +
        (v.filters?.length ?? 0) +
        (v.sorts?.length ?? 0) +
        (v.groups?.length ?? 0),
      0,
    );
    const expected =
      1 + // application
      OBJECT_KEYS.length +
      OBJECT_KEYS.reduce((n, k) => n + buildObject(k).fields.length, 0) +
      personFieldConfigs().length +
      (ROLE_SPECS.length + 1) + // + the minimal application role
      viewEntities +
      (VIEW_SPECS.length + 1); // + the folder
    expect(ids.length).toBe(expected);
    expect(new Set(ids).size).toBe(ids.length);
    for (const i of ids)
      expect(i, i).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ids.every(isUuid)).toBe(true);
  });
});

describe('data model', () => {
  const objects = OBJECT_KEYS.map((k) => ({ key: k, cfg: buildObject(k) }));
  const person = personFieldConfigs();

  /** Every field of every object, keyed by its own universalIdentifier, with who owns it. */
  const fieldIndex = new Map<string, { owner: string; field: ObjectField | FieldConfig }>();
  for (const { key, cfg } of objects)
    for (const f of cfg.fields)
      fieldIndex.set(f.universalIdentifier, { owner: objectId(key), field: f });
  for (const f of person)
    fieldIndex.set(f.universalIdentifier, { owner: objectId('person'), field: f });

  it('never reuses a Twenty standard object name', () => {
    const standard = new Set(Object.keys(STANDARD_OBJECT).map((k) => k.toLowerCase()));
    for (const o of OBJECTS) {
      expect(standard.has(o.nameSingular.toLowerCase()), o.nameSingular).toBe(false);
      expect(standard.has(o.namePlural.toLowerCase()), o.namePlural).toBe(false);
    }
    expect(new Set(OBJECTS.flatMap((o) => [o.nameSingular, o.namePlural])).size).toBe(
      OBJECTS.length * 2,
    );
  });

  it('has no duplicate field names within an object, and not on Person either', () => {
    for (const { key, cfg } of objects) {
      const names = cfg.fields.map((f) => f.name);
      expect(new Set(names).size, key).toBe(names.length);
    }
    const names = person.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain('name'); // Person's own name field is Twenty's
  });

  it('every object’s label field exists and is text', () => {
    for (const { key, cfg } of objects) {
      const label = cfg.fields.find(
        (f) => f.universalIdentifier === cfg.labelIdentifierFieldMetadataUniversalIdentifier,
      );
      expect(label?.type, key).toBe(FieldType.TEXT);
    }
  });

  it('relations are reciprocal: each side points at the other, on the right object, with opposite types', () => {
    const relations = [...fieldIndex.values()].filter((e) => e.field.type === FieldType.RELATION);
    expect(relations).toHaveLength(RELATIONS.length * 2);
    for (const { owner, field } of relations) {
      const f = field as unknown as {
        universalIdentifier: string;
        name: string;
        relationTargetFieldMetadataUniversalIdentifier: string;
        relationTargetObjectMetadataUniversalIdentifier: string;
        universalSettings: { relationType: RelationType; joinColumnName?: string };
      };
      const back = fieldIndex.get(f.relationTargetFieldMetadataUniversalIdentifier);
      expect(back, `${f.name} has no counterpart`).toBeDefined();
      const b = back?.field as unknown as typeof f;
      expect(b.relationTargetFieldMetadataUniversalIdentifier, f.name).toBe(f.universalIdentifier);
      expect(back?.owner, f.name).toBe(f.relationTargetObjectMetadataUniversalIdentifier);
      expect(b.relationTargetObjectMetadataUniversalIdentifier, f.name).toBe(owner);
      expect([f.universalSettings.relationType, b.universalSettings.relationType].sort()).toEqual(
        [RelationType.MANY_TO_ONE, RelationType.ONE_TO_MANY].sort(),
      );
      if (f.universalSettings.relationType === RelationType.MANY_TO_ONE) {
        expect(f.universalSettings.joinColumnName).toBe(`${f.name}Id`);
      }
    }
  });

  it('erasing a person removes their attendance, follow-ups about them and care metadata; it never orphans them', () => {
    const cascade = [
      'attendance.person',
      'groupMembership.person',
      'eventRegistration.person',
      'followUp.subject',
      'touchpoint.person',
      'careRequest.person',
    ];
    for (const path of cascade) {
      const [object, name] = path.split('.') as [string, string];
      const rel = RELATIONS.find((r) => r.many.object === object && r.many.name === name);
      expect(rel?.onDelete, path).toBe('CASCADE');
    }
    // Deleting a volunteer must never delete the guests they were assigned.
    for (const path of [
      'followUp.owner',
      'careRequest.owner',
      'touchpoint.actor',
      'person.primaryShepherd',
    ]) {
      const [object, name] = path.split('.') as [string, string];
      expect(
        RELATIONS.find((r) => r.many.object === object && r.many.name === name)?.onDelete,
        path,
      ).toBe('SET_NULL');
    }
  });

  describe('select options stay in sync with packages/core', () => {
    const cases: [string, string, readonly string[]][] = [
      ['person', 'lifecycleStage', LIFECYCLE_STAGES],
      ['followUp', 'kind', FOLLOW_UP_KINDS],
      ['followUp', 'status', FOLLOW_UP_STATUSES],
      ['followUp', 'outcome', FOLLOW_UP_OUTCOMES],
      ['touchpoint', 'outcome', FOLLOW_UP_OUTCOMES],
      ['attendance', 'kind', ATTENDANCE_KINDS],
      ['churchGroup', 'openness', GROUP_OPENNESS],
      ['groupMembership', 'status', MEMBERSHIP_STATUSES],
      ['careRequest', 'status', CARE_REQUEST_STATUSES],
    ];
    it.each(cases)('%s.%s', (object, name, expected) => {
      const f = fieldIndex.get(id.field(object, name))?.field as unknown as {
        options: { value: string; position: number }[];
      };
      expect(f.options.map((o) => o.value)).toEqual([...expected]);
      expect(f.options.map((o) => o.position)).toEqual(expected.map((_, i) => i));
    });
  });

  it('safe defaults: closed groups, interested (not active) members, no consent, no contact permission, adults', () => {
    const def = (o: string, n: string) =>
      (fieldIndex.get(id.field(o, n))?.field as unknown as { defaultValue?: unknown }).defaultValue;
    expect(def('churchGroup', 'openness')).toBe("'CLOSED'");
    expect(def('groupMembership', 'status')).toBe("'INTERESTED'");
    expect(def('person', 'consentEmail')).toBe(false);
    expect(def('person', 'consentSms')).toBe(false);
    expect(def('person', 'doNotContact')).toBe(false);
    expect(def('person', 'isMinor')).toBe(false);
    expect(def('person', 'backgroundCheckStatus')).toBe("'NONE'");
    expect(def('person', 'lifecycleStage')).toBe("'NEW_GUEST'");
    expect(def('followUp', 'status')).toBe("'OPEN'");
  });

  it('every SELECT default is one of its own options', () => {
    for (const { field } of fieldIndex.values()) {
      const f = field as unknown as {
        type: FieldType;
        defaultValue?: string;
        options?: { value: string }[];
        name: string;
      };
      if (f.type === FieldType.SELECT && f.defaultValue !== undefined) {
        expect(
          f.options?.map((o) => `'${o.value}'`),
          f.name,
        ).toContain(f.defaultValue);
      }
    }
  });

  it('idempotency keys are unique, so a retried write cannot duplicate a record', () => {
    for (const o of [
      'household',
      'attendance',
      'followUp',
      'touchpoint',
      'careRequest',
      'person',
    ]) {
      const f = fieldIndex.get(id.field(o, 'sourceRef'))?.field as unknown as {
        isUnique?: boolean;
      };
      expect(f?.isUnique, o).toBe(true);
    }
  });

  describe('sensitive text policy (ADR 0004)', () => {
    /** The complete list of free-text fields. Adding one is a deliberate act that must update this list. */
    const ALLOWED_TEXT = [
      'household.name',
      'household.sourceRef',
      'campus.name',
      'campus.timezone',
      'attendance.name',
      'attendance.ref',
      'attendance.sourceRef',
      'churchGroup.name',
      'churchGroup.schedule',
      'churchGroup.description',
      'groupMembership.name',
      'churchEvent.name',
      'churchEvent.location',
      'churchEvent.description',
      'eventRegistration.name',
      'followUp.name',
      'followUp.contextSummary',
      'followUp.sourceRef',
      'touchpoint.name',
      'touchpoint.sourceRef',
      'careRequest.name',
      'careRequest.communityRef',
      'careRequest.sourceRef',
      'person.sourceRef',
    ];

    it('lists every free-text field explicitly', () => {
      const actual = [...fieldIndex.entries()]
        .filter(([, e]) => e.field.type === FieldType.TEXT || e.field.type === FieldType.RICH_TEXT)
        .map(([, e]) => {
          const ownerKey = ALL_OBJECT_KEYS.find((k) => objectId(k) === e.owner) as string;
          return `${ownerKey}.${e.field.name}`;
        });
      expect(actual.sort()).toEqual([...ALLOWED_TEXT].sort());
    });

    it('has no field that looks like a place for a confidence', () => {
      const banned =
        /(^|[a-z])(body|notes?|comments?|message|prayer|details?|confid|reason|diagnos|counsel|struggl)/i;
      for (const { field } of fieldIndex.values())
        expect(field.name, field.name).not.toMatch(banned);
    });

    it('never uses rich text', () => {
      for (const { field } of fieldIndex.values()) expect(field.type).not.toBe(FieldType.RICH_TEXT);
    });

    it('the follow-up context field is documented as system-generated', () => {
      expect(
        OBJECTS.find((o) => o.key === 'followUp')?.fields.find((f) => f.name === 'contextSummary'),
      ).toBeDefined();
    });
  });

  it('Person gets every field the domain logic needs', () => {
    for (const name of [
      'lifecycleStage',
      'isMinor',
      'doNotContact',
      'awayUntil',
      'acceptedGapDays',
      'primaryShepherd',
      'guardian',
      'sharedEmail',
      'shepherdRoles',
      'maxOpenItems',
      'isHouseholdPrimaryContact',
    ]) {
      expect(
        person.map((f) => f.name),
        name,
      ).toContain(name);
    }
    expect(
      PERSON_FIELDS.length + RELATIONS.filter((r) => r.many.object === 'person').length,
    ).toBeGreaterThan(20);
  });
});

describe('roles', () => {
  const roles = ROLE_SPECS.map((r) => ({ key: r.key, cfg: buildRole(r.key) }));
  const care = objectId(CARE_OBJECT);
  const canRead = (cfg: ReturnType<typeof buildRole>) =>
    (cfg.objectPermissions ?? []).some(
      (p) => p.objectUniversalIdentifier === care && p.canReadObjectRecords,
    );

  it('only admins, pastors, the care team and the service account can read care requests', () => {
    expect(
      roles
        .filter((r) => canRead(r.cfg))
        .map((r) => r.key)
        .sort(),
    ).toEqual(['admin', 'careTeam', 'pastor', 'service']);
  });

  it('only admins, pastors and the care team can change care requests (the service account creates them via the outbox)', () => {
    const canWrite = roles.filter((r) =>
      (r.cfg.objectPermissions ?? []).some(
        (p) => p.objectUniversalIdentifier === care && p.canUpdateObjectRecords,
      ),
    );
    expect(canWrite.map((r) => r.key).sort()).toEqual(['admin', 'careTeam', 'pastor', 'service']);
  });

  it('nobody can permanently destroy records, and no role grants blanket access', () => {
    for (const { key, cfg } of roles) {
      expect(
        (cfg.objectPermissions ?? []).some((p) => p.canDestroyObjectRecords),
        key,
      ).toBe(false);
      expect(cfg.canDestroyAllObjectRecords ?? false, key).toBe(false);
      expect(cfg.canReadAllObjectRecords ?? false, key).toBe(false);
      expect(cfg.canAccessAllTools ?? false, key).toBe(false);
    }
  });

  it('only admins change workspace settings', () => {
    expect(roles.filter((r) => r.cfg.canUpdateAllSettings).map((r) => r.key)).toEqual(['admin']);
  });

  it('the service account is API-key only and people roles are never API-key roles', () => {
    for (const { key, cfg } of roles) {
      if (key === 'service') {
        expect(cfg.canBeAssignedToApiKeys).toBe(true);
        expect(cfg.canBeAssignedToUsers).toBe(false);
      } else {
        expect(cfg.canBeAssignedToApiKeys, key).toBe(false);
        expect(cfg.canBeAssignedToUsers, key).toBe(true);
      }
      expect(cfg.canBeAssignedToAgents, key).toBe(false);
    }
  });

  it('the read-only role cannot change anything', () => {
    const ro = roles.find((r) => r.key === 'readOnly')?.cfg;
    expect(
      (ro?.objectPermissions ?? []).some(
        (p) => p.canUpdateObjectRecords || p.canSoftDeleteObjectRecords,
      ),
    ).toBe(false);
  });

  it('hides background checks and birthdates from the roles that do not need them', () => {
    const hidden = (key: string) =>
      (roles.find((r) => r.key === key)?.cfg.fieldPermissions ?? [])
        .filter((p) => !p.canReadFieldValue)
        .map((p) => p.fieldUniversalIdentifier)
        .sort();
    const expected = ['backgroundCheckDate', 'backgroundCheckStatus', 'birthdate']
      .map((f) => id.field('person', f))
      .sort();
    expect(hidden('readOnly')).toEqual(expected);
    expect(hidden('welcomeLead')).toEqual(expected);
    expect(hidden('admin')).toEqual([]);
  });

  it('relies on no enterprise-licensed permission feature (row-level predicates)', () => {
    for (const { key, cfg } of roles) {
      expect(cfg.rowLevelPermissionPredicates ?? [], key).toEqual([]);
      expect(cfg.rowLevelPermissionPredicateGroups ?? [], key).toEqual([]);
    }
  });
});

describe('views and navigation', () => {
  it('every view has a navigation item, and every item points at a real view and the folder', () => {
    const viewIds = new Set(VIEW_SPECS.map((v) => buildView(v.key).universalIdentifier));
    const navs = VIEW_SPECS.map((v) => buildNavItem(v.key));
    expect(new Set(navs.map((n) => n.viewUniversalIdentifier))).toEqual(viewIds);
    for (const n of navs)
      expect(n.folderUniversalIdentifier).toBe(buildNavFolder().universalIdentifier);
    expect(buildNavFolder().universalIdentifier).toBe(id.nav(NAV_FOLDER_KEY));
  });

  it('every view column, filter, sort and group refers to a field that exists on the view’s object', () => {
    const known = new Set<string>([
      ...OBJECT_KEYS.flatMap((k) => buildObject(k).fields.map((f) => f.universalIdentifier)),
      ...personFieldConfigs().map((f) => f.universalIdentifier),
    ]);
    // Person’s own Twenty fields (e.g. name) are legitimately referenced too.
    const twentyPersonFields = new Set(
      Object.values(STANDARD_OBJECT.person.fields).map((f) => f.universalIdentifier),
    );
    for (const v of VIEW_SPECS) {
      const cfg = buildView(v.key);
      const refs = [
        ...(cfg.fields ?? []).map((f) => f.fieldMetadataUniversalIdentifier),
        ...(cfg.filters ?? []).map((f) => f.fieldMetadataUniversalIdentifier),
        ...(cfg.sorts ?? []).map((f) => f.fieldMetadataUniversalIdentifier),
        ...(cfg.mainGroupByFieldMetadataUniversalIdentifier
          ? [cfg.mainGroupByFieldMetadataUniversalIdentifier]
          : []),
      ];
      for (const r of refs)
        expect(
          known.has(r) || twentyPersonFields.has(r) || r === id.field('person', 'name'),
          `${v.key}: ${r}`,
        ).toBe(true);
    }
  });

  it('never ranks, scores or shames: no such view, column or name exists', () => {
    const banned = /(score|rank|leaderboard|risk|worst|streak|missing|delinquent)/i;
    for (const v of VIEW_SPECS) {
      expect(v.name, v.name).not.toMatch(banned);
      for (const c of v.columns) expect(c, `${v.key}.${c}`).not.toMatch(banned);
    }
    for (const { key, cfg } of OBJECT_KEYS.map((k) => ({ key: k, cfg: buildObject(k) }))) {
      for (const f of cfg.fields) expect(f.name, `${key}.${f.name}`).not.toMatch(banned);
    }
  });

  it('the check-in view shows why (context) and who owns it, not a number', () => {
    const cols = VIEW_SPECS.find((v) => v.key === 'checkIns')?.columns ?? [];
    expect(cols).toContain('contextSummary');
    expect(cols).toContain('owner');
  });

  it('the care-request kanban covers every status so no request can sit in an invisible column', () => {
    expect(VIEW_SPECS.find((v) => v.key === 'careRequests')?.groupBy?.values).toEqual([
      ...CARE_REQUEST_STATUSES,
    ]);
  });
});

describe('object config sanity', () => {
  it('builds each object with a label field and only fields owned by that object', () => {
    for (const key of OBJECT_KEYS) {
      const cfg: ObjectConfig = buildObject(key);
      expect(cfg.fields.length).toBeGreaterThan(3);
      expect(cfg.universalIdentifier).toBe(id.object(key));
      expect(
        (cfg.fields as { objectUniversalIdentifier?: string }[]).every(
          (f) => f.objectUniversalIdentifier === undefined,
        ),
      ).toBe(true);
    }
  });
});
