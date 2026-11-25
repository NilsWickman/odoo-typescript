/**
 * `account.move.send.wizard` (account/wizard/account_move_send_wizard.py) and the shared `account.move.send`
 * (account/models/account_move_send.py) with the installed extensions account_edi_ubl_cii and account_peppol, for the
 * single invoice dialog. The form opens, recomputes and saves; `action_send_and_print` sends the mail of a move with its
 * PDF (src/models/account_move_send_mail.ts), after rendering it with Browser Run where the engine exists (locally,
 * as on the oracle, Odoo's "Unable to find the pdf engine"). EDI formats refuse.
 * A partner with an EDI format and a company on Peppol refuse: they need the UBL builders or a network lookup.
 */
import { NotPorted, UserError } from "../errors";
import { registerMethod } from "../http/methods";
import { evalExprAsync } from "../pyexpr";
import { DbRec, registerDefaults, type Rec } from "../orm/recompute";
import { registerOverrides } from "../orm/write";
import type { Environment } from "../orm/types";
import { renderTemplateField } from "../qweb/mail_render";
import { PyRecords, registerPyMethod } from "../qweb/records";
import { checkPeppolPartnerEndpoint, defaultPdfReport, xmlidId } from "./account_buttons";
import { defineComputes, getLang } from "./tail_util";
import { peppolFormAction } from "./peppol_registration";
import { peppolProxyStateCanSend } from "./settings_computes";
import { translate } from "./util";
import { hasPdfEngine } from "../report/engine";
import { checkSendMail, createBinaryAttachment, sendMails, type SendSettings } from "./account_move_send_mail";
import { write } from "../orm/write";
import { idsModel, PrivateKwargs, PrivateRecords, privateNormal } from "../orm/private_hooks";
import * as priv from "../orm/dispatch_gen";

const WIZARD = "account.move.send.wizard";

// account/models/company.py:37-53
const PEPPOL_DEFAULT_COUNTRIES = ["AT", "BE", "CH", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "IE", "IS", "LT", "LU", "LV", "MT", "NL", "NO", "SE", "SI"];
const PEPPOL_LIST = [...PEPPOL_DEFAULT_COUNTRIES, "AD", "AL", "AX", "BA", "BG", "BL", "GB", "GF", "GP", "GR", "HR", "HU", "IT", "LI",
  "MC", "ME", "MF", "MK", "MQ", "NC", "PF", "PL", "PM", "PT", "RE", "RO", "RS", "SK", "SM", "TF", "TR", "VA", "WF", "YT"];
const ALWAYS_ON = ["BE", "FI", "LU", "LV", "NL", "NO", "SE", "FR"]; // account_peppol account_move_send.py:116

interface MoveData {
  id: number; company: number; partner: number; commercial: number; moveType: string; journal: number; state: string;
  pdf: number | null; countryCode: string | null;
}

async function moveData(env: Environment, wizard: Rec): Promise<MoveData> {
  const move = await wizard.rel("move_id");
  if (move === null || move.id === null) throw new NotPorted("account.move.send.wizard without a saved move");
  const r = (await env.cr.query<{ company_id: number; partner_id: number; commercial_partner_id: number; move_type: string; journal_id: number; state: string; pdf: number | null }>(
    `SELECT company_id, partner_id, commercial_partner_id, move_type, journal_id, state,
            (SELECT a.id FROM ir_attachment a WHERE a.res_model = 'account.move' AND a.res_id = m.id AND a.res_field = 'invoice_pdf_report_file' LIMIT 1) AS pdf
       FROM account_move m WHERE id = $1`, [move.id])).rows[0]!;
  const c = (await env.cr.query<{ code: string | null }>(
    "SELECT rc.code FROM res_company c JOIN res_partner p ON p.id = c.partner_id LEFT JOIN res_country rc ON rc.id = p.country_id WHERE c.id = $1", [r.company_id])).rows[0];
  return {
    id: move.id as number, company: r.company_id, partner: r.partner_id, commercial: r.commercial_partner_id, moveType: r.move_type, journal: r.journal_id, state: r.state,
    pdf: r.pdf, countryCode: c?.code ?? null,
  };
}

function companyEnv(env: Environment, company: number): Environment {
  return env.withContext({ ...env.context, allowed_company_ids: [company] });
}

/** account_peppol account_move_send.py:214-219 `_is_applicable_to_company`, as the refusal of an applicable company. */
async function refusePeppolCompany(env: Environment, m: MoveData): Promise<void> {
  await refusePeppolOf(env, m.company);
}

async function refusePeppolOf(env: Environment, company: number): Promise<void> {
  const r = (await env.cr.query<{ code: string | null; s: string | null }>(
    `SELECT rc.code, c.account_peppol_proxy_state AS s FROM res_company c JOIN res_partner p ON p.id = c.partner_id
       LEFT JOIN res_country rc ON rc.id = p.country_id WHERE c.id = $1`, [company])).rows[0];
  if (!r?.code || !PEPPOL_LIST.includes(r.code)) return;
  if (!["not_registered", "in_verification", "rejected"].includes(String(r.s))) throw new NotPorted("sending through Peppol");
}

/** The id of a record argument of a private method: PrivateRecords from the hand port, ids from a compiled super(). */
function oneId(x: unknown, model: string): number {
  const ids = x instanceof PrivateRecords && x.model === model ? x.ids : Array.isArray(x) && idsModel(x) === model ? x as number[] : null;
  if (ids?.length !== 1) throw new NotPorted(`a private method of the send wizard on other than one ${model}`);
  return ids[0]!;
}

/**
 * account_move_send.py:388-390 `_is_applicable_to_company` with account_peppol :214-219, a hook (l10n_dk's Nemhandel):
 * Peppol in a company that can send through it refuses (refusePeppolOf), else false; every other method applies.
 */
async function applicableToCompany(env: Environment, method: string, company: number): Promise<boolean> {
  const v = await priv.account_move_send_wizard._is_applicable_to_company.call(env, [], [method, new PrivateRecords("res.company", [company])], async (env2, _ids, args) => {
    if (args[0] !== "peppol") return true;
    await refusePeppolOf(env2, oneId(args[1], "res.company"));
    return false;
  });
  return Boolean(v);
}

/**
 * account_move_send.py:392-397 `_is_applicable_to_move` of a preferred method other than email, with
 * `_get_default_sending_settings(move)` as its keywords (wizard :146): account's True. A module's override needs those
 * settings, which the hand port does not build: refused where one is installed. Peppol never gets here
 * (applicableToCompany).
 */
async function applicableToMove(env: Environment, method: string): Promise<boolean> {
  if (method === "peppol") throw new NotPorted("_is_applicable_to_move of Peppol in the send wizard");
  if (await priv.account_move_send_wizard._is_applicable_to_move.overridden(env)) throw new NotPorted(`_is_applicable_to_move of a module for ${method}, with the send settings`);
  return true;
}

async function partnerRead(env: Environment, m: MoveData, fields: string[]): Promise<Record<string, unknown>> {
  return (await companyEnv(env, m.company).model("res.partner").read([m.commercial], fields, ""))[0]!;
}

/**
 * account.py :25-28 with account_peppol :17-27: `_is_applicable_to_move('peppol', move)` is false in a company that
 * cannot send through Peppol, after the endpoint verification of an unverified partner (a network lookup, refused).
 */
async function defaultSendingMethods(env: Environment, m: MoveData): Promise<string[]> {
  // `_get_default_sending_methods(move)` through the private hook (l10n_fr_pdp: email for a B2C invoice of a PDP
  // company), account's and account_peppol's below as the hand
  const v = await priv.account_move_send_wizard._get_default_sending_methods.call(env, [], [new PrivateRecords("account.move", [m.id])], async (e, _ids, args) => {
    if (oneId(args[0], "account.move") !== m.id) throw new NotPorted("_get_default_sending_methods of another move");
    return handDefaultSendingMethods(e, m);
  });
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new NotPorted("_get_default_sending_methods giving other than a list of methods");
  return v as string[];
}

async function handDefaultSendingMethods(env: Environment, m: MoveData): Promise<string[]> {
  await refusePeppolCompany(env, m);
  const p = await partnerRead(env, m, ["invoice_sending_method", "peppol_verification_state"]);
  const r = (await env.cr.query<{ s: string | null; e: string | null }>("SELECT routing_scheme AS s, routing_endpoint AS e FROM res_partner WHERE id = $1", [m.commercial])).rows[0];
  if (p["peppol_verification_state"] === "not_verified" && r?.s && r?.e) await checkPeppolPartnerEndpoint(env, m.commercial, m.company); // account_peppol account_move_send.py:227-228
  return [typeof p["invoice_sending_method"] === "string" ? p["invoice_sending_method"] : "email"];
}

/** ir_model_fields.py get_field_selection('res.partner', 'invoice_sending_method') without 'manual'. */
async function sendingMethodLabels(env: Environment): Promise<[string, string][]> {
  const lang = env.lang ?? "en_US";
  const rows = (await env.cr.query<{ value: string; name: string }>(
    `SELECT s.value, COALESCE(s.name->>$1, s.name->>'en_US') AS name FROM ir_model_fields_selection s JOIN ir_model_fields f ON f.id = s.field_id
      WHERE f.model = 'res.partner' AND f.name = 'invoice_sending_method' ORDER BY s.sequence, s.id`, [lang])).rows;
  return rows.filter((r) => r.value !== "manual").map((r) => [r.value, r.name]);
}

function selectedCheckboxes(json: unknown): string[] | null { // :348-352
  if (json === null || json === undefined || json === false || Object.keys(json as object).length === 0) return null;
  return Object.entries(json as Record<string, { checked: boolean }>).filter(([, v]) => v["checked"]).map(([k]) => k);
}

/**
 * account_move_send.py:45-47 `_get_default_invoice_edi_format(move, sending_methods=...)` with account_peppol :194-199,
 * a hook (l10n_dk's oioubl_21 for Nemhandel): the partner's `invoice_edi_format`, Peppol's format refused. Any format
 * refuses: sending it needs the UBL builders. `methods` is the wizard's `sending_methods or {}` (wizard :184).
 */
async function ediFormat(env: Environment, m: MoveData, methods: unknown): Promise<string | null> {
  const v = await priv.account_move_send_wizard._get_default_invoice_edi_format.call(env, [],
    [new PrivateRecords("account.move", [m.id]), new PrivateKwargs({ sending_methods: methods || {} })], async (env2, _ids, args) => {
      if (oneId(args[0], "account.move") !== m.id) throw new NotPorted("_get_default_invoice_edi_format of another move");
      const last = args[args.length - 1];
      const sm = last instanceof PrivateKwargs ? last.values["sending_methods"] : undefined;
      // account_peppol :197 `'peppol' in kwargs.get('sending_methods', [])`: a list or a dict's keys
      const peppol = Array.isArray(sm) ? sm.includes("peppol") : sm !== null && typeof sm === "object" && !(sm instanceof Map) ? "peppol" in sm : false;
      if (sm instanceof Map || (sm !== undefined && sm !== null && typeof sm !== "object")) throw new NotPorted("_get_default_invoice_edi_format with these sending methods");
      if (peppol) throw new NotPorted("_get_peppol_edi_format of a Peppol sending");
      return (await partnerRead(env2, m, ["invoice_edi_format"]))["invoice_edi_format"] || false;
    });
  if (v) throw new NotPorted(`invoice sending with the EDI format ${String(v)}`);
  return null;
}

async function templateId(env: Environment, m: MoveData): Promise<number> { // account_move.py:7137-7148
  if (m.moveType === "out_refund") return xmlidId(env, "account.email_template_edi_credit_note");
  if (m.moveType === "in_invoice" || m.moveType === "in_refund") {
    const r = (await env.cr.query<{ b: boolean | null }>("SELECT is_self_billing AS b FROM account_journal WHERE id = $1", [m.journal])).rows[0];
    if (r?.b) throw new NotPorted("self-billing mail templates");
  }
  return xmlidId(env, "account.email_template_edi_invoice");
}

/** mail_render_mixin.py:754-778 `_render_lang`: the template's `lang`, else the customer's. */
async function defaultMailLang(env: Environment, m: MoveData, template: number): Promise<string | null> {
  const lang = await renderTemplateField(env, template, "lang", m.id, env.lang ?? null);
  if (lang) return lang;
  const r = (await env.cr.query<{ lang: string | null }>("SELECT lang FROM res_partner WHERE id = $1", [m.partner])).rows[0];
  return r?.lang ?? null;
}

/** account_move_send.py:192-222 `_get_default_mail_partner_ids` for a template with `use_default_to`. */
async function defaultMailPartners(env: Environment, m: MoveData, template: number): Promise<number[]> {
  const t = (await env.cr.query<{ use_default_to: boolean | null }>("SELECT use_default_to FROM mail_template WHERE id = $1", [template])).rows[0];
  if (!t?.use_default_to) throw new NotPorted("_get_default_mail_partner_ids of a template without use_default_to");
  // mail/models/models.py:287-352 `_message_get_default_recipients` with the partner as only source (account.move has no email field)
  const p = (await env.cr.query<{ email: string | null; email_normalized: string | null; active: boolean }>(
    "SELECT p.email, p.email_normalized, p.active FROM res_partner p WHERE p.id = $1", [m.partner])).rows[0]!;
  const norm = p.email_normalized;
  if (norm) {
    const banned = (await env.cr.query(
      `SELECT 1 FROM res_partner r JOIN ir_model_data d ON d.res_id = r.id AND d.model = 'res.partner' AND d.module = 'base' AND d.name = 'partner_root' WHERE r.email_normalized = $1
       UNION ALL SELECT 1 FROM mail_alias a JOIN mail_alias_domain ad ON ad.id = a.alias_domain_id WHERE a.alias_name || '@' || ad.name = $1`, [norm])).rows.length > 0;
    if (banned) throw new NotPorted("default recipients with a banned email");
  }
  const partners = [m.partner];
  return env.context["allow_partners_without_mail"] ? partners : partners.filter(() => Boolean(p.email));
}

/** account_move.py:7685-7694 `_get_invoice_report_filename`. */
async function reportFilename(env: Environment, m: MoveData, report: number): Promise<string> {
  const rec = new PyRecords(env, "ir.actions.report", [report]);
  const expr = await rec.field("print_report_name");
  const name = typeof expr === "string" && expr
    ? await evalExprAsync(expr, new Map([["object", new PyRecords(env, "account.move", [m.id])]]))
    : await new PyRecords(env, "account.move", [m.id]).field("name");
  return `${String(name).replace(/\//g, "_")}.pdf`;
}

// account_move.py `_get_report_base_filename` -> `_get_move_display_name` (a posted move shows its name)
registerPyMethod("account.move", "_get_report_base_filename", async (recs) => {
  recs.ensureOne();
  if (await recs.field("state") === "draft") throw new NotPorted("_get_move_display_name of a draft move");
  return recs.field("name");
});

/** account_move_send.py:228-233 `_get_default_mail_attachments_widget`. */
async function attachmentsWidget(env: Environment, m: MoveData, template: number | null, report: number | null): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const pdf = report ?? await defaultPdfReport(env, m.id);
  // :256-275 the placeholder of the PDF to render, none when the move has its PDF
  if (m.pdf === null) {
    const filename = await reportFilename(env, m, pdf);
    out.push({ id: `placeholder_${filename}`, name: filename, mimetype: "application/pdf", placeholder: true });
  }
  if (template !== null) {
    const base = await xmlidId(env, "account.account_invoices");
    const extra = (await env.cr.query("SELECT 1 FROM mail_template_ir_actions_report_rel WHERE mail_template_id = $1 AND ir_actions_report_id <> ALL($2::int[])", [template, [pdf, base]])).rows;
    if (extra.length) throw new NotPorted("dynamic reports of a mail template");
  }
  // :308-322 `_get_invoice_extra_attachments_data`: the PDF (account_edi_ubl_cii :79-81 adds the UBL file: refused);
  // `_get_invoice_extra_attachments` through the private hook (l10n_it_edi: the FatturaPA file), refused where it
  // gives another attachment than the PDF
  if (m.pdf !== null) {
    const extra = await priv.account_move_send_wizard._get_invoice_extra_attachments.call(env, [], [new PrivateRecords("account.move", [m.id])],
      async () => new PrivateRecords("ir.attachment", [m.pdf!]));
    const ids = extra instanceof PrivateRecords ? extra.ids : Array.isArray(extra) && idsModel(extra) === "ir.attachment" ? extra as number[] : null;
    if (ids?.length !== 1 || ids[0] !== m.pdf) throw new NotPorted("_get_invoice_extra_attachments of a module giving other attachments than the PDF");
    const ubl = (await env.cr.query("SELECT 1 FROM ir_attachment WHERE res_model = 'account.move' AND res_id = $1 AND res_field = 'ubl_cii_xml_file'", [m.id])).rows.length;
    if (ubl) throw new NotPorted("mail attachments of a move with its UBL/CII file");
    const a = (await env.cr.query<{ id: number; name: string; mimetype: string | null }>("SELECT id, name, mimetype FROM ir_attachment WHERE id = $1", [m.pdf])).rows[0]!;
    out.push({ id: a.id, name: a.name, mimetype: a.mimetype ?? false, placeholder: false, protect_from_deletion: true });
  }
  if (template !== null) {
    const att = (await env.cr.query("SELECT 1 FROM email_template_attachment_rel WHERE email_template_id = $1", [template])).rows;
    if (att.length) throw new NotPorted("attachments of a mail template");
  }
  return out;
}

/**
 * account_peppol account_move_send.py:363-387 `action_what_is_peppol_activate(moves)` of one move: the registration
 * wizard's action (of the empty recordset: `res_id` False) in a company that cannot send, else the send wizard again.
 */
function whatIsPeppolActivate(env: Environment, m: MoveData, canSend: boolean): Record<string, unknown> {
  if (!canSend) {
    const action = peppolFormAction(env, false);
    action["context"] = { active_model: "account.move", active_ids: [m.id], dialog_size: "medium", ...(action["context"] as Record<string, unknown>) };
    return action;
  }
  return {
    name: translate(env, "Send", "account_peppol"),
    type: "ir.actions.act_window",
    view_mode: "form",
    res_model: WIZARD,
    target: "new",
    context: { active_model: "account.move", active_ids: [m.id] },
  };
}

/** account_peppol account_move_send.py:40-71 `_get_peppol_what_is_peppol_alert` of a company that is not French. */
function whatIsPeppolAlert(env: Environment, m: MoveData, canSend: boolean): Record<string, unknown> {
  return {
    level: "info",
    action_text: translate(env, "Why should you use it?", "account_peppol"),
    action: {
      name: translate(env, "Why should I use Peppol?", "account_peppol"),
      type: "ir.actions.client",
      tag: "account_peppol.what_is_peppol",
      target: "new",
      context: { footer: false, dialog_size: "medium", action_on_activate: whatIsPeppolActivate(env, m, canSend) },
    },
  };
}

/**
 * account :115-156, account_edi_ubl_cii :34-71, account_peppol :88-150 `_get_alerts` of one move: the hand port's part.
 * Without an EDI format (refused before, in the wizard's invoice_edi_format) account_edi_ubl_cii adds nothing; account's
 * missing e-mail alert refuses. account_peppol without a Peppol sending (a Peppol sending refuses): the what-is-Peppol
 * alert of an always-on company that cannot send, else the partner-wants-Peppol alert of one valid partner in a
 * default Peppol country, else the French PDP one (refused, as a French company's texts and l10n_fr_pdp's module info).
 */
async function handAlerts(env: Environment, w: Rec, m: MoveData, methods: string[] | null): Promise<Record<string, unknown> | null> {
  if (methods?.includes("peppol")) throw new NotPorted("alerts of a Peppol sending");
  const alerts: Record<string, unknown> = {};
  if (methods?.includes("email")) {
    const missing = [];
    for (const partner of await w.rels("mail_partner_ids")) if (!await partner.get("email")) missing.push(partner);
    if (missing.length) {
      alerts["account_missing_email"] = {
        level: "danger",
        message: translate(env, "Partner(s) should have an email address.", "account"),
        action_text: false,
        action: false,
      };
    }
  }
  const partner = await partnerRead(env, m, ["peppol_verification_state", "display_name"]);
  const state = partner["peppol_verification_state"];
  const r = (await env.cr.query<{ code: string | null; sent: boolean; fiscal: string | null; scheme: string | null }>(
    // account_peppol account_move.py:120-122 `_compute_peppol_is_sent` (not stored); res_company.py:145-150
    // `_peppol_is_french_company` reads the fiscal country and the company's routing scheme (its partner's)
    `SELECT rc.code, (SELECT COALESCE(peppol_move_state, 'ready') NOT IN ('ready', 'to_send', 'error', 'skipped') FROM account_move WHERE id = $2) AS sent,
            (SELECT fc.code FROM res_company c LEFT JOIN res_country fc ON fc.id = c.account_fiscal_country_id WHERE c.id = $3) AS fiscal,
            (SELECT cp.routing_scheme FROM res_company c JOIN res_partner cp ON cp.id = c.partner_id WHERE c.id = $3) AS scheme
       FROM res_partner p LEFT JOIN res_country rc ON rc.id = p.country_id WHERE p.id = $1`, [m.commercial, m.id, m.company])).rows[0]!;
  const french = ["FR", "GP", "MQ", "RE"].includes(String(r.fiscal)) || ["0225", "0009", "9957", "0002"].includes(String(r.scheme));
  const canSend = await peppolProxyStateCanSend(env, m.company);
  const alwaysOn = m.countryCode !== null && ALWAYS_ON.includes(m.countryCode) && !canSend;
  if (alwaysOn && !r.sent && state !== "not_valid" && state !== "not_verified") {
    if (french) throw new NotPorted("the account_peppol_what_is_peppol alert of a French company (l10n_fr_pdp)");
    alerts["account_peppol_what_is_peppol"] = {
      message: translate(env, "You can send this invoice electronically via Peppol.", "account_peppol"),
      ...whatIsPeppolAlert(env, m, canSend),
    };
  } else if (state === "valid" && !r.sent && r.code && PEPPOL_DEFAULT_COUNTRIES.includes(r.code)) {
    if (french) throw new NotPorted("the account_peppol_partner_want_peppol alert of a French company (l10n_fr_pdp)");
    alerts["account_peppol_partner_want_peppol"] = {
      message: translate(env, "%s has requested electronic invoices reception on Peppol.", "account_peppol").replace("%s", String(partner["display_name"])),
      ...whatIsPeppolAlert(env, m, canSend),
    };
  } else if (french) {
    // :138-147 unless account_peppol.disable_pdp_warning, and only for a company whose proxy is not the PDP's
    throw new NotPorted("the l10n_fr_pdp_what_is_pdp alert of a French company");
  }
  return Object.keys(alerts).length ? alerts : null;
}

const idOf = async (w: Rec, name: string): Promise<number | null> => {
  const v = await w.get(name);
  return typeof v === "number" ? v : null;
};

defineComputes(WIZARD, {
  // :103-114 `_get_alerts` (account :115-156, account_edi_ubl_cii :34-71, account_peppol :88-150): the alerts of a
  // company without Peppol on a customer without EDI format; the others refuse
  // `_get_alerts(moves, moves_data)` is a hook (l10n_ro_edi's waiting moves): moves_data as `_compute_alerts` builds it
  // (wizard :107-117); a module's alerts are the field's value
  alerts: async (env, w) => {
    const m = await moveData(env, w);
    const methods = (await w.get("sending_methods")) as string[] | null;
    const extra = (await w.get("extra_edis")) as string[] | null;
    const edi = await w.get("invoice_edi_format");
    const partners = (await w.rels("mail_partner_ids")).map((p) => p.id as number);
    const data = { sending_methods: methods || {}, invoice_edi_format: edi || false, extra_edis: extra || {}, mail_partner_ids: new PrivateRecords("res.partner", partners) };
    const moveKey = new PrivateRecords("account.move", [m.id]);
    const v = await priv.account_move_send_wizard._get_alerts.call(env, [], [moveKey, new Map([[moveKey, data]])], async (env2, _ids, args) => {
      if (oneId(args[0], "account.move") !== m.id) throw new NotPorted("_get_alerts of another move");
      const md = args[1];
      const same = md instanceof Map && md.size === 1 && oneId([...md.keys()][0], "account.move") === m.id
        && JSON.stringify(privateNormal([...md.values()][0])) === JSON.stringify(privateNormal(data));
      if (!same) throw new NotPorted("_get_alerts with other moves_data than the wizard's");
      return (await handAlerts(env2, w, m, methods)) ?? {};
    });
    if (v === null || v === false || (typeof v === "object" && !Array.isArray(v) && !(v instanceof Map) && Object.keys(v).length === 0)) return null;
    if (typeof v !== "object" || Array.isArray(v) || v instanceof Map) throw new NotPorted("_get_alerts giving other than a dict");
    return v;
  },
  sending_methods: async (_env, w) => selectedCheckboxes(await w.get("sending_method_checkboxes")),
  // :128-153 with account_peppol :39-73: the methods applicable to the company (no peppol line: applicableToCompany
  // refuses a company that could send through it), a preferred one checked when applicable to the move
  sending_method_checkboxes: async (env, w) => {
    const m = await moveData(env, w);
    const preferred = await defaultSendingMethods(env, m);
    const out: Record<string, { checked: boolean; label: string }> = {};
    for (const [key, label] of await sendingMethodLabels(env)) {
      if (!await applicableToCompany(env, key, m.company)) continue;
      out[key] = { checked: preferred.includes(key) && (key === "email" || await applicableToMove(env, key)), label };
    }
    return out;
  },
  // :155-161 `_display_attachments_widget(edi_format, sending_methods + extra_edis)` through the private hook (l10n_it_edi:
  // its SdI sending), account's `'email' in sending_methods` with account_edi_ubl_cii's as the hand (no EDI format here)
  display_attachments_widget: async (env, w) => {
    const methods = [...(((await w.get("sending_methods")) ?? []) as string[]), ...(((await w.get("extra_edis")) ?? []) as string[])];
    const edi = (await w.get("invoice_edi_format")) || false;
    const v = await priv.account_move_send_wizard._display_attachments_widget.call(env, [], [edi, methods], async (_e, _ids, args) => {
      if (args[0]) throw new NotPorted("_display_attachments_widget with an EDI format");
      const sm = args[1];
      if (!Array.isArray(sm)) throw new NotPorted("_display_attachments_widget with sending methods that are not a list");
      return sm.includes("email");
    });
    return Boolean(v);
  },
  extra_edis: async (_env, w) => selectedCheckboxes(await w.get("extra_edi_checkboxes")),
  // :170-177, `_get_all_extra_edis` is {} in account; a module's (l10n_ro_edi's E-Factura) gives functions to call on the
  // move, which the hand port cannot run: refused where one is installed
  extra_edi_checkboxes: async (env) => {
    if (await priv.account_move_send_wizard._get_all_extra_edis.overridden(env)) throw new NotPorted("_get_all_extra_edis of a module");
    return null;
  },
  invoice_edi_format: async (env, w) => ediFormat(env, await moveData(env, w), await w.get("sending_methods")),
  pdf_report_id: async (env, w) => defaultPdfReport(env, (await moveData(env, w)).id),
  // account_move.py:7242-7254 `_get_available_action_reports`
  available_pdf_report_ids: async (env) => {
    const rows = (await env.cr.query<{ id: number; domain: string | null }>(
      "SELECT id, domain FROM ir_act_report_xml WHERE model = 'account.move' AND is_invoice_report ORDER BY name::text, id")).rows;
    if (rows.some((r) => r.domain && r.domain.trim() !== "[]")) throw new NotPorted("invoice report with a domain");
    return rows.map((r) => r.id);
  },
  display_pdf_report_id: async (env, w) => (await w.rels("available_pdf_report_ids")).length > 1 && (await moveData(env, w)).pdf === null,
  template_id: async (env, w) => templateId(env, await moveData(env, w)),
  lang: async (env, w) => {
    const template = await idOf(w, "template_id");
    return template !== null ? defaultMailLang(env, await moveData(env, w), template) : (await getLang(env)).code;
  },
  mail_partner_ids: async (env, w) => { // :210-214
    const m = await moveData(env, w);
    const template = await idOf(w, "template_id");
    if (template !== null) return defaultMailPartners(env, m, template);
    const r = (await env.cr.query<{ email: string | null }>("SELECT email FROM res_partner WHERE id = $1", [m.commercial])).rows[0];
    return r?.email ? [m.commercial] : [];
  },
  subject: async (env, w) => {
    const template = await idOf(w, "template_id");
    if (template === null) return null;
    return (await renderTemplateField(env, template, "subject", (await moveData(env, w)).id, (await w.get("lang")) as string | null)) || null;
  },
  body: async (env, w) => {
    const template = await idOf(w, "template_id");
    if (template === null) return null;
    const html = await renderTemplateField(env, template, "body_html", (await moveData(env, w)).id, (await w.get("lang")) as string | null);
    const { sanitizeHtml } = await import("../orm/write_values");
    const def = env.reg.model(WIZARD);
    return html ? sanitizeHtml(env, def, def.fields.get("body")!, html) : null;
  },
  mail_attachments_widget: async (env, w) => { // :238-251
    const previous = ((await w.prev("mail_attachments_widget")) ?? []) as Record<string, unknown>[];
    const manual = Array.isArray(previous) ? previous.filter((x) => x["manual"]) : [];
    return [...await attachmentsWidget(env, await moveData(env, w), await idOf(w, "template_id"), await idOf(w, "pdf_report_id")), ...manual];
  },
  res_ids: async (_env, w) => `[${String(await w.get("move_id"))}]`, // :254-257, Text.convert_to_cache of a list
  // :261-266 `_compute_model` reads `self.env.context['active_model']`. A wizard created without an onchange (over RPC)
  // has it computed at the end of the request, by http/retrying.py:58 `env.cr.flush()` -> environments.py:741-744 the
  // transaction's default environment (the session's, without the call's `active_model`): it stays False. The client
  // gives `model` in the values (the form view has it), so only the onchange (a new record) reads the call's context.
  model: async (env, w) => (await w.prev("model")) || (w.id === null ? (env.context["active_model"] as string | undefined) : undefined) || null,
  can_edit_body: async (_env, w) => ((await w.get("sending_methods")) as string[] | null)?.includes("email") ?? false, // :270-273
  render_model: async () => "account.move", // :275-278
  // :340-344 with account_edi_ubl_cii wizard :7-20: no EDI format, nothing to refuse
  attachments_not_supported: async (env, w) => { await ediFormat(env, await moveData(env, w), await w.get("sending_methods")); return null; },
});

registerDefaults(WIZARD, {});

registerOverrides(WIZARD, {
  // :92-99 default_get
  defaultGet: async (env, fields, values) => {
    const activeIds = env.context["active_ids"];
    if (fields.includes("move_id") && !("move_id" in values) && Array.isArray(activeIds) && activeIds.length > 0 && typeof activeIds[0] === "number") {
      values["move_id"] = activeIds[0];
    }
  },
  // :344-347 `_check_move_id_constraints`, account_move_send.py:333-345
  constraints: [{
    fields: ["move_id"],
    fn: async (env, ids) => {
      const rows = (await env.cr.query<{ state: string; move_type: string }>(
        "SELECT m.state, m.move_type FROM account_move_send_wizard w JOIN account_move m ON m.id = w.move_id WHERE w.id = ANY($1::int[])", [[...ids]])).rows;
      for (const r of rows) {
        if (r.state !== "posted") throw new UserError(translate(env, "You can't generate invoices that are not posted."));
        if (!["out_invoice", "out_refund", "out_receipt"].includes(r.move_type)) throw new NotPorted("_get_move_constraints of a purchase document");
      }
    },
  }],
});

/**
 * :396-410 action_send_and_print as far as the PDF: the danger alerts (none ported), `_update_preferred_settings`
 * (:377-381), then `_generate_and_send_invoices` (account_move_send.py:850-877) renders the invoice PDF of a move
 * without one (:745-760 `_prepare_invoice_pdf_report` -> `_pre_render_qweb_pdf`), which raises without a PDF engine
 * (ir_actions_report.py:509-517), as on the recorded Odoo. A move with its PDF (the mail) and EDI formats refuse.
 */
registerMethod(WIZARD, "action_send_and_print", async (env, ids) => {
  if (ids?.length !== 1) throw new NotPorted("action_send_and_print of several wizards");
  const w = new DbRec(env, env.reg.model(WIZARD), ids[0]!);
  const alerts = await w.get("alerts");
  // :398-400 with account_move_send.py:327-330 `_raise_danger_alerts`: the messages of the danger alerts, if any
  if (alerts && typeof alerts === "object" && !Array.isArray(alerts)) {
    const danger = Object.values(alerts as Record<string, unknown>).filter((a) => a !== null && typeof a === "object" && (a as Record<string, unknown>)["level"] === "danger")
      .map((a) => (a as Record<string, unknown>)["message"]);
    if (danger.some((x) => typeof x !== "string")) throw new NotPorted("_raise_danger_alerts of an alert without a text message");
    if (danger.length) throw new UserError(danger.join("\n"));
  }
  const m = await moveData(env, w);
  const own = (await partnerRead(env, m, ["invoice_template_pdf_report_id"]))["invoice_template_pdf_report_id"];
  const chosen = await idOf(w, "pdf_report_id");
  if (!own && chosen !== (await defaultPdfReport(env, m.id))) throw new NotPorted("_update_preferred_settings of another PDF report");
  if (((await w.get("extra_edis")) as unknown[] | null)?.length) throw new NotPorted("send wizard extra EDIs");
  await ediFormat(env, m, await w.get("sending_methods"));
  await refusePeppolCompany(env, m); // account_peppol account_move_send.py:31-36: the endpoint check of a Peppol company
  if (m.pdf !== null || hasPdfEngine(env)) {
    const methods = ((await w.get("sending_methods")) ?? []) as string[];
    if (methods.some((x) => x !== "email")) throw new NotPorted(`send wizard sending methods ${methods.join(", ")}`);
    // :776-783 `_call_web_service_after_invoice_pdf_render(invoices_data)` after the PDF: account's and
    // account_peppol's do nothing without Peppol; a module's override needs Odoo's whole invoices_data, which the hand
    // port does not build: refused where one is installed
    // :762-766 `_hook_invoice_document_after_pdf_report_render(invoice, invoice_data)` and :466-485
    // `_link_invoice_documents(invoices_data)` (l10n_it_edi: the FatturaPA file), Odoo's whole invoice_data: the same
    for (const h of [priv.account_move_send_wizard._hook_invoice_document_after_pdf_report_render, priv.account_move_send_wizard._link_invoice_documents]) {
      if (await h.overridden(env)) throw new NotPorted(`${h.name} of a module`);
    }
    // :730-736 `_call_web_service_before_invoice_pdf_render(invoices_data)` (l10n_hu_edi: the NAV upload), the same
    if (await priv.account_move_send_wizard._call_web_service_before_invoice_pdf_render.overridden(env)) throw new NotPorted("_call_web_service_before_invoice_pdf_render of a module");
    if (await priv.account_move_send_wizard._call_web_service_after_invoice_pdf_render.overridden(env)) throw new NotPorted("_call_web_service_after_invoice_pdf_render of a module");
    // :724-725 `_hook_invoice_document_before_pdf_report_render(invoice, invoice_data)` with the same invoices_data
    if (await priv.account_move_send_wizard._hook_invoice_document_before_pdf_report_render.overridden(env)) throw new NotPorted("_hook_invoice_document_before_pdf_report_render of a module");
    const settings: SendSettings = {
      move: m.id, company: m.company, partner: m.partner, journal: m.journal, moveType: m.moveType,
      template: await idOf(w, "template_id"), lang: (await w.get("lang")) as string | null, body: (await w.get("body")) as string | null,
      subject: (await w.get("subject")) as string | null, partnerIds: (await w.rels("mail_partner_ids")).map((p) => p.id as number),
      widget: (((await w.get("mail_attachments_widget")) ?? []) as Record<string, unknown>[]),
    };
    if (methods.includes("email")) await checkSendMail(env, settings);
    if (m.pdf === null) {
      // with Browser Run (the deployed Worker): :735-760 `_prepare_invoice_pdf_report` renders the chosen report
      // `with_company(move.company_id)` (D8b: Chromium, so other bytes than wkhtmltopdf's), then :466-485
      // `_link_invoice_documents`: the sudo attachment of `invoice_pdf_report_file`, the main attachment and is_move_sent
      const report = chosen ?? await defaultPdfReport(env, m.id);
      const name = (await env.cr.query<{ n: string }>("SELECT report_name AS n FROM ir_act_report_xml WHERE id = $1", [report])).rows[0]!.n;
      const allowed = ((env.context["allowed_company_ids"] as number[] | undefined) ?? []).filter((c) => c !== m.company);
      const { renderReportPdfInRequest } = await import("../controllers/report");
      const content = await renderReportPdfInRequest(env.withContext({ ...env.context, allowed_company_ids: [m.company, ...allowed] }), name, [m.id]);
      const att = await createBinaryAttachment(env.sudo(), {
        name: await reportFilename(env, m, report), description: null, data: content, mimetype: "application/pdf",
        resModel: "account.move", resId: m.id, resField: "invoice_pdf_report_file", company: m.company,
      });
      await write(env.sudo(), "account.move", [m.id], { message_main_attachment_id: att });
      await write(env.sudo(), "account.move", [m.id], { is_move_sent: true });
    }
    if (methods.includes("email")) await sendMails(env, settings);
    else await write(env.sudo(), "account.move", [m.id], { sending_data: false });
    // :407-410 no 'manual' method: the dialog closes
    return { type: "ir.actions.act_window_close" };
  }
  throw new UserError(translate(env, "Unable to find the pdf engine on this system. The PDF can not be created."));
}, { apiModel: false });
