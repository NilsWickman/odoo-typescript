import { strict as assert } from "node:assert";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { moveDecoderFile, pdfMayEmbedFiles } from "./move_import";

const enc = new TextEncoder();
const cat = (...parts: (string | Uint8Array)[]): Uint8Array => {
  const bufs = parts.map((p) => (typeof p === "string" ? enc.encode(p) : p));
  const out = new Uint8Array(bufs.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of bufs) { out.set(b, at); at += b.length; }
  return out;
};
const plain = enc.encode("%PDF-1.3\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
const objStm = (inner: string, dict = "/Filter /FlateDecode", data?: Uint8Array): Uint8Array => {
  const body = data ?? deflateSync(enc.encode(inner));
  return cat("%PDF-1.5\n5 0 obj\n<< /Type /ObjStm /N 1 /First 4 ", dict, ` /Length ${body.length} >>\nstream\n`, body, "\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
};

test("PDF: embedded files named in the text, escaped, or inside a compressed object stream", () => {
  assert.equal(pdfMayEmbedFiles(plain), false);
  assert.equal(pdfMayEmbedFiles(enc.encode("%PDF-1.7\n1 0 obj << /Type /Catalog /Names << /EmbeddedFiles 4 0 R >> >> endobj\n")), true);
  assert.equal(pdfMayEmbedFiles(enc.encode("%PDF-1.7\n1 0 obj << /Type /Catalog /Names << /Embedded#46iles 4 0 R >> >> endobj\n")), true);
  assert.equal(pdfMayEmbedFiles(objStm("1 0 << /Type /Catalog /Pages 2 0 R >>")), false);
  assert.equal(pdfMayEmbedFiles(objStm("1 0 << /Type /Catalog /Names << /EmbeddedFiles 4 0 R >> >>")), true);
  assert.equal(pdfMayEmbedFiles(objStm("1 0 << /Type /Catalog /Names << /EmbeddedFiles 4 0 R >> >>", "/Filter [/FlateDecode]")), true);
  assert.equal(pdfMayEmbedFiles(objStm("1 0 << /Type /Catalog /Pages 2 0 R >>", "/Filter [/FlateDecode]")), false);
});

test("PDF: object streams the port cannot read count as may", () => {
  assert.equal(pdfMayEmbedFiles(objStm("", "/Filter /LZWDecode", enc.encode("xx"))), true);
  assert.equal(pdfMayEmbedFiles(objStm("1 0 << >>", "/Filter /FlateDecode /DecodeParms << /Predictor 12 >>")), true);
  assert.equal(pdfMayEmbedFiles(objStm("", "/Filter /FlateDecode", enc.encode("not deflated"))), true);
});

test("the files an account.move decoder may take", () => {
  assert.match(moveDecoderFile("bill.xml", "application/xml", null)!, /XML/);
  assert.match(moveDecoderFile("bill.xml", "text/xml", null)!, /XML/);
  assert.match(moveDecoderFile("bill.xml", "text/plain", null)!, /XML/);
  assert.match(moveDecoderFile("bill.txt", "text/plain", enc.encode("﻿  <?xml version='1.0'?><Invoice/>"))!, /XML/);
  assert.equal(moveDecoderFile("note.txt", "text/plain", enc.encode("A note\n")), null);
  assert.equal(moveDecoderFile("logo.svg", "image/svg+xml", null), null); // ends with +xml, not /xml
  assert.equal(moveDecoderFile("logo.png", "image/png", null), null);
  assert.equal(moveDecoderFile("offer.pdf", "application/pdf", plain), null);
  assert.equal(moveDecoderFile("x.bin", "application/octet-stream", null), null); // not a PDF by mimetype or name
  assert.match(moveDecoderFile("scan.pdf", "application/octet-stream", enc.encode("%PDF-1.7 /EmbeddedFiles"))!, /embedded/);
});
