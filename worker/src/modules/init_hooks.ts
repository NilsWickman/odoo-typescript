/**
 * Modules' `post_init_hook` (loading.py:236-240: after the module's data, demo and translations, before its state is
 * installed), ported one by one. A module whose hook is not here refuses its install, as does any `pre_init_hook`.
 *
 * l10n_gcc_invoice (__init__.py:4-5): `env['res.lang']._activate_and_install_lang('ar_001')` (res_lang.py:203-212):
 * an inactive language is unarchived (res_lang.py:375-384 `action_unarchive`): the ORM write of `active` (res_lang.py
 * :393-429), then `_update_translations` of the installed modules (the new module itself is still 'to install', so
 * not its own terms) and `_load_non_installed_modules_manifest_terms`. account's `_load_module_terms` (account
 * ir_module.py:106-115) delays the chart template translations while the registry loads: they run at `_register_hook`
 * (loading.py:583-590, after every module), `runDelayedAccountTranslator`.
 */
import { NotPorted } from "../errors";
import { activateLangs, loadAccountTranslations, loadManifestTerms } from "../models/lang_install";
import type { Environment } from "../orm/types";
import { type Capture, replayPhase } from "./install";

/** Languages whose account translations wait for `_register_hook`, per cursor (`registry._delayed_account_translator`). */
const DELAYED = new WeakMap<object, string[]>();

/** `_activate_and_install_lang(code)` during a module install (the registry not loaded yet). */
async function activateAndInstallLang(env: Environment, code: string, cap: Capture | null): Promise<void> {
  const lang = (await env.cr.query<{ id: number; active: boolean | null }>("SELECT id, active FROM res_lang WHERE code = $1", [code])).rows;
  if (lang.length !== 1 || lang[0]!.active) return; // `if lang and not lang.active` (a code is unique)
  await activateLangs(env, [lang[0]!.id]);
  // ir_module.py:894-907 `_update_translations([code])` of the installed modules: what Odoo's import wrote is the
  // capture's translation phase named by those modules (gen/install_capture.py), replayed with its runtime checks
  const installed = (await env.cr.query<{ name: string }>("SELECT name FROM ir_module_module WHERE state = 'installed'")).rows.map((r) => r.name);
  const phase = cap?.order.find((p) => p.startsWith("translations:") && p.slice(13).split(",").sort().join() === [...installed].sort().join());
  if (!cap || !phase) throw new NotPorted(`activating ${code} during an install: no captured translation of the installed modules (gen/install_capture.py)`);
  await replayPhase(env, cap, phase);
  // `registry._delayed_account_translator = load_account_translations`: the last call's languages
  if (installed.includes("account")) DELAYED.set(env.cr, [code]);
  await loadManifestTerms(env, code);
}

/**
 * account chart_template.py:46-50 `preserve_existing_tags_on_taxes(env, module)`: the XML ids of the account tags of
 * modules like `module` (the ORM's `like`: `%module%`, its underscores wildcards as in Odoo's SQL) kept on update.
 */
async function preserveExistingTagsOnTaxes(env: Environment, module: string): Promise<void> {
  await env.cr.query("UPDATE ir_model_data SET noupdate = TRUE WHERE model = 'account.account.tag' AND module LIKE $1", [`%${module}%`]);
}

const POST_INIT: Readonly<Record<string, { readonly name: string; readonly run: (env: Environment, cap: Capture | null) => Promise<void> }>> = {
  l10n_gcc_invoice: { name: "_l10n_gcc_invoice_post_init", run: (env, cap) => activateAndInstallLang(env, "ar_001", cap) },
  // l10n_lu __init__.py:6-11
  l10n_lu: { name: "_post_init_hook", run: (env) => preserveExistingTagsOnTaxes(env, "l10n_lu") },
  // payment_demo __init__.py:6-7 `setup_provider(env, "demo")` (src/models/payment_flow.ts)
  payment_demo: { name: "post_init_hook", run: async (env) => (await import("../models/payment_flow")).setupProvider(env, "demo") },
  // payment_custom __init__.py:7-9 `setup_provider(env, "custom", custom_mode=...)` for pay on invoice, then wire transfer
  payment_custom: { name: "post_init_hook", run: async (env) => {
    const { setupProvider } = await import("../models/payment_flow");
    const { withProcessedImages } = await import("../orm/image_write");
    // the copies' related images are stored after both (one flush)
    await withProcessedImages(env, async () => {
      await setupProvider(env, "custom", { custom_mode: "pay_on_invoice" });
      await setupProvider(env, "custom", { custom_mode: "wire_transfer" });
    });
  } },
};

/** loading.py:236-240 `post_init_hook` of `module`, in the load environment (the superuser). */
export async function runPostInit(env: Environment, module: string, hook: string, cap: Capture | null): Promise<void> {
  const h = POST_INIT[module];
  if (!h || h.name !== hook) throw new NotPorted(`install of ${module}: its post_init_hook ${hook} (Python)`);
  await h.run(env, cap);
}

/** account ir_module.py:117-121 `_register_hook`: the delayed account translations of the languages activated. */
export async function runDelayedAccountTranslator(env: Environment): Promise<void> {
  const langs = DELAYED.get(env.cr);
  if (!langs) return;
  DELAYED.delete(env.cr);
  for (const lang of langs) await loadAccountTranslations(env, lang);
}
