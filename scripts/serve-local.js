// Entrypoint: reads config from the environment, fails fast on missing
// secrets or artifacts, starts the HTTP server.
//
//   AGENT_GAMES_HMAC_SECRET   required, platform-issued (Rotate Secret).
//   PORT                      default 3000.
//   HOST                      default 127.0.0.1 (bind 0.0.0.0 only behind a
//                             reverse proxy; the platform requires public
//                             HTTPS on 443, which a TLS terminator provides).
//   DATA_DIR                  default ./data (seen-set + idempotency cache).
//   WASM_PATH / ZKEY_PATH     default ./circuits/gatekeeper.* (see
//                             src/artifacts.js for the resolution order).
//   PROVE_TIMEOUT_MS          default 45000 (inside the 60s deadline).
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//                             optional: when BOTH are set, the local server
//                             uses Upstash instead of the file store (useful
//                             for testing the serverless storage path
//                             locally). The Vercel function requires them.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../src/server.js";
import { resolveArtifactPaths } from "../src/artifacts.js";

const root = path.dirname(fileURLToPath(import.meta.url));

const secret = process.env.AGENT_GAMES_HMAC_SECRET;
if (!secret) {
  console.error("FATAL: AGENT_GAMES_HMAC_SECRET is not set. Refusing to start without the platform-issued secret.");
  process.exit(1);
}

let wasmPath;
let zkeyPath;
try {
  ({ wasmPath, zkeyPath } = resolveArtifactPaths());
} catch (e) {
  console.error(`FATAL: ${e.message}`);
  process.exit(1);
}

const { server } = createServer({
  secret,
  dataDir: process.env.DATA_DIR || path.join(root, "..", "data"),
  wasmPath,
  zkeyPath,
  proveTimeoutMs: Number(process.env.PROVE_TIMEOUT_MS || 45000),
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
server.listen(port, host, () => {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level: "info", event: "listening", host, port }) + "\n");
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
