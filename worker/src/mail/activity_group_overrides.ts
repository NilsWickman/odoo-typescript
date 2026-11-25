/**
 * Installed overrides of `res.users._get_activity_groups` (mail/models/res_users.py:512), applied to the groups
 * mail's own method built (menu.ts). They commute, so their load order does not matter:
 *  - contacts/models/res_users.py: res.partner groups take the contacts app icon;
 *  - project_todo/models/res_users.py: the project.task group is split into "To-Do" (no project) and "Task";
 *  - calendar/models/res_users.py:157-180: an "Upcoming Meetings" group first when the user has meetings today
 *    (`_systray_get_calendar_event_domain`, :92-155).
 * Kept apart from menu.ts (stream MAIL) by stream CRM for the poc_erp template.
 */
import { NotPorted } from '../errors';
import { and, cond, or } from '../orm/domain';
import { userInfo } from '../orm/env';
import type { Environment } from '../orm/types';
import { translate } from '../models/util';
import type { Activity } from './menu';

type Group = Record<string, unknown>;
type Format = (name: string, list: Activity[]) => Promise<Group>;

function installed(env: Environment, module: string): boolean {
  return env.reg.model('res.users').modules?.includes(module) ?? false;
}

export async function applyActivityGroupOverrides(env: Environment, groups: Group[], grouped: ReadonlyMap<string, Activity[]>, format: Format): Promise<Group[]> {
  let out = [...groups];
  if (installed(env, 'contacts')) {
    // Manifest.for_addon('contacts').icon
    for (const g of out) if (g['model'] === 'res.partner') g['icon'] = '/contacts/static/description/icon.png';
  }
  if (installed(env, 'project_todo')) out = await splitTodo(env, out, grouped, format);
  if (installed(env, 'calendar')) {
    const meetings = await upcomingMeetings(env);
    if (meetings) out.unshift(meetings);
  }
  return out;
}

/** project_todo/models/res_users.py `_get_activity_groups`. */
async function splitTodo(env: Environment, groups: Group[], grouped: ReadonlyMap<string, Activity[]>, format: Format): Promise<Group[]> {
  const index = groups.findIndex((g) => g['model'] === 'project.task');
  if (index < 0) return groups;
  const out = groups.filter((_, i) => i !== index);
  const list = grouped.get('project.task') ?? [];
  const taskIds = [...new Set(list.map((a) => a.res_id).filter((id): id is number => id !== null))];
  const rows = await env.cr.query<{ id: number; project_id: number | null }>('SELECT id, project_id FROM project_task WHERE id = ANY($1::int[])', [taskIds]);
  const withProject = new Map(rows.rows.map((r) => [r.id, r.project_id !== null]));
  const todo = list.filter((a) => !(a.res_id !== null && withProject.get(a.res_id)));
  const tasks = list.filter((a) => a.res_id !== null && withProject.get(a.res_id));
  if (todo.length > 0) {
    const g = await format('project.task', todo);
    Object.assign(g, {
      name: translate(env, 'To-Do'), is_todo: true, icon: '/project_todo/static/description/icon.png',
      domain: [['active', 'in', [true, false]], ['project_id', '=', false]],
    });
    out.push(g);
  }
  if (tasks.length > 0) {
    const g = await format('project.task', tasks);
    Object.assign(g, { is_todo: false, domain: [['active', 'in', [true, false]], ['project_id', '!=', false]] });
    out.push(g);
  }
  return out;
}

/** calendar/models/res_users.py:92-155 `_systray_get_calendar_event_domain` and the search at :160-165. */
async function upcomingMeetings(env: Environment): Promise<Group | null> {
  const self = await userInfo(env);
  const tz = self.tz || null;
  const t = (await env.cr.query<{ start_utc: string; stop_utc: string; start_date: string }>(
    `SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS start_utc,
            to_char(((((now() AT TIME ZONE COALESCE($1, 'UTC'))::date + time '23:59:59.999999') AT TIME ZONE COALESCE($1, 'UTC')) AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS') AS stop_utc,
            to_char((now() AT TIME ZONE COALESCE($1, 'UTC'))::date, 'YYYY-MM-DD') AS start_date`, [tz])).rows[0]!;
  const attendees = await env.model('calendar.attendee').search(and([cond('partner_id', '=', self.partnerId), cond('state', '!=', 'declined')]));
  const domain = and([
    cond('alarm_ids', '!=', false),
    cond('attendee_ids', 'in', attendees),
    or([
      and([cond('allday', '=', true), cond('start_date', '=', t.start_date)]),
      and([or([cond('start', '>=', t.start_utc), cond('stop', '>=', t.start_utc)]), cond('start', '<=', t.stop_utc)]),
    ]),
  ]);
  const meetings = await env.model('calendar.event').search(domain, { order: 'start', limit: 2 });
  if (!meetings.length) return null;
  if (env.lang && env.lang !== 'en_US') throw new NotPorted(`translated "Upcoming Meetings" (${env.lang})`);
  // calendar/models/res_users.py:161-180, `search_read(['id', 'start', 'name', 'allday'])`
  const read = await env.model('calendar.event').read(meetings, ['start', 'name', 'allday'], '');
  const model = (await env.cr.query<{ id: number }>("SELECT id FROM ir_model WHERE model = 'calendar.event'")).rows[0]?.id;
  return {
    id: model, type: 'meeting', name: 'Upcoming Meetings', is_today_meetings: true, model: 'calendar.event', icon: '/calendar/static/description/icon.png',
    domain: [['active', 'in', [true, false]]], view_type: 'calendar',
    meetings: read.map((r) => ({ id: r['id'], start: r['start'], name: r['name'], allday: r['allday'] })),
  } as unknown as Group;
}
