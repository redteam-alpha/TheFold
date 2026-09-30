// SPDX-License-Identifier: AGPL-3.0-or-later
import { uuidV5 } from './uuid.js';

/**
 * Namespace for every `universalIdentifier` in The Fold's Twenty app.
 *
 * **Never change this value, and never rename a key once an app version has been installed in any
 * workspace.** Twenty tracks objects, fields, roles and views by these identifiers: changing one
 * makes Twenty treat the entity as a different one and can orphan or drop its data.
 * `test/identifiers.test.ts` pins several values so an accidental change fails CI.
 */
export const FOLD_ID_NAMESPACE = 'b9c89a89-447d-4794-ae1c-23278b1a3ff5';

/**
 * Stable identifier for an entity of the Twenty app, derived from a readable key such as
 * `object.household` or `field.followUp.dueAt`.
 */
export function uid(key: string): string {
  if (!/^[a-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)+$/.test(key)) {
    throw new RangeError(
      `Identifier keys look like "object.household" or "field.person.lifecycleStage": ${key}`,
    );
  }
  return uuidV5(key, FOLD_ID_NAMESPACE);
}

export const id = {
  application: () => uid('application.thefold'),
  object: (object: string) => uid(`object.${object}`),
  field: (object: string, field: string) => uid(`field.${object}.${field}`),
  role: (role: string) => uid(`role.${role}`),
  view: (view: string) => uid(`view.${view}`),
  nav: (item: string) => uid(`nav.${item}`),
} as const;
