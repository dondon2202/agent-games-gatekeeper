// Unit tests: decision engine, all 7 trap varieties + valid case + edges.
// Payload shape mirrors the documented /build sample envelope.
import test from "node:test";
import assert from "node:assert/strict";
import { decide, validateInput } from "../src/decision.js";

const VK = "0x" + "7d91".repeat(16);
const VK_OTHER = "0x" + "13aa".repeat(16);
const ADDR = "0xDe42a1b2c3d4e5f60718293a4b5c6d7e8f909f01";
const ADDR_OTHER = "0xDe42a1b2c3d4e5f60718293a4b5c6d7e8f909f02";
const PROOF_TX = "0x" + "a82c".repeat(16);

function validInput(overrides = {}) {
  return {
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

const freshCtx = () => ({ seenProofTx: () => false });
const seenCtx = (tx) => ({ seenProofTx: (t) => t === tx.toLowerCase() });

test("VALID_CONDITION approves when every check passes", () => {
  const input = validInput();
  assert.equal(validateInput(input), null);
  assert.deepEqual(decide(input, freshCtx()), { decision: "APPROVE", reason_code: "VALID_CONDITION" });
});

test("VK_SUBSTITUTION rejects when proof_vk differs", () => {
  const input = validInput({ proof_vk: VK_OTHER });
  assert.deepEqual(decide(input, freshCtx()), { decision: "REJECT", reason_code: "VK_SUBSTITUTION" });
});

test("VK compare is case-insensitive", () => {
  const input = validInput({ proof_vk: VK.toUpperCase().replace("0X", "0x") });
  assert.equal(decide(input, freshCtx()).decision, "APPROVE");
});

test("THRESHOLD_MISMATCH rejects when public_balance < minimum", () => {
  const input = validInput({ public_balance: "999" });
  assert.deepEqual(decide(input, freshCtx()), { decision: "REJECT", reason_code: "THRESHOLD_MISMATCH" });
});

test("balance == minimum approves (threshold is >=)", () => {
  const input = validInput({ public_balance: "1000" });
  assert.equal(decide(input, freshCtx()).decision, "APPROVE");
});

test("PROOF_REUSED rejects when proof_tx was already seen", () => {
  const input = validInput();
  assert.deepEqual(decide(input, seenCtx(PROOF_TX)), { decision: "REJECT", reason_code: "PROOF_REUSED" });
});

test("EXPIRED_CONDITION rejects when current_block > expiry_block", () => {
  const input = validInput({ current_block: 8430001 });
  assert.deepEqual(decide(input, freshCtx()), { decision: "REJECT", reason_code: "EXPIRED_CONDITION" });
});

test("current_block == expiry_block rejects (circuit requires strict <)", () => {
  const input = validInput({ current_block: 8430000 });
  assert.deepEqual(decide(input, freshCtx()), { decision: "REJECT", reason_code: "EXPIRED_CONDITION" });
});

test("RECIPIENT_MISMATCH rejects when recipient differs", () => {
  const input = validInput({ recipient: ADDR_OTHER });
  assert.deepEqual(decide(input, freshCtx()), { decision: "REJECT", reason_code: "RECIPIENT_MISMATCH" });
});

test("recipient compare is case-insensitive", () => {
  const input = validInput({ recipient: ADDR.toLowerCase() });
  assert.equal(decide(input, freshCtx()).decision, "APPROVE");
});

test("AMOUNT_OVERFLOW rejects when amount > max_transfer", () => {
  const input = validInput({ amount: "1001" });
  assert.deepEqual(decide(input, freshCtx()), { decision: "REJECT", reason_code: "AMOUNT_OVERFLOW" });
});

test("amount == max_transfer approves (cap is <=)", () => {
  const input = validInput({ amount: "1000" });
  assert.equal(decide(input, freshCtx()).decision, "APPROVE");
});

test("numeric and string integers are both accepted", () => {
  const input = validInput({ minimum: 1000, public_balance: 1460, amount: 500, max_transfer: 1000 });
  assert.equal(validateInput(input), null);
  assert.equal(decide(input, freshCtx()).decision, "APPROVE");
});

test("precedence: VK check wins over threshold when both fail", () => {
  const input = validInput({ proof_vk: VK_OTHER, public_balance: "1" });
  assert.equal(decide(input, freshCtx()).reason_code, "VK_SUBSTITUTION");
});

test("validateInput rejects malformed fields", () => {
  assert.match(validateInput(null), /object/);
  assert.match(validateInput({}), /missing field/);
  assert.match(validateInput(validInput({ registered_vk: "zz" })), /hex/);
  assert.match(validateInput(validInput({ minimum: "-5" })), /integer/);
  assert.match(validateInput(validInput({ minimum: 1.5 })), /integer/);
  assert.match(validateInput(validInput({ recipient: "0x1234" })), /address/);
  assert.match(validateInput(validInput({ proof_tx: "nope" })), /hex/);
  assert.match(validateInput(validInput({ amount: "1e3" })), /integer/);
});
