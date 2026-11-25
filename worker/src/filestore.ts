/**
 * The filestore behind one call (ARCHITECTURE.md, Runtime facts): the bytes of `ir_attachment.store_fname`
 * (`odoo/odoo/addons/base/models/ir_attachment.py:133 _full_path`, `:140 _file_fname`: `<sha1[:2]>/<sha1>`).
 *
 * Two backends:
 *  - Local development (`wrangler dev`, start.sh): the Worker cannot read the disk, so start.sh runs
 *    `worker/filestore_server.py`, a plain `http.server` over `FILESTORE_ROOT` (one directory per database,
 *    harness/dbs.py), on a free port and passes it as `--var FILESTORE_URL:http://127.0.0.1:<port>`. The Worker
 *    fetches `${FILESTORE_URL}/<db>/<store_fname>`. The server falls back to `worker/gen/out/bundles/` for the
 *    precompiled lazy bundles (keyed by their store_fname through gen/out/bundles/index.json), so the attachment
 *    row that assets.ts inserts always has its bytes without copying anything.
 *  - Deployed read-only experiment: Workers Static Assets under `/__filestore/<store_fname>`, produced by
 *    gen/filestore.py from the template plus precompiled bundles. Source mtimes are preserved in metadata.
 *    No R2 subscription is needed. All served databases must use that same template snapshot; new uploads
 *    are not supported by this immutable backend.
 *
 * Owned by stream MAIL (since 2026-10-29). Runtime writes: writeFile -> FilestoreObject (src/do/filestore.ts).
 */
import type { Env } from "./env";
import { readMirrored } from "./filestore_mirror";
import { FILE_CHUNK as CHUNK } from "./filestore_files";
import { UserError } from "./errors";
import { demoUploadRefusal } from "./demo/upload_caps";

export interface FileInfo {
  readonly data: Uint8Array;
  /** The file's modification time (Odoo uses `os.stat(path).st_mtime` for Last-Modified, ir_attachment.py:1131). */
  readonly lastModified: Date | null;
}

/** ir_attachment.py:133 `_full_path`: `re.sub(r'[.:]', '', path).strip('/\\')`. */
export function sanitizeStoreFname(storeFname: string): string {
  return storeFname.replace(/[.:]/g, "").replace(/^[/\\]+|[/\\]+$/g, "");
}

/** A local file server remains available for scenarios that mutate the filestore. */
function filestoreUrl(env: Env): string | null {
  const v: unknown = Reflect.get(env, "FILESTORE_URL");
  return typeof v === "string" && v !== "" ? v.replace(/\/+$/, "") : null;
}

/**
 * Reads one filestore object with its mtime; null when the file does not exist (Odoo's OSError branch). Files written
 * at runtime first (writeFile), then the template's snapshot, then, only on a miss in both, the copy in the files
 * database (src/filestore_mirror.ts readMirrored: after a restore the dumps hold the files the object lost).
 */
export async function readFileInfo(env: Env, db: string, storeFname: string): Promise<FileInfo | null> {
  const key = sanitizeStoreFname(storeFname);
  if (key === "") return null;
  const stub = filestoreObject(env, db);
  const written = stub ? await getObjectFile(stub, key) : null;
  if (written) return { data: written.data, lastModified: new Date(written.mtime) };
  const found = await readSnapshot(env, db, key);
  if (found !== null) return found;
  const copy = await readMirrored(env, db, key);
  return copy === null ? null : { data: copy.data, lastModified: new Date(copy.mtime) };
}

/** The template's files: the local file server (http mode) or the packaged Static Assets snapshot (D16). */
async function readSnapshot(env: Env, db: string, key: string): Promise<FileInfo | null> {
  const base = filestoreUrl(env);
  if (base !== null) {
    const res = await fetch(`${base}/${encodeURIComponent(db)}/${key.split("/").map(encodeURIComponent).join("/")}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`filestore server: ${res.status} for ${db}/${key}`);
    const lm = res.headers.get("last-modified");
    const t = lm === null ? NaN : Date.parse(lm);
    return { data: new Uint8Array(await res.arrayBuffer()), lastModified: Number.isNaN(t) ? null : new Date(t) };
  }
  const metadata: Readonly<Record<string, number>> = (await import("../gen/out/filestore.json")).default;
  const mtime = metadata[key];
  if (mtime === undefined) return null;
  const res = await env.ASSETS.fetch(new Request(`http://assets/__filestore/${key}`));
  if (!res.ok) throw new Error(`Packaged filestore: ${res.status} for ${key}`);
  return { data: new Uint8Array(await res.arrayBuffer()), lastModified: new Date(mtime) };
}

/** Reads the local file server or packaged snapshot; null when absent. */
export async function readFile(env: Env, db: string, storeFname: string): Promise<Uint8Array | null> {
  const info = await readFileInfo(env, db, storeFname);
  return info === null ? null : info.data;
}

function filestoreObject(env: Env, db: string): DurableObjectStub<import("./do/filestore").FilestoreObject> | null {
  const ns: unknown = Reflect.get(env, "FILESTORE_DO");
  if (!ns) return null;
  return env.FILESTORE_DO.get(env.FILESTORE_DO.idFromName(db));
}

/**
 * `ir.attachment._file_write(fname, bin_value)` (ir_attachment.py:155): persist the bytes under `store_fname` in the
 * database's FilestoreObject. Content-addressed and idempotent; written before the attachment row commits, like
 * Odoo writes the file before COMMIT (a rolled-back request leaves an unreferenced file, which Odoo's GC also keeps
 * until `_gc_file_store`).
 */
export async function writeFile(env: Env, db: string, storeFname: string, data: Uint8Array): Promise<void> {
  const key = sanitizeStoreFname(storeFname);
  if (key === "") throw new Error("empty store_fname");
  const stub = filestoreObject(env, db);
  if (!stub) throw new Error("FILESTORE_DO binding missing");
  // the public demo only: 2 MiB per file, 20 MiB per database (src/demo/upload_caps.ts); a file already there is free
  if (env.DEMO_MODE === "1" && !(await stub.has(key))) {
    const refusal = demoUploadRefusal(data.length, await stub.totalBytes());
    if (refusal !== null) throw new UserError(refusal);
  }
  await putObjectFile(stub, key, data, Date.now());
}

type FilestoreStub = DurableObjectStub<import("./do/filestore").FilestoreObject>;

/** Stores a file in a FilestoreObject one chunk per RPC call, unless it is there; true when written now. */
export async function putObjectFile(stub: FilestoreStub, key: string, data: Uint8Array, mtime: number): Promise<boolean> {
  if (await stub.has(key)) return false;
  const chunks = Math.max(1, Math.ceil(data.length / CHUNK));
  for (let i = 0; i < chunks; i++) await stub.putChunk(key, i, data.slice(i * CHUNK, (i + 1) * CHUNK));
  await stub.putMeta(key, data.length, chunks, mtime);
  return true;
}

/** A file of a FilestoreObject read one chunk per RPC call; null when absent or incomplete. */
export async function getObjectFile(stub: FilestoreStub, key: string): Promise<{ data: Uint8Array; mtime: number } | null> {
  const meta = await stub.stat(key);
  if (!meta) return null;
  const out = new Uint8Array(meta.size);
  let off = 0;
  for (let i = 0; i < meta.chunks; i++) {
    const part = await stub.getChunk(key, i);
    if (!part) return null;
    out.set(part, off);
    off += part.length;
  }
  return { data: out, mtime: meta.mtime };
}
