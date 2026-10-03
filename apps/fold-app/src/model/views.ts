// SPDX-License-Identifier: AGPL-3.0-or-later
import { id, uid } from '@thefold/shared';
import { LIFECYCLE_STAGES, CARE_REQUEST_STATUSES } from '@thefold/core';
import {
  NavigationMenuItemType,
  STANDARD_OBJECT,
  ViewCalendarLayout,
  ViewFilterOperand,
  ViewSortDirection,
  ViewType,
  type ViewConfig,
  type defineNavigationMenuItem,
} from 'twenty-sdk/define';
import { PERSON, objectId } from './build.js';

export type NavConfig = Parameters<typeof defineNavigationMenuItem>[0];

const STANDARD_PERSON_FIELD_IDS: ReadonlyMap<string, string> = new Map(
  Object.entries(STANDARD_OBJECT.person.fields).map(([name, f]) => [name, f.universalIdentifier]),
);

/**
 * The id a view column, filter or sort points at. Person is Twenty's own object: its `name`, `emails`…
 * have Twenty's standard ids, and an id derived from our registry would name a field that does not exist
 * (the server answers "Field metadata not found"). Everything else is ours.
 */
export function viewFieldId(object: string, field: string): string {
  if (object === PERSON) {
    const standard = STANDARD_PERSON_FIELD_IDS.get(field);
    if (standard) return standard;
  }
  return id.field(object, field);
}

interface ViewSpec {
  key: string;
  name: string;
  object: string;
  icon: string;
  type: ViewType;
  columns: readonly string[];
  filters?: readonly { field: string; operand: ViewFilterOperand; value: string | string[] }[];
  sort?: { field: string; direction: ViewSortDirection };
  groupBy?: { field: string; values: readonly string[] };
  calendar?: { field: string };
}

const OPEN = ['OPEN', 'SNOOZED'];

/** Registry keys are alphanumeric segments: `IN_PROGRESS` becomes `inProgress`. */
const keySafe = (value: string): string =>
  value.toLowerCase().replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

/**
 * Views ask "who needs a human right now?", never "who is worst?". There is no ranking view, no score
 * column and no peer-visible "who's missing" list (docs/privacy-and-safety.md, "Never build").
 */
export const VIEW_SPECS: readonly ViewSpec[] = [
  {
    key: 'welcomeQueue',
    name: 'Welcome queue',
    object: 'followUp',
    icon: 'IconHandStop',
    type: ViewType.TABLE,
    columns: ['name', 'subject', 'owner', 'dueAt', 'status', 'firstActionAt'],
    filters: [
      { field: 'kind', operand: ViewFilterOperand.IS, value: ['WELCOME'] },
      { field: 'status', operand: ViewFilterOperand.IS, value: OPEN },
    ],
    sort: { field: 'dueAt', direction: ViewSortDirection.ASC },
  },
  {
    key: 'checkIns',
    name: 'Check-ins',
    object: 'followUp',
    icon: 'IconHeartHandshake',
    type: ViewType.TABLE,
    columns: ['name', 'subject', 'owner', 'kind', 'dueAt', 'contextSummary', 'status'],
    filters: [
      {
        field: 'kind',
        operand: ViewFilterOperand.IS,
        value: ['DRIFT_CHECKIN', 'PROMISED_CHECKIN', 'FOLLOW_UP'],
      },
      { field: 'status', operand: ViewFilterOperand.IS, value: OPEN },
    ],
    sort: { field: 'dueAt', direction: ViewSortDirection.ASC },
  },
  {
    key: 'peopleByStage',
    name: 'People by stage',
    object: 'person',
    icon: 'IconRoute',
    type: ViewType.KANBAN,
    columns: ['name', 'firstVisitDate', 'primaryShepherd'],
    groupBy: {
      field: 'lifecycleStage',
      values: LIFECYCLE_STAGES.filter((s) => s !== 'DECEASED' && s !== 'MOVED_AWAY'),
    },
  },
  {
    key: 'careRequests',
    name: 'Care requests',
    object: 'careRequest',
    icon: 'IconHeart',
    type: ViewType.KANBAN,
    columns: ['name', 'person', 'owner', 'priority', 'openedAt'],
    groupBy: { field: 'status', values: CARE_REQUEST_STATUSES },
  },
  {
    key: 'groups',
    name: 'Groups',
    object: 'churchGroup',
    icon: 'IconUsersGroup',
    type: ViewType.TABLE,
    columns: ['name', 'groupType', 'openness', 'schedule', 'capacity', 'childFriendly'],
    sort: { field: 'name', direction: ViewSortDirection.ASC },
  },
  {
    key: 'eventCalendar',
    name: 'Event calendar',
    object: 'churchEvent',
    icon: 'IconCalendarEvent',
    type: ViewType.CALENDAR,
    columns: ['name', 'startsAt', 'location', 'capacity'],
    calendar: { field: 'startsAt' },
  },
];

export function buildView(key: string): ViewConfig {
  const v = VIEW_SPECS.find((s) => s.key === key);
  if (!v) throw new Error(`Unknown view: ${key}`);
  const f = (field: string) => viewFieldId(v.object, field);
  return {
    universalIdentifier: id.view(v.key),
    name: v.name,
    objectUniversalIdentifier: objectId(v.object),
    type: v.type,
    icon: v.icon,
    fields: v.columns.map((c, position) => ({
      universalIdentifier: uid(`view.${v.key}.field.${c}`),
      fieldMetadataUniversalIdentifier: f(c),
      position,
      isVisible: true,
    })),
    ...(v.filters
      ? {
          filters: v.filters.map((flt) => ({
            universalIdentifier: uid(`view.${v.key}.filter.${flt.field}`),
            fieldMetadataUniversalIdentifier: f(flt.field),
            operand: flt.operand,
            value: flt.value,
          })),
        }
      : {}),
    ...(v.sort
      ? {
          sorts: [
            {
              universalIdentifier: uid(`view.${v.key}.sort.${v.sort.field}`),
              fieldMetadataUniversalIdentifier: f(v.sort.field),
              direction: v.sort.direction,
            },
          ],
        }
      : {}),
    ...(v.groupBy
      ? {
          mainGroupByFieldMetadataUniversalIdentifier: f(v.groupBy.field),
          groups: v.groupBy.values.map((fieldValue, position) => ({
            universalIdentifier: uid(`view.${v.key}.group.${keySafe(fieldValue)}`),
            fieldValue,
            position,
          })),
        }
      : {}),
    ...(v.calendar
      ? {
          calendarLayout: ViewCalendarLayout.MONTH,
          calendarFieldMetadataUniversalIdentifier: f(v.calendar.field),
        }
      : {}),
  };
}

export const NAV_FOLDER_KEY = 'theFold';

/** A view is invisible in the sidebar unless a navigation item points at it (the SDK scaffold warns about this). */
export function buildNavFolder(): NavConfig {
  return {
    universalIdentifier: id.nav(NAV_FOLDER_KEY),
    type: NavigationMenuItemType.FOLDER,
    name: 'The Fold',
    icon: 'IconHeartHandshake',
    position: 0,
  };
}

export function buildNavItem(viewKey: string): NavConfig {
  const v = VIEW_SPECS.find((s) => s.key === viewKey);
  if (!v) throw new Error(`Unknown view: ${viewKey}`);
  return {
    universalIdentifier: id.nav(`view.${v.key}`),
    type: NavigationMenuItemType.VIEW,
    name: v.name,
    icon: v.icon,
    position: VIEW_SPECS.indexOf(v),
    viewUniversalIdentifier: id.view(v.key),
    folderUniversalIdentifier: id.nav(NAV_FOLDER_KEY),
  };
}
