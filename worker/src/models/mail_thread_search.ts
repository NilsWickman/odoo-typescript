/**
 * `mail.thread._search_message_partner_ids` (mail/models/mail_thread.py:222-239) for the models whose ir.access
 * domains search it on poc_erp (project.task: project/security/ir_access.xml `('message_partner_ids', 'in',
 * [user.partner_id.id])`). Followers are read in sudo; non-internal users may only filter by themselves.
 */
import { AccessError, NotPorted } from "../errors";
import { and, cond } from "../orm/domain";
import { userInfo } from "../orm/env";
import { registerHooks } from "../orm/hooks";
import type { Environment } from "../orm/types";
import { userFlags } from "../session/user";

const MODELS = ["project.task"];

function searchMessagePartnerIds(model: string) {
  return async (env: Environment, operator: string, value: unknown) => {
    // :224-225 negative operators return NotImplemented (the ORM's generic fallback is not ported)
    if (operator !== "in" && operator !== "=" && operator !== "child_of" && operator !== "parent_of") {
      throw new NotPorted(`${model}.message_partner_ids ${operator}`);
    }
    const values = Array.isArray(value) ? value : [value];
    if (!values.every((v) => typeof v === "number")) throw new NotPorted(`${model}.message_partner_ids with non-id values`);
    const ids = values as number[];
    if (!env.su && !(await userFlags(env.cr, env.uid)).isInternal) {
      const self = await userInfo(env);
      const commercial = (await env.cr.query<{ id: number | null }>("SELECT commercial_partner_id AS id FROM res_partner WHERE id = $1", [self.partnerId])).rows[0]?.id ?? null;
      const allowed = new Set([self.partnerId, ...(commercial === null ? [] : [commercial])]);
      if (!ids.every((id) => allowed.has(id))) throw new AccessError("Portal users can only filter threads by themselves as followers.");
    }
    if (operator === "child_of" || operator === "parent_of") {
      const fids = await env.sudo().model("mail.followers").search(and([cond("res_model", "=", model), cond("partner_id", operator, ids)]));
      if (!fids.length) return cond("id", "in", []);
      const r = await env.cr.query<{ res_id: number }>(
        "SELECT DISTINCT res_id FROM mail_followers WHERE id = ANY($1::int[]) ORDER BY res_id", [fids]);
      return cond("id", "in", r.rows.map((x) => x.res_id));
    }
    const r = await env.cr.query<{ res_id: number }>(
      "SELECT DISTINCT res_id FROM mail_followers WHERE res_model = $1 AND partner_id = ANY($2::int[]) ORDER BY res_id", [model, ids]);
    return cond("id", "in", r.rows.map((x) => x.res_id));
  };
}

for (const model of MODELS) registerHooks(model, { search: { message_partner_ids: searchMessagePartnerIds(model) } });
