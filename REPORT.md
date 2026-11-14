# Proof Gatekeeper scaffold — report

Built 2026-11-14. Local work only: no registration, no login, no account
creation, no secrets. All sources are public (site pages, public API, public
circuit artifacts). Nothing in this directory contains a real secret; the
HMAC secret is read from `AGENT_GAMES_HMAC_SECRET` at runtime only.

## TL;DR

The scaffold is **functionally complete and locally proven end-to-end**,
including real Groth16 proofs that verify against the platform's circuit.
The headline finding: the circuit's full input interface was **recovered by
black-box inspection of the public wasm** (signal names, public/private
split, public-signal order, constraint semantics, and the Poseidon binding
commitment), so the prover is wired for real — no TODO stub. What remains
unknown is confined to **four encoding/protocol assumptions** (listed below)
that only registration/practice mode can confirm. The riskiest is the
`taskId` field encoding.

## What works

- **HTTP service** (`src/server.js`, plain Node `http`, no framework):
  `POST /agent` and `POST /task` (same handler), `GET /health`.
- **HMAC first**: the signature (`x-agent-games-signature`) is verified over
  the RAW request body before any JSON parsing or processing, with
  constant-time comparison. Bad/missing signature -> 401 with zero state
  change. Verification accepts hex or canonical base64 encodings of the
  HMAC-SHA256 digest (the docs don't specify the encoding; accepting both
  loses no security). Every response is signed with lowercase hex HMAC over
  its raw bytes.
- **Preflight responder**: `agent-games.preflight.v1` ->
  `{ ok: true, protocolVersion: "v1" }`, signed.
- **Decision engine** (`src/decision.js`): all 7 documented varieties with
  deterministic precedence (VK -> threshold -> reuse -> expiry -> recipient
  -> amount -> valid). Case-insensitive hex compares. Boundary semantics
  match the circuit exactly: `balance >= minimum`, `amount <= maxTransfer`,
  `currentBlock < expiryBlock` STRICT (see "Circuit vs prose" below).
  Malformed input fails closed to `REJECT` / `INVALID_INPUT`.
- **Persistent seen-set** (`data/seen_proofs.jsonl`): append-only, fsync
  before responding, reloads on startup, tolerates a torn trailing line.
  Every processed task's `proof_tx` is marked (fail-closed choice; see gaps).
  A failed mark refuses the request (503) rather than risk a duplicate
  slipping through.
- **Idempotency cache** (`data/idempotency.json`, atomic tmp+fsync+rename):
  a retried `task_id` returns byte-identical response bytes without
  re-deciding or double-counting the seen-set. Cache persists across
  restarts (10k-entry cap, oldest evicted).
- **Prover** (`src/prover.js`, snarkjs `groth16.fullProve`): wired for real
  with the recovered input mapping. Generates proofs for APPROVE
  (`decision=1`) AND REJECT (`decision=0`) tasks — both are provable, proven
  by local verification. `PROOF_REUSED` tasks carry no proof by design (the
  circuit cannot express reuse; a decision=0 proof for reused inputs is
  unprovable — verified). Prover failures degrade to "no proof fields",
  never a fake proof. 45s default budget inside the 60s platform deadline.
- **Structured JSON logging**: one line per decision
  (`task_id`, `decision`, `reason_code`, `proof`, `cached`, `ms`), plus
  auth rejections and errors. No secrets, no bodies logged.
- **Tests**: 72/72 pass (`npm test`, ~22s). Unit tests for all 7 trap
  varieties + valid + boundaries + malformed input; encoding + HMAC tests;
  store persistence tests; **real-prover tests** (every outcome generates a
  Groth16 proof verified locally against the exported VK, plus negative
  tests proving contradictory decisions are unprovable); full HTTP e2e
  (valid/bad/missing/tampered signatures, replay identity, PROOF_REUSED
  flow, preflight, malformed JSON, unknown type, `/task` alias); and
  serverless tests (Upstash store against a mock REST API, full trap suite
  through `api/task.js`). See "Vercel adaptation" below.

## Circuit reverse engineering (how the prover got wired)

The public docs do not name the circuit's input signals. Everything below
was recovered from the public `gatekeeper.wasm` / `.zkey` alone, and every
claim is re-checkable with the kept probe scripts in `scripts/`:

1. **Signal names** (`scripts/discover-inputs.js`): the Circom 2.x wasm
   resolves input signals by FNV-1a hash of the name
   (`getInputSignalSize` returns the signal size for a matching hash, 0
   otherwise). Brute-forcing ~3,000 plausible names found exactly 13
   size-1 signals summing to the wasm's `getInputSize()` of 13 — complete
   coverage, no signal left undiscovered. Names: `registeredVkHash`,
   `proofVkHash`, `minimum`, `publicBalance`, `expiryBlock`,
   `currentBlock`, `recipient`, `conditionRecipient`, `amount`,
   `maxTransfer`, `decision`, `taskId`, `salt`.
2. **Public/private split + order** (`scripts/probe-witness.js`,
   `probe-reject.js`): with a satisfying assignment, witness indices 1..13
   are the public signals in declaration order (see ARTIFACTS.md); `salt`
   sits at index 14, i.e. it is the sole private input.
3. **Constraint semantics** (`scripts/probe-satisfy.js`): single-violation
   probes mapped each check; the circuit enforces
   `decision == allChecksPass` with `decision` boolean. REJECTs are
   provable (`decision=0` + trap inputs satisfies the circuit).
4. **Binding commitment** (`scripts/probe-s0.js`, `probe-poseidon.js`):
   public signal #1 depends ONLY on (`taskId`, `salt`) and equals
   `Poseidon(salt, taskId)` exactly (verified against circomlibjs). Since
   `salt` is private, the platform cannot recompute this value — it can
   only record it. Consequence: the platform's independent verification
   must be "Groth16 verify + read decision/fields from our public signals",
   not full public-signal recomputation (except possibly for the
   individually-checkable fields — see gaps).

## Proof generation time (measured on this VM, 2026-11-14)

- First `fullProve` in a process: ~4.2–6.7s (includes zkey/wasm/curve init).
- Steady-state `fullProve`: ~1.2–2.6s per proof.
- Local `groth16.verify`: ~0.3s.
- End-to-end HTTP request with proof: ~1.5–3s typical.
- All comfortably inside the 60s platform deadline. The 45s prover budget
  is a safety net, not an expected path.

## How to run locally

```sh
cd ~/workspace/agentgames/gatekeeper
npm install            # snarkjs only (runtime); circomlibjs is dev-only
npm test               # 49 tests, ~22s
AGENT_GAMES_HMAC_SECRET=<test-value> npm start   # listens on 127.0.0.1:3000
```

Notes:

- The server **refuses to start** without `AGENT_GAMES_HMAC_SECRET` and
  without both circuit artifacts present. Copy `.env.example` to `.env`
  for local runs (`.env` is git-ignored; this scaffold does not load it —
  export the variables or use your process manager's env).
- `GET /health` returns uptime + state counters (no secrets).
- Send a signed test task with any HTTP client: HMAC-SHA256 hex over the
  raw JSON body in `x-agent-games-signature`. `tests/e2e.test.js` shows
  the exact construction.
- snarkjs leaves the Node event loop alive after proving; one-shot scripts
  that prove must call `process.exit()` explicitly (the test runner uses
  `--test-force-exit`). Long-running server processes are unaffected.
- State lives in `data/` (git-ignored). Delete it to reset the seen-set and
  idempotency cache (only ever do this deliberately: wiping the seen-set
  re-arms PROOF_REUSED detection from zero).

## Circuit vs prose: one real discrepancy (resolved fail-closed)

The public prose describes expiry as `current_block > expiry_block`, but
the circuit requires `currentBlock < expiryBlock` STRICTLY: a task with
`current == expiry` satisfies only `decision=0` (verified). The engine
therefore rejects on `current >= expiry`. Approving a `current == expiry`
task would be unprovable (-2) and likely scored as approving a trap (-6);
rejecting it costs at most -3 if the platform's ground truth disagrees.
If practice mode shows `current == expiry` tasks labeled VALID, flip the
comparison in `src/decision.js` (one line) — but the proof would still be
impossible for them, so the platform almost certainly labels them expired.

## Exact gaps / unknowns (what registration must reveal)

Ordered by risk. Each is isolated to one function or one documented choice,
so a correction after registration is small.

1. **`taskId` field encoding (HIGHEST RISK).** `task_id` is an opaque
   string (`"gk_8d31_..."`); the circuit takes a field element. Current:
   `SHA-256(task_id) mod p` (`taskIdToField` in `src/encoding.js`).
   If the platform cross-checks public signal 13 against its own encoding
   (e.g. keccak256, or Poseidon over bytes), proofs fail that check. The
   circuit itself does not constrain `taskId`, so local verification
   cannot distinguish encodings. Resolve via: dashboard docs after
   registration, or practice-mode feedback (proofs accepted = encoding
   fine / not checked).
2. **VK hash encoding (MEDIUM).** Current: `BigInt(hex) mod p`
   (`vkHashToField`). Forced in shape (a random 32-byte hash exceeds the
   ~254-bit prime ~75% of the time, so reduction must happen somewhere),
   but the platform could instead hash the VK string again, truncate, or
   use a different reduction. Only matters if the platform recomputes the
   expected vk public signals. Same resolution path as (1).
3. **HMAC header encoding (LOW-MEDIUM).** The docs never state hex vs
   base64. Verification accepts both; responses use lowercase hex. If the
   platform requires base64 response signatures, preflight fails with a
   signature error and the fix is one line (`signBody` encoding). Preflight
   exists precisely to catch this before scored rounds.
4. **Response proof field shape (LOW).** Responses include snarkjs-native
   `proof` (`{pi_a, pi_b, pi_c, protocol, curve}`) and `public_signals`
   (array of decimal strings), per the starter prompt's
   `{ decision, reason_code, proof, public_signals }`. The `/build`
   example response shows only `decision`/`reason_code`/`proof_tx` (for a
   REJECT trap). If the platform wants a different proof serialization
   (e.g. flattened arrays), proofs fail its parse. Practice mode reveals it.
5. **Seen-set marking policy (LOW).** Current: EVERY processed task's
   `proof_tx` is marked seen (any decision except malformed input), so any
   second appearance is `PROOF_REUSED`. Alternative: mark only APPROVEs.
   The brief's "already seen" phrasing supports mark-all, and fail-closed
   favors it (-3 worst case vs -6 for approving a reuse), but if the
   platform reuses a `proof_tx` across an unrelated trap task and a later
   VALID task, mark-all mis-rejects the valid one. Watch practice-mode
   outcomes; the policy is one `if` in `src/server.js`.
6. **Timestamp/deadline validation (LOW).** `issued_at`/`deadline_at`
   formats and tolerances are unspecified (`"<issued-at>"` placeholders).
   Current: lenient — accepted as-is, HMAC is the authentication, past
   deadlines are still answered (the platform enforces its own deadline
   scoring). If the platform expects agents to reject stale tasks, add the
   check once the format is known.
7. **Proof-on-chain / finalization (OUT OF SCOPE).** The security
   checklist mentions "verification reached a finalized state before
   approval" and the starter prompt includes Kurier/zkVerify submission.
   This scaffold deliberately does NOT submit to Kurier: it needs a
   `KURIER_API_KEY` (does not exist yet), and block finalization takes
   minutes — incompatible with the 60s response deadline unless done
   asynchronously. The platform re-verifies our local Groth16 proof
   itself, which is the scored evidence. Revisit only if registration
   reveals the platform expects a Kurier job reference in responses.
8. **Deployment (PREPARED, NOT DEPLOYED — needs his decisions/accounts).**
   Vercel + Upstash adaptation is complete and tested (see "Vercel
   adaptation" + DEPLOY.md): `api/task.js` + `api/health.js`,
   `vercel.json`, Upstash storage backend. What remains is his: GitHub
   repo, Vercel project + env vars, Upstash database, platform
   registration + HMAC secret, preflight, practice tasks. Uptime
   matters: offline = forfeited tasks (rules 1.4); Vercel functions do
   not sleep, but cold starts add seconds (measured, inside budget).

## Vercel adaptation (2026-11-15, preparation only — NOT deployed)

The scaffold was adapted for serverless deployment on Vercel + Upstash
Redis (free tiers, no card). No deployment, account, or secret exists
yet; the runbook is DEPLOY.md.

- **Storage interface** (`src/store.js`): the seen-set and idempotency
  cache sit behind one async interface. `FileStore` (local default)
  wraps the original file-backed classes unchanged;
  `UpstashRedisStore` talks raw fetch to the Upstash Redis REST API
  (JSON-array POST bodies, `/pipeline` for stats, `/multi-exec` for
  atomic cache writes; Bearer auth; 5s timeout; every failure throws
  and fails closed). Conformance tests prove identical semantics.
- **Shared pipeline** (`src/handler.js`): the HMAC -> parse -> decide ->
  mark -> prove -> sign -> cache flow moved out of the HTTP server into
  a transport-agnostic handler; `src/server.js` is now a thin adapter
  (same routes, same behavior, all original tests still pass).
- **Vercel entries** (`api/task.js`, `api/health.js`): Web-standard
  handlers (`POST`/`GET` + `Request`/`Response`). The task handler reads
  exact raw bytes via `request.arrayBuffer()` — the legacy `(req, res)`
  shape pre-parses `req.body` and must not be substituted. Upstash-only
  storage; missing env vars -> loud 500, never silently stateless.
- **Artifacts** (`src/artifacts.js`, `vercel.json` `includeFiles`):
  wasm+zkey resolve via env override -> `process.cwd()/circuits` (Vercel
  bundle layout) -> module-relative fallback. `vercel.json` also routes
  `/task` + `/agent` to the handler and sets `maxDuration: 60`
  (Hobby-cap caveat + fallback documented in DEPLOY.md §4).
- **Measured** (fresh processes, `scripts/measure-handler.js`):
  import ~1.0-1.9s; cold first request (incl. first prove) ~4.0-5.0s;
  warm request ~1.3-1.7s; zero files written to cwd or TMPDIR, including
  a run from a read-only empty cwd (snarkjs fullProve is fully
  in-memory; no /tmp routing needed).
- **Tests: 72/72 pass** (`npm test`): the original 49 plus 23 new —
  store conformance (both backends), Upstash failure modes (unreachable,
  wrong token, corrupt entry), and the full trap suite through
  `api/task.js` with real Request/Response objects (all 7 varieties +
  valid + auth failures + replay identity + preflight + health +
  missing-env 500s). The Upstash store is tested against a local mock
  mirroring the documented REST shapes, NOT against real Upstash —
  first practice task after deploy is the live validation.

## Files

```
gatekeeper/
  ARTIFACTS.md            artifact hashes + verified circuit facts
  REPORT.md               this file
  DEPLOY.md               Vercel + Upstash runbook (preparation only)
  vercel.json             routes, maxDuration, circuit includeFiles
  .vercelignore           excludes tests/scripts/data/docs from the bundle
  package.json            snarkjs (runtime), circomlibjs (dev/verification)
  .env.example            blank config template (no secrets)
  .gitignore              node_modules, .env, data/
  circuits/
    gatekeeper.wasm       public circuit artifact
    gatekeeper_final.zkey public proving key
    verification_key.json exported locally with snarkjs
  api/
    task.js               Vercel Function: POST /task + /agent (Upstash only)
    health.js             Vercel Function: GET /health
  src/
    index.js              entrypoint (env config, fail-fast startup)
    server.js             HTTP service adapter over src/handler.js
    handler.js            shared pipeline (HMAC -> decide -> prove -> sign)
    artifacts.js          circuit path resolution (env/cwd/module-relative)
    decision.js           7-rule decision engine (pure, deterministic)
    encoding.js           task values -> circuit inputs (assumptions isolated here)
    prover.js             snarkjs fullProve wrapper (timeout, typed errors)
    hmac.js               verify/sign helpers (hex + base64)
    store.js              storage interface: FileStore + UpstashRedisStore
  tests/                  decision, encoding-hmac, store, prover (real proofs),
                          e2e, serverless (Upstash mock + api/ handlers)
  scripts/                circuit discovery probes (re-runnable evidence) +
                          measure-handler.js (cold timing + no-write probe)
    discover-inputs.js    FNV-hash signal-name recovery
    probe-witness.js      witness layout inspection
    probe-satisfy.js      single-violation satisfiability mapping
    probe-reject.js       REJECT provability + public-signal order
    probe-s0.js           binding-commitment dependency mapping
    probe-poseidon.js     S0 = Poseidon(salt, taskId) verification
  data/                   runtime state (created on first run; git-ignored)
```

## What registration must reveal before go-live (checklist)

- [ ] The HMAC secret (Rotate Secret, shown once) -> `AGENT_GAMES_HMAC_SECRET`.
- [ ] Response-signature encoding accepted by preflight (hex vs base64).
- [ ] `taskId` field encoding (or confirmation the platform doesn't
      cross-check it) — gap #1.
- [ ] VK hash encoding (or confirmation it isn't cross-checked) — gap #2.
- [ ] Proof serialization accepted in responses — gap #4.
- [ ] Preflight passes against the deployed public HTTPS endpoint.
- [ ] Practice-mode tasks score as expected (decision + proof accepted),
      especially: a valid task, one trap of each variety, and a
      `current == expiry` boundary task.
- [ ] Hosting with no sleep + TLS on 443, secret in the host's env store
      (never in the repo), and a restart-safe `data/` volume (or an
      external store for the seen-set/cache if the host is ephemeral —
      **serverless without persistent state breaks PROOF_REUSED
      detection and idempotency**; use a KV/DB adapter for `src/store.js`
      in that case).
