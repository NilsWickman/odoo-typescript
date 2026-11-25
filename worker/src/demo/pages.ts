/**
 * Minimal English HTML pages and corner badge for the public Odoo-TS demo & Runbot deployment.
 */
import type { PoolStatus } from "./pool_logic";

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatShortEn(ms: number): string {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m} min` : `${m}m ${s}s`;
}

function formatClock(ms: number): string {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const BASE_CSS = `
  :root {
    --bg: #0b0e14;
    --surface: #131822;
    --surface-2: #1a2130;
    --border: rgba(255, 255, 255, 0.1);
    --text: #eef2f8;
    --muted: #98a4b8;
    --primary: #714b67;
    --primary-hover: #875a7b;
    --ok: #22c55e;
    --warn: #f59e0b;
    --radius: 14px;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f6f7fb;
      --surface: #ffffff;
      --surface-2: #f1f3f8;
      --border: rgba(15, 23, 42, 0.1);
      --text: #0f172a;
      --muted: #526074;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    line-height: 1.45;
  }
  .wrap { width: 100%; max-width: 660px; }
  .hero { text-align: center; margin-bottom: 22px; }
  h1 { margin: 0 0 10px; font-size: 28px; letter-spacing: -0.02em; }
  .creds {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 12px; border-radius: 999px;
    background: var(--surface); border: 1px solid var(--border);
    font-size: 13px; color: var(--muted);
  }
  .creds code {
    color: var(--text);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600;
  }
  .notice {
    margin: 0 0 16px; padding: 10px 14px; border-radius: 10px;
    background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.35);
    color: var(--text); font-size: 13px; text-align: center;
  }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(270px, 1fr)); gap: 14px; }
  .card {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 20px; display: flex; flex-direction: column; gap: 12px;
  }
  .card h2 { margin: 0; font-size: 17px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .pill {
    font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 999px;
    background: var(--surface-2); color: var(--muted); white-space: nowrap;
  }
  .pill.ok { background: rgba(34, 197, 94, 0.14); color: var(--ok); }
  .pill.warn { background: rgba(245, 158, 11, 0.14); color: var(--warn); }
  .card p { margin: 0; color: var(--muted); font-size: 14px; }
  .btn {
    margin-top: auto; width: 100%; border: 0; border-radius: 10px; padding: 11px 16px;
    font-size: 14px; font-weight: 600; cursor: pointer; text-decoration: none;
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    transition: transform 0.08s ease, opacity 0.15s ease, background 0.15s ease;
  }
  .btn:active { transform: scale(0.99); }
  .btn-primary { background: var(--primary); color: #fff; }
  .btn-primary:hover { background: var(--primary-hover); }
  .btn-secondary { background: var(--surface-2); color: var(--text); border: 1px solid var(--border); }
  .btn-secondary:hover { opacity: 0.9; }
  .queue-card { text-align: center; padding: 28px 22px; }
  .pos { font-size: 52px; font-weight: 700; letter-spacing: -0.03em; margin: 4px 0; }
  .spinner {
    width: 30px; height: 30px; border-radius: 50%; margin: 0 auto 6px;
    border: 3px solid var(--border); border-top-color: var(--primary);
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
`;

/** A small standalone notice (429 per-IP cap, 503 maintenance, 403 failed verification) with a way back. */
export function renderNoticePage(title: string, message: string, launcherHost: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <style>${BASE_CSS}</style>
</head>
<body>
  <main class="wrap">
    <div class="hero"><h1>${esc(title)}</h1></div>
    <div class="notice">${esc(message)}</div>
    <a class="btn btn-secondary" href="https://${esc(launcherHost)}/">Back to the demo launcher</a>
  </main>
</body>
</html>`;
}

/** `turnstileSiteKey`: render the Cloudflare Turnstile widget in the launch form (null = not configured). */
export function renderLauncherPage(
  status: PoolStatus,
  reason: "expired" | "reset" | "unknown" | null,
  turnstileSiteKey: string | null = null,
): string {
  const idleLabel = formatShortEn(status.idleMs);
  const runbotInterval = formatShortEn(status.runbotResetMs);
  const freeClass = status.freeSlots > 0 ? "ok" : "warn";
  const freeText = status.freeSlots > 0 ? "Available" : `Queue: ${status.queueLength}`;

  const notice =
    reason === "expired"
      ? `<div class="notice">Session reset after ${esc(idleLabel)} idle.</div>`
      : reason === "reset"
        ? `<div class="notice">Instance reset.</div>`
        : reason === "unknown"
          ? `<div class="notice">Session expired.</div>`
          : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Odoo on Cloudflare Workers</title>
  <style>${BASE_CSS}</style>
  ${turnstileSiteKey ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : ""}
</head>
<body>
  <main class="wrap">
    <div class="hero">
      <h1>Odoo on Cloudflare Workers</h1>
      <div class="creds">Login: <code>admin</code> / <code>admin</code></div>
    </div>

    ${notice}

    <div class="grid">
      <section class="card">
        <h2>
          <span>Private demo</span>
          <span class="pill ${freeClass}" id="slot-pill">${esc(freeText)}</span>
        </h2>
        <p>Works like demo.odoo.com. Resets after ${esc(idleLabel)} idle.</p>
        <form method="POST" action="/__demo/enter" style="margin-top:auto">
          ${turnstileSiteKey ? `<div class="cf-turnstile" data-sitekey="${esc(turnstileSiteKey)}" style="margin-bottom:12px"></div>` : ""}
          <button type="submit" class="btn btn-primary" id="enter-btn">${status.freeSlots > 0 ? "Launch demo →" : "Join queue →"}</button>
        </form>
      </section>

      <section class="card">
        <h2>
          <span>Runbot</span>
          <span class="pill" id="runbot-pill">Resets in <span id="rb-cd">${esc(formatClock(status.runbotNextResetInMs))}</span></span>
        </h2>
        <p>Shared sandbox, like runbot.odoo.com. Resets every ${esc(runbotInterval)}.</p>
        <a class="btn btn-secondary" href="https://${esc(status.runbotHost)}/web/login">Open Runbot →</a>
      </section>
    </div>
    <p style="text-align:center;margin-top:24px"><a href="/proof" style="color:var(--muted)">Proof that this runs in a Cloudflare Worker →</a></p>
  </main>
  <script>
    (function () {
      let runbotResetAt = ${status.runbotNextResetAt};
      function fmt(ms) {
        const s = Math.max(0, Math.ceil(ms / 1000));
        return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
      }
      function tick() {
        const el = document.getElementById("rb-cd");
        if (el) el.textContent = fmt(runbotResetAt - Date.now());
      }
      tick();
      setInterval(tick, 1000);
      setInterval(async () => {
        try {
          const res = await fetch("/__demo/status", { cache: "no-store" });
          if (!res.ok) return;
          const d = await res.json();
          runbotResetAt = d.runbotNextResetAt;
          const pill = document.getElementById("slot-pill");
          const btn = document.getElementById("enter-btn");
          if (pill) {
            pill.className = "pill " + (d.freeSlots > 0 ? "ok" : "warn");
            pill.textContent = d.freeSlots > 0 ? "Available" : ("Queue: " + d.queueLength);
          }
          if (btn) btn.textContent = d.freeSlots > 0 ? "Launch demo →" : "Join queue →";
        } catch {}
      }, 5000);
    })();
  </script>
</body>
</html>`;
}

export function renderQueuePage(
  queueId: string,
  position: number,
  totalWaiting: number,
  nextFreeInMs: number | null,
  runbotHost: string,
): string {
  const eta = nextFreeInMs === null ? "soon" : `~${formatShortEn(nextFreeInMs)}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Queue — Odoo on Cloudflare Workers</title>
  <style>${BASE_CSS}</style>
</head>
<body>
  <main class="wrap" style="max-width:460px">
    <section class="card queue-card">
      <div class="spinner"></div>
      <span class="pill warn" style="margin:0 auto">All instances busy</span>
      <h1 style="font-size:22px;margin:6px 0 0">Your place in the queue</h1>
      <div class="pos" id="q-pos">#${position}</div>
      <p id="q-meta">${totalWaiting} waiting · Est. wait: <strong>${esc(eta)}</strong></p>
      <div class="creds" style="margin:2px auto 0">Login: <code>admin</code> / <code>admin</code></div>
      <a class="btn btn-secondary" href="https://${esc(runbotHost)}/web/login" style="margin-top:8px">Open shared Runbot →</a>
      <a href="/" style="font-size:13px;color:var(--muted);text-decoration:none;margin-top:2px">← Back</a>
    </section>
  </main>
  <script>
    (function () {
      const q = ${JSON.stringify(queueId)};
      function fmt(ms) {
        if (ms == null) return "soon";
        const s = Math.max(0, Math.ceil(ms / 1000));
        return "~" + (s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s");
      }
      async function poll() {
        try {
          const res = await fetch("/__demo/queue-status?q=" + encodeURIComponent(q), { cache: "no-store" });
          if (!res.ok) return;
          const d = await res.json();
          if (d.kind === "assigned") {
            window.location.replace("https://" + d.host + "/__demo/claim?t=" + encodeURIComponent(d.claimToken));
            return;
          }
          if (d.kind === "gone") {
            window.location.replace("/");
            return;
          }
          const pos = document.getElementById("q-pos");
          const meta = document.getElementById("q-meta");
          if (pos) pos.textContent = "#" + d.position;
          if (meta) meta.innerHTML = d.totalWaiting + " waiting · Est. wait: <strong>" + fmt(d.nextFreeInMs) + "</strong>";
        } catch {}
      }
      setInterval(poll, 2000);
      poll();
    })();
  </script>
</body>
</html>`;
}

/**
 * Compact floating corner badge injected only into `/web/login` and `/odoo` HTML documents.
 */
export function buildDemoBadgeSnippet(opts:
  | { readonly kind: "slot"; readonly slotIndex: number; readonly idleMs: number; readonly launcherHost: string }
  | { readonly kind: "runbot"; readonly nextResetAt: number; readonly launcherHost: string }): string {
  const style =
    "position:fixed;right:12px;bottom:12px;z-index:2147483000;display:flex;align-items:center;gap:10px;" +
    "padding:7px 12px;border-radius:999px;background:rgba(15,23,42,0.92);color:#f8fafc;" +
    "font:500 12px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
    "box-shadow:0 6px 20px rgba(0,0,0,0.28);border:1px solid rgba(255,255,255,0.14);backdrop-filter:blur(8px);";
  const btnStyle =
    "border:0;background:rgba(255,255,255,0.14);color:#fff;padding:4px 9px;border-radius:999px;" +
    "cursor:pointer;font:600 11px/1.2 inherit;text-decoration:none;";

  if (opts.kind === "slot") {
    const idleLabel = formatShortEn(opts.idleMs);
    return `<div id="odoo-ts-demo-bar" style="${style}">` +
      `<span><strong>odoo-ts-${opts.slotIndex}</strong> · admin/admin · ${esc(idleLabel)} idle reset</span>` +
      `<form method="POST" action="/__demo/reset" style="margin:0;display:inline">` +
      `<button type="submit" style="${btnStyle}">Reset</button></form>` +
      `<a href="https://${esc(opts.launcherHost)}" style="${btnStyle}">Home</a>` +
      `</div>` +
      `<script>(function(){var orig=window.fetch;if(!orig)return;window.fetch=function(){return orig.apply(this,arguments).then(function(r){if(r&&r.headers&&r.headers.get("X-Demo-Expired")==="1"){window.location.replace("https://${esc(opts.launcherHost)}/?expired=1");}return r;});};})();</script>`;
  }

  return `<div id="odoo-ts-demo-bar" style="${style}">` +
    `<span><strong>Runbot</strong> · admin/admin · resets in <strong id="odoo-ts-rb-t">--:--</strong></span>` +
    `<a href="https://${esc(opts.launcherHost)}" style="${btnStyle}">Home</a>` +
    `</div>` +
    `<script>(function(){var end=${opts.nextResetAt};function u(){var el=document.getElementById("odoo-ts-rb-t");if(!el)return;var s=Math.max(0,Math.ceil((end-Date.now())/1000));el.textContent=Math.floor(s/60)+":"+String(s%60).padStart(2,"0");}u();setInterval(u,1000);})();</script>`;
}
