/**
 * Entry point of the Odoo hand port on Cloudflare Workers (docs/PHASE1.md section 5).
 * Routes are registered in src/http/router.ts by the controllers; this file only wires the handlers.
 */
import { connect as socketsConnect } from "cloudflare:sockets";
import type { Env } from "./env";
import { Cursor, UnknownDatabase } from "./db";
import { dbFilter, handleRequest, makeDbFilterConfig, werkzeugErrorResponse } from "./http/dispatch";
import { handleDemoRequest, tickDemoPool } from "./demo/router";
import { proof } from "./proof";
import { proofRoute } from "./proof_logic";
import { parseDemoHost } from "./demo/pool_logic";
import { demoConfigFromEnv } from "./do/demo_pool";
import { mirrorFilestores } from "./filestore_mirror";
import corpusModelsPack from "../gen/out/models.pack";
import erpModelsPack from "../gen/out/poc_erp/models.pack";
import { genModelsFile, provideModelPacks } from "./gen_models";
import { setEnvironmentFactory } from "./http/context";
import { processJobs } from "./models/ir_cron";
import { createEnvironment } from "./orm/env";
import { setGenMetadataLoader, type GenMetadata } from "./orm/registry";
import { AccessDenied, NotPorted } from "./errors";
import { provideSocketsConnect } from "./mail/notify";
import "./controllers/h2";
import "./controllers/home";
import "./controllers/session";
import "./controllers/base_setup";
import "./controllers/webclient";
import "./controllers/dataset";
import "./controllers/rpc";
import "./controllers/json2";
import "./controllers/action";
import "./controllers/domain";
import "./controllers/call_button";
import "./controllers/export";
import "./controllers/base_import";
import "./controllers/report";
import "./controllers/portal_invoice";
import "./controllers/payment_portal";
import "./controllers/portal_sale";
import "./controllers/portal_address";
import "./bus/routes";
import "./web/search_read";
import "./web/read";
import "./web/read_group";
import "./web/grouping_sets";
import "./web/progress_bar";
import "./web/search_panel";
import "./web/hierarchy";
import "./web/cldr";
import "./web/name_search";
import "./web/properties";
import "./web/fields_get";
import "./web/get_views";
import "./web/defaults";
import "./web/onchange";
import "./web/save";
import "./web/translations";
import "./models/filters";
import "./models/phone";
import "./models/partner_read";
import "./models/partner_form";
import "./models/partner";
import "./models/mail_thread_search";
import "./models/res_partner_write";
import "./models/mail_template_write";
import "./models/config_write";
import "./models/crm_lead";
import "./models/crm_lead_write";
import "./models/crm_lead_actions";
import "./models/crm_lead_mail";
import "./models/crm_merge";
import "./models/crm_lead_pls";
import "./models/crm_lead_lost_write";
import "./models/crm_team";
import "./models/crm_calendar";
import "./models/crm_activity_plan";
import "./models/crm_iap_enrich";
import "./models/sales_dashboards";
import "./models/sps_menus";
import "./models/onchange_forms";
import "./models/stock_forecast";
import "./models/sale_flow";
import "./models/sale_copy";
import "./models/crm_copy";
import "./models/task_copy";
import "./models/project_copy";
import "./models/project_task_recompute";
import "./models/account_move_copy";
import "./models/res_users_password";
import "./models/res_users_invite";
import "./models/product_onchange";
import "./models/purchase_flow";
import "./models/payment_flow";
import "./models/inventory_flow";
import "./models/stock_inventory";
import "./models/name_create";
import "./models/project_milestone";
import "./models/stock_forecast_report";
import "./models/sale_configurator";
import "./models/sale_invoice";
import "./models/sale_confirm";
import "./models/stock_new";
import "./models/stock_warehouse";
import "./models/config_overrides";
import "./models/sale_warning";
import "./models/account_partner_order";
import "./models/crm_iap_mine";
import "./models/import_templates";
import "./models/crm_config_write";
import "./models/mail_activity_schedule";
import "./models/partner_erp";
import "./models/partner_all_fields";
import "./models/stock_return";
import "./models/partner_erp_new";
import "./models/partner_erp_actions";
import "./models/mail_activity_data";
import "./models/mail_activity_access";
import "./models/quotation_document";
import "./models/ir_attachment_access";
import "./models/ir_attachment_create";
import "./models/res_lang";
import "./models/ir_exports";
import "./models/ir_filters";
import "./models/res_users_prefs";
import "./models/res_users_create";
import "./models/res_users_unlink";
import "./models/base_import";
import "./models/account_computes";
import "./models/account_buttons";
import "./models/server_action_methods";
import "./models/purchase_buttons";
import "./models/purchase_bill";
import "./models/stock_buttons";
import "./models/stock_computes";
import "./models/purchase_computes";
import "./models/payment_computes";
import "./models/crm_utm";
import "./models/res_currency";
import "./models/discuss_computes";
import "./models/mail_canned_computes";
import "./models/product_computes";
import "./models/tail_crm_computes";
import "./models/calendar_computes";
import "./models/project_computes";
import "./models/html_field_history";
import "./models/sale_computes";
import "./models/res_users_computes";
import "./models/rating_computes";
import "./models/project_task_create";
import "./models/group_expand_methods";
import "./models/project_project_create";
import "./models/sale_order_line_name";
import "./models/calendar_methods";
import "./models/calendar_answers";
import "./models/apps_data";
import "./models/record_actions";
import "./models/settings_defaults";
import "./models/settings_computes";
import "./models/res_config_settings_save";
import "./models/ir_model_fields_create";
import "./models/ir_model_create";
import "./models/analytic_line";
import "./mail/composer";
import "./mail/mail_mail_create";
import "./mail/template_send";
import "./mail/post_source";
import "./models/res_groups_hierarchy";
import "./models/ir_module_panel";
import "./models/ir_module_computes";
import "./models/spreadsheet_computes";
import "./models/callable_domains";
import "./models/tail_buttons";
import "./models/account_taxes";
import "./models/invoicing_computes";
import "./models/account_entries";
import "./models/account_payment_register";
import "./models/account_move_ops";
import "./models/account_move_create";
import "./models/account_move_onchange";
import "./models/account_integrity";
import "./models/report_invoice";
import "./models/report_sale";
import "./models/report_stock";
import "./models/document_layout";
import "./models/account_move_send";
import "./models/account_journal_create";
import "./models/stock_quantities";
import "./models/related_selections";
import "./models/display_names";
import "./models/orderpoint_forecast";
import "./modules/ir_ui_view";
import "./modules/import_module";
import "./modules/uninstall";
import "./modules/install";
import "./modules/apps_visible";
import "./modules/upgrade";
import "./models/account_report_create";
import "./models/data_functions";
import "./models/partner_bank_create";
import "./models/bank_statement_create";
import "./models/mail_message_create";
import "./models/ir_ui_menu_icon";
import "./web/read_methods";
import "./mail/bootstrap";
import "./mail/routes";
import "./mail/task_create";
import "./models/lang_install";
import "./models/rpc_data";
import "./models/rpc_misc";
import "./models/sweep_sale_product";
import "./models/sweep_purchase_stock";
import "./models/sweep_account";
import "./models/sweep2_account";
import "./models/sweep_project_crm";
import "./models/sweep_mail_cal_res";
import "./models/sweep2_wizards";
import "./models/sweep2_stock_sale";
import "./models/sweep2_settings";
import { setGenAssets } from "./gen_assets";
import { setTemplateRenderer } from "./controllers/offline";
import { withOverlay } from "./orm/overlay";
import { renderPage } from "./controllers/page";

// the socket module once, when the isolate starts: not at an isolate's first mail (src/mail/notify.ts)
provideSocketsConnect(socketsConnect);
// and the packs of the model metadata, for the same reason (src/gen_models.ts)
provideModelPacks({ "": corpusModelsPack, poc_erp: erpModelsPack });

setEnvironmentFactory((cr, uid, context) => {
  if (uid === null) throw new AccessDenied();
  return createEnvironment({ cr, uid, context, su: uid === 1 });
});
setTemplateRenderer(renderPage);
setGenMetadataLoader(async (template) => {
  // per corpus template (src/orm/template.ts): poc_corpus (S1) in gen/out/, poc_erp (C1) in gen/out/poc_erp/
  let generated: unknown;
  // the file parsed once for this and src/orm/genmeta.ts (src/gen_models.ts), one copy in the bundle (64 MiB Worker limit)
  if (template.dir === "poc_erp") generated = (await withOverlay(template, "models.json", { models: ((await genModelsFile("poc_erp")) as { models: Record<string, unknown> }).models }, "models")).models;
  else if (template.dir === "") generated = ((await genModelsFile("")) as { models: unknown }).models;
  else throw new NotPorted(`gen/out/${template.dir}/models.json is not wired in src/index.ts`);
  return generated as GenMetadata;
});

export { SessionStore } from "./do/session";
export { BusDispatcher } from "./do/bus";
export { FilestoreObject } from "./do/filestore";
export { DemoPool } from "./do/demo_pool";

async function health(request: Request, env: Env, url: URL): Promise<Response> {
  const db = url.searchParams.get("db");
  if (db === null) return new Response("ok", { headers: { "Content-Type": "text/plain" } });
  const host = request.headers.get("host") ?? url.host;
  if (dbFilter([db], makeDbFilterConfig(env, host)).length !== 1) {
    return new Response("Not Found", { status: 404 });
  }
  const cr = new Cursor(env, db);
  try {
    const t0 = performance.now();
    const r = await cr.query<{ n: string; v: string }>(
      "SELECT (SELECT count(*) FROM res_partner)::text AS n, version() AS v",
    );
    const row = r.rows[0];
    await cr.commit();
    return Response.json({ db, partners: Number(row?.n), version: row?.v, ms: Math.round(performance.now() - t0) });
  } finally {
    await cr.close();
  }
}

export default {
  async fetch(request: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    setGenAssets(env.ASSETS);
    try {
      if (url.pathname === "/health") {
        if (env.DEMO_MODE === "1" && url.searchParams.has("db")) return new Response("Not Found", { status: 404 });
        return await health(request, env, url);
      }
      // /proof before the demo router: no lease, login or pool call on the demo (src/proof_logic.ts). On the private
      // site Access lets /proof and everything below it through (an Access path covers its subpaths): nothing else
      // answers there
      const demoHost = env.DEMO_MODE === "1"
        ? parseDemoHost(request.headers.get("host") ?? url.host, demoConfigFromEnv(env)).kind
        : null;
      const proofAnswer = proofRoute(url.pathname, request.method, demoHost);
      if (proofAnswer === "page") return await proof(request, env);
      if (proofAnswer === "not_found") return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
      if (env.DEMO_MODE === "1") return await handleDemoRequest(request, env, exec);
      return await handleRequest(request, env, exec);
    } catch (e) {
      if (e instanceof UnknownDatabase) return new Response(e.message, { status: 404 });
      // werkzeug's InternalServerError page, as Odoo's WSGI layer answers an unhandled error: no cause, no stack
      console.error("Unhandled exception", e);
      return werkzeugErrorResponse(500, null);
    }
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    // Odoo's ir_cron loop (src/models/ir_cron.ts) on the databases named in CRON_DBS only: inert in measured runs, as
    // the oracle's max_cron_threads = 0
    void controller;
    if (env.DEMO_MODE === "1") {
      await tickDemoPool(env);
      return;
    }
    const dbs = String(Reflect.get(env, "CRON_DBS") ?? "").split(",").map((d) => d.trim()).filter(Boolean);
    // one database's failure does not stop the others, nor the files' mirroring (and the mirroring never throws)
    for (const db of dbs) {
      try {
        await processJobs(env, db);
      } catch (e) {
        console.error(`cron ${db}: failed`, e);
      }
    }
    // the written files into odoo_ts_files, for the nightly pg_dump (ACCEPTANCE C3, src/filestore_mirror.ts)
    await mirrorFilestores(env, dbs);
    // not the session store's objects: an object is placed where its first call came from, and Cloudflare runs this
    // handler in any data center (C2f); requests warm them (src/http/dispatch.ts warmDatabaseObjects)
  },
} satisfies ExportedHandler<Env>;
