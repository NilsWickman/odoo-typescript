/**
 * A Python `set` of strings with CPython 3.12's table (Objects/setobject.c), so that iterating it yields the order
 * Python's does under `PYTHONHASHSEED=0` (the oracle's seed, proofs/oracle.sh). `pySetOrder` (src/orm/pyset.ts) covers
 * a set built by `add` alone; Odoo code that unions sets (`values |= other`, view_validation.py:150-226) also depends
 * on `set_merge`, which resizes once up front to `(used + other.used) * 2` and copies or reinserts the other table in
 * slot order, so the table size (and with it the order) differs from adding the same strings one by one.
 */
import { pyStrHash } from "../orm/pyset";

const LINEAR_PROBES = 9, PERTURB_SHIFT = 5n, MINSIZE = 8;

export class PyStrSet implements Iterable<string> {
  private keys: (string | null)[] = new Array<string | null>(MINSIZE).fill(null);
  private hashes: bigint[] = new Array<bigint>(MINSIZE).fill(0n);
  private fill = 0;

  static of(...items: string[]): PyStrSet {
    const s = new PyStrSet();
    for (const item of items) s.add(item);
    return s;
  }

  get size(): number {
    return this.fill;
  }

  private get mask(): number {
    return this.keys.length - 1;
  }

  /** setobject.c set_insert_clean: a key known to be absent, into a table without dummies. */
  private static insertClean(keys: (string | null)[], hashes: bigint[], key: string, hash: bigint): void {
    const mask = BigInt(keys.length - 1);
    let perturb = hash, i = hash & mask;
    for (;;) {
      let j = Number(i);
      if (keys[j] === null) { keys[j] = key; hashes[j] = hash; return; }
      if (j + LINEAR_PROBES <= keys.length - 1) {
        for (let k = 0; k < LINEAR_PROBES; k++) {
          j++;
          if (keys[j] === null) { keys[j] = key; hashes[j] = hash; return; }
        }
      }
      perturb >>= PERTURB_SHIFT;
      i = (i * 5n + 1n + perturb) & mask;
    }
  }

  /** setobject.c set_table_resize(so, minused): the smallest power of two above minused, entries reinserted in slot order. */
  private resize(minused: number): void {
    let size = MINSIZE;
    while (size <= minused) size <<= 1;
    const keys = new Array<string | null>(size).fill(null), hashes = new Array<bigint>(size).fill(0n);
    this.keys.forEach((k, idx) => { if (k !== null) PyStrSet.insertClean(keys, hashes, k, this.hashes[idx]!); });
    this.keys = keys; this.hashes = hashes;
  }

  has(key: string): boolean {
    const hash = pyStrHash(key);
    for (let j = 0; j < this.keys.length; j++) if (this.keys[j] === key && this.hashes[j] === hash) return true;
    return false;
  }

  /** setobject.c set_add_entry (no dummies: nothing is ever removed). */
  add(key: string, hash: bigint = pyStrHash(key)): this {
    const mask = this.mask;
    let perturb = hash, i = hash & BigInt(mask);
    for (;;) {
      let j = Number(i);
      let probes = j + LINEAR_PROBES <= mask ? LINEAR_PROBES : 0;
      for (;;) {
        if (this.keys[j] === null) {
          this.keys[j] = key; this.hashes[j] = hash; this.fill++;
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

  /** `self |= other`: setobject.c set_merge. */
  update(other: PyStrSet): this {
    if (other === this || other.fill === 0) return this;
    if ((this.fill + other.fill) * 5 >= this.mask * 3) this.resize((this.fill + other.fill) * 2);
    if (this.fill === 0) {
      if (this.mask === other.mask) {
        // same size, no dummies: copy the slots
        this.keys = [...other.keys]; this.hashes = [...other.hashes];
      } else {
        other.keys.forEach((k, idx) => { if (k !== null) PyStrSet.insertClean(this.keys, this.hashes, k, other.hashes[idx]!); });
      }
      this.fill = other.fill;
      return this;
    }
    other.keys.forEach((k, idx) => { if (k !== null) this.add(k, other.hashes[idx]!); });
    return this;
  }

  *[Symbol.iterator](): Iterator<string> {
    for (const k of this.keys) if (k !== null) yield k;
  }
}
