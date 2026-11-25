/**
 * `account.journal.create` (account/models/account_journal.py:1058-1074) with `_fill_missing_values` (:984-1056),
 * `_create_default_account` (:942-982), the mail.alias.mixin.optional create (mail_alias_mixin_optional.py:52-103,
 * `_alias_get_creation_values` :836-856) and the stored payment method lines, and the `account.account.create` it
 * calls (account_account.py:1012-1051: code in the root company's `code_store`, `_ensure_code_is_unique`).
 */
import { NotPorted, UserError, ValidationError } from "../errors";
import { aliasMixinWrite, aliasOnlyWrite, baseAliasCreationValues, irModelId, writeAliasCreationValues } from "../mail/alias_mixin";
import { and, cond, TRUE } from "../orm/domain";
import { unlink } from "../orm/unlink";
import { create } from "../orm/create";
import { DbRec, registerDefaults, registerOnchange, registerRecordCompute, type Rec } from "../orm/recompute";
import { registerOverrides, write } from "../orm/write";
import { registerLoadRecordsWrite } from "../orm/load_records";
import { accountParentId, isCompany } from "./chart_template";
import { PrivateRecords } from "../orm/private_hooks";
import type { Environment } from "../orm/types";
import { evalExpr } from "../pyexpr";
import { dictEntries, isDict, pyRepr } from "../pyexpr/values";
import { sanitizeAliasName } from "./crm_team";
import { xmlidId } from "./account_buttons";
import { runVatChecks } from "./res_partner_write";
import { translate } from "./util";
import { fieldFlushed } from "../orm/flush_points";
import * as priv from "../orm/dispatch_gen";

type Vals = Record<string, unknown>;

const companyEnv = (env: Environment, company: number): Environment => env.withContext({ ...env.context, allowed_company_ids: [company] });

async function companyRow(env: Environment, company: number): Promise<Record<string, unknown>> {
  return (await env.cr.query<Record<string, unknown>>(
    `SELECT c.name, c.alias_domain_id, c.bank_account_code_prefix, c.cash_account_code_prefix, c.default_cash_difference_income_account_id,
            c.default_cash_difference_expense_account_id, split_part(c.parent_path, '/', 1) AS root_id, d.name AS alias_domain
       FROM res_company c LEFT JOIN mail_alias_domain d ON d.id = c.alias_domain_id WHERE c.id = $1`, [company])).rows[0]!;
}

/** account_account.py:551-568 `code_is_available`. */
async function codeUsed(env: Environment, company: number, code: string): Promise<boolean> {
  const r = await env.cr.query(
    `SELECT 1 FROM account_account a JOIN account_account_res_company_rel rel ON rel.account_account_id = a.id
       JOIN res_company c ON c.id = rel.res_company_id JOIN res_company me ON me.id = $1
      WHERE a.code_store->>split_part(c.parent_path, '/', 1) = $2 AND (me.parent_path LIKE c.parent_path || '%' OR c.parent_path LIKE me.parent_path || '%') LIMIT 1`, [company, code]);
  return r.rows.length > 0;
}

/** account_account.py:504-588 `_search_new_account_code` with the default cache. */
async function searchNewAccountCode(env: Environment, company: number, start: string): Promise<string> {
  if (!start) return start; // :545-546
  const m = /^(.*?)(\d*)(\D*?)$/.exec(start);
  if (m === null) throw new NotPorted(`account code ${start}`);
  const [, head, digits, tail] = m as unknown as [string, string, string, string];
  const free = async (code: string): Promise<boolean> => code !== start && !await codeUsed(env, company, code);
  if (digits !== "") {
    for (let n = Number(digits) + 1; n < 10 ** digits.length; n++) {
      const code = `${head}${String(n).padStart(digits.length, "0")}${tail}`;
      if (await free(code)) return code;
    }
  }
  for (let n = 0; n < 99; n++) {
    const code = `${start}.copy${n ? n + 1 : ""}`;
    if (await free(code)) return code;
  }
  throw new UserError("Cannot generate an unused account code.");
}

/** :942-982 `_create_default_account`, the parent account by the chart template's `_get_account_parent_id` (:960). */
async function createDefaultAccount(env: Environment, company: number, type: string, vals: Vals): Promise<number> {
  const c = await companyRow(env, company);
  const first = (await env.cr.query<{ code: string | null }>(
    `SELECT a.code_store->>$2::text AS code FROM account_account a JOIN account_account_res_company_rel rel ON rel.account_account_id = a.id
      WHERE rel.res_company_id = $1 AND a.active ORDER BY a.id LIMIT 1`, [company, c["root_id"]])).rows[0];
  const digits = first ? (first.code ?? "").length : 6;
  const prefix = String((type === "cash" ? c["cash_account_code_prefix"] || c["bank_account_code_prefix"] : c["bank_account_code_prefix"]) ?? "");
  // :958-961 `account_vals = {**vals, 'parent_id': ...}`
  const accountVals: Vals = { ...vals, parent_id: await accountParentId(env, company, prefix) };
  const code = await searchNewAccountCode(env, company, prefix.padEnd(digits, "0"));
  // :920-939 `_prepare_liquidity_account_vals` (bank, cash) through the private hook: a site's compiled override
  // (l10n_at, l10n_ie, l10n_lt, l10n_nl: the liquidity account's tags) runs around account's; `_prepare_credit_account_vals`
  const base = (account: Vals, type_: string): Vals => ({
    name: account["name"] ?? false, code, parent_id: account["parent_id"] ?? false, account_type: type_,
    currency_id: account["currency_id"] ?? false, company_ids: [[4, company, 0]], // Command.link: (4, id, 0)
  });
  let accountValues: Vals;
  if (type === "bank" || type === "cash") {
    const out = await priv.account_journal._prepare_liquidity_account_vals.call(env, [], [new PrivateRecords("res.company", [company]), code, accountVals],
      async (_e, _ids, args) => {
        if (!isCompany(args[0], company) || args[1] !== code) {
          throw new NotPorted("account.journal._prepare_liquidity_account_vals called by an override with another company or code");
        }
        return base((args[2] ?? {}) as Vals, "asset_cash");
      });
    if (out === null || typeof out !== "object" || Array.isArray(out)) throw new NotPorted(`_prepare_liquidity_account_vals returning ${JSON.stringify(out)}`);
    accountValues = out as Vals;
  } else accountValues = base(accountVals, "liability_credit_card");
  const [id] = await create(companyEnv(env, company).withContext({ ...env.context, allowed_company_ids: [company], skip_auto_account_journal_creation: true }), "account.account", [accountValues]);
  // ir_model_data.py `_update_xmlids`
  await env.cr.query(
    `INSERT INTO ir_model_data (module, name, model, res_id, noupdate) VALUES ('account', $1, 'account.account', $2, true)
     ON CONFLICT (module, name) DO UPDATE SET model = EXCLUDED.model, res_id = EXCLUDED.res_id`, [`${company}_${type}_journal_default_account_${id}`, id]);
  return id!;
}

/** `Field.get_company_dependent_fallback`: the ir.default of a company-dependent product.category account. */
async function categoryFallback(env: Environment, company: number, field: string): Promise<number | null> {
  const r = (await env.cr.query<{ v: string }>(
    `SELECT d.json_value AS v FROM ir_default d JOIN ir_model_fields f ON f.id = d.field_id
      WHERE f.model = 'product.category' AND f.name = $1 AND d.user_id IS NULL AND (d.company_id IS NULL OR d.company_id = $2) AND d.condition IS NULL
      ORDER BY d.company_id, d.id LIMIT 1`, [field, company])).rows[0];
  return r ? JSON.parse(r.v) as number : null;
}

// mail_alias.py:396-405 `_is_encodable`: ascii once the accents are removed (tools remove_accents: NFKD without marks)
const isAscii = (s: string): boolean => /^[\x00-\x7f]*$/.test(s.normalize("NFKD").replace(/\p{M}/gu, ""));

/** :858-876 `_alias_prepare_alias_name`. */
async function prepareAliasName(env: Environment, aliasName: unknown, name: unknown, code: unknown, type: string, company: number): Promise<string | false> {
  if (!["purchase", "sale", "bank", "credit", "cash"].includes(type)) return false;
  let picked: string | false = false;
  for (const s of [aliasName, name, code, type]) {
    if (typeof s === "string" && s && isAscii(s) && sanitizeAliasName(s)) { picked = s; break; }
  }
  if (company !== await xmlidId(env, "base.main_company")) {
    const companyName = String((await companyRow(env, company))["name"]);
    const identifier = isAscii(companyName) ? sanitizeAliasName(companyName) : company;
    if (!String(picked).includes(`-${identifier}`)) picked = `${picked}-${identifier}`;
  }
  return sanitizeAliasName(picked);
}

/** :878-896 `_ensure_unique_alias`. */
async function ensureUniqueAlias(env: Environment, vals: Vals, company: number): Promise<string | false> {
  let name = vals["alias_name"];
  const domain = (await companyRow(env, company))["alias_domain"];
  const r = await env.sudo().cr.query(
    `SELECT 1 FROM mail_alias a LEFT JOIN mail_alias_domain d ON d.id = a.alias_domain_id
      WHERE a.alias_name = $1 AND ($2::text IS NULL OR d.name = $2 OR a.alias_domain_id IS NULL) LIMIT 1`, [name, domain]);
  if (r.rows.length) name = `${String(name)}-${String(vals["code"])}`;
  return sanitizeAliasName(name);
}

async function fillMissingValues(env0: Environment, vals: Vals): Promise<void> {
  const isImport = "import_file" in env0.context;
  if (isImport && !vals["type"]) vals["type"] = "general";
  const type = vals["type"] as string | undefined;
  if (!type) return;
  const company = (vals["company_id"] as number | undefined) || await env0.company();
  vals["company_id"] = company;
  const env = env0;
  if (type === "bank" || type === "cash") {
    const c = await companyRow(env, company);
    vals["name"] = vals["name"] || vals["bank_account_number"] || vals["name_placeholder"];
    if (!vals["default_account_id"]) vals["default_account_id"] = await createDefaultAccount(env, company, type, vals);
    if (!vals["profit_account_id"]) vals["profit_account_id"] = c["default_cash_difference_income_account_id"] ?? false;
    if (!vals["loss_account_id"]) vals["loss_account_id"] = c["default_cash_difference_expense_account_id"] ?? false;
  } else if (type === "purchase" || type === "sale") {
    const account = await categoryFallback(env, company, type === "sale" ? "property_account_income_categ_id" : "property_account_expense_categ_id");
    if (account !== null && !("default_account_id" in vals)) vals["default_account_id"] = account;
  }
  if (type === "credit" && !vals["default_account_id"]) {
    const found = await companyEnv(env, company).model("account.account").search(
      and([cond("company_ids", "in", [company]), cond("account_type", "=", "liability_credit_card")]), { limit: 1 });
    vals["default_account_id"] = found[0] ?? await createDefaultAccount(env, company, type, vals);
  }
  if (isImport && !vals["code"]) throw new NotPorted("import of a journal without code");
  if (["sale", "purchase", "bank", "credit", "cash"].includes(type)) {
    if (!("alias_name" in vals)) {
      if (typeof vals["name"] === "object" && vals["name"] !== null) throw new NotPorted("journal name given as translations");
      vals["alias_name"] = await prepareAliasName(env, false, vals["name"], vals["code"], type, company);
    }
    vals["alias_name"] = await ensureUniqueAlias(env, vals, company);
  }
  if (!vals["name"] && vals["name_placeholder"]) vals["name"] = vals["name_placeholder"];
}

/**
 * :465-498 the two computes of the method lines. Creating the first line of the batch reads the other field of its
 * journal, which runs that compute on the whole batch before the inbound compute goes on: (first journal, inbound),
 * (all journals, outbound), (other journals, inbound), the order of the ids in the G188 reference.
 */
async function createMethodLines(env: Environment, ids: readonly number[]): Promise<void> {
  const rows = (await env.cr.query<{ id: number; type: string }>("SELECT id, type FROM account_journal WHERE id = ANY($1::int[])", [[...ids]])).rows;
  const liquid = ids.filter((id) => ["bank", "cash", "credit"].includes(String(rows.find((r) => r.id === id)?.type)));
  if (!liquid.length) return;
  const inbound = await xmlidId(env, "account.account_payment_method_manual_in"), outbound = await xmlidId(env, "account.account_payment_method_manual_out");
  const names = (await env.cr.query<{ id: number; name: string }>(
    "SELECT id, COALESCE(name->>$2, name->>'en_US') AS name FROM account_payment_method WHERE id = ANY($1::int[])", [[inbound, outbound], env.lang ?? "en_US"])).rows;
  // the lines are new records of the journal's compute: their computed name and provider (account_payment
  // account_payment_method_line.py:26-45, none for the manual methods) are in the values flushed into the INSERT
  const provider = env.reg.model("account.payment.method.line").fields.has("payment_provider_id") ? { payment_provider_id: false } : {};
  const line = (journal: number, method: number): Vals => ({ journal_id: journal, payment_method_id: method, name: names.find((n) => n.id === method)?.name, ...provider });
  const order = [line(liquid[0]!, inbound), ...liquid.map((j) => line(j, outbound)), ...liquid.slice(1).map((j) => line(j, inbound))];
  for (const vals of order) await create(env.sudo(), "account.payment.method.line", [vals]);
}

/**
 * :836-856 `_alias_get_creation_values` of a stored journal: the mixin's (mail_alias_mixin_optional.py:180-190), the
 * model of its documents, its alias name (:858-876) and its alias defaults (the current ones with the company, the
 * move type of its type and itself). The name is the journal's in `lang` (the record's language).
 */
async function journalAliasValues(env: Environment, id: number, lang: string): Promise<Vals> {
  const r = (await env.cr.query<{ type: string; code: string; company_id: number; name: unknown; alias_name: string | null; alias_defaults: string | null }>(
    `SELECT j.type, j.code, j.company_id, COALESCE(j.name->>$2, j.name->>'en_US') AS name, a.alias_name, a.alias_defaults
       FROM account_journal j LEFT JOIN mail_alias a ON a.id = j.alias_id WHERE j.id = $1`, [id, lang])).rows[0]!;
  const values = await baseAliasCreationValues(env, "account.journal", id);
  values["alias_model_id"] = await irModelId(env, ["bank", "cash", "credit"].includes(r.type) ? "account.journal" : "account.move");
  values["alias_name"] = await prepareAliasName(env, r.alias_name, r.name, r.code, r.type, r.company_id);
  const parsed = evalExpr(r.alias_defaults || "{}", new Map());
  if (!isDict(parsed)) throw new NotPorted("journal alias_defaults that is not a dict");
  const defaults = new Map<unknown, unknown>(dictEntries(parsed));
  defaults.set("company_id", r.company_id);
  defaults.set("move_type", r.type === "purchase" ? "in_invoice" : r.type === "sale" ? "out_invoice" : "entry");
  defaults.set("journal_id", id);
  values["alias_defaults"] = pyRepr(defaults);
  return values;
}

const LIQUID = ["bank", "cash", "credit"];

/**
 * :810-818 the alias after a type change: `journal.update({alias_defaults, alias_name})` of its creation values goes
 * through mail_alias_mixin_optional.py:108-140 `write`: a journal without alias gets one when the name is set (the
 * creation values with that name, sudo), then the alias (if any) is written with both values (sudo).
 */
async function syncJournalAlias(env: Environment, id: number): Promise<void> {
  const lang = env.lang ?? "en_US";
  const values = await journalAliasValues(env, id, lang);
  const aliasVals: Vals = { alias_defaults: values["alias_defaults"], alias_name: values["alias_name"] };
  let alias = (await env.cr.query<{ a: number | null }>("SELECT alias_id AS a FROM account_journal WHERE id = $1", [id])).rows[0]?.a ?? null;
  if (aliasVals["alias_name"] && alias === null) {
    // :111-122 the journal's creation values with the sanitized name; `record.alias_id = alias.id` writes the journal
    const [created] = await create(env.sudo(), "mail.alias", [{ ...values, alias_name: sanitizeAliasName(aliasVals["alias_name"]) }]);
    if (created === undefined) throw new NotPorted("mail.alias create giving no record");
    alias = created;
    await write(env, "account.journal", [id], { alias_id: alias });
  }
  if (alias !== null) await write(env.sudo(), "mail.alias", [alias], aliasVals);
}

/**
 * :464-499 `_compute_inbound_payment_method_line_ids` / `_compute_outbound_payment_method_line_ids` after a write of the
 * type or the currency (stored computes depending on them; a write marks them even with the value unchanged): the
 * lines are cleared (Command.clear: their journal emptied, the inverse is not required), and a bank, cash or credit
 * journal gets new lines copying the old ones (name, method, account) and the default manual method if missing; the
 * inbound lines of every journal first, then the outbound ones.
 */
async function recomputeMethodLines(env: Environment, ids: readonly number[]): Promise<void> {
  const defaults = { inbound: await xmlidId(env, "account.account_payment_method_manual_in"), outbound: await xmlidId(env, "account.account_payment_method_manual_out") };
  const provider = env.reg.model("account.payment.method.line").fields.has("payment_provider_id") ? { payment_provider_id: false } : {};
  for (const direction of ["inbound", "outbound"] as const) {
    for (const id of ids) {
      const type = (await env.cr.query<{ t: string }>("SELECT type AS t FROM account_journal WHERE id = $1", [id])).rows[0]!.t;
      // the one2many's domain (payment_type) and the comodel's order (sequence, id)
      const existing = (await env.cr.query<{ id: number; name: string | null; method: number; account: number | null }>(
        `SELECT l.id, l.name, l.payment_method_id AS method, l.payment_account_id AS account FROM account_payment_method_line l
           JOIN account_payment_method m ON m.id = l.payment_method_id WHERE l.journal_id = $1 AND m.payment_type = $2 ORDER BY l.sequence, l.id`, [id, direction])).rows;
      if (existing.length) await write(env, "account.payment.method.line", existing.map((l) => l.id), { journal_id: false });
      if (!LIQUID.includes(type)) continue;
      const lines: Vals[] = existing.map((l) => ({ name: l.name ?? false, payment_method_id: l.method, payment_account_id: l.account ?? false }));
      if (!existing.some((l) => l.method === defaults[direction])) {
        const name = (await env.cr.query<{ n: string }>("SELECT COALESCE(name->>$2, name->>'en_US') AS n FROM account_payment_method WHERE id = $1", [defaults[direction], env.lang ?? "en_US"])).rows[0]!.n;
        lines.push({ name, payment_method_id: defaults[direction] });
      }
      for (const vals of lines) await create(env, "account.payment.method.line", [{ ...vals, journal_id: id, ...provider }]);
    }
  }
}

/**
 * :776-785 a given alias name that cannot be encoded or sanitized becomes the journal's readable one
 * (`_alias_prepare_alias_name` of the name and code given or the journal's own, in the environment's language).
 * `vals.get('name', self.name)` reads `self.name` whatever the values: more than one journal raises there.
 */
async function readableAliasName(env: Environment, ids: readonly number[], vals: Vals): Promise<void> {
  const alias = vals["alias_name"];
  if (!alias || "type" in vals) return;
  if (typeof alias === "string" && isAscii(alias) && sanitizeAliasName(alias)) return;
  if (typeof alias !== "string") throw new NotPorted(`account.journal alias_name given as ${typeof alias}`);
  if (ids.length !== 1) throw new NotPorted("account.journal write of an unencodable alias_name on several journals (account_journal.py:782 `self.name`: Expected singleton)");
  const lang = env.lang ?? "en_US";
  const r = (await env.cr.query<{ name: string | null; code: string | null; type: string; company_id: number }>(
    "SELECT COALESCE(name->>$2, name->>'en_US') AS name, code, type, company_id FROM account_journal WHERE id = $1", [ids[0], lang])).rows[0];
  if (r === undefined) throw new NotPorted(`account.journal ${ids[0]} missing`);
  let name: unknown = "name" in vals ? vals["name"] : r.name ?? false;
  // a name given as translations: the one of the language, else the journal's
  if (typeof name === "object" && name !== null && !Array.isArray(name)) name = (name as Record<string, unknown>)[lang] ?? r.name ?? false;
  vals["alias_name"] = await prepareAliasName(env, false, name, "code" in vals ? vals["code"] : r.code ?? false, r.type, r.company_id);
}

/**
 * :775-829 `write`, ported for the alias name (its readable form above, then mail_alias_mixin_optional.py:108-141
 * `aliasMixinWrite`, the super() of the journal's write), the hash restriction (src/models/account_hash.ts), the
 * type (the payment method lines, the alias) and the currency (the payment method lines, the liquidity account's
 * currency with account_account.py:1061-1064's check). The company, bank account and bank account number keys refuse
 * in the guard (src/orm/override_status.ts).
 */
async function journalWrite(env: Environment, ids: readonly number[], vals: Vals, next: (env: Environment, ids: readonly number[], vals: Vals) => Promise<void>): Promise<void> {
  const { checkJournalHashWrite } = await import("./account_hash");
  await readableAliasName(env, ids, vals);
  await checkJournalHashWrite(env, ids, vals);
  await aliasMixinWrite(env, "account.journal", ids, vals, next, (e, id) => journalAliasValues(e, id, e.lang ?? "en_US"));
  // :821-824 the liquidity accounts share the journal's foreign currency; account_account.py:1061-1064 refuses one their
  // journal items do not share, before the payment method lines recomputed by the journal's write are flushed (Odoo
  // creates them at the flush, so a refusal consumes none of their ids)
  const liquidity = "currency_id" in vals ? (await env.cr.query<{ a: number | null; c: number | null }>(
    "SELECT default_account_id AS a, currency_id AS c FROM account_journal WHERE id = ANY($1::int[]) AND type = ANY($2::text[]) ORDER BY id", [[...ids], LIQUID])).rows : [];
  for (const r of liquidity) {
    if (r.a !== null && r.c !== null && (await env.cr.query("SELECT 1 FROM account_move_line WHERE account_id = $1 AND currency_id IS NOT NULL AND currency_id != $2 LIMIT 1", [r.a, r.c])).rows.length) {
      throw new UserError(translate(env, "You cannot set a currency on this account as it already has some journal entries having a different foreign currency."));
    }
  }
  if ("type" in vals || "currency_id" in vals) await recomputeMethodLines(env, ids);
  if ("type" in vals && !env.context["account_journal_skip_alias_sync"]) {
    for (const id of ids) await syncJournalAlias(env, id);
  }
  for (const r of liquidity) if (r.a !== null) await write(env, "account.account", [r.a], { currency_id: r.c ?? false });
}

/**
 * account.py account_payment_method.py:153-165 `unlink` of payment method lines: a line used by a payment only loses
 * its journal; the others are deleted, after account_payment account_payment_method_line.py:61-73
 * `_unlink_except_installed_payment_provider` (a line of a provider refuses here).
 */
async function unlinkMethodLines(env: Environment, ids: readonly number[]): Promise<void> {
  if (!ids.length) return;
  const used = new Set((await env.cr.query<{ l: number }>(
    "SELECT DISTINCT payment_method_line_id AS l FROM account_payment WHERE payment_method_line_id = ANY($1::int[])", [[...ids]])).rows.map((r) => r.l));
  const unused = ids.filter((id) => !used.has(id));
  if (used.size) await write(env, "account.payment.method.line", ids.filter((id) => used.has(id)), { journal_id: false });
  if ((await env.cr.query("SELECT 1 FROM account_payment_method_line WHERE id = ANY($1::int[]) AND payment_provider_id IS NOT NULL LIMIT 1", [unused])).rows.length) {
    throw new NotPorted("unlink of a payment method line of a payment provider (_unlink_except_installed_payment_provider)");
  }
  await unlink(env, "account.payment.method.line", unused);
}

/**
 * account_payment account_journal.py:10-21 `_unlink_except_linked_to_payment_provider`: the (active) providers whose
 * journal (`_compute_journal_id`, src/models/payment_flow.ts providerJournal) is one of these refuse, in the providers'
 * order, unless the context has `force_delete`.
 */
async function exceptLinkedToPaymentProvider(env: Environment, ids: readonly number[]): Promise<void> {
  if (env.context["force_delete"] || !env.reg.models.has("payment.provider")) return;
  const { providerJournal } = await import("./payment_flow");
  const su = env.sudo();
  const linked: number[] = [];
  for (const p of await su.model("payment.provider").search(TRUE)) {
    const journal = await providerJournal(env, p);
    if (journal !== null && ids.includes(journal)) linked.push(p);
  }
  if (!linked.length) return;
  const names = await su.model("payment.provider").displayName(linked);
  throw new UserError(translate(env, "You must first uninstall a payment provider before deleting its journal.\nLinked providers: %s", "account_payment")
    .replace("%s", linked.map((p) => names.get(p) ?? "").join(", ")));
}

registerOverrides("account.journal", {
  // mail_alias_mixin_optional.py:126-127: only alias fields do not reach BaseModel.write
  skipsCore: aliasOnlyWrite,
  write: journalWrite,
  beforeUnlink: exceptLinkedToPaymentProvider,
  /**
   * :734-743 `unlink`: the bank accounts only these journals use (an archived journal does not count, `search`'s
   * active_test) are archived after the delete (refused here), the journals' payment method lines are unlinked
   * first; super() is mail_alias_mixin_optional.py:143-148 (the aliases deleted after the journals,
   * registerAliasMixinUnlink in src/models/account_computes.ts).
   */
  unlink: async (env, ids, next) => {
    const banks = (await env.cr.query<{ b: number }>(
      "SELECT DISTINCT bank_account_id AS b FROM account_journal WHERE id = ANY($1::int[]) AND bank_account_id IS NOT NULL ORDER BY 1", [[...ids]])).rows.map((r) => r.b);
    const archive: number[] = [];
    for (const bank of banks) {
      const users = await env.model("account.journal").search(cond("bank_account_id", "=", bank));
      if (users.every((j) => ids.includes(j))) archive.push(bank);
    }
    await unlinkMethodLines(env, await env.model("account.payment.method.line").search(cond("journal_id", "in", [...ids])));
    await next(env, ids);
    if (archive.length) throw new NotPorted("account.journal unlink archiving its bank accounts (res.partner.bank action_archive)");
  },
  // :745-773 `copy_data`: each copy gets the first code of its prefix free in its company (the codes of the company's
  // journals, archived ones included, read once for the batch)
  copyData: async (env, ids, valsList) => {
    // :1044-1046 the create of the copies reads `self.name` of the copied journals for an alias name: several of them
    // fail in Odoo (ValueError "Expected singleton") as soon as one is a sale, purchase, bank, credit or cash journal
    if (ids.length > 1 && valsList.some((v) => ["sale", "purchase", ...LIQUID].includes(String(v["type"])) && !("alias_name" in v))) {
      throw new NotPorted("copy of several account.journal records with an alias (account_journal.py:1046 `self.name`: Expected singleton)");
    }
    const codes = new Map<number, Set<string>>();
    for (const vals of valsList) {
      const company = Number(vals["company_id"]);
      if (!codes.has(company)) {
        // `_check_company_domain(company)`: no company or the company and its parents
        const rows = (await env.cr.query<{ code: string | null }>(
          `SELECT code FROM account_journal WHERE company_id IS NULL OR company_id = ANY(
             SELECT split_part(c.parent_path, '/', n)::int FROM res_company c, generate_series(1, array_length(string_to_array(c.parent_path, '/'), 1) - 1) n WHERE c.id = $1)`,
          [company])).rows;
        codes.set(company, new Set(rows.map((r) => r.code).filter((c): c is string => c !== null)));
      }
      const all = codes.get(company)!;
      let code = String(vals["code"]);
      const prefix = code.replace(/\d+/g, "").trim();
      let counter = 1;
      while (counter <= all.size && all.has(code)) {
        code = `${prefix}${counter}`;
        counter++;
      }
      if (counter > all.size) throw new UserError(translate(env, "Could not compute any code for the copy automatically. Please create it manually."));
      vals["code"] = code;
    }
  },
  create: async (env, valsList, next) => {
    for (const vals of valsList) await fillMissingValues(env, vals);
    // mail_alias_mixin_optional.py:62-92, `_require_new_alias`: a given alias name without alias_id
    const aliasFields = env.reg.model("mail.alias").fields;
    const defaultCompany = await env.company();
    const records: Vals[] = [];
    for (const vals of valsList) {
      if (vals["alias_name"]) vals["alias_name"] = sanitizeAliasName(vals["alias_name"]);
      if (vals["alias_id"] || !vals["alias_name"]) { records.push(vals); continue; }
      const aliasVals: Vals = {}, recordVals: Vals = {};
      for (const [k, v] of Object.entries(vals)) (aliasFields.has(k) ? aliasVals : recordVals)[k] = v;
      const company = (vals["company_id"] as number | undefined) || defaultCompany;
      const domain = "alias_domain_id" in aliasVals ? aliasVals["alias_domain_id"] : (await companyRow(env, company))["alias_domain_id"] ?? false;
      Object.assign(aliasVals, await baseAliasCreationValues(env.withContext({ ...env.context, default_alias_domain_id: domain }), "account.journal", null),
        { alias_model_id: await irModelId(env, "account.move") });
      const [alias] = await create(env.sudo(), "mail.alias", [aliasVals]);
      records.push({ ...recordVals, alias_id: alias });
    }
    const ids = await next(env.withContext({ ...env.context, mail_create_nolog: true }), records);
    await createMethodLines(env, ids);
    await writeAliasCreationValues(env, "account.journal", ids, async (id) => journalAliasValues(env, id, "en_US"));
    for (const [i, id] of ids.entries()) {
      if (valsList[i]!["bank_account_number"]) throw new NotPorted(`set_bank_account of journal ${id}`);
    }
    return ids;
  },
});

registerRecordCompute("account.payment.method.line", {
  // account_payment account_payment_method_line.py:26-60: only the 'electronic' methods of a provider get one
  payment_provider_id: async (_env, rec) => {
    const method = await rec.rel("payment_method_id");
    if (method !== null && await method.get("code") !== "manual") throw new NotPorted("payment_provider_id of an electronic payment method");
    return rec.prev("payment_provider_id");
  },
});

registerRecordCompute("account.account", {
  // account_account.py:711-719 `_compute_reconcile`
  reconcile: async (_env, rec) => {
    const type = String(await rec.get("account_type"));
    if (["income", "expense", "equity"].includes(type.split("_")[0]!)) return false;
    if (type === "asset_receivable" || type === "liability_payable") return true;
    if (["asset_cash", "liability_credit_card", "off_balance"].includes(type)) return false;
    return rec.prev("reconcile");
  },
  // :648-676 `_compute_account_tags`: the tags of the account with the closest lower code
  tag_ids: async (env, rec) => {
    // :653-667 `_get_closest_parent_account` runs its search_read on `code` whatever the account: the query flushes
    // the accounts' code_store (environments.py:545-560), so the model's dirty records (src/orm/flush_points.ts)
    fieldFlushed(env.cr, "account.account", "code_store", env.uid);
    const previous = (await rec.prev("tag_ids")) as number[] | null;
    const code = await rec.get("code_store");
    if (!code || previous?.length) return previous ?? [];
    const company = await env.company();
    const root = (await companyRow(env, company))["root_id"] as string;
    const closest = (await env.cr.query<{ id: number }>(
      `SELECT a.id FROM account_account a JOIN account_account_res_company_rel rel ON rel.account_account_id = a.id
        WHERE rel.res_company_id = $1 AND a.code_store->>$2::text < $3 ORDER BY a.code_store->>$2::text DESC LIMIT 1`, [company, root, code])).rows[0];
    if (closest === undefined) return [];
    return (await env.cr.query<{ account_account_tag_id: number }>(
      "SELECT account_account_tag_id FROM account_account_account_tag WHERE account_account_id = $1 ORDER BY account_account_tag_id", [closest.id])).rows.map((r) => r.account_account_tag_id);
  },
});

// account_account.py:64, :121, :150, :155
registerDefaults("account.account", {
  active: async () => true,
  company_ids: async (env) => [[6, 0, [await env.company()]]],
  non_trade: async () => false,
  display_mapping_tab: async (env) => {
    const r = (await env.cr.query<{ n: string }>("SELECT count(*) AS n FROM res_company_users_rel WHERE user_id = $1", [env.uid])).rows[0];
    return Number(r?.n ?? 0) > 1;
  },
});

/** account_account.py:504-584 `_search_new_account_code(start_code, cache)` in the active company. */
async function searchNewAccountCodeCached(env: Environment, company: number, start: string, cache: ReadonlySet<string>): Promise<string> {
  if (!start) return start;
  const free = async (code: string): Promise<boolean> => !cache.has(code) && !await codeUsed(env, company, code);
  if (await free(start)) return start;
  const m = /^(.*?)(\d*)(\D*?)$/.exec(start)!;
  const [, head, digits, tail] = m as unknown as [string, string, string, string];
  if (digits !== "") {
    for (let n = Number(digits) + 1; n < 10 ** digits.length; n++) {
      const code = `${head}${String(n).padStart(digits.length, "0")}${tail}`;
      if (await free(code)) return code;
    }
  }
  for (let n = 0; n < 99; n++) {
    const code = `${start}.copy${n ? n + 1 : ""}`;
    if (await free(code)) return code;
  }
  throw new UserError("Cannot generate an unused account code.");
}

registerOverrides("account.account", {
  create: async (env, valsListIn, next) => {
    if (valsListIn.some((v) => "code_mapping_ids" in v)) throw new NotPorted("account.account create with code_mapping_ids");
    if (!env.context["skip_auto_account_journal_creation"] && !env.context["chart_template_load"]
        && valsListIn.some((v) => v["account_type"] === "asset_cash" || v["account_type"] === "liability_credit_card")) {
      throw new NotPorted("account.account create of a liquidity account (_create_default_journals)");
    }
    // :1012-1033 per run of equal `company_ids`: the active company first; `prefix`/`code_digits` become a free code
    const valsList = valsListIn.map((v) => ({ ...v }));
    const company = await env.company();
    const root = (await companyRow(env, company))["root_id"];
    if (root !== String(company)) throw new NotPorted("account.account create in a branch");
    const cache = new Set<string>();
    let previous: string | undefined;
    for (const vals of valsList) {
      const key = JSON.stringify(vals["company_ids"] ?? []);
      if (previous !== undefined && key !== previous) cache.clear();
      previous = key;
      if ("prefix" in vals) {
        const prefix = String(vals["prefix"] || "");
        const digits = Number(vals["code_digits"]);
        delete vals["prefix"];
        delete vals["code_digits"];
        const start = prefix.length < digits ? prefix.padEnd(digits - 1, "0") + "1" : prefix;
        vals["code"] = await searchNewAccountCodeCached(env, company, start, cache);
        cache.add(String(vals["code"]));
      }
    }
    // :324-335 `_inverse_code`: the code lives in the root company's `code_store` (no code: not written)
    const stored = valsList.map(({ code, ...rest }) => (code === undefined ? rest : { ...rest, code_store: code }));
    const ids = await next(env.withContext({ ...env.context, defer_account_code_checks: true }), stored);
    // :1087-1124 `_ensure_code_is_unique` for the created accounts
    for (const [i, id] of ids.entries()) {
      const code = valsList[i]!["code"];
      if (!code) continue;
      const r = await env.cr.query(
        `SELECT 1 FROM account_account a JOIN account_account_res_company_rel rel ON rel.account_account_id = a.id JOIN res_company c ON c.id = rel.res_company_id
          WHERE a.id <> $1 AND a.code_store->>split_part(c.parent_path, '/', 1) = $2 AND rel.res_company_id = ANY(SELECT res_company_id FROM account_account_res_company_rel WHERE account_account_id = $1) LIMIT 1`, [id, code]);
      if (r.rows.length) throw new ValidationError(`Account codes must be unique. You can't create accounts with these duplicate codes: ${String(code)}`);
    }
    return ids;
  },
});

/** The payment method lines of a form's journal: none outside bank, cash and credit journals (the write's are recomputeMethodLines). */
async function methodLines(rec: Rec, field: string): Promise<unknown> {
  if (rec.id !== null) throw new NotPorted(`account.journal.${field} recomputed outside the journal's write`);
  if (LIQUID.includes(String(await rec.get("type")))) throw new NotPorted(`account.journal.${field} of a new bank, cash or credit journal (new lines of the default methods)`);
  if (rec.origin !== null && ((await rec.prev(field)) as unknown[] | null ?? []).length) throw new NotPorted(`account.journal.${field} cleared on a journal with payment method lines`);
  return [];
}

/**
 * :541-579 `_onchange_type`: the alias name of a sale or purchase journal (else none), the code and the accounts reset
 * for the new type (the company's income or expense account, the cash difference accounts of a bank or cash journal),
 * then the code computed again.
 */
registerOnchange("account.journal", "_onchange_type", ["type"], async (env, rec) => {
  const type = await rec.get("type");
  const company = Number(await rec.get("company_id")) || await env.company();
  if (type !== "sale" && type !== "purchase") await rec.set("alias_name", false);
  else if (!(await rec.get("alias_name"))) {
    const name = await rec.get("name");
    if (typeof name === "object" && name !== null) throw new NotPorted("journal name given as translations");
    await rec.set("alias_name", await prepareAliasName(env, false, name, await rec.get("code"), String(type), company));
  }
  // :550-558 a journal with posted statements in a hashed journal keeps its type (`self.ids` are the origins,
  // models.py:5382-5386): the refusal's message is not ported
  if (rec.origin !== null && (await env.cr.query(
    `SELECT 1 FROM account_bank_statement s JOIN account_journal j ON j.id = s.journal_id
      WHERE s.journal_id = $1 AND j.restrict_mode_hash_table AND s.is_statement_posted LIMIT 1`, [rec.origin])).rows.length) {
    throw new NotPorted("account.journal type change of a journal with hashed statements (UserError)");
  }
  await rec.set("code", false);
  await rec.set("default_account_id", false);
  await rec.set("profit_account_id", false);
  await rec.set("loss_account_id", false);
  // the company's accounts that are active (res.company income/expense accounts are company defaults of the product
  // category properties, company.py:303-317)
  const companyRec = new DbRec(env, env.reg.model("res.company"), company);
  const active = async (field: string): Promise<number | null> => {
    const account = await companyRec.rel(field);
    return account && (await account.get("active")) ? account.origin : null;
  };
  if (type === "sale" && await active("income_account_id")) await rec.set("default_account_id", await active("income_account_id"));
  else if (type === "purchase" && await active("expense_account_id")) await rec.set("default_account_id", await active("expense_account_id"));
  else if (type === "bank" && (await rec.get("restrict_mode_hash_table"))) await rec.set("restrict_mode_hash_table", false);
  else if (type === "cash" || type === "bank") {
    const profit = await active("default_cash_difference_income_account_id"), loss = await active("default_cash_difference_expense_account_id");
    if (profit !== null) await rec.set("profit_account_id", profit);
    if (loss !== null) await rec.set("loss_account_id", loss);
  }
  // :577-579 `self._compute_code()`: its own batch cache, the code was just emptied
  const type2 = await rec.get("type");
  await rec.set("code", type2 ? await nextJournalCode(env, String(type2), company, []) : false);
});

// :709-712 `_onchange_incoming_einvoice_notification_email`: the addresses normalized and joined (an empty value is "")
registerOnchange("account.journal", "_onchange_incoming_einvoice_notification_email", ["incoming_einvoice_notification_email"], async (_env, rec) => {
  const value = await rec.get("incoming_einvoice_notification_email");
  if (value) throw new NotPorted("account.journal.incoming_einvoice_notification_email normalized (email_normalize_all)");
  await rec.set("incoming_einvoice_notification_email", "");
});

registerDefaults("account.journal", {
  // account_journal.py:60-68 `_default_invoice_reference_model`: the first model named after the company's country
  invoice_reference_model: async (env) => {
    const code = (await env.cr.query<{ c: string | null }>(
      "SELECT co.code AS c FROM res_company c JOIN res_partner p ON p.id = c.partner_id LEFT JOIN res_country co ON co.id = p.country_id WHERE c.id = $1",
      [await env.company()])).rows[0]?.c?.toLowerCase();
    if (code) {
      for (const s of env.reg.model("account.journal").fields.get("invoice_reference_model")?.selection ?? []) {
        if (s.value.startsWith(code)) return s.value;
      }
    }
    return "odoo";
  },
});

registerRecordCompute("account.journal", {
  // :716-724 `_compute_refund_sequence`, `_compute_payment_sequence`
  refund_sequence: async (_env, rec) => ["sale", "purchase"].includes(String(await rec.get("type"))),
  payment_sequence: async (_env, rec) => LIQUID.includes(String(await rec.get("type"))),
  // :464-499 the payment method lines: cleared outside bank, cash and credit journals; their new lines are not ported
  inbound_payment_method_line_ids: async (_env, rec) => methodLines(rec, "inbound_payment_method_line_ids"),
  outbound_payment_method_line_ids: async (_env, rec) => methodLines(rec, "outbound_payment_method_line_ids"),
  // account_journal.py:313-323 `_compute_code` with :898-917 `_get_next_journal_default_code`; the batch cache is
  // the codes given to the other new journals of this request
  code: async (env, rec) => {
    const own = await rec.prev("code");
    const type = await rec.get("type");
    if (own || !type) return own;
    const company = (await rec.rel("company_id"))?.id ?? null;
    const key = `account.journal.code_cache.${company}`;
    const cache = (env.cache.get(key) as string[] | undefined) ?? [];
    const code = await nextJournalCode(env, String(type), company, cache);
    if (code) env.cache.set(key, [...cache, code]);
    return code;
  },
});

/** :898-917 `_get_next_journal_default_code` in the company's journals (archived ones too) and the batch's `cache`. */
async function nextJournalCode(env: Environment, type: string, company: number | null, cache: readonly string[]): Promise<string | false> {
  const base = ({ sale: "INV", purchase: "BILL", cash: "CSH", bank: "BNK", credit: "CCD", general: "MISC" } as Record<string, string>)[type];
  if (base === undefined) throw new NotPorted(`account.journal default code of type ${type}`);
  const existing = new Set([...(await env.cr.query<{ code: string }>(
    `SELECT code FROM account_journal WHERE (company_id IS NULL OR company_id = ANY(
       SELECT split_part(c.parent_path, '/', n)::int FROM res_company c, generate_series(1, array_length(string_to_array(c.parent_path, '/'), 1) - 1) n WHERE c.id = $1))
       AND code LIKE $2`, [company, `${base}%`])).rows.map((r) => r.code), ...cache]);
  for (let n = 1; n < 100; n++) {
    const code = `${base}${n}`;
    if (!existing.has(code)) return code;
  }
  return false;
}

// account partner.py:152-159 `_inverse_foreign_vat` (country_id, country_group_id, foreign_vat): a foreign VAT with a
// country goes through `_run_vat_checks` (validation on, the label "fiscal position [name]"). The assignment runs while
// the record is protected for the inverse fields (fields.py:2005-2008): a cache write without business logic, flushed
// as a plain column update.
async function inverseForeignVat(env: Environment, ids: readonly number[]): Promise<void> {
  const rows = (await env.cr.query<{ id: number; vat: string | null; code: string | null }>(
    `SELECT p.id, p.foreign_vat AS vat, c.code FROM account_fiscal_position p LEFT JOIN res_country c ON c.id = p.country_id
      WHERE p.id = ANY($1::int[]) ORDER BY p.id`, [[...ids]])).rows;
  for (const r of rows) {
    if (!r.vat || !r.code) continue;
    const name = String((await env.model("account.fiscal.position").read([r.id], ["name"], ""))[0]?.["name"] ?? "");
    const label = translate(env, "fiscal position [%s]", "account").replace("%s", name);
    const checked = await runVatChecks(env, r.code, r.vat, "error", label);
    if (checked !== r.vat) await env.cr.query("UPDATE account_fiscal_position SET foreign_vat = $2 WHERE id = $1", [r.id, checked]);
  }
}

/** partner.py:191-199 `_convert_zip_values`: two numeric zips are left-padded with zeros to the same length
 *  (`str.isdigit`, here decimal digits; lengths in code points as Python's `len`). */
function convertZipValues(zipFrom: unknown, zipTo: unknown): [unknown, unknown] {
  if (!zipFrom || !zipTo) return [zipFrom, zipTo];
  let from = String(zipFrom), to = String(zipTo);
  const len = Math.max([...from].length, [...to].length);
  const pad = (s: string): string => "0".repeat(Math.max(0, len - [...s].length)) + s;
  if (/^\p{Nd}+$/u.test(from)) from = pad(from);
  if (/^\p{Nd}+$/u.test(to)) to = pad(to);
  return [from, to];
}

/** models.py:162-178 `check_company_domain_parent_of` for one company: its parent_path's ids and False. */
async function companyAndParents(env: Environment, company: number): Promise<(number | false)[]> {
  const path = (await env.cr.query<{ p: string }>("SELECT parent_path AS p FROM res_company WHERE id = $1", [company])).rows[0]?.p ?? "";
  return [...path.split("/").slice(0, -1).map(Number), false];
}

registerOverrides("account.fiscal.position", {
  inverse: { country_id: inverseForeignVat, country_group_id: inverseForeignVat, foreign_vat: inverseForeignVat },
  // partner.py:203-210 create: the zip range is padded before super()
  create: async (env, valsList, next) => {
    for (const vals of valsList) {
      if (vals["zip_from"] && vals["zip_to"]) [vals["zip_from"], vals["zip_to"]] = convertZipValues(vals["zip_from"], vals["zip_to"]);
    }
    return next(env, valsList);
  },
  // partner.py:212-218 write: with either zip given, the values are padded against each record's own (Odoo's loop
  // overwrites `vals` per record, so the last record's values are written to all)
  write: async (env, ids, vals, next) => {
    const zipFrom = vals["zip_from"], zipTo = vals["zip_to"];
    if (zipFrom || zipTo) {
      const rows = (await env.cr.query<{ id: number; zip_from: string | null; zip_to: string | null }>(
        "SELECT id, zip_from, zip_to FROM account_fiscal_position WHERE id = ANY($1::int[])", [[...ids]])).rows;
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const id of ids) {
        const r = byId.get(id);
        [vals["zip_from"], vals["zip_to"]] = convertZipValues(zipFrom || (r?.zip_from || false), zipTo || (r?.zip_to || false));
      }
    }
    await next(env, ids, vals);
  },
  constraints: [
    // partner.py:117-121 `_check_zip`
    {
      fields: ["zip_from", "zip_to"],
      fn: async (env, ids) => {
        const rows = (await env.cr.query<{ zip_from: string | null; zip_to: string | null }>(
          "SELECT zip_from, zip_to FROM account_fiscal_position WHERE id = ANY($1::int[]) ORDER BY id", [[...ids]])).rows;
        for (const r of rows) {
          const from = r.zip_from || false, to = r.zip_to || false;
          if (Boolean(from) !== Boolean(to) || (from !== false && to !== false && from > to)) {
            throw new ValidationError(translate(env, 'Invalid "Zip Range", You have to configure both "From" and "To" values for the zip range and "To" should be greater than "From".', "account"));
          }
        }
      },
    },
    // partner.py:123-149 `_validate_foreign_vat_country`
    {
      fields: ["country_id", "country_group_id", "state_ids", "foreign_vat"],
      fn: async (env, ids) => {
        const rows = (await env.cr.query<{ id: number; vat: string | null; country: number | null; grp: number | null; company: number; fiscal: number | null }>(
          `SELECT p.id, p.foreign_vat AS vat, p.country_id AS country, p.country_group_id AS grp, p.company_id AS company,
                  c.account_fiscal_country_id AS fiscal
             FROM account_fiscal_position p JOIN res_company c ON c.id = p.company_id WHERE p.id = ANY($1::int[]) ORDER BY p.id`, [[...ids]])).rows;
        for (const r of rows) {
          if (!r.vat) continue;
          if (r.country === null) throw new ValidationError(translate(env, "The country of the foreign Tax ID could not be detected. Please assign a country to the fiscal position.", "account"));
          if (r.country === r.fiscal) {
            const states = (await env.cr.query("SELECT 1 FROM account_fiscal_position_res_country_state_rel WHERE account_fiscal_position_id = $1 LIMIT 1", [r.id])).rows.length;
            const fiscalStates = (await env.cr.query("SELECT 1 FROM res_country_state WHERE country_id = $1 LIMIT 1", [r.fiscal])).rows.length;
            if (!states && fiscalStates) throw new ValidationError(translate(env, "You cannot create a fiscal position with a foreign Tax ID within your fiscal country without assigning it a state.", "account"));
          }
          if (r.grp !== null) {
            const inGroup = (await env.cr.query("SELECT 1 FROM res_country_res_country_group_rel WHERE res_country_group_id = $1 AND res_country_id = $2", [r.grp, r.country])).rows.length;
            if (!inGroup) throw new ValidationError(translate(env, "You cannot create a fiscal position with a country outside of the selected country group.", "account"));
          }
          // the search_count runs as the user (record rules, active records only)
          const similar = await env.model("account.fiscal.position").searchCount(and([
            cond("company_id", "in", await companyAndParents(env, r.company)),
            cond("foreign_vat", "not in", [false, r.vat]),
            cond("id", "!=", r.id),
            cond("country_id", "=", r.country),
          ]));
          if (similar) throw new ValidationError(translate(env, "A fiscal position with a foreign Tax ID already exists in this country.", "account"));
        }
      },
    },
  ],
});

registerRecordCompute("account.reconcile.model", {
  // account_reconcile_model.py:205-208
  trigger: async (_env, rec) => ((await rec.get("rule_type")) === "matching_rule" ? "auto_reconcile" : "manual"),
  // :199-203 `_compute_partner_mapping`
  mapped_partner_id: async (_env, rec) => {
    const lines = await rec.rels("line_ids");
    if (await rec.get("match_label") && lines.length === 1 && await lines[0]!.get("partner_id") && !await lines[0]!.get("account_id")) {
      return lines[0]!.get("partner_id");
    }
    return false;
  },
  // :193-197
  can_be_proposed: async (_env, rec) => {
    if (await rec.get("mapped_partner_id")) return false;
    const partners = await rec.get("match_partner_ids");
    return Boolean(await rec.get("match_label") || await rec.get("match_amount") || (Array.isArray(partners) && partners.length)
      || (await rec.get("trigger")) === "auto_reconcile");
  },
});
registerRecordCompute("account.reconcile.model.line", {
  // account_reconcile_model.py:68-75 `_compute_float_amount`: Python's float() of the text, 0 when it fails
  amount: async (_env, rec) => {
    const text = String((await rec.get("amount_string")) ?? "").trim();
    const value = /^[+-]?(\d+(_?\d+)*(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text) ? Number(text.replace(/_/g, "")) : 0;
    return Number.isFinite(value) ? value : 0;
  },
});

// account_account.py:1149-1153 `_load_records_write`: an existing account loaded again (a chart template's utility
// account the template's own data already created, l10n_ae's transfer account) keeps its code: `prefix` and
// `code_digits` are dropped before the write
registerLoadRecordsWrite("account.account", async (env, id, values) => {
  const vals = { ...values };
  if ("prefix" in vals) {
    delete vals["code_digits"];
    delete vals["prefix"];
  }
  await write(env, "account.account", [id], vals);
});
