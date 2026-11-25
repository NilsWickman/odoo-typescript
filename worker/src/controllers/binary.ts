/**
 * `/web/image/...` and `/web/content/...`: `odoo/addons/web/controllers/binary.py` (content_image :153,
 * content_common :55) on top of `odoo/odoo/addons/base/models/ir_binary.py` (_find_record :24,
 * _record_to_stream :66, _get_stream_from :103, _get_image_stream_from :174, _get_placeholder_stream :308) and
 * `ir_attachment.py:1116 _to_http_stream`. The response headers come from stream.ts (stream.py get_response).
 *
 * The record's field value is read through the ORM Model API (src/orm/types.ts), so computed binaries such as
 * `avatar_128` are produced by the models stream's hooks (avatar_mixin.py); this module only serves the bytes.
 *
 * Owned by stream H2.
 */
import type { Cursor } from "../db";
import { AccessError, HttpError, MissingError, NotPorted, OdooError, UserError } from "../errors";
import type { RequestContext } from "../http/context";
import { route } from "../http/router";
import type { BinaryValue, Environment, FieldDef, ModelDef } from "../orm/types";
import { hasFieldAccess } from "../orm/sql";
import { readFileInfo } from "../filestore";
import { timingSafeEqual } from "node:crypto";
import { dbNow, odooHmac } from "../models/util";
import { hasGroup, userGroupIds } from "../session/user";
import {
  Stream, STATIC_CACHE_LONG, getExtension, guessExtension, guessMimetype, imageGuessSizeFromFieldName, imageProcess,
  isResourceModified,
} from "./stream";
import { staticFilePath, streamFromStaticPath } from "./static";

/** ir_binary.py:16 */
const DEFAULT_PLACEHOLDER_PATH = "web/static/img/placeholder.png";

// ---------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------

/** `odoo.exceptions`: UserError and its subclasses (AccessError, MissingError, ValidationError, RedirectWarning). */
function isUserError(e: unknown): e is OdooError {
  return e instanceof OdooError && [
    "odoo.exceptions.UserError", "odoo.exceptions.AccessError", "odoo.exceptions.MissingError",
    "odoo.exceptions.ValidationError", "odoo.exceptions.RedirectWarning",
  ].includes(e.odooName);
}

/** Constant-time string comparison safe for multi-byte UTF-8 inputs. */
export function consteq(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** odoo/odoo/tools/misc.py:439 `str2bool`. */
function str2bool(s: string | null, dflt: boolean): boolean {
  if (s === null || s === "") return dflt;
  const v = s.toLowerCase();
  if (["y", "yes", "1", "true", "t", "on"].includes(v)) return true;
  if (["n", "no", "0", "false", "f", "off"].includes(v)) return false;
  return dflt;
}

/** `res.users._has_group(xmlid)` (res_users.py:1214) through the HTTP stream's group helpers (session/user.ts). */
export async function userHasGroup(cr: Cursor, uid: number, xmlid: string): Promise<boolean> {
  return hasGroup(cr, await userGroupIds(cr, uid), xmlid);
}

export interface AttachmentRow {
  id: number;
  name: string | null;
  mimetype: string | null;
  checksum: string | null;
  store_fname: string | null;
  url: string | null;
  public: boolean | null;
  type: string;
  db_datas: Uint8Array | null;
  access_token: string | null;
  res_model: string | null;
  res_id: number | null;
  write_epoch: number | null;
}

export const ATTACHMENT_COLUMNS = `id, name, mimetype, checksum, store_fname, url, public, type, db_datas, access_token, res_model, res_id,
  extract(epoch from write_date)::float8 AS write_epoch`;

async function attachmentById(cr: Cursor, id: number): Promise<AttachmentRow | null> {
  const r = await cr.query<AttachmentRow>(`SELECT ${ATTACHMENT_COLUMNS} FROM ir_attachment WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

/** `ir.attachment.sudo().search([res_model, res_id, res_field], limit=1)` (ir_binary.py:82; `_order = 'id desc'`, :84). */
async function attachmentOfField(cr: Cursor, model: string, id: number, field: string): Promise<AttachmentRow | null> {
  const r = await cr.query<AttachmentRow>(
    `SELECT ${ATTACHMENT_COLUMNS} FROM ir_attachment WHERE res_model = $1 AND res_id = $2 AND res_field = $3 ORDER BY id DESC LIMIT 1`,
    [model, id, field],
  );
  return r.rows[0] ?? null;
}

function epochToDate(e: number | null): Date | null {
  return e === null ? null : new Date(e * 1000);
}

/** ir_attachment.py:1116 `_to_http_stream`. */
export async function attachmentToHttpStream(ctx: RequestContext, row: AttachmentRow): Promise<Stream> {
  const kw = {
    mimetype: row.mimetype,
    downloadName: row.name,
    etag: row.checksum,
    public: row.public === true,
  };
  if (row.store_fname !== null && row.store_fname !== "") {
    const reading = readFileInfo(ctx.env, ctx.db ?? "", row.store_fname);
    const info = await (ctx.phases ? ctx.phases.time("fs", reading) : reading);
    if (info !== null) {
      return new Stream({ kind: "data", data: info.data, lastModified: info.lastModified, ...kw });
    }
    // OSError: falls through to `self.raw.content`, which `_file_read` (:145) turns into EMPTY_BINARY
    return new Stream({ kind: "data", data: new Uint8Array(0), lastModified: epochToDate(row.write_epoch), ...kw });
  }
  if (row.url !== null && row.url !== "") {
    // Stream(type='url'): stream.py:91-100 turns a url that is a static addon file into a path stream (public)
    const sp = staticFilePath(row.url.split("?")[0] ?? "");
    if (sp !== null) {
      const stream = await streamFromStaticPath(ctx.env, sp, true);
      if (stream !== null) {
        // the url stream's own kwargs stay in `self.__dict__` only where from_path does not set them (:100)
        return stream;
      }
    }
    return new Stream({ kind: "url", url: row.url, ...kw });
  }
  return new Stream({
    kind: "data", data: row.db_datas ?? new Uint8Array(0), lastModified: epochToDate(row.write_epoch), ...kw,
  });
}

interface RecordRef {
  readonly model: string;
  readonly id: number;
  /** The environment the record is read with: sudo when `_can_return_content` allowed it (ir_binary.py:59-60). */
  readonly env: Environment;
  /** Caller's original non-sudo env for `record.sudo(False).has_field_access(field, 'read')`. */
  readonly callerEnv: Environment;
}

/** ir_binary.py:24 `_find_record`. */
async function findRecord(ctx: RequestContext, env: Environment, xmlid: string | null, model: string, id: number | null, accessToken: string | null, field: string): Promise<RecordRef> {
  const cr = ctx.cursor();
  let found: { model: string; id: number } | null = null;
  let speculative: Promise<void> | null = null;
  if (xmlid !== null && xmlid !== "") {
    // env.ref(xmlid, False): ir_model_data lookup
    const dot = xmlid.indexOf(".");
    if (dot > 0) {
      const r = await cr.query<{ model: string; res_id: number }>(
        "SELECT model, res_id FROM ir_model_data WHERE module = $1 AND name = $2", [xmlid.slice(0, dot), xmlid.slice(dot + 1)],
      );
      const row = r.rows[0];
      if (row !== undefined && env.reg.models.has(row.model)) {
        const def = env.reg.model(row.model);
        const ex = await cr.query(`SELECT 1 FROM "${def.table}" WHERE id = $1`, [row.res_id]);
        if (ex.rows.length > 0) found = { model: row.model, id: row.res_id };
      }
    }
  } else if (id !== null && env.reg.models.has(model)) {
    const def = env.reg.model(model);
    if (def.abstract || def.table === "") throw new NotPorted(`/web/image on abstract model ${model}`);
    const exists = cr.query(`SELECT 1 FROM "${def.table}" WHERE id = $1`, [id]);
    // the access check this record gets below when it exists (no token, not an attachment), sent behind the existence
    // read so that both share a round trip (C2d); for a missing record its outcome is dropped and MissingError raised
    if ((accessToken === null || accessToken === "") && model !== "ir.attachment") {
      speculative = env.model(model).checkAccess([id], "read");
      speculative.catch(() => undefined);
    }
    if ((await exists).rows.length > 0) found = { model, id };
  }
  if (found === null) {
    if (speculative !== null) await speculative.catch(() => undefined);
    // ir_binary.py:51: `res_id=id` is the builtin, hence its repr in the message
    throw new MissingError(`No record found for xmlid=${xmlid ?? "None"}, res_model=${model}, id=<built-in function id>`);
  }
  // ir_binary.py:58: a limited field access token of this record and field (scope "binary") grants sudo
  if (accessToken !== null && accessToken !== "" && await verifyLimitedFieldAccessToken(env, found.model, found.id, field, accessToken, "binary")) {
    return { ...found, env: env.sudo(), callerEnv: env };
  }
  if (accessToken !== null && accessToken !== "") {
    if (found.model !== "ir.attachment") {
      // verify_limited_field_access_token (tools/misc.py): hmac with the database secret
      throw new NotPorted("access_token on a non-attachment binary (limited field access token)");
    }
    // ir_attachment.py:1157-1160 _can_return_content with a token: consteq with the row's token else AccessError
    const row = await attachmentById(cr, found.id);
    if (row === null || !row.access_token || !consteq(row.access_token, accessToken)) throw new AccessError("Invalid access token");
    return { ...found, env: env.sudo(), callerEnv: env };
  }
  // _can_return_content (models.py:5317 returns False; ir_attachment.py:1157 overrides)
  if (found.model === "ir.attachment") {
    const row = await attachmentById(cr, found.id);
    if (row !== null && row.public === true) return { ...found, env: env.sudo(), callerEnv: env };
    if (await userHasGroup(cr, env.uid, "base.group_portal")) {
      await env.model(found.model).checkAccess([found.id], "read");
      return { ...found, env: env.sudo(), callerEnv: env };
    }
  }
  await (speculative ?? env.model(found.model).checkAccess([found.id], "read"));
  return { ...found, env, callerEnv: env };
}

function fieldOf(def: ModelDef, name: string): FieldDef | null {
  return def.fields.get(name) ?? null;
}

function isBinaryValue(v: unknown): v is BinaryValue {
  return typeof v === "object" && v !== null && "checksum" in v && "content" in v
    && typeof (v as { content: unknown }).content === "function";
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The field value as bytes with its checksum (BinaryValue.checksum: sha1 for attachment-backed values,
 * sha256 for in-memory bytes, tools/binary.py:69-72). Accepts what the ORM may hand over for a binary: a
 * BinaryValue (src/orm/types.ts:20), a base64 string (Odoo's read() format), raw bytes, or false/null.
 */
async function binaryOf(value: unknown): Promise<{ data: Uint8Array; checksum: string } | null> {
  if (value === false || value === null || value === undefined || value === "") return null;
  if (isBinaryValue(value)) {
    const data = await value.content();
    return { data, checksum: value.checksum };
  }
  if (value instanceof Uint8Array) return { data: value, checksum: await sha256Hex(value) };
  if (typeof value === "string") {
    const data = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    return { data, checksum: await sha256Hex(data) };
  }
  throw new NotPorted(`binary field value of type ${typeof value}`);
}

/** ir_binary.py:66 `_record_to_stream`. */
async function recordToStream(ctx: RequestContext, rec: RecordRef, fieldName: string): Promise<Stream> {
  const cr = ctx.cursor();
  const def = rec.env.reg.model(rec.model);
  if (rec.model === "ir.attachment" && (fieldName === "raw" || fieldName === "db_datas")) {
    const row = await attachmentById(cr, rec.id);
    if (row === null) throw new MissingError("Record does not exist or has been deleted.");
    return attachmentToHttpStream(ctx, row);
  }
  const field = fieldOf(def, fieldName);
  if (field !== null && field.attachment) {
    // :75-87: a stored binary with attachment=True resolves to its ir_attachment row
    const row = await attachmentOfField(cr, rec.model, rec.id, fieldName);
    if (row !== null) return attachmentToHttpStream(ctx, row);
    // no row: the field is empty, `value` is falsy and the data branch below sends b''
  }
  const isBinary = field !== null && (field.type === "binary" || field.type === "image");
  const fields = isBinary ? ["id"] : [fieldName];
  if (def.logAccess) fields.push("write_date");
  const rows = await rec.env.model(rec.model).read([rec.id], fields);
  const values = rows[0];
  if (values === undefined) throw new MissingError("Record does not exist or has been deleted.");
  const bin = await binaryOf(isBinary ? await rec.env.model(rec.model).binaryValue(rec.id, fieldName) : values[fieldName]);
  const data = bin?.data ?? new Uint8Array(0);
  const wd = values["write_date"];
  const lastModified = def.logAccess && typeof wd === "string" && wd !== "" ? new Date(`${wd.replace(" ", "T")}Z`) : null;
  return new Stream({
    kind: "data",
    data,
    etag: bin?.checksum ?? await sha256Hex(data),
    lastModified,
    public: await userHasGroup(cr, rec.env.uid, "base.group_public"), // record.env.user._is_public()
  });
}

/** Python `s[:100]` counts code points. */
function sliceCodePoints(s: string, n: number): string {
  return Array.from(s).slice(0, n).join("");
}

/** ir_binary.py:103 `_get_stream_from`. */
async function getStreamFrom(ctx: RequestContext, rec: RecordRef, fieldName: string, filename: string | null, filenameField: string | null, mimetype: string | null, defaultMimetype = "application/octet-stream", forImage = false): Promise<Stream> {
  const def = rec.env.reg.model(rec.model);
  const field = fieldOf(def, fieldName);
  if (field === null) throw new UserError(`Record has no field “${fieldName}”`);
  if (field.type !== "binary" && field.type !== "image") {
    throw new UserError(`Field “${field.name}” is type “${field.type}” but it is only possible to stream Binary or Image fields.`);
  }
  const stream = await recordToStream(ctx, rec, fieldName);
  if (stream.kind === "data") {
    if (mimetype !== null && mimetype !== "") {
      stream.mimetype = mimetype;
    } else if (stream.mimetype === null || stream.mimetype === "") {
      const guessed = guessMimetype(stream.data);
      if (guessed === null) {
        // libmagic answers something for every input; the image route maps every non image/* answer to
        // application/octet-stream anyway (ir_binary.py:276), so only /web/content cannot proceed.
        if (!forImage) throw new NotPorted("guess_mimetype (libmagic) of data with no known signature");
        stream.mimetype = defaultMimetype;
      } else {
        stream.mimetype = guessed;
      }
    }
    if (filename !== null && filename !== "") {
      stream.downloadName = filename;
    } else if (filenameField !== null) {
      const fnField = def.fields.get(filenameField);
      if (fnField !== undefined && await hasFieldAccess(rec.callerEnv, fnField)) {
        const rows = await rec.env.model(rec.model).read([rec.id], [filenameField]);
        const v = rows[0]?.[filenameField];
        stream.downloadName = typeof v === "string" && v !== "" ? v : null;
      }
    }
    finalizeDownloadName(stream, `${def.table}-${rec.id}-${fieldName}`);
  }
  return stream;
}

/** ir_binary.py:163-170: default name, newline cleanup, 100 chars, extension from the name or the mimetype. */
function finalizeDownloadName(stream: Stream, fallback: string): void {
  if (stream.downloadName === null || stream.downloadName === "") stream.downloadName = fallback;
  let name = stream.downloadName.replace(/\n/g, "_").replace(/\r/g, "_");
  const ext = getExtension(name);
  if (ext !== "" && name.endsWith(ext)) name = name.slice(0, name.length - ext.length);
  name = sliceCodePoints(name, 100) + (ext !== "" ? ext : (guessExtension(stream.mimetype ?? "application/octet-stream") ?? ""));
  stream.downloadName = name;
}

/**
 * `ir.binary._get_stream_from(attachment, 'raw', filename)` for a row already fetched (used by /web/assets,
 * binary.py:119 and :146): `_to_http_stream`, the attachment's mimetype (guessed from the bytes when unset),
 * `filename` or the row's name, then the extension rule.
 */
export async function attachmentStream(ctx: RequestContext, row: AttachmentRow, filename: string | null): Promise<Stream> {
  const stream = await attachmentToHttpStream(ctx, row);
  if (stream.kind === "data") {
    if (stream.mimetype === null || stream.mimetype === "") {
      const guessed = guessMimetype(stream.data);
      if (guessed === null) throw new NotPorted("guess_mimetype (libmagic) of attachment data with no known signature");
      stream.mimetype = guessed;
    }
    if (filename !== null && filename !== "") stream.downloadName = filename;
    else if (stream.downloadName === null) stream.downloadName = row.name;
    finalizeDownloadName(stream, `ir_attachment-${row.id}-raw`);
  }
  return stream;
}

/** ir_binary.py:308 `_get_placeholder_stream` (Stream.from_path with filter_ext png/jpg, public=False). */
async function placeholderStream(ctx: RequestContext, path: string): Promise<Stream> {
  const p = path === "" ? DEFAULT_PLACEHOLDER_PATH : path;
  if (!/\.(png|jpg)$/i.test(p)) throw new HttpError(404, "placeholder must be png or jpg");
  const stream = await streamFromStaticPath(ctx.env, `/${p}`, false);
  if (stream === null) throw new HttpError(404, `placeholder ${p} not found in static assets`);
  return stream;
}

interface ImageOptions {
  filename: string | null;
  filenameField: string | null;
  mimetype: string | null;
  width: number;
  height: number;
  /** The raw `crop` query value (Odoo formats it with f-strings: `crop=False` when absent). */
  crop: string | null;
  downloadAttachments: boolean;
}

/** ir_binary.py:174 `_get_image_stream_from` (quality is always 0 from the controller). */
async function getImageStreamFrom(ctx: RequestContext, rec: RecordRef, fieldName: string, o: ImageOptions): Promise<Stream> {
  let stream: Stream | null = null;
  try {
    stream = await getStreamFrom(ctx, rec, fieldName, o.filename, o.filenameField, o.mimetype, "application/octet-stream", true);
  } catch (e) {
    if (!isUserError(e) || o.downloadAttachments) throw e;
  }
  if (stream === null || (stream.kind === "data" && stream.size === 0)) {
    // record._get_placeholder_filename(field) is False for every installed model (models.py:6518; the overrides
    // live in product, onboarding and website_slides, not installed in poc_corpus)
    stream = await placeholderStream(ctx, "");
  }
  if (stream.kind === "url") return stream;
  if (stream.mimetype === null || !stream.mimetype.startsWith("image/")) stream.mimetype = "application/octet-stream";
  let [width, height] = [o.width, o.height];
  if (width === 0 && height === 0) [width, height] = imageGuessSizeFromFieldName(fieldName);
  const crop = o.crop ?? "False"; // f'{crop}' of the Python default False
  if (stream.etag !== null) stream.etag += `-${width}x${height}-crop=${crop}-quality=0`;
  const modified = isResourceModified(ctx.request.headers, stream.etag, stream.lastModified);
  if (modified && (width !== 0 || height !== 0 || o.crop !== null)) {
    stream.data = await imageProcess(stream.data, width, height, o.crop, 0);
  }
  return stream;
}

// ---------------------------------------------------------------------------------------------------------
// controllers
// ---------------------------------------------------------------------------------------------------------

function intParam(params: Record<string, string>, name: string): number | null {
  const v = params[name];
  if (v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new HttpError(404, "Not Found");
  return n;
}

function parseQueryId(raw: string | null): number | null {
  if (raw === null || raw === "") return null;
  if (!/^\d+$/.test(raw)) throw new HttpError(404, "Not Found");
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(404, "Not Found");
  return n;
}

function queryParam(ctx: RequestContext, name: string): string | null {
  return ctx.url.searchParams.get(name);
}

/** The controller's keyword arguments: path converters override query parameters (dispatcher.py:244). */
function kw(ctx: RequestContext, params: Record<string, string>, name: string): string | null {
  return params[name] ?? queryParam(ctx, name);
}

/** binary.py:170 `content_image`. */
async function contentImage(ctx: RequestContext, params: Record<string, string>): Promise<Response> {
  const env = await ctx.orm();
  const xmlid = kw(ctx, params, "xmlid");
  const model = kw(ctx, params, "model") ?? "ir.attachment";
  const id = intParam(params, "id") ?? parseQueryId(queryParam(ctx, "id"));
  const field = kw(ctx, params, "field") ?? "raw";
  const filenameField = kw(ctx, params, "filename_field") ?? "name";
  const filename = kw(ctx, params, "filename");
  const mimetype = kw(ctx, params, "mimetype");
  const unique = kw(ctx, params, "unique");
  const download = str2bool(queryParam(ctx, "download"), false);
  let width = Number(kw(ctx, params, "width") ?? 0);
  let height = Number(kw(ctx, params, "height") ?? 0);
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw new HttpError(400, "Bad Request");
  const crop = queryParam(ctx, "crop");
  const accessToken = queryParam(ctx, "access_token");
  const nocache = queryParam(ctx, "nocache");

  let stream: Stream;
  try {
    const rec = await findRecord(ctx, env, xmlid, model, id, accessToken, field);
    stream = await getImageStreamFrom(ctx, rec, field, {
      filename, filenameField, mimetype, width, height, crop, downloadAttachments: download,
    });
    if (accessToken !== null && accessToken !== "") stream.public = true;
  } catch (e) {
    if (!isUserError(e)) throw e;
    if (download) throw new HttpError(404, "Not Found");
    // binary.py:193-200: the placeholder with the requested field's ratio
    if (width === 0 && height === 0) [width, height] = imageGuessSizeFromFieldName(field);
    const placeholder = await placeholderRecord(ctx, env);
    stream = await getImageStreamFrom(ctx, placeholder, "raw", {
      filename: null, filenameField: "name", mimetype: null, width, height, crop, downloadAttachments: download,
    });
    stream.public = false;
  }
  const opts: { asAttachment: boolean; immutable?: boolean; maxAge?: number | null } = { asAttachment: download };
  if (unique !== null && unique !== "") { opts.immutable = true; opts.maxAge = STATIC_CACHE_LONG; }
  if (nocache !== null && nocache !== "") opts.maxAge = null;
  return stream.getResponse(ctx.request, opts);
}

/** `request.env.ref('web.image_placeholder').sudo()` (binary.py:197): the url attachment of web/data/ir_attachment.xml. */
async function placeholderRecord(ctx: RequestContext, env: Environment): Promise<RecordRef> {
  const r = await ctx.cursor().query<{ res_id: number }>(
    "SELECT res_id FROM ir_model_data WHERE module = 'web' AND name = 'image_placeholder' AND model = 'ir.attachment'",
  );
  const row = r.rows[0];
  if (row === undefined) throw new HttpError(404, "web.image_placeholder missing");
  return { model: "ir.attachment", id: row.res_id, env: env.sudo(), callerEnv: env };
}

/** binary.py:55 `content_common`. */
async function contentCommon(ctx: RequestContext, params: Record<string, string>): Promise<Response> {
  const env = await ctx.orm();
  const xmlid = kw(ctx, params, "xmlid");
  const model = kw(ctx, params, "model") ?? "ir.attachment";
  const id = intParam(params, "id") ?? parseQueryId(queryParam(ctx, "id"));
  const field = kw(ctx, params, "field") ?? "raw";
  const filenameField = kw(ctx, params, "filename_field") ?? "name";
  const filename = kw(ctx, params, "filename");
  const mimetype = kw(ctx, params, "mimetype");
  const unique = queryParam(ctx, "unique");
  const download = str2bool(queryParam(ctx, "download"), false);
  const accessToken = queryParam(ctx, "access_token");
  const nocache = queryParam(ctx, "nocache");

  let stream: Stream;
  try {
    const rec = await findRecord(ctx, env, xmlid, model, id, accessToken, field);
    stream = await getStreamFrom(ctx, rec, field, filename, filenameField, mimetype);
    if (accessToken !== null && accessToken !== "") stream.public = true;
  } catch (e) {
    // replace_exceptions(UserError, by=request.not_found())
    if (isUserError(e)) throw new HttpError(404, "Not Found");
    throw e;
  }
  const opts: { asAttachment: boolean; immutable?: boolean; maxAge?: number | null } = { asAttachment: download };
  if (unique !== null && unique !== "") { opts.immutable = true; opts.maxAge = STATIC_CACHE_LONG; }
  if (nocache !== null && nocache !== "") opts.maxAge = null;
  return stream.getResponse(ctx.request, opts);
}

// Registration order reproduces werkzeug's rule priority (verified against werkzeug 3.0.1 Map.match for the
// routes of binary.py:153-171 and :45-53): more path parts first, int converters before string ones.
route([
  "/web/image/<string:model>/<int:id>/<string:field>/<int:width>x<int:height>/<string:filename>",
  "/web/image/<int:id>-<string:unique>/<int:width>x<int:height>/<string:filename>",
  "/web/image/<string:xmlid>/<int:width>x<int:height>/<string:filename>",
  "/web/image/<string:model>/<int:id>/<string:field>/<int:width>x<int:height>",
  "/web/image/<string:model>/<int:id>/<string:field>/<string:filename>",
  "/web/image/<int:id>-<string:unique>/<int:width>x<int:height>",
  "/web/image/<int:id>/<int:width>x<int:height>/<string:filename>",
  "/web/image/<int:id>-<string:unique>/<string:filename>",
  "/web/image/<string:xmlid>/<int:width>x<int:height>",
  "/web/image/<string:model>/<int:id>/<string:field>",
  "/web/image/<int:id>/<int:width>x<int:height>",
  "/web/image/<int:id>/<string:filename>",
  "/web/image/<string:xmlid>/<string:filename>",
  "/web/image/<int:id>-<string:unique>",
  "/web/image/<int:id>",
  "/web/image/<string:xmlid>",
  "/web/image",
], contentImage, { auth: "public", readonly: true, saveSession: false });

route([
  "/web/content/<string:model>/<int:id>/<string:field>/<string:filename>",
  "/web/content/<string:model>/<int:id>/<string:field>",
  "/web/content/<int:id>/<string:filename>",
  "/web/content/<string:xmlid>/<string:filename>",
  "/web/content/<int:id>",
  "/web/content/<string:xmlid>",
  "/web/content",
], contentCommon, { auth: "public", readonly: true });

/** tools/misc.py:1913 `verify_limited_field_access_token`: same token for the token's own timestamp, not expired. */
export async function verifyLimitedFieldAccessToken(env: Environment, model: string, id: number, field: string, token: string, scope: string): Promise<boolean> {
  const i = token.lastIndexOf("o");
  if (i < 0) return false;
  const timestamp = token.slice(i + 1);
  if (!/^0x[0-9a-f]+$/.test(timestamp)) return false;
  const expected = `${await odooHmac(env, scope, [model, id, field, timestamp])}o${timestamp}`;
  if (!consteq(expected, token)) return false;
  return (await dbNow(env)).getTime() / 1000 < parseInt(timestamp.slice(2), 16);
}
