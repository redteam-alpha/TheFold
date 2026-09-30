// SPDX-License-Identifier: AGPL-3.0-or-later
import { id } from '@thefold/shared';
import { defineApplication } from 'twenty-sdk/define';

export default defineApplication({
  universalIdentifier: id.application(),
  displayName: 'The Fold',
  description:
    'Church CRM for welcoming, knowing and connecting people: newcomer follow-up, groups and events, care follow-through, and compassionate check-ins.',
});
