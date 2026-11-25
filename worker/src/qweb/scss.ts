/**
 * The SCSS of `web.styles_company_report` as libsass compiles it for the layout wizard preview
 * (base_document_layout.py:251-259 `_get_css_for_preview`, ScssStylesheetAsset.compile, expanded output)
 * and for `web.report_assets_common` (minified, with Bootstrap's `h2, .h2` extend): nested rules, `&`,
 * selector lists, `rgba(<hex>, a)`, `mix(c1, c2, pct%)`, `preview-color-contrast(c)`, `@for $i from a through b`.
 * Anything else in the source refuses: this is not a general Sass compiler.
 */
import { NotPorted } from "../errors";

interface Rule { selectors: string[]; decls: string[]; }

const NAMED_RGB: Readonly<Record<string, [number, number, number]>> = {
  white: [255, 255, 255],
  black: [0, 0, 0],
};

function parseColor(raw: string): [number, number, number] | null {
  const s = raw.trim().toLowerCase();
  if (s in NAMED_RGB) return NAMED_RGB[s]!;
  if (/^#[0-9a-f]{3}$/.test(s)) {
    return [parseInt(s[1]! + s[1]!, 16), parseInt(s[2]! + s[2]!, 16), parseInt(s[3]! + s[3]!, 16)];
  }
  if (/^#[0-9a-f]{6}$/.test(s)) {
    return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  }
  return null;
}

function rgbToCss(r: number, g: number, b: number): string {
  if (r === 255 && g === 255 && b === 255) return "white";
  if (r === 0 && g === 0 && b === 0) return "black";
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const c = parseColor(hex);
  if (!c) throw new NotPorted(`SCSS color ${hex}`);
  return c;
}

/** Sass `mix($color1, $color2, $weight)` for opaque RGB colors, matching libsass rounding. */
function sassMix(c1Raw: string, c2Raw: string, pctStr: string): string {
  const c1 = parseColor(c1Raw), c2 = parseColor(c2Raw);
  const pct = Number(pctStr);
  if (!c1 || !c2 || !Number.isFinite(pct)) throw new NotPorted(`SCSS mix(${c1Raw}, ${c2Raw}, ${pctStr}%)`);
  const w = pct / 100;
  return rgbToCss(
    Math.round(c1[0] * w + c2[0] * (1 - w)),
    Math.round(c1[1] * w + c2[1] * (1 - w)),
    Math.round(c1[2] * w + c2[2] * (1 - w)),
  );
}

/** `web.styles_company_report` `@function preview-color-contrast($background)`: `lightness($c) > 50 ? black : white`. */
function previewColorContrast(colorRaw: string): string {
  const c = parseColor(colorRaw);
  if (!c) throw new NotPorted(`SCSS preview-color-contrast(${colorRaw})`);
  const lightness = ((Math.max(c[0], c[1], c[2]) + Math.min(c[0], c[1], c[2])) / 2 / 255) * 100;
  return lightness > 50 ? "black" : "white";
}

function value(v: string): string {
  let out = v.trim();
  // Evaluate inner `mix(...)` first so `preview-color-contrast(mix(...))` resolves in order.
  out = out.replace(/\bmix\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*,\s*([\d.]+)%\s*\)/g,
    (_m, c1: string, c2: string, pct: string) => sassMix(c1, c2, pct));
  out = out.replace(/\bpreview-color-contrast\(\s*([^()]+?)\s*\)/g,
    (_m, c: string) => previewColorContrast(c));
  out = out.replace(/rgba\(\s*(#[0-9a-fA-F]{3,6})\s*,\s*([\d.]+)\s*\)/g, (_m, hex: string, alpha: string) => {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${Number(alpha)})`;
  });
  out = out.replace(/(rgba\([^)]*,\s*)\.(\d+\s*\))/g, "$10.$2"); // libsass prints the leading zero
  if (/\$|\bmix\(|preview-color-contrast|\bdarken\(|\blighten\(/.test(out)) throw new NotPorted(`SCSS value ${out}`);
  return out;
}

function join(parents: string[], own: string[]): string[] {
  if (!parents.length) return own;
  return parents.flatMap((p) => own.map((s) => (s.includes("&") ? s.replace(/&/g, p) : `${p} ${s}`)));
}

/** Expand `@for $var from <start> through <end> { <body> }` blocks (used by `web.external_layout_lines`). */
function expandForLoops(src: string): string {
  const re = /@for\s+\$([a-zA-Z_][\w-]*)\s+from\s+(-?\d+)\s+through\s+(-?\d+)\s*\{/g;
  let out = src;
  for (;;) {
    re.lastIndex = 0;
    const m = re.exec(out);
    if (!m) return out;
    const name = m[1]!, start = Number(m[2]), end = Number(m[3]);
    const open = m.index + m[0].length - 1;
    let depth = 0, close = open;
    for (; close < out.length; close++) {
      if (out[close] === "{") depth++;
      else if (out[close] === "}" && --depth === 0) break;
    }
    if (depth !== 0) throw new NotPorted("SCSS: unclosed @for");
    const body = out.slice(open + 1, close);
    const expanded: string[] = [];
    const interpRe = new RegExp(`#\\{\\$${name}\\}`, "g");
    const mulPctRe = new RegExp(`\\$${name}\\s*\\*\\s*([\\d.]+)%`, "g");
    const varRe = new RegExp(`\\$${name}\\b`, "g");
    for (let i = start; i <= end; i++) {
      expanded.push(
        body
          .replace(interpRe, String(i))
          .replace(mulPctRe, (_x, factor: string) => `${i * Number(factor)}%`)
          .replace(varRe, String(i)),
      );
    }
    out = out.slice(0, m.index) + expanded.join("\n") + out.slice(close + 1);
  }
}

/** Blocks of `src` from `pos` up to the closing brace, in source order; rules are emitted before their nested rules. */
function parseBlock(src: string, start: number, parents: string[], out: Rule[]): number {
  const rule: Rule = { selectors: parents, decls: [] };
  const index = out.length;
  out.push(rule);
  let i = start;
  while (i < src.length) {
    const brace = src.indexOf("{", i), close = src.indexOf("}", i), semi = src.indexOf(";", i);
    const next = Math.min(...[brace, close, semi].filter((x) => x >= 0));
    if (!Number.isFinite(next)) {
      if (src.slice(i).trim() === "") return src.length;
      // a last declaration without semicolon cannot end the file
      throw new NotPorted("SCSS: unexpected end");
    }
    const text = src.slice(i, next).trim();
    if (next === semi) {
      if (text) rule.decls.push(text);
      i = next + 1;
    } else if (next === close) {
      if (text) rule.decls.push(text);
      if (!rule.decls.length && out[index] === rule) out.splice(index, 1);
      return next + 1;
    } else {
      if (text.startsWith("@")) throw new NotPorted(`SCSS at-rule ${text}`);
      const own = text.split(",").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);
      i = parseBlock(src, next + 1, join(parents, own), out);
    }
  }
  return i;
}

function withoutFunctions(src: string): string {
  for (let at = src.indexOf("@function"); at >= 0; at = src.indexOf("@function")) {
    let depth = 0, i = src.indexOf("{", at);
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) break;
    }
    src = src.slice(0, at) + src.slice(i + 1);
  }
  return src;
}

function compileRules(source: string): { selectors: string[]; decls: [string, string][] }[] {
  const src = expandForLoops(withoutFunctions(source.replace(/\/\/[^\n]*/g, "")));
  const rules: Rule[] = [];
  parseBlock(src, 0, [], rules);
  const out: { selectors: string[]; decls: [string, string][] }[] = [];
  for (const r of rules) {
    if (!r.decls.length || !r.selectors.length) continue;
    const decls: [string, string][] = r.decls.map((d) => {
      const c = d.indexOf(":");
      if (c < 0) throw new NotPorted(`SCSS declaration ${d}`);
      return [d.slice(0, c).trim(), value(d.slice(c + 1))];
    });
    out.push({ selectors: r.selectors, decls });
  }
  return out;
}

/** The css of one stylesheet of `web.styles_company_report` (libsass expanded output). */
export function compileCompanyScss(source: string): string {
  const blocks = compileRules(source).map((r) =>
    `${r.selectors.join(", ")} {\n${r.decls.map(([k, v]) => `  ${k}: ${v};`).join("\n")}\n}`);
  return blocks.join("\n\n") + "\n";
}

export interface CompanyReportStyle {
  readonly id: number;
  readonly primary_color: string | null;
  readonly secondary_color: string | null;
  readonly font: string | null;
  readonly report_tables_id: string | null;
  readonly layout: string | null;
}

/**
 * Render `web.styles_company_report` (odoo/addons/web/views/report_templates.xml:889-1065) as the minified CSS slice
 * inside `web.report_assets_common.min.css` (Bootstrap extends `h2` with `.h2`).
 */
export function renderCompanyReportCss(companies: readonly CompanyReportStyle[]): string {
  const parts: string[] = [];
  for (const c of companies) {
    const font = c.font || "Lato";
    const primary = c.primary_color || "#212529";
    const secondary = c.secondary_color || "#212529";
    const layout = c.layout || "web.external_layout_standard";
    const tables = c.report_tables_id || null;
    let scss = `
      .o_border_color { border-color: #000000; }
      .o_bg_color { background-color: #000000; }
      .o_bg_color_15 { background-color: rgba(0, 0, 0, .15); }
      .o_color_company_${c.id} {
        .o_border_color { border-color: ${primary}; }
        &.o_bg_color, .o_bg_color { background-color: ${primary}; }
        .o_bg_color_15 { background-color: rgba(${primary}, .15); }
      }
      .o_company_${c.id}_layout {
        font-family: ${font};
        h2, .h2 { color: ${primary}; }
        #informations strong { color: ${secondary}; }
        .o_total strong { color: ${primary}; }
        .o_company_tagline { color: ${primary}; }
    `;
    if (tables === "boxed") {
      scss += `
        &.o_report_layout_boxed {
          #total .o_total td {
            background-color: ${primary};
            strong { color: preview-color-contrast(${primary}); }
          }
        }`;
    } else if (tables === "bold") {
      scss += `
        &.o_report_layout_bold {
          th { color: ${primary}; border-color: ${primary}; }
          td, table { border-color: mix(white, ${primary}, 40%) !important; }
        }`;
    } else if (tables === "striped") {
      scss += `
        &.o_report_layout_striped {
          table:not(.o_ignore_layout_styling) {
            th { color: ${secondary} !important; }
            tbody tr {
              &:first-child, &:last-child { border-color: ${secondary}; }
              &.o_line_section td { background-color: ${secondary} !important; color: preview-color-contrast(${secondary}) !important; }
              &.o_line_subsection td { background-color: mix(white, ${secondary}, 40%) !important; color: preview-color-contrast(mix(white, ${secondary}, 40%)) !important; }
              &:nth-child(odd) td { background-color: mix(white, ${secondary}, 90%); }
            }
          }
          .o_total_table:not(.o_ignore_layout_styling) {
            tr:first-child { border-color: transparent; }
            tr:nth-child(odd) td { background-color: mix(white, ${secondary}, 90%); }
          }
        }`;
    } else if (tables === "bubble") {
      scss += `
        &.o_report_layout_bubble {
          #informations { border-color: ${secondary}; background-color: mix(white, ${secondary}, 92%); }
          table:not(.o_ignore_layout_styling)::before { border-color: ${primary} !important; }
          thead th, #total .o_total td {
            background-color: ${primary}; color: preview-color-contrast(${primary});
            strong { color: preview-color-contrast(${primary}); }
          }
        }`;
    } else if (tables === "column") {
      scss += `
        &.o_report_layout_column {
          table:not(.o_ignore_layout_styling) {
            th { background-color: ${secondary}; color: preview-color-contrast(${secondary}); }
          }
          #informations > div.col { border-color: ${secondary}; }
        }`;
    }
    if (layout === "web.external_layout_folder") {
      scss += `& .o_folder_header_container { rect, path { fill: mix(white, ${primary}, 92%); } }`;
    } else if (layout === "web.external_layout_center") {
      scss += `& .o_layout_center_header { background-color: mix(white, ${primary}, 90%); }`;
    } else if (layout === "web.external_layout_lines") {
      scss += `@for $i from 1 through 10 { .o_lines_path_#{$i} { stroke: mix(white, ${primary}, $i * 8%); } }`;
    }
    scss += "}";
    for (const r of compileRules(scss)) {
      parts.push(`${r.selectors.join(", ")}{${r.decls.map(([k, v]) => `${k}: ${v};`).join("")}}`);
    }
  }
  return parts.join("");
}
