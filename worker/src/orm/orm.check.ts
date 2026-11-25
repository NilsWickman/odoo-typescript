/** Integration checks against an existing poc_corpus scratch copy, with no persistent writes.
 * ODOO_TEST_DB=dev_cf1 npm run test:integration
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { before, after, test } from "node:test";
import { Cursor } from "../db";
import { AccessError } from "../errors";
import { createEnvironment } from "./env";
import { setGenMetadataLoader, type GenMetadata } from "./registry";
import { cond } from "./domain";
import type { Environment } from "./types";
import "../models/partner";

const database = process.env["ODOO_TEST_DB"];
if (!database || !/^(dev_|live_|run_)[a-zA-Z0-9_]+$/.test(database)) {
  throw new Error("Set ODOO_TEST_DB to an existing poc_corpus scratch copy (dev_*, live_* or run_*).");
}
setGenMetadataLoader(async () => {
  const data = JSON.parse(readFileSync(new URL("../../gen/out/models.json", import.meta.url).pathname, "utf8")) as { models: GenMetadata };
  return data.models;
});
const cr = new Cursor({ SLOTS: "{}", PG_DSN_TEMPLATE: "postgresql://track_rw:track_rw@127.0.0.1:5433/{db}" } as import("../env").Env, database);
let env: Environment;
let uid: number;
let partnerId: number;

before(async () => {
  const admin = (await cr.query<{id:number;partner_id:number}>("SELECT id,partner_id FROM res_users WHERE login='admin'")).rows[0];
  assert.ok(admin, "poc_corpus admin fixture required");
  uid = admin.id;
  partnerId = admin.partner_id;
  env = await createEnvironment({ cr, uid, context: { lang: "en_US", tz: "UTC" } });
});
after(async () => { await cr.rollback(); await cr.close(); });

test("inherited res.users access domain reaches a fixed point and reads the partner name", async () => {
  await env.model("res.users").checkAccess([uid], "read");
  const rows = await env.model("res.users").read([uid], ["name", "partner_id"], "web");
  const source = (await cr.query<{name:string}>("SELECT name FROM res_partner WHERE id=$1", [partnerId])).rows[0];
  assert.deepEqual(rows, [{ id:uid, name:source?.name, partner_id:partnerId }]);
});

test("search follows the translated many2one order without inventing an id tie-breaker", async () => {
  const ids = await env.model("res.country").search(cond("code", "in", ["BE", "FR", "US"]), { order: "name" });
  const source = await cr.query<{id:number}>("SELECT id FROM res_country WHERE code=ANY($1::text[]) ORDER BY name->>'en_US'", [["BE","FR","US"]]);
  assert.deepEqual(ids, source.rows.map(r=>r.id));
  const partners = env.sudo().model("res.partner");
  const ordered = await partners.search(cond("id", "in", [partnerId]), { order: "country_id" });
  assert.deepEqual(ordered, [partnerId]);
});

test("unknown companies fail closed before compiling an access domain", async () => {
  const invalid = env.withContext({ allowed_company_ids: [2147483647] });
  await assert.rejects(() => invalid.model("res.partner").search(cond("id", "=", partnerId)), AccessError);
});

test("NO_ACCESS fields are excluded and cannot be read by the administrator", async () => {
  const model = env.model("res.users");
  assert.deepEqual(await model.fieldsGet(["totp_secret"], []), {});
  await assert.rejects(() => model.read([uid], ["totp_secret"]), AccessError);
});

test("read(load=web) keeps relational ids while the classic API resolves display names", async () => {
  const model = env.model("res.users");
  const web = await model.read([uid], ["partner_id"], "web");
  const classic = await model.read([uid], ["partner_id"]);
  const names = await env.sudo().model("res.partner").displayName([partnerId]);
  assert.equal(web[0]?.["partner_id"], partnerId);
  assert.deepEqual(classic[0]?.["partner_id"], [partnerId, names.get(partnerId)]);
});

test("binary streaming preserves attachment checksum and RPC metadata", async () => {
  const model = env.model("res.users");
  const value = await model.binaryValue(uid, "avatar_128");
  assert.ok(value);
  const rows = await model.read([uid], ["avatar_128"], "web");
  assert.deepEqual(rows[0]?.["avatar_128"], { size:value.size, checksum:value.checksum, ...(value.filename ? {filename:value.filename} : {}) });
});

test("count limit and read order survive the SQL query layer", async () => {
  const model = env.model("res.partner");
  const ids = await model.search(cond("id", ">", 0), { limit: 3, order: "id DESC" });
  assert.equal(ids.length, 3);
  assert.deepEqual(ids, [...ids].sort((a,b)=>b-a));
  assert.equal(await model.searchCount(cond("id", ">", 0), 2), 2);
  assert.deepEqual((await model.read([...ids].reverse(), ["id"])).map(r=>r["id"]), [...ids].reverse());
});
