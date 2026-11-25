/**
 * `/base_import/set_file` (odoo/addons/base_import/controllers/main.py:10-22): stores the uploaded file on the
 * `base_import.import` record (`write({'file', 'file_name', 'file_type'})`) and answers `json.dumps({'result': True})`
 * as an html response.
 */
import { NotPorted, OdooError } from "../errors";
import { route } from "../http/router";

route("/base_import/set_file", async (ctx) => {
  const id = ctx.params["id"];
  const ufile = ctx.params["ufile"];
  for (const k of Object.keys(ctx.params)) {
    if (!["id", "ufile", "model", "csrf_token"].includes(k)) throw new OdooError("builtins.TypeError", `ImportController.set_file() got an unexpected keyword argument '${k}'`);
  }
  if (typeof id !== "string" || !/^\s*[+-]?\d+\s*$/.test(id)) throw new NotPorted("/base_import/set_file without an integer id");
  if (!(ufile instanceof File)) throw new NotPorted("/base_import/set_file without a file");
  const env = await ctx.orm();
  const rid = Number(id.trim());
  const m = env.model("base_import.import");
  // models.py write: access to the record, then the columns (file is Binary(attachment=False): bytea)
  await m.checkAccess([rid], "write");
  const exists = await env.cr.query("SELECT 1 FROM base_import_import WHERE id = $1", [rid]);
  if (!exists.rows.length) throw new OdooError("odoo.exceptions.MissingError", `Record does not exist or has been deleted.\n(Record: base_import.import(${rid},), User: ${env.uid})`);
  const data = Buffer.from(await ufile.arrayBuffer());
  await env.cr.query(
    `UPDATE base_import_import SET file = $2, file_name = $3, file_type = $4, write_uid = $5, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1`,
    [rid, data.length ? data : null, ufile.name || null, ufile.type || null, env.uid]);
  return new Response(JSON.stringify({ result: true }).replace(":", ": "), { headers: { "Content-Type": "text/html; charset=utf-8" } });
}, { methods: ["POST"] });
