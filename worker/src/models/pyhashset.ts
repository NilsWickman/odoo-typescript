/**
 * A Python `set` of hashable values other than strings, with CPython 3.12's table (Objects/setobject.c, the same
 * algorithm as src/web/pystrset.ts) and CPython's hashes of the values Odoo puts in them: naive `datetime`
 * (Modules/_datetimemodule.c `datetime_hash`: `_Py_HashBytes` of its 10 data bytes, SipHash-1-3 with the zero key of
 * `PYTHONHASHSEED=0`) and tuples (Objects/tupleobject.c `tuplehash`, the xxHash-based mix of 3.8+). The iteration
 * order of such a set (e.g. calendar_recurrence.py:221-233 `_reconcile_events` over `(start, stop)` ranges) decides the
 * order Odoo creates records in.
 */
import { pyBytesHash } from "../orm/pyset";
import { formatNaive, type Naive } from "../web/tz";

const M64 = (1n << 64n) - 1n;
const LINEAR_PROBES = 9, PERTURB_SHIFT = 5n, MINSIZE = 8;

/** `hash(datetime(...))` of a naive datetime without microseconds (fold 0), as an unsigned 64-bit value. */
export function pyDatetimeHash(n: Naive): bigint {
  // _PyDateTime_DATETIME_DATASIZE: year (2 bytes, big-endian), month, day, hour, minute, second, microsecond (3 bytes)
  const data = new Uint8Array([n.year >> 8, n.year & 0xff, n.month, n.day, n.hour, n.minute, n.second, 0, 0, 0]);
  return pyBytesHash(data);
}

const XXPRIME_1 = 11400714785074694791n, XXPRIME_2 = 14029467366897019727n, XXPRIME_5 = 2870177450012600261n;

/** tupleobject.c tuplehash of a tuple whose items hash to `lanes` (unsigned 64-bit). */
export function pyTupleHash(lanes: readonly bigint[]): bigint {
  let acc = XXPRIME_5;
  for (const lane of lanes) {
    acc = (acc + lane * XXPRIME_2) & M64;
    acc = ((acc << 31n) | (acc >> 33n)) & M64;
    acc = (acc * XXPRIME_1) & M64;
  }
  acc = (acc + (BigInt(lanes.length) ^ (XXPRIME_5 ^ 3527539n))) & M64;
  return acc === M64 ? 1546275796n : acc;
}

/** A set of values with their hash and an equality key; iteration is CPython's slot order. */
export class PyHashSet<T> implements Iterable<T> {
  private items: (T | null)[] = new Array<T | null>(MINSIZE).fill(null);
  private keys: (string | null)[] = new Array<string | null>(MINSIZE).fill(null);
  private hashes: bigint[] = new Array<bigint>(MINSIZE).fill(0n);
  private fill = 0;

  constructor(private readonly hashOf: (v: T) => bigint, private readonly keyOf: (v: T) => string) {}

  get size(): number {
    return this.fill;
  }

  private insertClean(items: (T | null)[], keys: (string | null)[], hashes: bigint[], item: T, key: string, hash: bigint): void {
    const mask = BigInt(items.length - 1);
    let perturb = hash, i = hash & mask;
    for (;;) {
      let j = Number(i);
      if (keys[j] === null) { items[j] = item; keys[j] = key; hashes[j] = hash; return; }
      if (j + LINEAR_PROBES <= items.length - 1) {
        for (let k = 0; k < LINEAR_PROBES; k++) {
          j++;
          if (keys[j] === null) { items[j] = item; keys[j] = key; hashes[j] = hash; return; }
        }
      }
      perturb >>= PERTURB_SHIFT;
      i = (i * 5n + 1n + perturb) & mask;
    }
  }

  private resize(minused: number): void {
    let size = MINSIZE;
    while (size <= minused) size <<= 1;
    const items = new Array<T | null>(size).fill(null), keys = new Array<string | null>(size).fill(null), hashes = new Array<bigint>(size).fill(0n);
    this.keys.forEach((k, idx) => { if (k !== null) this.insertClean(items, keys, hashes, this.items[idx]!, k, this.hashes[idx]!); });
    this.items = items; this.keys = keys; this.hashes = hashes;
  }

  has(v: T): boolean {
    const key = this.keyOf(v);
    return this.keys.includes(key);
  }

  /** setobject.c set_add_entry (nothing is ever removed, so no dummies). */
  add(v: T): this {
    const key = this.keyOf(v), hash = this.hashOf(v);
    const mask = this.items.length - 1;
    let perturb = hash, i = hash & BigInt(mask);
    for (;;) {
      let j = Number(i);
      let probes = j + LINEAR_PROBES <= mask ? LINEAR_PROBES : 0;
      for (;;) {
        if (this.keys[j] === null) {
          this.items[j] = v; this.keys[j] = key; this.hashes[j] = hash; this.fill++;
          if (this.fill * 5 >= mask * 3) this.resize(this.fill > 50000 ? this.fill * 2 : this.fill * 4);
          return this;
        }
        if (this.hashes[j] === hash && this.keys[j] === key) return this;
        if (probes-- === 0) break;
        j++;
      }
      perturb >>= PERTURB_SHIFT;
      i = (i * 5n + 1n + perturb) & BigInt(mask);
    }
  }

  /** `set(other)`: setobject.c set_merge into an empty set (a copy of the slots when the sizes agree). */
  copy(): PyHashSet<T> {
    const out = new PyHashSet<T>(this.hashOf, this.keyOf);
    if (this.fill === 0) return out;
    if (this.fill * 5 >= (out.items.length - 1) * 3) out.resize(this.fill * 2); // (so.fill + other.used) * 5 >= so.mask * 3
    if (out.items.length === this.items.length) {
      out.items = [...this.items]; out.keys = [...this.keys]; out.hashes = [...this.hashes];
    } else {
      this.keys.forEach((k, idx) => { if (k !== null) out.insertClean(out.items, out.keys, out.hashes, this.items[idx]!, k, this.hashes[idx]!); });
    }
    out.fill = this.fill;
    return out;
  }

  *[Symbol.iterator](): Iterator<T> {
    for (let j = 0; j < this.items.length; j++) if (this.keys[j] !== null) yield this.items[j]!;
  }
}

/** A `(start, stop)` range of naive datetimes as a Python tuple in a set. */
export type DtRange = readonly [Naive, Naive];

export function rangeSet(): PyHashSet<DtRange> {
  return new PyHashSet<DtRange>(
    (r) => pyTupleHash([pyDatetimeHash(r[0]), pyDatetimeHash(r[1])]),
    (r) => `${formatNaive(r[0], true)}|${formatNaive(r[1], true)}`,
  );
}
