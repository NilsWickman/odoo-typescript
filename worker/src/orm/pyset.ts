/**
 * The iteration order of a Python `set` of strings, as CPython 3.12 builds it with `PYTHONHASHSEED=0` (the seed the
 * oracle and the generators pin, worker/gen/_odoo.py): `hash(str)` is SipHash-1-3 over the string's PEP 393 buffer
 * with a zero key (Python/pyhash.c `siphash13`, Python/bootstrap_hash.c: seed 0 zeroes `_Py_HashSecret`), and the set
 * is an open-addressing table (Objects/setobject.c `set_add_entry`, `set_insert_clean`, `set_table_resize`) iterated
 * in slot order. Odoo code that returns `list(set(...))` (e.g. account partner.py:370-379) is ordered by this.
 */
const M64 = (1n << 64n) - 1n;

function rotl(x: bigint, b: bigint): bigint {
  return ((x << b) | (x >> (64n - b))) & M64;
}

/** Python/pyhash.c:367-418 siphash13 (k0 = k1 = 0). */
function siphash13(data: Uint8Array): bigint {
  let v0 = 0x736f6d6570736575n, v1 = 0x646f72616e646f6dn, v2 = 0x6c7967656e657261n, v3 = 0x7465646279746573n;
  const round = () => {
    // HALF_ROUND(v0, v1, v2, v3, 13, 16); HALF_ROUND(v2, v1, v0, v3, 17, 21)
    v0 = (v0 + v1) & M64; v2 = (v2 + v3) & M64; v1 = rotl(v1, 13n) ^ v0; v3 = rotl(v3, 16n) ^ v2; v0 = rotl(v0, 32n);
    v2 = (v2 + v1) & M64; v0 = (v0 + v3) & M64; v1 = rotl(v1, 17n) ^ v2; v3 = rotl(v3, 21n) ^ v0; v2 = rotl(v2, 32n);
  };
  const le = (off: number, n: number): bigint => {
    let x = 0n;
    for (let i = n - 1; i >= 0; i--) x = (x << 8n) | BigInt(data[off + i]!);
    return x;
  };
  let off = 0;
  for (; data.length - off >= 8; off += 8) {
    const mi = le(off, 8);
    v3 ^= mi; round(); v0 ^= mi;
  }
  const b = ((BigInt(data.length) << 56n) | le(off, data.length - off)) & M64;
  v3 ^= b; round(); v0 ^= b;
  v2 ^= 0xffn; round(); round(); round();
  return (v0 ^ v1) ^ (v2 ^ v3);
}

/** `_Py_HashBytes(data, len)` (Python/pyhash.c): the hash of a buffer (bytes, datetime data) as an unsigned 64-bit value. */
export function pyBytesHash(data: Uint8Array): bigint {
  if (!data.length) return 0n;
  const h = siphash13(data);
  return h === M64 ? M64 - 1n : h; // -1 is reserved: -2
}

/** `hash(s)` of a str as an unsigned 64-bit value (Py_hash_t reinterpreted as size_t, as the set uses it). */
export function pyStrHash(s: string): bigint {
  const cps = [...s].map((c) => c.codePointAt(0)!);
  if (!cps.length) return 0n; // pyhash.c _Py_HashBytes: len 0 -> 0
  const max = Math.max(...cps);
  const width = max < 256 ? 1 : max < 65536 ? 2 : 4; // PEP 393 kind
  const buf = new Uint8Array(cps.length * width);
  cps.forEach((cp, i) => { for (let k = 0; k < width; k++) buf[i * width + k] = (cp >> (8 * k)) & 0xff; });
  const h = siphash13(buf);
  return h === M64 ? M64 - 1n : h; // -1 is reserved: -2
}

const LINEAR_PROBES = 9, PERTURB_SHIFT = 5n, MINSIZE = 8;

/** Objects/setobject.c: the strings of `items` in the order `for x in set(items)` yields them. */
export function pySetOrder(items: readonly string[]): string[] {
  let table: (string | null)[] = new Array<string | null>(MINSIZE).fill(null);
  let hashes: bigint[] = new Array<bigint>(MINSIZE).fill(0n);
  let fill = 0;
  const insertClean = (t: (string | null)[], hs: bigint[], key: string, hash: bigint) => {
    const mask = BigInt(t.length - 1);
    let perturb = hash, i = hash & mask;
    for (;;) {
      let j = Number(i);
      if (t[j] === null) { t[j] = key; hs[j] = hash; return; }
      if (j + LINEAR_PROBES <= t.length - 1) {
        for (let k = 0; k < LINEAR_PROBES; k++) {
          j++;
          if (t[j] === null) { t[j] = key; hs[j] = hash; return; }
        }
      }
      perturb >>= PERTURB_SHIFT;
      i = (i * 5n + 1n + perturb) & mask;
    }
  };
  for (const key of items) {
    const hash = pyStrHash(key);
    const mask = table.length - 1;
    let perturb = hash, i = hash & BigInt(mask);
    let found = false, slot = -1;
    outer: for (;;) {
      let j = Number(i);
      let probes = j + LINEAR_PROBES <= mask ? LINEAR_PROBES : 0;
      for (;;) {
        if (table[j] === null) { slot = j; break outer; }
        if (hashes[j] === hash && table[j] === key) { found = true; break outer; }
        if (probes-- === 0) break;
        j++;
      }
      perturb >>= PERTURB_SHIFT;
      i = (i * 5n + 1n + perturb) & BigInt(mask);
    }
    if (found) continue;
    table[slot] = key; hashes[slot] = hash; fill++;
    if (fill * 5 < mask * 3) continue;
    // set_table_resize(so, used * 4): the smallest power of two above it, entries reinserted in slot order
    let size = MINSIZE;
    while (size <= fill * 4) size <<= 1;
    const nt = new Array<string | null>(size).fill(null), nh = new Array<bigint>(size).fill(0n);
    table.forEach((k, idx) => { if (k !== null) insertClean(nt, nh, k, hashes[idx]!); });
    table = nt; hashes = nh;
  }
  return table.filter((k): k is string => k !== null);
}
