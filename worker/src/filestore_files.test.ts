import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { budgetOf, DEFAULT_BUDGET, fits, FILES_DB, filesDbName, MAX_FILE, isReservedDb, isStoreFname, matchesStoreFname } from "./filestore_files";

const fnameOf = (data: Uint8Array) => {
  const sha = createHash("sha1").update(data).digest("hex");
  return `${sha.slice(0, 2)}/${sha}`;
};

test("the files database is reserved, Odoo databases are not", () => {
  assert.equal(FILES_DB, "odoo_ts_files");
  assert.ok(isReservedDb("odoo_ts_files"));
  for (const db of ["odoo_db", "odoo_ts_files_x", "odoo_ts", "postgres_files", "ODOO_TS_FILES"]) assert.ok(!isReservedDb(db), db);
});

test("only Odoo's store_fname shape is accepted, and the sha1 must match", () => {
  const data = new TextEncoder().encode("C3 part 2");
  const f = fnameOf(data);
  assert.ok(isStoreFname(f));
  assert.ok(!isStoreFname(`../${f.slice(3)}`));
  assert.ok(!isStoreFname(f.toUpperCase()));
  assert.ok(!isStoreFname(`${f.slice(3, 5) === "00" ? "11" : "00"}/${f.slice(3)}`));
  assert.ok(!isStoreFname(`meta:${f}`));
  assert.ok(matchesStoreFname(f, data));
  assert.ok(!matchesStoreFname(f, new TextEncoder().encode("C3 part 2!")));
});

test("the budget: the file count and the bytes, but the first file of a run always fits", () => {
  const budget = { files: 3, bytes: 100 };
  assert.ok(fits({ files: 0, bytes: 0 }, budget, 1000)); // larger than the budget, alone
  assert.ok(!fits({ files: 1, bytes: 1000 }, budget, 1));
  assert.ok(fits({ files: 1, bytes: 40 }, budget, 60));
  assert.ok(!fits({ files: 1, bytes: 40 }, budget, 61));
  assert.ok(!fits({ files: 3, bytes: 0 }, budget, 0));
});

test("the budget's overrides are positive integers, anything else is the default", () => {
  assert.deepEqual(budgetOf(undefined, undefined), DEFAULT_BUDGET);
  assert.deepEqual(budgetOf("2", "1048576"), { files: 2, bytes: 1048576 });
  assert.deepEqual(budgetOf("0", "-1"), DEFAULT_BUDGET);
  assert.deepEqual(budgetOf("2x", ""), DEFAULT_BUDGET);
});

test("a file over MAX_FILE is never copied, the default budget holds at least one file of that size", () => {
  assert.equal(MAX_FILE, 24 * 1024 * 1024);
  assert.ok(fits({ files: 0, bytes: 0 }, DEFAULT_BUDGET, MAX_FILE));
  assert.ok(DEFAULT_BUDGET.bytes <= MAX_FILE);
});

test("the files database has another name only for a local Worker that is given one", () => {
  assert.equal(filesDbName(undefined, undefined), FILES_DB);
  assert.equal(filesDbName("1", undefined), FILES_DB);
  assert.equal(filesDbName("1", "dev_fg_files"), "dev_fg_files");
  // the deployed Worker has no LOCAL_DEV: a name set there is not used
  assert.equal(filesDbName(undefined, "dev_fg_files"), FILES_DB);
  assert.equal(filesDbName("0", "dev_fg_files"), FILES_DB);
  // only a plain database name
  for (const bad of ["", "Dev", "a-b", "a b", "a;drop", "1abc", "a/b"]) assert.equal(filesDbName("1", bad), FILES_DB, bad);
});
