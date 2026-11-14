# Deploy: Proof Gatekeeper on Vercel + Upstash Redis (all free, no card)

Preparation is complete (see REPORT.md "Vercel adaptation"). This file is
the exact runbook for the real deploy. Nothing here has been deployed yet:
every step below needs the user's own accounts, and the HMAC secret only
exists after platform registration.

## 0. What gets deployed

- `api/task.js` — the agent endpoint (POST `/task` and `/agent`).
  Web-standard handler: raw bytes via `request.arrayBuffer()`, HMAC first,
  shared decision + Groth16 prover, Upstash-only storage.
- `api/health.js` — GET `/health` (liveness + storage counters).
- `src/*` — decision engine, encodings, prover, HMAC, storage backends.
- `circuits/gatekeeper.wasm` + `circuits/gatekeeper_final.zkey` — public
  circuit artifacts, bundled into the function via `vercel.json`
  `includeFiles`. These files ARE meant to be committed (public downloads,
  no secrets). `verification_key.json` is likewise public and derived.
- Never committed: `.env`, `data/`, `node_modules/` (all git-ignored).

## 1. Environment variables (exact names)

Set all three in the Vercel project (Production). No other env vars are
required.

| Variable | Value | Source |
|---|---|---|
| `AGENT_GAMES_HMAC_SECRET` | 32-byte platform secret, shown once | Agent Games dashboard -> agent settings -> Rotate Secret (at registration) |
| `UPSTASH_REDIS_REST_URL` | `https://<db>.upstash.io` | Upstash console -> database -> REST API section |
| `UPSTASH_REDIS_REST_TOKEN` | REST token (standard read-write) | Same Upstash section (NOT the read-only token) |

Optional overrides (defaults are correct; do not set unless debugging):
`PROVE_TIMEOUT_MS` (default 45000), `WASM_PATH`, `ZKEY_PATH`.

Notes:

- Changing any env var in the Vercel dashboard requires a redeploy to
  take effect.
- Rotating the HMAC secret on the platform invalidates the old secret
  immediately: update the Vercel env var and redeploy in the same session.
- Do NOT put these values in the repo, in chat logs, or in screenshots.

## 2. Create the free Upstash Redis database (no card)

1. Open the Upstash console and sign in (GitHub sign-in is fine).
2. Create Database -> type Redis -> give it a name (e.g.
   `agent-games-gatekeeper`) -> pick a region close to the Vercel
   function region (US East is the safe default; Vercel Hobby functions
   run in a single region). Free tier: $0, no card required (limits:
   256 MB storage and 500k commands/month per the pricing page checked
   Aug 2026; verify current limits in the console — our total usage is
   ~5 REST calls per task x ~64 scored tasks + practice, far under any
   free limit).
3. On the database page, open the REST API / Connect section. Copy:
   - the HTTPS REST URL -> `UPSTASH_REDIS_REST_URL`
   - the Token (standard read-write token) -> `UPSTASH_REDIS_REST_TOKEN`
4. Done. No tables, no schema, no eviction policy to set: the agent
   creates keys on first use (`gk:seen`, `gk:cache:<taskId>`,
   `gk:cache:ids`). Do NOT share this database with other projects: the
   `gk:` prefix namespaces the keys, but a second writer could corrupt
   the seen-set.

## 3. Create the Vercel project from GitHub (no card)

1. Push this directory to a GitHub repo under the user's account
   (`dondon2202`). The repo may be private. Verify the push contains:
   `api/`, `src/`, `circuits/` (wasm + zkey), `package.json`,
   `package-lock.json`, `vercel.json`, `.vercelignore` — and does NOT
   contain `.env`, `data/`, or `node_modules/`.
2. Vercel dashboard -> Add New Project -> Import the repo.
   - Framework Preset: **Other** (no framework; this is a bare Node
     project with `api/` functions).
   - Root Directory: the repo root (or the gatekeeper directory if the
     repo contains other projects — then all paths in this runbook are
     relative to that directory).
3. Before deploying: Project Settings -> Environment Variables -> add
   the three variables from section 1 (Production scope). If the HMAC
   secret is not available yet (registration not done), deploy with a
   placeholder ONLY to verify the build, then set the real secret and
   redeploy before registering the endpoint — the function returns 500
   until all three vars are set, by design.
4. Deploy. First build takes a few minutes (`npm install`, snarkjs).
5. Note the deployment URL: `https://<project>.vercel.app`.
   The agent endpoint to register is
   `https://<project>.vercel.app/task` (or `/agent`; both route to the
   same function via `vercel.json` rewrites; `/api/task` also works).

## 4. maxDuration / Hobby plan caveat

`vercel.json` sets `maxDuration: 60` for `api/task.js`. Measured locally
(fresh process, this VM): cold first request ~4-7s including the first
proof, warm requests ~1.3-1.7s — far inside 60s. Vercel's documented
Hobby cap is inconsistent across sources (older docs: 10s; newer Fluid
Compute docs: 300s default on every plan including Hobby). If the deploy
rejects `maxDuration: 60`, Vercel reports the allowed maximum: set
`maxDuration` to that value in `vercel.json` and redeploy.

Fallback if the cap is low (e.g. 10s): cold starts (~5-7s local + Vercel
cold-start overhead ~1-3s) may occasionally exceed it on the very first
task after idle. The platform retries timed-out deliveries, and a retry
lands on a warm instance (~2s), so a low cap costs latency, not tasks —
as long as the cap is >= ~8s. If the cap were lower than that, this host
would be unsuitable and a different free host would be needed. There is
no card-funded upgrade path; do not propose one.

## 5. Post-deploy verification checklist

Run in order. Stop at the first failure and check the Vercel function
logs (project -> Logs) before continuing.

- [ ] **Health:** `GET https://<project>.vercel.app/health` returns 200
      with `{"ok":true,"storage":"upstash","storage_ok":true, ...}`.
      `storage_ok:false` means Upstash is unreachable (check URL/token).
      500 means env vars are missing.
- [ ] **Preflight:** in the Agent Games dashboard, run the signed
      preflight against the registered endpoint. Must pass. A preflight
      signature error points at the HMAC header encoding (see REPORT.md
      gap #3). A 500 here means missing artifacts in the bundle — check
      the logs for "missing wasm/zkey artifact".
- [ ] **Practice task (valid):** one valid practice task returns
      APPROVE with a Groth16 proof, and the dashboard accepts both the
      decision and the proof. This validates the `taskId`/VK encodings
      (REPORT.md gaps #1-2) and the proof serialization (gap #4).
- [ ] **Practice tasks (traps):** one practice task of each trap
      variety returns the matching REJECT reason code, and a
      `current == expiry` boundary task rejects (circuit-strict expiry).
- [ ] **Timing:** Vercel function logs show per-invocation durations
      comfortably under the deadline (expect <10s cold, ~2s warm).
- [ ] **Redis state:** the Upstash console data browser shows the
      `gk:seen` set growing and `gk:cache:<taskId>` keys appearing after
      practice tasks.
- [ ] **Replay:** re-sending the same practice `task_id` (if the
      dashboard allows a re-dispatch) returns the byte-identical response.
- [ ] **Auth drill (optional):** an unsigned/wrong-signature request
      returns 401 and the Upstash key counts do not change.

## 6. Assumptions and unverified integrations

1. **Web-standard handler shape.** `api/task.js` uses
   `export async function POST(request)` with `request.arrayBuffer()`.
   This is Vercel's current documented model and the only shape that
   guarantees exact raw bytes for HMAC. The legacy `(req, res)` shape
   pre-parses `req.body` and must NOT be substituted without
   re-verifying raw-body access.
2. **Artifact bundling.** `vercel.json` `includeFiles` + the
   `process.cwd()`-relative layout is the documented mechanism; it is
   verified locally (the measurement script runs the handler from the
   project root and from an empty read-only cwd) but NOT against a real
   Vercel deployment. Preflight is the first live check.
3. **Upstash REST semantics.** The store uses the documented JSON-array
   POST body form, `/pipeline`, and `/multi-exec`, with
   `Authorization: Bearer` auth. It is tested against a local mock that
   mirrors the documented response shapes — NOT against real Upstash.
   The first practice task is the live validation; a REST-shape mismatch
   would surface as 503s with `UpstashError` in the function logs.
4. **Single-writer assumption.** The check-then-mark sequence on the
   seen-set is not atomic across concurrent invocations: two tasks
   sharing a `proof_tx` arriving in the same instant could both read
   "not seen". The platform dispatches one agent's tasks sequentially
   (8 tasks spread over a 10-hour round window), so this is accepted
   risk, not engineered for. Retries of the SAME task_id are safe
   (idempotency cache).
5. **No TTL on cached entries.** Cache keys have no expiry (same
   durability as the file backend). Total data is kilobytes; no cleanup
   is needed for this event.
6. **Encodings (unchanged from REPORT.md).** `taskId` = SHA-256 mod p,
   VK hash = BigInt(hex) mod p, response proof = snarkjs-native
   `proof` + `public_signals`, response signature = lowercase hex HMAC.
   Practice mode is the arbiter for all four.
7. **Region/latency.** Upstash REST adds roughly 50-200ms per call;
   worst case ~5 calls per request. Included in the timing budget above.

## 7. Steps that need the user's own accounts (nothing to do here)

- GitHub (`dondon2202`): create/push the repo; authorize Vercel.
- Vercel: create the account/project, set env vars, deploy.
- Upstash: create the account/database, copy REST credentials.
- Agent Games dashboard: X sign-in, registration, agent endpoint
  registration, HMAC secret (Rotate Secret, shown once), preflight,
  practice tasks.
- No step above requires a payment card. If any signup asks for one,
  stop and report: that is not the free path documented here.
