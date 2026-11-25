/**
 * Writes of `image.mixin` image fields (odoo/odoo/addons/base/models/image_mixin.py:12-18): `image_1920` is processed
 * by `Image._image_process` (fields_binary.py:344-387, `image_process(value, size=(1920, 1920),
 * verify_resolution=True)`), stored as its attachment (Binary attachment write: the existing `ir.attachment` of
 * (res_model, res_field, res_id) gets the new `raw`, else one is created, as superuser), and the stored related
 * `image_1024/512/256/128` follow (`_process_related` -> `_image_process` with their sizes, from the processed
 * `image_1920`). The processing runs in src/image/odoo-image.wasm, byte for byte Odoo's Pillow (src/image/process.ts).
 *
 * Refused: clearing an image that has an attachment, other image fields, values that are not base64 strings, and models where another
 * stored computed field depends on the image fields (product.template `can_image_1024_be_zoomed`, ...).
 */
import { createHash } from "node:crypto";
import { NotPorted, UserError } from "../errors";
import { writeFile } from "../filestore";
import { imageProcess } from "../image/wasm-process";
import { requestOfCursor } from "../http/context";
import type { Environment, FieldDef, ModelDef } from "./types";
import { DbRec } from "./recompute";
import type { BinaryValue } from "./types";
import { binaryBytes } from "./values";
import { hasGroup } from "./env";

/** image_mixin.py:12-18: the image.mixin fields and their max sizes; the smaller ones are related to image_1920. */
export const IMAGE_MIXIN_SIZES: Readonly<Record<string, number>> = {
  image_1920: 1920, image_1024: 1024, image_512: 512, image_256: 256, image_128: 128,
};

/** Whether `field` is the writable image.mixin source field handled here. */
export function isImageMixinSource(def: ModelDef, field: FieldDef): boolean {
  // Image fields have ttype 'binary' in ir_model_fields: image.mixin is recognised by its five fields
  const isBinary = (f: FieldDef): boolean => f.type === "image" || f.type === "binary";
  if (!isBinary(field) || !field.attachment || field.name !== "image_1920" || field.related !== null) return false;
  for (const [name, size] of Object.entries(IMAGE_MIXIN_SIZES)) {
    if (name === "image_1920") continue;
    const f = def.fields.get(name);
    if (!f || !isBinary(f) || f.related !== "image_1920" || !f.store || !f.attachment || size <= 0) return false;
  }
  return true;
}

/**
 * guess_mimetype (odoo/tools/mimetypes.py) for the two formats the image module produces and an SVG passed through
 * (mimetypes.py:270-271 `is_svg`). ir_attachment.py:546-555 `_check_contents` stores an xml-like type as text/plain for
 * a user who may not write views: not ported (refused).
 */
async function mimetypeOf(env: Environment, data: Uint8Array): Promise<string> {
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
  const text = Buffer.from(data).toString("latin1");
  if (data[0] === 0x3c && text.includes("<svg") && text.includes("/svg")) {
    if (env.context["attachments_mime_plainxml"] || !(await hasGroup(env, "base.group_system"))) {
      throw new NotPorted("an SVG image stored as text/plain (ir_attachment _check_contents of a user who may not write views)");
    }
    return "image/svg+xml";
  }
  throw new NotPorted("mimetype of a processed image");
}

function rememberWritten(env: Environment, key: string, value: BinaryValue): void {
  let written = env.cache.get("orm.binaryWritten") as Map<string, unknown> | undefined;
  if (!written) { written = new Map(); env.cache.set("orm.binaryWritten", written); }
  written.set(key, value);
}

/** fields_binary.py Binary attachment write (as superuser): update the field's attachment raw, or create it. */
export async function storeAttachment(env: Environment, model: string, field: string, id: number, data: Uint8Array, name: string = field): Promise<void> {
  const ctx = requestOfCursor(env.cr);
  const db = ctx?.db ?? null;
  if (ctx === null || db === null) throw new NotPorted("image field write outside a request");
  if ((await env.cr.query(`SELECT 1 FROM ir_config_parameter WHERE key = 'ir_attachment.location' AND value != 'file'`)).rows.length) {
    throw new NotPorted("database attachment storage");
  }
  // ir_attachment.py:424 `_get_datas_related_values`, :140 `_file_fname`, :561 `_index` (False for images)
  const checksum = createHash("sha1").update(data).digest("hex");
  const storeFname = `${checksum.slice(0, 2)}/${checksum}`;
  const mimetype = await mimetypeOf(env, data);
  await writeFile(ctx.env, db, storeFname, data);
  // the cache holds the written value for the rest of the transaction (src/models/binary.ts attachmentValues)
  rememberWritten(env, `${model},${field},${id}`, binaryBytes(data));
  const existing = (await env.cr.query<{ id: number }>(
    "SELECT id FROM ir_attachment WHERE res_model = $1 AND res_field = $2 AND res_id = $3 ORDER BY id", [model, field, id])).rows;
  if (existing.length > 1) throw new NotPorted(`several attachments for ${model}.${field} of record ${id}`);
  if (existing.length === 1) {
    await env.cr.query(
      `UPDATE ir_attachment SET checksum = $2, file_size = $3, mimetype = $4, store_fname = $5, db_datas = NULL, index_content = NULL,
         write_uid = $6, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1`,
      [existing[0]!.id, checksum, data.length, mimetype, storeFname, env.uid]);
  } else {
    await env.cr.query(
      `INSERT INTO ir_attachment (name, res_model, res_field, res_id, company_id, type, mimetype, file_size, checksum, store_fname,
         create_uid, write_uid, create_date, write_date)
       VALUES ($1, $2, $10, $3, $4, 'binary', $5, $6, $7, $8, $9, $9, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')`,
      [name, model, id, await env.company(), mimetype, data.length, checksum, storeFname, env.uid, field]);
  }
}

/** The field at the end of a related path (fields.py `related_field`), or null when the path does not resolve. */
function relatedFieldOf(env: Environment, def: ModelDef, path: string): FieldDef | null {
  let cur: ModelDef = def;
  const parts = path.split(".");
  for (let i = 0; i < parts.length; i++) {
    const f = cur.fields.get(parts[i]!);
    if (!f) return null;
    if (i === parts.length - 1) return f;
    if (!f.relation) return null;
    cur = env.reg.model(f.relation);
  }
  return null;
}

/**
 * fields_binary.py:344-387 `Image._image_process` of the bytes of a value, with the field's size from the registry
 * (gen/models.py `image`): a readonly field without a size, or related to an Image field of the same size, keeps the
 * value as it is (:345-354); a WEBP refuses (its resized attachment, :358-380); else `image_process(size=(max_width,
 * max_height), verify_resolution=...)` (tools/image.py:289-324), whose early return (:303) keeps the source when
 * nothing is asked.
 */
export function imageFieldProcess(env: Environment, def: ModelDef, field: FieldDef, source: Uint8Array): Uint8Array {
  const spec = field.image;
  if (!spec) throw new NotPorted(`${def.name}.${field.name} is not an Image field in the registry`);
  if (field.readonly) {
    if (!spec.maxWidth && !spec.maxHeight) return source;
    const rel = field.related ? relatedFieldOf(env, def, field.related) : null;
    if (rel?.image && rel.image.maxWidth === spec.maxWidth && rel.image.maxHeight === spec.maxHeight) return source;
  }
  if (!source.length) return source;
  // image.py:83 an SVG (or any XML) source is not processed: `image_quality` gives the source back
  if (source[0] === 0x3c) return source;
  if (source.length >= 15 && String.fromCharCode(...source.slice(0, 4)) === "RIFF" && String.fromCharCode(...source.slice(8, 15)) === "WEBPVP8") {
    throw new NotPorted(`${def.name}.${field.name} of a webp image (its resized attachment)`);
  }
  if (!spec.maxWidth && !spec.maxHeight && !spec.verifyResolution) return source;
  return imageProcess(source, spec.maxWidth, spec.maxHeight, { verifyResolution: spec.verifyResolution });
}

/**
 * fields_binary.py:389-396 `Image._process_related`: the related value through `_image_process`, False when that
 * raises a UserError (an image Odoo cannot decode, or above the resolution limit).
 */
export function imageRelatedProcess(env: Environment, def: ModelDef, field: FieldDef, source: Uint8Array): Uint8Array | null {
  try {
    return imageFieldProcess(env, def, field, source);
  } catch (e) {
    if (e instanceof UserError) return null;
    throw e;
  }
}

/** The stored related Image fields of the same model that follow `field` (`related='<field>'`), in field order. */
function sameModelRelated(def: ModelDef, field: FieldDef): FieldDef[] {
  return [...def.fields.values()].filter((g) => g.image && g.related === field.name && g.store && g.attachment);
}

/**
 * A stored `fields.Image` outside image.mixin (src/orm/image_write.ts writeImageMixin), from the registry: its create
 * processes the value (fields_binary.py:305-315 `create` -> `_image_process`) and stores it as its attachment; the
 * stored related Image fields of the model that follow it are resized from it (`_process_related`).
 */
export function isProcessedImage(def: ModelDef, field: FieldDef): boolean {
  return Boolean(field.image) && field.attachment && field.store && field.related === null && !field.compute && !isImageMixinSource(def, field);
}

/** The stored related images of the processed Image fields given a value in `vals` (stored by createProcessedImage, not by the queue). */
export function processedImageRelated(def: ModelDef, vals: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(vals)) {
    const f = def.fields.get(name);
    if (value && f && isProcessedImage(def, f)) out.push(...sameModelRelated(def, f).map((g) => g.name));
  }
  return out;
}

/** The value of such a field at a record's create: the processed image and its related images, as attachments. */
export async function createProcessedImage(env: Environment, def: ModelDef, field: FieldDef, id: number, value: unknown): Promise<void> {
  if (typeof value !== "string") throw new NotPorted(`${def.name}.${field.name} value that is not base64`);
  const source = new Uint8Array(Buffer.from(value, "base64"));
  const processed = imageFieldProcess(env, def, field, source);
  // Binary.create (fields_binary.py:160-175): no attachment for a falsy value
  if (!processed.length) return;
  await storeAttachment(env, def.name, field.name, id, processed);
  // the stored related images are computed at the next flush (the recompute of `_process_related`), after every
  // record created until then: queued inside a window that flushes them (a module data file, withProcessedImages)
  const related = sameModelRelated(def, field);
  if (!related.length) return;
  const key = requestOfCursor(env.cr) ?? env.cr;
  const queue = PENDING.get(key);
  if (!queue) throw new NotPorted(`${def.name}.${field.name} created outside a window that flushes its related images`);
  for (const r of related) queue.push({ env, def, field: r, id, data: processed });
}

/** A related image left to the flush: `size` an image.mixin size of the record's processed image_1920 (`data`), else
 *  the `_process_related` of a processed Image field's value. */
interface PendingImage { env: Environment; def: ModelDef; field: FieldDef; id: number; data: Uint8Array; size?: number }
const PENDING = new WeakMap<object, PendingImage[]>();
/** The windows of a module data file's load (image.mixin's sizes wait for the flush there too). */
const DATA_FILE = new WeakSet<object>();

/** Opens the window of queued related images for the cursor (idempotent): a data file's load (`dataFile`),
 *  withProcessedImages. */
export function openProcessedImages(env: Environment, dataFile = false): void {
  const key = requestOfCursor(env.cr) ?? env.cr;
  if (!PENDING.has(key)) PENDING.set(key, []);
  if (dataFile) DATA_FILE.add(key);
}

/**
 * The related images queued by createProcessedImage and writeImageMixin, stored as the flush's recompute does
 * (environments.py:398-408 `_recompute_all`: field by field in the order they were first marked to compute since the
 * last flush, each over its records in the order they were marked; measured on Odoo with lunch's data: categories
 * 1-4 image_1024, then their image_512, ...); the window stays open.
 */
export async function flushProcessedImages(env: Environment): Promise<void> {
  const queue = PENDING.get(requestOfCursor(env.cr) ?? env.cr);
  if (!queue?.length) return;
  const items = queue.splice(0);
  const byField = new Map<string, PendingImage[]>();
  for (const q of items) {
    const k = `${q.def.name}.${q.field.name}`;
    (byField.get(k) ?? byField.set(k, []).get(k)!).push(q);
  }
  for (const group of byField.values()) {
    for (const q of group) {
      const data = q.size !== undefined ? imageProcess(q.data, q.size, q.size) : imageRelatedProcess(q.env, q.def, q.field, q.data);
      if (data?.length) await storeAttachment(q.env, q.def.name, q.field.name, q.id, data);
    }
  }
}

/** Whether a data file's window is open on the cursor: image.mixin's sizes of the records it creates are queued. */
function dataFileWindow(env: Environment): PendingImage[] | null {
  const key = requestOfCursor(env.cr) ?? env.cr;
  return DATA_FILE.has(key) ? PENDING.get(key) ?? null : null;
}

/**
 * Binary.write of a stored attachment field from the recompute of a related field (fields_binary.py:177-226, the
 * protected records of fields.py `__set__`): the record's attachment gets the new raw value, or is created; nothing
 * of the record's own row is written. Clearing a value that has an attachment refuses (its unlink).
 */
export async function writeRecomputedAttachment(env: Environment, def: ModelDef, field: FieldDef, id: number, value: unknown): Promise<void> {
  if (value === null || value === false) {
    const existing = await env.cr.query("SELECT 1 FROM ir_attachment WHERE res_model = $1 AND res_field = $2 AND res_id = $3", [def.name, field.name, id]);
    if (existing.rows.length) throw new NotPorted(`clearing the attachment of ${def.name}.${field.name} (its unlink)`);
    return;
  }
  const content = await (value as BinaryValue).content();
  if (!content.length) throw new NotPorted(`${def.name}.${field.name}: an empty binary value`);
  await storeAttachment(env, def.name, field.name, id, content);
}

const DEPTH = new WeakMap<object, number>();

/**
 * Runs `fn` with the window open, then flushes what it queued. Nested, only the outermost flushes: payment_custom's
 * post_init sets up two providers, and Odoo stores the copies' related images after both (measured, vagb_pay_custom_form).
 */
export async function withProcessedImages<T>(env: Environment, fn: () => Promise<T>): Promise<T> {
  const key = requestOfCursor(env.cr) ?? env.cr;
  openProcessedImages(env);
  DEPTH.set(key, (DEPTH.get(key) ?? 0) + 1);
  let out: T;
  try {
    out = await fn();
  } finally {
    DEPTH.set(key, DEPTH.get(key)! - 1);
  }
  if (DEPTH.get(key) === 0) await flushProcessedImages(env);
  return out;
}

/** The companies' fields that follow their partner's image_1920 (`logo_web`, `uses_default_logo`), set by
 * src/models/company_create.ts; called with the processed image_1920 bytes. */
type CompanyLogoHook = (env: Environment, companies: readonly number[], image1920: Uint8Array) => Promise<void>;
let companyLogoHook: CompanyLogoHook | null = null;
export function registerCompanyLogoHook(fn: CompanyLogoHook): void { companyLogoHook = fn; }

const IMAGE_SIZE_FIELDS = ["image_1024", "image_512", "image_256", "image_128"];

/**
 * The sizes a web_save reads after its create, per cursor and model: Odoo computes the stored related sizes of a new
 * record lazily, the ones the specification reads first (models.py `fetch` -> `_recompute_model(fnames)`, avatar_N
 * through image_N), the others at the request's flush in field order. Their attachments are created in that order.
 */
const READ_FIRST = new WeakMap<object, Map<string, readonly string[]>>();
export async function withImageReadOrder<T>(env: Environment, model: string, spec: readonly string[], fn: () => Promise<T>): Promise<T> {
  const first: string[] = [];
  for (const k of spec) {
    const size = k.startsWith("avatar_") ? `image_${k.slice(7)}` : k;
    if (IMAGE_SIZE_FIELDS.includes(size) && !first.includes(size)) first.push(size);
  }
  const m = READ_FIRST.get(env.cr) ?? new Map<string, readonly string[]>();
  READ_FIRST.set(env.cr, m);
  m.set(model, first);
  try {
    return await fn();
  } finally {
    m.delete(model);
  }
}

/** The sizes the running web_save of `model` reads first (withImageReadOrder), none outside one. */
export function imageReadFirst(env: Environment, model: string): readonly string[] {
  return READ_FIRST.get(env.cr)?.get(model) ?? [];
}

/**
 * A write of `model`'s image_1920 whose sizes Odoo computes lazily in the order a read asks for them, `first` before
 * the others (field order) at the flush: product.product's `_set_image_1920` writes its template's image, and the
 * variant's web_save then reads `image_N` through the template's (product_product.py:290-308).
 */
const WRITE_FIRST = new WeakMap<object, Map<string, readonly string[]>>();
export async function withImageWriteOrder<T>(env: Environment, model: string, first: readonly string[], fn: () => Promise<T>): Promise<T> {
  const m = WRITE_FIRST.get(env.cr) ?? new Map<string, readonly string[]>();
  WRITE_FIRST.set(env.cr, m);
  const prev = m.get(model);
  m.set(model, first);
  try {
    return await fn();
  } finally {
    if (prev === undefined) m.delete(model); else m.set(model, prev);
  }
}

/** The write of `image_1920` and its related sizes for `ids`. */
export async function writeImageMixin(env: Environment, def: ModelDef, ids: readonly number[], value: unknown, created = false): Promise<void> {
  if (!value) {
    // fields_binary.py:177-226 Binary.write of a falsy value unlinks the records' attachments of image_1920 and its
    // sizes: with none there is nothing to do (a template's inverse from its variant, product_product.py:225-226)
    const existing = await env.cr.query("SELECT 1 FROM ir_attachment WHERE res_model = $1 AND res_id = ANY($2::int[]) AND res_field = ANY($3::text[]) LIMIT 1",
      [def.name, [...ids], Object.keys(IMAGE_MIXIN_SIZES)]);
    if (existing.rows.length) throw new NotPorted(`clearing ${def.name}.image_1920 (the unlink of its attachments)`);
    return;
  }
  // Binary.convert_to_cache (fields_binary.py:85-110): a base64 string, or {filename, content}
  const content = typeof value === "string" ? value
    : value && typeof value === "object" && typeof (value as Record<string, unknown>)["content"] === "string" ? (value as Record<string, string>)["content"]! : null;
  if (content === null) throw new NotPorted(`${def.name}.image_1920 value that is neither base64 nor {filename, content}`);
  // other stored computed fields depending on the image fields: product.template's `can_image_1024_be_zoomed` is
  // recomputed by the ORM (src/models/product_computes.ts), any other refuses
  for (const f of def.fields.values()) {
    if (f.store && f.depends.some((d) => d.split(".")[0]! in IMAGE_MIXIN_SIZES) && !(f.name in IMAGE_MIXIN_SIZES)
      && !(def.name === "product.template" && f.name === "can_image_1024_be_zoomed")) {
      throw new NotPorted(`${def.name}.${f.name} depends on the image fields`);
    }
  }
  const source = new Uint8Array(Buffer.from(content, "base64"));
  // res_company.py:107, :226-230 `logo_web` (stored, depends on partner_id.image_1920): a company's partner image
  // recomputes it as image_process(size=(180, 0)); with the same image only its attachment's write_uid and write_date
  // move, a new company logo refuses
  const companies = def.name === "res.partner"
    ? (await env.cr.query<{ id: number }>("SELECT id FROM res_company WHERE partner_id = ANY($1::int[]) ORDER BY id", [[...ids]])).rows.map((r) => r.id) : [];
  // The form of a wizard sends the stored image back: the sizes are derived from it, so `_image_process` leaves every
  // attachment's bytes as they are and only write_uid and write_date move (G153 base.document.layout web_save).
  if (ids.length === 1) {
    const current = await new DbRec(env.sudo(), def, ids[0]!).get("image_1920") as BinaryValue | null;
    if (current && Buffer.compare(await current.content(), source) === 0) {
      await env.cr.query(
        `UPDATE ir_attachment SET write_uid = $1, write_date = now() AT TIME ZONE 'UTC'
          WHERE res_model = $2 AND res_id = $3 AND res_field = ANY($4::text[])`, [env.uid, def.name, ids[0], ["image_1920", ...IMAGE_SIZE_FIELDS]]);
      rememberWritten(env, `${def.name},image_1920,${ids[0]}`, binaryBytes(source));
      if (companies.length) {
        await env.cr.query(
          `UPDATE ir_attachment SET write_uid = $1, write_date = now() AT TIME ZONE 'UTC'
            WHERE res_model = 'res.company' AND res_id = ANY($2::int[]) AND res_field = 'logo_web'`, [env.uid, companies]);
      }
      return;
    }
  }
  if (companies.length && companyLogoHook === null) throw new NotPorted("res.company.logo_web of a new company logo (image_process size (180, 0))");
  const i1920 = imageProcess(source, 1920, 1920);
  // a create inside a web_save stores the sizes its specification reads first (READ_FIRST); a write updates them in place
  const first = created ? READ_FIRST.get(env.cr)?.get(def.name) ?? [] : WRITE_FIRST.get(env.cr)?.get(def.name) ?? [];
  const order = [...first, ...IMAGE_SIZE_FIELDS.filter((n) => !first.includes(n))];
  // a record a module's data file creates: its sizes are stored related fields Odoo computes at the next flush (the
  // file's end, or an `invalidate_all` before it: src/orm/recompute.ts invalidationPoint), after every record created
  // until then (lunch's categories and products, measured with a trace of Odoo's `_recompute_field`)
  const window = created && !first.length && !companies.length ? dataFileWindow(env) : null;
  for (const id of ids) {
    await storeAttachment(env, def.name, "image_1920", id, i1920);
    if (window) {
      for (const name of order) window.push({ env, def, field: def.fields.get(name)!, id, data: i1920, size: IMAGE_MIXIN_SIZES[name]! });
      continue;
    }
    for (const name of order) {
      const size = IMAGE_MIXIN_SIZES[name]!;
      await storeAttachment(env, def.name, name, id, imageProcess(i1920, size, size));
    }
  }
  if (companies.length) await companyLogoHook!(env, companies, i1920);
}

/**
 * tools/image.py:517-541 `is_image_size_above(source1, source2)`: False for an SVG (`<` first); the width or height of
 * the first above the second's, after `image_fix_orientation`. An orientation that swaps them (EXIF 5-8), a WEBP and a
 * format whose size the port does not read refuse.
 */
export function isImageSizeAbove(a: Uint8Array, b: Uint8Array): boolean {
  if (!a.length || !b.length) return false;
  if (a[0] === 0x3c || b[0] === 0x3c) return false;
  const size = (x: Uint8Array): { width: number; height: number } => {
    if (x.length >= 15 && String.fromCharCode(...x.slice(0, 4)) === "RIFF" && String.fromCharCode(...x.slice(8, 15)) === "WEBPVP8") throw new NotPorted("is_image_size_above of a WEBP image");
    const d = imageDimensionsOf(x);
    if (!d) throw new NotPorted("is_image_size_above of an image whose size the port does not read");
    if (d.jpeg && jpegOrientation(x) >= 5) throw new NotPorted("is_image_size_above of a JPEG rotated by its EXIF orientation");
    return d;
  };
  const s1 = size(a), s2 = size(b);
  return s1.width > s2.width || s1.height > s2.height;
}

/** The pixel size of PNG, GIF, BMP or JPEG data (as src/controllers/stream.ts imageDimensions), or null. */
function imageDimensionsOf(data: Uint8Array): { width: number; height: number; jpeg: boolean } | null {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length >= 24 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return { width: dv.getUint32(16), height: dv.getUint32(20), jpeg: false };
  if (data.length >= 10 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return { width: dv.getUint16(6, true), height: dv.getUint16(8, true), jpeg: false };
  if (data.length >= 26 && data[0] === 0x42 && data[1] === 0x4d) return { width: Math.abs(dv.getInt32(18, true)), height: Math.abs(dv.getInt32(22, true)), jpeg: false };
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let pos = 2;
    while (pos + 9 < data.length) {
      if (data[pos] !== 0xff) return null;
      const marker = data[pos + 1] ?? 0;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { pos += 2; continue; }
      const len = dv.getUint16(pos + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: dv.getUint16(pos + 7), height: dv.getUint16(pos + 5), jpeg: true };
      pos += 2 + len;
    }
  }
  return null;
}

/** The EXIF orientation (tag 0x0112 of IFD0 in an APP1 "Exif" segment) of JPEG data, 1 without one. */
function jpegOrientation(data: Uint8Array): number {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = 2;
  while (pos + 4 < data.length && data[pos] === 0xff) {
    const marker = data[pos + 1]!;
    if (marker === 0xda || marker === 0xd9) break;
    const len = dv.getUint16(pos + 2);
    if (marker === 0xe1 && pos + 10 < data.length && String.fromCharCode(...data.slice(pos + 4, pos + 10)) === "Exif\0\0") {
      const t = pos + 10;
      const le = data[t] === 0x49;
      const u16 = (o: number) => dv.getUint16(t + o, le), u32 = (o: number) => dv.getUint32(t + o, le);
      const ifd = u32(4), n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (u16(e) === 0x0112) return u16(e + 8);
      }
      return 1;
    }
    pos += 2 + len;
  }
  return 1;
}
