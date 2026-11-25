/**
 * The functions `_prepare_environment` (ir_qweb.py:1364-1400) and the report rendering context give to templates.
 */
import { NotPorted } from "../errors";
import type { BinaryValue, Environment } from "../orm/types";
import { PyObject, pyStr } from "../pyexpr/values";
import { dbNow } from "../session/user";
import { type Naive, utcToLocal } from "../web/tz";

/** tools/mail.py:525-538 is_html_empty. */
export function isHtmlEmpty(value: unknown): boolean {
  if (!value) return true;
  const html = pyStr(value);
  const iconRe = /<\s*(i|span)\b(\s+[A-Za-z_-][A-Za-z0-9-_]*(\s*=\s*['"][^"']*['"])?)*\s*\bclass\s*=\s*["'][^"']*\b(fa|fab|fad|far|oi)\b/;
  const tagRe = /<\s*\/?(?:p|div|section|span|br|b|i|font)\b(?:(\s+[A-Za-z_-][A-Za-z0-9-_]*(\s*=\s*['"][^"']*['"]))*)(?:\s*>|\s*\/\s*>)/g;
  const text = html.replace(tagRe, "").replace(/&nbsp;/g, " ").replace(/&#160;/g, " ");
  return text.trim() === "" && !iconRe.test(html);
}

/** tools/image.py image_data_uri for a png or the sniffed type. */
async function imageDataUri(value: unknown): Promise<string> {
  const bytes = typeof value === "object" && value !== null && "content" in value ? await (value as BinaryValue).content() : null;
  if (bytes === null) throw new Error("image_data_uri of a value without content");
  const b64 = Buffer.from(bytes).toString("base64");
  // image.py:33-39 FILETYPE_BASE64_MAGICWORD on the first base64 character, png by default
  const mime = ({ "/": "jpg", R: "gif", i: "png", P: "svg+xml", U: "webp" } as Record<string, string>)[b64.slice(0, 1)] ?? "png";
  return `data:image/${mime};base64,${b64}`;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A `datetime.datetime` value: naive (UTC wall clock) or converted to a zone by `context_timestamp`. */
class PyDatetime extends PyObject {
  constructor(readonly utc: Date, readonly wall: Naive) { super(); }
  pyGetAttr(name: string): unknown {
    const w = this.wall;
    switch (name) {
      case "year": return w.year;
      case "month": return w.month;
      case "day": return w.day;
      case "hour": return w.hour;
      case "minute": return w.minute;
      case "second": return w.second;
      // datetime.strftime with the C locale directives the report templates use
      case "strftime": return (fmt: unknown) => String(fmt).replace(/%(.)/g, (_m, d: string) => {
        switch (d) {
          case "Y": return pad(w.year, 4);
          case "y": return pad(w.year % 100);
          case "m": return pad(w.month);
          case "d": return pad(w.day);
          case "H": return pad(w.hour);
          case "M": return pad(w.minute);
          case "S": return pad(w.second);
          case "B": return MONTHS[w.month - 1]!;
          case "b": return MONTHS[w.month - 1]!.slice(0, 3);
          case "%": return "%";
          default: throw new NotPorted(`datetime.strftime directive %${d}`);
        }
      });
      default: throw new NotPorted(`datetime attribute ${name}`);
    }
  }
  override pyToString(): string {
    const w = this.wall;
    return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`;
  }
}

/** safe_eval's `datetime` module, as far as `datetime.datetime.now()` (the transaction's now, frozen per run). */
class PyDatetimeModule extends PyObject {
  constructor(private readonly env: Environment) { super(); }
  pyGetAttr(name: string): unknown {
    const env = this.env;
    // `datetime.date.today()`: the server's local date, UTC in Odoo (odoo/__init__.py sets TZ=UTC), as the ISO string
    // date fields have in the templates (their comparisons and `str()` are the date's)
    if (name === "date") {
      return new (class extends PyObject {
        pyGetAttr(attr: string): unknown {
          if (attr !== "today") throw new NotPorted(`datetime.date.${attr} in a template`);
          return async () => (await dbNow(env.cr)).toISOString().slice(0, 10);
        }
      })();
    }
    if (name !== "datetime") throw new NotPorted(`datetime.${name} in a template`);
    return new (class extends PyObject {
      pyGetAttr(attr: string): unknown {
        if (attr !== "now") throw new NotPorted(`datetime.datetime.${attr} in a template`);
        return async () => { const now = await dbNow(env.cr); return new PyDatetime(now, utcToLocal(now, "UTC")); };
      }
    })();
  }
}

/**
 * ir_qweb.py:1388 `datetime` and the report's `context_timestamp` (ir_actions_report.py:417): the value in the
 * report user's zone (`fields.Datetime.context_timestamp` with tz=user.tz; no zone keeps UTC).
 */
export function reportHelpers(env: Environment): Record<string, unknown> {
  const contextTimestamp = async (dt: unknown): Promise<PyDatetime> => {
    if (!(dt instanceof PyDatetime)) throw new NotPorted("context_timestamp of a value other than datetime.datetime.now()");
    const tz = (await env.cr.query<{ tz: string | null }>("SELECT p.tz FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = $1", [env.uid])).rows[0]?.tz;
    let wall: Naive;
    try { wall = utcToLocal(dt.utc, tz || "UTC"); } catch { wall = dt.wall; }
    return new PyDatetime(dt.utc, wall);
  };
  return { is_html_empty: isHtmlEmpty, image_data_uri: imageDataUri, datetime: new PyDatetimeModule(env), context_timestamp: contextTimestamp };
}
