/**
 * `ir.filters` (`odoo/odoo/addons/base/models/ir_filters.py`): `create_filter` (:122-127), the search panel's
 * "Save search", and the `create` override (:70-74) with `_sanitize_shared_context` (:43-50).
 * The create itself is the ORM write path (src/orm/create.ts, stream WR).
 */
import { NotPorted } from "../errors";
import { registerMethod } from "../http/methods";
import { create } from "../orm/create";
import { registerDefaults } from "../orm/recompute";
import { registerOverrides } from "../orm/write";
import type { Environment } from "../orm/types";
import { pyStr } from "./pystr";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * ir_filters.py:43-50: filters shared with others than the current user lose the `default_*`-like keys of their
 * context (`clean_context`). Evaluating the stored context needs `ast.literal_eval`; only the cases where nothing
 * can change are ported (the filter is the current user's own, or its context is empty).
 */
async function sanitizeSharedContext(env: Environment, ids: readonly number[]): Promise<void> {
  const rows = (await env.cr.query<{ id: number; context: string | null; users: number[] }>(
    `SELECT f.id, f.context, COALESCE(array_agg(r.res_users_id ORDER BY r.res_users_id) FILTER (WHERE r.res_users_id IS NOT NULL), '{}') AS users
       FROM ir_filters f LEFT JOIN ir_filters_res_users_rel r ON r.ir_filters_id = f.id
      WHERE f.id = ANY($1::int[]) GROUP BY f.id`, [ids])).rows;
  for (const r of rows) {
    const own = r.users.length === 1 && r.users[0] === env.uid;
    const ctx = (r.context ?? "").trim();
    if (own || ctx === "" || ctx === "{}") continue;
    throw new NotPorted("ir.filters._sanitize_shared_context of a shared filter with a context (ast.literal_eval + clean_context)");
  }
}

// ir_filters.py:16-18, :27: the Python `default=` of the model's fields
registerDefaults("ir.filters", {
  domain: async () => "[]",
  context: async () => "{}",
  sort: async () => "[]",
  active: async () => true,
});

registerOverrides("ir.filters", {
  create: async (env, valsList, next) => {
    const ids = await next(env, valsList);
    await sanitizeSharedContext(env, ids);
    return ids;
  },
});

// ir_filters.py:122-127
registerMethod("ir.filters", "create_filter", async (env, _ids, args, kwargs) => {
  const vals0 = "vals" in kwargs ? kwargs["vals"] : args[0];
  if (!isRecord(vals0)) throw new NotPorted(`ir.filters.create_filter vals ${JSON.stringify(vals0)}`);
  const vals = { ...vals0 };
  if (!vals["embedded_action_id"] && "embedded_parent_res_id" in vals) delete vals["embedded_parent_res_id"];
  // the client sends `context` as a dict: Text.convert_to_cache stores its str() (fields_textual.py:137)
  for (const name of ["context", "domain", "sort"]) {
    const v = vals[name];
    if (v !== false && v !== null && v !== undefined && typeof v !== "string") vals[name] = pyStr(v);
  }
  // `return self.create(vals)`: the recordset is serialized as its ids (service/model.py call_kw)
  return create(env, "ir.filters", [vals]);
}, { apiModel: true });
