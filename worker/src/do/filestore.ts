/**
 * Written filestore files (ir_attachment.py `_file_write` :155 for files created at runtime): one Durable Object per
 * database with SQLite storage, keyed by `store_fname` (`<sha1[:2]>/<sha1>`, `_file_fname` :140). The template's
 * files stay in the immutable Static Assets snapshot (D16); there is no R2. A value is limited to 2 MB in DO storage,
 * so content is stored in 1 MiB chunks next to a small metadata record. Content addressing makes writes idempotent
 * (`_file_write` keeps an existing file with the same content).
 */
import { DurableObject } from "cloudflare:workers";
import { FILE_CHUNK as CHUNK } from "../filestore_files";

export interface Meta { readonly size: number; readonly chunks: number; readonly mtime: number }

export class FilestoreObject extends DurableObject {
  /** Nothing: a call that makes the object exist before the database's first file read (src/http/dispatch.ts `ensureDb`). */
  async ping(): Promise<void> {}

  /**
   * A file is written in pieces, one chunk per call (src/filestore.ts `putObjectFile`): Workers RPC serializes at most
   * 32 MiB per call, and a 40 MiB upload threw there when the whole file went in one (2026-11-17, a video in the
   * chatter on the site). Whether the file is complete, one chunk, then the metadata, written last so that a reader
   * never sees a file whose chunks are not all there.
   */
  async has(storeFname: string): Promise<boolean> {
    return Boolean(await this.ctx.storage.get<Meta>(`meta:${storeFname}`));
  }

  async putChunk(storeFname: string, index: number, data: Uint8Array): Promise<void> {
    if (data.length > CHUNK) throw new Error(`filestore chunk of ${data.length} bytes`);
    await this.ctx.storage.put(`data:${storeFname}:${index}`, data);
  }

  async putMeta(storeFname: string, size: number, chunks: number, mtime: number): Promise<void> {
    await this.ctx.storage.put(`meta:${storeFname}`, { size, chunks, mtime } satisfies Meta);
  }

  /**
   * One page of the stored files in key order, for the files' mirroring (src/filestore_mirror.ts): at most `limit` metadata
   * records after `after` (a store_fname), never the chunks, so a page costs the same however large the files are.
   */
  async list(after: string | null, limit: number): Promise<{ fname: string; size: number; mtime: number }[]> {
    const page = await this.ctx.storage.list<Meta>({ prefix: "meta:", limit, ...(after === null ? {} : { startAfter: `meta:${after}` }) });
    return [...page].map(([key, meta]) => ({ fname: key.slice("meta:".length), size: meta.size, mtime: meta.mtime }));
  }

  /** The file's metadata, null when absent (read the chunks with `getChunk`, each call well under the RPC limit). */
  async stat(storeFname: string): Promise<Meta | null> {
    return (await this.ctx.storage.get<Meta>(`meta:${storeFname}`)) ?? null;
  }

  async getChunk(storeFname: string, index: number): Promise<Uint8Array | null> {
    return (await this.ctx.storage.get<Uint8Array>(`data:${storeFname}:${index}`)) ?? null;
  }

  /** Bytes of all stored files (metadata records only; the demo's 20 MiB per database, src/demo/upload_caps.ts). */
  async totalBytes(): Promise<number> {
    let total = 0;
    for (const meta of (await this.ctx.storage.list<Meta>({ prefix: "meta:" })).values()) total += meta.size;
    return total;
  }

  /** Wipe all runtime-written files for this database (used by DemoPool when resetting a demo slot). */
  async reset(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
