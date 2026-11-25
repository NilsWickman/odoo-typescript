import { strict as assert } from "node:assert";
import { test } from "node:test";
import { configureDbFilter, dbFilter } from "./dispatch";
import type { Env } from "../env";

const env = (DB_FILTER?: string) => ({ DB_FILTER }) as unknown as Env;

test("dbfilter: unset lets every well-formed name pass", () => {
  configureDbFilter(env(), "odoo-ts.example.com");
  assert.deepEqual(dbFilter(["odoo_db", "poc_erp", "-bad"]), ["odoo_db", "poc_erp"]);
});

test("dbfilter: re.match semantics (anchored at the start only) with a negative lookahead", () => {
  configureDbFilter(env("^(?!poc_|neondb$|dev_latency$)"), "odoo-ts.example.com");
  assert.deepEqual(dbFilter(["dev_latency", "odoo_db", "neondb", "poc_corpus", "poc_erp", "live_x"]), ["odoo_db", "live_x"]);
  configureDbFilter(env("odoo"), "odoo-ts.example.com");
  assert.deepEqual(dbFilter(["odoo_db", "x_odoo"]), ["odoo_db"]);
});

test("dbfilter: %d is the first label of the host without www. and port, %h the host", () => {
  configureDbFilter(env("%d$"), "www.acme.example.com:8069");
  assert.deepEqual(dbFilter(["acme", "acme2", "other"]), ["acme"]);
  configureDbFilter(env("^%h$"), "a.b");
  assert.deepEqual(dbFilter(["a.b", "aXb"]), ["a.b"]);
  configureDbFilter(env(), "x");
});
