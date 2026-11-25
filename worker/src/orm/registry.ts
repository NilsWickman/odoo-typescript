/**
 * The registry of one database: ModelDef/FieldDef built from ir_model, ir_model_fields, ir_model_fields_selection,
 * ir_model_inherit and ir_model_fields_group_rel (PORTING_odoo.md section 2), merged with the Python-only metadata
 * stream G generates into gen/out/models.json (`_rec_name`, `_rec_names_search`, `_parent_store`, NO_ACCESS fields,
 * computed fields and their depends, ...). Until that file exists, `GEN_FALLBACK` below applies Odoo's defaults
 * (model_classes.py:466-485) and the few overrides named in PORTING_odoo.md; every fallback is marked so the merge
 * point stays explicit.
 *
 * Loading is lazy (first request for a database) and cached per database in a bounded map (at most 8, oldest out).
 */
import { currentSequences, onRegistryChange } from "./signaling";
import type { Cursor } from "../db";
import type { FieldDef, FieldType, ModelDef, Registry } from "./types";
import { templateKey, templateOf, type TemplateInfo } from "./template";
import { queryBackedModels } from "./table_sql";
import { loadCodeTranslations } from "./code_translations";
import { sharedRegistryRows, type GroupRow, type InheritRow, type ModelRow, type RegistryRows, type SelectionRow } from "./registry_share";

// --------------------------------------------------------------------------------------------------------------
// Generated metadata (stream G): the merge point
// --------------------------------------------------------------------------------------------------------------

export interface GenField {
  readonly tracking?: boolean;
  readonly tracking_sequence?: number | null;
  readonly selection?: readonly (readonly [string, string])[] | null;
  readonly selection_dynamic?: boolean;
  readonly description_domain?: unknown;
  readonly domain_callable?: boolean;
  /** fields.py:1109 `_description_group_expand` (ir_model_fields.group_expand is not filled for Python fields). */
  readonly group_expand?: boolean;
  /** `_description_domain` of a callable domain that does not read the environment (gen/models.py). */
  readonly description_domain_static?: unknown;
  readonly min_display_digits?: number | null;
  /** fields.py `inherited`: an `_inherits` delegated field (its `base_field` is the parent's). */
  readonly inherited?: boolean;
  readonly onchange?: boolean;
  readonly onchange_dependents?: readonly string[];
  readonly no_access?: boolean;
  readonly compute?: boolean;
  readonly search?: boolean;
  readonly compute_sudo?: boolean;
  readonly depends?: readonly string[];
  readonly depends_context?: readonly string[];
  readonly searchable?: boolean;
  readonly sortable?: boolean;
  readonly groupable?: boolean;
  readonly aggregator?: string | false | null;
  readonly digits?: readonly [number, number] | null;
  readonly digits_raw?: unknown;
  readonly size?: number | null;
  readonly trim?: boolean;
  readonly attachment?: boolean;
  /** gen/models.py: only on fields.Image. */
  readonly image?: { readonly max_width: number; readonly max_height: number; readonly verify_resolution: boolean };
  readonly exportable?: boolean;
  readonly default_export_compatible?: boolean;
  readonly change_default?: boolean;
  readonly context?: Readonly<Record<string, unknown>>;
  /** The `domain=` attribute as a domain list, or a string for client-side expressions. */
  readonly domain?: unknown;
  readonly bypass_search_access?: boolean;
  readonly falsy_value_label?: string | null;
  readonly definition_record?: string | null;
  readonly definition_record_field?: string | null;
  readonly groups?: readonly string[] | string | null;
}

export interface GenModel {
  readonly format_vat_label?: boolean;
  readonly format_address?: boolean;
  readonly has_activities?: boolean;
  readonly view_field_attributes?: readonly string[];
  readonly modules?: readonly string[];
  readonly original_module_icon?: string;
  readonly systray_view?: string;
  readonly table?: string;
  readonly rec_name?: string | null;
  readonly rec_names_search?: readonly string[];
  readonly active_name?: string | null;
  readonly parent_store?: boolean;
  readonly parent_name?: string;
  readonly check_inherits_access?: boolean;
  readonly log_access?: boolean;
  readonly fields?: Readonly<Record<string, GenField>>;
}

export type GenMetadata = Readonly<Record<string, GenModel>>;

let genLoader: ((template: TemplateInfo) => Promise<GenMetadata | null>) | null = null;
const genCache = new Map<string, Promise<GenMetadata | null>>();

/**
 * Install the loader of gen/out/models.json (a dynamic `import()` or an ASSETS fetch; src/index.ts decides, this
 * module must not load big tables at top level). Without a loader the fallback rules below are used.
 * The metadata is per corpus template (gen/out/models.json for poc_corpus, gen/out/<template>/models.json for the
 * others, src/orm/template.ts): the Python classes differ with the installed modules.
 */
export function setGenMetadataLoader(loader: (template: TemplateInfo) => Promise<GenMetadata | null>): void {
  genLoader = loader;
  genCache.clear();
}

async function genMetadata(cr: Cursor): Promise<GenMetadata | null> {
  const loader = genLoader;
  if (loader === null) return null;
  const template = await templateOf(cr);
  let p = genCache.get(templateKey(template));
  if (p === undefined) {
    p = loader(template);
    genCache.set(templateKey(template), p);
  }
  return p;
}

/**
 * `_table` overrides in the Odoo source for models whose table is not `_name.replace('.', '_')`
 * (model_classes.py:286, :297): base/models/ir_actions.py.
 */
const TABLE_OVERRIDES: Readonly<Record<string, string>> = {
  "ir.actions.actions": "ir_actions",
  "ir.actions.act_window": "ir_act_window",
  "ir.actions.act_window.view": "ir_act_window_view",
  "ir.actions.act_window_close": "ir_actions",
  "ir.actions.act_url": "ir_act_url",
  "ir.actions.server": "ir_act_server",
  "ir.actions.client": "ir_act_client",
  "ir.actions.report": "ir_act_report_xml",
  "mail.notification": "mail_notification",
};

/** `_check_inherits_access = False` in the installed source (models.py:463 default True): mail_alias_mixin.py:16, mail_mail.py:34. */
const CHECK_INHERITS_ACCESS_FALSE: ReadonlySet<string> = new Set(["mail.alias.mixin", "mail.mail"]);

/** `_rec_names_search` overrides named in PORTING_odoo.md section 2 (fallback until gen/ exists). */
const REC_NAMES_SEARCH_FALLBACK: Readonly<Record<string, readonly string[]>> = {
  "res.partner": ["complete_name", "email", "ref", "vat"], // res_partner.py:273
  "res.country": ["name", "code"], // res_country.py:57
  "res.country.state": ["name", "code"], // res_country.py:229
  "res.currency": ["name", "full_name"], // res_currency.py:55
  "res.currency.rate": ["name", "rate"], // res_currency.py:399
  "ir.model": ["name", "model"], // ir_model.py:230
};

/** `_rec_name` overrides (fallback until gen/ exists): res_groups.py:17, ir_model.py:583. */
const REC_NAME_FALLBACK: Readonly<Record<string, string>> = {
  "res.groups": "full_name",
  "ir.model.fields": "field_description",
};

// --------------------------------------------------------------------------------------------------------------
// Rows
// --------------------------------------------------------------------------------------------------------------


interface FieldRow {
  id: number; model: string; name: string; ttype: string; relation: string | null; relation_field: string | null;
  relation_model_field: string | null; relation_table: string | null; column1: string | null; column2: string | null;
  related: string | null; index: string | null; translate: string | null; state: string; on_delete: string | null;
  domain: string | null; depends: string | null; currency_field: string | null;
  field_description: Record<string, string> | null; help: Record<string, string> | null;
  copied: boolean | null; required: boolean | null; readonly: boolean | null; company_dependent: boolean | null;
  group_expand: boolean | null; selectable: boolean | null; store: boolean | null; size: number | null;
  sanitize: boolean | null; sanitize_tags: boolean | null; sanitize_attributes: boolean | null;
  sanitize_style: boolean | null; strip_style: boolean | null; strip_classes: boolean | null; tracking: number | null;
}

interface ColumnRow { table_name: string; column_name: string; is_nullable: string; data_type: string }

/** The ir_model_fields columns of FieldRow (but `model`), in the order of the load's json_build_array. */
const FIELD_COLUMNS = [
  "id", "name", "ttype", "relation", "relation_field", "relation_model_field", "relation_table", "column1", "column2",
  "related", "index", "translate", "state", "on_delete", "domain", "depends", "currency_field", "field_description",
  "help", "copied", "required", "readonly", "company_dependent", "group_expand", "selectable", "store", "size",
  "sanitize", "sanitize_tags", "sanitize_attributes", "sanitize_style", "strip_style", "strip_classes", "tracking",
] as const;

/**
 * One row of FIELD_COLUMNS as json_build_array gives it: the values node-postgres gave for the plain columns (int4 and
 * boolean as numbers and booleans, jsonb as the parsed object, varchar as strings, NULL as null).
 */
function fieldRow(model: string, values: readonly unknown[]): FieldRow {
  if (values.length !== FIELD_COLUMNS.length) throw new TypeError(`ir_model_fields row of ${model}: ${values.length} values`);
  const row: Record<string, unknown> = { model };
  for (let i = 0; i < FIELD_COLUMNS.length; i++) row[FIELD_COLUMNS[i] as string] = values[i];
  return row as unknown as FieldRow;
}

const FIELD_TYPES: ReadonlySet<string> = new Set<FieldType>([
  "boolean", "integer", "float", "monetary", "char", "text", "html", "date", "datetime", "binary", "image",
  "selection", "reference", "many2one", "many2one_reference", "one2many", "many2many", "json", "properties",
  "properties_definition",
]);

function fieldType(ttype: string): FieldType {
  if (!FIELD_TYPES.has(ttype)) throw new TypeError(`unknown ir_model_fields.ttype ${ttype}`);
  return ttype as FieldType;
}

function langMap(value: Record<string, string> | null): Record<string, string> {
  return value ?? {};
}

// --------------------------------------------------------------------------------------------------------------
// Loading
// --------------------------------------------------------------------------------------------------------------

/**
 * The registry object, outside `loadRegistry`: its methods are closures kept for the isolate's life, and V8 keeps one
 * context per function for all its closures, so built inside they kept every row of the load alive (rowsByModel,
 * columnsByTable: about 3 MB of the ERP template's isolate heap, measured 2026-11-07). The load's rows are held only by
 * LazyModels' builder, which lets them go once every model is built.
 */
function makeRegistry(db: string, defs: Map<string, ModelDef>, hasUnaccent: boolean): Registry {
  const xmlids = new Map<string, number | null>();
  let xmlidsSeq: string | null = null;
  return {
    db,
    models: defs,
    hasUnaccent,
    model(name: string): ModelDef {
      const def = defs.get(name);
      if (def === undefined) throw new UnknownModel(name);
      return def;
    },
    async xmlid(cursor: Cursor, xmlid: string): Promise<number | null> {
      const isDirty = (): boolean =>
        cursor.writtenTables?.has("ir_model_data") === true || cursor.writtenTables?.has("*") === true;
      const useShared = !isDirty() && cursor.isolateCache !== false;
      if (useShared) {
        const seq = currentSequences(cursor);
        if (seq !== undefined) {
          const sig = `${seq.dboid ?? ""}:${seq.registry ?? 0}:${seq.default ?? 0}:${seq.groups ?? 0}:${seq.stable ?? 0}`;
          if (xmlidsSeq !== sig) {
            xmlids.clear();
            xmlidsSeq = sig;
          }
        }
        const cached = xmlids.get(xmlid);
        if (cached !== undefined) return cached;
      }
      const dot = xmlid.indexOf(".");
      if (dot < 0) throw new TypeError(`xmlid without module: ${xmlid}`);
      const res = await cursor.query<{ res_id: number }>(
        `SELECT res_id FROM ir_model_data WHERE module = $1 AND name = $2`, [xmlid.slice(0, dot), xmlid.slice(dot + 1)]);
      const id = res.rows[0]?.res_id ?? null;
      // a missing xmlid is not remembered; never populate the shared cache from a dirty/uncommitted transaction
      if (id !== null && useShared && !isDirty()) xmlids.set(xmlid, id);
      return id;
    },
  };
}

/**
 * The load's statements read only the registry's tables, which the isolate's statement cache would keep (src/orm/
 * signaling.ts `sharedRead`): kept once in the registry itself, they would be held twice (5.5 MB of ir_model_fields
 * rows on the ERP template, the most of perf-1's isolate cache, measured 2026-11-07).
 */
const NO_SHARE = { share: false } as const;

/** The statements of a registry load, in the order sent (src/orm/registry_share.ts keys its cache on their text). */
const LOAD_SQL = {
  models: `SELECT id, model, "order", name, transient, abstract, is_mail_thread, state FROM ir_model ORDER BY id`,
  fields: `SELECT model, json_agg(json_build_array(${FIELD_COLUMNS.join(", ")}) ORDER BY id)::text AS rows
      FROM ir_model_fields GROUP BY model`,
  selections: `SELECT field_id, value, name FROM ir_model_fields_selection ORDER BY sequence, id`,
  inherits: `SELECT i.model_id, i.parent_id, f.name AS link FROM ir_model_inherit i
        LEFT JOIN ir_model_fields f ON f.id = i.parent_field_id ORDER BY i.id`,
  groups: `SELECT r.field_id, d.module || '.' || d.name AS xmlid FROM ir_model_fields_group_rel r
        JOIN ir_model_data d ON d.model = 'res.groups' AND d.res_id = r.group_id ORDER BY r.field_id, d.id`,
  columns: `SELECT table_name, json_agg(json_build_array(column_name, is_nullable, data_type))::text AS columns
        FROM information_schema.columns WHERE table_schema = 'public' GROUP BY table_name`,
  unaccent: `SELECT 1 AS n FROM pg_extension WHERE extname = 'unaccent'`,
  langs: `SELECT code FROM res_lang WHERE active`,
} as const;
const LOAD_STATEMENTS = Object.values(LOAD_SQL).join("\n");

/** What a registry load reads from the database, all statements sent at once (one round trip with pipelining). */
export async function readRegistryRows(cr: Cursor): Promise<RegistryRows> {
  const [models, fields, selections, inherits, groups, columns, unaccent, langs] = await Promise.all([
    cr.query<ModelRow>(LOAD_SQL.models, [], NO_SHARE),
    cr.query<{ model: string; rows: string }>(LOAD_SQL.fields, [], NO_SHARE),
    cr.query<SelectionRow>(LOAD_SQL.selections, [], NO_SHARE),
    cr.query<InheritRow>(LOAD_SQL.inherits, [], NO_SHARE),
    cr.query<GroupRow>(LOAD_SQL.groups, [], NO_SHARE),
    cr.query<{ table_name: string; columns: string }>(LOAD_SQL.columns, [], NO_SHARE),
    cr.query<{ n: number }>(LOAD_SQL.unaccent),
    cr.query<{ code: string }>(LOAD_SQL.langs),
  ]);
  return {
    models: models.rows,
    fieldTexts: fields.rows.map((r) => [r.model, r.rows] as const),
    selections: selections.rows,
    inherits: inherits.rows,
    groups: groups.rows,
    columnTexts: columns.rows.map((r) => [r.table_name, r.columns] as const),
    unaccent: unaccent.rows.length > 0,
    langs: langs.rows.map((r) => r.code),
  };
}

async function loadRegistry(cr: Cursor, db: string): Promise<Registry> {
  const [rows, gen] = await Promise.all([sharedRegistryRows(cr, LOAD_STATEMENTS, readRegistryRows), genMetadata(cr)]);
  return buildRegistry(cr, db, rows, gen);
}

/** The registry from a load's rows (the database's, or the same rows kept by another isolate: src/orm/registry_share.ts). */
export async function buildRegistry(cr: Cursor, db: string, rows: RegistryRows, gen: GenMetadata | null): Promise<Registry> {
  // ir_model_fields and the columns come as one JSON text per model and per table, parsed when a model needs them:
  // node-postgres' row parsing of the 3 452 / 10 635 field rows was most of a new isolate's registry CPU (C2d)
  const columnTexts = new Map<string, string>();
  for (const [table, text] of rows.columnTexts) columnTexts.set(table, text);
  const columnsByTable = new Map<string, Map<string, ColumnRow> | undefined>();
  const columnsOf = (table: string): Map<string, ColumnRow> | undefined => {
    if (columnsByTable.has(table)) return columnsByTable.get(table);
    const text = columnTexts.get(table);
    let map: Map<string, ColumnRow> | undefined;
    if (text !== undefined) {
      map = new Map();
      for (const [column_name, is_nullable, data_type] of JSON.parse(text) as [string, string, string][]) {
        map.set(column_name, { table_name: table, column_name, is_nullable, data_type });
      }
    }
    columnsByTable.set(table, map);
    return map;
  };

  const modelById = new Map<number, ModelRow>();
  for (const m of rows.models) modelById.set(m.id, m);

  const selectionsByField = new Map<number, SelectionRow[]>();
  for (const s of rows.selections) {
    const list = selectionsByField.get(s.field_id) ?? [];
    list.push(s);
    selectionsByField.set(s.field_id, list);
  }

  const groupsByField = new Map<number, string[]>();
  for (const g of rows.groups) {
    const list = groupsByField.get(g.field_id) ?? [];
    list.push(g.xmlid);
    groupsByField.set(g.field_id, list);
  }

  // _inherits: parent model -> link field (only rows with a parent field; the others are plain _inherit mixins)
  const inheritsByModel = new Map<number, Map<string, string>>();
  for (const row of rows.inherits) {
    if (row.link === null) continue;
    const parent = modelById.get(row.parent_id);
    if (parent === undefined) continue;
    const map = inheritsByModel.get(row.model_id) ?? new Map<string, string>();
    map.set(parent.model, row.link);
    inheritsByModel.set(row.model_id, map);
  }

  const fieldTexts = new Map<string, string>();
  for (const [model, text] of rows.fieldTexts) fieldTexts.set(model, text);
  const modelRows = new Map<string, ModelRow>();
  for (const m of rows.models) modelRows.set(m.model, m);
  // a model's field rows by name, in id order (needed to resolve related chains when a model is built)
  const fieldMaps = new Map<string, Map<string, FieldRow>>();
  const fieldsOf = (model: string): Map<string, FieldRow> | undefined => {
    let fmap = fieldMaps.get(model);
    if (fmap !== undefined || !modelRows.has(model)) return fmap;
    fmap = new Map<string, FieldRow>();
    const text = fieldTexts.get(model);
    if (text !== undefined) for (const values of JSON.parse(text) as unknown[][]) {
      const f = fieldRow(model, values);
      fmap.set(f.name, f);
    }
    fieldMaps.set(model, fmap);
    return fmap;
  };
  const tables = new Map<string, string>();
  const tableOf = (model: string): string => {
    let table = tables.get(model);
    if (table === undefined) {
      table = gen?.[model]?.table ?? TABLE_OVERRIDES[model] ?? model.replace(/\./g, "_");
      tables.set(model, table);
    }
    return table;
  };

  // query-backed models (`_table_sql`, src/orm/table_sql.ts): their stored fields are the columns of the query
  const queryBacked = await queryBackedModels(cr);
  const hasColumn = (model: string, field: string): ColumnRow | undefined => {
    if (!modelRows.has(model)) return undefined;
    const table = tableOf(model);
    const physical = columnsOf(table);
    if (physical === undefined && queryBacked.has(model)) return { table_name: table, column_name: field, is_nullable: "YES", data_type: "" };
    return physical?.get(field);
  };

  /** Whether `related` resolves through many2one links to a field with a column (Field.setup_related, fields.py:677-689). */
  const relatedChainInSql = (model: string, related: string): boolean => {
    const parts = related.split(".");
    let current = model;
    for (let i = 0; i < parts.length; i++) {
      const row = fieldsOf(current)?.get(parts[i] as string);
      if (row === undefined) return false;
      const last = i === parts.length - 1;
      if (!last) {
        if (row.ttype !== "many2one" || row.relation === null) return false;
        if (row.store !== true && row.related === null) return false;
        current = row.relation;
      } else {
        if (row.ttype === "one2many" || row.ttype === "many2many") return false;
        if (row.store === true) return hasColumn(current, row.name) !== undefined || row.company_dependent === true;
        return row.related !== null && relatedChainInSql(current, row.related);
      }
    }
    return false;
  };

  // second pass, per model when it is first read (LazyModels): the generated metadata of a model is parsed then too
  // (src/gen_models.ts), so a request on a new isolate builds the few models it uses, not all 234 / 519 (C2d)
  const buildModel = (modelName: string): ModelDef => {
    const m = modelRows.get(modelName) as ModelRow;
    const info = { fields: fieldsOf(modelName) as Map<string, FieldRow> };
    const genModel = gen?.[modelName];
    const inheritsMap = inheritsByModel.get(m.id) ?? new Map<string, string>();
    const linkFields = new Map<string, string>(); // link field -> parent model
    for (const [parent, link] of inheritsMap) linkFields.set(link, parent);

    const fieldDefs = new Map<string, FieldDef>();
    for (const f of info.fields.values()) {
      const type = fieldType(f.ttype);
      const genField = genModel?.fields?.[f.name];
      const column = hasColumn(modelName, f.name);
      const store = f.store === true;
      const x2many = type === "one2many" || type === "many2many";
      const related = f.related;
      // inherited (_inherits) fields are related fields through the link field: `partner_id.name` (fields.py:1000)
      let inheritedFrom: string | null = null;
      let inheritedVia: string | null = null;
      if (related !== null) {
        const [link, ...rest] = related.split(".");
        const parent = link === undefined ? undefined : linkFields.get(link);
        if (parent !== undefined && rest.length === 1 && rest[0] === f.name) {
          inheritedFrom = parent;
          inheritedVia = link as string;
        }
      }
      // Binary: stored as attachment unless a bytea column exists or the field is not stored (fields_binary.py:36-46)
      const attachment = genField?.attachment ?? ((type === "binary" || type === "image") && store && column === undefined);
      const hasSqlColumn = store && !x2many && !((type === "binary" || type === "image") && attachment) && (column !== undefined || f.company_dependent === true);
      const relatedInSql = related !== null && !store && relatedChainInSql(modelName, related);
      const selectionRows = selectionsByField.get(f.id);
      const groupList = genField?.groups ?? groupsByField.get(f.id) ?? null;
      const compute = genField?.compute ?? (!store && related === null && f.name !== "id");
      // the label source of fields.py `base_field` (baseFieldLabels): Odoo's `inherited` flag when generated, else the
      // `_inherits` link shape; a related field through the link that the model declares itself is not inherited
      const delegated = genField ? genField.inherited === true : inheritedFrom !== null;
      const def: FieldDef = {
        name: f.name,
        type,
        string: f.field_description?.["en_US"] ?? f.name,
        strings: langMap(f.field_description),
        helps: langMap(f.help),
        column: hasSqlColumn,
        notNull: column?.is_nullable === "NO",
        manual: f.state === "manual",
        changeDefault: genField?.change_default ?? false,
        groupExpand: genField?.group_expand ?? f.group_expand === true,
        attachment,
        image: genField?.image ? { maxWidth: genField.image.max_width, maxHeight: genField.image.max_height, verifyResolution: genField.image.verify_resolution } : null,
        trim: genField?.trim ?? true,
        context: genField?.context ?? {},
        domain: genField?.domain ?? (f.domain === null || f.domain === "" ? null : f.domain),
        bypassSearchAccess: genField?.bypass_search_access ?? (inheritedVia !== null || linkFields.has(f.name)),
        tracking: f.tracking,
        currencyField: f.currency_field,
        modelField: f.relation_model_field,
        sanitize: type === "html" ? {
          sanitize: f.sanitize === true, sanitize_tags: f.sanitize_tags === true,
          sanitize_attributes: f.sanitize_attributes === true, sanitize_style: f.sanitize_style === true,
          strip_style: f.strip_style === true, strip_classes: f.strip_classes === true,
        } : null,
        // properties.base.definition.mixin (base/models/properties_base_definition_mixin.py): the only Properties
        // field in scope; gen/ carries the real `definition=` attribute
        definitionRecord: genField?.definition_record ?? (type === "properties" && info.fields.has("properties_base_definition_id") ? "properties_base_definition_id" : null),
        definitionRecordField: genField?.definition_record_field ?? (type === "properties" && info.fields.has("properties_base_definition_id") ? "properties_definition" : null),
        falsyValueLabel: genField?.falsy_value_label ?? null,
        store,
        required: f.required === true,
        readonly: f.readonly === true,
        translate: f.translate !== null && f.translate !== "",
        companyDependent: f.company_dependent === true,
        index: f.index !== null && f.index !== "",
        copy: f.copied === true,
        related,
        relation: f.relation,
        relationField: f.relation_field,
        relationTable: f.relation_table,
        column1: f.column1,
        column2: f.column2,
        selection: genField?.selection_dynamic ? null : genField?.selection
          ? genField.selection.map(([value, label]) => ({ value, label, labels: langMap(selectionRows?.find(s => s.value === value)?.name ?? null) }))
          : selectionRows?.map((s) => ({ value: s.value, label: s.name?.["en_US"] ?? s.value, labels: langMap(s.name) })) ?? null,
        inheritedFrom,
        inheritedVia,
        ondelete: f.on_delete,
        groups: typeof groupList === "string" ? groupList.split(",") : groupList,
        noAccess: genField?.no_access ?? false,
        depends: genField?.depends ?? (related !== null ? [related] : []),
        dependsContext: genField?.depends_context ?? [],
        compute,
        search: genField?.search ?? false,
        computeSudo: genField?.compute_sudo ?? false,
        digits: genField?.digits ?? null,
        digitsRaw: genField?.digits_raw,
        size: genField?.size ?? f.size,
        help: f.help?.["en_US"] ?? null,
        // fields.py:1030 `_description_searchable`: store or search or compute_sql (ir_model_fields.selectable = search or store)
        searchable: genField?.searchable ?? (f.selectable === true || relatedInSql),
        // fields.py:1033 `_description_sortable`: a column, or a related chain that can be expressed in SQL
        sortable: genField?.sortable ?? (hasSqlColumn || relatedInSql),
        // fields.py:1050 `_description_groupable`: like sortable, plus stored many2many (fields_binary.py:50: never binaries)
        groupable: genField?.groupable ?? ((type === "binary" || type === "image") ? false : (hasSqlColumn || relatedInSql || (type === "many2many" && store))),
        exportable: genField?.exportable ?? true,
        // fields_numeric.py:23/:205 aggregator 'sum' for Integer/Float/Monetary, None for 'sequence' (:28) and
        // Many2oneReference (fields_reference.py:72); fields.py:1071 keeps it only when the field is in SQL
        aggregator: genField && 'aggregator' in genField ? genField.aggregator || null : (
          // `id` is fields_misc.py:88 `Id`, not an Integer: no aggregator
          (type === "integer" || type === "float" || type === "monetary") && f.name !== "sequence" && f.name !== "id" && (hasSqlColumn || relatedInSql) ? "sum" : null),
        defaultExportCompatible: genField?.default_export_compatible ?? false,
        // a callable domain whose value only depends on the model is generated (gen/models.py, fields_relational.py:125)
        descriptionDomain: genField?.description_domain ?? genField?.description_domain_static ?? undefined,
        domainCallable: (genField?.domain_callable ?? false) && (genField?.description_domain_static ?? null) === null,
        descriptionAggregator: genField?.aggregator ?? null,
        minDisplayDigits: genField?.min_display_digits ?? null,
        onchange: genField?.onchange ?? false,
        onchangeDependents: genField?.onchange_dependents ?? [],
        descriptionTracking: genField?.tracking ?? false,
        trackingSequence: genField?.tracking_sequence ?? null,
      };
      fieldDefs.set(f.name, def);
      if (delegated && inheritedFrom !== null) DELEGATED.add(def);
    }

    const recNameDefault = fieldDefs.has("name") ? "name" : fieldDefs.has("x_name") ? "x_name" : null; // model_classes.py:467-473
    const activeDefault = fieldDefs.has("active") ? "active" : fieldDefs.has("x_active") ? "x_active" : null; // :476-485
    const def: ModelDef = {
      name: modelName,
      table: tableOf(modelName),
      description: m.name?.["en_US"] ?? modelName,
      formatVatLabel: genModel?.format_vat_label ?? false,
      formatAddress: genModel?.format_address ?? false,
      hasActivities: genModel?.has_activities ?? false,
      // a custom model's class is BaseModel's with the `base` extensions of the installed modules (model_classes.py)
      viewFieldAttributes: genModel?.view_field_attributes ?? (m.state === "manual" ? gen?.["base"]?.view_field_attributes ?? [] : []),
      ...(genModel === undefined && m.state === "manual" ? { custom: true } : {}),
      modules: genModel?.modules ?? [],
      ...(genModel?.original_module_icon !== undefined ? { moduleIcon: genModel.original_module_icon } : {}),
      ...(genModel?.systray_view !== undefined ? { systrayView: genModel.systray_view } : {}),
      descriptions: langMap(m.name),
      isMailThread: m.is_mail_thread === true,
      order: m.order,
      transient: m.transient === true,
      abstract: m.abstract === true,
      recName: genModel?.rec_name !== undefined ? genModel.rec_name : (REC_NAME_FALLBACK[modelName] ?? recNameDefault),
      recNamesSearch: genModel?.rec_names_search ?? REC_NAMES_SEARCH_FALLBACK[modelName] ?? [],
      activeName: genModel?.active_name !== undefined ? genModel.active_name : activeDefault,
      // fallback: models with `_parent_store = True` declare `parent_path = fields.Char(index=True)` (res_partner.py:231-234)
      parentStore: genModel?.parent_store ?? fieldDefs.has("parent_path"),
      parentName: genModel?.parent_name ?? "parent_id",
      inherits: inheritsMap,
      fields: fieldDefs,
      logAccess: genModel?.log_access ?? fieldDefs.has("create_date"),
      checkInheritsAccess: genModel?.check_inherits_access ?? !CHECK_INHERITS_ACCESS_FALSE.has(modelName),
    };
    return def;
  };

  // the models in ir_model's order, as the eager loop gave them; a built model takes its delegated fields' labels
  // from its parents (baseFieldLabels, built in turn)
  const defs = new LazyModels([...modelRows.keys()], buildModel, (def) => modelBaseFieldLabels(registry, def));
  const registry = makeRegistry(db, defs, rows.unaccent);
  LOADED_LANGS.set(registry, new Set(rows.langs));
  return registry;
}

const UNBUILT = Symbol("unbuilt");

/**
 * The registry's models, each built from the load's rows on its first `get` (registry.py builds every class at
 * load; the result for a model depends only on the rows read in the load's transaction, so building it later gives the
 * same ModelDef). Iteration builds every model first and keeps ir_model's order; `has`, `keys` and `size` build
 * nothing. Once all are built the rows are released.
 */
class LazyModels extends Map<string, ModelDef> {
  private build: ((name: string) => ModelDef) | null;
  private built: ((def: ModelDef) => void) | null;
  private unbuilt: number;

  constructor(names: readonly string[], build: (name: string) => ModelDef, built: (def: ModelDef) => void) {
    super();
    for (const name of names) super.set(name, UNBUILT as unknown as ModelDef);
    this.build = build;
    this.built = built;
    this.unbuilt = names.length;
  }

  override get(name: string): ModelDef | undefined {
    const value = super.get(name);
    if ((value as unknown) !== UNBUILT) return value;
    const build = this.build as (name: string) => ModelDef;
    const after = this.built as (def: ModelDef) => void;
    const def = build(name);
    super.set(name, def);
    if (--this.unbuilt === 0) {
      this.build = null;
      this.built = null;
    }
    after(def);
    return def;
  }

  private buildAll(): void {
    if (this.unbuilt === 0) return;
    for (const name of [...super.keys()]) this.get(name);
  }

  override values(): MapIterator<ModelDef> {
    this.buildAll();
    return super.values();
  }

  override entries(): MapIterator<[string, ModelDef]> {
    this.buildAll();
    return super.entries();
  }

  override [Symbol.iterator](): MapIterator<[string, ModelDef]> {
    this.buildAll();
    return super[Symbol.iterator]();
  }

  override forEach(fn: (value: ModelDef, key: string, map: Map<string, ModelDef>) => void, thisArg?: unknown): void {
    this.buildAll();
    super.forEach(fn, thisArg);
  }

  override set(): this {
    throw new TypeError("the registry's models are read-only");
  }

  override delete(): boolean {
    throw new TypeError("the registry's models are read-only");
  }

  override clear(): void {
    throw new TypeError("the registry's models are read-only");
  }
}

/** The `_inherits` delegated fields (fields.py `inherited`), whose labels come from the parent's field. */
const DELEGATED = new WeakSet<FieldDef>();

/** The languages whose labels a registry holds: the active ones when it was loaded, plus those added since. */
const LOADED_LANGS = new WeakMap<Registry, Set<string>>();

/**
 * A language activated after the registry was loaded (base.language.install, src/models/lang_install.ts, possibly in
 * another isolate): read its labels from the rows Odoo's `_description_string` and friends read
 * (fields.py `_description_string`/`_description_help`: ir.model.fields `get_field_string`/`get_field_help`,
 * `get_field_selection`; ir_model.name) into the registry, so they are not silently answered in English.
 */
export async function ensureRegistryLang(cr: Cursor, reg: Registry, lang: string): Promise<void> {
  await loadCodeTranslations(cr, lang);
  const loaded = LOADED_LANGS.get(reg);
  if (loaded === undefined || loaded.has(lang)) return;
  const active = await cr.query<{ n: number }>("SELECT 1 AS n FROM res_lang WHERE active AND code = $1", [lang]);
  if (!active.rows.length) return; // checkLang raises "Invalid language code" where the language is used
  const [models, fields, selections] = await Promise.all([
    cr.query<{ model: string; name: string | null }>("SELECT model, name->>$1 AS name FROM ir_model", [lang]),
    cr.query<{ model: string; name: string; string: string | null; help: string | null }>(
      "SELECT model, name, field_description->>$1 AS string, help->>$1 AS help FROM ir_model_fields", [lang]),
    cr.query<{ model: string; field: string; value: string; name: string | null }>(
      `SELECT f.model, f.name AS field, s.value, s.name->>$1 AS name
         FROM ir_model_fields_selection s JOIN ir_model_fields f ON f.id = s.field_id`, [lang]),
  ]);
  for (const m of models.rows) {
    const def = reg.models.get(m.model);
    if (def && m.name !== null) (def.descriptions as Record<string, string>)[lang] = m.name;
  }
  for (const f of fields.rows) {
    const field = reg.models.get(f.model)?.fields.get(f.name);
    if (!field) continue;
    if (f.string !== null) (field.strings as Record<string, string>)[lang] = f.string;
    if (f.help !== null) (field.helps as Record<string, string>)[lang] = f.help;
  }
  for (const s of selections.rows) {
    const opt = reg.models.get(s.model)?.fields.get(s.field)?.selection?.find((o) => o.value === s.value);
    if (opt && s.name !== null) (opt.labels as Record<string, string>)[lang] = s.name;
  }
  baseFieldLabels(reg);
  loaded.add(lang);
}

/**
 * fields.py:1092-1104 `_description_string` / `_description_help` read ir.model.fields of `self.base_field.model_name`:
 * an `_inherits` delegated field takes its label and help (in every language) from the parent model's field, whose
 * translations can differ from the child's own ir_model_fields row (project.project.alias_defaults, mail.alias's).
 */
function baseFieldLabels(reg: Registry): void {
  for (const def of reg.models.values()) modelBaseFieldLabels(reg, def);
}

function modelBaseFieldLabels(reg: Registry, def: ModelDef): void {
  for (const field of def.fields.values()) {
    if (field.inheritedFrom === null || !DELEGATED.has(field)) continue;
    let base = reg.models.get(field.inheritedFrom)?.fields.get(field.name);
    for (let i = 0; base && base.inheritedFrom !== null && DELEGATED.has(base) && i < 10; i++) base = reg.models.get(base.inheritedFrom)?.fields.get(field.name);
    if (!base) continue;
    for (const [lang, v] of Object.entries(base.strings)) if (lang !== "en_US") (field.strings as Record<string, string>)[lang] = v;
    for (const [lang, v] of Object.entries(base.helps)) if (lang !== "en_US") (field.helps as Record<string, string>)[lang] = v;
  }
}

/** `KeyError` of `env[model_name]` for an unknown model. */
export class UnknownModel extends Error {
  readonly model: string;
  constructor(model: string) {
    super(`unknown model ${model}`);
    this.name = "UnknownModel";
    this.model = model;
  }
}

// --------------------------------------------------------------------------------------------------------------
// Bounded per-database cache
// --------------------------------------------------------------------------------------------------------------

const MAX_REGISTRIES = 8;
const registries = new Map<string, Promise<Registry>>();
onRegistryChange((db) => registries.delete(db));

/** The registry of the cursor's database, loaded on first use. */
export function getRegistry(cr: Cursor): Promise<Registry> {
  const cached = registries.get(cr.db);
  if (cached !== undefined) return timedRegistry(cr, "regwait", cached);
  const loading = loadRegistry(cr, cr.db).catch((e: unknown) => {
    registries.delete(cr.db);
    throw e;
  });
  registries.set(cr.db, loading);
  while (registries.size > MAX_REGISTRIES) {
    const oldest = registries.keys().next().value;
    if (oldest === undefined) break;
    registries.delete(oldest);
  }
  return timedRegistry(cr, "regt", loading);
}

/**
 * SQL_LOG=1 (src/phases.ts): the request's first wait for the registry, its own load (`regt`) or one another request
 * of the isolate began (`regwait`, 0 when it was loaded already). Without phases the promise itself.
 */
const registryTimed = new WeakSet<Cursor>();
function timedRegistry(cr: Cursor, wait: "regt" | "regwait", p: Promise<Registry>): Promise<Registry> {
  if (cr.phases === null || registryTimed.has(cr)) return p;
  registryTimed.add(cr);
  return cr.phases.time(wait, p);
}

/** Forget a database's registry (after module installs or for tests). */
export function dropRegistry(db: string): void {
  registries.delete(db);
}
