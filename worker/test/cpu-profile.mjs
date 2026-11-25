// Local workerd CPU sampling, not a claim about hosted Cloudflare CPU accounting.
// Start `PORT=8074 ./start.sh` against dev_cf1 first. Uses only the test admin/admin user.
// Run: node test/cpu-profile.mjs [output-directory]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
// Wrangler's local inspector requires an Origin header (the Node global WebSocket cannot set one).
import WebSocket from "ws";

const origin = process.env.ODOO_PROFILE_URL ?? "http://127.0.0.1:8074";
const db = process.env.ODOO_TEST_DB ?? "dev_cf1";
const output = resolve(process.argv[2] ?? "../results/cf/cpu-local");
await mkdir(output, { recursive: true });
await (await fetch(`${origin}/health`)).text();
const targets = await (await fetch("http://127.0.0.1:9229/json/list")).json();
const socket = new WebSocket(targets[0].webSocketDebuggerUrl, { origin: "http://localhost:9229" });
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let sequence = 0;
const pending = new Map();
socket.addEventListener("message", ({ data }) => {
  const result = JSON.parse(data);
  const callback = pending.get(result.id);
  if (callback) {
    pending.delete(result.id);
    if (result.error) callback.reject(new Error(JSON.stringify(result.error)));
    else callback.resolve(result.result);
  }
});
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Inspector timed out: ${method}`)); }, 15000);
    pending.set(id, {
      resolve: (result) => { clearTimeout(timer); resolve(result); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

let cookie = "";
async function rpc(path, params) {
  const response = await fetch(`${origin}${path}?db=${encodeURIComponent(db)}`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, params }),
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(`RPC failed: ${path}: ${JSON.stringify(body.error)}`);
  return body.result;
}

const summary = [];
async function profile(name, request) {
  await cdp("Profiler.start");
  const start = performance.now();
  let profile;
  try { await request(); }
  finally { ({ profile } = await cdp("Profiler.stop")); }
  const wallMs = performance.now() - start;
  await writeFile(`${output}/${name}.cpuprofile`, JSON.stringify(profile));
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const samplesByFunction = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    const node = nodes.get(profile.samples[i]);
    const fn = node.callFrame.functionName || "(anonymous)";
    samplesByFunction.set(fn, (samplesByFunction.get(fn) ?? 0) + profile.timeDeltas[i] / 1000);
  }
  const activeSampleMs = [...samplesByFunction].reduce((sum, [fn, ms]) =>
    sum + (["(idle)", "(root)"].includes(fn) ? 0 : ms), 0);
  const row = { name, wallMs, activeSampleMs,
    topFunctions: [...samplesByFunction].sort((a, b) => b[1] - a[1]).slice(0, 8) };
  summary.push(row);
  console.log(JSON.stringify(row));
}

try {
  await cdp("Profiler.enable");
  await cdp("Profiler.setSamplingInterval", { interval: 1000 });
  await profile("health", async () => { await (await fetch(`${origin}/health`)).text(); });
  // Like the browser, select the database through /web/login before authenticating the session.
  const selectDb = await fetch(`${origin}/web/login?db=${encodeURIComponent(db)}`, { redirect: "manual" });
  cookie = selectDb.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  await selectDb.text();
  for (let i = 1; i <= 3; i++) {
    await profile(`login-${i}`, () => rpc("/web/session/authenticate", { db, login: "admin", password: "admin" }));
  }
  const contacts = JSON.parse(await readFile(new URL("./contacts-request.json", import.meta.url), "utf8"));
  await profile("contacts-list", () => rpc("/web/dataset/call_kw/res.partner/web_search_read", contacts));
  await writeFile(`${output}/summary.json`, JSON.stringify({
    note: "Local V8 sampled execution time includes profiling overhead; not hosted CPU enforcement. Database waiting is mostly idle samples.",
    origin, db, samplingIntervalUs: 1000, samples: summary,
  }, null, 2) + "\n");
} finally {
  socket.close();
}
