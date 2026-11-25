// account_computes.ts qrMethodRows: the rows a compiled `_get_available_qr_methods` override returns through
// callPrivate. Before K2-base round 4 the label went through String(): a lazy label (compiler/runtime/install.ts
// privateKey gives `{kind: "lazy", ...}` since compiler-core4) became "[object Object]" in the selection, silently.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Markup } from "../pyexpr/values";
import { qrMethodRows } from "./qr_method_rows";

test("qr method rows: text and Markup labels, a PyFloat sequence; a lazy or other label refuses", () => {
  assert.deepEqual(qrMethodRows([["emv_qr", "EMV Merchant-Presented QR-code", 30], ["sct_qr", new Markup("SEPA <i>QR</i>"), { float: 20 }]]),
    [["emv_qr", "EMV Merchant-Presented QR-code", 30], ["sct_qr", "SEPA <i>QR</i>", 20]]);
  const lazy = { kind: "lazy", source: "EMV Merchant-Presented QR-code", module: "account_qr_code_emv" };
  assert.equal(String(lazy), "[object Object]"); // what the selection showed before
  for (const bad of [[["emv_qr", lazy, 30]], [["x", "y", "30"]], [["x", "y"]], "x"]) {
    assert.throws(() => qrMethodRows(bad), (e: unknown) => e instanceof Error && e.constructor.name === "NotPorted");
  }
});
