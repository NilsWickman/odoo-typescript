/**
 * `og_title_from_path` (odoo/addons/web/controllers/utils.py:20-37) over `get_action_triples` (:205-245) and
 * `get_action` (:160-202): the name of the last action of a "/odoo/..." path, "Odoo" when there is none or the
 * path does not parse (every exception is logged and answered "Odoo"; a port gap still raises NotPorted).
 */
import type { Cursor } from "../db";

interface ActionRow { id: number; type: string; name: Record<string, string> | string | null }

/** utils.py:160-202 get_action (as superuser). */
async function getAction(cr: Cursor, part: string): Promise<ActionRow | null> {
  const byId = async (id: number): Promise<ActionRow | null> =>
    (await cr.query<ActionRow>("SELECT id, type, name FROM ir_actions WHERE id = $1", [id])).rows[0] ?? null;
  if (part.startsWith("action-")) {
    const someid = part.slice("action-".length);
    if (/^\d+$/.test(someid)) return byId(Number(someid));
    if (someid.includes(".")) {
      const dot = someid.indexOf(".");
      const row = (await cr.query<{ model: string; res_id: number }>(
        "SELECT model, res_id FROM ir_model_data WHERE module = $1 AND name = $2", [someid.slice(0, dot), someid.slice(dot + 1)])).rows[0];
      if (!row || !row.model.startsWith("ir.actions")) return null;
      return byId(row.res_id);
    }
    return null;
  }
  if (part.startsWith("m-") || part.includes(".")) {
    const model = part.replace(/^m-/, "");
    const m = (await cr.query<{ abstract: boolean | null }>("SELECT abstract FROM ir_model WHERE model = $1", [model])).rows[0];
    if (!m || m.abstract) return null;
    const act = (await cr.query<{ id: number }>("SELECT id FROM ir_act_window WHERE res_model = $1 ORDER BY id LIMIT 1", [model])).rows[0];
    if (!act) return null;
    return byId(act.id);
  }
  const rows = (await cr.query<ActionRow>("SELECT id, type, name FROM ir_actions WHERE path = $1", [part])).rows;
  if (rows.length > 1) return null; // a multi-record `action.read` would raise: "Odoo"
  return rows[0] ?? null;
}

export async function ogTitleFromPath(cr: Cursor, path: string, lang: string): Promise<string> {
  const odooPath = (path.split(/[?#]/)[0] ?? "").replace(/^\/odoo/, "");
  if (!odooPath || odooPath === "/") return "Odoo";
  const parts = odooPath.replace(/^\/+|\/+$/g, "").split("/");
  let last: ActionRow | null = null;
  while (parts.length) {
    const action = await getAction(cr, parts.shift() ?? "");
    if (!action) return "Odoo"; // ValueError
    if (parts.length && (parts[0] === "new" || /^\d+$/.test(parts[0] ?? ""))) parts.shift();
    last = action;
    if (parts.length > 1 && /^\d+$/.test(parts[0] ?? "")) parts.shift();
  }
  if (last === null) return "Odoo";
  const name = last.name;
  const text = typeof name === "string" ? name : name ? (name[lang] ?? name["en_US"] ?? "") : "";
  return text || "Odoo";
}
