import { test } from "node:test";
import assert from "node:assert/strict";
import { Phases } from "./phases";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parse(fields: string): Record<string, string> {
  return Object.fromEntries(fields.split(" ").map((kv) => kv.split("=") as [string, string]));
}

test("the phases add up to the time to the response, and the waitUntil work is waited for", async () => {
  const ph = new Phases();
  const later: Promise<unknown>[] = [];
  const exec = ph.track({ waitUntil: (p) => { later.push(p); } });
  await sleep(15);
  ph.enter("auth");
  await ph.time("regt", sleep(10));
  ph.enter("disp");
  // two statements unanswered over the same sleep: the time counts once. How long the sleep really took is measured
  // around them, since a timer of 10 ms fires late on a busy machine (32 ms at load 11-20 made `sqlw < 30` fail a
  // merge check, mx44 2026-11-13); counted twice it would be about two times that.
  const sqlFrom = performance.now();
  ph.sqlBegin();
  ph.sqlBegin();
  await sleep(10);
  ph.sqlEnd();
  ph.sqlEnd();
  const sqlTook = performance.now() - sqlFrom;
  // a waitUntil that adds another while it runs
  exec.waitUntil(sleep(5).then(() => exec.waitUntil(sleep(20))));
  ph.responded();
  await ph.settled();
  assert.equal(later.length, 2);
  const f = parse(ph.fields());
  const parts: Record<string, string> = Object.fromEntries(f["ph"]!.split(",").map((p) => p.split(":") as [string, string]));
  const sum = Object.values(parts).reduce((a, v) => a + Number(v), 0);
  assert.ok(Math.abs(sum - Number(f["resp"])) <= 8, `${sum} vs ${f["resp"]}`);
  assert.ok(Number(parts["sess"] ?? 0) >= 13);
  assert.ok(Number(f["regt"]) >= 8);
  assert.ok(Number(f["sqlw"]) >= 8 && Number(f["sqlw"]) <= sqlTook + 1, `sqlw ${f["sqlw"]}, the sleep took ${sqlTook.toFixed(1)} ms`);
  assert.ok(Number(f["wu"]) >= 20, `wu ${f["wu"]}`);
  assert.match(f["conc"]!, /^\d+\/\d+$/);
  ph.done();
});

test("requests in flight at once see each other", () => {
  const a = new Phases();
  const b = new Phases();
  assert.equal(b.othersAtStart, a.othersAtStart + 1);
  assert.ok(a.othersMax >= 1);
  assert.equal(b.nth, a.nth + 1);
  a.done();
  b.done();
  const c = new Phases();
  assert.equal(c.othersAtStart, a.othersAtStart);
  c.done();
});
