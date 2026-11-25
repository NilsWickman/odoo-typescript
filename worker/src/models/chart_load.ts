/**
 * account chart_template.py:151-182 `try_loading` with its `self._load(template_code, company, install_demo,
 * force_create)` through the private hook: a site's compiled override (l10n_hu_edi template_hu.py:8-12: the company's
 * EDI configuration after a 'hu' load) runs around the hand port's load (src/models/chart_template.ts tryLoading, which
 * keeps try_loading's checks; they run in the hook's super(), before anything the override does after it). The hook
 * sits here, outside the chart loader's files, so the verified chart templates stay verified (compiler/chartverify.py).
 */
import { NotPorted } from "../errors";
import { idsModel, PrivateRecords } from "../orm/private_hooks";
import type { Environment } from "../orm/types";
import { tryLoading } from "./chart_template";
import * as priv from "../orm/dispatch_gen";

const companyOf = (x: unknown): number | null => {
  const ids = x instanceof PrivateRecords && x.model === "res.company" ? x.ids : Array.isArray(x) && idsModel(x) === "res.company" ? x as number[] : null;
  return ids?.length === 1 ? ids[0]! : null;
};

/**
 * The `@template(..., demo=True)` functions of Odoo 20's modules other than account (the hand ports only account's
 * generic ones, src/models/account_demo.ts `demoData`): module -> the template codes they are registered for, null for
 * the generic ones (`_template_register[True][None]`, run for every code). From the addons' source:
 * l10n_account_withholding_tax/demo/demo.py, l10n_<x>/demo/account_demo.py, l10n_cz/models/template_cz.py:40.
 */
const DEMO_TEMPLATES: Readonly<Record<string, readonly (string | null)[]>> = {
  l10n_account_withholding_tax: [null], l10n_ar: [null, "ar_base"], l10n_ar_withholding: ["ar_base", "ar_ri"],
  l10n_bd: ["bd"], l10n_be: ["be"], l10n_br: [null], l10n_cl: [null], l10n_cz: [null], l10n_ec: [null],
  l10n_in: [null, "in"], l10n_in_ewaybill: ["in"], l10n_it: ["it"], l10n_it_edi: ["it"], l10n_pa: [null],
  l10n_pe: [null], l10n_pk: ["pk"], l10n_sa: [null, "sa"], l10n_sa_edi: [null], l10n_us_account: ["us"],
  l10n_uy: [null, "uy"],
};
/** The `parent` of the template codes whose chain reaches a code of DEMO_TEMPLATES (template_ar_ex.py:13, template_ar_ri.py:13, template_be_comp.py:31, template_be_asso.py:31, template_in.py:18). */
const DEMO_PARENT: Readonly<Record<string, string>> = { ar_ex: "ar_base", ar_ri: "ar_ex", be_comp: "be", be_asso: "be", in_sch3: "in" };

/**
 * chart_template.py:830-831 `_get_chart_template_data(template_code, demo=True)` reads the demo functions of
 * `[None] + _get_parent_template(template_code)` from every module in the registry: when one of them is not account's,
 * the demo would lack its records, so the load refuses before it starts. A module counts from 'to install' on (its
 * classes are in the registry while its own data loads; a later one of the same install refuses too).
 */
export async function refuseUnportedDemo(env: Environment, code: string): Promise<void> {
  const chain: (string | null)[] = [null];
  for (let c: string | undefined = code; c; c = DEMO_PARENT[c]) chain.push(c);
  const rows = (await env.cr.query<{ name: string }>(
    "SELECT name FROM ir_module_module WHERE name = ANY($1) AND state IN ('installed', 'to install', 'to upgrade', 'to remove') ORDER BY name",
    [Object.keys(DEMO_TEMPLATES)])).rows;
  for (const { name } of rows) {
    const hit = DEMO_TEMPLATES[name]!.find((c) => chain.includes(c));
    if (hit !== undefined) throw new NotPorted(`the demo data of ${name} for the chart template ${code} (@template(${hit === null ? "" : `'${hit}', `}demo=True))`);
  }
}

export async function tryLoadingHooked(env: Environment, code: string | null, company: number, installDemo = false): Promise<void> {
  // try_loading returns before `_load` without a company, and raises for syscohada/syscebnl; the hand refuses a missing
  // code (`_guess_chart_template`)
  if (!company || !code || code === "syscohada" || code === "syscebnl") return tryLoading(env, code, company, installDemo);
  if (installDemo) await refuseUnportedDemo(env, code);
  await priv.account_chart_template._load.call(env, [], [code, new PrivateRecords("res.company", [company]), installDemo, true], async (e, _ids, args) => {
    if (args[0] !== code || companyOf(args[1]) !== company || args[2] !== installDemo || (args.length > 3 && args[3] !== true)) {
      throw new NotPorted("account.chart.template._load through a compiled super() with other arguments than try_loading's");
    }
    await tryLoading(e, code, company, installDemo);
    return null;
  });
}
