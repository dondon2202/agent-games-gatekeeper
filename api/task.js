// Vercel Function entry: POST /task (and /agent via vercel.json rewrite).
//
// Web-standard handler shape: a Fetch API Request in, a Response out.
// The raw body is read with `request.arrayBuffer()` — the EXACT bytes the
// platform signed. This deliberately avoids the legacy Node-style
// (req, res) handler, where Vercel pre-parses `req.body` and the original
// bytes are no longer recoverable for HMAC verification. Do NOT convert
// this file to the (req, res) shape without re-verifying raw-body access.
//
// Storage is Upstash Redis ONLY (see src/store.js): the serverless
// filesystem is read-only except /tmp and does not persist between
// invocations, so the file backend must never be used here. Missing
// Upstash env vars -> 500 (fail loud, never silently stateless).
//
// No file writes happen on this path: the prover only READS the bundled
// circuit artifacts (vercel.json `includeFiles`), and snarkjs fullProve
// works fully in memory. Verified locally with a read-only cwd probe
// (see scripts/measure-handler.js).
//
// Env vars (Vercel project settings, never in the repo):
//   AGENT_GAMES_HMAC_SECRET   platform-issued, shown once (Rotate Secret)
//   UPSTASH_REDIS_REST_URL    Upstash database REST URL
//   UPSTASH_REDIS_REST_TOKEN  Upstash database REST token (read-write)
//   PROVE_TIMEOUT_MS          optional, default 45000
//   WASM_PATH / ZKEY_PATH     optional overrides (see src/artifacts.js)

import { createHandler, SIGNATURE_HEADER } from "../src/handler.js";
import { requireUpstashStore } from "../src/store.js";
import { Prover } from "../src/prover.js";
import { resolveArtifactPaths } from "../src/artifacts.js";
import { signBody } from "../src/hmac.js";

function buildDeps(env) {
  const secret = env.AGENT_GAMES_HMAC_SECRET;
  if (!secret) {
    throw new Error("AGENT_GAMES_HMAC_SECRET is not set");
  }
  const store = requireUpstashStore(env);
  const { wasmPath, zkeyPath } = resolveArtifactPaths();
  const prover = new Prover({
    wasmPath,
    zkeyPath,
    timeoutMs: Number(env.PROVE_TIMEOUT_MS || 45000),
  });
  return { secret, store, prover };
}

function jsonResponse(status, bodyObject, secret) {
  const body = Buffer.from(JSON.stringify(bodyObject), "utf8");
  const headers = { "content-type": "application/json" };
  if (secret) headers[SIGNATURE_HEADER] = signBody(secret, body);
  return new Response(body, { status, headers });
}

export async function POST(request) {
  let secret;
  try {
    const deps = buildDeps(process.env);
    secret = deps.secret;
    // Exact raw bytes: arrayBuffer, never text()/json() re-serialization.
    const rawBody = Buffer.from(await request.arrayBuffer());
    const handler = createHandler(deps);
    const out = await handler.handle({
      rawBody,
      signatureHeader: request.headers.get(SIGNATURE_HEADER) || undefined,
    });
    return new Response(out.body, {
      status: out.status,
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: out.signature,
      },
    });
  } catch (e) {
    // Config/dependency failure (missing env, missing artifacts, store
    // construction). Never leak internals; the platform will retry.
    // Signed when the secret is available, for consistency.
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "task_handler_failed", error: String(e && e.message) }));
    return jsonResponse(500, { error: "internal error" }, secret || process.env.AGENT_GAMES_HMAC_SECRET);
  }
}
