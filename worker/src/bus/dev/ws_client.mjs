// Stream B check: connect like the browser's websocket worker, subscribe, update presence, print frames.
// node src/bus/dev/ws_client.mjs ws://127.0.0.1:8083/websocket?version=saas-19.5-1 [last] [channels-json]
// env: HOLD_MS (default 1500) how long to stay open; NO_UA=1 sends no User-Agent (a non-browser skips the version check).
const [url = "ws://127.0.0.1:8083/websocket?version=saas-19.5-1", lastArg = "null", channelsArg = "[]"] = process.argv.slice(2);
const hold = Number(process.env.HOLD_MS ?? "1500");
const headers = { Origin: "http://127.0.0.1:8083", Cookie: "session_id=dev" };
if (process.env.NO_UA === "1") headers["User-Agent"] = "";
const ws = new WebSocket(url, { headers });
const t0 = Date.now();
const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(5)}ms]`, ...a);
ws.addEventListener("open", () => {
  log("open");
  const last = lastArg === "null" ? null : Number(lastArg);
  ws.send(JSON.stringify({ event_name: "subscribe", data: { channels: JSON.parse(channelsArg), check_outdated: last !== null, last } }));
  log("sent subscribe", { last, channels: JSON.parse(channelsArg) });
  setTimeout(() => { ws.send(JSON.stringify({ event_name: "update_presence", data: { inactivity_period: 1234 } })); log("sent update_presence"); }, 400);
  setTimeout(() => { ws.send(new Uint8Array([0])); log("sent connection check 0x00"); }, 800);
  setTimeout(() => { ws.close(1000); log("closing"); }, hold);
});
ws.addEventListener("message", (ev) => log("frame:", typeof ev.data === "string" ? ev.data : `<binary ${ev.data.byteLength}>`));
ws.addEventListener("close", (ev) => { log("close", ev.code, JSON.stringify(ev.reason)); process.exit(0); });
ws.addEventListener("error", (ev) => { log("error", ev.message ?? ev); });
setTimeout(() => { log("timeout"); process.exit(1); }, hold + 6500);
