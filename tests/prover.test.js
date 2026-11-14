// Prover tests: for every decision outcome the engine can produce, generate
// a REAL Groth16 proof with the downloaded circuit artifacts and verify it
// locally against the exported verification key. This is the end-to-end
// proof that the recovered circuit mapping is correct. PROOF_REUSED is the
// deliberate exception: its inputs satisfy the circuit with decision=1, so
// a decision=0 proof must FAIL (proving the no-proof design).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";
import { decide } from "../src/decision.js";
import { Prover, ProofUnavailableError } from "../src/prover.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const vk = JSON.parse(fs.readFileSync(path.join(root, "circuits", "verification_key.json"), "utf8"));
const prover = new Prover({
  wasmPath: path.join(root, "circuits", "gatekeeper.wasm"),
  zkeyPath: path.join(root, "circuits", "gatekeeper_final.zkey"),
  timeoutMs: 30000,
});

const VK = "0x" + "7d91".repeat(16);
const VK_OTHER = "0x" + "13aa".repeat(16);
const ADDR = "0xDe42a1b2c3d4e5f60718293a4b5c6d7e8f909f01";
const ADDR_OTHER = "0xDe42a1b2c3d4e5f60718293a4b5c6d7e8f909f02";
const PROOF_TX = "0x" + "a82c".repeat(16);

function task(overrides = {}) {
  return {
    task_id: "gk_test_1",
    registered_vk: VK,
    proof_vk: VK,
    minimum: "1000",
    public_balance: "1460",
    expiry_block: 8430000,
    current_block: 8420000,
    recipient: ADDR,
    condition_recipient: ADDR,
    amount: "500",
    max_transfer: "1000",
    proof_tx: PROOF_TX,
    ...overrides,
  };
}

const CASES = [
  ["VALID_CONDITION", task(), { seenProofTx: () => false }, "APPROVE", 1n],
  ["VK_SUBSTITUTION", task({ proof_vk: VK_OTHER }), { seenProofTx: () => false }, "REJECT", 0n],
  ["THRESHOLD_MISMATCH", task({ public_balance: "999" }), { seenProofTx: () => false }, "REJECT", 0n],
  ["EXPIRED_CONDITION", task({ current_block: 8430001 }), { seenProofTx: () => false }, "REJECT", 0n],
  ["EXPIRED_CONDITION (boundary ==)", task({ current_block: 8430000 }), { seenProofTx: () => false }, "REJECT", 0n],
  ["RECIPIENT_MISMATCH", task({ recipient: ADDR_OTHER }), { seenProofTx: () => false }, "REJECT", 0n],
  ["AMOUNT_OVERFLOW", task({ amount: "1001" }), { seenProofTx: () => false }, "REJECT", 0n],
];

for (const [label, t, ctx, expectedDecision, decisionBit] of CASES) {
  test(`proof verifies for ${label}`, { timeout: 60000 }, async () => {
    const outcome = decide(t, ctx);
    assert.equal(outcome.decision, expectedDecision);
    assert.equal(outcome.reason_code, label.split(" ")[0]);
    const t0 = Date.now();
    const { proof, publicSignals } = await prover.prove(t, decisionBit);
    const ms = Date.now() - t0;
    assert.equal(publicSignals.length, 13);
    assert.equal(publicSignals[11], decisionBit.toString(), "public signal 12 must be the decision");
    assert.equal(await snarkjs.groth16.verify(vk, publicSignals, proof), true);
    assert.ok(ms < 30000, `prove took ${ms}ms`);
  });
}

test("PROOF_REUSED inputs cannot prove decision=0 (no-proof design)", { timeout: 60000 }, async () => {
  const t = task();
  const outcome = decide(t, { seenProofTx: () => true });
  assert.equal(outcome.reason_code, "PROOF_REUSED");
  // The inputs satisfy every circuit check, so decision=0 contradicts the
  // circuit and proving must fail cleanly (never a fake proof).
  await assert.rejects(() => prover.prove(t, 0n), ProofUnavailableError);
});

test("prover rejects a decision that contradicts the inputs", { timeout: 60000 }, async () => {
  await assert.rejects(() => prover.prove(task(), 0n), ProofUnavailableError);
  await assert.rejects(() => prover.prove(task({ proof_vk: VK_OTHER }), 1n), ProofUnavailableError);
});
