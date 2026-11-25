/**
 * Static module files: `GET /<module>/static/<path>`, `odoo/odoo/http/router.py:180 get_static_file` (served
 * before any routing or database, :274) and `:327 serve_static` (`Stream.from_path(..., public=True)
 * .get_response(max_age=STATIC_CACHE, content_security_policy=None)` then `set_csp`). The files come from
 * Workers Static Assets (`worker/assets/<module>/static/...`, filled by gen/assets.py from the installed modules'
 * trees) through the ASSETS binding.
 *
 * Odoo serves the static tree of every addon present in the addons path (Manifest.for_addon, router.py:172-178),
 * installed or not, so no database lookup happens here either; the set of modules is what gen/assets.py copied.
 *
 * Owned by stream H2.
 */
import type { Env } from "../env";
import type { RequestContext } from "../http/context";
import { route } from "../http/router";
import { HttpError, NotPorted } from "../errors";
import { Stream, STATIC_CACHE, guessTypeByName } from "./stream";

export interface StaticFile {
  readonly data: Uint8Array;
  /** The binding's ETag (content hash), unquoted. Odoo's `{mtime}-{size}-{adler32(path)}` cannot be reproduced. */
  readonly etag: string | null;
  readonly lastModified: Date | null;
}

/** Fetches `/<module>/static/<path>` from the ASSETS binding; null when the file does not exist. */
export async function fetchStaticAsset(env: Env, path: string): Promise<StaticFile | null> {
  if (!path.startsWith("/")) path = `/${path}`;
  const res = await env.ASSETS.fetch(new Request(`http://assets${path}`));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`ASSETS binding: ${res.status} for ${path}`);
  const etag = res.headers.get("etag");
  const lm = res.headers.get("last-modified");
  const t = lm === null ? NaN : Date.parse(lm);
  return {
    data: new Uint8Array(await res.arrayBuffer()),
    etag: etag === null ? null : etag.replace(/^W\//, "").replace(/^"|"$/g, ""),
    lastModified: Number.isNaN(t) ? null : new Date(t),
  };
}

/**
 * router.py:180-211: the url must be `/<module>/static/<resource>`; `file_path` keeps the resource inside the
 * module (no `..`). Returns the normalized static path or null.
 */
export function staticFilePath(urlPath: string): string | null {
  if (urlPath.includes("\\") || urlPath.includes("\0")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\\") || decoded.includes("\0")) return null;
  const parts = urlPath.split("/");
  if (parts.length < 4 || parts[0] !== "" || parts[2] !== "static") return null;
  const decodedParts = decoded.split("/");
  if (decodedParts.length < 4 || decodedParts[0] !== "" || decodedParts[2] !== "static") return null;
  const module = parts[1] ?? "";
  const resource = parts.slice(3).join("/");
  if (module === "" || resource === "" || parts.some((p) => p === "." || p === "..") || decodedParts.some((p) => p === "." || p === "..")) {
    return null;
  }
  return `/${module}/static/${resource}`;
}

/** `Stream.from_path(path, public=...)` (stream.py:103) backed by the ASSETS binding. */
export async function streamFromStaticPath(env: Env, path: string, isPublic: boolean): Promise<Stream | null> {
  const file = await fetchStaticAsset(env, path);
  if (file === null) return null;
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return new Stream({
    kind: "data",
    data: file.data,
    mimetype: guessTypeByName(basename), // mimetypes.guess_type(path)[0], may be None
    downloadName: basename,
    etag: file.etag,
    lastModified: file.lastModified,
    public: isPublic,
  });
}

async function serveStatic(ctx: RequestContext, params: Record<string, string>): Promise<Response> {
  const path = staticFilePath(`/${params["module"] ?? ""}/static/${params["path"] ?? ""}`);
  if (path === null) throw new HttpError(404, `File "${params["path"] ?? ""}" not found in module ${params["module"] ?? ""}.\n`);
  const stream = await streamFromStaticPath(ctx.env, path, true);
  if (stream === null) {
    // router.py:347 (OSError -> NotFound)
    throw new HttpError(404, `File "${params["path"] ?? ""}" not found in module ${params["module"] ?? ""}.\n`);
  }
  // router.py:335-338: debug=assets disables caching unless the request comes from wkhtmltopdf
  const debug = String(ctx.session.debug ?? "").includes("assets")
    && !ctx.userAgent.includes(" wkhtmltopdf ");
  const res = stream.getResponse(ctx.request, { maxAge: debug ? 0 : STATIC_CACHE, contentSecurityPolicy: null });
  // router.py:233 set_csp: nosniff is already set by get_response; images get the default CSP
  if ((res.headers.get("Content-Type") ?? "").startsWith("image/") && !res.headers.has("Content-Security-Policy")) {
    res.headers.set("Content-Security-Policy", "default-src 'none'");
  }
  if (ctx.request.method !== "GET" && ctx.request.method !== "HEAD") {
    throw new NotPorted(`static file with method ${ctx.request.method}`);
  }
  return res;
}

route("/<string:module>/static/<path:path>", serveStatic, { auth: "none", methods: ["GET"], readonly: true, saveSession: false });
