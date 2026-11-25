/**
 * The Store fields of polls (odoo/addons/mail/models/mail_poll.py:41-46 `_store_poll_fields`, mail_poll_option.py:99-102
 * `_store_poll_option_fields`) with their computes: `winning_option_id` (mail_poll.py:28-39), `number_of_votes`
 * (mail_poll_option.py:52-60) and `vote_percentage` (:62-97, the largest remainder method).
 * `selected_by_self` only when the Store is the current user's own (`forCurrentUser`), not on a bus.
 * The same computes serve ORM reads of the fields (`computed` hooks).
 */
import { NotPorted } from '../errors';
import type { Environment } from '../orm/types';
import type { Store } from './store';
import { registerHooks } from '../orm/hooks';
import { userFlags } from '../session/user';

interface PollRow {
  id: number; allow_multiple_options: boolean | null; create_date: string | null; create_uid: number | null; end_message_id: number | null;
  poll_end_dt: string | null; poll_question: string; start_message_id: number;
}
interface OptionRow { id: number; poll_id: number; option_emoji: string | null; option_label: string; votes: number }

/** mail_poll_option.py:62-97 per poll: whole percentages by the largest remainder, ties not skewed. */
export function votePercentages(options: readonly { id: number; votes: number }[]): Map<number, number> {
  const total = options.reduce((s, o) => s + o.votes, 0);
  const data = options.map((o) => {
    const exact = total ? (100 * o.votes) / total : 0;
    const rounded = Math.trunc(exact);
    return { id: o.id, rounded, remainder: exact - rounded, votes: o.votes };
  });
  data.sort((a, b) => b.remainder - a.remainder || a.id - b.id);
  const totalRounded = data.reduce((s, d) => s + d.rounded, 0);
  for (let i = 0; i < 100 - totalRounded; i++) {
    if (i + 1 === data.length || data[i]!.votes === data[i + 1]!.votes) break;
    data[i]!.rounded += 1;
  }
  return new Map(data.map((d) => [d.id, d.rounded]));
}

/**
 * `store.add(polls, "_store_poll_fields", with_start_message_id=...)` for a Store sent on a bus (not the current
 * user's): `addMessage` adds a start message with `_store_message_fields`.
 */
export async function addPollFields(env: Environment, store: Store, pollIds: readonly number[], withStartMessage: boolean,
  addMessage: (id: number) => Promise<void>, forCurrentUser = false): Promise<void> {
  if (!pollIds.length) return;
  // mail_poll_option.py:99-102: `selected_by_self` when the Store is the current user's (:38-50, the user's votes)
  if (forCurrentUser && (env.context['guest'] || (await userFlags(env.cr, env.uid)).isPublic)) throw new NotPorted('selected_by_self of a guest or the public user');
  const selfVotes = forCurrentUser ? new Set((await env.cr.query<{ option_id: number }>(
    'SELECT v.option_id FROM mail_poll_vote v JOIN mail_poll_option o ON o.id = v.option_id WHERE o.poll_id = ANY($1::int[]) AND v.user_id = $2',
    [[...pollIds], env.uid])).rows.map((r) => r.option_id)) : null;
  const polls = (await env.cr.query<PollRow>(
    `SELECT id, allow_multiple_options, to_char(create_date, 'YYYY-MM-DD HH24:MI:SS') AS create_date, create_uid, end_message_id,
            to_char(poll_end_dt, 'YYYY-MM-DD HH24:MI:SS') AS poll_end_dt, poll_question, start_message_id
       FROM mail_poll WHERE id = ANY($1::int[])`, [[...pollIds]])).rows;
  const options = await optionsOf(env, pollIds);
  for (const id of pollIds) {
    const p = polls.find((x) => x.id === id);
    if (!p) throw new NotPorted('a poll of a message that no longer exists');
    const own = options.get(id) ?? [];
    const pct = votePercentages(own);
    const winner = winningOption(p.end_message_id !== null, own);
    store.add('mail.poll', id, {
      allow_multiple_options: Boolean(p.allow_multiple_options), create_date: p.create_date ?? false, create_uid: p.create_uid ?? false,
      end_message_id: p.end_message_id ?? false, option_ids: own.map((o) => o.id),
    });
    for (const o of own) {
      store.add('mail.poll.option', o.id, {
        number_of_votes: o.votes, poll_id: id, option_emoji: o.option_emoji ?? false, option_label: o.option_label, vote_percentage: pct.get(o.id)!,
        ...(selfVotes ? { selected_by_self: selfVotes.has(o.id) } : {}),
      });
    }
    store.add('mail.poll', id, { poll_end_dt: p.poll_end_dt ?? false, poll_question: p.poll_question, winning_option_id: winner });
    if (withStartMessage) {
      store.add('mail.poll', id, { start_message_id: p.start_message_id });
      await addMessage(p.start_message_id);
    }
  }
}

/** The options of polls with their vote counts, by poll (mail.poll.option has no _order: id). */
async function optionsOf(env: Environment, pollIds: readonly number[]): Promise<Map<number, OptionRow[]>> {
  const rows = (await env.cr.query<OptionRow>(
    `SELECT o.id, o.poll_id, o.option_emoji, o.option_label, (SELECT count(*)::int FROM mail_poll_vote v WHERE v.option_id = o.id) AS votes
       FROM mail_poll_option o WHERE o.poll_id = ANY($1::int[]) ORDER BY o.id`, [[...pollIds]])).rows;
  const out = new Map<number, OptionRow[]>(pollIds.map((id) => [id, []]));
  for (const r of rows) out.get(r.poll_id)?.push(r);
  return out;
}

/** mail_poll.py:28-39 `_compute_winning_option_ids` of an ended poll's options. */
function winningOption(ended: boolean, options: readonly OptionRow[]): number | false {
  if (!ended || !options.length) return false;
  const pct = votePercentages(options);
  const max = Math.max(...options.map((o) => pct.get(o.id)!));
  const winners = options.filter((o) => pct.get(o.id) === max && max > 0);
  return winners.length === 1 ? winners[0]!.id : false;
}

registerHooks('mail.poll', {
  computed: {
    winning_option_id: async (env, ids) => {
      const ended = new Map((await env.cr.query<{ id: number; e: boolean }>(
        'SELECT id, end_message_id IS NOT NULL AS e FROM mail_poll WHERE id = ANY($1::int[])', [[...ids]])).rows.map((r) => [r.id, r.e]));
      const options = await optionsOf(env, ids);
      return new Map(ids.map((id) => [id, winningOption(ended.get(id) ?? false, options.get(id) ?? [])]));
    },
  },
});

registerHooks('mail.poll.option', {
  computed: {
    number_of_votes: async (env, ids) => new Map((await env.cr.query<{ id: number; n: number }>(
      'SELECT o.id, (SELECT count(*)::int FROM mail_poll_vote v WHERE v.option_id = o.id) AS n FROM mail_poll_option o WHERE o.id = ANY($1::int[])',
      [[...ids]])).rows.map((r) => [r.id, r.n])),
    vote_percentage: async (env, ids) => {
      const polls = (await env.cr.query<{ id: number; poll_id: number }>('SELECT id, poll_id FROM mail_poll_option WHERE id = ANY($1::int[])', [[...ids]])).rows;
      const options = await optionsOf(env, [...new Set(polls.map((p) => p.poll_id))]);
      const pct = new Map<number, number>();
      for (const list of options.values()) for (const [k, v] of votePercentages(list)) pct.set(k, v);
      return new Map(ids.map((id) => [id, pct.get(id) ?? 0]));
    },
  },
});
