import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeException, werkzeugErrorResponse } from "./dispatch";
import { psycopgError } from "../orm/sql_errors";
import { NotPorted, OdooError } from "../errors";

test("a psycopg2 error keeps Odoo's class name and libpq's message (dispatcher.py:78-91)", async () => {
  const e = await psycopgError({ code: "40001", severity: "ERROR", message: "could not serialize access due to concurrent update" } as never);
  assert.ok(e instanceof OdooError);
  assert.equal(serializeException(e, 0)["name"], "psycopg2.errors.SerializationFailure");
  assert.equal(serializeException(e, 0)["message"], "could not serialize access due to concurrent update\n");
  const col = await psycopgError({ code: "42703", severity: "ERROR", message: 'column "x" does not exist', hint: "Perhaps you meant y." } as never);
  assert.equal(serializeException(col, 0)["name"], "psycopg2.errors.UndefinedColumn");
  assert.equal(serializeException(col, 0)["message"], 'column "x" does not exist\nHINT:  Perhaps you meant y.\n');
});

test("an internal error sends no Worker stack to the client", () => {
  const data = serializeException(new NotPorted("something"), 0);
  assert.equal(data["debug"], "Traceback (most recent call last):\nNotPorted: not ported: something\n");
  const plain = serializeException(new TypeError("boom"), 0);
  assert.ok(!String(plain["debug"]).includes(".ts:"), String(plain["debug"]));
});

test("the 500 page is werkzeug's InternalServerError without a cause", async () => {
  const body = await werkzeugErrorResponse(500, null).text();
  assert.match(body, /<title>500 Internal Server Error<\/title>/);
  assert.ok(!body.includes("NotPorted"));
  assert.match(body, /The server encountered an internal error/);
});
