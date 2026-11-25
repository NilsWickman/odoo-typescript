/**
 * The files database `odoo_ts_files` (ACCEPTANCE C3, docs/accept/C3.md part 2). The files written at runtime live in
 * one FilestoreObject per database (src/do/filestore.ts), in Cloudflare, outside the nightly pg_dump. The Worker
 * copies them into Postgres itself, over the connection it already has (the VPS's tunnel, src/db.ts), so that the
 * dumps of the Odoo database and of `odoo_ts_files` together restore both the data and the files:
 *
 *  - mirrorFilestores: in the scheduled run (src/index.ts), for each database of CRON_DBS, the object's files that
 *    `odoo_ts_files.filestore` does not have yet are copied there (sha1 checked), within a budget per run; the rest
 *    follows in the next run.
 *  - readMirrored: when a file is neither in the database's object nor in the template's snapshot
 *    (src/filestore.ts readFileInfo), the copy is read from the table and written back into the object.
 *
 * Without the database or the table, both do nothing and every read behaves as before.
 */
import type { Env } from "./env";
import { Cursor } from "./db";
import { getObjectFile, putObjectFile } from "./filestore";
import { budgetOf, fits, filesDbName, MAX_FILE, FILES_DDL, isStoreFname, matchesStoreFname, type MirrorBudget, type MirrorUse } from "./filestore_files";

/** A listing page of the object (metadata records only). */
const PAGE = 1000;

/** The slice of a copy read at a time (readMirrored). */
const READ_SLICE = 1024 * 1024;

/** Postgres error codes that mean "no files database here": invalid_catalog_name, undefined_table, insufficient_privilege. */
const ABSENT = new Set(["3D000", "42P01", "42501"]);

function pgCode(e: unknown): string | null {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : null;
}

/** The files database of this Worker (src/filestore_files.ts filesDbName: another name for a local test or demo mode). */
function filesDb(env: Env): string {
  if (env.DEMO_MODE === "1" && typeof env.FILES_DB_NAME === "string" && /^[a-z][a-z0-9_]*$/.test(env.FILES_DB_NAME)) {
    return env.FILES_DB_NAME;
  }
  return filesDbName(env.LOCAL_DEV, env.FILES_DB_NAME);
}

function filesCursor(env: Env): Cursor {
  return new Cursor(env, filesDb(env), true);
}

function objectOf(env: Env, db: string): DurableObjectStub<import("./do/filestore").FilestoreObject> | null {
  return Reflect.get(env, "FILESTORE_DO") ? env.FILESTORE_DO.get(env.FILESTORE_DO.idFromName(db)) : null;
}

/**
 * The copy of `fname` for database `db`, null when there is none (or no files database). Called only on a miss, so a
 * file that exists costs nothing; a miss costs one connection and one indexed read (the primary key), and without
 * the files database one refused connection. The bytes are checked against the name and written back into the
 * database's object, so the next read is a hit there.
 */
export async function readMirrored(env: Env, db: string, fname: string): Promise<{ data: Uint8Array; mtime: number } | null> {
  if (!isStoreFname(fname)) return null;
  const cr = filesCursor(env);
  let data: Uint8Array | null = null;
  let mtime = 0;
  try {
    const templateKey = env.TEMPLATE_FILES_DB_KEY;
    let lookupDb = db;
    let head = (await cr.query<{ size: number; mtime: string }>("SELECT size, mtime FROM filestore WHERE db = $1 AND fname = $2", [lookupDb, fname])).rows[0];
    if (head === undefined && typeof templateKey === "string" && templateKey !== "" && templateKey !== db) {
      lookupDb = templateKey;
      head = (await cr.query<{ size: number; mtime: string }>("SELECT size, mtime FROM filestore WHERE db = $1 AND fname = $2", [lookupDb, fname])).rows[0];
    }
    if (head !== undefined) {
      // in slices: pg sends bytea as hex text, twice its size as one string; a slice keeps that to 2 MiB
      data = new Uint8Array(head.size);
      mtime = Number(head.mtime);
      for (let at = 0; at < head.size; at += READ_SLICE) {
        const part = (await cr.query<{ part: Uint8Array | null }>("SELECT substring(data FROM $3 FOR $4) AS part FROM filestore WHERE db = $1 AND fname = $2",
          [lookupDb, fname, at + 1, READ_SLICE])).rows[0]?.part;
        if (!part || part.length !== Math.min(READ_SLICE, head.size - at)) { data = null; break; }
        data.set(part, at);
      }
    }
    await cr.rollback();
  } catch (e) {
    const code = pgCode(e);
    if (code === null || !ABSENT.has(code)) console.warn(`filestore: ${filesDb(env)} not readable (${code ?? String(e)}), ${db}/${fname} stays missing`);
    return null;
  } finally {
    await cr.close().catch(() => undefined);
  }
  if (data === null) return null;
  if (!matchesStoreFname(fname, data)) {
    console.error(`filestore: the copy of ${db}/${fname} in ${filesDb(env)} does not match its sha1, not used`);
    return null;
  }
  const stub = objectOf(env, db);
  if (stub) await putObjectFile(stub, fname, data, mtime);
  console.log(`filestore: ${db}/${fname} restored from ${filesDb(env)} (${data.length} bytes)`);
  return { data, mtime };
}

/** What one database's mirroring did, for the log line. */
export interface MirrorReport {
  readonly db: string;
  listed: number;
  copied: number;
  bytes: number;
  badSha1: number;
  /** Files over MAX_FILE, skipped. */
  tooLarge: number;
  /** Files left for the next run (the budget ran out). */
  more: boolean;
  ms: number;
}

/**
 * Copies the object's files of `db` that the table does not have, within what is left of the run's budget (`use` is
 * shared by the databases of one run). Each file is committed on its own, so a run stopped halfway keeps what it did.
 */
async function mirrorOne(env: Env, cr: Cursor, db: string, budget: MirrorBudget, use: MirrorUse): Promise<MirrorReport> {
  const t0 = Date.now();
  const report: MirrorReport = { db, listed: 0, copied: 0, bytes: 0, badSha1: 0, tooLarge: 0, more: false, ms: 0 };
  const stub = objectOf(env, db);
  if (stub === null) return report;
  let after: string | null = null;
  pages: for (;;) {
    const page = await stub.list(after, PAGE);
    report.listed += page.length;
    if (page.length === 0) break;
    after = page[page.length - 1]!.fname;
    const have = new Set((await cr.query<{ fname: string }>(
      "SELECT fname FROM filestore WHERE db = $1 AND fname = ANY($2::text[])", [db, page.map((f) => f.fname)])).rows.map((r) => r.fname));
    for (const f of page) {
      if (have.has(f.fname)) continue;
      if (f.size > MAX_FILE) {
        report.tooLarge++;
        console.warn(`filestore mirror: ${db}/${f.fname} is ${f.size} bytes, over ${MAX_FILE}: not copied`);
        continue;
      }
      if (!fits(use, budget, f.size)) {
        report.more = true;
        break pages;
      }
      const file = await getObjectFile(stub, f.fname);
      if (file === null) continue; // listed but its chunks are gone: nothing to copy
      if (!matchesStoreFname(f.fname, file.data)) {
        report.badSha1++;
        console.error(`filestore mirror: ${db}/${f.fname} does not match its sha1 (${file.data.length} bytes), not copied`);
        continue;
      }
      await cr.query("INSERT INTO filestore (db, fname, size, mtime, data) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (db, fname) DO NOTHING",
        [db, f.fname, file.data.length, Math.round(file.mtime), file.data]);
      await cr.commitAndContinue();
      use.files++;
      use.bytes += file.data.length;
      report.copied++;
      report.bytes += file.data.length;
    }
    if (page.length < PAGE) break;
  }
  report.ms = Date.now() - t0;
  return report;
}

/**
 * The scheduled mirroring of every database in `dbs`. Never throws: an error is logged per database and the next one
 * is tried, so it cannot stop Odoo's cron jobs of the same run (src/index.ts scheduled).
 */
export async function mirrorFilestores(env: Env, dbs: readonly string[]): Promise<MirrorReport[]> {
  const budget = budgetOf(Reflect.get(env, "FILES_MIRROR_MAX_FILES") as string | undefined, Reflect.get(env, "FILES_MIRROR_MAX_BYTES") as string | undefined);
  const use: MirrorUse = { files: 0, bytes: 0 };
  const reports: MirrorReport[] = [];
  const cr = filesCursor(env);
  try {
    try {
      await cr.query(FILES_DDL);
      // DDL counts as a write to every table (src/orm/signaling.ts writtenTablesOf); the files database has no
      // registry and no orm_signaling tables to signal
      cr.writtenTables.clear();
      await cr.commitAndContinue();
    } catch (e) {
      const code = pgCode(e);
      console.warn(`filestore mirror: ${filesDb(env)} not available (${code ?? String(e)}), nothing copied`);
      return reports;
    }
    for (const db of dbs) {
      try {
        const r = await mirrorOne(env, cr, db, budget, use);
        reports.push(r);
        console.log(`filestore mirror ${db}: ${r.listed} files in the object, ${r.copied} copied (${r.bytes} bytes)` +
          `${r.badSha1 ? `, ${r.badSha1} with a wrong sha1` : ""}${r.tooLarge ? `, ${r.tooLarge} too large` : ""}${r.more ? ", more in the next run" : ", complete"}, ${r.ms} ms`);
      } catch (e) {
        console.error(`filestore mirror ${db}: failed`, e);
        await cr.rollback().catch(() => undefined);
        await cr.close().catch(() => undefined); // a broken connection: the next database opens a new one
      }
    }
    await cr.commit();
  } catch (e) {
    console.error("filestore mirror: failed", e);
  } finally {
    await cr.close().catch(() => undefined);
  }
  return reports;
}
