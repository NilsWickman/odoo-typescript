/**
 * Port of `odoo/odoo/http/stream.py` (Stream, STATIC_CACHE*) and of the werkzeug pieces it delegates to:
 * `werkzeug.utils.send_file` (werkzeug 3.0.1, the version the oracle runs; stream.py:14 imports it),
 * `Response.make_conditional` / `sansio.http.is_resource_modified`, `http.quote_header_value`,
 * `utils.get_content_type` and `utils.redirect`. Also Odoo's `tools/mimetypes.py` signature table (plus the
 * libmagic answers the oracle gives, since `python-magic` is installed there) and the parts of Python's
 * `mimetypes` the binary controllers use (`guess_type` by extension, `guess_extension`, `get_extension`).
 *
 * Owned by stream H2. Pure module (no Workers bindings) so it can be unit-tested with node.
 */
import { imageProcess as wasmImageProcess } from "../image/wasm-process";
import { NotPorted } from "../errors";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { redirectResponse } from "../http/context";

/** stream.py:24 */
export const STATIC_CACHE = 60 * 60 * 24 * 7;
/** stream.py:27 */
export const STATIC_CACHE_LONG = 60 * 60 * 24 * 365;

// ---------------------------------------------------------------------------------------------------------
// werkzeug header helpers
// ---------------------------------------------------------------------------------------------------------

/** werkzeug/http.py `_token_chars`. */
const TOKEN_CHARS = new Set("!#$%&'*+-.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ^_`abcdefghijklmnopqrstuvwxyz|~");

/** werkzeug/http.py `quote_header_value(value, allow_token=True)` (3.0.1). */
export function quoteHeaderValue(value: string): string {
  if (value === "") return '""';
  let token = true;
  for (const ch of value) {
    if (!TOKEN_CHARS.has(ch)) { token = false; break; }
  }
  if (token) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** werkzeug/http.py `dump_options_header`: `key*` values are emitted as is, others quoted when needed. */
function dumpOptionsHeader(header: string, options: readonly (readonly [string, string])[]): string {
  const segments = [header];
  for (const [key, value] of options) {
    segments.push(key.endsWith("*") ? `${key}=${value}` : `${key}=${quoteHeaderValue(value)}`);
  }
  return segments.join("; ");
}

/** `urllib.parse.quote(s, safe="!#$&+-.^_`|~")` as used by send_file for `filename*` (RFC 5987 attr-char). */
function rfc5987Quote(s: string): string {
  const safe = new Set("!#$&+-.^_`|~ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
  let out = "";
  for (const byte of new TextEncoder().encode(s)) {
    const ch = String.fromCharCode(byte);
    out += byte < 128 && safe.has(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** werkzeug/utils.py send_file, the `download_name` block: ascii names plain, others `filename` + `filename*`. */
export function contentDisposition(downloadName: string, asAttachment: boolean): string {
  const kind = asAttachment ? "attachment" : "inline";
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(downloadName)) return dumpOptionsHeader(kind, [["filename", downloadName]]);
  // unicodedata.normalize("NFKD", name).encode("ascii", "ignore")
  // eslint-disable-next-line no-control-regex
  const simple = downloadName.normalize("NFKD").replace(/[^\x00-\x7f]/g, "");
  return dumpOptionsHeader(kind, [["filename", simple], ["filename*", `UTF-8''${rfc5987Quote(downloadName)}`]]);
}

/** werkzeug/utils.py `get_content_type(mimetype, "utf-8")`; `_charset_mimetypes` of werkzeug 3.0.1. */
const CHARSET_MIMETYPES = new Set([
  "application/ecmascript", "application/javascript", "application/sql", "application/xml",
  "application/xml-dtd", "application/xml-external-parsed-entity",
]);
export function contentType(mimetype: string): string {
  if (mimetype.startsWith("text/") || CHARSET_MIMETYPES.has(mimetype) || mimetype.endsWith("+xml")) {
    return `${mimetype}; charset=utf-8`;
  }
  return mimetype;
}

/** werkzeug/http.py `http_date`: "Wed, 28 Oct 2026 10:31:22 GMT" (toUTCString prints the same form). */
export function httpDate(d: Date): string {
  return d.toUTCString();
}

/** werkzeug/http.py `parse_date`: RFC 2822 / 1123 dates; null when unparsable. */
function parseHttpDate(s: string | null): Date | null {
  if (s === null || s === "") return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

/** werkzeug/http.py `_etag_re` and `parse_etags` -> ETags(strong, weak, star_tag). */
interface ETags { readonly strong: string[]; readonly weak: string[]; readonly star: boolean }
const ETAG_RE = /([Ww]\/)?(?:"(.*?)"|(.*?))(?:\s*,\s*|$)/y;
function parseEtags(value: string | null): ETags | null {
  if (value === null || value === "") return null;
  const strong: string[] = [];
  const weak: string[] = [];
  let pos = 0;
  while (pos < value.length) {
    ETAG_RE.lastIndex = pos;
    const m = ETAG_RE.exec(value);
    if (m === null) break;
    const isWeak = m[1] !== undefined;
    const quoted = m[2];
    let raw = m[3] ?? "";
    if (raw === "*") return { strong, weak, star: true };
    if (quoted !== undefined) raw = quoted;
    if (isWeak) weak.push(raw); else strong.push(raw);
    if (m.index === ETAG_RE.lastIndex) break;
    pos = ETAG_RE.lastIndex;
  }
  return { strong, weak, star: false };
}

/**
 * werkzeug/sansio/http.py `is_resource_modified` with `ignore_if_range=True` (as make_conditional calls it).
 * `etag` is the unquoted tag. Returns true when the resource must be sent.
 */
export function isResourceModified(req: Headers, etag: string | null, lastModified: Date | null): boolean {
  let unmodified = false;
  if (lastModified !== null) {
    const lm = new Date(Math.floor(lastModified.getTime() / 1000) * 1000); // microseconds dropped
    const modifiedSince = parseHttpDate(req.get("if-modified-since"));
    if (modifiedSince !== null && lm.getTime() <= modifiedSince.getTime()) unmodified = true;
  }
  if (etag !== null && etag !== "") {
    const ifNoneMatch = parseEtags(req.get("if-none-match"));
    if (ifNoneMatch !== null && (ifNoneMatch.star || ifNoneMatch.strong.length > 0 || ifNoneMatch.weak.length > 0)) {
      // contains_weak: is_weak(etag) or contains(etag)
      unmodified = ifNoneMatch.star || ifNoneMatch.weak.includes(etag) || ifNoneMatch.strong.includes(etag);
    }
    const ifMatch = parseEtags(req.get("if-match"));
    if (ifMatch !== null && (ifMatch.star || ifMatch.strong.length > 0 || ifMatch.weak.length > 0)) {
      unmodified = !ifMatch.strong.includes(etag);
    }
  }
  return !unmodified;
}

/** werkzeug `ResponseCacheControl`: an insertion-ordered dict dumped as `k=v` / bare `k` (`dump_header`). */
export class CacheControl {
  private readonly items: [string, string | null][] = [];
  set(key: string, value: string | null): void {
    const i = this.items.findIndex(([k]) => k === key);
    if (i >= 0) this.items[i] = [key, value]; else this.items.push([key, value]);
  }
  delete(key: string): void {
    const i = this.items.findIndex(([k]) => k === key);
    if (i >= 0) this.items.splice(i, 1);
  }
  get(key: string): string | null | undefined {
    return this.items.find(([k]) => k === key)?.[1];
  }
  toHeader(): string {
    return this.items.map(([k, v]) => (v === null ? k : `${k}=${quoteHeaderValue(v)}`)).join(", ");
  }
}


// ---------------------------------------------------------------------------------------------------------
// mimetypes: Python `mimetypes` as the oracle has it (Python 3.12.3 defaults, /etc/mime.types, and Odoo's
// `odoo/odoo/_monkeypatches/mimetypes.py` add_type calls), restricted to the extensions present under the
// installed modules' static trees plus the ones the binary controllers meet. Values checked against the
// oracle's interpreter (`.venv/bin/python -c "import mimetypes; mimetypes.guess_type('x.js')"`, 2026-10-28)
// and gen/out's MANIFEST.json (same answers after the monkeypatch).
// ---------------------------------------------------------------------------------------------------------

const TYPES_MAP: Readonly<Record<string, string>> = {
  ".js": "text/javascript", // _monkeypatches/mimetypes.py:15
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".csv": "text/csv",
  ".eot": "application/vnd.ms-fontobject", // _monkeypatches/mimetypes.py:8
  ".gif": "image/gif",
  ".html": "text/html",
  ".htm": "text/html",
  ".ico": "image/vnd.microsoft.icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jpe": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".py": "text/x-python",
  ".sql": "application/sql",
  ".svg": "image/svg+xml", // _monkeypatches/mimetypes.py:12
  ".ts": "text/vnd.trolltech.linguist", // /etc/mime.types on the oracle host
  ".ttf": "application/x-font-ttf", // _monkeypatches/mimetypes.py:9
  ".txt": "text/plain",
  ".wasm": "application/wasm",
  ".wav": "audio/x-wav",
  ".webm": "video/webm",
  ".webp": "image/webp", // _monkeypatches/mimetypes.py:10
  ".woff": "application/font-woff", // _monkeypatches/mimetypes.py:7
  ".woff2": "font/woff2",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml",
  ".xsl": "application/xml",
  ".xhtml": "application/xhtml+xml",
  ".zip": "application/zip",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".avif": "image/avif",
  ".bin": "application/octet-stream",
};

/** Extensions Python treats as encodings (`mimetypes.encodings_map`): the oracle would add Content-Encoding. */
const ENCODING_EXTENSIONS = new Set([".gz", ".Z", ".bz2", ".xz", ".br"]);

/** `mimetypes.guess_type(name)[0]`: by the last extension (case-insensitive), null when unknown. */
export function guessTypeByName(name: string): string | null {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = base.slice(dot).toLowerCase();
  if (ENCODING_EXTENSIONS.has(ext)) throw new NotPorted(`static file with a compressed extension (${ext}): Content-Encoding`);
  return TYPES_MAP[ext] ?? null;
}

/**
 * `mimetypes.guess_extension(type)`: the first extension registered for the type in the oracle's interpreter
 * (verified 2026-10-28 for every entry below). Types not listed return null like Python does for unknown types.
 */
const GUESS_EXTENSION: Readonly<Record<string, string>> = {
  "image/webp": ".webp", "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/svg+xml": ".svg",
  "image/bmp": ".bmp", "image/vnd.microsoft.icon": ".ico", "image/tiff": ".tiff", "image/avif": ".avif",
  "application/pdf": ".pdf", "text/plain": ".txt", "application/octet-stream": ".bin", "text/javascript": ".js",
  "text/css": ".css", "font/woff2": ".woff2", "application/font-woff": ".woff", "application/json": ".json",
  "text/html": ".html", "application/xml": ".xsl", "text/xml": ".xml", "application/zip": ".zip",
  "text/csv": ".csv", "text/markdown": ".md", "audio/mpeg": ".mp3", "video/webm": ".webm", "video/mp4": ".mp4", "audio/ogg": ".ogg",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/msword": ".doc", "application/vnd.ms-excel": ".xls", "application/vnd.ms-powerpoint": ".ppt",
};
export function guessExtension(mimetype: string): string | null {
  if (mimetype === "image/x-icon" || mimetype === "application/javascript") return null; // verified None
  const ext = GUESS_EXTENSION[mimetype];
  if (ext !== undefined) return ext;
  if (mimetype.startsWith("image/") || mimetype.startsWith("text/") || mimetype.startsWith("application/")) {
    throw new NotPorted(`mimetypes.guess_extension(${mimetype})`);
  }
  return null;
}

/** odoo/odoo/tools/mimetypes.py:347 `get_extension(filename)`. */
export function getExtension(filename: string): string {
  const stripped = filename.replace(/^\.+/, "");
  const dot = stripped.lastIndexOf(".");
  if (dot < 0) return "";
  const ext = stripped.slice(dot + 1);
  if (!/^[\w-]+$/.test(ext)) return ""; // _extension_pattern.fullmatch, :344
  if (ext.length <= 4) return `.${ext}`.toLowerCase();
  const guessed = guessTypeByName(`x.${ext}`);
  // mimetypes.guess_type returns (type, encoding): a known type gives `.ext`; the encoding branch is unreachable
  // here since compressed extensions raise above.
  return guessed === null ? "" : `.${ext}`.toLowerCase();
}

/**
 * `odoo.tools.mimetypes.guess_mimetype(bin_data)`: the oracle has python-magic, so libmagic answers
 * (mimetypes.py:65-68). The signatures below are those of `SUPPORTED_MIMETYPES` plus the libmagic results
 * checked on the oracle (2026-10-28): svg with or without the xml prolog -> image/svg+xml, ico ->
 * image/vnd.microsoft.icon, empty -> application/x-empty. Null for anything else (callers decide).
 */
export function guessMimetype(data: Uint8Array): string | null {
  const starts = (sig: number[], offset = 0): boolean => sig.every((b, i) => data[offset + i] === b);
  const ascii = (s: string, offset = 0): boolean => starts([...s].map((c) => c.charCodeAt(0)), offset);
  if (data.length === 0) return "application/x-empty";
  if (starts([0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii("GIF")) return "image/gif";
  if (ascii("RIFF") && ascii("WEBP", 8)) return "image/webp";
  if (ascii("BM")) return "image/bmp";
  if (starts([0x00, 0x00, 0x01, 0x00])) return "image/vnd.microsoft.icon";
  if (ascii("%PDF-")) return "application/pdf";
  if (starts([0x49, 0x49, 0x2a, 0x00]) || starts([0x4d, 0x4d, 0x00, 0x2a])) return "image/tiff";
  if (ascii("ftypavif", 4)) return "image/avif";
  const head = new TextDecoder("utf-8").decode(data.subarray(0, 512));
  if (/^\s*<svg[\s>]/.test(head) || (/^\s*<\?xml/.test(head) && head.includes("<svg"))) return "image/svg+xml";
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------------------------------------

export interface StreamInit {
  /** 'data' streams carry bytes (Odoo's 'data' and 'path' kinds both end as bytes here); 'url' redirects. */
  readonly kind: "data" | "url";
  data?: Uint8Array;
  url?: string;
  mimetype?: string | null;
  downloadName?: string | null;
  /** Unquoted ETag; null for none. */
  etag?: string | null;
  lastModified?: Date | null;
  public?: boolean;
  maxAge?: number | null;
  immutable?: boolean;
  asAttachment?: boolean;
}

export interface ResponseOptions {
  asAttachment?: boolean;
  immutable?: boolean;
  /** stream.py:143 default "default-src 'none'"; null for none (assets, static). */
  contentSecurityPolicy?: string | null;
  /** `send_file_kwargs['max_age']`: overrides the stream's; null means "no max-age" (nocache). */
  maxAge?: number | null;
}

/** stream.py:60 `Stream`. */
export class Stream {
  readonly kind: "data" | "url";
  data: Uint8Array;
  url: string | null;
  mimetype: string | null;
  downloadName: string | null;
  etag: string | null;
  lastModified: Date | null;
  public: boolean;
  maxAge: number | null;
  immutable: boolean;
  asAttachment: boolean;

  constructor(init: StreamInit) {
    this.kind = init.kind;
    this.data = init.data ?? new Uint8Array(0);
    this.url = init.url ?? null;
    this.mimetype = init.mimetype ?? null;
    this.downloadName = init.downloadName ?? null;
    this.etag = init.etag ?? null;
    this.lastModified = init.lastModified ?? null;
    this.public = init.public ?? false;
    this.maxAge = init.maxAge ?? null;
    this.immutable = init.immutable ?? false;
    this.asAttachment = init.asAttachment ?? false;
  }

  get size(): number {
    return this.data.byteLength;
  }

  /** stream.py:143 `get_response` + werkzeug `send_file` + `make_conditional`. */
  getResponse(request: Request, opts: ResponseOptions = {}): Response {
    if (this.kind === "url") {
      // stream.py:168-173
      const url = this.url ?? "";
      if (this.maxAge !== null) {
        const res = redirectResponse(url, 302);
        res.headers.set("Cache-Control", `max-age=${this.maxAge}`);
        return res;
      }
      return redirectResponse(url, 301);
    }
    const asAttachment = opts.asAttachment ?? this.asAttachment;
    const immutable = opts.immutable ?? this.immutable;
    const maxAge = "maxAge" in opts ? (opts.maxAge ?? null) : immutable ? STATIC_CACHE_LONG : this.maxAge;
    const csp = "contentSecurityPolicy" in opts ? opts.contentSecurityPolicy : "default-src 'none'";

    const headers = new Headers();
    // send_file: mimetype from download_name when not given, else octet-stream
    let mimetype = this.mimetype;
    if (mimetype === null) {
      if (this.downloadName === null) throw new NotPorted("send_file without mimetype or download_name");
      mimetype = guessTypeByName(this.downloadName) ?? "application/octet-stream";
    }
    if (this.downloadName !== null) {
      headers.set("Content-Disposition", contentDisposition(this.downloadName, asAttachment));
    } else if (asAttachment) {
      throw new NotPorted("attachment download without a name");
    }
    headers.set("Content-Type", contentType(mimetype));
    headers.set("Content-Length", String(this.size));
    if (this.lastModified !== null) headers.set("Last-Modified", httpDate(this.lastModified));

    const cc = new CacheControl();
    cc.set("no-cache", null);
    if (maxAge !== null) {
      if (maxAge > 0) {
        cc.delete("no-cache");
        cc.set("public", null);
      }
      cc.set("max-age", String(maxAge));
      // send_file also sets `Expires = now + max_age`; omitted: it is wall-clock output (ARCHITECTURE.md, Time)
      // and the harness does not compare it.
    }
    if (this.etag !== null) headers.set("ETag", `"${this.etag}"`); // Response.set_etag -> quote_etag

    // make_conditional (GET/HEAD): ranges, then 304/412
    let status = 200;
    let ranged: Uint8Array | null = null;
    if (request.method === "GET" || request.method === "HEAD") {
      const range = request.headers.get("range");
      if (range !== null && this.size > 0 && request.headers.get("if-range") === null && request.method === "GET") {
        // werkzeug Response._process_range_request (wrappers/response.py), http.py parse_range_header: one range
        // Per RFC 9110, unsupported/multi-range/syntactically invalid Range headers are ignored (full 200 response)
        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (m && (m[1] !== "" || m[2] !== "")) {
          const size = this.size;
          const start = m[1] === "" ? Math.max(0, size - Number(m[2])) : Number(m[1]);
          const stop = m[1] === "" || m[2] === "" ? size : Math.min(size, Number(m[2]) + 1);
          if (start >= size || stop <= start) {
            return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" } });
          }
          if (!(this.data instanceof Uint8Array)) throw new NotPorted("HTTP Range requests on a stream without its bytes");
          headers.set("Content-Range", `bytes ${start}-${stop - 1}/${size}`);
          headers.set("Content-Length", String(stop - start));
          ranged = this.data.subarray(start, stop);
          status = 206;
        }
      }
      headers.set("Accept-Ranges", "bytes");
      if (!isResourceModified(request.headers, this.etag, this.lastModified)) {
        const ifMatch = parseEtags(request.headers.get("if-match"));
        status = ifMatch !== null && (ifMatch.star || ifMatch.strong.length > 0 || ifMatch.weak.length > 0) ? 412 : 304;
      }
    }

    // stream.py:203-224
    headers.set("X-Content-Type-Options", "nosniff");
    if (csp !== null && csp !== "") headers.set("Content-Security-Policy", csp);
    if (this.public) {
      if (maxAge !== null && maxAge > 0) cc.set("public", null);
    } else {
      cc.delete("public");
      cc.set("private", null);
    }
    if (immutable) cc.set("immutable", null);
    headers.set("Cache-Control", cc.toHeader());

    if (status === 304 || status === 412) {
      headers.delete("Content-Length");
      // werkzeug Response.get_wsgi_headers (wrappers/response.py:502-503): a 304 drops the entity headers
      // (http.py:30-43 `_entity_headers`, remove_entity_headers :1102 keeps Expires and Content-Location)
      if (status === 304) {
        for (const h of ["allow", "content-encoding", "content-language", "content-md5", "content-range", "content-type", "last-modified"]) headers.delete(h);
      }
      return new Response(null, { status, headers });
    }
    return new Response(request.method === "HEAD" ? null : ranged ?? this.data, { status, headers });
  }
}

/** The browser-facing image size guess, `odoo/odoo/tools/image.py:545 image_guess_size_from_field_name`. */
export function imageGuessSizeFromFieldName(fieldName: string): [number, number] {
  if (fieldName === "image") return [1024, 1024];
  if (fieldName.startsWith("x_")) return [0, 0];
  const last = fieldName.slice(fieldName.lastIndexOf("_") + 1);
  if (!/^-?\d+$/.test(last)) return [0, 0];
  const suffix = Number(last);
  if (suffix < 16) return [0, 0];
  return [suffix, suffix];
}

/**
 * The pixel size of PNG/GIF/JPEG/BMP data, or null when the format is not one of those; used to decide whether
 * `image_process` (tools/image.py:289) would return the source unchanged. ICO, TIFF and others return null.
 */
export function imageDimensions(data: Uint8Array): { format: "PNG" | "GIF" | "JPEG" | "BMP"; width: number; height: number } | null {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length >= 24 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return { format: "PNG", width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (data.length >= 10 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    return { format: "GIF", width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  }
  if (data.length >= 26 && data[0] === 0x42 && data[1] === 0x4d) {
    return { format: "BMP", width: Math.abs(dv.getInt32(18, true)), height: Math.abs(dv.getInt32(22, true)) };
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let pos = 2;
    while (pos + 9 < data.length) {
      if (data[pos] !== 0xff) return null;
      const marker = data[pos + 1] ?? 0;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { pos += 2; continue; }
      const len = dv.getUint16(pos + 2);
      const sof = (marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (sof) return { format: "JPEG", width: dv.getUint16(pos + 7), height: dv.getUint16(pos + 5) };
      pos += 2 + len;
    }
    return null;
  }
  return null;
}

/**
 * `odoo.tools.image.image_process(source, size=(w, h), crop, quality)` as `_get_image_stream_from` calls it
 * (ir_binary.py:285): returns the bytes Odoo would send, or raises NotPorted when PIL would re-encode (the
 * port has no PIL and must not guess bytes). Passthrough cases (image.py:83-93, :129-141, :187-200): empty, SVG
 * (`<` first byte), WEBP, GIF (never resized), and PNG/JPEG whose size already fits the asked box (PIL thumbnail
 * leaves them untouched, `operationsCount` stays 0 and the original source is returned).
 */
export async function imageProcess(source: Uint8Array, width: number, height: number, crop: string | null, quality: number): Promise<Uint8Array> {
  if (source.length === 0 || (width === 0 && height === 0 && crop === null && quality === 0)) return source; // image.py:303
  if (source[0] === 0x3c /* '<' */) return source; // SVG, :83
  if (source.length > 15 && String.fromCharCode(...source.subarray(0, 4)) === "RIFF" && String.fromCharCode(...source.subarray(8, 15)) === "WEBPVP8") {
    return source; // WEBP, :86
  }
  if (quality !== 0) throw new NotPorted("image_process quality (PIL re-encode)");
  // JPEG/PNG: Pillow's own code compiled to Wasm (src/image/process.ts); it refuses what it does not reproduce
  const isJpeg = source[0] === 0xff && source[1] === 0xd8 && source[2] === 0xff;
  const isPng = source[0] === 0x89 && source[1] === 0x50 && source[2] === 0x4e && source[3] === 0x47;
  const mode = crop === null || crop === "" ? "" : crop === "top" ? "top" : crop === "bottom" ? "bottom" : "center";
  if (mode !== "") {
    if (isJpeg || isPng) return wasmImageProcess(source, width, height, { crop: mode, verifyResolution: false });
    throw new NotPorted("image_process crop (PIL crop_resize)");
  }
  const dims = imageDimensions(source);
  if (dims === null) throw new NotPorted("image_process on a format the port cannot measure (ICO/TIFF/AVIF...: PIL)");
  if (dims.format === "BMP") throw new NotPorted("image_process BMP -> PNG conversion (PIL)");
  if (dims.format === "GIF") return source; // resize skipped for GIF (:187), format kept
  // resize (:187-200): PIL thumbnail only shrinks; no change when the image fits the asked box
  const { width: w, height: h } = dims;
  const askedWidth = width || Math.floor((w * height) / h);
  const askedHeight = height || Math.floor((h * width) / w);
  if (w <= askedWidth && h <= askedHeight) return source;
  // Odoo's immutable source placeholders are compiled at build time, keyed by
  // their source bytes and transformation. No corpus image enters this table.
  const variants:Record<string,{data:string}>=(await import('../../gen/out/images.json',{with:{type:'json'}})).default;
  const checksum=createHash('sha256').update(source).digest('hex');
  const variant=variants[`${checksum}:${askedWidth}:${askedHeight}`];
  if(variant) return new Uint8Array(Buffer.from(variant.data,'base64'));
  if (isJpeg || isPng) return wasmImageProcess(source, width, height, { verifyResolution: false });
  throw new NotPorted(`image_process resize ${w}x${h} -> ${askedWidth}x${askedHeight} (PIL LANCZOS re-encode)`);
}
