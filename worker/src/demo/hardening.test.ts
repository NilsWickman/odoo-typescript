import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEMO_MAX_BODY_BYTES, enforceDemoBodyCap, hasAdminToken, hasMaintenanceBypass } from "./guards";
import {
  AssetInliner,
  DEMO_PDF_CSP_META,
  DEMO_PDF_ENGINE_OPTIONS,
  inlineFontFaces,
  inlineImages,
  lockPdfHtml,
  sameOriginAsset,
  type AssetFetcher,
} from "./pdf_lock";
import { DEMO_MAX_FILE_BYTES, DEMO_MAX_STORE_BYTES, demoUploadRefusal } from "./upload_caps";

const base = new URL("https://odoo-ts-3.example.com/report/pdf/account.report_invoice/1");

function fakeFetcher(files: Record<string, { type: string; size: number }>, seen: string[] = []): AssetFetcher {
  return async (u) => {
    seen.push(u.pathname);
    const f = files[u.pathname];
    return f ? { contentType: f.type, bytes: new Uint8Array(f.size).fill(65) } : null;
  };
}

describe("demo PDF egress lock", () => {
  it("puts the CSP meta first in head and strips meta refresh", () => {
    const html = lockPdfHtml(`<!DOCTYPE html><html><head><meta charset="utf-8"><META HTTP-EQUIV='Refresh' content="0;url=https://evil"></head><body><meta http-equiv=refresh content=1>x</body></html>`);
    assert.ok(html.startsWith(`<!DOCTYPE html><html><head>${DEMO_PDF_CSP_META}<meta charset="utf-8">`));
    assert.doesNotMatch(html, /refresh/i);
    assert.deepEqual(DEMO_PDF_ENGINE_OPTIONS, { setJavaScriptEnabled: false, rejectRequestPattern: ["/^https?:\\/\\//"] });
  });

  it("accepts only same-origin images under /web/image/ or /web/content/, without path tricks", () => {
    assert.ok(sameOriginAsset("/web/image/res.company/1/logo", base, "image"));
    assert.ok(sameOriginAsset("https://odoo-ts-3.example.com/web/content/12", base, "image"));
    assert.equal(sameOriginAsset("https://evil.example/web/image/1", base, "image"), null);
    assert.equal(sameOriginAsset("/web/static/img/x.png", base, "image"), null);
    assert.equal(sameOriginAsset("/web/image/%2e%2e/secret", base, "image"), null);
    assert.equal(sameOriginAsset("data:image/png;base64,AA==", base, "image"), null);
    assert.ok(sameOriginAsset("/web/static/fonts/x.woff2", base, "font"));
    assert.equal(sameOriginAsset("//evil.example/x.woff2", base, "font"), null);
  });

  it("inlines fonts and images as data: URIs and drops what is remote, missing or past the budget", async () => {
    const seen: string[] = [];
    const inliner = new AssetInliner(fakeFetcher({
      "/web/static/fonts/a.woff2": { type: "font/woff2", size: 10 },
      "/web/image/res.company/1/logo": { type: "image/png", size: 20 },
      "/web/content/9": { type: "text/html", size: 5 },
      "/web/image/big": { type: "image/png", size: 100 },
    }, seen), 50);
    const css = `body{color:red;background:url(/web/static/img/bg.png)}@font-face{font-family:A;src:url('/web/static/fonts/a.woff2') format('woff2'),url(https://fonts.example/b.woff2)}`;
    const outCss = await inlineFontFaces(css, base, inliner);
    assert.match(outCss, /url\("data:font\/woff2;base64,QUFB/);
    assert.match(outCss, /url\("data:,"\)/);
    assert.match(outCss, /background:url\(\/web\/static\/img\/bg\.png\)/); // only @font-face rules are touched
    const html = `<img src="/web/image/res.company/1/logo"/><img class="x" src='/web/image/res.company/1/logo'><img src="/web/content/9"><img src="https://evil.example/t.gif"><img src="/web/image/big">`;
    const outHtml = await inlineImages(html, base, inliner);
    assert.equal((outHtml.match(/data:image\/png;base64,/g) ?? []).length, 2);
    assert.doesNotMatch(outHtml, /evil|\/web\/content\/9|\/web\/image\/big/);
    assert.equal(inliner.usedBytes, 30);
    // the logo was fetched once; the remote image never
    assert.deepEqual(seen.filter((p) => p === "/web/image/res.company/1/logo").length, 1);
    assert.ok(!seen.some((p) => p.includes("evil") || p === "/t.gif"));
  });
});

describe("demo request guards", () => {
  it("refuses bodies over 5 MiB by Content-Length or by counting the stream", async () => {
    const small = new Request("https://x/web/binary/upload_attachment", { method: "POST", body: "hello" });
    const okReq = await enforceDemoBodyCap(small);
    assert.ok(okReq instanceof Request);
    assert.equal(await okReq.text(), "hello");
    const declared = new Request("https://x/", { method: "POST", body: "x", headers: { "content-length": String(DEMO_MAX_BODY_BYTES + 1) } });
    const r1 = await enforceDemoBodyCap(declared);
    assert.ok(r1 instanceof Response);
    assert.equal(r1.status, 413);
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ < 6) c.enqueue(chunk);
        else c.close();
      },
    });
    const chunked = new Request("https://x/", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    const r2 = await enforceDemoBodyCap(chunked);
    assert.ok(r2 instanceof Response);
    assert.equal(r2.status, 413);
    const get = new Request("https://x/web");
    assert.equal(await enforceDemoBodyCap(get), get);
  });

  it("keeps the admin token and the bypass token apart", () => {
    const env = { DEMO_ADMIN_TOKEN: "admin-secret", DEMO_BYPASS_TOKEN: "bypass-secret" };
    const req = (h: Record<string, string>) => new Request("https://x/", { headers: h });
    assert.equal(hasAdminToken(req({ authorization: "Bearer admin-secret" }), env), true);
    assert.equal(hasAdminToken(req({ authorization: "Bearer bypass-secret" }), env), false);
    assert.equal(hasAdminToken(req({ authorization: "Bearer admin-secretX" }), env), false);
    assert.equal(hasAdminToken(req({}), env), false);
    assert.equal(hasAdminToken(req({ authorization: "Bearer " }), { DEMO_ADMIN_TOKEN: "" }), false);
    assert.equal(hasMaintenanceBypass(req({ "x-demo-admin-bypass": "bypass-secret" }), env), true);
    assert.equal(hasMaintenanceBypass(req({ "x-demo-admin-bypass": "admin-secret" }), env), false);
    assert.equal(hasMaintenanceBypass(req({ "x-demo-admin-bypass": "" }), { DEMO_BYPASS_TOKEN: "" }), false);
  });
});

describe("demo upload caps", () => {
  it("caps a file at 2 MiB and a database's runtime files at 20 MiB", () => {
    assert.equal(demoUploadRefusal(DEMO_MAX_FILE_BYTES, 0), null);
    assert.match(demoUploadRefusal(DEMO_MAX_FILE_BYTES + 1, 0)!, /2 MiB/);
    assert.equal(demoUploadRefusal(1024, DEMO_MAX_STORE_BYTES - 1024), null);
    assert.match(demoUploadRefusal(1024, DEMO_MAX_STORE_BYTES - 1023)!, /20 MiB/);
  });
});
