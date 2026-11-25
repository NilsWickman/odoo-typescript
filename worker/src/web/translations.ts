/**
 * The translation dialog's RPC methods (odoo/orm/models.py:2821-2994): `get_field_translations` and
 * `update_field_translations` of a field with `translate=True` (rådet runda 13, åtgärd 5; before, both were missing and
 * the dialog of every translated field failed). Term-translated fields (html_translate/xml_translate:
 * `StoredTranslations._get_translation_dictionary`, `.translated`), removing a translation (a falsy value) and the
 * models that override `_update_field_translations` (ir.ui.view, loyalty.reward) refuse.
 */
import { NotPorted, UserError } from "../errors";
import { translateKind } from "../orm/genmeta";
import { guardRequest } from "../orm/override_guard";
import { pySetOrder } from "../orm/pyset";
import { activeLangRows } from "../orm/signaling";
import type { Environment, FieldDef } from "../orm/types";
import { write } from "../orm/write";
import { translate } from "../models/util";
import { envFor, isRecord } from "./common";
import { registerBaseMethod } from "./register";
import { guardAccess } from "./save";
import { withDbErrors } from "../orm/sql_errors";

/** `self.ensure_one()` and the field (`self._fields[field_name]`: a KeyError for an unknown name). */
function one(model: string, ids: number[] | null, def: { fields: ReadonlyMap<string, FieldDef> }, name: unknown, method: string): { id: number; field: FieldDef } {
  if (!ids || ids.length !== 1) throw new NotPorted(`${model}.${method} on ${ids?.length ?? 0} records (ensure_one)`);
  if (typeof name !== "string" || !def.fields.has(name)) throw new NotPorted(`${model}.${method} of the field ${JSON.stringify(name)}`);
  return { id: ids[0]!, field: def.fields.get(name)! };
}

/** res_lang.py:347-352 `get_installed`: the active languages' codes, by name. */
async function installed(env: Environment): Promise<string[]> {
  return (await activeLangRows(env.cr)).map((r) => r.code);
}

// models.py:2953-2994 get_field_translations
registerBaseMethod("get_field_translations", async (env0, ids, args, kwargs0, model) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const def = env.reg.model(model);
  const { id, field } = one(model, ids, def, kwargs["field_name"] ?? args[0], "get_field_translations");
  const langsArg = kwargs["langs"] ?? args[1];
  if (langsArg !== undefined && langsArg !== null && langsArg !== false && !(Array.isArray(langsArg) && langsArg.every((l) => typeof l === "string"))) {
    throw new NotPorted(`${model}.get_field_translations langs ${JSON.stringify(langsArg)}`);
  }
  // `set(langs or [installed])`: iterated in the set's order (PYTHONHASHSEED=0, src/orm/pyset.ts)
  const given = Array.isArray(langsArg) && langsArg.length ? (langsArg as string[]) : await installed(env);
  const langs = pySetOrder(given);
  const kind = await translateKind(env, model, field.name);
  if (field.translate && kind !== "model") throw new NotPorted(`get_field_translations of the term-translated ${model}.${field.name}`);
  if (field.translate && field.related && !field.store) throw new NotPorted(`get_field_translations of the related ${model}.${field.name}`);
  const valueIn = async (lang: string): Promise<unknown> =>
    (await env.withContext({ ...env.context, lang }).model(model).read([id], [field.name]))[0]?.[field.name] ?? false;
  // `val_en` is read first (the field's read access applies even without translations)
  const valEn = await valueIn("en_US");
  const translations: { lang: string; source: unknown; value: unknown }[] = [];
  if (field.translate) for (const lang of langs) translations.push({ lang, source: valEn, value: await valueIn(lang) });
  return [translations, { translation_type: field.type === "text" || field.type === "html" ? "text" : "char", translation_show_source: false }];
}, { apiModel: false, readonly: true });

// models.py:2821-2951 update_field_translations / _update_field_translations of a `translate=True` field
registerBaseMethod("update_field_translations", async (env0, ids, args, kwargs0, model) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const def = env.reg.model(model);
  const { id, field } = one(model, ids, def, kwargs["field_name"] ?? args[0], "update_field_translations");
  if (model === "ir.ui.view" || model === "loyalty.reward") throw new NotPorted(`${model}._update_field_translations override`);
  const raw = kwargs["translations"] ?? args[1];
  if (!isRecord(raw)) throw new NotPorted(`${model}.update_field_translations translations ${JSON.stringify(raw)}`);
  const sourceLang0 = kwargs["source_lang"] ?? args[2] ?? "";
  if (typeof sourceLang0 !== "string") throw new NotPorted("update_field_translations source_lang");
  const translations: Record<string, unknown> = { ...raw };
  // :2873-2877 `check_access('write')`, `check_field_access(field, 'write')`
  await guardAccess(env, model, "write", [id], { [field.name]: true })();
  const valid = new Set([...(await installed(env)), "en_US"]);
  const sourceLang = sourceLang0 || "en_US";
  const missing = pySetOrder([...new Set([...Object.keys(translations), sourceLang])].filter((l) => !valid.has(l)));
  if (missing.length) {
    throw new UserError(translate(env, "The following languages are not activated: %(missing_names)s").replace("%(missing_names)s", missing.join(", ")));
  }
  if (!field.translate) return false;
  if (!field.store && !field.related && field.compute) return false;
  if (field.related && !field.store) throw new NotPorted(`update_field_translations of the related ${model}.${field.name}`);
  if ((await translateKind(env, model, field.name)) !== "model") throw new NotPorted(`update_field_translations of the term-translated ${model}.${field.name}`);
  // :2909-2916 falsy values (except '') void a translation; anything else must be a str
  if (Object.values(translations).some((t) => t && typeof t !== "string")) {
    throw new UserError(translate(env, "Translations for model translated fields only accept falsy values and str"));
  }
  const valueEn = "en_US" in translations ? translations["en_US"] : true;
  if (!valueEn && valueEn !== "") delete translations["en_US"];
  if (!Object.keys(translations).length) return false;
  if (Object.values(translations).some((t) => typeof t !== "string")) {
    throw new NotPorted(`update_field_translations removing a translation of ${model}.${field.name} (StoredTranslations)`);
  }
  // :2944 `self[field_name] = translations`: the record's write with the dict, through the model's write overrides
  const vals = { [field.name]: translations };
  await guardRequest(env, model, "write", [id], [vals]);
  await withDbErrors(env, () => write(env, model, [id], vals));
  return true;
}, { apiModel: false });
