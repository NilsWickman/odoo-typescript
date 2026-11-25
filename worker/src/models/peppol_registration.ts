/**
 * account_peppol's registration wizard (account_peppol/wizard/peppol_registration.py) as far as opening it goes:
 * res_company.py:352-355 `_action_open_peppol_form` creates the wizard of the company and returns its action
 * (:315-333), which the journal dashboard's onboarding button of an unregistered Peppol company carries
 * (account_peppol account_journal.py:70-82). The computes are the wizard's chain from the company to the stored
 * fields (`use_parent_connection_selection`, `peppol_eas`, `peppol_endpoint`). Refused: a French company (`_peppol_is_french_company`, the PDP's 0225).
 */
import { NotPorted } from "../errors";
import { create } from "../orm/create";
import type { Rec } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { preferredRoutingIdentifier } from "./res_partner_erp_write";
import { peppolParent, peppolProxyStateCanSend } from "./settings_computes";
import { defineComputes } from "./tail_util";
import { translate } from "./util";

const MODEL = "peppol.registration";
const idOf = (v: unknown): number | null => (typeof v === "number" && v ? v : null);

async function companyOf(rec: Rec): Promise<number> {
  const c = idOf(await rec.get("company_id"));
  if (c === null) throw new NotPorted("peppol.registration without a company");
  return c;
}

/** :161-165 `_compute_parent_company_id`: `company_id.peppol_parent_company_id or company_id`. */
async function parentOf(env: Environment, company: number): Promise<number> {
  return (await peppolParent(env, company)) ?? company;
}

/** :176-180 `_compute_use_parent_connection_selection` over :167-170 `display_use_parent_connection_selection`. */
async function selectionOf(env: Environment, company: number): Promise<string> {
  const parent = await parentOf(env, company);
  if (parent === company) return "use_self";
  return (await peppolProxyStateCanSend(env, parent)) ? "use_parent" : "use_self";
}

/** :182-194 `_compute_use_parent_connection` and `_compute_selected_company_id`. */
async function selectedOf(env: Environment, rec: Rec): Promise<number> {
  const company = await companyOf(rec);
  const parent = await parentOf(env, company);
  const useParent = parent !== company && (await rec.get("use_parent_connection_selection")) === "use_parent";
  return useParent ? parent : company;
}

/**
 * :110-121 `_compute_peppol_eas_endpoint`: the selected company's partner's routing identifier, else its
 * `_get_preferred_routing_identifier_vals()` (false when it has none, as a Swedish company with only its VAT, whose
 * 9955 is deprecated).
 */
async function easEndpoint(env: Environment, rec: Rec): Promise<{ eas: string | false; endpoint: string | false }> {
  const company = await selectedOf(env, rec);
  const r = (await env.cr.query<{ p: number; s: string | null; e: string | null; fiscal: string | null }>(
    `SELECT p.id AS p, p.routing_scheme AS s, p.routing_endpoint AS e, fc.code AS fiscal
       FROM res_company c JOIN res_partner p ON p.id = c.partner_id
  LEFT JOIN res_country fc ON fc.id = c.account_fiscal_country_id
      WHERE c.id = $1`, [company])).rows[0];
  if (!r) throw new NotPorted(`peppol.registration of the missing company ${company}`);
  // res_company.py:145-150 `_peppol_is_french_company`
  if (["FR", "GP", "MQ", "RE"].includes(String(r.fiscal)) || ["0225", "0009", "9957", "0002"].includes(String(r.s))) {
    throw new NotPorted("peppol.registration of a French company (l10n_fr_pdp's 0225)");
  }
  // account_edi_ubl_cii res_partner.py:157-163 `_compute_routing_identifier`
  if (r.s && r.e) return { eas: r.s, endpoint: r.e };
  const partner = await (await rec.rel("selected_company_id"))?.rel("partner_id");
  if (!partner || partner.id !== r.p) throw new NotPorted("peppol.registration whose selected company is not the computed one");
  const preferred = await preferredRoutingIdentifier(partner);
  return preferred ? { eas: preferred.scheme, endpoint: preferred.value } : { eas: false, endpoint: false };
}

defineComputes(MODEL, {
  parent_company_id: async (env, rec) => parentOf(env, await companyOf(rec)),
  display_use_parent_connection_selection: async (env, rec) => {
    const company = await companyOf(rec);
    return (await parentOf(env, company)) !== company;
  },
  use_parent_connection_selection: async (env, rec) => selectionOf(env, await companyOf(rec)),
  use_parent_connection: async (env, rec) => {
    const company = await companyOf(rec);
    return (await parentOf(env, company)) !== company && (await rec.get("use_parent_connection_selection")) === "use_parent";
  },
  selected_company_id: async (env, rec) => selectedOf(env, rec),
  peppol_eas: async (env, rec) => (await easEndpoint(env, rec)).eas,
  peppol_endpoint: async (env, rec) => (await easEndpoint(env, rec)).endpoint,
  // :123-129 `_compute_peppol_identifier`
  peppol_identifier: async (_env, rec) => {
    const eas = await rec.get("peppol_eas");
    const endpoint = await rec.get("peppol_endpoint");
    return eas && endpoint ? `${String(eas)}:${String(endpoint)}` : false;
  },
});

/** peppol_registration.py:315-333 `_action_open_peppol_form` of the wizard `resId` (false: of the empty recordset). */
export function peppolFormAction(env: Environment, resId: number | false, reopen = true): Record<string, unknown> {
  const action: Record<string, unknown> = {
    name: translate(env, "Activate Electronic Invoicing (via Peppol)", "account_peppol"),
    type: "ir.actions.act_window",
    view_mode: "form",
    views: [[false, "form"]],
    res_model: MODEL,
    target: "new",
    context: { dialog_size: "medium", ...env.context },
  };
  if (reopen) action["res_id"] = resId;
  return action;
}

/** res_company.py:352-355 `_action_open_peppol_form`: a new wizard of the company, opened. */
export async function openCompanyPeppolForm(env: Environment, company: number): Promise<Record<string, unknown>> {
  const [wizard] = await create(env, MODEL, [{ company_id: company }]);
  return peppolFormAction(env, wizard!);
}
