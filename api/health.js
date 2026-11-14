// Vercel Function entry: GET /health (via vercel.json rewrite).
//
// Liveness + storage counters. Unauthenticated, like the local server's
// /health. Stats are best-effort: if Upstash is unreachable the endpoint
// still answers 200 with null counts and storage_ok=false, so a storage
// blip is visible in the response instead of looking like a dead function.
// Missing Upstash env vars -> 500 (the deployment is misconfigured).

import { requireUpstashStore } from "../src/store.js";
import { signBody, SIGNATURE_HEADER } from "../src/hmac.js";

export async function GET() {
  const secret = process.env.AGENT_GAMES_HMAC_SECRET;
  let store;
  try {
    store = requireUpstashStore(process.env);
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: "storage not configured" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
  let stats = { seen: null, cached: null };
  let storageOk = false;
  try {
    stats = await store.stats();
    storageOk = true;
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "health_stats_failed", error: String(e && e.message) }));
  }
  const body = Buffer.from(JSON.stringify({
    ok: true,
    uptime_s: Math.round(process.uptime()),
    storage: "upstash",
    storage_ok: storageOk,
    seen_proofs: stats.seen,
    cached_tasks: stats.cached,
  }), "utf8");
  const headers = { "content-type": "application/json" };
  if (secret) headers[SIGNATURE_HEADER] = signBody(secret, body);
  return new Response(body, { status: 200, headers });
}
