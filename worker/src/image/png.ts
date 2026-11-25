/**
 * The pixels of a PNG as RGBA: what `PIL.Image.open(...).convert('RGBA')` gives for 8-bit non-interlaced images
 * (the formats of company logos). Other formats refuse.
 */
import { NotPorted } from "../errors";

export interface Rgba { width: number; height: number; data: Uint8Array; }

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(b: Uint8Array): boolean {
  return SIGNATURE.every((v, i) => b[i] === v);
}

async function inflate(chunks: Uint8Array[]): Promise<Uint8Array> {
  const stream = new Blob(chunks as unknown as ConstructorParameters<typeof Blob>[0]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export async function decodePng(b: Uint8Array): Promise<Rgba> {
  if (!isPng(b)) throw new NotPorted("image decoding of a non PNG");
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  let palette: Uint8Array | null = null, trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  for (let i = 8; i + 8 <= b.length;) {
    const len = view.getUint32(i);
    const kind = String.fromCharCode(b[i + 4]!, b[i + 5]!, b[i + 6]!, b[i + 7]!);
    const body = b.subarray(i + 8, i + 8 + len);
    if (kind === "IHDR") {
      width = view.getUint32(i + 8); height = view.getUint32(i + 12);
      depth = body[8]!; type = body[9]!; interlace = body[12]!;
    } else if (kind === "PLTE") palette = body;
    else if (kind === "tRNS") trns = body;
    else if (kind === "IDAT") idat.push(body);
    else if (kind === "IEND") break;
    i += 12 + len;
  }
  if (depth !== 8 || interlace !== 0) throw new NotPorted(`PNG of depth ${depth}, interlace ${interlace}`);
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (channels === undefined || (trns !== null && type !== 3) || (type === 3 && palette === null)) throw new NotPorted(`PNG of colour type ${type}`);
  const raw = await inflate(idat);
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new NotPorted("truncated PNG");
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const filter = raw[start]!;
    const line = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const v = raw[start + 1 + x]!;
      const a = x >= channels ? line[x - channels]! : 0, up = prev[x]!, c = x >= channels ? prev[x - channels]! : 0;
      switch (filter) {
        case 0: line[x] = v; break;
        case 1: line[x] = v + a; break;
        case 2: line[x] = v + up; break;
        case 3: line[x] = v + ((a + up) >> 1); break;
        case 4: line[x] = v + paeth(a, up, c); break;
        default: throw new NotPorted(`PNG filter ${filter}`);
      }
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4, p = x * channels;
      if (type === 6) { out.set(line.subarray(p, p + 4), o); continue; }
      if (type === 2) { out.set(line.subarray(p, p + 3), o); out[o + 3] = 255; continue; }
      if (type === 3) {
        const idx = line[p]!;
        out.set(palette!.subarray(idx * 3, idx * 3 + 3), o);
        out[o + 3] = trns !== null && idx < trns.length ? trns[idx]! : 255;
        continue;
      }
      out[o] = out[o + 1] = out[o + 2] = line[p]!;
      out[o + 3] = type === 4 ? line[p + 1]! : 255;
    }
    prev = line;
  }
  return { width, height, data: out };
}

/**
 * `image.resize((w, h), resample=NEAREST)` of Pillow: _imaging.c `_resize` -> Geometry.c ImagingScaleAffine, whose
 * source coordinates are accumulated doubles (`xo += a[0]`) truncated by COORD.
 */
export function resizeNearest(img: Rgba, w: number, h: number): Rgba {
  const xin: number[] = [];
  const ax = img.width / w, ay = img.height / h;
  for (let x = 0, xo = ax * 0.5; x < w; x++, xo += ax) xin.push(Math.trunc(xo));
  const out = new Uint8Array(w * h * 4);
  let yo = ay * 0.5;
  for (let y = 0; y < h; y++, yo += ay) {
    const yi = Math.trunc(yo);
    for (let x = 0; x < w; x++) {
      const s = (yi * img.width + xin[x]!) * 4;
      out.set(img.data.subarray(s, s + 4), (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data: out };
}
