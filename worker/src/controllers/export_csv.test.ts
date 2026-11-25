import { strict as assert } from "node:assert";
import { test } from "node:test";
import { cleanFilename, contentDispositionAttachment, csvFromData, csvRow } from "./export_csv";

// Expected values printed by CPython 3.12 csv.writer(quoting=1) and odoo.tools.osutil / odoo.http.stream (dd5d3718).
test("csv.writer QUOTE_ALL quoting, doubling and terminator", () => {
  assert.equal(csvRow(["a", 'b"c', "x,y\nz"]), '"a","b""c","x,y\nz"\r\n');
});

test("from_data: False/None empty, str() of numbers and booleans, formula guard on strings only", () => {
  const out = csvFromData(["H"], [["", 3, { float: 1.5 }, true, { float: 1e-5 }, { float: 2 }, -4, "'=1", false, null, "=SUM(A1)", "+32 1", "-x"]]);
  assert.equal(out, '"H"\r\n"","3","1.5","True","1e-05","2.0","-4","\'=1","","","\'=SUM(A1)","\'+32 1","\'-x"\r\n');
});

test("clean_filename and content_disposition", () => {
  assert.equal(contentDispositionAttachment(cleanFilename("Contact (res.partner).csv")), "attachment; filename*=UTF-8''Contact%20%28res.partner%29.csv");
  assert.equal(contentDispositionAttachment(cleanFilename("Société / Ém?l*.csv")), "attachment; filename*=UTF-8''Soci%C3%A9t%C3%A9%20%20%C3%89ml.csv");
  assert.equal(cleanFilename(".hidden-x"), "hidden-x");
  assert.equal(cleanFilename("CON.txt"), "Untitled");
  assert.equal(cleanFilename("a:b"), "ab");
});
