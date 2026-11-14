// Decision engine: the 7 documented trap varieties + the valid case.
// Pure, deterministic, no I/O except the seen-set lookup passed in.
// Fail closed: any malformed field, any failed check, any uncertainty ->
// REJECT. The engine never approves by default.
//
// Check precedence (first failure wins; tasks are generated with at most one
// trap, so precedence only matters for malformed/multi-trap inputs):
//   1. VK_SUBSTITUTION     proof_vk != registered_vk
//   2. THRESHOLD_MISMATCH  public_balance < minimum
//   3. PROOF_REUSED        proof_tx already seen in an earlier task
//   4. EXPIRED_CONDITION   current_block >= expiry_block
//   5. RECIPIENT_MISMATCH  recipient != condition_recipient
//   6. AMOUNT_OVERFLOW     amount > max_transfer
//   7. VALID_CONDITION     all checks pass -> APPROVE
//
// NOTE on EXPIRED_CONDITION: the public prose says "current > expiry", but
// the circuit itself requires currentBlock < expiryBlock STRICTLY (verified
// by witness probing: current == expiry satisfies only decision=0). The
// engine uses >= so its decisions always match what the circuit can prove.
// A current==expiry task approved by the ">" rule would be unprovable.
//
// NOTE on PROOF_REUSED: the circuit cannot express reuse (it has no memory),
// so a reused task's inputs satisfy the circuit with decision=1 while the
// correct decision is REJECT. Such tasks carry NO proof by design.

export const REASON_CODES = [
  "VALID_CONDITION",
  "VK_SUBSTITUTION",
  "THRESHOLD_MISMATCH",
  "PROOF_REUSED",
  "EXPIRED_CONDITION",
  "RECIPIENT_MISMATCH",
  "AMOUNT_OVERFLOW",
  "INVALID_INPUT",
];

const HEX_0X = /^0x[0-9a-fA-F]+$/;
const ADDRESS_0X = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^\d+$/;

function isDecimalInt(v) {
  return (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) ||
    (typeof v === "string" && DECIMAL.test(v));
}

function toBig(v) {
  return typeof v === "number" ? BigInt(v) : BigInt(v);
}

function normHex(v) {
  return v.toLowerCase();
}

/**
 * Validate the task input shape. Returns null when valid, else a string
 * describing the first problem. Structural validation only; semantic checks
 * live in decide().
 */
export function validateInput(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return "input must be an object";
  }
  const required = [
    "registered_vk", "proof_vk", "minimum", "public_balance", "expiry_block",
    "current_block", "recipient", "condition_recipient", "amount",
    "max_transfer", "proof_tx",
  ];
  for (const f of required) {
    if (!(f in input)) return `missing field: ${f}`;
  }
  if (!HEX_0X.test(input.registered_vk)) return "registered_vk must be 0x hex";
  if (!HEX_0X.test(input.proof_vk)) return "proof_vk must be 0x hex";
  if (!isDecimalInt(input.minimum)) return "minimum must be a non-negative integer";
  if (!isDecimalInt(input.public_balance)) return "public_balance must be a non-negative integer";
  if (!isDecimalInt(input.expiry_block)) return "expiry_block must be a non-negative integer";
  if (!isDecimalInt(input.current_block)) return "current_block must be a non-negative integer";
  if (!ADDRESS_0X.test(input.recipient)) return "recipient must be a 20-byte 0x address";
  if (!ADDRESS_0X.test(input.condition_recipient)) return "condition_recipient must be a 20-byte 0x address";
  if (!isDecimalInt(input.amount)) return "amount must be a non-negative integer";
  if (!isDecimalInt(input.max_transfer)) return "max_transfer must be a non-negative integer";
  if (!HEX_0X.test(input.proof_tx)) return "proof_tx must be 0x hex";
  return null;
}

/**
 * Decide a task.
 * @param {object} input - validated task input (see validateInput).
 * @param {object} ctx - { seenProofTx: (proofTx: string) => boolean }
 * @returns {{ decision: "APPROVE"|"REJECT", reason_code: string }}
 * Never throws for well-shaped input; throws only if `seenProofTx` throws
 * (caller must treat that as fail-closed REJECT).
 */
export function decide(input, ctx) {
  // 1. VK substitution (case-insensitive hex compare).
  if (normHex(input.proof_vk) !== normHex(input.registered_vk)) {
    return { decision: "REJECT", reason_code: "VK_SUBSTITUTION" };
  }
  // 2. Threshold: public_balance must be >= minimum.
  if (toBig(input.public_balance) < toBig(input.minimum)) {
    return { decision: "REJECT", reason_code: "THRESHOLD_MISMATCH" };
  }
  // 3. Reuse: proof_tx seen in any earlier processed task.
  if (ctx.seenProofTx(normHex(input.proof_tx))) {
    return { decision: "REJECT", reason_code: "PROOF_REUSED" };
  }
  // 4. Expiry: current_block must be STRICTLY below expiry_block (circuit).
  if (toBig(input.current_block) >= toBig(input.expiry_block)) {
    return { decision: "REJECT", reason_code: "EXPIRED_CONDITION" };
  }
  // 5. Recipient mismatch (case-insensitive hex compare).
  if (normHex(input.recipient) !== normHex(input.condition_recipient)) {
    return { decision: "REJECT", reason_code: "RECIPIENT_MISMATCH" };
  }
  // 6. Amount overflow: amount must be <= max_transfer.
  if (toBig(input.amount) > toBig(input.max_transfer)) {
    return { decision: "REJECT", reason_code: "AMOUNT_OVERFLOW" };
  }
  return { decision: "APPROVE", reason_code: "VALID_CONDITION" };
}
