/**
 * Creating accounting reports, as a localization's data file does (l10n_se/data/account_tax_report_data.xml, ACCEPTANCE
 * A1): account/models/account_report.py. The precomputes and stored computes of account.report (the option filters
 * :234-251, `_compute_user_groupby` :266-269, `_compute_default_availability_condition` :253-259, `_compute_use_sections`
 * :261-264), account.report.line (:468-517, the formula shortcuts' inverses :578-650 `_create_report_expression`) and
 * account.report.expression (`_compute_auditable` :765-769, the tax tags its `create` makes :805-824), with the
 * constraints those records meet. Not ported (NotPorted): the domain and external formula shortcuts, a groupby to
 * validate, writes that move a report to another country.
 */
import { NotPorted, OdooError, UserError, ValidationError } from "../errors";
import { parseDomain } from "../orm/domain";
import { searchQuery, sql } from "../orm/sql";
import { registerHooks } from "../orm/hooks";
import { defineComputes } from "./tail_util";
import { literalEval, LiteralEvalError } from "../pyexpr";
import { create } from "../orm/create";
import { RecomputeQueue, registerRecordCompute, type Rec } from "../orm/recompute";
import { registerOverrides } from "../orm/write";
import type { Environment } from "../orm/types";
import { DbRec } from "../orm/recompute";
import { onDataFileFlush } from "../modules/install";

// ----------------------------------------------------------------------------------------------- account.report

/** `_compute_report_option_filter(field_name, default_value)` (:234-251) for one record. */
function optionFilter(field: string, defaultValue: unknown) {
  return async (env: Environment, rec: Rec): Promise<unknown> => {
    // `ir.actions.client` whose context names the report: a new record's id (a NewId) is in none
    const accessible = rec.id !== null && (await env.cr.query(
      "SELECT 1 FROM ir_act_client WHERE context ILIKE $1 AND tag = 'account_report' LIMIT 1", [`%'report_id': ${rec.id}%`])).rows.length > 0;
    const root = await rec.rel("root_report_id");
    const mains = await rec.rels("section_main_report_ids");
    if ((accessible || root !== null) && mains.length) return rec.prev(field);
    if (root !== null) return root.get(field);
    if (mains.length === 1 && !accessible) return mains[0]!.get(field);
    return defaultValue;
  };
}

const OPTION_FILTERS: Record<string, unknown> = {
  only_tax_exigible: false, allow_foreign_vat: false, default_opening_date_filter: "previous_month", use_fiscal_periods: true,
  currency_translation: "cta", enable_snapshots: false, filter_multi_company: "selector", filter_date_range: true,
  filter_show_draft: true, filter_unreconciled: false, filter_unfold_all: false, filter_hide_0_lines: "optional",
  filter_period_comparison: true, filter_growth_comparison: true, filter_line_comparison: false, filter_journals: false,
  filter_hierarchy: "optional", filter_account_type: "disabled", filter_partner: false, filter_aml_ir_filters: false,
  filter_budgets: false,
};

registerRecordCompute("account.report", {
  ...Object.fromEntries(Object.entries(OPTION_FILTERS).map(([f, d]) => [f, optionFilter(f, d)])),
  user_groupby: async (_env, rec) => (await rec.prev("user_groupby")) || (await rec.get("groupby")) || null,
  availability_condition: async (_env, rec) => {
    if ((await rec.rel("root_report_id")) && (await rec.rel("country_id"))) return "country";
    return (await rec.prev("availability_condition")) || "always";
  },
  use_sections: async (_env, rec) => (await rec.rels("section_report_ids")).length > 0,
});

// account_report.py:55 `active` (non-stored, :379-381 `_compute_active`, :383-384 `_compute_sql_active`): the stored
// selection when set, else the fallback; read when a domain filters reports on it (a section's main reports)
defineComputes("account.report", {
  active: async (_env, rec) => {
    const sel = await rec.get("active_selection");
    return sel ? sel === "True" : Boolean(await rec.get("active_fallback"));
  },
});
registerHooks("account.report", {
  computeSql: { active: async (table) => sql`COALESCE(${await table.field("active_selection")} = 'True', ${await table.field("active_fallback")})` },
});

/** `_check_no_active_use_in_data_files` (:309-320). */
function checkNoActive(env: Environment, valsList: readonly Record<string, unknown>[]): void {
  const file = env.context["install_filename"];
  if (file && valsList.some((v) => "active" in v)) {
    throw new UserError(`'active' field of account.report shouldn't be directly written to in data files. Use active_fallback. (Detected while loading ${String(file)})`);
  }
}

/** The sections of `mains` (account_report_section_rel). */
async function sectionsOf(env: Environment, mains: readonly number[]): Promise<number[]> {
  if (!mains.length) return [];
  return (await env.cr.query<{ id: number }>("SELECT DISTINCT sub_report_id AS id FROM account_report_section_rel WHERE main_report_id = ANY($1::int[]) ORDER BY 1", [[...mains]])).rows.map((r) => r.id);
}

/**
 * The option filters depend on `section_main_report_ids` (account_report.py:88-232, `depends=['root_report_id',
 * 'section_main_report_ids']`), the inverse of the main reports' section_report_ids: setting a report's sections
 * recomputes the filters of its sections, old and new (a lone section takes its main report's values, :248-249;
 * l10n_lu's sections of its tax report). The changed values are written as a recomputation is.
 */
async function recomputeSectionFilters(env: Environment, sections: readonly number[]): Promise<void> {
  if (!sections.length) return;
  const queue = new RecomputeQueue(env);
  for (const f of Object.keys(OPTION_FILTERS)) queue.add("account.report", f, [...sections]);
  await queue.run();
}

registerOverrides("account.report", {
  create: async (env, valsList, next) => {
    checkNoActive(env, valsList);
    const ids = await next(env, valsList);
    const mains = ids.filter((_, i) => "section_report_ids" in valsList[i]!);
    await recomputeSectionFilters(env, await sectionsOf(env, mains));
    return ids;
  },
  write: async (env, ids, vals, next) => {
    checkNoActive(env, [vals]);
    if ("country_id" in vals) throw new NotPorted("account.report write of country_id (the tax tags of its expressions)");
    const before = "section_report_ids" in vals ? await sectionsOf(env, ids) : [];
    const out = await next(env, ids, vals);
    if ("section_report_ids" in vals) await recomputeSectionFilters(env, [...new Set([...before, ...await sectionsOf(env, ids)])]);
    return out;
  },
  constraints: [
    { fields: ["root_report_id"], fn: async (env, ids) => {
      const bad = (await env.cr.query("SELECT 1 FROM account_report r JOIN account_report p ON p.id = r.root_report_id WHERE r.id = ANY($1::int[]) AND p.root_report_id IS NOT NULL LIMIT 1", [[...ids]])).rows;
      if (bad.length) throw new ValidationError("Only a report without a root report of its own can be selected as root report.");
    } },
    { fields: ["section_report_ids"], fn: async (env, ids) => {
      const bad = (await env.cr.query(
        `SELECT 1 FROM account_report_section_rel s JOIN account_report_section_rel s2 ON s2.main_report_id = s.sub_report_id
          WHERE s.main_report_id = ANY($1::int[]) LIMIT 1`, [[...ids]])).rows;
      if (bad.length) throw new ValidationError("The sections defined on a report cannot have sections themselves.");
    } },
    { fields: ["availability_condition", "country_id"], fn: async (env, ids) => {
      const bad = (await env.cr.query("SELECT 1 FROM account_report WHERE id = ANY($1::int[]) AND availability_condition = 'country' AND country_id IS NULL LIMIT 1", [[...ids]])).rows;
      if (bad.length) throw new ValidationError("The Availability is set to 'Country Matches' but the field Country is not set.");
    } },
    { fields: ["line_ids"], fn: async (env, ids) => {
      // `_validate_parent_sequence` (:277-285): a line's parent comes before it in the report's sequence order
      for (const id of ids) {
        const lines = (await env.cr.query<{ id: number; parent_id: number | null; name: string; pname: string | null }>(
          `SELECT l.id, l.parent_id, l.name->>'en_US' AS name, p.name->>'en_US' AS pname FROM account_report_line l
             LEFT JOIN account_report_line p ON p.id = l.parent_id WHERE l.report_id = $1 ORDER BY l.sequence, l.id`, [id])).rows;
        const seen = new Set<number>();
        for (const l of lines) {
          if (l.parent_id !== null && !seen.has(l.parent_id)) {
            throw new ValidationError(`Line "${l.name}" defines line "${l.pname}" as its parent, but appears before it in the report. The parent must always come first.`);
          }
          seen.add(l.id);
        }
      }
    } },
  ],
});

// ------------------------------------------------------------------------------------------ account.report.line

registerRecordCompute("account.report.line", {
  report_id: async (_env, rec) => {
    const parent = await rec.rel("parent_id");
    return parent ? parent.get("report_id") : rec.prev("report_id");
  },
  hierarchy_level: async (_env, rec) => {
    const parent = await rec.rel("parent_id");
    if (!parent) return 1;
    const level = Number(await parent.get("hierarchy_level")) || 0;
    return level + (level === 0 ? 3 : 2);
  },
  horizontal_split_side: async (_env, rec) => {
    const parent = await rec.rel("parent_id");
    return parent ? parent.get("horizontal_split_side") : rec.prev("horizontal_split_side");
  },
  user_groupby: async (_env, rec) => {
    let value = await rec.prev("user_groupby");
    if (rec.id === null && !value) value = await rec.get("groupby");
    // `_validate_groupby` -> the expressions' `_validate_engine`: only an external engine with a groupby fails
    if (value) throw new NotPorted("account.report.line with a groupby (its validation)");
    return value || null;
  },
  foldability: async (env, rec) => {
    const current = await rec.prev("foldability");
    if (current) return current;
    // `@api.depends('create_date')`: Odoo computes it at the next flush, after the file's nested lines and the
    // expressions their formula shortcuts create; while a data file loads it is left for that flush (below)
    if (env.context["install_mode"]) return null;
    return foldability(rec);
  },
});

async function foldability(rec: Rec): Promise<string> {
  const report = await rec.rel("report_id");
  const hasGroupby = Boolean((await rec.get("groupby")) || (await rec.get("user_groupby"))
    || (report && ((await report.get("groupby")) || (await report.get("user_groupby")))));
  if ((await rec.rels("children_ids")).length) return "always_unfolded";
  const engines = await Promise.all((await rec.rels("expression_ids")).map((e) => e.get("engine")));
  const aggregated = engines.some((e) => e === "aggregation" || e === "external");
  if (hasGroupby && !aggregated) return "foldable";
  if (aggregated) return "never_unfolded";
  return "always_unfolded";
}

onDataFileFlush(async (env) => {
  const ids = (await env.cr.query<{ id: number }>("SELECT id FROM account_report_line WHERE foldability IS NULL ORDER BY id")).rows.map((r) => r.id);
  const def = env.reg.model("account.report.line");
  for (const id of ids) {
    await env.cr.query("UPDATE account_report_line SET foldability = $1 WHERE id = $2", [await foldability(new DbRec(env, def, id)), id]);
  }
});

/** `_create_report_expression(engine)` (:595-650) for lines created or written with a formula shortcut. */
async function createReportExpression(env: Environment, ids: readonly number[], engine: string, field: string, vals: Readonly<Record<string, unknown>>): Promise<void> {
  const valsList: Record<string, unknown>[] = [];
  for (const id of ids) {
    const formula = vals[field];
    if (typeof formula !== "string" || !formula) {
      const xml = (await env.cr.query(
        `SELECT 1 FROM account_report_expression e JOIN ir_model_data d ON d.model = 'account.report.expression' AND d.res_id = e.id
          WHERE e.report_line_id = $1 AND e.label = 'balance' AND e.engine = $2 LIMIT 1`, [id, engine])).rows.length;
      const plain = (await env.cr.query("SELECT 1 FROM account_report_expression WHERE report_line_id = $1 AND label = 'balance' AND engine = $2 LIMIT 1", [id, engine])).rows.length;
      if (plain && !xml) throw new NotPorted("account.report.line: emptying a formula shortcut (the expression unlinked)");
      continue;
    }
    if (engine === "domain" || engine === "external") throw new NotPorted(`account.report.line ${engine}_formula`);
    const existing = (await env.cr.query("SELECT id FROM account_report_expression WHERE report_line_id = $1 ORDER BY id", [id])).rows;
    if (existing.length) throw new NotPorted("account.report.line formula shortcut on a line with expressions");
    valsList.push({ report_line_id: id, label: "balance", engine, formula: formula.replace(/^[ \t\n]+/, ""), subformula: false });
  }
  if (valsList.length) await create(env, "account.report.expression", valsList);
}

registerOverrides("account.report.line", {
  inverse: {
    aggregation_formula: (env, ids, vals) => createReportExpression(env, ids, "aggregation", "aggregation_formula", vals),
    tax_tags_formula: (env, ids, vals) => createReportExpression(env, ids, "tax_tags", "tax_tags_formula", vals),
    account_codes_formula: (env, ids, vals) => createReportExpression(env, ids, "account_codes", "account_codes_formula", vals),
    domain_formula: (env, ids, vals) => createReportExpression(env, ids, "domain", "domain_formula", vals),
    external_formula: (env, ids, vals) => createReportExpression(env, ids, "external", "external_formula", vals),
  },
  constraints: [
    { fields: ["parent_id"], fn: async (env, ids) => {
      const rows = (await env.cr.query<{ name: string | null; self: boolean; grouped: boolean }>(
        `SELECT p.name->>'en_US' AS name, p.id = l.id AS self, (p.groupby IS NOT NULL AND p.groupby != '') OR (p.user_groupby IS NOT NULL AND p.user_groupby != '') AS grouped
           FROM account_report_line l JOIN account_report_line p ON p.id = l.parent_id WHERE l.id = ANY($1::int[]) ORDER BY l.id`, [[...ids]])).rows;
      for (const r of rows) if (r.grouped) throw new ValidationError(`A line cannot have both children and a groupby value (line '${r.name}').`);
      const self = (await env.cr.query<{ name: string }>("SELECT name->>'en_US' AS name FROM account_report_line WHERE id = ANY($1::int[]) AND parent_id = id ORDER BY id LIMIT 1", [[...ids]])).rows[0];
      if (self) throw new ValidationError(`Line "${self.name}" defines itself as its parent.`);
    } },
  ],
});

// ------------------------------------------------------------------------------------ account.report.expression

const AUDITABLE = new Set(["tax_tags", "domain", "account_codes", "external", "aggregation"]);

registerRecordCompute("account.report.expression", {
  auditable: async (_env, rec) => AUDITABLE.has(String(await rec.get("engine"))),
});

const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?`;
const LINE_CODE = String.raw`[+-]?[\s(]*[^().\s*/+\-]+\.[^().\s*/+\-]+`;
const OPERATOR = String.raw`[\s*/+\-]`;
/** AGGREGATION_ENGINE_FORMULA_REGEX (:35-43), matched in full. */
/** account_report.py:27-33 ACCOUNT_CODES_ENGINE_SPLIT_REGEX and ACCOUNT_CODES_ENGINE_TERM_REGEX (ASCII: `\d` [0-9], `\w` [A-Za-z0-9_]). */
const ACCOUNT_CODES_SPLIT = /(?=[+-])/;
const ACCOUNT_CODES_TERM = /^(?<sign>[+-]?)(?<prefix>([A-Za-z0-9.]*|tag\([A-Za-z0-9_.]+\))((?=\\)|(?<=[^CD])))(\\\((?<excluded_prefixes>([A-Za-z0-9.]+,)*[A-Za-z0-9.]*)\))?(?<balance_character>[DC]?)$/;
/** account_report.py:751-758 for an ASCII formula: whitespace removed, split before each sign, each term's prefix non-empty. */
export function accountCodesFormulaValid(formula: string): boolean {
  const cleaned = formula.replace(/[ \t\n\r\f\v\x1c-\x1f]+/g, "");
  return cleaned.split(ACCOUNT_CODES_SPLIT).every((token) => !token || Boolean(ACCOUNT_CODES_TERM.exec(token)?.groups?.["prefix"]));
}
const AGGREGATION = new RegExp(String.raw`^(?:sum_children|[\s(]*(?:${NUMBER}|${LINE_CODE})[\s)]*(?:${OPERATOR}[\s(]*(?:${NUMBER}|${LINE_CODE})[\s)]*)*)$`);

/** `account.account.tag._get_tax_tags` (account_account_tag.py:77-95), with active_test=False and lang en_US. */
async function taxTags(env: Environment, tagName: string, countryId: number | null): Promise<number[]> {
  return (await env.cr.query<{ id: number }>(
    `SELECT id FROM account_account_tag WHERE name->>'en_US' = $1 AND country_id IS NOT DISTINCT FROM $2 AND applicability = 'taxes' ORDER BY id`,
    [tagName.replace(/^-+/, ""), countryId])).rows.map((r) => r.id);
}

registerOverrides("account.report.expression", {
  create: async (env, valsList, next) => {
    const ids = await next(env, valsList);
    for (const id of ids) {
      const r = (await env.cr.query<{ engine: string; formula: string; country_id: number | null }>(
        `SELECT e.engine, e.formula, r.country_id FROM account_report_expression e
           JOIN account_report_line l ON l.id = e.report_line_id JOIN account_report r ON r.id = l.report_id WHERE e.id = $1`, [id])).rows[0]!;
      if (r.engine !== "tax_tags") continue;
      const tagName = r.formula.trim().replace(/\s+/g, " ");
      if (!tagName) continue;
      // `_create_tax_tags` (:799-803) with `_get_tags_create_vals` (:1007-1016)
      if (!(await taxTags(env, tagName, r.country_id)).length) {
        await create(env, "account.account.tag", [{ name: tagName.replace(/^-+/, ""), applicability: "taxes", country_id: r.country_id ?? false }]);
      }
    }
    return ids;
  },
  write: async (env, ids, vals, next) => {
    if ("formula" in vals || "engine" in vals) throw new NotPorted("account.report.expression write of formula or engine (tax tags)");
    return next(env, ids, vals);
  },
  constraints: [
    { fields: ["formula"], fn: async (env, ids) => {
      const rows = (await env.cr.query<{ engine: string; formula: string; label: string; line: string | null }>(
        `SELECT e.engine, e.formula, e.label, l.name->>'en_US' AS line FROM account_report_expression e
           LEFT JOIN account_report_line l ON l.id = e.report_line_id WHERE e.id = ANY($1::int[]) ORDER BY e.id`, [[...ids]])).rows;
      for (const r of rows) {
        if (r.engine === "domain") {
          // account_report.py:744-749: `ast.literal_eval(formula)` and `account.move.line._search(domain)` (the query
          // built, not run); any exception is the formula's error. An error of the port itself refuses instead
          try {
            await searchQuery(env, env.reg.model("account.move.line"), parseDomain(literalEval(r.formula)), {});
          } catch (e) {
            if (!(e instanceof OdooError || e instanceof LiteralEvalError)) throw e;
            throw new ValidationError(`Invalid formula for expression '${r.label}' of line '${r.line}': ${r.formula}`);
          }
          continue;
        }
        if (r.engine === "account_codes") {
          // account_report.py:751-758: whitespace removed, split before each sign, every term's prefix non-empty.
          // Python's `\s`, `\d` and `\w` are Unicode: a formula outside ASCII refuses
          if (/[^\x00-\x7f]/.test(r.formula)) throw new NotPorted("account.report.expression account_codes formula outside ASCII");
          if (!accountCodesFormulaValid(r.formula)) throw new ValidationError(`Invalid formula for expression '${r.label}' of line '${r.line}': ${r.formula}`);
          continue;
        }
        if (r.engine === "aggregation" && !AGGREGATION.test(r.formula.trim())) {
          throw new ValidationError(`Invalid formula for expression '${r.label}' of line '${r.line}': ${r.formula}`);
        }
      }
    } },
    { fields: ["carryover_target", "label"], fn: async (env, ids) => {
      const rows = (await env.cr.query<{ label: string; target: string | null }>(
        "SELECT label, carryover_target AS target FROM account_report_expression WHERE id = ANY($1::int[]) ORDER BY id", [[...ids]])).rows;
      for (const r of rows) {
        if (r.target && !r.label.startsWith("_carryover_")) throw new UserError("You cannot use the field carryover_target in an expression that does not have the label starting with _carryover_");
        if (r.target && !(r.target.split(".")[1] ?? "").startsWith("_applied_carryover_")) throw new UserError("When targeting an expression for carryover, the label of that expression must start with _applied_carryover_");
      }
    } },
    { fields: ["engine", "report_line_id"], fn: async (env, ids) => {
      const bad = (await env.cr.query(
        `SELECT 1 FROM account_report_expression e JOIN account_report_line l ON l.id = e.report_line_id
          WHERE e.id = ANY($1::int[]) AND e.engine = 'external' AND (COALESCE(l.groupby, '') != '' OR COALESCE(l.user_groupby, '') != '') LIMIT 1`, [[...ids]])).rows;
      if (bad.length) throw new NotPorted("account.report.expression external engine on a grouped line (the error's engine label)");
    } },
  ],
});
