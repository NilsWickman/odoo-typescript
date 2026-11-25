/**
 * Parser for the Python expression subset of QWeb templates and view attributes: names, constants, strings,
 * numbers, lists, tuples, dicts (incl. `**` unpacking), attribute access, subscripts and slices, calls with
 * positional and keyword arguments, unary/binary arithmetic, comparisons (chained, `in`, `not in`, `is`,
 * `is not`), `and`/`or`/`not`, the conditional expression, lambdas and comprehensions (those two evaluate in
 * `evaluateAsync` only). Starred arguments, walrus and bitwise operators raise NotPorted.
 */
import { NotPorted } from "../errors";
import { tokenize, type Token } from "./tokenize";

export type Expr =
  | { kind: "name"; id: string }
  | { kind: "const"; value: null | boolean }
  | { kind: "num"; value: number; isFloat: boolean }
  | { kind: "str"; value: string }
  | { kind: "list"; items: Expr[] }
  | { kind: "tuple"; items: Expr[] }
  | { kind: "dict"; items: ({ key: Expr; value: Expr } | { unpack: Expr })[] }
  | { kind: "attr"; obj: Expr; name: string }
  | { kind: "subscript"; obj: Expr; index: Expr }
  | { kind: "slice"; obj: Expr; lower: Expr | null; upper: Expr | null; step: Expr | null }
  | { kind: "call"; func: Expr; args: Expr[]; kwargs: { name: string; value: Expr }[] }
  | { kind: "unary"; op: "-" | "+" | "not"; operand: Expr }
  | { kind: "binary"; op: "+" | "-" | "*" | "/" | "//" | "%" | "**"; left: Expr; right: Expr }
  | { kind: "compare"; left: Expr; ops: CompareOp[]; comparators: Expr[] }
  | { kind: "bool"; op: "and" | "or"; values: Expr[] }
  | { kind: "ifexp"; test: Expr; body: Expr; orelse: Expr }
  | { kind: "lambda"; params: string[]; body: Expr }
  // `gen`: a generator expression (`(x for ...)`, `f(x for ...)`), which src/pyexpr evaluates as a list
  | { kind: "comp"; elt: Expr; value: Expr | null; clauses: CompClause[]; gen?: true };

/** `for a, b in iter if c if d` of a comprehension. */
export interface CompClause { targets: string[]; iter: Expr; ifs: Expr[] }

export type CompareOp = "==" | "!=" | "<" | ">" | "<=" | ">=" | "in" | "not in" | "is" | "is not";

class Parser {
  pos = 0;
  constructor(readonly tokens: Token[], readonly src: string) {}

  fail(what: string): never {
    throw new NotPorted(`python expression ${JSON.stringify(this.src)}: ${what}`);
  }

  peek(): Token {
    return this.tokens[this.pos]!;
  }

  next(): Token {
    return this.tokens[this.pos++]!;
  }

  isOp(value: string): boolean {
    const t = this.peek();
    return t.kind === "op" && t.value === value;
  }

  isName(value: string): boolean {
    const t = this.peek();
    return t.kind === "name" && t.value === value;
  }

  expectOp(value: string): void {
    if (!this.isOp(value)) this.fail(`expected ${JSON.stringify(value)}`);
    this.pos++;
  }

  parse(): Expr {
    const e = this.testlist();
    if (this.peek().kind !== "end") this.fail("unexpected trailing tokens");
    return e;
  }

  /** `a, b` at top level is a tuple. */
  testlist(): Expr {
    const first = this.test();
    if (!this.isOp(",")) return first;
    const items = [first];
    while (this.isOp(",")) {
      this.pos++;
      if (this.peek().kind === "end" || this.isOp(")")) break;
      items.push(this.test());
    }
    return { kind: "tuple", items };
  }

  test(): Expr {
    if (this.isName("lambda")) {
      this.pos++;
      const params: string[] = [];
      while (!this.isOp(":")) {
        const t = this.next();
        if (t.kind !== "name") this.fail("lambda parameter");
        params.push(t.value);
        if (this.isOp(",")) this.pos++;
      }
      this.pos++;
      return { kind: "lambda", params, body: this.test() };
    }
    const body = this.orTest();
    if (this.isName("if")) {
      this.pos++;
      const test = this.orTest();
      if (!this.isName("else")) this.fail("conditional expression without else");
      this.pos++;
      const orelse = this.test();
      return { kind: "ifexp", test, body, orelse };
    }
    return body;
  }

  orTest(): Expr {
    const first = this.andTest();
    if (!this.isName("or")) return first;
    const values = [first];
    while (this.isName("or")) {
      this.pos++;
      values.push(this.andTest());
    }
    return { kind: "bool", op: "or", values };
  }

  andTest(): Expr {
    const first = this.notTest();
    if (!this.isName("and")) return first;
    const values = [first];
    while (this.isName("and")) {
      this.pos++;
      values.push(this.notTest());
    }
    return { kind: "bool", op: "and", values };
  }

  notTest(): Expr {
    if (this.isName("not")) {
      this.pos++;
      return { kind: "unary", op: "not", operand: this.notTest() };
    }
    return this.comparison();
  }

  comparison(): Expr {
    const left = this.arith();
    const ops: CompareOp[] = [];
    const comparators: Expr[] = [];
    for (;;) {
      const t = this.peek();
      let op: CompareOp | null = null;
      if (t.kind === "op" && ["==", "!=", "<", ">", "<=", ">="].includes(t.value)) {
        op = t.value as CompareOp;
        this.pos++;
      } else if (t.kind === "name" && t.value === "in") {
        op = "in";
        this.pos++;
      } else if (t.kind === "name" && t.value === "not" && this.tokens[this.pos + 1]?.kind === "name" && (this.tokens[this.pos + 1] as { value: string }).value === "in") {
        op = "not in";
        this.pos += 2;
      } else if (t.kind === "name" && t.value === "is") {
        this.pos++;
        if (this.isName("not")) {
          this.pos++;
          op = "is not";
        } else op = "is";
      }
      if (op === null) break;
      ops.push(op);
      comparators.push(this.arith());
    }
    if (ops.length === 0) return left;
    return { kind: "compare", left, ops, comparators };
  }

  arith(): Expr {
    let left = this.term();
    for (;;) {
      if (this.isOp("+") || this.isOp("-")) {
        const op = (this.next() as { value: "+" | "-" }).value;
        left = { kind: "binary", op, left, right: this.term() };
      } else if (this.isOp("|") || this.isOp("&") || this.isOp("^") || this.isOp("<<") || this.isOp(">>")) {
        this.fail("bitwise operator");
      } else return left;
    }
  }

  term(): Expr {
    let left = this.factor();
    for (;;) {
      if (this.isOp("*") || this.isOp("/") || this.isOp("//") || this.isOp("%")) {
        const op = (this.next() as { value: "*" | "/" | "//" | "%" }).value;
        left = { kind: "binary", op, left, right: this.factor() };
      } else if (this.isOp("@")) this.fail("matrix multiplication");
      else return left;
    }
  }

  factor(): Expr {
    if (this.isOp("-") || this.isOp("+")) {
      const op = (this.next() as { value: "-" | "+" }).value;
      return { kind: "unary", op, operand: this.factor() };
    }
    if (this.isOp("~")) this.fail("bitwise not");
    return this.power();
  }

  power(): Expr {
    const base = this.primary();
    if (this.isOp("**")) {
      this.pos++;
      return { kind: "binary", op: "**", left: base, right: this.factor() };
    }
    return base;
  }

  primary(): Expr {
    let e = this.atom();
    for (;;) {
      if (this.isOp(".")) {
        this.pos++;
        const t = this.next();
        if (t.kind !== "name") this.fail("expected an attribute name after '.'");
        e = { kind: "attr", obj: e, name: t.value };
      } else if (this.isOp("(")) {
        this.pos++;
        e = this.callArgs(e);
      } else if (this.isOp("[")) {
        this.pos++;
        e = this.subscript(e);
      } else return e;
    }
  }

  /** The `for ... in ... if ...` clauses after the element of a comprehension. */
  compClauses(): CompClause[] {
    const clauses: CompClause[] = [];
    while (this.isName("for")) {
      this.pos++;
      const targets: string[] = [];
      for (;;) {
        const t = this.next();
        if (t.kind !== "name") this.fail("comprehension target");
        targets.push(t.value);
        if (!this.isOp(",")) break;
        this.pos++;
      }
      if (!this.isName("in")) this.fail("comprehension without in");
      this.pos++;
      const iter = this.orTest();
      const ifs: Expr[] = [];
      while (this.isName("if")) {
        this.pos++;
        ifs.push(this.orTest());
      }
      clauses.push({ targets, iter, ifs });
    }
    return clauses;
  }

  callArgs(func: Expr): Expr {
    const args: Expr[] = [];
    const kwargs: { name: string; value: Expr }[] = [];
    while (!this.isOp(")")) {
      if (this.isOp("*") || this.isOp("**")) this.fail("starred call argument");
      const t = this.peek();
      const after = this.tokens[this.pos + 1];
      if (t.kind === "name" && after?.kind === "op" && after.value === "=") {
        this.pos += 2;
        kwargs.push({ name: t.value, value: this.test() });
      } else {
        if (kwargs.length > 0) this.fail("positional argument after keyword argument");
        const arg = this.test();
        args.push(this.isName("for") ? { kind: "comp", elt: arg, value: null, clauses: this.compClauses(), gen: true } : arg);
      }
      if (this.isOp(",")) this.pos++;
      else if (!this.isOp(")")) this.fail("expected ',' or ')' in call");
    }
    this.pos++;
    return { kind: "call", func, args, kwargs };
  }

  subscript(obj: Expr): Expr {
    let lower: Expr | null = null;
    let upper: Expr | null = null;
    let step: Expr | null = null;
    let isSlice = false;
    if (!this.isOp(":")) lower = this.test();
    if (this.isOp(":")) {
      isSlice = true;
      this.pos++;
      if (!this.isOp(":") && !this.isOp("]")) upper = this.test();
      if (this.isOp(":")) {
        this.pos++;
        if (!this.isOp("]")) step = this.test();
      }
    }
    if (this.isOp(",")) this.fail("tuple subscript");
    this.expectOp("]");
    if (isSlice) return { kind: "slice", obj, lower, upper, step };
    return { kind: "subscript", obj, index: lower! };
  }

  atom(): Expr {
    const t = this.next();
    switch (t.kind) {
      case "name":
        if (t.value === "None") return { kind: "const", value: null };
        if (t.value === "True") return { kind: "const", value: true };
        if (t.value === "False") return { kind: "const", value: false };
        if (["lambda", "for", "if", "else", "and", "or", "not", "in", "is", "yield", "await", "def", "class"].includes(t.value)) {
          this.fail(`unexpected keyword ${t.value}`);
        }
        return { kind: "name", id: t.value };
      case "number":
        return { kind: "num", value: t.value, isFloat: t.isFloat };
      case "string": {
        let value = t.value;
        while (this.peek().kind === "string") value += (this.next() as { value: string }).value; // implicit concatenation
        return { kind: "str", value };
      }
      case "op":
        if (t.value === "(") {
          if (this.isOp(")")) {
            this.pos++;
            return { kind: "tuple", items: [] };
          }
          const first = this.test();
          if (this.isName("for")) {
            const comp: Expr = { kind: "comp", elt: first, value: null, clauses: this.compClauses(), gen: true };
            this.expectOp(")");
            return comp;
          }
          if (this.isOp(")")) {
            this.pos++;
            return first;
          }
          const items = [first];
          while (this.isOp(",")) {
            this.pos++;
            if (this.isOp(")")) break;
            items.push(this.test());
          }
          this.expectOp(")");
          return { kind: "tuple", items };
        }
        if (t.value === "[") {
          const items: Expr[] = [];
          while (!this.isOp("]")) {
            if (this.isOp("*")) this.fail("starred list item");
            const item = this.test();
            if (this.isName("for")) {
              const comp: Expr = { kind: "comp", elt: item, value: null, clauses: this.compClauses() };
              this.expectOp("]");
              return comp;
            }
            items.push(item);
            if (this.isOp(",")) this.pos++;
            else if (!this.isOp("]")) this.fail("expected ',' or ']' in list");
          }
          this.pos++;
          return { kind: "list", items };
        }
        if (t.value === "{") {
          const items: ({ key: Expr; value: Expr } | { unpack: Expr })[] = [];
          while (!this.isOp("}")) {
            if (this.isOp("**")) {
              this.pos++;
              items.push({ unpack: this.orTest() });
            } else {
              const key = this.test();
              if (!this.isOp(":")) this.fail("set literal");
              this.pos++;
              const value = this.test();
              if (this.isName("for")) {
                const comp: Expr = { kind: "comp", elt: key, value, clauses: this.compClauses() };
                this.expectOp("}");
                return comp;
              }
              items.push({ key, value });
            }
            if (this.isOp(",")) this.pos++;
            else if (!this.isOp("}")) this.fail("expected ',' or '}' in dict");
          }
          this.pos++;
          return { kind: "dict", items };
        }
        this.fail(`unexpected ${JSON.stringify(t.value)}`);
      // falls through to the end marker case only in theory
      case "end":
        this.fail("unexpected end of expression");
      default: {
        const never: never = t;
        return never;
      }
    }
  }
}

export function parseExpr(src: string): Expr {
  // `_compile_expr` wraps the expression in parentheses so multi-line attribute values parse (ir_qweb.py:1673)
  return new Parser(tokenize(src), src).parse();
}
