/**
 * Creating a bank account (base res_partner_bank.py), as l10n_se's demo company does (base.demo_bank_se, ACCEPTANCE
 * A1): the precomputes `_compute_country_id` (:139-143) and `_compute_clearing_label_id` (:114-124), the stored
 * `sanitized_account_number` (:136-138), `holder_name` (:166-170) and `_sanitize_vals` in create/write (:182-197),
 * `_check_clearing_number` (:93-106); account's stored `has_phishing_warnings` for a trusted account.
 */
import { NotPorted } from "../errors";
import { registerRecordCompute } from "../orm/recompute";
import { registerOverrides, write } from "../orm/write";
import { HOOKS_INSIDE } from "../orm/create";
import type { Environment } from "../orm/types";
import { userHasGroup } from "../web/groups";
import { escapeText, messageLogBatch } from "../mail/message";
import { createdInTransaction } from "../orm/created";

/** `sanitize_account_number` (res_partner_bank.py:8-11): `re.sub(r'\W+', '', number).upper()`, False when empty. */
function sanitize(v: unknown): string | false {
  return v ? String(v).replace(/[^\p{L}\p{N}_]+/gu, "").toUpperCase() || false : false;
}

async function partnerCountry(env: Environment, table: "res_partner" | "res_company", id: unknown): Promise<number | null> {
  if (typeof id !== "number") return null;
  const sql = table === "res_partner" ? "SELECT country_id AS c FROM res_partner WHERE id = $1"
    : "SELECT p.country_id AS c FROM res_company c JOIN res_partner p ON p.id = c.partner_id WHERE c.id = $1";
  return (await env.cr.query<{ c: number | null }>(sql, [id])).rows[0]?.c ?? null;
}

const idOf = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);

registerRecordCompute("res.partner.bank", {
  country_id: async (env, rec) => {
    const own = await rec.prev("country_id");
    if (own) return own;
    return (await partnerCountry(env, "res_partner", idOf(await rec.get("partner_id"))))
      ?? (await partnerCountry(env, "res_company", idOf(await rec.get("company_id"))))
      ?? (await partnerCountry(env, "res_company", await env.company()))
      ?? false;
  },
  clearing_label_id: async (env, rec) => {
    const country = idOf(await rec.get("country_id"));
    const labels = (await env.cr.query<{ id: number; country_id: number | null }>(
      "SELECT id, country_id FROM clearing_label WHERE country_id = $1 OR country_id IS NULL ORDER BY id", [typeof country === "number" ? country : null])).rows;
    const own = labels.filter((l) => l.country_id !== null && l.country_id === country);
    const dflt = labels.filter((l) => l.country_id === null);
    const pick = typeof country === "number" ? own : dflt;
    const chosen = pick.length ? pick : dflt;
    if (chosen.length > 1) throw new NotPorted("res.partner.bank clearing_label_id with several labels for a country");
    return chosen[0]?.id ?? false;
  },
  sanitized_account_number: async (_env, rec) => sanitize(await rec.get("account_number")),
  // :166-170 `_compute_account_holder_name`
  holder_name: async (env, rec) => {
    const own = await rec.prev("holder_name");
    if (own) return own;
    const partner = idOf(await rec.get("partner_id"));
    if (typeof partner !== "number") return own || false;
    return (await env.cr.query<{ name: string | null }>("SELECT name FROM res_partner WHERE id = $1", [partner])).rows[0]?.name || false;
  },
  // account res_partner_bank.py:97-153: a trusted account (allow_out_payment) or one without a number has no
  // phishing warning; the others' warnings (money transfer services, IBAN/CLABE/holder countries) are not ported
  has_phishing_warnings: async (env, rec) => {
    const sanitized = await rec.get("sanitized_account_number");
    if ((await rec.get("allow_out_payment")) || !sanitized) return false;
    const number = String(sanitized);
    const raw = String((await rec.get("account_number")) ?? "");
    // account `retrieve_account_type` (:46-56): iban, clabe, else bank
    const iban = isIban(raw), clabe = !iban && isClabe(raw);
    if (iban && ["967", "977", "974"].includes(number.slice(4, 7))) return true; // `_get_money_transfer_services`
    const country = async (code: string): Promise<number | null> =>
      (await env.cr.query<{ id: number }>("SELECT id FROM res_country WHERE code = $1 ORDER BY id LIMIT 1", [code])).rows[0]?.id ?? null;
    const partner = idOf(await rec.get("partner_id"));
    const countries = [
      iban ? await country(number.slice(0, 2)) : null,
      clabe ? await country("MX") : null,
      typeof partner === "number" ? await partnerCountry(env, "res_partner", partner) : null,
      (idOf(await rec.get("country_id")) as number | null) || null,
    ];
    for (let i = 0; i < countries.length; i++) {
      for (let j = i + 1; j < countries.length; j++) {
        if (countries[i] && countries[j] && countries[i] !== countries[j]) return true;
      }
    }
    return false;
  },
});

/** `_map_iban_template` (tools/bank_account_number.py:120-190): the IBAN length per country. */
const IBAN_LENGTHS: Readonly<Record<string, number>> = {ad: 24, ae: 23, al: 28, at: 20, az: 28, ba: 20, be: 16, bg: 22, bh: 22, br: 29, by: 28, ch: 21, cr: 22, cy: 28, cz: 24, de: 22, dk: 18, do: 28, ee: 20, es: 24, fi: 18, fo: 18, fr: 27, gb: 22, ge: 22, gi: 23, gl: 18, gr: 27, gt: 28, hr: 21, hu: 28, ie: 22, il: 23, is: 26, it: 27, jo: 30, kw: 30, kz: 20, lb: 28, li: 21, lt: 20, lu: 20, lv: 21, mc: 27, md: 24, me: 22, mk: 19, mr: 27, mt: 31, mu: 30, nl: 18, no: 15, om: 23, pk: 24, pl: 28, ps: 29, pt: 25, qa: 29, ro: 24, rs: 22, sa: 24, se: 24, si: 19, sk: 24, sm: 27, tn: 24, tr: 26, ua: 29, vg: 24, xk: 20};

/** `validate_iban` (tools/bank_account_number.py:51-70) passes. */
function isIban(number: string): boolean {
  const n = number.replace(/[\W_]/g, "");
  const len = IBAN_LENGTHS[n.slice(0, 2).toLowerCase()];
  if (!n || len === undefined || n.length !== len || !/^[a-zA-Z0-9]+$/.test(n)) return false;
  const digits = [...(n.slice(4) + n.slice(0, 4))].map((c) => parseInt(c, 36).toString()).join("");
  let rest = 0;
  for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  return rest === 1;
}

/** `validate_clabe` (:73-92) passes. */
function isClabe(number: string): boolean {
  const n = number.replace(/[\W_]/g, "");
  if (!/^\d{18}$/.test(n)) return false;
  const factors = [3, 7, 1];
  let total = 0;
  for (let i = 0; i < 17; i++) total += (Number(n[i]) * factors[i % 3]!) % 10;
  return (10 - (total % 10)) % 10 === Number(n[17]);
}

/** `format_account_number` (:99-115): a valid IBAN or CLABE in groups, else unchanged. */
function formatAccountNumber(number: string): string {
  const n = number.replace(/[\W_]/g, "");
  if (isIban(number)) return n.match(/.{1,4}/g)!.join(" ");
  if (isClabe(number)) return `${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6, 17)} ${n[17]}`;
  return number;
}

function sanitizeVals(vals: Record<string, unknown>): void {
  if ("sanitized_account_number" in vals) {
    vals["account_number"] = vals["sanitized_account_number"];
    delete vals["sanitized_account_number"];
  }
  if ("account_number" in vals) vals["sanitized_account_number"] = sanitize(vals["account_number"]);
  if (vals["bank_bic"]) vals["bank_bic"] = String(vals["bank_bic"]).toUpperCase();
}

/** account res_partner_bank.py:317-327 `_user_can_trust` (base: True). */
async function userCanTrust(env: Environment): Promise<boolean> {
  const allowed = env.su || userHasGroup(env, "account.group_validate_bank_account") || userHasGroup(env, "base.group_system");
  return allowed && (env.uid !== 1 || Boolean(env.context["install_mode"]));
}

// account's create logs after mail.thread's creation message (its `super().create`)
HOOKS_INSIDE.add("res.partner.bank");
registerOverrides("res.partner.bank", {
  // account res_partner_bank.py:332-357 (extends base :190-194, `_sanitize_vals`)
  create: async (env, valsList, next) => {
    const toTrust = valsList.map((v) => v["allow_out_payment"]);
    for (const vals of valsList) vals["allow_out_payment"] = false;
    for (const vals of valsList) {
      if (vals["account_number"]) vals["account_number"] = formatAccountNumber(String(vals["account_number"]));
      const partner = vals["partner_id"], number = vals["account_number"];
      if (partner && number) {
        const archived = (await env.cr.query("SELECT 1 FROM res_partner_bank WHERE NOT active AND partner_id = $1 AND account_number = $2 LIMIT 1", [partner, number])).rows.length;
        if (archived) throw new NotPorted("res.partner.bank create of an archived account number (the error's partner name)");
      }
    }
    valsList.forEach(sanitizeVals);
    const ids = await next(env, valsList);
    if (env.lang && env.lang !== "en_US") throw new NotPorted(`translated bank account messages (${env.lang})`);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      if (toTrust[i] && await userCanTrust(env)) await write(env, "res.partner.bank", [id], { allow_out_payment: true });
      const partner = (await env.cr.query<{ p: number }>("SELECT partner_id AS p FROM res_partner_bank WHERE id = $1", [id])).rows[0]!.p;
      const name = (await env.model("res.partner").displayName([partner])).get(partner) ?? "";
      // `_get_html_link(title=...)`; the translation is escaped around the Markup link (tools/translate.py)
      await messageLogBatch(env, "res.partner.bank", new Map([[id, `<p>Partner set to <a href="#" data-oe-model="res.partner" data-oe-id="${partner}">${escapeText(`#${name}`)}</a></p>`]]));
      await messageLogBatch(env, "res.partner", new Map([[partner, `<p>Bank Account <a href="#" data-oe-model="res.partner.bank" data-oe-id="${id}">#${id}</a> created</p>`]]));
    }
    return ids;
  },
  write: async (env, ids, vals, next) => {
    if (vals["account_number"]) vals["account_number"] = formatAccountNumber(String(vals["account_number"]));
    if (["bank_bic", "active", "account_number", "holder_name", "clearing_number", "partner_id", "allow_out_payment"].some((f) => f in vals)
      && !ids.every((id) => createdInTransaction(env.cr, "res.partner.bank", id))) {
      // :364-370 the change logged on the partner (`_track_record`); for an account created in the same transaction
      // Odoo logs nothing (measured: se_install's demo bank account, trusted right after its create)
      throw new NotPorted("res.partner.bank write of a tracked field (logged on the partner)");
    }
    if ("partner_id" in vals || "account_number" in vals || "allow_out_payment" in vals) {
      // :372-392 the trust lock (`lock_trust_fields`): only the go-ahead path of a new account is ported
      if (!ids.every((id) => createdInTransaction(env.cr, "res.partner.bank", id))) throw new NotPorted("res.partner.bank write under the trust lock");
    }
    sanitizeVals(vals);
    return next(env, ids, vals);
  },
  constraints: [
    { fields: ["clearing_label_id", "clearing_number"], fn: async (env, ids) => {
      const rows = (await env.cr.query<{ n: string; code: string | null }>(
        `SELECT b.clearing_number AS n, k.code FROM res_partner_bank b LEFT JOIN clearing_label l ON l.id = b.clearing_label_id
           LEFT JOIN res_country k ON k.id = l.country_id WHERE b.id = ANY($1::int[]) AND COALESCE(b.clearing_number, '') != '' ORDER BY b.id`, [[...ids]])).rows;
      for (const r of rows) {
        if (["AU", "HK", "JP", "SA", "US"].includes(r.code ?? "")) throw new NotPorted(`res.partner.bank clearing number check of ${r.code}`);
      }
    } },
  ],
});
