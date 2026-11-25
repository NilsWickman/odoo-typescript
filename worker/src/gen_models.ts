/**
 * gen/out/models.json and gen/out/poc_erp/models.json (5 and 17 MB), the generated model metadata that src/index.ts
 * (the registry's) and src/orm/genmeta.ts read. Both callers get the same object, as both got the same module.
 *
 * The Worker bundles each as its models.pack (gen/models_pack.py, a Data module of wrangler.jsonc's `rules`): a line
 * of JSON that names the models and the size of each one's chunk, then every model's compact JSON as its own
 * raw-deflate chunk. The `models` object is lazy (C2d): a model is inflated and parsed when it is first read, and a
 * request touches a few dozen of the 234 / 519.
 *
 * How it came to this. Bundled as JSON, esbuild made the files a JavaScript object literal whose evaluation took
 * 520-560 ms on an isolate's first use of poc_erp (C2c). As Text modules parsed whole, an isolate's first request
 * with a database paid 34 / 117 ms (C2d). As Text modules indexed by model, the text stayed in the heap for the
 * isolate's whole life: 57.8 MB while 138 characters above 255 made V8 hold it with two bytes a character, 28.9 MB
 * as ASCII, 21.6 MB without indentation (docs/infra-2026-11-13.md sections 1 and 12), of the 128 MB an isolate has.
 * The packs are 1.5 MB, outside the JavaScript heap.
 */
import { inflateRawSync } from "node:zlib";

const files = new Map<string, Promise<{ models: Readonly<Record<string, unknown>> }>>();
const given = new Map<string, ArrayBuffer>();

/**
 * The packs from the Worker's entry module, which imports them statically (src/index.ts), so that no `import()` runs
 * for them in an isolate: Cloudflare refuses a dynamic import in an isolate over its memory limit ("Dynamic import
 * exceeded memory limits", docs/infra-2026-11-13.md section 11), and an isolate that had served one template for long
 * would have failed at its first request for the other. Not given (node's test runner, which does not load the entry
 * module): the import below.
 */
export function provideModelPacks(packs: Readonly<Record<"" | "poc_erp", ArrayBuffer>>): void {
  for (const [dir, pack] of Object.entries(packs)) given.set(dir, pack);
}

export function genModelsFile(dir: "" | "poc_erp"): Promise<{ models: Readonly<Record<string, unknown>> }> {
  let p = files.get(dir);
  if (p === undefined) {
    const pack = given.get(dir);
    p = (pack !== undefined ? Promise.resolve({ default: pack }) : dir === "poc_erp" ? import("../gen/out/poc_erp/models.pack") : import("../gen/out/models.pack"))
      .then((m: { default: ArrayBuffer }) => ({ models: packedModels(new Uint8Array(m.default)) }));
    files.set(dir, p);
  }
  return p;
}

/** The lazy records made here (src/orm/overlay.ts layers an overlay over one without reading every model). */
const LAZY = new WeakSet<object>();

export function isLazyRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && LAZY.has(value);
}

/**
 * A models.pack's `models` object, each model inflated and parsed from its chunk at first read. The pack is refused
 * unless its head line and its length agree (gen/models_pack.py writes both).
 */
export function packedModels(pack: Uint8Array): Readonly<Record<string, unknown>> {
  const end = pack.indexOf(10);
  if (end < 0) throw new TypeError("models.pack: no head line");
  const head = JSON.parse(new TextDecoder().decode(pack.subarray(0, end))) as { format?: unknown; models?: unknown };
  if (head.format !== "models.pack/1" || !Array.isArray(head.models)) throw new TypeError("models.pack: not a models.pack/1 file");
  const index = new Map<string, readonly [number, number]>();
  let at = end + 1;
  for (const entry of head.models as unknown[]) {
    const [name, size] = Array.isArray(entry) ? (entry as unknown[]) : [];
    if (typeof name !== "string" || typeof size !== "number" || !Number.isInteger(size) || size <= 0 || index.has(name)) throw new TypeError("models.pack: a bad entry in the head line");
    index.set(name, [at, at + size]);
    at += size;
  }
  if (at !== pack.length) throw new TypeError(`models.pack: ${pack.length} bytes, the head line says ${at}`);
  const parsed = new Map<string, unknown>();
  const get = (name: string): unknown => {
    const done = parsed.get(name);
    if (done !== undefined) return done;
    const span = index.get(name);
    if (span === undefined) return undefined;
    // the chunk is ASCII (gen/models_pack.py), so latin1 reads it byte for character
    const value: unknown = JSON.parse(inflateRawSync(pack.subarray(span[0], span[1])).toString("latin1"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`models.pack: model ${name} is not an object`);
    parsed.set(name, value);
    return value;
  };
  const proxy = new Proxy(Object.create(null) as Record<string, unknown>, {
    get: (_t, p) => (typeof p === "string" ? get(p) : undefined),
    has: (_t, p) => typeof p === "string" && index.has(p),
    ownKeys: () => [...index.keys()],
    getOwnPropertyDescriptor: (_t, p) => (typeof p === "string" && index.has(p) ? { value: get(p), enumerable: true, configurable: true, writable: false } : undefined),
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  });
  LAZY.add(proxy);
  return proxy;
}

/** `{ ...base, ...over }` without reading base's models: over's entries first, base's otherwise (src/orm/overlay.ts). */
export function layeredRecord(base: Readonly<Record<string, unknown>>, over: Readonly<Record<string, unknown>>,
  removed: ReadonlySet<string> = new Set()): Readonly<Record<string, unknown>> {
  const has = (p: string): boolean => !removed.has(p) && (Object.prototype.hasOwnProperty.call(over, p) || p in base);
  const get = (p: string): unknown => (removed.has(p) ? undefined : Object.prototype.hasOwnProperty.call(over, p) ? over[p] : base[p]);
  const proxy = new Proxy(Object.create(null) as Record<string, unknown>, {
    get: (_t, p) => (typeof p === "string" ? get(p) : undefined),
    has: (_t, p) => typeof p === "string" && has(p),
    ownKeys: () => [...new Set([...Reflect.ownKeys(base), ...Object.keys(over)])].filter((k) => typeof k !== "string" || !removed.has(k)),
    getOwnPropertyDescriptor: (_t, p) => (typeof p === "string" && has(p) ? { value: get(p), enumerable: true, configurable: true, writable: false } : undefined),
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  });
  LAZY.add(proxy);
  return proxy;
}
