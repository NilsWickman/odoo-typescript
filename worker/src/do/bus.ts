/**
 * Odoo's bus dispatcher (`odoo/addons/bus/bus_dispatcher.py`, `odoo/addons/bus/websocket.py`) as one Durable
 * Object per database (id from the database name): the websockets Odoo keeps in gevent greenlets are hibernating
 * sockets here, subscribed by channel; `NOTIFY imbus` (bus.py:152-170) is the Worker posting the `bus_bus` rows
 * it committed to DISPATCH_PATH (src/bus/bus.ts `dispatchRows`), fanned out per channel.
 *
 * Split of the SQL (the DO holds no Postgres connection across hibernation):
 * - the Worker's `GET /websocket` route (src/bus/routes.ts) authenticates the session cookie and hands the DO the
 *   session (db, sid, uid) in a header; the DO keeps it in the socket attachment;
 * - each incoming message opens its own Cursor, one transaction, exactly Odoo's `acquire_cursor(self.db)` per
 *   message (websocket.py:748-761), runs src/bus/protocol.ts and commits; the rows it created are dispatched
 *   locally (the DO is the only fan-out point for its database);
 * - `webSocketClose` does the same for `_on_websocket_closed` (websocket.py:536-538).
 * Subscriptions live in the DO's storage (`sub:<socket id>`), not in the 2 KB attachment, so a user with many
 * groups fits and the state survives hibernation.
 */
import { DurableObject } from "cloudflare:workers";
import { Cursor } from "../db";
import type { Env } from "../env";
import { SessionExpired } from "../errors";
import { DISPATCH_PATH, fetchBusNotifications, type BusRow } from "../bus/bus";
import {
  CloseCode, InvalidWebsocketRequest, VERSION, dispatchToWebSockets, onWebsocketClosed, serveWebsocketMessage,
  type BusSubscription as Subscription, type WsSender, type WsSession,
} from "../bus/protocol";

/** Header the Worker route sets on the upgrade request it forwards to the DO. */
export const SESSION_HEADER = "X-Odoo-Bus-Session";

/** JSON carried in SESSION_HEADER. */
export interface UpgradeInfo extends WsSession {
  /** `?version=` of the upgrade URL (controllers/websocket.py:13). */
  readonly version: string | null;
  /** `httprequest.user_agent` truthiness (websocket.py:952): non-browsers skip the version check. */
  readonly hasUserAgent: boolean;
}

interface Attachment extends WsSession {
  readonly id: string;
}

function parseAttachment(ws: WebSocket): Attachment | null {
  const a: unknown = ws.deserializeAttachment();
  if (typeof a !== "object" || a === null) return null;
  const r = a as Record<string, unknown>;
  if (typeof r["id"] !== "string" || typeof r["db"] !== "string" || typeof r["sid"] !== "string") return null;
  const uid = r["uid"];
  return { id: r["id"], db: r["db"], sid: r["sid"], uid: typeof uid === "number" ? uid : null };
}

export class BusDispatcher extends DurableObject<Env> {
  /** Nothing: a call that makes the object exist before the database's first websocket (src/http/dispatch.ts `ensureDb`). */
  async ping(): Promise<void> {}

  /** Close all active websockets and clear subscriptions (used by DemoPool when resetting a demo slot). */
  async reset(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(CloseCode.SESSION_EXPIRED, "DEMO_RESET");
      } catch {
        // already closed
      }
    }
    await this.ctx.storage.deleteAll();
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === DISPATCH_PATH) {
      const rows = (await request.json()) as BusRow[];
      await this.dispatch(rows);
      return new Response(null, { status: 204 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a websocket", { status: 426 });
    }
    const raw = request.headers.get(SESSION_HEADER);
    if (raw === null) return new Response("missing session", { status: 400 });
    const info = JSON.parse(raw) as UpgradeInfo;
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const attachment: Attachment = { id: crypto.randomUUID(), db: info.db, sid: info.sid, uid: info.uid };
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(attachment);
    await this.ctx.storage.put<Subscription>(`sub:${attachment.id}`, { channels: [], last: 0 });
    if (info.hasUserAgent && info.version !== VERSION) {
      // websocket.py:952-962: an outdated worker is closed cleanly with the reason it must not reconnect on.
      // Odoo enqueues the close for its event loop; here it must run after the 101 has been returned (a close
      // before the handshake completes leaves the client without a close event).
      setTimeout(() => {
        void this.ctx.storage.delete(`sub:${attachment.id}`).catch(() => undefined);
        try { server.close(CloseCode.CLEAN, "OUTDATED_VERSION"); } catch { /* already closed */ }
      }, 0);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      // websocket.py:964-966: the worker's one-byte connection check (websocket_worker.js:473) is ignored.
      const bytes = new Uint8Array(message);
      if (bytes.length === 1 && bytes[0] === 0) return;
      const att = parseAttachment(ws);
      if (att !== null) await this.ctx.storage.delete(`sub:${att.id}`);
      try { ws.close(CloseCode.INCORRECT_DATA, "binary frames are not expected"); } catch { /* already closed */ }
      return;
    }
    const att = parseAttachment(ws);
    if (att === null) {
      try { ws.close(CloseCode.SERVER_ERROR); } catch { /* already closed */ }
      return;
    }
    const cr = new Cursor(this.env, att.db);
    const sender = this.sender(ws, att, cr);
    try {
      const rows = await serveWebsocketMessage(cr, att, message, sender);
      await cr.commit();
      await this.dispatch(rows);
    } catch (e) {
      await cr.rollback();
      if (e instanceof SessionExpired) {
        await this.ctx.storage.delete(`sub:${att.id}`);
        try { ws.close(CloseCode.SESSION_EXPIRED); } catch { /* already closed */ } // websocket.py:971-972
        return;
      }
      // websocket.py:975-976: logged, the connection stays open (InvalidWebsocketRequest included).
      console.error(`bus: exception during websocket request handling${e instanceof InvalidWebsocketRequest ? " (invalid request)" : ""}:`, e);
    } finally {
      await cr.close();
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    void wasClean;
    const att = parseAttachment(ws);
    if (att !== null) {
      await this.ctx.storage.delete(`sub:${att.id}`); // dispatch.unsubscribe (websocket.py:534)
      const cr = new Cursor(this.env, att.db);
      try {
        const rows = await onWebsocketClosed(cr, att); // websocket.py:536-538
        await cr.commit();
        await this.dispatch(rows);
      } catch (e) {
        await cr.rollback();
        console.error("bus: _on_websocket_closed failed:", e);
      } finally {
        await cr.close();
      }
    }
    // Codes 1005/1006 (no status, abnormal) cannot be sent back; answer with a normal closure.
    const replyCode = code === 1005 || code === 1006 ? CloseCode.CLEAN : code;
    try {
      ws.close(replyCode, reason);
    } catch (e) {
      console.warn("bus: close reply failed:", e);
    }
  }

  override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("bus: websocket error:", error);
    const att = parseAttachment(ws);
    if (att !== null) await this.ctx.storage.delete(`sub:${att.id}`);
  }

  /**
   * The `_dispatch` of bus_dispatcher.py:540-548 for rows the Worker committed: every socket subscribed to a
   * row's channel gets the notifications of that channel it has not seen, one frame per channel
   * (`ChannelTopic.dispatch_notifications`, :217-238; the id history is the socket's `last`).
   */
  async dispatch(rows: readonly BusRow[]): Promise<void> {
    await dispatchToWebSockets(this.ctx.storage, this.ctx.getWebSockets(), rows, WebSocket.OPEN);
  }

  private sender(ws: WebSocket, att: Attachment, cr: Cursor): WsSender {
    const ctx = this.ctx;
    return {
      sendWorkerInternalMessage(type: string, payload: unknown = null): void {
        // websocket.py:301-307
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify([{ type, internal: true, payload }])); } catch { /* socket closed */ }
        }
      },
      async subscribe(channels: readonly string[], last: number): Promise<void> {
        // bus_dispatcher.py:393-431: the subscription is replaced; channels new to this socket are caught up
        // from `last` (the waiting room, :417-421, served by `_fetch`/`dispatch_notifications`, :524-538, :227-231).
        const key = `sub:${att.id}`;
        const previous = (await ctx.storage.get<Subscription>(key)) ?? { channels: [], last: 0 };
        const known = new Set(previous.channels);
        const fresh = channels.filter((c) => !known.has(c));
        let maxId = Math.max(previous.last, last);
        if (fresh.length > 0) {
          const byChannel = await fetchBusNotifications(cr, fresh, last);
          for (const channel of fresh) {
            const notifications = byChannel.get(channel);
            if (notifications === undefined || notifications.length === 0) continue;
            if (ws.readyState === WebSocket.OPEN) {
              try {
                ws.send(JSON.stringify(notifications));
              } catch {
                await ctx.storage.delete(key);
                return;
              }
            }
            maxId = Math.max(maxId, notifications[notifications.length - 1]?.id ?? maxId);
          }
        }
        await ctx.storage.put<Subscription>(key, { channels: [...channels], last: maxId });
      },
    };
  }
}
