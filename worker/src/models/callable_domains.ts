/**
 * `_description_domain` of fields whose `domain=` is a callable (fields_get's `domain`, src/orm/model.ts), found by the
 * view validation sweep (proofs/scenarios/view_all.py) on standard forms.
 */
import { NotPorted } from "../errors";
import { hooksOf, registerHooks } from "../orm/hooks";
import type { Environment } from "../orm/types";

registerHooks("ir.actions.server", {
  descriptionDomain: {
    ...hooksOf("ir.actions.server").descriptionDomain,
    // ir_actions.py:628 domain=lambda self: str(self._get_children_domain()) (:797-803); base_automation adds a leaf
    child_ids: async (env) => {
      if (env.reg.models.has("base.automation")) throw new NotPorted("ir.actions.server.child_ids domain with base_automation");
      return "['&', '&', ('model_id', '=', model_id), ('parent_id', '=', False), ('id', '!=', id)]";
    },
  },
});

registerHooks("ir.cron", {
  // the field delegated through `_inherits` (ir.cron -> ir.actions.server) is a related field without the domain:
  // Odoo's fields_get answers [] (measured on the oracle)
  descriptionDomain: { ...hooksOf("ir.cron").descriptionDomain, child_ids: async () => [] },
});

registerHooks("stock.request.count", {
  descriptionDomain: {
    ...hooksOf("stock.request.count").descriptionDomain,
    // stock_request_count.py:15 domain=lambda self: [('all_group_ids', 'in', self.env.ref('stock.group_stock_user').id)]
    user_id: async (env) => {
      const r = (await env.cr.query<{ res_id: number }>("SELECT res_id FROM ir_model_data WHERE module = 'stock' AND name = 'group_stock_user'")).rows[0];
      if (!r) throw new NotPorted("stock.group_stock_user is missing (env.ref raises)");
      return [["all_group_ids", "in", Number(r.res_id)]];
    },
  },
});

/**
 * The installed modules in the order a server loads them (odoo/modules/module_graph.py:224-225 `ModuleGraph.__iter__`,
 * mode 'load': base first, then by (depth, name), the depth being the longest path to base along the dependencies,
 * :180-187), as `ir_module_module` and `ir_module_module_dependency` give them. `test_*` modules sort after their last
 * dependency (:166-173), which is not ported.
 */
async function moduleLoadOrder(env: Environment): Promise<Map<string, number>> {
  const mods = (await env.cr.query<{ name: string }>(
    "SELECT name FROM ir_module_module WHERE state IN ('installed', 'to upgrade', 'to remove')")).rows.map((r) => r.name);
  if (mods.some((m) => m.startsWith("test_"))) throw new NotPorted("registry order with a test_ module installed");
  const installed = new Set(mods);
  const deps = new Map<string, string[]>(mods.map((m) => [m, []]));
  for (const r of (await env.cr.query<{ module: string; dep: string }>(
    `SELECT m.name AS module, d.name AS dep FROM ir_module_module_dependency d JOIN ir_module_module m ON m.id = d.module_id
      WHERE m.state IN ('installed', 'to upgrade', 'to remove')`)).rows) {
    // a dependency that is not loaded removes the module from the graph (:258-267): not ported
    if (!installed.has(r.dep)) throw new NotPorted(`registry order: ${r.module} depends on ${r.dep}, not installed`);
    deps.get(r.module)!.push(r.dep);
  }
  const depth = new Map<string, number>();
  const depthOf = (m: string, seen: Set<string>): number => {
    const known = depth.get(m);
    if (known !== undefined) return known;
    if (seen.has(m)) throw new NotPorted(`registry order: ${m} in a dependency loop`);
    seen.add(m);
    const ds = deps.get(m) ?? [];
    const d = ds.length ? Math.max(...ds.map((x) => depthOf(x, seen))) + 1 : 0;
    seen.delete(m);
    depth.set(m, d);
    return d;
  };
  const key = (m: string): [number, number, string] => [m === "base" ? 0 : 1, depthOf(m, new Set()), m];
  const sorted = [...mods].sort((a, b) => {
    const [pa, da, na] = key(a), [pb, db, nb] = key(b);
    return pa - pb || da - db || (na < nb ? -1 : na > nb ? 1 : 0);
  });
  return new Map(sorted.map((m, i) => [m, i]));
}

registerHooks("mail.template", {
  descriptionDomain: {
    ...hooksOf("mail.template").descriptionDomain,
    // mail_template.py:31-34 `_get_non_abstract_models_domain`: the abstract models in registry order, the order in
    // which they were first defined (orm/registry.py:424-453 `load` per module in load order, model_classes.py:238 a
    // model keeps its place when another module extends it): by the first module defining it in load order (its
    // `model_<name>` xmlids are those of the modules defining or extending it), then by the reflection order of that
    // module's models (ir_model ids, ir_model.py `_reflect_models` in the module's definition order)
    model_id: async (env) => {
      const order = await moduleLoadOrder(env);
      const rows = (await env.cr.query<{ id: number; model: string; modules: string[] }>(
        `SELECT m.id, m.model, array_agg(d.module) AS modules FROM ir_model m
           JOIN ir_model_data d ON d.model = 'ir.model' AND d.res_id = m.id
          WHERE m.abstract GROUP BY m.id, m.model`)).rows;
      const all = (await env.cr.query<{ n: string }>("SELECT count(*)::text AS n FROM ir_model WHERE abstract")).rows[0]!;
      if (rows.length !== Number(all.n)) throw new NotPorted("registry order of an abstract model without xmlid");
      const first = (r: { model: string; modules: string[] }): number => {
        const pos = r.modules.map((m) => order.get(m)).filter((p): p is number => p !== undefined);
        if (!pos.length) throw new NotPorted(`registry order of ${r.model}: no installed module defines it`);
        return Math.min(...pos);
      };
      const keyed = rows.map((r) => ({ model: r.model, id: r.id, first: first(r) }));
      keyed.sort((a, b) => a.first - b.first || a.id - b.id);
      return [["model", "not in", keyed.map((k) => k.model)]];
    },
  },
});
