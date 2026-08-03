/**
 * Redirects `import ... from "obsidian"` to the in-memory test stub.
 *
 * The published `obsidian` package ships type definitions only, so the real
 * module cannot be loaded at runtime. Registered ahead of tsx via `--import`
 * in the `test` script; tsx then transpiles the stub like any other source file.
 */
import { fileURLToPath } from "node:url";

const STUB = new URL("./obsidian-stub.ts", import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === "obsidian") {
    // No explicit `format`: tsx's load hook decides how to transpile the stub.
    return { url: STUB, shortCircuit: true };
  }
  return next(specifier, context);
}

export const stubPath = fileURLToPath(STUB);
