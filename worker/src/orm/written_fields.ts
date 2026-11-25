/**
 * The fields a request's writes flush, for a Store version's `written_fields_by_record` (mail/models/models.py:28-33
 * `_flush`: every dirty stored field of a model, in the model's field order, marked on the request's StoreVersion;
 * mail/tools/discuss.py:81-107 `get_formatted_version`). The port has no dirty cache: a route that answers with a
 * version of what it wrote opens a window on its cursor (`recordWritten`), and the port's writes mark their fields in
 * it: the ORM's column writes (orm/recompute.ts writeColumns) and the account writers that update rows directly
 * (models/account_entries.ts updateRow, touchSyncedInvoices). Any other UPDATE inside the window refuses, rather than
 * leaving its fields out of the version.
 */
import { NotPorted } from "../errors";
import type { Cursor } from "../db";
import type { Environment } from "./types";

interface Window {
  /** model -> field -> ids, in the order marked */
  readonly marks: Map<string, Map<string, number[]>>;
  /** tables marked, for the UPDATE guard */
  readonly tables: Set<string>;
  /** model -> field -> the markWritten call that marked it first (for `byFlush`) */
  readonly first: Map<string, Map<string, number>>;
  calls: number;
}

const WINDOWS = new WeakMap<Cursor, Window>();

export function isRecordingWritten(cr: Cursor): boolean {
  return WINDOWS.has(cr);
}

/** Marks `fields` of `ids` of `model` as written (nothing outside a window). */
export function markWritten(env: Environment, model: string, ids: readonly number[], fields: readonly string[]): void {
  const w = WINDOWS.get(env.cr);
  if (!w) return;
  const def = env.reg.model(model);
  w.tables.add(def.table);
  if (!ids.length || !fields.length) return;
  const byField = w.marks.get(model) ?? new Map<string, number[]>();
  w.marks.set(model, byField);
  const first = w.first.get(model) ?? new Map<string, number>();
  w.first.set(model, first);
  const call = ++w.calls;
  for (const f of fields) {
    if (!first.has(f)) first.set(f, call);
    const list = byField.get(f) ?? [];
    byField.set(f, list);
    for (const id of ids) if (!list.includes(id)) list.push(id);
  }
}

/** Marks written columns of rows of `table` (a direct UPDATE of the model's table). */
export function markWrittenTable(env: Environment, table: string, ids: readonly number[], fields: readonly string[]): void {
  if (!WINDOWS.has(env.cr)) return;
  const def = [...env.reg.models.values()].find((d) => d.table === table && !d.abstract);
  if (!def) throw new NotPorted(`written fields of table ${table} without its model`);
  markWritten(env, def.name, ids, fields);
}

const UPDATE = /^\s*(?:WITH\b[\s\S]*?\)\s*)?UPDATE\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i;

/**
 * Runs `fn` with a window on the cursor and gives its result with the written fields: by model (in the order first
 * marked), record id, the fields in the model's field order (models.py `_flush` iterates `self._fields`). With
 * `byFlush`, for a window over ORM calls that each flush first (an unlink: models.py:3687 `flush_all`), a field marked
 * by an earlier write comes before one marked later (discuss.py:75-78 `mark_field_as_written` appends per flush), the
 * fields of one write in the model's field order.
 */
export async function recordWritten<T>(env: Environment, fn: () => Promise<T>, byFlush = false): Promise<{ out: T; written: Record<string, Record<string, string[]>> }> {
  const cr = env.cr;
  if (WINDOWS.has(cr)) throw new NotPorted("nested written-fields windows");
  // Flush any writes buffered before this window so they don't trigger writeWatch inside it.
  if (typeof cr.flushPending === "function") cr.flushPending();
  const w: Window = { marks: new Map(), tables: new Set(), first: new Map(), calls: 0 };
  WINDOWS.set(cr, w);
  const prev = cr.writeWatch;
  cr.writeWatch = (sql: string) => {
    prev?.(sql);
    const m = UPDATE.exec(sql);
    if (m && !w.tables.has(m[1]!)) throw new NotPorted(`an UPDATE of ${m[1]} whose fields the Store version would leave out`);
  };
  let out: T;
  try {
    out = await fn();
  } finally {
    cr.writeWatch = prev;
    WINDOWS.delete(cr);
  }
  const written: Record<string, Record<string, string[]>> = {};
  for (const [model, byField] of w.marks) {
    const order = [...env.reg.model(model).fields.keys()];
    const first = w.first.get(model)!;
    const fields = [...byField.keys()].sort((a, b) => (byFlush ? first.get(a)! - first.get(b)! : 0) || order.indexOf(a) - order.indexOf(b));
    const byId: Record<string, string[]> = {};
    for (const f of fields) for (const id of byField.get(f)!) (byId[String(id)] ??= []).push(f);
    written[model] = byId;
  }
  return { out, written };
}
