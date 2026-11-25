import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { test } from "node:test";
import { NotPorted } from "../errors";
import { decodePng, resizeNearest } from "./png";

function chunk(kind: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([len, Buffer.from(kind, "latin1"), body, Buffer.alloc(4)]); // the decoder does not check the CRC
}

function png(width: number, height: number, type: number, rows: number[][], extra: Buffer[] = []): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = type;
  const raw = deflateSync(Buffer.from(rows.flat()));
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), ...extra, chunk("IDAT", raw), chunk("IEND", Buffer.alloc(0))]));
}

test("RGBA with the sub and up filters", async () => {
  const img = await decodePng(png(2, 2, 6, [[1, 10, 20, 30, 255, 1, 1, 1, 0], [2, 1, 1, 1, 0, 0, 0, 0, 0]]));
  assert.deepEqual([...img.data], [10, 20, 30, 255, 11, 21, 31, 255, 11, 21, 31, 255, 11, 21, 31, 255]);
});

test("palette with transparency", async () => {
  const img = await decodePng(png(2, 1, 3, [[0, 0, 1]], [chunk("PLTE", Buffer.from([1, 2, 3, 4, 5, 6])), chunk("tRNS", Buffer.from([0]))]));
  assert.deepEqual([...img.data], [1, 2, 3, 0, 4, 5, 6, 255]);
});

test("RGB with tRNS refuses", async () => {
  await assert.rejects(decodePng(png(1, 1, 2, [[0, 1, 2, 3]], [chunk("tRNS", Buffer.from([0, 0]))])), NotPorted);
});

test("nearest resize takes the centre of each output pixel", () => {
  const data = new Uint8Array(16);
  for (let i = 0; i < 4; i++) data[i * 4] = i;
  const small = resizeNearest({ width: 4, height: 1, data }, 2, 1);
  assert.deepEqual([small.data[0], small.data[4]], [1, 3]);
});
