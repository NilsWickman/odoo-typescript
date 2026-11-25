/**
 * Binary values of computed fields (`odoo/odoo/tools/binary.py`, `odoo/odoo/orm/fields_binary.py`): in-memory bytes
 * (`BinaryBytes`) and values backed by an `ir_attachment` row (`BinaryValueAttachment`, fields_binary.py:399-445),
 * built from the attachment columns without touching the filestore until `content()` is called.
 */
import { NotPorted } from "../errors";
import type { BinaryValue, Environment } from "../orm/types";
import { pgInt, sha256Hex } from "./util";
import { readFile } from "../filestore";
import { requestOfCursor } from "../http/context";

/** `BinaryBytes(data, filename=...)`: checksum is sha256 of the bytes (binary.py:71). */
export function binaryBytes(data: Uint8Array, filename = "", mimetype = "application/octet-stream"): BinaryValue {
  let checksum: string | null = null;
  return {
    filename,
    size: data.byteLength,
    get checksum(): string {
      if (checksum === null) checksum = sha256Hex(data);
      return checksum;
    },
    mimetype,
    content: () => Promise.resolve(data),
  };
}

/** The columns of an `ir_attachment` row a binary field needs (fields_binary.py:148 `read`, :399 BinaryValueAttachment). */
export interface AttachmentRow {
  id: number;
  res_id: number | null;
  res_field: string | null;
  name: string | null;
  file_size: number | string | null;
  checksum: string | null;
  mimetype: string | null;
  store_fname: string | null;
  db_datas: Uint8Array | null;
}

export const ATTACHMENT_COLUMNS = "id, res_id, res_field, name, file_size, checksum, mimetype, store_fname, db_datas";

/** Reads the bytes of `store_fname` from the filestore; installed per request by the HTTP stream (NEEDS.md). */
export type FilestoreReader = (storeFname: string) => Promise<Uint8Array | null>;

export const FILESTORE_READER_KEY = "models.filestore_reader";

/**
 * `BinaryValueAttachment(att)` (fields_binary.py:406-445): filename is the attachment name unless it equals the field
 * name (:425), size is `file_size`, checksum the attachment's (sha1, ir_attachment.py), content the filestore bytes
 * or `db_datas`.
 */
export function attachmentValue(env: Environment, row: AttachmentRow): BinaryValue {
  const name = row.name ?? "";
  return {
    filename: name !== row.res_field ? name : "",
    size: pgInt(row.file_size) ?? 0,
    checksum: row.checksum ?? "",
    mimetype: row.mimetype ?? "application/octet-stream",
    content: async () => {
      if (row.db_datas !== null && row.db_datas.byteLength > 0) return row.db_datas;
      if (row.store_fname === null) return new Uint8Array();
      let reader = env.cache.get(FILESTORE_READER_KEY) as FilestoreReader | undefined;
      if (typeof reader !== "function") {
        // an environment made on the request's cursor without the request's cache (a module install's load
        // environment): the request's filestore, as storeAttachment writes it (src/orm/image_write.ts)
        const ctx = requestOfCursor(env.cr);
        const db = ctx?.db ?? null;
        if (ctx === null || db === null) {
          throw new NotPorted(`ir_attachment ${row.id} content: no filestore reader installed in env.cache["${FILESTORE_READER_KEY}"] (src/models/NEEDS.md)`);
        }
        reader = (name: string) => readFile(ctx.env, db, name);
      }
      const data = await reader(row.store_fname);
      if (data === null) throw new NotPorted(`ir_attachment ${row.id}: ${row.store_fname} not in the filestore`);
      return data;
    },
  };
}

/**
 * `Binary.read` for an attachment-stored field (fields_binary.py:148-158): the `ir_attachment` rows of
 * `(res_model, res_field, res_id in ids)` read as superuser, one value per id.
 */
export async function attachmentValues(env: Environment, model: string, field: string, ids: readonly number[]): Promise<Map<number, BinaryValue>> {
  const out = new Map<number, BinaryValue>();
  if (ids.length === 0) return out;
  const res = await env.cr.query<AttachmentRow>(
    `SELECT ${ATTACHMENT_COLUMNS} FROM ir_attachment WHERE res_model = $1 AND res_field = $2 AND res_id = ANY($3::int[]) ORDER BY id`,
    [model, field, ids],
  );
  for (const row of res.rows) {
    const rid = pgInt(row.res_id);
    if (rid !== null && !out.has(rid)) out.set(rid, attachmentValue(env, row));
  }
  // values written in this transaction are read from the cache (fields_binary.py: the written BinaryBytes, whose
  // checksum is the sha256 of the content), not from the attachment (sha1): src/orm/image_write.ts
  const written = env.cache.get(BINARY_WRITTEN_KEY) as Map<string, BinaryValue> | undefined;
  if (written) for (const id of ids) { const v = written.get(`${model},${field},${id}`); if (v) out.set(id, v); }
  return out;
}

/** env.cache key of the attachment-stored binary values written in the current transaction. */
export const BINARY_WRITTEN_KEY = "orm.binaryWritten";
