/**
 * crm.lead `iap_enrich` (odoo/addons/crm_iap_enrich/models/crm_lead.py:107-156, `_process_leads` :50-105) as the
 * oracle runs it: the lead's email domain is sent to IAP through `iap.enrich.api._request_enrich`
 * (iap/models/iap_enrich_api.py:13-40), which first gets or creates the user's `reveal` iap.account
 * (iap/models/iap_account.py:177-223, create :164-175: the account takes the service's name; mail.thread logs
 * "IAP Account created"); the HTTP call then fails (the oracle has no route to iap-services.odoo.com, and the Worker
 * does not call IAP either), `_process_leads` catches it (:95-100) and sends the "danger" `iap_notification` to the
 * user (iap_mail/models/iap_account.py:20-31), and the button answers None. The account survives (Odoo creates it in
 * a separate committed cursor). Leads skipped by `_process_leads` (won, done, without email) change nothing; the
 * branches that post enrichment templates (invalid email, mail provider domains) are not ported.
 */
import { NotPorted, OdooError } from "../errors";
import { requestOfCursor } from "../http/context";
import { registerMethod } from "../http/methods";
import { busSend } from "../mail/busnotify";
import { and, cond, or } from "../orm/domain";
import { create } from "../orm/create";
import { write } from "../orm/write";
import type { Environment } from "../orm/types";
import { envFor } from "../web/common";
import { emailNormalize } from "./partner_pure_write";
import { translate } from "./util";
import { mailProviderDomain } from "./crm_lead_write";

/** iap/tools/iap_tools.py:20-47 `_MAIL_PROVIDERS` (crm_iap_enrich crm_lead.py:72), as in crm_lead_write.ts. */
async function isProviderDomain(domain: string): Promise<boolean> {
  return mailProviderDomain(domain);
}

/** iap.account.get(service_name) for a service whose account does not exist yet (iap_account.py:177-223). */
export async function getAccount(env: Environment, serviceName: string): Promise<number> {
  const companies = await env.companies();
  const domain = and([cond("service_name", "=", serviceName), or([cond("company_ids", "in", [...companies]), cond("company_ids", "=", false)])]);
  const accounts = await env.model("iap.account").search(domain, { order: "id desc" });
  if (accounts.length) {
    const rows = await env.sudo().model("iap.account").read(accounts, ["account_token", "company_ids"], "");
    if (rows.some((r) => !r["account_token"])) throw new NotPorted("iap.account.get with accounts without token");
    const withCompany = rows.find((r) => Array.isArray(r["company_ids"]) && (r["company_ids"] as unknown[]).length);
    return Number((withCompany ?? rows[0])!["id"]);
  }
  const service = await env.model("iap.service").search(cond("technical_name", "=", serviceName), { limit: 1 });
  if (!service.length) throw new NotPorted(`iap service ${serviceName} missing`);
  const [id] = await create(env, "iap.account", [{ service_id: service[0] }]);
  // create (:164-169): an account without name takes the service's
  const name = (await env.model("iap.service").read([service[0]!], ["name"], ""))[0]?.["name"];
  await write(env, "iap.account", [id!], { name: name ?? false });
  return id!;
}

registerMethod("crm.lead", "iap_enrich", async (env0, ids, _args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  if (env.context["cron_id"]) throw new NotPorted("iap_enrich from the cron");
  if (kwargs["batch_size"] !== undefined && kwargs["batch_size"] !== 50) throw new NotPorted("iap_enrich batch_size");
  const leadIds = ids ?? [];
  if (leadIds.length > 50) throw new NotPorted("iap_enrich over several batches");
  // _process_leads (:50-105)
  const rows = await env.model("crm.lead").read(leadIds, ["probability", "iap_enrich_done", "email_from"], "");
  const leadEmails: Record<string, string> = {};
  for (const r of rows) {
    if (Number(r["probability"]) === 100 || r["iap_enrich_done"]) continue;
    if (!r["email_from"]) continue;
    const normalized = emailNormalize(String(r["email_from"]));
    if (!normalized) throw new NotPorted("iap_enrich of a lead with an invalid email (mail_message_lead_enrich_no_email)");
    const domain = normalized.split("@")[1] ?? "";
    if (await isProviderDomain(domain)) throw new NotPorted("iap_enrich of a mail provider domain (mail_message_lead_enrich_notfound)");
    leadEmails[String(r["id"])] = domain;
  }
  if (!Object.keys(leadEmails).length) return null;
  // _request_enrich -> _contact_iap: the account (created when missing, in its own cursor: a failure, e.g. a user
  // without write access on iap.account, leaves nothing behind), then the unreachable endpoint; any exception ends
  // in the same error notification (:95-100)
  await env.cr.query("SAVEPOINT crm_iap_enrich_account");
  try {
    await getAccount(env, "reveal");
    await env.cr.query("RELEASE SAVEPOINT crm_iap_enrich_account");
  } catch (e) {
    if (!(e instanceof OdooError)) throw e;
    await env.cr.query("ROLLBACK TO SAVEPOINT crm_iap_enrich_account");
  }
  const ctx = requestOfCursor(env.cr);
  if (ctx === null) throw new NotPorted("iap notification outside a request");
  await busSend(ctx, env, { model: "res.users", id: env.uid }, "iap_notification",
    { message: translate(env, "An error occurred during lead enrichment"), type: "danger" });
  return null;
}, { apiModel: false });
