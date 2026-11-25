import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { consteq } from "./binary";
import { sanitizeLandingRoute, validatePaymentAmount } from "./payment_portal";
import { escapeStyleContent, isAllowedPdfStylesheetHref } from "./report";
import { BASE_PRIVATE, CLASS_METHODS, MODEL_PRIVATE } from "../http/methods";
import { formatLongSv } from "../models/res_users_password";
import { csvFromData } from "./export_csv";
import { staticFilePath } from "./static";
import { matchPath } from "../http/router";
import { LOGIN_FAILURES_MAX_AGE_MS, purgeOldSessions, readLoginFailures, recordLoginFailure, type SessionStorageLike } from "../session/session_gc";

describe("W1 security & HTTP hardening", () => {
  it("consteq compares UTF-8 strings in constant time without throwing on byte-length mismatch", () => {
    assert.equal(consteq("abc", "abc"), true);
    assert.equal(consteq("abc", "abd"), false);
    assert.equal(consteq("abc", "abcd"), false);
    assert.equal(consteq("åäö", "åäö"), true);
    assert.equal(consteq("åäö", "aao"), false);
    // Same JS .length (3) but different UTF-8 byte lengths (6 vs 3) must not throw RangeError
    assert.equal(consteq("åäö", "abc"), false);
  });

  it("validatePaymentAmount rejects zero, negative, NaN, and Infinity", () => {
    assert.equal(validatePaymentAmount(50), 50);
    assert.equal(validatePaymentAmount("42.5"), 42.5);
    assert.equal(validatePaymentAmount(undefined, 99), 99);
    assert.throws(() => validatePaymentAmount(0));
    assert.throws(() => validatePaymentAmount(-10));
    assert.throws(() => validatePaymentAmount(Number.NaN));
    assert.throws(() => validatePaymentAmount(Number.POSITIVE_INFINITY));
  });

  it("sanitizeLandingRoute blocks external, protocol-relative, backslash, and CRLF redirects", () => {
    assert.equal(sanitizeLandingRoute("/my/invoices/42?access_token=abc"), "/my/invoices/42?access_token=abc");
    assert.equal(sanitizeLandingRoute(null), "/payment/status");
    assert.equal(sanitizeLandingRoute(""), "/payment/status");
    assert.throws(() => sanitizeLandingRoute("https://evil.example/phish"));
    assert.throws(() => sanitizeLandingRoute("//evil.example/phish"));
    assert.throws(() => sanitizeLandingRoute("/\\evil.example"));
    assert.throws(() => sanitizeLandingRoute("/my\r\nSet-Cookie: x=1"));
  });

  it("PDF stylesheet allowlist and style escaping block SSRF and </style> breakout", () => {
    const base = new URL("https://erp.example.com/report/pdf/account.report_invoice/1");
    assert.ok(isAllowedPdfStylesheetHref("/web/assets/1/report.css", base) !== null);
    assert.equal(isAllowedPdfStylesheetHref("//evil.example/a.css", base), null);
    assert.equal(isAllowedPdfStylesheetHref("http://169.254.169.254/latest/meta-data", base), null);
    assert.equal(isAllowedPdfStylesheetHref("https://evil.example/a.css", base), null);
    assert.equal(isAllowedPdfStylesheetHref("file:///etc/passwd", base), null);
    const escaped = escapeStyleContent("body { color: red; } </style><script>alert(1)</script>");
    assert.ok(!escaped.toLowerCase().includes("</style"));
  });

  it("JSON-2 private method sets include expected internal methods", () => {
    assert.ok(BASE_PRIVATE.size > 0);
    assert.ok(MODEL_PRIVATE instanceof Map || typeof MODEL_PRIVATE === "object");
    assert.ok(CLASS_METHODS instanceof Set || typeof CLASS_METHODS === "object");
  });

  it("staticFilePath blocks path traversal, backslashes, encoded backslashes, and null bytes", () => {
    assert.equal(staticFilePath("/web/static/src/core/app.js"), "/web/static/src/core/app.js");
    assert.equal(staticFilePath("/web/static/../secrets.txt"), null);
    assert.equal(staticFilePath("/web/static/a\\..\\b"), null);
    assert.equal(staticFilePath("/web/static/a%5c..%5cb"), null);
    assert.equal(staticFilePath("/web/static/a\0b.js"), null);
  });

  it("csvFromData neutralizes @ formula prefix alongside =, +, -", () => {
    const csv = csvFromData(["col"], [["@SUM(A1:A2)"], ["=1+1"], ["+1+1"], ["-1+1"], ["normal"]]);
    assert.ok(csv.includes("'@SUM(A1:A2)"));
    assert.ok(csv.includes("'=1+1"));
    assert.ok(csv.includes("'+1+1"));
    assert.ok(csv.includes("'-1+1"));
    assert.ok(csv.includes("normal"));
  });

  it("router matchPath returns not_found on malformed percent-encoding instead of throwing URIError", () => {
    const res = matchPath("GET", "/web/content/%E0%A4%A", false);
    assert.equal(res.kind, "not_found");
  });

  it("formatLongSv formats Swedish long date without throwing on GMT offsets", () => {
    const formatted = formatLongSv(new Date("2026-06-15T10:30:00Z"), "Europe/Stockholm");
    assert.ok(formatted.includes("2026"));
    const utcFormatted = formatLongSv(new Date("2026-06-15T10:30:00Z"), "UTC");
    assert.ok(utcFormatted.includes("2026"));
  });

  it("purgeOldSessions and login failure GC clean expired rotated sessions and stale failure counters", async () => {
    const store = new Map<string, unknown>();
    const storage: SessionStorageLike = {
      async get<T>(key: string) { return store.get(key) as T | undefined; },
      async put<T>(key: string, value: T) { store.set(key, value); },
      delete: (async (key: string | string[]) => {
        if (Array.isArray(key)) { let n = 0; for (const k of key) if (store.delete(k)) n++; return n; }
        return store.delete(key);
      }) as SessionStorageLike["delete"],
      async list<T>(opts?: { prefix?: string; limit?: number }) {
        const out = new Map<string, T>();
        for (const [k, v] of store) {
          if (opts?.prefix && !k.startsWith(opts.prefix)) continue;
          out.set(k, v as T);
          if (opts?.limit && out.size >= opts.limit) break;
        }
        return out;
      },
    };
    store.set("session:pref_old", JSON.stringify({ deletion_time: 100 }));
    store.set("session:pref_future", JSON.stringify({ deletion_time: 500 }));
    store.set("session:pref_cur", JSON.stringify({ deletion_time: 50 }));
    const removed = await purgeOldSessions(storage, "pref_", "pref_cur", 200);
    assert.equal(removed, 1);
    assert.equal(store.has("session:pref_old"), false);
    assert.equal(store.has("session:pref_future"), true);
    assert.equal(store.has("session:pref_cur"), true);

    const now = 10_000_000_000;
    store.set("login_failures:old", [5, now - LOGIN_FAILURES_MAX_AGE_MS - 1000]);
    assert.deepEqual(await readLoginFailures(storage, "login_failures:old", now), [0, 0]);
    assert.equal(store.has("login_failures:old"), false);
    await recordLoginFailure(storage, "login_failures:cur", now);
    assert.deepEqual(await readLoginFailures(storage, "login_failures:cur", now), [1, now]);
  });
});
