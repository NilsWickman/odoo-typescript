/**
 * `BaseModel._check_company` (odoo/odoo/orm/models.py:3351-3439), called by create (:4232) and write (:3989) of the
 * models with `_check_company_auto`, with the `_check_company_domain` variants (models.py:3339-3349, :162-196, base
 * res_users.py:181-185). The per-model metadata is generated from the registry by gen/check_company.py.
 */
import { NotPorted, UserError } from "../errors";
import { pyStrRepr } from "../models/util";
import { templateKey, templateOf, type TemplateInfo } from "./template";
import { withOverlay } from "./overlay";
import { ModelImpl } from "./model";
import type { Environment, ModelDef } from "./types";

/** The UserError of `_check_company` (a UserError to the client; callers can tell it from the others). */
export class CompanyInconsistencyError extends UserError {}

interface GenCheckCompany {
  readonly auto: boolean;
  readonly regular: readonly string[];
  readonly property: readonly string[];
  readonly domain?: string;
  readonly has_company_id?: boolean;
  readonly has_company_ids?: boolean;
}
type GenCheckCompanies = Readonly<Record<string, GenCheckCompany>>;
const cache = new Map<string, Promise<GenCheckCompanies>>();

async function load(t: TemplateInfo): Promise<GenCheckCompanies> {
  const dir = t.dir;
  if (dir === "poc_erp") return (await withOverlay(t, "check_company.json", { models: (await import("../../gen/out/poc_erp/check_company.json", { with: { type: "json" } })).default.models as unknown as GenCheckCompanies }, "models")).models;
  if (dir === "") return (await import("../../gen/out/check_company.json", { with: { type: "json" } })).default.models as unknown as GenCheckCompanies;
  throw new NotPorted(`gen/out/${dir}/check_company.json is not wired in src/orm/check_company.ts`);
}

async function meta(env: Environment, model: string): Promise<GenCheckCompany | undefined> {
  const t = await templateOf(env.cr);
  let p = cache.get(templateKey(t));
  if (!p) { p = load(t); cache.set(templateKey(t), p); }
  return (await p)[model];
}

/** `_check_company_auto` of the model (models.py:493). */
export async function checkCompanyAuto(env: Environment, model: string): Promise<boolean> {
  return (await meta(env, model))?.auto ?? false;
}

/** The ids of `rec.parent_path.split('/')[:-1]` for the companies (models.py:174-178). */
async function companyParents(env: Environment, companies: readonly number[]): Promise<number[]> {
  if (!companies.length) return [];
  const rows = (await env.cr.query<{ p: string | null }>("SELECT parent_path AS p FROM res_company WHERE id = ANY($1::int[]) ORDER BY id", [[...companies]])).rows;
  return rows.flatMap((r) => (r.p ?? "").split("/").slice(0, -1).map(Number));
}

/**
 * Whether the co-records pass `corecords._check_company_domain(companies)` with active_test=False (models.py:3401-3403,
 * :3412-3414); null when the domain is empty (no check).
 */
async function passes(env: Environment, comodel: ModelDef, ids: readonly number[], companies: readonly number[]): Promise<boolean | null> {
  const m = await meta(env, comodel.name);
  const kind = m?.domain ?? "default";
  // `filtered_domain` with active_test=False reads the field values (company_id may be a related field, no column)
  const values = async (fname: string): Promise<Map<number, number[]>> => {
    const field = comodel.fields.get(fname);
    if (!field) throw new NotPorted(`_check_company_domain on ${comodel.name} without ${fname}`);
    const read = await new ModelImpl(env.sudo().withContext({ ...env.context, active_test: false }), comodel).values([...ids], field);
    const out = new Map<number, number[]>();
    for (const id of ids) {
      const v = read.get(id);
      out.set(id, typeof v === "number" ? (v ? [v] : []) : Array.isArray(v) ? v.map(Number) : []);
    }
    return out;
  };
  const every = (vals: Map<number, number[]>, ok: (cs: number[]) => boolean): boolean => [...vals.values()].every(ok);
  switch (kind) {
    case "default": {
      // models.py:3345-3349 [('company_id', 'in', companies + [False])]
      const allowed = new Set(companies);
      return every(await values("company_id"), (cs) => !cs.length || cs.some((c) => allowed.has(c)));
    }
    case "parent_of": {
      // models.py:162-178 check_company_domain_parent_of
      const allowed = new Set(await companyParents(env, companies));
      return every(await values("company_id"), (cs) => !cs.length || cs.some((c) => allowed.has(c)));
    }
    case "companies_parent_of": {
      // models.py:181-196 check_companies_domain_parent_of: [] (no check) without companies
      if (!companies.length) return null;
      const allowed = new Set(await companyParents(env, companies));
      return every(await values("company_ids"), (cs) => cs.some((c) => allowed.has(c)));
    }
    case "res.users": {
      // base res_users.py:181-185: TRUE without companies, else company_ids in companies
      if (!companies.length) return null;
      const allowed = new Set(companies);
      return every(await values("company_ids"), (cs) => cs.some((c) => allowed.has(c)));
    }
    default:
      throw new NotPorted(`_check_company_domain ${kind} of ${comodel.name}`);
  }
}

async function relIds(env: Environment, def: ModelDef, id: number, name: string): Promise<number[]> {
  const field = def.fields.get(name)!;
  const v = (await new ModelImpl(env.sudo(), def).values([id], field)).get(id);
  if (typeof v === "number") return v ? [v] : [];
  if (Array.isArray(v)) return v.map(Number);
  return [];
}

/** models.py:3351-3439 `_check_company(fnames)`. */
export async function checkCompany(env: Environment, def: ModelDef, ids: readonly number[], fnames: readonly string[] | null): Promise<void> {
  const m = await meta(env, def.name);
  if (!m || !ids.length) return;
  const all = fnames === null || fnames.includes("company_id") || fnames.includes("company_ids");
  const regular = m.regular.filter((n) => all || fnames!.includes(n));
  const property = m.property.filter((n) => all || fnames!.includes(n));
  if (!regular.length && !property.length) return;
  const inconsistencies: [number, string, number[]][] = [];
  for (const id of ids) {
    if (regular.length) {
      let companies: number[] | null = null;
      if (def.name === "res.company") companies = [id];
      else if (def.fields.has("company_id")) companies = await relIds(env, def, id, "company_id");
      else if (def.fields.has("company_ids")) companies = await relIds(env, def, id, "company_ids");
      // :3393-3398 without company_id/company_ids: a warning, and the record is skipped (property fields included)
      if (companies === null) continue;
      for (const name of regular) {
        const co = await relIds(env, def, id, name);
        if (!co.length) continue;
        const comodel = env.reg.model(def.fields.get(name)!.relation!);
        if ((await passes(env, comodel, co, companies)) === false) inconsistencies.push([id, name, co]);
      }
    }
    // :3405-3415 company dependent fields: the value for env.company must be compatible with env.company
    if (property.length) {
      const company = [await env.company()];
      for (const name of property) {
        const co = await relIds(env, def, id, name);
        if (!co.length) continue;
        const comodel = env.reg.model(def.fields.get(name)!.relation!);
        if ((await passes(env, comodel, co, company)) === false) inconsistencies.push([id, name, co]);
      }
    }
  }
  if (!inconsistencies.length) return;
  if (env.lang && env.lang !== "en_US") throw new NotPorted(`_check_company message in ${env.lang}`);
  // :3417-3439
  const lines = ["Uh-oh! You’ve got some company inconsistencies here:"];
  const names = async (model: string, rids: readonly number[]): Promise<string[]> => {
    const dn = await new ModelImpl(env, env.reg.model(model)).displayName(rids);
    return rids.map((r) => dn.get(r) ?? "");
  };
  for (const [id, name, co] of inconsistencies.slice(0, 5)) {
    const field = def.fields.get(name)!;
    const desc = field.string; // ir.model.fields field_description (en_US, refused above otherwise)
    const values = (await names(field.relation!, co)).map(pyStrRepr).join(", ");
    if (def.name === "res.company") {
      const [company] = await names("res.company", [id]);
      lines.push(`- Record is company “${company}” while “${desc}” (${name}: ${values}) belongs to another company.`);
      continue;
    }
    const companyIds = def.fields.has("company_id") ? await relIds(env, def, id, "company_id") : await relIds(env, def, id, "company_ids");
    const companyNames = (await names("res.company", companyIds)).join(", ");
    if (name === "company_id" && field.relation === def.name && co.length === 1 && co[0] === id) {
      lines.push(`- Only a root company can be set on “${(await names(def.name, [id]))[0]}”. Currently set to “${companyNames}”`);
      continue;
    }
    const [record] = await names(def.name, [id]);
    lines.push(`- “${record}” belongs to company “${companyNames}” while “${desc}” (${name}: ${values}) belongs to another company.`);
  }
  lines.push("To avoid a mess, no company crossover is allowed!");
  throw new CompanyInconsistencyError(lines.join("\n"));
}
