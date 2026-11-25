/** A synchronous adapter around the pinned RustCrypto primitive, independently testable in Node. */
interface KdfExports {
  memory: WebAssembly.Memory;
  allocate(length: number): number;
  release(pointer: number, length: number): void;
  derive(password: number, passwordLength: number, salt: number, saltLength: number, rounds: number, output: number): void;
}

export type PasswordKdf = (password: Uint8Array, salt: Uint8Array, rounds: number) => Promise<Uint8Array>;

export function createKdf(module: WebAssembly.Module): (password: Uint8Array, salt: Uint8Array, rounds: number) => Uint8Array {
  const wasm = new WebAssembly.Instance(module, {}).exports as unknown as KdfExports;
  return (password, salt, rounds) => {
    if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 0xffff_ffff) throw new RangeError("Invalid PBKDF2 round count");
    const allocations: [number, number][] = [];
    const allocate = (length: number): number => {
      const pointer = wasm.allocate(length);
      allocations.push([pointer, length]);
      return pointer;
    };
    try {
      const p = allocate(password.length);
      const s = allocate(salt.length);
      const out = allocate(64);
      // Allocation can grow memory, so create views only after all allocations.
      new Uint8Array(wasm.memory.buffer, p, password.length).set(password);
      new Uint8Array(wasm.memory.buffer, s, salt.length).set(salt);
      wasm.derive(p, password.length, s, salt.length, rounds, out);
      return new Uint8Array(wasm.memory.buffer, out, 64).slice();
    } finally {
      for (const [pointer, length] of allocations) wasm.release(pointer, length);
    }
  };
}
