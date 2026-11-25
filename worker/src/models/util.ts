/**
 * Small Python-compatible helpers the model ports share: `repr()` of strings and tuples, `hmac` with the database
 * secret, `limited_field_access_token`, markupsafe's `escape`, `textwrap.shorten`, Odoo's date/datetime string
 * formats and the database clock (ARCHITECTURE.md: never Date.now() for anything the client sees).
 */
import { codeTranslation, codeTranslationAnyModule } from "../orm/code_translations";
import { createHash, createHmac } from "node:crypto";
import { NotPorted } from "../errors";
import { envCache } from "../orm/env";
import { icpStr } from "../session/user";
import { transactionNowUtc } from "../orm/signaling";
import type { Environment } from "../orm/types";

// --------------------------------------------------------------------------------------------------------------
// Python repr
// --------------------------------------------------------------------------------------------------------------

/** `repr(str)`: single quotes unless the text holds a single quote and no double quote (CPython unicode_repr). */
export function pyStrRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === quote || ch === "\\") out += `\\${ch}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return out + quote;
}

/** `repr()` of the tuples/strings/ints/bools/None the token messages are made of. */
export function pyRepr(v: unknown): string {
  if (typeof v === "string") return pyStrRepr(v);
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatReprSimple(v);
  if (typeof v === "boolean") return v ? "True" : "False";
  if (v === null || v === undefined) return "None";
  if (Array.isArray(v)) {
    // tuples: `(a,)` for one element, `(a, b)` otherwise
    if (v.length === 1) return `(${pyRepr(v[0])},)`;
    return `(${v.map(pyRepr).join(", ")})`;
  }
  throw new TypeError(`pyRepr: unsupported value ${String(v)}`);
}

/** `repr(float)` for the plain (non-exponent) range: ".0" on integral values, shortest round-trip otherwise. */
export function pyFloatReprSimple(n: number): string {
  if (!Number.isFinite(n)) throw new TypeError(`non-finite float ${n}`);
  const abs = Math.abs(n);
  if (abs !== 0 && (abs >= 1e16 || abs < 1e-4)) throw new NotPorted(`repr(float) with exponent for ${n}`);
  const s = String(n);
  return Number.isInteger(n) ? `${s}.0` : s;
}

// --------------------------------------------------------------------------------------------------------------
// hmac and limited field access tokens (odoo/odoo/tools/misc.py:1792, :1877)
// --------------------------------------------------------------------------------------------------------------

/** `ir.config_parameter` `database.secret` (misc.py:1805). */
export function databaseSecret(env: Environment): Promise<string> {
  return envCache(env, "models.database_secret", async () => {
    const value = await icpStr(env.cr, "database.secret");
    if (value === null || value === "") throw new Error("Non-empty secret required"); // misc.py:1812
    return value;
  });
}

/** `odoo.tools.misc.hmac(env, scope, message)`: HMAC-SHA256 of `repr((scope, message))` with the database secret. */
export async function odooHmac(env: Environment, scope: string, message: unknown): Promise<string> {
  if (scope === "") throw new Error("Non-empty scope required"); // misc.py:1803
  const secret = await databaseSecret(env);
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(Buffer.from(pyRepr([scope, message]), "utf8")).digest("hex");
}

/** `zlib.adler32(data)` (RFC 1950), as used for the token jitter (misc.py:1907). */
export function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return (b * 65536 + a) >>> 0;
}

/**
 * `limited_field_access_token(record, field_name, scope=...)` (misc.py:1877-1910): HMAC of
 * `(model, id, field, timestamp)` where the timestamp is the start of the current 14-day period plus two periods
 * plus a per-record jitter, in hex. `time.time()` is the database clock here (frozen like Odoo's, harness/clock.py).
 */
export async function limitedFieldAccessToken(env: Environment, model: string, id: number, fieldName: string, scope: string): Promise<string> {
  const uniqueStr = pyRepr([model, id, fieldName]);
  const twoWeeks = 1209600;
  const now = Math.trunc((await dbNow(env)).getTime() / 1000);
  const startOfPeriod = Math.trunc(now / twoWeeks) * twoWeeks;
  const adler32Max = 4294967295;
  // Python: `two_weeks * adler32 // adler32_max` (exact integer arithmetic, above 2^53 in the product -> BigInt)
  const jitter = Number((BigInt(twoWeeks) * BigInt(adler32(Buffer.from(uniqueStr, "utf8")))) / BigInt(adler32Max));
  const timestamp = `0x${(startOfPeriod + 2 * twoWeeks + jitter).toString(16)}`;
  const token = await odooHmac(env, scope, [model, id, fieldName, timestamp]);
  return `${token}o${timestamp}`;
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha512Hex(data: Uint8Array): string {
  return createHash("sha512").update(data).digest("hex");
}

// --------------------------------------------------------------------------------------------------------------
// Text
// --------------------------------------------------------------------------------------------------------------

/** `markupsafe.escape` (odoo.tools.misc.html_escape, misc.py:1269): `&`, `<`, `>`, `"` and `'`. */
export function htmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&#34;").replace(/'/g, "&#39;");
}

/** CPython's `string.whitespace` (textwrap._whitespace). */
const PY_WHITESPACE = "\t\n\u000b\u000c\r ";
const WS_CLASS = `[${PY_WHITESPACE.replace(/[\\\]^-]/g, "\\$&")}]`;
/** Python `\w` and `[^\d\W]` (a letter) over Unicode. */
const WORD_PUNCT = `[\\p{L}\\p{N}_!"'&.,?]`;
const LETTER = `[\\p{L}_]`;

/**
 * `textwrap.TextWrapper.wordsep_re` (CPython 3.12 textwrap.py): whitespace runs, em-dashes between words, and words
 * possibly split after a hyphen between letters. JS has no variable lookbehind on all engines, but V8 (Workers,
 * Node) supports it, so the pattern is ported literally.
 */
const WORDSEP_RE = new RegExp(
  `(${WS_CLASS}+`
  + `|(?<=${WORD_PUNCT})-{2,}(?=[\\p{L}\\p{N}_])`
  + `|[^${PY_WHITESPACE}]+?(?:`
  + `-(?:(?<=${LETTER}{2}-)|(?<=${LETTER}-${LETTER}-))(?=${LETTER}-?${LETTER})`
  + `|(?=${WS_CLASS}|$)`
  + `|(?<=${WORD_PUNCT})(?=-{2,}[\\p{L}\\p{N}_])`
  + `))`,
  "gu",
);

function splitChunks(text: string): string[] {
  // re.split with a capturing group keeps the separators; empty pieces are dropped (textwrap.py _split)
  const chunks: string[] = [];
  let last = 0;
  for (const m of text.matchAll(WORDSEP_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) chunks.push(text.slice(last, idx));
    if (m[0] !== "") chunks.push(m[0]);
    last = idx + m[0].length;
    if (m[0] === "") break; // zero-width match: the rest is one chunk
  }
  if (last < text.length) chunks.push(text.slice(last));
  return chunks.filter((c) => c !== "");
}

/**
 * `textwrap.shorten(text, width, placeholder)` (CPython 3.12 textwrap.py): collapse whitespace, then
 * `TextWrapper(width, max_lines=1, placeholder).fill()`, i.e. `_wrap_chunks` for one line: greedy chunks, long words
 * broken (`_handle_long_word`, break_long_words/break_on_hyphens), then words dropped from the end until the
 * placeholder fits. Used by `mail.thread._message_compute_subject` (mail_thread.py:3198).
 */
export function textwrapShorten(text: string, width: number, placeholder: string): string {
  const collapsed = text.trim().split(/[\t\n\u000b\u000c\r ]+/).filter((w) => w !== "").join(" ");
  if (collapsed === "") return "";
  const chunks = splitChunks(collapsed).reverse(); // consumed from the end like the Python list
  const curLine: string[] = [];
  let curLen = 0;
  while (chunks.length > 0) {
    const l = (chunks[chunks.length - 1] as string).length;
    if (curLen + l <= width) {
      curLine.push(chunks.pop() as string);
      curLen += l;
    } else break;
  }
  if (chunks.length > 0 && (chunks[chunks.length - 1] as string).length > width) {
    // _handle_long_word with break_long_words=True and break_on_hyphens=True
    const spaceLeft = width < 1 ? 1 : width - curLen;
    const chunk = chunks[chunks.length - 1] as string;
    let end = spaceLeft;
    if (chunk.length > spaceLeft) {
      const hyphen = chunk.lastIndexOf("-", spaceLeft - 1);
      if (hyphen > 0 && [...chunk.slice(0, hyphen)].some((c) => c !== "-")) end = hyphen + 1;
    }
    curLine.push(chunk.slice(0, end));
    chunks[chunks.length - 1] = chunk.slice(end);
    if (chunks[chunks.length - 1] === "") chunks.pop();
  }
  curLen = curLine.reduce((n, c) => n + c.length, 0);
  if (curLine.length > 0 && (curLine[curLine.length - 1] as string).trim() === "") {
    curLen -= (curLine[curLine.length - 1] as string).length;
    curLine.pop();
  }
  if (curLine.length === 0) return chunks.length === 0 ? "" : placeholder.trimStart();
  const onlyWhitespaceLeft = chunks.length === 1 && (chunks[0] as string).trim() === "";
  if ((chunks.length === 0 || onlyWhitespaceLeft) && curLen <= width) return curLine.join("");
  while (curLine.length > 0) {
    const last = curLine[curLine.length - 1] as string;
    if (last.trim() !== "" && curLen + placeholder.length <= width) {
      curLine.push(placeholder);
      return curLine.join("");
    }
    curLen -= last.length;
    curLine.pop();
  }
  return placeholder.trimStart();
}

// --------------------------------------------------------------------------------------------------------------
// Time and dates
// --------------------------------------------------------------------------------------------------------------

/** The database's `now()` (frozen per copy by the harness, ARCHITECTURE.md), once per request. */
export function dbNow(env: Environment): Promise<Date> {
  return envCache(env, "models.db_now", async () => {
    // the request's signaling statement reads it (src/orm/signaling.ts SEQUENCES_SQL)
    return new Date(await transactionNowUtc(env.cr));
  });
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/** `fields.Date.to_string` of a UTC instant's calendar day. */
export function dateToString(d: Date): string {
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** `fields.Datetime.to_string`: "%Y-%m-%d %H:%M:%S" of the UTC instant. */
export function datetimeToString(d: Date): string {
  return `${dateToString(d)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * `fields.Date.context_today(record)` (fields_temporal.py:141): today's date as seen in `tz` (an IANA name), of the
 * given UTC instant.
 */
export function todayInTz(nowUtc: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(nowUtc);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year").padStart(4, "0")}-${get("month")}-${get("day")}`;
}

/**
 * `fields.Datetime.context_timestamp(record, value)` (fields_temporal.py:226-244, the zone of environments.py:315
 * `env.tz`) assigned to a Date field (`.date()`): the day of a stored UTC datetime in the environment's zone, or
 * False for an empty value.
 */
export async function contextDay(env: Environment, value: unknown): Promise<string | false> {
  if (value === false || value === null || value === undefined || value === "") return false;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)) throw new NotPorted(`context_timestamp of ${JSON.stringify(value)}`);
  const { envTz } = await import("../orm/env");
  return todayInTz(new Date(`${value.slice(0, 19).replace(" ", "T")}Z`), await envTz(env));
}

/** Whether `tz` is a time zone Intl accepts (environments.py:321 falls back to UTC otherwise). */
export function validTz(tz: string | null | undefined): string | null {
  if (typeof tz !== "string" || tz === "") return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/** Days between two 'YYYY-MM-DD' dates (b - a), as `(date_b - date_a).days`. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

// --------------------------------------------------------------------------------------------------------------
// Translation of hard-coded strings (`_()`)
// --------------------------------------------------------------------------------------------------------------

/**
 * `env._(source)` for the strings the ported computes emit ("Address", "Tax ID", "Other Activities", ...). en_US is
 * the source. In another language Odoo looks the source up in the .po of the calling module and keeps it in English
 * when that module has no translation (translate.py:981-989, the module comes from the caller's frame,
 * `get_translated_module`): so `module` names the Odoo module of the ported line. Without it, or without a
 * generated table for the language (src/orm/code_translations.ts), the call refuses rather than answering English.
 */
export function translate(env: Environment, source: string, module?: string): string {
  return translateLang(env.lang, source, module);
}

/** `translate` for a language code (callers without an Environment, e.g. src/web/empty_list_help.ts). */
export function translateLang(lang: string | null, source: string, module?: string): string {
  if (lang === null || lang === "en_US") return source;
  const t = module === undefined ? codeTranslationAnyModule(lang, source) : codeTranslation(lang, module, source);
  if (t === null) throw new NotPorted(`translation of "${source}" to ${lang} (src/models/util.ts translate: ${module === undefined ? "no module given, and the text is in no module's _() or translated differently by them (gen/code_sources.py)" : "no .po table"})`);
  return t;
}

/** The language of translated jsonb columns: `env.lang` or en_US. */
export function langOf(env: Environment): string {
  return env.lang ?? "en_US";
}

/** `COALESCE(col->>lang, col->>'en_US')`: the SQL for a translated jsonb column (fields_textual.py:421). */
export function translatedSql(column: string, paramIndex: number): string {
  return `COALESCE(${column}->>$${paramIndex}, ${column}->>'en_US')`;
}

/** Python `bool()` of a value as the ORM represents it (false/null/''/0/[] are falsy). */
export function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/** Group a list of rows by a key, keeping insertion order. */
export function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list === undefined) out.set(k, [row]);
    else list.push(row);
  }
  return out;
}

/** Postgres int that `pg` may return as a string (int8) or number (int4). */
export function pgInt(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const n = Number(raw);
    if (!Number.isInteger(n)) throw new TypeError(`not an integer: ${raw}`);
    return n;
  }
  throw new TypeError(`unexpected integer value ${String(raw)}`);
}

export function uniqueInts(values: Iterable<number>): number[] {
  return [...new Set(values)];
}
