/**
 * `_validate_view` (odoo/addons/base/models/ir_ui_view.py:1829-1906), its tag validators (:1909-2217),
 * `_validate_attributes` (:2219-2304), the expression and domain checks (:2441-2491) and `NameManager.check`
 * (:3463-3560), for `_check_xml` (:441-547). Every check that raises is ported; the ones that only log a warning
 * (`_log_view_warning`: accessibility, classes, unknown groups, group inconsistencies of existing fields) change
 * nothing an RPC caller sees and are left out.
 *
 * The error is Odoo's: `_raise_view_error` makes a ValueError with the view's context (src/modules/view_buttons.ts
 * ViewValidationError), which `_check_xml` turns into "Error while validating view near:\n\n<five lines>\n<message>".
 * Where Odoo's answer would depend on something the port cannot reproduce (the text of a Python SyntaxError, the
 * iteration order of a Python set holding two failing names, a message translated into another language than en_US),
 * the port refuses (NotPorted) instead of answering.
 */
import { NotPorted, ValidationError } from "../errors";
import type { Environment, FieldDef } from "../orm/types";
import { hooksOf } from "../orm/hooks";
import { compileExpr, type Expr } from "../pyexpr";
import { isElement, serializeXml, escapeAttr, type Element } from "../xml";
import { groupDefinitions, modelGroups, type GroupDefinitions, type Groups } from "../views/groups";
import { pyStrRepr } from "../models/util";
import { verdict, ViewValidationError } from "./view_buttons";

/** ir_ui_view.py:34 VIEW_MODIFIERS. */
const VIEW_MODIFIERS = ["column_invisible", "invisible", "readonly", "required"];
/** :40-41 */
const QUARTER_PERIODS = new Set(["first_quarter", "second_quarter", "third_quarter", "fourth_quarter"]);
const RELATIVE_PERIODS = new Set(["today", "this_week", "this_month", "this_quarter", "this_year"]);
/** :47 COMP_REGEX */
const COMP_REGEX = /(^|[^\w])\s*__comp__\s*([^\w]|$)/u;
/** view_validation.py:22 IGNORED_IN_EXPRESSION */
const IGNORED_IN_EXPRESSION: ReadonlySet<string> = new Set([
  "True", "False", "None", "self", "uid", "context", "context_today", "allowed_company_ids", "current_company_id",
  "time", "datetime", "relativedelta", "current_date", "today", "now", "abs", "len", "bool", "float", "str", "unicode", "set",
]);
const DOMAIN_OPERATORS: ReadonlySet<string> = new Set(["!", "&", "|"]);
/** The models that are subclasses of ir.actions.actions (ir_actions.py: `_inherit = 'ir.actions.actions'`). */
const ACTION_MODELS: ReadonlySet<string> = new Set([
  "ir.actions.actions", "ir.actions.act_window", "ir.actions.act_window_close", "ir.actions.act_url",
  "ir.actions.server", "ir.actions.client", "ir.actions.report",
]);

/** A Python ValueError/AttributeError raised while reading an expression's AST (view_validation.py). */
class AstError extends Error {}

/** The `ast` class name of a node, for the AttributeError of `ast_domain.elts` (view_validation.py:115). */
function astClass(e: Expr): string {
  switch (e.kind) {
    case "name": return "Name";
    case "const": case "num": case "str": return "Constant";
    case "list": return "List";
    case "tuple": return "Tuple";
    case "dict": return "Dict";
    case "attr": return "Attribute";
    case "subscript": case "slice": return "Subscript";
    case "call": return "Call";
    case "unary": return "UnaryOp";
    case "binary": return "BinOp";
    case "compare": return "Compare";
    case "bool": return "BoolOp";
    case "ifexp": return "IfExp";
    case "lambda": return "Lambda";
    case "comp": throw new NotPorted("a comprehension in a view domain");
    default: {
      const never: never = e;
      throw new TypeError(String(never));
    }
  }
}

/** view_validation.py:152-226 `_get_expression_contextual_values`; an `ast` node it does not handle is a ValueError. */
function contextualValues(node: Expr): Set<string> {
  const union = (...parts: Set<string>[]): Set<string> => {
    const out = new Set<string>();
    for (const p of parts) for (const v of p) out.add(v);
    return out;
  };
  switch (node.kind) {
    case "const": case "num": case "str": return new Set();
    case "list": case "tuple": return union(...node.items.map(contextualValues));
    case "name": return new Set([node.id]);
    case "attr": {
      const values = contextualValues(node.obj);
      if (values.size === 1) return new Set([`${[...values].sort().pop()!}.${node.name}`]);
      return values;
    }
    case "subscript": return union(contextualValues(node.obj), contextualValues(node.index));
    // an ast.Slice inside the Subscript: "Undefined item <ast.Slice object at 0x...>" (an address)
    case "slice": throw new NotPorted("a slice in a view expression (Python's error has an address)");
    case "compare": return union(contextualValues(node.left), ...node.comparators.map(contextualValues));
    case "binary": return union(contextualValues(node.left), contextualValues(node.right));
    case "bool": return union(...node.values.map(contextualValues));
    case "unary": return contextualValues(node.operand);
    case "call": return union(contextualValues(node.func), ...node.args.map(contextualValues));
    case "ifexp": return union(contextualValues(node.test), contextualValues(node.body), contextualValues(node.orelse));
    case "dict": {
      const out = new Set<string>();
      // keys first, then values (:217-222); `**x` has the key None: "Undefined item None."
      for (const item of node.items) {
        if ("unpack" in item) throw new AstError("Undefined item None.");
        for (const v of contextualValues(item.key)) out.add(v);
      }
      for (const item of node.items) if (!("unpack" in item)) for (const v of contextualValues(item.value)) out.add(v);
      return out;
    }
    case "lambda": case "comp":
      throw new NotPorted(`${node.kind} in a view expression (Python's error has an address)`);
    default: {
      const never: never = node;
      throw new TypeError(String(never));
    }
  }
}

/** `ast.parse(src, mode='eval').body`; a source the port's parser does not read refuses (Python's SyntaxError text). */
function parsePy(src: string, what: string): Expr {
  try {
    return compileExpr(src);
  } catch (e) {
    if (e instanceof NotPorted) throw e;
    throw new NotPorted(`${what} ${JSON.stringify(src)} that the port's Python parser does not read (${e instanceof Error ? e.message : String(e)})`);
  }
}

function valueNames(contextual: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const name of contextual) {
    if (name === "parent") continue;
    const root = name.split(".")[0]!;
    if (!IGNORED_IN_EXPRESSION.has(root)) out.add(root === "parent" ? name : root);
  }
  return out;
}

/** view_validation.py:229-259 `get_expression_field_names`. */
function expressionFieldNames(expression: string): Set<string> {
  if (!expression) return new Set();
  return valueNames(contextualValues(parsePy(expression.trim(), "view expression")));
}

/** view_validation.py:51-149 `get_domain_value_names` of a string domain: [field names, value names]. */
function domainValueNames(domain: string): [Set<string>, Set<string>] {
  const contextual = new Set<string>();
  const fields = new Set<string>();
  const add = (s: Set<string>): void => { for (const v of s) contextual.add(v); };
  const nested = (e: Expr): boolean => e.kind === "list" || e.kind === "ifexp" || e.kind === "bool" || e.kind === "binary";
  const extract = (d: Expr): void => {
    if (d.kind === "ifexp") { extract(d.body); extract(d.orelse); return; }
    if (d.kind === "bool") { for (const v of d.values) { if (nested(v)) extract(v); else add(contextualValues(v)); } return; }
    if (d.kind === "binary") {
      if (nested(d.left)) extract(d.left); else add(contextualValues(d.left));
      if (nested(d.right)) extract(d.right); else add(contextualValues(d.right));
      return;
    }
    if (d.kind !== "list" && d.kind !== "tuple") throw new AttributeErr(`'${astClass(d)}' object has no attribute 'elts'`);
    for (const item of d.items) {
      if (item.kind === "str" || item.kind === "num" || item.kind === "const") {
        const v = item.value;
        // `value not in DOMAIN_OPERATORS and value not in (True, False)`: 1 == True, 0 == False
        if (!(typeof v === "string" && DOMAIN_OPERATORS.has(v)) && !(v === true || v === false || v === 1 || v === 0)) throw new AstError("leaf");
      } else if (item.kind === "list" || item.kind === "tuple") {
        if (item.items.length !== 3) throw new AstError("unpack");
        const [left, , right] = item.items as [Expr, Expr, Expr];
        add(contextualValues(right));
        if (left.kind === "str") fields.add(left.value);
        else if ((left.kind === "num" || left.kind === "const") && (left.value === 1 || left.value === 0 || left.value === true || left.value === false)) { /* True/False leaf */ }
        else if ((right.kind === "num" || right.kind === "const") && (right.value === 1 || right.value === true)) add(contextualValues(left));
        else throw new AstError("leaf");
      } else throw new AstError("leaf");
    }
  };
  const ast = parsePy(`(${domain.trim()})`, "view domain");
  try {
    if (ast.kind === "name") add(contextualValues(ast));
    else extract(ast);
  } catch (e) {
    // :141-142 every ValueError (a bad leaf, an unpacking, an undefined item) is "Wrong domain formatting."
    if (e instanceof AstError) throw new AstError("Wrong domain formatting.");
    throw e;
  }
  return [fields, valueNames(contextual)];
}

class AttributeErr extends Error {}

/** `str(GroupsExpression)` (odoo/tools/set_expression.py:418-434), the leaves by their first external id. */
function groupsStr(g: Groups, refs: ReadonlyMap<number | string, string>): string {
  if (g.empty) return "~*";
  const leafKey = (a: readonly [number | string, boolean], b: readonly [number | string, boolean]): number => {
    if (typeof a[0] !== typeof b[0]) throw new NotPorted("ordering of group ids and unknown group names");
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    return Number(a[1]) - Number(b[1]);
  };
  const interKey = (a: readonly (readonly [number | string, boolean])[], b: readonly (readonly [number | string, boolean])[]): number => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = leafKey(a[i]!, b[i]!); if (c) return c; }
    return a.length - b.length;
  };
  const inters = g.terms.map((t) => [...t].sort(leafKey)).sort(interKey);
  const wrapped = inters.length > 1;
  return inters.map((inter) => {
    const s = inter.map(([id, negative]) => `${negative ? "~" : ""}${pyStrRepr(refs.get(id) ?? String(id))}`).join(" & ") || "*";
    return wrapped && inter.length > 1 ? `(${s})` : s;
  }).join(" | ");
}

/** markupsafe.escape */
function markupEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&#34;" : "&#39;"));
}

interface NodeInfo {
  editable: boolean;
  validate: boolean;
  viewType: string;
  modelGroups: Groups;
  viewGroups: Groups;
  nm: NameManager;
}

interface Use { groups: Groups; use: string; node: Element }

/** ir_ui_view.py:3390-3460 NameManager, the parts `_validate_view` uses. */
class NameManager {
  readonly availableFields = new Map<string, { info?: Record<string, string | null>; groups?: Groups[] }>();
  readonly availableActions = new Set<string>();
  readonly availableNames = new Set<string>();
  readonly usedFields = new Map<string, Map<string, Use>>();
  readonly usedNames = new Map<string, string>();
  readonly mustExistActions = new Map<string, Element>();
  readonly fieldGroups = new Map<string, Groups>();
  /** the call of `must_have_fields` that first used a name (its position in `used_fields`) */
  readonly usedBatch = new Map<string, number>();
  constructor(readonly model: string, readonly fields: ReadonlyMap<string, FieldDef>, readonly parent: NameManager | null, readonly modelGroups: Groups) {}

  hasField(name: string, info: NodeInfo, extra: Record<string, string | null> = {}): void {
    const entry = this.availableFields.get(name) ?? {};
    this.availableFields.set(name, entry);
    entry.info = { ...(entry.info ?? {}), ...extra };
    this.fieldGroups.set(name, info.modelGroups);
    (entry.groups ??= []).push(info.viewGroups);
    this.availableNames.add(extra["id"] || name);
  }
  hasAction(name: string): void { this.availableActions.add(name); }
  /** `names` is a Python set: the names of one call have no order among themselves (`batch`). */
  mustHaveFields(node: Element, names: Iterable<string>, info: NodeInfo, use: string, batch: number): void {
    const groups = info.modelGroups.and(info.viewGroups);
    for (const name of names) {
      if (name === "id") continue;
      if (!name.startsWith("parent.")) {
        const uses = this.usedFields.get(name) ?? new Map<string, Use>();
        if (!this.usedFields.has(name)) { this.usedFields.set(name, uses); this.usedBatch.set(name, batch); }
        uses.set(groups.key, { groups, use, node });
      } else if (this.parent) {
        this.parent.mustHaveFields(node, [name.slice(7)], info, use, batch);
      }
    }
  }
}

export interface ValidatedView {
  readonly id: number;
  readonly type: string;
  readonly key: string | null;
  /** `_raise_view_error`'s context (view_buttons.ts) */
  readonly context: Readonly<Record<string, string>>;
}

/**
 * `view._validate_view(combined_arch, view.model)` (:1829). `combined` carries the `__validate__` flags of
 * `_add_validation_flag`; like Odoo, sub-views, search panels and `groupby` contents are taken out of it while it is
 * validated, so the five lines of an error (and the schema check after this) see the arch without them.
 */
export async function validateView(env: Environment, combined: Element, model: string, view: ValidatedView): Promise<void> {
  const defs = await groupDefinitions(env);
  const refs = new Map<number | string, string>();
  for (const [ref, id] of defs.refs) if (!refs.has(id)) refs.set(id, ref);
  const viewTypes = new Set((env.reg.model("ir.ui.view").fields.get("type")?.selection ?? []).map((s) => s.value));
  const lang = typeof env.context["lang"] === "string" ? env.context["lang"] : "en_US";
  let batches = 0;

  /** `_()`: the message in the environment's language; only en_US is ported for these messages. */
  const tr = (message: string): string => {
    if (lang !== "en_US") throw new NotPorted(`view validation error in ${lang}: ${message.split("\n")[0]}`);
    return message;
  };
  const fail = (message: string, node: Element | null): never => {
    const lines = serializeXml(combined, { withTail: false }).split(/(?<=\n)/);
    const line = node?.sourceline ?? 1;
    const five = lines.slice(Math.max(0, line - 3), line + 2).join("");
    throw new ViewValidationError(`Error while validating view near:\n\n${five}\n${tr(message)}`, { ...view.context, line: String(line) });
  };
  /** A ValueError without view context (get_dict_asts): "Error while validating view (<key or id>):\n\n<error>" (:543-546). */
  const failPlain = (message: string): never => {
    throw new ValidationError(tr(`Error while validating view (${view.key || view.id}):\n\n${message}`));
  };

  const descriptionDomain = async (modelName: string, field: FieldDef): Promise<unknown> => {
    // fields.py _description_domain, as fields_get reports it (src/orm/model.ts)
    // (src/models/callable_domains.ts and the models' own hooks)
    if (field.domainCallable) {
      const hook = hooksOf(modelName).descriptionDomain?.[field.name];
      if (!hook) throw new NotPorted(`domain ${modelName}.${field.name}`);
      return hook(env);
    }
    return field.descriptionDomain ?? field.domain ?? [];
  };

  /** :2462-2491 `_check_field_paths`; field paths come from a Python set, so two failing ones refuse. */
  const checkFieldPaths = (node: Element, paths: Set<string>, modelName: string, use: string): void => {
    const errors: string[] = [];
    for (const path of paths) {
      const names = path.split(".");
      if (names[0] === "parent") continue;
      let current: string | null = modelName;
      for (let i = 0; i < names.length; i++) {
        const name = names[i]!;
        if (current === null) { errors.push(`Non-relational field “${names[i - 1]}” in path “${path}” in ${use})`); break; }
        if (!env.reg.models.has(current)) throw new NotPorted(`view validation on unknown model ${current}`);
        const f: FieldDef | undefined = env.reg.model(current).fields.get(name);
        if (!f) { errors.push(`Unknown field "${current}.${name}" in ${use})`); break; }
        if (!f.searchable) { errors.push(`Unsearchable field “${name}” in path “${path}” in ${use})`); break; }
        current = f.relation && ["many2one", "one2many", "many2many"].includes(f.type) ? f.relation : null;
      }
    }
    if (errors.length > 1) throw new NotPorted("view validation: two invalid field paths in one domain (Python set order)");
    if (errors.length === 1) fail(errors[0]!, node);
  };

  const validateDomainIdentifiers = (node: Element, info: NodeInfo, domain: string, use: string, target: string): void => {
    let names: [Set<string>, Set<string>];
    try {
      names = domainValueNames(domain);
    } catch (e) {
      if (e instanceof AstError || e instanceof AttributeErr) return fail(`Invalid ${use}: “${domain}”\n${e.message}`, node);
      throw e;
    }
    checkFieldPaths(node, names[0], target, `${use} (${domain})`);
    info.nm.mustHaveFields(node, names[1], info, `${use} (${domain})`, batches++);
  };

  const validateExpression = (node: Element, info: NodeInfo, expr: string, use: string): void => {
    if (["0", "false", "1", "true"].includes(expr.toLowerCase())) return;
    let names: Set<string>;
    try {
      names = expressionFieldNames(expr);
    } catch (e) {
      if (e instanceof AstError) return fail(`Invalid ${use}: “${expr}”\n${e.message}`, node);
      throw e;
    }
    info.nm.mustHaveFields(node, names, info, `${use} (${expr})`, batches++);
  };

  /** :2219-2304 `_validate_attributes` (the raising part). */
  const validateAttributes = (node: Element, info: NodeInfo): void => {
    for (const attr of VIEW_MODIFIERS) {
      const expr = node.attrib.get(attr);
      if (expr) validateExpression(node, info, expr, `modifier ${pyStrRepr(attr)}`);
    }
    for (const [attr, expr] of node.attrib) {
      if (attr === "context") {
        let names: Set<string>;
        try {
          names = expressionFieldNames(expr);
        } catch (e) {
          if (e instanceof AstError) throw new NotPorted("view context whose AST Odoo does not read (Python's error)");
          throw e;
        }
        if (names.size) info.nm.mustHaveFields(node, names, info, `context (${expr})`, batches++);
        // view_validation.py:262-274 get_dict_asts
        const ast = parsePy(expr.trim(), "view context");
        if (ast.kind !== "dict") failPlain("Non-dict expression");
        else {
          for (const item of ast.items) if ("unpack" in item || item.key.kind !== "str") failPlain("Non-string literal dict key");
          for (const item of ast.items) {
            if ("unpack" in item || item.key.kind !== "str" || item.key.value !== "group_by") continue;
            if (item.value.kind !== "str") fail(`"group_by" value must be a string ${attr}=“${expr}”`, node);
            else {
              const fname = item.value.value.split(":")[0]!;
              if (!info.nm.fields.has(fname)) fail(`Unknown field “${fname}” in "group_by" value in ${attr}=“${expr}”`, node);
            }
          }
        }
      } else if (attr === "col" || attr === "colspan") {
        if (!/^\p{Nd}+$/u.test(expr)) fail(`“${attr}” value must be an integer (${expr})`, node);
      } else if (attr.startsWith("decoration-")) {
        let names: Set<string>;
        try {
          names = expressionFieldNames(expr);
        } catch (e) {
          // not caught by _validate_attributes: Python's ValueError/SyntaxError goes up as such
          if (e instanceof AstError) throw new NotPorted("decoration expression whose AST Odoo does not read");
          throw e;
        }
        if (names.size) info.nm.mustHaveFields(node, names, info, `${attr}=${pyStrRepr(expr)}`, batches++);
      } else if (/^(t-att-|t-attf-)?data-tooltip(-template|-info)$/u.test(attr)) {
        fail(`Forbidden attribute used in arch (${attr}).`, node);
      } else if (attr.startsWith("t-")) {
        // :2415-2439 _validate_qweb_directive: re.match (a prefix match) against the allowed directives
        const allowed = ["t-translation"];
        // :2216 _is_qweb_based_view, with mail's activity (mail/models/ir_ui_view.py:11) and web_hierarchy's hierarchy
        if (["kanban", "card", "calendar", "activity", "hierarchy"].includes(info.viewType)) {
          allowed.push("t-name", "t-out", "t-set", "t-value", "t-if", "t-else", "t-elif", "t-foreach", "t-as", "t-key", "t-att.*", "t-call", "t-debug");
        }
        if (!allowed.some((re) => new RegExp(`^(?:${re})`, "u").test(attr))) fail(`Forbidden owl directive used in arch (${attr}).`, node);
        if (COMP_REGEX.test(expr)) fail("Forbidden use of `__comp__` in arch.", node);
      }
    }
  };

  /** :3463-3560 NameManager.check (the raising part). */
  const check = async (nm: NameManager): Promise<void> => {
    for (const [name, use] of nm.usedNames) {
      if (!nm.availableActions.has(name) && !nm.availableNames.has(name) && !nm.fields.has(name)) {
        fail(`Name or id “${name}” in ${use} does not exist.`, null);
      }
      if (!nm.availableActions.has(name) && !nm.availableNames.has(name)) {
        fail(`Name or id “${name}” in ${use} must be present in view but is missing.`, null);
      }
    }
    for (const name of nm.availableFields.keys()) {
      if (!nm.fields.has(name)) fail(`Field \`${name}\` does not exist`, null);
    }
    for (const [name, node] of nm.mustExistActions) {
      // logic mimics /web/action/load
      let actionId: number;
      if (/^\s*[+-]?\d+\s*$/u.test(name)) actionId = parseInt(name, 10);
      else {
        const dot = name.indexOf(".");
        const r = dot < 0 ? undefined : (await env.cr.query<{ model: string; res_id: number }>(
          "SELECT model, res_id FROM ir_model_data WHERE module = $1 AND name = $2", [name.slice(0, dot), name.slice(dot + 1)])).rows[0];
        if (dot < 0) throw new NotPorted(`button of type action named ${name} (an xmlid without a module)`);
        if (!r || !r.res_id) return fail(`Invalid xmlid ${name} for button of type action.`, node);
        if (!ACTION_MODELS.has(r.model)) return fail(`${name} is of type ${r.model}, expected a subclass of ir.actions.actions`, node);
        actionId = Number(r.res_id);
      }
      const exists = (await env.cr.query("SELECT 1 FROM ir_actions WHERE id = $1", [actionId])).rows.length > 0;
      if (!exists) fail(`Action ${name} (id: ${actionId}) does not exist for button of type action.`, node);
    }
    // used fields: composed names and select multi, then the ones that do not exist (get_missing_fields)
    const fieldGroups = (name: string): Groups => {
      const g = nm.fieldGroups.get(name);
      if (g) return g;
      const f = nm.fields.get(name);
      let access = nm.modelGroups;
      if (!f && !nm.availableNames.has(name)) access = defs.empty;
      else if (f?.groups?.length) access = access.and(defs.parse(f.groups.join(",")));
      nm.fieldGroups.set(name, access);
      return access;
    };
    for (const [name, uses] of nm.usedFields) {
      const first = uses.values().next().value!;
      if (name.includes(".")) fail(`Invalid composed field ${name} in ${first.use}`, null);
      const entry = nm.availableFields.get(name) ?? {};
      nm.availableFields.set(name, entry); // defaultdict access
      if (entry.info === undefined) continue;
      if (entry.info["select"] === "multi") fail(`Field “${name}” used in ${first.use} is present in view but is in select multi.`, null);
    }
    const missing: [string, Use[], number][] = [];
    for (const [name, uses] of nm.usedFields) {
      if (nm.fields.has(name) || nm.availableNames.has(name)) continue; // only `does_not_exist` raises
      const errors: Use[] = [], used: Use[] = [];
      const available = nm.availableFields.get(name) ?? {};
      for (const u of uses.values()) {
        if (u.groups.empty) { if (!(available.groups ?? []).length) used.push(u); continue; }
        if (!u.groups.le(fieldGroups(name))) { errors.push(u); continue; }
        const combinedGroups = (available.groups ?? []).reduce((a, b) => a.or(b), defs.empty);
        if (!u.groups.le(combinedGroups)) used.push(u);
      }
      const reasons = errors.length ? errors : used;
      if (reasons.length) missing.push([name, reasons, nm.usedBatch.get(name)!]);
    }
    if (missing.some((m, i) => i > 0 && m[2] === missing[0]![2])) throw new NotPorted("view validation: two missing fields from one expression (Python set order)");
    if (missing.length) {
      const [name, reasons] = missing[0]!;
      const elements = reasons.map((r) => (r.node.tag === "field" ? `<field name="${r.node.attrib.get("name") ?? "None"}"/>` : `<${r.node.tag}>`));
      const debug = [`- field “${name}” does not exist in model “${nm.model}”.`];
      for (const r of reasons) {
        const attrs = [...r.node.attrib].filter(([k]) => k !== "__validate__" && k !== "__groups_key__");
        const clone = `<${r.node.tag}${attrs.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join("")}/>`;
        const groups = r.groups.universal ? "Free access" : r.groups.empty ? "Accessible only for the super user" : groupsStr(r.groups, refs);
        debug.push(`- element “${clone}” is shown in the view for groups: ${groups}`);
      }
      const body = "This view may not work for all users: some users may have a combination of groups where the elements "
        + `${elements.map((e) => `<b><tt>${markupEscape(e)}</tt></b>`).join(", ")} are displayed, but they depend on the field `
        + `<b><tt>${markupEscape(name)}</tt></b> that is not accessible. You might fix this by modifying user groups to make sure that all users `
        + "who have access to those elements also have access to the field, typically via group implications. Alternatively, you could "
        + "adjust the “<i>groups</i>” or “<i>invisible</i>” attributes for these fields, to make sure they are always available together.";
      fail(`<b>Access Rights Inconsistency</b><br/>${body}<br/>Debugging information:<br/>${debug.map(markupEscape).join("<br/>")}`, null);
    }
  };

  const validateNode = async (root: Element, modelName: string, viewType: string, editable0: boolean, outer: NodeInfo | null): Promise<NameManager> => {
    if (root.tag !== viewType) fail(`The root node of a ${viewType} view should be a <${viewType}>, not a <${root.tag}>`, root);
    if (!env.reg.models.has(modelName)) fail(`Model not found: ${modelName}`, root);
    const validate0 = outer?.validate ?? false;
    const modelGroups0 = (outer?.modelGroups ?? defs.universe).and(await modelGroups(env, modelName));
    const viewGroups0 = outer?.viewGroups ?? defs.universe;
    const fields = env.reg.model(modelName).fields;
    const nm = new NameManager(modelName, fields, outer?.nm ?? null, modelGroups0);
    const topType = root.tag;
    const stack: [Element, Groups, boolean, boolean][] = [[root, viewGroups0, editable0, validate0]];
    while (stack.length) {
      const [node, viewGroups, editable, inherited] = stack.pop()!;
      const tag = node.tag;
      const validate = inherited || node.attrib.has("__validate__");
      const field = tag === "field" ? fields.get(node.attrib.get("name") ?? "") : undefined;
      // :1787-1803 _editable_node
      const editableNode = tag === "form" ? true : tag === "list" ? !!(node.attrib.get("editable") || node.attrib.get("multi_edit"))
        : tag === "field" ? (!field || (!field.readonly && !["1", "True"].includes(node.attrib.get("readonly") ?? ""))) : !viewTypes.has(tag);
      const info: NodeInfo = { editable: editable && editableNode, validate, viewType: topType, modelGroups: modelGroups0, viewGroups, nm };
      const groupsAttr = node.attrib.get("groups");
      if (groupsAttr) info.viewGroups = info.viewGroups.and(defs.parse(groupsAttr)); // must_exist_group only warns
      await validateTag(node, info);
      if (validate) validateAttributes(node, info);
      const kids = node.children.filter(isElement);
      for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i]!, info.viewGroups, info.editable, validate]);
    }
    await check(nm);
    return nm;
  };

  const detach = (node: Element): void => {
    const p = node.parent;
    if (!p) return;
    const i = p.children.indexOf(node);
    if (i >= 0) p.children.splice(i, 1);
    node.parent = null;
  };

  const validateTag = async (node: Element, info: NodeInfo): Promise<void> => {
    const nm = info.nm;
    const children = node.children.filter(isElement);
    switch (node.tag) {
      case "list": {
        if (!info.validate) return;
        const editable = node.attrib.get("editable");
        if (editable && !["top", "bottom"].includes(editable)) fail(`The "editable" attribute of list views must be "top" or "bottom", received ${editable}`, node);
        const allowed = ["field", "button", "control", "groupby", "widget", "header", "column"];
        for (const c of children) if (!allowed.includes(c.tag)) fail(`List child can only have one of ${allowed.join(", ")} tag (not ${c.tag})`, c);
        return;
      }
      case "graph": {
        if (!info.validate) return;
        for (const c of children) if (c.tag !== "field") fail(`A <graph> can only contains <field> nodes, found a <${c.tag}>`, c);
        return;
      }
      case "calendar": {
        for (const a of ["date_start", "date_stop", "color", "all_day"]) {
          const v = node.attrib.get(a);
          if (v) nm.hasField(v.split(".")[0]!, info);
        }
        for (const c of children) if (c.tag === "filter") nm.hasField(c.attrib.get("name") ?? "None", info);
        return;
      }
      case "search": {
        const panels = children.filter((c) => c.tag === "searchpanel");
        if (panels.length > 1) fail("Search tag can only contain one search panel", node);
        if (panels.length) {
          detach(panels[0]!);
          await validateNode(panels[0]!, nm.model, "searchpanel", false, info);
        }
        return;
      }
      case "field": return validateTagField(node, info);
      case "filter": return validateTagFilter(node, info);
      case "button": {
        if (!info.validate) return;
        const name = node.attrib.get("name");
        const special = node.attrib.get("special");
        const type = node.attrib.get("type");
        if (special) {
          if (!["cancel", "save", "add"].includes(special)) fail(`Invalid special '${special}' in button`, node);
        } else if (type) {
          if (type !== "action" && type !== "object") return;
          if (!name) return;
          if (type === "object") {
            const v = await verdict(env, nm.model, name);
            if (v === "invalid") fail(`${name} is not a valid action on ${nm.model}`, node);
            if (v === "private") fail(`${name} on ${nm.model} is private and cannot be called from a button`, node);
          } else nm.mustExistActions.set(name, node);
          nm.hasAction(name);
        }
        return;
      }
      case "groupby": {
        const name = node.attrib.get("name");
        if (!name) return;
        const field = nm.fields.get(name);
        if (field) {
          if (info.validate) {
            if (field.type !== "many2one") fail(`Field '${field.name}' found in 'groupby' node can only be of type many2one, found ${field.type}`, node);
            const domain = info.editable ? await descriptionDomain(nm.model, field) : false;
            if (typeof domain === "string") validateDomainIdentifiers(node, info, domain, `domain of python field '${name}'`, field.relation!);
          }
          const group: Element = { kind: "element", tag: "groupby", attrib: new Map(), text: null, children: [], tail: null, parent: null };
          for (const c of [...node.children]) {
            if (isElement(c)) { detach(c); c.parent = group; group.children.push(c); }
          }
          if (!field.relation) throw new NotPorted(`view validation of a groupby on ${nm.model}.${field.name}`);
          await validateNode(group, field.relation, "groupby", false, info);
          nm.hasField(name, info);
        } else if (info.validate) {
          fail(`Field '${name}' found in 'groupby' node does not exist in model ${nm.model}`, node);
        }
        return;
      }
      case "searchpanel": {
        if (!info.validate) return;
        for (const c of children) if (c.attrib.get("domain") && c.attrib.get("select") !== "multi") fail("Searchpanel item with select multi cannot have a domain.", c);
        return;
      }
      case "label": {
        if (!info.validate) return;
        const f = node.attrib.get("for");
        if (!f) fail("Label tag must contain a \"for\". To match label style without corresponding field or button, use 'class=\"o_form_label\"'.", node);
        else nm.usedNames.set(f, '<label for="...">');
        return;
      }
      case "hierarchy": {
        // web_hierarchy/models/ir_ui_view.py:32-55 _validate_tag_hierarchy
        if (!info.validate) return;
        let templates = 0;
        for (const c of children) {
          if (c.tag === "templates") {
            if (!templates) templates += 1;
            else fail("Hierarchy view can contain only one templates tag", c);
          } else if (c.tag !== "field") fail(`Hierarchy child can only be field or template, got ${c.tag}`, c);
        }
        const valid = new Set(["__validate__", "class", "js_class", "string", "create", "edit", "delete", "parent_field", "child_field", "draggable", "default_order", "avatar_field", "label"]);
        // the message prints two Python sets (hash order)
        if ([...node.attrib.keys()].some((a) => !valid.has(a))) throw new NotPorted("invalid attributes of a hierarchy view (Python set repr in the message)");
        return;
      }
      case "page": {
        if (!info.validate) return;
        if (!node.parent || node.parent.tag !== "notebook") fail("Page direct ancestor must be notebook", node);
        return;
      }
      default: return;
    }
  };

  const validateTagField = async (node: Element, info: NodeInfo): Promise<void> => {
    const nm = info.nm;
    const name = node.attrib.get("name");
    if (!name) return fail('Field tag must have a "name" attribute defined', node);
    const field = nm.fields.get(name);
    if (field) {
      if (field.groups?.length) info.modelGroups = info.modelGroups.and(defs.parse(field.groups.join(",")));
      const relational = ["many2one", "one2many", "many2many"].includes(field.type);
      if (info.validate && relational) {
        const domain = node.attrib.get("domain") || (info.editable ? await descriptionDomain(nm.model, field) : false);
        if (typeof domain === "string") {
          const desc = node.attrib.get("domain") ? `domain of <field name="${name}">` : `domain of python field ${pyStrRepr(name)}`;
          validateDomainIdentifiers(node, info, domain, desc, field.relation!);
        }
      } else if (info.validate && node.attrib.get("domain")) {
        fail(`Domain on non-relational field "${name}" makes no sense (domain:${node.attrib.get("domain")})`, node);
      }
      if (field.type === "properties" && info.viewType !== "search") {
        if (!field.definitionRecord) throw new NotPorted(`properties field ${nm.model}.${name} without a definition record`);
        nm.mustHaveFields(node, [field.definitionRecord], info, `definition record of ${field.name}`, batches++);
      }
      for (const child of [...node.children]) {
        if (!isElement(child) || !["form", "list", "graph", "kanban", "calendar"].includes(child.tag)) continue;
        detach(child);
        if (!field.relation) throw new NotPorted(`view validation of a sub-view on ${nm.model}.${field.name}`);
        await validateNode(child, field.relation, child.tag, info.editable, info);
      }
    } else if (info.validate) {
      fail(`Field "${name}" does not exist in model "${nm.model}"`, node);
    }
    nm.hasField(name, info, { id: node.attrib.get("id") ?? null, select: node.attrib.get("select") ?? null });
  };

  const validateTagFilter = async (node: Element, info: NodeInfo): Promise<void> => {
    if (!info.validate) return;
    const nm = info.nm;
    const domain = node.attrib.get("domain");
    if (domain) {
      const name = node.attrib.get("name");
      validateDomainIdentifiers(node, info, domain, name ? `domain of <filter name="${name}">` : "domain of <filter>", nm.model);
    }
    if (node.attrib.get("end_date") && !node.attrib.get("date")) fail('Attribute "end_date" requires a "date" attribute', node);
    for (const attribute of ["date", "end_date"]) {
      const fname = node.attrib.get(attribute);
      if (!fname) continue;
      const f = nm.fields.get(fname);
      if (!f) fail(`Field "${fname}" does not exist in model "${nm.model}"`, node);
      else {
        if (f.type !== "date" && f.type !== "datetime") fail(`Field "${fname}" in attribute "${attribute}" must be a date or datetime field`, node);
        if (!f.searchable) fail(`Unsearchable field "${fname}" in attribute "${attribute}"`, node);
      }
    }
    const periods = node.attrib.get("default_period");
    if (node.attrib.get("date") && periods) {
      const custom = new Set(node.children.filter(isElement).map((c) => `custom_${c.attrib.get("name")}`));
      for (const p of periods.split(",")) {
        if (!/^(year|month)((-|\+)[1-9]\d*)?$/u.test(p) && !custom.has(p) && !QUARTER_PERIODS.has(p) && !RELATIVE_PERIODS.has(p)) {
          fail(`Invalid default period ${p} for date filter`, node);
        }
      }
    }
  };

  await validateNode(combined, model, view.type, true, null);
}

export type { GroupDefinitions };
