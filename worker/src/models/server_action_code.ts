/**
 * The code of a server action (odoo/odoo/addons/base/models/ir_actions.py:1015-1019 `_run_action_code_multi`:
 * `safe_eval(code, eval_context, mode="exec")`, then the `action` variable) for a subset of Python statements over the
 * expression evaluator of src/pyexpr: expression statements, `name = expr`, `for name in expr:`, `if`/`elif`/`else`,
 * `pass` and `raise UserError(expr)`, one statement per line (a bracket may continue it on the next lines),
 * whole-line and trailing comments. Records are src/qweb/records.ts `PyRecords` with `write(vals)` (the model's write
 * as an RPC call makes it, guard included). Any other statement, a name the eval context does not define
 * (`time`, `datetime`, `log`, ...: NameError or not ported), and any other method refuse with NotPorted before or as
 * they would run: the caller runs the action in the request's transaction, which a refusal rolls back.
 */
import { NotPorted, UserError } from "../errors";
import { lookupMethod } from "../http/methods";
import type { Environment } from "../orm/types";
import { BUILTIN_NAMES, evaluateAsync, parseExpr, type Expr, type Scope } from "../pyexpr";
import { dictEntries, isDict, isPyFloat, Markup, pyBool, PyTuple } from "../pyexpr/values";
import { iterate } from "../pyexpr/eval";
import { hasPyMethod, PyEnv, PyRecords } from "../qweb/records";

export type Stmt =
  | { kind: "expr"; expr: Expr; src: string }
  | { kind: "assign"; name: string; expr: Expr; src: string }
  // `obj[key] = expr`, `obj.attr = expr`: only the compiled code runner (compiler/runtime/safe_eval.ts) runs them
  | { kind: "store"; target: Expr & { kind: "subscript" | "attr" }; expr: Expr; src: string }
  | { kind: "for"; target: string; iter: Expr; body: Stmt[]; src: string }
  | { kind: "if"; branches: { test: Expr | null; body: Stmt[] }[]; src: string }
  | { kind: "pass" }
  | { kind: "raise"; expr: Expr; src: string };

interface Line { indent: number; text: string }

/** Logical lines: comments stripped, bracketed continuations joined; tabs, backslashes and triple quotes refuse. */
export function logicalLines(code: string): Line[] {
  const out: Line[] = [];
  let buf = "", depth = 0, indent = 0;
  for (const raw of code.split("\n")) {
    if (raw.includes("\t")) throw new NotPorted("server action code indented with tabs");
    let quote: string | null = null, text = "";
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]!;
      if (quote) {
        text += ch;
        if (ch === "\\") { text += raw[++i] ?? ""; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "#") break;
      if (ch === "'" || ch === '"') {
        if (raw.slice(i, i + 3) === ch.repeat(3)) throw new NotPorted("server action code with a triple-quoted string");
        quote = ch;
      } else if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth--;
      text += ch;
    }
    if (quote) throw new NotPorted("server action code with a string over several lines");
    if (/\\\s*$/.test(text)) throw new NotPorted("server action code with a backslash continuation");
    if (buf === "") {
      if (text.trim() === "") { depth = 0; continue; }
      indent = text.length - text.trimStart().length;
      buf = text.trim();
    } else buf += " " + text.trim();
    if (depth > 0) continue;
    if (depth < 0) throw new NotPorted("server action code with unbalanced brackets (SyntaxError)");
    out.push({ indent, text: buf });
    buf = "";
  }
  if (buf !== "") throw new NotPorted("server action code with an unclosed bracket (SyntaxError)");
  return out;
}

const KEYWORD = /^(def|class|while|try|except|finally|with|import|from|return|yield|del|global|nonlocal|lambda|assert|break|continue|async|await|elif|else)\b/;

/** The statements of the lines at `indent` from `pos` (the block ends at a smaller indent). */
function parseBlock(lines: Line[], pos: { i: number }, indent: number): Stmt[] {
  const out: Stmt[] = [];
  while (pos.i < lines.length) {
    const line = lines[pos.i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new NotPorted("server action code with an unexpected indent (IndentationError)");
    const t = line.text;
    pos.i++;
    let m: RegExpExecArray | null;
    if (t === "pass") { out.push({ kind: "pass" }); continue; }
    if ((m = /^for\s+([A-Za-z_]\w*)\s+in\s+(.+):$/.exec(t))) {
      out.push({ kind: "for", target: m[1]!, iter: parseExpr(m[2]!), body: body(lines, pos, indent), src: t });
      continue;
    }
    if ((m = /^if\s+(.+):$/.exec(t))) {
      const branches: { test: Expr | null; body: Stmt[] }[] = [{ test: parseExpr(m[1]!), body: body(lines, pos, indent) }];
      while (pos.i < lines.length && lines[pos.i]!.indent === indent) {
        const next = lines[pos.i]!.text;
        const e = /^elif\s+(.+):$/.exec(next);
        if (e) { pos.i++; branches.push({ test: parseExpr(e[1]!), body: body(lines, pos, indent) }); continue; }
        if (/^else\s*:$/.test(next)) { pos.i++; branches.push({ test: null, body: body(lines, pos, indent) }); }
        break;
      }
      out.push({ kind: "if", branches, src: t });
      continue;
    }
    if ((m = /^raise\s+(.+)$/.exec(t))) {
      const expr = parseExpr(m[1]!);
      if (expr.kind !== "call" || expr.func.kind !== "name" || expr.func.id !== "UserError" || expr.args.length !== 1 || expr.kwargs.length) {
        throw new NotPorted(`server action code: ${t}`);
      }
      out.push({ kind: "raise", expr: expr.args[0]!, src: t });
      continue;
    }
    if (KEYWORD.test(t) || t.endsWith(":") || /^[A-Za-z_]\w*\s*(\+|-|\*|\/|%|\/\/|\*\*|&|\||\^|>>|<<)=/.test(t)) throw new NotPorted(`server action code: ${t}`);
    if ((m = /^([A-Za-z_]\w*)\s*=(?!=)\s*(.+)$/.exec(t))) {
      out.push({ kind: "assign", name: m[1]!, expr: parseExpr(m[2]!), src: t });
      continue;
    }
    // `a[k] = v`, `a.b = v` (one target, no tuple): the target's text up to the first `=` outside brackets and strings
    const eq = storeSplit(t);
    if (eq !== null) {
      const target = parseExpr(t.slice(0, eq).trim());
      if (target.kind === "subscript" || target.kind === "attr") {
        out.push({ kind: "store", target, expr: parseExpr(t.slice(eq + 1).trim()), src: t });
        continue;
      }
    }
    // tuple targets, attribute and subscript assignments, annotations
    if (/^[^'"(]*[^=!<>]=[^=]/.test(t) && !/^[A-Za-z_][\w.]*\(/.test(t)) throw new NotPorted(`server action code: ${t}`);
    out.push({ kind: "expr", expr: parseExpr(t), src: t });
  }
  return out;
}

/** The index of an assignment's `=` (not `==`, `<=`, `>=`, `!=`, nor inside brackets or strings), or null. */
function storeSplit(t: string): number | null {
  let depth = 0, quote: string | null = null;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (quote) { if (ch === "\\") i++; else if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') quote = ch;
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === "=" && depth === 0 && t[i + 1] !== "=" && !"=<>!".includes(t[i - 1] ?? "")) return i;
  }
  return null;
}

function body(lines: Line[], pos: { i: number }, indent: number): Stmt[] {
  const next = lines[pos.i];
  if (!next || next.indent <= indent) throw new NotPorted("server action code: expected an indented block (IndentationError)");
  return parseBlock(lines, pos, next.indent);
}

export function parseProgram(code: string): Stmt[] {
  const lines = logicalLines(code);
  if (!lines.length) return [];
  if (lines[0]!.indent !== 0) throw new NotPorted("server action code with an unexpected indent (IndentationError)");
  const pos = { i: 0 };
  const out = parseBlock(lines, pos, 0);
  if (pos.i !== lines.length) throw new NotPorted("server action code with an unindent that matches no block (IndentationError)");
  return out;
}

/** The free names of an expression (lambda parameters and comprehension targets are local). */
export function freeNames(e: Expr, local: ReadonlySet<string>, out: Set<string>): void {
  const go = (x: Expr | null, l: ReadonlySet<string> = local): void => { if (x) freeNames(x, l, out); };
  switch (e.kind) {
    case "name": if (!local.has(e.id)) out.add(e.id); return;
    case "const": case "num": case "str": return;
    case "list": case "tuple": e.items.forEach((x) => go(x)); return;
    case "dict": for (const it of e.items) { if ("unpack" in it) go(it.unpack); else { go(it.key); go(it.value); } } return;
    case "attr": go(e.obj); return;
    case "subscript": go(e.obj); go(e.index); return;
    case "slice": go(e.obj); go(e.lower); go(e.upper); go(e.step); return;
    case "call": go(e.func); e.args.forEach((x) => go(x)); e.kwargs.forEach((k) => go(k.value)); return;
    case "unary": go(e.operand); return;
    case "binary": go(e.left); go(e.right); return;
    case "compare": go(e.left); e.comparators.forEach((x) => go(x)); return;
    case "bool": e.values.forEach((x) => go(x)); return;
    case "ifexp": go(e.test); go(e.body); go(e.orelse); return;
    case "lambda": go(e.body, new Set([...local, ...e.params])); return;
    case "comp": {
      let l = new Set(local);
      for (const c of e.clauses) { go(c.iter, l); l = new Set([...l, ...c.targets]); c.ifs.forEach((x) => go(x, l)); }
      go(e.elt, l); go(e.value, l);
      return;
    }
    default: { const never: never = e; return never; }
  }
}

async function evalIn(expr: Expr, scope: Scope, src: string): Promise<unknown> {
  const names = new Set<string>();
  freeNames(expr, new Set(), names);
  for (const n of names) {
    // safe_eval: a name neither in the eval context nor assigned before is a NameError (wrapped in a ValueError)
    if (!scope.has(n) && !BUILTIN_NAMES.has(n)) throw new NotPorted(`server action code: name ${n} (${src})`);
  }
  return evaluateAsync(expr, scope, src);
}

async function exec(stmts: readonly Stmt[], scope: Scope): Promise<void> {
  for (const s of stmts) {
    switch (s.kind) {
      case "pass": break;
      case "expr": await evalIn(s.expr, scope, s.src); break;
      case "assign": scope.set(s.name, await evalIn(s.expr, scope, s.src)); break;
      case "store": throw new NotPorted(`server action code: ${s.src}`);
      case "raise": {
        const v = await evalIn(s.expr, scope, s.src);
        if (typeof v !== "string") throw new NotPorted(`server action code: ${s.src} with a ${typeof v} message`);
        throw new UserError(v);
      }
      case "for":
        for (const item of iterate(await evalIn(s.iter, scope, s.src), "for")) {
          scope.set(s.target, item);
          await exec(s.body, scope);
        }
        break;
      case "if":
        for (const b of s.branches) {
          if (b.test === null || pyBool(await evalIn(b.test, scope, s.src))) { await exec(b.body, scope); break; }
        }
        break;
      default: { const never: never = s; return never; }
    }
  }
}

/** A Python value written through `write()`: scalars only (x2many commands and records refuse). */
function ormValue(v: unknown, what: string): unknown {
  if (v === null || v === undefined) return false;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (isPyFloat(v)) return v.float;
  if (v instanceof Markup) return v.toString();
  throw new NotPorted(`server action code: ${what} value of type ${v instanceof PyTuple ? "tuple" : Array.isArray(v) ? "list" : typeof v}`);
}

/** Records in server action code: `PyRecords` with `write`. */
export class PyActionRecords extends PyRecords {
  override browse(ids: readonly number[]): PyRecords {
    return new PyActionRecords(this.env, this.model, ids);
  }
  protected override with(env: Environment): PyRecords {
    return new PyActionRecords(env, this.model, this.ids);
  }
  override pyGetAttr(name: string): unknown {
    // A public method of the model without arguments (`action = model.with_context(...).action_view_quants()`, the
    // standard menu server actions): the method as the RPC call runs it, on these records under this environment
    // (ir_actions.py:1129-1167 gives `model` and `records` as recordsets; a method call is the model's own method)
    if (!name.startsWith("_") && !HAND_METHODS.has(name) && !RECORD_ATTRS.has(name) && !hasPyMethod(this.model, name) && !this.def.fields.has(name)) {
      const m = lookupMethod(this.model, name);
      if (m) {
        return async (...raw: unknown[]) => {
          if (raw.length) throw new NotPorted(`server action code: ${this.model}.${name}() with arguments`);
          const own = m.apiModel || m.rawArgs;
          return m.fn(this.env, own ? null : [...this.ids], m.rawArgs ? [[...this.ids]] : [], {}, this.model);
        };
      }
    }
    if (name === "write") {
      return async (vals: unknown) => {
        if (!isDict(vals)) throw new NotPorted("server action code: write() of a non-dict");
        const values: Record<string, unknown> = {};
        for (const [k, v] of dictEntries(vals)) values[String(k)] = ormValue(v, `write ${String(k)}`);
        // models.py write as the RPC write runs it (the model's own write, the override guard)
        const m = lookupMethod(this.model, "write");
        if (!m) throw new NotPorted(`${this.model}.write`);
        await m.fn(this.env, [...this.ids], [values], {}, this.model);
        return true;
      };
    }
    return super.pyGetAttr(name);
  }
}

/** `env` in server action code: `env['model']` gives `PyActionRecords`. */
class PyActionEnv extends PyEnv {
  override pyGetItem(key: unknown): unknown {
    const model = String(key);
    if (!this.env.reg.models.has(model)) throw new NotPorted(`server action code: env[${JSON.stringify(model)}] (KeyError)`);
    return new PyActionRecords(this.env, model, []);
  }
  override pyGetAttr(name: string): unknown {
    if (name === "user") return new PyActionRecords(this.env, "res.users", [this.env.uid]);
    return super.pyGetAttr(name);
  }
}

/** A Python value as JSON (the `action` dict returned to the client). */
export function toJson(v: unknown): unknown {
  if (v === null || v === undefined) return false;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (isPyFloat(v)) return v;
  if (v instanceof Markup) return v.toString();
  if (Array.isArray(v)) return v.map(toJson);
  if (isDict(v)) return Object.fromEntries(dictEntries(v).map(([k, x]) => [String(k), toJson(x)]));
  throw new NotPorted(`server action code: an action value of type ${typeof v}`);
}

/**
 * ir_actions.py:1129-1167 `_get_eval_context` (the names given: env, model, record, records, uid, user, UserError) and
 * `_run_action_code_multi`: the program run once over `records`, its `action` returned (None when unset).
 */
export async function runActionCode(env: Environment, model: string, code: string, record: number | null, records: readonly number[] | null): Promise<unknown> {
  const stmts = parseProgram(code.trim());
  const scope: Scope = new Map<string, unknown>([
    ["env", new PyActionEnv(env)],
    ["model", new PyActionRecords(env, model, [])],
    ["record", record === null ? null : new PyActionRecords(env, model, [record])],
    ["records", records === null ? null : new PyActionRecords(env, model, records)],
    ["uid", env.uid],
    ["user", new PyActionRecords(env, "res.users", [env.uid])],
    ["UserError", null],
  ]);
  await exec(stmts, scope);
  return scope.get("action") ?? null;
}

/** The methods this interpreter answers on records (`PyActionRecords.write` and src/qweb/records.ts PyRecords). */
const HAND_METHODS = new Set(["write", "sudo", "with_user", "ensure_one", "exists", "with_context", "filtered", "sorted", "mapped"]);
/** The other attributes src/qweb/records.ts PyRecords answers itself. */
const RECORD_ATTRS = new Set(["id", "ids", "env", "browse"]);
const HAND_NAMES = new Set(["env", "model", "record", "records", "uid", "user", "UserError"]);

/** Every expression of a program, in order (the targets of `store` included). */
export function programExprs(stmts: readonly Stmt[]): Expr[] {
  const out: Expr[] = [];
  for (const s of stmts) {
    switch (s.kind) {
      case "pass": break;
      case "expr": case "assign": case "raise": out.push(s.expr); break;
      case "store": out.push(s.target, s.expr); break;
      case "for": out.push(s.iter, ...programExprs(s.body)); break;
      case "if": for (const b of s.branches) { if (b.test) out.push(b.test); out.push(...programExprs(b.body)); } break;
      default: { const never: never = s; return never; }
    }
  }
  return out;
}

/** The names a program assigns (`name = ...`, `for name in ...`): known to every later read, as safe_eval's globals. */
export function assignedNames(stmts: readonly Stmt[], out = new Set<string>()): Set<string> {
  for (const s of stmts) {
    if (s.kind === "assign") out.add(s.name);
    else if (s.kind === "for") { out.add(s.target); assignedNames(s.body, out); }
    else if (s.kind === "if") for (const b of s.branches) assignedNames(b.body, out);
  }
  return out;
}

/** The attribute names a program calls (`x.name(...)`). */
export function calledMethods(e: Expr, out: Set<string>): void {
  const go = (x: Expr | null): void => { if (x) calledMethods(x, out); };
  switch (e.kind) {
    case "name": case "const": case "num": case "str": return;
    case "list": case "tuple": e.items.forEach(go); return;
    case "dict": for (const it of e.items) { if ("unpack" in it) go(it.unpack); else { go(it.key); go(it.value); } } return;
    case "attr": go(e.obj); return;
    case "subscript": go(e.obj); go(e.index); return;
    case "slice": go(e.obj); go(e.lower); go(e.upper); go(e.step); return;
    case "call": if (e.func.kind === "attr") out.add(e.func.name); go(e.func); e.args.forEach(go); e.kwargs.forEach((k) => go(k.value)); return;
    case "unary": go(e.operand); return;
    case "binary": go(e.left); go(e.right); return;
    case "compare": go(e.left); e.comparators.forEach(go); return;
    case "bool": e.values.forEach(go); return;
    case "ifexp": go(e.test); go(e.body); go(e.orelse); return;
    case "lambda": go(e.body); return;
    case "comp": for (const c of e.clauses) { go(c.iter); c.ifs.forEach(go); } go(e.elt); go(e.value); return;
    default: { const never: never = e; return never; }
  }
}

/**
 * Whether this interpreter takes the program as it is read (compiler/cron_scan.py "before"): it parses, its statements
 * are this interpreter's, its names are in its eval context and on records it calls only the methods it answers. A
 * program it does not take goes to the compiled code runner where a build serves the database (`codeRunnerFor`).
 */
export function handTakes(code: string): boolean {
  let stmts: Stmt[];
  try { stmts = parseProgram(code.trim()); } catch (e) { if (e instanceof NotPorted) return false; throw e; }
  const stores = (ss: readonly Stmt[]): boolean => ss.some((s) => s.kind === "store" || (s.kind === "for" && stores(s.body)) || (s.kind === "if" && s.branches.some((b) => stores(b.body))));
  if (stores(stmts)) return false;
  const assigned = assignedNames(stmts);
  const names = new Set<string>(), methods = new Set<string>();
  for (const e of programExprs(stmts)) { freeNames(e, new Set(), names); calledMethods(e, methods); }
  if ([...names].some((n) => !assigned.has(n) && !HAND_NAMES.has(n) && !BUILTIN_NAMES.has(n))) return false;
  return [...methods].every((m) => HAND_METHODS.has(m));
}

/**
 * The compiled code runner (compiler/runtime/safe_eval.ts, installed with a compiled build): server action code run
 * as Odoo's safe_eval runs it, over the build's compiled methods and the hand port's. `accepts` reads the program
 * without running it: null when no build serves the database, a NotPorted naming what it cannot evaluate otherwise.
 */
export interface CompiledCodeRunner {
  accepts(env: Environment, model: string, code: string): Promise<NotPorted | null | true>;
  run(env: Environment, model: string, code: string, record: number | null, records: readonly number[] | null): Promise<unknown>;
}
let compiledRunner: CompiledCodeRunner | null = null;
export function registerCompiledCodeRunner(runner: CompiledCodeRunner): void {
  if (compiledRunner) throw new Error("compiled code runner registered twice");
  compiledRunner = runner;
}

/**
 * The runner of a program: this interpreter when it takes it, else the compiled runner when it accepts it, else none
 * (`refusal` says why: the compiled runner's reason when a build serves the database, or that none does). A program
 * no runner takes is run by this interpreter all the same, which refuses it as before (or answers the rare program it
 * takes beyond `handTakes`: a string method).
 */
export async function codeRunnerFor(env: Environment, model: string, code: string): Promise<{ runner: "hand" | "compiled" | null; refusal: NotPorted | null }> {
  if (handTakes(code)) return { runner: "hand", refusal: null };
  if (!compiledRunner) return { runner: null, refusal: new NotPorted(`server action code without a compiled build: ${code.trim().slice(0, 200)}`) };
  const verdict = await compiledRunner.accepts(env, model, code);
  if (verdict === true) return { runner: "compiled", refusal: null };
  return { runner: null, refusal: verdict ?? new NotPorted(`server action code on a database no compiled build serves: ${code.trim().slice(0, 200)}`) };
}

/** `_run_action_code_multi` by the runner `codeRunnerFor` chose. */
export async function runCode(env: Environment, model: string, code: string, record: number | null, records: readonly number[] | null): Promise<unknown> {
  const { runner } = await codeRunnerFor(env, model, code);
  if (runner === "compiled") return compiledRunner!.run(env, model, code, record, records);
  return runActionCode(env, model, code, record, records);
}
