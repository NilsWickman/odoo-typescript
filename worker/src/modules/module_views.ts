/**
 * `ir.module.module._get_views` (base ir_module.py:222-252): the stored `views_by_module`, `reports_by_module` and
 * `menus_by_module` of installed modules, from their XML ids. Python's `sorted()` on str compares code points.
 */
import type { Environment } from "../orm/types";

const byCodePoint = (a: string, b: string): number => {
  const x = [...a], y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
};

export async function recomputeModuleViews(env: Environment, ids: readonly number[]): Promise<void> {
  for (const id of ids) {
    const m = (await env.cr.query<{ name: string; state: string }>("SELECT name, state FROM ir_module_module WHERE id = $1", [id])).rows[0];
    if (!m) continue;
    let views = "", reports = "", menus = "";
    if (["installed", "to upgrade", "to remove"].includes(m.state)) {
      views = (await env.cr.query<{ v: string }>(
        `SELECT CASE WHEN v.inherit_id IS NOT NULL THEN '* INHERIT ' ELSE '' END || v.name || ' (' || v.type || ')' AS v
           FROM ir_model_data d JOIN ir_ui_view v ON v.id = d.res_id
          WHERE d.module = $1 AND d.model = 'ir.ui.view' AND d.res_id IS NOT NULL`, [m.name])).rows.map((r) => r.v).sort(byCodePoint).join("\n");
      reports = (await env.cr.query<{ v: string }>(
        `SELECT r.name->>'en_US' AS v FROM ir_model_data d JOIN ir_act_report_xml r ON r.id = d.res_id
          WHERE d.module = $1 AND d.model = 'ir.actions.report' AND d.res_id IS NOT NULL`, [m.name])).rows.map((r) => r.v).sort(byCodePoint).join("\n");
      menus = (await env.cr.query<{ v: string }>(
        `WITH RECURSIVE chain AS (
           SELECT d.res_id AS menu, mm.id, mm.parent_id, mm.name->>'en_US' AS name, 0 AS depth
             FROM ir_model_data d JOIN ir_ui_menu mm ON mm.id = d.res_id
            WHERE d.module = $1 AND d.model = 'ir.ui.menu' AND d.res_id IS NOT NULL
           UNION ALL
           SELECT c.menu, p.id, p.parent_id, p.name->>'en_US', c.depth + 1 FROM chain c JOIN ir_ui_menu p ON p.id = c.parent_id)
         SELECT string_agg(name, '/' ORDER BY depth DESC) AS v FROM chain GROUP BY menu`, [m.name])).rows.map((r) => r.v).sort(byCodePoint).join("\n");
    }
    await env.cr.query("UPDATE ir_module_module SET views_by_module = $2, reports_by_module = $3, menus_by_module = $4 WHERE id = $1", [id, views, reports, menus]);
  }
}
