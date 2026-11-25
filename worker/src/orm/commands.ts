/**
 * x2many write values as `Command` triples (odoo/odoo/orm/commands.py:7-140) and their normalisation by
 * `_X2many._parse_write_commands` (odoo/odoo/orm/fields_relational.py:810-832). Pure: no database access.
 */
import { NotPorted } from "../errors";
import { PyValueError as OdooValueError } from "./domain";

export type Command =
  | { readonly op: "create"; readonly ref: unknown; readonly values: Record<string, unknown> }
  | { readonly op: "update"; readonly id: number; readonly values: Record<string, unknown> }
  | { readonly op: "delete"; readonly id: number }
  | { readonly op: "unlink"; readonly id: number }
  | { readonly op: "link"; readonly id: number }
  | { readonly op: "clear" }
  | { readonly op: "set"; readonly ids: readonly number[] };

/** commands.py:33-39 */
export const CREATE = 0, UPDATE = 1, DELETE = 2, UNLINK = 3, LINK = 4, CLEAR = 5, SET = 6;

function isDict(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function intId(v: unknown, what: string): number {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  throw new NotPorted(`x2many command ${what} with id ${JSON.stringify(v)}`);
}

function idList(v: unknown, what: string): number[] {
  if (!Array.isArray(v)) throw new NotPorted(`x2many command ${what} with ids ${JSON.stringify(v)}`);
  return v.map((x) => intId(x, what));
}

/**
 * fields_relational.py:813-824: a tuple/recordset means SET, False/None means CLEAR, a list of ids (first item
 * not a list) means SET; anything else must be a list of commands. JSON has no tuples, so a list of numbers is the
 * "list of ids" case.
 */
export function parseCommands(value: unknown, field: string): Command[] {
  if (value === false || value === null || value === undefined) return [{ op: "clear" }];
  if (!Array.isArray(value)) throw new OdooValueError(`Wrong value for ${field}: ${JSON.stringify(value)}`);
  if (value.length && !Array.isArray(value[0])) return [{ op: "set", ids: idList(value, "SET") }];
  return value.map((raw): Command => {
    if (!Array.isArray(raw) || raw.length === 0) throw new NotPorted(`x2many command ${JSON.stringify(raw)}`);
    const [code, a, b] = raw as unknown[];
    switch (code) {
      case CREATE:
        if (!isDict(b)) throw new NotPorted(`CREATE command without values: ${JSON.stringify(raw)}`);
        return { op: "create", ref: a, values: b };
      case UPDATE:
        if (!isDict(b)) throw new NotPorted(`UPDATE command without values: ${JSON.stringify(raw)}`);
        return { op: "update", id: intId(a, "UPDATE"), values: b };
      case DELETE: return { op: "delete", id: intId(a, "DELETE") };
      case UNLINK: return { op: "unlink", id: intId(a, "UNLINK") };
      case LINK: return { op: "link", id: intId(a, "LINK") };
      case CLEAR: return { op: "clear" };
      case SET: return { op: "set", ids: idList(b, "SET") };
      default: throw new NotPorted(`x2many command code ${JSON.stringify(code)}`);
    }
  });
}

/** Python's builtins.ValueError raised by the ORM ("Wrong value for ..."). */
export { OdooValueError };
