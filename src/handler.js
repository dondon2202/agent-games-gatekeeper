// Transport-agnostic request pipeline shared by the local HTTP server
// (src/server.js) and the Vercel serverless function (api/task.js).
//
// Input:  { rawBody: Buffer, signatureHeader: string|undefined }
// Output: { status: number, body: Buffer, signature: string }
//   `body` is the exact JSON response bytes; `signature` is the HMAC-SHA256
//   hex of those bytes, so callers only have to set the header and send.
//
// Pipeline (order is load-bearing; identical to the original server):
//   1. Size cap (1 MiB) -> 413.
//   2. Verify x-agent-games-signature over the RAW bytes BEFORE parsing.
//      Failure -> 401, nothing else happens.
//   3. Parse JSON. Failure -> 400.
//   4. Route on envelope `type`: preflight vs proof-gatekeeper task.
//      Unknown type -> 400.
//   5. Task flow: idempotency cache -> validate -> decide -> mark seen ->
//      prove (best effort, omitted on failure) -> sign -> cache -> respond.
// Every decision is logged as one JSON line. Fail closed throughout:
// any store failure -> 503 (the platform retries); any malformed input ->
// REJECT / INVALID_INPUT; any prover failure -> decision without proof.

import { verifySignature, signBody, SIGNATURE_HEADER } from "./hmac.js";
import { validateInput, decide } from "./decision.js";
import { ProofUnavailableError } from "./prover.js";

export const MAX_BODY_BYTES = 1024 * 1024;
export const TASK_TYPE = "agent-games.proof-gatekeeper.v1";
export const PREFLIGHT_TYPE = "agent-games.preflight.v1";

function defaultLog(fields) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...fields }) + "\n");
}

export function createHandler({ secret, store, prover, log = defaultLog }) {
  function respond(status, bodyObject) {
    const body = Buffer.from(JSON.stringify(bodyObject), "utf8");
    return { status, body, signature: signBody(secret, body) };
  }

  function respondRaw(status, bodyString) {
    const body = Buffer.from(bodyString, "utf8");
    return { status, body, signature: signBody(secret, body) };
  }

  async function handlePreflight() {
    log({ level: "info", event: "preflight" });
    return respond(200, { ok: true, protocolVersion: "v1" });
  }

  async function handleTask(envelope) {
    const started = Date.now();
    const taskId = envelope.task_id;
    if (typeof taskId !== "string" || taskId.length === 0) {
      return respond(400, { error: "task_id must be a non-empty string" });
    }

    // Idempotency: same task_id returns the identical response bytes.
    // A cache-read failure fails closed (503): answering without the cache
    // could double-decide a retried task.
    let cached;
    try {
      cached = await store.getCached(taskId);
    } catch (e) {
      log({ level: "error", event: "cache_read_failed", task_id: taskId, error: String(e.message) });
      return respond(503, { error: "state unavailable" });
    }
    if (cached) {
      log({ level: "info", event: "decision", task_id: taskId, decision: cached.decision, reason_code: cached.reason_code, proof: cached.proof, cached: true, ms: Date.now() - started });
      return respondRaw(200, cached.body);
    }

    const input = envelope.input;
    const validationError = validateInput(input);
    if (validationError) {
      const out = respond(200, {
        decision: "REJECT",
        reason_code: "INVALID_INPUT",
        ...(input && typeof input.proof_tx === "string" ? { proof_tx: input.proof_tx } : {}),
      });
      try {
        await store.putCached(taskId, { body: out.body.toString("utf8"), decision: "REJECT", reason_code: "INVALID_INPUT", proof: false });
      } catch (e) {
        log({ level: "error", event: "cache_persist_failed", task_id: taskId, error: String(e.message) });
      }
      log({ level: "info", event: "decision", task_id: taskId, decision: "REJECT", reason_code: "INVALID_INPUT", proof: false, cached: false, ms: Date.now() - started, detail: validationError });
      return out;
    }

    // Reuse check needs the durable seen-set; a lookup failure fails closed.
    let seen;
    try {
      seen = await store.hasSeen(input.proof_tx.toLowerCase());
    } catch (e) {
      log({ level: "error", event: "seen_lookup_failed", task_id: taskId, error: String(e.message) });
      return respond(503, { error: "state unavailable" });
    }

    let outcome;
    try {
      outcome = decide(input, { seenProofTx: () => seen });
    } catch (e) {
      log({ level: "error", event: "decide_failed", task_id: taskId, error: String(e.message) });
      return respond(503, { error: "decision unavailable" });
    }

    // Durably mark the proof reference seen BEFORE responding. If the mark
    // fails we refuse to answer (503) rather than risk a later duplicate
    // slipping through; the platform retries.
    try {
      await store.markSeen(input.proof_tx.toLowerCase(), taskId);
    } catch (e) {
      log({ level: "error", event: "seen_mark_failed", task_id: taskId, error: String(e.message) });
      return respond(503, { error: "state unavailable" });
    }

    // Proof: every decision except PROOF_REUSED is provable (the circuit
    // proves decision == all-checks-pass). PROOF_REUSED is stateful and
    // invisible to the circuit, so it carries no proof by design. Any
    // prover failure degrades to "no proof" rather than a wrong proof.
    let proof = null;
    let publicSignals = null;
    if (outcome.reason_code !== "PROOF_REUSED") {
      try {
        const r = await prover.prove(
          { task_id: taskId, ...input },
          outcome.decision === "APPROVE" ? 1n : 0n,
        );
        proof = r.proof;
        publicSignals = r.publicSignals;
      } catch (e) {
        if (!(e instanceof ProofUnavailableError)) throw e;
        log({ level: "warn", event: "proof_unavailable", task_id: taskId, reason_code: outcome.reason_code, error: e.message });
      }
    }

    const out = respond(200, {
      decision: outcome.decision,
      reason_code: outcome.reason_code,
      proof_tx: input.proof_tx,
      ...(proof ? { proof, public_signals: publicSignals } : {}),
    });
    try {
      await store.putCached(taskId, { body: out.body.toString("utf8"), decision: outcome.decision, reason_code: outcome.reason_code, proof: proof !== null });
    } catch (e) {
      log({ level: "error", event: "cache_persist_failed", task_id: taskId, error: String(e.message) });
    }
    log({ level: "info", event: "decision", task_id: taskId, decision: outcome.decision, reason_code: outcome.reason_code, proof: proof !== null, cached: false, ms: Date.now() - started });
    return out;
  }

  async function handle({ rawBody, signatureHeader }) {
    if (!Buffer.isBuffer(rawBody)) {
      return respond(400, { error: "unreadable body" });
    }
    if (rawBody.length > MAX_BODY_BYTES) {
      return respond(413, { error: "body too large" });
    }
    // HMAC over the raw bytes BEFORE any parsing or processing.
    if (!verifySignature(secret, rawBody, signatureHeader)) {
      log({ level: "warn", event: "auth_rejected" });
      return respond(401, { error: "invalid signature" });
    }

    let envelope;
    try {
      envelope = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return respond(400, { error: "invalid JSON" });
    }
    if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
      return respond(400, { error: "envelope must be an object" });
    }

    // Route on type. Timestamps (issued_at/deadline_at) are accepted
    // leniently: their exact format/tolerance is unspecified in the public
    // docs, and the HMAC is the authentication. A past deadline is still
    // answered; the platform enforces its own deadline scoring.
    if (envelope.type === PREFLIGHT_TYPE) {
      return handlePreflight();
    }
    if (envelope.type === TASK_TYPE) {
      return handleTask(envelope);
    }
    return respond(400, { error: "unknown envelope type" });
  }

  return { handle };
}

export { SIGNATURE_HEADER };
