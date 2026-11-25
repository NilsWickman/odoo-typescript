import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pyDatetimeHash, pyTupleHash, rangeSet } from "./pyhashset";
import { dateToNaive, formatNaive, naiveToUtcDate, parseNaive, type Naive } from "../web/tz";

// test/pyhashset_cases.json: CPython 3.12 with PYTHONHASHSEED=0 (test/pyhashset_cases.py)
const CASES = JSON.parse(readFileSync(fileURLToPath(new URL("../../test/pyhashset_cases.json", import.meta.url).href), "utf8")) as {
  hashes: [string, string, number | string, number | string][];
  sets: [string[], number, string, string[]][];
};

const plus = (n: Naive, minutes: number): Naive => dateToNaive(new Date(naiveToUtcDate(n).getTime() + minutes * 60000));

test("hash() of datetimes and (start, stop) tuples as CPython", () => {
  for (const [a, b, ha, ht] of CASES.hashes) {
    const na = parseNaive(a)!, nb = parseNaive(b)!;
    assert.equal(pyDatetimeHash(na), BigInt(ha), a);
    assert.equal(pyTupleHash([pyDatetimeHash(na), pyDatetimeHash(nb)]), BigInt(ht), `${a} ${b}`);
  }
});

test("a filtered and copied set of ranges iterates as CPython's", () => {
  for (const [starts, minutes, cut, expected] of CASES.sets) {
    const ranges = rangeSet();
    for (const s of starts) { const n = parseNaive(s)!; ranges.add([n, plus(n, minutes)]); }
    const kept = rangeSet();
    const cutDate = cut.slice(0, 10);
    for (const r of ranges) if (formatNaive(r[0], false) >= cutDate) kept.add(r);
    assert.deepEqual([...kept.copy()].map((r) => formatNaive(r[0], true)), expected);
  }
});
