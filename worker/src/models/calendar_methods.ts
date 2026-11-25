/** calendar model methods the calendar views call (odoo/addons/calendar/models). */
import { OdooError } from "../errors";
import { registerMethod } from "../http/methods";
import { cond } from "../orm/domain";
import { userInfo } from "../orm/env";
import { envFor } from "../web/common";
import { registerPyMethod } from "../qweb/records";
import { write } from "../orm/write";
import { NotPorted } from "../errors";
import { findPartnerCustomer, getDisplayTimeTz } from "./calendar_invitation";
import { readRecurrences, recurrenceName } from "./calendar_recurrence";

/**
 * calendar res_users.py:62-78 `get_selected_calendars_partner_ids(include_user=True)`: the partners of the user's
 * calendar filters (search order id, `.partner_id.ids` without duplicates), then the env user's partner.
 */
registerMethod("res.users", "get_selected_calendars_partner_ids", async (env0, ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const users = ids ?? [];
  if (users.length !== 1) throw new OdooError("builtins.ValueError", `Expected singleton: res.users(${users.join(", ")}${users.length === 1 ? "," : ""})`);
  const includeUser = "include_user" in kwargs ? kwargs["include_user"] : args.length ? args[0] : true;
  const filters = await env.model("calendar.filters").search(cond("user_id", "=", users[0]));
  const partners: number[] = [];
  if (filters.length) {
    for (const row of await env.model("calendar.filters").read(filters, ["partner_id"], "")) {
      const p = row["partner_id"];
      const pid = typeof p === "number" ? p : Array.isArray(p) ? p[0] as number : null;
      if (pid !== null && !partners.includes(pid)) partners.push(pid);
    }
  }
  if (includeUser) partners.push((await userInfo(env)).partnerId);
  return partners;
}, { apiModel: false, readonly: true });

/**
 * calendar_event.py:748-751 `get_discuss_videocall_location`: a new discuss route with a random token (uuid4 hex)
 * under `get_base_url()` (models.py:3327-3337, web.base.url; website is not installed).
 */
registerMethod("calendar.event", "get_discuss_videocall_location", async (env0, _ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const base = (await env.cr.query<{ value: string }>("SELECT value FROM ir_config_parameter WHERE key = 'web.base.url'")).rows[0]?.value ?? "";
  return `${base}/calendar/join_videocall/${crypto.randomUUID().replace(/-/g, "")}`;
}, { apiModel: true, readonly: true });

// calendar_event.py:1593-1595 `_get_mail_tz`
registerPyMethod("calendar.event", "_get_mail_tz", async (recs) => {
  recs.ensureOne();
  const tz = await recs.field("event_tz");
  if (tz) return tz;
  return (await userInfo(recs.env)).tz ?? false;
});

// calendar_event.py:703-709 `_calendar_event_ensure_token`: a token is written when the event has none
registerPyMethod("calendar.event", "_calendar_event_ensure_token", async (recs) => {
  recs.ensureOne();
  const id = recs.ids[0]!;
  const current = (await recs.env.cr.query<{ t: string | null }>("SELECT access_token AS t FROM calendar_event WHERE id = $1", [id])).rows[0]?.t;
  if (current) return current;
  const token = crypto.randomUUID();
  await write(recs.env.sudo(), "calendar.event", [id], { access_token: token });
  return token;
});

// the methods the calendar mail templates call (calendar/data/mail_template_data.xml), ported in calendar_invitation.ts
registerPyMethod("calendar.event", "find_partner_customer", (recs) => findPartnerCustomer(recs));
registerPyMethod("calendar.event", "get_display_time_tz", (recs, args, kwargs) => getDisplayTimeTz(recs, args, kwargs));
// calendar_recurrence.py:136-196 `get_recurrence_name`
registerPyMethod("calendar.recurrence", "get_recurrence_name", async (recs) => {
  recs.ensureOne();
  const [r] = await readRecurrences(recs.env, [recs.ids[0]!]);
  if (!r) throw new NotPorted("get_recurrence_name of a missing recurrence");
  return recurrenceName(recs.env, r);
});

/**
 * calendar_event.py:106-108 `get_state_selections`: the attendee states of the calendar popover
 * (attendee_calendar_common_popover.js:30), calendar_attendee.py:24-29 `STATE_SELECTION` as it is (no translation).
 */
registerMethod("calendar.event", "get_state_selections", async () => [
  ["accepted", "Yes"], ["declined", "No"], ["tentative", "Maybe"], ["needsAction", "Needs Action"],
], { apiModel: true, readonly: true });
