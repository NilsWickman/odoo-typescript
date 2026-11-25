/**
 * Development entry for stream H2 only (not wired into src/index.ts), after stream B's src/bus/dev pattern:
 * `npx wrangler dev --config src/controllers/dev/wrangler.jsonc --port 8082 --var PG_DSN_TEMPLATE:... --var
 * FILESTORE_URL:...` runs the H2 routes through the shared route table with the HTTP stream's RequestContextImpl
 * and a fixed session (`H2_DEV_UID`, default 2 = admin; `?db=` names the database). Delete this directory once `rcheck --track cf` exercises the real path.
 */
import type { Env } from "../../env";
import { Cursor, UnknownDatabase } from "../../db";
import { HttpError, NotPorted, OdooError } from "../../errors";
import { RequestContextImpl, type Handler } from "../../http/context";
import { match } from "../../http/router";
import { Session, SessionStore } from "../../session/session";
import "../h2";

export { BusDispatcher } from "../../do/bus";
export { SessionStore as SessionStoreDO } from "../../do/session";

interface DevEnv extends Env {
  readonly H2_DEV_UID?: string;
}

// The ORM stream's environment factory (src/orm/env.ts createEnvironment) is registered here once its modules
// build; until then ctx.orm() raises NotPorted and the /web/image routes answer 501.

export default {
  async fetch(request: Request, env: DevEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    const m = match(request.method, url.pathname);
    if (m === null) return new Response("not served", { status: 404, headers: { "X-Odoo-Port-Fallback": "1" } });
    const db = url.searchParams.get("db");
    const uid = Number(env.H2_DEV_UID ?? "2");
    const session = new Session({ uid, login: "admin", db, context: { lang: "en_US", tz: "Europe/Brussels", uid }, debug: "" }, "x".repeat(86));
    const ctx = new RequestContextImpl(env, request, url, db, session, new Map(), new SessionStore(env));
    ctx.uid = uid;
    ctx.context = { lang: "en_US", tz: "Europe/Brussels", uid };
    let cr: Cursor | null = null;
    try {
      const res = await (m.route.handler as Handler)(ctx, m.params);
      cr = ctx.openedCursor();
      await cr?.commit();
      return res;
    } catch (e) {
      cr = ctx.openedCursor();
      await cr?.rollback();
      if (e instanceof UnknownDatabase) return new Response(e.message, { status: 404 });
      if (e instanceof HttpError) return new Response(e.message, { status: e.status, headers: e.headers });
      if (e instanceof NotPorted) return new Response(e.message, { status: 501 });
      if (e instanceof OdooError) return new Response(`${e.odooName}: ${e.message}`, { status: 500 });
      const message = e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e);
      return new Response(message, { status: 500 });
    } finally {
      await ctx.openedCursor()?.close();
    }
  },
} satisfies ExportedHandler<DevEnv>;
