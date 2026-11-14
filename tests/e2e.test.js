// End-to-end tests: real HTTP server, HMAC-signed requests, idempotency,
// auth failures, preflight, and the PROOF_REUSED flow. Uses an ephemeral
// port and a temp data dir; the HMAC secret is a throwaway test value.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import { createServer } from "../src/server.js";
import { verifySignature } from "../src/hmac.js";

const SECRET = "e2e-test-secret-32-bytes-long!!";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const VK = "0x" + "7d91".repeat(16);
const ADDR = "0xDe42a1b2c3d4e5f60718293a4b5c6d7e8f909f01";
const PROOF_TX = "0x" + "a82c".repeat(16);
const PROOF_TX_2 = "0x" + "b93d".repeat(16);

function envelope(taskId, input) {
  return {
    type: "agent-games.proof-gatekeeper.v1",
    task_id: taskId,
    mode: "competition",
    issued_at: "2026-11-14T00:00:00Z",
    deadline_at: "2026-11-14T00:01:00Z",
    input,
  };
}

function validInput(proofTx = PROOF_TX) {
  return {
    registered_vk: VK, proof_vk: VK, minimum: "1000", public_balance: "1460",
    expiry_block: 8430000, current_block: 8420000,
    recipient: ADDR, condition_recipient: ADDR,
    amount: "500", max_transfer: "1000", proof_tx: proofTx,
  };
}

async function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gatekeeper-e2e-"));
  const { server, seenSet, cache } = createServer({
    secret: SECRET,
    dataDir,
    wasmPath: path.join(root, "circuits", "gatekeeper.wasm"),
    zkeyPath: path.join(root, "circuits", "gatekeeper_final.zkey"),
    proveTimeoutMs: 30000,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return { server, port, dataDir, seenSet, cache };
}

function request(port, { method = "POST", path: p = "/agent", body, signature, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers: { "content-type": "application/json", ...(signature ? { "x-agent-games-signature": signature } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function sign(bodyBuffer, secret = SECRET) {
  return createHmac("sha256", secret).update(bodyBuffer).digest("hex");
}

test("e2e: full flow", { timeout: 180000 }, async (t) => {
  const { server, port, seenSet, cache } = await startServer();
  t.after(() => server.close());

  await t.test("health responds", async () => {
    const r = await request(port, { method: "GET", path: "/health" });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body.toString()).ok, true);
  });

  await t.test("bad signature -> 401 before any processing, no state change", async () => {
    const body = Buffer.from(JSON.stringify(envelope("gk_bad_sig", validInput())), "utf8");
    const r = await request(port, { body, signature: sign(body, "wrong-secret") });
    assert.equal(r.status, 401);
    assert.equal(seenSet.size, 0);
    assert.equal(cache.size, 0);
  });

  await t.test("missing signature -> 401", async () => {
    const body = Buffer.from(JSON.stringify(envelope("gk_no_sig", validInput())), "utf8");
    const r = await request(port, { body });
    assert.equal(r.status, 401);
    assert.equal(seenSet.size, 0);
  });

  await t.test("tampered body -> 401 (signature covers raw bytes)", async () => {
    const original = Buffer.from(JSON.stringify(envelope("gk_tamper", validInput())), "utf8");
    const sig = sign(original);
    const tampered = Buffer.from(original.toString("utf8").replace('"1460"', '"9999"'), "utf8");
    const r = await request(port, { body: tampered, signature: sig });
    assert.equal(r.status, 401);
    assert.equal(seenSet.size, 0);
  });

  let firstBody;
  await t.test("valid signed task -> APPROVE with proof, response signature valid", async () => {
    const body = Buffer.from(JSON.stringify(envelope("gk_e2e_1", validInput())), "utf8");
    const r = await request(port, { body, signature: sign(body) });
    assert.equal(r.status, 200);
    assert.equal(verifySignature(SECRET, r.body, r.headers["x-agent-games-signature"]), true);
    const parsed = JSON.parse(r.body.toString());
    assert.equal(parsed.decision, "APPROVE");
    assert.equal(parsed.reason_code, "VALID_CONDITION");
    assert.equal(parsed.proof_tx, PROOF_TX);
    assert.equal(typeof parsed.proof, "object");
    assert.equal(parsed.proof.protocol, "groth16");
    assert.equal(parsed.public_signals.length, 13);
    assert.equal(parsed.public_signals[11], "1");
    assert.equal(seenSet.size, 1);
    firstBody = r.body.toString("utf8");
  });

  await t.test("replayed task_id returns byte-identical decision", async () => {
    const body = Buffer.from(JSON.stringify(envelope("gk_e2e_1", validInput())), "utf8");
    const r = await request(port, { body, signature: sign(body) });
    assert.equal(r.status, 200);
    assert.equal(r.body.toString("utf8"), firstBody);
    assert.equal(seenSet.size, 1, "replay must not double-count the seen-set");
  });

  await t.test("same proof_tx, new task_id -> PROOF_REUSED with no proof", async () => {
    const body = Buffer.from(JSON.stringify(envelope("gk_e2e_2", validInput(PROOF_TX))), "utf8");
    const r = await request(port, { body, signature: sign(body) });
    assert.equal(r.status, 200);
    const parsed = JSON.parse(r.body.toString());
    assert.equal(parsed.decision, "REJECT");
    assert.equal(parsed.reason_code, "PROOF_REUSED");
    assert.equal("proof" in parsed, false);
    assert.equal("public_signals" in parsed, false);
  });

  await t.test("trap task -> REJECT with decision=0 proof", async () => {
    const trapBody = Buffer.from(JSON.stringify(envelope("gk_e2e_3", {
      ...validInput(PROOF_TX_2), proof_vk: "0x" + "13aa".repeat(16),
    })), "utf8");
    const r = await request(port, { body: trapBody, signature: sign(trapBody) });
    assert.equal(r.status, 200);
    const parsed = JSON.parse(r.body.toString());
    assert.equal(parsed.decision, "REJECT");
    assert.equal(parsed.reason_code, "VK_SUBSTITUTION");
    assert.equal(typeof parsed.proof, "object");
    assert.equal(parsed.public_signals[11], "0");
  });

  await t.test("preflight -> signed {ok, protocolVersion}", async () => {
    const body = Buffer.from(JSON.stringify({
      type: "agent-games.preflight.v1", agent_id: "agt_x", issued_at: "2026-11-14T00:00:00Z", nonce: "abc123",
    }), "utf8");
    const r = await request(port, { body, signature: sign(body) });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body.toString()), { ok: true, protocolVersion: "v1" });
    assert.equal(verifySignature(SECRET, r.body, r.headers["x-agent-games-signature"]), true);
  });

  await t.test("malformed JSON with valid HMAC -> 400", async () => {
    const body = Buffer.from("{not json", "utf8");
    const r = await request(port, { body, signature: sign(body) });
    assert.equal(r.status, 400);
  });

  await t.test("unknown envelope type -> 400", async () => {
    const body = Buffer.from(JSON.stringify({ type: "something.else.v1" }), "utf8");
    const r = await request(port, { body, signature: sign(body) });
    assert.equal(r.status, 400);
  });

  await t.test("malformed task input -> REJECT INVALID_INPUT, no proof", async () => {
    const body = Buffer.from(JSON.stringify(envelope("gk_e2e_4", { ...validInput(), amount: "lots" })), "utf8");
    const r = await request(port, { body, signature: sign(body) });
    assert.equal(r.status, 200);
    const parsed = JSON.parse(r.body.toString());
    assert.equal(parsed.decision, "REJECT");
    assert.equal(parsed.reason_code, "INVALID_INPUT");
    assert.equal("proof" in parsed, false);
  });

  await t.test("/task alias behaves like /agent", async () => {
    const body = Buffer.from(JSON.stringify(envelope("gk_e2e_5", validInput("0x" + "c44d".repeat(16)))), "utf8");
    const r = await request(port, { path: "/task", body, signature: sign(body) });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body.toString()).decision, "APPROVE");
  });
});
