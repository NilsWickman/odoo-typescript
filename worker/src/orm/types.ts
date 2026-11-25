/**
 * Shared ORM types. Owned by the ORM stream (src/orm/); other streams import from here and never redefine.
 * Mapping rules: prestudy/PORTING_ts.md. Source of truth: `odoo/odoo/orm/` (fields*.py, models.py, domains.py).
 */
import type { Cursor } from "../db";

/** `ir_model_fields.ttype` (fields.py). */
export type FieldType =
  | "boolean" | "integer" | "float" | "monetary" | "char" | "text" | "html" | "date" | "datetime"
  | "binary" | "image" | "selection" | "reference" | "many2one" | "many2one_reference" | "one2many"
  | "many2many" | "json" | "properties" | "properties_definition";

/** A Python float carried through JS: Odoo emits `2026.0` where JS would print `2026` (PORTING_odoo.md section 9). */
export interface PyFloat { readonly float: number }

/**
 * Value of a binary field (`odoo/odoo/tools/binary.py` BinaryValue, `fields_binary.py:399` BinaryValueAttachment):
 * size and checksum are known without the content (ir_attachment.file_size/checksum); `content()` loads the bytes.
 */
export interface BinaryValue {
  /** '' when the value has no file name (binary.py:26; attachment name equal to the field name counts as none, :422). */
  readonly filename: string;
  readonly size: number;
  /** sha1 hex for attachments (ir_attachment.py:446), sha256 hex for in-memory bytes (binary.py:71). */
  readonly checksum: string;
  readonly mimetype: string;
  content(): Promise<Uint8Array>;
}

export interface FieldDef {
  readonly name: string;
  readonly type: FieldType;
  /** en_US label; `strings` holds every language of ir_model_fields.field_description. */
  readonly string: string;
  readonly strings: Readonly<Record<string, string>>;
  readonly helps: Readonly<Record<string, string>>;
  /** Whether the value lives in a column of the model's table (Field.column_type): stored, not x2many, not attachment. */
  readonly column: boolean;
  /** NOT NULL in the database (registry.not_null_fields). */
  readonly notNull: boolean;
  /** `ir_model_fields.state == 'manual'`. */
  readonly manual: boolean;
  readonly changeDefault: boolean;
  readonly groupExpand: boolean;
  /** Binary stored as ir_attachment rows (fields_binary.py:36). */
  readonly attachment: boolean;
  /**
   * A `fields.Image` (fields_binary.py:279-298, ttype 'binary' in ir_model_fields): the size `_image_process` resizes
   * to and whether it checks the resolution, from the registry (gen/models.py `image`); absent on other fields and in
   * metadata generated without it.
   */
  readonly image?: { readonly maxWidth: number; readonly maxHeight: number; readonly verifyResolution: boolean } | null;
  /** Char.trim (fields_textual.py:521). */
  readonly trim: boolean;
  /** Relational field attributes that only exist in Python (gen/): `context=`, `domain=`, `bypass_search_access=`. */
  readonly context: Readonly<Record<string, unknown>>;
  /** The field's `domain=` as written (a domain list, or a string for client-side expressions), else null. */
  readonly domain: unknown;
  readonly bypassSearchAccess: boolean;
  /** `ir_model_fields.tracking` (mail.track.mixin): null when not tracked. */
  readonly tracking: number | null;
  readonly currencyField: string | null;
  /** many2one_reference: the char field holding the model name. */
  readonly modelField: string | null;
  readonly sanitize: Readonly<Record<string, boolean>> | null;
  readonly definitionRecord: string | null;
  readonly definitionRecordField: string | null;
  readonly falsyValueLabel: string | null;
  readonly store: boolean;
  readonly required: boolean;
  readonly readonly: boolean;
  readonly translate: boolean;
  readonly companyDependent: boolean;
  readonly index: boolean;
  readonly copy: boolean;
  /** Dotted path for `related=` fields, else null. */
  readonly related: string | null;
  /** Comodel for relational fields. */
  readonly relation: string | null;
  /** Inverse many2one of a one2many. */
  readonly relationField: string | null;
  /** many2many: table, column1, column2. */
  readonly relationTable: string | null;
  readonly column1: string | null;
  readonly column2: string | null;
  /** Selection keys in order, with their labels per lang (ir_model_fields_selection); null for callable selections. */
  readonly selection: readonly { value: string; label: string; labels: Readonly<Record<string, string>> }[] | null;
  /** Model whose table holds the column for `_inherits` delegated fields, else null (the model itself). */
  readonly inheritedFrom: string | null;
  /** The `_inherits` link field through which the delegated field is reached. */
  readonly inheritedVia: string | null;
  /** `ir_model_fields.on_delete` of a many2one. */
  readonly ondelete: string | null;
  /** Group xmlids from ir_model_fields_group_rel, plus NO_ACCESS from the generator (gen/). */
  readonly groups: readonly string[] | null;
  readonly noAccess: boolean;
  /** `depends` of a computed field (generated from the Python source, gen/). */
  readonly depends: readonly string[];
  /** `registry.field_depends_context[field]` (gen/models.py): the context keys of the field's cache key. */
  readonly dependsContext?: readonly string[];
  readonly compute: boolean;
  /** Field.search can exist without Field.compute (phone_mobile_search). */
  readonly search?: boolean;
  readonly computeSudo?: boolean;
  readonly digits: readonly [number, number] | null;
  /** The `digits=` attribute as written when it is not a pair or a precision name (e.g. `digits=0`, fields_numeric.py:138). */
  readonly digitsRaw?: unknown;
  readonly size: number | null;
  readonly help: string | null;
  readonly sortable: boolean;
  readonly searchable: boolean;
  readonly groupable: boolean;
  readonly exportable: boolean;
  readonly aggregator: string | null;
  readonly defaultExportCompatible: boolean;
  readonly descriptionDomain?: unknown;
  readonly domainCallable?: boolean;
  readonly descriptionAggregator?: string | false | null;
  readonly minDisplayDigits?: number | null;
  readonly onchange?: boolean;
  readonly onchangeDependents?: readonly string[];
  readonly descriptionTracking?: boolean;
  readonly trackingSequence?: number | null;
}

export interface ModelDef {
  readonly name: string;
  readonly table: string;
  /** en_US `ir_model.name`; `descriptions` per language. */
  readonly description: string;
  readonly formatVatLabel?: boolean;
  readonly formatAddress?: boolean;
  readonly hasActivities?: boolean;
  readonly viewFieldAttributes?: readonly string[];
  /** A custom model (ir_model.state 'manual', made in Settings → Technical, B4): no Python class beyond BaseModel's. */
  readonly custom?: boolean;
  readonly modules?: readonly string[];
  /** `get_module_icon(_original_module)` (mail/models/res_users.py:567-568), from gen/models.py. */
  readonly moduleIcon?: string;
  /** `_systray_view` (mail/models/res_users.py:584, default 'list'), from gen/models.py. */
  readonly systrayView?: string;
  readonly descriptions: Readonly<Record<string, string>>;
  /** ir_model.is_mail_thread: fields_get adds `tracking`/`tracking_sequence` (mail_track_mixin.py:44). */
  readonly isMailThread: boolean;
  readonly order: string;
  readonly transient: boolean;
  readonly abstract: boolean;
  readonly recName: string | null;
  readonly recNamesSearch: readonly string[];
  readonly activeName: string | null;
  readonly parentStore: boolean;
  readonly parentName: string;
  /** `_inherits`: parent model -> link field. */
  readonly inherits: ReadonlyMap<string, string>;
  readonly fields: ReadonlyMap<string, FieldDef>;
  readonly logAccess: boolean;
  readonly checkInheritsAccess: boolean;
}

export interface Registry {
  readonly db: string;
  readonly models: ReadonlyMap<string, ModelDef>;
  /** `registry.has_unaccent`: whether ilike wraps both sides in unaccent() (registry.py:343). */
  readonly hasUnaccent: boolean;
  /** `ir_model_data` xmlid -> id lookups, cached. */
  xmlid(cr: Cursor, xmlid: string): Promise<number | null>;
  model(name: string): ModelDef;
}

/** Odoo's prefix-notation domain, parsed once into a tree (domains.py). */
export type Domain =
  | { readonly kind: "and"; readonly args: readonly Domain[] }
  | { readonly kind: "or"; readonly args: readonly Domain[] }
  | { readonly kind: "not"; readonly arg: Domain }
  | { readonly kind: "cond"; readonly path: string; readonly op: string; readonly value: unknown }
  | { readonly kind: "true" }
  | { readonly kind: "false" };

/** The known context keys; everything else is `unknown`. */
export interface Context {
  readonly lang?: string;
  readonly tz?: string;
  readonly uid?: number;
  readonly allowed_company_ids?: readonly number[];
  readonly active_test?: boolean;
  readonly bin_size?: boolean;
  readonly [key: string]: unknown;
}

/** `odoo/odoo/orm/environments.py` Environment: registry, cursor, user, context, superuser flag. */
export interface Environment {
  readonly reg: Registry;
  readonly cr: Cursor;
  readonly uid: number;
  readonly context: Context;
  readonly su: boolean;
  /** `request.session.debug` is non-empty: `has_group('base.group_no_one')` is only true in debug mode (res_users.py:1210). */
  readonly debug: boolean;
  /** `env.lang`: context lang or null (= en_US for translated values). */
  readonly lang: string | null;
  /** `env.companies` as ids (allowed_company_ids or all of the user's companies). */
  companies(): Promise<readonly number[]>;
  company(): Promise<number>;
  withContext(ctx: Context): Environment;
  withUser(uid: number): Environment;
  sudo(): Environment;
  /** Per-request cache shared by all models of this environment (field values by model, id, field). */
  readonly cache: Map<string, unknown>;
  model(name: string): Model;
}

export interface SearchOptions {
  readonly offset?: number;
  readonly limit?: number | null;
  readonly order?: string | null;
  readonly activeTest?: boolean;
}

export type RecordValues = Record<string, unknown>;

/** The subset of `odoo.models.BaseModel` the web layer needs for the read scenario (PORTING_odoo.md sections 3, 4). */
export interface Model {
  readonly def: ModelDef;
  readonly env: Environment;
  /** `_search`: access domain ANDed in, active_test applied, ordering per `_order_to_sql`. */
  search(domain: Domain, opts?: SearchOptions): Promise<number[]>;
  searchCount(domain: Domain, limit?: number | null): Promise<number>;
  /** `read()` with Odoo's value formats (`convert_to_read`): many2one `[id, display_name]`, x2many ids, `false` for empty. */
  read(ids: readonly number[], fields: readonly string[], load?: string): Promise<RecordValues[]>;
  /** Native record[field] binary value, before RPC serialization (ir.binary streams this value). */
  binaryValue(id: number, field: string): Promise<BinaryValue | null>;
  /** `_read_format` on records already checked for access. */
  displayName(ids: readonly number[]): Promise<Map<number, string>>;
  nameSearch(name: string, domain: Domain, operator: string, limit: number | null): Promise<[number, string | false][]>;
  /** `check_access(operation)` for ids: raises AccessError like `ir_access.py:326` (no permission at all) or `:411`. */
  checkAccess(ids: readonly number[], operation: "read" | "write" | "create" | "unlink"): Promise<void>;
  /** `_access_domain(operation)` from ir.access, or null for unrestricted (superuser). */
  accessDomain(operation: "read" | "write" | "create" | "unlink"): Promise<Domain | null>;
  fieldsGet(allfields?: readonly string[] | null, attributes?: readonly string[] | null): Promise<Record<string, RecordValues>>;
}
