// HTTP service: plain Node http, no framework. Thin adapter over the
// shared pipeline in src/handler.js; the local transport only reads the
// raw body and writes the handler's signed response bytes.
//
// Routes:
//   POST /agent   (documented example path; the path actually registered)
//   POST /task    (alias, same handler)
//   GET  /health  (liveness + state counters, no secrets)
// Anything else -> 404.
// State: FileStore under dataDir (see src/store.js).

import http from "node:http";
import path from "node:path";
import { createHandler, SIGNATURE_HEADER } from "./handler.js";
import { FileStore } from "./store.js";
import { Prover } from "./prover.js";
import { signBody } from "./hmac.js";

const MAX_BODY_BYTES = 1024 * 1024;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("body too large"), { code: "BODY_TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createServer({ secret, dataDir, wasmPath, zkeyPath, proveTimeoutMs }) {
  const store = new FileStore(dataDir);
  const prover = new Prover({ wasmPath, zkeyPath, timeoutMs: proveTimeoutMs });
  const handler = createHandler({ secret, store, prover });

  function sendSigned(res, status, bodyBuffer) {
    res.writeHead(status, {
      "content-type": "application/json",
      [SIGNATURE_HEADER]: signBody(secret, bodyBuffer),
    });
    res.end(bodyBuffer);
  }

  function send(res, status, bodyObject) {
    sendSigned(res, status, Buffer.from(JSON.stringify(bodyObject), "utf8"));
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") {
        const stats = await store.stats();
        send(res, 200, {
          ok: true,
          uptime_s: Math.round(process.uptime()),
          seen_proofs: stats.seen,
          cached_tasks: stats.cached,
        });
        return;
      }
      if (req.method !== "POST" || (url.pathname !== "/agent" && url.pathname !== "/task")) {
        send(res, 404, { error: "not found" });
        return;
      }

      let raw;
      try {
        raw = await readRawBody(req);
      } catch (e) {
        if (e.code === "BODY_TOO_LARGE") {
          send(res, 413, { error: "body too large" });
        } else {
          send(res, 400, { error: "unreadable body" });
        }
        return;
      }
      const out = await handler.handle({ rawBody: raw, signatureHeader: req.headers[SIGNATURE_HEADER] });
      // Use the handler's own signature (computed over these exact bytes).
      res.writeHead(out.status, {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: out.signature,
      });
      res.end(out.body);
    } catch (e) {
      // Last-resort guard: never crash the process on a request, never leak
      // internals. A 500 here means the platform will retry.
      try {
        send(res, 500, { error: "internal error" });
      } catch { /* socket already gone */ }
      process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "unhandled_request_error", error: String(e && e.message) }) + "\n");
    }
  });

  return { server, seenSet: store.seenSet, cache: store.cache, store, prover };
}
