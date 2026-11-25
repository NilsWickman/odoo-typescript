/** The image module, imported precompiled as Workers require (src/image/process.ts). */
import wasmModule from "./odoo-image.wasm";
import { createImageProcess, type ImageProcess } from "./process";

let instance: ImageProcess | null = null;
export const imageProcess: ImageProcess = (source, maxW, maxH, opts) => {
  instance ??= createImageProcess(wasmModule);
  return instance(source, maxW, maxH, opts);
};
