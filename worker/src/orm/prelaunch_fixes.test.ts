import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fillTemporalGroups, MAX_TEMPORAL_GROUPS, parseStrictNaive } from "../web/read_group";
import { writeEffect } from "../sql_cache";
import { htmlSanitize } from "./html_sanitize";
import { renderTextAttachmentHtml } from "../mail/attachment";
import { reprStrDict, spliceResponsibleSignature } from "../mail/notify";

describe("W2 ORM, SQL cache, QWeb & Mail fixes", () => {
  it("parseStrictNaive preserves low years (1..99) via setUTCFullYear and rejects invalid dates", () => {
    const d = parseStrictNaive("0001-01-01 00:00:00");
    assert.ok(d !== null);
    assert.equal(d!.year, 1);
    assert.equal(d!.month, 1);
    assert.equal(d!.day, 1);
    assert.equal(parseStrictNaive("2026-02-30"), null);
    assert.equal(parseStrictNaive("not-a-date"), null);
  });

  it("fillTemporalGroups rejects ranges exceeding MAX_TEMPORAL_GROUPS to prevent OOM DoS", async () => {
    assert.equal(MAX_TEMPORAL_GROUPS, 5000);
    const mockEnv = { reg: { model: () => ({ fields: new Map() }) } } as never;
    await assert.rejects(
      () => fillTemporalGroups(
        mockEnv,
        "sale.order",
        ["date_order:day"],
        ["__count"],
        [],
        { name: "date_order", type: "date" } as never,
        { fill_from: "0001-01-01", fill_to: "9999-12-31" },
      ),
      /Too many temporal groups/,
    );
    const small = await fillTemporalGroups(
      mockEnv,
      "sale.order",
      ["date_order:day"],
      ["__count"],
      [],
      { name: "date_order", type: "date" } as never,
      { fill_from: "2026-01-01", fill_to: "2026-01-03" },
    );
    assert.equal(small.length, 3);
  });

  it("writeEffect does not emit narrow updatedRows for UPDATE ... FROM ... joins", () => {
    const eff = writeEffect(
      "UPDATE sale_order_line l SET state = o.state FROM sale_order o WHERE l.order_id = o.id AND o.id = $1",
      [1],
    );
    assert.equal("updated" in eff ? eff.updated : null, null);
  });

  it("htmlSanitize handles out-of-range numeric HTML entities without throwing RangeError", () => {
    const out = htmlSanitize("<p>&#99999999; &#x110000; ok</p>", {
      sanitizeTags: true,
      sanitizeAttributes: true,
      sanitizeStyle: true,
      sanitizeForm: true,
      stripStyle: false,
      stripClasses: false,
      xmlOutput: false,
    });
    assert.ok(out.includes("ok"));
  });

  it("renderTextAttachmentHtml supports markdown, html, and pretty-printed JSON", () => {
    const md = renderTextAttachmentHtml(Buffer.from("# Title\n<script>x</script>"), "text/markdown", false);
    assert.ok(md.includes("Title"));
    assert.ok(!md.includes("<script>x</script>"));

    const json = renderTextAttachmentHtml(Buffer.from('{"a":1,"b":2}'), "application/json", false);
    assert.ok(json.includes("a") && json.includes("1") && json.includes("2") && json.includes("\n"));

    const jsonHead = renderTextAttachmentHtml(Buffer.from('{"a":1}'), "application/json", true);
    assert.equal(typeof jsonHead, "string");
  });

  it("reprStrDict strips CR/LF and escapes mixed quotes safely", () => {
    const out = reprStrDict([
      ["a", "line1\r\nline2"],
      ["b", "both 'single' and \"double\""],
    ]);
    assert.ok(!out.includes("\r"));
    assert.ok(!out.includes("\n"));
    assert.ok(out.includes("single"));
    assert.ok(out.includes("double"));
  });

  it("spliceResponsibleSignature preserves literal $& and $1 tokens in signatures", () => {
    const msgBody = "<p>Hello</p>";
    const body = `<main><div style="font-size: 13px;">${msgBody}</div>\n\n                \n            </main>`;
    const sig = "Best regards, Cost $& / $100";
    const result = spliceResponsibleSignature(body, msgBody, sig);
    assert.ok(result.includes("Cost $& / $100"));
    assert.ok(result.includes('class="o_signature"'));
  });
});
