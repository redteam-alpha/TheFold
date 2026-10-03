// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineNavigationMenuItem } from 'twenty-sdk/define';
import { buildNavFolder } from '../model/views.js';

export default defineNavigationMenuItem(buildNavFolder());
