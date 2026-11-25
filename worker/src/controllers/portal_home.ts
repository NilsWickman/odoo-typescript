/**
 * The customer portal's home and list pages: `/my`, `/my/home` and `/my/counters` (portal/controllers/portal.py:155-233
 * with the counters of sale, account, project, purchase and portal_discuss), `/my/account` (:235-263), `/my/quotes` and
 * `/my/orders` (sale/controllers/portal.py:36-118), `/my/invoices` (account/controllers/portal.py:41-143), `/my/projects`
 * (project/controllers/portal.py:56-114) and `/my/tasks` (:315-575 with sale_project/controllers/portal.py).
 * What a page needs that is not ported (a search, a group other than the default one, another module's counter)
 * refuses with NotPorted.
 */
import { NotPorted } from "../errors";
import type { RequestContext } from "../http/context";
import { jsonRoute, route } from "../http/router";
import { accessDomain } from "../orm/access";
import { registerHooks } from "../orm/hooks";
import { sql } from "../orm/sql";
import { envTz } from "../orm/env";
import { parseDomain } from "../orm/domain";
import type { Environment } from "../orm/types";
import { write } from "../orm/write";
import { dbNow, todayInTz, translate } from "../models/util";
import { PyRecords, registerPyMethod } from "../qweb/records";
import { escape as escapeHtml, Markup } from "../pyexpr/values";
import { renderPage, urlEncode } from "./page";
import { PyStrSet } from "../web/pystrset";
import { isPublicUser, withPortalTokenBatch } from "./portal_invoice";
import { frontendLangCookie } from "./report";

type DomainList = unknown[];

/** models.py `has_access(operation)` at model level: the access domain is not FALSE. */
async function hasAccess(env: Environment, model: string, operation: "read" = "read"): Promise<boolean> {
  return (await accessDomain(env, env.reg.model(model), operation)).kind !== "false";
}

async function userPartner(env: Environment): Promise<number> {
  return (await env.sudo().cr.query<{ partner_id: number }>("SELECT partner_id FROM res_users WHERE id = $1", [env.uid])).rows[0]!.partner_id;
}

async function commercialPartner(env: Environment, partnerId: number): Promise<number> {
  return (await env.sudo().cr.query<{ id: number | null }>("SELECT commercial_partner_id AS id FROM res_partner WHERE id = $1", [partnerId])).rows[0]?.id ?? partnerId;
}

/** portal/controllers/portal.py:31-102 `pager`. */
export function portalPager(url: string, total: number, page: number | string = 1, step = 30, urlArgs: Readonly<Record<string, unknown>> | null = null): Map<string, unknown> {
  const pageCount = Math.ceil(total / step);
  const asked = /^\d+$/.test(String(page)) ? Number(page) : 1;
  const cur = Math.max(1, Math.min(asked, pageCount));
  const prev = Math.max(1, cur - 1);
  const next = Math.min(pageCount, cur + 1);
  const getUrl = (p: number): string => {
    let u = p > 1 ? `${url}/page/${p}` : url;
    if (urlArgs && Object.keys(urlArgs).length) u = `${u}?${urlEncode(Object.entries(urlArgs))}`;
    return u;
  };
  let list: (number | string)[];
  if (pageCount <= 5) list = Array.from({ length: pageCount }, (_, i) => i + 1);
  else if (cur <= 3) list = [1, 2, 3, 4, "…", pageCount];
  else if (cur >= pageCount - 2) list = [1, "…", pageCount - 3, pageCount - 2, pageCount - 1, pageCount];
  else list = [1, "…", cur - 1, cur, cur + 1, "…", pageCount];
  const link = (p: number) => new Map<string, unknown>([["url", getUrl(p)], ["num", p]]);
  return new Map<string, unknown>([
    ["page_count", pageCount],
    ["offset", (cur - 1) * step],
    ["page", link(cur)],
    ["page_first", link(1)],
    ["page_previous", link(prev)],
    ["page_next", link(next)],
    ["page_last", link(pageCount)],
    ["pages", list.map((p) => new Map<string, unknown>([["num", p], ["url", p !== "…" ? getUrl(p as number) : null], ["is_current", p === cur]]))],
  ]);
}

/** A dict of dicts in Python's insertion order, as the templates read `searchbar_sortings` and the like. */
function dictOf(o: Readonly<Record<string, Readonly<Record<string, unknown>>>>): Map<string, Map<string, unknown>> {
  return new Map(Object.entries(o).map(([k, v]) => [k, new Map(Object.entries(v))]));
}

// ------------------------------------------------------------------------------------------------------------------
// portal.entry (portal/models/portal_entry.py, payment/models/portal_entry.py, portal_discuss/models/portal_entry.py)
// ------------------------------------------------------------------------------------------------------------------

async function xmlidRes(env: Environment, module: string, name: string): Promise<number | null> {
  return (await env.sudo().cr.query<{ res_id: number }>("SELECT res_id FROM ir_model_data WHERE module = $1 AND name = $2", [module, name])).rows[0]?.res_id ?? null;
}

async function installed(env: Environment, module: string): Promise<boolean> {
  return (await env.sudo().cr.query("SELECT 1 FROM ir_module_module WHERE name = $1 AND state = 'installed'", [module])).rows.length > 0;
}

registerPyMethod("portal.entry", "_filter_visible_portal_cards", async (recs) => {
  const env = recs.env;
  const visible: number[] = [];
  for (const id of recs.ids) {
    const r = (await env.sudo().cr.query<{ is_config_card: boolean | null }>("SELECT is_config_card FROM portal_entry WHERE id = $1", [id])).rows[0];
    if (r?.is_config_card) visible.push(id);
  }
  const drop = (id: number) => { const i = visible.indexOf(id); if (i >= 0) visible.splice(i, 1); };
  // payment/models/portal_entry.py:9-35: the payment methods card needs a provider allowing tokenization or a token
  const payEntry = await installed(env, "payment") ? await xmlidRes(env, "payment", "payment_methods_portal_entry") : null;
  if (payEntry !== null && recs.ids.includes(payEntry)) {
    const companyId = await env.company();
    const path = (await env.sudo().cr.query<{ parent_path: string }>("SELECT parent_path FROM res_company WHERE id = $1", [companyId])).rows[0]!.parent_path;
    const parents = path.split("/").filter(Boolean).map(Number);
    const providers = (await env.sudo().cr.query(
      `SELECT 1 FROM payment_provider p LEFT JOIN ir_module_module m ON m.id = p.module_id
        WHERE p.active AND COALESCE(p.allow_tokenization, false)
          AND (m.state = 'installed' OR p.module_id IS NULL)
          AND (p.company_id IS NULL OR p.company_id = ANY($1::int[])) LIMIT 1`, [parents])).rows.length;
    const partner = await userPartner(env);
    const tokens = providers > 0 ? 0 : (await env.sudo().cr.query(
      "SELECT 1 FROM payment_token t JOIN res_partner p ON p.id = t.partner_id WHERE t.active AND p.commercial_partner_id = (SELECT commercial_partner_id FROM res_partner WHERE id = $1) LIMIT 1", [partner])).rows.length;
    if (providers > 0 || tokens > 0) {
      if (!visible.includes(payEntry)) visible.push(payEntry);
    } else {
      drop(payEntry);
    }
  }
  // portal_discuss/models/portal_entry.py:9-23: the discuss card when the user's partner is a member of a channel
  const discussEntry = await installed(env, "portal_discuss") ? await xmlidRes(env, "portal_discuss", "portal_entry_discuss") : null;
  if (discussEntry !== null && recs.ids.includes(discussEntry)) {
    const partner = await userPartner(env);
    const member = await env.model("discuss.channel.member").searchCount(parseDomain([["partner_id", "=", partner]]), 1);
    if (member) { if (!visible.includes(discussEntry)) visible.push(discussEntry); } else drop(discussEntry);
  }
  // in recordset order (`visible_entries |= discuss_entry` appends)
  return recs.browse(visible);
});

// mail discuss_channel_member.py:207-225 `_compute_sql_is_unread`, for portal_discuss's `discuss_count` domain
registerHooks("discuss.channel.member", {
  computeSql: {
    is_unread: async (table) => {
      const subtype = await xmlidRes(table.env, "mail", "mt_important_notification");
      return sql`EXISTS (
        SELECT 1 FROM mail_message
         WHERE mail_message.model = 'discuss.channel' AND mail_message.res_id = ${await table.field("channel_id")}
           AND mail_message.message_type != 'user_notification'
           AND (mail_message.message_type != 'notification' OR mail_message.subtype_id = ${subtype ?? false})
           AND mail_message.id >= ${await table.field("new_message_separator")})`;
    },
  },
});

// ------------------------------------------------------------------------------------------------------------------
// portal/controllers/portal.py:155-233 layout values, counters, home
// ------------------------------------------------------------------------------------------------------------------

/** portal/controllers/portal.py:155-191 `_prepare_portal_layout_values`. */
async function portalLayoutValues(env: Environment): Promise<Record<string, unknown>> {
  const su = env.sudo();
  const partner = await userPartner(env);
  const salesman = async (pid: number): Promise<number | null> =>
    (await su.cr.query<{ user_id: number | null }>("SELECT user_id FROM res_partner WHERE id = $1", [pid])).rows[0]?.user_id ?? null;
  let sales = await salesman(partner);
  if (!(sales && !await isPublicUser(env, sales))) {
    sales = await salesman(await commercialPartner(env, partner));
    if (sales && await isPublicUser(env, sales)) sales = null;
  }
  const Entry = env.model("portal.entry");
  // `_read_group([('show_in_portal', '=', True)], ['category'], ['id:recordset'])`: by category, ids in id order
  const shown = await Entry.search(parseDomain([["show_in_portal", "=", true]]));
  const cats = new Map<string | false, number[]>();
  const rows = shown.length ? (await su.cr.query<{ id: number; category: string | null }>("SELECT id, category FROM portal_entry WHERE id = ANY($1::int[]) ORDER BY category NULLS LAST, id", [shown])).rows : [];
  for (const r of rows) {
    const k = r.category ?? false;
    cats.set(k, [...(cats.get(k) ?? []), r.id]);
  }
  const entries = new Map<string | false, PyRecords>([...cats].map(([k, ids]) => [k, new PyRecords(env, "portal.entry", ids)]));
  const cardIds = [...cats].filter(([k]) => k !== "alert").flatMap(([, ids]) => ids);
  const cards = cardIds.length ? await Entry.search(parseDomain([["id", "in", cardIds]])) : []; // `.sorted()`: by _order
  const hidden = await Entry.search(parseDomain([["category", "!=", "alert"], ["show_in_portal", "=", false]]));
  return {
    sales_user: new PyRecords(su, "res.users", sales ? [sales] : []),
    page_name: "home",
    portal_entries: entries,
    portal_cards: new PyRecords(env, "portal.entry", cards),
    portal_hidden_cards: new PyRecords(env, "portal.entry", hidden),
  };
}

type CounterSpec = [model: string, domain: DomainList, access: "read" | "sudo"] | null;

/** The `_prepare_portal_counter_values` overrides of the installed modules this port knows. */
async function counterValues(env: Environment, counter: string): Promise<CounterSpec> {
  const partner = await userPartner(env);
  switch (counter) {
    // sale/controllers/portal.py:16-34
    case "quotation_count":
    case "order_count":
      if (!await installed(env, "sale")) return null;
      return ["sale.order", [["partner_id", "child_of", [await commercialPartner(env, partner)]], ["state", "=", counter === "quotation_count" ? "sent" : "sale"]], "read"];
    // account/controllers/portal.py:19-26
    case "overdue_invoice_count":
      if (!await installed(env, "account")) return null;
      return ["account.move", await overdueInvoicesDomain(env), "read"];
    case "invoice_count":
      if (!await installed(env, "account")) return null;
      return ["account.move", invoicesDomain("out"), "read"];
    case "bill_count":
      if (!await installed(env, "account")) return null;
      return ["account.move", invoicesDomain("in"), "read"];
    // project/controllers/portal.py:19-24
    case "project_count":
      if (!await installed(env, "project")) return null;
      return ["project.project", [], "read"];
    case "task_count":
      if (!await installed(env, "project")) return null;
      return ["project.task", [["project_id", "!=", false]], "read"];
    // purchase/controllers/portal.py:18-23
    case "rfq_count":
      if (!await installed(env, "purchase")) return null;
      return ["purchase.order", [["state", "in", ["sent"]]], "read"];
    case "purchase_count":
      if (!await installed(env, "purchase")) return null;
      return ["purchase.order", [["state", "in", ["purchase", "cancel"]]], "read"];
    // portal_discuss/controllers/portal.py:10-17
    case "discuss_count":
      if (!await installed(env, "portal_discuss")) return null;
      return ["discuss.channel.member", [["partner_id", "=", partner], ["is_unread", "=", true]], "read"];
    default:
  }
  // the counters of modules this port does not have
  const others: Record<string, string> = {
    event_registration_count: "event", timesheet_count: "hr_timesheet", slide_channel_count: "website_slides",
    production_count: "mrp_subcontracting", lead_count: "website_crm_partner_assign", opp_count: "website_crm_partner_assign",
  };
  const mod = others[counter];
  if (mod !== undefined && await installed(env, mod)) throw new NotPorted(`the portal counter ${counter} of ${mod}`);
  return null;
}

/** account/controllers/portal.py:41-46 `_get_invoices_domain`. */
function invoicesDomain(mType: "in" | "out" | null = null): DomainList {
  const types = mType ? ["_invoice", "_refund", "_receipt"].map((m) => mType + m) : ["out_invoice", "out_refund", "in_invoice", "in_refund", "out_receipt", "in_receipt"];
  return [["state", "not in", ["cancel", "draft"]], ["move_type", "in", types]];
}

/** account/controllers/portal.py:48-55 `_get_overdue_invoices_domain`. */
async function overdueInvoicesDomain(env: Environment, partnerId: number | null = null): Promise<DomainList> {
  const today = todayInTz(await dbNow(env), await envTz(env));
  return [
    ["state", "not in", ["cancel", "draft"]],
    ["move_type", "in", ["out_invoice", "out_receipt"]],
    ["payment_state", "not in", ["in_payment", "paid", "reversed", "blocked", "invoicing_legacy"]],
    ["invoice_date_due", "<", today],
    ["partner_id", "=", partnerId || await userPartner(env)],
  ];
}

/** portal/controllers/portal.py:203-227 `counters`. */
async function counters(ctx: RequestContext, env: Environment, asked: Readonly<Record<string, unknown>>): Promise<Record<string, number>> {
  const res: Record<string, number> = {};
  for (const [counter, category] of Object.entries(asked)) {
    const spec = await counterValues(env, counter);
    let count = 0;
    if (spec) {
      const [model, domain, access] = spec;
      const menv = env.su || access === "sudo" ? env.sudo() : env;
      if (access === "sudo" || await hasAccess(menv, model)) {
        const precise = counter === "discuss_count" || category === "alert";
        count = await menv.model(model).searchCount(parseDomain(domain), precise ? null : 1);
      }
    }
    res[counter] = count;
  }
  // the counters cached as booleans in the session
  const prev = ctx.session["portal_counters"] as Record<string, boolean> | undefined | null;
  const cache: Record<string, boolean> = { ...(prev ?? {}) };
  for (const [k, v] of Object.entries(res)) if (k.endsWith("_count")) cache[k] = Boolean(v);
  if (!sameDict(cache, prev)) ctx.session["portal_counters"] = cache;
  return res;
}

function sameDict(a: Record<string, unknown>, b: Record<string, unknown> | undefined | null): boolean {
  if (b === undefined || b === null || typeof b !== "object") return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => k in b && a[k] === b[k]);
}

jsonRoute("/my/counters", async (ctx) => {
  const p = ctx.jsonParams ?? {};
  if (!("counters" in p)) throw new NotPorted("/my/counters without counters");
  const asked = p["counters"];
  if (asked === null || typeof asked !== "object" || Array.isArray(asked)) throw new NotPorted("/my/counters with counters other than a dict");
  const env = await ctx.orm();
  frontendLangCookie(ctx, env);
  return counters(ctx, env, asked as Record<string, unknown>);
}, { auth: "user", readonly: true });

function html(body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", ...extra } });
}

route(["/my", "/my/home"], async (ctx: RequestContext) => {
  const env = await ctx.orm();
  frontendLangCookie(ctx, env);
  const values = await portalLayoutValues(env);
  Object.assign(values, await counters(ctx, env, {}));
  return html(await renderPage(ctx, "portal.portal_my_home", values, env));
}, { auth: "user" });


// ------------------------------------------------------------------------------------------------------------------
// shared by the list pages
// ------------------------------------------------------------------------------------------------------------------

const ITEMS_PER_PAGE = 80; // portal/controllers/portal.py:153 `_items_per_page`

/** The route's `page` (the path's int, else the query's string as Python gets it, default 1). */
function pageArg(ctx: RequestContext, params: Record<string, string>): number | string {
  if (params["page"] !== undefined) return Number(params["page"]);
  return ctx.url.searchParams.get("page") ?? 1;
}

/** A query parameter as the route's keyword argument: None when absent. */
function arg(ctx: RequestContext, name: string): string | null {
  return ctx.url.searchParams.get(name);
}

/** The `date_begin` / `date_end` filter of the list routes. */
function dateDomain(dateBegin: string | null, dateEnd: string | null): DomainList {
  return dateBegin && dateEnd ? [["create_date", ">", dateBegin], ["create_date", "<=", dateEnd]] : [];
}

/** Parse a portal `page` route/query value into a positive integer (defaults to 1). */
export function parsePortalPage(raw: number | string | null | undefined): number {
  if (typeof raw === "number") return Number.isInteger(raw) && raw > 0 ? raw : 1;
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    return n > 0 ? n : 1;
  }
  return 1;
}

/** Group consecutive items by key, preserving original order. */
export function groupConsecutiveBy<T, K>(items: readonly T[], keyOf: (item: T) => K): T[][] {
  const out: T[][] = [];
  let last: K | undefined;
  for (const item of items) {
    const k = keyOf(item);
    if (out.length && k === last) out[out.length - 1]!.push(item);
    else out.push([item]);
    last = k;
  }
  return out;
}

/** Allow only same-origin relative redirect paths (blocks protocol-relative `//`, backslashes, and CRLF). */
export function safeLocalRedirect(raw: string | null | undefined, fallback = "/my"): string {
  if (!raw) return fallback;
  const s = raw.trim();
  if (!s.startsWith("/") || s.startsWith("//") || s.includes("\\") || /[\r\n]/.test(s)) return fallback;
  return s;
}

/** `searchbar_sortings[sortby]` with fallback to the first entry on an unknown key. */
export function sorting<T>(sortings: Readonly<Record<string, T>>, key: string): T {
  const s = Object.prototype.hasOwnProperty.call(sortings, key) ? sortings[key] : undefined;
  if (s !== undefined) return s;
  const first = Object.values(sortings)[0];
  if (first === undefined) throw new NotPorted(`a portal list sorted by an unknown key ${key} (KeyError)`);
  return first;
}

/** `request.session[key] = ids[:100]`: the history the document pages' record pager reads. */
function setHistory(ctx: RequestContext, key: string, ids: readonly number[]): void {
  ctx.session[key] = ids.slice(0, 100);
}

const _ = (env: Environment, s: string, module: string): string => translate(env, s, module);

// ------------------------------------------------------------------------------------------------------------------
// sale/controllers/portal.py:36-118 /my/quotes, /my/orders
// ------------------------------------------------------------------------------------------------------------------

async function salePortalValues(ctx: RequestContext, env: Environment, params: Record<string, string>, quotationPage: boolean): Promise<Record<string, unknown>> {
  const sortby = arg(ctx, "sortby") || "date";
  const dateBegin = arg(ctx, "date_begin"), dateEnd = arg(ctx, "date_end");
  const partner = await userPartner(env);
  const values = await portalLayoutValues(env);
  const url = quotationPage ? "/my/quotes" : "/my/orders";
  const domain: DomainList = [["partner_id", "child_of", [await commercialPartner(env, partner)]], ["state", "=", quotationPage ? "sent" : "sale"]];
  const sortings = { date: { label: _(env, "Order Date", "sale"), order: "date_order desc" } };
  const sortOrder = sorting(sortings, sortby).order;
  domain.push(...dateDomain(dateBegin, dateEnd));
  const urlArgs: Record<string, unknown> = { date_begin: dateBegin, date_end: dateEnd };
  const Sale = env.model("sale.order");
  const access = await hasAccess(env, "sale.order");
  const pager = portalPager(url, access ? await Sale.searchCount(parseDomain(domain)) : 0, pageArg(ctx, params), ITEMS_PER_PAGE, urlArgs);
  const ids = access ? await Sale.search(parseDomain(domain), { order: sortOrder, limit: ITEMS_PER_PAGE, offset: pager.get("offset") as number }) : [];
  const empty = new PyRecords(env, "sale.order", []);
  const orders = new PyRecords(env.sudo(), "sale.order", ids);
  Object.assign(values, {
    date: dateBegin, quotations: quotationPage ? orders : empty, orders: quotationPage ? empty : orders,
    page_name: quotationPage ? "quote" : "order", pager, default_url: url,
  });
  return values;
}

route(["/my/quotes", "/my/quotes/page/<int:page>"], async (ctx: RequestContext, params) => {
  const env = await ctx.orm();
  frontendLangCookie(ctx, env);
  const values = await salePortalValues(ctx, env, params, true);
  setHistory(ctx, "my_quotations_history", (values["quotations"] as PyRecords).ids);
  return html(await withPortalTokenBatch(env, () => renderPage(ctx, "sale.portal_my_quotations", values, env)));
}, { auth: "user" });

route(["/my/orders", "/my/orders/page/<int:page>"], async (ctx: RequestContext, params) => {
  const env = await ctx.orm();
  frontendLangCookie(ctx, env);
  const values = await salePortalValues(ctx, env, params, false);
  setHistory(ctx, "my_orders_history", (values["orders"] as PyRecords).ids);
  return html(await withPortalTokenBatch(env, () => renderPage(ctx, "sale.portal_my_orders", values, env)));
}, { auth: "user" });

// ------------------------------------------------------------------------------------------------------------------
// account/controllers/portal.py:57-143 /my/invoices
// ------------------------------------------------------------------------------------------------------------------

route(["/my/invoices", "/my/invoices/page/<int:page>"], async (ctx: RequestContext, params) => {
  const env = await ctx.orm();
  frontendLangCookie(ctx, env);
  const sortby = arg(ctx, "sortby") || "date";
  const filterby = arg(ctx, "filterby") || "all";
  const dateBegin = arg(ctx, "date_begin"), dateEnd = arg(ctx, "date_end");
  const values = await portalLayoutValues(env);
  const sortings = {
    date: { label: _(env, "Date", "account"), order: "invoice_date desc" },
    duedate: { label: _(env, "Due Date", "account"), order: "invoice_date_due desc" },
    name: { label: _(env, "Reference", "account"), order: "name desc" },
    state: { label: _(env, "Status", "account"), order: "payment_state" },
  };
  const order = sorting(sortings, sortby).order;
  const filters: Record<string, { label: string; domain: DomainList }> = {
    all: { label: _(env, "All", "account"), domain: [] },
    overdue_invoices: { label: _(env, "Overdue invoices", "account"), domain: await overdueInvoicesDomain(env) },
    invoices: { label: _(env, "Invoices", "account"), domain: [["move_type", "in", ["out_invoice", "out_refund", "out_receipt"]]] },
    bills: { label: _(env, "Bills", "account"), domain: [["move_type", "in", ["in_invoice", "in_refund", "in_receipt"]]] },
  };
  const filter = sorting(filters, filterby);
  const domain: DomainList = [...invoicesDomain(), ...filter.domain, ...dateDomain(dateBegin, dateEnd)];
  const Move = env.model("account.move");
  const access = await hasAccess(env, "account.move");
  const url = "/my/invoices";
  const pager = portalPager(url, access ? await Move.searchCount(parseDomain(domain)) : 0, pageArg(ctx, params), ITEMS_PER_PAGE,
    { date_begin: dateBegin, date_end: dateEnd, sortby, filterby });
  let invoices: unknown;
  let history: number[] = [];
  if (access) {
    const ids = await Move.search(parseDomain(domain), { order, limit: ITEMS_PER_PAGE, offset: pager.get("offset") as number });
    const { nextPaymentValues } = await import("./portal_invoice");
    const list: Map<string, unknown>[] = [];
    for (const id of ids) {
      const inv = new PyRecords(env, "account.move", [id]);
      // account_move.py:7450-7456 `_get_invoice_portal_extra_values`
      list.push(new Map(Object.entries({ invoice: inv, currency: await inv.field("currency_id"), ...await nextPaymentValues(inv) })));
    }
    invoices = list;
    history = ids;
  } else {
    invoices = new PyRecords(env, "account.move", []);
  }
  setHistory(ctx, "my_invoices_history", history);
  Object.assign(values, {
    date: dateBegin, invoices, page_name: "invoice", pager, default_url: url,
    searchbar_sortings: dictOf(sortings), sortby,
    searchbar_filters: dictOf(Object.fromEntries(Object.entries(filters).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))),
    filterby,
    overdue_invoice_count: access ? await Move.searchCount(parseDomain(await overdueInvoicesDomain(env))) : 0,
  });
  return html(await withPortalTokenBatch(env, () => renderPage(ctx, "account.portal_my_invoices", values, env)));
}, { auth: "user" });

// ------------------------------------------------------------------------------------------------------------------
// project/controllers/portal.py:56-114 /my/projects
// ------------------------------------------------------------------------------------------------------------------

route(["/my/projects", "/my/projects/page/<int:page>"], async (ctx: RequestContext, params) => {
  const env = await ctx.orm();
  frontendLangCookie(ctx, env);
  const values = await portalLayoutValues(env);
  const Project = env.model("project.project");
  const domain: DomainList = [["is_template", "=", false]];
  const inputs = { name: { input: "name", label: _(env, "Search Project", "project") } };
  const sortings = {
    date: { label: _(env, "Newest", "project"), order: "create_date desc" },
    name: { label: _(env, "Name", "project"), order: "name" },
  };
  const sortby = arg(ctx, "sortby") || "name";
  const order = sorting(sortings, sortby).order;
  const dateBegin = arg(ctx, "date_begin"), dateEnd = arg(ctx, "date_end");
  domain.push(...dateDomain(dateBegin, dateEnd));
  let search = arg(ctx, "search");
  if (search) {
    search = search.trim();
    domain.push(["name", "ilike", search]);
  }
  const count = await Project.searchCount(parseDomain(domain));
  const pager = portalPager("/my/projects", count, pageArg(ctx, params), ITEMS_PER_PAGE, { date_begin: dateBegin, date_end: dateEnd, sortby, search });
  const ids = await Project.search(parseDomain(domain), { order, limit: ITEMS_PER_PAGE, offset: pager.get("offset") as number });
  setHistory(ctx, "my_projects_history", ids);
  Object.assign(values, {
    date: dateBegin, date_end: dateEnd, projects: new PyRecords(env, "project.project", ids), page_name: "project",
    default_url: "/my/projects", pager, searchbar_sortings: dictOf(sortings), search, searchbar_inputs: dictOf(inputs),
    search_in: "name", sortby,
  });
  return html(await renderPage(ctx, "project.portal_my_projects", values, env));
}, { auth: "user" });

// ------------------------------------------------------------------------------------------------------------------
// project/controllers/portal.py:315-575 /my/tasks (with sale_project/controllers/portal.py:13-62)
// ------------------------------------------------------------------------------------------------------------------

type Entry = Record<string, unknown> & { sequence: number };

function bySequence(o: Record<string, Entry>): Record<string, Entry> {
  return Object.fromEntries(Object.entries(o).sort(([, a], [, b]) => a.sequence - b.sequence));
}

/** fields.Selection `_description_selection(env)`: the field's selection in the request's language. */
async function selectionLabels(env: Environment, model: string, field: string): Promise<Map<string, string>> {
  const got = await env.model(model).fieldsGet([field], ["selection"]);
  const sel = (got[field]?.["selection"] ?? []) as [string, string][];
  return new Map(sel.map(([k, v]) => [k, v]));
}

route(["/my/tasks", "/my/tasks/page/<int:page>"], async (ctx: RequestContext, params) => {
  const env = await ctx.orm();
  frontendLangCookie(ctx, env);
  const su = env.sudo();
  const page = parsePortalPage(pageArg(ctx, params));
  const dateBegin = arg(ctx, "date_begin"), dateEnd = arg(ctx, "date_end");
  let sortby = arg(ctx, "sortby");
  let groupby = arg(ctx, "groupby");
  const search = arg(ctx, "search");
  let searchIn: string | null = ctx.url.searchParams.has("search_in") ? arg(ctx, "search_in") : "name";
  const filterby = arg(ctx, "filterby") || "all";

  // :527-548 `_get_my_tasks_searchbar_filters([('is_template', '=', False)])`
  // a Map: Python's dict order (a JS object would put the project ids before 'all')
  const filters = new Map<string, Record<string, unknown>>([
    ["all", { label: _(env, "All", "project"), domain: [["project_id", "!=", false], ["is_template", "=", false]] }],
  ]);
  const projects = await env.model("project.project").search(parseDomain([["is_template", "=", false]]), { order: "id" });
  const projectNames = projects.length ? await env.model("project.project").read(projects, ["name"]) : [];
  for (const p of projectNames) filters.set(String(p["id"]), { label: p["name"], domain: [["project_id", "=", p["id"]]] });
  const otherTasks = await env.model("project.task").search(parseDomain([["project_id", "not in", projects], ["is_template", "=", false], ["project_id", "!=", false]]));
  if (otherTasks.length) {
    const pids = [...new Set((await su.cr.query<{ project_id: number }>("SELECT DISTINCT project_id FROM project_task WHERE id = ANY($1::int[])", [otherTasks])).rows.map((r) => r.project_id))];
    // `_read_group(..., ['project_id'])` without an order: by the group's value, the project's id (models.py:2212-2216)
    const ordered = [...pids].sort((a, b) => a - b);
    const names = await su.model("project.project").displayName(ordered);
    for (const pid of ordered) filters.set(String(pid), { label: names.get(pid), domain: [["project_id", "=", pid]] });
  }
  const filterDomain = (filters.get(filterby) ?? filters.get("all")!)["domain"] as DomainList;

  // :421-525 `_prepare_tasks_values`
  const values = await portalLayoutValues(env);
  const Task = env.model("project.task");
  let domain: DomainList = [...filterDomain, ["has_template_ancestor", "=", false]];
  // `domain &= Task._access_domain('read')`, then searched as superuser: the user's own search
  if (!await hasAccess(env, "project.task")) throw new NotPorted("/my/tasks without read access to tasks");
  const milestonesAllowed = (await Task.searchCount(parseDomain([...domain, ["allow_milestones", "=", true], ["milestone_id", "!=", false]]), 80)) > 0;
  const sortings: Record<string, Entry> = {
    "id desc": { label: _(env, "Newest", "project"), order: "id desc", sequence: 10 },
    name: { label: _(env, "Title", "project"), order: "name", sequence: 20 },
    "stage_id, project_id": { label: _(env, "Stage", "project"), order: "stage_id, project_id.id", sequence: 50 },
    state: { label: _(env, "Status", "project"), order: "state", sequence: 60 },
    "priority desc": { label: _(env, "Priority", "project"), order: "priority desc", sequence: 80 },
    "date_deadline asc": { label: _(env, "Deadline", "project"), order: "date_deadline asc", sequence: 90 },
    "date_last_stage_update desc": { label: _(env, "Last Stage Update", "project"), order: "date_last_stage_update desc", sequence: 110 },
    "project_id, stage_id": { label: _(env, "Project", "project"), order: "project_id.id, stage_id", sequence: 30 },
  };
  if (milestonesAllowed) sortings["milestone_id"] = { label: _(env, "Milestone", "project"), order: "milestone_id", sequence: 70 };
  const searchbarSortings = bySequence(sortings);
  const nolabel = (s: string): unknown => {
    const t = _(env, s, "project");
    return new Markup(String(escapeHtml(t)).replace("%(left)s", '<span class="nolabel">').replace("%(right)s", "</span>"));
  };
  const inputs: Record<string, Entry> = {
    name: { input: "name", label: nolabel("Search%(left)s Tasks%(right)s"), sequence: 10 },
    user_ids: { input: "user_ids", label: _(env, "Search in Assignees", "project"), sequence: 20 },
    stage_id: { input: "stage_id", label: _(env, "Search in Stages", "project"), sequence: 30 },
    status: { input: "status", label: _(env, "Search in Status", "project"), sequence: 40 },
    priority: { input: "priority", label: _(env, "Search in Priority", "project"), sequence: 60 },
    partner_id: { input: "partner_id", label: _(env, "Search in Customer", "project"), sequence: 80 },
    parent_id: { input: "parent_id", label: _(env, "Search in Parent Task", "project"), sequence: 110 },
    project_id: { input: "project_id", label: _(env, "Search in Project", "project"), sequence: 50 },
  };
  if (milestonesAllowed) inputs["milestone_id"] = { input: "milestone_id", label: _(env, "Search in Milestone", "project"), sequence: 70 };
  const groupings: Record<string, Entry> = {
    none: { label: _(env, "None", "project"), sequence: 10 },
    stage_id: { label: _(env, "Stage", "project"), sequence: 20 },
    state: { label: _(env, "Status", "project"), sequence: 40 },
    priority: { label: _(env, "Priority", "project"), sequence: 60 },
    partner_id: { label: _(env, "Customer", "project"), sequence: 70 },
    parent_id: { label: _(env, "Parent Task", "project"), sequence: 90 },
    project_id: { label: _(env, "Project", "project"), sequence: 30 },
  };
  if (milestonesAllowed) groupings["milestone_id"] = { label: _(env, "Milestone", "project"), sequence: 50 };
  // sale_project: the sales order item, without a project
  if (await installed(env, "sale_project")) {
    groupings["sale_line_id"] = { label: _(env, "Sales Order Item", "sale_project"), sequence: 80 };
    inputs["sale_order"] = { input: "sale_order", label: _(env, "Search in Sales Order Item", "sale_project"), sequence: 90 };
    inputs["invoice"] = { input: "invoice", label: _(env, "Search in Invoice", "sale_project"), sequence: 100 };
  }
  const searchbarInputs = bySequence(inputs);
  const searchbarGroupby = bySequence(groupings);
  if (!sortby || (sortby === "milestone_id" && !milestonesAllowed)) sortby = Object.keys(searchbarSortings)[0]!;
  if (!groupby || !(groupby in searchbarGroupby) || (groupby === "milestone_id" && !milestonesAllowed)) groupby = "project_id";
  domain = [...domain, ...dateDomain(dateBegin, dateEnd)];
  if (!milestonesAllowed && searchIn === "milestone_id") searchIn = "all";
  if (search && searchIn) {
    const q = search.trim();
    if (q) {
      const searchDomains: DomainList[] = [];
      if (["name", "all"].includes(searchIn)) searchDomains.push([["name", "ilike", q]]);
      if (["user_ids", "all"].includes(searchIn)) searchDomains.push([["user_ids", "ilike", q]]);
      if (["stage_id", "all"].includes(searchIn)) searchDomains.push([["stage_id", "ilike", q]]);
      if (["project_id", "all"].includes(searchIn)) searchDomains.push([["project_id", "ilike", q]]);
      if (["partner_id", "all"].includes(searchIn)) searchDomains.push([["partner_id", "ilike", q]]);
      if (["parent_id", "all"].includes(searchIn)) searchDomains.push([["parent_id", "ilike", q]]);
      if (["milestone_id", "all"].includes(searchIn) && milestonesAllowed) searchDomains.push([["milestone_id", "ilike", q]]);
      if (["status", "all"].includes(searchIn)) {
        const states = await selectionLabels(su, "project.task", "state");
        const matched = [...states].filter(([, lbl]) => lbl.toLowerCase().includes(q.toLowerCase())).map(([k]) => k);
        searchDomains.push([["state", "in", matched]]);
      }
      if (["priority", "all"].includes(searchIn)) {
        const prios = await selectionLabels(su, "project.task", "priority");
        const matched = [...prios].filter(([, lbl]) => lbl.toLowerCase().includes(q.toLowerCase())).map(([k]) => k);
        searchDomains.push([["priority", "in", matched]]);
      }
      if (["sale_order", "all"].includes(searchIn) && await installed(env, "sale_project")) {
        searchDomains.push([["sale_order_id", "ilike", q]]);
      }
      if (["invoice", "all"].includes(searchIn) && await installed(env, "sale_project")) {
        searchDomains.push([["sale_order_id.invoice_ids.name", "ilike", q]]);
      }
      if (searchDomains.length === 1) domain = [...domain, ...searchDomains[0]!];
      else if (searchDomains.length > 1) {
        const combined: DomainList = [];
        for (let i = 0; i < searchDomains.length - 1; i++) combined.push("|");
        for (const d of searchDomains) combined.push(...d);
        domain = [...domain, ...combined];
      }
    }
  }
  const GROUP_SPECS: Readonly<Record<string, { order: string; col: string }>> = {
    project_id: { order: "project_id.id", col: "project_id" },
    stage_id: { order: "stage_id", col: "stage_id" },
    state: { order: "state", col: "state" },
    priority: { order: "priority desc", col: "priority" },
    partner_id: { order: "partner_id", col: "partner_id" },
    parent_id: { order: "parent_id", col: "parent_id" },
    milestone_id: { order: "milestone_id", col: "milestone_id" },
    sale_line_id: { order: "sale_line_id", col: "sale_line_id" },
  };
  const groupSpec = groupby === "none" ? null : (GROUP_SPECS[groupby] ?? null);
  const sortOrder = String(sorting(searchbarSortings, sortby)["order"]);
  const order = groupSpec ? `${groupSpec.order}, ${sortOrder}` : sortOrder;

  const limitParam = (await su.cr.query<{ value: string }>("SELECT value FROM ir_config_parameter WHERE key = 'project.portal_task_page_limit'")).rows[0]?.value;
  if (limitParam !== undefined && !/^-?\d+$/.test(limitParam.trim())) throw new NotPorted("project.portal_task_page_limit that is not an int");
  const pageLimit = limitParam !== undefined ? Number(limitParam.trim()) : 100;
  const countLimit = pageLimit > 0 ? pageLimit * ITEMS_PER_PAGE : 0;
  let hasLimitedCount = false;
  let totalDisplay: number;
  if (pageLimit <= 0 || page >= pageLimit) totalDisplay = await Task.searchCount(parseDomain(domain));
  else {
    const total = await Task.searchCount(parseDomain(domain), countLimit + 1);
    if (total >= countLimit + 1) { totalDisplay = countLimit; hasLimitedCount = true; } else totalDisplay = total;
  }
  const urlArgs: Record<string, unknown> = { date_begin: dateBegin, date_end: dateEnd, sortby, groupby, search_in: searchIn, search, filterby };
  const pager = portalPager("/my/tasks", totalDisplay, page, ITEMS_PER_PAGE, urlArgs);
  if (hasLimitedCount) {
    const pages = pager.get("pages") as Map<string, unknown>[];
    if (pages.length) pages[pages.length - 1]!.set("num", `${String(pager.get("page_count"))}+`);
  }
  // `get_grouped_tasks(pager['offset'])`
  const ids = await Task.search(parseDomain(domain), { order, limit: ITEMS_PER_PAGE, offset: pager.get("offset") as number });
  setHistory(ctx, "my_tasks_history", ids);
  let grouped: number[][];
  if (!groupSpec) grouped = ids.length ? [ids] : [];
  else {
    // `_concat_tasks`: groupbyelem over consecutive tasks of the same group column
    const col = groupSpec.col;
    const keyMap = new Map(
      ids.length
        ? (await su.cr.query<{ id: number; k: unknown }>(`SELECT id, "${col}" AS k FROM project_task WHERE id = ANY($1::int[])`, [ids])).rows.map((r) => [r.id, r.k ?? null])
        : [],
    );
    grouped = groupConsecutiveBy(ids, (id) => keyMap.get(id) ?? null);
  }
  if (sortby === "state" && ids.length) {
    const states = await selectionLabels(su, "project.task", "state");
    const stateOf = new Map((await su.cr.query<{ id: number; state: string }>("SELECT id, state FROM project_task WHERE id = ANY($1::int[])", [ids])).rows.map((r) => [r.id, r.state]));
    const label = (id: number): string => states.get(stateOf.get(id) ?? "") ?? "";
    const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    if (groupby === "none" && grouped.length) grouped[0] = [...grouped[0]!].sort((a, b) => cmp(label(a), label(b)));
    else grouped.sort((a, b) => cmp(label(a[0]!), label(b[0]!)));
  }
  const priorities = await selectionLabels(su, "project.task", "priority");
  Object.assign(values, {
    date: dateBegin, date_end: dateEnd,
    grouped_tasks: grouped.map((g) => new PyRecords(su, "project.task", g)),
    allow_milestone: milestonesAllowed, multiple_projects: true, priority_labels: priorities,
    page_name: "task", default_url: "/my/tasks", task_url: "tasks", pager, has_limited_count: hasLimitedCount,
    searchbar_sortings: dictOf(searchbarSortings), searchbar_groupby: dictOf(searchbarGroupby), searchbar_inputs: dictOf(searchbarInputs),
    search_in: searchIn, search, sortby, groupby, show_project: true,
    searchbar_filters: new Map([...filters].map(([k, v]) => [k, new Map(Object.entries(v))])), filterby,
  });
  return html(await renderPage(ctx, "project.portal_my_tasks", values, env));
}, { auth: "user" });

// ------------------------------------------------------------------------------------------------------------------
// portal/controllers/portal.py:235-263, 372-478 /my/account (with account/controllers/portal.py:227-270 and
// account_peppol/controllers/portal.py:16-31)
// ------------------------------------------------------------------------------------------------------------------

interface CountryRow {
  id: number; code: string | null; address_format: string | null; zip_applicability: string | null; state_required: boolean | null;
  enforce_cities: boolean | null; vat_label: string | null; phone_code: number | null;
}

async function countryRow(env: Environment, id: number | null): Promise<CountryRow | null> {
  if (!id) return null;
  return (await env.sudo().cr.query<CountryRow>(
    `SELECT id, code, address_format, zip_applicability, state_required, enforce_cities, phone_code,
            COALESCE(vat_label->>$2, vat_label->>'en_US') AS vat_label
       FROM res_country WHERE id = $1`, [id, env.lang ?? "en_US"])).rows[0] ?? null;
}

/** portal res_country.py:83-95 `_enforce_city_choice`. */
async function enforceCityChoice(env: Environment, c: CountryRow | null): Promise<boolean> {
  if (!c) return false;
  if (!["BR", "CL", "PE", "CO", "TW"].includes(c.code ?? "")) return false;
  if (!c.enforce_cities) return false;
  return (await env.model("res.city").searchCount(parseDomain([["country_id", "=", c.id]]), 1)) > 0;
}

/** portal res_country.py:10-20 `_is_zip_before_city` with :22-46 `_get_address_fields`. */
async function zipBeforeCity(env: Environment, c: CountryRow | null): Promise<boolean> {
  if (!c || c.zip_applicability === "not_applicable") return false;
  const enforce = await enforceCityChoice(env, c);
  const fields = [...String(c.address_format ?? "").matchAll(/\((.+?)\)/g)].map((m) => m[1]!);
  const hasStates = (await env.sudo().cr.query("SELECT 1 FROM res_country_state WHERE country_id = $1 LIMIT 1", [c.id])).rows.length > 0;
  if (!fields.includes("state_name") && !fields.includes("state_code") && hasStates) fields.push("state_id");
  if (c.zip_applicability === "not_applicable") fields.splice(fields.indexOf("zip"), 1);
  const mapping: Record<string, string> = { state_name: "state_id", state_code: "state_id", country_name: "country_id", ...(enforce ? { city: "city_id" } : {}) };
  const mapped = fields.map((f) => mapping[f] ?? f);
  if (!mapped.length || !mapped.includes("zip")) return false;
  const cityField = enforce ? "city_id" : "city";
  const ci = mapped.indexOf(cityField);
  if (ci < 0) throw new NotPorted("_is_zip_before_city of an address format without the city (ValueError)");
  return mapped.indexOf("zip") < ci;
}

/**
 * portal res_partner.py:96-155 `_get_required_address_fields('billing', country, use_delivery_as_billing=True)`: a
 * Python set, joined by the template in CPython's iteration order (PyStrSet).
 */
async function requiredAddressFields(env: Environment, c: CountryRow | null): Promise<PyStrSet> {
  const mandatory = async (): Promise<PyStrSet> => {
    const base = PyStrSet.of("name", "email");
    base.add("phone");
    const address = PyStrSet.of("street", await enforceCityChoice(env, c) ? "city_id" : "city", "country_id");
    if (c?.state_required) address.add("state_id");
    if (c?.zip_applicability === "required") address.add("zip");
    return new PyStrSet().update(base).update(address); // `base_fields | ...`: set_copy then set_update
  };
  const required = new PyStrSet();
  required.update(await mandatory()); // delivery
  required.update(await mandatory()); // billing
  return required;
}

route("/my/account", async (ctx: RequestContext) => {
  const env = await ctx.orm();
  frontendLangCookie(ctx, env);
  const su = env.sudo();
  const redirect = safeLocalRedirect(arg(ctx, "redirect"), "/my");
  const values = await portalLayoutValues(env);
  // `_prepare_address_form_values(partner_sudo=request.env.user.partner_id, use_delivery_as_billing=True, callback=redirect)`
  const partnerId = await userPartner(env);
  const partner = new PyRecords(env, "res.partner", [partnerId]);
  const currentPartner = await isPublicUser(env, env.uid) ? new PyRecords(env, "res.partner", []) : partner;
  const commercialId = await commercialPartner(env, partnerId);
  const p = (await su.cr.query<{ country_id: number | null; state_id: number | null; city_id: number | null; parent_id: number | null; vat: string | null }>(
    "SELECT country_id, state_id, city_id, parent_id, vat FROM res_partner WHERE id = $1", [partnerId])).rows[0]!;
  const childOf = [["partner_id", "child_of", commercialId]];
  // sale res_partner.py:69-91 and account partner.py:786-812: `_has_order`, `_has_invoice`
  const hasOrder = async (d: DomainList) => (await su.model("sale.order").search(parseDomain([...d, ["state", "in", ["sent", "sale"]]]), { limit: 1 })).length > 0;
  const accountOn = await installed(env, "account");
  const hasInvoice = async (d: DomainList) => accountOn && (await su.model("account.move").search(parseDomain([...d, ["move_type", "in", ["out_invoice", "out_refund"]], ["state", "=", "posted"]]), { limit: 1 })).length > 0;
  const saleOn = await installed(env, "sale");
  const hasConfirmed = (saleOn && await hasOrder(childOf)) || await hasInvoice(childOf);
  // portal res_partner.py:30-43 `_is_main_contact`
  let isMainContact = true;
  if (p.parent_id) {
    const children = (await su.cr.query<{ id: number }>("SELECT id FROM res_partner WHERE parent_id = $1 AND active AND type = 'contact' ORDER BY id", [commercialId])).rows.map((r) => r.id);
    const users = (await su.cr.query("SELECT 1 FROM res_users WHERE partner_id = $1 AND active LIMIT 1", [commercialId])).rows.length > 0;
    isMainContact = children.length === 1 && children[0] === partnerId && !users;
  }
  let commercialFieldsWarning = "", vatWarning = "";
  if (!isMainContact) commercialFieldsWarning = _(env, "The company billing details can only be updated on the company account.", "portal");
  else if (p.vat && hasConfirmed) {
    vatWarning = _(env, "Updating VAT number is not allowed once document(s) have been issued for your account. Please contact us directly for this operation.", "portal");
  }
  const country = await countryRow(env, p.country_id);
  const enforce = await enforceCityChoice(env, country);
  if (enforce) throw new NotPorted("/my/account with a country enforcing its cities (_get_cities_data)");
  const canEditCountry = !p.country_id || (
    !(saleOn && await hasOrder(["|", ["partner_invoice_id", "=", partnerId], ["partner_id", "=", partnerId]]))
    && !await hasInvoice([["partner_id", "=", partnerId]]));
  const canEditCommercial = !hasConfirmed && isMainContact;
  const canEditVat = isMainContact && !(p.vat && hasConfirmed);

  const formErrors: Record<string, string> = {};
  const errorMessages: string[] = [];
  if (ctx.request.method === "POST") {
    const fd = await ctx.request.formData();
    const post = (k: string): string => {
      const v = fd.get(k);
      return typeof v === "string" ? v.trim() : "";
    };
    const postedCountryId = /^\d+$/.test(post("country_id")) ? Number(post("country_id")) : null;
    const effectiveCountry = canEditCountry && postedCountryId ? await countryRow(env, postedCountryId) : country;
    const reqFields = [...await requiredAddressFields(env, effectiveCountry)];
    for (const f of reqFields) {
      if (f === "country_id" && !canEditCountry) continue;
      if (!post(f)) formErrors[f] = "missing";
    }
    const emailVal = post("email");
    if (emailVal && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)) {
      formErrors["email"] = "error";
      errorMessages.push(_(env, "Invalid Email! Please enter a valid email address.", "portal"));
    }
    if (Object.values(formErrors).includes("missing")) {
      errorMessages.push(_(env, "Some required fields are empty.", "portal"));
    }
    let stateId: number | false | undefined;
    const rawState = post("state_id");
    if (fd.has("state_id")) {
      if (!rawState) stateId = false;
      else if (/^\d+$/.test(rawState)) {
        const sid = Number(rawState);
        const ok = effectiveCountry && (await su.cr.query("SELECT 1 FROM res_country_state WHERE id = $1 AND country_id = $2 LIMIT 1", [sid, effectiveCountry.id])).rows.length > 0;
        if (ok) stateId = sid;
        else {
          formErrors["state_id"] = "error";
          errorMessages.push(_(env, "Invalid state for the selected country.", "portal"));
        }
      } else {
        formErrors["state_id"] = "error";
      }
    }
    if (!Object.keys(formErrors).length && !errorMessages.length) {
      const vals: Record<string, unknown> = {};
      for (const f of ["name", "email", "phone", "street", "street2", "city", "zip"]) {
        if (fd.has(f)) vals[f] = post(f) || false;
      }
      if (canEditCountry && fd.has("country_id")) {
        vals["country_id"] = postedCountryId ?? false;
      }
      if (stateId !== undefined) vals["state_id"] = stateId;
      if (canEditCommercial && fd.has("company_name")) vals["company_name"] = post("company_name") || false;
      if (canEditVat && fd.has("vat")) vals["vat"] = post("vat") || false;
      if (Object.keys(vals).length) await write(su, "res.partner", [partnerId], vals);
      return ctx.redirect(safeLocalRedirect(post("redirect") || redirect, "/my"));
    }
  }

  const countryWarning = canEditCountry ? "" : _(env, "Changing country is not allowed once document(s) have been issued for your account. Please contact us directly for this operation.", "portal");
  const countryRec = new PyRecords(su, "res.country", country ? [country.id] : []);
  let vatLabel = country?.vat_label || null;
  if (!vatLabel) {
    const companyCountry = (await su.cr.query<{ country_id: number | null }>("SELECT p.country_id FROM res_company c JOIN res_partner p ON p.id = c.partner_id WHERE c.id = $1", [await env.company()])).rows[0]?.country_id ?? null;
    vatLabel = (await countryRow(env, companyCountry))?.vat_label || _(env, "VAT", "portal");
  }
  const phoneCode = country?.phone_code ?? 0;
  const statesIds = country ? (await su.model("res.country.state").search(parseDomain([["country_id", "=", country.id]]))) : [];
  Object.assign(values, {
    partner_sudo: partner, partner_id: partnerId, current_partner: currentPartner,
    commercial_partner: new PyRecords(env, "res.partner", [commercialId]),
    is_main_address: true, discard_url: redirect || "/my/addresses", address_type: "billing",
    can_edit_commercial_fields: canEditCommercial, commercial_address_update_url: "",
    commercial_fields_warning: commercialFieldsWarning, country_warning: countryWarning, callback: redirect,
    error: new Map(Object.entries(formErrors)), error_message: errorMessages,
    is_used_as_billing: true, required_fields: [...await requiredAddressFields(env, country)], use_delivery_as_billing: true,
    zip_applicability: country?.zip_applicability ?? false, zip_before_city: await zipBeforeCity(env, country),
    vat_warning: vatWarning, vat_label: vatLabel,
    email: await partner.field("email"), phone: await partner.field("phone"),
    phone_code: phoneCode !== 0 ? `+${phoneCode}` : "",
    country: countryRec,
    countries: canEditCountry ? new PyRecords(su, "res.country", await su.model("res.country").search(parseDomain([]))) : countryRec,
    state: new PyRecords(su, "res.country.state", p.state_id ? [p.state_id] : []),
    states: new PyRecords(su, "res.country.state", statesIds),
    city: new PyRecords(su, "res.city", p.city_id ? [p.city_id] : []),
    cities_data: false,
    page_name: "my_details",
  });
  // account: the identifiers of the address form (`_get_portal_additional_identifiers_whitelist` is empty) and the
  // invoice sending options
  const identifiers = await partner.field("additional_identifiers");
  Object.assign(values, {
    additional_identifiers_metadata: new Map(),
    partner_additional_identifiers: identifiers && typeof identifiers === "object" ? identifiers : new Map(),
    invoice_sending_methods: new Map([["email", _(env, "by Email", "account")]]),
    invoice_edi_formats: await selectionLabels(env, "res.partner", "invoice_edi_format"),
  });
  // account_peppol: the Peppol options when the company can send (account_edi_proxy_user.py:167-168)
  if (await installed(env, "account_peppol")) {
    const state = (await su.cr.query<{ s: string | null }>("SELECT account_peppol_proxy_state AS s FROM res_company WHERE id = $1", [await env.company()])).rows[0]?.s;
    if (["sender", "smp_registration", "receiver"].includes(String(state))) throw new NotPorted("/my/account of a company that can send on Peppol");
  }
  return html(await renderPage(ctx, "portal.portal_my_details", values, env), { "X-Frame-Options": "SAMEORIGIN", "Content-Security-Policy": "frame-ancestors 'self'" });
}, { auth: "user" });
