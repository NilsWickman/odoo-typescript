import { test } from "node:test";
import assert from "node:assert/strict";
import { handTakes, logicalLines, parseProgram } from "./server_action_code";
import { NotPorted } from "../errors";

test("server action code: comments stripped, bracketed lines joined", () => {
  const lines = logicalLines("x = {  # open\n    'a': 1,\n    'b': '#not a comment',\n}\n\n# whole line\nif x:\n    y = 2  # trailing\n");
  assert.deepEqual(lines, [
    { indent: 0, text: "x = { 'a': 1, 'b': '#not a comment', }" },
    { indent: 0, text: "if x:" },
    { indent: 4, text: "y = 2" },
  ]);
});

test("server action code: for, if/elif/else, assignment and raise parse", () => {
  const stmts = parseProgram("for rec in records:\n    if rec.a:\n        pass\n    elif rec.b:\n        rec.write({'c': 1})\n    else:\n        raise UserError('no')\naction = False");
  assert.equal(stmts.length, 2);
  assert.equal(stmts[0]!.kind, "for");
  assert.equal(stmts[1]!.kind, "assign");
  const loop = stmts[0] as { body: { kind: string; branches: unknown[] }[] };
  assert.equal(loop.body[0]!.kind, "if");
  assert.equal(loop.body[0]!.branches.length, 3);
});

for (const [what, code] of [
  ["tabs", "if x:\n\ty = 1"],
  ["triple quotes", "x = '''a'''"],
  ["a string over lines", "x = 'a\nb'"],
  ["a backslash continuation", "x = 1 + \\\n 2"],
  ["while", "while x:\n    pass"],
  ["def", "def f():\n    pass"],
  ["import", "import os"],
  ["augmented assignment", "x += 1"],
  ["tuple targets", "a, b = 1, 2"],
  ["a one-line compound statement", "if x: y = 1"],
  ["an unexpected indent", "x = 1\n    y = 2"],
  ["a missing block", "if x:\ny = 1"],
  ["a raise of another exception", "raise ValueError('x')"],
  ["an unclosed bracket", "x = (1,"],
] as const) {
  test(`server action code: ${what} refuses`, () => {
    assert.throws(() => parseProgram(code), NotPorted);
  });
}

test("server action code: attribute and subscript assignments parse for the compiled runner, not this interpreter", () => {
  const stmts = parseProgram("action['domain'] = [('a', '=', 1)]\nrec.name = 'x'\nok = a == b");
  assert.deepEqual(stmts.map((s) => s.kind), ["store", "store", "assign"]);
  assert.equal(handTakes("action = {}\naction['domain'] = []"), false);
});

test("server action code: what this interpreter takes (compiler/cron_scan.py \"before\")", () => {
  assert.equal(handTakes("for rec in records:\n    rec.write({'comment': 'x %s' % rec.name})\naction = {'type': 'ir.actions.client'}"), true);
  assert.equal(handTakes("records.write({'a': 1})\nif len(records) > 1:\n    raise UserError('one')"), true);
  // a method this interpreter does not answer, a name outside its eval context, code it cannot read
  assert.equal(handTakes("records.action_confirm()"), false);
  assert.equal(handTakes("env['lunch.supplier'].browse([3])._send_auto_email()"), false);
  assert.equal(handTakes("x = datetime.date.today()"), false);
  assert.equal(handTakes("while x:\n    pass"), false);
});
