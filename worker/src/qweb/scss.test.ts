import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { NotPorted } from "../errors";
import { compileCompanyScss, renderCompanyReportCss } from "./scss";

test("company styles: nesting, parent selector, rgba of a hex colour, declared functions dropped", () => {
  const css = compileCompanyScss(`
    // comment
    @function preview-color-contrast($background) {
      @if (lightness($background) > 50) { @return black; } @else { @return white; }
    }
    .o_bg_color_15 { background-color: rgba(0, 0, 0, .15); }
    .o_color_company_1 {
      .o_border_color { border-color: #5e4766; }
      &.o_bg_color, .o_bg_color { background-color: #5e4766; }
      .o_bg_color_15 { background-color: rgba(#5e4766, .15); }
    }`);
  assert.equal(css, [
    ".o_bg_color_15 {\n  background-color: rgba(0, 0, 0, 0.15);\n}",
    ".o_color_company_1 .o_border_color {\n  border-color: #5e4766;\n}",
    ".o_color_company_1.o_bg_color, .o_color_company_1 .o_bg_color {\n  background-color: #5e4766;\n}",
    ".o_color_company_1 .o_bg_color_15 {\n  background-color: rgba(94, 71, 102, 0.15);\n}",
  ].join("\n\n") + "\n");
});

test("mix, preview-color-contrast and @for match libsass", () => {
  const css = compileCompanyScss(`
    .a {
      c1: mix(white, #5e4766, 40%);
      c2: mix(white, #5e4766, 90%);
      c3: mix(white, #5e4766, 92%);
      c4: preview-color-contrast(#5e4766);
      c5: preview-color-contrast(#aabbcc);
      c6: preview-color-contrast(mix(white, #5e4766, 40%));
      @for $i from 1 through 2 {
        .o_lines_path_#{$i} { stroke: mix(white, #212529, $i * 8%); }
      }
    }`);
  assert.equal(css, [
    ".a {\n  c1: #9e91a3;\n  c2: #efedf0;\n  c3: #f2f0f3;\n  c4: white;\n  c5: black;\n  c6: black;\n}",
    ".a .o_lines_path_1 {\n  stroke: #33363a;\n}",
    ".a .o_lines_path_2 {\n  stroke: #45484b;\n}",
  ].join("\n\n") + "\n");
});

test("renderCompanyReportCss reproduces precompiled web.report_assets_common slices byte-for-byte", () => {
  const dir = join(import.meta.dirname, "../../gen/out/poc_erp/bundles");
  const sliceOf = (file: string): string => {
    const raw = readFileSync(join(dir, file), "utf8");
    const marker = "/* web/static/asset_styles_company_report.scss */\n ";
    const start = raw.indexOf(marker);
    assert.ok(start >= 0);
    const end = raw.indexOf("\n\n/* /html_editor/", start);
    assert.ok(end >= 0);
    return raw.slice(start + marker.length, end);
  };
  assert.equal(
    renderCompanyReportCss([{ id: 1, primary_color: null, secondary_color: null, font: null, report_tables_id: null, layout: null }]),
    sliceOf("report-default-web.report_assets_common.min.css"),
  );
  assert.equal(
    renderCompanyReportCss([
      { id: 5, primary_color: null, secondary_color: null, font: null, report_tables_id: null, layout: null },
      { id: 2, primary_color: null, secondary_color: null, font: null, report_tables_id: null, layout: null },
      { id: 4, primary_color: null, secondary_color: null, font: null, report_tables_id: null, layout: null },
      { id: 1, primary_color: "#5e4766", secondary_color: "#010101", font: null, report_tables_id: null, layout: "web.external_layout_standard" },
      { id: 3, primary_color: null, secondary_color: null, font: null, report_tables_id: null, layout: null },
    ]),
    sliceOf("report-c1_5e4766_010101_light-web.report_assets_common.min.css"),
  );
});

test("a Sass function call refuses", () => {
  assert.throws(() => compileCompanyScss(".a { color: darken(#000, 1%); }"), NotPorted);
});
