/**
 * The demo's PDF egress lock (`DEMO_MODE=1` only, src/controllers/report.ts renderPdf): the html Browser Run renders
 * reaches nothing. JavaScript off, every http(s) request rejected, a Content-Security-Policy that allows only inline
 * styles and data: images and fonts, no meta refresh; the fonts of the inlined stylesheets and the report's
 * same-origin `/web/image/` and `/web/content/` images are inlined as data: URIs instead, within a 4 MiB budget (an
 * asset past it is dropped with a warning, the PDF is still rendered).
 */

export const DEMO_PDF_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:;";
export const DEMO_PDF_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${DEMO_PDF_CSP}">`;
export const DEMO_PDF_ASSET_BUDGET = 4 * 1024 * 1024;
/** Extra `browser.quickAction("pdf", ...)` options of the demo. */
export const DEMO_PDF_ENGINE_OPTIONS = { setJavaScriptEnabled: false, rejectRequestPattern: ["/^https?:\\/\\//"] } as const;

/** Fetches one same-origin asset (through the Worker's own dispatcher); null when it did not answer 200. */
export type AssetFetcher = (url: URL) => Promise<{ readonly contentType: string; readonly bytes: Uint8Array } | null>;

export function stripMetaRefresh(html: string): string {
  return html.replace(/<meta\b[^>]*\bhttp-equiv\s*=\s*(["']?)\s*refresh\s*\1[^>]*>/gi, "");
}

/** The CSP meta as the very first element of `<head>` (after stripping any meta refresh). */
export function lockPdfHtml(html: string): string {
  const stripped = stripMetaRefresh(html);
  const m = /<head\b[^>]*>/i.exec(stripped);
  if (m) return stripped.slice(0, m.index + m[0].length) + DEMO_PDF_CSP_META + stripped.slice(m.index + m[0].length);
  return `<head>${DEMO_PDF_CSP_META}</head>${stripped}`;
}

function decodeAttr(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/** A same-origin url of the kind given, without path tricks; null otherwise. */
export function sameOriginAsset(raw: string, base: URL, kind: "font" | "image"): URL | null {
  const value = raw.trim();
  if (value === "" || value.startsWith("data:")) return null;
  let resolved: URL;
  try {
    resolved = new URL(value, base);
  } catch {
    return null;
  }
  if (resolved.origin !== base.origin) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(resolved.pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\\") || decoded.includes("\0") || decoded.split("/").some((s) => s === "." || s === "..")) return null;
  if (kind === "image") {
    return resolved.pathname.startsWith("/web/image/") || resolved.pathname.startsWith("/web/content/") ? resolved : null;
  }
  return resolved;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** The 4 MiB budget shared by every asset of one PDF, with a cache so a repeated logo is paid once. */
export class AssetInliner {
  private used = 0;
  private readonly cache = new Map<string, string | null>();

  constructor(private readonly fetcher: AssetFetcher, readonly budget = DEMO_PDF_ASSET_BUDGET) {}

  get usedBytes(): number {
    return this.used;
  }

  /** The asset as a data: URI, or null (missing, wrong type, or over budget: dropped with a warning). */
  async dataUri(url: URL, kind: "font" | "image"): Promise<string | null> {
    const key = url.href;
    if (this.cache.has(key)) return this.cache.get(key)!;
    let out: string | null = null;
    try {
      const asset = await this.fetcher(url);
      const type = (asset?.contentType ?? "").split(";")[0]!.trim().toLowerCase();
      if (asset === null) {
        console.warn(`demo pdf: asset ${url.pathname} unavailable, dropped`);
      } else if (kind === "image" && !type.startsWith("image/")) {
        console.warn(`demo pdf: asset ${url.pathname} is ${type || "untyped"}, not an image, dropped`);
      } else if (this.used + asset.bytes.length > this.budget) {
        console.warn(`demo pdf: asset ${url.pathname} (${asset.bytes.length} B) over the ${this.budget} B budget, dropped`);
      } else {
        this.used += asset.bytes.length;
        out = `data:${type || "application/octet-stream"};base64,${toBase64(asset.bytes)}`;
      }
    } catch (e) {
      console.warn(`demo pdf: asset ${url.pathname} failed, dropped:`, e);
    }
    this.cache.set(key, out);
    return out;
  }
}

async function replaceAsync(s: string, re: RegExp, fn: (m: RegExpExecArray) => Promise<string>): Promise<string> {
  const parts: string[] = [];
  let last = 0;
  for (const m of s.matchAll(re)) {
    parts.push(s.slice(last, m.index), await fn(m as RegExpExecArray));
    last = m.index! + m[0].length;
  }
  parts.push(s.slice(last));
  return parts.join("");
}

const DROPPED_URL = 'url("data:,")';

/** Every `url(...)` of the `@font-face` rules of a stylesheet inlined; anything not inlinable is dropped. */
export async function inlineFontFaces(css: string, base: URL, inliner: AssetInliner): Promise<string> {
  return replaceAsync(css, /@font-face\s*\{[^}]*\}/gi, async (block) =>
    replaceAsync(block[0], /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, async (u) => {
      const raw = u[2]!;
      if (raw.trim().startsWith("data:")) return u[0];
      const target = sameOriginAsset(raw, base, "font");
      const data = target === null ? null : await inliner.dataUri(target, "font");
      return data === null ? DROPPED_URL : `url("${data}")`;
    }),
  );
}

/** The `src` of every `<img>` on a same-origin `/web/image/` or `/web/content/` url inlined; other remote ones dropped. */
export async function inlineImages(html: string, base: URL, inliner: AssetInliner): Promise<string> {
  return replaceAsync(html, /(<img\b[^>]*?\bsrc\s*=\s*)(["'])([\s\S]*?)\2/gi, async (m) => {
    const raw = decodeAttr(m[3]!);
    if (raw.trim().startsWith("data:")) return m[0];
    const target = sameOriginAsset(raw, base, "image");
    const data = target === null ? null : await inliner.dataUri(target, "image");
    return `${m[1]}${m[2]}${data ?? "data:,"}${m[2]}`;
  });
}
