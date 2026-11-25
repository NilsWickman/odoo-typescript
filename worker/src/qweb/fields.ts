/**
 * `ir.qweb.field.*` (odoo/addons/base/models/ir_qweb_fields.py): what `t-field` and `t-out` with a widget print, and
 * `_get_field` / `_get_widget` (ir_qweb.py:2862-2916). No branding: reports and portal pages render without it.
 */
import { NotPorted } from "../errors";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { floatRound } from "../orm/convert";
import { envTz } from "../orm/env";
import type { BinaryValue, Environment, FieldDef } from "../orm/types";
import { escape, isPyFloat, Markup, pyStr, toNumber } from "../pyexpr/values";
import { langNumber } from "../mail/tracking";
import { formatPosix, getLang } from "../models/tail_util";
import { PyNewRecord, PyRecords } from "./records";
import type { FieldRender } from "./render";

type Options = Map<unknown, unknown>;

/** `nl2br` (ir_qweb_fields.py:22-27). */
export function nl2br(text: string): Markup {
  return new Markup(escape(text).toString().replace(/\n/g, "<br>\n"));
}

const num = (v: unknown): number => (isPyFloat(v) ? v.float : toNumber(v));

async function precisionGet(env: Environment, name: string): Promise<number> {
  const r = (await env.cr.query<{ digits: number }>("SELECT digits FROM decimal_precision WHERE name = $1", [name])).rows[0];
  return r?.digits ?? 2;
}

/** `lang.format(fmt, value, grouping=True)` for the `%.nf` and `%d` formats. */
async function langFormat(env: Environment, value: number, digits: number): Promise<string> {
  return (await langNumber(env, (await getLang(env)).code, value, digits));
}

async function floatHtml(env: Environment, value: number, options: Options): Promise<string> {
  let minPrecision = options.get("min_precision") as number | null | undefined;
  let precision: number;
  if (options.has("decimal_precision")) precision = await precisionGet(env, String(options.get("decimal_precision")));
  else if (options.get("precision") === null || options.get("precision") === undefined) {
    precision = 6;
    if (minPrecision === null || minPrecision === undefined) minPrecision = 1;
  } else precision = Number(options.get("precision"));
  const intDigits = value !== 0 ? Math.trunc(Math.log10(Math.abs(value))) + 1 : 1;
  precision = Math.min(precision, Math.max(14 - intDigits, 0));
  let digits = precision;
  if (minPrecision !== null && minPrecision !== undefined && minPrecision < precision) {
    const dec = (Math.abs(value).toFixed(precision).split(".")[1] ?? "").replace(/0+$/, "");
    if (dec.length < minPrecision) digits = minPrecision;
    else if (dec.length < precision) digits = dec.length;
  }
  return (await langFormat(env, floatRound(value, precision), digits)).replace(/-/g, "-﻿");
}

async function dateHtml(env: Environment, value: unknown, options: Options): Promise<string> {
  if (!value) return "";
  if (options.get("format")) throw new NotPorted("date widget with a format");
  const lang = await getLang(env);
  let text = String(value);
  if (text.length < 10) return ""; // misc.py:1401-1402
  if (text.length > 10) {
    // misc.py:1403-1406: a datetime is converted to env.tz (Datetime.context_timestamp) before taking its date
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: await envTz(env), year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(`${text.slice(0, 19).replace(" ", "T")}Z`)).map((x) => [x.type, x.value]));
    text = `${p["year"]}-${p["month"]}-${p["day"]}`;
  }
  const [y, mo, d] = text.split("-").map(Number) as [number, number, number];
  return formatPosix(lang.dateFormat, { y, mo, d, h: 0, mi: 0, s: 0 }, lang.code);
}

/** ir_qweb_fields.py:293-331 `ir.qweb.field.datetime.value_to_html`: context_timestamp in env.tz (or `tz_name`), then the
 *  lang's `date_format time_format` (or one of them) through posix_to_ldml + babel. */
async function datetimeHtml(env: Environment, value: unknown, options: Options): Promise<string> {
  if (!value) return "";
  if (options.has("format")) throw new NotPorted("datetime widget with a format");
  const lang = await getLang(env);
  const tzName = options.get("tz_name");
  const tz = tzName ? String(tzName) : await envTz(env);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(`${String(value).slice(0, 19).replace(" ", "T")}Z`)).map((x) => [x.type, Number(x.value)]));
  const w = { y: p["year"]!, mo: p["month"]!, d: p["day"]!, h: p["hour"]!, mi: p["minute"]!, s: p["second"]! };
  let fmt = options.get("time_only") ? lang.timeFormat : options.get("date_only") ? lang.dateFormat : `${lang.dateFormat} ${lang.timeFormat}`;
  if (options.get("hide_seconds")) fmt = fmt.replace(":%S", ""); // pattern.replace(":ss", "") on the LDML form
  return formatPosix(fmt, w, lang.code);
}

async function monetaryHtml(env: Environment, value: unknown, options: Options): Promise<Markup> {
  const currency = options.get("display_currency");
  if (!(currency instanceof PyRecords) || currency.ids.length !== 1) throw new NotPorted("monetary widget without a display currency");
  if (typeof value !== "number" && !isPyFloat(value)) throw new Error("The value send to monetary field is not a number.");
  if (options.get("from_currency")) throw new NotPorted("monetary widget with from_currency");
  if (options.get("label_price")) throw new NotPorted("monetary widget with label_price");
  const c = (await env.cr.query<{ symbol: string | null; position: string; decimal_places: number; rounding: string }>(
    "SELECT symbol, position, decimal_places, rounding::text AS rounding FROM res_currency WHERE id = $1", [currency.ids[0]])).rows[0]!;
  const places = options.has("decimal_places") ? Number(options.get("decimal_places")) : c.decimal_places;
  let amount = num(value);
  if (Math.abs(floatRound(amount, c.decimal_places)) === 0) amount = 0;
  const rounded = Math.round(amount / Number(c.rounding)) * Number(c.rounding);
  const formatted = (await langFormat(env, floatRound(rounded, c.decimal_places), places)).replace(/ /g, " ").replace(/-/g, "-﻿");
  const pre = c.position === "before" ? `${c.symbol ?? ""} ` : "";
  const post = c.position === "before" ? "" : ` ${c.symbol ?? ""}`;
  return new Markup(`${escape(pre).toString()}<span class="oe_currency_value">${escape(formatted).toString()}</span>${escape(post).toString()}`);
}

/** `etree.tostring(body, method='html')` of the stored html (ir_qweb_fields.py:433-444) for what sanitized fields hold. */
function htmlOut(value: string): Markup {
  return new Markup(value.replace(/<(br|hr|img|input|col|meta|link)((?:\s[^<>]*?)?)\s*\/>/gi, "<$1$2>"));
}

async function contactHtml(env: Environment, value: unknown, options: Options, render: ContactRenderer): Promise<unknown> {
  if (!(value instanceof PyRecords) || value.ids.length === 0) {
    if (options.get("null_text")) throw new NotPorted("contact widget null_text");
    return "";
  }
  const fields = options.get("fields") ?? ["name", "address", "phone", "email"];
  const sep = options.get("separator");
  const opsep = sep ? escape(sep).toString() : options.get("no_tag_br") ? escape(", ").toString() : "<br/>";
  const su = new PyRecords(value.env.sudo().withContext({ ...value.env.context, show_address: true }), value.model, value.ids);
  const displayName = String((await su.field("display_name")) || "");
  const lines = displayName.split("\n");
  const address = lines.slice(1).some((l) => l.trim() !== "")
    ? new Markup(lines.slice(1).map((l) => escape(l).toString()).join(opsep).trim()) : "";
  const country = (await su.field("country_id")) as PyRecords;
  const vatLabel = country.ids.length ? await country.field("vat_label") : false;
  const scope = new Map<string, unknown>([
    ["name", lines[0]], ["address", address], ["phone", await su.field("phone")], ["city", await su.field("city")],
    ["country_id", country.ids.length ? await country.field("display_name") : false], ["website", await su.field("website")],
    ["email", await su.field("email")], ["vat", await su.field("vat")], ["vat_label", vatLabel || "VAT"], ["fields", fields],
    ["object", su], ["options", options],
  ]);
  return new Markup(await render("base.contact", scope));
}

export type ContactRenderer = (template: string, values: Map<string, unknown>) => Promise<string>;

async function valueToHtml(env: Environment, type: string, value: unknown, options: Options, render: ContactRenderer): Promise<unknown> {
  switch (type) {
    case "integer":
      return (await langFormat(env, num(value), 0)).replace(/-/g, "-﻿");
    case "float":
      return floatHtml(env, num(value), options);
    case "date":
      return dateHtml(env, value, options);
    case "datetime":
      return datetimeHtml(env, value, options);
    case "text":
      return value ? nl2br(pyStr(value)) : "";
    case "many2one": {
      if (!(value instanceof PyRecords) || value.ids.length === 0) return false;
      const shown = await new PyRecords(value.env.sudo(), value.model, value.ids).field("display_name");
      return shown ? nl2br(String(shown)) : false;
    }
    case "html":
      return htmlOut(pyStr(value));
    case "monetary":
      return monetaryHtml(env, value, options);
    case "contact":
      return contactHtml(env, value, options, render);
    case "image":
      return imageHtml(value);
    case "char": case "default": case "selection_value":
      break;
    default:
      if (type !== "char") throw new NotPorted(`ir.qweb.field.${type}`);
  }
  if (value === null || value === undefined || value === false) return "";
  if (typeof value === "object" && value !== null && "content" in value) return new TextDecoder().decode(await (value as BinaryValue).content());
  return escape(value);
}

/**
 * ir_qweb_fields.py:455-487 `ir.qweb.field.image.value_to_html` (html_editor's class adds from_html only):
 * `<img src="data:...">` of the image (`image_data_uri`, tools/image.py:569-578: the type from the base64's first
 * character). A webp converts to another format (`_get_converted_image_data_uri`) and an image Pillow would refuse
 * raises: both refuse here, the image's format being taken from its signature.
 */
async function imageHtml(value: unknown): Promise<unknown> {
  if (!(value && typeof value === "object" && "content" in value)) throw new NotPorted("ir.qweb.field.image of a value that is not binary");
  const bytes = await (value as BinaryValue).content();
  if (!bytes.length) return "";
  const head = Array.from(bytes.slice(0, 12));
  const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  const isJpeg = head[0] === 0xff && head[1] === 0xd8;
  const isGif = head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46;
  const isSvg = /^\s*(<\?xml|<svg)/.test(new TextDecoder().decode(bytes.slice(0, 64)));
  if (!(isPng || isJpeg || isGif || isSvg)) throw new NotPorted("ir.qweb.field.image of an image that is not PNG, JPEG, GIF or SVG");
  const b64 = Buffer.from(bytes).toString("base64");
  const kind = ({ "/": "jpg", R: "gif", i: "png", P: "svg+xml", U: "webp" } as Record<string, string>)[b64[0]!] ?? "png";
  return new Markup(`<img src="data:image/${kind};base64,${b64}">`);
}

/** werkzeug urls.py `url_quote(s, safe='/:')`: UTF-8, everything but alphanumerics and `_.-~/:` percent-encoded. */
function urlQuote(s: string): string {
  return Array.from(new TextEncoder().encode(s)).map((b) => {
    const c = String.fromCharCode(b);
    return /[A-Za-z0-9_.\-~/:]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}

/**
 * web ir_qweb_fields.py:100-148 `ir.qweb.field.image.record_to_html` with :20-56 `_get_src_urls` (no resize, zoom
 * or raw data option): `<img src="/web/image/<model>/<id>/<field>/<filename>?unique=<sha512(str(write_date))[:7]>"
 * class="img img-fluid..." alt="..."/>`; the srcset of an `image_<size>` field and the other options refuse.
 */
async function imageRecordHtml(record: PyRecords | PyNewRecord, name: string, options: Options): Promise<unknown> {
  if (!(record instanceof PyRecords) || record.ids.length !== 1) throw new NotPorted("ir.qweb.field.image of a new or several records");
  for (const k of ["qweb_img_raw_data", "resize", "max_width", "max_height", "zoom", "filename-field", "filename", "preview_image", "itemprop", "style", "data-no-post-process", "alt"]) {
    if (options.get(k) !== undefined && options.get(k) !== null && options.get(k) !== false) throw new NotPorted(`ir.qweb.field.image option ${k}`);
  }
  if (/_(128|256|512|1024|1920)$/.test(name) && name.startsWith("image")) throw new NotPorted("ir.qweb.field.image srcset of an image_<size> field");
  if (options.get("qweb_img_responsive") === false) throw new NotPorted("ir.qweb.field.image without qweb_img_responsive");
  const env = record.env;
  const table = record.def.table;
  // `str(record.write_date)`: Python's datetime str, microseconds only when not zero
  const wd = (await env.cr.query<{ t: string | null; us: number | null }>(
    `SELECT to_char(write_date, 'YYYY-MM-DD HH24:MI:SS') AS t, EXTRACT(MICROSECONDS FROM write_date)::int % 1000000 AS us FROM "${table}" WHERE id = $1`, [record.ids[0]])).rows[0];
  if (!wd?.t) throw new NotPorted("ir.qweb.field.image of a record without write_date (fields.Datetime.now())");
  const stamp = wd.us ? `${wd.t}.${String(wd.us).padStart(6, "0")}` : wd.t;
  const sha = createHash("sha512").update(stamp).digest("hex").slice(0, 7);
  const filename = String((await record.field("display_name")) || "name").replace(/\//g, "-").replace(/\\/g, "-").replace(/\.\./g, "--");
  const src = `/web/image/${record.model}/${record.ids[0]}/${name}/${urlQuote(filename)}?unique=${sha}`;
  const classes = ["img", "img-fluid", ...String(options.get("class") ?? "").split(/\s+/).filter(Boolean)].map((c) => escape(c)).join(" ");
  let alt: string;
  const altField = options.get("alt-field");
  const altValue = typeof altField === "string" && record.def.fields.has(altField) ? await record.field(altField) : null;
  if (altValue) alt = String(escape(altValue));
  else alt = String(escape(await record.field("display_name")));
  // `escape(value)` of a value already escaped (markupsafe's Markup) leaves it as it is: class and alt once, src once
  // `atts["width"]`, `atts["height"]` (between class and alt) when given: `escape(value)` of their str
  const size = ["width", "height"].map((k) => {
    const v = options.get(k);
    if (v === undefined || v === null) return "";
    if (typeof v !== "number" && typeof v !== "string") throw new NotPorted(`ir.qweb.field.image option ${k} of a ${typeof v}`);
    return ` ${k}="${escape(String(v))}"`;
  }).join("");
  return new Markup(`<img src="${escape(src)}" class="${classes}"${size} alt="${alt}"/>`);
}

const CONVERTERS = new Set(["integer", "float", "date", "text", "many2one", "html", "monetary", "contact", "char", "selection", "image", "datetime", "many2many", "one2many"]);

/** The `field` and `widget` hooks of the renderer for `env`; `render` renders a sub template (`base.contact`). */
export function fieldHooks(env: Environment, render: ContactRenderer): {
  field: (record: unknown, field: string, expression: string, tag: string, options: Options, values: Map<string, unknown>) => Promise<FieldRender>;
  widget: (value: unknown, expression: string, tag: string, options: Options, values: Map<string, unknown>) => Promise<FieldRender>;
} {
  return {
    field: async (record, name, _expression, _tag, options0) => {
      if (!(record instanceof PyRecords) && !(record instanceof PyNewRecord)) throw new NotPorted(`t-field on a ${typeof record}`);
      const def = record.def.fields.get(name);
      if (def === undefined) throw new NotPorted(`t-field ${record.model}.${name}`);
      const options = new Map(options0);
      const type = String(options.get("widget") ?? def.type);
      if (!CONVERTERS.has(type)) throw new NotPorted(`ir.qweb.field.${type}`);
      const attrs: Record<string, unknown> = type === "text" ? { dir: "auto" } : {};
      if (record.ids.length === 0) return { attrs, content: false, forceDisplay: false }; // record_to_html: `if not record: return False`
      if (type === "image") return { attrs, content: await imageRecordHtml(record, name, options), forceDisplay: false };
      if (type === "selection") {
        // ir_qweb_fields.py:370-380: the label of the field's selection in the environment's language
        // (`get_description(env)['selection']`), else the value
        if (options.has("selection") || def.type !== "selection" || def.selection === null) throw new NotPorted("ir.qweb.field.selection with a given or callable selection");
        const value = await record.field(name);
        if (!value) return { attrs, content: false, forceDisplay: false };
        const opt = def.selection.find((o) => o.value === value);
        const label = opt ? (opt.labels[env.lang ?? "en_US"] ?? opt.label) : value;
        return { attrs, content: escape(label || ""), forceDisplay: false };
      }
      await prepareOptions(record, def, type, options);
      // ir_qweb_fields.py:165-167 `record.with_context(**self.env.context)[field_name]`: the value in the converter's
      // context (a `t-lang` callee's language), over the record's own
      const value = record instanceof PyRecords
        ? await new PyRecords(record.env.withContext({ ...record.env.context, ...env.context }), record.model, record.ids).field(name)
        : await record.field(name);
      if (value === false) return { attrs, content: false, forceDisplay: false };
      return { attrs, content: await valueToHtml(env, type, value, options, render), forceDisplay: false };
    },
    widget: async (value, expression, _tag, options) => {
      const type = String(options.get("widget"));
      // ir_qweb.py:2908-2910: a widget without a model of its own (`string`, `char`) converts with the base
      // `ir.qweb.field` (ir_qweb_fields.py:144-155, the escaped value)
      const base = !env.reg.models.has(`ir.qweb.field.${type}`);
      if (!base && !CONVERTERS.has(type)) throw new NotPorted(`ir.qweb.field.${type}`);
      return { attrs: { "data-oe-type": type, "data-oe-expression": expression }, content: await valueToHtml(env, base ? "default" : type, value, options, render), forceDisplay: false };
    },
  };
}

/** `record_to_html` of float (247-254) and monetary (572-588): the options the field gives. */
async function prepareOptions(record: PyRecords | PyNewRecord, field: FieldDef, type: string, options: Options): Promise<void> {
  if (type === "float") {
    if (!options.has("precision") && !options.has("decimal_precision")) options.set("precision", field.digits?.[1] ?? null);
    if (!options.has("min_precision") && field.minDisplayDigits !== null && field.minDisplayDigits !== undefined) options.set("min_precision", field.minDisplayDigits);
  } else if (type === "monetary" && !options.get("display_currency")) {
    if (field.type === "monetary") {
      const name = field.currencyField ?? "currency_id";
      if (record.def.fields.has(name)) options.set("display_currency", await record.field(name));
    }
    if (!options.get("display_currency")) {
      const other = [...record.def.fields.values()].find((f) => f.type === "many2one" && f.relation === "res.currency");
      if (other) options.set("display_currency", await record.field(other.name));
    }
  }
}

