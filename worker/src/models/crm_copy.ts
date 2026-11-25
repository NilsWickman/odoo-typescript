/**
 * Duplicating a lead: crm_lead.py `copy_data` (the recurring revenue reset without the group, the type and team kept,
 * `date_open` now for an opportunity of an active salesperson, an archived salesperson dropped). The generic copy is
 * src/web/save.ts.
 */
import { registerOverrides } from "../orm/write";
import { userHasGroup } from "../web/groups";
import { datetimeToString, dbNow } from "./util";

registerOverrides("crm.lead", {
  copyData: async (env, ids, valsList, defaults) => {
    // `default['recurring_revenue'] = 0; default['recurring_plan'] = False` before super(): a default overrides the copy
    if (!(await userHasGroup(env, "crm.group_use_recurring_revenues"))) {
      for (const vals of valsList) {
        if (!("recurring_revenue" in defaults)) vals["recurring_revenue"] = 0;
        if (!("recurring_plan" in defaults)) vals["recurring_plan"] = false;
      }
    }
    // `now = self.env.cr.now()`: the transaction's timestamp, to the second as the port's other crm.lead dates
    // (crm_lead_write.ts nowString; the microseconds Odoo keeps in the column are never read back by the ORM)
    const now = datetimeToString(await dbNow(env));
    const rows = (await env.cr.query<{ id: number; type: string | null; team_id: number | null; user_active: boolean | null }>(
      `SELECT l.id, l.type, l.team_id, u.active AS user_active FROM crm_lead l LEFT JOIN res_users u ON u.id = l.user_id WHERE l.id = ANY($1::int[])`,
      [[...ids]])).rows;
    for (let i = 0; i < ids.length; i++) {
      const lead = rows.find((r) => r.id === ids[i])!;
      const vals = valsList[i]!;
      if (!("type" in vals)) vals["type"] = lead.type ?? false;
      if (!("team_id" in vals)) vals["team_id"] = lead.team_id ?? false;
      // `lead.user_id.active`: False for no salesperson
      vals["date_open"] = lead.type === "opportunity" && lead.user_active === true ? now : false;
      if (lead.user_active !== true) vals["user_id"] = false;
    }
  },
});
