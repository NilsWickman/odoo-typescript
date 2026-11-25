import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  and, cond, equalDomains, FALSE, localMidnightToUtc, negate, not, optimizeBasic, or,
  parseDomain, parseIsoDate, PyDate, PyDateTime, PyValueError, toList, TRUE,
} from "./domain";
import type { DomainField, DomainModel } from "./domain";
import type { Domain, FieldType } from "./types";

function field(name: string, type: FieldType, extra: Partial<DomainField> = {}): DomainField {
  return { name, type, comodel: null, required: false, notNull: false, selection: null, ...extra };
}

const models: Record<string, Record<string, DomainField>> = {
  "res.partner": {
    id: field("id", "integer", { required: true, notNull: true }),
    display_name: field("display_name", "char"),
    name: field("name", "char"),
    email: field("email", "char"),
    active: field("active", "boolean"),
    color: field("color", "integer"),
    create_date: field("create_date", "datetime"),
    date: field("date", "date"),
    parent_id: field("parent_id", "many2one", { comodel: "res.partner" }),
    country_id: field("country_id", "many2one", { comodel: "res.country" }),
    state_id: field("state_id", "many2one", { comodel: "res.country.state" }),
    category_id: field("category_id", "many2many", { comodel: "res.partner.category" }),
    child_ids: field("child_ids", "one2many", { comodel: "res.partner" }),
    type: field("type", "selection", { selection: ["contact", "invoice"] }),
    company_id: field("company_id", "many2one", { comodel: "res.company", required: true, notNull: true }),
  },
  "res.country": { id: field("id", "integer"), display_name: field("display_name", "char"), name: field("name", "char"), code: field("code", "char") },
  "res.country.state": { id: field("id", "integer"), display_name: field("display_name", "char"), name: field("name", "char") },
  "res.partner.category": { id: field("id", "integer"), display_name: field("display_name", "char"), name: field("name", "char") },
  "res.company": { id: field("id", "integer"), display_name: field("display_name", "char"), name: field("name", "char") },
};

function model(name: string, tz = "UTC"): DomainModel {
  const fields = models[name];
  if (fields === undefined) throw new Error(name);
  return {
    name, tz,
    field: (f) => fields[f],
    comodel: (n) => model(n, tz),
  };
}

const partner = model("res.partner");

function opt(list: unknown): unknown[] {
  return toList(optimizeBasic(parseDomain(list), partner));
}

test("parse prefix notation: implicit AND, explicit operators, TRUE for []", () => {
  assert.deepEqual(parseDomain([]), TRUE);
  const d = parseDomain([["a", "=", 1], "|", ["b", "=", 2], "!", ["c", "=", 3]]);
  assert.deepEqual(d, {
    kind: "and",
    args: [
      { kind: "cond", path: "a", op: "=", value: 1 },
      { kind: "or", args: [{ kind: "cond", path: "b", op: "=", value: 2 }, { kind: "cond", path: "c", op: "!=", value: 3 }] },
    ],
  });
  assert.deepEqual(toList(d), ["&", ["a", "=", 1], "|", ["b", "=", 2], ["c", "!=", 3]]);
});

test("parse: malformed domains raise ValueError, any! is refused from the outside, None becomes False", () => {
  assert.throws(() => parseDomain(["&", ["a", "=", 1]]), PyValueError);
  assert.throws(() => parseDomain([["a", "any!", []]]), PyValueError);
  assert.throws(() => parseDomain([["a", "bogus", 1]]), PyValueError);
  assert.deepEqual(parseDomain([["a", "=", null]]), { kind: "cond", path: "a", op: "=", value: false });
});

test("boolean algebra: flatten, absorb constants, NOT pushdown", () => {
  const a = cond("a", "in", [1]);
  const b = cond("b", "in", [2]);
  assert.deepEqual(and([a, and([b, TRUE])]), { kind: "and", args: [a, b] });
  assert.deepEqual(and([a, FALSE]), FALSE);
  assert.deepEqual(or([a, TRUE]), TRUE);
  assert.deepEqual(or([FALSE]), FALSE);
  assert.deepEqual(not(and([a, b])), { kind: "or", args: [cond("a", "not in", [1]), cond("b", "not in", [2])] });
  assert.deepEqual(not(cond("a.b", "=", 1)), { kind: "not", arg: cond("a.b", "=", 1) });
});

test("= becomes in with a set; != becomes not in; duplicates removed (domains.py:1348, :1371)", () => {
  assert.deepEqual(opt([["name", "=", "x"]]), [["name", "in", ["x"]]]);
  assert.deepEqual(opt([["name", "!=", "x"]]), [["name", "not in", ["x"]]]);
  assert.deepEqual(opt([["color", "in", [1, 1, 2]]]), [["color", "in", [1, 2]]]);
  assert.deepEqual(opt([["color", "in", 3]]), [["color", "in", [3]]]);
});

test("empty collections: in [] is FALSE, != [] means set (domains.py:1357, :1381)", () => {
  assert.deepEqual(opt([["color", "in", []]]), [[0, "=", 1]]);
  assert.deepEqual(opt([["color", "not in", []]]), [[1, "=", 1]]);
  assert.deepEqual(opt([["name", "!=", []]]), [["name", "not in", [false]]]);
});

test("False is dropped from id and NOT NULL required fields (domains.py:1390)", () => {
  assert.deepEqual(opt([["id", "in", [1, false]]]), [["id", "in", [1]]]);
  assert.deepEqual(opt([["company_id", "in", [1, false]]]), [["company_id", "in", [1]]]);
  assert.deepEqual(opt([["parent_id", "in", [1, false]]]), [["parent_id", "in", [1, false]]]);
});

test("dotted paths become any (domains.py:992)", () => {
  assert.deepEqual(opt([["country_id.code", "=", "BE"]]), [["country_id", "any", [["code", "in", ["BE"]]]]]);
  assert.deepEqual(opt([["parent_id.country_id.code", "ilike", "be"]]),
    [["parent_id", "any", [["country_id", "any", [["code", "ilike", "be"]]]]]]);
});

test("string value on a relational field is a display_name search (domains.py:1516)", () => {
  assert.deepEqual(opt([["country_id", "ilike", "Bel"]]), [["country_id", "any", [["display_name", "ilike", "Bel"]]]]);
  assert.deepEqual(opt([["country_id", "not ilike", "Bel"]]), [["country_id", "not any", [["display_name", "ilike", "Bel"]]]]);
  assert.deepEqual(opt([["country_id", "=", "Belgium"]]), [["country_id", "any", [["display_name", "in", ["Belgium"]]]]]);
  assert.deepEqual(opt([["country_id", "in", ["Belgium", 5]]]),
    ["|", ["country_id", "in", [5]], ["country_id", "any", [["display_name", "in", ["Belgium"]]]]]);
  assert.deepEqual(opt([["country_id", "not in", ["Belgium", 5]]]),
    ["&", ["country_id", "not in", [5]], ["country_id", "not any", [["display_name", "in", ["Belgium"]]]]]);
  assert.deepEqual(opt([["country_id", "in", [5]]]), [["country_id", "in", [5]]]);
});

test("any on id is the sub-domain itself; any with an empty comodel domain is a constant (domains.py:1421, :1481)", () => {
  assert.deepEqual(opt([["id", "any", [["name", "=", "x"]]]]), [["name", "in", ["x"]]]);
  assert.deepEqual(opt([["country_id", "any", [["code", "in", []]]]]), [[0, "=", 1]]);
  assert.deepEqual(opt([["country_id", "not any", [["code", "in", []]]]]), [[1, "=", 1]]);
  assert.throws(() => opt([["name", "any", [["code", "=", 1]]]]), PyValueError);
});

test("like with an empty pattern (domains.py:1496)", () => {
  assert.deepEqual(opt([["name", "ilike", ""]]), [[1, "=", 1]]);
  assert.deepEqual(opt([["name", "not ilike", ""]]), [[0, "=", 1]]);
  assert.deepEqual(opt([["name", "=like", ""]]), [["name", "in", [false]]]);
  assert.deepEqual(opt([["name", "not =like", false]]), [["name", "not in", [false]]]);
  assert.deepEqual(opt([["country_id", "ilike", ""]]), [["country_id", "not in", [false]]]);
  assert.deepEqual(opt([["name", "like", 5]]), [["name", "like", "5"]]);
});

test("booleans compare to [True] (domains.py:1557)", () => {
  assert.deepEqual(opt([["active", "=", false]]), [["active", "not in", [true]]]);
  assert.deepEqual(opt([["active", "!=", false]]), [["active", "in", [true]]]);
  assert.deepEqual(opt([["active", "=", true]]), [["active", "in", [true]]]);
  assert.deepEqual(opt([["active", "in", ["yes"]]]), [["active", "in", [true]]]);
  assert.throws(() => opt([["active", ">", true]]), PyValueError);
});

test("negation of inequalities adds the null check only for fields without a falsy value (domains.py:897)", () => {
  assert.deepEqual(toList(negate(cond("color", ">", 3), partner)), [["color", "<=", 3]]);
  const d = negate(cond("create_date", ">", new PyDateTime(0)), partner);
  assert.equal(d.kind, "or");
  assert.deepEqual(toList(d), ["|", ["create_date", "in", [false]], ["create_date", "<=", "1970-01-01 00:00:00"]]);
  assert.deepEqual(opt(["!", ["name", "=", "x"]]), [["name", "not in", ["x"]]]);
  assert.deepEqual(opt(["!", "&", ["name", "=", "x"], ["color", "=", 1]]), ["|", ["color", "not in", [1]], ["name", "not in", ["x"]]]);
});

test("date values (domains.py:1612)", () => {
  assert.deepEqual(opt([["date", ">=", "2026-01-02"]]), [["date", ">=", "2026-01-02"]]);
  assert.deepEqual(opt([["date", "=", "2026-01-02 10:00:00"]]), [["date", "in", ["2026-01-02"]]]);
  assert.deepEqual(opt([["date", ">", false]]), [[0, "=", 1]]);
  assert.deepEqual(opt([["date", "=", false]]), [["date", "in", [false]]]);
  assert.throws(() => opt([["date", "=", 12]]), PyValueError);
});

test("datetime inequalities: > adds a second, <= becomes <; dates add a day (domains.py:1681)", () => {
  assert.deepEqual(opt([["create_date", ">", "2026-01-02 10:00:00"]]), [["create_date", ">=", "2026-01-02 10:00:01"]]);
  assert.deepEqual(opt([["create_date", "<=", "2026-01-02 10:00:00"]]), [["create_date", "<", "2026-01-02 10:00:01"]]);
  assert.deepEqual(opt([["create_date", "<", "2026-01-02 10:00:00.5"]]), [["create_date", "<", "2026-01-02 10:00:00"]]);
  assert.deepEqual(opt([["create_date", ">", "2026-01-02"]]), [["create_date", ">=", "2026-01-03 00:00:00"]]);
  assert.deepEqual(opt([["create_date", "<=", "2026-01-02"]]), [["create_date", "<", "2026-01-03 00:00:00"]]);
  assert.deepEqual(opt([["create_date", ">", false]]), [[0, "=", 1]]);
  assert.deepEqual(opt([["create_date", ">", "9999-12-31 23:59:59"]]), [[0, "=", 1]]);
  assert.deepEqual(opt([["create_date", "<=", "9999-12-31 23:59:59"]]), [["create_date", "not in", [false]]]);
});

// Expected values are Odoo's own `Domain(...).optimize(env['res.partner'])` (odoo-bin shell, 2026-11-10).
test("n-ary children are sorted and merged (domains.py:671-702, :1224, :2038-2177)", () => {
  assert.deepEqual(opt(["&", ["state_id", "!=", 3], "&", ["state_id", "not in", [4, 3]], ["name", "ilike", "a"]]),
    ["&", ["name", "ilike", "a"], ["state_id", "not in", [3, 4]]]);
  assert.deepEqual(opt(["|", ["state_id", "=", 3], ["state_id", "in", [4, 5]]]), [["state_id", "in", [3, 4, 5]]]);
  assert.deepEqual(opt(["&", ["state_id", "in", [3, 4, 5]], ["state_id", "in", [5, 4]]]), [["state_id", "in", [4, 5]]]);
  assert.deepEqual(opt(["|", ["country_id", "any", [["code", "=", "BE"]]], ["country_id", "any", [["code", "=", "FR"]]]]),
    [["country_id", "any", [["code", "in", ["BE", "FR"]]]]]);
  assert.deepEqual(opt(["&", ["category_id", "in", [1]], ["category_id", "in", [2]]]),
    ["&", ["category_id", "in", [1]], ["category_id", "in", [2]]]);
  assert.deepEqual(opt(["|", ["category_id", "in", [1]], ["category_id", "in", [2]]]), [["category_id", "in", [1, 2]]]);
  assert.deepEqual(opt(["&", "|", ["name", "=", "a"], ["color", "=", 1], "|", ["name", "=", "a"], ["color", "=", 1]]),
    ["|", ["color", "in", [1]], ["name", "in", ["a"]]]);
});

test("datetime equality compares the whole second (domains.py:1718)", () => {
  assert.deepEqual(opt([["create_date", "=", "2026-01-02 10:00:00"]]),
    ["&", ["create_date", "<", "2026-01-02 10:00:01"], ["create_date", ">=", "2026-01-02 10:00:00"]]);
  // ~(a >= x & a < y) -> (a in [False] | a < x) | (a in [False] | a >= y), same conditions merged (domains.py:2159)
  assert.deepEqual(opt([["create_date", "!=", "2026-01-02 10:00:00"]]),
    ["|", "|", ["create_date", "in", [false]], ["create_date", "<", "2026-01-02 10:00:00"], ["create_date", ">=", "2026-01-02 10:00:01"]]);
  assert.deepEqual(opt([["create_date", "in", ["2026-01-02 10:00:00", false]]]),
    ["|", ["create_date", "in", [false]], "&", ["create_date", "<", "2026-01-02 10:00:01"], ["create_date", ">=", "2026-01-02 10:00:00"]]);
});

test("a date for a datetime field is midnight in the user's timezone (domains.py:1668)", () => {
  const brussels = model("res.partner", "Europe/Brussels");
  const d = optimizeBasic(parseDomain([["create_date", ">=", "2026-01-02"]]), brussels);
  assert.deepEqual(toList(d), [["create_date", ">=", "2026-01-01 23:00:00"]]);
  const summer = optimizeBasic(parseDomain([["create_date", "<", "2026-07-02"]]), brussels);
  assert.deepEqual(toList(summer), [["create_date", "<", "2026-07-01 22:00:00"]]);
  assert.equal(localMidnightToUtc(new PyDate(Date.UTC(2026, 0, 2)), "UTC").toString(), "2026-01-02 00:00:00");
  // years 1 and 9999 are not shifted
  assert.deepEqual(toList(optimizeBasic(parseDomain([["create_date", "<", "9999-12-31"]]), brussels)), [["create_date", "<", "9999-12-31 00:00:00"]]);
});

test("ISO parsing refuses timezones; relative dates pass the basic level unchanged (domains.py:1657-1663)", () => {
  assert.throws(() => parseIsoDate("2026-01-02T10:00:00+02:00"), PyValueError);
  assert.equal(parseIsoDate("2026-01-02T10:00:00").toString(), "2026-01-02 10:00:00");
  assert.deepEqual(opt([["create_date", ">=", "today"]]), [["create_date", ">=", "today"]]);
  assert.deepEqual(opt([["create_date", ">=", "-1y"]]), [["create_date", ">=", "-1y"]]);
  assert.throws(() => opt([["create_date", ">=", "yesterday"]]), /not ported: relative date/);
});

test("optimization is idempotent and equalDomains is structural", () => {
  const once = optimizeBasic(parseDomain([["country_id", "ilike", "Bel"], ["active", "=", false], "!", ["color", ">", 1]]), partner);
  const twice = optimizeBasic(once, partner);
  assert.ok(equalDomains(once, twice));
  assert.equal(once, twice);
});

test("sub-domains of any are optimized against the comodel", () => {
  assert.deepEqual(opt([["category_id", "any", [["name", "=", "x"]]]]), [["category_id", "any", [["name", "in", ["x"]]]]]);
  const d: Domain = cond("child_ids", "any", cond("country_id", "=", "BE"));
  assert.deepEqual(toList(optimizeBasic(d, partner)), [["child_ids", "any", [["country_id", "any", [["display_name", "in", ["BE"]]]]]]]);
});
