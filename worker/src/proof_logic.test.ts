import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { DEFAULT_DEMO_CONFIG, parseDemoHost } from "./demo/pool_logic";
import { cachedFacts, PROOF_FACTS_TTL_MS, proofDbs, proofRoute, resetProofCache } from "./proof_logic";

const kind = (host: string) => parseDemoHost(host, DEFAULT_DEMO_CONFIG).kind;

describe("/proof routing", () => {
  it("private site (DEMO_MODE off): /proof is the page for any method, below it 404, the rest untouched", () => {
    assert.equal(proofRoute("/proof", "GET", null), "page");
    assert.equal(proofRoute("/proof", "POST", null), "page");
    assert.equal(proofRoute("/proof/", "GET", null), "not_found");
    assert.equal(proofRoute("/proof/x", "GET", null), "not_found");
    assert.equal(proofRoute("/proofs", "GET", null), null);
    assert.equal(proofRoute("/odoo", "GET", null), null);
    assert.equal(proofRoute("/", "GET", null), null);
  });

  it("demo (DEMO_MODE=1): GET and HEAD /proof on the launcher, the Runbot and every slot host", () => {
    const hosts = ["odoo-ts-demo.example.com", "odoo-ts-runbot.example.com", "odoo-ts-1.example.com",
      `odoo-ts-${DEFAULT_DEMO_CONFIG.slotCount}.example.com`, "ODOO-TS-DEMO.example.com:443"];
    for (const h of hosts) {
      assert.notEqual(kind(h), "unknown", h);
      assert.equal(proofRoute("/proof", "GET", kind(h)), "page", h);
      assert.equal(proofRoute("/proof", "HEAD", kind(h)), "page", h);
      assert.equal(proofRoute("/proof/", "GET", kind(h)), "not_found", h);
      assert.equal(proofRoute("/proof/x/y", "POST", kind(h)), "not_found", h);
      // everything else still goes to the demo router (lease, queue, pool)
      for (const p of ["/", "/web/login", "/__demo/enter", "/__demo/status", "/queue", "/proofs"]) {
        assert.equal(proofRoute(p, "GET", kind(h)), null, `${h}${p}`);
      }
      assert.equal(proofRoute("/proof", "POST", kind(h)), null, h);
    }
  });

  it("demo: an unknown host is left to the demo router (its redirect to the launcher)", () => {
    for (const h of ["example.com", "odoo-ts.example.com", `odoo-ts-${DEFAULT_DEMO_CONFIG.slotCount + 1}.example.com`, "odoo-ts-0.example.com"]) {
      assert.equal(kind(h), "unknown", h);
      assert.equal(proofRoute("/proof", "GET", kind(h)), null, h);
      assert.equal(proofRoute("/proof/x", "GET", kind(h)), null, h);
    }
  });
});

describe("/proof databases", () => {
  it("PROOF_DB wins, commas name several; on the demo without it the Runbot's two, never the template", () => {
    assert.deepEqual(proofDbs({}), []);
    assert.deepEqual(proofDbs({ PROOF_DB: "odoo_db" }), ["odoo_db"]);
    assert.deepEqual(proofDbs({ PROOF_DB: " a , ,b " , DEMO_MODE: "1" }), ["a", "b"]);
    assert.deepEqual(proofDbs({ DEMO_MODE: "1" }), ["demo_runbot_a", "demo_runbot_b"]);
    assert.deepEqual(proofDbs({ DEMO_MODE: "0" }), []);
  });
});

describe("/proof facts cache", () => {
  beforeEach(() => resetProofCache());

  it("reads once per minute per isolate, then again", async () => {
    let t = 1_000_000;
    const reads: string[] = [];
    const read = async (db: string) => { reads.push(db); return { n: reads.length }; };
    const a = await cachedFacts(["d"], read, () => t);
    assert.deepEqual(a, { facts: { n: 1 }, db: "d", at: 1_000_000 });
    t += PROOF_FACTS_TTL_MS - 1;
    for (let i = 0; i < 50; i++) assert.deepEqual((await cachedFacts(["d"], read, () => t)).facts, { n: 1 });
    assert.equal(reads.length, 1);
    t += 1;
    const b = await cachedFacts(["d"], read, () => t);
    assert.deepEqual(b, { facts: { n: 2 }, db: "d", at: t });
    assert.equal(reads.length, 2);
  });

  it("falls back to the next database, tries the one that answered first next time, caches no failure", async () => {
    let t = 0;
    const down = new Set(["a"]);
    const reads: string[] = [];
    const read = async (db: string) => { reads.push(db); if (down.has(db)) throw new Error(`${db} down`); return db; };
    assert.equal((await cachedFacts(["a", "b"], read, () => t)).db, "b");
    assert.deepEqual(reads, ["a", "b"]);
    t += PROOF_FACTS_TTL_MS;
    down.clear();
    reads.length = 0;
    assert.equal((await cachedFacts(["a", "b"], read, () => t)).db, "b");
    assert.deepEqual(reads, ["b"]);
    t += PROOF_FACTS_TTL_MS;
    down.add("a").add("b");
    reads.length = 0;
    await assert.rejects(cachedFacts(["a", "b"], read, () => t), /a down/);
    assert.deepEqual(reads, ["b", "a"]);
    down.clear();
    reads.length = 0;
    assert.equal((await cachedFacts(["a", "b"], read, () => t)).db, "b");
    assert.deepEqual(reads, ["b"]);
  });

  it("a different database list is a different entry", async () => {
    const read = async (db: string) => db;
    assert.equal((await cachedFacts(["x"], read, () => 0)).facts, "x");
    assert.equal((await cachedFacts(["y"], read, () => 1)).facts, "y");
  });

  it("with no database it throws", async () => {
    await assert.rejects(cachedFacts([], async () => 1, () => 0));
  });
});
