import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseCommands } from "./commands";
import { cacheEqual, convertToCache, convertToColumn, floatRound, floatRepr } from "./convert";
import type { FieldDef } from "./types";
import { emailNormalize, streetSplit } from "../models/partner_pure_write";

function field(type: FieldDef["type"], extra: Partial<Record<keyof FieldDef, unknown>> = {}): FieldDef {
  return { name: "f", type, digits: null, translate: false, selection: null, sanitize: null, ...extra } as unknown as FieldDef;
}

test("commands: Command triples and the shortcuts of _parse_write_commands", () => {
  assert.deepEqual(parseCommands([[4, 7]], "m.f"), [{ op: "link", id: 7 }]);
  assert.deepEqual(parseCommands([[6, 0, [1, 2]], [5], [3, 9], [2, 8]], "m.f"),
    [{ op: "set", ids: [1, 2] }, { op: "clear" }, { op: "unlink", id: 9 }, { op: "delete", id: 8 }]);
  assert.deepEqual(parseCommands([[0, "virtual_1", { name: "x" }], [1, 3, { a: 1 }]], "m.f"),
    [{ op: "create", ref: "virtual_1", values: { name: "x" } }, { op: "update", id: 3, values: { a: 1 } }]);
  assert.deepEqual(parseCommands([1, 2], "m.f"), [{ op: "set", ids: [1, 2] }]);
  assert.deepEqual(parseCommands(false, "m.f"), [{ op: "clear" }]);
  assert.deepEqual(parseCommands([], "m.f"), []);
  assert.throws(() => parseCommands("x", "m.f"), /Wrong value/);
});

test("float_round HALF-UP with digits, float_repr", () => {
  assert.equal(floatRound(1.123456789, 7), 1.1234568);
  assert.equal(floatRound(2.675, 2), 2.68);
  assert.equal(floatRound(-2.675, 2), -2.68);
  assert.equal(floatRound(0, 3), 0);
  assert.equal(floatRepr(1.1234568, 7), "1.1234568");
  assert.equal(floatRepr(-0.00000001, 7), "0.0000000");
});

test("convert_to_cache per type", () => {
  assert.equal(convertToCache(field("many2one"), 5, "m"), 5);
  assert.equal(convertToCache(field("many2one"), [381, "x"], "m"), null); // fields_relational.py:326-349
  assert.equal(convertToCache(field("many2one"), { id: 345 }, "m"), 345);
  assert.equal(convertToCache(field("many2one"), false, "m"), null);
  assert.equal(convertToCache(field("boolean"), 0, "m"), false);
  assert.equal(convertToCache(field("integer"), false, "m"), 0);
  assert.equal(convertToCache(field("float"), false, "m"), 0); // 0.0 is stored, not NULL (12.10)
  assert.equal(convertToCache(field("float", { digits: [10, 7] }), 1.123456789, "m"), 1.1234568);
  assert.equal(convertToCache(field("char"), false, "m"), null);
  assert.equal(convertToCache(field("char"), "a", "m"), "a");
  // a lone <p> around plain text is html_sanitize's identity (convert.ts); other markup is not ported
  assert.equal(convertToCache(field("html", { sanitize: { sanitize: true } }), "<p>x</p>", "m"), "<p>x</p>");
  assert.throws(() => convertToCache(field("html", { sanitize: { sanitize: true } }), "<p><b>x</b></p>", "m"), /not ported/);
  assert.throws(() => convertToCache(field("selection", { selection: [{ value: "a", label: "A", labels: {} }] }), "b", "m"), /Wrong value/);
  assert.equal(convertToCache(field("selection"), "xx_XX", "m"), "xx_XX"); // callable selections are not validated
  assert.equal(convertToCache(field("json"), {}, "m"), null);
});

test("convert_to_column", () => {
  assert.equal(convertToColumn(field("char", { translate: true }), "Leuven", "en_US"), JSON.stringify({ en_US: "Leuven" }));
  assert.equal(convertToColumn(field("char", { translate: true }), "Gand", "fr_FR"), JSON.stringify({ en_US: "Gand", fr_FR: "Gand" }));
  assert.equal(convertToColumn(field("float", { digits: [10, 7] }), 0, "en_US"), "0.0000000");
  assert.equal(convertToColumn(field("many2one"), 0, "en_US"), null);
});

test("snapshot equality: binary values compare by identity", () => {
  const a = { filename: "x", size: 1, checksum: "c", mimetype: "m", content: async () => new Uint8Array() };
  const b = { ...a };
  assert.equal(cacheEqual(a, a), true);
  assert.equal(cacheEqual(a, b), false);
  assert.equal(cacheEqual([1, 2], [1, 2]), true);
  assert.equal(cacheEqual({ x: [1] }, { x: [1] }), true);
  assert.equal(cacheEqual(null, false), false);
});

test("street_split (business_data.py:99)", () => {
  assert.deepEqual(streetSplit("1 Moon Street"), { street_name: "Moon Street", street_number: "1", street_number2: "" });
  assert.deepEqual(streetSplit("Rue de la Loi 16"), { street_name: "Rue de la Loi", street_number: "16", street_number2: "" });
  assert.deepEqual(streetSplit("Main Street, 12 - 3B"), { street_name: "Main Street", street_number: "12", street_number2: "3B" });
  // cases checked against the Python regexes
  assert.deepEqual(streetSplit("Avenue Louise 54, bte 3"), { street_name: "Avenue Louise 54", street_number: "", street_number2: "" });
  assert.deepEqual(streetSplit("Chaussée de Waterloo 1234/5"), { street_name: "Chaussée de Waterloo", street_number: "1234/5", street_number2: "" });
  assert.deepEqual(streetSplit("12, rue X"), { street_name: "rue X", street_number: "12", street_number2: "" });
  assert.deepEqual(streetSplit("Weg 3a - 2"), { street_name: "Weg", street_number: "3a", street_number2: "2" });
  assert.deepEqual(streetSplit(null), { street_name: "", street_number: "", street_number2: "" });
});

test("email_normalize of plain addresses", () => {
  assert.equal(emailNormalize("Hello@NightOwl.Example"), "hello@nightowl.example");
  assert.equal(emailNormalize(null), null);
  assert.throws(() => emailNormalize("Name <a@b.c>"), /not ported/);
});
