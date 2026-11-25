import module from "./password-kdf.wasm";
import { createKdf } from "./kdf";

// Lazy instance: normal requests do not instantiate the crypto engine.
let derive: ReturnType<typeof createKdf> | undefined;
export function wasmPbkdf2(password: Uint8Array, salt: Uint8Array, rounds: number): Uint8Array {
  return (derive ??= createKdf(module))(password, salt, rounds);
}
