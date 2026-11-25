/**
 * The page Odoo answers when no route matches a request on a database with http_routing installed:
 * http_routing ir_http.py:466-482 (`_match` re-raises NotFound with `request.is_frontend = True`) and :571-608
 * (`_handle_error`: the public user if none, `_handle_debug`, `_frontend_pre_dispatch`, the fallback once more, then
 * `_get_error_html(404)` (:562-569), the template `http_routing.404` rendered by `ir.ui.view._render_template`, not
 * `Response.render`, so without `response_template`), sent as `text/html;charset=utf-8` with status 404 after
 * `_post_dispatch`.
 *
 * The language is `_match`'s (:400-412): none in the url here, then the `frontend_lang` cookie, the context's language
 * and the default one, each through `get_nearest_lang` (:304-318). Ported for a logged-in session and a path whose
 * first segment is no language; a path with a language (rewrite or redirect, :414-470), a GET in a language other
 * than the default (redirect /5), `//` in a GET path, `?debug=` (`_handle_debug` writes the session) and a default
 * language from ir.default refuse (null: the dispatcher's own not-served answer).
 */
import { NotPorted } from "../errors";
import type { RequestContext } from "../http/context";
import { installedModules } from "../http/modules";
import { renderPage } from "./page";

interface LangRow { code: string; url_code: string }

/** `res.lang._get_frontend()` (portal: the active languages by code, ordered by name, res_lang.py:355-372). */
async function activeLangs(ctx: RequestContext): Promise<LangRow[]> {
  return (await ctx.cursor().query<LangRow>("SELECT code, url_code FROM res_lang WHERE active ORDER BY name, id")).rows;
}

/** http_routing ir_http.py:304-318 `get_nearest_lang`. */
function nearestLang(langs: readonly LangRow[], code: string | null | undefined): string | null {
  if (!code) return null;
  if (langs.some((l) => l.code === code)) return code;
  const short = code.split("_")[0]!;
  if (!short) return null;
  return langs.find((l) => l.code.startsWith(short))?.code ?? null;
}

/** The 404 page, or null when the port does not serve this not-found case (the caller refuses it). */
export async function notFoundPage(ctx: RequestContext, sessionUid: number | null): Promise<Response | null> {
  const cr = ctx.cursor();
  if (!(await installedModules(cr)).has("http_routing")) return null;
  if (sessionUid === null) return null; // `_match` on a public session (its context language) is not ported
  const path = ctx.url.pathname;
  const method = ctx.request.method;
  const langs = await activeLangs(ctx);
  // :383-385 `_, url_lang_str, *rest = path.split('/', 2)` and :404 the language of the url
  const urlLangStr = path.split("/")[1] ?? "";
  const byUrlCode = langs.find((l) => l.url_code === urlLangStr)?.code;
  if (nearestLang(langs, byUrlCode || urlLangStr)) return null; // a language in the url: rewrite or redirect
  if (method !== "POST" && path.includes("//")) return null; // :393-395 redirect
  if (ctx.url.searchParams.has("debug")) return null; // web ir_http.py:52-61 `_handle_debug` writes the session
  // :261-265 `_get_default_lang`: ir.default `_get('res.partner', 'lang')` (ir_default.py:140-167: the value for all
  // users and companies, without condition), else the first active language
  const stored = (await cr.query<{ v: string }>(
    `SELECT d.json_value AS v FROM ir_default d JOIN ir_model_fields f ON f.id = d.field_id
      WHERE f.model = 'res.partner' AND f.name = 'lang' AND d.user_id IS NULL AND d.company_id IS NULL AND d.condition IS NULL
      ORDER BY d.id LIMIT 1`)).rows[0];
  let defaultLang = langs[0]?.code;
  if (stored !== undefined) {
    const code: unknown = JSON.parse(stored.v);
    if (typeof code !== "string" || !langs.some((l) => l.code === code)) return null; // `_get_data` of an inactive language
    defaultLang = code;
  }
  if (defaultLang === undefined) throw new NotPorted("http_routing 404 page without an active language");
  const cookieLang = nearestLang(langs, ctx.requestCookies.get("frontend_lang"));
  const contextLang = nearestLang(langs, typeof ctx.context.lang === "string" ? ctx.context.lang : null);
  const lang = cookieLang ?? contextLang ?? defaultLang;
  // :424-437 a GET without a language in the url and another language than the default one redirects (/5); bots
  // (/3) take the default language
  if (lang !== defaultLang) return null;
  // :517-520 `_frontend_pre_dispatch`: the context's language and the cookie
  ctx.updateContext({ lang });
  if (ctx.requestCookies.get("frontend_lang") !== lang) {
    const expires = new Date(Date.now() + 365 * 24 * 3600 * 1000).toUTCString();
    ctx.cookies.push(`frontend_lang=${lang}; Expires=${expires}; Path=/`);
  }
  const env = await ctx.orm();
  // :529-557 `_get_exception_code_values` of a werkzeug NotFound; http_routing.404 reads none of them
  const values: Record<string, unknown> = {
    status_code: 404, status_message: "Not Found",
    error_message: "The requested URL was not found on the server. If you entered the URL manually please check your spelling and try again.",
  };
  const html = await renderPage(ctx, "http_routing.404", values, env, { responseTemplate: false });
  return new Response(html, { status: 404, headers: { "Content-Type": "text/html;charset=utf-8" } });
}
