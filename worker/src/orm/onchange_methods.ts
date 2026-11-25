/**
 * The `@api.onchange` methods Odoo applies for a field (models.py:594-627 `_onchange_methods`), per corpus template
 * (gen/onchange_methods.py: gen/out[/<template>]/onchange_methods.json; a site template, its base's plus installed
 * modules, from its overlay's file over its base's, src/orm/overlay.ts), resolved to the port's registrations
 * (src/orm/recompute.ts registerOnchange). A method Odoo has and the port does not raises NotPorted: skipping it
 * would answer the onchange without its effect, a silently wrong form. Methods come in Odoo's order
 * (`inspect.getmembers`, by name, then `change_default`), as `_apply_onchange_methods` runs them (models.py:6494).
 */
import { NotPorted } from "../errors";
import genCorpus from "../../gen/out/onchange_methods.json" with { type: "json" };
import genErp from "../../gen/out/poc_erp/onchange_methods.json" with { type: "json" };
import genErpSe from "../../gen/out/poc_erp_se/onchange_methods.json" with { type: "json" };
import { NewRec, registeredFor, registeredOnchange, type RecordOnchange } from "./recompute";
import { withOverlay } from "./overlay";
import { templateKey, templateOf, type TemplateInfo } from "./template";
import type { Environment } from "./types";

/** The `functools.partial(onchange_default, field)` of a `change_default` field (models.py:614-623). */
export const CHANGE_DEFAULT = "<change_default>";

interface GenModel {
  readonly fields: Record<string, string[]>;
  readonly methods: Record<string, { fields: string[]; source: string | null }>;
  readonly onchange_override?: string[];
}
type GenFile = { readonly models: Record<string, GenModel> };

const BY_TEMPLATE: Record<string, GenFile> = { poc_corpus: genCorpus, poc_erp: genErp, poc_erp_se: genErpSe };

const OVERLAID = new Map<string, Promise<GenFile>>();

/** The generated file of a template: its own, or for a site (`overlay` over a base above) the overlay's models over the base's. */
async function genOf(template: TemplateInfo): Promise<GenFile | undefined> {
  const own = BY_TEMPLATE[template.name];
  if (own) return own;
  const base = template.overlay ? BY_TEMPLATE[template.dir] : undefined;
  if (!base) return undefined;
  let p = OVERLAID.get(templateKey(template));
  if (!p) {
    p = withOverlay(template, "onchange_methods.json", base, "models");
    OVERLAID.set(templateKey(template), p);
  }
  return p;
}

/** The generated methods of a template. */
export async function generatedOnchanges(template: TemplateInfo): Promise<Record<string, GenModel> | undefined> {
  return (await genOf(template))?.models;
}

/**
 * A model whose Python class overrides `onchange` itself (sale, purchase, account, ...): the generic onchange is
 * only right through the port's own registration of that override, which calls src/web/onchange.ts onchangeCall.
 */
export async function refuseUnportedOnchangeOverride(env: Environment, model: string): Promise<void> {
  const template = await templateOf(env.cr);
  const over = (await genOf(template))?.models[model]?.onchange_override;
  if (over?.length) throw new NotPorted(`onchange override of ${model} (${over.join(", ")})`);
}

export interface OnchangeStep { readonly name: string; readonly fn: RecordOnchange }

/** The methods `_apply_onchange_methods(field)` runs on `model`, as port implementations; refuses an unported one. */
export async function onchangeSteps(env: Environment, model: string, field: string): Promise<OnchangeStep[]> {
  const template = await templateOf(env.cr);
  const gen = await genOf(template);
  if (gen === undefined) throw new NotPorted(`onchange methods of template ${template.name} (gen/onchange_methods.py)`);
  const names = gen.models[model]?.fields[field] ?? [];
  const out: OnchangeStep[] = [];
  for (const name of names) {
    if (name === CHANGE_DEFAULT) { out.push({ name, fn: changeDefault(field) }); continue; }
    const fn = registeredOnchange(model, name);
    if (fn === undefined) {
      const src = gen.models[model]?.methods[name]?.source;
      throw new NotPorted(`onchange method ${model}.${name}${src ? ` (${src})` : ""}`);
    }
    out.push({ name, fn });
  }
  // port registrations that are no onchange method of the model in any template: other mechanisms run at the same
  // point (sale.order.line `onchange` applying `_inverse_label`, sale_order_line.py:1753-1780; a line compute
  // triggered by its move's fields), after Odoo's methods
  // (a site's own methods, compiled and registered, are in its list above: not again)
  for (const r of registeredFor(model, field)) {
    if (!ANY_TEMPLATE.get(model)?.has(r.name) && !gen.models[model]?.methods[r.name]) out.push({ name: r.name, fn: r.fn });
  }
  return out;
}

/** Per model, the onchange method names of every template. */
const ANY_TEMPLATE = new Map<string, Set<string>>();
for (const gen of Object.values(BY_TEMPLATE)) {
  for (const [model, m] of Object.entries(gen.models)) {
    const set = ANY_TEMPLATE.get(model) ?? new Set<string>();
    for (const name of Object.keys(m.methods)) set.add(name);
    ANY_TEMPLATE.set(model, set);
  }
}

/** Whether `name` is an `@api.onchange` method of `model` in some template (the consistency test). */
export function isOdooOnchange(model: string, name: string): boolean {
  return ANY_TEMPLATE.get(model)?.has(name) ?? false;
}

const CHANGE_DEFAULT_FNS = new Map<string, RecordOnchange>();

/**
 * models.py:615-619 `onchange_default`: the `ir.default` values whose condition is `"<field>=<write value>"` are
 * assigned on the record (`self.update(defaults)`). Without such a default (every template here) it changes nothing;
 * a matching one is refused, as the update of the record from it is not ported.
 */
function changeDefault(field: string): RecordOnchange {
  let fn = CHANGE_DEFAULT_FNS.get(field);
  if (fn) return fn;
  fn = async (env, rec) => {
    const def = rec.def;
    const f = def.fields.get(field)!;
    const v = await rec.get(field);
    let written: string;
    // fields.py convert_to_write, printed with "%s" (models.py:617)
    if (v === null || v === undefined || v === false) written = "False";
    else if (v instanceof NewRec) throw new NotPorted(`change_default of ${def.name}.${field} on a new record value`);
    else if (f.type === "many2one" && typeof v === "number") written = String(v);
    else if ((f.type === "selection" || f.type === "char") && typeof v === "string") written = v;
    else if (f.type === "integer" && typeof v === "number") written = String(v);
    else throw new NotPorted(`change_default of ${def.name}.${field} (${f.type})`);
    const company = await env.company();
    // ir_default.py:174-200 `_get_model_defaults(model, condition)`
    const rows = (await env.cr.query<{ name: string }>(
      `SELECT f.name FROM ir_default d JOIN ir_model_fields f ON d.field_id = f.id
       WHERE f.model = $1 AND (d.user_id IS NULL OR d.user_id = $2) AND (d.company_id IS NULL OR d.company_id = $3)
         AND d.condition = $4 LIMIT 1`, [def.name, env.uid, company || null, `${field}=${written}`])).rows;
    if (rows.length) throw new NotPorted(`conditional ir.default on ${def.name} (change_default of ${field})`);
  };
  CHANGE_DEFAULT_FNS.set(field, fn);
  return fn;
}
