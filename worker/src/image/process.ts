/**
 * `odoo.tools.image.image_process(source, size=(w, h), verify_resolution=True)` (odoo/odoo/tools/image.py:289-324)
 * through src/image/odoo-image.wasm: Pillow 10.2.0's libImaging, libjpeg-turbo 3.0.1 and zlib 1.3 compiled from
 * source with Pillow's Python layer (thumbnail/draft/resize, JPEG and PNG open/save) in C (worker/image/,
 * README.md). Its outputs are checked byte for byte against Odoo's (worker/image/README.md, process.test.ts).
 *
 * Only RGB baseline/progressive JPEG without APP1/APP2/APP14/COM markers and non-interlaced 8-bit RGB/RGBA PNG with
 * no iCCP/tRNS/PLTE/eXIf chunks are handled; anything else refuses (NotPorted) rather than approximate.
 */
import { NotPorted, UserError } from "../errors";

interface Exports {
  readonly memory: WebAssembly.Memory;
  heap_reset(): void;
  alloc(n: number): number;
  process(ptr: number, len: number, maxW: number, maxH: number, crop: number, verify: number): number;
  out_ptr(): number;
  out_len(): number;
}

export type ImageProcess = (source: Uint8Array, maxW: number, maxH: number, opts?: { crop?: "" | "center" | "top" | "bottom"; verifyResolution?: boolean }) => Uint8Array;

export function createImageProcess(module: WebAssembly.Module): ImageProcess {
  return (source, maxW, maxH, opts = {}) => {
    // a fresh instance per call: its linear memory (up to ~50 MiB for a 2400x1600 JPEG) is dropped with it instead
    // of staying grown for the isolate's life (Wasm memory never shrinks)
    const e = new WebAssembly.Instance(module, {}).exports as unknown as Exports;
    e.heap_reset();
    const ptr = e.alloc(source.length);
    if (!ptr) throw new Error("image module: out of memory");
    new Uint8Array(e.memory.buffer, ptr, source.length).set(source);
    const crop = { "": 0, center: 1, top: 2, bottom: 3 }[opts.crop ?? ""];
    const status = e.process(ptr, source.length, maxW, maxH, crop, opts.verifyResolution === false ? 0 : 1);
    if (status === 0) return source;
    if (status === 1) return new Uint8Array(e.memory.buffer, e.out_ptr(), e.out_len()).slice();
    // image.py:96-97 (UserError, translated with _lt; en_US only here)
    if (status === -2) throw new UserError("Too large image (above 50.0Mpx), reduce the image size.");
    if (status === -3) throw new NotPorted("image_process of an image Pillow would fail to decode (UserError path)");
    throw new NotPorted("image_process of this image (format, markers or chunks outside the bit-exact Wasm subset)");
  };
}
