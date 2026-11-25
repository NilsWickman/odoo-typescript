/** res.partner display_name and avatar computes, base/models/res_partner.py:439, 469, 1151. */
import { NotPorted } from "../errors";
import { inOrder } from "../in_order";
import { registerHooks } from "../orm/hooks";
import type { Environment } from "../orm/types";
import { attachmentValues } from "./binary";
import { partnerAvatar } from "./avatar";
import { displayAddresses } from "./mail_address";

async function displayNames(env: Environment, ids: readonly number[]): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  const rows = await env.cr.query<{
    id: number; name: string | null; parent_id: number | null; parent_name: string | null; is_company: boolean;
    commercial_company_name: string | null; type: string; email: string | null; vat: string | null;
    cvat: string | null; cids: unknown;
  }>(`SELECT p.id,p.name,p.parent_id,pp.name AS parent_name,p.is_company,p.commercial_company_name,p.type,p.email,p.vat,
      cp.vat AS cvat, cp.additional_identifiers AS cids
      FROM res_partner p LEFT JOIN res_partner pp ON pp.id=p.parent_id LEFT JOIN res_partner cp ON cp.id=p.commercial_partner_id
      WHERE p.id=ANY($1::int[])`, [ids]);
  const labels = new Map(env.reg.model("res.partner").fields.get("type")?.selection?.map(s => [s.value, s.labels[env.lang ?? "en_US"] ?? s.label]));
  const addresses = env.context["show_address"] && !env.context["formatted_display_name"] ? await displayAddresses(env, ids, true, "\n") : null;
  for (const p of rows.rows) {
    let name = p.name ?? "";
    const ctx = env.context;
    if (ctx["display_email"]) {
      // mail discuss/res_partner.py:32-40
      const shown = p.name || "False";
      result.set(p.id, shown + (p.email ? (ctx["formatted_display_name"] ? ` --(${p.email})--` : ` (${p.email})`) : ""));
      continue;
    }
    if (ctx["formatted_display_name"]) {
      if (p.parent_id) name = `${p.parent_name} \t --${name || labels.get(p.type) || ""}--`;
      if (ctx["show_email"] && p.email) name += ` \t --${p.email}--`;
      else if (ctx["partner_show_db_id"]) name += ` \t --${p.id}--`;
    } else {
      if (p.parent_id) {
        if (!name && ["invoice", "delivery", "other"].includes(p.type)) name = labels.get(p.type) ?? "";
        if (!p.is_company && !ctx["partner_display_name_hide_company"]) name = `${p.commercial_company_name || p.parent_name}, ${name}`;
      }
      name = name.trim();
      if (ctx["partner_show_db_id"]) name += ` (${p.id})`;
      if (ctx["show_email"] && p.email) name += ` <${p.email}>`;
      // :1171-1172 `partner.address`: _display_address(without_name=True) (res_partner.py:586-592)
      if (ctx["show_address"]) name = `${name}\n${addresses?.get(p.id) || ""}`;
      // res_partner.py:1174-1180: `partner.vat or _get_preferred_legal_entity_identifier_vals().get('value')`
      if (ctx["show_identifier"]) {
        let identifier = p.vat;
        if (!identifier) {
          const extra = p.cids && typeof p.cids === "object" && Object.keys(p.cids as object).length > 0;
          if (p.cvat || extra) throw new NotPorted("partner display_name show_identifier from the commercial partner's identifiers");
        }
        if (identifier) name = ctx["show_address"] ? `${name} \n ${identifier}` : `${name} - ${identifier}`;
      }
    }
    result.set(p.id, name.replace(/\s+\n/g, "\n").trim());
  }
  return result;
}

registerHooks("res.partner", {
  // res_partner.py:938-941 `_compute_has_vat` (compute_sudo): `vat and vat not in ('/', 'na', 'NA')`
  computed: {
    has_vat: async (env: Environment, ids: readonly number[]) => new Map((await env.cr.query<{ id: number; vat: string | null }>(
      "SELECT id, vat FROM res_partner WHERE id = ANY($1::int[])", [ids])).rows.map((r) => [r.id, !!r.vat && !["/", "na", "NA"].includes(r.vat)])),
  },
});

registerHooks("res.partner", {
  // mail_thread.py:164 and fields_relational.py:982 append the reference discriminator.
  descriptionDomain: { message_ids: async () => "([('message_type', '!=', 'user_notification')]) + ([('model', '=', 'res.partner')])" },
  displayName: displayNames,
  selection: { lang: async env => (await env.cr.query<{code: string; name: string}>("SELECT code,name FROM res_lang WHERE active ORDER BY name")).rows.map(r => [r.code,r.name]) },
  computed: Object.fromEntries([128,256,512,1024,1920].map(size => [`avatar_${size}`, async (env: Environment, ids: readonly number[]) => {
    // the image and the partner's own fields are two independent reads, sent together in this order (C2d)
    const [images, rows] = await inOrder([attachmentValues(env, "res.partner", `image_${size}`, ids),
      env.cr.query<{id: number; name: string | null; type: string | null; is_company: boolean; create_date: string | null; internal: boolean}>(
      `SELECT p.id,p.name,p.type,p.is_company,p.create_date::text,
       EXISTS(SELECT 1 FROM res_users u WHERE u.partner_id=p.id AND u.active AND NOT u.share) AS internal
       FROM res_partner p WHERE p.id=ANY($1::int[])`, [ids])]);
    const result = new Map<number, unknown>();
    for (const p of rows.rows) {
      const fraction = p.create_date?.split(".")[1] ?? "0";
      result.set(p.id, await partnerAvatar({ id:p.id, name:p.name, type:p.type, isCompany:p.is_company,
        hasInternalUser:p.internal, image:images.get(p.id) ?? null,
        createDateUtc:p.create_date ? new Date(p.create_date.replace(" ","T")+"Z") : null,
        createMicroseconds:Number(fraction.padEnd(6,"0")),
      }));
    }
    return result;
  }])),
});

registerHooks("res.users", {
  displayName: async (env, ids) => {
    // models.py _compute_display_name: the `name` of the partner (no address or company prefix from the context)
    const rows = await env.cr.query<{id:number; name:string|null}>("SELECT u.id,p.name FROM res_users u JOIN res_partner p ON p.id=u.partner_id WHERE u.id=ANY($1::int[])", [ids]);
    return new Map(rows.rows.map(r=>[r.id,r.name ?? ""]));
  },
});
