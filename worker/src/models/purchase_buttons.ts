/**
 * Header buttons of the purchase.order form (`/web/dataset/call_button`) as far as the API corpus reaches them in
 * poc_erp. Confirming, approving, receiving, cancelling and resetting an order (picking creation, purchase_stock)
 * are not ported. Rows in worker/COMPUTED.md.
 */
import { NotPorted, UserError } from "../errors";
import { registerMethod } from "../http/methods";
import { hasGroup } from "../orm/env";
import { write } from "../orm/write";
import { PrivateRecords } from "../orm/private_hooks";
import type { Environment } from "../orm/types";
import { fetchRecords, forXmlId } from "./account_buttons";
import { approveOrders } from "./purchase_receipt";
import { translate } from "./util";
import { trackPrepare } from "../mail/tracking";
import { closeTrackingScope } from "../mail/write_hooks";
import { addPrecommit, withPrecommit } from "./precommit";
import { postNote } from "./stock_engine";
import * as priv from "../orm/dispatch_gen";

const MODEL = "purchase.order";

function single(ids: readonly number[] | null): number {
  if (ids === null || ids.length !== 1) throw new NotPorted(`ensure_one on ${MODEL}(${(ids ?? []).join(", ")})`);
  return ids[0]!;
}

function m2oId(v: unknown): number | false {
  if (Array.isArray(v)) return typeof v[0] === "number" ? v[0] : false;
  return typeof v === "number" && v > 0 ? v : false;
}

async function xmlidResId(env: Environment, module: string, name: string): Promise<number | false> {
  // ir_model_data.py `_xmlid_lookup`: ValueError when missing (caught by the callers below -> False)
  const r = await env.cr.query<{ res_id: number }>("SELECT res_id FROM ir_model_data WHERE module = $1 AND name = $2", [module, name]);
  return r.rows[0]?.res_id ?? false;
}

/** purchase_order.py:617-670 action_rfq_send. */
registerMethod(MODEL, "action_rfq_send", async (env, ids) => {
  const id = single(ids);
  const [order] = await fetchRecords(env, MODEL, [id], ["state"]);
  const templateId = env.context["send_rfq"]
    ? await xmlidResId(env, "purchase", "email_template_edi_purchase")
    : await xmlidResId(env, "purchase", "email_template_edi_purchase_done");
  const composeFormId = await xmlidResId(env, "mail", "email_compose_message_wizard_form");
  const ctx: Record<string, unknown> = {
    ...env.context,
    default_model: MODEL,
    default_res_ids: [id],
    default_template_id: templateId,
    default_composition_mode: "comment",
    email_notification_allow_footer: true,
    force_email: true,
    hide_mail_template_management_options: true,
    mark_rfq_as_sent: true,
  };
  // :650-653 only with a default_res_id in the context (template._render_lang)
  if ("default_res_id" in ctx) throw new NotPorted("action_rfq_send with default_res_id (template lang rendering)");
  ctx["model_description"] = ["draft", "sent"].includes(String(order!["state"])) ? translate(env, "Request for Quotation") : translate(env, "Purchase Order");
  return {
    name: translate(env, "Compose Email"),
    type: "ir.actions.act_window",
    view_mode: "form",
    res_model: "mail.compose.message",
    views: [[composeFormId, "form"]],
    view_id: composeFormId,
    target: "new",
    context: ctx,
  };
}, { apiModel: false });

/** purchase_stock/models/purchase_order.py:270-271 action_view_picking -> :305-320 _get_action_view_picking. */
registerMethod(MODEL, "action_view_picking", async (env, ids) => {
  const id = single(ids);
  const [order] = await fetchRecords(env, MODEL, [id], ["partner_id", "picking_type_id", "picking_ids"]);
  const { loadAction } = await import("../controllers/action");
  const result = await loadAction({ cursor: () => env.cr, context: env.context, uid: env.uid }, "stock.action_picking_tree_all");
  result["context"] = { default_partner_id: m2oId(order!["partner_id"]), default_picking_type_id: m2oId(order!["picking_type_id"]) };
  const pickings = (order!["picking_ids"] as number[]) ?? [];
  if (pickings.length !== 1) result["domain"] = [["id", "in", pickings]];
  else {
    // :315-319 the picking's form first, then the action's other views
    const form = await xmlidResId(env, "stock", "view_picking_form");
    const views = ((result["views"] ?? []) as [number | false, string][]).filter(([, v]) => v !== "form");
    result["views"] = [[form, "form"], ...views];
    result["res_id"] = pickings[0];
  }
  return result;
}, { apiModel: false });

/**
 * purchase_order.py:672-673 action_acknowledge and :733-737 button_lock / button_unlock: field assignments
 * (fields.py:1992-2027 __set__ -> write; purchase_stock :116-131 write adds nothing for these values).
 */
registerMethod(MODEL, "action_acknowledge", async (env, ids) => { await write(env, MODEL, ids ?? [], { acknowledged: true }); return null; }, { apiModel: false });
registerMethod(MODEL, "button_lock", async (env, ids) => { await write(env, MODEL, ids ?? [], { locked: true }); return null; }, { apiModel: false });
registerMethod(MODEL, "button_unlock", async (env, ids) => { await write(env, MODEL, ids ?? [], { locked: false }); return null; }, { apiModel: false });

const pyListRepr = (names: readonly string[]): string => `[${names.map((n) => `'${n.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`).join(", ")}]`;

/** Stock moves of the orders' lines (purchase_stock): cancelling or confirming them is not ported. */
async function hasStockMoves(env: Environment, ids: readonly number[]): Promise<boolean> {
  const r = await env.cr.query(
    `SELECT 1 FROM stock_move m JOIN purchase_order_line l ON l.id = m.purchase_line_id WHERE l.order_id = ANY($1::int[])
     UNION ALL
     SELECT 1 FROM stock_move_created_purchase_line_rel r JOIN purchase_order_line l ON l.id = r.created_purchase_line_id WHERE l.order_id = ANY($1::int[])
     LIMIT 1`, [[...ids]]);
  return r.rows.length > 0;
}

/** purchase_stock purchase_order.py:221-268 button_cancel (without stock moves) over purchase_order.py:723-731. */
async function buttonCancel(env: Environment, ids0: readonly number[] | null): Promise<null> {
  const ids = ids0 ?? [];
  const orders = await fetchRecords(env, MODEL, ids, ["locked", "display_name"]);
  if (await hasStockMoves(env, ids)) throw new NotPorted("purchase.order.button_cancel with stock moves (_action_cancel, pickings)");
  const locked = orders.filter((o) => o["locked"]).map((o) => String(o["display_name"]));
  if (locked.length) throw new UserError(translate(env, "Unable to cancel purchase order(s): %s. You must first unlock them.").replace("%s", pyListRepr(locked)));
  const invoiced = (await env.cr.query<{ id: number }>(
    `SELECT DISTINCT l.order_id AS id FROM purchase_order_line l JOIN account_move_line aml ON aml.purchase_line_id = l.id
       JOIN account_move m ON m.id = aml.move_id WHERE l.order_id = ANY($1::int[]) AND m.state NOT IN ('cancel', 'draft')`, [[...ids]])).rows.map((r) => r.id);
  if (invoiced.length) {
    const names = orders.filter((o) => invoiced.includes(Number(o["id"]))).map((o) => String(o["display_name"]));
    throw new UserError(translate(env, "Unable to cancel purchase order(s): %s. You must first cancel their related vendor bills.").replace("%s", pyListRepr(names)));
  }
  await write(env, MODEL, ids, { state: "cancel" });
  return null;
}
registerMethod(MODEL, "button_cancel", (env, ids) => buttonCancel(env, ids), { apiModel: false });

/**
 * purchase_order.py:708-721 button_confirm: the checks, then button_approve (purchase_stock :211-215,
 * src/models/purchase_receipt.ts).
 */
registerMethod(MODEL, "button_confirm", async (env, ids0) => {
  for (const id of ids0 ?? []) {
    const [order] = await fetchRecords(env, MODEL, [id], ["state", "company_id"]);
    if (!["draft", "sent"].includes(String(order!["state"]))) continue;
    const lines = (await env.cr.query<{ id: number; display_type: string | null; is_downpayment: boolean | null; product_id: number | null; date_planned: string | null }>(
      "SELECT id, display_type, is_downpayment, product_id, date_planned::text AS date_planned FROM purchase_order_line WHERE order_id = $1 ORDER BY sequence, id", [id])).rows;
    if (lines.some((l) => !l.display_type && !l.is_downpayment && !l.product_id)) {
      throw new UserError(translate(env, "Some order lines are missing a product, you need to correct them before going further."));
    }
    const mandatory = (await env.cr.query("SELECT 1 FROM account_analytic_applicability WHERE business_domain = 'purchase_order' AND applicability = 'mandatory' LIMIT 1")).rows.length;
    if (mandatory) throw new NotPorted("purchase.order.button_confirm with mandatory analytic plans (_validate_analytic_distribution)");
    // :1332-1341 _approval_allowed
    const company = m2oId(order!["company_id"]);
    const mode = (await env.cr.query<{ m: string | null }>("SELECT po_double_validation AS m FROM res_company WHERE id = $1", [company])).rows[0]?.m;
    if (mode !== "one_step" && !(await hasGroup(env, "purchase.group_purchase_manager"))) throw new NotPorted("purchase.order.button_confirm under double validation");
    await approveOrders(env, [id]);
  }
  return true;
}, { apiModel: false });

// purchase_order.py:675-680 action_purchase_comparison
registerMethod(MODEL, "action_purchase_comparison", async (env, ids) => {
  const id = single(ids);
  const [order] = await fetchRecords(env, MODEL, [id], ["display_name"]);
  const action = await forXmlId(env, "purchase.action_purchase_history");
  // order_line (purchase_order_line _order: order_id, sequence, id) .product_id: first occurrences, deduplicated
  const rows = (await env.cr.query<{ p: number }>(
    "SELECT product_id AS p FROM purchase_order_line WHERE order_id = $1 AND product_id IS NOT NULL ORDER BY sequence, id", [id])).rows;
  action["domain"] = [["product_id", "in", [...new Set(rows.map((r) => r.p))]]];
  action["display_name"] = translate(env, "Purchase Comparison for %s").replace("%s", String(order!["display_name"]));
  return action;
}, { apiModel: false });

/**
 * purchase_order.py:895-975 `action_merge` (Merge RFQs) with purchase_stock's `_prepare_grouped_data` (the operation
 * type): the requests for quotation of one vendor, currency, dropship address and operation type go into the oldest
 * (by order date); their lines move to it, the origins and vendor references are joined, each merged request gets a
 * note and is cancelled, then `_merge_po_post_process(rfqs)` on the oldest: purchase's (nothing) through the private
 * hook, around which a site's compiled override runs (purchase_alternative's alternatives), then purchase_stock's, which
 * is above them in the MRO and runs after its super(): the references (mergeReferences). A line matching one of the oldest request
 * (`_merge_po_line`: its quantity and price) refuses.
 */
/**
 * purchase_stock's `_merge_po_post_process(rfqs)` after its super() (purchase_order.py:473-475; purchase's own does
 * nothing, :976-977): `self.reference_ids += rfqs.reference_ids`, the union written as `[Command.set(ids)]`
 * (fields.py:2024-2027 `__set__` -> convert_to_write, fields_relational.py:736-767), also when it is empty.
 */
async function mergeReferences(env: Environment, oldest: number, rfqs: readonly number[]): Promise<void> {
  const refs = async (orders: readonly number[]): Promise<number[]> => {
    const out: number[] = [];
    if (!orders.length) return out;
    for (const r of await env.model(MODEL).read([...orders], ["reference_ids"], "")) for (const id of (r["reference_ids"] as number[])) if (!out.includes(id)) out.push(id);
    return out;
  };
  const union = await refs([oldest]);
  for (const id of await refs(rfqs)) if (!union.includes(id)) union.push(id);
  await write(env, MODEL, [oldest], { reference_ids: [[6, 0, union]] });
}

registerMethod(MODEL, "action_merge", async (env, ids0) => {
  const ids = ids0 ?? [];
  const rows = (await env.cr.query<{ id: number; state: string; partner_id: number | null; currency_id: number | null; dest_address_id: number | null; picking_type_id: number | null;
    date_order: string; origin: string | null; partner_ref: string | null; name: string }>(
    `SELECT id, state, partner_id, currency_id, dest_address_id, picking_type_id, date_order::text AS date_order, origin, partner_ref, name
       FROM purchase_order WHERE id = ANY($1::int[])`, [[...ids]])).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const rfqs = ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => r !== undefined && ["draft", "sent"].includes(r.state));
  if (rfqs.length < 2) throw new UserError(translate(env, "Please select at least two purchase orders with state RFQ and RFQ sent to merge.", "purchase"));
  const groups = new Map<string, typeof rfqs>();
  for (const r of rfqs) {
    // `self._prepare_grouped_data(rfq)` through callPrivate (private_hooks.json): purchase's (partner, currency, dropship
    // address) with purchase_stock's operation type as the hand; a site's override appends (purchase_requisition: the
    // agreement). The key is the tuple of ids it returns (False for an empty one)
    const value = await priv.purchase_order._prepare_grouped_data.call(env, [...ids], [new PrivateRecords(MODEL, [r.id])],
      async () => [r.partner_id ?? false, r.currency_id ?? false, r.dest_address_id ?? false, r.picking_type_id ?? false]);
    if (!Array.isArray(value) || value.some((v) => typeof v !== "number" && v !== false)) {
      throw new NotPorted("purchase.order._prepare_grouped_data() returned something else than a tuple of ids");
    }
    const key = JSON.stringify(value);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  if ([...groups.values()].every((g) => g.length === 1)) {
    throw new UserError(translate(env, "In selected purchase order to merge these details must be same\nVendor, currency, destination, dropship address and agreement", "purchase"));
  }
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
  const merged: number[] = [];
  const bunches = [...groups.values()].filter((g) => g.length > 1);
  await withPrecommit(env.cr, async () => {
    await trackPrepare(env, MODEL, bunches.flatMap((g) => {
      const oldest = g.reduce((a, b) => (b.date_order < a.date_order ? b : a));
      return [oldest.id, ...g.filter((r) => r !== oldest).map((r) => r.id)];
    }));
    await addPrecommit(env.cr, () => closeTrackingScope(env, MODEL));
    for (const g of bunches) {
      // Python min(): the first of the earliest
      const oldest = g.reduce((a, b) => (b.date_order < a.date_order ? b : a));
      const others = g.filter((r) => r !== oldest);
      const own = (await env.cr.query<{ id: number; product_id: number | null; uom_id: number | null; analytic_distribution: unknown; discount: number | null; date_planned: string | null }>(
        `SELECT id, product_id, uom_id, analytic_distribution, discount::float8 AS discount, date_planned::text AS date_planned FROM purchase_order_line
          WHERE order_id = $1 AND (display_type IS NULL OR display_type NOT IN ('line_section', 'line_subsection', 'line_note')) ORDER BY sequence, id`, [oldest.id])).rows;
      for (const r of others) {
        const lines = (await env.cr.query<{ id: number; product_id: number | null; uom_id: number | null; analytic_distribution: unknown; discount: number | null; date_planned: string | null }>(
          `SELECT id, product_id, uom_id, analytic_distribution, discount::float8 AS discount, date_planned::text AS date_planned FROM purchase_order_line
            WHERE order_id = $1 ORDER BY sequence, id`, [r.id])).rows;
        for (const l of lines) {
          const seconds = (d: string | null): number => (d ? Date.parse(`${d.replace(" ", "T")}Z`) / 1000 : NaN);
          const match = own.some((o) => o.product_id === l.product_id && o.uom_id === l.uom_id && JSON.stringify(o.analytic_distribution ?? null) === JSON.stringify(l.analytic_distribution ?? null)
            && (o.discount ?? 0) === (l.discount ?? 0) && Math.abs(seconds(o.date_planned) - seconds(l.date_planned)) <= 86400);
          if (match) throw new NotPorted("purchase.order.action_merge of a line matching one of the oldest request (_merge_po_line)");
          await write(env, "purchase.order.line", [l.id], { order_id: oldest.id });
        }
      }
      const join = (vals: (string | null)[]): string => vals.filter((v) => v).join(", ");
      await write(env, MODEL, [oldest.id], { origin: join([oldest.origin, ...others.map((r) => r.origin)]) });
      await write(env, MODEL, [oldest.id], { partner_ref: join([oldest.partner_ref, ...others.map((r) => r.partner_ref)]) });
      // `_get_html_link()` (models.py): the record's display_name, after the vendor references are joined above
      // (purchase.order `_compute_display_name`: the name and the vendor reference, "P00020 (WA)")
      const shown = String((await env.model(MODEL).read([oldest.id], ["display_name"], ""))[0]?.["display_name"] ?? oldest.name);
      const link = `<a href="#" data-oe-model="purchase.order" data-oe-id="${oldest.id}">${esc(shown)}</a>`;
      for (const r of others) await postNote(env, MODEL, r.id, `<p>${esc(translate(env, "RFQ merged with %s", "purchase")).replace("%s", link)}</p>`);
      await postNote(env, MODEL, oldest.id, `<p>${esc(translate(env, "RFQ merged with %(oldest_rfq_name)s and %(cancelled_rfq)s", "purchase")
        .replace("%(oldest_rfq_name)s", oldest.name).replace("%(cancelled_rfq)s", others.map((r) => r.name).join(", ")))}</p>`);
      const cancel = (await env.cr.query<{ id: number }>("SELECT id FROM purchase_order WHERE id = ANY($1::int[]) AND state != 'cancel'", [others.map((r) => r.id)])).rows.map((r) => r.id);
      const keep = others.map((r) => r.id).filter((id) => cancel.includes(id));
      if (keep.length) await buttonCancel(env, keep);
      await priv.purchase_order._merge_po_post_process.call(env, [oldest.id], [new PrivateRecords(MODEL, others.map((r) => r.id))], async () => null);
      await mergeReferences(env, oldest.id, others.map((r) => r.id));
      merged.push(oldest.id);
    }
  });
  const action: Record<string, unknown> = { type: "ir.actions.act_window", view_mode: "list,kanban,form", res_model: MODEL };
  if (merged.length === 1) {
    action["res_id"] = merged[0];
    action["view_mode"] = "form";
  } else {
    action["name"] = translate(env, "Merged RFQs", "purchase");
    action["domain"] = [["id", "in", merged]];
  }
  return action;
}, { apiModel: false });
