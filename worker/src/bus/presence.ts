/**
 * `mail.presence` (odoo/addons/mail/models/mail_presence.py) and the bus notifications its create/write send
 * through `Store` (odoo/addons/mail/tools/discuss.py `Store.__init__`, `StoreVersion`). The table itself is
 * presence noise for the harness (dbdiff.EXCLUDED), but `res.users.im_status` is computed from it
 * (odoo/addons/mail/models/res_users.py:130-143), so the rows are written as Odoo writes them.
 */
import type { Cursor } from "../db";
import type { BusValues } from "./bus";

/** mail_presence.py:10-13. */
export const UPDATE_PRESENCE_DELAY = 60;
export const DISCONNECTION_TIMER = UPDATE_PRESENCE_DELAY + 5;
export const AWAY_TIMER = 1800;
export const PRESENCE_OUTDATED_TIMER = 12 * 60 * 60;

export type PresenceStatus = "online" | "away" | "offline";

interface PresenceRow {
  id: number;
  status: PresenceStatus | null;
}

interface UserPresenceInfo {
  manual_im_status: string | null;
  active: boolean;
}

/** `written_fields_by_record` of a store version: model -> record id -> field names (discuss.py:92-96). */
export type WrittenFields = Record<string, Record<string, string[]>>;

/**
 * discuss.py:82-107 `StoreVersion.get_formatted_version`, computed inside the transaction after the write so
 * `pg_current_xact_id_if_assigned()` is set. xid8 values come back as strings from `pg`, as from psycopg2.
 */
export async function storeVersion(cr: Cursor, written: WrittenFields): Promise<Record<string, unknown>> {
  const r = await cr.query<{ snapshot: string; xact: string | null }>(
    "SELECT pg_current_snapshot()::text AS snapshot, pg_current_xact_id_if_assigned()::text AS xact",
  );
  const row = r.rows[0];
  if (row === undefined) throw new Error("pg_current_snapshot returned no row");
  const [xmin, xmax, xips] = row.snapshot.split(":");
  const xipList = (xips ?? "").split(",").filter((x) => x !== "");
  // Odoo's cursors are REPEATABLE READ (odoo/sql_db.py:795 ISOLATION_LEVEL_REPEATABLE_READ): the snapshot is taken by
  // the transaction's first query, before its own xid is assigned (at its first write), so it never "knows" its own
  // transaction (field_version.js knowsTransaction). The port's cursors are READ COMMITTED: the snapshot is the
  // statement's, taken after the xid exists, and a transaction that started after ours but committed before this
  // query pushes xmax past our xid, making the client treat our own writes as already seen (it then skips a later
  // write revision of the same transaction, e.g. the mail send failure of /mail/message/post). Listing our xid as
  // in progress restores the RR property for it.
  if (row.xact !== null && xmin !== undefined && xmax !== undefined) {
    const x = BigInt(row.xact);
    if (x >= BigInt(xmin) && x < BigInt(xmax) && !xipList.includes(row.xact)) {
      xipList.push(row.xact);
      xipList.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
    }
  }
  return {
    snapshot: {
      xmin,
      xmax,
      xip_list: xipList,
      xip_bitmap: "", // Deprecated, always empty (discuss.py:102).
      current_xact_id: row.xact,
    },
    written_fields_by_record: written,
  };
}

/**
 * mail/models/res_users.py:130-143 `_compute_im_status` for one user from its presence row:
 * offline when inactive or the presence is offline/missing, else the manual status, else the presence status.
 */
export function computeImStatus(user: UserPresenceInfo, presence: PresenceStatus | null): string | false {
  if (!user.active) return false;
  if (presence === null || presence === "offline") return "offline";
  return user.manual_im_status ?? presence;
}

/**
 * mail_presence.py:96-111 `_send_presence` for a user presence: two stores, `(user, "presence")` with
 * `im_status` and `user` with `presence_status`, each sent as `mail.record/insert` at construction
 * (discuss.py:231-238). The payload is the store's `as_dict`: `{"res.users": [{"id", <field>}], "__store_version__"}`.
 */
export async function sendPresence(
  cr: Cursor,
  bus: BusValues,
  uid: number,
  presenceStatus: PresenceStatus,
  written: WrittenFields,
  imStatusOverride: PresenceStatus | null = null,
): Promise<void> {
  const u = await cr.query<UserPresenceInfo>("SELECT manual_im_status, active FROM res_users WHERE id = $1", [uid]);
  const user = u.rows[0];
  if (user === undefined) return;
  const version = await storeVersion(cr, written);
  const imStatus = imStatusOverride ?? computeImStatus(user, presenceStatus);
  bus.sendone({ model: "res.users", id: uid, sub: "presence" }, "mail.record/insert", {
    "res.users": [{ id: uid, im_status: imStatus }],
    __store_version__: version,
  });
  bus.sendone({ model: "res.users", id: uid }, "mail.record/insert", {
    "res.users": [{ id: uid, presence_status: imStatusOverride ?? presenceStatus }],
    __store_version__: version,
  });
}

/**
 * mail_presence.py:80-94 `_update_presence` for a user (guests are not ported).
 * `fields.Datetime.now()` is the second-truncated now; `last_presence` subtracts the inactivity in milliseconds.
 * Values are taken from the database's `now()` (the harness freezes `public.now()`), never from Date.now().
 */
export async function updatePresence(cr: Cursor, bus: BusValues, uid: number, inactivityPeriod: number): Promise<void> {
  const status: PresenceStatus = inactivityPeriod > AWAY_TIMER * 1000 ? "away" : "online";
  const existing = await cr.query<PresenceRow>("SELECT id, status FROM mail_presence WHERE user_id = $1", [uid]);
  const presence = existing.rows[0];
  if (presence !== undefined) {
    await cr.query(
      `UPDATE mail_presence
          SET last_poll = date_trunc('second', now() AT TIME ZONE 'UTC'),
              last_presence = date_trunc('second', now() AT TIME ZONE 'UTC') - ($2::bigint * interval '1 millisecond'),
              status = $3
        WHERE id = $1`,
      [presence.id, inactivityPeriod, status],
    );
    // mail_presence.py:51-56 write(): notify only when the status changed. The store version lists the fields
    // the ORM flushed (mail/models/models.py:29-34): the three written columns, in field definition order.
    if (presence.status !== status) {
      await sendPresence(cr, bus, uid, status, { "mail.presence": { [String(presence.id)]: ["last_poll", "last_presence", "status"] } });
    }
    return;
  }
  const created = await cr.query<{ id: number }>(
    `INSERT INTO mail_presence (user_id, guest_id, last_poll, last_presence, status)
     VALUES ($1, NULL, date_trunc('second', now() AT TIME ZONE 'UTC'),
             date_trunc('second', now() AT TIME ZONE 'UTC') - ($2::bigint * interval '1 millisecond'), $3)
     RETURNING id`,
    [uid, inactivityPeriod, status],
  );
  const id = created.rows[0]?.id;
  if (id === undefined) throw new Error("mail_presence insert returned no id");
  // mail_presence.py:45-49 create(): always notifies. Fields flushed by create, in definition order
  // (mail_presence.py:27-35); guest_id is not written for a user presence.
  await sendPresence(cr, bus, uid, status, { "mail.presence": { [String(id)]: ["user_id", "last_poll", "last_presence", "status"] } });
}

/**
 * mail/models/ir_websocket.py:92-96 `_on_websocket_closed`: `self.env.user.sudo().presence_ids.status = "offline"`,
 * a write that notifies when the status changed (mail_presence.py:51-56).
 */
export async function setPresenceOffline(cr: Cursor, bus: BusValues, uid: number): Promise<void> {
  const existing = await cr.query<PresenceRow>("SELECT id, status FROM mail_presence WHERE user_id = $1", [uid]);
  const presence = existing.rows[0];
  if (presence === undefined) return;
  await cr.query("UPDATE mail_presence SET status = 'offline' WHERE id = $1", [presence.id]);
  if (presence.status !== "offline") {
    await sendPresence(cr, bus, uid, "offline", { "mail.presence": { [String(presence.id)]: ["status"] } });
  }
}
