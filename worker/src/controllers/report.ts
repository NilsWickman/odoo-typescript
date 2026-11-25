/**
 * web/controllers/report.py report_routes for the html converter, ir_actions_report.py `_render_qweb_html`,
 * `_get_rendering_context`, `_render_template` and the `report.account.report_invoice*` values
 * (account/report/account_invoice_report.py:157-189). PDF stays outside (no engine: `get_pdf_engine_state` is 'install').
 */
import { HttpError, HttpResponseError, MissingError, NotPorted, UserError } from "../errors";
import type { Env } from "../env";
import { Cursor } from "../db";
import { createEnvironment } from "../orm/env";
import { readFile } from "../filestore";
import { FILESTORE_READER_KEY } from "../models/binary";
import { handleRequest } from "../http/dispatch";
import { Markup } from "../pyexpr/values";
import { splitReportHtml } from "../report/pdf_html";
import type { RequestContext } from "../http/context";
import { requestOfCursor } from "../http/context";
import { jsonRoute, route } from "../http/router";
import { hasGroups } from "../orm/env";
import { loadTemplates, renderCall, renderLoaded, renderTemplate, type TemplateSet } from "../qweb";
import { ensureRegistryLang } from "../orm/registry";
import { pyStr } from "../pyexpr/values";
import type { Scope } from "../pyexpr";
import type { Element } from "../xml";
import { fieldHooks } from "../qweb/fields";
import { PyEnv, PyRecords } from "../qweb/records";
import type { Environment } from "../orm/types";
import { reportHelpers } from "../qweb/helpers";
import { pdfEngineOf } from "../report/engine";
import { serializeException } from "../http/dispatch";
import { pyJsonDumps } from "./translations";
import { contentDispositionAttachment } from "./export_csv";
import { evalExprAsync } from "../pyexpr";
import { translate } from "../models/util";
import { chargeDemoPdf } from "../demo/quota";
import { demoNotPortedFloor } from "../demo/not_ported";
import { AssetInliner, DEMO_PDF_ENGINE_OPTIONS, inlineFontFaces, inlineImages, lockPdfHtml } from "../demo/pdf_lock";

interface Report { id: number; report_name: string; model: string; report_type: string }

/** ir_actions_report.py `_get_report_from_name` with `_get_report`: an action by its report name. */
async function reportByName(env: Environment, name: string): Promise<Report> {
  const r = (await env.cr.query<Report>("SELECT id, report_name, model, report_type FROM ir_act_report_xml WHERE report_name = $1 AND report_type = ANY($2::text[]) ORDER BY id LIMIT 1", [name, ["qweb-html", "qweb-pdf", "qweb-text"]])).rows[0];
  if (r === undefined) throw new HttpError(404, "Not Found");
  return r;
}

/** `_render_template` with the rendering context of `report`. */
export async function renderReportHtml(env: Environment, name: string, docids: readonly number[], data: Record<string, unknown>): Promise<string> {
  const report = await reportByName(env, name);
  const values: Record<string, unknown> = { report_type: "html", ...data };
  if (name === "account.report_invoice" || name === "account.report_invoice_with_payments") {
    // account_invoice_report.py:161-189 (display_qr_code moves need the QR generation, which refuses in `_generate_qr_code`)
    const docs = new PyRecords(env, "account.move", docids);
    for (const doc of docs.pyIter() as PyRecords[]) {
      if (await doc.field("display_qr_code")) throw new NotPorted("invoice report with a QR code (_generate_qr_code)");
    }
    Object.assign(values, { doc_ids: [...docids], doc_model: "account.move", docs, qr_code_urls: new Map() });
    if (name === "account.report_invoice_with_payments") values["report_type"] = data["report_type"] ?? "html";
  } else {
    const hasCustom = (await env.cr.query("SELECT 1 FROM ir_model WHERE model = $1 LIMIT 1", [`report.${name}`])).rows.length > 0;
    if (hasCustom) throw new NotPorted(`report model report.${name} (_get_report_values)`);
    Object.assign(values, { doc_ids: [...docids], doc_model: report.model, docs: new PyRecords(env, report.model, docids) });
  }
  if (report.model) await env.model(report.model).checkAccess(docids, "read");
  if (env.context["proforma_invoice"]) values["proforma"] = true;
  const company = await env.company();
  const base = (await env.cr.query<{ value: string }>("SELECT value FROM ir_config_parameter WHERE key = 'web.base.url'")).rows[0]?.value ?? "";
  Object.assign(values, {
    user: new PyRecords(env, "res.users", [env.uid]), res_company: new PyRecords(env, "res.company", [company]), web_base_url: base,
    company: new PyRecords(env.sudo(), "res.company", [company]), user_id: new PyRecords(env, "res.users", [env.uid]), env: new PyEnv(env), ...reportHelpers(env),
  });
  return renderQweb(env, name, values);
}

/**
 * The callee of a `t-call` with `t-lang` (ir_qweb.py:816-818 `irQweb.with_context(lang=...)`): compiled in that
 * language (the templates' translated terms), rendered with the field converters and `_()` of an environment in it.
 */
function callInLang(env: Environment): (lang: string, template: string | number, values: Scope) => Promise<string> {
  return async (lang, template, values) => {
    await ensureRegistryLang(env.cr, env.reg, lang);
    const e = env.withContext({ ...env.context, lang });
    const sub = (t: string, v: Map<string, unknown>): Promise<string> => renderTemplate(e.cr, t, v, { lang, ...hooks });
    const hooks = fieldHooks(e, sub);
    const load = { lang, debug: pyStr(values.get("debug") ?? "") };
    const templates = await loadTemplates(e.cr, template, load);
    const loadTemplate = async (ref: string | number): Promise<void> => {
      const more = await loadTemplates(e.cr, ref, load);
      for (const [k, v] of more.byRef) templates.byRef.set(k, v);
      for (const [k, v] of more.assets) templates.assets.set(k, v);
    };
    return renderCall(templates, template, values, { lang, ...hooks, loadTemplate, hasGroups: (groups) => hasGroups(e, groups), callInLang: callInLang(e) });
  };
}

/** `ir.ui.view._render_template` for records: the field converters of `env`, `base.contact` included. */
export function renderQweb(env: Environment, template: string, values: Record<string, unknown>, minimalQcontext = false): Promise<string> {
  const lang = env.lang ?? "en_US";
  const sub = (t: string, v: Map<string, unknown>): Promise<string> => renderTemplate(env.cr, t, v, { lang, ...hooks });
  const hooks = fieldHooks(env, sub);
  return renderTemplate(env.cr, template, values, { lang, ...hooks, hasGroups: (groups) => hasGroups(env, groups), callInLang: callInLang(env), minimalQcontext });
}

/** `ir.qweb._render(element, values)`: a template that is not a view (mail.template bodies). */
export function renderQwebTree(env: Environment, tree: Element, values: Scope, opts?: { readonly escapeText?: boolean }): Promise<string> {
  const lang = env.lang ?? "en_US";
  const sub = (t: string, v: Map<string, unknown>): Promise<string> => renderTemplate(env.cr, t, v, { lang, ...hooks });
  const hooks = fieldHooks(env, sub);
  const ref = "mail.render.mixin.source";
  const templates: TemplateSet = { byRef: new Map([[ref, { id: 0, key: null, tree }]]), assets: new Map(), rtl: false };
  const loadTemplate = async (target: string | number): Promise<void> => {
    const more = await loadTemplates(env.cr, target, { lang, debug: "" });
    for (const [k, v] of more.byRef) templates.byRef.set(k, v);
    for (const [k, v] of more.assets) templates.assets.set(k, v);
  };
  return renderLoaded(templates, ref, values, {
    lang, ...hooks, loadTemplate, hasGroups: (groups) => hasGroups(env, groups), callInLang: callInLang(env),
    ...(opts?.escapeText ? { escapeText: true } : {}),
  });
}

const LANG_CODE_RE = /^[a-z]{2,3}(?:_[A-Z0-9]{2,4})?(?:@[a-zA-Z0-9]+)?$/;

/**
 * http_routing ir_http.py:517-520 `_frontend_pre_dispatch` of a `website=True` route: the cookie follows `request.lang`
 * (:405-412 the url, cookie, context or default language).
 */
export function frontendLangCookie(ctx: RequestContext, env: Environment): void {
  const rawLang = env.lang ?? "en_US";
  const lang = LANG_CODE_RE.test(rawLang) ? rawLang : "en_US";
  const cookie = ctx.requestCookies.get("frontend_lang");
  if (cookie === lang) return;
  const expires = new Date(Date.now() + 365 * 24 * 3600 * 1000).toUTCString();
  ctx.cookies.push(`frontend_lang=${lang}; Expires=${expires}; Path=/`);
}

/** The PDF engine: Browser Run where it is bound and deployed; local development (LOCAL_DEV) has none, as the oracle. */
function pdfEngine(ctx: { env: Env; db: string | null }): NonNullable<Env["BROWSER"]> | null {
  return pdfEngineOf(ctx.env, ctx.db);
}

export interface PdfParts { bodies: string[]; resIds: (number | null)[]; header: string; footer: string; headers: string[]; footers: string[]; args: [string, string][] }

/**
 * The html the PDF engine gets (ir_actions_report.py:663-675 `_pre_render_qweb_pdf` with account's override
 * (account/models/ir_actions_report.py:63-74), :447-525 `_render_qweb_pdf_prepare_streams` up to the engine, and
 * base_report_wkhtmltox ir_actions_report.py:156-238 `_prepare_wkhtmltopdf_html`).
 */
export async function reportPdfParts(env0: Environment, name: string, docids: readonly number[]): Promise<PdfParts> {
  const env = env0.withContext({ ...env0.context, debug: false });
  const report = await reportByName(env, name);
  const data: Record<string, unknown> = { report_type: "pdf" };
  const param = async (key: string): Promise<string | null> => (await env.cr.query<{ value: string }>("SELECT value FROM ir_config_parameter WHERE key = $1", [key])).rows[0]?.value ?? null;
  const invoiceReport = (await env.cr.query<{ i: boolean | null }>("SELECT is_invoice_report AS i FROM ir_act_report_xml WHERE id = $1", [report.id])).rows[0]?.i;
  if ((invoiceReport && report.model === "account.move") || name === "account.report_invoice") {
    await env.model("account.move").checkAccess(docids, "read");
    if (await param("account.display_name_in_footer")) data["display_name_in_footer"] = true;
    const types = (await env.cr.query<{ t: string }>("SELECT move_type AS t FROM account_move WHERE id = ANY($1::int[])", [[...docids]])).rows;
    if (types.some((r) => r.t === "entry")) {
      throw new UserError(translate(env, "Only invoices could be printed.", "account"));
    }
  }
  if (report.model && (await env.cr.query("SELECT 1 FROM ir_act_report_xml WHERE id = $1 AND attachment IS NOT NULL AND attachment <> ''", [report.id])).rows.length) {
    throw new NotPorted(`PDF report ${name} saved as attachment (retrieve_attachment, _prepare_pdf_report_attachment_vals_list)`);
  }
  if (new Set(docids).size !== docids.length) throw new NotPorted("PDF report with duplicated ids");
  data["debug"] = false;
  const html = await renderReportHtml(env, name, docids, data);
  const parts = splitReportHtml(html);
  // `_get_report_url`: report.url, else the layout's base url (web.base.url)
  const baseUrl = (await param("report.url")) || (await param("web.base.url")) || "";
  const xmlId = (await env.cr.query<{ x: string }>("SELECT module || '.' || name AS x FROM ir_model_data WHERE model = 'ir.actions.report' AND res_id = $1 ORDER BY id LIMIT 1", [report.id])).rows[0]?.x ?? "";
  const layout = (e: Environment, subst: boolean, body: string): Promise<string> =>
    renderQweb(e, "web.minimal_layout", { subst, body: new Markup(body), base_url: baseUrl, report_xml_id: xmlId, debug: false, env: new PyEnv(e) });
  const bodies: string[] = [];
  const resIds: (number | null)[] = [];
  for (const a of parts.articles) {
    const e = a.lang ? env.withContext({ ...env.context, lang: a.lang }) : env;
    bodies.push(await layout(e, false, a.html));
    resIds.push(a.model === report.model ? Number.parseInt(a.id ?? "0", 10) || 0 : null);
  }
  if (!bodies.length) bodies.push(parts.bodyFallback ?? "");
  return {
    bodies, resIds, header: await layout(env, true, parts.header), footer: await layout(env, true, parts.footer),
    headers: parts.headers, footers: parts.footers, args: parts.args,
  };
}

/**
 * The engine: Browser Run renders the html (D8b: Chromium instead of wkhtmltopdf, so the bytes and the pagination
 * differ; the text is the report's). One document for the records: each body with its own header before and footer
 * after the article (wkhtmltopdf repeats them per page through `subst()`), the stylesheets inlined (the browser
 * cannot reach the site behind Access), a page break between records.
 */
export function isAllowedPdfStylesheetHref(href: string, baseUrl: URL): URL | null {
  let resolved: URL;
  try {
    resolved = new URL(href, baseUrl);
  } catch {
    return null;
  }
  if (resolved.origin !== baseUrl.origin) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(resolved.pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\\") || decoded.includes("\0") || decoded.split("/").some((s) => s === "." || s === "..")) {
    return null;
  }
  if (resolved.pathname.startsWith("/web/assets/")) return resolved;
  if (/^\/[^/]+\/static\//.test(resolved.pathname)) return resolved;
  return null;
}

export function escapeStyleContent(css: string): string {
  return css.replace(/<\/style/gi, "<\\/style");
}

/**
 * `releaseCursor` (the standalone /report/pdf route on the public demo only): the request's read-only transaction is
 * ended before the engine runs, so the connection is not held for the seconds Browser Run takes.
 */
async function renderPdf(
  ctx: { env: Env; db: string | null; url: URL; cookie: string | null },
  parts: PdfParts,
  opts: { readonly releaseCursor?: () => Promise<void> } = {},
): Promise<Uint8Array> {
  const browser = pdfEngine(ctx);
  if (!browser) throw new NotPorted("/report/pdf without a PDF engine");
  const demo = ctx.env.DEMO_MODE === "1";
  // the public demo's quotas (15 per lease, 200 per day), counted by DemoPool before anything is rendered
  if (demo) await chargeDemoPdf(ctx.env);
  const styles: string[] = [];
  const seen = new Set<string>();
  const docs = parts.bodies.map((body, i) => {
    for (const m of body.matchAll(/<link type="text\/css" rel="stylesheet" href="([^"]+)"\/?>/g)) seen.add(m[1]!);
    const inner = /<body[^>]*>([\s\S]*)<\/body>/.exec(body)?.[1] ?? body;
    return `<div style="${i ? "page-break-before: always;" : ""}">${parts.headers[i] ?? ""}${inner}${parts.footers[i] ?? ""}</div>`;
  });
  for (const href of seen) {
    const target = isAllowedPdfStylesheetHref(href, ctx.url);
    if (target === null) continue;
    const headers = new Headers();
    if (ctx.cookie) headers.set("cookie", ctx.cookie);
    const r = await handleRequest(new Request(target, { headers }), ctx.env);
    if (r.status !== 200) throw new NotPorted(`PDF stylesheet ${href} answered ${r.status}`);
    styles.push(await r.text());
  }
  const head = /<head>([\s\S]*?)<\/head>/.exec(parts.bodies[0] ?? "")?.[1]?.replace(/<link[^>]*>/g, "").replace(/<base[^>]*>/g, "") ?? "";
  const bodyTag = /<body[^>]*>/.exec(parts.bodies[0] ?? "")?.[0] ?? "<body>";
  let html = `<!DOCTYPE html><html><head>${head}${styles.map((c) => `<style>${escapeStyleContent(c)}</style>`).join("")}</head>${bodyTag}${docs.join("")}</body></html>`;
  let lock = {};
  if (demo) {
    // src/demo/pdf_lock.ts: the html reaches nothing; its fonts and images come inlined (4 MiB)
    const inliner = new AssetInliner(async (u) => {
      const headers = new Headers();
      if (ctx.cookie) headers.set("cookie", ctx.cookie);
      const r = await handleRequest(new Request(u, { headers }), ctx.env);
      if (r.status !== 200) return null;
      return { contentType: r.headers.get("content-type") ?? "", bytes: new Uint8Array(await r.arrayBuffer()) };
    });
    const lockedStyles: string[] = [];
    for (const c of styles) lockedStyles.push(await inlineFontFaces(c, ctx.url, inliner));
    const lockedDocs = await inlineImages(docs.join(""), ctx.url, inliner);
    html = lockPdfHtml(`<!DOCTYPE html><html><head>${head}${lockedStyles.map((c) => `<style>${escapeStyleContent(c)}</style>`).join("")}</head>${bodyTag}${lockedDocs}</body></html>`);
    lock = DEMO_PDF_ENGINE_OPTIONS;
    if (opts.releaseCursor) await opts.releaseCursor();
  }
  const res = await browser.quickAction("pdf", { html, ...lock, pdfOptions: { format: "a4", printBackground: true, margin: { top: "10mm", bottom: "10mm", left: "7mm", right: "7mm" } } });
  if (!res.ok) throw new NotPorted(`Browser Run pdf answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * `_pre_render_qweb_pdf(report, res_ids)` and the engine for model code (the invoice send wizard,
 * account_move_send.py:745-760): the request's Browser Run binding, url and cookie (stylesheets).
 */
export async function renderReportPdfInRequest(env: Environment, name: string, docids: readonly number[]): Promise<Uint8Array> {
  const ctx = requestOfCursor(env.cr);
  if (ctx === null) throw new NotPorted("PDF rendering outside a request");
  return renderPdf({ env: ctx.env, db: ctx.db, url: ctx.url, cookie: ctx.request.headers.get("cookie") }, await reportPdfParts(env, name, docids));
}

// web/controllers/report.py:23-41: html, and pdf through Browser Run where the binding exists (text is not ported)
route(["/report/<string:converter>/<string:reportname>", "/report/<string:converter>/<string:reportname>/<string:docids>"], async (ctx: RequestContext, params) => {
  const converter = String(params["converter"]);
  if (converter === "pdf") {
    if (!pdfEngine(ctx)) throw new NotPorted("/report/pdf without a PDF engine");
    if (ctx.url.searchParams.get("options") || ctx.url.searchParams.get("context")) throw new NotPorted("/report/pdf with options or context");
    const docids = String(params["docids"] ?? "").split(",").filter((s) => /^\d+$/.test(s)).map(Number);
    const env = await ctx.orm();
    // public demo: the read-only transaction ends before Browser Run (only here, never in renderReportPdfInRequest,
    // whose caller goes on using its cursor)
    const releaseCursor = ctx.env.DEMO_MODE === "1"
      ? async (): Promise<void> => {
        const cr = ctx.cursor();
        await cr.commit();
        await cr.close();
      }
      : undefined;
    const pdf = await renderPdf({ env: ctx.env, db: ctx.db, url: ctx.url, cookie: ctx.request.headers.get("cookie") }, await reportPdfParts(env, String(params["reportname"]), docids), releaseCursor ? { releaseCursor } : {});
    // report.py:37-39
    return new Response(pdf, { status: 200, headers: { "Content-Type": "application/pdf", "Content-Length": String(pdf.length) } });
  }
  if (converter !== "html") throw new NotPorted(`/report/${converter}`);
  const docids = String(params["docids"] ?? "").split(",").filter((s) => /^\d+$/.test(s)).map(Number);
  const q = ctx.url.searchParams;
  if (q.get("options")) throw new NotPorted("/report/html with options");
  let env = await ctx.orm();
  const context = q.get("context");
  if (context) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(context);
    } catch {
      throw new HttpError(400, "Invalid context JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new HttpError(400, "Invalid context JSON");
    }
    env = env.withContext({ ...env.context, ...(parsed as Record<string, unknown>) });
  }
  frontendLangCookie(ctx, env);
  const html = await renderReportHtml(env, String(params["reportname"]), docids, {});
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}, { auth: "user", readonly: true });

/** A Python builtin exception (`builtins.<name>` in serialize_exception, dispatcher.py:78-91). */
function pyError(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

/** markupsafe `escape` (odoo.tools.misc.html_escape). */
function htmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&#34;").replace(/'/g, "&#39;");
}

interface ReportRow { id: number; report_name: string; model: string; report_type: string; attachment: string | null; is_invoice_report: boolean | null }

/** base ir_actions_report.py:291-316 `_get_report(report_ref)` of a report name or an xml id (sudo). */
async function reportRef(env: Environment, ref: string): Promise<ReportRow> {
  const cols = "id, report_name, model, report_type, attachment, is_invoice_report";
  const ids = await env.sudo().model("ir.actions.report").search({ kind: "cond", path: "report_name", op: "=", value: ref }, { limit: 1 });
  const byName = ids.length ? (await env.cr.query<ReportRow>(`SELECT ${cols} FROM ir_act_report_xml WHERE id = $1`, [ids[0]])).rows[0] : undefined;
  if (byName) return byName;
  // `self.env.ref(report_ref)` (ir_model.py `_xmlid_lookup`)
  const dot = ref.indexOf(".");
  if (dot < 0) throw new NotPorted(`report reference without a module (${ref})`);
  const xml = (await env.cr.query<{ model: string; res_id: number }>("SELECT model, res_id FROM ir_model_data WHERE module = $1 AND name = $2", [ref.slice(0, dot), ref.slice(dot + 1)])).rows[0];
  if (!xml) throw pyError("ValueError", `External ID not found in the system: ${ref}`);
  if (xml.model !== "ir.actions.report") throw new NotPorted(`report reference to a ${xml.model} (${ref})`);
  const r = (await env.cr.query<ReportRow>(`SELECT ${cols} FROM ir_act_report_xml WHERE id = $1`, [xml.res_id])).rows[0];
  if (!r) throw new NotPorted(`report reference to a missing record (${ref})`);
  return r;
}

/**
 * `_render_qweb_pdf(reportname, docids)` (base ir_actions_report.py:677-737): account's `_pre_render_qweb_pdf`
 * (account/models/ir_actions_report.py:63-74), base `_pre_render_qweb_pdf` (:663-675) and
 * `_render_qweb_pdf_prepare_streams` (:447-525) up to the engine. Without an engine (locally, as the oracle) it raises
 * Odoo's UserError (:509-517); with Browser Run the html renders as /report/pdf does.
 */
async function renderReportPdf(ctx: RequestContext, env: Environment, name: string, ids: readonly number[]): Promise<Uint8Array> {
  const report = await reportRef(env, name);
  if ((report.is_invoice_report && report.model === "account.move") || report.report_name === "account.report_invoice") {
    // `any(x.move_type == 'entry' for x in invoices)`: the field read checks the access of the current user, then each
    // record in turn: a missing one raises MissingError (models.py `_fetch_field`), an entry ends `any`
    const rows = ids.length ? await env.model("account.move").read([...ids], ["move_type"], "") : [];
    const types = new Map(rows.map((r) => [Number(r["id"]), r["move_type"]]));
    for (const id of ids) {
      if (!types.has(id)) throw new MissingError(`Record does not exist or has been deleted.\n(Record: account.move(${id},), User: ${env.uid})`);
      if (types.get(id) === "entry") throw new UserError(translate(env, "Only invoices could be printed."));
    }
  }
  if (report.report_name === "account.report_original_vendor_bill") throw new NotPorted("the original vendor bill report (account _render_qweb_pdf_prepare_streams)");
  const duplicated = ids.length > 0 && new Set(ids).size !== ids.length;
  if (ids.length && !duplicated && report.attachment && !env.context["report_pdf_no_attachment"]) {
    throw new NotPorted(`PDF report ${report.report_name} saved as attachment (retrieve_attachment)`);
  }
  if (!report.model && ids.length) throw new NotPorted(`PDF report ${report.report_name} without a model`);
  const engine = pdfEngine(ctx);
  // :494-518: `_get_pdf_engine` ('wkhtmltopdf' unless the report type or report.pdf_engine_default names another);
  // every engine of this Odoo answers 'install' without its binary, and `is_pdf_engine_required` holds (no stream)
  if (!engine) throw new UserError(translate(env, "Unable to find the pdf engine on this system. The PDF can not be created."));
  return renderPdf({ env: ctx.env, db: ctx.db, url: ctx.url, cookie: ctx.request.headers.get("cookie") }, await reportPdfParts(env, report.report_name, ids));
}

/**
 * `time.time()` of serialize_exception on the database's clock, as the dispatcher's errors (src/http/dispatch.ts
 * databaseNow): the request's `now()` when its transaction is usable, else the Worker's clock.
 */
async function errorNow(ctx: RequestContext): Promise<number> {
  try {
    const env = await ctx.orm();
    const row = (await env.cr.query<{ t: string | number }>("SELECT EXTRACT(EPOCH FROM now()) AS t")).rows[0];
    return row ? Number(row.t) : Date.now() / 1000;
  } catch (e) {
    if (e instanceof NotPorted) throw e;
    return Date.now() / 1000; // an aborted transaction
  }
}

/** The filename of a downloaded report (report.py:136-145). */
async function downloadFilename(env: Environment, reportname: string, ids: readonly number[] | null, extension: string): Promise<string> {
  // `_get_report_from_name` (ir_actions_report.py): report_name with the user's context, sudo
  const found = await env.sudo().model("ir.actions.report").search({ kind: "cond", path: "report_name", op: "=", value: reportname }, { limit: 1 });
  if (!found.length) throw new NotPorted(`report download filename of ${reportname} (no report of that name: "False.${extension}")`);
  const report = new PyRecords(env.sudo(), "ir.actions.report", found);
  let filename = `${String(await report.field("name"))}.${extension}`;
  if (ids !== null) {
    const expr = await report.field("print_report_name");
    if (typeof expr === "string" && expr && ids.length <= 1) {
      const model = String(await report.field("model"));
      let name: unknown;
      try {
        name = await evalExprAsync(expr, new Map([["object", new PyRecords(env, model, ids)]]));
      } catch (e) {
        if (e instanceof NotPorted || e instanceof UserError || e instanceof HttpError) throw e;
        throw new NotPorted(`print_report_name of ${reportname} (${expr}): ${e instanceof Error ? e.message : String(e)}`);
      }
      if (typeof name !== "string") throw new NotPorted(`print_report_name of ${reportname} that is not a string`);
      filename = `${name}.${extension}`;
    }
  }
  return filename;
}

/**
 * web/controllers/report.py:99-155 `report_download`, the web client's print path (reports/utils.js:79 after
 * `/report/get_pdf_engine_state`): the PDF of a generic report (a url with ids) with its filename. Odoo catches every
 * exception and answers 200 with the html-escaped JSON error the client's `download` shows, rolling the transaction
 * back (`InternalServerError(response=res)`); a refusal of the port is wrapped the same way, so the dialog names it.
 * Text reports and reports with options in the url (no ids) refuse.
 */
route("/report/download", async (ctx: RequestContext) => {
  const raw = ctx.params["data"];
  // :111-112 outside the try: a malformed `data` is an uncaught exception (the generic 500 page)
  if (typeof raw !== "string") throw new Error("report_download() missing 1 required positional argument: 'data'");
  const content = JSON.parse(raw) as unknown;
  if (!Array.isArray(content) || content.length < 2 || typeof content[0] !== "string" || typeof content[1] !== "string") {
    throw new NotPorted("/report/download with data that is not [url, type]");
  }
  const url = content[0];
  let type = content[1];
  if (type.startsWith("qweb-pdf")) type = "qweb-pdf";
  let reportname = "???";
  try {
    if (type === "qweb-pdf" || type === "qweb-text") {
      if (type === "qweb-text") throw new NotPorted("/report/download of a qweb-text report (_render_qweb_text)");
      const parts = url.split("/report/pdf/");
      if (parts.length < 2) throw pyError("IndexError", "list index out of range");
      reportname = parts[1]!.split("?")[0]!;
      let docids: string | null = null;
      if (reportname.includes("/")) {
        const sp = reportname.split("/");
        if (sp.length > 2) throw pyError("ValueError", "too many values to unpack (expected 2)");
        [reportname, docids] = [sp[0]!, sp[1]!];
      }
      if (!docids) throw new NotPorted("/report/download of a report without ids (options in the url)");
      // report_routes (:27-41): the request's context updated with the given one
      const env0 = await ctx.orm();
      let env = env0;
      const given = ctx.params["context"];
      if (typeof given === "string" && given) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(given);
        } catch (e) {
          throw new NotPorted(`/report/download with a context that is not JSON (${e instanceof Error ? e.message : String(e)})`);
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new NotPorted("/report/download with a context that is not a dict");
        env = env0.withContext({ ...env0.context, ...(parsed as Record<string, unknown>) });
      }
      const ids = docids.split(",").filter((i) => /^\d+$/.test(i)).map(Number);
      const pdf = await renderReportPdf(ctx, env, reportname, ids);
      const filename = await downloadFilename(env0, reportname, ids, "pdf");
      return new Response(pdf, { status: 200, headers: {
        "Content-Type": "application/pdf", "Content-Length": String(pdf.length), "Content-Disposition": contentDispositionAttachment(filename),
      } });
    }
    // another type: the function returns None, an empty html answer
    return new Response("", { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  } catch (e) {
    if (e instanceof HttpResponseError) throw e;
    const d = serializeException(demoNotPortedFloor(ctx.env, e, ctx.url.pathname), await errorNow(ctx));
    // serialize_exception's keys in their order (dispatcher.py:84-91), `{'code': 0, 'message': ..., 'data': se}`
    const se = { name: d["name"], message: d["message"], arguments: d["arguments"], timestamp: d["timestamp"], context: d["context"] ?? {}, debug: d["debug"] };
    const body = htmlEscape(pyJsonDumps({ code: 0, message: "Odoo Server Error", data: se }, false));
    throw new HttpResponseError(new Response(body, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }));
  }
}, { auth: "user" });

// web/controllers/report.py:161-166 with base ir_actions_report.py:170-183: 'ok' where Browser Run is bound (the
// deployed Worker), else 'install' as the oracle (no wkhtmltopdf)
jsonRoute("/report/get_pdf_engine_state", async (ctx: RequestContext) => (pdfEngine(ctx) ? "ok" : "install"), { auth: "user", readonly: true });

// Local development only (LOCAL_DEV, start.sh): the parts the PDF engine gets, for the proof `pdf_html`
route("/__proof/report_pdf_parts/<string:reportname>/<string:docids>", async (ctx: RequestContext, params) => {
  if (ctx.env.LOCAL_DEV !== "1") throw new HttpError(404, "Not Found");
  const docids = String(params["docids"]).split(",").filter((s) => /^\d+$/.test(s)).map(Number);
  const parts = await reportPdfParts(await ctx.orm(), String(params["reportname"]), docids);
  return new Response(JSON.stringify(parts), { status: 200, headers: { "Content-Type": "application/json" } });
}, { auth: "user", readonly: true });

/**
 * Not routed (2026-11-05): /proof is public, and an invoice is customer data whose every rendering spends the Browser
 * Run quota; the measurement used it once as /proof?pdf=invoice. Kept for a measurement behind Access.
 * Formerly /proof?pdf=invoice (deployed only, on request): the invoice report of the first posted customer invoice of PROOF_DB
 * as the administrator (uid 2), through the same parts and engine as /report/pdf, so that its text can be checked
 * from outside Access. Its own cursor rolls back; the stylesheet requests save the PDF bundle's attachment on first
 * use, as Odoo does when it renders the report.
 */
export async function proofInvoicePdf(workerEnv: Env, db: string, url: URL): Promise<Response> {
  if (!pdfEngine({ env: workerEnv, db })) return new Response("no PDF engine", { status: 404 });
  const cr = new Cursor(workerEnv, db);
  try {
    const user = (await cr.query<{ lang: string | null; tz: string | null }>("SELECT p.lang, p.tz FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = 2")).rows[0];
    const env = await createEnvironment({ cr, uid: 2, context: { lang: user?.lang ?? "en_US", ...(user?.tz ? { tz: user.tz } : {}) }, su: false });
    // the attachments' bytes (the company logo), as RequestContext.orm() installs it
    env.cache.set(FILESTORE_READER_KEY, (fname: string) => readFile(workerEnv, db, fname));
    const id = (await cr.query<{ id: number }>("SELECT id FROM account_move WHERE move_type = 'out_invoice' AND state = 'posted' ORDER BY id LIMIT 1")).rows[0]?.id;
    if (id === undefined) return new Response("no posted invoice", { status: 404 });
    const parts = await reportPdfParts(env, "account.report_invoice", [id]);
    const pdf = await renderPdf({ env: workerEnv, db, url, cookie: null }, parts);
    return new Response(pdf, { status: 200, headers: { "Content-Type": "application/pdf", "X-Invoice-Id": String(id) } });
  } finally {
    await cr.rollback();
    await cr.close();
  }
}
