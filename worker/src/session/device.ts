/**
 * Device tracking of a session (`odoo/odoo/http/session.py:286-372` get_device/update_device, and
 * `odoo/odoo/addons/base/models/res_device.py:54-104` `res.device.log._update_device`).
 * GeoIP: the oracle has no GeoIP database, so `GeoIP(ip).country.name` and `.city.name` are None (geoip.py).
 */
import type { Cursor } from "../db";
import { DEVICE_ACTIVITY_UPDATE_FREQUENCY, STORED_SESSION_BYTES, type Device, type Session } from "./session";

/** `zlib.adler32` of the UTF-8 bytes. */
export function adler32(s: string): number {
  const bytes = Buffer.from(s, "utf8");
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** session.py:286-299 `collapse_ip_address`: IPv6 addresses collapse to their /64 network, IPv4 stays. */
export function collapseIpAddress(ip: string): string {
  if (!ip.includes(":")) return ip;
  const groups = expandIpv6(ip);
  if (groups === null) return ip;
  const net = [...groups.slice(0, 4), 0, 0, 0, 0];
  return `${compressIpv6(net)}/64`;
}

function expandIpv6(ip: string): number[] | null {
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] => (part === "" ? [] : part.split(":").map((h) => parseInt(h, 16)));
  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (head.some(Number.isNaN) || tail.some(Number.isNaN)) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/** Python `ipaddress` compressed form: the longest run (>= 2) of zero groups becomes "::". */
function compressIpv6(groups: number[]): string {
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < groups.length;) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < groups.length && groups[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = (g: number): string => g.toString(16);
  if (bestLen < 2) return groups.map(hex).join(":");
  const left = groups.slice(0, bestStart).map(hex).join(":");
  const right = groups.slice(bestStart + bestLen).map(hex).join(":");
  return `${left}::${right}`;
}

export interface Client {
  readonly remoteAddr: string;
  readonly userAgent: string;
}

/** session.py:302-347 `get_device`: the current device's dict, created (trusted when first) if unknown. */
export function getDevice(session: Session, client: Client, nowSec: number): Device {
  if (!session.has("_devices")) {
    session.set("_devices", {});
    session.isDirty = true;
  }
  const devices = session.get("_devices") as Record<string, Device>;
  const ipKey = collapseIpAddress(client.remoteAddr);
  const deviceKey = `${Buffer.from(ipKey, "utf8").toString("hex")}${adler32(client.userAgent).toString(16)}`;
  const existing = devices[deviceKey];
  if (existing !== undefined) return existing;
  const device: Device = {
    ip_address: ipKey,
    user_agent: client.userAgent,
    first_activity: Math.floor(nowSec),
    last_activity: null,
    country: null,
    city: null,
    trusted: Object.keys(devices).length === 0, // first device in a session is always trusted
  };
  devices[deviceKey] = device; // in-place mutation of the nested dict, as Odoo does
  session.isDirty = true;
  return device;
}

/** session.py:350-372 `update_device`: the device when its activity was refreshed, else null. */
export function updateDevice(session: Session, client: Client, nowSec: number): Device | null {
  if (session.get("_trace_disable") === true) return null;
  const device = getDevice(session, client, nowSec);
  const now = Math.floor(nowSec);
  if (device.last_activity !== null && now - device.last_activity < DEVICE_ACTIVITY_UPDATE_FREQUENCY) return null;
  device.last_activity = now;
  session.isDirty = true;
  return device;
}

/**
 * res_device.py:54-104 `_update_device`: refresh the device and insert a `res_device_log` row (the table is
 * excluded from the harness's database diff, dbdiff.py EXCLUDED). Returns true when the session must be saved.
 */
export async function updateDeviceLog(cr: Cursor, session: Session, client: Client, nowSec: number): Promise<boolean> {
  const device = updateDevice(session, client, nowSec);
  if (device === null) return false;
  if (session.uid === null) return false;
  const toTs = (sec: number): Date => new Date(sec * 1000);
  await cr.query(
    `INSERT INTO res_device_log (session_identifier, user_id, ip_address, user_agent, country, city, first_activity, last_activity, revoked)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [session.sid.slice(0, STORED_SESSION_BYTES), session.uid, device.ip_address, device.user_agent.slice(0, 1024),
      device.country, device.city, toTs(device.first_activity), toTs(device.last_activity ?? nowSec), false],
  );
  return true; // session_store().save(request.session) (res_device.py:104)
}
