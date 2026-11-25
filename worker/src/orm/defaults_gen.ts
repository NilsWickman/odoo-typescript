/**
 * Field defaults generated from the Python source (gen/write_defaults.py -> gen/out[/<template>]/write_defaults.json):
 * constants as they are, the lambdas whose body is one of the patterns below evaluated in the environment, and
 * everything else refused when the field's default is actually requested (never guessed).
 */
import { NotPorted } from "../errors";
import { userInfo } from "./env";
import { withOverlay } from "./overlay";
import { templateKey, templateOf } from "./template";
import type { Environment } from "./types";
import { dbNow, datetimeToString, todayInTz, validTz } from "../models/util";

type GenDefault = { readonly const: unknown } | { readonly expr: string; readonly src: string | null } | { readonly callable: string; readonly src: string | null };
type GenDefaults = Readonly<Record<string, Readonly<Record<string, GenDefault>>>>;

const cache = new Map<string, Promise<GenDefaults>>();

async function load(env: Environment): Promise<GenDefaults> {
  const t = await templateOf(env.cr);
  let p = cache.get(templateKey(t));
  if (!p) {
    if (t.dir === "poc_erp") p = import("../../gen/out/poc_erp/write_defaults.json", { with: { type: "json" } }).then((m) => withOverlay(t, "write_defaults.json", m.default as unknown as GenDefaults, null));
    else if (t.dir === "") p = import("../../gen/out/write_defaults.json", { with: { type: "json" } }).then((m) => m.default as unknown as GenDefaults);
    else throw new NotPorted(`gen/out/${t.dir}/write_defaults.json is not wired in src/orm/defaults_gen.ts`);
    cache.set(templateKey(t), p);
  }
  return p;
}

/** Default methods whose body is `return randint(1, 11)` (checked in the source at these lines). */
const RANDINT_1_11 = new Set([
  "odoo/addons/analytic/models/analytic_plan.py:18", "odoo/addons/calendar/models/calendar_event_type.py:13",
  "odoo/addons/calendar/models/calendar_user.py:11", "odoo/addons/crm/models/crm_lead_scoring_frequency.py:22",
  "odoo/addons/sales_team/models/crm_tag.py:12", "odoo/addons/sales_team/models/crm_team.py:16",
  "odoo/addons/product/models/product_attribute_value.py:16", "odoo/addons/product/models/product_template_attribute_value.py:19",
  "odoo/addons/project/models/project_role.py:10", "odoo/addons/project/models/project_tags.py:16",
  "odoo/addons/resource/models/resource_resource.py:31", "odoo/odoo/addons/base/models/res_partner.py:233",
]);

/** Python `random.randint(lo, hi)`. */
function randint(lo: number, hi: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return lo + (buf[0]! % (hi - lo + 1));
}

/** Whether the generated metadata knows the model (its absence means the template was not generated). */
export async function hasGeneratedDefaults(env: Environment, model: string): Promise<boolean> {
  return model in (await load(env));
}

/** Whether the field has a generated default. */
export async function hasGeneratedDefault(env: Environment, model: string, field: string): Promise<boolean> {
  return (await load(env))[model]?.[field] !== undefined;
}

async function refId(env: Environment, xmlid: string): Promise<number> {
  const id = await env.reg.xmlid(env.cr, xmlid);
  if (id === null) throw new NotPorted(`default env.ref('${xmlid}') of a missing record`);
  return id;
}

/** `fields.Date.context_today(self)` (fields_temporal.py:141): today in the context or user time zone. */
async function contextToday(env: Environment): Promise<string> {
  const user = await userInfo(env);
  const tz = validTz(typeof env.context.tz === "string" ? env.context.tz : null) ?? validTz(user.tz) ?? "UTC";
  return todayInTz(await dbNow(env), tz);
}

/** The value of a generated default, or `undefined` when the field has none. */
export async function generatedDefault(env: Environment, model: string, field: string): Promise<unknown> {
  const d = (await load(env))[model]?.[field];
  if (d === undefined) return undefined;
  if ("const" in d) return d.const;
  const where = `${model}.${field}`;
  if ("callable" in d) {
    if (d.src && RANDINT_1_11.has(d.src)) return randint(1, 11);
    switch (d.callable.split(".").pop()) {
      case "now": return datetimeToString(await dbNow(env)); // fields_temporal.py Datetime.now, without microseconds
      case "context_today": return contextToday(env);
    }
    throw new NotPorted(`default ${d.callable} of ${where} (${d.src ?? "?"})`);
  }
  const e = d.expr;
  switch (e) {
    case "self.env.company": case "self.env.company.id": return env.company();
    case "self.env.company.ids": return [await env.company()];
    case "self.env.user.ids": return [env.uid];
    case "self.env.user": case "self.env.uid": return env.uid;
    case "self.env.context.get('user_id', self.env.user.id)": return env.context["user_id"] ?? env.uid;
    case "self.env.user.partner_id": return (await userInfo(env)).partnerId;
    case "fields.Datetime.now()": return datetimeToString(await dbNow(env));
    case "fields.Datetime.now() - timedelta(seconds=1)": return datetimeToString(new Date((await dbNow(env)).getTime() - 1000));
    case "str(uuid.uuid4())": return crypto.randomUUID(); // random by design (harness N6)
    case "uuid.uuid4().hex": return crypto.randomUUID().replace(/-/g, "");
    case "fields.Date.context_today(self)": return contextToday(env);
    // fields_temporal.py Date.today: `date.today()` in the server process, whose zone is UTC (odoo/_monkeypatches/__init__.py:57)
    case "fields.Date.today()": return todayInTz(await dbNow(env), "UTC");
    case "self.env.context.get('active_id')": case 'self.env.context.get("active_id")': return env.context["active_id"] ?? null;
  }
  // `_('text')` / `self.env._('text')`: the source string in en_US (odoo/tools/translate.py)
  let m = /^(?:self\.env\._|_)\(\s*(['"])((?:(?!\1).)*)\1\s*\)$/.exec(e);
  if (m) {
    if (env.lang && env.lang !== "en_US") throw new NotPorted(`translated default ${e} of ${where} (${env.lang})`);
    return m[2];
  }
  // `len(self._fields['f']._description_selection(self.env))`: the number of options of a static selection
  m = /^len\(self\._fields\[['"](\w+)['"]\]\._description_selection\(self\.env\)\)$/.exec(e);
  if (m) {
    const f = env.reg.model(model).fields.get(m[1]!);
    if (!f?.selection) throw new NotPorted(`default ${e} of ${where}: callable selection`);
    return f.selection.length;
  }
  m = /^self\.env\.context\.get\((['"])(\w+)\1\)$/.exec(e);
  if (m) return env.context[m[2]!] ?? null;
  m = /^self\.env\.ref\(['"]([\w.]+)['"],\s*raise_if_not_found=False\)$/.exec(e);
  if (m) return (await env.reg.xmlid(env.cr, m[1]!)) ?? false;
  m = /^self\.env\.ref\(['"]([\w.]+)['"]\)(\.id|\.ids)?$/.exec(e);
  if (m) {
    const id = await refId(env, m[1]!);
    return m[2] === ".ids" ? [id] : id;
  }
  // base decimal_precision.py precision_get
  m = /^self\.env\['decimal\.precision'\]\.precision_get\((['"])([^'"]+)\1\)$/.exec(e);
  if (m) return (await env.cr.query<{ digits: number }>("SELECT digits FROM decimal_precision WHERE name = $1", [m[2]])).rows[0]?.digits ?? 2;
  m = /^self\.env\.company\.(\w+) == '(\w+)'$/.exec(e);
  if (m) {
    const column = env.reg.model("res.company").fields.get(m[1]!);
    if (!column?.column) throw new NotPorted(`default ${e} of ${where}`);
    const { rows } = await env.cr.query<{ v: unknown }>(`SELECT "${column.name}" AS v FROM res_company WHERE id = $1`, [await env.company()]);
    return rows[0]?.v === m[2];
  }
  m = /^self\.env\.company\.(\w+)$/.exec(e);
  if (m) {
    const company = await env.company();
    const def = env.reg.model("res.company");
    const f = def.fields.get(m[1]!);
    if (!f) throw new NotPorted(`default ${e} of ${where}`);
    const { ModelImpl } = await import("./model");
    const v = (await new ModelImpl(env.sudo(), def).values([company], f)).get(company);
    if (f.type === "many2one" || f.type === "char" || f.type === "selection" || f.type === "boolean" || f.type === "integer") return v ?? false;
    throw new NotPorted(`default ${e} of ${where} (${f.type})`);
  }
  throw new NotPorted(`default \`${e}\` of ${where} (${d.src ?? "?"})`);
}
