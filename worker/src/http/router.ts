/**
 * Route table, Odoo's `@route` (`odoo/odoo/http/router.py`, `routing_map.py`). Controllers register at module
 * load time with `route()` / `jsonRoute()`; the dispatcher in src/http/dispatch.ts resolves and runs them.
 * Owned by the HTTP stream.
 */
import type { Handler, JsonHandler, RequestContext } from "./context";
import { NotPorted } from "../errors";

export type Auth = "user" | "public" | "none" | "bearer";

export interface RouteDef {
  readonly method: "GET" | "POST" | "ANY";
  /** Werkzeug-style pattern: `/web/image/<string:model>/<int:id>/<string:field>`; converters string, int, path. */
  readonly pattern: string;
  readonly auth: Auth;
  readonly type: "http" | "jsonrpc" | "json2";
  readonly handler: Handler | JsonHandler;
  /** `csrf=False` routes (Odoo checks csrf on POST http routes with a session). */
  readonly csrf: boolean;
  /** `save_session=False`: the response does not set the session cookie (routing_map.py). */
  readonly saveSession: boolean;
  /** `readonly=True` routes may run without a write cursor (Odoo 20 `readonly` route attribute). */
  readonly readonly: boolean;
  /** `check_identity=False` (home.py:87-92): no identity confirmation for this route. */
  readonly checkIdentity: boolean;
  /** `cors='*'` (webclient.py:50): Access-Control-Allow-Origin on the response. */
  readonly cors: string | null;
  /** `bearer_scope` of auth='bearer' routes (ir_http.py:318-357). */
  readonly bearerScope: string | null;
}

interface Compiled extends RouteDef {
  readonly regex: RegExp;
  readonly names: readonly string[];
  readonly ints: ReadonlySet<string>;
}

const ROUTES: Compiled[] = [];

function compile(pattern: string): { regex: RegExp; names: string[]; ints: Set<string> } {
  const names: string[] = [];
  const ints = new Set<string>();
  const source = pattern.replace(/<(?:(\w+):)?(\w+)>/g, (_m, conv: string | undefined, name: string) => {
    names.push(name);
    if (conv === "int") {
      ints.add(name);
      return "(\\d+)";
    }
    if (conv === "path") return "(.+?)";
    return "([^/]+)";
  });
  return { regex: new RegExp(`^${source}$`), names, ints };
}

export interface RouteOptions {
  auth?: Auth;
  csrf?: boolean;
  saveSession?: boolean;
  readonly?: boolean;
  methods?: ("GET" | "POST")[];
  checkIdentity?: boolean;
  cors?: string;
  bearerScope?: string;
}

export function route(patterns: string | string[], handler: Handler, opts: RouteOptions = {}): void {
  add(patterns, "http", handler, opts);
}

export function jsonRoute(patterns: string | string[], handler: JsonHandler, opts: RouteOptions = {}): void {
  add(patterns, "jsonrpc", handler, { ...opts, methods: opts.methods ?? ["POST"] });
}

/** `type='json2'` routes (dispatcher.py:414-472 Json2Dispatcher): the JSON body and the path arguments as parameters. */
export function json2Route(patterns: string | string[], handler: JsonHandler, opts: RouteOptions = {}): void {
  add(patterns, "json2", handler, opts);
}

function add(patterns: string | string[], type: "http" | "jsonrpc" | "json2", handler: Handler | JsonHandler, opts: RouteOptions): void {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  const method = opts.methods === undefined ? "ANY" : opts.methods.length === 1 ? (opts.methods[0] ?? "ANY") : "ANY";
  for (const pattern of list) {
    const c = compile(pattern);
    ROUTES.push({
      method, pattern, type, handler,
      auth: opts.auth ?? "user",
      csrf: opts.csrf ?? true,
      saveSession: opts.saveSession ?? true,
      readonly: opts.readonly ?? false,
      checkIdentity: opts.checkIdentity ?? true,
      cors: opts.cors ?? null,
      bearerScope: opts.bearerScope ?? null,
      regex: c.regex, names: c.names, ints: c.ints,
    });
  }
}

export interface Match {
  readonly route: RouteDef;
  readonly params: Record<string, string>;
}

export function match(method: string, pathname: string): Match | null {
  const m = matchPath(method, pathname, false);
  return m.kind === "match" ? m : null;
}

export type PathMatch =
  | ({ readonly kind: "match" } & Match)
  /** werkzeug `MethodNotAllowed`: the path matched rules of other methods only (`Allow` lists them). */
  | { readonly kind: "method_not_allowed"; readonly allowed: readonly string[] }
  | { readonly kind: "not_found" };

/**
 * Resolve a path like werkzeug's `Map.match(return_rule=True)` (base ir_http.py:252-255). `nodb` restricts to
 * auth="none" routes, the `nodb_routing_map` (router.py:215-226, routing_map.py:320-321). HEAD matches GET rules;
 * OPTIONS is accepted on every rule (router.py:220-221, ir_http.py:525-526).
 */
export function matchPath(method: string, pathname: string, nodb: boolean): PathMatch {
  return matchIn(ROUTES, method, pathname, nodb);
}

function matchIn(table: readonly Compiled[], method: string, pathname: string, nodb: boolean): PathMatch {
  const verb = method === "HEAD" ? "GET" : method;
  const allowed = new Set<string>();
  for (const r of table) {
    if (nodb && r.auth !== "none") continue;
    const m = r.regex.exec(pathname);
    if (m === null) continue;
    if (r.method !== "ANY" && r.method !== verb && verb !== "OPTIONS") {
      allowed.add(r.method);
      continue;
    }
    const params: Record<string, string> = {};
    try {
      for (let i = 0; i < r.names.length; i++) {
        params[r.names[i]!] = decodeURIComponent(m[i + 1] ?? "");
      }
    } catch (e) {
      if (e instanceof URIError) return { kind: "not_found" };
      throw e;
    }
    return { kind: "match", route: r, params };
  }
  if (allowed.size > 0) return { kind: "method_not_allowed", allowed: [...allowed, "OPTIONS"] };
  return { kind: "not_found" };
}

/**
 * The routes of a template's new modules' own controllers (compiler/runtime/install.ts routeKey): Odoo's routing map is
 * the registry's, built from the installed modules' controllers (routing_map.py:230-333 `_generate_routing_rules`), so
 * such a route exists only on a database of the template it was compiled for (src/orm/template.ts, the exact module set).
 */
interface TemplateCompiled extends Compiled { readonly template: string }
const TEMPLATE_ROUTES: TemplateCompiled[] = [];

/**
 * Registers a compiled route for `template`. A pattern the hand port registers itself would be an override of one of
 * the hand's routes (the hand's handler is not the module's chain): refused, as compiler/sitebuild.py refuses controller
 * overrides. The registration options are the merged `@route` arguments (routing_map.py:296-315).
 */
export function templateRoute(template: string, patterns: readonly string[], type: "http" | "jsonrpc", handler: Handler | JsonHandler, opts: RouteOptions): void {
  const method = opts.methods === undefined ? "ANY" : opts.methods.length === 1 ? (opts.methods[0] ?? "ANY") : "ANY";
  for (const pattern of patterns) {
    if (ROUTES.some((r) => r.pattern === pattern)) throw new Error(`compiled route ${pattern} of ${template}: the hand port serves this route (an override)`);
    if (TEMPLATE_ROUTES.some((r) => r.pattern === pattern && r.template === template)) throw new Error(`compiled route ${pattern} of ${template} registered twice`);
    const c = compile(pattern);
    TEMPLATE_ROUTES.push({
      template, method, pattern, type, handler,
      auth: opts.auth ?? "user",
      csrf: opts.csrf ?? true,
      saveSession: opts.saveSession ?? true,
      readonly: opts.readonly ?? false,
      checkIdentity: opts.checkIdentity ?? true,
      cors: opts.cors ?? null,
      bearerScope: opts.bearerScope ?? null,
      regex: c.regex, names: c.names, ints: c.ints,
    });
  }
}

/** The templates having a compiled route whose pattern matches `pathname` (no database needed: the regexes only). */
export function templateRouteCandidates(pathname: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const r of TEMPLATE_ROUTES) if (r.regex.test(pathname)) out.add(r.template);
  return out;
}

/**
 * Resolve a path against the hand's routes and `template`'s compiled ones together. Werkzeug sorts all rules of one map
 * by their weights (static parts first); a path that both tables match would need that order: refused.
 */
export function matchPathFor(template: string, method: string, pathname: string): PathMatch {
  const hand = matchIn(ROUTES, method, pathname, false);
  const mine = matchIn(TEMPLATE_ROUTES.filter((r) => r.template === template), method, pathname, false);
  if (mine.kind === "not_found") return hand;
  if (hand.kind !== "not_found") {
    throw new NotPorted(`${pathname} matches a hand route and a compiled route of ${template}: werkzeug's rule order between them is not modelled`);
  }
  return mine;
}

/** For tests and the health page: every registered pattern. */
export function routes(): readonly RouteDef[] {
  return ROUTES;
}

/**
 * `ir.http._serve_fallback` (base ir_http.py:499-505) and the static file service (router.py:274-275, 327-346):
 * handlers tried in order when no route matched, each returning a Response or null. Registered by the static
 * and binary stream (H2); the dispatcher answers 404 with `X-Odoo-Port-Fallback` when all decline.
 */
export type Fallback = (ctx: RequestContext) => Promise<Response | null>;
const FALLBACKS: Fallback[] = [];

export function registerFallback(fn: Fallback): void {
  FALLBACKS.push(fn);
}

export function fallbacks(): readonly Fallback[] {
  return FALLBACKS;
}
