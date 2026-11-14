// Circuit artifact resolution: one place that knows where the wasm/zkey
// live in every environment.
//
// Candidate layouts, in order:
//   1. Explicit WASM_PATH / ZKEY_PATH env vars (or direct arguments).
//   2. <process.cwd()>/circuits/... — the Vercel bundle layout: files
//      listed in vercel.json `includeFiles` are present at runtime
//      relative to the project root, and the function runs with cwd at
//      the project root.
//   3. Module-relative ../circuits/... — local runs from any cwd.
// Throws listing every path tried, so a missing artifact fails fast with
// a diagnosable message instead of a cryptic snarkjs error.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function firstExisting(candidates) {
  const tried = [];
  for (const c of candidates) {
    if (!c) continue;
    tried.push(c);
    if (fs.existsSync(c)) return { found: c, tried };
  }
  return { found: null, tried };
}

export function resolveArtifactPaths({ wasmPath, zkeyPath } = {}) {
  const wasm = firstExisting([
    wasmPath || process.env.WASM_PATH,
    path.join(process.cwd(), "circuits", "gatekeeper.wasm"),
    path.join(HERE, "..", "circuits", "gatekeeper.wasm"),
  ]);
  const zkey = firstExisting([
    zkeyPath || process.env.ZKEY_PATH,
    path.join(process.cwd(), "circuits", "gatekeeper_final.zkey"),
    path.join(HERE, "..", "circuits", "gatekeeper_final.zkey"),
  ]);
  if (!wasm.found) {
    throw new Error(`missing wasm artifact; tried: ${wasm.tried.join(", ")}`);
  }
  if (!zkey.found) {
    throw new Error(`missing zkey artifact; tried: ${zkey.tried.join(", ")}`);
  }
  return { wasmPath: wasm.found, zkeyPath: zkey.found };
}
