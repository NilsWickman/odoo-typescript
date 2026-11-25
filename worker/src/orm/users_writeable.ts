/**
 * res.users fields declared `user_writeable=True` in the installed modules: base res_users.py:213-249, mail
 * res_users.py:39-51, calendar res_users.py:14, sale_stock res_users.py:9. hr, im_livechat and website_profile add
 * more; none of them is installed in a template the port serves, and with one of them the list refuses (NotPorted).
 */
import { NotPorted } from "../errors";
import type { Environment } from "./types";

export const USERS_USER_WRITEABLE: ReadonlySet<string> = new Set(["api_key_ids", "signature", "company_id", "name", "email", "phone", "image_1920", "lang", "tz",
  "notification_type", "out_of_office_from", "out_of_office_to", "out_of_office_message", "calendar_ids", "property_warehouse_id"]);

/**
 * Refuses when the registry's res.users has fields of a module that declares more `user_writeable` fields than the
 * list knows (hr `km_home_work`, im_livechat `livechat_username`, website_profile `website_description`).
 */
export function usersWriteableKnown(env: Environment): void {
  const fields = env.reg.model("res.users").fields;
  for (const f of ["km_home_work", "livechat_username", "website_description"]) {
    if (fields.has(f)) throw new NotPorted(`user_writeable fields of res.users with the module of ${f} installed`);
  }
}
