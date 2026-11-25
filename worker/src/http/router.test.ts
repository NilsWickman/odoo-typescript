import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NotPorted } from "../errors";
import { matchPath, matchPathFor, route, templateRoute, templateRouteCandidates } from "./router";

// The compiled routes of a template's own controllers (compiler/runtime/install.ts routeKey): they exist only on that
// template's databases, never override a hand route, and a path both tables match refuses.
test("template routes: only for their template, never over the hand's", async () => {
  const h = async (): Promise<unknown> => null;
  route("/zz_rt/hand/<string:x>", async () => new Response(""), { auth: "user" });
  templateRoute("tpl_a", ["/zz_rt/infos"], "jsonrpc", h, { auth: "user", csrf: false });
  templateRoute("tpl_a", ["/zz_rt/hand/fixed"], "http", async () => new Response(""), { auth: "public", methods: ["GET"] });
  assert.deepEqual([...templateRouteCandidates("/zz_rt/infos")], ["tpl_a"]);
  assert.equal(templateRouteCandidates("/zz_rt/other").size, 0);
  // the hand's table alone does not have it; the template's does, with the merged route arguments
  assert.equal(matchPath("POST", "/zz_rt/infos", false).kind, "not_found");
  const m = matchPathFor("tpl_a", "POST", "/zz_rt/infos");
  assert.equal(m.kind, "match");
  if (m.kind === "match") {
    assert.equal(m.route.type, "jsonrpc");
    assert.equal(m.route.csrf, false);
  }
  assert.equal(matchPathFor("tpl_b", "POST", "/zz_rt/infos").kind, "not_found");
  // a hand pattern registered again by a template is an override of the hand's route
  assert.throws(() => templateRoute("tpl_a", ["/zz_rt/hand/<string:x>"], "http", async () => new Response(""), {}), /hand port serves/);
  assert.throws(() => templateRoute("tpl_a", ["/zz_rt/infos"], "jsonrpc", h, {}), /twice/);
  // both tables match one path: werkzeug's rule order is not modelled
  assert.throws(() => matchPathFor("tpl_a", "GET", "/zz_rt/hand/fixed"), NotPorted);
  // a path only the hand matches is the hand's
  assert.equal(matchPathFor("tpl_a", "POST", "/zz_rt/hand/other").kind, "match");
});
