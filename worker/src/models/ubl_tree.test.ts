import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseXml } from "../xml";
import { bis3Tree, find, findall, findtext } from "./ubl_tree";

const enc = new TextEncoder();
const doc = (inner: string, root = "Invoice", ns = "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"): Uint8Array =>
  enc.encode(`<?xml version="1.0" encoding="UTF-8"?><${root} xmlns="${ns}" xmlns:cbc="urn:cbc" xmlns:cac="urn:cac">${inner}</${root}>`);
const BIS3 = "<cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>";

test("ElementPath: {*} by local name, children, descendants, a predicate, findtext of an empty element", () => {
  const t = parseXml(`<r xmlns:a="u"><a:P><a:ID schemeID="0160">1</a:ID><ID schemeID="X">2</ID><x><a:ID/></x></a:P><a:Q><a:ID>3</a:ID></a:Q></r>`);
  assert.deepEqual(findall(t, "./{*}P/{*}ID").map((e) => e.text), ["1", "2"]);
  assert.deepEqual(findall(t, ".//{*}ID").map((e) => e.text), ["1", "2", null, "3"]);
  assert.equal(findtext(t, `./{*}P/{*}ID[@schemeID="X"]`), "2");
  assert.equal(findtext(t, ".//{*}P//{*}x/{*}ID"), "");
  assert.equal(findtext(t, "{*}Q/{*}ID"), "3");
  assert.equal(find(t, "./{*}Z"), null);
  assert.equal(findtext(t, "./{*}Z"), null);
});

test("the decoder of a file (account_edi_ubl_cii account_move.py:214-242): only BIS 3 is taken", () => {
  assert.equal(bis3Tree(doc(BIS3)).tag, "Invoice");
  assert.equal(bis3Tree(doc("<cbc:CustomizationID>urn:cen.eu:en16931:2017#other</cbc:CustomizationID>")).tag, "Invoice");
  assert.throws(() => bis3Tree(doc("<cbc:UBLVersionID>2.1</cbc:UBLVersionID>")), /UBL 2.1/);
  assert.throws(() => bis3Tree(doc("<cbc:CustomizationID>urn:xrechnung</cbc:CustomizationID>")), /XRechnung/);
  assert.throws(() => bis3Tree(doc("", "AttachedDocument")), /AttachedDocument/);
  assert.throws(() => bis3Tree(doc("", "rsm:CrossIndustryInvoice", "x").subarray(0)), /no EDI decoder|CII/);
  assert.throws(() => bis3Tree(enc.encode(`<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"/>`)), /CII/);
  assert.throws(() => bis3Tree(doc("<a>")), /does not parse/);
  assert.throws(() => bis3Tree(doc(`${BIS3}<!-- c -->`)), /comments/);
  assert.throws(() => bis3Tree(enc.encode(`<?xml version="1.0" encoding="ISO-8859-1"?><Invoice/>`)), /ISO-8859-1/);
  assert.throws(() => bis3Tree(doc("<x/>")), /no EDI decoder/);
});
