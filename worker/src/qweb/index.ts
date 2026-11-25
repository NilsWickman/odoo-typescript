/**
 * Server-side QWeb for the HTTP stream: `renderTemplate(cr, xmlid, values, opts)` = `request.render(template,
 * qcontext)` -> `ir.ui.view._render_template` -> `ir.qweb._render` (odoo/odoo/http/response.py:90-92,
 * ir_ui_view.py:2610-2611, ir_qweb.py:711-762) with `_prepare_environment` (1364-1400) for the values the port can
 * provide itself. Templates are read from ir_ui_view (type qweb) by key with inheritance applied (views/combine.ts).
 *
 * Values the caller must supply (`_prepare_environment` takes them from the request and the environment):
 *   request: { csrf_token(timeLimit?) -> string, db: string | null }            web.layout, web.login
 *   env: Map { 'ir.http' -> { get_frontend_session_info() -> dict } }            web.frontend_layout
 *   res_company: { uses_default_logo: boolean, name: string }                     web.login_layout
 *   keep_query(...names) -> string (the current query string, url-encoded)      auth_signup.login (web.login)
 *   user_id, company: provided by Odoo but unused by the three phase-1 templates
 * plus the controller's qcontext (see the report): web.login reads databases, login, error, message, redirect,
 * debug, disable_database_manager, disable_footer, disable_opengraph (+ og_url, og_title, og_image_url, og_domain),
 * signup_enabled, reset_password_enabled, login_card_classes, extra_session_info, title, x_icon, no_header,
 * no_footer, pageName (frontend_layout); web.webclient_bootstrap reads session_info, color_scheme, debug, head,
 * test_mode_enabled; web.webclient_offline reads odoo_icon (with to_base64()), debug.
 */
import type { SqlCursor } from "../views/combine";
import { jsonDumps, Markup, type Scope } from "../pyexpr";
import { isDict, pyStr } from "../pyexpr/values";
import { loadTemplates, type TemplateSet } from "./templates";
import { render, ScriptSafe, type RenderOptions } from "./render";

export { loadTemplates, type TemplateSet, type LoadedTemplate } from "./templates";
export { render, renderCall, QwebContent, ScriptSafe, type RenderOptions } from "./render";
export { assetCallKey, assetLinks, assetNodes, linkToNode, type AssetCall, type AssetNode } from "./assets";

export interface RenderTemplateOptions extends RenderOptions {
  /** `lang` of the rendering environment (translated archs, rtl bundles); default en_US. */
  readonly lang?: string;
  /** ir_qweb.py:1377 `minimal_qcontext`: the caller's values keep their `lang` (mail_render_mixin.py:259
   *  `_render_encapsulate`, whose `lang` is `self.env.lang`, None in a cron job's environment). */
  readonly minimalQcontext?: boolean;
}

/** `qwebJSON` (ir_qweb.py:680-697): `json.scriptsafe.dumps` with Mapping/BinaryValue/QwebContent defaults. */
export const qwebJson = {
  dumps: (obj: unknown): ScriptSafe =>
    new ScriptSafe(
      jsonDumps(obj, (v) => {
        if (v instanceof Markup) return v.toString();
        if (isDict(v)) return v;
        if (typeof v === "object" && v !== null && "decode" in v && typeof (v as { decode: unknown }).decode === "function") return (v as { decode: () => string }).decode();
        throw new TypeError(`Object of type ${typeof v} is not JSON serializable`);
      }),
    ),
};

/** `werkzeug.urls.url_quote_plus`: percent-encoding with `+` for spaces. */
export function quotePlus(s: unknown): string {
  return encodeURIComponent(pyStr(s)).replace(/%20/g, "+").replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * `_prepare_environment` (1364-1400) for the keys the port owns; `request`, `env`, `user_id`, `res_company`,
 * `company` and `keep_query` come from the caller (`setdefault`/`update` semantics as in Odoo: `debug` and
 * `res_company`/`company`/`user_id` only when absent, the helpers always).
 */
export function prepareValues(values: Scope, opts: RenderTemplateOptions): Scope {
  if (!values.has("debug")) values.set("debug", opts.debug ?? "");
  values.set("test_mode_enabled", false); // config['test_enable']
  values.set("json", qwebJson);
  values.set("quote_plus", quotePlus);
  values.set("floor", (x: unknown) => Math.floor(Number(x)));
  values.set("ceil", (x: unknown) => Math.ceil(Number(x)));
  if (!opts.minimalQcontext) values.set("lang", opts.lang ?? null);
  return values;
}

/**
 * Render the QWeb template `xmlid` (a view key or id) with `values` (a Map or plain object of the qcontext) and
 * return the html, like `request.render(xmlid, values).render()`.
 */
export async function renderTemplate(cr: SqlCursor, xmlid: string | number, values: Scope | Record<string, unknown>, opts: RenderTemplateOptions = {}): Promise<string> {
  const scope: Scope = values instanceof Map ? new Map(values) : new Map(Object.entries(values));
  const load = { lang: opts.lang ?? "en_US", debug: opts.debug ?? pyStr(scope.get("debug") ?? "") };
  const templates = await loadTemplates(cr, xmlid, load);
  // a dynamic t-call (web.external_layout: `{{company.external_report_layout_id.sudo().key}}`) loads its target when it is reached
  const loadTemplate = async (ref: string | number): Promise<void> => {
    const more = await loadTemplates(cr, ref, load);
    for (const [k, v] of more.byRef) templates.byRef.set(k, v);
    for (const [k, v] of more.assets) templates.assets.set(k, v);
  };
  return renderLoaded(templates, xmlid, scope, { ...opts, loadTemplate });
}

/** The second half of renderTemplate, for preloaded template sets (tests, repeated renders). */
export function renderLoaded(templates: TemplateSet, xmlid: string | number, values: Scope, opts: RenderTemplateOptions = {}): Promise<string> {
  return render(templates, xmlid, prepareValues(values, opts), opts);
}
