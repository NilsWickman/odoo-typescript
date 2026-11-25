import { test } from "node:test";
import assert from "node:assert/strict";
import { evalExpr, jsonDumps, literalEval, Markup, PyKwargs, pyStr, pyTuple, type Scope } from "./index";
import { NotPorted } from "../errors";

const scope = (o: Record<string, unknown> = {}): Scope => new Map(Object.entries(o));

test("names, constants, truthiness", () => {
  assert.equal(evalExpr("title or 'Odoo'", scope()), "Odoo");
  assert.equal(evalExpr("title or 'Odoo'", scope({ title: "X" })), "X");
  assert.equal(evalExpr("not login", scope({ login: "" })), true);
  assert.equal(evalExpr("databases and len(databases) > 1", scope({ databases: ["a"] })), false);
  assert.equal(evalExpr("databases and len(databases) > 1", scope({ databases: null })), null);
  assert.equal(evalExpr("'autofocus' if login else None", scope({ login: "admin" })), "autofocus");
  assert.equal(evalExpr("'autofocus' if login else None", scope()), null);
  assert.equal(evalExpr("None is None and True is not False", scope()), true);
  assert.equal(evalExpr("1 == True", scope()), true);
  assert.equal(evalExpr("1 < 2 < 3", scope()), true);
  assert.equal(evalExpr("1 < 3 < 2", scope()), false);
});

test("strings, in, methods", () => {
  assert.equal(evalExpr("'tests' in debug or test_mode_enabled", scope({ debug: "", test_mode_enabled: false })), false);
  assert.equal(evalExpr("'tests' in debug", scope({ debug: "assets,tests" })), true);
  assert.deepEqual(evalExpr("'a,b'.split(',')", scope()), ["a", "b"]);
  assert.equal(evalExpr("'Ab'.lower().startswith('a')", scope()), true);
  assert.equal(evalExpr("' x '.strip()", scope()), "x");
  assert.equal(evalExpr("'-'.join(['a', 'b'])", scope()), "a-b");
  assert.equal(evalExpr("'?dbname=' + db if db else ''", scope({ db: "poc" })), "?dbname=poc");
  assert.equal(evalExpr("'?dbname=' + db if db else ''", scope({ db: null })), "");
  assert.equal(evalExpr("'%s and %s' % ('a', 1)", scope()), "a and 1");
  assert.equal(evalExpr("'%(x)s!' % {'x': 2}", scope()), "2!");
  assert.equal(evalExpr("x[1:]", scope({ x: "abc" })), "bc");
  assert.equal(evalExpr("x[-1]", scope({ x: [1, 2, 3] })), 3);
});

test("dicts, lists, tuples, unpacking", () => {
  assert.equal(evalExpr("p.get('auth_link') or '#'", scope({ p: new Map([["auth_link", null]]) })), "#");
  assert.equal(evalExpr("p.get('icon') or 'login'", scope({ p: { icon: "qr_code" } })), "qr_code");
  assert.equal(evalExpr("p['body']", scope({ p: { body: "Use a Passkey" } })), "Use a Passkey");
  const d = evalExpr("{**a, **(b or {})}", scope({ a: { x: 1 }, b: null })) as Map<unknown, unknown>;
  assert.deepEqual([...d.entries()], [["x", 1]]);
  const merged = evalExpr("{**a, **b}", scope({ a: new Map([["x", 1]]), b: { x: 2, y: 3 } })) as Map<unknown, unknown>;
  assert.deepEqual([...merged.entries()], [["x", 2], ["y", 3]]);
  assert.deepEqual(evalExpr("auth_btns + passkey_btn", scope({ auth_btns: [], passkey_btn: [1] })), [1]);
  const lst = evalExpr("[{'css_class': 'oi oi-fw', 'icon': 'qr_code', 'body': passkey_body}]", scope({ passkey_body: "B" })) as Map<unknown, unknown>[];
  assert.equal(lst[0]!.get("body"), "B");
  assert.equal(evalExpr("html_data or {}", scope({ html_data: new Map([["style", "height: 100%;"]]) })) instanceof Map, true);
  assert.equal(pyStr(evalExpr("(1, 'a')", scope())), "(1, 'a')");
  assert.equal(pyStr(evalExpr("(1,)", scope())), "(1,)");
  assert.equal(evalExpr("x[0]", scope({ x: pyTuple([7]) })), 7);
  assert.equal(evalExpr("len(x) + len(y)", scope({ x: { a: 1 }, y: new Map() })), 1);
  assert.equal(evalExpr("'x' in d", scope({ d: { x: null } })), true);
  assert.equal(evalExpr("list(d.items())[0][1]", scope({ d: { x: 5 } })), 5);
});

test("arithmetic and str()", () => {
  assert.equal(evalExpr("7 // 2", scope()), 3);
  assert.equal(evalExpr("-7 % 3", scope()), 2);
  assert.equal(pyStr(evalExpr("7 / 2", scope())), "3.5");
  assert.equal(pyStr(evalExpr("4 / 2", scope())), "2.0");
  assert.equal(pyStr(evalExpr("2.0 + 1", scope())), "3.0");
  assert.equal(pyStr(evalExpr("1e16", scope())), "1e+16");
  assert.equal(pyStr(evalExpr("0.00001", scope())), "1e-05");
  assert.equal(pyStr(evalExpr("str(True) + str(None) + str(12)", scope())), "TrueNone12");
  assert.equal(evalExpr("int('42') + 1", scope()), 43);
  assert.equal(evalExpr("round(2.5)", scope()), 2);
  assert.equal(evalExpr("max([1, 5, 3])", scope()), 5);
});

test("attribute objects and calls with kwargs", () => {
  const request = { db: "poc", csrf_token: (t?: unknown) => `tok${t === undefined ? "" : String(t)}` };
  assert.equal(evalExpr("request.csrf_token(None)", scope({ request })), "toknull");
  assert.equal(evalExpr("request.csrf_token()", scope({ request })), "tok");
  assert.equal(evalExpr("request.db", scope({ request })), "poc");
  let seen: unknown = null;
  const f = (...args: unknown[]): unknown => {
    seen = args;
    return 1;
  };
  evalExpr("f(1, a=2)", scope({ f }));
  const [first, kw] = seen as unknown[];
  assert.equal(first, 1);
  assert.equal((kw as PyKwargs).entries.get("a"), 2);
  assert.throws(() => evalExpr("request.missing", scope({ request })), NotPorted);
  assert.equal(evalExpr("env['ir.http'].x", scope({ env: new Map([["ir.http", { x: 3 }]]) })), 3);
});

test("Markup", () => {
  assert.equal(pyStr(evalExpr("m + '<b>'", scope({ m: new Markup("<i>") }))), "<i>&lt;b&gt;");
  assert.equal(pyStr(evalExpr("'<b>' + m", scope({ m: new Markup("<i>") }))), "&lt;b&gt;<i>");
  assert.equal(pyStr(evalExpr("'Powered by %s%s' % (logo, _message and ('- ' + _message) or '')", scope({ logo: new Markup("<a>Odoo</a>"), _message: "" }))), "Powered by <a>Odoo</a>");
  assert.equal(pyStr(evalExpr("m % ('<x>', n)", scope({ m: new Markup("%s and %s"), n: new Markup("<y>") }))), "&lt;x&gt; and <y>");
});

test("json.dumps like CPython", () => {
  assert.equal(jsonDumps({ a: 1, b: [1.5, { float: 2 }, true, null, "é<>& "] }), '{"a": 1, "b": [1.5, 2.0, true, null, "\\u00e9<>&\\u2028"]}');
  assert.equal(jsonDumps(new Map<unknown, unknown>([[1, "x"], ["126", 2]])), '{"1": "x", "126": 2}');
  assert.equal(jsonDumps("a\"b\\c\n\u0001😀"), '"a\\"b\\\\c\\n\\u0001\\ud83d\\ude00"');
});

test("unsupported syntax is NotPorted", () => {
  assert.throws(() => evalExpr("[x for x in y]", scope()), NotPorted);
  assert.throws(() => evalExpr("lambda a: a", scope()), NotPorted);
  assert.throws(() => evalExpr("f(*a)", scope()), NotPorted);
  assert.throws(() => evalExpr("a | b", scope()), NotPorted);
  assert.throws(() => evalExpr("f'{x}'", scope()), NotPorted);
  assert.throws(() => evalExpr("x.__class__", scope({ x: 1 })), NotPorted);
  assert.throws(() => evalExpr("'a'.format(1)", scope()), NotPorted);
});

// The compiler thread's K2 edge cases that reach worker/src/pyexpr (docs/council/2026-11-04/fran-kompilatorn-2026-11-08.md)
test("K2: `*` width and precision in % formatting", () => {
  assert.equal(evalExpr("'%*d|' % (5, 42)", scope()), "   42|");
  assert.equal(evalExpr("'%-*d|' % (4, 7)", scope()), "7   |");
  assert.equal(evalExpr("'%*d|' % (-4, 7)", scope()), "7   |");
  assert.equal(evalExpr("'%.*f' % (2, 3.14159)", scope()), "3.14");
  assert.throws(() => evalExpr("'%*d' % (4.5, 1)", scope()), /\* wants int/);
  assert.throws(() => evalExpr("'%*d' % (4,)", scope()), /not enough arguments/);
});

test("K2: ast.literal_eval refuses what is not a literal", () => {
  assert.deepEqual(literalEval("{'a': [1, -2, (3.5,)], 'b': None}") instanceof Object, true);
  assert.equal(literalEval("-1"), -1);
  assert.equal(literalEval("  \t'x'"), "x");
  assert.throws(() => literalEval("--1"), /malformed node or string/);
  assert.throws(() => literalEval("-True"), /malformed node or string/);
  assert.throws(() => literalEval("active_id"), /malformed node or string/);
  assert.throws(() => literalEval("len('a')"), /malformed node or string/);
  assert.throws(() => literalEval("{**a}"), /malformed node or string/);
  assert.throws(() => literalEval("1 + 2j"), NotPorted);
});

test("a slice of an iterable object gives the object back (records[:1]), else the list", async () => {
  const { evalExprAsync, PyObject } = await import("./index");
  class Recs extends PyObject {
    constructor(readonly ids: number[]) { super(); }
    pyGetAttr(name: string): unknown { return name === "id" ? (this.ids[0] ?? false) : undefined; }
    override pyTruth(): boolean { return this.ids.length > 0; }
    override pyIter(): unknown[] { return this.ids.map((i) => new Recs([i])); }
    override pyFromSlice(items: unknown[]): unknown { return new Recs(items.flatMap((r) => (r as Recs).ids)); }
  }
  class Plain extends PyObject {
    pyGetAttr(): unknown { return undefined; }
    override pyIter(): unknown[] { return [1, 2, 3]; }
  }
  assert.equal(await evalExprAsync("r[:1].id", scope({ r: new Recs([7, 8]) })), 7);
  assert.equal(await evalExprAsync("r[:1].id", scope({ r: new Recs([]) })), false);
  assert.deepEqual(((await evalExprAsync("r[1:]", scope({ r: new Recs([7, 8, 9]) }))) as Recs).ids, [8, 9]);
  assert.deepEqual(await evalExprAsync("p[-2:]", scope({ p: new Plain() })), [2, 3]);
});
