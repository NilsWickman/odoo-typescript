import { strict as assert } from "node:assert";
import { pbkdf2Sync } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createKdf } from "./kdf";
import { verifyAndUpdate, verifyPassword } from "./auth";

// Node compiles bytes in this test; Workers only import the precompiled module.
const NodeModule = WebAssembly.Module as unknown as { new(bytes: Uint8Array): WebAssembly.Module };
const module = new NodeModule(readFileSync(fileURLToPath(new URL("./password-kdf.wasm", import.meta.url).href)));
const derive = createKdf(module);

test("RustCrypto Wasm matches native PBKDF2-SHA512, including Odoo's 600000 rounds", () => {
  for (const [password, salt, rounds] of [
    [Buffer.from("password"), Buffer.from("salt"), 1],
    [Buffer.from("räksmörgås 🔑\0"), Buffer.from([0, 255, 128, 1]), 100_000],
    [Buffer.alloc(257, 0xab), Buffer.alloc(300, 0xef), 100_001],
    [Buffer.from("admin"), Buffer.from("odoo-experiment"), 600_000],
    [Buffer.alloc(0), Buffer.alloc(0), 2],
    // Exercise memory growth, then reuse the instance below.
    [Buffer.alloc(2 * 1024 * 1024, 0x61), Buffer.from("salt"), 2],
    [Buffer.from("after growth"), Buffer.from("salt"), 3],
  ] as const) {
    assert.deepEqual(Buffer.from(derive(password, salt, rounds)), pbkdf2Sync(password, salt, rounds, 64, "sha512"));
  }
  for (const rounds of [0, -1, 1.5, NaN, 2 ** 32]) assert.throws(() => derive(Buffer.alloc(0), Buffer.alloc(0), rounds), RangeError);
});

test("Odoo passlib format accepts the correct password and rejects a wrong one through Wasm", async () => {
  const salt = Buffer.from([251, 239, 255, 0, 128, 1]);
  const password = "räksmörgås 🔑";
  const ab64 = (b: Buffer) => b.toString("base64").replace(/\+/g, ".").replace(/=+$/, "");
  const stored = `$pbkdf2-sha512$600000$${ab64(salt)}$${ab64(pbkdf2Sync(password, salt, 600_000, 64, "sha512"))}`;
  const kdf = async (p: Uint8Array, s: Uint8Array, n: number) => derive(p, s, n);
  assert.equal(await verifyPassword(stored, password, kdf), true);
  assert.equal(await verifyPassword(stored, password + "!", kdf), false);
  const unexpected = async (): Promise<Uint8Array> => { throw new Error("must not derive"); };
  assert.equal(await verifyPassword("", password, unexpected), false);
  // another round count is verified in the Worker (the checksum here is the 600000-round one: no match, no update)
  assert.deepEqual(await verifyAndUpdate(stored.replace("600000", "100000"), password, unexpected), { valid: false, replacement: null });
  assert.deepEqual(await verifyAndUpdate(stored, password, kdf), { valid: true, replacement: null });
});

test("verify_and_update: a valid hash of another round count, or plaintext, is replaced by a 600000-round hash", async () => {
  const kdf = async (p: Uint8Array, s: Uint8Array, n: number) => derive(p, s, n);
  const ab64 = (b: Buffer): string => b.toString("base64").replace(/=+$/, "").replace(/\+/g, ".");
  const salt = Buffer.from("other-salt");
  const cheap = `$pbkdf2-sha512$1000$${ab64(salt)}$${ab64(pbkdf2Sync("admin", salt, 1000, 64, "sha512"))}`;
  for (const stored of [cheap, "admin"]) {
    const r = await verifyAndUpdate(stored, "admin", kdf);
    assert.equal(r.valid, true);
    assert.match(r.replacement ?? "", /^\$pbkdf2-sha512\$600000\$[A-Za-z0-9./]{22}\$[A-Za-z0-9./]{86}$/);
    assert.equal(await verifyPassword(r.replacement!, "admin", kdf), true);
    assert.deepEqual(await verifyAndUpdate(stored, "wrong", kdf), { valid: false, replacement: null });
  }
});

test("D18 experiment rounds: an exact configured count verifies in the Worker and is kept; others are re-hashed", async () => {
  const { experimentRounds } = await import("./auth");
  assert.equal(experimentRounds(undefined), null);
  assert.equal(experimentRounds("600000"), null);
  assert.equal(experimentRounds("abc"), null);
  assert.equal(experimentRounds("1000"), 1000);
  const password = "admin";
  const salt = Buffer.from("experiment-salt");
  const ab64 = (b: Buffer): string => b.toString("base64").replace(/=+$/, "").replace(/\+/g, ".");
  const stored = `$pbkdf2-sha512$1000$${ab64(salt)}$${ab64(pbkdf2Sync(password, salt, 1000, 64, "sha512"))}`;
  const unexpected = async (): Promise<Uint8Array> => { throw new Error("the DO must not be called"); };
  assert.equal(await verifyPassword(stored, password, unexpected, 1000), true);
  assert.equal(await verifyPassword(stored, "wrong", unexpected, 1000), false);
  // without the experiment (or with another count) Odoo's verify_and_update rewrites it: the DO derives 600000 rounds
  await assert.rejects(verifyPassword(stored, password, unexpected, null), /the DO must not be called/);
  await assert.rejects(verifyPassword(stored, password, unexpected, 2000), /the DO must not be called/);
});
