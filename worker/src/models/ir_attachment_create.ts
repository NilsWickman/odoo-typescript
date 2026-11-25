/**
 * `ir.attachment.create` and `write` (odoo/odoo/addons/base/models/ir_attachment.py:878-956) for values without
 * content, as an API script or the web client sends them: `datas` is dropped (`_check_contents` :532-559, "Use raw,
 * datas has beeen removed"), the mimetype is computed (`_compute_mimetype` :469-489) and xml-like types are forced
 * to text/plain for users who may not write views, the record the attachment points to must be writable
 * (`_inaccessible_comodel_records` :787-814), and only system users may create binary attachments with a url
 * (`_check_serving_attachments` :626-636). product's create override (product/models/ir_attachment.py:9-25) and
 * account's write override (account/models/ir_attachment.py:20-52) are checked where they apply.
 *
 * Content given as bytes in `raw` is stored at create (`_get_datas_related_values`, the filestore write) for types that
 * need no post-processing; other content (`db_datas`, images, a write of raw) refuses.
 */
import { createHash } from "node:crypto";
import { AccessError, NotPorted, ValidationError } from "../errors";
import { writeFile } from "../filestore";
import { requestOfCursor } from "../http/context";
import { indexContent } from "../mail/attachment";
import { accessDomain } from "../orm/access";
import { registerOverrides } from "../orm/write";
import type { Environment } from "../orm/types";
import { userHasGroup } from "../web/groups";
import { isAdmin } from "./account_buttons";
import { fieldAccess, inaccessibleComodelRecords, isSystem } from "./ir_attachment_access";
import { guessType } from "./mimetypes";
import { pyTruthy } from "./util";

type Vals = Record<string, unknown>;

/** `_compute_mimetype(values)` (:469-489) without raw content. */
function computeMimetype(values: Vals): string {
  let mimetype: string | null = null;
  if (pyTruthy(values["mimetype"])) {
    if (typeof values["mimetype"] !== "string") throw new NotPorted("ir.attachment mimetype that is not a string");
    mimetype = values["mimetype"];
  }
  if (!mimetype && pyTruthy(values["name"])) {
    if (typeof values["name"] !== "string") throw new NotPorted("ir.attachment name that is not a string");
    mimetype = guessType(values["name"]);
  }
  if (!mimetype && pyTruthy(values["url"])) {
    if (typeof values["url"] !== "string") throw new NotPorted("ir.attachment url that is not a string");
    mimetype = guessType(values["url"].split("?")[0]!);
  }
  // :481-488: guess_mimetype(raw) only runs with content, which refuses before this point
  return mimetype ? mimetype.toLowerCase() : "application/octet-stream";
}

/** `_check_contents(values)` (:532-559) for values without content; the values are changed in place. */
async function checkContents(env: Environment, values: Vals): Promise<void> {
  if ("datas" in values) delete values["datas"]; // :534-536
  const dbDatas = values["db_datas"];
  delete values["db_datas"];
  const raw = "raw" in values ? values["raw"] : dbDatas;
  // bytes (the chart loader's demo files, account_demo.py:461-487) are stored by create below; other content refuses
  if (raw instanceof Uint8Array && raw.length) {
    values["raw"] = raw;
    if (!pyTruthy(values["mimetype"]) && !pyTruthy(values["name"]) && !pyTruthy(values["url"])) throw new NotPorted("ir.attachment content without a name or mimetype (guess_mimetype)");
    values["mimetype"] = computeMimetype(values);
    // :492-530 `_postprocess_contents` resizes images; :551-554 xml-like types may become text/plain
    if (String(values["mimetype"]).startsWith("image/") || /ht|xml/.test(String(values["mimetype"]))) throw new NotPorted(`ir.attachment content of type ${String(values["mimetype"])}`);
    return;
  }
  if (pyTruthy(raw)) throw new NotPorted("ir.attachment content given as raw or db_datas (filestore write, checksum, index, image post-processing)");
  // :540-543 an empty raw stays an empty raw when it was given; create pops it again (:935), write sends it to
  // `_inverse_raw`, which is not ported for a write
  if ("raw" in values) values["raw"] = false;
  if (!("name" in values) && pyTruthy(values["res_field"])) values["name"] = values["res_field"]; // :545-546 (raw.filename is None)
  const mimetype = values["mimetype"] = computeMimetype(values);
  const xmlLike = mimetype.includes("ht") || (mimetype.includes("xml") && !mimetype.startsWith("application/vnd.openxmlformats"));
  if (xmlLike) {
    // :551-554 `self.env['ir.ui.view'].sudo(False).has_access('write')`
    const viewWritable = (await accessDomain(env.withUser(env.uid), env.reg.model("ir.ui.view"), "write")).kind !== "false";
    if (pyTruthy(env.context["attachments_mime_plainxml"]) || !viewWritable) values["mimetype"] = "text/plain";
  }
  // :557-558 `_postprocess_contents` returns the values unchanged without raw
}

/** `_check_serving_attachments` (:626-636) on the given rows. */
async function checkServing(env: Environment, ids: readonly number[]): Promise<void> {
  if (await isAdmin(env)) return;
  const rows = (await env.cr.query<{ type: string; url: string | null }>("SELECT type, url FROM ir_attachment WHERE id = ANY($1::int[]) ORDER BY id", [[...ids]])).rows;
  for (const r of rows) {
    if (r.type === "binary" && r.url) {
      // get_serving_groups (:618-624): base.group_system
      if (!(await userHasGroup(env.sudo(), "base.group_system"))) throw new ValidationError("Sorry, you are not allowed to write on this document");
    }
  }
}

/** `_check_circular_attachment` (:638-645). */
async function checkCircular(env: Environment, ids: readonly number[]): Promise<void> {
  const rows = (await env.cr.query<{ id: number }>("SELECT id FROM ir_attachment WHERE id = ANY($1::int[]) AND res_model = 'ir.attachment' AND res_id = id ORDER BY id", [[...ids]])).rows;
  const r = rows[0];
  if (r) throw new ValidationError(`You cannot attach an attachment to itself.\nAttachment ir.attachment(${r.id},) cannot have res_id: ir.attachment(${r.id},)`);
}

function modelAndIds(pairs: Iterable<[unknown, unknown]>): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const [model, id] of pairs) {
    if (!pyTruthy(model)) continue;
    if (typeof model !== "string") throw new NotPorted("ir.attachment res_model that is not a string");
    if (!pyTruthy(id)) { out.set(model, out.get(model) ?? new Set()); continue; }
    if (typeof id !== "number" || !Number.isInteger(id)) throw new NotPorted("ir.attachment res_id that is not an integer");
    const set = out.get(model) ?? new Set<number>();
    set.add(id);
    out.set(model, set);
  }
  return out;
}

registerOverrides("ir.attachment", {
  create: async (env, valsList, next) => {
    // :924-932: the computed fields depending on raw are dropped (the stream flag is a Python object no call can pass)
    const list: Vals[] = valsList.map((vals) => Object.fromEntries(Object.entries(vals).filter(([k]) => !["file_size", "checksum", "store_fname"].includes(k))));
    const pairs: [unknown, unknown][] = [];
    const files: [string, Uint8Array][] = [];
    for (const values of list) {
      await checkContents(env, values);
      const raw = values["raw"];
      delete values["raw"]; // :935 an empty raw has nothing to store
      if (raw instanceof Uint8Array && raw.length) {
        // :936-939 `_get_datas_related_values` (:424-441) in the file storage, the file written after the rows
        if ((await env.cr.query("SELECT 1 FROM ir_config_parameter WHERE key = 'ir_attachment.location' AND value != 'file'")).rows.length) throw new NotPorted("ir.attachment content in the database storage");
        const checksum = createHash("sha1").update(raw).digest("hex");
        const storeFname = `${checksum.slice(0, 2)}/${checksum}`; // :140 _file_fname
        Object.assign(values, { file_size: raw.length, checksum, index_content: indexContent(raw, String(values["mimetype"])) ?? false, store_fname: storeFname, db_datas: false });
        files.push([storeFname, raw]);
      }
      pairs.push([values["res_model"], values["res_id"]]);
    }
    if ((await inaccessibleComodelRecords(env, modelAndIds(pairs), "write")).size) {
      throw new AccessError("Sorry, you are not allowed to access this document.");
    }
    // product/models/ir_attachment.py:9-25 creates a product.document (an _inherits child) for product attachments
    if (!env.context["disable_product_documents_creation"]
      && list.some((v) => (v["res_model"] === "product.product" || v["res_model"] === "product.template") && !pyTruthy(v["res_field"]))) {
      throw new NotPorted("ir.attachment on a product: product.document creation");
    }
    const ids = await next(env, list);
    if (files.length) {
      const ctx = requestOfCursor(env.cr);
      if (ctx === null || ctx.db === null) throw new NotPorted("ir.attachment content outside a request");
      for (const [fname, raw] of files) await writeFile(ctx.env, ctx.db, fname, raw);
    }
    await checkCircular(env, ids);
    await checkServing(env, ids);
    return ids;
  },
  write: async (env, ids, vals0, next) => {
    // account/models/ir_attachment.py:40-52 `_except_audit_trail` on moves of companies with a restricted audit trail
    if (Object.keys(vals0).some((k) => ["res_id", "res_model", "raw", "store_fname", "db_datas", "company_id"].includes(k))) {
      const audit = await env.cr.query(
        `SELECT 1 FROM ir_attachment a JOIN res_company c ON c.id = a.company_id
          WHERE a.id = ANY($1::int[]) AND a.res_model = 'account.move' AND a.res_id IS NOT NULL AND a.res_id != 0 AND c.restrictive_audit_trail LIMIT 1`, [[...ids]]);
      if (audit.rows.length) throw new NotPorted("ir.attachment write on an invoice attachment of a restricted audit trail");
    }
    await env.model("ir.attachment").checkAccess(ids, "write"); // :879
    const vals: Vals = { ...vals0 };
    if ("res_model" in vals || "res_id" in vals || "res_field" in vals) {
      let triples: [unknown, unknown, unknown][];
      if ("res_model" in vals && "res_id" in vals && "res_field" in vals) {
        triples = [[vals["res_model"], vals["res_id"], vals["res_field"]]];
      } else {
        const rows = (await env.cr.query<{ res_model: string | null; res_id: number | null; res_field: string | null }>(
          "SELECT res_model, res_id, res_field FROM ir_attachment WHERE id = ANY($1::int[]) ORDER BY id",
          [[...ids]],
        )).rows;
        triples = rows.map((r) => [
          "res_model" in vals ? vals["res_model"] : r.res_model,
          "res_id" in vals ? vals["res_id"] : r.res_id,
          "res_field" in vals ? vals["res_field"] : r.res_field,
        ]);
      }
      if (pyTruthy(vals["res_model"]) || pyTruthy(vals["res_id"])) {
        const pairs: [unknown, unknown][] = triples.map(([m, id]) => [m, id]);
        if ((await inaccessibleComodelRecords(env, modelAndIds(pairs), "write")).size) {
          throw new AccessError("Sorry, you are not allowed to access this document.");
        }
      }
      if (!(await isSystem(env))) {
        for (const [m, _id, rf] of triples) {
          if (!pyTruthy(rf)) continue;
          if (typeof m !== "string" || typeof rf !== "string" || !env.reg.models.has(m)) {
            throw new AccessError("Sorry, you are not allowed to access this document.");
          }
          const field = env.reg.model(m).fields.get(rf);
          if (!field || !(await fieldAccess(env, m, field))) {
            throw new AccessError("Sorry, you are not allowed to access this document.");
          }
        }
      }
    }
    for (const f of ["file_size", "checksum", "store_fname"]) delete vals[f]; // :889-890
    if ("mimetype" in vals || "raw" in vals || "db_datas" in vals || "datas" in vals) {
      await checkContents(env, vals);
      // `_inverse_raw` (:395-422) would write the content-related values of an empty raw: not ported
      if ("raw" in vals) throw new NotPorted("ir.attachment write of raw (_inverse_raw)");
    }
    await next(env, ids, vals);
    await checkCircular(env, ids);
    if ("url" in vals || "type" in vals) await checkServing(env, ids);
  },
});
