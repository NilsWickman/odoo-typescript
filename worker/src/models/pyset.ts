/**
 * Python `set`s of non-negative ints (`hash(n) == n` below 2**61 - 1), as CPython 3.12 builds them (the oracle's
 * Python): Objects/setobject.c, an open-addressing table iterated in slot order.
 *   - `set_add_entry`: slot `hash & mask`, then up to LINEAR_PROBES (9) following slots when they fit in the table,
 *     then `i = i * 5 + 1 + (perturb >>= 5)`; after an insertion `fill * 5 >= mask * 3` resizes to `used * 4`.
 *   - `set_table_resize(minused)`: the smallest power of two (at least 8) above `minused`, the entries re-inserted
 *     with `set_insert_clean` in slot order.
 *   - `set_merge` (`s.update(t)`, `set(t)` of a set): one resize up front when `(fill + other.used) * 5 >= mask * 3`
 *     (to `(used + other.used) * 2`), then the other table copied slot for slot when both are empty-vs-same-size,
 *     else inserted clean in its slot order when this one is empty, else added one by one.
 * Checked against CPython 3.12 on random sets (pyset.test.ts).
 */
const LINEAR_PROBES = 9;
const MINSIZE = 8;
const DUMMY = -1;

export class PySet {
  private table: (number | null)[] = new Array<number | null>(MINSIZE).fill(null);
  /** CPython's `fill` (active and dummy slots) and the dummies left by `discard`. */
  private fill = 0;
  private dummies = 0;

  /** `len(self)` (CPython's `used`). */
  get size(): number { return this.fill - this.dummies; }
  private get mask(): number { return this.table.length - 1; }

  static fromList(items: Iterable<number>): PySet {
    const s = new PySet();
    for (const x of items) s.add(x);
    return s;
  }

  private static check(key: number): void {
    if (!Number.isSafeInteger(key) || key < 0) throw new TypeError(`PySet of ${key}: only non-negative ints are ported`);
  }

  private static insertClean(t: (number | null)[], key: number): void {
    const size = t.length, mask = size - 1;
    let perturb = key, i = key % size;
    for (;;) {
      if (t[i] === null) { t[i] = key; return; }
      if (i + LINEAR_PROBES <= mask) {
        for (let j = 1; j <= LINEAR_PROBES; j++) if (t[i + j] === null) { t[i + j] = key; return; }
      }
      perturb = Math.floor(perturb / 32);
      i = (i * 5 + 1 + perturb) % size;
    }
  }

  private resize(minused: number): void {
    let size = MINSIZE;
    while (size <= minused) size *= 2;
    const nt = new Array<number | null>(size).fill(null);
    for (const k of this.order()) PySet.insertClean(nt, k);
    this.fill -= this.dummies;
    this.dummies = 0;
    this.table = nt;
  }

  add(key: number): void {
    PySet.check(key);
    // set_add_entry skips dummy slots without reusing them; the sets with dummies here only come out of `difference`
    if (this.dummies) throw new TypeError("PySet.add after discard is not ported");
    const size = this.table.length, mask = size - 1;
    let perturb = key, i = key % size;
    for (;;) {
      const probes = i + LINEAR_PROBES <= mask ? LINEAR_PROBES : 0;
      for (let j = 0; j <= probes; j++) {
        const k = this.table[i + j];
        if (k === null) {
          this.table[i + j] = key;
          this.fill++;
          if (this.fill * 5 >= mask * 3) this.resize(this.fill > 50000 ? this.fill * 2 : this.fill * 4);
          return;
        }
        if (k === key) return;
      }
      perturb = Math.floor(perturb / 32);
      i = (i * 5 + 1 + perturb) % size;
    }
  }

  /** `self.update(other)` with a set (set_merge). */
  update(other: PySet): void {
    if (other === this || other.size === 0) return;
    if ((this.fill + other.size) * 5 >= this.mask * 3) this.resize((this.size + other.size) * 2);
    if (this.fill === 0 && this.mask === other.mask && other.dummies === 0) {
      this.table = [...other.table];
      this.fill = other.fill;
      return;
    }
    if (this.fill === 0) {
      for (const k of other.order()) PySet.insertClean(this.table, k);
      this.fill = other.size;
      return;
    }
    for (const k of other.order()) this.add(k);
  }

  has(key: number): boolean {
    return this.table.includes(key);
  }

  /** `self.discard(key)` (set_discard_entry): the slot becomes a dummy, skipped by iteration. */
  discard(key: number): void {
    const i = this.table.indexOf(key);
    if (i < 0) return;
    this.table[i] = DUMMY;
    this.dummies++;
  }

  /** `self - other` (set_difference): a copy with other's elements discarded when self is over four times larger
   *  (set_copy_and_difference), else a new set of self's elements not in other, added in slot order. */
  difference(other: PySet): PySet {
    const out = new PySet();
    if ((this.size >> 2) > other.size) {
      out.update(this);
      for (const k of other.order()) out.discard(k);
      return out;
    }
    for (const k of this.order()) if (!other.has(k)) out.add(k);
    return out;
  }

  /** `list(self)` */
  order(): number[] {
    return this.table.filter((k): k is number => k !== null && k !== DUMMY);
  }
}

/** `list(set(ids))` with the ids added in the given order. */
export function pySetOrder(ids: readonly number[]): number[] {
  return PySet.fromList(ids).order();
}
