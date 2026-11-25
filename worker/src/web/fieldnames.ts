/**
 * `get_expression_field_names` (odoo/odoo/tools/view_validation.py:229) and `_get_expression_contextual_values`
 * (:150): the names a view attribute expression reads, using the Python expression parser of src/pyexpr/.
 */
import { NotPorted } from "../errors";
import { compileExpr, type Expr } from "../pyexpr";
import { PyStrSet } from "./pystrset";

/** view_validation.py:22 IGNORED_IN_EXPRESSION. */
const IGNORED_IN_EXPRESSION: ReadonlySet<string> = new Set([
  "True", "False", "None", "self", "uid", "context", "context_today", "allowed_company_ids", "current_company_id",
  "time", "datetime", "relativedelta", "current_date", "today", "now", "abs", "len", "bool", "float", "str", "unicode", "set",
]);

/** view_validation.py:150-226 `_get_expression_contextual_values`, with Python's sets (their order is the order of the
 * names a view adds as missing fields, ir_ui_view.py:3622-3682 and :1546-1592). */
function contextualValues(node: Expr): PyStrSet {
  const union = (first: PyStrSet, ...parts: PyStrSet[]): PyStrSet => {
    for (const p of parts) first.update(p);
    return first;
  };
  switch (node.kind) {
    case "const":
    case "num":
    case "str":
      return new PyStrSet();
    case "list":
    case "tuple":
      return union(new PyStrSet(), ...node.items.map(contextualValues));
    case "name":
      return PyStrSet.of(node.id);
    case "attr": {
      const values = contextualValues(node.obj);
      if (values.size === 1) {
        const path = [...values][0] ?? "";
        return PyStrSet.of(`${path}.${node.name}`);
      }
      return values;
    }
    case "subscript":
      return union(contextualValues(node.obj), contextualValues(node.index));
    case "compare":
      return union(contextualValues(node.left), ...node.comparators.map(contextualValues));
    case "binary":
      return union(contextualValues(node.left), contextualValues(node.right));
    case "bool":
      return union(new PyStrSet(), ...node.values.map(contextualValues));
    case "unary":
      return contextualValues(node.operand);
    case "call":
      // ast.Call: the function and positional args only (keywords are not visited, view_validation.py:206-210)
      return union(contextualValues(node.func), ...node.args.map(contextualValues));
    case "ifexp":
      return union(contextualValues(node.test), contextualValues(node.body), contextualValues(node.orelse));
    case "dict": {
      // :219-225: every key first, then every value; a `**x` item has the key None, which raises ValueError there
      const items = node.items.map((item) => {
        if ("unpack" in item) throw new NotPorted("dict unpacking in a view expression");
        return item;
      });
      return union(new PyStrSet(), ...items.map((item) => contextualValues(item.key)), ...items.map((item) => contextualValues(item.value)));
    }
    case "slice":
    case "lambda":
    case "comp":
      // ast.Slice, ast.Lambda and comprehensions are not handled there (:226 raises ValueError)
      throw new NotPorted(`${node.kind} in a view expression`);
    default: {
      const never: never = node;
      throw new TypeError(String(never));
    }
  }
}

/** The field names used by a Python expression of a view attribute; `parent.x` paths are kept whole. The set's order
 * is Python's (`PYTHONHASHSEED=0`). */
export function expressionFieldNames(expression: string | null | undefined): Set<string> {
  if (expression === null || expression === undefined || expression.trim() === "") return new Set();
  let ast: Expr;
  try {
    ast = compileExpr(expression.trim());
  } catch (e) {
    if (e instanceof NotPorted) throw e;
    throw new NotPorted(`view expression ${JSON.stringify(expression)}: ${e instanceof Error ? e.message : String(e)}`);
  }
  // :251-258: value_names is a set too, and the caller iterates it (ir_ui_view.py:3434-3442 must_have_fields)
  const names = new PyStrSet();
  for (const name of contextualValues(ast)) {
    if (name === "parent") continue;
    const root = name.split(".")[0] ?? "";
    if (!IGNORED_IN_EXPRESSION.has(root)) names.add(root === "parent" ? name : root);
  }
  return new Set(names);
}
