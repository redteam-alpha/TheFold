// SPDX-License-Identifier: AGPL-3.0-or-later
import { id } from '@thefold/shared';
import {
  FieldType,
  NumberDataType,
  OnDeleteAction,
  RelationType,
  STANDARD_OBJECT,
  type defineField,
  type defineObject,
} from 'twenty-sdk/define';
import {
  OBJECTS,
  PERSON_FIELDS,
  RELATIONS,
  type ObjectSpec,
  type RelationSpec,
  type ScalarSpec,
} from './spec.js';

export type ObjectConfig = Parameters<typeof defineObject>[0];
export type FieldConfig = Parameters<typeof defineField>[0];
export type ObjectField = ObjectConfig['fields'][number];

/** Twenty's built-in Person object; every other object is ours. */
export const PERSON = 'person';

/** The universalIdentifier of an object: Twenty's own for Person, derived from our key otherwise. */
export function objectId(key: string): string {
  return key === PERSON ? STANDARD_OBJECT.person.universalIdentifier : id.object(key);
}

export const humanize = (value: string): string => {
  const words = value.toLowerCase().split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** SELECT option lists in the SDK need a stable position and a readable label. */
const options = (values: readonly string[]) =>
  values.map((value, position) => ({ value, label: humanize(value), position }));

export function scalarField(objectKey: string, spec: ScalarSpec): ObjectField {
  const base = {
    universalIdentifier: id.field(objectKey, spec.name),
    name: spec.name,
    label: spec.label,
    ...(spec.icon ? { icon: spec.icon } : {}),
    ...(spec.unique ? { isUnique: true } : {}),
  };
  switch (spec.type) {
    case 'TEXT':
      return { ...base, type: FieldType.TEXT };
    case 'DATE':
      return { ...base, type: FieldType.DATE };
    case 'DATE_TIME':
      return { ...base, type: FieldType.DATE_TIME };
    case 'INT':
      return {
        ...base,
        type: FieldType.NUMBER,
        universalSettings: { dataType: NumberDataType.INT, decimals: 0 },
      };
    case 'ARRAY':
      return { ...base, type: FieldType.ARRAY };
    case 'ADDRESS':
      return { ...base, type: FieldType.ADDRESS };
    case 'BOOLEAN':
      return {
        ...base,
        type: FieldType.BOOLEAN,
        ...(typeof spec.default === 'boolean' ? { defaultValue: spec.default } : {}),
      };
    case 'SELECT':
      // Twenty stores a SELECT default as a quoted literal ("'OPEN'"). Confirmed in M0 (docs/verification-status.md).
      return {
        ...base,
        type: FieldType.SELECT,
        options: options(spec.options ?? []),
        ...(typeof spec.default === 'string' ? { defaultValue: `'${spec.default}'` } : {}),
      };
    case 'MULTI_SELECT':
      return { ...base, type: FieldType.MULTI_SELECT, options: options(spec.options ?? []) };
  }
}

export function relationField(r: RelationSpec, side: 'many' | 'one'): ObjectField {
  const self = r[side];
  const other = side === 'many' ? r.one : r.many;
  return {
    universalIdentifier: id.field(self.object, self.name),
    type: FieldType.RELATION,
    name: self.name,
    label: self.label,
    isNullable: true,
    relationTargetFieldMetadataUniversalIdentifier: id.field(other.object, other.name),
    relationTargetObjectMetadataUniversalIdentifier: objectId(other.object),
    universalSettings:
      side === 'many'
        ? {
            relationType: RelationType.MANY_TO_ONE,
            onDelete: OnDeleteAction[r.onDelete],
            joinColumnName: `${self.name}Id`,
          }
        : { relationType: RelationType.ONE_TO_MANY },
  };
}

/** Every relation field (either side) that lives on `objectKey`. */
export function relationFieldsFor(objectKey: string): ObjectField[] {
  return RELATIONS.flatMap((r) => [
    ...(r.many.object === objectKey ? [relationField(r, 'many')] : []),
    ...(r.one.object === objectKey ? [relationField(r, 'one')] : []),
  ]);
}

export function objectSpec(key: string): ObjectSpec {
  const spec = OBJECTS.find((o) => o.key === key);
  if (!spec) throw new Error(`Unknown object: ${key}`);
  return spec;
}

export function buildObject(key: string): ObjectConfig {
  const spec = objectSpec(key);
  return {
    universalIdentifier: id.object(key),
    nameSingular: spec.nameSingular,
    namePlural: spec.namePlural,
    labelSingular: spec.labelSingular,
    labelPlural: spec.labelPlural,
    description: spec.description,
    icon: spec.icon,
    labelIdentifierFieldMetadataUniversalIdentifier: id.field(key, 'name'),
    fields: [...spec.fields.map((f) => scalarField(key, f)), ...relationFieldsFor(key)],
  };
}

/** Fields added to Twenty's Person: our scalars and both halves of every relation that touches Person. */
export function personFieldConfigs(): FieldConfig[] {
  const fields = [
    ...PERSON_FIELDS.map((f) => scalarField(PERSON, f)),
    ...relationFieldsFor(PERSON),
  ];
  return fields.map((f) => ({ ...f, objectUniversalIdentifier: objectId(PERSON) }));
}

export const OBJECT_KEYS = OBJECTS.map((o) => o.key);
export const ALL_OBJECT_KEYS = [PERSON, ...OBJECT_KEYS] as const;

/** One Person field by name, for the one-field-per-file layout the SDK discovers. */
export function personField(name: string): FieldConfig {
  const f = personFieldConfigs().find((c) => c.name === name);
  if (!f) throw new Error(`Unknown Person field: ${name}`);
  return f;
}
