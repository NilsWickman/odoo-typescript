/**
 * Loading module data files: `odoo/tools/convert.py` (`xml_import`, `convert_csv_import`, `convert_file`) and the
 * record side of it, `BaseModel._load_records` (orm/models.py:4619-4724) with `ir.model.data._update_xmlids`
 * (ir_model.py:2446-2524).
 *
 * Ported tags: record, menuitem, template, delete; field values by text, eval, ref, search and the char, int, float,
 * list, tuple and xml types; <function> through registerDataFunction or the call_kw table. Not ported (NotPorted): <asset> (the Worker's
 * bundles are precompiled), field files and the html type, uid= on a node, and the RelaxNG validation of the file
 * (`import_xml.rng`, convert.py:793-810), so a file Odoo rejects for its shape alone may load here.
 */
import { lookupMethod } from "../http/methods";
import { dbNow } from "../models/util";
import { assertImportXml } from "./relaxng";
import { NotPorted, UserError, ValidationError } from "../errors";
import { create } from "../orm/create";
import { write } from "../orm/write";
import { unlink } from "../orm/unlink";
import { parseDomain } from "../orm/domain";
import type { Environment } from "../orm/types";
import { evalExprAsync, PyObject, PyTuple, pyTuple, isDict, dictEntries } from "../pyexpr";
import { element, parseXml, serializeHtml, serializeXml, type Element, type Node } from "../xml";
import { loadRows } from "./load_csv";
import { pformatDict, ViewValidationError } from "./view_buttons";
import { loadRecords } from "../orm/load_records";
import { ModelImpl } from "../orm/model";
import { dataDateFieldValue, isDataDateValue, PyDataDatetime, PyDatetimeClass, PyRelativedelta, PyTimedelta, PyUnported } from "./data_dates";
export { loadRecords, updateXmlids } from "../orm/load_records";

export type IdRef = Map<string, number>;
export type ConvertMode = "init" | "update";

/**
 * Methods a data file's `<function>` may call (convert.py:182-221), by model and name: `apiModel` methods get no
 * record ids; the others get the first argument as ids. A method not here falls back to the call_kw table
 * (src/http/methods.ts), as Odoo calls any public method.
 */
export interface DataFunction {
  readonly apiModel: boolean;
  readonly fn: (env: Environment, ids: number[], args: unknown[], kwargs: Record<string, unknown>) => Promise<unknown>;
}
const DATA_FUNCTIONS = new Map<string, DataFunction>();
export function registerDataFunction(model: string, name: string, fn: DataFunction): void {
  DATA_FUNCTIONS.set(`${model}::${name}`, fn);
}

/** `env` in an eval context (`obj().env`): `ref(xmlid)` as the record id, and `company`. */
class PyEnv extends PyObject {
  constructor(private readonly ref: (x: unknown) => Promise<unknown>, private readonly env: Environment) { super(); }
  pyGetAttr(name: string): unknown {
    if (name === "ref") return this.ref;
    if (name === "company") return this.env.company().then((id) => new PyCompany(this.env, id));
    throw new NotPorted(`env.${name} in a data file eval`);
  }
}

/**
 * `env.company` (environments.py `company`) in an eval: its id and its plain stored fields, read in the loading
 * environment (partnership's menu name, partnership_menu.xml:4 `obj().env.company.partnership_label`).
 */
class PyCompany extends PyObject {
  constructor(private readonly env: Environment, private readonly id: number) { super(); }
  pyGetAttr(name: string): unknown {
    if (name === "id") return this.id;
    const def = this.env.reg.model("res.company");
    const f = def.fields.get(name);
    if (!f || !f.store || !["char", "text", "integer", "float", "boolean", "selection"].includes(f.type)) {
      throw new NotPorted(`env.company.${name} in a data file eval`);
    }
    return new ModelImpl(this.env, def).values([this.id], f).then((v) => v.get(this.id) ?? false);
  }
}

/** `obj()` in an eval context with a model (convert.py:66 `_get_eval_context`): the model, here only its `env`. */
class PyModel extends PyObject {
  constructor(private readonly env: PyEnv) { super(); }
  pyGetAttr(name: string): unknown {
    if (name === "env") return this.env;
    throw new NotPorted(`obj().${name} in a data file eval`);
  }
}

/**
 * The `time` module of the eval context (convert.py:51): `time.strftime(fmt)` of the process's local time, which is UTC
 * (odoo/__init__.py sets TZ=UTC); the transaction's now() stands for it (the same day but at midnight). The
 * directives data files use; others refuse.
 */
class PyTimeModule extends PyObject {
  constructor(private readonly env: Environment) { super(); }
  pyGetAttr(name: string): unknown {
    if (name !== "strftime") throw new NotPorted(`time.${name} in a data file`);
    return async (fmt: unknown, ...rest: unknown[]) => {
      if (typeof fmt !== "string" || rest.length) throw new NotPorted("time.strftime with a time tuple");
      const now = await dbNow(this.env);
      const p = (n: number, w = 2) => String(n).padStart(w, "0");
      return fmt.replace(/%(.)/g, (_m, d: string) => {
        switch (d) {
          case "Y": return p(now.getUTCFullYear(), 4);
          case "m": return p(now.getUTCMonth() + 1);
          case "d": return p(now.getUTCDate());
          case "H": return p(now.getUTCHours());
          case "M": return p(now.getUTCMinutes());
          case "S": return p(now.getUTCSeconds());
          case "y": return p(now.getUTCFullYear() % 100);
          case "%": return "%";
          default: throw new NotPorted(`time.strftime directive %${d}`);
        }
      });
    };
  }
}

/** `fields.Command` in eval contexts: the x2many command tuples. */
class PyCommand extends PyObject {
  pyGetAttr(name: string): unknown {
    switch (name) {
      case "create": return (values: unknown) => pyTuple([0, 0, values]);
      case "update": return (id: unknown, values: unknown) => pyTuple([1, id, values]);
      case "delete": return (id: unknown) => pyTuple([2, id, 0]);
      case "unlink": return (id: unknown) => pyTuple([3, id, 0]);
      case "link": return (id: unknown) => pyTuple([4, id, 0]);
      case "clear": return () => pyTuple([5, 0, 0]);
      case "set": return (ids: unknown) => pyTuple([6, 0, ids]);
      case "CREATE": return 0;
      case "UPDATE": return 1;
      case "DELETE": return 2;
      case "UNLINK": return 3;
      case "LINK": return 4;
      case "CLEAR": return 5;
      case "SET": return 6;
      default: throw new NotPorted(`Command.${name}`);
    }
  }
}

/** Python values of an eval as plain JS for the ORM: dicts as objects. */
/**
 * The names of a data file's eval context (convert.py:49-62): `safe_eval` raises NameError for any other, where the
 * template evaluator reads a missing name as None; a name outside the context refuses (an unknown name read as None
 * gave an AttributeError that the demo loader took for a failure of the module's demo data).
 */
class DataEvalScope extends Map<string, unknown> {
  override has(_key: string): boolean { return true; }
  override get(key: string): unknown {
    if (!super.has(key)) throw new NotPorted(`name ${key} in a data file eval (not in convert.py's eval context)`);
    return super.get(key);
  }
}

function plain(v: unknown): unknown {
  if (isDataDateValue(v)) throw new NotPorted("a datetime, timedelta or relativedelta value inside a data file value");
  // a tuple stays one (PyTuple: `str()` of an evaluated domain in a Char field, l10n_kr's report formulas, is its repr)
  if (v instanceof PyTuple) return pyTuple(v.map(plain));
  if (Array.isArray(v)) return v.map(plain);
  if (isDict(v)) return Object.fromEntries(dictEntries(v).map(([k, x]) => [String(k), plain(x)]));
  return v;
}

const str2bool = (value: string): boolean => !["0", "false", "off"].includes(value.toLowerCase());

function nodeattr2bool(node: Element, attr: string, dflt = false): boolean {
  const v = node.attrib.get(attr);
  if (!v || !v.trim()) return dflt;
  return str2bool(v.trim());
}

const isElement = (n: Node): n is Element => n.kind === "element";
const childElements = (n: Element, tag?: string): Element[] => n.children.filter((c): c is Element => isElement(c) && (tag === undefined || c.tag === tag));

/** `ir.model.data._xmlid_lookup` (ir_model.py:2351-2361). */
async function xmlidLookup(env: Environment, xmlid: string): Promise<[string, number] | null> {
  const dot = xmlid.indexOf(".");
  if (dot < 0) return null;
  const row = (await env.cr.query<{ model: string; res_id: number | null }>(
    "SELECT model, res_id FROM ir_model_data WHERE module = $1 AND name = $2", [xmlid.slice(0, dot), xmlid.slice(dot + 1)])).rows[0];
  return row && row.res_id ? [row.model, row.res_id] : null;
}

/** `env.ref(xmlid)` as (model, id) when the record exists, else null (`_load_xmlid`, ir_model.py:2527-2534). */
async function loadXmlid(env: Environment, xmlid: string): Promise<[string, number] | null> {
  const r = await xmlidLookup(env, xmlid);
  if (r === null || !env.reg.models.has(r[0])) return null;
  const table = env.reg.model(r[0]).table;
  return (await env.cr.query(`SELECT 1 FROM "${table}" WHERE id = $1`, [r[1]])).rows.length ? r : null;
}

/** `xml_import` (convert.py:237-689). */
export class XmlImport {
  private readonly envs: Environment[];
  private readonly noupdates: boolean[];
  private readonly sequences: (number | null)[] = [];

  /**
   * @param binaries the files `<field file="...">` names, base64 by their addons path (gen/module_files.py `binaries`):
   * convert.py:137-147 `file_open`
   */
  constructor(env: Environment, readonly module: string, readonly idref: IdRef, readonly mode: ConvertMode, noupdate: boolean, readonly xmlFilename: string,
    private readonly binaries?: Readonly<Record<string, string>>) {
    // `env(context=dict(env.context, lang=None))`: values are written as the source (en_US) terms
    const { lang: _lang, ...ctx } = env.context;
    this.envs = [env.withContext(ctx)];
    this.noupdates = [noupdate];
  }

  private get env(): Environment { return this.envs[this.envs.length - 1]!; }
  private get noupdate(): boolean { return this.noupdates[this.noupdates.length - 1]!; }

  private nextSequence(): number | null {
    let value = this.sequences[this.sequences.length - 1] ?? null;
    if (value !== null) value = this.sequences[this.sequences.length - 1] = value + 10;
    return value;
  }

  makeXmlId(xmlId: string): string {
    if (!xmlId || xmlId.includes(".")) return xmlId;
    return `${this.module}.${xmlId}`;
  }

  /** `_test_xml_id`: at most one dot, and another module's id must be from an installed module. */
  private async testXmlId(xmlId: string): Promise<void> {
    if (!xmlId.includes(".")) return;
    const dot = xmlId.indexOf(".");
    const module = xmlId.slice(0, dot);
    if (xmlId.slice(dot + 1).includes(".")) throw new Error(`The ID reference "${xmlId}" must contain\nmaximum one dot. They are used to refer to other modules ID, in the\nform: module.record_id`);
    if (module !== this.module) {
      const n = (await this.env.cr.query<{ n: string }>("SELECT count(*)::text AS n FROM ir_module_module WHERE name = $1 AND state = 'installed'", [module])).rows[0]!.n;
      if (Number(n) !== 1) throw new Error(`The ID "${xmlId}" refers to an uninstalled module`);
    }
  }

  async idGet(idStr: string, raiseIfNotFound = true): Promise<number | false> {
    const full = this.makeXmlId(idStr);
    const known = this.idref.get(full);
    if (known !== undefined) return known;
    const r = await this.modelIdGet(full, raiseIfNotFound);
    return r[1];
  }

  async modelIdGet(idStr: string, raiseIfNotFound = true): Promise<[string, number] | [false, false]> {
    const r = await xmlidLookup(this.env, this.makeXmlId(idStr));
    if (r === null) {
      if (raiseIfNotFound) throw new Error(`External ID not found in the system: ${this.makeXmlId(idStr)}`);
      return [false, false];
    }
    return r;
  }

  /** `_get_eval_context` (convert.py:49-62): the names data files use. */
  private evalScope(model?: string): Map<string, unknown> {
    const ref = async (x: unknown) => this.idGet(String(x));
    const datetime = new PyDatetimeClass(this.env);
    const scope = new DataEvalScope([
      ["Command", new PyCommand()],
      ["time", new PyTimeModule(this.env)],
      ["DateTime", datetime],
      ["datetime", datetime],
      ["timedelta", PyTimedelta.make],
      ["relativedelta", PyRelativedelta.make],
      ["version", "20.0"],
      ["ref", ref],
      ["pytz", new PyUnported("pytz")],
    ]);
    if (model) scope.set("obj", () => new PyModel(new PyEnv(ref, this.env)));
    return scope;
  }

  private async pyEval(src: string, model?: string): Promise<unknown> {
    const v = await evalExprAsync(src, this.evalScope(model));
    // a datetime is a record field's value (tagRecord converts it for the field), nowhere else
    return v instanceof PyDataDatetime ? v : plain(v);
  }

  /** `get_env` (convert.py:238-252). */
  private async getEnv(node: Element): Promise<Environment> {
    const uid = node.attrib.get("uid");
    const context = node.attrib.get("context");
    if (uid) throw new NotPorted("data file node with uid=");
    if (context) {
      const ctx = await this.pyEval(context);
      return this.env.withContext({ ...this.env.context, ...(ctx as Record<string, unknown>) });
    }
    return this.env;
  }

  /** `%(xmlid)d` / `%(xmlid)s` references of xml and html field contents (convert.py:111-128). */
  private async process(s: string): Promise<string> {
    const done = new Set<string>();
    for (const m of s.matchAll(/[^%]%\((.*?)\)[ds]/g)) {
      const found = m[0].slice(1);
      if (done.has(found)) continue;
      done.add(found);
      const xid = this.makeXmlId(m[1]!);
      let recordId = this.idref.get(xid);
      if (recordId === undefined) {
        recordId = (await this.idGet(xid)) as number;
        this.idref.set(xid, recordId);
      }
      s = s.replaceAll(found, String(recordId));
    }
    return s.replaceAll("%%", "%");
  }

  /** `_eval_xml` for <field> and <value> nodes (convert.py:82-180). */
  private async evalXml(node: Element, env: Environment): Promise<unknown> {
    if (node.tag !== "field" && node.tag !== "value") throw new NotPorted(`data file <${node.tag}> value`);
    const t = node.attrib.get("type") ?? "char";
    const fModel = node.attrib.get("model");
    const fSearch = node.attrib.get("search");
    if (fSearch) {
      if (!fModel) throw new Error("search without a model");
      const use = node.attrib.get("use") ?? "id";
      const ids = await env.model(fModel).search(parseDomain(await this.pyEval(fSearch)));
      if (use !== "id") throw new NotPorted(`data file search with use="${use}"`);
      const name = node.attrib.get("name");
      if (name && env.reg.model(fModel).fields.get(name)?.type === "many2many") return ids;
      return ids.length ? ids[0] : false;
    }
    const aEval = node.attrib.get("eval");
    if (aEval) return this.pyEval(aEval, fModel);
    if (t === "xml") {
      // _fix_multiple_roots: several real roots are wrapped in <data>
      const real = node.children.filter(isElement);
      let nodes: Node[] = node.children;
      if (real.length > 1) {
        const data = element("data");
        data.children.push(...node.children);
        for (const c of node.children) c.parent = data;
        data.parent = node;
        nodes = [data];
      }
      // "".join(etree.tostring(n) for n in node): the children with their tails, comments and PIs too (lxml iterates
      // them; the field's own text is dropped). arch_prev keeps a view's comments (auth_password_policy res_config_settings_views.xml)
      return '<?xml version="1.0"?>\n' + await this.process(nodes.map((n) => serializeXml(n)).join(""));
    }
    // convert.py:134-135: the children (comments too, with their tails) as lxml's method='html' writes them
    if (t === "html") return this.process(node.children.map((n) => serializeHtml(n)).join(""));
    let data = node.text ?? "";
    const file = node.attrib.get("file");
    if (file) {
      // convert.py:137-147: type bytes is the file's bytes (a binary field takes them as base64 here, as from the
      // RPC layer), base64 (deprecated) their base64, any other type the file's text
      const b64 = this.binaries?.[file];
      if (b64 === undefined) throw new NotPorted(`data file field with file=${file} (not packaged, gen/module_files.py)`);
      if (t === "bytes" || t === "base64") return b64;
      data = new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)));
    }
    switch (t) {
      case "file": throw new NotPorted("data file field of type file");
      case "char": return data;
      case "int": {
        const d = data.trim();
        if (d === "None") return null;
        if (!/^[+-]?\d+$/.test(d)) throw new Error(`invalid literal for int() with base 10: '${d}'`);
        return Number(d);
      }
      case "float": return Number(data.trim());
      case "list": {
        const out: unknown[] = [];
        for (const c of childElements(node, "value")) out.push(await this.evalXml(c, env));
        return out;
      }
      case "tuple": {
        const out: unknown[] = [];
        for (const c of childElements(node, "value")) out.push(await this.evalXml(c, env));
        return pyTuple(out);
      }
      case "bytes": throw new Error("bytes type is only compatible with file data");
      case "base64": throw new Error("base64 type is only compatible with file data");
      default: throw new Error(`Unknown type '${t}'`);
    }
  }

  /** `_tag_delete` (convert.py:269-288). */
  private async tagDelete(rec: Element): Promise<void> {
    const model = rec.attrib.get("model")!;
    let ids: number[] = [];
    const search = rec.attrib.get("search");
    if (search) ids = await this.env.model(model).search(parseDomain(await this.pyEval(search)));
    const id = rec.attrib.get("id");
    if (id) {
      const r = await this.idGet(id, false);
      if (r) ids.push(r);
    }
    if (ids.length) await unlink(this.env, model, [...new Set(ids)]);
  }

  /** `_tag_menuitem` (convert.py:296-355). */
  private async tagMenuitem(rec: Element, parent: number | null = null): Promise<void> {
    const recId = rec.attrib.get("id")!;
    await this.testXmlId(recId);
    const values: Record<string, unknown> = { parent_id: false, active: nodeattr2bool(rec, "active", true) };
    if (rec.attrib.get("sequence")) values["sequence"] = Number.parseInt(rec.attrib.get("sequence")!, 10);
    if (parent !== null) values["parent_id"] = parent;
    else if (rec.attrib.get("parent")) values["parent_id"] = await this.idGet(rec.attrib.get("parent")!);
    else if (rec.attrib.get("web_icon")) values["web_icon"] = rec.attrib.get("web_icon");
    if (rec.attrib.get("name")) values["name"] = rec.attrib.get("name");
    const action = rec.attrib.get("action");
    if (action) {
      const xid = action.includes(".") ? action : `${this.module}.${action}`;
      const ref = await xmlidLookup(this.env, xid);
      if (ref === null) throw new Error(`External ID not found in the system: ${xid}`);
      const act = (await this.env.cr.query<{ type: string; name: string | null }>(
        "SELECT type, name->>'en_US' AS name FROM ir_actions WHERE id = $1", [ref[1]])).rows[0];
      if (!act) throw new Error(`Record does not exist or has been deleted: ${xid}`);
      values["action"] = `${act.type},${ref[1]}`;
      if (!values["name"] && /(act_window|wizard|url|client|server)$/.test(act.type) && act.name) values["name"] = act.name;
    }
    if (!values["name"]) values["name"] = recId || "?";
    const groups: unknown[] = [];
    for (const g of (rec.attrib.get("groups") ?? "").split(",")) {
      if (g.startsWith("-")) groups.push(pyTuple([3, await this.idGet(g.slice(1)), 0]));
      else if (g) groups.push(pyTuple([4, await this.idGet(g), 0]));
    }
    if (groups.length) values["group_ids"] = groups;
    const [menu] = await loadRecords(this.env, "ir.ui.menu", [{ xml_id: this.makeXmlId(recId), values, noupdate: this.noupdate }], this.mode === "update");
    for (const child of childElements(rec, "menuitem")) await this.tagMenuitem(child, menu!);
  }

  /** `_tag_record` (convert.py:357-489). */
  async tagRecord(rec: Element, extraVals: Record<string, unknown> | null = null): Promise<[string, number] | null> {
    const recModel = rec.attrib.get("model")!;
    let env = await this.getEnv(rec);
    const recId = rec.attrib.get("id") ?? "";
    if (!env.reg.models.has(recModel)) throw new Error(`Model not found: ${recModel}`);
    if (this.xmlFilename && recId) {
      env = env.withContext({ ...env.context, install_mode: true, install_module: this.module, install_filename: this.xmlFilename });
    }
    await this.testXmlId(recId);
    const xid = this.makeXmlId(recId);
    if (this.noupdate && this.mode !== "init") {
      if (!recId) return null;
      const record = await loadXmlid(env, xid);
      if (record) {
        for (const child of descendants(rec).filter((c) => c.tag === "record" && c.attrib.has("id"))) {
          const sub = child.attrib.get("id")!;
          await this.testXmlId(sub);
          const subRecord = await loadXmlid(env, this.makeXmlId(sub));
          if (subRecord) this.idref.set(this.makeXmlId(sub), subRecord[1]);
        }
        this.idref.set(xid, record[1]);
        return null;
      } else if (!nodeattr2bool(rec, "forcecreate", true)) return null;
    }
    let foreignRecordToCreate = false;
    if (xid && xid.split(".")[0] !== this.module) {
      const record = await loadXmlid(this.env, xid);
      if (!record && !(foreignRecordToCreate = nodeattr2bool(rec, "forcecreate"))) {
        if (this.noupdate && !nodeattr2bool(rec, "forcecreate", true)) return null;
        throw new Error(`Cannot update missing record '${xid}'`);
      }
    }
    const def = env.reg.model(recModel);
    const res: Record<string, unknown> = {};
    const subRecords: [Element, string][] = [];
    for (const field of childElements(rec, "field")) {
      const fName = field.attrib.get("name")!;
      if (fName.includes("@")) continue;
      const fdef = def.fields.get(fName);
      let fModel = field.attrib.get("model");
      if (!fModel && fdef?.relation && ["many2one", "one2many", "many2many"].includes(fdef.type)) fModel = fdef.relation;
      const fUse = field.attrib.get("use") || "id";
      let fVal: unknown = false;
      const fSearch = field.attrib.get("search");
      const fRef = field.attrib.get("ref");
      if (fSearch) {
        if (!fModel) throw new Error('Define an attribute model="..." in your .XML file!');
        if (fUse !== "id") throw new NotPorted(`data file search with use="${fUse}"`);
        const ids = await env.model(fModel).search(parseDomain(await this.pyEval(fSearch)));
        if (fdef?.type === "many2many") fVal = [pyTuple([6, 0, ids])];
        else if (ids.length) fVal = ids[0];
      } else if (fRef) {
        if (fdef?.type === "reference") {
          const val = await this.modelIdGet(fRef);
          fVal = `${val[0]},${val[1]}`;
        } else {
          fVal = await this.idGet(fRef, nodeattr2bool(rec, "forcecreate", true));
          if (!fVal) return null; // "Skipping creation ... could not be resolved"
        }
      } else {
        fVal = await this.evalXml(field, env);
        if (fVal instanceof PyDataDatetime) fVal = dataDateFieldValue(fdef, fVal);
        if (fdef) {
          switch (fdef.type) {
            case "many2one": fVal = fVal ? Number.parseInt(String(fVal), 10) : false; break;
            case "integer": fVal = Number.parseInt(String(fVal), 10); break;
            case "float": case "monetary": fVal = Number(fVal); break;
            case "boolean": if (typeof fVal === "string") fVal = str2bool(fVal); break;
            case "one2many":
              for (const child of childElements(field, "record")) subRecords.push([child, fdef.relationField ?? ""]);
              if (typeof fVal === "string") continue;
              break;
            default: break;
          }
        }
      }
      res[fName] = fVal;
    }
    if (extraVals) Object.assign(res, extraVals);
    if (!("sequence" in res) && def.fields.has("sequence")) {
      const sequence = this.nextSequence();
      if (sequence) res["sequence"] = sequence;
    }
    if (!("xmlid" in res) && def.fields.has("xmlid")) res["xmlid"] = xid;
    let model = env;
    if (foreignRecordToCreate) model = env.withContext({ ...env.context, foreign_record_to_create: true });
    const [record] = await loadRecords(model, recModel, [xid ? { xml_id: xid, values: res, noupdate: this.noupdate } : { values: res, noupdate: this.noupdate }], this.mode === "update");
    if (xid) this.idref.set(xid, record!);
    for (const [child, inverse] of subRecords) await this.tagRecord(child, { [inverse]: record });
    return [recModel, record!];
  }

  /** `_tag_template` (convert.py:491-568): the template becomes an ir.ui.view record. */
  private async tagTemplate(el: Element): Promise<void> {
    const tplId = el.attrib.get("id") ?? el.attrib.get("t-name")!;
    const fullTplId = tplId.includes(".") ? tplId : `${this.module}.${tplId}`;
    const attrib = el.attrib;
    if (!attrib.get("inherit_id")) {
      attrib.set("t-name", fullTplId);
      (el as { tag: string }).tag = "t";
    } else (el as { tag: string }).tag = "data";
    attrib.delete("id");
    if (this.module.startsWith("theme_")) throw new NotPorted("theme.ir.ui.view templates");
    const record = element("record", [["id", tplId], ["model", "ir.ui.view"]]);
    for (const att of ["forcecreate", "context"]) {
      if (attrib.has(att)) { record.attrib.set(att, attrib.get(att)!); attrib.delete(att); }
    }
    const field = (name: string, text: string | null, attrs: [string, string][] = []): Element => {
      const f = element("field", [["name", name], ...attrs]);
      f.text = text;
      f.parent = record;
      record.children.push(f);
      return f;
    };
    const pop = (k: string): string | undefined => { const v = attrib.get(k); attrib.delete(k); return v; };
    const name = el.attrib.get("name") ?? tplId;
    field("name", name);
    field("key", fullTplId);
    field("type", "qweb");
    if (attrib.has("track")) field("track", pop("track")!);
    if (attrib.has("priority")) field("priority", pop("priority")!);
    if (attrib.has("inherit_id")) field("inherit_id", null, [["ref", pop("inherit_id")!]]);
    if (attrib.has("technical_usage")) field("technical_usage", pop("technical_usage")!);
    if (attrib.has("website_id")) throw new NotPorted("template website_id");
    if (attrib.has("key")) field("key", pop("key")!);
    const active = pop("active");
    if (active === "True" || active === "False") {
      const viewId = await this.idGet(tplId, false);
      if (this.mode !== "update" || !viewId) field("active", null, [["eval", active]]);
    }
    const customizeShow = pop("customize_show");
    if (customizeShow === "True" || customizeShow === "False") field("customize_show", null, [["eval", customizeShow]]);
    const groups = pop("groups");
    if (groups) field("group_ids", null, [["eval", `[Command.set([${groups.split(",").map((x) => `ref('${x}')`).join(", ")}])]`]]);
    if (pop("primary") === "True") {
      const xp = element("xpath", [["expr", "."], ["position", "attributes"]]);
      const at = element("attribute", [["name", "t-name"]]);
      at.text = fullTplId;
      at.parent = xp;
      xp.children.push(at);
      xp.parent = el;
      el.children.push(xp);
      field("mode", "primary");
    }
    const arch = field("arch", null, [["type", "xml"]]);
    if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1);
    el.parent = arch;
    arch.children.push(el);
    await this.tagRecord(record);
  }

  /** `_tag_function` (convert.py:290-294) -> `_eval_xml` of a function node (:182-221). */
  async tagFunction(rec: Element): Promise<void> {
    let env = await this.getEnv(rec);
    const model = rec.attrib.get("model") ?? "";
    const name = rec.attrib.get("name") ?? "";
    if (name.includes("__") || ["env", "pool", "id", "ids"].includes(name)) throw new Error(`Access to forbidden name '${name}'`);
    let args: unknown[] = [];
    const kwargs: Record<string, unknown> = {};
    const aEval = rec.attrib.get("eval");
    if (aEval) args = [...(await this.pyEval(aEval, model) as unknown[])];
    for (const child of rec.children) {
      if (!isElement(child)) continue;
      if (child.tag === "value" && child.attrib.get("name")) kwargs[child.attrib.get("name")!] = await this.evalXml(child, env);
      else args.push(await this.evalXml(child, env));
    }
    if ("context" in kwargs) {
      env = env.withContext({ ...env.context, ...(kwargs["context"] as Record<string, unknown>) });
      delete kwargs["context"];
    }
    const own = DATA_FUNCTIONS.get(`${model}::${name}`);
    const called = own ?? (() => {
      const m = lookupMethod(model, name);
      return m && { apiModel: m.apiModel, fn: (e: Environment, ids: number[], a: unknown[], kw: Record<string, unknown>) => m.fn(e, m.apiModel ? null : ids, a, kw, model) };
    })();
    if (!called) throw new NotPorted(`data file <function> ${model}.${name}`);
    let ids: number[] = [];
    if (!called.apiModel) {
      const first = args.shift();
      ids = (Array.isArray(first) ? first : [first]).filter((x): x is number => typeof x === "number" && x !== 0);
    }
    await called.fn(env, ids, args, kwargs);
  }

  /** `_tag_root` (convert.py:620-651). */
  async tagRoot(el: Element): Promise<void> {
    for (const rec of [...el.children]) {
      if (!isElement(rec)) continue;
      const tag = rec.tag;
      if (!["record", "delete", "function", "menuitem", "template", "asset", "odoo", "data", "openerp"].includes(tag)) continue;
      this.envs.push(await this.getEnv(el));
      this.noupdates.push(nodeattr2bool(el, "noupdate", this.noupdate));
      this.sequences.push(nodeattr2bool(el, "auto_sequence", false) ? 0 : null);
      try {
        switch (tag) {
          case "record": await this.tagRecord(rec); break;
          case "delete": await this.tagDelete(rec); break;
          case "menuitem": await this.tagMenuitem(rec); break;
          case "template": await this.tagTemplate(rec); break;
          case "function":
            if (!(this.noupdate && this.mode !== "init")) await this.tagFunction(rec);
            break;
          case "asset": throw new NotPorted("data file <asset> (the Worker's asset bundles are precompiled)");
          default: await this.tagRoot(rec);
        }
      } catch (e) {
        if (e instanceof NotPorted || e instanceof UserError) throw e;
        // convert.py:633-640: a ValidationError becomes a ParseError with the record's line and the view error context
        if (e instanceof ValidationError) {
          const context = e instanceof ViewValidationError ? pformatDict(e.context) : "'-no context-'";
          throw new ParseError(`while parsing ${this.xmlFilename}:${rec.sourceline ?? "None"}\n${e.message}\n\nView error context:\n${context}\n`);
        }
        throw new ParseError(`while parsing ${this.xmlFilename}, somewhere inside\n${serializeXml(rec, { withTail: false })}\n${e instanceof Error ? e.message : String(e)}`, e);
      } finally {
        this.noupdates.pop();
        this.envs.pop();
        this.sequences.pop();
      }
    }
  }

  async parse(root: Element): Promise<void> {
    if (!["odoo", "data", "openerp"].includes(root.tag)) throw new Error("Root xml tag must be <openerp>, <odoo> or <data>.");
    await this.tagRoot(root);
  }
}

/** `odoo.tools.convert.ParseError` (convert.py:45): the import's error prints the dotted class (import_module.ts). */
export class ParseError extends Error {
  /** The error the parse error wraps (convert.py:641-643 `raise ParseError(...) from e`). */
  readonly wrapped: unknown;
  constructor(message: string, wrapped: unknown = null) { super(message); this.name = "odoo.tools.convert.ParseError"; this.wrapped = wrapped; }
}

function descendants(el: Element): Element[] {
  const out: Element[] = [];
  const walk = (n: Element) => { for (const c of n.children) if (isElement(c)) { out.push(c); walk(c); } };
  walk(el);
  return out;
}

/** `convert_file` (convert.py:692-722) on the file's bytes. */
export async function convertFile(env: Environment, module: string, filename: string, content: Uint8Array, idref: IdRef, mode: ConvertMode, noupdate: boolean, pathname: string,
  binaries?: Readonly<Record<string, string>>): Promise<void> {
  const ext = /\.[^./]*$/.exec(filename)?.[0]?.toLowerCase() ?? "";
  if (ext === ".csv") return convertCsvImport(env, module, pathname, content, mode, noupdate);
  if (ext === ".sql") throw new NotPorted("data file .sql (raw SQL from an imported module)");
  if (ext === ".xml") {
    const text = new TextDecoder().decode(content);
    const root = parseXml(text.replace(/^<\?xml[^>]*\?>/, ""));
    // convert_xml_import (convert.py:792-797): the file must fit import_xml.rng before anything of it is loaded
    await assertImportXml(root);
    return new XmlImport(env, module, idref, mode, noupdate, pathname, binaries).parse(root);
  }
  if (ext === ".js") return;
  throw new Error(`Can't load unknown file type ${filename}.`);
}

/** `convert_csv_import` (convert.py:725-780): `env[model].load(fields, rows)` with the install context. */
async function convertCsvImport(env0: Environment, module: string, fname: string, content: Uint8Array, mode: ConvertMode, noupdate: boolean): Promise<void> {
  const { lang: _lang, ...ctx0 } = env0.context;
  const env = env0.withContext({ ...ctx0, mode, module, install_mode: true, install_module: module, install_filename: fname, noupdate });
  const base = fname.split("/").pop()!.replace(/\.[^.]*$/, "");
  const model = base.split("-")[0]!;
  await loadRows(env, model, new TextDecoder().decode(content), mode, module);
}
