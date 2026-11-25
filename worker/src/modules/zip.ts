/**
 * Reading a .zip the way Python's `zipfile` does for `_import_zipfile` (base_import_module ir_module.py:326-392):
 * the central directory lists the members (`infolist()`), stored and deflated members are supported.
 * `zipfile.is_zipfile` looks for the end-of-central-directory record; anything else is not a zip.
 */
export interface ZipEntry {
  /** The member name as stored (`ZipInfo.filename`, '/' separated; directories end with '/'). */
  readonly filename: string;
  /** Uncompressed size (`ZipInfo.file_size`). */
  readonly fileSize: number;
  read(): Promise<Uint8Array>;
}

const EOCD = 0x06054b50;
const CDH = 0x02014b50;
const LFH = 0x04034b50;

function findEocd(b: Uint8Array, v: DataView): number {
  // the record is 22 bytes plus a comment of up to 65535 bytes at the end of the file
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (v.getUint32(i, true) === EOCD) return i;
  }
  return -1;
}

/** `zipfile.is_zipfile`. */
export function isZip(b: Uint8Array): boolean {
  if (b.length < 22) return false;
  return findEocd(b, new DataView(b.buffer, b.byteOffset, b.byteLength)) >= 0;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as unknown as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** `ZipFile(file).infolist()`. */
export function readZip(b: Uint8Array): ZipEntry[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const eocd = findEocd(b, v);
  if (eocd < 0) throw new Error("File is not a zip file");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const utf8 = new TextDecoder("utf-8");
  const cp437 = new TextDecoder("latin1"); // names without the UTF-8 flag; ASCII names decode the same
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== CDH) throw new Error("Bad magic number for central directory");
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const compSize = v.getUint32(p + 20, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const nameBytes = b.subarray(p + 46, p + 46 + nameLen);
    const filename = (flags & 0x800 ? utf8 : cp437).decode(nameBytes);
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x1) throw new Error(`File ${filename} is encrypted, password required for extraction`);
    entries.push({
      filename,
      fileSize: size,
      async read(): Promise<Uint8Array> {
        if (v.getUint32(local, true) !== LFH) throw new Error("Bad magic number for file header");
        const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
        const raw = b.subarray(start, start + compSize);
        if (method === 0) return raw.slice();
        if (method === 8) return inflateRaw(raw);
        throw new Error(`That compression method is not supported`);
      },
    });
  }
  return entries;
}
