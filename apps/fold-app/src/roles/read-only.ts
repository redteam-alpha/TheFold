// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineRole } from 'twenty-sdk/define';
import { buildRole } from '../model/roles.js';

export default defineRole(buildRole('readOnly'));
