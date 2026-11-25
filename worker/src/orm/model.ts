/** Read-side BaseModel, odoo/orm/models.py:2798, 3014, 3460, 4852. */
import { flushListening, readRecords } from "./flush_points";
import { refuseOverriddenDisplayName } from "./display_override";
import { USERS_USER_WRITEABLE } from "./users_writeable";
import { AccessError, NotPorted } from "../errors";
import { attachmentValues } from "../models/binary";
import { translate } from "../models/util";
import { accessDomain, checkModelAccess, failingAccessCompanyRelated, type Operation } from "./access";
import * as D from "./domain";
import { checkLang, envTz, hasGroup, hasGroups, userInfo } from "./env";
import { hooksOf } from "./hooks";
import { inOrder } from "../in_order";
import { fetchQuery, hintIds, many2manyLinks, PREFETCH_MAX, prefetchable, prefetchableCompanyDependent, prefetchableTranslated, prefetchCompanyDependent, prefetchTranslated, prefetchValues, readFetchesColumns } from "./prefetch";
import { tableQuery } from "./table_sql";
import { WATCHED_TABLES } from "./signaling";
import { checkFieldAccess, companyDependentFallback, fallbackLangs, hasFieldAccess, ident, queryCount, queryIds, Query, runSql, searchQuery, Sql, sql } from "./sql";
import type { BinaryValue, Domain, Environment, FieldDef, Model, ModelDef, RecordValues, SearchOptions } from "./types";
import { binaryToRead, binaryToWebRead, floatToRead, fromPg, integerToRead, parseJsonFloats } from "./values";

/**
 * Models whose record rules search a field with the searched domain (`search_domain` in the context, src/orm/sql.ts
 * searchDomainOf): ir.attachment and mail.activity `_search_res_access`, mail.message's (src/models/
 * ir_attachment_access.ts, mail_activity_access.ts). A search of them is not merged with another one's domain.
 */
const SEARCH_DOMAIN_RULES = new Set(["ir.attachment", "mail.activity", "mail.message"]);

/**
 * Whether a search's answer for a context and user is fixed by the database (for RowCache.x2many): every search hook
 * reads only those, but ir.module.module's (src/modules/apps_visible.ts keeps what it computed in the request's
 * memory) and the SEARCH_DOMAIN_RULES models' (left out with their rules).
 */
function repeatableSearch(model: string): boolean {
  return model !== "ir.module.module" && !SEARCH_DOMAIN_RULES.has(model);
}

/** Whether a search of `model` is BaseModel._search alone: no hook of the port's own and no SEARCH_DOMAIN_RULES. */
function plainSearch(model: string): boolean {
  const h = hooksOf(model);
  return h.searchOverride === undefined && h.searchFetch === undefined && h.searchDomain === undefined && !SEARCH_DOMAIN_RULES.has(model);
}

/** The key of an x2many's values in RowCache.x2many: the field, the user, superuser or not and the context. */
function x2manyKey(env: Environment, model: string, field: string): string | null {
  let context: string;
  try {
    context = JSON.stringify(env.context);
  } catch (e) {
    // a context JSON cannot hold (a cycle, a BigInt) is read without the cache
    if (e instanceof TypeError) return null;
    throw e;
  }
  return `${model}.${field}\u0000${env.uid}\u0000${env.su ? 1 : 0}\u0000${context}`;
}

export class ModelImpl implements Model {
  constructor(readonly env: Environment, readonly def: ModelDef) {}

  async search(domain: Domain, opts: SearchOptions = {}): Promise<number[]> {
    await checkLang(this.env);
    const fetch = async (dom: Domain, o: SearchOptions): Promise<number[]> => {
      const next = async (d: Domain) => queryIds(await searchQuery(this.env, this.def, d, {
        ...o, limit: o.limit || null, order: o.order || this.def.order,
      }));
      const override = hooksOf(this.def.name).searchOverride;
      return override ? override(this.env, dom, next) : next(dom);
    };
    const searchFetch = hooksOf(this.def.name).searchFetch;
    const ids = await (searchFetch ? searchFetch(this.env, domain, opts, fetch) : fetch(domain, opts));
    // `search` returns `browse(ids)`, whose prefetch ids are the result (models.py:1376): reading one of them reads the
    // others' columns in the same statement (src/orm/prefetch.ts)
    hintIds(this.env, this.def, ids);
    return ids;
  }

  async searchCount(domain: Domain, limit?: number | null): Promise<number> {
    if (hooksOf(this.def.name).searchOverride) return (await this.search(domain, { limit: limit ?? null })).length;
    return queryCount(await searchQuery(this.env, this.def, domain, { limit: limit || null }));
  }

  accessDomain(operation: Operation): Promise<Domain> { return accessDomain(this.env, this.def, operation); }

  async binaryValue(id: number, name: string): Promise<BinaryValue | null> {
    const field = this.def.fields.get(name);
    if (!field || !["binary", "image"].includes(field.type)) throw new D.PyValueError(`Not a binary field: ${this.def.name}.${name}`);
    await checkFieldAccess(this.env, this.def, field, "read");
    await this.checkAccess([id], "read");
    return ((await this.values([id], field)).get(id) ?? null) as BinaryValue | null;
  }

  async checkAccess(ids: readonly number[], operation: Operation): Promise<void> {
    if (this.env.su) return;
    await checkModelAccess(this.env, this.def, operation);
    const domain = await this.accessDomain(operation);
    if (domain.kind === "true" || !ids.length) return;
    const query = await this.accessQuery(ids, domain);
    // Missing records are filtered by read(), not reported as forbidden. Both reads are sent together, in this order,
    // and share a round trip (C2d)
    const [allowedIds, existing] = await inOrder([queryIds(query), this.existingIds(ids)]);
    await this.refuseForbidden(new Set(allowedIds.map(Number)), existing, operation, domain);
  }

  /** The ids of `ids` that `domain` (an access domain) allows, as superuser and with archived records (models.py:3585-3591). */
  private accessQuery(ids: readonly number[], domain: Domain): Promise<Query> {
    return searchQuery(this.env, this.def, D.cond("id", "in", ids), { activeTest: false, secDomain: domain });
  }

  /** The ids of `ids` that exist (`exists()`), in the order the database answers. */
  private async existingIds(ids: readonly number[]): Promise<number[]> {
    const rows = await runSql<{ id: number }>(this.env, sql`SELECT id FROM ${tableQuery(this.env, this.def) ?? ident(this.def.table)} AS ${ident(this.def.table)} WHERE id = ANY(${ids}::int[])`);
    return rows.map((r) => Number(r.id));
  }

  /**
   * read()'s fetch (models.py:3121-3153): one statement selects the requested ids that exist and the access domain
   * allows, with the prefetch group's columns when a requested column is not in the row cache (src/orm/prefetch.ts
   * fetchQuery). Only when a record is missing from it does a second statement tell missing records (left out) from
   * forbidden ones (the error, as checkAccess). The access check and the error are checkAccess's; the ids are returned
   * in the order of `ids`, without duplicates.
   */
  private async fetchReadable(ids: readonly number[], names: readonly string[]): Promise<number[]> {
    // ids as numbers: a SQL view's bigint id comes from a search as a string (pg's int8), as the old read's rows did
    const unique = [...new Set(ids.map(Number))];
    let domain: Domain = D.TRUE;
    if (!this.env.su) {
      await checkModelAccess(this.env, this.def, "read");
      domain = await this.accessDomain("read");
    }
    const columns = readFetchesColumns(this.env, this.def, names, unique);
    let query: Query;
    if (domain.kind === "true") {
      // nothing to fetch and every record read in this transaction and not deleted since: the statement would answer
      // all of them (src/sql_cache.ts RowCache.allExist), as Odoo answers from its cache without a query
      if (!columns && tableQuery(this.env, this.def) === null && this.env.cr.rows.allExist(this.def.table, unique)) return unique;
      query = new Query(this.def, this.env);
      query.setResultIds(unique, false);
    } else {
      query = await this.accessQuery(ids, domain);
    }
    const found = new Set(await fetchQuery(this.env, this.def, query, names, columns));
    if (found.size < unique.length && domain.kind !== "true") {
      await this.refuseForbidden(found, await this.existingIds(ids), "read", domain);
    }
    return unique.filter((id) => found.has(id));
  }

  /** checkAccess's error (models.py:3594) when an existing record is not among the allowed ones. */
  private async refuseForbidden(allowed: ReadonlySet<number>, existing: readonly number[], operation: Operation, domain: Domain): Promise<void> {
    if (existing.every((id) => allowed.has(id))) return;
    const forbidden = existing.filter((id) => !allowed.has(id));
    const own = hooksOf(this.def.name).accessErrorMessage;
    const custom = own ? await own(this.env, forbidden, operation, domain) : null;
    if (custom) throw custom;
    if (this.env.lang && this.env.lang !== "en_US") throw new NotPorted(`translated record access error (${this.env.lang})`);
    throw await this.recordAccessError(forbidden, operation); // models.py:3594 forbidden
  }

  /** ir_access.py:411-494 `_make_record_access_error` (the non-debug message; the debug variant is not ported). */
  private async recordAccessError(ids: readonly number[], operation: Operation): Promise<AccessError> {
    const user = await userInfo(this.env);
    if (!user.share && await hasGroups(this.env, "base.group_no_one")) throw new NotPorted("record access error in debug mode (group_no_one)");
    let resolution = "If you really, really need access, perhaps you can win over your friendly administrator with a batch of freshly baked cookies.";
    let context: Record<string, unknown> | null = null;
    const sudo = this.env.sudo().withContext({ ...this.env.context, active_test: false });
    const filtered = async (domain: Domain) => (await queryIds(await searchQuery(this.env, this.def, D.cond("id", "in", ids), { activeTest: false, secDomain: domain }))).length;
    if (await failingAccessCompanyRelated(this.env, this.def, operation, filtered, ids.length)) {
      // models.py:5301 _get_redirect_suggested_company of records[:6]
      const first = ids.slice(0, 6);
      let companies: number[] = [];
      if (this.def.fields.has("company_id")) {
        companies = [...new Set((await new ModelImpl(sudo, this.def).read(first, ["company_id"], "")).map((r) => r["company_id"]).filter((c): c is number => typeof c === "number"))];
      } else if (this.def.fields.has("company_ids")) {
        throw new NotPorted("record access error suggested company from company_ids");
      }
      if (companies.length > 1) {
        resolution += "\n\nNote: this might be a multi-company issue. Switching company may help - in Odoo, not in real life!";
      } else if (companies.length === 1 && user.companyIds.includes(companies[0]!)) {
        const name = (await sudo.model("res.company").displayName(companies)).get(companies[0]!);
        context = { suggested_company: { id: companies[0], display_name: name } };
        resolution += `\n\nThis seems to be a multi-company issue, you might be able to access the record by switching to the company: ${name}.`;
      } else if (companies.length === 1) {
        resolution += "\n\nThis seems to be a multi-company issue, but you do not have access to the proper company to access the record anyhow.";
      }
    }
    const message = `Uh-oh! Looks like you have stumbled upon some top-secret records.\n\nSorry, ${user.name} (id=${user.id}) doesn't have '${operation === "unlink" ? "delete" : operation}' access to:\n- ${this.def.description} (${this.def.name})\n\n${resolution}`;
    return new AccessError(message, context ? { context } : {});
  }

  async read(ids: readonly number[], fields: readonly string[], load = "_classic_read"): Promise<RecordValues[]> {
    await checkLang(this.env);
    const names = fields.length ? fields : Object.keys(await this.fieldsGet(null, []));
    for (const name of names) {
      const f = this.def.fields.get(name);
      // models.py:3200-3203 `_determine_fields_to_fetch` (read -> fetch, search_read -> search_fetch)
      if (!f) throw new D.PyValueError(`Invalid field ${D.pyRepr(name)} on ${D.pyRepr(this.def.name)}`);
      await checkFieldAccess(this.env, this.def, f, "read");
    }
    if (!ids.length) {
      await this.checkAccess(ids, "read");
      return [];
    }
    const existing = await this.fetchReadable(ids, names);
    const rows: RecordValues[] = existing.map((id) => ({ id }));
    for (const name of names) {
      if (name === "id") continue;
      const f = this.def.fields.get(name)!;
      const values = await this.values(existing, f);
      let labels: Map<number, string> | null = null;
      const genericName = f.type === "many2one" && !!f.relation && emptyNameIsFalse(f.relation);
      let preciseJson: Map<number, unknown> | null = null;
      if (f.type === "json" && f.name === "analytic_distribution" && f.column && !f.inheritedFrom) {
        const raw = (await this.env.cr.query<{ id: number; t: string | null }>(
          `SELECT id, "${f.name}"::text AS t FROM "${this.def.table}" WHERE id = ANY($1::int[])`, [existing])).rows;
        preciseJson = new Map(raw.filter((r) => r.t !== null).map((r) => [r.id, parseJsonFloats(r.t!)]));
      }
      if (f.type === "many2one" && load === "_classic_read" && f.relation) {
        const coids = [...new Set([...values.values()].filter((v): v is number => typeof v === "number" && v > 0))];
        labels = await this.env.sudo().model(f.relation).displayName(coids);
      }
      for (const row of rows) {
        const v = values.get(Number(row["id"])) ?? null;
        switch (f.type) {
          // Many2one.convert_to_read `(id, display_name)`: a generic display name of an empty `_rec_name` is False
          case "many2one": row[name] = v ? (labels ? [v, (genericName ? labels.get(Number(v)) || false : labels.get(Number(v)) ?? false)] : v) : false; break;
          case "one2many": case "many2many": row[name] = v ?? []; break;
          case "float": case "monetary": row[name] = floatToRead(v as number | null); break;
          // Many2oneReference is an Integer: convert_to_record `value or 0` (fields_numeric.py:41-42), an empty res_id reads 0
          case "integer": case "many2one_reference": row[name] = integerToRead(v as number | null); break;
          case "binary": case "image": row[name] = load === "web" ? binaryToWebRead(v as BinaryValue | null, name) : await binaryToRead(v as BinaryValue | null, name); break;
          case "properties":
            if (v !== null && (!Array.isArray(v) || v.length)) throw new NotPorted(`${this.def.name}.${name}: properties convert_to_read_multi`);
            row[name] = []; break;
          case "properties_definition":
            if(v && (!Array.isArray(v)||v.length)) throw new NotPorted('nonempty properties definition cleanup');
            row[name] = []; break;
          case "json":
            // json.loads of the column: a share written by analytic.mixin's `_sanitize_values` is a float ("100.0"),
            // one stored by a compute may be an int ("100"); pg hands both as 100, so the column's text decides
            row[name] = name === "analytic_distribution" && v ? (preciseJson?.get(Number(row["id"])) ?? v) : v ?? false;
            break;
          default: row[name] = v ?? false;
        }
      }
    }
    return rows;
  }

  /** Fetch in cache format; related fields traverse without converting binary/relational values. */
  async values(ids: readonly number[], field: FieldDef): Promise<Map<number, unknown>> {
    if (!ids.length) return new Map();
    // values written to non-stored fields in this request (src/orm/recompute.ts setOverlay, fields.py write)
    const overlay = this.env.cache.get(`wr.overlay:${this.def.name}.${field.name}`) as Map<number, unknown> | undefined;
    if (overlay && overlay.size && ids.some((id) => overlay.has(id))) {
      const rest = ids.filter((id) => !overlay.has(id));
      const out = rest.length ? await this.values(rest, field) : new Map<number, unknown>();
      for (const id of ids) if (overlay.has(id)) out.set(id, overlay.get(id));
      return out;
    }
    if (field.name === "display_name") {
      // models.py:1512 + fields.py:1220 convert_to_display_name: `str(value) if value else False` for a plain _rec_name
      const rf = this.def.recName ? this.def.fields.get(this.def.recName) : undefined;
      const hooks = hooksOf(this.def.name);
      if ((!hooks.displayName || hooks.displayNameFalse) && rf && ["char", "text", "selection", "many2one", "date", "datetime"].includes(rf.type)) {
        const names = await this.displayName(ids);
        return new Map(ids.filter((id) => names.has(id)).map((id) => [id, names.get(id) || false]));
      }
      return this.displayName(ids);
    }
    const hook = hooksOf(this.def.name).computed?.[field.name];
    if (hook && !field.store) return hook(field.computeSudo ? this.env.sudo() : this.env, ids);
    if (field.inheritedFrom && field.inheritedVia) {
      return this.relatedValues(ids, `${field.inheritedVia}.${field.name}`);
    }
    if (field.related && !field.store) return (field.computeSudo ? new ModelImpl(this.env.sudo(),this.def) : this).relatedValues(ids, field.related);
    if (field.attachment && field.store) return attachmentValues(this.env, this.def.name, field.name, ids);
    const fetched = async (m: Map<number, unknown>): Promise<Map<number, unknown>> => {
      const filter = hooksOf(this.def.name).fetchFilter;
      return filter && !this.env.su ? filter(this.env, field, m) : m;
    };
    if (field.type === "one2many" || field.type === "many2many") return fetched(await this.relationValues(ids, field));
    if (!field.store || !field.column) throw new NotPorted(`computed field ${this.def.name}.${field.name}`);
    return readRecords(this.env.cr, this.def.name, field.name, ids, async () => {
      const q = new Query(this.def, this.env);
      q.setResultIds(ids, false);
      const expr = await q.table.field(field.name);
      // models.py:3077 _fetch_field: the field's prefetch group for these and the model's other read records (src/orm/prefetch.ts)
      if (prefetchable(this.env, this.def, field, expr)) return fetched(await prefetchValues(this.env, this.def, field, ids));
      // a translated column: the language picked from the stored values (src/orm/prefetch.ts prefetchTranslated)
      if (prefetchableTranslated(this.env, this.def, field)) {
        const translated = await prefetchTranslated(this.env, this.def, field, ids, fallbackLangs(this.env.lang ?? "en_US"));
        if (translated !== null) return fetched(translated);
      }
      // a company-dependent number or boolean: the company's value or the fallback, from the stored values
      if (prefetchableCompanyDependent(this.env, this.def, field)) {
        const fallback = await companyDependentFallback(this.env, this.def, field);
        const values = await prefetchCompanyDependent(this.env, this.def, field, ids, await this.env.company(), fallback);
        if (values !== null) return fetched(values);
      }
      const data = await runSql<{ id: number; value: unknown }>(this.env, q.select(q.table.id, sql`${expr} AS value`));
      return fetched(new Map(data.map(r => [r.id, fromPg(field.type, r.value)])));
    });
  }

  private async relatedValues(ids: readonly number[], path: string): Promise<Map<number, unknown>> {
    const [first, ...rest] = path.split(".");
    const f = this.def.fields.get(first!);
    if (!f) throw new NotPorted(`related field ${this.def.name}.${path}`);
    const values = await this.values(ids, f);
    if (!rest.length) return values;
    if (!['many2one','one2many','many2many'].includes(f.type) || !f.relation) throw new NotPorted(`related traversal ${this.def.name}.${path}`);
    // fields.py:759 traverses value[name][:1], including an x2many link.
    const firstId=(value:unknown):number=>Number(Array.isArray(value)?value[0]:value)||0;
    const coids = [...new Set([...values.values()].map(firstId).filter(id=>id>0))];
    const comodel = new ModelImpl(this.env, this.env.reg.model(f.relation));
    const co = await comodel.relatedValues(coids, rest.join("."));
    return new Map(ids.map(id => [id, co.get(firstId(values.get(id))) ?? null]));
  }

  /**
   * An x2many's values for `ids`. Odoo fetches an x2many for every record of the prefetch set that lacks it
   * (models.py:3077 `_fetch_field` on `_prefetch_ids`, fields_relational.py `_fetch`), so a compute that reads a
   * relation record by record makes one query: here the other records of the model read in this transaction
   * (src/orm/prefetch.ts) are fetched along, up to PREFETCH_MAX, and their values kept until the next write
   * (src/sql_cache.ts RowCache.x2many). Not kept while a deferred flush listens (its bookkeeping follows each query),
   * nor for models whose table is a query or whose search depends on more than the database (repeatableSearch).
   */
  private async relationValues(ids: readonly number[], field: FieldDef): Promise<Map<number, unknown>> {
    if (!field.relation) throw new NotPorted(`relation ${this.def.name}.${field.name}`);
    const comodel = this.env.reg.models.get(field.relation);
    const cacheable = comodel !== undefined && !flushListening(this.env.cr) && repeatableSearch(comodel.name) && repeatableSearch(this.def.name)
      && tableQuery(this.env, comodel) === null && tableQuery(this.env, this.def) === null;
    const key = cacheable ? x2manyKey(this.env, this.def.name, field.name) : null;
    if (key === null) return this.fetchRelation(ids, field);
    const rows = this.env.cr.rows;
    const parents = new Set<number>();
    for (const id of ids) if (rows.x2many(key, id) === undefined) parents.add(id);
    let fetched = new Map<number, unknown>();
    if (parents.size) {
      for (const id of rows.seen(this.def.table)) {
        if (parents.size >= PREFETCH_MAX) break;
        if (id > 0 && rows.x2many(key, id) === undefined) parents.add(id);
      }
      const before = rows.writeCount();
      if (typeof this.env.cr.trackReads === "function") {
        const tracked = await this.env.cr.trackReads(() => this.fetchRelation([...parents], field));
        fetched = tracked.value;
        if (rows.writeCount() === before) {
          for (const [id, v] of fetched) rows.putX2many(key, id, [...(v as number[])], tracked.deps, tracked.words);
        }
      } else {
        fetched = await this.fetchRelation([...parents], field);
        if (rows.writeCount() === before) {
          for (const [id, v] of fetched) rows.putX2many(key, id, [...(v as number[])]);
        }
      }
    }
    const out = new Map<number, unknown>();
    for (const id of ids) {
      const kept = parents.has(id) ? fetched.get(id) as number[] | undefined : rows.x2many(key, id);
      out.set(id, [...(kept ?? [])]);
    }
    return out;
  }

  /** The x2many's values for `ids` (fields_relational.py One2many.read/Many2many.read and convert_to_record). */
  private async fetchRelation(ids: readonly number[], field: FieldDef): Promise<Map<number, unknown>> {
    if (!field.relation) throw new NotPorted(`relation ${this.def.name}.${field.name}`);
    const coEnv = this.env.withContext({ ...this.env.context, active_test: false, ...field.context });
    const co = new ModelImpl(coEnv, coEnv.reg.model(field.relation));
    const domain = Array.isArray(field.domain) ? D.parseDomain(field.domain) : D.TRUE;
    // fields_relational.py:91-101 get_comodel_domain: a string domain is client-side only (Domain.TRUE here); a
    // callable one is evaluated in Python
    if (field.domain && !Array.isArray(field.domain) && (typeof field.domain !== "string" || field.domainCallable)) {
      throw new NotPorted(`relation domain ${this.def.name}.${field.name}`);
    }
    const result = new Map<number, number[]>(ids.map(id => [id, []]));
    // The access filter below (convert_to_record's `_filtered_access`) in the fetch's own statement when it can be:
    // `filtered` says the co-records found already went through it. A rule domain of TRUE lets every existing co-record
    // through, so the filter's search is not sent; another one is the WHERE of the fetch, searched as the user (the
    // same rows as the superuser's fetch filtered by the user's search of them, models.py:4904-4914). A FALSE one
    // reads as no records. Kept as before for comodels whose search is the port's own code (hooks) or whose rules
    // search with the searched domain (SEARCH_DOMAIN_RULES).
    let filtered = false;
    let fetcher: ModelImpl = new ModelImpl(coEnv.sudo(), co.def);
    if (!this.env.su && !field.bypassSearchAccess && plainSearch(co.def.name)) {
      const rule = await accessDomain(coEnv, co.def, "read");
      if (rule.kind === "false") return result;
      filtered = true;
      if (rule.kind !== "true") fetcher = co;
    }
    if (field.type === "one2many") {
      if (!field.relationField) throw new NotPorted(`inverse ${this.def.name}.${field.name}`);
      const inverse = co.def.fields.get(field.relationField)!;
      const extra = inverse.type === "many2one_reference" && inverse.modelField ? D.cond(inverse.modelField, "=", this.def.name) : D.TRUE;
      const sudo = new ModelImpl(coEnv.sudo(), co.def);
      const coids = await fetcher.search(D.and([domain, extra, D.cond(field.relationField, "in", ids)]));
      const values = await sudo.values(coids, inverse);
      for (const id of coids) result.get(Number(values.get(id)))?.push(id);
    } else {
      if (!field.relationTable || !field.column1 || !field.column2) throw new NotPorted(`m2m table ${this.def.name}.${field.name}`);
      // the links already known (read in this transaction) or kept by the isolate (a registry table's, shared across
      // requests): they cost no statement, and no links no search
      const rel = field.relationTable;
      const linksKnown = WATCHED_TABLES.has(rel) || ids.every((id) => this.env.cr.rows.link(rel, `${field.column1}\u0000${field.column2}`, id) !== undefined);
      if (!linksKnown && fetcher.env.su && plainSearch(co.def.name) && tableQuery(coEnv, co.def) === null) {
        // fields_relational.py:1428-1442 Many2many.read: the comodel's search joined with the relation table, the
        // pairs (record, line) in the comodel's order, one statement. Only without a record rule in the fetch (as
        // Odoo's `bypass_access=True`): a rule's search methods would otherwise run over the whole comodel, where the
        // links first narrow them to the linked records
        await checkLang(fetcher.env);
        const query = await searchQuery(fetcher.env, co.def, domain, { limit: null, order: co.def.order });
        if (!query.isEmpty()) {
          query.addJoin("JOIN", rel, ident(rel), sql`${ident(rel, field.column2)} = ${query.table.id}`);
          query.addWhere(sql`${ident(rel, field.column1)} IN (${Sql.join(", ", [...new Set(ids)].map((id) => sql`${id}`))})`);
          const rows = await runSql<{ parent: number; child: number }>(this.env, query.select(sql`${ident(rel, field.column1)} AS "parent"`, sql`${ident(rel, field.column2)} AS "child"`));
          for (const r of rows) result.get(Number(r.parent))?.push(Number(r.child));
          // the search's `browse(ids)` (ModelImpl.search): its records are prefetch ids of the comodel
          hintIds(this.env, co.def, rows.map((r) => Number(r.child)));
        }
      } else {
        const links = await many2manyLinks(this.env, field, ids);
        // fields_relational.py:1428-1436 Many2many.read: `comodel.sudo()._search(domain, bypass_access=True)`; access
        // filtering is convert_to_record's (below)
        const coids = await fetcher.search(D.and([domain, D.cond("id", "in", links.map(r => r.child))]));
        const parents = new Map<number, number[]>();
        for (const link of links) parents.set(link.child, [...(parents.get(link.child) ?? []), link.parent]);
        for (const id of coids) for (const parent of parents.get(id) ?? []) result.get(parent)?.push(id);
      }
    }
    // fields_relational.py:convert_to_record filters cached relations by access
    // and active_test. The cache fetch above deliberately includes archived rows.
    const all=[...new Set([...result.values()].flat())];
    // fields_relational.py `prefetch_x2many_ids`: the co-records are prefetch ids of the comodel (src/orm/prefetch.ts)
    hintIds(this.env, co.def, all);
    let allowed=new Set(all);
    // models.py:3506-3529 `_filtered_access('read')`: no permission on the comodel reads as no records, never an error
    if(!this.env.su && !field.bypassSearchAccess && !filtered && all.length) {
      allowed = (await accessDomain(coEnv, co.def, "read")).kind === "false" ? new Set() : new Set(await co.search(D.cond('id','in',all)));
    }
    const active=co.def.activeName;
    if(active && (field.context['active_test'] ?? this.env.context['active_test'] ?? true)) {
      const values=await new ModelImpl(coEnv.sudo(),co.def).values(all,co.def.fields.get(active)!);
      allowed=new Set([...allowed].filter(id=>values.get(id)));
    }
    for(const [id,values] of result) result.set(id,values.filter(v=>allowed.has(v)));
    return result;
  }

  async displayName(ids: readonly number[]): Promise<Map<number, string>> {
    const hook = hooksOf(this.def.name).displayName;
    if (hook) return hook(this.env, ids);
    if (ids.length) refuseOverriddenDisplayName(this.def.name, this.env.cr);
    return this.baseDisplayName(ids);
  }

  /** models.py:1503-1517 BaseModel._compute_display_name, the `super()` of an override (src/models/display_names.ts). */
  async baseDisplayName(ids: readonly number[]): Promise<Map<number, string>> {
    // models.py _compute_display_name: _rec_name, or model,id when no naming field exists.
    if (!this.def.recName) return new Map(ids.map(id => [id, `${this.def.name},${id}`]));
    const field = this.def.fields.get(this.def.recName)!;
    const values = await this.values(ids, field);
    if (field.type === "many2one" && field.relation) {
      // fields_relational.py Many2one.convert_to_display_name: the comodel record's display_name, else False
      const coids = [...new Set([...values.values()].filter((v): v is number => typeof v === "number" && v > 0))];
      const names = coids.length ? await new ModelImpl(this.env, this.env.reg.model(field.relation)).displayName(coids) : new Map<number, string>();
      return new Map(ids.map(id => { const v = values.get(id); return [id, typeof v === "number" ? names.get(v) ?? "" : ""]; }));
    }
    if (field.type === "datetime") {
      // fields_temporal.py Datetime.convert_to_display_name: to_string(context_timestamp(value)) in env.tz
      const tz = await envTz(this.env);
      const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
      return new Map(ids.map(id => {
        const v = values.get(id);
        if (typeof v !== "string" || !v) return [id, ""];
        const p = Object.fromEntries(fmt.formatToParts(new Date(`${v.replace(" ", "T")}Z`)).map(x => [x.type, x.value]));
        return [id, `${p["year"]}-${p["month"]}-${p["day"]} ${p["hour"]}:${p["minute"]}:${p["second"]}`];
      }));
    }
    return new Map(ids.map(id => [id, String(values.get(id) ?? "")]));
  }

  async nameSearch(name: string, domain: Domain, operator: string, limit: number | null): Promise<[number, string | false][]> {
    const hook = hooksOf(this.def.name).nameSearch;
    if (hook) return hook(this.env, name, domain, operator, limit);
    return this.baseNameSearch(name, domain, operator, limit);
  }

  /** models.py:1598-1622 BaseModel.name_search, the `super()` of an override. */
  async baseNameSearch(name: string, domain: Domain, operator: string, limit: number | null): Promise<[number, string | false][]> {
    const ids = await this.search(D.and([D.cond("display_name", operator, name), domain]), { limit });
    // models.py:1622 `[(record.id, record.display_name) for record in records.sudo()]`: False for an empty _rec_name
    const names = await new ModelImpl(this.env.sudo(), this.def).values(ids, this.def.fields.get("display_name")!);
    return ids.map(id => [id, (names.get(id) as string | false | undefined) ?? ""]);
  }

  async fieldsGet(allfields?: readonly string[] | null, attributes?: readonly string[] | null): Promise<Record<string, RecordValues>> {
    const result: Record<string, RecordValues> = {};
    const lang = await checkLang(this.env) ?? "en_US";
    // models.py fields_get: `readonly or not has_field_access(field, 'write')`; res.users `_has_field_access`
    // (base res_users.py:651-661) allows writes only to user_writeable fields unless superuser or erp manager
    const usersManager = this.def.name === "res.users" && !this.env.su ? await hasGroup(this.env, "base.group_erp_manager") : true;
    for (const field of this.def.fields.values()) {
      if (allfields?.length && !allfields.includes(field.name) || !(await hasFieldAccess(this.env, field))) continue;
      const attrs: RecordValues = {
        name: field.name, type: field.type, string: field.strings[lang] ?? field.string, store: field.store, required: field.required,
        readonly: field.readonly || !(await hasFieldAccess(this.env, field)) || (!usersManager && !USERS_USER_WRITEABLE.has(field.name)),
        company_dependent: field.companyDependent, change_default: field.changeDefault,
        // fields.py:1033-1045 _description_sortable: a field whose _order_field_to_sql works is sortable; the generator
        // ran without a request, so request-dependent orderings (res.session.is_current) come from a computeSql hook
        searchable: field.searchable, sortable: field.sortable || hooksOf(this.def.name).computeSql?.[field.name] !== undefined,
        groupable: field.groupable && (field.type !== "many2many" || !field.relation || await canReadModel(this.env, field.relation)), exportable: field.exportable,
        default_export_compatible: field.defaultExportCompatible, manual: field.manual, depends: field.depends,
        group_expand: field.groupExpand,
      };
      if (field.related) attrs["related"] = field.related;
      if (field.groups?.length) attrs["groups"] = field.groups.join(",");
      if (field.relation) {
        attrs["context"] = field.context;
        attrs["allow_hierachy_operators"] = this.env.reg.model(field.relation).fields.has(this.env.reg.model(field.relation).parentName);
        if (field.domainCallable && (!attributes || attributes.includes("domain"))) {
          const hook = hooksOf(this.def.name).descriptionDomain?.[field.name];
          if (!hook) throw new NotPorted(`domain ${this.def.name}.${field.name}`);
          attrs["domain"] = await hook(this.env);
        } else attrs["domain"] = field.descriptionDomain ?? field.domain ?? [];
      }
      if (field.type === "char") attrs["trim"] = field.trim;
      if (field.type === "binary" || field.type === "image") attrs["attachment"] = field.attachment;
      if (field.sanitize) Object.assign(attrs, field.sanitize);
      if (field.definitionRecord) attrs["definition_record"] = field.definitionRecord;
      if (field.definitionRecordField) attrs["definition_record_field"] = field.definitionRecordField;
      if (field.modelField) attrs["model_field"] = field.modelField;
      if (field.falsyValueLabel) {
        // fields.py:1106-1107 `env._(self.falsy_value_label)`: the labels are `_lt(...)` of the field's module, so the
        // module is the one whose code has that `_lt` (gen/code_sources.py); a label found in none refuses
        attrs["falsy_value_label"] = lang === "en_US" || (attributes && !attributes.includes("falsy_value_label"))
          ? field.falsyValueLabel : translate(this.env, field.falsyValueLabel);
      }
      if (field.minDisplayDigits != null) attrs["min_display_digits"] = field.minDisplayDigits;
      if (field.help) attrs["help"] = field.helps[lang] ?? field.help;
      if (field.relation) attrs["relation"] = field.relation;
      if (field.relationField) attrs["relation_field"] = field.relationField;
      if (field.descriptionAggregator != null) attrs["aggregator"] = field.descriptionAggregator;
      else if (field.aggregator) attrs["aggregator"] = field.aggregator;
      if (field.size !== null) attrs["size"] = field.size;
      if (field.digits !== null) attrs["digits"] = field.digits;
      // fields_numeric.py:153 `_description_digits`: `digits=0` is described as 0 (only None is left out)
      // ... and `digits=False` (account.move.line price_unit, account/models/account_move_line.py) as False
      else if ((field.digitsRaw === 0 || field.digitsRaw === false) && (field.type === "float" || field.type === "monetary")) attrs["digits"] = field.digitsRaw;
      // fields_numeric.py:227-233 `get_currency_field`: currency_field, else currency_id / x_currency_id of the model
      // (ir_model_fields.currency_field is only filled for stored fields)
      if (field.type === "monetary") {
        const cf = field.currencyField ?? (this.def.fields.has("currency_id") ? "currency_id" : this.def.fields.has("x_currency_id") ? "x_currency_id" : null);
        if (cf) attrs["currency_field"] = cf;
      } else if (field.currencyField) attrs["currency_field"] = field.currencyField;
      if (field.type === "char" || field.type === "text" || field.type === "html") attrs["translate"] = field.translate;
      if (field.type === "selection" || field.type === "reference") { // fields_reference.py:20 Reference(Selection)
        const hook = hooksOf(this.def.name).selection?.[field.name];
        if (field.selection) attrs["selection"] = field.selection.map(s => [s.value, s.labels[lang] ?? s.label]);
        else if (hook) attrs["selection"] = await hook(this.env);
        else if (!attributes || attributes.includes("selection")) {
          const related = field.related ? await relatedSelection(this.env, this.def, field) : null;
          if (!related) throw new NotPorted(`selection ${this.def.name}.${field.name}`);
          attrs["selection"] = related;
        }
      }
      result[field.name] = attributes ? Object.fromEntries(Object.entries(attrs).filter(([key]) => attributes.includes(key))) : attrs;
      // mail_track_mixin.py:44 adds both attributes when tracking is requested.
      if (this.def.isMailThread && (!attributes || attributes.includes("tracking"))) {
        result[field.name]!["tracking"] = field.descriptionTracking ?? false;
        result[field.name]!["tracking_sequence"] = field.trackingSequence ?? 100;
      }
    }
    // base/models/res_partner.py:142 FormatVatLabelMixin.fields_get.
    if (this.def.formatVatLabel && attributes?.includes("string") && result["vat"]) {
      const company = await this.env.company();
      const row = (await this.env.cr.query<{vat_label:string|null}>(
        `SELECT COALESCE(c.vat_label->>$2,c.vat_label->>'en_US') AS vat_label
         FROM res_company co JOIN res_partner p ON p.id=co.partner_id
         LEFT JOIN res_country c ON c.id=p.country_id WHERE co.id=$1`, [company, lang])).rows[0];
      if (!row?.vat_label && lang !== "en_US") throw new NotPorted("translated Tax ID label");
      result["vat"]["string"] = row?.vat_label || "Tax ID";
    }
    return result;
  }
}

/**
 * fields.py:1050 `_description_groupable` of a many2many: `_read_group_groupby` joins `comodel._search(codomain)`
 * (fields_relational.py:1706), which raises AccessError without read access on the comodel -> not groupable.
 */
async function canReadModel(env: Environment, model: string): Promise<boolean> {
  if (env.su) return true;
  const def = env.reg.models.get(model);
  if (!def) return false;
  const domain = await accessDomain(env, def, "read");
  return domain.kind !== "false";
}

/**
 * Whether an empty display name of `model` is Python's False: BaseModel._compute_display_name (models.py:1503-1517,
 * fields.py:1220 `str(value) if value else False`), also through the overrides that fall back on `super()` for it
 * (`displayNameFalse`, src/models/display_names.ts). Round 9: a many2one to such a record read `[id, ""]` where Odoo
 * reads `[id, false]` (purchase.order.line of a bill line).
 */
export function emptyNameIsFalse(model: string): boolean {
  const hooks = hooksOf(model);
  return !hooks.displayName || hooks.displayNameFalse === true;
}

/** `record.sudo().display_name` of `ids` as the web methods return it: False for an empty generic name. */
export async function displayNamesOrFalse(env: Environment, model: string, ids: readonly number[]): Promise<Map<number, string | false>> {
  const names = await env.sudo().model(model).displayName(ids);
  if (!emptyNameIsFalse(model)) return names;
  return new Map([...names].map(([id, n]) => [id, n || false]));
}

/**
 * fields_selection.py:79-84 `setup_related`: a related Selection field's selection is its target field's
 * `_description_selection`: the target's static list in the request's language, or its hook, followed through a target
 * that is itself related. Null when the path does not resolve through the registry.
 */
async function relatedSelection(env: Environment, def: ModelDef, field: FieldDef, depth = 0): Promise<[string, string][] | null> {
  if (!field.related || depth > 8) return null;
  const path = field.related.split(".");
  let m = def;
  for (const step of path.slice(0, -1)) {
    const f = m.fields.get(step);
    if (!f?.relation || (f.type !== "many2one" && f.type !== "one2many" && f.type !== "many2many")) return null;
    const next = env.reg.models.get(f.relation);
    if (!next) return null;
    m = next;
  }
  const target = m.fields.get(path[path.length - 1]!);
  if (!target || (target.type !== "selection" && target.type !== "reference")) return null;
  const lang = env.lang ?? "en_US";
  if (target.selection) return target.selection.map((s) => [s.value, s.labels[lang] ?? s.label]);
  const hook = hooksOf(m.name).selection?.[target.name];
  if (hook) return (await hook(env)).map(([v, l]) => [v, l] as [string, string]);
  return relatedSelection(env, m, target, depth + 1);
}
