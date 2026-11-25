import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkPatterns, csvRead, DATE_PATTERNS, detectEncoding, sequenceRatio, sniffSeparator } from "./base_import_parse";

// Expected values printed by CPython 3.12 (difflib, csv).
test("difflib SequenceMatcher ratio, including autojunk", () => {
  assert.equal(sequenceRatio("country", "country_id"), 0.8235294117647058);
  assert.equal(sequenceRatio("tags", "category_id"), 0.26666666666666666);
  assert.equal(sequenceRatio("e-mail", "email"), 0.9090909090909091);
  assert.equal(sequenceRatio("xxxxx", "phone"), 0);
  assert.equal(sequenceRatio("abcabcabc".repeat(30), "cab".repeat(80)), 0);
});

test("csv.reader excel dialect", () => {
  assert.deepEqual(csvRead('a,b\r\n"x""y","p,q"\n\nz"w,2\n"r"s,3', ",", '"'), [["a", "b"], ['x"y', "p,q"], [], ['z"w', "2"], ["rs", "3"]]);
  const contacts = 'Name,Email,Phone,Country,Tags\nOrion Analytics,info@orion.example,+32 2 555 10 10,Belgium,Vendor\nLyra Studio,hello@lyra.example,+33 1 55 20 20 20,France,"Prospects,Services"\nVega Logistics,ops@vega.example,,Netherlands,\n';
  assert.equal(sniffSeparator(contacts, '"'), ",");
  assert.deepEqual(csvRead(contacts, ",", '"')[2], ["Lyra Studio", "hello@lyra.example", "+33 1 55 20 20 20", "France", "Prospects,Services"]);
  assert.equal(detectEncoding(new TextEncoder().encode(contacts)), "ascii");
});

test("date patterns", () => {
  assert.equal(checkPatterns(DATE_PATTERNS, ["Belgium", "France"]), null);
  assert.equal(checkPatterns(["%Y-%m-%d"], ["2024-01-31", ""]), "%Y-%m-%d");
});
