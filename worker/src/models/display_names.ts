/**
 * `_compute_display_name` overrides that had no port (gen/out/poc_erp/orm_methods.json `display_name_override`): the
 * web client showed BaseModel's `_rec_name` value for them, which differs from Odoo on records the scenarios never
 * touched (measured 2026-11-04 over every record of poc_erp, docs/council/2026-11-04/atgarder-runda-1.md).
 *
 * Each hook is the Python method for stored records, batched per field; `displayNameFalse` marks the overrides whose
 * empty name is Python's False (from `super()`). Values are read as superuser through the ORM
 * (translations, related fields); the Python computes read them as the user, which only differs when the user may not
 * read a related record (Odoo raises AccessError there). Branches that need a formatter the port does not have refuse.
 */
import { AccessError, NotPorted } from "../errors";
import { hasPrivateOverride } from "../orm/private_hooks";
import * as D from "../orm/domain";
import { envTz } from "../orm/env";
import { hooksOf, registerHooks } from "../orm/hooks";
import { ModelImpl } from "../orm/model";
import { baseRecordDisplayName, type Rec, registerRecordCompute } from "../orm/recompute";
import { searchDisplayNameDefault, sql } from "../orm/sql";
import type { Domain, Environment } from "../orm/types";
import { othersPrivate } from "./calendar_computes";
import { formatDate } from "./invoicing_computes";
import { formatLangCurrency } from "./product_computes";
import { pyFloatReprSimple, pyTruthy, translate } from "./util";

type Names = Map<number, string>;

/** Field values in cache format (null for empty), as superuser with the env's context (lang). */
async function vals(env: Environment, model: string, ids: readonly number[], fname: string): Promise<Map<number, unknown>> {
  const def = env.reg.model(model);
  const field = def.fields.get(fname);
  if (!field) throw new NotPorted(`${model}.${fname} in a display name`);
  return ids.length ? new ModelImpl(env.sudo(), def).values(ids, field) : new Map();
}

async function m2o(env: Environment, model: string, ids: readonly number[], fname: string): Promise<Map<number, number | null>> {
  const v = await vals(env, model, ids, fname);
  return new Map(ids.map((id) => { const x = v.get(id); return [id, typeof x === "number" && x > 0 ? x : null]; }));
}

function uniq(values: Iterable<number | null>): number[] {
  return [...new Set([...values].filter((v): v is number => v !== null))];
}

/** `str(value)` of a field value inside an f-string: an empty field is False. */
function pyS(v: unknown): string {
  if (v === null || v === undefined || v === false) return "False";
  if (v === true) return "True";
  if (typeof v === "number") return Number.isInteger(v) && !Object.is(v, -0) ? String(v) : pyFloatReprSimple(v);
  return String(v);
}

/** `str(float)` of a Float field value. */
function pyFloatS(v: unknown): string {
  return pyFloatReprSimple(typeof v === "number" ? v : 0);
}

const ctx = (env: Environment, key: string): boolean => pyTruthy(env.context[key]);

/** BaseModel._compute_display_name, the `super()` of the overrides. */
function base(env: Environment, model: string, ids: readonly number[]): Promise<Names> {
  return new ModelImpl(env, env.reg.model(model)).baseDisplayName(ids);
}

/** `record.display_name` of another model, as the env's user. */
async function dn(env: Environment, model: string, ids: readonly number[]): Promise<Names> {
  return ids.length ? env.model(model).displayName(ids) : new Map();
}

/** `env._(source, **kwargs)` with %(name)s placeholders. */
function tr(env: Environment, source: string, args: Readonly<Record<string, string>>): string {
  return translate(env, source).replace(/%\((\w+)\)s/g, (_m, k: string) => {
    const v = args[k];
    if (v === undefined) throw new NotPorted(`translation placeholder ${k}`);
    return v;
  });
}

/** babel format_list(style='standard') for en_US (tools/i18n.py:25). */
export function formatList(env: Environment, items: readonly string[]): string {
  if ((env.lang ?? "en_US") !== "en_US") throw new NotPorted("format_list outside en_US");
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** Python `str.title()`: a cased character after a cased one is lowercased, any other is uppercased. */
export function pyTitle(s: string): string {
  let out = "", prevCased = false;
  for (const ch of s) {
    const cased = ch.toLowerCase() !== ch.toUpperCase();
    out += cased ? (prevCased ? ch.toLowerCase() : ch.toUpperCase()) : ch;
    prevCased = cased;
  }
  return out;
}

/** Python `round(x)` of a float: ties to even. */
function roundEven(x: number): number {
  const f = Math.floor(x), d = x - f;
  return d === 0.5 ? (f % 2 === 0 ? f : f + 1) : Math.round(x);
}

// --------------------------------------------------------------------------------------------------------------
// account
// --------------------------------------------------------------------------------------------------------------

/** company.py:455-469 `_compute_multi_vat_foreign_country` of env.company: active fiscal positions with a foreign VAT. */
async function multiVatForeignCountries(env: Environment): Promise<boolean> {
  const company = await env.company();
  return (await env.cr.query("SELECT 1 FROM account_fiscal_position WHERE company_id = $1 AND active AND foreign_vat IS NOT NULL AND foreign_vat <> '' LIMIT 1", [company])).rows.length > 0;
}

// account_account_tag.py:27-37
registerHooks("account.account.tag", {
  displayNameFalse: true,
  displayName: async (env, ids) => {
    if (!ids.length || !(await multiVatForeignCountries(env))) return base(env, "account.account.tag", ids);
    const company = await env.company();
    const fiscal = (await env.cr.query<{ c: number | null }>("SELECT account_fiscal_country_id AS c FROM res_company WHERE id = $1", [company])).rows[0]?.c ?? null;
    const [name, applicability, country] = await Promise.all([vals(env, "account.account.tag", ids, "name"), vals(env, "account.account.tag", ids, "applicability"), m2o(env, "account.account.tag", ids, "country_id")]);
    const codes = await vals(env, "res.country", uniq(country.values()), "code");
    return new Map(ids.map((id) => {
      const c = country.get(id) ?? null;
      const n = name.get(id) ? String(name.get(id)) : "";
      return [id, applicability.get(id) === "taxes" && c !== null && c !== fiscal ? tr(env, "%(tag)s (%(country_code)s)", { tag: n, country_code: pyS(codes.get(c)) }) : n];
    }));
  },
});

// account_incoterms.py:22-25
registerHooks("account.incoterms", {
  displayName: async (env, ids) => {
    const [code, name] = await Promise.all([vals(env, "account.incoterms", ids, "code"), vals(env, "account.incoterms", ids, "name")]);
    return new Map(ids.map((id) => { const c = code.get(id); return [id, `${c ? `[${String(c)}] ` : ""}${pyS(name.get(id))}`]; }));
  },
});

// account_journal.py:1121-1129
registerHooks("account.journal", {
  displayName: async (env, ids) => {
    const M = "account.journal";
    const [name, currency, company] = await Promise.all([vals(env, M, ids, "name"), m2o(env, M, ids, "currency_id"), m2o(env, M, ids, "company_id")]);
    const companies = uniq(company.values());
    const [companyCurrency, companyName] = await Promise.all([m2o(env, "res.company", companies, "currency_id"), vals(env, "res.company", companies, "name")]);
    const currencyName = await vals(env, "res.currency", uniq(currency.values()), "name");
    const showCompany = (await env.companies()).length > 1 && ctx(env, "show_company_journal");
    return new Map(ids.map((id) => {
      let n = pyS(name.get(id));
      const cur = currency.get(id) ?? null, co = company.get(id) ?? null;
      if (cur !== null && cur !== (co === null ? null : companyCurrency.get(co) ?? null)) n = `${n} (${pyS(currencyName.get(cur))})`;
      if (showCompany) n = `${pyS(co === null ? null : companyName.get(co))} - ${n}`;
      return [id, n];
    }));
  },
});

// account_lock_exception.py:100-102
registerHooks("account.lock_exception", {
  displayName: async (env, ids) => new Map(ids.map((id) => [id, translate(env, "Lock Date Exception %s").replace("%s", String(id))])),
});

// account_payment_method.py:133-141: "<name> (<journal>)" unless hide_payment_journal_id
registerHooks("account.payment.method.line", {
  displayNameFalse: true,
  displayName: async (env, ids) => {
    const M = "account.payment.method.line";
    if (ctx(env, "hide_payment_journal_id")) return base(env, M, ids);
    const [name, journal] = await Promise.all([vals(env, M, ids, "name"), m2o(env, M, ids, "journal_id")]);
    const jname = await vals(env, "account.journal", uniq(journal.values()), "name");
    return new Map(ids.map((id) => { const j = journal.get(id) ?? null; return [id, `${pyS(name.get(id))} (${pyS(j === null ? null : jname.get(j))})`]; }));
  },
});

// account_report.py:396-402
registerHooks("account.report", {
  displayName: async (env, ids) => {
    const M = "account.report";
    const [name, country] = await Promise.all([vals(env, M, ids, "name"), m2o(env, M, ids, "country_id")]);
    const codes = await vals(env, "res.country", uniq(country.values()), "code");
    return new Map(ids.map((id) => {
      const n = name.get(id);
      if (!n) throw new NotPorted("account.report display_name False (unnamed report)");
      const c = country.get(id) ?? null;
      return [id, String(n) + (c !== null ? ` (${pyS(codes.get(c))})` : "")];
    }));
  },
});

// account_report.py:900-903
registerHooks("account.report.expression", {
  displayName: async (env, ids) => {
    const M = "account.report.expression";
    const [line, label] = await Promise.all([vals(env, M, ids, "report_line_name"), vals(env, M, ids, "label")]);
    return new Map(ids.map((id) => [id, `${pyS(line.get(id))} [${pyS(label.get(id))}]`]));
  },
});

/** res_company.py:484-501 `__accessible_branches()[:1]`: the company or its first descendant (level by level) in env.companies. */
async function firstAccessibleBranch(env: Environment, company: number): Promise<number | null> {
  const accessible = new Set(await env.companies());
  let current = [company];
  while (current.length) {
    const hit = current.find((c) => accessible.has(c));
    if (hit !== undefined) return hit;
    const children: number[] = [];
    for (const c of current) {
      for (const r of (await env.cr.query<{ id: number }>("SELECT id FROM res_company WHERE parent_id = $1 ORDER BY sequence, name, id", [c])).rows) {
        if (!children.includes(r.id)) children.push(r.id);
      }
    }
    current = children;
  }
  return env.uid === 1 ? company : null;
}

function selectionLabels(env: Environment, model: string, fname: string): Map<string, string> {
  const field = env.reg.model(model).fields.get(fname);
  if (!field?.selection) throw new NotPorted(`selection labels of ${model}.${fname}`);
  const lang = env.lang ?? "en_US";
  return new Map(field.selection.map((s) => [s.value, s.labels[lang] ?? s.label]));
}

// account_tax.py:630-651
registerHooks("account.tax", {
  displayName: async (env, ids) => {
    const M = "account.tax";
    const uses = selectionLabels(env, M, "type_tax_use"), scopes = selectionLabels(env, M, "tax_scope");
    const markdown = ctx(env, "formatted_display_name");
    const wrap = (s: string): string => (markdown ? `\t--${s}--` : ` (${s})`);
    const append = env.context["append_fields"];
    const include = new Set(Array.isArray(append) ? append.map(String) : []);
    const multi = (await env.companies()).length > 1;
    const [name, use, scope, country, company, code] = await Promise.all([
      vals(env, M, ids, "name"), vals(env, M, ids, "type_tax_use"), vals(env, M, ids, "tax_scope"), m2o(env, M, ids, "country_id"),
      m2o(env, M, ids, "company_id"), vals(env, M, ids, "country_code"),
    ]);
    const companies = uniq(company.values());
    const fiscal = new Map<number, number | null>();
    for (const c of companies) {
      const branch = await firstAccessibleBranch(env, c);
      fiscal.set(c, branch === null ? null : (await m2o(env, "res.company", [branch], "account_fiscal_country_id")).get(branch) ?? null);
    }
    const companyNames = include.has("company_id") && multi ? await dn(env, "res.company", companies) : new Map<number, string>();
    const out: Names = new Map();
    for (const id of ids) {
      let n = name.get(id);
      if (n) {
        let s = String(n);
        const u = uses.get(String(use.get(id)));
        if (include.has("type_tax_use") && u) s += wrap(u);
        const co = company.get(id) ?? null;
        if (include.has("company_id") && multi) s += wrap(co === null ? "" : companyNames.get(co) ?? "");
        const sc = scopes.get(String(scope.get(id)));
        if (markdown && sc) s += wrap(sc);
        if ((country.get(id) ?? null) !== (co === null ? null : fiscal.get(co) ?? null)) s += wrap(pyS(code.get(id)));
        n = s;
      } else throw new NotPorted("account.tax display_name False (unnamed tax)");
      out.set(id, String(n));
    }
    return out;
  },
});

// --------------------------------------------------------------------------------------------------------------
// base, mail, iap, privacy, payment
// --------------------------------------------------------------------------------------------------------------

// clearing_label.py:14-21
registerHooks("clearing.label", {
  displayName: async (env, ids) => {
    const M = "clearing.label";
    const [name, country] = await Promise.all([vals(env, M, ids, "name"), m2o(env, M, ids, "country_id")]);
    const formatted = ctx(env, "formatted_display_name");
    const cname = formatted ? await vals(env, "res.country", uniq(country.values()), "name") : new Map<number, unknown>();
    return new Map(ids.map((id) => {
      const c = country.get(id) ?? null;
      return [id, formatted && c !== null ? `${pyS(name.get(id))} \v --${pyS(cname.get(c))}--` : pyS(name.get(id))];
    }));
  },
});

// crm_iap_lead_role.py:21-23, crm_iap_lead_seniority.py:20-23: name.replace('_', ' ').title()
for (const model of ["crm.iap.lead.role", "crm.iap.lead.seniority"]) {
  registerHooks(model, {
    displayName: async (env, ids) => {
      const name = await vals(env, model, ids, "name");
      return new Map(ids.map((id) => [id, pyTitle(String(name.get(id) || "").replace(/_/g, " "))]));
    },
  });
}

// discuss_channel.py:249-263 (channel_name_member_ids: :265-290, the first 3 members of a group by id)
registerHooks("discuss.channel", {
  displayName: async (env, ids) => {
    const M = "discuss.channel";
    const [name, type] = await Promise.all([vals(env, M, ids, "name"), vals(env, M, ids, "channel_type")]);
    const out: Names = new Map();
    for (const id of ids) {
      const n = name.get(id);
      if (n) { out.set(id, String(n)); continue; }
      const parts: string[] = [];
      if (type.get(id) === "group") {
        const rows = (await env.cr.query<{ pname: string | null; gname: string | null }>(
          `SELECT p.name AS pname, g.name AS gname FROM (SELECT * FROM discuss_channel_member WHERE channel_id = $1 ORDER BY id LIMIT 3) m
             LEFT JOIN res_partner p ON p.id = m.partner_id LEFT JOIN mail_guest g ON g.id = m.guest_id ORDER BY m.id`, [id])).rows;
        for (const r of rows) parts.push(pyS(r.pname || r.gname || null));
      }
      const count = Number((await env.cr.query<{ n: string }>("SELECT count(*) AS n FROM discuss_channel_member WHERE channel_id = $1", [id])).rows[0]?.n ?? 0);
      if (count > 3) {
        const remaining = count - 3;
        parts.push(remaining === 1 ? translate(env, "1 other") : translate(env, "%s others").replace("%s", String(remaining)));
      }
      out.set(id, formatList(env, parts));
    }
    return out;
  },
});

// iap_service_pack.py:20-23
registerHooks("iap.service.pack", {
  displayName: async (env, ids) => {
    const M = "iap.service.pack";
    const [name, credit, price, service] = await Promise.all([vals(env, M, ids, "name"), vals(env, M, ids, "credit"), vals(env, M, ids, "price"), m2o(env, M, ids, "service_id")]);
    const services = uniq(service.values());
    const [integer, unit] = await Promise.all([vals(env, "iap.service", services, "integer_balance"), vals(env, "iap.service", services, "unit_name")]);
    return new Map(ids.map((id) => {
      const s = service.get(id) ?? null;
      const c = Number(credit.get(id) ?? 0);
      // round(credit, None) is an int; round(credit, 4) a float
      const cs = s !== null && integer.get(s) ? String(roundEven(c)) : pyFloatReprSimple(Math.round(c * 1e4) / 1e4);
      return [id, `${pyS(name.get(id))} - ${cs} ${pyS(s === null ? null : unit.get(s))} (${pyFloatS(price.get(id))} EUR)`];
    }));
  },
});

// ir_actions.py:491-506: babel format_datetime(create_date, tzinfo=env.tz, locale) - author
registerHooks("ir.actions.server.history", {
  displayName: async (env, ids) => {
    const M = "ir.actions.server.history";
    const [created, uid] = await Promise.all([vals(env, M, ids, "create_date"), m2o(env, M, ids, "create_uid")]);
    const authors = await vals(env, "res.users", uniq(uid.values()), "name");
    const out: Names = new Map();
    for (const id of ids) {
      const c = created.get(id);
      if (typeof c !== "string" || !c) throw new NotPorted("ir.actions.server.history display_name False (no create_date)");
      if ((env.lang ?? "en_US") !== "en_US") throw new NotPorted("babel format_datetime outside en_US");
      // en_US medium datetime: "MMM d, y, h:mm:ss a"
      const tz = await envTz(env);
      const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })
        .formatToParts(new Date(`${c.replace(" ", "T").slice(0, 19)}Z`)).map((x) => [x.type, x.value]));
      const label = `${p["month"]} ${p["day"]}, ${p["year"]}, ${p["hour"]}:${p["minute"]}:${p["second"]} ${String(p["dayPeriod"]).toUpperCase()}`;
      const u = uid.get(id) ?? null;
      out.set(id, tr(env, "%(date_label)s - %(author)s", { date_label: label, author: pyS(u === null ? null : authors.get(u)) }));
    }
    return out;
  },
});

// ir_embedded_actions.py:57-64: the action's display name (sudo), else the name
registerHooks("ir.embedded.actions", {
  displayName: async (env, ids) => {
    const M = "ir.embedded.actions";
    const [action, name] = await Promise.all([m2o(env, M, ids, "action_id"), vals(env, M, ids, "name")]);
    const names = await dn(env.sudo(), "ir.actions.actions", uniq(action.values()));
    return new Map(ids.map((id) => { const a = action.get(id) ?? null; return [id, a !== null ? names.get(a) ?? "" : pyS(name.get(id))]; }));
  },
});

// ir_model.py:2335-2346: the target record's display name or the complete name (invalid target, missing record,
// access error)
registerHooks("ir.model.data", {
  displayName: async (env, ids) => {
    const rows = (await env.cr.query<{ id: number; module: string | null; name: string | null; model: string | null; res_id: number | null }>(
      "SELECT id, module, name, model, res_id FROM ir_model_data WHERE id = ANY($1::int[])", [ids])).rows;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const complete = (id: number): string => { const r = byId.get(id); return [r?.module, r?.name].filter((n) => n).join("."); };
    const out: Names = new Map(ids.map((id) => [id, complete(id)]));
    const groups = new Map<string, number[]>();
    for (const id of ids) {
      const r = byId.get(id);
      if (!r || !r.res_id || !r.model || !env.reg.models.has(r.model)) continue;
      groups.set(r.model, [...(groups.get(r.model) ?? []), id]);
    }
    for (const [model, xids] of groups) {
      const def = env.reg.model(model);
      const targets = uniq(xids.map((x) => byId.get(x)!.res_id));
      if (def.abstract || !def.table) continue;
      // calendar_event.py:974-998: Odoo computes the name of a private event that is not cached yet inside its own
      // `_fetch_query` and shows 'Busy' for events `_check_private_event_conditions` accepts (measured on poc_erp:
      // public events of others read as 'Busy' here, by name through read())
      if (model === "calendar.event" && !env.su) throw new NotPorted("ir.model.data display_name of calendar events (_fetch_query order)");
      // a deleted target raises MissingError, an unreadable one AccessError: both give the complete name
      const existing = new Set((await env.cr.query<{ id: number }>(`SELECT id FROM "${def.table}" WHERE id = ANY($1::int[])`, [targets])).rows.map((r) => r.id));
      let readable = [...existing];
      // the generic name of a model without _rec_name reads no field, so it raises no AccessError
      if (!env.su && readable.length && (def.recName !== null || hooksOf(model).displayName)) {
        try {
          readable = await new ModelImpl(env.withContext({ ...env.context, active_test: false }), def).search(D.cond("id", "in", readable));
        } catch (e) {
          if (e instanceof AccessError) readable = [];
          else throw e;
        }
      }
      const names = await dn(env, model, readable);
      for (const x of xids) {
        const t = byId.get(x)!.res_id!;
        const n = names.get(t);
        if (n) out.set(x, n);
      }
    }
    return out;
  },
});

// ir_model.py:1317-1325: "<field description> (<model name>)" unless hide_model
registerHooks("ir.model.fields", {
  displayName: async (env, ids) => {
    const M = "ir.model.fields";
    const [desc, model] = await Promise.all([vals(env, M, ids, "field_description"), vals(env, M, ids, "model")]);
    if (ctx(env, "hide_model")) return new Map(ids.map((id) => [id, pyS(desc.get(id))]));
    const models = [...new Set([...model.values()].map(String))];
    const irModel = new Map((await env.cr.query<{ id: number; model: string }>("SELECT id, model FROM ir_model WHERE model = ANY($1::text[])", [models])).rows.map((r) => [r.model, r.id]));
    const modelNames = await vals(env, "ir.model", [...irModel.values()], "name");
    return new Map(ids.map((id) => {
      const mid = irModel.get(String(model.get(id)));
      return [id, `${pyS(desc.get(id))} (${pyS(mid === undefined ? null : modelNames.get(mid))})`];
    }));
  },
});

// ir_ui_menu.py:48-55 `_get_full_name(level=6)`, :142-145
registerHooks("ir.ui.menu", {
  displayName: async (env, ids) => {
    const M = "ir.ui.menu";
    const name = new Map<number, unknown>(), parent = new Map<number, number | null>();
    let todo = [...ids];
    for (let depth = 0; depth < 7 && todo.length; depth++) {
      const [n, p] = await Promise.all([vals(env, M, todo, "name"), m2o(env, M, todo, "parent_id")]);
      for (const id of todo) { name.set(id, n.get(id) ?? null); parent.set(id, p.get(id) ?? null); }
      todo = uniq(p.values()).filter((id) => !name.has(id));
    }
    const full = (id: number, level: number): string | null => {
      if (level <= 0) return "...";
      const p = parent.get(id) ?? null;
      const n = name.get(id);
      if (p !== null) return (full(p, level - 1) || "") + "/" + (n ? String(n) : "");
      return n ? String(n) : null;
    };
    return new Map(ids.map((id) => [id, full(id, 6) ?? ""]));
  },
});

// mail_followers.py:44-50: the partner's display name (sudo)
registerHooks("mail.followers", {
  displayName: async (env, ids) => {
    const partner = await m2o(env, "mail.followers", ids, "partner_id");
    const names = await dn(env.sudo(), "res.partner", uniq(partner.values()));
    return new Map(ids.map((id) => { const p = partner.get(id) ?? null; return [id, p === null ? "" : names.get(p) ?? ""]; }));
  },
});

// mail_guest.py:60-78
registerHooks("mail.guest", {
  displayNameFalse: true,
  displayName: async (env, ids) => {
    if (!ctx(env, "display_email")) return base(env, "mail.guest", ids);
    const name = await vals(env, "mail.guest", ids, "name");
    const formatted = ctx(env, "formatted_display_name");
    return new Map(ids.map((id) => [id, formatted
      ? tr(env, "%(guest_name)s --%(guest_indicator)s--", { guest_name: pyS(name.get(id)), guest_indicator: "(External)" })
      : tr(env, "%(guest_name)s (External)", { guest_name: pyS(name.get(id)) })]));
  },
});

// payment_token.py:48-53, :127-164 `_build_display_name()` (max_length 34, padded)
registerHooks("payment.token", {
  displayName: async (env, ids) => {
    const M = "payment.token";
    // a provider's override (payment_demo: `super()._build_display_name(should_pad=False)`, payment_paypal) passes
    // keyword arguments the private hooks cannot carry: refused where one of those modules is installed
    // (private_hooks.json, unported: the build installs no override, so hasPrivateOverride would never see one)
    if (ids.length && (await env.cr.query("SELECT 1 FROM ir_module_module WHERE name IN ('payment_demo', 'payment_paypal') AND state = 'installed'")).rows.length) {
      throw new NotPorted("payment.token display name with a provider's override (should_pad)");
    }
    const [details, created] = await Promise.all([vals(env, M, ids, "payment_details"), vals(env, M, ids, "create_date")]);
    return new Map(ids.map((id) => {
      const c = created.get(id);
      if (typeof c !== "string" || !c) return [id, ""];
      const d = details.get(id) ? String(details.get(id)) : "";
      const len = [...d].length, max = 34, padding = max - len;
      if (!d) return [id, tr(env, "Payment details saved on %(date)s", { date: c.slice(0, 10).replace(/-/g, "/") })];
      if (padding >= 2) return [id, `${"•".repeat(Math.min(padding - 1, 4))} ${d}`];
      if (padding > 0) return [id, d];
      return [id, [...d].slice(-max).join("")];
    }));
  },
});

// privacy_lookup_wizard.py:30-31
registerHooks("privacy.lookup.wizard", {
  displayName: async (env, ids) => new Map(ids.map((id) => [id, translate(env, "Privacy Lookup")])),
});

// res_city.py:18-26
registerHooks("res.city", {
  displayName: async (env, ids) => {
    const M = "res.city";
    const [name, zip, state] = await Promise.all([vals(env, M, ids, "name"), vals(env, M, ids, "zipcode"), m2o(env, M, ids, "state_id")]);
    const formatted = ctx(env, "formatted_display_name");
    const sname = formatted ? await vals(env, "res.country.state", uniq(state.values()), "name") : new Map<number, unknown>();
    return new Map(ids.map((id) => {
      const z = zip.get(id);
      const n = z ? `${pyS(name.get(id))} (${String(z)})` : pyS(name.get(id));
      const s = state.get(id) ?? null;
      return [id, formatted && s !== null ? `${n} \v--${pyS(sname.get(s))}--` : n];
    }));
  },
});

/** res_partner_bank.py:8-11 sanitize_account_number: `re.sub(r'\W+', '', number).upper()`, False when empty. */
function sanitizeAccountNumber(v: unknown): string | false {
  return v ? String(v).replace(/[^\p{L}\p{N}_]+/gu, "").toUpperCase() : false;
}

// res_partner_bank.py:172-175; :148-153 `_search_account_number` on the sanitized number
registerHooks("res.partner.bank", {
  search: {
    account_number: async (_env, operator, value) => {
      if (operator === "in" || operator === "not in") {
        if (!Array.isArray(value)) throw new NotPorted("res.partner.bank account_number 'in' with a non-list value");
        return D.cond("sanitized_account_number", operator, value.map(sanitizeAccountNumber));
      }
      return D.cond("sanitized_account_number", operator, sanitizeAccountNumber(value));
    },
  },
  displayName: async (env, ids) => {
    const M = "res.partner.bank";
    const [number, bank] = await Promise.all([vals(env, M, ids, "account_number"), vals(env, M, ids, "bank_name")]);
    return new Map(ids.map((id) => { const b = bank.get(id); return [id, b ? `${pyS(number.get(id))} - ${String(b)}` : pyS(number.get(id))]; }));
  },
});

// res_users_settings_volumes.py:26-29
registerHooks("res.users.settings.volumes", {
  displayName: async (env, ids) => {
    const M = "res.users.settings.volumes";
    const [setting, partner, guest] = await Promise.all([m2o(env, M, ids, "user_setting_id"), m2o(env, M, ids, "partner_id"), m2o(env, M, ids, "guest_id")]);
    const user = await m2o(env, "res.users.settings", uniq(setting.values()), "user_id");
    const [uname, pname, gname] = await Promise.all([vals(env, "res.users", uniq(user.values()), "name"), vals(env, "res.partner", uniq(partner.values()), "name"), vals(env, "mail.guest", uniq(guest.values()), "name")]);
    return new Map(ids.map((id) => {
      const s = setting.get(id) ?? null, u = s === null ? null : user.get(s) ?? null;
      const p = partner.get(id) ?? null, g = guest.get(id) ?? null;
      const other = (p === null ? null : pname.get(p)) || (g === null ? null : gname.get(g)) || null;
      return [id, `${pyS(u === null ? null : uname.get(u))} - ${pyS(other)}`];
    }));
  },
});

// resource_calendar_attendance.py:352-361: format_duration (misc.py:1622-1633); the timed branch needs format_time
registerHooks("resource.calendar.attendance", {
  displayName: async (env, ids) => {
    const M = "resource.calendar.attendance";
    const [hours, based] = await Promise.all([vals(env, M, ids, "duration_hours"), vals(env, M, ids, "duration_based")]);
    return new Map(ids.map((id) => {
      if (!based.get(id)) throw new NotPorted("resource.calendar.attendance display_name with hour_from/hour_to (format_time)");
      const v = Number(hours.get(id) ?? 0);
      let h = Math.floor(Math.abs(v) * 60 / 60), m = Math.round((Math.abs(v) * 60) % 60);
      // Python round(): ties to even
      const raw = (Math.abs(v) * 60) % 60;
      if (raw - Math.floor(raw) === 0.5) m = Math.floor(raw) % 2 === 0 ? Math.floor(raw) : Math.floor(raw) + 1;
      if (m === 60) { m = 0; h += 1; }
      const duration = `${v < 0 ? "-" : ""}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      return [id, tr(env, "%(duration)s hours A", { duration })];
    }));
  },
});

// --------------------------------------------------------------------------------------------------------------
// product, project, purchase
// --------------------------------------------------------------------------------------------------------------

// product_category.py:65-70: the complete name unless hierarchical_naming is falsy
registerHooks("product.category", {
  displayNameFalse: true,
  displayName: async (env, ids) => {
    if (pyTruthy(env.context["hierarchical_naming"] ?? true)) return base(env, "product.category", ids);
    const name = await vals(env, "product.category", ids, "name");
    return new Map(ids.map((id) => [id, pyS(name.get(id))]));
  },
});

// product_pricelist.py:64-68
registerHooks("product.pricelist", {
  displayName: async (env, ids) => {
    const M = "product.pricelist";
    const [name, currency] = await Promise.all([vals(env, M, ids, "name"), m2o(env, M, ids, "currency_id")]);
    const cname = await vals(env, "res.currency", uniq(currency.values()), "name");
    return new Map(ids.map((id) => {
      const c = currency.get(id) ?? null;
      return [id, `${name.get(id) ? String(name.get(id)) : translate(env, "New")} (${pyS(c === null ? null : cname.get(c))})`];
    }));
  },
});

// product_pricelist_item.py:219-222 "<price> - <name>": both are computed labels (formatLang, the rule's base)
registerHooks("product.pricelist.item", {
  displayName: async (_env, ids) => {
    if (ids.length) throw new NotPorted("product.pricelist.item display_name (_compute_price_label, _compute_name)");
    return new Map();
  },
});

// project_collaborator.py:24-27
registerHooks("project.collaborator", {
  displayName: async (env, ids) => {
    const M = "project.collaborator";
    const [project, partner] = await Promise.all([m2o(env, M, ids, "project_id"), m2o(env, M, ids, "partner_id")]);
    const [pn, rn] = await Promise.all([dn(env, "project.project", uniq(project.values())), dn(env, "res.partner", uniq(partner.values()))]);
    return new Map(ids.map((id) => {
      const p = project.get(id) ?? null, r = partner.get(id) ?? null;
      return [id, `${p === null ? "" : pn.get(p) ?? ""} - ${r === null ? "" : rn.get(r) ?? ""}`];
    }));
  },
});

// project_task.py:390-397: the name, with the project muted in formatted names when show_muted_project
registerHooks("project.task", {
  displayNameFalse: true,
  displayName: async (env, ids) => {
    const M = "project.task";
    const names = await base(env, M, ids);
    if (!(ctx(env, "formatted_display_name") && ctx(env, "show_muted_project"))) return names;
    const [name, project] = await Promise.all([vals(env, M, ids, "name"), m2o(env, M, ids, "project_id")]);
    const pname = await vals(env, "project.project", uniq(project.values()), "name");
    for (const id of ids) {
      const p = project.get(id) ?? null;
      if (p !== null) names.set(id, `${pyS(name.get(id))} \t --${pyS(pname.get(p))}--`);
    }
    return names;
  },
});

// purchase_bill.py:24-41
registerHooks("purchase.bill.union", {
  displayName: async (env, ids) => {
    const M = "purchase.bill.union";
    const [name, reference, amount, order, currency, date] = await Promise.all([
      vals(env, M, ids, "name"), vals(env, M, ids, "reference"), vals(env, M, ids, "amount"), m2o(env, M, ids, "purchase_order_id"),
      m2o(env, M, ids, "currency_id"), vals(env, M, ids, "date"),
    ]);
    const status = await vals(env, "purchase.order", uniq(order.values()), "invoice_status");
    const formatted = ctx(env, "formatted_display_name");
    const out: Names = new Map();
    for (const id of ids) {
      const o = order.get(id) ?? null;
      const a = o !== null && status.get(o) === "no" ? 0 : Number(amount.get(id) ?? 0);
      const money = await formatLangCurrency(env, a, currency.get(id) ?? null);
      const n = name.get(id) ? String(name.get(id)) : "", ref = reference.get(id) ? String(reference.get(id)) : "";
      if (formatted) {
        const d = date.get(id);
        const header = `**${n}**${ref ? ` (${ref})` : ""}\t${money}`;
        out.set(id, `${header}\t${typeof d === "string" && d ? await formatDate(env, d) : ""}`);
      } else out.set(id, `${n}${ref ? ` - ${ref}` : ""}: ${money}`);
    }
    return out;
  },
});

// purchase_order_line.py:224-238
registerHooks("purchase.order.line", {
  displayNameFalse: true,
  displayName: async (env, ids) => {
    const M = "purchase.order.line";
    if (!ctx(env, "display_order_name")) return base(env, M, ids);
    if (ctx(env, "formatted_display_name") && ids.length) throw new NotPorted("purchase.order.line formatted display_name (currency.format, qty_to_invoice)");
    const order = await m2o(env, M, ids, "order_id");
    const oname = await vals(env, "purchase.order", uniq(order.values()), "name");
    return new Map(ids.map((id) => { const o = order.get(id) ?? null; return [id, pyS(o === null ? null : oname.get(o))]; }));
  },
});

// --------------------------------------------------------------------------------------------------------------
// stock, uom, calendar
// --------------------------------------------------------------------------------------------------------------

async function dims(env: Environment, ids: readonly number[]): Promise<Map<number, string | null>> {
  const M = "stock.package.type";
  const [l, w, h] = await Promise.all([vals(env, M, ids, "packaging_length"), vals(env, M, ids, "width"), vals(env, M, ids, "height")]);
  return new Map(ids.map((id) => [id, l.get(id) && w.get(id) && h.get(id) ? `${pyFloatS(l.get(id))} x ${pyFloatS(w.get(id))} x ${pyFloatS(h.get(id))}` : null]));
}

// stock_package.py:70-89
registerHooks("stock.package", {
  displayName: async (env, ids) => {
    const M = "stock.package";
    const field = ctx(env, "is_done") ? "name" : ctx(env, "show_dest_package") ? "dest_complete_name" : ctx(env, "show_src_package") ? "complete_name" : "name";
    const [shown, type] = await Promise.all([vals(env, M, ids, field), m2o(env, M, ids, "package_type_id")]);
    const formatted = ctx(env, "formatted_display_name");
    const d = formatted ? await dims(env, uniq(type.values())) : new Map<number, string | null>();
    return new Map(ids.map((id) => {
      const t = type.get(id) ?? null;
      const s = t === null ? null : d.get(t) ?? null;
      return [id, formatted && s !== null ? `${pyS(shown.get(id))}\t--${s}--` : pyS(shown.get(id))];
    }));
  },
});

// stock_package_type.py:62-72
registerHooks("stock.package.type", {
  displayNameFalse: true,
  displayName: async (env, ids) => {
    const M = "stock.package.type";
    const names = await base(env, M, ids);
    if (!ctx(env, "formatted_display_name")) return names;
    const [name, d] = await Promise.all([vals(env, M, ids, "name"), dims(env, ids)]);
    for (const id of ids) { const s = d.get(id) ?? null; if (s !== null) names.set(id, `${pyS(name.get(id))}\t--${s}--`); }
    return names;
  },
});

// stock_picking.py:205-222; :246-250 `_search_display_name` also matches the origin and the partner
registerHooks("stock.picking", {
  displayNameFalse: true,
  displayName: async (env, ids) => {
    const M = "stock.picking";
    const names = await base(env, M, ids);
    const formatted = ctx(env, "formatted_display_name");
    if (!formatted && !ctx(env, "display_name_partner")) return names;
    const [origin, partner] = await Promise.all([vals(env, M, ids, "origin"), m2o(env, M, ids, "partner_id")]);
    const pn = await dn(env, "res.partner", uniq(partner.values()));
    for (const id of ids) {
      const p = partner.get(id) ?? null;
      if (formatted) {
        const extra = [origin.get(id) ? String(origin.get(id)) : null, p !== null ? pn.get(p) ?? "" : null].filter((x): x is string => x !== null);
        if (extra.length) names.set(id, `${names.get(id) ?? ""}\t--${extra.join(" ")}--`);
      } else if (p !== null) names.set(id, `${names.get(id) ?? ""} - ${pn.get(p) ?? ""}`);
    }
    return names;
  },
  searchDisplayName: async (env, operator, value) =>
    D.or([searchDisplayNameDefault(env, env.reg.model("stock.picking"), operator, value), D.cond("origin", operator, value), D.cond("partner_id", operator, value)]),
});

// stock_picking_batch.py:72-78
registerHooks("stock.picking.batch", {
  displayNameFalse: true,
  displayName: async (env, ids) => {
    const M = "stock.picking.batch";
    if (!ctx(env, "add_to_existing_batch")) return base(env, M, ids);
    const [name, desc] = await Promise.all([vals(env, M, ids, "name"), vals(env, M, ids, "description")]);
    return new Map(ids.map((id) => [id, desc.get(id) ? `${pyS(name.get(id))}: ${String(desc.get(id))}` : pyS(name.get(id))]));
  },
});

// stock_quant.py:590-612
registerHooks("stock.quant", {
  displayName: async (env, ids) => {
    const M = "stock.quant";
    const [location, lot, pack, owner] = await Promise.all([m2o(env, M, ids, "location_id"), m2o(env, M, ids, "lot_id"), m2o(env, M, ids, "package_id"), m2o(env, M, ids, "owner_id")]);
    const [lotName, packName] = await Promise.all([vals(env, "stock.lot", uniq(lot.values()), "name"), dn(env, "stock.package", uniq(pack.values()))]);
    const out: Names = new Map();
    if (ctx(env, "formatted_display_name")) {
      const lname = await vals(env, "stock.location", uniq(location.values()), "name");
      for (const id of ids) {
        const l = location.get(id) ?? null, k = pack.get(id) ?? null, t = lot.get(id) ?? null;
        let n = pyS(l === null ? null : lname.get(l));
        if (k !== null) n += `\t--${packName.get(k) ?? ""}--`;
        if (t !== null) n += `${k !== null ? " " : "\t"}--${pyS(lotName.get(t))}--`;
        out.set(id, n);
      }
      return out;
    }
    const [ldn, oname] = await Promise.all([dn(env, "stock.location", uniq(location.values())), vals(env, "res.partner", uniq(owner.values()), "name")]);
    for (const id of ids) {
      const l = location.get(id) ?? null, k = pack.get(id) ?? null, t = lot.get(id) ?? null, o = owner.get(id) ?? null;
      const parts = [l === null ? "" : ldn.get(l) ?? ""];
      if (t !== null) parts.push(pyS(lotName.get(t)));
      if (k !== null) parts.push(packName.get(k) ?? "");
      if (o !== null) parts.push(pyS(oname.get(o)));
      out.set(id, parts.join(" - "));
    }
    return out;
  },
});

// uom_uom.py:130-137
registerHooks("uom.uom", {
  displayNameFalse: true,
  displayName: async (env, ids) => {
    const M = "uom.uom";
    const names = await base(env, M, ids);
    if (!ctx(env, "formatted_display_name")) return names;
    const [name, factor, rel] = await Promise.all([vals(env, M, ids, "name"), vals(env, M, ids, "relative_factor"), m2o(env, M, ids, "relative_uom_id")]);
    const rname = await vals(env, M, uniq(rel.values()), "name");
    for (const id of ids) {
      const r = rel.get(id) ?? null;
      if (r !== null) names.set(id, `${pyS(name.get(id))}\t--${pyFloatS(factor.get(id))} ${pyS(rname.get(r))}--`);
    }
    return names;
  },
});

// calendar_event.py:1151-1156: 'Busy' for the private events of others (`_check_private_event_conditions`)
registerHooks("calendar.event", {
  displayNameFalse: true,
  displayName: async (env, ids) => {
    const names = await base(env, "calendar.event", ids);
    for (const id of ids) if (await othersPrivate(env, id)) names.set(id, translate(env, "Busy"));
    return names;
  },
});

// --------------------------------------------------------------------------------------------------------------
// name_search and _search_display_name overrides measured with the display names
// --------------------------------------------------------------------------------------------------------------

// account_report.py:55, :383-384 `_compute_sql_active`: the active field of every search
registerHooks("account.report", {
  computeSql: { active: async (table) => sql`COALESCE(${await table.field("active_selection")} = 'True', ${await table.field("active_fallback")})` },
});

/** res_country.py:278-286 `_get_name_search_domain`: "Name (Country)". */
function stateNameDomain(name: unknown, operator: string): Domain {
  const m = typeof name === "string" ? /^(.+)\((.+)\)$/.exec(name) : null;
  if (!m) return D.FALSE;
  const country = m[2]!.trim();
  return D.and([D.cond("name", operator, m[1]!.trim()), D.or([D.cond("country_id.name", "ilike", country), D.cond("country_id.code", "=", country)])]);
}

registerHooks("res.country.state", {
  // res_country.py:240-263: the states whose code matches first, then the normal search
  nameSearch: async (env, name, domain, operator, limit) => {
    const def = env.reg.model("res.country.state");
    const model = new ModelImpl(env, def);
    if (operator === "in") throw new NotPorted("res.country.state name_search with operator 'in'");
    const result: [number, string | false][] = [];
    let dom = domain, lim = limit;
    if (!D.isNegativeOperator(operator) && name) {
      const states = await model.search(D.and([dom, D.cond("code", "=like", name)]), { limit: lim });
      const names = await new ModelImpl(env.sudo(), def).values(states, def.fields.get("display_name")!);
      for (const id of states) result.push([id, (names.get(id) as string | false | undefined) ?? false]);
      dom = D.and([dom, D.cond("id", "not in", states)]);
      if (lim !== null) {
        lim -= states.length;
        if (lim <= 0) return result;
      }
    }
    result.push(...await model.baseNameSearch(name, dom, operator, lim));
    return result;
  },
  // res_country.py:265-276
  searchDisplayName: async (env, operator, value) => {
    let domain = searchDisplayNameDefault(env, env.reg.model("res.country.state"), operator, value);
    if (pyTruthy(value) && !D.isNegativeOperator(operator)) {
      if (operator === "ilike" || operator === "=") domain = D.or([domain, stateNameDomain(value, operator)]);
      else if (operator === "in") domain = D.or([domain, ...(Array.isArray(value) ? value : []).map((v) => stateNameDomain(v, "="))]);
    }
    const country = env.context["country_id"];
    if (country) domain = D.and([domain, D.cond("country_id", "=", country)]);
    return domain;
  },
});

// --------------------------------------------------------------------------------------------------------------
// The same computes on new records (onchange): a hook above answers for stored records only (src/orm/recompute.ts
// computes display_name of a new record through registerRecordCompute). Models without one refuse there.
// --------------------------------------------------------------------------------------------------------------

const text = async (rec: Rec, f: string): Promise<string | null> => { const v = await rec.get(f); return v === null || v === undefined || v === false || v === "" ? null : String(v); };
const relName = async (rec: Rec, f: string, sub = "name"): Promise<string | null> => { const r = await rec.rel(f); return r ? text(r, sub) : null; };
const relDisplay = async (rec: Rec, f: string): Promise<string> => { const r = await rec.rel(f); return r ? String((await r.get("display_name")) || "") : ""; };

registerRecordCompute("account.account.tag", {
  display_name: async (env, rec) => {
    if (await multiVatForeignCountries(env)) throw new NotPorted("account.account.tag display_name of a new tag with foreign VAT fiscal positions");
    return baseRecordDisplayName(rec);
  },
});
registerRecordCompute("account.incoterms", {
  display_name: async (_env, rec) => { const c = await text(rec, "code"); return `${c ? `[${c}] ` : ""}${pyS(await text(rec, "name"))}`; },
});
registerRecordCompute("account.journal", {
  display_name: async (env, rec) => {
    let n = pyS(await text(rec, "name"));
    const cur = await rec.rel("currency_id"), company = await rec.rel("company_id");
    const ccur = company ? await company.get("currency_id") : null;
    if (cur && cur.origin !== (typeof ccur === "number" ? ccur : null)) n = `${n} (${pyS(await text(cur, "name"))})`;
    if ((await env.companies()).length > 1 && ctx(env, "show_company_journal")) n = `${pyS(company ? await text(company, "name") : null)} - ${n}`;
    return n;
  },
});
registerRecordCompute("account.payment.method.line", {
  display_name: async (env, rec) => ctx(env, "hide_payment_journal_id") ? baseRecordDisplayName(rec) : `${pyS(await text(rec, "name"))} (${pyS(await relName(rec, "journal_id"))})`,
});
registerRecordCompute("account.report", {
  display_name: async (_env, rec) => {
    const n = await text(rec, "name");
    if (!n) return false;
    const code = await relName(rec, "country_id", "code");
    return n + ((await rec.rel("country_id")) ? ` (${pyS(code)})` : "");
  },
});
registerRecordCompute("account.report.expression", {
  display_name: async (_env, rec) => `${pyS(await text(rec, "report_line_name"))} [${pyS(await text(rec, "label"))}]`,
});
registerRecordCompute("account.tax", {
  display_name: async (env, rec) => {
    const n = await text(rec, "name");
    if (!n) return false;
    const M = "account.tax";
    const markdown = ctx(env, "formatted_display_name");
    const wrap = (x: string): string => (markdown ? `\t--${x}--` : ` (${x})`);
    const append = env.context["append_fields"];
    const include = new Set(Array.isArray(append) ? append.map(String) : []);
    let s = n;
    const use = selectionLabels(env, M, "type_tax_use").get(String(await rec.get("type_tax_use")));
    if (include.has("type_tax_use") && use) s += wrap(use);
    const company = await rec.rel("company_id");
    if (include.has("company_id") && (await env.companies()).length > 1) s += wrap(company ? String((await company.get("display_name")) || "") : "");
    const scope = selectionLabels(env, M, "tax_scope").get(String(await rec.get("tax_scope")));
    if (markdown && scope) s += wrap(scope);
    const branch = company?.origin ? await firstAccessibleBranch(env, company.origin) : null;
    if (company && company.origin === null) throw new NotPorted("account.tax display_name with a new company");
    const fiscal = branch === null ? null : (await m2o(env, "res.company", [branch], "account_fiscal_country_id")).get(branch) ?? null;
    const country = await rec.rel("country_id");
    if ((country?.origin ?? null) !== fiscal) s += wrap(pyS(country ? await text(country, "code") : null));
    return s;
  },
});
registerRecordCompute("calendar.event", {
  // a new event of the current user is never another's private event (calendar_event.py:1121-1150)
  display_name: async (env, rec) => {
    const user = await rec.get("user_id");
    if (user !== env.uid) throw new NotPorted("calendar.event display_name of a new event of another user (_check_private_event_conditions)");
    return baseRecordDisplayName(rec);
  },
});
registerRecordCompute("clearing.label", {
  display_name: async (env, rec) => {
    const country = await rec.rel("country_id");
    return ctx(env, "formatted_display_name") && country ? `${pyS(await text(rec, "name"))} \v --${pyS(await text(country, "name"))}--` : pyS(await text(rec, "name"));
  },
});
for (const model of ["crm.iap.lead.role", "crm.iap.lead.seniority"]) {
  registerRecordCompute(model, { display_name: async (_env, rec) => pyTitle((await text(rec, "name") ?? "").replace(/_/g, " ")) });
}
registerRecordCompute("ir.actions.server.history", {
  display_name: async (_env, rec) => { if (await rec.get("create_date")) throw new NotPorted("ir.actions.server.history display_name"); return false; },
});
registerRecordCompute("ir.model.data", {
  display_name: async (_env, rec) => {
    if (await rec.get("res_id")) throw new NotPorted("ir.model.data display_name of a new record with a target");
    return [await text(rec, "module"), await text(rec, "name")].filter((x) => x).join(".");
  },
});
registerRecordCompute("ir.model.fields", {
  display_name: async (env, rec) => {
    const desc = pyS(await text(rec, "field_description"));
    if (ctx(env, "hide_model")) return desc;
    const model = await text(rec, "model");
    const id = model === null ? undefined : (await env.cr.query<{ id: number }>("SELECT id FROM ir_model WHERE model = $1", [model])).rows[0]?.id;
    return `${desc} (${pyS(id === undefined ? null : (await vals(env, "ir.model", [id], "name")).get(id))})`;
  },
});
async function menuFullName(rec: Rec, level: number): Promise<string | null> {
  if (level <= 0) return "...";
  const parent = await rec.rel("parent_id");
  const n = await text(rec, "name");
  if (parent) return ((await menuFullName(parent, level - 1)) || "") + "/" + (n ?? "");
  return n;
}
registerRecordCompute("ir.ui.menu", { display_name: async (_env, rec) => (await menuFullName(rec, 6)) ?? false });
registerRecordCompute("mail.followers", { display_name: async (env, rec) => { const p = await rec.rel("partner_id"); return p?.origin ? (await dn(env.sudo(), "res.partner", [p.origin])).get(p.origin) ?? "" : p ? relDisplay(rec, "partner_id") : ""; } });
registerRecordCompute("mail.guest", {
  display_name: async (env, rec) => {
    if (!ctx(env, "display_email")) return baseRecordDisplayName(rec);
    const name = pyS(await text(rec, "name"));
    return ctx(env, "formatted_display_name") ? tr(env, "%(guest_name)s --%(guest_indicator)s--", { guest_name: name, guest_indicator: "(External)" })
      : tr(env, "%(guest_name)s (External)", { guest_name: name });
  },
});
registerRecordCompute("payment.token", { display_name: async (_env, rec) => { if (await rec.get("create_date")) throw new NotPorted("payment.token display_name"); return ""; } });
registerRecordCompute("privacy.lookup.wizard", { display_name: async (env) => translate(env, "Privacy Lookup") });
registerRecordCompute("product.category", {
  display_name: async (env, rec) => pyTruthy(env.context["hierarchical_naming"] ?? true) ? baseRecordDisplayName(rec) : pyS(await text(rec, "name")),
});
registerRecordCompute("product.pricelist", {
  display_name: async (env, rec) => `${(await text(rec, "name")) ?? translate(env, "New")} (${pyS(await relName(rec, "currency_id"))})`,
});
registerRecordCompute("project.collaborator", { display_name: async (_env, rec) => `${await relDisplay(rec, "project_id")} - ${await relDisplay(rec, "partner_id")}` });
registerRecordCompute("project.task", {
  display_name: async (env, rec) => {
    const project = await rec.rel("project_id");
    if (ctx(env, "formatted_display_name") && ctx(env, "show_muted_project") && project) return `${pyS(await text(rec, "name"))} \t --${pyS(await text(project, "name"))}--`;
    return baseRecordDisplayName(rec);
  },
});
registerRecordCompute("purchase.order.line", {
  display_name: async (env, rec) => {
    if (!ctx(env, "display_order_name")) return baseRecordDisplayName(rec);
    if (ctx(env, "formatted_display_name")) throw new NotPorted("purchase.order.line formatted display_name (currency.format, qty_to_invoice)");
    return pyS(await relName(rec, "order_id"));
  },
});
registerRecordCompute("res.city", {
  display_name: async (env, rec) => {
    const zip = await text(rec, "zipcode");
    const n = zip ? `${pyS(await text(rec, "name"))} (${zip})` : pyS(await text(rec, "name"));
    const state = await rec.rel("state_id");
    return ctx(env, "formatted_display_name") && state ? `${n} \v--${pyS(await text(state, "name"))}--` : n;
  },
});
registerRecordCompute("res.partner.bank", {
  display_name: async (_env, rec) => { const b = await text(rec, "bank_name"); const n = pyS(await text(rec, "account_number")); return b ? `${n} - ${b}` : n; },
});
registerRecordCompute("resource.calendar.attendance", {
  display_name: async () => { throw new NotPorted("resource.calendar.attendance display_name of a new attendance"); },
});
registerRecordCompute("stock.package.type", {
  display_name: async (env, rec) => {
    const l = await rec.get("packaging_length"), w = await rec.get("width"), h = await rec.get("height");
    if (ctx(env, "formatted_display_name") && l && w && h) return `${pyS(await text(rec, "name"))}\t--${pyFloatS(l)} x ${pyFloatS(w)} x ${pyFloatS(h)}--`;
    return baseRecordDisplayName(rec);
  },
});
registerRecordCompute("stock.picking", {
  display_name: async (env, rec) => {
    const base0 = await baseRecordDisplayName(rec);
    const partner = await rec.rel("partner_id");
    if (ctx(env, "formatted_display_name")) {
      const extra = [await text(rec, "origin"), partner ? await relDisplay(rec, "partner_id") : null].filter((x): x is string => x !== null);
      return extra.length ? `${pyS(base0)}\t--${extra.join(" ")}--` : base0;
    }
    if (ctx(env, "display_name_partner") && partner) return `${pyS(base0)} - ${await relDisplay(rec, "partner_id")}`;
    return base0;
  },
});
registerRecordCompute("stock.picking.batch", {
  display_name: async (env, rec) => {
    if (!ctx(env, "add_to_existing_batch")) return baseRecordDisplayName(rec);
    const d = await text(rec, "description");
    return d ? `${pyS(await text(rec, "name"))}: ${d}` : pyS(await text(rec, "name"));
  },
});
registerRecordCompute("uom.uom", {
  display_name: async (env, rec) => {
    const rel = await rec.rel("relative_uom_id");
    if (ctx(env, "formatted_display_name") && rel) return `${pyS(await text(rec, "name"))}\t--${pyFloatS(await rec.get("relative_factor"))} ${pyS(await text(rel, "name"))}--`;
    return baseRecordDisplayName(rec);
  },
});
