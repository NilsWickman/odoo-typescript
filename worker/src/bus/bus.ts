/**
 * `bus.bus` (odoo/addons/bus/models/bus.py) and `odoo/addons/bus/tools/notifications.py`: channel encoding,
 * the precommit collector of `_sendone` values that becomes `bus_bus` rows, `_poll` and `_bus_last_id`.
 * `NOTIFY imbus` (bus.py:152-170) is replaced by the BusDispatcher Durable Object (src/do/bus.ts): after the
 * transaction committed, the Worker calls `dispatchRows` with the rows it inserted.
 */
import type { Cursor } from "../db";
import type { Env } from "../env";
import { isPyFloat, pyFloatRepr } from "../http/json";

/** A record used as a bus target: `channel_with_db` turns it into `(db, model, id)` (bus.py:41-48). */
export interface RecordTarget {
  readonly model: string;
  readonly id: number;
  /** `(record, subchannel)` tuples (bus.py:44-45). */
  readonly sub?: string;
}

/** A channel after `channel_with_db`: `(db, "broadcast")`, `(db, model, id)` or `(db, model, id, sub)`. */
export type Channel = readonly (string | number)[];

/** bus.py:41-48 `channel_with_db`. */
export function channelWithDb(db: string, target: string | RecordTarget): Channel {
  if (typeof target === "string") return [db, target];
  if (target.sub !== undefined) return [db, target.model, target.id, target.sub];
  return [db, target.model, target.id];
}

/**
 * notifications.py:10-11 `json_dump`: `json.dumps(v, separators=(",", ":"))`. Python's default `ensure_ascii=True`
 * escapes every non-ASCII UTF-16 code unit as `\uXXXX`; JSON.stringify does not, so we do it here.
 */
export function jsonDump(value: unknown): string {
  return compactJson(value).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** JSON.stringify's compact output, with a `PyFloat` (a Store's float field, e.g. `rating_avg`) as Python's float repr. */
function compactJson(v: unknown): string {
  if (isPyFloat(v)) return pyFloatRepr(v.float);
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined || typeof x === "function" ? "null" : compactJson(x))).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const toJSON = (v as { toJSON?: () => unknown }).toJSON;
    if (typeof toJSON === "function") return compactJson(toJSON.call(v));
    const parts: string[] = [];
    for (const [k, x] of Object.entries(v)) if (x !== undefined && typeof x !== "function") parts.push(`${JSON.stringify(k)}:${compactJson(x)}`);
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** A committed `bus_bus` row as the dispatcher wants it. */
export interface BusRow {
  readonly id: number;
  /** `bus_bus.channel`: the `json_dump` of the channel tuple. */
  readonly channel: string;
  /** `bus_bus.message`: the `json_dump` of `{"type": ..., "payload": ...}`. */
  readonly message: string;
}

/** What `_poll` returns per notification (notifications.py:55). */
export interface Notification {
  readonly id: number;
  readonly message: unknown;
}

/** bus.py:182-184 `_bus_last_id`. */
export async function busLastId(cr: Cursor): Promise<number> {
  const r = await cr.query<{ id: number }>("SELECT id FROM bus_bus ORDER BY id DESC LIMIT 1");
  return r.rows[0]?.id ?? 0;
}

/**
 * notifications.py:14-57 `fetch_bus_notifications` for one lower bound: notifications grouped by channel
 * (the JSON string), each group sorted by id. Duplicate channels collapse (notifications.py:28-33).
 */
export async function fetchBusNotifications(
  cr: Cursor,
  channels: readonly string[],
  last: number,
): Promise<Map<string, Notification[]>> {
  const unique = [...new Set(channels)];
  const out = new Map<string, Notification[]>();
  if (unique.length === 0) return out;
  const values = unique.map((_, i) => `($${i + 1}, $${unique.length + 1}::int)`).join(", ");
  const r = await cr.query<{ id: number; message: string; channel: string }>(
    `SELECT b.id, b.message, b.channel
       FROM bus_bus b
       JOIN (VALUES ${values}) AS v(channel, last_fetched_id)
         ON b.channel = v.channel AND b.id > v.last_fetched_id
      ORDER BY b.id`,
    [...unique, last],
  );
  for (const row of r.rows) {
    const list = out.get(row.channel) ?? [];
    list.push({ id: row.id, message: JSON.parse(row.message) as unknown });
    out.set(row.channel, list);
  }
  return out;
}

/** bus.py:172-180 `_poll`: every notification after `last` on `channels`, sorted by id. */
export async function poll(cr: Cursor, channels: readonly string[], last: number): Promise<Notification[]> {
  const byChannel = await fetchBusNotifications(cr, channels, last);
  return [...byChannel.values()].flat().sort((a, b) => a.id - b.id);
}

/**
 * The precommit collector of bus.py:92-137: `_sendone` appends `(channel, type, payload)`; `create()` is the
 * `create_bus` precommit hook that inserts the rows (`self.sudo().create(values)`: create_uid is the env user).
 * Rows are returned so the caller can `dispatchRows` them once its transaction committed (bus.py:148-151).
 */
export class BusValues {
  private readonly values: { channel: Channel; type: string; payload: unknown }[] = [];
  private readonly db: string;

  // A plain field, not a parameter property: node's strip-types test runner rejects the latter.
  constructor(db: string) {
    this.db = db;
  }

  /** bus.py:92-109 `_sendone`. */
  sendone(target: string | RecordTarget, notificationType: string, payload: unknown): void {
    this.values.push({ channel: channelWithDb(this.db, target), type: notificationType, payload });
  }

  get size(): number {
    return this.values.length;
  }

  /** bus.py:123-137 `create_bus`: one INSERT for every collected value, in order. */
  async create(cr: Cursor, uid: number): Promise<BusRow[]> {
    if (this.values.length === 0) return [];
    const params: unknown[] = [uid];
    const tuples = this.values.map((v, i) => {
      params.push(jsonDump(v.channel), jsonDump({ type: v.type, payload: v.payload }));
      return `($${2 * i + 2}, $${2 * i + 3}, $1, $1, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')`;
    });
    this.values.length = 0;
    // create_date/write_date are `cr.now()` in Odoo; `now()` unqualified resolves to the harness's frozen
    // `public.now()` when present (harness/clock.py), as it does for Odoo.
    const r = await cr.query<BusRow>(
      `INSERT INTO bus_bus (channel, message, create_uid, write_uid, create_date, write_date)
       VALUES ${tuples.join(", ")} RETURNING id, channel, message`,
      params,
    );
    return r.rows;
  }
}

/** Internal path of the BusDispatcher's fetch handler that receives committed rows (src/do/bus.ts). */
export const DISPATCH_PATH = "/__bus/dispatch";

/**
 * Post-commit `NOTIFY imbus` replacement: hand the committed rows to the database's BusDispatcher (one Durable
 * Object per database, id from the database name). A fetch rather than an RPC method keeps `Env.BUS` untyped.
 */
export async function dispatchRows(env: Env, db: string, rows: readonly BusRow[]): Promise<void> {
  if (rows.length === 0) return;
  const stub = env.BUS.get(env.BUS.idFromName(db));
  const res = await stub.fetch(`https://bus.internal${DISPATCH_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`bus dispatch failed: ${res.status} ${await res.text()}`);
}
