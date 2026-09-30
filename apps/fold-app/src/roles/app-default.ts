// SPDX-License-Identifier: AGPL-3.0-or-later
import { id } from '@thefold/shared';
import { defineApplicationRole } from 'twenty-sdk/define';

/**
 * The identity the app itself acts under. The Fold uses no logic functions (they are off by default in
 * production Twenty and unsandboxed when LOCAL), so this stays deliberately minimal: it reads nothing.
 * The community service uses an API key assigned the separate "service" role.
 */
export default defineApplicationRole({
  universalIdentifier: id.role('appDefault'),
  label: 'The Fold app (minimal)',
  description: 'Default role for The Fold app. Grants no data access.',
  canReadAllObjectRecords: false,
  canUpdateAllObjectRecords: false,
  canSoftDeleteAllObjectRecords: false,
  canDestroyAllObjectRecords: false,
});
