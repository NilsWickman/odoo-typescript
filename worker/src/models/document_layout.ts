/**
 * `base.document.layout` (odoo/addons/web/models/base_document_layout.py, extended by
 * odoo/addons/account/wizard/base_document_layout.py): the layout configurator of the first send or print.
 */
import { activateOrCreatePricelists } from "./invoicing_computes";
import { refuseAccountCompanyWrites, validateLocks } from "./account_locks";
import { AccessError, NotPorted } from "../errors";
import { decodePng, resizeNearest } from "../image/png";
import { renderQweb } from "../controllers/report";
import { registerMethod } from "../http/methods";
import { hasGroup } from "../orm/env";
import { create as ormCreate } from "../orm/create";
import { DbRec, NewRec, type Rec, registerDefaults, registerOnchange } from "../orm/recompute";
import { registerOverrides, write as ormWrite } from "../orm/write";
import type { Environment } from "../orm/types";
import { escape, Markup } from "../pyexpr/values";
import { nl2br } from "../qweb/fields";
import { isHtmlEmpty, reportHelpers } from "../qweb/helpers";
import { PyEnv, PyNewRecord, PyRecords } from "../qweb/records";
import { compileCompanyScss } from "../qweb/scss";
import { displayAddresses } from "./mail_address";
import { defineComputes } from "./tail_util";
import { xmlidId } from "./account_buttons";
import { companyCreate, companyDefaultForInverse } from "./company_create";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "../filestore";
import { requestOfCursor } from "../http/context";
import { indexContent } from "../mail/attachment";
import * as priv from "../orm/dispatch_gen";

const DEFAULT_PRIMARY = "#000000", DEFAULT_SECONDARY = "#000000";
const COMPANY_FIELDS = ["logo", "report_header", "report_footer", "company_details", "paperformat_id", "font", "primary_color", "secondary_color", "report_tables_id", "qr_code", "vat"]; // :4-16

type Rgb = [number, number, number];
type Color = [number, [number, number, number, number]];

function compareColors(a: Color, b: Color): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  for (let i = 0; i < 4; i++) if (a[1][i] !== b[1][i]) return a[1][i]! - b[1][i]!;
  return 0;
}

/** tools/image.py:329-393 average_dominant_color. */
function averageDominantColor(colors: Color[], mitigate = 175, maxMargin = 140): [Rgb, Color[]] {
  const dominant = colors.reduce((m, c) => (compareColors(c, m) > 0 ? c : m));
  const margin = maxMargin * (1 - dominant[0] / colors.reduce((s, c) => s + c[0], 0));
  const inSet = [dominant];
  const remaining: Color[] = [];
  for (const c of colors) {
    if (c === dominant) continue;
    const near = [0, 1, 2].every((b) => c[1][b]! < dominant[1][b]! + margin && c[1][b]! > dominant[1][b]! - margin);
    (near ? inSet : remaining).push(c);
  }
  const avg = [0, 1, 2].map((band) => {
    let sum = 0, total = 0;
    for (const c of inSet) { sum += c[0] * c[1][band]!; total += c[0]; }
    return Math.trunc(sum / total);
  });
  const brightest = Math.max(...avg);
  return [avg.map((v) => Math.trunc(brightest > mitigate ? v / (brightest / mitigate) : v)) as Rgb, remaining];
}

const lightness = (c: Rgb): number => (Math.max(...c) + Math.min(...c)) / 2 / 255; // :600
function saturation(c: Rgb): number { // :589
  const max = Math.max(...c) / 255, min = Math.min(...c) / 255, d = max - min;
  return d === 0 ? 0 : d / (1 - Math.abs(max + min - 1));
}
const rgbToHex = (c: Rgb): string => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`; // :612

/** The raw bytes of a binary field value of a wizard. */
async function binaryContent(value: unknown): Promise<Uint8Array | null> {
  if (value === null || value === undefined || value === false) return null;
  if (typeof value === "string") return new Uint8Array(Buffer.from(value, "base64"));
  if (typeof value === "object" && "content" in value && typeof value.content === "function") return (value.content as () => Promise<Uint8Array>)();
  throw new NotPorted("logo value of base.document.layout");
}

/** base_document_layout.py:171-232 `extract_image_primary_secondary_colors` (decoding: src/image/png.ts). */
export async function extractColors(logo: unknown, whiteThreshold = 225, mitigate = 175): Promise<[string | false, string | false]> {
  const bytes = await binaryContent(logo);
  if (bytes === null) return [false, false];
  const image = await decodePng(bytes);
  const w = Math.ceil(50 * image.width / image.height), h = 50;
  const small = resizeNearest(image, w, h);
  const counts = new Map<number, Color>();
  for (let i = 0; i < w * h; i++) {
    const [r, g, b, a] = small.data.subarray(i * 4, i * 4 + 4) as unknown as [number, number, number, number];
    if ((r > whiteThreshold && g > whiteThreshold && b > whiteThreshold) || a <= 0) continue;
    const key = r * 2 ** 24 + (g << 16) + (b << 8) + a;
    const c = counts.get(key);
    if (c) c[0]++;
    else counts.set(key, [1, [r, g, b, a]]);
  }
  const colors = [...counts.values()];
  if (!colors.length) return [false, false];
  let [primary, remaining] = averageDominantColor(colors, mitigate);
  let secondary = remaining.length ? averageDominantColor(remaining, mitigate)[0] : primary;
  const lp = lightness(primary), ls = lightness(secondary);
  if ((lp < 0.2 && ls < 0.2) || (lp >= 0.2 && ls >= 0.2)) {
    if (saturation(primary) < saturation(secondary)) [primary, secondary] = [secondary, primary];
  } else if (ls > lp) [primary, secondary] = [secondary, primary];
  return [rgbToHex(primary), rgbToHex(secondary)];
}

/** account/wizard/base_document_layout.py:30-38 `_check_company_access`. */
async function checkCompanyAccess(env: Environment, companies: readonly number[]): Promise<void> {
  const allowed = await env.companies();
  if (!companies.length || companies.some((c) => !allowed.includes(c))) throw new AccessError("You cannot configure the document layout for this company.");
}

/** :102-106 `_is_account_layout_configurator`. */
async function isConfigurator(env: Environment): Promise<boolean> {
  return !!env.context["account_document_layout_configurator"] && await hasGroup(env, "account.group_account_basic");
}

const previewTemplate = (env: Environment): string => // sale wizard/base_document_layout.py:9-14, account :72-78
  (env.context["active_model"] === "sale.order" && env.context["active_id"] ? "sale.quote_document_layout_preview"
    : env.context["active_model"] === "account.move" && env.context["active_id"] ? "account.report_invoice_wizard_iframe" : "web.report_invoice_wizard_preview");

/** `ir.ui.view._prepare_qcontext` of a server render. */
async function qcontext(env: Environment): Promise<Record<string, unknown>> {
  return { user: new PyRecords(env, "res.users", [env.uid]), res_company: new PyRecords(env.sudo(), "res.company", [await env.company()]), env: new PyEnv(env), ...reportHelpers(env) };
}

/** :39-58 `_get_accessible_preview_move`. */
async function previewMove(env: Environment, wizard: Rec): Promise<PyRecords> {
  const activeId = env.context["active_id"];
  if (env.context["active_model"] !== "account.move" || !activeId) return new PyRecords(env, "account.move", []);
  const move = (await env.cr.query<{ company_id: number }>("SELECT company_id FROM account_move WHERE id = $1", [activeId])).rows[0];
  if (move === undefined) throw new AccessError("You cannot preview this invoice.");
  await env.model("account.move").checkAccess([activeId as number], "read");
  if (move.company_id !== await wizard.get("company_id")) throw new AccessError("You cannot preview this invoice.");
  return new PyRecords(env, "account.move", [activeId as number]);
}

/** account :114-140 `_compute_preview` over web :96-108, `_get_render_information` (account :80-98, web :110-117). */
async function computePreview(env: Environment, wizard: Rec): Promise<unknown> {
  const configurator = await isConfigurator(env);
  if (configurator) await checkCompanyAccess(env, [await wizard.get("company_id") as number]);
  if (!await wizard.get("report_layout_id")) return null;
  const self = wizard instanceof NewRec ? new PyNewRecord(wizard) : new PyRecords(env, "base.document.layout", [wizard.id as number]);
  const scss = await renderQweb(configurator ? env.sudo() : env, "web.styles_company_report", { company_ids: [self], ...await qcontext(env) });
  const values: Record<string, unknown> = {
    ...await qcontext(env), company: self, preview_css: scss.trim() ? new Markup(compileCompanyScss(scss)) : "", is_html_empty: isHtmlEmpty,
  };
  const template = previewTemplate(env);
  if (env.context["active_model"] === "account.move" && env.context["active_id"]) {
    values["o"] = new PyRecords(env, "account.move", [env.context["active_id"] as number]);
  }
  values["qr_code"] = Boolean(await wizard.get("qr_code"));
  values["account_number"] = (await wizard.get("account_number")) ?? false;
  if (configurator) {
    const move = await previewMove(env, wizard);
    if (move.ids.length) values["o"] = move;
  }
  // sale wizard/base_document_layout.py:16-22: the order being sent
  if (env.context["active_model"] === "sale.order" && env.context["active_id"]) values["doc"] = new PyRecords(env, "sale.order", [env.context["active_id"] as number]);
  return renderQweb(env, template, values);
}

/**
 * The defaults of report_footer and company_details are the private methods `_default_report_footer` and
 * `_default_company_details` (`default=_default_x`, fields.py:545 calls that function), run through the private hook
 * (src/orm/private_hooks.ts): a site's compiled override (l10n_din5008, l10n_fr_account, l10n_ma, l10n_mu_account)
 * runs around web's definition here. Every such module also redefines the field with its own function as default,
 * so Odoo runs the override wherever the hook does (compiler/private_hooks_check.py `default_of`). The value goes to
 * the compiled side as the Markup Odoo's returns (`super() + Markup(...)` in l10n_fr_account concatenates, a str
 * would be escaped), and comes back as the field's string.
 */
const markupOut = (v: unknown): unknown => (v instanceof Markup ? v.toString() : v);

registerDefaults("base.document.layout", {
  company_id: async (env) => env.company(), // :38
  // :27-30
  report_footer: async (env) => markupOut(await priv.base_document_layout._default_report_footer.call(env, [], [], async (e) => {
    const c = await companyRec(e);
    const parts: string[] = [];
    for (const name of ["phone", "email", "website", "vat"]) {
      const v = await c.get(name);
      if (typeof v === "string" && v.length) parts.push(escape(v).toString());
    }
    return new Markup(parts.join(" "));
  })),
  // :32-35 nl2br_enclose(company.partner_id.contact_address, 'div')
  company_details: async (env) => markupOut(await priv.base_document_layout._default_company_details.call(env, [], [], async (e) => {
    const c = await companyRec(e);
    const address = (await displayAddresses(e, [await c.get("partner_id") as number], false, "\n")).get(await c.get("partner_id") as number);
    if (typeof address !== "string") throw new NotPorted("company_details default of a company without address");
    return new Markup(`<div>${nl2br(address).toString()}</div>`);
  })),
});

async function companyRec(env: Environment): Promise<Rec> {
  return new DbRec(env, env.reg.model("res.company"), await env.company());
}

defineComputes("base.document.layout", {
  // :76-87
  custom_colors: async (_env, w) => {
    const lp = String((await w.get("logo_primary_color")) || ""), ls = String((await w.get("logo_secondary_color")) || "");
    const p = await w.get("primary_color"), s = await w.get("secondary_color");
    return Boolean(await w.get("logo") && p && s && !(String(p).toLowerCase() === lp.toLowerCase() && String(s).toLowerCase() === ls.toLowerCase()));
  },
  logo_primary_color: async (_env, w) => (await extractColors(await w.get("logo")))[0] || null,
  logo_secondary_color: async (_env, w) => (await extractColors(await w.get("logo")))[1] || null,
  preview: computePreview,
  is_company_details_empty: async (_env, w) => isHtmlEmpty(await w.get("company_details")),
  // account :108-112
  account_number: async (_env, w) => {
    const partner = await w.rel("partner_id");
    const banks = partner ? await partner.rels("bank_ids") : [];
    return banks.length ? (await banks[0]!.get("account_number")) || "" : "";
  },
  can_configure_later: async (env) => Boolean(env.context["can_configure_later"]), // account :142-146
});

// web :122-148, account :179-193
registerOnchange("base.document.layout", "_onchange_company_id", ["company_id"], async (env, rec) => {
  if (await isConfigurator(env)) await checkCompanyAccess(env, [await rec.get("company_id") as number]);
  const wizard = rec as NewRec;
  const company = await wizard.rel("company_id");
  if (company === null) throw new NotPorted("_onchange_company_id without company");
  await wizard.set("logo", await company.get("logo"));
  await wizard.set("report_header", await company.get("report_header"));
  const footer = await company.get("report_footer"), details = await company.get("company_details");
  if (typeof footer === "string") await wizard.set("report_footer", footer);
  if (typeof details === "string") await wizard.set("company_details", details);
  await wizard.set("paperformat_id", await company.get("paperformat_id"));
  await wizard.set("external_report_layout_id", await company.get("external_report_layout_id"));
  await wizard.set("font", await company.get("font"));
  await wizard.set("primary_color", await company.get("primary_color"));
  await wizard.set("secondary_color", await company.get("secondary_color"));
  const view = await company.rel("external_report_layout_id");
  const key = view ? await view.get("key") : null;
  const layout = (await env.cr.query<{ id: number }>(
    `SELECT l.id FROM report_layout l JOIN ir_ui_view v ON v.id = l.view_id WHERE v.key = $1 ORDER BY l.sequence, l.id`, [key])).rows;
  if (layout.length > 1) throw new NotPorted("several report.layout of one view");
  const first = layout[0] ?? (await env.cr.query<{ id: number }>("SELECT id FROM report_layout ORDER BY sequence, id LIMIT 1")).rows[0];
  await wizard.set("report_layout_id", first?.id ?? null);
  if (!await wizard.get("primary_color")) await wizard.set("primary_color", (await wizard.get("logo_primary_color")) || DEFAULT_PRIMARY);
  if (!await wizard.get("secondary_color")) await wizard.set("secondary_color", (await wizard.get("logo_secondary_color")) || DEFAULT_SECONDARY);
});

registerOnchange("base.document.layout", "_onchange_custom_colors", ["custom_colors"], async (_env, rec) => {
  const w = rec as NewRec;
  if (await w.get("logo") && !await w.get("custom_colors")) {
    await w.set("primary_color", (await w.get("logo_primary_color")) || DEFAULT_PRIMARY);
    await w.set("secondary_color", (await w.get("logo_secondary_color")) || DEFAULT_SECONDARY);
  }
});

registerOnchange("base.document.layout", "_onchange_report_layout_id", ["report_layout_id"], async (_env, rec) => {
  const w = rec as NewRec;
  const layout = await w.rel("report_layout_id");
  await w.set("external_report_layout_id", layout ? await layout.get("view_id") : null);
});

registerOnchange("base.document.layout", "_onchange_logo", ["logo"], async (_env, rec) => {
  const w = rec as NewRec;
  const company = await w.rel("company_id");
  if (company === null) throw new NotPorted("_onchange_logo without company");
  const mine = await binaryContent(await w.get("logo")), theirs = await binaryContent(await company.get("logo"));
  const same = mine === null || theirs === null ? mine === theirs : Buffer.compare(mine, theirs) === 0;
  if (same && await company.get("primary_color") && await company.get("secondary_color")) return;
  const p = await w.get("logo_primary_color"), s = await w.get("logo_secondary_color");
  if (p) await w.set("primary_color", p);
  if (s) await w.set("secondary_color", s);
});

/** account :164-177 `_extract_company_layout_vals`: moves the company fields out of `vals`. */
async function extractCompanyVals(env: Environment, vals: Record<string, unknown>): Promise<Record<string, unknown>> {
  delete vals["external_report_layout_id"];
  const out: Record<string, unknown> = {};
  for (const name of COMPANY_FIELDS) {
    if (name in vals) { out[name] = vals[name]; delete vals[name]; }
  }
  if ("report_layout_id" in vals) {
    const id = vals["report_layout_id"];
    const row = id ? (await env.cr.query<{ view_id: number }>("SELECT view_id FROM report_layout WHERE id = $1", [id])).rows[0] : undefined;
    out["external_report_layout_id"] = row?.view_id ?? false;
  }
  return out;
}

const STYLE_FIELDS = ["external_report_layout_id", "font", "primary_color", "secondary_color"];

/**
 * web models.py:2445-2461 `_get_asset_style_raw` and `_update_asset_style`: `web.styles_company_report` rendered for
 * every company (`search([])`: active ones, `sequence, name`), written into the `web.asset_styles_company_report`
 * attachment when the bytes differ (`raw = data`: ir_attachment.py:395-421 `_inverse_raw` with :424-440, the mimetype
 * guessed from the text content, :561 `_index`).
 */
export async function updateAssetStyle(env: Environment): Promise<void> {
  const su = env.sudo();
  // env.ref(..., raise_if_not_found=False)
  const attachment = (await su.cr.query<{ res_id: number }>("SELECT res_id FROM ir_model_data WHERE module = 'web' AND name = 'asset_styles_company_report'")).rows[0]?.res_id;
  if (!attachment) return;
  const companies = (await su.cr.query<{ id: number }>("SELECT id FROM res_company WHERE active ORDER BY sequence, name, id")).rows.map((r) => r.id);
  const scss = await renderQweb(su, "web.styles_company_report", { company_ids: new PyRecords(su, "res.company", companies), ...await qcontext(su) });
  const data = new TextEncoder().encode(String(scss));
  const row = (await su.cr.query<{ store_fname: string | null; db_datas: Buffer | null }>("SELECT store_fname, db_datas FROM ir_attachment WHERE id = $1", [attachment])).rows[0];
  if (!row) return;
  const ctx = requestOfCursor(su.cr);
  if (ctx === null || ctx.db === null) throw new NotPorted("_update_asset_style outside a request");
  const current = row.db_datas ?? (row.store_fname ? await readFile(ctx.env, ctx.db, row.store_fname) : new Uint8Array());
  if (current !== null && Buffer.compare(Buffer.from(current), Buffer.from(data)) === 0) return;
  // guess_mimetype of the rendered text: plain printable text is text/plain; anything else refuses
  if (data.some((b) => (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b > 0x7e)) throw new NotPorted("guess_mimetype of company styles with non-ASCII text");
  if ((await su.cr.query("SELECT 1 FROM ir_config_parameter WHERE key = 'ir_attachment.location' AND value != 'file'")).rows.length) throw new NotPorted("database attachment storage");
  const checksum = createHash("sha1").update(data).digest("hex");
  const storeFname = `${checksum.slice(0, 2)}/${checksum}`;
  await writeFile(ctx.env, ctx.db, storeFname, data);
  await su.cr.query(
    `UPDATE ir_attachment SET checksum = $2, file_size = $3, mimetype = 'text/plain', store_fname = $4, db_datas = NULL, index_content = $5,
       write_uid = $6, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1`,
    [attachment, checksum, data.length, storeFname, indexContent(data, "text/plain"), su.uid]);
}

registerOverrides("res.company", {
  inverse: companyDefaultForInverse,
  // web models.py:2429-2442: a write or create touching the style fields updates the shared style attachment
  create: async (env, valsList, next) => {
    // base res_company.py:348-396 and the modules' overrides (src/models/company_create.ts)
    const ids = await companyCreate(env, valsList, next);
    if (valsList.some((v) => STYLE_FIELDS.some((f) => f in v))) await updateAssetStyle(env);
    return ids;
  },
  write: async (env, ids, vals, next) => {
    // account company.py:897-912 before super(): the lock dates are validated, code prefix changes refuse
    await validateLocks(env, ids, vals);
    await refuseAccountCompanyWrites(env, ids, vals);
    // base res_company.py:410-413, :439-440: the first country of a company installs its localization module
    if (vals["country_id"] && (await env.cr.query("SELECT 1 FROM res_company c JOIN res_partner p ON p.id = c.partner_id WHERE c.id = ANY($1::int[]) AND p.country_id IS NULL LIMIT 1", [[...ids]])).rows.length) {
      throw new NotPorted("res.company write of the first country_id (install_l10n_modules)");
    }
    // product res_company.py:47-67: a new currency may enable the pricelists; the write runs with
    // disable_company_pricelist_creation and the default pricelists are created after it
    const currency = vals["currency_id"];
    const pricelistsBefore = currency ? await hasGroup(env, "product.group_product_pricelist") : true;
    const wenv = currency ? env.withContext({ ...env.context, disable_company_pricelist_creation: true }) : env;
    // base res_company.py:402-405: the company's new currency is activated
    if (currency && (await env.cr.query("SELECT 1 FROM res_currency WHERE id = $1 AND NOT active", [currency])).rows.length) {
      await ormWrite(wenv, "res.currency", [currency as number], { active: true });
    }
    const out = await next(wenv, ids, vals);
    if (STYLE_FIELDS.some((f) => f in vals)) await updateAssetStyle(env);
    if (!pricelistsBefore && await hasGroup(env, "product.group_product_pricelist")) await activateOrCreatePricelists(env);
    return out;
  },
});

/** `company.sudo().write(company_vals)`; logo_web follows the partner's image (src/orm/image_write.ts). */
async function writeCompany(env: Environment, company: number, vals: Record<string, unknown>): Promise<void> {
  await ormWrite(env.sudo(), "res.company", [company], vals);
}

registerOverrides("base.document.layout", {
  // account :200-226
  create: async (env, valsList, next) => {
    if (!await isConfigurator(env)) return next(env, valsList);
    const list = valsList.map((v) => ({ ...v }));
    const companies: number[] = [];
    const companyVals: Record<string, unknown>[] = [];
    for (const vals of list) {
      const company = (vals["company_id"] as number) || await env.company();
      await checkCompanyAccess(env, [company]);
      vals["company_id"] = company;
      companies.push(company);
      companyVals.push(await extractCompanyVals(env, vals));
    }
    const ids = await next(env.sudo(), list);
    for (const [i, company] of companies.entries()) {
      if (Object.keys(companyVals[i]!).length) await writeCompany(env, company, companyVals[i]!);
    }
    return ids;
  },
  // account :228-246
  write: async (env, ids, raw, next) => {
    if (!await isConfigurator(env)) return next(env, ids, raw);
    const vals = { ...raw };
    let companies: number[];
    if ("company_id" in vals) companies = [vals["company_id"] as number];
    else companies = (await env.cr.query<{ company_id: number }>("SELECT DISTINCT company_id FROM base_document_layout WHERE id = ANY($1::int[])", [[...ids]])).rows.map((r) => r.company_id);
    await checkCompanyAccess(env, companies);
    const companyVals = await extractCompanyVals(env, vals);
    await next(env, ids, vals);
    if (Object.keys(companyVals).length) for (const c of companies) await writeCompany(env, c, companyVals);
  },
  inverse: {
    // account :148-162
    account_number: async (env, ids) => {
      for (const id of ids) {
        const w = new DbRec(env, env.reg.model("base.document.layout"), id);
        const number = await w.get("account_number");
        const partner = await w.rel("partner_id");
        const banks = partner ? await partner.rels("bank_ids") : [];
        if (banks.length && number) {
          if (await banks[0]!.get("account_number") !== number) throw new NotPorted("base.document.layout: changing the bank account number");
        } else if (number) throw new NotPorted("base.document.layout: _find_or_create_bank_account");
      }
    },
  },
});

/** onboarding_onboarding_step.py:94-98 and :113-133, onboarding_progress_step.py:28-31 for one company. */
async function stepJustDone(env: Environment, step: number, company: number): Promise<void> {
  const su = env.sudo();
  const existing = (await su.cr.query<{ id: number; step_state: string }>(
    "SELECT id, step_state FROM onboarding_progress_step WHERE step_id = $1 AND (company_id IS NULL OR company_id = $2)", [step, company])).rows[0];
  if (existing) {
    if (existing.step_state === "not_done") await ormWrite(su, "onboarding.progress.step", [existing.id], { step_state: "just_done" });
    return;
  }
  const row = (await su.cr.query<{ is_per_company: boolean }>("SELECT is_per_company FROM onboarding_onboarding_step WHERE id = $1", [step])).rows[0];
  const progress = (await su.cr.query<{ id: number }>(
    `SELECT p.id FROM onboarding_progress p WHERE p.onboarding_id IN (
       SELECT onboarding_onboarding_id FROM onboarding_onboarding_onboarding_onboarding_step_rel WHERE onboarding_onboarding_step_id = $1)
       AND (p.company_id IS NULL OR p.company_id = $2) ORDER BY p.id`, [step, company])).rows;
  const [id] = await ormCreate(su, "onboarding.progress.step", [{
    step_id: step, company_id: row?.is_per_company ? company : false, progress_ids: progress.map((p) => [4, p.id, 0]),
  }]);
  await ormWrite(su, "onboarding.progress.step", [id!], { step_state: "just_done" });
}

// web :119-121 with account :60-70
registerMethod("base.document.layout", "document_layout_save", async (env, recordIds) => {
  const ids = recordIds ?? [];
  const action = env.context["report_action"];
  const res = (action ? { ...(action as Record<string, unknown>) } : { type: "ir.actions.act_window_close" }) as Record<string, unknown>;
  const step = await xmlidId(env, "account.onboarding_onboarding_step_base_document_layout");
  const companies = (await env.cr.query<{ company_id: number }>("SELECT DISTINCT company_id FROM base_document_layout WHERE id = ANY($1::int[])", [[...ids]])).rows;
  for (const c of companies) await stepJustDone(env, step, c.company_id);
  if (res["context"]) res["context"] = { ...(res["context"] as Record<string, unknown>), dialog_size: "large" };
  return res;
}, { apiModel: false });

// account :248-256
registerMethod("base.document.layout", "action_configure_later", async (env, ids) => {
  if (ids?.length !== 1) throw new Error("ValueError: Expected singleton");
  const report = env.context["report_action"];
  if (!report) return { type: "ir.actions.act_window_close" };
  const r = (await env.cr.query<{ company_id: number }>("SELECT company_id FROM base_document_layout WHERE id = $1", [ids[0]])).rows[0]!;
  await checkCompanyAccess(env, [r.company_id]);
  await ormWrite(env.sudo(), "res.company", [r.company_id], { external_report_layout_id: false });
  return report;
}, { apiModel: false });
