/**
 * `@api.onchange` methods that run on the New form of a menu (the map's "new", "save_empty" and "fill" steps) and that
 * refused as "onchange method ... not ported". Each is ported for the values the form gives it and refuses where it
 * would need more (a tracked product, existing stock moves, a payment provider token, another warning text).
 */
import { NotPorted, UserError } from "../errors";
import { userHasGroup } from "../web/groups";
import { NewRec, registerOnchange, type Rec } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { translate } from "./util";
import { runVatChecks } from "./res_partner_write";

/** A many2one value of a form record: its id, null when empty; a new co-record refuses. */
function m2o(value: unknown, what: string): number | null {
  if (typeof value === "number") return value;
  if (value === null || value === false || value === undefined) return null;
  if (value instanceof NewRec && value.origin !== null) return value.origin;
  throw new NotPorted(`${what}: a new record as value`);
}

/** An x2many value of a form record as database ids; new lines refuse. */
function idsOf(value: unknown, what: string): number[] {
  if (value === null || value === false || value === undefined) return [];
  if (!Array.isArray(value)) throw new NotPorted(`${what}: x2many value ${typeof value}`);
  return value.map((v) => {
    if (typeof v === "number") return v;
    if (v instanceof NewRec && v.origin !== null) return v.origin;
    throw new NotPorted(`${what}: a new line`);
  });
}

// mail mail_activity_type.py:89-92 `_onchange_res_model`: the templates (read as superuser) of the new model only,
// and `res_model_change = initial_res_model and initial_res_model != res_model`
registerOnchange("mail.activity.type", "_onchange_res_model", ["res_model"], async (env, rec) => {
  const model = await rec.get("res_model");
  const templates = idsOf(await rec.get("mail_template_ids"), "mail.activity.type.mail_template_ids");
  if (templates.length) {
    const models = new Map((await env.cr.query<{ id: number; model: string | null }>(
      "SELECT t.id, m.model FROM mail_template t LEFT JOIN ir_model m ON m.id = t.model_id WHERE t.id = ANY($1::int[])", [templates])).rows.map((r) => [r.id, r.model]));
    await rec.set("mail_template_ids", templates.filter((t) => (models.get(t) ?? false) === (model || false)));
  } else await rec.set("mail_template_ids", []);
  const initial = await rec.get("initial_res_model");
  await rec.set("res_model_change", Boolean(initial) && initial !== model);
});

// crm crm_stage.py:57-67 `_onchange_is_won`: no warning while creating a stage
registerOnchange("crm.stage", "_onchange_is_won", ["is_won"], async (env, rec) => {
  if (rec.origin === null) return;
  return {
    title: translate(env, "Do you really want to update this stage?", "crm"),
    message: translate(env, "Changing the value of 'Is Won Stage' may induce a large number of operations, "
      + "as the probabilities of opportunities in this stage will be recomputed on saving.", "crm"),
  };
});

// l10n_us_account account_tax.py:62-69 `_onchange_l10n_us_jurisdiction`
registerOnchange("account.tax", "_onchange_l10n_us_jurisdiction", ["l10n_us_jurisdiction_type", "l10n_us_state_id"], async (_env, rec) => {
  const type = await rec.get("l10n_us_jurisdiction_type");
  if (!type) await rec.set("l10n_us_state_id", false);
  const state = m2o(await rec.get("l10n_us_state_id"), "account.tax.l10n_us_state_id");
  for (const [kind, field] of [["county", "l10n_us_county_id"], ["city", "l10n_us_city_id"]] as const) {
    const target = await rec.rel(field);
    const targetState = target ? m2o(await target.get("state_id"), `account.tax.${field}.state_id`) : null;
    if (type !== kind || targetState !== state) await rec.set(field, false);
  }
});

// account_edi_ubl_cii account_tax.py:128-133 `_onchange_ubl_cii_tax_category_code`
registerOnchange("account.tax", "_onchange_ubl_cii_tax_category_code", ["ubl_cii_requires_exemption_reason"], async (_env, rec) => {
  if (await rec.get("ubl_cii_requires_exemption_reason")) return;
  await rec.set("ubl_cii_tax_exemption_reason", false);
  await rec.set("ubl_cii_tax_exemption_reason_code", false);
});

// account account_tax.py:5239-5242 `_onchange_repartition_type`
registerOnchange("account.tax.repartition.line", "_onchange_repartition_type", ["repartition_type"], async (_env, rec) => {
  if ((await rec.get("repartition_type")) === "base") await rec.set("account_id", false);
});

// account partner.py:148-150 `_onchange_foreign_vat`: `_run_vat_checks(country, foreign_vat, validation=False)` gives
// the value back unchanged when there is none to check
registerOnchange("account.fiscal.position", "_onchange_foreign_vat", ["country_id", "foreign_vat"], async (env, rec) => {
  const vat = await rec.get("foreign_vat");
  const country = m2o(await rec.get("country_id"), "account.fiscal.position.country_id");
  if (!vat || country === null) return; // :1418-1419 `if not country or not vat: return vat, False`
  const code = (await env.cr.query<{ code: string }>("SELECT code FROM res_country WHERE id = $1", [country])).rows[0]?.code ?? null;
  const checked = await runVatChecks(env, code, String(vat), false);
  if (checked !== vat) await rec.set("foreign_vat", checked);
});
// account partner.py:187-191 `_onchange_country_group_id`
registerOnchange("account.fiscal.position", "_onchange_country_group_id", ["country_group_id"], async (_env, rec) => {
  if (m2o(await rec.get("country_group_id"), "account.fiscal.position.country_group_id") === null) return;
  await rec.set("zip_from", false);
  await rec.set("zip_to", false);
  await rec.set("state_ids", []);
});
// account partner.py:180-185 `_onchange_country_id`
registerOnchange("account.fiscal.position", "_onchange_country_id", ["country_id"], async (env, rec) => {
  const country = m2o(await rec.get("country_id"), "account.fiscal.position.country_id");
  if (country === null) return;
  await rec.set("zip_from", false);
  await rec.set("zip_to", false);
  await rec.set("state_ids", []);
  const n = (await env.cr.query<{ n: number }>("SELECT count(*)::int AS n FROM res_country_state WHERE country_id = $1", [country])).rows[0]?.n ?? 0;
  await rec.set("states_count", n);
});

// stock stock_picking_type.py:493-500 `_onchange_picking_code`
registerOnchange("stock.picking.type", "_onchange_picking_code", ["code"], async (env, rec) => {
  if ((await rec.get("code")) === "internal" && !(await userHasGroup(env, "stock.group_stock_multi_locations"))) {
    return { title: "", message: translate(env, "You need to activate storage locations to be able to do internal operation types.", "stock") };
  }
});

// stock stock_move.py:1521-1525 `_onchange_lot_ids`: nothing for a product without tracking
registerOnchange("stock.move", "_onchange_lot_ids", ["lot_ids"], async (_env, rec) => {
  const product = await rec.rel("product_id");
  const tracking = product ? await product.get("tracking") : false;
  if (!tracking || tracking === "none") return;
  throw new NotPorted("stock.move._onchange_lot_ids of a tracked product");
});

// stock stock_picking.py:630-637 `_onchange_picking_type`: the moves of a draft picking follow its operation type
// and company; a picking without moves has nothing to change
registerOnchange("stock.picking", "_onchange_picking_type", ["picking_type_id", "partner_id"], async (_env, rec) => {
  if (!m2o(await rec.get("picking_type_id"), "stock.picking.picking_type_id") || (await rec.get("state")) !== "draft") return;
  const moves = await rec.get("move_ids");
  if (Array.isArray(moves) && moves.length) throw new NotPorted("stock.picking._onchange_picking_type with moves");
});

// stock stock_picking.py:639-652 `_onchange_location_id`: the moves follow the source location (a warning about the
// reservations of chained moves); a picking without moves has nothing to change
registerOnchange("stock.picking", "_onchange_location_id", ["location_id"], async (_env, rec) => {
  const moves = await rec.get("move_ids");
  if (Array.isArray(moves) && moves.length) throw new NotPorted("stock.picking._onchange_location_id with moves");
});

// account_payment account_payment.py:116-128 `_onchange_set_payment_token_id`: no token unless the payment method is a
// provider's (payment.provider.code) with a customer and a journal
registerOnchange("account.payment", "_onchange_set_payment_token_id", ["partner_id", "payment_method_line_id", "journal_id"], async (env, rec) => {
  const codes = (env.reg.model("payment.provider").fields.get("code")?.selection ?? []).map((s) => s.value);
  const code = await rec.get("payment_method_code");
  if (typeof code === "string" && codes.includes(code) && m2o(await rec.get("commercial_partner_id"), "account.payment.commercial_partner_id") !== null
    && m2o(await rec.get("journal_id"), "account.payment.journal_id") !== null) {
    throw new NotPorted("account.payment._onchange_set_payment_token_id with a provider payment method (token search)");
  }
  await rec.set("payment_token_id", false);
});

/** `self.env.ref(xmlid)` of a group. */
async function groupId(env: Environment, xmlid: string): Promise<number> {
  const id = await env.reg.xmlid(env.cr, xmlid);
  if (typeof id !== "number") throw new NotPorted(`group ${xmlid}`);
  return id;
}
// stock stock_warehouse.py:100-111 `_onchange_company_id`
registerOnchange("stock.warehouse", "_onchange_company_id", ["company_id"], async (env, rec) => {
  const user = await groupId(env, "base.group_user");
  const implied = new Set((await env.cr.query<{ hid: number }>("SELECT hid FROM res_groups_implied_rel WHERE gid = $1", [user])).rows.map((r) => r.hid));
  if (!implied.has(await groupId(env, "stock.group_stock_multi_warehouses")) && !implied.has(await groupId(env, "stock.group_stock_multi_locations"))) {
    return { title: translate(env, "Warning", "stock"), message: translate(env, "Creating a new warehouse will automatically activate the Storage Locations setting", "stock") };
  }
});

/** res_currency.py:464-472 `_get_latest_rate` (stored rates of the currency: the rate `_order` is "name desc, id", so
 *  the last of `sorted('name')` is the highest id of the latest day). */
async function latestRate(env: Environment, rec: Rec): Promise<number | null> {
  const name = await rec.get("name");
  if (!name) throw new UserError(translate(env, "The name for the current rate is empty.\nPlease set it."));
  const currency = await rec.rel("currency_id");
  if (currency === null) return null;
  if (currency instanceof NewRec) {
    // the currency's form: `currency_id.rate_ids` are its lines, new or edited ones included (refused); a currency not
    // saved yet has no stored rate
    const lines = await currency.get("rate_ids");
    if (Array.isArray(lines) && lines.some((l) => l !== rec && l instanceof NewRec)) throw new NotPorted("res.currency.rate._onchange_rate_warning beside other edited rate lines");
    if (currency.origin === null) return null;
  }
  const companyValue = m2o(await rec.get("company_id"), "res.currency.rate.company_id");
  const company = companyValue ?? (await env.cr.query<{ r: number }>(
    "SELECT COALESCE(NULLIF(split_part(parent_path, '/', 1), '')::int, id) AS r FROM res_company WHERE id = $1", [await env.company()])).rows[0]!.r;
  const row = (await env.cr.query<{ rate: string }>(
    `SELECT rate::text AS rate FROM res_currency_rate WHERE currency_id = $1 AND rate IS NOT NULL AND rate != 0
       AND (company_id = $2 OR company_id IS NULL) AND name < $3 ORDER BY name DESC, id DESC LIMIT 1`, [currency.origin, company, name])).rows[0];
  return row ? Number(row.rate) : null;
}
// res_currency.py:518-531 `_onchange_rate_warning`
registerOnchange("res.currency.rate", "_onchange_rate_warning", ["company_rate"], async (env, rec) => {
  const latest = await latestRate(env, rec);
  if (!latest) return;
  const diff = (latest - Number((await rec.get("rate")) ?? 0)) / latest;
  if (Math.abs(diff) <= 0.2) return;
  const currency = await rec.rel("currency_id");
  const currencyName = currency ? String(await currency.get("name")) : "False";
  return {
    title: translate(env, "Warning for %s").replace("%s", currencyName),
    message: translate(env, "The new rate is quite far from the previous rate.\nIncorrect currency rates may cause critical problems, make sure the rate is correct!"),
  };
});
// res_currency.py:510-515 `_inverse_inverse_company_rate` (an onchange)
registerOnchange("res.currency.rate", "_inverse_inverse_company_rate", ["inverse_company_rate"], async (_env, rec) => {
  if (!Number((await rec.get("inverse_company_rate")) ?? 0)) await rec.set("inverse_company_rate", 1.0);
  await rec.set("company_rate", 1.0 / Number(await rec.get("inverse_company_rate")));
});

// base res_users.py:446-463 `_onchange_role`: for a regular user, group_user_regular is added unless implied already
// (refused: a new group line) and the settings group removed; the other roles add or reduce groups (refused)
registerOnchange("res.users", "_onchange_role", ["role"], async (env, rec) => {
  const role = await rec.get("role");
  if (role === "regular_user") {
    const regular = await groupId(env, "base.group_user_regular");
    // `all_group_ids` of the form's user: `group_ids.all_implied_ids` (res_users.py `_compute_all_group_ids`), the
    // transitive closure of res_groups_implied_rel
    const direct = idsOf(await rec.get("group_ids"), "res.users.group_ids");
    const all = direct.length === 0 ? [] : (await env.cr.query<{ id: number }>(
      `WITH RECURSIVE c(id) AS (SELECT unnest($1::int[]) UNION SELECT r.hid FROM res_groups_implied_rel r JOIN c ON r.gid = c.id)
       SELECT id FROM c`, [direct])).rows.map((r) => r.id);
    if (!all.includes(regular)) throw new NotPorted("res.users._onchange_role adding group_user_regular");
    const admin = await groupId(env, "base.group_system");
    const groups = await rec.get("group_ids");
    if (Array.isArray(groups) && groups.some((g) => g === admin || (g instanceof NewRec && g.origin === admin))) {
      throw new NotPorted("res.users._onchange_role removing the settings group");
    }
    return;
  }
  if (role) throw new NotPorted(`res.users._onchange_role to ${String(role)}`);
});
// mail res_users.py:182-185 `_onchange_out_of_office_from`
registerOnchange("res.users", "_onchange_out_of_office_from", ["out_of_office_from"], async (_env, rec) => {
  if (!(await rec.get("out_of_office_from"))) await rec.set("out_of_office_to", false);
});
