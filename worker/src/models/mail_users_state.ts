/**
 * `res.users.state` (odoo/addons/auth_signup/models/res_users.py:38-41 `_compute_state`), non-stored, tracked by
 * mail (tracking=4): 'inactive' when archived, 'active' once the user has a login (`login_date`, related to the
 * latest res.users.log, base res_users.py:222), else 'new'. Needed to snapshot res.users tracking (src/mail/tracking.ts).
 */
import { registerHooks } from '../orm/hooks';

registerHooks('res.users', {
  computed: {
    state: async (env, ids) => new Map((await env.cr.query<{ id: number; state: string }>(
      `SELECT u.id, CASE WHEN u.active IS NOT TRUE THEN 'inactive'
                         WHEN EXISTS (SELECT 1 FROM res_users_log l WHERE l.create_uid = u.id) THEN 'active' ELSE 'new' END AS state
         FROM res_users u WHERE u.id = ANY($1::int[])`, [ids])).rows.map(r => [r.id, r.state])),
  },
});
