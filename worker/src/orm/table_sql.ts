/**
 * `_table_sql` of the models whose table is a query (`_auto = False` reports such as sale.report, purchase.report,
 * account.invoice.report; odoo/odoo/orm/models.py:531 and each report's `_table_sql` property): Odoo puts
 * `(<query>) AS "<table>"` in FROM. The queries are rendered by Odoo itself per template, language and company
 * (gen/table_sql.py -> gen/out[/<template>]/table_sql.json); `fields.Date.today()` was rendered as a sentinel date
 * and becomes the database's date here. A company whose render is missing, or a context without a company when the
 * renders differ per company, refuses.
 */
import type { Cursor } from "../db";
import { NotPorted } from "../errors";
import { allowedCompanyIds } from "./env";
import { raw, Sql, sql } from "./sql";
import { templateOf, type TemplateInfo } from "./template";
import { withOverlay } from "./overlay";
import { onRegistryChange } from "./signaling";
import type { Environment, ModelDef } from "./types";

interface Render { readonly code?: string; readonly params?: readonly unknown[]; readonly error?: string }
interface ModelRenders { readonly renders: Readonly<Record<string, Render>>; readonly today: string }
type TableSqlFile = Readonly<Record<string, ModelRenders>>;

const byDb = new Map<string, Promise<TableSqlFile>>();
const ready = new Map<string, TableSqlFile>();
onRegistryChange((db) => { byDb.delete(db); ready.delete(db); });

async function load(t: TemplateInfo): Promise<TableSqlFile> {
  if (t.dir === "poc_erp") return withOverlay(t, "table_sql.json", (await import("../../gen/out/poc_erp/table_sql.json", { with: { type: "json" } })).default as unknown as TableSqlFile, null);
  return {}; // poc_corpus has no query-backed model in scope
}

/** Load the renders of the cursor's database (once per database). */
export async function preloadTableSql(cr: Cursor): Promise<void> {
  if (ready.has(cr.db)) return;
  let p = byDb.get(cr.db);
  if (!p) {
    p = templateOf(cr).then((t) => load(t));
    byDb.set(cr.db, p);
  }
  ready.set(cr.db, await p);
}

/**
 * Table-less models (`_auto = False`, `_table_sql = SQL('(0)')`) whose records the port computes from their ids
 * (account.code.mapping): the ids they can have, so that read's existence check finds them. Odoo never selects from
 * their table (every field is computed, `_search` is overridden).
 */
const PORT_TABLES = new Map<string, Sql>();
export function registerPortTable(model: string, query: Sql): void {
  PORT_TABLES.set(model, query);
}

/** The FROM expression of `model` when its table is a query, else null (a plain table). */
export function tableQuery(env: Environment, model: ModelDef): Sql | null {
  const own = PORT_TABLES.get(model.name);
  if (own !== undefined) return own;
  const file = ready.get(env.cr.db);
  const entry = file?.[model.name];
  if (!entry) return null;
  const renders = Object.entries(entry.renders).filter(([, r]) => r.code && /^\(\s*SELECT\b/i.test(r.code));
  if (!renders.length) return null;
  const lang = env.lang ?? "en_US";
  // rendered per language, user (ir.default subqueries read the uid) and company
  const prefix = `${lang}/${env.uid}/`;
  const mine = renders.filter(([k]) => k.startsWith(prefix));
  const distinct = new Set(mine.map(([, r]) => r.code! + JSON.stringify(r.params ?? [])));
  let render: Render | undefined;
  if (mine.length && distinct.size === 1) render = mine[0]![1];
  else {
    const company = allowedCompanyIds(env.context, env.su)[0];
    if (company === undefined) throw new NotPorted(`table query of ${model.name} without a company in the context`);
    render = entry.renders[`${prefix}${company}`];
  }
  if (!render?.code) throw new NotPorted(`table query of ${model.name} for ${lang}, user ${env.uid}`);
  // psycopg2 placeholders: %s are parameters, %% is a literal %
  const parts = render.code.split(/(%s|%%)/);
  const params = [...(render.params ?? [])];
  const out: Sql[] = [];
  for (const part of parts) {
    if (part === "%s") {
      const v = params.shift();
      if (Array.isArray(v)) {
        // psycopg2 adapts a tuple to (a, b, ...)
        if (!v.length) throw new NotPorted(`empty tuple in the table query of ${model.name}`);
        out.push(raw("("), Sql.join(", ", v.map((x) => sql`${x}`)), raw(")"));
      } else out.push(v === entry.today ? raw("((now() AT TIME ZONE 'UTC')::date)") : sql`${v}`);
    } else if (part === "%%") out.push(raw("%"));
    else if (part) {
      if (part.includes("?")) throw new NotPorted(`'?' in the table query of ${model.name}`);
      out.push(raw(part));
    }
  }
  return Sql.join("", out);
}

/** The models of the cursor's template whose table is a query (for the registry: their stored fields are columns). */
export async function queryBackedModels(cr: Cursor): Promise<Set<string>> {
  await preloadTableSql(cr);
  const file = ready.get(cr.db) ?? {};
  return new Set(Object.entries(file).filter(([, e]) => Object.values(e.renders).some((r) => r.code && /^\(\s*SELECT\b/i.test(r.code))).map(([m]) => m));
}
