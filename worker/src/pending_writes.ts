/**
 * Pending column writes buffered per transaction (odoo/odoo/orm/models.py:3997-4080 `_write_multi`, :5859-5905
 * `_flush`). Multiple `writeColumns` calls on the same table (recomputed fields, sequential writes) merge into one
 * row map per table and flush as a single `UPDATE ... FROM (VALUES ...)` per set of updated columns (or `WHERE id =
 * ANY(...)` when all rows in the group share the same values) right before any SQL statement that may read or write
 * them, or at drain/savepoint/commit.
 */

export type PendingValue =
  | { readonly kind: "val"; readonly sqlVal: unknown; readonly pgType: string }
  | { readonly kind: "now" };

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteIdent(name: string): string {
  if (!IDENT_RE.test(name)) throw new TypeError(`invalid SQL identifier ${name}`);
  return `"${name}"`;
}

/** Whether two PendingValues represent the exact same constant SQL assignment. */
function samePendingValue(a: PendingValue, b: PendingValue): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "now") return true;
  const bv = b as Extract<PendingValue, { kind: "val" }>;
  if (a.pgType !== bv.pgType) return false;
  const av = a.sqlVal;
  const bval = bv.sqlVal;
  if (av === null || typeof av === "boolean" || typeof av === "number" || typeof av === "string") {
    return Object.is(av, bval);
  }
  return false;
}

/**
 * Per-cursor buffer of pending column updates, keyed by table -> record id -> column -> PendingValue.
 * Also tracks the lowercased pending column names per table for fast flush checks on SELECT statements.
 */
export class PendingWrites {
  private readonly tables = new Map<string, Map<number, Map<string, PendingValue>>>();
  private readonly columns = new Map<string, Set<string>>();

  get size(): number {
    return this.tables.size;
  }

  has(table: string): boolean {
    return this.tables.has(table);
  }

  put(table: string, id: number, cols: ReadonlyMap<string, PendingValue>): void {
    if (!cols.size) return;
    let byId = this.tables.get(table);
    let colSet = this.columns.get(table);
    if (byId === undefined) {
      byId = new Map();
      colSet = new Set();
      this.tables.set(table, byId);
      this.columns.set(table, colSet);
    }
    let row = byId.get(id);
    if (row === undefined) {
      row = new Map();
      byId.set(id, row);
    }
    for (const [col, val] of cols) {
      row.set(col, val);
      colSet!.add(col.toLowerCase());
    }
  }

  /**
   * Pending tables that a pure SELECT with `deps` and `words` (from src/sql_cache.ts) may observe:
   * - `deps === null` (view, opaque function, unknown relation): every pending table.
   * - otherwise only pending tables in `deps` whose pending columns overlap `words` (or `words === null`).
   */
  tablesToFlushForRead(deps: ReadonlySet<string> | null, words: ReadonlySet<string> | null): string[] {
    if (this.tables.size === 0) return [];
    if (deps === null) return [...this.tables.keys()];
    const out: string[] = [];
    for (const [table, cols] of this.columns) {
      if (!deps.has(table)) continue;
      if (words === null) {
        out.push(table);
        continue;
      }
      for (const c of cols) {
        if (words.has(c)) {
          out.push(table);
          break;
        }
      }
    }
    return out;
  }

  takeTable(table: string): Map<number, Map<string, PendingValue>> | undefined {
    const rows = this.tables.get(table);
    if (rows === undefined) return undefined;
    this.tables.delete(table);
    this.columns.delete(table);
    return rows;
  }

  takeAll(): [string, Map<number, Map<string, PendingValue>>][] {
    if (this.tables.size === 0) return [];
    const out = [...this.tables.entries()];
    this.tables.clear();
    this.columns.clear();
    return out;
  }

  clear(): void {
    this.tables.clear();
    this.columns.clear();
  }
}

/** Max bind parameters per VALUES batch (well below Postgres' 65,535 limit). */
const MAX_VALUES_PARAMS = 4000;
/** Max rows per UPDATE batch (odoo/odoo/orm/models.py UPDATE_BATCH_SIZE = 1000). */
const UPDATE_BATCH_SIZE = 1000;

/**
 * Render one table's pending row updates into the minimal set of UPDATE statements (models.py:4013-4080
 * `_write_multi`):
 * - grouped by sorted column set;
 * - single-row or all-identical groups emit `UPDATE t SET ... WHERE id = $n` / `WHERE id = ANY($n::int[])`;
 * - multi-row groups with differing values keep identical columns in SET and put varying columns in
 *   `FROM (VALUES (...)) AS "__tmp"("id", ...) WHERE t."id" = "__tmp"."id"`.
 */
export function buildUpdates(
  table: string,
  rows: ReadonlyMap<number, ReadonlyMap<string, PendingValue>>,
): { text: string; params: unknown[] }[] {
  const qTable = quoteIdent(table);
  const byCols = new Map<string, { cols: string[]; entries: [number, ReadonlyMap<string, PendingValue>][] }>();
  for (const [id, colMap] of rows) {
    if (!colMap.size) continue;
    const cols = [...colMap.keys()].sort();
    const key = cols.join("\u0000");
    let group = byCols.get(key);
    if (group === undefined) {
      group = { cols, entries: [] };
      byCols.set(key, group);
    }
    group.entries.push([id, colMap]);
  }
  const statements: { text: string; params: unknown[] }[] = [];
  for (const { cols, entries } of byCols.values()) {
    if (entries.length === 1) {
      const [id, colMap] = entries[0]!;
      statements.push(buildSingleUpdate(qTable, cols, id, colMap));
      continue;
    }
    const constantCols: string[] = [];
    const varyingCols: string[] = [];
    const firstMap = entries[0]![1];
    for (const c of cols) {
      const v0 = firstMap.get(c)!;
      if (entries.every(([, m]) => samePendingValue(v0, m.get(c)!))) constantCols.push(c);
      else varyingCols.push(c);
    }
    if (varyingCols.length === 0) {
      const params: unknown[] = [];
      const sets = constantCols.map((c) => assignExpr(c, firstMap.get(c)!, params));
      params.push(entries.map(([id]) => id));
      statements.push({
        text: `UPDATE ${qTable} SET ${sets.join(", ")} WHERE id = ANY($${params.length}::int[])`,
        params,
      });
      continue;
    }
    const batchSize = Math.max(1, Math.min(UPDATE_BATCH_SIZE, Math.floor(MAX_VALUES_PARAMS / (1 + varyingCols.length))));
    for (let at = 0; at < entries.length; at += batchSize) {
      const batch = entries.slice(at, at + batchSize);
      if (batch.length === 1) {
        const [id, colMap] = batch[0]!;
        statements.push(buildSingleUpdate(qTable, cols, id, colMap));
        continue;
      }
      const params: unknown[] = [];
      const sets: string[] = [];
      for (const c of constantCols) sets.push(assignExpr(c, firstMap.get(c)!, params));
      for (const c of varyingCols) {
        const qc = quoteIdent(c);
        sets.push(`${qc} = "__tmp".${qc}`);
      }
      const tuples: string[] = [];
      for (const [id, colMap] of batch) {
        params.push(id);
        const cells = [`$${params.length}::int4`];
        for (const c of varyingCols) {
          const v = colMap.get(c)!;
          if (v.kind === "now") {
            cells.push(`(now() AT TIME ZONE 'UTC')`);
          } else {
            params.push(v.sqlVal);
            cells.push(`$${params.length}::${quoteIdent(v.pgType)}`);
          }
        }
        tuples.push(`(${cells.join(", ")})`);
      }
      const tmpCols = [`"id"`, ...varyingCols.map(quoteIdent)].join(", ");
      statements.push({
        text: `UPDATE ${qTable} SET ${sets.join(", ")} FROM (VALUES ${tuples.join(", ")}) AS "__tmp"(${tmpCols}) WHERE ${qTable}."id" = "__tmp"."id"`,
        params,
      });
    }
  }
  return statements;
}

function buildSingleUpdate(
  qTable: string,
  cols: readonly string[],
  id: number,
  colMap: ReadonlyMap<string, PendingValue>,
): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  const sets = cols.map((c) => assignExpr(c, colMap.get(c)!, params));
  params.push(id);
  return {
    text: `UPDATE ${qTable} SET ${sets.join(", ")} WHERE id = $${params.length}`,
    params,
  };
}

function assignExpr(col: string, val: PendingValue, params: unknown[]): string {
  const qc = quoteIdent(col);
  if (val.kind === "now") return `${qc} = (now() AT TIME ZONE 'UTC')`;
  params.push(val.sqlVal);
  return `${qc} = $${params.length}`;
}
