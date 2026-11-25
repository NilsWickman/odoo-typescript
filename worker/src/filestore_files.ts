/**
 * The pure part of the files database (ACCEPTANCE C3, docs/accept/C3.md part 2): the Worker copies the files written
 * at runtime (FilestoreObject, src/do/filestore.ts) into the Postgres database `odoo_ts_files`, so the nightly
 * pg_dump of that database holds them next to the dump of the Odoo database. No Workers bindings here, so the tests
 * run it under Node; the I/O is src/filestore_mirror.ts.
 */
import { createHash } from "node:crypto";

/** The database that holds the copies; never an Odoo database (src/http/dispatch.ts dbFilter, src/db.ts Cursor). */
export const FILES_DB = "odoo_ts_files";

/**
 * The files database's name: `odoo_ts_files`. A local Worker (LOCAL_DEV, start.sh) may be given another one,
 * FILES_DB_NAME, so that a test writes into a database of its own and leaves the local `odoo_ts_files` as it is
 * (worker/vps/files_local_test.py: its writes there made the Postgres in RAM read as stale, 2026-11-14). The deployed
 * Worker has no LOCAL_DEV and takes no other name. The reserved name stays reserved either way (isReservedDb).
 */
export function filesDbName(localDev: string | undefined, name: string | undefined): string {
  return localDev === "1" && typeof name === "string" && /^[a-z][a-z0-9_]*$/.test(name) ? name : FILES_DB;
}

/** Names the Worker never serves as an Odoo database, whatever DB_FILTER says. */
export function isReservedDb(db: string): boolean {
  return db === FILES_DB || db === "odoo_demo_files" || db === "demo_template";
}

/**
 * One row per file and database: the same bytes under two database names are two rows (a restored copy's). The bytes
 * uncompressed out of line (STORAGE EXTERNAL, Postgres 16), so readMirrored's slices are read without decompressing the
 * whole value each time; most uploads are compressed already, and pg_dump -Fc compresses the dump.
 */
export const FILES_DDL = `CREATE TABLE IF NOT EXISTS filestore (
  db text NOT NULL,
  fname text NOT NULL,
  size integer NOT NULL,
  mtime bigint NOT NULL,
  data bytea STORAGE EXTERNAL NOT NULL,
  PRIMARY KEY (db, fname))`;

/** Odoo's store_fname, `<sha1[:2]>/<sha1>` (ir_attachment.py:140 `_file_fname`), and nothing else. */
const STORE_FNAME = /^([0-9a-f]{2})\/([0-9a-f]{40})$/;

export function isStoreFname(fname: string): boolean {
  const m = STORE_FNAME.exec(fname);
  return m !== null && m[2]!.startsWith(m[1]!);
}

/** True when the bytes are the file the store_fname names (the content address, ir_attachment.py:446 `_compute_checksum`). */
export function matchesStoreFname(fname: string, data: Uint8Array): boolean {
  return isStoreFname(fname) && fname.slice(3) === createHash("sha1").update(data).digest("hex");
}

/** What one scheduled run may copy, over every database of CRON_DBS together. */
export interface MirrorBudget {
  readonly files: number;
  readonly bytes: number;
}

/**
 * 100 files or 16 MiB a run (every 15 minutes): one file is in memory at a time (the object's copy, pg's parameter),
 * and a run measured locally at this size stays far inside 30 s CPU and 128 MB (docs/accept/C3.md part 2).
 */
export const DEFAULT_BUDGET: MirrorBudget = { files: 100, bytes: 16 * 1024 * 1024 };

/** FILES_MIRROR_MAX_FILES / FILES_MIRROR_MAX_BYTES (positive integers) override the default, e.g. in the local proof. */
export function budgetOf(maxFiles: string | undefined, maxBytes: string | undefined): MirrorBudget {
  const n = (raw: string | undefined, dflt: number) => (raw !== undefined && /^[1-9][0-9]{0,11}$/.test(raw) ? Number(raw) : dflt);
  return { files: n(maxFiles, DEFAULT_BUDGET.files), bytes: n(maxBytes, DEFAULT_BUDGET.bytes) };
}

/**
 * The largest file the mirroring copies. One file costs about three times its size in the Worker while it is copied
 * (the object's answer, pg's Bind message, the corked write, src/db.ts corkable); measured locally, the workerd
 * process peaked 73 MB over its resting size for a file of 24 MiB (docs/accept/C3.md part 2), against 128 MB per
 * isolate. A larger file is skipped and logged on every run instead of failing the run each time and blocking the
 * files after it; restore_check.sh then reports it missing.
 */
export const MAX_FILE = 24 * 1024 * 1024;

/** What a run has used so far. */
export interface MirrorUse {
  files: number;
  bytes: number;
}

/**
 * Whether the next file fits: under the file count, and under the byte budget, except that the first file of a run
 * always fits (a file larger than the budget is copied alone instead of never).
 */
export function fits(use: MirrorUse, budget: MirrorBudget, size: number): boolean {
  if (use.files >= budget.files) return false;
  return use.files === 0 || use.bytes + size <= budget.bytes;
}

/** The chunk of a file in a FilestoreObject (src/do/filestore.ts): a DO storage value holds at most 2 MB. */
export const FILE_CHUNK = 1024 * 1024;
