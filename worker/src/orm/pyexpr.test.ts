import { strict as assert } from "node:assert";
import { test } from "node:test";
import { evalPyExpr, parsePyExpr, pyExprNames } from "./pyexpr";

const resolve = (path: readonly string[]): unknown => {
  const key = path.join(".");
  const values: Record<string, unknown> = {
    "user.id": 5, "user.ids": [5], "user.partner_id.id": 6, "user.commercial_partner_id.id": 6,
    "user.all_group_ids.ids": [1, 7, 8, 13], "company_ids": [1, 2], "company_id": 1,
  };
  if (!(key in values)) throw new Error(`not ported: ${key}`);
  return values[key];
};

function ev(src: string): unknown {
  return evalPyExpr(parsePyExpr(src), resolve);
}

test("the ir.access domain forms of poc_corpus evaluate", () => {
  assert.deepEqual(ev("[('id', 'child_of', user.commercial_partner_id.id)]"), [["id", "child_of", 6]]);
  assert.deepEqual(ev("[('id', '=', user.partner_id.id)]"), [["id", "=", 6]]);
  assert.deepEqual(ev("['|', '|', ('partner_share', '=', False), ('company_id', 'parent_of', company_ids), ('company_id', '=', False)]"),
    ["|", "|", ["partner_share", "=", false], ["company_id", "parent_of", [1, 2]], ["company_id", "=", false]]);
  assert.deepEqual(ev("[('id','in', company_ids)]"), [["id", "in", [1, 2]]]);
  assert.deepEqual(ev("[('user_ids', 'in', user.ids)]"), [["user_ids", "in", [5]]]);
  assert.deepEqual(ev("[('user_id', 'in', [user.id, False])]"), [["user_id", "in", [5, false]]]);
  assert.deepEqual(ev("['|', ('create_uid', '=', user.id), ('group_ids', 'in', user.all_group_ids.ids)]"),
    ["|", ["create_uid", "=", 5], ["group_ids", "in", [1, 7, 8, 13]]]);
  assert.deepEqual(ev("[('channel_id.channel_type', 'not in', ('channel', 'chat'))]"), [["channel_id.channel_type", "not in", ["channel", "chat"]]]);
  assert.deepEqual(ev(`
                [
                    "|",
                        "&",
                            ("channel_type", "!=", "channel"),
                            ("is_member", "=", True),
                        ("group_public_id", "=", False),
                ]
             `), ["|", "&", ["channel_type", "!=", "channel"], ["is_member", "=", true], ["group_public_id", "=", false]]);
  assert.deepEqual(ev("[('company_id', 'parent_of', company_ids), ('company_id', '=', False)]"),
    [["company_id", "parent_of", [1, 2]], ["company_id", "=", false]]);
});

test("list concatenation of the multi-company rules (company_ids + [False])", () => {
  assert.deepEqual(ev("[('company_id', 'in', company_ids + [False])]"), [["company_id", "in", [1, 2, false]]]);
});

test("strings with escapes and both quote styles", () => {
  assert.deepEqual(ev(`['it\\'s', "say \\"hi\\"", 'a\\nb']`), ["it's", 'say "hi"', "a\nb"]);
});

test("unsupported Python raises NotPorted, unknown names are reported", () => {
  assert.throws(() => ev("[('x', '=', user.id + 1)]"), /not ported/); // only list/str + is ported
  assert.throws(() => parsePyExpr("[('x', '=', time.strftime('%Y'))]"), /not ported/);
  assert.throws(() => parsePyExpr("{'a': 1}"), /not ported/);
  assert.throws(() => ev("[('x', '=', user.name)]"), /not ported: user.name/);
  assert.deepEqual(pyExprNames(parsePyExpr("[('a', '=', user.id), ('b', 'in', company_ids)]")), ["user.id", "company_ids"]);
});
